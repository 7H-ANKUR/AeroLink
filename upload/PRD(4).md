# PRD.md

# Product Requirements Document
## AI-Assisted Virtual Camera Tracking System for Coarse Alignment of Mobile FSOC Terminals

## 1. Product Summary

Build a desktop software application that simulates the coarse alignment stage of optical Free Space Optical Communication between mobile terminals. The software creates a virtual world, generates a moving optical beacon, produces a virtual camera feed, detects and tracks the beacon, and automatically changes the virtual camera pan/tilt direction so that the beacon remains visible and near the desired pointing location.

The product must also support external benchmark video input because the source PS states that evaluators may provide 30-FPS MP4 videos containing a moving beacon and noise. The same detection/tracking/controller pipeline should therefore operate on simulator frames and benchmark videos.

## 2. Problem Statement

FSOC uses a highly directional optical beam. Small angular errors can prevent successful communication. Before fine alignment can operate, the transmitting terminal must first locate and maintain the remote terminal or beacon inside its camera FOV. Doing this on real hardware requires expensive cameras, pan-tilt mechanisms and optical equipment. The product replaces that hardware requirement with a software-based virtual camera tracking environment.

## 3. Users

### Primary user

- SIH participant/team developer building and validating coarse PAT algorithms.

### Secondary users

- evaluator/judge running benchmark scenarios;
- researcher/student learning visual tracking;
- developer comparing tracking algorithms.

## 4. Product Goals

### Must achieve

1. Autonomous beacon detection.
2. Continuous tracking.
3. Automatic pan/tilt response.
4. Configurable target motion.
5. Configurable noise and disturbances.
6. Simulation mode.
7. MP4 video benchmark mode.
8. Real-time performance metrics.
9. Automatic performance reporting.
10. Standalone executable deployment.

### Success definition

A run is considered successful when the system can acquire the beacon quickly, keep image-space error within the specified benchmark range as often as possible, survive disturbances, reacquire after loss, and provide complete logs.

## 5. Product Modes

### Mode A — Simulation

The application generates its own environment, beacon trajectory, camera, and disturbances.

Use cases:

- development;
- regression testing;
- algorithm tuning;
- demonstration;
- automated test generation.

### Mode B — External Video Benchmark

The user selects a video file, nominally a 30-FPS MP4 benchmark video. The system bypasses the virtual camera renderer and feeds the video into preprocessing/detection/tracking/control/metrics.

Important limitation: for an external video, actual physical camera pan/tilt cannot change the supplied pixels unless the benchmark pipeline defines a viewport-control simulation. The product must therefore clearly separate **detection/tracking evaluation on supplied video** from **closed-loop virtual-camera control**. The benchmark adapter can expose control outputs even when physical repositioning is not part of the video test.

## 6. Core User Journey

```text
Open application
    ↓
Choose Simulation / Video
    ↓
Load scenario or video
    ↓
Review parameters
    ↓
Start
    ↓
System searches for beacon
    ↓
Beacon acquired
    ↓
Camera automatically follows
    ↓
Disturbances may occur
    ↓
Target remains locked or is reacquired
    ↓
Stop / scenario completes
    ↓
View metrics
    ↓
Export performance report
```

## 7. Functional Requirements

### FR-01: Scenario Configuration

The application shall provide configurable:

- scene dimensions;
- camera resolution;
- camera FOV;
- camera update rate;
- starting camera position;
- number of targets;
- target shape;
- target size;
- initial target location;
- target motion;
- pan/tilt speed;
- disturbances;
- noise;
- controller settings;
- tracker settings.

### FR-02: Virtual Environment

The system shall generate a virtual scene and an observable camera viewport.

### FR-03: Beacon Generation

The system shall generate at least one configurable beacon spot. Multiple targets may be supported.

### FR-04: Target Motion

Required modes:

- straight line;
- circular;
- figure 8;
- random.

Optional:

- spiral;
- sinusoidal;
- user-defined trajectory.

### FR-05: Virtual Camera

The system shall implement a controllable virtual pan-tilt camera.

### FR-06: Beacon Detection

The system shall detect the designated beacon automatically and produce a position/centroid and confidence/status.

