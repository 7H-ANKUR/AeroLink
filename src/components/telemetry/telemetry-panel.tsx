'use client';

/**
 * Right telemetry panel (docs/Frontend-Design §12-§14, §42, §43) —
 * "single source of truth" for run state. State labels mirror the backend
 * machine 1:1. PS-169 official targets visually distinct from internal
 * thresholds. Values update from the throttled store flush (~8 Hz).
 */
import { Check, X, Minus } from 'lucide-react';
import { useFsoc } from '@/lib/store';
import { STATE_COLORS, STATE_LABELS } from '@/components/shell/state-colors';

function Row({ label, value, unit, mono = true }: { label: string; value: string; unit?: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-fsoc-text2">{label}</span>
      <span className={`${mono ? 'tnum' : ''} text-[11px] text-fsoc-text1`}>
        {value}
        {unit && <span className="text-fsoc-text3 ml-0.5">{unit}</span>}
      </span>
    </div>
  );
}

function GateBadge({ pass, na }: { pass: boolean | null | undefined; na?: boolean }) {
  if (na || pass === undefined || pass === null) {
    return (
      <span className="inline-flex items-center gap-1 text-[9px] tracking-wider text-fsoc-text3 border border-fsoc-border1 rounded px-1.5 py-0.5">
        <Minus className="w-2.5 h-2.5" /> N/A
      </span>
    );
  }
  return pass ? (
    <span className="inline-flex items-center gap-1 text-[9px] tracking-wider text-fsoc-success border border-fsoc-success/40 rounded px-1.5 py-0.5">
      <Check className="w-2.5 h-2.5" /> PASS
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[9px] tracking-wider text-fsoc-danger border border-fsoc-danger/40 rounded px-1.5 py-0.5">
      <X className="w-2.5 h-2.5" /> FAIL
    </span>
  );
}

