/**
 * The orient-first rule AS MECHANISM (card agent-harness-orient-first-mus-
 * 2026-08-20, spec docs/superpowers/specs/2026-08-20-dispatch-orient-
 * injection.md): the prose rule in every spawn prompt still failed because
 * its trigger ("directories the task touches") never fires when the facts
 * arrive by board/mail and the access is not a file read. So the DISPATCH
 * PIPELINE itself detects the directories a dispatch references and appends
 * an ORIENT FIRST block to the contract: registry cwd matching (deepest
 * root wins — /opt/django/projects is itself a registered cwd and a naive
 * match would tag everything with it), a basename idiom match, an
 * absolute-path fallback that walks UPWARD to the nearest directory with
 * CLAUDE.md/AGENTS.md (that is what makes worktrees resolve to their
 * owning checkout), and the assignee's own cwd. Docs-less roots drop
 * silently; the cap is 5 with an explicit '+N more' line, never a silent
 * truncation; zero roots append NOTHING (no asserted negative, §6/Q3).
 *
 * SELF-CONTAINED BY DESIGN: hive.ts serializes this function verbatim
 * (Function.prototype.toString) into the generated bin/ CLIs the same way
 * cardHeld is, so the code the CLI runs is the code the main-process tests
 * exercise. No imports, no module-scope references, everything inside the
 * one function. FAIL OPEN is non-negotiable: on ANY error the function
 * returns '' and the dispatch proceeds with the body unmodified — a broken
 * injector must never block a dispatch (Card B backstops). Probes are the
 * injected (path) => boolean — existsSync at the CLI call sites, fake sets
 * in tests — and never open or read a file.
 */
