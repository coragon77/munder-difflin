# Munder Difflin — Design System

- **Coverage:** `src/renderer/src/design/`, `src/renderer/src/components/`, `src/renderer/src/scene/`, `src/renderer/src/statusLabel.ts`, `src/shared/waitingLabel.ts`, `src/renderer/index.html`, `src/renderer/src/statusText.ts`, `src/shared/agentOrder.ts`, `src/shared/settingsHero.ts`
- **Last Updated:** 2026-08-21

> The aesthetic is **Animal Crossing × Earthbound × SNES menu UI**. Pixel-snapped, chunky, friendly. Every UI element should feel like it could appear in a Nintendo game from 1995–2005. This document is canonical: any new component must derive from these tokens.

---

## 1. Principles

1. **Pixel-snapped everything.** No half-pixels. No CSS blur. No floaty `border-radius`. The grid is real.
2. **Chunky over slick.** Borders are visible, panels have weight, buttons feel pressable. If a component could exist on iOS 17, it's wrong.
3. **Limited palette.** Each screen uses ≤ 8 colors. Each sprite uses ≤ 5. Restraint creates the look.
4. **Information through motion.** An avatar walking *is* the status. Don't add a progress bar if the walk already communicates. The converse is the trap: motion must never *claim* a status the agent does not have — see §12.4.
5. **Friendly, never cute-for-its-own-sake.** Copy is short and human. Avoid baby talk. Think Tom Nook's signage, not Saturday morning cartoons.
6. **Read like a 90s game manual.** Heavy use of named panels, framed groups, status windows. Information has a *home*.

### What we are NOT
- Not glassmorphism. Not Material. Not iOS. Not "modern web." Not "retro filter on a normal app."
- Not pixel art for its own sake — every pixel choice serves a UX function.

---

## 2. References (study these)

| Reference | What we steal |
|---|---|
| **Animal Crossing: New Leaf / NH** | Villager characters, soft palette, friendly copy, dialog boxes |
| **Earthbound / Mother 3** | Status windows, multi-layer panel borders, vibrant flat colors |
| **Stardew Valley** | Font choice, tile floors, sprite proportions |
| **Pokémon B/W & X/Y** | Clean info panels, summary screens |
| **Mario Kart 8 (HUD only)** | Coin/timer chips, vibrant accents on neutral backgrounds |
| **Undertale** | Terminal-style typography for system feedback |
| **Stardew Concerned Ape sprites** | Walk cycles, station design |
| **SNES Final Fantasy VI menus** | Three-layer panel borders, cornered headers |

---

## 3. Color system

All colors specified in `#RRGGBB`. Token names use a `--cth-<category>-<weight>` pattern (CSS variables) and a parallel TypeScript `tokens.colors.<category>.<weight>` (objects).

**Two themes, one set of token names.** Since `5510818` the whole app has a dark
mode, not just the terminal: `design/theme.ts` stamps `data-cth-theme` on `<html>`
and `tokens.css` re-declares the same token names under
`:root[data-cth-theme="dark"]` — a warm-neutral elevation ramp, an off-white text
ramp that never reaches `#FFF`, and accents lifted one step so they hold the same
perceived weight (`51ec611`). Every hex below is the **light** value. A component
that reads tokens gets both themes for free; a component that hardcodes a hex gets
one theme and is invisible in the other, which is the bug class `b158c29` fixed.

### 3.1 Base (panels, floors, surfaces)

| Token | Hex | Use |
|---|---|---|
| `cream-50` | `#FFFDF5` | Lightest highlight, dialog box innermost |
| `cream-100` | `#FFF8E7` | Default panel fill |
| `cream-200` | `#F4E9C7` | Inset / alt row |
| `cream-300` | `#E8D9A0` | Disabled fill |
| `paper-100` | `#FCFAF0` | Terminal background |
| `paper-200` | `#F0EAD2` | Subtle panel variant |

### 3.2 Ink (text, outlines)

| Token | Hex | Use |
|---|---|---|
| `ink-900` | `#1A1320` | Body text, outer borders. **Never use `#000`.** |
| `ink-700` | `#3D2E4A` | Secondary text, middle border layer |
| `ink-500` | `#6B5878` | Tertiary text, disabled borders |
| `ink-300` | `#A899B5` | Placeholder, hairline dividers |
| `ink-100` | `#D9CFE0` | Subtle separators |

### 3.3 Agent accents (vibrant, character colors)

Each avatar gets one — the strip badge, the agent's chat selection highlight, their
nameplate.

`51ec611` recalibrated the whole set: **same hues, professional saturation.** The
originals were full-saturation arcade tones (`lemon` was `#FFD93D`, `coral`
`#FF6B6B`) that read as noise at UI density; the current values sit in the calmer
band Linear and Radix use. The hue language — and therefore every mnemonic below —
is unchanged; only the saturation moved.

| Token | Hex | Mnemonic |
|---|---|---|
| `coral` | `#D96A62` | Mario red |
| `coral-light` | `#F3D3CD` | |
| `mint` | `#5CA97A` | 1UP green |
| `mint-light` | `#D2E7DA` | |
| `sky` | `#4F9FAF` | Wind Waker ocean |
| `sky-light` | `#CFE5E9` | |
| `lemon` | `#DCAB3C` | Pikachu |
| `lemon-light` | `#F3E4BC` | |
| `lilac` | `#9482D3` | Psychic-type |
| `lilac-light` | `#E0DAF2` | |
| `peach` | `#D99168` | Princess Peach |
| `peach-light` | `#F3DACA` | |

In dark mode the `-light` variants are **not** lighter — they become deep muted
fills (`coral-light` is `#46302E`) so that `ink-900`, which is off-white there,
stays readable on top (`51ec611`).

### 3.4 Status (system semantics)

Recalibrated with the accents in `51ec611`; the hue meanings are unchanged.

