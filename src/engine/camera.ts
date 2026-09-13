/**
 * Virtual pan/tilt camera (docs/04 §4.5) + disturbance chain (§4.6).
 *
 * Angular scale (docs/MVP-Tech-Doc §6): the sensor samples the scene 1:1,
 * so pixels-per-degree is set by the sensor itself:
 *   pxPerDegX = resolutionWidth / fovX  (640/4 = 160 px/deg at PS defaults)
 * The 2000x2000 scene therefore spans ≈12.5° — the coarse-alignment arena.
 * Control-loop conversions use the FOV directly (docs/04 §4.13).
 */
import { makeGaussian, type Rng } from './rng';

export interface VirtualCamera {
  pan_deg: number;
  tilt_deg: number;
  maxPanSpeedDegS: number;
  maxTiltSpeedDegS: number;
  resolutionWidth: number;
  resolutionHeight: number;
  sceneWidth: number;
  sceneHeight: number;
  pxPerDegX: number;
  pxPerDegY: number;
}

export function createCamera(cfg: {
  maxPanSpeedDegS: number;
  maxTiltSpeedDegS: number;
  resolutionWidth: number;
  resolutionHeight: number;
  sceneWidth: number;
  sceneHeight: number;
  fovXDeg: number;
  fovYDeg: number;
}): VirtualCamera {
  return {
    pan_deg: 0, // PS: initial camera position = screen center
    tilt_deg: 0,
    pxPerDegX: cfg.resolutionWidth / cfg.fovXDeg,
    pxPerDegY: cfg.resolutionHeight / cfg.fovYDeg,
    ...cfg,
  };
}

/**
 * Apply a rate command over dt with speed saturation and pose clamping so the
 * viewport stays inside the scene. Returns the actually-applied rates.
 */
export function stepCamera(
  cam: VirtualCamera,
  panCmdDegS: number,
  tiltCmdDegS: number,
  dtS: number,
): { panApplied: number; tiltApplied: number } {
  const satPan = clampAbs(panCmdDegS, cam.maxPanSpeedDegS);
  const satTilt = clampAbs(tiltCmdDegS, cam.maxTiltSpeedDegS);
  const dPan = satPan * dtS;
  const dTilt = satTilt * dtS;

  const maxPan = (cam.sceneWidth / 2 - cam.resolutionWidth / 2) / cam.pxPerDegX;
  const maxTilt = (cam.sceneHeight / 2 - cam.resolutionHeight / 2) / cam.pxPerDegY;

  const nextPan = clamp(cam.pan_deg + dPan, -maxPan, maxPan);
  const nextTilt = clamp(cam.tilt_deg + dTilt, -maxTilt, maxTilt);
  const panApplied = (nextPan - cam.pan_deg) / (dtS || 1);
  const tiltApplied = (nextTilt - cam.tilt_deg) / (dtS || 1);
  cam.pan_deg = nextPan;
  cam.tilt_deg = nextTilt;
  return { panApplied, tiltApplied };
}

/** Scene-pixel center of the current viewport (before jitter/platform offset). */
export function cameraCenterPx(cam: VirtualCamera): { cx: number; cy: number } {
  return {
    cx: cam.sceneWidth / 2 + cam.pan_deg * cam.pxPerDegX,
    cy: cam.sceneHeight / 2 + cam.tilt_deg * cam.pxPerDegY,
  };
}

/**
 * Crop the sensor window out of the scene into `dst` (w x h grayscale),
 * applying camera jitter and platform-motion pixel offsets.
 */
export function cropFrame(
  scene: Uint8Array,
  sceneWidth: number,
  sceneHeight: number,
  dst: Uint8Array,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
): void {
  const x0 = Math.round(centerX - width / 2);
  const y0 = Math.round(centerY - height / 2);
  for (let y = 0; y < height; y++) {
    const sy = y0 + y;
    const dstRow = y * width;
    if (sy < 0 || sy >= sceneHeight) {
      dst.fill(4, dstRow, dstRow + width); // out-of-scene = deep dark
      continue;
    }
    const srcRow = sy * sceneWidth;
    for (let x = 0; x < width; x++) {
      const sx = x0 + x;
      dst[dstRow + x] = sx < 0 || sx >= sceneWidth ? 4 : scene[srcRow + sx];
    }
  }
}

/**
 * Disturbance chain — composable, pure w.r.t. ground truth (docs/04 §4.6).
 * Order: salt&pepper → gaussian → poisson → atmosphere.
 */
export interface DisturbanceParams {
  saltPepperPercent: number;
  gaussianSigma: number;
  poissonEnabled: boolean;
  contrastFactor: number;
  brightnessFactor: number;
  rainStrength: number; // 0..1 derived from atmosphere mode
}

export interface DisturbanceResult {
  framesDropped: number;
}

