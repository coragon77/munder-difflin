/**
 * Access-time orient gate — Card B, the orient-first BACKSTOP (card
 * agent-harness-b-access-time-or-2026-08-20, spec docs/superpowers/specs/
 * 2026-08-20-access-time-orient-gate.md).
 *
 * Card A injects ORIENT FIRST at dispatch time — it cannot see directories
 * the agent discovers MID-TASK (a grep hit, a path in a mail body, `psql -d
 * merlin_hlog`). B closes that hole at the ACCESS boundary: a PreToolUse
 * gate that, when a tool call resolves into a directory subtree carrying a
 * CLAUDE.md/AGENTS.md this session has not yet read, refuses ONCE with a
 * pointer naming the file, records the root, and passes every later call
 * into it. Record-BEFORE-deny makes the agent's verbatim retry pass — the
 * gate never refuses the same (agent, session, root) twice.
 *
 * Detection and render are REUSED from Card A: one orientationBlock() call
 * (assigneeCwd '' — B exempts the session cwd via §6 instead), roots parsed
 * back out of the rendered bullet lines (BULLET_RE, deliberate render
 * coupling, tripwired by acceptance case 16) and reused VERBATIM in the
 * refusal. No resolveOrientRoot refactor, no second walker — Robert's call.
 *
 * Pure logic — no electron, no fs — the hiveGate house pattern: hooks.ts
 * supplies existsSync as the probe, the per-agent seen-state Map, and the
 * lazy registry context. FAIL OPEN is non-negotiable: any error inside the
 * decide path returns pass — a broken gate must never block a tool call.
 */

import { orientationBlock } from './orientInject';
import { isPrimitiveInvocation, shCParts, maskQuoted, redirectTargets } from './hiveGate';

/** Seen-state for one agent: keyed on the payload session_id, REPLACED on
 *  session change, never persisted — a restart refires once per root by
 *  design (spec §5: stale state rots; one self-healing refusal doesn't). */
export interface OrientSessionState {
  sessionKey: string;
  roots: Set<string>;
}

export interface OrientGateResult {
  /** The refusal reason, or null for pass. */
  deny: string | null;
  /** The (possibly new/replaced) seen-state — always store it back. */
  state: OrientSessionState;
}

export interface OrientGateInput {
  toolName?: string;
  toolInput?: unknown;
  /** Payload session_id; absent → 'proc' (once per agent per harness run). */
  sessionId?: string;
  /** The payload's cwd ('' when the engine sends none). */
  sessionCwd?: string;
  /** Registry facts, LAZY: only called once detection actually runs, so the
   *  overwhelming inside-cwd majority of calls costs one startsWith (spec §9). */
  context?: () => { sessionCwd: string; provider: string; registryCwds: string[] };
  probe: (p: string) => boolean;
}

/** Per-tool searchText extraction is a field ALLOWLIST — never
 *  JSON.stringify(tool_input): Edit content fields quote foreign paths and
 *  would over-fire (spec §4). */
function extractSearchText(tool: string, toolInput: unknown): string | null {
  const ti = (toolInput && typeof toolInput === 'object' ? toolInput : {}) as Record<
    string,
    unknown
  >;
  if (tool === 'read' || tool === 'edit') {
    const p = typeof ti.file_path === 'string' ? ti.file_path : ti.path; // pi naming
    return typeof p === 'string' && p ? p : null;
  }
  if (tool === 'grep' || tool === 'glob') {
    // Absent path defaults to cwd → exempt by construction → pass.
    return typeof ti.path === 'string' && ti.path ? ti.path : null;
  }
  if (tool === 'bash') {
    const c = ti.command;
    return typeof c === 'string' && c ? c.slice(0, 32 * 1024) : null;
  }
  return null; // Write/NotebookEdit/anything else: deliberately not gated
}

const norm = (p: string): string => {
  let s = p.trim();
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
};

const basenameOf = (p: string): string => p.split('/').pop() ?? '';
const dirOf = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
};

/** Is `path` inside-or-equal to the `cwd` subtree (one startsWith, spec §6). */
function insideCwd(path: string, cwd: string): boolean {
  if (!cwd) return false;
  return path === cwd || path.indexOf(cwd + '/') === 0;
}

/** Parse contract with Card A's render: bullet lines of orientationBlock
 *  (spec §3). Tripwired by acceptance case 16 against the REAL renderer. */
export const BULLET_RE = /^- (\/.+?): read (?:CLAUDE|AGENTS)\.md first/;

/** Bash narrowing (card agent-orient-gate-fires-on-cal-2026-08-21): the
 *  command string is PROSE-CARRYING — a project path or name inside a
 *  --body/--reason/--notes value (or a heredoc-fed stdin contract) is a
 *  mention, not an access (observed 2026-08-21: hive-park refused via the
 *  parked agent's registered cwd, hive-dispatch refused via contract-body
 *  prose). Split the command QUOTE-AWARE and exempt every segment that IS
 *  a hive-* primitive invocation — lifecycle primitives operate ON agents
 *  and hive state, never IN a work directory. But the exemption covers only
 *  the primitive's own words: real shell work hiding in the segment —
 *  background `&` splits, `<`/`>` redirects, and live $( )/backtick bodies
 *  (which the shell executes even inside double quotes) — is extracted and
 *  scanned (cold-context review round: wholesale segment drops let
 *  `hive-card list & cat <project>` through). Non-primitive segments are
 *  scanned exactly as before (joined with '\n'); sh -c bodies recurse, and
 *  the text BEFORE an unanchored sh -c match is scanned too. Returns '' when
 *  nothing scannable remains. */
