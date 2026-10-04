/**
 * FSOC-PAT engine data contracts.
 * Mirrors docs/06-api-contracts.md field-for-field and the metrics.json
 * schema from docs/05-database-schema.md §4.
 *
 * These types are shared by the simulation engine (Web Worker), the
 * video-benchmark runner and the frontend UI. Units must never be renamed:
 * positions are pixels, angles are degrees, rates are deg/s.
 */

export type TrackingStateName =
  | 'SEARCH'
  | 'CANDIDATE'
  | 'ACQUIRE'
  | 'TRACK'
  | 'PREDICT_REACQUIRE';

export type DetectionMethod = 'cv' | 'ai' | 'fusion';

export type SourceMode = 'simulation' | 'video';

export type MotionMode =
  | 'straight'
  | 'circular'
  | 'figure8'
  | 'random'
  | 'spiral'
  | 'sinusoidal';

export type AtmosphereMode = 'clear' | 'haze' | 'fog' | 'rain' | 'low_light';

export type PlatformMotionMode = 'none' | 'linear' | 'circular' | 'random' | 'spiral' | 'figure8';

/**
 * `ai_fullframe` is the plan's Phase 12 Mode 1 (full-frame learned detection).
 * It is implemented and benchmarked, but it does not fit the 33 ms frame
 * budget, so the live UI does not offer it (see DETECTOR_REGISTRY.realtime).
 */
export type DetectorKind = 'cv_classical' | 'ai' | 'fusion' | 'ai_fullframe';
export type TrackerKind = 'kalman_cv';
export type ControllerKind = 'pid_angle_space';
export type SearchPattern = 'raster' | 'spiral';

/** Ground truth emitted by the simulator every frame (docs/04 §4.4).
 *  For the METRICS branch the packet carries the IMAGE-SPACE beacon center
 *  (docs/MVP-Tech-Doc §5 — known image-space beacon center computed before
 *  noise); the 3D/trajectory views use scene-space via telemetry. */
export interface GroundTruthTarget {
  id: number;
  /** Position in scene pixels. */
  x_px: number;
  y_px: number;
  vx_px_s: number;
  vy_px_s: number;
  visible: boolean;
  intensity: number;
}

/** docs/06 §1 FramePacket — frame payload is a Uint8 grayscale buffer. */
export interface FramePacket {
  frame: Uint8Array; // HxW grayscale
  width: number;
  height: number;
  timestamp_s: number;
  frame_index: number;
  ground_truth: GroundTruthTarget | null;
  /** Camera pose at exposure time (degrees). */
  pan_deg: number;
  tilt_deg: number;
}

export interface SourceMetadata {
  mode: SourceMode;
  fps: number;
  resolution: [number, number];
  has_ground_truth: boolean;
}

/** docs/06 §2 Detection. */
/**
 * Per-frame perception provenance (AI plan Phase 8).
 *
 * Records WHICH stage actually supplied the answer, so the claim "this was a
 * fusion decision" can be checked against the run record instead of taken on
 * trust. Present only for detectors that have more than one stage; the
 * classical detector leaves it null.
 */
export interface DetectionProvenance {
  /** Optical spots the classical stage proposed this frame. */
  candidateCount: number;
  /** The classical stage's own top pick. */
  cv: { x: number; y: number; confidence: number } | null;
  /** The learned model's top pick, or null when no model is loaded. */
  ai: { x: number; y: number; confidence: number } | null;
  /** Distance between the two stages' picks, px — null if either is absent. */
  spatialAgreementPx: number | null;
  /** Distance from the chosen candidate to the Kalman prediction, px. */
  predictionDistancePx: number | null;
  /** Which rule selected the final answer. */
  chosenBy: string;
  /** Candidates thrown out by the learned model's reject gate. */
  aiRejected: number;
  /** True when the two stages' top picks were different candidates. */
  disagreed: boolean;
  cvLatencyMs: number;
  aiLatencyMs: number;
  fusionLatencyMs: number;
  /** Spots the learned branch's own proposer found (Phase 5); null if not run. */
  aiBranchCount?: number | null;
  /** Which branch(es) proposed the chosen candidate. */
  chosenSource?: 'cv' | 'ai' | 'both' | null;
  /** Temporal evidence for the chosen candidate (Phase 7). */
  trackId?: number | null;
  trackAgeFrames?: number | null;
  /** Learned track verifier's P(beacon) for the chosen candidate's track. */
  trackP?: number | null;
  /** World speed of the chosen track after removing the receiver's slew, px/s. */
  trackSpeedPxS?: number | null;
  /** Candidates rejected by track-level gates this frame. */
  trackRejected?: number;
  /** Points currently in the clutter map. */
  clutterPoints?: number;
  /** Live candidate tracks in the bank. */
  liveTracks?: number;
  /** Time spent in the track bank + verifier, ms. */
  temporalLatencyMs?: number;
  /** Which inference runtime produced the AI scores (plan2): e.g.
   *  'onnxruntime-web 1.30.0 (wasm)' or the in-engine TypeScript pass. */
  aiRuntime?: string;
  /** Time inside the CNN runtime call(s) this frame, ms. */
  aiInferenceMs?: number;
  /** ROIs the CNN scored this frame. */
  aiScored?: number;
  /** Fused score of the chosen candidate (before the 1.15 display lift). */
  chosenFusionScore?: number | null;
  /** Human-readable reason for the final decision. */
  decisionReason?: string;
}

