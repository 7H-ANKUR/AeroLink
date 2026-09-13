# MVP Tech Doc.md

# MVP Technical Document
## AI-Assisted Virtual Camera Tracking System for Coarse Alignment of Mobile FSOC Terminals

## 1. Technical Objective

Implement a working, testable and extensible desktop application that demonstrates coarse visual alignment of a moving optical beacon using a software virtual camera.

The MVP deliberately separates **world truth**, **camera observation**, **perception**, **tracking**, **control**, and **evaluation**. This makes the system easy to test and avoids accidentally using simulator truth inside the tracking algorithm.

## 2. Recommended Stack

| Layer | Technology |
|---|---|
| Language | Python 3.11+ (recommended) |
| GUI | PySide6 |
| Computer vision | OpenCV |
| Numerical computation | NumPy, SciPy |
| AI | PyTorch for experimentation; ONNX Runtime for optional packaged inference |
| Video | OpenCV/FFmpeg-backed reader |
| Charts | Matplotlib |
| Data | Pandas |
| Configuration | YAML or JSON |
| Testing | Pytest |
| Packaging | PyInstaller |
| Versioning | Git |

For the first implementation, avoid introducing a heavy 3D engine unless the visual requirements prove that it is necessary. A deterministic 2D image-space simulation is sufficient to implement and validate the coarse tracking control loop described in the PS.

## 3. Runtime Architecture

```text
UI Thread
  |
  +-- configuration
  +-- controls
  +-- plots/status

Simulation / Video Thread
  |
  +-- FrameSource
  +-- preprocessing
  +-- detection
  +-- tracking
  +-- control
  +-- metrics

Report Worker
  |
  +-- CSV/JSON
  +-- charts
  +-- summary
```

Do not block the GUI thread with the frame-processing loop.

## 4. Core Interfaces

### 4.1 FrameSource

```python
class FrameSource(Protocol):
    def start(self) -> None: ...
    def read(self) -> FramePacket | None: ...
    def stop(self) -> None: ...
```

### 4.2 Detector

```python
class Detector(Protocol):
    def detect(self, frame: np.ndarray) -> Detection: ...
```

### 4.3 Tracker

```python
class Tracker(Protocol):
    def update(self, detection: Detection | None, timestamp_s: float) -> TrackState: ...
```

### 4.4 Controller

```python
class Controller(Protocol):
    def compute(self, target_xy, center_xy, dt_s) -> PanTiltCommand: ...
```

### 4.5 Disturbance Model

```python
class DisturbanceModel(Protocol):
    def apply(self, frame, state, rng) -> np.ndarray: ...
```

## 5. Coordinate Systems

Maintain explicit coordinate systems to prevent common bugs.

### Scene coordinates

World/simulation coordinates used to generate the target.

### Camera angular coordinates

Virtual camera pan/tilt pose in degrees.

### Image coordinates

Pixel coordinates `(x, y)` in the camera frame.

### Ground truth

Known image-space beacon center computed by the simulator before noise.

Never mix coordinate spaces without an explicit conversion.

## 6. Camera Model

Minimum MVP model: perspective-like image-space viewport.

Given a camera horizontal FOV and image width, the mapping can approximate angular displacement as:

```text
angle_x ≈ (x - cx) / width * FOV_x
angle_y ≈ (y - cy) / height * FOV_y
```

Use a more formal projection model if the implementation becomes 3D.

The PS default FOV is 4° x 3°.

## 7. Virtual Scene MVP

The scene can initially be a high-resolution canvas with:

- neutral background;
- beacon spot;
- optional distractor spots;
- atmospheric overlays;
- camera viewport.

A minimum screen size of 2000 x 2000 pixels is suggested by the PS, while the camera feed itself can be 640 x 480 by default.

## 8. Target Generator

### Beacon

Represent the beacon as a high-intensity spot. The PS default shape is a square with default size 10 x 10 pixels; make shape and size configurable.

