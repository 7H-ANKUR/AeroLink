/**
 * FSOC synthetic dataset generator (AI plan, Phase 3).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * The public Zenodo set is laser-pointer projection on indoor surfaces. It is
 * real optical-spot data, which is exactly what we want for pretraining, but
 * it is NOT the PS-169 domain: no dark sky, no atmospheric attenuation, no
 * sensor noise model, no platform vibration, no competing bright objects.
 *
 * This generator produces the missing half by driving the SHIPPED
 * SimulationRunner — the same scene renderer, the same virtual camera, the
 * same disturbance chain the live system runs. Training data therefore comes
 * from the deployment distribution by construction, not by approximation.
 *
 * GROUND TRUTH IS USED HERE, AND ONLY HERE.
 *
 * This is an offline labelling tool. The beacon's true position is read to
 * write the YOLO label file and for nothing else. At runtime the trained model
 * receives pixels only — see src/engine/detectors.ts and the source-inspection
 * assertions in tests/engine-evidence.test.ts, which fail if ground truth is
 * ever wired into a detector, tracker or controller.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * PHASE 15: a third split, `test_stress`, is generated from a DISJOINT seed
 * range with a harsher recipe (bright decoys always, heavy noise, bad
 * atmosphere, strong blur and smear). It is a locked test set — the training
 * script reads it once, at the end, to report a number, and never selects on
 * it — the synthetic counterpart of the locked 56-image smartphone set.
 *
 * Output: datasets/fsoc_synth/{train,valid,test_stress}/{images,labels} + data.yaml
 * Usage:  bun scripts/gen-synthetic-dataset.ts [--frames N] [--out DIR]
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/engine/config';
import { SimulationRunner } from '../src/engine/simulation';
import { makeRng } from '../src/engine/rng';
import type { ScenarioConfig } from '../src/engine/config';
import type { AtmosphereMode, MotionMode, PlatformMotionMode } from '../src/engine/types';
import { encodeGrayPng } from './lib/png';

const ATMOS: AtmosphereMode[] = ['clear', 'clear', 'haze', 'fog', 'rain', 'low_light'];
const MOTIONS: MotionMode[] = ['straight', 'circular', 'figure8', 'random', 'spiral', 'sinusoidal'];
const PLATFORM: PlatformMotionMode[] = ['none', 'none', 'linear', 'circular', 'random', 'figure8'];

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];
}
function rand(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

/**
 * One randomised recipe. Every axis the plan calls for is varied: beacon
 * position/size/intensity/shape, scene clutter, noise family, atmosphere and
 * motion. The controller is disabled on a large fraction of recipes so the
 * beacon sweeps the whole frame instead of sitting on the boresight — without
 * that the dataset would be almost entirely centre crops.
 */
