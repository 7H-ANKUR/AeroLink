/**
 * Metrics engine + scoring (docs/08-scoring-engine-spec.md — single source
 * of truth for every formula). Streaming accumulators per docs/MVP-Tech-Doc §17.
 *
 * Formulas implemented EXACTLY as specified:
 *  - acquisition_time_s   = t(first TRACK) - t(run start)
 *  - error_px             = sqrt((x_est-x_gt)^2 + (y_est-y_gt)^2)   [GT exists only]
 *  - RMSE                 = sqrt(mean(error_px^2))
 *  - loss_percent         = lost_frames / total_frames * 100  (SEARCH or expired PREDICT)
 *  - lock_retention       = locked_frames / eligible_frames * 100
 *  - reacquisition_time_s = t(confirmed reacq) - t(confirmed loss)
 *  - algorithm_fps        = processed_frames / algorithm_elapsed  (>=20 FPS target)
 */
import { shortHash } from './rng';
import type {
  FrameEventRow,
  GroundTruthSource,
  MetricsSnapshot,
  PanTiltCommand,
  PassFail,
  RunResult,
  ScenarioConfig,
  SourceMode,
  TrackState,
} from './types';

export const SOFTWARE_VERSION = '1.0.0';

export const PS_TARGETS = {
  acquisition_s: 2.0, // <= 2 s
  tracking_error_px: 10, // <= 10 px (avg)
  target_loss_percent: 5, // < 5%
  reacquisition_s: 1.0, // <= 1 s (avg)
  processing_fps: 20, // >= 20 FPS (algorithm_fps)
} as const;

export interface MetricsEngineEvents {
  onAcquired?(acquisitionTimeS: number): void;
}

export class MetricsEngine {
  private mode: SourceMode;
  private config: ScenarioConfig;
  private gtSource: GroundTruthSource;
  private startedAtMs: number;
  private algorithmElapsedMs = 0;

  private framesProcessed = 0;
  private framesDropped = 0;
  private errorSum = 0;
  private errorSqSum = 0;
  private maxError = 0;
  private errors: number[] = [];
  // Centroiding error = |detector centroid - ground truth| (docs/08; the PS
  // Benchmark stages grade "Centroiding error" specifically). This is the RAW
  // DETECTOR output, deliberately NOT the Kalman-filtered track estimate that
  // avg_error_px measures.
  private centroidErrorSum = 0;
  private centroidErrorSqSum = 0;
  private centroidErrorMax = 0;
  private centroidErrorCount = 0;
  /** Detections returned while the beacon was NOT inside the sensor frame —
   *  i.e. the detector locked onto something that is not the target. These are
   *  false positives, counted separately instead of being averaged into the
   *  centroiding error (a 700 px "centroid error" in a 640x480 frame is not an
   *  accuracy measurement, it is a mis-detection). */
  private falsePositiveFrames = 0;
  /** Error accumulated ONLY over frames where the system was actually tracking
   *  (TRACK / PREDICT_REACQUIRE). The PS grades Acquisition Time separately, so
   *  this isolates steady-state pointing accuracy from the search/slew phase.
   *  Reported alongside — NOT instead of — the all-frames avg_error_px, which
   *  remains what pass_fail gates on. */
  private trackPhaseErrorSum = 0;
  private trackPhaseErrorSqSum = 0;
  private trackPhaseErrorCount = 0;
  private gtFrames = 0;
  private detectedFrames = 0;
  private confidenceSum = 0;
  private lostFrames = 0;
  private lockedFrames = 0;
  private eligibleFrames = 0;
  private acquisitionTimeS: number | null = null;
  private reacqTimes: number[] = [];
  private processingSum = 0;
  private detectorLatencySum = 0;
  private trackStreak = 0;
  private longestStreak = 0;
  private events: MetricsEngineEvents;
  private rows: FrameEventRow[] = [];
  private onAcquiredLogged = false;

  constructor(
    mode: SourceMode,
    config: ScenarioConfig,
    gtSource: GroundTruthSource,
    events: MetricsEngineEvents = {},
  ) {
    this.mode = mode;
    this.config = config;
    this.gtSource = gtSource;
    this.events = events;
    this.startedAtMs = nowMs();
  }

