#!/usr/bin/env node
/**
 * md-telegram-reply.cjs — post a message back into the Telegram chat that owns
 * this hive, WITHOUT ever handling the bot token.
 *
 * The Munder Difflin main process runs a loopback-only HTTP endpoint (bound to
 * 127.0.0.1, never public) and writes its `{ port, token }` to a discovery file
 * under the app's userData dir. This helper reads that file and POSTs the reply
 * to the endpoint, which holds the bot token and forwards to the owned chat.
 * The token never appears here, in the prompt, or in any transcript — and the
 * endpoint only ever posts to the ONE claimed chat.
 *
 * Usage:
 *   node md-telegram-reply.cjs --text "..."
 *   (optional) --config /abs/path/to/telegram-reply.json
 *
 * The discovery file is located via, in order: --config, then the
 * MD_TELEGRAM_REPLY_CONFIG env var (injected into every agent by main).
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

function fail(msg) {
  process.stderr.write(`md-telegram-reply: ${msg}\n`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const text = args.text;
if (!text || text === true) fail('required: --text "<message>"');

const configPath = args.config || process.env.MD_TELEGRAM_REPLY_CONFIG;
if (!configPath) fail('cannot locate the reply endpoint: set MD_TELEGRAM_REPLY_CONFIG or pass --config');

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  fail(`reply endpoint not running (could not read ${configPath}): ${e.message}`);
}
if (!cfg || typeof cfg.port !== 'number' || typeof cfg.token !== 'string') {
  fail(`malformed reply config at ${configPath}`);
}

const body = JSON.stringify({ text });
const req = http.request(
  {
    method: 'POST',
    host: '127.0.0.1',
    port: cfg.port,
    path: '/reply',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'x-md-reply-token': cfg.token
    }
  },
  (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let json = {};
      try { json = JSON.parse(raw); } catch { /* non-JSON body */ }
      if (res.statusCode === 200 && json.ok) {
        process.stdout.write('Posted reply to the Telegram chat.\n');
        process.exit(0);
      }
      fail(`reply failed (HTTP ${res.statusCode}): ${json.error || raw || 'unknown'}`);
    });
  }
);
req.on('error', (e) => fail(`could not reach reply endpoint: ${e.message}`));
req.write(body);
req.end();
