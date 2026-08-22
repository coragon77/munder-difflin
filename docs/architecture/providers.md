# The Provider Layer — running an agent on a CLI and a machine

- **Coverage:** `src/shared/agentProvider.ts`, `src/shared/*Commands.ts`, `src/shared/codexRemote.ts`, `src/shared/modelOptions.ts`, `src/shared/ossModels.ts`, `src/shared/providerAutomation.ts`, `src/shared/hire.ts`, `src/shared/toolCatalog.ts`, `src/main/hire.ts`, `src/main/providerModels.ts`, `src/main/resumeGuard.ts`, `src/main/internDefaults.ts`, `src/main/toolStatus.ts`, `src/main/cliInstall.ts`, `src/main/nodeInstall.ts`, `src/main/skills.ts`
- **Depends on:** [The Hive](hive.md), [Munder Difflin Spec](spec.md)
- **Last Updated:** 2026-08-22

## Purpose

Everything it takes to run an agent on a **given CLI** and a **given machine**.
A worker can run Claude Code, the OpenAI Codex CLI, xAI Grok, Kimi, Antigravity
(`agy`), Qwen, OpenCode, Crush, Pi, GitHub Copilot, or an arbitrary custom
command. Each speaks a different dialect — a different auto-approve flag, a
different way to receive its first prompt, a different resume verb, a different
install story — and this layer is the single place those differences are
written down.

Three concerns are merged here on purpose, because a task naming one usually
touches the next: **CLI dialects** (Part A), **hire manifests** (Part B), and
**machine setup** (Part C).

It deliberately does **not** spawn agents: it returns argv tokens, env maps
and shell scripts, and `spawnAgentCore` (`src/main/index.ts`) spawns. It does
not decide *which* agent runs — that is the hive's roster. It never auto-runs
what a manifest asked for; an import only pre-fills a form a human submits.

## Terminology

| Term | Symbol | Meaning |
|---|---|---|
| Provider (UI: engine) | `AgentProvider` | The CLI an agent runs on. Eleven ids, `custom` included. |
| Preset | `AgentProviderPreset` | The per-provider declaration: flags, model support, bridge, installer. |
| hive-aware | `hiveAware` | Takes the *Claude-only* identity injection (`--append-system-prompt` + `--settings`). NOT the same as "participates in the hive". |
| Bridge | `BridgeDescriptor` | How a non-hive-aware CLI still gets lifecycle events: `hooks` (config-file shim) or `proxy` (loopback sidecar reading LLM traffic). |
| Rung | `InstallRungKind` | One step of the install ladder: `npm`, `node-then-npm`, `native`, `manual`. |
| Hire manifest | `HireManifest` | A shareable role template, spec tag `munder-difflin/hire@1`. |

---

# Part A — CLI dialects

## Which provider a command is

`inferAgentProvider(command, explicit)` is the one answer everyone uses. An
explicit provider wins; otherwise the command's first token is reduced to a bare
leaf name (path stripped, `.exe`/`.cmd`/`.bat`/`.ps1` stripped, lower-cased) and
matched against the known binaries. An empty command or bare `claude` means
`claude`; an unrecognised binary means `custom`. `providerPreset(id)` never
returns undefined — an unknown id falls back to Claude — so callers read through
thin accessors (`canReceiveInbox`, `bridgeOf`, `autoModeFlagForProvider`) and
never hold a preset object.

## What a preset declares

The fields answer five independent questions: **how do I start it**
(`defaultCommand`, `nonInteractiveEnv`, the install fields), **how do I make it
autonomous** (`autoModeFlag`/`autoFlag`, one value under two names for two sets
of consumers, plus `effort` — the thinking-effort flag *and its exact level
vocabulary*), **how does it hear the hive** (`hiveAware`, `hookBridge`,
`bridge`, `canReceiveInbox`), **how does it receive a first prompt**
(`initialPromptFlag`, `positionalInitialPrompt`, `seedDelivery`), and **how does
it continue** (`resumeFlag`, `resumeSubcommand`, `modelFlag`,
`recommendedOrchestratorModel`).

> ⚠ **VERIFY:** Grok's `autoModeFlag` (`--permission-mode bypassPermissions`)
> was verified against a Grok binary in an earlier round but NOT re-verified
> since the 2714c92 flag audit — no Grok binary is installed here, and a
> 2026-08-17 sweep found no official xAI grok CLI package on npm to check
> against. Checked the preset and `grokCommands.ts` only. (raised 2026-08-22)

## Three tiers of hive participation

`hiveAware` gates exactly one thing: the Claude flag pair
`--append-system-prompt` + `--settings`. Only `claude` sets it.
`bridgeOf(provider)` says how everything else hears the hive instead:

