'use client';

/**
 * FSOC-PAT application shell — single-window console (docs/03 §1).
 * Top system bar + narrow command rail + view router + status bar.
 * Keyboard shortcuts per docs/Frontend-Design §29.
 */
import { useEffect } from 'react';
import { TopBar } from '@/components/shell/top-bar';
import { CommandRail } from '@/components/shell/command-rail';
import { StatusBar } from '@/components/shell/status-bar';
import { LaunchView } from '@/components/views/launch-view';
import { LaboratoryView } from '@/components/views/laboratory-view';
import { ScenariosView } from '@/components/views/scenarios-view';
import { BenchmarkView } from '@/components/views/benchmark-view';
import { AnalyticsView } from '@/components/views/analytics-view';
import { ReplayView } from '@/components/views/replay-view';
import { ComparisonView } from '@/components/views/comparison-view';
import { SettingsView } from '@/components/views/settings-view';
import { bindEngineToStore, useFsoc } from '@/lib/store';

export default function Home() {
  const view = useFsoc((s) => s.view);
  const setView = useFsoc((s) => s.setView);

  // bind engine → store flush loop once
  useEffect(() => {
    const unbind = bindEngineToStore();
    return unbind;
  }, []);

  // keyboard shortcuts (docs/Frontend-Design §29)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      const st = useFsoc.getState();
      switch (e.key) {
        case ' ':
          e.preventDefault();
          if (st.phase === 'running' || st.phase === 'paused') st.pauseRun();
          else if (st.phase === 'idle' || st.phase === 'complete') st.startRun();
          break;
        case 'Escape':
          if (st.phase === 'running' || st.phase === 'paused' || st.phase === 'initializing') st.stopRun();
          break;
        case '1':
          st.setView('laboratory');
          break;
        case '2':
          st.setView('scenarios');
          break;
        case '3':
          st.setView('analytics');
          break;
        case 'g':
        case 'G': {
          const c = structuredClone(st.config);
          c.debugOverlay.groundTruth = !c.debugOverlay.groundTruth;
          st.setConfig(c);
          break;
        }
        case 'k':
        case 'K':
          st.killBeacon();
          break;
        case 'l':
        case 'L':
          // focus event log — it is always visible in Mission Control
          st.setView('laboratory');
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="h-screen flex flex-col bg-fsoc-bg0 overflow-hidden">
      <TopBar />
      <div className="flex-1 min-h-0 flex">
        {view !== 'launch' && <CommandRail />}
        {view === 'launch' && <LaunchView />}
        {view === 'laboratory' && <LaboratoryView />}
        {view === 'scenarios' && <ScenariosView />}
        {view === 'benchmark' && <BenchmarkView />}
        {view === 'analytics' && <AnalyticsView />}
        {view === 'replay' && <ReplayView />}
        {view === 'comparison' && <ComparisonView />}
        {view === 'settings' && <SettingsView />}
      </div>
      <StatusBar />
    </div>
  );
}