| Token | Hex | Means |
|---|---|---|
| `status-idle` | `#A199AB` | Agent at desk, awaiting |
| `status-thinking` | `#4F9FAF` | Reasoning + en route to a station |
| `status-working` | `#DCAB3C` | At a station, using a tool |
| `status-waiting` | `#6D87D6` | Worker stalled on god or another agent. Distinct from the §7.3 badge label `wait (N)`, which counts pending background work |
| `status-blocked` | `#D96A62` | Notification fired, needs user |
| `status-success` | `#5CA97A` | Just finished |
| `status-ghost` | `#D9D3DE` | Pane closed, fading out |
| `status-compacting` | `#8F7CC7` | Boxing up context (PreCompact/PostCompact) |
| `status-looping` | `#D6903F` | Circuit breaker armed — runaway |
| `status-typing` | `#C89838` | **Not an agent state.** *You* have unsent text on that agent's prompt, which is holding its message queue |

`tokens.ts` mirrors only the six statuses the Pixi floor draws (idle, thinking,
working, blocked, success, ghost). `waiting`, `compacting`, `looping` and `typing`
are CSS-only — they are badge states, and no sprite renders them.

### 3.5 World (the floor itself)

| Token | Hex | Use |
|---|---|---|
| `grass-light` | `#D4EAB0` | Light tile |
| `grass-dark` | `#B5D589` | Dark tile (checkerboard) |
| `wood-light` | `#E5C896` | Room floor light tile |
| `wood-dark` | `#C9A66B` | Room floor dark tile |
| `path` | `#E8D8B0` | Pathways between rooms |
| `wall` | `#8B6F47` | Room walls (3px stroke) |

### 3.6 Gradient bans

No gradients except: vertical 2-stop on title bars (`cream-100` → `cream-200`). That's it. Every other surface is flat.

---

## 4. Typography

Three roles, three token names — but **only the display face is still a pixel
font.** `51ec611` replaced the two faces the user actually reads: Pixelify Sans and
VT323 were the biggest readability drag in the product, so Inter took every UI
string and JetBrains Mono took everything code- or terminal-shaped (the xterm pool,
`TerminalView`, Monaco and its diff view, `--cth-font-mono`). Press Start 2P
survives as the **brand** face only — the logo, headers and small-caps labels — and
the pixel identity now lives in those, in the icons, and on the office floor.

| Role | Token | Family | Why |
|---|---|---|---|
| **Display / brand** | `--cth-font-display` | `Press Start 2P` | NES-iconic, small-caps labels and headers only, 8/12/16 px |
| **UI** | `--cth-font-ui` | `Inter` | Everything the user reads; falls back through `-apple-system` / `system-ui` |
| **Mono / terminal** | `--cth-font-mono` | `JetBrains Mono` | Terminal, code, Monaco; falls back through `ui-monospace` / `Menlo` |

Every text element must still declare a font from this set. The three families are
loaded from Google Fonts in `index.html`; the system faces after each are fallbacks
for a failed font load, never a choice a component makes.

### 4.1 Type scale (all px integers)

`3c2b6d1` took the body and mono ramps **one step down** — Inter reads larger than
Pixelify at equal px, and the controls built against the old scale were oversized.
The display ramp did not move: Press Start 2P is the same face at the same sizes.

| Token | Size | Line height | Use |
|---|---|---|---|
| `display-lg` | 16 / `Press Start 2P` | 24 | App title, screen titles |
| `display-md` | 12 / `Press Start 2P` | 20 | Section headers, modal titles |
| `display-sm` | 8 / `Press Start 2P` | 12 | Badges, chip labels |
| `body-lg` | 16 / `Inter` | 24 | Primary body |
| `body-md` | 14 / `Inter` | 20 | Default UI text (the `<body>` default) |
| `body-sm` | 13 / `Inter` | 18 | Secondary, captions |
| `mono-md` | 14 / `JetBrains Mono` | 20 | Terminal stream |
| `mono-sm` | 13 / `JetBrains Mono` | 20 | Inline log lines, paths |

Both mono sizes share one line-height token, `--cth-lh-mono` (20 px). The 18 px
this table used to list for `mono-sm` was a doc error: there has never been a
per-size mono line height.

### 4.2 Weight
**Never bold.** For emphasis: use color (`ink-900` vs `ink-500`) or a chip/badge.

The original reason was mechanical — Pixelify Sans and VT323 shipped one weight, so
bold was not available. `51ec611` removed that guardrail: Inter is a full-weight
family, so bolding is now merely forbidden rather than impossible.

> ⚠ **VERIFY:** Does **Never bold** still hold? 16 sites in
> `src/renderer/src/components/` set `fontWeight: 600` or `700` (`HivePicker`,
> `ThreadsPanel`, `WorkersTab`, and the `CodeEditor` heading tag among them). No
> commit in the 2026-08-04 → 2026-08-21 range records a decision to lift the rule,
> so this may be drift that arrived with Inter rather than a design change.
> Checked: `grep -rn fontWeight src/renderer/src/components/`. (raised 2026-08-21)

### 4.3 Case
- Display fonts: **TITLE CASE**, never ALL CAPS (Press Start 2P is already loud).
- UI fonts: Sentence case.
- Status badges: lowercase ("working", "thinking", "blocked").

### 4.4 Letter spacing
- Press Start 2P: `0` (already wide enough).
- Pixelify Sans: `0`.
- VT323: `0`.
Never add letter-spacing — it breaks the pixel grid.

---

## 5. Spacing & grid

Base unit: **4 px**. Every margin, padding, gap, position must be a multiple of 4. No exceptions outside sprite-internal art.

> ⚠ **VERIFY:** Is the 4 px grid still enforced outside the `--cth-space-*` tokens?
> The tokens themselves are untouched, but components in the 2026-08-04 →
> 2026-08-21 range place off-grid values without noting an exception:
> `066372d` made `CARD_RIGHT_SLOT` a *shared* layout rule at `marginRight: 6`, and
> `3c2b6d1` sized the god agent card 216 × **86**. Neither commit records a decision
> to drop the grid, so this may be drift rather than a design change. Checked:
> `tokens.css`, `AgentCard.tsx:123-124`, `TasksKanban.tsx`. (raised 2026-08-21)

