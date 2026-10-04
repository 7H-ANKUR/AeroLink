/**
 * SimulationRunner — the single canonical simulation frame loop.
 *
 * Before this module existed the loop (scene render → platform/jitter offset →
 * sensor crop → disturbance chain → pipeline step) was re-implemented in eight
 * places: the shipped Web Worker, six headless scripts and the integration
 * test. Those copies had silently diverged, so the benchmark gates and the
 * "closed-loop proof" were measuring a loop that was NOT the one that ships.
 *
 * Everything — worker, benchmark, demos, tests — now drives this class, so a
 * change to the loop is a change to what is measured. The semantics here are
 * the SHIPPED ones (previously only the worker had them):
 *
 *  1. jitter magnitude is clamped to jitter.maxPxPerFrame (PS: ±20 px/frame);
 *  2. PipelineHost.viewportCenter()/sceneToImage() use the TRUE crop centre,
 *     i.e. including platform-motion and jitter offsets;
 *  3. the controller integrator is reset on entry to SEARCH / ACQUIRE
 *     (docs/04 §4.13);
 *  4. a blinked-off or killed beacon reports ground_truth.visible = false.
 *
 * Ground truth still branches only to the metrics engine (docs/04 §5) — the
 * packet carries the IMAGE-space beacon centre and the detector never sees it.
 *
 * The caller owns time: step(dtS) advances exactly one frame by dtS seconds.
 * The worker passes a wall-clock delta (real-time behaviour); headless callers
 * pass a fixed 1/updateHz (reproducible behaviour).
 */
import {
  atmosphereParams,
  cameraCenterPx,
  cropFrame,
  createCamera,
  makeGaussFor,
  applyDisturbances,
  PlatformMotion,
  type VirtualCamera,
} from './camera';
import { Pipeline, type PipelineHost, type PipelineStepResult } from './pipeline';
import type { LoadedModel } from './detector-ai';
import { ReceiverMount, type MountTelemetry } from './mount';
import { computeLink, type LinkTelemetry } from './link';
import { MissionTracker, type MissionSnapshot } from './mission';
import { initScene, makeBeacon, renderScene, type SceneInitResult } from './scene';
import { createTrajectory } from './trajectories';
import { makeGaussian, makeRng } from './rng';
import type { MetricsEngine } from './metrics';
import type { ScenarioConfig } from './config';
import type { FramePacket, GroundTruthTarget, PanTiltCommand, RunResult } from './types';

/** One rendered, disturbed frame awaiting the pipeline. */
interface PreparedFrame {
  packet: FramePacket;
  frameBuf: Uint8Array;
  centerX: number;
  centerY: number;
  jitterPx: number;
  blinkOff: boolean;
  beaconRestored: boolean;
  hidden: boolean;
}

/** Optional observers — the same set PipelineHost exposes, minus geometry. */
export interface SimulationHooks {
  onTransition?(from: string, to: string, frameIndex: number): void;
  onAcquired?(acquisitionTimeS: number, frameIndex: number): void;
  onLossConfirmed?(lossTimeS: number, frameIndex: number): void;
  onReacquired?(reacquisitionTimeS: number, frameIndex: number): void;
}

export interface SimulationStepResult {
  frameIndex: number;
  timestampS: number;
  /** The observation buffer handed to the pipeline (disturbances applied). */
  frame: Uint8Array;
  width: number;
  height: number;
  /** Beacon ground truth in SCENE space (telemetry / 3D views only). */
  beacon: GroundTruthTarget;
  /** True sensor-window centre in scene px, incl. platform + jitter. */
  cropCenter: { x: number; y: number };
  /** Magnitude of the jitter offset applied this frame, px. */
  jitterPx: number;
  /** Receiver mount state for this frame (master prompt §15). */
  mount: MountTelemetry;
  /** SIMULATED link quality derived from this frame's pointing error (§20). */
  link: LinkTelemetry;
  /** Mission phases + evidence checks observed so far (§21, §23). */
  mission: MissionSnapshot;
  blinkOff: boolean;
  /** True on the frame a kill-beacon countdown reached zero. */
  beaconRestored: boolean;
  pipeline: PipelineStepResult;
}

export class SimulationRunner {
  config: ScenarioConfig;
  readonly camera: VirtualCamera;
  readonly pipeline: Pipeline;
  readonly sceneData: SceneInitResult;
  readonly beacon: GroundTruthTarget;

