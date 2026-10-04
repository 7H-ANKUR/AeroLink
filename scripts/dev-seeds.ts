/**
 * Development-seed harness (seeds 9100 + 37k) — DISJOINT from the evaluation
 * seeds in scripts/eval-detectors.ts (4200 + 101k).
 *
 * Every post-first-pass change to the hybrid decision engine (docs/AI-DETECTOR.md
 * §6) was diagnosed and checked here, so the reported evaluation was never
 * used for tuning. Reports per-seed correct-lock % and correct-acquisition
 * time; pass a single seed as the third argument for a 3 Hz frame trace.
 *
 * Usage: bun scripts/dev-seeds.ts [cond,cond] [cv_classical,fusion] [traceSeed]
 */
import { DEFAULT_CONFIG, type ScenarioConfig } from '../src/engine/config';
import { SimulationRunner } from '../src/engine/simulation';
import { tryLoadModel } from './lib/load-model';
const model = tryLoadModel();
const DECOYS = (c: ScenarioConfig): ScenarioConfig => ({ ...c, scene: { ...c.scene, distractorCount: 10, distractorIntensityMin: 0.62, distractorIntensityMax: 0.95 } });
const C: Record<string, (c: ScenarioConfig) => ScenarioConfig> = {
  clear: (c) => c,
  rain: (c) => ({ ...c, atmosphere: { ...c.atmosphere, mode: 'rain' } }),
  noise: (c) => ({ ...c, noise: { saltPepperPercent: 2.0, gaussianSigma: 18, poissonEnabled: true } }),
  blink: (c) => ({ ...c, beacon: { ...c.beacon, blinkPeriodS: 4 } }),
  decoys: DECOYS,
  decoys_noise: (c) => ({ ...DECOYS(c), noise: { saltPepperPercent: 1.2, gaussianSigma: 14, poissonEnabled: true } }),
  decoys_jitter: (c) => ({ ...DECOYS(c), jitter: { enabled: true, maxPxPerFrame: 14 } }),
  dim: (c) => ({ ...c, beacon: { ...c.beacon, intensity: 0.35 } }),
};
const conds = (process.argv[2] ?? Object.keys(C).join(',')).split(',');
const dets = (process.argv[3] ?? 'cv_classical,fusion').split(',') as any[];
const trace = process.argv[4] ? Number(process.argv[4]) : null;
const seeds = trace !== null ? [trace] : Array.from({ length: 6 }, (_, i) => 9100 + i * 37);
for (const cn of conds) {
  for (const d of dets) {
    const out: string[] = [];
    let totLock = 0;
    for (const seed of seeds) {
      const cfg = C[cn]({ ...DEFAULT_CONFIG, seed, durationS: 25, tracking: { ...DEFAULT_CONFIG.tracking, detector: d } });
      const sim = new SimulationRunner(cfg, {}, model);
      const W = 640, H = 480;
      let vis = 0, ok = 0, acq: number | null = null;
      for (let i = 0; i < 750; i++) {
        const st = sim.step(1 / 30);
        const p = st.pipeline;
        const gx = st.beacon.x_px - (st.cropCenter.x - W / 2), gy = st.beacon.y_px - (st.cropCenter.y - H / 2);
        const visible = st.beacon.visible && !st.blinkOff && gx >= 0 && gy >= 0 && gx < W && gy < H;
        const on = (p.track.state === 'TRACK' || p.track.state === 'PREDICT_REACQUIRE') && p.errorPx !== null && p.errorPx <= 10;
        if (on && acq === null) acq = st.timestampS;
        if (visible) { vis++; if (on) ok++; }
        if (trace !== null && i % 10 === 0) {
          const pv = p.detection.provenance;
          console.log(`f${i} ${p.track.state.padEnd(17)} err=${p.errorPx?.toFixed(0)} vis=${visible} det=${p.detection.found ? `(${p.detection.x!.toFixed(0)},${p.detection.y!.toFixed(0)})` : 'none'} gt=(${gx.toFixed(0)},${gy.toFixed(0)}) trk#${pv?.trackId} age=${pv?.trackAgeFrames} p=${pv?.trackP?.toFixed(2)} v=${pv?.trackSpeedPxS?.toFixed(0)} src=${pv?.chosenSource} by=${pv?.chosenBy} rej=${pv?.trackRejected}/${pv?.aiRejected} cl=${pv?.clutterPoints} n=${pv?.candidateCount}+${pv?.aiBranchCount}`);
        }
      }
      const pct = vis ? (100 * ok) / vis : 0;
      totLock += pct;
      out.push(`${seed}:${pct.toFixed(0)}%/${acq?.toFixed(1) ?? '-'}s`);
    }
    console.log(`${cn.padEnd(14)} ${d.padEnd(13)} mean-correct-lock ${(totLock / seeds.length).toFixed(1)}%  ${out.join(' ')}`);
  }
}
