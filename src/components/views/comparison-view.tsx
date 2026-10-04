'use client';

/**
 * Experiment comparison (docs/Frontend-Design §22, FR-15) — technical
 * two-run delta table supporting algorithm experiments.
 */
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Scale } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface RegistryRow {
  id: string;
  runId: string;
  scenarioName: string;
  mode: string;
  detector: string;
  avgErrorPx: number | null;
  rmsePx: number | null;
  targetLossPercent: number | null;
  acquisitionTimeS: number | null;
  reacquisitionAvgS: number | null;
  fpsMeasured: number;
  lockRetentionPercent: number | null;
  processingAvgMs: number | null;
}

const COMPARABLE: { key: keyof RegistryRow; label: string; unit: string; lowerBetter: boolean }[] = [
  { key: 'avgErrorPx', label: 'Avg Error', unit: 'px', lowerBetter: true },
  { key: 'rmsePx', label: 'RMSE', unit: 'px', lowerBetter: true },
  { key: 'targetLossPercent', label: 'Loss', unit: '%', lowerBetter: true },
  { key: 'lockRetentionPercent', label: 'Lock Retention', unit: '%', lowerBetter: false },
  { key: 'acquisitionTimeS', label: 'Acquisition', unit: 's', lowerBetter: true },
  { key: 'reacquisitionAvgS', label: 'Re-acquisition', unit: 's', lowerBetter: true },
  { key: 'fpsMeasured', label: 'Algorithm FPS', unit: '', lowerBetter: false },
  { key: 'processingAvgMs', label: 'Processing', unit: 'ms', lowerBetter: true },
];

export function ComparisonView() {
  const [runs, setRuns] = useState<RegistryRow[]>([]);
  const [aId, setAId] = useState<string>('');
  const [bId, setBId] = useState<string>('');

  const loadRuns = useCallback(async () => {
    try {
      const res = await fetch('/api/runs');
      const data = (await res.json()) as { runs?: RegistryRow[] };
      const list = data.runs ?? [];
      setRuns(list);
      setAId((prev) => prev || list[0]?.id || '');
      setBId((prev) => prev || list[1]?.id || list[0]?.id || '');
    } catch {
      setRuns([]);
    }
  }, []);

  useEffect(() => {
    // defer registry fetch off the render cycle
    const t = setTimeout(() => void loadRuns(), 0);
    return () => clearTimeout(t);
  }, [loadRuns]);

  const a = runs.find((r) => r.id === aId) ?? null;
  const b = runs.find((r) => r.id === bId) ?? null;

  const fmt = (v: number | null | undefined, unit: string): string =>
    v === null || v === undefined ? '—' : `${v.toFixed(2)}${unit ? ` ${unit}` : ''}`;

  const delta = (key: keyof RegistryRow, unit: string, lowerBetter: boolean): { text: string; good: boolean | null } => {
    const av = a?.[key] as number | null | undefined;
    const bv = b?.[key] as number | null | undefined;
    if (av == null || bv == null) return { text: '—', good: null };
    const d = bv - av;
    if (Math.abs(d) < 1e-9) return { text: '±0', good: null };
    const pct = av !== 0 ? (d / Math.abs(av)) * 100 : null;
    const text = `${d >= 0 ? '+' : ''}${d.toFixed(2)}${unit ? ` ${unit}` : ''}${pct !== null ? ` (${d >= 0 ? '+' : ''}${pct.toFixed(1)}%)` : ''}`;
    const improved = lowerBetter ? d < 0 : d > 0;
    return { text, good: improved };
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4">
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-[16px] font-semibold tracking-[0.14em] text-fsoc-text0">RUN COMPARISON</h2>
          <Button variant="ghost" size="sm" className="gap-1.5 text-fsoc-text2" onClick={loadRuns}>
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="panel px-4 py-3">
            <div className="panel-title mb-2">Run A (baseline)</div>
            <Select value={aId} onValueChange={setAId}>
              <SelectTrigger className="h-8 text-[11px] bg-fsoc-bg0 border-fsoc-border1">
                <SelectValue placeholder="Select run A" />
              </SelectTrigger>
              <SelectContent className="bg-fsoc-bg2 border-fsoc-border2 text-[11px] max-h-64">
                {runs.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.scenarioName} · {r.runId.slice(0, 14)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="panel px-4 py-3">
            <div className="panel-title mb-2">Run B (variant)</div>
            <Select value={bId} onValueChange={setBId}>
              <SelectTrigger className="h-8 text-[11px] bg-fsoc-bg0 border-fsoc-border1">
                <SelectValue placeholder="Select run B" />
              </SelectTrigger>
              <SelectContent className="bg-fsoc-bg2 border-fsoc-border2 text-[11px] max-h-64">
                {runs.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.scenarioName} · {r.runId.slice(0, 14)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {a && b ? (
          <div className="panel overflow-hidden">
            <table className="w-full text-[11.5px]">
              <thead>
                <tr className="border-b border-fsoc-border1 text-fsoc-text3">
                  <th className="text-left font-medium px-4 py-2.5">Metric</th>
                  <th className="text-right font-medium px-4 py-2.5">RUN A</th>
                  <th className="text-right font-medium px-4 py-2.5">RUN B</th>
                  <th className="text-right font-medium px-4 py-2.5">Δ (B−A)</th>
                </tr>
              </thead>
              <tbody className="tnum">
                <tr className="border-b border-fsoc-border1/50">
                  <td className="px-4 py-2 text-fsoc-text2">Scenario</td>
                  <td className="px-4 py-2 text-right text-fsoc-text1 max-w-[160px] truncate" title={a.scenarioName}>{a.scenarioName}</td>
                  <td className="px-4 py-2 text-right text-fsoc-text1 max-w-[160px] truncate" title={b.scenarioName}>{b.scenarioName}</td>
                  <td className="px-4 py-2 text-right text-fsoc-text3">—</td>
                </tr>
                <tr className="border-b border-fsoc-border1/50">
                  <td className="px-4 py-2 text-fsoc-text2">Detector</td>
                  <td className="px-4 py-2 text-right text-fsoc-text1">{a.detector}</td>
                  <td className="px-4 py-2 text-right text-fsoc-text1">{b.detector}</td>
                  <td className="px-4 py-2 text-right text-fsoc-text3">—</td>
                </tr>
                {COMPARABLE.map((c) => {
                  const d = delta(c.key, c.unit, c.lowerBetter);
                  return (
                    <tr key={String(c.key)} className="border-b border-fsoc-border1/50">
                      <td className="px-4 py-2 text-fsoc-text2">{c.label}</td>
                      <td className="px-4 py-2 text-right text-fsoc-text1">{fmt(a[c.key] as number | null, c.unit)}</td>
                      <td className="px-4 py-2 text-right text-fsoc-text1">{fmt(b[c.key] as number | null, c.unit)}</td>
                      <td className={`px-4 py-2 text-right ${d.good === null ? 'text-fsoc-text3' : d.good ? 'text-fsoc-success' : 'text-fsoc-danger'}`}>
                        {d.text}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="panel px-6 py-10 text-center">
            <Scale className="w-6 h-6 text-fsoc-text3 mx-auto" />
            <p className="text-[12px] text-fsoc-text1 mt-3">Select two saved runs to compare</p>
            <p className="text-[11px] text-fsoc-text3 mt-1.5">
              Complete at least two runs (e.g. a clear scenario vs a disturbed one) to enable the delta table.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
