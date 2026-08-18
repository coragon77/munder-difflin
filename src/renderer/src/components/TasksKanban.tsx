import { useCallback, useEffect, useRef, useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { PixelBadge } from './PixelBadge';
import { Icon } from './Icon';
import { TASK_BOARD_RESYNC_EVENT } from '@/scene/office/taskBoardReconcile';
import { useStore, agentClassOf, displayAgentName } from '@/store/store';

/** A card on the task kanban. Mirrors HiveTask in the main/preload process —
 *  re-declared locally so the renderer doesn't reach into the preload package
 *  (same convention as store/config.ts). Structurally compatible with
 *  window.cth.hiveWriteTasks. */
export interface HumanQA {
  q: string;
  a?: string;
  askedAt?: string;
  answeredAt?: string;
  /** Set when the human dismisses the ask from the ASK ME board WITHOUT
   *  answering — the question stays on the card (history is preserved) but
   *  openQuestion() stops returning it, so the card leaves ASK ME. */
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
  /** First-class human feedback: the god appends {q} when a card needs the
   *  human; the ASK ME view fills in {a}. Full history stays on the card. */
  humanQA?: HumanQA[];
  /** Set when the HUMAN created this card from the tasks tab. Gates the UI's
   *  delete control (only human-origin cards, only while still 'todo'). */
  origin?: 'human';
}

/** The card's currently open question for the human, if any. An entry the human
 *  dismissed (dismissedAt) counts as resolved, same as an answered one. */
export function openQuestion(t: HiveTask): HumanQA | undefined {
  if (!Array.isArray(t.humanQA)) return undefined;
  for (let i = t.humanQA.length - 1; i >= 0; i--) {
    const e = t.humanQA[i];
    if (e && typeof e.q === 'string' && !e.a && !e.dismissedAt) return e;
  }
  return undefined;
}

/** Waiting on the human = blocked with an unanswered question on the card. */
export function waitsOnHuman(t: HiveTask): boolean {
  return t.status === 'blocked' && !!openQuestion(t);
}

type Status = HiveTask['status'];

const COLUMNS: { key: Status; label: string; accent: string }[] = [
  { key: 'todo', label: 'TODO', accent: 'var(--cth-sky)' },
  { key: 'doing', label: 'DOING', accent: 'var(--cth-lemon)' },
  { key: 'blocked', label: 'BLOCKED', accent: 'var(--cth-coral)' },
  { key: 'done', label: 'DONE', accent: 'var(--cth-mint)' },
];

const POLL_MS = 5000;

/** Deterministic fallback id derived from a task's content (djb2 → base36).
 *  Used for tasks lacking a valid string id so re-parsing tasks.json on every
 *  5s poll yields the SAME id — no React key churn / card remount. Unlike
 *  shortId() (random, for brand-new tasks), this never changes across polls. */
function stableId(seed: string): string {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = (((h << 5) + h) ^ seed.charCodeAt(i)) | 0;
  return `t-${(h >>> 0).toString(36)}`;
}

/** Normalize whatever hive:tasks returns into a typed task array. The god
 *  writes this file by hand — every field except the shape itself is optional
 *  in practice, so EVERY consumer must go through this (exported for the
 *  detail overlay; a raw card without dependsOn once crashed it).
 *
 *  FIELD SURVIVAL (card agent-tasks-tab-ui-strips-card-2026-08-18): the card
 *  SPREADS the raw entry and overrides only the normalized fields below — a
 *  previous whitelist silently dropped sessionId, sessionMode, result, slack,
 *  webhook and downgraded origin:'agent' to undefined, and the overlay's
 *  whole-ledger rewrite then stripped them from tasks.json on EVERY move
 *  (lost /resume keys, dead Slack routing). Unknown/future fields (e.g. the
 *  upcoming paused flag) now survive any round-trip forever. */
export function parseTasks(raw: unknown): HiveTask[] {
  const list =
    raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks)
      ? (raw as { tasks: unknown[] }).tasks
      : [];
  return list
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t, i) => ({
      ...t,
      id:
        typeof t.id === 'string' && t.id
          ? t.id
          : stableId(
              `${typeof t.title === 'string' ? t.title : ''}|${typeof t.createdAt === 'string' ? t.createdAt : ''}|${i}`,
            ),
      title: typeof t.title === 'string' ? t.title : '(untitled)',
      description: typeof t.description === 'string' ? t.description : undefined,
      assignee: typeof t.assignee === 'string' ? t.assignee : undefined,
      status: (['todo', 'doing', 'blocked', 'done'] as const).includes(t.status as Status)
        ? (t.status as Status)
        : 'todo',
      dependsOn: Array.isArray(t.dependsOn)
        ? t.dependsOn.filter((d): d is string => typeof d === 'string')
        : [],
      priority: typeof t.priority === 'number' ? t.priority : 3,
      createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date().toISOString(),
      humanQA: Array.isArray(t.humanQA)
        ? (t.humanQA as unknown[])
            .filter(
              (e): e is Record<string, unknown> =>
                !!e && typeof e === 'object' && typeof (e as { q?: unknown }).q === 'string',
            )
            .map((e) => ({
              q: e.q as string,
              a: typeof e.a === 'string' ? e.a : undefined,
              askedAt: typeof e.askedAt === 'string' ? e.askedAt : undefined,
              answeredAt: typeof e.answeredAt === 'string' ? e.answeredAt : undefined,
              // Preserve a dismissal across the 5s re-parse, else the card would
              // resurface on the next poll (openQuestion would see it as open).
              dismissedAt: typeof e.dismissedAt === 'string' ? e.dismissedAt : undefined,
            }))
        : undefined,
      origin: t.origin === 'human' ? 'human' : undefined,
    }));
}

