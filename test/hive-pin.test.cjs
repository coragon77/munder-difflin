'use strict';

/**
 * PINNED WORKERS (pin-workers-20260817) — a pin/unpin toggle per worker.
 * A PINNED worker is NEVER eligible for vacation: no matter who tries — god's
 * vacation-request, the UI park button, any future auto-park — the park is
 * rejected at the choke point. Pinning never applies to the god agent.
 *
 * These tests pin the registry half behaviorally (the HiveManager layer) and
 * the main/renderer wiring as source-text pins — same split as
 * hive-vacation.test.cjs + vacation-ui-surface.test.cjs, since the repo has
 * no DOM harness and parkAgent lives in the electron entry file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { parkAgentCore } = loadTs('src/main/vacationFlow.ts');

const repoRoot = path.join(__dirname, '..');
const read = (p) => readFileSync(path.join(repoRoot, p), 'utf8');

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-pin-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, hive: new HiveManager(() => home) };
}

// ─── registry behavior ──────────────────────────────────────────────────────

test('a pin persists to the registry and survives a restart', async (t) => {
  const { home, hive } = floor(t);
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: '/tmp' });

  assert.equal(hive.setPinned('pam-1', true), true, 'pinning reports success');

  const entry = hive.registry().agents['pam-1'];
  assert.equal(entry.pinned, true);
  // The registry is what a restart reads — a fresh manager over the same home
  // is exactly what boot sees.
  assert.equal(
    new HiveManager(() => home).registry().agents['pam-1'].pinned,
    true,
    'the pin must outlive the process',
  );

  assert.equal(hive.setPinned('pam-1', false), true, 'unpinning reports success');
  assert.equal(!!hive.registry().agents['pam-1'].pinned, false);
  assert.equal(
    new HiveManager(() => home).registry().agents['pam-1'].pinned,
    false,
    'so does the unpin',
  );
});

test('a pinned agent is never parkable; unpin reopens the park path', async (t) => {
  const { hive } = floor(t);
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: '/tmp' });
  hive.setPinned('pam-1', true);

  assert.equal(hive.setVacation('pam-1', true), false, 'the registry refuses the park flag');
  const refused = hive.registry().agents['pam-1'];
  assert.equal(!!refused.vacation, false, 'not parked');
  assert.equal(!!refused.archived, false, 'and not archived either — nothing happened');
  assert.equal(refused.pinned, true, 'the pin itself survives the attempt');

  hive.setPinned('pam-1', false);
  assert.equal(hive.setVacation('pam-1', true), true, 'after the unpin the park works');
  assert.equal(hive.registry().agents['pam-1'].vacation, true);
});

test('god is unpinnable — the pin never applies to the god agent', async (t) => {
  const { home, hive } = floor(t);
  await hive.ensureAgent({
    id: 'michael',
    name: 'Michael',
    provider: 'claude',
    isGod: true,
    cwd: '/tmp',
  });

  assert.equal(hive.setPinned('michael', true), false, 'pinning god is refused');
  assert.equal(!!hive.registry().agents['michael'].pinned, false, 'no pin landed');
  assert.equal(
    new HiveManager(() => home).registry().agents['michael'].pinned,
    undefined,
    'and nothing was persisted',
  );
});

test('a respawn (the recall path) preserves the pin', async (t) => {
  const { hive } = floor(t);
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: '/tmp' });
  hive.setPinned('pam-1', true);

  // A (re)spawn is the recall — it must clear `vacation` but keep the pin:
  // the pin is the human's standing "never park this one", not run state.
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: '/tmp' });

  assert.equal(
    hive.registry().agents['pam-1'].pinned,
    true,
    'a recall must not silently drop the pin',
  );
});

test('pin semantics mirror setVacation: idempotent re-set is true, unknown agent false', async (t) => {
  const { hive } = floor(t);
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: '/tmp' });
  hive.setPinned('pam-1', true);

  assert.equal(hive.setPinned('pam-1', true), true, 're-pinning a pinned agent is still true');
  assert.equal(hive.setPinned('nobody-1', true), false, 'an unknown agent is refused');
});

test('godLine carries the PINNED rule — check the pin before any park decision', () => {
  // TS `private` is compile-time only — same reach-through as godline-rules.test.cjs.
  const injectedPrompt = HiveManager.prototype['injectedPrompt'];
  const p = injectedPrompt.call(
    null,
    { id: 'god', name: 'God', role: 'god', cwd: '/w', isGod: true },
    '/agents/god',
    '/hive',
    false,
    false,
  );
  assert.ok(/PINNED/.test(p), 'the god briefing must mention pinned workers');
  assert.ok(/never parked/i.test(p), 'and say plainly that a pinned worker is never parked');
});

// ─── the park choke point (parkAgentCore — every park path converges here) ──

/** Minimal park deps over an in-memory registry, with a teardown tape —
 *  mirrors test/vacation-flow.test.cjs's harness. */
