# Architecture.md

# AI-Assisted Virtual Camera Tracking System for Coarse Alignment of Mobile FSOC Terminals

## 1. Document Purpose

This document defines the complete software architecture for the SIH 2026 Problem Statement 169 / source document titled **“Development of an AI-Based Virtual Camera Tracking System for Coarse Alignment of Mobile Free Space Optical Communication (FSOC) Terminals.”**

The architecture is designed around the official requirement that the software autonomously detects, identifies, and continuously tracks a designated moving target in a virtual scene by controlling a virtual camera viewport. The system must also support disturbance simulation, real-time statistics, standalone execution, source code, technical documentation, a user manual, and automatically generated performance logs.

> **Important source interpretation:** The official PDF says the dataset link is NA, while the portal's “Dataset Link” field points to the additional-information PDF. The evaluation section separately states that evaluators may provide 30-FPS MP4 benchmark videos. Therefore, the product should not depend on a pre-supplied training dataset.

## 2. Problem in One Paragraph

A mobile FSOC terminal uses a highly directional optical beam. Before fine pointing can take over, a transmitting terminal needs to locate the remote terminal or its optical beacon inside the camera Field-of-View (FOV), estimate the beacon location, and continuously adjust pointing direction to retain visibility. The proposed software replaces expensive real optical hardware with a virtual environment and virtual camera, while also allowing benchmark video files to be fed into the same coarse-pointing pipeline.

## 3. Architectural Goals

### Primary goals

1. Build a configurable virtual scene containing a moving optical beacon.
2. Simulate a virtual camera with controllable pan and tilt.
3. Produce a video stream that resembles the camera input.
4. Detect the beacon automatically.
5. Estimate beacon centroid/position and confidence.
6. Track the beacon over time.
7. Control the virtual camera to keep the beacon visible and near the desired image location.
8. Handle target loss and perform reacquisition.
9. Inject configurable disturbances and noise.
10. Measure and log all benchmark metrics.
11. Accept both generated simulation frames and external MP4 benchmark videos.
12. Package the system as a standalone executable.

### Secondary goals

- Compare classical computer-vision tracking with AI-assisted tracking.
- Keep the detector/control pipeline modular so different algorithms can be swapped.
- Provide reproducible experiments using saved scenario configurations and seeds.
- Provide replay and post-run analysis.

## 4. Non-Goals

The MVP does **not** require:

- physical laser hardware;
- physical PTZ hardware;
- a real UAV or satellite flight-control system;
- real optical communication data transmission;
- fine-pointing hardware control;
- a mandatory external machine-learning dataset;
- a claim of direct physical-system certification.

The source PS is explicitly software-focused and calls for a virtual camera tracking system.

## 5. System Context

```text
                 +----------------------+
                 |       User / Judge   |
                 +----------+-----------+
                            |
                            v
                 +----------------------+
                 |       Main GUI        |
                 +----------+-----------+
                            |
          +-----------------+------------------+
          |                                    |
          v                                    v
+---------------------+              +---------------------+
| Simulation Mode     |              | Video Input Mode    |
| Scene + Beacon      |              | External MP4        |
| Camera + Disturb.   |              | 30 FPS benchmark    |
+----------+----------+              +----------+----------+
           |                                    |
           +----------------+-------------------+
                            v
                 +----------------------+
                 | Frame Ingestion      |
                 +----------+-----------+
                            v
                 +----------------------+
                 | Preprocessing        |
                 +----------+-----------+
                            v
                 +----------------------+
                 | Beacon Detection     |
                 | CV + optional AI     |
                 +----------+-----------+
                            v
                 +----------------------+
                 | Centroid / Position  |
                 | Confidence / Status   |
                 +----------+-----------+
                            v
                 +----------------------+
                 | Tracker / Predictor  |
                 | Kalman / Motion      |
                 +----------+-----------+
                            v
                 +----------------------+
                 | Coarse Controller    |
                 | Pan / Tilt            |
                 +----------+-----------+
                            v
                 +----------------------+
                 | Virtual Camera       |
                 +----------+-----------+
                            |
                            +------ feedback loop

                 +----------------------+
                 | Metrics & Reporting   |
                 | CSV / JSON / Report   |
                 +----------------------+
```

