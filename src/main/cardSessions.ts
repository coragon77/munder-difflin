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
// SAFETY: the FIRST tick after boot only snapshots — a restart must never
// re-clear a working pane (no transition observed live = no action). Actions
// fire only on transitions seen between two consecutive ticks. A failed emit
// (window down) leaves the transition unseen so the next tick retries.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeSessionCommand } from './sessionRequests';
import type { AgentProvider } from '../shared/agentProvider';
import type { CardSessionMarker } from '../shared/cardSessions';

/** Minimal structural card the watcher needs (subset of hive.HiveTask). */
export interface CardLike {
  id: string;
  title?: string;
  assignee?: string;
  status?: string;
  sessionId?: string;
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
  /** Typed right AFTER the command: leads the conversation so the CLI names
   *  it after the card (naming amendment). */
  label: string;
  /** The card.sessionId the action was decided against (resume target or
   *  adopted conversation; undefined for a clear) — delivery-time staleness
   *  check (see shared/cardSessions.ts). */
  session?: string;
}

/** What the watcher remembers per card between ticks (the transition memory). */
export type CardSeen = Record<string, { status?: string }>;

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
 * for tests).
 */
export function cardSessionDecisions(
  cards: CardLike[],
  seen: CardSeen,
  registrySessions: Record<string, string | undefined>,
  providers: Record<string, AgentProvider | undefined>,
  sessionStarted: Record<string, number | undefined> = {},
  now: number = Date.now()
): CardSessionAction[] {
  const actions: CardSessionAction[] = [];
  for (const card of cards) {
    const prev = seen[card.id];
    if (!prev || prev.status === card.status) continue; // not a transition TO doing
    if (card.status !== 'doing' || !card.assignee) continue;
    const live = registrySessions[card.assignee];
    let command: string | null = null;
    let session: string | undefined;
    if (!card.sessionId && live && sessionStarted[card.assignee] !== undefined
        && now - sessionStarted[card.assignee]! <= ADOPT_SESSION_MS) {
      // Young live conversation (started while the card was still not doing —
      // god's manual clear race): adopt it, don't wipe it. Lead only.
      session = live;
      command = ''; // no command — the marker kind 'adopt' says lead-only
    } else if (!card.sessionId) {
      // Never ran → fresh conversation for the new card.
      const c = composeSessionCommand({ verb: 'clear' }, providers[card.assignee]);
      command = c.ok ? c.command : null;
    } else if (card.sessionId !== live) {
      // Paused earlier, different conversation live now → resume the card's own.
      session = card.sessionId;
      command = `/resume ${card.sessionId}`;
    } else {
      continue; // already in this card's conversation — nothing to steer
    }
    if (command === null) continue;
    const title = (card.title ?? card.id).trim() || card.id;
    const kind: CardSessionAction['kind'] = session && !card.sessionId ? 'adopt' : card.sessionId ? 'resume' : 'clear';
    actions.push({
      kind, agentId: card.assignee, cardId: card.id, cardTitle: title,
      command, label: `Card "${title}" — this conversation is scoped to that kanban card; read your hive inbox for the full dispatch and act on it now.`, session
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
  registry(): { agents: Record<string, { provider?: AgentProvider; archived?: boolean; retired?: boolean; sessionId?: string; sessionStartedAt?: number }> };
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
    const raw = JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8')) as { tasks?: CardLike[] };
    return Array.isArray(raw.tasks) ? raw.tasks : [];
  } catch { return []; }
}

/** One poll tick: diff tasks.json against `seen`, queue actions, update `seen`.
 *  `seen` is owned by the caller (the watcher loop) so the function stays pure
 *  apart from the deps side effects — and testable with a hand-fed snapshot.
 *  A card whose emit failed (window down) stays UNSEEN so the next tick
 *  re-detects the transition and retries; every other card advances. */
export function cardSessionTick(deps: CardSessionDeps, seen: CardSeen): void {
  const root = deps.root();
  if (!root) return;
  const cards = readCards(root);
  const reg = deps.registry().agents;
  const registrySessions: Record<string, string | undefined> = {};
  const providers: Record<string, AgentProvider | undefined> = {};
  const sessionStarted: Record<string, number | undefined> = {};
  for (const card of cards) {
    if (card.assignee) {
      registrySessions[card.assignee] = reg[card.assignee]?.sessionId;
      providers[card.assignee] = reg[card.assignee]?.provider;
      sessionStarted[card.assignee] = reg[card.assignee]?.sessionStartedAt;
    }
  }
  // Pre-tick snapshot: on a failed emit a card's PRE-transition status is
  // RESTORED, so the next tick re-detects todo→doing and retries. (Deleting the
  // entry instead would read as a first sight — snapshot-only — and never retry.)
  const prevSeen: CardSeen = { ...seen };
  const actions = cardSessionDecisions(cards, seen, registrySessions, providers, sessionStarted);
  const failed = new Set<string>();
  for (const a of actions) {
    const marker: CardSessionMarker = { cardId: a.cardId, agentId: a.agentId, kind: a.kind, ...(a.session ? { session: a.session } : {}) };
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
        `Card "${a.cardTitle}" (${a.cardId}): the ${a.command || 'card lead'} could not reach a live floor window — it will retry on the next poll while the transition stays pending.`
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
        ? `Card "${a.cardTitle}" (${a.cardId}) is now doing and ${a.agentId}'s conversation just started (god steering or fresh spawn) — adopted it as this card's conversation (stamped ${a.session!.slice(0, 8)}) and queued the card-title lead. No clear: the pane keeps its fresh conversation.`
        : `Card "${a.cardTitle}" (${a.cardId}) is now doing: queued "${a.command}" into ${a.agentId}'s pane${a.kind === 'clear' ? ' for a fresh card-scoped conversation' : ' to resume the card\u2019s recorded conversation'}, followed by the card-title lead (the conversation is named after the card). The card\u2019s sessionId stamp updates automatically once the new conversation reports in.`
    );
  }
  for (const card of cards) {
    if (failed.has(card.id)) {
      // Restore the pre-transition memory so the retry re-detects the
      // transition (a failed card always had one; restore-else-skip is a no-op).
      if (prevSeen[card.id]) seen[card.id] = prevSeen[card.id];
    } else {
      seen[card.id] = { status: card.status };
    }
  }
}

/** Polling cadence — matches the hive router / spawn / session watchers. */
const CARD_TICK_MS = 1500;
let cardWatchTimer: ReturnType<typeof setInterval> | null = null;
const cardSeen: CardSeen = {};

/** Start the watcher. Idempotent; re-reads deps.root() every tick. */
export function startCardSessionWatcher(deps: CardSessionDeps): void {
  if (cardWatchTimer || !deps.root()) return;
  cardWatchTimer = setInterval(() => { cardSessionTick(deps, cardSeen); }, CARD_TICK_MS);
}

export function stopCardSessionWatcher(): void {
  if (cardWatchTimer) { clearInterval(cardWatchTimer); cardWatchTimer = null; }
}
