# 12 — Testing Strategy

## 1. Test Levels

### Unit Tests
- Trajectory equations (straight/circular/figure-8/random — position at a given `t` matches the analytic formula).
- Camera projection (pixel ↔ angle conversion, both directions — directly tests the `04-system-architecture.md` §4.13 fix).
- Noise generation (statistical properties under a fixed seed: reproducible, within expected distribution).
- Detector candidate filtering (area/aspect/brightness/shape thresholds individually).
- Centroid calculation (weighted centroid formula against hand-computed cases).
- Kalman prediction (predict-only step matches closed-form constant-velocity prediction).
- PID controller (step response, saturation, anti-windup, deadband, `dt=0` handling).
- Metric calculations (RMSE, loss %, lock retention — against hand-computed small fixtures).
- Configuration validation (every rule in `04-system-architecture.md` §9, both valid and invalid cases).

### Contract Tests (new — enforces `06-api-contracts.md`)
For each concrete implementation of `FrameSource`, `Detector`, `Tracker`, `Controller`, `DisturbanceModel`:
- Output shape/types match the dataclass exactly.
- `None`/missing-input handling (`detection=None`, `target_xy=None`) produces the contractually required behavior, not a crash or silent no-op.
- Confidence values stay within `[0,1]`.
- A `Controller` implementation is rejected by the contract suite if it accepts only pixel coordinates without `fov_deg`/`image_size_px` — this directly guards against the original unit-mismatch bug recurring in a future controller implementation.

### Integration Tests
- Target → camera → detector (does a known synthetic beacon get detected at the expected position).
- Detector → tracker → controller (does a synthetic detection sequence produce a stable, non-oscillating command sequence).
- Target loss → prediction → reacquisition (forced occlusion recovers within the configured timeout, and falls back to `SEARCH` if not).
- Simulator → logger → report (a short run produces a valid `events.csv` + `metrics.json` matching `05-database-schema.md`).
- Cross-thread integration: worker-thread processing loop + UI signal consumption runs for N frames with no dropped-frame count above a sanity threshold and no UI-thread blocking (`04-system-architecture.md` §6).

### Scenario Tests (end-to-end, seeded)
Minimum required set:
1. Straight motion / clear.
2. Circular / clear.
3. Figure-8 / clear.
4. Random / clear.
5. Straight + Gaussian noise.
6. Straight + salt-and-pepper.
7. Straight + Poisson.
8. Motion + camera jitter.
9. Haze / fog / rain / low-light (one scenario each).
10. Platform motion + target motion combined.
11. Temporary beacon disappearance (forced occlusion).
12. Multiple beacons (designated-target selection policy, `04-system-architecture.md` §4.9).
13. High combined-disturbance stress case.
14. MP4 input, known ground truth.
15. MP4 input, no ground truth (manual annotation path exercised).
16. MP4 input, no ground truth, no annotation (reference-free metrics path).

Scenarios 14–16 directly test the ground-truth-availability risk mitigation from `08-scoring-engine-spec.md` §4 — this was a gap in the original test list and is now explicit.

## 2. Benchmark Gate (repeated-seed, per `08-scoring-engine-spec.md` §5)

Before declaring a phase's checkpoint met (`10-development-phases.md`), run each applicable scenario across ≥5 seeds and record `[min, mean, max]` per gate metric:

```text
Gate: mean(acquisition_time_s) ≤ 2.0
Gate: mean(avg_error_px) ≤ 10.0     (GT-available scenarios only)
Gate: mean(loss_percent) < 5.0
Gate: mean(reacquisition_avg_s) ≤ 1.0
Gate: mean(algorithm_fps) ≥ 20.0
```

Record which scenarios pass/fail explicitly — never report blanket compliance from a single favorable run.

## 3. Failure-Mode Coverage (from the original risk lists, consolidated)

The system must be exercised against, at minimum:
1. Beacon immediately visible.
2. Beacon initially outside FOV.
3. Slow-moving beacon.
4. Fast-moving beacon.
5. Sudden direction change.
6. High image noise.
7. Camera jitter.
8. Platform motion.
9. Low light.
10. Temporary beacon disappearance.
11. Distractor bright spots.
12. Multiple beacons.
13. Detector false positive.
14. Video frame drop.
15. Combined severe disturbance.
16. Corrupt/invalid video file (fault-handling path, `04-system-architecture.md` §8).
17. Packaged executable on a clean machine (not a unit test — a manual/scripted smoke test, `11-environment-and-devops.md` §5).

## 4. Test Oracle Rules

- **Simulation:** ground truth is exact, generated analytically by the simulator — always available.
- **External MP4:** compute error/RMSE **only** when a ground-truth reference (evaluator-supplied or manually annotated) exists. When it doesn't, tests assert that the reference-free metric set is returned and that error fields are `null`, not a fabricated or extrapolated value — this is a testable, enforceable rule, not just a design intention.

## 5. AI/Model Testing (Tier 3)

- Train/test split by **scenario/seed**, never by randomly sampling adjacent frames — adjacent frames are near-duplicates and would leak information between train and test sets.
- A test confirms the AI detector is optional: disabling it (config flag or missing model file) must not break the pipeline, and the full contract/integration/scenario suite must still pass using the classical detector alone.
- Ablation test: classical-only vs. AI-only vs. fused, run on the same seeded scenario set, with results captured for the technical report's novelty claims (feeds `02-user-stories-and-acceptance-criteria.md` US-H2).

## 6. Non-Functional Testing

- **Performance:** scenario tests assert `algorithm_fps ≥ 20` and camera update ≥ 30 Hz on the team's lowest-spec test machine, not just a dev workstation.
- **Reliability/determinism:** running the same seed twice must produce byte-identical `events.csv` (or numerically identical within floating-point tolerance) — a dedicated determinism test, since this is asserted throughout the design but easy to silently break with an unseeded RNG call.
- **Usability:** a scripted "judge walkthrough" manual test — launch, load a predefined scenario, run it, export a report — with zero source-code edits, timed to fit inside the 10–15 minute Functional Verification window.

## 7. What Is Explicitly Out of Scope for Testing
- Physical hardware-in-the-loop testing (no physical PTZ/camera exists — Non-Goal per `09-engineering-scope-definition.md` §3).
- Load/stress testing beyond single-run desktop usage (not a multi-user server product).
- Security penetration testing (no network attack surface in the required build; the optional local monitoring API is loopback-only).
