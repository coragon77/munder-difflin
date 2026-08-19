// ─── card-scoped sessions: one kanban card = one conversation (card-scoped-sessions-20260816)
// Built ON TOP of the session-requests mechanism (sessionRequests.ts — extended
// through its API, never rewritten): the same realtime:enqueue channel, the same
// queue gates, the same provider-aware command table.
//
// LIFECYCLE (Stefan's invariant): a standing agent accumulates unrelated
// engagements in one window; here, a NEW card starts a FRESH conversation and
// returning to a PAUSED card RESUMES its recorded one. memory.md/MemPalace
// remain the bridge between conversations (protocol unchanged).
//
//   - god sets a card to 'doing' with an assignee (his normal dispatch act)
//   - THIS watcher observes the transition (1.5s poll, like every other queue):
//       · card has NO sessionId  → it never ran → queue the provider clear
//         (fresh conversation), then a card-title lead so the CLI names the
//         new conversation after the CARD (naming amendment; composes with
//         spawnLabel for fresh hires)
//       · card HAS a sessionId ≠ the agent's live one → queue
//         /resume <card.sessionId> + the same title lead
//       · sessionId already live → no-op (already in that conversation)
//   - the harness stamps card.sessionId automatically whenever the agent's
//     session id CHANGES while the card is their active 'doing' card (see
//     HiveManager.recordSession) — so the stamp converges to the post-clear
//     conversation without racing the queue.
//
// MAIL STAGING (card agent-card-session-clear-loses-2026-08-19): the dispatch
// mail and the clear are two INDEPENDENT channels racing for one agent, and the
// wake (monitor/nudge keyed on inbox visibility) can start the card's work in
// the PRE-clear conversation — turning the pending clear into a post-work
// wipe. So the router stages mail in inbox/.staged while the assignee's doing
// card is un-established (cardSessionMailHold) and releases it when the stamp
// lands — sequencing the channels at their common dependency: mail visibility.
// See cardSessionMailHold below and HiveManager.deliver/releaseStagedMail.
//
// SAFETY: the FIRST tick after boot only snapshots — a restart must never
// re-clear a working pane (no transition observed live = no action). Actions
// fire only on transitions seen between two consecutive ticks. A failed emit
// (window down) leaves the transition unseen so the next tick retries.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeSessionCommand } from './sessionRequests';
import type { AgentProvider } from '../shared/agentProvider';
import type { CardSessionMarker } from '../shared/cardSessions';

/** How long dispatch mail may sit in inbox/.staged before the router gives up
 *  on the card-scoped conversation ever establishing (broken spawn, window
 *  down, restart mid-transition) and releases it WITH a god notice. The healthy
 *  chain (spawn → tick → clear typed at idle → session reports → stamp) is
 *  well under a minute; this is the "something is broken, make it visible"
 *  horizon, not a tuning knob. */
export const MAIL_STAGE_TIMEOUT_MS = 10 * 60_000;

/** MAIL STAGING (card agent-card-session-clear-loses-2026-08-19): a dispatch
 *  reaches its assignee over TWO independent channels — the typed card-scoped
 *  clear (this watcher) and the inbox mail (which wakes the agent through the
 *  in-pane monitor or the renderer's typed nudge). They RACE, and the wake can
 *  win: the agent starts the card's work in the PRE-clear conversation, and the
 *  clear — typed input that only executes at an idle prompt — degenerates into
 *  a post-turn wipe of the conversation that just did the work. No busy/idle
 *  gate can fix an ordering violation, so the fix sequences the channels at
 *  their common dependency: MAIL VISIBILITY. While an assignee has a 'doing'
 *  card whose conversation is not yet established, the router stages mail in
 *  inbox/.staged (invisible to the monitor's `ls inbox/*.json`, to
 *  hive.inbox()/the nudge, and to `hive-inbox drain` — all non-recursive
 *  *.json listings) and releases it once the stamp lands (the fresh
 *  conversation reported in) or the card stops holding (blocked/done/reassign).
 *  PURE: cards + registry sessions + providers → the set of agentIds whose mail
 *  must stage right now. Never holds when the establishment mechanism does not
 *  exist for the provider (no typable clear for a fresh card; no typable resume
 *  — pi's picker — for a paused one): there the watcher itself types nothing,
 *  and holding mail would only delay the dispatch to the timeout. Adopt-mode
 *  cards never hold: the engagement is connected, mail in the live
 *  conversation is the intent. */
