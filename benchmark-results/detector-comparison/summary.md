# Detector comparison — classical vs AI vs hybrid

Merged 2026-09-29T11:12:32.287Z from 14 parts · 25s per run · 6 seeds per cell (4200, 4301, 4402, 4503, 4604, 4705).
Identical scenarios and seeds across detectors. Evaluation seeds are disjoint from every training seed range and from the development seeds used for tuning.
Learned stages executed on: **onnxruntime-web 1.30.0 (wasm, 1 thread)**.

CNN `beacon-roi-v2` (2989 parameters, locked smartphone-test F1 0.9589, locked stress-test F1 0.9975). Track verifier locked-test F1 0.8083, AUC 0.9608.

## Arm A — perception on identical frames

Camera frozen, no Kalman prediction. "FA / empty" = detections reported on frames with no visible beacon.

| Condition | Detector | Precision | Recall | Miss rate | FA / empty frames | Localisation | Latency |
|---|---|---|---|---|---|---|---|
| Clear | cv_classical | 0.950 | 1.000 | 0.000 | 71 / 3150 | 0.83 px | 0.350 ms |
| Clear | ai | 0.375 | 0.961 | 0.039 | 2111 / 3150 | 0.80 px | 3.160 ms |
| Clear | fusion | 0.950 | 0.996 | 0.004 | 71 / 3150 | 0.83 px | 3.568 ms |
| Haze | cv_classical | 0.973 | 1.000 | 0.000 | 38 / 3150 | 0.83 px | 0.338 ms |
| Haze | ai | 0.277 | 0.712 | 0.288 | 2120 / 3150 | 0.81 px | 3.068 ms |
| Haze | fusion | 0.963 | 0.996 | 0.004 | 51 / 3150 | 0.83 px | 3.399 ms |
| Fog | cv_classical | 0.983 | 1.000 | 0.000 | 23 / 3150 | 0.83 px | 0.418 ms |
| Fog | ai | 0.443 | 0.968 | 0.032 | 1602 / 3150 | 0.80 px | 9.233 ms |
| Fog | fusion | 0.969 | 1.000 | 0.000 | 43 / 3150 | 0.83 px | 4.364 ms |
| Rain | cv_classical | 0.962 | 1.000 | 0.000 | 54 / 3150 | 0.83 px | 0.391 ms |
| Rain | ai | 0.308 | 0.866 | 0.134 | 2442 / 3150 | 0.80 px | 3.594 ms |
| Rain | fusion | 0.945 | 0.996 | 0.004 | 78 / 3150 | 0.83 px | 4.029 ms |
| Low light | cv_classical | 0.386 | 1.000 | 0.000 | 2145 / 3150 | 0.83 px | 0.413 ms |
| Low light | ai | 0.376 | 0.963 | 0.037 | 2111 / 3150 | 0.80 px | 112.497 ms |
| Low light | fusion | 0.913 | 0.996 | 0.004 | 128 / 3150 | 0.83 px | 4.289 ms |
| Heavy sensor noise | cv_classical | 0.358 | 1.000 | 0.000 | 2421 / 3150 | 0.83 px | 0.476 ms |
| Heavy sensor noise | ai | 0.375 | 0.964 | 0.036 | 2122 / 3150 | 0.81 px | 4.782 ms |
| Heavy sensor noise | fusion | 0.857 | 0.995 | 0.005 | 224 / 3150 | 0.83 px | 5.226 ms |
| Camera jitter | cv_classical | 0.946 | 1.000 | 0.000 | 77 / 3151 | 0.89 px | 0.417 ms |
| Camera jitter | ai | 0.378 | 0.970 | 0.030 | 2114 / 3151 | 0.87 px | 90.949 ms |
| Camera jitter | fusion | 0.917 | 0.995 | 0.005 | 119 / 3151 | 0.89 px | 4.374 ms |
| Optical blur + motion smear | cv_classical | 0.959 | 1.000 | 0.000 | 58 / 3131 | 0.76 px | 0.338 ms |
| Optical blur + motion smear | ai | 0.391 | 0.991 | 0.009 | 2105 / 3131 | 0.74 px | 3.043 ms |
| Optical blur + motion smear | fusion | 0.947 | 0.996 | 0.004 | 76 / 3131 | 0.76 px | 3.412 ms |
| Dim beacon (below threshold) | cv_classical | 0.000 | 0.000 | 1.000 | 0 / 3150 | — | 0.425 ms |
| Dim beacon (below threshold) | ai | 0.217 | 0.558 | 0.442 | 2123 / 3150 | 0.82 px | 4.878 ms |
| Dim beacon (below threshold) | fusion | 0.910 | 0.641 | 0.359 | 21 / 3150 | 0.80 px | 27.916 ms |
| Blinking beacon (reacquisition) | cv_classical | 0.949 | 1.000 | 0.000 | 61 / 3373 | 0.83 px | 0.332 ms |
| Blinking beacon (reacquisition) | ai | 0.319 | 0.957 | 0.043 | 2255 / 3373 | 0.79 px | 3.020 ms |
| Blinking beacon (reacquisition) | fusion | 0.948 | 0.996 | 0.004 | 61 / 3373 | 0.83 px | 3.397 ms |
| Bright decoys | cv_classical | 0.235 | 0.989 | 0.011 | 3432 / 3432 | 0.80 px | 0.389 ms |
| Bright decoys | ai | 0.135 | 0.569 | 0.431 | 3432 / 3432 | 0.77 px | 3.229 ms |
| Bright decoys | fusion | 0.854 | 1.000 | 0.000 | 183 / 3432 | 0.82 px | 3.583 ms |
| Bright decoys + noise | cv_classical | 0.096 | 0.403 | 0.597 | 3432 / 3432 | 0.81 px | 1.012 ms |
| Bright decoys + noise | ai | 0.084 | 0.353 | 0.647 | 3432 / 3432 | 0.77 px | 11.619 ms |
| Bright decoys + noise | fusion | 0.390 | 0.975 | 0.025 | 1598 / 3432 | 0.81 px | 12.105 ms |
| Bright decoys + jitter | cv_classical | 0.236 | 0.991 | 0.009 | 3430 / 3430 | 0.88 px | 0.918 ms |
| Bright decoys + jitter | ai | 0.134 | 0.565 | 0.435 | 3430 / 3430 | 0.86 px | 8.773 ms |
| Bright decoys + jitter | fusion | 0.817 | 0.994 | 0.006 | 232 / 3430 | 0.90 px | 9.501 ms |

