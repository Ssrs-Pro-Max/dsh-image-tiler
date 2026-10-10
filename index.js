/**
 * Image Tiler — shows oversized images at a resolution the model can read.
 *
 * Why this exists: one request image carries at most 1024 vision tokens, so the
 * route rescales anything larger before the model sees it. A screenshot, a
 * photographed document, or a long comic page therefore reaches the model as a
 * ~1300px-wide picture no matter how many pixels were uploaded, and the text in
 * it is gone. This plugin cuts such an image into adjacent regions and submits
 * each region as its own image, so every region is transmitted at its own
 * resolution and small text survives.
 *
 * Where it hooks in: `ctx.attachments.admitPromptContent`, the one call the
 * session controller makes before it appends a user message. Replacing the
 * stored image there is what makes the tiled images part of the session log
 * itself, so replay, resume, and fork all rebuild the same message the model
 * originally saw.
 *
 * @module dsh-image-tiler
 */
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local';
import { planTiles } from './lib/geometry.js';

/** Media type of the bytes this plugin publishes. */
const TILE_MEDIA_TYPE = 'image/png';

/**
 * Shortest tile edge worth showing, in source pixels.
 *
 * Below this a region cannot carry a readable word: at eight source pixels per
 * character — already unreadable — a tile this narrow fits about two of them. A
 * layout that produces such a sliver has stopped dividing the source and started
 * shaving it, which is what happens when the tile cap is low enough that the
 * planner trades the far edge for one oversized region.
 */
const MIN_TILE_SPAN = 64;

/**
 * Fewest tiles worth spending a message's image budget on.
 *
 * Below four, the planner stops looking like a division of the source and turns
 * into strips: two or three regions leave one whole axis at the provider's
 * print, and the detail the user paid for is only bought along the other one.
 * A budget that small is better spent showing the picture the user sent.
 */
const MIN_TILES = 4;

/**
 * Bytes the store will measure for a part this plugin did not replace.
 *
 * The store decodes every member of a batch, so an image the tiler leaves alone
 * still counts against the message's aggregate byte budget at its decoded size.
 * `data` is canonical base64 on the wire, which makes the decoded length exact.
 */
function storedBytes(part) {
  const data = typeof part?.data === 'string' ? part.data : '';
  return Math.floor(data.length / 4) * 3;
}

/**
 * Whether a layout really shows the whole source.
 *
 * The planner aims for equal regions that tile the source exactly once, so a
 * layout that does not is a bug rather than a preference: it would either drop
 * source pixels (a sliver cannot hold the content it was allocated) or show them
 * twice, and the user cannot tell which happened from the tiles alone.
 */
function planIsUsable(plan) {
  return plan.tiles.every((tile) => tile.width >= MIN_TILE_SPAN && tile.height >= MIN_TILE_SPAN);
}

/**
 * Load the raster cropper/encoder.
 *
 * `sharp` is imported on first use rather than at module scope so a host
 * without a working binary still boots: an ordinary conversation never needs
 * it, and a plugin that cannot load stops the whole harness.
 */
function loadSharp() {
  return import('sharp').then((module) => module.default ?? module);
}

/** Name one tile after the image it came from, keeping the extension. */
function tileName(name, index, total) {
  const stem = typeof name === 'string' && name !== '' ? name : 'image';
  const dot = stem.lastIndexOf('.');
  const base = dot > 0 ? stem.slice(0, dot) : stem;
  const extension = dot > 0 ? stem.slice(dot) : '';
  return `${base}#${index + 1} of ${total}${extension}`;
}

/**
 * Cut one encoded image into the regions the planner chose.
 *
 * @param input - `{ data, mediaType, name }` as the prompt carried it.
 * @param options - tiling limits.
 * @returns `{ plan, tiles, sizes }` with the replacement image inputs and their
 * exact stored byte counts, or `undefined` when this image is better left alone.
 */
