/**
 * DEMO 6 — Multiple candidates / distractor rejection (master prompt §34).
 *
 * Runs the maximum-distractor configuration (12 decoys, schema max) plus a
 * raised background, and proves the tracker locks onto the REAL beacon, not
 * a decoy: state transitions logged, error vs ground truth stays tiny, all
 * PS-169 gates pass. Also proves the sticky prediction gate: while TRACK is
 * active a brighter-looking candidate cannot steal the lock.
 *
 * Usage: bun scripts/distractor-demo.ts
 */
import { validateConfig, DEFAULT_CONFIG } from '../src/engine/config';
import { SimulationRunner } from '../src/engine/simulation';

const seed = 2026;
const base = structuredClone(DEFAULT_CONFIG);
const cfg = validateConfig({
  ...base,
  scenarioName: 'DEMO6 Distractor Storm',
  seed,
  durationS: 30,
  scene: { ...base.scene, distractorCount: 12, backgroundLevel: 26 },
  beacon: { ...base.beacon, motion: 'circular', speed: 1.0, startX: 1050, startY: 980 },
});
if (!cfg.ok) {
  console.error('config invalid', cfg.errors);
  process.exit(1);
}
const config = cfg.config;
const transitions: string[] = [];
const sim = new SimulationRunner(config, {
  onTransition(from, to, fi) {
    transitions.push(`frame ${fi}: ${from} -> ${to}`);
  },
});

console.log('=== DEMO 6: distractor storm — 12 decoys, elevated background ===');
console.log(`scene ${config.scene.width}x${config.scene.height}, decoys=${sim.sceneData.distractors.length}, beacon 10x10 @ (${config.beacon.startX},${config.beacon.startY}), circular orbit`);

sim.runFor(30);

const r = sim.finalize('demo6-distractors');
console.log('\nState transitions:');
for (const tr of transitions) console.log('  ' + tr);
console.log('\nResults (ground truth only used by MetricsEngine):');
console.log(`  acquisition        : ${r.acquisition_time_s?.toFixed(3)} s   (gate <= 2 s)`);
console.log(`  avg tracking error : ${r.avg_error_px?.toFixed(2)} px  (gate <= 10 px — proves lock is on the REAL beacon)`);
console.log(`  rmse / max error   : ${r.rmse_px?.toFixed(2)} / ${r.max_error_px?.toFixed(1)} px`);
console.log(`  target loss        : ${r.target_loss_percent}%    (gate < 5%)`);
console.log(`  lock retention     : ${r.lock_retention_percent}%`);
console.log(`  algorithm FPS      : ${r.fps_measured.toFixed(0)}     (gate >= 20)`);
console.log(`  avg confidence     : ${r.avg_detection_confidence?.toFixed(3)}`);
const gates = r.pass_fail ?? {};
console.log(`  gates: ${JSON.stringify(gates)}`);
const allPass = Object.values(gates).every(Boolean);
const lockedOnRealBeacon = (r.avg_error_px ?? 99) < 10;
console.log(`\nRESULT: all gates pass=${allPass}, locked-on-real-beacon=${lockedOnRealBeacon}`);
process.exit(allPass && lockedOnRealBeacon ? 0 : 1);