export interface Detection {
  found: boolean;
  x: number | null;
  y: number | null;
  confidence: number; // [0,1]
  bbox: [number, number, number, number] | null; // x, y, w, h
  method: DetectionMethod;
  latency_ms: number;
  /** Multi-stage provenance; null for single-stage detectors (Phase 8). */
  provenance?: DetectionProvenance | null;
  /**
   * The detector has deliberately moved to a DIFFERENT target than the one it
   * was reporting (false-lock recovery). The tracker must not blend the new
   * position into the old track's Kalman state; it re-confirms instead, and
   * the interval is recorded as a loss and a reacquisition. Only the hybrid
   * detector ever sets this.
   */
  newTarget?: boolean;
}

/** docs/06 §3 TrackState. */
export interface TrackState {
  state: TrackingStateName;
  x: number | null;
  y: number | null;
  vx: number | null;
  vy: number | null;
  confidence: number;
  track_age_frames: number;
  lost_frames_consecutive: number;
  is_prediction: boolean;
}

/** Virtual receiver mount state for one frame (master prompt §13, §15).
 *  Commanded and actual rates are deliberately separate values: the mount has
 *  finite angular acceleration, so they differ during every transient. */
export interface MountTelemetry {
  azimuthDeg: number;
  elevationDeg: number;
  commandedPanRateDegS: number;
  commandedTiltRateDegS: number;
  actualPanRateDegS: number;
  actualTiltRateDegS: number;
  /** Command exceeded the mount's maximum rate and was clipped. */
  rateSaturated: boolean;
  /** Actual rate could not reach the command this step (accel limited). */
  accelLimited: boolean;
  /** Pose hit the end of mechanical travel. */
  travelLimited: boolean;
  /** Fraction of maximum rate in use, 0..1 — actuator effort. */
  panEffort: number;
  tiltEffort: number;
}

/** docs/06 §4 PanTiltCommand. */
export interface PanTiltCommand {
  pan_deg_s: number;
  tilt_deg_s: number;
}

/** Pass/fail gates against official PS-169 targets (docs/08 §2). */
export interface PassFail {
  acquisition: boolean;
  tracking_error: boolean;
  target_loss: boolean;
  reacquisition: boolean;
  processing_speed: boolean;
}

export type GroundTruthSource = 'simulation' | 'manual_annotation' | 'none';

import type { ScenarioConfig } from './config';
import type { LinkTelemetry } from './link';
import type { MissionSnapshot } from './mission';
export type { ScenarioConfig };

