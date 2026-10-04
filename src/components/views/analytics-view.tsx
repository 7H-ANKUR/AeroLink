'use client';

/**
 * Results / Analytics view (docs/Frontend-Design §20, §43) — last-run
 * summary with PS-169 pass/fail table (official targets visually distinct),
 * exports, and the persisted run registry from SQLite.
 */
import { useCallback, useEffect, useState } from 'react';
import { Download, FileJson, FileText, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFsoc, engine } from '@/lib/store';
import { downloadText, eventsToCsv, summaryHtml } from '@/engine/export';
import type { RunResult } from '@/engine/types';

interface RegistryRow {
  id: string;
  runId: string;
  mode: string;
  scenarioName: string;
  scenarioSeed: number;
  durationS: number;
  fpsMeasured: number;
  acquisitionTimeS: number | null;
  avgErrorPx: number | null;
  rmsePx: number | null;
  targetLossPercent: number | null;
  lockRetentionPercent: number | null;
  reacquisitionAvgS: number | null;
  groundTruthSource: string;
  passFail: string;
  createdAt: string;
}

export function AnalyticsView() {
  const lastResult = useFsoc((s) => s.lastResult);
  const [rows, setRows] = useState<RegistryRow[]>([]);
  const [loading, setLoading] = useState(false);

  const loadRegistry = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/runs');
      const data = (await res.json()) as { runs?: RegistryRow[] };
      setRows(data.runs ?? []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRegistry();
  }, [loadRegistry, lastResult]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4">
      <div className="max-w-5xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-[16px] font-semibold tracking-[0.14em] text-fsoc-text0">RESULTS & ANALYTICS</h2>
          <Button variant="ghost" size="sm" className="gap-1.5 text-fsoc-text2" onClick={loadRegistry}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </div>

        {lastResult ? (
          <LastRunCard result={lastResult} />
        ) : (
          <div className="panel px-6 py-8 text-center">
            <p className="text-[13px] text-fsoc-text1">No completed run in this session yet</p>
            <p className="text-[11px] text-fsoc-text3 mt-1.5 leading-relaxed">
              Run a scenario in Mission Control or a video benchmark — every completed run is summarized here,
              saved to the local registry, and exportable as JSON / CSV / HTML.
            </p>
          </div>
        )}

        <div className="panel">
          <div className="flex items-center justify-between px-4 py-3 border-b border-fsoc-border1">
            <span className="panel-title">Run Registry ({rows.length})</span>
            {rows.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-fsoc-text3 hover:text-fsoc-danger"
                onClick={async () => {
                  await fetch('/api/runs', { method: 'DELETE' });
                  void loadRegistry();
                }}
              >
                <Trash2 className="w-3 h-3" /> Clear
              </Button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-fsoc-text3 border-b border-fsoc-border1">
                  {['Run', 'Scenario', 'Mode', 'Seed', 'Acq (s)', 'Avg err (px)', 'RMSE', 'Loss %', 'Lock %', 'FPS', 'Gates'].map((h) => (
                    <th key={h} className="text-left font-medium px-3 py-2 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="tnum">
                {rows.map((r) => {
                  let pf: Record<string, boolean> | null = null;
                  try {
                    pf = JSON.parse(r.passFail) as Record<string, boolean>;
                  } catch {
                    pf = null;
                  }
                  const passed = pf ? Object.values(pf).filter(Boolean).length : 0;
                  const total = pf ? Object.keys(pf).length : 0;
                  return (
                    <tr key={r.id} className="border-b border-fsoc-border1/50 hover:bg-fsoc-bg2/60 transition-colors">
                      <td className="px-3 py-2 text-fsoc-text2 whitespace-nowrap">{r.runId.slice(0, 19)}</td>
                      <td className="px-3 py-2 text-fsoc-text1 max-w-[180px] truncate" title={r.scenarioName}>{r.scenarioName}</td>
                      <td className="px-3 py-2 text-fsoc-text2">{r.mode}</td>
                      <td className="px-3 py-2 text-fsoc-text2">{r.scenarioSeed}</td>
                      <td className="px-3 py-2 text-fsoc-text1">{r.acquisitionTimeS?.toFixed(2) ?? '—'}</td>
                      <td className="px-3 py-2 text-fsoc-text1">{r.avgErrorPx?.toFixed(2) ?? '—'}</td>
                      <td className="px-3 py-2 text-fsoc-text1">{r.rmsePx?.toFixed(2) ?? '—'}</td>
                      <td className="px-3 py-2 text-fsoc-text1">{r.targetLossPercent?.toFixed(1) ?? '—'}</td>
                      <td className="px-3 py-2 text-fsoc-text1">{r.lockRetentionPercent?.toFixed(1) ?? '—'}</td>
                      <td className="px-3 py-2 text-fsoc-text1">{r.fpsMeasured.toFixed(1)}</td>
                      <td className="px-3 py-2">
                        {total === 0 ? (
                          <span className="text-fsoc-text3">ref-free</span>
                        ) : (
                          <span className={passed === total ? 'text-fsoc-success' : 'text-fsoc-warning'}>
                            {passed}/{total} PASS
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={11} className="px-3 py-6 text-center text-fsoc-text3">
                      Registry is empty — completed runs persist here automatically.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function LastRunCard({ result }: { result: RunResult }) {
  const pf = result.pass_fail;
  const gates: { key: string; label: string; target: string; measured: string; pass: boolean | null }[] = [
    {
      key: 'acquisition',
      label: 'Acquisition time',
      target: '≤ 2.00 s',
      measured: result.acquisition_time_s !== null ? `${result.acquisition_time_s.toFixed(2)} s` : '—',
      pass: pf?.acquisition ?? null,
    },
    {
      key: 'tracking_error',
      label: 'Average tracking error',
      target: '≤ 10 px',
      measured: result.avg_error_px !== null ? `${result.avg_error_px.toFixed(2)} px` : '—',
      pass: pf?.tracking_error ?? null,
    },
    {
      key: 'target_loss',
      label: 'Target loss',
      target: '< 5 %',
      measured: result.target_loss_percent !== null ? `${result.target_loss_percent.toFixed(2)} %` : '—',
      pass: pf?.target_loss ?? null,
    },
    {
      key: 'reacquisition',
      label: 'Re-acquisition (avg)',
      target: '≤ 1.00 s',
      measured: result.reacquisition_avg_s !== null ? `${result.reacquisition_avg_s.toFixed(2)} s` : '—',
      pass: pf?.reacquisition ?? null,
    },
    {
      key: 'processing_speed',
      label: 'Processing speed',
      target: '≥ 20 FPS',
      measured: `${result.fps_measured.toFixed(1)} FPS`,
      pass: pf?.processing_speed ?? null,
    },
  ];

  const summary: [string, string][] = [
    ['Duration', `${result.duration_s.toFixed(1)} s`],
    ['Acquisition', result.acquisition_time_s !== null ? `${result.acquisition_time_s.toFixed(3)} s` : '—'],
    ['Average error', result.avg_error_px !== null ? `${result.avg_error_px.toFixed(2)} px` : '—'],
    ['Max error', result.max_error_px !== null ? `${result.max_error_px.toFixed(2)} px` : '—'],
    ['RMSE', result.rmse_px !== null ? `${result.rmse_px.toFixed(2)} px` : '—'],
    ['p95 / p99', `${result.p95_error_px?.toFixed(2) ?? '—'} / ${result.p99_error_px?.toFixed(2) ?? '—'} px`],
    ['Loss', result.target_loss_percent !== null ? `${result.target_loss_percent.toFixed(2)} %` : '—'],
    ['Lock retention', result.lock_retention_percent !== null ? `${result.lock_retention_percent.toFixed(1)} %` : '—'],
    ['Re-acquisition', `${result.reacquisition_avg_s?.toFixed(3) ?? '—'} s avg · ${result.reacquisition_events} events`],
    ['Algorithm FPS', result.fps_measured.toFixed(1)],
    ['Wall-clock FPS', result.wall_clock_fps.toFixed(1)],
    ['Avg processing', `${result.processing_avg_ms?.toFixed(2) ?? '—'} ms`],
    ['Frames processed', `${result.frames_processed} (${result.frames_dropped} dropped)`],
    ['Detection rate', result.detection_rate_percent !== null ? `${result.detection_rate_percent.toFixed(1)} %` : '—'],
    ['Avg confidence', result.avg_detection_confidence !== null ? result.avg_detection_confidence.toFixed(3) : '—'],
  ];

  const passedCount = pf ? Object.values(pf).filter(Boolean).length : 0;
  const totalCount = pf ? Object.keys(pf).length : 0;

  return (
    <div className="panel overflow-hidden">
      <div className="px-5 py-4 border-b border-fsoc-border1 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[10px] tracking-[0.16em] text-fsoc-success font-semibold">RUN COMPLETE</div>
          <div className="text-[15px] text-fsoc-text0 font-medium mt-0.5">
            {result.scenario_name} <span className="text-fsoc-text3 font-normal">· {result.mode}</span>
          </div>
          <div className="text-[10px] tnum text-fsoc-text3 mt-0.5">
            {result.run_id} · seed {result.scenario_seed} · v{result.software_version}
          </div>
        </div>
        <div className="text-right">
          {totalCount > 0 ? (
            <>
              <div className="text-[22px] tnum font-semibold" style={{ color: passedCount === totalCount ? 'var(--success)' : 'var(--warning)' }}>
                {passedCount} / {totalCount}
              </div>
              <div className="text-[9px] tracking-[0.14em] text-fsoc-text3">PS-169 GATES PASSED</div>
            </>
          ) : (
            <div className="text-[10px] text-fsoc-warning tracking-wider">PERCEPTION-ONLY RUN</div>
          )}
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-0">
        <div className="px-5 py-4 border-b md:border-b-0 md:border-r border-fsoc-border1">
          <div className="panel-title mb-2.5">Summary</div>
          <div className="grid grid-cols-1 gap-1.5">
            {summary.map(([k, v]) => (
              <div key={k} className="flex items-center justify-between text-[11px]">
                <span className="text-fsoc-text2">{k}</span>
                <span className="tnum text-fsoc-text1">{v}</span>
              </div>
            ))}
          </div>
          {result.ground_truth_source === 'none' && (
            <p className="text-[10px] text-fsoc-warning/90 leading-relaxed mt-3">
              Perception-only benchmark — error/RMSE not computable without ground truth. Reference-free metrics reported instead.
            </p>
          )}
        </div>

        <div className="px-5 py-4">
          <div className="panel-title mb-2.5">PS-169 Benchmark Gates</div>
          <div className="space-y-2">
            {gates.map((g) => (
              <div key={g.key} className="flex items-center justify-between gap-2 text-[11px]">
                <div className="min-w-0">
                  <div className="text-fsoc-text1">{g.label}</div>
                  <div className="text-[9px] text-fsoc-text3 tnum">OFFICIAL TARGET {g.target}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="tnum text-fsoc-text0">{g.measured}</span>
                  {g.pass === null ? (
                    <span className="text-[9px] text-fsoc-text3 border border-fsoc-border1 rounded px-1.5 py-0.5">N/A</span>
                  ) : (
                    <span className={`text-[9px] tracking-wider border rounded px-1.5 py-0.5 ${g.pass ? 'text-fsoc-success border-fsoc-success/40' : 'text-fsoc-danger border-fsoc-danger/40'}`}>
                      {g.pass ? '✓ PASS' : '× FAIL'}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
          <p className="text-[9px] text-fsoc-text3 leading-relaxed mt-3">
            Official PS-169 targets — visually distinct from internal engineering thresholds. Lock policy: predicted
            frames {result.lock_policy_counts_prediction ? 'count toward' : 'are excluded from'} lock retention.
          </p>
        </div>
      </div>

      <div className="px-5 py-3.5 border-t border-fsoc-border1 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          className="gap-1.5 h-8 text-[11px]"
          onClick={() => downloadText(`${result.run_id}-metrics.json`, JSON.stringify(result, null, 2), 'application/json')}
        >
          <FileJson className="w-3.5 h-3.5" /> Export JSON
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="gap-1.5 h-8 text-[11px]"
          onClick={() => downloadText(`${result.run_id}-events.csv`, engine.lastEventsCsv ?? eventsToCsv([]), 'text/csv')}
        >
          <Download className="w-3.5 h-3.5" /> Export CSV
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="gap-1.5 h-8 text-[11px]"
          onClick={() => downloadText(`${result.run_id}-summary.html`, summaryHtml(result), 'text/html')}
        >
          <FileText className="w-3.5 h-3.5" /> Export HTML Report
        </Button>
      </div>
    </div>
  );
}
