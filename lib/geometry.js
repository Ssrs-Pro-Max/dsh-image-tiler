/**
 * Tile planning arithmetic for oversized images.
 *
 * The numbers here are not invented: they are transcribed from the shipped
 * DeepSeek route so the planner and the provider cannot disagree about how
 * much of an image the model actually sees.
 *
 * Provider constants (`@deepseek-ai/dsh-llm-deepseek/lib/index.js`):
 * `PATCH_SIZE = 14`, `DOWNSAMPLE_RATIO = 3`, `MAX_IMAGE_TOKENS = 1024`,
 * `CELL_SIZE = PATCH_SIZE * DOWNSAMPLE_RATIO = 42`, and
 * `gridTokens(h, w) = h * (w + 1) + 2`.
 *
 * Practical consequence: a request image is transmitted at full resolution
 * only when `gridTokens <= 1024`, which caps a square image near 1300x1300
 * and any image at 4096px on the long edge. Anything larger is rescaled by the
 * provider before the model sees it, which is what destroys small text.
 */

/** Provider pixels per visual patch. */
export const PATCH_SIZE = 14;
/** Provider pixels per visual token cell. */
export const DOWNSAMPLE_RATIO = 3;
/** Provider vision token budget for one request image. */
export const MAX_IMAGE_TOKENS = 1024;
/** `PATCH_SIZE * DOWNSAMPLE_RATIO`: one token maps to this many pixels. */
export const CELL_SIZE = PATCH_SIZE * DOWNSAMPLE_RATIO;

const intDiv = (value, divisor) => Math.trunc(value / divisor);
const ceilDiv = (value, divisor) => Math.ceil(value / divisor);

/** Integer ceil. */
export const ceil = ceilDiv;

/**
 * Provider `gridTokens`: the token count for a patch grid, including the two
 * boundary tokens.
 *
 * @param gridHeight - patch rows.
 * @param gridWidth - patch columns.
 * @returns token count the provider charges for that grid.
 */
export function gridTokens(gridHeight, gridWidth) {
  return gridHeight * (gridWidth + 1) + 2;
}

/**
 * Provider `gridCells`: token cells along one axis for a pixel length.
 *
 * @param paddedLength - patch-aligned pixel length.
 * @returns number of token cells.
 */
export function gridCells(paddedLength) {
  return ceilDiv(intDiv(paddedLength, PATCH_SIZE), DOWNSAMPLE_RATIO);
}

/**
 * Provider `padToPatch`: round a pixel length up to whole patches.
 *
 * @param length - pixel length.
 * @returns patch-aligned length.
 */
export function padToPatch(length) {
  return ceilDiv(length, PATCH_SIZE) * PATCH_SIZE;
}

/**
 * Provider cost of one image at its own size.
 *
 * @param width - pixel width.
 * @param height - pixel height.
 * @returns token count.
 */
export function providerTokens(width, height) {
  return gridTokens(gridCells(padToPatch(height)), gridCells(padToPatch(width)));
}

/**
 * Widest single-row strip whose grid still fits the token budget.
 *
 * A strip one cell tall has `gridHeight === 1`, so `gridTokens` reduces to
 * `gridWidth + 3`, and `gridTokens <= MAX_IMAGE_TOKENS` allows
 * `gridWidth = MAX_IMAGE_TOKENS - 3` cells.
 */
export const MAX_TILE_WIDTH = (MAX_IMAGE_TOKENS - 3) * CELL_SIZE;

/**
 * Tallest single-column strip whose grid still fits the token budget.
 *
 * A strip one cell wide has `gridWidth === 1`, so `gridTokens` reduces to
 * `gridHeight * 2 + 2`, allowing `(MAX_IMAGE_TOKENS - 2) / 2` cells 鈥?half as
 * many, because a one-cell width already costs the extra token per row.
 */
export const MAX_TILE_HEIGHT = intDiv(MAX_IMAGE_TOKENS - 2, 2) * CELL_SIZE;

