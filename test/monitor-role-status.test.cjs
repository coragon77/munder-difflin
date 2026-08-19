'use strict';

// MONITOR: ROLE IS IDENTITY, SCRAPE IS STATUS
// (card agent-restore-parked-agents-de-2026-08-19)
//
// The registry roles were restored, but the Command Center's VACATION shelf
// and the AGENTS (floor) rows rendered the store `description` — the LIVE
// terminal scrape — as the agent's identity line. Every parked agent read
// 'on standby' (or, for Dwight, raw pane output WITH ANSI cursor codes),
// which is exactly the wrong text that caused the Ryan/merlin_oegb misroute.
//
// This file pins the monitor half of the role/status split shipped for the
// edit dialog (card agent-separate-agent-identity--2026-08-19):
//  • VACATION + AGENTS rows render the REGISTRY ROLE as the identity line,
//    with the shared UNKNOWN_ROLE constant when it is absent/empty;
//  • the live status stays visible on the floor rows, labelled as status;
//  • the status scrape is SANITISED where it is written (usePtyParser) and
//    where legacy rows hydrate (store loaders), so no ANSI/control junk can
//    reach any consumer;
//  • a PARKED agent's row is never rewritten — Stefan cancelled the
//    description-restore mid-card ('the role field fits my purpose much
//    better'); descriptions stay what the scrape left, only sanitised;
//  • the fullscreen header quotes the ROLE too, and the 'a fresh harness'
//    role-shaped placeholder class is dead everywhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const read = (p) => readFileSync(path.join(repoRoot, p), 'utf8');

// ─── the sanitiser (unit) ──────────────────────────────────────────────────

const { sanitizeStatusText } = require('./load-ts.cjs')('src/renderer/src/statusText.ts');

// Dwight's ACTUAL stored description (roster.json, 2026-08-19): a background-
// task notice scraped off the pane with CSI cursor-absolute (`G`) and
// erase-line (`K`) sequences still embedded.
const DWIGHT_JUNK =
  'no completion record w\x1b[26Gs found for this background\x1b[54Gshell command\x1b[68Gfrom the\x1b[77Gp\x1b[79Gevious session. It may have been stopped (via the\x1b[K';

test('an ANSI-laden scrape is stripped clean: no escapes, no control chars, collapsed whitespace', () => {
  const out = sanitizeStatusText(DWIGHT_JUNK, 400);
  assert.ok(!/\x1b/.test(out), 'no ESC byte survives');
  // C0 controls except \t (already collapsed) must not survive either.
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f]/.test(out), 'no control characters survive');
  assert.ok(!/\s{2,}/.test(out), 'whitespace runs collapse to single spaces');
  assert.ok(out.startsWith('no completion record'), 'the readable text itself survives');
  assert.ok(
    out.includes('session'),
    'text past the cursor codes survives (as flattened fragments)',
  );
  // The default (row-length) cap keeps the same text but visibly truncated.
  const row = sanitizeStatusText(DWIGHT_JUNK);
  assert.ok(row.length <= 120 && row.endsWith('…'), 'row rendering stays within the cap');
});

test('a normal scrape summary passes through unchanged (up to the row-length cap)', () => {
  assert.equal(sanitizeStatusText('bash npm test'), 'bash npm test');
  assert.equal(sanitizeStatusText('  read   src/main/hive.ts  '), 'read src/main/hive.ts');
  const long = sanitizeStatusText(`read ${'x'.repeat(400)}`);
  assert.ok(long.length <= 120, 'truncated to something that fits a row');
  assert.ok(long.endsWith('…'), 'truncation is visible, never silent');
});

// ─── the write point: the scrape is sanitised where it is recorded ─────────

test('usePtyParser sanitises the scrape at the write point (status semantics kept)', () => {
  const src = read('src/renderer/src/hooks/usePtyParser.ts');
  assert.ok(
    src.includes('sanitizeStatusText'),
    'the parser routes its status text through the shared sanitiser',
  );
  // SGR-only stripping is what let the cursor codes through — the parser must
  // not keep a private narrow regex next to the shared one.
  assert.ok(
    !/\[0-9;\]\*m/.test(src),
    'the old SGR-only ANSI_RE is gone (it passed cursor-position codes)',
  );
});

test('store loaders sanitise legacy persisted descriptions on hydrate', () => {
  const src = read('src/renderer/src/store/store.ts');
  for (const fn of ['loadPersistedAgents', 'loadPersistedArchived']) {
    const at = src.indexOf(`function ${fn}`);
    const body = src.slice(at, src.indexOf('}', src.indexOf('return parsed.map', at)));
    assert.ok(
      body.includes('sanitizeStatusText'),
      `${fn} sanitises descriptions from the persisted roster (Dwight-style legacy junk)`,
    );
  }
});

// ─── behavior: a junk description hydrates clean for EVERY consumer ────────

