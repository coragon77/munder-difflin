'use strict';

/**
 * Shared-state PreToolUse gate (card agent-pretooluse-hook-refuse-g-2026-08-19):
 * god must never hand-edit shared hive state — the bin/hive-* primitives own
 * it. The gate refuses Write/Edit against protected paths and Bash commands
 * that target them WITHOUT going through a primitive. The refusal message
 * names the primitive for the attempted operation.
 *
 * THE CENTRAL RULE — gate the COMMAND, not the file: the primitives write
 * these exact files as subprocesses of god's Bash tool, so a naive path block
 * would brick the hive. Exec-position hive-* invocations pass.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// hooks.ts pulls Notification from electron; outside Electron that resolve gives
// a path string, so seed the cache with the surface the server actually touches.
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: {
    Notification: class {
      show() {}
      static isSupported() {
        return false;
      }
    },
  },
};

const { sharedStateGate } = loadTs('src/main/hiveGate.ts');

/** Harness-layout tmp home: <home>/hive is the hive root, like the real thing. */
function floor() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-gate-'));
  const root = path.join(home, 'hive');
  fs.mkdirSync(root, { recursive: true });
  return { home, root };
}

const gate = (root, cwd, toolName, toolInput) =>
  sharedStateGate({ toolName, toolInput, hiveRoot: root, cwd });

// —————————————————————————————————————————————— Write / Edit by file_path —

for (const tool of ['Write', 'Edit', 'write', 'edit']) {
  test(`${tool} to tasks.json is refused`, () => {
    const { root } = floor();
    const d = gate(root, root, tool, { file_path: path.join(root, 'tasks.json') });
    assert.ok(d, 'denied');
    assert.match(d.reason, /hive-dispatch|hive-card/);
  });

  test(`${tool} to registry.json is refused`, () => {
    const { root } = floor();
    const d = gate(root, root, tool, { file_path: path.join(root, 'registry.json') });
    assert.ok(d, 'denied');
  });

  test(`${tool} to fleet.json is refused`, () => {
    const { root } = floor();
    const d = gate(root, root, tool, { file_path: path.join(root, 'fleet.json') });
    assert.ok(d, 'denied');
  });

  test(`${tool} into vacation-requests/ is refused and names hive-park`, () => {
    const { root } = floor();
    const d = gate(root, root, tool, {
      file_path: path.join(root, 'vacation-requests', 'park-pam.json'),
    });
    assert.ok(d, 'denied');
    assert.match(d.reason, /hive-park/);
  });

  test(`${tool} into spawn-requests/ is refused and names hive-hire`, () => {
    const { root } = floor();
    const d = gate(root, root, tool, { file_path: path.join(root, 'spawn-requests', 'req.json') });
    assert.ok(d, 'denied');
    assert.match(d.reason, /hive-hire/);
  });

  test(`${tool} into fire-requests/ is refused and names hive-fire`, () => {
    const { root } = floor();
    const d = gate(root, root, tool, { file_path: path.join(root, 'fire-requests', 'x.json') });
    assert.ok(d, 'denied');
    assert.match(d.reason, /hive-fire/);
  });

  test(`${tool} to board.md passes (god is the sole scribe)`, () => {
    const { root } = floor();
    assert.equal(gate(root, root, tool, { file_path: path.join(root, 'board.md') }), null);
  });

  test(`${tool} to god's memory.md passes`, () => {
    const { root } = floor();
    assert.equal(
      gate(root, root, tool, { file_path: path.join(root, 'agents', 'god-1', 'memory.md') }),
      null,
    );
  });
}

// ———————————————————————————————————————————————— Bash: hand-edit vehicles —

test('python one-liner flipping todo->doing on tasks.json is refused, names hive-dispatch as the ONLY path', () => {
  const { root } = floor();
  const cmd =
    `python3 -c "import json; d=json.load(open('tasks.json')); ` +
    `d['tasks'][0]['status']='doing'; json.dump(d, open('tasks.json','w'), indent=2)"`;
  const d = gate(root, root, 'Bash', { command: cmd });
  assert.ok(d, 'denied');
  assert.match(d.reason, /hive-dispatch/);
  assert.match(d.reason, /ONLY/i);
});