| Token | px |
|---|---|
| `space-0` | 0 |
| `space-1` | 4 |
| `space-2` | 8 |
| `space-3` | 12 |
| `space-4` | 16 |
| `space-5` | 24 |
| `space-6` | 32 |
| `space-7` | 48 |
| `space-8` | 64 |

### Layout

- Main window minimum: 1280 × 800.
- Standard gutter: 16 px (`space-4`).
- Panel internal padding: 12 px (`space-3`).
- Floor canvas: dynamically sized, but tile grid is 32 × 32 px (one game tile).

### Pixel snapping

- All `transform: translate(...)` values must be integers.
- `imageRendering: pixelated` on every `<canvas>` and any rendered sprite `<img>`.
- Zoom levels are whole or **half** steps (1×, 1.5×, 2×, 2.5×) — never an arbitrary
  fraction. `e6cfac4` relaxed this from whole-only: a half-step doubles every other
  source row, which pixel art survives, whereas a scale like 1.37× renders some rows
  one device pixel tall and others two. `SpritePortrait` blits with
  `imageSmoothingEnabled = false` and rounds the backing store and the CSS box to
  the *same* integer — a mismatch between those two is what actually makes pixel art
  blurry.

---

## 6. Borders & panels

**The SNES three-layer border is gone from every panel but one.** `3c2b6d1`
collapsed it to a single hairline; only `panel/active` still draws the old
five-pixel ring (§6.2). The three-layer package boxed every surface in 5 px of chrome,
and at the density this app reached that read as heavy nested boxes rather than as
structure. Structure now comes from **surface contrast** — the cream/paper ramp —
and the outline only says where one surface ends.

The same commit swept the rest of the repo one step down with it: 2 px `ink-900`
active outlines became 1.5 px `ink-500`, 1 px `ink-900`/`ink-700` outlines became
`ink-300`/`ink-100` hairlines, and 2 px solid dividers became 1 px.

### 6.1 Anatomy

```
┌────────────────────────────────┐  ← hairline: 1px, ink-300 (ink-500 on dialogs)
│                                │
│   panel content                │  ← fill:     cream-100
│                                │
└────────────────────────────────┘
```

CSS implementation: a single `box-shadow inset` from a token, not nested DOM. No
`border-radius`. Total border weight: 1 px on each side.

### 6.2 Panel variants

Four border tokens in `tokens.css`, each `inset 0 0 0 1px`. The fill is chosen by
the consumer from the base ramp (§3.1), not carried by the border token.

| Variant | Token | Hairline | Typical fill | Use |
|---|---|---|---|---|
| `panel/default` | `--cth-panel-border` | `ink-300` | `cream-100` | Standard |
| `panel/inset` | `--cth-panel-border-inset` | `ink-100` | `cream-200` | Recessed area |
| `panel/terminal` | `--cth-panel-border-terminal` | `ink-300` | `paper-100` | Terminal background |
| `panel/dialog` | `--cth-panel-border-dialog` | `ink-500` | `cream-50` | Modals, notifications — the one deliberately stronger line |

**`panel/active` is the one place the three-layer border survives.** It has no
token of its own — it reuses `--cth-panel-border` — but when an `accent` prop is
present `PixelPanel` overlays the old anatomy directly: `ink-100` at 1 px, the
accent at 3 px, `ink-900` at 5 px. Selection is the one state where the heavy ring
still earns its weight, so `3c2b6d1`'s sweep left it. Everywhere else, a
component that wants a selected look should follow the sweep and use the accent at
the reduced 1.5 px weight rather than rebuilding a five-pixel ring.

### 6.3 Corner cuts

Optional. Adds an 8-bit "rounded corner" feel by clipping 2 px squares from each corner. Implementation: SVG `clip-path` or four absolute-positioned 2 × 2 squares matching the parent background. Reserved for: dialogs, the main app frame.

### 6.4 Drop shadow

The only shadow allowed is a **hard offset**, from the `--cth-shadow-hard` token.
No blur, ever. Used on: modals, toasts, dragging avatars.

`3c2b6d1` softened the light-mode shadow from 4 px / 25 % to 3 px / 14 % as part of
the same de-chroming pass as the hairline borders. Dark mode keeps the full 4 px
offset, because on the dark elevation ramp a soft shadow reads as void rather than
as depth; `5510818` shipped it at 55 % black and `51ec611` softened it to 45 %.

```css
/* light  */ --cth-shadow-hard: 3px 3px 0 rgba(26, 19, 32, 0.14);
/* dark   */ --cth-shadow-hard: 4px 4px 0 rgba(0, 0, 0, 0.45);
```

Or as a sibling block element absolutely positioned 3 px offset.

Read the token; never hardcode either value, or the shadow will be wrong in one of
the two themes.

---

## 7. Components

Every component is spec'd by its anatomy, states, props, and example.

### 7.1 `<PixelPanel>`

Foundational container.

```
Props:
  variant    'default' | 'inset' | 'active' | 'terminal' | 'dialog'
  title?     string        — renders titlebar
  accent?    AccentColor   — applies to title bar + middle border if active
  children   ReactNode

States:
  default   — as drawn
  hover     — no change (panels don't hover; only buttons do)
  focused   — pass variant='active' + accent: the panel paints the accent
              into the old middle-border slot (see §6.2 — the one surviving
              three-layer border)
```

### 7.2 `<PixelButton>`

Pressable, but no longer 3D-chunky: `3c2b6d1` took it to a **1 px hairline plus a
1 px lift** (it was 2 px and 2 px), dropped three of the four variants' borders one
step — `primary` keeps `ink-900` — and moved the label down one step of the type
scale.

