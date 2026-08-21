'use strict';

/**
 * VACATION-POOL PRIMITIVES (card agent-hive-park-hive-recall-ga-2026-08-19).
 *
 * bin/hive-park + bin/hive-recall, emitted from harness constants (like
 * hive-hire/hive-fire), tested by RUNNING the emitted scripts against a fake
 * HIVE_ROOT. The point of the card is the GATE, not the file write:
 *
 *  - park REFUSES pinned agents, agents holding a doing card, god, interns,
 *    the retired, archived agents, already-parked agents, and unknown ids —
 *    each with a distinct message naming the gate — and it REFUSES without
 *    writing a request file when any gate fires.
 *  - park requires --reason (it lands in the vacation log as god's
 *    done-evidence record).
 *  - the happy path writes a well-formed vacation-request the existing
 *    watcher accepts unchanged ({agentId, reason}); --when-quiet passes
 *    "whenQuiet": true through verbatim (held+retried while busy), and the
 *    field is ABSENT without the flag (the watcher's strict-true check).
 *  - recall REFUSES unknown ids, agents not on vacation, and the retired;
 *    its happy path writes {agentId, action:'recall'} — the watcher's
 *    contract, untouched.
 *
 * The ONE gate deliberately NOT mechanised: "positive done evidence" — that
 * judgement stays god's; there is no idle-time proxy here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.join(__dirname, '..');

// Same extraction machinery as intern-hire-fire.test.cjs: the CLIs live in
// src/main/hive.ts as template-literal constants; bootstrap EVALUATES them,
// so undo the one template escape (\\n -> \n) the raw copy keeps.
function templateOf(name) {
  const src = fs.readFileSync(path.join(repoRoot, 'src/main/hive.ts'), 'utf8');
  const marker = `const ${name} = \``;
  const at = src.indexOf(marker);
  assert.ok(at > 0, `${name} constant exists in src/main/hive.ts`);
  const end = src.indexOf('\n`;', at);
  return src
    .slice(at + src.slice(at).indexOf('`') + 1, end)
    .split('\\\\n')
    .join('\\n');
}

const GUARD_TOKEN = '${' + 'ASSERT_LIVE_HIVE}';
function cliSource(name) {
  const raw = templateOf(name);
  return raw.includes(GUARD_TOKEN)
    ? raw.split(GUARD_TOKEN).join(templateOf('ASSERT_LIVE_HIVE'))
    : raw;
}

function withFakeHive(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'park-recall-'));
  fs.mkdirSync(path.join(root, 'vacation-requests'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'registry.json'),
    JSON.stringify({
      godId: 'god',
      agents: {
        god: { id: 'god', name: 'God', role: 'god', isGod: true, cwd: '/tmp' },
        'pam-1': { id: 'pam-1', name: 'Pam', role: 'agent', cwd: '/tmp' },
        'pin-1': { id: 'pin-1', name: 'Pin', role: 'agent', cwd: '/tmp', pinned: true },
        'busy-1': { id: 'busy-1', name: 'Busy', role: 'agent', cwd: '/tmp' },
        'parked-1': {
          id: 'parked-1',
          name: 'Parked',
          role: 'agent',
          cwd: '/tmp',
          vacation: true,
          archived: true,
          vacationSince: Date.now(),
        },
        'arch-1': { id: 'arch-1', name: 'Arch', role: 'agent', cwd: '/tmp', archived: true },
        'intern-docs': { id: 'intern-docs', name: 'Docs (Intern)', role: 'intern', cwd: '/tmp' },
        'ret-1': { id: 'ret-1', name: 'Ret', role: 'agent', cwd: '/tmp', retired: true },
      },
    }),
  );
  fs.writeFileSync(
    path.join(root, 'tasks.json'),
    JSON.stringify({
      tasks: [
        { id: 'card-open', title: 'open', status: 'doing', assignee: 'busy-1' },
        { id: 'card-other', title: 'someone else', status: 'doing', assignee: 'pam-1x' },
        { id: 'card-done', title: 'done one', status: 'done', assignee: 'busy-1' },
      ],
    }),
  );
  return fn(root);
}

function runCli(name, args, root) {
  const file = path.join(root, `${name}.run.cjs`);
  fs.writeFileSync(file, cliSource(name).replace(/^#!.*\n/, ''));
  try {
    const out = execFileSync('node', [file, ...args], {
      env: { ...process.env, HIVE_ROOT: root, AGENT_ID: 'god' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, out: out.toString(), err: '' };
  } catch (e) {
    return {
      code: e.status ?? 1,
      out: (e.stdout ?? '').toString(),
      err: (e.stderr ?? '').toString(),
    };
  }
}

function requestFiles(root) {
  return fs
    .readdirSync(path.join(root, 'vacation-requests'))
    .filter((f) => f.endsWith('.json'))
    .sort();
}

/** Write a fleet.json the busy pre-flight can read (card
 *  agent-hive-park-reports-succes-2026-08-21). ts defaults to now — a FRESH
 *  fleet, as the worker tick (seconds) keeps it on a live floor. */
