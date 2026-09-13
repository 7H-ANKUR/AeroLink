# 09 — Engineering Scope Definition

## 1. Why This Document Exists (correction from earlier draft)

The original PRD's "MVP Scope" section listed effectively every functional requirement — full disturbance suite, MP4 mode, Kalman + PID, real-time metrics, standalone build — as equally mandatory for the MVP, with only AI/replay/comparison pushed to "post-MVP." That is not an achievable single milestone in a hackathon timeline; it's the full product. This document replaces the flat list with **four tiers**, each independently demo-able, so the team always has a working, presentable state even if later tiers slip.

## 2. Tier Definitions

### Tier 0 — Walking Skeleton (prove the architecture works end to end)
The smallest thing that exercises the full pipeline once, on a clean scenario, with no disturbances.

- Scene canvas + one beacon + straight-line motion.
- Virtual pan/tilt camera, manually or automatically following.
- Classical CV detector (threshold + centroid), no confidence scoring yet.
- Minimal GUI: camera viewport + Start/Stop.
- No Kalman, no PID (proportional-only or open-loop is acceptable here).

**Exit criterion:** a beacon moves on screen and the camera visibly tracks it, end to end, once, with no crash.

### Tier 1 — Core MVP (the PS's mandatory functions, clean conditions)
Everything required to look and behave like the described product, still without noise.

- All four required motions (straight, circular, figure-8, random).
- Kalman tracker with the full state machine (`SEARCH → CANDIDATE → ACQUIRE → TRACK → PREDICT/REACQUIRE`, including the CANDIDATE→SEARCH disconfirmation path).
- PID controller in angle-error space (`04-system-architecture.md` §4.13).
- Target-loss and reacquisition behavior, demonstrable on command (e.g. a "kill beacon" debug button).
- Real-time on-screen metrics (FPS, error, lock status, acquisition time).
- Configuration panel covering scenario + algorithm parameters (no disturbance panel yet).
- Config validation (`04-system-architecture.md` §9).
- Basic CSV/JSON logging and a minimal auto-generated report.
- First standalone-executable smoke test on a clean machine (moved early deliberately — see §5).

**Exit criterion:** Functional Verification (20% of grade) can be passed using Tier 1 alone.

### Tier 2 — Full Spec Compliance (matches every PRD functional requirement except stretch items)
- Full disturbance suite: salt-and-pepper, Gaussian, Poisson noise; camera jitter; all five atmospheric presets; platform motion (linear mandatory + at least one optional pattern).
- MP4 video benchmark mode, including the ground-truth availability handling and manual-annotation fallback from `08-scoring-engine-spec.md` §4.
- Full metrics set (RMSE, p95/p99 error, reacquisition avg/max, processing speed both variants) and full report (charts, pass/fail table).
- Repeated-seed benchmark gate (`08-scoring-engine-spec.md` §5).

**Exit criterion:** Benchmark Performance-1 and Benchmark Performance-2 (60% combined) are executable end to end.

### Tier 3 — Stretch / Differentiation
- AI detector + classical/AI fusion.
- Adaptive PID / confidence-aware control.
- Replay screen with overlays.
- Run comparison / experiment dashboard.
- SQLite run registry and Run History browser.
- Optional local monitoring API (`06-api-contracts.md` §7).

**Exit criterion:** supports Technical Evaluation novelty claims (20%) — only pursued once Tiers 0–2 are demo-stable.

## 3. Explicit Non-Goals (all tiers)

- Physical laser/PTZ hardware.
- Real UAV/satellite flight control.
- Real optical data transmission.
- Fine-pointing hardware control.
- A mandatory external ML dataset (none is provided by the PS).
- Any claim of physical-system certification.

## 4. Tier → Requirement Traceability

| FR (from `01-product-requirements.md`) | Tier |
|---|---|
| FR-01 Scenario config | 0 → 1 (disturbance fields added in 2) |
| FR-02 Virtual environment | 0 |
| FR-03 Beacon generation | 0 |
| FR-04 Target motion (required 4) | 1 |
| FR-04 (optional: spiral/sinusoidal/user-defined) | 2/3 |
| FR-05 Virtual camera | 0 |
| FR-06 Beacon detection | 0 (basic) → 1 (confidence/scoring) |
| FR-07 Continuous tracking | 1 |
| FR-08 Prediction | 1 |
| FR-09 Camera control | 1 |
| FR-10 Disturbance injection | 2 |
| FR-11 Real-time statistics | 1 |
| FR-12 Performance logging | 1 (basic) → 2 (full) |
| FR-13 External video | 2 |
| FR-14 Replay | 3 |
| FR-15 Experiment comparison | 3 |

## 5. Scope Decisions That Directly Fix Review Findings

1. **Packaging validated early, not last.** A PyInstaller smoke test on a machine without the dev environment is part of Tier 1's exit criterion, not deferred to a final "polish" phase — this was identified as a top deployment risk.
2. **Ground-truth fallback is Tier 2, not assumed away.** MP4 mode is not "done" until both the annotated-GT and no-GT code paths work, because it is unknown in advance whether evaluator videos include a reference track.
3. **Controller unit-conversion fix is baked into Tier 1**, not treated as a later refinement — an angle-space PID is part of the Tier 1 definition, not a Tier 2/3 improvement, because getting it wrong makes every later tuning pass unreliable.
4. **AI is strictly Tier 3.** The system must be demo-complete and fully scorable using only the classical pipeline; AI is additive, never a dependency.

## 6. Decision Rule for Adding Scope Mid-Development

Before pulling anything from Tier 2/3 forward, confirm:
- Tier 0's exit criterion still holds (no regression), and
- Tier 1 is fully passing its own exit criterion (Functional Verification demo-ready).

If either is false, work stays inside the current tier. This rule exists specifically to prevent the original flat-scope failure mode from recurring mid-project.
