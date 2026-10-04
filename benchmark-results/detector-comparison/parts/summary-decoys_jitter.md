# Detector comparison — classical vs learned vs hybrid

Generated 2026-09-29T10:53:01.981Z · 25s per run · 6 seeds per cell (4200, 4301, 4402, 4503, 4604, 4705).
Identical scenarios and seeds across detectors. Evaluation seeds are disjoint from every training seed range.
Learned stages executed on: **onnxruntime-web 1.30.0 (wasm, 1 thread)**.

CNN `beacon-roi-v2` (2989 parameters, locked smartphone-test F1 0.9589, locked stress-test F1 0.9975). Track verifier `track-verifier-v1` (locked-test F1 0.8083, AUC 0.9608).

## Arm A — perception on identical frames

Camera frozen, no Kalman prediction. "FA/empty" = detections reported on frames with no visible beacon.

| Condition | Detector | Precision | Recall | Miss rate | FA / empty frames | Localisation | Latency |
|---|---|---|---|---|---|---|---|
| Bright decoys + jitter | cv_classical | 0.236 | 0.991 | 0.009 | 3430 / 3430 | 0.88 px | 0.918 ms |
| Bright decoys + jitter | ai | 0.134 | 0.565 | 0.435 | 3430 / 3430 | 0.86 px | 8.773 ms |
| Bright decoys + jitter | fusion | 0.817 | 0.994 | 0.006 | 232 / 3430 | 0.90 px | 9.501 ms |

## Arm B — closed loop

Median across 6 seeds. "Diverged" = seeds whose mean tracking error exceeded 50 px (a false lock).
"Correct acq" = first time the lock was within the lock radius of the TRUE beacon (the PS acquisition gate counts any lock).
"Correct lock" = frames locked on the beacon / frames the beacon was in view. "Continuity" = longest unbroken correct lock.

| Condition | Detector | Median error | Correct lock | Correct acq | Continuity | Reacq | Diverged | Pipeline | FPS |
|---|---|---|---|---|---|---|---|---|---|
| Bright decoys + jitter | cv_classical | 460.82 px | 0.0 % | 0.12 s | 0.0 s | — | 4/6 | 0.51 ms | 2471 |
| Bright decoys + jitter | ai | 471.88 px | 1.7 % | 0.13 s | 0.1 s | — | 6/6 | 8.94 ms | 112 |
| Bright decoys + jitter | fusion | 114.15 px | 60.1 % | 4.67 s | 0.5 s | 0.78 s | 4/6 | 9.81 ms | 102 |

## Per-stage latency on the live 30 Hz loop (Phase 11)

Mean per frame over every closed-loop run of each detector, on this machine.

| Detector | CV stage | AI stage | Temporal verifier | Fusion | Total perception | Whole pipeline |
|---|---|---|---|---|---|---|
| cv_classical | 0.000 ms | 0.000 ms | 0.000 ms | 0.000 ms | 0.508 ms | 0.514 ms |
| ai | 0.000 ms | 8.902 ms | 0.000 ms | 0.000 ms | 8.913 ms | 8.936 ms |
| fusion | 0.969 ms | 8.666 ms | 0.125 ms | 0.010 ms | 9.787 ms | 9.807 ms |
