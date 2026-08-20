'use strict';

/**
 * The tickets-view contract (card agent-implement-the-tickets-vi-2026-08-20,
 * spec docs/superpowers/specs/2026-08-20-tickets-view.md §3–§7).
 *
 * The /ticket-overview skill writes ~/.cache/ticket-overview/tickets.json;
 * main validates it (app:tickets IPC → TicketsState | null), the renderer
 * renders it. The TRAP the spec calls out: generated_at is LOCAL
 * "YYYY-MM-DD HH:MM" — no zone, no seconds — NOT ISO-Z. A lenient
 * Date.parse would guess a timezone per engine and show a WRONG staleness
 * badge instead of failing loudly; these tests pin the explicit local
 * construction and the version-gated file validation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { TICKETS_STALE_MS, parseGeneratedAt, parseTicketsState } = loadTs('src/shared/tickets.ts');

const row = (over = {}) => ({
  id: 3214,
  subject: 'E-Rechnungen',
  priority: 'Normal',
  priority_id: 2,
  status: 'In Bearbeitung',
  project: 'Schultzundschirm',
  updated_on: '2026-08-18T11:32:29Z',
  roles: 'A',
  active: true,
  recap: 'state sentence **Next:** do the thing',
  ...over,
});
const state = (over = {}) => ({
  version: 1,
  generated_at: '2026-08-20 08:31',
  redmine_base: 'https://redmine.asol.at',
  tickets: [row()],
  ...over,
});

test('the 26h staleness horizon is a named constant (spec §7)', () => {
  assert.equal(TICKETS_STALE_MS, 26 * 60 * 60 * 1000);
});

test('generated_at parses as LOCAL time, month 1-based, minute resolution', () => {
  // Pinned against the only correct-by-construction local parse. Catches both
  // failure modes: an ISO-Z-style parse (wrong epoch in every nonzero-offset
  // zone) and a 0-based month slip (September for August).
  assert.equal(parseGeneratedAt('2026-08-20 08:31'), new Date(2026, 7, 20, 8, 31).getTime());
  // Round-trip through the LOCAL getters — proves the fields landed where the
  // local constructor puts them, not at some engine-guessed offset.
  const t = new Date(parseGeneratedAt('2026-08-20 08:31'));
  assert.equal(t.getFullYear(), 2026);
  assert.equal(t.getMonth(), 7);
  assert.equal(t.getDate(), 20);
  assert.equal(t.getHours(), 8);
  assert.equal(t.getMinutes(), 31);
});

test('generated_at rejects ISO-Z, seconds, garbage — and calendar rollovers', () => {
  assert.equal(parseGeneratedAt('2026-08-20T08:31:00Z'), null);
  assert.equal(parseGeneratedAt('2026-08-20 08:31:45'), null);
  assert.equal(parseGeneratedAt('2026-08-20'), null);
  assert.equal(parseGeneratedAt(''), null);
  assert.equal(parseGeneratedAt('garbage'), null);
  // The local constructor ROLLS these over instead of rejecting — the
  // round-trip check must catch them (review finding 4).
  assert.equal(parseGeneratedAt('2026-02-30 08:31'), null);
  assert.equal(parseGeneratedAt('2026-08-20 24:31'), null);
  assert.equal(parseGeneratedAt('2026-08-20 08:60'), null);
});

test('a real-shaped file validates and keeps the script sort order', () => {
  const s = state({ tickets: [row({ id: 2 }), row({ id: 1 })] });
  const out = parseTicketsState(s);
  assert.ok(out);
  assert.deepEqual(
    out.tickets.map((t) => t.id),
    [2, 1],
  );
  assert.equal(out.generated_at, '2026-08-20 08:31');
  assert.equal(out.redmine_base, 'https://redmine.asol.at');
});

test('unknown extra fields are ignored (version-gated, forward-compatible)', () => {
  const out = parseTicketsState(state({ extra_top: true, tickets: [row({ extra_row: 'x' })] }));
  assert.ok(out);
  assert.equal(out.tickets.length, 1);
});

test('recap is null for inactive and recap-less tickets (contract §3)', () => {
  const out = parseTicketsState(
    state({ tickets: [row({ active: false, recap: null }), row({ active: true, recap: null })] }),
  );
  assert.ok(out);
  assert.equal(out.tickets[0].recap, null);
  assert.equal(out.tickets[1].recap, null);
});

test('wrong version, wrong shapes → null (the empty state, visibly)', () => {
  assert.equal(parseTicketsState(null), null);
  assert.equal(parseTicketsState('nope'), null);
  assert.equal(parseTicketsState(state({ version: 2 })), null);
  assert.equal(parseTicketsState(state({ version: undefined })), null);
  assert.equal(parseTicketsState(state({ generated_at: 123 })), null);
  assert.equal(parseTicketsState(state({ redmine_base: null })), null);
  assert.equal(parseTicketsState(state({ tickets: 'no' })), null);
  // A malformed ROW rejects the whole file: the writer broke the contract —
  // better one visible empty state than 94 rendered rows hiding a broken 95th.
  assert.equal(parseTicketsState(state({ tickets: [row(), { id: 'x' }] })), null);
  assert.equal(parseTicketsState(state({ tickets: [row({ subject: 7 })] })), null);
  assert.equal(parseTicketsState(state({ tickets: [row({ active: 'yes' })] })), null);
  assert.equal(parseTicketsState(state({ tickets: [row({ recap: 5 })] })), null);
});

test('a broken generated_at rejects the whole file (empty state, visibly)', () => {
  assert.equal(parseTicketsState(state({ generated_at: '2026-08-20T08:31Z' })), null);
  assert.equal(parseTicketsState(state({ generated_at: 'not a date' })), null);
});

test('redmine_base is scheme-gated at the trust boundary (review finding 3)', () => {
  // It becomes row hrefs opened in the external browser — http(s) only.
  assert.ok(parseTicketsState(state())); // https passes
  assert.ok(parseTicketsState(state({ redmine_base: 'http://redmine.internal' })));
  assert.equal(parseTicketsState(state({ redmine_base: 'file:///etc/passwd' })), null);
  assert.equal(parseTicketsState(state({ redmine_base: 'javascript:alert(1)' })), null);
  assert.equal(parseTicketsState(state({ redmine_base: 'redmine.asol.at' })), null); // no scheme
});
