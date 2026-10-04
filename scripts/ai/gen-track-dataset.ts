/**
 * Harvest candidate-TRACK training data for the learned track verifier
 * (AI plan Phases 4, 7, 15).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * The CNN judges one crop; the verifier judges a whole track. It has to be
 * trained on tracks produced EXACTLY the way the live hybrid detector
 * produces them, so this script runs the same pieces in the same order —
 * classical candidates, the AI branch's proposer, `mergeBranchCandidates`,
 * CNN scores, `CandidateTrackBank.update`, `CandidateTrackBank.features` —
 * over frames from the shipped SimulationRunner, with the mount pose taken at
 * exposure the same way the pipeline takes it.
 *
 * The camera is driven by the closed loop with the CLASSICAL detector, so
 * the harvested motion includes everything the live system does: locking
 * onto decoys, scanning, following the beacon, shaking.
 *
 * GROUND TRUTH IS USED HERE, AND ONLY HERE — to label each track sample as
 * "this is the beacon" or not. At runtime the verifier sees the eight
 * features and nothing else.
 *
 * Splits use disjoint seed ranges. `test` is LOCKED (Phase 15): the trainer
 * reads it once at the end and never selects on it.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Usage:  bun scripts/ai/gen-track-dataset.ts [--seconds 12] [--stride 3]
 * Output: datasets/tracks/{train,valid,test}.csv
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type ScenarioConfig } from '../../src/engine/config';
import { SimulationRunner } from '../../src/engine/simulation';
import { ClassicalDetector } from '../../src/engine/detector';
import { LocalContrastProposer } from '../../src/engine/proposer';
import { CandidateTrackBank, TRACK_FEATURES, N_TRACK_FEATURES } from '../../src/engine/candidate-tracks';
import { BRANCH_LIMITS, mergeBranchCandidates, scoreAll } from '../../src/engine/detector-ai';
import { makeRng } from '../../src/engine/rng';
import { loadModelOrThrow } from '../lib/load-model';
import type { AtmosphereMode, MotionMode, PlatformMotionMode } from '../../src/engine/types';

const MOTIONS: MotionMode[] = ['straight', 'circular', 'figure8', 'random', 'spiral', 'sinusoidal'];
const ATMOS: AtmosphereMode[] = ['clear', 'clear', 'haze', 'fog', 'rain', 'low_light'];
const PLATFORM: PlatformMotionMode[] = ['none', 'none', 'linear', 'circular', 'random', 'figure8'];
/** A candidate this close to the true beacon centre IS the beacon. */
const LABEL_RADIUS_PX = 6;

const pick = <T,>(rng: () => number, a: T[]): T => a[Math.min(a.length - 1, Math.floor(rng() * a.length))];
const rand = (rng: () => number, lo: number, hi: number): number => lo + rng() * (hi - lo);

function recipe(seed: number): ScenarioConfig {
  const rng = makeRng(seed ^ 0x7ac4);
  const decoys = rng() < 0.75;
  return {
    ...DEFAULT_CONFIG,
    scenarioName: `tracks-${seed}`,
    seed,
    durationS: 600,
    scene: {
      ...DEFAULT_CONFIG.scene,
      distractorCount: decoys ? 6 + Math.floor(rand(rng, 0, 7)) : Math.floor(rand(rng, 0, 4)),
      backgroundLevel: Math.floor(rand(rng, 6, 36)),
      distractorIntensityMin: decoys ? 0.55 : 0.3,
      distractorIntensityMax: decoys ? 0.98 : 0.45,
    },
    camera: { ...DEFAULT_CONFIG.camera, exposureMs: rng() < 0.3 ? rand(rng, 4, 25) : 0 },
    beacon: {
      ...DEFAULT_CONFIG.beacon,
      shape: rng() < 0.5 ? 'square' : 'circle',
      sizePx: Math.floor(rand(rng, 5, 21)),
      intensity: rand(rng, 0.3, 1.0),
      motion: pick(rng, MOTIONS),
      // Include slow beacons so "moving" is not learned as a trivially large
      // number — the verifier has to cope with the whole speed range.
      speed: rng() < 0.2 ? rand(rng, 0.1, 0.4) : rand(rng, 0.4, 3),
      startX: null,
      startY: null,
      blurSigmaPx: rng() < 0.4 ? rand(rng, 0.3, 2.5) : 0,
    },
    tracking: { ...DEFAULT_CONFIG.tracking, detector: 'cv_classical', controllerEnabled: rng() < 0.75 },
    noise: {
      saltPepperPercent: rng() < 0.5 ? rand(rng, 0, 2.5) : 0,
      gaussianSigma: rng() < 0.6 ? rand(rng, 0, 18) : 0,
      poissonEnabled: rng() < 0.3,
    },
    jitter: { enabled: rng() < 0.5, maxPxPerFrame: Math.floor(rand(rng, 2, 21)) },
    atmosphere: { ...DEFAULT_CONFIG.atmosphere, mode: pick(rng, ATMOS) },
    platformMotion: {
      mode: pick(rng, PLATFORM),
      maxPxPerFrame: Math.floor(rand(rng, 2, 14)),
      speed: rand(rng, 0.1, 1.0),
    },
  };
}