function makeRecipe(rng: () => number, seed: number): ScenarioConfig {
  const hardNegatives = rng() < 0.45;
  const controllerOn = rng() < 0.35;
  const atmosphere = pick(rng, ATMOS);
  return {
    ...DEFAULT_CONFIG,
    scenarioName: `synth-${seed}`,
    seed,
    durationS: 600,
    scene: {
      ...DEFAULT_CONFIG.scene,
      distractorCount: Math.floor(rand(rng, 0, 13)),
      backgroundLevel: Math.floor(rand(rng, 4, 40)),
      // Hard negatives: decoys that genuinely clear the detection threshold,
      // so the classical stage proposes real false candidates and the learned
      // model has something non-trivial to separate.
      distractorIntensityMin: hardNegatives ? 0.5 : 0.3,
      distractorIntensityMax: hardNegatives ? 0.98 : 0.45,
    },
    beacon: {
      ...DEFAULT_CONFIG.beacon,
      shape: rng() < 0.5 ? 'square' : 'circle',
      sizePx: Math.floor(rand(rng, 5, 21)), // PS row 10: 5-20 px
      // Down to 0.25 so the dim-beacon regime (below the classical threshold)
      // is represented — the AI branch's own proposer exists to find it.
      intensity: rand(rng, 0.25, 1.0),
      motion: pick(rng, MOTIONS),
      speed: rand(rng, 0.2, 2.5),
      startX: null,
      startY: null,
      blinkPeriodS: 0,
      // Phase 3: optical blur on half the recipes.
      blurSigmaPx: rng() < 0.5 ? rand(rng, 0.3, 2.5) : 0,
    },
    camera: {
      ...DEFAULT_CONFIG.camera,
      // Phase 3: exposure smear (motion blur) on 40 % of recipes.
      exposureMs: rng() < 0.4 ? rand(rng, 4, 25) : 0,
    },
    tracking: {
      ...DEFAULT_CONFIG.tracking,
      controllerEnabled: controllerOn,
    },
    noise: {
      saltPepperPercent: rng() < 0.6 ? rand(rng, 0, 3) : 0,
      gaussianSigma: rng() < 0.6 ? rand(rng, 0, 20) : 0, // PS max 20 grey levels
      poissonEnabled: rng() < 0.4,
    },
    jitter: {
      enabled: rng() < 0.5,
      maxPxPerFrame: Math.floor(rand(rng, 2, 21)), // PS max +/-20 px/frame
    },
    atmosphere: {
      mode: atmosphere,
      contrastFactor: DEFAULT_CONFIG.atmosphere.contrastFactor,
      brightnessFactor: DEFAULT_CONFIG.atmosphere.brightnessFactor,
    },
    platformMotion: {
      mode: pick(rng, PLATFORM),
      maxPxPerFrame: Math.floor(rand(rng, 2, 16)),
      speed: rand(rng, 0.1, 1.0),
    },
  };
}

/**
 * Phase 15 stress recipe — the locked synthetic test set. Every axis pushed
 * toward the hard end at once: bright decoys, heavy sensor noise, degraded
 * atmosphere, strong optical blur and exposure smear, dim beacons, shake.
 * Drawn from a seed range no training or validation recipe uses.
 */
function makeStressRecipe(rng: () => number, seed: number): ScenarioConfig {
  const base = makeRecipe(rng, seed);
  return {
    ...base,
    scenarioName: `stress-${seed}`,
    scene: {
      ...base.scene,
      distractorCount: 8 + Math.floor(rand(rng, 0, 5)),
      distractorIntensityMin: 0.6,
      distractorIntensityMax: 0.98,
    },
    beacon: {
      ...base.beacon,
      intensity: rand(rng, 0.3, 0.85),
      blurSigmaPx: rand(rng, 1.0, 3.0),
    },
    camera: { ...base.camera, exposureMs: rand(rng, 10, 30) },
    noise: {
      saltPepperPercent: rand(rng, 1, 4),
      gaussianSigma: rand(rng, 12, 20),
      poissonEnabled: rng() < 0.5,
    },
    jitter: { enabled: true, maxPxPerFrame: Math.floor(rand(rng, 10, 21)) },
    atmosphere: { ...base.atmosphere, mode: pick(rng, ['haze', 'fog', 'rain', 'low_light'] as AtmosphereMode[]) },
  };
}

interface Split {
  name: 'train' | 'valid' | 'test_stress';
  recipes: number;
  seedBase: number;
  stress?: boolean;
}

