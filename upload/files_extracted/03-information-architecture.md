# 03 — Information Architecture

Desktop application (PySide6), single-window shell with mode-dependent panels. This document defines screens, navigation, and what data lives where — the UI equivalent of a sitemap for a desktop app.

## 1. Application Shell

```text
Main Window
├── Top bar: mode toggle (Simulation | Video), Start/Stop/Pause, Run ID, Save/Load Scenario
├── Left: Parameter Panel (tabbed)
├── Center: Camera Viewport + Scene View (tabbed or split)
├── Right: Live Metrics Panel
├── Bottom (collapsible): Event Log
└── Menu: File | Scenario | Run | View | Help
```

Only one mode is active at a time; switching modes swaps the Parameter Panel's contents and the frame source, without restarting the application.

## 2. Screen Inventory

| Screen / Panel | Primary purpose | Tier |
|---|---|---|
| Parameter Panel — Scenario tab | Scene size, camera resolution/FOV/update rate, start pose, target count/shape/size/location/motion, pan/tilt speed limits | T0 |
| Parameter Panel — Disturbance tab | Noise types, atmosphere preset, platform motion, jitter | T2 |
| Parameter Panel — Algorithm tab | Detector/tracker/controller selection and their tunable params (PID gains, lock radius, confirm frames, loss timeout) | T1 |
| Parameter Panel — Video tab | File picker, GT annotation mode toggle, manual-annotation tool | T2 |
| Camera Viewport | Live camera feed with overlays: center crosshair, detection box/centroid, predicted point, confidence, lock ring | T0 |
| Scene View (optional 2nd view) | World-space view: target path, camera FOV footprint, camera pose, ground truth | T1 |
| Live Metrics Panel | STATE, FPS, ERROR, ACQ time, LOCK %, PAN/TILT rates, active disturbance indicators | T1 |
| Results / Report Screen | Summary metrics, plots, pass/fail vs. PS targets, export controls | T1 |
| Replay Screen | Scrub through a saved run with the same overlays as live view | T3 |
| Comparison Screen | Two-run side-by-side metric delta view | T3 |
| Run History / Experiment Browser | List of past runs (from local run registry), filter/search, open in Replay or Comparison | T3 |

## 3. Navigation Model

```text
[Start] ──────────────────────────────┐
   │                                   │
   ▼                                   ▼
Parameter Panel  ←──editable while idle──  (locked while running)
   │
   ▼
[Run Start] → Camera Viewport + Live Metrics (active)
   │
   ▼
[Run Stop / Complete] → Results Screen
   │                         │
   │                         ├── Export report (CSV/JSON/summary)
   │                         ├── Open in Replay (T3)
   │                         └── Add to Comparison (T3)
   ▼
Back to Parameter Panel (idle)
```

The parameter panel is read-only once a run starts, to prevent config drift mid-run from corrupting reproducibility (ties to determinism requirement in `01-product-requirements.md` §8).

## 4. Data Ownership per Screen

| Screen | Reads | Writes |
|---|---|---|
| Parameter Panel | Config schema defaults (`config/default.yaml`) | In-memory `ScenarioConfig`; on Save, a named config file |
| Camera Viewport | Live `FramePacket`, `Detection`, `TrackState`, `PanTiltCommand` (streamed via Qt signal, queued connection) | Nothing — display only |
| Live Metrics Panel | Streaming accumulators from the Metrics Engine | Nothing |
| Results Screen | `RunResult` + frame-event log for the just-completed `run_id` | Triggers `ReportGenerator` export |
| Replay / Comparison / History | Local run registry + exported CSV/JSON (`05-database-schema.md`) | Nothing (read-only, post-hoc analysis) |

## 5. State Indicators Surfaced to the User

The state machine (`04-system-architecture.md` §State Machine) is exposed directly in the Live Metrics Panel as one of: `SEARCH`, `CANDIDATE`, `ACQUIRE`, `TRACK`, `PREDICT/REACQUIRE`. This mapping must stay 1:1 with the internal state machine — the UI must never invent an intermediate label that doesn't correspond to an actual internal state, since judges will cross-check the demo against the technical report.

## 6. Mode B (Video) — UI-Specific Rules

- The Video tab must show, before a run starts, whether ground truth is available for the loaded file: **Known GT file**, **Manual annotation required**, or **No GT — perception-only metrics**.
- If **No GT**, the Results Screen swaps the "Tracking Error / RMSE" cards for "Detection rate / Track continuity / Reacquisition events" and shows a persistent label: *"Perception-only benchmark — no physical re-pointing of recorded footage."*
- Manual annotation tool: click-to-mark on sampled frames (e.g. every 10th frame), linearly interpolated between marks, stored alongside the run as a lightweight reference track.

## 7. Accessibility / Usability Constraints (from NFR-Usability)

- Every control needed to run a full scenario must be reachable without editing a config file by hand.
- Validation errors surface inline on the offending field, not only in a log panel.
- The Results Screen must visually separate **official PS targets** (Section 10 of the PRD) from **internal engineering thresholds**, per FR-12/NFR labeling requirement.
