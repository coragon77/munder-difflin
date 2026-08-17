/**
 * Intern portrait pool (card agent-harness-intern-portrait--2026-08-17).
 *
 * Interns used to render as ONLY Angela (female-coded names) or Jim
 * (everything else). This card adds 10 intern-only Office side characters as
 * portraitArt.ts recipes — a 5-face female pool + a 5-face male pool — and
 * spawnIdentity hashes the intern's NAME onto the matching pool: stable, same
 * name always same face. An intern must NEVER wear a hire-cast face by
 * default mapping (the floor reads by face), while the icon PICKER lists all
 * 25 faces and an operator pick (saved identity) always wins.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const load = require('./load-ts.cjs');

const { spawnIdentity, INTERN_FEMALE_POOL, INTERN_MALE_POOL } = load(
  'src/renderer/src/scene/office/spawnIdentity.ts',
);
const { OFFICE_CAST } = load('src/renderer/src/scene/office/cast.ts');
const portraitArt = load('src/renderer/src/scene/office/portraitArt.ts');

/** The 15 hire-cast faces — an intern must never wear one by DEFAULT mapping. */
const HIRE_CAST = [
  'michael',
  'jim',
  'pam',
  'dwight',
  'kevin',
  'angela',
  'oscar',
  'stanley',
  'phyllis',
  'andy',
  'kelly',
  'ryan',
  'toby',
  'creed',
  'meredith',
];
const FEMALE_POOL = ['holly', 'erin', 'jan', 'karen', 'nellie'];
const MALE_POOL = ['darryl', 'roy', 'gabe', 'robert', 'mose'];

test('the cast is 25 members: 15 hires + 10 interns', () => {
  assert.equal(OFFICE_CAST.length, 25);
  const names = OFFICE_CAST.map((c) => c.name);
  assert.equal(new Set(names).size, 25, 'cast names are unique');
  for (const n of [...HIRE_CAST, ...FEMALE_POOL, ...MALE_POOL]) {
    assert.ok(names.includes(n), `cast contains ${n}`);
  }
});

test('the icon picker enumerates all 25 faces (picker maps OFFICE_CAST)', () => {
  // AddAgentModal's Character picker is literally `OFFICE_CAST.map(...)` —
  // the 25-entry cast IS the picker list; pin the wiring so a future
  // hard-coded sublist cannot silently hide the interns.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src/renderer/src/components/AddAgentModal.tsx'),
    'utf8',
  );
  assert.ok(src.includes('OFFICE_CAST.map('), 'picker enumerates OFFICE_CAST');
  assert.equal(OFFICE_CAST.length, 25);
});

test('the intern pools are the 10 new faces, never a hire face', () => {
  assert.deepEqual([...INTERN_FEMALE_POOL], FEMALE_POOL);
  assert.deepEqual([...INTERN_MALE_POOL], MALE_POOL);
  for (const n of [...INTERN_FEMALE_POOL, ...INTERN_MALE_POOL]) {
    assert.ok(!HIRE_CAST.includes(n), `${n} is not a hire-cast face`);
  }
});

test('female-coded names hash onto the female pool — pinned name->face map', () => {
  // The hash is a char-code sum of the name token mod pool size — pin the
  // concrete outcomes so a pool reorder or hash change is a loud diff.
  assert.equal(spawnIdentity('ada-1', 'Ada').character, 'nellie');
  assert.equal(spawnIdentity('emma-1', 'Emma').character, 'erin');
  assert.equal(spawnIdentity('sara-1', 'Sara').character, 'karen');
});

test('other names hash onto the male pool — pinned name->face map', () => {
  assert.equal(spawnIdentity('carl-1', 'Carl').character, 'robert');
  assert.equal(spawnIdentity('bob-1', 'Bob').character, 'gabe');
  assert.equal(spawnIdentity('pete-1', 'Pete').character, 'darryl');
});

test('same name always maps to the same face', () => {
  const a = spawnIdentity('x-1', 'Wendy');
  const b = spawnIdentity('x-2', 'Wendy');
  assert.equal(a.character, b.character);
});

test('the pool hash also works on the tokens of an id key', () => {
  // Live spawn patterns: name undefined, id rides 'name-xxxx' or 'intern-name'.
  assert.equal(spawnIdentity('ada-msw5vf5o', undefined).character, 'nellie');
  assert.equal(spawnIdentity('intern-pete', 'Pete (Intern)').character, 'darryl');
});

test('a cast-name match still outranks the pool hash', () => {
  // Interns named after a pool character get THAT face via the cast rung.
  assert.equal(spawnIdentity('holly-msx1', 'Holly').character, 'holly');
  assert.equal(spawnIdentity('dwight-msu29wrc', 'Dwight').character, 'dwight');
});

test('a registry-saved pick beats the pool mapping', () => {
  assert.equal(spawnIdentity('ada-1', 'Ada', undefined, { character: 'jim' }).character, 'jim');
});

test('a prior row beats the pool mapping', () => {
  const prior = spawnIdentity('holly-1', 'Holly', { character: 'jim', accent: 'lemon' });
  assert.equal(prior.character, 'jim');
});

test('all 25 recipes render distinct portrait buffers', () => {
  assert.equal(typeof portraitArt.portraitBuf, 'function');
  const names = OFFICE_CAST.map((c) => c.name);
  const bufs = names.map((n) => Buffer.from(portraitArt.portraitBuf(n)));
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      assert.ok(!bufs[i].equals(bufs[j]), `${names[i]} and ${names[j]} portraits differ`);
    }
  }
});

test('all 25 recipes render distinct scene walking frames', () => {
  const names = OFFICE_CAST.map((c) => c.name);
  const frames = names.map((n) => Buffer.from(portraitArt.sceneFrameBufs(n).front[0]));
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      assert.ok(!frames[i].equals(frames[j]), `${names[i]} and ${names[j]} scene frames differ`);
    }
  }
});
