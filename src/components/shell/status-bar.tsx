'use client';

/**
 * Bottom status bar — keyboard shortcut hints + registry status
 * (docs/Frontend-Design §29 keyboard shortcuts).
 */
import { useFsoc } from '@/lib/store';

export function StatusBar() {
  const phase = useFsoc((s) => s.phase);
  const telemetry = useFsoc((s) => s.telemetry);

  return (
    <footer className="h-7 shrink-0 border-t border-fsoc-border1 bg-fsoc-bg1 flex items-center px-4 gap-4 text-[10px] text-fsoc-text3">
      <span className="tracking-[0.12em] uppercase">FSOC-PAT v1.0.0</span>
      <span className="text-fsoc-border2">|</span>
      <span className="hidden md:inline tracking-wide">
        <kbd className="px-1 rounded border border-fsoc-border1 text-fsoc-text2">Space</kbd> start/pause
        <kbd className="px-1 ml-2 rounded border border-fsoc-border1 text-fsoc-text2">Esc</kbd> stop
        <kbd className="px-1 ml-2 rounded border border-fsoc-border1 text-fsoc-text2">G</kbd> ground truth
        <kbd className="px-1 ml-2 rounded border border-fsoc-border1 text-fsoc-text2">L</kbd> logs
      </span>
      <div className="flex-1" />
      <span className="tnum tracking-wide">
        {telemetry ? `frame ${telemetry.frameIndex} · t+${telemetry.timestampS.toFixed(1)}s` : 'no active run'}
      </span>
      <span className="text-fsoc-border2 hidden sm:inline">|</span>
      <span className="hidden sm:inline tracking-[0.1em] uppercase">
        {phase === 'running' ? 'closed-loop control active' : 'idle'}
      </span>
    </footer>
  );
}
