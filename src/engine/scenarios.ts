/**
 * Predefined PS-169 scenario library (docs/Frontend-Design §17) plus the
 * ability to derive custom scenarios. Each preset shows seed / duration /
 * disturbance profile / expected difficulty.
 */
import { DEFAULT_CONFIG, type ScenarioConfig } from './config';
import type { MotionMode } from './types';

export type Difficulty = 'low' | 'medium' | 'high' | 'extreme';

export interface ScenarioPreset {
  id: string;
  name: string;
  description: string;
  difficulty: Difficulty;
  config: ScenarioConfig;
}

function base(overrides: {
  name: string;
  motion: MotionMode;
  seed: number;
  durationS?: number;
  noise?: Partial<ScenarioConfig['noise']>;
  jitter?: Partial<ScenarioConfig['jitter']>;
  atmosphere?: Partial<ScenarioConfig['atmosphere']>;
  platform?: Partial<ScenarioConfig['platformMotion']>;
  beacon?: Partial<ScenarioConfig['beacon']>;
  distractors?: number;
  speed?: number;
}): ScenarioConfig {
  const cfg: ScenarioConfig = {
    ...DEFAULT_CONFIG,
    scenarioName: overrides.name,
    seed: overrides.seed,
    durationS: overrides.durationS ?? 60,
    beacon: { ...DEFAULT_CONFIG.beacon, motion: overrides.motion, ...overrides.beacon },
    noise: { ...DEFAULT_CONFIG.noise, ...overrides.noise },
    jitter: { ...DEFAULT_CONFIG.jitter, ...overrides.jitter },
    atmosphere: { ...DEFAULT_CONFIG.atmosphere, ...overrides.atmosphere },
    platformMotion: { ...DEFAULT_CONFIG.platformMotion, ...overrides.platform },
    scene: { ...DEFAULT_CONFIG.scene, distractorCount: overrides.distractors ?? DEFAULT_CONFIG.scene.distractorCount },
  };
  if (overrides.speed !== undefined) cfg.beacon.speed = overrides.speed;
  return cfg;
}

export const SCENARIO_PRESETS: ScenarioPreset[] = [
  {
    id: 'PS169-01',
    name: 'PS169-01 Straight / Clear',
    description: 'Baseline linear traverse, no disturbances. Verification of the full closed loop.',
    difficulty: 'low',
    config: base({ name: 'PS169-01 Straight / Clear', motion: 'straight', seed: 11, distractors: 0, speed: 0.8 }),
  },
  {
    id: 'PS169-02',
    name: 'PS169-02 Circular / Clear',
    description: 'Constant-rate orbit. Exercises steady-state tracking error under continuous turn rate.',
    difficulty: 'low',
    config: base({ name: 'PS169-02 Circular / Clear', motion: 'circular', seed: 22, distractors: 0, speed: 1.0 }),
  },
  {
    id: 'PS169-03',
    name: 'PS169-03 Figure-8 / Clear',
    description: 'Lissajous path with velocity sign reversals. Default demo scenario.',
    difficulty: 'medium',
    config: base({ name: 'PS169-03 Figure-8 / Clear', motion: 'figure8', seed: 42, distractors: 2, speed: 1.2 }),
  },
  {
    id: 'PS169-04',
    name: 'PS169-04 Random / Clear',
    description: 'Bounded random walk with smoothed velocity. Unpredictable target for control robustness.',
    difficulty: 'medium',
    config: base({ name: 'PS169-04 Random / Clear', motion: 'random', seed: 7, distractors: 2, speed: 1.0 }),
  },
  {
    id: 'PS169-05',
    name: 'PS169-05 Gaussian Noise',
    description: 'Straight motion under zero-mean Gaussian sensor noise, sigma 12 gray levels.',
    difficulty: 'medium',
    config: base({ name: 'PS169-05 Gaussian Noise', motion: 'straight', seed: 15, noise: { gaussianSigma: 12 } }),
  },
  {
    id: 'PS169-06',
    name: 'PS169-06 Salt & Pepper',
    description: 'Impulsive salt-and-pepper noise at the PS-suggested 10% of pixels.',
    difficulty: 'high',
    config: base({ name: 'PS169-06 Salt & Pepper', motion: 'straight', seed: 16, noise: { saltPepperPercent: 10 } }),
  },
  {
    id: 'PS169-07',
    name: 'PS169-07 Poisson',
    description: 'Intensity-dependent shot noise. Detector must tolerate multiplicative fluctuation.',
    difficulty: 'medium',
    config: base({ name: 'PS169-07 Poisson', motion: 'circular', seed: 17, noise: { poissonEnabled: true, gaussianSigma: 4 } }),
  },
  {
    id: 'PS169-08',
    name: 'PS169-08 Camera Jitter',
    description: 'Viewport jitter up to ±8 px/frame (PS max ±20). Kalman prediction compensates.',
    difficulty: 'high',
    config: base({ name: 'PS169-08 Camera Jitter', motion: 'figure8', seed: 18, jitter: { enabled: true, maxPxPerFrame: 8 } }),
  },
  {
    id: 'PS169-09',
    name: 'PS169-09 Haze',
    description: 'Moderate contrast loss. Beacon still dominant but background lifts.',
    difficulty: 'medium',
    config: base({ name: 'PS169-09 Haze', motion: 'straight', seed: 19, atmosphere: { mode: 'haze' } }),
  },
  {
    id: 'PS169-10',
    name: 'PS169-10 Fog',
    description: 'Strong contrast and visibility reduction. Detection threshold stress test.',
    difficulty: 'high',
    config: base({ name: 'PS169-10 Fog', motion: 'circular', seed: 20, atmosphere: { mode: 'fog' } }),
  },
  {
    id: 'PS169-11',
    name: 'PS169-11 Rain',
    description: 'Streak overlays plus contrast loss. False-positive candidates from rain streaks.',
    difficulty: 'high',
    config: base({ name: 'PS169-11 Rain', motion: 'figure8', seed: 21, atmosphere: { mode: 'rain' } }),
  },
  {
    id: 'PS169-12',
    name: 'PS169-12 Low Light',
    description: 'Reduced brightness/contrast. SNR collapse with dim beacon.',
    difficulty: 'high',
    config: base({
      name: 'PS169-12 Low Light',
      motion: 'straight',
      seed: 23,
      atmosphere: { mode: 'low_light' },
      beacon: { intensity: 0.85 },
    }),
  },
  {
    id: 'PS169-13',
    name: 'PS169-13 Platform Motion',
    description: 'Linear platform drift up to ±8 px/frame combined with target motion (PS: linear mandatory).',
    difficulty: 'medium',
    config: base({
      name: 'PS169-13 Platform Motion',
      motion: 'circular',
      seed: 24,
      platform: { mode: 'linear', maxPxPerFrame: 8, speed: 0.6 },
    }),
  },
  {
    id: 'PS169-14',
    name: 'PS169-14 High Disturbance',
    description: 'Combined Gaussian + jitter + fog + platform motion + random motion. Stress case.',
    difficulty: 'extreme',
    config: base({
      name: 'PS169-14 High Disturbance',
      motion: 'random',
      seed: 99,
      durationS: 60,
      noise: { gaussianSigma: 10 },
      jitter: { enabled: true, maxPxPerFrame: 10 },
      atmosphere: { mode: 'fog' },
      platform: { mode: 'random', maxPxPerFrame: 8, speed: 0.7 },
      distractors: 3,
    }),
  },
];

export function presetById(id: string): ScenarioPreset | undefined {
  return SCENARIO_PRESETS.find((p) => p.id === id);
}