function withFleet(root, agents, ts = Date.now()) {
  fs.writeFileSync(path.join(root, 'fleet.json'), JSON.stringify({ ts, agents }));
}

// ─── hive-park: the busy pre-flight (card agent-hive-park-reports-succes-2026-08-21) ──
// The receipt promises "parks it on the next tick", but the watcher's busy
// gate can still refuse the request ~2s later — and the rejection mail drowns
// in god's inbox (the card's "reports success and silently does nothing").
// The pre-flight mirrors the gate's two fleet-visible inputs and refuses UP
// FRONT instead of queueing a request the watcher will bounce.

test('hive-park REFUSES a busy-by-census agent up front and writes nothing', () => {
  withFakeHive((root) => {
    withFleet(root, [{ id: 'pam-1', pendingBackgroundWork: 1, lastActiveSecAgo: 600 }]);
    const r = runCli('HIVE_PARK_CLI', ['pam-1', '--reason', 'done, no open card'], root);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /busy/);
    assert.match(r.err, /1 pending background task/);
    assert.match(r.err, /--when-quiet/, 'points at the hold instead of a silent bounce');
    assert.equal(requestFiles(root).length, 0, 'refusal writes no request');
  });
});

test('hive-park REFUSES a telemetry-active agent (fresh lastActiveSecAgo) up front', () => {
  withFakeHive((root) => {
    withFleet(root, [{ id: 'pam-1', pendingBackgroundWork: 0, lastActiveSecAgo: 5 }]);
    const r = runCli('HIVE_PARK_CLI', ['pam-1', '--reason', 'done'], root);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /busy/);
    assert.equal(requestFiles(root).length, 0, 'refusal writes no request');
  });
});

test('hive-park --when-quiet QUEUES despite the busy pre-flight — the hold IS the busy mechanism', () => {
  withFakeHive((root) => {
    withFleet(root, [{ id: 'pam-1', pendingBackgroundWork: 2, lastActiveSecAgo: 3 }]);
    const r = runCli('HIVE_PARK_CLI', ['pam-1', '--reason', 'end of turn', '--when-quiet'], root);
    assert.equal(r.code, 0, r.err);
    const req = JSON.parse(
      fs.readFileSync(path.join(root, 'vacation-requests', requestFiles(root)[0]), 'utf8'),
    );
    assert.equal(req.whenQuiet, true);
  });
});

test('hive-park happy path with a QUIET fleet row still queues normally', () => {
  withFakeHive((root) => {
    withFleet(root, [{ id: 'pam-1', pendingBackgroundWork: 0, lastActiveSecAgo: 600 }]);
    const r = runCli('HIVE_PARK_CLI', ['pam-1', '--reason', 'done'], root);
    assert.equal(r.code, 0, r.err);
    assert.equal(requestFiles(root).length, 1);
  });
});