## Arm B — closed loop

Median across 6 seeds. "Diverged" = seeds whose mean tracking error exceeded 50 px (a run that STARTS on a decoy and recovers can still count, because the mean includes the decoy period).
"Correct acq" = first time the lock was within the lock radius of the TRUE beacon (the PS acquisition gate counts any lock).
"Correct lock" = frames locked on the beacon / frames the beacon was in view. "Continuity" = longest unbroken correct lock.

| Condition | Detector | Median error | Correct lock | Correct acq | Continuity | Reacq | Diverged | Pipeline | FPS |
|---|---|---|---|---|---|---|---|---|---|
| Clear | cv_classical | 6.07 px | 95.6 % | 0.55 s | 22.1 s | — | 0/6 | 0.30 ms | 3439 |
| Clear | ai | 6.07 px | 96.3 % | 0.55 s | 22.9 s | — | 0/6 | 2.95 ms | 339 |
| Clear | fusion | 6.07 px | 95.6 % | 0.55 s | 22.1 s | — | 0/6 | 3.28 ms | 305 |
| Haze | cv_classical | 6.07 px | 95.6 % | 0.55 s | 22.1 s | — | 0/6 | 0.31 ms | 3237 |
| Haze | ai | 6.07 px | 95.6 % | 0.52 s | 22.1 s | — | 2/6 | 3.00 ms | 334 |
| Haze | fusion | 6.07 px | 95.6 % | 0.55 s | 22.1 s | — | 0/6 | 3.35 ms | 299 |
| Fog | cv_classical | 6.07 px | 95.6 % | 0.55 s | 22.1 s | — | 0/6 | 0.34 ms | 2989 |
| Fog | ai | 6.07 px | 96.3 % | 0.55 s | 22.9 s | — | 0/6 | 3.56 ms | 282 |
| Fog | fusion | 6.07 px | 95.6 % | 0.55 s | 22.1 s | — | 0/6 | 4.10 ms | 246 |
| Rain | cv_classical | 6.07 px | 95.6 % | 0.55 s | 22.0 s | — | 0/6 | 0.30 ms | 3312 |
| Rain | ai | 7.08 px | 93.6 % | 0.53 s | 10.1 s | — | 1/6 | 3.64 ms | 280 |
| Rain | fusion | 6.07 px | 96.0 % | 0.55 s | 22.7 s | 0.12 s | 0/6 | 3.52 ms | 284 |
| Low light | cv_classical | 6.07 px | 95.6 % | 0.52 s | 22.1 s | — | 2/6 | 0.30 ms | 3474 |
| Low light | ai | 6.07 px | 96.3 % | 0.55 s | 22.9 s | — | 0/6 | 2.95 ms | 339 |
| Low light | fusion | 6.07 px | 96.4 % | 0.55 s | 23.0 s | 0.10 s | 0/6 | 3.39 ms | 295 |
| Heavy sensor noise | cv_classical | 6.06 px | 95.9 % | 0.52 s | 22.1 s | — | 2/6 | 0.54 ms | 2031 |
| Heavy sensor noise | ai | 6.26 px | 95.8 % | 0.55 s | 15.9 s | — | 0/6 | 5.31 ms | 189 |
| Heavy sensor noise | fusion | 6.06 px | 95.9 % | 0.55 s | 22.1 s | 0.17 s | 1/6 | 5.91 ms | 173 |
| Camera jitter | cv_classical | 9.37 px | 58.3 % | 0.35 s | 0.4 s | — | 0/6 | 0.33 ms | 3076 |
| Camera jitter | ai | 9.37 px | 58.4 % | 0.35 s | 0.4 s | — | 0/6 | 3.84 ms | 270 |
| Camera jitter | fusion | 9.37 px | 57.8 % | 0.35 s | 0.4 s | 0.07 s | 0/6 | 3.56 ms | 283 |
| Optical blur + motion smear | cv_classical | 15.10 px | 21.5 % | 0.83 s | 0.6 s | — | 0/6 | 0.29 ms | 3605 |
| Optical blur + motion smear | ai | 15.13 px | 21.7 % | 0.83 s | 0.6 s | — | 0/6 | 2.88 ms | 348 |
| Optical blur + motion smear | fusion | 15.10 px | 21.5 % | 0.83 s | 0.6 s | — | 0/6 | 3.24 ms | 309 |
| Dim beacon (below threshold) | cv_classical | — | 0.0 % | — | 0.0 s | — | 0/6 | 0.25 ms | 3975 |
| Dim beacon (below threshold) | ai | 410.14 px | 31.1 % | 0.53 s | 4.0 s | — | 4/6 | 3.06 ms | 328 |
| Dim beacon (below threshold) | fusion | 6.11 px | 95.7 % | 1.70 s | 20.9 s | 0.84 s | 2/6 | 3.27 ms | 306 |
| Blinking beacon (reacquisition) | cv_classical | 10.55 px | 93.6 % | 1.53 s | 3.6 s | 0.44 s | 0/6 | 0.29 ms | 3485 |
| Blinking beacon (reacquisition) | ai | 32.88 px | 90.5 % | 1.82 s | 3.5 s | 0.44 s | 2/6 | 2.93 ms | 341 |
| Blinking beacon (reacquisition) | fusion | 10.55 px | 93.6 % | 1.53 s | 3.6 s | 0.44 s | 0/6 | 3.24 ms | 309 |
| Bright decoys | cv_classical | 460.81 px | 0.0 % | 0.10 s | 0.0 s | — | 4/6 | 0.37 ms | 2805 |
| Bright decoys | ai | 471.83 px | 2.9 % | 0.10 s | 0.2 s | — | 6/6 | 3.04 ms | 329 |
| Bright decoys | fusion | 17.19 px | 96.7 % | 1.38 s | 22.6 s | 0.51 s | 2/6 | 3.39 ms | 295 |
| Bright decoys + noise | cv_classical | 482.49 px | 0.0 % | 0.10 s | 0.0 s | — | 5/6 | 1.03 ms | 968 |
| Bright decoys + noise | ai | 515.55 px | 0.3 % | 0.73 s | 0.0 s | — | 6/6 | 11.60 ms | 86 |
| Bright decoys + noise | fusion | 16.94 px | 96.8 % | 1.03 s | 22.8 s | 0.07 s | 2/6 | 7.14 ms | 174 |
| Bright decoys + jitter | cv_classical | 460.82 px | 0.0 % | 0.12 s | 0.0 s | — | 4/6 | 0.51 ms | 2471 |
| Bright decoys + jitter | ai | 471.88 px | 1.7 % | 0.13 s | 0.1 s | — | 6/6 | 8.94 ms | 112 |
| Bright decoys + jitter | fusion | 114.15 px | 60.1 % | 4.67 s | 0.5 s | 0.78 s | 4/6 | 9.81 ms | 102 |

## Per-stage latency on the live loop (Phase 11)

Mean per frame over every closed-loop run of each detector, on this machine.

| Detector | CV stage | AI stage | Temporal verifier | Fusion | Total perception | Whole pipeline |
|---|---|---|---|---|---|---|
| cv_classical | 0.000 ms | 0.000 ms | 0.000 ms | 0.000 ms | 0.390 ms | 0.398 ms |
| ai | 0.000 ms | 4.416 ms | 0.000 ms | 0.000 ms | 4.424 ms | 4.437 ms |
| fusion | 0.409 ms | 3.910 ms | 0.056 ms | 0.005 ms | 4.390 ms | 4.400 ms |

## Mode 1 (full-frame) vs Mode 2 (ROI verification) — Phase 12

Mode 1 (full-frame): 822.2 ms/frame, recall 0.793, precision 0.192. Mode 2 (own proposals + ROI CNN): 9.92 ms/frame, recall 0.655, precision 0.211. Same 120 frames (clear, bright decoys, dim beacon). Frame budget at 30 Hz: 33.3 ms. Mode 1 is 83x slower.
