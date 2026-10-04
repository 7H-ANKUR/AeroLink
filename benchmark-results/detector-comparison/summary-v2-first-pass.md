# Detector comparison — classical vs learned vs hybrid

Generated 2026-09-27T13:22:19.164Z · 25s per run · 6 seeds per cell (4200, 4301, 4402, 4503, 4604, 4705).
Identical scenarios and seeds across detectors. Evaluation seeds are disjoint from every training seed range.

CNN `beacon-roi-v2` (2989 parameters, locked smartphone-test F1 0.9589, locked stress-test F1 0.9975). Track verifier `track-verifier-v1` (locked-test F1 0.8083, AUC 0.9608).

## Arm A — perception on identical frames

Camera frozen, no Kalman prediction. "FA/empty" = detections reported on frames with no visible beacon.

| Condition | Detector | Precision | Recall | Miss rate | FA / empty frames | Localisation | Latency |
|---|---|---|---|---|---|---|---|
| Clear | cv_classical | 0.950 | 1.000 | 0.000 | 71 / 3150 | 0.83 px | 0.397 ms |
| Clear | ai | 0.375 | 0.961 | 0.039 | 2111 / 3150 | 0.80 px | 14.680 ms |
| Clear | fusion | 0.913 | 0.996 | 0.004 | 128 / 3150 | 0.83 px | 4.706 ms |
| Haze | cv_classical | 0.973 | 1.000 | 0.000 | 38 / 3150 | 0.83 px | 0.302 ms |
| Haze | ai | 0.277 | 0.712 | 0.288 | 2120 / 3150 | 0.81 px | 3.681 ms |
| Haze | fusion | 0.926 | 0.996 | 0.004 | 108 / 3150 | 0.83 px | 3.697 ms |
| Fog | cv_classical | 0.983 | 1.000 | 0.000 | 23 / 3150 | 0.83 px | 0.301 ms |
| Fog | ai | 0.443 | 0.968 | 0.032 | 1602 / 3150 | 0.80 px | 3.515 ms |
| Fog | fusion | 0.949 | 1.000 | 0.000 | 72 / 3150 | 0.83 px | 3.607 ms |
| Rain | cv_classical | 0.962 | 1.000 | 0.000 | 54 / 3150 | 0.83 px | 0.302 ms |
| Rain | ai | 0.308 | 0.866 | 0.134 | 2442 / 3150 | 0.80 px | 3.973 ms |
| Rain | fusion | 0.872 | 0.992 | 0.008 | 197 / 3150 | 0.83 px | 4.034 ms |
| Low light | cv_classical | 0.386 | 1.000 | 0.000 | 2145 / 3150 | 0.83 px | 0.320 ms |
| Low light | ai | 0.376 | 0.963 | 0.037 | 2111 / 3150 | 0.80 px | 3.875 ms |
| Low light | fusion | 0.913 | 0.996 | 0.004 | 128 / 3150 | 0.83 px | 3.872 ms |
| Heavy sensor noise | cv_classical | 0.358 | 1.000 | 0.000 | 2421 / 3150 | 0.83 px | 0.444 ms |
| Heavy sensor noise | ai | 0.375 | 0.964 | 0.036 | 2122 / 3150 | 0.81 px | 6.146 ms |
| Heavy sensor noise | fusion | 0.835 | 0.995 | 0.005 | 265 / 3150 | 0.83 px | 7.569 ms |
| Camera jitter | cv_classical | 0.946 | 1.000 | 0.000 | 77 / 3151 | 0.89 px | 0.321 ms |
| Camera jitter | ai | 0.378 | 0.970 | 0.030 | 2114 / 3151 | 0.87 px | 3.986 ms |
| Camera jitter | fusion | 0.877 | 0.994 | 0.006 | 188 / 3151 | 0.89 px | 3.982 ms |
| Optical blur + motion smear | cv_classical | 0.959 | 1.000 | 0.000 | 58 / 3131 | 0.76 px | 0.320 ms |
| Optical blur + motion smear | ai | 0.391 | 0.991 | 0.009 | 2105 / 3131 | 0.74 px | 3.625 ms |
| Optical blur + motion smear | fusion | 0.904 | 0.996 | 0.004 | 145 / 3131 | 0.76 px | 3.960 ms |
| Dim beacon (below threshold) | cv_classical | 0.000 | 0.000 | 1.000 | 0 / 3150 | — | 0.312 ms |
| Dim beacon (below threshold) | ai | 0.217 | 0.558 | 0.442 | 2123 / 3150 | 0.82 px | 3.910 ms |
| Dim beacon (below threshold) | fusion | 0.944 | 0.993 | 0.007 | 75 / 3150 | 0.83 px | 3.894 ms |
| Blinking beacon (reacquisition) | cv_classical | 0.949 | 1.000 | 0.000 | 61 / 3373 | 0.83 px | 0.323 ms |
| Blinking beacon (reacquisition) | ai | 0.319 | 0.957 | 0.043 | 2255 / 3373 | 0.79 px | 3.933 ms |
| Blinking beacon (reacquisition) | fusion | 0.885 | 0.996 | 0.004 | 146 / 3373 | 0.83 px | 3.952 ms |
| Bright decoys | cv_classical | 0.235 | 0.989 | 0.011 | 3432 / 3432 | 0.80 px | 0.328 ms |
| Bright decoys | ai | 0.135 | 0.569 | 0.431 | 3432 / 3432 | 0.77 px | 5.625 ms |
| Bright decoys | fusion | 0.854 | 1.000 | 0.000 | 183 / 3432 | 0.82 px | 4.631 ms |
| Bright decoys + noise | cv_classical | 0.096 | 0.403 | 0.597 | 3432 / 3432 | 0.81 px | 0.398 ms |
| Bright decoys + noise | ai | 0.084 | 0.353 | 0.647 | 3432 / 3432 | 0.77 px | 6.168 ms |
| Bright decoys + noise | fusion | 0.390 | 0.975 | 0.025 | 1601 / 3432 | 0.81 px | 5.861 ms |
| Bright decoys + jitter | cv_classical | 0.236 | 0.991 | 0.009 | 3430 / 3430 | 0.88 px | 0.347 ms |
| Bright decoys + jitter | ai | 0.134 | 0.565 | 0.435 | 3430 / 3430 | 0.86 px | 5.946 ms |
| Bright decoys + jitter | fusion | 0.817 | 0.994 | 0.006 | 232 / 3430 | 0.90 px | 4.917 ms |

