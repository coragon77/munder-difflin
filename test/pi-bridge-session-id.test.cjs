'use strict';
/**
 * Pi bridge session stamping (card-session-stamp-never-fires-20260816):
 * pi agents' cards never got a sessionId stamp because the bridge's hook posts
 * carried NO session_id — the only place it was sent (CostSample) read
 * process.env.PI_SESSION_ID, which pi injects into BASH TOOL executions only,
 * never into the extension's process env. So recordSession never ran for pi
 * agents (registry sessionId stayed None) and stampActiveCards was unreachable.
 *
 * Fix: every post derives session_id from ctx.sessionManager.getSessionId()
 * (documented, verified against the installed pi's .d.ts). This loads the
 * generated extension template and fires its events with a fake pi harness —
 * every resulting socket payload must carry the session id.
 *
 * Run with `node --test test/pi-bridge-session-id.test.cjs`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const hive = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8');
const match = hive.match(/const PI_EXTENSION = `([\s\S]*?)`;\n\n\/\/ ─── opencode/);
assert.ok(match, 'must find the generated pi extension template');

// The template is TypeScript (deployed as hive-bridge.ts) — transpile it the
// same way load-ts.cjs handles the main-process sources, then run it as ESM
// with a fake net + fake pi ctx.
const ts = require('typescript');
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bridge-'));
const extFile = path.join(extDir, 'hive-bridge.mjs');
fs.writeFileSync(extFile, ts.transpileModule(match[1], {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: 'hive-bridge.ts'
}).outputText.replace(/import net from ['"]node:net['"];?/, 'const net = globalThis.__hiveNet;'), 'utf8');

// The extracted module binds `net` to __hiveNet at FIRST import and is then
// cached — so the fake must be installed once and route to a swappable sink.
let sink = null;
async function loadExtension(posts, sessionId) {
  globalThis.__hiveNet ??= {
    createConnection(_sock, connected) {
      const connection = {
        end(payload) { sink?.(payload); },
        on() {}
      };
      queueMicrotask(connected);
      return connection;
    }
  };
  sink = (payload) => posts.push(JSON.parse(payload.slice(0, payload.lastIndexOf('}') + 1)));
  process.env.HIVE_SOCK = '/fake/hive.sock';
  const mod = await import(pathToFileURL(extFile).href);
  const handlers = {};
  const pi = { on: (ev, fn) => { handlers[ev] = fn; } };
  const ctx = { sessionManager: { getSessionId: () => sessionId } };
  mod.default(pi);
  return { handlers, ctx };
}

test('every hook post carries the session id from ctx.sessionManager (recordSession becomes reachable for pi agents)', async () => {
  const posts = [];
  const { handlers, ctx } = await loadExtension(posts, 'pi-session-uuid-1');

  await handlers.tool_call({ toolName: 'bash', input: { command: 'ls' } }, ctx);
  await handlers.tool_result({ toolName: 'bash' }, ctx);
  await handlers.agent_settled({}, ctx);
  await handlers.message_end({ message: { role: 'assistant', usage: { input: 10, output: 5 } } }, ctx);

  assert.equal(posts.length, 4);
  for (const p of posts) {
    assert.equal(p.session_id, 'pi-session-uuid-1', `${p.hook_event_name} post must carry the session id`);
  }
  assert.equal(posts[0].hook_event_name, 'PreToolUse');
  assert.equal(posts[3].hook_event_name, 'CostSample');
});

test('a missing/legacy ctx (no sessionManager) degrades to no session_id, never throws', async () => {
  const posts = [];
  const { handlers } = await loadExtension(posts, 'unused');
  await handlers.tool_call({ toolName: 'bash', input: {} }, undefined);
  await handlers.agent_settled({}, {});
  assert.equal(posts.length, 2);
  for (const p of posts) assert.equal(p.session_id, undefined);
});
