import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { providerPreset, CLAUDE_HELPER_MODEL, type AgentProvider } from '../shared/agentProvider';
import { defaultMcpDefaults } from '../shared/mcpCatalog';
import { expandTilde } from './fs';
import type { IntegrationRecord } from '../shared/integrations';
import {
  DEFAULT_CONTEXT_TRIGGER,
  DEFAULT_ORG_TRIGGER,
  DEFAULT_TRIGGER_MODE,
  DEFAULT_WEBHOOK_SCHEMA,
  type ContextTriggerConfig,
  type OrgTriggerConfig,
  type WebhookTrigger,
} from '../shared/triggers';

/** A recurring auto-dispatched mission fired on an interval by the scheduler. */
export interface ScheduledMission {
  id: string;
  label: string;
  intervalMs: number;
  to: string;
  body: string;
  enabled: boolean;
  /** When true, the scheduler asks the renderer to compact live terminals when
   *  this mission fires — but only agents whose context has filled past the bar
   *  in `contextTrigger.compact` (60% by default, 40% on ~1M-token windows), so
   *  small/idle sessions are left alone instead of compacting on every tick.
   *
   *  This gate used to be described here but was never actually implemented: every
   *  live agent was compacted on every tick. It is real now, and the bars live in
   *  `ContextTriggerConfig` where the operator can edit them, so do not restate
   *  the numbers anywhere else — they will drift. */
  autoCompact?: boolean;
  lastFiredAt?: number;
  /** todo-unattended dedup state (card agent-every-non-paused-todo-ke-2026-
   *  08-18): the card ids escalated as todo-unattended at the previous
   *  standup fire, so an old backlog card escalates ONCE, not hourly. Written
   *  by the standup clerk every fire (same read-modify-write as lastFiredAt). */
  escalatedTodos?: string[];
  /** When true, a due fire is silently skipped while the floor is quiet
   *  (no non-god agent active since the last fire AND nothing in the ledger
   *  that counts: no 'doing'/'blocked' card and no NON-PAUSED todo — card
   *  agent-every-non-paused-todo-ke-2026-08-18). */
  skipWhenFloorQuiet?: boolean;
  /** Mission flavor. Absent ⇒ 'dispatch' (the classic interval-dispatch mission,
   *  e.g. the ops standup). 'heartbeat' (Lane A #1) is a context-aware beat: it
   *  observes live floor state, re-engages a quiet god, and ticks the circuit
   *  breaker — armed with an adaptive cadence, not a fixed setInterval. */
  kind?: 'dispatch' | 'heartbeat' | 'compact';
  /** Heartbeat only: a floor is "quiet" when no tracked signal (log.jsonl mtime,
   *  inbox/outbox mtimes, any PTY output) has moved in this many ms. Default
   *  ~5 min. NOT derived from registry.status (which never transitions in main). */
  quietThresholdMs?: number;
}

/** The built-in hourly ops standup: god reviews who's doing what + whether tasks
 *  are on track and agents are running, and every terminal's context is compacted.
 *  Shipped enabled by default; users can toggle it off in the Command Center. */
export const OPS_STANDUP_MISSION: ScheduledMission = {
  id: 'ops-standup',
  label: 'Hourly ops standup',
  intervalMs: 3_600_000,
  to: 'god',
  body:
    'Hourly ops standup. Review every agent: who is doing what, and confirm each ' +
    'is still running (not stalled or idle-stale). Check the task board — are ' +
    'in-flight tasks on track, and is anything blocked or unowned? Flag stale ' +
    'agents and at-risk tasks, and keep the board accurate. (As part of this ' +
    'standup each working agent is asked to summarise its current task and the ' +
    'next step, then compact and resume from the same point — so terminal ' +
    'contexts stay bounded without losing work. The compaction is queued and ' +
    'runs when an agent is idle, so it never interrupts work mid-step.)',
  enabled: true,
  skipWhenFloorQuiet: true,
  // NO autoCompact. Compaction belongs to contextTrigger.compact and nothing else.
  // This flag used to live here as well, which meant a default install asked for
  // compaction on TWO cadences — hourly from this standup and 2-hourly from the
  // trigger — the exact "two controls that disagree" the maint-1 retirement below
  // was written to end. The standup's own prose still describes compaction, and
  // that stays true: the trigger does it, just not on this mission's clock.
};

/** The built-in heartbeat (Lane A #1). A context-aware beat that, each tick,
 *  observes live floor state and — only when the floor has gone quiet — drops a
 *  digest into god's inbox and (if god's PTY is genuinely idle) nudges it to
 *  re-engage anyone stalled. The same beat ticks the circuit breaker.
 *
 *  Shipped DISABLED by default (opt-in): unlike the standup, which only sends a
 *  hive message, the heartbeat types into god's PTY, so the user turns it on
 *  explicitly in the Command Center once they want active re-engagement.
 *  `intervalMs` is the normal-cadence base; the scheduler derives a tighter beat
 *  when an agent looks stuck and a slower one right after a re-engage. */
export const HEARTBEAT_MISSION: ScheduledMission = {
  id: 'heartbeat',
  label: 'Floor heartbeat',
  intervalMs: 120_000,
  to: 'god',
  body:
    'Floor heartbeat: the team has gone quiet. Review the digest in your inbox, ' +
    're-engage anyone stalled or blocked, and keep the board accurate — or rest ' +
    'if the work is genuinely done.',
  enabled: false,
  kind: 'heartbeat',
  quietThresholdMs: 300_000,
};

