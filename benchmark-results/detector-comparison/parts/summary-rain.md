# Detector comparison — classical vs learned vs hybrid

Generated 2026-09-29T09:49:46.749Z · 25s per run · 6 seeds per cell (4200, 4301, 4402, 4503, 4604, 4705).
Identical scenarios and seeds across detectors. Evaluation seeds are disjoint from every training seed range.
Learned stages executed on: **onnxruntime-web 1.30.0 (wasm, 1 thread)**.

CNN `beacon-roi-v2` (2989 parameters, locked smartphone-test F1 0.9589, locked stress-test F1 0.9975). Track verifier `track-verifier-v1` (locked-test F1 0.8083, AUC 0.9608).

## Arm A — perception on identical frames

Camera frozen, no Kalman prediction. "FA/empty" = detections reported on frames with no visible beacon.

| Condition | Detector | Precision | Recall | Miss rate | FA / empty frames | Localisation | Latency |
|---|---|---|---|---|---|---|---|
| Rain | cv_classical | 0.962 | 1.000 | 0.000 | 54 / 3150 | 0.83 px | 0.391 ms |
| Rain | ai | 0.308 | 0.866 | 0.134 | 2442 / 3150 | 0.80 px | 3.594 ms |
| Rain | fusion | 0.945 | 0.996 | 0.004 | 78 / 3150 | 0.83 px | 4.029 ms |

## Arm B — closed loop

Median across 6 seeds. "Diverged" = seeds whose mean tracking error exceeded 50 px (a false lock).
"Correct acq" = first time the lock was within the lock radius of the TRUE beacon (the PS acquisition gate counts any lock).
"Correct lock" = frames locked on the beacon / frames the beacon was in view. "Continuity" = longest unbroken correct lock.

| Condition | Detector | Median error | Correct lock | Correct acq | Continuity | Reacq | Diverged | Pipeline | FPS |
|---|---|---|---|---|---|---|---|---|---|
| Rain | cv_classical | 6.07 px | 95.6 % | 0.55 s | 22.0 s | — | 0/6 | 0.30 ms | 3312 |
| Rain | ai | 7.08 px | 93.6 % | 0.53 s | 10.1 s | — | 1/6 | 3.64 ms | 280 |
| Rain | fusion | 6.07 px | 96.0 % | 0.55 s | 22.7 s | 0.12 s | 0/6 | 3.52 ms | 284 |

## Per-stage latency on the live 30 Hz loop (Phase 11)

Mean per frame over every closed-loop run of each detector, on this machine.

| Detector | CV stage | AI stage | Temporal verifier | Fusion | Total perception | Whole pipeline |
|---|---|---|---|---|---|---|
| cv_classical | 0.000 ms | 0.000 ms | 0.000 ms | 0.000 ms | 0.298 ms | 0.305 ms |
| ai | 0.000 ms | 3.618 ms | 0.000 ms | 0.000 ms | 3.625 ms | 3.637 ms |
| fusion | 0.334 ms | 3.116 ms | 0.046 ms | 0.005 ms | 3.511 ms | 3.519 ms |
