/**
 * EngineClient — transport adapter between the UI and the simulation worker
 * (docs/Frontend-Design §34: "the frontend must not hard-code transport
 * assumptions into visual components").
 *
 * Performance rules implemented here (§35):
 *  - raw per-frame data never flows directly into React state;
 *  - latest frame lives in a module-level buffer read via rAF by the viewport;
 *  - chart ring-buffers updated per frame, sampled into the store at ~10 Hz;
 *  - event log capped and batched.
 */
import { DEFAULT_CONFIG, validateConfig, type ScenarioConfig } from '@/engine/config';
import type {
  EnginePhase,
  LogEntry,
  LogLevel,
  MetricsSnapshot,
  RunResult,
  TelemetrySnapshot,
  TrackingStateName,
} from '@/engine/types';

export interface FrameData {
  buf: Uint8Array | null;
  width: number;
  height: number;
  version: number;
}

export interface PointSample {
  t: number;
  v: number;
}

export interface TrajSample {
  t: number;
  gtX: number | null;
  gtY: number | null;
  estX: number | null;
  estY: number | null;
  cx: number;
  cy: number;
}

export interface LockBand {
  startT: number;
  endT: number;
  state: TrackingStateName;
}

const CHART_CAP = 900;
const LOG_CAP = 400;

class EngineClient {
  private worker: Worker | null = null;
  private listeners = new Set<() => void>();

  phase: EnginePhase = 'idle';
  frame: FrameData = { buf: null, width: 640, height: 480, version: 0 };
  latest: TelemetrySnapshot | null = null;

  // chart ring buffers
  errorSeries: PointSample[] = [];
  panSeries: PointSample[] = [];
  tiltSeries: PointSample[] = [];
  trajSeries: TrajSample[] = [];
  lockBands: LockBand[] = [];
  private lastState: TrackingStateName | null = null;

  // pending log batch
  pendingLogs: LogEntry[] = [];
  logs: LogEntry[] = [];

  config: ScenarioConfig = DEFAULT_CONFIG;
  configErrors: { path: string; message: string }[] = [];
  validationOk = true;

  runNumber = 0;
  lastResult: RunResult | null = null;
  lastEventsCsv: string | null = null;

  private storeHook: ((fn: () => void) => void) | null = null;

  /** Register the zustand setState hook used for throttled flushes. */
  bindStore(hook: (fn: () => void) => void): void {
    this.storeHook = hook;
  }

  private notify(): void {
    this.storeHook?.(() => undefined);
    this.listeners.forEach((l) => l());
  }

