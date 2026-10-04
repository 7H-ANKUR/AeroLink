/**
 * Anti-cheating assertions for the learned perception path.
 *
 * Adding a neural network to a system that is judged on measured performance
 * creates two new ways to cheat, and these tests exist to make both of them
 * fail loudly:
 *
 *   1. LEAKING GROUND TRUTH INTO THE MODEL. A detector that can see the
 *      simulator's answer will post superb numbers and mean nothing.
 *
 *   2. CLAIMING AI WITHOUT RUNNING A MODEL. A build that reports
 *      `method: 'ai'` while executing classical CV would make every AI claim
 *      in the product false while looking completely normal from outside.
 *
 * The existing suite in engine-evidence.test.ts covers the classical path.
 * This file extends the same treatment to nn.ts, fusion.ts and detector-ai.ts.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/engine/config';
import { SimulationRunner } from '../src/engine/simulation';
import { createDetector, DETECTOR_REGISTRY, detectorRequiresModel } from '../src/engine/detectors';
import { ClassicalDetector } from '../src/engine/detector';
import {
  fuse,
  aiVeto,
  AI_VETO_WEIGHT,
  DECOY_MIN_AGE,
  type DetectionContext,
  type TemporalEvidence,
} from '../src/engine/fusion';
import { tryLoadModel } from '../scripts/lib/load-model';
import { mergeBranchCandidates } from '../src/engine/detector-ai';
import type { ScenarioConfig } from '../src/engine/config';
import type { BeaconCandidate } from '../src/engine/detector';

const SRC = join(import.meta.dir, '..', 'src', 'engine');
const GT_TOKENS = /ground_truth|groundTruth|GroundTruthTarget|gt_x|gt_y|gtTuple/;

const PARAMS = {
  threshold: 90,
  minAreaPx: 4,
  maxAreaPx: 1200,
  expectedBeaconSize: 100,
  minConfidence: 0.5,
};

/** CNN + raw weights + track verifier, exactly as the scripts load them. */
function loadModel() {
  return tryLoadModel();
}

describe('learned perception path: ground-truth isolation', () => {
  test('nn.ts, fusion.ts and detector-ai.ts contain no ground-truth access', () => {
    for (const f of [
      'nn.ts',
      'fusion.ts',
      'detector-ai.ts',
      'detectors.ts',
      'proposer.ts',
      'candidate-tracks.ts',
      'track-verifier.ts',
    ]) {
      const src = readFileSync(join(SRC, f), 'utf8');
      // Comments legitimately discuss ground truth; strip them before testing
      // so the assertion is about code, not prose.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      expect({ file: f, leaks: GT_TOKENS.test(code) }).toEqual({ file: f, leaks: false });
    }
  });

  test('the model scores pixels only — identical frames give identical scores', () => {
    const model = loadModel();
    if (model === null) return;
    // Two runs with different beacon truth but the SAME pixel buffer must
    // produce the same score. If truth were reaching the model, it could not.
    const W = 64;
    const H = 64;
    const frame = new Uint8Array(W * H).fill(20);
    for (let y = 30; y < 36; y++) for (let x = 30; x < 36; x++) frame[y * W + x] = 240;
    const a = model.net.scoreAt(frame, W, H, 33, 33);
    const b = model.net.scoreAt(frame, W, H, 33, 33);
    expect(a).toBe(b);
  });

  test('the detector interface exposes no parameter that could carry truth', () => {
    const model = loadModel();
    if (model === null) return;
    const det = createDetector('fusion', PARAMS, model);
    // detect(frame, width, height, tStartMs, predictHint) — five parameters,
    // none of which is a truth channel.
    expect(det.detect.length).toBe(5);
  });
});