- **Native** — `claude`, reads hook responses itself.
- **Hooks bridge** — `agy`, `codex`, `grok` carry the legacy `hookBridge` string
  and `bridgeOf` derives `{kind:'hooks', shim}` from it; `opencode` and `pi` set
  the structured `bridge` field directly. A per-agent config file or bundled
  plugin posts `HIVE_SOCK` payloads.
- **Proxy bridge** — `qwen` has no hook surface; Crush exposes only PreToolUse,
  with no Stop/SessionEnd to drain on. Neither can end a turn through a hook, so
  a loopback sidecar watches their LLM traffic and *synthesizes* the same
  payloads. `api` picks the wire shape, `baseUrlEnv` names the env var pointing
  the CLI at the sidecar.
- **None** — `kimi`, `copilot`, `custom`. Mail bounces to the god.

`bridgeDeliversHookContext(provider)` answers a separate question: can a steer
the HookServer *consumed* at a hook boundary actually be *delivered* back into
the session? It reads `deliversSteers` off the descriptor rather than switching
on the shim name, so a future bridge defaults to `false` and can never silently
drop a consumed steer. Undeliverable steers stay queued (`src/main/hooks.ts`).

## How flags reach the process

**A flag must ride the `args` array, never the command string.** Four builders
produce those tokens, and `spawnAgentCore` applies them in this order:

| Builder | Produces | Guard |
|---|---|---|
| `prependCommandTail` — `index.ts:3562` | Everything the operator typed after the binary | Args already prefixed with the tail are returned untouched |
| `permissionModeArgs` — `index.ts:3583` | The auto/bypass flag as argv tokens | A typed permission choice always wins |
| `disallowedToolsArgs` — `index.ts:3606` | `['--disallowedTools','AskUserQuestion']`, Claude only | Only an already-present deny suppresses it |
| `godEffortArgs` — `index.ts:3616` | `[flag, level]`, god only | Level must be in the preset's exact vocabulary |

After them the provider's `nonInteractiveEnv` is merged (`index.ts:3960`),
resume is attached per dialect (`index.ts:3877`), and the hive protocol seed is
delivered (`hive.ts:1267`).

`tokenizeCommand` is the shared splitter; it honours quotes so a whitespace model
label (`--model "Gemini 3.1 Pro (High)"`) survives as one token, and strips them.
Every builder is idempotent because the **missing-CLI install relaunch re-enters
`spawnAgentCore` with the SAME opts object**, whose args already carry the tail,
the flag and the deny.

`permissionModeArgs` encodes the Claude/non-Claude split:

``` ts
const tokens = claude
  ? mode === 'bypass'
    ? (preset.autoFlag ?? '').split(/\s+/).filter(Boolean)  // --dangerously-skip-permissions
    : ['--permission-mode', 'auto']
  : (preset.autoFlag ?? '').split(/\s+/).filter(Boolean);   // the CLI's single autonomous flag
```

Non-Claude CLIs do not distinguish auto from bypass. The mode itself comes from
`resolveHirePermissionMode(explicit, stored)`: an explicit mode on the spawn
wins, else the agent's stored registry record (how an operator-set god bypass
survives restarts), else `DEFAULT_HIRE_PERMISSION_MODE` = `'auto'`. Bypass is
never the shipped default.

## How the first prompt gets in

Non-hive-aware CLIs still need the hive identity and protocol. Three delivery
shapes, dispatched in `hive.ensureAgent` (`src/main/hive.ts:1267`): a **flag**
(`initialPromptFlag` — `agy -i`, `qwen -i`, `opencode --prompt`, `copilot -p`),
a **trailing positional** (`positionalInitialPrompt`, set on exactly two
presets — `codex` and `grok`), or **typed into the TUI after boot**
(`seedDelivery: 'type-into-tui'`, Crush alone). For the third the harness spawns
the bare TUI and returns `seedPrompt`, which the renderer types through the same
per-pty write chain as the inbox-wake nudge so the two cannot collide.

A provider with none of the three spawns **bare, with no protocol seed at all**:
`kimi`, `custom` — and `pi`, whose preset sets `initialPromptFlag: undefined`
under the comment "positional, like codex" but never sets
`positionalInitialPrompt`, so it falls through `hive.ts:1270-1272` to the bare
branch.

> ⚠ **VERIFY:** Is `pi` missing `positionalInitialPrompt: true`, or is it
> intentionally seedless? The preset comment at `agentProvider.ts:498` says
> positional, the field says otherwise, and the two cannot both be right — a
> probable live bug. Checked `agentProvider.ts` and `hive.ts:1267-1272` only.
> (raised 2026-08-22)

## What may be typed into a live TUI