  /** Reference trajectory — exposed so tests can assert the beacon path was
   *  never altered by the controller (docs §17: no teleporting to centre). */
  readonly trajectory: ReturnType<typeof createTrajectory>;
  private platform: PlatformMotion;
  private readonly rngMain: ReturnType<typeof makeRng>;
  private readonly gaussMain: () => number;
  private readonly jitterGauss: () => number;
  private atm: ReturnType<typeof atmosphereParams>;
  private readonly width: number;
  private readonly height: number;
  private readonly ownFrameBuf: Uint8Array;

  readonly mount: ReceiverMount;
  readonly missionTracker = new MissionTracker();
  private lastMountTelemetry: MountTelemetry;
  private cropCenter = { x: 0, y: 0 };
  /** Platform offset last frame and its rate, px/s — for exposure smear. */
  private lastPlat: { dx: number; dy: number } | null = null;
  private platVel = { x: 0, y: 0 };
  private killFrames = 0;
  private killLatched = false;

  frameIndex = 0;
  simTimeS = 0;

  constructor(
    config: ScenarioConfig,
    hooks: SimulationHooks = {},
    /** Trained weights, required only when the configured detector is a
     *  learned one. Loaded by the caller (worker: fetch; scripts: readFile)
     *  so the engine itself stays free of I/O. */
    model: LoadedModel | null = null,
  ) {
    this.config = config;
    this.width = config.camera.resolutionWidth;
    this.height = config.camera.resolutionHeight;

    // Every random stream derives from the scenario seed (determinism).
    this.rngMain = makeRng(config.seed);
    this.gaussMain = makeGaussian(this.rngMain);
    this.jitterGauss = makeGaussFor(makeRng(config.seed ^ 0x9e3779b9));

    this.sceneData = initScene(
      config.scene.width,
      config.scene.height,
      config.scene.backgroundLevel,
      config.scene.distractorCount,
      config.seed,
      { x: config.beacon.startX, y: config.beacon.startY },
      { min: config.scene.distractorIntensityMin, max: config.scene.distractorIntensityMax },
    );
    this.trajectory = createTrajectory({
      mode: config.beacon.motion,
      speed: config.beacon.speed,
      sceneWidth: config.scene.width,
      sceneHeight: config.scene.height,
      startX: config.beacon.startX ?? this.sceneData.startX,
      startY: config.beacon.startY ?? this.sceneData.startY,
      margin: 80,
      rng: makeRng(config.seed ^ 0x1234abcd),
    });
    this.camera = createCamera({
      maxPanSpeedDegS: config.camera.maxPanSpeedDegS,
      maxTiltSpeedDegS: config.camera.maxTiltSpeedDegS,
      resolutionWidth: this.width,
      resolutionHeight: this.height,
      sceneWidth: config.scene.width,
      sceneHeight: config.scene.height,
      fovXDeg: config.camera.fovXDeg,
      fovYDeg: config.camera.fovYDeg,
    });
    this.platform = new PlatformMotion(
      config.platformMotion.mode,
      config.platformMotion.maxPxPerFrame,
      config.platformMotion.speed,
    );
    this.atm = atmosphereParams(
      config.atmosphere.mode,
      config.atmosphere.contrastFactor,
      config.atmosphere.brightnessFactor,
    );
    this.mount = new ReceiverMount(config.camera.mountAccelDegS2);
    this.lastMountTelemetry = {
      azimuthDeg: 0,
      elevationDeg: 0,
      commandedPanRateDegS: 0,
      commandedTiltRateDegS: 0,
      actualPanRateDegS: 0,
      actualTiltRateDegS: 0,
      rateSaturated: false,
      accelLimited: false,
      travelLimited: false,
      panEffort: 0,
      tiltEffort: 0,
    };
    this.beacon = makeBeacon(1, this.sceneData.startX, this.sceneData.startY, config.beacon.intensity);
    this.ownFrameBuf = new Uint8Array(this.width * this.height);

    // Initial crop centre = camera boresight, so viewportCenter() is sane
    // before the first step().
    const cc0 = cameraCenterPx(this.camera);
    this.cropCenter = { x: cc0.cx, y: cc0.cy };

    // Arrow properties: `this` is the instance, no aliasing needed.
    const host: PipelineHost = {
      applyCommand: (cmd: PanTiltCommand, dtS: number) => {
        // The mount is the only thing that moves the camera: the command
        // passes through rate saturation and an acceleration limit first.
        this.lastMountTelemetry = this.mount.step(this.camera, cmd.pan_deg_s, cmd.tilt_deg_s, dtS);
        return { pan_deg: this.camera.pan_deg, tilt_deg: this.camera.tilt_deg };
      },
      viewportCenter: () => {
        // TRUE crop centre — includes platform motion and jitter, matching the
        // pixels the detector actually saw this frame.
        return { x: this.cropCenter.x, y: this.cropCenter.y };
      },
      pixelsPerDeg: () => ({ x: this.camera.pxPerDegX, y: this.camera.pxPerDegY }),
      sceneToImage: (x: number, y: number) => {
        const ix = x - (this.cropCenter.x - this.width / 2);
        const iy = y - (this.cropCenter.y - this.height / 2);
        if (ix < 0 || iy < 0 || ix >= this.width || iy >= this.height) return null;
        return { x: ix, y: iy };
      },
      onTransition: (from: string, to: string, fi: number) => {
        // docs/04 §4.13: integrator reset on entry to SEARCH / ACQUIRE
        if (to === 'SEARCH' || to === 'ACQUIRE') {
          this.pipeline.resetControllerIntegrator();
        }
        hooks.onTransition?.(from, to, fi);
      },
      onAcquired: (t: number, fi: number) => hooks.onAcquired?.(t, fi),
      onLossConfirmed: (t: number, fi: number) => hooks.onLossConfirmed?.(t, fi),
      onReacquired: (rt: number, fi: number) => hooks.onReacquired?.(rt, fi),
    };

    this.missionTracker.markInitialized();

    this.pipeline = new Pipeline(
      config,
      {
        mode: 'simulation',
        fps: config.camera.updateHz,
        resolution: [this.width, this.height],
        has_ground_truth: true,
      },
      host,
      'simulation',
      model,
    );
  }

