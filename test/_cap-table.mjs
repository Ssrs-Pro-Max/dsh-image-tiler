/**
 * Tile-layout table: what the planner does to a source at each tile cap.
 *
 * Run: `node test/_cap-table.mjs`
 *
 * Used to pick and document the `maxTiles` default: it prints the grid, the tile
 * size, the reported zoom, and the smallest tile edge, so the table shows both
 * how much detail a cap buys and how much of the source each tile reaches.
 */
import { planTiles } from '../lib/geometry.js';

const cases = [
  [8000, 8000, 'a 64MP square'],
  [12000, 12000, 'a 144MP square'],
  [3000, 2000, 'a 6MP photo'],
  [20000, 12000, 'a 240MP scan'],
  [12000, 3000, 'a 4:1 wide strip'],
  [1000, 20000, 'a 1:20 tall strip'],
  [2048, 2048, 'a 4MP image'],
];

const caps = [1, 2, 4, 6, 8, 12, 16, 20];
const header = ['source', 'cap', 'tiles', 'grid', 'tile', 'zoom', 'minEdge'].join('\t');
console.log(header);
for (const [width, height, label] of cases) {
  for (const maxTiles of caps) {
    const plan = planTiles({ width, height, maxTiles });
    const minEdge = Math.min(...plan.tiles.map((tile) => Math.min(tile.width, tile.height)));
    console.log([
      `${width}x${height} ${label}`,
      maxTiles,
      plan.tiles.length,
      `${plan.grid.columns}x${plan.grid.rows}`,
      `${plan.tile.width}x${plan.tile.height}`,
      plan.zoom.toFixed(2),
      minEdge,
    ].join('\t'));
  }
  console.log('');
}
