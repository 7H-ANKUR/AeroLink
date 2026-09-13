# 04 — System Architecture

## 1. Purpose

Engineering source of truth between the PRD and implementation: components, data flow, state machine, control-loop math, threading model, and fault handling. This revision corrects two issues found in the original design pass (marked **[FIX]** below) and documents two previously-implicit behaviors (marked **[NEW]**).

## 2. Core Concept — Two Worlds

```text
GROUND TRUTH                         OBSERVATION
Beacon true position                 Disturbed image
       │                                  │
       ▼                                  ▼
Scene simulator ──────────────────▶ Virtual camera
       │                                  │
       │                                  ▼
       └───────────────────────▶ Detector
                                       │
                                       ▼
                                   Estimate
                                       │
                                 Tracker / Predictor
                                       │
                                 Control output
                                       │
                                 Camera update ──▶ next frame
```

The Metrics Engine has a direct branch from the simulator to ground truth. The algorithm under test (detector/tracker/controller) never receives ground truth.

## 3. System Context

```text
User/Judge → Main GUI
                │
      ┌─────────┴─────────┐
      ▼                    ▼
Simulation Mode       Video Input Mode
Scene+Beacon+Camera    External MP4
      └─────────┬─────────┘
                 ▼
          Frame Ingestion (FrameSource)
                 ▼
             Preprocessing
                 ▼
        Beacon Detection (CV + optional AI)
                 ▼
      Centroid / Position / Confidence
                 ▼
         Tracker / Predictor (Kalman)
                 ▼
        Coarse Controller (Pan/Tilt)
                 ▼
            Virtual Camera ─── feedback loop

                 Metrics & Reporting (parallel branch, fed by ground truth + pipeline outputs)
```

## 4. Major Components

### 4.1 Application Shell
Start/stop, mode selection, scenario load/save, module selection, experiment lifecycle, status/error display, report export trigger.

### 4.2 Configuration Manager
Validated config object; see `05-database-schema.md` for persisted schema and `06-api-contracts.md` for the in-memory `ScenarioConfig` contract. Labels every value as **PS-official default** or **implementation choice**.

### 4.3 Simulation Engine
Scene renderer, coordinate system, beacon generator, target motion generator, camera pose model, disturbance model, frame composer.

### 4.4 Target / Beacon Engine
Emits `GroundTruthTarget {id, x_px, y_px, vx_px_s, vy_px_s, visible, intensity}` every frame. Required motions: straight, circular, figure-8, random. Optional: spiral, sinusoidal, user-defined.

### 4.5 Virtual Camera
Maintains pose, applies pan/tilt commands, enforces max speed, crops/renders FOV, produces frames at the configured update rate (≥30 Hz default).

### 4.6 Disturbance & Sensor Model
Image noise (salt-and-pepper, Gaussian, Poisson), camera jitter (±20 px/frame max), atmospheric presets (clear/haze/fog/rain/low-light), platform motion (linear mandatory, others optional, ±20 px/frame max). Composable — multiple effects can run simultaneously. Never mutates the stored clean ground truth.

### 4.7 Frame Ingestion Abstraction
```text
FrameSource
  start()
  read() -> FramePacket | EOF
  stop()
  metadata() -> SourceMetadata
```
Implementations: `SimulationFrameSource`, `VideoFileFrameSource`, optional `WebcamFrameSource` (dev only). The detector is agnostic to the source.

### 4.8 Preprocessing
`frame → grayscale/channel select → optional denoise → optional normalize → threshold/enhance → candidate map`. Configurable; never touches the ground-truth path.

### 4.9 Beacon Detection

**Classical detector:** grayscale → noise suppression → threshold → morphology → connected components → candidate filters (area, aspect ratio, brightness, compactness, optional temporal proximity) → centroid → confidence.

**AI detector (optional, Tier 3):** same output schema as classical. Must not be a single point of failure — classical path remains fully operational without it.

**[NEW] Multi-target / designated-beacon selection.** When more than one candidate passes filtering (multiple beacons, or a beacon plus a distractor), the system applies a deterministic selection policy before handing a single detection to the tracker:
1. If a track is already active, prefer the candidate nearest to the Kalman-predicted position (gated by a max-distance threshold).
2. If no track is active (SEARCH/CANDIDATE), prefer the highest composite score (`brightness × size × shape × temporal`).
3. Once a track is confirmed, its identity is sticky — a new brighter candidate elsewhere does **not** steal the lock unless the current track is lost.
This policy is configuration-exposed (`tracking.selection_policy`) and must be documented in the technical report, since "multiple beacons" is an explicit optional PS scenario.