  get eventRows(): readonly FrameEventRow[] {
    return this.rows;
  }

  onFrame(
    frameIndex: number,
    timestampS: number,
    ground_truth: [number, number] | null,
    trackState: TrackState,
    command: PanTiltCommand,
    processingMs: number,
    detectionFound: boolean,
    detectionConfidence: number,
    detectorLatencyMs: number,
    cameraPose: { pan_deg: number; tilt_deg: number },
    detectedXY: [number | null, number | null],
    predictedXY: [number | null, number | null] = [null, null],
  ): void {
    this.framesProcessed++;
    this.algorithmElapsedMs += processingMs;
    this.processingSum += processingMs;
    this.detectorLatencySum += detectorLatencyMs;

    if (detectionFound) {
      this.detectedFrames++;
      this.confidenceSum += detectionConfidence;
    }

    // loss definition (docs/08 §1): SEARCH, or PREDICT beyond timeout — the
    // tracker already transitions expired PREDICT to SEARCH, so SEARCH here
    // is the authoritative "lost" signal.
    const lost = trackState.state === 'SEARCH';
    if (lost) this.lostFrames++;

    // lock definition: within lock radius while TRACK (policy: prediction counts?)
    let locked = false;
    if (ground_truth && trackState.x !== null && trackState.y !== null) {
      const d = Math.hypot(trackState.x - ground_truth[0], trackState.y - ground_truth[1]);
      locked = d <= this.config.tracking.lockRadiusPx;
      if (locked && !trackState.is_prediction) {
        // definitely counts
      } else if (locked && trackState.is_prediction && !this.config.tracking.countPredictionAsLocked) {
        locked = false;
      }
    }
    const eligible = trackState.state === 'TRACK' || trackState.state === 'PREDICT_REACQUIRE';
    if (eligible) {
      this.eligibleFrames++;
      if (locked) this.lockedFrames++;
    }

    // Centroiding error: raw detector centroid vs ground truth. Only meaningful
    // when the beacon is actually inside the sensor frame — ground_truth is
    // image-space and may legitimately fall outside it during search/slew.
    if (ground_truth && detectionFound && detectedXY[0] !== null && detectedXY[1] !== null) {
      const w = this.config.camera.resolutionWidth;
      const h = this.config.camera.resolutionHeight;
      const beaconInFrame =
        ground_truth[0] >= 0 && ground_truth[0] < w && ground_truth[1] >= 0 && ground_truth[1] < h;
      if (beaconInFrame) {
        const ce = Math.hypot(detectedXY[0] - ground_truth[0], detectedXY[1] - ground_truth[1]);
        this.centroidErrorSum += ce;
        this.centroidErrorSqSum += ce * ce;
        if (ce > this.centroidErrorMax) this.centroidErrorMax = ce;
        this.centroidErrorCount++;
      } else {
        this.falsePositiveFrames++;
      }
    }

    // error vs ground truth (only where GT exists)
    let errorPx: number | null = null;
    if (ground_truth && trackState.x !== null && trackState.y !== null) {
      errorPx = Math.hypot(trackState.x - ground_truth[0], trackState.y - ground_truth[1]);
      this.errorSum += errorPx;
      this.errorSqSum += errorPx * errorPx;
      if (errorPx > this.maxError) this.maxError = errorPx;
      this.errors.push(errorPx);
      this.gtFrames++;
      if (eligible) {
        this.trackPhaseErrorSum += errorPx;
        this.trackPhaseErrorSqSum += errorPx * errorPx;
        this.trackPhaseErrorCount++;
      }
    }

    // track continuity streak (reference-free metric, docs/08 §4)
    if (trackState.state === 'TRACK') {
      this.trackStreak++;
      if (this.trackStreak > this.longestStreak) this.longestStreak = this.trackStreak;
    } else {
      this.trackStreak = 0;
    }

    if (trackState.state === 'TRACK' && this.acquisitionTimeS === null && !this.onAcquiredLogged) {
      this.acquisitionTimeS = timestampS;
      this.onAcquiredLogged = true;
      this.events.onAcquired?.(timestampS);
    }

    this.rows.push({
      timestamp: round3(timestampS),
      frame_index: frameIndex,
      source_mode: this.mode,
      gt_x: ground_truth ? round3(ground_truth[0]) : null,
      gt_y: ground_truth ? round3(ground_truth[1]) : null,
      detected_x: detectedXY[0] !== null ? round3(detectedXY[0]) : null,
      detected_y: detectedXY[1] !== null ? round3(detectedXY[1]) : null,
      predicted_x: predictedXY[0] !== null ? round3(predictedXY[0]) : null,
      predicted_y: predictedXY[1] !== null ? round3(predictedXY[1]) : null,
      confidence: round3(detectionConfidence),
      tracking_state: trackState.state,
      pan_deg: round3(cameraPose.pan_deg),
      tilt_deg: round3(cameraPose.tilt_deg),
      pan_command: round3(command.pan_deg_s),
      tilt_command: round3(command.tilt_deg_s),
      error_px: errorPx !== null ? round3(errorPx) : null,
      processing_ms: round2(processingMs),
      locked,
      lost,
    });
  }

