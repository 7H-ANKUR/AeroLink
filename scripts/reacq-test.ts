/**
 * Blink → loss → re-acquisition smoke test over the shipped loop.
 * Usage: bun scripts/reacq-test.ts
 */
import { validateConfig, DEFAULT_CONFIG } from '../src/engine/config';
import { SimulationRunner } from '../src/engine/simulation';

const base = structuredClone(DEFAULT_CONFIG);
const cfg = validateConfig({
  ...base,
  seed: 42,
  durationS: 45,
  beacon: { ...base.beacon, blinkPeriodS: 9 },
});
if (!cfg.ok) process.exit(1);

const sim = new SimulationRunner(cfg.config, {
  onTransition(from, to, fi) {
    if (to !== 'TRACK') console.log(`  [f${fi}] ${from} → ${to}`);
  },
  onAcquired(t) {
    console.log(`  >> acquired t=${t.toFixed(2)}s`);
  },
  onLossConfirmed(_t, fi) {
    console.log(`  !! loss confirmed [f${fi}]`);
  },
  onReacquired(rt) {
    console.log(`  >> REACQUIRED in ${rt.toFixed(3)}s`);
  },
});

sim.runFor(45);

const r = sim.finalize('reacq');
console.log(
  `loss=${r.target_loss_percent}% reacq avg=${r.reacquisition_avg_s}s max=${r.reacquisition_max_s}s ` +
    `events=${r.reacquisition_events} lock=${r.lock_retention_percent}% avgErr=${r.avg_error_px}`,
);
console.log('pass_fail:', JSON.stringify(r.pass_fail));
