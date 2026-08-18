'use strict';
/**
 * Proxy-bridge steer delivery for qwen/crush (card
 * agent-opencode-qwen-crush-agen-2026-08-18): the proxy tier has no hook
 * surface, so steers were queued + surfaced loudly but never delivered. Fix:
 * the sidecar's synthesized PostToolUse is now BIDIRECTIONAL — HookServer
 * consumes the queued steer and returns it as additionalContext — and the
 * sidecar injects it into the NEXT upstream request as a synthetic trailing
 * user message. The CLI sees the model respond to guidance it never sent:
 * mid-run delivery without any hook support.
 *
 * Integration-shaped: runs the extracted PROXY_BRIDGE_SHIM as a REAL child
 * process against a real fake HookServer unix socket and a real fake upstream
 * HTTP server, driving three requests through the loopback proxy.
 * Run with `node --test test/proxy-bridge-steer-inject.test.cjs`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const hive = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8');
const match = hive.match(/const PROXY_BRIDGE_SHIM = `([\s\S]*?)`;\n\n\/\/ ─── grok-hook shim/);
assert.ok(match, 'must find the PROXY_BRIDGE_SHIM template');
// Materialize the template exactly like hive.ts does (evaluating the \\n
// escapes) — the child speaks real-newline protocols on stdout + the socket.
const shimSource = new Function(`return \`${match[1]}\``)();

const STEER = 'OPERATOR: circuit breaker — stop and summarize.';

function waitFor(cond, ms = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - started > ms) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** A fake HookServer: replies to PostToolUse with a steer-bearing response. */
function startHookSock(sockPath, seen) {
  return new Promise((resolve) => {
    const server = net.createServer((conn) => {
      let buf = '';
      conn.on('data', (d) => {
        buf += d.toString();
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        let payload = {};
        try {
          payload = JSON.parse(buf.slice(0, nl));
        } catch {
          /* ignore */
        }
        seen.push(payload);
        const res =
          payload.hook_event_name === 'PostToolUse'
            ? {
                hookSpecificOutput: {
                  hookEventName: 'PostToolUse',
                  additionalContext: STEER,
                },
              }
            : {};
        conn.end(JSON.stringify(res));
      });
      conn.on('error', () => {});
    });
    server.listen(sockPath, () => resolve(server));
  });
}

