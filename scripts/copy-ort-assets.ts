/**
 * Copy the ONNX Runtime Web WASM artefacts into public/ort/ so the browser
 * worker can load them from the app's own origin (no CDN, works offline).
 *
 * Only the plain SIMD build is copied: the worker runs ORT single-threaded
 * on the WASM execution provider (no COOP/COEP headers are required, and the
 * frame loop is already off the UI thread).
 *
 * Usage: bun scripts/copy-ort-assets.ts   (also run by `bun run ort:assets`)
 */
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..', 'node_modules', 'onnxruntime-web', 'dist');
const DST = join(import.meta.dir, '..', 'public', 'ort');
const FILES = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];

mkdirSync(DST, { recursive: true });
for (const f of FILES) {
  copyFileSync(join(SRC, f), join(DST, f));
  process.stdout.write(`  public/ort/${f}  ${(statSync(join(DST, f)).size / 1e6).toFixed(1)} MB\n`);
}
