# IDE Panel — In-App Editor, Diffs and Git Visualization

- **Coverage:** `src/renderer/src/ide/`, `src/renderer/src/markdown/MarkdownPreview.tsx`
- **Depends on:** [Design System](design.md), [Core Spec](spec.md)
- **Last Updated:** 2026-08-22

## Purpose

A full-window overlay (`IdePanel`, z-index 290) that lets the human read and edit
the files an agent is working on without leaving the app: a file tree and git
rail on the left, Monaco editor / diff tabs on the right. It is not an agent
tool — nothing in this subsystem is exposed to agents, and it holds no
filesystem or git access of its own. Every read, write and git command goes
through `window.cth.*` into the main process.

What it deliberately does not do: no staging, no commit, no branch creation, no
search, no multi-cursor workflows, no LSP beyond what Monaco's bundled workers
give for free. The only mutations it offers are **save a file** and **check out
a ref**, both guarded.

## Mechanism

### Which directory the IDE opens on

`pickRoot()` (`IdePanel.tsx:79`) snapshots a workspace root **once**, at mount,
through `useState(pickRoot)`:

``` ts
return sel?.cwd ?? s.agents.find((a) => a.isGod)?.cwd ?? s.agents[0]?.cwd ?? null;
```

Selected agent, else the god agent, else the first agent. The comment states the
reasoning: the IDE is a full-window overlay, so the user cannot switch agents
while it is open, and a root that never moves under an open editor is correct.
With no agents at all, `root` is `null` and the body renders "No workspace
available."

Another surface can ask for a specific file: it writes an absolute path to
`store.ideInitialFile` and sets `ideOpen`, and an effect (`IdePanel.tsx:256`)
consumes that slot once `root` is known, clearing it immediately so the next IDE
open starts fresh. A path outside `root` is ignored — the tree still lets the
user browse — otherwise it opens an `edit` tab, forced to `preview` for markdown.

### Two roots, and why the git panes use the other one

`root` is one agent's cwd, which is frequently a **linked worktree**, and a
worktree's history shows only its own branch. `IdePanel` therefore resolves a
second root on mount via `window.cth.gitMainRepo(root)` → `mainRepoRoot()`
(`src/main/git.ts:298`), stores it as `gitRoot`, and runs HISTORY and COMPARE
there so every agent branch appears in one graph.

The split is exact, and it is the thing to get right when touching this file:

