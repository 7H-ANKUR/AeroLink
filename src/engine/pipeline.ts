/**
 * Processing pipeline orchestrator (docs/04 §5 data flow, docs/MVP §15).
 *
 *   frame → disturbances(already applied by source in sim) → detect → track
 *     → error calc → control command → camera pose update → metrics
 *
 * The pipeline is source-agnostic: the caller (simulation worker or video
 * benchmark runner) provides FramePackets; ground truth branches directly to
 * the metrics engine and NEVER reaches detector/tracker/controller.
 */
import { nowMs } from './detector';
import { createDetector, type BeaconDetector } from './detectors';
import type { LoadedModel } from './detector-ai';
import { PIDAngleController, ScanPattern } from './pid';
import { Tracker } from './tracker';
import { MetricsEngine } from './metrics';
import type { ScenarioConfig } from './config';
import type {
  Detection,
  FramePacket,
  GroundTruthSource,
  PanTiltCommand,
  SourceMetadata,
  TrackState,
} from './types';

export interface PipelineStepResult {
  detection: Detection;
  track: TrackState;
  command: PanTiltCommand;
  cameraPan: number;
  cameraTilt: number;
  processingMs: number;
  errorPx: number | null;
  beaconImageX: number | null;
  beaconImageY: number | null;
  /** Scene-px position where the camera viewport is looking. */
  viewportCenterSceneX: number;
  viewportCenterSceneY: number;
  /** px/frame jitter offset applied (telemetry). */
  jitterPx: number;
  /** Pre-correction Kalman prediction for this frame, image px (null until initialised). */
  predictedX: number | null;
  predictedY: number | null;
}

export interface PipelineHost {
  /** Applies the commanded rates to the camera and returns the new pose. */
  applyCommand(cmd: PanTiltCommand, dtS: number): { pan_deg: number; tilt_deg: number };
  /** Current viewport center in scene px (after platform motion etc). */
  viewportCenter(): { x: number; y: number };
  /** Scene px per degree on each axis (sensor angular scale). */
  pixelsPerDeg(): { x: number; y: number };
  /** Converts a scene-px point into camera-image px (null if outside frame). */
  sceneToImage(x: number, y: number): { x: number; y: number } | null;
  onTransition(from: string, to: string, frameIndex: number): void;
  onAcquired(acquisitionTimeS: number, frameIndex: number): void;
  onLossConfirmed(lossTimeS: number, frameIndex: number): void;
  onReacquired(reacqS: number, frameIndex: number): void;
}

export class Pipeline {
  private config: ScenarioConfig;
  private detector: BeaconDetector;
  private tracker: Tracker;
  private controller: PIDAngleController;
  private scan: ScanPattern;
  private metrics: MetricsEngine;
  private host: PipelineHost;
  private metadata: SourceMetadata;
  private lastTimestampS: number | null = null;
  /** Last scene-space position the tracker was confidently on. Seeds the
   *  search sweep when a lock is lost (master prompt §11, §19). */
  private lastGoodSceneXY: { x: number; y: number } | null = null;
  private prevState: string = 'SEARCH';