## 6. Major Components

### 6.1 Application Shell

Responsibilities:

- Start/stop simulation.
- Select input mode.
- Load/save scenario configurations.
- Select detector/tracker/controller.
- Manage experiment lifecycle.
- Display status and errors.
- Trigger report export.

### 6.2 Configuration Manager

Stores all user-configurable parameters in a validated configuration object.

Suggested top-level configuration:

```yaml
application:
  mode: simulation   # simulation | video
  random_seed: 42
  logging_level: INFO

camera:
  screen_width: 2000
  screen_height: 2000
  resolution_width: 640
  resolution_height: 480
  monochrome: true
  horizontal_fov_deg: 4.0
  vertical_fov_deg: 3.0
  update_hz: 30
  max_pan_speed_deg_s: 5.0
  max_tilt_speed_deg_s: 5.0

beacon:
  count: 1
  shape: square
  size_px: 10
  initial_location: random
  motion: straight

tracking:
  detector: hybrid
  predictor: kalman
  controller: pid
  lock_radius_px: 10
  acquisition_confirm_frames: 3
  lost_timeout_frames: 5

noise:
  salt_pepper_percent: 10
  gaussian_sigma_px: 20
  poisson_enabled: true
  jitter_px_per_frame: 20

atmosphere:
  mode: clear
  contrast_factor: 1.0
  brightness_factor: 1.0

platform_motion:
  mode: linear
  max_px_per_frame: 20
```

Values above are recommended implementation defaults derived from the source specification where applicable; the product must label which values are official suggested/default values and which are implementation choices.

### 6.3 Simulation Engine

Generates a synthetic scene and updates it frame-by-frame.

Submodules:

- Scene renderer.
- Coordinate system.
- Beacon generator.
- Target motion generator.
- Camera pose model.
- Disturbance model.
- Frame composer.

### 6.4 Target / Beacon Engine

The official specification identifies the target type as **Beacon Spot**, with one target mandatory and multiple targets optional. The default target shape is square, with a user-defined size and a suggested/default size of 10 x 10 pixels.

Motion modes required by the PS:

- Straight line.
- Circular.
- Figure of 8.
- Random.

Optional motion modes:

- Spiral.
- Sinusoidal.
- User-defined.

The target engine should output, every simulation frame:

```text
GroundTruthTarget {
    id
    x_px
    y_px
    vx_px_s
    vy_px_s
    visible
    intensity
}
```

Ground truth is essential for calculating benchmark errors even though it is not shown to the detector.

### 6.5 Virtual Camera

The virtual camera represents the viewport used for coarse pointing.

Responsibilities:

- Maintain camera pose.
- Apply pan/tilt commands.
- Enforce maximum pan/tilt speeds.
- Render/crop the scene into the camera FOV.
- Produce frames at the configured update rate.

Required/source values include a default FOV of 4° x 3°, minimum 30 Hz camera update rate, and user-defined FOV.

### 6.6 Disturbance and Sensor Model

A dedicated layer creates realistic failure conditions without changing the clean ground truth target state.

Supported disturbance groups:

1. Image noise: salt-and-pepper, Gaussian, Poisson.
2. Camera jitter: maximum ±20 pixels/frame suggested.
3. Atmospheric conditions: clear, haze, fog, rain, low light.
4. Platform motion: up to ±20 pixels/frame maximum suggested, with linear as mandatory/default and circular/random/spiral/figure-8 as optional.

The disturbance layer should be composable so multiple effects can be enabled together.

### 6.7 Frame Ingestion Abstraction

The detector must not care whether frames come from the simulator or an external MP4.

Interface:

```text
FrameSource
  start()
  read() -> FramePacket | EOF
  stop()
  metadata() -> SourceMetadata
```

Implementations:

- `SimulationFrameSource`.
- `VideoFileFrameSource`.
- Optional `WebcamFrameSource` for development only.

This directly supports the PS benchmark requirement in which evaluators may provide MP4 files at 30 FPS.

### 6.8 Preprocessing

