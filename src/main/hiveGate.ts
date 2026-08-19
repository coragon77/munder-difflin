/**
 * Shared-state PreToolUse gate (card agent-pretooluse-hook-refuse-g-2026-08-19).
 *
 * Shared-state PreToolUse gate (card agent-pretooluse-hook-refuse-g-2026-08-19,
 * tightened by agent-hook-r3-refuse-all-non-p-2026-08-19).
 *
 * The operator's decision (2026-08-19): the harness must FORCE god through the
 * bin/hive-* primitives — no more hand-editing shared hive state. This module
 * decides, for one PreToolUse payload, whether the attempted Bash/Write/Edit
 * touches protected state WITHOUT going through a primitive, and if so returns
 * the refusal message naming the primitive to use instead. It is a HARD GATE
 * with deliberately NO override flag.
 *
 * R3 — an EVERYTHING-gate: ALL non-primitive access is refused, reads included.
 * Read-vs-write classification of heredoc bodies was the rot surface (god's
 * daily pattern is read-only python heredocs against tasks.json); refusing
 * everything leaves nothing to classify. Reads are pointed at hive-card list
 * (Meredith, 7cb1733); every gap becomes a carded list-filter extension —
 * which is the operator's stated policy, not a workaround.
 *
 * THE CENTRAL RULE — gate the COMMAND, not the file. The generated
 * `$HIVE_ROOT/bin/hive-*` CLIs write these exact files as subprocesses of
 * god's Bash tool, so a naive path block would refuse the primitives
 * themselves and brick the hive. A command whose exec-position token (or its
 * hive-node launcher argument) is a `hive-*` primitive is therefore exempt;
 * anything else that targets a protected path is refused.
 *
 * Protected (operator list): tasks.json, registry.json, fleet.json and the
 * vacation-requests/ spawn-requests/ fire-requests/ drop-dirs — all relative
 * to the hive root. NOT protected: board.md and god's memory.md (god is the
 * sole scribe there by design), anything under an agent's own dir.
 *
 * Pure logic — no electron, no fs — so tests load it directly. Scope (god
 * only) is enforced by the caller in HookServer, via hive.isGod().
 */

export interface SharedStateDenial {
  reason: string;
}

export interface SharedStateGateInput {
  toolName?: string;
  toolInput?: unknown;
  /** Absolute hive root (the dir holding tasks.json / bin/ …), or null. */
  hiveRoot: string | null;
  /** The session's cwd, when the engine reports it (resolves bare relative paths). */
  cwd?: string;
}

/** Files at the hive root that only the primitives/harness may write. */
const PROTECTED_FILES = ['tasks.json', 'registry.json', 'fleet.json'] as const;

/** CLI-owned drop-dirs. Their names are hive-global; any reference counts. */
const DROP_DIRS = ['vacation-requests', 'spawn-requests', 'fire-requests'] as const;

/** bin/hive-* primitives (and the bundled-node launcher that runs them). */
const PRIMITIVE_RE = /^hive-[a-z][a-z0-9-]*$/;
const LAUNCHERS = new Set(['hive-node', 'node', 'electron']);

const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? '';

