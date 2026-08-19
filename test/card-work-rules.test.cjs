'use strict';

/**
 * Card-work rules under the placement rule (card
 * agent-move-the-three-card-work-2026-08-19 + god's Robert-review amendment).
 *
 * Placement rule: SPAWN PROMPT = every-agent-every-task rules only (highest
 * bar); GENERATED MD FILES = on-disk pull docs, near-zero standing cost,
 * mode-scopable; DISPATCH CONTRACT = one worker, one engagement. Under it:
 *  - REVIEWER-AS-DONE-EVIDENCE (ruling 3) folds into integrationLine +
 *    INTEGRATION_WORKERS_MD ("gates green" becomes "gates green + a
 *    fresh-context reviewer over the diff"), mode-scoped.
 *  - RED-GATE / DIRTY-REBASE CONDUCT (amendment A): red gate or unresolvable
 *    rebase conflict → STOP and mail god; never merge red, never force past.
 *    Same two mode-scoped surfaces.
 *  - HELD-BRANCH CONDUCT (amendment B, worker half of ARM LATE): hold
 *    un-rebased, report final tip once, rebase+gate+push when god calls the
 *    window. Same two surfaces.
 *  - MID-CARD ARCHITECTURAL DISCOVERY (ruling 1 residual): one bullet in
 *    HIVE_CARD_MD — god owns the dispatch-time side via the contract.
 *  - FIXTURES-ONLY TESTING (amendment C): every-agent spawn-prompt sentence +
 *    PROTOCOL.md bullet — a live-floor test's writes are unrecoverable.
 *  - Ruling 2 (plan docs) is god's dispatch-side rule — deliberately NOT in
 *    any worker surface here.
 *  - reportContractLine: an unlabeled claim is a defect in the report.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager, PROTOCOL_MD, renderCommandsMd } = loadTs('src/main/hive.ts');

// TS `private` is compile-time only — erased by transpile, reachable at runtime.
const injectedPrompt = HiveManager.prototype['injectedPrompt'];
const GOD = { id: 'michael', name: 'Michael', isGod: true, cwd: '/w' };
const WORKER = { id: 'pam', name: 'Pam', role: 'worker', cwd: '/w' };

// ——— integrationLine: reviewer + red-gate + held-branch (mode-scoped) ———

test('integrationLine folds the reviewer into gates-green and carries red-gate + held-branch conduct', () => {
  for (const mode of ['workers', 'lean']) {
    const p = injectedPrompt.call(null, WORKER, '/agents/pam', '/hive', false, false, true, mode);
    // ruling 3: reviewer over the green diff is part of gates-green
    assert.ok(
      /a fresh-context reviewer subagent has reviewed the green diff/.test(p),
      `mode ${mode}: reviewer folded into gates-green`,
    );
    assert.ok(
      /INCLUDING any you did not act on, and why — go in your done-report/.test(p),
      `mode ${mode}: un-actioned findings + reason land in the done-report`,
    );
    assert.ok(/no QA pass behind you/.test(p), `mode ${mode}: lean rationale named`);
    // amendment A: red-gate / dirty-rebase conduct
    assert.ok(
      /A red gate, or a rebase conflict you cannot cleanly resolve, means STOP and mail god/.test(
        p,
      ),
      `mode ${mode}: red-gate conduct`,
    );
    assert.ok(/never merge red, never force past it/.test(p), `mode ${mode}: never merge red`);
    // amendment B: held-branch conduct (worker half of ARM LATE)
    assert.ok(
      /hold it un-rebased, report your final tip ONCE/.test(p),
      `mode ${mode}: hold + tip once`,
    );
    assert.ok(
      /rebase \+ gate \+ push when god calls the window/.test(p),
      `mode ${mode}: rebase on window call`,
    );
  }
});

test("god mode: workers get no integrationLine (unchanged) — and god's briefing never carries it", () => {
  const workerGodMode = injectedPrompt.call(
    null,
    WORKER,
    '/agents/pam',
    '/hive',
    false,
    false,
    true,
    'god',
  );
  assert.ok(
    !workerGodMode.includes('INTEGRATION — WORKER-SIDE'),
    'god mode: no integration heading for a worker',
  );
  for (const marker of [
    'fresh-context reviewer',
    'never merge red',
    'report your final tip ONCE',
    'rebase conflict you cannot cleanly resolve',
  ]) {
    assert.ok(!workerGodMode.includes(marker), `god mode: no ${JSON.stringify(marker)}`);
  }
  for (const mode of ['god', 'workers', 'lean']) {
    const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false, true, mode);
    assert.ok(!p.includes('INTEGRATION — WORKER-SIDE'), `mode ${mode}: not in god briefing`);
    assert.ok(!p.includes('fresh-context reviewer'), `mode ${mode}: reviewer rule is worker-side`);
    assert.ok(!p.includes('never merge red'), `mode ${mode}: red-gate rule is worker-side`);
    assert.ok(
      !p.includes('report your final tip ONCE'),
      `mode ${mode}: held-branch rule is worker-side`,
    );
  }
});

// ——— INTEGRATION_WORKERS_MD: lockstep with integrationLine —————————————————

test('COMMANDS.md integration section (workers/lean render) carries the same three rules', () => {
  for (const mode of ['workers', 'lean']) {
    const md = renderCommandsMd(mode);
    assert.ok(
      /fresh-context reviewer subagent has\s+reviewed the green diff/.test(md),
      `mode ${mode}: reviewer`,
    );
    assert.ok(
      /including any you did not act on, and\s+why/.test(md),
      `mode ${mode}: un-actioned findings`,
    );
    assert.ok(/never merge red, never force past it/.test(md), `mode ${mode}: red-gate conduct`);
    assert.ok(
      /hold it un-rebased,\s+report your final tip once/.test(md),
      `mode ${mode}: held-branch conduct`,
    );
  }
  const godMd = renderCommandsMd('god');
  assert.ok(!godMd.includes('## Integration — worker-side'), 'god render: no integration section');
  for (const marker of [
    'fresh-context reviewer',
    'never merge red',
    'report your final tip once',
    'rebase conflict you cannot cleanly resolve',
  ]) {
    assert.ok(!godMd.includes(marker), `god render: no ${JSON.stringify(marker)}`);
  }
});

// ——— HIVE_CARD_MD: mid-card architectural discovery (one bullet) ————————————

test('HIVE_CARD_MD tells the mid-card architectural discovery to stop and mail god', () => {
  const md = renderCommandsMd('god'); // HIVE_CARD_MD renders in every mode
  assert.ok(/turns ARCHITECTURAL mid-card/.test(md), 'the mid-card discovery case is named');
  assert.ok(
    /STOP BEFORE THE NEXT EDIT and mail god the design: verdict first,\s+rejected alternatives with their failure modes, then the concrete\s+recommendation/.test(
      md,
    ),
    'design-mail shape pinned',
  );
});

// ——— fixtures-only testing: every-agent spawn sentence + PROTOCOL bullet ————

test('FIXTURES-ONLY TESTING is an every-agent spawn-prompt rule (worker AND god, every mode)', () => {
  for (const meta of [WORKER, GOD]) {
    for (const mode of ['god', 'workers', 'lean']) {
      const p = injectedPrompt.call(null, meta, '/agents/x', '/hive', false, false, true, mode);
      assert.ok(
        /FIXTURES-ONLY TESTING: never exercise the hive lifecycle primitives or shared state/.test(
          p,
        ),
        `${meta.id} / mode ${mode}: rule present`,
      );
      assert.ok(
        /a test's writes to the live floor are unrecoverable/.test(p),
        `${meta.id} / mode ${mode}: why named`,
      );
    }
  }
});

test('PROTOCOL.md carries the fixtures-only bullet and the unlabeled-claim defect', () => {
  assert.ok(/\*\*Fixtures-only testing\*\*/.test(PROTOCOL_MD), 'bullet present');
  assert.ok(
    /never exercise the hive lifecycle primitives or shared state as\s+a test against the live floor/.test(
      PROTOCOL_MD,
    ),
  );
  assert.ok(/An unlabeled claim is\s+a defect in the report/.test(PROTOCOL_MD));
  // ruling 2 dropped from every worker surface (god owns it dispatch-side)
  assert.ok(!PROTOCOL_MD.includes('Plan docs only for architectural work'));
  assert.ok(!PROTOCOL_MD.includes('## Card work: three standing rules'));
});

test('a worker SPAWN actually receives the fixtures rule and (lean floor) the integration additions', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-card-work-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-card-work-cwd-'));
  t.after(() => fs.rmSync(workdir, { recursive: true, force: true }));

  for (const [mode, expectIntegration] of [
    ['god', false],
    ['lean', true],
  ]) {
    const { args } = await hive.ensureAgent(
      { id: `worker-${mode}`, name: 'X', provider: 'claude', cwd: workdir },
      { integrationMode: mode },
    );
    const i = args.indexOf('--append-system-prompt');
    assert.ok(i !== -1, `${mode}: claude spawn carries the appended system prompt`);
    const prompt = args[i + 1];
    assert.ok(
      /FIXTURES-ONLY TESTING:/.test(prompt),
      `${mode}: spawned worker sees the fixtures rule`,
    );
    assert.equal(/fresh-context reviewer subagent/.test(prompt), expectIntegration);
    if (expectIntegration) {
      assert.ok(
        /never merge red, never force past it/.test(prompt),
        `${mode}: red-gate conduct at spawn`,
      );
      assert.ok(/report your final tip ONCE/.test(prompt), `${mode}: held-branch conduct at spawn`);
    }
  }
});