**Fusion (classical + AI, Tier 3):** candidate matching by proximity/confidence; retains provenance (`method` field) for reporting.

Detection output:
```json
{"found": true, "x": 312.4, "y": 228.9, "confidence": 0.97, "bbox": [307,224,10,10], "method": "cv", "latency_ms": 3.7}
```

### 4.10 Centroid Estimation
```text
cx = Σ(w_i * x_i) / Σ(w_i)
cy = Σ(w_i * y_i) / Σ(w_i)
```
`w_i` = pixel intensity after background normalization. If the chosen algorithm instead uses a bounding-box center, that substitution must be explicitly stated in the report — the PS evaluates "centroiding error" specifically, so the two methods are not interchangeable without disclosure.

```text
centroid_error_px = sqrt((x_measured - x_gt)^2 + (y_measured - y_gt)^2)
```

### 4.11 Tracker / Predictor — Kalman Filter
State: `x = [px, py, vx, vy]ᵀ`, constant-velocity model.
```text
Prediction:      x_k|k-1 = F x_k-1|k-1 ;  P_k|k-1 = F P Fᵀ + Q
Measurement upd: z_k = H x_k + v   (when a detection exists)
```
Configurable process/measurement covariance. Track confidence combines detector confidence, consecutive-detection count, prediction age, and residual magnitude. Outputs: filtered position, predicted position, confidence, track age, lost-frame count.

### 4.12 State Machine

```text
SEARCH ──candidate detected──▶ CANDIDATE
CANDIDATE ──stable detection──▶ ACQUIRE
CANDIDATE ──confirmation fails (M frames)──▶ SEARCH        [FIX: explicit disconfirmation path]
ACQUIRE ──confirmation──▶ TRACK
TRACK ──temporary loss──▶ PREDICT/REACQUIRE
PREDICT/REACQUIRE ──recovered──▶ TRACK
PREDICT/REACQUIRE ──failed──▶ SEARCH
```

- **SEARCH:** camera runs a configurable scan strategy (left↔right sweep with vertical stepping by default; spiral/raster/sector-sweep optional). No lock reported.
- **CANDIDATE:** possible beacon seen; temporal confirmation window open. **[FIX]** If confirmation fails for `M` consecutive frames (configurable, distinct from the N-frame confirm count), the state reverts to `SEARCH` rather than hanging indefinitely — this was previously implied but undrawn.
- **ACQUIRE:** consecutive confirmations validated across frames; acquisition timestamp recorded here (at confirmed acquisition, not at first detection).
- **TRACK:** tracker estimate drives the controller.
- **PREDICT/REACQUIRE:** tiered reacquisition — (1) short-term Kalman prediction, (2) local scan around predicted point, (3) global scan (deterministic sweep) if local fails. Reacquisition time is logged from loss confirmation to recovery.

### 4.13 Coarse Camera Controller — **[FIX] Corrected unit handling**

Previous drafts fed raw pixel error directly into a PID whose output was `pan_deg_s`/`tilt_deg_s`, which implicitly folds a pixel→degree scale factor into `Kp` and makes gains brittle to any change in FOV or resolution. Corrected loop:

```text
1. Image error (pixels):
   ex = target_x - frame_center_x
   ey = target_y - frame_center_y

2. Convert to angular error BEFORE the PID:
   angle_x = (ex / image_width)  * FOV_x_deg
   angle_y = (ey / image_height) * FOV_y_deg

3. PID runs in angle-error space, per axis:
   u(t) = Kp*angle(t) + Ki*∫angle(t)dt + Kd*d(angle)/dt

4. Output is directly a rate command in deg/s (no further scaling needed):
   PanTiltCommand { pan_deg_s, tilt_deg_s }
```

Required safety behavior: output saturation at max pan/tilt speed, integral clamping (anti-windup), deadband around center, integrator reset on entry to SEARCH/ACQUIRE, optional derivative low-pass filter, dt=0 handled explicitly (skip update, do not divide).

Pixel error is still logged and reported (the PS threshold is stated in pixels), but it is no longer the PID's operating variable.

### 4.14 Reacquisition
Same as §4.12 tiered strategy. Scan speed is bounded by configured pan/tilt speed limits.

### 4.15 Metrics Engine
Required: simulation duration, FPS (measured, not configured), acquisition time, avg/max tracking error, RMSE, target-loss %, lock retention %, reacquisition time, processing time. Additional: p95/p99 error, detection confidence, detector/controller latency, reacquisition event count, frames processed/dropped. Definitions and pass/fail logic are centralized in `08-scoring-engine-spec.md`.

