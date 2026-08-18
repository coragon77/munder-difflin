'use strict';

/**
 * waiting-label-single-source (card agent-shorten-the-agent-card-w-2026-08-18).
 *
 * The "waiting (N)" label was hand-built in FOUR independent places
 * (statusLabel.ts, useHive.ts, hive.ts roster injection, hooks.ts notify) and
 * drifted. It now has ONE builder — waitingLabel() in src/shared/waitingLabel.ts
 * (shared because two sites live in the main process, two in the renderer).
 *
 * Pins:
 *   - the wording: literally "waiting (N)", bare number, no "background tasks"
 *     suffix (operator call — closed decision, do not re-add a labelled variant);
 *   - the single source: a repo scan for any template that builds "waiting (…)"
 *     must find exactly one construction site, the shared helper. A fifth
 *     hand-rolled copy fails here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { waitingLabel } = loadTs('src/shared/waitingLabel.ts');

test('the wording is literally "waiting (N)" — bare number, no suffix', () => {
  assert.equal(waitingLabel(1), 'waiting (1)');
  assert.equal(waitingLabel(3), 'waiting (3)');
});

test('floors fractional counts (statusLabel used to floor before building)', () => {
  assert.equal(waitingLabel(2.9), 'waiting (2)');
});

test('exactly ONE place in src/ builds a "waiting (…)" label', () => {
  const root = path.join(__dirname, '..', 'src');
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        const src = fs.readFileSync(p, 'utf8');
        if (/waiting \(\$\{[^}]+\}\)/.test(src)) hits.push(path.relative(root, p));
      }
    }
  };
  walk(root);
  assert.deepEqual(hits, ['shared/waitingLabel.ts']);
});
