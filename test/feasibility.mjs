// Feasibility probe: build one large image whose only detail is small text, plan
// its tiles, and cut the real pixels with sharp. Prints the numbers the plan
// claims and writes the images a model can actually be shown.
//
// Run: node test/feasibility.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_IMAGE_TOKENS, planTiles, providerPrint, providerTokens } from '../lib/geometry.js';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'out');
// sharp is not resolvable from the plugin directory yet; the profile copy is the
// same one the host would give the plugin once it declares the dependency.
const sharp = require('C:/Users/Ssrs-Pro-Max/.dsh/profiles/desktop/node_modules/sharp');

const SOURCE_WIDTH = 8000;
const SOURCE_HEIGHT = 8000;
// The interesting case is text the whole-image print cannot resolve but a tile
// still can: at this size a glyph is a few source pixels tall, and the print
// squeezes the source by more than 6x on its way to one image.
const FONT_SIZE = 12;
const LINE_HEIGHT = 22;

const rows = Math.floor((SOURCE_HEIGHT - 200) / LINE_HEIGHT);
const words = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
  'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
  'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray',
];

/** Deterministic pseudo-random text, so the probe is reproducible and the words
 * are not guessable from context when a model reads them back. */
function lineFor(index) {
  let seed = (index * 2654435761) % 4294967296;
  const parts = [];
  for (let word = 0; word < 12; word += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    parts.push(`${words[seed % words.length]}-${(seed % 97).toString().padStart(2, '0')}`);
  }
  return parts.join(' ');
}

function escapeXml(text) {
  return text.replace(/[<>&]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[character]);
}

function buildSvg() {
  const lines = [];
  for (let row = 0; row < rows; row += 1) {
    lines.push(
      `<text x="40" y="${80 + row * LINE_HEIGHT}" font-family="Consolas,monospace"` +
        ` font-size="${FONT_SIZE}" fill="#111">${escapeXml(lineFor(row))}</text>`,
    );
  }
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SOURCE_WIDTH}" height="${SOURCE_HEIGHT}">` +
      `<rect width="${SOURCE_WIDTH}" height="${SOURCE_HEIGHT}" fill="#fff"/>` +
      lines.join('') +
      '</svg>',
  );
}

const sourcePath = join(outDir, 'source.png');
const buffer = await sharp(buildSvg()).png().toBuffer();
await mkdir(outDir, { recursive: true });
await writeFile(sourcePath, buffer);

const plan = planTiles({ width: SOURCE_WIDTH, height: SOURCE_HEIGHT, maxTiles: 20, overlap: 0 });
const print = providerPrint(SOURCE_WIDTH, SOURCE_HEIGHT);

console.log(`source      ${SOURCE_WIDTH}x${SOURCE_HEIGHT} (${rows} text rows, font ${FONT_SIZE}px)`);
console.log(`as one image ${print.width}x${print.height} — text is scaled by ${(SOURCE_WIDTH / print.width).toFixed(2)}x here`);
console.log(`plan        ${plan.tiles.length} tiles, ${plan.grid.columns}x${plan.grid.rows}, region ${plan.tile.width}x${plan.tile.height}`);
console.log(`zoom        ${plan.zoom.toFixed(2)}x more of each region than the single print`);
console.log(`coverage    ${(plan.coverage * 100).toFixed(1)}% of the source`);
console.log('');

// Cut the real pixels and record what the provider will do with each tile, so
// the numbers can be checked against the images written below.
const metadata = await sharp(buffer).metadata();
if (metadata.width !== SOURCE_WIDTH || metadata.height !== SOURCE_HEIGHT) {
  throw new Error(`probe: rendered ${metadata.width}x${metadata.height}, expected the source size`);
}

const manifest = [];
for (const [index, tile] of plan.tiles.entries()) {
  const name = `tile-${String(index).padStart(2, '0')}.png`;
  const cut = sharp(buffer).extract({
    left: tile.x,
    top: tile.y,
    width: tile.width,
    height: tile.height,
  });
  const tilePath = join(outDir, name);
  await cut.clone().png().toBuffer().then((bytes) => writeFile(tilePath, bytes));
  const tokens = providerTokens(tile.width, tile.height);
  const sent = tokens <= MAX_IMAGE_TOKENS
    ? { width: tile.width, height: tile.height }
    : providerPrint(tile.width, tile.height);
  manifest.push({
    index,
    region: { x: tile.x, y: tile.y, width: tile.width, height: tile.height },
    tokens,
    sent: { width: sent.width, height: sent.height },
    scale: +(sent.width / tile.width).toFixed(3),
    file: name,
  });
}