test('hive-park busy pre-flight trusts a STALE fleet only for the census, not the 60s activity window', () => {
  withFakeHive((root) => {
    // 10-min-old fleet: a lastActiveSecAgo of 5s is ancient news — the agent
    // may be quiet now, so the activity rung must NOT refuse; the census
    // (TTL 75min) far outlives fleet staleness, so pending still refuses.
    withFleet(
      root,
      [{ id: 'pam-1', pendingBackgroundWork: 0, lastActiveSecAgo: 5 }],
      Date.now() - 600_000,
    );
    const okActive = runCli('HIVE_PARK_CLI', ['pam-1', '--reason', 'done'], root);
    assert.equal(okActive.code, 0, okActive.err);
    withFleet(
      root,
      [{ id: 'pam-1', pendingBackgroundWork: 1, lastActiveSecAgo: 5 }],
      Date.now() - 600_000,
    );
    const pendActive = runCli('HIVE_PARK_CLI', ['pam-1', '--reason', 'done'], root);
    assert.notEqual(pendActive.code, 0);
    assert.match(pendActive.err, /pending background task/);
  });
});

test('syntax: both emitted CLIs parse as standalone node scripts', () => {
  for (const name of ['HIVE_PARK_CLI', 'HIVE_RECALL_CLI']) {
    const file = path.join(os.tmpdir(), `syn-${name}.cjs`);
    fs.writeFileSync(file, cliSource(name).replace(/^#!.*\n/, ''));
    execFileSync('node', ['--check', file]);
  }
});

// ─── hive-park: the happy path ──────────────────────────────────────────────

test('hive-park happy path writes a well-formed watcher-compatible request', () => {
  withFakeHive((root) => {
    const r = runCli('HIVE_PARK_CLI', ['pam-1', '--reason', 'done reported, no open card'], root);
    assert.equal(r.code, 0, r.err);
    const files = requestFiles(root);
    assert.equal(files.length, 1, 'exactly one request file');
    const req = JSON.parse(fs.readFileSync(path.join(root, 'vacation-requests', files[0]), 'utf8'));
    assert.equal(req.agentId, 'pam-1');
    assert.equal(req.reason, 'done reported, no open card');
    assert.notEqual(req.action, 'recall', 'a park is not a recall');
    assert.ok(!('whenQuiet' in req), 'no --when-quiet flag → field ABSENT (watcher strict-true)');
    assert.match(r.out, /pam-1/, 'receipt names the agent');
  });
});

test('hive-park --when-quiet passes "whenQuiet": true through unchanged', () => {
  withFakeHive((root) => {
    const r = runCli(
      'HIVE_PARK_CLI',
      ['pam-1', '--reason', 'park at end of turn', '--when-quiet'],
      root,
    );
    assert.equal(r.code, 0, r.err);
    const req = JSON.parse(
      fs.readFileSync(path.join(root, 'vacation-requests', requestFiles(root)[0]), 'utf8'),
    );
    assert.equal(req.whenQuiet, true, 'strict boolean true — the watcher holds on exactly this');
    assert.equal(req.agentId, 'pam-1');
    assert.equal(req.reason, 'park at end of turn');
  });
});

// ─── hive-park: the refusal ladder (each gate distinct, nothing written) ────

test("hive-park REFUSES a PINNED agent (operator's call) and writes nothing", () => {
  withFakeHive((root) => {
    const r = runCli('HIVE_PARK_CLI', ['pin-1', '--reason', 'idle'], root);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /pinned/);
    assert.equal(requestFiles(root).length, 0, 'refusal writes no request');
  });
});

test('hive-park REFUSES an agent holding a doing card and writes nothing', () => {
  withFakeHive((root) => {
    const r = runCli('HIVE_PARK_CLI', ['busy-1', '--reason', 'idle'], root);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /card-open/, 'names the open card');
    assert.match(r.err, /doing/);
    assert.equal(requestFiles(root).length, 0, 'refusal writes no request');
  });
});

