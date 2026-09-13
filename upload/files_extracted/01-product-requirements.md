# 01 — Product Requirements Document

## FSOC-PAT: AI-Assisted Virtual Camera Tracking System for Coarse Alignment of Mobile FSOC Terminals

**SIH 2026 — Problem Statement 169**

> **Revision note:** This PRD supersedes the earlier draft. Section 9 (Scope Tiers) replaces the old flat "MVP must include everything" list — see `09-engineering-scope-definition.md` for the full rationale. Section 11 documents a scoring-risk that was previously implicit.

---

## 1. Product Summary

A desktop application that simulates the coarse-alignment stage of Free Space Optical Communication (FSOC) between mobile terminals. It generates a virtual scene with a moving optical beacon, renders a virtual camera feed, detects and tracks the beacon, and automatically re-points a virtual pan/tilt camera to keep the beacon near the desired image location.

The same detection → tracking → control → metrics pipeline must also run against **externally supplied 30-FPS MP4 benchmark videos**, since the official PS evaluation includes a video-benchmark stage.

## 2. Problem Statement

FSOC uses a narrow, highly directional beam; small angular errors break the link. Before fine pointing can engage, a terminal must first locate and hold the remote beacon inside its camera field of view. Real hardware (cameras, PTZ mounts, optics) is expensive and impractical for a hackathon deliverable — the product replaces it with a software-only virtual camera-tracking environment that is functionally equivalent for the coarse-alignment problem.

## 3. Users

| Role | Need |
|---|---|
| SIH participant/developer (primary) | Build, tune and validate coarse PAT algorithms |
| Evaluator / judge (secondary) | Run benchmark scenarios and MP4 tests without touching code |
| Researcher / student (secondary) | Learn visual tracking / control concepts |
| Developer comparing algorithms (secondary) | Swap detector/tracker/controller and compare runs |

## 4. Product Goals

1. Autonomous beacon detection.
2. Continuous tracking with short-term prediction.
3. Closed-loop pan/tilt control.
4. Configurable target motion (4 required + optional modes).
5. Configurable noise and disturbances.
6. Simulation mode.
7. MP4 video benchmark mode.
8. Real-time on-screen performance metrics.
9. Automatic performance report generation.
10. Standalone executable deployment.

**Success definition:** the system acquires the beacon quickly, keeps image-space error within the benchmark range as often as possible, survives disturbances, reacquires after loss, and produces a complete, reproducible log for every run.

## 5. Product Modes

### Mode A — Simulation
The application generates its own scene, beacon trajectory, camera, and disturbances. Used for development, regression testing, tuning, and demonstration.

### Mode B — External Video Benchmark
The user loads a video file (nominally 30-FPS MP4). The system bypasses the virtual-camera renderer and feeds decoded frames into the same preprocessing/detection/tracking/control/metrics pipeline.

**Constraint carried through the whole design:** pan/tilt commands cannot physically alter pixels already recorded in a video file. Mode B is therefore a **perception/tracking benchmark**, not a closed-loop control demonstration, unless the supplied benchmark format includes enough scene information to re-render a controllable viewport. The controller still runs and emits commands (useful for control-quality metrics and for the demo), but the UI and report must **not** claim physical re-pointing occurred on recorded footage.

## 6. Core User Journey

```text
Open application
  → Choose Simulation / Video
  → Load scenario or video
  → Review parameters
  → Start
  → System searches for beacon
  → Beacon acquired
  → Camera automatically follows
  → Disturbances may occur
  → Target remains locked or is reacquired
  → Stop / scenario completes
  → View metrics
  → Export performance report
```

## 7. Functional Requirements

| ID | Requirement |
|---|---|
| FR-01 | Configurable scenario: scene size, camera resolution/FOV/update rate, start pose, target count/shape/size/location/motion, pan/tilt speed, disturbances, noise, detector/tracker/controller selection |
| FR-02 | Virtual environment + observable camera viewport |
| FR-03 | ≥1 configurable beacon; multiple targets supported |
| FR-04 | Target motion: straight, circular, figure-8, random (required); spiral, sinusoidal, user-defined (optional) |
| FR-05 | Controllable virtual pan/tilt camera |
| FR-06 | Automatic beacon detection → position/centroid + confidence/status |
| FR-07 | Continuous tracking with explicit acquired / tracked / lost states |
| FR-08 | Short-term prediction during noisy or missing detections |
| FR-09 | Controller computes target-to-center error and emits bounded pan/tilt commands |
| FR-10 | Noise and environmental/platform disturbance injection per PS categories |
| FR-11 | Real-time UI stats: FPS, acquisition status/time, target coords, tracking error, lock status, processing time |
| FR-12 | Automatic performance report: duration, FPS, acquisition time, avg/max error, lock retention, processing time, etc. |
| FR-13 | External MP4 ingestion through the same detector/tracker/metrics interfaces |
| FR-14 | Replay of a completed run with overlays (detection, ground truth, prediction, controller output) |
| FR-15 | Comparison of saved runs (e.g. baseline vs. AI-assisted) |

FR-14 and FR-15 are explicitly **post-MVP** — see `09-engineering-scope-definition.md`.