export function cardSessionMailHold(
  cards: CardLike[],
  registrySessions: Record<string, string | undefined>,
  providers: Record<string, AgentProvider | undefined> = {},
): Set<string> {
  const held = new Set<string>();
  for (const card of cards) {
    if (!card.assignee || card.status !== 'doing' || card.sessionMode === 'adopt') continue;
    if (card.sessionId && card.sessionId === registrySessions[card.assignee]) continue; // established
    const mechanism = card.sessionId
      ? composeSessionCommand(
          { verb: 'resume', sessionId: card.sessionId },
          providers[card.assignee],
        ).ok
      : composeSessionCommand({ verb: 'clear' }, providers[card.assignee]).ok;
    if (mechanism) held.add(card.assignee);
  }
  return held;
}

/** Minimal structural card the watcher needs (subset of hive.HiveTask). */
export interface CardLike {
  id: string;
  title?: string;
  assignee?: string;
  status?: string;
  sessionId?: string;
  /** Written by `hive-dispatch --adopt` / `hive-card status <id> doing
   *  --adopt`: the assignee's CURRENT conversation IS this card's engagement —
   *  lead only + stamp, NO clear, no age limit (god's explicit word beats the
   *  young-session heuristic). `hive-dispatch --resume` writes 'resume': the
   *  card's stored sessionId is where the work lives; the watcher takes the
   *  resume branch below (the mode's job is refusing dispatches with no/gone
   *  stamps at the CLI, never a fresh fallback — that would wipe a pane).
   *  Absent = fresh (the default). Consumed on the →doing transition. */
  sessionMode?: 'adopt' | 'resume';
}

/** One queued pane action derived from a card transition. */
export interface CardSessionAction {
  kind: 'clear' | 'resume' | 'adopt';
  agentId: string;
  cardId: string;
  cardTitle: string;
  /** Slash command for the pane (provider-aware via composeSessionCommand).
   *  EMPTY for an adopt: the conversation is already fresh, only the lead is
   *  typed (card-session-stamp-never-fires-20260816: god can clear a pane for
   *  this card's work seconds before flipping the card to doing — the watcher
   *  adopts that young conversation instead of queuing a redundant clear that
   *  would later wipe it). */
  command: string;
  /** Present ONLY when the card's conversation could not be resumed because
   *  the assignee's provider has NO typable id-carrying resume (picker or
   *  spawn-flag only). The tick mails god (card, agent, provider, sessionId)
   *  and types NOTHING — never a fallback to the claude dialect. */
  noResume?: { provider: AgentProvider | undefined; sessionId: string };
  /** Typed right AFTER the command: leads the conversation so the CLI names
   *  it after the card (naming amendment). */
  label: string;
  /** The card.sessionId the action was decided against (resume target or
   *  adopted conversation; undefined for a clear) — delivery-time staleness
   *  check (see shared/cardSessions.ts). */
  session?: string;
  /** True when the pane was BUSY at decision time (vacationBusy's rule): the
   *  tick must NOT emit yet — the transition stays pending and the decision
   *  re-runs each tick until the pane goes quiet (idle-gated clears,
   *  engagement-aware flips 2026-08-17). Only pane-restarting commands defer;
   *  an adopt lead (command '') never does. */
  deferred?: boolean;
}

/** What the watcher remembers per card between ticks (the transition memory).
 *  `deferred` records that a pane-restart command was held back for a busy
 *  pane — the eventual fire states "fresh-deferred (fired at HH:MM)" in god's
 *  notice mail. */
export type CardSeen = Record<string, { status?: string; deferred?: boolean }>;

