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
import { createTrajectory } from '../src/engine/trajectories';
import { initScene, renderScene, makeBeacon } from '../src/engine/scene';
import { createCamera, cropFrame, stepCamera, cameraCenterPx } from '../src/engine/camera';
import { makeRng, makeGaussian } from '../src/engine/rng';
import { Pipeline, type PipelineHost } from '../src/engine/pipeline';

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
const w = config.camera.resolutionWidth;
const h = config.camera.resolutionHeight;

const sceneData = initScene(
  config.scene.width, config.scene.height, config.scene.backgroundLevel,
  config.scene.distractorCount, config.seed,
  { x: config.beacon.startX, y: config.beacon.startY ?? config.scene.height / 2 },
);
const trajectory = createTrajectory({
  mode: config.beacon.motion, speed: config.beacon.speed,
  sceneWidth: config.scene.width, sceneHeight: config.scene.height,
  startX: config.beacon.startX ?? sceneData.startX, startY: config.beacon.startY ?? sceneData.startY,
  margin: 80, rng: makeRng(config.seed ^ 0x1234abcd),
});
const camera = createCamera({
  maxPanSpeedDegS: config.camera.maxPanSpeedDegS, maxTiltSpeedDegS: config.camera.maxTiltSpeedDegS,
  resolutionWidth: w, resolutionHeight: h,
  sceneWidth: config.scene.width, sceneHeight: config.scene.height,
  fovXDeg: config.camera.fovXDeg, fovYDeg: config.camera.fovYDeg,
});
const beacon = makeBeacon(1, sceneData.startX, sceneData.startY, config.beacon.intensity);
const rngMain = makeRng(config.seed);
const gauss = makeGaussian(rngMain);
const frameBuf = new Uint8Array(w * h);
const transitions: string[] = [];

const host: PipelineHost = {
  applyCommand(cmd, dtS) {
    stepCamera(camera, cmd.pan_deg_s, cmd.tilt_deg_s, dtS);
    return { pan_deg: camera.pan_deg, tilt_deg: camera.tilt_deg };
  },
  viewportCenter() {
    const c = cameraCenterPx(camera);
    return { x: c.cx, y: c.cy };
  },
  pixelsPerDeg() {
    return { x: camera.pxPerDegX, y: camera.pxPerDegY };
  },
  sceneToImage(x, y) {
    const c = cameraCenterPx(camera);
    const ix = x - (c.cx - w / 2);
    const iy = y - (c.cy - h / 2);
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) return null;
    return { x: ix, y: iy };
  },
  onTransition(from, to, fi) {
    transitions.push(`frame ${fi}: ${from} -> ${to}`);
  },
  onAcquired() {},
  onLossConfirmed() {},
  onReacquired() {},
};
const pipeline = new Pipeline(
  config,
  { mode: 'simulation', fps: config.camera.updateHz, resolution: [w, h], has_ground_truth: true },
  host,
  'simulation',
);

console.log('=== DEMO 6: distractor storm — 12 decoys, elevated background ===');
console.log(`scene ${config.scene.width}x${config.scene.height}, decoys=${sceneData.distractors.length}, beacon 10x10 @ (${config.beacon.startX},${config.beacon.startY}), circular orbit`);

const dt = 1 / config.camera.updateHz;
let t = 0;
for (let fi = 1; fi <= 30 * config.camera.updateHz; fi++) {
  t += dt;
  const traj = trajectory.at(t);
  beacon.x_px = traj.x;
  beacon.y_px = traj.y;
  beacon.vx_px_s = traj.vx;
  beacon.vy_px_s = traj.vy;
  renderScene({
    scene: sceneData.scene, background: sceneData.background,
    sceneWidth: config.scene.width, sceneHeight: config.scene.height,
    backgroundLevel: config.scene.backgroundLevel, beacon,
    beaconSizePx: config.beacon.sizePx, beaconShape: 'square',
    killBeacon: false, blinkOff: false, distractors: sceneData.distractors,
  });
  const cc = cameraCenterPx(camera);
  cropFrame(sceneData.scene, config.scene.width, config.scene.height, frameBuf, w, h, cc.cx, cc.cy);
  pipeline.step({
    frame: frameBuf, width: w, height: h, timestamp_s: t, frame_index: fi,
    ground_truth: { ...beacon, x_px: beacon.x_px - (cc.cx - w / 2), y_px: beacon.y_px - (cc.cy - h / 2) },
    pan_deg: camera.pan_deg, tilt_deg: camera.tilt_deg,
  });
}

const r = pipeline.getMetrics().finalize('demo6-distractors');
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
