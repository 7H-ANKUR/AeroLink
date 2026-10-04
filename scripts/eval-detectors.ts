/**
 * Controlled CLASSICAL vs LEARNED vs HYBRID evaluation (AI plan Phases 2, 9, 11, 12).
 *
 * ────────────────────────────────────────────────────────────────────────
 * "Don't pre-decide the result; let the benchmark tell you what works."
 * This script exists to be able to report that a learned configuration is
 * NOT worth shipping, if that is what the numbers say.
 *
 *   ARM A — PERCEPTION, on identical frames.
 *     Controller disabled, so every detector sees the SAME pixel sequence.
 *     No Kalman prediction is offered. The hybrid detector does get the
 *     (frozen) mount pose, because its temporal verifier is part of its
 *     perception — that is what is being compared.
 *     Reports precision, recall, miss rate, false alarms on empty frames,
 *     localisation and latency.
 *
 *   ARM B — CLOSED LOOP.
 *     The full PAT loop per detector. Bimodal (one bad initial lock sends a
 *     seed to a ~400 px mean error), so MEDIANS are reported and diverged
 *     seeds are counted, not averaged away. Adds correctness-aware measures
 *     that the PS gates do not have: CORRECT acquisition (first time the lock
 *     is actually on the beacon), correct-lock %, correct-lock continuity,
 *     reacquisition, and per-stage latency (CV / AI / temporal / fusion).
 *
 *   MODE 1 vs MODE 2 (Phase 12) — the full-frame network is timed and scored
 *     on a frame subsample (it is ~40x over the frame budget).
 *
 * Ground truth is used the way metrics.ts uses it: to score runs afterwards.
 * It never reaches a detector.
 * ────────────────────────────────────────────────────────────────────────
 *
 * Usage: bun scripts/eval-detectors.ts [--seeds 6] [--seconds 25] [--only id,id]
 * Writes: benchmark-results/detector-comparison/{summary.json,summary.md}
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/engine/config';
import { SimulationRunner } from '../src/engine/simulation';
import { createDetector, type BeaconDetector } from '../src/engine/detectors';
import { nowMs } from '../src/engine/detector';
import { tryLoadModel, tryLoadModelWithOrt } from './lib/load-model';
import type { LoadedModel } from '../src/engine/detector-ai';
import type { ScenarioConfig } from '../src/engine/config';
import type { DetectorKind } from '../src/engine/types';

/** Radius within which a detection counts as finding the real beacon. */
const HIT_RADIUS_PX = 8;
/** Mean error above which a closed-loop run is treated as having diverged. */
const DIVERGED_PX = 50;

interface Condition {
  id: string;
  label: string;
  apply: (c: ScenarioConfig) => ScenarioConfig;
}

const DECOYS = (c: ScenarioConfig): ScenarioConfig => ({
  ...c,
  scene: { ...c.scene, distractorCount: 10, distractorIntensityMin: 0.62, distractorIntensityMax: 0.95 },
});

