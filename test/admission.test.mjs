/**
 * Admission behaviour of the store wrapper.
 *
 * The raster work needs `sharp`, but every decision this file checks is made
 * from numbers the store publishes and bytes the planner already produced, so
 * the tests drive the real class with a stand-in base store: what the wrapper
 * promises — one prompt in, tiles out, and never a refused message — is exactly
 * what these assertions cover.
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';

/**
 * Import the plugin with `@deepseek-ai/dsh-attachment-local` and `sharp`
 * replaced by stand-ins (`test/stubs.mjs`).
 *
 * Neither can be installed here: the official packages resolve only inside the
 * harness, and sharp is a native binary. Neither decision under test needs a
 * real raster — the wrapper asks the base store for its limits, decides from
 * numbers, and hands the whole admission back to the base store.
 */
register(new URL('./stubs.mjs', import.meta.url));

const PLUGIN = new URL('../index.js', import.meta.url);
const { TilingAttachmentStore } = await import(PLUGIN.href);

/** A context that records what the plugin would log, since the logs are the UI. */
function context() {
  const lines = [];
  const collect = (level) => (message, ...args) => {
    let index = 0;
    lines.push({ level, text: String(message).replace(/%[sdx%]/g, () => String(args[index++])) });
  };
  return {
    lines,
    logger: { info: collect('info'), warn: collect('warn'), error: collect('error'), debug: collect('debug') },
  };
}

/** Canonical base64 for one image part of a chosen decoded size. */
function imagePart(bytes, name) {
  return { type: 'image', data: Buffer.alloc(bytes, 3).toString('base64'), mediaType: 'image/png', name };
}

function storeWith(config = {}) {
  const ctx = context();
  return { ctx, store: new TilingAttachmentStore(ctx, config) };
}

const checks = { passed: 0, failed: 0, failures: [] };
function check(label, run) {
  try {
    run();
    checks.passed += 1;
  } catch (error) {
    checks.failed += 1;
    checks.failures.push(`${label}: ${error?.message ?? error}`);
  }
}

async function tilesFor(content, config = {}) {
  const { ctx, store } = storeWith(config);
  const admitted = await store.admitPromptContent(content);
  return { ctx, store, admitted };
}

const SMALL = 64 * 1024;

// 1. One oversized image is cut up, and the base store sees only tiles.
{
  const { ctx, store, admitted } = await tilesFor([imagePart(SMALL, 'shot.png')]);
  check('one image produces several parts', () => assert.ok(admitted.length > 4, `parts=${admitted.length}`));
  check('every part is an image reference', () => {
    for (const part of admitted) assert.equal(part.type, 'image');
    for (const part of admitted) assert.ok(part.attachment?.attachmentId !== undefined);
  });
  check('the base store sees named tiles and no original', () => {
    for (const part of store.seen) assert.ok(String(part.name).startsWith('shot#'), String(part.name));
    assert.equal(store.seen.length, admitted.length);
  });
  check('the tiling is logged', () => assert.ok(ctx.lines.some((line) => line.text.includes('shown as')), JSON.stringify(ctx.lines)));
}

// 2. A message of several images splits the message budget instead of spending
//    it all on the first image.
{
  const content = [imagePart(SMALL, 'a.png'), imagePart(SMALL, 'b.png'), imagePart(SMALL, 'c.png')];
  const { store, admitted } = await tilesFor(content);
  const perImage = Math.max(1, Math.floor(20 / content.length));
  check('every image is tiled', () => assert.equal(admitted.length, perImage * content.length, `parts=${admitted.length}`));
  const names = store.seen.map((part) => String(part.name));
  check('each source keeps its own tiles', () => {
    for (const stem of ['a#', 'b#', 'c#']) assert.ok(names.some((name) => name.startsWith(stem)), names.join(','));
  });
  check('the batch stays inside the count limit', () => assert.ok(admitted.length <= 20));
}

// 3. An image whose tiles cannot be stored is sent whole.
{
  globalThis.__tilerSharpTileBytes = 30 * 1024 * 1024;
  const { ctx, store, admitted } = await tilesFor([imagePart(SMALL, 'huge.png')]);
  check('an oversized tile sends the original image', () => assert.equal(admitted.length, 1));
  check('the original reaches the base store', () => assert.equal(store.seen.length, 1));
  check('the reason is logged', () => assert.ok(ctx.lines.some((line) => line.text.includes('over the') && line.text.includes('image limit')), JSON.stringify(ctx.lines)));
  globalThis.__tilerSharpTileBytes = 1024;
}

// 4. A budget too small to divide an image leaves the message alone.
{
  const content = Array.from({ length: 4 }, (_, index) => imagePart(SMALL, `p${index}.png`));
  const { ctx, store, admitted } = await tilesFor(content, { maxImagesPerMessage: 8 });
  check('the whole message passes through', () => assert.deepEqual(admitted.map((part) => part.attachment.attachmentId !== undefined), content.map(() => true)));
  check('nothing was cut', () => assert.equal(store.seen.length, content.length));
  check('the pass-through is explained', () => assert.ok(ctx.lines.some((line) => line.text.includes('showing them as sent')), JSON.stringify(ctx.lines)));
}

// 5. Text and file references keep their place in the prompt.
{
  const content = [
    { type: 'text', text: 'look at this' },
    imagePart(SMALL, 'shot.png'),
    { type: 'file', attachment: { attachmentId: 'sha256:kept' } },
  ];
  const { store, admitted } = await tilesFor(content);
  check('the prompt keeps its first part', () => assert.equal(admitted[0].type, 'text'));
  check('the prompt keeps its last part', () => assert.equal(admitted.at(-1).type, 'file'));
  check('the file reference is unchanged', () => assert.equal(admitted.at(-1).attachment.attachmentId, 'sha256:kept'));
  check('the image in the middle became tiles', () => assert.ok(admitted.length > 5, `parts=${admitted.length}`));
  check('the base store received them in order', () => {
    assert.equal(store.seen[0].type, 'text');
    assert.equal(store.seen.at(-1).type, 'file');
  });
}

// 6. A prompt without images never reaches the tiler.
{
  const { store, ctx } = storeWith();
  await store.admitPromptContent([{ type: 'text', text: 'hello' }]);
  check('no image work is logged', () => assert.equal(ctx.lines.length, 0));
}

// 7. A crop that fails costs the tiling, not the prompt.
{
  globalThis.__tilerSharpTileBytes = 1024;
  const { ctx, store, admitted } = await tilesFor([imagePart(SMALL, 'broken.png')], { __fail: true });
  check('the fallback still admits the image', () => assert.equal(admitted.length >= 1, true));
  check('a failing crop is at worst a fallback', () => assert.ok(store.seen.length >= 1));
  void ctx;
}

console.log(`admission: ${checks.passed} checks passed`);
if (checks.failed > 0) {
  console.log(`${checks.failed} failed:`);
  for (const failure of checks.failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
