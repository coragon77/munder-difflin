/**
 * Engine-neutral HIDDEN one-shot helpers (standup clerk, memory condenser).
 *
 * Every hidden helper used to hardcode the claude binary through
 * `runHiddenClaude` — an Anthropic API outage took the whole helper layer
 * down with it. This module resolves ONE helper engine for all of them and
 * dispatches on it:
 *
 *   claude → runHiddenClaude (the existing PTY machinery, unchanged)
 *   pi     → runHiddenPi (plain headless `pi -p` — no PTY boot dance, no
 *            transcript scraping: stdout IS the answer)
 *
 * Resolution (testable, pure):
 *   provider: helperDefaults.provider > godProvider > 'claude'
 *   model:    helperDefaults.model > claude's haiku-class helper constant >
 *             undefined (the CLI's own default — pi gets NO --model flag,
 *             whatever the operator's pi config says; pin one in Settings)
 *   command:  claude honors config.defaultCommand (today's behavior);
 *             other providers use their preset's defaultCommand.
 *
 * ponytail: other providers (codex/gemini/…) are REFUSED loudly, not
 * approximated — each needs its own headless dialect and call sites already
 * have deterministic fallbacks (clerk facts / condense-abort). Add a branch
 * here when one is actually needed.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  CLAUDE_HELPER_MODEL,
  isClaudeProvider,
  normalizeAgentProvider,
  providerPreset,
  type AgentProvider,
} from '../shared/agentProvider';
import { expandTilde } from './fs';
import { ensureKilled } from './procKill';
import { resolveCommand, userShellPath } from './shellEnv';

/** The config slice the resolver needs — keeps it test-pure. */
export interface HelperEngineConfig {
  defaultCommand?: string;
  godProvider?: AgentProvider;
  helperDefaults?: { provider?: AgentProvider; model?: string };
}

export interface ResolvedHelperEngine {
  provider: AgentProvider;
  model?: string;
  command: string;
}

export function resolveHelperEngine(cfg: HelperEngineConfig): ResolvedHelperEngine {
  // normalizeAgentProvider: an unknown/blank stored provider is UNSET, never a
  // broken spawn (same defense as every other config read).
  const pick = normalizeAgentProvider(cfg.helperDefaults?.provider);
  const provider = pick ?? cfg.godProvider ?? 'claude';
  const model = cfg.helperDefaults?.model?.trim() || undefined;
  const command = isClaudeProvider(provider)
    ? cfg.defaultCommand?.trim() || 'claude'
    : (providerPreset(provider).defaultCommand ?? 'claude');
  return {
    provider,
    model: model ?? (isClaudeProvider(provider) ? CLAUDE_HELPER_MODEL : undefined),
    command,
  };
}

/** pi headless argv — pure so tests pin the contract. Prompt stays ONE argv
 *  element (spawn without a shell never re-splits it). */
export function piHelperArgs(model: string | undefined, prompt: string): string[] {
  return [
    '-p',
    '--no-tools',
    '--no-session',
    '--mode',
    'text',
    ...(model ? ['--model', model] : []),
    prompt,
  ];
}

/** Headless `pi -p` one-shot: stdout is the answer. */
export function runHiddenPi(
  prompt: string,
  opts: {
    engine: ResolvedHelperEngine;
    cwd: string;
    timeoutMs?: number;
    env?: Record<string, string>;
  },
): Promise<{ ok: boolean; text?: string; error?: string }> {
  return new Promise((resolve) => {
    if (!prompt.trim()) {
      resolve({ ok: false, error: 'empty prompt' });
      return;
    }
    const cwd = opts.cwd ? expandTilde(opts.cwd) : opts.cwd;
    if (!cwd || !existsSync(cwd)) {
      resolve({ ok: false, error: `cwd does not exist: ${opts.cwd}` });
      return;
    }
    const binary = opts.engine.command.trim().split(/\s+/)[0] || 'pi';
    const exe = resolveCommand(binary);
    const args = piHelperArgs(opts.engine.model, prompt);
    const timeoutMs = opts.timeoutMs ?? 180_000;
    // Windows: npm's extensionless/`.cmd` shims can't be spawned directly
    // (#22, same wrap as hiddenClaude).
    const winWrap = process.platform === 'win32' && !/\.(exe|com)$/i.test(exe);
    const spawnFile = winWrap ? process.env.ComSpec || 'cmd.exe' : exe;
    const spawnArgs = winWrap ? ['/c', exe, ...args] : args;

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(spawnFile, spawnArgs, {
        cwd,
        // stdin IGNORED: pi -p reads stdin when it's a non-TTY pipe and waits
        // for EOF — an open pipe hangs the one-shot forever (reproduced live:
        // prompt-on-argv + never-closing stdin = timeout). The prompt rides argv.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: userShellPath(),
          ...(providerPreset('pi').nonInteractiveEnv ?? {}),
          ...(opts.env ?? {}),
        } as Record<string, string>,
      });
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      const pid = proc.pid;
      try {
        proc.kill();
      } catch {
        /* noop */
      }
      if (pid) ensureKilled(pid);
    }, timeoutMs);

    const finish = (r: { ok: boolean; text?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', (e) => finish({ ok: false, error: e.message }));
    proc.on('close', (code) => {
      if (timedOut) {
        finish({ ok: false, error: 'hidden pi session timed out' });
        return;
      }
      const text = stdout.trim();
      if (code === 0 && text) finish({ ok: true, text });
      else
        finish({
          ok: false,
          error: stderr.trim().slice(-400) || `pi exited with code ${code} and no output`,
        });
    });
  });
}

/** Shared options for the dispatch. `disallowedTools`/`env` only reach the
 *  claude branch (pi runs --no-tools); the engine comes from
 *  resolveHelperEngine so call sites stay one-liners. */
export interface HiddenHelperOptions {
  engine: ResolvedHelperEngine;
  cwd: string;
  /** claude-only: tool denies (the AskUserQuestion rule etc.). */
  disallowedTools?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** Dispatch every hidden helper through the resolved engine. */
export async function runHiddenHelper(
  prompt: string,
  opts: HiddenHelperOptions,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (isClaudeProvider(opts.engine.provider)) {
    // Lazy import: hiddenClaude pulls node-pty (Electron ABI) — keep it out of
    // this module's load graph so tests and non-claude runs never touch it.
    const { runHiddenClaude } = await import('./hiddenClaude');
    return runHiddenClaude(prompt, {
      model: opts.engine.model ?? CLAUDE_HELPER_MODEL,
      cwd: opts.cwd,
      command: opts.engine.command,
      disallowedTools: opts.disallowedTools,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
    });
  }
  if (opts.engine.provider === 'pi') return runHiddenPi(prompt, opts);
  return {
    ok: false,
    error: `hidden helpers support claude and pi, not '${opts.engine.provider}' — pick one in Settings`,
  };
}
