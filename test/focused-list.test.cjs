'use strict';

const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');

const ROOT = join(__dirname, '..');
const LIST = join(ROOT, 'test', 'focused.list');

test('focused.list lists one existing file per line, no blanks or duplicates', () => {
  assert.ok(existsSync(LIST), 'test/focused.list must exist');
  const lines = readFileSync(LIST, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  assert.ok(lines.length > 0, 'test/focused.list must not be empty');
  for (const line of lines) {
    assert.ok(!/\s/.test(line), `one path per line: "${line}"`);
    assert.ok(existsSync(join(ROOT, line)), `listed file missing: ${line}`);
  }
  assert.equal(new Set(lines).size, lines.length, 'duplicate entries in focused.list');
});

test('package.json test:focused delegates to the list runner, not an inline file list', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['test:focused'], 'node tools/test-focused.cjs');
});
