'use strict';
/**
 * Circuit-breaker FALSE-POSITIVE regression: the loop detector miscounting
 * DISTINCT tool calls as identical (card breaker-standby-fps-20260816).
 *
 * Live symptom: "8× identical tool call (bash)" on ~10 genuinely distinct calls.
 * Root cause: the pi bridge's PostToolUse carried NO `tool_input`, so every Bash
 * call hashed to the same name-only key. Fix: no input = no identity = never a
 * repeat. Second, latent source: long commands sharing a >250-char prefix
 * collapsed because the replacer TRUNCATED long strings before hashing; they are
 * now digested at full length instead.
 *
 * Self-contained, no framework — `node test/breaker-loop-identity.test.cjs`.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const SRC = path.join(__dirname, '..', 'src', 'main', 'breaker.ts');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-identity-'));
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

const T0 = 1_000_000_000_000;

function beat(b, id, s, progressing, now, hasOpenWork) {
  return b.tick([{ agentId: id, sample: s, progressing, hasOpenWork }], now)[0];
}

// ── FP 2: distinct calls must not read as identical ──────────────────────────

test("Pam's pattern: 10 distinct Bash calls with NO tool_input never trip the loop arm", () => {
  const b = makeBreaker();
  // The pi bridge's PostToolUse carried no input at all. Ten real, distinct calls.
  for (let i = 0; i < 10; i++) b.recordToolUse('a', 'Bash', undefined);
  const d = beat(b, 'a', null, true, T0, true);
  assert.equal(d.state.level, 'healthy', `reason: ${d.state.reason}`);
});

test('a null tool_input is likewise never a repeat', () => {
  const b = makeBreaker();
  for (let i = 0; i < 10; i++) b.recordToolUse('a', 'Bash', null);
  const d = beat(b, 'a', null, true, T0, true);
  assert.equal(d.state.level, 'healthy', `reason: ${d.state.reason}`);
});

test('input-less calls do not poison a REAL loop that follows', () => {
  const b = makeBreaker();
  for (let i = 0; i < 5; i++) b.recordToolUse('a', 'Bash', undefined);
  for (let i = 0; i < 8; i++) b.recordToolUse('a', 'Bash', { command: 'while true; do :; done' });
  const d = beat(b, 'a', null, true, T0, true);
  assert.equal(d.state.level, 'steering');
  assert.match(d.state.reason, /looping/);
});

test('distinct commands differing only AFTER the 250-char cap stay distinct', () => {
  const b = makeBreaker();
  const prefix = `cd ${'/deeply/nested/monorepo/segment'.repeat(10)} && grep -rn `;
  assert.ok(prefix.length > 250, 'fixture must exceed the string cap');
  for (let i = 0; i < 10; i++)
    b.recordToolUse('a', 'Bash', { command: `${prefix}needle${i} src/` });
  const d = beat(b, 'a', null, true, T0, true);
  assert.equal(d.state.level, 'healthy', `reason: ${d.state.reason}`);
});

test('two long commands of different LENGTH sharing a capped prefix stay distinct', () => {
  const b = makeBreaker();
  const prefix = 'x'.repeat(300);
  for (let i = 0; i < 10; i++) b.recordToolUse('a', 'Bash', { command: prefix + 'y'.repeat(i) });
  const d = beat(b, 'a', null, true, T0, true);
  assert.equal(d.state.level, 'healthy', `reason: ${d.state.reason}`);
});

test('identical long commands DO still trip (the cap change kept repeats equal)', () => {
  const b = makeBreaker();
  const command = 'z'.repeat(4000);
  for (let i = 0; i < 8; i++) b.recordToolUse('a', 'Bash', { command });
  const d = beat(b, 'a', null, true, T0, true);
  assert.equal(d.state.level, 'steering');
  assert.match(d.state.reason, /looping/);
});

// ── the bridge that produced the input-less payloads ─────────────────────────

test('the pi bridge puts tool_input on its PostToolUse payload', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8');
  const ext = src.slice(src.indexOf('const PI_EXTENSION'));
  const post = ext.slice(ext.indexOf("'PostToolUse'"));
  assert.match(post.slice(0, 200), /tool_input:/, 'pi PostToolUse must carry tool_input');
});

process.exit(failures ? 1 : 0);
