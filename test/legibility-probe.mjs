// How many source pixels per text row survive each path to the model.
//
// A reader needs a glyph to be roughly 7px tall before letterforms separate. That
// constant is an assumption; everything below it is measured from the real pixels,
// so the numbers can be checked against any reader's actual threshold.
//
// Run: node test/legibility-probe.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_IMAGE_TOKENS, planTiles, providerPrint, providerTokens } from '../lib/geometry.js';

const require = createRequire(import.meta.url);
const sharp = require('C:/Users/Ssrs-Pro-Max/.dsh/profiles/desktop/node_modules/sharp');
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');

const SOURCE = { width: 8000, height: 8000 };
const FONT_SIZE = 12;
const LINE_HEIGHT = 22;
const NEEDED_ROW_PX = 7; // a glyph shorter than this usually stops being readable

const sourcePath = join(outDir, 'source.png');
const print = providerPrint(SOURCE.width, SOURCE.height);
const rows = Math.floor((SOURCE.height - 200) / LINE_HEIGHT);

// Where the text rows actually are is measured from the pixels, not assumed from
// the font size: one line is a run of rows with dark pixels in them, and the gap
// to the next run is the real line pitch. Assuming metrics here is how the first
// version of this probe talked itself into a 58px glyph.
const CROP = { left: 0, top: 40, width: 900, height: 600 };
const { data, info } = await sharp(sourcePath)
  .extract(CROP)
  .greyscale()
  .raw()
  .toBuffer({ resolveWithObject: true });
const runs = [];
let open = null;
for (let y = 0; y < info.height; y += 1) {
  let dark = 0;
  for (let x = 0; x < info.width; x += 1) if (data[y * info.width + x] < 128) dark += 1;
  if (dark > 0 && open === null) open = y;
  if (dark === 0 && open !== null) {
    runs.push({ top: open, height: y - open });
    open = null;
  }
}
if (runs.length < 2) throw new Error(`probe: found ${runs.length} text lines in the crop, expected several`);
const glyphHeight = runs[0].height;
const linePitch = runs[1].top - runs[0].top;

const answer = (rowPixels) => (rowPixels >= NEEDED_ROW_PX ? 'readable' : 'not readable');
const plan = planTiles({ ...SOURCE, maxTiles: 20, overlap: 0 });
const tile = plan.tiles[0];
const tileSent = providerTokens(tile.width, tile.height) <= MAX_IMAGE_TOKENS ? tile : providerPrint(tile.width, tile.height);
const paths = [
  { label: 'whole image, one print', width: print.width, scale: print.width / SOURCE.width },
  { label: 'as a tile in the plan', width: tileSent.width, scale: tileSent.width / tile.width },
];

console.log(`source ${SOURCE.width}x${SOURCE.height}, ${rows} rows of ${FONT_SIZE}px text`);
console.log(`plan: ${plan.tiles.length} tiles ${plan.grid.columns}x${plan.grid.rows}, region ${tile.width}x${tile.height}, zoom ${plan.zoom.toFixed(2)}x, coverage ${(plan.coverage * 100).toFixed(1)}%`);
console.log(`measured in the source: glyph height ${glyphHeight}px, line pitch ${linePitch}px (${runs.length} lines in a ${CROP.height}px crop)`);
console.log('');
for (const path of paths) {
  const rowPixels = glyphHeight * path.scale;
  console.log(
    `${path.label.padEnd(24)} ${String(path.width).padStart(5)}px wide  glyphs ${rowPixels.toFixed(1)}px  ${answer(rowPixels)}`,
  );
}
console.log('');
console.log(`a reader needs about ${NEEDED_ROW_PX}px per glyph; the whole print is ${(NEEDED_ROW_PX / (glyphHeight * paths[0].scale)).toFixed(1)}x short of that`);
console.log(`the tile delivers ${(paths[1].scale / paths[0].scale).toFixed(1)}x the pixel height of the print`);

// Two images at a size a reader can take in at once: the same band of text, once
// as the whole picture is printed and once as it comes through a tile. The band is
// taken from the same source rows and written at the same width, so the glyphs are
// as large as each path can actually afford.
const band = {
  left: 0,
  top: Math.max(0, CROP.top + runs[0].top - linePitch),
  width: 4000,
  height: 1000,
};
const viewWidth = 1400;
const viewHeight = Math.round((band.height / band.width) * viewWidth);

await sharp(sourcePath)
  .resize(print.width, print.height, { fit: 'fill' })
  .extract({
    left: Math.round(band.left * (print.width / SOURCE.width)),
    top: Math.round(band.top * (print.height / SOURCE.height)),
    width: Math.max(1, Math.round(band.width * (print.width / SOURCE.width))),
    height: Math.max(1, Math.round(band.height * (print.height / SOURCE.height))),
  })
  .resize(viewWidth, viewHeight, { fit: 'fill' })
  .png()
  .toBuffer()
  .then((bytes) => writeFile(join(outDir, 'f-print-band.png'), bytes));

await sharp(sourcePath)
  .extract(band)
  .resize(viewWidth, viewHeight, { fit: 'fill' })
  .png()
  .toBuffer()
  .then((bytes) => writeFile(join(outDir, 'g-tile-band.png'), bytes));

console.log('');
console.log(`wrote f-print-band.png and g-tile-band.png — both ${viewWidth}x${viewHeight}, same ${band.width}x${band.height} source band`);
