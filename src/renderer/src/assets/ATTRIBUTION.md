# Asset attribution

The office tileset/map and base character walk sheets in this directory are vendored from
[`shahar061/the-office`](https://github.com/shahar061/the-office) (project code: ISC).

## Pixel art — LimeZu (IMPORTANT: non-commercial license)

The tilesets (`tilesets/*.png`) and the base character sheets used as recolor sources
(`characters/{Adam,Alex,Amelia,Bob}_walk.png`) are LimeZu pixel-art assets, distributed under
the **LimeZu FREE VERSION license** (see `tilesets/LIMEZUASSETS-LICENSE.txt`):

- ✅ May be used **and edited** (we recolor them into the Office cast) — **in non-commercial projects only**.
- ❌ May **not** be used or edited in commercial projects, and may not be resold.

This project (Munder Difflin) is a personal, non-commercial project, which is compatible
with that license. **If this project is ever commercialized, these assets must be replaced or a
paid LimeZu license obtained.** The recolored Office-cast sprites are derived edits of these base
sheets and inherit the same restriction.

## Pixel art — LimeZu PAID full versions (commercial use OK)

The operator has purchased the full LimeZu packs; the specific sheets the app uses are
vendored here (never the raw bundle folders — the paid license forbids redistribution):

- `tilesets/modern-office-revamped.png` — **Modern Office Revamped v1.2** (`Modern_Office_16x16.png`)
- `tilesets/room-builder-office.png` — its **Room Builder Office** sheet (`Room_Builder_Office_16x16.png`)

Both are used by the `custom` office theme (card agent-harness-custom-office-th-2026-08-17)
as extra paintable atlases. Their license (see the pack's `LICENSE.txt`): use and edit in any
commercial or non-commercial project; no reselling or redistributing the asset itself;
**credit: [limezu.itch.io](https://limezu.itch.io)** — credits appreciated. Commercial use of
these two sheets is OK; the FREE-version sheets above remain non-commercial-only.

## Tiled map

`maps/office.tmj` / `maps/lobby.tmj` are Tiled JSON maps from the same repo, built on the LimeZu
tilesets above. `maps/custom.tmj` is the operator's editable clone of `office.tmj` (same gid
space; the purchased atlases are appended at firstgid 2449/3297 for painting in Tiled).
