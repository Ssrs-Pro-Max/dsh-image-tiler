/**
 * Module hooks that let the admission test drive the real plugin without the
 * packages this machine cannot install: the official attachment store resolves
 * only inside the harness, and `sharp` is a platform binary.
 *
 * Both stand-ins keep the seam the plugin actually uses. The store stand-in
 * publishes the same numeric limits the real one resolves from its config; the
 * `sharp` stand-in answers `metadata()` with a source size and produces a PNG
 * buffer of a size the test chooses, which is all the admission guards read.
 */

const ATTACHMENT_LOCAL = `
export class LocalAttachmentStore {
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.imageLimits = {
      maxImageBytes: config.maxImageBytes ?? 20 * 1024 * 1024,
      maxImagesPerMessage: config.maxImagesPerMessage ?? 20,
      maxMessageImageBytes: config.maxMessageImageBytes ?? 200 * 1024 * 1024,
    };
    this.normalizationPolicy = {
      maxBytes: config.normalizedImageMaxBytes ?? 4 * 1024 * 1024,
      maxPixels: config.normalizedImageMaxPixels ?? 2048 * 2048,
      maxDimension: config.normalizedImageMaxDimension ?? 8192,
    };
  }
  async admitPromptContent(content) {
    this.seen = content;
    return content.map((part) => part.type === 'image'
      ? { type: 'image', attachment: { attachmentId: 'sha256:stub', bytes: Math.floor(part.data.length / 4) * 3 } }
      : part);
  }
}
`;

const SHARP = `
const size = () => Number(globalThis.__tilerSharpTileBytes ?? 1024);
function sharp() {
  return {
    metadata: async () => ({ width: 4000, height: 4000, format: 'png' }),
    clone() { return this; },
    extract() { return this; },
    png() { return this; },
    toBuffer: async () => Buffer.alloc(size(), 7),
  };
}
export default sharp;
export { sharp };
`;

const STUBS = new Map([
  ['@deepseek-ai/dsh-attachment-local', ATTACHMENT_LOCAL],
  ['sharp', SHARP],
]);

export async function resolve(specifier, context, next) {
  if (STUBS.has(specifier)) return { url: `stub:${specifier}`, shortCircuit: true };
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (!url.startsWith('stub:')) return next(url, context);
  return { format: 'module', shortCircuit: true, source: STUBS.get(url.slice('stub:'.length)) };
}
