'use strict';

/**
 * GEAR ON VACATION + ARCHIVED ROWS (harness-gear-vacation-archived-20260817).
 *
 * The monitor tab's edit gear (harness-editbtn-monitor-20260817) covered only
 * ACTIVE agent cards. Stefan wants it on the VACATION and ARCHIVED rows too —
 * same dialog, pre-filled. Two things must be true for that to be honest:
 *
 *  • The dialog must FIND the agent: App's editOf lookup spans only the active
 *    list — it must also search archivedAgents, or the modal silently never
 *    opens for a parked/archived id.
 *  • The save must LAND somewhere durable: the edit branch calls updateAgent,
 *    which maps over ACTIVE agents only — for an archived id that was a silent
 *    no-op, losing engine edits (command/model/permissionMode) that the NEXT
 *    RECALL reads from roster.json's archived rows. updateAgent must patch the
 *    archived entry too (persistArchived already mirrors it to the roster).
 *
 * Registry fields (name/role/icon) already work for any id — hiveSetAgentMeta
 * is id-keyed (Meredith's overwrite path, in main since batch 3).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// store.ts reads window/localStorage at module load — shim before requiring it
// (same discipline as vacation-store.test.cjs).
const memoryStorage = {
  data: {},
  getItem(k) {
    return Object.hasOwn(this.data, k) ? this.data[k] : null;
  },
  setItem(k, v) {
    this.data[k] = String(v);
  },
  removeItem(k) {
    delete this.data[k];
  },
};
globalThis.localStorage = memoryStorage;
globalThis.window = {
  localStorage: memoryStorage,
  addEventListener() {},
  setTimeout,
  clearTimeout,
};

const { readFileSync } = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { useStore } = loadTs('src/renderer/src/store/store.ts');

const repoRoot = path.join(__dirname, '..');
const read = (p) => readFileSync(path.join(repoRoot, p), 'utf8');

const agent = (id, extra = {}) => ({
  id,
  name: id,
  character: 'jim',
  accent: 'coral',
  description: '',
  cwd: '/tmp',
  command: 'claude',
  status: 'idle',
  action: 'idle',
  ...extra,
});

// ─── the save path: updateAgent must reach archived agents ──────────────────

test('updateAgent patches an ARCHIVED agent — the recall recipe source, not a silent no-op', () => {
  const pam = agent('pam-1', { command: 'claude', model: 'opus' });
  useStore.setState({ agents: [], archivedAgents: [pam] });
  useStore.getState().updateAgent('pam-1', { command: 'pi --approve', model: undefined });

  const after = useStore.getState().archivedAgents.find((a) => a.id === 'pam-1');
  assert.ok(after, 'the archived entry still exists');
  assert.equal(after.command, 'pi --approve', 'the engine edit lands on the archived entry');
  assert.equal(after.model, undefined, 'the model edit lands too');
  // And it mirrors to the roster (what main's rosterRecipe reads on recall).
  const mirrored = (() => {
    const raw = memoryStorage.data['cth.archivedAgents'];
    return raw ? JSON.parse(raw) : [];
  })();
  assert.equal(
    mirrored.find((a) => a.id === 'pam-1')?.command,
    'pi --approve',
    'the patched archived entry persists',
  );
});

test('updateAgent keeps active-agent semantics — no archived cross-contamination', () => {
  const jim = agent('jim-1');
  const pam = agent('pam-1', { vacation: true });
  useStore.setState({ agents: [jim], archivedAgents: [pam] });
  useStore.getState().updateAgent('jim-1', { description: 'live edit' });

  assert.equal(
    useStore.getState().agents.find((a) => a.id === 'jim-1').description,
    'live edit',
    'active edit lands',
  );
  assert.equal(
    useStore.getState().archivedAgents.find((a) => a.id === 'pam-1').description,
    '',
    'the archived sibling is untouched by an active-agent edit',
  );
});

// ─── wiring pins (renderer source-pinned — no DOM harness) ──────────────────

test('VACATION rows carry the edit gear, human-class scoped, wired to their own id', () => {
  const src = read('src/renderer/src/components/CommandCenterPanel.tsx');
  const at = src.indexOf('function VacationSection');
  const section = src.slice(at, src.indexOf('function ArchivedSection'));
  assert.ok(at > 0, 'VacationSection exists');
  assert.ok(section.includes('setEditAgent(a.id)'), 'vacation rows open the dialog');
  assert.ok(
    section.includes("agentClassOf(a) === 'human'"),
    'gear is human-class only (no god/interns)',
  );
});

test('ARCHIVED rows carry the edit gear, human-class scoped, wired to their own id', () => {
  const src = read('src/renderer/src/components/CommandCenterPanel.tsx');
  const at = src.indexOf('function ArchivedSection');
  assert.ok(at > 0, 'ArchivedSection exists');
  const section = src.slice(at, src.indexOf('// ─── Memory tab'));
  assert.ok(section.includes('setEditAgent(a.id)'), 'archived rows open the dialog');
  assert.ok(
    section.includes("agentClassOf(a) === 'human'"),
    'gear is human-class only (no god/interns)',
  );
});

test("App's dialog lookup spans archived agents — the modal opens pre-filled", () => {
  const src = read('src/renderer/src/App.tsx');
  assert.ok(
    /archivedAgents.*editAgentId|editAgentId.*archivedAgents/s.test(src),
    'the editOf resolution considers archivedAgents',
  );
});
