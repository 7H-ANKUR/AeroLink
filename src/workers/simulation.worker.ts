/**
 * Simulation engine worker (docs/04 §6 threading model).
 * The full processing loop — scene render → disturbances → camera crop →
 * detect → track → control → metrics — runs HERE, never on the UI thread.
 *
 * The loop itself lives in `SimulationRunner` (src/engine/simulation.ts) and
 * is shared with the headless benchmark, demos and tests, so what is measured
 * offline is exactly what runs here. This file owns only the things that are
 * specific to running live in a browser: wall-clock pacing, the event log,
 * the frame-buffer pool and the telemetry snapshots posted to the UI.
 */
import { scenarioConfigSchema, type ScenarioConfig } from '../engine/config';
import { SimulationRunner, type SimulationStepResult } from '../engine/simulation';
import { DEMO_SCRIPT, type DemoAction } from '../engine/demo';
import type { MetricsEngine } from '../engine/metrics';
import { eventsToCsv } from '../engine/export';
import { assetUrl, loadModel, lastLoadError } from '../lib/load-model';
import { createOrtBackends } from '../lib/ort-runtime';
import { buildPatchBatch } from '../engine/nn';
import { detectorRequiresModel } from '../engine/detectors';
import type { LoadedModel } from '../engine/detector-ai';
import type { LogLevel, TelemetrySnapshot } from '../engine/types';

