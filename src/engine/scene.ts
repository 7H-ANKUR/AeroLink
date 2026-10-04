/**
 * Virtual scene renderer + beacon generator (docs/04 §4.3, §4.4).
 * The scene is a W x H grayscale canvas (PS minimum 2000x2000).
 * Ground truth flows ONLY to the metrics engine — never into detection.
 */
import type { GroundTruthTarget } from './types';
import { makeRng, type Rng } from './rng';

export interface Distractor {
  x: number;
  y: number;
  size: number;
  intensity: number;
}

export interface SceneRenderInput {
  scene: Uint8Array; // sceneWidth*sceneHeight, mutated in place
  background: Uint8Array; // static background layer
  sceneWidth: number;
  sceneHeight: number;
  backgroundLevel: number;
  beacon: GroundTruthTarget;
  beaconSizePx: number;
  /** PS row 9: user-defined target shape (default square). */
  beaconShape: 'square' | 'circle';
  killBeacon: boolean; // debug "kill beacon" — hides the beacon from the scene
  blinkOff: boolean; // beacon blink phase off
  distractors: Distractor[];
  /**
   * Optical point-spread function, Gaussian sigma in px (AI plan Phase 3).
   * Applied to every spot the optics image — beacon and decoys alike. The
   * single-pixel starfield is left sharp. 0 = ideal optics.
   */
  blurSigmaPx?: number;
  /**
   * Exposure smear of the beacon, scene px: its motion RELATIVE to the sensor
   * window over one exposure. Centred on the beacon so the smear does not
   * shift its centroid. {0,0} = no motion blur.
   */
  beaconSmear?: { dx: number; dy: number };
  /** Exposure smear of world-static objects (decoys): the sensor's own slew. */
  staticSmear?: { dx: number; dy: number };
}

export interface SceneInitResult {
  scene: Uint8Array;
  background: Uint8Array; // static background layer (stars/texture)
  distractors: Distractor[];
  startX: number;
  startY: number;
}

export function initScene(
  sceneWidth: number,
  sceneHeight: number,
  backgroundLevel: number,
  distractorCount: number,
  seed: number,
  beaconStart: { x: number | null; y: number | null },
  /**
   * Decoy brightness range, as a fraction of the 200-level stamp.
   *
   * The default (0.36-0.44 -> levels 72-88) is deliberately BELOW the default
   * detection threshold of 90: in the shipped scenarios a decoy is visual
   * texture, and the beacon is the only thing the classical stage can see.
   *
   * Raising it produces decoys that DO clear the threshold, which is the
   * "false bright objects" risk named in the problem statement and the only
   * regime where a learned detector has anything to contribute. Used by the
   * dataset generator and the hard-negative benchmark scenarios; shipped
   * scenarios leave it at the default so their measured gates are unchanged.
   */
  distractorIntensity: { min: number; max: number } = { min: 0.36, max: 0.44 },
): SceneInitResult {
  const rng = makeRng(seed ^ 0x5f3759df);
  const background = new Uint8Array(sceneWidth * sceneHeight);
  // Base level + faint sensor texture so the viewport doesn't look synthetic-flat.
  for (let i = 0; i < background.length; i++) {
    background[i] = backgroundLevel;
  }
  // Sparse dim starfield
  const starCount = Math.floor((sceneWidth * sceneHeight) / 2600);
  for (let s = 0; s < starCount; s++) {
    const sx = Math.floor(rng() * sceneWidth);
    const sy = Math.floor(rng() * sceneHeight);
    const v = backgroundLevel + 8 + Math.floor(rng() * 22);
    background[sy * sceneWidth + sx] = v;
  }

  const distractors: Distractor[] = [];
  for (let d = 0; d < distractorCount; d++) {
    distractors.push({
      x: 100 + rng() * (sceneWidth - 200),
      y: 100 + rng() * (sceneHeight - 200),
      size: 6 + Math.floor(rng() * 10),
      // See `distractorIntensity` above: dim by default so the beacon remains
      // the dominant candidate (product risk: false bright objects, docs/01 §11).
      intensity:
        distractorIntensity.min + rng() * (distractorIntensity.max - distractorIntensity.min),
    });
  }

  // PS row 11: initial target location is user-defined, DEFAULT RANDOM.
  // Randomised on BOTH axes (±220 px of centre) so acquisition is still
  // demonstrable inside the ≤2 s gate without the target being trivially
  // parked on the boresight.
  const startX = beaconStart.x ?? sceneWidth / 2 + (rng() - 0.5) * 440;
  const startY = beaconStart.y ?? sceneHeight / 2 + (rng() - 0.5) * 440;
  return {
    scene: new Uint8Array(background),
    background,
    distractors,
    startX,
    startY,
  };
}

