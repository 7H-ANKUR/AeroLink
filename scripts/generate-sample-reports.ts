/**
 * Generates the sample run deliverables from a REAL engine run:
 *   metrics.json   — RunResult (docs/05 §4 schema)
 *   events.csv     — per-frame log (docs/05 §3 schema)
 *   summary.html   — human-readable report (docs/04 §4.16)
 * Written to public/samples/ (served by the app) and download/.
 * Usage: bun scripts/generate-sample-reports.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig, DEFAULT_CONFIG } from '../src/engine/config';
import { SimulationRunner } from '../src/engine/simulation';
import { eventsToCsv, summaryHtml } from '../src/engine/export';

const DURATION = 60;
const cfg = validateConfig({ ...structuredClone(DEFAULT_CONFIG), seed: 42, durationS: DURATION });
if (!cfg.ok) {
  console.error(cfg.errors);
  process.exit(1);
}

const sim = new SimulationRunner(cfg.config);
sim.runFor(DURATION);

const result = sim.finalize('sample-seed-42');
result.scenario_name = 'PS169-03 Figure-8 / Clear';

const csv = eventsToCsv(sim.metrics.eventRows);
const html = summaryHtml(result);

// Repo-relative so this runs anywhere, not just in the original container.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const dir of [join(repoRoot, 'public', 'samples'), join(repoRoot, 'download')]) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'metrics.json'), JSON.stringify(result, null, 2));
  writeFileSync(join(dir, 'events.csv'), csv);
  writeFileSync(join(dir, 'summary-report.html'), html);
}
console.log('sample run (seed 42, 60 s figure-8):');
console.log(
  `  acquisition=${result.acquisition_time_s}s avgErr=${result.avg_error_px}px rmse=${result.rmse_px}px ` +
    `loss=${result.target_loss_percent}% lock=${result.lock_retention_percent}% fps=${result.fps_measured}`,
);
console.log(`  pass_fail=${JSON.stringify(result.pass_fail)}`);
console.log('written: metrics.json, events.csv, summary-report.html → public/samples/ + download/');