async function tileImage(input, options) {
  const warn = options.warn;
  const sharp = await loadSharp();
  // `input.data` is canonical base64 on the wire, so it is decoded here rather
  // than handed to the decoder as text.
  const image = sharp(Buffer.from(input.data, 'base64'), { failOn: 'none' });
  const metadata = await image.metadata();
  const width = Number(metadata.width ?? 0);
  const height = Number(metadata.height ?? 0);
  if (width < 1 || height < 1) return undefined;
  const plan = planTiles({
    width,
    height,
    maxTiles: options.maxTiles,
    bounds: options.bounds,
  });
  if (plan.tiles.length < 2 || plan.tiles.length > options.maxTiles) return undefined;
  if (!planIsUsable(plan)) {
    // A layout with a sliver in it is worse than no layout at all: some glyphs
    // would be unreadable everywhere. Leaving the source whole keeps the
    // failure mode the user already knows, and the log says why.
    warn?.('image-tiler: ignoring a %d-tile layout for %dx%d; keeping the source whole', plan.tiles.length, width, height);
    return undefined;
  }
  const tiles = [];
  const sizes = [];
  for (const [index, region] of plan.tiles.entries()) {
    const data = await image
      .clone()
      .extract({ left: region.x, top: region.y, width: region.width, height: region.height })
      .png()
      .toBuffer();
    // One region is never bigger than the picture it came from, and the picture
    // was already accepted, so a region this large is refused by the store for
    // the very same reason. Measuring it here is what keeps that refusal from
    // costing the whole prompt.
    if (data.byteLength > options.maxImageBytes) {
      warn?.(
        'image-tiler: a %dx%d tile would be %d bytes, over the %d-byte image limit; keeping the source whole',
        region.width,
        region.height,
        data.byteLength,
        options.maxImageBytes,
      );
      return undefined;
    }
    // The wire contract is canonical base64, not raw bytes: the shared
    // admission path decodes every image part with `Buffer.from(data, 'base64')`
    // and refuses the batch when re-encoding does not reproduce the string.
    tiles.push({
      // The part type is what tells the admission path this is an image; a tile
      // without it is treated as a file reference and is dropped for good.
      type: 'image',
      data: data.toString('base64'),
      mediaType: TILE_MEDIA_TYPE,
      name: tileName(input.name, index, plan.tiles.length),
    });
    sizes.push(data.byteLength);
  }
  return { plan, tiles, sizes };
}

/**
 * Clamp one decoded tile batch to the store's own admission limits.
 *
 * Tiling multiplies a message's image count and its total bytes, and the store
 * refuses the whole prompt when either limit is exceeded — and it asks every
 * member of the batch for its own byte count first, so one oversized tile is
 * enough to lose the message. Sending an unreadable image is a smaller failure
 * than sending no prompt at all, so an over-budget group is dropped back to the
 * pieces it replaced.
 */
function withinLimits(pieces, limits) {
  let count = 0;
  let bytes = 0;
  for (const piece of pieces) {
    if (piece.sizes.some((size) => size > limits.maxImageBytes)) return false;
    count += piece.sizes.length;
    for (const size of piece.sizes) bytes += size;
  }
  return count <= limits.maxImagesPerMessage && bytes <= limits.maxMessageImageBytes;
}

export class TilingAttachmentStore extends LocalAttachmentStore {
  constructor(ctx, config) {
    // The base store owns storage, admission limits, normalization, and reads;
    // only the admission of a prompt is replaced, so everything a stored
    // reference promises about itself stays true.
    //
    // The plugin declares no configuration of its own. It used to, but the keys
    // only arrived when the host happened to keep the base store's schema alive
    // under them, and a key that silently does nothing is worse than no key at
    // all. Everything below is derived from what the store itself reports.
    super(ctx, config);
  }

  /**
   * The per-image ceiling the store publishes at full resolution.
   *
   * A region larger than the normalization policy is downscaled after the
   * crop, which would undo the tiling between the crop and the model, so the
   * planner is told the same ceiling the store enforces.
   */
  get tilerBounds() {
    const policy = this.normalizationPolicy ?? {};
    return {
      maxPixels: policy.maxPixels ?? 0,
      maxDimension: policy.maxDimension ?? 0,
    };
  }

  /**
   * The admission limits a tiled batch has to fit inside.
   *
   * Tiling spends one image's share of the message budget on several pieces of
   * the same source, so the count limit is the binding one and is reported
   * separately from its configured ceiling.
   */
  get tilerLimits() {
    // Tiling may never widen what the store would have accepted: every limit is
    // exactly the store's own number.
    return { ...this.imageLimits };
  }