/**
 * Compose frame: background + distractors + beacon. Mutates `scene` in place
 * (single allocation per run; per-frame cost is bounded by beacon+distractor area).
 */
export function renderScene(input: SceneRenderInput): void {
  const { scene, background, sceneWidth, sceneHeight, beacon, beaconSizePx, beaconShape, killBeacon, blinkOff, distractors } = input;
  scene.set(background);
  const sigma = input.blurSigmaPx ?? 0;
  const bs = input.beaconSmear ?? NO_SMEAR;
  const ss = input.staticSmear ?? NO_SMEAR;

  // Distractors (static bright-ish spots)
  for (const d of distractors) {
    const level = Math.round(200 * d.intensity);
    if (isSharp(sigma, ss)) {
      stampSpot(scene, sceneWidth, sceneHeight, d.x, d.y, d.size, level);
    } else {
      stampSoftSpot(scene, sceneWidth, sceneHeight, d.x, d.y, d.size, level, 'square', sigma, ss);
    }
  }

  // Beacon: high-intensity spot (PS default 10x10 square; circle optional)
  if (!killBeacon && !blinkOff && beacon.visible) {
    const level = Math.round(235 * beacon.intensity);
    if (isSharp(sigma, bs)) {
      stampSpot(scene, sceneWidth, sceneHeight, beacon.x_px, beacon.y_px, beaconSizePx, level, beaconShape);
    } else {
      stampSoftSpot(scene, sceneWidth, sceneHeight, beacon.x_px, beacon.y_px, beaconSizePx, level, beaconShape, sigma, bs);
    }
  }
}

const NO_SMEAR = { dx: 0, dy: 0 };

/** Below this the soft path would change nothing visible, so the exact
 *  legacy stamp is used and published frames stay byte-identical. */
function isSharp(sigma: number, smear: { dx: number; dy: number }): boolean {
  return sigma < 0.05 && Math.hypot(smear.dx, smear.dy) < 0.5;
}

// Scratch for the soft stamp, grown on demand (no per-frame allocation once warm).
let softMask = new Float32Array(0);
let softTmp = new Float32Array(0);
let softKernel = new Float32Array(0);

/**
 * Blurred and/or motion-smeared spot (AI plan Phase 3).
 *
 * 1. Coverage: the binary spot shape is swept along the exposure smear in
 *    ~1 px steps and averaged, i.e. the fraction of the exposure each pixel
 *    spent covered. The sweep is centred on (cx, cy) so the smear widens the
 *    spot without moving its centroid.
 * 2. Optics: that coverage is convolved with a separable Gaussian PSF.
 * 3. Composite: each pixel moves from its current value toward `level` by the
 *    resulting fraction, so energy is spread rather than invented — a blurred
 *    spot is dimmer at its peak, which is exactly what makes it harder to see.
 */
