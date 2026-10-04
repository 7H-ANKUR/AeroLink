/**
 * Assemble the resumable evaluation parts into the final comparison report.
 *
 * scripts/eval-resumable.sh runs scripts/eval-detectors.ts once per condition
 * (`--only <id>`) plus once for the Mode 1 vs Mode 2 comparison
 * (`--mode-only`), each writing benchmark-results/detector-comparison/parts/.
 * This script merges them, in the canonical condition order, into
 * summary.json / summary.md. It refuses to write a report with a missing part.
 *
 * Usage: bun scripts/eval-merge.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CONDITION_IDS = [
  'clear', 'haze', 'fog', 'rain', 'low_light', 'noise_heavy', 'jitter',
  'blur_smear', 'dim', 'blink', 'decoys_bright', 'decoys_plus_noise', 'decoys_jitter',
];

const DIR = join('benchmark-results', 'detector-comparison');
const PARTS = join(DIR, 'parts');
const DIVERGED_PX = 50;

type Rec = Record<string, any>;
const fmt = (v: number | null | undefined, d = 2, u = '') => (v === null || v === undefined ? '—' : `${v.toFixed(d)}${u}`);

function main(): void {
  const missing = [...CONDITION_IDS.map((id) => `summary-${id}.json`), 'summary-mode.json'].filter(
    (f) => !existsSync(join(PARTS, f)),
  );
  if (missing.length > 0) {
    process.stderr.write(`Missing parts: ${missing.join(', ')}\n`);
    process.exit(1);
  }
  const parts = CONDITION_IDS.map((id) => JSON.parse(readFileSync(join(PARTS, `summary-${id}.json`), 'utf8')) as Rec);
  const mode = JSON.parse(readFileSync(join(PARTS, 'summary-mode.json'), 'utf8')) as Rec;
  const first = parts[0];
  const perception: Rec[] = parts.flatMap((p) => p.perception);
  const loop: Rec[] = parts.flatMap((p) => p.loop);
  const runtimes = new Set(parts.map((p) => p.inferenceRuntime));
  const detectors = [...new Set(loop.map((c) => c.detector as string))];

  const merged = {
    generatedAt: new Date().toISOString(),
    partsGeneratedAt: parts.map((p) => p.generatedAt),
    seconds: first.seconds,
    seeds: first.seeds,
    model: first.model,
    verifier: first.verifier,
    inferenceRuntime: [...runtimes].join(' | '),
    modeComparison: mode.modeComparison,
    perception,
    loop,
  };
  writeFileSync(join(DIR, 'summary.json'), JSON.stringify(merged, null, 2));

  const L: string[] = [];
  L.push('# Detector comparison — classical vs AI vs hybrid');
  L.push('');
  L.push(`Merged ${merged.generatedAt} from ${parts.length + 1} parts · ${first.seconds}s per run · ${first.seeds.length} seeds per cell (${first.seeds.join(', ')}).`);
  L.push('Identical scenarios and seeds across detectors. Evaluation seeds are disjoint from every training seed range and from the development seeds used for tuning.');
  L.push(`Learned stages executed on: **${merged.inferenceRuntime}**.`);
  L.push('');
  if (first.model) {
    L.push(`CNN \`${first.model.name}\` (${first.model.paramCount} parameters, locked smartphone-test F1 ${first.model.metrics.locked_test_f1}, locked stress-test F1 ${first.model.metrics.stress_test_f1}). ` +
      `Track verifier locked-test F1 ${first.verifier?.test_f1}, AUC ${first.verifier?.test_auc}.`);
    L.push('');
  }
  L.push('## Arm A — perception on identical frames');
  L.push('');
  L.push('Camera frozen, no Kalman prediction. "FA / empty" = detections reported on frames with no visible beacon.');
  L.push('');
  L.push('| Condition | Detector | Precision | Recall | Miss rate | FA / empty frames | Localisation | Latency |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const c of perception) {
    L.push(`| ${c.condition} | ${c.detector} | ${c.precision.toFixed(3)} | ${c.recall.toFixed(3)} | ${c.missRate.toFixed(3)} | ${c.falseAlarmsOnEmpty} / ${c.emptyFrames} | ${fmt(c.localisationPx, 2, ' px')} | ${c.latencyMs.toFixed(3)} ms |`);
  }
  L.push('');
  L.push('## Arm B — closed loop');
  L.push('');
  L.push(`Median across ${first.seeds.length} seeds. "Diverged" = seeds whose mean tracking error exceeded ${DIVERGED_PX} px (a run that STARTS on a decoy and recovers can still count, because the mean includes the decoy period).`);
  L.push('"Correct acq" = first time the lock was within the lock radius of the TRUE beacon (the PS acquisition gate counts any lock).');
  L.push('"Correct lock" = frames locked on the beacon / frames the beacon was in view. "Continuity" = longest unbroken correct lock.');
  L.push('');
  L.push('| Condition | Detector | Median error | Correct lock | Correct acq | Continuity | Reacq | Diverged | Pipeline | FPS |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const c of loop) {
    L.push(`| ${c.condition} | ${c.detector} | ${fmt(c.medianErrorPx, 2, ' px')} | ${fmt(c.medianCorrectLockPct, 1, ' %')} | ${fmt(c.medianCorrectAcqS, 2, ' s')} | ${fmt(c.medianContinuityS, 1, ' s')} | ${fmt(c.medianReacqS, 2, ' s')} | ${c.divergedSeeds}/${c.seeds} | ${c.latency.pipelineMs.toFixed(2)} ms | ${c.algorithmFps.toFixed(0)} |`);
  }
  L.push('');
  L.push('## Per-stage latency on the live loop (Phase 11)');
  L.push('');
  L.push('Mean per frame over every closed-loop run of each detector, on this machine.');
  L.push('');
  L.push('| Detector | CV stage | AI stage | Temporal verifier | Fusion | Total perception | Whole pipeline |');
  L.push('|---|---|---|---|---|---|---|');
  for (const d of detectors) {
    const cells = loop.filter((c) => c.detector === d);
    const avg = (f: (c: Rec) => number) => cells.reduce((a, c) => a + f(c), 0) / Math.max(1, cells.length);
    L.push(`| ${d} | ${avg((c) => c.latency.cvMs).toFixed(3)} ms | ${avg((c) => c.latency.aiMs).toFixed(3)} ms | ${avg((c) => c.latency.temporalMs).toFixed(3)} ms | ${avg((c) => c.latency.fusionMs).toFixed(3)} ms | ${avg((c) => c.latency.perceptionMs).toFixed(3)} ms | ${avg((c) => c.latency.pipelineMs).toFixed(3)} ms |`);
  }
  L.push('');
  if (mode.modeComparison) {
    L.push('## Mode 1 (full-frame) vs Mode 2 (ROI verification) — Phase 12');
    L.push('');
    L.push(mode.modeComparison.note);
    L.push('');
  }
  writeFileSync(join(DIR, 'summary.md'), L.join('\n'));
  process.stdout.write(`Merged ${parts.length} condition parts + mode comparison into ${DIR}/summary.{json,md}\n`);
}

main();
