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
import { ClassicalDetector, nowMs } from './detector';
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
  private detector: ClassicalDetector;
  private tracker: Tracker;
  private controller: PIDAngleController;
  private scan: ScanPattern;
  private metrics: MetricsEngine;
  private host: PipelineHost;
  private metadata: SourceMetadata;
  private lastTimestampS: number | null = null;

  constructor(
    config: ScenarioConfig,
    metadata: SourceMetadata,
    host: PipelineHost,
    gtSource: GroundTruthSource,
  ) {
    this.config = config;
    this.metadata = metadata;
    this.host = host;

    this.detector = new ClassicalDetector({
      threshold: config.tracking.threshold,
      minAreaPx: config.tracking.minAreaPx,
      maxAreaPx: config.tracking.maxAreaPx,
      expectedBeaconSize: config.beacon.sizePx * config.beacon.sizePx,
    });

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

    this.scan = new ScanPattern(config.tracking.searchPattern, config.scene.width, config.scene.height);
  }

  getMetrics(): MetricsEngine {
    return this.metrics;
  }

  resetControllerIntegrator(): void {
    this.controller.resetIntegrator();
  }

  /** Process exactly one frame. */
  step(packet: FramePacket): PipelineStepResult {
    const t0 = nowMs();

    // dt for this frame
    const dtS =
      this.lastTimestampS !== null ? Math.max(1e-3, packet.timestamp_s - this.lastTimestampS) : 1 / this.metadata.fps;
    this.lastTimestampS = packet.timestamp_s;

    // 1. Detection (ground truth is NOT passed here — it flows only to metrics)
    const detection = this.detector.detect(
      packet.frame,
      packet.width,
      packet.height,
      t0,
      this.tracker.predictionHint,
    );
    const detectorLatency = detection.latency_ms;

    // 2. Track / predict (called exactly once per frame even on miss)
    const track = this.tracker.update(detection, packet.timestamp_s, packet.frame_index, dtS);

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
    if (useTarget !== null) {
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
    );

    // beacon position in image space (telemetry only — computed from GT for HUD)
    const beaconImage = gt ? this.host.sceneToImage(gt.x_px, gt.y_px) : null;

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
    };
  }
}