### Motion equations

#### Straight line

```text
x(t) = x0 + vx * t
y(t) = y0 + vy * t
```

Bounce or wrap behavior must be configurable when the target reaches scene bounds.

#### Circular

```text
x(t) = cx + r cos(wt + phi)
y(t) = cy + r sin(wt + phi)
```

#### Figure 8

A simple Lissajous-style trajectory:

```text
x(t) = cx + A sin(wt)
y(t) = cy + B sin(2wt + phi)
```

#### Random

Use bounded random motion with smoothed velocity so the trajectory is not unrealistic frame-to-frame pixel teleportation.

Optional:

- spiral;
- sinusoidal;
- user-defined trajectory callback/script.

## 9. Disturbance Model

### 9.1 Salt-and-pepper noise

Randomly flip a configurable fraction of pixels. The PS suggests around 10% of the image as one selectable noise option.

### 9.2 Gaussian noise

Add zero-mean Gaussian noise. Expose standard deviation, with 20 pixels as the suggested maximum in the PS.

### 9.3 Poisson noise

Use intensity-dependent shot-noise approximation.

### 9.4 Camera jitter

Apply image-space or camera-pose displacement, up to the suggested ±20 pixels/frame.

### 9.5 Atmospheric conditions

Implement presets:

- Clear: baseline.
- Haze: moderate contrast loss.
- Fog: stronger contrast and visibility loss.
- Rain: streak/noise overlays plus contrast effects.
- Low light: reduced brightness and contrast.

The source specifies these conditions as user-selectable reductions in contrast and brightness rather than a precise physical atmospheric model, so an MVP should make the effects configurable and document that they are simulation approximations.

### 9.6 Platform motion

Implement:

- linear mandatory/default;
- circular optional;
- random optional;
- spiral optional;
- figure 8 optional.

Limit displacement according to the source parameter.

## 10. Detection Pipeline

### Baseline CV Detector

```text
Frame
 -> grayscale / intensity channel
 -> denoise
 -> adaptive/global threshold
 -> connected components
 -> candidate filtering
 -> centroid
 -> confidence
```

Candidate scoring can use:

```text
score =
  w_brightness * brightness_score +
  w_size       * size_score +
  w_shape      * shape_score +
  w_temporal   * temporal_score
```

The exact weights should be configuration data, not hard-coded magic numbers.

### AI Detector

Optional model can take the frame or ROI and produce a beacon bounding box/center.

Recommended packaging approach:

```text
Training/experimentation:
  PyTorch

Deployment:
  ONNX Runtime or TorchScript
```

Synthetic data can be generated for model development because the official PS does not provide a mandatory dataset.

## 11. Hybrid Detection

For robustness, merge classical and AI detections.

```text
CV candidate ----+
                 |
                 +--> Fusion --> selected detection
                 |
AI candidate ----+
```

Fusion must retain provenance so the report can say which detector provided the final measurement.

## 12. Tracking / Kalman Filter

Recommended state:

```text
x_k = [px, py, vx, vy]^T
```

State transition for constant velocity:

```text
F = [[1,0,dt,0],
     [0,1,0,dt],
     [0,0,1, 0],
     [0,0,0, 1]]
```

The tracker should support:

- measurement update when detection exists;
- prediction-only mode during brief loss;
- confidence decay;
- reset after long loss.

## 13. Acquisition Logic

A single bright pixel should not immediately be considered acquired.

Suggested MVP acquisition rule:

1. Candidate detected.
2. Candidate passes size/brightness/confidence checks.
3. Same/nearby target confirmed for N consecutive frames.
4. Acquisition timestamp is stored.
5. Tracking state becomes `TRACK`.

N should be configurable.

## 14. Control Logic

Target error:

```text
ex = target_x - cx
 ey = target_y - cy
```

PID independently on each axis:

