'use strict';

// Card agent-hire-dialog-spec-cannot--2026-08-20: the hire spec's provider
// allowlist drifted to three hand-maintained values while the harness grew
// eleven provider presets — a pi manifest was rejected at import and the
// HIRE_PROMPT told AIs to emit only claude|codex|antigravity. PROVIDERS is now
// DERIVED from AGENT_PROVIDER_PRESETS (minus 'custom'), so this test pins two
// things: the validator accepts every real preset, and the hand-written
// surfaces that restate the list (HIRE_PROMPT, published JSON schema, spec
// doc) stay in sync with it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const root = path.resolve(__dirname, '..');
const { HIRE_SPEC_V1, validateHireManifest } = loadTs('src/shared/hire.ts');
const { AGENT_PROVIDER_PRESETS } = loadTs('src/shared/agentProvider.ts');

/** Every spawnable provider preset except 'custom' (manifests may never pick
 *  an arbitrary local binary). The canonical order = preset declaration order. */
const hireable = AGENT_PROVIDER_PRESETS.filter((p) => p.id !== 'custom').map((p) => p.id);
const manifest = (provider) => ({ spec: HIRE_SPEC_V1, name: 'Pin', provider });

test('validateHireManifest accepts every non-custom provider preset (incl. pi)', () => {
  assert.ok(hireable.includes('pi'), 'pi must be a hireable provider');
  for (const id of hireable) {
    const v = validateHireManifest(manifest(id));
    assert.equal(v.ok, true, `${id}: ${v.errors.join('; ')}`);
  }
});

test('custom and unknown providers stay rejected; "agy" aliases antigravity', () => {
  assert.equal(validateHireManifest(manifest('custom')).ok, false);
  assert.equal(validateHireManifest(manifest('nonsense')).ok, false);
  const agy = validateHireManifest(manifest('agy'));
  assert.equal(agy.ok, true);
  assert.equal(agy.manifest.provider, 'antigravity');
});

test('HIRE_PROMPT enum line matches the allowlist exactly, in preset order', () => {
  const tsx = fs.readFileSync(
    path.join(root, 'src/renderer/src/components/AddAgentModal.tsx'),
    'utf8',
  );
  const m = tsx.match(/"provider" MUST be one of: ([^.]+)\./);
  assert.ok(m, 'HIRE_PROMPT rules line not found');
  assert.deepEqual(
    m[1].split('|').map((s) => s.trim()),
    hireable,
  );
});

test('published JSON schema enum matches the allowlist (agy kept as alias)', () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(root, 'docs/hires/spec/hire.schema.json'), 'utf8'),
  );
  const listed = schema.properties.provider.enum.filter((v) => v !== 'agy');
  assert.deepEqual([...listed].sort(), [...hireable].sort());
});

test('HIRE_SPEC.md provider row mentions every hireable provider', () => {
  const md = fs.readFileSync(path.join(root, 'docs/hires/spec/HIRE_SPEC.md'), 'utf8');
  const row = md.split('\n').find((l) => l.startsWith('| `provider`'));
  assert.ok(row, 'HIRE_SPEC.md provider table row not found');
  for (const id of hireable)
    assert.ok(row.includes(`\`${id}\``), `${id} missing from HIRE_SPEC.md`);
});