```
Props:
  variant   'primary' | 'secondary' | 'ghost' | 'destructive'
  size      'sm' (24h) | 'md' (32h) | 'lg' (40h)
  icon?     IconName
  children  ReactNode

States:
  default   — inset 1px hairline + `0 1px 0` lift in the variant's shadow color
  hover     — fill becomes the light variant of the variant color
  active    — translateY(1px), the lift disappears (pressed)
  disabled  — fill = cream-300, text = ink-500, no press affordance
  focus     — 2px ink-900 outline at +2px offset

Label font: --cth-font-ui. Size: body-sm at 'sm'/'md', body-md at 'lg'.

              fill          text       border     lift shadow
Primary:      ink-900       cream-50   ink-900    ink-900
Secondary:    cream-100     ink-900    ink-300    ink-100
Ghost:        transparent   ink-700    ink-300    ink-100
Destructive:  coral         ink-900    ink-500    ink-300
```

**Disabled text is its own token, not the variant's.** All four variants swap the
fill to `cream-300` when disabled and *must* pair it with `ink-500`. `b158c29`
fixed the alternative: `primary` kept its enabled `cream-50`, the inverse
foreground chosen to sit on an ink-900 button, and on the disabled fill that pair
collapses to `#1A191E` on `#37363E` in dark mode — about 1.4:1, invisible. A
disabled Send or Dispatch read as an empty box. `ink-500` is the one foreground
that works against `cream-300` in both themes, because both tokens flip together.

### 7.3 `<PixelBadge>` (status chip)

```
Props:
  status    'idle' | 'thinking' | 'working' | 'waiting' | 'blocked' | 'success'
            | 'ghost' | 'compacting' | 'looping' | 'typing'
  label     string
  icon?     IconName

Anatomy: 8 px tall pixel dot + space-1 + lowercase Pixelify Sans 14 px.
Color: status palette. Background: status-color at 20% opacity over cream-100.
```

Labels are not the token names — they read from the *user's* side. `blocked` shows
"needs you" (reserved for the god agent waiting on you), and `typing` shows
**"your draft"** — it is your text on the prompt, not the agent's, and it is why
that agent's message queue is not draining. See
[`docs/architecture/message-queue.md`](docs/architecture/message-queue.md).

`waiting` now shows **`wait (N)`**, N being the agent's count of pending finite
background work — a CI monitor, a background shell, an in-flight subagent. Three
commits shaped that label and the rules are worth keeping:

- **Waiting is derived at render, never stored.** `8f3cebe` derives it from the
  volatile `Agent.pending` census in `statusLabel.ts` `waitingBadge()`, the same
  way `typing` derives from `hasTerminalDraft`. The census only *upgrades* idle; an
  agent that is working, typing, looping or blocked keeps its stronger state, so
  the badge can never mask a real one.
- **One builder, one wording.** `659a862` replaced four hand-built copies of the
  label with `waitingLabel()` in `src/shared/`, imported by both main and renderer.
- **The wording is `wait (N)`, bare number.** `134ee8e` shortened it from
  `waiting (N)` because that wrapped to a second line in the agent pane. Do not
  re-add a labelled variant; a source scan pins that exactly one file in `src/`
  builds the template.

### 7.4 `<AgentCard>` (bottom strip)

`3c2b6d1` compacted the card and the strip that holds it (strip 132 → 112 px) and
replaced the 8-segment progress dots with a slim gauge pinned to the bottom edge.

```
Width: 196 px (god 216). Height: 76 px (god 86).   ← AgentCard.tsx:123-124
Portrait: 36 × 46 (god 50), anchored TOP.
Row 1 (identity): name + status badge. Nothing else.
Row 2 (context):  action while working, repo while idle — pure info text.
Row 3 (note):     the private note, with the ✎ affordance; class chip right-aligned.
Bottom edge:      4 px gauge, filled to progress/8 — the same 8 work units
                  the old dot row counted, drawn as one continuous bar.

Selected state: the agent's accent color.
```

Three rules on this card were each learned from a specific regression:

- **The name row is the card's scarcest horizontal space.** The name span is an
  ellipsized `nowrap`, so anything sharing that row steals width from the name
  itself. `4a8289c` put `(G)`/`(I)`/`(H)` class prefixes there and ate four
  characters of every name; `d38e723` replaced them with a chip *outside* the
  ellipsized span so it can never truncate the name, and `e64e2a4` moved the chip
  off the name row entirely — Michael was still rendering as `MIC…` beside his
  chip. It now sits right-aligned on row 3, lined up under the status badge.
- **Only the exception class is marked.** Interns get an `INT` chip and the god
  gets a `BOSS` chip — renamed from `GOD` by `c64d7ae` so the app speaks the
  site's language, since he is the boss of the agents and the human is still the
  boss of him. Human-made hires are the unmarked default.
- **The portrait anchors top, so feet crop and faces do not.** The 56 px-tall
  sprite overflows its tile; bottom-anchoring cropped the head (`122472a`).

The private note is a **row inside the card**, above the gauge — it used to be an
overlay that covered the context bar, and the editor itself is now a fixed 280 px
popover anchored off the card's rect (`122472a`).

**Anything that must escape the card has to be portalled.** The agent dock clips
its children, so a popover positioned *inside* a card is sliced at the card's edge
no matter how it is anchored. `122472a` learned this with the note editor and
`9e5cc52` hit it again with the voice-key explainer, which now portals to `body`
with measured fixed coordinates. Same fix, same reason, twice.

### 7.5 `<CommandBar>`

```
Anatomy: PixelPanel inset variant.
Contains:
  - prompt prefix "> " (mono-md, agent's accent)
  - text input (mono-md, no border)
  - send button (primary, size-md, icon: arrow)
  - mode tabs above: [Free] [/skill] [Quick]

States:
  - typing       — caret = 2px wide block, blinks 500ms
  - busy         — input border tints lemon (agent is working)
  - blocked      — input border tints coral with helper text
```

### 7.6 `<TerminalView>`

```
PixelPanel terminal variant.
xterm.js with theme:
  background = paper-100
  foreground = ink-900
  cursor = coral
  selection = lemon-light
  ansi colors: see §11
Font: VT323 16 px.
Top edge: 2px dashed ink-300 line, label "live · pipe-pane" in mono-sm.
```

### 7.7 `<Toast>` (notification)

