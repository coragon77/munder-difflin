'use strict';

/**
 * AGENT-DETAIL READER (card agent-hive-roster-show-agent-d-2026-08-19).
 *
 * bin/hive-roster, emitted from a harness constant like hive-park/hive-recall,
 * tested by RUNNING the emitted script against a fake HIVE_ROOT (FIXTURES
 * ONLY — never the live floor). The point of the card: the roster line
 * carries name/role/state/tokens/cost but NOT cwd, and god's
 * one-agent-per-directory rule needs exactly that before ruling a conflict —
 * the shared-state gate refuses the raw registry read, so the sanctioned read
 * is this primitive.
 *
 *  - `show <agent-id>` prints id, name, role, provider+model, class
 *    (god/hire/intern), live state (active/parked/archived/retired/fired),
 *    pinned, cwd, spawnLabel — read-only, non-zero exit on unknown id.
 *  - `list` prints the same fields one line per agent, parked agents
 *    INCLUDED (that is the whole point — the fetchable vacation pool).
 *  - both never write anything (registry.json bytes unchanged).
 *  - no telemetry duplicated: model is '-' when the registry carries none
 *    (it never does — the roster line owns tokens/cost).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.join(__dirname, '..');
const loadTs = require('./load-ts.cjs');

// Same extraction machinery as hive-park-recall-cli.test.cjs: the CLI lives in
// src/main/hive.ts as a template-literal constant; bootstrap EVALUATES it, so
// undo the template escapes the raw copy keeps. \\n AND \\s (reviewer finding:
// an un-normalized \\s left oneLine's regex matching a literal backslash-s in
// the test copy — the collapse was never actually exercised here).
function templateOf(name) {
  const src = fs.readFileSync(path.join(repoRoot, 'src/main/hive.ts'), 'utf8');
  const marker = `const ${name} = \``;
  const at = src.indexOf(marker);
  assert.ok(at > 0, `${name} constant exists in src/main/hive.ts`);
  const end = src.indexOf('\n`;', at);
  return src
    .slice(at + src.slice(at).indexOf('`') + 1, end)
    .split('\\\\n')
    .join('\\n')
    .split('\\\\s')
    .join('\\s');
}

const GUARD_TOKEN = '${' + 'ASSERT_LIVE_HIVE}';
function cliSource() {
  const raw = templateOf('HIVE_ROSTER_CLI');
  return raw.includes(GUARD_TOKEN)
    ? raw.split(GUARD_TOKEN).join(templateOf('ASSERT_LIVE_HIVE'))
    : raw;
}

function withFakeHive(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-roster-'));
  fs.writeFileSync(
    path.join(root, 'registry.json'),
    JSON.stringify({
      godId: 'god',
      agents: {
        'fired-1': {
          id: 'fired-1',
          name: 'Fired Intern',
          role: 'intern',
          cwd: '/tmp',
          retired: true,
        },
        god: { id: 'god', name: 'God', role: 'agent', cwd: '/tmp/throne' },
        'pam-1': {
          id: 'pam-1',
          name: 'Pam',
          role: 'agent',
          provider: 'claude',
          model: 'gpt-rogue',
          cwd: '/work/dundler',
          spawnLabel: 'Fix the printer jam',
        },
        'messy-1': {
          id: 'messy-1',
          name: 'Mia\n\nPower\tTab',
          role: 'agent',
          cwd: ' /work/messy ',
          spawnLabel: 'x'.repeat(300),
        },
        'pin-1': { id: 'pin-1', name: 'Pin', role: 'agent', cwd: '/tmp', pinned: true },
        'parked-1': {
          id: 'parked-1',
          name: 'Parked',
          role: 'agent',
          provider: 'codex',
          cwd: '/work/vacant',
          vacation: true,
          archived: true,
        },
        'arch-1': { id: 'arch-1', name: 'Arch', role: 'agent', cwd: '/tmp', archived: true },
        'intern-docs': { id: 'intern-docs', name: 'Docs (Intern)', role: 'intern', cwd: '/tmp' },
        'ret-1': { id: 'ret-1', name: 'Ret', role: 'agent', cwd: '/tmp', retired: true },
      },
    }),
  );
  return fn(root);
}

function runCli(args, root) {
  const file = path.join(root, 'hive-roster.run.cjs');
  fs.writeFileSync(file, cliSource().replace(/^#!.*\n/, ''));
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

test('syntax: the emitted CLI parses as a standalone node script', () => {
  const file = path.join(os.tmpdir(), 'syn-hive-roster.cjs');
  fs.writeFileSync(file, cliSource().replace(/^#!.*\n/, ''));
  execFileSync('node', ['--check', file]);
});

test('hive-roster show prints the detail fields the roster line omits', () => {
  withFakeHive((root) => {
    const r = runCli(['show', 'pam-1'], root);
    assert.equal(r.code, 0, r.err);
    for (const line of [
      'id: pam-1',
      'name: Pam',
      'role: agent',
      'provider: claude',
      'model: -',
      'class: hire',
      'state: active',
      'pinned: no',
      'cwd: /work/dundler',
      'spawnLabel: Fix the printer jam',
    ]) {
      assert.ok(r.out.split('\n').includes(line), `output has "${line}"`);
    }
  });
});

test('hive-roster show prints the god/hire/intern class', () => {
  withFakeHive((root) => {
    // god carries NEITHER isGod NOR role 'god' in the fixture — godId alone
    // must classify it (floorCensus parity; role is user-authored free text).
    assert.ok(runCli(['show', 'god'], root).out.includes('class: god'));
    assert.ok(runCli(['show', 'intern-docs'], root).out.includes('class: intern'));
    assert.ok(runCli(['show', 'pam-1'], root).out.includes('class: hire'));
  });
});

test('hive-roster show renders pinned and the off-floor states', () => {
  withFakeHive((root) => {
    assert.ok(runCli(['show', 'pin-1'], root).out.includes('pinned: yes'));
    assert.ok(runCli(['show', 'parked-1'], root).out.includes('state: parked'));
    assert.ok(runCli(['show', 'arch-1'], root).out.includes('state: archived'));
    assert.ok(runCli(['show', 'ret-1'], root).out.includes('state: retired'));
    // one retired flag, two vocabularies: an intern was FIRED, a hire RETIRED
    assert.ok(runCli(['show', 'fired-1'], root).out.includes('state: fired'));
  });
});

test('hive-roster show REFUSES an unknown id with a non-zero exit', () => {
  withFakeHive((root) => {
    const r = runCli(['show', 'ghost'], root);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /ghost/);
    assert.match(r.err, /registry/);
  });
});

test('hive-roster show REFUSES prototype-named ids (own-property check)', () => {
  withFakeHive((root) => {
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const r = runCli(['show', id], root);
      assert.notEqual(r.code, 0, `id ${id} must not resolve`);
      assert.match(r.err, /registry/);
    }
  });
});

test('hive-roster show REFUSES extra arguments', () => {
  withFakeHive((root) => {
    const r = runCli(['show', 'pam-1', 'pam-2'], root);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /exactly one/);
  });
});

test('hive-roster ignores a ROGUE model field (no telemetry duplication)', () => {
  withFakeHive((root) => {
    const r = runCli(['show', 'pam-1'], root);
    assert.ok(r.out.split('\n').includes('model: -'));
    assert.ok(!r.out.includes('gpt-rogue'), 'out-of-schema model never surfaces');
  });
});

test('hive-roster collapses whitespace and caps oversized fields (real regex)', () => {
  withFakeHive((root) => {
    const r = runCli(['show', 'messy-1'], root);
    assert.ok(r.out.split('\n').includes('name: Mia Power Tab'), 'newlines/tabs collapsed');
    assert.ok(r.out.split('\n').includes('cwd: /work/messy'), 'cwd trimmed');
    const label = r.out.split('\n').find((l) => l.startsWith('spawnLabel: '));
    assert.equal(label.length, 'spawnLabel: '.length + 120, 'label capped at 120 + ellipsis char');
    assert.ok(label.endsWith('…'));
    const row = runCli(['list'], root)
      .out.split('\n')
      .find((l) => l.startsWith('messy-1 |'));
    assert.equal(row.split('\n').length, 1);
    assert.ok(row.includes('Mia Power Tab'));
    assert.ok(row.includes('label=' + 'x'.repeat(59) + '…'), 'list caps label at 60');
  });
});

test('hive-roster list prints one line per agent INCLUDING parked and retired', () => {
  withFakeHive((root) => {
    const r = runCli(['list'], root);
    assert.equal(r.code, 0, r.err);
    const lines = r.out.split('\n').filter(Boolean);
    assert.equal(lines.length, 9, 'every registry agent (messy-1 included), no phantom rows');
    // sorted → deterministic diffing between two invocations
    const ids = lines.map((l) => l.split(' | ')[0]);
    assert.deepEqual(ids, [...ids].sort());
    const parked = lines.find((l) => l.startsWith('parked-1 |'));
    assert.ok(parked, 'parked agent is listed');
    assert.ok(parked.includes('/work/vacant'), 'line carries the cwd');
    assert.ok(parked.includes('parked'), 'line carries the state');
    // single-line rows: a rogue name/label can never wrap or inject rows
    for (const l of lines) assert.ok(!l.includes('\n'));
  });
});

test('hive-roster list carries spawnLabel and pinned per line', () => {
  withFakeHive((root) => {
    const r = runCli(['list'], root);
    const pam = r.out.split('\n').find((l) => l.startsWith('pam-1 |'));
    assert.ok(pam.includes('pinned=no'), 'pinned column');
    assert.ok(pam.includes('Fix the printer jam'), 'spawnLabel column');
    const pin = r.out.split('\n').find((l) => l.startsWith('pin-1 |'));
    assert.ok(pin.includes('pinned=yes'));
  });
});

test('hive-roster is READ-ONLY: registry.json bytes are unchanged', () => {
  withFakeHive((root) => {
    const before = fs.readFileSync(path.join(root, 'registry.json'), 'utf8');
    runCli(['show', 'pam-1'], root);
    runCli(['list'], root);
    assert.equal(fs.readFileSync(path.join(root, 'registry.json'), 'utf8'), before);
    // and no stray files appeared in the fake hive root
    assert.deepEqual(fs.readdirSync(root).sort(), ['hive-roster.run.cjs', 'registry.json']);
  });
});

test('hive-roster without HIVE_ROOT refuses with a non-zero exit', () => {
  withFakeHive((root) => {
    const file = path.join(root, 'hive-roster.run.cjs');
    fs.writeFileSync(file, cliSource().replace(/^#!.*\n/, ''));
    let res = { code: 0, err: '' };
    try {
      execFileSync('node', [file, 'list'], {
        env: { ...process.env, HIVE_ROOT: '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      res = { code: e.status ?? 1, err: (e.stderr ?? '').toString() };
    }
    assert.notEqual(res.code, 0);
    assert.match(res.err, /HIVE_ROOT/);
  });
});

// Reviewer finding 5, second half: the extractor-based runs above bypass
// ensureHive. This one drives the REAL evaluated template the way bootstrap
// writes it — creation, chmod, and the escaping the extractor cannot prove
// (production /\s+/ vs the extractor copy) all checked here.
test('ensureHive ships an executable hive-roster built from the EVALUATED template', {
  skip: process.platform === 'win32',
}, (t) => {
  const { HiveManager } = loadTs('src/main/hive.ts');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-roster-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  new HiveManager(() => home).ensureHive();
  const cli = path.join(home, 'hive', 'bin', 'hive-roster');
  assert.ok(fs.existsSync(cli), 'hive-roster exists in <hive>/bin');
  assert.equal(fs.statSync(cli).mode & 0o777, 0o755, 'executable (0755)');
  const hiveRoot = path.join(home, 'hive');
  fs.writeFileSync(
    path.join(hiveRoot, 'registry.json'),
    JSON.stringify({
      godId: 'g',
      agents: { g: { id: 'g', name: 'Multi\nLine', role: 'agent', cwd: '/x' } },
    }),
  );
  const out = execFileSync(process.execPath, [cli, 'show', 'g'], {
    env: { ...process.env, HIVE_ROOT: hiveRoot },
    encoding: 'utf8',
  });
  assert.ok(
    out.split('\n').includes('name: Multi Line'),
    'the evaluated template really collapses whitespace',
  );
  assert.ok(out.split('\n').includes('cwd: /x'));
});

// ─── set-capabilities: the write side (card agent-no-primitive-can-set-an--) ──
// The CLI never writes registry.json — it drops a request JSON into
// capability-requests/ and the harness watcher applies it (single writer).
test('hive-roster set-capabilities drops a request file and never touches the registry', () => {
  withFakeHive((root) => {
    const before = fs.readFileSync(path.join(root, 'registry.json'), 'utf8');
    const r = runCli(['set-capabilities', 'pam-1', 'email,tickets'], root);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /queued|capability-requests/, 'a receipt names the queue');
    assert.equal(
      fs.readFileSync(path.join(root, 'registry.json'), 'utf8'),
      before,
      'the CLI itself never writes registry.json',
    );
    const q = path.join(root, 'capability-requests');
    const files = fs.readdirSync(q).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1, 'exactly one request file');
    const req = JSON.parse(fs.readFileSync(path.join(q, files[0]), 'utf8'));
    assert.equal(req.agentId, 'pam-1');
    assert.deepEqual(req.capabilities, ['email', 'tickets']);
  });
});

test('hive-roster set-capabilities refuses bad argv without writing anything', () => {
  withFakeHive((root) => {
    for (const args of [
      ['set-capabilities'],
      ['set-capabilities', 'pam-1'],
      ['set-capabilities', 'pam-1', ''],
      ['set-capabilities', 'pam-1', 'a', 'b'],
    ]) {
      const r = runCli(args, root);
      assert.notEqual(r.code, 0, JSON.stringify(args));
      const q = path.join(root, 'capability-requests');
      assert.ok(!fs.existsSync(q) || fs.readdirSync(q).length === 0, 'no request written');
    }
  });
});

test('hive-roster set-capabilities whitespace-splits and drops empties like the harness will', () => {
  withFakeHive((root) => {
    const r = runCli(['set-capabilities', 'pam-1', ' tickets ,, email , '], root);
    assert.equal(r.code, 0, r.err);
    const q = path.join(root, 'capability-requests');
    const req = JSON.parse(fs.readFileSync(path.join(q, fs.readdirSync(q)[0]), 'utf8'));
    assert.deepEqual(req.capabilities, ['tickets', 'email']);
  });
});
