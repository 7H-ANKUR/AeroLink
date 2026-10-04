/**
 * Batch benchmark gate — runs all 14 PS-169 presets headlessly and reports
 * pass/fail per scenario (docs/08 §5: repeated seeds, mean must meet target).
 * Usage: bun scripts/batch-test.ts
 *
 * Drives SimulationRunner — the same loop the app ships — at a fixed
 * 1/updateHz timestep, so results are reproducible and representative.
 */
import { SCENARIO_PRESETS } from '../src/engine/scenarios';
import type { ScenarioConfig } from '../src/engine/config';
import { PS_TARGETS, SOFTWARE_VERSION } from '../src/engine/metrics';
import type { RunResult } from '../src/engine/types';
import { SimulationRunner } from '../src/engine/simulation';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** §26 — every run's raw result is written out, not just the printed mean. */
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'benchmark-results');
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const rawRuns: unknown[] = [];

function runScenario(config: ScenarioConfig, seconds: number): Record<string, number | boolean | null> {
  const sim = new SimulationRunner(config);
  sim.runFor(seconds);
  const r = sim.finalize('batch');
  // full RunResult per seed, including the exact config that produced it
  rawRuns.push(r);
  return {
    acq: r.acquisition_time_s,
    avg: r.avg_error_px,
    rmse: r.rmse_px,
    loss: r.target_loss_percent,
    lock: r.lock_retention_percent,
    reacq: r.reacquisition_avg_s,
    reacqN: r.reacquisition_events,
    fps: r.fps_measured,
    allPass: r.pass_fail ? Object.values(r.pass_fail).every(Boolean) : false,
  };
}

const presets = SCENARIO_PRESETS;
console.log('scenario                    |  acq(s) | avg(px) | rmse | loss% | lock% | re-acq(s) | fps  | ALL (mean of 5 seeds, docs/08 §5)');
console.log('-'.repeat(110));
let passCount = 0;
const aggregate: unknown[] = [];
for (const p of presets) {
  // docs/08 §5 score stability: ≥5 seeded runs per scenario; gate on the MEAN
  const runs = [0, 1, 2, 3, 4].map((i) => {
    const cfg = { ...structuredClone(p.config), seed: p.config.seed + i * 137 };
    return runScenario(cfg, 30);
  });
  const mean = (k: string) => {
    const vals = runs.map((r) => r[k] as number | null).filter((v): v is number => v !== null && Number.isFinite(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  // Mean-gate against official PS targets (docs/08 §2 + §5)
  const gates = {
    acquisition: (mean('acq') as number | null) !== null && (mean('acq') as number) <= 2.0,
    tracking_error: (mean('avg') as number) <= 10,
    target_loss: (mean('loss') as number) < 5,
    reacquisition: (mean('reacq') as number | null) === null || (mean('reacq') as number) <= 1.0,
    processing_speed: (mean('fps') as number) >= 20,
  };
  const allPass = Object.values(gates).every(Boolean);
  if (allPass) passCount++;
  aggregate.push({
    id: p.id,
    name: p.name,
    seeds: runs.map((_, i) => p.config.seed + i * 137),
    mean: {
      acquisition_s: mean('acq'),
      avg_error_px: mean('avg'),
      rmse_px: mean('rmse'),
      target_loss_pct: mean('loss'),
      lock_retention_pct: mean('lock'),
      reacquisition_s: mean('reacq'),
      algorithm_fps: mean('fps'),
    },
    gates,
    all_pass: allPass,
  });
  const f = (v: number | null, d = 2) => (v === null ? '  — ' : v.toFixed(d));
  console.log(
    `${p.name.padEnd(27)} | ${f(mean('acq') as number, 2).padStart(7)} | ${f(mean('avg') as number).padStart(7)} | ${f(mean('rmse') as number).padStart(4)} | ${f(mean('loss') as number, 1).padStart(5)} | ${f(mean('lock') as number, 1).padStart(5)} | ${f(mean('reacq') as number).padStart(9)} | ${f(mean('fps') as number, 0).padStart(4)} | ${allPass ? 'PASS' : 'FAIL'}`,
  );
}
console.log('-'.repeat(110));
console.log(`${passCount}/${presets.length} scenarios pass all PS-169 gates (mean of 5 seeded runs each)`);

// ── §26 reproducibility artefacts ───────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true });
const runDir = join(OUT_DIR, RUN_STAMP);
mkdirSync(runDir, { recursive: true });

writeFileSync(join(runDir, 'raw-runs.json'), JSON.stringify(rawRuns, null, 2));
writeFileSync(
  join(runDir, 'aggregate.json'),
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      software_version: SOFTWARE_VERSION,
      ps_targets: PS_TARGETS,
      seeds_per_scenario: 5,
      seconds_per_run: 30,
      scenarios_passing: passCount,
      scenarios_total: presets.length,
      scenarios: aggregate,
    },
    null,
    2,
  ),
);
const csvHeader = 'scenario,seed,acquisition_s,avg_error_px,centroid_error_px,rmse_px,target_loss_pct,lock_retention_pct,reacquisition_s,algorithm_fps,all_gates_pass';
const csvRows = (rawRuns as RunResult[]).map((r) =>
  [
    JSON.stringify(r.scenario_name),
    r.scenario_seed,
    r.acquisition_time_s ?? '',
    r.avg_error_px ?? '',
    r.centroid_error_avg_px ?? '',
    r.rmse_px ?? '',
    r.target_loss_percent ?? '',
    r.lock_retention_percent ?? '',
    r.reacquisition_avg_s ?? '',
    r.fps_measured,
    r.pass_fail ? Object.values(r.pass_fail).every(Boolean) : '',
  ].join(','),
);
writeFileSync(join(runDir, 'per-seed.csv'), [csvHeader, ...csvRows].join('\n'));
console.log(`\nArtefacts written to benchmark-results/${RUN_STAMP}/`);
console.log('  raw-runs.json   full RunResult per seed (config included)');
console.log('  aggregate.json  per-scenario means + gate verdicts');
console.log('  per-seed.csv    one row per seeded run');
