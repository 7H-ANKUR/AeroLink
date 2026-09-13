/**
 * Generates the sample run deliverables from a REAL engine run:
 *   metrics.json   — RunResult (docs/05 §4 schema)
 *   events.csv     — per-frame log (docs/05 §3 schema)
 *   summary.html   — human-readable report (docs/04 §4.16)
 * Written to public/samples/ (served by the app) and download/.
 * Usage: bun scripts/generate-sample-reports.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { validateConfig, DEFAULT_CONFIG } from '../src/engine/config';
import { createTrajectory } from '../src/engine/trajectories';
import { initScene, renderScene, makeBeacon } from '../src/engine/scene';
import { createCamera, cropFrame, stepCamera, cameraCenterPx, makeGaussFor } from '../src/engine/camera';
import { makeRng, makeGaussian } from '../src/engine/rng';
import { Pipeline, type PipelineHost } from '../src/engine/pipeline';
import { eventsToCsv, summaryHtml } from '../src/engine/export';

const DURATION = 60;
const cfg = validateConfig({ ...structuredClone(DEFAULT_CONFIG), seed: 42, durationS: DURATION });
if (!cfg.ok) {
  console.error(cfg.errors);
  process.exit(1);
}
const config = cfg.config;

const sceneData = initScene(config.scene.width, config.scene.height, config.scene.backgroundLevel, config.scene.distractorCount, config.seed, { x: config.beacon.startX, y: config.beacon.startY ?? config.scene.height / 2 });
const trajectory = createTrajectory({ mode: config.beacon.motion, speed: config.beacon.speed, sceneWidth: config.scene.width, sceneHeight: config.scene.height, startX: config.beacon.startX ?? sceneData.startX, startY: config.beacon.startY ?? sceneData.startY, margin: 80, rng: makeRng(config.seed ^ 0x1234abcd) });
const camera = createCamera({ maxPanSpeedDegS: config.camera.maxPanSpeedDegS, maxTiltSpeedDegS: config.camera.maxTiltSpeedDegS, resolutionWidth: config.camera.resolutionWidth, resolutionHeight: config.camera.resolutionHeight, sceneWidth: config.scene.width, sceneHeight: config.scene.height, fovXDeg: config.camera.fovXDeg, fovYDeg: config.camera.fovYDeg });
const beacon = makeBeacon(1, sceneData.startX, sceneData.startY, config.beacon.intensity);
const rngMain = makeRng(config.seed);
const gauss = makeGaussian(rngMain);
const w = config.camera.resolutionWidth;
const h = config.camera.resolutionHeight;
const frameBuf = new Uint8Array(w * h);

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
  onTransition() {},
  onAcquired() {},
  onLossConfirmed() {},
  onReacquired() {},
};

const pipeline = new Pipeline(config, { mode: 'simulation', fps: config.camera.updateHz, resolution: [w, h], has_ground_truth: true }, host, 'simulation');
const dt = 1 / config.camera.updateHz;
let t = 0;
for (let fi = 1; fi <= DURATION * config.camera.updateHz; fi++) {
  t += dt;
  const traj = trajectory.at(t);
  beacon.x_px = traj.x;
  beacon.y_px = traj.y;
  beacon.vx_px_s = traj.vx;
  beacon.vy_px_s = traj.vy;
  renderScene({ scene: sceneData.scene, background: sceneData.background, sceneWidth: config.scene.width, sceneHeight: config.scene.height, backgroundLevel: config.scene.backgroundLevel, beacon, beaconSizePx: config.beacon.sizePx, beaconShape: 'square', killBeacon: false, blinkOff: false, distractors: sceneData.distractors });
  const cc = cameraCenterPx(camera);
  cropFrame(sceneData.scene, config.scene.width, config.scene.height, frameBuf, w, h, cc.cx, cc.cy);
  pipeline.step({ frame: frameBuf, width: w, height: h, timestamp_s: t, frame_index: fi, ground_truth: { ...beacon, x_px: beacon.x_px - (cc.cx - w / 2), y_px: beacon.y_px - (cc.cy - h / 2) }, pan_deg: camera.pan_deg, tilt_deg: camera.tilt_deg });
}

const result = pipeline.getMetrics().finalize('sample-seed-42');
result.scenario_name = 'PS169-03 Figure-8 / Clear';

const csv = eventsToCsv(pipeline.getMetrics().eventRows);
const html = summaryHtml(result);

for (const dir of ['/home/z/my-project/public/samples', '/home/z/my-project/download']) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/metrics.json`, JSON.stringify(result, null, 2));
  writeFileSync(`${dir}/events.csv`, csv);
  writeFileSync(`${dir}/summary-report.html`, html);
}
console.log('sample run (seed 42, 60 s figure-8):');
console.log(`  acquisition=${result.acquisition_time_s}s avgErr=${result.avg_error_px}px rmse=${result.rmse_px}px loss=${result.target_loss_percent}% lock=${result.lock_retention_percent}% fps=${result.fps_measured}`);
console.log(`  pass_fail=${JSON.stringify(result.pass_fail)}`);
console.log('written: metrics.json, events.csv, summary-report.html → public/samples/ + download/');
