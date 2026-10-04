/**
 * VideoBenchmarkRunner — Mode B (docs/04 §10, docs/08 §4).
 * Feeds decoded MP4 frames through the SAME detector/tracker/metrics
 * pipeline. Controller emits commands for logging only — recorded footage is
 * never re-pointed (the UI must never imply it was).
 *
 * Ground-truth policy (docs/08 §4, three distinct paths):
 *  - 'none'              → reference-free metrics; error/RMSE = null
 *  - 'manual_annotation' → GT from sparse click-annotation JSON, linearly
 *                          interpolated; flagged in the report
 *  - evaluator GT file   → treated as full-metric path via same annotation
 *                          schema with annotation_type: "evaluator"
 */
import { ClassicalDetector } from '@/engine/detector';
import { Tracker } from '@/engine/tracker';
import { PIDAngleController } from '@/engine/pid';
import { MetricsEngine } from '@/engine/metrics';
import { eventsToCsv } from '@/engine/export';
import { DEFAULT_CONFIG } from '@/engine/config';
import type { Detection, RunResult, ScenarioConfig, TrackingStateName } from '@/engine/types';

export type VideoGtMode = 'none' | 'manual_annotation' | 'evaluator';

export interface AnnotationFile {
  source_video: string;
  annotation_type: 'manual_sparse' | 'evaluator';
  annotated_frames: { frame_index: number; x: number; y: number }[];
  interpolation: 'linear';
}

export interface VideoBenchmarkProgress {
  frameIndex: number;
  totalFrames: number;
  fpsAlgorithm: number;
  detection: Detection | null;
  state: TrackingStateName;
  isPrediction: boolean;
  x: number | null;
  y: number | null;
  elapsedS: number;
}

export interface VideoBenchmarkCallbacks {
  onFrame(img: ImageData | null, progress: VideoBenchmarkProgress): void;
  onLog(level: 'INFO' | 'WARN' | 'ERROR' | 'STATE' | 'METRIC', message: string, detail?: string): void;
  onDone(result: RunResult, eventsCsv: string): void;
  onError(message: string): void;
}

export class VideoBenchmarkRunner {
  private config: ScenarioConfig;
  private detector: ClassicalDetector;
  private tracker: Tracker;
  private controller: PIDAngleController;
  private metrics: MetricsEngine;
  private annotation: AnnotationFile | null = null;
  private gtMode: VideoGtMode = 'none';
  private running = false;
  private frameIndex = 0;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cb: VideoBenchmarkCallbacks;
  private lastVideoTime = 0;
  private readonly W = 640;
  private readonly H = 480;

  constructor(config: ScenarioConfig | null, cb: VideoBenchmarkCallbacks) {
    this.config = config ?? this.videoDefaults();
    this.detector = new ClassicalDetector({
      threshold: this.config.tracking.threshold,
      minAreaPx: this.config.tracking.minAreaPx,
      maxAreaPx: this.config.tracking.maxAreaPx,
      expectedBeaconSize: this.config.beacon.sizePx * this.config.beacon.sizePx,
      minConfidence: this.config.tracking.minDetectionConfidence,
    });
    this.tracker = new Tracker({
      acquisitionConfirmFrames: this.config.tracking.acquisitionConfirmFrames,
      candidateDisconfirmFrames: this.config.tracking.candidateDisconfirmFrames,
      lostTimeoutFrames: this.config.tracking.lostTimeoutFrames,
      kalmanQ: this.config.tracking.kalmanQ,
      kalmanR: this.config.tracking.kalmanR,
    });
    this.controller = new PIDAngleController({
      kp: this.config.tracking.kp,
      ki: this.config.tracking.ki,
      kd: this.config.tracking.kd,
      deadbandDeg: this.config.tracking.deadbandDeg,
      maxPanSpeedDegS: 5,
      maxTiltSpeedDegS: 5,
      searchPattern: 'raster',
    });
    this.metrics = new MetricsEngine('video', this.config, 'none');
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    this.cb = cb;
  }

  private videoDefaults(): ScenarioConfig {
    return {
      ...DEFAULT_CONFIG,
      scenarioName: 'Video Benchmark',
      camera: { ...DEFAULT_CONFIG.camera, updateHz: 30 },
    };
  }

  getGtMode(): VideoGtMode {
    return this.gtMode;
  }

  loadAnnotation(a: AnnotationFile, fileName: string): void {
    this.annotation = a;
    this.gtMode = a.annotation_type === 'evaluator' ? 'evaluator' : 'manual_annotation';
    // rebuild metrics with the correct GT source label (docs/08 §4)
    this.metrics = new MetricsEngine('video', this.config, a.annotation_type === 'evaluator' ? 'simulation' : 'manual_annotation');
    this.cb.onLog('INFO', `Ground truth loaded: ${fileName}`, `${a.annotated_frames.length} annotated frames (${a.annotation_type})`);
  }

