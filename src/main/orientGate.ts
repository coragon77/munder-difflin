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

/** One command-line segment, with the heredoc bodies attached to the
 *  segment whose `<<` introduced them (a heredoc-fed --body/stdin contract
 *  is PROSE for the primitive that reads it — it must stay inside the
 *  exempt segment, not become free-floating command lines). */
interface Segment {
  text: string;
  /** Heredoc body spans (indices into text) with their delimiter quoting:
   *  a QUOTED delimiter makes the body literal (prose — expansions in it
   *  never run); an unquoted one leaves $( )/backticks live. */
  heredocs: Array<{ start: number; end: number; quoted: boolean }>;
}

/** Bash narrowing, round 2 (card agent-orient-gate-fires-on-cal-2026-08-21,
 *  two cold-context review rounds): the command string is PROSE-CARRYING —
 *  a project path or name inside a --body/--reason/--notes value or a
 *  heredoc contract is a mention, not an access. Split the command
 *  QUOTE-AWARE and exempt every segment that IS a hive-* primitive
 *  invocation — lifecycle primitives operate ON agents and hive state,
 *  never IN a work directory. Splitting mirrors real shell syntax:
 *  quoted prose never splits; splits inside live $( )/backtick/subshell
 *  spans don't happen (they're one command); single & (background) splits,
 *  fd-dups (2>&1) and >& redirects don't; # comments are inert; heredoc
 *  bodies attach to their introducer segment (quoted delimiter = prose);
 *  <<< herestrings are operators, not heredocs. The exemption covers only
 *  the primitive's own words: real shell work hiding in the segment —
 *  redirect operands (quoted or not), herestring operands, live $( ) and
 *  backtick bodies, and <( )/>( ) process substitutions — is extracted
 *  from the quote mask and scanned. Known ceiling (marked, not chased): a
 *  `)` inside quotes nested WITHIN a $() body can unbalance the extractor;
 *  adversarial var-redefinition (HIVE_NODE=/bin/cat) is outside a
 *  fail-open orientation gate's threat model. */