  get metrics(): MetricsEngine {
    return this.pipeline.getMetrics();
  }

  /**
   * Change the disturbance profile mid-run (§18 live controls, §22 demo).
   * Recomputes the derived atmosphere and platform state so the change takes
   * effect on the NEXT frame. Ground truth is untouched, as always.
   */
  setDisturbance(p: {
    noise?: Partial<ScenarioConfig['noise']>;
    jitter?: Partial<ScenarioConfig['jitter']>;
    atmosphere?: Partial<ScenarioConfig['atmosphere']>;
    platformMotion?: Partial<ScenarioConfig['platformMotion']>;
  }): void {
    const cfg = this.config;
    if (p.noise) cfg.noise = { ...cfg.noise, ...p.noise };
    if (p.jitter) cfg.jitter = { ...cfg.jitter, ...p.jitter };
    if (p.atmosphere) cfg.atmosphere = { ...cfg.atmosphere, ...p.atmosphere };
    if (p.platformMotion) {
      cfg.platformMotion = { ...cfg.platformMotion, ...p.platformMotion };
      this.platform = new PlatformMotion(
        cfg.platformMotion.mode,
        cfg.platformMotion.maxPxPerFrame,
        cfg.platformMotion.speed,
      );
    }
    this.atm = atmosphereParams(
      cfg.atmosphere.mode,
      cfg.atmosphere.contrastFactor,
      cfg.atmosphere.brightnessFactor,
    );
  }

  /** Hide the beacon for the next `frames` frames (debug KILL BEACON). */
  killBeaconForFrames(frames: number): void {
    this.killFrames = frames;
    this.killLatched = false;
  }

  /** Hold the beacon hidden until cleared (time-window style outages). */
  setBeaconKilled(killed: boolean): void {
    this.killLatched = killed;
    if (!killed) this.killFrames = 0;
  }

  get beaconKilled(): boolean {
    return this.killLatched || this.killFrames > 0;
  }

  /**
   * Advance exactly one frame by dtS seconds.
   * `outBuf` lets the caller supply a pooled buffer (the worker transfers it);
   * when omitted an internal buffer is reused.
   */
  step(dtS: number, outBuf?: Uint8Array): SimulationStepResult {
    const f = this.prepareFrame(dtS, outBuf);
    return this.finishFrame(f, this.pipeline.step(f.packet));
  }

  /**
   * Identical to `step`, except the learned perception stages may await an
   * inference runtime (plan2: ONNX Runtime Web in the browser worker). The
   * scene, the observed frame, the tracker, controller and mount are the same
   * code on the same data.
   */
  async stepAsync(dtS: number, outBuf?: Uint8Array): Promise<SimulationStepResult> {
    const f = this.prepareFrame(dtS, outBuf);
    return this.finishFrame(f, await this.pipeline.stepAsync(f.packet));
  }