const CONDITIONS: Condition[] = [
  { id: 'clear', label: 'Clear', apply: (c) => c },
  { id: 'haze', label: 'Haze', apply: (c) => ({ ...c, atmosphere: { ...c.atmosphere, mode: 'haze' } }) },
  { id: 'fog', label: 'Fog', apply: (c) => ({ ...c, atmosphere: { ...c.atmosphere, mode: 'fog' } }) },
  { id: 'rain', label: 'Rain', apply: (c) => ({ ...c, atmosphere: { ...c.atmosphere, mode: 'rain' } }) },
  { id: 'low_light', label: 'Low light', apply: (c) => ({ ...c, atmosphere: { ...c.atmosphere, mode: 'low_light' } }) },
  {
    id: 'noise_heavy',
    label: 'Heavy sensor noise',
    apply: (c) => ({ ...c, noise: { saltPepperPercent: 2.0, gaussianSigma: 18, poissonEnabled: true } }),
  },
  { id: 'jitter', label: 'Camera jitter', apply: (c) => ({ ...c, jitter: { enabled: true, maxPxPerFrame: 16 } }) },
  {
    id: 'blur_smear',
    label: 'Optical blur + motion smear',
    apply: (c) => ({
      ...c,
      beacon: { ...c.beacon, blurSigmaPx: 2.0, speed: 2.0 },
      camera: { ...c.camera, exposureMs: 20 },
    }),
  },
  {
    id: 'dim',
    label: 'Dim beacon (below threshold)',
    apply: (c) => ({ ...c, beacon: { ...c.beacon, intensity: 0.35 } }),
  },
  {
    id: 'blink',
    label: 'Blinking beacon (reacquisition)',
    apply: (c) => ({ ...c, beacon: { ...c.beacon, blinkPeriodS: 4 } }),
  },
  { id: 'decoys_bright', label: 'Bright decoys', apply: DECOYS },
  {
    id: 'decoys_plus_noise',
    label: 'Bright decoys + noise',
    apply: (c) => ({ ...DECOYS(c), noise: { saltPepperPercent: 1.2, gaussianSigma: 14, poissonEnabled: true } }),
  },
  {
    id: 'decoys_jitter',
    label: 'Bright decoys + jitter',
    apply: (c) => ({ ...DECOYS(c), jitter: { enabled: true, maxPxPerFrame: 14 } }),
  },
];

const DETECTOR_PARAMS = (c: ScenarioConfig) => ({
  threshold: c.tracking.threshold,
  minAreaPx: c.tracking.minAreaPx,
  maxAreaPx: c.tracking.maxAreaPx,
  expectedBeaconSize: c.beacon.sizePx * c.beacon.sizePx,
  minConfidence: c.tracking.minDetectionConfidence,
});

interface PerceptionCell {
  condition: string;
  detector: DetectorKind;
  frames: number;
  visibleFrames: number;
  emptyFrames: number;
  tp: number;
  fp: number;
  fn: number;
  /** Detections reported on frames with no visible beacon. */
  falseAlarmsOnEmpty: number;
  precision: number;
  recall: number;
  missRate: number;
  localisationPx: number | null;
  latencyMs: number;
}

async function perceptionArm(
  cond: Condition,
  seeds: number[],
  seconds: number,
  model: LoadedModel | null,
  detectors: DetectorKind[],
): Promise<PerceptionCell[]> {
  const acc = new Map<DetectorKind, PerceptionCell>();
  const locSum = new Map<DetectorKind, number>();
  const latSum = new Map<DetectorKind, number>();
  for (const d of detectors) {
    acc.set(d, {
      condition: cond.label, detector: d, frames: 0, visibleFrames: 0, emptyFrames: 0,
      tp: 0, fp: 0, fn: 0, falseAlarmsOnEmpty: 0, precision: 0, recall: 0, missRate: 0,
      localisationPx: null, latencyMs: 0,
    });
    locSum.set(d, 0);
    latSum.set(d, 0);
  }

  for (const seed of seeds) {
    const base = cond.apply({ ...DEFAULT_CONFIG, scenarioName: `perc-${cond.id}`, seed });
    const cfg: ScenarioConfig = { ...base, durationS: seconds, tracking: { ...base.tracking, controllerEnabled: false } };
    const sim = new SimulationRunner(cfg);
    const dt = 1 / cfg.camera.updateHz;
    const W = cfg.camera.resolutionWidth;
    const H = cfg.camera.resolutionHeight;
    const steps = Math.round(seconds * cfg.camera.updateHz);
    const instances = new Map<DetectorKind, BeaconDetector>();
    for (const d of detectors) instances.set(d, createDetector(d, DETECTOR_PARAMS(cfg), model));

    for (let i = 0; i < steps; i++) {
      const pose = { panDeg: sim.camera.pan_deg, tiltDeg: sim.camera.tilt_deg, pxPerDegX: sim.camera.pxPerDegX, pxPerDegY: sim.camera.pxPerDegY };
      const st = sim.step(dt);
      const gx = st.beacon.x_px - (st.cropCenter.x - W / 2);
      const gy = st.beacon.y_px - (st.cropCenter.y - H / 2);
      const visible = st.beacon.visible && !st.blinkOff && gx >= 0 && gy >= 0 && gx < W && gy < H;
      for (const d of detectors) {
        const cell = acc.get(d)!;
        const inst = instances.get(d)!;
        // No prediction, ever: perception only. The pose is the mount's own.
        inst.setContext?.({ state: 'SEARCH', prediction: null, trackAgeFrames: 0, lostFramesConsecutive: 0, pose, timestampS: st.timestampS });
        const t0 = nowMs();
        // Learned detectors score through the runtime backend when one is
        // attached (ONNX Runtime Web); classical has no learned stage.
        const det = inst.detectAsync && model?.scorer
          ? await inst.detectAsync(st.frame, W, H, t0, null)
          : inst.detect(st.frame, W, H, t0, null);
        latSum.set(d, latSum.get(d)! + det.latency_ms);
        cell.frames++;
        if (visible) cell.visibleFrames++;
        else cell.emptyFrames++;
        if (det.found && det.x !== null && det.y !== null) {
          const dist = Math.hypot(det.x - gx, det.y - gy);
          if (visible && dist <= HIT_RADIUS_PX) {
            cell.tp++;
            locSum.set(d, locSum.get(d)! + dist);
          } else {
            cell.fp++;
            if (!visible) cell.falseAlarmsOnEmpty++;
            else cell.fn++; // a wrong pick on a frame with a beacon is also a miss
          }
        } else if (visible) {
          cell.fn++;
        }
      }
    }
  }

  return detectors.map((d) => {
    const c = acc.get(d)!;
    c.precision = c.tp + c.fp === 0 ? 0 : c.tp / (c.tp + c.fp);
    c.recall = c.visibleFrames === 0 ? 0 : c.tp / c.visibleFrames;
    c.missRate = c.visibleFrames === 0 ? 0 : 1 - c.recall;
    c.localisationPx = c.tp === 0 ? null : locSum.get(d)! / c.tp;
    c.latencyMs = latSum.get(d)! / Math.max(1, c.frames);
    return c;
  });
}