test('python one-liner via $HIVE_ROOT path is refused', () => {
  const { root } = floor();
  const cmd =
    `python3 -c "import json,pathlib; p='$HIVE_ROOT/tasks.json'; d=json.load(open(p)); ` +
    `d['tasks'][0]['paused']=False; pathlib.Path(p).write_text(json.dumps(d))"`;
  const d = gate(root, root, 'Bash', { command: cmd });
  assert.ok(d, 'denied');
  assert.match(d.reason, /hive-card update/);
});

test('jq over tasks.json is refused (funnel through hive-card)', () => {
  const { root } = floor();
  const cmd = `jq '.tasks[] | select(.status=="todo") | .id' $HIVE_ROOT/tasks.json`;
  const d = gate(root, root, 'Bash', { command: cmd });
  assert.ok(d, 'denied');
  assert.match(d.reason, /hive-card/);
});

test('sed -i on fleet.json is refused', () => {
  const { root } = floor();
  const d = gate(root, root, 'Bash', {
    command: `sed -i 's/doing/todo/' $HIVE_ROOT/fleet.json`,
  });
  assert.ok(d, 'denied');
});

test('awk writing registry.json is refused', () => {
  const { root } = floor();
  const d = gate(root, root, 'Bash', {
    command: `awk '{print}' $HIVE_ROOT/registry.json`,
  });
  assert.ok(d, 'denied');
});

test('tee into registry.json is refused', () => {
  const { root } = floor();
  const d = gate(root, root, 'Bash', {
    command: `echo '{}' | tee $HIVE_ROOT/registry.json`,
  });
  assert.ok(d, 'denied');
});

test('shell redirect onto tasks.json is refused', () => {
  const { root } = floor();
  const d = gate(root, root, 'Bash', { command: `echo '{}' > $HIVE_ROOT/tasks.json` });
  assert.ok(d, 'denied');
});

test('append redirect onto relative hive/fleet.json is refused', () => {
  const { home, root } = floor();
  const d = gate(root, home, 'Bash', { command: `cat x.jsonl >> hive/fleet.json` });
  assert.ok(d, 'denied');
});

test('cp into vacation-requests/ is refused and names hive-park', () => {
  const { root } = floor();
  const d = gate(root, root, 'Bash', {
    command: `cp park.json $HIVE_ROOT/vacation-requests/park-pam.json`,
  });
  assert.ok(d, 'denied');
  assert.match(d.reason, /hive-park/);
});

test('heredoc drop into spawn-requests/ is refused and names hive-hire', () => {
  const { root } = floor();
  const cmd = `cat > $HIVE_ROOT/spawn-requests/req.json <<'EOF'\n{"name":"Intern"}\nEOF`;
  const d = gate(root, root, 'Bash', { command: cmd });
  assert.ok(d, 'denied');
  assert.match(d.reason, /hive-hire/);
});

test('rm in fire-requests/ is refused and names hive-fire', () => {
  const { root } = floor();
  const d = gate(root, root, 'Bash', { command: `rm $HIVE_ROOT/fire-requests/x.json` });
  assert.ok(d, 'denied');
  assert.match(d.reason, /hive-fire/);
});

test('mv onto tasks.json is refused', () => {
  const { root } = floor();
  const d = gate(root, root, 'Bash', { command: `mv /tmp/nt $HIVE_ROOT/tasks.json` });
  assert.ok(d, 'denied');
});

test('node one-liner touching tasks.json is refused', () => {
  const { root } = floor();
  const d = gate(root, root, 'Bash', {
    command: `node -e 'require("fs").writeFileSync("$HIVE_ROOT/tasks.json","{}")'`,
  });
  assert.ok(d, 'denied');
});

// ————————————————————————————————————————————————— Bash: primitives pass —

