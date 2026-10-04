'use client';

/**
 * Perception chain panel (AI plan Phase 14).
 *
 * Shows the classical stage, the learned stage and the fusion decision for the
 * CURRENT FRAME, so the whole perception chain is visible rather than just its
 * conclusion.
 *
 * THE WORD "AI" APPEARS HERE ONLY WHEN A MODEL IS ACTUALLY RUNNING.
 *
 * With the classical detector selected there is no learned stage, and this
 * panel says exactly that instead of showing an empty AI section that implies
 * one exists. Every number below is read from `detection.provenance`, which is
 * populated by the detector that ran — there is no separate display path that
 * could show something the engine did not produce.
 */
import { useFsoc } from '@/lib/store';

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-fsoc-text2">{label}</span>
      <span className="tnum text-[11px]" style={{ color: color ?? 'var(--text-1)' }}>
        {value}
      </span>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="panel-title !text-[9px] mb-1.5 mt-2.5 first:mt-0">{children}</div>;
}

const CHOSEN_BY_LABEL: Record<string, string> = {
  'cv-only': 'CLASSICAL',
  agreement: 'BOTH STAGES AGREED',
  'ai-override': 'LEARNED MODEL',
  'temporal-override': 'KALMAN PREDICTION',
  'track-verified': 'TEMPORAL VERIFIER',
  ai: 'LEARNED MODEL',
  none: 'NO CANDIDATE ACCEPTED',
};

