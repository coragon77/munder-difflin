'use strict';
/**
 * Steer delivery gate (card agent-operator-steers-for-pi-a-2026-08-18):
 * takeSteer() is DESTRUCTIVE — a steer consumed at a hook boundary is gone
 * from the queue and rides the socket response as additionalContext. A
 * provider with NO delivering bridge would silently DROP every steer. So
 * HookServer must only consume for providers
 * whose bridge reads the response and injects the context; for every other
 * provider the steer STAYS QUEUED (visible via pendingSteers) and the loss is
 * surfaced LOUDLY — desktop notify + hive log, once per episode.
 *
 * Run with `node --test test/steer-delivery-gate.test.cjs`.
 *
 * Card agent-opencode-qwen-crush-agen-2026-08-18 widened the delivering set:
 * the opencode plugin (system.transform injection) and the qwen/crush proxy
 * sidecar (next-request injection) now read the response too; only providers
 * with NO delivering bridge (kimi/copilot/custom) keep steers queued + loud.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// hooks.ts pulls Notification from electron; seed a recording fake so the LOUD
// surfacing is observable.
const shown = [];
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: {
    Notification: class {
      constructor(opts) {
        this.opts = opts;
      }
      show() {
        shown.push(this.opts);
      }
      static isSupported() {
        return true;
      }
    },
  },
};

const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const { ControlRegistry } = loadTs('src/main/control.ts');
const { bridgeDeliversHookContext } = loadTs('src/shared/agentProvider.ts');

const CONFIG = { notifications: true };

async function floor(t, agents) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-steer-gate-'));
  const hive = new HiveManager(() => home);
  // ensureAgent() for a PROXY-tier provider (qwen below) starts the real
  // hive-proxy.cjs sidecar with a bound loopback listener — production spawn
  // behavior that would keep this test child alive forever (and with it the
  // whole `node --test` run). Tear every sidecar down before the tmpdir goes.
  t.after(() => {
    hive.stopAllProxyBridges();
    fs.rmSync(home, { recursive: true, force: true });
  });
  for (const a of agents) await hive.ensureAgent({ cwd: home, ...a });
  const control = new ControlRegistry();
  const server = new HookServer(
    hive,
    () => null,
    () => CONFIG,
    control,
    undefined,
  );
  const fire = (agent_id, hook_event_name, extra = {}) =>
    server.handle({ agent_id, hook_event_name, session_id: 's1', ...extra });
  const logLines = () =>
    fs
      .readFileSync(path.join(hive.root(), 'log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return { home, hive, control, fire, logLines };
}

const context = (res) => res?.hookSpecificOutput?.additionalContext ?? '';

test('predicate: response-reading bridges deliver, bridgeless providers do not', () => {
  // Response readers: claude natively, codex/grok/agy shims read + translate,
  // pi extension reads + injects via pi.sendMessage, the opencode plugin reads
  // + injects via experimental.chat.system.transform, and the qwen/crush proxy
  // sidecar reads + injects into the next upstream request.
  for (const p of ['claude', 'codex', 'grok', 'antigravity', 'pi', 'opencode', 'qwen', 'crush']) {
    assert.equal(bridgeDeliversHookContext(p), true, `${p} reads the hook response`);
  }
  // No bridge at all: consuming a steer would drop it.
  for (const p of ['kimi', 'copilot', 'custom', undefined]) {
    assert.equal(bridgeDeliversHookContext(p), false, `${p} cannot receive a consumed steer`);
  }
});

test('a steer for a response-reading agent is consumed and returned as context', async (t) => {
  const { control, fire } = await floor(t, [
    { id: 'claude-1', name: 'Cody', provider: 'claude' },
    { id: 'pi-1', name: 'Pia', provider: 'pi' },
  ]);
  control.steer('claude-1', 'OPERATOR: stop and summarize.');
  control.steer('pi-1', 'OPERATOR: slow down.');

  assert.match(
    context(await fire('claude-1', 'PostToolUse', { tool_name: 'Bash' })),
    /OPERATOR: stop and summarize\./,
  );
  assert.equal(control.snapshot('claude-1').pendingSteers, 0, 'consumed exactly once');

  assert.match(
    context(await fire('pi-1', 'UserPromptSubmit', { prompt: 'go on' })),
    /OPERATOR: slow down\./,
    'pi steers flow too — the bridge now reads the response and injects',
  );
});

test('a steer for a bridgeless agent is NOT consumed — it stays queued', async (t) => {
  const { control, fire } = await floor(t, [{ id: 'cp-1', name: 'Coby', provider: 'copilot' }]);
  control.steer('cp-1', 'OPERATOR: stop the refactor.');

  const res = await fire('cp-1', 'PostToolUse', { tool_name: 'bash' });
  assert.equal(context(res), '', 'nothing is handed to a provider with no delivering bridge');
  assert.equal(
    control.snapshot('cp-1').pendingSteers,
    1,
    'the steer survives, visible in the queue',
  );
});

test('the undeliverable steer is surfaced LOUDLY — once per episode', async (t) => {
  shown.length = 0;
  const { control, fire, logLines } = await floor(t, [
    { id: 'cp-2', name: 'Coby', provider: 'copilot' },
  ]);
  control.steer('cp-2', 'OPERATOR: circuit breaker — constrain.');

  await fire('cp-2', 'PostToolUse', { tool_name: 'shell' });
  await fire('cp-2', 'PostToolUse', { tool_name: 'shell' });

  const loud = shown.filter((n) =>
    /cannot receive.*steer|steer.*cannot/i.test(`${n.title} ${n.body}`),
  );
  assert.equal(loud.length, 1, 'one desktop notification per episode, not one per hook');
  const logged = logLines().filter((l) => l.kind === 'steer_undeliverable');
  assert.equal(logged.length, 1, 'a durable hive-log record names the agent');
  assert.equal(logged[0].agentId, 'cp-2');
});

test('the loud episode clears once the queue drains (next steer notifies again)', async (t) => {
  shown.length = 0;
  const { control, fire } = await floor(t, [{ id: 'cp-3', name: 'Coby', provider: 'copilot' }]);

  control.steer('cp-3', 'first steer');
  await fire('cp-3', 'PostToolUse', { tool_name: 'bash' });
  control.clearSteers('cp-3'); // operator dropped the backlog
  await fire('cp-3', 'PostToolUse', { tool_name: 'bash' }); // next hook sees the drain
  control.steer('cp-3', 'second steer');
  await fire('cp-3', 'PostToolUse', { tool_name: 'bash' });

  assert.equal(shown.length, 2, 'a fresh episode after the queue drained notifies again');
  assert.equal(control.snapshot('cp-3').pendingSteers, 1);
});

test('unknown agents (no registry entry) are treated as undeliverable, never consumed', async (t) => {
  shown.length = 0;
  const { control, fire } = await floor(t, []);
  control.steer('ghost', 'OPERATOR: anyone there?');
  const res = await fire('ghost', 'PostToolUse', { tool_name: 'bash' });
  assert.equal(context(res), '');
  assert.equal(control.snapshot('ghost').pendingSteers, 1);
});