/** A live conversation younger than this at a →doing flip is presumed to BE
 *  the card's fresh conversation (god's manual clear / a just-finished spawn)
 *  and is adopted instead of cleared. Two minutes covers the manual-steering
 *  race window; an old standing engagement stays clearable.
// ponytail: fixed 2min heuristic — a card flipped >2min after god's manual
// clear still queues a redundant clear; session-requests intent-sharing is the
// upgrade path if that ever bites. */
const ADOPT_SESSION_MS = 120_000;

/**
 * PURE transition engine — no fs, no deps, directly unit-tested.
 * `seen` is the previous tick's snapshot (empty = first tick = snapshot-only:
 * boot must not fire actions). Returns the actions to queue, in card order.
 * `sessionStarted` maps assignee → epoch ms their CURRENT conversation began
 * (RegistryAgent.sessionStartedAt); `now` defaults to Date.now() (injectable
 * for tests); `busy` maps assignee → pane is mid-work (vacationBusy's house
 * rule) — pane-restarting commands (clear/resume) come back `deferred` for a
 * busy pane instead of firing (engagement-aware flips 2026-08-17: never wipe
 * a working pane; re-decide each tick until it goes quiet).
 *
 * `booted` (the tick wires it from the BOOT sentinel in `seen`): false = the
 * watcher's FIRST tick after start — an unseen card is a restart survivor and
 * is only snapshotted, never steered. true = mid-session — an unseen card is
 * a genuinely NEW card; when it is first observed ALREADY 'doing' with an
 * assignee (hive-dispatch creates and flips in one command), the watcher can
 * never see a non-doing state for it, so the first sight IS the →doing
 * transition and the card gets its fresh/resumed conversation like any flip
 * (dispatch-first-sight-2026-08-18: cards created that way used to silently
 * continue the agent's PREVIOUS conversation and never gain a sessionId). An
 * unseen NON-doing card stays a snapshot in both modes.
 */
export function cardSessionDecisions(
  cards: CardLike[],
  seen: CardSeen,
  registrySessions: Record<string, string | undefined>,
  providers: Record<string, AgentProvider | undefined>,
  sessionStarted: Record<string, number | undefined> = {},
  now: number = Date.now(),
  busy: Record<string, boolean> = {},
  booted = false,
): CardSessionAction[] {
  const actions: CardSessionAction[] = [];
  for (const card of cards) {
    const prev = seen[card.id];
    if (!prev) {
      // Unseen card: snapshot at boot; mid-session, first-sight-already-doing
      // is the dispatch-created card's transition (see docblock).
      if (!booted || card.status !== 'doing' || !card.assignee) continue;
    } else if (prev.status === card.status) continue; // not a transition TO doing
    if (card.status !== 'doing' || !card.assignee) continue;
    const live = registrySessions[card.assignee];
    let command: string | null = null;
    let session: string | undefined;
    let kind: CardSessionAction['kind'];
    let noResume: CardSessionAction['noResume'] | undefined;
    if (card.sessionMode === 'adopt' && live) {
      // EXPLICIT adopt (hive-card status <id> doing --adopt): the assignee's
      // current conversation IS this card's engagement (connected card, mid-work
      // handoff) — lead only + stamp, regardless of conversation age. Checked
      // BEFORE the already-live no-op so a re-adopt (blocked→doing) still leads.
      session = live;
      command = '';
      kind = 'adopt';
    } else if (
      !card.sessionId &&
      live &&
      sessionStarted[card.assignee] !== undefined &&
      now - sessionStarted[card.assignee]! <= ADOPT_SESSION_MS
    ) {
      // Young live conversation (started while the card was still not doing —
      // god's manual clear race): adopt it, don't wipe it. Lead only.
      session = live;
      command = ''; // no command — the marker kind 'adopt' says lead-only
      kind = 'adopt';
    } else if (!card.sessionId) {
      // Never ran → fresh conversation for the new card.
      const c = composeSessionCommand({ verb: 'clear' }, providers[card.assignee]);
      command = c.ok ? c.command : null;
      kind = 'clear';
    } else if (card.sessionId !== live) {
      // Paused earlier, different conversation live now → resume the card's
      // own. Provider-aware like the clear path: a provider whose only resume
      // is a picker or a spawn flag gets NO typed command (typing "/resume
      // <uuid>" into such a REPL lands as a prompt) — a noResume marker the
      // tick turns into god-mail, never a claude-dialect fallback.
      session = card.sessionId;
      const c = composeSessionCommand(
        { verb: 'resume', sessionId: card.sessionId },
        providers[card.assignee],
      );
      command = c.ok ? c.command : '';
      noResume = c.ok
        ? undefined
        : { provider: providers[card.assignee], sessionId: card.sessionId };
      kind = 'resume';
    } else {
      continue; // already in this card's conversation — nothing to steer
    }
    if (command === null) continue;
    const title = (card.title ?? card.id).trim() || card.id;
    // A pane-restart command at a BUSY pane is deferred, not fired: the command
    // rides along (what WILL fire), the tick holds the transition pending and
    // re-decides next tick. An adopt lead types no command — safe to queue.
    const deferred = command !== '' && busy[card.assignee] === true;
    actions.push({
      kind,
      agentId: card.assignee,
      cardId: card.id,
      cardTitle: title,
      command,
      label: `Card "${title}" — this conversation is scoped to that kanban card; read your hive inbox for the full dispatch and act on it now.`,
      session,
      ...(noResume ? { noResume } : {}),
      ...(deferred ? { deferred: true } : {}),
    });
  }
  return actions;
}

