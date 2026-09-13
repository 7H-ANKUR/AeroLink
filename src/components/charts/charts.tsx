'use client';

/**
 * Engineering charts (docs/Frontend-Design §15) — tracking error vs the
 * official 10 px threshold, lock timeline strip, pan/tilt traces with
 * configured limits. Data is sampled from engine ring buffers on store
 * flush ticks (~8 Hz) — never per raw frame.
 */
import { useMemo } from 'react';
import {
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { engine } from '@/lib/engine-client';
import { useFsoc } from '@/lib/store';

function ChartPanel({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="panel px-3 py-2.5 h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between mb-1.5">
        <span className="panel-title">{title}</span>
        {right}
      </div>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}

const axisStyle = { fontSize: 9, fill: '#58636d', fontFamily: 'var(--font-tech)' };
const tooltipStyle = {
  background: '#13181d',
  border: '1px solid #313a43',
  borderRadius: 6,
  fontSize: 10,
  fontFamily: 'var(--font-tech)',
  color: '#c3ccd4',
};

export function ErrorChart() {
  const tick = useFsoc((s) => s.refreshTick);
  const data = useMemo(() => {
    void tick;
    return engine.errorSeries
      .filter((p) => Number.isFinite(p.v))
      .slice(-420)
      .map((p) => ({ t: +p.t.toFixed(1), e: +p.v.toFixed(2) }));
  }, [tick]);

  return (
    <ChartPanel
      title="Tracking Error (px)"
      right={
        <span className="text-[9px] tnum text-fsoc-text3">
          TARGET ≤ 10 px · <span className="text-fsoc-gt">GT REF</span>
        </span>
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
          <XAxis dataKey="t" tick={axisStyle} tickLine={false} axisLine={{ stroke: '#252c33' }} minTickGap={40} />
          <YAxis tick={axisStyle} tickLine={false} axisLine={false} width={34} />
          <Tooltip contentStyle={tooltipStyle} labelFormatter={(v) => `t = ${v}s`} />
          <ReferenceLine y={10} stroke="#d8b56b" strokeDasharray="4 4" strokeOpacity={0.7} />
          <Line type="monotone" dataKey="e" stroke="#72d9e8" strokeWidth={1.2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </ChartPanel>
  );
}

export function ControlChart() {
  const tick = useFsoc((s) => s.refreshTick);
  const config = useFsoc((s) => s.config);
  const data = useMemo(() => {
    void tick;
    const pans = engine.panSeries.slice(-420);
    const tilts = engine.tiltSeries.slice(-420);
    const n = Math.min(pans.length, tilts.length);
    return Array.from({ length: n }, (_, i) => ({
      t: +pans[i + (pans.length - n)].t.toFixed(1),
      pan: +pans[i + (pans.length - n)].v.toFixed(3),
      tilt: +tilts[i + (tilts.length - n)].v.toFixed(3),
    }));
  }, [tick]);

  const lim = Math.max(config.camera.maxPanSpeedDegS, config.camera.maxTiltSpeedDegS);

  return (
    <ChartPanel title="Pan / Tilt Rate Command (°/s)">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
          <XAxis dataKey="t" tick={axisStyle} tickLine={false} axisLine={{ stroke: '#252c33' }} minTickGap={40} />
          <YAxis tick={axisStyle} tickLine={false} axisLine={false} width={34} domain={[-lim, lim]} />
          <Tooltip contentStyle={tooltipStyle} labelFormatter={(v) => `t = ${v}s`} />
          <ReferenceLine y={lim} stroke="#58636d" strokeDasharray="3 4" strokeOpacity={0.6} />
          <ReferenceLine y={-lim} stroke="#58636d" strokeDasharray="3 4" strokeOpacity={0.6} />
          <Line type="monotone" dataKey="pan" stroke="#72d9e8" strokeWidth={1} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="tilt" stroke="#d7b36e" strokeWidth={1} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </ChartPanel>
  );
}

export function TrajectoryChart() {
  const tick = useFsoc((s) => s.refreshTick);
  const data = useMemo(() => {
    void tick;
    return engine.trajSeries.slice(-600).map((p) => ({
      gx: p.gtX,
      gy: p.gtY,
      ex: p.estX,
      ey: p.estY,
    }));
  }, [tick]);

  // scene coordinates normalized to view box
  const xs = data.flatMap((d) => [d.gx, d.ex]).filter((v): v is number => v !== null);
  const ys = data.flatMap((d) => [d.gy, d.ey]).filter((v): v is number => v !== null);
  const minX = xs.length ? Math.min(...xs) - 20 : 0;
  const maxX = xs.length ? Math.max(...xs) + 20 : 1;
  const minY = ys.length ? Math.min(...ys) - 20 : 0;
  const maxY = ys.length ? Math.max(...ys) + 20 : 1;

  return (
    <ChartPanel
      title="Target vs Camera Center (scene px)"
      right={
        <span className="text-[9px] text-fsoc-text3 flex gap-2">
          <span className="text-fsoc-gt">━ ground truth</span>
          <span className="text-fsoc-cyan">━ tracked estimate</span>
        </span>
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
          <XAxis dataKey="gx" type="number" domain={[minX, maxX]} hide />
          <YAxis type="number" domain={[minY, maxY]} tick={axisStyle} tickLine={false} axisLine={false} width={34} />
          <Tooltip contentStyle={tooltipStyle} />
          <Line type="monotone" dataKey="gx" stroke="#90a7ff" strokeWidth={1} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="ex" stroke="#72d9e8" strokeWidth={1} dot={false} strokeOpacity={0.85} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </ChartPanel>
  );
}

/** Horizontal state strip (docs/Frontend-Design §15.3). */
export function LockTimeline() {
  const tick = useFsoc((s) => s.refreshTick);
  void tick;
  const bands = engine.lockBands.slice(-80);
  const t0 = bands.length ? bands[0].startT : 0;
  const tEnd = engine.latest?.timestampS ?? 1;
  const span = Math.max(0.001, tEnd - t0);

  const colors: Record<string, string> = {
    SEARCH: '#3a454f',
    CANDIDATE: '#d8b56b',
    ACQUIRE: '#8faee8',
    TRACK: '#79c99b',
    PREDICT_REACQUIRE: '#d7b36e',
  };

  return (
    <ChartPanel
      title="Lock Timeline"
      right={
        <span className="text-[9px] text-fsoc-text3 flex gap-2">
          {Object.entries(colors).map(([k, c]) => (
            <span key={k} className="flex items-center gap-1">
              <span className="w-2 h-[7px] rounded-[1px]" style={{ background: c }} />
              {k === 'PREDICT_REACQUIRE' ? 'PRED' : k}
            </span>
          ))}
        </span>
      }
    >
      <div className="h-5 flex items-center gap-[2px] w-full overflow-hidden">
        {bands.map((b, i) => {
          const end = b.endT < 0 ? tEnd : b.endT;
          const width = Math.max(0.4, ((end - b.startT) / span) * 100);
          return (
            <div
              key={i}
              className="h-3 rounded-[1px] shrink-0"
              style={{ width: `${width}%`, background: colors[b.state] ?? '#3a454f', opacity: 0.85 }}
              title={`${b.state} @ t=${b.startT.toFixed(1)}s`}
            />
          );
        })}
        {bands.length === 0 && <div className="text-[10px] text-fsoc-text3">No run data — start a run to record the state timeline.</div>}
      </div>
    </ChartPanel>
  );
}
