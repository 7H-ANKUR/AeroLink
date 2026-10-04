# Detector comparison — classical vs learned vs hybrid

Generated 2026-09-29T09:44:45.470Z · 25s per run · 6 seeds per cell (4200, 4301, 4402, 4503, 4604, 4705).
Identical scenarios and seeds across detectors. Evaluation seeds are disjoint from every training seed range.
Learned stages executed on: **onnxruntime-web 1.30.0 (wasm, 1 thread)**.

CNN `beacon-roi-v2` (2989 parameters, locked smartphone-test F1 0.9589, locked stress-test F1 0.9975). Track verifier `track-verifier-v1` (locked-test F1 0.8083, AUC 0.9608).

## Arm A — perception on identical frames

Camera frozen, no Kalman prediction. "FA/empty" = detections reported on frames with no visible beacon.

| Condition | Detector | Precision | Recall | Miss rate | FA / empty frames | Localisation | Latency |
|---|---|---|---|---|---|---|---|
| Clear | cv_classical | 0.950 | 1.000 | 0.000 | 71 / 3150 | 0.83 px | 0.350 ms |
| Clear | ai | 0.375 | 0.961 | 0.039 | 2111 / 3150 | 0.80 px | 3.160 ms |
| Clear | fusion | 0.950 | 0.996 | 0.004 | 71 / 3150 | 0.83 px | 3.568 ms |

## Arm B — closed loop

Median across 6 seeds. "Diverged" = seeds whose mean tracking error exceeded 50 px (a false lock).
"Correct acq" = first time the lock was within the lock radius of the TRUE beacon (the PS acquisition gate counts any lock).
"Correct lock" = frames locked on the beacon / frames the beacon was in view. "Continuity" = longest unbroken correct lock.

| Condition | Detector | Median error | Correct lock | Correct acq | Continuity | Reacq | Diverged | Pipeline | FPS |
|---|---|---|---|---|---|---|---|---|---|
| Clear | cv_classical | 6.07 px | 95.6 % | 0.55 s | 22.1 s | — | 0/6 | 0.30 ms | 3439 |
| Clear | ai | 6.07 px | 96.3 % | 0.55 s | 22.9 s | — | 0/6 | 2.95 ms | 339 |
| Clear | fusion | 6.07 px | 95.6 % | 0.55 s | 22.1 s | — | 0/6 | 3.28 ms | 305 |

## Per-stage latency on the live 30 Hz loop (Phase 11)

Mean per frame over every closed-loop run of each detector, on this machine.

| Detector | CV stage | AI stage | Temporal verifier | Fusion | Total perception | Whole pipeline |
|---|---|---|---|---|---|---|
| cv_classical | 0.000 ms | 0.000 ms | 0.000 ms | 0.000 ms | 0.290 ms | 0.296 ms |
| ai | 0.000 ms | 2.941 ms | 0.000 ms | 0.000 ms | 2.947 ms | 2.955 ms |
| fusion | 0.299 ms | 2.925 ms | 0.038 ms | 0.003 ms | 3.273 ms | 3.281 ms |
