'use strict';

// remove-end-vacation-button-20260816: the VACATION shelf renders Recall only.
// Stefan's flow — Recall, then the agent pane's Archive button — covers what
// End vacation did, without the name reading like a second recall. This file
// pins the REMOVAL across all four layers (button, preload bridge, IPC verb,
// store action). Source-text pins because the repo has no DOM harness — the
// store-half behavior lives in vacation-store.test.cjs.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('vacation shelf renders Recall only, keeps no delete X, and stays off the ARCHIVED shelf', () => {
  const src = read('src/renderer/src/components/CommandCenterPanel.tsx');
  const vac = src.slice(
    src.indexOf('function VacationSection'),
    src.indexOf('function ArchivedSection'),
  );
  assert.ok(vac.includes("'Recall'"), 'Recall button stays');
  assert.ok(!vac.includes('End vacation'), 'End vacation button is gone');
  assert.ok(!vac.includes('hiveEndVacation'), 'no end-vacation IPC call remains');
  assert.ok(!vac.includes('name="x"'), 'vacationer cards render no delete X');
  // The guard's rendering half: plain ARCHIVED only shows non-vacationers, so
  // the X can never reach a vacationer even if the lists drift.
  assert.ok(
    src.includes('archived.filter((a) => !a.vacation)'),
    'ARCHIVED section still excludes vacationers from its delete X',
  );
});

test('the end-vacation verb is gone from every layer', () => {
  assert.ok(!read('src/main/index.ts').includes('hive:endVacation'), 'no IPC handler');
  assert.ok(!read('src/preload/index.ts').includes('hiveEndVacation'), 'no preload bridge');
  assert.ok(
    !read('src/renderer/src/store/store.ts').includes('endVacationAgent'),
    'no store action',
  );
});