/** The dedicated auto-compact MAINTENANCE schedule (maint-1). DECOUPLED from the
 *  ops standup so editing/replacing a standup can never silently disable
 *  compaction again (the bug this fixes). It fires ONLY the auto-compact signal —
 *  `kind:'compact'` makes syncMissions skip the hive.send dispatch (empty to/body).
 *  Shipped DISABLED (v0.3.4 founder decision): scheduled compaction is opt-in.
 *  Turn it on in Settings → General or the Schedules tab; the Schedules warning
 *  panel explains the risk of leaving it off for long-running agents. It is the
 *  SINGLE source of truth for compaction, and it's persistent: deleting it makes
 *  it reappear DISABLED.
 *  Existing installs keep whatever enabled state the user already has
 *  (compactMaintenanceSeeded guards re-seeding). */
export const COMPACT_MAINTENANCE_MISSION: ScheduledMission = {
  id: 'compact-maintenance',
  label: 'Auto-compact (maintenance)',
  // 2h, matching DEFAULT_CONTEXT_TRIGGER.compact.everyMs. The two cadences must
  // agree: this mission is the schedule half of the same behaviour the context
  // trigger now owns, and a 1h seed here would keep interrupting agents on the
  // old rhythm no matter what the trigger says.
  intervalMs: 7_200_000,
  to: '',
  body: '',
  enabled: false,
  autoCompact: true,
  kind: 'compact',
};

/** The 1h cadence `compact-maintenance` was seeded with before Triggers doubled
 *  it. `migrateTriggersV1` bumps only missions still sitting on this EXACT value,
 *  so an interval the user tuned by hand is left exactly where they put it. */
const LEGACY_COMPACT_MAINTENANCE_INTERVAL_MS = 3_600_000;

/** Circuit-breaker thresholds (Lane A #6.6b). The breaker runs inside the
 *  heartbeat beat, so it only ticks when the heartbeat is enabled. Trip
 *  conditions are behavioral by default; `costCapUsd` is the only $-based one and
 *  is unset by default (a hardcoded dollar default would be arbitrary). Defaults
 *  are deliberately conservative and steer-first — `hardStop` is OFF unless the
 *  user opts in, so the breaker never auto-kills a healthy long-runner. */
export interface CircuitBreakerConfig {
  /** Master switch for breaker evaluation within the beat. Default true. */
  enabled?: boolean;
  /** Allow the top of the ladder (kill PTY + archive). Default false = the
   *  breaker may steer/constrain but never hard-stops until the user opts in. */
  hardStop?: boolean;
  /** Consecutive identical tool calls (same name+input) before tripping. */
  repeatedToolLimit?: number;
  /** Consecutive api_error / retry events before tripping. */
  errorStormLimit?: number;
  /** Output-token velocity (tokens/min, diffed across beats) before tripping. */
  tokenVelocityPerMin?: number;
}

/** Enterprise Knowledge Graph (multimodal context store + agent access tool).
 *  The user ingests their own documents/images/PDFs; agents query them on demand
 *  via the `kg` CLI. Opt-in like the heartbeat/Slack features — `enabled` gates
 *  everything (no env injected, no prompt line, no store touched when off). See
 *  docs/design/knowledge-graph.md. */
export interface KnowledgeGraphConfig {
  /** Master switch. Default false = zero behaviour change (the feature is dark). */
  enabled?: boolean;
  /** Override the store location. Unset = <userData>/knowledge. */
  rootPath?: string;
}

