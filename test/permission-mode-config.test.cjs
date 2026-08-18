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
};

const loadTs = require('./load-ts.cjs');
const { godCommand } = loadTs('src/main/kittySatellite.ts');
const { useStore } = loadTs('src/renderer/src/store/store.ts');
const { DEFAULT_HIRE_PERMISSION_MODE, permissionModeArgs, resolveHirePermissionMode } = loadTs(
  'src/shared/agentProvider.ts',
);

// ── 1) god co-terminal ───────────────────────────────────────────────────

const withTempXdg = (run) => {
  const dir = mkdtempSync(join(tmpdir(), 'perm-mode-xdg-'));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    mkdirSync(join(dir, 'munder-difflin'), { recursive: true });
    return run(join(dir, 'munder-difflin', 'config.json'));
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
};

test('god co-terminal defaults to Claude Auto, not bypass', () => {
  withTempXdg((cfgPath) => {
    writeFileSync(cfgPath, JSON.stringify({ defaultCommand: 'claude' }));
    // Identity resolver: this test pins the permission-mode argv, not binary
    // resolution (which is machine-dependent — see section 6 below).
    const { file, args } = godCommand((c) => c);
    assert.equal(file, 'claude');
    assert.deepEqual(
      args,
      ['--permission-mode', 'auto', '--disallowedTools', 'AskUserQuestion'],
      'the satellite god mirrors the in-app god default (Claude Auto)',
    );
  });
});

test('god co-terminal respects a typed --permission-mode, never doubles', () => {
  withTempXdg((cfgPath) => {
    writeFileSync(
      cfgPath,
      JSON.stringify({ defaultCommand: 'claude --permission-mode acceptEdits' }),
    );
    const { args } = godCommand();
    assert.deepEqual(args, [
      '--permission-mode',
      'acceptEdits',
      '--disallowedTools',
      'AskUserQuestion',
    ]);
  });
});

// ── 2) persistence slim keeps the stored choice ──────────────────────────

const agent = (id, extra = {}) => ({
  id,
  name: id,
  character: 'jim',
  accent: 'coral',
  description: '',
  project: 'p',
  tmuxTarget: '',
  cwd: '/tmp',
  command: 'claude',
  status: 'idle',
  action: 'idle',
  progress: 0,
  ...extra,
});

test('a restorable agent keeps its stored permissionMode through the slim', () => {
  useStore.setState({
    agents: [],
    archivedAgents: [],
    restorableAgents: [agent('stefans-pick', { permissionMode: 'bypass' }), agent('other-worker')],
  });
  // Archiving an UNRELATED agent re-persists the remaining restorable list.
  useStore.getState().archiveAgent('other-worker');
  const saved = JSON.parse(memoryStorage.getItem('cth.restorableAgents'));
  assert.equal(saved.length, 1);
  assert.equal(
    saved[0].permissionMode,
    'bypass',
    'the slim must never grow a permissionMode strip — restarts read this field',
  );
});

// ── 3) spawnAgentCore resolution mirror ───────────────────────────────────

// ── 4) registry fallback rung (card god-boot-ignores-permission-mode-20260816)
// The real helper spawnAgentCore calls (not a mirror): a spawn carrying no
// explicit mode must fall back to the STORED registry record before the
// Claude-Auto default — that record is how an operator-set god bypass
// survives restarts when the god boot (which never sends a mode) re-spawns.

test('resolution helper exists as real shared code', () => {
  assert.equal(typeof resolveHirePermissionMode, 'function');
});

test('registry rung: no explicit mode + stored bypass => bypass argv', () => {
  const mode = resolveHirePermissionMode(undefined, 'bypass');
  assert.equal(mode, 'bypass');
  // The argv spawnAgentCore assembles: opts WITHOUT permissionMode + registry
  // record 'bypass' => the bypass flag lands in the injected args.
  assert.deepEqual(permissionModeArgs('claude --model m', 'claude', mode), [
    '--dangerously-skip-permissions',
  ]);
});

test('registry rung: record with no stored mode => unchanged Claude-Auto default', () => {
  const mode = resolveHirePermissionMode(undefined, undefined);
  assert.equal(mode, DEFAULT_HIRE_PERMISSION_MODE);
  assert.deepEqual(permissionModeArgs('claude --model m', 'claude', mode), [
    '--permission-mode',
    'auto',
  ]);
});

test('registry rung: an explicit spawn mode still wins over the record', () => {
  // god's spawn-requests send workerBypass ? 'bypass' : 'default' — that
  // explicit choice must never be overridden by a stale registry record.
  assert.equal(resolveHirePermissionMode('default', 'bypass'), 'default');
  assert.equal(resolveHirePermissionMode('bypass', undefined), 'bypass');
});

// ── 5) god co-terminal prefers the registry god record (same authority as the
//      in-app boot's new fallback rung) —

