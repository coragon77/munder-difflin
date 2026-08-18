/**
 * SKILLS — LOCAL inventory only: what the coding agents on this machine can
 * already do, discovered by walking the directories each CLI reads.
 *
 * Claude Code is the well-specified one: a skill is a folder containing
 * SKILL.md whose YAML frontmatter carries `name` and `description`. OpenCode
 * and Codex use plugin/config directories instead, so they are reported as
 * plugins rather than pretending they share a format.
 *
 * There is deliberately NO catalog, NO fetch, NO install and NO uninstall in
 * this file (card agent-skills-panel-local-inven-2026-08-18, operator's call):
 * a public skill store is a supply-chain surface for no gain, and adding a
 * skill is a decision, not a click. Ported by intent from upstream 1b821b3 —
 * whose header claimed "nothing here installs anything" in the same commit that
 * added installSkill at line 342; the catalog half was dropped, not trusted.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface LocalSkill {
  id: string;
  name: string;
  description: string;
  /** Which CLI reads this directory. */
  provider: 'claude' | 'opencode' | 'codex';
  /** 'user' = global for the whole machine, 'project' = one repo, 'bundled' = ships with the app. */
  scope: 'user' | 'project' | 'bundled';
  path: string;
}

/** Strip a leading YAML frontmatter block and pull the two fields we render.
 *  Deliberately not a YAML parser: `name` and `description` are all the UI shows,
 *  and description is routinely a multi-line `|` block, which a naive key:value
 *  split would truncate at the first line. */
export function parseSkillFrontmatter(md: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const body = m[1];
  const out: { name?: string; description?: string } = {};
  const nameM = /^name:\s*(.+)$/m.exec(body);
  if (nameM) out.name = nameM[1].trim().replace(/^["']|["']$/g, '');
  // Block scalar (`description: |`) → take the indented lines that follow.
  // Consecutive INDENTED lines after `description: |`. The earlier lookahead
  // form ended at `\r?\n?$`, which under /m matches the end of the FIRST line —
  // so every multi-line description silently arrived truncated to one line.
  const blockM = /^description:\s*[|>]-?[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))+)/m.exec(body);
  if (blockM) {
    out.description = blockM[1]
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ')
      .trim();
  } else {
    const inlineM = /^description:\s*(.+)$/m.exec(body);
    if (inlineM) out.description = inlineM[1].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Every folder under `dir` holding a SKILL.md, read into a LocalSkill. */
function scanSkillDir(
  dir: string,
  provider: LocalSkill['provider'],
  scope: LocalSkill['scope'],
): LocalSkill[] {
  const out: LocalSkill[] = [];
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return out;
    for (const entry of readdirSync(dir)) {
      const skillDir = join(dir, entry);
      const md = join(skillDir, 'SKILL.md');
      try {
        if (!statSync(skillDir).isDirectory() || !existsSync(md)) continue;
        const fm = parseSkillFrontmatter(readFileSync(md, 'utf8'));
        out.push({
          id: `${scope}:${entry}`,
          name: fm.name || entry,
          description: fm.description || '',
          provider,
          scope,
          path: skillDir,
        });
      } catch {
        /* one unreadable skill must not hide the rest */
      }
    }
  } catch {
    /* unreadable root → report nothing rather than throw into IPC */
  }
  return out;
}

/** Plugin directories for the CLIs that do not use Claude's SKILL.md format.
 *  Reported as entries so the tab tells the truth about what a provider has,
 *  instead of implying only Claude Code is extensible. */
function scanPluginDir(
  dir: string,
  provider: LocalSkill['provider'],
  scope: LocalSkill['scope'],
): LocalSkill[] {
  const out: LocalSkill[] = [];
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return out;
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.')) continue;
      out.push({
        id: `${scope}:${provider}:${entry}`,
        name: entry.replace(/\.(m|c)?js$/i, ''),
        description: `Plugin in ${dir}`,
        provider,
        scope,
        path: join(dir, entry),
      });
    }
  } catch {
    /* noop */
  }
  return out;
}

/**
 * Everything installed, deduped by (provider, name) with the most specific scope
 * winning — a project skill shadows the user's, which shadows the bundled copy,
 * which is the same precedence the CLIs themselves apply.
 *
 * `home` is injectable so the discovery/dedup logic is testable against a fake
 * machine instead of the real ~/.claude (defaults to the live homedir).
 */
export function listLocalSkills(opts: {
  cwds: string[];
  bundledDir: string | null;
  home?: string;
}): LocalSkill[] {
  const home = opts.home ?? homedir();
  const found: LocalSkill[] = [
    ...(opts.bundledDir ? scanSkillDir(opts.bundledDir, 'claude', 'bundled') : []),
    ...scanSkillDir(join(home, '.claude', 'skills'), 'claude', 'user'),
    ...scanPluginDir(join(home, '.config', 'opencode', 'plugin'), 'opencode', 'user'),
    ...scanPluginDir(join(home, '.codex', 'plugins'), 'codex', 'user'),
  ];
  for (const cwd of opts.cwds) {
    if (!cwd) continue;
    found.push(...scanSkillDir(join(cwd, '.claude', 'skills'), 'claude', 'project'));
    found.push(...scanPluginDir(join(cwd, '.opencode', 'plugin'), 'opencode', 'project'));
  }
  const rank = { project: 3, user: 2, bundled: 1 } as const;
  const best = new Map<string, LocalSkill>();
  for (const s of found) {
    const key = `${s.provider}:${s.name.toLowerCase()}`;
    const prev = best.get(key);
    if (!prev || rank[s.scope] > rank[prev.scope]) best.set(key, s);
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
}