  constructor(
    config: ScenarioConfig,
    metadata: SourceMetadata,
    host: PipelineHost,
    gtSource: GroundTruthSource,
    /** Trained weights for the learned detectors. Required when
     *  config.tracking.detector is 'ai' or 'fusion'; createDetector throws
     *  rather than substituting classical CV behind an AI label. */
    model: LoadedModel | null = null,
  ) {
    this.config = config;
    this.metadata = metadata;
    this.host = host;

    this.detector = createDetector(config.tracking.detector, {
      threshold: config.tracking.threshold,
      minAreaPx: config.tracking.minAreaPx,
      maxAreaPx: config.tracking.maxAreaPx,
      expectedBeaconSize: config.beacon.sizePx * config.beacon.sizePx,
      minConfidence: config.tracking.minDetectionConfidence,
    }, model);

    this.tracker = new Tracker(
      {
        acquisitionConfirmFrames: config.tracking.acquisitionConfirmFrames,
        candidateDisconfirmFrames: config.tracking.candidateDisconfirmFrames,
        lostTimeoutFrames: config.tracking.lostTimeoutFrames,
        kalmanQ: config.tracking.kalmanQ,
        kalmanR: config.tracking.kalmanR,
      },
      {
        onTransition: (from, to, fi) => host.onTransition(from, to, fi),
        onAcquired: (t, fi) => host.onAcquired(t, fi),
        onLossConfirmed: (t, fi) => host.onLossConfirmed(t, fi),
        onReacquired: (rt, fi) => {
          // reacquisition interval recorded by the metrics engine (docs/08 §1)
          this.metrics.registerReacquisition(rt);
          host.onReacquired(rt, fi);
        },
      },
    );

    this.controller = new PIDAngleController({
      kp: config.tracking.kp,
      ki: config.tracking.ki,
      kd: config.tracking.kd,
      deadbandDeg: config.tracking.deadbandDeg,
      maxPanSpeedDegS: config.camera.maxPanSpeedDegS,
      maxTiltSpeedDegS: config.camera.maxTiltSpeedDegS,
      searchPattern: config.tracking.searchPattern,
    });

    this.metrics = new MetricsEngine(metadata.mode, config, gtSource, {
      onAcquired: (t) => {
        void t;
      },
    });

    this.scan = new ScanPattern(config.tracking.searchPattern, config.scene.width, config.scene.height, {
      viewportWidthPx: config.camera.resolutionWidth,
      viewportHeightPx: config.camera.resolutionHeight,
      slewRateDegS: Math.min(config.camera.maxPanSpeedDegS, config.camera.maxTiltSpeedDegS),
      pxPerDeg: config.camera.resolutionWidth / config.camera.fovXDeg,
      rateFactor: config.tracking.searchRateFactor,
    });
  }

  getMetrics(): MetricsEngine {
    return this.metrics;
  }

  resetControllerIntegrator(): void {
    this.controller.resetIntegrator();
  }

  /** Process exactly one frame. */
  step(packet: FramePacket): PipelineStepResult {
    const t0 = this.beginStep(packet);
    const detection: Detection = this.config.tracking.detectorEnabled
      ? this.detector.detect(packet.frame, packet.width, packet.height, t0, this.tracker.predictionHint)
      : this.detectorOff(t0);
    return this.completeStep(packet, t0, detection);
  }

  /**
   * Same frame, same stages, but the learned stages may await an inference
   * runtime (plan2: ONNX Runtime Web in the browser worker). Everything before
   * and after detection is the identical code `step` runs.
   */
  async stepAsync(packet: FramePacket): Promise<PipelineStepResult> {
    const t0 = this.beginStep(packet);
    let detection: Detection;
    if (!this.config.tracking.detectorEnabled) {
      detection = this.detectorOff(t0);
    } else if (this.detector.detectAsync) {
      detection = await this.detector.detectAsync(
        packet.frame,
        packet.width,
        packet.height,
        t0,
        this.tracker.predictionHint,
      );
    } else {
      detection = this.detector.detect(packet.frame, packet.width, packet.height, t0, this.tracker.predictionHint);
    }
    return this.completeStep(packet, t0, detection);
  }

  /** DETECTOR OFF (§41): "no measurement", so prediction and search take over. */
  private detectorOff(t0: number): Detection {
    return {
      found: false,
      x: null,
      y: null,
      confidence: 0,
      bbox: null,
      method: 'cv',
      latency_ms: nowMs() - t0,
    };
  }

  private pendingDtS = 0;

