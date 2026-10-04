# Detector comparison — classical vs learned vs hybrid

Generated 2026-09-29T10:18:10.892Z · 25s per run · 6 seeds per cell (4200, 4301, 4402, 4503, 4604, 4705).
Identical scenarios and seeds across detectors. Evaluation seeds are disjoint from every training seed range.
Learned stages executed on: **onnxruntime-web 1.30.0 (wasm, 1 thread)**.

CNN `beacon-roi-v2` (2989 parameters, locked smartphone-test F1 0.9589, locked stress-test F1 0.9975). Track verifier `track-verifier-v1` (locked-test F1 0.8083, AUC 0.9608).

## Arm A — perception on identical frames

Camera frozen, no Kalman prediction. "FA/empty" = detections reported on frames with no visible beacon.

| Condition | Detector | Precision | Recall | Miss rate | FA / empty frames | Localisation | Latency |
|---|---|---|---|---|---|---|---|
| Dim beacon (below threshold) | cv_classical | 0.000 | 0.000 | 1.000 | 0 / 3150 | — | 0.425 ms |
| Dim beacon (below threshold) | ai | 0.217 | 0.558 | 0.442 | 2123 / 3150 | 0.82 px | 4.878 ms |
| Dim beacon (below threshold) | fusion | 0.910 | 0.641 | 0.359 | 21 / 3150 | 0.80 px | 27.916 ms |

## Arm B — closed loop

Median across 6 seeds. "Diverged" = seeds whose mean tracking error exceeded 50 px (a false lock).
"Correct acq" = first time the lock was within the lock radius of the TRUE beacon (the PS acquisition gate counts any lock).
"Correct lock" = frames locked on the beacon / frames the beacon was in view. "Continuity" = longest unbroken correct lock.

| Condition | Detector | Median error | Correct lock | Correct acq | Continuity | Reacq | Diverged | Pipeline | FPS |
|---|---|---|---|---|---|---|---|---|---|
| Dim beacon (below threshold) | cv_classical | — | 0.0 % | — | 0.0 s | — | 0/6 | 0.25 ms | 3975 |
| Dim beacon (below threshold) | ai | 410.14 px | 31.1 % | 0.53 s | 4.0 s | — | 4/6 | 3.06 ms | 328 |
| Dim beacon (below threshold) | fusion | 6.11 px | 95.7 % | 1.70 s | 20.9 s | 0.84 s | 2/6 | 3.27 ms | 306 |

## Per-stage latency on the live 30 Hz loop (Phase 11)

Mean per frame over every closed-loop run of each detector, on this machine.

| Detector | CV stage | AI stage | Temporal verifier | Fusion | Total perception | Whole pipeline |
|---|---|---|---|---|---|---|
| cv_classical | 0.000 ms | 0.000 ms | 0.000 ms | 0.000 ms | 0.250 ms | 0.255 ms |
| ai | 0.000 ms | 3.042 ms | 0.000 ms | 0.000 ms | 3.047 ms | 3.061 ms |
| fusion | 0.274 ms | 2.936 ms | 0.041 ms | 0.003 ms | 3.261 ms | 3.271 ms |
