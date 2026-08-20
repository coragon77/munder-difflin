'use strict';

/**
 * Dispatch-time orientation injection (card agent-harness-orient-first-mus-
 * 2026-08-20, spec docs/superpowers/specs/2026-08-20-dispatch-orient-
 * injection.md §8): the pure detect-probe-render function, exercised with a
 * fake probe — this is exactly the code the generated bin/ CLIs run
 * (serialized verbatim, cardHeld pattern).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { orientationBlock } = loadTs('src/main/orientInject.ts');

const HEADER = '--- ORIENT FIRST (injected by hive-dispatch) ---';

/** Fake probe: existsSync over a set of existing paths. */
function probeOf(existing) {
  const set = new Set(existing);
  return (p) => set.has(p);
}

const MERLIN = '/opt/django/projects/merlin_hpt';
const MERLIN_DOCS = [MERLIN + '/CLAUDE.md', MERLIN + '/graphify-out/graph.json'];

test('full-path hit: a registered cwd referenced by path orients on it', () => {
  const block = orientationBlock(
    'Fix the export in ' + MERLIN + '/qbase — details on the card.',
    '',
    'claude',
    [MERLIN],
    probeOf(MERLIN_DOCS),
  );
  assert.ok(block.startsWith(HEADER), 'block carries the marker naming the injector');
  assert.match(block, new RegExp('- ' + MERLIN + ': read CLAUDE\\.md first'));
  assert.match(block, /graphify query/, 'graphify line present when graph.json exists');
});

test('basename hit: bare "merlin_hpt" with no path references the cwd', () => {
  const block = orientationBlock(
    'Run the migration on merlin_hpt after the restart window.',
    '',
    'claude',
    [MERLIN],
    probeOf(MERLIN_DOCS),
  );
  assert.match(block, new RegExp('- ' + MERLIN + ':'));
});

test('short basenames (< 6 chars) never match — generic segments are guarded', () => {
  const block = orientationBlock(
    'work on dev today',
    '',
    'claude',
    ['/opt/dev'],
    probeOf(['/opt/dev/CLAUDE.md']),
  );
  assert.equal(block, '');
});

test('deepest root wins: the registered parent does not tag everything', () => {
  const probe = probeOf(['/opt/django/projects/CLAUDE.md', ...MERLIN_DOCS]);
  const block = orientationBlock(
    'Deploy ' + MERLIN + '/qbase tonight.',
    '',
    'claude',
    ['/opt/django/projects', MERLIN],
    probe,
  );
  assert.match(block, new RegExp('- ' + MERLIN + ':'));
  assert.doesNotMatch(block, /- \/opt\/django\/projects:/, 'the shallow parent is shadowed');
});

test('upward-walk fallback: a worktree path resolves to its own AGENTS.md', () => {
  const wt = '/home/u/HarnessAgents/worktrees/rob-abc123';
  const probe = probeOf([wt + '/AGENTS.md', wt + '/src', wt + '/src/main']);
  const block = orientationBlock(
    'See ' + wt + '/src/main for the regression.',
    '',
    'pi',
    [],
    probe,
  );
  assert.match(
    block,
    new RegExp('- ' + wt + ': read AGENTS\\.md first'),
    'walk stops AT the worktree root',
  );
});

test('upward walk finds the nearest docs-carrying ANCESTOR of an existing prefix', () => {
  const probe = probeOf(['/opt/estate/CLAUDE.md', '/opt/estate/app', '/opt/estate/app/bin']);
  const block = orientationBlock('restart /opt/estate/app/bin/svc', '', 'claude', [], probe);
  assert.match(block, /- \/opt\/estate: read CLAUDE\.md first/);
});

test('both docs files: claude assignees get CLAUDE.md, others AGENTS.md', () => {
  const both = [MERLIN + '/CLAUDE.md', MERLIN + '/AGENTS.md'];
  const claude = orientationBlock('work on merlin_hpt', '', 'claude', [MERLIN], probeOf(both));
  const pi = orientationBlock('work on merlin_hpt', '', 'pi', [MERLIN], probeOf(both));
  assert.match(claude, /read CLAUDE\.md first/);
  assert.match(pi, /read AGENTS\.md first/);
});

