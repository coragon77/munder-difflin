/**
 * Sprite identity across re-spawns (card vacation-recall-sprite-change-20260816).
 *
 * A recalled vacationer came back with a different office-floor sprite: the
 * spawn-broadcast fallback (useHive) re-derived character/accent from scratch
 * while the agent's persisted row — still on the archived shelf, carrying its
 * hire-time pick — was silently consumed by addAgent. Live roster-backups
 * evidence (ada-msw5vf5o): angela/sky pre-park → jim/lemon after recall.
 *
 * These tests pin the extracted selection logic (spawnIdentity): a prior row
 * for the same id ALWAYS wins; first-carding falls back to cast-name match,
 * then the intern portrait pool (intern-portrait-pool-20260817), with a
 * deterministic id-hash accent.
 */
const test = require('node:test');
const assert = require('node:assert');
const load = require('./load-ts.cjs');

const { spawnIdentity, SPAWN_ACCENTS, FEMALE_CODED_NAMES } = load(
  'src/renderer/src/scene/office/spawnIdentity.ts',
);

test('the female-coded name list is lowercase and covers the known cases', () => {
  for (const n of FEMALE_CODED_NAMES) assert.equal(n, n.toLowerCase());
  assert.ok(FEMALE_CODED_NAMES.has('ada'));
  assert.ok(FEMALE_CODED_NAMES.has('holly'));
  // Cast members are NOT in the list — the cast-name rung handles them.
  assert.ok(!FEMALE_CODED_NAMES.has('pam'));
  assert.ok(!FEMALE_CODED_NAMES.has('angela'));
});

test('recall reuses the prior row identity (ada keeps angela/sky)', () => {
  const firstCard = spawnIdentity('ada-msw5vf5o', 'Ada');
  // A female-coded name DERIVES an intern-pool face (nellie for 'ada') — but
  // the prior row's pick must win on recall.
  assert.equal(firstCard.character, 'nellie');

  const recalled = spawnIdentity('ada-msw5vf5o', 'Ada', { character: 'angela', accent: 'sky' });
  assert.equal(recalled.character, 'angela');
  assert.equal(recalled.accent, 'sky');
});

test('prior identity wins even when the name would match a cast member', () => {
  // "Dwight" the hire picked phyllis; a recall must not snap him back to dwight.
  const recalled = spawnIdentity('dwight-1', 'Dwight', { character: 'phyllis', accent: 'coral' });
  assert.equal(recalled.character, 'phyllis');
  assert.equal(recalled.accent, 'coral');
});

test('first carding: cast-name match, else the intern pool', () => {
  assert.equal(spawnIdentity('dwight-msu29wrc', 'Dwight').character, 'dwight');
  assert.equal(spawnIdentity('pam-msu2xdpo', 'Pam').character, 'pam');
  // Since the intern-portrait-pool card, unmapped names hash onto the pool
  // instead of falling to the default character ('bob' hashes to gabe).
  assert.equal(spawnIdentity('bob-msw9x', 'Bob').character, 'gabe');
});

// ─── Gendered intern sprites (card agent-harness-gendered-intern--2026-08-17)
//
// Main-initiated spawns (interns, voice hires, recalls) with a FEMALE-coded
// name derive a face from the female intern pool (intern-portrait-pool-
// 20260817); every other name hashes onto the male pool. The saved/prior
// rungs above still outrank the map — the operator's explicit icon pick
// beats the name derivation.

test('first carding: a female-coded name derives a female-pool face', () => {
  assert.equal(spawnIdentity('ada-msw5vf5o', 'Ada').character, 'nellie');
  assert.equal(spawnIdentity('emma-msx2', 'Emma').character, 'erin');
  // 'Holly' is now a cast member — the cast-name rung gets her her own face.
  assert.equal(spawnIdentity('holly-msx1', 'Holly').character, 'holly');
});

