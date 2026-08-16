/**
 * TelegramTrigger — talk to the hive from your phone, no Slack, no tunnel.
 *
 * Long-polls `getUpdates` with the bot token, so the machine dials OUT and
 * nothing listens publicly — no tunnelmole, no port, no signature dance (the
 * poll channel is authenticated by the token itself). Mirrors the Slack
 * trigger's role: inbound text is handed to `onMessage` for Michael's queue;
 * replies flow back through the same chat.
 *
 * SECURITY MODEL (mirrors slack.ts):
 *   - the bot token is read from `.env.telegram` and NEVER leaves this class —
 *     not in prompts, not in agent env, not in logs, not in config.json (the
 *     renderer-visible settings store); Settings edits it WRITE-ONLY through
 *     `writeTelegramEnv` — the value never crosses IPC back to the renderer;
 *   - inbound is allowlisted to ONE chat id (`MD_TELEGRAM_CHAT_ID` in the same
 *     env file). If unset, the FIRST chat to send `/start` claims ownership and
 *     the id is persisted back to the file — every other chat is dropped
 *     silently. Claim-once: keep the bot username private until claimed;
 *   - outbound for AGENTS goes through a loopback-only reply endpoint
 *     (127.0.0.1, random port, bearer token in a userData discovery file) so an
 *     agent can post to THE ONE chat without ever seeing the bot token.
 *
 * Runs in the Electron main process; free of `electron` imports so it can be
 * tested as a plain Node module, same as slack.ts / webhook.ts.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

export interface TelegramInboundMessage {
  /** Chat the message came from (always the allowlisted owner chat). */
  chatId: number;
  /** Message text (empty string for non-text updates, which are skipped). */
  text: string;
}

export interface TelegramTriggerOptions {
  /** Absolute path to the env file holding TELEGRAM_BOT_TOKEN (+ MD_TELEGRAM_CHAT_ID). */
  envFile: string;
  /** userData path for the reply-endpoint discovery file ({ port, token }). */
  replyConfigFile: string;
  /** Verified inbound message (owner chat only) → Michael's queue. */
  onMessage: (m: TelegramInboundMessage) => void | Promise<void>;
  /** Optional log sink (main passes console.log-style). */
  log?: (...args: unknown[]) => void;
}

interface TgUpdate {
  update_id: number;
  message?: { chat?: { id?: number }; text?: string };
}

/** Parse `KEY=value` lines from a `.env.telegram`-style file. Exported for
 *  tests and the settings plumbing; tolerant of missing files (empty map). */
export function readTelegramEnv(envFile: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0 && !line.trimStart().startsWith('#')) {
        out.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
      }
    }
  } catch {
    /* missing file → empty map */
  }
  return out;
}

/** Non-secret summary of the env file for IPC (`telegram:status`): whether a
 *  token exists and which chat (if any) owns the hive. The token VALUE never
 *  crosses this boundary — that is the whole point of the shape. */
export function telegramEnvSummary(envFile: string): { hasToken: boolean; chatId: number | null } {
  const env = readTelegramEnv(envFile);
  const claimed = env.get('MD_TELEGRAM_CHAT_ID');
  return { hasToken: !!env.get('TELEGRAM_BOT_TOKEN'), chatId: claimed ? Number(claimed) : null };
}

/** Key-level edit of `.env.telegram`, preserving every other line (comments
 *  included). A blank/null value REMOVES the key — that is how Settings clears
 *  the chat id (back to claim-on-first-/start). Written by the settings IPC so
 *  the token can be edited without ever being read back into the renderer. */
export function writeTelegramEnv(
  envFile: string,
  patch: { TELEGRAM_BOT_TOKEN?: string | null; MD_TELEGRAM_CHAT_ID?: string | null },
): void {
  const lines = existsSync(envFile) ? readFileSync(envFile, 'utf8').split('\n') : [];
  for (const [key, value] of Object.entries(patch)) {
    const wanted = typeof value === 'string' && value.trim() ? value.trim() : null;
    let done = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trimStart().startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0 || line.slice(0, eq).trim() !== key) continue;
      if (wanted === null) lines.splice(i--, 1);
      else lines[i] = `${key}=${wanted}`;
      done = true;
    }
    if (!done && wanted !== null) lines.push(`${key}=${wanted}`);
  }
  // Trim a trailing blank-run so repeated claim-appends (handleUpdate appends
  // `MD_TELEGRAM_CHAT_ID=...` directly) don't accumulate empty lines.
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  writeFileSync(envFile, lines.length ? lines.join('\n') + '\n' : '');
}

/** Pure toggle/start/stop decision for the settings IPC + boot path. `enabled`
 *  is the RAW config value: undefined = enabled, exactly the pre-Settings
 *  behaviour (env file present ⇒ feature on — non-breaking default). Returns
 *  what the caller should do with the trigger so `telegram:setConfig` takes
 *  effect live, with no app restart. */
export function resolveTelegramRuntime(
  running: boolean,
  enabled: boolean | undefined,
  hasToken: boolean,
  envChanged: boolean,
): 'start' | 'stop' | 'restart' | 'none' {
  const wantsRun = (enabled ?? true) && hasToken;
  if (!wantsRun) return running ? 'stop' : 'none';
  if (!running) return 'start';
  return envChanged ? 'restart' : 'none';
}

const log = (...a: unknown[]) => console.log('[telegram]', ...a);

export class TelegramTrigger {
  private readonly opts: TelegramTriggerOptions;
  private token = '';
  private chatId: number | null = null;
  private offset = 0;
  private running = false;
  private abort: AbortController | null = null;
  private replyServer: Server | null = null;
  private replyToken = '';
  private replyPort = 0;

