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
  kind: 'clear' | 'resume';
  agentId: string;
  cardId: string;
  cardTitle: string;
  /** Slash command for the pane (provider-aware via composeSessionCommand). */
  command: string;
  /** Typed right AFTER the command: leads the conversation so the CLI names
   *  it after the card (naming amendment). */
  label: string;
}

/** What the watcher remembers per card between ticks (the transition memory). */
export type CardSeen = Record<string, { status?: string }>;

/**
 * PURE transition engine — no fs, no deps, directly unit-tested.
 * `seen` is the previous tick's snapshot (empty = first tick = snapshot-only:
 * boot must not fire actions). Returns the actions to queue, in card order.
 */
export function cardSessionDecisions(
  cards: CardLike[],
  seen: CardSeen,
  registrySessions: Record<string, string | undefined>,
  providers: Record<string, AgentProvider | undefined>
): CardSessionAction[] {
  const actions: CardSessionAction[] = [];
  for (const card of cards) {
    const prev = seen[card.id];
    if (!prev || prev.status === card.status) continue; // not a transition TO doing
    if (card.status !== 'doing' || !card.assignee) continue;
    const live = registrySessions[card.assignee];
    let command: string | null = null;
    if (!card.sessionId) {
      // Never ran → fresh conversation for the new card.
      const c = composeSessionCommand({ verb: 'clear' }, providers[card.assignee]);
      command = c.ok ? c.command : null;
    } else if (card.sessionId !== live) {
      // Paused earlier, different conversation live now → resume the card's own.
      command = `/resume ${card.sessionId}`;
    } else {
      continue; // already in this card's conversation — nothing to steer
    }
    if (!command) continue;
    const title = (card.title ?? card.id).trim() || card.id;
    actions.push({
      kind: card.sessionId ? 'resume' : 'clear',
      agentId: card.assignee,
      cardId: card.id,
      cardTitle: title,
      command,
      label: `Card "${title}" — this conversation is scoped to that kanban card; read your hive inbox for the full dispatch and act on it now.`
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
  registry(): { agents: Record<string, { provider?: AgentProvider; archived?: boolean; retired?: boolean; sessionId?: string }> };
  /** Broadcast to the renderer's queue gate (same channel as session-requests). */
  emit(agentId: string, text: string): boolean;
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
  for (const card of cards) {
    if (card.assignee) {
      registrySessions[card.assignee] = reg[card.assignee]?.sessionId;
      providers[card.assignee] = reg[card.assignee]?.provider;
    }
  }
  // Pre-tick snapshot: on a failed emit a card's PRE-transition status is
  // RESTORED, so the next tick re-detects todo→doing and retries. (Deleting the
  // entry instead would read as a first sight — snapshot-only — and never retry.)
  const prevSeen: CardSeen = { ...seen };
  const actions = cardSessionDecisions(cards, seen, registrySessions, providers);
  const failed = new Set<string>();
  for (const a of actions) {
    // Command first, label second — FIFO queue keeps the order, so the fresh
    // conversation's FIRST user turn leads with the card title (its name).
    if (!deps.emit(a.agentId, a.command) || !deps.emit(a.agentId, a.label)) {
      failed.add(a.cardId);
      deps.informGod(
        `[card-session] ${a.kind} for ${a.agentId} not delivered`,
        `Card "${a.cardTitle}" (${a.cardId}): the ${a.command} could not reach a live floor window — it will retry on the next poll while the transition stays pending.`
      );
      continue;
    }
    deps.informGod(
      `[card-session] ${a.kind} queued for ${a.agentId}`,
      `Card "${a.cardTitle}" (${a.cardId}) is now doing: queued "${a.command}" into ${a.agentId}'s pane${a.kind === 'clear' ? ' for a fresh card-scoped conversation' : ' to resume the card\u2019s recorded conversation'}, followed by the card-title lead (the conversation is named after the card). The card\u2019s sessionId stamp updates automatically once the new conversation reports in.`
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
