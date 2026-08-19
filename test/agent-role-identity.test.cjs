'use strict';

/**
 * ROLE IS IDENTITY, DESCRIPTION IS LIVE STATUS
 * (card agent-separate-agent-identity--2026-08-19).
 *
 * The conflation already cost seven registry roles: usePtyParser rewrites the
 * store agent's `description` to 'on standby' (or scraped pane output) after
 * ~4 s idle, the EDIT dialog prefilled its description input from that live
 * value, and save sent it as `role` — so editing an idle agent's ICON silently
 * wiped its registry role with status wording. A wiped role does not read as
 * missing data; it reads like a plausible description of a general-purpose
 * worker, which is exactly how Ryan (merlin_oegb) got misrouted.
 *
 * This file pins the split:
 *  • the edit dialog edits the REGISTRY role (identity), never the store
 *    description (status);
 *  · an untouched role field sends NO role at all in hiveSetAgentMeta;
 *  • the status scrape stays alive in usePtyParser (the operator uses it) —
 *    it just never reaches identity again;
 *  • an absent role renders unmistakably unknown via ONE shared constant
 *    (UNKNOWN_ROLE — same string as the main-side roster line, Jessica's
 *    card agent-stop-the-registry-role-d-2026-08-19), never a placeholder
 *    that reads like a real role;
 *  • ensureAgent keeps its respawn contract: no role in the spawn meta → the
 *    prior (hired) role survives; an explicit role (god hires) overwrites.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const loadTs = require('./load-ts.cjs');

const repoRoot = path.join(__dirname, '..');
const read = (p) => readFileSync(path.join(repoRoot, p), 'utf8');

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-role-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, hive: loadTs('src/main/hive.ts').HiveManager };
}

// ─── the shared unknown-role rendering ─────────────────────────────────────

test('UNKNOWN_ROLE is one shared constant with the agreed unmistakable wording', () => {
  const { UNKNOWN_ROLE } = loadTs('src/shared/agentRole.ts');
  assert.equal(
    UNKNOWN_ROLE,
    'role: UNKNOWN — ask before routing',
    'the exact string god specified — the main-side roster line (Jessica) and every renderer surface say the same thing',
  );
  assert.ok(/UNKNOWN/.test(UNKNOWN_ROLE), 'visibly UNKNOWN, never title-cased prose');
});

// ─── the edit dialog: identity in, status out ──────────────────────────────

test('the edit dialog prefills role from the REGISTRY, never from the store description', () => {
  const src = read('src/renderer/src/components/AddAgentModal.tsx');
  // Role is fetched from the registry (hiveRegistry) and held in its own state.
  assert.ok(src.includes('hiveRegistry'), 'the dialog reads the registry role');
  assert.ok(/setRole/.test(src), 'role has its own state setter');
  // The status scrape must not seed identity: the prefill of the ROLE state
  // may not read editOf.description / pendingHire.description.
  const roleState = src.slice(src.indexOf('const [role'), src.indexOf('const [role') + 400);
  assert.ok(
    !/description/.test(roleState),
    'the role state is seeded from the registry, not the live description',
  );
});

test('an untouched role field sends NO role — the save cannot clobber identity', () => {
  const src = read('src/renderer/src/components/AddAgentModal.tsx');
  const submitAt = src.indexOf('const submit');
  const body = src.slice(submitAt, src.indexOf('return (', submitAt));
  const editBranch = body.slice(
    body.indexOf('if (editOf)'),
    body.indexOf('setBusy(true);\n    const id'),
  );
  assert.ok(editBranch.includes('hiveSetAgentMeta'), 'the edit branch still writes meta');
  assert.ok(
    !/role:\s*description/.test(editBranch),
    'the edit branch never derives role from the description (status) value',
  );
  // Exactly one role key in the payload, and it lives INSIDE the conditional
  // spread on roleTouched — untouched ⇒ the key is not sent at all.
  const roleKeys = editBranch.match(/\brole:/g) ?? [];
  assert.equal(roleKeys.length, 1, 'exactly one role key in the edit payload');
  assert.ok(
    /\.\.\.\(\s*roleTouched[^;]*\{ role: role\.trim\(\) \}[^;]*\)\s*,/.test(editBranch),
    'the single role key is behind the ...(roleTouched …) spread',
  );
  assert.ok(
    /onChange=\{[^}]*setRoleTouched\(true\)/s.test(src),
    'only typing in the role input arms the gate',
  );
});

test('the status scrape stays alive — description remains usePtyParser-owned', () => {
  const src = read('src/renderer/src/hooks/usePtyParser.ts');
  assert.ok(
    src.includes("description: 'on standby'"),
    'the idle status scrape still writes its own field (the operator uses it)',
  );
});

test('the edit dialog shows live status read-only, clearly not an input for identity', () => {
  const src = read('src/renderer/src/components/AddAgentModal.tsx');
  assert.ok(
    /readOnly/.test(src) && /Live status/i.test(src),
    'edit mode renders the live status as a read-only row',
  );
});

// ─── unknown renders unknown on every renderer-facing surface ──────────────

test('the agent directory renders an absent role as UNKNOWN_ROLE, not a plausible default', () => {
  const src = read('src/main/index.ts');
  const dirAt = src.indexOf("'hive:agentDirectory'");
  const handler = src.slice(dirAt, dirAt + 3000);
  assert.ok(handler.includes('UNKNOWN_ROLE'), 'the directory payload uses the shared constant');
  assert.ok(
    !handler.includes("?? 'agent'"),
    "no 'agent' placeholder — a default that reads like a real role is the bug",
  );
});

// ─── ensureAgent: the respawn echo path stays closed ───────────────────────

test('ensureAgent preserves a hired role across a respawn that carries no role', async (t) => {
  const { home, hive: HiveManager } = floor(t);
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({
    id: 'ryan-1',
    name: 'Ryan',
    provider: 'claude',
    role: 'owns merlin_oegb (customer)',
    cwd: '/tmp',
  });
  // A respawn (dead-terminal revive / restore team / restart & continue) sends
  // no role — the renderer never echoes description into spawn meta anymore.
  await hive.ensureAgent({ id: 'ryan-1', name: 'Ryan', provider: 'claude', cwd: '/tmp' });
  assert.equal(
    hive.registry().agents['ryan-1'].role,
    'owns merlin_oegb (customer)',
    'identity survives a role-less respawn',
  );
});

test('ensureAgent still accepts an EXPLICIT role (god hires) — that is identity, not echo', async (t) => {
  const { home, hive: HiveManager } = floor(t);
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: '/tmp' });
  await hive.ensureAgent({
    id: 'pam-1',
    name: 'Pam',
    provider: 'claude',
    role: 'intern',
    cwd: '/tmp',
  });
  assert.equal(hive.registry().agents['pam-1'].role, 'intern');
});

test('no renderer spawn path echoes the store description into spawn role', () => {
  // The hire (create) path is the ONE legitimate description→role door: a
  // human typed it fresh; no live status exists yet. Every other spawn payload
  // must carry no role at all (ensureAgent preserves) or an explicit literal.
  const modal = read('src/renderer/src/components/AddAgentModal.tsx');
  const submitAt = modal.indexOf('const submit');
  const body = modal.slice(submitAt, modal.indexOf('return (', submitAt));
  const editBranch = body.slice(
    body.indexOf('if (editOf)'),
    body.indexOf('setBusy(true);\n    const id'),
  );
  const createBranch = body.slice(body.indexOf('setBusy(true);\n    const id'));
  assert.ok(
    createBranch.includes('role: description.trim() || undefined'),
    'the hire path still seeds role from the human-typed briefing',
  );
  assert.equal(
    (editBranch.match(/\brole:/g) ?? []).length,
    1,
    'the edit path sends role only via the touched gate (one conditional key)',
  );
  for (const f of [
    'src/renderer/src/hooks/useHive.ts',
    'src/renderer/src/hooks/useRestoreTeam.ts',
    'src/renderer/src/components/CommandCenterPanel.tsx',
  ]) {
    const src = read(f);
    const roles = src.match(/role:\s*[^,\n]+/g) ?? [];
    for (const r of roles) {
      assert.ok(
        !/description/.test(r),
        `${f} must not derive spawn role from description (${r.trim()})`,
      );
    }
  }
});