## Arm B — closed loop

Median across 6 seeds. "Diverged" = seeds whose mean tracking error exceeded 50 px (a false lock).
"Correct acq" = first time the lock was within the lock radius of the TRUE beacon (the PS acquisition gate counts any lock).
"Correct lock" = frames locked on the beacon / frames the beacon was in view. "Continuity" = longest unbroken correct lock.

| Condition | Detector | Median error | Correct lock | Correct acq | Continuity | Reacq | Diverged | Pipeline | FPS |
|---|---|---|---|---|---|---|---|---|---|
| Clear | cv_classical | 6.07 px | 95.6 % | 0.55 s | 22.1 s | — | 0/6 | 0.29 ms | 3437 |
| Clear | ai | 6.07 px | 96.3 % | 0.55 s | 22.9 s | — | 0/6 | 4.21 ms | 238 |
| Clear | fusion | 6.07 px | 96.4 % | 0.55 s | 23.0 s | 0.10 s | 0/6 | 4.03 ms | 248 |
| Haze | cv_classical | 6.07 px | 95.6 % | 0.55 s | 22.1 s | — | 0/6 | 0.28 ms | 3561 |
| Haze | ai | 6.07 px | 95.6 % | 0.52 s | 22.1 s | — | 2/6 | 4.23 ms | 237 |
| Haze | fusion | 6.07 px | 96.4 % | 0.55 s | 23.0 s | 0.10 s | 0/6 | 3.98 ms | 252 |
| Fog | cv_classical | 6.07 px | 95.6 % | 0.55 s | 22.1 s | — | 0/6 | 0.28 ms | 3568 |
| Fog | ai | 6.07 px | 96.3 % | 0.55 s | 22.9 s | — | 0/6 | 4.18 ms | 239 |
| Fog | fusion | 6.07 px | 96.4 % | 0.55 s | 23.0 s | 0.10 s | 0/6 | 3.94 ms | 254 |
| Rain | cv_classical | 6.07 px | 95.6 % | 0.55 s | 22.0 s | — | 0/6 | 0.29 ms | 3488 |
| Rain | ai | 7.08 px | 93.6 % | 0.53 s | 10.1 s | — | 1/6 | 4.48 ms | 223 |
| Rain | fusion | 6.07 px | 96.1 % | 0.55 s | 22.0 s | 2.12 s | 2/6 | 4.44 ms | 225 |
| Low light | cv_classical | 6.07 px | 95.6 % | 0.52 s | 22.1 s | — | 2/6 | 0.32 ms | 3265 |
| Low light | ai | 6.07 px | 96.3 % | 0.55 s | 22.9 s | — | 0/6 | 4.25 ms | 236 |
| Low light | fusion | 6.07 px | 96.4 % | 0.55 s | 23.0 s | 0.10 s | 0/6 | 4.02 ms | 249 |
| Heavy sensor noise | cv_classical | 6.06 px | 95.9 % | 0.52 s | 22.1 s | — | 2/6 | 0.41 ms | 2414 |
| Heavy sensor noise | ai | 6.26 px | 95.8 % | 0.55 s | 15.9 s | — | 0/6 | 6.24 ms | 160 |
| Heavy sensor noise | fusion | 6.06 px | 95.9 % | 0.55 s | 22.1 s | 0.27 s | 1/6 | 6.91 ms | 145 |
| Camera jitter | cv_classical | 9.37 px | 58.3 % | 0.35 s | 0.4 s | — | 0/6 | 0.30 ms | 3379 |
| Camera jitter | ai | 9.37 px | 58.4 % | 0.35 s | 0.4 s | — | 0/6 | 4.33 ms | 231 |
| Camera jitter | fusion | 9.37 px | 58.5 % | 0.35 s | 0.4 s | 0.12 s | 0/6 | 4.00 ms | 250 |
| Optical blur + motion smear | cv_classical | 15.10 px | 21.5 % | 0.83 s | 0.6 s | — | 0/6 | 0.28 ms | 3583 |
| Optical blur + motion smear | ai | 15.13 px | 21.7 % | 0.83 s | 0.6 s | — | 0/6 | 3.71 ms | 270 |
| Optical blur + motion smear | fusion | 15.14 px | 21.2 % | 0.83 s | 0.5 s | 0.83 s | 0/6 | 4.01 ms | 250 |
| Dim beacon (below threshold) | cv_classical | — | 0.0 % | — | 0.0 s | — | 0/6 | 0.27 ms | 3656 |
| Dim beacon (below threshold) | ai | 410.14 px | 31.1 % | 0.53 s | 4.0 s | — | 4/6 | 4.18 ms | 240 |
| Dim beacon (below threshold) | fusion | 6.43 px | 97.2 % | 0.57 s | 23.8 s | 0.07 s | 0/6 | 4.59 ms | 219 |
| Blinking beacon (reacquisition) | cv_classical | 10.55 px | 93.6 % | 1.53 s | 3.6 s | 0.44 s | 0/6 | 0.35 ms | 2909 |
| Blinking beacon (reacquisition) | ai | 32.88 px | 90.5 % | 1.82 s | 3.5 s | 0.44 s | 2/6 | 4.57 ms | 219 |
| Blinking beacon (reacquisition) | fusion | 27.96 px | 92.7 % | 3.50 s | 3.6 s | 0.45 s | 0/6 | 4.04 ms | 249 |
| Bright decoys | cv_classical | 460.81 px | 0.0 % | 0.10 s | 0.0 s | — | 4/6 | 0.28 ms | 3561 |
| Bright decoys | ai | 471.83 px | 2.9 % | 0.10 s | 0.2 s | — | 6/6 | 5.24 ms | 195 |
| Bright decoys | fusion | 17.19 px | 96.7 % | 1.38 s | 22.6 s | 0.51 s | 2/6 | 4.57 ms | 219 |
| Bright decoys + noise | cv_classical | 482.49 px | 0.0 % | 0.10 s | 0.0 s | — | 5/6 | 0.36 ms | 2743 |
| Bright decoys + noise | ai | 515.56 px | 0.3 % | 0.73 s | 0.0 s | — | 6/6 | 6.04 ms | 168 |
| Bright decoys + noise | fusion | 451.80 px | 0.0 % | 0.10 s | 0.0 s | 0.07 s | 4/6 | 6.24 ms | 161 |
| Bright decoys + jitter | cv_classical | 460.82 px | 0.0 % | 0.12 s | 0.0 s | — | 4/6 | 0.29 ms | 3502 |
| Bright decoys + jitter | ai | 471.88 px | 1.7 % | 0.13 s | 0.1 s | — | 6/6 | 5.29 ms | 193 |
| Bright decoys + jitter | fusion | 114.15 px | 60.1 % | 4.67 s | 0.5 s | 0.78 s | 4/6 | 4.69 ms | 214 |

## Per-stage latency on the live 30 Hz loop (Phase 11)

Mean per frame over every closed-loop run of each detector, on this machine.

| Detector | CV stage | AI stage | Temporal verifier | Fusion | Total perception | Whole pipeline |
|---|---|---|---|---|---|---|
| cv_classical | 0.000 ms | 0.000 ms | 0.000 ms | 0.000 ms | 0.304 ms | 0.308 ms |
| ai | 0.000 ms | 4.679 ms | 0.000 ms | 0.000 ms | 4.682 ms | 4.688 ms |
| fusion | 0.325 ms | 4.223 ms | 0.015 ms | 0.003 ms | 4.569 ms | 4.574 ms |

## Mode 1 (full-frame) vs Mode 2 (ROI verification) — Phase 12

Mode 1 (full-frame): 308.0 ms/frame, recall 0.793, precision 0.192. Mode 2 (own proposals + ROI CNN): 4.83 ms/frame, recall 0.655, precision 0.211. Same 120 frames (clear, bright decoys, dim beacon). Frame budget at 30 Hz: 33.3 ms. Mode 1 is 64x slower.
