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
 *
 * Card agent-harness-owned-wake-rearm-2026-08-19 widens both halves:
 *  - the line now covers the WHOLE silent-death class — a restart kills every
 *    in-session background task (builds, gate runs, shells, watchers), and a
 *    restored transcript still believes they run; no mail is involved, so no
 *    nudge path existed for them at all. Pinned: dead-tasks + re-verify.
 *  - the typed-nudge wake itself becomes REARM-AWARE: the harness knows
 *    (durably, registry) the agent once armed a persistent monitor, and knows
 *    (session-scoped, PostToolUse Monitor) whether it rearmed since this
 *    session began. Known-degraded ⇒ the wake NAMES THE CAUSE (monitor gone,
 *    rearm it), riding UserPromptSubmit — the boundary every typed nudge
 *    lands on — as additionalContext, because the typed text itself is
 *    renderer-owned and this must merge live without a restart window.
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
const { PendingWorkTracker } = loadTs('src/main/pendingWork.ts');

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

  // A fresh server+tracker pair over the SAME hive simulates the restarted
  // harness: everything in-memory died, the registry fact survived on disk.
  const boot = () => {
    const pendingWork = new PendingWorkTracker();
    const server = new HookServer(
      hive,
      () => null,
      () => ({ notifications: false }),
      undefined,
      undefined,
      undefined,
      pendingWork,
    );
    const fire = (agent_id, hook_event_name, extra = {}) =>
      server.handle({ agent_id, hook_event_name, session_id: 's1', ...extra });
    return { server, pendingWork, fire };
  };
  return { hive, boot, ...boot() };
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

test('an agent with NO prior monitor arm gets the line only at SessionStart — not prompts or tool calls', async (t) => {
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

test('PostToolUse(Monitor, persistent) records BOTH facts: the durable registry arm and the session-scoped rearm', async (t) => {
  const { hive, pendingWork, fire } = await floor(t);
  assert.equal(hive.inboxMonitorArmed('jim-1'), false, 'no arm seen yet — no durable fact');
  await fire('jim-1', 'PostToolUse', {
    tool_name: 'Monitor',
    tool_response: { taskId: 'm1', persistent: true },
  });
  assert.equal(hive.inboxMonitorArmed('jim-1'), true, 'a persistent arm is durable knowledge now');
  assert.equal(pendingWork.hasPersistentMonitor('jim-1'), true, 'and visible in the session scope');
  // a one-shot arm is NOT the inbox monitor — the durable fact must not flip for it
  await fire('jim-1', 'PostToolUse', { tool_name: 'Monitor', tool_response: { taskId: 'm2' } });
  assert.equal(hive.inboxMonitorArmed('kevin-1'), false);
});

test('after a harness restart the typed-nudge wake NAMES THE CAUSE for a known-degraded agent', async (t) => {
  const { hive, boot } = await floor(t);
  // Before the restart: the agent armed its persistent monitor (both facts set).
  await boot().fire('jim-1', 'PostToolUse', {
    tool_name: 'Monitor',
    tool_response: { taskId: 'm1', persistent: true },
  });
  // The restart: the whole harness (server + in-memory tracker) dies; a new
  // process boots over the same on-disk hive. SessionStart wipes the
  // session-scoped ids; the registry fact survives. The agent does NOT rearm
  // (it believes its monitor alive) — then mail arrives and the typed nudge
  // lands as a user prompt: that wake must say the monitor is gone.
  const second = boot();
  await second.fire('jim-1', 'SessionStart');
  assert.equal(second.pendingWork.hasPersistentMonitor('jim-1'), false, 'session scope wiped');
  assert.equal(hive.inboxMonitorArmed('jim-1'), true, 'durable fact survived the restart');
  const ctx = context(await second.fire('jim-1', 'UserPromptSubmit'));
  assert.match(ctx, REARM, 'the nudge wake carries the rearm notice');
  assert.match(ctx, /GONE/, 'names the cause: the monitor is gone');
  assert.match(ctx, /REARM it now/, 'the instruction is an imperative');
  assert.match(ctx, /INBOX WAKE/, 'pointer to the command, never a duplicate');
  assert.match(ctx, /system prompt/);
  assert.doesNotMatch(ctx, /while true/, 'never duplicates the arming command itself');
});

test('an agent that DID rearm in this session gets no rearm notice on prompts', async (t) => {
  const { boot } = await floor(t);
  await boot().fire('jim-1', 'PostToolUse', {
    tool_name: 'Monitor',
    tool_response: { taskId: 'm1', persistent: true },
  });
  const second = boot();
  await second.fire('jim-1', 'SessionStart');
  // The agent obeys the SessionStart line and rearms in the fresh session.
  await second.fire('jim-1', 'PostToolUse', {
    tool_name: 'Monitor',
    tool_response: { taskId: 'm2', persistent: true },
  });
  assert.doesNotMatch(
    context(await second.fire('jim-1', 'UserPromptSubmit')),
    REARM,
    'rearmed ⇒ no notice; the monitor wakes it in-session again',
  );
});

test('providers without a monitor capability are unaffected — even with a stale durable fact', async (t) => {
  const { hive, fire } = await floor(t);
  // Simulate a durable fact for a monitor-incapable provider (e.g. an agent id
  // re-hired on a different engine): the capability gate must refuse the line.
  hive.recordInboxMonitorArm('kevin-1');
  assert.equal(hive.inboxMonitorArmed('kevin-1'), true);
  assert.doesNotMatch(context(await fire('kevin-1', 'UserPromptSubmit')), REARM);
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
  // widened (card agent-harness-owned-wake-rearm-2026-08-19): the whole
  // silent-death class, not just the monitor — builds, gate runs, background
  // shells, watchers die with the session and no mail-based nudge exists.
  assert.match(line, /EVERY background task/, 'the whole class, not just the monitor');
  assert.match(line, /re-verify anything you were waiting on/, 'the action for dead tasks');
  assert.match(line, /can never arrive/, 'why waiting is a trap: the notification is dead too');
});
