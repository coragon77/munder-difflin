/**
 * The setup catalog — every EXTERNAL tool the harness leans on, what it buys
 * the user, and how to install it on this platform (card
 * agent-prerequisites-panel-live-2026-08-18, ported BY INTENT from upstream
 * 1b821b3's Prerequisites page — status-only; upstream's install-delegation
 * prompt is deliberately NOT ported).
 *
 * Why this file exists: the app ships as one Electron bundle, but several of
 * its best features are thin wrappers over tools that live outside it —
 * mempalace for semantic memory, uv to install it, git for worktrees, and one
 * CLI per agent engine. Every one of them degrades SILENTLY when absent (that
 * is the deliberate runtime design), which is friendly right up until "off"
 * and "broken" look identical and nobody can say which is which. This catalog
 * is the single place that distingu them.
 *
 * The engine rows are DERIVED from AGENT_PROVIDER_PRESETS rather than restated
 * here: those presets already carry `defaultCommand`, `installCommand`,
 * `nativeInstallCommand` and `docsUrl`, and a second hand-maintained copy
 * would drift the moment a provider is added.
 *
 * Shared between main and renderer; keep it dependency-free.
 */

import { AGENT_PROVIDER_PRESETS } from './agentProvider';

export type ToolKind = 'prerequisite' | 'memory' | 'engine';

export interface ToolSpec {
  /** Stable row id. For a probed binary this is also the name we look up. */
  id: string;
  /** The executable to probe on PATH, or null when presence is derived some
   *  other way (mempalace comes from the memory subsystem's own status). */
  bin: string | null;
  label: string;
  kind: ToolKind;
  /** One line, benefit-framed: what the user LOSES without it. */
  why: string;
  /** Recommended tooling — flagged MISSING when absent (vs NOT SET UP). */
  essential: boolean;
  /** Install command per platform. Empty string = no scripted install. */
  install: { posix: string; win32: string };
  /** Shown when there is no scripted install, or as extra context. */
  note?: string;
  docsUrl?: string;
}

/** Base rows — the non-engine tools. Engines are appended by `toolCatalog()`. */
const BASE_TOOLS: ToolSpec[] = [
  {
    id: 'uv',
    bin: 'uv',
    label: 'uv',
    kind: 'prerequisite',
    why: 'Installs and runs mempalace. A self-contained Python toolchain — it does not touch any Python you already have.',
    essential: true,
    install: {
      posix: 'curl -LsSf https://astral.sh/uv/install.sh | sh',
      // PowerShell, not cmd.exe: astral ships install.ps1 for Windows and there
      // is no .bat equivalent. Quoted so it survives being pasted into either.
      win32: 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"',
    },
    docsUrl: 'https://docs.astral.sh/uv/',
  },
  {
    id: 'mempalace',
    bin: null, // presence comes from MemoryStatus.available, not a PATH probe
    label: 'MemPalace — semantic memory',
    kind: 'memory',
    why: 'Meaning-based recall across everything your agents have learned. Without it they still keep plain markdown notes, but cannot search them by meaning.',
    essential: true,
    install: {
      posix: 'uv tool install mempalace',
      win32: 'uv tool install mempalace',
    },
    note: 'Needs uv first.',
  },
  {
    id: 'git',
    bin: 'git',
    label: 'git',
    kind: 'prerequisite',
    why: 'Worktrees let agents work in parallel without fighting over one checkout, and the hive keeps its own history in git.',
    essential: true,
    install: {
      posix: 'xcode-select --install   # macOS · or: sudo apt install git',
      win32: 'winget install --id Git.Git -e',
    },
    docsUrl: 'https://git-scm.com/downloads',
  },
  {
    id: 'node',
    bin: 'node',
    label: 'Node.js',
    kind: 'prerequisite',
    why: 'Runs the npm-installed agent engines (OpenCode, and Claude Code on machines without the native build).',
    essential: false,
    // Deliberately no scripted command: the app already ships a checksum-verified
    // Node installer (nodeInstall.ts) that runs automatically when an engine needs
    // one. Printing a rival curl|sh here would compete with it.
    install: { posix: '', win32: '' },
    note: 'The app installs this for you when an engine needs it — nothing to do by hand.',
    docsUrl: 'https://nodejs.org',
  },
];

/** The full catalog for a platform. Engines derived from the provider presets
 *  (see file header) — `custom` has nothing to detect or install. */
export function toolCatalog(): ToolSpec[] {
  const engines: ToolSpec[] = AGENT_PROVIDER_PRESETS.filter(
    (p) => p.id !== 'custom' && !!p.defaultCommand,
  ).map((p) => ({
    id: `engine:${p.id}`,
    bin: p.defaultCommand,
    label: p.label,
    kind: 'engine' as const,
    why: `Agent engine — ${p.defaultCommand}.`,
    // Claude Code is the recommended engine and the only one the floor assumes
    // by default, so it is the one engine flagged essential.
    essential: p.id === 'claude',
    install: {
      posix: p.installCommand ?? p.nativeInstallCommand?.posix ?? '',
      win32: p.installCommand ?? p.nativeInstallCommand?.win32 ?? '',
    },
    docsUrl: p.docsUrl,
  }));
  return [...BASE_TOOLS, ...engines];
}

/** A catalog row plus what we found on THIS machine. */
export interface ToolStatus extends ToolSpec {
  found: boolean;
  /** Absolute path when found, or null. */
  path: string | null;
  /** Extra live context — e.g. a version string, 'palace initialised'. */
  detail?: string;
  /** `install` already resolved for the running platform. */
  installCommand: string;
}
