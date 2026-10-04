# The learned perception stack — what was built, how it runs, and what it was measured to do

FSOC-PAT's perception has two learned components on the live 30 Hz loop: a small CNN that judges
individual candidate spots, and a learned track verifier that judges a candidate's behaviour over
time. In the shipped browser application both execute in **ONNX Runtime Web** inside the
simulation Web Worker. This document is the model card for both, and records — including where
the result is negative — what the benchmark says they are worth.

> Every number below was produced by a script named next to it, on this repository's current
> source. Thresholds were chosen on validation splits or development seeds, never on the locked
> test sets or the evaluation seeds.

---

## 1. Model card

### 1.1 `beacon-roi-v2` — TinyBeaconNet (appearance)

| Field | Value |
|---|---|
| Task | P(this 24×24 region of interest contains the beacon) |
| Architecture | conv3×3 1→8, ReLU, maxpool2 · conv3×3 8→12, ReLU, maxpool2 · conv3×3 12→16, ReLU · global average pool · dense 16→16, ReLU · dense 16→1, sigmoid |
| Parameters | 2,989 |
| Input | `patches` float32 `[N, 1, 24, 24]` — crop at the candidate centroid with edge replication, minus the median of the 2-px border ring, ÷128, clipped to [−1, 2] (`cropAndNormalise` in `src/engine/nn.ts`, twin of `scripts/ai/common.py`) |
| Input resolution | 24×24 px ROIs cut from the 640×480 monochrome sensor frame at native resolution |
| Output | `p_beacon` float32 `[N, 1]`, sigmoid probability |
| Confidence thresholds | `ai` detector accepts its best proposal at ≥ 0.50; in the hybrid the CNN only vetoes below 0.35 (`AI_TRUST`), hard-rejects below 0.12 without temporal support, and an AI-branch-only spot needs ≥ 0.60 plus track verification (§4) |
| Training data | Zenodo laser-spot dataset, Intel D435 split (309 train / 76 valid images) → 49,406 + 12,488 ROI patches from 5,040 + 1,260 FSOC simulator images (incl. optical blur and exposure smear) |
| Training procedure | Stage A: real data only, Adam 2e-3, 40 epochs, cosine LR. Stage B: real + synthetic mixed, Adam 1e-3, 40 epochs. Dihedral flips/rotations, amplitude ×[0.75, 1.3], additive noise σ 0.035. Epoch selected on validation F1 only (`scripts/ai/train_roi.py`) |
| Locked tests | 56-image smartphone set (different camera, never fitted on): **F1 0.9589** (P 0.9558, R 0.9619). Unseen synthetic stress scenarios (disjoint seeds, bright decoys + heavy noise + fog/rain/low light + blur + smear): **F1 0.9975** |
| Weights | `public/models/beacon-roi-v2.bin` (11,956 B), sha256 `73f5b53c8826bbc683a887e841ed2bf987fa86c5e44ac2df351a64ce8bc3b151` |
| ONNX | `public/models/beacon-roi-v2.onnx` (14,422 B, opset 17), sha256 `1bb8a7ded0f6d9b1bd34b103e383ef66f1be33af3ae000f2f8b623a24e84ffbb` |
| Version | v2 (2026-09-27). v1 was trained without blur/smear or dim beacons; locked smartphone F1 0.9001 |

### 1.2 `track-verifier-v1` — learned track verifier (behaviour over time)

