# Detector comparison — classical vs learned vs hybrid

Generated 2026-09-29T09:59:27.310Z · 25s per run · 6 seeds per cell (4200, 4301, 4402, 4503, 4604, 4705).
Identical scenarios and seeds across detectors. Evaluation seeds are disjoint from every training seed range.
Learned stages executed on: **onnxruntime-web 1.30.0 (wasm, 1 thread)**.

CNN `beacon-roi-v2` (2989 parameters, locked smartphone-test F1 0.9589, locked stress-test F1 0.9975). Track verifier `track-verifier-v1` (locked-test F1 0.8083, AUC 0.9608).

## Arm A — perception on identical frames

Camera frozen, no Kalman prediction. "FA/empty" = detections reported on frames with no visible beacon.

| Condition | Detector | Precision | Recall | Miss rate | FA / empty frames | Localisation | Latency |
|---|---|---|---|---|---|---|---|
| Low light | cv_classical | 0.386 | 1.000 | 0.000 | 2145 / 3150 | 0.83 px | 0.413 ms |
| Low light | ai | 0.376 | 0.963 | 0.037 | 2111 / 3150 | 0.80 px | 112.497 ms |
| Low light | fusion | 0.913 | 0.996 | 0.004 | 128 / 3150 | 0.83 px | 4.289 ms |

## Arm B — closed loop

Median across 6 seeds. "Diverged" = seeds whose mean tracking error exceeded 50 px (a false lock).
"Correct acq" = first time the lock was within the lock radius of the TRUE beacon (the PS acquisition gate counts any lock).
"Correct lock" = frames locked on the beacon / frames the beacon was in view. "Continuity" = longest unbroken correct lock.

| Condition | Detector | Median error | Correct lock | Correct acq | Continuity | Reacq | Diverged | Pipeline | FPS |
|---|---|---|---|---|---|---|---|---|---|
| Low light | cv_classical | 6.07 px | 95.6 % | 0.52 s | 22.1 s | — | 2/6 | 0.30 ms | 3474 |
| Low light | ai | 6.07 px | 96.3 % | 0.55 s | 22.9 s | — | 0/6 | 2.95 ms | 339 |
| Low light | fusion | 6.07 px | 96.4 % | 0.55 s | 23.0 s | 0.10 s | 0/6 | 3.39 ms | 295 |

## Per-stage latency on the live 30 Hz loop (Phase 11)

Mean per frame over every closed-loop run of each detector, on this machine.

| Detector | CV stage | AI stage | Temporal verifier | Fusion | Total perception | Whole pipeline |
|---|---|---|---|---|---|---|
| cv_classical | 0.000 ms | 0.000 ms | 0.000 ms | 0.000 ms | 0.298 ms | 0.304 ms |
| ai | 0.000 ms | 2.932 ms | 0.000 ms | 0.000 ms | 2.938 ms | 2.948 ms |
| fusion | 0.316 ms | 3.013 ms | 0.041 ms | 0.004 ms | 3.381 ms | 3.388 ms |
