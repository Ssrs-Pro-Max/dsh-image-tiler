/**
 * Tile geometry tests.
 *
 * Run: `node test/geometry.test.mjs` (no test runner dependency).
 *
 * The first half re-implements the provider's shipped projection inline 閳?the
 * same lines the harness runs in `dsh-llm-deepseek` 閳?so the planner is checked
 * against an independent transcription rather than against itself. The second
 * half asserts the invariants a dense tile layout must satisfy.
 */
import assert from 'node:assert/strict';
import { planTiles, providerTokens, providerPrint, gridTokens, gridCells, maxTileForAspect, MAX_IMAGE_TOKENS, MAX_TILE_WIDTH, MAX_TILE_HEIGHT, PATCH_SIZE, CELL_SIZE } from '../lib/geometry.js';

// Mirrors MIN_TILE_SPAN in index.js: the shortest tile edge the plugin is willing
// to publish, restated here so the geometry suite can hold the planner to it.
const MIN_TILE_SPAN = 64;

// --- reference transcription of the provider projection (do not "simplify") ---
const R_PATCH = 14;
const R_RATIO = 3;
const R_BUDGET = 1024;
const R_CELL = R_PATCH * R_RATIO;
const rInt = (v, d) => Math.floor(v / d);
const rCeil = (v, d) => Math.floor((v + d - 1) / d);
const rGridTokens = (gh, gw) => gh * (gw + 1) + 2;
const rGridCells = (padded) => rCeil(rInt(padded, R_PATCH), R_RATIO);

function rSolve(height, width, budget) {
  const aspect = height / width;
  const idealGridWidth = Math.sqrt((budget - 2) / aspect + 0.25) - 0.5;
  const idealGridHeight = idealGridWidth * aspect;
  let bestHeight;
  let bestWidth;
  if (idealGridWidth < 1) {
    bestWidth = 1 * R_CELL;
    bestHeight = rInt(budget - 2, 2) * R_CELL;
  } else if (idealGridHeight < 1) {
    bestWidth = (rInt(budget - 2, 1) - 1) * R_CELL;
    bestHeight = 1 * R_CELL;
  } else {
    const gw = Math.trunc(idealGridWidth);
    const gh = Math.trunc(idealGridHeight);
    const scale = Math.min((gw * R_CELL) / width, (gh * R_CELL) / height);
    bestWidth = Math.trunc((width * scale) / R_PATCH) * R_PATCH;
    bestHeight = Math.trunc((height * scale) / R_PATCH) * R_PATCH;
  }
  return { bestWidth, bestHeight };
}

