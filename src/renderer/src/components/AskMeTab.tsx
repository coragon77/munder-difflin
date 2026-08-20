import { useCallback, useEffect, useRef, useState } from 'react';
import { PixelButton } from './PixelButton';
import { PixelBadge } from './PixelBadge';
import { useStore } from '@/store/store';
import { type HiveTask, waitsOnHuman } from './TasksKanban';
import { openAsks, type OpenAsk } from './openAsks';

/**
 * ASK ME — first-class human feedback through the task system.
 *
 * Tasks the god can only move with the human's input sit here. An entry isn't
 * necessarily a question — it can be a TO-DO only the human can perform
 * (create an account, approve a purchase, provide credentials, test on a real
 * device). Each card pages through ALL of its open asks, oldest first
 * (openAsks — card agent-ask-me-board-switch-thro-2026-08-20): one ask
 * visible at a time, ◀ ▶ triangles with an i/N position indicator between
 * them, so the operator can answer question 3/8 first — paging is free
 * navigation, nothing has to be answered in order. Every displayed entry has
 * its own answer box, respond button and dismiss ✕ acting on exactly that
 * entry, plus the CASCADE of downstream tasks stuck waiting on this one, so
 * "why isn't X done?" reads as "ah, because I still owe something here."
 *
 * Sending an answer does two things atomically-ish:
 *   1. writes it into the card's humanQA entry in hive/tasks.json (the
 *      decision is documented ON the task, forever) — addressed by the
 *      entry's array index, with the question text as the checked guard, so
 *      even two identical question texts resolve to the exact entry, and
 *   2. mails the god so it picks the answer up, unblocks the card, and the
 *      work continues — no separate HumanQuestion.md side-channel anymore.
 */

const POLL_MS = 5000;

function parse(raw: unknown): HiveTask[] {
  const list =
    raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks)
      ? (raw as { tasks: HiveTask[] }).tasks
      : [];
  return list.filter((t) => !!t && typeof t === 'object');
}

/** All tasks transitively waiting on `id` (dependents chain), cycle-safe. */
function dependentsTree(id: string, all: HiveTask[], seen = new Set<string>()): HiveTask[] {
  if (seen.has(id)) return [];
  seen.add(id);
  const direct = all.filter(
    (t) => Array.isArray(t.dependsOn) && t.dependsOn.includes(id) && t.status !== 'done',
  );
  return direct.flatMap((d) => [d, ...dependentsTree(d.id, all, seen)]);
}

