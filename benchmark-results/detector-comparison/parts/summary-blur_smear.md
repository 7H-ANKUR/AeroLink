# Detector comparison — classical vs learned vs hybrid

Generated 2026-09-29T10:14:55.190Z · 25s per run · 6 seeds per cell (4200, 4301, 4402, 4503, 4604, 4705).
Identical scenarios and seeds across detectors. Evaluation seeds are disjoint from every training seed range.
Learned stages executed on: **onnxruntime-web 1.30.0 (wasm, 1 thread)**.

CNN `beacon-roi-v2` (2989 parameters, locked smartphone-test F1 0.9589, locked stress-test F1 0.9975). Track verifier `track-verifier-v1` (locked-test F1 0.8083, AUC 0.9608).

## Arm A — perception on identical frames

Camera frozen, no Kalman prediction. "FA/empty" = detections reported on frames with no visible beacon.

| Condition | Detector | Precision | Recall | Miss rate | FA / empty frames | Localisation | Latency |
|---|---|---|---|---|---|---|---|
| Optical blur + motion smear | cv_classical | 0.959 | 1.000 | 0.000 | 58 / 3131 | 0.76 px | 0.338 ms |
| Optical blur + motion smear | ai | 0.391 | 0.991 | 0.009 | 2105 / 3131 | 0.74 px | 3.043 ms |
| Optical blur + motion smear | fusion | 0.947 | 0.996 | 0.004 | 76 / 3131 | 0.76 px | 3.412 ms |

## Arm B — closed loop

Median across 6 seeds. "Diverged" = seeds whose mean tracking error exceeded 50 px (a false lock).
"Correct acq" = first time the lock was within the lock radius of the TRUE beacon (the PS acquisition gate counts any lock).
"Correct lock" = frames locked on the beacon / frames the beacon was in view. "Continuity" = longest unbroken correct lock.

| Condition | Detector | Median error | Correct lock | Correct acq | Continuity | Reacq | Diverged | Pipeline | FPS |
|---|---|---|---|---|---|---|---|---|---|
| Optical blur + motion smear | cv_classical | 15.10 px | 21.5 % | 0.83 s | 0.6 s | — | 0/6 | 0.29 ms | 3605 |
| Optical blur + motion smear | ai | 15.13 px | 21.7 % | 0.83 s | 0.6 s | — | 0/6 | 2.88 ms | 348 |
| Optical blur + motion smear | fusion | 15.10 px | 21.5 % | 0.83 s | 0.6 s | — | 0/6 | 3.24 ms | 309 |

## Per-stage latency on the live 30 Hz loop (Phase 11)

Mean per frame over every closed-loop run of each detector, on this machine.

| Detector | CV stage | AI stage | Temporal verifier | Fusion | Total perception | Whole pipeline |
|---|---|---|---|---|---|---|
| cv_classical | 0.000 ms | 0.000 ms | 0.000 ms | 0.000 ms | 0.284 ms | 0.289 ms |
| ai | 0.000 ms | 2.861 ms | 0.000 ms | 0.000 ms | 2.866 ms | 2.875 ms |
| fusion | 0.302 ms | 2.883 ms | 0.037 ms | 0.003 ms | 3.233 ms | 3.240 ms |
