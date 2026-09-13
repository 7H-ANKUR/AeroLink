import { validateConfig, DEFAULT_CONFIG } from '../src/engine/config';
import { createTrajectory } from '../src/engine/trajectories';
import { initScene, renderScene, makeBeacon } from '../src/engine/scene';
import { createCamera, cropFrame, stepCamera, cameraCenterPx, makeGaussFor } from '../src/engine/camera';
import { makeRng, makeGaussian } from '../src/engine/rng';
import { Pipeline, type PipelineHost } from '../src/engine/pipeline';

const seed = 42;
const cfg = validateConfig({ ...structuredClone(DEFAULT_CONFIG), seed, durationS: 45, beacon: { ...structuredClone(DEFAULT_CONFIG).beacon, blinkPeriodS: 9 } });
if (!cfg.ok) process.exit(1);
const config = cfg.config;
const sceneData = initScene(config.scene.width, config.scene.height, config.scene.backgroundLevel, config.scene.distractorCount, config.seed, { x: config.beacon.startX, y: config.beacon.startY ?? config.scene.height / 2 });
const trajectory = createTrajectory({ mode: config.beacon.motion, speed: config.beacon.speed, sceneWidth: config.scene.width, sceneHeight: config.scene.height, startX: config.beacon.startX ?? sceneData.startX, startY: config.beacon.startY ?? sceneData.startY, margin: 80, rng: makeRng(config.seed ^ 0x1234abcd) });
const camera = createCamera({ maxPanSpeedDegS: config.camera.maxPanSpeedDegS, maxTiltSpeedDegS: config.camera.maxTiltSpeedDegS, resolutionWidth: config.camera.resolutionWidth, resolutionHeight: config.camera.resolutionHeight, sceneWidth: config.scene.width, sceneHeight: config.scene.height, fovXDeg: config.camera.fovXDeg, fovYDeg: config.camera.fovYDeg });
const beacon = makeBeacon(1, sceneData.startX, sceneData.startY, config.beacon.intensity);
const rngMain = makeRng(config.seed);
const gauss = makeGaussian(rngMain);
const w = config.camera.resolutionWidth; const h = config.camera.resolutionHeight;
const frameBuf = new Uint8Array(w * h);
const host: PipelineHost = {
  applyCommand(cmd, dtS) { stepCamera(camera, cmd.pan_deg_s, cmd.tilt_deg_s, dtS); return { pan_deg: camera.pan_deg, tilt_deg: camera.tilt_deg }; },
  viewportCenter() { const c = cameraCenterPx(camera); return { x: c.cx, y: c.cy }; },
  pixelsPerDeg() { return { x: camera.pxPerDegX, y: camera.pxPerDegY }; },
  sceneToImage(x, y) { const c = cameraCenterPx(camera); const ix = x - (c.cx - w / 2); const iy = y - (c.cy - h / 2); if (ix < 0 || iy < 0 || ix >= w || iy >= h) return null; return { x: ix, y: iy }; },
  onTransition(from, to, fi) { if (to !== 'TRACK') console.log(`  [f${fi}] ${from} → ${to}`); },
  onAcquired(t) { console.log(`  >> acquired t=${t.toFixed(2)}s`); },
  onLossConfirmed(_t, fi) { console.log(`  !! loss confirmed [f${fi}]`); },
  onReacquired(rt) { console.log(`  >> REACQUIRED in ${rt.toFixed(3)}s`); },
};
const pipeline = new Pipeline(config, { mode: 'simulation', fps: config.camera.updateHz, resolution: [w, h], has_ground_truth: true }, host, 'simulation');
const dt = 1 / config.camera.updateHz; let t = 0;
for (let fi = 1; fi <= 45 * config.camera.updateHz; fi++) {
  t += dt;
  const traj = trajectory.at(t);
  beacon.x_px = traj.x; beacon.y_px = traj.y;
  const blinkOff = config.beacon.blinkPeriodS > 0 && (t % config.beacon.blinkPeriodS) < config.beacon.blinkPeriodS * 0.12;
  renderScene({ scene: sceneData.scene, background: sceneData.background, sceneWidth: config.scene.width, sceneHeight: config.scene.height, backgroundLevel: config.scene.backgroundLevel, beacon, beaconSizePx: config.beacon.sizePx, beaconShape: 'square', killBeacon: false, blinkOff, distractors: sceneData.distractors });
  const cc = cameraCenterPx(camera);
  cropFrame(sceneData.scene, config.scene.width, config.scene.height, frameBuf, w, h, cc.cx, cc.cy);
  pipeline.step({ frame: frameBuf, width: w, height: h, timestamp_s: t, frame_index: fi, ground_truth: { ...beacon, x_px: beacon.x_px - (cc.cx - w / 2), y_px: beacon.y_px - (cc.cy - h / 2) }, pan_deg: camera.pan_deg, tilt_deg: camera.tilt_deg });
}
const r = pipeline.getMetrics().finalize('reacq');
console.log(`loss=${r.target_loss_percent}% reacq avg=${r.reacquisition_avg_s}s max=${r.reacquisition_max_s}s events=${r.reacquisition_events} lock=${r.lock_retention_percent}% avgErr=${r.avg_error_px}`);
console.log('pass_fail:', JSON.stringify(r.pass_fail));
