/**
 * Headless engine test — runs the simulation loop without a browser so
 * detection/tracking behavior can be debugged precisely (deterministic).
 * Usage: bun scripts/sim-test.ts [seed] [seconds]
 */
import { validateConfig, DEFAULT_CONFIG, type ScenarioConfig } from '../src/engine/config';
import { SCENARIO_PRESETS } from '../src/engine/scenarios';
import { createTrajectory } from '../src/engine/trajectories';
import { initScene, renderScene, makeBeacon } from '../src/engine/scene';
import {
  createCamera,
  cropFrame,
  stepCamera,
  cameraCenterPx,
  PlatformMotion,
  makeGaussFor,
  atmosphereParams,
  applyDisturbances,
} from '../src/engine/camera';
import { makeRng, makeGaussian } from '../src/engine/rng';
import { Pipeline, type PipelineHost } from '../src/engine/pipeline';

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

const sceneData = initScene(config.scene.width, config.scene.height, config.scene.backgroundLevel, config.scene.distractorCount, config.seed, { x: config.beacon.startX, y: config.beacon.startY ?? config.scene.height / 2 });
const trajectory = createTrajectory({
  mode: config.beacon.motion,
  speed: config.beacon.speed,
  sceneWidth: config.scene.width,
  sceneHeight: config.scene.height,
  startX: config.beacon.startX ?? sceneData.startX,
  startY: config.beacon.startY ?? sceneData.startY,
  margin: 80,
  rng: makeRng(config.seed ^ 0x1234abcd),
});
const camera = createCamera({
  maxPanSpeedDegS: config.camera.maxPanSpeedDegS,
  maxTiltSpeedDegS: config.camera.maxTiltSpeedDegS,
  resolutionWidth: config.camera.resolutionWidth,
  resolutionHeight: config.camera.resolutionHeight,
  sceneWidth: config.scene.width,
  sceneHeight: config.scene.height,
  fovXDeg: config.camera.fovXDeg,
  fovYDeg: config.camera.fovYDeg,
});
const platform = new PlatformMotion(config.platformMotion.mode, config.platformMotion.maxPxPerFrame, config.platformMotion.speed);
const beacon = makeBeacon(1, sceneData.startX, sceneData.startY, config.beacon.intensity);
const rngMain = makeRng(config.seed);
const gauss = makeGaussian(rngMain);
const jitterGauss = makeGaussFor(makeRng(config.seed ^ 0x9e3779b9));

const w = config.camera.resolutionWidth;
const h = config.camera.resolutionHeight;
const frameBuf = new Uint8Array(w * h);

let lastPanCmd = 0;
let lastTiltCmd = 0;

const host: PipelineHost = {
  applyCommand(cmd, dtS) {
    stepCamera(camera, cmd.pan_deg_s, cmd.tilt_deg_s, dtS);
    lastPanCmd = cmd.pan_deg_s;
    lastTiltCmd = cmd.tilt_deg_s;
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
};

const pipeline = new Pipeline(config, { mode: 'simulation', fps: config.camera.updateHz, resolution: [w, h], has_ground_truth: true }, host, 'simulation');

const dt = 1 / config.camera.updateHz;
let t = 0;
console.log(`beacon start: (${beacon.x_px.toFixed(0)}, ${beacon.y_px.toFixed(0)}), motion=${config.beacon.motion}`);
for (let fi = 1; fi <= seconds * config.camera.updateHz; fi++) {
  t += dt;
  const traj = trajectory.at(t);
  beacon.x_px = traj.x;
  beacon.y_px = traj.y;
  beacon.vx_px_s = traj.vx;
  beacon.vy_px_s = traj.vy;
  renderScene({
    scene: sceneData.scene,
    background: sceneData.background,
    sceneWidth: config.scene.width,
    sceneHeight: config.scene.height,
    backgroundLevel: config.scene.backgroundLevel,
    beacon,
    beaconSizePx: config.beacon.sizePx,
    beaconShape: 'square',
    killBeacon: false,
    blinkOff: false,
    distractors: sceneData.distractors,
  });
  const plat = platform.step(dt);
  const cc = cameraCenterPx(camera);
  const centerX = cc.cx + plat.dx;
  const centerY = cc.cy + plat.dy;

  cropFrame(sceneData.scene, config.scene.width, config.scene.height, frameBuf, w, h, centerX, centerY);

  // ground truth in IMAGE space for the metrics branch (docs/MVP §5)
  const gtImageX = beacon.x_px - (centerX - w / 2);
  const gtImageY = beacon.y_px - (centerY - h / 2);

  const packet = {
    frame: frameBuf,
    width: w,
    height: h,
    timestamp_s: t,
    frame_index: fi,
    ground_truth: { ...beacon, x_px: gtImageX, y_px: gtImageY },
    pan_deg: camera.pan_deg,
    tilt_deg: camera.tilt_deg,
  };
  const r = pipeline.step(packet);
  if (fi % 15 === 0) {
    const c = cameraCenterPx(camera);
    console.log(
      `[f${fi}] t=${t.toFixed(2)} state=${r.track.state} det=${r.detection.found ? `(${r.detection.x?.toFixed(0)},${r.detection.y?.toFixed(0)}) conf ${r.detection.confidence.toFixed(2)}` : 'none'} ` +
        `est=(${r.track.x?.toFixed(0) ?? '—'},${r.track.y?.toFixed(0) ?? '—'}) gtScene=(${beacon.x_px.toFixed(0)},${beacon.y_px.toFixed(0)}) ` +
        `err=${r.errorPx?.toFixed(1) ?? '—'} cam=(${camera.pan_deg.toFixed(2)}°,${camera.tilt_deg.toFixed(2)}°) cmd=(${lastPanCmd.toFixed(2)},${lastTiltCmd.toFixed(2)})`,
    );
  }
}
const result = pipeline.getMetrics().finalize('headless');
console.log('--- RESULT ---');
console.log(JSON.stringify({
  acquisition: result.acquisition_time_s,
  avg_err: result.avg_error_px,
  max_err: result.max_error_px,
  rmse: result.rmse_px,
  loss: result.target_loss_percent,
  lock: result.lock_retention_percent,
  fps: result.fps_measured,
  pass: result.pass_fail,
}, null, 1));
