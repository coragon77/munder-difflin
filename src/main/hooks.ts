/**
 * HookServer — the bridge between `claude` lifecycle hooks and the harness.
 *
 * Each spawned agent is launched with `--settings` pointing its hooks at a tiny
 * shim (see HOOK_SHIM in hive.ts) that forwards the hook payload to the Unix
 * domain socket this server listens on. We then:
 *   - drive avatar state from PreToolUse/PostToolUse/Notification/etc., and
 *   - report lifecycle boundaries while renderer-side guarded queues deliver
 *     inbox work only after the session reaches a safe idle prompt.
 *
 * Runs in the Electron main process.
 */
import { createServer, type Server } from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { Notification, type WebContents } from 'electron';
import type { HiveManager } from './hive';
import type { AgentProvider } from '../shared/agentProvider';
import type { HarnessConfig } from './config';
import type { ControlRegistry } from './control';
import type { CircuitBreaker } from './breaker';
import type { TelemetryCollector } from './telemetry';
import type { PendingWorkTracker } from './pendingWork';
import { waitingLabel } from '../shared/waitingLabel';
import { estimateCostUsd } from './pricing';
import { bridgeDeliversHookContext } from '../shared/agentProvider';
import { hasInboxMonitor } from '../shared/providerAutomation';
import { sharedStateGate } from './hiveGate';

interface HookPayload {
  hook_event_name?: string;
  agent_id?: string | null;
  session_id?: string;
  transcript_path?: string;
  /** Status-line payloads only: the session's live context accounting. */
  context_window?: { total_input_tokens?: number; context_window_size?: number };
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
  stop_hook_active?: boolean;
  prompt?: string;
  source?: string;
  notification_type?: string;
  /** Notification hook text, e.g. "Claude is waiting for your input" (idle) vs a
   *  permission request. Used to tell "needs you" from "just done / lingering". */
  message?: string;
  /** CostSample payloads only (synthesized by the proxy-bridge sidecar for
   *  qwen). Raw token counts for one response, fed to the cost ledger. */
  model?: string;
  input?: number;
  output?: number;
  cache_read?: number;
  cache_creation?: number;
  /** Stop payloads only (claude 2.1.x): the live background-task registry
   *  snapshot — running+backgrounded shells, subagents, workflows, monitors,
   *  teammates… — the pending-work census for the house busy signal (card
   *  agent-harness-busy-signal-coun-2026-08-17). Shape per Kjp():
   *  {id, type, status, description, …}. */
  background_tasks?: unknown;
  /** PostToolUse payloads carry the tool's result — Monitor's is
   *  {taskId, timeoutMs, persistent?}, the arm-time classification the census
   *  uses to exclude never-completing (persistent) monitors. */
  tool_response?: { taskId?: unknown; persistent?: boolean };
}

/** Card agent-sessionstart-must-tell-e-2026-08-19. A harness restart (the
 *  operator's KILL button) kills every agent's inbox monitor silently — the
 *  Monitor-tool task dies with the agent's session, the deferred tool list
 *  resets, and NOTHING tells the agent: an agent stalling on a doing card is
 *  caught by the standup's stalled detector, a dead inbox monitor is caught
 *  by nothing (the typed-nudge fallback covers the unread-mail symptom but
 *  never names the cause). So the SessionStart boundary says it plainly:
 *  fresh session → the old monitor is dead → rearm now. Pinned by
 *  test/sessionstart-rearm.test.cjs; capability-gated by hasInboxMonitor so
 *  providers with no agent-armable wake primitive (pi, codex, …) get no noise
 *  — their typed nudge IS the mechanism. No duplicate of the arming command
 *  (it lives in the system prompt's INBOX WAKE clause, re-applied on every
 *  respawn): two copies would drift apart. No restart-vs-first-start branch:
 *  SessionStart `source` is optional and shim-dependent, and the action is
 *  identical either way — "unless you armed it in THIS session" makes one
 *  literal correct for startup, resume and clear alike. */
