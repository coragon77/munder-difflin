'use strict';

/**
 * installPiHooks reconciles the `subagents` block of an existing per-agent
 * settings copy with the operator's user-level settings (card
 * agent-installpihooks-freezes-e-2026-08-21).
 *
 * The copy used to be written ONCE (`!existsSync` guard): copies made before
 * an operator-level model switch stayed frozen forever, so every reviewer
 * call by a stale agent kept burning the retired model. The subagents block
 * is an operator-level budget decision — it is reconciled from the user file
 * on every spawn; every other key (theme, packages, …) stays per-agent.
 *
 * Hermetic: fixture $HOME (os.homedir() reads $HOME on POSIX at call time),
 * fixture agent dir — never a live agent's .pi-agent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const installPiHooks = HiveManager.prototype['installPiHooks'];

const USER_BLOCK = { defaultModel: 'm/current', agentOverrides: { reviewer: { model: 'terra' } } };
const STALE_BLOCK = { defaultModel: 'm/old', agentOverrides: { reviewer: { model: 'sol' } } };

/** Fixture hive: $HOME with user settings + an agent dir, HOME swapped in. */
function withFixture(userSettings, agentSettings, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reconcile-'));
  const home = path.join(root, 'home');
  const agentDir = path.join(root, 'agents', 'fixture-agent');
  fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
  if (userSettings !== null)
    fs.writeFileSync(
      path.join(home, '.pi', 'agent', 'settings.json'),
      typeof userSettings === 'string' ? userSettings : JSON.stringify(userSettings),
    );
  if (agentSettings !== null) {
    fs.mkdirSync(path.join(agentDir, '.pi-agent'), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, '.pi-agent', 'settings.json'),
      typeof agentSettings === 'string' ? agentSettings : JSON.stringify(agentSettings),
    );
  }
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn(path.join(agentDir, '.pi-agent', 'settings.json'));
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('stale subagents block on an existing copy is healed from the user file', () => {
  withFixture(
    { subagents: USER_BLOCK },
    { subagents: STALE_BLOCK, theme: 'dracula', packages: ['npm:pi-subagents'] },
    (dest) => {
      installPiHooks.call(null, path.dirname(path.dirname(dest)));
      const after = read(dest);
      assert.deepEqual(after.subagents, USER_BLOCK, 'operator block arrived');
      assert.equal(after.theme, 'dracula', 'per-agent keys untouched');
      assert.deepEqual(after.packages, ['npm:pi-subagents'], 'per-agent packages untouched');
      assert.equal(
        fs.readdirSync(path.dirname(dest)).filter((f) => f.includes('.tmp-')).length,
        0,
        'atomic write leaves no tmp leftovers',
      );
    },
  );
});

test('subagents block already equal → file rewritten byte-identically (idempotent)', () => {
  withFixture({ subagents: USER_BLOCK }, { subagents: USER_BLOCK, theme: 'dracula' }, (dest) => {
    const before = fs.readFileSync(dest, 'utf8');
    installPiHooks.call(null, path.dirname(path.dirname(dest)));
    assert.equal(fs.readFileSync(dest, 'utf8'), before, 'no churn, no formatting drift');
  });
});

test('operator removing the subagents block reaches existing copies', () => {
  withFixture({ theme: 'light' }, { subagents: STALE_BLOCK, theme: 'dracula' }, (dest) => {
    installPiHooks.call(null, path.dirname(path.dirname(dest)));
    assert.equal('subagents' in read(dest), false, 'block removed');
    assert.equal(read(dest).theme, 'dracula');
  });
});

test('copy predating subagents config still receives the operator block', () => {
  withFixture({ subagents: USER_BLOCK }, { theme: 'dracula' }, (dest) => {
    installPiHooks.call(null, path.dirname(path.dirname(dest)));
    assert.deepEqual(read(dest).subagents, USER_BLOCK, 'block added');
    assert.equal(read(dest).theme, 'dracula');
  });
});

test('first copy still filters pi-telegram from packages (one poller per bot)', () => {
  withFixture(
    {
      packages: ['git:github.com/badlogic/pi-telegram', 'npm:pi-subagents'],
      subagents: USER_BLOCK,
    },
    null,
    (dest) => {
      installPiHooks.call(null, path.dirname(path.dirname(dest)));
      assert.deepEqual(read(dest).packages, ['npm:pi-subagents']);
      assert.deepEqual(read(dest).subagents, USER_BLOCK);
    },
  );
});

test('non-object user settings ([] / 42) cannot mutate a healthy agent copy', () => {
  // JSON.parse succeeds on [] and 42 — the syntax-invalid guards never fire, and
  // s.subagents reads undefined, so the reconcile used to DELETE subagents from
  // a healthy agent copy (malformed source must leave the dest alone).
  for (const bad of ['[]', '42']) {
    withFixture(bad, { subagents: STALE_BLOCK, theme: 'dracula' }, (dest) => {
      installPiHooks.call(null, path.dirname(path.dirname(dest)));
      assert.deepEqual(read(dest).subagents, STALE_BLOCK, `${bad} user file: copy untouched`);
      assert.equal(read(dest).theme, 'dracula');
    });
  }
});

test('non-object agent copy with a user block is left alone, never half-written', () => {
  // JSON.stringify drops named props on arrays: cur.subagents = <block> on an
  // array copy "succeeds" but the block silently does not arrive. Non-empty
  // array so the spurious rewrite is observable (formatting churn); a literal
  // [] rewrites byte-identically and hides it.
  withFixture({ subagents: USER_BLOCK }, '["legacy"]', (dest) => {
    installPiHooks.call(null, path.dirname(path.dirname(dest)));
    assert.equal(fs.readFileSync(dest, 'utf8'), '["legacy"]', 'non-object copy untouched');
  });
});

test('settings writes are atomic: tmp file then rename, never a direct write', () => {
  withFixture({ subagents: USER_BLOCK }, { subagents: STALE_BLOCK }, (dest) => {
    const writes = [];
    const renames = [];
    const origWrite = fs.writeFileSync;
    const origRename = fs.renameSync;
    fs.writeFileSync = (p, ...a) => {
      writes.push(String(p));
      return origWrite.call(fs, p, ...a);
    };
    fs.renameSync = (from, to) => {
      renames.push([String(from), String(to)]);
      return origRename.call(fs, from, to);
    };
    try {
      installPiHooks.call(null, path.dirname(path.dirname(dest)));
    } finally {
      fs.writeFileSync = origWrite;
      fs.renameSync = origRename;
    }
    assert.equal(writes.includes(dest), false, 'no direct write to settings.json');
    const tmp = writes.find((p) => p !== dest && p.includes('.tmp-'));
    assert.ok(tmp, 'write staged through a tmp file');
    assert.ok(
      renames.some(([f, t]) => f === tmp && t === dest),
      'tmp renamed onto settings.json',
    );
  });
});

test('malformed copies are left alone, never crashed on', () => {
  // malformed agent copy → byte-identical, user file still readable path
  withFixture({ subagents: USER_BLOCK }, null, (dest) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, '{not json');
    installPiHooks.call(null, path.dirname(path.dirname(dest)));
    assert.equal(fs.readFileSync(dest, 'utf8'), '{not json', 'agent copy untouched');
  });
  // malformed user settings → no copy written, no throw
  withFixture('{broken', null, (dest) => {
    const threw = installPiHooks.call(null, path.dirname(path.dirname(dest)));
    assert.equal(threw, path.dirname(dest), 'still returns the agent home');
    assert.equal(fs.existsSync(dest), false, 'nothing written');
  });
});