| Field | Value |
|---|---|
| Task | P(this candidate TRACK is the beacon) |
| Architecture | standardise (train-split mean/std, baked into the graph) → dense 8→12, ReLU → dense 12→1, sigmoid |
| Input | `features` float32 `[N, 8]`: mean CNN score, mean classical composite, mean size affinity, mean peak brightness, world speed (px/s ÷100, cap 4), speed reliability, speed × reliability, persistence (`TRACK_FEATURES`, `src/engine/candidate-tracks.ts`) |
| Output | `p_beacon` float32 `[N, 1]`, **calibrated** sigmoid probability |
| Confidence thresholds (validation-chosen) | established decoy: track age ≥ 30 and P ≤ 0.20 (on validation: 83.9 % of mature decoy samples rejected, 0.19 % of beacon samples); verified challenger: age ≥ 15 and P ≥ 0.75 (71.1 % of beacons, 2.19 % of decoys) and either incumbent ≤ 0.35 or a margin ≥ 0.35; AI-branch-only spot may start a lock at age ≥ 10 and P ≥ 0.5 |
| Training data | 29,180 track samples from 120 simulator recipes (camera driven by the closed loop), 5,955 validation from 30 disjoint recipes; locked test 7,415 from 30 further disjoint recipes (`scripts/ai/gen-track-dataset.ts`) |
| Training procedure | Unweighted BCE (a class-weighted first version inflated every probability and put a bright static decoy at 0.42 — see §6), Adam 3e-3, 40 epochs, epoch selected on validation log-loss (`scripts/ai/train_track_verifier.py`) |
| Locked test | P 0.913, R 0.725, F1 0.808, **AUC 0.961**, log-loss 0.257; mature tracks (age ≥ 30) AUC 0.971. Calibration: predicted 0.044 → observed 0.073; 0.497 → 0.699; 0.935 → 0.972 |
| Ablations (locked test AUC) | all features 0.961 · without CNN feature 0.962 · without motion features 0.942 · **CNN feature alone 0.755** |
| Weights | `public/models/track-verifier-v1.json`, sha256 `0c482259b8b4d152be4acb8fa3bbd2ed76a589b0203cad14cc5ec0943b2468a4` |
| ONNX | `public/models/track-verifier-v1.onnx` (1,196 B, opset 17), sha256 `c5fd64314968a0b0a5189f9dc02b313076beca9174b3e7221a40e8de729d67ad` |

### 1.3 Runtime

| Field | Value |
|---|---|
| Browser runtime | **onnxruntime-web 1.30.0**, WASM execution provider, 1 thread, no proxy worker, inside the simulation Web Worker (`src/lib/ort-runtime.ts`, `src/workers/simulation.worker.ts`) |
| Execution mode | CPU via WebAssembly (SIMD build `ort-wasm-simd-threaded.wasm`, served from `public/ort/` — no CDN, works offline). No GPU/WebGPU/WebGL provider is used; single-threaded WASM needs no cross-origin isolation |
| Headless runtime | The same `ort-runtime.ts` adapter under Bun (benchmark, tests) |
| In-engine forward pass | `src/engine/nn.ts` / `track-verifier.ts` — the same weights in TypeScript; used by the synchronous path and as the labelled fallback if ORT cannot start. Every frame's provenance records `aiRuntime` |
| Export | `scripts/ai/export_onnx.py` rebuilds both networks from the shipped weight files, exports with torch 2.14 (TorchScript exporter, opset 17), and fails unless onnxruntime reproduces PyTorch |
| Parity | ORT vs PyTorch: 3.6e-7 (CNN), 7.5e-8 (verifier). ORT vs TypeScript on a live browser frame: 5.5e-8. ORT and TypeScript paths make **identical decisions** on 240 closed-loop frames (`tests/ai-runtime.test.ts`) |
| Inference latency | Browser (Chrome 154, this machine): session creation 655–672 ms once; CNN batch of 1–6 ROIs 0.4–1.9 ms per frame. Full per-stage figures in §7 |
| Mode 1 (full-frame) | Implemented (`FullFrameNet`), benchmark-only: see §7 |

---

## 2. Data

### 2.1 Real data — Zenodo laser-spot set

| Split | Images | Use |
|---|---|---|
| `train` (Intel D435) | 309 | Stage A training |
| `valid` (Intel D435) | 76 | Stage A validation |
| `test` (smartphone) | 56 | **LOCKED** — cross-camera generalisation only |

