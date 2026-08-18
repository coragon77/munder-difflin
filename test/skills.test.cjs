'use strict';

/**
 * Card agent-skills-panel-local-inven-2026-08-18 — the LOCAL skills inventory.
 * A skill folder whose frontmatter stops parsing or a precedence rule that
 * silently flips would render as "no such skill", so these pin the failures
 * that would otherwise be silent. No catalog here by design (operator's call):
 * nothing in src/main/skills.ts may fetch, install, or uninstall.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { parseSkillFrontmatter, listLocalSkills } = loadTs('src/main/skills.ts');

test('SKILL.md frontmatter reads a multi-line block description whole', () => {
  const fm = parseSkillFrontmatter(
    [
      '---',
      'name: md-audit',
      'description: |',
      '  Read-only code quality audit — scan the cwd',
      '  and return a prioritised report.',
      'version: 1.0.0',
      '---',
      '# body',
    ].join('\n'),
  );
  assert.equal(fm.name, 'md-audit');
  assert.match(fm.description, /scan the cwd and return a prioritised report/);
});

test('inline frontmatter description and absent frontmatter both behave', () => {
  assert.equal(
    parseSkillFrontmatter('---\nname: x\ndescription: one liner\n---').description,
    'one liner',
  );
  assert.deepEqual(parseSkillFrontmatter('# no frontmatter'), {});
});

// ── discovery + dedup ────────────────────────────────────────────────────────

function mkSkill(root, folder, name, description) {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\nbody`,
  );
  return dir;
}

/** A fake machine: home with user skills, a repo cwd with project skills, and a
 *  bundled dir — all in tmp, so the test never touches the real ~/.claude. */
function fakeMachine(t, layout) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'md-skills-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const cwd = path.join(base, 'repo');
  const bundled = path.join(base, 'bundled');
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  for (const [folder, name] of layout.user ?? [])
    mkSkill(path.join(home, '.claude', 'skills'), folder, name, 'user copy');
  if (layout.userPlugin) {
    fs.mkdirSync(path.join(home, '.config', 'opencode', 'plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.config', 'opencode', 'plugin', layout.userPlugin),
      '// plugin',
    );
  }
  if (layout.codexPlugin) {
    fs.mkdirSync(path.join(home, '.codex', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'plugins', layout.codexPlugin), '// plugin');
  }
  for (const [folder, name] of layout.project ?? [])
    mkSkill(path.join(cwd, '.claude', 'skills'), folder, name, 'project copy');
  if (layout.projectPlugin) {
    fs.mkdirSync(path.join(cwd, '.opencode', 'plugin'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.opencode', 'plugin', layout.projectPlugin), '// plugin');
  }
  for (const [folder, name] of layout.bundled ?? []) mkSkill(bundled, folder, name, 'bundled copy');
  return { home, cwd, bundled };
}

test('an empty machine reports an empty list, not a throw', () => {
  const empty = listLocalSkills({ cwds: [], bundledDir: null, home: '/nonexistent-home' });
  assert.deepEqual(empty, []);
});

test('discovery: skills and plugins across scopes, providers, and roots', (t) => {
  const { home, cwd, bundled } = fakeMachine(t, {
    user: [['docx', 'docx']],
    userPlugin: 'my-opencode-plugin.js',
    codexPlugin: 'codex-thing.js',
    project: [['pdf', 'pdf']],
    projectPlugin: 'proj-plugin.js',
    bundled: [['xlsx', 'xlsx']],
  });

  const skills = listLocalSkills({ cwds: [cwd], bundledDir: bundled, home });
  const byId = Object.fromEntries(skills.map((s) => [`${s.provider}/${s.name}`, s]));

  assert.equal(byId['claude/docx'].scope, 'user', 'user skill found at ~/.claude/skills');
  assert.equal(byId['claude/pdf'].scope, 'project', 'project skill found at <cwd>/.claude/skills');
  assert.equal(byId['claude/xlsx'].scope, 'bundled', 'bundled skill found in the resources dir');
  assert.equal(byId['opencode/my-opencode-plugin'].scope, 'user', 'opencode plugin reported');
  assert.equal(byId['codex/codex-thing'].scope, 'user', 'codex plugin reported');
  assert.equal(byId['opencode/proj-plugin'].scope, 'project', 'project opencode plugin reported');

  // Plugins are FILES, not SKILL.md folders — they must still show a real path.
  assert.ok(byId['opencode/my-opencode-plugin'].path.endsWith('my-opencode-plugin.js'));
});

test('dedup: project shadows user shadows bundled, per provider', (t) => {
  const { home, cwd, bundled } = fakeMachine(t, {
    user: [['docx', 'docx']],
    bundled: [
      ['docx', 'docx'],
      ['pdf', 'pdf'],
    ],
    project: [['docx', 'docx']],
  });

  const skills = listLocalSkills({ cwds: [cwd], bundledDir: bundled, home });
  const docx = skills.filter((s) => s.name === 'docx');
  const pdf = skills.filter((s) => s.name === 'pdf');

  assert.equal(docx.length, 1, 'same name deduped across scopes');
  assert.equal(docx[0].scope, 'project', 'project wins over user and bundled');
  assert.match(docx[0].description, /project copy/);
  assert.equal(pdf.length, 1);
  assert.equal(pdf[0].scope, 'bundled', 'name only in bundled stays bundled');
});

test('dedup keys on (provider, name), so a claude skill does not shadow an opencode plugin', (t) => {
  const { home, bundled } = fakeMachine(t, { user: [['docx', 'docx']], userPlugin: 'docx' });
  const skills = listLocalSkills({ cwds: [], bundledDir: bundled, home });
  const names = skills.filter((s) => s.name.toLowerCase() === 'docx');
  assert.equal(names.length, 2, 'same name, different providers → both stay');
  assert.ok(names.some((s) => s.provider === 'claude'));
  assert.ok(names.some((s) => s.provider === 'opencode'));
});

test('an unreadable skill folder is skipped, not fatal', (t) => {
  const { home, bundled } = fakeMachine(t, { user: [['good', 'good']] });
  const broken = path.join(home, '.claude', 'skills', 'broken');
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, 'SKILL.md'), '---\nname: [unclosed\n---'); // unparseable is fine — name falls back
  const skills = listLocalSkills({ cwds: [], bundledDir: bundled, home });
  assert.ok(
    skills.some((s) => s.name === 'good'),
    'the good skill still reports',
  );
});

test('output is sorted by name for display', (t) => {
  const { home, bundled } = fakeMachine(t, {
    user: [
      ['zeta', 'zeta'],
      ['alpha', 'alpha'],
    ],
  });
  const skills = listLocalSkills({ cwds: [], bundledDir: bundled, home });
  assert.deepEqual(
    skills.map((s) => s.name),
    ['alpha', 'zeta'],
  );
});
