'use strict';
/**
 * Pi bridge steer delivery (card agent-operator-steers-for-pi-a-2026-08-18):
 * HookServer consumes queued operator steers at the hook boundary and returns
 * them as hookSpecificOutput.additionalContext on the socket response. The pi
 * bridge must READ that response and inject the steer via
 * pi.sendMessage({…}, {deliverAs:'steer'}) — the old fire-and-forget post()
 * ended the connection unread, so every consumed steer was silently dropped
 * (including the circuit breaker's steer/constrain message).
 *
 * Self-contained: extracts the PI_EXTENSION template from hive.ts and runs it
 * against a fake socket that replies with a steer-bearing response.
 * Run with `node --test test/pi-bridge-steer-inject.test.cjs`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const hive = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8');
const match = hive.match(/const PI_EXTENSION = `([\s\S]*?)`;\n\n\/\/ ─── opencode bridge/);
assert.ok(match, 'must find the PI_EXTENSION template');

process.env.HIVE_SOCK = '/tmp/hive-test.sock';
process.env.AGENT_ID = 'pi-1';

async function loadExtension(reply) {
  const posts = [];
  const sent = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bridge-'));
  const file = path.join(dir, 'hive-bridge.ts');
  fs.writeFileSync(
    file,
    match[1].replace("import net from 'node:net';", 'const net = globalThis.__hiveNet;'),
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
  const mod = await import(pathToFileURL(file).href);
  const pi = {
    handlers: {},
    on(ev, fn) {
      this.handlers[ev] = fn;
    },
    sendMessage(message, options) {
      sent.push({ message, options });
    },
  };
  mod.default(pi);
  return { pi, posts, sent };
}

const settle = () => new Promise((r) => setTimeout(r, 25));

test('a steer-bearing hook response is injected via pi.sendMessage(deliverAs:steer)', async () => {
  const steer = 'OPERATOR: stop the refactor and summarize.';
  const { pi, posts, sent } = await loadExtension(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: steer } }),
  );

  pi.handlers.tool_result({ toolName: 'bash' }, { sessionManager: { getSessionId: () => 's1' } });
  await settle();

  assert.equal(posts.length, 1, 'the PostToolUse payload was posted');
  assert.equal(sent.length, 1, 'the response steer was injected exactly once');
  assert.equal(sent[0].message.content, steer);
  assert.equal(sent[0].options?.deliverAs, 'steer');
});

test('an empty hook response injects nothing', async () => {
  const { pi, sent } = await loadExtension('{}');
  pi.handlers.tool_result({ toolName: 'bash' }, { sessionManager: { getSessionId: () => 's1' } });
  await settle();
  assert.equal(sent.length, 0, 'no additionalContext -> no injection');
});

test('a steer arriving on the turn-start (UserPromptSubmit) post is injected too', async () => {
  // Ada's floor-status branch (merged: agent_start -> UserPromptSubmit) widened
  // the consume window to turn start; steers consumed at THAT boundary must ride
  // the same injection path.
  const steer = 'OPERATOR: circuit breaker — slow down.';
  const { pi, sent } = await loadExtension(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: steer } }),
  );
  assert.ok(pi.handlers.agent_start, 'the bridge posts a turn-start UserPromptSubmit');
  pi.handlers.agent_start({}, { sessionManager: { getSessionId: () => 's1' } });
  await settle();
  assert.equal(sent.length, 1, 'the turn-start steer is injected like any other');
  assert.equal(sent[0].message.content, steer);
});