function stampSoftSpot(
  scene: Uint8Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  size: number,
  level: number,
  shape: 'square' | 'circle',
  sigma: number,
  smear: { dx: number; dy: number },
): void {
  const half = size / 2;
  const kr = sigma >= 0.05 ? Math.ceil(3 * sigma) : 0;
  const pad = Math.ceil(half + Math.abs(smear.dx) / 2 + Math.abs(smear.dy) / 2) + kr + 2;
  const ox = Math.floor(cx) - pad;
  const oy = Math.floor(cy) - pad;
  const side = 2 * pad + 1;
  const n = side * side;
  if (softMask.length < n) {
    softMask = new Float32Array(n);
    softTmp = new Float32Array(n);
  }
  const mask = softMask;
  mask.fill(0, 0, n);

  // 1. coverage along the smear path
  const len = Math.hypot(smear.dx, smear.dy);
  const samples = Math.max(1, Math.ceil(len));
  const wSample = 1 / samples;
  const r2 = half * half;
  for (let s = 0; s < samples; s++) {
    const f = samples === 1 ? 0 : s / (samples - 1) - 0.5;
    const sx = cx + smear.dx * f;
    const sy = cy + smear.dy * f;
    const x0 = Math.floor(sx - half);
    const x1 = Math.ceil(sx + half) - 1;
    const y0 = Math.floor(sy - half);
    const y1 = Math.ceil(sy + half) - 1;
    for (let y = y0; y <= y1; y++) {
      const my = y - oy;
      if (my < 0 || my >= side) continue;
      for (let x = x0; x <= x1; x++) {
        const mx = x - ox;
        if (mx < 0 || mx >= side) continue;
        if (shape === 'circle') {
          const dx = x + 0.5 - sx;
          const dy = y + 0.5 - sy;
          if (dx * dx + dy * dy > r2) continue;
        }
        mask[my * side + mx] += wSample;
      }
    }
  }

  // 2. separable Gaussian PSF
  if (kr > 0) {
    const klen = 2 * kr + 1;
    if (softKernel.length < klen) softKernel = new Float32Array(klen);
    const k = softKernel;
    let ksum = 0;
    for (let i = -kr; i <= kr; i++) {
      const v = Math.exp(-(i * i) / (2 * sigma * sigma));
      k[i + kr] = v;
      ksum += v;
    }
    for (let i = 0; i < klen; i++) k[i] /= ksum;
    const tmp = softTmp;
    for (let y = 0; y < side; y++) {
      const row = y * side;
      for (let x = 0; x < side; x++) {
        let acc = 0;
        for (let i = -kr; i <= kr; i++) {
          const xx = x + i;
          if (xx >= 0 && xx < side) acc += mask[row + xx] * k[i + kr];
        }
        tmp[row + x] = acc;
      }
    }
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        let acc = 0;
        for (let i = -kr; i <= kr; i++) {
          const yy = y + i;
          if (yy >= 0 && yy < side) acc += tmp[yy * side + x] * k[i + kr];
        }
        mask[y * side + x] = acc;
      }
    }
  }

  // 3. composite onto the scene
  for (let my = 0; my < side; my++) {
    const y = oy + my;
    if (y < 0 || y >= h) continue;
    const rowOff = y * w;
    for (let mx = 0; mx < side; mx++) {
      const x = ox + mx;
      if (x < 0 || x >= w) continue;
      const m = mask[my * side + mx];
      if (m <= 0.002) continue;
      const cur = scene[rowOff + x];
      const v = cur + (level - cur) * (m > 1 ? 1 : m);
      scene[rowOff + x] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
  }
}

function stampSpot(
  scene: Uint8Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  size: number,
  level: number,
  shape: 'square' | 'circle' = 'square',
): void {
  const half = size / 2;
  const x0 = Math.max(0, Math.floor(cx - half));
  const x1 = Math.min(w - 1, Math.ceil(cx + half) - 1);
  const y0 = Math.max(0, Math.floor(cy - half));
  const y1 = Math.min(h - 1, Math.ceil(cy + half) - 1);
  const r2 = half * half;
  for (let y = y0; y <= y1; y++) {
    const rowOff = y * w;
    for (let x = x0; x <= x1; x++) {
      if (shape === 'circle') {
        // pixel-centre test keeps the disc area ≈ πr², so the detector's
        // size-affinity score still sees a spot of the configured scale
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy > r2) continue;
      }
      scene[rowOff + x] = level;
    }
  }
}

export function makeBeacon(id: number, x: number, y: number, intensity: number): GroundTruthTarget {
  return { id, x_px: x, y_px: y, vx_px_s: 0, vy_px_s: 0, visible: true, intensity };
}

export type { Rng };
