/**
 * ONNX Runtime Web backends for the learned perception stages (plan2).
 *
 * Builds a BatchScorer (TinyBeaconNet, beacon-roi-v2.onnx) and a
 * BatchVerifier (track verifier, track-verifier-v1.onnx) from ONNX bytes.
 * Used by the browser Web Worker (bytes fetched from /models/) and by the
 * headless scripts and tests (bytes read from public/models/), so the SAME
 * adapter runs in both places.
 *
 * Execution: WASM execution provider, single thread, no proxy worker — the
 * simulation already runs in its own Web Worker, and single-threaded WASM
 * needs no cross-origin-isolation headers. The runtime label records this.
 *
 * Nothing here decides anything: it turns crops and feature rows into
 * probabilities. It never sees ground truth — its only inputs are the tensors
 * built by the detector from the observed frame.
 */
import * as ort from 'onnxruntime-web/wasm';
import type { BatchScorer, BatchVerifier } from '@/engine/nn';
import { PATCH } from '@/engine/nn';
import { N_TRACK_FEATURES } from '@/engine/candidate-tracks';

export const ORT_VERSION = '1.30.0';

export interface OrtBackends {
  scorer: BatchScorer;
  batchVerifier: BatchVerifier | null;
  /** e.g. 'onnxruntime-web 1.30.0 (wasm, 1 thread)'. */
  runtime: string;
  /** Session creation time, ms. */
  loadMs: number;
}

let configured = false;

/** Configure the WASM backend once. `wasmPaths` = URL prefix of public/ort/. */
export function configureOrt(wasmPaths?: string): void {
  if (configured) return;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  if (wasmPaths) ort.env.wasm.wasmPaths = wasmPaths;
  ort.env.logLevel = 'warning';
  configured = true;
}

function firstOutput(out: ort.InferenceSession.OnnxValueMapType): Float32Array {
  const t = out[Object.keys(out)[0]] as ort.Tensor;
  return t.data as Float32Array;
}

export async function createOrtBackends(
  cnnOnnx: Uint8Array,
  verifierOnnx: Uint8Array | null,
  wasmPaths?: string,
): Promise<OrtBackends> {
  configureOrt(wasmPaths);
  const t0 = performance.now();
  const opts: ort.InferenceSession.SessionOptions = {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  };
  const cnn = await ort.InferenceSession.create(cnnOnnx, opts);
  const ver = verifierOnnx ? await ort.InferenceSession.create(verifierOnnx, opts) : null;
  const loadMs = performance.now() - t0;
  const runtime = `onnxruntime-web ${ORT_VERSION} (wasm, 1 thread)`;

  const scorer: BatchScorer = {
    runtime,
    async scoreBatch(patches: Float32Array, n: number): Promise<Float32Array> {
      if (n === 0) return new Float32Array(0);
      const input = new ort.Tensor('float32', patches.subarray(0, n * PATCH * PATCH), [n, 1, PATCH, PATCH]);
      const out = await cnn.run({ [cnn.inputNames[0]]: input });
      return Float32Array.from(firstOutput(out));
    },
  };
  const batchVerifier: BatchVerifier | null = ver
    ? {
        runtime,
        async predictBatch(features: Float32Array, n: number): Promise<Float32Array> {
          if (n === 0) return new Float32Array(0);
          const input = new ort.Tensor('float32', features.subarray(0, n * N_TRACK_FEATURES), [n, N_TRACK_FEATURES]);
          const out = await ver.run({ [ver.inputNames[0]]: input });
          return Float32Array.from(firstOutput(out));
        },
      }
    : null;
  return { scorer, batchVerifier, runtime, loadMs };
}