export interface HarnessConfig {
  /** Has the user completed the first-run onboarding? */
  onboardingComplete: boolean;
  /** Self-identified audience picked on the first onboarding screen. Drives the
   *  copy register everywhere onboarding explains itself: 'technical' shows CLI /
   *  flag lingo, 'non-technical' explains each concept in plain language. Unset =
   *  not yet chosen (treated as technical for any incidental copy). */
  audience?: 'technical' | 'non-technical';
  /** Folder where the harness keeps its own state (agent metadata, logs). */
  harnessHome: string | null;
  /** Recently-opened hive home folders (most-recent first), surfaced by the
   *  launch-time hive picker. Maintained by writeConfig whenever harnessHome is
   *  set (onboarding finish, changeHome). Capped to a handful. */
  recentHives?: string[];
  /** Folders the user registered during onboarding (used as quick-picks). */
  registeredRepos: string[];
  /** When true, god's spawn-requests (ephemeral workers AND interns) launch
   *  with the provider's permission-bypass flag (claude:
   *  --dangerously-skip-permissions). DEFAULT OFF — bypass is the operator's
   *  per-installation opt-in, never the shipped default (card
   *  permission-mode-config-20260816); a flag god typed into the request's
   *  command still wins. UI hires carry their own hire-time selector. */
  workerBypass: boolean;
  /** Operator authorization for Agent-tool SUBAGENTS in skill-driven plan
   *  execution (superpowers SDD) — card sdd-authorization-switch-20260816.
   *  The claude CLI's stock prompt forbids AgentTool "unless the user
   *  requested it"; when this is ON (default — Stefan's stated preference)
   *  the harness-generated AGENTS.md and every agent briefing carry the
   *  operator-authorization line scoped to SKILL EXECUTION (subagent-driven
   *  default, cheap model overrides for mechanical tasks), which satisfies the
   *  stock prompt's own escape clause. OFF = the line is omitted and the
   *  engine's stock subagent rules apply unchanged. NOT blanket subagent use. */
  sddSubagentsAuthorized?: boolean;
  /** Who owns integration (merge + push) of finished work AND how lean god's
   *  operating posture is: 'god' (default — today's flow: workers hand
   *  branches to god, god integrates and verifies) · 'workers' (each worker
   *  merges + pushes its OWN branch after its gates are green and reports the
   *  pushed hash; god records it, no re-QA) · 'lean' (worker-side integration
   *  PLUS the lean-god posture: god default-delegates mechanical-but-judgment
   *  work, records worker-reported hashes/gate results WITHOUT re-verifying,
   *  and concentrates on operator dialogue, decomposition, dispatch
   *  contracts, conflict resolution, report translation). One monotonic enum,
   *  not two switches, because the lean posture INCLUDES worker-side
   *  integration — a matrix would need a conflict rule for the incoherent
   *  lean+god-integrates combo. Rationale: god runs on a tight token budget.
   *  The renderer/preload restart-window merge mechanism stays god-owned in
   *  every mode; a skill or dispatch boundary that forbids push always
   *  overrides (card integration-mode-toggle-20260817 + lean addendum).
   *  Threads into the generated prose (godLine, worker briefing, AGENTS.md,
   *  COMMANDS.md, identity.md). */
  integrationMode?: 'god' | 'workers' | 'lean';
  /** When true, the god agent's fresh spawns run `/remote-control Michael`,
   *  linking his session to the Claude mobile app (phone-side supervision of a
   *  bypassPermissions orchestrator — the only remote view into what he DOES,
   *  vs Telegram's what he SAYS). Default true; toggleable in Settings. */
  godRemoteControl?: boolean;
  /** The command we run when spawning a new agent. */
  defaultCommand: string;
  /** Default model for newly spawned agents (e.g. 'claude-sonnet-4-6[1m]'); unset = CLI default. */
  defaultModel?: string;
  /** Which provider powers the GOD orchestrator ("Michael"). The persona is
   *  constant; only its engine is selectable. Default 'claude'. Eligible providers
   *  are those that can receive inbox (claude/codex/antigravity/qwen). */
  godProvider?: AgentProvider;
  /** The model GOD runs on. Unset falls back to the provider preset's
   *  `recommendedOrchestratorModel`, then MODEL_GOD. Default 'claude-opus-4-8'. */
  godModel?: string;
  /** Thinking effort GOD runs at (card agent-command-center-engine-ro-
   *  2026-08-18) — provider-specific flag+vocabulary from the provider preset
   *  (claude --effort, pi --thinking). unset = the CLI's default effort; an
   *  unknown value is dropped at spawn (claude warns-and-ignores rather than
   *  failing). God-only: workers keep the CLI default. */
  godEffort?: string;
  /** Per-server consent state for the default MCP bundle, keyed by catalog id.
   *  Seeded from MCP_CATALOG (safe-readonly ON, write/secret OFF); the user flips
   *  these in Settings. A server is wired into an agent only when enabled here. */
  mcpDefaults?: { [id: string]: { enabled: boolean } };
  /** Enable semantic memory (MemPalace CLI). No-op if mempalace isn't installed. */
  semanticMemory: boolean;
  /** Embedding model for the palace: lightweight 'minilm' or multilingual 'embeddinggemma'. */
  embeddingModel: 'minilm' | 'embeddinggemma';
  /** Recurring auto-dispatch missions handled by the scheduler. */
  missions?: ScheduledMission[];
  /** Route the hourly ops standup to a cheap haiku-class clerk instead of god
   *  (card agent-harness-standup-clerk-ch-2026-08-17). DEFAULT ON (operator
   *  call): a due standup on a NON-quiet floor is answered by a one-shot clerk
   *  that reads fleet.json + tasks.json, and god is mailed ONLY on a real
   *  escalation (stalled · blocked-unowned · breaker-armed · over-budget) — on
   *  a healthy floor god hears nothing. `false` restores the old behaviour
   *  (the standup dispatch lands in god's inbox every hour). Orthogonal to
   *  `skipWhenFloorQuiet`, which still skips a quiet floor before any of this. */
  standupClerk?: boolean;
  /** One-time guard: has the built-in hourly ops standup been seeded into an
   *  existing install's missions? Prevents re-adding it after a user deletes it. */
  opsStandupSeeded?: boolean;
  /** One-time guard for the built-in heartbeat mission (mirrors opsStandupSeeded
   *  so a user who deletes the heartbeat doesn't get it re-added every boot). */
  heartbeatSeeded?: boolean;
  /** maint-1 guard for the dedicated auto-compact maintenance mission. UNLIKE the
   *  two above, this does NOT suppress re-add forever: once seeded (flag set), a
   *  later delete makes the mission reappear DISABLED on next boot (compaction is
   *  required, so it's never silently lost — only user-disabled). */
  compactMaintenanceSeeded?: boolean;
  /** DEPRECATED (v0.3.4): config-file only, no UI anywhere. Hard dollar ceiling
   *  across all active agents. Still enforced if present so legacy configs keep
   *  their guard, but the token cap (costCapTokens) is the real budget —
   *  scheduled for removal next release. */
  costCapUsd?: number;
  /** Hard TOKEN ceiling (total tokens across all active agents) before the
   *  breaker trips. The user-facing budget — set in Settings. Opt-in like the
   *  $-cap; total = input + output + cacheRead + cacheCreation, summed across the
   *  floor (the biggest token spender is blamed). */
  costCapTokens?: number;
  /** Per-agent total-token ceiling, keyed by agent id. When an agent's own total
   *  tokens exceed its cap the breaker trips that agent alone (independent of the
   *  floor budget). Set from each agent's card in the Command Center. */
  agentTokenCaps?: Record<string, number>;
  /** Agent ids whose automatic inbox/queue delivery is paused. Pending messages
   *  stay durable until the operator explicitly resumes delivery. */
  autoDeliveryPausedAgents?: string[];
  /** Passed to every spawned agent as `--max-turns <n>` when set; unset = no cap
   *  (Claude Code's default). A coarse runaway guard independent of the breaker. */
  maxTurns?: number;
  /** Max concurrent god-triggered ephemeral Slack workers; extra spawn-requests
   *  wait in the queue (natural backpressure, a resource backstop). Default 4.
   *  This is the HEADLESS-EPHEMERAL cap only — it never counts hires/interns on
   *  the floor; that ceiling is `floorMaxAgents` (see there). */
  maxConcurrentWorkers?: number;
  /** Master switch for the OLD ephemeral-worker system (spawn-requests with
   *  `persistent` unset/false). DEFAULT OFF — workers are superseded by interns
   *  on this floor (operator order, card
   *  agent-harness-workersenabled-d-2026-08-17): while off, non-persistent
   *  spawn-requests fast-fail with an actionable error naming this setting, and
   *  the workers tab in god's pane is hidden. Because DEFAULTS carries `false`
   *  and `readConfig` merges over it, existing installs whose config.json
   *  predates the field ALSO read off — the deliberate default asymmetry with
   *  `internsEnabled`. */
  workersEnabled?: boolean;
  /** Master switch for the intern path (spawn-requests with
   *  `persistent: true`). DEFAULT ON — while off, persistent spawn-requests
   *  fast-fail with an actionable error naming this setting (same card as
   *  `workersEnabled`). */
  internsEnabled?: boolean;
  /** DEFAULT provider/CLI + model for INTERN spawns (persistent
   *  spawn-requests), operator-configured in Settings → Autonomy & Budgets
   *  (card agent-harness-settings-section-2026-08-17). Resolution in
   *  src/main/internDefaults.ts: request field > this default > the existing
   *  fallbacks — god's per-intern overrides always win. Unset fields keep
   *  today's behavior; ephemeral workers never read this. */
  internDefaults?: { provider?: AgentProvider; model?: string };
  /** Engine for the harness's own HIDDEN one-shot helpers (standup clerk,
   *  memory condenser). Resolution in src/main/hiddenHelpers.ts:
   *   helperDefaults > godProvider (the onboarding driver choice) > 'claude'.
   *   Model: helperDefaults.model > claude's haiku-class helper constant >
   *   the CLI's own default (pi runs with NO --model flag). Settings →
   *   Autonomy & Budgets (next to the standup clerk switch). Unset keeps
   *   today's behavior exactly. */
  helperDefaults?: { provider?: AgentProvider; model?: string };
  /** Physical workplaces on the office floor — the hard ceiling on hires +
   *  interns ON THE FLOOR at once (god excluded; the office ships 16 desks).
   *  Operator-downsizable (Settings → Autonomy & Budgets, 1..16). Enforced in
   *  spawnAgentCore, the single door every spawn path passes through (Add Agent,
   *  restore-team, god spawn-requests incl. interns). DISTINCT from
   *  `maxConcurrentWorkers`, which caps only the headless ephemeral-worker queue
   *  concurrency. Default 16 (card agent-harness-floormaxagents-s-2026-08-17). */
  floorMaxAgents?: number;
  /** Minutes an ephemeral worker may produce NO output before the reaper kills it
   *  — idle-based, never wall-clock, so an actively-working worker is never reaped.
   *  Default 20. */
  workerIdleTimeoutMinutes?: number;
  /** Registered integrations (Phase 2) — labeled REST endpoints workers reach through
   *  the loopback secret broker. METADATA ONLY: each record carries a `secretRef`
   *  handle, never the secret value (secrets live encrypted in a separate file via
   *  Electron safeStorage — see src/main/integrations.ts). Default []. */
  integrations?: IntegrationRecord[];
  /** Default per-worker TOTAL-token cap (input+output+cache) applied to every
   *  god-triggered ephemeral worker; a worker's own spawn-request `tokenCap`
   *  overrides it. When the effective cap is exceeded the worker is reaped (its
   *  committed work preserved) and god is informed. This is PLUMBING for a later
   *  budget feature: per the human directive there is NO per-worker cap today, so
   *  the default is 0 = UNLIMITED — the mechanism is wired but never throttles
   *  unless someone explicitly sets a positive cap (per request or here). */
  defaultWorkerTokenCap?: number;
  /** Circuit-breaker thresholds (Lane A #6.6b). Unset = conservative defaults. */
  circuitBreaker?: CircuitBreakerConfig;
  /** Enterprise Knowledge Graph (multimodal context for agents). Default OFF. */
  knowledgeGraph?: KnowledgeGraphConfig;
  /** Fire native desktop notifications on agent lifecycle events (idle finish / waiting for input). */
  notifications?: boolean;
  /** Kitty integration (card agent-harness-kittyenabled-set-2026-08-17) —
   *  gates EVERY kitty feature: the satellite window + kitty buttons, and
   *  detach-to-kitty panes/tabs. DEFAULT OFF, and a MISSING field reads as
   *  off for existing configs. If on, assumes kitty is installed. */
  kittyEnabled?: boolean;
  /** Opt-in "strong keep-alive": while ≥1 agent PTY is live, escalate the power
   *  blocker from 'prevent-app-suspension' to 'prevent-display-sleep', which on
   *  macOS also blocks TRUE system sleep (lid-close/idle) so scheduled missions
   *  and terminals keep firing ON TIME while away — at a battery cost (best on
   *  AC). Default OFF: the honest default is "survive sleep + catch up once on
   *  resume" (see the powerMonitor 'resume' handler), not "stay awake". */
  strongKeepalive?: boolean;
  /** Auto-update from GitHub releases (v0.3.4). Default ON. Packaged builds
   *  check on boot + every ~6h, download in the background, and show a
   *  "restart to update" toast — installation is always user-initiated. OFF
   *  disables checking entirely. (Mirrored in preload + renderer config.) */
  autoUpdate?: boolean;
  /** Multi-window "floors": expose a New Floor action that opens additional
   *  windows, each an independent office with isolated renderer state (its own
   *  session partition) and per-window PTY routing. ON by default (v0.3.4: code
   *  and comment disagreed; the shipped behavior — enabled — wins) —
   *  the window/PTY-ownership plumbing is always active and single-window-safe,
   *  but the New Floor entry points (app menu item + IPC) only appear when on.
   *  The on-disk hive (god orchestration under harnessHome) stays process-global;
   *  floors share it. */
  multiWindow?: boolean;
  /** Terminal theme — mirrored into each agent's per-session Claude settings
   *  ("theme" key) at spawn so the TUI's truecolor palette matches. Scoped to
   *  harness agents only; the user's global Claude theme is never touched. */
  terminalTheme?: 'light' | 'dark';
  /** Anonymous product analytics (PostHog) — the exact events/properties are
   *  documented in TELEMETRY.md. Default ON (opt-out, like autoUpdate); builds
   *  without an injected key and environments with DO_NOT_TRACK set never send
   *  regardless of this flag. (Mirrored in preload + renderer config.) */
  telemetryEnabled?: boolean;
  /** Master flag for the TV-show office themes feature (Settings theme picker +
   *  destructive switch flow). Default false = the picker is hidden and the
   *  office renders as today (zero behavior change). */
  tvShowOffices?: boolean;
  /** Which office map/cast theme the pixel office renders. Only honored when
   *  `tvShowOffices` is on; otherwise the office theme is used. Unbuilt show
   *  themes fall back to 'office' in the loader. */
  officeTheme?:
    | 'office'
    | 'custom'
    | 'friends'
    | 'brooklyn99'
    | 'siliconvalley'
    | 'got'
    | 'hogwarts';
  /** Per-CLI-provider local/self-hosted base URL (Ollama/LM Studio/vLLM, …) for the
   *  OpenCode/Crush/pi/qwen engines; applied at spawn (config-injection or proxy
   *  upstream). API KEYS are NOT stored here — they live write-only in the secret
   *  broker (integrations.ts), read MAIN-ONLY at spawn. */
  providerBaseUrls?: Partial<Record<AgentProvider, string>>;
  /** Per-CLI-provider default model slug, used to pre-fill the model picker. */
  providerDefaultModels?: Partial<Record<AgentProvider, string>>;
  /** Master toggle for the Slack → Michael's-queue integration. */
  slackEnabled?: boolean;
  /** Slack app signing secret (Basic Information → Signing Secret). Never logged. */
  slackSigningSecret?: string;
  /** Bot token (xoxb-…) — only needed if the bot ever replies; optional for now. */
  slackBotToken?: string;
  /** Restrict ingestion to one channel id; empty/undefined = any channel. */
  slackChannelId?: string;
  /** Local HTTP port the webhook server binds to (default 3847). */
  slackPort?: number;
  /** Opt-in: allow APP/VOICE-INITIATED proactive posting into Slack (e.g. the
   *  renderer's "queued" acknowledgement). DEFAULT OFF per the human directive
   *  "stop posting into Slack by default". This does NOT gate the Slack-ORIGIN
   *  done-reply round-trip (a user @-mention → task → result posted back to that
   *  thread) or an agent's own direct in-thread reply — those always stay on. */
  slackProactivePosting?: boolean;
  /** Master toggle for the Telegram trigger. UNSET = enabled, which keeps the
   *  pre-Settings behaviour intact: `.env.telegram` carrying a token ⇒ the
   *  trigger polls (the file stays the feature's storage; the TOKEN itself never
   *  lives here — config.json is renderer-visible, .env.telegram is not).
   *  `false` fully stops bot polling, live (no restart). Mirrors slackEnabled. */
  telegramEnabled?: boolean;