### FR-07: Continuous Tracking

The software shall maintain a target track over time and distinguish between acquired, tracked, and lost states.

### FR-08: Prediction

The system should provide short-term target prediction to improve robustness during noisy measurements or temporary detection loss.

### FR-09: Camera Control

The controller shall calculate target-to-center error and generate bounded pan/tilt commands.

### FR-10: Disturbance Injection

The system shall support noise and environmental/platform disturbances, including the categories specified by the PS.

### FR-11: Real-Time Statistics

The UI shall display at minimum:

- FPS;
- acquisition status/time;
- target coordinates;
- tracking error;
- lock status;
- processing time.

### FR-12: Performance Logging

The application shall automatically generate a performance report containing simulation duration, FPS, acquisition time, average/max tracking error, lock retention, processing time and related metrics.

### FR-13: External Video

The application shall accept benchmark MP4 video input, preserve the same detector/tracker/metrics interfaces, and log results.

### FR-14: Replay

The user should be able to replay a completed run with overlays showing detections, ground truth, predicted position and controller output.

### FR-15: Experiment Comparison

The product should support comparing saved runs, for example baseline versus AI-assisted mode.

## 8. Non-Functional Requirements

### Performance

- Processing speed: >= 20 FPS target.
- Camera update rate: >= 30 Hz minimum in simulation.
- UI should remain responsive during simulation.

### Reliability

- No silent target-state corruption.
- Reproducible runs when a seed is fixed.
- Graceful recovery from temporary target loss.

### Usability

A judge should be able to launch, select a scenario, run it, and obtain a report without editing source code.

### Portability

The final deliverable should be a standalone application suitable for the intended desktop environment.

### Privacy / Offline operation

Core operation should not require cloud inference or internet access.

## 9. Source PS Acceptance Targets

| Metric | Official suggested/required target |
|---|---:|
| Acquisition time | <= 2 sec |
| Tracking error | <= 10 px |
| Target loss | < 5% |
| Re-acquisition time | <= 1 sec |
| Processing speed | >= 20 FPS |
| Camera update | >= 30 Hz |
| Default FOV | 4° x 3° |
| Default beacon size | 10 x 10 px |
| Default max pan/tilt speed | 5°/s |
| Max suggested camera jitter | ±20 px/frame |
| Max platform motion | ±20 px/frame |
| Noise std. dev. | up to 20 px |

These are benchmark targets from the provided source. They should be displayed separately from any internally chosen engineering thresholds.

## 10. AI Requirements

The PS says the solution shall be AI-assisted, but it also evaluates algorithm selection, AI/computer vision, innovation and novelty. The implementation may therefore combine AI and classical vision.

Recommended product strategy:

- use classical CV for a transparent fast baseline;
- use optional lightweight AI for robustness;
- combine candidate scores;
- use temporal tracking/prediction to stabilize output.

The AI component must not become a single point of failure. The system should still be capable of demonstrating a classical baseline.

## 11. Detection Requirements

Detection output:

```json
{
  "found": true,
  "x": 312.4,
  "y": 228.9,
  "confidence": 0.97,
  "bbox": [307,224,10,10],
  "latency_ms": 3.7
}
```

## 12. Tracking Requirements

The tracker must:

- accept detections with confidence;
- filter measurement noise;
- estimate velocity where possible;
- predict during short detection gaps;
- declare loss after configurable timeout;
- support reacquisition;
- emit track quality/state.

## 13. Control Requirements

The controller must:

- calculate horizontal and vertical image error;
- support proportional/PID control;
- respect max pan/tilt speed;
- avoid unstable oscillation;
- support deadband/hysteresis;
- emit actual command values for logging.

## 14. Lock Definition

A configurable default lock condition should be:

> beacon is detected or reliably predicted and its image-space distance from the desired pointing center is within the configured lock radius.

The product must expose the lock definition in configuration so it is not hidden.

## 15. Target-Loss Definition

A target-loss event occurs when no valid detection/prediction maintains lock for longer than the configured loss timeout.

The product should report:

- number of loss events;
- total lost frames;
- loss percentage;
- longest continuous loss duration.