/** Everything the watcher needs from the host process (mirrors the
 *  session-requests deps shape; index.ts wires the real implementations). */
export interface CardSessionDeps {
  /** Hive root, or null when the hive is disabled. */
  root(): string | null;
  /** Live registry snapshot (structural subset incl. the session stamps). */
  registry(): {
    agents: Record<
      string,
      {
        provider?: AgentProvider;
        archived?: boolean;
        retired?: boolean;
        sessionId?: string;
        sessionStartedAt?: number;
      }
    >;
  };
  /** Is this agent mid-work? THE house busy rule (vacationBusy: real work
   *  inside its window, telemetry-primary, PTY fallback) — the same
   *  definition the vacation gate uses, wired identically in index.ts. A
   *  pane-restarting command (clear/resume) is deferred while busy
   *  (engagement-aware flips 2026-08-17: never fire /new at a busy pane). */
  busy(agentId: string): boolean;
  /** PTY id of the agent's live pane, or undefined when none is open
   *  (card agent-recalled-pane-resumes-it-2026-08-18). A →doing flip for an
   *  assignee with NO pane — the dispatch-to-a-PARKED-agent path, where the
   *  recall spawn lands seconds AFTER the flip — must HOLD the transition
   *  pending exactly like a busy pane: the emit channel's renderer half
   *  (useHive 5c) silently DROPS messages for agents with no floor card, so
   *  emitting here "succeeds" (a window is alive) while the clear + lead
   *  vanish and the watcher consumes the transition — the recalled pane then
   *  resumes its OWN old conversation, no fresh card conversation starts, the
   *  inbox monitor never re-arms, and the dispatch sits unread until a
   *  standup notices. Optional only so legacy test fakes keep compiling; main
   *  always wires it. */
  ptyForAgent?(agentId: string): string | undefined;
  /** Broadcast to the renderer's queue gate (same channel as session-requests).
   *  The marker rides along so the queue-drain can stale-drop at delivery. */
  emit(agentId: string, text: string, marker?: CardSessionMarker): boolean;
  /** Stamp card.sessionId (the adopt path records the adopted conversation).
   *  Wired to HiveManager.stampCard — same read-modify-write discipline. */
  stampCard(cardId: string, sessionId: string): void;
  /** Surface lifecycle actions in god's inbox (transparency, one per action). */
  informGod(subject: string, body: string): void;
}

/** Read tasks.json's card list (best-effort: missing/corrupt → []). */
function readCards(root: string): CardLike[] {
  try {
    const raw = JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8')) as {
      tasks?: CardLike[];
    };
    return Array.isArray(raw.tasks) ? raw.tasks : [];
  } catch {
    return [];
  }
}

