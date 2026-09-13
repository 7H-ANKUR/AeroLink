# 05 — Database / Local Storage Schema

FSOC-PAT is a fully offline desktop application — there is no server-side database. "Database" here means the **local persistence layer**: a lightweight SQLite run registry (for the Tier-3 Replay/Comparison/History features) plus a file-based export structure that is the source of truth for every run. SQLite is a query index over data that also exists as plain files, never the only copy.

## 1. Storage Layers

| Layer | Technology | Purpose |
|---|---|---|
| Scenario/config files | YAML | Human-editable scenario definitions, checked into the repo under `scenarios/` |
| Run export directory | Filesystem (CSV/JSON/HTML) | Canonical, portable record of a run — always written, regardless of SQLite |
| Run registry | SQLite (`fsoc_pat.db`) | Queryable index for the Run History / Comparison UI (Tier 3) — points at export directories, does not duplicate frame-level data |

If SQLite is unavailable or corrupted, the application must still function using only the filesystem exports — the registry is a convenience index, not a dependency of core recording.

## 2. Filesystem Export Layout (canonical, all tiers)

```text
exports/
  20260913_141200_a1b2c3/
      config.yaml           # full resolved ScenarioConfig used for this run
      events.csv             # per-frame log (see schema below)
      metrics.json            # RunResult summary object
      annotation.json         # optional: manual GT annotation (Mode B, if used)
      summary.html            # human-readable report
      plots/
          error_over_time.png
          lock_state_timeline.png
```

Directory name = `YYYYMMDD_HHMMSS_<run_id short hash>`. This structure is what the technical report and judge-facing exports point to; it must remain stable across refactors.

## 3. `events.csv` — Per-Frame Log

| Column | Type | Notes |
|---|---|---|
| timestamp | float (s) | Simulation or video-derived timestamp |
| frame_index | int | |
| source_mode | enum(`simulation`,`video`) | |
| gt_x, gt_y | float \| null | Null when no ground truth (Mode B without annotation) |
| detected_x, detected_y | float \| null | Null on missed detection |
| predicted_x, predicted_y | float \| null | Kalman prediction |
| confidence | float [0,1] | |
| tracking_state | enum(`SEARCH`,`CANDIDATE`,`ACQUIRE`,`TRACK`,`PREDICT_REACQUIRE`) | |
| pan_deg, tilt_deg | float | Current camera pose |
| pan_command, tilt_command | float (deg/s) | Controller output, post-saturation |
| error_px | float \| null | Null when `gt_x`/`gt_y` unavailable |
| processing_ms | float | Algorithm-only latency for this frame |
| locked | bool | Within configured lock radius |
| lost | bool | |

## 4. `metrics.json` — `RunResult`

```json
{
  "run_id": "2026-09-13T14:12:00Z-a1b2c3",
  "mode": "simulation",
  "duration_s": 60.0,
  "fps_measured": 48.4,
  "acquisition_time_s": 1.12,
  "avg_error_px": 4.21,
  "max_error_px": 14.8,
  "rmse_px": 5.63,
  "target_loss_percent": 2.3,
  "lock_retention_percent": 97.1,
  "reacquisition_avg_s": 0.54,
  "reacquisition_max_s": 1.10,
  "processing_avg_ms": 7.2,
  "scenario_seed": 42,
  "detector": "cv_classical",
  "tracker": "kalman_cv",
  "controller": "pid_angle_space",
  "ground_truth_source": "simulation | manual_annotation | none",
  "pass_fail": { "acquisition": true, "tracking_error": true, "target_loss": true, "reacquisition": true, "processing_speed": true }
}
```

`pass_fail` keys map 1:1 to the official PS targets defined in `01-product-requirements.md` §10 and computed per `08-scoring-engine-spec.md`.

## 5. SQLite Registry Schema (Tier 3 — Replay/Comparison/History)

```sql
CREATE TABLE runs (
    run_id            TEXT PRIMARY KEY,       -- matches export directory hash
    created_at         TEXT NOT NULL,          -- ISO8601
    mode               TEXT NOT NULL CHECK(mode IN ('simulation','video')),
    scenario_name       TEXT,
    scenario_seed       INTEGER,
    detector            TEXT,
    tracker              TEXT,
    controller           TEXT,
    duration_s           REAL,
    fps_measured         REAL,
    acquisition_time_s    REAL,
    avg_error_px          REAL,
    max_error_px           REAL,
    rmse_px                 REAL,
    target_loss_percent      REAL,
    lock_retention_percent    REAL,
    reacquisition_avg_s        REAL,
    processing_avg_ms           REAL,
    ground_truth_source          TEXT,
    export_path                   TEXT NOT NULL,  -- path to exports/<dir>/
    software_version               TEXT,
    notes                            TEXT
);

CREATE TABLE scenario_configs (
    scenario_name  TEXT PRIMARY KEY,
    file_path       TEXT NOT NULL,      -- points at scenarios/<name>.yaml
    description      TEXT,
    motion_types      TEXT,              -- comma-separated, for filtering in History view
    is_predefined      BOOLEAN DEFAULT 0
);

CREATE TABLE model_versions (
    model_id   TEXT PRIMARY KEY,
    kind        TEXT CHECK(kind IN ('detector','tracker','controller')),
    version      TEXT,
    file_path     TEXT,               -- ONNX/TorchScript path if applicable
    trained_on     TEXT,               -- seed range / dataset description
    notes            TEXT
);

CREATE INDEX idx_runs_mode ON runs(mode);
CREATE INDEX idx_runs_created ON runs(created_at);
```

**Design notes:**
- `runs` never stores frame-level data — that stays in `events.csv`. This keeps the registry small and query-fast even after hundreds of runs, and means deleting the SQLite file never loses primary data.
- `export_path` is the join key back to the filesystem for Replay (streams `events.csv`) and Comparison (reads two `metrics.json`).
- `model_versions` exists specifically so the report can state which detector version produced a given run's numbers — required for reproducibility claims in the Technical Evaluation.

## 6. Annotation Reference (`annotation.json`, Mode B fallback)

```json
{
  "source_video": "benchmark_01.mp4",
  "annotation_type": "manual_sparse",
  "annotated_frames": [
    {"frame_index": 0, "x": 310.0, "y": 224.0},
    {"frame_index": 10, "x": 318.2, "y": 226.1}
  ],
  "interpolation": "linear"
}
```
Sparse manual annotations are linearly interpolated to produce a reference track for `error_px` computation in `events.csv`. This is the concrete implementation of the ground-truth fallback flagged as a risk in `01-product-requirements.md` §11.

## 7. Data Retention & Reproducibility
- Every run is self-contained (config + events + metrics in one directory) — copying a run directory is sufficient to reproduce or share it.
- `scenario_seed` + `software_version` + module versions together define reproducibility; a run without a seed is flagged non-deterministic in the report.
