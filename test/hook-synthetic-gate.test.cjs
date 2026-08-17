'use strict';

/**
 * Synthetic-wake gate (card agent-harness-reduce-transcrip-2026-08-17, E1):
 * a background task-notification delivered as a queued user prompt is
 * machine-generated — it needs neither god's roster line nor a steer take.
 * takeSteer() is DESTRUCTIVE (delivered-once queue): on a gated wake it must
 * NEVER run, or queued operator guidance is silently swallowed. The event is
 * still emitted so avatars/telemetry stay live.
 *
 * Pass-list is god-ratified (intern corpus, 2033 real prompts, 0 false
 * positives): ONLY ^<task-notification gates. Hive inbox nudges, Telegram
 * <channel>, <agent-message>, and human text all pass.
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

const CONFIG = { notifications: false };

async function floor(t, { steer } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-synth-gate-'));
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

  const steerCalls = [];
  const control = {
    takeSteer: (id) => {
      steerCalls.push(id);
      return steer ?? null;
    },
    shouldHalt: () => false,
    toolDecision: () => ({ deny: false }),
  };
  const hookEvents = [];
  const webContents = { send: (channel, payload) => hookEvents.push({ channel, payload }) };
  const server = new HookServer(
    hive,
    () => webContents,
    () => CONFIG,
    control,
    undefined,
  );
  const fire = (agent_id, hook_event_name, prompt) =>
    server.handle({ agent_id, hook_event_name, session_id: 's1', prompt });
  return { home, hive, server, fire, steerCalls, hookEvents };
}

function snapshot(hive) {
  hive.writeFleetSnapshot({
    ts: Date.now() - 4000,
    agents: [
      {
        id: 'god-1',
        name: 'Michael',
        role: 'orchestrator',
        isGod: true,
        breaker: 'ok',
        tokens: 812_400,
        usd: 4.2199,
        lastActiveSecAgo: 6,
        inboxBacklog: 2,
      },
    ],
  });
}

const context = (res) => res?.hookSpecificOutput?.additionalContext ?? '';

const TASK_NOTIFICATION =
  '<task-notification>\n<task-id>b6afevetr</task-id> Background task completed: sleep 25\n</task-notification>';

test('a <task-notification> wake on god: no roster, no steer take, still emitted', async (t) => {
  const { hive, fire, steerCalls, hookEvents } = await floor(t, {
    steer: 'OPERATOR: queued guidance',
  });
  snapshot(hive);

  const res = await fire('god-1', 'UserPromptSubmit', TASK_NOTIFICATION);
  assert.equal(context(res), '', 'no additionalContext on a synthetic wake');
  assert.deepEqual(steerCalls, [], 'takeSteer is destructive — must NEVER run on a gated wake');
  assert.ok(
    hookEvents.some(
      (e) => e.channel === 'hive:hookEvent' && e.payload.event === 'UserPromptSubmit',
    ),
    'the gated wake is still emitted so avatars/telemetry stay live',
  );
});

test('pass-list: hive nudges, Telegram <channel>, <agent-message>, human text all pass', async (t) => {
  const { hive, fire, steerCalls } = await floor(t, { steer: 'OPERATOR: queued guidance' });
  snapshot(hive);

  const passing = [
    'You have new hive inbox message(s) — read your inbox, act on them now, and move handled ones to inbox/.done/.',
    '<channel source="telegram" chat="Michael">Ship the release now.</channel>',
    '<agent-message from="kevin-1">FYI the build is green.</agent-message>',
    'Why is the login test flaky again?',
  ];
  for (const prompt of passing) {
    const res = await fire('god-1', 'UserPromptSubmit', prompt);
    assert.match(context(res), /LIVE ROSTER/, `roster must pass for: ${prompt.slice(0, 40)}`);
    assert.match(
      context(res),
      /OPERATOR: queued guidance/,
      `steer must pass for: ${prompt.slice(0, 40)}`,
    );
  }
  assert.equal(steerCalls.length, passing.length, 'every passing prompt took its steer');
});

test('a queued steer survives a gated wake — the next REAL prompt delivers it', async (t) => {
  const { hive, fire, steerCalls } = await floor(t, { steer: 'OPERATOR: stop and summarize.' });
  snapshot(hive);

  // A synthetic wake arrives while operator guidance is queued.
  await fire('god-1', 'UserPromptSubmit', TASK_NOTIFICATION);
  assert.deepEqual(steerCalls, [], 'the gated wake did not consume the steer');

  const res = await fire('god-1', 'UserPromptSubmit', 'real operator typing');
  assert.match(
    context(res),
    /OPERATOR: stop and summarize\./,
    'the steer is still queued for the next real prompt',
  );
  assert.equal(steerCalls.length, 1, 'consumed exactly once, by the real prompt');
});

test('gating is prompt-scoped, not agent-scoped: a worker wake also injects nothing', async (t) => {
  const { fire } = await floor(t);
  const res = await fire('jim-1', 'UserPromptSubmit', TASK_NOTIFICATION);
  assert.equal(context(res), '', 'workers never had the roster; the gate must not add context');
});

test('PostToolUse never gates (only the UserPromptSubmit synthetic-wake path)', async (t) => {
  const { hive, fire, steerCalls } = await floor(t, { steer: 'OPERATOR: queued guidance' });
  snapshot(hive);
  const res = await fire('god-1', 'PostToolUse', TASK_NOTIFICATION);
  assert.match(
    context(res),
    /OPERATOR: queued guidance/,
    'steer flows on PostToolUse regardless of text',
  );
  assert.equal(steerCalls.length, 1);
});