Suggested pipeline:

```text
Input frame
  -> grayscale / channel selection
  -> optional denoising
  -> optional normalization
  -> threshold / enhancement
  -> candidate map
```

Preprocessing should be configurable and must not alter the ground-truth path.

### 6.9 Beacon Detection

Two interchangeable detector families should be supported.

#### Classical detector

Possible stages:

- intensity thresholding;
- connected components;
- contour/area filtering;
- brightness filtering;
- shape filtering;
- candidate scoring.

#### AI-assisted detector

A lightweight object/spot detector may be used where training data is available from synthetic generation or a separately curated dataset. Because the official PS provides no mandatory dataset, the architecture must not assume a specific external model.

Recommended product behavior:

```text
             frame
               |
       +-------+-------+
       |               |
   CV detector      AI detector
       |               |
       +-------+-------+
               |
        score fusion
               |
        best candidate
```

The detector output should include:

```text
Detection {
    found: bool
    x_px
    y_px
    bbox
    confidence
    method
    processing_ms
}
```

### 6.10 Centroid Estimation

The source evaluation specifically mentions logging **centroiding error**. Therefore, the system should distinguish between:

- ground-truth beacon center;
- measured beacon center;
- predicted target center.

For a measured center `(xm, ym)` and ground truth `(xg, yg)`:

```text
centroid_error_px = sqrt((xm-xg)^2 + (ym-yg)^2)
```

### 6.11 Tracker / Predictor

The tracker stabilizes detections across frames and provides short-term prediction when detections are noisy or temporarily missing.

Recommended default:

- Kalman filter with position and velocity state.

Conceptual state:

```text
x = [position_x, position_y, velocity_x, velocity_y]^T
```

Inputs:

- measured beacon center;
- detection confidence;
- frame interval.

Outputs:

- filtered target location;
- predicted target location;
- track confidence;
- track age;
- lost-frame count.

### 6.12 State Machine

The tracking system should explicitly manage states:

```text
SEARCH
  |
  v
CANDIDATE
  |
  v
ACQUIRE
  |
  v
TRACK
  |
  +------ target lost ------+
  |                          |
  v                          v
PREDICT / REACQUIRE ----> SEARCH
```

Suggested behavior:

- `SEARCH`: no target confirmed; camera scans according to a configurable strategy.
- `CANDIDATE`: detection observed but not yet stable.
- `ACQUIRE`: consecutive confirmations required.
- `TRACK`: closed-loop pan/tilt control active.
- `PREDICT/REACQUIRE`: short-term prediction and local search after loss.

### 6.13 Coarse Camera Controller

The controller takes target image error and generates pan/tilt commands.

Image error:

```text
error_x = target_x - frame_center_x
error_y = target_y - frame_center_y
```

Control options:

- proportional controller;
- PID controller;
- optional adaptive PID.

A PID-based implementation is recommended for the primary system because it exposes a clear control loop and is easy to benchmark.

The controller must enforce:

- maximum pan speed;
- maximum tilt speed;
- command update interval;
- camera mechanical/virtual bounds.

### 6.14 Reacquisition

When the target is lost:

1. Continue short-term prediction.
2. Search around the predicted position.
3. Expand search region if needed.
4. Return to global scan when local reacquisition fails.
5. Record reacquisition time.

### 6.15 Metrics Engine

Required/logged metrics:

- simulation duration;
- FPS;
- acquisition time;
- average tracking/centroid error;
- maximum tracking error;
- RMSE;
- target loss percentage;
- lock retention rate;
- reacquisition time;
- processing time.

Additional useful metrics:

- p95/p99 error;
- detection confidence;
- detector latency;
- controller latency;
- number of reacquisition events;
- frames processed;
- frames dropped.

### 6.16 Report Generator

Exports:

- CSV metrics;
- JSON raw event data;
- human-readable summary report;
- optional charts.

The report should store the scenario configuration, random seed, software version, detector/tracker/controller selection, and benchmark results so experiments are reproducible.

### 6.17 GUI / Visualization

Recommended views:

