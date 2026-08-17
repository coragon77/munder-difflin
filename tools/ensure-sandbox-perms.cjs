#!/usr/bin/env node
'use strict';
/**
 * Guarantee electron's chrome-sandbox has the SUID perms Linux demands.
 *
 * Incident 2026-08-17 ~21:15 (board.md): `npm ci` recreates node_modules, which
 * wipes the manually-configured root:root 4755 on node_modules/electron/dist/
 * chrome-sandbox (npm restores it as <user> 755). Linux Electron aborts at boot
 * with a cryptic "SUID sandbox helper" FATAL — the trap fires far from its
 * cause and nothing documented it. This check moves the failure to INSTALL
 * time, loudly: on Linux it verifies owner root + mode 4755 and, when wrong,
 * prints the two exact sudo commands and exits non-zero (it cannot self-fix —
 * the fix needs root, which the installing user doesn't have).
 *
 * Non-Linux: no-op (macOS/Windows have no SUID sandbox helper). CI runners can
 * never chown to root, so they opt out via MD_SKIP_SANDBOX_CHECK=1 (wired into
 * the release workflow's npm ci step) and get a one-line warning instead.
 *
 * Sibling of tools/ensure-pty-perms.cjs, which it deliberately is NOT like:
 * pty-perms best-effort-never-fails because it CAN fix what it finds (+x needs
 * no root); this one can only verify, so failing loud IS the service.
 *
 * Exported `checkStat({uid, mode})` is the test seam — the branch where the
 * file is root-owned 4755 (the happy path) cannot be spawned by a non-root
 * test. Required-as-module yields the function; run-as-main executes the check.
 */
const { existsSync, statSync } = require('node:fs');
const { join } = require('node:path');

/** The one acceptable state: owned by root, mode exactly 4755 (SUID rwxr-xr-x).
 *  Extra bits (setgid, group-write) fail — the kernel and Electron's own docs
 *  name 4755, and a looser match would green-light a sandboxable sandbox. */
function checkStat(stat) {
  const errs = [];
  if (stat.uid !== 0) errs.push(`owner must be root:root (found uid ${stat.uid})`);
  if ((stat.mode & 0o7777) !== 0o4755) {
    errs.push(`mode must be 4755 (found ${(stat.mode & 0o7777).toString(8)})`);
  }
  return { ok: errs.length === 0, errs };
}

if (require.main === module) {
  const TARGET = join(__dirname, '..', 'node_modules', 'electron', 'dist', 'chrome-sandbox');
  const say = (msg) => console.log(`[ensure-sandbox-perms] ${msg}`);

  if (process.platform !== 'linux') process.exit(0); // no SUID sandbox off Linux
  if (process.env.MD_SKIP_SANDBOX_CHECK === '1') {
    say(
      'WARNING: MD_SKIP_SANDBOX_CHECK=1 — chrome-sandbox perms NOT verified (CI/pipeline opt-out)',
    );
    process.exit(0);
  }
  if (!existsSync(TARGET)) process.exit(0); // no electron installed — nothing to verify

  const { ok, errs } = checkStat(statSync(TARGET));
  if (ok) {
    say('chrome-sandbox root:root 4755 ok');
    process.exit(0);
  }
  console.error(`[ensure-sandbox-perms] BROKEN chrome-sandbox perms: ${errs.join('; ')}`);
  console.error(
    '[ensure-sandbox-perms] npm ci wiped the SUID bit — the harness would FATAL at boot.',
  );
  console.error('[ensure-sandbox-perms] Fix it now (needs sudo), then re-run the install:');
  console.error(`  sudo chown root:root ${TARGET}`);
  console.error(`  sudo chmod 4755 ${TARGET}`);
  process.exit(1);
}

module.exports = { checkStat };
