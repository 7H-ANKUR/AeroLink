'use client';

/**
 * Mission Control / Live Run dashboard (docs/Frontend-Design §7) —
 * three-column operations layout: left control panel, primary workspace
 * (camera viewport / 3D scene / split), right telemetry panel; charts
 * strip + event log at the bottom.
 */
import { useState } from 'react';
import { Box, Grid2X2, ScanLine } from 'lucide-react';
import { ControlPanels } from '@/components/controls/control-panels';
import { TelemetryPanel } from '@/components/telemetry/telemetry-panel';
import { CameraViewport } from '@/components/camera/camera-viewport';
import { Scene3D } from '@/components/scene/scene-3d';
import { ControlChart, ErrorChart, LockTimeline, TrajectoryChart } from '@/components/charts/charts';
import { EventLog } from '@/components/logs/event-log';
import { useFsoc } from '@/lib/store';

type WorkspaceMode = 'camera' | '3d' | 'split';

export function LaboratoryView() {
  const [mode, setMode] = useState<WorkspaceMode>('camera');
  const [showCharts, setShowCharts] = useState(true);
  const config = useFsoc((s) => s.config);
  const phase = useFsoc((s) => s.phase);
  const idle = phase === 'idle' || phase === 'complete';

  return (
    <div className="flex-1 min-h-0 grid grid-cols-[272px_minmax(0,1fr)_304px] gap-2.5 p-2.5 max-[1100px]:grid-cols-[240px_minmax(0,1fr)] max-[1100px]:[&>*:nth-child(3)]:hidden">
      {/* LEFT — run configuration */}
      <aside className="min-h-0 flex flex-col" aria-label="Run configuration">
        <ControlPanels />
      </aside>

      {/* CENTER — workspace */}
      <main className="min-h-0 flex flex-col gap-2.5 overflow-y-auto">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1 panel px-1 py-1">
            <WorkspaceTab active={mode === 'camera'} onClick={() => setMode('camera')} icon={ScanLine} label="CAM-01" />
            <WorkspaceTab active={mode === '3d'} onClick={() => setMode('3d')} icon={Box} label="3D SCENE" />
            <WorkspaceTab active={mode === 'split'} onClick={() => setMode('split')} icon={Grid2X2} label="SPLIT" />
          </div>
          <button
            onClick={() => setShowCharts((v) => !v)}
            className="text-[10px] tracking-[0.12em] text-fsoc-text3 hover:text-fsoc-text1 px-2 py-1 rounded border border-fsoc-border1 transition-colors"
          >
            {showCharts ? 'HIDE CHARTS' : 'SHOW CHARTS'}
          </button>
        </div>

        <div className="min-h-[280px] flex-[3] basis-40">
          {mode === 'camera' && <CameraViewport />}
          {mode === '3d' && <Scene3D />}
          {mode === 'split' && (
            <div className="grid grid-rows-2 gap-2.5 h-full min-h-0">
              <CameraViewport />
              <Scene3D />
            </div>
          )}
        </div>

        {showCharts && (
          <div className="h-[148px] grid grid-cols-2 xl:grid-cols-4 gap-2.5 shrink-0 max-[1100px]:grid-cols-2">
            <ErrorChart />
            <TrajectoryChart />
            <ControlChart />
            <LockTimeline />
          </div>
        )}

        <div className="h-[136px] shrink-0">
          <EventLog />
        </div>

        <p className="text-[9px] text-fsoc-text3 shrink-0">
          Seed {config.seed} · {config.camera.updateHz} Hz loop · detector threshold {config.tracking.threshold} ·
          Kalman Q {config.tracking.kalmanQ}/R {config.tracking.kalmanR} · PID Kp {config.tracking.kp} Ki {config.tracking.ki} Kd {config.tracking.kd}
          {idle && ' · configure a scenario on the left, then Start Run'}
        </p>
      </main>

      {/* RIGHT — telemetry */}
      <aside className="min-h-0" aria-label="Tracking telemetry">
        <TelemetryPanel />
      </aside>
    </div>
  );
}

function WorkspaceTab({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Box;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[10px] tracking-[0.12em] transition-colors ${
        active ? 'bg-fsoc-bg3 text-fsoc-cyan' : 'text-fsoc-text3 hover:text-fsoc-text1'
      }`}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  );
}
