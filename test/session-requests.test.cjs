'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// The watcher module is dependency-injected (like realtimeActions.ts), so tests
// drive it with a fake hive: tmp-dir root, in-memory registry, spy emit.
const { composeSessionCommand, processSessionRequest, sessionRequestsDir } = loadTs(
  'src/main/sessionRequests.ts',
);

// — request validation + queued command composition —

test('compose: clear composes the provider table clear command (claude → /clear)', () => {
  assert.deepEqual(composeSessionCommand({ agentId: 'x', verb: 'clear' }, 'claude'), {
    ok: true,
    command: '/clear',
  });
});

test('compose: grok clear is /new (the provider table, not a hardcoded /clear)', () => {
  assert.deepEqual(composeSessionCommand({ agentId: 'x', verb: 'clear' }, 'grok'), {
    ok: true,
    command: '/new',
  });
});

test('compose: unknown/undefined provider defaults to claude semantics', () => {
  assert.deepEqual(composeSessionCommand({ agentId: 'x', verb: 'clear' }, undefined), {
    ok: true,
    command: '/clear',
  });
});

test('compose: resume carries the sessionId verbatim', () => {
  assert.deepEqual(
    composeSessionCommand({ agentId: 'x', verb: 'resume', sessionId: '  abc-123  ' }, 'claude'),
    { ok: true, command: '/resume abc-123' },
  );
});

test('compose: bad verb is rejected', () => {
  const r = composeSessionCommand({ agentId: 'x', verb: 'restart' }, 'claude');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /verb/);
});

test('compose: resume without sessionId is rejected', () => {
  const r = composeSessionCommand({ agentId: 'x', verb: 'resume' }, 'claude');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /sessionId/);
});

test('compose: sessionId on clear is rejected (resume-only field)', () => {
  const r = composeSessionCommand({ agentId: 'x', verb: 'clear', sessionId: 'abc' }, 'claude');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /clear/);
});

// — processSessionRequest: validation, archival, IPC emission —

function fakeDeps(tmp, { agents = {}, ptys = {}, emitResult = true } = {}) {
  const emitted = [];
  const informs = [];
  return {
    deps: {
      root: () => tmp,
      registry: () => ({ agents }),
      ptyForAgent: (id) => ptys[id],
      emit: (agentId, text) => {
        emitted.push({ agentId, text });
        return emitResult;
      },
      informGod: (subject, body) => informs.push({ subject, body }),
    },
    emitted,
    informs,
  };
}

function drop(tmp, name, obj) {
  const fp = path.join(sessionRequestsDir(tmp), `${name}.json`);
  fs.writeFileSync(fp, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return fp;
}

function arch(tmp, sub, name) {
  return path.join(sessionRequestsDir(tmp), sub, `${name}.json`);
}

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-req-'));
  fs.mkdirSync(sessionRequestsDir(tmp), { recursive: true });
  return tmp;
}

const LIVE = { provider: 'claude' }; // registry entry shape the watcher reads

test('valid clear request: emits the composed command and archives .done', () => {
  const tmp = setup();
  const { deps, emitted, informs } = fakeDeps(tmp, {
    agents: { 'agent-x': { ...LIVE, archived: false } },
    ptys: { 'agent-x': 'pty-1' },
  });
  const fp = drop(tmp, 'ok', { agentId: 'agent-x', verb: 'clear' });

  processSessionRequest(fp, deps);

  assert.deepEqual(emitted, [{ agentId: 'agent-x', text: '/clear' }]);
  assert.equal(fs.existsSync(arch(tmp, '.done', 'ok')), true, 'archived to .done');
  assert.equal(informs.length, 0, 'no failure inform on success');
});