  // ─── Free Flow (voice dictation → message queue) ───────────────────────────
  /** Master toggle for Free Flow push-to-talk dictation. Default OFF: with it off
   *  the composer shows no mic button, no getUserMedia runs, and no Groq call is
   *  ever made (zero behavior change). */
  freeflowEnabled?: boolean;
  /** User-pasted Groq API key (the user supplies their own free key). Used ONLY in
   *  the main process for the Groq STT call; NEVER logged, and never crosses IPC
   *  for the request. Treated like `slackBotToken`. */
  groqApiKey?: string;
  /** Groq Whisper model id. Default 'whisper-large-v3-turbo' (fast, multilingual). */
  freeflowModel?: string;

  // ─── Realtime Michael (premium speech-to-speech voice orchestrator) ─────────
  /** True ONLY while a Realtime Michael voice session is live: the renderer
   *  session flips this on at start() (before getUserMedia) and off at stop().
   *  The main-process mic permission gate reads it so the Electron media
   *  permission is open EXACTLY while the voice loop holds the mic — never just
   *  because an OpenAI key exists (that key is shared with the CLI engines).
   *  Default off; absence ⇒ mic denied, mirroring `freeflowEnabled`. */
  realtimeVoiceEnabled?: boolean;
  /** How long (ms) a realtime voice session may sit with no voice activity before
   *  it auto-disconnects (the rt-9 idle guard). Default 180000 (3 min). 0 = never
   *  auto-disconnect on idle — the spend cap remains the runaway guard. The user
   *  tunes this in Settings → Realtime Michael. */
  realtimeIdleDisconnectMs?: number;

