'use client';

/**
 * Scenario library + builder (docs/Frontend-Design §17). The 14 PS-169
 * presets each show seed / duration / disturbance profile / difficulty.
 * Selecting a preset arms it in Mission Control.
 */
import { useMemo, useState } from 'react';
import { Check, Play, Search, Star } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useFsoc } from '@/lib/store';
import { SCENARIO_PRESETS, type Difficulty } from '@/engine/scenarios';
import { atmosphereLabel, motionLabel } from '@/engine/config';
import { cn } from '@/lib/utils';

const DIFF_COLOR: Record<Difficulty, string> = {
  low: 'var(--success)',
  medium: 'var(--accent-blue)',
  high: 'var(--warning)',
  extreme: 'var(--danger)',
};

export function ScenariosView() {
  const setConfig = useFsoc((s) => s.setConfig);
  const setView = useFsoc((s) => s.setView);
  const startRun = useFsoc((s) => s.startRun);
  const current = useFsoc((s) => s.config);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string>(current.scenarioName);

  const filtered = useMemo(
    () => SCENARIO_PRESETS.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()) || p.description.toLowerCase().includes(query.toLowerCase())),
    [query],
  );

  const armScenario = (id: string) => {
    const preset = SCENARIO_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setConfig(structuredClone(preset.config));
    setSelected(preset.name);
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-[16px] font-semibold tracking-[0.14em] text-fsoc-text0">SCENARIO LIBRARY</h2>
            <p className="text-[11px] text-fsoc-text2 mt-0.5">
              Fourteen PS-169 benchmark presets spanning the four required motions and the full disturbance suite.
            </p>
          </div>
          <div className="relative w-64">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fsoc-text3" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search scenarios…" className="h-8 pl-8 bg-fsoc-bg1 border-fsoc-border1 text-[12px]" />
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-2.5">
          {filtered.map((p) => {
            const isCurrent = current.scenarioName === p.name;
            const isSelected = selected === p.name;
            const c = p.config;
            const disturbs: string[] = [];
            if (c.noise.gaussianSigma > 0) disturbs.push(`Gauss σ${c.noise.gaussianSigma}`);
            if (c.noise.saltPepperPercent > 0) disturbs.push(`S&P ${c.noise.saltPepperPercent}%`);
            if (c.noise.poissonEnabled) disturbs.push('Poisson');
            if (c.jitter.enabled) disturbs.push(`Jitter ±${c.jitter.maxPxPerFrame}px`);
            if (c.atmosphere.mode !== 'clear') disturbs.push(atmosphereLabel(c.atmosphere.mode));
            if (c.platformMotion.mode !== 'none') disturbs.push(`Platform ${c.platformMotion.mode}`);
            if (disturbs.length === 0) disturbs.push('Clear');
            return (
              <div
                key={p.id}
                className={cn(
                  'panel px-4 py-3.5 cursor-pointer transition-colors hover:border-fsoc-border2',
                  isCurrent && 'border-fsoc-cyan/50',
                )}
                onClick={() => armScenario(p.id)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Star className={`w-3.5 h-3.5 ${isSelected ? 'text-fsoc-cyan fill-fsoc-cyan' : 'text-fsoc-text3'}`} />
                    <span className="text-[12px] font-medium text-fsoc-text0">{p.name}</span>
                  </div>
                  <span className="text-[9px] tracking-wider uppercase px-1.5 py-0.5 rounded" style={{ color: DIFF_COLOR[p.difficulty], border: `1px solid ${DIFF_COLOR[p.difficulty]}55` }}>
                    {p.difficulty}
                  </span>
                </div>
                <p className="text-[10.5px] text-fsoc-text2 mt-1.5 leading-relaxed">{p.description}</p>
                <div className="flex flex-wrap gap-1.5 mt-2.5">
                  <Tag>seed {c.seed}</Tag>
                  <Tag>{c.durationS}s</Tag>
                  <Tag>{motionLabel(c.beacon.motion)}</Tag>
                  {disturbs.map((drb) => (
                    <Tag key={drb} warn={drb !== 'Clear'}>{drb}</Tag>
                  ))}
                </div>
                <div className="flex items-center gap-2 mt-3">
                  <button
                    className="h-7 px-3 rounded-md bg-fsoc-bg3 border border-fsoc-border2 text-[10px] tracking-[0.1em] text-fsoc-text1 hover:border-fsoc-cyan/50 hover:text-fsoc-cyan transition-colors inline-flex items-center gap-1.5"
                    onClick={(e) => {
                      e.stopPropagation();
                      armScenario(p.id);
                      setView('laboratory');
                    }}
                  >
                    <Check className="w-3 h-3" /> ARM IN MISSION CONTROL
                  </button>
                  <button
                    className="h-7 px-3 rounded-md text-[10px] tracking-[0.1em] text-white bg-fsoc-cyan hover:bg-fsoc-cyan/85 transition-colors inline-flex items-center gap-1.5 disabled:opacity-40"
                    onClick={(e) => {
                      e.stopPropagation();
                      armScenario(p.id);
                      setView('laboratory');
                      setTimeout(() => startRun(), 350);
                    }}
                  >
                    <Play className="w-3 h-3" /> RUN NOW
                  </button>
                  {isCurrent && <span className="text-[9px] text-fsoc-cyan tracking-wider ml-1">ARMED</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Tag({ children, warn }: { children: React.ReactNode; warn?: boolean }) {
  return (
    <span
      className={cn(
        'text-[9px] tnum px-1.5 py-0.5 rounded border',
        warn ? 'border-fsoc-warning/40 text-fsoc-warning' : 'border-fsoc-border2 text-fsoc-text2',
      )}
    >
      {children}
    </span>
  );
}