`providerAutomation.ts` holds `CONTEXT_COMMANDS`, a **total**
`Record<AgentProvider, ProviderContextCommands>` — deliberately not a switch with
a `default:` arm. The previous switch answered `null` for seven of eleven
providers, so auto-compaction quietly did nothing for most of the fleet and
nobody found out. A total record stops whoever adds the next provider until they
have looked its commands up. `null` means "we could not establish a command we
trust", never "we didn't check": every entry cites where it was verified, mostly
from the shipped binary's own embedded command table, which cannot lag the
installed version the way web docs can.

- **`compact`** carries `compactTakesFocus` — whether the TUI parses text *after*
  the verb as a focus instruction. Where it does not, the focus is dropped rather
  than typed, because a CLI that re-reads the remainder as a fresh prompt turns a
  compaction into a whole extra turn. Qwen's verb is `/compress`, not `/compact`.
- **`clear`** is `/new` for Grok, OpenCode and Pi and `/clear` for Claude, Codex,
  Kimi, Qwen and Antigravity. Crush, Copilot and `custom` resolve to
  `NO_CONTEXT_COMMANDS`, so their `clear` is `null` like everything else on them.
  `clearCommandForProvider(provider, message)` treats a non-empty message as a
  **literal override**, not a suffix. The asymmetry with compact is the
  operator's escape hatch for providers that answer `null` and for a CLI that
  renames its verb between releases.
- **`resume`** is `null` everywhere except Claude (below).

`isCompactionCommand(text)` matches the leading verb only, against a set derived
from the table, so `/compact keep the auth decisions` counts while a sentence
merely mentioning compaction does not. Before typing,
`terminalReadyToReceive(hasOutput, elapsedMs, provider)` requires an initial
frame plus a provider settle (`terminalReadySettleMs`: kimi 650 ms, grok and
codex 500 ms, else 400 ms). It deliberately does not wait for output to go quiet
— Codex repaints its status line continuously, which used to keep queued
messages blocked until every readiness attempt timed out.

The same file also holds the inbox-wake grace. `hasInboxMonitor(provider)` is
true for `claude` alone, whose boot prompt arms a persistent monitor over the
agent's own inbox directory; Pi is excluded deliberately, because its bash tool
is synchronous and a poll loop would pin the only tool the agent can act with.
`nudgeGraceMsForProvider` returns `NUDGE_GRACE_MS` (45 s) for a provider with a
monitor and `0` for everything else, so the typed nudge stays a fallback for
when the monitor did not take rather than a competing delivery path.

> ⚠ **INTENT UNVERIFIED:** Why is `NUDGE_GRACE_MS` 45 s? The monitor is
> documented to see mail within about a second, which leaves the specific
> 45-second wait before the fallback nudge unexplained. Nothing in the code, the
> commits or the tests records it. (raised 2026-08-22)

## Resuming a session

**Typed resume** is non-null for `claude` only, because `/resume <query>` is the
one typable id-carrying resume in the fleet. Everywhere else `/resume` opens an
interactive **picker** taking no argument, so typing `/resume <uuid>` lands as a
prompt or wedges the pane on a modal. Callers skip and surface rather than fall
back to the Claude dialect: the card transition mails the god naming card, agent,
provider and session id, and consumes the transition so it does not re-mail every
tick.

**Spawn resume** is `resumeFlag` (claude `--resume`, agy `--conversation`, crush
and pi `--session`, grok and copilot `--resume`) or `resumeSubcommand` — Codex
resumes via `codex resume <SESSION_ID>` because no `--resume` flag exists, which
is why restarts used to silently start a brand-new session.

**The resume guard.** A `sessionId` is dialect state: after an engine switch the
registry still holds the previous CLI's id, and attaching it kills the spawn
(`pi --resume <claude-uuid>` → exit 1, live incident 2026-08-18). Claude
validates through `seedSessionTranscript` and Codex through
`findCodexHomeForSession`; `piSessionExists(agentDir, sid)`
(`src/main/resumeGuard.ts`) gives Pi the same treatment by walking the agent's
own `.pi-agent/sessions` tree for `<ts>_<sid>.jsonl`. Pi-only on purpose —
another cross-engine resumer needs its own branch.

## Model lists

`ModelOption` (`src/shared/modelOptions.ts`) is the whole shared shape: `id`
(undefined means "use the CLI default, emit no `--model`") and `label`.

**Hardcoded lists lie** for providers whose catalog is scoped by the actual
login — the live incident was a smoke intern spawned with a hardcoded Anthropic
id its Pi auth could not reach, showing "alive, no activity, zero tokens". So
`ProviderModelCache` (`src/main/providerModels.ts`) *discovers*: for `pi` it runs
`pi --list-models` and `parsePiListModels` reads the fixed-column table
(2+-space split, rows under six columns dropped, ids joined into pi's own
`provider/model` form). Every other provider keeps its static list; the adapter
extends one provider at a time. **Failure is graceful** — a `null` discovery
leaves each caller on its static list and is never cached, so the next call after
the window retries. Success is cached for `MODEL_LIST_TTL_MS` (10 min) so the CLI
is not spawned per render.

