/**
 * FSOC-PAT UI store (Zustand). Mirrors the backend state machine 1:1
 * (SEARCH / CANDIDATE / ACQUIRE / TRACK / PREDICT_REACQUIRE — no invented
 * UI states). Telemetry is flushed from EngineClient buffers at ~8 Hz so
 * React re-renders stay bounded while the pipeline runs at 30 Hz.
 */
import { create } from 'zustand';
import { engine, type FrameData } from './engine-client';
import { DEFAULT_CONFIG, type ScenarioConfig } from '@/engine/config';
import { buildDemoConfig } from '@/engine/demo';
import type { EnginePhase, LogEntry, RunResult, TelemetrySnapshot } from '@/engine/types';

export type ViewId = 'launch' | 'laboratory' | 'scenarios' | 'benchmark' | 'analytics' | 'replay' | 'comparison' | 'settings';

interface FsocState {
  view: ViewId;
  phase: EnginePhase;
  runNumber: number;
  telemetry: TelemetrySnapshot | null;
  frameVersion: number;
  logs: LogEntry[];
  config: ScenarioConfig;
  configLocked: boolean;
  configErrors: { path: string; message: string }[];
  lastResult: RunResult | null;
  refreshTick: number; // bumped on every flush to trigger subscribers

  setView(v: ViewId): void;
  setConfig(c: ScenarioConfig): void;
  startRun(): void;
  startDemo(): void;
  pauseRun(): void;
  stopRun(): void;
  killBeacon(): void;
  refresh(): void;
}

export const useFsoc = create<FsocState>((set, get) => ({
  view: 'launch',
  phase: 'idle',
  runNumber: 0,
  telemetry: null,
  frameVersion: 0,
  logs: [],
  config: DEFAULT_CONFIG,
  configLocked: false,
  configErrors: [],
  lastResult: null,
  refreshTick: 0,

  setView: (v) => set({ view: v }),

  setConfig: (c) => {
    if (get().configLocked) return; // parameter panel read-only during a run
    engine.validateAndSet(c);
    set({ config: c, configErrors: engine.configErrors });
  },

  startRun: () => {
    const { config } = get();
    engine.start(config);
    set({ configLocked: true, phase: 'initializing' });
  },

  /** §22 — one-button judge demonstration on a fixed seed. */
  startDemo: () => {
    const config = buildDemoConfig();
    engine.start(config, true);
    set({ config, configLocked: true, phase: 'initializing', view: 'laboratory' });
  },

  pauseRun: () => {
    engine.pause();
  },

  stopRun: () => {
    engine.stop('Stopped by operator');
  },

  killBeacon: () => {
    engine.killBeacon(18);
  },

  refresh: () => {
    const f = engine.flush();
    set((s) => ({
      telemetry: f.telemetry ?? s.telemetry,
      phase: f.phase,
      logs: f.logs,
      frameVersion: f.frameVersion,
      lastResult: engine.lastResult ?? s.lastResult,
      runNumber: engine.runNumber,
      configLocked: f.phase === 'running' || f.phase === 'paused' || f.phase === 'initializing',
      refreshTick: s.refreshTick + 1,
    }));
  },
}));

/** Bind engine → store flush loop (called once from the shell). */
export function bindEngineToStore(): () => void {
  engine.bindStore((fn) => fn());
  const interval = setInterval(() => useFsoc.getState().refresh(), 120);
  return () => clearInterval(interval);
}

export function getFrame(): FrameData {
  return engine.frame;
}

// End-to-end verification hook (scripts/browser-e2e.ts). Exposed ONLY when the
// page is opened with ?e2e, so the browser test drives the app through its own
// store actions (setConfig / startRun) and reads back what the UI shows.
if (typeof window !== 'undefined' && window.location.search.includes('e2e')) {
  (window as unknown as { __fsoc: typeof useFsoc }).__fsoc = useFsoc;
}

export { engine };