test('every bin/hive-* primitive invocation passes untouched', () => {
  const { root } = floor();
  const cmds = [
    '"$HIVE_ROOT/bin/hive-card" status agent-foo-1 done',
    '"$HIVE_ROOT/bin/hive-card" update agent-foo-1 --paused',
    '"$HIVE_ROOT/bin/hive-card" add --title t --status todo',
    '"$HIVE_ROOT/bin/hive-card" list',
    '"$HIVE_ROOT/bin/hive-card" list --status todo --open',
    '"$HIVE_ROOT/bin/hive-card" list --assignee pam-msvqb91b',
    '"$HIVE_ROOT/bin/hive-card" actionable',
    '"$HIVE_ROOT/bin/hive-dispatch" --card agent-foo-1 --assignee pam --body go',
    '"$HIVE_ROOT/bin/hive-hire" --name Holly --cwd /tmp --objective x',
    '"$HIVE_ROOT/bin/hive-fire" intern-1',
    '"$HIVE_ROOT/bin/hive-park" pam --reason idle',
    '"$HIVE_ROOT/bin/hive-recall" pam',
    '"$HIVE_ROOT/bin/hive-inbox" drain',
    '"$HIVE_ROOT/bin/hive-mail" --to pam --act inform --subject s --body b',
    '"$HIVE_NODE" "$HIVE_ROOT/bin/hive-restart-window" arm abc --repo /repo',
    '$HIVE_ROOT/bin/hive-new --name Jim',
    'sh -c \'"$HIVE_ROOT/bin/hive-dispatch" --title t --assignee pam\'',
  ];
  for (const command of cmds) {
    assert.equal(gate(root, root, 'Bash', { command }), null, `must pass: ${command}`);
  }
});

test('compound command: primitive segment passes but hand-edit segment still refuses', () => {
  const { root } = floor();
  const d = gate(root, root, 'Bash', {
    command: `"$HIVE_ROOT/bin/hive-card" list && python3 -c 'import json; json.dump({}, open("$HIVE_ROOT/tasks.json","w"))'`,
  });
  assert.ok(d, 'denied — the python segment is a hand-edit even next to a primitive');
});

// —————————————————————————————————————————————————————— Bash: reads pass —

test('reads of UNRELATED files pass (the gate is scoped to protected paths)', () => {
  const { root, home } = floor();
  const cmds = [
    `cat ${home}/notes.md`,
    `grep -r pattern ${home}/src`,
    `head -5 ${home}/hive/board.md`,
    `wc -l $HIVE_ROOT/log.jsonl`,
    'ls /tmp',
  ];
  for (const command of cmds) {
    assert.equal(gate(root, root, 'Bash', { command }), null, `must pass: ${command}`);
  }
});

// R3 (card agent-hook-r3-refuse-all-non-p-2026-08-19): refuse ALL non-primitive
// access to protected paths, READS INCLUDED — read-vs-write classification of
// heredoc bodies was the rot surface, so there is nothing left to classify.
// Reads are pointed at hive-card list (Meredith, 7cb1733).

test('R3: read-only cat/grep/head/rg/stat of tasks.json is REFUSED and names hive-card list', () => {
  const { root } = floor();
  const cmds = [
    'cat $HIVE_ROOT/tasks.json',
    'grep -c doing $HIVE_ROOT/tasks.json',
    'head -5 $HIVE_ROOT/tasks.json',
    'rg paused $HIVE_ROOT/tasks.json',
    'stat $HIVE_ROOT/tasks.json',
    'wc -l $HIVE_ROOT/tasks.json',
    'diff $HIVE_ROOT/tasks.json /tmp/old.json',
  ];
  for (const command of cmds) {
    const d = gate(root, root, 'Bash', { command });
    assert.ok(d, `must refuse: ${command}`);
    assert.match(d.reason, /hive-card list/, `must name hive-card list: ${command}`);
  }
});

test('R3: read-only python heredoc against tasks.json is REFUSED and names hive-card list', () => {
  const { root } = floor();
  const cmd = `python3 - <<'EOF'\nimport json\nd = json.load(open("$HIVE_ROOT/tasks.json"))\nprint([t['id'] for t in d['tasks'] if t.get('paused')])\nEOF`;
  const d = gate(root, root, 'Bash', { command: cmd });
  assert.ok(d, 'denied — reads included, heredoc bodies never classified');
  assert.match(d.reason, /hive-card list/);
});

test('R3: ls of a drop-dir is refused with the nothing-covers message naming mail-the-operator', () => {
  const { root } = floor();
  const d = gate(root, root, 'Bash', { command: 'ls $HIVE_ROOT/spawn-requests/' });
  assert.ok(d, 'denied');
  assert.match(d.reason, /hive-hire/);
  assert.match(d.reason, /mail the operator/i);
});

test('R2: nothing-covers-this refusal (registry.json) names MAIL-THE-OPERATOR and no-retry', () => {
  const { root } = floor();
  const d = gate(root, root, 'Bash', {
    command: `python3 -c 'import json; json.dump({}, open("$HIVE_ROOT/registry.json","w"))'`,
  });
  assert.ok(d, 'denied');
  assert.match(d.reason, /mail the operator/i);
  assert.match(d.reason, /do not thrash retrying|do not hand-edit/);
});