  /** Streaming snapshot for the live dashboard. */
  snapshot(wallElapsedS: number): MetricsSnapshot {
    const n = this.errors.length;
    const avgError = n > 0 ? this.errorSum / n : null;
    const rmse = n > 0 ? Math.sqrt(this.errorSqSum / n) : null;
    const fpsAlg = this.algorithmElapsedMs > 0 ? (this.framesProcessed / this.algorithmElapsedMs) * 1000 : 0;
    const lossPct = this.framesProcessed > 0 ? (this.lostFrames / this.framesProcessed) * 100 : null;
    const lockPct = this.eligibleFrames > 0 ? (this.lockedFrames / this.eligibleFrames) * 100 : null;
    const reacqAvg = this.reacqTimes.length > 0 ? this.reacqTimes.reduce((a, b) => a + b, 0) / this.reacqTimes.length : null;
    return {
      elapsedS: wallElapsedS,
      fpsAlgorithm: fpsAlg,
      fpsWallClock: wallElapsedS > 0 ? this.framesProcessed / wallElapsedS : 0,
      avgErrorPx: avgError,
      maxErrorPx: n > 0 ? this.maxError : null,
      rmsePx: rmse,
      lossPercent: lossPct,
      lockRetentionPercent: lockPct,
      acquisitionTimeS: this.acquisitionTimeS,
      reacquisitionAvgS: reacqAvg,
      reacquisitionEvents: this.reacqTimes.length,
      processingAvgMs: this.framesProcessed > 0 ? this.processingSum / this.framesProcessed : 0,
      detectionRatePercent: this.framesProcessed > 0 ? (this.detectedFrames / this.framesProcessed) * 100 : null,
      avgConfidence: this.detectedFrames > 0 ? this.confidenceSum / this.detectedFrames : null,
      framesProcessed: this.framesProcessed,
    };
  }

  registerReacquisition(tS: number): void {
    this.reacqTimes.push(tS);
  }

  registerDropped(): void {
    this.framesDropped++;
  }

  getAlgorithmElapsedS(): number {
    return this.algorithmElapsedMs / 1000;
  }

