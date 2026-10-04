/**
 * Parity between the trained model and the shipped TypeScript inference.
 *
 * Training happens offline in PyTorch; inference ships as hand-written
 * TypeScript in src/engine/nn.ts. That split buys a dependency-free engine,
 * and it costs exactly one risk: the two can drift, after which the product
 * keeps producing confident numbers from a model that is no longer the one
 * that was validated.
 *
 * These tests close that. If the TypeScript forward pass, the weight layout or
 * the preprocessing stops matching Python, this file fails.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  TinyBeaconNet,
  cropAndNormalise,
  decodeWeights,
  PATCH,
  WEIGHT_COUNT,
} from '../src/engine/nn';
import { TrackVerifier, type TrackVerifierWeights } from '../src/engine/track-verifier';
import { N_TRACK_FEATURES } from '../src/engine/candidate-tracks';

const ROOT = join(import.meta.dir, '..');
const WEIGHTS = join(ROOT, 'public', 'models', 'beacon-roi-v2.bin');
const MANIFEST = join(ROOT, 'public', 'models', 'beacon-roi-v2.json');
const SCORE_FIXTURE = join(ROOT, 'tests', 'fixtures', 'ai-parity.json');
const PRE_FIXTURE = join(ROOT, 'tests', 'fixtures', 'ai-preprocess.json');

const hasModel = existsSync(WEIGHTS) && existsSync(SCORE_FIXTURE);

describe('preprocessing parity with scripts/ai/common.py', () => {
  test('cropAndNormalise reproduces the Python implementation exactly', () => {
    expect(existsSync(PRE_FIXTURE)).toBe(true);
    const fx = JSON.parse(readFileSync(PRE_FIXTURE, 'utf8')) as {
      patch: number;
      cases: Array<{
        why: string;
        width: number;
        height: number;
        frame: number[];
        cx: number;
        cy: number;
        expected: number[];
      }>;
    };
    expect(fx.patch).toBe(PATCH);
    expect(fx.cases.length).toBeGreaterThan(4);

    const out = new Float32Array(PATCH * PATCH);
    const ring = new Float32Array(PATCH * PATCH);
    for (const c of fx.cases) {
      const frame = new Uint8Array(c.frame);
      cropAndNormalise(frame, c.width, c.height, c.cx, c.cy, out, ring);
      for (let i = 0; i < out.length; i++) {
        // Python rounds the fixture to 7 dp; 1e-6 is the tightest tolerance
        // that rounding allows.
        expect(Math.abs(out[i] - c.expected[i])).toBeLessThan(1e-6);
      }
    }
  });
});

describe('TinyBeaconNet inference parity', () => {
  test('weight blob matches the architecture', () => {
    if (!hasModel) {
      throw new Error(
        'public/models/beacon-roi-v2.bin is missing. Run ' +
          'python scripts/ai/build_roi_dataset.py && python scripts/ai/train_roi.py',
      );
    }
    const w = decodeWeights(readFileSync(WEIGHTS));
    expect(w.length).toBe(WEIGHT_COUNT);
    expect(w.length).toBe(2989);
    // A blob of zeros would load fine and score everything identically.
    let nonZero = 0;
    for (let i = 0; i < w.length; i++) if (w[i] !== 0) nonZero++;
    expect(nonZero).toBeGreaterThan(w.length * 0.9);
  });

  test('a mismatched weights blob is rejected rather than run', () => {
    expect(() => new TinyBeaconNet(new Float32Array(WEIGHT_COUNT - 1))).toThrow();
    expect(() => new TinyBeaconNet(new Float32Array(WEIGHT_COUNT + 1))).toThrow();
  });

  test('TypeScript forward pass reproduces the PyTorch scores', () => {
    const w = decodeWeights(readFileSync(WEIGHTS));
    const net = new TinyBeaconNet(w);
    const fx = JSON.parse(readFileSync(SCORE_FIXTURE, 'utf8')) as {
      patches: number[][];
      scores: number[];
    };
    expect(fx.patches.length).toBeGreaterThan(8);

    let worst = 0;
    for (let i = 0; i < fx.patches.length; i++) {
      const patch = Float32Array.from(fx.patches[i]);
      expect(patch.length).toBe(PATCH * PATCH);
      const got = net.forward(patch);
      worst = Math.max(worst, Math.abs(got - fx.scores[i]));
    }
    // Float32 accumulation order differs between the two implementations, so
    // exact equality is not available; 1e-4 is far tighter than any decision
    // threshold the detector applies.
    expect(worst).toBeLessThan(1e-4);
  });

  test('the model actually discriminates — it is not a constant function', () => {
    const w = decodeWeights(readFileSync(WEIGHTS));
    const net = new TinyBeaconNet(w);
    const fx = JSON.parse(readFileSync(SCORE_FIXTURE, 'utf8')) as {
      patches: number[][];
      scores: number[];
    };
    const scores = fx.patches.map((p) => net.forward(Float32Array.from(p)));
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    // A network that returns the same value for every input would pass every
    // other test in this file while being useless.
    expect(max - min).toBeGreaterThan(0.5);
  });

  test('manifest records what the model was trained on and measured at', () => {
    const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    expect(m.paramCount).toBe(2989);
    expect(m.patch).toBe(PATCH);
    expect(Array.isArray(m.trainedOn)).toBe(true);
    expect(m.trainedOn.length).toBe(2);
    // The locked-test metrics must be present: a model shipped without a
    // held-out number is a model nobody can check.
    expect(typeof m.metrics.locked_test_f1).toBe('number');
    expect(m.metrics.locked_test_f1).toBeGreaterThan(0);
  });
});

describe('track verifier inference parity', () => {
  const VERIFIER = join(ROOT, 'public', 'models', 'track-verifier-v1.json');
  const VFIX = join(ROOT, 'tests', 'fixtures', 'track-verifier-parity.json');

  test('TypeScript MLP reproduces the PyTorch scores', () => {
    expect(existsSync(VERIFIER)).toBe(true);
    const v = new TrackVerifier(JSON.parse(readFileSync(VERIFIER, 'utf8')) as TrackVerifierWeights);
    const fx = JSON.parse(readFileSync(VFIX, 'utf8')) as { rows: number[][]; scores: number[] };
    expect(fx.rows.length).toBeGreaterThan(16);
    let worst = 0;
    for (let i = 0; i < fx.rows.length; i++) {
      expect(fx.rows[i].length).toBe(N_TRACK_FEATURES);
      worst = Math.max(worst, Math.abs(v.predict(Float32Array.from(fx.rows[i])) - fx.scores[i]));
    }
    expect(worst).toBeLessThan(1e-4);
  });

  test('the verifier discriminates and records its locked-test numbers', () => {
    const w = JSON.parse(readFileSync(VERIFIER, 'utf8')) as TrackVerifierWeights;
    const v = new TrackVerifier(w);
    const fx = JSON.parse(readFileSync(VFIX, 'utf8')) as { rows: number[][] };
    const s = fx.rows.map((r) => v.predict(Float32Array.from(r)));
    expect(Math.max(...s) - Math.min(...s)).toBeGreaterThan(0.5);
    expect(typeof w.metrics.test_f1).toBe('number');
    expect(typeof w.metrics.test_auc).toBe('number');
  });

  test('weights trained on a different feature order are refused', () => {
    const w = JSON.parse(readFileSync(VERIFIER, 'utf8')) as TrackVerifierWeights;
    const swapped = { ...w, features: [...w.features].reverse() };
    expect(() => new TrackVerifier(swapped)).toThrow();
  });
});