```
PixelPanel dialog variant, 320 px wide.
Top: 12 px stripe of agent's accent color.
Body: avatar portrait (24 × 24) + message (body-md, max 3 lines).
Actions row: two buttons max.
Drop shadow (hard 4/4).
Slide in from top-right, snap (no easing past first frame).
Auto-dismiss only for non-blocking. Blocking notifications wait for user.
```

### 7.8 `<RoomLabel>` (signpost over each project room)

```
Signpost: 8 px wood post + plank.
Plank: cream-200 fill, ink-900 outline, display-sm text.
Reads "project: <basename>". Positioned at top-left of each room.
Functionally a pixel sprite, not HTML.
```

### 7.9 `<ConfigDrawer>`

```
Slides in from right (240 ms snap, no easing).
Width: 480 px.
Title bar: display-md + close button.
Sections (collapsible): Identity, Goal, Runtime, Skills, MCP, Hooks.
Each section header: ink-900 + 2px underline + accent dot.
```

### 7.10 `<Modal>`

```
PixelPanel dialog variant.
Backdrop: ink-900 @ 60% opacity. NO blur.
Position: centered. Snap-in (200 ms ease-out scale 0.92 → 1.0).
Always has close button top-right and at least one action button bottom-right.
```

---

## 8. Avatar sprites

The whole product hinges on these. Spec is exact.

### 8.1 Grid

- **24 × 24 px** sprite cell.
- Walk cycle: **4 frames** (idle, step-A, idle, step-B). Each frame 24 × 24.
- Animation: 8 fps (125 ms per frame).
- Directions: **4 cardinal** (down, up, left, right). Diagonals are computed at runtime by selecting the dominant axis.

### 8.2 Anatomy

```
0123456789012345678901234   (x)
        ▓▓▓▓▓▓▓▓             row 4-5: hair
      ▓░░░░░░░░░▓            row 6-9: head, skin
      ▓░██░░░██░▓            row 8: eyes
      ▓░░░░░░░░░▓            row 10: mouth/cheeks
        ▓▓▓▓▓▓▓▓             row 11: jaw
       ▓░░░░░░░▓             row 12-17: torso, outfit
       ▓░██░██░▓             outfit detail
       ▓░██░██░▓
       ▓░░░░░░░▓
        ▓░░░░░▓              row 18-22: legs
        ▓░░ ░░▓              walk: alternating
         ▓▓  ▓▓              feet
```

### 8.3 Per-avatar palette (4 colors max)

Each avatar uses **exactly 4 sprite colors** (plus `ink-900` outline = 5 total slots):

| Slot | Role |
|---|---|
| `skin` | face, hands |
| `hair` | top of head |
| `primary` | main outfit color |
| `accent` | outfit detail (collar, belt) |

The agent's **accent palette token** (from §3.3) drives `primary`.

> ⚠ **VERIFY:** Does the accent token still drive `primary` for built-in cast
> members? Each `OFFICE_CAST` entry carries its own `shirt` hex — Michael
> `#5a6b8c`, Dwight `#b89b3e` — and none of them is an accent token; the ten added
> by `c714f79` follow the same pattern. The accent is persisted *separately* as
> `officeAccent` on the registry entry (`832e0ef`), so the two may be independent
> now. Checked: `scene/office/cast.ts:51-79`, `scene/office/spawnIdentity.ts`.
> (raised 2026-08-21)

### 8.4 Starter character archetypes

Built-in sprite presets. Each has its own outfit pattern.

| Archetype | Vibe | Outfit notes |
|---|---|---|
| `scientist` | Lab researcher | White coat panel down center, square glasses (2px black on row 8) |
| `wizard` | Magic mode | Pointed hat (rows 2-5 above head), star on chest (row 14) |
| `astronaut` | Explorer | Helmet (3px ring around head), antenna pixel on top |
| `cat-villager` | Animal Crossing | Triangle ears (rows 3-4), tail visible behind torso |
| `hacker` | Hoodie | Hood drape down sides of head, headphones (2px black on rows 6-7 sides) |
| `ninja` | Stealth | Mask covering lower face, ninja headband |

**Answered (Stefan, 2026-08-21):** the archetype table above is history — the
Office cast is intended, and character presets are now a per-**theme** concern.
The floor has a theme mechanism: `ThemeConfig` was extracted in `e8228e9`
(2026-06-13, "TV-show offices Phase 0" — before this doc's previous revision,
which is why no in-window commit removed the archetypes). The registry
(`scene/office/themeRegistry.ts:462`) holds `office`, `custom` and `brooklyn99`,
and `getTheme()` falls back to the office theme so a bad or absent show bundle
can never break the floor. Each `ThemeConfig` carries its own `cast` — the
Office cast is one theme's roster, not the system. The `custom` theme
(`d8d33dd`, 2026-08-17) is the operator's editable clone: it starts as a
byte-copy of `office.tmj`, re-uses every `OFFICE_THEME` field (seats, anchors,
palette, cast) and sets `preservesAgents: true`, so switching office↔custom
keeps every live agent, pane and session; the purchased LimeZu atlases ride as
extra tilesets at fresh firstgids, so painting them can never shift an existing
gid. Intent (Stefan): the copy exists so he can iterate on the floor easily in
Tiled.

**What the built-in presets actually are today.** `OFFICE_CAST`
(`scene/office/cast.ts:51`) holds **25** recolored LimeZu sprites, each a
`{ name, displayName, shirt, blurb }` row with art in `portraitArt.ts`. Fifteen are
the core floor; `c714f79` added ten more as an **intern-only pool** — Holly, Erin,
Jan, Karen, Nellie, Darryl, Roy, Gabe, Robert, Mose — so interns stop all wearing
the same two faces, and extended the icon picker to enumerate all 25.

Which sprite an agent gets is a three-rung ladder in
`scene/office/spawnIdentity.ts`, tried in order (`832e0ef`, `7b974a3`):

1. **The registry-saved pick** — `officeCharacter`/`officeAccent` on the registry
   entry. This is the durable home; before `832e0ef` identity lived only in the
   renderer's store and its wipeable roster mirror, so a recall with no matching
   shelf row re-derived from the name and Ada came back as the default Jim.