/** docs/05 §4 metrics.json — RunResult. */
export interface RunResult {
  run_id: string;
  mode: SourceMode;
  scenario_name: string;
  duration_s: number;
  fps_measured: number; // algorithm_fps (pipeline-only) per docs/08 §1
  wall_clock_fps: number;
  acquisition_time_s: number | null;
  avg_error_px: number | null;
  max_error_px: number | null;
  rmse_px: number | null;
  p95_error_px: number | null;
  p99_error_px: number | null;
  /** Centroiding error = |detector centroid - ground truth|, averaged over
   *  frames with a detection. This is the RAW detector accuracy the PS
   *  Benchmark stages grade; avg_error_px is the filtered track error. */
  centroid_error_avg_px: number | null;
  centroid_error_max_px: number | null;
  centroid_error_rmse_px: number | null;
  centroid_error_samples: number;
  /** Frames where a detection was produced while the beacon was outside the
   *  sensor frame — mis-detections, reported rather than silently averaged. */
  false_positive_frames: number;
  /** Pointing error over tracking frames only (TRACK / PREDICT_REACQUIRE),
   *  excluding the search/slew phase that Acquisition Time already measures.
   *  Reported for transparency; pass_fail still gates on avg_error_px. */
  tracking_phase_error_avg_px: number | null;
  tracking_phase_error_rmse_px: number | null;
  tracking_phase_frames: number;
  target_loss_percent: number | null;
  lock_retention_percent: number | null;
  lock_policy_counts_prediction: boolean;
  reacquisition_avg_s: number | null;
  reacquisition_max_s: number | null;
  reacquisition_events: number;
  processing_avg_ms: number | null;
  detector_latency_avg_ms: number | null;
  frames_processed: number;
  frames_dropped: number;
  detection_rate_percent: number | null;
  track_continuity_frames: number | null;
  avg_detection_confidence: number | null;
  scenario_seed: number;
  detector: string;
  tracker: string;
  controller: string;
  ground_truth_source: GroundTruthSource;
  pass_fail: PassFail | null;
  software_version: string;
  config: ScenarioConfig;
  completed_at: string;
}

/** One per-frame record for events.csv (docs/05 §3). */
export interface FrameEventRow {
  timestamp: number;
  frame_index: number;
  source_mode: SourceMode;
  gt_x: number | null;
  gt_y: number | null;
  detected_x: number | null;
  detected_y: number | null;
  predicted_x: number | null;
  predicted_y: number | null;
  confidence: number;
  tracking_state: TrackingStateName;
  pan_deg: number;
  tilt_deg: number;
  pan_command: number;
  tilt_command: number;
  error_px: number | null;
  processing_ms: number;
  locked: boolean;
  lost: boolean;
}

/** Immutable snapshot emitted by the worker each frame for the UI. */
export interface TelemetrySnapshot {
  frameIndex: number;
  timestampS: number;
  detection: Detection;
  track: TrackState;
  command: PanTiltCommand;
  camera: { pan_deg: number; tilt_deg: number };
  /** Pre-correction Kalman prediction, image px (plan2 chain display). */
  predicted?: { x: number; y: number } | null;
  groundTruth: { x_px: number; y_px: number; vx_px_s: number; vy_px_s: number } | null;
  /** Beacon position in camera-image pixels (may be off-frame). */
  beaconImageX: number | null;
  beaconImageY: number | null;
  errorPx: number | null;
  locked: boolean;
  lost: boolean;
  processingMs: number;
  metrics: MetricsSnapshot;
  jitterPx: number;
  activeDisturbances: string[];
  /** Receiver mount state (master prompt §15). */
  mount: MountTelemetry;
  /** SIMULATED optical link quality — a model, never a measurement (§20). */
  link: LinkTelemetry;
  /** Mission phases reached and live evidence checks (§21, §23). */
  mission: MissionSnapshot;
}

export interface MetricsSnapshot {
  elapsedS: number;
  fpsAlgorithm: number;
  fpsWallClock: number;
  avgErrorPx: number | null;
  maxErrorPx: number | null;
  rmsePx: number | null;
  lossPercent: number | null;
  lockRetentionPercent: number | null;
  acquisitionTimeS: number | null;
  reacquisitionAvgS: number | null;
  reacquisitionEvents: number;
  processingAvgMs: number;
  detectionRatePercent: number | null;
  avgConfidence: number | null;
  framesProcessed: number;
}

/** Structured mission event types (master prompt §30). Each names a stage of
 *  the acquisition chain, so the log reads as the story of the run rather than
 *  as undifferentiated text. */
export type LogLevel =
  | 'SYSTEM'
  | 'SCENARIO'
  | 'SEARCH'
  | 'DETECT'
  | 'TRACK'
  | 'PREDICT'
  | 'CONTROL'
  | 'MOUNT'
  | 'ACQUIRE'
  | 'LOCK'
  | 'LOSS'
  | 'REACQUIRE'
  | 'DISTURBANCE'
  | 'METRIC'
  | 'STATE'
  | 'INFO'
  | 'WARN'
  | 'ERROR';

export interface LogEntry {
  id: number;
  t: string; // wall clock HH:MM:SS.mmm
  simT: number; // simulation seconds
  /** Engine frame this event belongs to (§30). */
  frame?: number;
  level: LogLevel;
  message: string;
  detail?: string;
}

export type EnginePhase = 'idle' | 'initializing' | 'running' | 'paused' | 'complete' | 'error';

export interface CameraPose {
  pan_deg: number;
  tilt_deg: number;
}
