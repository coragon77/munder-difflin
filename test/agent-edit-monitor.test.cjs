'use strict';

/**
 * MONITOR EDIT ANCHOR (harness-editbtn-monitor-20260817).
 *
 * The agent-edit dialog (agent-edit-dialog-20260817) opened only from the
 * tasks view's agents chip row. The operator wants the SAME dialog reachable
 * from the MONITOR tab (CommandCenterPanel FloorTab) — pre-filled for the
 * clicked agent, no new dialog logic. This file source-pins the wiring:
 *
 *  • FloorTab calls the SAME store mechanism (setEditAgent) — App already
 *    renders the single <AddAgentModal editOf> keyed on editAgentId, so the
 *    monitor must NOT mount a second dialog.
 *  • The affordance is scoped like the tasks view: human-class agents only
 *    (god runs himself, interns are fire-and-rehire — no setup dialog).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const read = (p) => readFileSync(path.join(repoRoot, p), 'utf8');

test('the monitor tab (FloorTab) anchors an edit affordance per human agent', () => {
  const src = read('src/renderer/src/components/CommandCenterPanel.tsx');
  assert.ok(src.includes('setEditAgent'), 'FloorTab opens the edit dialog via the store');
  assert.ok(
    src.includes('agentClassOf'),
    'the affordance is class-scoped like the tasks-view chips (human only)',
  );
  // The AGENTS section renders it per agent card, wired to that card's id —
  // not a stray toolbar toggle that opens someone else's dialog.
  const agentsAt = src.indexOf('Section title="AGENTS"');
  assert.ok(agentsAt > 0, 'the AGENTS section exists');
  const section = src.slice(agentsAt, agentsAt + 12000);
  assert.ok(
    section.includes('setEditAgent(a.id)'),
    'the per-agent button passes ITS agent id to the dialog',
  );
});

test('the monitor reuses the single dialog — it mounts no second AddAgentModal', () => {
  const src = read('src/renderer/src/components/CommandCenterPanel.tsx');
  assert.ok(
    !src.includes('AddAgentModal'),
    'App owns the one <AddAgentModal editOf>; the monitor only sets editAgentId',
  );
});