2. **The prior row** on the archived/restorable shelf, which carries the hire-time
   pick (`7b974a3`).
3. **Derivation from the spawn name.** `a8b1a0c` mapped female-coded name tokens to
   Angela and everything else to Jim; `c714f79` replaced that binary with a hash of
   the spawn name onto the gender-matched intern pool, so the same name always
   yields the same face and no intern wears a hire's face by default.

Backfill into rung 1 is **first-write-wins**, so the renderer can never repaint a
live agent's icon. An *explicit* edit is the exception and overwrites — `8c94d61`
made the edit dialog write `officeCharacter`/`officeAccent` through
`hive.setAgentMeta` and had `CharacterSprite.setFrames` swap the art in place, so
the floor sprite repaints immediately instead of waiting for a respawn.

### 8.5 Walk cycle

Frame 0 (idle): feet aligned, slight droop (y+0)
Frame 1 (step-A): left foot raised 1 px (y-1), right foot planted (y+0)
Frame 2 (idle): same as frame 0
Frame 3 (step-B): right foot raised 1 px, left foot planted

Walking adds a sin-wave bob to the whole sprite: ±1 px on y, sampled at 8 fps phased with the foot cycle. This is the Stardew Valley walk feel.

### 8.6 Status overlays

Drawn above sprite, 8 × 8 px:

| State | Overlay |
|---|---|
| `thinking` | 3 dots cycling (`...`) at +2 above head |
| `blocked` | Pulsing `!` mark (coral), 2-frame blink |
| `success` | Sparkle (4-frame star burst) |
| `attention` | Wave hand (drawn into right-arm slot, 2-frame loop) |
| `ghost` | Sprite opacity 50%, no overlay |

### 8.7 Movement

- Speed: 80 px / sec when walking.
- Pathing: A* on a 32 × 32 px tile grid. For MVP: simple lerp toward target tile center.
- Bob: `y += sin(t * 8π) * 1` while walking; `0` while standing.

### 8.8 Carrying artifacts

When walking back from a station after a tool result, the avatar carries a **token** above its hands:

| Tool | Token |
|---|---|
| `Read` / `Edit` / `Write` | 6 × 8 px folded paper (cream-50 + ink-700 outline) |
| `Bash` | 6 × 6 px terminal `>_` (ink-900 fill) |
| `WebFetch` / `WebSearch` | 6 × 6 px globe (sky + mint) |
| `Grep` / `Glob` | 6 × 6 px magnifier (ink-900 + cream-50) |
| MCP tool | 6 × 6 px diamond in MCP server's color |
| `TodoWrite` | 6 × 8 px checklist sprite |

Token is dropped onto desk on arrival (3-frame fade).

---

## 9. Stations (the workshop)

Stations are 64 × 64 px structures placed inside each room.

### 9.1 Catalog

| Station | Purpose | Visual |
|---|---|---|
| **Desk** | Per-avatar home | 32 × 32 wooden desk with mini laptop, chair |
| **File shelf** | Read/Edit/Write | 64 × 48 bookshelf, 3 rows of 4 books each in random palette |
| **Terminal station** | Bash | 32 × 48 CRT monitor on a table, blinking caret |
| **Web portal** | WebFetch/Search | 48 × 48 archway, lilac swirl gradient (animated) |
| **MCP corner** | Any `mcp__*` | 48 × 48 modular shelf; mini-icon per MCP server placed on it |
| **Task board** | TodoWrite | 32 × 48 corkboard with sticky notes (3-color rotation) |
| **Mailbox** | Notification | 16 × 24 pole mailbox; flag UP when notification pending |

### 9.2 Station states

Each station has 3 states:

1. **Idle** — static sprite
2. **In use** — 2-frame animation, +sparkle particles around it
3. **Highlighted** — when hovered or when its avatar is approaching (1 px white outline added)

### 9.3 Placement

Within a room (a project), stations are arranged in a fixed pattern:

```
┌───── project: <name> ──────────────┐
│  [shelf]    [terminal]    [web]    │
│                                     │
│              · · · ·                │ ← pathways (path color tiles)
│                                     │
│  [desks of agents in this project]  │
│                                     │
│  [board]    [mailbox]    [mcp]     │
└────────────────────────────────────┘
```

Room min size: 480 × 320 px. Room grows to fit number of agents (extra desk row every 4 agents).

---

## 10. Iconography

16 × 16 px pixel icons. 2 colors max (ink + accent). All icons hand-crafted.

**The ink path is `currentColor`, not `ink-900`.** `b158c29` changed it: an icon
that hardcoded `var(--cth-ink-900)` went invisible on any inverted surface, because
a `primary` PixelButton fills itself with that same token — so the arrow on Send
disappeared in *both* themes whenever the button was enabled. `currentColor` is a
no-op everywhere else, since `body` already sets ink-900 as its color.

### 10.1 Required icon set

| Name | Use | Accent |
|---|---|---|
| `gear` | Configure | ink-300 |
| `plus` | Add | mint |
| `x` | Close / cancel | coral |
| `check` | Confirm | mint |
| `arrow-right` | Send / next | sky |
| `pause` | Stop / pause | lemon |
| `play` | Resume | mint |
| `bell` | Notification | peach |
| `folder` | Project | lemon |
| `terminal` | Terminal | mint |
| `code` | File / code | sky |
| `web` | Web tool | lilac |
| `mcp` | MCP server | lilac |
| `sparkle` | Success | lemon |
| `expand` | Enter fullscreen | sky |
| `minimize` | Exit fullscreen | sky |
| `clock` | Schedules / cadence | lemon |
| `mic` | Voice | coral |
| `ledger` | Trigger history (`9f44125`) | lemon |
| `info` | Explain a setup step (`b158c29`) | sky |
| `sidebar` | Collapse / expand a rail (`b158c29`) | ink-300 |
| `pin` | Pinned — never vacation-eligible (`4e6d3c5`) | ink-900 |
| `pin-outline` | Unpinned, quiet until hover (`4e6d3c5`) | ink-300 |
| `detach` | Detach the pane to a kitty window (`888f9e4`) | sky |