const SESSION_START_REARM =
  'INBOX MONITOR — this is a FRESH session: the inbox monitor you armed in any earlier session is DEAD (a restart or session clear kills every Monitor task silently — nothing else will tell you). REARM it NOW — unless you armed it in THIS session — using the INBOX WAKE command in your system prompt (a redundant arm is cheaper than a missed one). If you cannot arm it, do nothing: the typed nudge remains the fallback.';

/** The rearm line for an agent's provider — null when the provider has no
 *  agent-armable inbox monitor (capability absent, never a default). */
function sessionStartRearmFor(provider: AgentProvider | undefined): string | null {
  return provider !== undefined && hasInboxMonitor(provider) ? SESSION_START_REARM : null;
}

export class HookServer {
  private server: Server | null = null;
  /** agentId → the live session's transcript file, learned from hook payloads.
   *  Lets the harness read per-agent telemetry (e.g. current context size)
   *  even when several agents share one cwd. */
  private transcriptPaths = new Map<string, string>();
  /** agentId → the latest context-window accounting from the statusLine shim
   *  (current tokens + the REAL window size — 200k vs 1M, which nothing else
   *  exposes). The renderer already gets this pushed live on `hive:contextUpdate`;
   *  we also retain the last value here so a main-side read (the voice read-layer's
   *  get_agent_detail / list_agents) can report "how full is each agent's context"
   *  without depending on a renderer round-trip. */
  private contextById = new Map<string, { tokens: number; limit: number; ts: number }>();
  /** agentId → already surfaced a loud "steer backlog cannot be delivered" notice
   *  for the CURRENT episode (card agent-operator-steers-for-pi-a-2026-08-18).
   *  Cleared when a hook sees the backlog drained, so a FRESH steer after a
   *  clear/delivery notifies again instead of staying silent. */
  private steerBacklogNotified = new Set<string>();

  constructor(
    private hive: HiveManager,
    private getWebContents: () => WebContents | null,
    private getConfig: () => HarnessConfig,
    /** #7C — operator control state. Optional so tests can omit it. */
    private control?: ControlRegistry,
    /** Circuit breaker (Lane A #6.6b) — fed the hook-derived signals (session id,
     *  repeated identical tool calls). Optional so the server still runs without it. */
    private breaker?: CircuitBreaker,
    /** Telemetry sink for the hook plane (non-Claude providers — pi, agy, grok,
     *  opencode, qwen sidecar — have no OTLP; their hook payloads are their ONLY
     *  telemetry). Optional so tests can omit it. Claude agents keep OTLP as
     *  their source; the collector overlays OTLP over these rows. */
    /** Telemetry sink for the hook plane (non-Claude providers — pi, agy, grok,
     *  opencode, qwen sidecar — have no OTLP; their hook payloads are their ONLY
     *  telemetry). Optional so tests can omit it. Claude agents keep OTLP as
     *  their source; the collector overlays OTLP over these rows. */
    private telemetry?: TelemetryCollector,
    /** Pending-background-work census (waiting ≠ idle). Optional so tests can
     *  omit it — the tracker itself is the single source both busy gates read. */
    private pendingWork?: PendingWorkTracker,
  ) {}

  start(): void {
    const sock = this.hive.sockPath();
    if (!sock || this.server) return;
    // Clear a stale socket file left by a previous run.
    try {
      if (existsSync(sock)) rmSync(sock);
    } catch {
      /* noop */
    }

    this.server = createServer((conn) => {
      let buf = '';
      conn.on('data', (d) => {
        buf += d.toString();
        const nl = buf.indexOf('\n');
        if (nl === -1) return; // wait for the full line
        let payload: HookPayload = {};
        try {
          payload = JSON.parse(buf.slice(0, nl));
        } catch {
          /* ignore */
        }
        let res: unknown = {};
        try {
          res = this.handle(payload);
        } catch {
          res = {};
        }
        conn.end(JSON.stringify(res ?? {}));
      });
      conn.on('error', () => {
        /* shim hung up — ignore */
      });
    });
    this.server.on('error', (e) => console.error('[hive] hook server error:', e));
    this.server.listen(sock);
  }

