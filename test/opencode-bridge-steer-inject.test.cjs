'use strict';
/**
 * OpenCode bridge steer delivery (card agent-opencode-qwen-crush-agen-2026-08-18):
 * same fix class as pi (6b432b6). HookServer consumes queued operator steers at
 * the hook boundary and returns them as hookSpecificOutput.additionalContext on
 * the socket response. The opencode plugin must READ that response and inject
 * the steer into the NEXT LLM call — via `experimental.chat.system.transform`,
 * a hook whose trigger shape is VERIFIED against the installed opencode 1.1.55
 * binary (fires in LLMRequestPrep before every LLM call; output.system is the
 * system-prompt string array, mutated in place). The old fire-and-forget post()
 * ended the connection unread, so a steer consumed for an opencode agent was
 * silently dropped.
 *
 * Self-contained: extracts the OPENCODE_PLUGIN template from hive.ts and runs
 * it against a fake socket that replies with a steer-bearing response.
 * Run with `node --test test/opencode-bridge-steer-inject.test.cjs`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const hive = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8');
const match = hive.match(/const OPENCODE_PLUGIN = `([\s\S]*?)`;\n\n\/\/ ─── proxy-bridge/);
assert.ok(match, 'must find the OPENCODE_PLUGIN template');

async function loadPlugin(reply) {
  const posts = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-steer-'));
  const file = path.join(dir, 'hive-bridge.mjs');
  fs.writeFileSync(
    file,
    match[1].replace(
      "import { createConnection } from 'node:net';",
      'const { createConnection } = globalThis.__hiveNet;',
    ),
    'utf8',
  );
  globalThis.__hiveNet = {
    createConnection(_sock, connected) {
      const conn = {
        handlers: {},
        end(payload) {
          // The template literal's '\\n' lands as a LITERAL backslash-n in the
          // extracted source (same escape dance as opencode-bridge-tool-input).
          posts.push(JSON.parse(payload.replace(/\\n$/, '')));
          // The real HookServer writes one JSON response, then ends the
          // connection — replay that after the payload lands.
          queueMicrotask(() => {
            this.handlers.data?.(reply);
            this.handlers.end?.();
          });
        },
        setEncoding() {},
        on(ev, fn) {
          this.handlers[ev] = fn;
        },
      };
      queueMicrotask(connected);
      return conn;
    },
  };
  const priorSock = process.env.HIVE_SOCK;
  const priorAgent = process.env.AGENT_ID;
  process.env.HIVE_SOCK = '/tmp/hive.sock';
  process.env.AGENT_ID = 'oc-steer';
  const mod = await import(`${pathToFileURL(file).href}?${Date.now()}`);
  const hooks = await mod.HiveBridge();
  return {
    hooks,
    posts,
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

const settle = () => new Promise((r) => setTimeout(r, 25));

test('a steer-bearing hook response is injected into the next LLM system prompt', async () => {
  const steer = 'OPERATOR: stop the refactor and summarize.';
  const plugin = await loadPlugin(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: steer },
    }),
  );
  try {
    await plugin.hooks['tool.execute.after']({ tool: 'bash', callID: 'c1' });
    await settle();

    const output = { system: ['base system prompt'] };
    await plugin.hooks['experimental.chat.system.transform']({ sessionID: 's1' }, output);
    assert.equal(output.system.length, 2, 'the steer rides the next LLM call');
    assert.match(output.system[1], /OPERATOR: stop the refactor and summarize\./);

    // Delivered ONCE: the following LLM call gets no repeat injection.
    const next = { system: ['base system prompt'] };
    await plugin.hooks['experimental.chat.system.transform']({ sessionID: 's1' }, next);
    assert.equal(next.system.length, 1, 'a consumed steer is injected exactly once');
  } finally {
    plugin.dispose();
  }
});

test('an empty hook response injects nothing', async () => {
  const plugin = await loadPlugin('{}');
  try {
    await plugin.hooks['tool.execute.after']({ tool: 'bash', callID: 'c1' });
    await settle();
    const output = { system: ['base'] };
    await plugin.hooks['experimental.chat.system.transform']({}, output);
    assert.deepEqual(output.system, ['base'], 'no additionalContext -> no injection');
  } finally {
    plugin.dispose();
  }
});

test('chat.message posts the turn-start UserPromptSubmit boundary with the prompt', async () => {
  const plugin = await loadPlugin('{}');
  try {
    assert.ok(plugin.hooks['chat.message'], 'the bridge hooks chat.message');
    await plugin.hooks['chat.message'](
      { sessionID: 's9' },
      { message: {}, parts: [{ type: 'text', text: 'fix the build' }, { type: 'file' }] },
    );
    await settle();
    const up = plugin.posts.find((p) => p.hook_event_name === 'UserPromptSubmit');
    assert.ok(up, 'turn-start boundary posted — the earliest steer-consume window');
    assert.equal(up.session_id, 's9');
    assert.equal(up.prompt, 'fix the build');
  } finally {
    plugin.dispose();
  }
});

test('steers consumed at two boundaries before the next LLM call both land', async () => {
  const steer = 'OPERATOR: slow down.';
  const plugin = await loadPlugin(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: steer },
    }),
  );
  try {
    await plugin.hooks['tool.execute.after']({ tool: 'bash', callID: 'c1' });
    await settle();
    await plugin.hooks['tool.execute.after']({ tool: 'bash', callID: 'c2' });
    await settle();
    const output = { system: ['base'] };
    await plugin.hooks['experimental.chat.system.transform']({}, output);
    assert.equal(output.system.length, 2);
    const occurrences = output.system[1].split(steer).length - 1;
    assert.equal(occurrences, 2, 'both consumed steers accumulate, nothing dropped');
  } finally {
    plugin.dispose();
  }
});