function harvest(seeds: number[], seconds: number, stride: number): string[] {
  const model = loadModelOrThrow();
  const rows: string[] = [];
  const feat = new Float32Array(N_TRACK_FEATURES);
  let pos = 0;
  for (let r = 0; r < seeds.length; r++) {
    const cfg = recipe(seeds[r]);
    const sim = new SimulationRunner(cfg, {}, null);
    const W = cfg.camera.resolutionWidth;
    const H = cfg.camera.resolutionHeight;
    const dt = 1 / cfg.camera.updateHz;
    const params = {
      threshold: cfg.tracking.threshold,
      minAreaPx: cfg.tracking.minAreaPx,
      maxAreaPx: cfg.tracking.maxAreaPx,
      expectedBeaconSize: cfg.beacon.sizePx * cfg.beacon.sizePx,
      minConfidence: cfg.tracking.minDetectionConfidence,
    };
    const classical = new ClassicalDetector(params);
    const proposer = new LocalContrastProposer({
      maxProposals: BRANCH_LIMITS.maxAiProposals,
      minContrast: BRANCH_LIMITS.aiMinContrast,
      expectedBeaconSize: params.expectedBeaconSize,
    });
    const bank = new CandidateTrackBank();
    const scores: number[] = [];
    const steps = Math.round(seconds * cfg.camera.updateHz);

    for (let i = 0; i < steps; i++) {
      // Pose at exposure — read before the step, exactly as the packet does.
      const pose = {
        panDeg: sim.camera.pan_deg,
        tiltDeg: sim.camera.tilt_deg,
        pxPerDegX: sim.camera.pxPerDegX,
        pxPerDegY: sim.camera.pxPerDegY,
        width: W,
        height: H,
      };
      const st = sim.step(dt);
      const cands = mergeBranchCandidates(
        classical.detectCandidates(st.frame, W, H, BRANCH_LIMITS.maxCandidates),
        proposer.propose(st.frame, W, H),
      );
      scoreAll(model.net, cands, st.frame, W, H, scores);
      const fb = bank.update(cands, scores, pose, st.timestampS);
      if (i % stride !== 0) continue;

      // ---- GROUND TRUTH -> LABEL ONLY ----
      const gx = st.beacon.x_px - (st.cropCenter.x - W / 2);
      const gy = st.beacon.y_px - (st.cropCenter.y - H / 2);
      const beaconShown = st.beacon.visible && !st.blinkOff;
      for (let k = 0; k < cands.length; k++) {
        const t = fb.trackOf[k];
        if (t.age < 2) continue;
        const isBeacon = beaconShown && Math.hypot(cands[k].x - gx, cands[k].y - gy) <= LABEL_RADIUS_PX ? 1 : 0;
        pos += isBeacon;
        CandidateTrackBank.features(t, feat);
        rows.push(
          `${Array.from(feat, (v) => v.toFixed(5)).join(',')},${isBeacon},${r},${t.age}`,
        );
      }
    }
    if ((r + 1) % 10 === 0) {
      process.stdout.write(`    ${r + 1}/${seeds.length} recipes, ${rows.length} samples (${pos} beacon)\n`);
    }
  }
  return rows;
}

function main(): void {
  const args = process.argv.slice(2);
  const get = (k: string, d: number) => {
    const i = args.indexOf(k);
    return i >= 0 ? Number(args[i + 1]) : d;
  };
  const seconds = get('--seconds', 12);
  const stride = get('--stride', 3);
  const outDir = join('datasets', 'tracks');
  mkdirSync(outDir, { recursive: true });
  const header = [...TRACK_FEATURES, 'label', 'recipe', 'age'].join(',');

  // Disjoint seed ranges: no trajectory or noise stream is shared.
  const splits: Array<[string, number[]]> = [
    ['train', Array.from({ length: 120 }, (_, i) => 2_000_000 + i * 13)],
    ['valid', Array.from({ length: 30 }, (_, i) => 2_500_000 + i * 13)],
    ['test', Array.from({ length: 30 }, (_, i) => 2_900_000 + i * 13)], // LOCKED
  ];
  const t0 = Date.now();
  for (const [name, seeds] of splits) {
    process.stdout.write(`  ${name}: ${seeds.length} recipes x ${seconds}s\n`);
    const rows = harvest(seeds, seconds, stride);
    writeFileSync(join(outDir, `${name}.csv`), [header, ...rows].join('\n') + '\n');
    process.stdout.write(`  ${name}: ${rows.length} samples written\n`);
  }
  process.stdout.write(`\nTrack datasets written to ${outDir} in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
}

main();
