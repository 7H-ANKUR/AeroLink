/**
 * ScenarioConfig — validated configuration object (docs/04 §4.2, §9).
 * Every value is labeled PS-OFFICIAL (from the problem statement) or
 * IMPL (implementation choice) per docs/01 §10.
 */
import { z } from 'zod';
import type {
  AtmosphereMode,
  DetectorKind,
  MotionMode,
  PlatformMotionMode,
  SearchPattern,
} from './types';

export const scenarioConfigSchema = z
  .object({
    scenarioName: z.string().min(1).max(80),
    seed: z.number().int().min(0).max(2 ** 31 - 1),
    durationS: z.number().min(5).max(600),

    scene: z.object({
      // PS-OFFICIAL: minimum screen size 2000 x 2000 px
      width: z.number().int().min(1000).max(4096),
      height: z.number().int().min(1000).max(4096),
      distractorCount: z.number().int().min(0).max(12),
      backgroundLevel: z.number().int().min(0).max(80),
    }),

    camera: z.object({
      // PS-OFFICIAL: 640 x 480 default, user-defined optional
      resolutionWidth: z.number().int().min(160).max(1280),
      resolutionHeight: z.number().int().min(120).max(1024),
      // PS-OFFICIAL: user-defined FOV, default 4 x 3 deg
      fovXDeg: z.number().min(0.5).max(30),
      fovYDeg: z.number().min(0.5).max(30),
      // PS-OFFICIAL: >= 30 Hz camera update rate
      updateHz: z.number().min(10).max(120),
      // PS-OFFICIAL: default max pan/tilt speed 5 deg/s
      maxPanSpeedDegS: z.number().min(0.5).max(30),
      maxTiltSpeedDegS: z.number().min(0.5).max(30),
      monochrome: z.boolean(),
    }),

    beacon: z.object({
      count: z.number().int().min(1).max(5),
      // PS-OFFICIAL: default square, default 10 x 10 px
      sizePx: z.number().int().min(2).max(60),
      intensity: z.number().min(0.2).max(1),
      // PS-OFFICIAL: 4 required motions + optional extras
      motion: z.enum(['straight', 'circular', 'figure8', 'random', 'spiral', 'sinusoidal']),
      speed: z.number().min(0.1).max(8), // motion speed multiplier (IMPL)
      startX: z.number().nullable(), // null = random within scene (IMPL)
      startY: z.number().nullable(),
      blinkPeriodS: z.number().min(0).max(30), // 0 = never blinks (IMPL; enables loss demos)
    }),

    tracking: z
      .object({
        detector: z.enum(['cv_classical']),
        tracker: z.enum(['kalman_cv']),
        controller: z.enum(['pid_angle_space']),
        // IMPL defaults; all user-tunable
        lockRadiusPx: z.number().min(1).max(120),
        acquisitionConfirmFrames: z.number().int().min(1).max(30),
        candidateDisconfirmFrames: z.number().int().min(1).max(60),
        lostTimeoutFrames: z.number().int().min(1).max(120),
        searchPattern: z.enum(['raster', 'spiral']),
        countPredictionAsLocked: z.boolean(),
        threshold: z.number().int().min(20).max(250),
        minAreaPx: z.number().int().min(1).max(500),
        maxAreaPx: z.number().int().min(10).max(20000),
        kalmanQ: z.number().min(0.0001).max(50),
        kalmanR: z.number().min(0.01).max(500),
        kp: z.number().min(0).max(20),
        ki: z.number().min(0).max(10),
        kd: z.number().min(0).max(10),
        deadbandDeg: z.number().min(0).max(2),
      })
      .refine((t) => t.minAreaPx <= t.maxAreaPx, {
        message: 'min area must be <= max area',
        path: ['minAreaPx'],
      }),

    noise: z.object({
      saltPepperPercent: z.number().min(0).max(40), // PS-OFFICIAL suggests 10% option
      gaussianSigma: z.number().min(0).max(60), // PS-OFFICIAL max std-dev 20 (gray levels)
      poissonEnabled: z.boolean(),
    }),

    jitter: z.object({
      enabled: z.boolean(),
      maxPxPerFrame: z.number().min(0).max(20), // PS-OFFICIAL: ±20 px/frame max
    }),

    atmosphere: z.object({
      mode: z.enum(['clear', 'haze', 'fog', 'rain', 'low_light']),
      contrastFactor: z.number().min(0.1).max(1.5),
      brightnessFactor: z.number().min(0.1).max(1.5),
    }),

    platformMotion: z.object({
      mode: z.enum(['none', 'linear', 'circular', 'random', 'spiral', 'figure8']),
      maxPxPerFrame: z.number().min(0).max(20), // PS-OFFICIAL: ±20 px/frame max
      speed: z.number().min(0.05).max(4),
    }),

    /** UI debug overlay flags (docs/Frontend-Design §41). */
    debugOverlay: z.object({
      groundTruth: z.boolean(),
      detection: z.boolean(),
      prediction: z.boolean(),
      cameraCenter: z.boolean(),
    }),
  })
  .refine((c) => c.camera.fovYDeg <= c.camera.fovXDeg * 1.6 && c.camera.fovXDeg <= c.camera.fovYDeg * 1.6, {
    message: 'FOV aspect should roughly match the sensor aspect',
    path: ['camera', 'fovYDeg'],
  })
  .refine(
    (c) =>
      c.beacon.sizePx < Math.min(c.camera.resolutionWidth, c.camera.resolutionHeight) / 4,
    { message: 'beacon too large for camera resolution', path: ['beacon', 'sizePx'] },
  );

