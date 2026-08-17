'use strict';

/**
 * Human-task mail must reference its card (card
 * agent-harness-human-task-mail--2026-08-17).
 *
 * The tasks-tab assign flow (card detail → "assign") seeds the Floor
 * dispatch box and mails god a 'Task from the human'. That mail now carries
 * the created card's id BOTH structurally (a cardId field on the message
 * JSON) and in prose (a 'Card: <id>' body line), so god can enrich + assign
 * THE EXISTING human-origin card instead of minting a duplicate (live
 * incident: human-kampa-ticket-3216-2026-08-17 got a god-made twin).
 *
 * Also pins the shipped floor docs: COMMANDS.md documents
 * `hive-card update`, and the hive-root AGENTS.md carries the
 * enrich-don't-duplicate rule (harness rules live in the harness).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager, hiveRootAgentsMd } = loadTs('src/main/hive.ts');

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-human-card-ref-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureAgent({ id: 'god1', name: 'God', provider: 'claude', cwd: home, isGod: true });
  const hiveRoot = path.join(home, 'hive');
  return { home, hive, hiveRoot };
}

test("send: a cardId on the mail survives routing into god's inbox file", async (t) => {
  const { hive, hiveRoot } = setup(t);
  const card = hive.addHumanTask('Kampa: Ticket #3216');
  const msg = hive.send(
    {
      to: 'god',
      act: 'request',
      subject: 'Task from the human',
      body: `Task: ${card.title}\nContext: (no description)\nCard: ${card.id}\n`,
      cardId: card.id,
    },
    'human',
  );
  assert.equal(msg.cardId, card.id, 'the round-tripped message keeps cardId');

  const file = path.join(hiveRoot, 'agents', 'god1', 'inbox', `${msg.id}.json`);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.cardId, card.id, 'the delivered JSON carries the cardId field');
  assert.match(onDisk.body, new RegExp('Card: ' + card.id), 'the body carries the Card line');
});

test('send: mail without cardId stays shaped exactly as before', async (t) => {
  const { hive, hiveRoot } = setup(t);
  const msg = hive.send(
    { to: 'god', act: 'request', subject: 'Task from the human', body: 'plain prose' },
    'human',
  );
  assert.equal(msg.cardId, undefined);
  const onDisk = JSON.parse(
    fs.readFileSync(path.join(hiveRoot, 'agents', 'god1', 'inbox', `${msg.id}.json`), 'utf8'),
  );
  assert.equal('cardId' in onDisk, false, 'no empty cardId key is written');
});

test('shipped floor docs carry the update subcommand and the no-duplicate rule', async (t) => {
  const { hiveRoot } = setup(t);

  const cli = fs.readFileSync(path.join(hiveRoot, 'bin', 'hive-card'), 'utf8');
  assert.match(cli, /hive-card update <id>/, 'usage names update');

  const commands = fs.readFileSync(path.join(hiveRoot, 'COMMANDS.md'), 'utf8');
  assert.match(commands, /hive-card.{0,400}update/, 'COMMANDS.md documents hive-card update');

  const agentsMd = hiveRootAgentsMd(false);
  assert.match(
    agentsMd,
    /references (an? existing )?card|references its card/,
    'AGENTS.md ties human task mail to its card',
  );
  assert.match(
    agentsMd,
    /enrich and assign THAT existing card[\s\S]*never mint a\s+duplicate card/,
    'AGENTS.md forbids duplicate cards',
  );
});