/** Reserved `seen` key: set once the watcher has COMPLETED a tick, so the
 *  next tick knows an unseen card is genuinely new (created between ticks)
 *  rather than a restart survivor — see cardSessionDecisions' `booted`. */
const BOOT_SEEN_KEY = '__cardSessionBooted__';

/** One poll tick: diff tasks.json against `seen`, queue actions, update `seen`.
 *  `seen` is owned by the caller (the watcher loop) so the function stays pure
 *  apart from the deps side effects — and testable with a hand-fed snapshot.
 *  A card whose emit failed (window down) stays UNSEEN so the next tick
 *  re-detects the transition and retries; a card whose pane-restart command
 *  was DEFERRED (busy pane) stays pending the same way, carrying a `deferred`
 *  memory so the eventual fire's notice states the mode; every other card
 *  advances. */
export function cardSessionTick(deps: CardSessionDeps, seen: CardSeen): void {
  const root = deps.root();
  if (!root) return;
  const cards = readCards(root);
  const reg = deps.registry().agents;
  const registrySessions: Record<string, string | undefined> = {};
  const providers: Record<string, AgentProvider | undefined> = {};
  const sessionStarted: Record<string, number | undefined> = {};
  const busy: Record<string, boolean> = {};
  for (const card of cards) {
    if (card.assignee) {
      registrySessions[card.assignee] = reg[card.assignee]?.sessionId;
      providers[card.assignee] = reg[card.assignee]?.provider;
      sessionStarted[card.assignee] = reg[card.assignee]?.sessionStartedAt;
      if (busy[card.assignee] === undefined) busy[card.assignee] = deps.busy(card.assignee);
    }
  }
  // Pre-tick snapshot: on a failed emit a card's PRE-transition status is
  // RESTORED, so the next tick re-detects todo→doing and retries. (Deleting the
  // entry instead would read as a first sight — snapshot-only — and never retry.)
  const prevSeen: CardSeen = { ...seen };
  const booted = prevSeen[BOOT_SEEN_KEY]?.status === 'done';
  const actions = cardSessionDecisions(
    cards,
    seen,
    registrySessions,
    providers,
    sessionStarted,
    Date.now(),
    busy,
    booted,
  );
  const failed = new Set<string>();
  const deferredIds = new Set<string>();
  for (const a of actions) {
    // NO TYPABLE RESUME (agent-card-resume-must-be-prov-2026-08-18): the
    // assignee's engine has no id-carrying typable resume — do not type
    // anything (a picker verb would wedge the pane; a fallback dialect lands
    // as a prompt). Mail god with everything needed to steer the pane by hand
    // and consume the transition (retrying would re-mail every tick).
    if (a.noResume) {
      deps.informGod(
        `[card-session] resume NOT possible for ${a.agentId} (${a.noResume.provider ?? 'claude'})`,
        `Card "${a.cardTitle}" (${a.cardId}) needs its recorded conversation ${a.noResume.sessionId} resumed in ${a.agentId}'s pane, but provider ${a.noResume.provider ?? 'claude'} has no typable id-carrying resume (its /resume is an interactive picker, or resume is a spawn-only flag). NOTHING was typed — the card lead below was also skipped. Steer the pane by hand: restart the engine with its resume flag/spawn form naming ${a.noResume.sessionId}, or have the agent /clear and re-drain its inbox for the card.`,
      );
      continue;
    }
    // PANE-LESS HOLD (agent-recalled-pane-resumes-it-2026-08-18): same pending
    // semantics as the busy-defer below — an assignee with no live pane cannot
    // receive anything through the queue channel (the renderer drops messages
    // for cardless agents), so firing here would silently lose the card-scoped
    // clear + lead and consume the transition. Hold and re-decide each tick;
    // the recall/restore/revive spawn brings the pane up and the held action
    // fires into it (a /clear typed after a recall-resume still wins — resume
    // is argv, the clear is just input).
    if (deps.ptyForAgent !== undefined && !deps.ptyForAgent(a.agentId)) {
      deferredIds.add(a.cardId);
      continue;
    }
    if (a.deferred) {
      // Busy pane: hold the transition pending (no emit, no mail — the mode is
      // stated when it FIRES). Next tick re-decides against the live pane.
      deferredIds.add(a.cardId);
      continue;
    }
    const wasDeferred = prevSeen[a.cardId]?.deferred === true;
    const marker: CardSessionMarker = {
      cardId: a.cardId,
      agentId: a.agentId,
      kind: a.kind,
      ...(a.session ? { session: a.session } : {}),
    };
    // Command first, label second — FIFO queue keeps the order, so the fresh
    // conversation's FIRST user turn leads with the card title (its name).
    // (Adopt: command is '' — the lead is the only typed turn.)
    const sent = a.command
      ? deps.emit(a.agentId, a.command, marker) && deps.emit(a.agentId, a.label, marker)
      : deps.emit(a.agentId, a.label, marker);
    if (!sent) {
      failed.add(a.cardId);
      deps.informGod(
        `[card-session] ${a.kind} for ${a.agentId} not delivered`,
        `Card "${a.cardTitle}" (${a.cardId}): the ${a.command || 'card lead'} could not reach a live floor window — it will retry on the next poll while the transition stays pending.`,
      );
      continue;
    }
    // Record the adopted conversation only once the lead is queued — stamping
    // on a failed emit would make the retry read "already in this card's
    // conversation" and silently skip the lead forever.
    if (a.kind === 'adopt') deps.stampCard(a.cardId, a.session!);
    deps.informGod(
      `[card-session] ${a.kind} queued for ${a.agentId}`,
      a.kind === 'adopt'
        ? `Card "${a.cardTitle}" (${a.cardId}) is now doing in ${a.agentId}'s CURRENT conversation (mode: adopt — the engagement is connected; no clear). Stamped ${a.session!.slice(0, 8)} and queued the card-title lead as an info line; the pane keeps its conversation.`
        : `Card "${a.cardTitle}" (${a.cardId}) is now doing: queued "${a.command}" into ${a.agentId}'s pane for a ${a.kind === 'clear' ? `fresh card-scoped conversation (mode: ${wasDeferred ? `fresh-deferred (fired at ${firedAt()}) — the pane was busy at the flip, the clear fired once it went idle` : 'fresh'})` : `resume of the card's recorded conversation${wasDeferred ? ` (deferred while the pane was busy; fired at ${firedAt()})` : ''}`}, followed by the card-title lead (the conversation is named after the card). The card's sessionId stamp updates automatically once the new conversation reports in.`,
    );
  }
  for (const card of cards) {
    if (failed.has(card.id) || deferredIds.has(card.id)) {
      // Restore the pre-transition memory so the retry re-detects the
      // transition (a failed card always had one; restore-else-skip is a no-op).
      // A deferral additionally sets the deferred memory — the eventual fire
      // states "fresh-deferred (fired at HH:MM)" in god's notice.
      if (prevSeen[card.id])
        seen[card.id] = {
          ...prevSeen[card.id],
          ...(deferredIds.has(card.id) ? { deferred: true } : {}),
        };
    } else {
      seen[card.id] = { status: card.status };
    }
  }
  // Mark the tick complete: from the NEXT tick on, an unseen card is a
  // genuinely new card (dispatch-created), not a restart survivor.
  seen[BOOT_SEEN_KEY] = { status: 'done' };
}

/** HH:MM (UTC, the hive log timezone) for the fired-at notice line. */
function firedAt(): string {
  return new Date().toISOString().slice(11, 16);
}

/** Polling cadence — matches the hive router / spawn / session watchers. */
const CARD_TICK_MS = 1500;
let cardWatchTimer: ReturnType<typeof setInterval> | null = null;
const cardSeen: CardSeen = {};

/** Start the watcher. Idempotent; re-reads deps.root() every tick. */
export function startCardSessionWatcher(deps: CardSessionDeps): void {
  if (cardWatchTimer || !deps.root()) return;
  cardWatchTimer = setInterval(() => {
    cardSessionTick(deps, cardSeen);
  }, CARD_TICK_MS);
}

export function stopCardSessionWatcher(): void {
  if (cardWatchTimer) {
    clearInterval(cardWatchTimer);
    cardWatchTimer = null;
  }
}
