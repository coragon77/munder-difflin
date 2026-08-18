'use strict';
/**
 * pi subagent token attribution (card agent-pi-subagent-tokens-may-b-2026-08-18).
 *
 * MEASURED (live, on the reporting agent itself): pi.agent children are spawned
 * launch-resolved (runtime extension only — the hive bridge never loads inside
 * them) and their per-message usage never re-emits on the parent's message_end
 * bus. A child that burned 16.7M tokens (15.9M of it cacheRead — each child
 * re-reads the parent's context) contributed ZERO to the parent's fleet.json
 * row: the parent's own session shows no usage rows for the child window, and
 * the row delta during a child-only window is explained entirely by the
 * parent's own turns.
 *
 * Fix: the bridge template reconciles CHILD SESSION FILES (the canonical
 * record, shared via PI_CODING_AGENT_DIR/sessions) into the CostSample plane —
 * baseline history at load, post each file's growth once (persisted cursors),
 * exclude the parent's own session. This test runs the real extracted template
 * against a fake pi harness + fake net + REAL session files in a tmpdir.
 *
 * Run with `node --test test/pi-subagent-token-attribution.test.cjs`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const hive = fs.readFileSync(path.join(ROOT, 'src', 'main', 'hive.ts'), 'utf8');
const match = hive.match(/const PI_EXTENSION = `([\s\S]*?)`;\n\n\/\/ ─── opencode/);
assert.ok(match, 'must find the generated pi extension template');

const ts = require('typescript');
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-child-usage-'));
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
async function loadExtension(posts, piDir, sessionId) {
  globalThis.__hiveNet ??= {
    createConnection(_sock, connected) {
      const connection = {
        end(payload) {
          sink?.(payload);
        },
        setEncoding() {},
        on() {},
      };
      queueMicrotask(connected);
      return connection;
    },
  };
  sink = (payload) => posts.push(JSON.parse(payload.slice(0, payload.lastIndexOf('}') + 1)));
  process.env.HIVE_SOCK = '/fake/hive.sock';
  // Hermetic env: the extension reconciles child session files from
  // PI_CODING_AGENT_DIR — a real agent dir inherited from the ambient env
  // (these tests run INSIDE a pi agent) would leak real sessions in.
  process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-hermetic-'));
  if (piDir) process.env.PI_CODING_AGENT_DIR = piDir;
  const mod = await import(pathToFileURL(extFile).href);
  const handlers = {};
  const pi = { on: (ev, fn) => (handlers[ev] = fn), sendMessage() {} };
  const ctx = { sessionManager: { getSessionId: () => sessionId } };
  mod.default(pi);
  return { handlers, ctx };
}

/** A session-file entry: assistant message with pi's normalized usage shape. */
function msgEntry(role, usage, model) {
  return JSON.stringify({
    type: 'message',
    timestamp: new Date().toISOString(),
    message: { role, usage, ...(model ? { responseModel: model } : {}), content: [] },
  });
}

const SESS_DIR_NAME = '--home-sfuchs-HarnessAgents-worktrees-ada-msw5vf5o--';

/** A file name pi could have created NOW (children are born during the run). */
function freshSessionName(uuid) {
  return new Date().toISOString().replace(/[:.]/g, '-') + '_' + uuid + '.jsonl';
}

function writeSession(piDir, file, entries) {
  const d = path.join(piDir, 'sessions', SESS_DIR_NAME);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, file), entries.join('\n') + '\n', 'utf8');
  return path.join(d, file);
}

const CHILD_A = '01a0aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CHILD_B = '01a0ffff-1111-4222-8333-444444444444';