| Uses `root` (the agent's cwd) | Uses `gitRoot` (the main repo root) |
|---|---|
| `readFile` / `writeFile`, the FileTree | `gitLogGraph`, `gitBranch`, `gitBranches` |
| `gitIsRepo`, `gitStatus` (the CHANGES list) | `gitCommitFiles`, `gitCompareRefs`, `gitCheckout` |
| `gitDiff` (working tree vs HEAD) | `gitShowFile` (both sides of a rev-pinned diff; `openRevDiff` is `gitRoot ?? root`, so it falls back to `root` until `gitMainRepo` resolves) |

### Tabs and the three tab modes

One flat `Tab[]` list. `tabKey(mode, rel)` builds `edit::…` and `diff::…` keys, so
the same file can be open as an editor and as a diff at once; `openRevDiff` builds
a four-part key inline — `` `rev::${revA}::${revB}::${rel}` `` — so the same path
at two different commit pairs stays two tabs.

| Mode | Left side | Right side | Loaded by |
|---|---|---|---|
| `edit` | — | — | `ensureEdit` → `fs:readFile` |
| `diff` | HEAD | working tree | `ensureDiff` → `git:diff` |
| `revdiff` | content at `revA` | content at `revB` | `openRevDiff` → two `git:showFile` calls |

`editBuffers` is keyed by `rel`, shared across every tab showing that file.
`diffData` is keyed by `rel` for `diff` mode but by the full **tab key** for
`revdiff`.

### Saving, and the in-flight-edit rule

`save()` (`IdePanel.tsx:306`) is the only write path. It refuses when the buffer
is not `ready`, when `content === original`, or when a save is already in flight.
On success it sets `original` to `buf.content` — the snapshot captured *before*
the IPC round trip — never to the latest buffer:

``` ts
const res = await window.cth.writeFile(root, rel, buf.content);
if (res.ok) {
  setEditBuffers((p) => ({ ...p, [rel]: { ...p[rel], original: buf.content, saveState: 'saved' } }));
```

Keystrokes typed during the write therefore stay dirty and land on the next save.
The earlier version folded the latest buffer into `original`, which marked the
tab clean while disk held the older snapshot — silent data loss with no dirty dot
(fixed in `3ead7ce`, found by an independent review as a BLOCKER).

`saveState` flips back to `idle` on a 1200 ms timer, so "saved" is a flash, not a
state. `refreshStatus()` runs after every save so the CHANGES list follows.

### Git status polling

`refreshStatus()` calls `git:isRepo` then `git:status` and runs on a 4000 ms
`setInterval` for the whole time the IDE is open. This poll is the only thing
that notices an agent changing files underneath the panel. The app runs no
filesystem watcher anywhere, by policy — the rationale is recorded on the hive
router (`src/main/hive.ts:3065`): *"Poll-based router. Cheap and robust vs
fs.watch quirks on macOS."*

### The left rail: CHANGES, HISTORY, COMPARE

One strip of three buttons plus a caret. **CHANGES** merges `git:status` into a
single list in `changedFiles`; when a path appears more than once, the unstaged
status wins, then staged, then untracked (`?`). Clicking a row opens a `diff` tab.

**HISTORY** (`HistoryPane`, `GitPanes.tsx:99`) loads `gitLogGraph(gitRoot, page * 200)`
and renders it through `CommitGraph` (`src/renderer/src/components/git/CommitGraph.tsx`,
outside this slice). Clicking a commit calls `gitCommitFiles` and opens a file
list; clicking a file opens a `revdiff` tab of `sha^` against `sha`. "jump here"
runs `gitCheckout(gitRoot, sha, true)` behind a `window.confirm`.

**COMPARE** (`ComparePane`, `GitPanes.tsx:256`) picks base and head from
`gitBranches` — base defaults to `main`, else `master`, else the first local
branch; head defaults to the current branch — and re-runs `gitCompareRefs` on
every change to base, head or mode. `three` mode (the default) is PR-style
`base...head`; `two` is the literal `base head` difference. Clicking a file opens
a `revdiff` of `result.mergeBase` (three-dot) or `base` (two-dot) against `head`.

The caret collapses the pane but never the strip, so the control that reopens it
stays reachable. The state persists in `localStorage` under
`cth.ide.gitRailCollapsed` because it is a working preference, not a mode.

### Markdown: code, split, preview

`isMarkdown(rel)` matches `.md` / `.markdown`. Markdown edit tabs get a
`code | split | preview` switch in `EditorBar`. The choice is per-tab in
`mdViews`, and every change also writes the value to `localStorage` key
`cth.ide.mdView` as the sticky default for the next markdown file (`split` on
first run).

`MdPane` renders the **live edit buffer**, not the saved file, wrapped in
`useDeferredValue` so re-rendering the markdown never blocks typing. Save, dirty
dots and Cmd+S are untouched by the view mode.

### MarkdownPreview and its security posture

`MarkdownPreview` is `react-markdown` + `remark-gfm`, memoized, and the module
docstring states the constraint: **never add `rehype-raw`**. Without it,
react-markdown renders to React elements only, so no HTML sink exists — raw HTML
in agent-generated markdown is displayed as text, and react-markdown's default
`urlTransform` already drops `javascript:` URIs.

Anchors never navigate the window. The `a` component intercepts every click:

- `http(s):` / `mailto:` → `window.cth.openExternal(h)` (main-process opener).
- A relative `*.md` path, when the host passed `onOpenMarkdownLink` → resolved
  against `baseRel`'s directory by `resolveRel` and handed to the host.
  `isRelativeMd` accepts a trailing `#anchor` but the handler strips it before
  resolving, so `[see](./x.md#section)` opens the file and silently drops the
  section.
- Everything else (`file:`, in-page anchors, unknown schemes) is inert, and
  renders with `text-decoration: underline dotted` to signal that.

Images never load: the `img` component renders an `alt`-text chip instead,
because remote images are CSP-blocked by design and a broken-image icon is worse
than a placeholder.

## Workflows

### Checking out a ref from the panel

| Step | Action | Location |
|---|---|---|
| 1 | `window.confirm` in the renderer | `HistoryPane.jump` / `ComparePane.switchTo` |
| 2 | Any live pty in the tree with output in the last 10 s → refuse | `git:checkout` handler, `src/main/index.ts:4590` |
| 3 | Staged or unstaged changes → refuse | `checkoutRef`, `src/main/git.ts:760` |
| 4 | Branch held by another worktree → name the holder | `listWorktrees` lookup in `checkoutRef` |
| 5 | `git switch [--detach] <ref>` | `checkoutRef` |

## Integration points

- **Main-process git** (`src/main/git.ts` via the `git:*` channels in
  `src/main/index.ts`). The renderer holds no git access. Every rev the renderer
  supplies passes `isSafeRev()` (`git.ts:574`), every path goes through
  `safeJoin`, and `--` separates paths from revs. Content reads are capped at
  2 MB (`MAX_SHOW_BYTES`, `MAX_DIFF_BYTES`) with a binary sniff for NUL bytes.
- **`fs:readFile` / `fs:writeFile`** for the edit buffers, scoped to `root` + a
  relative path.
- **`app:openExternal`** — the only way a link in a preview reaches a browser.
- **`FileTree`** (`src/renderer/src/components/FileTree.tsx`) is reused as-is;
  the IDE supplies `onOpenFile` and `onCopyPath`.
- **`CommitGraph`** (`src/renderer/src/components/git/CommitGraph.tsx`) with its
  lane algorithm in `git/graph.ts`. Both are outside this slice. `HistoryPane`
  supplies `commits`, `currentBranch` and `onCommitClick`, nothing else.
- **Store fields** `ideInitialFile` / `setIdeInitialFile` (`store.ts:232`) and
  `ideOpen` / `setIdeOpen` (`store.ts:236`).
- **Other `MarkdownPreview` consumers:** `FullscreenFileEditor.tsx:232` (the
  fullscreen file overlay's `edit | preview` toggle, which previews the **saved**
  file, not a live buffer) and `CommandCenterPanel.tsx:523`.

## Gotchas

- **Monaco is always light, even when the app is dark.** `monaco.ts` defines
  exactly one theme, `cth-light`, and `CTH_MONACO_THEME` is a hardcoded constant
  that both `MonacoEditor` and `MonacoDiff` pass. The app itself has a real
  `AppTheme = 'light' | 'dark'` (`design/theme.ts:16`), so in dark mode the
  editor is a bright rectangle in a dark window. The `defineThemes` docstring
  claims it registers "the CTH light/dark Monaco themes" — the dark half does not
  exist.
- **History stops at 500 commits and the "load older" button vanishes.** The
  `git:logGraph` handler clamps the count with `Math.min(500, …)`, while
  `HistoryPane` requests `page * 200` and only shows the button while
  `commits.length >= page * 200`. At page 3 it asks for 600, receives 500, and
  `500 >= 600` is false. The IPC accepts a `skip` offset that `HistoryPane` never
  passes; each page refetches the whole window instead of paginating.
- **Closing the IDE with the ✕ button discards unsaved edits without a warning.**
  Only the `Escape` handler checks `anyDirtyRef.current`; the title-bar button
  calls `setIdeOpen(false)` unconditionally, and there is no `beforeunload`-style
  guard. Dirty tabs live only in React state.
- **A scroller inside a `maxHeight` column needs `flex: 1` or it never scrolls.**
  `overflow: auto` with flex-basis `auto` sizes to its *content*, so it overflows
  the cap instead of reaching its own scroll threshold. This bit both the CHANGES
  list and the per-commit file list; both now carry `flex: 1, overflow: auto,
  minHeight: 0` and an inline comment saying why (`cb413fe`).
- **Relative markdown links only work inside the IDE.** `onOpenMarkdownLink` is
  optional and only `IdePanel` passes it. `FullscreenFileEditor` passes `baseRel`
  but no handler, and `CommandCenterPanel` passes neither, so a `[see](./x.md)`
  link renders as dotted-underline inert text on both.
- **CHANGES and the git panes can disagree about the repo.** CHANGES runs
  `gitStatus(root)` on the agent's worktree; HISTORY and COMPARE run at
  `gitRoot`. In a worktree setup the file list shows one branch's changes while
  the graph beside it shows every branch.
- **"switch to <branch>" strips the remote prefix.** `ComparePane.switchTo` sends
  `head.replace(/^origin\//, '')`, so picking `origin/feature` checks out the
  local `feature`. If no such local branch exists, git's own error surfaces in the
  note line.
- **The panes remount on every rail-tab switch.** `HistoryPane` and `ComparePane`
  render only while their tab is active and carry `key={gitRoot}`, so selected
  commit, page and branch pickers all reset when you leave and come back.
- **Monaco must be bootstrapped before the first `<Editor/>` mounts.**
  `MonacoEditor.tsx` and `MonacoDiff.tsx` both call `setupMonaco()` at *module*
  scope, not in a render or effect. It pins `@monaco-editor/react` to the bundled
  instance via `loader.config({ monaco })`; without that, the library lazy-loads
  Monaco from a CDN over AMD, which fails offline and inside `app.asar`. Both
  `setupMonaco` and `defineThemes` are idempotent behind module-level flags.
- **`languageForPath` maps `.toml` to `ini`.** Monaco ships no TOML grammar, and
  `ini` is the closest highlighter available.
- **An added file's parent side is an empty document, not an error.**
  `getFileAtRev` returns `{ ok: true, exists: false, content: '' }` when the path
  is missing at that rev, so `openRevDiff`'s `!a.ok` check passes and the diff
  renders as an all-additions view.

> ⚠ **VERIFY:** Was the missing `cth-dark` Monaco theme a deliberate deferral or
> an oversight? The design recalibration commit `51ec611` explicitly touched
> "Monaco editor + diff" for fonts and rebuilt the dark palette everywhere else,
> but left `CTH_MONACO_THEME` hardcoded. Checked `src/renderer/src/ide/` and
> `design/theme.ts` only — not the design-system cards or the v0.3.x planning
> docs. (raised 2026-08-22)

> ⚠ **INTENT UNVERIFIED:** Why does the CHANGES list stay on the agent's `root`
> when HISTORY and COMPARE were deliberately built against `gitRoot` in the same
> commit (`7797d20`)? Showing the worktree's own dirty files is defensible, but
> the decision is not recorded anywhere. (raised 2026-08-22)

> ⚠ **VERIFY:** Nothing in `test/` exercises this slice — `test/commit-graph.test.cjs`
> covers `layoutGraph` in `components/git/graph.ts`, which is one seam away. The
> save-path fix from `3ead7ce` and the `revdiff` key construction are unpinned by
> any test. Checked `test/*.test.cjs` by grep for `IdePanel`, `MarkdownPreview`,
> `monaco`, `languageForPath` and `GitPanes` only. (raised 2026-08-22)

## Key files

| File | What lives in it |
|---|---|
| `src/renderer/src/ide/IdePanel.tsx` | The overlay: root selection, tab model, edit buffers, save, status polling, the left rail and the `code/split/preview` switch. Everything except the two Monaco wrappers and the two git panes. |
| `src/renderer/src/ide/GitPanes.tsx` | `HistoryPane` and `ComparePane` — commit list, per-commit file list, branch pickers, ahead/behind, the two confirm-guarded checkout buttons. |
| `src/renderer/src/ide/monaco.ts` | Bootstrap: `?worker` imports + `MonacoEnvironment.getWorker`, `loader.config({ monaco })`, the `cth-light` theme, `languageForPath`. |
| `src/renderer/src/ide/MonacoEditor.tsx` | Editor wrapper. Binds Cmd/Ctrl+S once at mount through an `onSaveRef` so the command never needs rebinding. |
| `src/renderer/src/ide/MonacoDiff.tsx` | Read-only side-by-side `DiffEditor`. `ignoreTrimWhitespace: false`, no overview ruler. |
| `src/renderer/src/markdown/MarkdownPreview.tsx` | The shared renderer: no HTML sink, link interception, image placeholders. Styled by `.cth-md-preview` in `design/global.css:217`. |