await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify({ source: sourcePath, plan: {
  tiles: plan.tiles.length, grid: plan.grid, region: plan.tile, zoom: plan.zoom, coverage: plan.coverage,
}, print, manifest }, null, 2)}\n`);

// The readability comparison. Whatever a provider does before the model sees an
// image, it can only work with the bytes we hand it: the whole picture squeezed
// into one budget-sized print, or a tile that still carries the region's pixels.
// Write the whole picture, one region as the print shows it, the same region as a
// tile, and then the same three text rows out of each blown up to one size — so
// the only thing left that differs is how many source pixels went in.
const tile = plan.tiles[0];
const regionHeight = Math.round((tile.height / SOURCE_HEIGHT) * print.height);
const found = providerTokens(tile.width, tile.height) <= MAX_IMAGE_TOKENS;
const tileSize = found ? { width: tile.width, height: tile.height } : manifest[0].sent;
const scale = tileSize.width / tile.width;
const VIEW_WIDTH = 1400;
const VIEW_HEIGHT = 168;
const rowHeight = Math.round(LINE_HEIGHT / scale);
const rowTop = Math.round((80 - FONT_SIZE) / scale);
const stripHeight = rowHeight * 3;

const whole = await sharp(buffer).resize(print.width, print.height, { fit: 'fill' }).png().toBuffer();
const region = await sharp(buffer)
  .extract({ left: tile.x, top: tile.y, width: tile.width, height: tile.height })
  .png()
  .toBuffer();
const arrived = await sharp(region).resize(tileSize.width, tileSize.height, { fit: 'fill' }).png().toBuffer();

const views = [
  {
    name: 'a-whole-source-as-print.png',
    detail: `whole source as one image (${print.width}x${print.height}, text ~${((FONT_SIZE * print.width) / SOURCE_WIDTH).toFixed(1)}px)`,
    bytes: whole,
  },
  {
    name: 'b-region-as-print.png',
    detail: `first region as the print shows it (${print.width}x${regionHeight}, text ~${((FONT_SIZE * print.width) / SOURCE_WIDTH).toFixed(1)}px)`,
    bytes: await sharp(region).resize(print.width, regionHeight, { fit: 'fill' }).png().toBuffer(),
  },
  {
    name: 'c-region-as-tile.png',
    detail: `the same region as a tile (${tileSize.width}x${tileSize.height}, text ~${(FONT_SIZE * scale).toFixed(1)}px)`,
    bytes: arrived,
  },
  {
    name: 'd-print-text-rows.png',
    detail: `${VIEW_WIDTH}x${VIEW_HEIGHT}: three text rows out of the print, magnified`,
    bytes: await sharp(whole)
      .extract({ left: 0, top: rowTop, width: print.width, height: rowHeight * 2 })
      .resize(VIEW_WIDTH, VIEW_HEIGHT, { fit: 'fill' })
      .png()
      .toBuffer(),
  },
  {
    name: 'e-tile-text-rows.png',
    detail: `${VIEW_WIDTH}x${VIEW_HEIGHT}: the same three text rows out of the tile, magnified the same`,
    bytes: await sharp(arrived)
      .extract({ left: 0, top: rowTop, width: tileSize.width, height: stripHeight })
      .resize(VIEW_WIDTH, VIEW_HEIGHT, { fit: 'fill' })
      .png()
      .toBuffer(),
  },
];

for (const view of views) {
  await writeFile(join(outDir, view.name), view.bytes);
  console.log(`${view.name} — ${view.detail}`);
}

// The whole point in numbers: how tall one text row survives each path.
const rowPixels = (source) => ((FONT_SIZE * source) / SOURCE_WIDTH).toFixed(1);
console.log('');
console.log(`text row height   as one image ${rowPixels(print.width)}px   as a tile ${rowPixels(tileSize.width)}px`);
console.log(`source pixels per sent pixel   1:${(SOURCE_WIDTH / print.width).toFixed(2)} as one image   1:${(1 / scale).toFixed(2)} as a tile`);
