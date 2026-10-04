# Detector comparison — classical vs learned vs hybrid

Generated 2026-09-29T10:05:33.843Z · 25s per run · 6 seeds per cell (4200, 4301, 4402, 4503, 4604, 4705).
Identical scenarios and seeds across detectors. Evaluation seeds are disjoint from every training seed range.
Learned stages executed on: **onnxruntime-web 1.30.0 (wasm, 1 thread)**.

CNN `beacon-roi-v2` (2989 parameters, locked smartphone-test F1 0.9589, locked stress-test F1 0.9975). Track verifier `track-verifier-v1` (locked-test F1 0.8083, AUC 0.9608).

## Arm A — perception on identical frames

Camera frozen, no Kalman prediction. "FA/empty" = detections reported on frames with no visible beacon.

| Condition | Detector | Precision | Recall | Miss rate | FA / empty frames | Localisation | Latency |
|---|---|---|---|---|---|---|---|
| Heavy sensor noise | cv_classical | 0.358 | 1.000 | 0.000 | 2421 / 3150 | 0.83 px | 0.476 ms |
| Heavy sensor noise | ai | 0.375 | 0.964 | 0.036 | 2122 / 3150 | 0.81 px | 4.782 ms |
| Heavy sensor noise | fusion | 0.857 | 0.995 | 0.005 | 224 / 3150 | 0.83 px | 5.226 ms |

## Arm B — closed loop

Median across 6 seeds. "Diverged" = seeds whose mean tracking error exceeded 50 px (a false lock).
"Correct acq" = first time the lock was within the lock radius of the TRUE beacon (the PS acquisition gate counts any lock).
"Correct lock" = frames locked on the beacon / frames the beacon was in view. "Continuity" = longest unbroken correct lock.

| Condition | Detector | Median error | Correct lock | Correct acq | Continuity | Reacq | Diverged | Pipeline | FPS |
|---|---|---|---|---|---|---|---|---|---|
| Heavy sensor noise | cv_classical | 6.06 px | 95.9 % | 0.52 s | 22.1 s | — | 2/6 | 0.54 ms | 2031 |
| Heavy sensor noise | ai | 6.26 px | 95.8 % | 0.55 s | 15.9 s | — | 0/6 | 5.31 ms | 189 |
| Heavy sensor noise | fusion | 6.06 px | 95.9 % | 0.55 s | 22.1 s | 0.17 s | 1/6 | 5.91 ms | 173 |

## Per-stage latency on the live 30 Hz loop (Phase 11)

Mean per frame over every closed-loop run of each detector, on this machine.

| Detector | CV stage | AI stage | Temporal verifier | Fusion | Total perception | Whole pipeline |
|---|---|---|---|---|---|---|
| cv_classical | 0.000 ms | 0.000 ms | 0.000 ms | 0.000 ms | 0.528 ms | 0.545 ms |
| ai | 0.000 ms | 5.280 ms | 0.000 ms | 0.000 ms | 5.289 ms | 5.307 ms |
| fusion | 0.534 ms | 5.254 ms | 0.085 ms | 0.010 ms | 5.897 ms | 5.908 ms |