function rRequestDimensions(width, height) {
  const paddedWidth = rCeil(width, R_PATCH) * R_PATCH;
  const paddedHeight = rCeil(height, R_PATCH) * R_PATCH;
  if (rGridTokens(rGridCells(paddedHeight), rGridCells(paddedWidth)) <= R_BUDGET) return { width, height };
  const solved = rSolve(height, width, R_BUDGET);
  const longEdge = width >= height ? solved.bestWidth : solved.bestHeight;
  const scale = longEdge / Math.max(width, height);
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

let checks = 0;
function check(label, condition, detail) {
  checks += 1;
  assert.ok(condition, `${label}${detail === undefined ? '' : ` 閳?${detail}`}`);
}

// --- 1. provider arithmetic parity ---
// Both strip bounds are checked on their thin axis so the assertion does not
// depend on how the *other* axis is divided into cells.
check('MAX_TILE_WIDTH is the largest in-budget single-row strip',
  providerTokens(MAX_TILE_WIDTH, PATCH_SIZE) <= MAX_IMAGE_TOKENS
  && providerTokens(MAX_TILE_WIDTH + CELL_SIZE, PATCH_SIZE) > MAX_IMAGE_TOKENS,
  `w=${MAX_TILE_WIDTH} tokens=${providerTokens(MAX_TILE_WIDTH, PATCH_SIZE)} / next=${providerTokens(MAX_TILE_WIDTH + CELL_SIZE, PATCH_SIZE)}`);
check('MAX_TILE_HEIGHT is the largest in-budget single-column strip',
  providerTokens(PATCH_SIZE, MAX_TILE_HEIGHT) <= MAX_IMAGE_TOKENS
  && providerTokens(PATCH_SIZE, MAX_TILE_HEIGHT + CELL_SIZE) > MAX_IMAGE_TOKENS,
  `h=${MAX_TILE_HEIGHT} tokens=${providerTokens(PATCH_SIZE, MAX_TILE_HEIGHT)} / next=${providerTokens(PATCH_SIZE, MAX_TILE_HEIGHT + CELL_SIZE)}`);
check('gridTokens matches reference', gridTokens(30, 30) === rGridTokens(30, 30));
check('gridCells matches reference', gridCells(2184) === rGridCells(2184));

// The square-ish budget box must itself cost no more than one image.
for (const aspect of [0.05, 0.25, 0.5, 1, 2, 4, 20]) {
  const best = maxTileForAspect(aspect);
  check(`maxTileForAspect(${aspect}) stays in budget`, providerTokens(best.width, best.height) <= MAX_IMAGE_TOKENS, `${best.width}x${best.height} tokens=${providerTokens(best.width, best.height)}`);
  check(`maxTileForAspect(${aspect}) is patch-aligned`, best.width % PATCH_SIZE === 0 && best.height % PATCH_SIZE === 0, `${best.width}x${best.height}`);
}
check('maxTileForAspect(1) is at least a megapixel', maxTileForAspect(1).area >= 1000 * 1000, `${maxTileForAspect(1).width}x${maxTileForAspect(1).height}`);

const parityCases = [];
for (const width of [544, 700, 1000, 1260, 1300, 1310, 1722, 2000, 2048, 2184, 2198, 4096, 5000, 8000, 12000, 20000, 30000]) {
  for (const height of [200, 420, 900, 1000, 1300, 1600, 1722, 2184, 3000, 6000, 12000, 20000]) {
    parityCases.push([width, height]);
  }
}
for (const [width, height] of parityCases) {
  const mine = providerPrint(width, height);
  if (providerTokens(width, height) <= MAX_IMAGE_TOKENS) {
    check(`parity ${width}x${height} passes through`, mine.transmitted && mine.width === width && mine.height === height);
    check(`parity ${width}x${height} matches provider`, rRequestDimensions(width, height).width === width && rRequestDimensions(width, height).height === height);
    continue;
  }
  const reference = rRequestDimensions(width, height);
  const scaleMine = mine.width / Math.max(width, height);
  const scaleRef = reference.width / Math.max(width, height);
  check(`parity ${width}x${height} shrinks`, !mine.transmitted && mine.width < width && mine.height < height, `${mine.width}x${mine.height}`);
  check(`parity ${width}x${height} within 1px of provider long edge`, Math.abs(scaleMine - scaleRef) * Math.max(width, height) <= PATCH_SIZE + 1, `mine=${mine.width}x${mine.height} provider=${reference.width}x${reference.height}`);
  check(`parity ${width}x${height} stays in budget`, mine.tokens <= MAX_IMAGE_TOKENS, `tokens=${mine.tokens}`);
}

// --- 2. layout invariants ---
// Coverage is counted as row intervals rather than one entry per pixel: the
// largest fixtures hold billions of pixels, and a per-pixel set exceeds the
// engine's Set limit before it can prove anything.
function coverage(plan) {
  const rows = new Map();
  for (const tile of plan.tiles) {
    for (let y = tile.y; y < tile.y + tile.height; y += 1) {
      const spans = rows.get(y) ?? [];
      spans.push([tile.x, tile.x + tile.width]);
      rows.set(y, spans);
    }
  }
  let covered = 0;
  for (const spans of rows.values()) {
    spans.sort((a, b) => a[0] - b[0]);
    let end = -1;
    for (const [start, stop] of spans) {
      const from = Math.max(start, end);
      if (stop > from) covered += stop - from;
      end = Math.max(end, stop);
    }
  }
  return covered;
}

const layoutCases = [
  [1260, 1260], [1300, 1300], [2048, 2048], [3000, 2000], [4000, 3000], [6000, 4000],
  [8000, 8000], [12000, 3000], [20000, 12000], [20000, 20000], [30000, 2000], [1000, 20000],
  [24000, 14000], [5000, 500], [700, 300], [420, 420], [544, 544],
];
for (const [width, height] of layoutCases) {
  const plan = planTiles({ width, height, maxTiles: 20 });
  const label = `${width}x${height}`;
  check(`${label} has at least one tile`, plan.tiles.length >= 1);
  check(`${label} respects the tile cap`, plan.tiles.length <= 20, `tiles=${plan.tiles.length}`);
  // A tile may be larger than one request image can hold: the provider scales
  // such a tile down rather than refusing it, and a scaled-down fifth of the
  // source still reaches the model sharper than the whole source did. What has
  // to hold is that the layout is *clearer* than the plain print, which is what
  // the plan reports as its zoom. A per-tile token check would forbid exactly the
  // layouts that help most.
  check(`${label} every tile is at least as clear as the whole print`, plan.zoom >= 1, `zoom=${plan.zoom}`);
  check(`${label} covers every source pixel`, coverage(plan) === width * height, `covered=${coverage(plan)} of ${width * height}`);
  check(`${label} tiles stay inside the source`, plan.tiles.every((tile) => tile.x >= 0 && tile.y >= 0 && tile.x + tile.width <= width && tile.y + tile.height <= height));
  check(`${label} grid dims match tile count`, plan.grid.columns * plan.grid.rows === plan.tiles.length);
  check(`${label} determinism`, JSON.stringify(plan) === JSON.stringify(planTiles({ width, height, maxTiles: 20 })));
  if (plan.tiles.length > 1) {
    check(`${label} gains detail over the plain print`, plan.zoom > 1, `zoom=${plan.zoom} tile=${plan.tile.width}x${plan.tile.height} print=${plan.providerPrint.width}x${plan.providerPrint.height}`);
  }
  // The whole plan must also survive one admission batch: 20 images per message.
  check(`${label} fits one message image batch`, plan.tiles.length <= 20);
}

// --- 3. a low tile cap must still page the source evenly ---
//
// Regression: an earlier revision let a layout cover less than its own share of
// the source, so a low `maxTiles` produced one huge region plus slivers (a
// 6-tile cap on 8000x8000 yielded 8000x4000 next to 16x4000 and 8000x32). A
// sliver cannot hold the content it was allocated, so those pixels reached the
// model nowhere. Stepping by the stride is what makes a grid complete, and this
// pins the property rather than the shapes.
{
  const width = 8000;
  const height = 8000;
  for (const maxTiles of [1, 2, 3, 4, 6, 8, 12, 20]) {
    const plan = planTiles({ width, height, maxTiles });
    const label = `8000x8000 capped at ${maxTiles}`;
    check(`${label} keeps the cap`, plan.tiles.length <= maxTiles, `tiles=${plan.tiles.length}`);
    check(`${label} covers every source pixel`, coverage(plan) === width * height, `covered=${coverage(plan)}`);
    check(`${label} has no sliver`, plan.tiles.every((tile) => tile.width >= MIN_TILE_SPAN && tile.height >= MIN_TILE_SPAN), `smallest=${Math.min(...plan.tiles.map((tile) => Math.min(tile.width, tile.height)))}`);
    check(`${label} grid dims match tile count`, plan.grid.columns * plan.grid.rows === plan.tiles.length);
    // Paging the source only pays when the pages read better than the single
    // printed image. At a cap of one the plan has to collapse to the whole
    // source instead of pretending to tile it.
    if (plan.tiles.length > 1) {
      check(`${label} beats the plain print`, plan.zoom > 1, `zoom=${plan.zoom}`);
    }
  }
}

// --- 4. documented worked examples ---
{
  const plan = planTiles({ width: 3000, height: 2000, maxTiles: 20 });
  const scaled = providerPrint(3000, 2000);
  check('3000x2000 splits instead of downscaling', plan.tiles.length > 1, `tiles=${plan.tiles.length}`);
  check('3000x2000 reads a region past the print it replaced', plan.zoom > 1, `zoom=${plan.zoom}`);
  check('3000x2000 provider print is smaller than the source', scaled.width < 3000 && scaled.height < 2000, `${scaled.width}x${scaled.height}`);
  check('3000x2000 print is not the source size', scaled.transmitted === false);
}
{
  const plan = planTiles({ width: 420, height: 420, maxTiles: 20 });
  check('a small image is left alone', plan.tiles.length === 1 && plan.zoom === 1);
  check('a small image is transmitted as-is', plan.providerPrint.transmitted === true);
}
{
  // A 1920x1080 screenshot used to arrive as four 960x540 fragments: the
  // provider prints it at 1708x960, eleven percent narrower, and a layout that
  // beat that print by two percent was accepted. The margin now sits where the
  // eye does, so a screenshot this close to its own print stays whole and leaves
  // the message's image budget to pictures that need it.
  const plan = planTiles({ width: 1920, height: 1080, maxTiles: 20 });
  check('1920x1080 stays whole instead of splitting for nothing', plan.tiles.length === 1, `tiles=${plan.tiles.length}`);
  check('1920x1080 is still printed smaller than the source', plan.providerPrint.width < 1920, `${plan.providerPrint.width}x${plan.providerPrint.height}`);
}
{
  const plan = planTiles({ width: 1080, height: 2400, maxTiles: 20 });
  check('a phone screenshot stays whole', plan.tiles.length === 1, `tiles=${plan.tiles.length}`);
  check('a phone screenshot is not transmitted as-is', plan.providerPrint.transmitted === false);
}
{
  const plan = planTiles({ width: 2560, height: 1440, maxTiles: 20 });
  check('2560x1440 still splits, its print is a third smaller', plan.tiles.length > 1, `tiles=${plan.tiles.length}`);
  check('2560x1440 buys a visible amount of detail', plan.zoom >= 2, `zoom=${plan.zoom}`);
}
{
  const plan = planTiles({ width: 12000, height: 12000, maxTiles: 20 });
  check('a 144MP square still yields one message', plan.tiles.length <= 20, `tiles=${plan.tiles.length}`);
  check('a 144MP square shows more of itself than the print', plan.zoom > 1, `zoom=${plan.zoom}`);
}
{
  const plan = planTiles({ width: 30000, height: 2000, maxTiles: 20 });
  check('a 15:1 strip still covers the source', coverage(plan) === 30000 * 2000);
  check('a 15:1 strip stays in one message', plan.tiles.length <= 20, `tiles=${plan.tiles.length}`);
}

console.log(`geometry: ${checks} checks passed`);
