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
import { isPrimitiveInvocation } from './hiveGate';

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

/** A shell WORD: one fully-concatenated operand/argument (quotes stripped,
 *  fragment-joining done, backslash escapes resolved) — `"/a/b"/c/d` is ONE
 *  word, because bash opens one file. */
interface Word {
  text: string;
}

/** A command-substitution / process-substitution / subshell BODY: text the
 *  shell executes — recursively scannable as a command of its own. */
interface CmdBody {
  text: string;
}

/** One pipeline/sequence segment. `subs` holds every live substitution body
 *  anywhere in the segment (word-embedded or standing), `operands` every
 *  redirect/herestring operand (a PATH the shell opens — never a command),
 *  `heredocs` the bodies with their delimiter quoting. `raw` is the exact
 *  original text (heredoc bodies attached to their introducer's segment) —
 *  the exec-position primitive test runs on it unchanged. */
interface Segment {
  raw: string;
  words: Word[];
  subs: CmdBody[];
  operands: Word[];
  heredocs: Array<{ text: string; quoted: boolean }>;
}

/** Balanced ( … ) span in `s` starting at the '(' at index `open`:
 *  quote- and escape-aware — a ')' inside quotes, after a backslash (any
 *  unquoted escape), or inside a # comment never closes (round-4 finding,
 *  card agent-orient-gate-fires-on-cal-2026-08-21) — returns the body's
 *  [start, end) indices; callers slice the raw text. Null when unclosed
 *  (the shell would error; nothing to run). */
function balancedSpan(s: string, open: number): { start: number; end: number } | null {
  if (s[open] !== '(') return null;
  let d = 0;
  let q: "'" | '"' | null = null;
  let atWordStart = true;
  for (let k = open; k < s.length; k++) {
    const c = s[k] as string;
    if (q === "'") {
      if (c === "'") q = null;
      continue;
    }
    if (c === '\\' && q === null) {
      k++; // unquoted escape: the next char never closes anything
      continue;
    }
    if (c === '\\' && q === '"') {
      k++;
      continue;
    }
    if (q === '"') {
      if (c === '"') q = null;
      continue;
    }
    if (c === '#' && atWordStart) {
      while (k < s.length && s[k] !== '\n') k++; // comment inside the span
      continue;
    }
    atWordStart = c === '(' || /[\s;]/.test(c);
    if (c === "'" || c === '"') {
      q = c;
      continue;
    }
    if (c === '(') d++;
    else if (c === ')') {
      d--;
      if (d === 0) return { start: open + 1, end: k };
    }
  }
  return null;
}

/** The ` … ` body starting at the backtick at index `open`: ends at the
 *  next unescaped backtick (`` pairs aside — an empty substitution).
 *  Quote-aware only for escaping; returns null when unclosed. */
function backtickSpan(s: string, open: number): { start: number; end: number } | null {
  for (let k = open + 1; k < s.length; k++) {
    const c = s[k] as string;
    if (c === '\\') {
      k++;
      continue;
    }
    if (c === '`') return { start: open + 1, end: k };
  }
  return null;
}

/** Lex one WORD starting at i (blanks skipped): concatenates quoted and
 *  unquoted fragments until whitespace or a shell metacharacter; resolves
 *  backslash escapes per context. `quoted` reports whether ANY quoting or
 *  escaping was present (heredoc delimiters: quoting any part disables
 *  body expansion). Substitutions inside DOUBLE quotes are LIVE — their
 *  bodies are appended to `subs` when provided (single quotes never run).
 *  Returns the word and the next index. */
