'use client';

/**
 * Top system bar (docs/Frontend-Design §5.1).
 * Left: identity + reticle mark. Center: live run status.
 * Right: system-level status + primary run controls.
 */
import { Crosshair, Pause, Play, Settings2, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFsoc } from '@/lib/store';
import { STATE_COLORS } from './state-colors';

export function TopBar() {
  const phase = useFsoc((s) => s.phase);
  const telemetry = useFsoc((s) => s.telemetry);
  const runNumber = useFsoc((s) => s.runNumber);
  const startRun = useFsoc((s) => s.startRun);
  const pauseRun = useFsoc((s) => s.pauseRun);
  const stopRun = useFsoc((s) => s.stopRun);
  const setView = useFsoc((s) => s.setView);
  const config = useFsoc((s) => s.config);
  const validationOk = useFsoc((s) => s.configErrors.length === 0);

  const running = phase === 'running' || phase === 'initializing' || phase === 'paused';
  const stateName = telemetry?.track.state ?? 'SEARCH';
  const stateColor = running ? STATE_COLORS[stateName] : 'var(--text-3)';
  const runLabel = String(runNumber + 1).padStart(4, '0');

  return (
    <header className="h-14 shrink-0 border-b border-fsoc-border1 bg-fsoc-bg1 flex items-center px-4 gap-4">
      {/* Left — identity */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-8 h-8 rounded-md border border-fsoc-border2 bg-fsoc-bg2 flex items-center justify-center shrink-0">
          <Crosshair className="w-4 h-4 text-fsoc-cyan" strokeWidth={1.5} />
        </div>
        <div className="leading-tight min-w-0">
          <div className="text-[13px] font-semibold tracking-[0.18em] text-fsoc-text0">FSOC-PAT</div>
          <div className="text-[10px] text-fsoc-text2 tracking-wide truncate">
            Virtual Coarse Alignment Laboratory
          </div>
        </div>
      </div>

      {/* Center — live run status */}
      <div className="flex-1 flex justify-center">
        <div className="flex items-center gap-3 px-4 py-1.5 rounded-md border border-fsoc-border1 bg-fsoc-bg0">
          <span className="text-[10px] tracking-[0.16em] text-fsoc-text2 font-medium">
            {config.scenarioName.toUpperCase().slice(0, 28)}
          </span>
          <span className="w-px h-4 bg-fsoc-border2" />
          <span
            className={`flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.14em] ${running ? 'status-live' : ''}`}
            style={{ color: stateColor }}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: stateColor }} />
            {phase === 'running' ? 'RUNNING' : phase === 'paused' ? 'PAUSED' : phase === 'complete' ? 'RUN COMPLETE' : phase === 'initializing' ? 'INITIALIZING' : 'STANDBY'}
          </span>
          <span className="w-px h-4 bg-fsoc-border2" />
          <span className="text-[11px] text-fsoc-text1 tnum">RUN {runLabel}</span>
        </div>
      </div>

      {/* Right — system status + controls */}
      <div className="flex items-center gap-2">
        <div className="hidden lg:flex items-center gap-3 mr-2 tnum text-[11px] text-fsoc-text2">
          <span>
            FPS <span className="text-fsoc-text1">{telemetry ? telemetry.metrics.fpsWallClock.toFixed(1) : '—'}</span>
          </span>
          <span>
            PROC <span className="text-fsoc-text1">{telemetry ? telemetry.processingMs.toFixed(1) : '—'}</span> ms
          </span>
          <span>
            F <span className="text-fsoc-text1">{telemetry ? telemetry.frameIndex : '—'}</span>
          </span>
        </div>
        {running ? (
          <>
            <Button
              variant="secondary"
              size="sm"
              className="h-8 gap-1.5"
              onClick={pauseRun}
              title={phase === 'paused' ? 'Resume (Space)' : 'Pause (Space)'}
            >
              <Play className="w-3.5 h-3.5" />
              {phase === 'paused' ? 'Resume' : 'Pause'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="h-8 gap-1.5 text-fsoc-danger hover:text-fsoc-danger"
              onClick={stopRun}
              title="Stop run (Esc)"
            >
              <Square className="w-3.5 h-3.5" />
              Stop
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            className="h-8 gap-1.5 bg-fsoc-cyan text-[#06272c] hover:bg-fsoc-cyan/85 font-semibold"
            onClick={startRun}
            disabled={!validationOk}
            title="Start run (Space)"
          >
            <Play className="w-3.5 h-3.5" />
            Start Run
          </Button>
        )}
        <Button variant="ghost" size="icon" className="h-8 w-8 text-fsoc-text2" onClick={() => setView('settings')} title="Settings">
          <Settings2 className="w-4 h-4" />
        </Button>
      </div>
    </header>
  );
}