function splitCommand(command: string): Segment[] {
  const out: Segment[] = [];
  let cur = '';
  const curHeredocs: Array<{ start: number; end: number; quoted: boolean }> = [];
  let quote: "'" | '"' | null = null;
  let sub = 0; // $( depth inside double quotes — live, kept with its segment
  let bt = false; // backtick span inside double quotes — same
  let depth = 0; // unquoted ( )/$( nesting — no splits inside (one command)
  let pending: { term: string; tabs: boolean; quoted: boolean; segIdx: number } | null = null;
  const n = command.length;
  let i = 0;
  const push = (): void => {
    out.push({ text: cur, heredocs: curHeredocs.splice(0) });
    cur = '';
  };
  const wordBoundary = (): boolean =>
    cur.length === 0 || /[\s;&|()<)]$/.test(cur[cur.length - 1] ?? '');
  while (i < n) {
    const c = command[i] as string;
    if (quote === null && depth === 0 && c === '#' && wordBoundary()) {
      // Comment: inert — skip to end of line (a `<<` inside it is not a
      // heredoc; a commented-out command is not an access).
      while (i < n && command[i] !== '\n') i++;
      continue;
    }
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
      if (c === '"') quote = null;
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
    // Unquoted, live shell syntax.
    if (depth > 0) {
      if (c === '(') depth++;
      else if (c === ')') depth--;
      cur += c;
      i++;
      continue;
    }
    if (c === '$' && command[i + 1] === '(') {
      depth = 1;
      cur += c + (command[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (c === '(') {
      depth = 1;
      cur += c;
      i++;
      continue;
    }
    if (c === '<' && command[i + 1] === '<') {
      if (command[i + 2] === '<') {
        cur += '<<<'; // herestring: an operator, not a heredoc
        i += 3;
        continue;
      }
      // Heredoc introducer: parse the delimiter (blanks, optional -, quotes),
      // keep the op text in the segment, and arm pending — the body starts
      // at the next NEWLINE (tails like `<<EOF | cat f` split normally first).
      let j = i + 2;
      let tabs = false;
      if (command[j] === '-') {
        tabs = true;
        j++;
      }
      while (j < n && /[ \t]/.test(command[j] ?? '')) j++;
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
      pending = { term: delim || '\n', tabs, quoted: q !== '', segIdx: out.length };
      continue;
    }
    if (c === ';' || c === '\n') {
      const wasNewline = c === '\n';
      push();
      i++;
      if (wasNewline && pending) {
        // Consume the heredoc body: line-compare against the terminator
        // (tab-stripped for <<-), attach everything to the introducer's
        // segment. An unclosed heredoc swallows the rest, as in the shell.
        const p = pending;
        pending = null;
        const seg = out[p.segIdx] as Segment;
        const start = seg.text.length;
        let end = start;
        let closed = false;
        while (i <= n) {
          const nl = command.indexOf('\n', i);
          const stop = nl === -1 ? n : nl;
          let line = command.slice(i, stop).replace(/\r$/, '');
          if (p.tabs) line = line.replace(/^\t+/, '');
          seg.text += command.slice(i, stop === n ? n : stop + 1);
          end = seg.text.length;
          i = stop === n ? n : stop + 1;
          if (line === p.term) {
            closed = true;
            break;
          }
          if (nl === -1) break;
        }
        seg.heredocs.push({ start, end, quoted: p.quoted });
        if (!closed) break;
      }
      continue;
    }
    if (c === '&') {
      const prev = cur[cur.length - 1] ?? '';
      if (prev === '>' || prev === '<' || command[i + 1] === '>') {
        cur += c; // fd-dup (2>&1, <&3) or the >& / &> redirect forms
        i++;
        continue;
      }
      i++;
      push(); // single & : background — the right half is a real command
      continue;
    }
    if (c === '|') {
      i += command[i + 1] === '|' ? 2 : 1;
      push();
      continue;
    }
    cur += c;
    i++;
  }
  push();
  return out;
}

/** Read one shell WORD from raw text at index i (blanks skipped): a quoted
 *  word runs through its closing quote (backslash escapes inside "), a bare
 *  word until whitespace or shell metacharacters. Wrapping quotes stripped. */
function readRawWord(s: string, i: number): { word: string; j: number } {
  const n = s.length;
  while (i < n && /[\s]/.test(s[i] ?? '')) i++;
  let out = '';
  while (i < n) {
    const c = s[i] as string;
    if (c === '\\') {
      out += s[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < n && s[i] !== q) {
        if (q === '"' && s[i] === '\\') {
          out += s[i + 1] ?? '';
          i += 2;
          continue;
        }
        out += s[i] ?? '';
        i++;
      }
      i++; // closing quote
      return { word: out, j: i };
    }
    if (/[\s;&|<>()`]/.test(c)) return { word: out, j: i };
    out += c;
    i++;
  }
  return { word: out, j: i };
}

/** Real shell work hiding inside an (exempt) primitive segment, extracted
 *  from the QUOTE MASK so only live syntax counts: redirect operands
 *  (`>`/`>>`/`<`/`<<<`/`>&` — quoted or not; fd-dups skipped), live $( )
 *  and backtick bodies (executed even inside double quotes), and <( )/>( )
 *  process substitution bodies. Heredoc bodies are data: never redirects;
 *  expansions only when the delimiter was UNQUOTED. Each part is fed back
 *  through the scan. */
function primitiveExtras(seg: Segment): string[] {
  const parts: string[] = [];
  const text = seg.text;
  const rawMask = maskQuoted(text);
  // Two masked views: operators must ignore ALL heredoc bodies; expansions
  // must ignore QUOTED-delimiter bodies only (unquoted ones are live).
  const opMask = rawMask.split('');
  const exMask = rawMask.split('');
  for (const h of seg.heredocs) {
    for (let k = h.start; k < h.end && k < opMask.length; k++) opMask[k] = '\0';
    if (h.quoted) for (let k = h.start; k < h.end && k < exMask.length; k++) exMask[k] = '\0';
  }
  const op = opMask.join('');
  const ex = exMask.join('');
  // Redirect / herestring operators, raw-operand based (quoted operands
  // still open the file). Heredoc introducers (<<) are skipped.
  for (let k = 0; k < op.length; k++) {
    const c = op[k] as string;
    if (c !== '>' && c !== '<') continue;
    if ((c === '<' || c === '>') && op[k + 1] === '(') {
      // Process substitution <( … ) / >( … ): paren-balanced body.
      const span = spanBalanced(ex, k + 1);
      if (span) {
        parts.push(text.slice(span.start, span.end));
        k = span.end;
      } else k++;
      continue;
    }
    if (op[k + 1] === '<' || op[k - 1] === '<') continue; // << introducer
    let opEnd = k + 1;
    if (op[k + 1] === '>' || op[k + 1] === '<' || op[k + 1] === '|') opEnd = k + 2;
    if (op[opEnd] === '&' && /[0-9-]/.test(op[opEnd + 1] ?? '')) {
      k = opEnd + 1; // fd-dup (2>&1, <&3): no file
      continue;
    }
    if (op[opEnd] === '&') opEnd++; // >&word: deprecated redirect form
    const w = readRawWord(text, opEnd);
    if (w.word) parts.push(w.word);
    k = Math.max(k, w.j - 1);
  }
  // Live $( … ) bodies: paren balance over the expansion mask.
  for (let k = 0; k < ex.length - 1; k++) {
    if (ex[k] === '$' && ex[k + 1] === '(') {
      const span = spanBalanced(ex, k + 1);
      if (span) {
        parts.push(text.slice(span.start, span.end));
        k = span.end;
      } else k++;
    }
  }
  // Live backtick bodies: pairs over the expansion mask.
  let btAt = -1;
  for (let k = 0; k < ex.length; k++) {
    if (ex[k] !== '`') continue;
    if (btAt === -1) btAt = k;
    else {
      parts.push(text.slice(btAt + 1, k));
      btAt = -1;
    }
  }
  return parts;
}

/** Indices of the balanced ( … ) span starting AT the '(' (mask view):
 *  [bodyStart, bodyEnd) — callers slice the RAW text, so quoted paths
 *  inside the body survive extraction. */
function spanBalanced(mask: string, open: number): { start: number; end: number } | null {
  if (mask[open] !== '(') return null;
  let d = 0;
  for (let k = open; k < mask.length; k++) {
    if (mask[k] === '(') d++;
    else if (mask[k] === ')') {
      d--;
      if (d === 0) return { start: open + 1, end: k };
    }
  }
  return null; // unclosed — the shell would error; nothing to extract
}

function scanNonPrimitiveBash(command: string): string {
  const keep: string[] = [];
  for (const seg of splitCommand(command)) {
    const sc = shCParts(seg.text);
    if (sc) {
      if (sc.prefix.trim()) keep.push(sc.prefix);
      const inner = scanNonPrimitiveBash(sc.body);
      if (inner) keep.push(inner);
      // Heredocs attached to the sh -c segment itself: the shell -c body
      // never sees them as heredocs, but their expansion rules still hold.
      for (const extra of primitiveExtras({ text: seg.text, heredocs: seg.heredocs })) {
        const inner2 = scanNonPrimitiveBash(extra);
        if (inner2) keep.push(inner2);
      }
      continue;
    }
    if (isPrimitiveInvocation(seg.text)) {
      for (const extra of primitiveExtras(seg)) {
        const inner = scanNonPrimitiveBash(extra);
        if (inner) keep.push(inner);
      }
      continue;
    }
    keep.push(seg.text);
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
