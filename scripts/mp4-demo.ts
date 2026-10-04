/// <reference types="bun-types" />
/**
 * DEMO 7 — External MP4 benchmark, headless (master prompt §25, §34).
 *
 * REAL video ingestion: ffmpeg decodes the MP4 to raw grayscale frames on a
 * pipe; each decoded frame enters the SAME pipeline as the simulator:
 *
 *   decoded frame → detector → Kalman tracker → state machine → controller
 *                   → (pose logged; recorded pixels CANNOT be altered)
 *                   → metrics (reference-free: no ground truth fabrication)
 *
 * Because the recording has no evaluator ground truth, only perception
 * metrics are reported (docs/08 §4 policy): detection rate, track
 * continuity, reacquisition events, algorithm FPS, confidence.
 *
 * Usage: bun scripts/mp4-demo.ts [videoPath]
 */
import { validateConfig, DEFAULT_CONFIG } from '../src/engine/config';
import { createCamera, stepCamera, cameraCenterPx } from '../src/engine/camera';
import { Pipeline, type PipelineHost } from '../src/engine/pipeline';

const videoPath = process.argv[2] ?? 'public/samples/sample_benchmark_01.mp4';

// --- probe the container ------------------------------------------------
const probe = Bun.spawnSync([
  'ffprobe', '-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height,r_frame_rate,nb_frames',
  '-of', 'csv=p=0', videoPath,
]);
const [vwS, vhS, rateS] = probe.stdout.toString().trim().split(',');
const vw = parseInt(vwS, 10);
const vh = parseInt(vhS, 10);
const [rn, rd] = rateS.split('/').map(Number);
const fps = rn / rd;
console.log(`=== DEMO 7: external MP4 benchmark (perception-only) ===`);
console.log(`input: ${videoPath} — ${vw}x${vh} @ ${fps.toFixed(2)} fps`);

// --- config: PS defaults, camera matched to the file --------------------
const base = structuredClone(DEFAULT_CONFIG);
const cfg = validateConfig({
  ...base,
  scenarioName: 'DEMO7 External MP4',
  seed: 7,
  durationS: 60,
  camera: { ...base.camera, resolutionWidth: vw, resolutionHeight: vh, updateHz: Math.round(fps) },
});
if (!cfg.ok) {
  console.error('config invalid', cfg.errors);
  process.exit(1);
}
const config = cfg.config;

// Virtual pose integrates controller commands for logging ONLY — the decoded
// pixels are pre-recorded and cannot be altered by the controller.
const camera = createCamera({
  maxPanSpeedDegS: config.camera.maxPanSpeedDegS, maxTiltSpeedDegS: config.camera.maxTiltSpeedDegS,
  resolutionWidth: vw, resolutionHeight: vh,
  sceneWidth: config.scene.width, sceneHeight: config.scene.height,
  fovXDeg: config.camera.fovXDeg, fovYDeg: config.camera.fovYDeg,
});
const transitions: string[] = [];
const host: PipelineHost = {
  applyCommand(cmd, dtS) {
    stepCamera(camera, cmd.pan_deg_s, cmd.tilt_deg_s, dtS);
    return { pan_deg: camera.pan_deg, tilt_deg: camera.tilt_deg };
  },
  viewportCenter() {
    const c = cameraCenterPx(camera);
    return { x: c.cx, y: c.cy };
  },
  pixelsPerDeg() {
    return { x: camera.pxPerDegX, y: camera.pxPerDegY };
  },
  sceneToImage(x, y) {
    const c = cameraCenterPx(camera);
    const ix = x - (c.cx - vw / 2);
    const iy = y - (c.cy - vh / 2);
    if (ix < 0 || iy < 0 || ix >= vw || iy >= vh) return null;
    return { x: ix, y: iy };
  },
  onTransition(from, to, fi) {
    transitions.push(`frame ${fi}: ${from} -> ${to}`);
  },
  onAcquired() {},
  onLossConfirmed() {},
  onReacquired() {},
};

const pipeline = new Pipeline(
  config,
  { mode: 'video', fps, resolution: [vw, vh], has_ground_truth: false },
  host,
  'none', // no evaluator GT → reference-free mode (docs/08 §4)
);

// --- decode + feed -------------------------------------------------------
console.log('decoding with ffmpeg (-f rawvideo -pix_fmt gray) …');
const proc = Bun.spawn(
  ['ffmpeg', '-v', 'error', '-i', videoPath, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
  { stdout: 'pipe', stderr: 'ignore' },
);
const raw = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
const frameLen = vw * vh;
const nFrames = Math.floor(raw.length / frameLen);
console.log(`decoded ${nFrames} frames (${raw.length} bytes)`);

let t = 0;
const dt = 1 / fps;
for (let fi = 1; fi <= nFrames; fi++) {
  const frame = raw.subarray((fi - 1) * frameLen, fi * frameLen);
  t += dt;
  pipeline.step({
    frame, width: vw, height: vh, timestamp_s: t, frame_index: fi,
    ground_truth: null, // external recording: no ground truth exists
    pan_deg: camera.pan_deg, tilt_deg: camera.tilt_deg,
  });
}
void proc.exited;

const r = pipeline.getMetrics().finalize('demo7-mp4');
console.log('\nState transitions:');
for (const tr of transitions) console.log('  ' + tr);
console.log('\nReference-free results (NO ground truth fabrication — docs/08 §4):');
console.log(`  frames processed      : ${r.frames_processed}`);
console.log(`  detection rate        : ${r.detection_rate_percent?.toFixed(1)} %`);
console.log(`  track continuity      : ${r.track_continuity_frames} frames`);
console.log(`  reacquisition events  : ${r.reacquisition_events}`);
console.log(`  avg confidence        : ${r.avg_detection_confidence?.toFixed(3)}`);
console.log(`  algorithm FPS         : ${r.fps_measured.toFixed(0)}   (gate >= 20)`);
console.log(`  detector latency avg  : ${r.detector_latency_avg_ms?.toFixed(3)} ms`);
console.log(`  final virtual pose    : pan ${camera.pan_deg.toFixed(3)}°, tilt ${camera.tilt_deg.toFixed(3)}° (logged only — recorded pixels cannot move)`);
console.log(`  pass_fail             : ${JSON.stringify(r.pass_fail)} (null = ref-free by policy, NOT a failure)`);
const ok =
  (r.detection_rate_percent ?? 0) >= 99 &&
  r.fps_measured >= 20 &&
  (r.track_continuity_frames ?? 0) >= nFrames * 0.95;
console.log(`\nRESULT: MP4 ingestion + perception pipeline OK = ${ok}`);
process.exit(ok ? 0 : 1);