Discovery runs through `SHELL -l -i -c`, not a bare `execFile`: the Electron app
inherits the desktop session env, whose PATH lacks the nvm directory where `pi`
lives, so a bare exec ENOENT'd and fell back silently. PTY spawns never hit this
because node-pty runs an *interactive* shell whose `~/.bashrc` loads nvm, and
plain `bash -lc` is not enough — the stock `.bashrc` returns early for
non-interactive shells before its nvm lines. Failure is now logged loudly,
because finding it took reading `/proc/<pid>/environ`.

The static half stays renderer-side: `modelsForProvider`
(`src/renderer/src/store/config.ts`) and the `useProviderModels` hook, which
renders the static list instantly and swaps in the discovered one.

**OSS quick-picks** (`src/shared/ossModels.ts`) are a separate curated shortlist
transcribed from the frozen `oss-models-catalog.md` §7: `OSS_LOCAL_PICKS`
(Mac-runnable Ollama tags, no key, with a RAM floor) and `OSS_PROVIDER_PICKS`
(BYOK slugs plus the `keyEnv` each route reads). `localSlugFor(provider, tag)`
handles the one engine difference — OpenCode names its local provider `local/`,
Crush and Pi use `ollama/`. Frontier slugs are excluded from code defaults by the
catalog's own "verify-live" rule.

> ⚠ **INTENT UNVERIFIED:** Why does `hasOssQuickPicks` cover only `opencode`,
> `crush` and `pi`, and not `qwen`? Qwen drives any OpenAI-compatible endpoint,
> and its preset already existed (3ad2089, 2026-06-16) when the quick-picks
> landed (f062dab, 2026-06-22). Nothing in the code, the commits or the tests
> records the exclusion. (raised 2026-08-22)

## Which engine an intern gets

`resolveInternSpawn(cfg, raw, intern)` (`src/main/internDefaults.ts`) resolves
request pair → `config.internDefaults` pair (interns only) →
`config.defaultCommand ?? 'claude'` with the model left unset. The load-bearing
property is **pair coherence**: a request naming *any* engine field (command,
provider or model) is authoritative for the whole engine identity, and Settings
defaults never fill the missing half. The old per-field merge grafted the
request's provider onto the settings' model and launched `claude --model
openai-codex/gpt-5.6-sol` — a Pi model id on the Claude binary, read out of
`/proc/<pid>/cmdline`. A provider named with no explicit command derives it from
`providerPreset(provider).defaultCommand`.

## The Codex control-socket alias

macOS caps a Unix socket path at 104 bytes (`sun_path`) and Codex builds its
control socket as `$CODEX_HOME/app-server-control/app-server-control.sock` — 42
bytes of suffix — so a per-agent `CODEX_HOME` under the harness home does not
fit. `codexRemoteAliasPath(realHome, agentId)` mints `/tmp/mdc/<8 hex of
sha256(realHome\0agentId)>`, which `enableCodexRemoteForSpawn`
(`src/main/index.ts:391`) symlinks to the real home. `$TMPDIR` cannot host it:
macOS spells it `/var/folders/xx/<30-char-hash>/T/`, and the alias came out at
**121 bytes — longer than the 118-byte real home it was introduced to shorten**,
so every daemon start failed with `path must be shorter than SUN_LEN`. The fixed
short root plus an 8-char digest lands the socket at 60 bytes.
`codexRemoteSocketFits` checks before the filesystem is touched, so the warning
names the real reason instead of a generic readiness timeout.
`withCodexRemoteArgs` prepends `--remote <endpoint>` in all cases, because Codex
requires global options to precede the `resume` subcommand. Every failure here is
non-fatal — the worker starts as a normal local Codex session.

> ⚠ **VERIFY:** Nothing in this slice removes the `/tmp/mdc/<digest>` symlinks
> `enableCodexRemoteForSpawn` creates, and the fixed root means they accumulate
> across runs. Is there a cleanup path in `teardownPty` or an app-quit handler?
> Checked `src/shared/codexRemote.ts` and `src/main/index.ts:391-455` only.
> (raised 2026-08-22)

---

# Part B — Hire manifests

A **hire** is a portable agent role template: a small JSON document (name,
provider, model, flags, goal, budget, capabilities) shared as a file or hosted in
a gallery, imported through the `munderdifflin://hire?src=<https-url>` deep link
or an in-app file picker. `HIRE_SPEC_V1 = 'munder-difflin/hire@1'`; any other
`spec` is rejected before another field is read.

