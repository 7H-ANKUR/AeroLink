# Detector comparison — classical vs learned vs hybrid

Generated 2026-09-29T10:54:47.072Z · 25s per run · 6 seeds per cell (4200, 4301, 4402, 4503, 4604, 4705).
Identical scenarios and seeds across detectors. Evaluation seeds are disjoint from every training seed range.
Learned stages executed on: **onnxruntime-web 1.30.0 (wasm, 1 thread)**.

CNN `beacon-roi-v2` (2989 parameters, locked smartphone-test F1 0.9589, locked stress-test F1 0.9975). Track verifier `track-verifier-v1` (locked-test F1 0.8083, AUC 0.9608).

## Arm A — perception on identical frames

Camera frozen, no Kalman prediction. "FA/empty" = detections reported on frames with no visible beacon.

| Condition | Detector | Precision | Recall | Miss rate | FA / empty frames | Localisation | Latency |
|---|---|---|---|---|---|---|---|

## Arm B — closed loop

Median across 6 seeds. "Diverged" = seeds whose mean tracking error exceeded 50 px (a false lock).
"Correct acq" = first time the lock was within the lock radius of the TRUE beacon (the PS acquisition gate counts any lock).
"Correct lock" = frames locked on the beacon / frames the beacon was in view. "Continuity" = longest unbroken correct lock.

| Condition | Detector | Median error | Correct lock | Correct acq | Continuity | Reacq | Diverged | Pipeline | FPS |
|---|---|---|---|---|---|---|---|---|---|

## Per-stage latency on the live 30 Hz loop (Phase 11)

Mean per frame over every closed-loop run of each detector, on this machine.

| Detector | CV stage | AI stage | Temporal verifier | Fusion | Total perception | Whole pipeline |
|---|---|---|---|---|---|---|
| cv_classical | 0.000 ms | 0.000 ms | 0.000 ms | 0.000 ms | 0.000 ms | 0.000 ms |
| ai | 0.000 ms | 0.000 ms | 0.000 ms | 0.000 ms | 0.000 ms | 0.000 ms |
| fusion | 0.000 ms | 0.000 ms | 0.000 ms | 0.000 ms | 0.000 ms | 0.000 ms |

## Mode 1 (full-frame) vs Mode 2 (ROI verification) — Phase 12

Mode 1 (full-frame): 822.2 ms/frame, recall 0.793, precision 0.192. Mode 2 (own proposals + ROI CNN): 9.92 ms/frame, recall 0.655, precision 0.211. Same 120 frames (clear, bright decoys, dim beacon). Frame budget at 30 Hz: 33.3 ms. Mode 1 is 83x slower.
