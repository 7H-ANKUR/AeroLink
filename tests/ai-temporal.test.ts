/**
 * Tests for the AI-plan completion work:
 *   Phase 3   optical blur + exposure smear in the renderer
 *   Phase 5   the learned branch's independent local-contrast proposer
 *   Phase 7   world-frame candidate tracks, common-mode removal, clutter map,
 *             deliberate target switching in the tracker
 *   end-to-end: the hybrid detector recovers from the decoy false lock that
 *             every detector previously failed on.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG, type ScenarioConfig } from '../src/engine/config';
import { SimulationRunner } from '../src/engine/simulation';
import { renderScene, makeBeacon } from '../src/engine/scene';
import { LocalContrastProposer } from '../src/engine/proposer';
import { ClassicalDetector, type BeaconCandidate } from '../src/engine/detector';
import { CandidateTrackBank, CLUTTER_MIN_AGE, type TrackBankFrame } from '../src/engine/candidate-tracks';
import type { DetectionProvenance } from '../src/engine/types';
import { Tracker } from '../src/engine/tracker';
import { tryLoadModel } from '../scripts/lib/load-model';

const SW = 400;
const SH = 400;

function render(opts: {
  sigma?: number;
  smear?: { dx: number; dy: number };
  intensity?: number;
  x?: number;
  y?: number;
}): Uint8Array {
  const background = new Uint8Array(SW * SH).fill(18);
  const scene = new Uint8Array(SW * SH);
  renderScene({
    scene,
    background,
    sceneWidth: SW,
    sceneHeight: SH,
    backgroundLevel: 18,
    beacon: makeBeacon(1, opts.x ?? 200.5, opts.y ?? 200.5, opts.intensity ?? 1),
    beaconSizePx: 10,
    beaconShape: 'square',
    killBeacon: false,
    blinkOff: false,
    distractors: [],
    blurSigmaPx: opts.sigma ?? 0,
    beaconSmear: opts.smear ?? { dx: 0, dy: 0 },
  });
  return scene;
}

function centroid(img: Uint8Array): { x: number; y: number; peak: number; spread: number } {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let peak = 0;
  let spread = 0;
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      const v = img[y * SW + x] - 18;
      if (v <= 0) continue;
      sw += v;
      sx += x * v;
      sy += y * v;
      if (v > peak) peak = v;
      spread++;
    }
  }
  return { x: sx / sw, y: sy / sw, peak, spread };
}

describe('Phase 3 — optical blur and exposure smear', () => {
  test('zero blur and zero smear are byte-identical to the legacy stamp', () => {
    // Published benchmarks were measured with the legacy renderer; the new
    // path must not change a single pixel when it is switched off.
    const a = render({});
    const b = render({ sigma: 0, smear: { dx: 0, dy: 0 } });
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
  });

  test('blur spreads energy and lowers the peak without moving the centroid', () => {
    const sharp = centroid(render({}));
    const blurred = centroid(render({ sigma: 2.5 }));
    expect(blurred.spread).toBeGreaterThan(sharp.spread);
    expect(blurred.peak).toBeLessThan(sharp.peak);
    expect(Math.abs(blurred.x - sharp.x)).toBeLessThan(0.3);
    expect(Math.abs(blurred.y - sharp.y)).toBeLessThan(0.3);
  });

  test('smear elongates the spot along the motion and keeps it centred', () => {
    const s = centroid(render({ smear: { dx: 16, dy: 0 } }));
    const sharp = centroid(render({}));
    expect(s.spread).toBeGreaterThan(sharp.spread);
    expect(Math.abs(s.x - sharp.x)).toBeLessThan(0.6);
    expect(Math.abs(s.y - sharp.y)).toBeLessThan(0.3);
  });

  test('exposure smear follows the mount slew for static objects', () => {
    // Same seed, same slew: with an exposure time the static decoys smear.
    const base: ScenarioConfig = {
      ...DEFAULT_CONFIG,
      seed: 5,
      scene: { ...DEFAULT_CONFIG.scene, distractorCount: 12, distractorIntensityMin: 0.9, distractorIntensityMax: 0.95 },
    };
    const run = (exposureMs: number) => {
      const sim = new SimulationRunner({ ...base, camera: { ...base.camera, exposureMs } });
      let st = sim.step(1 / 30);
      for (let i = 0; i < 20; i++) st = sim.step(1 / 30); // SEARCH is slewing
      let lit = 0;
      for (let i = 0; i < st.frame.length; i++) if (st.frame[i] > 40) lit++;
      return lit;
    };
    expect(run(25)).toBeGreaterThan(run(0));
  });
});

describe('Phase 5 — the learned branch proposes on its own', () => {
  test('finds a beacon BELOW the classical threshold', () => {
    const W = 320;
    const H = 240;
    const frame = new Uint8Array(W * H).fill(18);
    for (let y = 100; y < 110; y++) for (let x = 150; x < 160; x++) frame[y * W + x] = 70; // < 90
    const cv = new ClassicalDetector({ threshold: 90, minAreaPx: 4, maxAreaPx: 1200, expectedBeaconSize: 100, minConfidence: 0.5 });
    expect(cv.detectCandidates(frame, W, H).length).toBe(0);
    const p = new LocalContrastProposer({ maxProposals: 6, minContrast: 18, expectedBeaconSize: 100 });
    const props = p.propose(frame, W, H);
    expect(props.length).toBeGreaterThan(0);
    expect(Math.hypot(props[0].x - 154.5, props[0].y - 104.5)).toBeLessThan(1);
    expect(props[0].source).toBe('ai');
  });

  test('isolated salt noise does not become a proposal', () => {
    const W = 320;
    const H = 240;
    const frame = new Uint8Array(W * H).fill(18);
    for (let k = 0; k < 200; k++) frame[(k * 7919) % (W * H)] = 255;
    const p = new LocalContrastProposer({ maxProposals: 6, minContrast: 18, expectedBeaconSize: 100 });
    expect(p.propose(frame, W, H).length).toBe(0);
  });
});

const cand = (x: number, y: number): BeaconCandidate => ({
  x,
  y,
  bbox: [x - 5, y - 5, 10, 10],
  area: 100,
  maxIntensity: 200,
  aspect: 1,
  sizeScore: 1,
  shapeScore: 1,
  brightnessScore: 0.8,
  cvConfidence: 0.9,
  source: 'cv',
});

describe('Phase 7 — world-frame candidate tracks', () => {
  const pose = (pan: number, tilt = 0) => ({ panDeg: pan, tiltDeg: tilt, pxPerDegX: 160, pxPerDegY: 160, width: 640, height: 480 });

  test('a world-static object reads as static while the camera slews', () => {
    // The receiver pans at 2 deg/s = 320 px/s; a static object therefore
    // moves ACROSS THE IMAGE at 320 px/s. In the world it must read ~0.
    const bank = new CandidateTrackBank();
    let fb: TrackBankFrame | null = null;
    for (let i = 0; i < 30; i++) {
      const pan = (2 * i) / 30;
      const imgX = 320 - pan * 160 + 100; // world x = 100 px
      fb = bank.update([cand(imgX, 240)], [0.9], pose(pan), i / 30);
    }
    expect(fb!.trackOf[0].speedPxS).toBeLessThan(2);
    expect(fb!.trackOf[0].age).toBeGreaterThanOrEqual(29);
  });

  test('a moving object reads its true world speed from a still camera', () => {
    const bank = new CandidateTrackBank();
    let fb: TrackBankFrame | null = null;
    for (let i = 0; i < 30; i++) fb = bank.update([cand(100 + 3 * i, 200)], [0.9], pose(0), i / 30);
    expect(Math.abs(fb!.trackOf[0].speedPxS - 90)).toBeLessThan(3); // 3 px/frame at 30 Hz
  });

  test('frame-wide shake is removed when three or more tracks agree', () => {
    // Three static decoys + one mover, all shaken by the same random offset.
    const bank = new CandidateTrackBank();
    let fb: TrackBankFrame | null = null;
    let s = 1;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 30; // ±15 px
    for (let i = 0; i < 30; i++) {
      const jx = rnd();
      const jy = rnd();
      fb = bank.update(
        [cand(100 + jx, 100 + jy), cand(500 + jx, 120 + jy), cand(300 + jx, 400 + jy), cand(200 + 2 * i + jx, 250 + jy)],
        [0.5, 0.5, 0.5, 0.9],
        pose(0),
        i / 30,
      );
      expect(fb!.commonMode === null || i < 2 || Math.abs(fb!.commonMode!.dx - jx) < 20).toBe(true);
    }
    const speeds = fb!.trackOf.map((t) => t.speedPxS);
    expect(Math.max(speeds[0], speeds[1], speeds[2])).toBeLessThan(10);
    expect(Math.abs(speeds[3] - 60)).toBeLessThan(10);
  });

  test('a mature low-probability track is written into the clutter map', () => {
    const bank = new CandidateTrackBank();
    for (let i = 0; i <= CLUTTER_MIN_AGE + 2; i++) {
      const fb = bank.update([cand(300, 200)], [0.9], pose(0), i / 30);
      fb.trackOf[0].pBeacon = 0.02; // the verifier's verdict
      bank.promoteClutter();
    }
    expect(bank.clutterPoints.length).toBe(1);
    // A later candidate at the same WORLD point is flagged even from a new pose.
    const later = bank.update([cand(300 - 160, 200)], [0.9], pose(1), 10);
    expect(later.onClutter[0]).toBe(true);
  });
});

describe('Phase 7 — deliberate target switch in the tracker', () => {
  const det = (x: number, y: number, newTarget = false) => ({
    found: true, x, y, confidence: 0.9, bbox: null, method: 'fusion' as const, latency_ms: 0, newTarget,
  });

  test('a switch re-confirms instead of blending, and is logged as loss + reacquisition', () => {
    const events: string[] = [];
    const tr = new Tracker(
      { acquisitionConfirmFrames: 3, candidateDisconfirmFrames: 8, lostTimeoutFrames: 30, kalmanQ: 0.6, kalmanR: 4 },
      {
        onLossConfirmed: () => events.push('loss'),
        onReacquired: () => events.push('reacq'),
      },
    );
    let f = 0;
    for (let i = 0; i < 10; i++) tr.update(det(100, 100), f / 30, f++, 1 / 30);
    expect(tr.currentState).toBe('TRACK');
    const s = tr.update(det(400, 300, true), f / 30, f++, 1 / 30);
    expect(s.state).toBe('ACQUIRE');
    // Kalman re-initialised on the new target, not dragged half-way.
    expect(Math.hypot(s.x! - 400, s.y! - 300)).toBeLessThan(1);
    for (let i = 0; i < 4; i++) tr.update(det(400, 300), f / 30, f++, 1 / 30);
    expect(tr.currentState).toBe('TRACK');
    expect(events).toEqual(['loss', 'reacq']);
  });

  test('detectors that never set newTarget are unaffected', () => {
    const tr = new Tracker({ acquisitionConfirmFrames: 3, candidateDisconfirmFrames: 8, lostTimeoutFrames: 30, kalmanQ: 0.6, kalmanR: 4 });
    let f = 0;
    for (let i = 0; i < 10; i++) tr.update(det(100, 100), f / 30, f++, 1 / 30);
    const s = tr.update(det(140, 100), f / 30, f++, 1 / 30);
    expect(s.state).toBe('TRACK');
  });
});

describe('end-to-end — the hybrid detector escapes the decoy false lock', () => {
  const model = tryLoadModel();
  const decoyCfg = (seed: number, detector: 'cv_classical' | 'fusion'): ScenarioConfig => ({
    ...DEFAULT_CONFIG,
    seed,
    durationS: 25,
    scene: { ...DEFAULT_CONFIG.scene, distractorCount: 10, distractorIntensityMin: 0.62, distractorIntensityMax: 0.95 },
    tracking: { ...DEFAULT_CONFIG.tracking, detector },
  });

  test('seed 4402: classical stays on a decoy; hybrid ends on the beacon', () => {
    if (model === null || !model.verifier) return;
    // Traced failure: the beacon starts out of view, a decoy is locked by
    // frame 3, and the beacon later flies in ~150 px away.
    const run = (d: 'cv_classical' | 'fusion') => {
      const sim = new SimulationRunner(decoyCfg(4402, d), {}, model);
      let lastErr: number | null = null;
      let onBeacon = 0;
      for (let i = 0; i < 750; i++) {
        const st = sim.step(1 / 30);
        lastErr = st.pipeline.errorPx;
        if (i >= 600 && st.pipeline.errorPx !== null && st.pipeline.errorPx <= 10) onBeacon++;
      }
      return { lastErr, onBeacon };
    };
    const cv = run('cv_classical');
    const hy = run('fusion');
    expect(cv.lastErr === null || cv.lastErr > 50).toBe(true);
    expect(hy.onBeacon).toBeGreaterThan(120); // on the beacon for most of the last 5 s
  }, 120000);

  test('the hybrid provenance carries the temporal evidence it acted on', () => {
    if (model === null || !model.verifier) return;
    const sim = new SimulationRunner(decoyCfg(4200, 'fusion'), {}, model);
    let p: DetectionProvenance | null | undefined = null;
    for (let i = 0; i < 120; i++) p = sim.step(1 / 30).pipeline.detection.provenance;
    expect(p).not.toBeNull();
    expect(p!.liveTracks).toBeGreaterThan(0);
    expect(typeof p!.temporalLatencyMs).toBe('number');
    expect(p!.aiBranchCount).not.toBeNull();
  }, 60000);
});