interface LoopCell {
  condition: string;
  detector: DetectorKind;
  seeds: number;
  medianErrorPx: number | null;
  medianLossPct: number | null;
  medianAcquisitionS: number | null;
  /** First time the lock was actually ON the beacon (error <= lock radius). */
  medianCorrectAcqS: number | null;
  /** Frames locked on the beacon / frames the beacon was visible, %. */
  medianCorrectLockPct: number | null;
  /** Longest unbroken run of correct lock, s. */
  medianContinuityS: number | null;
  medianReacqS: number | null;
  divergedSeeds: number;
  perSeedErrorPx: Array<number | null>;
  algorithmFps: number;
  latency: { cvMs: number; aiMs: number; temporalMs: number; fusionMs: number; perceptionMs: number; pipelineMs: number };
}

function median(xs: Array<number | null>): number | null {
  const v = xs.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = v.length >> 1;
  return v.length % 2 === 1 ? v[m] : (v[m - 1] + v[m]) / 2;
}

async function loopArm(
  cond: Condition,
  seeds: number[],
  seconds: number,
  model: LoadedModel | null,
  detectors: DetectorKind[],
): Promise<LoopCell[]> {
  const out: LoopCell[] = [];
  for (const detector of detectors) {
    const errors: Array<number | null> = [];
    const losses: Array<number | null> = [];
    const acqs: Array<number | null> = [];
    const correctAcqs: Array<number | null> = [];
    const correctLocks: Array<number | null> = [];
    const conts: Array<number | null> = [];
    const reacqs: Array<number | null> = [];
    const fps: number[] = [];
    const lat = { cvMs: 0, aiMs: 0, temporalMs: 0, fusionMs: 0, perceptionMs: 0, pipelineMs: 0 };
    let latN = 0;
    let diverged = 0;

    for (const seed of seeds) {
      const base = cond.apply({ ...DEFAULT_CONFIG, scenarioName: `loop-${cond.id}`, seed });
      const cfg: ScenarioConfig = { ...base, durationS: seconds, tracking: { ...base.tracking, detector } };
      const sim = new SimulationRunner(cfg, {}, model);
      const dt = 1 / cfg.camera.updateHz;
      const steps = Math.round(seconds * cfg.camera.updateHz);
      const W = cfg.camera.resolutionWidth;
      const H = cfg.camera.resolutionHeight;
      let correctAcq: number | null = null;
      let lockedOk = 0;
      let visibleN = 0;
      let streak = 0;
      let bestStreak = 0;
      const useAsync = detector !== 'cv_classical' && !!model?.scorer;
      for (let i = 0; i < steps; i++) {
        const st = useAsync ? await sim.stepAsync(dt) : sim.step(dt);
        const gx = st.beacon.x_px - (st.cropCenter.x - W / 2);
        const gy = st.beacon.y_px - (st.cropCenter.y - H / 2);
        const visible = st.beacon.visible && !st.blinkOff && gx >= 0 && gy >= 0 && gx < W && gy < H;
        const p = st.pipeline;
        const onBeacon =
          (p.track.state === 'TRACK' || p.track.state === 'PREDICT_REACQUIRE') &&
          p.errorPx !== null &&
          p.errorPx <= cfg.tracking.lockRadiusPx;
        if (onBeacon && correctAcq === null) correctAcq = st.timestampS;
        if (visible) {
          visibleN++;
          if (onBeacon) lockedOk++;
        }
        streak = onBeacon ? streak + 1 : 0;
        if (streak > bestStreak) bestStreak = streak;
        const pv = p.detection.provenance;
        if (pv) {
          lat.cvMs += pv.cvLatencyMs;
          lat.aiMs += pv.aiLatencyMs;
          lat.temporalMs += pv.temporalLatencyMs ?? 0;
          lat.fusionMs += pv.fusionLatencyMs;
        }
        lat.perceptionMs += p.detection.latency_ms;
        lat.pipelineMs += p.processingMs;
        latN++;
      }
      const r = sim.finalize(`${cfg.scenarioName}/${detector}`);
      errors.push(r.avg_error_px);
      losses.push(r.target_loss_percent);
      acqs.push(r.acquisition_time_s);
      correctAcqs.push(correctAcq);
      correctLocks.push(visibleN > 0 ? (100 * lockedOk) / visibleN : null);
      conts.push(bestStreak / cfg.camera.updateHz);
      reacqs.push(r.reacquisition_avg_s);
      fps.push(r.fps_measured);
      if (r.avg_error_px !== null && r.avg_error_px > DIVERGED_PX) diverged++;
    }
    const n = Math.max(1, latN);
    out.push({
      condition: cond.label,
      detector,
      seeds: seeds.length,
      medianErrorPx: median(errors),
      medianLossPct: median(losses),
      medianAcquisitionS: median(acqs),
      medianCorrectAcqS: median(correctAcqs),
      medianCorrectLockPct: median(correctLocks),
      medianContinuityS: median(conts),
      medianReacqS: median(reacqs),
      divergedSeeds: diverged,
      perSeedErrorPx: errors,
      algorithmFps: fps.reduce((a, b) => a + b, 0) / Math.max(1, fps.length),
      latency: {
        cvMs: lat.cvMs / n,
        aiMs: lat.aiMs / n,
        temporalMs: lat.temporalMs / n,
        fusionMs: lat.fusionMs / n,
        perceptionMs: lat.perceptionMs / n,
        pipelineMs: lat.pipelineMs / n,
      },
    });
  }
  return out;
}

