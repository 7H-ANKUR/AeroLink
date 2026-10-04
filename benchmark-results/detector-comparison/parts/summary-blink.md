# Detector comparison — classical vs learned vs hybrid

Generated 2026-09-29T10:19:25.184Z · 25s per run · 6 seeds per cell (4200, 4301, 4402, 4503, 4604, 4705).
Identical scenarios and seeds across detectors. Evaluation seeds are disjoint from every training seed range.
Learned stages executed on: **onnxruntime-web 1.30.0 (wasm, 1 thread)**.

CNN `beacon-roi-v2` (2989 parameters, locked smartphone-test F1 0.9589, locked stress-test F1 0.9975). Track verifier `track-verifier-v1` (locked-test F1 0.8083, AUC 0.9608).

## Arm A — perception on identical frames

Camera frozen, no Kalman prediction. "FA/empty" = detections reported on frames with no visible beacon.

| Condition | Detector | Precision | Recall | Miss rate | FA / empty frames | Localisation | Latency |
|---|---|---|---|---|---|---|---|
| Blinking beacon (reacquisition) | cv_classical | 0.949 | 1.000 | 0.000 | 61 / 3373 | 0.83 px | 0.332 ms |
| Blinking beacon (reacquisition) | ai | 0.319 | 0.957 | 0.043 | 2255 / 3373 | 0.79 px | 3.020 ms |
| Blinking beacon (reacquisition) | fusion | 0.948 | 0.996 | 0.004 | 61 / 3373 | 0.83 px | 3.397 ms |

## Arm B — closed loop

Median across 6 seeds. "Diverged" = seeds whose mean tracking error exceeded 50 px (a false lock).
"Correct acq" = first time the lock was within the lock radius of the TRUE beacon (the PS acquisition gate counts any lock).
"Correct lock" = frames locked on the beacon / frames the beacon was in view. "Continuity" = longest unbroken correct lock.

| Condition | Detector | Median error | Correct lock | Correct acq | Continuity | Reacq | Diverged | Pipeline | FPS |
|---|---|---|---|---|---|---|---|---|---|
| Blinking beacon (reacquisition) | cv_classical | 10.55 px | 93.6 % | 1.53 s | 3.6 s | 0.44 s | 0/6 | 0.29 ms | 3485 |
| Blinking beacon (reacquisition) | ai | 32.88 px | 90.5 % | 1.82 s | 3.5 s | 0.44 s | 2/6 | 2.93 ms | 341 |
| Blinking beacon (reacquisition) | fusion | 10.55 px | 93.6 % | 1.53 s | 3.6 s | 0.44 s | 0/6 | 3.24 ms | 309 |

## Per-stage latency on the live 30 Hz loop (Phase 11)

Mean per frame over every closed-loop run of each detector, on this machine.

| Detector | CV stage | AI stage | Temporal verifier | Fusion | Total perception | Whole pipeline |
|---|---|---|---|---|---|---|
| cv_classical | 0.000 ms | 0.000 ms | 0.000 ms | 0.000 ms | 0.287 ms | 0.293 ms |
| ai | 0.000 ms | 2.922 ms | 0.000 ms | 0.000 ms | 2.926 ms | 2.934 ms |
| fusion | 0.290 ms | 2.904 ms | 0.032 ms | 0.002 ms | 3.235 ms | 3.242 ms |
