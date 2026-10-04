/**
 * plan2 — the ONNX Runtime Web path, end to end, on real simulation frames.
 *
 *   camera frame → classical CV → AI inference (ORT) → fusion → Kalman → LOS
 *     → PID → mount → camera update
 *
 * These tests use the SAME adapter the browser worker uses
 * (src/lib/ort-runtime.ts, onnxruntime-web WASM backend) and the SAME
 * SimulationRunner.stepAsync the worker calls. The browser run itself is
 * exercised by scripts/browser-e2e.ts against the production build.
 */
import { describe, expect, test, beforeAll } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type ScenarioConfig } from '../src/engine/config';
import { SimulationRunner } from '../src/engine/simulation';
import { buildPatchBatch } from '../src/engine/nn';
import { tryLoadModel, tryLoadModelWithOrt } from '../scripts/lib/load-model';
import type { LoadedModel } from '../src/engine/detector-ai';

const ROOT = join(import.meta.dir, '..');
const MODELS = join(ROOT, 'public', 'models');

let ortModel: LoadedModel | null = null;
beforeAll(async () => {
  ortModel = await tryLoadModelWithOrt();
});

const decoyCfg = (seed: number, detector: 'fusion' | 'ai'): ScenarioConfig => ({
  ...DEFAULT_CONFIG,
  seed,
  durationS: 25,
  scene: { ...DEFAULT_CONFIG.scene, distractorCount: 10, distractorIntensityMin: 0.62, distractorIntensityMax: 0.95 },
  tracking: { ...DEFAULT_CONFIG.tracking, detector },
});

describe('ONNX export', () => {
  test('ONNX files exist and match the hashes recorded in onnx-manifest.json', () => {
    const man = JSON.parse(readFileSync(join(MODELS, 'onnx-manifest.json'), 'utf8'));
    for (const name of ['beacon-roi-v2', 'track-verifier-v1']) {
      const entry = man.models[name];
      const bytes = readFileSync(join(MODELS, entry.file));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
      // ...and the source weights they were exported from are the shipped ones.
      const src = readFileSync(join(MODELS, entry.sourceWeights));
      expect(createHash('sha256').update(src).digest('hex')).toBe(entry.sourceWeightsSha256);
    }
  });
});

describe('ONNX Runtime Web inference', () => {
  test('the runtime is really onnxruntime-web, for both networks', () => {
    expect(ortModel).not.toBeNull();
    expect(ortModel!.scorer!.runtime).toContain('onnxruntime-web');
    expect(ortModel!.batchVerifier!.runtime).toContain('onnxruntime-web');
  });

  test('ORT reproduces the PyTorch scores (fixture) and the TS forward pass', async () => {
    const fx = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'ai-parity.json'), 'utf8')) as {
      patches: number[][];
      scores: number[];
    };
    const n = fx.patches.length;
    const batch = new Float32Array(n * 576);
    fx.patches.forEach((p, i) => batch.set(p, i * 576));
    const got = await ortModel!.scorer!.scoreBatch(batch, n);
    const ts = tryLoadModel()!;
    for (let i = 0; i < n; i++) {
      expect(Math.abs(got[i] - fx.scores[i])).toBeLessThan(1e-4);
      expect(Math.abs(got[i] - ts.net.forward(Float32Array.from(fx.patches[i])))).toBeLessThan(1e-4);
    }
  });

  test('scores on an ACTUAL simulation frame: ORT and TS agree ROI by ROI', async () => {
    const sim = new SimulationRunner(decoyCfg(4200, 'ai'), {}, tryLoadModel());
    let st = sim.step(1 / 30);
    for (let i = 0; i < 20; i++) st = sim.step(1 / 30);
    const pts = [
      { x: 320, y: 240 },
      { x: 100, y: 100 },
      { x: 500, y: 400 },
    ];
    const ort = await ortModel!.scorer!.scoreBatch(buildPatchBatch(st.frame, st.width, st.height, pts), pts.length);
    const ts = tryLoadModel()!;
    for (let i = 0; i < pts.length; i++) {
      expect(Math.abs(ort[i] - ts.net.scoreAt(st.frame, st.width, st.height, pts[i].x, pts[i].y))).toBeLessThan(1e-4);
    }
  });
});

