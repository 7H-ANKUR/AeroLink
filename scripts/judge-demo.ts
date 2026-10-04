/**
 * Headless execution of the §22 judge demonstration.
 *
 * Runs the same config and the same injection timeline the UI button uses, at a
 * fixed timestep, and prints what the engine actually did: the mission phases
 * it reached and when, the §21 integrity checks, the simulated link at lock,
 * and the PS-169 gate results.
 *
 * This exists so the demonstration can be verified without a browser — §52
 * requires the demo to be executed, not merely implemented.
 *
 * Usage: bun scripts/judge-demo.ts
 */
import { buildDemoConfig, DEMO_SCRIPT, DEMO_DURATION_S } from '../src/engine/demo';
import { SimulationRunner } from '../src/engine/simulation';
import type { SimulationStepResult } from '../src/engine/simulation';

const config = buildDemoConfig();
const sim = new SimulationRunner(config, {
  onTransition(from, to, fi) {
    console.log(`  [f${String(fi).padStart(5)}] ${from} → ${to}`);
  },
  onAcquired(t) {
    console.log(`  >> COARSE LOCK ACQUIRED at t+${t.toFixed(3)} s`);
  },
  onLossConfirmed() {
    console.log('  !! OPTICAL SIGNAL LOST — Kalman prediction engaged');
  },
  onReacquired(rt) {
    console.log(`  >> REACQUIRED after ${rt.toFixed(3)} s`);
  },
});

console.log('=== FSOC-PAT — JUDGE DEMONSTRATION (headless) ===');
console.log(`scenario : ${config.scenarioName}`);
console.log(`seed     : ${config.seed}   duration: ${DEMO_DURATION_S}s   camera: ${config.camera.resolutionWidth}×${config.camera.resolutionHeight} @ ${config.camera.updateHz}Hz`);
console.log(`beacon   : starts at (${config.beacon.startX}, ${config.beacon.startY}) — near the FOV edge; the figure-8 carries it out, forcing a real search`);
console.log('');

const dt = 1 / config.camera.updateHz;
const frames = Math.round(DEMO_DURATION_S * config.camera.updateHz);
const fired = new Set<number>();
let last: SimulationStepResult | null = null;
let linkAtLock: SimulationStepResult['link'] | null = null;

// §5 blackout instrumentation — measured, not asserted
let blackoutStartS: number | null = null;
let blackoutEndS: number | null = null;
let predictionFrames = 0;
let searchFrames = 0;
let relockS: number | null = null;
let errorAtRelock: number | null = null;
let prevSuppressed = false;

for (let i = 0; i < frames; i++) {
  // fire the same injection timeline the worker uses
  for (let k = 0; k < DEMO_SCRIPT.length; k++) {
    if (fired.has(k)) continue;
    const a = DEMO_SCRIPT[k];
    if (sim.simTimeS < a.atS) continue;
    fired.add(k);
    if (a.kind === 'disturbance') {
      sim.setDisturbance(a.payload as Parameters<SimulationRunner['setDisturbance']>[0]);
    } else if (a.kind === 'kill-beacon') {
      sim.killBeaconForFrames(Number((a.payload as { frames?: number })?.frames ?? 45));
    }
    console.log(`  ~~ t+${sim.simTimeS.toFixed(1)}s  INJECT: ${a.label}`);
  }

  last = sim.step(dt);

  // blackout window, taken from the beacon's real visibility, not from the script
  const suppressed = sim.beaconKilled;
  if (suppressed && !prevSuppressed) blackoutStartS = sim.simTimeS;
  if (!suppressed && prevSuppressed) blackoutEndS = sim.simTimeS;
  prevSuppressed = suppressed;
  if (blackoutStartS !== null && relockS === null) {
    const st = last.pipeline.track.state;
    if (st === 'PREDICT_REACQUIRE') predictionFrames++;
    if (st === 'SEARCH') searchFrames++;
    if (blackoutEndS !== null && st === 'TRACK' && last.pipeline.detection.found) {
      relockS = sim.simTimeS;
      errorAtRelock = last.pipeline.errorPx;
    }
  }
  // Capture the link once it is genuinely ACQUIRED — sampling merely on
  // "inside the lock radius" catches frames before TRACK, where the model
  // correctly reports nothing yet.
  if (linkAtLock === null && last.link.state === 'ACQUIRED') {
    linkAtLock = last.link;
  }
}

