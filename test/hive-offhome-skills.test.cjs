'use strict';

/**
 * Bundled-skill discovery for off-home claude agents (card
 * agent-bundled-skills-may-never-2026-08-20).
 *
 * copyBundledSkills provisions <home>/.claude/skills on every spawn, but Claude
 * Code only discovers `.claude/skills` under a working-directory root (the cwd,
 * `--add-dir` roots, and nested subdirectories of either). When an agent's cwd
 * is NOT under its hive home (every merlin-style off-home agent) the bundled
 * skills never load — verified live: 22 off-home Creed sessions show zero
 * bundled skills while home-cwd sessions show them as directory-scoped skills.
 * The fix registers home via `--add-dir` exactly when nested discovery cannot
 * already see it (empirically confirmed against claude 2.1.221).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

test('off-home claude agent registers its home via --add-dir so bundled skills load', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-offhome-root-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'md-offhome-cwd-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const hive = new HiveManager(() => root);
  const { args } = await hive.ensureAgent(
    { id: 'offhome', name: 'O', provider: 'claude', cwd },
    {},
  );
  const i = args.indexOf('--add-dir');
  assert.ok(i !== -1, 'off-home spawn carries --add-dir');
  assert.equal(
    args[i + 1],
    path.join(root, 'hive', 'agents', 'offhome'),
    'points at the agent home',
  );
});

test('home-under-cwd claude agent gets no extra --add-dir (nested discovery covers it)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-homecwd-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hive = new HiveManager(() => root);
  // cwd === hive root: home (root/hive/agents/<id>) is a nested subdir of cwd, so
  // Claude's directory-scoped discovery already loads the skills.
  const { args } = await hive.ensureAgent(
    { id: 'godling', name: 'G', provider: 'claude', cwd: root },
    {},
  );
  assert.equal(args.indexOf('--add-dir'), -1, 'no redundant --add-dir');
});