  /** Frame timing + the detector's context. Returns the frame start time. */
  private beginStep(packet: FramePacket): number {
    const t0 = nowMs();

    // dt for this frame
    this.pendingDtS =
      this.lastTimestampS !== null ? Math.max(1e-3, packet.timestamp_s - this.lastTimestampS) : 1 / this.metadata.fps;
    this.lastTimestampS = packet.timestamp_s;

    // Hand the hybrid detector the tracker's own state (AI plan Phase 7).
    // This is the system's own estimate from its own past measurements, not
    // ground truth; the classical detector ignores it entirely.
    // The pose is the mount's own encoder reading at exposure (the packet's
    // pan/tilt), so the hybrid detector can measure candidate motion in the
    // world with the receiver's own slew removed (AI plan Phase 7).
    // Recorded video cannot be re-pointed: the pixels never moved with the
    // virtual mount, so its pose is held fixed there.
    const ppd = this.host.pixelsPerDeg();
    const live = this.metadata.mode === 'simulation';
    this.detector.setContext?.({
      state: this.tracker.currentState,
      prediction: this.tracker.predictionHint,
      trackAgeFrames: this.tracker.trackAgeFrames,
      lostFramesConsecutive: this.tracker.lostFrames,
      pose: {
        panDeg: live ? packet.pan_deg : 0,
        tiltDeg: live ? packet.tilt_deg : 0,
        pxPerDegX: ppd.x,
        pxPerDegY: ppd.y,
      },
      timestampS: packet.timestamp_s,
    });
    return t0;
  }