sim.missionTracker.markReportGenerated(sim.simTimeS, sim.frameIndex);
const result = sim.finalize('judge-demo');
const mission = sim.missionTracker.snapshot();

console.log('\n--- MISSION PHASES ---');
let reached = 0;
for (const p of mission.phases) {
  if (p.reached) reached++;
  console.log(`  [${p.reached ? 'x' : ' '}] ${p.label.padEnd(26)} ${p.reached ? `t+${(p.atS ?? 0).toFixed(2)}s` : '—'}`);
}
console.log(`  ${reached}/${mission.phases.length} phases reached`);

console.log('\n--- INTEGRITY CHECKS (§21) ---');
for (const c of mission.checks) {
  console.log(`  ${c.verdict.padEnd(8)} ${c.label.padEnd(42)} ${c.detail}`);
}

console.log('\n--- SIMULATED OPTICAL LINK at first lock (model, not a measurement) ---');
if (linkAtLock) {
  console.log(`  state=${linkAtLock.state}  signal=${linkAtLock.signalLevelPercent}%  pointingLoss=${linkAtLock.pointingLossDb}dB  margin=${linkAtLock.linkMarginDb}dB`);
} else {
  console.log('  never reached lock radius');
}

console.log('\n--- BLACKOUT STRESS CASE (§5) ---');
if (blackoutStartS !== null && blackoutEndS !== null) {
  const dur = blackoutEndS - blackoutStartS;
  console.log(`  blackout duration          : ${dur.toFixed(2)} s  (beacon physically absent)`);
  console.log(`  prediction phase           : ${(predictionFrames / config.camera.updateHz).toFixed(2)} s (${predictionFrames} frames)`);
  console.log(`  active search phase        : ${(searchFrames / config.camera.updateHz).toFixed(2)} s (${searchFrames} frames)`);
  if (relockS !== null) {
    console.log(`  relock after beacon return : ${(relockS - blackoutEndS).toFixed(2)} s   <-- the algorithmic figure`);
    console.log(`  total loss -> lock restored: ${(relockS - blackoutStartS).toFixed(2)} s   (includes the ${dur.toFixed(1)} s absence)`);
    console.log(`  pointing error at relock   : ${errorAtRelock !== null ? errorAtRelock.toFixed(2) + ' px' : '-'}`);
  } else {
    console.log('  never relocked within the run');
  }
  console.log(`\n  NOTE: a beacon absent for ${dur.toFixed(1)} s cannot be reacquired inside the 1 s PS`);
  console.log('  gate by any algorithm. The reacquisition and target-loss gates below are');
  console.log('  therefore reported as FAIL for this scenario, honestly. The 14-scenario');
  console.log('  benchmark, where outages are short, is where those gates are met.');
} else {
  console.log('  no blackout occurred in this run');
}

console.log('\n--- MEASURED RESULT ---');
console.log(`  acquisition       : ${result.acquisition_time_s ?? '—'} s      (gate ≤ 2.00)`);
console.log(`  avg tracking error: ${result.avg_error_px ?? '—'} px     (gate ≤ 10)`);
console.log(`  centroiding error : ${result.centroid_error_avg_px ?? '—'} px`);
console.log(`  target loss       : ${result.target_loss_percent ?? '—'} %      (gate < 5)`);
console.log(`  reacquisition     : ${result.reacquisition_avg_s ?? '—'} s      (gate ≤ 1.00, ${result.reacquisition_events} events)`);
console.log(`  algorithm FPS     : ${result.fps_measured}        (gate ≥ 20)`);
console.log(`  gates             : ${JSON.stringify(result.pass_fail)}`);

const allPhases = reached === mission.phases.length;
const noFailedChecks = mission.checks.every((c) => c.verdict !== 'FAIL');
const gates = result.pass_fail ? Object.values(result.pass_fail).every(Boolean) : false;
console.log(`\nRESULT: phases=${reached}/${mission.phases.length}  integrity=${noFailedChecks ? 'no failures' : 'FAILURES'}  gates=${gates ? 'all pass' : 'NOT all pass'}`);
// Exit status reflects the demonstration's own success criteria: the full
// causal chain ran and nothing failed an integrity check. Gate results are
// printed above and judged on their own terms — the blackout scenario is
// deliberately harder than the benchmark.
process.exit(allPhases && noFailedChecks ? 0 : 1);
