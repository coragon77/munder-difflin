'use strict';

/**
 * Remaining force-select paths (card agent-harness-remaining-force--2026-08-17).
 *
 * The sweep behind 0b3ab0e left two hive:agentSpawned senders that still
 * force-selected the spawned agent's pane: the spawnAgent bridge (voice/MAIN
 * spawns) and the setArchived unarchive. Both now stamp select:false on the
 * broadcast — same pattern as the recall fix (b4bb8d4) and the spawn-request
 * fix (0b3ab0e). The renderer pass-through (addAgent(agent, { select:
 * rec.select !== false })) is already pinned by recall-focus-steal, so only
 * the two main-process stamps are pinned here. index.ts is not loadable
 * outside Electron, so the source is pinned (same pattern as spawn-focus-
 * steal).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');

test('voice/MAIN spawns and unarchive re-card in the background', () => {
  const src = read('src/main/index.ts');
  // The spawnAgent bridge (rt voice hire) broadcasts select:false — the card
  // lands on the floor without touching the operator's pane selection.
  assert.match(
    src,
    /liveWebContents\(\)\?\.send\('hive:agentSpawned', \{\s*id: o\.id,[\s\S]{0,1200}?select: false,/,
    'spawnAgent bridge broadcasts select:false (background voice hire)',
  );
  // The setArchived unarchive direction re-cards with select:false; the
  // archive direction reads only { id }, so the shared marker is harmless.
  assert.match(
    src,
    /archived \? 'hive:agentArchived' : 'hive:agentSpawned',[\s\S]{0,600}?select: false,/,
    'unarchive broadcasts select:false (background re-card)',
  );
});