test('female-coded match also works on the tokens of the key', () => {
  // The key falls back to the id; the name rides a later token (live pattern
  // intern-holly / intern-erin). Same for display names like 'Nora (Intern)'.
  assert.equal(spawnIdentity('ada-msw5vf5o', undefined).character, 'nellie');
  assert.equal(spawnIdentity('intern-nora-x1', 'Nora (Intern)').character, 'jan');
  // An unmapped male-coded name hashes onto the male pool.
  assert.equal(spawnIdentity('intern-pete', 'Pete (Intern)').character, 'darryl');
});

test('male-coded and unknown names hash onto the male pool', () => {
  assert.equal(spawnIdentity('carl-msx3', 'Carl').character, 'robert');
  assert.equal(spawnIdentity('zed-msx4', 'Zed').character, 'robert');
});

test('a registry-saved pick beats the pool mapping', () => {
  // Operator set Ada to jim explicitly — the map must not overrule the pick.
  const saved = spawnIdentity('ada-1', 'Ada', undefined, { character: 'jim' });
  assert.equal(saved.character, 'jim');
});

test('a prior row beats the pool mapping', () => {
  const prior = spawnIdentity('holly-1', 'Holly', { character: 'jim', accent: 'lemon' });
  assert.equal(prior.character, 'jim');
});

test('accent fallback is a stable id-hash from the palette', () => {
  const a = spawnIdentity('x-1', 'Nobody');
  const again = spawnIdentity('x-1', 'Nobody');
  assert.equal(a.accent, again.accent);
  assert.ok(SPAWN_ACCENTS.includes(a.accent));
});

// ─── Registry-saved identity (card agent-icon-persistence-20260817) ─────────
//
// The prior row lives in the RENDERER's shelves (localStorage / roster.json
// mirror) — fragile across origins and wipes. The registry is the durable
// home: a spawn broadcast that carries a saved identity must beat both the
// prior row and any derivation. This is the rung that was missing when a
// recalled Ada came back as Jim despite the 7b974a3 prior-row fix.

test('a registry-saved identity beats the prior row', () => {
  const saved = spawnIdentity(
    'ada-1',
    'Ada',
    { character: 'jim', accent: 'lemon' },
    {
      character: 'angela',
      accent: 'sky',
    },
  );
  assert.equal(saved.character, 'angela');
  assert.equal(saved.accent, 'sky');
});

test('a saved identity alone (no prior row) still wins over derivation', () => {
  // The saved rung outranks any derivation, pool hash included.
  const saved = spawnIdentity('ada-1', 'Ada', undefined, { character: 'angela', accent: 'sky' });
  assert.equal(saved.character, 'angela');
  assert.equal(saved.accent, 'sky');
});

test('an unknown saved character is ignored, never rendered', () => {
  // Registry strings are written by whatever version wrote them — a name the
  // current cast does not know must fall through to the normal ladder, not
  // crash the sprite lookup downstream.
  const r = spawnIdentity('bob-1', 'Bob', undefined, { character: 'not-a-cast-member' });
  assert.equal(r.character, 'gabe', 'falls through to the pool hash, not the bogus value');
  // Derivation still picks a stable accent when the saved accent is missing.
  assert.ok(SPAWN_ACCENTS.includes(r.accent));
});

test('an unknown saved accent is ignored', () => {
  const r = spawnIdentity('ada-1', 'Ada', undefined, { character: 'angela', accent: 'neon' });
  assert.equal(r.character, 'angela');
  assert.ok(SPAWN_ACCENTS.includes(r.accent), 'accent falls back to the id-hash rotation');
});

// 'intern-roy': the id key hashes the 'roy' token (char-code sum mod pool
// size) — roy is also a cast member, but the FULL key 'intern-roy' does not
// match the cast-name rung, so the pool hash decides. 'roy' is a fixed point
// of the hash (346 mod 5 = 1 = its own pool index) — pin it:
test('id-key spawns named after a pool member land on the pool hash', () => {
  assert.equal(spawnIdentity('intern-roy', undefined).character, 'roy');
});
