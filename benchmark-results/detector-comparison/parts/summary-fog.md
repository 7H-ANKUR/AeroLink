# Detector comparison — classical vs learned vs hybrid

Generated 2026-09-29T09:48:13.063Z · 25s per run · 6 seeds per cell (4200, 4301, 4402, 4503, 4604, 4705).
Identical scenarios and seeds across detectors. Evaluation seeds are disjoint from every training seed range.
Learned stages executed on: **onnxruntime-web 1.30.0 (wasm, 1 thread)**.

CNN `beacon-roi-v2` (2989 parameters, locked smartphone-test F1 0.9589, locked stress-test F1 0.9975). Track verifier `track-verifier-v1` (locked-test F1 0.8083, AUC 0.9608).

## Arm A — perception on identical frames

Camera frozen, no Kalman prediction. "FA/empty" = detections reported on frames with no visible beacon.

| Condition | Detector | Precision | Recall | Miss rate | FA / empty frames | Localisation | Latency |
|---|---|---|---|---|---|---|---|
| Fog | cv_classical | 0.983 | 1.000 | 0.000 | 23 / 3150 | 0.83 px | 0.418 ms |
| Fog | ai | 0.443 | 0.968 | 0.032 | 1602 / 3150 | 0.80 px | 9.233 ms |
| Fog | fusion | 0.969 | 1.000 | 0.000 | 43 / 3150 | 0.83 px | 4.364 ms |

## Arm B — closed loop

Median across 6 seeds. "Diverged" = seeds whose mean tracking error exceeded 50 px (a false lock).
"Correct acq" = first time the lock was within the lock radius of the TRUE beacon (the PS acquisition gate counts any lock).
"Correct lock" = frames locked on the beacon / frames the beacon was in view. "Continuity" = longest unbroken correct lock.

| Condition | Detector | Median error | Correct lock | Correct acq | Continuity | Reacq | Diverged | Pipeline | FPS |
|---|---|---|---|---|---|---|---|---|---|
| Fog | cv_classical | 6.07 px | 95.6 % | 0.55 s | 22.1 s | — | 0/6 | 0.34 ms | 2989 |
| Fog | ai | 6.07 px | 96.3 % | 0.55 s | 22.9 s | — | 0/6 | 3.56 ms | 282 |
| Fog | fusion | 6.07 px | 95.6 % | 0.55 s | 22.1 s | — | 0/6 | 4.10 ms | 246 |

## Per-stage latency on the live 30 Hz loop (Phase 11)

Mean per frame over every closed-loop run of each detector, on this machine.

| Detector | CV stage | AI stage | Temporal verifier | Fusion | Total perception | Whole pipeline |
|---|---|---|---|---|---|---|
| cv_classical | 0.000 ms | 0.000 ms | 0.000 ms | 0.000 ms | 0.328 ms | 0.336 ms |
| ai | 0.000 ms | 3.536 ms | 0.000 ms | 0.000 ms | 3.543 ms | 3.556 ms |
| fusion | 0.376 ms | 3.633 ms | 0.052 ms | 0.008 ms | 4.084 ms | 4.096 ms |