```text
u = Kp*e + Ki*integral(e) + Kd*derivative(e)
```

Required safety behavior:

- output saturation;
- anti-windup;
- deadband;
- maximum pan/tilt speed;
- optional acceleration/rate limits.

The controller must output commands at the configured update interval and should be capable of running at >=20 Hz.

## 15. Camera Update Loop

A single frame cycle is:

```text
1. Get target ground truth (simulation only)
2. Render scene
3. Apply platform/camera motion
4. Apply sensor/atmospheric disturbances
5. Produce camera frame
6. Detect
7. Track/predict
8. Compute control error
9. Generate pan/tilt command
10. Update virtual camera pose
11. Compute metrics
12. Send UI snapshot
13. Continue
```

## 16. Video Benchmark Loop

For external MP4:

```text
Read frame
 -> timestamp from FPS / frame index
 -> preprocessing
 -> detector
 -> tracker
 -> metrics
 -> optional control output
```

The software should not assume that a supplied video provides ground truth. When the benchmark video has no ground-truth annotation, centroiding error can only be computed if an annotation source or predefined reference is available. The benchmark adapter must therefore support:

- known ground truth;
- manual annotation;
- externally supplied annotation file.

Do not fabricate ground truth.

## 17. Metrics Implementation

### Running metrics

Keep streaming accumulators for:

- frame count;
- processing time sum;
- error sum;
- squared error sum;
- max error;
- detected frames;
- locked frames;
- lost frames;
- acquisition timestamp;
- reacquisition timestamps.

### Error

```python
error_px = np.hypot(x_est - x_gt, y_est - y_gt)
```

### RMSE

```python
rmse_px = np.sqrt(np.mean(np.square(errors)))
```

### Lock retention

```python
lock_rate = 100.0 * locked_frames / eligible_frames
```

Metrics must clearly define whether predicted frames count toward lock retention and expose that policy in the report.

## 18. Data Model

Suggested `RunResult`:

```json
{
  "run_id": "2026-09-13T12:00:00Z-001",
  "mode": "simulation",
  "duration_s": 60.0,
  "fps": 48.4,
  "acquisition_time_s": 1.12,
  "avg_error_px": 4.21,
  "max_error_px": 14.8,
  "rmse_px": 5.63,
  "target_loss_percent": 2.3,
  "lock_retention_percent": 97.1,
  "reacquisition_avg_s": 0.54,
  "processing_avg_ms": 7.2,
  "scenario_seed": 42
}
```

## 19. Logging Format

CSV event fields:

```text
timestamp,
frame_index,
source_mode,
gt_x,gt_y,
detected_x,detected_y,
predicted_x,predicted_y,
confidence,
tracking_state,
pan_deg,tilt_deg,
pan_command,tilt_command,
error_px,
processing_ms,
locked,
lost
```

This provides enough information to recreate plots and investigate failures.

## 20. Testing Strategy

### Unit tests

- trajectory equations;
- camera projection;
- noise generation;
- detector candidate filtering;
- centroid calculation;
- Kalman prediction;
- PID controller;
- metric calculations;
- configuration validation.

### Integration tests

- target -> camera -> detector;
- detector -> tracker -> controller;
- target loss -> prediction -> reacquisition;
- simulator -> logger -> report.

### Scenario tests

At minimum:

1. Straight motion / clear.
2. Circular / clear.
3. Figure 8 / clear.
4. Random / clear.
5. Straight + Gaussian noise.
6. Straight + salt-and-pepper.
7. Straight + Poisson.
8. Motion + jitter.
9. Haze/fog/rain/low light.
10. Platform motion + target motion.
11. Temporary beacon loss.
12. High combined-disturbance stress case.

## 21. Benchmark Gates

Before calling the MVP ready, run repeated seeds and record distributions rather than a single best run.

Suggested internal gate:

