'use strict';

/**
 * Card agent-sessionstart-must-tell-e-2026-08-19.
 *
 * A harness restart silently kills every agent's inbox monitor (a Monitor-tool
 * task owned by the dying session), and nothing told the agent — it only
 * discovered the loss when it happened to reach for the tool, while every
 * worker done-report waited for the typed-nudge fallback instead of arriving
 * in seconds. The asymmetry: a stalled agent on a doing card IS caught
 * (standup escalation), a dead inbox monitor is caught by NOTHING.
 *
 * The fix: the SessionStart hook boundary tells every MONITOR-CAPABLE agent,
 * in plain text, that this is a FRESH session and the monitor must be
 * (re)armed now. Pinning rules, the way godline-rules.test.cjs pins the
 * godLine — a phrase agents depend on must survive rewrites:
 *  - FRESH session stated plainly, monitor declared DEAD (unmissable, not a
 *    hint inferred from a reset tool list),
 *  - REARM NOW, with the "unless you armed it in THIS session" out (a
 *    redundant arm is cheaper than a missed one),
 *  - a POINTER to the INBOX WAKE command in the system prompt — never a
 *    duplicate of the command itself (two copies would drift),
 *  - the typed-nudge fallback named, so an agent that cannot arm does
 *    nothing instead of inventing a mechanism.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// hooks.ts pulls Notification from electron; outside Electron that resolve gives
// a path string, so seed the cache with the surface the server actually touches.
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: {
    Notification: class {
      show() {}
      static isSupported() {
        return false;
      }
    },
  },
};

const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-rearm-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({
    id: 'god-1',
    name: 'Michael',
    provider: 'claude',
    cwd: home,
    isGod: true,
  });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  // pi has no agent-armable wake primitive (hasInboxMonitor false) — the typed
  // nudge IS its mechanism, so a rearm instruction would be pure noise.
  await hive.ensureAgent({ id: 'kevin-1', name: 'Kevin', provider: 'pi', cwd: home });

  const server = new HookServer(
    hive,
    () => null,
    () => ({ notifications: false }),
  );
  const fire = (agent_id, hook_event_name) =>
    server.handle({ agent_id, hook_event_name, session_id: 's1' });
  return { hive, server, fire };
}

const context = (res) => res?.hookSpecificOutput?.additionalContext ?? '';
const REARM = /INBOX MONITOR/;

test('SessionStart tells a WORKER to rearm its inbox monitor', async (t) => {
  const { fire } = await floor(t);
  const res = await fire('jim-1', 'SessionStart');
  assert.match(context(res), REARM, 'a monitor-capable worker must be told at session start');
  assert.equal(res.hookSpecificOutput.hookEventName, 'SessionStart');
});

test('SessionStart tells GOD too — and the line merges with the roster, not displaces it', async (t) => {
  const { hive, fire } = await floor(t);
  hive.writeFleetSnapshot({
    ts: Date.now() - 4000,
    agents: [{ id: 'god-1', name: 'Michael', role: 'orchestrator', isGod: true, breaker: 'ok' }],
  });
  const ctx = context(await fire('god-1', 'SessionStart'));
  assert.match(ctx, REARM, "god's monitor dies identically — god gets the line too");
  assert.match(ctx, /LIVE ROSTER/, 'only one additionalContext exists — both must ride it');
});

test('agents WITHOUT a monitor provider get nothing on SessionStart', async (t) => {
  const { fire } = await floor(t);
  assert.doesNotMatch(context(await fire('kevin-1', 'SessionStart')), REARM);
  // unknown agent = capability absent, never a default provider
  const res = await fire('ghost-1', 'SessionStart');
  assert.equal(res.hookSpecificOutput, undefined, 'no injection for an unregistered agent');
});

test('the rearm line rides ONLY SessionStart — not prompts or tool calls', async (t) => {
  const { hive, fire } = await floor(t);
  hive.writeFleetSnapshot({
    ts: Date.now() - 4000,
    agents: [{ id: 'god-1', name: 'Michael', role: 'orchestrator', isGod: true, breaker: 'ok' }],
  });
  for (const [agent, event] of [
    ['jim-1', 'UserPromptSubmit'],
    ['jim-1', 'PostToolUse'],
    ['god-1', 'UserPromptSubmit'], // roster yes (slim), rearm no
    ['god-1', 'PostToolUse'],
  ]) {
    assert.doesNotMatch(
      context(await fire(agent, event)),
      REARM,
      `${event} must not carry the rearm line`,
    );
  }
});

test('the injected text pins the phrases agents depend on', async (t) => {
  const { fire } = await floor(t);
  const line = context(await fire('jim-1', 'SessionStart'));
  // unmissable and unambiguous: fresh session, dead monitor, act now
  assert.match(line, /FRESH session/i, 'states plainly this is a fresh session');
  assert.match(line, /DEAD/i, 'declares the old monitor dead');
  assert.match(line, /REARM it NOW/, 'the instruction is an imperative');
  assert.match(
    line,
    /unless you armed it in THIS session/,
    'the redundant-arm out: a missed arm costs more than a duplicate',
  );
  // pointer, not duplicate: the command lives in the system prompt's INBOX WAKE
  assert.match(line, /INBOX WAKE/, 'names the clause that carries the command');
  assert.match(line, /system prompt/, 'points at where the command lives');
  assert.doesNotMatch(line, /while true/, 'never duplicates the arming command itself');
  // the fallback stays named — an agent that cannot arm does nothing
  assert.match(line, /typed nudge/);
});