test('hive-park REFUSES god itself', () => {
  withFakeHive((root) => {
    const r = runCli('HIVE_PARK_CLI', ['god', '--reason', 'idle'], root);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /god/i);
    assert.equal(requestFiles(root).length, 0, 'refusal writes no request');
  });
});

test('hive-park REFUSES an unknown id with a distinct message', () => {
  withFakeHive((root) => {
    const r = runCli('HIVE_PARK_CLI', ['ghost', '--reason', 'idle'], root);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /ghost/);
    assert.match(r.err, /registry/);
    assert.equal(requestFiles(root).length, 0, 'refusal writes no request');
  });
});

test('hive-park REFUSES an archived (off-floor, not parked) agent with a distinct message', () => {
  withFakeHive((root) => {
    const r = runCli('HIVE_PARK_CLI', ['arch-1', '--reason', 'idle'], root);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /archived/);
    assert.equal(requestFiles(root).length, 0, 'refusal writes no request');
  });
});

test('hive-park REFUSES an already-parked agent with a distinct message', () => {
  withFakeHive((root) => {
    const r = runCli('HIVE_PARK_CLI', ['parked-1', '--reason', 'idle'], root);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /already on vacation/);
    assert.equal(requestFiles(root).length, 0, 'refusal writes no request');
  });
});

test('hive-park REFUSES an intern (they are fired, never parked)', () => {
  withFakeHive((root) => {
    const r = runCli('HIVE_PARK_CLI', ['intern-docs', '--reason', 'idle'], root);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /intern/);
    assert.equal(requestFiles(root).length, 0, 'refusal writes no request');
  });
});

test('hive-park REFUSES a retired agent (fired and vacation are mutually exclusive)', () => {
  withFakeHive((root) => {
    const r = runCli('HIVE_PARK_CLI', ['ret-1', '--reason', 'idle'], root);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /fired|retired/);
    assert.equal(requestFiles(root).length, 0, 'refusal writes no request');
  });
});

test("hive-park REQUIRES --reason (it is god's done-evidence record in the vacation log)", () => {
  withFakeHive((root) => {
    const r = runCli('HIVE_PARK_CLI', ['pam-1'], root);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /--reason/);
    assert.equal(requestFiles(root).length, 0, 'refusal writes no request');
  });
});

// ─── hive-recall ────────────────────────────────────────────────────────────

test("hive-recall happy path writes the watcher's recall request", () => {
  withFakeHive((root) => {
    const r = runCli('HIVE_RECALL_CLI', ['parked-1'], root);
    assert.equal(r.code, 0, r.err);
    const req = JSON.parse(
      fs.readFileSync(path.join(root, 'vacation-requests', requestFiles(root)[0]), 'utf8'),
    );
    assert.equal(req.agentId, 'parked-1');
    assert.equal(req.action, 'recall', 'the watcher keys the verb on this exact field');
    assert.match(r.out, /parked-1/, 'receipt names the agent');
  });
});

test('hive-recall REFUSES an agent that is not parked', () => {
  withFakeHive((root) => {
    const r = runCli('HIVE_RECALL_CLI', ['pam-1'], root);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /not on vacation/);
    assert.equal(requestFiles(root).length, 0, 'refusal writes no request');
  });
});

test('hive-recall REFUSES an unknown id with a distinct message', () => {
  withFakeHive((root) => {
    const r = runCli('HIVE_RECALL_CLI', ['ghost'], root);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /ghost/);
    assert.match(r.err, /registry/);
    assert.equal(requestFiles(root).length, 0, 'refusal writes no request');
  });
});

test("hive-recall REFUSES a retired agent (reinstate, don't recall)", () => {
  withFakeHive((root) => {
    const r = runCli('HIVE_RECALL_CLI', ['ret-1'], root);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /fired|retired/);
    assert.equal(requestFiles(root).length, 0, 'refusal writes no request');
  });
});
