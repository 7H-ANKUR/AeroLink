/**
 * Per-frame time series for the technical report figures.
 *
 * Runs the SHIPPED SimulationRunner (learned stages in ONNX Runtime Web via
 * stepAsync, exactly as the browser worker does) and records, per frame, what
 * the engine produced plus the ground truth used ONLY for scoring/plotting.
 *
 *   A  hybrid  (fusion, ORT)  bright decoys, seed 4402 — starts on a decoy
 *   B  classical             bright decoys, seed 4402 — same scene
 *   C  classical             PS169-03 Figure-8 / Clear, seed 42 (the default)
 *
 * Usage:  bun scripts/report-timeseries.ts
 * Writes: docs/report/data/{hybrid_decoys_4402,classical_decoys_4402,classical_fig8_42}.csv
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type ScenarioConfig } from '../src/engine/config';
import { SimulationRunner } from '../src/engine/simulation';
import { tryLoadModelWithOrt } from './lib/load-model';
import type { LoadedModel } from '../src/engine/detector-ai';

const OUT = join('docs', 'report', 'data');
const COLS = [
  't', 'state', 'gt_x', 'gt_y', 'gt_visible', 'est_x', 'est_y', 'pred_x', 'pred_y', 'err_px',
  'det_found', 'det_x', 'det_y', 'det_conf', 'cv_conf', 'ai_conf', 'track_p', 'chosen_by',
  'cmd_pan', 'cmd_tilt', 'act_pan', 'act_tilt', 'az_deg', 'el_deg', 'proc_ms', 'ai_runtime',
];

async function record(name: string, cfg: ScenarioConfig, model: LoadedModel | null, async: boolean): Promise<void> {
  const sim = new SimulationRunner(cfg, {}, model);
  const W = cfg.camera.resolutionWidth;
  const H = cfg.camera.resolutionHeight;
  const rows: string[] = [COLS.join(',')];
  const steps = Math.round(cfg.durationS * cfg.camera.updateHz);
  const f = (v: number | null | undefined, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? '' : v.toFixed(d));
  for (let i = 0; i < steps; i++) {
    const st = async ? await sim.stepAsync(1 / cfg.camera.updateHz) : sim.step(1 / cfg.camera.updateHz);
    const p = st.pipeline;
    const pv = p.detection.provenance ?? null;
    // Ground truth: scoring/plotting only (image space).
    const gx = st.beacon.x_px - (st.cropCenter.x - W / 2);
    const gy = st.beacon.y_px - (st.cropCenter.y - H / 2);
    rows.push([
      f(st.timestampS, 4), p.track.state, f(gx), f(gy), st.beacon.visible && !st.blinkOff ? 1 : 0,
      f(p.track.x), f(p.track.y), f(p.predictedX), f(p.predictedY), f(p.errorPx),
      p.detection.found ? 1 : 0, f(p.detection.x), f(p.detection.y), f(p.detection.confidence),
      f(pv?.cv?.confidence ?? (pv ? null : p.detection.found ? p.detection.confidence : null)),
      f(pv?.ai?.confidence), f(pv?.trackP), pv?.chosenBy ?? 'cv',
      f(p.command.pan_deg_s), f(p.command.tilt_deg_s), f(st.mount.actualPanRateDegS), f(st.mount.actualTiltRateDegS),
      f(st.mount.azimuthDeg, 4), f(st.mount.elevationDeg, 4), f(p.processingMs, 4), pv?.aiRuntime ?? 'none',
    ].join(','));
  }
  writeFileSync(join(OUT, `${name}.csv`), rows.join('\n') + '\n');
  const r = sim.finalize(name);
  process.stdout.write(
    `${name}: avg err ${r.avg_error_px} px, max ${r.max_error_px} px, loss ${r.target_loss_percent} %, lock ${r.lock_retention_percent} %, acq ${r.acquisition_time_s} s\n`,
  );
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const model = await tryLoadModelWithOrt();
  if (!model?.scorer || !model.verifier) throw new Error('ORT model / verifier not available');
  const decoys = (seed: number, detector: ScenarioConfig['tracking']['detector']): ScenarioConfig => ({
    ...DEFAULT_CONFIG,
    scenarioName: `report-decoys-${detector}`,
    seed,
    durationS: 25,
    scene: { ...DEFAULT_CONFIG.scene, distractorCount: 10, distractorIntensityMin: 0.62, distractorIntensityMax: 0.95 },
    tracking: { ...DEFAULT_CONFIG.tracking, detector },
  });
  await record('hybrid_decoys_4402', decoys(4402, 'fusion'), model, true);
  await record('classical_decoys_4402', decoys(4402, 'cv_classical'), null, false);
  await record('classical_fig8_42', { ...DEFAULT_CONFIG, durationS: 25 }, null, false);
}

void main();