Over the labelled training images the laser spot sits at the 91st brightness percentile on average
and is the frame maximum in only 21 % of them, so proposals are mined with a local-contrast
(top-hat) operator rather than a global threshold.

### 2.2 Synthetic data — the FSOC domain (plan Phase 3)

`scripts/gen-synthetic-dataset.ts` drives the **shipped `SimulationRunner`** across randomised
recipes: beacon position, size (5–20 px), intensity (0.25–1.0), shape, **optical blur (Gaussian
PSF σ 0.3–2.5 px)**, **exposure smear (4–25 ms, from beacon motion and mount slew)**, scene
clutter and decoy brightness, Gaussian / salt-and-pepper / Poisson noise, clear / haze / fog /
rain / low-light, camera jitter and platform motion.

| Split | Recipes | Images | Seeds |
|---|---|---|---|
| train | 180 | 5,040 | 700,000+ |
| valid | 45 | 1,260 | 900,000+ |
| **test_stress (LOCKED)** | 40 | 1,120 | 1,100,000+ |

The stress split is the plan's Phase 15 "completely unseen synthetic stress scenarios": bright
decoys always, heavy noise, bad atmosphere, strong blur and smear, dim beacons, shake.

Ground truth is used to write labels, and only there.

---

## 3. Architecture on the live path

```
                       OBSERVED FRAME (640×480, after the disturbance chain)
                                   │
             ┌─────────────────────┴─────────────────────┐
             ▼                                           ▼
     CLASSICAL CV BRANCH                          AI BRANCH
  threshold → components →                local-contrast proposer
  weighted centroid (≤12)                 (no threshold, ≤6 spots)
             └─────────────────────┬─────────────────────┘
                                   ▼
                     merged candidates (cv | ai | both)
                                   ▼
             CNN beacon-roi-v2 — ONNX Runtime Web, one batch per frame
                                   ▼
        CANDIDATE TRACK BANK — world coordinates from the mount's own pose,
        common-mode shake removal, least-squares world velocity, clutter map
                                   ▼
             TRACK VERIFIER track-verifier-v1 — ONNX Runtime Web
                                   ▼
                DECISION ENGINE (fusion.ts): CV + CNN veto + Kalman
                proximity + track verifier + hysteresis + hard gates
                                   ▼
          KALMAN → LOS → PID → MOUNT → camera update (unchanged)
```

Four detectors implement one interface, so the tracker, controller, mount and metrics are
identical in every configuration:

| `tracking.detector` | What runs |
|---|---|
| `cv_classical` | Classical branch only |
| `ai` | AI branch only: its own proposals scored by the CNN |
| `fusion` | Both branches + temporal verification + decision engine |
| `ai_fullframe` | The CNN applied densely over the whole frame (Mode 1) — benchmark-only |

The two branches read the same frame buffer. The detector interface has five parameters, none a
truth channel; `tests/ai-integrity.test.ts` inspects the source of every perception file,
including `ort-runtime.ts`, and fails if a ground-truth token appears.

---

## 4. Why a temporal verifier was needed

The first evaluation showed every detector — classical, learned and hybrid — false-locking onto
bright decoys (4–6 of 6 seeds). Tracing those runs gave one mechanism every time: the beacon
starts outside the sensor window, a decoy is locked by frame 3, and lock hysteresis holds it even
after the beacon flies into view.

A single frame cannot fix that: PS-169 lets the beacon be 5–20 px and the decoys are 6–15 px, so a
decoy is a plausible beacon on appearance alone. The ablation confirms it — the CNN score alone
separates beacon tracks from decoy tracks at AUC 0.755; with world-motion evidence the verifier
reaches 0.961. The decoys are fixed in the world and the beacon is on a mobile terminal.

The decision engine uses the verifier in four places:

1. **Established decoy** — a track ≥ 30 frames old at P ≤ 0.20 is rejected even where the Kalman
   filter predicts it (the filter predicts the decoy *because* it has been tracking it).
2. **Clutter map** — rejected decoys are remembered in world coordinates; a cold search will not
   lock onto them again.
