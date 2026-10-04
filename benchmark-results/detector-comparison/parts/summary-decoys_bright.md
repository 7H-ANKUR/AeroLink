# Detector comparison — classical vs learned vs hybrid

Generated 2026-09-29T10:20:43.348Z · 25s per run · 6 seeds per cell (4200, 4301, 4402, 4503, 4604, 4705).
Identical scenarios and seeds across detectors. Evaluation seeds are disjoint from every training seed range.
Learned stages executed on: **onnxruntime-web 1.30.0 (wasm, 1 thread)**.

CNN `beacon-roi-v2` (2989 parameters, locked smartphone-test F1 0.9589, locked stress-test F1 0.9975). Track verifier `track-verifier-v1` (locked-test F1 0.8083, AUC 0.9608).

## Arm A — perception on identical frames

Camera frozen, no Kalman prediction. "FA/empty" = detections reported on frames with no visible beacon.

| Condition | Detector | Precision | Recall | Miss rate | FA / empty frames | Localisation | Latency |
|---|---|---|---|---|---|---|---|
| Bright decoys | cv_classical | 0.235 | 0.989 | 0.011 | 3432 / 3432 | 0.80 px | 0.389 ms |
| Bright decoys | ai | 0.135 | 0.569 | 0.431 | 3432 / 3432 | 0.77 px | 3.229 ms |
| Bright decoys | fusion | 0.854 | 1.000 | 0.000 | 183 / 3432 | 0.82 px | 3.583 ms |

## Arm B — closed loop

Median across 6 seeds. "Diverged" = seeds whose mean tracking error exceeded 50 px (a false lock).
"Correct acq" = first time the lock was within the lock radius of the TRUE beacon (the PS acquisition gate counts any lock).
"Correct lock" = frames locked on the beacon / frames the beacon was in view. "Continuity" = longest unbroken correct lock.

| Condition | Detector | Median error | Correct lock | Correct acq | Continuity | Reacq | Diverged | Pipeline | FPS |
|---|---|---|---|---|---|---|---|---|---|
| Bright decoys | cv_classical | 460.81 px | 0.0 % | 0.10 s | 0.0 s | — | 4/6 | 0.37 ms | 2805 |
| Bright decoys | ai | 471.83 px | 2.9 % | 0.10 s | 0.2 s | — | 6/6 | 3.04 ms | 329 |
| Bright decoys | fusion | 17.19 px | 96.7 % | 1.38 s | 22.6 s | 0.51 s | 2/6 | 3.39 ms | 295 |

## Per-stage latency on the live 30 Hz loop (Phase 11)

Mean per frame over every closed-loop run of each detector, on this machine.

| Detector | CV stage | AI stage | Temporal verifier | Fusion | Total perception | Whole pipeline |
|---|---|---|---|---|---|---|
| cv_classical | 0.000 ms | 0.000 ms | 0.000 ms | 0.000 ms | 0.362 ms | 0.367 ms |
| ai | 0.000 ms | 3.025 ms | 0.000 ms | 0.000 ms | 3.030 ms | 3.038 ms |
| fusion | 0.361 ms | 2.970 ms | 0.042 ms | 0.004 ms | 3.385 ms | 3.393 ms |