test('valid resume request: emits /resume <sessionId>', () => {
  const tmp = setup();
  const { deps, emitted } = fakeDeps(tmp, {
    agents: { 'agent-x': LIVE },
    ptys: { 'agent-x': 'pty-1' },
  });
  const fp = drop(tmp, 'res', { agentId: 'agent-x', verb: 'resume', sessionId: 'deadbeef-0000' });

  processSessionRequest(fp, deps);

  assert.deepEqual(emitted, [{ agentId: 'agent-x', text: '/resume deadbeef-0000' }]);
  assert.equal(fs.existsSync(arch(tmp, '.done', 'res')), true);
});

test('unparseable JSON → .failed + god informed, nothing emitted', () => {
  const tmp = setup();
  const { deps, emitted, informs } = fakeDeps(tmp, {
    agents: { 'agent-x': LIVE },
    ptys: { 'agent-x': 'pty-1' },
  });
  const fp = drop(tmp, 'bad', '{not json');

  processSessionRequest(fp, deps);

  assert.equal(emitted.length, 0);
  assert.equal(fs.existsSync(arch(tmp, '.failed', 'bad')), true);
  assert.equal(informs.length, 1);
});

test('unknown agent → .failed with reason', () => {
  const tmp = setup();
  const { deps, informs } = fakeDeps(tmp, { agents: {}, ptys: {} });
  const fp = drop(tmp, 'ghost', { agentId: 'nobody', verb: 'clear' });

  processSessionRequest(fp, deps);

  assert.equal(fs.existsSync(arch(tmp, '.failed', 'ghost')), true);
  assert.match(informs[0].body, /no agent/);
});

test('archived agent → .failed (card: "agent exists, not archived")', () => {
  const tmp = setup();
  const { deps, informs } = fakeDeps(tmp, {
    agents: { 'agent-x': { ...LIVE, archived: true } },
    ptys: { 'agent-x': 'pty-1' },
  });
  const fp = drop(tmp, 'arch', { agentId: 'agent-x', verb: 'clear' });

  processSessionRequest(fp, deps);

  assert.equal(fs.existsSync(arch(tmp, '.failed', 'arch')), true);
  assert.match(informs[0].body, /archived/);
});

test('retired agent → .failed (retirement implies off-floor)', () => {
  const tmp = setup();
  const { deps } = fakeDeps(tmp, {
    agents: { 'agent-x': { ...LIVE, retired: true } },
    ptys: { 'agent-x': 'pty-1' },
  });
  const fp = drop(tmp, 'ret', { agentId: 'agent-x', verb: 'clear' });

  processSessionRequest(fp, deps);

  assert.equal(fs.existsSync(arch(tmp, '.failed', 'ret')), true);
});

test('no live pane → .failed (the command could never be delivered)', () => {
  const tmp = setup();
  const { deps, informs } = fakeDeps(tmp, { agents: { 'agent-x': LIVE }, ptys: {} });
  const fp = drop(tmp, 'nopane', { agentId: 'agent-x', verb: 'clear' });

  processSessionRequest(fp, deps);

  assert.equal(fs.existsSync(arch(tmp, '.failed', 'nopane')), true);
  assert.match(informs[0].body, /no live pane/i);
});

test('emit refused (no floor window) → .failed, request survives for retry', () => {
  const tmp = setup();
  const { deps } = fakeDeps(tmp, {
    agents: { 'agent-x': LIVE },
    ptys: { 'agent-x': 'pty-1' },
    emitResult: false,
  });
  const fp = drop(tmp, 'nowin', { agentId: 'agent-x', verb: 'clear' });

  processSessionRequest(fp, deps);

  assert.equal(fs.existsSync(arch(tmp, '.failed', 'nowin')), true);
});

test('missing agentId → .failed', () => {
  const tmp = setup();
  const { deps, informs } = fakeDeps(tmp, {
    agents: { 'agent-x': LIVE },
    ptys: { 'agent-x': 'pty-1' },
  });
  const fp = drop(tmp, 'noid', { verb: 'clear' });

  processSessionRequest(fp, deps);

  assert.equal(fs.existsSync(arch(tmp, '.failed', 'noid')), true);
  assert.match(informs[0].body, /agentId/);
});
