'use client';

/**
 * Narrow operational command rail (docs/Frontend-Design §6) — 64px icon
 * navigation with tooltips. Tooltips explain each destination.
 */
import { Radar, LayoutGrid, Crosshair, BarChart3, History, Scale, Settings, FileVideo } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useFsoc, type ViewId } from '@/lib/store';

const ITEMS: { id: ViewId; icon: typeof Radar; label: string; tip: string }[] = [
  { id: 'laboratory', icon: Radar, label: 'Mission', tip: 'Mission Control — live run dashboard' },
  { id: 'scenarios', icon: LayoutGrid, label: 'Scenarios', tip: 'Scenario library & builder' },
  { id: 'benchmark', icon: FileVideo, label: 'Benchmark', tip: 'MP4 video benchmark mode (perception-only)' },
  { id: 'analytics', icon: BarChart3, label: 'Analytics', tip: 'Run results & PS-169 compliance' },
  { id: 'replay', icon: History, label: 'Replay', tip: 'Replay a completed run' },
  { id: 'comparison', icon: Scale, label: 'Compare', tip: 'Run-to-run comparison' },
  { id: 'settings', icon: Settings, label: 'Settings', tip: 'Application settings' },
];

export function CommandRail() {
  const view = useFsoc((s) => s.view);
  const setView = useFsoc((s) => s.setView);
  const phase = useFsoc((s) => s.phase);
  const running = phase === 'running' || phase === 'initializing';

  return (
    <TooltipProvider delayDuration={200}>
      <nav
        aria-label="Primary"
        className="w-16 shrink-0 border-r border-fsoc-border1 bg-fsoc-bg1 flex flex-col items-center py-3 gap-1"
      >
        {ITEMS.map((item) => {
          const Icon = item.icon;
          const active = view === item.id;
          return (
            <Tooltip key={item.id}>
              <TooltipTrigger asChild>
                <button
                  aria-label={item.label}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setView(item.id)}
                  className={`relative w-11 h-11 rounded-lg flex items-center justify-center transition-colors duration-150 ${
                    active
                      ? 'bg-fsoc-bg3 text-fsoc-cyan'
                      : 'text-fsoc-text2 hover:bg-fsoc-bg2 hover:text-fsoc-text1'
                  }`}
                >
                  {active && (
                    <span className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-3 w-[3px] h-6 rounded-full bg-fsoc-cyan" />
                  )}
                  <Icon className="w-[18px] h-[18px]" strokeWidth={1.6} />
                  {item.id === 'laboratory' && running && (
                    <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-fsoc-success status-live" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" className="bg-fsoc-bg2 border-fsoc-border2 text-fsoc-text1 text-xs">
                {item.tip}
              </TooltipContent>
            </Tooltip>
          );
        })}
        <div className="flex-1" />
        <div className="text-[8px] tracking-[0.2em] text-fsoc-text3 font-mono [writing-mode:vertical-lr] rotate-180 select-none">
          PS-169
        </div>
      </nav>
    </TooltipProvider>
  );
}
