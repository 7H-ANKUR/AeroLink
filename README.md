# FSOC-PAT — Virtual Coarse Alignment Laboratory

Software-only laboratory for **coarse pointing, acquisition and tracking (PAT)** of mobile
free-space optical communication terminals.
SIH 2026 — Problem Statement 169 (Dept. of Space / ISRO), software category.

A virtual optical beacon moves through a simulated scene. A virtual receiver — camera on a
pan/tilt mount — must find it, lock onto it, hold the lock through noise, weather and vibration,
survive losing the signal, and reacquire. Every number the application shows is produced by that
loop running; nothing is scripted, animated or pre-recorded.

> **Software only.** There is no laser, telescope, gimbal, photodetector, UAV or satellite in this
> project, and nothing here has been validated against optical hardware. Terms like *virtual
> receiver*, *virtual pan/tilt mount* and *simulated optical link* are meant literally.

---

## Quick start

Requires [Bun](https://bun.sh) 1.x (the project is developed against 1.4).
Node 18+ works for the app but the test and benchmark scripts use Bun's test runner.

```bash
bun install          # install dependencies
bun run db:generate  # generate the Prisma client for the run registry
bun run dev          # development server on http://localhost:3000
```

Production build:

```bash
bun run build
bun run start        # serves the standalone build on :3000
```

No API keys, cloud services or internet access are required for the simulation, the benchmark or
the demonstration. The only stored state is a local SQLite file (`db/custom.db`) used as a run
registry; `DATABASE_URL` in `.env` points at it with a repo-relative path.

---

## Judge demonstration

Open the app and press **RUN JUDGE DEMONSTRATION** on the launch screen. One button, fixed seed
(`20260920`), 60 seconds, no configuration.

It runs a deterministic scenario that forces the whole causal chain to happen in order:

```
beacon near the FOV edge, moving on a figure-8
  → receiver searches
  → detector finds the beacon in the image
  → candidate confirmed over N frames
  → pixel error converted to angular/LOS error
  → PID produces a pan/tilt rate command
  → mount slews under bounded dynamics
  → boresight converges, coarse lock acquired  (t+1.47 s)
  → haze + sensor noise injected               (t+18 s)
  → platform vibration + camera jitter         (t+24 s)
  → conditions restored                        (t+31 s)
  → beacon occulted for 7 s                    (t+34 s)  ← the stress case
  → Kalman prediction carries 0.93 s, then an active search sweep
  → beacon returns; relock 2.63 s later
  → report generated
```

The same run can be executed without a browser, which is how the results below were produced:

```bash
bun scripts/judge-demo.ts
```

Measured on the current source:

| Metric | Measured | PS-169 gate | |
|---|---|---|---|
| Acquisition time | 1.467 s | ≤ 2 s | PASS |
| Average tracking error | 2.508 px | ≤ 10 px | PASS |
| Centroiding error | 0.843 px | — | — |
| Algorithm FPS | ~1,900 | ≥ 20 | PASS |
| Target loss | 16.556 % | < 5 % | **FAIL** |
| Reacquisition | 9.567 s | ≤ 1 s | **FAIL** |

**The last two gates fail, and that is reported rather than hidden.** This scenario removes the
beacon from the scene for 7 seconds. Reacquisition is measured from loss-confirmed, so it includes
the time the beacon was absent — no algorithm can reacquire a target that is not there. The
figure that actually measures the software is the **2.63 s relock after the beacon returns**. The
14-scenario benchmark, where outages are short, is where those two gates are met.

13/13 mission phases reached, 0 integrity-check failures.

---

## Perception: classical, learned, or hybrid

The detector is switchable at run time from **Tracking → Perception** in the control panel. The
tracker, controller, mount and metrics are identical in all configurations, so switching changes
perception and nothing else.

| Option | What runs |
|---|---|
| `cv_classical` | Threshold, connected components, intensity-weighted centroid. No learned component. |
| `ai` | The learned branch alone: its own local-contrast proposer (no threshold) and `TinyBeaconNet`, a 2,989-parameter CNN, scoring a 24×24 crop of each spot. |
| `fusion` | Both branches propose independently; every candidate is scored by the CNN, followed as a track in world coordinates and judged over time by a learned **track verifier**; the decision engine arbitrates with the Kalman prediction, lock hysteresis and a clutter map of known decoys. |
| `ai_fullframe` | The same CNN applied densely over the whole frame (Mode 1). Benchmark-only — too slow for the 30 Hz loop. |

**In the shipped browser app both networks run in ONNX Runtime Web** (1.30.0, WASM, inside the
simulation Web Worker), loaded from `public/models/*.onnx`. Every frame's provenance names the
runtime that produced the AI scores, and every run logs a live parity check of ORT against the
in-engine TypeScript forward pass on a real frame. `bun scripts/browser-e2e.ts` drives the
production build in a real Chrome and verifies the whole chain — frame → CV → AI (ORT) → fusion →
Kalman → PID → mount → camera — from what the UI displays.

The CNN was trained in PyTorch on the public Zenodo laser-spot dataset, then fine-tuned on
simulator images including optical blur and exposure smear: **F1 0.9589 on a locked 56-image
smartphone test set from a different camera**, and F1 0.9975 on locked, unseen synthetic stress
scenarios. The track verifier reaches AUC 0.961 on locked test recipes; on its own the CNN's
appearance score separates beacon from decoy tracks at only AUC 0.755 — which is why the temporal
stage exists.

**The learned options are disabled when no model is deployed, and never silently fall back to
classical CV.** `docs/AI-DETECTOR.md` is the model card (architecture, data, training, files and
hashes, input/output, thresholds, latency, runtime) and records where the learned configurations
are *worse* than classical CV.

---

## Commands

| Command | What it does |
|---|---|
| `bun run dev` | Development server |
| `bun run build` | Production build |
| `bun run start` | Serve the production build |
| `bun test tests/` | Unit, integration and anti-cheating suites |
| `bun scripts/batch-test.ts` | 14 PS-169 scenarios × 5 seeds, writes `benchmark-results/` |
| `bun scripts/judge-demo.ts` | The §22 demonstration, headless |
| `bun scripts/sim-test.ts [seed\|PS169-xx] [sec]` | Single headless run with per-frame trace |
| `bun scripts/distractor-demo.ts` | 12-decoy rejection demonstration |
| `bun scripts/reacq-latency-test.ts` | Reacquisition gate decomposition |
| `bun scripts/mp4-demo.ts <file.mp4>` | External MP4 through the perception pipeline |
| `bun scripts/generate-sample-reports.ts` | Generate sample deliverables into `download/` (not kept in the repository) |
| `bun scripts/gen-synthetic-dataset.ts` | Generate the FSOC synthetic training set (PNG + YOLO labels) |
| `python scripts/ai/build_roi_dataset.py` | Build ROI patch datasets from real + synthetic images |
| `python scripts/ai/train_roi.py` | Two-stage training; writes `public/models/` and the parity fixture |
| `bun scripts/eval-detectors.ts` | Classical vs AI vs hybrid, both arms, learned stages in ONNX Runtime Web (`--runtime ts` for the TypeScript pass) |
| `bash scripts/eval-resumable.sh` | The same evaluation, one resumable part per condition, merged by `scripts/eval-merge.ts` (survives an interrupted run) |
| `bun scripts/dev-seeds.ts` | Development-seed harness (disjoint from evaluation seeds) used for every post-first-pass tuning decision |
| `python scripts/ai/export_onnx.py` | Export both trained networks to ONNX and verify them against PyTorch |
| `bun scripts/ai/gen-track-dataset.ts` / `python scripts/ai/train_track_verifier.py` | Harvest candidate tracks / train the track verifier |
| `bun scripts/browser-e2e.ts` | Real-browser verification of the ORT runtime path (needs `bun run build && bun run start`) |
| `bun scripts/bench-latency.ts` | Per-stage latency on this machine — run it on the judge machine |
| `bun run lint` / `bunx tsc --noEmit` | Lint / typecheck |

---

## How it is put together

```
src/engine/          pure TypeScript, no browser APIs — runs in the worker AND headless
  scene.ts           2000×2000 scene, beacon and decoy rendering
  trajectories.ts    six analytic beacon paths, seeded
  camera.ts          virtual camera, sensor crop, disturbance chain
  mount.ts           receiver pan/tilt mount: rate + acceleration limits
  detector.ts        threshold → connected components → weighted centroid → confidence
  detectors.ts       the BeaconDetector interface + registry (classical / learned / hybrid)
  nn.ts              pure-TS inference for the trained model — no runtime dependency
  detector-ai.ts     learned ROI verifier and the hybrid detector
  fusion.ts          decision engine: CV + learned + Kalman proximity + lock hysteresis
  kalman.ts          constant-velocity filter
  tracker.ts         SEARCH / CANDIDATE / ACQUIRE / TRACK / PREDICT_REACQUIRE
  pid.ts             angle-space PID + search scan pattern
  pipeline.ts        one frame: detect → track → control → metrics
  simulation.ts      THE canonical frame loop — worker, benchmark, demos and tests all use it
  metrics.ts         every PS-169 gate is computed here and nowhere else
  mission.ts         mission phases + live integrity checks (observers only)
  link.ts            SIMULATED optical link model
  demo.ts            the judge-demonstration scenario and injection timeline
src/workers/         the browser loop: pacing, event log, telemetry snapshots
src/components/      console UI
scripts/             headless runners and demonstrations
tests/               unit, integration, anti-cheating
```

### Two rules the code enforces

**Ground truth never reaches perception or control.** It is carried on the frame packet but
branches only to the metrics engine. `tests/engine-evidence.test.ts` asserts this by inspecting the
source of `detector.ts`, `tracker.ts`, `kalman.ts` and `pid.ts` — the suite fails if anyone wires it
in later.

**The mount is the only thing that moves the camera.** The controller produces a rate command; the
mount applies saturation and a finite acceleration limit and integrates it into the pose. Commanded
and achieved rates are separate values, both shown in the telemetry panel.

---

## Verifying it yourself

```bash
bun test tests/               # 86 tests, incl. the anti-cheating and model-parity suites
bun scripts/batch-test.ts     # 14/14 scenarios pass all five gates
bun scripts/judge-demo.ts     # 13/13 phases, all gates pass
```

`bun scripts/batch-test.ts` writes a timestamped directory under `benchmark-results/` containing
`raw-runs.json` (the full result and config for all 70 runs), `aggregate.json` (per-scenario means
and gate verdicts) and `per-seed.csv`.

Two diagnostic switches exist specifically to show the system is doing real work
(`tracking.controllerEnabled`, `tracking.detectorEnabled`): turning the controller off leaves the
mount motionless; turning the detector off prevents acquisition entirely.

---

## Current limitations

These are real and deliberately listed:

- **The learned model cannot reject bright decoys, and this is structural, not a training bug.**
  PS-169 makes the beacon's size a user parameter (5–20 px), so the model is trained to accept a
  bright compact spot anywhere in that range. The scene's decoys are 6–15 px — a strict *subset* of
  the beacon's own size range. "Wrong size" is therefore not a property the model is permitted to
  learn, and it scores bright decoys as beacons. Classical CV escapes this only because it is given
  the run-specific configured size and penalises off-size blobs. This is the reason the hybrid
  detector keeps the classical stage rather than replacing it. See `docs/AI-DETECTOR.md` §6.
- **Reacquisition after a long blackout is bounded by mount slew, not by the algorithm.** A ~1 s
  outage recovers during the prediction phase in ~0.1 s. A 7 s blackout relocks 2.63 s after the
  beacon returns, because the mount has to sweep back to wherever it reappeared under real rate and
  acceleration limits.
- **Single beacon.** The config schema accepts up to 5; rendering and tracking handle one.
- **MP4 mode is perception-only.** Recorded pixels cannot be re-pointed, so the controller's
  commands are computed and logged but cannot close the loop. Without supplied ground truth the
  geometric metrics are reported as unavailable rather than estimated.
- **MP4 ground-truth import** accepts one JSON shape; it is not yet format-tolerant.
- **The `low_light` atmosphere model brightens the scene.** The airlight term
  `(1 - brightnessFactor) * 90` in `applyDisturbances` is physically reasonable for haze and fog,
  where scattered light genuinely veils the image, but it adds a +41 grey-level pedestal in
  `low_light` — so a decoy at level 82 is lifted to 107 and clears the detection threshold of 90.
  Low light should darken. This is left unchanged rather than silently retuned, because every
  published benchmark number was measured with the current model; it is recorded here as a known
  modelling defect.
- **A false lock on a static object is not recoverable.** If the beacon is outside the sensor
  window at startup and a decoy clears the threshold, the tracker can lock onto it and hold that
  lock indefinitely — while `target_loss_percent` reports 0 %, because the metric measures whether
  a lock was *held*, not whether it was *correct*. `bun scripts/eval-detectors.ts` counts these as
  diverged seeds rather than averaging them away.

`IMPLEMENTATION_STATUS.md` holds the component-by-component audit, including what each claim is
backed by.
