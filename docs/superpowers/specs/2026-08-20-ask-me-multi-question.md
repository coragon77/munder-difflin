# ASK ME board: show and answer every open ask on a card

Card: agent-ask-me-board-shows-only--2026-08-20. Author: Robert (advisory).
Status: spec — no implementation yet. Implementer: any harness worker;
renderer-only for the MVP, one optional main-process extension (both land via
god's restart-window mechanism — see "Merge constraints").

## Problem — verified behavior, not the reported one

The report was "the ask me tab shows only the last one of one entry". The
actual mechanism (all verified in the live checkout):

1. `openQuestion()` (`src/renderer/src/components/TasksKanban.tsx:49-57`)
   walks `humanQA` BACKWARDS and returns the first unanswered, undismissed
   entry — i.e. the tail-most open entry. `AskMeTab.tsx` renders exactly that
   ONE entry per card with one answer box. Answering it makes the next open
   entry surface after the immediate refresh, so every entry IS reachable —
   strictly serially, newest-batch-first, with no indication that more are
   queued.
2. `hive-card ask` writes multiple `--q` flags REVERSED into the array
   (`src/main/hive.ts:6281`, comment at :6245-6250) precisely so the backward
   walk yields FIFO order. That reversal only works WITHIN one call. Across
   separate calls each new block appends at the tail, and the backward walk
   surfaces the NEWEST call's asks first: with the day's pattern of many
   single-question calls per card, the operator is always shown the newest
   question and older ones sink. That is the "only shows the last one"
   experience, and it is a real ordering defect, not a misreading.
3. The ANSWER path has the same shape but is not index-limited:
   `resolveHumanQuestion(id, question, answer?)` (`src/main/hive.ts:2968`)
   matches by question TEXT, tail-first, under the ledger lock. It can write
   to any entry whose text it is handed — the renderer just never hands it
   anything but the tail-most open one. So this is a display/UX limitation,
   not a data-path bug. Nothing addresses entries by array index today.
4. Answered and dismissed entries already stay on the card forever
   (append-only, `cmdAsk` comment hive.ts:6250-6252) and are viewable via the
   task detail overlay ("VIEW N EARLIER ANSWERS", AskMeTab.tsx:302-320).

Real data: card agent-redmine-3230-alfred-2026-08-20 carries 11 entries (all
now answered — serially), agent-redmine-3231-oegb-2026-08-20 carries 8.

## Design

One change of shape: an ASK ME card renders ALL open asks as an ordered list
instead of a single question. No carousel, no pagination — a list satisfies
"switch through them" with fewer moving parts.

### Ordering

Oldest-asked first. Sort key, applied to open entries only:

- primary: `askedAt` ascending (entries missing `askedAt` sort first, stable);
- tiebreak: array index DESCENDING.

The tiebreak is load-bearing: entries written in one `hive-card ask` call
share one `askedAt` timestamp (hive.ts:6274) and are stored reversed
(:6281), so within a call the LATER array index is the EARLIER ask. This
rule fixes the cross-call inversion in the UI without touching the CLI or
existing data.

### Rendering (AskMeTab.tsx only)

Per card, replace the single-question block with:

- A count line in the header area: `N OPEN ASK{S}` (display font, like the
  BLOCKING label). The existing "VIEW M EARLIER ANSWERS" link stays as the
  history entry point; do not render answered/dismissed entries on the board.
- The list of open entries in the order above. The FIRST entry renders
  expanded (question text + answer box + buttons — the current layout). Every
  other entry renders collapsed: one line, question text ellipsized, with an
  expand affordance. Clicking a collapsed entry expands it (its own answer
  box); multiple entries may be expanded at once. Expansion state is local
  component state — it does not need to survive tab switches.
- Each expanded entry gets its own "respond & unblock" button and its own
  dismiss ✕ (the current card-level ✕ moves INTO the entry row; dismissing
  one entry must not touch the others). Keep the Ctrl+Enter shortcut per
  textarea.

### Drafts

`answerDrafts` (store.ts:290, keyed by task id) becomes keyed by
`` `${taskId}:${entryKey}` `` where `entryKey` is the entry's array index in
`humanQA`. Renderer-only change; keep the store shape
(`Record<string, string>`), only the key format changes. Stale draft keys
from before the change are orphaned and harmless (drafts are not persisted
to disk — verify at implementation; if they are, migrate by dropping).

Array index is stable enough as a draft key because the array is append-only
(entries are never reordered or removed — hive.ts:6250-6252); a concurrent
append changes no existing index.

### Answer write path

Per-entry send does exactly what `sendAnswer` does today (AskMeTab.tsx:80-111)
— `hiveResolveHumanQuestion(task.id, entry.q, text)` then the mail to god —
but with the SELECTED entry's `q`, not `openQuestion(task)`'s. Same for
dismiss. The mail format is unchanged; one mail per answered entry is
intended (god acts on each incrementally).

Known limitation of text addressing, accepted for the MVP: if one card
carries two IDENTICAL open question texts, `resolveHumanQuestion` patches the
tail-most one, which under the sort above is the OLDER of the duplicates —
acceptable, since both are open and textually identical, and the protocol's
one-ask-per-entry rule makes exact duplicates pathological.

### Optional main-process extension (recommended, small)

Add an optional `index` parameter through the chain
`resolveHumanQuestion(id, question, answer?, index?)` (hive.ts:2968) →
preload (`src/preload/index.ts`, `hiveResolveHumanQuestion`) → renderer.
Semantics: if `index` is given and `humanQA[index]` exists, is open, and its
`q` strictly equals `question`, patch exactly that entry; otherwise fall back
to the existing tail-first text match (never fail a valid text match because
the index went stale). This removes the duplicate-text ambiguity and gives
the UI a precise write target. Backward compatible: all existing callers
omit it.

### Unblock semantics — unchanged

`waitsOnHuman` (TasksKanban.tsx:59) keeps the card on the board while ANY
open entry remains; answering one of several does not unblock the card, and
the card leaves ASK ME only when every entry is answered or dismissed.
This is current behavior and stays.

## Out of scope

- `hive-card ask` / CLI changes (the write-side reversal stays; the UI sort
  makes it irrelevant to display order).
- Protocol text changes. The multi-ask-per-card model is affirmed, not
  changed (see the opinion in the card's mail record).
- TaskDetailOverlay changes (history display is already there).
- The dispatch-refusal quote (`hive.ts:6884-6895`) quotes the tail-most open
  question, which after this change may not be the entry shown first on the
  board. Cosmetic mismatch; aligning it to the same sort is a one-line
  follow-up, not part of this card.
- Notifications, kanban card badges, answer batching.

## Merge constraints

- AskMeTab.tsx / TasksKanban.tsx / store.ts are renderer files: the branch
  merges only in god's restart window (three renderer branches already
  queued: e2a0503, 8ef8d3f, 751818d — none touch AskMeTab.tsx, verified via
  `git log --all -- src/renderer/src/components/AskMeTab.tsx`).
- The optional `index` extension touches main + preload: same restart-window
  constraint. If the implementer ships it, ship it in the same branch so the
  window lands one consistent unit.

## Acceptance

1. A card with asks from three separate `hive-card ask` calls (one multi-`--q`
   among them) shows ALL open asks, ordered by ask time, in-call order
   preserved.
2. Answering a middle entry writes `a`/`answeredAt` into exactly that entry
   in tasks.json (inspect via `hive-card show`), mails god once, and leaves
   the other entries open and on the board.
3. Dismissing a middle entry sets `dismissedAt` on exactly that entry.
4. The card leaves ASK ME only when no open entries remain.
5. Drafts typed into two different entries of one card survive a tab switch
   independently.
