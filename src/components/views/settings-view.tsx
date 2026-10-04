'use client';

/**
 * Settings (docs/Frontend-Design §46) — application-level configuration,
 * PS-169 target reference table, keyboard shortcuts, engine information.
 */
import { Keyboard, Info, Target, Download } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useFsoc } from '@/lib/store';
import { engine } from '@/lib/store';
import { PS_TARGETS, SOFTWARE_VERSION } from '@/engine/metrics';
import { downloadText, summaryHtml } from '@/engine/export';

export function SettingsView() {
  const config = useFsoc((s) => s.config);
  const setConfig = useFsoc((s) => s.setConfig);

  const patch = (fn: (draft: typeof config) => void) => {
    const draft = structuredClone(config);
    fn(draft);
    setConfig(draft);
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4">
      <div className="max-w-3xl mx-auto space-y-4">
        <h2 className="text-[16px] font-semibold tracking-[0.14em] text-fsoc-text0">SETTINGS</h2>

        <div className="panel px-5 py-4">
          <div className="panel-title mb-3">Run Defaults</div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-[12px] text-fsoc-text1">Count Kalman predictions as locked</Label>
                <p className="text-[10px] text-fsoc-text3 mt-0.5">
                  Lock-retention policy — stated in every report (docs/08 §1). Default ON.
                </p>
              </div>
              <Switch
                checked={config.tracking.countPredictionAsLocked}
                onCheckedChange={(v) => patch((d) => { d.tracking.countPredictionAsLocked = v; })}
              />
            </div>
          </div>
        </div>

        <div className="panel px-5 py-4">
          <div className="flex items-center gap-2 mb-3">
            <Target className="w-4 h-4 text-fsoc-text2" />
            <div className="panel-title">PS-169 Official Acceptance Targets</div>
          </div>
          <div className="grid sm:grid-cols-2 gap-x-8 gap-y-2 text-[11px]">
            {[
              ['Acquisition time', `≤ ${PS_TARGETS.acquisition_s.toFixed(2)} s`],
              ['Tracking error (avg)', `≤ ${PS_TARGETS.tracking_error_px} px`],
              ['Target loss', `< ${PS_TARGETS.target_loss_percent} %`],
              ['Re-acquisition', `≤ ${PS_TARGETS.reacquisition_s.toFixed(2)} s`],
              ['Processing speed', `≥ ${PS_TARGETS.processing_fps} FPS`],
              ['Camera update rate', '≥ 30 Hz'],
              ['Default FOV', '4° × 3°'],
              ['Default beacon', '10 × 10 px, square'],
              ['Max pan/tilt speed', '5 °/s'],
              ['Max camera jitter', '±20 px/frame'],
              ['Max platform motion', '±20 px/frame'],
              ['Noise std-dev', 'up to 20'],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between border-b border-fsoc-border1/40 pb-1.5">
                <span className="text-fsoc-text2">{k}</span>
                <span className="tnum text-fsoc-text1">{v}</span>
              </div>
            ))}
          </div>
          <p className="text-[9px] text-fsoc-text3 leading-relaxed mt-3">
            Values from the source problem statement — displayed separately from internal engineering thresholds
            (deadband, confirm-frame counts, lock radius) which live in the Scenario and Algorithm panels.
          </p>
        </div>

        <div className="panel px-5 py-4">
          <div className="flex items-center gap-2 mb-3">
            <Keyboard className="w-4 h-4 text-fsoc-text2" />
            <div className="panel-title">Keyboard Shortcuts</div>
          </div>
          <div className="grid sm:grid-cols-2 gap-x-8 gap-y-1.5 text-[11px]">
            {[
              ['Space', 'Start / Pause run'],
              ['Esc', 'Stop run'],
              ['1', 'Mission Control'],
              ['2', 'Scenarios'],
              ['3', 'Analytics'],
              ['G', 'Toggle ground-truth overlay'],
              ['L', 'Focus event log'],
              ['K', 'Kill beacon (loss demo)'],
            ].map(([k, d]) => (
              <div key={k} className="flex items-center justify-between">
                <span className="text-fsoc-text2">{d}</span>
                <kbd className="px-1.5 py-0.5 rounded border border-fsoc-border1 text-fsoc-text1 tnum">{k}</kbd>
              </div>
            ))}
          </div>
        </div>

        <div className="panel px-5 py-4">
          <div className="flex items-center gap-2 mb-3">
            <Info className="w-4 h-4 text-fsoc-text2" />
            <div className="panel-title">System</div>
          </div>
          <div className="space-y-1.5 text-[11px]">
            <Row k="Software version" v={SOFTWARE_VERSION} />
            <Row k="Engine" v="Web Worker · deterministic seeded pipeline" />
            <Row k="Detector" v="Classical CV (threshold → connected components → weighted centroid)" />
            <Row k="Tracker" v="Kalman constant-velocity + SEARCH/CANDIDATE/ACQUIRE/TRACK/PREDICT_REACQUIRE" />
            <Row k="Controller" v="PID in angle-error space (pixel→degree conversion before control law)" />
            <Row k="Registry" v="SQLite via Prisma — runs persist automatically" />
          </div>
          <div className="flex gap-2 mt-4">
            <Button
              variant="secondary"
              size="sm"
              className="gap-1.5 h-8 text-[11px]"
              onClick={() => {
                const sample = engine.lastResult;
                if (sample) downloadText(`${sample.run_id}-summary.html`, summaryHtml(sample), 'text/html');
              }}
              disabled={!engine.lastResult}
            >
              <Download className="w-3.5 h-3.5" /> Download last report
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="h-8 text-[11px]"
              onClick={() => engine.hardReset()}
            >
              Hard-reset engine worker
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-fsoc-text2 shrink-0">{k}</span>
      <span className="text-fsoc-text1 text-right">{v}</span>
    </div>
  );
}