function parkTape(agents) {
  const events = [];
  const reg = { godId: 'michael', agents };
  return {
    events,
    deps: {
      hiveEnabled: () => true,
      registry: () => reg,
      ptyForAgent: (id) => (agents[id]?.archived ? undefined : 'pty-1'),
      busy: () => {
        events.push('busy');
        return false;
      },
      dropWorktree: () => events.push('dropWorktree'),
      killPty: () => events.push('killPty'),
      teardownPty: () => events.push('teardownPty'),
      setVacation: (id, v) => {
        events.push(`setVacation:${id}=${v}`);
        if (v) agents[id].vacation = true;
        return true;
      },
      appendLog: (e) => events.push(`log:${e.kind}`),
      notifyVacationed: () => events.push('notify'),
      log: () => {},
      error: () => {},
    },
  };
}

const pinEntry = (over = {}) => ({
  id: 'pam-1',
  name: 'Pam',
  status: 'idle',
  lastSeen: 0,
  cwd: '/floor/pam',
  role: 'worker',
  ...over,
});

test('parkAgentCore: a park against a pinned agent is rejected as a NO-OP', () => {
  const { deps, events } = parkTape({ 'pam-1': pinEntry({ pinned: true }) });

  const res = parkAgentCore(deps, 'pam-1', 'idle 30min');

  assert.equal(res.ok, false);
  assert.match(res.error, /pinned/);
  assert.deepEqual(
    events,
    [],
    'a refused park must touch nothing — no busy check, no teardown, no flag write',
  );
});

test('parkAgentCore: after the unpin the same park goes through', () => {
  const agents = { 'pam-1': pinEntry({ pinned: false }) };
  const { deps, events } = parkTape(agents);

  const res = parkAgentCore(deps, 'pam-1', 'idle 30min');

  assert.equal(res.ok, true);
  assert.ok(events.includes('teardownPty'), 'the PTY teardown ran');
  assert.ok(events.includes('setVacation:pam-1=true'), 'the flag landed');
  assert.equal(agents['pam-1'].pinned, false, 'and the (cleared) pin itself is untouched');
});

test('parkAgentCore: the pinned rung sits AFTER identity/role refusals, BEFORE busy', () => {
  // The ladder reads: unknown → god → intern → retired → already-parked →
  // PINNED → busy. Pin state must never mask who the agent IS (an intern's
  // refusal stays the intern refusal), and the pin must outrank the busy gate.
  const intern = parkTape({ ryan: pinEntry({ id: 'ryan', role: 'intern', pinned: true }) });
  const internRes = parkAgentCore(intern.deps, 'ryan');
  assert.match(internRes.error, /intern/);

  const busy = parkTape({ 'pam-1': pinEntry({ pinned: true }) });
  busy.deps.busy = () => {
    busy.events.push('busy');
    return true;
  };
  const busyRes = parkAgentCore(busy.deps, 'pam-1');
  assert.match(busyRes.error, /pinned/, 'the pin refusal wins over the busy gate');
  assert.ok(!busy.events.includes('busy'), 'the busy check was never even consulted');
});

// ─── main/renderer wiring (source pins — index.ts is the electron entry) ────

test('the pin toggle reaches every layer', () => {
  const main = read('src/main/index.ts');
  assert.ok(main.includes("'hive:setPinned'"), 'IPC handler registered');
  const preload = read('src/preload/index.ts');
  assert.ok(preload.includes('hiveSetPinned'), 'preload bridge exists');
  const store = read('src/renderer/src/store/store.ts');
  assert.ok(store.includes('pinned?: boolean'), 'store Agent carries the flag');
});

// Agent-pane placement (agent-harness-pin-unpin-button-2026-08-17): the toggle
// sits in the pane header's button row, next to the detach/reattach button.
// Source pins, same as above — no DOM harness in this repo.
test('the agent pane carries the pin toggle beside detach; the god pane stays clean', () => {
  const pane = read('src/renderer/src/components/AgentDetailPanel.tsx');
  assert.ok(pane.includes('hiveSetPinned'), 'it drives the registry flag');
  assert.match(
    pane,
    /canPin\s*&&\s*\(\s*<PixelButton[^>]*onClick=\{onTogglePin\}/s,
    'the pin is a header button (not a stray icon) gated by canPin',
  );
  const pinAt = pane.indexOf('onClick={onTogglePin}');
  const detachAt = pane.indexOf('onClick={onToggleDetach}');
  assert.ok(pinAt !== -1 && detachAt !== -1, 'both toggles render in the pane header');
  assert.ok(pinAt < detachAt, 'the pin button sits next to (just before) detach');

  const godPane = read('src/renderer/src/components/CommandCenterPanel.tsx');
  assert.ok(
    !godPane.includes('hiveSetPinned') && !godPane.includes('onTogglePin'),
    'god cannot be pinned — no toggle ever renders on the command center',
  );
});
