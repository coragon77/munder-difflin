import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * Confines `path` inside `root` to prevent path-traversal escapes.
 * Returns the resolved absolute path on success, or null on violation.
 *
 * Exported so other main-process modules (e.g. git.ts) validate caller-supplied
 * relative paths against a workspace root with the SAME guard — there is exactly
 * one path-escape policy in the app and it lives here.
 */
export function safeJoin(root: string, rel: string): string | null {
  const absRoot = resolve(root);
  const absPath = isAbsolute(rel) ? normalize(rel) : resolve(absRoot, rel);
  const rel2 = relative(absRoot, absPath);
  if (rel2.startsWith('..') || isAbsolute(rel2)) return null;
  return absPath;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

export async function listDir(
  root: string,
  rel: string,
): Promise<
  | {
      ok: true;
      entries: DirEntry[];
      path: string;
    }
  | { ok: false; error: string }
> {
  const abs = safeJoin(root, rel);
  if (!abs) return { ok: false, error: 'path escapes root' };
  try {
    const names = await readdir(abs);
    const entries = await Promise.all(
      names.map(async (name): Promise<DirEntry> => {
        try {
          const s = await stat(join(abs, name));
          return { name, isDir: s.isDirectory(), size: s.size, mtime: s.mtimeMs };
        } catch {
          return { name, isDir: false, size: 0, mtime: 0 };
        }
      }),
    );
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { ok: true, entries, path: abs };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const MAX_READ_BYTES = 2 * 1024 * 1024; // 2 MB

export async function readFileText(
  root: string,
  rel: string,
): Promise<
  | {
      ok: true;
      content: string;
      path: string;
      size: number;
    }
  | { ok: false; error: string }
> {
  const abs = safeJoin(root, rel);
  if (!abs) return { ok: false, error: 'path escapes root' };
  try {
    const s = await stat(abs);
    if (s.size > MAX_READ_BYTES) {
      return { ok: false, error: `file too large (${(s.size / 1024 / 1024).toFixed(1)} MB)` };
    }
    const buf = await readFile(abs);
    // Reject obvious binary files based on null-byte sniff
    if (buf.includes(0)) return { ok: false, error: 'binary file (not displayable)' };
    return { ok: true, content: buf.toString('utf8'), path: abs, size: s.size };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function writeFileText(
  root: string,
  rel: string,
  content: string,
): Promise<
  | {
      ok: true;
      path: string;
    }
  | { ok: false; error: string }
> {
  const abs = safeJoin(root, rel);
  if (!abs) return { ok: false, error: 'path escapes root' };
  try {
    await writeFile(abs, content, 'utf8');
    return { ok: true, path: abs };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Expand a leading `~` to the user's home dir and return an absolute, normalized
 * path. SYNC on purpose — every consumer (spawn guards, cwd validation, config
 * writes) is synchronous.
 *
 * Only a SHELL expands `~`; Node's `fs`/`child_process` treat it as a literal
 * directory name, so a user-typed `~/dev/foo` fails every existsSync/statSync and
 * dies with `cwd does not exist`. This is applied at INGESTION (project add,
 * `pty:spawn`) so the registry only ever stores an ABSOLUTE cwd, with
 * defense-in-depth at the consumers.
 *
 * Non-tilde absolute paths are returned resolved/normalized. Anything that is
 * still RELATIVE after expansion is returned untouched (trimmed) so callers keep
 * their own "not-absolute" errors instead of it being silently resolved against
 * the Electron process cwd. Empty input passes straight through. Windows paths
 * (`C:\…`, UNC) are unaffected — they never start with `~`.
 */
export function expandTilde(p: string): string {
  if (typeof p !== 'string') return p;
  const t = p.trim();
  if (!t) return p;
  let out = t;
  if (t === '~') out = homedir();
  else if (t.startsWith('~/') || t.startsWith('~\\')) out = join(homedir(), t.slice(2));
  if (!isAbsolute(out)) return t;
  return resolve(out);
}

/** Existence/metadata check for an ABSOLUTE path (v0.3.4 — backs the terminal
 *  ⌘-click markdown flow). `~/` is expanded here (the renderer doesn't know
 *  the home dir). Read-only metadata: returns whether a regular file exists and
 *  the normalized absolute path; never file contents. */
export async function statAbs(
  p: string,
): Promise<{ exists: boolean; isFile: boolean; path: string }> {
  let abs = p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
  if (!isAbsolute(abs)) return { exists: false, isFile: false, path: p };
  abs = normalize(abs);
  try {
    const s = await stat(abs);
    return { exists: true, isFile: s.isFile(), path: abs };
  } catch {
    return { exists: false, isFile: false, path: abs };
  }
}