export function AskMeTab() {
  const agents = useStore((s) => s.agents);
  const restorable = useStore((s) => s.restorableAgents);
  const [tasks, setTasks] = useState<HiveTask[]>([]);
  // Drafts live in the STORE (keyed by `${taskId}:${humanQA index}` — one per
  // open entry) — switching tabs or PAGING away and back must not eat a
  // half-typed answer, on ANY of a card's open entries. The index is a stable
  // key: the humanQA array is append-only, so a concurrent append never moves
  // it and a sibling's answer never re-keys another entry's draft.
  const drafts = useStore((s) => s.answerDrafts);
  const setAnswerDraft = useStore((s) => s.setAnswerDraft);
  const openTaskDetail = useStore((s) => s.openTaskDetail);
  const [sending, setSending] = useState<string | null>(null);
  // Pager position per card — index into that card's OPEN asks in openAsks()
  // order (oldest first). Purely local: it does not need to survive tab
  // switches. Clamped on every render against the CURRENT open list, which is
  // the landing rule after an answer: the answered entry drops out, the
  // position stays where it was and shows the ask that followed — answering
  // 3/8 lands on the new 3/7, never thrown back to 1/N; answering the last
  // one steps back one. New asks (newest askedAt) append at the END of the
  // sorted list, so they never shift an existing position either.
  const [page, setPage] = useState<Record<string, number>>({});
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setTasks(parse(await window.cth.hiveTasks()));
    } catch {
      /* keep last good */
    }
  }, []);

  useEffect(() => {
    refresh();
    timer.current = setInterval(refresh, POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [refresh]);

  const nameFor = (id?: string): string | undefined =>
    id
      ? (agents.find((a) => a.id === id)?.name ?? restorable.find((a) => a.id === id)?.name ?? id)
      : undefined;

  const waiting = tasks.filter(waitsOnHuman);

  const sendAnswer = async (task: HiveTask, o: OpenAsk) => {
    const key = `${task.id}:${o.index}`;
    const text = (drafts[key] ?? '').trim();
    if (!text || sending) return;
    setSending(key);
    try {
      // 1) Document the answer ON the card, on exactly the displayed entry.
      // Main re-reads and patches only the addressed open question under
      // tasks.json.lock; never overwrite the stale ledger. The index makes
      // the write precise even when two asks share one question text.
      const saved = await window.cth.hiveResolveHumanQuestion(task.id, o.entry.q, text, o.index);
      if (!saved?.ok) throw new Error(saved?.error ?? 'failed to save answer');
      await refresh();
      // 2) Tell the god, so the card gets unblocked and work continues.
      await window.cth.hiveSend(
        {
          to: 'god',
          act: 'inform',
          subject: `HUMAN ANSWER on task "${task.title}"`,
          body: [
            `The human answered the open question on task ${task.id} ("${task.title}"):`,
            `Q: ${o.entry.q}`,
            `A: ${text}`,
            "The answer is also recorded in the card's humanQA. Act on it, unblock the card, and continue the work.",
          ].join('\n'),
        },
        'human',
      );
      setAnswerDraft(key, '');
    } catch {
      /* leave the draft so the user can retry */
    }
    setSending(null);
  };

  // Dismiss the DISPLAYED open ask off the ASK ME board WITHOUT answering it
  // — never touching the card's other open entries. We mark that humanQA
  // entry `dismissedAt` (no fabricated answer) so it leaves the board; the
  // question itself stays on the card, so the Q&A history is never dropped
  // (protocol). The task stays blocked on the kanban until its LAST open
  // entry is answered or dismissed; the god can re-ask by appending a fresh
  // entry. Like answers, dismissals are targeted main-process writes under
  // the ledger lock.
  const dismiss = async (task: HiveTask, o: OpenAsk) => {
    const key = `${task.id}:${o.index}`;
    if (sending === key) return;
    const next = tasks.map((t) => {
      if (t.id !== task.id) return t;
      const qa = (t.humanQA ?? []).map((e, i) =>
        i === o.index ? { ...e, dismissedAt: new Date().toISOString() } : e,
      );
      return { ...t, humanQA: qa };
    });
    setTasks(next); // optimistic — the entry disappears immediately
    try {
      const saved = await window.cth.hiveResolveHumanQuestion(
        task.id,
        o.entry.q,
        undefined,
        o.index,
      );
      if (!saved?.ok) throw new Error(saved?.error ?? 'failed to dismiss question');
      await refresh();
    } catch {
      void refresh(); // restore the fresh ledger so the user can retry
    }
  };

  return (
    // Body text is set in the mono face (VT323) — the same readable font the
    // memory viewer uses. Pixelify Sans (font-ui) is too chunky for prose like
    // questions and answers. Display/badge bits keep their explicit faces.
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        background: 'var(--cth-paper-200)',
        padding: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        fontFamily: 'var(--cth-font-mono)',
      }}
    >
      {waiting.length === 0 && (
        <div
          style={{
            textAlign: 'center',
            padding: '24px 12px',
            color: 'var(--cth-ink-500)',
            fontSize: 12,
          }}
        >
          Nothing needs you right now. 🌿<br />
          <span style={{ fontSize: 11, color: 'var(--cth-ink-300)' }}>
            When the team blocks a task on your input — a question to answer or a to-do only you can
            perform — it shows up here (and on the ASK ME board on the floor).
          </span>
        </div>
      )}
      {waiting.map((t) => {
        const asks = openAsks(t);
        // Landing rule: clamp the stored position against the current open
        // list (see `page` above for why this is the post-answer behavior).
        const p = Math.min(page[t.id] ?? 0, asks.length - 1);
        const o = asks[p];
        const key = `${t.id}:${o.index}`;
        const stuck = dependentsTree(t.id, tasks);
        const answeredCount = t.humanQA?.filter((e) => e.a).length ?? 0;
        return (
          <div
            key={t.id}
            style={{
              background: 'var(--cth-paper-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {/* header: title + assignee */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 9px',
                background: 'var(--cth-lilac-light, #ece2f5)',
                boxShadow: 'inset 0 -1px 0 var(--cth-ink-700)',
              }}
            >
              <button
                onClick={() => openTaskDetail(t.id)}
                title="open the full task detail"
                style={{
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  padding: 0,
                  textAlign: 'left',
                  fontFamily: 'var(--cth-font-mono)',
                  fontSize: 15,
                  color: 'var(--cth-ink-900)',
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {t.title}
              </button>
              {nameFor(t.assignee) && <PixelBadge status="blocked" label={nameFor(t.assignee)!} />}
            </div>

            <div style={{ padding: 9, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* pager: one ask visible at a time, oldest first. Paging is
                  free navigation — answer 3/8 without touching 1/8 or 2/8. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {asks.length > 1 ? (
                  <>
                    <button
                      onClick={() => setPage({ ...page, [t.id]: p - 1 })}
                      disabled={p === 0}
                      title="previous ask"
                      aria-label="previous ask"
                      style={{
                        flexShrink: 0,
                        width: 22,
                        height: 22,
                        padding: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        lineHeight: 1,
                        border: 'none',
                        cursor: p === 0 ? 'default' : 'pointer',
                        background: 'transparent',
                        color: p === 0 ? 'var(--cth-ink-300)' : 'var(--cth-ink-900)',
                        fontFamily: 'var(--cth-font-mono)',
                        fontSize: 13,
                      }}
                    >
                      ◀
                    </button>
                    <div
                      title={`${asks.length} open ask${asks.length === 1 ? '' : 's'} on this card`}
                      style={{
                        fontFamily: 'var(--cth-font-display)',
                        fontSize: 9,
                        color: 'var(--cth-coral)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {p + 1}/{asks.length}
                    </div>
                    <button
                      onClick={() => setPage({ ...page, [t.id]: p + 1 })}
                      disabled={p === asks.length - 1}
                      title="next ask"
                      aria-label="next ask"
                      style={{
                        flexShrink: 0,
                        width: 22,
                        height: 22,
                        padding: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        lineHeight: 1,
                        border: 'none',
                        cursor: p === asks.length - 1 ? 'default' : 'pointer',
                        background: 'transparent',
                        color: p === asks.length - 1 ? 'var(--cth-ink-300)' : 'var(--cth-ink-900)',
                        fontFamily: 'var(--cth-font-mono)',
                        fontSize: 13,
                      }}
                    >
                      ▶
                    </button>
                  </>
                ) : (
                  <div
                    title="one open ask on this card"
                    style={{
                      fontFamily: 'var(--cth-font-display)',
                      fontSize: 9,
                      color: 'var(--cth-coral)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    1 OPEN ASK
                  </div>
                )}
                <div style={{ flex: 1 }} />
                {/* Dismiss — clears the DISPLAYED ask off the board without
                    answering it. The card's Q&A history is preserved (the
                    question stays on the card, just marked dismissed). */}
                <button
                  onClick={() => void dismiss(t, o)}
                  disabled={sending === key}
                  title="dismiss — clear this ask off the ASK ME board without answering (history kept)"
                  aria-label="dismiss this ask"
                  style={{
                    flexShrink: 0,
                    width: 18,
                    height: 18,
                    padding: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    lineHeight: 1,
                    border: 'none',
                    cursor: sending === key ? 'default' : 'pointer',
                    background: 'transparent',
                    color: 'var(--cth-ink-500)',
                    fontFamily: 'var(--cth-font-ui)',
                    fontSize: 13,
                  }}
                  onMouseEnter={(e) => {
                    if (sending !== key) e.currentTarget.style.color = 'var(--cth-coral)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = 'var(--cth-ink-500)';
                  }}
                >
                  ✕
                </button>
              </div>

              {/* the displayed question */}
              <div
                style={{
                  fontSize: 15,
                  lineHeight: '19px',
                  color: 'var(--cth-ink-900)',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {o.entry.q}
              </div>

              {/* answer box — bound to the DISPLAYED ask's draft */}
              <textarea
                value={drafts[key] ?? ''}
                onChange={(e) => setAnswerDraft(key, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void sendAnswer(t, o);
                }}
                rows={3}
                placeholder="Your answer — or 'done', with the result… (Ctrl+Enter to send)"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '6px 8px',
                  resize: 'vertical',
                  background: 'var(--cth-paper-100)',
                  border: 'none',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                  fontFamily: 'var(--cth-font-mono)',
                  fontSize: 15,
                  lineHeight: '18px',
                  color: 'var(--cth-ink-900)',
                  outline: 'none',
                }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <PixelButton
                  variant="primary"
                  size="sm"
                  disabled={!(drafts[key] ?? '').trim() || sending === key}
                  onClick={() => void sendAnswer(t, o)}
                >
                  {sending === key ? 'sending…' : 'respond & unblock'}
                </PixelButton>
                {answeredCount > 0 && (
                  <button
                    onClick={() => openTaskDetail(t.id)}
                    title="open the task detail with the full Q&A history"
                    style={{
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      padding: 0,
                      fontSize: 10,
                      color: 'var(--cth-ink-700)',
                      fontFamily: 'var(--cth-font-display)',
                      textDecoration: 'underline',
                    }}
                  >
                    VIEW {answeredCount} EARLIER ANSWER{answeredCount === 1 ? '' : 'S'}
                  </button>
                )}
              </div>

              {/* the cascade: what's stuck behind this card's answers */}
              {stuck.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div
                    style={{
                      fontFamily: 'var(--cth-font-display)',
                      fontSize: 8,
                      color: 'var(--cth-coral)',
                    }}
                  >
                    BLOCKING {stuck.length} DOWNSTREAM TASK{stuck.length === 1 ? '' : 'S'}
                  </div>
                  {stuck.slice(0, 6).map((d, i) => (
                    <div
                      key={d.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        paddingLeft: 8 + Math.min(i, 3) * 8,
                        fontSize: 12,
                        color: 'var(--cth-ink-700)',
                      }}
                    >
                      <span style={{ color: 'var(--cth-ink-300)' }}>└</span>
                      <span
                        style={{
                          width: 7,
                          height: 7,
                          flexShrink: 0,
                          background:
                            d.status === 'blocked' ? 'var(--cth-coral)' : 'var(--cth-sky)',
                          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                        }}
                      />
                      <span
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {d.title}
                      </span>
                      {nameFor(d.assignee) && (
                        <span style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>
                          ({nameFor(d.assignee)})
                        </span>
                      )}
                    </div>
                  ))}
                  {stuck.length > 6 && (
                    <div style={{ paddingLeft: 14, fontSize: 11, color: 'var(--cth-ink-300)' }}>
                      … +{stuck.length - 6} more
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
