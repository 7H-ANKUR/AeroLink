/**
 * Load the trained weights from disk for headless runs (scripts, tests).
 *
 * The engine does no I/O — that is what lets the same code run in a Web Worker
 * and under `bun test`. Loading therefore happens at the edge: here for Node/
 * Bun, and in src/lib/load-model.ts via fetch for the browser.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeWeights, TinyBeaconNet, type ModelManifest } from '../../src/engine/nn';
import { TrackVerifier, type TrackVerifierWeights } from '../../src/engine/track-verifier';
import type { LoadedModel } from '../../src/engine/detector-ai';

export const MODEL_DIR = join(import.meta.dir, '..', '..', 'public', 'models');
export const DEFAULT_MODEL = 'beacon-roi-v2';
export const DEFAULT_VERIFIER = 'track-verifier-v1';

/** The track verifier alone, or null if it has not been trained. */
export function tryLoadVerifier(name = DEFAULT_VERIFIER): TrackVerifier | null {
  const p = join(MODEL_DIR, `${name}.json`);
  if (!existsSync(p)) return null;
  return new TrackVerifier(JSON.parse(readFileSync(p, 'utf8')) as TrackVerifierWeights);
}

/** Returns null when the CNN has not been trained yet. Never throws. The
 *  verifier is attached when present; the hybrid detector requires it. */
export function tryLoadModel(name = DEFAULT_MODEL, verifier = DEFAULT_VERIFIER): LoadedModel | null {
  const bin = join(MODEL_DIR, `${name}.bin`);
  const json = join(MODEL_DIR, `${name}.json`);
  if (!existsSync(bin) || !existsSync(json)) return null;
  const manifest = JSON.parse(readFileSync(json, 'utf8')) as ModelManifest;
  const weights = decodeWeights(readFileSync(bin));
  const net = new TinyBeaconNet(weights);
  return { net, manifest, weights, verifier: tryLoadVerifier(verifier) };
}

/**
 * The CNN + verifier, with ONNX Runtime Web backends attached (plan2): the
 * learned stages then run through ORT via SimulationRunner.stepAsync, the
 * same adapter the browser worker uses. Returns null when no model or no
 * ONNX export exists.
 */
export async function tryLoadModelWithOrt(): Promise<LoadedModel | null> {
  const base = tryLoadModel();
  if (base === null) return null;
  const cnn = join(MODEL_DIR, `${DEFAULT_MODEL}.onnx`);
  const ver = join(MODEL_DIR, `${DEFAULT_VERIFIER}.onnx`);
  if (!existsSync(cnn)) return null;
  const { createOrtBackends } = await import('../../src/lib/ort-runtime');
  const b = await createOrtBackends(
    new Uint8Array(readFileSync(cnn)),
    existsSync(ver) ? new Uint8Array(readFileSync(ver)) : null,
  );
  return { ...base, scorer: b.scorer, batchVerifier: b.batchVerifier };
}

/** Same, but fails loudly — for callers that have explicitly asked for AI. */
export function loadModelOrThrow(name = DEFAULT_MODEL): LoadedModel {
  const m = tryLoadModel(name);
  if (m === null) {
    throw new Error(
      `No trained model at public/models/${name}.bin.\n` +
        'Build one with:\n' +
        '  python scripts/ai/build_roi_dataset.py\n' +
        '  python scripts/ai/train_roi.py',
    );
  }
  return m;
}