3. **Verified switch** — a mature challenger at P ≥ 0.75 may take the lock from an incumbent the
   verifier doubts (≤ 0.35) or clearly prefers less (margin ≥ 0.35); when it does, proximity to the
   incumbent's own Kalman prediction is treated as neutral. The tracker re-confirms the new target
   and logs the switch as a loss and a reacquisition.
4. **AI-branch-only spots** — a spot the threshold cannot see at all may start a lock only after
   its track is ≥ 10 frames old at P ≥ 0.5.

---

## 5. Honesty mechanisms

- **Ground truth cannot reach any perception stage** — source inspection in
  `tests/ai-integrity.test.ts` and `tests/ai-runtime.test.ts`.
- **No AI claim without a model** — the learned detectors refuse to construct without weights;
  the hybrid refuses without its verifier; nothing falls back to classical CV behind an AI label.
- **Runtime is recorded, not assumed** — every frame's provenance names the runtime that produced
  the AI scores; the browser test fails if any perception-chain line is not ONNX Runtime Web.
- **Live parity** — each browser run logs the same ROI scored by ORT and by the TypeScript pass.
- **Thresholds from validation / development data only** — §1.2, §6.

---

## 6. What changed after measurement (recorded, not absorbed)

| Finding | Where found | Change |
|---|---|---|
| A class-weighted verifier put a bright static decoy at P 0.42 (8 % beacon in the data) | development trace | retrained unweighted, epoch chosen on log-loss → 0.12 |
| Two AI proposals near each other were labelled "found by both branches" | development trace | merge compares AI spots against classical candidates only |
| The hybrid chased dim static decoys during cold search; blinking-beacon acquisition 6–10 s vs ~1 s classical | development seeds 9100+ (`scripts/dev-seeds.ts`) | AI-only spots need track verification before starting a lock |
| A beacon-lookalike decoy (bright, right size, static) sits at P ≈ 0.5 and was never "doubted" | development seed 9248 (`scripts/dev-seeds.ts`) | relative verified-switch rule (margin ≥ 0.35) |
| The browser worker could start a run before the model/ORT finished loading | browser verification | `start` waits for `init` |
| Relative asset URLs failed in the bundled worker, silently disabling every learned detector in the browser | browser verification | asset URLs anchored to the worker's origin; load errors surfaced |

The first-pass evaluation (before the development-seed fixes) is kept at
`benchmark-results/detector-comparison/summary-v2-first-pass.md`.

---

## 7. What the benchmark says

Source: `benchmark-results/detector-comparison/summary.md` — 13 conditions × 3 detectors × 6 seeds
(4200 + 101k, disjoint from all training and development seeds), 25 s per run, **learned stages
executed on onnxruntime-web 1.30.0 (wasm, 1 thread)**, the runtime the browser ships. Produced by
`bash scripts/eval-resumable.sh`. The pre-fix first pass is kept in
`summary-v2-first-pass.md` for comparison.

### 7.1 Closed loop — median correct-lock % · diverged seeds

"Correct lock" counts frames on the TRUE beacon (the PS gates count any lock). "Diverged" = run mean
error > 50 px; a run that starts on a decoy and then recovers can still count as diverged because
its mean includes the decoy period.