/**
 * Largest aspect-preserving tile box one request image can carry at full
 * provider resolution.
 *
 * The search is over provider cell counts rather than raw pixels, because cell
 * counts map to token cost exactly (`gridTokens(k, j) = k * (j + 1) + 2`) while
 * a patch-aligned pixel width can round up to one extra cell. For each width
 * the candidate is the largest in-budget height whose aspect-correct width is
 * at most that width, so the returned box is patch-aligned and in budget.
 *
 * @param aspect - source width divided by source height.
 * @returns `{ width, height, area }`, patch-aligned.
 */
export function maxTileForAspect(aspect) {
  if (!Number.isFinite(aspect) || aspect <= 0) throw new Error(`image-tiler: invalid aspect ${aspect}`);
  let best = { width: PATCH_SIZE, height: PATCH_SIZE, area: 0 };
  const consider = (width, height) => {
    const candidateWidth = Math.min(Math.floor(height * aspect), width);
    if (candidateWidth < PATCH_SIZE) return;
    // Only the height has to be patch-aligned: `padToPatch` makes the
    // provider's own column count exact for aligned lengths, while a patch
    // multiple on the width would round up to one extra token cell and make
    // every aspect below 1 miss its budget.
    if (providerTokens(candidateWidth, height) > MAX_IMAGE_TOKENS) return;
    const area = candidateWidth * height;
    if (area > best.area) best = { width: candidateWidth, height, area };
  };
  for (let width = CELL_SIZE; width <= MAX_TILE_WIDTH; width += CELL_SIZE) {
    const cellsTall = intDiv(MAX_IMAGE_TOKENS - 2, gridCells(padToPatch(width)) + 1);
    if (cellsTall >= 1) consider(width, cellsTall * CELL_SIZE);
  }
  for (let height = CELL_SIZE; height <= MAX_TILE_HEIGHT; height += CELL_SIZE) {
    const cellsWide = intDiv(MAX_IMAGE_TOKENS - 2, gridCells(padToPatch(height)) + 1) - 1;
    if (cellsWide >= 1) consider(cellsWide * CELL_SIZE, height);
  }
  if (best.area === 0) {
    for (let side = CELL_SIZE; side <= MAX_TILE_WIDTH; side += CELL_SIZE) {
      if (providerTokens(side, side) <= MAX_IMAGE_TOKENS) best = { width: side, height: side, area: side * side };
    }
  }
  return best;
}

/**
 * Provider solver: the largest aspect-preserving patch grid inside the token
 * budget. Transcribed from the shipped route so planner arithmetic and
 * provider arithmetic cannot drift.
 *
 * @param height - source pixel height.
 * @param width - source pixel width.
 * @param budget - token budget.
 * @returns `{ gridHeight, gridWidth, bestHeight, bestWidth, numTokens }`.
 */
export function solveResizeRatio(height, width, budget) {
  const aspect = height / width;
  const idealGridWidth = Math.sqrt((budget - 2) / aspect + 0.25) - 0.5;
  const idealGridHeight = idealGridWidth * aspect;
  let bestHeight;
  let bestWidth;
  if (idealGridWidth < 1) {
    const solvedGridWidth = 1;
    const solvedGridHeight = intDiv(budget - 2, 2);
    bestWidth = solvedGridWidth * CELL_SIZE;
    bestHeight = solvedGridHeight * CELL_SIZE;
  } else if (idealGridHeight < 1) {
    const solvedGridHeight = 1;
    bestWidth = (intDiv(budget - 2, solvedGridHeight) - 1) * CELL_SIZE;
    bestHeight = solvedGridHeight * CELL_SIZE;
  } else {
    const solvedGridWidth = Math.trunc(idealGridWidth);
    const solvedGridHeight = Math.trunc(idealGridHeight);
    const scale = Math.min((solvedGridWidth * CELL_SIZE) / width, (solvedGridHeight * CELL_SIZE) / height);
    bestWidth = Math.trunc((width * scale) / PATCH_SIZE) * PATCH_SIZE;
    bestHeight = Math.trunc((height * scale) / PATCH_SIZE) * PATCH_SIZE;
  }
  const gridHeight = gridCells(bestHeight);
  const gridWidth = gridCells(bestWidth);
  return { gridHeight, gridWidth, bestHeight, bestWidth, numTokens: gridTokens(gridHeight, gridWidth) };
}

