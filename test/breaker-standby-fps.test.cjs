'use strict';
/**
 * Circuit-breaker FALSE-POSITIVE regression: no-progress on an IDLE agent
 * (card breaker-standby-fps-20260816).
 *
 * Reproduces the shape that fired on a live agent standing by for ~3h: it had no
 * card and no pending dispatch, so its coordination files were stale BY
 * DEFINITION. Each steer made it answer, and that answer's output tokens re-armed
 * the Δoutput arm — four steers in three hours. Fix: the arm is gated on
 * `hasOpenWork`, which the beat derives from undrained non-system inbox mail, an
 * assigned `doing` card, or activity that only just went quiet.
 *
 * Self-contained, no framework — `node test/breaker-standby-fps.test.cjs`.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const SRC = path.join(__dirname, '..', 'src', 'main', 'breaker.ts');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-standby-'));
const js = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
fs.writeFileSync(path.join(out, 'breaker.js'), js, 'utf8');
const { CircuitBreaker } = require(path.join(out, 'breaker.js'));

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL  ${name}\n      ${e.message}`);
  }
}

function makeBreaker(over = {}) {
  return new CircuitBreaker(() => ({
    enabled: true,
    hardStop: false,
    repeatedToolLimit: 8,
    errorStormLimit: 5,
    tokenVelocityPerMin: 60000,
    ...over,
  }));
}

function sample(agentId, ts, output, input = 1000) {
  return {
    agentId,
    sessionId: 's1',
    ts,
    input,
    output,
    cacheRead: 0,
    cacheCreation: 0,
    model: 'm',
    usd: 0,
  };
}

const T0 = 1_000_000_000_000;
const BEAT = 30_000;

function beat(b, id, s, progressing, now, hasOpenWork) {
  return b.tick([{ agentId: id, sample: s, progressing, hasOpenWork }], now)[0];
}

// ── FP 1: no-progress must not fire on an idle agent with no open work ───────

test('idle agent with no open work never trips no-progress (4 beats)', () => {
  const b = makeBreaker();
  // Stale files, no tool activity, and a steady token trickle — exactly the
  // standing-by agent that answers each steer. Four beats, far past the debounce.
  let d;
  for (let i = 0; i <= 4; i++) {
    d = beat(b, 'a', sample('a', T0 + i * BEAT, i * 500), false, T0 + i * BEAT, false);
  }
  assert.equal(d.state.level, 'healthy', `reason: ${d.state.reason}`);
});

test('the steer loop cannot restart itself: still healthy after 20 idle beats', () => {
  const b = makeBreaker();
  let d;
  for (let i = 0; i <= 20; i++) {
    d = beat(b, 'a', sample('a', T0 + i * BEAT, i * 500), false, T0 + i * BEAT, false);
  }
  assert.equal(d.state.level, 'healthy', `reason: ${d.state.reason}`);
});

test('a stuck WORKING agent (open work, stale files) still trips no-progress', () => {
  const b = makeBreaker();
  beat(b, 'a', sample('a', T0, 0), false, T0, true);
  beat(b, 'a', sample('a', T0 + BEAT, 500), false, T0 + BEAT, true);
  const d = beat(b, 'a', sample('a', T0 + 2 * BEAT, 1000), false, T0 + 2 * BEAT, true);
  assert.equal(d.state.level, 'steering');
  assert.match(d.state.reason, /no-progress/);
});

test('work arriving mid-standby re-arms the arm (idle → open work → trips)', () => {
  const b = makeBreaker();
  for (let i = 0; i <= 3; i++)
    beat(b, 'a', sample('a', T0 + i * BEAT, i * 500), false, T0 + i * BEAT, false);
  // A dispatch lands: the same stale-file signature must now be actionable.
  beat(b, 'a', sample('a', T0 + 4 * BEAT, 2500), false, T0 + 4 * BEAT, true);
  const d = beat(b, 'a', sample('a', T0 + 5 * BEAT, 3000), false, T0 + 5 * BEAT, true);
  assert.equal(d.state.level, 'steering');
  assert.match(d.state.reason, /no-progress/);
});

test('the gate touches ONLY no-progress — an idle agent still trips on velocity', () => {
  const b = makeBreaker();
  beat(b, 'a', sample('a', T0, 0), false, T0, false);
  const d = beat(b, 'a', sample('a', T0 + BEAT, 40_000), false, T0 + BEAT, false); // 80k/min
  assert.equal(d.state.level, 'steering');
  assert.match(d.state.reason, /velocity/);
});

process.exit(failures ? 1 : 0);
