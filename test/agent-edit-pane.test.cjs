'use strict';

/**
 * AGENT PANE EDIT ANCHOR (agent-harness-agent-settings-b-2026-08-17).
 *
 * The agent-edit dialog (AddAgentModal editOf) was reachable from the monitor
 * and tasks windows only. The operator wants the SAME gear in the agent pane
 * header, beside the pin/detach controls. This file source-pins the wiring:
 *
 *  • AgentDetailPanel calls the SAME store mechanism (setEditAgent) — App
 *    already renders the single <AddAgentModal editOf> keyed on editAgentId,
 *    so the pane must NOT mount a second dialog.
 *  • The affordance is scoped like every other gear: human-class only (god's
 *    pane is the CommandCenter, which offers no god gear; interns are
 *    fire-and-rehire — no setup dialog).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const read = (p) => readFileSync(path.join(repoRoot, p), 'utf8');

test('the agent pane header anchors the edit gear beside the pin control', () => {
  const src = read('src/renderer/src/components/AgentDetailPanel.tsx');
  assert.ok(src.includes('setEditAgent'), 'the pane opens the edit dialog via the store');
  assert.ok(
    src.includes('setEditAgent(agent.id)'),
    "the gear passes THIS pane agent id to the dialog, not someone else's",
  );
  assert.ok(
    src.includes("agentClassOf(agent) === 'human'"),
    'the gear is class-scoped like the monitor and tasks gears (human only)',
  );
  assert.ok(src.includes('Icon name="gear"'), 'the affordance is the same gear icon');

  // Placement: inside the header, next to the pin button (the card pins it to
  // the existing header controls cluster, not the tab body or the composer).
  const gearAt = src.indexOf('setEditAgent(agent.id)');
  const pinAt = src.indexOf('onClick={onTogglePin}');
  assert.ok(gearAt > 0 && pinAt > gearAt, 'the gear sits with the header controls, before pin');

  // No second dialog: the pane must not import or mount its own edit modal.
  assert.ok(
    !src.includes('AddAgentModal'),
    "the pane reuses App's single dialog — never mounts its own",
  );
});