  constructor(opts: TelegramTriggerOptions) {
    this.opts = opts;
  }

  /** Parse `KEY=value` lines from the env file (no shell semantics needed). */
  private readEnv(): Map<string, string> {
    return readTelegramEnv(this.opts.envFile);
  }

  private api(
    method: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; result?: unknown; description?: string }> {
    return fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal,
    }).then((r) => r.json());
  }

  /** True when the env file carries a bot token (i.e. the feature is on). */
  isConfigured(): boolean {
    return !!this.readEnv().get('TELEGRAM_BOT_TOKEN');
  }

  async start(): Promise<{ ok: boolean; error?: string }> {
    const env = this.readEnv();
    this.token = env.get('TELEGRAM_BOT_TOKEN') ?? '';
    if (!this.token) return { ok: false, error: 'no TELEGRAM_BOT_TOKEN in ' + this.opts.envFile };
    const claimed = env.get('MD_TELEGRAM_CHAT_ID');
    this.chatId = claimed ? Number(claimed) : null;

    const me = await this.api('getMe');
    if (!me.ok) return { ok: false, error: 'token rejected: ' + (me.description ?? 'unknown') };
    log('bot ok:', (me.result as { username?: string })?.username ?? '(unnamed)');

    // Drop any stale queue before polling so old messages don't flood in.
    await this.api('deleteWebhook', { drop_pending_updates: true }).catch(() => undefined);

    await this.startReplyEndpoint();
    this.running = true;
    void this.pollLoop();
    return { ok: true };
  }

  /** The long-poll loop. Errors back off 5s; `stop()` aborts the in-flight poll. */
  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const res = await this.api(
          'getUpdates',
          {
            offset: this.offset,
            timeout: 25,
            allowed_updates: ['message'],
          },
          this.abort?.signal,
        );
        if (!this.running) return;
        if (!res.ok) throw new Error(res.description ?? 'getUpdates failed');
        for (const u of (res.result as TgUpdate[]) ?? []) {
          this.offset = u.update_id + 1;
          this.handleUpdate(u);
        }
      } catch (e) {
        if (!this.running || (e as Error).name === 'AbortError') return;
        log('poll error, retrying in 5s:', (e as Error).message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private handleUpdate(u: TgUpdate): void {
    const chat = u.message?.chat?.id;
    const text = (u.message?.text ?? '').trim();
    if (!chat || !text) return;
    if (this.chatId === null) {
      // Claim-once: the first chat to say /start owns this hive forever.
      if (text !== '/start') return;
      this.chatId = chat;
      try {
        appendFileSync(this.opts.envFile, `\nMD_TELEGRAM_CHAT_ID=${chat}\n`);
      } catch (e) {
        log('could not persist chat id:', e);
      }
      log('chat claimed:', chat);
      void this.sendText(
        '✅ This chat now owns the hive. Messages here go to Michael; replies come back in this chat.',
      );
      return;
    }
    if (chat !== this.chatId) return; // silent drop — no enumeration signal
    log('inbound from owner chat:', text.slice(0, 80));
    void Promise.resolve(this.opts.onMessage({ chatId: chat, text })).catch((e) =>
      log('onMessage failed:', e),
    );
  }

  /** Outbound: post to the owned chat (bot token stays here). */
  async sendText(text: string): Promise<boolean> {
    if (!this.chatId) return false;
    try {
      const r = await this.api('sendMessage', { chat_id: this.chatId, text });
      return !!r.ok;
    } catch {
      return false;
    }
  }

  /** Loopback reply endpoint for agents: POST /reply + x-md-reply-token → sendText.
   *  Never tunneled, never public — same trust shape as SlackReplyServer. */
  private startReplyEndpoint(): Promise<void> {
    return new Promise((resolve) => {
      this.replyToken = randomBytes(24).toString('hex');
      const ok = (res: ServerResponse, code: number, body: Record<string, unknown>) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      this.replyServer = createServer((req: IncomingMessage, res: ServerResponse) => {
        const auth = (req.headers['x-md-reply-token'] ?? '') as string;
        const a = Buffer.from(auth);
        const b = Buffer.from(this.replyToken);
        const good = a.length === b.length && timingSafeEqual(a, b);
        if (req.method !== 'POST' || req.url !== '/reply' || !good)
          return ok(res, 403, { ok: false, error: 'forbidden' });
        let buf = '';
        req.on('data', (c) => {
          buf += c;
          if (buf.length > 16384) req.destroy();
        });
        req.on('end', () => {
          try {
            const { text } = JSON.parse(buf) as { text?: string };
            if (typeof text !== 'string' || !text.trim())
              return ok(res, 400, { ok: false, error: 'text required' });
            void this.sendText(text).then((sent) =>
              ok(res, sent ? 200 : 502, sent ? { ok: true } : { ok: false, error: 'send failed' }),
            );
          } catch {
            ok(res, 400, { ok: false, error: 'bad json' });
          }
        });
      });
      this.replyServer.listen(0, '127.0.0.1', () => {
        const addr = this.replyServer!.address();
        this.replyPort = typeof addr === 'object' && addr ? addr.port : 0;
        try {
          writeFileSync(
            this.opts.replyConfigFile,
            JSON.stringify({ port: this.replyPort, token: this.replyToken }),
          );
          log('reply endpoint on 127.0.0.1:' + this.replyPort);
        } catch (e) {
          log('could not write discovery file:', e);
        }
        resolve();
      });
    });
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
    this.abort = null;
    this.replyServer?.close();
    this.replyServer = null;
    try {
      if (existsSync(this.opts.replyConfigFile)) unlinkSync(this.opts.replyConfigFile);
    } catch {
      /* best-effort */
    }
  }
}