function main(): void {
  const args = process.argv.slice(2);
  const frameArg = args.indexOf('--frames');
  const outArg = args.indexOf('--out');
  const framesPerRecipe = frameArg >= 0 ? Number(args[frameArg + 1]) : 28;
  const outDir = outArg >= 0 ? args[outArg + 1] : 'datasets/fsoc_synth';

  // Disjoint seed bases: no recipe, and therefore no trajectory or noise
  // stream, is shared between train and valid.
  const splits: Split[] = [
    { name: 'train', recipes: 180, seedBase: 700_000 },
    { name: 'valid', recipes: 45, seedBase: 900_000 },
    // LOCKED (Phase 15): disjoint seeds, harsher recipe, never fitted on.
    { name: 'test_stress', recipes: 40, seedBase: 1_100_000, stress: true },
  ];

  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });

  let grandTotal = 0;
  let grandVisible = 0;
  const startedAt = Date.now();

  for (const split of splits) {
    const imgDir = join(outDir, split.name, 'images');
    const lblDir = join(outDir, split.name, 'labels');
    mkdirSync(imgDir, { recursive: true });
    mkdirSync(lblDir, { recursive: true });

    for (let r = 0; r < split.recipes; r++) {
      const seed = split.seedBase + r * 17;
      const rng = makeRng(seed ^ 0xbeac04);
      const cfg = split.stress ? makeStressRecipe(rng, seed) : makeRecipe(rng, seed);
      const sim = new SimulationRunner(cfg);
      const dt = 1 / cfg.camera.updateHz;
      const W = cfg.camera.resolutionWidth;
      const H = cfg.camera.resolutionHeight;

      // Warm-up so the mount/platform are not all captured from rest.
      const warmup = Math.floor(rand(rng, 5, 60));
      for (let i = 0; i < warmup; i++) sim.step(dt);

      // Stride so consecutive saved frames are not near-duplicates.
      const stride = Math.max(1, Math.floor(rand(rng, 3, 11)));
      let saved = 0;
      let guard = 0;
      while (saved < framesPerRecipe && guard < framesPerRecipe * stride * 4) {
        guard++;
        const st = sim.step(dt);
        if (guard % stride !== 0) continue;

        // ---- GROUND TRUTH -> LABEL ONLY (see the header) ----
        const gx = st.beacon.x_px - (st.cropCenter.x - W / 2);
        const gy = st.beacon.y_px - (st.cropCenter.y - H / 2);
        const size = cfg.beacon.sizePx;
        const inFrame =
          st.beacon.visible &&
          !st.blinkOff &&
          gx >= -size / 2 &&
          gy >= -size / 2 &&
          gx < W + size / 2 &&
          gy < H + size / 2;

        const stem = `synth_${seed}_${String(guard).padStart(5, '0')}`;
        writeFileSync(join(imgDir, `${stem}.png`), encodeGrayPng(st.frame, W, H));

        // YOLO: class cx cy w h, normalised, clipped to the frame. An empty
        // label file is a legitimate negative sample (beacon out of view) and
        // is kept deliberately — the model must learn to emit nothing.
        let label = '';
        if (inFrame) {
          const x0 = Math.max(0, gx - size / 2);
          const y0 = Math.max(0, gy - size / 2);
          const x1 = Math.min(W, gx + size / 2);
          const y1 = Math.min(H, gy + size / 2);
          const bw = x1 - x0;
          const bh = y1 - y0;
          if (bw > 0.5 && bh > 0.5) {
            const cx = (x0 + x1) / 2 / W;
            const cy = (y0 + y1) / 2 / H;
            label = `0 ${cx.toFixed(6)} ${cy.toFixed(6)} ${(bw / W).toFixed(6)} ${(bh / H).toFixed(6)}\n`;
            grandVisible++;
          }
        }
        writeFileSync(join(lblDir, `${stem}.txt`), label);
        saved++;
        grandTotal++;
      }
      if ((r + 1) % 20 === 0) {
        process.stdout.write(
          `  ${split.name}: ${r + 1}/${split.recipes} recipes, ${grandTotal} images\n`,
        );
      }
    }
  }

  writeFileSync(
    join(outDir, 'data.yaml'),
    [
      'train: ../train/images',
      'val: ../valid/images',
      'test: ../test_stress/images   # LOCKED stress split (AI plan Phase 15)',
      '',
      'nc: 1',
      "names: ['Beacon']",
      '',
      '# Generated by scripts/gen-synthetic-dataset.ts from the shipped',
      '# SimulationRunner. Labels are derived from simulator ground truth;',
      '# ground truth is never available to the model at runtime.',
      '',
    ].join('\n'),
  );

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  process.stdout.write(
    `\nFSOC synthetic dataset written to ${outDir}\n` +
      `  images          ${grandTotal}\n` +
      `  with a beacon   ${grandVisible} (${((100 * grandVisible) / grandTotal).toFixed(1)} %)\n` +
      `  empty (negative)${String(grandTotal - grandVisible).padStart(5)}\n` +
      `  elapsed         ${elapsed}s\n`,
  );
}

main();