/**
 * Pixel size the provider effectively shows the model for one image, before
 * its own byte-budget rescaling. `transmitted` is false when the provider
 * shrinks the image, which is exactly the case tiling exists to fix.
 *
 * @param width - source width in pixels.
 * @param height - source height in pixels.
 * @returns `{ width, height, tokens, transmitted }`.
 */
export function providerPrint(width, height) {
  const tokens = providerTokens(width, height);
  if (tokens <= MAX_IMAGE_TOKENS) return { width, height, tokens, transmitted: true };
  const solved = solveResizeRatio(height, width, MAX_IMAGE_TOKENS);
  const longEdge = width >= height ? solved.bestWidth : solved.bestHeight;
  if (longEdge >= Math.max(width, height)) return { width, height, tokens, transmitted: true };
  const scale = longEdge / Math.max(width, height);
  const printed = {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
  return { width: printed.width, height: printed.height, tokens: providerTokens(printed.width, printed.height), transmitted: false };
}

const intScale = (floorValue, base) => (floorValue <= base ? 1 : Math.floor(base / floorValue));

/**
 * Largest region inside both an allocated stride and a per-image pixel cap.
 *
 * A region equal to its stride covers every pixel exactly once, so the stride
 * is the first ceiling. The second one is the store: an image is published at
 * its own resolution only while it stays inside the host's normalization
 * policy, and a store configured with a default policy silently downscales
 * anything larger 鈥?which would undo the tiling between the crop and the
 * model. Shrinking proportionally keeps the region's shape, so a capped region
 * shows less of the source rather than a distorted part of it.
 *
 * @param stride - `{ width, height }` the region would cover at 1:1.
 * @param bounds - optional `{ maxPixels, maxDimension }` ceiling.
 * @returns `{ width, height }` inside both ceilings, at most the stride.
 */
export function fitRegion(stride, bounds) {
  const strideWidth = Math.max(1, Math.floor(stride.width));
  const strideHeight = Math.max(1, Math.floor(stride.height));
  const maxPixels = Math.floor(bounds?.maxPixels ?? 0);
  const maxDimension = Math.floor(bounds?.maxDimension ?? 0);
  let width = strideWidth;
  let height = strideHeight;
  if (maxDimension >= 1) {
    if (height > maxDimension) {
      width = Math.floor(width / intScale(height, maxDimension));
      height = maxDimension;
    }
    if (width > maxDimension) {
      height = Math.floor(height / intScale(width, maxDimension));
      width = maxDimension;
    }
  }
  if (maxPixels >= 1 && width * height > maxPixels) {
    const scale = Math.sqrt(maxPixels / (width * height));
    width = Math.max(1, Math.floor(width * scale));
    height = Math.max(1, Math.floor(height * scale));
    while (width * height > maxPixels && height > 1) height -= 1;
    while (width * height > maxPixels && width > 1) width -= 1;
  }
  return { width, height };
}

/**
 * Grid of tiles covering the source. Strides decide where each region starts and
 * how far apart the regions are, so the grid covers the source exactly once with
 * nothing left out and nothing shown twice. A region smaller than its stride is
 * a pixel-cap ceiling, not a crop: the neighbours keep their own allocations.
 * Tiles are cropped to the source edge, so the final row or column can be
 * smaller.
 */
function tileGrid({ width, height, region, stride }) {
  const span = Math.max(1, Math.floor(region.width));
  const spanY = Math.max(1, Math.floor(region.height));
  // Tiles step by the region they were allocated, which is what makes the grid
  // complete: the page starts where the previous one ended. Sizing the step by
  // anything smaller than the stride would let a region cover less than its
  // share, and the uncovered source would be missing from every tile.
  const stepX = Math.max(1, Math.floor(stride?.width ?? span));
  const stepY = Math.max(1, Math.floor(stride?.height ?? spanY));
  const columns = Math.max(1, ceilDiv(width, stepX));
  const rows = Math.max(1, ceilDiv(height, stepY));
  const tiles = [];
  for (let row = 0; row < rows; row += 1) {
    const y = row * stepY;
    for (let column = 0; column < columns; column += 1) {
      const x = column * stepX;
      tiles.push({
        x,
        y,
        width: Math.min(span, width - x),
        height: Math.min(spanY, height - y),
      });
    }
  }
  return { grid: { columns, rows }, tiles };
}

/**
 * Plan a tile layout for one source image.
 *
 * Tiles are packed the way the provider itself packs a request image: one
 * image carries one `PATCH_SIZE`-multiple raster, and the model sees it at full
 * resolution only while the patch grid stays inside `MAX_IMAGE_TOKENS`. So the
 * plan searches the feasible grid shapes (`columns x rows` within the message
 * tile cap, tiles covering equal shares of the source) and keeps the grid whose
 * tiles land closest to 1:1 with what the provider would have sent without
 * tiling. A source the provider already transmits unchanged yields exactly one
 * tile, so small images keep their current path.
 *
 * @param options - `{ width, height, maxTiles, bounds }`.
 * @returns a plan describing the grid, the shared tile size, the tile list, and
 * the detail the provider would otherwise have destroyed.
 */
export function planTiles(options) {
  const width = options.width;
  const height = options.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error(`image-tiler: invalid source size ${width}x${height}`);
  }
  const maxTiles = Math.max(1, options.maxTiles ?? 20);
  // The region has to survive the store as well as the provider: a tile larger
  // than the host's normalization policy is downscaled after the crop, which
  // would throw away the detail the crop was made for.
  const bounds = options.bounds;
  const printable = providerPrint(width, height);
  const full = {
    grid: { columns: 1, rows: 1 },
    tiles: [{ x: 0, y: 0, width, height }],
    tile: { width, height },
  };
  if (printable.transmitted) return finish({ width, height, printable, maxTiles }, full);

  // A layout is a grid of equal regions that divides the source between them.
  // Each region is sent as one request image, and the provider's own budget
  // decides how much of that region survives 鈥?a region larger than one image
  // can hold is downscaled, not rejected, which is why the region and the
  // transmitted image are two different sizes and both have to be tracked.
  let best;
  for (let columns = 1; columns <= maxTiles; columns += 1) {
    for (let rows = 1; columns * rows <= maxTiles; rows += 1) {
      const stride = { width: Math.ceil(width / columns), height: Math.ceil(height / rows) };
      const region = fitRegion(stride, bounds);
      if (region.width < PATCH_SIZE || region.height < PATCH_SIZE) continue;
      const plan = tileGrid({ width, height, region, stride });
      const count = plan.grid.columns * plan.grid.rows;
      if (count > maxTiles) continue;
      const measured = measurePlan(plan, printable, { width, height });
      // Every region has to end up clearer than the whole source was, and there
      // is no room for a plan that only matches it: below one means the model
      // reads that region worse than it read the whole picture.
      if (measured.clarity <= 1) continue;
      // Leaving part of the source out is worse than showing it softly: a
      // missing region is invisible, while a soft one can still be read. So a
      // layout has to reach across the source to be considered at all 鈥?measured
      // by where the tiles land, not by how much area they add up to 鈥?and only
      // then does sharpness decide between the layouts that do.
      if (measured.spread < MIN_SPREAD) continue;
      // Clearest worst-region first, then how evenly the source is reached, then
      // the most of it covered, then the fewest pieces. Clarity is rounded to one
      // decimal before comparing because layouts that differ by less than that are
      // the same layout as far as the measurement can tell, and letting the
      // rounding noise pick between them produced twenty 8000x400 strips where ten
      // 4000x800 regions deliver exactly as many pixels in a readabler shape.
      const key = [Number(measured.clarity.toFixed(1)), measured.shape, measured.spread, measured.coverage, -count];
      if (best === undefined || compareScore(key, best.key) > 0) {
        best = { key, measured, plan, tile: region, stride };
      }
    }
  }
  // Cutting the source up only pays when it beats showing it whole, so the
  // fallback is measured the same way rather than assumed to lose; the whole
  // source counts as one region, and scores exactly one by construction.
  const whole = {
    tiles: [{ x: 0, y: 0, width, height }],
    tile: { width, height },
  };
  const baseline = measurePlan(whole, printable, { width, height });
  if (best === undefined || best.measured.clarity <= baseline.clarity * 1.02) {
    return finish({ width, height, printable, maxTiles }, full);
  }
  return finish({ width, height, printable, maxTiles }, { ...best.plan, tile: best.tile });
}