test('a persisted ANSI-junk description loads clean out of the store', () => {
  const memoryStorage = {
    data: {},
    getItem(k) {
      return Object.hasOwn(this.data, k) ? this.data[k] : null;
    },
    setItem(k, v) {
      this.data[k] = String(v);
    },
    removeItem(k) {
      delete this.data[k];
    },
  };
  globalThis.localStorage = memoryStorage;
  globalThis.window = {
    localStorage: memoryStorage,
    addEventListener() {},
    setTimeout,
    clearTimeout,
    cth: {
      rosterReadSync: () => ({
        version: 1,
        savedAt: new Date().toISOString(),
        agents: [],
        archived: [
          {
            id: 'dwight-msvy7pf1',
            name: 'Dwight',
            character: 'dwight',
            accent: 'coral',
            description: DWIGHT_JUNK,
            project: 'merlin_hlog42',
            tmuxTarget: '',
            cwd: '/opt/django/projects/merlin_hlog42',
            command: 'claude',
            status: 'idle',
            action: 'on vacation',
            progress: 0,
            vacation: true,
          },
        ],
        restorable: [],
        queues: {},
        selectedId: null,
      }),
    },
  };
  // Fresh module (load-ts caches per path): assert the cache was cold so a
  // stale store from another test file can never answer here.
  const { useStore } = require('./load-ts.cjs')('src/renderer/src/store/store.ts');
  const row = useStore.getState().archivedAgents.find((a) => a.id === 'dwight-msvy7pf1');
  assert.ok(row, 'the vacationer hydrates onto the archived shelf');
  assert.equal(
    row.description,
    sanitizeStatusText(DWIGHT_JUNK),
    'the hydrated description is the sanitised text, byte-for-byte',
  );
});

// ─── the monitor rows: role is identity, status is labelled ────────────────

test('VACATION rows render the REGISTRY ROLE as identity, never the live status', () => {
  const src = read('src/renderer/src/components/CommandCenterPanel.tsx');
  const vac = src.slice(
    src.indexOf('function VacationSection'),
    src.indexOf('function ArchivedSection'),
  );
  assert.ok(
    /a\.role(\?\.trim\(\))? \|\| UNKNOWN_ROLE/.test(vac) || /UNKNOWN_ROLE/.test(vac),
    'the vacation identity line falls back to the shared UNKNOWN_ROLE constant',
  );
  assert.ok(
    !/\{a\.description\}/.test(vac),
    'the vacation shelf no longer renders the live description as the identity line',
  );
});

test('AGENTS (floor) rows render the role identity line plus a labelled live status', () => {
  const src = read('src/renderer/src/components/CommandCenterPanel.tsx');
  const agents = src.slice(
    src.indexOf('<Section title="AGENTS">'),
    src.indexOf('<Section title="DIRECTORIES">'),
  );
  assert.ok(
    /a\.role(\?\.trim\(\))? \|\| UNKNOWN_ROLE/.test(agents),
    'floor rows carry the role identity line with the shared unknown fallback',
  );
  assert.ok(
    /status:/.test(agents) && /\{a\.description/.test(agents),
    'the live status stays visible on floor rows, clearly labelled as status',
  );
});

test('the panel imports the shared UNKNOWN_ROLE — no fourth spelling', () => {
  const src = read('src/renderer/src/components/CommandCenterPanel.tsx');
  assert.ok(
    src.includes("from '@shared/agentRole'"),
    'the panel reuses src/shared/agentRole.ts like the dialog, directory payload and roster line',
  );
});

// ─── Stefan's final call: role, not description — no data migration ────────

test('the boot vacation-reconcile stamps ONLY the role — no description rewrite', () => {
  const src = read('src/renderer/src/hooks/useHive.ts');
  const at = src.indexOf('BOOT vacation reconcile');
  const body = src.slice(at, src.indexOf('// 5c)', at));
  assert.ok(at >= 0, 'the boot vacation reconcile effect exists');
  assert.ok(
    /role:\s*e\.role/.test(body),
    'every row gets the registry role stamped — the identity the monitor renders',
  );
  // The description-restore deliverable was CANCELLED mid-card (Stefan: 'the
  // role field fits my purpose much better'). Pin that it cannot sneak back.
  assert.ok(
    !/description:\s*(restore|e\.role)/.test(body),
    'the reconcile never rewrites descriptions — Stefan chose role over description',
  );
});

test('the spawn broadcast and the store row both carry the registry role', () => {
  const hive = read('src/renderer/src/hooks/useHive.ts');
  const at = hive.indexOf('const agent: Agent = {');
  const block = hive.slice(at, hive.indexOf('// A background spawn', at));
  assert.ok(/role:\s*rec\.role/.test(block), 'cards built from spawn broadcasts carry rec.role');
  const store = read('src/renderer/src/store/store.ts');
  assert.ok(
    /role\?: string/.test(store),
    'the store Agent type has a role field (identity is no longer re-derived from status)',
  );
});

// ─── god steer 5: the fullscreen header quotes the ROLE ────────────────────

test('FullscreenTerminal quotes the registry role, not the live description', () => {
  const src = read('src/renderer/src/components/FullscreenTerminal.tsx');
  assert.ok(
    src.includes("from '@shared/agentRole'"),
    'reuses the shared UNKNOWN_ROLE constant — no second spelling',
  );
  assert.ok(
    /\{agent\.role(\?\.trim\(\))? \|\| UNKNOWN_ROLE\}/.test(src),
    'the quoted identity line is the registry role with the unknown fallback',
  );
  assert.ok(
    !/\{agent\.description\}/.test(src),
    'the live description no longer poses as identity in the fullscreen header',
  );
});

// ─── god steer 6: the 'a fresh harness' placeholder class is dead ──────────

test("no surface ships the 'a fresh harness' role-shaped placeholder", () => {
  const sources = [
    'src/renderer/src/components/AddAgentModal.tsx',
    'src/renderer/src/hooks/useHive.ts',
    'src/renderer/src/store/store.ts',
    'src/renderer/src/components/CommandCenterPanel.tsx',
  ];
  for (const p of sources) {
    const src = read(p).replace(/^\s*\/\/.*$/gm, ''); // comments may name the dead placeholder
    assert.ok(!src.includes("'a fresh harness'"), `${p} carries no live 'a fresh harness' default`);
  }
});