/**
 * Task kanban over hive/tasks.json. Polls every 5s. The god remains the
 * ledger's writer of record — but the human can ADD cards from here (routed
 * through the main process, which read-modify-writes the file at action time
 * and mails the god an inform so nothing enters the board unheard) and delete
 * their OWN cards while those are still untouched 'todo'.
 */
export function TasksKanban() {
  const agents = useStore((s) => s.agents);
  const setEditAgent = useStore((s) => s.setEditAgent);
  const [tasks, setTasks] = useState<HiveTask[]>([]);
  // Human add-form (toolbar): title + optional notes.
  const [adding, setAdding] = useState(false);
  // Agent-setup chips (toolbar): the tasks view's edit anchor — one chip per
  // live human-class worker, click reopens the agent dialog pre-filled
  // (agent-edit-dialog-20260817). God runs himself (Command Center), interns
  // are god's fire-and-rehire disposables — neither gets a setup dialog.
  const [showAgents, setShowAgents] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  // Detail view: cards show just the title — clicking one opens the full
  // breakdown as an APP-WIDE overlay over the office floor (see
  // TaskDetailOverlay) — the content grows (contracts, deps, human Q&A), so it
  // gets the big stage instead of the narrow side panel.
  const openTaskDetail = useStore((s) => s.openTaskDetail);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setTasks(parseTasks(await window.cth.hiveTasks()));
    } catch {
      /* keep last good */
    }
  }, []);

  // Human-created card: main process does the read-modify-write on tasks.json
  // (never a renderer-side whole-file overwrite — the god edits that file too).
  // No wake-up message: god triages human cards at heartbeat standups.
  const addTask = useCallback(async () => {
    const title = newTitle.trim();
    if (!title) return;
    try {
      const res = await window.cth.hiveAddHumanTask(title, newNotes.trim() || undefined);
      if (!res.ok) throw new Error(res.error ?? 'failed');
      setNewTitle('');
      setNewNotes('');
      setAdding(false);
      setAddError(null);
      await refresh();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    }
  }, [newTitle, newNotes, refresh]);

  useEffect(() => {
    refresh();
    timer.current = setInterval(refresh, POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [refresh]);

  const restorableAgents = useStore((s) => s.restorableAgents);
  /** Resolve an assignee id to a display name — falls back to the restorable
   *  roster so a done card keeps its author's name even after that worker's
   *  terminal is gone, then to the raw id. */
  const nameFor = (id?: string): string | undefined =>
    id
      ? (agents.find((a) => a.id === id)?.name ??
        restorableAgents.find((a) => a.id === id)?.name ??
        id)
      : undefined;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--cth-paper-200)',
        position: 'relative',
      }}
    >
      {/* Toolbar — the god writes the ledger, but the human can ADD cards
          (origin 'human'; triaged by the god at heartbeats) and delete their
          own while still untouched todo (detail view). */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          flexShrink: 0,
          borderBottom: '1px solid var(--cth-ink-300)',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--cth-font-display)',
            fontSize: 9,
            color: 'var(--cth-ink-500)',
          }}
        >
          {tasks.length} task{tasks.length === 1 ? '' : 's'}
        </span>
        <PixelButton
          variant="secondary"
          size="sm"
          onClick={() => {
            setAdding((a) => !a);
            setAddError(null);
          }}
        >
          + task
        </PixelButton>
        <PixelButton variant="secondary" size="sm" onClick={() => setShowAgents((v) => !v)}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <Icon name="gear" /> agents
          </span>
        </PixelButton>
        <PixelButton
          variant="secondary"
          size="sm"
          title="Reload the office floor boards from the task ledger"
          onClick={() => window.dispatchEvent(new Event(TASK_BOARD_RESYNC_EVENT))}
        >
          sync floor boards
        </PixelButton>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--cth-ink-300)' }}>
          urgent? dispatch it to Michael (monitor tab)
        </span>
      </div>
      {adding && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '8px 10px',
            flexShrink: 0,
            borderBottom: '1px solid var(--cth-ink-300)',
            background: 'var(--cth-cream-100)',
          }}
        >
          <input
            autoFocus
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addTask();
              if (e.key === 'Escape') setAdding(false);
            }}
            placeholder="task title — becomes a todo card for Michael to triage"
            style={inputStyle}
          />
          <input
            value={newNotes}
            onChange={(e) => setNewNotes(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addTask();
              if (e.key === 'Escape') setAdding(false);
            }}
            placeholder="notes (optional)"
            style={inputStyle}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <PixelButton
              variant="primary"
              size="sm"
              disabled={!newTitle.trim()}
              onClick={() => void addTask()}
            >
              add
            </PixelButton>
            <PixelButton variant="ghost" size="sm" onClick={() => setAdding(false)}>
              cancel
            </PixelButton>
            {addError && (
              <span style={{ fontSize: 11, color: 'var(--cth-coral)' }}>{addError}</span>
            )}
          </div>
        </div>
      )}

      {showAgents && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 10px',
            flexShrink: 0,
            borderBottom: '1px solid var(--cth-ink-300)',
            background: 'var(--cth-cream-100)',
            flexWrap: 'wrap',
          }}
        >
          {agents.filter((a) => agentClassOf(a) === 'human').length === 0 && (
            <span style={{ fontSize: 11, color: 'var(--cth-ink-300)' }}>
              no editable agents on the floor — hire one first (add agent)
            </span>
          )}
          {agents
            .filter((a) => agentClassOf(a) === 'human')
            .map((a) => (
              <button
                key={a.id}
                onClick={() => setEditAgent(a.id)}
                title={`edit ${displayAgentName(a)}'s setup — name, engine, briefing`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '3px 8px 2px',
                  border: 'none',
                  cursor: 'pointer',
                  background: `var(--cth-${a.accent}-light)`,
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                  fontFamily: 'var(--cth-font-ui)',
                  fontSize: 12,
                  color: 'var(--cth-ink-900)',
                }}
              >
                <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10 }}>
                  {displayAgentName(a).toUpperCase()}
                </span>
                <Icon name="gear" />
              </button>
            ))}
        </div>
      )}

      {/* Columns */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          gap: 8,
          padding: 10,
          overflowX: 'auto',
        }}
      >
        {COLUMNS.map((col) => {
          const cards = tasks.filter((t) => t.status === col.key);
          return (
            <div
              key={col.key}
              style={{
                flex: '1 1 0',
                minWidth: 170,
                display: 'flex',
                flexDirection: 'column',
                background: 'var(--cth-cream-100)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '5px 8px 4px',
                  background: col.accent,
                  boxShadow: 'inset 0 -1px 0 var(--cth-ink-900)',
                  fontFamily: 'var(--cth-font-display)',
                  fontSize: 9,
                  color: 'var(--cth-ink-900)',
                }}
              >
                {col.label}
                <span
                  style={{ marginLeft: 'auto', fontSize: 11, fontFamily: 'var(--cth-font-ui)' }}
                >
                  {cards.length}
                </span>
              </div>
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflowY: 'auto',
                  padding: 6,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                {cards.length === 0 && (
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--cth-ink-300)',
                      textAlign: 'center',
                      padding: '8px 0',
                    }}
                  >
                    —
                  </div>
                )}
                {cards.map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    accent={col.accent}
                    assigneeName={nameFor(t.assignee)}
                    onOpen={() => openTaskDetail(t.id)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Card ────────────────────────────────────────────────────────────────────
// Deliberately minimal — a colored status edge, the title, a whisper of an
// assignee. Everything else (the full contract, deps, controls) lives in the
// detail view a click away: a kanban card can carry a title at most.

function TaskCard({
  task,
  accent,
  assigneeName,
  onOpen,
}: {
  task: HiveTask;
  accent: string;
  assigneeName?: string;
  onOpen: () => void;
}) {
  return (
    <div style={{ position: 'relative', display: 'flex' }}>
      <button
        onClick={onOpen}
        title="open task details"
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'stretch',
          gap: 0,
          padding: 0,
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          background: 'var(--cth-paper-100)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
        }}
      >
        <span
          style={{
            width: 4,
            flexShrink: 0,
            background: accent,
            boxShadow: 'inset -1px 0 0 var(--cth-ink-700)',
          }}
        />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            padding: '6px 7px',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <span
            style={{
              fontFamily: 'var(--cth-font-ui)',
              fontSize: 12,
              lineHeight: '16px',
              color: 'var(--cth-ink-900)',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {task.title}
          </span>
          {assigneeName && (
            <span
              style={{
                fontSize: 10,
                color: 'var(--cth-ink-500)',
                fontFamily: 'var(--cth-font-display)',
              }}
            >
              {assigneeName.toUpperCase()}
            </span>
          )}
        </span>
        {waitsOnHuman(task) && (
          <span
            title="waiting on YOUR answer — see the ASK ME tab"
            style={{
              alignSelf: 'center',
              marginRight: 6,
              flexShrink: 0,
              fontFamily: 'var(--cth-font-display)',
              fontSize: 10,
              padding: '2px 5px 1px',
              background: 'var(--cth-lilac)',
              color: 'var(--cth-ink-900)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            }}
          >
            ?
          </span>
        )}
      </button>
    </div>
  );
}

// ─── Detail view ─────────────────────────────────────────────────────────────
// The full breakdown of one task: status, assignee, priority, the complete
// description (the god writes 4-part dispatch contracts in there — preserved
// line by line), dependencies resolved to their titles, the human Q&A trail,
// and the move/assign controls that used to crowd every card. Rendered as an
// APP-WIDE overlay (over the office floor) — this content grows, so it gets
// the big stage instead of the narrow side panel. Exported for App's
// TaskDetailOverlay; opened via the store's openTaskDetail from anywhere.

export function TaskDetail({
  task,
  all,
  assigneeName,
  onMove,
  onAssign,
  onClose,
  onDelete,
}: {
  task: HiveTask;
  all: HiveTask[];
  assigneeName?: string;
  onMove: (s: Status) => void;
  onAssign: () => void;
  onClose: () => void;
  /** Delete this card — only offered for human-origin todo cards (enforced
   *  again in the main process; god-created and picked-up cards survive). */
  onDelete?: () => void;
}) {
  const col = COLUMNS.find((c) => c.key === task.status) ?? COLUMNS[0];
  // Belt + suspenders: parseTasks normalizes these, but the ledger is a
  // hand-written file — never trust a card's shape at the point of use.
  const deps = (task.dependsOn ?? [])
    .map((id) => all.find((t) => t.id === id))
    .filter((t): t is HiveTask => !!t);
  const created = new Date(task.createdAt);
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 280,
        background: 'rgba(26, 19, 32, 0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 720, maxWidth: '94vw', maxHeight: '90vh', display: 'flex' }}
      >
        <PixelPanel
          variant="dialog"
          title="TASK"
          noPadding
          style={{ display: 'flex', flexDirection: 'column', width: '100%', minHeight: 0 }}
        >
          <div
            style={{
              padding: 14,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              minHeight: 0,
              overflowY: 'auto',
            }}
          >
            {/* Title under a status-colored bar */}
            <div style={{ borderLeft: `4px solid ${col.accent}`, paddingLeft: 8 }}>
              <div
                style={{
                  fontFamily: 'var(--cth-font-ui)',
                  fontSize: 15,
                  lineHeight: '20px',
                  color: 'var(--cth-ink-900)',
                }}
              >
                {task.title}
              </div>
            </div>

            {/* Fact row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span
                style={{
                  fontFamily: 'var(--cth-font-display)',
                  fontSize: 8,
                  padding: '2px 6px 1px',
                  background: col.accent,
                  color: 'var(--cth-ink-900)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                }}
              >
                {col.label}
              </span>
              {assigneeName ? (
                <PixelBadge status="working" label={assigneeName} />
              ) : (
                <span style={{ fontSize: 11, color: 'var(--cth-ink-300)' }}>unassigned</span>
              )}
              <PriorityDots level={Math.max(1, Math.min(5, task.priority))} />
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: 10,
                  color: 'var(--cth-ink-500)',
                  fontFamily: 'var(--cth-font-display)',
                }}
              >
                {Number.isNaN(created.getTime()) ? '' : created.toLocaleString()}
              </span>
            </div>

            {/* The contract — preserved line by line */}
            <div
              style={{
                padding: 10,
                background: 'var(--cth-paper-100)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                fontFamily: 'var(--cth-font-mono)',
                fontSize: 12,
                lineHeight: '18px',
                color: 'var(--cth-ink-900)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {task.description?.trim() || (
                <span style={{ color: 'var(--cth-ink-300)' }}>(no description on this card)</span>
              )}
            </div>

            {/* The human Q&A trail — every decision documented on the card */}
            {(task.humanQA?.length ?? 0) > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div
                  style={{
                    fontFamily: 'var(--cth-font-display)',
                    fontSize: 8,
                    color: 'var(--cth-ink-500)',
                  }}
                >
                  HUMAN Q&A
                </div>
                {/* biome-ignore-start lint/suspicious/noArrayIndexKey: append-only QA event log — index stays stable for existing rows */}
                {task.humanQA!.map((e, i) => (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div
                      style={{
                        padding: '5px 7px',
                        background: 'var(--cth-lilac-light, #ece2f5)',
                        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                        fontSize: 12,
                        lineHeight: '17px',
                        color: 'var(--cth-ink-900)',
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      <span
                        style={{
                          fontFamily: 'var(--cth-font-display)',
                          fontSize: 8,
                          marginRight: 6,
                        }}
                      >
                        Q
                      </span>
                      {e.q}
                    </div>
                    {e.a ? (
                      <div
                        style={{
                          padding: '5px 7px',
                          background: 'var(--cth-mint-light, #d9eed9)',
                          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                          fontSize: 12,
                          lineHeight: '17px',
                          color: 'var(--cth-ink-900)',
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        <span
                          style={{
                            fontFamily: 'var(--cth-font-display)',
                            fontSize: 8,
                            marginRight: 6,
                          }}
                        >
                          A
                        </span>
                        {e.a}
                      </div>
                    ) : (
                      <div
                        style={{
                          fontSize: 11,
                          color: 'var(--cth-coral)',
                          fontFamily: 'var(--cth-font-display)',
                        }}
                      >
                        AWAITING YOUR ANSWER — ASK ME TAB
                      </div>
                    )}
                  </div>
                ))}
                {/* biome-ignore-end lint/suspicious/noArrayIndexKey: end human QA rows */}
              </div>
            )}

            {/* Dependencies, resolved to titles */}
            {deps.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div
                  style={{
                    fontFamily: 'var(--cth-font-display)',
                    fontSize: 8,
                    color: 'var(--cth-ink-500)',
                  }}
                >
                  DEPENDS ON
                </div>
                {deps.map((d) => {
                  const dc = COLUMNS.find((c) => c.key === d.status) ?? COLUMNS[0];
                  return (
                    <div
                      key={d.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '3px 6px',
                        background: 'var(--cth-cream-200)',
                        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                        fontSize: 12,
                        color: 'var(--cth-ink-700)',
                      }}
                    >
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          background: dc.accent,
                          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                          flexShrink: 0,
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
                    </div>
                  );
                })}
              </div>
            )}

            {/* Controls */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <select
                value={task.status}
                onChange={(e) => onMove(e.target.value as Status)}
                style={{
                  flex: 1,
                  padding: '4px 6px',
                  background: 'var(--cth-paper-100)',
                  border: 'none',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                  fontFamily: 'var(--cth-font-ui)',
                  fontSize: 12,
                  color: 'var(--cth-ink-900)',
                  cursor: 'pointer',
                }}
              >
                {COLUMNS.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label.toLowerCase()}
                  </option>
                ))}
              </select>
              <PixelButton variant="secondary" size="sm" onClick={onAssign}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  <Icon name="arrow-right" /> assign
                </span>
              </PixelButton>
              <PixelButton variant="ghost" size="sm" onClick={onClose}>
                close
              </PixelButton>
            </div>
            {/* Delete — human-origin todo cards only. Everything else (god's
                cards, anything the hive picked up) is not the UI's to remove. */}
            {onDelete && task.origin === 'human' && task.status === 'todo' && (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <PixelButton variant="destructive" size="sm" onClick={onDelete}>
                  delete card
                </PixelButton>
              </div>
            )}
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}

function PriorityDots({ level }: { level: number }) {
  // 1 = lowest, 5 = highest. Warmer fill as priority climbs.
  const color =
    level >= 4 ? 'var(--cth-coral)' : level === 3 ? 'var(--cth-lemon)' : 'var(--cth-mint)';
  return (
    <span
      title={`Priority ${level}/5`}
      style={{ display: 'inline-flex', gap: 1, flexShrink: 0, marginTop: 2 }}
    >
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          style={{
            width: 4,
            height: 8,
            background: i <= level ? color : 'var(--cth-cream-200)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
          }}
        />
      ))}
    </span>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 12,
  lineHeight: '17px',
  color: 'var(--cth-ink-900)',
  outline: 'none',
  boxSizing: 'border-box',
};