/** Phase 12: Mode 1 (full-frame) timed and scored on a subsample of frames. */
async function modeComparison(model: LoadedModel, seeds: number[]): Promise<{
  note: string;
  fullFrame: { frames: number; recall: number; precision: number; latencyMs: number };
  roi: { frames: number; recall: number; precision: number; latencyMs: number };
}> {
  const kinds: DetectorKind[] = ['ai_fullframe', 'ai'];
  const res = new Map<DetectorKind, { frames: number; tp: number; fp: number; vis: number; lat: number }>();
  for (const k of kinds) res.set(k, { frames: 0, tp: 0, fp: 0, vis: 0, lat: 0 });
  for (const cond of [CONDITIONS[0], CONDITIONS.find((c) => c.id === 'decoys_bright')!, CONDITIONS.find((c) => c.id === 'dim')!]) {
    for (const seed of seeds.slice(0, 2)) {
      const base = cond.apply({ ...DEFAULT_CONFIG, scenarioName: `mode-${cond.id}`, seed });
      const cfg: ScenarioConfig = { ...base, tracking: { ...base.tracking, controllerEnabled: false } };
      const sim = new SimulationRunner(cfg);
      const W = cfg.camera.resolutionWidth;
      const H = cfg.camera.resolutionHeight;
      const inst = new Map(kinds.map((k) => [k, createDetector(k, DETECTOR_PARAMS(cfg), model)]));
      for (let i = 0; i < 300; i++) {
        const st = sim.step(1 / 30);
        if (i % 15 !== 0) continue;
        const gx = st.beacon.x_px - (st.cropCenter.x - W / 2);
        const gy = st.beacon.y_px - (st.cropCenter.y - H / 2);
        const visible = gx >= 0 && gy >= 0 && gx < W && gy < H;
        for (const k of kinds) {
          const r = res.get(k)!;
          const di = inst.get(k)!;
          const d = di.detectAsync && model.scorer && k === 'ai'
            ? await di.detectAsync(st.frame, W, H, nowMs(), null)
            : di.detect(st.frame, W, H, nowMs(), null);
          r.frames++;
          r.lat += d.latency_ms;
          if (visible) r.vis++;
          if (d.found && d.x !== null && d.y !== null) {
            if (visible && Math.hypot(d.x - gx, d.y - gy) <= HIT_RADIUS_PX) r.tp++;
            else r.fp++;
          }
        }
      }
    }
  }
  const summ = (k: DetectorKind) => {
    const r = res.get(k)!;
    return {
      frames: r.frames,
      recall: r.vis === 0 ? 0 : r.tp / r.vis,
      precision: r.tp + r.fp === 0 ? 0 : r.tp / (r.tp + r.fp),
      latencyMs: r.lat / Math.max(1, r.frames),
    };
  };
  const ff = summ('ai_fullframe');
  const roi = summ('ai');
  const note =
    `Mode 1 (full-frame): ${ff.latencyMs.toFixed(1)} ms/frame, recall ${ff.recall.toFixed(3)}, precision ${ff.precision.toFixed(3)}. ` +
    `Mode 2 (own proposals + ROI CNN): ${roi.latencyMs.toFixed(2)} ms/frame, recall ${roi.recall.toFixed(3)}, precision ${roi.precision.toFixed(3)}. ` +
    `Same ${ff.frames} frames (clear, bright decoys, dim beacon). Frame budget at 30 Hz: 33.3 ms. ` +
    `Mode 1 is ${(ff.latencyMs / Math.max(1e-6, roi.latencyMs)).toFixed(0)}x slower.`;
  return { note, fullFrame: ff, roi };
}

