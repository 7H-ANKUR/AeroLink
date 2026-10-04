# Detector comparison — classical vs learned vs hybrid

Generated 2026-09-29T10:49:35.315Z · 25s per run · 6 seeds per cell (4200, 4301, 4402, 4503, 4604, 4705).
Identical scenarios and seeds across detectors. Evaluation seeds are disjoint from every training seed range.
Learned stages executed on: **onnxruntime-web 1.30.0 (wasm, 1 thread)**.

CNN `beacon-roi-v2` (2989 parameters, locked smartphone-test F1 0.9589, locked stress-test F1 0.9975). Track verifier `track-verifier-v1` (locked-test F1 0.8083, AUC 0.9608).

## Arm A — perception on identical frames

Camera frozen, no Kalman prediction. "FA/empty" = detections reported on frames with no visible beacon.

| Condition | Detector | Precision | Recall | Miss rate | FA / empty frames | Localisation | Latency |
|---|---|---|---|---|---|---|---|
| Bright decoys + noise | cv_classical | 0.096 | 0.403 | 0.597 | 3432 / 3432 | 0.81 px | 0.442 ms |
| Bright decoys + noise | ai | 0.084 | 0.353 | 0.647 | 3432 / 3432 | 0.77 px | 4.366 ms |
| Bright decoys + noise | fusion | 0.390 | 0.975 | 0.025 | 1598 / 3432 | 0.81 px | 4.645 ms |

## Arm B — closed loop

Median across 6 seeds. "Diverged" = seeds whose mean tracking error exceeded 50 px (a false lock).
"Correct acq" = first time the lock was within the lock radius of the TRUE beacon (the PS acquisition gate counts any lock).
"Correct lock" = frames locked on the beacon / frames the beacon was in view. "Continuity" = longest unbroken correct lock.

| Condition | Detector | Median error | Correct lock | Correct acq | Continuity | Reacq | Diverged | Pipeline | FPS |
|---|---|---|---|---|---|---|---|---|---|
| Bright decoys + noise | cv_classical | 482.49 px | 0.0 % | 0.10 s | 0.0 s | — | 5/6 | 0.98 ms | 1093 |
| Bright decoys + noise | ai | 515.55 px | 0.3 % | 0.73 s | 0.0 s | — | 6/6 | 11.50 ms | 87 |
| Bright decoys + noise | fusion | 16.94 px | 96.8 % | 1.03 s | 22.8 s | 0.07 s | 2/6 | 66.53 ms | 67 |

## Per-stage latency on the live 30 Hz loop (Phase 11)

Mean per frame over every closed-loop run of each detector, on this machine.

| Detector | CV stage | AI stage | Temporal verifier | Fusion | Total perception | Whole pipeline |
|---|---|---|---|---|---|---|
| cv_classical | 0.000 ms | 0.000 ms | 0.000 ms | 0.000 ms | 0.953 ms | 0.978 ms |
| ai | 0.000 ms | 11.444 ms | 0.000 ms | 0.000 ms | 11.459 ms | 11.498 ms |
| fusion | 1.067 ms | 65.255 ms | 0.154 ms | 0.013 ms | 66.506 ms | 66.530 ms |