export type ScenarioConfig = z.infer<typeof scenarioConfigSchema>;

/** Validation result with per-field paths for inline UI errors (docs/03 §7). */
export type ConfigValidation =
  | { ok: true; config: ScenarioConfig }
  | { ok: false; errors: { path: string; message: string }[] };

export function validateConfig(input: unknown): ConfigValidation {
  const parsed = scenarioConfigSchema.safeParse(input);
  if (parsed.success) return { ok: true, config: parsed.data };
  const errors: { path: string; message: string }[] = [];
  for (const issue of parsed.error.issues) {
    errors.push({ path: issue.path.join('.'), message: issue.message });
  }
  return { ok: false, errors };
}

/** IMPL defaults — labeled per docs/01 §10. */
export const DEFAULT_CONFIG: ScenarioConfig = {
  scenarioName: 'PS169-03 Figure-8 / Clear',
  seed: 42,
  durationS: 60,
  scene: {
    width: 2000, // PS-OFFICIAL minimum screen size
    height: 2000,
    distractorCount: 2,
    backgroundLevel: 18,
  },
  camera: {
    resolutionWidth: 640, // PS-OFFICIAL default resolution
    resolutionHeight: 480,
    fovXDeg: 4.0, // PS-OFFICIAL default FOV
    fovYDeg: 3.0,
    updateHz: 30, // PS-OFFICIAL minimum update rate
    maxPanSpeedDegS: 5.0, // PS-OFFICIAL default max speed
    maxTiltSpeedDegS: 5.0,
    monochrome: true, // PS-OFFICIAL monochrome focal-plane array
  },
  beacon: {
    count: 1,
    sizePx: 10, // PS-OFFICIAL default 10x10 px
    intensity: 1.0,
    motion: 'figure8',
    speed: 1.2,
    startX: null,
    startY: null,
    blinkPeriodS: 0,
  },
  tracking: {
    detector: 'cv_classical',
    tracker: 'kalman_cv',
    controller: 'pid_angle_space',
    lockRadiusPx: 10, // PS target: tracking error <= 10 px
    acquisitionConfirmFrames: 3,
    candidateDisconfirmFrames: 8,
    lostTimeoutFrames: 30,
    searchPattern: 'raster',
    countPredictionAsLocked: true,
    threshold: 90,
    minAreaPx: 4,
    maxAreaPx: 1200,
    kalmanQ: 0.6,
    kalmanR: 4.0,
    kp: 2.2,
    ki: 0.25,
    kd: 0.35,
    deadbandDeg: 0.02,
  },
  noise: {
    saltPepperPercent: 0,
    gaussianSigma: 0,
    poissonEnabled: false,
  },
  jitter: { enabled: false, maxPxPerFrame: 8 },
  atmosphere: { mode: 'clear', contrastFactor: 1.0, brightnessFactor: 1.0 },
  platformMotion: { mode: 'none', maxPxPerFrame: 8, speed: 0.4 },
  debugOverlay: {
    groundTruth: true,
    detection: true,
    prediction: true,
    cameraCenter: true,
  },
};

export function motionLabel(m: MotionMode): string {
  switch (m) {
    case 'straight':
      return 'Straight';
    case 'circular':
      return 'Circular';
    case 'figure8':
      return 'Figure-8';
    case 'random':
      return 'Random';
    case 'spiral':
      return 'Spiral';
    case 'sinusoidal':
      return 'Sinusoidal';
  }
}

export function atmosphereLabel(a: AtmosphereMode): string {
  switch (a) {
    case 'clear':
      return 'Clear';
    case 'haze':
      return 'Haze';
    case 'fog':
      return 'Fog';
    case 'rain':
      return 'Rain';
    case 'low_light':
      return 'Low Light';
  }
}

export function platformLabel(p: PlatformMotionMode): string {
  switch (p) {
    case 'none':
      return 'Static';
    case 'linear':
      return 'Linear';
    case 'circular':
      return 'Circular';
    case 'random':
      return 'Random';
    case 'spiral':
      return 'Spiral';
    case 'figure8':
      return 'Figure-8';
  }
}

export function searchLabel(s: SearchPattern): string {
  return s === 'raster' ? 'Raster' : 'Spiral';
}

export function detectorLabel(d: DetectorKind): string {
  return d === 'cv_classical' ? 'Classical CV' : d;
}