  /** Render, crop and disturb one observed frame; build its packet. */
  private prepareFrame(dtS: number, outBuf?: Uint8Array): PreparedFrame {
    const cfg = this.config;
    const w = this.width;
    const h = this.height;

    this.simTimeS += dtS;
    this.frameIndex++;

    // ---- Ground truth update (beacon trajectory) ----
    const traj = this.trajectory.at(this.simTimeS);
    this.beacon.x_px = traj.x;
    this.beacon.y_px = traj.y;
    this.beacon.vx_px_s = traj.vx;
    this.beacon.vy_px_s = traj.vy;
    this.beacon.visible = true;

    // blink (temporary loss demonstration)
    let blinkOff = false;
    if (cfg.beacon.blinkPeriodS > 0) {
      const phase = this.simTimeS % cfg.beacon.blinkPeriodS;
      blinkOff = phase < cfg.beacon.blinkPeriodS * 0.12;
    }

    const killed = this.beaconKilled;

    // ---- Exposure smear (AI plan Phase 3) ----
    // Relative motion across the focal plane during one exposure. The sensor
    // window moves with the mount's ACHIEVED slew (what the hardware actually
    // did, not what was commanded) plus platform drift; the beacon adds its
    // own motion on top. Frame-to-frame jitter is a discrete offset, not a
    // within-exposure sweep, so it does not smear.
    const exposureS = (cfg.camera.exposureMs ?? 0) / 1000;
    let beaconSmear = { dx: 0, dy: 0 };
    let staticSmear = { dx: 0, dy: 0 };
    if (exposureS > 0) {
      const mt = this.lastMountTelemetry;
      const winVx = mt.actualPanRateDegS * this.camera.pxPerDegX + this.platVel.x;
      const winVy = mt.actualTiltRateDegS * this.camera.pxPerDegY + this.platVel.y;
      staticSmear = { dx: -winVx * exposureS, dy: -winVy * exposureS };
      beaconSmear = {
        dx: (this.beacon.vx_px_s - winVx) * exposureS,
        dy: (this.beacon.vy_px_s - winVy) * exposureS,
      };
    }

    // ---- Render clean scene ----
    renderScene({
      scene: this.sceneData.scene,
      background: this.sceneData.background,
      sceneWidth: cfg.scene.width,
      sceneHeight: cfg.scene.height,
      backgroundLevel: cfg.scene.backgroundLevel,
      beacon: this.beacon,
      beaconSizePx: cfg.beacon.sizePx,
      beaconShape: cfg.beacon.shape,
      killBeacon: killed,
      blinkOff,
      distractors: this.sceneData.distractors,
      blurSigmaPx: cfg.beacon.blurSigmaPx ?? 0,
      beaconSmear,
      staticSmear,
    });

    let beaconRestored = false;
    if (this.killFrames > 0) {
      this.killFrames--;
      if (this.killFrames === 0) beaconRestored = true;
    }

    // ---- Camera pose: platform motion + jitter ----
    const plat = this.platform.step(dtS);
    if (this.lastPlat !== null && dtS > 0) {
      this.platVel = { x: (plat.dx - this.lastPlat.dx) / dtS, y: (plat.dy - this.lastPlat.dy) / dtS };
    }
    this.lastPlat = plat;
    let jitterDx = 0;
    let jitterDy = 0;
    if (cfg.jitter.enabled && cfg.jitter.maxPxPerFrame > 0) {
      jitterDx = (this.jitterGauss() * cfg.jitter.maxPxPerFrame) / 2;
      jitterDy = (this.jitterGauss() * cfg.jitter.maxPxPerFrame) / 2;
      const mag = Math.hypot(jitterDx, jitterDy);
      // PS-OFFICIAL: jitter is bounded at ±maxPxPerFrame
      if (mag > cfg.jitter.maxPxPerFrame) {
        const s = cfg.jitter.maxPxPerFrame / mag;
        jitterDx *= s;
        jitterDy *= s;
      }
    }
    const jitterPx = Math.hypot(jitterDx, jitterDy);

    const cc = cameraCenterPx(this.camera);
    const centerX = cc.cx + plat.dx + jitterDx;
    const centerY = cc.cy + plat.dy + jitterDy;
    this.cropCenter = { x: centerX, y: centerY };

    // ---- Crop sensor window ----
    const frameBuf = outBuf ?? this.ownFrameBuf;
    cropFrame(this.sceneData.scene, cfg.scene.width, cfg.scene.height, frameBuf, w, h, centerX, centerY);

    // ---- Disturbance chain (does NOT touch ground truth) ----
    applyDisturbances(
      frameBuf,
      w,
      h,
      {
        saltPepperPercent: cfg.noise.saltPepperPercent,
        gaussianSigma: cfg.noise.gaussianSigma,
        poissonEnabled: cfg.noise.poissonEnabled,
        contrastFactor: this.atm.contrastFactor,
        brightnessFactor: this.atm.brightnessFactor,
        rainStrength: this.atm.rainStrength,
      },
      this.rngMain,
      this.gaussMain,
    );

    // ---- Frame packet: ground truth is IMAGE-space for the metrics branch ----
    const gtImageX = this.beacon.x_px - (centerX - w / 2);
    const gtImageY = this.beacon.y_px - (centerY - h / 2);
    const hidden = killed || blinkOff;
    const packet: FramePacket = {
      frame: frameBuf,
      width: w,
      height: h,
      timestamp_s: this.simTimeS,
      frame_index: this.frameIndex,
      ground_truth: hidden
        ? { ...this.beacon, x_px: gtImageX, y_px: gtImageY, visible: false }
        : { ...this.beacon, x_px: gtImageX, y_px: gtImageY },
      pan_deg: this.camera.pan_deg,
      tilt_deg: this.camera.tilt_deg,
    };
    return { packet, frameBuf, centerX, centerY, jitterPx, blinkOff, beaconRestored, hidden };
  }