test('R2: tasks.json refusal references hive-card restore for corrupt-ledger repair', () => {
  const { root } = floor();
  const d = gate(root, root, 'Bash', {
    command: `python3 -c 'import json; json.dump({}, open("$HIVE_ROOT/tasks.json","w"))'`,
  });
  assert.ok(d, 'denied');
  assert.match(d.reason, /hive-card restore/);
});

test('R3: fleet.json read is refused (roster arrives via the injected roster line)', () => {
  const { root } = floor();
  const d = gate(root, root, 'Bash', { command: 'cat $HIVE_ROOT/fleet.json' });
  assert.ok(d, 'denied');
  assert.match(d.reason, /roster/);
});

test('bare tasks.json from a cwd OUTSIDE the hive root passes (not our file)', () => {
  const { home, root } = floor();
  const outside = path.join(home, 'elsewhere');
  fs.mkdirSync(outside);
  assert.equal(
    gate(root, outside, 'Bash', {
      command: `python3 -c 'import json; json.load(open("tasks.json"))'`,
    }),
    null,
  );
});

test('bare tasks.json with cwd AT the hive root is refused', () => {
  const { root } = floor();
  const d = gate(root, root, 'Bash', {
    command: `python3 -c 'import json; json.dump({}, open("tasks.json","w"))'`,
  });
  assert.ok(d, 'denied');
});

// ———————————————————————————————————————— HookServer integration: god only —

const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

async function serverFloor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-gate-srv-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({
    id: 'god-1',
    name: 'Michael',
    provider: 'claude',
    cwd: home,
    isGod: true,
  });
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: home });
  const events = [];
  const server = new HookServer(
    hive,
    () => ({ send: (c, p) => events.push({ c, p }) }),
    () => ({
      notifications: false,
    }),
  );
  const fire = (agent_id, tool_name, tool_input) =>
    server.handle({
      agent_id,
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      tool_name,
      tool_input,
      cwd: hive.root(),
    });
  return { home, hive, server, fire, events };
}

test('god python flip through HookServer returns a deny decision with the primitive-naming reason', async (t) => {
  const { hive, fire } = await serverFloor(t);
  const res = fire('god-1', 'Bash', {
    command: `python3 -c "import json; d=json.load(open('${hive.root()}/tasks.json')); d['tasks'][0]['status']='doing'; json.dump(d, open('${hive.root()}/tasks.json','w'))"`,
  });
  assert.equal(res.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(res.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(res.hookSpecificOutput.permissionDecisionReason, /hive-dispatch/);
});

test('the same hand-edit from a WORKER passes — the gate is god-only', async (t) => {
  const { hive, fire } = await serverFloor(t);
  const res = fire('pam-1', 'Bash', {
    command: `python3 -c "import json; json.dump({}, open('${hive.root()}/tasks.json','w'))"`,
  });
  assert.deepEqual(res, {});
});

test('god runs hive-card through HookServer: no denial (primitive path verified)', async (t) => {
  const { fire } = await serverFloor(t);
  const res = fire('god-1', 'Bash', {
    command: '"$HIVE_ROOT/bin/hive-card" status agent-foo-1 done',
  });
  assert.deepEqual(res, {});
});

test('god runs hive-dispatch through HookServer: no denial (primitive path verified)', async (t) => {
  const { fire } = await serverFloor(t);
  const res = fire('god-1', 'Bash', {
    command: '"$HIVE_ROOT/bin/hive-dispatch" --card agent-foo-1 --assignee pam --body contract',
  });
  assert.deepEqual(res, {});
});

test('god Write to board.md through HookServer passes (sole scribe)', async (t) => {
  const { hive, fire } = await serverFloor(t);
  const res = fire('god-1', 'Write', { file_path: path.join(hive.root(), 'board.md') });
  assert.deepEqual(res, {});
});

test('god Write to tasks.json through HookServer is denied', async (t) => {
  const { hive, fire } = await serverFloor(t);
  const res = fire('god-1', 'Write', { file_path: path.join(hive.root(), 'tasks.json') });
  assert.equal(res.hookSpecificOutput.permissionDecision, 'deny');
});