describe('learned perception path: no AI without a model', () => {
  test('createDetector refuses the learned kinds when no model is supplied', () => {
    expect(() => createDetector('ai', PARAMS, null)).toThrow();
    expect(() => createDetector('fusion', PARAMS, null)).toThrow();
    expect(() => createDetector('ai_fullframe', PARAMS, null)).toThrow();
  });

  test('the hybrid refuses to run without its track verifier', () => {
    const model = loadModel();
    if (model === null) return;
    // CNN present, verifier absent: the temporal stage would silently vanish.
    expect(() => createDetector('fusion', PARAMS, { ...model, verifier: null })).toThrow();
  });

  test('the refusal does not silently downgrade to classical CV', () => {
    let fellBack = false;
    try {
      const d = createDetector('ai', PARAMS, null);
      fellBack = d.kind === 'cv_classical';
    } catch {
      fellBack = false;
    }
    expect(fellBack).toBe(false);
  });

  test('the registry marks which kinds need a model', () => {
    expect(detectorRequiresModel('cv_classical')).toBe(false);
    expect(detectorRequiresModel('ai')).toBe(true);
    expect(detectorRequiresModel('fusion')).toBe(true);
    expect(detectorRequiresModel('ai_fullframe')).toBe(true);
    expect(DETECTOR_REGISTRY.length).toBe(4);
    // Mode 1 is benchmarked but must not be offered on the live 30 Hz loop.
    expect(DETECTOR_REGISTRY.find((d) => d.kind === 'ai_fullframe')!.realtime).toBe(false);
  });

  test('a run configured for AI fails rather than producing classical results', () => {
    const cfg: ScenarioConfig = {
      ...DEFAULT_CONFIG,
      tracking: { ...DEFAULT_CONFIG.tracking, detector: 'ai' },
    };
    expect(() => new SimulationRunner(cfg, {}, null)).toThrow();
  });

  test('detections report the method that actually ran', () => {
    const model = loadModel();
    if (model === null) return;
    const W = 640;
    const H = 480;
    const frame = new Uint8Array(W * H).fill(18);
    for (let y = 238; y < 248; y++) for (let x = 318; x < 328; x++) frame[y * W + x] = 235;

    expect(createDetector('cv_classical', PARAMS, model).detect(frame, W, H, 0, null).method)
      .toBe('cv');
    expect(createDetector('ai', PARAMS, model).detect(frame, W, H, 0, null).method).toBe('ai');
    expect(createDetector('fusion', PARAMS, model).detect(frame, W, H, 0, null).method)
      .toBe('fusion');
  });

  test('the learned detectors carry provenance naming both stages', () => {
    const model = loadModel();
    if (model === null) return;
    const W = 640;
    const H = 480;
    const frame = new Uint8Array(W * H).fill(18);
    for (let y = 238; y < 248; y++) for (let x = 318; x < 328; x++) frame[y * W + x] = 235;

    const p = createDetector('fusion', PARAMS, model).detect(frame, W, H, 0, null).provenance;
    expect(p).not.toBeNull();
    expect(p!.candidateCount).toBeGreaterThan(0);
    expect(p!.cv).not.toBeNull();
    expect(p!.ai).not.toBeNull();
    // Both stage latencies must be real measurements, not placeholders.
    expect(p!.aiLatencyMs).toBeGreaterThan(0);
  });
});