test('graphify line appears only when graphify-out/graph.json exists', () => {
  const withGraph = orientationBlock('x ' + MERLIN, '', 'claude', [MERLIN], probeOf(MERLIN_DOCS));
  const noGraph = orientationBlock(
    'x ' + MERLIN,
    '',
    'claude',
    [MERLIN],
    probeOf([MERLIN + '/CLAUDE.md']),
  );
  assert.match(withGraph, /graphify query/);
  assert.doesNotMatch(noGraph, /graphify/);
});

test('dedupe: the same root reached twice renders ONE bullet', () => {
  const text = 'path ' + MERLIN + '/qbase and again bare merlin_hpt and cwd';
  const block = orientationBlock(text, MERLIN, 'claude', [MERLIN], probeOf(MERLIN_DOCS));
  const bullets = block.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(bullets.length, 1);
});

test("assignee's own cwd is always a candidate and renders FIRST — even when the text also references it", () => {
  const home = '/home/u/somewhere';
  // home is a REAL dir here: the S3 walk finds it (with a late text index),
  // then S4 re-adds it — it must still sort first (§3 ordering).
  const probe = probeOf([home, home + '/AGENTS.md', ...MERLIN_DOCS]);
  const block = orientationBlock('work on merlin_hpt then ' + home, home, 'pi', [MERLIN], probe);
  const bullets = block.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(bullets.length, 2, 'deduped across S3 and S4');
  assert.ok(bullets[0].startsWith('- ' + home + ':'), 'own cwd first');
  assert.ok(bullets[1].startsWith('- ' + MERLIN + ':'));
});

test('basename ambiguity: a worktree twin loses to the live checkout', () => {
  const live = '/opt/django/projects/merlin_hpt';
  const wt = '/home/u/HarnessAgents/worktrees/merlin_hpt';
  const probe = probeOf([live + '/CLAUDE.md', wt + '/CLAUDE.md']);
  const block = orientationBlock('work on merlin_hpt', '', 'claude', [live, wt], probe);
  assert.match(block, new RegExp('- ' + live + ':'));
  assert.doesNotMatch(block, /worktrees/, 'the worktree twin is suppressed');
});

test('docs-less roots drop silently — no "no docs found" noise', () => {
  const block = orientationBlock('work on ' + MERLIN, '', 'claude', [MERLIN], probeOf([]));
  assert.equal(block, '');
});

test('cap: at most 5 roots, then an explicit +N more line', () => {
  const roots = [];
  const existing = [];
  for (let i = 1; i <= 7; i++) {
    const r = '/opt/estate/proj' + i;
    roots.push(r);
    existing.push(r + '/CLAUDE.md');
  }
  const text = roots.join(' ');
  const block = orientationBlock(text, '', 'claude', roots, probeOf(existing));
  const bullets = block.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(bullets.length, 5, 'never more than 5 bullets');
  assert.match(
    block,
    /\(\+2 more directories referenced — orient in each before working there\.\)/,
  );
});

test('no truncation line when everything fits', () => {
  const block = orientationBlock('x ' + MERLIN, '', 'claude', [MERLIN], probeOf(MERLIN_DOCS));
  assert.doesNotMatch(block, /more directories/);
});

test('zero hits → empty string — the body stays byte-identical', () => {
  assert.equal(orientationBlock('please review the plan', '', 'claude', [], probeOf([])), '');
});

test('probe throwing → empty string (fail open)', () => {
  const boom = () => {
    throw new Error('disk on fire');
  };
  assert.equal(orientationBlock('work on ' + MERLIN, MERLIN, 'claude', [MERLIN], boom), '');
});

test('garbage inputs never throw', () => {
  assert.equal(orientationBlock(undefined, null, undefined, 'not-an-array', probeOf([])), '');
});
