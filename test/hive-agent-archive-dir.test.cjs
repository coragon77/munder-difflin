'use strict';

/**
 * The operator sweeps retired agents into `hive/agents/archive/<id>` to keep the
 * floor readable. The path layer has to know about that folder, or two things
 * break: a re-hire builds a FRESH empty `agents/<id>` while the agent's memory
 * and inbox rot under `archive/`, and every readdir over `agents/` counts the
 * literal `archive` directory as an agent id.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-agent-archive-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, hive: new HiveManager(() => home), agents: path.join(home, 'hive', 'agents') };
}

/** Sweep a live agent folder into agents/archive/<id>, the way the operator does. */
function sweep(agents, id) {
  const dest = path.join(agents, 'archive', id);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(path.join(agents, id), dest);
}

test('re-hiring a swept agent restores its folder instead of starting blind', async (t) => {
  const { hive, agents } = floor(t);
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude' });

  fs.writeFileSync(path.join(agents, 'pam-1', 'memory.md'), '# Memory\n\nremember the toner order\n', 'utf8');
  fs.writeFileSync(path.join(agents, 'pam-1', 'inbox', 'm1.json'),
    JSON.stringify({ id: 'm1', from: 'god', to: 'pam-1', act: 'request', subject: 's', body: 'b' }), 'utf8');
  sweep(agents, 'pam-1');
  assert.equal(fs.existsSync(path.join(agents, 'pam-1')), false, 'precondition: swept away');

  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude' });

  assert.match(fs.readFileSync(path.join(agents, 'pam-1', 'memory.md'), 'utf8'), /toner order/,
    're-hire must get its memory back, not a fresh boilerplate file');
  assert.ok(fs.existsSync(path.join(agents, 'pam-1', 'inbox', 'm1.json')), 'inbox must come back too');
  assert.equal(fs.existsSync(path.join(agents, 'archive', 'pam-1')), false, 'no orphan copy left behind');
});

test('a live folder is never clobbered by the archived copy', async (t) => {
  const { hive, agents } = floor(t);
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude' });
  fs.mkdirSync(path.join(agents, 'archive', 'jim-1'), { recursive: true });
  fs.writeFileSync(path.join(agents, 'archive', 'jim-1', 'memory.md'), 'stale\n', 'utf8');
  fs.writeFileSync(path.join(agents, 'jim-1', 'memory.md'), 'live\n', 'utf8');

  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude' });

  assert.equal(fs.readFileSync(path.join(agents, 'jim-1', 'memory.md'), 'utf8'), 'live\n');
  assert.ok(fs.existsSync(path.join(agents, 'archive', 'jim-1')), 'archive copy left for the operator');
});

test('the archive sweep folder is never an agent owner', async (t) => {
  const { hive, agents } = floor(t);
  await hive.ensureAgent({ id: 'dwight-1', name: 'Dwight', provider: 'claude' });
  await hive.ensureAgent({ id: 'toby-1', name: 'Toby', provider: 'claude' });
  sweep(agents, 'toby-1');

  // The container is given agent-SHAPED subfolders on purpose. Today `archive/`
  // has no inbox/outbox of its own, so the old id-blind readdir got away with it
  // — the phantom owner produced zero messages and nobody noticed. This fixture
  // removes that accident so the invariant ("archive is a container, not an
  // agent") is actually asserted rather than assumed.
  fs.mkdirSync(path.join(agents, 'archive', 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(agents, 'archive', 'inbox', 'ghost.json'),
    JSON.stringify({ id: 'ghost', from: 'god', to: 'archive', act: 'inform', subject: 's', body: 'b' }), 'utf8');
  fs.writeFileSync(path.join(agents, 'dwight-1', 'outbox', 'a.json'),
    JSON.stringify({ id: 'a', to: 'toby-1', act: 'inform', subject: 'beets', body: 'b' }), 'utf8');
  hive.routeOnce();

  const owners = new Set(hive.voiceMessages({ limit: 40 }).map((m) => m.owner));
  assert.equal(owners.has('archive'), false, `phantom "archive" owner: ${[...owners]}`);
  assert.ok(owners.has('dwight-1'), 'real agents still listed');
  assert.equal(owners.has('toby-1'), false, 'swept agents stay off the live view');
});
