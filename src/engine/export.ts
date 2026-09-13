/**
 * Export utilities — events.csv, metrics.json and human-readable summary
 * report generation (docs/04 §4.16, docs/05 §2/§3).
 */
import type { FrameEventRow, RunResult } from './types';

const EVENTS_HEADER = [
  'timestamp',
  'frame_index',
  'source_mode',
  'gt_x',
  'gt_y',
  'detected_x',
  'detected_y',
  'predicted_x',
  'predicted_y',
  'confidence',
  'tracking_state',
  'pan_deg',
  'tilt_deg',
  'pan_command',
  'tilt_command',
  'error_px',
  'processing_ms',
  'locked',
  'lost',
];

export function eventsToCsv(rows: readonly FrameEventRow[]): string {
  const lines: string[] = [EVENTS_HEADER.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.timestamp,
        r.frame_index,
        r.source_mode,
        r.gt_x ?? '',
        r.gt_y ?? '',
        r.detected_x ?? '',
        r.detected_y ?? '',
        r.predicted_x ?? '',
        r.predicted_y ?? '',
        r.confidence,
        r.tracking_state,
        r.pan_deg,
        r.tilt_deg,
        r.pan_command,
        r.tilt_command,
        r.error_px ?? '',
        r.processing_ms,
        r.locked ? 'true' : 'false',
        r.lost ? 'true' : 'false',
      ].join(','),
    );
  }
  return lines.join('\n');
}

function fmt(v: number | null | undefined, unit = '', digits = 2): string {
  if (v === null || v === undefined) return '<span class="na">not computable</span>';
  return `${v.toFixed(digits)}${unit}`;
}

