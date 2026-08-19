'use strict';
// Live-protocol verification for card agent-pretooluse-hook-refuse-g-2026-08-19.
// Stands up the NEW HookServer on a real Unix socket (tmp hive home) and talks
// the cth-hook wire protocol: one JSON payload + '\n', read the JSON response —
// exactly what `bin/cth-hook.cjs` does on god's every tool call.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const loadTs = require('./load-ts.cjs');

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

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-gate-live-'));
  const { HiveManager } = loadTs('src/main/hive.ts');
  const { HookServer } = loadTs('src/main/hooks.ts');
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({
    id: 'god-1',
    name: 'Michael',
    provider: 'claude',
    cwd: home,
    isGod: true,
  });
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'pi', cwd: home });
  const server = new HookServer(
    hive,
    () => null,
    () => ({ notifications: false }),
  );
  server.start();
  const sock = hive.sockPath();
  console.log('setup complete, sock =', sock);

  const ask = (payload) =>
    new Promise((resolve, reject) => {
      const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\n'));
      let buf = '';
      c.setEncoding('utf8');
      // The server answers with conn.end(json) — NO trailing newline (the real
      // cth-hook shim reads until close, not until newline).
      c.on('data', (d) => {
        buf += d;
      });
      c.on('end', () => resolve(buf ? JSON.parse(buf) : {}));
      c.on('error', reject);
      setTimeout(() => reject(new Error('hook socket timeout')), 10000);
    });

  const ptu = (agent_id, tool_name, tool_input) => ({
    agent_id,
    hook_event_name: 'PreToolUse',
    session_id: 'live-check',
    tool_name,
    tool_input,
    cwd: hive.root(),
  });

  // (a) hive-card through the hook
  console.log('asking (a)...');
  const a = await ask(
    ptu('god-1', 'Bash', { command: '"$HIVE_ROOT/bin/hive-card" status agent-foo-1 done' }),
  );
  console.log('=== (a) god Bash hive-card →', JSON.stringify(a));

  // (a2) hive-dispatch through the hook
  const a2 = await ask(
    ptu('god-1', 'Bash', {
      command: '"$HIVE_ROOT/bin/hive-dispatch" --card agent-foo-1 --assignee pam --body contract',
    }),
  );
  console.log('=== (a2) god Bash hive-dispatch →', JSON.stringify(a2));

  // (b) the incident's python one-liner (paused card hand-flipped to doing)
  const b = await ask(
    ptu('god-1', 'Bash', {
      command: `python3 -c "import json; d=json.load(open('${hive.root()}/tasks.json')); [t.update(status='doing') for t in d['tasks'] if t['id']=='agent-hold-1']; json.dump(d, open('${hive.root()}/tasks.json','w'), indent=2)"`,
    }),
  );
  console.log('=== (b) god Bash python flip →');
  console.log(b.hookSpecificOutput ? JSON.stringify(b, null, 2) : JSON.stringify(b));

  // (c) Write to board.md passes (god is the sole scribe)
  const c = await ask(ptu('god-1', 'Write', { file_path: path.join(hive.root(), 'board.md') }));
  console.log('=== (c) god Write board.md →', JSON.stringify(c));

  // (d) scope: the same python hand-edit from a WORKER passes
  const d = await ask(
    ptu('pam-1', 'Bash', {
      command: `python3 -c "import json; json.dump({}, open('${hive.root()}/tasks.json','w'))"`,
    }),
  );
  console.log('=== (d) worker python (must PASS, god-only scope) →', JSON.stringify(d));

  server.stop();
  fs.rmSync(home, { recursive: true, force: true });
  const deny = (r) => r?.hookSpecificOutput?.permissionDecision === 'deny';
  const ok =
    Object.keys(a).length === 0 &&
    Object.keys(a2).length === 0 &&
    deny(b) &&
    /hive-dispatch/.test(String(b.hookSpecificOutput.permissionDecisionReason)) &&
    Object.keys(c).length === 0 &&
    Object.keys(d).length === 0;
  console.log(ok ? 'LIVE-PROTOCOL VERIFICATION: PASS' : 'LIVE-PROTOCOL VERIFICATION: FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