  async admitPromptContent(content) {
    const imageParts = content.filter((part) => part.type === 'image');
    if (imageParts.length === 0) return super.admitPromptContent(content);
    const limits = this.tilerLimits;
    // One message may carry at most `maxImagesPerMessage` images, and tiling
    // spends that budget on regions of a single source. Every image in the
    // message shares it evenly: tiling one image to the ceiling would leave the
    // others at the provider's print, so the pictures the user sent together
    // would arrive at wildly different resolutions. A budget too small to split
    // an image at all leaves the whole message untiled, which is the state the
    // user already knows.
    const budget = Math.max(1, Math.floor(Math.max(1, limits.maxImagesPerMessage) / imageParts.length));
    if (budget < MIN_TILES) {
      this.ctx.logger?.info(
        'image-tiler: %d images leave no room to tile inside a %d-image message; showing them as sent',
        imageParts.length,
        limits.maxImagesPerMessage,
      );
      return super.admitPromptContent(content);
    }
    const options = {
      maxTiles: budget,
      bounds: this.tilerBounds,
      maxImageBytes: limits.maxImageBytes,
      warn: (message, ...args) => this.ctx.logger?.warn(message, ...args),
    };
    const pieces = [];
    let tiled = 0;
    for (const part of content) {
      if (part.type !== 'image') {
        // Text and durable file references cost no image budget and pass
        // through untouched, in place.
        pieces.push({ group: [part], sizes: [], tiled: false });
        continue;
      }
      let group;
      let sizes;
      let tiledThisImage = false;
      try {
        const result = await tileImage(part, options);
        if (result === undefined) {
          group = [part];
          sizes = [storedBytes(part)];
        } else {
          group = result.tiles;
          sizes = result.sizes;
          tiledThisImage = true;
        }
        if (result !== undefined) {
          tiled += 1;
          this.ctx.logger?.info(
            'image-tiler: %dx%d shown as %d tiles of up to %dx%d (%sx detail, %s%% covered)',
            result.plan.source.width,
            result.plan.source.height,
            result.tiles.length,
            result.plan.tile.width,
            result.plan.tile.height,
            result.plan.zoom.toFixed(1),
            (result.plan.coverage * 100).toFixed(0),
          );
        }
      } catch (error) {
        // A crop that fails must not cost the user their prompt: the original
        // image is still a legal submission, so report and fall back to it.
        this.ctx.logger?.warn('image-tiler: leaving an image untiled: %s', error?.message ?? error);
        group = [part];
        sizes = [storedBytes(part)];
      }
      pieces.push({ group, sizes, tiled: tiledThisImage });
    }
    if (tiled === 0 || !withinLimits(pieces, limits)) {
      if (tiled > 0) {
        this.ctx.logger?.warn(
          'image-tiler: %d tiles would exceed the image limits of this store; sending the original image',
          pieces.reduce((sum, piece) => sum + piece.sizes.length, 0),
        );
      }
      return super.admitPromptContent(content);
    }
    const flat = pieces.flatMap((piece) => piece.group);
    // The host's admission path keeps only parts that announce themselves as
    // images; anything else it rewrites into a file reference with no bytes. A
    // malformed tile would therefore cost the user the picture silently, so the
    // batch is checked here and the original image is sent instead. Only the
    // parts tiling produced are checked: the prompt's own text and file parts
    // are not images and are not supposed to be.
    const produced = pieces.reduce((sum, piece) => sum + (piece.tiled ? piece.group.length : 0), 0);
    const declared = flat.filter((part) => part.type === 'image').length;
    if (declared !== produced) {
      this.ctx.logger?.warn(
        'image-tiler: refusing %d tiles without an image part type; sending the original image',
        produced - declared,
      );
      return super.admitPromptContent(content);
    }
    return super.admitPromptContent(flat);
  }
}

/** Plugin entry point: mount the store under the `attachments` service name. */
export function apply(ctx, config) {
  return new TilingAttachmentStore(ctx, config ?? {});
}

export default apply;
