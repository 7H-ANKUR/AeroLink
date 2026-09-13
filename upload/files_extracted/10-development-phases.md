# 10 — Development Phases

Consolidates the earlier "Sprint 1–10" and "Phase 1–9" lists into one plan, mapped to the tiers in `09-engineering-scope-definition.md`. Each phase has a go/no-go checkpoint — do not start the next phase until the current one's checkpoint is met, per the decision rule in `09` §6.

## Phase 1 — Skeleton (Tier 0)
- Repo scaffold per `07-monorepo-structure.md`.
- Config loading + validation (basic fields only).
- Logging setup.
- GUI shell (window, camera viewport widget, Start/Stop).
- Scene, single beacon, straight-line trajectory, virtual pan/tilt camera.
- **Packaging smoke test #1:** confirm `pyinstaller` can produce *any* running executable from the skeleton, even with a blank viewport — catches environment/packaging issues before real logic exists.

**Checkpoint:** beacon visibly moves on screen inside the packaged executable.

## Phase 2 — Perception Baseline (Tier 0 → 1)
- Classical CV detector (threshold → connected components → centroid).
- Centroid vs. ground-truth error computed and logged (no report yet, console/CSV only).
- Manual/open-loop or proportional-only camera follow.

**Checkpoint:** detector output matches the `Detection` schema (`06-api-contracts.md`); centroid error visible in a raw log.

## Phase 3 — Tracking & State Machine (Tier 1)
- Kalman tracker.
- Full state machine incl. `CANDIDATE → SEARCH` disconfirmation path.
- Acquisition-confirm logic (N consecutive frames).

**Checkpoint:** forced/simulated occlusion correctly drives `TRACK → PREDICT/REACQUIRE → TRACK` (or `→ SEARCH` on failure) without manual intervention.

## Phase 4 — Closed-Loop Control (Tier 1)
- Angle-space PID controller (`04-system-architecture.md` §4.13 — pixel→angle conversion implemented from the start, not retrofitted).
- Output saturation, anti-windup, deadband, integrator reset on SEARCH/ACQUIRE entry.
- All four required motion types wired in.

**Checkpoint:** stationary-target steady-state test (`02-user-stories-and-acceptance-criteria.md` US-C1/AC3) passes — no persistent oscillation.

## Phase 5 — Real-Time Metrics & Basic Reporting (Tier 1)
- Live metrics panel (FPS, error, lock status, acquisition time, pan/tilt).
- Basic CSV/JSON export + minimal summary.
- Config validation completed for all Tier 1 fields.
- **Packaging smoke test #2:** full Tier 1 build run start-to-finish on a machine without the dev environment.

**Checkpoint:** Tier 1 exit criterion met — a full Functional Verification dry run can be performed end to end.

*— Tier 1 complete. This is the first "safe" milestone: if nothing else ships, Functional Verification (20%) is coverable. —*

## Phase 6 — Disturbance Engine (Tier 2)
- Salt-and-pepper, Gaussian, Poisson noise (seeded RNG per `06-api-contracts.md` §5).
- Camera jitter, atmospheric presets, platform motion.
- Disturbance indicators in the UI.

**Checkpoint:** clean-scenario benchmark numbers do not regress when disturbances are toggled off (proves disturbance layer never touches ground truth).

## Phase 7 — Full Performance Dashboard & Reporting (Tier 2)
- RMSE, p95/p99 error, reacquisition avg/max, both FPS variants.
- Pass/fail table vs. official PS targets, visually separated from internal thresholds.
- Repeated-seed benchmark gate automation (`08-scoring-engine-spec.md` §5).

**Checkpoint:** Benchmark Performance-1 dry run produces a complete, correctly labeled report with no manual post-processing.

## Phase 8 — External MP4 Benchmark Adapter (Tier 2)
- `VideoFileFrameSource` implementation.
- Ground-truth availability handling: known-GT / manual-annotation / no-GT paths, all three tested.
- UI messaging that Mode B is perception-only unless GT exists (`03-information-architecture.md` §6).

**Checkpoint:** a sample MP4 with no annotation still produces a complete, correctly-labeled reference-free report; an annotated sample produces full error metrics.

*— Tier 2 complete. Benchmark Performance-1 and -2 (60% combined) are now coverable. —*

## Phase 9 — AI Detector & Fusion (Tier 3)
- AI detector matching the `Detector` contract.
- Fusion logic with provenance tracking.
- A/B comparison data collected (classical vs. AI vs. fused) for the technical report.

**Checkpoint:** removing the AI model entirely still leaves a fully functional, fully scorable application (single-point-of-failure check).

## Phase 10 — Replay, Comparison, Run Registry (Tier 3)
- SQLite run registry (`05-database-schema.md` §5).
- Replay screen (reconstructs from logged CSV/JSON, no re-execution).
- Comparison screen.

**Checkpoint:** two previously exported runs can be opened in Comparison without re-running the simulation.

## Phase 11 — Hardening, Documentation, Final Packaging
- Full scenario test suite run (`12-testing-strategy.md`).
- Technical report, user manual, optional demo video.
- Final standalone build, tested on a genuinely clean machine one more time.
- Repository/docs audit: confirm source matches every document in this set.

**Checkpoint:** `01-product-requirements.md` §14 (Definition of Done) fully satisfied.

## Phase-to-Tier Summary

| Phase | Tier | Unblocks |
|---|---|---|
| 1–5 | 0 → 1 | Functional Verification |
| 6–8 | 2 | Benchmark Performance-1 & -2 |
| 9–10 | 3 | Technical Evaluation novelty claims |
| 11 | — | Deliverables / final submission |

## Working Agreement
- Do not begin a phase's work until the previous phase's checkpoint is verifiably met (not just "mostly done").
- If time runs short, stop at the last fully-completed phase boundary — Tier 1 alone is a defensible, gradeable submission; a half-finished Tier 3 feature is not.