/**
 * Lexicographic comparison, used to rank layouts on more than one axis.
 *
 * @returns negative when `left` ranks below `right`, positive when above.
 */
function compareScore(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/**
 * Share of the source a layout has to reach before it is worth using.
 *
 * A message carries at most twenty images, so a source much larger than twenty
 * tiles cannot be shown whole at full resolution 鈥?reaching all of it and
 * reaching half of it sharply are genuinely different offers, and this is where
 * the planner chooses the second. The bar is low on purpose, because the two
 * offers are not close in readable content: a source that arrives as one
 * printed image delivers about 1.7 megapixels however large it is, while a
 * quarter of a 20000x12000 source shown at its own resolution delivers tens of
 * megapixels of legible detail. Below a quarter the layout stops sampling the
 * source and starts showing one corner of it, which is when a model would be
 * reasoning about a picture most of which it never saw.
 */
const MIN_SPREAD = 0.25;

/**
 * How much of the source a layout shows at least as well as one printed image.
 *
 * The provider scales an oversized image by its long edge until it fits
 * `MAX_IMAGE_TOKENS`, so sending the source whole hands the model one print of
 * about 1.7 megapixels however large the source is. Cropping first is what buys
 * resolution back: each tile is measured against that same budget on its own, so
 * a region which was scaled down as part of the whole can arrive at its own
 * size. A region therefore counts in proportion to how close its own copy comes
 * to the detail one printed image carried 鈥?a region the tiles deliver at a
 * third of that detail is worth a third of its area, and one delivered at full
 * detail counts in full. That single measure ranks the trade the planner faces:
 * a large area at moderate detail against a smaller area sharply, whichever
 * leaves the model with more readable source.
 *
 * A tile is also only worth as much as what it shows of the source, and a tile
 * far wider or taller than the source is mostly a letterbox view of one region,
 * so `shape` discounts tiles that drift from the source's proportions.
 *
 * @param plan - a `{ tiles }` layout.
 * @param printable - the provider's own print size for the source.
 * @param source - the source's own size.
 */
function measurePlan(plan, printable, source) {
  const sourcePixels = Math.max(1, source.width * source.height);
  // The one bar every layout has to clear: what the provider already shows of the
  // source when it sends it whole. Whatever a region's own size, it has to be
  // displayed at least this densely for cutting the source up to have helped.
  const baselineDensity = Math.max(1, printable.width * printable.height) / sourcePixels;
  let shown = 0;
  let worst = Number.POSITIVE_INFINITY;
  let tiles = 0;
  for (const tile of plan.tiles) {
    // The tile is a region of the source; what the provider sends for it is the
    // same region sized to its own budget, so a region too large for one image
    // is downscaled rather than refused.
    const sent = transmittedSize(tile);
    const sourceInTile = Math.max(1, tile.width * tile.height);
    const density = Math.max(1, sent.width * sent.height) / sourceInTile;
    // How much of the baseline's own density this region ends up with. One or
    // more means the model reads this region at least as finely as it read the
    // whole source; below one means cutting it out made it worse.
    const perPixel = density / baselineDensity;
    // A plan is only as clear as its blurriest region: averaging would let
    // nineteen sharp tiles cover for one unreadable strip.
    worst = tiles === 0 ? perPixel : Math.min(worst, perPixel);
    shown += sourceInTile * Math.min(1, density);
    tiles += 1;
  }
  if (tiles === 0 || shown === 0) return { clarity: 0, coverage: 0, shape: 0 };
  // Overlap cannot uncover new source, so the total never exceeds the whole.
  const coverage = Math.min(1, shown / sourcePixels);
  return { clarity: worst, coverage, shape: shapeFit(plan, source), sourcePixels, spread: spatialSpread(plan, source) };
}

/**
 * How usable the shape of one region is.
 *
 * Two layouts can send the same number of pixels per region and still not be
 * equally readable: twenty strips of 8000x400 and ten regions of 4000x800 hand
 * over identical detail, but a region whose shape matches the source arrives as a
 * picture rather than a sliver. This is only ever a tie-breaker 鈥?it is compared
 * after clarity has already been rounded to the precision the measurement really
 * has, so it settles near-equal layouts and never overrides a clearer one.
 *
 * @returns 1 for a region shaped like the source, down to 0 as it flattens out.
 */
function shapeFit(plan, source) {
  if (plan.tiles.length === 0) return 0;
  const region = plan.tiles[0];
  if (!region.width || !region.height) return 0;
  const regionAspect = region.width / region.height;
  const sourceAspect = source.width / source.height;
  const worse = Math.max(regionAspect, sourceAspect) / Math.min(regionAspect, sourceAspect);
  return 1 / worse;
}

/**
 * How evenly a layout covers the source, measured on a coarse grid of sample
 * points rather than by area.
 *
 * Total coverage alone cannot tell a layout that shows half of every part of a
 * picture from one that shows all of one half and nothing of the other, and only
 * the first is useful: a model reading a band of an image cannot see what the
 * band was a detail of. Sampling keeps this honest without walking every pixel.
 *
 * @returns share of sample points inside some tile, between 0 and 1.
 */
function spatialSpread(plan, source) {
  const steps = 20;
  let covered = 0;
  let total = 0;
  for (let row = 0; row < steps; row += 1) {
    const y = Math.min(source.height - 1, Math.floor(((row + 0.5) * source.height) / steps));
    for (let column = 0; column < steps; column += 1) {
      const x = Math.min(source.width - 1, Math.floor(((column + 0.5) * source.width) / steps));
      total += 1;
      for (const tile of plan.tiles) {
        if (x >= tile.x && x < tile.x + tile.width && y >= tile.y && y < tile.y + tile.height) {
          covered += 1;
          break;
        }
      }
    }
  }
  return total === 0 ? 0 : covered / total;
}

/**
 * Size at which the provider will actually transmit one cropped tile, applying
 * the same token budget and long-edge rule it applies to any other image.
 */
function transmittedSize(tile) {
  if (providerTokens(tile.width, tile.height) <= MAX_IMAGE_TOKENS) return tile;
  return providerPrint(tile.width, tile.height);
}

function finish({ width, height, printable, maxTiles }, planned) {
  const tiles = planned.tiles;
  const box = planned.tile ?? tiles.reduce((accumulator, tile) => ({
    width: Math.max(accumulator.width, tile.width),
    height: Math.max(accumulator.height, tile.height),
  }), { width: 0, height: 0 });
  // Measured the same way every candidate was, so the reported zoom is the one
  // the choice was actually made on: the whole source scores exactly one, and a
  // layout that was taken over it scores above.
  const measured = measurePlan({ tiles }, printable, { width, height });
  return {
    source: { width, height },
    tiles,
    grid: planned.grid,
    tile: box,
    maxTiles,
    providerPrint: printable,
    // How much more of each region the model reads than it would have from the
    // single printed image: 1 is no gain, above 1 is the gain tiling bought.
    zoom: measured.clarity,
    coverage: measured.coverage,
    ratio: {
      width: box.width / Math.max(1, Math.min(printable.width, width)),
      height: box.height / Math.max(1, Math.min(printable.height, height)),
      pixels: (box.width * box.height) / Math.max(1, printable.width * printable.height),
    },
    tokensPerTile: providerTokens(box.width, box.height),
  };
}

export default {
  planTiles,
  providerTokens,
  providerPrint,
  solveResizeRatio,
  maxTileForAspect,
  fitRegion,
  gridTokens,
  gridCells,
  padToPatch,
  MAX_IMAGE_TOKENS,
  CELL_SIZE,
  MAX_TILE_WIDTH,
  MAX_TILE_HEIGHT,
  PATCH_SIZE,
  DOWNSAMPLE_RATIO,
};
