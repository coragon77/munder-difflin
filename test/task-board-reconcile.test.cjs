'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const reconcileModule = path.resolve(
  __dirname,
  '../src/renderer/src/scene/office/taskBoardReconcile.ts',
);

test('an idle poll repairs a stale animation finish without interrupting choreography', () => {
  assert.ok(fs.existsSync(reconcileModule), 'task-board reconciliation is implemented');
  const { reconcileTaskBoard } = loadTs('src/renderer/src/scene/office/taskBoardReconcile.ts');

  // Reproduction: a newer doing -> done poll direct-set the visual card while
  // its actor was busy, then the older todo -> doing animation finished last.
  const stale = new Map([['card', { status: 'doing', assignee: 'erin' }]]);
  const ledger = [{ id: 'card', status: 'done', assignee: 'erin' }];

  assert.strictEqual(
    reconcileTaskBoard(stale, ledger, true),
    stale,
    'an active or queued move keeps its theatre',
  );
  const repaired = reconcileTaskBoard(stale, ledger, false);
  assert.deepEqual(
    [...repaired],
    [['card', { status: 'done', assignee: 'erin' }]],
    'the first idle poll restores the ledger truth',
  );
  assert.strictEqual(
    reconcileTaskBoard(repaired, ledger, false),
    repaired,
    'an already-correct idle poll avoids an unnecessary redraw',
  );

  const floor = fs.readFileSync(
    path.resolve(__dirname, '../src/renderer/src/scene/office/OfficeFloor.tsx'),
    'utf8',
  );
  assert.ok(
    /const choreographyInFlight = moveQueue\.length > 0 \|\| busyActors\.size > 0;[\s\S]{0,180}reconcileTaskBoard\(\s*visualTasks,\s*ledger,\s*choreographyInFlight/.test(
      floor,
    ),
    'the poll wires both queued and active choreography into reconciliation',
  );
});

test('the tasks toolbar can request a floor-board cold resync', () => {
  const { TASK_BOARD_RESYNC_EVENT } = loadTs('src/renderer/src/scene/office/taskBoardReconcile.ts');
  assert.equal(TASK_BOARD_RESYNC_EVENT, 'cth:resync-task-boards');

  const kanban = fs.readFileSync(
    path.resolve(__dirname, '../src/renderer/src/components/TasksKanban.tsx'),
    'utf8',
  );
  const floor = fs.readFileSync(
    path.resolve(__dirname, '../src/renderer/src/scene/office/OfficeFloor.tsx'),
    'utf8',
  );
  assert.match(kanban, /dispatchEvent\(new Event\(TASK_BOARD_RESYNC_EVENT\)\)/);
  assert.match(kanban, />\s*sync floor boards\s*</);
  assert.match(floor, /addEventListener\(TASK_BOARD_RESYNC_EVENT/);
  assert.match(floor, /removeEventListener\(TASK_BOARD_RESYNC_EVENT/);
  assert.match(
    floor,
    /setTimeout\(\(\) => \{\s+if \(mountIdRef\.current !== mountId\) return;/,
    'a resync invalidates the old scene before its acting timeout can redraw',
  );
});