  // ─── Generic inbound webhook + status API (LEGACY, single-endpoint) ─────────
  // Superseded by `webhookTriggers`, which allows many endpoints over one server
  // and one tunnel. These three are kept because they are the MIGRATION SOURCE
  // (`migrateTriggersV1` folds them into a `WebhookTrigger`) and because the main
  // process still reads them until the server is rewired onto the new list.
  // Nothing new should be written here.
  /** @deprecated Use `webhookTriggers[].enabled`. */
  webhookEnabled?: boolean;
  /** App-generated shared secret callers echo in `x-md-webhook-secret`. Never
   *  logged, and never forwarded into the routed message/card/response.
   *  @deprecated Use `webhookTriggers[].secret` (one secret per endpoint, so
   *  revoking one caller never disturbs the others). */
  webhookSecret?: string;
  /** Local HTTP port the generic webhook server binds to (default 3849).
   *  @deprecated The port is a property of the shared server, not of any one
   *  trigger; `webhookTriggers` are multiplexed over it by id. */
  webhookPort?: number;

  // ─── Triggers (src/shared/triggers.ts owns every type here) ────────────────
  /** Auto-compaction / auto-clearing of agent terminal context. Both halves ship
   *  in DEFAULT_CONTEXT_TRIGGER; `readConfig` deep-fills them, because the
   *  top-level merge below is one level deep and a half-written sub-object would
   *  otherwise reach consumers with `undefined` thresholds. */
  contextTrigger?: ContextTriggerConfig;
  /** Inbound HTTP endpoints, one entry per caller. Replaces the legacy single
   *  webhook above; several coexist on one port, told apart by `id` in the path. */
  webhookTriggers?: WebhookTrigger[];
  /** Peer messaging between teammates' clone nodes. Persistence + UI only today —
   *  no transport service reads `apiKey` yet. */
  orgTrigger?: OrgTriggerConfig;
  /** One-time guard for `migrateTriggersV1` (legacy webhook → webhookTriggers,
   *  1h → 2h compact cadence). Set once the migration has run to completion. */
  triggersMigratedV1?: boolean;