test('child session growth posts as CostSample keyed by the child session id; parent session excluded; history baselined', async () => {
  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-home-'));
  // Pre-load history (another old session) — must be baselined, never posted.
  writeSession(piDir, '2026-08-17T07-00-00-000Z_' + CHILD_B + '.jsonl', [
    msgEntry('assistant', { input: 999, output: 999, cacheRead: 999, cacheWrite: 0 }),
  ]);
  const posts = [];
  const { handlers, ctx } = await loadExtension(
    posts,
    piDir,
    '01a0c0de-dead-4be7-8bad-baadbaadbaad',
  );

  // The parent's own session file, born after load — must NEVER be posted.
  const parentFile = freshSessionName('01a0c0de-dead-4be7-8bad-baadbaadbaad');
  writeSession(piDir, parentFile, [
    msgEntry('assistant', { input: 5000, output: 5000, cacheRead: 5000, cacheWrite: 0 }),
  ]);
  // Baseline scan (agent_start carries ctx so MY_SESSION is known).
  await handlers.agent_start({}, ctx);
  assert.equal(
    posts.filter((p) => p.hook_event_name === 'CostSample').length,
    0,
    'nothing posted at baseline',
  );

  // A child session appears (born after load): full totals must post.
  const childFile = freshSessionName(CHILD_A);
  writeSession(piDir, childFile, [
    msgEntry('assistant', { input: 300, output: 40, cacheRead: 7000, cacheWrite: 0 }, 'test-model'),
    msgEntry('toolResult', { input: 0, output: 0, cacheRead: 1000, cacheWrite: 0 }),
  ]);
  await handlers.agent_settled({}, ctx);
  const cost = posts.filter((p) => p.hook_event_name === 'CostSample');
  assert.equal(cost.length, 1, 'one CostSample for the new child session');
  assert.equal(cost[0].session_id, CHILD_A);
  assert.equal(cost[0].model, 'test-model');
  assert.equal(cost[0].input, 300);
  assert.equal(cost[0].output, 40);
  assert.equal(cost[0].cache_read, 8000);

  // Same state again — idempotent, nothing new posts.
  await handlers.agent_settled({}, ctx);
  assert.equal(posts.filter((p) => p.hook_event_name === 'CostSample').length, 1);

  // The child session GROWS: only the delta posts.
  const f = path.join(piDir, 'sessions', SESS_DIR_NAME, childFile);
  fs.appendFileSync(
    f,
    msgEntry('assistant', { input: 10, output: 2, cacheRead: 500, cacheWrite: 7 }) + '\n',
  );
  await handlers.agent_settled({}, ctx);
  const cost2 = posts.filter((p) => p.hook_event_name === 'CostSample');
  assert.equal(cost2.length, 2);
  assert.equal(cost2[1].input, 10);
  assert.equal(cost2[1].cache_read, 500);
  assert.equal(cost2[1].cache_creation, 7);

  // The parent's own file grew too — still never posted.
  fs.appendFileSync(
    path.join(piDir, 'sessions', SESS_DIR_NAME, parentFile),
    msgEntry('assistant', { input: 999, output: 999, cacheRead: 999, cacheWrite: 0 }) + '\n',
  );
  await handlers.agent_settled({}, ctx);
  assert.equal(
    posts.filter((p) => p.hook_event_name === 'CostSample').length,
    2,
    'parent session never double-reports',
  );
});

test('cursors persist across a simulated restart — a fresh extension load posts no history twice', async () => {
  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-home-2-'));
  const posts1 = [];
  const first = await loadExtension(posts1, piDir, '01a0c0de-dead-4be7-8bad-baadbaadbaad');
  // Child born DURING module 1's lifetime → its totals post once.
  const childFile = freshSessionName(CHILD_A);
  writeSession(piDir, childFile, [
    msgEntry('assistant', { input: 100, output: 20, cacheRead: 4000, cacheWrite: 0 }),
  ]);
  await first.handlers.agent_settled({}, first.ctx);
  assert.equal(posts1.filter((p) => p.hook_event_name === 'CostSample').length, 1);

  // "Restart": re-import the template fresh (module cache is per-URL — use a
  // query to force a second module instance sharing the same PI dir).
  const ext2 = path.join(extDir, 'hive-bridge-2.mjs');
  fs.writeFileSync(ext2, fs.readFileSync(extFile, 'utf8'), 'utf8');
  const saved = process.env.PI_CODING_AGENT_DIR;
  const posts2 = [];
  const sink2 = (payload) =>
    posts2.push(JSON.parse(payload.slice(0, payload.lastIndexOf('}') + 1)));
  const mod2 = await import(pathToFileURL(ext2).href + '?v=2');
  sink = sink2;
  process.env.PI_CODING_AGENT_DIR = saved;
  const handlers2 = {};
  mod2.default({ on: (ev, fn) => (handlers2[ev] = fn), sendMessage() {} });
  await handlers2.agent_settled(
    {},
    { sessionManager: { getSessionId: () => '01a0c0de-dead-4be7-8bad-baadbaadbaad' } },
  );
  // Load-time baseline consumed the child's totals via the persisted cursor:
  // no growth since, so nothing posts.
  assert.equal(posts2.filter((p) => p.hook_event_name === 'CostSample').length, 0);
});

test('a pi dir with no sessions dir (or none at all) is a silent no-op', async () => {
  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-home-3-')); // empty
  const posts = [];
  const { handlers, ctx } = await loadExtension(
    posts,
    piDir,
    '01a0c0de-dead-4be7-8bad-baadbaadbaad',
  );
  await handlers.agent_start({}, ctx);
  await handlers.agent_settled({}, ctx);
  assert.equal(posts.filter((p) => p.hook_event_name === 'CostSample').length, 0);
});