function splitCommand(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: "'" | '"' | null = null;
  let sub = 0; // $( depth inside double quotes — live, but kept with its segment
  let bt = false; // backtick span inside double quotes — same
  const n = command.length;
  let i = 0;
  const push = (): void => {
    out.push(cur);
    cur = '';
  };
  while (i < n) {
    const c = command[i] as string;
    if (quote === null && c === "'") {
      quote = "'";
      cur += c;
      i++;
      continue;
    }
    if (quote === "'") {
      if (c === "'") quote = null;
      cur += c;
      i++;
      continue;
    }
    if (c === '\\' && sub === 0 && !bt) {
      cur += c + (command[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (quote === '"') {
      if (sub === 0 && !bt && c === '$' && command[i + 1] === '(') {
        sub = 1;
        cur += c + (command[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (sub > 0) {
        if (c === '(') sub++;
        else if (c === ')') sub--;
        cur += c;
        i++;
        continue;
      }
      if (bt) {
        if (c === '`') bt = false;
        cur += c;
        i++;
        continue;
      }
      if (c === '`') {
        bt = true;
        cur += c;
        i++;
        continue;
      }
      if (c === '"') quote = null; // closing quote (after sub/bt: mirror maskQuoted)
      cur += c;
      i++;
      continue;
    }
    if (c === '"') {
      quote = '"';
      cur += c;
      i++;
      continue;
    }
    // Unquoted live shell — heredocs first: the introducer AND every body
    // line stay with this segment (a heredoc-fed --body/stdin contract is
    // prose, not commands; maskQuoted keeps bodies live, segments() splits
    // them — here they belong to the primitive that reads them).
    if (c === '<' && command[i + 1] === '<') {
      let j = i + 2;
      let hdTabs = false;
      if (command[j] === '-') {
        hdTabs = true;
        j++;
      }
      let q = '';
      if (command[j] === "'" || command[j] === '"') {
        q = command[j] as string;
        j++;
      }
      let delim = '';
      while (j < n && !/[\s'"]/.test(command[j] ?? '')) {
        delim += command[j];
        j++;
      }
      if (q && command[j] === q) j++;
      cur += command.slice(i, j);
      i = j;
      const nl = command.indexOf('\n', i);
      cur += command.slice(i, nl === -1 ? n : nl + 1);
      i = nl === -1 ? n : nl + 1;
      const term = delim || '\n';
      while (i < n) {
        const nl2 = command.indexOf('\n', i);
        const end2 = nl2 === -1 ? n : nl2;
        let line = command.slice(i, end2).replace(/\r$/, '');
        if (hdTabs) line = line.replace(/^\t+/, '');
        if (line === term) {
          cur += command.slice(i, nl2 === -1 ? n : nl2 + 1);
          i = nl2 === -1 ? n : nl2 + 1;
          break;
        }
        if (nl2 === -1) {
          cur += command.slice(i, n); // unclosed heredoc swallows the rest
          i = n;
          break;
        }
        cur += command.slice(i, nl2 + 1);
        i = nl2 + 1;
      }
      continue;
    }
    if (c === ';' || c === '\n') {
      push();
      i++;
      continue;
    }
    if (c === '&' || c === '|') {
      const pair = c + (command[i + 1] ?? '');
      i += pair === '&&' || pair === '||' ? 2 : 1;
      push(); // single & (background) splits too — its right half is a real command
      continue;
    }
    cur += c;
    i++;
  }
  push();
  return out;
}

/** Real shell work hiding inside an (exempt) primitive segment, extracted
 *  from the QUOTE MASK so only live syntax counts: `>`/`>>` targets, `<`
 *  sources, and live `$( … )` / backtick bodies (executed even inside double
 *  quotes; single-quoted ones are NUL-masked and rightly ignored). Each part
 *  is a command line or a bare path — fed back through the scan. */
function primitiveExtras(segment: string): string[] {
  const parts: string[] = [];
  const mask = maskQuoted(segment);
  for (const t of redirectTargets(segment)) parts.push(t);
  const lt = /(?<!<)<(?!<)\s*([^\s;&|)\0]+)/g; // single '<': not <<, not <<<
  let m: RegExpExecArray | null;
  while ((m = lt.exec(mask))) parts.push(m[1] ?? '');
  let depth = 0;
  let start = -1;
  for (let k = 0; k < mask.length; k++) {
    const ch = mask[k] as string;
    if (depth === 0 && ch === '$' && mask[k + 1] === '(') {
      start = k;
      depth = 1;
      k++;
      continue;
    }
    if (depth > 0) {
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0 && start !== -1) {
          parts.push(segment.slice(start + 2, k));
          start = -1;
        }
      }
    }
  }
  let btStart = -1;
  for (let k = 0; k < mask.length; k++) {
    if ((mask[k] as string) !== '`') continue;
    if (btStart === -1) btStart = k;
    else {
      parts.push(segment.slice(btStart + 1, k));
      btStart = -1;
    }
  }
  return parts;
}

function scanNonPrimitiveBash(command: string): string {
  const keep: string[] = [];
  for (const segment of splitCommand(command)) {
    const sc = shCParts(segment);
    if (sc) {
      if (sc.prefix.trim()) keep.push(sc.prefix);
      const inner = scanNonPrimitiveBash(sc.body);
      if (inner) keep.push(inner);
      continue;
    }
    if (isPrimitiveInvocation(segment)) {
      for (const extra of primitiveExtras(segment)) {
        const inner = scanNonPrimitiveBash(extra);
        if (inner) keep.push(inner);
      }
      continue;
    }
    keep.push(segment);
  }
  return keep.join('\n');
}

/**
 * The gate. Returns the denial (or null) plus the seen-state to store.
 * Flow (spec §7): extract → orientationBlock → parse → drop seen and
 * cwd-exempt roots → none left: pass → else record ALL fresh roots FIRST,
 * then deny once naming all of them.
 */
export function orientGate(
  prev: OrientSessionState | null | undefined,
  input: OrientGateInput,
): OrientGateResult {
  const sessionKey =
    typeof input.sessionId === 'string' && input.sessionId ? input.sessionId : 'proc';
  // Session change REPLACES the entry (old set dropped) — /new, /clear, or a
  // fresh engine session starts unoriented (spec §5).
  const state: OrientSessionState =
    prev && prev.sessionKey === sessionKey ? prev : { sessionKey, roots: new Set<string>() };
  const pass = (): OrientGateResult => ({ deny: null, state });

  try {
    const tool = String(input.toolName ?? '')
      .trim()
      .toLowerCase();
    if (tool !== 'read' && tool !== 'edit' && tool !== 'grep' && tool !== 'glob' && tool !== 'bash')
      return pass();
    let searchText = extractSearchText(tool, input.toolInput);
    if (!searchText) return pass();

    let cwd = norm(typeof input.sessionCwd === 'string' ? input.sessionCwd : '');

    // Voluntary orienters get a free pass: reading a docs file marks its
    // directory seen and passes unconditionally — this also kills the
    // deny-of-the-pointer deadlock (spec §5(b)).
    if (
      tool === 'read' &&
      (basenameOf(searchText) === 'CLAUDE.md' || basenameOf(searchText) === 'AGENTS.md')
    ) {
      if (searchText.startsWith('/')) {
        const dir = norm(dirOf(searchText));
        if (dir !== '/') state.roots.add(dir); // '/' can never be a rendered root
      } else if (cwd) state.roots.add(cwd);
      return pass();
    }

    const isPathTool = tool !== 'bash';
    if (isPathTool) {
      // Relative paths resolve against the session cwd → inside by
      // construction; engines' own nested-discovery covers roots under cwd.
      if (!searchText.startsWith('/')) return pass();
      if (insideCwd(norm(searchText), cwd)) return pass(); // fast path (spec §6)
    } else {
      // Bash: quoted prose is a mention, not an access — scan only the
      // non-primitive segments (the fast path above never ran for bash).
      searchText = scanNonPrimitiveBash(searchText);
      if (!searchText) return pass();
    }

    // Detection actually runs — pull the lazy registry context.
    const ctx = input.context
      ? input.context()
      : { sessionCwd: '', provider: '', registryCwds: [] as string[] };
    if (!cwd) cwd = norm(ctx.sessionCwd ?? '');
    if (isPathTool && cwd && insideCwd(norm(searchText), cwd)) return pass();

    const block = orientationBlock(
      searchText,
      '',
      ctx.provider ?? '',
      ctx.registryCwds ?? [],
      input.probe,
    );
    if (!block) return pass(); // fail open: no roots (or an internal catch)

    const fresh: Array<{ root: string; line: string }> = [];
    for (const line of block.split('\n')) {
      const m = BULLET_RE.exec(line);
      if (!m || !m[1]) continue; // the '(+N more)' overflow line is not parsed
      const root = m[1];
      if (state.roots.has(root)) continue; // already seen this session
      if (insideCwd(cwd, root)) continue; // root ancestor-or-self of cwd: auto-loaded chain
      fresh.push({ root, line });
    }
    if (fresh.length === 0) return pass();

    // RECORD-BEFORE-DENY: whatever the agent does next, the verbatim retry
    // passes — a second refusal for the same root is impossible (spec §7).
    for (const f of fresh) state.roots.add(f.root);

    const reason = [
      'ORIENT FIRST (access gate): this call enters directories whose onboarding docs this session has not read.',
      ...fresh.map((f) => f.line),
      'Read the file(s) above, then re-run this exact call — it will pass. This gate fires once per directory per session.',
    ].join('\n');
    return { deny: reason, state };
  } catch (_) {
    return pass(); // fail open: a broken gate never blocks a tool call
  }
}