export function applyDisturbances(
  frame: Uint8Array,
  width: number,
  height: number,
  p: DisturbanceParams,
  rng: Rng,
  gauss: () => number,
): void {
  const n = frame.length;

  // 1. Salt & pepper (PS suggests ~10% option)
  if (p.saltPepperPercent > 0) {
    const count = Math.floor((p.saltPepperPercent / 100) * n);
    for (let i = 0; i < count; i++) {
      const idx = (rng() * n) | 0;
      frame[idx] = rng() < 0.5 ? 255 : 0;
    }
  }

  // 2. Gaussian zero-mean noise (PS max std-dev 20 gray levels)
  if (p.gaussianSigma > 0) {
    const sigma = p.gaussianSigma;
    for (let i = 0; i < n; i++) {
      let v = frame[i] + gauss() * sigma;
      frame[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }

  // 3. Poisson shot noise approximation (intensity-dependent)
  if (p.poissonEnabled) {
    for (let i = 0; i < n; i++) {
      const lambda = frame[i] / 12; // scale down so variance is visible but bounded
      if (lambda > 0.5) {
        // normal approximation of Poisson for speed
        const noisy = lambda + gauss() * Math.sqrt(lambda);
        let v = (noisy * 12) | 0;
        frame[i] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }

  // 4. Atmosphere: contrast/brightness reduction (docs/MVP-Tech-Doc §9.5)
  if (p.contrastFactor !== 1 || p.brightnessFactor !== 1) {
    const c = p.contrastFactor;
    const b = p.brightnessFactor;
    for (let i = 0; i < n; i++) {
      let v = (frame[i] - 24) * c + 24 * b + (1 - b) * 90;
      frame[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }

  // 5. Rain streaks (light overlay — kept below the default detection
  // threshold so rain degrades contrast without generating a storm of
  // false candidate components)
  if (p.rainStrength > 0) {
    const streaks = Math.floor(70 * p.rainStrength);
    for (let s = 0; s < streaks; s++) {
      let x = (rng() * width) | 0;
      let y = (rng() * height) | 0;
      const len = 5 + ((rng() * 12) | 0);
      for (let l = 0; l < len && y < height; l++) {
        frame[y * width + x] = Math.min(255, frame[y * width + x] + 22 + ((rng() * 26) | 0));
        y += 1;
        x += rng() < 0.25 ? 1 : 0;
      }
    }
  }
}

export function atmosphereParams(
  mode: string,
  contrastFactor: number,
  brightnessFactor: number,
): Pick<DisturbanceParams, 'contrastFactor' | 'brightnessFactor' | 'rainStrength'> {
  switch (mode) {
    case 'haze':
      return { contrastFactor: Math.min(contrastFactor, 0.55), brightnessFactor: Math.min(brightnessFactor, 0.9), rainStrength: 0 };
    case 'fog':
      return { contrastFactor: Math.min(contrastFactor, 0.32), brightnessFactor: Math.min(brightnessFactor, 0.78), rainStrength: 0 };
    case 'rain':
      return { contrastFactor: Math.min(contrastFactor, 0.7), brightnessFactor: Math.min(brightnessFactor, 0.85), rainStrength: 1 };
    case 'low_light':
      return { contrastFactor: Math.min(contrastFactor, 0.8), brightnessFactor: Math.min(brightnessFactor, 0.45), rainStrength: 0 };
    default:
      return { contrastFactor: 1, brightnessFactor: 1, rainStrength: 0 };
  }
}

/** Platform motion: slow additive drift of the camera viewport (docs §4.6). */
export class PlatformMotion {
  private mode: string;
  private maxPx: number;
  private speed: number;
  private phase = 0;

  constructor(mode: string, maxPx: number, speed: number) {
    this.mode = mode;
    this.maxPx = maxPx;
    this.speed = speed;
  }

  /** Returns pixel offset {dx, dy} to add to the viewport center this frame. */
  step(dtS: number): { dx: number; dy: number } {
    this.phase += dtS * this.speed;
    const t = this.phase;
    switch (this.mode) {
      case 'linear':
        return { dx: this.maxPx * Math.sin(t * 0.9) * 0.6, dy: this.maxPx * 0.25 * Math.sin(t * 0.9 + 1.2) };
      case 'circular':
        return { dx: this.maxPx * Math.sin(t), dy: this.maxPx * Math.cos(t) };
      case 'figure8':
        return { dx: this.maxPx * Math.sin(t), dy: this.maxPx * 0.6 * Math.sin(2 * t) };
      case 'spiral':
        return { dx: this.maxPx * t * 0.1 * Math.cos(t) % this.maxPx, dy: this.maxPx * t * 0.1 * Math.sin(t) % this.maxPx };
      case 'random':
        return { dx: this.maxPx * Math.sin(t * 2.7) * Math.cos(t * 0.63), dy: this.maxPx * Math.sin(t * 1.9) * Math.cos(t * 0.87) };
      default:
        return { dx: 0, dy: 0 };
    }
  }
}

function clampAbs(v: number, max: number): number {
  return v > max ? max : v < -max ? -max : v;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function makeGaussFor(rng: Rng): () => number {
  return makeGaussian(rng);
}