## The security model

A manifest is untrusted input, and three properties are load-bearing. **It can
never auto-spawn** — importing only pre-fills the Add-Agent modal, and the human
reviews the final command. **It cannot carry an executable** — the spawn binary
always comes from the locally configured preset, and `provider` is restricted to
`claude`, `antigravity` (`agy` accepted as an alias) and `codex`, with `custom`
excluded precisely because it would let a manifest choose an arbitrary local
binary. **`skills` and `mcpServers` are references into bundled allowlists**
(`BUNDLED_SKILL_IDS`, `mcpCatalogEntry`), never raw specs; MCP entries outside
the `safe-readonly` tier come back as `consentRequired` and are surfaced for
explicit human consent, never auto-enabled.

## The flag allowlist

`commandFlags` is a **default-deny allowlist** — `SAFE_FLAG_NAMES` = `--model`,
`--max-turns`, `--output-format`, `--verbose`. It replaced a denylist because a
denylist provably drifts: three rounds of re-review each found one more spelling
that escaped, first codex `-a`/`-s`, then `-c model_providers.*.base_url=…`
(backend redirect, credential exfiltration), then `--provider`. Default-deny
closes the class instead of the case. Matching is on the flag **name** (before
any `=`), case-insensitive; a bare token is accepted only immediately after an
allowed `--flag` with no inline `=`, so a value can never smuggle in a second
unknown flag. The list is biased hard toward exclusion because the spawn command
stays editable after import.

Two regexes back it up. `FLAG_RE` rejects quotes, backticks, semicolons, pipes,
ampersands, redirects, percent (cmd.exe `%VAR%` expansion) and whitespace.
`MODEL_RE` is separate, with its own character set — it allows spaces, parens and
brackets that real labels need (`Gemini 3.1 Pro (High)`, `claude-sonnet-4-6[1m]`)
and drops `=` and `,` — for a concrete reason: a model value flows onto the
command line, and on Windows a `.cmd`/`.bat` provider shim routes it through
cmd.exe where an unquoted `&`/`|`/`^`/`<`/`>` would chain a second command. Everything else is length-capped by `capped()` — name 40, description
200, goal 4000, model 80, at most 16 flags / 12 capabilities / 8 skills / 8 MCP
ids — and `homepage` must be `https://`.

## Transport (main process)

`src/main/hire.ts` is the fetch/read half, deliberately free of any `electron`
import so it can be smoke-tested as a plain Node module. Both entry points end in
the same shared validator. `fetchHireManifest(src)` is bounded four ways:

- **https only**, with plain http allowed for loopback so a local gallery can be
  developed against (`isAllowedManifestUrl`).
- **`redirect: 'manual'`**, up to 5 hops, each re-validated and each required to
  be https. `follow` would validate only the initial URL, so a remote manifest
  could 302 to `http://127.0.0.1:PORT/…` or a metadata endpoint, turning a
  clicked link into a blind GET against an internal service.
- **An SSRF address gate.** `assertPublicTarget` resolves DNS for the initial URL
  and every hop against a `node:net` `BlockList` covering loopback, RFC1918,
  CGNAT, link-local (including `169.254.169.254` cloud metadata), ULA,
  deprecated site-local and multicast/reserved. Unresolvable or unparseable fails
  **closed**. IPv4-in-IPv6 forms are de-mapped first — v4-mapped `::ffff:a.b.c.d`
  in *both* dotted and hex-group spelling, v4-compatible `::a.b.c.d`, NAT64
  `64:ff9b::/96`, 6to4 `2002::/16` — because the hex-group form `::ffff:7f00:1`,
  which is what `new URL()` actually emits, sailed straight past the earlier
  hand-rolled string-prefix check.
- **A 10 s timeout and a 64 KB body cap** read incrementally by `readBounded`:
  `content-length` is attacker-controlled and `res.text()` would buffer the whole
  stream first, so a hostile host could stream unbounded data and OOM the main
  process inside the timeout window.

The residual risk is stated rather than solved: a DNS rebind between the lookup
and `fetch()`'s own resolution is accepted for v1, because there is no connection
pinning. `readHireManifestFile(path)` is the file-picker half — a `statSync` size
check against the same cap, then parse and validate.

> ⚠ **INTENT UNVERIFIED:** Why does `HireProvider` still list only `claude`,
> `antigravity` and `codex` when eleven providers exist? It could be that spec v1
> is frozen and widening the enum needs a spec bump, or it could be drift.
> Nothing in the code, the commits or the tests records which. (raised
> 2026-08-22)

---

# Part C — Machine setup

## The setup catalog and live detection

