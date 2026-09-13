# 08 — Scoring Engine Spec

This document is the single source of truth for every metric formula, its data requirements, its pass/fail threshold, and how it maps to the SIH evaluation weighting. `evaluation/metrics.py` and `evaluation/scoring.py` (see `07-monorepo-structure.md`) must implement exactly this spec — no metric definition should exist only in the UI or only in the report generator.

## 1. Metric Definitions

### Acquisition time
Time from scenario/run start to first confirmed `TRACK` state (i.e. after the ACQUIRE confirmation window, not first raw detection — see `04-system-architecture.md` §4.12).
```text
acquisition_time_s = t(first TRACK) - t(run start)
```

### Tracking error (per frame)
Euclidean pixel distance between the measured/estimated center and ground truth. Only computable when ground truth exists (simulation, or annotated video — see §4).
```text
error_px = sqrt((x_est - x_gt)^2 + (y_est - y_gt)^2)
```

### RMSE
```text
RMSE = sqrt(mean(error_px^2))   # over all frames where error_px is defined
```

### Target loss
```text
loss_percent = lost_frames / total_frames * 100
```
A frame is `lost` when the state machine is in `SEARCH` or has exceeded the loss timeout in `PREDICT_REACQUIRE`, per the definition in `04-system-architecture.md` §4.12 — not simply "no detection this frame" (a single missed detection during valid prediction is not a loss).

### Lock retention rate
```text
lock_retention = locked_frames / eligible_frames * 100
```
`locked` = image-space distance from desired pointing center ≤ configured lock radius, **while** state is `TRACK` (predicted frames count toward lock only if `tracking.count_prediction_as_locked = true` in config — this policy must be stated in the report; it is not hardcoded true or false).

### Re-acquisition time
```text
reacquisition_time_s = t(confirmed reacquisition) - t(confirmed loss)
```
Reported as both average and maximum across all loss events in a run.

### Processing speed
```text
algorithm_fps = processed_frames / algorithm_elapsed_time     # pipeline-only, excludes render/UI
wall_clock_fps = displayed_frames / wall_clock_time             # includes render/UI
```
Both are computed; the report must label which one is compared against the PS's ≥20 FPS target (`algorithm_fps`).

## 2. Pass/Fail Against Official PS Targets

| Metric | Target | Evaluated per |
|---|---:|---|
| Acquisition time | ≤ 2 s | run |
| Tracking error (avg) | ≤ 10 px | run, where GT exists |
| Target loss | < 5% | run |
| Re-acquisition time (avg) | ≤ 1 s | run |
| Processing speed | ≥ 20 FPS (algorithm_fps) | run |

`pass_fail` object in `RunResult` (`05-database-schema.md` §4) is computed by `evaluation/scoring.py` immediately at `finalize()` and never recomputed or overridden by the UI — the Results screen only displays what scoring.py returns.

**Reporting discipline:** the PS targets are pass/fail gates, not a numeric score the team invents. Do not compute or display an aggregate "overall score out of 100" derived from these — the actual four-stage weighting (§3) is the judges' own rubric, applied externally.

## 3. Internal Self-Assessment Rubric (mirrors the four official evaluation stages)

This section is a planning/self-check tool only — it never appears as a claimed "score" in judge-facing output. It exists so the team can track readiness against the real weighting before the event.

| Stage | Weight | Internal readiness checklist |
|---|---:|---|
| Functional Verification | 20% | Every mandatory FR demonstrable live in ≤15 min; standalone build runs on a clean machine (`11-environment-and-devops.md`) |
| Benchmark Performance-1 | 30% | Scenario suite (`12-testing-strategy.md` §Scenario Tests) run with fixed seeds; centroiding error logged; report auto-generated with no manual steps |
| Benchmark Performance-2 | 30% | MP4 pipeline runs end-to-end on a sample video; ground-truth availability handled per §4 below for both annotated and unannotated cases |
| Technical Evaluation | 20% | Architecture/report answer every question listed in the technical-evaluation-readiness checklist (see `04-system-architecture.md`, `09-engineering-scope-definition.md`) |

## 4. Ground-Truth Availability Policy (Mode B) — resolves the risk flagged in `01-product-requirements.md` §11

| Situation | Behavior |
|---|---|
| Evaluator MP4 ships with a known GT reference file | Full metric set computed as normal |
| No GT supplied, manual annotation performed by the team | GT derived from sparse click-annotation + linear interpolation (`05-database-schema.md` §6); `ground_truth_source = "manual_annotation"` recorded in `RunResult`, and the report flags this explicitly so it is never mistaken for evaluator-supplied ground truth |
| No GT, no annotation performed | `error_px`, `RMSE`, and lock-retention-vs-ground-truth are reported as `null`/"not computable"; the following **reference-free** metrics are reported instead: detection rate (`detected_frames/total_frames`), track continuity (longest continuous TRACK streak), reacquisition event count, `algorithm_fps`, average detection confidence |

The scoring engine must never silently substitute one ground-truth source for another or blend annotated and non-annotated segments of the same run without labeling the split.

## 5. Score Stability Requirement
Because a single run can be noisy, the internal benchmark gate (used before declaring any phase "done" in `10-development-phases.md`) requires **repeated seeds**, not a single best run:
```text
For gate metric M: report [min, mean, max] over ≥5 seeded runs per scenario,
and require mean(M) to meet the PS target, not just best-case(M).
```
The report states exactly which scenarios pass/fail rather than claiming blanket compliance from one favorable run.
