# 02 — User Stories & Acceptance Criteria

Stories are grouped by FR from `01-product-requirements.md` and tagged with the scope tier from `09-engineering-scope-definition.md` (T0 = walking skeleton, T1 = core MVP, T2 = full spec, T3 = stretch).

---

## Epic A — Scenario Setup (FR-01, FR-02, FR-03)

**US-A1** [T0] As a developer, I want to configure scene size, camera resolution/FOV, and beacon start position, so that I can create a repeatable test scenario.
- **AC1:** Given the parameter panel is open, when I change FOV or resolution, then the camera viewport preview updates before I click Start.
- **AC2:** Given invalid values (e.g. FOV ≤ 0, target size ≤ 0), when I try to start, then the system blocks the run and shows a specific validation message (see `04-system-architecture.md` §Config Validation).
- **AC3:** Given a fixed random seed, when I run the same scenario twice, then both runs produce identical beacon trajectories.

**US-A2** [T1] As a judge, I want a set of predefined scenarios, so that I can run a standard test without building one from scratch.
- **AC1:** At least one scenario per required motion type ships with the application.
- **AC2:** Loading a predefined scenario populates every parameter field with its stored values.

## Epic B — Target Motion (FR-04)

**US-B1** [T0] As a developer, I want the beacon to move in straight, circular, figure-8, and random patterns, so that I can validate tracking under all required motion types.
- **AC1:** Each motion type produces ground truth at the exact simulation timestamp, computed analytically (not from stored/rendered pixels).
- **AC2:** Boundary behavior (bounce/wrap) is configurable and does not produce a discontinuous frame-to-frame position jump larger than the configured max speed.

**US-B2** [T2] As a developer, I want optional spiral/sinusoidal/user-defined motion, so that I can stress-test the controller beyond the mandatory set.
- **AC1:** A user-defined trajectory can be supplied as a config-referenced callback/script without modifying core simulator code.

## Epic C — Camera & Control (FR-05, FR-09)

**US-C1** [T0] As a developer, I want the virtual camera to pan/tilt in response to tracked position, so that the beacon stays near image center.
- **AC1:** Commanded pan/tilt rate never exceeds the configured max speed.
- **AC2:** Pixel error is converted to angular error **before** it reaches the PID controller (see `04-system-architecture.md` — corrected control-loop unit handling).
- **AC3:** With a stationary beacon at image center, steady-state pan/tilt command settles to ~0 (no persistent oscillation) within the configured deadband.

**US-C2** [T1] As a developer, I want the controller to enforce output saturation, anti-windup, and a deadband, so that the camera doesn't oscillate or hunt near lock.
- **AC1:** Integrator resets on transition into SEARCH/ACQUIRE.
- **AC2:** No commanded rate exceeds max pan/tilt speed under any tested disturbance combination.

## Epic D — Detection & Tracking (FR-06, FR-07, FR-08)

**US-D1** [T0] As a developer, I want the system to automatically detect the beacon and produce a centroid with confidence, so that downstream tracking has an input.
- **AC1:** Detector output matches the schema in `06-api-contracts.md` (`found`, `x`, `y`, `confidence`, `bbox`, `latency_ms`).
- **AC2:** On a clean (no-noise) frame with one beacon, detection succeeds on ≥ 95% of frames in a 100-frame test.

**US-D2** [T1] As a developer, I want the system to maintain SEARCH → CANDIDATE → ACQUIRE → TRACK states (with CANDIDATE able to fall back to SEARCH on disconfirmation), so that acquisition is deliberate rather than a false trigger on one bright pixel.
- **AC1:** A single-frame detection does not immediately produce TRACK; N consecutive confirmations (configurable) are required.
- **AC2:** A CANDIDATE that fails confirmation for M consecutive frames returns to SEARCH rather than hanging indefinitely.
- **AC3:** Acquisition timestamp is recorded at the TRACK transition, not at first detection.

**US-D3** [T1] As a developer, I want short-term Kalman prediction during brief occlusion, so that the tracker survives momentary detection loss without immediately declaring loss.
- **AC1:** During a configured prediction-timeout window with no detection, the tracker reports a predicted position and `TRACK` state with decaying confidence.
- **AC2:** Exceeding the timeout transitions to `PREDICT/REACQUIRE`, then `SEARCH` if not recovered.

**US-D4** [T3] As a developer, I want an optional AI detector that plugs into the same interface as the classical detector, so that I can compare or fuse both.
- **AC1:** AI detector output conforms to the same `Detection` schema as the CV detector.
- **AC2:** Disabling/removing the AI model does not break the pipeline — classical detector remains fully functional.

## Epic E — Disturbances (FR-10)

**US-E1** [T2] As a developer, I want to enable salt-and-pepper, Gaussian, and Poisson noise independently, so that I can test robustness against each PS-specified noise type.
- **AC1:** Each noise type has an independent on/off toggle and parameter (probability / sigma).
- **AC2:** The clean ground-truth beacon position is stored before noise is applied and is never affected by it.

**US-E2** [T2] As a developer, I want atmospheric presets (clear/haze/fog/rain/low-light) and platform motion, so that I can demonstrate resilience across the PS-named conditions.
- **AC1:** Switching presets changes only rendering/contrast/brightness parameters, never the ground-truth trajectory.
- **AC2:** Platform motion displacement never exceeds the configured max px/frame.

## Epic F — Real-Time Stats & Reporting (FR-11, FR-12)

**US-F1** [T1] As a judge, I want to see live FPS, error, lock status, and pan/tilt values while a run is in progress, so that I can verify the system is working without reading logs.
- **AC1:** Displayed FPS is measured (algorithm_fps), not the configured target rate.
- **AC2:** UI updates do not block or slow the processing thread (cross-thread updates via Qt signals only).

**US-F2** [T1] As a judge, I want a report auto-generated at the end of a run, so that I can review quantitative results without extra steps.
- **AC1:** Report includes: duration, avg FPS, acquisition time, avg/max error, RMSE, loss %, lock retention, avg processing time, and which detector/tracker/controller/seed were used.
- **AC2:** Report clearly labels which metrics are official PS targets vs. internal engineering metrics.

## Epic G — External Video Benchmark (FR-13)

**US-G1** [T2] As a judge, I want to load a 30-FPS MP4 and have it run through the same pipeline as simulation, so that I can evaluate the system on external footage.
- **AC1:** Detector/tracker/metrics modules require no code change to accept video frames vs. simulator frames (same `FrameSource` interface).
- **AC2:** If the video has no ground-truth annotation, the UI clearly states that centroiding error/RMSE cannot be computed and instead shows reference-free metrics.
- **AC3:** A manual-annotation mode lets the user click to mark ground truth on sampled frames, enabling error metrics even for unannotated video.
- **AC4:** The UI/report never implies that pan/tilt commands physically repositioned the camera for recorded video.

## Epic H — Replay & Comparison (FR-14, FR-15) — Stretch

**US-H1** [T3] As a developer, I want to replay a completed run with overlays (detection, ground truth, prediction, controller output), so that I can debug failures after the fact.
- **AC1:** Replay reconstructs frame-by-frame state entirely from the logged CSV/JSON — no re-execution of the algorithm required.

**US-H2** [T3] As a developer, I want to compare two saved runs (e.g. baseline vs. AI-assisted) side by side, so that I can support novelty claims with data during the Technical Evaluation.
- **AC1:** Comparison view shows metric deltas for two selected `run_id`s from the local run registry (`05-database-schema.md`).