export function orientationBlock(
  searchText: string,
  assigneeCwd: string,
  assigneeProvider: string,
  registryCwds: string[],
  probe: (p: string) => boolean,
): string {
  try {
    const text = String(searchText ?? '');

    const norm = (p: unknown): string => {
      let s = String(p ?? '').trim();
      while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
      return s;
    };

    // The registered cwds, normalized and deduped ('/' alone is no cwd).
    const cwds: string[] = [];
    if (Array.isArray(registryCwds)) {
      for (const raw of registryCwds) {
        const c = norm(raw);
        if (c && c !== '/' && cwds.indexOf(c) === -1) cwds.push(c);
      }
    }

    interface Hit {
      root: string;
      idx: number; // first appearance in the search text; -1 = assignee cwd
    }
    const hits: Hit[] = [];
    const addHit = (root: string, idx: number): void => {
      for (const h of hits) {
        if (h.root === root) {
          if (idx === -1)
            h.idx = -1; // assignee cwd is unconditionally first (§3)
          else if (h.idx !== -1 && idx < h.idx) h.idx = idx;
          return;
        }
      }
      hits.push({ root, idx });
    };

    // S1 — registry cwd match, full path: the text contains the cwd followed
    // by end, whitespace, a quote, or '/'.
    const pathHit = (cwd: string): number => {
      let at = text.indexOf(cwd);
      while (at !== -1) {
        const after = text.charAt(at + cwd.length);
        if (after === '' || after === '/' || /[\s'"`]/.test(after)) return at;
        at = text.indexOf(cwd, at + 1);
      }
      return -1;
    };
    for (const c of cwds) {
      const at = pathHit(c);
      if (at !== -1) addHit(c, at);
    }

    // S2 — registry cwd match, basename (≥ 6 chars guards against generic
    // segments like 'dev'): a word-boundary, case-sensitive match catches the
    // dominant human idiom, bare 'merlin_hpt' with no path. Ambiguity: one
    // basename mapping to several cwds prefers the non-worktree path; still
    // ambiguous, include each (distinct real directories).
    const segOf = (p: string): string => {
      const i = p.lastIndexOf('/');
      return i === -1 ? p : p.slice(i + 1);
    };
    const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const underWorktrees = (p: string): boolean => /(^|\/)(worktrees|\.worktrees)\//.test(p);
    const bySeg = new Map<string, Array<{ cwd: string; idx: number }>>();
    for (const c of cwds) {
      const seg = segOf(c);
      if (seg.length < 6) continue;
      const m = new RegExp('(^|[^A-Za-z0-9_-])' + escRe(seg) + '(?=$|[^A-Za-z0-9_-])').exec(text);
      if (m) {
        const arr = bySeg.get(seg) ?? [];
        arr.push({ cwd: c, idx: m.index });
        bySeg.set(seg, arr);
      }
    }
    for (const arr of bySeg.values()) {
      let pick = arr;
      if (arr.length > 1) {
        const nonWt = arr.filter((h) => !underWorktrees(h.cwd));
        if (nonWt.length > 0) pick = nonWt;
      }
      for (const h of pick) addHit(h.cwd, h.idx);
    }

    // DEEPEST ROOT WINS over the union of registry matches: a referenced cwd
    // shadowed by a deeper referenced cwd is dropped — the deeper root is the
    // orientation root for that path (spec §3/S1).
    const kept = hits.filter(
      (h) => !hits.some((o) => o !== h && o.root.indexOf(h.root + '/') === 0),
    );

    // S3 — absolute-path fallback for directories no agent staffs and for
    // worktrees: from the longest EXISTING prefix of each token, walk UPWARD
    // (≤ 8 steps) to the nearest directory carrying CLAUDE.md or AGENTS.md.
    const forbidden = (p: string): boolean =>
      p === '/' || p === '/home' || /^\/home\/[^/]+$/.test(p) || p === '/opt' || p === '/tmp';
    const tokens = text.match(/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g) ?? [];
    for (const tok of tokens) {
      const t = norm(tok);
      if (!t) continue;
      if (kept.some((h) => t === h.root || t.indexOf(h.root + '/') === 0)) continue; // S1-covered
      let p = t;
      for (let guard = 0; p !== '/' && !probe(p) && guard < 40; guard++) {
        const i = p.lastIndexOf('/');
        p = i <= 0 ? '/' : p.slice(0, i);
      }
      if (p === '/' || !probe(p)) continue;
      let dir: string | null = p;
      for (let step = 0; step <= 8 && dir; step++) {
        if (!forbidden(dir) && (probe(dir + '/CLAUDE.md') || probe(dir + '/AGENTS.md'))) {
          addHit(dir, text.indexOf(tok));
          break;
        }
        if (dir === '/') break;
        const i = dir.lastIndexOf('/');
        dir = i <= 0 ? '/' : dir.slice(0, i);
      }
    }

    // S4 — the assignee's own cwd is ALWAYS a candidate.
    const own = norm(assigneeCwd);
    if (own && own !== '/') addHit(own, -1);

    // Post-processing: one more deepest-root pass (an S3 walk can find an
    // ancestor of a registry root), then drop docs-less roots SILENTLY.
    const union = hits.filter(
      (h) => !hits.some((o) => o !== h && o.root.indexOf(h.root + '/') === 0),
    );
    const survivors = union.filter(
      (h) => probe(h.root + '/CLAUDE.md') || probe(h.root + '/AGENTS.md'),
    );
    survivors.sort((a, b) => a.idx - b.idx); // assignee cwd (-1) first, then first appearance
    if (survivors.length === 0) return '';

    const cap = 5;
    const shown = survivors.slice(0, cap);
    const overflow = survivors.length - shown.length;
    const provider = String(assigneeProvider ?? '')
      .trim()
      .toLowerCase();
    const lines: string[] = [
      '--- ORIENT FIRST (injected by hive-dispatch) ---',
      'This task references directories that carry their own onboarding docs. In each one, BEFORE grepping, reading source, or forming a plan — and even if the task is advisory and your facts arrive from the board or mail — orient first:',
    ];
    for (const h of shown) {
      const hasClaude = probe(h.root + '/CLAUDE.md');
      const hasAgents = probe(h.root + '/AGENTS.md');
      const docs =
        hasClaude && hasAgents
          ? provider === 'claude'
            ? 'CLAUDE.md'
            : 'AGENTS.md'
          : hasClaude
            ? 'CLAUDE.md'
            : 'AGENTS.md';
      const graph = probe(h.root + '/graphify-out/graph.json')
        ? ' Knowledge graph present: run `graphify query "<question>"` before any grep.'
        : '';
      lines.push('- ' + h.root + ': read ' + docs + ' first and follow what it mandates.' + graph);
    }
    if (overflow > 0) {
      lines.push(
        '(+' + overflow + ' more directories referenced — orient in each before working there.)',
      );
    }
    return lines.join('\n');
  } catch (_) {
    return ''; // fail open: a broken injector never blocks a dispatch
  }
}