describe('decision engine behaviour', () => {
  const mk = (x: number, y: number, cv: number): BeaconCandidate => ({
    x,
    y,
    bbox: [x - 5, y - 5, 10, 10],
    area: 100,
    maxIntensity: 235,
    aspect: 1,
    sizeScore: 1,
    shapeScore: 1,
    brightnessScore: cv,
    cvConfidence: cv,
  });
  const ctx = (state: DetectionContext['state'], pred: { x: number; y: number } | null):
    DetectionContext => ({
    state,
    prediction: pred,
    trackAgeFrames: state === 'TRACK' ? 100 : 0,
    lostFramesConsecutive: 0,
  });

  test('an absent model is not treated as a model that disagrees', () => {
    // Same candidates, aiScores null vs all-zero. Null must cast no veto;
    // zeros must veto, or "no model present" would be indistinguishable from
    // "the model rejected everything".
    const cands = [mk(100, 100, 0.9), mk(300, 300, 0.4)];
    const withNull = fuse(cands, null, ctx('SEARCH', null), { incumbent: null, minConfidence: 0.5 });
    const withZeros = fuse(cands, [0, 0], ctx('SEARCH', null), { incumbent: null, minConfidence: 0.5 });
    expect(withNull.confidence).toBeGreaterThan(withZeros.confidence);
    expect(withNull.chosenBy).toBe('cv-only');
  });

  test('a confident model rejection needs no temporal support to fire', () => {
    const cands = [mk(100, 100, 0.9)];
    // Far from prediction -> weak motion consistency -> gate may fire.
    const d = fuse(cands, [0.01], ctx('TRACK', { x: 600, y: 400 }), {
      incumbent: null,
      minConfidence: 0.5,
    });
    expect(d.aiRejected).toBe(1);
    expect(d.index).toBeNull();
  });

  test('a model rejection is overridden when the candidate is where predicted', () => {
    const cands = [mk(100, 100, 0.9)];
    // Sitting on the prediction: appearance may be poor (fog, edge clipping)
    // but position is evidence, so the gate must NOT fire.
    const d = fuse(cands, [0.01], ctx('TRACK', { x: 100, y: 100 }), {
      incumbent: null,
      minConfidence: 0.5,
    });
    expect(d.aiRejected).toBe(0);
    expect(d.index).toBe(0);
  });

  test('lock hysteresis penalises switching to a distant candidate', () => {
    const near = mk(100, 100, 0.7);
    const far = mk(500, 400, 0.75); // slightly better appearance, far away
    const d = fuse([near, far], [0.9, 0.95], ctx('TRACK', { x: 100, y: 100 }), {
      incumbent: { x: 100, y: 100 },
      minConfidence: 0.5,
    });
    // Without hysteresis the brighter distant candidate would win.
    expect(d.index).toBe(0);
  });

  test('the model can veto during a cold search, not only while tracking', () => {
    // Regression: motionConsistency returns a neutral 0.5 with no prediction,
    // and reading that as "temporally supported" disabled the veto for the
    // whole of SEARCH — exactly when a false lock is formed. Measured, that
    // left the hybrid detector with the classical detector's 71 false alarms
    // per 3,150 empty frames instead of the learned model's 1.
    const d = fuse([mk(100, 100, 0.9)], [0.01], ctx('SEARCH', null), {
      incumbent: null,
      minConfidence: 0.5,
    });
    expect(d.aiRejected).toBe(1);
    expect(d.index).toBeNull();
  });

  test('the model votes only against, never for', () => {
    // A confident acceptance must not promote a candidate. The model cannot
    // judge size — PS-169 makes the beacon 5-20 px and decoys are 6-15 px, a
    // strict subset — so letting it vote in favour promotes decoys.
    expect(aiVeto(1.0)).toBe(0);
    expect(aiVeto(0.9)).toBe(0);
    expect(aiVeto(0.35)).toBe(0);
    expect(aiVeto(null)).toBe(0);
    expect(aiVeto(0.2)).toBeLessThan(0);
    expect(aiVeto(0)).toBeCloseTo(-AI_VETO_WEIGHT, 9);
    // Monotone and bounded.
    for (const v of [0, 0.1, 0.2, 0.3, 0.5, 1]) {
      expect(aiVeto(v)).toBeLessThanOrEqual(0);
      expect(aiVeto(v)).toBeGreaterThanOrEqual(-AI_VETO_WEIGHT);
    }
  });

  test('a confident model score cannot outrank the classical size prior', () => {
    // right-size candidate the classical stage likes, vs an off-size one the
    // model loves. The classical prior must win.
    const rightSize = mk(100, 100, 0.95);
    const offSize = mk(400, 300, 0.60);
    const d = fuse([rightSize, offSize], [0.55, 1.0], ctx('SEARCH', null), {
      incumbent: null,
      minConfidence: 0.5,
    });
    expect(d.index).toBe(0);
  });

  const tv = (over: Partial<TemporalEvidence>): TemporalEvidence => ({
    trackId: 1,
    age: 60,
    pBeacon: 0.5,
    speedPxS: 0,
    onClutter: false,
    ...over,
  });

  test('an established decoy is rejected even where the Kalman filter predicts it', () => {
    // The false-lock case: the filter predicts the decoy BECAUSE it has been
    // tracking it, so temporal support must not rescue it.
    const d = fuse([mk(100, 100, 0.95)], [0.9], ctx('TRACK', { x: 100, y: 100 }), {
      incumbent: { x: 100, y: 100 },
      minConfidence: 0.5,
      temporal: [tv({ age: DECOY_MIN_AGE + 5, pBeacon: 0.02 })],
      incumbentP: 0.02,
    });
    expect(d.index).toBeNull();
    expect(d.trackRejected).toBe(1);
  });

  test('a young track is never judged a decoy - too little history', () => {
    const d = fuse([mk(100, 100, 0.95)], [0.9], ctx('SEARCH', null), {
      incumbent: null,
      minConfidence: 0.5,
      temporal: [tv({ age: 3, pBeacon: 0.02 })],
    });
    expect(d.index).toBe(0);
  });

  test('known clutter is refused during a cold search', () => {
    const d = fuse([mk(100, 100, 0.95)], [0.9], ctx('SEARCH', null), {
      incumbent: null,
      minConfidence: 0.5,
      temporal: [tv({ age: 2, onClutter: true })],
    });
    expect(d.index).toBeNull();
    expect(d.trackRejected).toBe(1);
  });

  test('a verified beacon can take the lock from a doubted incumbent', () => {
    // Without verified-switch, hysteresis keeps the (decoy) incumbent.
    const incumbent = mk(100, 100, 0.95);
    const challenger = mk(400, 300, 0.9);
    const args = { incumbent: { x: 100, y: 100 }, minConfidence: 0.5 };
    const blind = fuse([incumbent, challenger], [0.9, 0.9], ctx('TRACK', { x: 100, y: 100 }), args);
    expect(blind.index).toBe(0);
    const informed = fuse([incumbent, challenger], [0.9, 0.9], ctx('TRACK', { x: 100, y: 100 }), {
      ...args,
      temporal: [tv({ trackId: 1, age: 25, pBeacon: 0.2 }), tv({ trackId: 2, age: 25, pBeacon: 0.95 })],
      incumbentP: 0.2,
    });
    expect(informed.index).toBe(1);
  });

  test('a verified challenger can also win on RELATIVE evidence', () => {
    // A beacon-lookalike decoy (bright, right size, static) sits at P ~ 0.5:
    // never "doubted" in absolute terms. A mature track at 0.97 is still the
    // far better explanation and must be able to take the lock.
    const incumbent = mk(100, 100, 0.95);
    const challenger = mk(400, 300, 0.9);
    const d = fuse([incumbent, challenger], [0.9, 0.9], ctx('TRACK', { x: 100, y: 100 }), {
      incumbent: { x: 100, y: 100 },
      minConfidence: 0.5,
      temporal: [tv({ trackId: 1, age: 200, pBeacon: 0.5 }), tv({ trackId: 2, age: 25, pBeacon: 0.97 })],
      incumbentP: 0.5,
    });
    expect(d.index).toBe(1);
    // ...but a small preference is NOT enough to abandon a lock.
    const close = fuse([incumbent, challenger], [0.9, 0.9], ctx('TRACK', { x: 100, y: 100 }), {
      incumbent: { x: 100, y: 100 },
      minConfidence: 0.5,
      temporal: [tv({ trackId: 1, age: 200, pBeacon: 0.7 }), tv({ trackId: 2, age: 25, pBeacon: 0.8 })],
      incumbentP: 0.7,
    });
    expect(close.index).toBe(0);
  });

  test('a spot only the AI branch sees cannot start a lock until verified over time', () => {
    const dim: BeaconCandidate = { ...mk(100, 100, 0.8), source: 'ai' };
    const young = fuse([dim], [0.95], ctx('SEARCH', null), {
      incumbent: null,
      minConfidence: 0.5,
      temporal: [tv({ age: 3, pBeacon: 0.9 })],
    });
    expect(young.index).toBeNull();
    const verified = fuse([dim], [0.95], ctx('SEARCH', null), {
      incumbent: null,
      minConfidence: 0.5,
      temporal: [tv({ age: 12, pBeacon: 0.9 })],
    });
    expect(verified.index).toBe(0);
    const staticDim = fuse([dim], [0.95], ctx('SEARCH', null), {
      incumbent: null,
      minConfidence: 0.5,
      temporal: [tv({ age: 12, pBeacon: 0.1 })],
    });
    expect(staticDim.index).toBeNull();
  });

  test('two nearby AI proposals are not "confirmed by both branches"', () => {
    // Regression: the merge compared AI proposals against each other, so two
    // refined AI peaks within 6 px were labelled 'both' with no classical
    // candidate anywhere — which let dim clutter dodge the AI-only gates.
    const a: BeaconCandidate = { ...mk(100, 100, 0.8), source: 'ai' };
    const b: BeaconCandidate = { ...mk(104, 101, 0.8), source: 'ai' };
    const merged = mergeBranchCandidates([], [a, b]);
    expect(merged.every((c) => c.source === 'ai')).toBe(true);
    const withCv = mergeBranchCandidates([{ ...mk(101, 100, 0.9), source: 'cv' }], [a]);
    expect(withCv.length).toBe(1);
    expect(withCv[0].source).toBe('both');
  });

  test('cold search still applies the confidence floor', () => {
    const weak = mk(100, 100, 0.1);
    const d = fuse([weak], [0.2], ctx('SEARCH', null), { incumbent: null, minConfidence: 0.5 });
    expect(d.index).toBeNull();
  });
});

