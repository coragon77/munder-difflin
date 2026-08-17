'use strict';

/**
 * ensure-sandbox-perms (card agent-harness-postinstall-guar-2026-08-17).
 *
 * Incident 2026-08-17 ~21:15: `npm ci` recreates node_modules, which wiped the
 * manually-configured root:root 4755 on node_modules/electron/dist/
 * chrome-sandbox — Linux Electron needs exactly that (SUID sandbox helper), so
 * the harness aborted at boot with a cryptic SUID sandbox FATAL. The trap was
 * invisible at install time and undocumented.
 *
 * The guard: tools/ensure-sandbox-perms.cjs in the postinstall chain — on
 * Linux, verify owner root + mode 4755; when wrong, print the two exact sudo
 * commands and exit non-zero (loud at INSTALL time, not cryptic at boot).
 * Non-Linux: no-op. Escape hatch MD_SKIP_SANDBOX_CHECK=1 for CI runners that
 * can never chown to root (wired into the release workflow's ubuntu leg).
 *
 * Two layers here:
 *  - unit: checkStat({uid, mode}) — every branch, including the root-owned
 *    happy path (unreachable from a spawned test as non-root);
 *  - integration: spawn the real script against a fake repo layout — exit
 *    codes, the printed fix, the escape hatch, the missing-file no-op;
 *  - wiring: the postinstall chain and the release workflow carry it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'tools', 'ensure-sandbox-perms.cjs');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const RELEASE_YML = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');

const { checkStat } = require('../tools/ensure-sandbox-perms.cjs');
// ——— unit: the permission decision ——————————————————————————————————————

test('root:root 4755 is the one happy path (ok)', () => {
  assert.deepEqual(checkStat({ uid: 0, gid: 0, mode: 0o1004755 }), { ok: true, errs: [] });
});

test('the incident: user-owned 755 fails BOTH owner and mode', () => {
  const r = checkStat({ uid: 1000, gid: 1000, mode: 0o1000755 });
  assert.equal(r.ok, false);
  assert.equal(r.errs.length, 2, 'owner AND mode are both wrong');
});

test('SUID present but user-owned still fails (owner check is independent)', () => {
  const r = checkStat({ uid: 1000, gid: 0, mode: 0o1004755 });
  assert.equal(r.ok, false);
  assert.ok(r.errs.length >= 1);
  assert.match(r.errs.join('; '), /root/i);
});

test('root-owned but no SUID still fails (mode check is independent)', () => {
  const r = checkStat({ uid: 0, gid: 0, mode: 0o1000755 });
  assert.equal(r.ok, false);
  assert.match(r.errs.join('; '), /4755/);
});

test('sticky/group-write variants do not sneak past the exact mode', () => {
  // 4775 (group-writable) and 6755 (setgid too) must both fail.
  assert.equal(checkStat({ uid: 0, gid: 0, mode: 0o1004775 }).ok, false);
  assert.equal(checkStat({ uid: 0, gid: 0, mode: 0o1006755 }).ok, false);
});

// ——— integration: the real script against a fake repo layout ————————————

/** Build a tmp repo: tools/<script> + node_modules/electron/dist/chrome-sandbox
 *  with the given mode (owned by the CURRENT user — good enough: anything not
 *  created by root fails the owner check, which is exactly the incident). */
function fakeRepo(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-sbx-'));
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(dir, 'tools', 'ensure-sandbox-perms.cjs'));
  const target = path.join(dir, 'node_modules', 'electron', 'dist');
  fs.mkdirSync(target, { recursive: true });
  const sbx = path.join(target, 'chrome-sandbox');
  fs.writeFileSync(sbx, 'fake');
  if (mode !== undefined) fs.chmodSync(sbx, mode);
  return dir;
}

function runScript(cwd, env = {}) {
  const r = spawnSync(process.execPath, ['tools/ensure-sandbox-perms.cjs'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('wrong perms (the incident) → exit 1 and BOTH exact sudo commands printed', () => {
  const dir = fakeRepo(0o755); // current user, no SUID — sfuchs:755
  const { code, out } = runScript(dir);
  assert.equal(code, 1, 'install must FAIL LOUD, not pass silently');
  assert.match(out, /sudo chown root:root .*chrome-sandbox/);
  assert.match(out, /sudo chmod 4755 .*chrome-sandbox/);
});

test('SUID set but user-owned → still exit 1 (owner half alone is fatal)', () => {
  const dir = fakeRepo(0o4755);
  const { code, out } = runScript(dir);
  assert.equal(code, 1);
  assert.match(out, /sudo chown root:root/);
});

test('escape hatch MD_SKIP_SANDBOX_CHECK=1 → exit 0 with a one-line warning', () => {
  const dir = fakeRepo(0o755);
  const { code, out } = runScript(dir, { MD_SKIP_SANDBOX_CHECK: '1' });
  assert.equal(code, 0);
  assert.match(out, /MD_SKIP_SANDBOX_CHECK/);
  assert.match(out, /warn|skip/i);
});

test('missing chrome-sandbox → exit 0 (nothing to verify, mirrors ensure-pty-perms)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-sbx-'));
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(dir, 'tools', 'ensure-sandbox-perms.cjs'));
  const { code } = runScript(dir);
  assert.equal(code, 0);
});

// ——— wiring: postinstall chain + CI escape hatch ————————————————————————

test('postinstall chain runs the guard', () => {
  assert.match(
    PKG.scripts.postinstall,
    /node tools\/ensure-sandbox-perms\.cjs/,
    'the guard must ride the postinstall chain',
  );
});

test('the release workflow (ubuntu leg runs npm ci) sets the escape hatch', () => {
  const m = /- name: Install dependencies\n\s+run: npm ci\n((?:\s+env:.*\n(?:\s{6,}.*\n)*))?/.exec(
    RELEASE_YML,
  );
  assert.ok(m, 'release.yml still has an npm ci step');
  const step = m[0];
  assert.match(
    step,
    /MD_SKIP_SANDBOX_CHECK/,
    'npm ci in release.yml must set MD_SKIP_SANDBOX_CHECK — GH runners can never chown to root',
  );
});

test('the happy path is reachable on this machine only as root — sanity', () => {
  // meta-test: documents WHY the happy path is unit-tested, not spawned.
  if (process.getuid && process.getuid() === 0) return; // running under sudo — fine
  const dir = fakeRepo(0o4755);
  const { code } = runScript(dir);
  assert.equal(code, 1, 'non-root-created file must fail the owner check');
});
