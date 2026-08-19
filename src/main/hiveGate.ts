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

/** Quote-aware mask, same length as `s`: INERT shell prose becomes NUL, so
 *  pattern scans see only live shell syntax. Masked (inert): single- and
 *  double-quoted prose, and the escaped char of a `\x` pair (the backslash
 *  itself stays visible so `> tasks.json\ copy` is not aliased onto
 *  tasks.json). LIVE (unmasked): `$( )` and backtick bodies inside double
 *  quotes — command substitution EXECUTES there — and heredoc bodies, where
 *  quotes never open state and newlines still split (card
 *  agent-r3-gate-false-positive-q-2026-08-19 + cold-context review round:
 *  a naive quote mask let `"$(cat x > $HIVE_ROOT/tasks.json)"` smuggle a
 *  hand-edit through the primitive exemption). Unclosed quotes/substitutions
 *  swallow the rest as prose; the exec-position check still runs on it. */
function maskQuoted(s: string): string {
  const out = s.split('');
  const n = out.length;
  let quote: '"' | "'" | null = null;
  let sub = 0; // depth of $( opened inside double quotes — live
  let bt = false; // backtick body opened inside double quotes — live
  let heredoc: string | null = null; // pending heredoc terminator
  let hdTabs = false; // <<- : terminator may be tab-indented
  let body = false; // inside a heredoc body line — live, quotes never open
  for (let i = 0; i < n; i++) {
    const c = s[i] as string;
    if (body) {
      if (c === '\n') body = false;
      continue; // live
    }
    if (heredoc !== null && (i === 0 || (s[i - 1] as string) === '\n')) {
      const nl = s.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      let line = s.slice(i, end).replace(/\r$/, '');
      if (hdTabs) line = line.replace(/^\t+/, '');
      if (line === heredoc) {
        heredoc = null;
        i = end - 1; // land on the \n (or EOF); it stays live and splits
      } else {
        body = true;
      }
      continue;
    }
    if (quote === "'") {
      out[i] = '\0';
      if (c === "'") quote = null;
      continue;
    }
    if (c === '\\' && sub === 0 && !bt) {
      if (i + 1 < n) out[i + 1] = '\0';
      continue; // backslash itself stays visible
    }
    if (quote === '"') {
      if (sub > 0) {
        if (c === '(') sub++;
        else if (c === ')') sub--;
        continue; // live
      }
      if (bt) {
        if (c === '`') bt = false;
        continue; // live
      }
      if (c === '$' && (s[i + 1] as string) === '(') {
        sub = 1;
        i++; // the '(' is live too
        continue;
      }
      if (c === '`') {
        bt = true;
        continue;
      }
      out[i] = '\0';
      if (c === '"') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out[i] = '\0';
      continue;
    }
    if (c === '<' && (s[i + 1] as string) === '<') {
      let j = i + 2;
      hdTabs = false;
      if ((s[j] as string) === '-') {
        hdTabs = true;
        j++;
      }
      let q = '';
      if ((s[j] as string) === "'" || (s[j] as string) === '"') {
        q = s[j] as string;
        j++;
      }
      let delim = '';
      while (j < n && !/[\s'"]/.test(s[j] as string)) {
        delim += s[j];
        j++;
      }
      if (q && (s[j] as string) === q) j++;
      heredoc = delim || '\n'; // bare <<: only an empty line terminates
      i = j - 1;
    }
  }
  return out.join('');
}

/** Split a command line into pipeline/sequence segments, QUOTE-AWARE: a
 *  metacharacter inside quotes never splits (card agent-r3-gate-false-
 *  positive-q-2026-08-19 — `--notes "a|b … tasks.json"` used to fracture a
 *  legitimate primitive call and get it refused). Unclosed quotes swallow the
 *  rest as one segment; the exec-position check still runs on it. */
function segments(command: string): string[] {
  const mask = maskQuoted(command);
  const re = /&&|\|\||[;|\n]/g;
  const out: string[] = [];
  let last = 0;
  for (const m of mask.matchAll(re)) {
    out.push(command.slice(last, m.index));
    last = (m.index ?? 0) + m[0].length;
  }
  out.push(command.slice(last));
  return out;
}

/** Whitespace tokens of one segment, quote-stripped, $HIVE_ROOT expanded. */
function tokens(segment: string, hiveRoot: string): string[] {
  return segment
    .split(/[\s;,&|<>()`'"=]+/)
    .map((t) => expandRoot(t, hiveRoot))
    .filter(Boolean);
}

/** Quote-aware shell WORDS of a segment (whole-word wrapping quotes stripped,
 *  inner syntax kept raw). Feeds the exec-position test so a quoted
 *  `"$HIVE_ROOT/bin/hive-card|evil"` cannot tokenize into the primitive
 *  basename — the exact basename must match (review round, finding 5). */
function shellWords(segment: string): string[] {
  const words: string[] = [];
  let raw = '';
  let open: string | null = null;
  const push = () => {
    if (!raw) return;
    const q = raw[0] as string;
    if (
      raw.length > 1 &&
      (q === "'" || q === '"') &&
      raw.endsWith(q) &&
      !raw.slice(1, -1).includes(q)
    ) {
      raw = raw.slice(1, -1);
    }
    words.push(raw);
    raw = '';
  };
  for (const c of segment) {
    if (/\s/.test(c) && !open) {
      push();
    } else {
      if (open) {
        if (c === open) open = null;
      } else if (c === '"' || c === "'") {
        open = c;
      }
      raw += c;
    }
  }
  push();
  return words;
}

/** Is this segment an invocation of a bin/hive-* primitive? Covers direct
 *  calls (`…/bin/hive-card …`) and the bundled-node launcher
 *  (`"$HIVE_NODE" "$HIVE_ROOT/bin/hive-restart-window" …`). Works on
 *  quote-aware WORDS: env assignments and wrappers are skipped at word
 *  level, and the exec basename must match the primitive regex EXACTLY. */
function isPrimitiveSegment(words: string[]): boolean {
  let i = 0;
  while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i] ?? '')) i++;
  while (i < words.length && ['sudo', 'nohup', 'time', 'exec', 'command'].includes(words[i] ?? ''))
    i++;
  const exec = words[i] ?? null;
  if (!exec) return false;
  if (PRIMITIVE_RE.test(basename(exec))) return true;
  if (LAUNCHERS.has(basename(exec))) {
    const next = expandRoot(words[i + 1] ?? '', '');
    if (PRIMITIVE_RE.test(basename(next))) return true;
  }
  return false;
}

/** Redirect (`>` / `>>`) targets in a segment, QUOTE-AWARE: a `>` inside
 *  quotes is prose, not a redirect (same card as segments()). Scanned against
 *  the quote mask; NUL-masked chars end a capture, so a quoted target is not
 *  mistaken for a path (nor for a redirect). */
function redirectTargets(segment: string): string[] {
  const out: string[] = [];
  const re = />>?\s*([^\s;&|)\0]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(maskQuoted(segment)))) out.push(m[1] ?? '');
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
        "→ for paused/resume use `$HIVE_ROOT/bin/hive-card update <id> --paused|--resume` (god-only — the operator's hold)",
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

/** sh -c '<body>' — the body is a full command line; capture it RAW (with
 *  wrapping quotes stripped) so operators inside survive recursion. The old
 *  retokenize-and-join path dropped `>` and sequencing (review round,
 *  finding 4: `sh -c 'hive-card list > tasks.json'` sailed through). */
const SH_C =
  /(?:^|[\s;&|])(?:(?:sudo|nohup|time|exec|command)\s+)*(?:sh|bash|dash|zsh)(?:\s+-[a-zA-Z]+)*\s+-[a-zA-Z]*c[a-zA-Z]*\s*([\s\S]*)$/;

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
    const m = SH_C.exec(segment);
    if (m && m[1] !== undefined) {
      let body = m[1];
      const q = body[0] as string;
      if (body.length > 1 && (q === "'" || q === '"') && body.endsWith(q)) body = body.slice(1, -1);
      const inner = gateBash(body, hiveRoot, cwd);
      if (inner) return inner;
      continue;
    }
    if (isPrimitiveSegment(shellWords(segment))) continue; // the CLIs own these files
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