describe('classical multi-candidate output', () => {
  test('detectCandidates is ungated and sorted by classical confidence', () => {
    const W = 320;
    const H = 240;
    const frame = new Uint8Array(W * H).fill(18);
    // Bright compact spot and a dimmer one.
    for (let y = 100; y < 110; y++) for (let x = 100; x < 110; x++) frame[y * W + x] = 240;
    for (let y = 200; y < 210; y++) for (let x = 200; x < 210; x++) frame[y * W + x] = 130;

    const d = new ClassicalDetector(PARAMS);
    const cands = d.detectCandidates(frame, W, H, 12);
    expect(cands.length).toBe(2);
    expect(cands[0].cvConfidence).toBeGreaterThanOrEqual(cands[1].cvConfidence);
    // The brightest is first and lands on the spot we drew.
    expect(Math.abs(cands[0].x - 104.5)).toBeLessThan(1.5);
  });

  test('detect() is unchanged by the refactor that added detectCandidates', () => {
    const W = 320;
    const H = 240;
    const frame = new Uint8Array(W * H).fill(18);
    for (let y = 100; y < 110; y++) for (let x = 100; x < 110; x++) frame[y * W + x] = 240;
    const d = new ClassicalDetector(PARAMS);
    const det = d.detect(frame, W, H, 0, null);
    const cands = d.detectCandidates(frame, W, H, 12);
    expect(det.found).toBe(true);
    expect(det.x).toBeCloseTo(cands[0].x, 6);
    expect(det.y).toBeCloseTo(cands[0].y, 6);
  });
});