  // ─── Memory reflection (the janitor's condense half) ───────────────────────
  /** Master toggle for the in-process MemoryReflector. Default on. */
  reflectEnabled?: boolean;
  /** How often to scan agent memory.md files for condensing (default 30 min). */
  reflectIntervalMs?: number;
  /** Condense when bytes exceed this percent of the 128 KB budget (matches the
   *  janitor's TRIGGER_PCT). DECIDED: 50. */
  reflectByteTriggerPct?: number;
  /** ...OR when `## ` section count exceeds this (AND bytes > floor). DECIDED: 50. */
  reflectSectionTrigger?: number;
  /** Newest K verbatim `## ` sections kept untouched on each condense. */
  reflectRecentKeep?: number;
  /** Never condense a file smaller than this; also the section-trigger byte floor.
   *  DECIDED: 16 KB. */
  reflectMinBytes?: number;
}

const DEFAULTS: HarnessConfig = {
  onboardingComplete: false,
  harnessHome: null,
  recentHives: [],
  registeredRepos: [],
  workerBypass: false,
  sddSubagentsAuthorized: true,
  integrationMode: 'god',
  godRemoteControl: true,
  defaultCommand: 'claude',
  godProvider: 'claude',
  godModel: 'claude-opus-4-8',
  // Global default model for every agent that hasn't picked one explicitly — wins
  // over the role-based tiers (modelForRole) in the spawn handler, so all agents
  // (incl. god) default to Fable 5. A per-agent model choice still overrides it.
  defaultModel: 'claude-fable-5',
  // Seeded from the MCP catalog so the consent defaults never drift from it
  // (safe-readonly ON, write/secret OFF).
  mcpDefaults: defaultMcpDefaults(),
  maxConcurrentWorkers: 4,
  // The spawn-switch asymmetry (card agent-harness-workersenabled-d-2026-08-17):
  // the old ephemeral-worker system ships OFF (superseded by interns), interns
  // ship ON. readConfig merges over these, so configs predating the fields
  // resolve to exactly this.
  workersEnabled: false,
  internsEnabled: true,
  // The office ships 16 physical workplaces — the default floor ceiling.
  floorMaxAgents: 16,
  workerIdleTimeoutMinutes: 20,
  integrations: [],
  defaultWorkerTokenCap: 0, // 0 = unlimited (human directive: NO per-worker cap)
  semanticMemory: true,
  embeddingModel: 'minilm',
  missions: [OPS_STANDUP_MISSION],
  // The standup goes to a cheap clerk, not to god (operator call). Existing
  // installs read the same default: readConfig merges over DEFAULTS, so a
  // config.json predating the field routes to the clerk too.
  standupClerk: true,
  notifications: false,
  kittyEnabled: false,
  strongKeepalive: false,
  autoUpdate: true,
  telemetryEnabled: true,
  multiWindow: true,
  tvShowOffices: false,
  officeTheme: 'office',
  slackEnabled: false,
  slackSigningSecret: undefined,
  slackBotToken: undefined,
  slackChannelId: undefined,
  slackPort: undefined,
  slackProactivePosting: false,
  freeflowEnabled: true,
  groqApiKey: undefined,
  freeflowModel: 'whisper-large-v3-turbo',
  realtimeVoiceEnabled: false,
  realtimeIdleDisconnectMs: 180_000,
  webhookEnabled: false,
  webhookSecret: undefined,
  webhookPort: undefined,
  // Triggers. These three are the ONLY object/array defaults that get handed
  // straight back out of `readConfig` for a config that never persisted them, so
  // `withTriggerDefaults` re-copies them on every read — see the note there.
  contextTrigger: DEFAULT_CONTEXT_TRIGGER,
  webhookTriggers: [],
  orgTrigger: DEFAULT_ORG_TRIGGER,
  triggersMigratedV1: false,
  // Memory reflection — preventive; nobody is over threshold today, so it sits
  // dark until an agent's memory crosses one of these (the verify gate is the
  // safety for the LLM step). Thresholds DECIDED by god 2026-06-06.
  reflectEnabled: true,
  reflectIntervalMs: 1_800_000,
  reflectByteTriggerPct: 50,
  reflectSectionTrigger: 50,
  reflectRecentKeep: 12,
  reflectMinBytes: 16_384,
  // Enterprise Knowledge Graph — opt-in; dark until the user enables it.
  // v0.3.4 fix: default OFF, matching the field's own documentation ("Default
  // OFF / dark until enabled") — the true default contradicted it. Existing
  // installs keep their persisted value.
  knowledgeGraph: { enabled: false },
};

function configPath(): string {
  return join(app.getPath('userData'), 'config.json');
}

/**
 * Deep-fill the trigger sub-objects, and hand back copies of them.
 *
 * TWO problems, one fix. First, the merge in `readConfig` is one level deep, so a
 * `contextTrigger` persisted by an older build (or by a `writeConfig` that
 * patched only `compact`) arrives missing sub-keys that DEFAULTS would have
 * supplied — the consumer then reads `undefined` where it expects a number and
 * the rule never fires. Second, that same shallow merge hands the literal
 * DEFAULT_CONTEXT_TRIGGER / DEFAULT_ORG_TRIGGER instances to every config that
 * didn't persist them, so one caller mutating what it read would rewrite the
 * defaults for the whole process — and for every config read afterwards.
 *
 * Every branch below therefore constructs a fresh object, including the
 * "nothing persisted" branch.
 */