describe('plan2 end-to-end chain through ONNX Runtime Web', () => {
  test('frame → CV → AI (ORT) → fusion → Kalman → PID → mount → camera', async () => {
    const sim = new SimulationRunner(decoyCfg(4402, 'fusion'), {}, ortModel);
    const pan0 = sim.camera.pan_deg;
    const tilt0 = sim.camera.tilt_deg;
    let ortFrames = 0;
    let cvAndAiSameFrame = 0;
    let tracked = 0;
    let commanded = 0;
    let mountMoved = 0;
    let lastErr: number | null = null;
    for (let i = 0; i < 300; i++) {
      const st = await sim.stepAsync(1 / 30);
      const p = st.pipeline;
      const pv = p.detection.provenance!;
      // AI scores this frame came from ORT, not from anywhere else.
      if (pv.aiRuntime?.startsWith('onnxruntime-web') && (pv.aiScored ?? 0) > 0) ortFrames++;
      // Both branches reported on the SAME frame (same provenance record).
      if (pv.cv !== null && pv.ai !== null) cvAndAiSameFrame++;
      // The selected candidate became the tracker's measurement...
      if (p.detection.found && p.track.state === 'TRACK' && p.track.x !== null) tracked++;
      // ...the PID produced a command from it...
      if (Math.hypot(p.command.pan_deg_s, p.command.tilt_deg_s) > 0.01) commanded++;
      // ...and the mount actually moved.
      if (Math.hypot(st.mount.actualPanRateDegS, st.mount.actualTiltRateDegS) > 0.01) mountMoved++;
      lastErr = p.errorPx;
    }
    expect(ortFrames).toBeGreaterThan(250);
    expect(cvAndAiSameFrame).toBeGreaterThan(200);
    expect(tracked).toBeGreaterThan(150);
    expect(commanded).toBeGreaterThan(100);
    expect(mountMoved).toBeGreaterThan(100);
    expect(Math.hypot(sim.camera.pan_deg - pan0, sim.camera.tilt_deg - tilt0)).toBeGreaterThan(0.2);
    // ...and it ends on the beacon (this seed starts on a decoy).
    expect(lastErr).not.toBeNull();
    expect(lastErr!).toBeLessThan(15);
  }, 120000);

  test('the ORT path makes the same decisions as the TypeScript path', async () => {
    // Same scenario, same seed; only the inference runtime differs.
    const a = new SimulationRunner(decoyCfg(4301, 'fusion'), {}, tryLoadModel());
    const b = new SimulationRunner(decoyCfg(4301, 'fusion'), {}, ortModel);
    let same = 0;
    const N = 240;
    for (let i = 0; i < N; i++) {
      const sa = a.step(1 / 30).pipeline;
      const sb = (await b.stepAsync(1 / 30)).pipeline;
      const bothNone = !sa.detection.found && !sb.detection.found;
      const close =
        sa.detection.found &&
        sb.detection.found &&
        Math.hypot(sa.detection.x! - sb.detection.x!, sa.detection.y! - sb.detection.y!) < 1e-3;
      if ((bothNone || close) && sa.track.state === sb.track.state) same++;
    }
    expect(same).toBe(N);
  }, 120000);

  test('the runtime adapter never touches ground truth', () => {
    const code = readFileSync(join(ROOT, 'src', 'lib', 'ort-runtime.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(/ground_truth|groundTruth|GroundTruthTarget|gt_x|gt_y|gtTuple/.test(code)).toBe(false);
  });

  test('the ONNX assets the browser loads are present', () => {
    expect(existsSync(join(ROOT, 'public', 'ort', 'ort-wasm-simd-threaded.wasm'))).toBe(true);
    expect(existsSync(join(ROOT, 'public', 'ort', 'ort-wasm-simd-threaded.mjs'))).toBe(true);
  });
});
