'use strict';

/**
 * Telegram settings + live toggle (card telegram-settings-toggle-20260816).
 *
 * Covers the three main-process helpers the settings surface leans on:
 *  - writeTelegramEnv: key-level .env.telegram edits (comments preserved,
 *    blank value removes the key) — the WRITE-ONLY path the UI uses so the
 *    token never crosses IPC back into the renderer;
 *  - telegramEnvSummary: non-secret state only (token existence, owner chat);
 *  - resolveTelegramRuntime: the pure on/off/start/stop/restart decision that
 *    makes telegram:setConfig take effect without an app restart — including
 *    the non-breaking default (enabled UNSET = on, exactly the pre-Settings
 *    "file presence is the switch" behaviour).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, dirname } = require('node:path');
const loadTs = require('./load-ts.cjs');

const { TelegramTrigger, writeTelegramEnv, telegramEnvSummary, resolveTelegramRuntime, readTelegramEnv } =
  loadTs('src/main/telegram.ts');

const envFile = () => join(mkdtempSync(join(tmpdir(), 'tg-')), '.env.telegram');

test('writeTelegramEnv: creates the file with the token when none exists', () => {
  const f = envFile();
  writeTelegramEnv(f, { TELEGRAM_BOT_TOKEN: '123:ABC' });
  assert.equal(readTelegramEnv(f).get('TELEGRAM_BOT_TOKEN'), '123:ABC');
  assert.equal(telegramEnvSummary(f).hasToken, true);
});

test('writeTelegramEnv: replaces keys, preserves comments and unrelated lines', () => {
  const f = envFile();
  writeFileSync(f, '# bot creds\nTELEGRAM_BOT_TOKEN=old\nSOME_OTHER=keep-me\n', 'utf8');
  writeTelegramEnv(f, { TELEGRAM_BOT_TOKEN: 'new' });
  const text = readFileSync(f, 'utf8');
  assert.match(text, /# bot creds/);
  assert.match(text, /SOME_OTHER=keep-me/);
  assert.doesNotMatch(text, /old/);
  assert.equal(readTelegramEnv(f).get('TELEGRAM_BOT_TOKEN'), 'new');
});

test('writeTelegramEnv: blank value REMOVES the key (chat-id clear → claim-on-start)', () => {
  const f = envFile();
  writeTelegramEnv(f, { TELEGRAM_BOT_TOKEN: '123:ABC', MD_TELEGRAM_CHAT_ID: '42' });
  writeTelegramEnv(f, { MD_TELEGRAM_CHAT_ID: '  ' });
  const env = readTelegramEnv(f);
  assert.equal(env.has('MD_TELEGRAM_CHAT_ID'), false);
  assert.equal(env.get('TELEGRAM_BOT_TOKEN'), '123:ABC'); // untouched
});

test('summary + parse stay consistent with the trigger’s claim-append path', () => {
  const f = envFile();
  writeFileSync(f, 'TELEGRAM_BOT_TOKEN=123:ABC\n', 'utf8');
  // handleUpdate claims a chat by APPENDING the key (last occurrence wins in
  // the parser, so an appended claim overrides any earlier line).
  require('node:fs').appendFileSync(f, '\nMD_TELEGRAM_CHAT_ID=98765\n');
  const s = telegramEnvSummary(f);
  assert.deepEqual(s, { hasToken: true, chatId: 98765 });
});

test('telegramEnvSummary: missing file → not configured, no owner', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'tg-')), 'nope.env');
  assert.deepEqual(telegramEnvSummary(f), { hasToken: false, chatId: null });
});

test('resolveTelegramRuntime: UNSET enabled with a token = run (non-breaking default)', () => {
  assert.equal(resolveTelegramRuntime(false, undefined, true, false), 'start');
  assert.equal(resolveTelegramRuntime(true, undefined, true, false), 'none');
});

test('resolveTelegramRuntime: explicit off stops a live poll loop', () => {
  assert.equal(resolveTelegramRuntime(true, false, true, false), 'stop');
  assert.equal(resolveTelegramRuntime(false, false, true, false), 'none');
});

test('resolveTelegramRuntime: on with no token never starts (and stops a tokenless runner)', () => {
  assert.equal(resolveTelegramRuntime(false, true, false, false), 'none');
  // token removed while running (writeTelegramEnv clear) → full stop
  assert.equal(resolveTelegramRuntime(true, true, false, true), 'stop');
});

test('resolveTelegramRuntime: edited credentials restart; pure toggle-on starts; no-op stays none', () => {
  assert.equal(resolveTelegramRuntime(true, true, true, true), 'restart');
  assert.equal(resolveTelegramRuntime(false, true, true, false), 'start');
  assert.equal(resolveTelegramRuntime(true, true, true, false), 'none');
});

/** The LIVE half of the toggle: the real TelegramTrigger poll loop (network
 *  mocked at fetch — no Electron, no api.telegram.org). Pins that off
 *  (stop()) halts getUpdates for good + cleans up the reply endpoint, and on
 *  (a fresh trigger, exactly what startTelegramServer builds) resumes polling —
 *  i.e. telegram:setConfig needs no app restart. */
test('TelegramTrigger: stop() halts polling + cleans up; restart resumes polling', async () => {
  const f = envFile();
  writeTelegramEnv(f, { TELEGRAM_BOT_TOKEN: 'test:token' });
  const replyConfigFile = join(dirname(f), 'telegram-reply.json');
  const realFetch = globalThis.fetch;
  let polls = 0;
  const mkResp = (body) => ({ ok: body.ok, json: async () => body });
  globalThis.fetch = (url, init) => {
    const method = /\/bot[^/]+\/(\w+)/.exec(String(url))?.[1] ?? '';
    if (method === 'getUpdates') {
      polls++;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(mkResp({ ok: true, result: [] })), 5);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
    }
    return Promise.resolve(mkResp(method === 'getMe'
      ? { ok: true, result: { username: 'testbot' } }
      : { ok: true }));
  };
  const quiet = { envFile: f, replyConfigFile, onMessage: () => {}, log: () => {} };
  try {
    // ON: start → polls.
    const t1 = new TelegramTrigger(quiet);
    assert.equal((await t1.start()).ok, true);
    assert.equal(existsSync(replyConfigFile), true, 'reply discovery file written while running');
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(polls >= 2, `expected several polls, saw ${polls}`);

    // OFF: stop() → polling ceases, discovery file removed.
    t1.stop();
    const n = polls;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(polls, n, `poll loop must stop after stop() (${polls - n} extra polls)`);
    assert.equal(existsSync(replyConfigFile), false, 'discovery file removed on stop');

    // ON again (restart path — a fresh instance, same env file): polling resumes.
    const t2 = new TelegramTrigger(quiet);
    assert.equal((await t2.start()).ok, true);
    const before = polls;
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(polls > before, 'polling must resume after restart');
    t2.stop();
  } finally {
    globalThis.fetch = realFetch;
  }
});