interface WorkerAPI {
  init(config: unknown): void;
  start(): void;
  startNow(): void;
  pause(): void;
  stop(reason?: string): void;
  killBeacon(frames: number): void;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let config: ScenarioConfig | null = null;
let runner: SimulationRunner | null = null;
/** Trained weights, fetched once per worker and reused across runs. */
let model: LoadedModel | null = null;
let metrics: MetricsEngine | null = null;

let running = false;
let paused = false;
let lastLoopMs = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let framePool: ArrayBuffer[] = [];
let poolIdx = 0;
const POOL_SIZE = 4;
let logIdCounter = 0;
/** Judge-demo injection timeline; empty for a normal run (§22). */
let demoScript: DemoAction[] = [];
let demoFired = new Set<number>();
/** True when the learned stages run through ONNX Runtime Web (plan2). */
let useOrt = false;
/** Live ORT-vs-TypeScript parity check, once per run on a real frame. */
let parityChecked = false;
/** Guards the async loop against re-entrancy. */
let stepping = false;

/**
 * Attach ONNX Runtime Web backends to the loaded model (plan2). The ONNX files
 * are the exported deployed weights (scripts/ai/export_onnx.py). If the
 * runtime cannot start, the run continues on the in-engine TypeScript forward
 * pass of the SAME weights — and says so in the log and in every frame's
 * provenance (aiRuntime); nothing is presented as ORT output that was not.
 */
async function attachOrt(m: LoadedModel): Promise<void> {
  if (m.scorer) return;
  try {
    const [cnnRes, verRes] = await Promise.all([
      fetch(assetUrl('/models/beacon-roi-v2.onnx')),
      fetch(assetUrl('/models/track-verifier-v1.onnx')),
    ]);
    if (!cnnRes.ok) throw new Error(`beacon-roi-v2.onnx: HTTP ${cnnRes.status}`);
    const cnnBytes = new Uint8Array(await cnnRes.arrayBuffer());
    const verBytes = verRes.ok ? new Uint8Array(await verRes.arrayBuffer()) : null;
    const b = await createOrtBackends(cnnBytes, verBytes, assetUrl('/ort/'));
    m.scorer = b.scorer;
    m.batchVerifier = b.batchVerifier;
    postLog(
      'SYSTEM',
      `ONNX Runtime Web ready — ${b.runtime}`,
      `beacon-roi-v2.onnx ${cnnBytes.byteLength} B` +
        (verBytes ? ` + track-verifier-v1.onnx ${verBytes.byteLength} B` : '') +
        `, sessions created in ${b.loadMs.toFixed(0)} ms`,
    );
  } catch (err) {
    postLog(
      'WARN',
      'ONNX Runtime Web unavailable — learned stages use the in-engine TypeScript forward pass',
      err instanceof Error ? err.message : String(err),
    );
  }
}

function simTime(): number {
  return runner ? runner.simTimeS : 0;
}

function postLog(level: LogLevel, message: string, detail?: string, frame?: number): void {
  const d = new Date();
  const pad = (v: number, n = 2) => String(v).padStart(n, '0');
  ctx.postMessage({
    type: 'log',
    entry: {
      id: ++logIdCounter,
      t: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`,
      simT: simTime(),
      frame,
      level,
      message,
      detail,
    },
  });
}

async function initEngine(rawConfig: unknown): Promise<void> {
  const parsed = scenarioConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    ctx.postMessage({ type: 'error', message: 'Configuration validation failed on worker side.' });
    return;
  }
  config = parsed.data;
  const cfg = config;

  // The learned detectors need weights before the runner can be built. If the
  // model is missing we say so and stop, rather than starting a run that is
  // silently classical while the UI reports a learned detector.
  if (detectorRequiresModel(cfg.tracking.detector)) {
    if (model === null) model = await loadModel();
    if (model === null) {
      ctx.postMessage({
        type: 'error',
        message:
          `The ${cfg.tracking.detector} detector needs a trained model, and ` +
          'public/models/beacon-roi-v2.bin was not found. Select the classical ' +
          'detector, or train a model with scripts/ai/train_roi.py.' +
          (lastLoadError ? ` (load error: ${lastLoadError})` : ''),
      });
      return;
    }
    if (cfg.tracking.detector === 'fusion' && !model.verifier) {
      ctx.postMessage({
        type: 'error',
        message:
          'The hybrid detector needs the learned track verifier, and ' +
          'public/models/track-verifier-v1.json was not found. Select another ' +
          'detector, or train it with scripts/ai/train_track_verifier.py.',
      });
      return;
    }
    postLog('SYSTEM', `Learned model loaded — ${model.manifest.name}`,
      `${model.manifest.paramCount} parameters`);
    await attachOrt(model);
    if (cfg.tracking.detector === 'fusion' && model.verifier) {
      postLog('SYSTEM', `Track verifier loaded — ${model.verifier.name}`,
        'temporal decoy rejection + clutter map active');
    }
  }

  runner = new SimulationRunner(cfg, {
    onTransition(from, to, fi) {
      postLog('STATE', `${from} → ${to}`, undefined, fi);
      if (to === 'SEARCH') {
        postLog('SEARCH', 'Coarse acquisition scan started', `pattern=${cfg.tracking.searchPattern}`, fi);
      } else if (to === 'CANDIDATE') {
        postLog('DETECT', 'Optical candidate detected', undefined, fi);
      } else if (to === 'ACQUIRE') {
        postLog('ACQUIRE', 'Candidate confirmed — validating lock', undefined, fi);
      }
    },
    onAcquired(t, fi) {
      postLog('LOCK', 'Coarse optical alignment acquired', `${t.toFixed(3)}s from run start`, fi);
    },
    onLossConfirmed(_t, fi) {
      postLog('LOSS', 'OPTICAL SIGNAL LOST', 'detection unavailable', fi);
      postLog('PREDICT', 'Kalman prediction engaged', undefined, fi);
    },
    onReacquired(rt, fi) {
      postLog('REACQUIRE', 'Optical signal reacquired — coarse lock restored', `${rt.toFixed(3)}s after loss`, rt !== undefined ? fi : undefined);
    },
  }, model);
  metrics = runner.metrics;

  paused = false;
  running = false;
  demoFired = new Set<number>();
  useOrt = detectorRequiresModel(cfg.tracking.detector) && !!model?.scorer;
  parityChecked = false;

  const w = cfg.camera.resolutionWidth;
  const h = cfg.camera.resolutionHeight;
  framePool = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    framePool.push(new ArrayBuffer(w * h));
  }
  poolIdx = 0;

  postLog(
    'SYSTEM',
    'Mission initialized',
    `scene ${cfg.scene.width}×${cfg.scene.height}, cam ${w}×${h} @ ${cfg.camera.updateHz}Hz, seed ${cfg.seed}`,
  );
  ctx.postMessage({ type: 'initialized' });
}

function loop(): void {
  if (!running || stepping) return;
  const loopStart = performance.now();
  stepping = true;
  void stepOnce()
    .catch((err: unknown) => {
      postLog('ERROR', 'Frame step failed', err instanceof Error ? err.message : String(err));
      running = false;
    })
    .finally(() => {
      stepping = false;
      if (!running || paused) return;
      const cfg = config!;
      const interval = 1000 / cfg.camera.updateHz;
      const spent = performance.now() - loopStart;
      const wait = Math.max(1, interval - spent);
      timer = setTimeout(loop, wait);
    });
}

async function stepOnce(): Promise<void> {
  const cfg = config;
  if (!cfg || !runner || !metrics) return;

  // Live pacing: advance by the real elapsed time, bounded so a stalled tab
  // cannot teleport the beacon. (Headless callers pass a fixed dt instead,
  // which is what makes the benchmark reproducible.)
  const now = performance.now();
  const wallDt = lastLoopMs ? (now - lastLoopMs) / 1000 : 1 / cfg.camera.updateHz;
  lastLoopMs = now;
  const dt = Math.min(0.2, Math.max(0.001, wallDt));

  const w = cfg.camera.resolutionWidth;
  const h = cfg.camera.resolutionHeight;
  const frameBuf = new Uint8Array(framePool[poolIdx]);
  poolIdx = (poolIdx + 1) % POOL_SIZE;

  // Learned detectors with an ORT backend step asynchronously: the CNN and the
  // track verifier run in ONNX Runtime Web on THIS frame before the tracker,
  // controller and mount see the result.
  const step = useOrt ? await runner.stepAsync(dt, frameBuf) : runner.step(dt, frameBuf);
  if (!running) return;
  const result = step.pipeline;
  if (useOrt && !parityChecked && result.detection.found && result.detection.x !== null && model?.scorer) {
    parityChecked = true;
    // Live runtime parity on a real observed frame: the same ROI through ORT
    // and through the in-engine forward pass of the same weights.
    const pt = { x: result.detection.x, y: result.detection.y as number };
    const ortP = (await model.scorer.scoreBatch(buildPatchBatch(step.frame, step.width, step.height, [pt]), 1))[0];
    const tsP = model.net.scoreAt(step.frame, step.width, step.height, pt.x, pt.y);
    postLog(
      'SYSTEM',
      'Runtime parity on live frame',
      `ROI (${pt.x.toFixed(1)}, ${pt.y.toFixed(1)}): ORT ${ortP.toFixed(6)} vs TS ${tsP.toFixed(6)} · |Δ| ${Math.abs(ortP - tsP).toExponential(2)}`,
      step.frameIndex,
    );
  }

  if (step.beaconRestored) postLog('SYSTEM', 'Beacon restored after kill', undefined, step.frameIndex);
  if (cfg.jitter.enabled && step.frameIndex % 30 === 0 && step.jitterPx > 1) {
    postLog('DISTURBANCE', 'Camera jitter', `${step.jitterPx.toFixed(1)} px`, step.frameIndex);
  }
  emitMissionEvents(cfg, step);
  runDemoScript(step.timestampS);

  // ---- Telemetry snapshot to UI (transferred frame buffer) ----
  const metricsSnap = metrics.snapshot(step.timestampS);
  const snap: TelemetrySnapshot = {
    frameIndex: step.frameIndex,
    timestampS: step.timestampS,
    detection: { ...result.detection },
    track: { ...result.track },
    command: { ...result.command },
    camera: { pan_deg: result.cameraPan, tilt_deg: result.cameraTilt },
    // scene-space for the 3D / trajectory views
    groundTruth: {
      x_px: step.beacon.x_px,
      y_px: step.beacon.y_px,
      vx_px_s: step.beacon.vx_px_s,
      vy_px_s: step.beacon.vy_px_s,
    },
    beaconImageX: result.beaconImageX,
    beaconImageY: result.beaconImageY,
    errorPx: result.errorPx,
    locked: false,
    lost: result.track.state === 'SEARCH',
    processingMs: result.processingMs,
    metrics: metricsSnap,
    jitterPx: step.jitterPx,
    activeDisturbances: collectActiveDisturbances(cfg),
    mount: step.mount,
    link: step.link,
    mission: step.mission,
    predicted:
      result.predictedX !== null && result.predictedY !== null
        ? { x: result.predictedX, y: result.predictedY }
        : null,
  };

  const transferBuf = frameBuf.buffer.slice(0);
  ctx.postMessage(
    {
      type: 'frame',
      frame: transferBuf,
      width: w,
      height: h,
      snapshot: snap,
      cameraPose: { pan_deg: result.cameraPan, tilt_deg: result.cameraTilt },
      viewportCenterScene: { x: result.viewportCenterSceneX, y: result.viewportCenterSceneY },
    },
    [transferBuf],
  );

  // end-of-run
  if (step.timestampS >= cfg.durationS) {
    finishRun('Scenario duration reached');
  }
}

/**
 * The §14 acquisition chain, emitted from real engine state.
 *
 * Throttled deliberately: the loop runs at 30 Hz and a line per frame would
 * bury the story. While converging (not yet locked) the stream is dense enough
 * to follow the slew; once locked it drops to a heartbeat.
 */
let lastDetectLoggedFrame = -999;
function emitMissionEvents(cfg: ScenarioConfig, step: SimulationStepResult): void {
  const r = step.pipeline;
  const fi = step.frameIndex;
  const w = cfg.camera.resolutionWidth;
  const h = cfg.camera.resolutionHeight;

  // First detection after a dry spell — the moment the beacon is seen.
  if (r.detection.found && r.detection.x !== null && r.detection.y !== null) {
    if (fi - lastDetectLoggedFrame > 45) {
      postLog(
        'DETECT',
        'Optical candidate detected',
        `centroid=(${r.detection.x.toFixed(1)}, ${r.detection.y.toFixed(1)}) confidence=${r.detection.confidence.toFixed(2)}`,
        fi,
      );
      lastDetectLoggedFrame = fi;
    }
  } else {
    lastDetectLoggedFrame = -999;
  }

  // ── plan2: the whole chain for ONE frame, from the engine's own state ──
  // camera frame → classical CV → AI inference → fusion → Kalman → LOS → PID
  // → mount. Throttled to once a second so it stays readable.
  const pv = r.detection.provenance;
  if (pv && fi % 30 === 0) {
    const f = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? '—' : v.toFixed(d));
    postLog(
      'DETECT',
      'Perception chain',
      `CV ${pv.cv ? `(${f(pv.cv.x)}, ${f(pv.cv.y)}) c=${f(pv.cv.confidence, 2)}` : 'none'} [${pv.candidateCount} cand] · ` +
        `AI ${pv.ai ? `(${f(pv.ai.x)}, ${f(pv.ai.y)}) p=${f(pv.ai.confidence, 3)}` : 'none'} [${pv.aiScored ?? 0} ROIs, ${f(pv.aiInferenceMs, 2)} ms, ${pv.aiRuntime ?? '—'}] · ` +
        `FUSION ${pv.chosenBy}${pv.trackP != null ? ` trackP=${f(pv.trackP, 2)}` : ''} → ` +
        (r.detection.found ? `(${f(r.detection.x)}, ${f(r.detection.y)}) conf=${f(r.detection.confidence, 2)}` : 'no target') +
        ` · ${pv.decisionReason ?? ''}`,
      fi,
    );
    postLog(
      'TRACK',
      'Kalman → PID → mount',
      `state=${r.track.state} pred=(${f(r.predictedX)}, ${f(r.predictedY)}) est=(${f(r.track.x)}, ${f(r.track.y)}) · ` +
        `cmd pan=${f(r.command.pan_deg_s, 2)} tilt=${f(r.command.tilt_deg_s, 2)} °/s · ` +
        `mount actual=${f(step.mount.actualPanRateDegS, 2)}/${f(step.mount.actualTiltRateDegS, 2)} °/s az=${f(step.mount.azimuthDeg, 3)}° el=${f(step.mount.elevationDeg, 3)}°`,
      fi,
    );
  }

  const tracking = r.track.state === 'TRACK' || r.track.state === 'PREDICT_REACQUIRE';
  if (!tracking || r.track.x === null || r.track.y === null) return;

  const locked = r.errorPx !== null && r.errorPx <= cfg.tracking.lockRadiusPx;
  // dense while slewing onto the target, sparse once settled
  const every = locked ? 60 : 12;
  if (fi % every !== 0) return;

  // LOS solution: pixel error → angular error (docs/04 §4.13)
  const dx = r.track.x - w / 2;
  const dy = r.track.y - h / 2;
  const azErr = (dx / w) * cfg.camera.fovXDeg;
  const elErr = (dy / h) * cfg.camera.fovYDeg;
  const sgn = (v: number, d: number) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;

  postLog(
    'TRACK',
    'LOS solution computed',
    `dx=${sgn(dx, 1)} px dy=${sgn(dy, 1)} px · az=${sgn(azErr, 3)}° el=${sgn(elErr, 3)}°`,
    fi,
  );
  postLog(
    'CONTROL',
    'Pan/tilt command generated',
    `pan=${sgn(r.command.pan_deg_s, 2)} °/s tilt=${sgn(r.command.tilt_deg_s, 2)} °/s`,
    fi,
  );
  postLog(
    'MOUNT',
    step.mount.accelLimited ? 'Receiver slewing (accel limited)' : 'Receiver slewing',
    `az=${sgn(step.mount.azimuthDeg, 3)}° el=${sgn(step.mount.elevationDeg, 3)}° · actual=${sgn(step.mount.actualPanRateDegS, 2)}/${sgn(step.mount.actualTiltRateDegS, 2)} °/s`,
    fi,
  );
}

/**
 * Fire any scripted demo injections whose time has arrived. This only changes
 * CONDITIONS — atmosphere, noise, whether the beacon is visible. It never
 * touches detection, tracking or control, and it never claims an outcome:
 * what the loop does in response is the loop's own behaviour.
 */
function runDemoScript(timestampS: number): void {
  if (demoScript.length === 0 || !runner) return;
  for (let i = 0; i < demoScript.length; i++) {
    if (demoFired.has(i)) continue;
    const a = demoScript[i];
    if (timestampS < a.atS) continue;
    demoFired.add(i);
    if (a.kind === 'disturbance') {
      runner.setDisturbance(a.payload as Parameters<SimulationRunner['setDisturbance']>[0]);
      postLog('DISTURBANCE', a.label, 'injected by demonstration script', runner.frameIndex);
    } else if (a.kind === 'kill-beacon') {
      const frames = Number((a.payload as { frames?: number })?.frames ?? 45);
      runner.killBeaconForFrames(frames);
      postLog('WARN', a.label, `${frames} frames`, runner.frameIndex);
    }
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
  if (!metrics || !runner || !config) return;
  runner.missionTracker.markReportGenerated(runner.simTimeS, runner.frameIndex);
  const result = metrics.finalize(config.scenarioName + reason);
  postLog('SYSTEM', `Run complete — ${reason}`, `${result.frames_processed} frames processed`);
  const csv = eventsToCsv(metrics.eventRows);
  ctx.postMessage({ type: 'result', result, eventsCsv: csv });
  ctx.postMessage({ type: 'phase', phase: 'complete' });
}

/**
 * Initialisation is asynchronous (model fetch, ONNX Runtime session
 * creation), but the client posts `init` and `start` back to back. `start`
 * therefore waits for the most recent `init` to settle; without this it could
 * arrive while the runner was still being built and be dropped — or restart
 * the previous run's runner.
 */
let initPromise: Promise<void> = Promise.resolve();

const api: WorkerAPI = {
  init(rawConfig) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    running = false;
    runner = null;
    initPromise = initEngine(rawConfig).catch((err: unknown) => {
      ctx.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : 'Engine initialisation failed.',
      });
    });
  },
  start() {
    void initPromise.then(() => api.startNow());
  },
  startNow() {
    if (!config || !runner) return;
    running = true;
    paused = false;
    lastLoopMs = 0;
    postLog('SCENARIO', `Scenario armed — ${config.scenarioName}`, `seed=${config.seed} duration=${config.durationS}s`);
    ctx.postMessage({ type: 'phase', phase: 'running' });
    loop();
  },
  pause() {
    if (!running) return;
    paused = !paused;
    postLog('SYSTEM', paused ? 'Simulation paused' : 'Simulation resumed');
    ctx.postMessage({ type: 'phase', phase: paused ? 'paused' : 'running' });
    if (paused && timer) {
      clearTimeout(timer);
      timer = null;
    } else if (!paused) {
      // Drop the stale timestamp so the first frame after a resume advances by
      // one nominal frame instead of the whole pause duration.
      lastLoopMs = 0;
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
    runner?.killBeaconForFrames(frames);
    postLog('WARN', `DEBUG: beacon killed for ${frames} frames`);
  },
};

const workerSelf = self as unknown as { onmessage: (e: MessageEvent) => void };
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
    case 'setDemoScript':
      demoScript = msg.enabled ? DEMO_SCRIPT : [];
      demoFired = new Set<number>();
      break;
    case 'setDisturbance':
      runner?.setDisturbance(msg.payload);
      break;
    case 'resetIntegrator':
      runner?.pipeline.resetControllerIntegrator();
      break;
  }
};
