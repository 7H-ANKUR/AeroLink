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

export type DetectorKind = 'cv_classical';
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
export interface Detection {
  found: boolean;
  x: number | null;
  y: number | null;
  confidence: number; // [0,1]
  bbox: [number, number, number, number] | null; // x, y, w, h
  method: DetectionMethod;
  latency_ms: number;
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
  centroid_error_avg_px: number | null;
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

export type LogLevel = 'INFO' | 'DETECT' | 'STATE' | 'METRIC' | 'DIST' | 'TRACK' | 'WARN' | 'ERROR';

export interface LogEntry {
  id: number;
  t: string; // wall clock HH:MM:SS.mmm
  simT: number; // simulation seconds
  level: LogLevel;
  message: string;
  detail?: string;
}

export type EnginePhase = 'idle' | 'initializing' | 'running' | 'paused' | 'complete' | 'error';

export interface CameraPose {
  pan_deg: number;
  tilt_deg: number;
}