function withTriggerDefaults(cfg: HarnessConfig): HarnessConfig {
  return {
    ...cfg,
    contextTrigger: {
      compact: { ...DEFAULT_CONTEXT_TRIGGER.compact, ...cfg.contextTrigger?.compact },
      clear: { ...DEFAULT_CONTEXT_TRIGGER.clear, ...cfg.contextTrigger?.clear },
    },
    orgTrigger: { ...DEFAULT_ORG_TRIGGER, ...cfg.orgTrigger },
    webhookTriggers: Array.isArray(cfg.webhookTriggers)
      ? cfg.webhookTriggers.map((t) => ({ ...t }))
      : [],
  };
}

/** Set once `migrateTriggersV1` has run in THIS process. `writeConfig` reads
 *  before it writes, so without an in-memory latch the migration's own persist
 *  would re-enter `readConfig` and run the migration a second time before
 *  `triggersMigratedV1: true` ever reached disk. */
let triggersMigrationRan = false;

/**
 * Fold the pre-Triggers config shape forward, exactly once per install.
 *
 * Runs from `readConfig`, so it is complete before any consumer can observe the
 * config — there is no boot ordering to get wrong and no window in which half
 * the app sees the old shape. Two things move:
 *
 *   1. The single legacy webhook (`webhookEnabled`/`webhookSecret`) becomes one
 *      `WebhookTrigger` with the stable id `legacy`, so the caller that already
 *      holds that secret keeps working across the upgrade. Skipped when
 *      `webhookTriggers` is already populated — the user has moved on, and
 *      re-adding a synthesised entry would resurrect a revoked endpoint.
 *   2. The seeded `compact-maintenance` mission moves from the old 1h cadence to
 *      2h, but ONLY if it still reads exactly 1h. A user-chosen interval is a
 *      decision, not a stale default, and is left alone.
 *
 * Wrapped end-to-end in a try/catch: a config that is corrupt in some unrelated
 * way must still boot the app, and a migration is never worth a failed launch.
 */
function migrateTriggersV1(cfg: HarnessConfig): HarnessConfig {
  if (cfg.triggersMigratedV1 || triggersMigrationRan) return cfg;
  triggersMigrationRan = true;
  try {
    const next: HarnessConfig = { ...cfg, triggersMigratedV1: true };

    const legacySecret = typeof cfg.webhookSecret === 'string' ? cfg.webhookSecret.trim() : '';
    if (legacySecret && (cfg.webhookTriggers?.length ?? 0) === 0) {
      next.webhookTriggers = [
        {
          id: 'legacy',
          name: 'Default webhook',
          secret: legacySecret,
          enabled: cfg.webhookEnabled ?? false,
          mode: DEFAULT_TRIGGER_MODE,
          schema: DEFAULT_WEBHOOK_SCHEMA,
          createdAt: Date.now(),
        },
      ];
    }

    const missions = Array.isArray(cfg.missions) ? cfg.missions : [];
    const stale = (m: ScheduledMission): boolean =>
      m?.id === COMPACT_MAINTENANCE_MISSION.id &&
      m.intervalMs === LEGACY_COMPACT_MAINTENANCE_INTERVAL_MS;
    if (missions.some(stale)) {
      next.missions = missions.map((m) =>
        stale(m) ? { ...m, intervalMs: COMPACT_MAINTENANCE_MISSION.intervalMs } : m,
      );
    }

    persistConfig(next);
    return next;
  } catch {
    // Leave the config exactly as read. The latch above stays set, so a failing
    // migration retries on the next launch rather than on every single read.
    return cfg;
  }
}

/** Resolve the two spawn switches (card
 *  agent-harness-workersenabled-d-2026-08-17) with their asymmetric defaults:
 *  workers OFF unless explicitly `true`, interns ON unless explicitly `false`.
 *  The spawn gate and any other consumer read through this so the defaults
 *  can't drift — it also re-encodes them, so even a config that somehow missed
 *  the DEFAULTS merge resolves to the shipped asymmetry. */
export function spawnSwitches(cfg: Pick<HarnessConfig, 'workersEnabled' | 'internsEnabled'>): {
  workers: boolean;
  interns: boolean;
} {
  return { workers: cfg.workersEnabled === true, interns: cfg.internsEnabled !== false };
}

/** `floorMaxAgents` clamped into the office's physical range (1..16 workplaces);
 *  unset/invalid → 16 (the full floor). Shared by the spawn gate, the fleet
 *  snapshot, and the settings widget so they can't drift apart. */
export function normalizeFloorMaxAgents(n: number | undefined | null): number {
  return typeof n === 'number' && Number.isFinite(n)
    ? Math.min(16, Math.max(1, Math.floor(n)))
    : 16;
}

export function readConfig(): HarnessConfig {
  const p = configPath();
  // No file yet = a first run with nothing to migrate; the defaults ARE the
  // post-migration shape. Deliberately does not persist — a bare read must not
  // conjure a config.json before onboarding has written one.
  if (!existsSync(p)) return withTriggerDefaults({ ...DEFAULTS });
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return migrateTriggersV1(withTriggerDefaults({ ...DEFAULTS, ...parsed }));
  } catch {
    return withTriggerDefaults({ ...DEFAULTS });
  }
}