const withGodRegistry = (godRecord, defaultCommand = 'claude') =>
  withTempXdg((cfgPath) => {
    const hive = mkdtempSync(join(tmpdir(), 'perm-mode-hive-'));
    writeFileSync(cfgPath, JSON.stringify({ defaultCommand, harnessHome: hive }));
    mkdirSync(join(hive, 'agents', 'god'), { recursive: true });
    writeFileSync(
      join(hive, 'registry.json'),
      JSON.stringify({
        godId: 'god',
        agents: { god: { id: 'god', isGod: true, cwd: hive, ...godRecord } },
      }),
    );
    return godCommand();
  });

test('god co-terminal: registry god bypass => bypass flag, not Claude Auto', () => {
  const { args } = withGodRegistry({ permissionMode: 'bypass' });
  assert.ok(args.includes('--dangerously-skip-permissions'), `got ${JSON.stringify(args)}`);
  assert.ok(!args.includes('auto'), 'stored bypass must replace the blanket auto default');
});

test('god co-terminal: no registry record => unchanged Claude-Auto default', () => {
  const { args } = withGodRegistry({});
  assert.deepEqual(args, ['--permission-mode', 'auto', '--disallowedTools', 'AskUserQuestion']);
});

test('god co-terminal: registry stored default mode => no flag at all', () => {
  const { args } = withGodRegistry({ permissionMode: 'default' });
  assert.deepEqual(args, ['--disallowedTools', 'AskUserQuestion']);
});

test('god co-terminal: a typed --permission-mode beats the registry record', () => {
  const { args } = withGodRegistry(
    { permissionMode: 'bypass' },
    'claude --permission-mode acceptEdits',
  );
  assert.deepEqual(args, [
    '--permission-mode',
    'acceptEdits',
    '--disallowedTools',
    'AskUserQuestion',
  ]);
});

test('resolution: stored mode wins; legacy agents fall back to Claude Auto, never bypass', () => {
  // Mirrors spawnAgentCore: const mode = opts.permissionMode ?? DEFAULT_HIRE_PERMISSION_MODE
  const argvFor = (storedMode) => {
    const cmd = 'claude --model claude-sonnet-5';
    const mode = storedMode ?? DEFAULT_HIRE_PERMISSION_MODE;
    return [
      ...['claude', '--model', 'claude-sonnet-5'],
      ...permissionModeArgs(cmd, undefined, mode),
    ];
  };
  assert.deepEqual(argvFor('bypass'), [
    'claude',
    '--model',
    'claude-sonnet-5',
    '--dangerously-skip-permissions',
  ]);
  assert.deepEqual(argvFor('default'), ['claude', '--model', 'claude-sonnet-5']);
  assert.deepEqual(
    argvFor(undefined),
    ['claude', '--model', 'claude-sonnet-5', '--permission-mode', 'auto'],
    'legacy agents (hired before the selector) restart in Claude Auto, not bypass',
  );
});

// ── 6) god co-terminal binary resolution (card kitty-satellite-button-only-20260816)
// kitty is not a login shell — an nvm-installed bare `claude` died with
// "executable file not found in $PATH". The engine token must go through the
// same login-shell resolver the PTYs use; the bash fallback (always on PATH)
// never needs it.

test('god co-terminal resolves the engine binary through the login-shell resolver', () => {
  withTempXdg((cfgPath) => {
    writeFileSync(cfgPath, JSON.stringify({ defaultCommand: 'claude --model sonnet' }));
    const { file, args, cwd } = godCommand(() => '/nvm/versions/node/v24/bin/claude');
    assert.equal(file, '/nvm/versions/node/v24/bin/claude');
    assert.deepEqual(args, [
      '--model',
      'sonnet',
      '--permission-mode',
      'auto',
      '--disallowedTools',
      'AskUserQuestion',
    ]);
    assert.equal(cwd, null, 'no harnessHome in config → no god cwd');
  });
});

test('god co-terminal passes an explicit path token straight through', () => {
  withTempXdg((cfgPath) => {
    writeFileSync(cfgPath, JSON.stringify({ defaultCommand: '/opt/engines/claude' }));
    // resolveCommand's own contract: path-like tokens come back untouched.
    // (god-pi-switch-2026-08-18): the engine now resolves from config
    // godProvider (absent → claude), so a claude-at-a-path defaultCommand gets
    // the SAME unattended-orchestrator flags as bare `claude` — the old
    // parts[0]-sniff sent a path-form claude to the satellite naked.
    const seen = [];
    const { file, args } = godCommand((c) => {
      seen.push(c);
      return c;
    });
    assert.deepEqual(seen, ['/opt/engines/claude']);
    assert.equal(file, '/opt/engines/claude');
    assert.deepEqual(args, ['--permission-mode', 'auto', '--disallowedTools', 'AskUserQuestion']);
  });
});

test('god co-terminal without config falls back to plain bash, unresolved', () => {
  withTempXdg(() => {
    const { file, args } = godCommand((c) => `/resolved/${c}`);
    assert.equal(file, 'bash', 'the fallback shell never goes through the resolver');
    assert.deepEqual(args, []);
  });
});