1. Camera viewport.
2. Full simulation scene/ground truth view.
3. Target status.
4. Pan and tilt values.
5. Error plots.
6. FPS and processing time.
7. Lock status.
8. Disturbance controls.
9. Scenario controls.
10. Video input mode.
11. Experiment/replay controls.
12. Export/report controls.

## 7. Data Flow

```text
Scenario config
    -> scene initialization
    -> target trajectory
    -> camera pose
    -> clean scene
    -> disturbances
    -> camera frame
    -> preprocessing
    -> detection
    -> centroid
    -> tracking/prediction
    -> error calculation
    -> control command
    -> camera pose update
    -> next frame
```

Ground truth should branch directly from the simulator to the metrics engine, not through the detector.

## 8. Performance-Critical Design

The evaluation requires at least 20 FPS processing speed. The camera update rate requirement is at least 30 Hz in the source specification. Therefore:

- avoid unnecessary frame copies;
- keep AI model lightweight;
- use bounded queues;
- separate rendering from detection where practical;
- permit detector and GUI frequencies to differ;
- log asynchronously;
- expose actual measured FPS, not configured FPS.

## 9. Fault Handling

The application must handle:

- invalid video files;
- missing/corrupt frames;
- detector failure;
- temporary target loss;
- configuration outside allowed ranges;
- insufficient CPU/GPU resources;
- model loading failure;
- report-write failures.

The UI should report meaningful messages instead of silently failing.

## 10. Packaging Architecture

The final application should be distributable as a standalone executable with:

- executable;
- required runtime libraries;
- optional model file(s);
- default scenarios;
- sample videos;
- sample reports;
- user manual.

No internet connection should be required for core simulation and offline video benchmarking after installation.

## 11. Security / Reproducibility

- No credentials should be required for core operation.
- Do not send benchmark video frames to external services by default.
- Store scenario seed and version.
- Use deterministic simulation when deterministic mode is selected.
- Keep user files in explicit project/export directories.

## 12. Architecture Decision Summary

| Decision | Recommendation | Reason |
|---|---|---|
| Primary language | Python | Rapid CV/simulation development |
| GUI | PySide6 | Desktop standalone GUI |
| CV | OpenCV | Mature real-time frame processing |
| Numerical simulation | NumPy/SciPy | Fast deterministic simulation |
| AI | PyTorch or ONNX Runtime | Optional lightweight inference |
| Tracking | Kalman filter | Robust short-term prediction |
| Control | PID | Simple, measurable coarse-pointing control |
| Reporting | CSV + JSON + charts | Evaluation/reproducibility |
| Video | OpenCV/FFmpeg-backed reader | MP4 benchmark input |
| Packaging | PyInstaller | Standalone executable |

## 13. Requirement Traceability

| Official requirement | Architecture component |
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
| Source/documentation | Repository + docs |
| Performance report | Report Generator |
| External 30-FPS MP4 evaluation | Frame Ingestion abstraction |

## 14. Source-Based Constraints from PS

The source specification states:

- minimum screen size: 2000 x 2000 pixels;
- camera type: monochrome focal-plane array, with color optional;
- camera resolution: 640 x 480 pixels, user-defined optional;
- camera FOV: user-defined, default 4° x 3°;
- camera update rate: 30 Hz minimum;
- initial camera position: screen center;
- target: beacon spot;
- one target mandatory, multiple optional;
- target shape default square;
- target size user-defined, default 10 x 10 pixels;
- four required motion modes: straight, circular, figure-8, random;
- optional spiral, sinusoidal, user-defined motions;
- max pan/tilt speed suggested 5–10°/s, default 5°/s;
- update interval >= 20 Hz;
- acquisition time <= 2 s;
- tracking error <= 10 pixels;
- target loss < 5%;
- reacquisition <= 1 s;
- processing speed >= 20 FPS;
- noise options: salt-and-pepper, Gaussian, Poisson;
- max noise standard deviation 20 pixels, user-defined;
- max camera jitter ±20 pixels/frame, user-defined;
- atmospheric modes: clear, haze, fog, rain, low light;
- platform motion max ±20 pixels/frame, with linear mandatory/default and additional optional patterns.