| Condition | Classical | AI branch alone | Hybrid |
|---|---|---|---|
| Clear | 95.6 % · 0/6 | 96.3 % · 0/6 | 95.6 % · 0/6 |
| Haze | 95.6 % · 0/6 | 95.6 % · 2/6 | 95.6 % · 0/6 |
| Fog | 95.6 % · 0/6 | 96.3 % · 0/6 | 95.6 % · 0/6 |
| Rain | 95.6 % · 0/6 | 93.6 % · 1/6 | 96.0 % · 0/6 |
| Low light | 95.6 % · 2/6 | 96.3 % · 0/6 | 96.4 % · 0/6 |
| Heavy sensor noise | 95.9 % · 2/6 | 95.8 % · 0/6 | 95.9 % · 1/6 |
| Camera jitter | 58.3 % · 0/6 | 58.4 % · 0/6 | 57.8 % · 0/6 |
| Optical blur + motion smear | 21.5 % · 0/6 | 21.7 % · 0/6 | 21.5 % · 0/6 |
| Dim beacon (below threshold) | 0.0 % · 0/6 | 31.1 % · 4/6 | 95.7 % · 2/6 |
| Blinking beacon (reacquisition) | 93.6 % · 0/6 | 90.5 % · 2/6 | 93.6 % · 0/6 |
| Bright decoys | 0.0 % · 4/6 | 2.9 % · 6/6 | 96.7 % · 2/6 |
| Bright decoys + noise | 0.0 % · 5/6 | 0.3 % · 6/6 | 96.8 % · 2/6 |
| Bright decoys + jitter | 0.0 % · 4/6 | 1.7 % · 6/6 | 60.1 % · 4/6 |

### 7.2 Perception on identical frames — precision / recall / false alarms on empty frames

| Condition | Classical | AI branch alone | Hybrid |
|---|---|---|---|
| Clear | 0.950 / 1.000 / 71 | 0.375 / 0.961 / 2111 | 0.950 / 0.996 / 71 |
| Haze | 0.973 / 1.000 / 38 | 0.277 / 0.712 / 2120 | 0.963 / 0.996 / 51 |
| Fog | 0.983 / 1.000 / 23 | 0.443 / 0.968 / 1602 | 0.969 / 1.000 / 43 |
| Rain | 0.962 / 1.000 / 54 | 0.308 / 0.866 / 2442 | 0.945 / 0.996 / 78 |
| Low light | 0.386 / 1.000 / 2145 | 0.376 / 0.963 / 2111 | 0.913 / 0.996 / 128 |
| Heavy sensor noise | 0.358 / 1.000 / 2421 | 0.375 / 0.964 / 2122 | 0.857 / 0.995 / 224 |
| Camera jitter | 0.946 / 1.000 / 77 | 0.378 / 0.970 / 2114 | 0.917 / 0.995 / 119 |
| Optical blur + motion smear | 0.959 / 1.000 / 58 | 0.391 / 0.991 / 2105 | 0.947 / 0.996 / 76 |
| Dim beacon (below threshold) | 0.000 / 0.000 / 0 | 0.217 / 0.558 / 2123 | 0.910 / 0.641 / 21 |
| Blinking beacon (reacquisition) | 0.949 / 1.000 / 61 | 0.319 / 0.957 / 2255 | 0.948 / 0.996 / 61 |
| Bright decoys | 0.235 / 0.989 / 3432 | 0.135 / 0.569 / 3432 | 0.854 / 1.000 / 183 |
| Bright decoys + noise | 0.096 / 0.403 / 3432 | 0.084 / 0.353 / 3432 | 0.390 / 0.975 / 1598 |
| Bright decoys + jitter | 0.236 / 0.991 / 3430 | 0.134 / 0.565 / 3430 | 0.817 / 0.994 / 232 |

### 7.3 Complementary strengths and weaknesses — the conclusion the numbers support

The hybrid does **not** improve every condition, and this section says where it does not.

**Where the hybrid is clearly better**
- **Bright decoys** (the problem the plan was about): classical and the AI branch false-lock in 4–6
  of 6 seeds with 0–3 % correct lock; the hybrid holds the true beacon ~97 % of the time with
  bright decoys and with bright decoys + noise. In perception, false alarms on empty frames fall
  from 3,432 of 3,432 to 183 (decoys) and to 1,598 (decoys + noise).
- **Beacon below the classical threshold** (dim): classical never sees it (0 %); the hybrid's
  independent AI branch plus temporal verification holds it 95.7 % of the time.
