/**
 * Batch benchmark gate — runs all 14 PS-169 presets headlessly and reports
 * pass/fail per scenario (docs/08 §5: repeated seeds, mean must meet target).
 * Usage: bun scripts/batch-test.ts
 */
import { SCENARIO_PRESETS } from '../src/engine/scenarios';
import type { ScenarioConfig } from '../src/engine/config';
import { createTrajectory } from '../src/engine/trajectories';
import { initScene, renderScene, makeBeacon } from '../src/engine/scene';
import { createCamera, cropFrame, stepCamera, cameraCenterPx, PlatformMotion, makeGaussFor, atmosphereParams, applyDisturbances } from '../src/engine/camera';
import { makeRng, makeGaussian } from '../src/engine/rng';
import { Pipeline, type PipelineHost } from '../src/engine/pipeline';
import type { PanTiltCommand } from '../src/engine/types';

function runScenario(config: ScenarioConfig, seconds: number): Record<string, number | boolean | null> {
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
  const atm = atmosphereParams(config.atmosphere.mode, config.atmosphere.contrastFactor, config.atmosphere.brightnessFactor);

  const w = config.camera.resolutionWidth;
  const h = config.camera.resolutionHeight;
  const frameBuf = new Uint8Array(w * h);

  const host: PipelineHost = {
    applyCommand(cmd: PanTiltCommand, dtS: number) {
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
  let blinkPhase = 0;
  for (let fi = 1; fi <= seconds * config.camera.updateHz; fi++) {
    t += dt;
    const traj = trajectory.at(t);
    beacon.x_px = traj.x;
    beacon.y_px = traj.y;
    beacon.vx_px_s = traj.vx;
    beacon.vy_px_s = traj.vy;
    let blinkOff = false;
    if (config.beacon.blinkPeriodS > 0) {
      blinkPhase = t % config.beacon.blinkPeriodS;
      blinkOff = blinkPhase < config.beacon.blinkPeriodS * 0.12;
    }
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
      blinkOff,
      distractors: sceneData.distractors,
    });
    const plat = platform.step(dt);
    const cc = cameraCenterPx(camera);
    let jx = 0;
    let jy = 0;
    if (config.jitter.enabled && config.jitter.maxPxPerFrame > 0) {
      jx = (jitterGauss() * config.jitter.maxPxPerFrame) / 2;
      jy = (jitterGauss() * config.jitter.maxPxPerFrame) / 2;
    }
    const centerX = cc.cx + plat.dx + jx;
    const centerY = cc.cy + plat.dy + jy;
    cropFrame(sceneData.scene, config.scene.width, config.scene.height, frameBuf, w, h, centerX, centerY);
    applyDisturbances(
      frameBuf,
      w,
      h,
      {
        saltPepperPercent: config.noise.saltPepperPercent,
        gaussianSigma: config.noise.gaussianSigma,
        poissonEnabled: config.noise.poissonEnabled,
        contrastFactor: atm.contrastFactor,
        brightnessFactor: atm.brightnessFactor,
        rainStrength: atm.rainStrength,
      },
      rngMain,
      gauss,
    );
    const gtImageX = beacon.x_px - (centerX - w / 2);
    const gtImageY = beacon.y_px - (centerY - h / 2);
    pipeline.step({
      frame: frameBuf,
      width: w,
      height: h,
      timestamp_s: t,
      frame_index: fi,
      ground_truth: { ...beacon, x_px: gtImageX, y_px: gtImageY },
      pan_deg: camera.pan_deg,
      tilt_deg: camera.tilt_deg,
    });
  }
  const r = pipeline.getMetrics().finalize('batch');
  return {
    acq: r.acquisition_time_s,
    avg: r.avg_error_px,
    rmse: r.rmse_px,
    loss: r.target_loss_percent,
    lock: r.lock_retention_percent,
    reacq: r.reacquisition_avg_s,
    reacqN: r.reacquisition_events,
    fps: r.fps_measured,
    allPass: r.pass_fail ? Object.values(r.pass_fail).every(Boolean) : false,
  };
}

const presets = SCENARIO_PRESETS;
console.log('scenario                    |  acq(s) | avg(px) | rmse | loss% | lock% | re-acq(s) | fps  | ALL (mean of 5 seeds, docs/08 §5)');
console.log('-'.repeat(110));
let passCount = 0;
for (const p of presets) {
  // docs/08 §5 score stability: ≥5 seeded runs per scenario; gate on the MEAN
  const runs = [0, 1, 2, 3, 4].map((i) => {
    const cfg = { ...structuredClone(p.config), seed: p.config.seed + i * 137 };
    return runScenario(cfg, 30);
  });
  const mean = (k: string) => {
    const vals = runs.map((r) => r[k] as number | null).filter((v): v is number => v !== null && Number.isFinite(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  // Mean-gate against official PS targets (docs/08 §2 + §5)
  const gates = {
    acquisition: (mean('acq') as number | null) !== null && (mean('acq') as number) <= 2.0,
    tracking_error: (mean('avg') as number) <= 10,
    target_loss: (mean('loss') as number) < 5,
    reacquisition: (mean('reacq') as number | null) === null || (mean('reacq') as number) <= 1.0,
    processing_speed: (mean('fps') as number) >= 20,
  };
  const allPass = Object.values(gates).every(Boolean);
  if (allPass) passCount++;
  const f = (v: number | null, d = 2) => (v === null ? '  — ' : v.toFixed(d));
  console.log(
    `${p.name.padEnd(27)} | ${f(mean('acq') as number, 2).padStart(7)} | ${f(mean('avg') as number).padStart(7)} | ${f(mean('rmse') as number).padStart(4)} | ${f(mean('loss') as number, 1).padStart(5)} | ${f(mean('lock') as number, 1).padStart(5)} | ${f(mean('reacq') as number).padStart(9)} | ${f(mean('fps') as number, 0).padStart(4)} | ${allPass ? 'PASS' : 'FAIL'}`,
  );
}
console.log('-'.repeat(110));
console.log(`${passCount}/${presets.length} scenarios pass all PS-169 gates (mean of 5 seeded runs each)`);