const unquote = (t: string): string =>
  t
    .trim()
    .replace(/^[`'"]+/, '')
    .replace(/[`'"]+$/, '')
    .replace(/[,:;]+$/, '');

/** Expand $HIVE_ROOT / ${HIVE_ROOT} so token paths become absolute. */
function expandRoot(token: string, hiveRoot: string): string {
  const braced = '$' + '{HIVE_ROOT}'; // spelled out so lint doesn't see a placeholder
  return token.replaceAll(braced, hiveRoot).replaceAll('$HIVE_ROOT', hiveRoot);
}

/** Does this single path-ish token target protected hive state? */
export function isProtectedPath(rawToken: string, hiveRoot: string, cwd?: string): boolean {
  const token = expandRoot(unquote(String(rawToken)), hiveRoot);
  if (!token) return false;
  if (DROP_DIRS.some((d) => token.includes(d))) return true;
  for (const f of PROTECTED_FILES) {
    if (token === f) {
      // Bare basename: protected when god sits in the hive root (or cwd is
      // unknown — refuse-biased; tasks.json in god's life IS the shared one).
      if (!cwd) return true;
      try {
        return pathResolve(cwd) === pathResolve(hiveRoot);
      } catch {
        return true;
      }
    }
    const suffix = `/${f}`;
    if (token.endsWith(suffix)) {
      const dir = token.slice(0, token.length - suffix.length);
      try {
        return pathResolve(dir, cwd ?? hiveRoot) === pathResolve(hiveRoot);
      } catch {
        return false;
      }
    }
  }
  return false;
}

// path.resolve without importing node:path (keeps the module dependency-free
// for the renderer-adjacent bundler). Relative inputs resolve against `base`.
function pathResolve(p: string, base?: string): string {
  const joined = p.startsWith('/') ? p : `${base ?? '/'}${base ? '/' : ''}${p}`;
  const parts: string[] = [];
  for (const seg of joined.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join('/')}`;
}

/** Split a command line into pipeline/sequence segments. Over-eager on quoted
 *  operators — safe: it can only split a segment into MORE checked pieces. */
function segments(command: string): string[] {
  return command.split(/&&|\|\||[;|\n]/);
}

/** Whitespace tokens of one segment, quote-stripped, $HIVE_ROOT expanded. */
function tokens(segment: string, hiveRoot: string): string[] {
  return segment
    .split(/[\s;,&|<>()`'"=]+/)
    .map((t) => expandRoot(t, hiveRoot))
    .filter(Boolean);
}

/** The executable token of a segment: skips env assignments and wrappers. */
function execOf(toks: string[]): string | null {
  let i = 0;
  while (i < toks.length && /^[A-Za-z_]\w*=/.test(toks[i] ?? '')) i++;
  while (i < toks.length && ['sudo', 'nohup', 'time', 'exec', 'command'].includes(toks[i] ?? ''))
    i++;
  return toks[i] ?? null;
}

/** Is this segment an invocation of a bin/hive-* primitive? Covers direct
 *  calls (`…/bin/hive-card …`) and the bundled-node launcher
 *  (`"$HIVE_NODE" "$HIVE_ROOT/bin/hive-restart-window" …`). */
function isPrimitiveSegment(toks: string[]): boolean {
  const exec = execOf(toks);
  if (!exec) return false;
  if (PRIMITIVE_RE.test(basename(exec))) return true;
  if (LAUNCHERS.has(basename(exec))) {
    const next = toks[toks.indexOf(exec) + 1] ?? '';
    if (PRIMITIVE_RE.test(basename(next))) return true;
  }
  return false;
}

/** Redirect (`>` / `>>`) targets in a segment, quote-stripped. */
function redirectTargets(segment: string): string[] {
  const out: string[] = [];
  const re = />>?\s*([^\s;&|)'"]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment))) out.push(m[1] ?? '');
  return out;
}

/** The refusal message — the feature. Names the primitive for the attempted
 *  operation; says so explicitly when nothing covers it. R3 (card
 *  agent-hook-r3-refuse-all-non-p-2026-08-19): NO read-vs-write classification
 *  — everything non-primitive is refused, reads point at hive-card list. */
function refusalReason(target: string, context: string): string {
  const head =
    'REFUSED: shared hive state is primitive-owned — hand-access (reads AND writes) is banned outside the bin/hive-* primitives (operator decision 2026-08-19, no override exists).';
  const tail =
    'If no primitive covers this operation: MAIL THE OPERATOR and card a harness extension — do not hand-edit, and do not thrash retrying the refused command.';
  if (target.includes('tasks.json')) {
    const lines = [
      `${head} Use the card primitives instead:`,
      `- reads: \`$HIVE_ROOT/bin/hive-card list [--status <s>] [--assignee <id>] [--open]\` (paused always shown) — every gap in it is a carded list-filter extension, never a raw read`,
      `- todo→doing: \`$HIVE_ROOT/bin/hive-dispatch\` — the ONLY legal path (it enforces the paused/blocked holds)`,
      '- any other status change: `$HIVE_ROOT/bin/hive-card status <id> <status>`',
      '- assignee / title / notes / paused: `$HIVE_ROOT/bin/hive-card update <id> …`',
      '- humanQA entry: `$HIVE_ROOT/bin/hive-card ask`',
      '- removing done cards: `$HIVE_ROOT/bin/hive-card prune-done`',
      '- corrupt ledger (hand-repair attempt): `hive-card restore` — git-history-backed recovery (card agent-hive-card-restore-bound--2026-08-19)',
      tail,
    ];
    const ctx = context.toLowerCase();
    if (/paused|unpause|resume/.test(ctx))
      lines.splice(
        1,
        0,
        '→ for paused/resume use `$HIVE_ROOT/bin/hive-card update <id> --paused|--resume`',
      );
    else if (/assignee|owner/.test(ctx))
      lines.splice(
        1,
        0,
        '→ for assignee changes use `$HIVE_ROOT/bin/hive-card update <id> --assignee <agent>`',
      );
    return lines.join('\n');
  }
  if (target.includes('registry.json')) {
    return [
      head,
      'registry.json is owned by the harness (spawn/retire/vacation flows) and the hire CLIs (`hive-hire`, `hive-new`). No god-side primitive reads or writes it directly.',
      tail,
    ].join('\n');
  }
  if (target.includes('fleet.json')) {
    return [
      head,
      'fleet.json is written exclusively by the harness — the live roster line is AUTO-INJECTED into your context at session start and on every prompt (rosterContext); no primitive reads or writes fleet.json directly.',
      tail,
    ].join('\n');
  }
  if (target.includes('vacation-requests')) {
    return [
      head,
      'vacation-requests/ is a CLI-owned drop-dir. Park an agent with `$HIVE_ROOT/bin/hive-park`, recall with `$HIVE_ROOT/bin/hive-recall` — never hand-drop files.',
      tail,
    ].join('\n');
  }
  if (target.includes('spawn-requests')) {
    return [
      head,
      'spawn-requests/ is a CLI-owned drop-dir. Hire with `$HIVE_ROOT/bin/hive-hire` (it owns the spawn-request JSON and applies internDefaults) — never hand-drop files.',
      tail,
    ].join('\n');
  }
  if (target.includes('fire-requests')) {
    return [
      head,
      'fire-requests/ is a CLI-owned drop-dir. Fire with `$HIVE_ROOT/bin/hive-fire` <intern-id> — never hand-drop files.',
      tail,
    ].join('\n');
  }
  return [head, tail].join('\n');
}

/** Evaluate one Bash command string; returns the denial or null. */
function gateBash(command: string, hiveRoot: string, cwd?: string): SharedStateDenial | null {
  for (const segment of segments(command)) {
    // A redirect onto protected state is a hand-edit even from a reader
    // (`cat x > tasks.json`) — check targets before the reader allowlist.
    for (const target of redirectTargets(segment)) {
      if (isProtectedPath(target, hiveRoot, cwd)) {
        return { reason: refusalReason(target, segment) };
      }
    }
    const toks = tokens(segment, hiveRoot);
    if (toks.length === 0) continue;
    const exec = execOf(toks);
    if (exec && ['sh', 'bash', 'dash', 'zsh'].includes(basename(exec))) {
      // sh -c '<body>' — evaluate the body, not the shell.
      const rest = toks.slice(toks.indexOf(exec) + 1);
      if (rest[0] === '-c' && rest.length > 1) {
        const inner = gateBash(rest.slice(1).join(' '), hiveRoot, cwd);
        if (inner) return inner;
        continue;
      }
    }
    if (isPrimitiveSegment(toks)) continue; // the CLIs own these files
    const hit = toks.find((t) => isProtectedPath(t, hiveRoot, cwd));
    if (!hit) continue;
    return { reason: refusalReason(hit, segment) };
  }
  return null;
}

/**
 * The gate. Returns a denial (with the primitive-naming reason) when the
 * tool call is a hand-edit of protected shared hive state, else null.
 */
export function sharedStateGate(input: SharedStateGateInput): SharedStateDenial | null {
  const { toolName, toolInput, hiveRoot, cwd } = input;
  if (!hiveRoot || !toolName) return null;
  const tool = toolName.toLowerCase();
  const ti = (toolInput ?? {}) as Record<string, unknown>;
  if (tool === 'bash') {
    const command = ti.command;
    if (typeof command !== 'string' || !command) return null;
    return gateBash(command, hiveRoot, cwd);
  }
  if (tool === 'write' || tool === 'edit') {
    const filePath = typeof ti.file_path === 'string' ? ti.file_path : ti.path;
    if (typeof filePath !== 'string' || !filePath) return null;
    if (isProtectedPath(expandRoot(filePath, hiveRoot), hiveRoot, cwd)) {
      return { reason: refusalReason(filePath, filePath) };
    }
  }
  return null;
}
