# 07 — Monorepo Structure

Single-repository, single-language (Python 3.11+) project. No polyglot/service split is needed — this is a desktop monolith, so "monorepo" here means one well-organized repo with enforced module boundaries, not multiple deployable services.

## 1. Directory Layout

```text
fsoc-pat/
├── app/
│   ├── main.py                 # entry point, wires modules per config
│   └── version.py              # single source of truth for software_version
├── config/
│   ├── default.yaml             # implementation defaults (labeled vs. PS-official values)
│   └── schemas.py                # ScenarioConfig dataclass + validation (04 §9)
├── simulator/
│   ├── scene.py
│   ├── beacon.py
│   ├── trajectories.py           # straight/circular/figure8/random (+ optional)
│   ├── camera.py
│   └── disturbances.py
├── io/
│   ├── base.py                    # FrameSource protocol (06 §1)
│   ├── simulation_source.py
│   └── video_source.py
├── detection/
│   ├── base.py                     # Detector protocol (06 §2)
│   ├── cv_detector.py
│   ├── ai_detector.py               # Tier 3
│   └── fusion.py                     # Tier 3
├── tracking/
│   ├── kalman.py
│   └── state_machine.py               # 04 §4.12, incl. CANDIDATE→SEARCH path
├── control/
│   ├── pid.py                          # angle-space PID (04 §4.13 fix)
│   └── pan_tilt.py
├── evaluation/
│   ├── metrics.py                       # MetricsEngine (06 §6)
│   ├── events.py                         # events.csv writer (05 §3)
│   ├── reports.py                         # ReportGenerator (06 §6)
│   └── scoring.py                          # pass/fail vs PS targets (08)
├── persistence/
│   ├── registry.py                          # SQLite run registry (05 §5)
│   └── exports.py                            # exports/ directory writer (05 §2)
├── gui/
│   ├── main_window.py
│   ├── camera_view.py
│   ├── dashboard.py
│   ├── config_panel.py
│   ├── replay_view.py                          # Tier 3
│   └── comparison_view.py                       # Tier 3
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── contract/                                # 06 §8 contract tests
│   └── scenario/
├── scenarios/                                    # predefined .yaml scenarios
├── samples/                                       # sample MP4s, sample reports
├── exports/                                        # runtime output (git-ignored)
├── models/                                          # optional ONNX/TorchScript files
├── packaging/
│   ├── pyinstaller.spec
│   └── build_and_smoke_test.sh                        # 11 §Packaging
├── docs/                                                # this document set
├── pyproject.toml
├── requirements.txt / requirements-dev.txt
└── README.md
```

## 2. Dependency Direction Rules

```text
gui  ──depends on──▶  evaluation, tracking, control, detection, io, simulator, config
evaluation ──depends on──▶ config, persistence
tracking, control, detection ──depend on──▶ config only (never on gui, io, or each other directly)
io ──depends on──▶ simulator, config
persistence ──depends on──▶ config
simulator ──depends on──▶ config only
```

**Hard rule:** `detection`, `tracking`, and `control` must never import from `gui` or `io`. This is what makes the contract tests in `12-testing-strategy.md` possible — every algorithmic module is testable with plain NumPy arrays and dataclasses, no Qt event loop or file I/O required. A CI check (import-linter or equivalent) enforces this boundary.

## 3. Module Ownership vs. Build Phases

Each top-level package maps to one or more phases in `10-development-phases.md`, so scope decisions in `09-engineering-scope-definition.md` translate directly into "which folders exist yet":

| Package | First appears at |
|---|---|
| `simulator/`, `io/simulation_source.py`, minimal `gui/` | Phase 1 (Tier 0) |
| `detection/cv_detector.py` | Phase 2 (Tier 0/1) |
| `tracking/` | Phase 3 (Tier 1) |
| `control/` | Phase 4 (Tier 1) |
| `simulator/disturbances.py`, full `evaluation/` | Phase 5–6 (Tier 2) |
| `io/video_source.py` | Phase 7 (Tier 2) |
| `detection/ai_detector.py`, `detection/fusion.py` | Phase 8 (Tier 3) |
| `gui/replay_view.py`, `gui/comparison_view.py`, `persistence/registry.py` | Phase 9+ (Tier 3) |

## 4. Build & Tooling Files

- `pyproject.toml` — single source for lint (ruff), formatting (black), and package metadata.
- `requirements.txt` (runtime) vs. `requirements-dev.txt` (pytest, ruff, black, pyinstaller) kept separate so the packaged executable doesn't pull dev tooling.
- `packaging/pyinstaller.spec` lives in the repo (not generated ad hoc) so the build is reproducible — see `11-environment-and-devops.md`.

## 5. Naming & Versioning
- `app/version.py` exposes a single `__version__` string, embedded into every `RunResult` (`05-database-schema.md` §4) and into the packaged executable's filename.
- Git tags mirror `__version__`; the technical report references the exact tag used for benchmark runs.