The app ships as one Electron bundle, but several of its best features are thin
wrappers over tools that live outside it, and every one of them **degrades
silently** when absent. That is the deliberate runtime design, and it is friendly
right up until "off" and "broken" look identical. `src/shared/toolCatalog.ts` is
the single place that distinguishes them: four base rows (`uv`, `mempalace`,
`git`, `node`) plus **one engine row per provider, derived from
`AGENT_PROVIDER_PRESETS`** rather than restated, so a new provider cannot drift a
second hand-maintained copy. `toolCatalog()` skips `custom` and any preset
without a `defaultCommand` — there is nothing to detect or install.
Claude is the only engine marked `essential`,
because it is the one the floor assumes by default. `node` carries no scripted
install on purpose — the app already ships a checksum-verified Node installer,
and printing a rival `curl | sh` would compete with it.

`src/main/toolStatus.ts` answers "is it here?" under one hard rule: **detection
must never hang the UI**. The app already burned time on a `spawnSync` that
blocked Electron's main process for up to 120 s. So presence is a pure
`existsSync` walk with no spawn at all (`detectToolPath`), and the only spawn —
the optional `--version` probe — is an async `execFile` with a hard 3 s timeout,
all in parallel, so wall time stays around 3 s regardless of tool count.
Detection mirrors what a spawn does: the user's interactive-shell PATH (memoized
`userShellPath()`) plus the same fixed candidate directories `resolveCommand`
falls back to (`defaultExtraDirs`), walking `.exe`/`.cmd`/`.bat` and `;` on
Windows. A binary outside that reachable set is reported **missing on purpose**
— the harness spawns via PATH, so "installed but unreachable" and "missing" are
the same failure.

## The install ladder

`src/main/cliInstall.ts` decides what can actually succeed here. Every provider's
`installCommand` is `npm install -g …`, which needs npm, which needs node; on a
bare machine the banner used to print that command and run it, so the user
watched `npm: command not found` scroll past and concluded the app was broken.

``` ts
if (info.command && npmAvailable)  return { kind: 'npm' };            // the common case
if (info.command && nodeInstaller) return { kind: 'node-then-npm' };  // fix the machine
if (info.nativeCommand)            return { kind: 'native' };         // vendor's self-contained installer
return { kind: 'manual' };                                            // run NOTHING
```

