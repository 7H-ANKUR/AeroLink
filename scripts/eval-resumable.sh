#!/usr/bin/env bash
# Resumable full evaluation (AI plan Phase 9 / plan2 re-benchmark).
#
# Runs scripts/eval-detectors.ts once per condition and once for the Mode 1
# vs Mode 2 comparison, skipping any part already written, then merges them.
# An interrupted run (machine sleep, closed terminal) resumes where it stopped
# instead of starting an hour-long job from scratch. The learned stages run in
# ONNX Runtime Web (--runtime ort), the shipped browser runtime.
#
# Usage: bash scripts/eval-resumable.sh        (from the repository root)
#        FRESH=1 bash scripts/eval-resumable.sh   to discard old parts first
set -u
cd "$(dirname "$0")/.."
PARTS=benchmark-results/detector-comparison/parts
mkdir -p "$PARTS"
[ "${FRESH:-0}" = "1" ] && rm -f "$PARTS"/summary-*.json "$PARTS"/summary-*.md
LOG="$PARTS/run.log"
for id in clear haze fog rain low_light noise_heavy jitter blur_smear dim blink decoys_bright decoys_plus_noise decoys_jitter; do
  if [ -f "$PARTS/summary-$id.json" ]; then echo "skip $id (done)" >> "$LOG"; continue; fi
  echo "$(date -Iseconds) start $id" >> "$LOG"
  bun scripts/eval-detectors.ts --runtime ort --only "$id" >> "$LOG" 2>&1 || { echo "FAILED $id" >> "$LOG"; exit 1; }
done
if [ ! -f "$PARTS/summary-mode.json" ]; then
  echo "$(date -Iseconds) start mode" >> "$LOG"
  bun scripts/eval-detectors.ts --runtime ort --mode-only >> "$LOG" 2>&1 || { echo "FAILED mode" >> "$LOG"; exit 1; }
fi
bun scripts/eval-merge.ts >> "$LOG" 2>&1 && echo "$(date -Iseconds) ALL DONE" >> "$LOG"