function lexWord(
  s: string,
  i: number,
  subs?: Array<{ text: string }>,
): { text: string; quoted: boolean; j: number } {
  const n = s.length;
  while (i < n && /[\s]/.test(s[i] ?? '')) i++;
  let out = '';
  let quoted = false;
  while (i < n) {
    const c = s[i] as string;
    if (c === '\\') {
      if (s[i + 1] === '\n') {
        // Line continuation: the pair is REMOVED before lexing continues
        // (round-4 finding — `<<EO\<newline>F` must lex as delimiter EOF).
        // Joining does NOT quote the word (round-5 note 6: a joined
        // delimiter still expands its body — only real quoting disables).
        i += 2;
        continue;
      }
      out += s[i + 1] ?? '';
      quoted = true;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      quoted = true;
      i++;
      while (i < n && s[i] !== q) {
        if (q === '"') {
          if (s[i] === '\\' && s[i + 1] === '\n') {
            i += 2; // continuation inside double quotes
            continue;
          }
          if (s[i] === '\\' && /[\\"$`\n]/.test(s[i + 1] ?? '')) {
            out += s[i + 1] ?? '';
            i += 2;
            continue;
          }
          if (s[i] === '$' && s[i + 1] === '(') {
            const span = balancedSpan(s, i + 1);
            if (span) {
              subs?.push({ text: s.slice(span.start, span.end) });
              out += s.slice(i, span.end + 1);
              i = span.end + 1;
              continue;
            }
          }
          if (s[i] === '`') {
            const span = backtickSpan(s, i);
            if (span) {
              subs?.push({ text: s.slice(span.start, span.end) });
              out += s.slice(i, span.end + 1);
              i = span.end + 1;
              continue;
            }
          }
        }
        out += s[i] ?? '';
        i++;
      }
      i++; // closing quote (or EOF)
      continue;
    }
    if (/[\s;&|<>()`]/.test(c)) break;
    out += c;
    i++;
  }
  return { text: out, quoted, j: i };
}

/** Bash narrowing, round 3 (card agent-orient-gate-fires-on-cal-2026-08-21,
 *  three cold-context review rounds — patches kept finding bypasses, so the
 *  parse is now ONE tokenizer, correct by construction): the command string
 *  is PROSE-CARRYING — a project path or name inside a --body/--reason/
 *  --notes value or a heredoc contract is a mention, not an access. Split
 *  the command into segments QUOTE-AWARE and exempt every segment that IS
 *  a hive-* primitive invocation — lifecycle primitives operate ON agents
 *  and hive state, never IN a work directory. The tokenizer mirrors shell
 *  lexing: quoted prose never splits; live $( )/backtick/subshell bodies
 *  are extracted whole (no splits inside); single & (background) splits
 *  while fd-dups (2>&1, <&3, >&fd) and >&file don't; # comments are inert;
 *  <<< herestrings and <( )/>( ) process substitutions are operators;
 *  heredoc bodies attach to their introducer's segment, expansion per the
 *  DELIMITER's quoting (quoted delimiter = literal prose), several heredocs
 *  per line each keep their own rules. The exemption covers only the
 *  primitive's own words: real shell work in the segment — substitution
 *  bodies (recursively scanned), redirect/herestring operands (paths, never
 *  exec-tested), live heredoc expansions — is extracted and scanned.
 *  Known ceiling (marked, not chased): adversarial launcher redefinition
 *  (HIVE_NODE=/bin/cat) — outside a fail-open orientation backstop's
 *  threat model; same pre-existing shape in the shared-state gate. */
function parseCommand(command: string): Segment[] {
  const segs: Segment[] = [];
  const newSeg = (): Segment => ({ raw: '', words: [], subs: [], operands: [], heredocs: [] });
  let cur = newSeg();
  const pushSeg = (): void => {
    segs.push(cur);
    cur = newSeg();
  };
  const n = command.length;
  let i = 0;
  let word = '';
  let wordOpen = false; // mid-word (for # comment detection)
  const pending: Array<{ term: string; tabs: boolean; quoted: boolean; segIdx: number }> = [];
  const flush = (): void => {
    if (wordOpen) {
      cur.words.push({ text: word });
      word = '';
      wordOpen = false;
    }
  };

  while (i < n) {
    const c = command[i] as string;
    if (c === '#' && !wordOpen) {
      // Comment — inert to end of line (a << inside it is not a heredoc).
      while (i < n && command[i] !== '\n') i++;
      continue;
    }
    if (c === "'" || c === '"') {
      // A quoted fragment of the current word: lexWord handles joining.
      const w = lexWord(command, i, cur.subs);
      word += w.text;
      wordOpen = true;
      cur.raw += command.slice(i, w.j);
      i = w.j;
      continue;
    }
    if (c === '\\') {
      word += command[i + 1] ?? '';
      wordOpen = true;
      cur.raw += command.slice(i, Math.min(i + 2, n));
      i += 2;
      continue;
    }
    if (c === '$' && command[i + 1] === '(') {
      const span = balancedSpan(command, i + 1);
      if (span) {
        cur.subs.push({ text: command.slice(span.start, span.end) });
        cur.raw += command.slice(i, span.end + 1);
        i = span.end + 1;
      } else {
        // Unclosed: the shell errors; keep it with the segment.
        cur.raw += c;
        i++;
      }
      wordOpen = true; // a substitution inside a word keeps the word open
      continue;
    }
    if (c === '(') {
      const span = balancedSpan(command, i);
      if (span) {
        cur.subs.push({ text: command.slice(span.start, span.end) });
        cur.raw += command.slice(i, span.end + 1);
        i = span.end + 1;
      } else {
        cur.raw += c;
        i++;
      }
      continue;
    }
    if (c === '`') {
      const span = backtickSpan(command, i);
      if (span) {
        cur.subs.push({ text: command.slice(span.start, span.end) });
        cur.raw += command.slice(i, span.end + 1);
        i = span.end + 1;
      } else {
        cur.raw += c;
        i++;
      }
      wordOpen = true;
      continue;
    }
    if (c === '<' || c === '>') {
      // An IO-NUMBER word (the `2` of `2>/dev/null`) is part of the
      // operator, never a command word (round-5 finding 4).
      if (wordOpen && /^\d+$/.test(word)) {
        word = '';
        wordOpen = false;
      } else flush();
      // Operator lexing — fd-dups, herestrings, process subs, heredocs.
      let j = i + 1;
      if (command[j] === c) j++; // >> or <<
      const two = j - i === 2;
      if (c === '<' && two && command[j] === '<') {
        j++; // <<< herestring: operand is stdin DATA, not a file
        cur.raw += command.slice(i, j);
        i = j;
        const w = lexWord(command, i, cur.subs);
        cur.raw += command.slice(i, w.j);
        i = w.j; // word text is prose (not an operand); subs were collected
        continue;
      }
      if (command[j] === '(') {
        // Process substitution <( ) / >>( ): a command body.
        const span = balancedSpan(command, j);
        if (span) {
          cur.subs.push({ text: command.slice(span.start, span.end) });
          cur.raw += command.slice(i, span.end + 1);
          i = span.end + 1;
        } else {
          cur.raw += command.slice(i, j + 1);
          i = j + 1;
        }
        continue;
      }
      if (two && c === '<') {
        // Heredoc: optional '-', then the delimiter as a proper WORD.
        let tabs = false;
        if (command[j] === '-') {
          tabs = true;
          j++;
        }
        const dl = lexWord(command, j);
        cur.raw += command.slice(i, dl.j);
        // Empty QUOTED delimiter (<<"") terminates on a blank line; only a
        // bare << (nothing lexed, unquoted) falls back to the '\n' term.
        const term = dl.quoted ? dl.text : dl.text || '\n';
        pending.push({ term, tabs, quoted: dl.quoted, segIdx: segs.length });
        i = dl.j;
        continue;
      }
      let opEnd = j;
      if (command[opEnd] === '&' || command[opEnd] === '|') opEnd++; // >& >&| <& <|
      cur.raw += command.slice(i, opEnd);
      i = opEnd;
      if (command[opEnd - 1] === '&' || command[opEnd - 1] === '|') {
        // fd form: >& / <& — dup only when the word is all digits or '-'.
        const save = i;
        const w = lexWord(command, i);
        if (/^\d+$|^-$/.test(w.text)) {
          cur.raw += command.slice(save, w.j);
          i = w.j; // fd number consumed, no file operand
        } else if (save < w.j) {
          cur.operands.push({ text: w.text }); // >&file: deprecated redirect
          cur.raw += command.slice(save, w.j);
          i = w.j;
        }
        continue;
      }
      const w = lexWord(command, i, cur.subs);
      if (w.j > i) {
        cur.operands.push({ text: w.text });
        cur.raw += command.slice(i, w.j);
        i = w.j;
      }
      continue;
    }
    if (c === '&' && command[i + 1] === '>') {
      // &> / &>> — ONE redirect operator (round-5 finding 5: splitting at
      // the & fractured the primitive from its arguments).
      flush();
      const opEnd = command[i + 2] === '>' ? i + 3 : i + 2;
      cur.raw += command.slice(i, opEnd);
      i = opEnd;
      const w = lexWord(command, i, cur.subs);
      if (w.j > i) {
        cur.operands.push({ text: w.text });
        cur.raw += command.slice(i, w.j);
        i = w.j;
      }
      continue;
    }
    if (c === '&' || c === '|' || c === ';' || c === '\n') {
      flush();
      const wasNewline = c === '\n';
      if ((c === '&' || c === '|') && command[i + 1] === c) i += 2;
      else i++;
      cur.raw += c === '\n' ? '\n' : (command[i - 1] ?? c);
      pushSeg();
      // A newline ends the heredoc's COMMAND only when the just-ended
      // segment is complete: a trailing | / || / && CONTINUES the pipeline
      // onto the next line, so the body starts one newline later (round-5
      // finding 1). Whitespace-only tail segments don't count — the
      // continuation operator sits in the last non-empty segment.
      let lastIdx = segs.length - 1;
      while (lastIdx >= 0 && (segs[lastIdx] as Segment).raw.trim() === '') lastIdx--;
      const lastSeg = lastIdx >= 0 ? (segs[lastIdx] as Segment) : cur;
      const continues = /(?:\|\||&&|\|)$/.test(lastSeg.raw.trimEnd());
      if (wasNewline && pending.length > 0 && !continues) {
        // Heredoc bodies start at this newline: consume each pending body
        // in order (terminator line exact, tab-stripped for <<-, \r-safe;
        // unclosed bodies swallow the rest, as in the shell) and attach it
        // to the introducer's segment — body text captured DIRECTLY from
        // the consumed span (round-4 finding: reconstructing from cumulative
        // raw mis-attributed earlier bodies to later heredocs).
        for (const p of pending.splice(0)) {
          const seg = segs[p.segIdx] as Segment;
          let closed = false;
          const bodyStart = i;
          let bodyEnd = i;
          while (i <= n) {
            const nl = command.indexOf('\n', i);
            const stop = nl === -1 ? n : nl;
            let line = command.slice(i, stop).replace(/\r$/, '');
            if (p.tabs) line = line.replace(/^\t+/, '');
            if (line === p.term) {
              bodyEnd = i;
              closed = true;
              const consumed = stop === n ? n - i : stop - i + 1;
              seg.raw += command.slice(i, i + consumed);
              i += consumed;
              break;
            }
            const consumed = stop === n ? n - i : stop - i + 1;
            seg.raw += command.slice(i, i + consumed);
            i += consumed;
            bodyEnd = i;
            if (nl === -1) break;
          }
          seg.heredocs.push({ text: command.slice(bodyStart, bodyEnd), quoted: p.quoted });
          if (!closed) break;
        }
      }
      continue;
    }
    if (/[\s]/.test(c)) {
      flush();
      cur.raw += c;
      i++;
      continue;
    }
    word += c;
    wordOpen = true;
    cur.raw += c;
    i++;
  }
  flush();
  pushSeg();
  return segs;
}

/** Live expansions inside an UNQUOTED heredoc body: only $( ) and backticks
 *  run there — redirects, pipes and semicolons are DATA, not operators. */
function heredocSubs(text: string): string[] {
  const out: string[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i] as string;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '$' && text[i + 1] === '(') {
      const span = balancedSpan(text, i + 1);
      if (span) {
        out.push(text.slice(span.start, span.end));
        i = span.end + 1;
        continue;
      }
    }
    if (c === '`') {
      const span = backtickSpan(text, i);
      if (span) {
        out.push(text.slice(span.start, span.end));
        i = span.end + 1;
        continue;
      }
    }
    i++;
  }
  return out;
}

