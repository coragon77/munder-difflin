'use strict';

/**
 * intern-defaults (card agent-harness-settings-section-2026-08-17).
 *
 * Interns spawned on the harness default (claude + defaultModel) with no
 * operator say. The card adds Settings-configurable DEFAULTS for intern
 * spawns: provider/CLI (from the provider registry — no new hardcoded list)
 * and model (per-provider). Precedence is the contract:
 *
 *   request field (god overrides per-intern)  >  settings default  >  current
 *   fallback (config.defaultCommand/'claude', model only via the existing
 *   defaultModel/modelForRole path in spawnAgentCore)
 *
 * Settings defaults apply to INTERNS (persistent spawn-requests) only — the
 * disabled-by-default ephemeral-worker path keeps today's behavior. There is
 * no UI intern-hire flow (AddAgentModal hires regular agents; interns come
 * only from god's spawn-requests — checked), so the request path is the only
 * wiring. PI interns must boot end-to-end (verified live on the pi bridge
 * machinery with an explicit-provider request; see done-report).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const { resolveInternSpawn } = loadTs('src/main/internDefaults.ts');

const CFG = (internDefaults) => ({ defaultCommand: 'claude', internDefaults });

// ——— unit: precedence ————————————————————————————————————————————————————

test('request fields always win over settings defaults (god overrides per-intern)', () => {
  const r = resolveInternSpawn(
    CFG({ provider: 'pi', model: 'anthropic/claude-sonnet-4-5' }),
    { command: 'claude --flag', provider: 'codex', model: 'gpt-5.2' },
    true,
  );
  assert.equal(r.command, 'claude --flag');
  assert.equal(r.provider, 'codex');
  assert.equal(r.model, 'gpt-5.2');
});

test('settings defaults fill in when the request omits the fields (the card)', () => {
  const r = resolveInternSpawn(
    CFG({ provider: 'pi', model: 'anthropic/claude-haiku-4-5' }),
    {},
    true,
  );
  assert.equal(r.provider, 'pi');
  assert.equal(r.command, 'pi', 'command derives from the settings provider preset');
  assert.equal(r.model, 'anthropic/claude-haiku-4-5');
});

test('no settings → the current fallback: defaultCommand, no model (today behavior)', () => {
  const r = resolveInternSpawn(CFG(undefined), {}, true);
  assert.equal(r.command, 'claude');
  assert.equal(r.provider, undefined, 'inference stays downstream in spawnAgentCore');
  assert.equal(r.model, undefined, 'no --model — spawnAgentCore defaultModel path applies');
});

test('empty internDefaults object behaves like unset (pure extension)', () => {
  const r = resolveInternSpawn(CFG({}), {}, true);
  assert.deepEqual(r, { command: 'claude', provider: undefined, model: undefined });
});

test('settings defaults apply to INTERNS only — ephemeral workers keep today behavior', () => {
  const r = resolveInternSpawn(CFG({ provider: 'pi', model: 'x' }), {}, false);
  assert.equal(r.command, 'claude');
  assert.equal(r.provider, undefined);
  assert.equal(r.model, undefined);
});

test('an explicit request provider with no command derives the command from ITS preset', () => {
  // Also fixes the old mismatch: raw.provider 'pi' + no command used to spawn
  // the 'claude' binary while claiming provider pi.
  const r = resolveInternSpawn(CFG(undefined), { provider: 'pi' }, false);
  assert.equal(r.command, 'pi');
  assert.equal(r.provider, 'pi');
});

test('whitespace-only request fields count as absent (LLM-authored JSON)', () => {
  const r = resolveInternSpawn(
    CFG({ provider: 'pi', model: 'm1' }),
    { command: '  ', model: '' },
    true,
  );
  assert.equal(r.command, 'pi');
  assert.equal(r.model, 'm1');
});

test('settings model alone works with the default provider (claude)', () => {
  const r = resolveInternSpawn(CFG({ model: 'claude-fable-5' }), {}, true);
  assert.equal(r.command, 'claude');
  assert.equal(r.model, 'claude-fable-5');
});

// ——— wiring: schema, request path, settings UI ——————————————————————————

test('config schema carries internDefaults; renderer mirror matches', () => {
  const cfg = read('src/main/config.ts');
  assert.ok(/internDefaults\?:\s*\{[^}]*provider\?[^}]*model\?/s.test(cfg), 'main schema field');
  const mirror = read('src/renderer/src/store/config.ts');
  assert.ok(/internDefaults\??:\s*\{[^}]*provider\?[^}]*model\?/s.test(mirror), 'renderer mirror');
});

test('the spawn-request path resolves through resolveInternSpawn', () => {
  const idx = read('src/main/index.ts');
  assert.ok(idx.includes('resolveInternSpawn('), 'request path calls the resolver');
  // and the resolved values reach the spawn opts (provider + model), not raw.*
  const callSite = idx.slice(idx.indexOf('resolveInternSpawn('));
  assert.match(callSite.slice(0, 400), /persistent/, 'resolution knows persistent (intern gate)');
});

test('Settings exposes intern defaults and writes through updateConfig', () => {
  const sm = read('src/renderer/src/components/SettingsModal.tsx');
  assert.ok(sm.includes('internDefaults'), 'modal reads/writes the field');
  assert.match(sm, /updateConfig\(\{[^}]*internDefaults/s, 'persists via updateConfig');
  assert.ok(
    sm.includes('AGENT_PROVIDER_PRESETS'),
    'provider list comes from the existing registry, not a new hardcoded list',
  );
});
