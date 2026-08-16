'use strict';
/**
 * OpenCode bridge regression: tool.execute.before exposes args on its output,
 * while tool.execute.after does not. The bridge must retain those args per
 * callID so the breaker receives the actual tool_input on PostToolUse.
 *
 * Self-contained: extracts and executes the generated plugin template with a
 * fake socket. Run with `node --test test/opencode-bridge-tool-input.test.cjs`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const hive = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8');
const match = hive.match(/const OPENCODE_PLUGIN = `([\s\S]*?)`;\n\n\/\/ ─── proxy-bridge/);
assert.ok(match, 'must find the generated OpenCode plugin template');

async function loadPlugin(posts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-bridge-'));
  const plugin = match[1].replace(
    "import { createConnection } from 'node:net';",
    'const { createConnection } = globalThis.__hiveNet;',
  );
  const file = path.join(dir, 'hive-bridge.mjs');
  fs.writeFileSync(file, plugin, 'utf8');
  globalThis.__hiveNet = {
    createConnection(_socket, connected) {
      const connection = {
        end(payload) {
          posts.push(JSON.parse(payload.replace(/\\n$/, '')));
        },
        on() {},
      };
      queueMicrotask(connected);
      return connection;
    },
  };
  const priorSock = process.env.HIVE_SOCK;
  const priorAgent = process.env.AGENT_ID;
  process.env.HIVE_SOCK = '/tmp/hive.sock';
  process.env.AGENT_ID = 'opencode-agent';
  const module = await import(`${pathToFileURL(file).href}?${Date.now()}`);
  return {
    hooks: await module.HiveBridge(),
    dispose() {
      fs.rmSync(dir, { recursive: true, force: true });
      delete globalThis.__hiveNet;
      if (priorSock === undefined) delete process.env.HIVE_SOCK;
      else process.env.HIVE_SOCK = priorSock;
      if (priorAgent === undefined) delete process.env.AGENT_ID;
      else process.env.AGENT_ID = priorAgent;
    },
  };
}

async function flushPosts() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('OpenCode PostToolUse retains the matching before-hook output.args', async () => {
  const posts = [];
  const plugin = await loadPlugin(posts);
  try {
    await plugin.hooks['tool.execute.before'](
      { tool: 'bash', sessionID: 's', callID: 'first' },
      { args: { command: 'printf first' } },
    );
    await plugin.hooks['tool.execute.before'](
      { tool: 'bash', sessionID: 's', callID: 'second' },
      { args: { command: 'printf second' } },
    );
    await plugin.hooks['tool.execute.after'](
      { tool: 'bash', sessionID: 's', callID: 'first' },
      { title: '', output: '', metadata: {} },
    );
    await plugin.hooks['tool.execute.after'](
      { tool: 'bash', sessionID: 's', callID: 'second' },
      { title: '', output: '', metadata: {} },
    );
    await flushPosts();

    const after = posts.filter((post) => post.hook_event_name === 'PostToolUse');
    assert.deepEqual(after, [
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'bash',
        tool_input: { command: 'printf first' },
        agent_id: 'opencode-agent',
      },
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'bash',
        tool_input: { command: 'printf second' },
        agent_id: 'opencode-agent',
      },
    ]);
  } finally {
    plugin.dispose();
  }
});
