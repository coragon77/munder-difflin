'use strict';
/**
 * Floor status out of sync: working agents render idle / standing
 * (card agent-floor-status-out-of-sync-2026-08-18).
 *
 * Two verified root causes, both fixed on this branch:
 *
 * (A) STANDING/CLUSTERED — commit 34958c5 made card transitions choreographed:
 *     every NEW card walks god (actorFor(_, preferGod=true) always picks god)
 *     from the CEO desk to the PIN/TAKE stands, every todo→doing walks the
 *     assignee. A dispatch fan-out (create card + assign N workers, the hive's
 *     standard parallel pattern) marches god + all assignees to the board
 *     stands AT ONCE — pixel-verified on the operator's 16:23 screenshot:
 *     four sprites with live work bubbles clustered under the boards (top of
 *     the map), every PC desk dark (screens only light while seated). The
 *     statuses were CORRECT; the theatre owned working agents' bodies.
 *     Fix: canChoreograph() — only idle/waiting/success agents walk for the
 *     boards; busy ones get the instant board update.
 *
 * (B) RENDERS IDLE — the #2e quiesce fallback flips a working agent to idle
 *     after 12s of pty+hook silence, but a pi tool run is silent on BOTH
 *     planes for the tool's whole duration (live probe: 25s+ dead pty during a
 *     bash sleep; cost-ledger gaps mid-work: 121s–5166s). PreToolUse fires,
 *     then nothing until PostToolUse — every pi tool >12s flipped its sprite
 *     idle mid-work. Fix: quiesce skips agents with a tool IN FLIGHT
 *     (PreToolUse without its PostToolUse), stale after 30min so a dead
 *     bridge still drains.
 *
 * Run with `node --test test/floor-status-sync.test.cjs`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const ts = require('typescript');
const ROOT = path.join(__dirname, '..');

/** Transpile a TS module to a loadable ESM file (no imports here). */
async function loadModule(relPath) {
  const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: path.basename(relPath),
  }).outputText;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'floor-status-')), 'mod.mjs');
  fs.writeFileSync(file, out, 'utf8');
  return import(pathToFileURL(file).href);
}

// — part 1: busy agents are never choreographed for board moves ————————————

test('canChoreograph: only idle/waiting/success agents may walk to the boards', async () => {
  const { canChoreograph } = await loadModule(
    'src/renderer/src/scene/office/taskBoardReconcile.ts',
  );
  // The regression: these statuses own the agent's body — instant board update.
  assert.equal(canChoreograph('working'), false, 'working agents must not leave their desk');
  assert.equal(canChoreograph('thinking'), false);
  assert.equal(canChoreograph('compacting'), false);
  assert.equal(canChoreograph('blocked'), false, 'blocked agents wait at the door');
  assert.equal(canChoreograph('looping'), false, 'breaker-pinned agents hold position');
  // Free-to-move agents keep the theatre.
  assert.equal(canChoreograph('idle'), true);
  assert.equal(canChoreograph('waiting'), true, 'waiting (N) sits at the desk, may walk');
  assert.equal(canChoreograph('success'), true);
  assert.equal(canChoreograph(undefined), false, 'unknown status fails closed');
});

test('OfficeFloor gates moveQueue pushes on canChoreograph', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/renderer/src/scene/office/OfficeFloor.tsx'),
    'utf8',
  );
  assert.match(src, /actorFree = mv \? canChoreograph\(/, 'emission must consult canChoreograph');
  assert.match(
    src,
    /if \(\s*mv &&\s*actorFree &&\s*!busyActors\.has/,
    'moveQueue.push requires a free actor',
  );
});

// — part 2: quiesce respects tools in flight ————————————————————————————————

test('useHive: PreToolUse marks in-flight, PostToolUse/Stop clear, quiesce skips', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/src/hooks/useHive.ts'), 'utf8');
  // marker exists
  assert.match(src, /const inflightToolAt = useRef<Record<string, number>>\(\{\}\);/);
  // set on PreToolUse, cleared on completion/turn-end
  assert.match(
    src,
    /e\.event === 'PreToolUse' && e\.tool[\s\S]{0,200}inflightToolAt\.current\[e\.agentId\] = Date\.now\(\)/,
  );
  assert.match(
    src,
    /e\.event === 'PostToolUse' \|\| e\.event === 'UserPromptSubmit'[\s\S]{0,400}delete inflightToolAt\.current\[e\.agentId\]/,
  );
  assert.match(
    src,
    /e\.event === 'Stop' \|\| e\.event === 'SubagentStop'[\s\S]{0,400}delete inflightToolAt\.current\[e\.agentId\]/,
  );
  // the quiesce loop skips in-flight tools, bounded by staleness
  assert.match(src, /INFLIGHT_TOOL_STALE_MS = 30 \* 60_000/);
  assert.match(
    src,
    /const inflight = inflightToolAt\.current\[a\.id\];\s*\n\s*if \(inflight && now - inflight <= INFLIGHT_TOOL_STALE_MS\) continue;/,
    'quiesce must skip agents with a fresh in-flight tool',
  );
});
