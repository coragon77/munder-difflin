'use strict';

// Runs the focused test suite from test/focused.list (one file per line).
// Appending a test = adding one line there; package.json never changes.

const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const LIST = join(ROOT, 'test', 'focused.list');

const files = readFileSync(LIST, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'));

if (files.length === 0) {
  console.error('test/focused.list lists no test files');
  process.exit(1);
}

const missing = files.filter((file) => !existsSync(join(ROOT, file)));
if (missing.length > 0) {
  console.error(`test/focused.list references missing files:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: ROOT,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
