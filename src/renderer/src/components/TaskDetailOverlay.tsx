import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { TaskDetail, parseTasks, type HiveTask } from './TasksKanban';

/**
 * App-wide host for the task detail: whoever calls store.openTaskDetail(id) —
 * a kanban card, the sticky note on an agent's strip card, a floor prop —
 * gets the SAME big overlay rendered over the office floor. Keeps its own
 * 5s ledger poll so an open detail stays fresh while the god edits cards.
 */

const POLL_MS = 5000;

export function TaskDetailOverlay() {
  const taskDetailId = useStore((s) => s.taskDetailId);
  const closeTaskDetail = useStore((s) => s.closeTaskDetail);
  const agents = useStore((s) => s.agents);
  const restorable = useStore((s) => s.restorableAgents);
  const [tasks, setTasks] = useState<HiveTask[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    // parseTasks NORMALIZES (the ledger is a hand-written file; cards may lack
    // dependsOn/priority/etc.) — a raw card without dependsOn crashed the
    // detail once. Never feed TaskDetail unparsed ledger entries.
    try {
      setTasks(parseTasks(await window.cth.hiveTasks()));
    } catch {
      /* keep last good */
    }
  }, []);

  useEffect(() => {
    if (!taskDetailId) return;
    void refresh();
    timer.current = setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [taskDetailId, refresh]);

  if (!taskDetailId) return null;
  const task = tasks.find((t) => t.id === taskDetailId);
  if (!task) return null;

  const nameFor = (id?: string): string | undefined =>
    id
      ? (agents.find((a) => a.id === id)?.name ?? restorable.find((a) => a.id === id)?.name ?? id)
      : undefined;

  const move = async (status: HiveTask['status']) => {
    // Targeted main-process read-modify-write (card agent-tasks-tab-ui-
    // strips-card-2026-08-18) — NEVER a whole-ledger overwrite from this
    // 5s-stale copy: that path stripped unknown fields off every card and
    // silently reverted concurrent CLI flips. updateTaskStatus re-reads the
    // ledger under tasks.json.lock and patches only this card; false (lock
    // contended / card gone) reverts the optimistic flip via the next poll.
    // The →doing flip clears `paused` server-side (auto-resume).
    setTasks(tasks.map((t) => (t.id === task.id ? { ...t, status } : t))); // optimistic
    try {
      const res = await window.cth.hiveUpdateTaskStatus(task.id, status);
      if (!res?.ok) void refresh();
    } catch {
      void refresh();
    }
  };

  // The labeled on-hold toggle (card agent-every-non-paused-todo-ke-2026-08-
  // 18, amendment E secondary control — the one-click pause glyph sits on
  // the card face in the kanban). Same targeted-write discipline as move():
  // main re-reads the ledger under the lock and patches only this card.
  const togglePaused = async () => {
    setTasks(tasks.map((t) => (t.id === task.id ? { ...t, paused: !t.paused } : t))); // optimistic
    try {
      const res = await window.cth.hiveSetTaskPaused(task.id, !task.paused);
      if (!res?.ok) void refresh();
    } catch {
      void refresh();
    }
  };

  const assign = () => {
    // Route through the Command Center's dispatch box (which mails the god —
    // the human never writes into a worker's inbox directly). The seed names
    // the card BOTH in prose ('Card: <id>' line) and structurally (cardId) so
    // the god ADOPTS this card (hive-card update) instead of minting a twin.
    const st = useStore.getState();
    const god = st.agents.find((a) => a.isGod);
    if (god) st.select(god.id);
    const desc = task.description?.trim() ? task.description.trim() : '(no description)';
    st.requestDispatchSeed(`Task: ${task.title}\nContext: ${desc}\nCard: ${task.id}\n`, task.id);
    st.requestCommandCenterTab('floor');
    closeTaskDetail();
  };

  // Delete a human-origin card (offered only while still 'todo'; the main
  // process re-checks both conditions before touching tasks.json).
  const del = async () => {
    try {
      await window.cth.hiveDeleteHumanTask(task.id);
    } catch {
      /* stay open on failure */
    }
    closeTaskDetail();
  };

  return (
    <TaskDetail
      task={task}
      all={tasks}
      assigneeName={nameFor(task.assignee)}
      onMove={(s) => void move(s)}
      onAssign={assign}
      onClose={closeTaskDetail}
      onDelete={() => void del()}
      onTogglePaused={() => void togglePaused()}
      togglePausedLabel={task.paused ? 'resume' : 'set on hold'}
    />
  );
}