  stop(): void {
    try {
      this.server?.close();
    } catch {
      /* noop */
    }
    this.server = null;
    const sock = this.hive.sockPath();
    try {
      if (sock && existsSync(sock)) rmSync(sock);
    } catch {
      /* noop */
    }
  }

  /** The transcript file of an agent's CURRENT session, if any hook has fired. */
  transcriptPath(agentId: string): string | undefined {
    return this.transcriptPaths.get(agentId);
  }

  /** The latest context-window accounting for an agent (current tokens + the real
   *  window size), or undefined if no statusLine tick has fired for it yet. */
  contextFor(agentId: string): { tokens: number; limit: number; ts: number } | undefined {
    return this.contextById.get(agentId);
  }

  private handle(p: HookPayload): unknown {
    const agentId = p.agent_id ?? undefined;
    const event = p.hook_event_name ?? 'Unknown';
    if (agentId && typeof p.transcript_path === 'string' && p.transcript_path) {
      this.transcriptPaths.set(agentId, p.transcript_path);
    }
    // Liveness for every provider: any hook event means the agent is alive, so
    // fleet.json's lastActiveSecAgo stops reading null for non-Claude agents
    // (their hooks are their only telemetry — see TelemetryCollector).
    if (agentId) this.telemetry?.recordHookActivity(agentId);

    // Session boundaries reset the pending-work census (card
    // agent-harness-busy-signal-coun-2026-08-17): a fresh conversation
    // inherits no stale census, and the dead session's persistent-monitor ids
    // die with it (the new session re-arms and re-classifies within minutes).
    if ((event === 'SessionStart' || event === 'SessionEnd') && agentId) {
      this.pendingWork?.resetAgent(agentId);
    }

    // Status-line payloads carry the session's EXACT context accounting —
    // current tokens AND the real window size (200k vs 1M, which nothing else
    // exposes). Forward to the renderer for the agent-card context gauge.
    // Handled FIRST and returned early: this is pure telemetry from the
    // statusLine shim, not a real hook boundary — it must never trip the
    // HALT gate or feed the breaker's loop detector below. The early return
    // also (deliberately) skips recordSession for status ticks: a statusLine
    // payload's session_id adds nothing the real hooks don't already record,
    // and telemetry should never write to the registry. transcript_path IS
    // still captured above, where every payload shape benefits from it.
    if (event === 'Status') {
      const cw = p.context_window;
      if (
        agentId &&
        cw &&
        typeof cw.total_input_tokens === 'number' &&
        typeof cw.context_window_size === 'number' &&
        cw.context_window_size > 0
      ) {
        // Retain for main-side reads (voice get_agent_detail / list_agents) …
        this.contextById.set(agentId, {
          tokens: cw.total_input_tokens,
          limit: cw.context_window_size,
          ts: Date.now(),
        });
        // … and forward live to the renderer's agent-card context gauge.
        this.getWebContents()?.send('hive:contextUpdate', {
          agentId,
          tokens: cw.total_input_tokens,
          limit: cw.context_window_size,
        });
      }
      return {};
    }

    // 7C.3 — a graceful operator HALT overrides everything (incl. the inbox
    // drain below): stop the agent CLEANLY at this hook boundary rather than
    // killing the PTY. session_id is in the payload for a later --resume.
    if (agentId && this.control?.shouldHalt(agentId)) {
      this.emit(agentId, event, p);
      return { continue: false, stopReason: 'Halted by the operator from the floor.' };
    }

    // Capture the Claude Code session id for idempotent --resume + cost dedup
    // (Lane A #6.6a). Cheap: recordSession writes only when it changes.
    if (agentId && p.session_id) this.hive.recordSession(agentId, p.session_id);

    // CostSample — synthesized by the proxy-bridge sidecar (qwen) and the pi
    // bridge extension on every response with usage. Persist it to the SAME cost
    // ledger as Claude's OTel path, keyed by the synthesized session_id, then
    // return early so cost stays OUT of the Claude-only OTel/breaker/drain paths
    // below. `usd` is the fallback per-model estimate (a local model normally
    // costs ~$0, but the row keeps the accounting schema uniform). Pure telemetry
    // — never feeds the loop detector. Also forwarded to the telemetry collector
    // so fleet.json shows these agents' tokens (snapshot-only, never the locked
    // getAgentUsage seam).
    if (event === 'CostSample') {
      const input = p.input ?? 0;
      const output = p.output ?? 0;
      const cacheRead = p.cache_read ?? 0;
      const cacheCreation = p.cache_creation ?? 0;
      if (agentId && p.session_id) {
        this.hive.appendCostLedger({
          agentId,
          sessionId: p.session_id,
          ts: Date.now(),
          input,
          output,
          cacheRead,
          cacheCreation,
          model: p.model ?? '',
          usd: estimateCostUsd(p.model, {
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheCreation,
          }),
        });
      }
      if (agentId) {
        this.telemetry?.recordHookUsage(agentId, p.session_id ?? '', {
          input,
          output,
          cacheRead,
          cacheCreation,
          model: p.model ?? '',
        });
      }
      return {};
    }

    // Feed the breaker its hook-derived loop signal: a tool that actually ran.
    // A repeated identical (name+input) PostToolUse is the runaway-loop tell.
    // The same event is the ONLY tool signal non-Claude providers have — forward
    // it to the telemetry collector too (lastTool + span waterfall + the
    // breaker's progress leg both read that ring).
    if (event === 'PostToolUse' && agentId) {
      this.breaker?.recordToolUse(agentId, p.tool_name, p.tool_input);
      if (p.tool_name) this.telemetry?.recordHookSpan(agentId, p.tool_name);
      // Monitor arm-time classification: the census excludes persistent
      // (never-completing) monitors by the taskId learned HERE — counting them
      // would make the whole floor permanently busy and no clear/park would
      // ever fire. One-shot monitors (persistent false/absent) still count.
      if (p.tool_name === 'Monitor') {
        this.pendingWork?.recordMonitorArm(
          agentId,
          p.tool_response?.taskId,
          p.tool_response?.persistent === true,
        );
      }
    }

    // Compaction exemption (issue #109): PreCompact opens it so the compaction
    // token burst can't trip the Δoutput arms; PostCompact — or any SessionStart,
    // since a fresh session makes in-flight compaction state moot — closes it
    // down to the trailing grace (a no-op when nothing was compacting).
    if (event === 'PreCompact' && agentId) this.breaker?.recordCompactStart(agentId);
    if ((event === 'PostCompact' || event === 'SessionStart') && agentId) {
      this.breaker?.recordCompactEnd(agentId);
    }

    if ((event === 'Stop' || event === 'SubagentStop') && agentId) {
      // The census refreshes at every SETTLE — exactly when the idle gates
      // evaluate. Stop only: SubagentStop's agent_id is claude's internal
      // subagent id, not the hive agent, so its snapshot would key garbage.
      let pendingWorkCount: number | undefined;
      if (event === 'Stop') {
        this.pendingWork?.recordSettle(agentId, p.background_tasks);
        pendingWorkCount = this.pendingWork?.countFor(agentId);
      }
      // Respect any upstream Stop hook that already re-entered this boundary.
      if (p.stop_hook_active) {
        this.emit(agentId, event, p, false, pendingWorkCount);
        return {};
      }
      // Never turn unread hive mail into a forced continuation at Stop. That old
      // path bypassed terminal-draft/HITL safety and could spend credits while a
      // user was answering a question. Inbox files remain durable; the renderer
      // wakes the agent later through its guarded idle-only delivery path.
      this.notify(
        agentId ?? 'Agent',
        pendingWorkCount && pendingWorkCount > 0
          ? `finished — ${waitingLabel(pendingWorkCount)}`
          : 'finished — idle',
      );
      this.emit(agentId, event, p, false, pendingWorkCount);
      return {};
    }

    // 7C.1 — HITL gate: deny a tool call at the PreToolUse boundary when the
    // agent is paused or this tool is gated. Race-free (immediate return, no
    // renderer round-trip → can't hit the shim timeout). Slow human APPROVAL is
    // deliberately left to Claude's native permission prompt.
    if (event === 'PreToolUse' && agentId && this.control) {
      const d = this.control.toolDecision(agentId, p.tool_name ?? '');
      if (d.deny) {
        this.emitControl(agentId, p.tool_name, d.reason);
        this.emit(agentId, event, p);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: d.reason ?? 'Denied by operator.',
          },
        };
      }
    }

    // Shared-state gate (card agent-pretooluse-hook-refuse-g-2026-08-19, R3
    // tighten agent-hook-r3-refuse-all-non-p-2026-08-19): ALL of god's
    // non-primitive access to shared hive state (tasks.json / registry.json /
    // fleet.json and the vacation/spawn/fire request drop-dirs) — reads AND
    // writes — is REFUSED at the PreToolUse boundary; the message names the
    // bin/hive-* primitive to use instead. God-only by design — workers never
    // touch these files (single-writer dirs), and the primitives themselves
    // pass because the gate inspects the COMMAND, not the file. No override
    // exists.
    if (event === 'PreToolUse' && agentId && this.hive.isGod(agentId)) {
      const gate = sharedStateGate({
        toolName: p.tool_name ?? '',
        toolInput: p.tool_input,
        hiveRoot: this.hive.root(),
        cwd: typeof p.cwd === 'string' ? p.cwd : undefined,
      });
      if (gate) {
        this.emitControl(agentId, p.tool_name, gate.reason);
        this.emit(agentId, event, p);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: gate.reason,
          },
        };
      }
    }

    // 7C.4 — synthetic-wake gate (transcript-pollution card, E1): a background
    // task-notification delivered as a queued user prompt is machine-generated —
    // it needs neither the roster line below nor a steer take (measured ~43k
    // tok/session of injected boilerplate on a busy god). takeSteer() is
    // DESTRUCTIVE (delivered-once queue): on a gated wake it must NEVER run, or
    // queued operator guidance is silently swallowed. ONLY ^<task-notification>
    // gates (god-ratified pass-list: hive inbox nudges, Telegram <channel>,
    // <agent-message> all pass — 0 false positives over 2033 real prompts,
    // intern corpus 2026-08-17). The event is still emitted below so
    // avatars/telemetry stay live.
    // A turn whose ENTIRE content is a <system-reminder> (the "user named this
    // session" event) is a system event by the same argument — but only when it
    // is the whole prompt: a reminder appended to real typing is a real prompt.
    const syntheticWake =
      event === 'UserPromptSubmit' &&
      (/^\s*<task-notification/.test(p.prompt ?? '') ||
        /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/.test(p.prompt ?? ''));

    // 7C.2 — mid-run steering: inject queued operator guidance as context on the
    // next eligible hook (no fragile typing into the TUI). Delivered once.
    // Merged with the roster line below so the two injections never displace each
    // other (only ONE additionalContext can be returned per hook).
    //
    // takeSteer() is DESTRUCTIVE, so consume ONLY when the agent's bridge reads
    // this very response and injects the context (card agent-operator-steers-
    // for-pi-a-2026-08-18): claude natively, codex/grok/agy via their shims, pi
    // via pi.sendMessage(deliverAs:'steer'), opencode via the plugin's
    // experimental.chat.system.transform injection, qwen/crush via the proxy
    // sidecar's next-request injection (card agent-opencode-qwen-crush-agen-
    // 2026-08-18) — the capability lives in bridgeDeliversHookContext. A
    // provider with NO delivering bridge (kimi/copilot/custom) would silently
    // DROP a consumed steer — for those it STAYS QUEUED (pendingSteers keeps it
    // visible in the control strip) and the backlog is surfaced loudly once per
    // episode.
    let steer: string | null = null;
    if (
      !syntheticWake &&
      (event === 'UserPromptSubmit' || event === 'PostToolUse') &&
      agentId &&
      this.control
    ) {
      if (bridgeDeliversHookContext(this.hive.providerOf(agentId))) {
        steer = this.control.takeSteer(agentId) ?? null;
        if (steer) this.steerBacklogNotified.delete(agentId);
      } else {
        const backlog = this.control.snapshot(agentId).pendingSteers;
        if (backlog === 0) this.steerBacklogNotified.delete(agentId);
        else if (!this.steerBacklogNotified.has(agentId)) {
          this.steerBacklogNotified.add(agentId);
          this.hive.appendLog({ kind: 'steer_undeliverable', agentId, backlog });
          this.notify(
            agentId,
            'cannot receive mid-run steering — the queued steer is held in the queue, not dropped.',
          );
        }
      }
    }

    // Keep god's roster CURRENT. fleet.json is always fresh on disk, but god's
    // context is not: after a restart it resumes a transcript describing the old
    // floor and messages agents that are long gone. Push the live roster in as
    // additionalContext at the start of each session and on every prompt, so god
    // knows the floor all the time instead of only when it remembers to Read.
    // God-only and one line — every other agent is unaffected.
    const wantsRoster =
      !syntheticWake &&
      (event === 'SessionStart' || event === 'UserPromptSubmit') &&
      !!agentId &&
      this.hive.isGod(agentId);
    // Full block on SessionStart (the fresh transcript has no roster at all),
    // slim on every prompt after it until the floor actually moves — see
    // HiveManager.rosterContext.
    const roster = wantsRoster ? this.hive.rosterContext(agentId, event === 'SessionStart') : null;

    // Same boundary, every monitor-capable agent (not just god — their
    // monitors die identically on a restart). Merges with roster/steer: only
    // ONE additionalContext may be returned per hook.
    const rearm =
      event === 'SessionStart' && agentId
        ? sessionStartRearmFor(this.hive.providerOf(agentId))
        : null;

    if (steer || roster || rearm) {
      this.emit(agentId, event, p);
      return {
        hookSpecificOutput: {
          hookEventName: event,
          additionalContext: [roster, rearm, steer].filter(Boolean).join('\n\n'),
        },
      };
    }

    // A Notification hook that means "the agent is blocked waiting for the user"
    // (idle prompt) deserves a desktop toast too — distinct from a permission
    // request, which surfaces natively in the agent's own Claude Code session
    // (approvable remotely via /remote-control).
    if (
      event === 'Notification' &&
      (p.notification_type === 'idle' ||
        (p.message ?? '').toLowerCase().includes('waiting for your input'))
    ) {
      this.notify(agentId ?? 'Agent', p.message ?? 'needs your attention');
    }

    // Forward everything else to the renderer so avatars reflect real activity.
    this.emit(agentId, event, p);
    return {};
  }

  /** Fire a native desktop notification — gated on the user's `notifications`
   *  setting. Only the OS toast is gated; the hive:hookEvent emit is always sent
   *  so avatars/UI stay live regardless. Best-effort: never throw into the hook. */
  private notify(title: string, body: string): void {
    if (!this.getConfig().notifications) return;
    try {
      if (!Notification.isSupported()) return;
      new Notification({ title, body }).show();
    } catch {
      /* notifications unsupported on this platform — ignore */
    }
  }

  /** Tell the renderer a tool call was gated/denied (#7C.1) so it can surface it
   *  (toast / control strip) — distinct from the avatar hook stream. */
  private emitControl(agentId: string, tool: string | undefined, reason: string | undefined): void {
    this.getWebContents()?.send('control:approvalRequest', { agentId, tool, reason });
  }

  private emit(
    agentId: string | undefined,
    event: string,
    p: HookPayload,
    blocked = false,
    pendingWork?: number,
  ): void {
    this.getWebContents()?.send('hive:hookEvent', {
      agentId,
      event,
      tool: p.tool_name,
      notificationType: p.notification_type,
      source: p.source,
      message: p.message,
      blocked,
      ...(pendingWork !== undefined ? { pendingWork } : {}),
    });
  }
}
