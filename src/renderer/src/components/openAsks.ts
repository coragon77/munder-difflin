import type { HiveTask, HumanQA } from './TasksKanban';

/** One open ask with the array index it occupies in the card's humanQA.
 *  The array is APPEND-ONLY (entries are never reordered or removed —
 *  cmdAsk, src/main/hive.ts), so the index is a stable key for drafts
 *  (store answerDrafts, `${taskId}:${index}`) and for the indexed
 *  resolveHumanQuestion write. */
export interface OpenAsk {
  entry: HumanQA;
  index: number;
}

/** All OPEN (unanswered, undismissed) asks of a card, OLDEST FIRST — the ASK
 *  ME board order (card agent-ask-me-board-switch-thro-2026-08-20). Replaces
 *  the serial tail-most surface: the board renders this whole list, first
 *  entry expanded, the rest collapsed.
 *
 *  Sort key is LOAD-BEARING — do not simplify:
 *    primary  askedAt ASCENDING (entries missing askedAt sort first);
 *    tiebreak array index DESCENDING.
 *  Entries written by one `hive-card ask` call share a single askedAt and
 *  land REVERSED (cmdAsk pushes --q flags backwards), so within a call the
 *  LATER index is the EARLIER ask. Across calls the newest batch sits at the
 *  tail; ascending askedAt surfaces the oldest ask first, the tiebreak keeps
 *  each call's in-call order — fixing the cross-call inversion in the UI
 *  without touching the CLI or the stored data. */
export function openAsks(t: HiveTask): OpenAsk[] {
  if (!Array.isArray(t.humanQA)) return [];
  return t.humanQA
    .map((entry, index) => ({ entry, index }))
    .filter((o) => !!o.entry && typeof o.entry.q === 'string' && !o.entry.a && !o.entry.dismissedAt)
    .sort((x, y) => {
      const ax = x.entry.askedAt ?? '';
      const ay = y.entry.askedAt ?? '';
      return ax !== ay ? (ax < ay ? -1 : 1) : y.index - x.index;
    });
}