  /** docs/06 §6 finalize() → RunResult with pass/fail computed here (docs/08 §2). */
  finalize(runIdBase: string): RunResult {
    const wallElapsedS = (nowMs() - this.startedAtMs) / 1000;
    const snap = this.snapshot(wallElapsedS);
    const n = this.errors.length;

    // error percentiles
    let p95: number | null = null;
    let p99: number | null = null;
    if (n > 3) {
      const sorted = [...this.errors].sort((a, b) => a - b);
      p95 = sorted[Math.min(n - 1, Math.floor(0.95 * n))];
      p99 = sorted[Math.min(n - 1, Math.floor(0.99 * n))];
    }

    // pass/fail vs official PS targets — computed by scoring rules here,
    // never recomputed by the UI (docs/08 §2).
    const hasGtMetrics = n > 0;
    const pass_fail: PassFail | null =
      this.gtSource === 'none' && !hasGtMetrics
        ? null // reference-free mode: PS error gates not computable (docs/08 §4)
        : {
            acquisition: snap.acquisitionTimeS !== null && snap.acquisitionTimeS <= PS_TARGETS.acquisition_s,
            tracking_error: hasGtMetrics ? (snap.avgErrorPx ?? 99) <= PS_TARGETS.tracking_error_px : false,
            target_loss: (snap.lossPercent ?? 100) < PS_TARGETS.target_loss_percent,
            reacquisition:
              this.reacqTimes.length === 0 ||
              (snap.reacquisitionAvgS !== null && snap.reacquisitionAvgS <= PS_TARGETS.reacquisition_s),
            processing_speed: snap.fpsAlgorithm >= PS_TARGETS.processing_fps,
          };

    const runId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z')}-${shortHash(runIdBase + String(this.framesProcessed))}`;

    return {
      run_id: runId,
      mode: this.mode,
      scenario_name: this.config.scenarioName,
      duration_s: round2(wallElapsedS),
      fps_measured: round2(snap.fpsAlgorithm),
      wall_clock_fps: round2(snap.fpsWallClock),
      acquisition_time_s: snap.acquisitionTimeS !== null ? round3(snap.acquisitionTimeS) : null,
      avg_error_px: snap.avgErrorPx !== null ? round3(snap.avgErrorPx) : null,
      max_error_px: snap.maxErrorPx !== null ? round3(snap.maxErrorPx) : null,
      rmse_px: snap.rmsePx !== null ? round3(snap.rmsePx) : null,
      p95_error_px: p95 !== null ? round3(p95) : null,
      p99_error_px: p99 !== null ? round3(p99) : null,
      centroid_error_avg_px: this.centroidErrorCount > 0 ? round3(this.centroidErrorSum / this.centroidErrorCount) : null,
      centroid_error_max_px: this.centroidErrorCount > 0 ? round3(this.centroidErrorMax) : null,
      centroid_error_rmse_px:
        this.centroidErrorCount > 0 ? round3(Math.sqrt(this.centroidErrorSqSum / this.centroidErrorCount)) : null,
      centroid_error_samples: this.centroidErrorCount,
      false_positive_frames: this.falsePositiveFrames,
      tracking_phase_error_avg_px:
        this.trackPhaseErrorCount > 0 ? round3(this.trackPhaseErrorSum / this.trackPhaseErrorCount) : null,
      tracking_phase_error_rmse_px:
        this.trackPhaseErrorCount > 0
          ? round3(Math.sqrt(this.trackPhaseErrorSqSum / this.trackPhaseErrorCount))
          : null,
      tracking_phase_frames: this.trackPhaseErrorCount,
      target_loss_percent: snap.lossPercent !== null ? round3(snap.lossPercent) : null,
      lock_retention_percent: snap.lockRetentionPercent !== null ? round2(snap.lockRetentionPercent) : null,
      lock_policy_counts_prediction: this.config.tracking.countPredictionAsLocked,
      reacquisition_avg_s: snap.reacquisitionAvgS !== null ? round3(snap.reacquisitionAvgS) : null,
      reacquisition_max_s: this.reacqTimes.length > 0 ? round3(Math.max(...this.reacqTimes)) : null,
      reacquisition_events: this.reacqTimes.length,
      processing_avg_ms: round2(snap.processingAvgMs),
      detector_latency_avg_ms: this.framesProcessed > 0 ? round2(this.detectorLatencySum / this.framesProcessed) : null,
      frames_processed: this.framesProcessed,
      frames_dropped: this.framesDropped,
      detection_rate_percent: snap.detectionRatePercent !== null ? round2(snap.detectionRatePercent) : null,
      track_continuity_frames: this.longestStreak,
      avg_detection_confidence: snap.avgConfidence !== null ? round3(snap.avgConfidence) : null,
      scenario_seed: this.config.seed,
      detector: this.config.tracking.detector,
      tracker: this.config.tracking.tracker,
      controller: this.config.tracking.controller,
      ground_truth_source: this.gtSource,
      pass_fail,
      software_version: SOFTWARE_VERSION,
      config: this.config,
      completed_at: new Date().toISOString(),
    };
  }
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