export function summaryHtml(result: RunResult): string {
  const pf = result.pass_fail;
  const badge = (b: boolean | undefined) =>
    b === undefined || b === null
      ? '<span class="muted">N/A</span>'
      : b
        ? '<span class="pass">✓ PASS</span>'
        : '<span class="fail">× FAIL</span>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>FSOC-PAT Run Report — ${result.run_id}</title>
<style>
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0a0d10; color: #e8edf1; margin: 32px auto; max-width: 860px; padding: 0 24px; }
  h1 { font-size: 20px; font-weight: 600; letter-spacing: 0.4px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 1.2px; color: #7d8994; border-bottom: 1px solid #252c33; padding-bottom: 6px; margin-top: 32px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 12px; }
  td, th { border-bottom: 1px solid #1c232a; padding: 8px 10px; text-align: left; }
  th { color: #7d8994; font-weight: 500; }
  td.v { font-family: 'Cascadia Mono', Consolas, monospace; font-variant-numeric: tabular-nums; }
  .pass { color: #79c99b; font-weight: 600; }
  .fail { color: #d87575; font-weight: 600; }
  .na, .muted { color: #58636d; }
  .meta { color: #7d8994; font-size: 12px; }
  .tag { display:inline-block; border:1px solid #313a43; border-radius:4px; padding:2px 8px; font-size:11px; color:#c3ccd4; margin-right:6px; }
</style>
</head>
<body>
<h1>FSOC-PAT — Performance Report</h1>
<p class="meta">Run <strong>${result.run_id}</strong> · completed ${result.completed_at} · software v${result.software_version}</p>
<p>
  <span class="tag">Mode: ${result.mode}</span>
  <span class="tag">Scenario: ${result.scenario_name}</span>
  <span class="tag">Seed: ${result.scenario_seed}</span>
  <span class="tag">Detector: ${result.detector}</span>
  <span class="tag">Tracker: ${result.tracker}</span>
  <span class="tag">Controller: ${result.controller}</span>
  <span class="tag">GT source: ${result.ground_truth_source}</span>
</p>

<h2>Summary Metrics</h2>
<table>
  <tr><th>Metric</th><th>Value</th></tr>
  <tr><td>Duration</td><td class="v">${fmt(result.duration_s, ' s')}</td></tr>
  <tr><td>Acquisition time</td><td class="v">${fmt(result.acquisition_time_s, ' s', 3)}</td></tr>
  <tr><td>Average tracking error (centroiding)</td><td class="v">${fmt(result.avg_error_px, ' px', 3)}</td></tr>
  <tr><td>Max tracking error</td><td class="v">${fmt(result.max_error_px, ' px', 2)}</td></tr>
  <tr><td>RMSE</td><td class="v">${fmt(result.rmse_px, ' px', 3)}</td></tr>
  <tr><td>p95 / p99 error</td><td class="v">${fmt(result.p95_error_px, ' px')} / ${fmt(result.p99_error_px, ' px')}</td></tr>
  <tr><td>Target loss</td><td class="v">${fmt(result.target_loss_percent, ' %')}</td></tr>
  <tr><td>Lock retention</td><td class="v">${fmt(result.lock_retention_percent, ' %')}</td></tr>
  <tr><td>Re-acquisition avg / max</td><td class="v">${fmt(result.reacquisition_avg_s, ' s', 3)} / ${fmt(result.reacquisition_max_s, ' s', 3)} (${result.reacquisition_events} events)</td></tr>
  <tr><td>Algorithm FPS (pipeline-only)</td><td class="v">${fmt(result.fps_measured)}</td></tr>
  <tr><td>Wall-clock FPS</td><td class="v">${fmt(result.wall_clock_fps)}</td></tr>
  <tr><td>Avg processing time</td><td class="v">${fmt(result.processing_avg_ms, ' ms')}</td></tr>
  <tr><td>Frames processed / dropped</td><td class="v">${result.frames_processed} / ${result.frames_dropped}</td></tr>
  <tr><td>Detection rate</td><td class="v">${fmt(result.detection_rate_percent, ' %')}</td></tr>
  <tr><td>Longest continuous TRACK streak</td><td class="v">${result.track_continuity_frames ?? '—'} frames</td></tr>
  <tr><td>Avg detection confidence</td><td class="v">${fmt(result.avg_detection_confidence, '', 3)}</td></tr>
</table>

${
  result.ground_truth_source === 'none'
    ? `<h2>Ground Truth Notice</h2>
<p class="muted">Perception-only benchmark — no ground truth was available for this run. Tracking error,
RMSE and lock-retention-vs-GT are <strong>not computable</strong> and are reported as null.
Reference-free metrics (detection rate, track continuity, re-acquisition events, FPS, confidence)
are reported instead. No physical re-pointing occurred on recorded footage.</p>`
    : ''
}

<h2>PS-169 Official Benchmark Gates</h2>
${
  pf
    ? `<table>
  <tr><th>Metric</th><th>Official target</th><th>Measured</th><th>Result</th></tr>
  <tr><td>Acquisition time</td><td class="v">≤ 2.00 s</td><td class="v">${fmt(result.acquisition_time_s, ' s', 3)}</td><td>${badge(pf.acquisition)}</td></tr>
  <tr><td>Average tracking error</td><td class="v">≤ 10 px</td><td class="v">${fmt(result.avg_error_px, ' px')}</td><td>${badge(pf.tracking_error)}</td></tr>
  <tr><td>Target loss</td><td class="v">&lt; 5 %</td><td class="v">${fmt(result.target_loss_percent, ' %')}</td><td>${badge(pf.target_loss)}</td></tr>
  <tr><td>Re-acquisition (avg)</td><td class="v">≤ 1.00 s</td><td class="v">${fmt(result.reacquisition_avg_s, ' s', 3)}</td><td>${badge(pf.reacquisition)}</td></tr>
  <tr><td>Processing speed</td><td class="v">≥ 20 FPS</td><td class="v">${fmt(result.fps_measured)}</td><td>${badge(pf.processing_speed)}</td></tr>
</table>
<p class="meta">Official PS-169 targets, visually distinct from internal engineering thresholds.
Lock policy: predicted frames ${result.lock_policy_counts_prediction ? 'count toward' : 'are excluded from'} lock retention.</p>`
    : `<p class="muted">Reference-free run — pass/fail against PS-169 error gates is not computable without ground truth.</p>`
}

<h2>Reproducibility</h2>
<p class="meta">Deterministic run under seed ${result.scenario_seed}. Reproduce by loading the bundled
config into the scenario builder with identical engine version v${result.software_version}.</p>
</body>
</html>`;
}

export function downloadText(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