`expand`, `minimize`, `clock` and `mic` predate 2026-08-04 and were never listed
here. `IconName` in `Icon.tsx` is the authoritative union.

### 10.2 Implementation

Icons live as inline SVG `<svg viewBox="0 0 16 16">` components, all paths drawn at integer coordinates. `image-rendering: pixelated`. Scale via `transform: scale(N)` integer only.

---

## 11. Terminal (xterm.js) theme

There are now **two palettes, and they are not the app's accent palette.**
`lightTheme` and `darkTheme` live side by side in
`components/PtyTerminalView.tsx:54` and `:82`, keyed by `PtyTheme`. Read them there
rather than from a copy here — reproducing 40 hexes in a doc is what made this
section wrong in the first place.

**The terminal palette is its own state** (`918a5ea`). The v0.3.4 ☾ coupled
everything, so terminals could only go dark with the whole app; the pre-0.3.4
`cth.ptyTheme` key was revived, a `▤` button in the title bar flips only the
terminals, and the xterm palettes, the fullscreen ☾ and the per-session Claude TUI
theme all follow it. Unset means *follow the app theme*, so existing setups behave
exactly as before until someone toggles.

Two constraints explain why the ANSI entries look nothing like §3.3:

- **A terminal color is text and background at once**, and no single luminance
  satisfies both. The light set is tuned to read as text on cream: green has been a
  deep `#20904B` and yellow a deep `#9C6B00` since `1ee25e8` (2026-06-06), and the
  light red has differed from the accent palette since inception — which is why the
  hex block this section used to reproduce had already been wrong for months. For
  red, green, yellow and blue the bright variants are the *lighter* shades, per
  terminal convention; `white` inverts, because default "white" terminal text still
  has to be visible on cream — it is a dark `#3A2F44`, with `brightWhite` darker
  still at `#1A1320`. `terminalPool` additionally sets xterm's
  `minimumContrastRatio` so the per-cell foreground is nudged at render time;
  `3864c50` exposes that as a DevTools-only handle (`window.__cthTermDebug`) for
  diagnosing flicker and blur, inert until called.
- **The dark set matches the app's dark surface ramp**, not the light terminal
  (`51ec611`): background `#1D1C21`, the same value as `--cth-paper-100` under
  `data-cth-theme="dark"`. Hues stay recognizable without fluorescing on the dark
  ground, and brights are one legible step up rather than pastels.

`51ec611` softened the light cursor from `#FF6B6B` to `#D96A62` with the rest of
the accent recalibration.

Font: `JetBrains Mono`, default **12 px** (`DEFAULT_TERMINAL_FONT_SIZE`, taken down
from 14 by `3c2b6d1`; a persisted user zoom still wins), line-height 1.0. The
line-height stays exactly 1.0 so TUI box-drawing characters stay joined.

---

## 12. Motion

### 12.1 Durations

| Type | ms | Easing |
|---|---|---|
| UI snap-in (modal, drawer) | 200 | cubic-bezier(.2, .8, .2, 1) |
| Hover state | 0 | none — instant |
| Button press | 0 | none — instant translate |
| Toast slide | 200 | cubic-bezier(.2, .8, .2, 1) |
| Sprite walk | continuous | sin-wave bob @ 8 fps |
| Sprite frame | 125 ms each | step (no easing) |
| Avatar teleport (room change) | 400 | step — fade-out, move, fade-in |

### 12.2 Forbidden motion
- No spring physics on UI.
- No bouncing.
- No parallax.
- No ambient idle animations on static UI panels.

Animation belongs to the **game layer** (avatars, stations, particles). The UI layer is largely still.

### 12.3 Particles

Used sparingly:

- **Sparkle** on task complete: 4 pixel stars burst out from desk, 250 ms total
- **Dust** when an avatar lands at a station: 3 pixel dots arc out, gravity-influenced, 300 ms
- **Pulse** on mailbox flag: every 800 ms, 1-frame `+1 px scale` on the flag

### 12.4 When the floor may animate

Three rules the office floor learned the hard way in this period.

- **Choreography must never move a busy agent.** `34958c5` made card transitions
  choreographed — every new card walked god to the board, every todo→doing walked
  the assignee — and a dispatch fan-out then marched god plus every assignee to the
  board stands at once, leaving all the desks dark while those agents were in fact
  working. The statuses were correct; the theatre had taken the bodies. `2672efc`
  added `canChoreograph()`: only `idle`, `waiting` and `success` actors walk, and a
  busy agent gets the instant board update instead. This is the boundary on
  principle 4 — the walk may only *report* status, never overwrite it.
- **Leaving is an animation, not a disappearance.** The floor renders from the
  roster, so a park, fire or archive used to despawn the sprite the instant the
  backend acted. `7693d83` added a ghost queue: the departing sprite raises a
  thought bubble and walks out through the entrance, with a 20 s hard expiry so a
  blocked path cannot strand it. Ghosts are scene-local, so a reload cannot strand
  them either.
- **A floor nobody is looking at does not render.** A fullscreen terminal or a
  hidden window covers the office completely, and the Pixi ticker used to animate
  the whole scene into pixels nobody could see — the app's largest continuous cost
  on a floor of twenty. `b95d2fd` stops the *ticker* rather than unmounting, so the
  WebGL context and scene graph survive and returning is instant. This works only
  because nothing in the scene reads wall-clock time: every update is driven by the
  ticker's own delta, so a paused floor resumes exactly where it stopped. **New
  scene code must keep that property** or pausing will skip it forward.

---

## 13. Sound (deferred — spec only)

8-bit SFX in this order of priority:

1. `agent-arrives.wav` — bloop on station arrival
2. `task-complete.wav` — 3-note major-third jingle
3. `notification.wav` — single chime
4. `button-press.wav` — soft click
5. `error.wav` — descending buzz
6. `mailbox-flag.wav` — flag-up clack