  /**
   * Everything after detection: tracker, LOS, controller, mount, metrics.
   * 1. Detection happened in the caller — from packet.frame/width/height
   *    only; ground truth is NOT passed to it and flows only to metrics.
   */
  private completeStep(packet: FramePacket, t0: number, detection: Detection): PipelineStepResult {
    const dtS = this.pendingDtS;
    const detectorLatency = detection.latency_ms;

    // 2. Track / predict (called exactly once per frame even on miss)
    const track = this.tracker.update(detection, packet.timestamp_s, packet.frame_index, dtS);
    // pre-correction prediction, logged per frame (docs/05 §3)
    const prediction = this.tracker.lastPrediction;

    // Search seeding: remember where the beacon actually was while tracking,
    // and when the lock collapses to SEARCH, expand the sweep from THERE.
    const viewCentre = this.host.viewportCenter();
    if (track.state === 'TRACK' && detection.found && track.x !== null && track.y !== null) {
      this.lastGoodSceneXY = {
        x: viewCentre.x + (track.x - packet.width / 2),
        y: viewCentre.y + (track.y - packet.height / 2),
      };
    }
    // SEARCH sweep (§5, §11). The sweep is scene-covering and rate-bounded, so
    // it is left to run rather than being steered at a remembered position.
    // Two alternatives were implemented and MEASURED to be worse and are not
    // used: a one-shot seed at the last known position (blink target loss
    // 18.1 % -> 75.3 %, because the sweep slews off a beacon about to reappear
    // in place) and a coasted estimate followed frame by frame (7 s blackout
    // recovery 24 s -> 39.6 s, because the sweep tracks a drifting guess
    // instead of covering the scene).
    if (track.state === 'SEARCH' && this.prevState !== 'SEARCH') {
      // Begin the sweep where the receiver is already pointing, then cover
      // outward — never by slewing to a corner first.
      this.scan.setOrigin(viewCentre.x, viewCentre.y);
    }
    this.prevState = track.state;

    // 3. Control: pixel error → angular error inside compute() (docs/06 §4)
    const center = this.host.viewportCenter();
    const imgCenter: [number, number] = [packet.width / 2, packet.height / 2];
    let targetImage: [number, number] | null = null;
    if (track.state === 'TRACK' || track.state === 'PREDICT_REACQUIRE') {
      if (track.x !== null && track.y !== null) {
        // track coordinates are already image-space (detector frame space)
        targetImage = [track.x, track.y];
      }
    }

    const useTarget: [number, number] | null =
      targetImage ??
      (track.state === 'CANDIDATE' || track.state === 'ACQUIRE'
        ? track.x !== null && track.y !== null
          ? [track.x, track.y]
          : null
        : null);

    let command: PanTiltCommand;
    // CONTROLLER OFF (§40): the mount receives a zero command, so the camera
    // stops converging. Everything upstream keeps running unchanged.
    if (!this.config.tracking.controllerEnabled) {
      command = { pan_deg_s: 0, tilt_deg_s: 0 };
    } else if (useTarget !== null) {
      command = this.controller.compute(
        useTarget,
        imgCenter,
        [this.config.camera.fovXDeg, this.config.camera.fovYDeg],
        [packet.width, packet.height],
        dtS,
      );
    } else {
      // SEARCH / expired prediction: PID-drive the boresight onto a moving
      // scan point (Lissajous coverage, speed bounded by pan/tilt limits).
      const scanScene = this.scan.step(dtS, track.state === 'PREDICT_REACQUIRE' ? 0.4 : 1);
      const scanImage = this.host.sceneToImage(scanScene.x, scanScene.y);
      // sceneToImage returns null when outside the CURRENT frame — but the
      // scan point must remain commandable even off-frame, so convert manually:
      // scene px → deg (sensor angular scale) → camera-image px (FOV scale).
      const center = this.host.viewportCenter();
      const ppd = this.host.pixelsPerDeg();
      const offX = ((scanScene.x - center.x) / ppd.x) * (packet.width / this.config.camera.fovXDeg);
      const offY = ((scanScene.y - center.y) / ppd.y) * (packet.height / this.config.camera.fovYDeg);
      const target: [number, number] =
        scanImage !== null ? [scanImage.x, scanImage.y] : [packet.width / 2 + offX, packet.height / 2 + offY];
      command = this.controller.compute(
        target,
        imgCenter,
        [this.config.camera.fovXDeg, this.config.camera.fovYDeg],
        [packet.width, packet.height],
        dtS,
      );
    }

    // 4. Camera pose update (host applies saturation + clamping)
    const pose = this.host.applyCommand(command, dtS);

    // 5. Metrics — ground truth branches directly here (never via detector)
    const gt = packet.ground_truth;
    const gtTuple: [number, number] | null = gt ? [gt.x_px, gt.y_px] : null;
    const errorPx =
      gtTuple && track.x !== null && track.y !== null
        ? Math.hypot(track.x - gtTuple[0], track.y - gtTuple[1])
        : null;

    const processingMs = nowMs() - t0;
    this.metrics.onFrame(
      packet.frame_index,
      packet.timestamp_s,
      gtTuple,
      track,
      command,
      processingMs,
      detection.found,
      detection.confidence,
      detectorLatency,
      pose,
      detection.found ? [detection.x, detection.y] : [null, null],
      prediction ? [prediction.x, prediction.y] : [null, null],
    );

    // Beacon position in image space (telemetry/HUD only — never reaches the
    // detector). packet.ground_truth is ALREADY image-space (the frame source
    // converts it), so it must not be run through sceneToImage again: that
    // double-subtracted the crop offset and pushed the marker off-frame, which
    // silently disabled the ground-truth overlay. May legitimately fall
    // outside the frame while the beacon is out of view.
    const beaconImage = gt ? { x: gt.x_px, y: gt.y_px } : null;

    return {
      detection,
      track,
      command,
      cameraPan: pose.pan_deg,
      cameraTilt: pose.tilt_deg,
      processingMs,
      errorPx,
      beaconImageX: beaconImage ? beaconImage.x : null,
      beaconImageY: beaconImage ? beaconImage.y : null,
      viewportCenterSceneX: center.x,
      viewportCenterSceneY: center.y,
      jitterPx: 0,
      predictedX: prediction ? prediction.x : null,
      predictedY: prediction ? prediction.y : null,
    };
  }
}
