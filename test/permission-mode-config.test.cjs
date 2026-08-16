'use strict';

/**
 * Card permission-mode-config-20260816 — pins beyond the shared helper (those
 * live in spawn-bypass-flag.test.cjs / provider-config.test.cjs):
 *
 *  1. The god co-terminal (kitty satellite) mirrors the in-app god's default
 *     (Claude Auto), respecting a typed --permission-mode — it used to key on
 *     the deleted install-wide autoMode and push bypassPermissions.
 *  2. The stored per-agent choice survives the restorable-roster persistence
 *     slim — the contract "restarts respect the hire-time selection" rides on.
 *  3. The spawnAgentCore resolution mirror: opts.permissionMode ?? DEFAULT —
 *     a stored mode wins, a legacy agent (no stored mode) falls back to the
 *     Claude-Auto default, NEVER to bypass.
 *
 * (2) and (3) are contract pins over already-green plumbing — the repo's
 * established mirror convention for main-process/React-gated wiring; (1) is
 * watched-red-first.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

// store.ts reads window/localStorage at module load — shim first
// (same shim as restore-team.test.cjs).
const memoryStorage = {
  data: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this.data, k) ? this.data[k] : null; },
  setItem(k, v) { this.data[k] = String(v); },
  removeItem(k) { delete this.data[k]; }
};
globalThis.localStorage = memoryStorage;
globalThis.window = { localStorage: memoryStorage, addEventListener() {}, setTimeout, clearTimeout };

const loadTs = require('./load-ts.cjs');
const { godCommand } = loadTs('src/main/kittySatellite.ts');
const { useStore } = loadTs('src/renderer/src/store/store.ts');
const {
  DEFAULT_HIRE_PERMISSION_MODE,
  permissionModeArgs
} = loadTs('src/shared/agentProvider.ts');

// ── 1) god co-terminal ───────────────────────────────────────────────────

const withTempXdg = (run) => {
  const dir = mkdtempSync(join(tmpdir(), 'perm-mode-xdg-'));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    mkdirSync(join(dir, 'munder-difflin'), { recursive: true });
    return run(join(dir, 'munder-difflin', 'config.json'));
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
};

test('god co-terminal defaults to Claude Auto, not bypass', () => {
  withTempXdg((cfgPath) => {
    writeFileSync(cfgPath, JSON.stringify({ defaultCommand: 'claude' }));
    const { file, args } = godCommand();
    assert.equal(file, 'claude');
    assert.deepEqual(args, ['--permission-mode', 'auto'],
      'the satellite god mirrors the in-app god default (Claude Auto)');
  });
});

test('god co-terminal respects a typed --permission-mode, never doubles', () => {
  withTempXdg((cfgPath) => {
    writeFileSync(cfgPath, JSON.stringify({ defaultCommand: 'claude --permission-mode acceptEdits' }));
    const { args } = godCommand();
    assert.deepEqual(args, ['--permission-mode', 'acceptEdits']);
  });
});

// ── 2) persistence slim keeps the stored choice ──────────────────────────

const agent = (id, extra = {}) => ({
  id, name: id, character: 'jim', accent: 'coral', description: '',
  project: 'p', tmuxTarget: '', cwd: '/tmp', command: 'claude',
  status: 'idle', action: 'idle', progress: 0, ...extra
});

test('a restorable agent keeps its stored permissionMode through the slim', () => {
  useStore.setState({
    agents: [], archivedAgents: [],
    restorableAgents: [agent('stefans-pick', { permissionMode: 'bypass' }), agent('other-worker')]
  });
  // Archiving an UNRELATED agent re-persists the remaining restorable list.
  useStore.getState().archiveAgent('other-worker');
  const saved = JSON.parse(memoryStorage.getItem('cth.restorableAgents'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].permissionMode, 'bypass',
    'the slim must never grow a permissionMode strip — restarts read this field');
});

// ── 3) spawnAgentCore resolution mirror ───────────────────────────────────

test('resolution: stored mode wins; legacy agents fall back to Claude Auto, never bypass', () => {
  // Mirrors spawnAgentCore: const mode = opts.permissionMode ?? DEFAULT_HIRE_PERMISSION_MODE
  const argvFor = (storedMode) => {
    const cmd = 'claude --model claude-sonnet-5';
    const mode = storedMode ?? DEFAULT_HIRE_PERMISSION_MODE;
    return [...['claude', '--model', 'claude-sonnet-5'], ...permissionModeArgs(cmd, undefined, mode)];
  };
  assert.deepEqual(argvFor('bypass'),
    ['claude', '--model', 'claude-sonnet-5', '--dangerously-skip-permissions']);
  assert.deepEqual(argvFor('default'),
    ['claude', '--model', 'claude-sonnet-5']);
  assert.deepEqual(argvFor(undefined),
    ['claude', '--model', 'claude-sonnet-5', '--permission-mode', 'auto'],
    'legacy agents (hired before the selector) restart in Claude Auto, not bypass');
});
