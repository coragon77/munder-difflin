'use strict';

/**
 * INTERN LIFECYCLE PRIMITIVES (card agent-build-hive-hire-the-miss-2026-08-18).
 *
 * Three pinned surfaces, one card:
 *
 *  1. RESOLVER PAIR FIX — resolveInternSpawn merged PER FIELD, grafting the
 *     request's provider onto the settings' model. Live incident 2026-08-18:
 *     request {command:'claude', provider:'claude', model:null} + settings
 *     {provider:'pi', model:'openai-codex/gpt-5.6-sol'} launched
 *     `claude --model openai-codex/gpt-5.6-sol` — read from /proc/<pid>/cmdline.
 *     A provider and its model must resolve TOGETHER: request names any engine
 *     field → the request pair is authoritative and settings are ignored
 *     entirely; no engine field → the settings pair applies verbatim.
 *
 *  2. THE CLIs — bin/hive-hire + bin/hive-fire, emitted from harness constants
 *     (like hive-dispatch), tested by RUNNING the emitted script against a fake
 *     HIVE_ROOT: hire writes a spawn-request that owns the engine fields (no
 *     hand-written "command": "claude"), refuses half engine pairs, refuses
 *     retired ids, refuses on a full floor; fire refuses non-interns, refuses
 *     (until --force) a doing card, and the receipt states irreversibility.
 *
 *  3. THE PROMPTS TEACH THE PRIMITIVES — godLine + COMMANDS.md must lead with
 *     hive-hire/hive-fire as THE interface (mechanism second), or the primitive
 *     ships dead (the godline-teaches-manual-dispatch card exists because
 *     capability and teaching shipped apart).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const repoRoot = path.join(__dirname, '..');
const read = (p) => readFileSync(path.join(repoRoot, p), 'utf8');

// ─── 1. the resolver: pair coherence ────────────────────────────────────────

const { resolveInternSpawn } = loadTs('src/main/internDefaults.ts');

const CFG = {
  defaultCommand: 'claude',
  internDefaults: { provider: 'pi', model: 'openai-codex/gpt-5.6-sol' },
};

test('THE INCIDENT: request engine fields make the request pair authoritative — no settings graft', () => {
  const r = resolveInternSpawn(CFG, { command: 'claude', provider: 'claude', model: null }, true);
  assert.equal(r.provider, 'claude', 'request provider wins');
  assert.equal(r.command, 'claude');
  assert.equal(
    r.model,
    undefined,
    'the settings model (a pi model) must NEVER be grafted onto a request claude — this exact graft launched claude --model openai-codex/gpt-5.6-sol',
  );
});

test('request pair taken verbatim when both halves given', () => {
  const r = resolveInternSpawn(CFG, { provider: 'grok', model: 'grok-4' }, true);
  assert.deepEqual({ provider: r.provider, model: r.model }, { provider: 'grok', model: 'grok-4' });
  assert.equal(r.command, 'grok', 'command derives from the request provider preset');
});

test('no engine fields → the settings pair applies verbatim (the normal intern path)', () => {
  const r = resolveInternSpawn(CFG, {}, true);
  assert.equal(r.provider, 'pi');
  assert.equal(r.model, 'openai-codex/gpt-5.6-sol');
  assert.equal(r.command, 'pi', 'command derives from the settings provider preset');
});

test('a request COMMAND alone is already engine intent — settings model does not ride along', () => {
  const r = resolveInternSpawn(CFG, { command: 'codex' }, true);
  assert.equal(r.command, 'codex');
  assert.equal(r.model, undefined, 'codex with a pi model grafted is the same defect class');
  assert.equal(r.provider, undefined);
});

test('non-intern (ephemeral worker) never sees internDefaults', () => {
  const r = resolveInternSpawn(CFG, {}, false);
  assert.equal(r.provider, undefined);
  assert.equal(r.model, undefined);
  assert.equal(r.command, 'claude', 'defaultCommand fallback');
});

// ─── 2. the CLIs, run against a fake hive root ─────────────────────────────

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');

// The constants are module-private in hive.ts; the EMITTED script is what
// ships, so extract it the way bootstrap does — from the constant via a tiny
// eval shim over the source (kept in sync by the syntax + behavior pins).
function cliSource(name) {
  const src = read('src/main/hive.ts');
  const at = src.indexOf(`const ${name} = \``);
  assert.ok(at > 0, `${name} constant exists in src/main/hive.ts`);
  const end = src.indexOf('\n`;', at);
  // The constant is a TS template literal; bootstrap EVALUATES it (\n becomes
  // a real escape in the emitted script). This extractor copies the raw text,
  // so undo the one template escape these scripts use: backslash-backslash-n
  // -> backslash-n, exactly what template evaluation would produce.
  return src
    .slice(at + src.slice(at).indexOf('`') + 1, end)
    .split('\\\\n')
    .join('\\n');
}

function withFakeHive(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hire-fire-'));
  fs.mkdirSync(path.join(root, 'spawn-requests'), { recursive: true });
  fs.mkdirSync(path.join(root, 'fire-requests'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'registry.json'),
    JSON.stringify({
      godId: 'god',
      agents: {
        god: { id: 'god', name: 'God', role: 'god', isGod: true },
        pam: { id: 'pam', name: 'Pam', role: 'agent' },
        'intern-old': { id: 'intern-old', name: 'Old (Intern)', role: 'intern', retired: true },
        'intern-docs': { id: 'intern-docs', name: 'Docs (Intern)', role: 'intern' },
      },
    }),
  );
  fs.writeFileSync(
    path.join(root, 'fleet.json'),
    JSON.stringify({
      ts: Date.now(),
      agents: [],
      vacation: [],
      floor: {
        maxAgents: 16,
        onFloor: 10,
        freeSeats: 6,
        internsEnabled: true,
        internDefaults: { provider: 'pi', model: 'openai-codex/gpt-5.6-sol' },
      },
    }),
  );
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks: [] }));
  return fn(root);
}

function runCli(name, args, root, opts = {}) {
  const file = path.join(root, `${name}.run.cjs`);
  fs.writeFileSync(file, cliSource(name).replace(/^#!.*\n/, ''));
  try {
    const out = execFileSync('node', [file, ...args], {
      env: { ...process.env, HIVE_ROOT: root, AGENT_ID: 'god' },
      stdio: ['pipe', 'pipe', 'pipe'],
      input: opts.stdin ?? '',
    });
    return { code: 0, out: out.toString() };
  } catch (e) {
    return {
      code: e.status ?? 1,
      out: (e.stdout ?? '').toString(),
      err: (e.stderr ?? '').toString(),
    };
  }
}

test('syntax: both emitted CLIs parse as standalone node scripts', () => {
  for (const name of ['HIVE_HIRE_CLI', 'HIVE_FIRE_CLI']) {
    const file = path.join(os.tmpdir(), `syn-${name}.cjs`);
    fs.writeFileSync(file, cliSource(name).replace(/^#!.*\n/, ''));
    execFileSync('node', ['--check', file]);
  }
});

test('hive-hire (no engine flags) writes a spawn-request with NO engine fields — internDefaults applies at spawn', () => {
  withFakeHive((root) => {
    const r = runCli(
      'HIVE_HIRE_CLI',
      ['--name', 'Newbie', '--cwd', root, '--objective', 'write docs'],
      root,
    );
    assert.equal(r.code, 0, `receipt: ${r.out}${r.err}`);
    assert.match(
      r.out,
      /engine: internDefaults .*pi \/ openai-codex\/gpt-5\.6-sol/,
      'receipt shows the RESOLVED engine (from the fleet mirror)',
    );
    const queued = fs
      .readdirSync(path.join(root, 'spawn-requests'))
      .filter((f) => f.endsWith('.json'));
    assert.equal(queued.length, 1, 'exactly one spawn-request queued');
    const req = JSON.parse(fs.readFileSync(path.join(root, 'spawn-requests', queued[0]), 'utf8'));
    assert.equal(req.persistent, true);
    assert.equal(req.name, 'Newbie');
    assert.equal(
      'command' in req || 'provider' in req || 'model' in req,
      false,
      'no engine fields hand-written — the resolver owns them (the incident class)',
    );
  });
});

test('hive-hire: --provider without --model is a REFUSAL (pair rule), writing nothing', () => {
  withFakeHive((root) => {
    const r = runCli(
      'HIVE_HIRE_CLI',
      ['--name', 'X', '--cwd', root, '--objective', 'o', '--provider', 'grok'],
      root,
    );
    assert.notEqual(r.code, 0);
    assert.match(r.err, /--provider and --model go together/);
    assert.equal(
      fs.readdirSync(path.join(root, 'spawn-requests')).filter((f) => f.endsWith('.json')).length,
      0,
      'refused before writing',
    );
  });
});

test('hive-hire: full engine pair rides the request verbatim', () => {
  withFakeHive((root) => {
    const r = runCli(
      'HIVE_HIRE_CLI',
      ['--name', 'X', '--cwd', root, '--objective', 'o', '--provider', 'grok', '--model', 'grok-4'],
      root,
    );
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /engine: grok \/ grok-4/);
    const queued = fs
      .readdirSync(path.join(root, 'spawn-requests'))
      .filter((f) => f.endsWith('.json'));
    const req = JSON.parse(fs.readFileSync(path.join(root, 'spawn-requests', queued[0]), 'utf8'));
    assert.equal(req.provider, 'grok');
    assert.equal(req.model, 'grok-4');
  });
});

test('hive-hire: retired id is a plain refusal naming the fix (fresh id)', () => {
  withFakeHive((root) => {
    const r = runCli(
      'HIVE_HIRE_CLI',
      ['--name', 'Old', '--id', 'old', '--cwd', root, '--objective', 'o'],
      root,
    );
    assert.notEqual(r.code, 0);
    assert.match(r.err, /was fired/i);
    assert.match(r.err, /fresh --id/);
  });
});

test('hive-hire: full floor is a refusal naming the free seats', () => {
  withFakeHive((root) => {
    fs.writeFileSync(
      path.join(root, 'fleet.json'),
      JSON.stringify({ floor: { freeSeats: 0, maxAgents: 16, onFloor: 16, internsEnabled: true } }),
    );
    const r = runCli('HIVE_HIRE_CLI', ['--name', 'X', '--cwd', root, '--objective', 'o'], root);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /floor is full/);
  });
});

test('hive-hire: internsEnabled off is a refusal pointing at the setting', () => {
  withFakeHive((root) => {
    fs.writeFileSync(
      path.join(root, 'fleet.json'),
      JSON.stringify({ floor: { freeSeats: 5, internsEnabled: false } }),
    );
    const r = runCli('HIVE_HIRE_CLI', ['--name', 'X', '--cwd', root, '--objective', 'o'], root);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /internsEnabled/);
  });
});

test('hive-hire: --title creates a born-doing card assigned to the intern', () => {
  withFakeHive((root) => {
    const r = runCli(
      'HIVE_HIRE_CLI',
      ['--name', 'Fresh', '--cwd', root, '--objective', 'o', '--title', 'Write the docs'],
      root,
    );
    assert.equal(r.code, 0, r.err);
    const tasks = JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')).tasks;
    const card = tasks.find((t) => t.title === 'Write the docs');
    assert.ok(card, 'card created');
    assert.equal(card.status, 'doing');
    assert.equal(card.assignee, 'intern-fresh', 'assigned to the minted intern id');
    assert.match(r.out, /card/);
  });
});

test('hive-fire: non-intern registry id is a refusal naming the role; bare unknown ids refuse too', () => {
  withFakeHive((root) => {
    // A registry entry under an intern- id that is NOT role intern (the
    // watcher's boundary — only god-hired interns are fireable).
    const reg = JSON.parse(fs.readFileSync(path.join(root, 'registry.json'), 'utf8'));
    reg.agents['intern-clerk'] = { id: 'intern-clerk', name: 'Clerk', role: 'agent' };
    fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify(reg));
    const role = runCli('HIVE_FIRE_CLI', ['intern-clerk'], root);
    assert.notEqual(role.code, 0);
    assert.match(role.err, /not an intern/);
    const unknown = runCli('HIVE_FIRE_CLI', ['pam'], root);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.err, /no agent "intern-pam"/);
    assert.equal(fs.readdirSync(path.join(root, 'fire-requests')).length, 0);
  });
});

test('hive-fire: doing card is a refusal unless --force; receipt states irreversibility + what survives', () => {
  withFakeHive((root) => {
    fs.writeFileSync(
      path.join(root, 'tasks.json'),
      JSON.stringify({
        tasks: [{ id: 'c1', title: 'T', status: 'doing', assignee: 'intern-docs' }],
      }),
    );
    const refused = runCli('HIVE_FIRE_CLI', ['intern-docs'], root);
    assert.notEqual(refused.code, 0);
    assert.match(refused.err, /doing/);
    assert.equal(fs.readdirSync(path.join(root, 'fire-requests')).length, 0, 'no request written');
    const forced = runCli('HIVE_FIRE_CLI', ['intern-docs', '--force'], root);
    assert.equal(forced.code, 0, forced.err);
    assert.match(forced.out, /PERMANENT/i, 'irreversibility stated');
    assert.match(forced.out, /memory.*inbox|inbox.*memory/i, 'what survives is stated');
    const queued = fs
      .readdirSync(path.join(root, 'fire-requests'))
      .filter((f) => f.endsWith('.json'));
    assert.equal(queued.length, 1);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(root, 'fire-requests', queued[0]), 'utf8')).id,
      'intern-docs',
    );
  });
});

test('hive-fire: already-fired intern is an informative no-op, no request written', () => {
  withFakeHive((root) => {
    const r = runCli('HIVE_FIRE_CLI', ['intern-old'], root);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /already fired/);
    assert.equal(
      fs.readdirSync(path.join(root, 'fire-requests')).filter((f) => f.endsWith('.json')).length,
      0,
    );
  });
});

// ─── 3. the prompts teach the primitives ───────────────────────────────────

const { HiveManager } = loadTs('src/main/hive.ts');
const injectedPrompt = HiveManager.prototype['injectedPrompt'];
const GOD = { id: 'god', name: 'God', role: 'god', cwd: '/w', isGod: true };

test('godLine: hive-hire/hive-fire are THE intern interface; drop-dirs are the mechanism', () => {
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  assert.ok(/hive-hire/.test(p), 'god briefing names hive-hire');
  assert.ok(/hive-fire/.test(p), 'god briefing names hive-fire');
  assert.ok(
    /hive-hire[^\n]*(internDefaults|defaults)/.test(p) || /internDefaults[^\n]*hive-hire/.test(p),
    'the briefing ties hive-hire to internDefaults (interface first)',
  );
});

test('COMMANDS.md: Path 3 leads with hive-hire; no template hardcodes an engine any more', () => {
  const src = read('src/main/hive.ts');
  const path3 = src.slice(
    src.indexOf('### Path 3 — Intern'),
    src.indexOf('### Path 4') > 0
      ? src.indexOf('### Path 4')
      : src.indexOf('## HIRING', src.indexOf('### Path 3')),
  );
  assert.ok(/hive-hire/.test(path3), 'Path 3 leads with the hive-hire interface');
  const templates = src.match(/spawn-requests\/[a-z-]+\.json" <<'EOF'[\s\S]*?EOF/g) ?? [];
  for (const t of templates) {
    assert.ok(
      !/"command":\s*"claude"/.test(t) && !/"provider":\s*"claude"/.test(t),
      `a spawn-request template still hardcodes the claude engine: ${t.slice(0, 80)}…`,
    );
  }
});

test('fleet mirror: the floor snapshot type carries the intern settings the CLI reads', () => {
  const src = read('src/main/index.ts');
  assert.ok(
    /floor:.*internsEnabled[\s\S]*internDefaults|internsEnabled[\s\S]*floor:/.test(src) ||
      (src.includes('internsEnabled') &&
        src.includes('internDefaults') &&
        src.includes('writeFleetSnapshot')),
    'writeFleetSnapshot mirrors internsEnabled + internDefaults into fleet.json for the CLIs',
  );
});