function PerfCard({
  label,
  value,
  sub,
  subColor,
}: {
  label: string;
  value: string;
  sub?: string;
  subColor?: string;
}) {
  return (
    <div className="panel-elevated px-2.5 py-2">
      <div className="text-[9px] tracking-[0.14em] text-fsoc-text3 font-semibold">{label}</div>
      <div className="tnum text-[17px] leading-tight text-fsoc-text0 mt-0.5">{value}</div>
      {sub && (
        <div className="text-[9px] tnum mt-0.5" style={{ color: subColor ?? 'var(--text-3)' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

export function TelemetryPanel() {
  const t = useFsoc((s) => s.telemetry);
  const phase = useFsoc((s) => s.phase);
  const config = useFsoc((s) => s.config);
  const killBeacon = useFsoc((s) => s.killBeacon);
  const running = phase === 'running';

  const state = t?.track.state ?? 'SEARCH';
  const stateColor = running || phase === 'paused' ? STATE_COLORS[state] : 'var(--text-3)';
  const m = t?.metrics;
  const err = t?.errorPx ?? null;
  const inTarget = err !== null && err <= config.tracking.lockRadiusPx;

  const acq = m?.acquisitionTimeS ?? null;
  const reacq = m?.reacquisitionAvgS ?? null;
  const loss = m?.lossPercent ?? null;
  const fps = m?.fpsAlgorithm ?? null;

  return (
    <div className="h-full overflow-y-auto pl-1 space-y-2.5">
      {/* state header */}
      <div className="panel px-3 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full" style={{ background: stateColor }} />
            <span className="text-[15px] font-bold tracking-[0.12em]" style={{ color: stateColor }}>
              {running || phase === 'paused' ? STATE_LABELS[state] : 'STANDBY'}
            </span>
          </div>
          <span className="text-[10px] tnum text-fsoc-text2">Beacon #{String(config.beacon.count).padStart(2, '0')}</span>
        </div>
        <div className="mt-2.5 space-y-1.5">
          <Row label="Acquired" value={acq !== null ? `${acq.toFixed(2)} s` : '—'} />
          <Row label="Track age" value={t ? `${t.track.track_age_frames.toLocaleString()} f` : '—'} />
          <Row label="Lost frames" value={t ? `${t.track.lost_frames_consecutive}` : '—'} />
        </div>
      </div>

      {/* position */}
      <div className="panel px-3 py-3">
        <div className="panel-title mb-2">Position</div>
        <div className="space-y-1.5">
          <Row label="X" value={t?.track.x !== null && t?.track.x !== undefined ? t.track.x.toFixed(1) : '—'} unit="px" />
          <Row label="Y" value={t?.track.y !== null && t?.track.y !== undefined ? t.track.y.toFixed(1) : '—'} unit="px" />
          <Row label="VX" value={t?.track.vx !== null && t?.track.vx !== undefined ? `${t.track.vx >= 0 ? '+' : ''}${t.track.vx.toFixed(1)}` : '—'} unit="px/s" />
          <Row label="VY" value={t?.track.vy !== null && t?.track.vy !== undefined ? `${t.track.vy >= 0 ? '+' : ''}${t.track.vy.toFixed(1)}` : '—'} unit="px/s" />
        </div>
      </div>

      {/* error */}
      <div className="panel px-3 py-3">
        <div className="panel-title mb-2">Tracking Error</div>
        <div className="flex items-baseline gap-2">
          <span className={`tnum text-[26px] font-semibold ${err !== null && !inTarget && running ? 'text-fsoc-warning' : 'text-fsoc-text0'}`}>
            {err !== null ? err.toFixed(2) : '—'}
          </span>
          <span className="text-[11px] text-fsoc-text3">px</span>
        </div>
        <div className="mt-2 space-y-1.5">
          <Row label="PS-169 official target" value="≤ 10 px" />
          <Row label="Internal lock radius" value={`${config.tracking.lockRadiusPx} px`} />
          <Row label="Angular error" value={err !== null ? `${((err / config.camera.resolutionWidth) * config.camera.fovXDeg).toFixed(3)}°` : '—'} />
        </div>
      </div>

      {/* performance cards */}
      <div className="grid grid-cols-2 gap-2">
        <PerfCard
          label="PIPE FPS"
          value={fps !== null ? fps.toFixed(1) : '—'}
          sub={fps !== null ? (fps >= 20 ? `✓ ALGORITHM ≥ 20 PS` : `× ALGORITHM < 20 PS`) : 'pipeline-only'}
          subColor={fps !== null ? (fps >= 20 ? 'var(--success)' : 'var(--danger)') : undefined}
        />
        <PerfCard
          label="AVG ERROR"
          value={m?.avgErrorPx !== null && m?.avgErrorPx !== undefined ? `${m.avgErrorPx.toFixed(2)}` : '—'}
          sub="px"
        />
        <PerfCard
          label="LOCK"
          value={m?.lockRetentionPercent !== null && m?.lockRetentionPercent !== undefined ? `${m.lockRetentionPercent.toFixed(1)}` : '—'}
          sub="%"
        />
        <PerfCard
          label="LOSS"
          value={loss !== null ? `${loss.toFixed(1)}` : '—'}
          sub="%"
          subColor={loss !== null ? (loss < 5 ? 'var(--success)' : 'var(--danger)') : undefined}
        />
        <PerfCard label="ACQ" value={acq !== null ? acq.toFixed(2) : '—'} sub="s" />
        <PerfCard label="RE-ACQ" value={reacq !== null ? reacq.toFixed(2) : '—'} sub={m && m.reacquisitionEvents > 0 ? `${m.reacquisitionEvents} events` : 's'} />
      </div>

      {/* control output */}
      <div className="panel px-3 py-3">
        <div className="panel-title mb-2">Control Output</div>
        <div className="space-y-1.5">
          <Row
            label="PAN"
            value={t ? `${t.command.pan_deg_s >= 0 ? '+' : ''}${t.command.pan_deg_s.toFixed(2)}` : '—'}
            unit="°/s"
          />
          <Row
            label="TILT"
            value={t ? `${t.command.tilt_deg_s >= 0 ? '+' : ''}${t.command.tilt_deg_s.toFixed(2)}` : '—'}
            unit="°/s"
          />
          <Row label="Limit PAN" value={config.camera.maxPanSpeedDegS.toFixed(2)} unit="°/s" />
          <Row label="Limit TILT" value={config.camera.maxTiltSpeedDegS.toFixed(2)} unit="°/s" />
        </div>
      </div>

      {/* PS-169 benchmark */}
      <div className="panel px-3 py-3">
        <div className="flex items-center justify-between mb-2">
          <div className="panel-title">PS-169 Benchmark</div>
          <GateBadge na={m === null} pass={null} />
        </div>
        <div className="space-y-2">
          <BenchmarkRow
            label="Acquisition"
            measured={acq !== null ? `${acq.toFixed(2)} s` : '—'}
            target="≤ 2.00 s"
            pass={acq !== null ? acq <= 2 : null}
          />
          <BenchmarkRow
            label="Tracking error"
            measured={m?.avgErrorPx !== null && m?.avgErrorPx !== undefined ? `${m.avgErrorPx.toFixed(2)} px` : '—'}
            target="≤ 10 px"
            pass={m?.avgErrorPx != null ? m.avgErrorPx <= 10 : null}
          />
          <BenchmarkRow
            label="Target loss"
            measured={loss !== null ? `${loss.toFixed(2)} %` : '—'}
            target="< 5 %"
            pass={loss !== null ? loss < 5 : null}
          />
          <BenchmarkRow
            label="Re-acquisition"
            measured={reacq !== null ? `${reacq.toFixed(2)} s` : '—'}
            target="≤ 1.00 s"
            pass={reacq !== null ? reacq <= 1 : null}
          />
          <BenchmarkRow
            label="Processing"
            measured={fps !== null ? `${fps.toFixed(1)} FPS` : '—'}
            target="≥ 20 FPS"
            pass={fps !== null ? fps >= 20 : null}
          />
        </div>
        <p className="text-[9px] text-fsoc-text3 leading-relaxed mt-2.5">
          Official PS-169 targets — distinct from internal engineering thresholds shown above.
        </p>
      </div>

      {/* active disturbances */}
      <div className="panel px-3 py-3">
        <div className="panel-title mb-2">Disturbance Chain</div>
        {t && t.activeDisturbances.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {t.activeDisturbances.map((dstrb) => (
              <span key={dstrb} className="text-[9px] px-1.5 py-0.5 rounded border border-fsoc-warning/40 text-fsoc-warning">
                {dstrb}
              </span>
            ))}
          </div>
        ) : (
          <div className="text-[11px] text-fsoc-text3">Clear — no active disturbances</div>
        )}
        <div className="mt-2.5 space-y-1.5">
          <Row label="Jitter offset" value={t ? `${t.jitterPx.toFixed(1)}` : '—'} unit="px" />
          <Row label="Processing" value={t ? t.processingMs.toFixed(1) : '—'} unit="ms" />
        </div>
        <button
          className="mt-3 w-full h-7 rounded-md border border-fsoc-danger/40 text-[10px] tracking-[0.12em] text-fsoc-danger hover:bg-fsoc-danger/10 transition-colors disabled:opacity-40"
          onClick={killBeacon}
          disabled={!running}
          title="Debug: hide the beacon for 45 frames to demonstrate loss → prediction → reacquisition"
        >
          KILL BEACON (LOSS DEMO)
        </button>
      </div>
    </div>
  );
}

function BenchmarkRow({ label, measured, target, pass }: { label: string; measured: string; target: string; pass: boolean | null }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <div className="text-[11px] text-fsoc-text1 truncate">{label}</div>
        <div className="text-[9px] text-fsoc-text3 tnum">{target}</div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="tnum text-[11px] text-fsoc-text0">{measured}</span>
        <GateBadge pass={pass} />
      </div>
    </div>
  );
}
