/**
 * Simulation engine worker (docs/04 §6 threading model).
 * The full processing loop — scene render → disturbances → camera crop →
 * detect → track → control → metrics — runs HERE, never on the UI thread.
 * All messages to the UI carry immutable snapshots; frame buffers are
 * transferred (zero-copy) from a rotating pool.
 */
import { scenarioConfigSchema, type ScenarioConfig } from '../engine/config';
import { createTrajectory } from '../engine/trajectories';
import { initScene, renderScene, makeBeacon, type SceneInitResult } from '../engine/scene';
import {
  createCamera,
  cropFrame,
  stepCamera,
  applyDisturbances,
  atmosphereParams,
  PlatformMotion,
  cameraCenterPx,
  makeGaussFor,
} from '../engine/camera';
import { Pipeline, type PipelineHost } from '../engine/pipeline';
import { MetricsEngine } from '../engine/metrics';
import { eventsToCsv } from '../engine/export';
import { makeRng, makeGaussian } from '../engine/rng';
import type {
  Detection,
  FramePacket,
  LogLevel,
  PanTiltCommand,
  TelemetrySnapshot,
} from '../engine/types';

interface WorkerAPI {
  init(config: unknown): void;
  start(): void;
  pause(): void;
  stop(reason?: string): void;
  killBeacon(frames: number): void;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let config: ScenarioConfig | null = null;
let sceneData: SceneInitResult | null = null;
let trajectory: ReturnType<typeof createTrajectory> | null = null;
let camera: ReturnType<typeof createCamera> | null = null;
let platform: PlatformMotion | null = null;
let pipeline: Pipeline | null = null;
let metrics: MetricsEngine | null = null;
let rngMain = makeRng(1);
let gaussMain = makeGaussian(rngMain);
let jitterGauss = makeGaussFor(rngMain);

let running = false;
let paused = false;
let frameIndex = 0;
let simTimeS = 0;
let lastLoopMs = 0;
let killBeaconFrames = 0;
let beacon: ReturnType<typeof makeBeacon> | null = null;
let lastCommand: PanTiltCommand = { pan_deg_s: 0, tilt_deg_s: 0 };
let lastDetection: Detection = {
  found: false,
  x: null,
  y: null,
  confidence: 0,
  bbox: null,
  method: 'cv',
  latency_ms: 0,
};
let lastTrack: TelemetrySnapshot['track'] = {
  state: 'SEARCH',
  x: null,
  y: null,
  vx: null,
  vy: null,
  confidence: 0,
  track_age_frames: 0,
  lost_frames_consecutive: 0,
  is_prediction: false,
};
let jitterPx = 0;
let lastCropCenter = { x: 0, y: 0 }; // true crop center (includes jitter + platform)
let timer: ReturnType<typeof setTimeout> | null = null;
let framePool: ArrayBuffer[] = [];
let poolIdx = 0;
const POOL_SIZE = 4;
let logIdCounter = 0;

function postLog(level: LogLevel, message: string, detail?: string): void {
  const d = new Date();
  const pad = (v: number, n = 2) => String(v).padStart(n, '0');
  ctx.postMessage({
    type: 'log',
    entry: {
      id: ++logIdCounter,
      t: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`,
      simT: simTimeS,
      level,
      message,
      detail,
    },
  });
}

function initEngine(rawConfig: unknown): void {
  const parsed = scenarioConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    ctx.postMessage({ type: 'error', message: 'Configuration validation failed on worker side.' });
    return;
  }
  config = parsed.data;
  const cfg = config;

  // All randomness derives from the scenario seed (determinism requirement)
  rngMain = makeRng(cfg.seed);
  gaussMain = makeGaussian(rngMain);
  jitterGauss = makeGaussFor(makeRng(cfg.seed ^ 0x9e3779b9));

  sceneData = initScene(
    cfg.scene.width,
    cfg.scene.height,
    cfg.scene.backgroundLevel,
    cfg.scene.distractorCount,
    cfg.seed,
    { x: cfg.beacon.startX, y: cfg.beacon.startY ?? cfg.scene.height / 2 },
  );
  trajectory = createTrajectory({
    mode: cfg.beacon.motion,
    speed: cfg.beacon.speed,
    sceneWidth: cfg.scene.width,
    sceneHeight: cfg.scene.height,
    startX: cfg.beacon.startX ?? sceneData.startX,
    startY: cfg.beacon.startY ?? sceneData.startY,
    margin: 80,
    rng: makeRng(cfg.seed ^ 0x1234abcd),
  });
  camera = createCamera({
    maxPanSpeedDegS: cfg.camera.maxPanSpeedDegS,
    maxTiltSpeedDegS: cfg.camera.maxTiltSpeedDegS,
    resolutionWidth: cfg.camera.resolutionWidth,
    resolutionHeight: cfg.camera.resolutionHeight,
    sceneWidth: cfg.scene.width,
    sceneHeight: cfg.scene.height,
    fovXDeg: cfg.camera.fovXDeg,
    fovYDeg: cfg.camera.fovYDeg,
  });
  platform = new PlatformMotion(cfg.platformMotion.mode, cfg.platformMotion.maxPxPerFrame, cfg.platformMotion.speed);

  beacon = makeBeacon(1, sceneData.startX, sceneData.startY, cfg.beacon.intensity);
  frameIndex = 0;
  simTimeS = 0;
  killBeaconFrames = 0;
  paused = false;
  running = false;

  framePool = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    framePool.push(new ArrayBuffer(cfg.camera.resolutionWidth * cfg.camera.resolutionHeight));
  }
  poolIdx = 0;

  const w = cfg.camera.resolutionWidth;
  const h = cfg.camera.resolutionHeight;

  const host: PipelineHost = {
    applyCommand(cmd: PanTiltCommand, dtS: number) {
      const r = stepCamera(camera!, cmd.pan_deg_s, cmd.tilt_deg_s, dtS);
      lastCommand = cmd;
      return { pan_deg: camera!.pan_deg, tilt_deg: camera!.tilt_deg };
    },
    viewportCenter() {
      // true crop center (with jitter + platform offsets applied this frame)
      return { x: lastCropCenter.x, y: lastCropCenter.y };
    },
    pixelsPerDeg() {
      return { x: camera!.pxPerDegX, y: camera!.pxPerDegY };
    },
    sceneToImage(x: number, y: number) {
      const ix = x - (lastCropCenter.x - w / 2);
      const iy = y - (lastCropCenter.y - h / 2);
      if (ix < 0 || iy < 0 || ix >= w || iy >= h) return null;
      return { x: ix, y: iy };
    },
    onTransition(from: string, to: string, fi: number) {
      postLog('STATE', `${from} → ${to}`, `frame=${fi}`);
      // docs/04 §4.13: integrator reset on entry to SEARCH / ACQUIRE
      if (to === 'SEARCH' || to === 'ACQUIRE') {
        pipeline?.resetControllerIntegrator();
      }
    },
    onAcquired(t: number, _fi: number) {
      void _fi;
      postLog('METRIC', 'Acquisition confirmed', `${t.toFixed(3)}s from run start`);
    },
    onLossConfirmed(_t: number, _fi: number) {
      postLog('TRACK', 'Target loss confirmed — prediction engaged');
    },
    onReacquired(rt: number, _fi: number) {
      postLog('METRIC', 'Re-acquired target', `${rt.toFixed(3)}s after loss`);
    },
  };

  pipeline = new Pipeline(cfg, { mode: 'simulation', fps: cfg.camera.updateHz, resolution: [w, h], has_ground_truth: true }, host, 'simulation');
  metrics = pipeline.getMetrics();

  postLog('INFO', 'Engine initialized', `scene ${cfg.scene.width}×${cfg.scene.height}, cam ${w}×${h} @ ${cfg.camera.updateHz}Hz, seed ${cfg.seed}`);
  ctx.postMessage({ type: 'initialized' });
}

function loop(): void {
  if (!running) return;
  const loopStart = performance.now();
  stepOnce();
  const cfg = config!;
  const interval = 1000 / cfg.camera.updateHz;
  const spent = performance.now() - loopStart;
  const wait = Math.max(1, interval - spent);
  timer = setTimeout(loop, wait);
}

function stepOnce(): void {
  const cfg = config;
  if (!cfg || !sceneData || !trajectory || !camera || !pipeline || !metrics || !beacon) return;

  const now = performance.now();
  const wallDt = lastLoopMs ? (now - lastLoopMs) / 1000 : 1 / cfg.camera.updateHz;
  lastLoopMs = now;
  const dt = Math.min(0.2, Math.max(0.001, wallDt));
  simTimeS += dt;
  frameIndex++;

  // ---- Ground truth update (beacon trajectory) ----
  const traj = trajectory.at(simTimeS);
  beacon.x_px = traj.x;
  beacon.y_px = traj.y;
  beacon.vx_px_s = traj.vx;
  beacon.vy_px_s = traj.vy;
  beacon.visible = true;

  // blink (temporary loss demonstration)
  let blinkOff = false;
  if (cfg.beacon.blinkPeriodS > 0) {
    const phase = simTimeS % cfg.beacon.blinkPeriodS;
    blinkOff = phase < cfg.beacon.blinkPeriodS * 0.12;
  }

  // ---- Render clean scene ----
  renderScene({
    scene: sceneData.scene,
    background: sceneData.background,
    sceneWidth: cfg.scene.width,
    sceneHeight: cfg.scene.height,
    backgroundLevel: cfg.scene.backgroundLevel,
    beacon,
    beaconSizePx: cfg.beacon.sizePx,
    beaconShape: 'square',
    killBeacon: killBeaconFrames > 0,
    blinkOff,
    distractors: sceneData.distractors,
  });
  if (killBeaconFrames > 0) {
    killBeaconFrames--;
    if (killBeaconFrames === 0) postLog('INFO', 'Beacon restored after kill');
  }

  // ---- Camera pose: platform motion + jitter ----
  const plat = platform ? platform.step(dt) : { dx: 0, dy: 0 };
  let jitterDx = 0;
  let jitterDy = 0;
  if (cfg.jitter.enabled && cfg.jitter.maxPxPerFrame > 0) {
    jitterDx = (jitterGauss() * cfg.jitter.maxPxPerFrame) / 2;
    jitterDy = (jitterGauss() * cfg.jitter.maxPxPerFrame) / 2;
    const mag = Math.hypot(jitterDx, jitterDy);
    if (mag > cfg.jitter.maxPxPerFrame) {
      const s = cfg.jitter.maxPxPerFrame / mag;
      jitterDx *= s;
      jitterDy *= s;
    }
    if (frameIndex % 30 === 0 && mag > 1) {
      postLog('DIST', 'Camera jitter', `${mag.toFixed(1)} px`);
    }
  }
  jitterPx = Math.hypot(jitterDx, jitterDy);

  const cc = cameraCenterPx(camera);
  const centerX = cc.cx + plat.dx + jitterDx;
  const centerY = cc.cy + plat.dy + jitterDy;
  lastCropCenter = { x: centerX, y: centerY };

  // ---- Crop sensor window ----
  const w = cfg.camera.resolutionWidth;
  const h = cfg.camera.resolutionHeight;
  const frameBuf = new Uint8Array(framePool[poolIdx]);
  poolIdx = (poolIdx + 1) % POOL_SIZE;
  cropFrame(sceneData.scene, cfg.scene.width, cfg.scene.height, frameBuf, w, h, centerX, centerY);

  // ---- Disturbance chain (does NOT touch ground truth) ----
  const atm = atmosphereParams(cfg.atmosphere.mode, cfg.atmosphere.contrastFactor, cfg.atmosphere.brightnessFactor);
  applyDisturbances(
    frameBuf,
    w,
    h,
    {
      saltPepperPercent: cfg.noise.saltPepperPercent,
      gaussianSigma: cfg.noise.gaussianSigma,
      poissonEnabled: cfg.noise.poissonEnabled,
      contrastFactor: atm.contrastFactor,
      brightnessFactor: atm.brightnessFactor,
      rainStrength: atm.rainStrength,
    },
    rngMain,
    gaussMain,
  );

  // ---- Frame packet (ground truth is IMAGE-space for the metrics branch,
  // per docs/MVP-Tech-Doc §5 — never seen by the detector) ----
  const gtImageX = beacon.x_px - (centerX - w / 2);
  const gtImageY = beacon.y_px - (centerY - h / 2);
  const packet: FramePacket = {
    frame: frameBuf,
    width: w,
    height: h,
    timestamp_s: simTimeS,
    frame_index: frameIndex,
    ground_truth: killBeaconFrames > 0 || blinkOff ? { ...beacon, x_px: gtImageX, y_px: gtImageY, visible: false } : { ...beacon, x_px: gtImageX, y_px: gtImageY },
    pan_deg: camera.pan_deg,
    tilt_deg: camera.tilt_deg,
  };

  // ---- Pipeline: detect → track → control → metrics ----
  const result = pipeline.step(packet);
  lastDetection = result.detection;
  lastTrack = result.track;

  // ---- Telemetry snapshot to UI (transferred frame buffer, zero-copy) ----
  const metricsSnap = metrics.snapshot(simTimeS);
  const snap: TelemetrySnapshot = {
    frameIndex,
    timestampS: simTimeS,
    detection: { ...result.detection },
    track: { ...result.track },
    command: { ...result.command },
    camera: { pan_deg: result.cameraPan, tilt_deg: result.cameraTilt },
    groundTruth: { x_px: beacon.x_px, y_px: beacon.y_px, vx_px_s: beacon.vx_px_s, vy_px_s: beacon.vy_px_s }, // scene-space for 3D/trajectory views
    beaconImageX: result.beaconImageX,
    beaconImageY: result.beaconImageY,
    errorPx: result.errorPx,
    locked: false,
    lost: result.track.state === 'SEARCH',
    processingMs: result.processingMs,
    metrics: metricsSnap,
    jitterPx,
    activeDisturbances: collectActiveDisturbances(cfg),
  };

  const transferBuf = frameBuf.buffer.slice(0);
  ctx.postMessage(
    {
      type: 'frame',
      frame: transferBuf,
      width: w,
      height: h,
      snapshot: snap,
      cameraPose: { pan_deg: camera.pan_deg, tilt_deg: camera.tilt_deg },
      viewportCenterScene: { x: result.viewportCenterSceneX, y: result.viewportCenterSceneY },
    },
    [transferBuf],
  );

  // end-of-run
  if (simTimeS >= cfg.durationS) {
    finishRun('Scenario duration reached');
  }
}

function collectActiveDisturbances(cfg: ScenarioConfig): string[] {
  const active: string[] = [];
  if (cfg.noise.saltPepperPercent > 0) active.push(`Salt&Pepper ${cfg.noise.saltPepperPercent}%`);
  if (cfg.noise.gaussianSigma > 0) active.push(`Gaussian σ=${cfg.noise.gaussianSigma}`);
  if (cfg.noise.poissonEnabled) active.push('Poisson');
  if (cfg.jitter.enabled) active.push(`Jitter ±${cfg.jitter.maxPxPerFrame}px`);
  if (cfg.atmosphere.mode !== 'clear') active.push(cfg.atmosphere.mode.replace('_', ' '));
  if (cfg.platformMotion.mode !== 'none') active.push(`Platform ${cfg.platformMotion.mode}`);
  return active;
}

function finishRun(reason: string): void {
  running = false;
  paused = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!metrics || !pipeline || !config) return;
  const result = metrics.finalize(config.scenarioName + reason);
  postLog('INFO', `Run complete — ${reason}`, `${result.frames_processed} frames processed`);
  const csv = eventsToCsv(metrics.eventRows);
  ctx.postMessage({ type: 'result', result, eventsCsv: csv });
  ctx.postMessage({ type: 'phase', phase: 'complete' });
}

const api: WorkerAPI = {
  init(rawConfig) {
    initEngine(rawConfig);
  },
  start() {
    if (!config || !pipeline) return;
    running = true;
    paused = false;
    lastLoopMs = 0;
    postLog('INFO', 'Simulation started', `run seed=${config.seed}`);
    ctx.postMessage({ type: 'phase', phase: 'running' });
    loop();
  },
  pause() {
    if (!running) return;
    paused = !paused;
    postLog('INFO', paused ? 'Simulation paused' : 'Simulation resumed');
    ctx.postMessage({ type: 'phase', phase: paused ? 'paused' : 'running' });
    // simple pause: stop scheduling while paused, resume restarts loop
    if (paused && timer) {
      clearTimeout(timer);
      timer = null;
    } else if (!paused) {
      loop();
    }
  },
  stop(reason) {
    if (running) {
      finishRun(reason ?? 'Stopped by operator');
    } else {
      ctx.postMessage({ type: 'phase', phase: 'idle' });
    }
  },
  killBeacon(frames) {
    killBeaconFrames = frames;
    postLog('WARN', `DEBUG: beacon killed for ${frames} frames`);
  },
};

const workerSelf = self as any;
workerSelf.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      api.init(msg.config);
      break;
    case 'start':
      api.start();
      break;
    case 'pause':
      api.pause();
      break;
    case 'stop':
      api.stop(msg.reason);
      break;
    case 'killBeacon':
      api.killBeacon(msg.frames);
      break;
    case 'resetIntegrator':
      pipeline?.resetControllerIntegrator();
      break;
  }
};