### 4.16 Report Generator
Exports CSV metrics, JSON raw events, human-readable summary, optional charts. Stores scenario config, seed, software version, and module selection for reproducibility. Schema: `05-database-schema.md` / `06-api-contracts.md`.

### 4.17 GUI / Visualization
See `03-information-architecture.md` for the full screen inventory.

## 5. Data Flow

```text
Scenario config → scene init → target trajectory → camera pose → clean scene
  → disturbances → camera frame → preprocessing → detection → centroid
  → tracking/prediction → error calc (px→angle) → control command
  → camera pose update → next frame
```
Ground truth branches directly from the simulator to the Metrics Engine — never through the detector.

## 6. Threading Model — **[NEW]**

```text
UI Thread            Simulation/Video Thread        Report Worker Thread
  │                          │                             │
  │  config, controls   ◀────┼── Qt signal (queued) ───────┤
  │  plots/status       ◀────┤   FramePacket, Detection,    │
  │                          │   TrackState, Metrics snapshot│
  └──────────────────────────┴─────────────────────────────┘
```

- The processing loop (FrameSource → detection → tracking → control → metrics) **must never run on the UI thread** — this was previously only stated as a rule ("do not block the GUI thread") without a mechanism.
- All cross-thread communication uses Qt signals/slots with **queued connections**; no shared mutable object (e.g. the live `TrackState`) is read directly from the UI thread while the worker thread may be writing it. Emit immutable snapshots (copies), not references to live objects.
- The Report Worker runs on its own thread/executor so CSV/JSON/chart export never stalls the live view.

## 7. Performance-Critical Design
- Avoid unnecessary frame copies; keep the AI model lightweight; use bounded queues between threads (drop-oldest policy under backpressure, logged as `frames_dropped`); detector/GUI update frequencies may differ; log asynchronously; expose **measured** FPS.

## 8. Fault Handling
Must handle: invalid/corrupt video files, detector exceptions, temporary target loss, out-of-range configuration (blocked at validation, §9), insufficient CPU/GPU resources, model load failure, report-write failure. UI surfaces a specific message; nothing fails silently.

## 9. Configuration Validation
Validate before allowing Start: FOV > 0, FPS > 0, target size > 0, target count ≥ 1, non-negative speed bounds, noise parameters in valid ranges, scene dimensions large enough to contain the configured target and its motion envelope.

## 10. Video-Benchmark Design (Mode B)
```text
MP4 → Decoder → Frame timestamp → Preprocessing → Detector → Tracker
  → metrics (only if a ground-truth reference exists) → controller output (for logging/demo only)
```
If no reference exists, the pipeline still runs (for demo purposes and reference-free metrics) but the Results screen and report must state plainly that error/RMSE could not be computed — never fabricate ground truth (see `08-scoring-engine-spec.md` for the exact fallback metric set).

## 11. Packaging Architecture
Standalone executable + runtime libraries + optional model file(s) + default scenarios + sample video + sample report + user manual. No internet required for core operation. Full build/test process: `11-environment-and-devops.md`.

## 12. Architecture Decision Summary

| Decision | Choice | Reason |
|---|---|---|
| Language | Python 3.11+ | Fast CV/simulation development |
| GUI | PySide6 | Native desktop, signal/slot threading model |
| CV | OpenCV | Mature real-time processing |
| Numerics | NumPy/SciPy | Deterministic, fast |
| AI (optional) | PyTorch (train) / ONNX Runtime (deploy) | CPU-capable inference, avoids GPU dependency |
| Tracking | Kalman filter | Robust, explainable short-term prediction |
| Control | PID (angle-space, see §4.13) | Simple, benchmarkable |
| Local data | SQLite + CSV/JSON | See `05-database-schema.md` |
| Packaging | PyInstaller | Standalone executable |

## 13. Requirement Traceability

| Requirement | Component |
|---|---|
| Configurable virtual environment | Simulation Engine + Config Manager |
| Moving targets | Beacon/Target Engine |
| Movable virtual camera | Virtual Camera + Controller |
| Automatic beacon detection | Detection Module |
| Continuous CV tracking | Tracker |
| Camera repositioning | Coarse Controller |
| Disturbances | Disturbance/Sensor Model |
| Real-time statistics | Metrics Engine + GUI |
| Standalone application | Packaging layer |
| Performance report | Report Generator |
| External 30-FPS MP4 evaluation | Frame Ingestion abstraction |