function fmt(v: number | null, digits = 2, unit = ''): string {
  return v === null ? '—' : `${v.toFixed(digits)}${unit}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : null;
  };
  const nSeeds = Number(arg('--seeds') ?? 6);
  const seconds = Number(arg('--seconds') ?? 25);
  const only = arg('--only')?.split(',') ?? null;
  // plan2: by default the learned stages run through ONNX Runtime Web — the
  // runtime the shipped browser worker uses. `--runtime ts` runs the
  // in-engine TypeScript forward pass of the same weights instead.
  const runtime = arg('--runtime') ?? 'ort';
  // --mode-only: run just the Phase 12 Mode 1 vs Mode 2 comparison.
  // --only id[,id]: run just those conditions, written as a resumable part
  // (scripts/eval-resumable.sh runs every part, eval-merge.ts assembles them).
  const modeOnly = args.includes('--mode-only');
  const conditions = modeOnly ? [] : only ? CONDITIONS.filter((c) => only.includes(c.id)) : CONDITIONS;

  const model = runtime === 'ort' ? await tryLoadModelWithOrt() : tryLoadModel();
  if (runtime === 'ort' && model !== null && !model.scorer) {
    process.stdout.write('ONNX export missing — run python scripts/ai/export_onnx.py\n');
    process.exit(1);
  }
  const detectors: DetectorKind[] = model === null ? ['cv_classical'] : ['cv_classical', 'ai', 'fusion'];
  if (model === null) {
    process.stdout.write('NO TRAINED MODEL FOUND — only the classical detector can be evaluated.\n\n');
  } else {
    process.stdout.write(
      `Model: ${model.manifest.name} (${model.manifest.paramCount} params), locked-test F1 ${model.manifest.metrics.locked_test_f1}; ` +
        `verifier: ${model.verifier ? model.verifier.name : 'NOT FOUND'}\n\n`,
    );
    if (!model.verifier) {
      process.stdout.write('Track verifier missing — the hybrid detector cannot run. Train it first.\n');
      process.exit(1);
    }
  }

  const seeds = Array.from({ length: nSeeds }, (_, i) => 4200 + i * 101);
  const perception: PerceptionCell[] = [];
  const loop: LoopCell[] = [];

  process.stdout.write('ARM A — perception on identical frames (camera frozen)\n\n');
  for (const cond of conditions) {
    const cells = await perceptionArm(cond, seeds, seconds, model, detectors);
    perception.push(...cells);
    for (const c of cells) {
      process.stdout.write(
        `  ${c.condition.padEnd(32)} ${c.detector.padEnd(13)} P ${c.precision.toFixed(3)}  R ${c.recall.toFixed(3)}  ` +
          `FA/empty ${String(c.falseAlarmsOnEmpty).padStart(4)}/${c.emptyFrames}  loc ${fmt(c.localisationPx)}px  ${c.latencyMs.toFixed(3)}ms\n`,
      );
    }
    process.stdout.write('\n');
  }

  process.stdout.write('\nARM B — closed loop (median across seeds, divergences counted)\n\n');
  for (const cond of conditions) {
    const cells = await loopArm(cond, seeds, seconds, model, detectors);
    loop.push(...cells);
    for (const c of cells) {
      process.stdout.write(
        `  ${c.condition.padEnd(32)} ${c.detector.padEnd(13)} err ${fmt(c.medianErrorPx)}px  correct-lock ${fmt(c.medianCorrectLockPct, 1)}%  ` +
          `correct-acq ${fmt(c.medianCorrectAcqS)}s  reacq ${fmt(c.medianReacqS)}s  diverged ${c.divergedSeeds}/${c.seeds}  ${c.latency.pipelineMs.toFixed(2)}ms\n`,
      );
    }
    process.stdout.write('\n');
  }

  let mode: Awaited<ReturnType<typeof modeComparison>> | null = null;
  if (model !== null && (!only || modeOnly)) {
    mode = await modeComparison(model, seeds);
    process.stdout.write(`\nMode 1 vs Mode 2 (Phase 12)\n  ${mode.note}\n`);
  }

  const outDir = join('benchmark-results', 'detector-comparison', only || modeOnly ? 'parts' : '');
  mkdirSync(outDir, { recursive: true });
  const suffix = modeOnly ? '-mode' : only ? `-${only.join('_')}` : '';
  writeFileSync(
    join(outDir, `summary${suffix}.json`),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        seconds,
        seeds,
        model: model?.manifest ?? null,
        verifier: model?.verifier?.manifest.metrics ?? null,
        inferenceRuntime: model?.scorer?.runtime ?? 'typescript (in-engine forward pass)',
        modeComparison: mode,
        perception,
        loop,
      },
      null,
      2,
    ),
  );

  const L: string[] = [];
  L.push('# Detector comparison — classical vs learned vs hybrid');
  L.push('');
  L.push(`Generated ${new Date().toISOString()} · ${seconds}s per run · ${nSeeds} seeds per cell (${seeds.join(', ')}).`);
  L.push('Identical scenarios and seeds across detectors. Evaluation seeds are disjoint from every training seed range.');
  L.push(`Learned stages executed on: **${model?.scorer?.runtime ?? 'typescript (in-engine forward pass)'}**.`);
  L.push('');
  if (model) {
    L.push(`CNN \`${model.manifest.name}\` (${model.manifest.paramCount} parameters, locked smartphone-test F1 ${model.manifest.metrics.locked_test_f1}` +
      `${model.manifest.metrics.stress_test_f1 !== undefined ? `, locked stress-test F1 ${model.manifest.metrics.stress_test_f1}` : ''}). ` +
      `Track verifier \`${model.verifier?.name}\` (locked-test F1 ${model.verifier?.manifest.metrics.test_f1}, AUC ${model.verifier?.manifest.metrics.test_auc}).`);
    L.push('');
  }
  L.push('## Arm A — perception on identical frames');
  L.push('');
  L.push('Camera frozen, no Kalman prediction. "FA/empty" = detections reported on frames with no visible beacon.');
  L.push('');
  L.push('| Condition | Detector | Precision | Recall | Miss rate | FA / empty frames | Localisation | Latency |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const c of perception) {
    L.push(`| ${c.condition} | ${c.detector} | ${c.precision.toFixed(3)} | ${c.recall.toFixed(3)} | ${c.missRate.toFixed(3)} | ${c.falseAlarmsOnEmpty} / ${c.emptyFrames} | ${fmt(c.localisationPx, 2, ' px')} | ${c.latencyMs.toFixed(3)} ms |`);
  }
  L.push('');
  L.push('## Arm B — closed loop');
  L.push('');
  L.push(`Median across ${nSeeds} seeds. "Diverged" = seeds whose mean tracking error exceeded ${DIVERGED_PX} px (a false lock).`);
  L.push('"Correct acq" = first time the lock was within the lock radius of the TRUE beacon (the PS acquisition gate counts any lock).');
  L.push('"Correct lock" = frames locked on the beacon / frames the beacon was in view. "Continuity" = longest unbroken correct lock.');
  L.push('');
  L.push('| Condition | Detector | Median error | Correct lock | Correct acq | Continuity | Reacq | Diverged | Pipeline | FPS |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const c of loop) {
    L.push(`| ${c.condition} | ${c.detector} | ${fmt(c.medianErrorPx, 2, ' px')} | ${fmt(c.medianCorrectLockPct, 1, ' %')} | ${fmt(c.medianCorrectAcqS, 2, ' s')} | ${fmt(c.medianContinuityS, 1, ' s')} | ${fmt(c.medianReacqS, 2, ' s')} | ${c.divergedSeeds}/${c.seeds} | ${c.latency.pipelineMs.toFixed(2)} ms | ${c.algorithmFps.toFixed(0)} |`);
  }
  L.push('');
  L.push('## Per-stage latency on the live 30 Hz loop (Phase 11)');
  L.push('');
  L.push('Mean per frame over every closed-loop run of each detector, on this machine.');
  L.push('');
  L.push('| Detector | CV stage | AI stage | Temporal verifier | Fusion | Total perception | Whole pipeline |');
  L.push('|---|---|---|---|---|---|---|');
  for (const d of detectors) {
    const cells = loop.filter((c) => c.detector === d);
    const avg = (f: (c: LoopCell) => number) => cells.reduce((a, c) => a + f(c), 0) / Math.max(1, cells.length);
    L.push(`| ${d} | ${avg((c) => c.latency.cvMs).toFixed(3)} ms | ${avg((c) => c.latency.aiMs).toFixed(3)} ms | ${avg((c) => c.latency.temporalMs).toFixed(3)} ms | ${avg((c) => c.latency.fusionMs).toFixed(3)} ms | ${avg((c) => c.latency.perceptionMs).toFixed(3)} ms | ${avg((c) => c.latency.pipelineMs).toFixed(3)} ms |`);
  }
  L.push('');
  if (mode) {
    L.push('## Mode 1 (full-frame) vs Mode 2 (ROI verification) — Phase 12');
    L.push('');
    L.push(mode.note);
    L.push('');
  }
  writeFileSync(join(outDir, `summary${suffix}.md`), L.join('\n'));
  process.stdout.write(`\nWritten to ${outDir}/summary${suffix}.{json,md}\n`);
}

void main();
