'use strict';

/**
 * fleet-telemetry blind panes (card fleet-telemetry-blind-panes-20260816).
 *
 * Every non-Claude provider (pi today) reports through HOOK payloads — the pi
 * bridge extension posts Pre/PostToolUse/Stop to HIVE_SOCK — but TelemetryCollector
 * was fed exclusively by Claude Code's OTLP push. snapshot() therefore had no
 * entry at all for these agents, and every display surface reading it
 * (fleet.json, the renderer fleet grid, the voice directory) showed a
 * permanently blind row — 0 tokens, null lastTool, null lastActiveSecAgo,
 * "no activity yet" — while the agent was demonstrably working.
 *
 * The fix: the HookServer forwards hook-plane signals (liveness, tool spans,
 * CostSample usage) into the collector, where they merge into snapshot() ONLY —
 * getAgentUsage() is the locked breaker/ledger seam and must stay OTLP-only so
 * hook-derived totals never start cost-ledger rows or change breaker inputs.
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

const { TelemetryCollector } = loadTs('src/main/telemetry.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const CONFIG = { notifications: false };

/** A minimal OTLP metrics batch: one `claude_code.token.usage` input data point. */
function otlpTokenBatch(agentId, sessionId, type, value) {
  const attr = (key, stringValue) => ({ key, value: { stringValue } });
  return {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'claude_code.token.usage',
                sum: {
                  dataPoints: [
                    {
                      attributes: [
                        attr('agent.id', agentId),
                        attr('session.id', sessionId),
                        attr('type', type),
                      ],
                      asInt: value,
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

test('hook-plane ingest lights up snapshot() for an agent with no OTLP', () => {
  const c = new TelemetryCollector();
  c.recordHookActivity('pi-1');
  c.recordHookSpan('pi-1', 'Bash');
  c.recordHookUsage('pi-1', 'sess-9', {
    input: 100,
    output: 20,
    cacheRead: 3,
    cacheCreation: 4,
    model: 'glm-5.3',
  });

  const snap = c.snapshot();
  const u = snap.usage.find((x) => x.agentId === 'pi-1');
  assert.ok(u, 'no usage row — the fleet row stays blind');
  assert.ok(u.ts > 0, 'no activity stamp — lastActiveSecAgo stays null');
  assert.equal(u.input + u.output + u.cacheRead + u.cacheCreation, 127);
  assert.equal(snap.spans['pi-1'].at(-1).tool, 'Bash', 'no span — lastTool stays null');

  // Deltas accumulate like the OTLP path.
  c.recordHookUsage('pi-1', 'sess-9', { input: 1, output: 0, cacheRead: 0, cacheCreation: 0 });
  assert.equal(c.snapshot().usage.find((x) => x.agentId === 'pi-1').input, 101);
});

test('OTLP stays the preferred source when both exist for one agent', () => {
  const c = new TelemetryCollector();
  c.recordHookUsage('a1', 'hook-sess', {
    input: 5,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    model: 'm',
  });
  c.ingestMetrics(otlpTokenBatch('a1', 'otlp-sess', 'input', 1000));
  const u = c.snapshot().usage.find((x) => x.agentId === 'a1');
  assert.equal(u.input, 1000, 'hook-plane rows must not shadow real OTLP totals');
  assert.equal(u.sessionId, 'otlp-sess');
});

test('hook-plane rows never enter the locked getAgentUsage seam', () => {
  const c = new TelemetryCollector();
  c.recordHookUsage('pi-1', 'sess-9', {
    input: 100,
    output: 20,
    cacheRead: 3,
    cacheCreation: 4,
    model: 'glm-5.3',
  });
  // No OTLP session, no resolveCwd → the breaker/ledger pull must see nothing:
  // a truthy sessionId here would append cost-ledger rows on the ~30s beat.
  assert.equal(c.getAgentUsage('pi-1'), null);
});

test('HookServer forwards liveness, spans and CostSample into telemetry', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-fleet-tel-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'pi-1', name: 'Piper', provider: 'claude', cwd: home });

  const collector = new TelemetryCollector();
  const server = new HookServer(
    hive,
    () => null,
    () => CONFIG,
    undefined,
    undefined,
    collector,
  );

  server.handle({ agent_id: 'pi-1', hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  server.handle({
    agent_id: 'pi-1',
    hook_event_name: 'CostSample',
    session_id: 's1',
    input: 10,
    output: 5,
    cache_read: 1,
    cache_creation: 1,
    model: 'glm-5.3',
  });
  server.handle({ agent_id: 'pi-2', hook_event_name: 'Stop' }); // liveness only

  const snap = collector.snapshot();
  const u1 = snap.usage.find((x) => x.agentId === 'pi-1');
  assert.ok(u1 && u1.ts > 0, 'CostSample agent has no usage row');
  assert.equal(u1.input + u1.output + u1.cacheRead + u1.cacheCreation, 17);
  assert.equal(snap.spans['pi-1'].at(-1).tool, 'Bash');
  const u2 = snap.usage.find((x) => x.agentId === 'pi-2');
  assert.ok(u2 && u2.ts > 0, 'a bare Stop event must still stamp liveness');
});

test('the pi bridge extension posts usage as CostSample on message_end', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-pi-ext-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'pi-9', name: 'Piper', provider: 'pi', cwd: home });

  const bridge = path.join(home, 'hive/agents/pi-9/.pi-agent/extensions/hive-bridge.ts');
  assert.ok(fs.existsSync(bridge), 'pi bridge extension missing');
  const body = fs.readFileSync(bridge, 'utf8');
  assert.match(body, /message_end/, 'no usage source without the message_end handler');
  assert.match(body, /CostSample/, 'usage must ride the existing CostSample socket path');
  assert.match(body, /PI_SESSION_ID/, 'samples need the session id for ledger/dedup semantics');
});
