/**
 * Per-stage latency on THIS machine (AI plan Phases 2, 11).
 *
 * The plan: "choose the smallest model that gives enough detection quality
 * while meeting the real-time constraint... benchmark inference latency on
 * the actual judge machine." Every latency figure in the docs was measured on
 * the development machine. This script is what to run on the judge machine:
 * ~30 s, no network, no configuration.
 *
 * For each detector it runs the full closed loop on a hard scenario (bright
 * decoys + sensor noise + jitter) and reports mean and p95 per-stage latency,
 * whole-pipeline time and the resulting headroom against the 30 Hz budget.
 *
 * Usage:  bun scripts/bench-latency.ts [--seconds 10]
 * Writes: benchmark-results/latency-<hostname>.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname, cpus, platform } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type ScenarioConfig } from '../src/engine/config';
import { SimulationRunner } from '../src/engine/simulation';
import { createDetector } from '../src/engine/detectors';
import { nowMs } from '../src/engine/detector';
import { tryLoadModelWithOrt } from './lib/load-model';
import type { DetectorKind } from '../src/engine/types';

const BUDGET_MS = 1000 / 30;

function stats(xs: number[]): { mean: number; p95: number; max: number } {
  const v = xs.slice().sort((a, b) => a - b);
  const mean = v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
  return { mean, p95: v[Math.min(v.length - 1, Math.floor(v.length * 0.95))] ?? 0, max: v[v.length - 1] ?? 0 };
}

async function main(): Promise<void> {
  const i = process.argv.indexOf('--seconds');
  const seconds = i >= 0 ? Number(process.argv[i + 1]) : 10;
  // Learned stages run in ONNX Runtime Web (WASM) — the shipped browser runtime.
  const model = await tryLoadModelWithOrt();
  const detectors: DetectorKind[] = model?.verifier ? ['cv_classical', 'ai', 'fusion'] : model ? ['cv_classical', 'ai'] : ['cv_classical'];

  const base: ScenarioConfig = {
    ...DEFAULT_CONFIG,
    scenarioName: 'latency-bench',
    seed: 314159,
    scene: { ...DEFAULT_CONFIG.scene, distractorCount: 10, distractorIntensityMin: 0.62, distractorIntensityMax: 0.95 },
    noise: { saltPepperPercent: 1, gaussianSigma: 12, poissonEnabled: true },
    jitter: { enabled: true, maxPxPerFrame: 10 },
  };

  const cpu = cpus()[0]?.model ?? 'unknown CPU';
  process.stdout.write(`Machine: ${hostname()} · ${platform()} · ${cpu} · ${cpus().length} threads\n`);
  process.stdout.write(`Inference runtime: ${model?.scorer?.runtime ?? 'none (no model)'}
`);
  process.stdout.write(`Scenario: bright decoys + noise + jitter, ${seconds}s per detector. Budget ${BUDGET_MS.toFixed(1)} ms/frame.\n\n`);

  const results: Record<string, unknown> = {};
  for (const d of detectors) {
    const cfg: ScenarioConfig = { ...base, tracking: { ...base.tracking, detector: d } };
    const sim = new SimulationRunner(cfg, {}, model);
    const cv: number[] = [];
    const ai: number[] = [];
    const temporal: number[] = [];
    const fusion: number[] = [];
    const perception: number[] = [];
    const pipeline: number[] = [];
    const steps = Math.round(seconds * 30);
    for (let k = 0; k < steps; k++) {
      const st = d !== 'cv_classical' && model?.scorer ? await sim.stepAsync(1 / 30) : sim.step(1 / 30);
      if (k < 15) continue; // warm-up
      const pv = st.pipeline.detection.provenance;
      if (pv) {
        cv.push(pv.cvLatencyMs);
        ai.push(pv.aiLatencyMs);
        temporal.push(pv.temporalLatencyMs ?? 0);
        fusion.push(pv.fusionLatencyMs);
      }
      perception.push(st.pipeline.detection.latency_ms);
      pipeline.push(st.pipeline.processingMs);
    }
    const pl = stats(pipeline);
    const row = {
      cv: stats(cv),
      ai: stats(ai),
      temporal: stats(temporal),
      fusion: stats(fusion),
      perception: stats(perception),
      pipeline: pl,
      pipelineFps: 1000 / Math.max(1e-6, pl.mean),
      withinBudgetP95: pl.p95 <= BUDGET_MS,
    };
    results[d] = row;
    process.stdout.write(
      `${d.padEnd(13)} perception ${row.perception.mean.toFixed(2)} ms (p95 ${row.perception.p95.toFixed(2)})  ` +
        `pipeline ${pl.mean.toFixed(2)} ms (p95 ${pl.p95.toFixed(2)}) -> ${row.pipelineFps.toFixed(0)} FPS  ` +
        `${row.withinBudgetP95 ? 'WITHIN' : 'OVER'} 30 Hz budget\n`,
    );
    if (pv0(cv)) {
      process.stdout.write(
        `${''.padEnd(13)} CV ${row.cv.mean.toFixed(2)} · AI ${row.ai.mean.toFixed(2)} · temporal ${row.temporal.mean.toFixed(2)} · fusion ${row.fusion.mean.toFixed(3)} ms\n`,
      );
    }
  }

  // Mode 1 (full-frame) — a handful of frames, it is slow by design.
  if (model) {
    const ff = createDetector('ai_fullframe', {
      threshold: 90, minAreaPx: 4, maxAreaPx: 1200, expectedBeaconSize: 100, minConfidence: 0.5,
    }, model);
    const sim = new SimulationRunner(base);
    const times: number[] = [];
    for (let k = 0; k < 10; k++) {
      const st = sim.step(1 / 30);
      const t0 = nowMs();
      ff.detect(st.frame, 640, 480, t0, null);
      times.push(nowMs() - t0);
    }
    const s = stats(times.slice(2));
    results.ai_fullframe = { perception: s, withinBudgetP95: s.p95 <= BUDGET_MS };
    process.stdout.write(`${'ai_fullframe'.padEnd(13)} perception ${s.mean.toFixed(1)} ms (Mode 1, not realtime)\n`);
  }

  const outDir = 'benchmark-results';
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `latency-${hostname().replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  writeFileSync(
    file,
    JSON.stringify({ generatedAt: new Date().toISOString(), runtime: model?.scorer?.runtime ?? null, host: hostname(), platform: platform(), cpu, threads: cpus().length, budgetMs: BUDGET_MS, results }, null, 2),
  );
  process.stdout.write(`\nWritten to ${file}\n`);
}

function pv0(xs: number[]): boolean {
  return xs.length > 0;
}

void main();
