# Detector comparison — classical vs learned vs hybrid

Generated 2026-09-29T10:13:37.436Z · 25s per run · 6 seeds per cell (4200, 4301, 4402, 4503, 4604, 4705).
Identical scenarios and seeds across detectors. Evaluation seeds are disjoint from every training seed range.
Learned stages executed on: **onnxruntime-web 1.30.0 (wasm, 1 thread)**.

CNN `beacon-roi-v2` (2989 parameters, locked smartphone-test F1 0.9589, locked stress-test F1 0.9975). Track verifier `track-verifier-v1` (locked-test F1 0.8083, AUC 0.9608).

## Arm A — perception on identical frames

Camera frozen, no Kalman prediction. "FA/empty" = detections reported on frames with no visible beacon.

| Condition | Detector | Precision | Recall | Miss rate | FA / empty frames | Localisation | Latency |
|---|---|---|---|---|---|---|---|
| Camera jitter | cv_classical | 0.946 | 1.000 | 0.000 | 77 / 3151 | 0.89 px | 0.417 ms |
| Camera jitter | ai | 0.378 | 0.970 | 0.030 | 2114 / 3151 | 0.87 px | 90.949 ms |
| Camera jitter | fusion | 0.917 | 0.995 | 0.005 | 119 / 3151 | 0.89 px | 4.374 ms |

## Arm B — closed loop

Median across 6 seeds. "Diverged" = seeds whose mean tracking error exceeded 50 px (a false lock).
"Correct acq" = first time the lock was within the lock radius of the TRUE beacon (the PS acquisition gate counts any lock).
"Correct lock" = frames locked on the beacon / frames the beacon was in view. "Continuity" = longest unbroken correct lock.

| Condition | Detector | Median error | Correct lock | Correct acq | Continuity | Reacq | Diverged | Pipeline | FPS |
|---|---|---|---|---|---|---|---|---|---|
| Camera jitter | cv_classical | 9.37 px | 58.3 % | 0.35 s | 0.4 s | — | 0/6 | 0.33 ms | 3076 |
| Camera jitter | ai | 9.37 px | 58.4 % | 0.35 s | 0.4 s | — | 0/6 | 3.84 ms | 270 |
| Camera jitter | fusion | 9.37 px | 57.8 % | 0.35 s | 0.4 s | 0.07 s | 0/6 | 3.56 ms | 283 |

## Per-stage latency on the live 30 Hz loop (Phase 11)

Mean per frame over every closed-loop run of each detector, on this machine.

| Detector | CV stage | AI stage | Temporal verifier | Fusion | Total perception | Whole pipeline |
|---|---|---|---|---|---|---|
| cv_classical | 0.000 ms | 0.000 ms | 0.000 ms | 0.000 ms | 0.319 ms | 0.328 ms |
| ai | 0.000 ms | 3.819 ms | 0.000 ms | 0.000 ms | 3.827 ms | 3.840 ms |
| fusion | 0.323 ms | 3.177 ms | 0.042 ms | 0.004 ms | 3.554 ms | 3.562 ms |