`npmAvailable` means npm is present **and** its Node is at or above
`NODE_FLOOR_MAJOR` (20, Electron's own bundled line); a Node newer than ours is
left alone entirely. The **founder decision of 2026-08-07** put `node-then-npm`
above `native`, reversing the earlier "never auto-install a system Node" rule
that 60ecca0 had shipped the same day: a user who only ever gets the node-free
Claude installer still has no runtime for MCP servers, hooks or any other
provider, so the default is to fix the machine rather than route around it. The
new rung landed in 0b95976 (2026-08-08). `native` survives as the fallback for
when no installer could be resolved — offline, or a platform nodejs.org ships no
package for.

`buildMissingCliScript` emits the script in the target platform's shell syntax.
The Windows form is **one `&`-chained cmd.exe line containing no double quotes**,
because it is wrapped verbatim in `cmd /d /s /c "…"` where one embedded quote
would end the command line early. The POSIX form is one statement per line for
`$SHELL -lc`, single-quoted echo text, and no `!` so history expansion never
fires. The only user-derived value — the missing binary name — is sanitized to
`[A-Za-z0-9._-]`; the install commands are trusted hardcoded constants.

## Installing Node itself

`src/main/nodeInstall.ts` resolves the exact installer for this machine, purely
and offline-testably. `pickLatestLts(index)` takes the **first entry with a
truthy `lts`** from nodejs.org's newest-first `index.json` — deliberately not
`index[0]`, which is the current/odd release and not what "latest stable" means
to a user who wants things to work. `nodeArtifactFor` derives the filename (macOS
one universal `node-<v>.pkg`; Windows `node-<v>-<arch>.msi`; Linux a `.tar.xz`,
because there is no official Linux package), but the names are **validated
against `SHASUMS256.txt`**, which is authoritative: `index.json`'s `files` array
omits `win-arm64-msi` even though that artifact is published, and its
`osx-x64-pkg` entry actually denotes the universal pkg. **No digest means no
install** — we run the result as root, so `resolveNodeInstaller` returns null
rather than executing something unverified. Fetches are bounded at 6 s so an
unreachable nodejs.org drops the ladder to its next rung instead of hanging a
spawn.

`buildNodeInstallScript` is download → **verify** → install, aborting at every
step. macOS ships `shasum` and Linux ships `sha256sum` (neither ships both);
Windows uses `certutil -hashfile` with `findstr` for the compare, because cmd has
no string equality on command output. Elevation is visible — `sudo`, or
msiexec's own UAC prompt — in the same terminal as every other installer in the
app. Nothing elevates silently, and a mismatch aborts before anything executes.

## The local skills inventory

`src/main/skills.ts` reports **what the coding agents on this machine can already
do**, by walking the directories each CLI reads: Claude Code's `SKILL.md` folders
(`~/.claude/skills`, `<cwd>/.claude/skills`, the bundled resources dir), plus
OpenCode (`~/.config/opencode/plugin`, `<cwd>/.opencode/plugin`) and Codex
(`~/.codex/plugins`) plugin directories, reported as plugins rather than
pretending they share a format.

There is deliberately **no catalog, no fetch, no install and no uninstall**
(operator's call): a public skill store is a supply-chain surface for no gain,
and adding a skill is a decision, not a click. The upstream commit this was
ported from claimed "nothing here installs anything" in the same commit that
added `installSkill`, so the catalog half was dropped, not trusted.

`parseSkillFrontmatter` is not a YAML parser: `name` and `description` are all
the UI shows, and `description` is routinely a multi-line `|` block that a naive
`key: value` split truncates at the first line. `listLocalSkills` dedupes by
`(provider, lowercased name)` with **project > user > bundled** precedence, the
same precedence the CLIs apply. An unreadable folder is skipped, never fatal.

---

## Workflows

### A missing engine CLI

| Step | Action | Location |
|---|---|---|
| 1 | Pre-spawn: the binary is not on PATH and `noAutoInstall` is unset | `index.ts:3641` |
| 2 | Probe npm **and** its Node version against the floor | `nodeIsUsable(detectNodeVersion(…))` |
| 3 | Only if npm is unusable, reach the network for a Node installer | `resolveNodeInstaller` |
| 4 | Classify the rung | `chooseInstallRung` |
| 5 | Spawn a PTY running the emitted script, visibly | `buildMissingCliScript` |
| 6 | Arm the relaunch **only when a rung actually ran** | `pendingInstallRelaunch`, `index.ts:3683` |
| 7 | On clean exit, re-run the same spawn with `noAutoInstall` | `index.ts` exit handler |

### Importing a hire

| Step | Action | Location |
|---|---|---|
| 1 | Parse the deep link, extract and gate `src` | `parseHireDeepLink`, `isAllowedManifestUrl` |
| 2 | Fetch under all four bounds, or read the picked file | `fetchHireManifest` / `readHireManifestFile` |
| 3 | Validate — shape, caps, flag allowlist, skill/MCP allowlists | `validateHireManifest` |
| 4 | Return non-safe-readonly MCP ids for human consent | `HireValidation.consentRequired` |
| 5 | Pre-fill the Add-Agent modal; a human clicks spawn | `AddAgentModal.tsx` |

## Integration points

- **The spawn spine** (`spawnAgentCore`, `PtyManager`, `src/main/index.ts`)
  consumes every argv builder here and owns the spawn, the PATH resolution and
  the install relaunch. This layer returns tokens and scripts, never processes.
- **The hive** (`hive.ensureAgent`, `src/main/hive.ts`) dispatches on `hiveAware`
  for the Claude flag injection, on `bridgeOf(...).kind` for bridge installation
  (`installCodexHooks`, `installAgyHooks`, `installGrokHooks`,
  `installOpenCodePlugin`, `installPiHooks`, `installCrushConfig`), and on the
  three prompt-delivery fields for the protocol seed.
- **The renderer** reads presets directly in `AddAgentModal.tsx`,
  `CommandCenterPanel.tsx`, `SettingsModal.tsx` with `SetupPanel.tsx` and
  `AiEnginesSettings.tsx`, and `OnboardingWizard.tsx`; `useProviderModels` is the
  one hook merging the static and discovered model lists.
- **The hook layer** (`src/main/hooks.ts`) gates steer delivery on
  `bridgeDeliversHookContext`; undeliverable steers stay queued.
- **The card/session layer** routes every resume through
  `composeSessionCommand` (`src/main/sessionRequests.ts:63`), which is the one
  caller of `contextCommandsForProvider` (`sessionRequests.ts:81`);
  `src/main/cardSessions.ts` reaches it one hop away and mails the god on `null`.
- **The MCP catalog** (`src/shared/mcpCatalog.ts`) supplies `mcpCatalogEntry` and
  the tier that decides `consentRequired`.

## Gotchas

- **A flag glued onto the command string never reaches the process.** Spawn paths
  PATH-resolve only the first token. This is the
  `renderer-hire-flag-append-20260816` bug class, and why every injector returns
  `string[]`. Pinned by `test/hire-flag-tail.test.cjs`.
- **Every argv builder must be idempotent**, because the install relaunch
  re-enters `spawnAgentCore` with the same opts object. Pinned by
  "install-relaunch re-entry: the tail is never prepended twice".
- **`hiveAware` is not "participates in the hive".** Codex, Grok, Antigravity,
  OpenCode and Pi are all `hiveAware: false` and still full hive citizens with
  live status and inbox delivery.
- **`canReceiveInbox` is a third, separate question.** Kimi is bridgeless today
  and Copilot runs in print mode and exits per turn, so both bounce mail to the
  god while being otherwise normal providers.
- **Claude warns on an unknown `--effort` value instead of failing**, so a stale
  or wrongly-cased config value would degrade invisibly. `godEffortArgs` drops any
  level outside the preset's vocabulary before the spawn.
- **A session id does not survive an engine switch.** Attaching the old CLI's id
  to the new CLI's resume flag kills the spawn. Pinned by
  `test/pi-resume-guard.test.cjs`.
- **Crush cannot take a positional prompt** (its first positional is a Cobra
  subcommand) and has no `--prompt` flag, so its seed must be typed into the TUI.
- **Crush's `baseUrlEnv: 'CRUSH_PROXY_BASE_URL'` is an intentionally inert
  sentinel.** Crush has no base-URL env override; routing goes through the
  per-agent `CRUSH_GLOBAL_CONFIG` that `installCrushConfig` writes. "Fixing" it to
  a real env var would have no effect.
- **`codexCommands.ts` is knowingly incomplete.** It listed `/clear` but not
  `/compact` while `providerAutomation` was already sending `/compact`; the
  binary was right and the catalog was corrected, but the two remain separate
  hand-maintained lists that can drift again.
- **A tool outside the reachable PATH is reported MISSING** — intentional parity
  with spawn behaviour, and it surprises people who can run the binary in their
  own shell.
- **`BUNDLED_SKILL_IDS` is far narrower than `resources/skills/`.** A manifest may
  request only `md-hive-sync`, `md-fetch-summarize` and `md-audit`, while the
  skills panel reports every bundled folder it finds. The two "bundled" sets are
  not the same set.
- **The Qwen preset carries four unresolved `// TODO-verify` marks** — `--yolo`,
  `OPENAI_BASE_URL`, `-i`, `qwen3-coder-plus`. Treat them as unconfirmed until a
  qwen binary is available.
- **`claw` (claw-code) was removed as a selectable provider** because its upstream
  is an unmaintained repo, not a production CLI. The proxy-bridge tier it shared
  stays in place for qwen.

## Key files

| File | What lives in it |
|---|---|
| `src/shared/agentProvider.ts` | `AgentProvider`, `AGENT_PROVIDER_PRESETS`, inference, every argv builder, bridge accessors, install info |
| `src/shared/claudeCommands.ts` | `Cmd`/`CmdGroup` shape and the Claude command reference (also rendered to `<hive>/COMMANDS.md`) |
| `src/shared/codexCommands.ts`, `src/shared/grokCommands.ts` | Codex and Grok command references |
| `src/shared/providerAutomation.ts` | `CONTEXT_COMMANDS`, TUI readiness, inbox-monitor and nudge grace |
| `src/shared/modelOptions.ts` | `ModelOption` — the shared picker entry shape |
| `src/main/providerModels.ts` | `pi --list-models` discovery, `parsePiListModels`, `ProviderModelCache` |
| `src/shared/ossModels.ts` | OSS local + BYOK quick-picks, `localSlugFor`, `hasOssQuickPicks`, blog links |
| `src/main/resumeGuard.ts` | `piSessionExists` — the cross-engine stale-resume guard |
| `src/shared/codexRemote.ts` | Short `CODEX_HOME` alias, socket-length checks, `--remote` arg prepend |
| `src/main/internDefaults.ts` | `resolveInternSpawn` — engine identity as a coherent pair |
| `src/shared/hire.ts` | Manifest spec v1, `validateHireManifest`, `SAFE_FLAG_NAMES`, deep-link parsing |
| `src/main/hire.ts` | Manifest transport: bounded fetch, SSRF gate, file import |
| `src/shared/toolCatalog.ts` | `ToolSpec` rows; engine rows derived from the presets |
| `src/main/toolStatus.ts` | Non-blocking PATH detection and the capped `--version` probe |
| `src/main/cliInstall.ts` | `chooseInstallRung`, `buildMissingCliScript` |
| `src/main/nodeInstall.ts` | LTS resolution, artifact naming, checksum pinning, install script |
| `src/main/skills.ts` | Local skill/plugin inventory with project > user > bundled precedence |

Behaviour specs live in `test/agent-provider.test.cjs`, `hire-flag-tail`,
`provider-automation`, `provider-models`, `pi-models-dynamic`,
`pi-resume-guard`, `intern-defaults`, `cli-install-ladder`, `node-install`,
`tool-detect`, `codex-remote` and `skills` (`*.test.cjs`).