  onFrame(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('../workers/simulation.worker.ts', import.meta.url));
      this.worker.onmessage = (e: MessageEvent) => this.handleMessage(e.data);
      this.worker.onerror = (err) => {
        console.error('[engine-worker]', err.message);
        this.phase = 'error';
        this.pushLog('ERROR', `Engine worker error: ${err.message}`);
        this.notify();
      };
    }
    return this.worker;
  }

  private handleMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'initialized':
        this.phase = 'idle';
        this.notify();
        break;
      case 'phase':
        this.phase = msg.phase as EnginePhase;
        if (this.phase === 'running') {
          // new run bookkeeping
        }
        this.notify();
        break;
      case 'frame': {
        const buf = msg.frame as ArrayBuffer;
        const w = msg.width as number;
        const h = msg.height as number;
        this.frame = {
          buf: new Uint8Array(buf),
          width: w,
          height: h,
          version: this.frame.version + 1,
        };
        const snap = msg.snapshot as TelemetrySnapshot;
        this.latest = snap;
        this.pushChartSamples(snap);
        this.listeners.forEach((l) => l());
        break;
      }
      case 'log': {
        const entry = msg.entry as LogEntry;
        this.pendingLogs.push(entry);
        if (this.pendingLogs.length >= 8) this.flushLogs();
        break;
      }
      case 'result': {
        const result = msg.result as RunResult;
        this.lastResult = result;
        this.lastEventsCsv = (msg.eventsCsv as string) ?? null;
        this.runNumber++;
        void this.saveRun(result, this.lastEventsCsv);
        this.notify();
        break;
      }
      case 'error':
        this.pushLog('ERROR', msg.message as string);
        this.phase = 'error';
        this.notify();
        break;
    }
  }

  private pushChartSamples(snap: TelemetrySnapshot): void {
    const t = snap.timestampS;
    pushSample(this.errorSeries, { t, v: snap.errorPx ?? NaN }, CHART_CAP);
    pushSample(this.panSeries, { t, v: snap.command.pan_deg_s }, CHART_CAP);
    pushSample(this.tiltSeries, { t, v: snap.command.tilt_deg_s }, CHART_CAP);
    // convert tracked estimate (camera-image px) into scene px so the
    // trajectory chart compares like with like
    const cfg = this.config;
    const ppdX = cfg.camera.resolutionWidth / cfg.camera.fovXDeg;
    const ppdY = cfg.camera.resolutionHeight / cfg.camera.fovYDeg;
    const cropCenterX = cfg.scene.width / 2 + snap.camera.pan_deg * ppdX;
    const cropCenterY = cfg.scene.height / 2 + snap.camera.tilt_deg * ppdY;
    const estSceneX = snap.track.x !== null ? snap.track.x + (cropCenterX - cfg.camera.resolutionWidth / 2) : null;
    const estSceneY = snap.track.y !== null ? snap.track.y + (cropCenterY - cfg.camera.resolutionHeight / 2) : null;
    pushSample(
      this.trajSeries,
      {
        t,
        gtX: snap.groundTruth?.x_px ?? null,
        gtY: snap.groundTruth?.y_px ?? null,
        estX: estSceneX,
        estY: estSceneY,
        cx: NaN,
        cy: NaN,
      },
      CHART_CAP,
    );
    if (this.lastState !== snap.track.state) {
      if (this.lastState !== null && this.lockBands.length > 0) {
        const last = this.lockBands[this.lockBands.length - 1];
        if (last.endT < 0) last.endT = t;
      }
      this.lockBands.push({ startT: t, endT: -1, state: snap.track.state });
      if (this.lockBands.length > 240) this.lockBands.shift();
      this.lastState = snap.track.state;
    } else if (this.lockBands.length > 0) {
      // extend implicit via startT of last band (endT stays open)
    }
  }

  /** Called by the UI at ~10 Hz to move buffered data into React state. */
  flush(): {
    telemetry: TelemetrySnapshot | null;
    phase: EnginePhase;
    logs: LogEntry[];
    frameVersion: number;
  } {
    this.flushLogs();
    return {
      telemetry: this.latest,
      phase: this.phase,
      logs: this.logs,
      frameVersion: this.frame.version,
    };
  }

  private flushLogs(): void {
    if (this.pendingLogs.length === 0) return;
    this.logs = [...this.logs, ...this.pendingLogs].slice(-LOG_CAP);
    this.pendingLogs = [];
  }

  pushLog(level: LogLevel, message: string, detail?: string): void {
    const d = new Date();
    const pad = (v: number, n = 2) => String(v).padStart(n, '0');
    this.logs = [
      ...this.logs.slice(-(LOG_CAP - 1)),
      {
        id: Date.now() + Math.random(),
        t: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`,
        simT: this.latest?.timestampS ?? 0,
        level,
        message,
        detail,
      },
    ];
    this.notify();
  }

  // ---- commands ----

  validateAndSet(config: ScenarioConfig): boolean {
    const v = validateConfig(config);
    if (v.ok) {
      this.config = v.config;
      this.configErrors = [];
      this.validationOk = true;
    } else {
      this.configErrors = v.errors;
      this.validationOk = false;
    }
    this.notify();
    return this.validationOk;
  }

  /** Initialize + start a run. Config is locked while running (docs/03 §3). */
  start(config: ScenarioConfig): void {
    if (!this.validateAndSet(config)) {
      this.pushLog('ERROR', 'Cannot start: configuration invalid', 'Fix the highlighted fields');
      return;
    }
    // fresh buffers per run
    this.errorSeries = [];
    this.panSeries = [];
    this.tiltSeries = [];
    this.trajSeries = [];
    this.lockBands = [];
    this.lastState = null;
    this.frame = { buf: null, width: config.camera.resolutionWidth, height: config.camera.resolutionHeight, version: 0 };
    this.latest = null;
    const w = this.ensureWorker();
    w.postMessage({ type: 'init', config: this.config });
    w.postMessage({ type: 'start' });
    this.phase = 'initializing';
    this.notify();
  }

  pause(): void {
    this.ensureWorker().postMessage({ type: 'pause' });
  }

  stop(reason?: string): void {
    if (this.phase === 'running' || this.phase === 'paused' || this.phase === 'initializing') {
      this.ensureWorker().postMessage({ type: 'stop', reason });
    }
  }

  killBeacon(frames = 18): void {
    this.ensureWorker().postMessage({ type: 'killBeacon', frames });
  }

  resetIntegrator(): void {
    this.ensureWorker().postMessage({ type: 'resetIntegrator' });
  }

  /** Terminate + recreate the worker (hard reset). */
  hardReset(): void {
    this.worker?.terminate();
    this.worker = null;
    this.phase = 'idle';
    this.frame = { buf: null, width: 640, height: 480, version: 0 };
    this.latest = null;
    this.notify();
  }

  private async saveRun(result: RunResult, eventsCsv: string | null): Promise<void> {
    try {
      // Cap stored CSV to the first ~5400 rows (~3 min @30 Hz) to bound DB size
      let csv = eventsCsv;
      if (csv && csv.length > 0) {
        const lines = csv.split('\n');
        if (lines.length > 5401) csv = [...lines.slice(0, 5401), '# truncated'].join('\n');
      }
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result, eventsCsv: csv }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.pushLog('INFO', 'Run saved to registry', result.run_id);
    } catch (err) {
      this.pushLog('WARN', 'Run registry unavailable — export files remain valid', String(err));
    }
  }
}

function pushSample<T>(arr: T[], sample: T, cap: number): void {
  arr.push(sample);
  if (arr.length > cap) arr.shift();
}

export const engine = new EngineClient();
export type { MetricsSnapshot };
