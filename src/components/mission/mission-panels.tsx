'use client';

/**
 * Mission-layer panels (master prompt §20, §21, §23, §42).
 *
 * All three render engine state only. Where a value has not been observed yet
 * they show a dash or UNKNOWN — none of them assumes success, and none shows a
 * PASS badge for something the run has not actually done.
 */
import { Check, Minus, X } from 'lucide-react';
import { useFsoc } from '@/lib/store';

/** §23 — mission progress. A phase lights only when the engine reached it. */
export function MissionPhaseStrip() {
  const t = useFsoc((s) => s.telemetry);
  const phases = t?.mission.phases ?? [];

  if (phases.length === 0) {
    return (
      <div className="panel px-3 py-2 flex items-center gap-2">
        <span className="panel-title">Optical Acquisition</span>
        <span className="text-[11px] text-fsoc-text3">No active run — start a run to track mission phases.</span>
      </div>
    );
  }

  return (
    <div className="panel px-3 py-2">
      <div className="flex items-center gap-2 mb-2">
        <span className="panel-title">Optical Acquisition</span>
        <span className="text-[10px] text-fsoc-text3 tnum">
          {phases.filter((p) => p.reached).length}/{phases.length} phases
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {phases.map((p) => (
          <div
            key={p.id}
            title={`${p.plain}${p.atS !== null ? ` — reached at t+${p.atS.toFixed(2)}s` : ' — not yet reached'}`}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md border text-[10px] transition-colors"
            style={{
              borderColor: p.reached ? 'var(--success)' : 'var(--border-1)',
              background: p.reached ? 'color-mix(in srgb, var(--success) 10%, transparent)' : 'transparent',
              color: p.reached ? 'var(--text-0)' : 'var(--text-3)',
            }}
          >
            {p.reached ? (
              <Check className="w-3 h-3" style={{ color: 'var(--success)' }} />
            ) : (
              <span className="w-3 h-3 rounded-full border border-fsoc-border2" />
            )}
            <span className="tracking-[0.04em]">{p.label}</span>
            {p.atS !== null && <span className="tnum text-fsoc-text3">t+{p.atS.toFixed(1)}s</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** §20 — SIMULATED optical link. Labelled as a model everywhere it appears. */
export function SimulatedLinkPanel() {
  const t = useFsoc((s) => s.telemetry);
  const link = t?.link ?? null;

  const stateColor =
    link === null
      ? 'var(--text-3)'
      : link.state === 'ACQUIRED'
        ? 'var(--success)'
        : link.state === 'DEGRADED'
          ? 'var(--warning)'
          : link.state === 'LOST'
            ? 'var(--danger)'
            : 'var(--text-2)';

  const pct = link?.signalLevelPercent ?? 0;

  return (
    <div className="panel px-3 py-3">
      <div className="flex items-center justify-between mb-1">
        <div className="panel-title">Simulated Optical Link</div>
        <span className="text-[10px] font-semibold tracking-[0.1em]" style={{ color: stateColor }}>
          {link?.state ?? '—'}
        </span>
      </div>
      <p className="text-[9px] leading-relaxed text-fsoc-text3 mb-2.5">
        Model of the downstream link given the achieved pointing error. Not a physical optical measurement — no
        detector or laser exists in this system.
      </p>

      <div className="h-1.5 rounded-full bg-fsoc-bg2 overflow-hidden mb-2.5">
        <div
          className="h-full rounded-full transition-[width] duration-150"
          style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: stateColor }}
        />
      </div>

      <div className="space-y-1.5">
        <LinkRow label="Beacon" value={link ? (link.beaconDetected ? 'DETECTED' : 'NOT DETECTED') : '—'} />
        <LinkRow
          label="Boresight error"
          value={link?.boresightErrorDeg != null ? `${link.boresightErrorDeg.toFixed(3)}°` : '—'}
        />
        <LinkRow label="Atmosphere" value={link ? link.atmosphere.replace('_', ' ').toUpperCase() : '—'} />
        <LinkRow label="Signal level" value={link ? `${link.signalLevelPercent.toFixed(1)} %` : '—'} />
        <LinkRow label="Pointing loss" value={link ? `${link.pointingLossDb.toFixed(2)} dB` : '—'} />
        <LinkRow label="Atmospheric loss" value={link ? `${link.atmosphericLossDb.toFixed(2)} dB` : '—'} />
        <LinkRow
          label="Link margin"
          value={link ? `${link.linkMarginDb >= 0 ? '+' : ''}${link.linkMarginDb.toFixed(2)} dB` : '—'}
          color={link ? (link.linkMarginDb > 0 ? 'var(--success)' : 'var(--danger)') : undefined}
        />
      </div>
    </div>
  );
}

function LinkRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-fsoc-text2">{label}</span>
      <span className="tnum text-[11px]" style={{ color: color ?? 'var(--text-1)' }}>
        {value}
      </span>
    </div>
  );
}

/** §21 — evidence mode: the data chain and the live integrity checks. */
export function EvidencePanel() {
  const t = useFsoc((s) => s.telemetry);
  const config = useFsoc((s) => s.config);
  const phase = useFsoc((s) => s.phase);
  const checks = t?.mission.checks ?? [];

  // Each link reports a live value taken from this frame, so the chain shows
  // what is actually flowing rather than a static diagram.
  const cmdMatches =
    t !== null &&
    Math.abs(t.mount.commandedPanRateDegS - t.command.pan_deg_s) < 1e-9 &&
    Math.abs(t.mount.commandedTiltRateDegS - t.command.tilt_deg_s) < 1e-9;
  const mountMoving =
    t !== null && Math.abs(t.mount.actualPanRateDegS) + Math.abs(t.mount.actualTiltRateDegS) > 1e-6;
  const chain = [
    {
      label: 'BEACON → CAMERA OBSERVATION',
      live: t !== null && t.frameIndex > 0,
      evidence: t ? `frame ${t.frameIndex}` : '—',
    },
    {
      label: 'OBSERVATION → DETECTOR',
      live: t !== null,
      evidence: t ? `${t.detection.latency_ms.toFixed(2)} ms` : '—',
    },
    {
      label: 'DETECTOR → TRACKER',
      live: t !== null && t.detection.found,
      evidence: t && t.detection.found && t.detection.x !== null
        ? `(${t.detection.x.toFixed(0)}, ${t.detection.y?.toFixed(0)})`
        : 'no detection',
    },
    {
      label: 'TRACKER → CONTROLLER',
      live: t !== null && t.track.x !== null,
      evidence: t?.track.x != null ? `${t.track.state}` : '—',
    },
    {
      label: 'CONTROLLER → MOUNT',
      live: cmdMatches,
      evidence: t ? `${t.command.pan_deg_s.toFixed(2)} °/s` : '—',
    },
    {
      label: 'MOUNT → CAMERA POSE',
      live: mountMoving,
      evidence: t ? `${t.mount.azimuthDeg.toFixed(3)}°` : '—',
    },
  ];

  return (
    <div className="panel px-3 py-3">
      <div className="panel-title mb-2">Evidence</div>

      <div className="space-y-1.5 mb-3">
        <LinkRow label="Scenario" value={config.scenarioName.slice(0, 26)} />
        <LinkRow label="Seed" value={String(config.seed)} />
        <LinkRow label="Frame" value={t ? String(t.frameIndex) : '—'} />
        <LinkRow label="Source" value="SIMULATION" />
        <LinkRow label="Detector" value="CLASSICAL CV" />
        <LinkRow label="Tracker" value="KALMAN CONSTANT-VELOCITY" />
        <LinkRow label="Controller" value="PID ANGLE SPACE" />
        <LinkRow label="Ground truth" value="METRICS ONLY" />
        <LinkRow
          label="Camera control"
          value={config.tracking.controllerEnabled ? 'CLOSED LOOP' : 'CONTROLLER OFF'}
          color={config.tracking.controllerEnabled ? undefined : 'var(--warning)'}
        />
        <LinkRow
          label="Detector state"
          value={config.tracking.detectorEnabled ? 'ENABLED' : 'DETECTOR OFF'}
          color={config.tracking.detectorEnabled ? undefined : 'var(--warning)'}
        />
      </div>

      {/* §8 — the data chain, link by link, verified from live values */}
      <div className="panel-title !text-[9px] mb-1.5">Data chain</div>
      <div className="space-y-1 mb-3">
        {chain.map((c) => (
          <div key={c.label} className="flex items-center gap-2">
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ background: c.live ? 'var(--success)' : 'var(--border-2)' }}
            />
            <span className="text-[10.5px] text-fsoc-text1 flex-1 min-w-0 truncate">{c.label}</span>
            <span className="tnum text-[9px] text-fsoc-text3 shrink-0">{c.evidence}</span>
          </div>
        ))}
        <div className="flex items-center gap-2 pt-1 mt-1 border-t border-fsoc-border1">
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'var(--accent-blue)' }} />
          <span className="text-[10.5px] text-fsoc-text1 flex-1">GROUND TRUTH → METRICS ONLY</span>
          <span className="text-[9px] text-fsoc-text3">never to detector / tracker / controller</span>
        </div>
      </div>

      <div className="panel-title !text-[9px] mb-1.5">Integrity checks</div>
      {checks.length === 0 ? (
        <div className="text-[11px] text-fsoc-text3">
          {phase === 'idle' ? 'Start a run to compute integrity checks.' : 'Awaiting frames…'}
        </div>
      ) : (
        <div className="space-y-2">
          {checks.map((c) => (
            <div key={c.id} className="flex items-start gap-2">
              <VerdictBadge verdict={c.verdict} />
              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-fsoc-text1 leading-tight">{c.label}</div>
                <div className="text-[9px] text-fsoc-text3 tnum leading-snug">{c.detail}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function VerdictBadge({ verdict }: { verdict: 'PASS' | 'FAIL' | 'UNKNOWN' }) {
  if (verdict === 'PASS') {
    return (
      <span className="shrink-0 mt-0.5 inline-flex items-center gap-1 text-[9px] tracking-wider px-1.5 py-0.5 rounded border"
        style={{ color: 'var(--success)', borderColor: 'color-mix(in srgb, var(--success) 45%, transparent)' }}>
        <Check className="w-2.5 h-2.5" /> PASS
      </span>
    );
  }
  if (verdict === 'FAIL') {
    return (
      <span className="shrink-0 mt-0.5 inline-flex items-center gap-1 text-[9px] tracking-wider px-1.5 py-0.5 rounded border"
        style={{ color: 'var(--danger)', borderColor: 'color-mix(in srgb, var(--danger) 45%, transparent)' }}>
        <X className="w-2.5 h-2.5" /> FAIL
      </span>
    );
  }
  return (
    <span className="shrink-0 mt-0.5 inline-flex items-center gap-1 text-[9px] tracking-wider px-1.5 py-0.5 rounded border border-fsoc-border1 text-fsoc-text3">
      <Minus className="w-2.5 h-2.5" /> N/A
    </span>
  );
}
