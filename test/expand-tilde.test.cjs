'use strict';

/**
 * `~` is a SHELL convention — Node's fs/child_process treat it as a literal
 * directory name. Adding a project with `~/dev/foo` therefore died on
 * "cwd does not exist". expandTilde is the single shared expander that fixes it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { expandTilde } = loadTs('src/main/fs.ts');

const HOME = os.homedir();

test('expands the tilde-home forms', () => {
  assert.equal(expandTilde('~/dev/proj'), path.join(HOME, 'dev/proj'));
  assert.equal(expandTilde('~'), HOME, 'a bare ~ is a valid cwd too');
  assert.equal(expandTilde('~/'), HOME);
  assert.equal(
    expandTilde('  ~/dev/proj  '),
    path.join(HOME, 'dev/proj'),
    'pasted paths carry whitespace',
  );
});

test('leaves absolute paths alone (beyond normalizing)', () => {
  assert.equal(expandTilde('/a/b/c'), '/a/b/c');
  assert.equal(expandTilde('/a/b/c/'), '/a/b/c');
  assert.equal(expandTilde('/a/b/../c'), '/a/c');
});

test('does not touch anything that is not a tilde-home path', () => {
  assert.equal(expandTilde(''), '');
  assert.equal(expandTilde('~notauser/x'), '~notauser/x', '~user is not a form we expand');
  assert.equal(
    expandTilde('C:\\Users\\me\\proj'),
    'C:\\Users\\me\\proj',
    'windows paths must survive',
  );
});

test('a still-relative path is returned untouched, NOT resolved', () => {
  // Deliberate: resolving here would silently anchor the path to the Electron
  // process cwd. Callers keep their own "not absolute" error instead.
  assert.equal(expandTilde('relative/path'), 'relative/path');
  assert.equal(expandTilde('./rel'), './rel');
});

test('the expanded path is what fs can actually stat — the original bug', () => {
  assert.equal(fs.existsSync('~'), false, 'the literal "~" never exists on disk');
  const expanded = expandTilde('~');
  assert.equal(path.isAbsolute(expanded), true);
  assert.equal(fs.existsSync(expanded), true);
});