/** Exec-position `sh -c` script: returns [script, argText] when the
 *  segment's words start (after env/wrapper prefixes) with a shell and a
 *  -c flag — the ARGUMENT after -c is the script; the words after it are
 *  $0 and positionals, DATA to the script but readable through it ($1), so
 *  they are returned for scanning as text (round-4 finding: dropping them
 *  let `sh -c 'cat "$1"' _ /project/file` through). Null when not sh -c. */
function shCInvocation(seg: Segment): { script: string; args: string } | null {
  const w = seg.words.map((x) => x.text);
  let i = 0;
  while (i < w.length && /^[A-Za-z_]\w*=/.test(w[i] ?? '')) i++;
  while (i < w.length && ['sudo', 'nohup', 'time', 'exec', 'command'].includes(w[i] ?? '')) i++;
  const exec = w[i] ?? '';
  const base = exec.split('/').pop() ?? '';
  if (!['sh', 'bash', 'dash', 'zsh'].includes(base)) return null;
  i++;
  while (i < w.length) {
    const t = w[i] ?? '';
    if (/^-[a-zA-Z]*c/.test(t)) {
      const script = w[i + 1] ?? '';
      const rest = w.slice(i + 2).filter((x) => x !== '');
      return { script, args: rest.join('\n') };
    }
    if (t.startsWith('-')) {
      i++;
      continue;
    }
    return null;
  }
  return null;
}

function scanNonPrimitiveBash(command: string): string {
  const keep: string[] = [];
  for (const seg of parseCommand(command)) {
    const sc = shCInvocation(seg);
    if (sc) {
      const inner = scanNonPrimitiveBash(sc.script);
      if (inner) keep.push(inner);
      if (sc.args) keep.push(sc.args); // positionals: readable via $1 — scanned
    } else if (isPrimitiveInvocation(seg.raw)) {
      // exempt — but its real shell work is still scanned
    } else {
      keep.push(seg.raw);
    }
    for (const sub of seg.subs) {
      const inner = scanNonPrimitiveBash(sub.text);
      if (inner) keep.push(inner);
    }
    for (const op of seg.operands) keep.push(op.text);
    for (const h of seg.heredocs) {
      if (h.quoted) continue;
      for (const sub of heredocSubs(h.text)) {
        const inner = scanNonPrimitiveBash(sub);
        if (inner) keep.push(inner);
      }
    }
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
