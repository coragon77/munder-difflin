'use strict';

/**
 * Agent panes must be their OWN claude sessions, not nested children of the
 * session that launched the harness (card pane-session-persistence-20260816).
 *
 * When the app starts from inside a claude session (god's detached restart
 * script), process.env carries CLAUDE_CODE_CHILD_SESSION & friends; inherited
 * through the pty merge they make the CLI treat every pane as a child session
 * and disable transcript saving fleet-wide. buildSpawnEnv scrubs them for
 * agent panes (extra has AGENT_ID) and forces persistence on; non-agent panes
 * keep inheriting untouched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { buildSpawnEnv } = loadTs('src/main/pty.ts');

const MARKERS = [
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_PID',
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT'
];

test('agent pane: child-session markers scrubbed, persistence forced', () => {
  const inherited = Object.fromEntries(MARKERS.map((k) => [k, '1']));
  const env = buildSpawnEnv(inherited, { AGENT_ID: 'a1', HIVE_ROOT: '/h' }, '/usr/bin');
  for (const k of MARKERS) assert.equal(k in env, false, `${k} must not leak into an agent pane`);
  assert.equal(env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE, '1');
  assert.equal(env.AGENT_ID, 'a1');
  assert.equal(env.HIVE_ROOT, '/h');
});

test('non-agent pane: inheritance untouched', () => {
  const inherited = Object.fromEntries(MARKERS.map((k) => [k, '1']));
  const env = buildSpawnEnv(inherited, { SOMETHING: 'x' }, '/usr/bin');
  for (const k of MARKERS) assert.equal(env[k], '1', `${k} belongs to whoever owns this tab`);
  assert.equal('CLAUDE_CODE_FORCE_SESSION_PERSISTENCE' in env, false);
});

test('per-pane extras still win the merge and base flags stay set', () => {
  const env = buildSpawnEnv({ FORCE_COLOR: '0' }, { AGENT_ID: 'a1', HIVE_SOCK: '/sock' }, '/p');
  assert.equal(env.HIVE_SOCK, '/sock');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.PATH, '/p');
});