## 8. Non-Functional Requirements

- **Performance:** processing ≥ 20 FPS; camera update ≥ 30 Hz in simulation; UI stays responsive during processing (see threading note in `04-system-architecture.md`).
- **Reliability:** no silent state corruption; reproducible runs under a fixed seed; graceful recovery from temporary target loss.
- **Usability:** a judge can launch, configure, run, and export a report with zero code edits.
- **Portability:** standalone executable, no source checkout required on the judge's machine.
- **Offline operation:** core simulation and MP4 benchmarking require no network access.

## 9. Scope Tiers (summary)

The full tiered breakdown lives in `09-engineering-scope-definition.md`. Headline change from the earlier draft: the PRD previously listed almost every FR as MVP-mandatory in one flat bucket, which is not achievable in a hackathon timeline. Requirements are now split into a **Tier 0 walking skeleton**, **Tier 1 core MVP** (matches the PS mandatory functions), **Tier 2 full spec compliance** (all disturbance types, MP4 mode, full metrics/report), and **Tier 3 stretch** (AI detector, replay, comparison dashboard, adaptive control).

## 10. Source PS Acceptance Targets

| Metric | Target |
|---|---:|
| Acquisition time | ≤ 2 s |
| Tracking error | ≤ 10 px |
| Target loss | < 5% |
| Re-acquisition time | ≤ 1 s |
| Processing speed | ≥ 20 FPS |
| Camera update | ≥ 30 Hz |
| Default FOV | 4° × 3° |
| Default beacon size | 10 × 10 px |
| Default max pan/tilt speed | 5°/s |
| Max camera jitter | ±20 px/frame |
| Max platform motion | ±20 px/frame |
| Noise std. dev. | up to 20 px |

These are displayed in the UI/report as **official targets**, kept visually distinct from internally chosen engineering thresholds (e.g. deadband radius, acquisition-confirm frame count).

## 11. Known Product Risks (top-level)

| Risk | Impact | Mitigation |
|---|---|---|
| **Evaluator MP4s may ship without ground-truth annotation** | Benchmark Performance-2 is 30% of the score; centroiding error/RMSE cannot be computed without a reference | Build a manual-annotation fallback (click-to-mark) into the video benchmark UI; report reference-free metrics (detection rate, track continuity, reacquisition events) when no GT exists; confirm annotation availability with the SIH nodal center in advance |
| **MVP scope as originally written is too large for the timeline** | Missed Functional Verification demo | Tiered scope (`09`), packaging smoke-test moved to an early phase (`10`, `11`) |
| Detector too slow | Fails processing-speed target | Lightweight classical baseline first; ROI-restricted search; optimize before adding AI |
| False bright objects (distractors) | False lock, oscillating control | Shape/size/temporal candidate scoring |
| Oscillating control | Fails tracking-error target, looks bad in demo | PID with deadband, output saturation, anti-windup; pixel error converted to angular error **before** PID (see `04-system-architecture.md`) |
| Overfitting to synthetic training data | AI detector fails on judge's video | Separate external-video benchmark mode kept independent of simulator internals |
| GUI thread blocked by processing loop | UI freeze, failed live demo | Dedicated processing thread; Qt signal/slot with queued connections only |
| AI model unavailable at demo time | No fallback | Classical baseline remains fully operational without the AI path |
| Standalone build too large / fails on clean machine | Cannot run Functional Verification | Test packaging on a clean machine starting Sprint/Phase 2, not at the end |

## 12. Deliverables

- Standalone executable implementing all Tier 0–2 functions.
- Complete, modular, commented source code.
- Technical report (10–15 pages): understanding, architecture, modules, tracking/AI methods, testing, performance, future work.
- User manual: install, operate, configure, GUI walkthrough — including an explicit note that MP4 evaluation is perception-only unless GT is supplied.
- Optional 3–5 minute demo video.
- Automatically generated performance log per run.

## 13. Evaluation Weighting (source PS)

| Stage | Weight | Covers |
|---|---:|---|
| Functional Verification | 20% | 10–15 min live demo of mandatory functions, incl. GUI |
| Benchmark Performance-1 | 30% | Scenario-based runs, centroiding error, auto-generated logs |
| Benchmark Performance-2 | 30% | Evaluator-supplied 30-FPS MP4s: centroiding error (if GT available), RMSE, acquisition/re-acquisition time, lock retention, FPS |
| Technical Evaluation | 20% | Architecture, algorithm selection, AI/CV, innovation, documentation, Q&A |

The entire roadmap in `10-development-phases.md` is built around passing these four stages, in that order of priority.

## 14. Definition of Done

- Fresh machine can install and launch the application.
- A judge can start a simulation without touching code.
- All four required motions work; disturbances can be toggled.
- Beacon is detected automatically; virtual camera moves based on tracking.
- Target loss and reacquisition are visibly demonstrable.
- Metrics compute continuously and a report is auto-generated.
- An MP4 can be loaded for benchmark processing, with the perception-only distinction clearly surfaced in the UI.
- Source, docs, and running application match.
- Application is packaged as a standalone executable and has been run on a machine that never had the dev environment installed.
