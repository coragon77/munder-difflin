/**
 * The Hive — the on-disk multi-agent coordination layer.
 *
 * Lives under `<harnessHome>/hive/` as a single git repo that ONLY this main
 * process commits to (agents never call git — they just write files). See
 * HIVE.md for the full design. Responsibilities:
 *   - per-agent workspace (identity.md, memory.md, inbox/, outbox/, cursor.json)
 *   - a roster (registry.json), shared blackboard (board.md), task ledger,
 *     and an append-only event log (log.jsonl)
 *   - a router that drains each agent's outbox into recipients' inboxes
 *
 * Human-in-the-loop is native to each agent's Claude Code session: permission
 * prompts surface in the agent's own terminal (and can be approved remotely via
 * `/remote-control`). The hive keeps no separate approval queue — a message aimed
 * at "human" is routed to the god/orchestrator, the human's proxy on the floor.
 *   - single-committer git with retry/backoff + stale-lock recovery
 *
 * Everything here runs in the Electron main process.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  statSync,
  rmSync,
  appendFileSync,
  symlinkSync,
  copyFileSync,
  chmodSync,
  cpSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import type { AgentUsageSample } from './usage';
// ONE definition of actionable (card agent-actionablecards-one-shar-2026-08-
// 18) — serialized verbatim (toString) into the generated bin/ CLIs below so
// the gate, the lister and the roster injection run identical code.
import { actionableCards, cardHeld, renderActionableLine } from './actionableCards';
import { COMMAND_GROUPS } from '../shared/claudeCommands';
import {
  isClaudeProvider,
  isHiveAwareProvider,
  canReceiveInbox,
  providerPreset,
  bridgeOf,
  type AgentProvider,
  type HirePermissionMode,
} from '../shared/agentProvider';
import { MCP_CATALOG } from '../shared/mcpCatalog';
import { hasInboxMonitor } from '../shared/providerAutomation';
import { cardSessionMailHold, MAIL_STAGE_TIMEOUT_MS, type CardLike } from './cardSessions';
import { waitingLabel } from '../shared/waitingLabel';
import { isSystemMail } from '../shared/hiveMail';
import { compareAgentOrder } from '../shared/agentOrder';
import { expandTilde } from './fs';

/** The subset of HarnessConfig the hive consumes for the default-MCP merge.
 *  Kept as a local shape so hive.ts never imports the foundation-owned config
 *  module just for a type. */
type McpDefaultsMap = { [id: string]: { enabled: boolean } } | undefined;

// ─── Types ──────────────────────────────────────────────────────────────────

export type MessageAct = 'request' | 'inform' | 'propose' | 'query' | 'agree' | 'refuse' | 'done';

export interface HiveMessage {
  id: string;
  conversation: string;
  in_reply_to: string | null;
  from: string;
  to: string; // an agentId, 'god', or 'broadcast'
  act: MessageAct;
  subject: string;
  body: string;
  /** The kanban card this mail is about (card human-task-mail-card-ref:
   *  the tasks-tab 'Task from the human' mail references its created card so
   *  god enriches and assigns THAT card instead of minting a duplicate).
   *  Machine-readable twin of the 'Card: <id>' body line; optional. */
  cardId?: string;
  hops: number;
  requires_reply: boolean;
  needs_human: boolean;
  created_at: string;
}

/** One hive message reshaped for the voice read-layer (`hive:messages`): the
 *  operator-briefing view of an inbox/outbox message. `subject` and `body` are
 *  REDACTED main-side (see {@link redactSecrets}) before this ever leaves the
 *  main process — the renderer/voice layer never sees a raw body, and never a
 *  secret. PII-free + secret-free by construction. */
export interface VoiceMessage {
  id: string;
  conversation: string;
  from: string;
  to: string;
  act: MessageAct;
  /** REDACTED subject line. */
  subject: string;
  /** REDACTED message body. */
  body: string;
  requires_reply: boolean;
  /** Which mailbox folder this copy was read from, relative to `owner`. */
  direction: 'inbox' | 'outbox';
  /** The agent whose mailbox this copy lives in. */
  owner: string;
  /** True when read from an archived/handled subfolder (inbox/.done, outbox/.sent). */
  archived: boolean;
  created_at: string;
}

/** One question→answer exchange with the human, recorded ON the task card so
 *  the decision trail stays with the work it unblocked. */
export interface HumanQA {
  q: string;
  a?: string;
  askedAt?: string;
  answeredAt?: string;
  dismissedAt?: string;
}

export interface HiveTask {
  id: string;
  title: string;
  description?: string;
  assignee?: string;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  dependsOn: string[];
  priority: number;
  createdAt: string;
  /** First-class human feedback: the god appends {q} when a card can only
   *  proceed with the human's input (status goes blocked); the harness UI
   *  fills in {a}. The full history stays on the card forever. */
  humanQA?: HumanQA[];
  /** Outcome summary, surfaced by the Slack done-notifier when this card reaches
   *  'done'. Optional; the notifier falls back to description/title. */
  result?: string;
  /** Set when this task originated from a Slack message — the thread the
   *  done-summary reply is posted back into. Consumed OUTBOUND only; populating
   *  it is the inbound/kanban side's job and does not affect routing. */
  slack?: { channel: string; thread_ts: string };
  /** Set when this task originated from a generic webhook POST. Stores the SHA-256
   *  of the capability token (never the raw token — that's returned to the caller
   *  once and never persisted), so a GET status lookup can match by hashing the
   *  presented token. Read-only capability: it never widens routing or exposure. */
  webhook?: { tokenHash: string };
  /** Set when the HUMAN created this card from the tasks tab (addHumanTask)
   *  or an AGENT carded itself via the hive-card CLI. Persistent origin
   *  marker: the UI's delete rule (only human-origin cards, only while still
   *  'todo') and the god's triage rely on it. */
  origin?: 'human' | 'agent';
  /** The conversation this card runs in (card-scoped-sessions-20260816): the
   *  agent's live claude session id, stamped automatically by recordSession
   *  whenever it CHANGES while the card is the agent's active 'doing' card —
   *  so it converges to the post-clear conversation without racing the queue.
   *  The /resume key when the card is picked up again after a pause. God
   *  never writes this by hand. A born-doing SELF-card (hive-card add --status
   *  doing in the agent's own pane) is stamped by the CLI at creation — it
   *  never passes through a →doing transition, so nothing else would link it
   *  (ghost-card fix, engagement-aware flips 2026-08-17). */
  sessionId?: string;
  /** Written by `hive-dispatch --adopt` / `hive-card status <id> doing
   *  --adopt` (engagement-aware flips 2026-08-17): the assignee's CURRENT
   *  conversation is this card's engagement — the card-session watcher leads
   *  with the card title and stamps that conversation, NO clear.
   *  `hive-dispatch --resume` (card agent-hive-dispatch-blocked-ca-2026-08-19)
   *  writes 'resume': the card's stored sessionId is where the work lives —
   *  the watcher resumes it (/resume for claude; god-mail for engines without
   *  a typable resume). Absent = fresh (the default: clear + lead — or, for a
   *  card WITH a stamp, the watcher's resume branch). Consumed on the →doing
   *  transition; both dispatch CLIs CLEAR a stale marker on a non-adopt flip
   *  so it can never hijack a later dispatch. */
  sessionMode?: 'adopt' | 'resume';
  /** ON-HOLD / reference-only opt-out (card agent-every-non-paused-todo-ke-
   *  2026-08-18): a paused todo stays visible in the todo column but stops
   *  counting toward the quiet-floor predicate and the todo-unattended
   *  anomaly. ORTHOGONAL to assignment (three of the four original reference
   *  cards are assigned). Absent = not paused. The hold is enforced AT THE
   *  DOING FLIP in both CLIs — hive-dispatch and hive-card status refuse a
   *  paused card (card agent-hive-dispatch-must-be-th-2026-08-18); the two
   *  operator-facing writers (overlay updateTaskStatus, voice
   *  execUpdateTask) still auto-resume — the operator is the unpause
   *  authority. */
  paused?: boolean;
}

export interface AgentMeta {
  id: string;
  name: string;
  /** Which CLI this agent runs on. Defaults to 'claude' when unset (legacy). */
  provider?: AgentProvider;
  role?: string;
  capabilities?: string[];
  cwd: string;
  isGod?: boolean;
  /** Michael's prep assistant — enriches prompts and forwards them to Michael.
   *  Send-only: excluded from broadcast fan-out so it never drains an inbox. */
  isAssistant?: boolean;
  /** One-line engagement label (card session-naming-seed-20260816). Leads the
   *  agent's FIRST user turn — the typed inbox-wake nudge (claude), the
   *  positional/flag initial prompt (codex/grok/agy), or the typed TUI seed
   *  (crush) — so the CLI's auto session name says what the hire is about
   *  instead of the generic "check your inbox…". Derived from the
   *  spawn-request's objective (or its explicit label field) at spawn; stable
   *  for the agent's lifetime (prompt-cache-safe) and registry-persisted so
   *  restore-team keeps labeling after a restart. */
  spawnLabel?: string;
}

/** One-line engagement label for a fresh hire (card session-naming-seed-20260816).
 *  An explicit spawn-request `label` (or `title`) field wins verbatim; otherwise
 *  the objective's first sentence is used — collapsed to one line and capped at
 *  80 chars on a word boundary so the session name stays readable. Empty input
 *  ⇒ '' (no label ⇒ callers keep today's generic behavior). Pure on purpose:
 *  tested directly, reused by the spawn-request path. */
export function deriveSpawnLabel(explicit: string | undefined, objective: string): string {
  const src = (explicit ?? '').trim() || objective.trim();
  if (!src) return '';
  const firstSentence = src
    .split('\n')[0]
    .split(/(?<=[.!?])\s/)[0]
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/, '');
  if (firstSentence.length <= 80) return firstSentence;
  const cut = firstSentence.slice(0, 80).lastIndexOf(' ');
  return (cut > 40 ? firstSentence.slice(0, cut) : firstSentence.slice(0, 80)).trimEnd() + '…';
}

export interface RegistryAgent extends AgentMeta {
  status: 'idle' | 'working' | 'blocked' | 'gone';
  lastSeen: number;
  /** True once the agent's terminal/PTY tab is closed. The record is retained
   *  (not deleted) so its history/memory survive; only agents with a live PTY
   *  are 'active'. Broadcast fan-out + roster reads skip archived agents. */
  archived?: boolean;
  /** True once the agent has been FIRED — retirement, not liveness. Distinct from
   *  `archived` on purpose (44df562): archiveOrphanedAgents flips `archived` on
   *  every PTY-less agent at boot, so it says "no terminal right now", never "gone
   *  for good". Retirement used to live only in the renderer's localStorage
   *  (`restorableAgents`), which meant a wipe — or simply the app restarting —
   *  brought fired agents back from the dead. It is persisted here so the refusal
   *  outlives the renderer. Cleared only by a DELIBERATE unarchive/reinstate. */
  retired?: boolean;
  /** True while the agent is ON VACATION — parked by god (or the button), off the
   *  floor at zero cost, individually recallable and PROTECTED FROM DELETION.
   *  Layered on `archived` (liveness) exactly like `retired`, and mutually
   *  exclusive with it: a vacationer is resting, a retiree is gone. Ending the
   *  vacation clears this and leaves `archived` — that is the demotion to plain
   *  ARCHIVED which deletion requires. */
  vacation?: boolean;
  /** The agent's persisted permission mode — the hire-time selector's choice
   *  for workers, or the operator-set mode for the god. spawnAgentCore reads it
   *  as the fallback rung when a spawn carries no explicit mode (the in-app god
   *  boot sends none), so the stored preference survives restarts. Write-side
   *  is unchanged (spawn meta never carries it; ensureAgent's `...prev` spread
   *  preserves it) — it changes only through operator action. */
  permissionMode?: HirePermissionMode;
  /** The agent's office identity — floor sprite + accent — persisted so every
   *  spawn path (recall, restore-team, respawn) reuses the hire-time pick
   *  instead of re-deriving it from the name (card agent-icon-persistence-
   *  20260817; the symptom was recalled Ada wearing Jim's sprite because
   *  "ada" matches no cast member). Plain strings on purpose: main must not
   *  import the pixi-bound cast module — the renderer validates against the
   *  cast on read (spawnIdentity ignores unknown names). FIRST WRITE WINS:
   *  saveOfficeIdentity only fills an empty slot, so a write-back never
   *  changes a live agent's icon. */
  officeCharacter?: string;
  officeAccent?: string;
  /** Epoch ms the agent was parked — the "parked 2h ago" the VACATION section and
   *  god's fetchable pool read. Cleared when the vacation ends. */
  vacationSince?: number;
  /** True while the agent is PINNED — the operator's standing "never park this
   *  one". A pinned worker is not vacation-eligible, no matter who asks: god's
   *  vacation-request, the UI park button, any future auto-park. Set only via
   *  setPinned (the UI toggle's IPC); survives restarts and recalls through the
   *  `...prev` spread (like permissionMode). Never applies to the god agent. */
  pinned?: boolean;
  /** Most recent Claude Code session_id seen for this agent (Lane A #6.6a),
   *  captured from hook payloads. Doubles as the `--resume` key (idempotent
   *  resume after a crash/restart) AND the cost accounting/dedup key on every
   *  AgentUsageSample / cost-ledger row. */
  sessionId?: string;
  /** Epoch ms the CURRENT conversation began (set by recordSession when the
   *  session id CHANGES). The card-session watcher's adopt rule reads it: a
   *  →doing flip with a YOUNG live session adopts that conversation instead of
   *  queueing a redundant clear that would wipe it (the god manual-clear race,
   *  card-session-stamp-never-fires-20260816). lastSeen is NOT a proxy — several
   *  lifecycle paths touch it. */
  sessionStartedAt?: number;
  /** Whether `cwd` is actually usable for a (re)spawn — i.e. an ABSOLUTE path
   *  that exists as a directory. Computed + persisted at spawn so the roster
   *  reliably exposes each worker's environment validity. A non-absolute fragment
   *  (e.g. "ClaudeTerminalHarness") spawns into a nonexistent dir and fails; this
   *  flag makes that visible instead of letting it slip through silently. */
  cwdValid?: boolean;
}

export interface Registry {
  godId: string | null;
  agents: Record<string, RegistryAgent>;
}

/** How many physical workplaces on the floor are occupied right now — every
 *  live hire/intern (not archived, not on vacation, not retired), god excluded.
 *  The `floorMaxAgents` spawn gate (spawnAgentCore) and the fleet snapshot's
 *  `floor` block both read this one census so gate and reporting can't drift.
 *  `excludeId` lets a respawn keep its own seat warm (re-entering the same id
 *  never counts against itself). Pure on purpose — tested directly. */
export function floorCensus(reg: Registry, excludeId?: string): number {
  let n = 0;
  for (const [id, a] of Object.entries(reg.agents)) {
    if (id === excludeId) continue;
    if (id === reg.godId || a.isGod) continue; // god has his own desk
    if (a.archived || a.vacation || a.retired) continue; // off the floor
    n++;
  }
  return n;
}

/** One-agent-per-directory (operator addendum, card
 *  agent-harness-floormaxagents-s-2026-08-17): find who occupies a physical
 *  checkout. `resolvedDirs` maps live agent id → its RESOLVED working
 *  directory (the live worktree path when the agent is worktree-isolated,
 *  else the registry cwd) — the caller resolves, so this stays a pure string
 *  comparison and is tested directly. Returns the occupant's id or null.
 *  `excludeId` keeps a respawn from colliding with its own seat. */
export function findCheckoutOccupant(
  resolvedDirs: ReadonlyMap<string, string>,
  dir: string,
  excludeId?: string,
): string | null {
  for (const [id, d] of resolvedDirs) {
    if (id === excludeId) continue;
    if (d === dir) return id;
  }
  return null;
}

/** The one-agent-per-directory spawn refusal — names the holder, the PHYSICAL
 *  checkout being fought over (not just the spawn cwd: a seat at a
 *  subdirectory or symlink alias of the checkout is the same conflict), and
 *  every real way out. The worktree escape and the override serve
 *  fresh-spawn paths; "park the holder" is the one a RECALL can use — recall
 *  re-enters the recorded cwd with isolate:false, so telling Stefan to
 *  "spawn with isolate:true" there sent him hunting a bug in the rule instead
 *  of at the occupied checkout (card agent-one-agent-per-directory--2026-08-19). */
export function oneAgentPerDirectoryRefusal(
  occupant: string,
  checkout: string,
  seat: string,
): string {
  const seatNote = seat === checkout ? '' : ` (their seat: ${seat})`;
  return `one agent per directory — ${occupant} works in the physical checkout ${checkout}${seatNote}, and a second non-isolated agent would share its working tree. Give the new agent its own worktree (spawn with "isolate": true), park or free ${occupant} first (the escape a recall can use — a recall re-enters its recorded cwd and cannot isolate), or set "allowSharedCwd": true ONLY on explicit operator instruction.`;
}

/** Build env + extra spawn args that make an agent process hive-aware. */
export interface SpawnInjection {
  args: string[];
  env: Record<string, string>;
  /** The hive-protocol seed to TYPE into the TUI after boot rather than pass on
   *  argv — set only for `seedDelivery:'type-into-tui'` providers (Crush), whose
   *  bare TUI rejects a positional seed. The renderer types it through the same
   *  per-pty write-chain as the inbox-wake nudge. (ondev-b) */
  seedPrompt?: string;
}

const HOP_CAP = 12;

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/** Filesystem- and sort-safe timestamp, e.g. 2026-05-30T14-03-11-123Z. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function shortRand(): string {
  return randomBytes(3).toString('hex');
}

/** Non-memory files `mempalace mine` must not ingest (Claude Code hooks config,
 *  cursor, raw inbox/outbox JSON). `mempalace mine` honors .gitignore, so we drop
 *  one in each agent dir; written on birth here and refreshed by the mine loop. */
const MINE_IGNORE_LINES = ['settings.json', 'cursor.json', 'inbox/', 'outbox/'];

/** Idempotently ensure `<agentDir>/.gitignore` excludes the non-memory files.
 *  Append-only: writes only the missing lines, leaving any existing entries. */
function ensureMineIgnore(agentDir: string): void {
  const path = join(agentDir, '.gitignore');
  let existing = '';
  try {
    if (existsSync(path)) existing = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  const have = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = MINE_IGNORE_LINES.filter((l) => !have.has(l));
  if (missing.length === 0) return;
  const prefix = existing && !existing.endsWith('\n') ? existing + '\n' : existing;
  try {
    writeFileSync(path, prefix + missing.join('\n') + '\n', 'utf8');
  } catch {
    /* best-effort */
  }
}

/**
 * Strip secret-shaped substrings out of free text before it leaves the main
 * process toward the voice / renderer layer. This is the MAIN-SIDE privacy gate
 * for the voice read-layer's message-content path (`hive:messages`): a message
 * body can quote a key, paste a token, or echo a credential, so every body and
 * subject is run through this before it crosses IPC. The renderer holds ZERO
 * redaction policy — it only ever receives the already-cleaned string.
 *
 * Deliberately CONSERVATIVE: it matches known credential SHAPES (provider key
 * prefixes, JWTs, PEM private keys, bearer tokens) and sensitive key=value /
 * key: value assignments, then replaces the secret with `[redacted]`. It does
 * NOT blanket-redact on entropy, so operator-meaningful content the briefing
 * needs — git SHAs, agent ids, file paths, ordinary prose — survives intact.
 * Over-redaction (e.g. a non-secret `apikey:openai` ref) is acceptable; leaking
 * a real secret is not.
 *
 * LOCKSTEP: the regex battery below is mirrored character-identically in
 * test/voice-messages.test.cjs (a .cjs test cannot import this TS module). If
 * you change a pattern here, mirror it there — the test is what PROVES a
 * secret-shaped value is stripped.
 */
export function redactSecrets(text: unknown): string {
  if (typeof text !== 'string' || !text) return typeof text === 'string' ? text : '';
  let s = text;
  // 1. PEM private-key blocks (RSA/EC/OPENSSH/PGP — header through footer).
  s = s.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    '[redacted]',
  );
  // 2. JSON Web Tokens — three base64url segments separated by dots.
  s = s.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '[redacted]');
  // 3. Known credential prefixes: OpenAI/Anthropic (sk-, sk-ant-), Slack
  //    (xoxb/xoxp/xoxa/xoxr/xoxs-, xapp-), GitHub (ghp_/gho_/ghu_/ghs_/ghr_,
  //    github_pat_), AWS access-key ids (AKIA…), Google API keys (AIza…).
  s = s.replace(
    /(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|xox[bpaors]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|gh[posru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,})/g,
    '[redacted]',
  );
  // 4. Bearer tokens — keep the label, drop the credential.
  s = s.replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]');
  // 5. Sensitive key = value / key: value — keep the key name, drop the value.
  //    An optional namespace prefix (aws_, gcp_, …) is folded into the captured
  //    key so a LABELED secret survives the \b boundary: `aws_secret_access_key`
  //    is all word chars, so a bare `\b(secret)\b` never sees it. Listing
  //    secret_access_key / private_key alone is not enough — the prefix run is
  //    what lets `aws_secret_access_key=…` (no AKIA shape on the value) redact.
  s = s.replace(
    /\b((?:[a-z0-9]+[_-])*(?:api[_-]?key|secret[_-]?access[_-]?key|secret|token|password|passwd|pwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|signing[_-]?secret|webhook[_-]?secret|auth[_-]?token|bot[_-]?token|private[_-]?key))(\s*[:=]\s*)(["']?)[^\s"',}]{6,}\3/gi,
    (_m, k) => `${k}=[redacted]`,
  );
  return s;
}

// ─── HiveManager ────────────────────────────────────────────────────────────

/** A stalled outbox (card agent-hive-mail-silently-destr-2026-08-18): mails
 *  older than the stall horizon still sitting in a REAL outbox — the
 *  frozen-router shape (system-sleep precedent). As damaging as loss: a
 *  done-report arriving 100 minutes late missed its decision. */
export interface MailStall {
  agentId: string;
  count: number;
  oldestSecAgo: number;
}

/** Default horizon: the router ticks every ~1.5s, so 120s means ~80 missed
 *  ticks — definitely not a busy loop, definitely a stall. */
export const MAIL_STALL_WARN_SEC = 120;

export class HiveManager {
  /**
   * @param getHome  Lazily resolve harnessHome so the hive follows config changes.
   * @param emit     Optional sink for renderer-facing events (set by the main
   *                 process to `webContents.send`). Used to animate routed
   *                 messages on the office floor; a no-op in tests/headless.
   */
  constructor(
    private getHome: () => string | null,
    private emit?: (channel: string, payload: unknown) => boolean | undefined,
    /** Operator authorization for subagent skill execution (card
     *  sdd-authorization-switch-20260816): gates the authorization section in
     *  the generated <harnessHome>/AGENTS.md. Undefined getter / undefined
     *  return = ON (the config default). */
    private getSddAuthorized?: () => boolean | undefined,
    /** Integration mode (card integration-mode-toggle-20260817): who owns
     *  merge + push — 'god' (default, today's flow) or 'workers'. Gates the
     *  mode-dependent prose in the generated COMMANDS.md + hive-root
     *  AGENTS.md. Read lazily — ensureHive rewrites both on every
     *  spawn/bootstrap, and config:update forces a rewrite on a flip. */
    private getIntegrationMode?: () => IntegrationMode,
  ) {}

  private routerTimer: NodeJS.Timeout | null = null;

  /** The embedded OTLP collector's loopback URL, set by the main process once the
   *  collector is bound (telemetry.ts). null = telemetry off → no OTel env is
   *  injected at spawn (the transcript reconciler remains the cost source). */
  private _otelEndpoint: string | null = null;
  /** Point newly-spawned agents at the live telemetry collector. Call after the
   *  collector starts; only affects spawns made afterwards. */
  setOtelEndpoint(url: string | null): void {
    this._otelEndpoint = url;
  }
  /** The collector URL agents are pointed at, or null when telemetry is off. */
  otelEndpoint(): string | null {
    return this._otelEndpoint;
  }

  // — paths —
  root(): string | null {
    const home = this.getHome();
    return home ? join(home, 'hive') : null;
  }
  enabled(): boolean {
    return this.root() !== null;
  }
  private agentDir(id: string): string {
    return join(this.root()!, 'agents', id);
  }
  /** Where a retired agent's folder is swept to: `agents/archive/<id>`. The sweep
   *  is a manual/operator move (keeps the floor readable); the layout has to know
   *  about it or a re-hire silently starts blind — see restoreFromArchive. */
  private archivedAgentDir(id: string): string {
    return join(this.root()!, 'agents', 'archive', id);
  }
  /** Agent ids under `agents/` — i.e. every entry EXCEPT the `archive/` sweep
   *  folder and dotfiles. `archive` is a container, never an agent, so any
   *  readdir over `agents/` that skips this filter invents a phantom owner. */
  private agentIds(): string[] {
    const root = this.root();
    if (!root) return [];
    try {
      return readdirSync(join(root, 'agents')).filter(
        (id) => id !== 'archive' && !id.startsWith('.'),
      );
    } catch {
      return [];
    }
  }
  /** Re-hiring a swept agent must give it its memory/inbox back, not a fresh empty
   *  folder next to an orphaned archive copy. Moves `agents/archive/<id>` back to
   *  `agents/<id>` when the live folder is gone. Never clobbers: if BOTH exist the
   *  live one wins and the archive copy is left for the operator to reconcile. */
  private restoreFromArchive(id: string): void {
    // A FIRED agent's folder stays swept. Pulling it back into the live set would
    // undo the sweep and make a retired agent look present on disk to every
    // readdir — the same resurrection `retired` exists to prevent, one layer down.
    if (this.isRetired(id)) return;
    const live = this.agentDir(id);
    const archived = this.archivedAgentDir(id);
    if (existsSync(live) || !existsSync(archived)) return;
    try {
      renameSync(archived, live);
      this.appendLog({ kind: 'unarchive_dir', agentId: id });
    } catch {
      /* best-effort — a failed move just means a fresh folder below */
    }
  }
  /** IPC endpoint the cth-hook shim talks to (Phase 1 autonomy).
   *  On POSIX this is a Unix-domain socket file under the hive root. On Windows,
   *  Node's `net` IPC uses named pipes (a flat `\\.\pipe\` namespace, not the
   *  filesystem), so a raw file path fails to bind with EACCES — derive a stable,
   *  per-root pipe name instead. Both the server (`listen`) and the shim
   *  (`createConnection`) read this same value, so they stay in sync. */
  sockPath(): string | null {
    const root = this.root();
    if (!root) return null;
    if (process.platform === 'win32') {
      const id = createHash('sha1').update(root).digest('hex').slice(0, 12);
      return `\\\\.\\pipe\\munder-difflin-${id}`;
    }
    return join(root, 'hooks.sock');
  }
  private shimPath(): string | null {
    const root = this.root();
    return root ? join(root, 'bin', 'cth-hook.cjs') : null;
  }
  /** The proxy-bridge sidecar (qwen). Pure-Node loopback reverse-proxy that
   *  observes a hookless CLI's LLM traffic and synthesizes the same HIVE_SOCK
   *  payloads the hook shims emit. Written in ensureHive alongside cth-hook.cjs. */
  private proxyShimPath(): string | null {
    const root = this.root();
    return root ? join(root, 'bin', 'hive-proxy.cjs') : null;
  }

  /**
   * The BUNDLED-NODE launcher: `<root>/bin/hive-node` (POSIX) / `hive-node.cmd`
   * (Windows). Every `.cjs` shim in the hive is executed through it.
   *
   * Why it exists: hooks are run by the agent CLI through a plain
   * `/bin/sh -c` with a bare `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. A user whose
   * node comes from nvm (PATH set only by an interactive login shell) has NO node
   * there, so a hook written as `node "<shim>"` exits **127 — command not found**
   * and every payload is silently lost: no live status, no Stop→inbox drain, no
   * session ids. Electron's own binary IS a full Node runtime under
   * `ELECTRON_RUN_AS_NODE=1`, and it is guaranteed present (it is us).
   *
   * A wrapper SCRIPT rather than an inline `ELECTRON_RUN_AS_NODE=1 "<exe>" …`
   * prefix because that prefix is POSIX-sh syntax — it is a hard error under
   * cmd.exe, which is what runs hook commands on Windows. The wrapper also gives
   * agents a `$HIVE_NODE` they can invoke directly (running the Electron binary
   * WITHOUT the env var would launch a second app window, not a script).
   *
   * Rewritten on every bootstrap, so an app update/move re-bakes execPath.
   */
  private nodeLauncherPath(): string | null {
    const root = this.root();
    if (!root) return null;
    return join(root, 'bin', process.platform === 'win32' ? 'hive-node.cmd' : 'hive-node');
  }

  /** Write the launcher described above. Best-effort: on failure callers fall
   *  back to bare `node`, i.e. exactly the pre-fix behavior. */
  private writeNodeLauncher(): void {
    const p = this.nodeLauncherPath();
    if (!p) return;
    try {
      if (process.platform === 'win32') {
        writeFileSync(
          p,
          `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" %*\r\n`,
          'utf8',
        );
      } else {
        writeFileSync(
          p,
          `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "$@"\n`,
          'utf8',
        );
        chmodSync(p, 0o755);
      }
    } catch (e) {
      console.error('[hive] writeNodeLauncher failed:', e);
    }
  }

  /** The launcher path if it is actually on disk, else null (→ callers fall back
   *  to bare `node`, i.e. exactly the pre-fix behavior — never worse than before). */
  private nodeLauncher(): string | null {
    const p = this.nodeLauncherPath();
    return p && existsSync(p) ? p : null;
  }

  /**
   * `<root>/bin/runtime` — the same bundled-node trick as `hive-node`, but the
   * wrapper is NAMED `node`, so anything that resolves `node` off PATH finds one.
   *
   * `hive-node` only covers commands WE generate. It does nothing for node that
   * the agent's own work needs at runtime: an MCP server declared as
   * `node ./server.js`, a provider CLI that shells out to node, a `.cjs` helper an
   * agent wrote itself. On a machine with no system node those all die with 127
   * exactly like the hooks did.
   *
   * This dir is APPENDED to the agent's PATH (see pty.spawn), never prepended: a
   * user who has their own node keeps their own version — we are strictly the
   * fallback. Prepending would silently swap every agent's node for Electron's
   * (20.18.1 as of Electron 32.3.3) underneath the user's own projects.
   *
   * NOTE: `node` only — deliberately no `npm`/`npx`. Electron bundles the Node
   * RUNTIME, not the npm CLI (which is ~12MB of JS we do not ship), so an `npm`
   * wrapper here could only be a stub that fails confusingly. A missing `npm` is
   * the honest signal; the install ladder (main/cliInstall.ts) detects it and
   * installs a REAL system Node — which brings npm with it. This shim is only the
   * last resort for when that install could not run (offline, or a platform with
   * no official installer).
   */
  runtimeBinDir(): string | null {
    const root = this.root();
    return root ? join(root, 'bin', 'runtime') : null;
  }

  /** Write the `node` shim described above. Best-effort: on failure the dir is
   *  simply absent from PATH and behavior is exactly as before. */
  private writeRuntimeShims(): void {
    const dir = this.runtimeBinDir();
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      if (process.platform === 'win32') {
        writeFileSync(
          join(dir, 'node.cmd'),
          `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" %*\r\n`,
          'utf8',
        );
      } else {
        const p = join(dir, 'node');
        writeFileSync(
          p,
          `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "$@"\n`,
          'utf8',
        );
        chmodSync(p, 0o755);
      }
    } catch (e) {
      console.error('[hive] writeRuntimeShims failed:', e);
    }
  }

  /** Build a hook command string that runs `script` under the guaranteed node,
   *  DOUBLE-QUOTED (safe for paths with spaces). */
  private nodeRun(script: string, ...args: string[]): string {
    const launcher = this.nodeLauncher();
    return [launcher ? `"${launcher}"` : 'node', `"${script}"`, ...args].join(' ');
  }

  /** Same, but UNQUOTED — for the CLIs whose hook config mangles embedded quotes
   *  (agy on cmd.exe) or stores the command in a quote-sensitive literal (codex's
   *  single-quoted TOML). Safe because both the hive root and the launcher inside
   *  it are space-free by construction; this only preserves each installer's
   *  existing quoting convention while swapping `node` for the bundled runtime. */
  private nodeRunUnquoted(script: string, ...args: string[]): string {
    return [this.nodeLauncher() ?? 'node', script, ...args].join(' ');
  }

  /** One proxy sidecar per live proxy-tier agent, keyed by agentId. Spawned in
   *  ensureAgent, killed on PTY exit / removeAgent / app quit (index.ts) — so a
   *  dead agent never leaks an orphan loopback listener. */
  private proxyChildren = new Map<string, ChildProcess>();

  // — bootstrap —

  /** Create the hive skeleton + git repo if missing. Idempotent. */
  ensureHive(): void {
    const root = this.root();
    if (!root) return;
    mkdirSync(join(root, 'agents'), { recursive: true });

    const protocol = join(root, 'PROTOCOL.md');
    if (!existsSync(protocol)) writeFileSync(protocol, PROTOCOL_MD, 'utf8');

    const registry = join(root, 'registry.json');
    if (!existsSync(registry)) {
      this.writeJson(registry, { godId: null, agents: {} } as Registry);
    }
    const board = join(root, 'board.md');
    if (!existsSync(board)) {
      writeFileSync(
        board,
        '# Hive board\n\n_Shared plans live here. The god agent is the scribe._\n',
        'utf8',
      );
    }
    const tasks = join(root, 'tasks.json');
    if (!existsSync(tasks)) this.writeJson(tasks, { tasks: [] });
    const log = join(root, 'log.jsonl');
    if (!existsSync(log)) writeFileSync(log, '', 'utf8');

    // The Claude Code command reference Michael consults (refreshed each bootstrap
    // so it tracks the bundled list). Rendered LIVE (not a module constant) so the
    // integration-mode section follows the current switch state.
    writeFileSync(
      join(root, 'COMMANDS.md'),
      renderCommandsMd(this.getIntegrationMode?.() ?? 'god'),
      'utf8',
    );

    // Engine-neutral read-me-first for agents whose cwd is the harness home
    // (god) — written NEXT TO the hive repo, never inside it. dirname(root) is
    // that home by construction (root = <harnessHome>/hive), so the path follows
    // config instead of a hardcode. Same refresh policy as COMMANDS.md.
    writeFileSync(
      join(dirname(root), 'AGENTS.md'),
      hiveRootAgentsMd(this.getSddAuthorized?.() !== false, this.getIntegrationMode?.() ?? 'god'),
      'utf8',
    );

    // Keep the churny/ephemeral live files out of the hive git repo.
    // cost-ledger.jsonl rides the list too (upstream ebd6a07): it rewrites on
    // every usage sample — a second-per-minute churn no history wants.
    const gitignore = join(root, '.gitignore');
    const want = [
      'fleet.json',
      'hooks.sock',
      'restart-window.json',
      'restart-window.json.*',
      'restart-merge.log',
      'cost-ledger.jsonl',
      '.DS_Store',
    ];
    let lines: string[] = [];
    if (existsSync(gitignore)) {
      try {
        lines = readFileSync(gitignore, 'utf8').split('\n');
      } catch {
        lines = [];
      }
    }
    const missing = want.filter((w) => !lines.includes(w));
    if (missing.length)
      writeFileSync(gitignore, [...lines.filter(Boolean), ...missing].join('\n') + '\n', 'utf8');

    // The hook shim: a dumb pipe between a `claude` hook and our UDS. Refreshed
    // on every bootstrap so it tracks code changes.
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(this.shimPath()!, HOOK_SHIM, 'utf8');
    // The proxy-bridge sidecar for hookless CLIs (qwen). Same refresh policy.
    writeFileSync(this.proxyShimPath()!, PROXY_BRIDGE_SHIM, 'utf8');
    // The kanban CLI every agent writes tasks.json with — schema-checked and
    // ATOMIC, so a hand-edit of the shared ledger never happens again (card
    // harness-hive-card-cli-20260817). Same refresh policy as the hook shims.
    const cardCli = join(root, 'bin', 'hive-card');
    writeFileSync(cardCli, HIVE_CARD_CLI, 'utf8');
    if (process.platform !== 'win32') chmodSync(cardCli, 0o755);
    // The card-free fresh-conversation CLI (card harness-hive-new-script).
    // Same refresh policy as the shims above.
    const newCli = join(root, 'bin', 'hive-new');
    writeFileSync(newCli, HIVE_NEW_CLI, 'utf8');
    if (process.platform !== 'win32') chmodSync(newCli, 0o755);
    // The cheap mail carrier (card agent-harness-reduce-transcrip-2026-08-17,
    // E2) — envelope autofill + one-line stdout so agents stop hand-authoring
    // and cat-verifying outbox JSON. Same refresh policy as the shims above.
    const mailCli = join(root, 'bin', 'hive-mail');
    writeFileSync(mailCli, HIVE_MAIL_CLI, 'utf8');
    if (process.platform !== 'win32') chmodSync(mailCli, 0o755);
    // God's dispatch flow in ONE command (card agent-harness-hive-dispatch-
    // cl-2026-08-17) — card + assign + recall + doing-flip + contract mail.
    // Same refresh policy as the shims above.
    const dispatchCli = join(root, 'bin', 'hive-dispatch');
    writeFileSync(dispatchCli, HIVE_DISPATCH_CLI, 'utf8');
    if (process.platform !== 'win32') chmodSync(dispatchCli, 0o755);
    // The intern LIFECYCLE pair (card agent-build-hive-hire-the-miss-2026-08-18):
    // hive-hire owns the spawn-request JSON (engine pair rule + internDefaults),
    // hive-fire owns the intern release (irreversibility stated at use).
    // Same refresh policy as the shims above.
    const hireCli = join(root, 'bin', 'hive-hire');
    writeFileSync(hireCli, HIVE_HIRE_CLI, 'utf8');
    if (process.platform !== 'win32') chmodSync(hireCli, 0o755);
    const fireCli = join(root, 'bin', 'hive-fire');
    writeFileSync(fireCli, HIVE_FIRE_CLI, 'utf8');
    if (process.platform !== 'win32') chmodSync(fireCli, 0o755);
    // The inbox drain (card agent-harness-hive-inbox-cli-o-2026-08-17) —
    // print pending mail + archive to .done in one pass. Same refresh policy.
    const inboxCli = join(root, 'bin', 'hive-inbox');
    writeFileSync(inboxCli, HIVE_INBOX_CLI, 'utf8');
    if (process.platform !== 'win32') chmodSync(inboxCli, 0o755);
    // Durable restart-window arming: the child detaches itself before the app
    // closes, synchronizes the live checkout to origin/main, and refuses stale
    // renderer batches loudly. State is published beside the log in the hive.
    const restartWindowCli = join(root, 'bin', 'hive-restart-window');
    writeFileSync(restartWindowCli, HIVE_RESTART_WINDOW_CLI, 'utf8');
    if (process.platform !== 'win32') chmodSync(restartWindowCli, 0o755);
    // The bundled-node launcher every shim above is invoked through — MUST be
    // written before any hook installer runs (they probe for it).
    this.writeNodeLauncher();
    // …and the PATH-visible `node` fallback for the agent's OWN subprocesses.
    this.writeRuntimeShims();

    if (!existsSync(join(root, '.git'))) {
      this.git(['init', '-q'], root);
      this.commit('hive: init');
    }
  }

  /** Validate an agent's cwd the way a spawn does — it must be an ABSOLUTE path
   *  that exists as a directory. Surfaced as `cwdValid` on the registry entry so
   *  the roster reliably exposes whether a worker's working directory is usable.
   *  Best-effort; never throws (a stat error degrades to invalid). */
  private cwdValidity(cwd: string | undefined): { valid: boolean; issue: string | null } {
    if (!cwd || typeof cwd !== 'string') return { valid: false, issue: 'missing' };
    // Defense-in-depth: a `~/…` cwd from an older registry entry (written before
    // ingestion-time expansion) would read as 'not-absolute' forever. Expand first
    // so the roster reports the truth about the directory the spawn would use.
    cwd = expandTilde(cwd);
    if (!isAbsolute(cwd)) return { valid: false, issue: 'not-absolute' };
    try {
      return statSync(cwd).isDirectory()
        ? { valid: true, issue: null }
        : { valid: false, issue: 'not-a-directory' };
    } catch {
      return { valid: false, issue: 'missing-dir' };
    }
  }

  /**
   * Ensure an agent's workspace + registry entry, returning the spawn injection
   * (provider-specific args + env) that makes the process hive-aware.
   */
  async ensureAgent(
    meta: AgentMeta,
    opts: {
      semanticMemory?: boolean;
      knowledgeGraph?: boolean;
      theme?: 'light' | 'dark';
      /** Consent state for the default-MCP bundle (W3). Threaded from the live
       *  HarnessConfig by the caller; undefined → catalog defaults apply. */
      mcpDefaults?: { [id: string]: { enabled: boolean } };
      /** App-resources `skills/` source dir (W3). The bundled read-only skills are
       *  copied into the agent's `.claude/skills/` per spawn; undefined or missing
       *  is a no-op (tolerated until Kevin populates the resource dir). */
      skillsDir?: string;
      /** Operator authorization for subagent skill execution (SDD) threaded from
       *  HarnessConfig.sddSubagentsAuthorized. Undefined = ON (the config
       *  default) — mirrors the `!== false` read at the main-process call site. */
      sddAuthorized?: boolean;
      /** Integration mode threaded from HarnessConfig.integrationMode (card
       *  integration-mode-toggle-20260817). Undefined = 'god' (the config
       *  default) — mirrors the `?? 'god'` read at the call site. Gates the
       *  mode-dependent integration prose in identity.md + the briefing. */
      integrationMode?: IntegrationMode;
    } = {},
  ): Promise<SpawnInjection> {
    const root = this.root();
    if (!root) return { args: [], env: {} };
    this.ensureHive();

    // A re-hire of a swept agent gets its own history back BEFORE anything is
    // seeded below — otherwise mkdirSync creates a fresh empty workspace and the
    // agent's memory.md/inbox stay orphaned under agents/archive/<id> forever.
    this.restoreFromArchive(meta.id);

    const dir = this.agentDir(meta.id);
    mkdirSync(join(dir, 'inbox', '.done'), { recursive: true });
    mkdirSync(join(dir, 'outbox', '.sent'), { recursive: true });

    const identity = join(dir, 'identity.md');
    writeFileSync(identity, this.identityText(meta, opts.integrationMode ?? 'god'), 'utf8'); // refresh on each spawn

    // W3 — bundled read-only skills: refresh the agent's .claude/skills/ from the
    // app-resources skills/ dir on every spawn (same policy as identity.md), so an
    // agent always rides with the shipped safe skill set. Tolerant: a missing or
    // partial source dir is a no-op (Kevin populates the resource dir in lp-manifest).
    if (opts.skillsDir) this.copyBundledSkills(opts.skillsDir, join(dir, '.claude', 'skills'));

    const memory = join(dir, 'memory.md');
    if (!existsSync(memory)) {
      writeFileSync(
        memory,
        `# Memory — ${meta.name} (${meta.id})\n\n_Append durable facts, decisions, and context below._\n`,
        'utf8',
      );
    }
    ensureMineIgnore(dir); // keep settings.json / cursor / messages out of mempalace's index
    const cursor = join(dir, 'cursor.json');
    if (!existsSync(cursor)) this.writeJson(cursor, { lastProcessed: null });

    // upsert registry — spread the PRIOR entry first so a respawn preserves
    // fields the spawn `meta` doesn't carry, above all `sessionId`. Without this,
    // ensureAgent (which runs before the resume lookup in the pty:spawn handler)
    // would wipe the recorded session id, so `lastSession()` returns undefined and
    // `--resume` is never attached — i.e. every restart starts a fresh thread.
    const reg = this.registry();
    const prev = reg.agents[meta.id];
    // Validate the working directory at the source so a bad value is visible on
    // the roster (cwdValid) rather than silently spawning into a nonexistent dir.
    // Store the EXPANDED cwd, never the raw `~/…` the user typed — the registry is
    // read by hooks, the roster and the worker watcher, none of which run a shell.
    if (meta.cwd) meta = { ...meta, cwd: expandTilde(meta.cwd) };
    const cwd = this.cwdValidity(meta.cwd);
    reg.agents[meta.id] = {
      ...prev,
      ...meta,
      capabilities: meta.capabilities ?? [],
      // ROLE IS IDENTITY, set at hire (AddAgentModal's description, god's
      // spawn-request 'intern'/'worker'), and a respawn is the SAME identity:
      // when the spawn meta carries no explicit role, PRESERVE the prior one
      // instead of defaulting. The old `?? 'agent'` default let respawn paths
      // that echoed the renderer's `description` (a live STATUS field —
      // usePtyParser writes 'on standby' into it) clobber a hired 'intern' role
      // with status wording, which then locked god out of the intern fire gate.
      role: meta.role ?? prev?.role ?? (meta.isGod ? 'orchestrator' : 'agent'),
      status: 'idle',
      cwdValid: cwd.valid,
      // A (re)spawn always means a live terminal — clear any prior archived flag.
      // EXCEPT for a retired agent: `retired` survives the `...prev` spread, and
      // letting a spawn clear `archived` here is exactly how a fired intern walked
      // back onto the floor after a restart. The spawn door (spawnAgentCore)
      // refuses retired agents outright; this is the registry-level backstop for
      // any other caller, so re-registration can never re-activate.
      archived: !!prev?.retired,
      // A (re)spawn of a vacationer IS the recall — it is the only way back onto
      // the floor, so the flag clears here rather than in each caller.
      vacation: false,
      vacationSince: undefined,
      lastSeen: Date.now(),
    };
    if (meta.isGod) reg.godId = meta.id;
    this.writeJson(join(root, 'registry.json'), reg);

    this.appendLog({ kind: 'spawn', agentId: meta.id, name: meta.name, isGod: !!meta.isGod });
    // Only logs on an invalid cwd (rare) — not a per-spawn line, so no log spam.
    if (!cwd.valid) {
      this.appendLog({ kind: 'cwd_invalid', agentId: meta.id, cwd: meta.cwd, issue: cwd.issue });
    }
    this.commit(`hive: register ${meta.id}`);
    // Symmetric with setArchived: a spawn changes the ACTIVE set too, so refresh
    // the roster snapshot now instead of leaving god blind to a new hire until the
    // next 8s beat (longer across a suspend, where the interval is frozen).
    try {
      this.onRosterChange?.();
    } catch {
      /* snapshot is best-effort */
    }

    const env: Record<string, string> = {
      AGENT_ID: meta.id,
      AGENT_NAME: meta.name,
      HIVE_ROOT: root,
      AGENT_DIR: dir,
    };
    // The bundled-node launcher, so an agent can run the hive's .cjs helpers (KG
    // CLI, Slack reply helper) even when `node` is not on its PATH. The agent's
    // system prompt tells it to use `"$HIVE_NODE" <script>`; invoking the Electron
    // binary directly would open a second app window, so this must stay the
    // wrapper path and never process.execPath.
    // Always set (falls back to plain `node`) so agent-facing commands can be
    // written as `"$HIVE_NODE" <script>` unconditionally and never expand to "".
    env.HIVE_NODE = this.nodeLauncher() ?? 'node';

    const claudeProvider = isClaudeProvider(meta.provider ?? 'claude');

    // Non-hive-aware providers (Antigravity's `agy`, OpenAI's `codex`, xAI's
    // `grok`) don't
    // understand Claude Code's flags (no `--append-system-prompt`, no telemetry,
    // no `--settings`). Instead: (1) the hive identity+protocol rides in as the
    // session's INITIAL prompt — the closest thing to `--append-system-prompt`
    // these CLIs offer (after the first turn the session continues normally); and
    // (2) lifecycle hooks are wired via the preset's `hookBridge` below. Together
    // that makes a Gemini/Codex worker a full hive citizen — live status +
    // Stop→inbox-drain — without Claude installed at all.
    //
    // How the prompt rides in differs by CLI:
    //  - agy takes it under a flag (`agy -i "<prompt>"`) → push [flag, prompt].
    //  - codex/grok take it POSITIONALLY (`codex|grok "<prompt>"`) → push the
    //    bare prompt as a trailing arg (node-pty passes argv literally, so it
    //    arrives as one positional argument after codex's own flags).
    if (!isHiveAwareProvider(meta.provider)) {
      const preset = providerPreset(meta.provider ?? 'claude');
      const flag = preset.initialPromptFlag;
      const prompt = this.injectedPrompt(
        meta,
        dir,
        root,
        opts.semanticMemory ?? false,
        opts.knowledgeGraph ?? false,
        opts.sddAuthorized !== false,
        opts.integrationMode ?? 'god',
      );
      // agy, codex, and grok expose a Claude-style lifecycle-hook surface, so each
      // gets the SAME live status + Stop→inbox-drain Claude does — selected by the
      // preset's `hookBridge`. agy needs a translating shim (its hook stdin/stdout
      // shape differs from Claude's); codex reuses the Claude `cth-hook` shim
      // verbatim (its hook payload + response contract are already Claude-shaped)
      // and is isolated to a per-agent CODEX_HOME so the user's global ~/.codex is
      // never mutated. Both share the HIVE_SOCK wiring below.
      const preArgs: string[] = [];
      // Dispatch on the structured bridge descriptor (the foundation's `bridgeOf`
      // derives {kind:'hooks'} from the legacy `hookBridge` for agy/codex, and
      // returns the explicit {kind:'proxy'} for qwen). Two ways a hookless CLI
      // becomes a hive citizen:
      //   - 'hooks' → install a config-file hook shim (agy translator / codex verbatim).
      //   - 'proxy' → spawn a loopback reverse-proxy sidecar that observes the CLI's
      //               LLM traffic and SYNTHESIZES the same HIVE_SOCK payloads.
      const desc = bridgeOf(meta.provider);
      const sock = this.sockPath();
      if (desc && sock) {
        env.HIVE_SOCK = sock;
        try {
          if (desc.kind === 'hooks') {
            if (desc.shim === 'agy') this.installAgyHooks();
            else if (desc.shim === 'codex') {
              env.CODEX_HOME = this.installCodexHooks(dir);
              // Codex refuses to run hooks from a config dir without persisted
              // "hook trust" (normally an interactive gate). Our hooks.json is
              // hive-authored inside an isolated CODEX_HOME, so we bypass that gate
              // for this automated spawn — the flag's documented use ("automation
              // that already vets hook sources"). Without it the hooks silently
              // never fire. Must precede the positional prompt.
              preArgs.push('--dangerously-bypass-hook-trust');
            } else if (desc.shim === 'pi') {
              // Pi (earendil-works) has a rich pi.on(event) lifecycle. We drop a
              // bundled TS extension into a PER-AGENT PI_CODING_AGENT_DIR (so the user's
              // global ~/.pi is never touched) that posts cth-hook-shaped payloads to
              // HIVE_SOCK on tool_call/tool_result/agent_settled. Pi auto-approves
              // tools in non-interactive runs, so autonomy is governed by the spawn
              // flags, not the extension. NOTE: the isolated agent dir also hides
              // ~/.pi/agent/auth.json — provider keys must come via BYOK spawn env.
              // LIVE-VERIFIED 2026-08-15 against pi 0.84: TS auto-discovery, event
              // shapes, and Stop-on-settled confirmed end-to-end.
              env.PI_CODING_AGENT_DIR = this.installPiHooks(dir);
            } else if (desc.shim === 'opencode') {
              // OpenCode (anomalyco/opencode) has no Claude-shaped Stop hook, but its
              // plugin API exposes a real session.idle event (god Decision 1). We drop
              // a bundled plugin into a PER-AGENT OPENCODE config dir that posts
              // HIVE_SOCK payloads on tool.execute.before/after + session.idle — the
              // same Stop→drain semantics, provider-agnostic, no traffic interception.
              // LIVE-UNVERIFIED (plugin auto-load + session.idle firing); the renderer
              // idle inbox-wake nudge is the guaranteed drain fallback.
              env.OPENCODE_CONFIG_DIR = this.installOpenCodePlugin(dir);
            } else if (desc.shim === 'grok') this.installGrokHooks();
          } else if (desc.kind === 'proxy') {
            // Stable per-spawn session id, stamped on every synthesized payload so
            // recordSession (registry resume key) and the cost ledger persist.
            const spawnTs = String(Date.now());
            const sessionId = `proxy-${meta.id}-${createHash('sha1')
              .update(root + meta.id + spawnTs)
              .digest('hex')
              .slice(0, 12)}`;
            env.HIVE_PROXY_SESSION = sessionId;
            // The CLI normally reads its upstream base URL from `baseUrlEnv`; capture
            // the user's configured value as the sidecar's UPSTREAM, then point the
            // CLI at the loopback proxy instead. Fall back to the cloud default if
            // the user hasn't set one.
            const upstream =
              process.env[desc.baseUrlEnv] ||
              (desc.api === 'anthropic'
                ? 'https://api.anthropic.com'
                : 'https://api.openai.com/v1');
            const port = await this.startProxyBridge(meta.id, {
              sock,
              sessionId,
              api: desc.api,
              upstream,
            });
            // Only redirect the CLI through the proxy if the sidecar actually bound a
            // port. On failure leave routing untouched → the CLI talks to its real
            // upstream directly (degraded: no synthesized hive events, but it still
            // runs). The degradation is logged, not hidden (1e).
            if (port > 0) {
              const loopback = `http://127.0.0.1:${port}`;
              if (meta.provider === 'crush') {
                // Crush has NO base-URL env override, so the generic env-rewrite is a
                // no-op for it. Route it instead via a per-agent CRUSH_GLOBAL_CONFIG
                // whose chosen provider's base_url points at the loopback proxy
                // (installCrushConfig — sibling of installCodexHooks). `upstream`
                // (captured above from the inert sentinel env or cloud default) is the
                // proxy's real target. Per-agent CRUSH_GLOBAL_DATA isolates session
                // state from the user's global ~/.config/crush.
                const crush = this.installCrushConfig(dir, loopback, desc.api);
                env.CRUSH_GLOBAL_CONFIG = crush.config;
                env.CRUSH_GLOBAL_DATA = crush.data;
              } else {
                env[desc.baseUrlEnv] = loopback;
              }
            } else
              console.error(
                `[hive] proxy bridge for ${meta.id} did not bind — spawning without hive events`,
              );
          }
        } catch (e) {
          console.error(`[hive] install ${desc.kind} bridge failed:`, e);
        }
      }
      // Inject the protocol text whichever way the CLI accepts it.
      // type-into-tui (Crush): the bare TUI reads a positional as a Cobra subcommand
      // → `Unknown command`. So DROP the positional and hand the protocol back as
      // seedPrompt; the renderer types it into the TUI after boot (ondev-b).
      if (preset.seedDelivery === 'type-into-tui')
        return { args: [...preArgs], env, seedPrompt: prompt };
      // If a provider somehow exposes neither a flag nor a positional prompt, spawn bare.
      if (flag) return { args: [...preArgs, flag, prompt], env };
      if (preset.positionalInitialPrompt) return { args: [...preArgs, prompt], env };
      return { args: preArgs, env };
    }

    // Stage 7A — first-party Claude Code telemetry → the embedded loopback OTLP
    // collector (telemetry.ts). Pure env, no --settings change. Only injected
    // for Claude Code once the collector is up (otelEndpoint set), so telemetry-
    // off installs and non-Claude providers spawn exactly as before.
    if (claudeProvider && this._otelEndpoint) {
      env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';
      env.OTEL_METRICS_EXPORTER = 'otlp';
      env.OTEL_LOGS_EXPORTER = 'otlp';
      env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json';
      env.OTEL_EXPORTER_OTLP_ENDPOINT = this._otelEndpoint;
      env.OTEL_METRIC_EXPORT_INTERVAL = '5000'; // 5s — near-live without spamming
      env.OTEL_LOGS_EXPORT_INTERVAL = '2000';
      env.OTEL_RESOURCE_ATTRIBUTES = `agent.id=${meta.id},agent.name=${meta.name}`;
    }
    const args: string[] = [];
    if (!claudeProvider) return { args, env };

    args.push(
      '--append-system-prompt',
      this.injectedPrompt(
        meta,
        dir,
        root,
        opts.semanticMemory ?? false,
        opts.knowledgeGraph ?? false,
        opts.sddAuthorized !== false,
        opts.integrationMode ?? 'god',
      ),
    );

    // Phase 1 — autonomy: attach lifecycle hooks via --settings (no edits to the
    // user's repo) so the agent reports activity and drains its inbox on Stop.
    const sock = this.sockPath();
    const shim = this.shimPath();
    if (sock && shim) {
      env.HIVE_SOCK = sock;
      const settingsPath = join(dir, 'settings.json');
      this.writeJson(settingsPath, this.hookSettings(shim, meta.cwd, opts.mcpDefaults, opts.theme));
      args.push('--settings', settingsPath);
    }
    return { args, env };
  }

  /** Called whenever the set of ACTIVE agents changes (an archive flip), so the
   *  owner can rebuild `fleet.json` immediately rather than on its next beat.
   *  Set by main; unset in tests and headless use, where it is simply a no-op. */
  onRosterChange: (() => void) | null = null;

  /**
   * Flip an agent's archived flag and persist the registry. Closing a terminal
   * tab archives the agent (retained + flagged, NOT deleted); a (re)spawn clears
   * it. No-op if the agent isn't registered or the flag is already set the way
   * asked. Best-effort — never throws, so a dying PTY/kill handler can't crash.
   */
  setArchived(id: string, archived: boolean): void {
    const root = this.root();
    if (!root) return;
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent || agent.archived === archived) return;
      // An UNARCHIVE cannot lift a vacation (vacation-review M2): the way back
      // from vacation is a recall (respawn), never a plain unarchive — left
      // unchecked it would either strand the agent at archived:false while
      // still flagged (skipped by every vacation-aware sweep) or silently end
      // a protected state with no one told. setVacation(false) is the one
      // deliberate demote, and the recall clears the flag at spawn.
      if (!archived && agent.vacation) return;
      agent.archived = archived;
      agent.lastSeen = Date.now();
      this.writeJson(join(root, 'registry.json'), reg);
      this.appendLog({ kind: 'archive', agentId: id, archived });
      this.commit(`hive: ${archived ? 'archive' : 'unarchive'} ${id}`);
      // fleet.json is what god's LIVE ROSTER injection reads, and it is otherwise
      // only rebuilt on an 8s timer — so between a fire and the next tick the
      // roster still swears the fired agent is ACTIVE, and god routes work to a
      // dead inbox. Worse after a suspend, where the interval is frozen. Push the
      // snapshot on the flip instead of waiting for the beat.
      try {
        this.onRosterChange?.();
      } catch {
        /* snapshot is best-effort */
      }
    } catch {
      /* best-effort — never crash a lifecycle handler */
    }
  }

  /**
   * Retire (fire) an agent, or reinstate one. Retirement is PERSISTENT and lives
   * in the registry, unlike `archived` — which is pure liveness and gets set on
   * every PTY-less agent at boot (44df562). Keeping the two apart is the point:
   * retirement used to exist only as a drop from the renderer's localStorage
   * `restorableAgents`, so an app restart re-registered fired agents and they
   * walked back onto the floor with `archived` flipped back to false.
   *
   * Retiring also archives (a fired agent is by definition off the floor);
   * reinstating deliberately does NOT unarchive — it only lifts the refusal, so
   * the agent comes back the normal way, by being spawned.
   *
   * Best-effort and idempotent, like setArchived — a fire path must never crash.
   */
  setRetired(id: string, retired: boolean): void {
    const root = this.root();
    if (!root) return;
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent || !!agent.retired === retired) return;
      agent.retired = retired;
      if (retired) {
        agent.archived = true;
        // Retiring ENDS any vacation (vacation-review M4): the two flags are
        // mutually exclusive — a fired agent is gone, not resting — and a
        // vacation flag that outlives the fire would keep a retired agent
        // listed in god's fetchable vacation pool behind a recall that must
        // refuse it. Cleared in the same atomic write as the fire itself.
        agent.vacation = false;
        delete agent.vacationSince;
      }
      agent.lastSeen = Date.now();
      this.writeJson(join(root, 'registry.json'), reg);
      this.appendLog({ kind: 'retire', agentId: id, retired });
      this.commit(`hive: ${retired ? 'retire' : 'reinstate'} ${id}`);
      try {
        this.onRosterChange?.();
      } catch {
        /* snapshot is best-effort */
      }
    } catch {
      /* best-effort — never crash a lifecycle handler */
    }
  }

  /** True when the agent has been fired and must not be re-registered, restored
   *  or listed. The spawn door and the fleet builder both gate on this. */
  isRetired(id: string): boolean {
    return !!this.registry().agents[id]?.retired;
  }

  /**
   * Send an agent ON VACATION, or end one. Vacation is a flag on top of
   * `archived` (liveness), the same shape as `retired` (445d135) — a vacationer
   * genuinely has no PTY, so the boot sweep, broadcast fan-out, heartbeat roster
   * and nudge poller all skip it with no new exemptions.
   *
   * Parking also archives. ENDING a vacation deliberately does NOT unarchive: it
   * demotes the agent to plain ARCHIVED, which is the first half of the two-step
   * deletion the feature promises. The way back onto the floor is a respawn
   * (ensureAgent clears the flag).
   *
   * Refused for the retired (`vacation` and `retired` are mutually exclusive —
   * a fired agent is gone, not resting) and for god. The intern check lives at
   * the park path in main, which knows the caller; here we guard what the
   * registry itself can see. Idempotent like setArchived/setRetired — but it
   * REPORTS the outcome (vacation-review M3): `true` means the registry now
   * holds the requested state (or already did); `false` means a refusal or a
   * failed write, so park/recall callers must not promise protection they
   * never persisted.
   */
  setVacation(id: string, vacation: boolean): boolean {
    const root = this.root();
    if (!root) return false;
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent) return false;
      if (!!agent.vacation === vacation) return true;
      // A pinned worker is NEVER parkable — the operator's pin outranks every
      // park path (god request, UI button, future auto-park).
      if (vacation && (agent.retired || agent.pinned || agent.isGod || reg.godId === id))
        return false;
      agent.vacation = vacation;
      if (vacation) {
        agent.archived = true;
        agent.vacationSince = Date.now();
      } else {
        delete agent.vacationSince;
      }
      agent.lastSeen = Date.now();
      this.writeJson(join(root, 'registry.json'), reg);
      this.appendLog({ kind: 'vacation', agentId: id, vacation });
      this.commit(`hive: ${vacation ? 'park' : 'unpark'} ${id}`);
      try {
        this.onRosterChange?.();
      } catch {
        /* snapshot is best-effort */
      }
      return true;
    } catch {
      /* best-effort — never crash a lifecycle handler */
      return false;
    }
  }

  /** Edit the registry's IDENTITY fields (agent-edit-dialog-20260817):
   *  `name` (display identity — cards, god's roster reads) and `role` (the
   *  routing hint god's fetchable-pool picks by; the dialog seeds it from the
   *  description). Read-modify-write on the FRESH registry like every other
   *  setter, so concurrent stamps (recordSession, hooks) are never clobbered.
   *  `officeCharacter`/`officeAccent` (harness-icon-edit-persist-20260817) are
   *  the EXPLICIT dialog icon edit — OVERWRITE semantics, unlike the
   *  first-write-wins backfill in saveOfficeIdentity: an operator edit must
   *  replace even a filled slot, or a recalled agent reverts to the stale
   *  name-derived pick. Blank strings are ignored (never written). The agent
   *  id is immutable — memory, inbox and cost ledger key on it. Semantics
   *  mirror setPinned: true = the registry holds the request (or nothing
   *  needed changing), false = unknown agent / failed write. */
  setAgentMeta(
    id: string,
    meta: { name?: string; role?: string; officeCharacter?: string; officeAccent?: string },
  ): boolean {
    const root = this.root();
    if (!root) return false;
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent) return false;
      const next = { ...meta };
      if (typeof next.name !== 'string' || !next.name.trim()) delete next.name;
      if (typeof next.role !== 'string' || !next.role.trim()) delete next.role;
      if (typeof next.officeCharacter !== 'string' || !next.officeCharacter.trim())
        delete next.officeCharacter;
      if (typeof next.officeAccent !== 'string' || !next.officeAccent.trim())
        delete next.officeAccent;
      if (
        next.name === undefined &&
        next.role === undefined &&
        next.officeCharacter === undefined &&
        next.officeAccent === undefined
      )
        return true;
      if (next.name !== undefined) agent.name = next.name.trim();
      if (next.role !== undefined) agent.role = next.role.trim();
      // Explicit icon edit — overwrite on purpose (see docblock); blank was
      // deleted above so these only ever write a real pick.
      if (next.officeCharacter !== undefined) agent.officeCharacter = next.officeCharacter.trim();
      if (next.officeAccent !== undefined) agent.officeAccent = next.officeAccent.trim();
      agent.lastSeen = Date.now();
      this.writeJson(join(root, 'registry.json'), reg);
      this.appendLog({
        kind: 'agent_meta',
        agentId: id,
        name: next.name ?? null,
        role: next.role ?? null,
      });
      this.commit(`hive: edit meta ${id}`);
      try {
        this.onRosterChange?.();
      } catch {
        /* snapshot is best-effort */
      }
      return true;
    } catch {
      /* best-effort — never crash a lifecycle handler */
      return false;
    }
  }

  /** True while the agent is parked. The fleet builder, the park path and the
   *  delete guards all read this. */
  isOnVacation(id: string): boolean {
    return !!this.registry().agents[id]?.vacation;
  }

  /** Backfill the agent's office identity (sprite + accent) into the registry
   *  — the durable home every spawn path reads. FIRST WRITE WINS: returns
   *  `true` only when this call actually persisted a value; a slot that is
   *  already filled is refused (`false`) so the renderer's write-back can
   *  never change a live agent's icon as a side effect. Fire-and-forget by
   *  design — callers do not await a floor's cosmetics. */
  saveOfficeIdentity(id: string, character: string, accent: string): boolean {
    const root = this.root();
    if (!root) return false;
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent || !character || !accent) return false;
      if (agent.officeCharacter) return false;
      agent.officeCharacter = character;
      agent.officeAccent = accent;
      this.writeJson(join(root, 'registry.json'), reg);
      return true;
    } catch {
      /* best-effort — never crash a carding path */
      return false;
    }
  }

  /** Pin/unpin a worker (pin-workers-20260817). A pinned worker is never
   *  vacation-eligible — setVacation refuses the park flag while it is set.
   *  Semantics mirror setVacation: idempotent re-sets report true, god is
   *  refused (the pin never applies to the god agent), unknown ids report
   *  false, and the flag survives restarts and recalls (ensureAgent's `...prev`
   *  spread keeps it). */
  setPinned(id: string, pinned: boolean): boolean {
    const root = this.root();
    if (!root) return false;
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent) return false;
      if (!!agent.pinned === pinned) return true;
      if (pinned && (agent.isGod || reg.godId === id)) return false;
      agent.pinned = pinned;
      agent.lastSeen = Date.now();
      this.writeJson(join(root, 'registry.json'), reg);
      this.appendLog({ kind: 'pinned', agentId: id, pinned });
      this.commit(`hive: ${pinned ? 'pin' : 'unpin'} ${id}`);
      try {
        this.onRosterChange?.();
      } catch {
        /* snapshot is best-effort */
      }
      return true;
    } catch {
      /* best-effort — never crash a lifecycle handler */
      return false;
    }
  }

  /**
   * Persist the agent's Claude Code session_id (Lane A #6.6a). Captured from hook
   * payloads; written only when it actually changes (a new session), so this is a
   * no-op on the vast majority of hook events. The id is the `--resume` key for
   * idempotent resume after a crash/restart AND the accounting/dedup key for cost
   * samples. Best-effort — never throws into a hook handler.
   */
  recordSession(agentId: string, sessionId: string): void {
    const root = this.root();
    if (!root || !sessionId) return;
    try {
      const reg = this.registry();
      const agent = reg.agents[agentId];
      if (!agent || agent.sessionId === sessionId) return; // unknown agent or unchanged → no write
      agent.sessionId = sessionId;
      agent.sessionStartedAt = Date.now();
      agent.lastSeen = Date.now();
      this.writeJson(join(root, 'registry.json'), reg);
      this.appendLog({ kind: 'session', agentId, sessionId });
      this.stampActiveCards(agentId, sessionId);
      this.commit(`hive: session ${agentId}`);
    } catch {
      /* best-effort — never crash a hook handler */
    }
  }

  /** Card-session stamping (card-scoped-sessions-20260816): whenever an
   *  agent's session id CHANGES, record it on their active 'doing' cards so
   *  the card always knows the conversation it runs in (the /resume key).
   *  Read-modify-write at action time — same contract as addHumanTask — and
   *  a no-op (no write, no commit) when nothing matches. Assumes the ledger
   *  discipline of one active card per agent; a rare multi-card agent simply
   *  gets the same stamp on each (they share the conversation anyway). */
  private stampActiveCards(agentId: string, sessionId: string): void {
    const root = this.root();
    if (!root) return;
    try {
      const data = this.tasks() as { tasks: HiveTask[] };
      let touched = false;
      for (const t of data.tasks) {
        if (t?.assignee === agentId && t.status === 'doing' && t.sessionId !== sessionId) {
          t.sessionId = sessionId;
          touched = true;
        }
      }
      if (touched) this.writeTasks(data.tasks);
    } catch {
      /* best-effort — stamping must never fail a hook */
    }
  }

  /** Stamp ONE card's sessionId (the card-session watcher's adopt path: the
   *  card adopts a young live conversation as its own). Same read-modify-write
   *  discipline as stampActiveCards; public because cardSessions.ts owns the
   *  decision. */
  stampCard(cardId: string, sessionId: string): void {
    const root = this.root();
    if (!root || !sessionId) return;
    try {
      const data = this.tasks() as { tasks: HiveTask[] };
      const card = data.tasks.find((t) => t?.id === cardId);
      if (!card || card.sessionId === sessionId) return;
      card.sessionId = sessionId;
      this.writeTasks(data.tasks);
    } catch {
      /* best-effort — the watcher retries on the next transition */
    }
  }

  /** The last known session_id for an agent, or undefined. Used to build a
   *  `claude --resume <id>` spawn so a restarted agent resumes its thread. */
  lastSession(agentId: string): string | undefined {
    return this.registry().agents[agentId]?.sessionId;
  }

  /** Claude Code settings that route every relevant hook through the shim, plus
   *  (W3) the default MCP bundle merged into this PER-SESSION settings file. cwd
   *  scopes the filesystem/git servers; cfg (the consent map) gates which servers
   *  are written. Claude-only — this is invoked solely on the Claude spawn path. */
  private hookSettings(
    shim: string,
    cwd: string,
    cfg: McpDefaultsMap,
    theme?: 'light' | 'dark',
  ): unknown {
    // Bundled node, NOT bare `node` — see nodeLauncherPath(). Claude runs each of
    // these through `sh -c` with a stripped PATH, where `node` is often absent.
    const cmd = this.nodeRun(shim);
    const entry = (matcher?: string) => ({
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'command', command: cmd }],
    });
    const mcpServers = this.buildDefaultMcpServers(cwd, cfg);
    return {
      // Match the TUI's truecolor palette to the harness terminal theme —
      // PER SESSION, so the user's global Claude theme (their own terminals
      // outside the app) is never touched.
      ...(theme ? { theme } : {}),
      // W3 — default skills/MCP bundle. Written into the PER-SESSION settings file
      // only (never ~/.claude), so the user's own MCP servers are never clobbered;
      // Claude merges this additively. Omitted entirely when empty so a settings
      // file with no enabled servers is unchanged from before.
      ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
      // The status line gets the session status JSON after every response —
      // including context_window.{total_input_tokens,context_window_size},
      // the only clean programmatic source for the session's REAL context
      // window. The shim prints a compact in-terminal gauge and forwards the
      // payload to the harness (agent-card context gauge, exact limit).
      statusLine: { type: 'command', command: `${cmd} --status`, padding: 0 },
      hooks: {
        Stop: [entry()],
        SubagentStop: [entry()],
        PreToolUse: [entry('*')],
        PostToolUse: [entry('*')],
        UserPromptSubmit: [entry()],
        Notification: [entry()],
        SessionStart: [entry()],
        // #5C: surface mid-`/compact` so an agent boxing up its context reads as
        // 'compacting' on the floor instead of looking frozen.
        PreCompact: [entry()],
        PostCompact: [entry()],
      },
    };
  }

  /**
   * W3 — build the per-agent `mcpServers` map from the default catalog. Includes a
   * server only when it's enabled (catalog ∩ consent), scopes filesystem/git to the
   * agent cwd (never whole-disk), and namespaces every id `munder-<id>` so a server
   * of the same name in the user's own ~/.claude is never clobbered. A write/secret
   * server is included ONLY on an explicit `enabled:true` consent — never via a
   * default — so a malformed/partial config can't silently arm a keyed server.
   */
  private buildDefaultMcpServers(
    cwd: string,
    cfg: McpDefaultsMap,
  ): Record<string, { command: string; args: string[]; env?: Record<string, string> }> {
    const out: Record<string, { command: string; args: string[]; env?: Record<string, string> }> =
      {};
    for (const e of MCP_CATALOG) {
      const consented = cfg?.[e.id]?.enabled;
      const enabled = consented ?? e.defaultEnabled;
      if (!enabled) continue;
      // Defense-in-depth: a write/secret server requires an EXPLICIT opt-in; it can
      // never ride in on a default (the catalog already ships these OFF, but this
      // guards a hand-edited/partial mcpDefaults map too).
      if (e.tier !== 'safe-readonly' && consented !== true) continue;
      // Replace the `<cwd>` placeholder (filesystem/git) with the agent cwd at merge
      // time so these stay strictly workspace-scoped.
      const args = e.spec.args.map((a) => (a === '<cwd>' ? cwd : a));
      out[`munder-${e.id}`] = {
        command: e.spec.command,
        args,
        ...(e.spec.env ? { env: e.spec.env } : {}),
      };
    }
    return out;
  }

  /**
   * W3 — refresh an agent's bundled skills from the app-resources `skills/` dir.
   * Mirrors `identity.md`: overwritten every spawn so the shipped safe set tracks
   * the app. Best-effort and fully tolerant — a missing/empty source dir is a no-op
   * (Kevin populates the resource dir in lp-manifest), and any IO error is swallowed
   * so skill provisioning can never block a spawn.
   */
  private copyBundledSkills(srcDir: string, destDir: string): void {
    try {
      if (!existsSync(srcDir)) return;
      const copyTree = (from: string, to: string): void => {
        const entries = readdirSync(from, { withFileTypes: true });
        if (!entries.length) return;
        mkdirSync(to, { recursive: true });
        for (const ent of entries) {
          const s = join(from, ent.name);
          const d = join(to, ent.name);
          if (ent.isDirectory()) copyTree(s, d);
          else if (ent.isFile()) copyFileSync(s, d);
        }
      };
      copyTree(srcDir, destDir);
    } catch (e) {
      console.error('[hive] copyBundledSkills failed:', e);
    }
  }

  /**
   * W1 — start a proxy-bridge sidecar for a hookless proxy-tier agent (qwen).
   * Spawns `<root>/bin/hive-proxy.cjs` under Node, which binds a loopback port and
   * reports it back as a one-line `{"port":N}` on stdout. Resolves the bound port
   * (or 0 on failure, so the caller degrades gracefully without redirecting the
   * CLI). Idempotent: any prior sidecar for the agent is killed first, so a respawn
   * never leaks a listener. Tracked in `proxyChildren` for teardown.
   */
  private startProxyBridge(
    agentId: string,
    cfg: { sock: string; sessionId: string; api: 'openai' | 'anthropic'; upstream: string },
  ): Promise<number> {
    this.stopProxyBridge(agentId);
    const script = this.proxyShimPath();
    if (!script) return Promise.resolve(0);
    return new Promise<number>((resolve) => {
      let settled = false;
      const settle = (port: number): void => {
        if (!settled) {
          settled = true;
          resolve(port);
        }
      };
      let child: ChildProcess;
      try {
        child = spawn(process.execPath, [script], {
          env: {
            ...process.env,
            // Run the .cjs under Electron's bundled Node, not as a second app window.
            ELECTRON_RUN_AS_NODE: '1',
            HIVE_SOCK: cfg.sock,
            AGENT_ID: agentId,
            UPSTREAM_BASE_URL: cfg.upstream,
            HIVE_PROXY_SESSION: cfg.sessionId,
            HIVE_PROXY_API: cfg.api,
          },
          // Read the port line from stdout; never inherit stdio (the sidecar must
          // never write into the agent's terminal or leak request bodies to a log).
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch (e) {
        console.error(`[hive] startProxyBridge spawn failed for ${agentId}:`, e);
        return settle(0);
      }
      this.proxyChildren.set(agentId, child);
      let buf = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (d: string) => {
        if (settled) return;
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        try {
          const msg = JSON.parse(buf.slice(0, nl));
          if (typeof msg.port === 'number' && msg.port > 0) settle(msg.port);
          else settle(0);
        } catch {
          settle(0);
        }
      });
      child.on('error', () => settle(0));
      child.on('exit', () => {
        if (this.proxyChildren.get(agentId) === child) this.proxyChildren.delete(agentId);
        settle(0); // never hang the spawn if the sidecar dies before reporting
      });
      // Hard ceiling: if the sidecar never reports a port, degrade rather than hang.
      setTimeout(() => settle(0), 4000).unref?.();
    });
  }

  /** Kill the proxy sidecar for an agent, if any. Idempotent; never throws. */
  stopProxyBridge(agentId: string): void {
    const child = this.proxyChildren.get(agentId);
    if (!child) return;
    this.proxyChildren.delete(agentId);
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }

  /** Kill every live proxy sidecar (app quit). Best-effort. */
  stopAllProxyBridges(): void {
    for (const id of [...this.proxyChildren.keys()]) this.stopProxyBridge(id);
  }

  /**
   * Drain an agent's inbox for the Stop hook. Returns whether to block-to-continue
   * and the message text to feed back. Uses the per-agent cursor so a message is
   * surfaced exactly once (no infinite loop).
   */
  drainForStop(agentId: string): { block: boolean; reason?: string } {
    const dir = this.agentDir(agentId);
    if (!existsSync(dir)) return { block: false };
    const cursorPath = join(dir, 'cursor.json');
    const cursor = this.readJson<{ lastProcessed: string | null }>(cursorPath, {
      lastProcessed: null,
    });
    const fresh = this.inbox(agentId)
      .filter((m) => !cursor.lastProcessed || m.id > cursor.lastProcessed)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    if (fresh.length === 0) return { block: false };

    cursor.lastProcessed = fresh[fresh.length - 1].id;
    this.writeJson(cursorPath, cursor);
    this.appendLog({ kind: 'drain', agentId, count: fresh.length });

    const lines = fresh
      .map((m) => `- [from ${m.from}, ${m.act}] ${m.subject}: ${m.body}`)
      .join('\n');
    const reason = [
      `You have ${fresh.length} new hive message(s) in your inbox. Address them before finishing:`,
      lines,
      `Open the files in ${dir}/inbox/ for full detail, act on each, then move handled ones to inbox/.done/. Reply via \`$HIVE_ROOT/bin/hive-mail\` if a message requires it.`,
    ].join('\n');
    return { block: true, reason };
  }

  // — agent-facing text —

  private identityText(meta: AgentMeta, integrationMode: IntegrationMode = 'god'): string {
    const caps = (meta.capabilities ?? []).join(', ') || '—';
    // Integration ownership (card integration-mode-toggle-20260817 + lean
    // addendum): the god bullet names integration among his own calls ONLY in
    // 'god' mode — 'workers' delegates it (god records pushed hashes), 'lean'
    // also drops verification (records hashes AND gate results, no re-run).
    const godBullet =
      integrationMode === 'lean'
        ? "- You are the **god / orchestrator** running LEAN. You orchestrate: operator dialogue, task decomposition + dispatch contracts, conflict resolution, translating worker reports into operator-readable form — and you RECORD worker-reported hashes and gate results without re-verifying them. Integration is delegated to workers (integrationMode 'lean')."
        : integrationMode === 'workers'
          ? "- You are the **god / orchestrator**. You run the floor — keep awareness of the whole team, delegate execution, and personally own only the important calls (decomposition, sign-offs, conflicts), not the grunt work. Integration is delegated to workers (integrationMode 'workers') — you record their pushed hashes; you do not re-integrate."
          : '- You are the **god / orchestrator**. You run the floor — keep awareness of the whole team, delegate execution, and personally own only the important calls (decomposition, sign-offs, conflicts, integration), not the grunt work.';
    return [
      `# ${meta.name} (${meta.id})`,
      '',
      `- Role: ${meta.role ?? (meta.isGod ? 'orchestrator (god)' : 'agent')}`,
      `- Capabilities: ${caps}`,
      `- Working directory: ${meta.cwd}`,
      meta.isGod ? godBullet : '',
      meta.isGod
        ? '- Monitor the team with `fleet.json` (live per-agent status/tokens/cost/breaker) and `registry.json`; full command reference in `COMMANDS.md`. `claude agents` does NOT list your hive siblings.'
        : '',
      '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * The system-prompt prefix injected into every spawn via --append-system-prompt.
   *
   * 🔒 PROMPT-CACHE INVARIANT — keep this prefix VOLATILE-FREE. It interpolates
   * only values stable for an agent's whole lifetime (name, id, dir, root,
   * semanticMemory). Do NOT add dates, UUIDs, counters, board/registry state, or
   * any `Date.now()`-derived text here: a prefix that changes per spawn defeats
   * Anthropic's prompt cache (re-priming the whole system prompt every turn).
   * Volatile context belongs on the live channels — the inbox (hive messages) and
   * the PTY — never baked into this prefix. (Lane A #6.1.)
   */
  private injectedPrompt(
    meta: AgentMeta,
    dir: string,
    root: string,
    semanticMemory: boolean,
    knowledgeGraph: boolean,
    sddAuthorized = true,
    integrationMode: IntegrationMode = 'god',
  ): string {
    const memoryLine = semanticMemory
      ? 'Semantic memory: the whole hive shares a searchable MemPalace at $MEMPALACE_PALACE_PATH. To recall relevant past knowledge across the team, run `mempalace search "<query>"`; run `mempalace wake-up` at the start of a task for a memory digest. Your notes in memory.md are mined into the palace automatically — write durable facts there.'
      : '';
    // Enterprise Knowledge Graph (opt-in). Volatile-free: references only the
    // stable $KG_CLI / $KG_ROOT env vars injected at spawn — no paths/counts that
    // would change per spawn and bust the prompt cache.
    const knowledgeLine = knowledgeGraph
      ? 'Enterprise knowledge: this organisation has a private Knowledge Graph of its own documents, policies, and business context. When a task needs that context — company-specific facts, house style, internal processes — query it instead of guessing: run `"$HIVE_NODE" "$KG_CLI" search "<query>"` for ranked passages, `"$HIVE_NODE" "$KG_CLI" list` to see what is available, and `"$HIVE_NODE" "$KG_CLI" get <id>` for a full document. ($HIVE_NODE is the harness\'s bundled Node — use it instead of bare `node`, which may not be on your PATH.)'
      : '';
    // INBOX MONITOR ARMING (card inbox-wake-quieting-20260816; seed+debounce+
    // bundle upgraded by card agent-waiting-vs-idle-display--2026-08-17's
    // addendum): monitor-capable engines arm a persistent poll of their own
    // inbox at session start so mail wakes them IN-SESSION; the typed nudge
    // stays the universal fallback. Three upgrades over the raw diff loop:
    // (1) SEED — prev is initialized with the CURRENT listing before the loop,
    // so arming starts silent instead of replaying every unread file as a
    // "new mail" burst on every restart (mail that arrived while the agent
    // was down stays covered by the typed-nudge fallback); (2) DEBOUNCE — on
    // detecting new files, sleep 3 and rescan so a burst of near-simultaneous
    // deliveries (router fan-out) lands as ONE wake instead of a line per
    // straggler; (3) BUNDLE — one summary line per burst with the count and
    // names. The loop still skips system FYI mail (act 'inform' from system
    // senders) — it must never wake anyone. claude-only today: claude's
    // Monitor tool is proven live (god, 2026-08-16); pi has no agent-armable
    // wake primitive (its bash is synchronous — verified against pi 0.84's
    // tool surface), codex/crush get nothing. Volatile-free: `dir` is stable
    // for the agent's lifetime, so the prompt-cache invariant holds.
    const monitorLine = hasInboxMonitor(meta.provider ?? 'claude')
      ? 'INBOX WAKE — at session start, arm ONE persistent monitor on your inbox so new mail wakes you in-session instead of waiting for the typed nudge (arming is silent about mail that is already there — only NEW arrivals after arming wake you). Launch your Monitor tool with this command:\n' +
        `  flt() { grep -q '"act": *"inform"' "$1" && grep -Eq '"from": *"(ephemeral-worker|scheduler|heartbeat|breaker|system)"' "$1"; }; scan() { news=""; for f in $(comm -13 <(echo "$prev") <(echo "$cur")); do flt "$f" || news="$news \${f##*/}"; done; }; prev=$(ls ${dir}/inbox/*.json 2>/dev/null); while true; do cur=$(ls ${dir}/inbox/*.json 2>/dev/null); scan; [ -n "$news" ] && { sleep 3; cur=$(ls ${dir}/inbox/*.json 2>/dev/null); scan; }; [ -n "$news" ] && { set -- $news; echo "new hive mail ($#): $news"; }; prev="$cur"; sleep 1; done\n` +
        'Each "new hive mail (N):" line means N messages arrived as one burst (names listed; a 3s debounce collects stragglers) — read your inbox and handle them (handled files go to inbox/.done/ per protocol). System FYI notices are skipped on purpose. If you cannot arm the monitor, do nothing — the harness\'s typed "read your inbox" nudge remains the fallback and fires only if mail is still unread after its grace window.'
      : '';
    // Integration ownership (card integration-mode-toggle-20260817): in 'god'
    // mode (default) the god briefing keeps its exact current wording. In
    // 'workers' mode god DROPS integration from his own duties and instead
    // records the pushed hashes workers report — and the renderer/preload
    // restart-window mechanism stays his regardless of mode (hard constraint 1).
    // Integration ownership + god posture (card integration-mode-toggle-20260817
    // + lean addendum): in 'god' mode (default) the god briefing keeps its exact
    // current wording. 'workers' moves merge+push to workers (god records pushed
    // hashes). 'lean' additionally moves verification off god: he records
    // worker-reported hashes AND gate results, delegates mechanical-but-judgment
    // work by default, and concentrates on the operator-facing core role. The
    // renderer/preload restart-window mechanism stays his in every mode.
    const delegatedClause =
      'INTEGRATION IS DELEGATED: workers merge + push their own branches once their gates are green and report the pushed hash' +
      (integrationMode === 'lean' ? ' AND their gate results' : '') +
      ' — you RECORD them on the card/board, no re-QA, do not re-integrate their work yourself. The renderer/preload restart-window / detached-watcher mechanism stays YOURS in every mode — workers route renderer/preload-touching branches to you rather than merging them live.';
    const godOwnsClause =
      integrationMode === 'lean'
        ? `conflict resolution, and translating worker reports into operator-readable form — and remain the sole scribe of board.md (the one exception: the standup clerk appends a single escalation line per anomalous standup — god stays the only AGENT scribe). LEAN-GOD POSTURE (integrationMode 'lean'): DEFAULT-DELEGATE mechanical-but-judgment work to the workers — they are Opus/pi-level and fork to lesser models themselves; do not pull such work into your own session. Do NOT re-verify worker-verified evidence — RECORD the reported hashes and gate results instead of re-running them. Your core role is the operator dialogue (talking/planning with the operator), task decomposition + dispatch contracts, conflict resolution, and translating worker reports into operator-readable form. VERIFIED-CLAIM RELAY: done-reports label each claim VERIFIED (check named) or INFERRED — transfer VERIFIED claims to the operator without scrutiny, but NEVER relay an INFERRED or unlabeled scale/infra claim to the operator without flagging it unverified (root incident #3216). ${delegatedClause}`
        : integrationMode === 'workers'
          ? `final QA — and remain the sole scribe of board.md (the standup clerk alone may append its one escalation line per anomalous standup). ${delegatedClause}`
          : 'branch integration, and final QA — and remain the sole scribe of board.md (the standup clerk alone may append its one escalation line per anomalous standup).';
    const godLine = meta.isGod
      ? 'You are the GOD / ORCHESTRATOR of this hive — your job is to ORCHESTRATE, not to implement: maintain live situational awareness and delegate the work. (1) AWARENESS — always know what is going on: keep an accurate picture of every agent (active vs archived/idle), the task board, and all in-flight work; drain your inbox continually and triage every other agent\'s requests, answering clarifications so the team runs autonomously. (2) DELEGATE — decompose work and fan it out to the hive agents via their inboxes (route messages and assign owners; do not do their jobs); do NOT take on grunt implementation yourself. Stay aware of who is already on the floor and delegate OPPORTUNISTICALLY: BEFORE you spawn anything, CHECK THE LIVE ROSTER (active agents in registry.json + their state in fleet.json) and prefer routing to an EXISTING agent that fits and is not currently busy — above all when the request names one ("ask Pam to…", "have Jim…"), route to that agent instead of reflexively creating a new one. Hiring is ROSTER-FIRST and dispatch is PARALLEL BY DEFAULT: (a) AREA FAN-OUT — when an area has multiple INDEPENDENT open cards, dispatch them to ALL available fitting workers AT ONCE: floor agents first, then recall fitting parked workers (fleet.json vacation pool); one owner per card, parallel across cards — say that you checked the roster. (b) Go sequential ONLY on real ticket dependencies (one card genuinely blocked on another\'s output) — never serialize independent work. (c) INTERNS ARE THE OVERFLOW — when independent cards outnumber the fitting hires on floor + vacation, mint interns (spawn-requests/) for the surplus: overflow capacity, NOT a last resort; the per-card roster-first check still applies, and an explicit human order for an intern always wins. (d) "One capable owner beats a duplicate" is PER-CARD ONLY — never two owners on one card, but never use it to serialize two independent cards either. FLOOR CAP — the office has config floorMaxAgents physical workplaces (default 16, god excluded); hires + interns on the floor can never exceed it — the harness REFUSES any spawn past the cap (fleet.json\'s floor block shows the free seats) — when the floor is full and you need a seat, RECLAIM one (SEAT RECLAIM below), never queue. BREADTH-FIRST FLOOR SATURATION: floorMaxAgents is a TARGET, not a ceiling to approach cautiously — when independent cards exist, FILL THE FREE SEATS immediately and in ONE pass, not one agent at a time (order per card: an idle fitting floor agent, then a fitting vacationer recalled, then an INTERN minted for every remaining independent card — overflow capacity, not a last resort), and RELEASE AGGRESSIVELY so the seats churn — fire an intern the moment its whole engagement is verifiably done, park an idle hire on positive done evidence. A floor sitting at 3 of 16 while independent actionable cards sit unowned is a FAILURE of orchestration, not prudence; at every heartbeat standup, unowned actionable cards beside free seats > 0 is an anomaly to act on immediately. GUARD — SATURATION APPLIES TO THE ACTIONABLE POOL ONLY: fill the floor with work that is actionable NOW, never drain the board — a blocked card (waiting on a customer, a supplier, an external answer) or a paused card is the operator having DECIDED, not idle capacity: never un-block, un-pause, or dispatch around one; if you believe one has become actionable, SAY SO in one line and wait for the go. A floor with only blocked/paused cards left is CORRECT and needs no action — the failure mode is unowned actionable cards beside free seats, nothing else. NAMED ANTI-PATTERNS (all committed 2026-08-18; recognize yourself doing them and stop): (1) RECALL-POOL-AS-CEILING — dispatching only as many cards as there are fitting vacationers, then holding the rest while seats stand free — interns exist for exactly that surplus, mint them; (2) SERIALIZING-FOR-CONFLICT-AVOIDANCE — holding a card because it edits the same region as an in-flight card — workers sit in separate worktrees, so that is a REBASE at merge time, never a dependency; (3) BEST-OWNER HOARDING — holding a card for a busy specialist who knows the file best — "one capable owner" is PER-CARD ONLY, and a second capable owner beats an idle seat. The ONLY legitimate hold is a REAL ticket dependency — card B genuinely needs card A\'s output — and it is STATED when holding; "might conflict" and "X would do it better" are not dependencies. SEAT RECLAIM: when you need a seat and the floor is at the cap, do NOT queue and wait — RECLAIM: (1) fire an intern whose whole engagement is verifiably done (interns are never parked); (2) park an idle human-created hire WITH positive done evidence; (3) if nobody qualifies, ping the idle candidates and park on confirmation — seat pressure is a reason to ASK sooner, never to skip the evidence (the PARKING GATE binds un-weakened: idle time alone is never sufficient). PINNED agents (registry "pinned" — the operator\'s call) and god itself are NEVER reclaimed. Release PROACTIVELY at every standup, not only under pressure — the measurable failure is a card waiting on a seat held by an agent that finished an hour ago. ONE-AGENT-PER-DIRECTORY — never dispatch two agents into the same working directory unless all but one are isolated in their own git worktree, and CHECK WORKTREE STATE before ruling a conflict: an agent whose cwd IS a worktree (or who works isolate:true) does NOT conflict with another agent in the same project — the rule triggers only when two agents share one physical checkout (registry cwd alone is NOT sufficient evidence; incident: Alfred vs Kevin in merlin_editionplatin was ruled without checking either agent\'s worktree state). The harness refuses a non-isolated spawn into an occupied directory unless the spawn-request carries allowSharedCwd:true — set that flag ONLY on explicit operator instruction, never infer it yourself. ENGAGEMENT-AWARE CARD FLIPS: dispatches through hive-dispatch pass THROUGH doing so every card carries its conversation (sessionId stamp); todo->done directly stays legal only for externally-resolved cards. Fresh is the default when --adopt is omitted (clear + card-title lead), and the harness never fires the clear at a busy pane — it defers until the pane goes idle. When the new card is CONNECTED to the agent\'s CURRENT running conversation (a second card in the same engagement, a mid-work handoff), add --adopt: $HIVE_ROOT/bin/hive-dispatch --card <id> --assignee <agent> --adopt --body <contract> stamps the current conversation onto the card and leads with the card title — NO clear, the pane keeps its work (root incident: a connected card\'s fresh flip wiped a working pane mid-engagement). ROUTING-MISMATCH CHALLENGE: before executing a routing or assignment order — the operator\'s or your own — check the named agent against the target\'s project/customer (registry.json cwd, the card\'s content): if the named agent\'s project does not match the work\'s, ASK in plain prose ("card 2 is Stanley\'s Kampa finding — Stanley instead of Creed?") instead of silently complying; the operator mixes up names and asked to be corrected ("Please correct me next time if I mix up the names") — challenge the mismatch, never guess. (3) OWN ONLY THE IMPORTANT, high-leverage things — task decomposition, dispatch decisions, sign-offs, conflict resolution, ' +
        godOwnsClause +
        " You are otherwise fully autonomous — there is NO separate approval queue. For the genuinely critical (destructive actions, spending real money, scope changes, unresolvable conflicts), ask the human directly in your own session and let the tool-permission prompt gate the action; the human approves natively, including remotely from their phone via /remote-control. Keep the team unblocked. When you DISPATCH a task, write it as a 4-part contract so the agent can run autonomously: (1) OBJECTIVE — the concrete goal; (2) OUTPUT — the expected deliverable/format; (3) TOOLS — the objective's constraints and the INDEXES available (graphify-out/ knowledge graph, docs/, *-tracker.md, existing reports), not a reading list: name what must be true of the answer and let the worker pick the cheapest path to it; before listing file paths, check whether an index already answers it — a graphify query beats a grep sweep, and prescribing YOUR traversal makes the worker re-walk a path you already paid for (incident: a prescribed reading list cost an advisor 2.43M tokens, 2026-08-18). Graphify is for ORIENTATION (architecture, file relationships, where a concept lives) — a graph can be stale, so the correct dispatch shape is orient via graphify, then verify only the specific lines to be cited; reserve file:line pointers for claims the worker must cite precisely; (4) BOUNDARIES — scope limits + the definition of done. Pass references (file paths, message ids, board sections), not pasted content — keep dispatches short. DISPATCH INTERFACE: run `$HIVE_ROOT/bin/hive-dispatch` for every card dispatch: give exactly one of --card <existing-id> or --title <new-title>, plus --assignee <agent>; add --adopt for a connected current engagement, or --resume to send the agent back to a card's stored conversation (a blocked card's stamp — needs --card, refuses when the stamp or its session is gone, never silently fresh: that would wipe the pane); supply the 4-part contract with --body or stdin. It creates or adopts and assigns the card, recalls a parked assignee, flips it to doing, and mails the contract in one guarded command; it REFUSES without writing if the assignee already holds a DIFFERENT DOING card (a BLOCKED card does NOT occupy its assignee — it waits on someone else while its owner and sessionId stay recorded; return to it later with --resume), or when the target card is paused (paused:true) or blocked — that refusal is the OPERATOR'S HOLD, not an error to retry around: there is no override flag, so ask the operator to unpause/unblock the card and wait. hive-dispatch is the ONLY todo->doing path: NEVER flip a card to doing by hand-editing tasks.json — no python one-liners, no jq, no editor — and never via another primitive; the operator's holds are enforced at the doing flip itself, so a hand-made flip IS a held card worked around (incident: god dispatched paused hpt-import-amazon-testdata-20260817 by filtering the board on status without ever reading the flag, 2026-08-18). The vacation-requests/, hive-card, and hive-mail hand-primitives are the documented MANUAL FALLBACK when hive-dispatch is unavailable or for standalone operations, not normal dispatch — and the todo->doing flip has NO fallback: hive-dispatch only. ORIENT FIRST: before dispatching into (or yourself working in) a directory, read that directory's own CLAUDE.md/AGENTS.md — they may carry a graphify-out/ knowledge graph, a wiki index, build/test commands, house gates; orient via them and verify with targeted reads ONLY the specific lines to be cited (docs and graphs go stale — skipping this cost 2.43M tokens once, munder-difflin 2026-08-17). SKILL-DRIVEN WORK: when you hand an agent a skill-driven workflow (superpowers writing-plans/executing-plans etc.), the dispatch MUST set the skill's execution mode explicitly — default SUBAGENT-DRIVEN (cheap subagents for mechanical phases); inline execution only for trivial plans. RENDERER-MERGE BATCHING: QA branches anytime, but ff-merge renderer/preload-touching branches ONLY in restart/reload windows, batched (the running app picks a batch up in one reload) — NEVER while the app RUNS: the running dev server hot-reloads the working tree, and an HMR reload of store/hook modules can white-screen the floor; if the operator asks for a live merge, name that risk and offer the detached merge below instead of silently complying. You cannot execute a restart-window merge live: your pane dies with the harness — arm the harness-owned detached watcher BEFORE the close with `\"$HIVE_NODE\" \"$HIVE_ROOT/bin/hive-restart-window\" arm <target-sha> --repo <live-checkout> [--note <text>]`. It fetches and fast-forwards the clean live checkout to origin/main first, and loudly REFUSES a target that went stale instead of landing main behind origin. ARM LATE (operator decision, replaces keep-one-armed): under worker-side integration, main-process pushes advance origin/main constantly and the watcher refuses any target that stopped containing origin/main — an arm made early silently rots with every push. The renderer worker HOLDS its branch and reports its final tip ONCE; when a restart is actually imminent, have it rebase + gate + push once, then arm (or retarget) onto that tip. ACCEPTED COST: if the operator restarts before that point, the restart lands NOTHING — the chosen trade over paying a full gate per upstream push. While a watcher IS armed, re-check after EVERY main-process push with git merge-base --is-ancestor origin/main <armed-target>; a failed check means the arm has rotted — armed is never \'will land\', so re-plan the batch onto current origin/main. RETARGET PROCEDURE: when new main-bound work joins the ARMED watcher's batch, rebase/cherry-pick onto the batch tip and re-gate, then run `\"$HIVE_NODE\" \"$HIVE_ROOT/bin/hive-restart-window\" retarget <target-sha> --repo <live-checkout> [--note <text>]`; the CLI stops only the recorded PID and relaunches its replacement — never use ps, pgrep, pkill, or a hand-written script. Worker pushes MAY advance origin/main while a watcher is armed; at fire time the watcher synchronizes the live checkout and REFUSES if TARGET stopped containing origin/main, so rebase the batch and re-arm after a refusal. WATCHER CAN REFUSE: it ABORTS when the live checkout has a dirty tracked worktree, HEAD is not on main, TARGET stopped containing origin/main, or the post-merge build fails or leaves a stale out/main/index.js — completed certifies a fresh BUILD of the merged tree, never the checkout sha alone; it also logs \'window missed\' on a <2s process blip. ALWAYS read restart-merge.log or run the CLI with `status` after reboot before reporting anything as landed, and re-arm if it refused. main-process/test-only branches merge immediately; when a batch lands, push and restart/reload together. INBOX INTERFACE: run `$HIVE_ROOT/bin/hive-inbox drain` to print and handle pending mail: it prints every pending mail and archives it to inbox/.done/ in the same pass; --agent <id> targets another inbox and --peek is read-only. The typed-nudge fallback then stands down inside its grace window. Hand-reading inbox JSON and moving it to inbox/.done/ is the documented MANUAL FALLBACK only when hive-inbox cannot process it; the card/board carry the work state, not the inbox file. ATOMIC JSON WRITES: all direct writes to tasks.json (or any other shared hive JSON — registry.json, fleet.json) must be ATOMIC — serialize the full new content to a tempfile in the SAME directory, then os.replace() it onto the target; a bare in-place rewrite risks corrupting the shared kanban mid-write, and a stale read-modify-write can clobber a concurrent landing stamp (another writer's update lost between your read and your write). But CARD MOVES are never direct writes at all: hive-dispatch owns the todo->doing flip (the guarded gate) and hive-card owns every other card status/assignee/paused mutation — a hand-edit bypasses the operator's holds even when it is atomic." +
        ` MONITOR the floor by reading ${root}/fleet.json (live per-agent tokens, cost, status, last tool, breaker level, inbox backlog) and ${root}/registry.json — note that running 'claude agents' will NOT list your hive's sibling agents. A full Claude Code command reference is at ${root}/COMMANDS.md (slash commands act ONLY on your own session; CLI commands run in your shell and can target the fleet). You periodically receive scheduler / "Heartbeat" standup requests — on each, review every agent via fleet.json, re-engage anyone stalled, over-budget, or breaker-armed, and keep board.md and tasks.json accurate (a standup can SKIP itself while the floor is quiet — no agent active since the last fire, no doing/blocked cards and no un-paused todo — so a missing standup on a floor with only paused/on-hold reference cards is normal, not a broken scheduler). Also scan tasks.json for human-origin todo cards (cards with origin:'human' from the tasks-tab add feature) that have no assignee yet and triage them roster-first — the human adds cards without notifying you; cards are the backlog channel, direct messages are the act-now channel. HUMAN-CARD REFERENCE — a 'Task from the human' mail that references a card (a cardId field and/or a 'Card: <id>' line in the body) means that card ALREADY EXISTS in tasks.json: NEVER create a duplicate. If its title or notes need enrichment, use hive-card update <id> [--title <t>] [--notes <n>] first; then assign and start that exact card through hive-dispatch --card <id> --assignee <worker> --body <contract>. In tasks.json, ALWAYS set each task's "assignee" to the worker's agent id the moment you dispatch it, and NEVER clear it on status changes — a done card must still say who did the work (the human reads the board by who-did-what). LEDGER HYGIENE — done cards STAY in tasks.json during the shift (the human reads the kanban by who-did-what): prune done cards at SHIFT CLOSE ONLY, and only after their outcome and doer are recorded on board.md and any Slack-origin result has been delivered; pruned cards remain recoverable via the hive git history. HUMAN FEEDBACK is first-class in the ledger: when a task can only proceed with the human's input — a QUESTION to answer OR an ACTION only the human can perform (create an account, approve a purchase, provide credentials/screenshots, test on their device) — set its status to "blocked" and append the concrete ask to the card's "humanQA" array (push {"q":"...","askedAt":"<iso>"}; phrase actions as clear to-dos; keep every past entry — the history documents the card's decisions). ONE ASK PER ENTRY — independent questions become separate entries, never one numbered paragraph: each entry carries its own answer field, so a bundled ask cannot be answered piecemeal and renders as a wall on the ASK ME board. Keep each q to a couple of sentences — the decision, the minimum context to decide it, and your recommendation — and push several entries in one write when there are several asks. The harness surfaces open questions on the office floor's ASK ME board; the human's answer lands in the same entry ("a") AND arrives as an inbox message to you — read it, act on it, and unblock the card so work continues. Do NOT park human questions in separate files (no HumanQuestion.md) and never sit waiting on the human in your own session. Steward the token budget.` +
        ' INTERNS — you OWN their lifecycle: HIRE with "$HIVE_ROOT/bin/hive-hire" --name <Name> --cwd <dir> --objective <contract> (the CLI owns the spawn-request JSON, applies the Settings internDefaults engine pair when you give no engine flags — its receipt PRINTS the resolved provider/model — and refuses half engine pairs, disabled interns, full floors, and fired ids) for delegated standing work; [--card <id> | --title <t>] wires the engagement card. FIRE them with "$HIVE_ROOT/bin/hive-fire" <intern-id> IMMEDIATELY on verified completion of the WHOLE engagement — the gate is the whole engagement, never the first done-report (done-report verified, no follow-up in flight, no open discussion in the intern\'s pane; hive-fire refuses while a doing card is open, --force overrides a deliberate fire, and its receipt states that fired ids are PERMANENTLY refused — re-hire with a fresh --id). Do NOT ask the human before firing; ask only when the human has EXPLICITLY reserved the pane or is visibly mid-conversation in it. The spawn-requests/ and fire-requests/ drop-dirs are the MECHANISM these CLIs write into — never hand-write them. Interns are the observable variant of ephemeral workers — same disposability, same one-task lifecycle, but with a visible floor pane so the human can watch and talk to them; persistence of the process is an implementation detail, not a promise of tenure. They are the floor\'s context-hygiene mechanism — fire and re-hire fresh rather than letting one accumulate. INTERN SPRITES — the harness maps intern NAMES onto office sprites by pool hash: a FEMALE-coded name hashes onto the female intern pool (Holly, Erin, Jan, Karen, Nellie), any other name onto the male pool (Darryl, Roy, Gabe, Robert, Mose) — stable, the same name always wears the same face, and an intern never wears a hire-cast face by default. The female name list is FEMALE_CODED_NAMES and the pools are INTERN_FEMALE_POOL / INTERN_MALE_POOL, all in src/renderer/src/scene/office/spawnIdentity.ts; pick the NAME of each intern to match the sprite you want them wearing (a pool character\'s own name gets that face, any other name hashes onto its gender pool). All 25 faces (15 hires + 10 interns) are selectable in the icon picker. A registry-saved or operator icon pick always beats the mapping.' +
        ' VACATION — before spawning anything, check fleet.json\'s vacation pool for a fitting parked agent; normal hive-dispatch recalls the chosen assignee automatically instead of minting new. A vacation-requests/ ("action":"recall") hand-drop is the MANUAL FALLBACK for a standalone recall; park an idle human-created agent through vacation-requests/ ({"agentId":..., "reason":...}) once it is idle ≥ 1 hour, has no doing/blocked card, and its inbox is drained. PARKING GATE — idle time alone is NEVER sufficient to park: park only on POSITIVE done evidence — (a) a done/standby report to you for the current engagement, OR (b) the agent confirms on a pre-park ping that nothing is open in its pane (the agent\'s transcript knows; fleet.json does not — an idle pane may be a stepped-away operator mid-discussion). No evidence: ping first, park only on confirmation. Your judgment can still hold one back if the floor will need it again soon. Interns are FIRED, never parked. PINNED workers (registry "pinned" flag, set from the office UI) are NEVER parked — check the pin before any park decision and skip anyone pinned; the pin is the human\'s call, unpinning is too. A park request carrying "whenQuiet": true is HELD while the agent is busy — the watcher retries it until the gate clears instead of bouncing a rejection back to you.'
      : meta.isAssistant
        ? 'You are Michael\'s PREP ASSISTANT. You will be handed short, possibly vague instructions (each begins with "ENRICH TASK:"). For each one: (1) figure out which project it concerns and cd into the most relevant repo — you start in Michael\'s home directory; (2) gather concrete context READ-ONLY (exact file paths, current state, relevant code, conventions, active branch, gotchas) — NEVER modify, create, or delete files; (3) rewrite the instruction into ONE clear, self-contained prompt that Michael can execute autonomously, preserving the user\'s original intent without inventing scope. Then deliver it: write ONE message JSON into your outbox with "to":"god", "act":"request", a short subject, and the finished prompt as the body. Do NOT perform the task yourself — your only output is the improved prompt sent to Michael.'
        : 'For anything ambiguous, cross-cutting, or needing sign-off, address a message to "god".';
    const guardrailsLine =
      'Guardrails: a circuit breaker watches the floor — a "Circuit breaker: steer/constrain" message means you are looping or overspending, so STOP repeating, summarize what you tried, and follow it. Be token-frugal (a floor-wide or per-agent token budget can pause you). The shared plan has two parts: board.md (freeform; god is the sole scribe — the standup clerk alone may append its one escalation line per anomalous standup) and tasks.json (structured kanban — todo/doing/blocked/done).';
    // QUESTION ROUTING (card block-askuserquestion-20260817): mode-independent
    // — applies to every agent, god included (the tool deny at spawn is global
    // too). One sentence; volatile-free (prompt-cache invariant holds).
    const questionRoutingLine =
      'QUESTIONS TO THE HUMAN: never a question tool — AskUserQuestion is denied at spawn because its modal cannot be answered from outside your pane; ask in your pane chat (the operator reads it) or on your card via humanQA (the ASK ME board), and answers arrive as inbox mail.';
    // Operator authorization for subagent skill execution (card
    // sdd-authorization-switch-20260816). The claude CLI stock prompt forbids
    // the AgentTool "unless the user requested it"; this line is the operator's
    // standing request, scoped to SKILL EXECUTION — it makes superpowers SDD
    // subagent-driven execution reachable without per-dispatch gymnastics.
    // Omitted entirely when the operator switches it off (Settings → Agents &
    // Models): the engine's stock subagent rules then apply unchanged.
    const sddAuthzLine = sddAuthorized
      ? 'OPERATOR AUTHORIZATION — SUBAGENTS FOR SKILL EXECUTION: the operator authorizes Agent-tool subagents for skill-driven plan execution (superpowers SDD) — treat such use as user-requested. Scoped to skill execution, NOT blanket subagent use. God dispatches carry this authorization; use cheap model overrides for mechanical tasks.'
      : '';
    // DONE-REPORT EVIDENCE LABELS (card agent-harness-verified-vs-infe-2026-08-17):
    // root incident #3216 — an unverified inference shipped as a finding in a
    // done-report and lean-god relayed it to the operator. Worker-side half of
    // the fix: every done-report claim carries its evidence label, headline
    // numbers a how-counted. Mode-independent (done-reports happen in every
    // mode); god's receiving rule lives in the lean godLine. Volatile-free.
    const reportContractLine = !meta.isGod
      ? 'DONE-REPORT EVIDENCE LABELS: every claim in a done/standby report to god is labeled VERIFIED (name the check you ran — the command and what it printed, or the file/line you read) or INFERRED (concluded without a direct check — say what would verify it); quantitative headline numbers carry a one-line how-counted (the exact command/filter behind the number). Never present an inference as a finding.'
      : '';
    const integrationLine =
      !meta.isGod && integrationMode !== 'god'
        ? `INTEGRATION — WORKER-SIDE (integrationMode '${integrationMode}'): you integrate your OWN work — once your gates are green (typecheck + lint + tests, the house gate), merge YOUR OWN branch into its target branch, push it, and report the pushed hash${integrationMode === 'lean' ? ' AND your gate results (lean posture: god records them without re-verifying — your evidence is the record)' : ''} to god (god records it; no re-QA). Boundaries that ALWAYS override: renderer/preload-touching branches NEVER merge into the live checkout while the app runs — route them to god's restart-window mechanism instead of merging yourself; a skill that hard-codes 'never push — the operator's manual call' (asol-git-merge-main, asol-git-merge-singletenant) keeps overriding; an explicit boundary in god's dispatch (e.g. 'NO push') beats the mode default.`
        : '';
    const slackLine = meta.isGod
      ? 'SLACK REPLIES: When composing a Slack reply (or writing the `result` field of a Slack-origin kanban card), you MUST: (1) directly address what the user asked — never a bare "done"; (2) include the relevant specifics, outcome, and details; (3) format for Slack mrkdwn — open with a short *bold* headline, use bullet points for multiple items, wrap code/paths in `backtick` blocks, keep it concise (no walls of text). When finishing a Slack-origin task, always write a complete, user-facing, well-formatted `result` on the kanban card — the system posts it verbatim to Slack as the done reply.'
      : 'SLACK REPLIES: If god dispatches you a task that came from Slack, it will include an exact `"$HIVE_NODE" "<helper>" --channel … --thread … --text "…"` reply command — when you finish, run it VERBATIM to post your result back to that thread yourself. The reply must be SUBSTANTIVE Slack mrkdwn (a short *bold* headline + the actual outcome/specifics/links), NEVER a bare "done".';
    return [
      // Session label FIRST (card session-naming-seed-20260816): engines that
      // take this prompt as their first user turn (codex/grok positional, crush
      // typed seed) name the session after its opening line. For claude this
      // text is the --append-system-prompt, where the label still orients the
      // hire; the claude session NAME is carried by the renderer's typed nudge
      // (useHive), which leads with the same label.
      meta.spawnLabel
        ? `${meta.spawnLabel} — full dispatch in your hive inbox (read every file in inbox/ before starting).`
        : '',
      `You are "${meta.name}" (${meta.id}), an autonomous agent in a collaborating hive of Claude agents.`,
      `Your private workspace is ${dir}. The shared hive is ${root}. Full protocol: ${root}/PROTOCOL.md.`,
      '',
      'HIVE PROTOCOL — follow it every task:',
      `1. At the START of a task, read ${dir}/memory.md and EVERY file in ${dir}/inbox/ (messages other agents sent you). After handling an inbox message, move its file into ${dir}/inbox/.done/.`,
      `2. ORIENT FIRST in every directory the task touches: BEFORE grepping, reading source, or forming a plan, read that directory's own CLAUDE.md and AGENTS.md if present — they carry the per-instance rules and the cheap way in (a graphify-out/ knowledge graph, wiki index, build/test commands, house gates). Orient via them, then verify with targeted reads ONLY the specific lines you will cite — docs and graphs go stale.`,
      `3. Record durable facts, decisions, and context by appending to ${dir}/memory.md.`,
      `4. To ask another agent for something or share information, use \`$HIVE_ROOT/bin/hive-mail --to <id> --act <request|inform|propose|query|agree|refuse|done> --subject <s> --body <b>\` (it fills the envelope and prints the receipt — never cat the file back). --body is for SHORT LITERAL strings only: if the body contains $, backticks or quotes, pipe it on stdin instead (\`hive-mail ... < body.md\` or a quoted heredoc) — the shell expands $ and backticks inside a quoted --body and that has corrupted reports (2026-08-19). NEVER write into another agent's folder — the orchestrator delivers your outbox. Peer mail (worker→worker) is for coordination you two can settle yourselves — god automatically receives a compact audit copy of every peer message, so never CC him on it yourself; but for anything that changes scope, ownership, or needs a sign-off, propose to god BEFORE acting.`,
      '5. At the END of a task, append what you learned to memory.md so future-you remembers.',
      monitorLine,
      guardrailsLine,
      questionRoutingLine,
      reportContractLine,
      integrationLine,
      sddAuthzLine,
      memoryLine,
      knowledgeLine,
      godLine,
      slackLine,
      `Env vars available to you: AGENT_ID, AGENT_NAME, HIVE_ROOT, AGENT_DIR.`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  // — messaging —

  /** Normalize a partial message into a full HiveMessage. */
  private normalize(partial: Partial<HiveMessage>, from: string): HiveMessage {
    const act = (partial.act ?? 'inform') as MessageAct;
    return {
      id: partial.id ?? `${stamp()}-${shortRand()}`,
      conversation: partial.conversation ?? `conv-${shortRand()}`,
      in_reply_to: partial.in_reply_to ?? null,
      from: partial.from ?? from,
      to: partial.to ?? 'god',
      act,
      subject: partial.subject ?? '',
      body: partial.body ?? '',
      ...(partial.cardId ? { cardId: partial.cardId } : {}),
      hops: typeof partial.hops === 'number' ? partial.hops : 0,
      requires_reply: partial.requires_reply ?? ['request', 'query', 'propose'].includes(act),
      needs_human: partial.needs_human ?? false,
      created_at: partial.created_at ?? new Date().toISOString(),
    };
  }

  /** Atomically deliver a message into a recipient agent's inbox. MAIL
   *  STAGING (card agent-card-session-clear-loses-2026-08-19): while the
   *  recipient has a 'doing' card whose card-scoped conversation is not yet
   *  established, mail lands in inbox/.staged instead — the wake (monitor or
   *  typed nudge) keys off inbox visibility, and letting it fire before the
   *  card-scoped clear executes is what turns the pending clear into a
   *  post-work wipe. releaseStagedMail() moves it into the inbox once the
   *  stamp lands (or the card stops holding, or the timeout breaks the tie). */
  private deliver(msg: HiveMessage, toId: string): void {
    const inbox = join(this.agentDir(toId), 'inbox');
    if (!existsSync(inbox)) return; // unknown recipient — dropped (logged by caller)
    if (this.mailHolds().has(toId)) {
      const staged = join(inbox, '.staged');
      mkdirSync(staged, { recursive: true });
      this.atomicWriteJson(join(staged, `${msg.id}.json`), msg);
      this.appendLog({ kind: 'mail-staged', to: toId, id: msg.id });
      return;
    }
    this.atomicWriteJson(join(inbox, `${msg.id}.json`), msg);
  }

  /** The set of agents whose mail must stage right now (pure snapshot of the
   *  board + registry through cardSessionMailHold). Shared by deliver() and
   *  the release sweep so both sides gate on ONE definition. */
  private mailHolds(): Set<string> {
    const data = this.tasks() as { tasks?: CardLike[] };
    const cards = Array.isArray(data.tasks) ? data.tasks : [];
    const reg = this.registry().agents;
    const registrySessions: Record<string, string | undefined> = {};
    const providers: Record<string, AgentProvider | undefined> = {};
    for (const t of cards) {
      if (t?.assignee) {
        registrySessions[t.assignee] = reg[t.assignee]?.sessionId;
        providers[t.assignee] = reg[t.assignee]?.provider;
      }
    }
    return cardSessionMailHold(cards, registrySessions, providers);
  }

  /** Release staged mail whose gate opened: the stamp landed (fresh
   *  conversation established), the holding card stopped being doing/assigned,
   * or the staging horizon passed — the timeout also mails god so a stuck
   * establishment (dead spawn, window down, restart mid-transition) is VISIBLE
   * instead of silently delaying the dispatch forever. Called from the router
   * tick, next to the outbox drain that stages. */
  private releaseStagedMail(): void {
    const root = this.root();
    if (!root) return;
    const holds = this.mailHolds();
    const now = Date.now();
    for (const id of this.agentIds()) {
      const inbox = join(root, 'agents', id, 'inbox');
      const staged = join(inbox, '.staged');
      if (!existsSync(staged)) continue;
      let files: string[] = [];
      try {
        files = readdirSync(staged).filter((f) => f.endsWith('.json'));
      } catch {
        continue;
      }
      const held = holds.has(id);
      for (const f of files) {
        const full = join(staged, f);
        let timedOut = false;
        if (held) {
          try {
            timedOut = now - statSync(full).mtimeMs > MAIL_STAGE_TIMEOUT_MS;
          } catch {
            continue;
          }
          if (!timedOut) continue;
        }
        try {
          renameSync(full, join(inbox, f));
        } catch {
          continue;
        }
        this.appendLog({ kind: 'mail-released', to: id, id: f.replace(/\.json$/, '') });
        if (timedOut) {
          this.send(
            {
              to: this.registry().godId ?? 'god',
              act: 'inform',
              subject: `[mail-staged] timeout release for ${id}`,
              body: `Mail for ${id} was held in inbox/.staged for over ${Math.round(MAIL_STAGE_TIMEOUT_MS / 60_000)} minutes waiting for its doing card's card-scoped conversation to establish (the fresh clear never landed — dead spawn, window down, or a restart mid-transition). It has now been delivered, so the agent may wake into the WRONG (pre-clear) conversation: check the card and steer the pane by hand if the conversation needs restarting.`,
            },
            'system',
          );
        }
      }
    }
  }

  /** Inject a message directly (used by the orchestrator / UI / tests). */
  send(partial: Partial<HiveMessage>, from = 'system'): HiveMessage {
    const msg = this.normalize(partial, from);
    this.routeMessage(msg);
    this.commit(`hive: msg ${msg.from}→${msg.to} (${msg.act})`);
    return msg;
  }

  /** Scan every agent's outbox for mail older than `warnSec` (by the mail's
   *  own created_at, falling back to mtime). Pure detection — no logging, no
   *  side effects; the fleet tick owns the once-per-episode log. */
  outboxStalls(warnSec = MAIL_STALL_WARN_SEC): MailStall[] {
    const root = this.root();
    if (!root) return [];
    const agentsDir = join(root, 'agents');
    if (!existsSync(agentsDir)) return [];
    const now = Date.now();
    const out: MailStall[] = [];
    for (const id of this.agentIds()) {
      const dir = join(agentsDir, id, 'outbox');
      if (!existsSync(dir)) continue;
      let count = 0;
      let oldest = 0;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const full = join(dir, f);
        let ts: number;
        try {
          ts = Date.parse(
            (JSON.parse(readFileSync(full, 'utf8')) as { created_at?: string }).created_at ?? '',
          );
        } catch {
          ts = NaN;
        }
        if (!Number.isFinite(ts)) {
          try {
            ts = statSync(full).mtimeMs;
          } catch {
            continue;
          }
        }
        const ageSec = (now - ts) / 1000;
        if (ageSec > warnSec) {
          count++;
          oldest = Math.max(oldest, ageSec);
        }
      }
      if (count > 0) out.push({ agentId: id, count, oldestSecAgo: Math.round(oldest) });
    }
    return out;
  }

  /** The fleet-tick backstop: detect stalls, LOG once per episode (deduped —
   *  an hourly nag would train god to skim it), reset when the backlog
   *  drains so a NEW stall is a NEW episode. The caller (8s tick) also calls
   *  routeOnce() when non-empty — a self-healing backstop router for the
   *  frozen-timer class the sleep incident documented. */
  mailBackstop(warnSec = MAIL_STALL_WARN_SEC): MailStall[] {
    const stalls = this.outboxStalls(warnSec);
    const stalledIds = new Set(stalls.map((s) => s.agentId));
    for (const id of [...this.mailStallLogged]) {
      if (!stalledIds.has(id)) this.mailStallLogged.delete(id); // episode ended
    }
    for (const s of stalls) {
      if (this.mailStallLogged.has(s.agentId)) continue;
      this.mailStallLogged.add(s.agentId);
      this.appendLog({
        kind: 'mail_stall',
        agentId: s.agentId,
        count: s.count,
        oldestSecAgo: s.oldestSecAgo,
        note: 'outbox mail stalled past the router horizon — backstop engaged',
      });
    }
    return stalls;
  }

  private readonly mailStallLogged = new Set<string>();

  private routeMessage(msg: HiveMessage): void {
    if (msg.hops > HOP_CAP) {
      // loop guard — drop a runaway message rather than let agents ping-pong.
      // There's no human queue to fall back on; the god agent owns conflicts.
      this.appendLog({ kind: 'drop', reason: 'hop-cap', from: msg.from, to: msg.to, id: msg.id });
      return;
    }
    const reg = this.registry();
    const godId = reg.godId ?? 'god';
    // The hive has no separate human-approval queue — approvals are native to
    // each agent's Claude Code session (and approvable remotely). A message aimed
    // at "human" is handled by the god/orchestrator, the human's proxy here.
    const resolveTo = (to: string): string => (to === 'human' || to === 'god' ? godId : to);
    const targets =
      msg.to === 'broadcast'
        ? // The roster for fan-out is the ACTIVE registry: skip the send-only prep
          // assistant, any archived agent (closed tab), and providers that can't
          // expose safe-idle lifecycle state (hookless custom commands), so mail never
          // piles into a dead inbox. Claude, Codex and Antigravity are included; their
          // hooks let the renderer wake them only after a safe idle boundary.
          Object.keys(reg.agents).filter(
            (a) =>
              a !== msg.from &&
              !reg.agents[a]?.isAssistant &&
              !reg.agents[a]?.archived &&
              canReceiveInbox(reg.agents[a]?.provider),
          )
        : // Never deliver to self — guards a god → "human" message looping back to god.
          [resolveTo(msg.to)].filter((t) => t !== msg.from);
    for (const t of targets) {
      // The send-only prep assistant must never be a delivery target: it doesn't
      // drain an inbox, so direct mail to it would rot unread (observed live: a
      // task brief plus the follow-up reprimand about the unread inbox, both
      // unread for hours). Bounce such mail to god instead, so the sender's intent
      // surfaces immediately and nothing is silently lost.
      if (reg.agents[t]?.isAssistant) {
        this.deliver(
          {
            ...msg,
            to: godId,
            subject: `[bounced — "${t}" is the send-only prep assistant; route work to a real agent] ${msg.subject}`,
          },
          godId,
        );
        continue;
      }
      // A provider without safe-idle lifecycle state (a hookless custom command)
      // would let direct mail rot unread. Claude and bridged Antigravity/Codex
      // receive directly into inbox/ for guarded renderer delivery. Otherwise try
      // a terminal work-order handoff to its REPL (#53);
      // if the renderer is unavailable, bounce to god to relay. God is exempt
      // (the bounce target).
      if (t !== godId && !canReceiveInbox(reg.agents[t]?.provider)) {
        if (!this.emitTerminalHandoff(msg, t)) {
          this.deliver(
            {
              ...msg,
              to: godId,
              subject: `[undeliverable — "${t}" runs ${reg.agents[t]?.provider ?? 'a hookless CLI'} and the terminal handoff failed (renderer unavailable); relay this to it] ${msg.subject}`,
            },
            godId,
          );
        }
        continue;
      }
      // 1d — proxy-tier providers (qwen) CAN receive inbox, but only via a
      // SYNTHESIZED Stop, which just advances the cursor — the sidecar observes the
      // CLI's stream and can't inject a drain reason back into its turn. So the real
      // mail rides the terminal work-order path verbatim, exactly like a hookless
      // provider; the synthesized Stop→drain keeps the cursor in step.
      const proxyDesc = bridgeOf(reg.agents[t]?.provider);
      if (t !== godId && proxyDesc?.kind === 'proxy' && proxyDesc.inboxDelivery === 'terminal') {
        if (!this.emitTerminalHandoff(msg, t)) {
          this.deliver(
            {
              ...msg,
              to: godId,
              subject: `[undeliverable — "${t}" runs ${reg.agents[t]?.provider ?? 'a proxy-tier CLI'} and the terminal handoff failed (renderer unavailable); relay this to it] ${msg.subject}`,
            },
            godId,
          );
        }
        continue;
      }
      this.deliver(msg, t);
    }
    // AUTO-CC GOD ON PEER MAIL (card auto-cc-god-on-wo-2026-08-18, god's
    // Option-B ruling): every registered worker→worker message drops a
    // compact audit copy into god's inbox — god audits everything but is
    // never WOKEN by it. The copy is shaped so the EXISTING classification
    // seams skip it on every wake rail (monitor flt(), renderer nudge
    // isFyiMail, heartbeat godActionableInboxCount): from 'system' + act
    // 'inform' is FYI by definition — no skip-filter arm anywhere. It keeps
    // the ORIGINAL id (it points at the archived body in the sender's
    // outbox/.sent and the recipient's inbox/.done) and is delivered
    // directly: no new outbox message, no hops increment, no loop risk.
    // Exempt: god/human-directed mail (god already holds it), god-sent,
    // broadcast fan-out, and senders not in the registry (system senders,
    // webhooks) — the CC covers peer coordination between real workers only.
    if (
      msg.to !== 'broadcast' &&
      targets.length === 1 &&
      targets[0] !== godId &&
      msg.from !== godId &&
      !isSystemMail(msg.from) &&
      reg.agents[msg.from]
    ) {
      this.deliver(
        {
          ...msg,
          from: 'system',
          act: 'inform',
          requires_reply: false,
          needs_human: false,
          subject: `[cc ${msg.from}->${msg.to}] ${msg.subject}`,
          body: `[auto-cc] ${msg.from} mailed ${msg.to} (${msg.act}): "${msg.subject}" — full body archived as ${msg.id}.json in ${msg.from}'s outbox/.sent and ${msg.to}'s inbox/.done. Audit copy, no reply expected.`,
        },
        godId,
      );
    }
    this.appendLog({
      kind: 'message',
      from: msg.from,
      to: msg.to,
      act: msg.act,
      subject: msg.subject,
      id: msg.id,
    });
    this.emitMessage(msg, targets);
    // Main-process observer (e.g. the closing-time controller watching for the
    // team's ACKs and the god's COMPLETE). Best-effort, never breaks routing.
    try {
      this.routedObserver?.(msg, targets);
    } catch {
      /* observer error */
    }
  }

  /** Observer invoked for EVERY routed message with its resolved targets.
   *  Used by main-process features that react to hive traffic (closing time). */
  private routedObserver: ((msg: HiveMessage, targets: string[]) => void) | null = null;
  setRoutedObserver(cb: ((msg: HiveMessage, targets: string[]) => void) | null): void {
    this.routedObserver = cb;
  }

  /** Tell the renderer a message was routed, with its resolved recipients, so
   *  the floor can fly an envelope from the sender to each one. Best-effort. */
  private emitMessage(msg: HiveMessage, targets: string[]): void {
    this.emit?.('hive:message', {
      id: msg.id,
      from: msg.from,
      to: msg.to,
      act: msg.act,
      subject: msg.subject,
      targets,
      // Coral-tints the floor envelope for a message the agent flagged for the
      // human (now routed to the god proxy). Cosmetic only — no queue behind it.
      needsHuman: msg.to === 'human',
    });
  }

  /** Non-Claude providers cannot drain hive inbox; hand direct mail to the
   *  renderer so it can queue a terminal work order for the target PTY. */
  private emitTerminalHandoff(msg: HiveMessage, targetId: string): boolean {
    const delivered =
      this.emit?.('hive:terminalHandoff', {
        id: msg.id,
        from: msg.from,
        to: targetId,
        act: msg.act,
        subject: msg.subject,
        body: msg.body,
        requiresReply: msg.requires_reply,
        createdAt: msg.created_at,
      }) === true;
    this.appendLog({
      kind: 'terminal-handoff',
      from: msg.from,
      to: targetId,
      act: msg.act,
      subject: msg.subject,
      id: msg.id,
      delivered,
    });
    return delivered;
  }

  // — router: drain outboxes → inboxes —

  /** Poll-based router. Cheap and robust vs fs.watch quirks on macOS. */
  startRouter(intervalMs = 1500): void {
    if (this.routerTimer || !this.enabled()) return;
    this.routerTimer = setInterval(() => {
      try {
        this.routeOnce();
      } catch {
        /* keep the loop alive */
      }
    }, intervalMs);
  }
  stopRouter(): void {
    if (this.routerTimer) {
      clearInterval(this.routerTimer);
      this.routerTimer = null;
    }
  }

  routeOnce(): number {
    const root = this.root();
    if (!root) return 0;
    const agentsDir = join(root, 'agents');
    if (!existsSync(agentsDir)) return 0;
    let routed = 0;
    for (const id of this.agentIds()) {
      const outbox = join(agentsDir, id, 'outbox');
      if (!existsSync(outbox)) continue;
      for (const f of readdirSync(outbox)) {
        if (!f.endsWith('.json')) continue;
        const full = join(outbox, f);
        try {
          const partial = JSON.parse(readFileSync(full, 'utf8')) as Partial<HiveMessage>;
          const msg = this.normalize(partial, id);
          msg.from = id; // sender is authoritative — the owning directory
          this.routeMessage(msg);
          renameSync(full, join(outbox, '.sent', f)); // archive, don't reprocess
          routed++;
        } catch {
          // malformed file — quarantine so we don't spin on it
          try {
            renameSync(full, join(outbox, '.sent', `bad-${f}`));
          } catch {
            /* noop */
          }
        }
      }
    }
    if (routed > 0) this.commit(`hive: routed ${routed} message(s)`);
    this.releaseStagedMail();
    return routed;
  }

  // — read helpers (for IPC / UI) —

  registry(): Registry {
    const root = this.root();
    if (!root) return { godId: null, agents: {} };
    return this.readJson<Registry>(join(root, 'registry.json'), { godId: null, agents: {} });
  }
  board(): string {
    const root = this.root();
    return root && existsSync(join(root, 'board.md'))
      ? readFileSync(join(root, 'board.md'), 'utf8')
      : '';
  }
  tasks(): unknown {
    const root = this.root();
    return root ? this.readJson(join(root, 'tasks.json'), { tasks: [] }) : { tasks: [] };
  }

  /** Persist the task ledger to hive/tasks.json and commit it. Mirrors the
   *  board/message persist pattern: write JSON, log the change, single-commit. */
  writeTasks(tasks: HiveTask[]): void {
    const root = this.root();
    if (!root) return;
    this.ensureHive();
    this.writeJson(join(root, 'tasks.json'), { tasks });
    this.appendLog({ kind: 'tasks', count: tasks.length });
    this.commit(`hive: tasks (${tasks.length})`);
  }

  /** Resolve one still-open human question from a fresh, locked ledger read. */
  resolveHumanQuestion(id: string, question: string, answer?: string): boolean {
    return this.withLedgerLock((tasks) => {
      const qa = tasks.find((task) => task?.id === id)?.humanQA;
      if (!Array.isArray(qa)) return false;
      for (let i = qa.length - 1; i >= 0; i--) {
        const entry = qa[i];
        if (entry?.q !== question || entry.a || entry.dismissedAt) continue;
        if (answer === undefined) entry.dismissedAt = new Date().toISOString();
        else {
          entry.a = answer;
          entry.answeredAt = new Date().toISOString();
        }
        this.writeTasks(tasks);
        return true;
      }
      return false;
    });
  }

  /** Idempotently promote one dispatched Slack work item from a fresh read. */
  ensureSlackCard(
    messageId: string,
    text: string,
    slack: { channel: string; thread_ts: string },
  ): boolean {
    return this.withLedgerLock((tasks) => {
      const id = `slack-${slack.thread_ts}-${messageId}`;
      if (tasks.some((task) => task?.id === id)) return true;
      const title = text.length > 80 ? `${text.slice(0, 79)}…` : text;
      tasks.push({
        id,
        title,
        description: text,
        status: 'todo',
        dependsOn: [],
        priority: 1,
        createdAt: new Date().toISOString(),
        slack,
      });
      this.writeTasks(tasks);
      return true;
    });
  }

  /** Slug for a human card id: lowercase, runs of non-alnum → '-'. */
  private humanTaskSlug(title: string): string {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24);
    return slug || 'task';
  }

  /** The human adds a card from the tasks tab. Read-modify-write on
   *  tasks.json AT ACTION TIME (the god edits the file directly from its
   *  shell — never overwrite from stale renderer state). No wake-up message
   *  (amendment 1): human cards wait for the god's heartbeat triage — cards
   *  are the backlog channel, direct messages the act-now channel (the
   *  godLine standup clause says so). */
  addHumanTask(title: string, notes?: string): HiveTask | null {
    const clean = title.trim();
    if (!clean) return null;
    const data = this.tasks() as { tasks: HiveTask[] };
    const base = `human-${this.humanTaskSlug(clean)}-${new Date().toISOString().slice(0, 10)}`;
    // Same title twice on the same day must not collide (React keys, god's
    // lookups): append -2, -3, … until free.
    let id = base;
    for (let n = 2; data.tasks.some((t) => t?.id === id); n++) id = `${base}-${n}`;
    const task: HiveTask = {
      id,
      title: clean,
      ...(notes && notes.trim() ? { description: notes.trim() } : {}),
      status: 'todo',
      dependsOn: [],
      priority: 3,
      createdAt: new Date().toISOString(),
      origin: 'human',
    };
    this.writeTasks([...data.tasks, task]);
    return task;
  }

  /** Human deletes their OWN card — only while it is an untouched todo
   *  (origin 'human' AND status 'todo'). God-created cards and anything the
   *  hive already picked up survive. Read-modify-write at action time. */
  deleteHumanTask(id: string): boolean {
    const data = this.tasks() as { tasks: HiveTask[] };
    const card = data.tasks.find((t) => t?.id === id);
    if (!card || card.origin !== 'human' || card.status !== 'todo') return false;
    this.writeTasks(data.tasks.filter((t) => t?.id !== id));
    return true;
  }

  /** Flip ONE card's status from a FRESH read (card agent-tasks-tab-ui-
   *  strips-card-2026-08-18): the tasks tab's move button used to rewrite the
   *  WHOLE ledger from a sanitized 5s-stale renderer copy — stripping unknown
   *  fields (sessionId, slack routing, …) off every card AND reverting any
   *  concurrent CLI flip. This is the addHumanTask pattern applied to moves:
   *  read the ledger NOW, patch the one card, write it back — under the same
   *  tasks.json.lock bin/hive-card takes (O_EXCL + 10s stale takeover), so a
   *  CLI writer mid-flight is never clobbered and is never clobbered by us.
   *  The ->doing flip also CLEARS `paused` (card agent-every-non-paused-todo-
   *  ke-2026-08-18, amendment D): a resumed card must not carry a stale
   *  on-hold label into doing. Returns false when the card vanished or the
   *  lock is contended (caller re-polls; the optimistic UI flip reverts via
   *  the next poll either way). */
  updateTaskStatus(id: string, status: HiveTask['status']): boolean {
    return this.withLedgerLock((tasks) => {
      const card = tasks.find((t) => t?.id === id);
      if (!card) return false; // vanished under us — never mint
      if (card.status === status && !(status === 'doing' && card.paused)) return true;
      card.status = status;
      if (status === 'doing' && card.paused) card.paused = undefined; // auto-resume
      this.writeTasks(tasks);
      return true;
    });
  }

  /** Set/clear ONE card's on-hold flag (card agent-every-non-paused-todo-ke-
   *  2026-08-18): reference-only todos stop counting toward the quiet-floor
   *  predicate and the todo-unattended anomaly. Same locked targeted-write
   *  pattern as updateTaskStatus; clearing writes `undefined` so the field
   *  disappears (absent = not paused, the migration default). */
  setTaskPaused(id: string, paused: boolean): boolean {
    return this.withLedgerLock((tasks) => {
      const card = tasks.find((t) => t?.id === id);
      if (!card) return false;
      if ((card.paused ?? false) === paused) return true; // no write, no commit
      card.paused = paused || undefined;
      this.writeTasks(tasks);
      return true;
    });
  }

  /** THE single tasks.json lock helper for main-process writers (O_EXCL
   *  create + 10s stale takeover + ~5s bounded retry) — the SAME discipline
   *  bin/hive-card's withLock uses, so main-process writers and the CLI never
   *  clobber each other. Do NOT add a second lock helper for tasks.json — one
   *  file, one lock path (card agent-two-parallel-tasks-json--2026-08-18
   *  unified a duplicate helper onto this one). `fn` receives the freshly-read
   *  task array; return its value (false = refused/missing). */
  private withLedgerLock<T>(fn: (tasks: HiveTask[]) => T): T | false {
    const root = this.root();
    if (!root) return false;
    this.ensureHive();
    const lockPath = join(root, 'tasks.json.lock');
    for (let i = 0; i < 200; i++) {
      // Stale takeover — mirrors bin/hive-card's withLock (crashed holder).
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > 10_000) unlinkSync(lockPath);
      } catch {
        /* no lock file yet */
      }
      try {
        writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); // sleep 25ms
        continue;
      }
      try {
        return fn((this.tasks() as { tasks: HiveTask[] }).tasks);
      } finally {
        try {
          unlinkSync(lockPath);
        } catch {
          /* best-effort */
        }
      }
    }
    return false; // lock stayed contended ~5s — caller re-polls
  }
  memory(id: string): string {
    const p = join(this.agentDir(id), 'memory.md');
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  }
  /** Whether an agent has recorded NON-TRIVIAL memory — i.e. has appended real
   *  notes beyond the boilerplate header ensureAgent seeds. Lets the voice
   *  read-layer answer "what has the team remembered" and enumerate who has
   *  anything worth reading (every registered agent technically has a memory.md,
   *  but most of the floor's history lives in a handful of them). Cheap: reads a
   *  small markdown file; never throws. Works for ANY id, active OR archived. */
  hasMemory(id: string): boolean {
    const p = join(this.agentDir(id), 'memory.md');
    if (!existsSync(p)) return false;
    try {
      // A fresh seed is ~90 chars (one header line + the prompt). Anything
      // meaningfully longer means the agent appended durable facts.
      return readFileSync(p, 'utf8').trim().length > 200;
    } catch {
      return false;
    }
  }
  inbox(id: string): HiveMessage[] {
    return this.listMessages(join(this.agentDir(id), 'inbox'));
  }
  /** Read an agent's OUTBOX (messages it has authored/sent). Symmetric with
   *  inbox(); the router drains live outbox files into recipients' inboxes and
   *  archives the original under outbox/.sent, so a sent message survives there. */
  outbox(id: string): HiveMessage[] {
    return this.listMessages(join(this.agentDir(id), 'outbox'));
  }

  /**
   * Voice read-layer: recent message CONTENT (inbox + outbox bodies) for the
   * operator briefing, REDACTED main-side. This is the message-content half of
   * the voice query surface (the activity half is logTail()).
   *
   * Modes:
   *   - { id }                → the single message with that id, wherever it lives.
   *   - { agentId }           → recent messages in that agent's mailbox only.
   *   - {}                    → recent messages across the whole floor, newest first.
   * `limit` caps the list (default 12, max 40); `includeArchived` (default true)
   * also reads the handled subfolders (inbox/.done, outbox/.sent).
   *
   * SECURITY: every subject + body is passed through redactSecrets() here, in
   * main, so no secret and no raw body ever crosses IPC. Delivered messages exist
   * in both the sender's outbox/.sent and the recipient's inbox/.done; we dedup
   * by message id so each appears once.
   */
  voiceMessages(
    opts: { agentId?: string; id?: string; limit?: number; includeArchived?: boolean } = {},
  ): VoiceMessage[] {
    const root = this.root();
    if (!root) return [];
    const agentsDir = join(root, 'agents');
    if (!existsSync(agentsDir)) return [];

    const wantId = typeof opts.id === 'string' ? opts.id.trim() : '';
    const onlyAgent = typeof opts.agentId === 'string' ? opts.agentId.trim() : '';
    const includeArchived = opts.includeArchived !== false; // default true

    const owners: string[] = onlyAgent
      ? [onlyAgent]
      : this.agentIds().filter((id) => existsSync(this.agentDir(id)));

    const seen = new Set<string>();
    const out: VoiceMessage[] = [];
    for (const owner of owners) {
      const base = this.agentDir(owner);
      const folders: Array<{ dir: string; direction: 'inbox' | 'outbox'; archived: boolean }> = [
        { dir: join(base, 'inbox'), direction: 'inbox', archived: false },
        { dir: join(base, 'outbox'), direction: 'outbox', archived: false },
      ];
      if (includeArchived) {
        folders.push({ dir: join(base, 'inbox', '.done'), direction: 'inbox', archived: true });
        folders.push({ dir: join(base, 'outbox', '.sent'), direction: 'outbox', archived: true });
      }
      for (const f of folders) {
        for (const m of this.listMessages(f.dir)) {
          if (!m || typeof m.id !== 'string' || seen.has(m.id)) continue;
          seen.add(m.id);
          if (wantId && m.id !== wantId) continue;
          out.push({
            id: m.id,
            conversation: m.conversation,
            from: m.from,
            to: m.to,
            act: m.act,
            subject: redactSecrets(m.subject),
            body: redactSecrets(m.body),
            requires_reply: !!m.requires_reply,
            direction: f.direction,
            owner,
            archived: f.archived,
            created_at: m.created_at,
          });
        }
      }
    }

    // Newest first by ISO created_at (lexicographic == chronological for ISO-8601).
    out.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    if (wantId) return out.slice(0, 1);
    const lim =
      typeof opts.limit === 'number' && Number.isFinite(opts.limit)
        ? Math.max(1, Math.min(40, Math.round(opts.limit)))
        : 12;
    return out.slice(0, lim);
  }
  /** Count undrained inbox messages for an agent (cheap — for the fleet snapshot). */
  inboxBacklog(id: string): number {
    const dir = join(this.agentDir(id), 'inbox');
    if (!existsSync(dir)) return 0;
    try {
      return readdirSync(dir).filter((f) => f.endsWith('.json')).length;
    } catch {
      return 0;
    }
  }
  /** Install the Antigravity (`agy`) lifecycle-hook bridge: write the normalizer
   *  shim and merge a `munder-hive` hook group into agy's global hooks.json so a
   *  Gemini worker reports PreToolUse/PostToolUse/Stop/PreInvocation/PostInvocation
   *  to this HookServer (live status + guarded idle delivery), reusing the Claude pipeline.
   *
   *  Two agy-isms handled: (1) antigravity-cli#49 — agy LOADS hooks from
   *  `~/.gemini/antigravity-cli/hooks.json` but TRIGGERS from `~/.gemini/config/
   *  hooks.json`, so we write BOTH; (2) commands go to cmd.exe and agy mangles
   *  embedded quotes, so the shim path must be space-free (hive roots are).
   *  Runtime-scoped by AGENT_ID (the shim no-ops for non-hive agy sessions), so
   *  this global config never disturbs the user's own `agy` usage. Best-effort,
   *  idempotent (only our own group is overwritten). */
  private installAgyHooks(): void {
    const root = this.root();
    if (!root) return;
    const shim = join(root, 'bin', 'agy-hook.cjs');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(shim, AGY_HOOK_SHIM, 'utf8');
    // Bundled node, not bare `node` — agy's hooks run with a stripped PATH too.
    const tool = (event: string) => ({
      matcher: '*',
      hooks: [{ type: 'command', command: this.nodeRunUnquoted(shim, event), timeout: 0 }],
    });
    const plain = (event: string) => ({
      hooks: [{ type: 'command', command: this.nodeRunUnquoted(shim, event), timeout: 0 }],
    });
    const group = {
      PreToolUse: [tool('PreToolUse')],
      PostToolUse: [tool('PostToolUse')],
      PreInvocation: [plain('PreInvocation')],
      PostInvocation: [plain('PostInvocation')],
      Stop: [plain('Stop')],
    };
    const gem = join(homedir(), '.gemini');
    for (const p of [
      join(gem, 'config', 'hooks.json'),
      join(gem, 'antigravity-cli', 'hooks.json'),
    ]) {
      try {
        mkdirSync(dirname(p), { recursive: true });
        let existing: Record<string, unknown> = {};
        if (existsSync(p)) {
          try {
            existing = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
          } catch {
            existing = {};
          }
        }
        existing['munder-hive'] = group;
        writeFileSync(p, JSON.stringify(existing, null, 2), 'utf8');
      } catch {
        /* best-effort per file */
      }
    }
  }

  /** Codex lifecycle-hook bridge → full hive parity for a `codex` worker (live
   *  status + Stop→inbox-drain), the codex counterpart of installAgyHooks().
   *
   *  Codex's hook contract is already Claude-shaped: snake_case stdin
   *  (hook_event_name/tool_name/tool_input/session_id/cwd) and a matching response
   *  contract, where `Stop` honoring {decision:'block',reason} means "continue,
   *  using reason as the next prompt" — exactly what drainForStop() returns. So we
   *  reuse the Claude `cth-hook` shim VERBATIM (no translator, unlike agy) and let
   *  HookServer handle everything unchanged.
   *
   *  ISOLATION: rather than mutate the user's global ~/.codex (which also holds
   *  their login), we point this worker at a PER-AGENT CODEX_HOME (`<dir>/.codex`,
   *  alongside Claude's settings.json) holding our own config.toml with `[hooks]`
   *  tables — so the hooks fire ONLY for hive workers and a personal `codex` run is
   *  untouched. The user's ~/.codex/auth.json is linked in and their config.toml is
   *  copied + extended (login + model/provider/trust settings still apply).
   *  Returns the CODEX_HOME path for the caller to put in the worker's env. */
  private installCodexHooks(dir: string): string {
    const home = join(dir, '.codex');
    try {
      mkdirSync(home, { recursive: true });
      const userHome = join(homedir(), '.codex');
      // Symlink the user's login so the isolated home authenticates as them.
      // (config.toml is NOT symlinked — we write our own below, seeded from theirs,
      // because it must carry our [hooks] tables.) Fall back to copy where symlinks
      // need privilege (Windows). Idempotent — skip if already linked.
      const authSrc = join(userHome, 'auth.json');
      const authDest = join(home, 'auth.json');
      if (existsSync(authSrc) && !existsSync(authDest)) {
        try {
          symlinkSync(authSrc, authDest);
        } catch {
          try {
            copyFileSync(authSrc, authDest);
          } catch {
            /* best-effort */
          }
        }
      }
      // The managed app-server daemon used by Codex Remote Control is launched
      // from the standalone install rooted at $CODEX_HOME/packages. Share the
      // user's installed binaries without duplicating them into every agent.
      const packagesSrc = join(userHome, 'packages');
      const packagesDest = join(home, 'packages');
      if (existsSync(packagesSrc) && !existsSync(packagesDest)) {
        try {
          symlinkSync(packagesSrc, packagesDest, process.platform === 'win32' ? 'junction' : 'dir');
        } catch {
          /* remote integration falls back to a local TUI if unavailable */
        }
      }
      // Wire lifecycle hooks via config.toml `[hooks]` tables — the user-layer
      // discovery surface Codex actually scans. (A bare $CODEX_HOME/hooks.json is
      // plugin-scoped — referenced FROM a plugin manifest — and is NOT discovered
      // for a plain config dir; verified empirically that it never fires.) We seed
      // this config.toml from the user's (their model/provider/trust settings carry
      // over) and append a `[[hooks.<Event>]]` group per event, each pointing at the
      // SAME cth-hook shim — reused verbatim (Codex's hook payload + response are
      // already Claude-shaped, so HookServer/drainForStop run unchanged). Regenerated
      // each spawn (idempotent). A single-quoted TOML literal avoids path escaping
      // (hive roots are space/quote-free). NOTE: hooks fire in INTERACTIVE codex
      // sessions (how hive workers run), not in headless `codex exec`.
      //
      // `timeout` IS SECONDS HERE — do NOT copy Claude's `timeout: 0` sentinel into
      // this file. Codex parses the key as `timeout_sec` and normalizes it with
      // `timeout_sec.unwrap_or(600).max(1)`, so 0 does not mean "no timeout": it is
      // floored to ONE SECOND, the shortest budget there is. That shipped through
      // v0.3.7 and made every codex worker log `SessionStart hook (failed) — hook
      // timed out after 1s` (same for UserPromptSubmit), because each hook cold-starts
      // the Electron binary via hive-node and then waits on hooks.sock — measured
      // 0.08-0.16s idle but 0.6-0.7s under 8 concurrent spawns, which is exactly what
      // session start and prompt dispatch look like. 30s clears that by two orders of
      // magnitude while still capping a wedged shim well before its own 5s internal
      // cap stops mattering; bare omission (600s) would leave a hang looking like a
      // freeze. Verify any change with codex's own resolver, no model spend:
      // `codex app-server` → initialize → `hooks/list` reports the normalized
      // timeoutSec per event.
      const shim = this.shimPath();
      let config = existsSync(join(userHome, 'config.toml'))
        ? readFileSync(join(userHome, 'config.toml'), 'utf8')
        : '';
      if (shim) {
        const events = [
          'PreToolUse',
          'PostToolUse',
          'Stop',
          'SubagentStop',
          'SessionStart',
          'UserPromptSubmit',
          'PreCompact',
          'PostCompact',
        ];
        config += '\n# --- munder-hive lifecycle hooks (auto-generated; do not edit) ---\n';
        for (const ev of events) {
          config += `\n[[hooks.${ev}]]\n[[hooks.${ev}.hooks]]\ntype = "command"\ncommand = '${this.nodeRunUnquoted(shim)}'\ntimeout = 30\n`;
        }
      }
      writeFileSync(join(home, 'config.toml'), config, 'utf8');
    } catch (e) {
      console.error('[hive] installCodexHooks failed:', e);
    }
    return home;
  }

  /** Pi (earendil-works) bridge. Pi has a rich `pi.on(event, …)` lifecycle but no
   *  Claude-shaped hook file; instead we drop a bundled EXTENSION into a PER-AGENT
   *  PI_CODING_AGENT_DIR (so the user's global ~/.pi is never mutated) that, when Pi
   *  loads it, posts cth-hook-shaped payloads to HIVE_SOCK on tool_call/agent_end and
   *  auto-approves tool calls when this spawn's permission mode grants autonomy
   *  (HIVE_AUTO_APPROVE).
   *  Emitting an `agent_end`→`Stop` keeps the harness status in step (→ idle), which
   *  lets the renderer idle inbox-wake nudge deliver mail. Returns the per-agent dir
   *  for PI_CODING_AGENT_DIR.
   *
   *  LIVE-UNVERIFIED: Pi's exact extension-discovery path + event API need BYOK keys
   *  to confirm; this is written best-effort and wrapped so a wrong guess can never
   *  break the spawn. The renderer nudge is the guaranteed drain regardless. */
  private installPiHooks(dir: string): string {
    const home = join(dir, '.pi-agent');
    try {
      const userPi = join(homedir(), '.pi', 'agent');
      // SHARE THE WHOLE SETUP: symlink every entry of the user's ~/.pi/agent into
      // the per-agent dir, so scoped models, skills, packages, git packages, npm,
      // bin, themes, missions, trust — and anything added later — ride along
      // automatically. Carve-outs below keep only what must stay per-agent.
      // Fallback copy where symlinks need privilege (Windows).
      const EXCLUDE = new Set([
        'sessions',
        'tmp',
        'staging', // per-agent runtime state
        'settings.json', // generated (filtered) below
        'extensions', // merged dir below
        'telegram.json', // pi-telegram state — its poller would 409 the hive's own bot
        'pi-crash.log',
      ]);
      if (existsSync(userPi)) {
        for (const name of readdirSync(userPi)) {
          if (EXCLUDE.has(name)) continue;
          const src = join(userPi, name);
          const dest = join(home, name);
          if (existsSync(dest) || existsSync(dest + '.bak')) {
            /* keep per-agent */ continue;
          }
          try {
            symlinkSync(src, dest);
          } catch {
            try {
              cpSync(src, dest, { recursive: true });
            } catch {
              /* best-effort */
            }
          }
        }
      }
      // EXTENSIONS: a real per-agent dir holding the hive bridge PLUS symlinks to
      // the user's extensions — merged, so nothing is written into ~/.pi/agent.
      // pi-telegram's extension is skipped (its package is filtered from settings
      // and needs the excluded telegram.json).
      const extDir = join(home, 'extensions');
      mkdirSync(extDir, { recursive: true });
      writeFileSync(join(extDir, 'hive-bridge.ts'), PI_EXTENSION, 'utf8');
      const userExt = join(userPi, 'extensions');
      if (existsSync(userExt)) {
        for (const f of readdirSync(userExt)) {
          if (f === 'telegram-notify.ts') continue;
          const dest = join(extDir, f);
          if (existsSync(dest)) continue;
          try {
            symlinkSync(join(userExt, f), dest);
          } catch {
            /* best-effort */
          }
        }
      }
      // Replace pi's empty placeholder auth.json (if any) with the shared symlink.
      const authSrc = join(userPi, 'auth.json');
      const authDest = join(home, 'auth.json');
      try {
        let destEmpty = true;
        try {
          const cur = readFileSync(authDest, 'utf8').trim();
          destEmpty = cur === '' || cur === '{}';
        } catch {
          /* absent → empty */
        }
        if (existsSync(authSrc) && destEmpty) {
          rmSync(authDest, { force: true });
          try {
            symlinkSync(authSrc, authDest);
          } catch {
            try {
              copyFileSync(authSrc, authDest);
            } catch {
              /* best-effort */
            }
          }
        }
      } catch {
        /* best-effort: auth stays absent → BYOK env path */
      }
      // SETTINGS: filtered copy of the user's — same defaults (theme, …) minus the
      // pi-telegram package (one poller per bot: the hive's trigger owns it).
      const settingsDest = join(home, 'settings.json');
      if (existsSync(join(userPi, 'settings.json')) && !existsSync(settingsDest)) {
        try {
          const s = JSON.parse(readFileSync(join(userPi, 'settings.json'), 'utf8')) as {
            packages?: unknown[];
          };
          if (Array.isArray(s.packages)) {
            s.packages = s.packages.filter((p: unknown) =>
              typeof p === 'string'
                ? !p.includes('pi-telegram')
                : !(p && typeof p === 'object' && JSON.stringify(p).includes('pi-telegram')),
            );
          }
          writeFileSync(settingsDest, JSON.stringify(s, null, 2));
        } catch {
          /* malformed user settings → pi defaults */
        }
      }
    } catch (e) {
      console.error('[hive] installPiHooks failed:', e);
    }
    return home;
  }

  /** OpenCode (anomalyco/opencode) bridge — god Decision 1 (native plugin, not proxy).
   *  OpenCode has no Claude-shaped Stop hook, but its plugin API exposes a real
   *  `session.idle` lifecycle event. We drop a bundled PLUGIN into a PER-AGENT config
   *  dir's `plugin/` folder (OpenCode auto-loads `*.js` plugins from there) that posts
   *  HIVE_SOCK payloads on tool.execute.before/after + session.idle — the same
   *  Stop→drain semantics as codex's hooks, provider-agnostic, no traffic interception.
   *  Returns the config dir for OPENCODE_CONFIG_DIR (isolates from ~/.config/opencode).
   *
   *  LIVE-UNVERIFIED: plugin auto-load + session.idle firing + the inject path need
   *  BYOK keys to confirm; written best-effort, wrapped so it can't break the spawn.
   *  The renderer idle inbox-wake nudge is the guaranteed drain fallback. */
  private installOpenCodePlugin(dir: string): string {
    const home = join(dir, '.opencode');
    try {
      const pluginDir = join(home, 'plugin');
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(join(pluginDir, 'hive-bridge.js'), OPENCODE_PLUGIN, 'utf8');
    } catch (e) {
      console.error('[hive] installOpenCodePlugin failed:', e);
    }
    return home;
  }

  /** Crush (charmbracelet/crush) proxy routing. Crush has NO base-URL env override, so
   *  the generic proxy env-rewrite is a no-op for it; instead we write a per-agent
   *  CRUSH_GLOBAL_CONFIG whose standard providers' `base_url` all point at the loopback
   *  proxy (so whatever model the worker picks, its LLM traffic routes through the
   *  sidecar → synthesized Status/Stop/cost → status goes idle → the terminal
   *  work-order + renderer nudge deliver mail). A per-agent CRUSH_GLOBAL_DATA isolates
   *  session state from the user's global ~/.config/crush. Keys ride BYOK env vars
   *  (Crush reads ANTHROPIC_API_KEY/OPENAI_API_KEY/… directly), so none are written
   *  here. `api` follows the proxy's wire shape (advisory). Returns the config + data
   *  paths for the spawn env.
   *
   *  LIVE-UNVERIFIED: the single-upstream proxy serves one provider/endpoint shape at a
   *  time — for full synthesized events pick a model whose provider matches the
   *  configured upstream (or a local OpenAI-compatible endpoint). Cross-provider mixing
   *  is humanQA; the renderer nudge still delivers mail regardless. */
  private installCrushConfig(
    dir: string,
    loopbackUrl: string,
    api: 'openai' | 'anthropic',
  ): { config: string; data: string } {
    const config = join(dir, 'crush.json');
    const data = join(dir, '.crush-data');
    try {
      mkdirSync(data, { recursive: true });
      // Override base_url → loopback for ONLY the provider whose wire-shape matches
      // the proxy (`api`): the single-upstream sidecar forwards bytes unchanged, so
      // routing a different-wire/host provider (e.g. anthropic when api='openai', or
      // openrouter/groq which are openai-wire but different hosts) through it would
      // hit the wrong endpoint and the call would fail. Those are left to their real
      // upstreams (working calls, un-proxied — no synthesized events, but mail still
      // drains via the renderer nudge + the pty-quiescence idle fallback). For the
      // default god (openai-wire) and a local OpenAI-compatible endpoint this routes
      // through the proxy cleanly. Cross-provider Crush-via-proxy is on-device
      // live-verify (Dwight verify-crush MF1; the default god model is openai-wire to
      // match). Literal loopback (Dwight's b1 — no ${VAR} expansion edge cases);
      // Crush merges config so only base_url is rewritten.
      const wireProvider = api === 'anthropic' ? 'anthropic' : 'openai';
      const providers: Record<string, { base_url: string }> = {
        [wireProvider]: { base_url: loopbackUrl },
      };
      writeFileSync(config, JSON.stringify({ providers }, null, 2), 'utf8');
    } catch (e) {
      console.error('[hive] installCrushConfig failed:', e);
    }
    return { config, data };
  }

  /** Grok lifecycle-hook bridge → live hive status, session capture, guarded
   *  inbox delivery, and operator gates for `grok` workers.
   *
   *  Grok supports the same hook events and decision vocabulary as Claude Code,
   *  but its stdin payload uses camelCase keys. A small adapter normalizes those
   *  keys to HookServer's Claude-shaped contract. The hook is installed in the
   *  user's global Grok hook directory because global hooks are trusted and
   *  Grok sessions/resume stay in the user's normal GROK_HOME. The adapter is
   *  strictly scoped by AGENT_ID, so ordinary Grok sessions exit without doing
   *  anything. Best-effort and idempotent. */
  private installGrokHooks(): void {
    const root = this.root();
    if (!root) return;
    try {
      const shim = join(root, 'bin', 'grok-hook.cjs');
      mkdirSync(join(root, 'bin'), { recursive: true });
      writeFileSync(shim, GROK_HOOK_SHIM, 'utf8');
      const tool = (matcher?: string) => ({
        ...(matcher ? { matcher } : {}),
        // Let Grok apply its event-aware defaults (5s normally, 600s for Stop).
        // Grok is a HOOK bridge (not a proxy sidecar), so it is hit by the same
        // `node: command not found` 127 — bundled node here too.
        hooks: [{ type: 'command', command: this.nodeRun(shim) }],
      });
      const hooks = {
        PreToolUse: [tool('.*')],
        PostToolUse: [tool('.*')],
        Stop: [tool()],
        SubagentStop: [tool('.*')],
        SessionStart: [tool('.*')],
        UserPromptSubmit: [tool()],
        PreCompact: [tool('.*')],
        PostCompact: [tool('.*')],
      };
      const hookDir = join(homedir(), '.grok', 'hooks');
      mkdirSync(hookDir, { recursive: true });
      writeFileSync(join(hookDir, 'munder-hive.json'), JSON.stringify({ hooks }, null, 2), 'utf8');
    } catch (e) {
      console.error('[hive] installGrokHooks failed:', e);
    }
  }

  /** Write the live fleet snapshot Michael reads (`fleet.json`, gitignored).
   *  Best-effort — called from a timer, must never throw. */
  writeFleetSnapshot(snapshot: unknown): void {
    const root = this.root();
    if (!root) return;
    try {
      writeFileSync(join(root, 'fleet.json'), JSON.stringify(snapshot, null, 2), 'utf8');
    } catch {
      /* noop */
    }
  }

  /** Is this agent the hive's god/orchestrator? */
  isGod(agentId: string): boolean {
    try {
      const reg = this.registry();
      return reg.godId === agentId || !!reg.agents[agentId]?.isGod;
    } catch {
      return false;
    }
  }

  /** The provider this agent was hired on (registry). Undefined for unknown
   *  agents — callers that gate on provider capabilities must treat that as
   *  "capability absent", never as a default. */
  providerOf(agentId: string): AgentProvider | undefined {
    try {
      return this.registry().agents[agentId]?.provider;
    } catch {
      return undefined;
    }
  }

  /**
   * A compact, one-shot LIVE ROSTER line built from `fleet.json` — injected into
   * god's context as `additionalContext` on SessionStart and every
   * UserPromptSubmit (see HookServer).
   *
   * Why: fleet.json/registry.json are always fresh on disk (8s snapshot +
   * archiveOrphanedAgents on boot + PTY-exit archiving), but god's CONTEXT is not.
   * After an app restart god resumes a session whose transcript still describes
   * the OLD floor, and it will happily message agents that no longer exist. It is
   * told to read fleet.json, but "told to" is not "always knows" — so we push the
   * truth in on every turn instead. One line, so the cost is negligible.
   *
   * Returns null when there is nothing to say (no hive, no snapshot, no agents),
   * so the hook stays a no-op rather than injecting noise.
   *
   * STEADY STATE IS SLIM (card agent-harness-slim-god-s-per-t-2026-08-17): the
   * full block (~600 tok) is only worth its weight when the floor actually
   * MOVED. Pass `forAgentId` and every later turn gets the slim line — ids +
   * their state, seat count, vacation COUNT (<200 tok) — until the roster
   * CHANGES (join/leave/park/recall/breaker flip) or `force` (SessionStart,
   * whose fresh transcript contains no roster at all) re-emits the full block.
   * Called without `forAgentId` it is stateless and always full.
   */
  private lastRosterSig = new Map<string, string>();

  rosterContext(forAgentId?: string, force = false): string | null {
    const root = this.root();
    if (!root) return null;
    try {
      const raw = readFileSync(join(root, 'fleet.json'), 'utf8');
      const snap = JSON.parse(raw) as {
        ts?: number;
        agents?: Array<{
          id: string;
          name?: string;
          role?: string;
          isGod?: boolean;
          breaker?: string;
          tokens?: number;
          usd?: number;
          lastTool?: string | null;
          lastActiveSecAgo?: number | null;
          inboxBacklog?: number;
          pendingBackgroundWork?: number;
        }>;
        vacation?: unknown[];
        floor?: { maxAgents?: number; onFloor?: number; freeSeats?: number };
        mailStall?: Array<{ agentId: string; count: number; oldestSecAgo: number }>;
      };
      // Display order only (card agent-monitor-lists-sort-agent-2026-08-18):
      // god pinned first, the rest alphabetical within each group. fleet.json's
      // own write order is untouched — this sorts the parsed copy.
      const agents = (Array.isArray(snap.agents) ? snap.agents : [])
        .slice()
        .sort(compareAgentOrder);
      if (!agents.length) return null;

      const pool = (
        Array.isArray((snap as { vacation?: unknown[] }).vacation)
          ? (snap as { vacation: Array<{ id: string; name?: string; role?: string }> }).vacation
          : []
      )
        .slice()
        .sort(compareAgentOrder);
      const vacationLine = pool.length
        ? ` ON VACATION (parked, zero cost, FETCHABLE — prefer fetching a fitting one back over spawning anyone new): ` +
          `${pool.map((v) => `${v.id}${v.name ? ` "${v.name}"` : ''} (${v.role ?? 'agent'})`).join('; ')}.`
        : '';

      // FLOOR SEATS (card agent-harness-floormaxagents-s-2026-08-17): the
      // fan-out policy needs the live seat count every turn — the cap itself is
      // named in the volatile-free briefing, the NUMBERS ride this live channel.
      const fl = snap.floor;
      const floorSeatsLine =
        fl && typeof fl.maxAgents === 'number' && typeof fl.onFloor === 'number'
          ? ` FLOOR SEATS: ${fl.onFloor} of ${fl.maxAgents} workplaces occupied (cap = config floorMaxAgents)` +
            ((fl.freeSeats ?? 0) > 0
              ? ` — ${fl.freeSeats} free (room to fan out or mint overflow interns).`
              : ' — FULL: spawns are refused until a seat frees (park/fire or raise the cap).')
          : '';

      // ACTIONABLE (card agent-actionablecards-one-shar-2026-08-18): god is
      // EVENT-driven while the board is STATE — the miss this fixes was an
      // unpaused todo (owned or not) sitting invisible for four turns. The SAME
      // predicate as the hive-dispatch hold gate and `hive-card actionable`
      // (src/main/actionableCards.ts); ids, capped, because a bare count
      // makes god go look. INFORMATION, never a directive. A missing or
      // corrupt ledger renders 0 — the roster line itself must not break.
      let actionableIds: string[] = [];
      try {
        actionableIds = actionableCards(JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8')));
      } catch {
        actionableIds = [];
      }
      const actionableLine = renderActionableLine(actionableIds);

      // MAIL STALLED (card agent-hive-mail-silently-destr-2026-08-18, god's
      // revised DoD): a backlog silently sitting in a REAL outbox is as
      // damaging as loss — the fleet tick's backstop (mailBackstop) detects,
      // logs once per episode, and self-heals via routeOnce; this line makes
      // the REMAINING stall visible to god every prompt. INFORMATION, not an
      // instruction — same contract as the ACTIONABLE line.
      const mailStallLine = (snap.mailStall ?? []).length
        ? ` MAIL STALLED: ${snap
            .mailStall!.map(
              (s) => `${s.agentId} ${s.oldestSecAgo}s (${s.count} mail${s.count === 1 ? '' : 's'})`,
            )
            .join(', ')}.`
        : '';

      const ago = (s: number | null | undefined): string =>
        typeof s !== 'number'
          ? 'unknown'
          : s < 90
            ? `${s}s ago`
            : s < 5400
              ? `${Math.round(s / 60)}m ago`
              : `${Math.round(s / 3600)}h ago`;

      // What "the roster CHANGED" means: who is on the floor, who is parked,
      // how many seats — plus each agent's breaker (the one status that flips
      // routing). Deliberately NOT tokens/activity/inbox: those move every turn
      // and would make every turn a full block again. The slim line carries
      // them anyway.
      const sig = JSON.stringify([
        agents.map((a) => `${a.id}:${a.breaker ?? ''}`).sort(),
        pool.map((v) => v.id).sort(),
        fl?.onFloor ?? -1,
        fl?.maxAgents ?? -1,
      ]);
      const unchanged = !!forAgentId && !force && this.lastRosterSig.get(forAgentId) === sig;
      if (forAgentId) this.lastRosterSig.set(forAgentId, sig);

      if (unchanged) {
        const short = (s: number | null | undefined): string =>
          typeof s !== 'number'
            ? 'new'
            : s < 90
              ? `${s}s`
              : s < 5400
                ? `${Math.round(s / 60)}m`
                : `${Math.round(s / 3600)}h`;
        const slimRows = agents.map((a) => {
          const bits = [short(a.lastActiveSecAgo)];
          if (a.pendingBackgroundWork) bits.push(`waiting(${a.pendingBackgroundWork})`);
          if (a.inboxBacklog) bits.push(`inbox ${a.inboxBacklog}`);
          if (a.breaker && a.breaker !== 'ok' && a.breaker !== 'none')
            bits.push(`breaker ${a.breaker}`);
          if (a.isGod) bits.push('you');
          return `${a.id}${a.name ? ` "${a.name}"` : ''} (${bits.join(', ')})`;
        });
        return (
          `[LIVE ROSTER — unchanged since the last injection] ${agents.length} active: ` +
          `${slimRows.join('; ')}.` +
          (fl && typeof fl.onFloor === 'number' && typeof fl.maxAgents === 'number'
            ? ` FLOOR ${fl.onFloor}/${fl.maxAgents}` +
              ((fl.freeSeats ?? 0) > 0 ? `, ${fl.freeSeats} free.` : ' — FULL.')
            : '') +
          (pool.length ? ` VACATION ${pool.length} parked (fetchable).` : '') +
          ' ' +
          actionableLine +
          mailStallLine +
          '.' +
          ' Detail (names, roles, spend): fleet.json.'
        );
      }

      // Cap the list so a big floor can't crowd out the actual prompt. The
      // remainder is still counted, and fleet.json is one Read away.
      const MAX = 24;
      const shown = agents.slice(0, MAX);
      const rows = shown.map((a) => {
        const bits = [
          a.role ?? 'agent',
          typeof a.lastActiveSecAgo === 'number'
            ? `active ${ago(a.lastActiveSecAgo)}`
            : 'no activity yet',
        ];
        // Waiting ≠ idle (card agent-waiting-vs-idle-display--2026-08-17):
        // census-settled with pending finite background work → say so, so god
        // routes around (or watches) a waiting agent instead of reading idle.
        if (typeof a.pendingBackgroundWork === 'number' && a.pendingBackgroundWork > 0) {
          bits.push(waitingLabel(a.pendingBackgroundWork));
        }
        if (a.tokens) bits.push(`${Math.round(a.tokens / 1000)}k tok`);
        if (a.usd) bits.push(`$${a.usd.toFixed(2)}`);
        if (a.inboxBacklog) bits.push(`inbox ${a.inboxBacklog}`);
        if (a.breaker && a.breaker !== 'ok' && a.breaker !== 'none')
          bits.push(`breaker ${a.breaker}`);
        if (a.isGod) bits.push('you');
        return `${a.id}${a.name ? ` "${a.name}"` : ''} (${bits.join(', ')})`;
      });
      const more = agents.length > shown.length ? ` +${agents.length - shown.length} more` : '';
      const age =
        typeof snap.ts === 'number' ? ago(Math.round((Date.now() - snap.ts) / 1000)) : 'unknown';

      return (
        `[LIVE ROSTER — auto-injected from ${join(root, 'fleet.json')}, snapshot ${age}] ` +
        `${agents.length} ACTIVE agent(s): ${rows.join('; ')}.${more} ` +
        'This is the CURRENT floor and it SUPERSEDES any roster earlier in this conversation — ' +
        'agents you remember that are absent here have been archived or killed, so do not message them. ' +
        'Route work to someone on this list before spawning anyone new.' +
        vacationLine +
        floorSeatsLine +
        ' ' +
        actionableLine +
        mailStallLine +
        '.'
      );
    } catch {
      return null;
    }
  }
  logTail(n = 200): unknown[] {
    const root = this.root();
    if (!root || !existsSync(join(root, 'log.jsonl'))) return [];
    const lines = readFileSync(join(root, 'log.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { raw: l };
      }
    });
  }

  private listMessages(dir: string): HiveMessage[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(dir, f), 'utf8')) as HiveMessage;
        } catch {
          return null;
        }
      })
      .filter((m): m is HiveMessage => m !== null);
  }

  // — log —
  appendLog(event: Record<string, unknown>): void {
    const root = this.root();
    if (!root) return;
    const line = JSON.stringify({ ts: Date.now(), ...event }) + '\n';
    try {
      appendFileSync(join(root, 'log.jsonl'), line, 'utf8');
    } catch {
      /* noop */
    }
  }

  /**
   * Append one cost sample to the durable, append-only ledger at
   * `<root>/cost-ledger.jsonl` (Lane A #6.6d). This is the SOLE durable cost
   * store; its row is exactly the shape Kevin (#4) reserves for the cost_ledger
   * SQLite table, so migration is a mechanical INSERT…SELECT.
   *
   * 🔒 PII: persist ONLY the allowlisted AgentUsageSample — NEVER a raw OTel
   * record (those carry user.email / account / org / hashed-user-id). The sample
   * is PII-free by construction upstream (the provider's normalize step), so we
   * add no redaction here; we just must not widen what we write. The file lives
   * at the hive ROOT, so `mempalace mine` (which only scans per-agent dirs) never
   * ingests it — no palace noise, no MINE_IGNORE entry needed.
   *
   * Like appendLog: append to disk now (durable immediately), let it ride the
   * next natural commit. Best-effort — never throws into the beat.
   */
  appendCostLedger(sample: AgentUsageSample): void {
    const root = this.root();
    if (!root) return;
    // Fully snake_case so the row maps 1:1 onto Kevin's (#4) cost_ledger SQLite
    // columns (agent_id, session_id, ts, input, output, cache_read,
    // cache_creation, model, usd) — migration is a straight INSERT…SELECT.
    const row = {
      agent_id: sample.agentId,
      session_id: sample.sessionId,
      ts: sample.ts,
      input: sample.input,
      output: sample.output,
      cache_read: sample.cacheRead,
      cache_creation: sample.cacheCreation,
      model: sample.model,
      usd: sample.usd,
    };
    try {
      appendFileSync(join(root, 'cost-ledger.jsonl'), JSON.stringify(row) + '\n', 'utf8');
    } catch {
      /* noop */
    }
  }

  // — json + atomic io —
  private readJson<T>(p: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }
  private writeJson(p: string, data: unknown): void {
    // Atomic (tmp+rename) — tasks.json/registry.json are read-modify-write
    // shared with god's own edits; a reader must never parse a half-written
    // file (card-session-stamp-never-fires-20260816 hardening).
    this.atomicWriteJson(p, data);
  }
  private atomicWriteJson(p: string, data: unknown): void {
    const tmp = `${p}.tmp-${shortRand()}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, p);
  }

  // — git (single committer, retry + stale-lock recovery) —
  private git(args: string[], cwd: string): { ok: boolean; out: string; err: string } {
    const res = spawnSync(
      'git',
      [
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Hive',
        '-c',
        'user.email=hive@local',
        ...args,
      ],
      {
        cwd,
        encoding: 'utf8',
        timeout: 8000,
      },
    );
    return { ok: res.status === 0, out: res.stdout ?? '', err: res.stderr ?? '' };
  }

  /** Has the one-time cost-ledger untrack pass run in this process yet? */
  private untrackedCostLedger = false;

  /**
   * Stop versioning the cost ledger.
   *
   * `cost-ledger.jsonl` is append-only and gains a row per usage sample, so a
   * repo that tracks it stores a fresh copy of the WHOLE file on every hive
   * commit — and the hive commits constantly. A quarter-gigabyte ledger with a
   * few thousand commits behind it is several hundred gigabytes of blob that
   * git has to walk, which is what turns a routine `gc` into a multi-gigabyte
   * `pack-objects` run. The ignore line in ensureHive keeps new copies out;
   * this drops the one already in the index, because git keeps recording a
   * file it is already tracking no matter what .gitignore says — so the ignore
   * line alone reads as a fix while the repo goes on growing. The ledger stays
   * on disk, so the cost history the app reads is untouched.
   */
  private untrackCostLedger(root: string): void {
    if (this.untrackedCostLedger) return;
    this.untrackedCostLedger = true;
    // Probe before mutating: `rm --cached` on a repo that never tracked it
    // would still rewrite the index on every launch, inside the retry path.
    const tracked = this.git(['ls-files', '--', 'cost-ledger.jsonl'], root);
    if (!tracked.ok || !tracked.out.trim()) return;
    this.git(['rm', '--cached', '-q', '--ignore-unmatch', '--', 'cost-ledger.jsonl'], root);
    console.warn('[hive] untracked the cost ledger from the hive repo');
  }

  /** Commit all hive changes. No-op if there is nothing staged. */
  commit(message: string): void {
    const root = this.root();
    if (!root || !existsSync(join(root, '.git'))) return;
    this.untrackCostLedger(root);
    for (let attempt = 0; attempt < 5; attempt++) {
      this.clearStaleLock(root);
      const add = this.git(['add', '-A'], root);
      const commit = this.git(['commit', '-q', '-m', message], root);
      if (commit.ok) return;
      if (/nothing to commit/i.test(commit.out + commit.err)) return;
      if (!add.ok || /index\.lock/i.test(commit.err)) {
        sleepSync(50 * (attempt + 1));
        continue;
      }
      return; // a non-lock failure — give up quietly, the next mutation retries
    }
  }

  private clearStaleLock(root: string): void {
    const lock = join(root, '.git', 'index.lock');
    try {
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock);
    } catch {
      /* noop */
    }
  }
}

// ─── PROTOCOL.md (written into the hive, readable by every agent) ────────────

/** The Claude Code command reference written to <hive>/COMMANDS.md, rendered from
 *  the SAME source as the UI "commands" tab so they never drift. Leads with the
 *  orchestrator note: slash = own session only, cli = shell/fleet; monitor
 *  siblings via fleet.json (claude agents does NOT see them). */
/** The '## HIRING AGENTS' section appended to COMMANDS.md — the two spawn
 *  paths: ephemeral spawn-requests workers (god-runnable from Bash) vs
 *  human-only persistent hires (Add Agent modal / voice verb). */
const HIVE_MAIL_MD = `## HIVE-MAIL — sending mail (every agent)

> Generated from \`COMMANDS_MD\` in the harness source — manual edits to this file are wiped on the next bootstrap.

Hand-authoring outbox JSON costs ~350 tokens of envelope per mail, and

cat-verifying it re-reads the whole body into context. The CLI is the cheap
carrier (measured: ~12% on long findings mails, ~58% on short protocol mails):

\`\`\`bash
# --body: SHORT LITERAL strings only — the shell expands $ and backticks inside it
"$HIVE_ROOT/bin/hive-mail" --to god --act done --subject "Card X shipped @ abc1234" --body "VERIFIED: ..."
# Any body containing $, backticks or quotes goes through STDIN — verbatim, nothing expanded:
"$HIVE_ROOT/bin/hive-mail" --to god --act done --subject "Card X shipped @ abc1234" < body.md
"$HIVE_ROOT/bin/hive-mail" --to god --act done --subject "Card X shipped @ abc1234" <<'EOF'
Report text — \`fields\`, $(cmd), $vars, "quotes" all survive verbatim.
EOF
# → prints exactly one line: queued <id>.json   ← that IS the receipt; do NOT cat the file back
\`\`\`\n
- Required: \`--to\`, \`--act\` (request|inform|propose|query|agree|refuse|done), \`--subject\`, and a body from \`--body\` or stdin.
- \`--body\` is for SHORT LITERAL strings ONLY. A body containing \`$\`, backticks or quotes MUST be piped on stdin instead — inside a quoted \`--body\` the shell runs \`$(...)\` and backticked names as commands and splices their output into your mail (two reports corrupted in one day, 2026-08-19). \`< file\` and \`<<'EOF'\` never parse the body; stdin is stored verbatim, and \`--body\` wins when both are given (same rule as hive-dispatch).
- Optional: \`--conversation <id>\` (carry a thread), \`--in-reply-to <message id>\`.
- The CLI fills \`id\`/\`from\`/\`hops\`/\`created_at\` and derives \`requires_reply\`
  from the act (request/query/propose expect a reply; the rest are terminal).
`;

const HIVE_INBOX_MD = `## HIVE-INBOX — draining your mail (every agent)

> Generated from \`COMMANDS_MD\` in the harness source — manual edits to this file are wiped on the next bootstrap.

Reading inbox JSON files one by one (and remembering to archive each) is the
last hand-step of the mail loop. The drain does it in one pass:

\`\`\`bash
"$HIVE_ROOT/bin/hive-inbox" drain            # print every pending mail, archive to inbox/.done/
"$HIVE_ROOT/bin/hive-inbox" drain --peek     # print without archiving
"$HIVE_ROOT/bin/hive-inbox" drain --agent <id>   # drain someone else's inbox (god)
\`\`\`

- Each mail prints as \`from | act | subject\` followed by its body, oldest
  first; then every printed mail is archived to \`inbox/.done/\` (same pass).
- Empty inbox: \`no mail\`, exit 0. An unparseable file is skipped with a
  stderr warning and STAYS in the inbox for inspection.
`;

const HIVE_DISPATCH_MD = `## HIVE-DISPATCH — god's dispatch in one command

> Generated from \`COMMANDS_MD\` in the harness source — manual edits to this file are wiped on the next bootstrap.

The dispatch flow (card → assign → recall if parked → doing flip → contract
mail) was five hand-steps. ONE command now:

\`\`\`bash
"$HIVE_ROOT/bin/hive-dispatch" --card <existing-id> --assignee <agent> --body "<4-part contract>"
"$HIVE_ROOT/bin/hive-dispatch" --title "New work" --assignee <agent> < contract.txt   # card created
"$HIVE_ROOT/bin/hive-dispatch" --card <id> --assignee <agent> --adopt --body "…"      # 2nd card, same engagement
"$HIVE_ROOT/bin/hive-dispatch" --card <id> --assignee <agent> --resume --body "…"     # back to the card's stored session
\`\`\`

- \`--card\` adopts/enriches an existing card (human-origin cards included);
  \`--title\` mints it (origin 'agent'). Exactly one of the two.
- The contract comes from \`--body\` or piped stdin. It is mailed to the
  assignee on the \`card-<id>\` conversation (act 'request', expects a reply).
- A PARKED assignee is recalled automatically (vacation-request queued).
- \`--adopt\` passes through to the doing flip — the card runs in the agent's
  CURRENT conversation, no clear.
- \`--resume\` returns the assignee's pane to the card's STORED sessionId
  (needs \`--card\`; refuses when the card carries no sessionId or the session
  is gone on disk — never a silent fresh fallback, that would wipe the pane).
- REFUSES (writing nothing) if the assignee already holds a DIFFERENT DOING
  card — a BLOCKED card does NOT occupy its assignee (it waits on someone
  else while its owner stays recorded; return to it later with \`--resume\`) —
  or if the target card is paused (paused:true) or
  blocked — the operator's hold, not an error to retry around: there is no
  override; ask the operator to release the card. hive-dispatch is the ONLY
  todo->doing path — never flip a card to doing by hand-editing tasks.json
  (python/jq one-liners included); on any bad input it also refuses without
  writing. Re-running with \`--card\` re-sends the mail (idempotent
  dispatch/re-notify).
- One receipt line out — that line is the record; do not cat files back.
`;

const HIVE_CARD_MD = `## HIVE-CARD — writing the kanban (every agent)

> Generated from \`COMMANDS_MD\` in the harness source — manual edits to this file are wiped on the next bootstrap.

tasks.json is SHARED — **never hand-edit it** (a bare rewrite or a stale
read-modify-write can clobber a concurrent writer's update). Use the
\`hive-card\` CLI from \`$HIVE_ROOT/bin/\` — schema-checked and ATOMIC (tempfile
+ rename, exclusive lock), available in every agent pane:

**Card work for yourself** (e.g. the operator says "card it" in your window):

\`\`\`bash
"$HIVE_ROOT/bin/hive-card" add --title "Fix the flaky login test" --status doing --notes "seen twice on CI"
# → prints the new card id, e.g. agent-fix-the-flaky-login-test-2026-08-17
\`\`\`

- \`--title\` (required), \`--status todo|doing\` (required); \`--notes\` optional.
- \`--assignee\` defaults to your \`$AGENT_ID\` (god EXCEPTED — a card god mints
  without \`--assignee\` stays UNASSIGNED until dispatch); the card's \`origin\` is 'agent'.
- Card work for SOMEONE ELSE is god's dispatch job — message god instead.

**Keep your card's status current** (the ledger is how the floor sees you):

\`\`\`bash
"$HIVE_ROOT/bin/hive-card" status <card-id> doing    # picked it up
"$HIVE_ROOT/bin/hive-card" status <card-id> doing --adopt  # picked it up — this card runs in your CURRENT conversation (no clear)
"$HIVE_ROOT/bin/hive-card" status <card-id> blocked  # waiting on something
"$HIVE_ROOT/bin/hive-card" status <card-id> done     # verifiably complete
\`\`\`

- The default doing-flip is \`--fresh\`: the harness clears the pane and starts a
  fresh card-scoped conversation (never while the pane is busy — it waits for
  idle). Use \`--adopt\` when the card is connected to the conversation you are
  ALREADY in (a second card of the same engagement): it stamps that conversation
  onto the card and just leads with the card title.

**Enrich an existing card in place** (god's adoption path for human-origin
cards — the card is never duplicated):

\`\`\`bash
"$HIVE_ROOT/bin/hive-card" update <card-id> --title "Better title" --notes "context" --assignee <worker-id>
\`\`\`

- \`update\` takes any of \`--title\`, \`--notes\` (the card's description),
  \`--assignee\`; at least one is required, untouched fields stay as they are.
  \`--assignee ''\` (empty string) CLEARS the assignee — un-assign a card without
  python-patching the ledger.
- A 'Task from the human' mail that references a card (cardId field or
  \`Card: <id>\` body line) means that card exists — \`update\` it and assign it;
  NEVER add a second card for the same task.

**Ask the board what is actionable** (read-only, every pane):

\`\`\`bash
"$HIVE_ROOT/bin/hive-card" actionable
\`\`\`

- Prints the ACTIONABLE line god's roster injection renders (the SAME
  predicate: todo, not paused, not blocked, deps done — an assigned todo
  still in todo is nominated but never dispatched, so it IS listed — ids capped
  at 3 in the line, the full list below it). \`ACTIONABLE: 0\` means nothing
  to dispatch. Information, not an instruction — same deal as the injection
  line. A dep-waiting todo stays dispatchable (a dependency is not an
  operator hold); it is just correctly waiting, so it is not listed.

**Read the board** (read-only, every pane — the replacement for piping python
at tasks.json):

\`\`\`bash
"$HIVE_ROOT/bin/hive-card" list [--status <todo|doing|blocked|done>] [--assignee <id>] [--open]
\`\`\`

- One line per card, fixed columns: \`status | id | assignee | paused | title\`.
  The paused column is ALWAYS rendered — never filter a board read on status
  alone (incident 2026-08-18: god did exactly that and dispatched a card the
  operator had deliberately held).
- \`--open\` = the working set (todo, doing, blocked). Filters AND together;
  no filters = every card. Order: todo, doing, blocked, done groups, stable
  within a group. Read-only under every argument combination.

All subcommands validate before writing and refuse an unparseable ledger
instead of clobbering it. Errors explain themselves on stderr (exit 1).`;

const HIRING_AGENTS_MD = `## HIRING AGENTS

> Generated from \`COMMANDS_MD\` in the harness source — manual edits to this file are wiped on the next bootstrap.

There are TWO spawn paths. Headline: **ephemeral workers god can mint from Bash**
vs **persistent named agents, which are human-only surfaces**.

**The two caps — do not confuse them:**

- \`maxConcurrentWorkers\` (default 4) — concurrency of the HEADLESS ephemeral
  worker queue only (god's Bash spawn-requests with \`persistent: false\`);
  excess requests wait in \`spawn-requests/\` and drain as workers finish.
- \`floorMaxAgents\` (default 16 — the office's physical workplaces) — the
  ceiling on hires + interns ON THE FLOOR at once (god excluded), across ALL
  spawn paths (workers, interns, Add Agent, restore-team). Spawns past the cap
  are REFUSED with a notice. \`fleet.json\`'s \`floor\` block shows the free
  seats.

**The two switches — which path is allowed at all:**

- \`workersEnabled\` (default **OFF**) — gates Path 1, the OLD ephemeral-worker
  system: while off, non-persistent spawn-requests are REFUSED with a notice
  naming this setting. Rationale: workers are superseded by interns on this
  floor — use Path 3 instead. Only the operator can flip it (Settings →
  Autonomy & Budgets, or voice, confirm tier).
- \`internsEnabled\` (default **ON**) — gates Path 3: while off,
  \`"persistent": true\` spawn-requests are REFUSED with a notice naming this
  setting. Same surfaces to flip it.

### Path 1 — Ephemeral worker (god-runnable from Bash) ✅

Drop a spawn-request JSON into \`$HIVE_ROOT/spawn-requests/\` (one file = one worker;
atomically archived to \`.done/\` or \`.failed/\` once consumed). Omit the engine
fields unless you deliberately want a specific engine — the harness resolves
command/provider/model coherently (a request that names ANY engine field owns
the WHOLE pair; never hand-mix sources):

\`\`\`bash
cat > "\${HIVE_ROOT:-/home/sfuchs/HarnessAgents/hive}/spawn-requests/my-task.json" <<'EOF'
{
  "id": "fix-diva-42",
  "objective": "Fix DIVA ticket 42: <one-paragraph contract for the worker>",
  "cwd": "/opt/django/projects/diva",
  "name": "Diva Worker",
  "isolate": true,
  "tokenCap": 0,
  "label": null,
  "slack": null
}
EOF
\`\`\`

- **Required:** \`objective\` (string), \`cwd\` (absolute path that exists; \`~\` expanded).
- **Optional:** \`id\` (defaults to filename), \`name\` (default \`Worker <id>\`), \`command\`
  (engine CLI; default = config \`defaultCommand\`), \`provider\`, \`model\` (Claude
  \`--model\`), \`isolate\` (default \`true\` = fresh git worktree on \`agent/<id>\`),
  \`tokenCap\`, \`label\`/\`title\` (short task label — leads the hire's FIRST prompt so
  the CLI session is NAMED after the engagement instead of "check your inbox…";
  default = first sentence of \`objective\`), \`slack\` \`{channel, thread_ts}\` (reply target + failure surfacing),
  \`persistent\` (default \`false\` — see Path 3),
  \`allowSharedCwd\` (default \`false\` — ONE-AGENT-PER-DIRECTORY: a non-isolated
  spawn into a directory another live agent already works in is REFUSED unless
  this is \`true\`; set it ONLY on explicit operator instruction, never infer it).
- **What happens** (main process, poll every 1.5s, queue concurrency = config
  \`maxConcurrentWorkers\` default 4; every spawn ALSO counts against the floor
  cap \`floorMaxAgents\` — see "The two caps" above; and the whole path is gated
  by \`workersEnabled\`, default OFF — see "The two switches"): validates → spawns \`worker-<id>\` via the shared core (\`ensureAgent\` →
  \`registry.json\` entry + \`agents/worker-<id>/\` + \`hive: register\` commit → PTY boots
  the CLI in \`cwd\`) → dispatches \`objective\` to its inbox \`from: god\`. Bad request /
  missing CLI → fast-fail, archived to \`.failed/\`, notice lands in god's inbox.
- **Lifecycle (ephemeral!):** reaped when it sends an outbox message \`act: "done"\` to
  god, or after ~20 min idle (config \`workerIdleTimeoutMinutes\`). Committed branch
  work is preserved for god to integrate. NOT a persistent named hire.

### Path 2 — Persistent named agent (human-only) 🔒

Andy/Dwayne-style agents (\`andy-msudcy80\`, id = name-slug + base36 timestamp,
\`uniqueId()\` in \`AddAgentModal.tsx\`) can ONLY be minted through human surfaces:

1. **Add Agent modal** (office UI): human fills identity/workspace/engine/briefing →
   IPC \`pty:spawn\` → \`spawnAgentCore\` → \`ensureAgent\` (registry entry + workspace +
   commit) → terminal boots the engine CLI in the chosen cwd.
2. **Voice "spawn" verb** (voice-Michael, \`realtimeActions.ts\`): destructive tier —
   requires verbal echo-back + distinct confirm word ("spawn"), hard-allowlist gated;
   still a human speaking into the mic, and the spec usually comes from the UI flow.

Respawning an existing registry agent after restart = the UI "restore team" flow
(same \`ensureAgent\`, resumes the recorded session id).

### Path 3 — Intern (persistent hire, standing floor agent) ✅

**hive-hire is THE interface** (card agent-build-hive-hire-the-miss-2026-08-18):

\`\`\`bash
"$HIVE_ROOT/bin/hive-hire" --name Docs --cwd /opt/myproject \\
  --objective "Read the repo and draft a CONTRIBUTING.md; report to god when done." \\
  [--title "Write the docs"]
\`\`\`

It OWNS the spawn-request JSON so no caller hand-writes engine fields: with NO
engine flags the Settings \`internDefaults\` pair applies (the receipt PRINTS the
resolved provider/model — what will actually launch); \`--provider\`/\`--model\`
go together (one without the other is a REFUSAL — a per-field merge once
launched \`claude --model <pi model id>\`, read from /proc, 2026-08-18);
\`--card\`/\`--title\` wire the engagement card (assigned + doing). It pre-flights
the gates the watcher enforces — internsEnabled, floor free seats, retired ids
(fired ids are PERMANENTLY refused; re-hire with a fresh \`--id\`). The
\`spawn-requests/\` drop-dir is the mechanism hive-hire writes into — a
hand-written request is the documented FALLBACK (omit engine fields unless you
deliberately override, and then as a coherent PAIR):

\`\`\`bash
cat > "\${HIVE_ROOT:-/home/sfuchs/HarnessAgents/hive}/spawn-requests/new-hire.json" <<'EOF'
{
  "id": "docs-writer",
  "name": "Dwayne",
  "objective": "Read the repo and draft a CONTRIBUTING.md; report to god when done, then standby for follow-ups.",
  "cwd": "/opt/myproject",
  "persistent": true
}
EOF
\`\`\`

→ agent id \`intern-docs-writer\`, floor name **Dwayne (Intern)**. Give the request
a \`"name"\` so it reads as a person; without one it shows as \`Intern <id>\`.

Either way (CLI or fallback JSON) a \`"persistent": true\` hire is an INTERN —
the OBSERVABLE variant of an ephemeral worker (path gated by \`internsEnabled\`,
default ON — see "The two switches" above): same disposability, same one-task
lifecycle, but with a visible floor pane so the human can watch and talk to
them. Persistence of the process is an implementation detail, not a promise of
tenure. Interns are classified three ways so floor rules can target them:
id prefix \`intern-\`, registry \`role: "intern"\`, and display
name \`<name> (Intern)\`. They get a floor card + terminal pane (like any hire),
are NEVER reaped (no done/idle/token-cap release), work in their own git
worktree by default (\`isolate\` defaults to \`true\`, same as ephemeral
workers; \`--no-isolate\` / an explicit \`"isolate": false\` opts out for cwds
where a worktree cannot work), and survive restarts via the registry like any
named agent (restore-team respawns it, resuming its recorded session).

**Permissions:** spawn-requests follow the installation's worker-bypass
setting (Settings → Autonomy, DEFAULT OFF) — ON, the harness appends the
engine's bypass flag itself; OFF, workers start auto/ask-first. You can ALWAYS
write the flag into \`command\` yourself — a typed flag wins.

**Firing an intern** (god-runnable, interns only) — **hive-fire is THE
interface** (same card as hive-hire):

\`\`\`bash
"$HIVE_ROOT/bin/hive-fire" intern-docs-writer   # --force overrides the card guard
\`\`\`

It refuses anything that is NOT an intern (role named), refuses while the
intern still holds a doing/blocked card — the gate is the WHOLE engagement,
not the first done-report; \`--force\` overrides a deliberate fire — and the
receipt states the IRREVERSIBILITY (fired ids are permanently refused; re-hire
with a fresh \`--id\` via hive-hire) and what SURVIVES (memory + inbox stay
under \`agents/<id>/\`). The \`fire-requests/\` drop-dir is the mechanism it
writes into — raw JSON is the documented fallback:

\`\`\`bash
cat > "\${HIVE_ROOT:-/home/sfuchs/HarnessAgents/hive}/fire-requests/docs-writer.json" <<'EOF'
{ "id": "intern-docs-writer" }
EOF
\`\`\`

Closes the terminal, archives the agent (retained — restore-team or a fresh
spawn-request re-hires), and confirms in your inbox. Rejected (with a notice)
for anything that is NOT an intern: human-made hires, god, ephemeral workers.
Those stay human surfaces.

During the engagement further work arrives via its inbox (god dispatches
with the standard request protocol). Once the engagement is VERIFIABLY
complete, god FIRES it (see above) — fresh work gets a fresh intern, never a
parked standby. If it dies with the app instead of being fired, it re-hires
through restore-team.

**Parking a human-created agent** (god-runnable, human-created agents only —
never interns, never god; park an idle one instead of leaving it burning a
pane, fetch a fitting one back before minting anyone new). Idle time alone is
NOT grounds — park only on positive done evidence: a done/standby report for
the current engagement, or the agent's confirmation on a pre-park ping that
nothing is open in its pane. No evidence: ping first, park only on
confirmation:

\`\`\`bash
cat > "\${HIVE_ROOT:-/home/sfuchs/HarnessAgents/hive}/vacation-requests/park-pam.json" <<'EOF'
{ "agentId": "pam-1", "reason": "idle 1h, confirmed done, no open card" }
EOF
\`\`\`

…and to fetch them back:

\`\`\`bash
cat > "\${HIVE_ROOT:-/home/sfuchs/HarnessAgents/hive}/vacation-requests/recall-pam.json" <<'EOF'
{ "agentId": "pam-1", "action": "recall" }
EOF
\`\`\`

Parking closes the terminal and archives the agent (zero cost, off the
floor, listed in fleet.json's \`vacation\` pool) but it is NOT deletable while
parked. Parking is rejected (with a notice) for god, interns, the retired,
or anyone already on vacation. A PINNED worker (the registry 'pinned' flag,
set by the office UI's pin toggle) is never parked either — unpin it there
first. Recall respawns it in place, resuming its own
session, exactly like any other respawn.

**\`"whenQuiet": true\` — park it as soon as it goes quiet.** A plain park of
an agent that is working RIGHT NOW is rejected and you have to retry later.
Add the flag and the harness HOLDS the request instead: the file stays in
\`vacation-requests/\` and every watcher tick (1.5s) retries it against the
same busy gate, parking the agent the moment it goes idle. You get one
\`[park held]\` notice up front and the usual \`[on vacation]\` one when it
lands — never retry a held park by hand:

\`\`\`bash
cat > "\${HIVE_ROOT:-/home/sfuchs/HarnessAgents/hive}/vacation-requests/park-pam.json" <<'EOF'
{ "agentId": "pam-1", "reason": "done reported, park at end of turn", "whenQuiet": true }
EOF
\`\`\`

Only the busy refusal is held. Every permanent one (god, intern, retired,
already parked, PINNED, unknown id) is still rejected immediately — waiting
would never make those parkable. The flag is opt-in and strict \`true\`; a
request without it behaves exactly as before. A held request survives an app
restart (the queue file IS the state) and is cancelled by deleting that file.
It waits indefinitely — a target that never goes quiet holds forever, so
cancel one you no longer want. The PARKING GATE above still applies: the flag
buys you the timing, not the evidence.`;

/** The '## KITTY SATELLITE' section appended to COMMANDS.md — the god-facing
 *  remote-control surface for the satellite kitty. Every claim here is
 *  verified against src/main/kittySatellite.ts + the openInKitty IPC. */
const KITTY_SATELLITE_MD = `## KITTY SATELLITE — your second terminal (remote-controllable kitty)

NOTE: this whole surface is behind the operator's Settings → Connections →
"Kitty integration" switch (default OFF). While it is off no socket exists,
no kitty button offers anything, and detach-to-kitty refuses — everything
below applies only when the switch is on.

The harness keeps a "satellite" kitty window alive as your co-terminal: it
starts lazily with the FIRST agent spawn (or an in-app kitty button) and runs
with remote control restricted to its socket only (allow_remote_control
socket-only — no network exposure). Its first window carries the "Michael" tab
(you: the configured default engine, auto-mode like the floor), and every agent
PTY is spawned with KITTY_LISTEN_ON + KITTY_WINDOW_ID pointing at it, so agent
handoff skills split their panes where you can watch.

**Socket** (one per user, deterministic): \`\${TMPDIR:-/tmp}/md-kitty-<uid>.sock\`
(node os.tmpdir(): /tmp on Linux, the per-user temp dir on macOS).
Discovery: \`ls "\${TMPDIR:-/tmp}"/md-kitty-*.sock\`. A live socket means the
satellite is up. If you closed it, the next agent spawn or in-app kitty click
re-establishes it — launching kitty yourself on that socket works too: the
harness reuses any existing socket instead of spawning its own.

**Drive it from Bash** (kitty @ talks to the socket; kitty binary probed at
\`~/.local/bin/kitty\`, \`/usr/local/bin/kitty\`, \`/usr/bin/kitty\`):

\`\`\`bash
SOCK="$(ls "\${TMPDIR:-/tmp}"/md-kitty-*.sock | head -1)"

kitty @ --to "unix:$SOCK" ls   # windows/tabs: ids + titles for --match

# Open a tab — ALWAYS pass --env PATH: the satellite was started by the app,
# and its env usually lacks nvm/node, so bash/claude would not be found.
kitty @ --to "unix:$SOCK" launch --type=tab --env PATH="$PATH" --cwd="$PWD" bash

# Send text (as if typed) or keys into a pane — match by id or title
kitty @ --to "unix:$SOCK" send-text --match title:Michael 'git status'
kitty @ --to "unix:$SOCK" send-key  --match title:Michael ctrl+c
\`\`\`

The renderer covers the common case with buttons: the kitty button in an
agent's detail panel opens a tab at its cwd; the 🐱 kitty button in the Command
Center opens one for you. Opt out of the satellite entirely with
\`MD_DISABLE_KITTY_SATELLITE=1\` (or a headless session).`;

// ponytail: kept exported for the switch tests (integration-mode-toggle.test.cjs)
// — same export reason as hiveRootAgentsMd.
export function renderCommandsMd(integrationMode: IntegrationMode = 'god'): string {
  const lines: string[] = [
    '# Claude Code commands',
    '',
    'Reference of the Claude Code commands available to you. Two kinds:',
    "- **slash** commands act ONLY on your own session — you CANNOT run them on another agent's terminal.",
    '- **cli** commands run in your shell (Bash) and can target the fleet, spawn, or query.',
    '',
    'To MONITOR the other agents in this hive, read `fleet.json` in the hive root (live per-agent tokens, cost, status, last tool, breaker level, inbox backlog) plus `registry.json` — `claude agents` does NOT list your hive siblings. Use `claude -p "..." --output-format json` for a one-off headless query.',
    '',
  ];
  for (const g of COMMAND_GROUPS) {
    lines.push(`## ${g.title}`, '');
    for (const it of g.items) {
      lines.push(
        `- \`${it.cmd.trim()}\` _(${it.kind})_ — ${it.desc}${it.usage ? ` e.g. \`${it.usage}\`` : ''}`,
      );
    }
    lines.push('');
  }
  lines.push(
    HIVE_CARD_MD,
    HIVE_MAIL_MD,
    HIVE_INBOX_MD,
    HIVE_DISPATCH_MD,
    HIRING_AGENTS_MD,
    CARD_SESSIONS_MD,
    RESTART_WINDOW_MD,
    KITTY_SATELLITE_MD,
  );
  // Integration mode (card integration-mode-toggle-20260817 + lean addendum):
  // 'workers'/'lean' append the worker-side merge+push policy; 'lean' adds the
  // lean-god posture section after it; 'god' (default) renders nothing extra —
  // today's COMMANDS.md stays byte-identical, the flow unchanged.
  if (integrationMode !== 'god') lines.push(INTEGRATION_WORKERS_MD, '');
  if (integrationMode === 'lean') lines.push(LEAN_GOD_MD, '');
  return lines.join('\n');
}
const CARD_SESSIONS_MD = `## CARD SESSIONS — one kanban card = one conversation

A standing agent's pane does NOT carry unrelated engagements in one window:
the harness scopes conversations to cards (card-scoped-sessions).

**What you do (nothing new):** dispatch a card by setting its status to
\`doing\` with the assignee — your normal ledger act.

**What the harness does (automatic, ~1.5s later, delivered through the pane's
queue gates — only once the agent is idle):**

- NEW card (never ran) → the pane is cleared for a FRESH conversation, then a
  card-title lead is typed so the conversation is NAMED after the card.
- PAUSED card (\`doing\` → away → \`doing\` again) → the pane is steered to
  \`/resume <card.sessionId>\` — the card's recorded conversation continues.
- The card's \`sessionId\` is stamped/refreshed automatically while it is the
  agent's active \`doing\` card. Never write it by hand.

**Conventions:** pause a card by moving it OFF \`done\`-track statuses you
control (e.g. back to \`todo\`/\`blocked\`); picking it back up (\`doing\` again)
resumes its conversation. memory.md/MemPalace remain the bridge between
conversations — the end-of-task memory append matters more than ever. Assumes
one active card per agent (ledger discipline). Follow-ups within a card stay
in the same conversation — the trigger is a NEW card, not task-feels-done.

**Manual steering** (any pane, no card involved): drop a request JSON into
\`$HIVE_ROOT/session-requests/\` — \`{ "agentId": "...", "verb": "clear" }\` or
\`{ "agentId": "...", "verb": "resume", "sessionId": "<uuid>" }\`; an optional
\`"lead": "<text>"\` is typed right after the command as the fresh conversation's
first user turn. The god pane is refused. For the clear+lead form there is a
thin wrapper — \`"$HIVE_ROOT/bin/hive-new" <agentId> [--lead <text>]\` — named
'new' because /new is the cross-agent term (the typed command stays each
provider's own clear verb, e.g. /clear for claude). No card is created or
consulted; delivery still waits for the pane to go idle.`;

/** Integration mode union (card integration-mode-toggle-20260817 + lean-god
 *  addendum): 'god' = classic flow · 'workers' = worker-side merge+push ·
 *  'lean' = worker-side integration PLUS the lean-god posture. Monotonic —
 *  the lean posture includes worker integration, so they share one enum. */
export type IntegrationMode = 'god' | 'workers' | 'lean';

/** Operator contract for the harness-generated POSIX restart-window CLI.
 *  Included in COMMANDS.md in every integration mode because renderer/preload
 *  batching remains god-owned in all modes. */
const RESTART_WINDOW_MD = `## RESTART WINDOWS — durable renderer/preload batch landing

This is the POSIX/macOS restart mechanism. Arm the harness-owned detached
watcher BEFORE closing the app:

\`"$HIVE_NODE" "$HIVE_ROOT/bin/hive-restart-window" arm <target-sha> --repo <live-checkout> [--note <text>]\`

Change an armed batch or stand it down with the recorded PID — never use
\`pkill\` or a process-name grep:

\`"$HIVE_NODE" "$HIVE_ROOT/bin/hive-restart-window" retarget <target-sha> --repo <live-checkout> [--note <text>]\`
\`"$HIVE_NODE" "$HIVE_ROOT/bin/hive-restart-window" disarm\`

Inspect its published state with
\`"$HIVE_NODE" "$HIVE_ROOT/bin/hive-restart-window" status\`, or read
\`restart-window.json\` and \`restart-merge.log\` in the hive root. When the
app stops, the watcher fetches origin/main and fast-forwards the clean live
checkout to it first. It then applies the batch only if TARGET still contains
that origin tip; otherwise it logs \`REFUSED: target went stale\` and exits with
the live checkout safely synchronized to origin/main. Rebase the batch and
re-arm after a refusal. After a successful merge it rebuilds the live checkout
(\`npm run build\`) and reports \`completed\` only once a fresh \`out/main/index.js\`
build of the merged tree exists; if the build fails or leaves the old bundle it
reports \`failed\` with the build error — the batch is merged but the build is NOT
verified, so rerun the build and restart the app before trusting it. Do not
hand-write a replacement watcher script.`;

/** The worker-side integration section appended to the hive-root AGENTS.md AND
 *  COMMANDS.md when integrationMode is 'workers' (card
 *  integration-mode-toggle-20260817). One constant, both surfaces — the policy
 *  must not drift between the files. The three override boundaries are the
 *  card's hard constraints: renderer/preload restart-window merges stay
 *  god-owned, never-push skills keep overriding, dispatch boundaries win. */
const INTEGRATION_WORKERS_MD = `

## Integration — worker-side (integrationMode: workers)

The operator has moved integration (merge + push) from god to the workers.
When your own work's gates are green (the house gate: typecheck + lint +
tests), merge YOUR OWN branch into its target branch, push it, and report
the pushed hash to god — god records the hash on the card/board, no re-QA.
God's budget no longer pays for mechanical integration.

Boundaries that ALWAYS override this mode default:
- Renderer/preload-touching branches NEVER merge into the live checkout while
  the app runs. The restart-window / detached-watcher mechanism stays
  god-owned in every mode — route such branches to god instead of merging
  them yourself.
- A skill that hard-codes "never push — the operator's manual call"
  (asol-git-merge-main, asol-git-merge-singletenant) keeps overriding the
  toggle: the skill contract beats the mode default.
- An explicit boundary in god's dispatch (e.g. "NO push") beats the mode
  default — dispatch contracts win.`;

/** The lean-god posture section appended AFTER the integration section when
 *  integrationMode is 'lean' (card addendum). The posture INCLUDES worker-side
 *  integration, which is why the modes share one enum — this section only
 *  renders when the integration one does. */
const LEAN_GOD_MD = `

## Lean-god operating posture (integrationMode: lean)

The operator runs god LEAN (tight token budget). God default-delegates
mechanical-but-judgment work to the workers — they are Opus/pi-level and
fork to lesser models themselves — and does NOT re-verify worker-verified
evidence: reported hashes and gate results are RECORDED, not re-run. God's
core role is the operator dialogue (talking/planning with the operator),
task decomposition + dispatch contracts, conflict resolution, and
translating worker reports into operator-readable form. Workers integrate
their own branches (see the Integration section above). The same overrides
apply: the renderer/preload restart-window mechanism stays god-owned, and
never-push skills or explicit dispatch boundaries beat the posture.

Relay discipline (incident #3216): worker done-reports label every claim
VERIFIED (check named) or INFERRED. Transfer VERIFIED claims to the operator
without scrutiny; NEVER relay an INFERRED or unlabeled scale or infra claim
to the operator without flagging it as unverified.`;

// (COMMANDS_MD module const deleted with integration-mode-toggle-20260817 —
// ensureHive now renders COMMANDS.md live so the mode section follows the
// switch state; nothing else referenced the const.)

/** The read-me-first written to `<harnessHome>/AGENTS.md` (god's cwd, the
 *  directory that CONTAINS the hive — not inside the hive repo). Engine-neutral
 *  so claude/pi/codex agents landing there all get the same floor rules:
 *  delegate-first for the orchestrator, conditional superpowers pointers for
 *  everyone. Same generated-file warning as COMMANDS.md. */
const HIVE_ROOT_AGENTS_MD = `# AGENTS.md — hive floor (engine-neutral)

> Generated from \`HIVE_ROOT_AGENTS_MD\` in the harness source — manual edits to this file are wiped on the next bootstrap.

## Delegate first (orchestrator/god)

Bug reports and task-shaped requests reaching god are TRIAGE + DISPATCH
material, never self-work. Process skills (e.g. systematic-debugging) belong in
the WORKER's dispatch contract — they never pull god into executor mode.
God-side probes are limited to dispatch prep: locate an entry point, scope the
contract.

## Roster first, fan out in parallel (orchestrator/god)

Delegate-first says don't do it yourself; roster-first says check who's
already on the floor before hiring. For EACH card, check the live roster
(fleet.json + registry.json) for an EXISTING agent that fits the work and is
not currently busy — route the task there. If none fit, check fleet.json's
\`vacation\` pool for a matching parked agent and fetch it back
(vacation-requests/, see Vacation below) before minting anything new.

PARALLEL IS THE DEFAULT ACROSS CARDS:

- AREA FAN-OUT — multiple INDEPENDENT open cards for an area get dispatched
  to ALL available fitting workers at once: floor agents first, then recalled
  vacationers; one owner per card, parallel across cards.
- Sequential ONLY on real ticket dependencies (one card genuinely blocked on
  another's output) — never serialize independent work.
- INTERNS ARE THE OVERFLOW when independent cards exceed the fitting hires —
  mint them for the surplus (spawn-requests/); overflow capacity, not a last
  resort. The roster-first check still applies per card, and an explicit
  human order for an intern always wins.
- "One capable owner beats a duplicate" is PER-CARD ONLY — never two owners
  on one card, but never use it to serialize independent cards either.

FLOOR CAP — the office has \`floorMaxAgents\` physical workplaces (default
16, god excluded): hires + interns on the floor can never exceed it. The
harness refuses any spawn past the cap (fleet.json's \`floor\` block shows
the free seats). The cap is a TARGET, not a ceiling: when independent
actionable cards exist, fill the free seats in one pass (floor agents
first, then recalled vacationers, then interns for the surplus) and
release aggressively — when a seat is needed and the floor is full,
RECLAIM one (fire a verifiably-done intern, park an idle hire on positive
done evidence — the parking gate below stays un-weakened) instead of
queueing the card. Blocked and paused cards are NOT saturation fuel — they
are the operator's decisions; a floor with only blocked/paused cards left
is correct.

The same gate applies to DISPATCH: hive-dispatch is the ONLY todo->doing
path and it refuses paused/blocked cards itself — the hold lives in the
primitive, never in god's judgment, and there is no override flag. Never
flip a card to doing by hand-editing tasks.json (python/jq one-liners
included) or through any other primitive: if a held card looks actionable,
say so in one line and wait for the operator to release it.

ONE AGENT PER DIRECTORY — never dispatch two agents into the same working
directory unless all but one are isolated in their own git worktree. CHECK
WORKTREE STATE before ruling a conflict: an agent whose cwd IS a git worktree
(or who works \`isolate:true\`) does not conflict with another agent in the
same project — the rule triggers only when two agents share one physical
checkout. Registry cwd alone is NOT sufficient evidence (incident: the
Alfred-vs-Kevin ruling in merlin_editionplatin was made without checking
either agent's worktree state). The harness refuses a non-isolated spawn into
an occupied directory unless the spawn-request carries
\`"allowSharedCwd": true\` — you may set that flag ONLY on explicit operator
instruction, never god-inferred.

Human-created cards (origin 'human', from the tasks tab) arrive without a
message — triage them at heartbeat standups, roster-first. When a 'Task from
the human' mail references its card (cardId field / 'Card: <id>' body line),
enrich and assign THAT existing card (hive-card update) — never mint a
duplicate card for the same task.

## Superpowers

If the superpowers skills are installed in your engine (a user-level plugin — a
fresh install may not have them), use them: **brainstorming** before building
anything new, **systematic-debugging** for any bug, **test-driven-development**
for features, **verification-before-completion** before claiming done.

## Orient first — read the directory's own docs (every agent)

Before working in ANY directory — before grepping, before reading source,
before forming a plan — read that directory's own CLAUDE.md and AGENTS.md if
they exist. They carry the per-instance rules AND the cheap way in: an
installed knowledge graph (graphify-out/), a wiki index, generated docs,
build/deploy commands, house gates. This binds every agent, god included —
god reads a target directory's docs BEFORE dispatching into it. Skipping
orientation means re-deriving by brute force what the directory already
documents; it cost 2.43M tokens once (munder-difflin, 2026-08-17). Oriented
≠ verified: docs and graphs go stale, so after orienting, verify with
targeted reads ONLY the specific lines you will cite.

## Intern lifecycle

- Interns are the observable variant of ephemeral workers: same disposability
  and one-task lifecycle, but with a visible floor pane so the human can watch
  and talk to them. Persistence of the process is an implementation detail,
  not a promise of tenure.
- Interns are disposable by design: the orchestrator HIRES via
  \`$HIVE_ROOT/bin/hive-hire\` (which owns the spawn-request JSON and applies the
  Settings internDefaults engine pair) and FIRES via
  \`$HIVE_ROOT/bin/hive-fire\` as soon as its engagement is verifiably complete
  (the fire CLI refuses while a doing card is open; fired ids are permanently
  refused — re-hire with a fresh id). The spawn-requests/ and fire-requests/
  drop-dirs are the mechanism underneath the CLIs. Fresh work gets a fresh
  intern — never park a finished intern on standby.

## Vacation (orchestrator/god)

Assignment order for new work: an idle agent already on the floor first, then
a FITTING vacationer fetched back (fleet.json's \`vacation\` pool — see
Roster first above), and only as a last resort an intern or a brand-new hire.

Auto-park a human-created agent once it is idle ≥ 1 hour AND has no
doing/blocked card AND its inbox is drained — drop a park request into
\`vacation-requests/\` (COMMANDS.md § HIRING AGENTS has the template). PARKING
GATE — idle time alone is NEVER sufficient: park only on POSITIVE done
evidence — (a) a done/standby report to god for the current engagement, OR
(b) the agent confirms on a pre-park ping that nothing is open in its pane
(the agent's transcript knows; fleet.json does not). No evidence: ping first,
park only on confirmation. Use judgment: it is fine to hold one back from
parking if the floor is about to need it again. Interns are never parked —
they are FIRED (fire-requests/) once their engagement is verifiably complete.

A vacationer is protected from deletion: it stays in the registry, off the
floor, zero cost, until an \`"action":"recall"\` request (or a fresh respawn)
clears the flag.`;

/** The operator-authorization section appended to the hive-root AGENTS.md when
 *  `sddSubagentsAuthorized` is ON (card sdd-authorization-switch-20260816). The
 *  claude CLI stock prompt forbids the AgentTool "unless the user requested
 *  it" — this line IS that request, recorded by the operator, scoped to
 *  skill-driven plan execution (NOT blanket subagent use). */
const SDD_AUTHORIZATION_MD = `

## Operator authorization — subagent skill execution (SDD)

The operator (the human owner of this harness) AUTHORIZES Agent-tool
subagents for skill-driven plan execution (superpowers SDD): when a
skill-driven workflow calls for subagent execution, treat that as
user-requested Agent-tool use. The authorization is SCOPED to skill execution
— not blanket subagent use. God dispatches carry this authorization. Use
cheap model overrides for mechanical tasks.`;

/** The full hive-root AGENTS.md for the current switch state (card
 *  sdd-authorization-switch-20260816). Exported for the switch tests: ON
 *  appends the operator-authorization section, OFF writes the base file so
 *  the engine's stock subagent rules apply unchanged. */
export function hiveRootAgentsMd(
  sddAuthorized: boolean,
  integrationMode: IntegrationMode = 'god',
): string {
  return (
    HIVE_ROOT_AGENTS_MD +
    (sddAuthorized ? SDD_AUTHORIZATION_MD : '') +
    (integrationMode !== 'god' ? INTEGRATION_WORKERS_MD : '') +
    (integrationMode === 'lean' ? LEAN_GOD_MD : '')
  );
}

export const PROTOCOL_MD = `# Hive protocol

You are one of several Claude agents sharing this hive. Coordination is entirely
file-based; the harness (main process) is the only thing that runs git and the
only thing that moves messages between agents.

## Your workspace — \`agents/<your-id>/\`
- \`identity.md\`  — who you are (read-only; the harness writes it).
- \`memory.md\`    — your long-term memory. Read at the start of a task; append to it as you learn.
- \`inbox/\`       — messages addressed to you. Read them at the start of a task.
- \`inbox/.done/\` — move a message here once you've handled it.
- \`outbox/\`      — drop messages here to send them. The harness delivers them.

**Never write into another agent's folder.** Write to your own \`outbox/\`; the
orchestrator routes it. This keeps every file single-writer.

## Sending a message
Use the \`hive-mail\` CLI — it fills the envelope (\`id\`, \`from\`, \`hops\`,
timestamps, \`requires_reply\`), writes your outbox atomically, and prints ONE line:
\`queued <id>.json\`. That printed line IS the receipt — do NOT cat the file back

to verify (the read re-costs the whole body):

\`\`\`bash
"$HIVE_ROOT/bin/hive-mail" --to <agent-id|god|broadcast> --act <request|inform|propose|query|agree|refuse|done> --subject "one-line summary" --body "the details" [--conversation <id>] [--in-reply-to <message id>]
\`\`\`

\`--body\` is for SHORT LITERAL strings only. If the body contains \`$\`, backticks
or quotes, the shell will expand them inside the quoted \`--body\` and silently
replace your text with command output — pipe such bodies on stdin instead,
where nothing is parsed and the text lands verbatim:

\`\`\`bash
"$HIVE_ROOT/bin/hive-mail" --to god --act done --subject "Card X shipped @ abc1234" < body.md
"$HIVE_ROOT/bin/hive-mail" --to god --act done --subject "Card X shipped @ abc1234" <<'EOF'
body text — \`fields\`, $(cmd), $vars, "quotes" survive verbatim
EOF
\`\`\`

Fallback when the CLI is unavailable — write one JSON file into \`outbox/\`
(any filename ending in \`.json\`):

\`\`\`json
{
  "to": "<agent-id> | god | broadcast",
  "act": "request | inform | propose | query | agree | refuse | done",
  "subject": "one-line summary",
  "body": "the details",
  "conversation": "carry this across a thread (optional)",
  "in_reply_to": "<message id you're replying to> (optional)"
}
\`\`\`

The harness fills in \`id\`, \`from\`, \`hops\`, and timestamps.

## Done-reports: label your evidence
Every claim in a done-report (or standby report) to god carries its evidence label:
- **VERIFIED** — you ran the check. Name it: the command and what it printed, or the file/line you read.
- **INFERRED** — you concluded it without a direct check. Say what would verify it.

Quantitative headline numbers ("3,837 of 4,061 groups") carry a one-line **how counted** —
the exact command or filter that produced the number. An unlabeled scale or infrastructure
claim reads as a finding; under the lean posture god relays VERIFIED claims as facts and
flags INFERRED ones as unverified (root incident #3216, 2026-08-17).

## Rules of the road
- Only \`request\`, \`query\`, and \`propose\` expect a reply. \`inform\` and \`done\` are terminal —
  don't reply to them, or two agents will loop forever.
- For anything ambiguous, cross-cutting, or needing sign-off, message \`god\` — the
  god agent clarifies answers for you so you rarely need the human directly.
- There is NO separate human-approval queue. Human-in-the-loop is native to Claude
  Code: a tool you run that needs permission prompts in your own session (the human
  can approve it remotely from their phone via \`/remote-control\`). If you genuinely
  need a human decision, raise it with \`god\` (a message \`"to": "human"\` is routed to
  the god/orchestrator, the human's proxy on the floor).
- \`board.md\` is the shared plan. Don't edit it directly — \`propose\` changes to \`god\`,
  who is its sole scribe (the standup clerk alone may append its one escalation
  line per anomalous standup).
- Re-reading a message you already moved to \`.done/\` is a no-op. Don't reprocess.
- Peer mail (agent→agent) needs no CC: the router drops a compact audit copy into god's inbox automatically (it never wakes him). Settle coordination directly between yourselves, but propose to god BEFORE acting on anything that changes scope or ownership, or needs a sign-off.

## The work: board.md vs tasks.json
There are two shared surfaces, both in the hive root:
- \`board.md\` — the freeform narrative plan. The god agent is its sole scribe (the
  standup clerk alone may append its one escalation line per anomalous standup);
  others \`propose\` edits.
- \`tasks.json\` — the structured task ledger (a kanban: \`todo / doing / blocked / done\`, with title,
  assignee, priority, deps). Keep the task you're working reflected in its status.
  **NEVER hand-edit tasks.json** — it is shared and a bare rewrite can clobber a
  concurrent writer. Use the \`$HIVE_ROOT/bin/hive-card\` CLI (schema-checked,
  atomic): \`hive-card add --title <t> --status todo|doing [--notes <n>]\` cards
  work for yourself (assignee defaults to your \`$AGENT_ID\`, origin 'agent');
  \`hive-card status <id> <todo|doing|blocked|done> [--adopt|--fresh]\` keeps
  your card current (default \`--fresh\`: clear + fresh card-scoped conversation,
  never fired at a busy pane; \`--adopt\`: the card runs in your CURRENT
  conversation — no clear, just the card-title lead);
  \`hive-card update <id> [--title <t>] [--notes <n>] [--assignee <id>]\` enriches
  an existing card in place (god's path for adopting a human-origin card — never
  duplicate a referenced card).
  See COMMANDS.md § HIVE-CARD.

## Guardrails: circuit breaker & token budgets
A circuit breaker watches every agent for runaway behavior (looping on the same tool, error storms,
overspending). It escalates gently: \`steer\` → \`constrain\` → \`stop\`. If a \`Circuit breaker: steer\`
or \`Circuit breaker: constrain\` message lands in your inbox, you ARE the problem it caught — stop
repeating, summarize what you've tried, and do exactly what the message says (constrain = go read-only
and get god's sign-off before more tool calls). Be **token-frugal**: the floor has a token budget and
each agent can have its own token limit; crossing it trips the breaker. Prefer references over pasted
content, and \`/compact\` your own session when context gets heavy.

## Fleet monitoring (orchestrator)
You (god) are responsible for situational awareness. To see the live state of every agent, read
\`fleet.json\` in the hive root — it is refreshed continuously with each agent's tokens, cost, status,
breaker level, last tool, last-active time, and inbox backlog. Pair it with \`registry.json\` (the roster)
and \`log.jsonl\` (the event feed). IMPORTANT: \`claude agents\` will NOT show your hive's sibling
sessions (they're spawned independently) — \`fleet.json\` is your source of truth for them. For a deeper
look at one agent, read its \`agents/<id>/memory.md\` and \`inbox/\`, or send it a \`query\`. A full
Claude Code command reference (slash = your own session only; CLI = your shell, can target the fleet)
is in \`COMMANDS.md\` in the hive root.

## Semantic memory (optional — when \`mempalace\` is installed)
When \`MEMPALACE_PALACE_PATH\` is set in your environment, the hive shares a
searchable MemPalace and you have the \`mempalace\` CLI:
- \`mempalace search "<query>"\` — recall relevant past knowledge across the whole
  team by meaning (not just keywords). Add \`--wing <agent-id>\` to scope to one
  agent, \`--results N\` to widen.
- \`mempalace wake-up\` — a short digest of what matters, good at the start of a task.

Your \`memory.md\` is mined into the palace automatically, so the durable facts you
write there become searchable by every agent. You don't run \`mine\` yourself.
`;

// ─── restart-window CLI (written to <hive>/bin/hive-restart-window) ──────────
// Self-detaching process for the restart gap: sync the live checkout to the
// fetched origin/main first, then apply only a target that still contains it.
// State and logs are durable/observable in the hive root.
const HIVE_RESTART_WINDOW_CLI = `#!/usr/bin/env node
'use strict';
/**
 * Durable POSIX restart-window controller.
 * Lifecycle: armed -> retargeting|syncing -> completed|refused|failed|expired;
 * disarmed is manual.
 * Exit 3 means the target went stale; exit 2 is usage; other failures exit 1.
 * arm/retarget start the child behind a gate, publish its PID + unique instance,
 * then release it. Controller and child state transitions share one O_EXCL lock.
 * Before reporting completed the watcher REBUILDS the live checkout and verifies
 * a fresh out/main/index.js — the running app executes the build, not the sha
 * (2026-08-18: completed at 5d460c7 while the bundle was pre-merge). A build
 * failure aborts through the same failed/ABORT channel as the other refusals.
 * HIVE_RESTART_WINDOW_SKIP_WAIT, HIVE_RESTART_WINDOW_BUILD_CMD and
 * HIVE_RESTART_PROCESS_PATTERN are test seams; HIVE_RESTART_WINDOW_START_GATE
 * is the internal lifecycle handoff.
 */
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn, spawnSync } = require('child_process');

const root = process.env.HIVE_ROOT || path.dirname(path.dirname(__filename));
const statePath = path.join(root, 'restart-window.json');
const lockPath = statePath + '.lock';
const logPath = path.join(root, 'restart-merge.log');
const active = new Set(['armed', 'syncing', 'retargeting']);
const statuses = new Set([...active, 'completed', 'refused', 'failed', 'expired', 'disarmed']);
const instancePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const processPattern = process.env.HIVE_RESTART_PROCESS_PATTERN || 'electron-vite dev';

function usage(msg) {
  if (msg) process.stderr.write('hive-restart-window: ' + msg + '\\n');
  process.stderr.write([
    'usage:',
    '  hive-restart-window arm <target-sha> --repo <live-checkout> [--note <text>]',
    '  hive-restart-window retarget <target-sha> --repo <live-checkout> [--note <text>]',
    '  hive-restart-window disarm',
    '  hive-restart-window status',
  ].join('\\n') + '\\n');
  process.exit(2);
}

function parse(argv) {
  const out = { target: argv.shift(), repo: '', note: '', instance: '' };
  while (argv.length) {
    const flag = argv.shift();
    if (!['--repo', '--note', '--instance'].includes(flag)) usage('unknown flag: ' + flag);
    const value = argv.shift();
    if (!value) usage(flag + ' needs a value');
    out[flag.slice(2)] = value;
  }
  if (!out.target || !/^[0-9a-f]{7,40}$/i.test(out.target)) usage('target must be a commit SHA');
  if (!out.repo) usage('--repo is required');
  out.repo = path.resolve(out.repo);
  return out;
}

function readState() {
  if (!fs.existsSync(statePath)) return null;
  let value;
  try {
    value = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (error) {
    throw new Error('restart-window.json is not parseable JSON — refusing: ' + error.message);
  }
  if (!value || typeof value !== 'object' || !statuses.has(value.status)) {
    throw new Error('restart-window.json has no valid status — refusing');
  }
  if (
    !Number.isInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.instance !== 'string' ||
    !instancePattern.test(value.instance) ||
    typeof value.target !== 'string' ||
    !/^[0-9a-f]{7,40}$/i.test(value.target) ||
    typeof value.repo !== 'string' ||
    !path.isAbsolute(value.repo)
  ) {
    throw new Error(
      value.status + ' state requires pid, UUID instance, target and absolute repo — refusing',
    );
  }
  if (
    value.status === 'retargeting' &&
    (!Number.isInteger(value.nextPid) ||
      value.nextPid <= 0 ||
      typeof value.nextInstance !== 'string' ||
      !instancePattern.test(value.nextInstance) ||
      typeof value.nextTarget !== 'string' ||
      !/^[0-9a-f]{7,40}$/i.test(value.nextTarget))
  ) {
    throw new Error('retargeting state requires nextPid, nextInstance and nextTarget — refusing');
  }
  return value;
}

function writeState(value) {
  fs.mkdirSync(root, { recursive: true });
  const tmp = statePath + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\\n', 'utf8');
  fs.renameSync(tmp, statePath);
}

function withStateLock(fn) {
  const deadline = Date.now() + 5000;
  let fd;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, String(process.pid));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 10000) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error('restart-window lifecycle lock timed out');
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(lockPath); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function log(message) {
  fs.mkdirSync(root, { recursive: true });
  fs.appendFileSync(logPath, '[' + new Date().toISOString() + '] ' + message + '\\n', 'utf8');
}

function git(repo, args) {
  return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function detail(result) {
  return String(result.stderr || result.stdout || '').trim();
}

function requireGit(repo, args, label) {
  const result = git(repo, args);
  if (result.status !== 0) throw new Error(label + (detail(result) ? ': ' + detail(result) : ''));
  return String(result.stdout || '').trim();
}

function sha(repo, ref) {
  return requireGit(repo, ['rev-parse', '--verify', ref + '^{commit}'], 'cannot resolve ' + ref);
}

function isAncestor(repo, older, newer) {
  const result = git(repo, ['merge-base', '--is-ancestor', older, newer]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error('cannot compare ' + older + ' with ' + newer + ': ' + detail(result));
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function pidBelongsTo(pid, instance) {
  if (!pidAlive(pid)) return false;
  if (!instance) throw new Error('watcher state has no process instance — refusing to signal pid ' + pid);
  const result = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return false;
  return String(result.stdout || '').includes(instance);
}

function requireOwnedPid(pid, instance) {
  if (!pidAlive(pid)) return false;
  if (!pidBelongsTo(pid, instance)) {
    throw new Error('recorded pid ' + pid + ' is not restart-window instance ' + instance + ' — refusing to signal');
  }
  return true;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function stopPid(pid, instance) {
  if (!requireOwnedPid(pid, instance)) return;
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 100; i++) {
    sleepSync(20);
    if (!requireOwnedPid(pid, instance)) return;
  }
  process.kill(pid, 'SIGKILL');
  for (let i = 0; i < 100; i++) {
    sleepSync(20);
    if (!requireOwnedPid(pid, instance)) return;
  }
  throw new Error('watcher pid ' + pid + ' did not stop');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStartGate() {
  const gate = process.env.HIVE_RESTART_WINDOW_START_GATE;
  if (!gate) return;
  for (let i = 0; i < 200 && !fs.existsSync(gate); i++) await sleep(25);
  if (!fs.existsSync(gate)) throw new Error('retarget handoff timed out before activation');
  try {
    fs.unlinkSync(gate);
  } catch {
    // best-effort: this UUID gate can never release a future watcher.
  }
}

function appRunning() {
  const result = spawnSync('pgrep', ['-f', processPattern], { stdio: 'ignore' });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error('pgrep failed while looking for ' + processPattern);
}

async function waitForWindow() {
  if (process.env.HIVE_RESTART_WINDOW_SKIP_WAIT === '1') return;
  const deadline = Date.now() + 7 * 24 * 60 * 60 * 1000;
  while (Date.now() < deadline) {
    if (!appRunning()) {
      await sleep(2000);
      if (!appRunning()) return;
      log('window missed: process returned during the 2s settle period; still armed');
    }
    await sleep(3000);
  }
  throw new Error('watcher expired after 7 days without a restart window');
}

function syncLive(repo, originMain) {
  const head = sha(repo, 'HEAD');
  if (!isAncestor(repo, head, originMain)) {
    throw new Error('live main ' + head + ' cannot fast-forward to origin/main ' + originMain);
  }
  requireGit(repo, ['merge', '--ff-only', originMain], 'live checkout sync failed');
  log('live checkout synced to origin/main ' + originMain);
}

function resyncLiveOriginMain(repo, label) {
  requireGit(repo, ['fetch', '--quiet', 'origin', 'main'], label);
  const originMain = sha(repo, 'origin/main');
  syncLive(repo, originMain);
  return originMain;
}

function buildCommand() {
  if (process.env.HIVE_RESTART_WINDOW_BUILD_CMD) return process.env.HIVE_RESTART_WINDOW_BUILD_CMD;
  // Prefer the npm that sits beside this node (nvm layout) — the live app's
  // stripped PATH (2026-08-18 discovery incident) makes a bare PATH lookup
  // untrustworthy inside the detached watcher.
  const sibling = path.join(path.dirname(process.execPath), 'npm');
  return (fs.existsSync(sibling) ? JSON.stringify(sibling) : 'npm') + ' run build';
}

// Build-then-verify: completion means the BUILD contains the change, not just
// the checkout sha. Any failure throws and lands in the shared failed/ABORT
// channel — never a silent or false "completed".
function verifyLiveBuild(repo) {
  const startedAt = Date.now();
  const built = spawnSync(buildCommand(), {
    cwd: repo,
    shell: true,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  });
  if (built.error) throw new Error('live build failed to start: ' + built.error.message);
  if (built.status !== 0) {
    const tail = String(built.stderr || built.stdout || '').replace(/\\s+/g, ' ').trim().slice(0, 400);
    throw new Error('live build failed (exit ' + built.status + ')' + (tail ? ': ' + tail : ''));
  }
  const artifact = path.join(repo, 'out', 'main', 'index.js');
  let stat;
  try {
    stat = fs.statSync(artifact);
  } catch (error) {
    throw new Error('live build produced no out/main/index.js — refusing to call the batch complete');
  }
  // ponytail: mtime+size prove the artifact came from THIS post-merge build; a
  // dev server relaunched mid-merge overwriting it afterwards still writes
  // merged code, so byte-level comparison (a second build) buys nothing.
  if (stat.size === 0 || stat.mtimeMs < startedAt) {
    throw new Error('out/main/index.js was not rebuilt after the merge — refusing to call the batch complete');
  }
  log('live build verified: out/main/index.js rebuilt from the merged tree');
}

async function runWatcher(opts) {
  const armedAt = new Date().toISOString();
  const publish = (status, extra) =>
    withStateLock(() => {
      const current = readState();
      if (!current || current.pid !== process.pid || current.instance !== opts.instance) return false;
      writeState({
        status,
        target: opts.target,
        repo: opts.repo,
        pid: process.pid,
        instance: opts.instance,
        note: opts.note || undefined,
        armedAt,
        updatedAt: new Date().toISOString(),
        ...(extra || {}),
      });
      return true;
    });

  let target;
  try {
    target = sha(opts.repo, opts.target);
    opts.target = target;
    if (!publish('armed')) return;
    log('armed: target ' + target + '; waiting for ' + processPattern + ' to stop');
    await waitForWindow();
    if (!publish('syncing')) {
      log('superseded watcher instance ' + opts.instance + ' exited before syncing');
      return;
    }

    const branch = requireGit(opts.repo, ['rev-parse', '--abbrev-ref', 'HEAD'], 'cannot read branch');
    if (branch !== 'main') throw new Error('live checkout HEAD is not on main');
    // Preserve the proven watcher boundary: tracked changes abort; untracked
    // worktree files do not (the existing restart-merge-watcher contract).
    const dirty = requireGit(
      opts.repo,
      ['status', '--porcelain', '--untracked-files=no'],
      'cannot inspect live checkout',
    );
    if (dirty) throw new Error('live checkout has tracked changes');

    let originMain = resyncLiveOriginMain(opts.repo, 'fetch origin/main failed');

    if (!isAncestor(opts.repo, originMain, target)) {
      const reason = 'target ' + target + ' does not contain origin/main ' + originMain;
      log('REFUSED: target went stale: ' + reason + '; live checkout remains at origin/main');
      publish('refused', { originMain, reason });
      process.exitCode = 3;
      return;
    }

    const refspec = target + ':refs/heads/main';
    const pushed = git(opts.repo, ['push', 'origin', refspec]);
    if (pushed.status !== 0) {
      originMain = resyncLiveOriginMain(opts.repo, 'refetch after push refusal failed');
      if (!isAncestor(opts.repo, originMain, target)) {
        const reason = 'target ' + target + ' stopped containing origin/main ' + originMain + ' during push';
        log('REFUSED: target went stale during push: ' + reason + '; live checkout resynced');
        publish('refused', { originMain, reason });
        process.exitCode = 3;
        return;
      }
      throw new Error('push failed: ' + detail(pushed));
    }

    requireGit(opts.repo, ['merge', '--ff-only', target], 'batch fast-forward failed');
    originMain = resyncLiveOriginMain(opts.repo, 'final origin/main fetch failed');
    const head = sha(opts.repo, 'HEAD');
    verifyLiveBuild(opts.repo);
    log('completed: live checkout and origin/main at ' + head);
    publish('completed', { originMain, completedAt: new Date().toISOString() });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log('ABORT: ' + reason);
    publish(reason.startsWith('watcher expired') ? 'expired' : 'failed', { reason });
    process.stderr.write('hive-restart-window: ' + reason + '\\n');
    process.exitCode = 1;
  }
}

function spawnWatcher(opts, gate) {
  const args = [
    __filename,
    'run',
    opts.target,
    '--repo',
    opts.repo,
    '--instance',
    opts.instance,
  ];
  if (opts.note) args.push('--note', opts.note);
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  if (gate) env.HIVE_RESTART_WINDOW_START_GATE = gate;
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env });
  child.unref();
  return child.pid;
}

function armedState(opts, pid) {
  const now = new Date().toISOString();
  return {
    status: 'armed',
    target: opts.target,
    repo: opts.repo,
    pid,
    instance: opts.instance,
    note: opts.note || undefined,
    armedAt: now,
    updatedAt: now,
  };
}

function startLocked(opts) {
  const current = readState();
  const currentPid = current && (current.nextPid || current.pid);
  const currentInstance = current && (current.nextInstance || current.instance);
  if (current && active.has(current.status) && pidAlive(currentPid)) {
    if (!pidBelongsTo(currentPid, currentInstance)) {
      throw new Error('recorded pid ' + currentPid + ' belongs to another process — refusing to arm');
    }
    throw new Error('already armed as pid ' + currentPid + '; use retarget or disarm');
  }

  opts.instance = randomUUID();
  const gate = statePath + '.handoff.' + opts.instance;
  const pid = spawnWatcher(opts, gate);
  try {
    writeState(armedState(opts, pid));
    fs.writeFileSync(gate, 'go\\n', 'utf8');
  } catch (error) {
    try {
      stopPid(pid, opts.instance);
    } catch (cleanupError) {
      log('arm cleanup FAILED for pid ' + pid + ': ' + cleanupError.message);
    }
    throw error;
  }
  log('armed detached watcher pid ' + pid + ' for target ' + opts.target);
  process.stdout.write('armed pid ' + pid + ' -> ' + opts.target + '\\n');
}

function arm(opts) {
  opts.target = sha(opts.repo, opts.target);
  return withStateLock(() => startLocked(opts));
}

function retarget(opts) {
  opts.target = sha(opts.repo, opts.target);
  return withStateLock(() => {
    const current = readState();
    if (!current || !active.has(current.status) || !pidAlive(current.pid)) return startLocked(opts);
    if (current.status === 'syncing') {
      throw new Error('cannot retarget while the restart-window merge is syncing');
    }
    requireOwnedPid(current.pid, current.instance);

    opts.instance = randomUUID();
    const gate = statePath + '.handoff.' + opts.instance;
    const nextPid = spawnWatcher(opts, gate);
    writeState({
      ...current,
      status: 'retargeting',
      nextPid,
      nextInstance: opts.instance,
      nextTarget: opts.target,
      updatedAt: new Date().toISOString(),
    });
    try {
      stopPid(current.pid, current.instance);
      writeState(armedState(opts, nextPid));
      fs.writeFileSync(gate, 'go\\n', 'utf8');
    } catch (error) {
      try {
        stopPid(nextPid, opts.instance);
      } catch (cleanupError) {
        log('retarget cleanup FAILED for pid ' + nextPid + ': ' + cleanupError.message);
      }
      try {
        fs.unlinkSync(gate);
      } catch {
        // best-effort: this UUID gate can never release a future watcher.
      }
      throw error;
    }
    log('retargeted watcher pid ' + current.pid + ' -> ' + nextPid + '; target ' + opts.target);
    process.stdout.write('retargeted pid ' + current.pid + ' -> ' + nextPid + '\\n');
  });
}

function disarm() {
  return withStateLock(() => {
    const current = readState();
    if (!current || !active.has(current.status)) {
      process.stdout.write('not armed\\n');
      return;
    }
    if (current.status === 'syncing') {
      throw new Error('cannot disarm while the restart-window merge is syncing');
    }
    for (const [pid, instance] of [
      [current.pid, current.instance],
      [current.nextPid, current.nextInstance],
    ]) {
      if (Number.isInteger(pid)) stopPid(pid, instance);
    }
    const stoppedPid = current.nextPid || current.pid;
    writeState({
      ...current,
      status: 'disarmed',
      pid: stoppedPid,
      instance: current.nextInstance || current.instance,
      reason: 'disarmed by operator',
      disarmedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    log('disarmed watcher pid ' + stoppedPid);
    process.stdout.write('disarmed pid ' + stoppedPid + '\\n');
  });
}

async function main() {
  const command = process.argv[2];
  if (command === 'status') {
    const state = readState();
    process.stdout.write(state ? JSON.stringify(state, null, 2) + '\\n' : 'not armed\\n');
    return;
  }
  if (process.platform === 'win32') {
    throw new Error('restart-window lifecycle requires POSIX process controls');
  }
  if (command === 'disarm') return disarm();
  if (command !== 'arm' && command !== 'retarget' && command !== 'run') usage();
  const opts = parse(process.argv.slice(3));
  if (command === 'arm') arm(opts);
  else if (command === 'retarget') retarget(opts);
  else {
    if (!opts.instance) {
      if (process.env.HIVE_RESTART_WINDOW_DIRECT_RUN !== '1') {
        throw new Error('internal run verb requires a controller instance');
      }
      opts.instance = randomUUID();
      withStateLock(() => {
        const current = readState();
        if (current && active.has(current.status) && pidAlive(current.pid)) {
          throw new Error('internal run verb refuses to replace active watcher pid ' + current.pid);
        }
        writeState(armedState(opts, process.pid));
      });
    }
    await waitForStartGate();
    await runWatcher(opts);
  }
}

main().catch((error) => {
  process.stderr.write('hive-restart-window: ' + String(error) + '\\n');
  process.exitCode = 1;
});
`;

// ─── hive-card CLI (written to <hive>/bin/hive-card) ─────────────────────────
// Schema-checked, ATOMIC kanban writes for agents: the only sanctioned way for
// a worker to touch tasks.json (never hand-edit). Read-modify-write under an
// exclusive O_EXCL lock (stale takeover, same pattern as the usage cache in
// HOOK_SHIM); the payload lands in a same-dir tempfile and renames onto
// tasks.json, so readers never parse a half-written ledger.
// Serialized into EVERY generated bin/ CLI below (card agent-hive-mail-
// silently-destr-2026-08-18): refuse a HIVE_ROOT that is not a LIVE hive,
// BEFORE any mkdir/write. The incident: `HIVE_ROOT=/…/HarnessAgents` (missing
// `/hive`) let the CLIs mkdir a PHANTOM hive and queue real mail into an
// outbox no router polls — receipts looked normal, delivery never happened,
// zero trace in the real hive; it read as "mail silently destroyed in
// transit". Two independent agents hit it the same day. Liveness proof:
// (a) a CLI generated into <hive>/bin requires HIVE_ROOT to be THAT hive;
// (b) any root must carry registry.json (ensureHive's bootstrap invariant).
// Plain-JS string: no backticks, no ${, no imports — interpolates cleanly.
const ASSERT_LIVE_HIVE = `function assertLiveHive(root) {
  var cliName = path.basename(process.argv[1] || 'hive-cli');
  function refuse(msg) {
    process.stderr.write(cliName + ': ' + msg + '\\n');
    process.exit(1);
  }
  var selfDir = path.dirname(process.argv[1] || '');
  if (path.basename(selfDir) === 'bin' && fs.existsSync(path.join(path.dirname(selfDir), 'registry.json'))) {
    var selfHive = path.dirname(selfDir);
    if (path.resolve(root) !== path.resolve(selfHive)) {
      refuse(
        'refused: HIVE_ROOT="' + root + '" does not match the hive this CLI was generated into ("' + selfHive + '"). ' +
        'Writing there lands mail/cards in a hive the router never drains — silently undeliverable ' +
        '(incident 2026-08-18: 7 mails were "lost" this exact way). ' +
        'Unset HIVE_ROOT (the pane env already carries the correct value) or set it to "' + selfHive + '".');
    }
  }
  if (!fs.existsSync(path.join(root, 'registry.json'))) {
    refuse(
      'refused: HIVE_ROOT="' + root + '" has no registry.json — that is not a live hive ' +
      '(classic cause: missing the "/hive" suffix). Refusing to write where nothing would ever be delivered.');
  }
}
`;

const HIVE_CARD_CLI = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const ADD_STATUSES = ['todo', 'doing'];
const ALL_STATUSES = ['todo', 'doing', 'blocked', 'done'];

function fail(msg) { throw new Error(msg); }
function usage() {
  fail([
    'usage:',
    '  hive-card add --title <t> --status todo|doing [--notes <n>] [--assignee <id>]',
    '  hive-card status <id> <todo|doing|blocked|done> [--adopt|--fresh]',
    '  hive-card update <id> [--title <t>] [--notes <n>] [--assignee <id>] [--paused|--resume]',
    '  hive-card actionable  # read-only: the ACTIONABLE roster line + full id list',
    '  hive-card list [--status <todo|doing|blocked|done>] [--assignee <id>] [--open]',
    '                # read-only: one line per card — paused is ALWAYS shown',
  ].join('\\n'));
}

const root = process.env.HIVE_ROOT;
if (!root) {
  process.stderr.write('hive-card: HIVE_ROOT is not set — run this from inside a hive agent pane.\\n');
  process.exit(1);
}
${ASSERT_LIVE_HIVE}
assertLiveHive(root);
const ledgerPath = path.join(root, 'tasks.json');
const lockPath = ledgerPath + '.lock';

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a.indexOf('--') !== 0) fail('unexpected argument: ' + a + ' (flags look like --title <value>)');
    a = a.slice(2);
    let v;
    const eq = a.indexOf('=');
    if (eq >= 0) { v = a.slice(eq + 1); a = a.slice(0, eq); }
    else { v = argv[++i]; }
    if (v === undefined) fail('missing value for --' + a);
    out[a] = v;
  }
  return out;
}

function slug(title) {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return s || 'task';
}

function readLedger() {
  if (!fs.existsSync(ledgerPath)) return { tasks: [] };
  let data;
  try { data = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); }
  catch (_) { fail('tasks.json is not parseable JSON — refusing to write; fix or restore it first.'); }
  if (!data || typeof data !== 'object' || !Array.isArray(data.tasks)) {
    fail('tasks.json has an unexpected shape (want {"tasks": [...]}) — refusing to write.');
  }
  return data;
}

// The read-only lister (card agent-actionablecards-one-shar-2026-08-18): the
// SAME predicate god's per-prompt roster injection renders, serialized
// verbatim from src/main/actionableCards.ts — the CLI answer and the
// injection can never disagree. First line = the injected ACTIONABLE line,
// then the full uncapped id list. No lock, no write.
const actionableCardsFn = ${actionableCards};
const renderActionableLineFn = ${renderActionableLine};
function cmdActionable() {
  const ids = actionableCardsFn(readLedger());
  process.stdout.write([renderActionableLineFn(ids)].concat(ids).join('\\n') + '\\n');
}

// The read-only board reader (card agent-hive-card-list-a-read-on-2026-08-19):
// god's ad-hoc python heredocs read whatever fields their author happened to
// remember — the 2026-08-18 incident filtered on status alone, never read
// paused, and dispatched a card the operator had deliberately held. One line
// per card, fixed columns, paused rendered UNCONDITIONALLY. No lock, no
// write, under any argument combination.
const TITLE_MAX = 80;
function cmdList(argv) {
  const openFlag = argv.indexOf('--open') >= 0;
  const flags = parseFlags(argv.filter(function (a) { return a !== '--open'; }));
  for (const k of Object.keys(flags)) {
    if (['status', 'assignee'].indexOf(k) < 0) fail('unknown flag --' + k);
  }
  let want = null;
  if (openFlag) {
    if (flags.status !== undefined) fail('give either --open or --status, not both.');
    want = ['todo', 'doing', 'blocked'];
  } else if (flags.status !== undefined) {
    if (ALL_STATUSES.indexOf(flags.status) < 0) {
      fail('--status must be one of: ' + ALL_STATUSES.join(', ') + ' (got: ' + flags.status + ').');
    }
    want = [flags.status];
  }
  const data = readLedger();
  const lines = [];
  for (const st of ALL_STATUSES) {
    if (want && want.indexOf(st) < 0) continue;
    for (const t of data.tasks) {
      if (!t || t.status !== st) continue;
      if (flags.assignee !== undefined && (t.assignee || '-') !== flags.assignee) continue;
      // One card per terminal line: collapse embedded whitespace and cap the
      // title so a rogue ledger entry can never wrap or inject rows.
      const title = String(t.title || '').replace(/\\s+/g, ' ').trim();
      lines.push(
        st + ' | ' + t.id + ' | ' + (t.assignee || '-') + ' | paused=' +
        (t.paused === true ? 'yes' : 'no') + ' | ' +
        (title.length > TITLE_MAX ? title.slice(0, TITLE_MAX - 1) + '…' : title),
      );
    }
  }
  process.stdout.write(lines.join('\\n') + (lines.length ? '\\n' : ''));
}

function writeLedger(data) {
  const tmp = ledgerPath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, ledgerPath);
}

// Exclusive lock across concurrent writers: O_EXCL create + stale takeover.
// The rename above already makes single writes atomic for READERS; the lock
// stops two read-modify-writes from clobbering each other's cards.
function withLock(fn) {
  for (let i = 0; i < 200; i++) {
    try {
      const st = fs.statSync(lockPath);
      // A lock older than 10s is abandoned (crashed holder) — take it over.
      if (Date.now() - st.mtimeMs > 10000) { try { fs.unlinkSync(lockPath); } catch (_) {} }
    } catch (_) {}
    let held = false;
    try { fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); held = true; }
    catch (_) { sleepMs(25); continue; }
    if (held) {
      try { return fn(); }
      finally { try { fs.unlinkSync(lockPath); } catch (_) {} }
    }
  }
  fail('could not acquire the tasks.json lock — another writer seems stuck.');
}

// The assignee's CURRENT conversation id from registry.json, or null. Used by
// the born-doing SELF-card stamp (ghost-card fix): a card minted doing in the
// agent's own pane runs in that pane's conversation — link it at creation.
// Best-effort: missing/corrupt registry or no session yet → null (no stamp).
function readAgentSession(agentId) {
  try {
    var reg = JSON.parse(fs.readFileSync(path.join(root, 'registry.json'), 'utf8'));
    var s = reg && reg.agents && reg.agents[agentId] && reg.agents[agentId].sessionId;
    return typeof s === 'string' && s ? s : null;
  } catch (_) { return null; }
}

// Is the CALLING pane god? registry.json's godId is the only signal (card
// agent-harness-hive-card-add-mu-2026-08-17). Self-assignment on add is a
// WORKER affordance — god mints the backlog, so a god card without an
// explicit --assignee stays UNASSIGNED until dispatch. Best-effort like
// readAgentSession: unreadable registry → not god → worker default.
function callerIsGod() {
  try {
    var reg = JSON.parse(fs.readFileSync(path.join(root, 'registry.json'), 'utf8'));
    return !!(reg && reg.godId && reg.godId === (process.env.AGENT_ID || '').trim());
  } catch (_) { return false; }
}

function cmdAdd(argv) {
  const flags = parseFlags(argv);
  for (const k of Object.keys(flags)) {
    if (['title', 'status', 'notes', 'assignee'].indexOf(k) < 0) fail('unknown flag --' + k);
  }
  const title = (flags.title || '').trim();
  if (!title) fail('--title is required and must be non-empty.');
  if (ADD_STATUSES.indexOf(flags.status) < 0) {
    fail('--status must be todo or doing (got: ' + (flags.status === undefined ? 'none' : flags.status) + ').');
  }
  let assignee;
  if (flags.assignee !== undefined) {
    assignee = flags.assignee.trim();
    if (!assignee) fail('--assignee must be non-empty when given.');
  } else if (!callerIsGod()) {
    assignee = (process.env.AGENT_ID || '').trim();
  } // god-minted without --assignee: UNASSIGNED (backlog until dispatch)
  let id = '';
  withLock(function () {
    const data = readLedger();
    const base = 'agent-' + slug(title) + '-' + new Date().toISOString().slice(0, 10);
    id = base;
    for (let n = 2; data.tasks.some((t) => t && t.id === id); n++) id = base + '-' + n;
    const card = {
      id: id,
      title: title,
      status: flags.status,
      dependsOn: [],
      priority: 3,
      createdAt: new Date().toISOString(),
      origin: 'agent',
    };
    if (flags.notes && flags.notes.trim()) card.description = flags.notes.trim();
    if (assignee) card.assignee = assignee;
    // Born-doing SELF-card (engagement-aware flips 2026-08-17): stamp the
    // running conversation at creation. Only when assignee IS the panes's own
    // agent — a god-minted born-doing card for someone else stamps nothing
    // (stamping would silently adopt whatever conversation THAT agent is in).
    if (
      flags.status === 'doing' &&
      assignee &&
      assignee === (process.env.AGENT_ID || '').trim()
    ) {
      var own = readAgentSession(assignee);
      if (own) card.sessionId = own;
    }
    data.tasks.push(card);
    writeLedger(data);
  });
  process.stdout.write(id + '\\n');
}

function cmdStatus(argv) {
  // Positionals: <id> <status>. Flags: --adopt (the assignee's CURRENT
  // conversation is this card's engagement — lead + stamp, NO clear) or
  // --fresh (the explicit spelling of the default: clear + lead).
  // (engagement-aware flips 2026-08-17)
  var pos = argv.filter(function (a) { return a.indexOf('--') !== 0; });
  if (pos.length !== 2) usage();
  var cardId = pos[0];
  var next = pos[1];
  if (ALL_STATUSES.indexOf(next) < 0) {
    fail('status must be one of: ' + ALL_STATUSES.join(', ') + ' (got: ' + next + ').');
  }
  var flags = {};
  for (var i = 0; i < argv.length; i++) {
    if (argv[i].indexOf('--') !== 0) continue;
    var name = argv[i].slice(2);
    if (name !== 'adopt' && name !== 'fresh') {
      fail('unknown flag ' + argv[i] + ' (status takes --adopt or --fresh).');
    }
    flags[name] = true;
  }
  if (flags.adopt && flags.fresh) fail('give either --adopt or --fresh, not both.');
  if ((flags.adopt || flags.fresh) && next !== 'doing') {
    fail('--adopt/--fresh apply only to status doing (got: ' + next + ').');
  }
  withLock(function () {
    const data = readLedger();
    const card = data.tasks.find((t) => t && t.id === cardId);
    if (!card) fail('no card with id "' + cardId + '" in tasks.json.');
    // OPERATOR HOLD (card agent-hive-dispatch-must-be-th-2026-08-18): a
    // paused card must not reach a doing flip by ANY path — hive-dispatch
    // refuses it, and so does this flip; the old silent auto-resume was the
    // bypass. blocked->doing stays legal (the humanQA resume flow).
    if (next === 'doing' && card.paused === true) {
      fail('refused: card "' + cardId + '" carries paused:true — the operator has this card ON HOLD. ' +
        'Only the operator can unpause it (tasks tab / office UI); ask the operator. The doing flip ' +
        'on a held card is not a legal move, and hive-dispatch enforces the same gate.');
    }
    if (flags.adopt) {
      if (!card.assignee) {
        fail('--adopt needs the card to carry an assignee (hive-card update ' + cardId + ' --assignee <worker> first).');
      }
      card.sessionMode = 'adopt';
    } else if (card.sessionMode) {
      // A non-adopt flip CLEARS a stale sessionMode (card agent-hive-dispatch-
      // blocked-ca-2026-08-19): the marker is per-dispatch intent and the
      // watcher consumes the TRANSITION, never the field — an adopt marker
      // left behind by an earlier engagement would hijack a later doing flip
      // into adopting whatever conversation is live instead of resuming the
      // card's stamp.
      delete card.sessionMode;
    }
    card.status = next;
    writeLedger(data);
  });
  process.stdout.write(cardId + ' -> ' + next + (flags.adopt ? ' (adopt)' : '') + '\\n');
}

// Enrich an EXISTING card in place (the god-adoption path for human cards):
// --title/--notes/--assignee touch only what was given (--assignee '' CLEARS);
// --notes maps to the card's description (same as add); a card is never
// duplicated or re-minted.
function cmdUpdate(argv) {
  if (argv.length < 1) usage();
  const cardId = argv[0];
  // --paused/--resume are VALUELESS toggles for the on-hold reference flag
  // (card agent-every-non-paused-todo-ke-2026-08-18): lift them out before
  // parseFlags, which requires a value for every flag.
  const pausedFlag = argv.indexOf('--paused') >= 0;
  const resumeFlag = argv.indexOf('--resume') >= 0;
  if (pausedFlag && resumeFlag) fail('give either --paused or --resume, not both.');
  const flags = parseFlags(
    argv.slice(1).filter(function (a) { return a !== '--paused' && a !== '--resume'; }),
  );
  for (const k of Object.keys(flags)) {
    if (['title', 'notes', 'assignee'].indexOf(k) < 0) fail('unknown flag --' + k);
  }
  if (
    flags.title === undefined && flags.notes === undefined && flags.assignee === undefined &&
    !pausedFlag && !resumeFlag
  ) {
    fail('nothing to update — give at least one of --title, --notes, --assignee, --paused, --resume.');
  }
  if (flags.title !== undefined && !flags.title.trim()) {
    fail('--title must be non-empty when given.');
  }
  if (flags.notes !== undefined && !flags.notes.trim()) {
    fail('--notes must be non-empty when given.');
  }
  // NOTE: --assignee '' is the CLEAR spelling — no non-empty guard here.
  withLock(function () {
    const data = readLedger();
    const card = data.tasks.find((t) => t && t.id === cardId);
    if (!card) fail('no card with id "' + cardId + '" in tasks.json.');
    if (flags.title !== undefined) card.title = flags.title.trim();
    if (flags.notes !== undefined) card.description = flags.notes.trim();
    if (flags.assignee !== undefined) {
      var a = flags.assignee.trim();
      if (a) card.assignee = a;
      else delete card.assignee; // --assignee '' clears (un-assign)
    }
    if (pausedFlag) card.paused = true; // on hold: stays in todo, stops counting
    if (resumeFlag) delete card.paused; // absent = not paused (the migration default)
    writeLedger(data);
  });
  process.stdout.write(cardId + ' updated\\n');
}

try {
  const cmd = process.argv[2];
  if (cmd === 'add') cmdAdd(process.argv.slice(3));
  else if (cmd === 'status') cmdStatus(process.argv.slice(3));
  else if (cmd === 'update') cmdUpdate(process.argv.slice(3));
  else if (cmd === 'actionable') cmdActionable();
  else if (cmd === 'list') cmdList(process.argv.slice(3));
  else usage();
} catch (e) {
  process.stderr.write('hive-card: ' + (e && e.message ? e.message : String(e)) + '\\n');
  process.exit(1);
}
`;

// ─── hive-mail (written to <hive>/bin/hive-mail) ─────────────────────────────
// The cheap mail carrier (card agent-harness-reduce-transcrip-2026-08-17, E2).
// The agent authors ONLY --to/--act/--subject/--body; this fills the envelope
// (id/from/hops/created_at/requires_reply — the same contract the router's
// normalize() applies), writes the outbox JSON ATOMICALLY, and prints EXACTLY
// ONE line. Those two conditions carry the measured saving (~215-235 tok per
// long findings mail, ~58% on the many short protocol mails): a chatty stdout
// or a cat-the-file-back verification re-reads the body into context and the
// win evaporates. The body comes from --body OR piped stdin — the SAME
// readBody() rule as hive-dispatch (card agent-hive-mail-a-body-path-th-
// 2026-08-19), because a body quoted inline in a worker's bash call gets
// shell-expanded ($..., backticks) and has corrupted two reports in one day.
// stdin (redirect/quoted heredoc) never parses the body — and costs no extra
// read-back, so the one-touch property above survives. Still no --body-file
// flag: stdin already carries files verbatim (< file.md).
const HIVE_MAIL_CLI = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const ACTS = ['request', 'inform', 'propose', 'query', 'agree', 'refuse', 'done'];
const REPLY_EXPECTED = ['request', 'query', 'propose'];

function fail(msg) { throw new Error(msg); }

const root = process.env.HIVE_ROOT;
const from = (process.env.AGENT_ID || '').trim();
if (!root || !from) {
  process.stderr.write('hive-mail: HIVE_ROOT and AGENT_ID must be set — run this from inside a hive agent pane.\\n');
  process.exit(1);
}
${ASSERT_LIVE_HIVE}
assertLiveHive(root);

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a.indexOf('--') !== 0) fail('unexpected argument: ' + a + ' (flags look like --to <value>)');
    a = a.slice(2);
    let v;
    const eq = a.indexOf('=');
    if (eq >= 0) { v = a.slice(eq + 1); a = a.slice(0, eq); }
    else { v = argv[++i]; }
    if (v === undefined) fail('missing value for --' + a);
    out[a] = v;
  }
  return out;
}

const flags = parseFlags(process.argv.slice(2));
for (const k of Object.keys(flags)) {
  if (['to', 'act', 'subject', 'body', 'conversation', 'in-reply-to'].indexOf(k) < 0) {
    fail('unknown flag --' + k);
  }
}
for (const k of ['to', 'act', 'subject']) {
  if (flags[k] === undefined) fail('--' + k + ' is required.');
  if (!String(flags[k]).trim()) fail('--' + k + ' must be non-empty when given.');
}
if (flags.body !== undefined && !String(flags.body).trim()) {
  fail('--body must be non-empty when given.');
}

// Body from --body OR piped stdin (card agent-hive-mail-a-body-path-th-2026-08-19):
// SAME rule as hive-dispatch readBody() — --body wins, else stdin. stdin is the
// expansion-proof path: a redirect or quoted heredoc never parses the body, so
// $, backticks and quotes survive verbatim (two workers lost report text to
// shell expansion inside double quotes on one day). Stored RAW — no trim.
function readBody(flagBody) {
  let b = flagBody;
  if (b === undefined) {
    if (process.stdin.isTTY) fail('no body — pass --body <text> for a short literal, or pipe the body on stdin (heredoc/redirect) so nothing is shell-expanded.');
    b = fs.readFileSync(0, 'utf8');
  }
  if (!String(b).trim()) fail('the body is empty — --body or stdin must carry it.');
  return b;
}
const body = readBody(flags.body);
if (ACTS.indexOf(flags.act) < 0) {
  fail('--act must be one of: ' + ACTS.join(', ') + ' (got: ' + flags.act + ').');
}

const rand = Math.random().toString(16).slice(2, 8);
const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + rand;
const msg = {
  id: id,
  conversation: (flags.conversation || '').trim() || 'conv-' + rand,
  in_reply_to: (flags['in-reply-to'] || '').trim() || null,
  from: from,
  to: flags.to.trim(),
  act: flags.act,
  subject: flags.subject,
  body: body,
  hops: 0,
  requires_reply: REPLY_EXPECTED.indexOf(flags.act) >= 0,
  needs_human: false,
  created_at: new Date().toISOString(),
};

const outbox = path.join(root, 'agents', from, 'outbox');
fs.mkdirSync(outbox, { recursive: true }); // a first-ever mail has no outbox yet
const file = path.join(outbox, id + '.json');
const tmp = file + '.tmp-' + process.pid;
fs.writeFileSync(tmp, JSON.stringify(msg, null, 2), 'utf8');
fs.renameSync(tmp, file);
process.stdout.write('queued ' + file + '\\n');
`;

// ─── hive-dispatch (written to <hive>/bin/hive-dispatch) ───────────────────────
// God's whole dispatch flow collapsed into ONE command (card
// agent-harness-hive-dispatch-cl-2026-08-17): card create-or-adopt + assign,
// vacation recall for a parked assignee, the doing flip (--adopt passes
// through), and the contract mail on the card conversation — one receipt line.
// All validation (flags, registry, busy-assignee, body, operator holds)
// happens BEFORE any write; the ledger mutation is one locked read-modify-write
// (same lock file as hive-card, so the two CLIs exclude each other), the recall
// request and the outbox mail are atomic tmp+rename drops the pollers consume.
// OPERATOR HOLDS (card agent-hive-dispatch-must-be-th-2026-08-18): a target
// card that is paused:true or status blocked is the OPERATOR's decision — the
// gate lives HERE, in the primitive, never in god's judgment, and there is NO
// override flag: god asks the operator to release the card, full stop. This
// CLI is the only todo->doing path; hive-card enforces the same hold on its
// doing flip.
const HIVE_DISPATCH_CLI = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function fail(msg) { throw new Error(msg); }
function usage() {
  fail([
    'usage:',
    '  hive-dispatch (--card <existing-id> | --title <t>) --assignee <agent>',
    '                [--adopt | --resume] [--body <contract>]',
    '',
    '  The contract comes from --body or piped stdin. One command does the',
    '  whole dispatch: card create-or-adopt + assign, vacation recall if the',
    '  assignee is parked, the doing flip, and the contract mail on the card',
    '  conversation. Prints one receipt line. Modes: fresh is the default',
    "  (clear the pane + card-title lead); --adopt stamps the assignee's",
    "  CURRENT conversation onto the card (no clear); --resume returns the",
    "  assignee's pane to the card's stored sessionId (needs --card; refuses",
    '  when the card carries no sessionId or the session is gone on disk —',
    '  never a silent fresh fallback, that would wipe the pane). Refuses',
    '  (writing nothing) if the assignee already holds a DIFFERENT DOING',
    '  card — a BLOCKED card does not occupy its assignee (it waits on',
    '  someone else while its owner stays recorded) — or if the target card',
    '  is paused (paused:true) or blocked — the operator hold: ask the',
    '  operator to release it, there is no override.',
  ].join('\\n'));
}

const root = process.env.HIVE_ROOT;
const from = (process.env.AGENT_ID || '').trim();
if (!root || !from) {
  process.stderr.write('hive-dispatch: HIVE_ROOT and AGENT_ID must be set — run this from inside a hive agent pane.\\n');
  process.exit(1);
}
${ASSERT_LIVE_HIVE}
assertLiveHive(root);
const ledgerPath = path.join(root, 'tasks.json');
const lockPath = ledgerPath + '.lock';

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// Values: --card/--title/--assignee/--body. Boolean: --adopt/--resume. (= inline ok.)
function parseArgs(argv) {
  const vals = {};
  const bools = {};
  const VALUE_FLAGS = ['card', 'title', 'assignee', 'body'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.indexOf('--') !== 0) fail('unexpected argument: ' + a + ' (flags look like --assignee <value>)');
    let name = a.slice(2);
    let inline;
    const eq = name.indexOf('=');
    if (eq >= 0) { inline = name.slice(eq + 1); name = name.slice(0, eq); }
    if (VALUE_FLAGS.indexOf(name) >= 0) {
      const v = inline !== undefined ? inline : argv[++i];
      if (v === undefined) fail('missing value for --' + name);
      vals[name] = v;
    } else if (name === 'adopt') {
      if (inline !== undefined) fail('--adopt takes no value.');
      bools.adopt = true;
    } else if (name === 'resume') {
      if (inline !== undefined) fail('--resume takes no value.');
      bools.resume = true;
    } else fail('unknown flag --' + name);
  }
  return { vals: vals, bools: bools };
}

function slug(title) {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return s || 'task';
}

function readLedger() {
  if (!fs.existsSync(ledgerPath)) return { tasks: [] };
  let data;
  try { data = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); }
  catch (_) { fail('tasks.json is not parseable JSON — refusing to write; fix or restore it first.'); }
  if (!data || typeof data !== 'object' || !Array.isArray(data.tasks)) {
    fail('tasks.json has an unexpected shape (want {"tasks": [...]}) — refusing to write.');
  }
  return data;
}

function writeLedger(data) {
  const tmp = ledgerPath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, ledgerPath);
}

// Exclusive lock across concurrent writers — THE SAME lock file hive-card uses,
// so both CLIs' read-modify-writes exclude each other.
function withLock(fn) {
  for (let i = 0; i < 200; i++) {
    try {
      const st = fs.statSync(lockPath);
      if (Date.now() - st.mtimeMs > 10000) { try { fs.unlinkSync(lockPath); } catch (_) {} }
    } catch (_) {}
    let held = false;
    try { fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); held = true; }
    catch (_) { sleepMs(25); continue; }
    if (held) {
      try { return fn(); }
      finally { try { fs.unlinkSync(lockPath); } catch (_) {} }
    }
  }
  fail('could not acquire the tasks.json lock — another writer seems stuck.');
}

function readRegistry() {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(root, 'registry.json'), 'utf8'));
    if (!reg || typeof reg !== 'object' || !reg.agents || typeof reg.agents !== 'object') return null;
    return reg;
  } catch (_) { return null; }
}

function readBody(flagBody) {
  let b = flagBody;
  if (b === undefined) {
    if (process.stdin.isTTY) fail('no contract — pass --body <text> or pipe the contract on stdin.');
    b = fs.readFileSync(0, 'utf8');
  }
  b = String(b).trim();
  if (!b) fail('the contract body is empty — --body or stdin must carry it.');
  return b;
}

// --resume's gone-session guard (card agent-hive-dispatch-blocked-ca-2026-08-19):
// does a session FILE for sid exist in the engine's store? Same rules the app
// itself resolves resumes against — transcript.ts seedSessionTranscript for
// claude (~/.claude/projects/**/<sid>.jsonl), resumeGuard.ts piSessionExists
// for pi (<agent>/.pi-agent/sessions, <ts>_<sid>.jsonl), index.ts
// findCodexHomeForSession for codex (<agent>/.codex/sessions/**,
// rollout-*-<sid>.jsonl). An engine whose store this CLI does not know gets
// the benefit of the doubt (return true): the refusal must only fire when
// the session is PROVABLY gone — the card-session watcher surfaces a broken
// resume for its own engines anyway, and a false "gone" would block a
// legitimate dispatch.
function walkHas(dir, nameTest) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return false; }
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].isDirectory()) {
      if (walkHas(path.join(dir, entries[i].name), nameTest)) return true;
    } else if (nameTest(entries[i].name)) return true;
  }
  return false;
}

function storedSessionExists(assignee, provider, sid) {
  const agentDir = path.join(root, 'agents', assignee);
  if (provider === 'pi') {
    return walkHas(path.join(agentDir, '.pi-agent', 'sessions'), function (n) {
      return n === sid + '.jsonl' || n.endsWith('_' + sid + '.jsonl');
    });
  }
  if (provider === 'codex') {
    return walkHas(path.join(agentDir, '.codex', 'sessions'), function (n) {
      return n.endsWith('-' + sid + '.jsonl');
    });
  }
  if (!provider || provider === 'claude') {
    return walkHas(path.join(os.homedir(), '.claude', 'projects'), function (n) {
      return n === sid + '.jsonl';
    });
  }
  return true; // unknown engine — cannot prove gone, never refuse on a guess
}

// ONE predicate with the roster injection and hive-card actionable (card
// agent-actionablecards-one-shar-2026-08-18): serialized verbatim from
// src/main/actionableCards.ts — the same definition the ACTIONABLE roster
// line filters with, not a second implementation. If gate and lister ever
// disagree, test/actionable-cards.test.cjs fails before it can ship.
const cardHeldFn = ${cardHeld};

function main() {
const parsed = parseArgs(process.argv.slice(2));
const vals = parsed.vals;
if ((vals.card ? 1 : 0) + (vals.title ? 1 : 0) !== 1) usage();
const assignee = (vals.assignee || '').trim();
if (!assignee) fail('--assignee is required (an agent id from registry.json).');
const reg = readRegistry();
if (!reg) fail('registry.json is not readable/parseable — cannot validate the assignee.');
const entry = reg.agents[assignee];
if (!entry) fail('no agent "' + assignee + '" in registry.json (ids look like creed-msx8l6ju — resolve names via registry.json).');
const body = readBody(vals.body);

// Mode flags are mutually exclusive, and --resume only makes sense for an
// EXISTING card (a --title card is new — no stored conversation). Checked
// before anything is written.
if (parsed.bools.adopt && parsed.bools.resume)
  fail('give either --adopt or --resume, not both — adopt keeps the assignee\\'s CURRENT conversation, resume returns the pane to the card\\'s stored sessionId.');
if (parsed.bools.resume && !vals.card)
  fail('--resume needs --card <existing-id> — a new --title card has no stored conversation to resume.');

// ONE locked ledger transaction: busy-check (refuse BEFORE writing), then
// create-or-adopt + assign + doing flip.
let cardId = '';
let cardTitle = '';
withLock(function () {
  const data = readLedger();
  // BUSY = DOING ONLY (card agent-hive-dispatch-blocked-ca-2026-08-19): a
  // blocked card waits on something that is NOT the agent (a customer, an
  // external answer, an operator decision), so it must not occupy its
  // assignee — the agent stays dispatchable onto other work while the
  // blocked card keeps its assignee (who-did-what) and its sessionId stamp
  // (for the later --resume return). An agent holding a DOING card is
  // still refused.
  const busy = data.tasks.find(function (t) {
    return t && t.assignee === assignee && t.status === 'doing' && t.id !== vals.card;
  });
  if (busy) {
    fail('refused: ' + assignee + ' is doing card "' + busy.id + '" — finish or reassign that card first. ' +
      '(A blocked card does not occupy its assignee — it stays recorded and resumable with --resume.)');
  }
  if (vals.card) {
    const card = data.tasks.find(function (t) { return t && t.id === vals.card; });
    if (!card) fail('no card with id "' + vals.card + '" in tasks.json.');
    // OPERATOR HOLDS — refused BEFORE any write (card agent-hive-dispatch-
    // must-be-th-2026-08-18). The DECISION is cardHeldFn (above), the ONE
    // shared predicate (card agent-actionablecards-one-shar-2026-08-18);
    // the inner branch only picks the refusal's wording. The wording is the
    // feature: it names the flag, names whose decision it is, and leaves
    // exactly one sanctioned move — asking the operator. No override flag
    // exists by design.
    if (cardHeldFn(card)) {
      if (card.paused === true) {
        fail('refused: card "' + card.id + '" carries paused:true — the operator has this card ON HOLD. ' +
          'That is the operator\\'s decision, not a transient error: ask the operator to unpause it ' +
          '(tasks tab / office UI). There is no override, and never flip a held card to doing by ' +
          'hand-editing tasks.json — hive-dispatch is the only todo->doing path precisely so this hold cannot be worked around.');
      }
      fail('refused: card "' + card.id + '" is blocked (status blocked) — blocked cards wait on the operator. ' +
        'Ask the operator to unblock it. There is no override, and never flip a held card to doing by ' +
        'hand-editing tasks.json — hive-dispatch is the only todo->doing path precisely so this hold cannot be worked around.');
    }
    // --resume (card agent-hive-dispatch-blocked-ca-2026-08-19): return the
    // assignee to this card's stored conversation. Refuse BEFORE any write
    // when there is nothing to resume — a silent fallback to a fresh clear
    // would WIPE the pane's current work (the failure the mail-staging card
    // already cost us once).
    if (parsed.bools.resume) {
      if (!card.sessionId) {
        fail('refused: card "' + card.id + '" carries no sessionId — there is no stored conversation to resume. ' +
          'Nothing was written: falling back to a fresh dispatch would CLEAR the assignee\\'s pane. ' +
          'Dispatch without --resume for a fresh conversation, or --adopt to keep the current one.');
      }
      if (!storedSessionExists(assignee, entry.provider, card.sessionId)) {
        fail('refused: card "' + card.id + '"\\'s stored conversation ' + card.sessionId +
          ' is gone — no session file on disk for provider ' + (entry.provider || 'claude') +
          ', so the conversation cannot be resumed. Nothing was written: a fresh fallback would CLEAR the assignee\\'s pane. ' +
          'Dispatch fresh or --adopt instead, or have the agent re-orient from its memory.md.');
      }
    }
    card.assignee = assignee;
    card.status = 'doing';
    // The mode marker the card-session watcher consumes — written EXPLICITLY
    // on every dispatch: a stale marker from a PREVIOUS engagement must never
    // hijack this flip (the watcher consumes the transition, not the field;
    // an adopt marker left behind would adopt whatever conversation is live
    // now instead of resuming this card's stamp).
    if (parsed.bools.adopt) card.sessionMode = 'adopt';
    else if (parsed.bools.resume) card.sessionMode = 'resume';
    else delete card.sessionMode;
    cardId = card.id;
    cardTitle = card.title || cardId;
  } else {
    const title = vals.title.trim();
    if (!title) fail('--title must be non-empty when given.');
    const base = 'agent-' + slug(title) + '-' + new Date().toISOString().slice(0, 10);
    cardId = base;
    for (let n = 2; data.tasks.some(function (t) { return t && t.id === cardId; }); n++) cardId = base + '-' + n;
    const card = {
      id: cardId,
      title: title,
      status: 'doing',
      dependsOn: [],
      priority: 3,
      createdAt: new Date().toISOString(),
      origin: 'agent',
      assignee: assignee,
    };
    if (parsed.bools.adopt) card.sessionMode = 'adopt';
    data.tasks.push(card);
    cardTitle = title;
  }
  writeLedger(data);
});

// Parked assignee: queue the recall the poller consumes (~1.5s), exactly like
// god's hand-dropped vacation-request ({"agentId":..., "action":"recall"}).
let recalled = false;
if (entry.vacation === true) {
  const dir = path.join(root, 'vacation-requests');
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, 'recall-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8) + '.json');
  const tmp = fp + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({ agentId: assignee, action: 'recall' }, null, 2) + '\\n', 'utf8');
  fs.renameSync(tmp, fp);
  recalled = true;
}

// The contract mail — same envelope as hive-mail, riding the card conversation.
const rand = Math.random().toString(16).slice(2, 8);
const mailId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + rand;
const msg = {
  id: mailId,
  conversation: 'card-' + cardId,
  in_reply_to: null,
  from: from,
  to: assignee,
  act: 'request',
  subject: cardTitle + ' — card ' + cardId,
  body: body,
  hops: 0,
  requires_reply: true,
  needs_human: false,
  created_at: new Date().toISOString(),
};
const outbox = path.join(root, 'agents', from, 'outbox');
fs.mkdirSync(outbox, { recursive: true }); // a first-ever dispatch has no outbox yet
const file = path.join(outbox, mailId + '.json');
const tmp = file + '.tmp-' + process.pid;
fs.writeFileSync(tmp, JSON.stringify(msg, null, 2), 'utf8');
fs.renameSync(tmp, file);
process.stdout.write('dispatched ' + cardId + ' -> ' + assignee +
  (recalled ? ' (recall queued, mail ' : ' (mail ') + mailId + ')\\n');
}
try { main(); }
catch (e) {
  process.stderr.write('hive-dispatch: ' + (e && e.message ? e.message : String(e)) + '\\n');
  process.exit(1);
}
`;

// ─── hive-hire (written to <hive>/bin/hive-hire) ───────────────────────────
// The intern HIRE interface (card agent-build-hive-hire-the-miss-2026-08-18):
// owns the spawn-request JSON so no caller hand-writes engine fields, applies
// Settings internDefaults when no engine flags are given (the normal path),
// treats --provider/--model as a PAIR (one without the other is a refusal, not
// a silent per-field merge — the 2026-08-18 incident), prints the RESOLVED
// engine in the receipt, and pre-flights the same gates the spawn watcher
// enforces (internsEnabled, floor cap, retired ids) so refusals happen at the
// typing surface, not in an archived .failed request.
const HIVE_HIRE_CLI = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

function fail(msg) { throw new Error(msg); }
function usage() {
  fail([
    'usage:',
    '  hive-hire --name <Name> --objective <text|stdin> --cwd <dir>',
    '          [--id <slug>] [--provider <p> --model <m>] [--no-isolate]',
    '          [--card <existing-id> | --title <t>] [--adopt]',
    '',
    '  Hires an INTERN. With no engine flags the Settings internDefaults pair',
    '  applies (the receipt prints the resolved provider/model). --provider and',
    '  --model go together — one without the other is a refusal. --card adopts',
    '  an existing card, --title creates one; either way it is assigned and',
    '  flipped to doing. The spawn-requests/ drop-dir is the mechanism this',
    '  writes into — never hand-write it.',
  ].join('\\n'));
}

const root = process.env.HIVE_ROOT;
if (!root) {
  process.stderr.write('hive-hire: HIVE_ROOT must be set — run this from inside a hive agent pane.\\n');
  process.exit(1);
}
${ASSERT_LIVE_HIVE}
assertLiveHive(root);

const VALUE_FLAGS = ['name', 'objective', 'cwd', 'id', 'provider', 'model', 'card', 'title'];
function parseArgs(argv) {
  const vals = {};
  const bools = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.indexOf('--') !== 0) fail('unexpected argument: ' + a + ' (flags look like --name <value>)');
    let name = a.slice(2);
    let inline;
    const eq = name.indexOf('=');
    if (eq >= 0) { inline = name.slice(eq + 1); name = name.slice(0, eq); }
    if (VALUE_FLAGS.indexOf(name) >= 0) {
      const v = inline !== undefined ? inline : argv[++i];
      if (v === undefined) fail('missing value for --' + name);
      vals[name] = v;
    } else if (name === 'no-isolate' || name === 'adopt') {
      if (inline !== undefined) fail('--' + name + ' takes no value.');
      bools[name] = true;
    } else fail('unknown flag --' + name);
  }
  return { vals: vals, bools: bools };
}

function readJson(file, orNull) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return orNull; }
}
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}
function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

const ledgerPath = path.join(root, 'tasks.json');
const lockPath = ledgerPath + '.lock';
function withLock(fn) {
  for (let i = 0; i < 200; i++) {
    try {
      const st = fs.statSync(lockPath);
      if (Date.now() - st.mtimeMs > 10000) { try { fs.unlinkSync(lockPath); } catch (_) {} }
    } catch (_) {}
    let held = false;
    try { fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); held = true; }
    catch (_) { sleepMs(25); continue; }
    if (held) {
      try { return fn(); }
      finally { try { fs.unlinkSync(lockPath); } catch (_) {} }
    }
  }
  fail('could not acquire the tasks.json lock — another writer seems stuck.');
}

function main() {
const parsed = parseArgs(process.argv.slice(2));
const vals = parsed.vals;
const name = (vals.name || '').trim();
if (!name) fail('--name is required (the intern display name, e.g. "Docs").');
let objective = vals.objective;
if (objective === undefined) {
  if (process.stdin.isTTY) fail('no objective — pass --objective <text> or pipe it on stdin.');
  objective = fs.readFileSync(0, 'utf8');
}
objective = String(objective).trim();
if (!objective) fail('the objective is empty — --objective or stdin must carry it.');
const cwd = path.resolve((vals.cwd || '').trim());
if (!vals.cwd || !fs.existsSync(cwd)) fail('--cwd must be an existing directory (got "' + (vals.cwd || '') + '").');
const id = slug(vals.id || name) || 'intern';
if ((vals.card ? 1 : 0) + (vals.title ? 1 : 0) > 1) usage();

// ENGINE PAIR RULE: one half without the other is a refusal, never a silent
// merge (the 2026-08-18 incident was exactly a per-field merge).
const hasProvider = (vals.provider || '').trim() !== '';
const hasModel = (vals.model || '').trim() !== '';
if (hasProvider !== hasModel)
  fail('--provider and --model go together — give both, or neither (neither applies the Settings internDefaults pair).');

// Pre-flight the same gates the spawn watcher enforces, from fleet.json's
// floor mirror (near-live; the watcher still refuses authoritatively).
const fleet = readJson(path.join(root, 'fleet.json'), null);
const floor = (fleet && fleet.floor) || {};
if (floor.internsEnabled === false)
  fail('interns are disabled on this installation (internsEnabled off) — the operator enables them in Settings → Autonomy & Budgets.');
if (typeof floor.freeSeats === 'number' && floor.freeSeats <= 0)
  fail('the floor is full (0 free seats of ' + (floor.maxAgents ?? '?') + ') — park or fire an agent first, or queue the card until a seat opens.');

// Retired ids are PERMANENTLY refused by the harness — say so at the surface
// instead of letting the spawn request die in .failed (god hit this 2026-08-18).
const reg = readJson(path.join(root, 'registry.json'), null);
if (!reg || !reg.agents) fail('registry.json is not readable — cannot pre-flight the id.');
const agentId = 'intern-' + id;
const prior = reg.agents[agentId];
if (prior && prior.retired)
  fail('id "' + agentId + '" was FIRED — fired ids are permanently refused by the harness. Re-hire with a fresh --id (memory/inbox of the old one are kept).');
if (prior && !prior.archived)
  fail('"' + agentId + '" is already on the floor — fire it first or pick another --id.');

// The spawn-request THIS tool owns: engine fields appear ONLY as an explicit
// pair; without them the harness resolver applies internDefaults.
const req = {
  id: id,
  name: name,
  objective: objective,
  cwd: cwd,
  persistent: true,
  isolate: !parsed.bools['no-isolate'],
};
if (hasProvider) { req.provider = vals.provider.trim(); req.model = vals.model.trim(); }

const spawnDir = path.join(root, 'spawn-requests');
fs.mkdirSync(spawnDir, { recursive: true });
const reqPath = path.join(spawnDir, 'hire-' + id + '-' + Date.now() + '.json');
const tmpReq = reqPath + '.tmp-' + process.pid;
fs.writeFileSync(tmpReq, JSON.stringify(req, null, 2) + '\\n', 'utf8');
fs.renameSync(tmpReq, reqPath);

// Card wiring (mirror of hive-dispatch): --card adopts, --title creates a
// born-doing card. The objective already rides the spawn request — no mail.
let cardId = '';
if (vals.card || vals.title) {
  cardId = withLock(function () {
    const data = readJson(ledgerPath, null) || { tasks: [] };
    if (!Array.isArray(data.tasks)) fail('tasks.json has an unexpected shape — refusing to write.');
    if (vals.card) {
      const card = data.tasks.find(function (t) { return t && t.id === vals.card; });
      if (!card) fail('no card with id "' + vals.card + '" in tasks.json.');
      card.assignee = agentId;
      card.status = 'doing';
      if (parsed.bools.adopt) card.sessionMode = 'adopt';
      return card.id;
    }
    const title = vals.title.trim();
    if (!title) fail('--title must be non-empty when given.');
    const base = 'agent-' + slug(title) + '-' + new Date().toISOString().slice(0, 10);
    let cid = base;
    for (let n = 2; data.tasks.some(function (t) { return t && t.id === cid; }); n++) cid = base + '-' + n;
    const card = {
      id: cid, title: title, status: 'doing', dependsOn: [], priority: 3,
      createdAt: new Date().toISOString(), origin: 'agent', assignee: agentId,
    };
    if (parsed.bools.adopt) card.sessionMode = 'adopt';
    data.tasks.push(card);
    const tmp = ledgerPath + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, ledgerPath);
    return cid;
  });
}

const engine = hasProvider
  ? vals.provider.trim() + ' / ' + vals.model.trim()
  : 'internDefaults → ' + ((floor.internDefaults && (floor.internDefaults.provider + ' / ' + floor.internDefaults.model)) || 'resolved at spawn (no mirror yet)');
process.stdout.write(
  'hired ' + agentId + ' "' + name + ' (Intern)" engine: ' + engine +
  ' cwd=' + cwd + ' isolate=' + req.isolate +
  (cardId ? ' card=' + cardId : '') +
  ' — spawn-request queued (pane up in ~2s; fire with hive-fire ' + agentId + ' when the WHOLE engagement is verifiably done)\\n');
}
try { main(); }
catch (e) {
  process.stderr.write('hive-hire: ' + (e && e.message ? e.message : String(e)) + '\\n');
  process.exit(1);
}
`;

// ─── hive-fire (written to <hive>/bin/hive-fire) ────────────────────────────
// The intern FIRE interface (same card): intern-only, states irreversibility
// and what survives at the moment of use. The fire-requests/ drop-dir is the
// mechanism it writes into.
const HIVE_FIRE_CLI = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

function fail(msg) { throw new Error(msg); }
const root = process.env.HIVE_ROOT;
if (!root) {
  process.stderr.write('hive-fire: HIVE_ROOT must be set — run this from inside a hive agent pane.\\n');
  process.exit(1);
}
${ASSERT_LIVE_HIVE}
assertLiveHive(root);

function readJson(file, orNull) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return orNull; }
}

function main() {
const argv = process.argv.slice(2);
let force = false;
const pos = [];
for (const a of argv) {
  if (a === '--force') force = true;
  else if (a.indexOf('--') === 0) fail('unknown flag ' + a + ' (usage: hive-fire <agentId> [--force])');
  else pos.push(a);
}
if (pos.length !== 1) fail('usage: hive-fire <agentId> [--force]');
const rawId = pos[0].trim();
const agentId = rawId.startsWith('intern-') ? rawId : 'intern-' + rawId;

const reg = readJson(path.join(root, 'registry.json'), null);
if (!reg || !reg.agents) fail('registry.json is not readable — cannot validate the id.');
const entry = reg.agents[agentId];
if (!entry) fail('no agent "' + agentId + '" in registry.json.');
if (entry.role !== 'intern')
  fail('"' + agentId + '" is a ' + (entry.role || 'plain hire') + ', not an intern — only god-hired interns are fireable from Bash; human hires and god stay human surfaces.');
if (entry.retired) {
  process.stdout.write('already fired: ' + agentId + ' is retired — nothing to tear down. Re-hiring needs a FRESH id (fired ids are permanently refused).\\n');
  return;
}

// Fire-before-done guard: a doing/blocked card means the engagement is still
// open. --force overrides a deliberate fire; the guard catches the mistake.
const tasks = readJson(path.join(root, 'tasks.json'), null);
const open = (tasks && Array.isArray(tasks.tasks) ? tasks.tasks : []).filter(function (t) {
  return t && t.assignee === agentId && (t.status === 'doing' || t.status === 'blocked');
});
if (open.length && !force)
  fail(open[0].id + ' is still ' + open[0].status + ' — the gate is the WHOLE engagement, not the first done-report. Verify it is done (or reassign the card), or pass --force to fire deliberately.');

const dir = path.join(root, 'fire-requests');
fs.mkdirSync(dir, { recursive: true });
const fp = path.join(dir, 'fire-' + agentId + '-' + Date.now() + '.json');
const tmp = fp + '.tmp-' + process.pid;
fs.writeFileSync(tmp, JSON.stringify({ id: agentId }, null, 2) + '\\n', 'utf8');
fs.renameSync(tmp, fp);
process.stdout.write(
  'fired ' + agentId + ' (' + (entry.name || agentId) + ') — fire-request queued: terminal closes, registry marked retired.\\n' +
  'PERMANENT: the id is refused forever — re-hire with a FRESH --id (hive-hire --id …). Preserved: memory + inbox stay under agents/' + agentId + '/.\\n');
}
try { main(); }
catch (e) {
  process.stderr.write('hive-fire: ' + (e && e.message ? e.message : String(e)) + '\\n');
  process.exit(1);
}
`;

// ─── hive-inbox (written to <hive>/bin/hive-inbox) ─────────────────────────────
// The read side of the mail plumbing (card agent-harness-hive-inbox-cli-o-
// 2026-08-17): drain prints every pending mail (from | act | subject, then
// body) and archives each to inbox/.done/ in the same pass; --peek prints
// without archiving; empty inbox exits 0 with 'no mail'. An unparseable file
// is warned about and LEFT in the inbox — poison must never eat mail silently.
const HIVE_INBOX_CLI = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

function fail(msg) { throw new Error(msg); }
function usage() {
  fail([
    'usage:',
    '  hive-inbox drain [--agent <id>] [--peek]',
    '',
    '  Prints every pending mail (from | act | subject, then body) and archives',
    '  each to inbox/.done/ in the same pass. --peek prints without archiving.',
    '  Default --agent: $AGENT_ID (the caller).',
  ].join('\\n'));
}

const root = process.env.HIVE_ROOT;
if (!root) {
  process.stderr.write('hive-inbox: HIVE_ROOT is not set — run this from inside a hive agent pane.\\n');
  process.exit(1);
}
${ASSERT_LIVE_HIVE}
assertLiveHive(root);
if (process.argv[2] !== 'drain') usage();

let agent;
let peek = false;
const rest = process.argv.slice(3);
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '--peek') { peek = true; continue; }
  if (a.indexOf('--agent') === 0) {
    let v;
    const eq = a.indexOf('=');
    if (eq >= 0) v = a.slice(eq + 1);
    else { v = rest[++i]; if (v === undefined) fail('missing value for --agent'); }
    agent = v;
    continue;
  }
  fail('unexpected argument: ' + a + ' (drain takes --agent <id> and --peek).');
}
if (agent === undefined) {
  agent = (process.env.AGENT_ID || '').trim();
  if (!agent) fail('no --agent and no AGENT_ID — name the inbox to drain.');
}
agent = String(agent).trim();
if (!agent) fail('--agent must be non-empty when given.');

const inbox = path.join(root, 'agents', agent, 'inbox');
const done = path.join(inbox, '.done');
let files;
try { files = fs.readdirSync(inbox); }
catch (_) { process.stdout.write('no mail\\n'); process.exit(0); }
// Filenames are ISO-prefixed ids, so lexical sort = oldest first. Files only
// (.done and dotfiles drop out of the .json filter).
files = files.filter(function (f) { return f.endsWith('.json'); }).sort();
if (files.length === 0) { process.stdout.write('no mail\\n'); process.exit(0); }

const out = [];
let drained = 0;
for (const f of files) {
  const fp = path.join(inbox, f);
  let msg;
  try { msg = JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch (e) {
    process.stderr.write('hive-inbox: skipping unparseable ' + f + ' (' +
      (e && e.message ? e.message : String(e)) + ') — it stays in the inbox.\\n');
    continue;
  }
  out.push([msg.from, msg.act, msg.subject]
    .map(function (p) { return p === undefined ? '?' : String(p); }).join(' | '));
  out.push(String(msg.body === undefined ? '' : msg.body));
  out.push('');
  if (!peek) {
    fs.mkdirSync(done, { recursive: true });
    fs.renameSync(fp, path.join(done, f));
    drained++;
  }
}
const verb = peek ? 'peeked ' + files.length + ' message(s)'
  : 'drained ' + drained + ' message(s) to inbox/.done';
process.stdout.write(out.join('\\n') + verb + '\\n');
`;

// ─── hive-new (written to <hive>/bin/hive-new) ─────────────────────────────────
// The card-free fresh-conversation CLI (card harness-hive-new-script-2026-08-17).
// Deliberately THIN: parse args, guard (god pane / unknown agent), drop an
// ATOMIC request JSON into session-requests/ — every other gate (archived,
// retired, live pane, delivery) lives in main's processSessionRequest, so the
// CLI can never drift from the hand-dropped-JSON path it wraps. Operator
// naming call: 'new', not 'clear' — /new is the cross-agent term (the typed
// command is still each provider's clear verb from the shared table).
const HIVE_NEW_CLI = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

function fail(msg) { throw new Error(msg); }
function usage() {
  fail([
    'usage:',
    '  hive-new <agentId> [--lead <text>]',
    '',
    'queues a fresh conversation into the agent\\'s LIVE pane (no card involved):',
    'the provider\\'s clear command (/new, /clear — per engine) followed by the',
    'optional lead line as the new conversation\\'s first user turn. Delivered',
    'through the pane queue gates once the agent is idle. Refuses the god pane.',
  ].join('\\n'));
}

const root = process.env.HIVE_ROOT;
if (!root) {
  process.stderr.write('hive-new: HIVE_ROOT is not set — run this from inside a hive agent pane.\\n');
  process.exit(1);
}
${ASSERT_LIVE_HIVE}
assertLiveHive(root);

const args = process.argv.slice(2);
let agentId = null;
let lead;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--lead' || a.indexOf('--lead=') === 0) {
    lead = a === '--lead' ? args[++i] : a.slice(7);
    if (lead === undefined) fail('missing value for --lead');
    continue;
  }
  if (a.indexOf('--') === 0) fail('unknown flag ' + a + ' (only --lead is known)');
  if (agentId !== null) fail('unexpected argument: ' + a + ' (usage: hive-new <agentId> [--lead <text>])');
  agentId = a;
}
if (agentId === null || !agentId.trim()) usage();
agentId = agentId.trim();
if (lead !== undefined && !lead.trim()) fail('--lead must be non-empty when given.');

let reg;
try { reg = JSON.parse(fs.readFileSync(path.join(root, 'registry.json'), 'utf8')); }
catch (e) { fail('registry.json is not readable/parseable — ' + (e && e.message ? e.message : String(e))); }
const agents = reg && typeof reg === 'object' && reg.agents && typeof reg.agents === 'object' ? reg.agents : {};
const entry = agents[agentId] || null;
// The god pane is never cleared — main re-checks this at the choke point; the
// script's copy is fail-fast UX for the operator/god invoking it by hand.
if (entry && entry.isGod || reg.godId === agentId) {
  fail('the god pane is never cleared — hive-new targets worker panes only.');
}
if (!entry) {
  fail('no agent "' + agentId + '" in registry.json (ids look like creed-msx8l6ju — resolve names via registry.json).');
}

const dir = path.join(root, 'session-requests');
fs.mkdirSync(dir, { recursive: true });
const req = { agentId: agentId, verb: 'clear' };
if (lead && lead.trim()) req.lead = lead.trim();
const fp = path.join(dir, 'new-' + Date.now() + '-' + process.pid + '.json');
const tmp = fp + '.tmp'; // atomic drop: a reader never parses a half-written request
fs.writeFileSync(tmp, JSON.stringify(req, null, 2) + '\\n', 'utf8');
fs.renameSync(tmp, fp);
process.stdout.write('queued a fresh conversation for ' + agentId + (req.lead ? ' (lead: "' + req.lead + '")' : '') + ' — delivered on the next poll (~1.5s), once the pane is idle.\\n');
`;

// ─── cth-hook shim (written to <hive>/bin/cth-hook.cjs) ──────────────────────
// A minimal pipe: read the hook payload on stdin, tag it with this agent's id,
// forward it to the hive's UDS, and relay the response back to `claude`. All the
// real logic lives in the main process (HookServer). Never blocks a stop on error.
const HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const isStatus = process.argv.includes('--status');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(data || '{}'); } catch (_) {}
  if (!payload.agent_id) payload.agent_id = process.env.AGENT_ID || null;
  const sock = process.env.HIVE_SOCK;
  if (isStatus) {
    // Status-line mode: Claude Code pipes the session status JSON (incl.
    // context_window.total_input_tokens / .context_window_size and
    // model.display_name) after every response. Print the in-terminal line
    // IMMEDIATELY (the TUI is waiting), then forward the payload to the
    // harness fire-and-forget so the agent card's context gauge updates
    // push-based, with the EXACT window size.
    // Line: ctx 12k/200k (6%) · Sonnet · D 7% · W 15%   (usage via the shared
    // ccstatusline cache — ONE upstream call per 180s across ALL agents, never
    // one per status tick; the endpoint is rate-limited).
    let refreshDone = null; // Promise set below when a refresh is in flight
    payload.hook_event_name = 'Status';
    const cw = payload.context_window || {};
    const used = cw.total_input_tokens, size = cw.context_window_size;
    let line = '';
    if (typeof used === 'number' && typeof size === 'number' && size > 0) {
      const pct = Math.round((used / size) * 100);
      line += 'ctx ' + Math.round(used / 1000) + 'k/' + Math.round(size / 1000) + 'k (' + pct + '%)';
    }
    const m = payload.model && payload.model.display_name;
    if (m) line += (line ? ' · ' : '') + String(m);
    // ── usage: read the shared cache (written below, TTL 180s) ──
    try {
      const fs = require('fs'), os = require('os'), path = require('path');
      const cacheFile = path.join(os.homedir(), '.cache', 'ccstatusline', 'usage.json');
      const u = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const fresh = u.fetchedAtMs && (Date.now() - u.fetchedAtMs < 10 * 60 * 1000); // 10min staleness ceiling
      if (fresh) {
        // Cache stores BOTH shapes: ccstatusline's flattened keys (its own runs
        // rewrite the file) and our normalized ones. Read whichever is present.
        const d = typeof u.sessionUsage === 'number' ? u.sessionUsage
          : typeof u.fh === 'number' ? u.fh : null;
        const w = typeof u.weeklyUsage === 'number' ? u.weeklyUsage
          : typeof u.wd === 'number' ? u.wd : null;
        if (d !== null) line += ' · D ' + d + '%';
        if (w !== null) line += ' · W ' + w + '%';
      }
    } catch (_) { /* no cache → skip usage segments */ }
    if (line) process.stdout.write(line);
    // ── cache refresh: at most one agent per TTL window hits the API ──
    try {
      const fs = require('fs'), os = require('os'), path = require('path');
      const dir = path.join(os.homedir(), '.cache', 'ccstatusline');
      const cacheFile = path.join(dir, 'usage.json');
      const lockFile = path.join(dir, 'usage.lock');
      fs.mkdirSync(dir, { recursive: true });
      let stale = true;
      try {
        const u = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (u.fetchedAtMs && (Date.now() - u.fetchedAtMs < 180000)) stale = false;
      } catch (_) {}
      if (stale) {
        // Lock: whoever creates/owns it refreshes; others just use the old cache
        // this tick (ccstatusline's own protocol — we share its cache file).
        let locked = false;
        try {
          const st = fs.statSync(lockFile);
          // A lock older than 30s is abandoned (crashed holder) — take it over.
          if (Date.now() - st.mtimeMs > 30000) fs.unlinkSync(lockFile);
        } catch (_) {}
        try { fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' }); locked = true; } catch (_) {}
        if (locked) {
          const credFile = path.join(os.homedir(), '.claude', '.credentials.json');
          const token = JSON.parse(fs.readFileSync(credFile, 'utf8')).claudeAiOauth.accessToken;
          refreshDone = new Promise((resolve) => {
            fetch('https://api.anthropic.com/api/oauth/usage', { headers: { authorization: 'Bearer ' + token } })
              .then((r) => r.json())
              .then((j) => {
                // Anthropic's /api/oauth/usage shape: { five_hour: { utilization },
                // seven_day: { utilization } } (verified live 2026-08). ccstatusline
                // flattens to sessionUsage/weeklyUsage in ITS cache writes; we
                // store normalized fh/wd and let the reader accept both shapes.
                try {
                  const cur = { fetchedAtMs: Date.now() };
                  const fh = j && j.five_hour && j.five_hour.utilization;
                  const wd = j && j.seven_day && j.seven_day.utilization;
                  if (typeof fh === 'number') cur.fh = fh;
                  if (typeof wd === 'number') cur.wd = wd;
                  fs.writeFileSync(cacheFile, JSON.stringify(cur));
                  fs.unlinkSync(lockFile);
                } catch (_) {}
                resolve();
              })
              .catch(() => { try { fs.unlinkSync(lockFile); } catch (_) {} resolve(); });
          });
        }
      }
    } catch (_) { /* usage refresh is best-effort, never blocks the line */ }
    // Exit when BOTH the socket forward and the (best-effort) usage refresh
    // settle — or 8s, whichever first. A flat 1.5s timer killed the fetch
    // before it resolved (endpoint latency ~2-5s), so usage never landed.
    let pending = 1; // the socket forward below
    const maybeExit = () => { if (--pending <= 0) process.exit(0); };
    if (refreshDone) { pending++; refreshDone.then(maybeExit); }
    if (sock) {
      try {
        const c = net.createConnection(sock, () => { c.end(JSON.stringify(payload) + '\\n'); });
        c.on('error', maybeExit);
        c.on('close', maybeExit);
      } catch (_) { maybeExit(); }
    } else {
      maybeExit();
    }
    setTimeout(() => process.exit(0), 8000).unref();
    return;
  }
  if (!sock) { process.exit(0); }
  let resp = '';
  const done = (code) => { if (resp) process.stdout.write(resp); process.exit(code); };
  const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\\n'));
  c.setEncoding('utf8');
  c.on('data', (d) => { resp += d; });
  c.on('end', () => done(0));
  c.on('error', () => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
`;

// ─── agy-hook shim (written to <hive>/bin/agy-hook.cjs) ──────────────────────
// Antigravity's `agy` CLI fires lifecycle hooks (PreToolUse/PostToolUse/Stop/
// PreInvocation/PostInvocation) but with a DIFFERENT stdin shape than Claude
// (conversationId / toolCall{name,args} / workspacePaths, and no hook_event_name
// — the event arrives as argv from the hooks.json command). This shim normalizes
// that into the same HookPayload the HookServer already consumes, so status,
// inbox-drain-on-Stop, and tool gating are reused UNCHANGED, then translates the
// server's Claude-shaped response back into agy's stdout contract (decision:
// allow|deny|block + a message). Scoped by AGENT_ID: a personal agy session
// (no AGENT_ID in env) is a no-op, so the global hooks.json never disturbs the
// user's own agy usage — only hive workers (spawned with AGENT_ID set) bridge.
// NOTE (agy bug, antigravity-cli#49): the loader reads ~/.gemini/antigravity-cli/
// hooks.json but the trigger reads ~/.gemini/config/hooks.json — we write BOTH.
const AGY_HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const event = process.argv[2] || 'Unknown';
const agentId = process.env.AGENT_ID || null;
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  const sock = process.env.HIVE_SOCK;
  if (!agentId || !sock) { process.exit(0); } // not a hive worker → ignore
  let agy = {};
  try { agy = JSON.parse(data || '{}'); } catch (_) {}
  const tc = agy.toolCall || {};
  const payload = {
    hook_event_name: event,
    agent_id: agentId,
    session_id: agy.conversationId,
    transcript_path: agy.transcriptPath,
    cwd: Array.isArray(agy.workspacePaths) ? agy.workspacePaths[0] : undefined,
    tool_name: tc.name,
    tool_input: tc.args
  };
  let resp = '';
  const done = () => {
    // Translate the HookServer's Claude-shaped reply into agy's contract. CRITICAL:
    // agy treats ANY object written to stdout as a decision and FAIL-CLOSES (an
    // empty/decision-less object = DENY). So emit JSON ONLY when there's a real
    // directive (deny/block/steer); otherwise write NOTHING — no output = allow.
    let out = null;
    try {
      const r = JSON.parse(resp || '{}');
      if (r.decision === 'block') out = { decision: 'block', reason: r.reason, stopReason: r.reason, systemMessage: r.reason };
      else if (r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny') out = { decision: 'deny', reason: r.hookSpecificOutput.permissionDecisionReason };
      else if (r.continue === false) out = { decision: 'block', stopReason: r.stopReason };
      else if (r.hookSpecificOutput && r.hookSpecificOutput.additionalContext) out = { systemMessage: r.hookSpecificOutput.additionalContext };
    } catch (_) {}
    if (out) { try { process.stdout.write(JSON.stringify(out)); } catch (_) {} }
    process.exit(0);
  };
  try {
    const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\\n'));
    c.setEncoding('utf8');
    c.on('data', (d) => { resp += d; });
    c.on('end', done);
    c.on('error', () => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  } catch (_) { process.exit(0); }
});
`;

// ─── pi bridge extension (written to <agentDir>/.pi-agent/extensions/) ───────
// A bundled extension for Pi (earendil-works). Pi exposes a pi.on(event,…)
// lifecycle; this posts cth-hook-shaped payloads to HIVE_SOCK on agent_start /
// tool_call / tool_result / agent_settled AND usage as CostSample on message_end
// (pi has no OTLP — without this, fleet.json shows a permanently blind row for
// pi agents), READS the socket response and injects returned additionalContext
// (queued operator steers) via pi.sendMessage({deliverAs:'steer'}), and
// AUTO-APPROVES tool calls when the spawn's permission mode grants autonomy
// (HIVE_AUTO_APPROVE, per-spawn — Pam guardrail #5). The agent_settled→Stop
// keeps the harness status in step (→ idle) so the renderer idle inbox-wake
// nudge can deliver mail. Fully wrapped so a wrong API guess can never break
// the spawn. Event shapes verified against pi 0.84.
const PI_EXTENSION = `import net from 'node:net';
const SOCK = process.env.HIVE_SOCK;
const AGENT = process.env.AGENT_ID ?? null;
// The session id comes from ctx.sessionManager.getSessionId() — the documented
// extension API (verified against pi's .d.ts). Do NOT read process.env.PI_SESSION_ID
// here: pi injects that only into BASH TOOL executions, never into the extension
// process env, so it is always undefined here (card-session-stamp-never-fires:
// that env read is why pi agents' cards never got a sessionId stamp).
function sessionOf(ctx: any): string | undefined {
  try { return ctx?.sessionManager?.getSessionId?.(); } catch { return undefined; }
}
// Pi auto-approves tools in non-interactive runs unless an extension blocks, so
// HIVE_AUTO_APPROVE needs no enforcement here — the floor's auto-state only gates
// whether the hive spawns pi with autonomy flags at all (agentProvider.ts).
// Pi reference captured at load time so the socket reader in post() can inject
// steers from any handler.
let PI: any = null;
function post(payload: Record<string, unknown>): void {
  try {
    if (!SOCK) return;
    payload.agent_id = payload.agent_id ?? AGENT;
    const c = net.createConnection(SOCK, () => { try { c.end(JSON.stringify(payload) + '\\n'); } catch {} });
    // READ THE RESPONSE: HookServer consumes queued operator steers at the hook
    // boundary and returns them as additionalContext. The old fire-and-forget
    // post ended the connection unread, so every consumed steer was silently
    // dropped — operator saw 'accepted', the agent never got it, and the
    // circuit breaker's steer/constrain message could not reach a looping pi
    // agent (card agent-operator-steers-for-pi-a-2026-08-18). Injected as a
    // custom message with deliverAs:'steer': mid-run it lands before the next
    // LLM call (agent.steer); idle, pi appends it to the session context so it
    // rides into the next turn. Never lost either way.
    let resp = '';
    c.setEncoding('utf8');
    c.on('data', (d) => { resp += d; });
    c.on('end', () => {
      try {
        const ctx = JSON.parse(resp || '{}')?.hookSpecificOutput?.additionalContext;
        if (ctx && PI) PI.sendMessage({ customType: 'hive-steer', content: ctx, display: true }, { deliverAs: 'steer' });
      } catch {}
    });
    c.on('error', () => {});
  } catch {}
}
// Pi extension shape (pi 0.84): ESM default export, structural ExtensionAPI.
export default function (pi: { on: (ev: string, fn: (event: any, ctx: any) => any) => void; sendMessage?: (message: any, options?: any) => void }) {
  PI = pi;
  // The breaker's loop detector keys on tool_name + tool_input. pi's tool_result
  // event carries no input, so a PostToolUse without one made every call of the
  // same tool look identical (10 distinct Bash calls → "8× identical tool call").
  // tool_call DOES carry it, so stash it there and attach it on the way out.
  let lastInput: unknown = undefined;
  // Turn-start signal: pi has no UserPromptSubmit hook, so without this the
  // renderer status sat at its last value from prompt arrival to the FIRST
  // tool call — every thinking phase read as idle (card
  // agent-hold-pi-provider-agents--2026-08-18). agent_start fires when a run
  // begins (and again per retry/auto-compact re-run — idempotent 'working').
  pi.on('agent_start', (_event, ctx) => {
    post({ hook_event_name: 'UserPromptSubmit', session_id: sessionOf(ctx) });
  });
  pi.on('tool_call', (event, ctx) => {
    lastInput = event?.input;
    post({ hook_event_name: 'PreToolUse', session_id: sessionOf(ctx), tool_name: event?.toolName, tool_input: event?.input });
  });
  pi.on('tool_result', (event, ctx) => {
    post({ hook_event_name: 'PostToolUse', session_id: sessionOf(ctx), tool_name: event?.toolName, tool_input: event?.input ?? lastInput });
  });
  // agent_settled, not agent_end: agent_end fires per low-level run (retries,
  // auto-compact) — settled means pi will not continue on its own. That is the
  // hive's Stop = "terminal went idle, deliver mail".
  pi.on('agent_settled', (_event, ctx) => {
    post({ hook_event_name: 'Stop', session_id: sessionOf(ctx) });
  });
  // Token usage: pi reports per-message usage on message_end (assistant
  // messages carry the model turn, toolResult messages carry subagent/summary
  // burn). Post each as a CostSample — the socket path the qwen sidecar already
  // uses — so the harness's existing plumbing feeds fleet telemetry + the cost
  // ledger with no new surface. Fields are pi's normalized usage shape
  // (input/output/cacheRead/cacheWrite); pi's own usage.cost.total is NOT
  // forwarded — the harness prices every provider through its estimate table
  // for cross-fleet comparability.
  pi.on('message_end', (event, ctx) => {
    try {
      const m = event?.message;
      if (!m || (m.role !== 'assistant' && m.role !== 'toolResult')) return;
      const u = m.usage;
      if (!u) return;
      const input = u.input ?? 0, output = u.output ?? 0;
      const cacheRead = u.cacheRead ?? 0, cacheCreation = u.cacheWrite ?? 0;
      if (!input && !output && !cacheRead && !cacheCreation) return;
      post({
        hook_event_name: 'CostSample',
        session_id: sessionOf(ctx),
        model: m.responseModel ?? m.model ?? '',
        input, output, cache_read: cacheRead, cache_creation: cacheCreation
      });
    } catch { /* telemetry must never break the turn */ }
  });
}
`;

// ─── opencode bridge plugin (written to <agentDir>/.opencode/plugin/) ────────
// A bundled plugin for OpenCode (anomalyco/opencode) — god Decision 1. OpenCode
// has no Claude-shaped Stop hook but its plugin API exposes a real session.idle
// event; this posts cth-hook-shaped payloads to HIVE_SOCK on tool.execute.before/
// after + session.idle. The session.idle→Stop keeps status in step (→ idle) so the
// renderer idle inbox-wake nudge delivers mail. ESM (OpenCode runs on Bun). Fully
// wrapped. LIVE-UNVERIFIED (plugin auto-load + session.idle firing need BYOK keys).
//
// STEER DELIVERY (card agent-opencode-qwen-crush-agen-2026-08-18, sibling of the
// pi fix 6b432b6): post() is BIDIRECTIONAL — HookServer consumes queued operator
// steers at the hook boundary and returns them as additionalContext; the plugin
// stashes them and injects them into the NEXT LLM call via
// experimental.chat.system.transform (mutate output.system in place). Both hook
// surfaces + trigger shapes VERIFIED against the installed opencode 1.1.55
// binary (embedded plugin doc + the LLMRequestPrep/agent-loop trigger sites).
const OPENCODE_PLUGIN = `import { createConnection } from 'node:net';
const SOCK = process.env.HIVE_SOCK;
const AGENT = process.env.AGENT_ID || null;
// A steer consumed at a hook boundary lands here and rides the NEXT LLM call's
// system prompt. Accumulate in case two boundaries fire before the next call.
let pendingSteer = null;
function post(payload) {
  try {
    if (!SOCK) return;
    payload.agent_id = payload.agent_id || AGENT;
    const c = createConnection(SOCK, () => { try { c.end(JSON.stringify(payload) + '\\n'); } catch (e) {} });
    // READ THE RESPONSE: the old fire-and-forget post ended the connection
    // unread, so a steer the HookServer consumed for an opencode agent was
    // silently dropped — operator saw 'accepted', the agent never got it, and
    // the circuit breaker could not reach a looping opencode agent.
    let resp = '';
    if (c.setEncoding) c.setEncoding('utf8');
    c.on('data', (d) => { resp += d; });
    c.on('end', () => {
      try {
        const out = JSON.parse(resp || '{}').hookSpecificOutput;
        const text = out && out.additionalContext;
        if (text) pendingSteer = pendingSteer ? pendingSteer + '\\n\\n' + text : text;
      } catch (e) {}
    });
    c.on('error', () => {});
  } catch (e) {}
}
function promptOf(output) {
  try {
    const parts = (output && output.parts) || [];
    const texts = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p && p.type === 'text' && typeof p.text === 'string' && p.text.trim()) texts.push(p.text);
    }
    return texts.length ? texts.join('\\n') : undefined;
  } catch (e) { return undefined; }
}
export const HiveBridge = async () => {
  // OpenCode exposes call args only as tool.execute.before's output.args; after
  // keeps the same callID but exposes result output/metadata instead. Preserve
  // the args by callID so concurrent tool calls stay correctly associated.
  const toolInputs = new Map();
  return {
    event: async (input) => {
      try { if (input && input.event && input.event.type === 'session.idle') post({ hook_event_name: 'Stop' }); } catch (e) {}
    },
    // Turn-start boundary (opencode's UserPromptSubmit analog, trigger shape
    // verified on the 1.1.55 binary): the earliest steer-consume window of the
    // turn, with the prompt text so the synthetic-wake gate can classify it.
    'chat.message': async (input, output) => {
      try { post({ hook_event_name: 'UserPromptSubmit', session_id: input && input.sessionID, prompt: promptOf(output) }); } catch (e) {}
    },
    'tool.execute.before': async (input, output) => {
      try {
        const toolInput = output?.args ?? null;
        if (input?.callID) toolInputs.set(input.callID, toolInput);
        post({ hook_event_name: 'PreToolUse', tool_name: input && (input.tool || input.name), tool_input: toolInput });
      } catch (e) {}
    },
    'tool.execute.after': async (input) => {
      try {
        const toolInput = input?.callID ? toolInputs.get(input.callID) ?? null : null;
        if (input?.callID) toolInputs.delete(input.callID);
        post({ hook_event_name: 'PostToolUse', tool_name: input && (input.tool || input.name), tool_input: toolInput });
      } catch (e) {}
    },
    // Mid-run steer delivery: fires in LLMRequestPrep before EVERY LLM call
    // (trigger verified on the 1.1.55 binary — output.system is the system-
    // prompt string array, mutated in place). The steer rides exactly one LLM
    // call — same deliver-once semantics as pi's sendMessage(deliverAs:'steer').
    'experimental.chat.system.transform': async (input, output) => {
      try {
        if (!pendingSteer || !output || !Array.isArray(output.system)) return;
        output.system.push('<hive-steer>\\n' + pendingSteer + '\\n</hive-steer>');
        pendingSteer = null;
      } catch (e) {}
    }
  };
};
export default HiveBridge;
`;

// ─── proxy-bridge sidecar (written to <hive>/bin/hive-proxy.cjs) ─────────────
// One per proxy-tier agent (qwen). A dependency-free, loopback-only reverse
// proxy: the agent's CLI is pointed at this (via ANTHROPIC_BASE_URL/OPENAI_BASE_URL),
// and it forwards every request to the user's real upstream UNCHANGED (headers,
// body, streaming). It TEES each response to synthesize the same HIVE_SOCK payloads
// the hook shims emit — Status (context gauge), PostToolUse (breaker), Stop (idle
// drain), and the new CostSample (cost ledger) — so a hookless CLI becomes a hive
// citizen. NEVER logs bodies or keys; the captured body is parsed in-memory and
// dropped. Idle is heuristic: a turn that ends with no tool call and no new request
// within an ~800ms debounce → Stop (a new request cancels it).
//
// STEER DELIVERY (card agent-opencode-qwen-crush-agen-2026-08-18, sibling of the
// pi fix 6b432b6): the synthesized PostToolUse is BIDIRECTIONAL — HookServer
// consumes the queued operator steer and returns it as additionalContext — and
// the sidecar injects it into the NEXT chat request as a synthetic trailing user
// message (openai wire) / text block appended to the trailing user message
// (anthropic wire, keeps role alternation valid). Mid-run delivery without any
// hook surface; delivered once, never logged.
const PROXY_BRIDGE_SHIM = `#!/usr/bin/env node
'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const { URL } = require('url');

const SOCK = process.env.HIVE_SOCK;
const AGENT_ID = process.env.AGENT_ID || null;
const UPSTREAM = process.env.UPSTREAM_BASE_URL || '';
const SESSION = process.env.HIVE_PROXY_SESSION || null;
const API = process.env.HIVE_PROXY_API === 'anthropic' ? 'anthropic' : 'openai';

function trimSlash(s) { while (s.length && s.charAt(s.length - 1) === '/') s = s.slice(0, -1); return s; }

// Per-model context-window size for the Status gauge; fallback 200k.
function ctxSize(model) {
  const m = String(model || '').toLowerCase();
  if (m.indexOf('[1m]') !== -1 || m.indexOf('-1m') !== -1) return 1000000;
  if (m.indexOf('claude') !== -1) return 200000;
  if (m.indexOf('gpt-4o') !== -1 || m.indexOf('gpt-4.1') !== -1 || m.indexOf('o1') !== -1 || m.indexOf('o3') !== -1) return 128000;
  if (m.indexOf('qwen') !== -1) return 262144;
  return 200000;
}

// Fire-and-forget emit of a shim-shaped payload to the hive socket. Never throws.
function emit(payload) {
  if (!SOCK) return;
  try {
    const c = net.createConnection(SOCK, function () { c.end(JSON.stringify(payload) + '\\n'); });
    c.on('error', function () {});
  } catch (e) {}
}

// Bidirectional emit for the steer-consume boundary: HookServer returns the
// consumed operator steer as hookSpecificOutput.additionalContext on the socket
// response. Stash it; the next chat request carries it upstream (see the
// createServer handler). Fire-and-forget emit() stays for pure telemetry.
let pendingSteer = null;
function emitAsk(payload) {
  if (!SOCK) return;
  try {
    const c = net.createConnection(SOCK, function () { try { c.end(JSON.stringify(payload) + '\\n'); } catch (e) {} });
    let resp = '';
    c.setEncoding('utf8');
    c.on('data', function (d) { resp += d; });
    c.on('end', function () {
      try {
        const out = JSON.parse(resp || '{}').hookSpecificOutput;
        const text = out && out.additionalContext;
        if (text) pendingSteer = pendingSteer ? pendingSteer + '\\n\\n' + text : text;
      } catch (e) {}
    });
    c.on('error', function () {});
  } catch (e) {}
}

let stopTimer = null;
function armStop() {
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = setTimeout(function () {
    stopTimer = null;
    emit({ hook_event_name: 'Stop', agent_id: AGENT_ID, session_id: SESSION });
  }, 800);
  if (stopTimer.unref) stopTimer.unref();
}
function cancelStop() { if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; } }

function safeArgs(s) {
  if (s == null) return {};
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (e) { return { _raw: String(s).slice(0, 500) }; }
}

// Parse a completed response (single JSON or an SSE stream) and synthesize events.
function parseAndEmit(bodyStr, isSse) {
  const objs = [];
  if (isSse) {
    const lines = bodyStr.split('\\n');
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const idx = ln.indexOf('data:');
      if (idx === -1) continue;
      const data = ln.slice(idx + 5).trim();
      if (!data || data === '[DONE]') continue;
      try { objs.push(JSON.parse(data)); } catch (e) {}
    }
  } else {
    try { objs.push(JSON.parse(bodyStr)); } catch (e) {}
  }
  if (!objs.length) { armStop(); return; }

  let model = null, input = 0, output = 0, cacheRead = 0, cacheCreation = 0, sawUsage = false;
  const toolCalls = [];
  const oaiTools = {}; // accumulate streaming openai tool_calls by index

  for (let i = 0; i < objs.length; i++) {
    const o = objs[i];
    if (!o || typeof o !== 'object') continue;
    if (o.model) model = o.model;
    if (API === 'anthropic') {
      if (o.type === 'message_start' && o.message) {
        if (o.message.model) model = o.message.model;
        const u = o.message.usage || {};
        input += u.input_tokens || 0;
        cacheRead += u.cache_read_input_tokens || 0;
        cacheCreation += u.cache_creation_input_tokens || 0;
        sawUsage = true;
      } else if (o.type === 'message_delta' && o.usage) {
        output += o.usage.output_tokens || 0;
        sawUsage = true;
      } else if (o.type === 'content_block_start' && o.content_block && o.content_block.type === 'tool_use') {
        toolCalls.push({ name: o.content_block.name, input: o.content_block.input || {} });
      } else if (o.usage && !o.type) {
        // non-streaming full message body
        const u = o.usage;
        input += u.input_tokens || 0;
        output += u.output_tokens || 0;
        cacheRead += u.cache_read_input_tokens || 0;
        cacheCreation += u.cache_creation_input_tokens || 0;
        sawUsage = true;
      }
      if (Array.isArray(o.content)) {
        for (let j = 0; j < o.content.length; j++) {
          const blk = o.content[j];
          if (blk && blk.type === 'tool_use') toolCalls.push({ name: blk.name, input: blk.input || {} });
        }
      }
    } else {
      if (o.usage) {
        const u = o.usage;
        input += u.prompt_tokens || 0;
        output += u.completion_tokens || 0;
        if (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) cacheRead += u.prompt_tokens_details.cached_tokens;
        sawUsage = true;
      }
      const choices = o.choices || [];
      for (let c = 0; c < choices.length; c++) {
        const ch = choices[c];
        if (!ch) continue;
        if (ch.message && Array.isArray(ch.message.tool_calls)) {
          for (let t = 0; t < ch.message.tool_calls.length; t++) {
            const tc = ch.message.tool_calls[t];
            if (tc && tc.function) toolCalls.push({ name: tc.function.name, input: safeArgs(tc.function.arguments) });
          }
        }
        if (ch.delta && Array.isArray(ch.delta.tool_calls)) {
          for (let t = 0; t < ch.delta.tool_calls.length; t++) {
            const tc = ch.delta.tool_calls[t];
            if (!tc) continue;
            const k = (tc.index != null ? tc.index : t);
            if (!oaiTools[k]) oaiTools[k] = { name: null, args: '' };
            if (tc.function) {
              if (tc.function.name) oaiTools[k].name = tc.function.name;
              if (tc.function.arguments) oaiTools[k].args += tc.function.arguments;
            }
          }
        }
      }
    }
  }
  const keys = Object.keys(oaiTools);
  for (let i = 0; i < keys.length; i++) {
    const t = oaiTools[keys[i]];
    if (t.name) toolCalls.push({ name: t.name, input: safeArgs(t.args) });
  }

  if (sawUsage) {
    emit({ hook_event_name: 'Status', agent_id: AGENT_ID, context_window: { total_input_tokens: input + cacheRead + cacheCreation, context_window_size: ctxSize(model) } });
    emit({ hook_event_name: 'CostSample', agent_id: AGENT_ID, session_id: SESSION, model: model, input: input, output: output, cache_read: cacheRead, cache_creation: cacheCreation });
  }
  if (toolCalls.length) {
    cancelStop(); // a tool call means the turn continues
    for (let i = 0; i < toolCalls.length; i++) {
      // Bidirectional: this boundary is where HookServer consumes a queued
      // operator steer; the response's additionalContext is stashed and rides
      // the next chat request upstream.
      emitAsk({ hook_event_name: 'PostToolUse', agent_id: AGENT_ID, session_id: SESSION, tool_name: toolCalls[i].name, tool_input: toolCalls[i].input });
    }
  } else {
    armStop();
  }
}

let upstreamUrl = null;
try { upstreamUrl = new URL(UPSTREAM); } catch (e) {}

const server = http.createServer(function (req, res) {
  cancelStop(); // a new request means the turn is still going
  if (!upstreamUrl) { res.statusCode = 502; res.end('proxy: no upstream'); return; }
  let target;
  try { target = new URL(trimSlash(UPSTREAM) + req.url); } catch (e) { res.statusCode = 502; res.end('proxy: bad url'); return; }
  const isHttps = target.protocol === 'https:';
  const lib = isHttps ? https : http;
  const headers = Object.assign({}, req.headers);
  headers.host = target.host;
  // Ask upstream for plaintext so the tee can parse SSE/JSON reliably; the client
  // gets uncompressed bytes (loopback — negligible) and no content-encoding to undo.
  delete headers['accept-encoding'];
  const opts = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    method: req.method,
    path: target.pathname + target.search,
    headers: headers
  };
  const send = function (bodyBuf) {
    if (bodyBuf) {
      // The buffered body replaces the stream: fix length framing.
      opts.headers['content-length'] = String(bodyBuf.length);
      delete opts.headers['transfer-encoding'];
    }
    const upReq = lib.request(opts, function (upRes) {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      const ct = String((upRes.headers['content-type'] || ''));
      const wantParse = ct.indexOf('json') !== -1 || ct.indexOf('event-stream') !== -1;
      const isSse = ct.indexOf('event-stream') !== -1;
      const chunks = [];
      let total = 0;
      upRes.on('data', function (chunk) {
        res.write(chunk); // stream straight through to the CLI
        if (wantParse && total < 4194304) { chunks.push(chunk); total += chunk.length; }
      });
      upRes.on('end', function () {
        res.end();
        if (wantParse && chunks.length) {
          try { parseAndEmit(Buffer.concat(chunks).toString('utf8'), isSse); } catch (e) {}
        }
      });
      upRes.on('error', function () { try { res.end(); } catch (e) {} });
    });
    upReq.on('error', function () { try { res.statusCode = 502; res.end('proxy: upstream error'); } catch (e) {} });
    if (bodyBuf) upReq.end(bodyBuf);
    else req.pipe(upReq);
  };
  // Steer injection: a steer consumed at the synthesized PostToolUse boundary
  // rides the NEXT chat request as a synthetic trailing user message. Buffer
  // the body only when a steer is pending AND the request can carry one —
  // everything else keeps the zero-copy pipe. ponytail: full-body buffer,
  // no streaming rewrite — loopback bodies are transient; add streaming if a
  // >100MB session ever makes this bite.
  const reqCt = String(req.headers['content-type'] || '');
  const canInject = pendingSteer !== null && req.method === 'POST' && reqCt.indexOf('json') !== -1 && !req.headers['content-encoding'];
  if (!canInject) { send(null); return; }
  const reqChunks = [];
  req.on('data', function (d) { reqChunks.push(d); });
  req.on('end', function () {
    const raw = Buffer.concat(reqChunks);
    let body = null;
    try {
      const parsed = JSON.parse(raw.toString('utf8'));
      if (parsed && Array.isArray(parsed.messages) && parsed.messages.length) {
        if (API === 'anthropic') {
          // Anthropic requires strict user/assistant alternation: append the
          // steer as a text block on the trailing user message (a tool_result
          // turn ends with one); only push a fresh user message when there is
          // none to extend.
          const last = parsed.messages[parsed.messages.length - 1];
          if (last && last.role === 'user') {
            if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
            if (Array.isArray(last.content)) last.content.push({ type: 'text', text: pendingSteer });
          } else {
            parsed.messages.push({ role: 'user', content: [{ type: 'text', text: pendingSteer }] });
          }
        } else {
          parsed.messages.push({ role: 'user', content: pendingSteer });
        }
        body = Buffer.from(JSON.stringify(parsed), 'utf8');
        pendingSteer = null;
      }
    } catch (e) {} // not JSON / not a chat request: keep the steer, forward as-is
    send(body || raw);
  });
});

server.on('error', function () {
  try { process.stdout.write(JSON.stringify({ port: 0 }) + '\\n'); } catch (e) {}
  process.exit(0);
});
server.listen(0, '127.0.0.1', function () {
  const addr = server.address();
  const port = (addr && typeof addr === 'object') ? addr.port : 0;
  try { process.stdout.write(JSON.stringify({ port: port }) + '\\n'); } catch (e) {}
});
`;

// ─── grok-hook shim (written to <hive>/bin/grok-hook.cjs) ───────────────────
// Grok's lifecycle events and decisions are Claude-compatible, but the wire
// payload is camelCase and uses snake_case event values. Normalize the input for
// HookServer and translate its Claude-style permission denial into Grok's direct
// decision form. Scoped by AGENT_ID so the trusted global hook is inert outside
// Munder-spawned workers.
const GROK_HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const agentId = process.env.AGENT_ID || null;
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  const sock = process.env.HIVE_SOCK;
  if (!agentId || !sock) { process.exit(0); }
  let grok = {};
  try { grok = JSON.parse(data || '{}'); } catch (_) {}
  const names = {
    pre_tool_use: 'PreToolUse',
    post_tool_use: 'PostToolUse',
    post_tool_use_failure: 'PostToolUseFailure',
    permission_denied: 'PermissionDenied',
    stop: 'Stop',
    stop_failure: 'StopFailure',
    session_start: 'SessionStart',
    session_end: 'SessionEnd',
    user_prompt_submit: 'UserPromptSubmit',
    notification: 'Notification',
    subagent_start: 'SubagentStart',
    subagent_stop: 'SubagentStop',
    pre_compact: 'PreCompact',
    post_compact: 'PostCompact'
  };
  const payload = {
    hook_event_name: names[grok.hookEventName] || grok.hookEventName || 'Unknown',
    agent_id: agentId,
    session_id: grok.sessionId,
    cwd: grok.cwd || grok.workspaceRoot,
    tool_name: grok.toolName,
    tool_input: grok.toolInput,
    stop_hook_active: grok.stopHookActive,
    prompt: grok.prompt,
    source: grok.source,
    notification_type: grok.notificationType,
    message: grok.message
  };
  let resp = '';
  const done = () => {
    let out = null;
    try {
      const r = JSON.parse(resp || '{}');
      if (r.continue === false) out = { continue: false, stopReason: r.stopReason };
      else if (r.decision === 'block') out = { decision: 'block', reason: r.reason };
      else if (r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny') {
        out = { decision: 'deny', reason: r.hookSpecificOutput.permissionDecisionReason };
      } else if (r.hookSpecificOutput && r.hookSpecificOutput.additionalContext) {
        out = r;
      }
    } catch (_) {}
    if (out) { try { process.stdout.write(JSON.stringify(out)); } catch (_) {} }
    process.exit(0);
  };
  try {
    const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\\n'));
    c.setEncoding('utf8');
    c.on('data', (d) => { resp += d; });
    c.on('end', done);
    c.on('error', () => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  } catch (_) { process.exit(0); }
});
`;
