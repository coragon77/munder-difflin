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
 * then the default character, with a deterministic id-hash accent.
 */
const test = require('node:test');
const assert = require('node:assert');
const load = require('./load-ts.cjs');

const { spawnIdentity, SPAWN_ACCENTS } = load('src/renderer/src/scene/office/spawnIdentity.ts');

test('recall reuses the prior row identity (ada keeps angela/sky)', () => {
  const firstCard = spawnIdentity('ada-msw5vf5o', 'Ada');
  // The unfixed bug in one assertion: no cast member named "ada", so the plain
  // fallback yields the default — NOT the angela she was hired as.
  assert.notEqual(firstCard.character, 'angela');

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

test('first carding: cast-name match, else default character', () => {
  assert.equal(spawnIdentity('dwight-msu29wrc', 'Dwight').character, 'dwight');
  assert.equal(spawnIdentity('pam-msu2xdpo', 'Pam').character, 'pam');
  assert.equal(spawnIdentity('ada-msw5vf5o', 'Ada').character, 'jim'); // DEFAULT_CHARACTER
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
  // "ada" matches no cast member — derivation yields the default (jim).
  const saved = spawnIdentity('ada-1', 'Ada', undefined, { character: 'angela', accent: 'sky' });
  assert.equal(saved.character, 'angela');
  assert.equal(saved.accent, 'sky');
});

test('an unknown saved character is ignored, never rendered', () => {
  // Registry strings are written by whatever version wrote them — a name the
  // current cast does not know must fall through to the normal ladder, not
  // crash the sprite lookup downstream.
  const r = spawnIdentity('ada-1', 'Ada', undefined, { character: 'not-a-cast-member' });
  assert.equal(r.character, 'jim', 'falls through to the default, not the bogus value');
  // Derivation still picks a stable accent when the saved accent is missing.
  assert.ok(SPAWN_ACCENTS.includes(r.accent));
});

test('an unknown saved accent is ignored', () => {
  const r = spawnIdentity('ada-1', 'Ada', undefined, { character: 'angela', accent: 'neon' });
  assert.equal(r.character, 'angela');
  assert.ok(SPAWN_ACCENTS.includes(r.accent), 'accent falls back to the id-hash rotation');
});
