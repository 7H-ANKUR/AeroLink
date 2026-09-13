'use client';

/**
 * Replay (docs/Frontend-Design §21, FR-14) — reconstructs a completed run
 * from its recorded per-frame events (never re-runs the simulation).
 * Scrub through with overlays: GT, detected, predicted, state, commands.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFsoc } from '@/lib/store';
import { STATE_COLORS } from '@/components/shell/state-colors';

interface RegistryRow {
  id: string;
  runId: string;
  scenarioName: string;
  mode: string;
  eventsCsv: string | null;
  avgErrorPx: number | null;
}

interface ParsedRow {
  timestamp: number;
  frame_index: number;
  gt_x: number | null;
  gt_y: number | null;
  detected_x: number | null;
  detected_y: number | null;
  tracking_state: string;
  pan_deg: number;
  tilt_deg: number;
  pan_command: number;
  tilt_command: number;
  error_px: number | null;
  locked: boolean;
  lost: boolean;
}

function parseCsv(csv: string): ParsedRow[] {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];
  const header = lines[0].split(',');
  const idx = (name: string) => header.indexOf(name);
  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startsWith('#')) continue;
    const c = lines[i].split(',');
    const val = (name: string): number | null => {
      const v = c[idx(name)];
      return v === undefined || v === '' ? null : parseFloat(v);
    };
    rows.push({
      timestamp: val('timestamp') ?? 0,
      frame_index: val('frame_index') ?? i - 1,
      gt_x: val('gt_x'),
      gt_y: val('gt_y'),
      detected_x: val('detected_x'),
      detected_y: val('detected_y'),
      tracking_state: c[idx('tracking_state')] ?? 'SEARCH',
      pan_deg: val('pan_deg') ?? 0,
      tilt_deg: val('tilt_deg') ?? 0,
      pan_command: val('pan_command') ?? 0,
      tilt_command: val('tilt_command') ?? 0,
      error_px: val('error_px'),
      locked: c[idx('locked')] === 'true',
      lost: c[idx('lost')] === 'true',
    });
  }
  return rows;
}

export function ReplayView() {
  const lastResult = useFsoc((s) => s.lastResult);
  const [runs, setRuns] = useState<RegistryRow[]>([]);
  const [selected, setSelected] = useState<RegistryRow | null>(null);
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const rafRef = useRef<number>(0);
  const lastTickRef = useRef<number>(0);

  const loadRuns = useCallback(async () => {
    try {
      const res = await fetch('/api/runs');
      const data = (await res.json()) as { runs?: Omit<RegistryRow, 'eventsCsv'>[] };
      setRuns((data.runs ?? []) as RegistryRow[]);
    } catch {
      setRuns([]);
    }
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns, lastResult]);

  const openRun = useCallback(async (r: RegistryRow) => {
    setSelected(r);
    setLoading(true);
    setRows([]);
    setCursor(0);
    setPlaying(false);
    try {
      const res = await fetch(`/api/runs/${r.id}`);
      const data = (await res.json()) as { run?: { eventsCsv: string | null } };
      if (data.run?.eventsCsv) {
        setRows(parseCsv(data.run.eventsCsv));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // playback loop (~30 fps equivalent)
  useEffect(() => {
    if (!playing || rows.length === 0) return;
    const step = (ms: number) => {
      if (lastTickRef.current && ms - lastTickRef.current >= 33) {
        lastTickRef.current = ms;
        setCursor((c) => {
          if (c >= rows.length - 1) {
            setPlaying(false);
            return c;
          }
          return c + 1;
        });
      } else if (!lastTickRef.current) {
        lastTickRef.current = ms;
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, rows.length]);

  const row = rows[Math.min(cursor, rows.length - 1)] ?? null;
  const progress = rows.length > 0 ? (cursor / (rows.length - 1)) * 100 : 0;

  const bounds = useMemo(() => {
    const xs = rows.flatMap((r) => [r.gt_x, r.detected_x]).filter((v): v is number => v !== null);
    const ys = rows.flatMap((r) => [r.gt_y, r.detected_y]).filter((v): v is number => v !== null);
    return {
      minX: xs.length ? Math.min(...xs) - 30 : 0,
      maxX: xs.length ? Math.max(...xs) + 30 : 1,
      minY: ys.length ? Math.min(...ys) - 30 : 0,
      maxY: ys.length ? Math.max(...ys) + 30 : 1,
    };
  }, [rows]);

  // map scene coords to canvas — replay renders in scene space around the track
  const W = 640;
  const H = 480;
  const spanX = Math.max(120, bounds.maxX - bounds.minX);
  const spanY = Math.max(90, bounds.maxY - bounds.minY);
  const scale = Math.min(W / spanX, H / spanY);

  const toCanvas = (x: number | null, y: number | null): [number, number] | null => {
    if (x === null || y === null) return null;
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    return [W / 2 + (x - cx) * scale, H / 2 + (y - cy) * scale];
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4">
      <div className="max-w-5xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-[16px] font-semibold tracking-[0.14em] text-fsoc-text0">REPLAY</h2>
          <Button variant="ghost" size="sm" className="gap-1.5 text-fsoc-text2" onClick={loadRuns}>
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </Button>
        </div>

        {/* run selector */}
        <div className="flex gap-2 overflow-x-auto pb-1">
          {runs.slice(0, 12).map((r) => (
            <button
              key={r.id}
              onClick={() => openRun(r)}
              className={`shrink-0 panel px-3 py-2 text-left hover:border-fsoc-border2 transition-colors ${selected?.id === r.id ? 'border-fsoc-cyan/50' : ''}`}
            >
              <div className="text-[10.5px] text-fsoc-text1 max-w-[180px] truncate">{r.scenarioName}</div>
              <div className="text-[9px] tnum text-fsoc-text3">{r.runId.slice(0, 19)} · {r.mode}</div>
            </button>
          ))}
          {runs.length === 0 && (
            <div className="text-[11px] text-fsoc-text3 px-2 py-3">
              No saved runs yet — complete a run in Mission Control, then replay it here.
            </div>
          )}
        </div>

        {selected && (
          <div className="grid md:grid-cols-[1fr_260px] gap-4">
            {/* replay canvas */}
            <div className="panel overflow-hidden">
              <div className="px-4 py-2.5 border-b border-fsoc-border1 flex items-center justify-between">
                <span className="text-[11px] text-fsoc-text1 truncate">{selected.scenarioName}</span>
                <span className="text-[9px] tnum text-fsoc-text3">
                  frame {row?.frame_index ?? '—'} / {rows.length - 1}
                </span>
              </div>
              <div className="relative bg-[#05070a] aspect-video">
                <canvas
                  id="replay-canvas"
                  width={W}
                  height={H}
                  className="w-full h-full object-contain"
                  style={{ imageRendering: 'auto' }}
                  ref={(canvas) => {
                    if (!canvas || !row) return;
                    const ctx = canvas.getContext('2d');
                    if (!ctx) return;
                    ctx.fillStyle = '#05070a';
                    ctx.fillRect(0, 0, W, H);
                    // trail
                    ctx.strokeStyle = 'rgba(144,167,255,0.35)';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    let started = false;
                    for (let i = Math.max(0, cursor - 300); i <= cursor; i++) {
                      const r = rows[i];
                      const p = toCanvas(r.gt_x, r.gt_y);
                      if (!p) continue;
                      if (!started) {
                        ctx.moveTo(p[0], p[1]);
                        started = true;
                      } else ctx.lineTo(p[0], p[1]);
                    }
                    ctx.stroke();
                    // ground truth
                    const gt = toCanvas(row.gt_x, row.gt_y);
                    if (gt) {
                      ctx.strokeStyle = '#90a7ff';
                      ctx.setLineDash([2, 3]);
                      ctx.beginPath();
                      ctx.moveTo(gt[0] - 7, gt[1]);
                      ctx.lineTo(gt[0] + 7, gt[1]);
                      ctx.moveTo(gt[0], gt[1] - 7);
                      ctx.lineTo(gt[0], gt[1] + 7);
                      ctx.stroke();
                      ctx.setLineDash([]);
                    }
                    // detected
                    const det = toCanvas(row.detected_x, row.detected_y);
                    if (det) {
                      ctx.strokeStyle = '#72d9e8';
                      ctx.strokeRect(det[0] - 8, det[1] - 8, 16, 16);
                      ctx.fillStyle = '#fff7d8';
                      ctx.fillRect(det[0] - 1.5, det[1] - 1.5, 3, 3);
                    }
                    // camera center
                    ctx.strokeStyle = 'rgba(243,246,248,0.5)';
                    ctx.beginPath();
                    ctx.moveTo(W / 2 - 9, H / 2);
                    ctx.lineTo(W / 2 + 9, H / 2);
                    ctx.moveTo(W / 2, H / 2 - 9);
                    ctx.lineTo(W / 2, H / 2 + 9);
                    ctx.stroke();
                    ctx.fillStyle = '#58636d';
                    ctx.font = '10px monospace';
                    ctx.fillText('SCENE VIEW — GT ✕  DETECTED ○  CENTER +', 12, H - 12);
                  }}
                />
                {!row && (
                  <div className="absolute inset-0 flex items-center justify-center text-[11px] text-fsoc-text3">
                    {loading ? 'Loading event stream…' : 'No event data stored for this run'}
                  </div>
                )}
              </div>
              {/* transport */}
              <div className="px-4 py-3 border-t border-fsoc-border1 flex items-center gap-3">
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setCursor((c) => Math.max(0, c - 1))}>
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setPlaying((p) => !p)} disabled={rows.length === 0}>
                  {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setCursor((c) => Math.min(rows.length - 1, c + 1))}>
                  <ChevronRight className="w-4 h-4" />
                </Button>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, rows.length - 1)}
                  value={cursor}
                  onChange={(e) => {
                    setPlaying(false);
                    setCursor(parseInt(e.target.value));
                  }}
                  className="flex-1 accent-[#72d9e8] h-1"
                />
                <span className="text-[10px] tnum text-fsoc-text3 w-14 text-right">
                  {row ? `t=${row.timestamp.toFixed(1)}s` : '—'}
                </span>
              </div>
            </div>

            {/* frame inspector */}
            <div className="panel px-4 py-3.5">
              <div className="panel-title mb-2.5">Frame Inspector</div>
              {row ? (
                <div className="space-y-1.5 text-[11px] tnum">
                  <KV k="State" v={row.tracking_state} vColor={STATE_COLORS[row.tracking_state as keyof typeof STATE_COLORS]} />
                  <KV k="GT" v={row.gt_x !== null ? `${row.gt_x.toFixed(1)}, ${row.gt_y?.toFixed(1)}` : '—'} />
                  <KV k="Detected" v={row.detected_x !== null ? `${row.detected_x.toFixed(1)}, ${row.detected_y?.toFixed(1)}` : '—'} />
                  <KV k="Error" v={row.error_px !== null ? `${row.error_px.toFixed(2)} px` : '—'} />
                  <KV k="Pan" v={`${row.pan_deg.toFixed(2)}°`} />
                  <KV k="Tilt" v={`${row.tilt_deg.toFixed(2)}°`} />
                  <KV k="Pan cmd" v={`${row.pan_command >= 0 ? '+' : ''}${row.pan_command.toFixed(2)} °/s`} />
                  <KV k="Tilt cmd" v={`${row.tilt_command >= 0 ? '+' : ''}${row.tilt_command.toFixed(2)} °/s`} />
                  <KV k="Locked" v={row.locked ? 'true' : 'false'} vColor={row.locked ? 'var(--success)' : 'var(--text-3)'} />
                  <KV k="Lost" v={row.lost ? 'true' : 'false'} vColor={row.lost ? 'var(--danger)' : 'var(--text-3)'} />
                </div>
              ) : (
                <div className="text-[10px] text-fsoc-text3">No frame selected.</div>
              )}
              <p className="text-[9px] text-fsoc-text3 leading-relaxed mt-3">
                Replay reconstructs the run from its recorded event stream (events.csv) — the simulation is not re-executed.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function KV({ k, v, vColor }: { k: string; v: string; vColor?: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-fsoc-text2">{k}</span>
      <span style={{ color: vColor ?? 'var(--text-1)' }}>{v}</span>
    </div>
  );
}
