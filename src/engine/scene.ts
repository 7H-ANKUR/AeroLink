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
  beaconShape: 'square';
  killBeacon: boolean; // debug "kill beacon" — hides the beacon from the scene
  blinkOff: boolean; // beacon blink phase off
  distractors: Distractor[];
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
  beaconStart: { x: number | null; y: number },
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
      // dim decoys — strictly below the default detection threshold (90) so
      // the beacon remains the dominant candidate; decoys are visual texture
      // plus a tunable false-candidate source when users lower the threshold
      // (product risk: false bright objects, docs/01 §11)
      intensity: 0.36 + rng() * 0.08,
    });
  }

  const startX = beaconStart.x ?? sceneWidth / 2 + (rng() - 0.5) * 440; // IMPL: random start ±220 px of center for ≤2 s acquisition demos
  return {
    scene: new Uint8Array(background),
    background,
    distractors,
    startX,
    startY: beaconStart.y,
  };
}

/**
 * Compose frame: background + distractors + beacon. Mutates `scene` in place
 * (single allocation per run; per-frame cost is bounded by beacon+distractor area).
 */
export function renderScene(input: SceneRenderInput): void {
  const { scene, background, sceneWidth, sceneHeight, beacon, beaconSizePx, killBeacon, blinkOff, distractors } = input;
  scene.set(background);

  // Distractors (static bright-ish spots)
  for (const d of distractors) {
    stampSpot(scene, sceneWidth, sceneHeight, d.x, d.y, d.size, Math.round(200 * d.intensity));
  }

  // Beacon: high-intensity square spot (PS default 10x10)
  if (!killBeacon && !blinkOff && beacon.visible) {
    const level = Math.round(235 * beacon.intensity);
    stampSpot(scene, sceneWidth, sceneHeight, beacon.x_px, beacon.y_px, beaconSizePx, level);
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
): void {
  const half = size / 2;
  const x0 = Math.max(0, Math.floor(cx - half));
  const x1 = Math.min(w - 1, Math.ceil(cx + half) - 1);
  const y0 = Math.max(0, Math.floor(cy - half));
  const y1 = Math.min(h - 1, Math.ceil(cy + half) - 1);
  // Soft edge: full intensity core, quick falloff ring for anti-aliasing
  for (let y = y0; y <= y1; y++) {
    const rowOff = y * w;
    for (let x = x0; x <= x1; x++) {
      scene[rowOff + x] = level;
    }
  }
}

export function makeBeacon(id: number, x: number, y: number, intensity: number): GroundTruthTarget {
  return { id, x_px: x, y_px: y, vx_px_s: 0, vy_px_s: 0, visible: true, intensity };
}

export type { Rng };
