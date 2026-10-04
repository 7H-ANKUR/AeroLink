/**
 * Headless engine test — runs the shipped simulation loop without a browser so
 * detection/tracking behavior can be debugged precisely (deterministic).
 * Usage: bun scripts/sim-test.ts [seed|PS169-xx] [seconds]
 */
import { validateConfig, DEFAULT_CONFIG } from '../src/engine/config';
import { SCENARIO_PRESETS } from '../src/engine/scenarios';
import { SimulationRunner } from '../src/engine/simulation';

const arg = process.argv[2] ?? '42';
const seconds = parseInt(process.argv[3] ?? '12');

let baseConfig: unknown;
let seed: number;
if (arg.startsWith('PS169')) {
  const preset = SCENARIO_PRESETS.find((p) => p.id === arg);
  if (!preset) {
    console.error('unknown preset', arg);
    process.exit(1);
  }
  baseConfig = structuredClone(preset.config);
  seed = preset.config.seed;
  console.log(`preset ${preset.name}`);
} else {
  baseConfig = DEFAULT_CONFIG;
  seed = parseInt(arg);
}

const cfg = validateConfig({ ...(baseConfig as object), seed, durationS: Math.min(seconds + 5, 600) });
if (!cfg.ok) {
  console.error('config invalid', cfg.errors);
  process.exit(1);
}
const config = cfg.config;

const sim = new SimulationRunner(config, {
  onTransition(from, to, fi) {
    console.log(`[f${fi}] STATE ${from} → ${to}`);
  },
  onAcquired(t) {
    console.log(`  >> ACQUIRED at t=${t.toFixed(3)}s`);
  },
  onLossConfirmed() {
    console.log('  !! LOSS confirmed');
  },
  onReacquired(rt) {
    console.log(`  >> REACQUIRED in ${rt.toFixed(3)}s`);
  },
});

console.log(
  `beacon start: (${sim.beacon.x_px.toFixed(0)}, ${sim.beacon.y_px.toFixed(0)}), motion=${config.beacon.motion}`,
);

sim.runFor(seconds, (step) => {
  if (step.frameIndex % 15 !== 0) return;
  const r = step.pipeline;
  console.log(
    `[f${step.frameIndex}] t=${step.timestampS.toFixed(2)} state=${r.track.state} ` +
      `det=${r.detection.found ? `(${r.detection.x?.toFixed(0)},${r.detection.y?.toFixed(0)}) conf ${r.detection.confidence.toFixed(2)}` : 'none'} ` +
      `est=(${r.track.x?.toFixed(0) ?? '—'},${r.track.y?.toFixed(0) ?? '—'}) ` +
      `gtScene=(${step.beacon.x_px.toFixed(0)},${step.beacon.y_px.toFixed(0)}) ` +
      `err=${r.errorPx?.toFixed(1) ?? '—'} cam=(${sim.camera.pan_deg.toFixed(2)}°,${sim.camera.tilt_deg.toFixed(2)}°) ` +
      `cmd=(${r.command.pan_deg_s.toFixed(2)},${r.command.tilt_deg_s.toFixed(2)})`,
  );
});

const result = sim.finalize('headless');
console.log('--- RESULT ---');
console.log(
  JSON.stringify(
    {
      acquisition: result.acquisition_time_s,
      avg_err: result.avg_error_px,
      max_err: result.max_error_px,
      rmse: result.rmse_px,
      loss: result.target_loss_percent,
      lock: result.lock_retention_percent,
      fps: result.fps_measured,
      pass: result.pass_fail,
    },
    null,
    1,
  ),
);
