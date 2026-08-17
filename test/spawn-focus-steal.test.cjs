'use strict';

/**
 * Spawn focus steal (card agent-harness-god-initiated-sp-2026-08-17).
 *
 * Spawning the pi smoke intern via a god spawn-request forcibly showed its
 * pane — same defect class as the recall focus steal (b4bb8d4), on the SPAWN
 * path. God-initiated spawns are BACKGROUND hires: the intern's card lands on
 * the floor but the operator keeps their current pane. The renderer mechanism
 * (addAgent(agent, { select: false }) + the useHive marker pass-through)
 * already exists from the recall card and is pinned there; what is new is the
 * stamp at the spawn-request broadcast source. index.ts is not loadable
 * outside Electron, so the source is pinned (same pattern as recall-focus-
 * steal / worker-intern-switches).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');

test('the spawn-request intern broadcast is background; the UI hire still switches', () => {
  const src = read('src/main/index.ts');
  // processSpawnRequest's persistent-hire broadcast stamps select:false so the
  // renderer cards the intern WITHOUT touching selectedId.
  assert.match(
    src,
    /id: workerId,[\s\S]{0,1200}?select: false,/,
    'god spawn-request broadcasts select:false (background hire)',
  );
  // The operator's Add-Agent flow keeps its explicit switch (default select).
  const modal = read('src/renderer/src/components/AddAgentModal.tsx');
  assert.match(modal, /addAgent\(agent\);/, 'UI hire selects as before');
});
