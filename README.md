# dsh-image-tiler

[English](README.md) | [简体中文](README.zh-CN.md)

[![version](https://img.shields.io/badge/version-0.1.6-4176E6)](https://github.com/Ssrs-Pro-Max/dsh-image-tiler)
[![npm](https://img.shields.io/npm/v/dsh-image-tiler?label=npm)](https://www.npmjs.com/package/dsh-image-tiler)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![dsh](https://img.shields.io/badge/DeepSeek%20Harness-dsh--plugin-4176E6)](https://github.com/deepseek-ai/deepseek-harness)
[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

> Upload a screenshot, a photographed document, or a long comic page and the model reads the small
> text in it. Without this plugin it does not: one request image carries at most 1024 vision tokens,
> so the harness rescales anything larger before the model sees it, and an 8000x8000 screenshot
> arrives as a ~1300px-wide picture with the text already gone.
>
> This is **not** an official DeepSeek product and does not imply DeepSeek endorsement.

## What it does

The plugin replaces the attachment store's admission step. When a prompt carries an image too large
to survive the harness' own downscaling, it cuts the image into adjacent regions and submits each
region as its own image, in the same message. Every region is then transmitted at its own
resolution, so the model sees the source at the resolution it was uploaded at instead of at the
resolution one image can hold.

Measured on a real boot (DSH 0.2.0-rc.2, desktop host, an 8000x8000 PNG of small text):

| | as one image | tiled (default settings) |
| --- | --- | --- |
| what the model receives | 2048x2048, re-encoded | 20 regions of 2000x1600, one per image part |
| glyph height in the image | 10 px in the source, unreadable after scaling | 10 px, unchanged |
| text rows the model can resolve | 0 | 8 |
| contrast in the text band | 11.2 | 29.7 |

Small images are not touched: anything the provider would transmit as-is is admitted exactly as
before, so ordinary screenshots keep their current path.

## Compatibility

- DeepSeek Harness `>=0.2.0-rc.1 <0.3.0` (declared in `engines.dsh`, and as `peerDependencies` on
  `@deepseek-ai/dsh-attachment` / `-attachment-local`; verified against `0.2.0-rc.2`). The range
  covers the whole `0.2.x` line, prereleases included, so a harness patch or rc bump does not
  disable the plugin.
- Node.js 20 or newer (the host's own requirement).
- Status: **experimental**. The tiling policy is verified, but the plugin replaces a core service,
  so treat a version bump of the harness as a reason to re-check it.
- `sharp` is bundled as a dependency. The plugin ships no prebuilt binaries of its own; pnpm
  installs `sharp`'s platform package for your machine as usual.

## Install

### From npm (recommended)

```
dsh plugin --profile web add dsh-image-tiler@0.1.6
```

Two different versions matter here, and mixing them up is the usual mistake. Pin the **plugin** version
(`@0.1.6`): that is what keeps the install reproducible. Do **not** pin the harness: this package
accepts any harness `0.2.x`, prereleases included, so a harness patch or rc bump does not disable it.
A harness the plugin cannot work with is refused before pnpm runs —
`dsh: installation rejected: Plugin <name>@<version> is incompatible with dsh <version>` — and
`dsh plugin allow-version` exists to override that by hand if you are testing an unreleased harness.

### Desktop profile, by hand

Add the dependency and the bundle to `~/.dsh/profiles/desktop/package.json`, then install and
restart the app from the tray:

```json
{
  "dependencies": { "dsh-image-tiler": "0.1.6" },
  "dsh": { "profile": { "bundles": ["...", "dsh-image-tiler"] } }
}
```

### Verify the install

Send any image larger than roughly 1500x1500 and watch the host log:

```
image-tiler: 8000x8000 shown as 20 tiles of up to 2000x1600 (20.4x detail, 54% covered)
```

The number of image attachments in the message is what changed: one upload becomes N parts.

### Update / Uninstall

```
dsh plugin --profile web add dsh-image-tiler@0.1.6
dsh plugin --profile web remove dsh-image-tiler
```

## Configuration

The plugin adds no settings of its own. It is the store, so the only block it reads is the one the
official `attachment-local` row already accepts:

```yaml
- id: attachment-local
  disabled: true          # the plugin serves `attachments` in its place

- insert:
    - id: image-tiler
      name: dsh-image-tiler
```

Every key of the official `attachment-local` row still applies, unchanged: `dshHome`,
`maxImageBytes`, `maxImagesPerMessage`, `maxMessageImageBytes`, `maxImagePixels`,
`maxImageDimension`, `normalizedImageMaxPixels`, `normalizedImageMaxDimension`,
`normalizedImageMaxBytes`, `imageCompressionConcurrency`.

Two of them decide what the tiler can do:

| key | default | effect on tiling |
| --- | --- | --- |
| `maxImagesPerMessage` | `20` | The tiling budget, shared evenly by the images in one message. A single 8000x8000 upload is spent as 20 tiles of 2000x1600 (20.4x the detail of the single downscaled image); three uploads in one message get 6 tiles each (about 15.5x) so no image is left behind at the provider's print. Lowering it makes each piece larger and *less* readable, because a piece bigger than `normalizedImageMaxPixels` is downscaled after the crop. |
| `normalizedImageMaxPixels` | `4194304` | The ceiling on one published image. The planner is told this number and keeps every piece under it, so no piece is downscaled after being cut. |
| `maxImageBytes` | `20971520` | The ceiling on one stored image. A tile bigger than this would make the store refuse the whole message, so the tiler measures every tile and sends the source whole if one of them is over. In practice a piece lands far below it: PNG is lossless, so even photographic tiles stay in single-digit megabytes. |

The row also has to be reachable: if the profile already raises the global image ceiling for huge
uploads, keep those values. The plugin does not change them, and a source the store refuses never
reaches the tiler.

## Security posture

- No telemetry, no network access, no credentials handling, no background service.
- No `prepare`, `install`, or `postinstall` scripts; the package contains JavaScript, YAML, and text.
- No child processes. Nothing is spawned or executed; `sharp` runs in-process through its native
  binding.
- Images are decoded and re-encoded in memory. Tiles are written by the harness' own attachment
  store, to the same place the original image would have gone, and nothing is written anywhere else.
- The only files the plugin reads are the ones the store hands it.

## How it works

1. `apply(ctx, config)` mounts `TilingAttachmentStore` under the `attachments` service name, so it
   replaces the official `attachment-local` store while extending it. Storage, admission limits,
   normalization, and reads all stay the base implementation's.
2. `admitPromptContent(content)` is the single call the session controller makes before it appends a
   user message. The override plans a tile layout for each image part, crops the source with
   `sharp`, and returns the tiles as image parts.
3. Because the replacement happens before admission, the tiled images become part of the stored
   session message itself. Replay, resume, and fork rebuild exactly what the model originally saw.
4. The layout comes from `lib/geometry.js`, which transcribes the provider's own image projection
   (patch/downsample grid, 1024-token budget) and picks the grid whose regions land closest to 1:1
   with what the provider would otherwise have sent. A source the provider already transmits
   unchanged yields exactly one tile, which is why small images keep their old path.
5. The whole batch is checked against the store's own limits before admission — piece count, each
   piece's stored size, and the total. If it does not fit, or if any tile would be a sliver, the
   original image is sent instead and the reason is logged. A plugin that tiled badly must never
   cost the user their picture, and the store refuses a whole message over one oversized member.

## Development

```
node test/geometry.test.mjs        # tile geometry invariants, no test runner needed
node test/admission.test.mjs       # prompt admission: budgets, fallbacks, part order
node test/_cap-table.mjs           # layout table for each tile cap
node test/feasibility.mjs          # legibility measurements on a generated fixture
```

`test/` is not part of the published package.

## Known limitations

- **A tiled upload costs more vision tokens than a single image.** Cutting one source into N pieces
  sends N images; that is the point, but a 20-tile upload is a much larger request than a 1-image
  upload.
- **Tile size is capped by the store's normalization policy.** A tile larger than
  `normalizedImageMaxPixels` (4194304, i.e. about 2048x2048) is downscaled after the crop, which is
  why the planner fills the whole `maxImagesPerMessage` budget (20 by default) instead of using a
  few big pieces.
- **The piece count follows `maxImagesPerMessage`, so a lower value gives worse tiles.** With the
  budget lowered to 6, an 8000x8000 source becomes five 4579x915 strips: complete and clear, but not
  the shape a reader would pick. The default of `20` produces the squarest layout.
- **Several large uploads in one message share the budget.** Ten images at once leave two pieces
  each, below the four a layout needs to divide a source rather than shave it, so they are sent at
  the provider's print. Send large images one or two at a time when their detail matters.
- **Tiles are whole regions, not overlapping pages.** A glyph on a seam is cut in half, and neither
  neighbouring tile shows it whole.
- **Only the inline image path is tiled.** Files attached as documents, and images that arrive
  through other tools, are not.
- The plugin was verified against `0.2.0-rc.2` on Windows. Other platforms are untested.

## License

MIT — see [LICENSE](LICENSE).
