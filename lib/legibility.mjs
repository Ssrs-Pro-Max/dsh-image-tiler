// Legibility calibration: render text at a range of sizes so a reader can report
// which sizes it can actually make out. This measures the reader, not the tiler —
// the tiler only decides how many source pixels reach the reader, and this says
// how many source pixels per glyph that costs.
//
// Run: node lib/legibility.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sharp = require('C:/Users/Ssrs-Pro-Max/.dsh/profiles/desktop/node_modules/sharp');
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const TEXT_WIDTH = 27;
const COLUMNS = 9;
const SIZES = [12, 14, 16, 18, 20, 26, 30, 38];

function controls(seed) {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state;
  };
  return Array.from({ length: TEXT_WIDTH }, () => ALPHABET[next() % ALPHABET.length]).join('');
}

function escapeXml(text) {
  return text.replace(/[<>&]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[character]);
}

function buildSvg(sizes = SIZES) {
  const bandHeight = Math.round(Math.max(...sizes) * 1.7);
  const width = COLUMNS * (TEXT_WIDTH * Math.max(...sizes) * 0.62 + 24) + 40;
  const parts = [];
  sizes.forEach((size, row) => {
    const baseline = row * bandHeight + bandHeight - Math.round(size * 0.35);
    for (let column = 0; column < COLUMNS; column += 1) {
      const step = Math.max(1, Math.round((TEXT_WIDTH * size * 0.62 + 24) / 1));
      const x = 20 + column * step;
      parts.push(
        `<text x="${x}" y="${baseline}" font-family="Consolas,monospace" font-size="${size}" font-weight="bold" fill="#000">` +
          `${escapeXml(controls(row * 1000 + column))}</text>`,
      );
    }
    parts.push(
      `<text x="${20}" y="${row * bandHeight + 18}" font-family="Consolas,monospace" font-size="13" fill="#888">size ${size}px</text>`,
    );
  });
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${sizes.length * bandHeight}">` +
      `<rect width="${width}" height="${sizes.length * bandHeight}" fill="#fff"/>${parts.join('')}</svg>`,
  );
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await mkdir(outDir, { recursive: true });
  const svg = buildSvg();
  const source = await sharp(svg).png().toBuffer();
  const metadata = await sharp(source).metadata();
  await writeFile(join(outDir, 'calibration-source.png'), source);
  // Also a scaled-down copy, to see what survives the same reduction a big image
  // takes on its way to a model.
  await sharp(source)
    .resize(1500, null)
    .png()
    .toBuffer()
    .then((bytes) => writeFile(join(outDir, 'calibration-scaled.png'), bytes));
  console.log(`calibration-source.png ${metadata.width}x${metadata.height} — bold text, one row per size: ${SIZES.join(', ')}px`);
  console.log('calibration-scaled.png 1500px wide — the same sheet after a reduction');
}

export { buildSvg, controls };