All sounds capped at 200 ms, mono, 22 kHz. Off by default; user can enable in preferences.

---

## 14. Voice & copy

### Tone
Friendly, brief, factual. Imagine an Animal Crossing villager who happens to be technically literate.

### Examples (do / don't)

| Don't | Do |
|---|---|
| "Agent is currently performing a Read operation on SPEC.md" | "Ada is reading SPEC.md" |
| "An error has occurred" | "Ada hit a snag" |
| "The agent has completed the task" | "Ada is done!" |
| "Permission denied" | "Ada needs your permission" |
| "Confirm operation" | "Sure?" |
| "Loading..." | "One sec..." |

### Always
- Use the avatar's name. Never "the agent."
- Keep system feedback under 12 words.
- Use second person to the user ("Ada needs you to take a look").

### Never
- Emojis in copy. We have icons.
- Exclamation marks except for completions and notifications.
- Apostrophe-free contractions ("dont"). Use proper punctuation.

---

## 15. Layout templates

### 15.1 Main view

```
┌─────────────────────── App title bar (display-md) ──────────────────────┐
├──────────────────────────────────────────┬─────────────────────────────┤
│                                          │                             │
│           Floor canvas (Pixi)            │     Selected agent panel    │
│           — fills remaining width        │     — 360 px wide           │
│                                          │     - portrait + name       │
│                                          │     - terminal view         │
│                                          │     - command bar           │
│                                          │     - status badge          │
│                                          │                             │
├──────────────────────────────────────────┴─────────────────────────────┤
│  Agent strip — horizontal scroll of <AgentCard>s, 80 px tall            │
└─────────────────────────────────────────────────────────────────────────┘
```

Min window: 1280 × 800. Right panel collapses below 1024 to bottom drawer.

### 15.2 Z-index layers

| Layer | z | Contents |
|---|---|---|
| 0 | floor canvas |
| 1 | UI chrome (panels, strip) |
| 2 | drawer / sidebar |
| 3 | toasts |
| 4 | modals |
| 5 | tooltips |

> ⚠ **VERIFY:** Is this 0–5 scale still the real stacking order? Commits in the
> 2026-08-04 → 2026-08-21 range quote three-digit values for these same layers —
> `701e2a9` states the IDE overlay sits at **z 290** and fullscreen at **250**.
> The ordering may be intact with the numbers rescaled, or the layers may have
> multiplied. No commit
> in this range records a decision to change the scale. Checked: the commit
> messages only, not a sweep of `z-index` in `src/renderer/src/`.
> (raised 2026-08-21)

---

## 16. Token files

All tokens live in `src/renderer/src/design/`:

- `tokens.css` — CSS custom properties for any styled element. Declares the light
  ramp under `:root` and the dark ramp under `:root[data-cth-theme="dark"]`.
- `tokens.ts` — TypeScript objects for Pixi.js and inline styles.
- `theme.ts` — the subscribable switch (`5510818`): persists `cth.theme`, migrates
  the older `cth.ptyTheme` key, and stamps `data-cth-theme` on `<html>`.

There is still no build-time `tokens.json`; the files are hand-kept in sync, and
both carry a header comment saying so.

Three display-logic helpers claimed in the coverage-gap round (2026-08-22),
each with its rationale in its own header docstring: `src/renderer/src/statusText.ts`
(the status-text sanitiser feeding the labels this doc's copy rules govern —
sibling of the covered `statusLabel.ts`); `src/shared/agentOrder.ts` (the ONE
display order for grouped agent lists — god pinned first, by the operator's
call); `src/shared/settingsHero.ts` (the Settings hero card's field logic; the
card shape is ported from upstream `1b821b3` by intent).

**`tokens.ts` has no dark ramp.** `5510818` added the dark block to `tokens.css`
and `theme.ts` only, so every Pixi consumer of `tokens.ts` — the office floor,
its sprites and its tiles — renders the light values in both themes. That is the
floor's intended look (cream is the brand, §18.2), but it means a value copied
from `tokens.ts` into a CSS-styled component silently loses dark mode.

---

## 17. Accessibility notes

- The 14 px floor was a **pixel-font** floor, and pixel fonts no longer carry body
  text. `51ec611` moved UI text to Inter and code to JetBrains Mono, both of which
  read larger than Pixelify at equal px, and `3c2b6d1` took the ramp one step down
  on that reasoning: `body-sm` and `mono-sm` are now 13 px, the component sweep put
  UI text at 12–13 px, and `.cth-md-preview code` sets 12.5 px (the markdown
  preview body itself stays at 14 px). Press Start 2P is
  still never used below its display sizes.
- Color contrast: every text/background pair in this doc passed WCAG AA (4.5:1)
  **in light mode**, which is the only theme that existed when it was written.
  Dark mode (`5510818`) doubled every pair, and `b158c29` found two that had
  collapsed — a disabled `primary` button at roughly 1.4:1, and `Icon`'s hardcoded
  ink on inverted surfaces. Re-check both themes when adding a pair, and read
  tokens rather than hexes so the pair flips together.
- Status is communicated via **color + icon + position** (avatar location). Never color alone.
- Keyboard navigation: every interactive UI element reachable via Tab; focus state is the 2 px outline (§7.2).
- Reduced motion: when `prefers-reduced-motion: reduce`, sprite bob disabled and walks become instant teleports. Particles disabled.

---

## 18. Open design decisions (revisit)

1. Whether to commission custom sprite art vs continuing programmatic sprites long-term.
2. ~~Dark mode: not in v1~~ — **decided and shipped.** `5510818` darkens the whole
   app through one token swap, and `918a5ea` then gave the terminal palette its own
   independent switch. The cream-brand argument survived where it mattered: the
   Pixi floor still renders the light ramp (§16), so the pixel art keeps its
   backgrounds in both themes.
3. Resizable rooms vs fixed grid — currently spec'd fixed; may want to drag-resize rooms.
4. Whether to add ambient floor decorations (flowers, rugs) — yes, low-priority polish.
5. Custom mouse cursor (pixel-style hand) — defer.