function persistConfig(next: HarnessConfig): HarnessConfig {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function writeConfig(patch: Partial<HarnessConfig>): HarnessConfig {
  const current = readConfig();
  const next: HarnessConfig = { ...current, ...patch };
  // Project INGESTION — a registered repo is typed by hand ("~/dev/foo") as often
  // as it is picked from the folder dialog. Expand `~` here so the persisted list
  // (and therefore every agent's default cwd) is ABSOLUTE; Node's fs/spawn treat
  // `~` as a literal directory name and the spawn dies with `cwd does not exist`.
  if (Array.isArray(patch.registeredRepos)) {
    const seen = new Set<string>();
    next.registeredRepos = patch.registeredRepos
      .map((r) => expandTilde(r))
      .filter((r) => r && !seen.has(r) && (seen.add(r), true));
  }
  // Track recently-opened hive homes so the launch picker can list them. Any write
  // that SETS harnessHome (onboarding finish, changeHome) promotes it to the front,
  // deduped and capped. Skips empty/null so a clear doesn't pollute the list.
  if (typeof patch.harnessHome === 'string' && patch.harnessHome) {
    const prior = current.recentHives ?? [];
    next.recentHives = [patch.harnessHome, ...prior.filter((h) => h !== patch.harnessHome)].slice(
      0,
      8,
    );
  }
  return persistConfig(next);
}

/** Wipe the persisted config back to first-run defaults so the app boots into
 *  onboarding again. Used by the "reset & start over" flow. */
export function resetConfig(): HarnessConfig {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(DEFAULTS, null, 2), 'utf8');
  // Drop the migration latch too: the file on disk is back to `triggersMigratedV1:
  // false`, and a latch left set would keep the flag from ever being written again
  // in this process. The migration itself is a no-op on defaults either way.
  triggersMigrationRan = false;
  return withTriggerDefaults({ ...DEFAULTS });
}

/** Model ids by tier (Lane A #6.4). Kept in sync with AGENT_MODELS in
 *  src/renderer/src/store/config.ts. */
const MODEL_GOD = 'claude-opus-4-8'; // orchestration — highest capability
const MODEL_WORKER = 'claude-sonnet-4-6'; // general execution
const MODEL_HELPER = CLAUDE_HELPER_MODEL; // narrow, cheap helpers (single source)

/** Minimal structural shape for tiering — a subset of AgentMeta so config.ts
 *  stays free of a hive.ts import. */
export interface RoleHint {
  isGod?: boolean;
  role?: string;
  capabilities?: string[];
}

/** Default model for an agent given its role (Lane A #6.4): Opus for the god,
 *  Haiku for narrow helpers (triage / routing / verification / formatting),
 *  Sonnet for general workers. Returns a model id (matching AGENT_MODELS) or
 *  undefined to fall back to the CLI default. This is only a DEFAULT — an
 *  explicit per-agent model selection always wins. */
export function modelForRole(
  meta: RoleHint,
  config?: Pick<HarnessConfig, 'godProvider' | 'godModel'>,
): string | undefined {
  if (meta.isGod) {
    // GOD engine is selectable: an explicit godModel wins, else the chosen
    // provider's recommended orchestrator model, else the legacy Opus default.
    const preset = providerPreset(config?.godProvider ?? 'claude');
    return config?.godModel ?? preset.recommendedOrchestratorModel ?? MODEL_GOD;
  }
  const hay = `${meta.role ?? ''} ${(meta.capabilities ?? []).join(' ')}`.toLowerCase();
  if (/\b(triage|rout|verif|lint|format|summar|classif|label)/.test(hay)) return MODEL_HELPER;
  return MODEL_WORKER;
}

/** Ensure harnessHome exists on disk. */
export function ensureHarnessHome(path: string): { ok: boolean; error?: string } {
  try {
    mkdirSync(path, { recursive: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Idempotently pre-accept Claude Code's first-run prompts so agents spawned
 *  with bypass permissions (claude: `--dangerously-skip-permissions`) start
 *  cleanly. Without this, a fresh
 *  install shows an interactive "WARNING: Bypass Permissions mode … 1. No, exit /
 *  2. Yes, I accept" prompt that the PTY can't answer in time, so the agent exits
 *  code 1 on its own (reported by multiple users).
 *
 *  Two separate gates, written only when they aren't already satisfied (so we
 *  rarely touch files a running `claude` also writes):
 *   1. `~/.claude/settings.json` → `skipDangerousModePermissionPrompt` +
 *      `skipAutoPermissionPrompt` — these gate the bypass-mode warning (global).
 *   2. `~/.claude.json` → `projects[cwd].hasTrustDialogAccepted` — the per-folder
 *      "do you trust the files in this folder?" dialog. */
export function ensureClaudePermissionsAccepted(cwd?: string): void {
  const home = homedir();
  if (!home) return;
  // 1) Global bypass-mode warning gate.
  try {
    const dir = join(home, '.claude');
    const p = join(dir, 'settings.json');
    let s: Record<string, unknown> = {};
    if (existsSync(p)) {
      try {
        s = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
      } catch {
        s = {};
      }
    }
    if (s.skipDangerousModePermissionPrompt !== true || s.skipAutoPermissionPrompt !== true) {
      s.skipDangerousModePermissionPrompt = true;
      s.skipAutoPermissionPrompt = true;
      mkdirSync(dir, { recursive: true });
      writeFileSync(p, JSON.stringify(s, null, 2), 'utf8');
    }
  } catch {
    /* best-effort; never block a spawn */
  }
  // 2) Per-folder trust dialog gate (only when this cwd isn't already trusted).
  if (cwd) {
    try {
      const p = join(home, '.claude.json');
      let c: { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> } = {};
      if (existsSync(p)) {
        try {
          c = JSON.parse(readFileSync(p, 'utf8'));
        } catch {
          c = {};
        }
      }
      if (c.projects?.[cwd]?.hasTrustDialogAccepted !== true) {
        c.projects = c.projects ?? {};
        c.projects[cwd] = { ...(c.projects[cwd] ?? {}), hasTrustDialogAccepted: true };
        writeFileSync(p, JSON.stringify(c, null, 2), 'utf8');
      }
    } catch {
      /* best-effort */
    }
  }
}