export function PerceptionPanel() {
  const t = useFsoc((s) => s.telemetry);
  const config = useFsoc((s) => s.config);
  const phase = useFsoc((s) => s.phase);

  const detector = config.tracking.detector;
  const learned = detector === 'ai' || detector === 'fusion' || detector === 'ai_fullframe';
  const det = t?.detection ?? null;
  const p = det?.provenance ?? null;

  return (
    <div className="panel px-3 py-3">
      <div className="flex items-center justify-between mb-1">
        <div className="panel-title">Perception Chain</div>
        <span className="text-[9px] tracking-[0.1em] text-fsoc-text3">
          {detector === 'cv_classical'
            ? 'CLASSICAL CV'
            : detector === 'ai'
              ? 'LEARNED AI BRANCH'
              : detector === 'ai_fullframe'
                ? 'LEARNED FULL-FRAME'
                : 'HYBRID CV + AI + TEMPORAL'}
        </span>
      </div>

      {!learned && (
        <p className="text-[9px] leading-relaxed text-fsoc-text3 mb-1">
          No learned model is active in this run. The detector is classical computer vision:
          threshold, connected components and an intensity-weighted centroid.
        </p>
      )}

      <SectionTitle>Classical CV</SectionTitle>
      <div className="space-y-1.5">
        <Row label="Candidates proposed" value={p ? String(p.candidateCount) : det ? '—' : '—'} />
        <Row
          label="Top confidence"
          value={p?.cv ? p.cv.confidence.toFixed(3) : det ? det.confidence.toFixed(3) : '—'}
        />
        <Row
          label="Position"
          value={
            p?.cv
              ? `(${p.cv.x.toFixed(0)}, ${p.cv.y.toFixed(0)})`
              : det?.found && det.x !== null
                ? `(${det.x.toFixed(0)}, ${det.y?.toFixed(0)})`
                : '—'
          }
        />
        <Row
          label="Stage latency"
          value={p ? `${p.cvLatencyMs.toFixed(3)} ms` : det ? `${det.latency_ms.toFixed(3)} ms` : '—'}
        />
      </div>

      {learned && (
        <>
          <SectionTitle>AI branch</SectionTitle>
          <div className="space-y-1.5">
            <Row
              label="Own proposals"
              value={p?.aiBranchCount != null ? String(p.aiBranchCount) : '—'}
            />
            <Row
              label="Beacon confidence"
              value={p?.ai ? p.ai.confidence.toFixed(3) : '—'}
              color={
                p?.ai ? (p.ai.confidence >= 0.5 ? 'var(--success)' : 'var(--warning)') : undefined
              }
            />
            <Row
              label="Position"
              value={p?.ai ? `(${p.ai.x.toFixed(0)}, ${p.ai.y.toFixed(0)})` : '—'}
            />
            <Row label="ROIs scored" value={p?.aiScored != null ? String(p.aiScored) : '—'} />
            <Row
              label="Inference runtime"
              value={p?.aiRuntime ? (p.aiRuntime.startsWith('onnxruntime-web') ? 'ONNX RUNTIME WEB' : 'IN-ENGINE TS') : '—'}
              color={p?.aiRuntime?.startsWith('onnxruntime-web') ? 'var(--success)' : undefined}
            />
            <Row label="Inference time" value={p?.aiInferenceMs != null ? `${p.aiInferenceMs.toFixed(2)} ms` : '—'} />
            <Row label="Candidates rejected" value={p ? String(p.aiRejected) : '—'} />
            <Row label="Stage latency" value={p ? `${p.aiLatencyMs.toFixed(3)} ms` : '—'} />
          </div>
        </>
      )}

      {detector === 'fusion' && (
        <>
          <SectionTitle>Decision engine</SectionTitle>
          <div className="space-y-1.5">
            <Row
              label="Spatial agreement"
              value={
                p?.spatialAgreementPx != null ? `${p.spatialAgreementPx.toFixed(1)} px apart` : '—'
              }
              color={
                p?.spatialAgreementPx != null
                  ? p.spatialAgreementPx <= 3
                    ? 'var(--success)'
                    : 'var(--warning)'
                  : undefined
              }
            />
            <Row
              label="Stages disagreed"
              value={p ? (p.disagreed ? 'YES' : 'NO') : '—'}
              color={p?.disagreed ? 'var(--warning)' : undefined}
            />
            <Row
              label="Distance to prediction"
              value={
                p?.predictionDistancePx != null
                  ? `${p.predictionDistancePx.toFixed(1)} px`
                  : 'no prediction'
              }
            />
            <Row label="Stage latency" value={p ? `${p.fusionLatencyMs.toFixed(3)} ms` : '—'} />
          </div>

          <SectionTitle>Temporal verifier</SectionTitle>
          <div className="space-y-1.5">
            <Row
              label="Chosen track"
              value={p?.trackId != null ? `#${p.trackId} · ${p.trackAgeFrames ?? 0} frames` : '—'}
            />
            <Row
              label="World speed"
              value={p?.trackSpeedPxS != null ? `${p.trackSpeedPxS.toFixed(0)} px/s` : '—'}
            />
            <Row
              label="P(beacon), learned"
              value={p?.trackP != null ? p.trackP.toFixed(3) : '—'}
              color={
                p?.trackP != null
                  ? p.trackP >= 0.5
                    ? 'var(--success)'
                    : 'var(--warning)'
                  : undefined
              }
            />
            <Row label="Live candidate tracks" value={p?.liveTracks != null ? String(p.liveTracks) : '—'} />
            <Row label="Clutter map points" value={p?.clutterPoints != null ? String(p.clutterPoints) : '—'} />
            <Row
              label="Rejected as decoy/clutter"
              value={p?.trackRejected != null ? String(p.trackRejected) : '—'}
              color={p?.trackRejected ? 'var(--warning)' : undefined}
            />
            <Row
              label="Stage latency"
              value={p?.temporalLatencyMs != null ? `${p.temporalLatencyMs.toFixed(3)} ms` : '—'}
            />
          </div>
        </>
      )}

      <SectionTitle>Final decision</SectionTitle>
      <div className="space-y-1.5">
        <Row
          label="Beacon"
          value={
            det?.found && det.x !== null && det.y !== null
              ? `(${det.x.toFixed(1)}, ${det.y.toFixed(1)})`
              : phase === 'idle'
                ? '—'
                : 'NOT DETECTED'
          }
          color={det?.found ? undefined : phase === 'idle' ? undefined : 'var(--warning)'}
        />
        <Row label="Confidence" value={det ? det.confidence.toFixed(3) : '—'} />
        {p?.chosenFusionScore != null && (
          <Row label="Fused score" value={p.chosenFusionScore.toFixed(3)} />
        )}
        <Row
          label="Decided by"
          value={p ? (CHOSEN_BY_LABEL[p.chosenBy] ?? p.chosenBy.toUpperCase()) : 'CLASSICAL'}
        />
        <Row
          label="Found by"
          value={p?.chosenSource ? (p.chosenSource === 'both' ? 'BOTH BRANCHES' : p.chosenSource === 'ai' ? 'AI BRANCH ONLY' : 'CLASSICAL BRANCH') : '—'}
        />
        <Row label="Method" value={det ? det.method.toUpperCase() : '—'} />
      </div>
      {p?.decisionReason && (
        <p className="text-[9px] leading-relaxed text-fsoc-text3 mt-1.5">Reason: {p.decisionReason}</p>
      )}

      <SectionTitle>Control chain</SectionTitle>
      <div className="space-y-1.5">
        <Row label="Tracker state" value={t ? t.track.state : '—'} />
        <Row
          label="Kalman prediction"
          value={t?.predicted ? `(${t.predicted.x.toFixed(1)}, ${t.predicted.y.toFixed(1)})` : '—'}
        />
        <Row
          label="Controller command"
          value={t ? `${t.command.pan_deg_s.toFixed(2)} / ${t.command.tilt_deg_s.toFixed(2)} °/s` : '—'}
        />
        <Row
          label="Mount response"
          value={t ? `${t.mount.actualPanRateDegS.toFixed(2)} / ${t.mount.actualTiltRateDegS.toFixed(2)} °/s` : '—'}
          color={t?.mount.accelLimited ? 'var(--warning)' : undefined}
        />
        <Row
          label="Mount pose"
          value={t ? `az ${t.mount.azimuthDeg.toFixed(3)}° · el ${t.mount.elevationDeg.toFixed(3)}°` : '—'}
        />
      </div>
    </div>
  );
}