- **Low light and heavy sensor noise** in perception: precision 0.386 → 0.913 and 0.358 → 0.857,
  because the verifier rejects the static clutter those conditions lift over the threshold. In the
  closed loop, low light goes from 2/6 diverged seeds to 0/6, heavy noise from 2/6 to 1/6.

**Where it is equal** — clear, haze, fog, rain, jitter, blur + smear, blinking beacon: the hybrid
matches classical within a fraction of a percent in the closed loop. It adds nothing there,
because classical CV was already right.

**Where no detector does well** — camera jitter (~58 % correct lock) and optical blur + motion
smear (~21.5 %) are limited for all three configurations alike. Those losses are in tracking and
control (the lock radius is 10 px; ±16 px/frame shake and a 20 ms smear at speed 2 move the
beacon's measured centre by more than that), not in perception, so a better detector cannot
recover them.

**Where it is worse, or costs something**
- **Latency:** 4.4 ms per frame against 0.45 ms for classical (this machine, hard scenario;
  p95 6.3 ms) — still ~7× inside the 33 ms budget, but ten times the cost.
- **Dim beacon acquisition is slower** (correct acquisition 1.70 s vs 0.57 s in the first pass), and
  2 of 6 seeds exceed the 50 px divergence mark: a spot only the AI branch can see must now prove
  itself over ≥ 10 frames before it may start a lock. That rule is what fixed the blinking-beacon
  and rain regressions of the first pass (§6); it is a deliberate trade, not a free win.
- **Bright decoys + camera jitter** is only partly solved: 60 % correct lock (classical 0 %), with 4
  of 6 seeds still diverging. Jitter of up to ±14 px/frame corrupts the short-window motion estimate
  that separates the beacon from static decoys.
- **Heavy noise perception**: a few more false alarms than on a clean scene (224 of 3,150 empty
  frames), and one closed-loop seed still diverges (classical: two).
- **Arm A dim recall is 0.641**, because without a Kalman prediction an AI-only spot is not accepted
  until its track is mature.

**The AI branch on its own should not be used.** Its proposer finds dim static decoys that classical
CV never sees, and the CNN — which by construction cannot judge size (PS-169 beacon 5–20 px, decoys
6–15 px) — accepts them: ~2,100 false alarms per 3,150 empty frames in every condition, 4/6 diverged
on the dim beacon, 6/6 on bright decoys. Its value is as a *branch* feeding the verifier.

**Mode 1 vs Mode 2 (Phase 12):** Mode 1 (full-frame): 822.2 ms/frame, recall 0.793, precision 0.192. Mode 2 (own proposals + ROI CNN): 9.92 ms/frame, recall 0.655, precision 0.211. Same 120 frames (clear, bright decoys, dim beacon). Frame budget at 30 Hz: 33.3 ms. Mode 1 is 83x slower.

### 7.4 Latency on this machine (`bun scripts/bench-latency.ts`)

12th Gen Intel(R) Core(TM) i3-1215U, 8 threads, runtime onnxruntime-web 1.30.0 (wasm, 1 thread); bright decoys + noise + jitter.

| Detector | Perception mean / p95 | Pipeline mean / p95 | FPS | 30 Hz budget |
|---|---|---|---|---|
| cv_classical | 0.42 / 0.58 ms | 0.45 / 0.65 ms | 2238 | within |
| ai | 4.00 / 6.05 ms | 4.03 / 6.10 ms | 248 | within |
| fusion | 4.40 / 6.30 ms | 4.42 / 6.32 ms | 226 | within |
| ai_fullframe (Mode 1) | 288 ms | — | — | OVER |

Inside the browser (Chrome 154, same machine): ONNX Runtime Web session creation 655–672 ms once per
run; CNN inference 0.4–1.9 ms per frame for 1–6 ROIs. The evaluation's first merge showed a 66.5 ms
mean pipeline for the hybrid on bright decoys + noise; it did not reproduce (six seeds re-profiled
in isolation: 10.6–11.1 ms; the cell re-measured: 7.1 ms, identical tracking results) and is kept
in `parts/superseded/`.

