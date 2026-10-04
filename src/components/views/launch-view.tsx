'use client';

/**
 * Launch screen (docs/Frontend-Design §25) — extremely minimal welcome with
 * a subtle live 3D frustum behind. Not a SaaS landing page.
 */
import { ArrowRight, FileVideo, LayoutGrid, Radar, BarChart3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFsoc } from '@/lib/store';
import { Scene3D } from '@/components/scene/scene-3d';

const PIPELINE = ['SCENE', 'BEACON', 'CAMERA', 'DETECTION', 'TRACKING', 'CONTROL', 'METRICS', 'PROOF'];

export function LaunchView() {
  const setView = useFsoc((s) => s.setView);
  const startRun = useFsoc((s) => s.startRun);
  const startDemo = useFsoc((s) => s.startDemo);

  return (
    <div className="flex-1 min-h-0 relative overflow-hidden">
      {/* subtle 3D backdrop */}
      <div className="absolute inset-0 opacity-50 pointer-events-none">
        <Scene3D />
      </div>
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[#fbf4eecc] to-[var(--bg-0)]" />

      <div className="relative h-full flex flex-col items-center justify-center gap-8 px-6">
        <div className="text-center max-w-2xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-fsoc-border2 bg-fsoc-bg1/80 text-[10px] tracking-[0.18em] text-fsoc-text2 mb-5">
            <span className="w-1.5 h-1.5 rounded-full bg-fsoc-cyan" />
            SIH 2026 · PROBLEM STATEMENT 169
          </div>
          <h1 className="text-[34px] font-semibold tracking-[0.22em] text-fsoc-text0">AeroLink FSOC-PAT</h1>
          <p className="mt-1 text-[13px] text-fsoc-text2 tracking-wide">Virtual Coarse Alignment Laboratory</p>
          <p className="mt-4 text-[12px] leading-relaxed text-fsoc-text3 max-w-lg mx-auto">
            Software environment for simulation, visual tracking and coarse optical alignment of
            mobile free-space optical communication terminals. Autonomous beacon detection,
            Kalman-predicted tracking and closed-loop pan/tilt control — with measured evidence.
          </p>
          <div className="mt-7 flex items-center justify-center gap-3">
            {/* §22 — the demonstration path: one button, fixed seed, no setup */}
            <Button
              size="lg"
              className="h-11 px-6 bg-fsoc-cyan text-white hover:bg-fsoc-cyan/85 font-semibold tracking-[0.1em] gap-2"
              onClick={() => startDemo()}
              title="Deterministic end-to-end demonstration: search → detect → lock → disturbance → signal loss → reacquisition → report"
            >
              RUN JUDGE DEMONSTRATION
              <ArrowRight className="w-4 h-4" />
            </Button>
            <Button
              variant="secondary"
              size="lg"
              className="h-11 px-5 tracking-[0.1em]"
              onClick={() => {
                setView('laboratory');
                setTimeout(() => startRun(), 350);
              }}
            >
              LAUNCH LABORATORY
            </Button>
            <Button
              variant="secondary"
              size="lg"
              className="h-11 px-5 tracking-[0.1em]"
              onClick={() => setView('benchmark')}
            >
              LOAD MP4 BENCHMARK
            </Button>
          </div>
        </div>

        {/* pipeline loop */}
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 max-w-3xl">
          {PIPELINE.map((step, i) => (
            <div key={step} className="flex items-center gap-3">
              <span className="text-[9px] tracking-[0.22em] text-fsoc-text3">{step}</span>
              {i < PIPELINE.length - 1 && <span className="text-fsoc-border2 text-[9px]">↓</span>}
            </div>
          ))}
        </div>

        {/* quick destinations */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 w-full max-w-3xl">
          <QuickCard icon={Radar} title="Simulation" desc="Closed-loop virtual camera tracking" onClick={() => setView('laboratory')} />
          <QuickCard icon={FileVideo} title="Video Benchmark" desc="30-FPS MP4 · perception-only mode" onClick={() => setView('benchmark')} />
          <QuickCard icon={LayoutGrid} title="Scenarios" desc="14 PS-169 presets + builder" onClick={() => setView('scenarios')} />
          <QuickCard icon={BarChart3} title="Results" desc="Metrics, PS-169 gates, exports" onClick={() => setView('analytics')} />
        </div>
      </div>
    </div>
  );
}

function QuickCard({
  icon: Icon,
  title,
  desc,
  onClick,
}: {
  icon: typeof Radar;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="panel px-4 py-3.5 text-left hover:border-fsoc-border2 hover:bg-fsoc-bg2 transition-colors group"
    >
      <Icon className="w-4 h-4 text-fsoc-text2 group-hover:text-fsoc-cyan transition-colors" strokeWidth={1.6} />
      <div className="mt-2.5 text-[12px] font-medium text-fsoc-text0">{title}</div>
      <div className="text-[10px] text-fsoc-text3 mt-0.5 leading-relaxed">{desc}</div>
    </button>
  );
}
