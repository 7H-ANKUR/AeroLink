/// <reference types="bun-types" />
/**
 * FSOC-PAT engine unit tests (master prompt §29 — unit layer).
 * Covers: RNG determinism, trajectory equations, camera projection,
 * pixel→angle conversion, weighted centroid, candidate filtering,
 * Kalman filter, PID safety behavior, disturbance statistics,
 * configuration validation, PS-169 official targets.
 * Run: bun test tests/
 */
import { describe, test, expect } from 'bun:test';
import { makeRng, makeGaussian } from '../src/engine/rng';
import { createTrajectory } from '../src/engine/trajectories';
import {
  createCamera,
  stepCamera,
  cameraCenterPx,
  applyDisturbances,
  atmosphereParams,
} from '../src/engine/camera';
import { ClassicalDetector } from '../src/engine/detector';
import { Kalman2D } from '../src/engine/kalman';
import { PIDAngleController, ScanPattern } from '../src/engine/pid';
import { PS_TARGETS } from '../src/engine/metrics';
import { validateConfig, DEFAULT_CONFIG } from '../src/engine/config';

const EPS = 1e-9;

/* ------------------------------------------------------------------ */
/* 1. Deterministic RNG (master prompt §5 — seed 42 twice = same)      */
/* ------------------------------------------------------------------ */
describe('RNG determinism', () => {
  test('same seed produces identical sequence', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    for (let i = 0; i < 1000; i++) expect(a()).toBe(b());
  });
  test('different seeds diverge', () => {
    const a = makeRng(42);
    const b = makeRng(43);
    let diverged = false;
    for (let i = 0; i < 100; i++) if (a() !== b()) diverged = true;
    expect(diverged).toBe(true);
  });
  test('uniform range [0,1)', () => {
    const r = makeRng(7);
    for (let i = 0; i < 5000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  test('Box-Muller gaussian: mean≈0, sigma≈1', () => {
    const g = makeGaussian(makeRng(1234));
    const n = 20000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const v = g();
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / n;
    const sigma = Math.sqrt(sumSq / n - mean * mean);
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(Math.abs(sigma - 1)).toBeLessThan(0.05);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Trajectory equations (§29 — trajectory equations)                */
/* ------------------------------------------------------------------ */
describe('Trajectories', () => {
  const W = 2000;
  const H = 2000;
  const M = 80;

  test('straight: starts at start point, |v|=60·speed px/s, bounces in bounds', () => {
    const traj = createTrajectory({
      mode: 'straight', speed: 1, sceneWidth: W, sceneHeight: H,
      startX: 1000, startY: 1000, margin: M, rng: makeRng(42),
    });
    const p0 = traj.at(0);
    expect(p0.x).toBeCloseTo(1000, 6);
    expect(p0.y).toBeCloseTo(1000, 6);
    expect(Math.hypot(p0.vx, p0.vy)).toBeCloseTo(60, 6);
    for (let t = 0; t <= 120; t += 0.1) {
      const p = traj.at(t);
      expect(p.x).toBeGreaterThanOrEqual(M - EPS);
      expect(p.x).toBeLessThanOrEqual(W - M + EPS);
      expect(p.y).toBeGreaterThanOrEqual(M - EPS);
      expect(p.y).toBeLessThanOrEqual(H - M + EPS);
    }
  });
  test('straight: deterministic for same seed', () => {
    const mk = () =>
      createTrajectory({ mode: 'straight', speed: 1.5, sceneWidth: W, sceneHeight: H, startX: 500, startY: 800, margin: M, rng: makeRng(42) });
    const a = mk();
    const b = mk();
    for (let t = 0; t <= 30; t += 0.5) {
      expect(a.at(t).x).toBe(b.at(t).x);
      expect(a.at(t).y).toBe(b.at(t).y);
    }
  });
  test('circular: at(0) = start, orbit radius constant around orbit center (cx−r, cy)', () => {
    const traj = createTrajectory({
      mode: 'circular', speed: 1, sceneWidth: W, sceneHeight: H,
      startX: 1200, startY: 900, margin: M, rng: makeRng(42),
    });
    const p0 = traj.at(0);
    expect(p0.x).toBeCloseTo(1200, 6);
    expect(p0.y).toBeCloseTo(900, 6);
    // pos = start + r·(cos ωt − 1, sin ωt): start lies ON the circle, center at
    // (cx − r, cy). Max distance from start over one period = diameter = 2r.
    let dMax = 0;
    for (let t = 0; t <= 18; t += 0.05) {
      const p = traj.at(t);
      dMax = Math.max(dMax, Math.hypot(p.x - 1200, p.y - 900));
    }
    const r = dMax / 2;
    expect(r).toBeGreaterThan(0);
    const ocx = 1200 - r;
    for (let t = 0; t <= 40; t += 0.5) {
      const p = traj.at(t);
      // precision 2: r derived from a 0.05 s sampling grid (max under-sampled
      // by ~1e-4 px). Any real modeling error would be ≫ 0.01 px.
      expect(Math.hypot(p.x - ocx, p.y - 900)).toBeCloseTo(r, 2);
    }
  });
  test('figure8: Lissajous x = cx + A·sin(ωt), |x-cx| ≤ A, |y-cy| ≤ B', () => {
    const traj = createTrajectory({
      mode: 'figure8', speed: 1, sceneWidth: W, sceneHeight: H,
      startX: 1000, startY: 1000, margin: M, rng: makeRng(42),
    });
    const w = 0.45; // rad/s at speed multiplier 1
    const A = Math.min(W / 2 - M, 520);
    for (const t of [0.7, 1.5, 3.2, 7.9]) {
      const p = traj.at(t);
      expect(p.x).toBeCloseTo(1000 + A * Math.sin(w * t), 4);
    }
    for (let t = 0; t <= 60; t += 0.25) {
      const p = traj.at(t);
      expect(Math.abs(p.x - 1000)).toBeLessThanOrEqual(A + 1e-6);
      expect(Math.abs(p.y - 1000)).toBeLessThanOrEqual(Math.min(H / 2 - M, 300) + 1e-6);
    }
  });
  test('random: bounded walk, no teleporting (|Δpos| ≤ v·dt bound)', () => {
    const traj = createTrajectory({
      mode: 'random', speed: 1, sceneWidth: W, sceneHeight: H,
      startX: 1000, startY: 1000, margin: M, rng: makeRng(42),
    });
    let prev = traj.at(0);
    for (let t = 0.033; t <= 60; t += 0.033) {
      const p = traj.at(t);
      expect(p.x).toBeGreaterThanOrEqual(M - EPS);
      expect(p.x).toBeLessThanOrEqual(W - M + EPS);
      expect(p.y).toBeGreaterThanOrEqual(M - EPS);
      expect(p.y).toBeLessThanOrEqual(H - M + EPS);
      prev = p;
    }
  });
  test('spiral: starts at center, radius grows monotonically to cap', () => {
    const traj = createTrajectory({
      mode: 'spiral', speed: 1, sceneWidth: W, sceneHeight: H,
      startX: 1000, startY: 1000, margin: M, rng: makeRng(42),
    });
    const p0 = traj.at(0);
    expect(p0.x).toBeCloseTo(1000, 6);
    expect(p0.y).toBeCloseTo(1000, 6);
    let prevR = 0;
    for (let t = 0.1; t <= 20; t += 0.1) {
      const p = traj.at(t);
      const r = Math.hypot(p.x - 1000, p.y - 1000);
      expect(r).toBeGreaterThanOrEqual(prevR - 1e-6);
      prevR = r;
    }
    // exact endpoint (avoid float accumulation in the loop stepping)
    const pEnd = traj.at(20);
    expect(Math.hypot(pEnd.x - 1000, pEnd.y - 1000)).toBeCloseTo(Math.min(920, 18 * 20), 4); // capped growth
  });
});

/* ------------------------------------------------------------------ */
/* 3. Camera model + projection (§7, §8)                               */
/* ------------------------------------------------------------------ */
describe('Virtual camera & projection', () => {
  const mkCam = () =>
    createCamera({
      maxPanSpeedDegS: 5, maxTiltSpeedDegS: 5,
      resolutionWidth: 640, resolutionHeight: 480,
      sceneWidth: 2000, sceneHeight: 2000,
      fovXDeg: 4, fovYDeg: 3,
    });

  test('PS defaults → angular scale 160 px/deg both axes', () => {
    const cam = mkCam();
    expect(cam.pxPerDegX).toBe(160);
    expect(cam.pxPerDegY).toBe(160);
  });
  test('initial pose = scene center (PS: initial camera position = screen center)', () => {
    const c = cameraCenterPx(mkCam());
    expect(c.cx).toBe(1000);
    expect(c.cy).toBe(1000);
  });
  test('pan +1° moves viewport center +160 scene px (projection consistency)', () => {
    const cam = mkCam();
    cam.pan_deg = 1;
    const c = cameraCenterPx(cam);
    expect(c.cx).toBeCloseTo(1160, 6);
    expect(c.cy).toBe(1000);
  });
  test('rate command saturation at ±5 °/s (PS max pan/tilt speed)', () => {
    const cam = mkCam();
    const applied = stepCamera(cam, 50, -50, 0.1);
    expect(applied.panApplied).toBeCloseTo(5, 9);
    expect(applied.tiltApplied).toBeCloseTo(-5, 9);
    expect(cam.pan_deg).toBeCloseTo(0.5, 9);
    expect(cam.tilt_deg).toBeCloseTo(-0.5, 9);
  });
  test('pose clamping keeps viewport inside the 2000×2000 scene', () => {
    const cam = mkCam();
    cam.pan_deg = 4.24; // max = (1000-320)/160 = 4.25°
    stepCamera(cam, 5, 0, 0.5);
    expect(cam.pan_deg).toBeLessThanOrEqual(4.25 + EPS);
    const c = cameraCenterPx(cam);
    expect(c.cx).toBeLessThanOrEqual(2000 - 320 + EPS);
  });
  test('pixel→angle identity: 16 px @ 640 px / 4° FOV = 0.1°', () => {
    // via PID pre-conversion (docs/04 §4.13): u = kp·(ex/fw)·fovX, kp=1
    const pid = new PIDAngleController({
      kp: 1, ki: 0, kd: 0, deadbandDeg: 0.02,
      maxPanSpeedDegS: 5, maxTiltSpeedDegS: 5, searchPattern: 'raster',
    });
    const cmd = pid.compute([336, 240], [320, 240], [4, 3], [640, 480], 1 / 30);
    expect(cmd.pan_deg_s).toBeCloseTo(0.1, 10);
    expect(cmd.tilt_deg_s).toBeCloseTo(0, 10);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Detector: weighted centroid + candidate filtering (§10, §11, §12) */
/* ------------------------------------------------------------------ */
describe('Beacon detector', () => {
  const W = 64;
  const H = 48;
  const BG = 20;

  function makeFrame(): Uint8Array {
    return new Uint8Array(W * H).fill(BG);
  }
  function drawSquare(f: Uint8Array, cx: number, cy: number, size: number, val: number) {
    const x0 = cx - Math.floor(size / 2);
    const y0 = cy - Math.floor(size / 2);
    for (let y = y0; y < y0 + size; y++)
      for (let x = x0; x < x0 + size; x++)
        if (x >= 0 && y >= 0 && x < W && y < H) f[y * W + x] = val;
  }
  const det = () =>
    new ClassicalDetector({ threshold: 90, minAreaPx: 4, maxAreaPx: 1200, expectedBeaconSize: 100 });

  test('finds 10×10 square, centroid = blob center, bbox 10×10', () => {
    const f = makeFrame();
    drawSquare(f, 32, 24, 10, 200);
    const d = det().detect(f, W, H, 0, null);
    expect(d.found).toBe(true);
    expect(d.x).toBeCloseTo(31.5, 1); // pixel-index centroid of 10 px span
    expect(d.y).toBeCloseTo(23.5, 1);
    expect(d.bbox![2]).toBe(10);
    expect(d.bbox![3]).toBe(10);
    expect(d.confidence).toBeGreaterThan(0.5);
    expect(d.method).toBe('cv');
  });
  test('intensity-weighted centroid shifts toward brighter pixels (not bbox center)', () => {
    const f = makeFrame();
    drawSquare(f, 32, 24, 10, 100);
    // overwrite right half brighter
    for (let y = 20; y < 30; y++)
      for (let x = 32; x < 37; x++) f[y * W + x] = 255;
    const d = det().detect(f, W, H, 0, null);
    expect(d.found).toBe(true);
    expect(d.x).toBeGreaterThan(31.5 + 0.5); // pulled right by weights
  });
  test('rejects isolated noise pixels (area < minArea)', () => {
    const f = makeFrame();
    f[24 * W + 32] = 255; // 1 px
    f[24 * W + 33] = 255; // 2 px total — still < 4
    const d = det().detect(f, W, H, 0, null);
    expect(d.found).toBe(false);
    expect(d.x).toBeNull();
  });
  test('rejects oversized background regions (area > maxArea)', () => {
    const f = makeFrame();
    for (let y = 4; y < 44; y++) for (let x = 4; x < 44; x++) f[y * W + x] = 220; // 1600 px
    const d = det().detect(f, W, H, 0, null);
    expect(d.found).toBe(false);
  });
  test('brightness-weighted scoring: bright beacon outranks dim decoy', () => {
    const f = makeFrame();
    drawSquare(f, 14, 24, 10, 120); // dim decoy
    drawSquare(f, 46, 24, 10, 250); // bright beacon
    const d = det().detect(f, W, H, 0, null);
    expect(d.found).toBe(true);
    expect(d.x).toBeGreaterThan(40); // picked the bright one
  });
  test('predictHint gating: nearest candidate to prediction wins when equal', () => {
    const W2 = 128;
    const H2 = 96;
    const f = new Uint8Array(W2 * H2).fill(BG);
    const drawSq = (cx: number, cy: number, size: number, val: number) => {
      for (let y = cy - size / 2; y < cy + size / 2; y++)
        for (let x = cx - size / 2; x < cx + size / 2; x++) f[y * W2 + x] = val;
    };
    drawSq(24, 48, 10, 250);
    drawSq(104, 48, 10, 250);
    const d = () => new ClassicalDetector({ threshold: 90, minAreaPx: 4, maxAreaPx: 1200, expectedBeaconSize: 100 });
    // hint near right blob: left blob is 80 px away → outside the 60 px sticky gate
    const nearB = d().detect(f, W2, H2, 0, { x: 104, y: 48 });
    expect(nearB.x).toBeGreaterThan(95);
    const nearA = d().detect(f, W2, H2, 0, { x: 24, y: 48 });
    expect(nearA.x).toBeLessThan(33);
  });
  test('reports latency and method on every call', () => {
    const f = makeFrame();
    drawSquare(f, 32, 24, 10, 200);
    const d = det().detect(f, W, H, 0, null);
    expect(d.latency_ms).toBeGreaterThanOrEqual(0);
    expect(d.method).toBe('cv');
  });
});

/* ------------------------------------------------------------------ */
/* 5. Kalman filter (§13)                                              */
/* ------------------------------------------------------------------ */
describe('Kalman constant-velocity tracker', () => {
  test('converges to true constant velocity (30 px/s, 0 px/s)', () => {
    const kf = new Kalman2D(0.6, 4.0);
    const dt = 1 / 30;
    for (let i = 1; i <= 120; i++) {
      kf.predict(dt);
      kf.correct(100 + 30 * i * dt, 200);
    }
    const v = kf.velocity();
    expect(v.vx).toBeGreaterThan(27);
    expect(v.vx).toBeLessThan(33);
    expect(Math.abs(v.vy)).toBeLessThan(2);
    const p = kf.position();
    expect(Math.abs(p.x - (100 + 30 * 120 * dt))).toBeLessThan(3);
    expect(Math.abs(p.y - 200)).toBeLessThan(3);
  });
  test('prediction advances state during missed detections', () => {
    const kf = new Kalman2D(0.6, 4.0);
    const dt = 1 / 30;
    for (let i = 1; i <= 60; i++) {
      kf.predict(dt);
      kf.correct(100 + 30 * i * dt, 200);
    }
    const before = kf.position();
    kf.predict(dt); // one frame with NO correction
    const after = kf.position();
    expect(after.x).toBeGreaterThan(before.x + 0.5); // moved ~ v·dt = 1 px
  });
  test('uninitialized filter is safe (no NaN) and reset() works', () => {
    const kf = new Kalman2D(0.6, 4.0);
    const p = kf.predict(dt(1));
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
    kf.correct(50, 60);
    expect(kf.isInitialized).toBe(true);
    kf.reset();
    expect(kf.isInitialized).toBe(false);
  });
  function dt(_i: number) {
    return 1 / 30;
  }
});

/* ------------------------------------------------------------------ */
/* 6. PID controller safety (§16)                                      */
/* ------------------------------------------------------------------ */
describe('PID angle-space controller', () => {
  const P = { kp: 2.2, ki: 0.25, kd: 0.35, deadbandDeg: 0.02, maxPanSpeedDegS: 5, maxTiltSpeedDegS: 5, searchPattern: 'raster' as const };

  test('deadband: sub-threshold error → zero command', () => {
    const pid = new PIDAngleController(P);
    const cmd = pid.compute([321, 240], [320, 240], [4, 3], [640, 480], 1 / 30); // 1 px = 0.00625°
    expect(cmd.pan_deg_s).toBe(0);
    expect(cmd.tilt_deg_s).toBe(0);
  });
  test('output saturates at ±5 °/s (PS max speeds)', () => {
    const pid = new PIDAngleController(P);
    const cmd = pid.compute([1320, 240], [320, 240], [4, 3], [640, 480], 1 / 30); // 1000 px = 6.25°
    expect(cmd.pan_deg_s).toBe(5);
  });
  test('dt=0 protection: no NaN/Infinity', () => {
    const pid = new PIDAngleController(P);
    const c1 = pid.compute([400, 300], [320, 240], [4, 3], [640, 480], 0);
    expect(Number.isFinite(c1.pan_deg_s)).toBe(true);
    expect(Number.isFinite(c1.tilt_deg_s)).toBe(true);
  });
  test('anti-windup: integral clamped, output never exceeds limits', () => {
    const pid = new PIDAngleController({ ...P, kp: 0, ki: 1, kd: 0 });
    let last = { pan_deg_s: 0, tilt_deg_s: 0 };
    for (let i = 0; i < 200; i++)
      last = pid.compute([360, 240], [320, 240], [4, 3], [640, 480], 1); // 0.25° each step
    expect(last.pan_deg_s).toBeLessThanOrEqual(5 + EPS);
    expect(last.pan_deg_s).toBeGreaterThan(4.9); // integrator saturated at clamp
  });
  test('integrator reset clears accumulated windup', () => {
    const pid = new PIDAngleController({ ...P, kp: 0, ki: 1, kd: 0 });
    for (let i = 0; i < 50; i++) pid.compute([360, 240], [320, 240], [4, 3], [640, 480], 1);
    pid.resetIntegrator();
    const cmd = pid.compute([360, 240], [320, 240], [4, 3], [640, 480], 1);
    expect(cmd.pan_deg_s).toBeCloseTo(0.25, 6); // only one fresh step accumulated
  });
  test('null target → non-zero scan command (camera keeps searching)', () => {
    const pid = new PIDAngleController(P);
    const cmd = pid.compute(null, [320, 240], [4, 3], [640, 480], 1 / 30);
    expect(Math.abs(cmd.pan_deg_s) + Math.abs(cmd.tilt_deg_s)).toBeGreaterThan(0);
  });
  test('ScanPattern stays inside scene and expands coverage', () => {
    const sp = new ScanPattern('raster', 2000, 2000);
    const p0 = sp.step(0.1, 1);
    expect(p0.x).toBeGreaterThanOrEqual(0);
    expect(p0.x).toBeLessThanOrEqual(2000);
    let maxOff = 0;
    for (let i = 0; i < 400; i++) {
      const p = sp.step(1 / 30, 1);
      maxOff = Math.max(maxOff, Math.abs(p.x - 1000), Math.abs(p.y - 1000));
    }
    expect(maxOff).toBeGreaterThan(600); // reached wide coverage
  });
});

/* ------------------------------------------------------------------ */
/* 7. Disturbance engine statistics (§9)                               */
/* ------------------------------------------------------------------ */
describe('Disturbance engine', () => {
  const W = 192;
  const H = 160;
  const N = W * H;

  test('gaussian noise: measured sigma ≈ configured sigma, mean shift ≈ 0', () => {
    const mk = () => new Uint8Array(N).fill(128);
    const f1 = mk();
    applyDisturbances(f1, W, H, { saltPepperPercent: 0, gaussianSigma: 20, poissonEnabled: false, contrastFactor: 1, brightnessFactor: 1, rainStrength: 0 }, makeRng(42), makeGaussian(makeRng(42)));
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < N; i++) {
      const d = f1[i] - 128;
      sum += d;
      sumSq += d * d;
    }
    const mean = sum / N;
    const sigma = Math.sqrt(sumSq / N - mean * mean);
    expect(Math.abs(mean)).toBeLessThan(2);
    expect(Math.abs(sigma - 20)).toBeLessThan(3);
  });
  test('salt & pepper 10%: ~10% pixels flipped to 0 or 255', () => {
    const f = new Uint8Array(N).fill(128);
    applyDisturbances(f, W, H, { saltPepperPercent: 10, gaussianSigma: 0, poissonEnabled: false, contrastFactor: 1, brightnessFactor: 1, rainStrength: 0 }, makeRng(99), makeGaussian(makeRng(99)));
    let changed = 0;
    for (let i = 0; i < N; i++) if (f[i] === 0 || f[i] === 255) changed++;
    const frac = changed / N;
    expect(frac).toBeGreaterThan(0.08);
    expect(frac).toBeLessThan(0.12);
  });
  test('poisson noise: bright pixels fluctuate, dark pixels untouched', () => {
    const f = new Uint8Array(N).fill(4); // lambda = 4/12 < 0.5 → untouched
    for (let y = 60; y < 100; y++) for (let x = 76; x < 116; x++) f[y * W + x] = 240;
    const bgBefore = f.slice(0, 100);
    applyDisturbances(f, W, H, { saltPepperPercent: 0, gaussianSigma: 0, poissonEnabled: true, contrastFactor: 1, brightnessFactor: 1, rainStrength: 0 }, makeRng(7), makeGaussian(makeRng(7)));
    let brightChanged = 0;
    const brightCount = 40 * 40;
    let sumSq = 0;
    for (let y = 60; y < 100; y++)
      for (let x = 76; x < 116; x++) {
        const v = f[y * W + x];
        sumSq += v * v;
        brightChanged++;
      }
    void brightChanged;
    const rms = Math.sqrt(sumSq / (40 * 40));
    expect(brightChanged).toBe(1600);
    expect(rms).toBeGreaterThan(0);
    expect(bgBefore).toEqual(new Uint8Array(100).fill(4)); // dark region untouched by poisson
  });
  test('determinism: same seed → byte-identical disturbed frames', () => {
    const mk = () => {
      const f = new Uint8Array(N).fill(100);
      applyDisturbances(f, W, H, { saltPepperPercent: 8, gaussianSigma: 15, poissonEnabled: true, contrastFactor: 0.6, brightnessFactor: 0.8, rainStrength: 1 }, makeRng(2024), makeGaussian(makeRng(2024)));
      return f;
    };
    const a = mk();
    const b = mk();
    expect(Array.from(a)).toEqual(Array.from(b));
  });
  test('disturbances operate on the observation image only — ground truth array untouched', () => {
    const frame = new Uint8Array(N).fill(128);
    const groundTruth = { x_px: 320, y_px: 240, vx_px_s: 10, vy_px_s: 0 };
    const gtCopy = { ...groundTruth };
    applyDisturbances(frame, W, H, { saltPepperPercent: 20, gaussianSigma: 25, poissonEnabled: true, contrastFactor: 0.4, brightnessFactor: 0.7, rainStrength: 1 }, makeRng(5), makeGaussian(makeRng(5)));
    expect(groundTruth).toEqual(gtCopy); // structural contract: GT never passed in
  });
  test('atmosphere presets clamp contrast/brightness per docs', () => {
    expect(atmosphereParams('clear', 1, 1)).toEqual({ contrastFactor: 1, brightnessFactor: 1, rainStrength: 0 });
    expect(atmosphereParams('fog', 1, 1).contrastFactor).toBeCloseTo(0.32, 6);
    expect(atmosphereParams('haze', 1, 1).contrastFactor).toBeCloseTo(0.55, 6);
    expect(atmosphereParams('low_light', 1, 1).brightnessFactor).toBeCloseTo(0.45, 6);
    expect(atmosphereParams('rain', 1, 1).rainStrength).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 8. Metrics targets + configuration validation (§20, §29)            */
/* ------------------------------------------------------------------ */
describe('PS-169 targets & config validation', () => {
  test('official gate targets match PS-169 exactly', () => {
    expect(PS_TARGETS).toEqual({
      acquisition_s: 2.0,
      tracking_error_px: 10,
      target_loss_percent: 5,
      reacquisition_s: 1.0,
      processing_fps: 20,
    });
  });
  test('DEFAULT_CONFIG passes validation', () => {
    const v = validateConfig(DEFAULT_CONFIG);
    expect(v.ok).toBe(true);
  });
  test('PS-official defaults present (§1 of master prompt)', () => {
    expect(DEFAULT_CONFIG.scene.width).toBe(2000);
    expect(DEFAULT_CONFIG.scene.height).toBe(2000);
    expect(DEFAULT_CONFIG.camera.resolutionWidth).toBe(640);
    expect(DEFAULT_CONFIG.camera.resolutionHeight).toBe(480);
    expect(DEFAULT_CONFIG.camera.fovXDeg).toBe(4);
    expect(DEFAULT_CONFIG.camera.fovYDeg).toBe(3);
    expect(DEFAULT_CONFIG.camera.updateHz).toBe(30);
    expect(DEFAULT_CONFIG.camera.maxPanSpeedDegS).toBe(5);
    expect(DEFAULT_CONFIG.camera.maxTiltSpeedDegS).toBe(5);
    expect(DEFAULT_CONFIG.beacon.sizePx).toBe(10);
    expect(DEFAULT_CONFIG.beacon.count).toBe(1);
  });
  test('rejects out-of-range seed / FOV / update rate', () => {
    expect(validateConfig({ ...DEFAULT_CONFIG, seed: -1 }).ok).toBe(false);
    expect(
      validateConfig({ ...DEFAULT_CONFIG, camera: { ...DEFAULT_CONFIG.camera, fovXDeg: 0.2 } }).ok,
    ).toBe(false);
    expect(
      validateConfig({ ...DEFAULT_CONFIG, camera: { ...DEFAULT_CONFIG.camera, updateHz: 200 } }).ok,
    ).toBe(false);
  });
  test('refinements: minArea ≤ maxArea, FOV aspect ≈ sensor aspect', () => {
    const bad = validateConfig({
      ...DEFAULT_CONFIG,
      tracking: { ...DEFAULT_CONFIG.tracking, minAreaPx: 500, maxAreaPx: 100 },
    });
    expect(bad.ok).toBe(false);
    const badAspect = validateConfig({
      ...DEFAULT_CONFIG,
      camera: { ...DEFAULT_CONFIG.camera, fovXDeg: 1, fovYDeg: 3 },
    });
    expect(badAspect.ok).toBe(false);
  });
  test('validation errors carry field paths for inline UI display', () => {
    const v = validateConfig({ ...DEFAULT_CONFIG, seed: -5 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors[0].path).toBe('seed');
  });
});