- acquisition <= 2 s on a defined set of normal scenarios;
- tracking error <= 10 px on benchmark scenarios where the specification is applicable;
- target loss < 5%;
- reacquisition <= 1 s;
- processing >= 20 FPS.

The report should state exactly which scenarios pass/fail instead of claiming universal compliance from one run.

## 22. Tuning Strategy

Tune in this order:

1. Detection on clean images.
2. Centroid accuracy.
3. Tracking filter.
4. Controller on clean motion.
5. Noise robustness.
6. Platform/camera motion.
7. Reacquisition.
8. AI/hybrid improvements.

Do not simultaneously tune all parameters; that makes failure diagnosis difficult.

## 23. Repository Structure

```text
fsoc-pat/
├── app/
│   ├── main.py
│   └── version.py
├── config/
│   ├── default.yaml
│   └── schemas.py
├── simulator/
│   ├── scene.py
│   ├── beacon.py
│   ├── trajectories.py
│   ├── camera.py
│   └── disturbances.py
├── io/
│   ├── base.py
│   ├── simulation_source.py
│   └── video_source.py
├── detection/
│   ├── base.py
│   ├── cv_detector.py
│   ├── ai_detector.py
│   └── fusion.py
├── tracking/
│   ├── kalman.py
│   └── state_machine.py
├── control/
│   ├── pid.py
│   └── pan_tilt.py
├── evaluation/
│   ├── metrics.py
│   ├── events.py
│   └── reports.py
├── gui/
│   ├── main_window.py
│   ├── camera_view.py
│   ├── dashboard.py
│   └── config_panel.py
├── tests/
├── scenarios/
├── samples/
├── exports/
└── docs/
```

## 24. Build Phases

### Phase 1

Simulation canvas + moving beacon + virtual camera.

### Phase 2

Classical detector + centroid logging.

### Phase 3

Kalman tracker + acquisition/loss state machine.

### Phase 4

PID camera control + closed loop.

### Phase 5

Disturbance/noise engine.

### Phase 6

Performance dashboard + reports.

### Phase 7

External MP4 input mode.

### Phase 8

AI detector + fusion.

### Phase 9

Hardening, packaging, documentation and benchmark automation.

## 25. Development Dataset Strategy

Because the source PS does not provide a mandatory dataset, generate synthetic training/test data using the same simulator.

Recommended generated dataset dimensions:

- multiple beacon sizes;
- random initial positions;
- all required motion types;
- varying brightness;
- all noise modes;
- atmospheric presets;
- camera jitter;
- platform motion;
- distractor bright spots;
- temporary occlusion/loss.

Split by **scenario/seed**, not random adjacent frames, so train and test sets do not contain nearly identical frames.

Use external laser-spot datasets only as supplementary research/development material; do not assume they match the SIH benchmark format.

## 26. Standalone Packaging Checklist

- build executable;
- include configuration defaults;
- include sample scenarios;
- include sample MP4;
- include model files if used;
- test on clean machine;
- verify no source checkout is required;
- verify output folder permissions;
- verify report export.

## 27. MVP Technical Risks

### Risk: synthetic detector looks unrealistically easy

Mitigation: add distractor spots, realistic blur, changing brightness, noise and motion.

### Risk: control looks good but detector is weak

Mitigation: evaluate perception and control separately.

### Risk: external benchmark differs from simulator

Mitigation: make detector/tracker independent of simulator implementation and test against standalone MP4 input early.

### Risk: GPU dependency hurts deployment

Mitigation: keep CPU-capable classical mode and package AI as optional/optimized inference.

## 28. Final MVP Definition

The MVP is complete when an operator can:

1. launch the executable;
2. choose a predefined or custom scenario;
3. generate a moving beacon;
4. view the camera feed;
5. see the beacon automatically detected;
6. watch the virtual camera track it;
7. add noise/disturbances;
8. observe target loss/reacquisition;
9. load an MP4 benchmark video;
10. review quantitative metrics;
11. export the performance log.
