'use strict';
/**
 * pi agents render IDLE on the office floor while working
 * (card agent-hold-pi-provider-agents--2026-08-18).
 *
 * Root cause (verified): the renderer status pipeline assumed Claude-shaped
 * signals. Three gaps stacked: (1) pi's bridge posted tool_call/tool_result/
 * agent_settled but NO turn-start event, so prompt→first-tool thinking phases
 * stayed 'idle'; (2) the provider-agnostic quiesce idle fallback flipped any
 * 'working' agent to idle after 12s of PTY silence — a pi agent in a long
 * tool/subagent run posts hook events steadily while its pty prints nothing;
 * (3) usePtyParser is a Claude-TUI stopgap whose 4s idle drift never matches a
 * pi TUI, so a mounted pi pane was a pure idle machine fighting the hook
 * events. Telemetry (fleet.json) was correct all along — it reads the same
 * hook plane the sprite ignored.
 *
 * Fixes under test: the bridge emits UserPromptSubmit on agent_start; the
 * quiesce fallback requires BOTH pty-quiet AND hook-quiet; the pty parser
 * stays out of non-claude status entirely.
 *
 * Run with `node --test test/pi-floor-status.test.cjs`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

// — part 1: the bridge template actually emits the turn-start event ————
// Same extraction + fake-harness mechanism as pi-bridge-session-id.test.cjs.

const hive = fs.readFileSync(path.join(ROOT, 'src', 'main', 'hive.ts'), 'utf8');
const match = hive.match(/const PI_EXTENSION = `([\s\S]*?)`;\n\n\/\/ ─── opencode/);
assert.ok(match, 'must find the generated pi extension template');

const ts = require('typescript');
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-floor-status-'));
const extFile = path.join(extDir, 'hive-bridge.mjs');
fs.writeFileSync(
  extFile,
  ts
    .transpileModule(match[1], {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: 'hive-bridge.ts',
    })
    .outputText.replace(/import net from ['"]node:net['"];?/, 'const net = globalThis.__hiveNet;'),
  'utf8',
);

let sink = null;
async function loadExtension(posts, sessionId) {
  globalThis.__hiveNet ??= {
    createConnection(_sock, connected) {
      const connection = {
        end(payload) {
          sink?.(payload);
        },
        on() {},
      };
      queueMicrotask(connected);
      return connection;
    },
  };
  sink = (payload) => posts.push(JSON.parse(payload.slice(0, payload.lastIndexOf('}') + 1)));
  process.env.HIVE_SOCK = '/fake/hive.sock';
  const mod = await import(pathToFileURL(extFile).href);
  const handlers = {};
  const pi = {
    on: (ev, fn) => {
      handlers[ev] = fn;
    },
  };
  const ctx = { sessionManager: { getSessionId: () => sessionId } };
  mod.default(pi);
  return { handlers, ctx };
}

test('pi bridge posts UserPromptSubmit on agent_start — the turn-start signal the renderer never had', async () => {
  const posts = [];
  const { handlers, ctx } = await loadExtension(posts, 'pi-sess-1');
  assert.equal(typeof handlers.agent_start, 'function', 'agent_start must be subscribed');

  await handlers.agent_start({}, ctx);
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(posts.length, 1);
  assert.equal(posts[0].hook_event_name, 'UserPromptSubmit');
  assert.equal(posts[0].session_id, 'pi-sess-1');
});

test('pi bridge still posts the full working/idle cycle around the new event', async () => {
  const posts = [];
  const { handlers, ctx } = await loadExtension(posts, 'pi-sess-2');

  await handlers.agent_start({}, ctx);
  await handlers.tool_call({ toolName: 'bash', input: { command: 'ls' } }, ctx);
  await handlers.tool_result({ toolName: 'bash' }, ctx);
  await handlers.agent_settled({}, ctx);
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(
    posts.map((p) => p.hook_event_name),
    ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'],
    'turn start → tool cycle → settle, all on the Claude hook plane',
  );
});

// — part 2: renderer source scans (house pattern: renderer behaviour is
//   verified against the source; the .cjs harness cannot load React) ————

const useHive = fs.readFileSync(
  path.join(ROOT, 'src', 'renderer', 'src', 'hooks', 'useHive.ts'),
  'utf8',
);
const usePtyParser = fs.readFileSync(
  path.join(ROOT, 'src', 'renderer', 'src', 'hooks', 'usePtyParser.ts'),
  'utf8',
);

test('the hook handler stamps per-agent hook liveness for the quiesce fallback', () => {
  assert.match(useHive, /lastHookEventAt\.current\[e\.agentId\] = Date\.now\(\)/);
});

test('quiesce idle fallback requires BOTH pty-quiet AND hook-quiet', () => {
  // The guard: recent hook events skip the idle flip even when the pty is
  // silent — a pi agent in a long tool/subagent run prints nothing but keeps
  // posting Pre/PostToolUse.
  assert.match(useHive, /const lastHook = lastHookEventAt\.current\[a\.id\] \?\? 0;/);
  assert.match(useHive, /if \(lastHook > 0 && now - lastHook <= QUIESCE_IDLE_MS\) continue;/);
});

test('the Claude-TUI pty parser no longer writes status for non-claude providers', () => {
  assert.match(usePtyParser, /inferAgentProvider\(self\.command, self\.provider\) !== 'claude'/);
  // The gate must sit inside the chunk callback, ahead of every status write.
  const gate = usePtyParser.indexOf("inferAgentProvider(self.command, self.provider) !== 'claude'");
  const callback = usePtyParser.indexOf('return useCallback(');
  const firstWrite = usePtyParser.indexOf('updateAgent(agentId', callback);
  assert.ok(callback !== -1 && gate > callback && firstWrite > gate);
});