  private gtForFrame(frameIndex: number): [number, number] | null {
    if (!this.annotation) return null;
    const frames = this.annotation.annotated_frames;
    if (frames.length === 0) return null;
    // exact match
    const exact = frames.find((f) => f.frame_index === frameIndex);
    if (exact) return [exact.x, exact.y];
    // linear interpolation between neighbors (docs/05 §6)
    let prev = frames[0];
    for (const f of frames) {
      if (f.frame_index > frameIndex) {
        const t = (frameIndex - prev.frame_index) / Math.max(1, f.frame_index - prev.frame_index);
        return [prev.x + (f.x - prev.x) * t, prev.y + (f.y - prev.y) * t];
      }
      prev = f;
    }
    return [prev.x, prev.y];
  }

  async run(video: HTMLVideoElement): Promise<void> {
    this.video = video;
    this.running = true;
    this.frameIndex = 0;
    this.lastVideoTime = 0;

    this.cb.onLog('INFO', 'Video benchmark started', `${video.videoWidth}×${video.videoHeight}, ${video.duration.toFixed(1)}s`);
    if (this.gtMode === 'none') {
      this.cb.onLog('WARN', 'No ground truth — reference-free metrics only', 'error/RMSE not computable');
    }

    const estimateFps = 30; // nominal per PS; used for dt when timestamps unavailable

    await new Promise<void>((resolve) => {
      const step = () => {
        if (!this.running || video.ended || video.paused) {
          resolve();
          return;
        }
        const t = video.currentTime;
        if (t === this.lastVideoTime) {
          // rAF (60 Hz) outpaces the 30 fps stream — skip duplicate frames so
          // frames_processed matches the video's actual frame count
          requestAnimationFrame(step);
          return;
        }
        const dt = this.lastVideoTime ? Math.max(1e-3, t - this.lastVideoTime) : 1 / estimateFps;
        this.lastVideoTime = t;

        // draw + grayscale
        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, this.W, this.H);
        const scale = Math.min(this.W / video.videoWidth, this.H / video.videoHeight);
        const dw = video.videoWidth * scale;
        const dh = video.videoHeight * scale;
        this.ctx.drawImage(video, (this.W - dw) / 2, (this.H - dh) / 2, dw, dh);
        const img = this.ctx.getImageData(0, 0, this.W, this.H);
        const gray = new Uint8Array(this.W * this.H);
        for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
          gray[i] = (img.data[p] * 0.299 + img.data[p + 1] * 0.587 + img.data[p + 2] * 0.114) | 0;
        }

        // detect
        const t0 = performance.now();
        const detection = this.detector.detect(gray, this.W, this.H, t0, this.tracker.predictionHint);
        // track
        const track = this.tracker.update(detection, t, this.frameIndex, dt);
        // control (logging only — no physical re-pointing of recorded footage)
        const cmd =
          track.x !== null && track.y !== null
            ? this.controller.compute([track.x, track.y], [this.W / 2, this.H / 2], [4, 3], [this.W, this.H], dt)
            : this.controller.compute(null, [this.W / 2, this.H / 2], [4, 3], [this.W, this.H], dt);
        // metrics with GT if available
        const gt = this.gtForFrame(this.frameIndex);
        this.metrics.onFrame(
          this.frameIndex,
          t,
          gt,
          track,
          cmd,
          performance.now() - t0,
          detection.found,
          detection.confidence,
          detection.latency_ms,
          { pan_deg: 0, tilt_deg: 0 },
          detection.found ? [detection.x, detection.y] : [null, null],
        );

        this.cb.onFrame(img, {
          frameIndex: this.frameIndex,
          totalFrames: Math.ceil(video.duration * estimateFps),
          fpsAlgorithm: this.metrics.snapshot(t).fpsAlgorithm,
          detection,
          state: track.state,
          isPrediction: track.is_prediction,
          x: track.x,
          y: track.y,
          elapsedS: t,
        });

        this.frameIndex++;
        requestAnimationFrame(step);
      };
      video.play().then(() => requestAnimationFrame(step)).catch((err) => {
        this.cb.onError(`Playback failed: ${String(err)}`);
        resolve();
      });
    });

    this.running = false;
    const result = this.metrics.finalize(`${this.config.scenarioName}-video`);
    // override scenario name & GT policy info for the report
    result.scenario_name = this.config.scenarioName;
    const csv = eventsToCsv(this.metrics.eventRows);
    this.cb.onLog('INFO', 'Video benchmark complete', `${result.frames_processed} frames`);
    this.cb.onDone(result, csv);
  }

  stop(): void {
    this.running = false;
    this.video?.pause();
  }
}
