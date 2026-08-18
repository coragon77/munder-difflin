'use strict';
/**
 * Tool detection for the Prerequisites panel (card
 * agent-prerequisites-panel-live-2026-08-18): detection is a pure
 * existsSync PATH-walk (never a spawn — the page must never hang the UI or
 * the main process), and it must say MISSING when a binary exists somewhere
 * the harness cannot reach, because the harness spawns via PATH.
 *
 * Run with `node --test test/tool-detect.test.cjs`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { detectToolPath, probeVersion, defaultExtraDirs } = loadTs('src/main/toolStatus.ts');
const { toolCatalog } = loadTs('src/shared/toolCatalog.ts');

/** Fake env: `present` lists the exact candidate paths that "exist on disk". */
function env(platform, pathEnv, present, extraDirs = []) {
  const wanted = new Set(present.map((p) => path.normalize(p)));
  return {
    platform,
    pathEnv,
    extraDirs,
    exists: (p) => wanted.has(path.normalize(p)),
  };
}

test('a tool ON the PATH is found at its resolved path', () => {
  const e = env('linux', '/usr/x/bin:/opt/y/bin', [path.join('/opt/y/bin', 'pi')]);
  assert.equal(detectToolPath('pi', e), path.join('/opt/y/bin', 'pi'));
});

test('the FIRST PATH hit wins (earlier dir beats later dir)', () => {
  const e = env('linux', '/a:/b', [path.join('/a', 'git'), path.join('/b', 'git')]);
  assert.equal(detectToolPath('git', e), path.join('/a', 'git'));
});

test('an ABSENT tool resolves to null', () => {
  const e = env('linux', '/usr/bin:/usr/local/bin', []);
  assert.equal(detectToolPath('claude', e), null);
});

test('a tool present but NOT on the PATH is reported missing', () => {
  // The binary exists on disk, but nowhere the harness would look for it:
  // "installed but unreachable" and "missing" are the same failure for a
  // PATH-based spawn, and the panel must say so.
  const e = env('linux', '/usr/bin', [path.join('/private/stash', 'uv')]);
  assert.equal(detectToolPath('uv', e), null);
});

test('...unless it sits in one of the fixed candidate dirs (spawn parity)', () => {
  // resolveCommand falls back to ~/.local/bin etc.; detection must agree, or
  // the panel would say MISSING for a binary the harness spawns fine.
  const e = env(
    'linux',
    '/usr/bin',
    [path.join('/home/u/.local/bin', 'uv')],
    ['/home/u/.local/bin'],
  );
  assert.equal(detectToolPath('uv', e), path.join('/home/u/.local/bin', 'uv'));
});

test('win32 walks PATHEXT extensions and the semicolon separator', () => {
  const e = env('win32', 'C:\\bin;D:\\other', [path.join('C:\\bin', 'codex.cmd')]);
  assert.equal(detectToolPath('codex', e), path.join('C:\\bin', 'codex.cmd'));
});

test('defaultExtraDirs mirrors resolveCommand fallbacks', () => {
  const dirs = defaultExtraDirs('linux', { HOME: '/home/u' });
  assert.ok(dirs.includes('/opt/homebrew/bin'));
  assert.ok(dirs.includes('/usr/local/bin'));
  assert.ok(dirs.includes(path.join('/home/u', '.local', 'bin')));
  assert.ok(!dirs.includes(''), 'an unset HOME never yields an empty dir');
});

test('the version probe is capped, async, and never rejects', async () => {
  // The running node binary stands in for a real CLI: --version prints fast.
  const v = await probeVersion(process.execPath);
  assert.ok(v && /^v\d+/.test(v), `node --version yields a version line, got ${v}`);
  // A path that cannot exist resolves undefined — never a rejection.
  assert.equal(await probeVersion('/nonexistent/bin/never'), undefined);
});

test('the catalog derives engines from the provider presets', () => {
  const cat = toolCatalog();
  const ids = cat.map((t) => t.id);
  assert.ok(ids.includes('uv') && ids.includes('mempalace') && ids.includes('git'));
  assert.ok(ids.includes('engine:pi') && ids.includes('engine:claude'));
  assert.ok(!ids.some((id) => id.includes('custom')), 'custom is never probed');
  const mempalace = cat.find((t) => t.id === 'mempalace');
  assert.equal(mempalace.bin, null, 'mempalace presence comes from the memory subsystem');
  const pi = cat.find((t) => t.id === 'engine:pi');
  assert.equal(pi.bin, 'pi');
  assert.equal(pi.kind, 'engine');
  assert.equal(pi.essential, false, 'only claude is an essential engine');
  assert.equal(cat.find((t) => t.id === 'engine:claude').essential, true);
});