  /** Everything after the pipeline: link model, mission observers, result. */
  private finishFrame(f: PreparedFrame, result: PipelineStepResult): SimulationStepResult {
    const cfg = this.config;
    const w = this.width;
    const h = this.height;
    const { frameBuf, centerX, centerY, jitterPx, blinkOff, beaconRestored, hidden } = f;

    // ── SIMULATED link quality from the achieved pointing error (§20) ──
    const tracking = result.track.state === 'TRACK' || result.track.state === 'PREDICT_REACQUIRE';
    const locked = result.errorPx !== null && result.errorPx <= cfg.tracking.lockRadiusPx;
    const link = computeLink({
      beaconDetected: result.detection.found,
      pointingErrorPx: result.errorPx,
      imageWidthPx: w,
      fovXDeg: cfg.camera.fovXDeg,
      atmosphere: cfg.atmosphere.mode,
      tracking,
      locked,
    });

    // ── mission phases + evidence, observed from real state (§21, §23) ──
    const ref = this.trajectory.at(this.simTimeS);
    this.missionTracker.observe({
      frameIndex: this.frameIndex,
      timestampS: this.simTimeS,
      state: result.track.state,
      detectionFound: result.detection.found,
      isPrediction: result.track.is_prediction,
      errorPx: result.errorPx,
      lockRadiusPx: cfg.tracking.lockRadiusPx,
      mount: this.lastMountTelemetry,
      beaconX: this.beacon.x_px,
      beaconY: this.beacon.y_px,
      referenceX: ref.x,
      referenceY: ref.y,
      disturbanceActive:
        cfg.noise.saltPepperPercent > 0 ||
        cfg.noise.gaussianSigma > 0 ||
        cfg.noise.poissonEnabled ||
        cfg.jitter.enabled ||
        cfg.atmosphere.mode !== 'clear' ||
        cfg.platformMotion.mode !== 'none',
      beaconSuppressed: hidden,
    });

    return {
      frameIndex: this.frameIndex,
      timestampS: this.simTimeS,
      frame: frameBuf,
      width: w,
      height: h,
      beacon: this.beacon,
      cropCenter: { x: centerX, y: centerY },
      jitterPx,
      mount: this.lastMountTelemetry,
      link,
      mission: this.missionTracker.snapshot(),
      blinkOff,
      beaconRestored,
      pipeline: result,
    };
  }

  /** Run `seconds` of simulation at the configured fixed rate (headless). */
  runFor(seconds: number, onStep?: (r: SimulationStepResult) => void): void {
    const dt = 1 / this.config.camera.updateHz;
    const frames = Math.round(seconds * this.config.camera.updateHz);
    for (let i = 0; i < frames; i++) {
      const r = this.step(dt);
      onStep?.(r);
    }
  }

  finalize(label: string): RunResult {
    return this.metrics.finalize(label);
  }
}
