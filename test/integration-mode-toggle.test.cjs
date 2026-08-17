'use strict';

/**
 * Integration mode toggle (card integration-mode-toggle-20260817).
 *
 * A Settings switch that moves integration (merge + push) from god to the
 * workers. Rationale: god runs on a tight token budget — integration is
 * mechanical overhead his budget shouldn't pay; workers know their own
 * branches. Default 'god' = today's flow byte-identical.
 *
 * The policy lives in PROSE constants (godLine, worker briefing, hive-root
 * AGENTS.md, COMMANDS.md, identity.md), so these tests pin the mode-dependent
 * RENDERING on every surface plus the config/wiring plumbing (source pins —
 * the repo's established mirror convention for Electron-gated wiring, cf.
 * vacation-ui-surface / permission-mode-config).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager, hiveRootAgentsMd, renderCommandsMd } = loadTs('src/main/hive.ts');

const SECTION = '## Integration — worker-side (integrationMode: workers)';
const RENDERER_CONSTRAINT = 'NEVER merge into the live checkout';
const SKILL_OVERRIDE = 'asol-git-merge-singletenant';
const DISPATCH_OVERRIDE = 'beats the mode default';

// ——— config plumbing (defaults = current behavior) ————————————————————————

test("config: DEFAULTS pins integrationMode 'god' (the shipped default)", () => {
  const src = readFileSync(join(__dirname, '..', 'src/main/config.ts'), 'utf8');
  const defaults = src.slice(src.indexOf('const DEFAULTS'));
  assert.ok(defaults.includes("integrationMode: 'god'"), 'DEFAULTS carries the god default');
  const iface = src.slice(
    src.indexOf('export interface HarnessConfig'),
    src.indexOf('const DEFAULTS'),
  );
  assert.ok(iface.includes("integrationMode?: 'god' | 'workers'"), 'interface types the two modes');
});

// ——— hive-root AGENTS.md (hiveRootAgentsMd) ———————————————————————————

test('workers mode appends the integration section after the base doc; god mode does not', () => {
  const on = hiveRootAgentsMd(true, 'workers');
  assert.ok(on.includes(SECTION), 'section present');
  assert.ok(on.includes(RENDERER_CONSTRAINT), 'renderer/preload constraint baked in');
  assert.ok(on.includes(SKILL_OVERRIDE), 'never-push skill override named');
  assert.ok(on.includes(DISPATCH_OVERRIDE), 'dispatch boundary override named');
  assert.ok(on.indexOf('# AGENTS.md — hive floor') === 0, 'base doc still leads');
  assert.ok(on.indexOf('## Delegate first') < on.indexOf(SECTION), 'section appended after base');

  const off = hiveRootAgentsMd(true, 'god');
  assert.ok(!off.includes(SECTION), 'god mode: no integration section');
  assert.equal(off, hiveRootAgentsMd(true), 'omitting the mode defaults to god (back-compat)');
});

// ——— agent briefing (injectedPrompt) ——————————————————————————————————

// TS `private` is compile-time only — erased by transpile, reachable at runtime.
const injectedPrompt = HiveManager.prototype['injectedPrompt'];
const GOD = { id: 'michael', name: 'Michael', isGod: true, cwd: '/w' };
const WORKER = { id: 'pam', name: 'Pam', role: 'worker', cwd: '/w' };

test('god mode: the god briefing is unchanged — god still owns branch integration', () => {
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false, true, 'god');
  assert.ok(p.includes('branch integration, and final QA'), 'god owns integration');
  assert.ok(!p.includes('INTEGRATION IS DELEGATED'), 'no delegation clause');
  const omitted = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false, true);
  assert.ok(omitted.includes('branch integration, and final QA'), 'mode omitted = god default');
});

test("workers mode: god's briefing DELEGATES integration and records pushed hashes", () => {
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false, true, 'workers');
  assert.ok(p.includes('INTEGRATION IS DELEGATED'), 'delegation clause present');
  assert.ok(!p.includes('branch integration, and final QA'), 'god no longer owns it');
  assert.ok(p.includes('RECORD the hash'), 'god records the pushed hash, no re-QA');
  // Constraint 1 survives the mode: the restart-window mechanism stays god's.
  assert.ok(p.includes('stays YOURS in every mode'), 'renderer mechanism stays god-owned');
});

test('workers mode: the worker briefing carries the worker-side integration duty', () => {
  const p = injectedPrompt.call(
    null,
    WORKER,
    '/agents/pam',
    '/hive',
    false,
    false,
    true,
    'workers',
  );
  assert.ok(p.includes('INTEGRATION — WORKER-SIDE'), 'duty line present');
  assert.ok(p.includes('gates are green'), 'merge only after own gates');
  assert.ok(p.includes('pushed hash'), 'report the hash to god');
  assert.ok(p.includes(RENDERER_CONSTRAINT), 'renderer/preload constraint');
  assert.ok(p.includes(SKILL_OVERRIDE), 'never-push skills still override');
  assert.ok(p.includes(DISPATCH_OVERRIDE), 'dispatch boundary beats the mode default');
});

test('god mode: the worker briefing has no integration duty (today’s flow)', () => {
  const p = injectedPrompt.call(null, WORKER, '/agents/pam', '/hive', false, false, true, 'god');
  assert.ok(!p.includes('INTEGRATION — WORKER-SIDE'));
});

// ——— COMMANDS.md (renderCommandsMd) ———————————————————————————————————

test('COMMANDS.md renders the integration section only in workers mode', () => {
  const on = renderCommandsMd('workers');
  assert.ok(on.includes(SECTION), 'workers: section present');
  assert.ok(
    on.indexOf(SECTION) > on.indexOf('## HIRING AGENTS'),
    'appended after the stock sections',
  );
  const off = renderCommandsMd('god');
  assert.ok(!off.includes(SECTION), 'god: no section (byte-compatible with today)');
  assert.equal(off, renderCommandsMd(), 'mode omitted = god default');
});

// ——— identity.md (identityText) ———————————————————————————————————————

const identityText = HiveManager.prototype['identityText'];

test('identity.md: god owns integration in god mode, delegates it in workers mode', () => {
  const godMode = identityText.call(null, GOD, 'god');
  assert.ok(godMode.includes('conflicts, integration'), 'god-mode bullet unchanged');
  const workersMode = identityText.call(null, GOD, 'workers');
  assert.ok(!workersMode.includes('conflicts, integration'), 'integration dropped from god’s owns');
  assert.ok(workersMode.includes('Integration is delegated to workers'), 'delegation noted');
});

// —── wiring (source pins — Electron-gated, cf. vacation-ui-surface) ────────

test('wiring: main reads the mode lazily, threads it to ensureAgent, and regenerates on flip', () => {
  const idx = readFileSync(join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.ok(
    idx.includes("() => readConfig().integrationMode ?? 'god'"),
    'HiveManager ctor gets a lazy mode getter',
  );
  assert.ok(
    idx.includes("integrationMode: readConfig().integrationMode ?? 'god'"),
    'ensureAgent spawn path threads the mode',
  );
  assert.ok(
    idx.includes("patch?.integrationMode === 'workers'"),
    'config:update regenerates the generated files on a flip',
  );
});

test('wiring: Settings toggle + config mirrors exist on all three surfaces', () => {
  const read = (p) => readFileSync(join(__dirname, '..', p), 'utf8');
  for (const p of ['src/preload/index.ts', 'src/renderer/src/store/config.ts']) {
    assert.ok(read(p).includes("integrationMode?: 'god' | 'workers'"), `${p} mirrors the key`);
  }
  const sm = read('src/renderer/src/components/SettingsModal.tsx');
  assert.ok(sm.includes('integrationMode'), 'SettingsModal reads the key');
  assert.ok(sm.includes('toggleIntegrationMode'), 'toggle handler');
  assert.ok(sm.includes("'workers' : 'god'"), 'toggle writes the two-mode value');
});
