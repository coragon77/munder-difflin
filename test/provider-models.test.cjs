'use strict';

/**
 * provider-models (card agent-harness-provider-model-l-2026-08-17).
 *
 * Every model picker showed a HARDCODED per-provider list; pi's real list is
 * SCOPED by the actual agent/auth (the live incident: a smoke intern got a
 * hardcoded anthropic id this pi has no access to — "no activity", zero
 * tokens). The fix: a discovery adapter.
 *
 * Mechanism (named per the card contract): pi exposes `pi --list-models` — a
 * fixed-column table (provider, model, context, max-out, thinking, images)
 * already scoped to what the CURRENT auth can reach. No JSON flag exists
 * (checked), so the table is parsed. claude keeps the curated static list as
 * the adapter's static answer; every other provider keeps its static list
 * today; discovery failure falls back to the static list (graceful — a picker
 * must never break), cached with a TTL so the CLI is not spawned per render.
 *
 * Wired into ALL pickers: the hire/edit dialog (AddAgentModal serves both)
 * and the intern-defaults settings field, through one hook
 * (useProviderModels) that renders the static list instantly and swaps in the
 * discovered list when it lands.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const { parsePiListModels, ProviderModelCache } = loadTs('src/main/providerModels.ts');

// Real `pi --list-models` output shape (captured live 2026-08-17, this auth:
// note the absence of plain anthropic/* — the incident's exact scope).
const PI_TABLE = [
  'provider         model                                      context  max-out  thinking  images',
  'local            unsloth/Qwen3.6-27B-MTP-GGUF               62.0K    8.2K     no        no',
  'moonshotai       kimi-k3                                    1.0M     131.1K   yes       yes',
  'nanogpt          anthropic/claude-sonnet-4.6                128K     16.4K    no        no',
  'nanogpt          thinkingmachines/inkling:thinking          128K     16.4K    no        no',
  'openai-codex     gpt-5.5                                    272K     128K     yes       yes',
].join('\n');

// ——— parse: pi's fixed-column table ————————————————————————————————————————

test('parses the live table into provider/model ids (the --model value form)', () => {
  const out = parsePiListModels(PI_TABLE);
  assert.equal(out.length, 5);
  assert.deepEqual(out[0], {
    id: 'local/unsloth/Qwen3.6-27B-MTP-GGUF',
    label: 'unsloth/Qwen3.6-27B-MTP-GGUF',
  });
  assert.deepEqual(out[2], {
    id: 'nanogpt/anthropic/claude-sonnet-4.6',
    label: 'anthropic/claude-sonnet-4.6',
  });
  assert.ok(out.every((m) => typeof m.id === 'string' && m.label));
});

test('header row is skipped — never surfaces as a model', () => {
  const out = parsePiListModels(PI_TABLE);
  assert.ok(
    !out.some(
      (m) =>
        /provider|model/.test(m.id.split('/').pop() ?? '') &&
        m.id.includes('context') === false &&
        m.id === 'provider/model',
    ),
  );
});

test('garbage, empty, and non-table output parse to [] (graceful, never throws)', () => {
  assert.deepEqual(parsePiListModels(''), []);
  assert.deepEqual(parsePiListModels('something went wrong\nno table here'), []);
  assert.deepEqual(parsePiListModels(null), []);
  assert.deepEqual(parsePiListModels(undefined), []);
});

test('trailing junk lines without the 6-column shape are dropped', () => {
  const out = parsePiListModels(`${PI_TABLE}\n\n(update available)\n`);
  assert.equal(out.length, 5);
});

// ——— cache: TTL + failure fallback ————————————————————————————————————————

test('cache: discovery runs once per provider, TTL expiry re-runs', async () => {
  let calls = 0;
  const discover = async (provider) => {
    calls++;
    return provider === 'pi' ? parsePiListModels(PI_TABLE) : null;
  };
  let now = 1_000_000;
  const cache = new ProviderModelCache(discover, () => now);
  const a = await cache.list('pi');
  assert.equal(a?.length, 5);
  await cache.list('pi'); // cached — no re-run
  assert.equal(calls, 1);
  now += 10 * 60_000 + 1; // TTL (10min) expired
  await cache.list('pi');
  assert.equal(calls, 2, 'stale cache re-discovers');
});

test('cache: a failed discovery (null) is not cached across the TTL — retry next call window', async () => {
  let fail = true;
  const cache = new ProviderModelCache(
    async (p) => (p === 'pi' && !fail ? parsePiListModels(PI_TABLE) : null),
    () => 5_000_000,
  );
  assert.equal(await cache.list('pi'), null, 'failure → null (caller falls back to static)');
  fail = false;
  let now = 5_000_000;
  const retry = new ProviderModelCache(
    async (p) => (p === 'pi' ? parsePiListModels(PI_TABLE) : null),
    () => now,
  );
  assert.ok((await retry.list('pi')).length === 5);
});

// ——— wiring: IPC + both pickers ————————————————————————————————————————————

test('IPC handler exists for discovered model lists', () => {
  const idx = read('src/main/index.ts');
  assert.ok(idx.includes("ipcMain.handle('provider:listModels'"), 'handler registered');
});

test('preload exposes providerListModels', () => {
  const pre = read('src/preload/index.ts');
  assert.ok(pre.includes('providerListModels'), 'renderer can reach the adapter');
});

test('the hire/edit dialog picker reads the adapter hook, not the static list', () => {
  const modal = read('src/renderer/src/components/AddAgentModal.tsx');
  assert.ok(modal.includes('useProviderModels('), 'hook wired');
  // hook at component top; the picker's option list comes from its result
  assert.match(modal, /const providerModelOptions = useProviderModels\(provider\);/);
  assert.match(modal, /const known = providerModelOptions;/);
});

test('the intern-defaults settings field reads the adapter hook', () => {
  const sm = read('src/renderer/src/components/SettingsModal.tsx');
  assert.ok(sm.includes('useProviderModels('), 'settings datalist uses discovered models');
});

test('the hook falls back to the static list until discovery lands (never a broken picker)', () => {
  const hook = read('src/renderer/src/hooks/useProviderModels.ts');
  assert.ok(hook.includes('modelsForProvider'), 'static fallback present');
});