test('the proxy consumes a steer at PostToolUse and injects it into the next request', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-steer-'));
  const sockPath = path.join(dir, 'hive.sock');
  const shimPath = path.join(dir, 'hive-proxy.cjs');
  fs.writeFileSync(shimPath, shimSource, 'utf8');

  const hookEvents = [];
  const hookServer = await startHookSock(sockPath, hookEvents);

  // Fake upstream: the FIRST response carries a tool call (which makes the
  // sidecar synthesize PostToolUse → the steer-consume round-trip); every
  // request body is recorded for the injection assertions.
  const upstreamSeen = [];
  let calls = 0;
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      upstreamSeen.push(JSON.parse(body));
      calls += 1;
      res.setHeader('content-type', 'application/json');
      if (calls === 1) {
        res.end(
          JSON.stringify({
            id: 'r1',
            model: 'gpt-4o',
            usage: { prompt_tokens: 10, completion_tokens: 5 },
            choices: [
              {
                message: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      id: 't1',
                      type: 'function',
                      function: { name: 'shell', arguments: '{"cmd":"ls"}' },
                    },
                  ],
                },
              },
            ],
          }),
        );
      } else {
        res.end(
          JSON.stringify({
            id: `r${calls}`,
            model: 'gpt-4o',
            usage: { prompt_tokens: 12, completion_tokens: 3 },
            choices: [{ message: { role: 'assistant', content: 'done' } }],
          }),
        );
      }
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

  const child = spawn(process.execPath, [shimPath], {
    env: {
      ...process.env,
      HIVE_SOCK: sockPath,
      AGENT_ID: 'qwen-1',
      UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`,
      HIVE_PROXY_SESSION: 'proxy-steer-test',
      HIVE_PROXY_API: 'openai',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(() => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    hookServer.close();
    upstream.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('sidecar never reported a port')), 5000);
    child.stdout.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buf.slice(0, nl)).port);
      } catch (e) {
        reject(e);
      }
    });
    child.on('exit', () => reject(new Error('sidecar exited before reporting a port')));
  });
  const base = `http://127.0.0.1:${port}`;

  const post = (body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        `${base}/chat/completions`,
        { method: 'POST', headers: { 'content-type': 'application/json' } },
        (res) => {
          let b = '';
          res.on('data', (d) => (b += d));
          res.on('end', () => resolve(b));
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });

  // Request 1: a plain prompt. The response's tool call makes the sidecar emit
  // PostToolUse BIDIRECTIONALLY and stash the steer the fake HookServer returns.
  await post({ model: 'gpt-4o', messages: [{ role: 'user', content: 'list the repo' }] });
  await waitFor(() => hookEvents.some((e) => e.hook_event_name === 'PostToolUse'));
  // Give the sidecar its response-read tick before the next request races in.
  await waitFor(() => false, 100).catch(() => {});

  // Request 2: the CLI continues the tool loop. The sidecar must append the
  // steer as a synthetic trailing user message before forwarding.
  await post({
    model: 'gpt-4o',
    messages: [
      { role: 'user', content: 'list the repo' },
      {
        role: 'assistant',
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'shell', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 't1', content: 'file.txt' },
    ],
  });
  assert.equal(upstreamSeen.length, 2, 'both requests reached the upstream');
  const injected = upstreamSeen[1].messages;
  assert.equal(injected.at(-1).role, 'user', 'the steer lands as a trailing user message');
  assert.equal(injected.at(-1).content, STEER, 'steer text injected verbatim');
  assert.equal(
    Buffer.byteLength(JSON.stringify(upstreamSeen[1]), 'utf8') > 0,
    true,
    'the re-serialized body is valid JSON',
  );

  // Request 3: delivered exactly once — no repeat injection.
  await post({ model: 'gpt-4o', messages: [{ role: 'user', content: 'carry on' }] });
  assert.ok(
    !upstreamSeen[2].messages.some((m) => typeof m.content === 'string' && m.content === STEER),
    'the steer is injected exactly once',
  );
});

test('a stashed steer survives a non-chat hop and rides the next chat request', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-steer-'));
  const sockPath = path.join(dir, 'hive.sock');
  const shimPath = path.join(dir, 'hive-proxy.cjs');
  fs.writeFileSync(shimPath, shimSource, 'utf8');

  const hookEvents = [];
  const hookServer = await startHookSock(sockPath, hookEvents);

  const upstreamSeen = [];
  let calls = 0;
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      upstreamSeen.push(body);
      calls += 1;
      res.setHeader('content-type', 'application/json');
      // The FIRST chat response carries a tool call → PostToolUse → steer reply.
      if (calls === 1) {
        res.end(
          JSON.stringify({
            id: 'r1',
            model: 'gpt-4o',
            usage: { prompt_tokens: 1, completion_tokens: 1 },
            choices: [
              {
                message: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      id: 't1',
                      type: 'function',
                      function: { name: 'shell', arguments: '{}' },
                    },
                  ],
                },
              },
            ],
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          id: 'r',
          model: 'gpt-4o',
          usage: { prompt_tokens: 1, completion_tokens: 1 },
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
        }),
      );
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

  const child = spawn(process.execPath, [shimPath], {
    env: {
      ...process.env,
      HIVE_SOCK: sockPath,
      AGENT_ID: 'crush-1',
      UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`,
      HIVE_PROXY_SESSION: 'proxy-steer-test-2',
      HIVE_PROXY_API: 'openai',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(() => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    hookServer.close();
    upstream.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('sidecar never reported a port')), 5000);
    child.stdout.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      resolve(JSON.parse(buf.slice(0, nl)).port);
    });
    child.on('exit', () => reject(new Error('sidecar exited before reporting a port')));
  });

  const rawPost = (urlPath, body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${port}${urlPath}`,
        { method: 'POST', headers: { 'content-type': 'application/json' } },
        (res) => {
          let b = '';
          res.on('data', (d) => (b += d));
          res.on('end', () => resolve(b));
        },
      );
      req.on('error', reject);
      req.end(body);
    });

  // Request 1: chat; the tool-call response consumes the steer at PostToolUse.
  await rawPost(
    '/v1/chat/completions',
    JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'go' }] }),
  );
  await waitFor(() => hookEvents.some((e) => e.hook_event_name === 'PostToolUse'));
  await waitFor(() => false, 100).catch(() => {});

  // Request 2: a non-chat hop (no messages array). It cannot carry the steer —
  // but must be forwarded untouched WITHOUT dropping it.
  await rawPost('/v1/embeddings', JSON.stringify({ input: 'x' }));
  assert.ok(!upstreamSeen[1].includes(STEER), 'the non-chat hop is forwarded untouched');

  // Request 3: the next chat request picks the stashed steer up.
  await rawPost(
    '/v1/chat/completions',
    JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'on' }] }),
  );
  const ride = JSON.parse(upstreamSeen[2]);
  assert.equal(ride.messages.at(-1).role, 'user');
  assert.equal(ride.messages.at(-1).content, STEER, 'the steer survives the non-chat hop');
});