## 16. Performance Metrics Definitions

### Acquisition time

Time from scenario start to first stable acquisition.

### Tracking error

Euclidean pixel distance between detected/estimated target center and ground truth target center in simulation.

### RMSE

```text
RMSE = sqrt(mean(error_px^2))
```

### Target loss

```text
loss_percent = lost_frames / total_frames * 100
```

### Lock retention rate

```text
lock_retention = locked_frames / eligible_frames * 100
```

### Re-acquisition time

Elapsed time between confirmed target loss and confirmed reacquisition.

### Processing speed

Measured frames processed per second by the algorithmic pipeline, reported independently of rendering FPS where possible.

## 17. UI Requirements

### Main Dashboard

- simulation/video preview;
- target marker;
- predicted marker;
- camera center crosshair;
- status: SEARCH / ACQUIRE / TRACK / LOST;
- pan/tilt values;
- acquisition time;
- live error;
- FPS;
- lock retention;
- disturbance indicators.

### Parameter Panel

- scenario selection;
- motion selection;
- target size;
- target count;
- FOV;
- speed;
- noise;
- atmosphere;
- platform motion;
- detector;
- tracker;
- controller.

### Results Panel

- summary metrics;
- plots;
- pass/fail indication against configured targets;
- export controls.

## 18. Evaluation Workflow

The source document defines three major evaluation stages:

### Functional Verification — 20%

10–15 minute software demonstration checking mandatory functions and operational success, including GUI.

### Benchmark Performance-1 — 30%

Scenario-based execution with centroiding error logs and automatically generated performance logs.

### Benchmark Performance-2 — 30%

Evaluation on 30-FPS MP4 files with noise and moving beacon spot, including centroiding error and metrics such as RMSE, acquisition/re-acquisition time, lock retention rate and FPS.

### Technical Evaluation — 20%

Technical discussion of problem understanding, architecture, design, algorithm selection, AI/CV, innovation, documentation, presentation and Q&A.

The product roadmap should be built around these four evaluation stages.

## 19. Deliverables Requirements

### Software Application

Standalone executable implementing mandatory functions.

### Source Code

Complete, modular, documented and commented source.

### Technical Report

About 10–15 pages covering understanding, architecture, modules, tracking methods, AI methods, testing, performance and future improvements.

### User Manual

Installation, operation, configuration and GUI explanation.

### Optional Demo Video

3–5 minutes.

### Performance Log

Automatically generated performance report.

## 20. MVP Scope

### MVP must include

- desktop GUI;
- simulation mode;
- one beacon;
- all four mandatory motions;
- virtual pan/tilt camera;
- CV beacon detection;
- Kalman tracking;
- PID control;
- target-loss and reacquisition;
- required disturbance types;
- real-time metrics;
- CSV/JSON logs;
- MP4 input mode;
- standalone build path.

### Post-MVP enhancements

- AI detector;
- hybrid detector fusion;
- adaptive PID;
- multiple simultaneous beacons;
- advanced atmospheric models;
- scenario batch runner;
- experiment comparison dashboard;
- report PDF generation;
- richer 3D visualization.

## 21. Product Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Detector too slow | Lightweight detector, ROI and optimized preprocessing |
| False bright objects | Shape/size/temporal scoring |
| Target loss | Kalman prediction + reacquisition state machine |
| Oscillating control | PID tuning, deadband, speed saturation |
| Overfitting to synthetic data | Separate external-video benchmark mode |
| GUI slows processing | Decouple rendering and algorithm loops |
| External video cannot be physically re-aimed | Separate video evaluation from closed-loop simulation control |
| AI model unavailable | Classical baseline remains operational |

## 22. Definition of Done

A release candidate is complete when:

- a fresh machine can install and launch the application;
- a judge can start a simulation without coding;
- all four required target motions work;
- disturbances can be enabled;
- the beacon is detected automatically;
- the virtual camera moves based on tracking;
- target loss and reacquisition are visible;
- metrics are continuously computed;
- performance logs are automatically generated;
- an MP4 can be loaded for benchmark processing;
- source code and documentation match the implementation;
- the application can be packaged as a standalone executable.
