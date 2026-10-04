/// <reference types="bun-types" />
/**
 * FSOC-PAT integration/e2e tests (master prompt §29 — integration + e2e layer).
 *
 * 1. Closed-loop mini-run: beacon → scene render → virtual camera crop →
 *    detector → Kalman → state machine → PID → camera pose update → metrics.
 *    Verifies TRACK is reached, gates pass, and the camera MOVED because the
 *    controller commanded it (§17 closed-loop validation).
 * 2. Determinism: two identical seeded runs produce identical metric values.
 * 3. Loss → prediction → reacquisition cycle.
 *
 * Run: bun test tests/
 */
import { describe, test, expect } from 'bun:test';
import { DEFAULT_CONFIG, validateConfig, type ScenarioConfig } from '../src/engine/config';
import { cameraCenterPx } from '../src/engine/camera';
import { SimulationRunner } from '../src/engine/simulation';

interface RigHooks {
  onTransition?: (from: string, to: string, fi: number) => void;
  onReacquired?: (t: number) => void;
  onLossConfirmed?: (t: number, fi: number) => void;
}

/**
 * Test rig over the SHIPPED loop. buildRig drives SimulationRunner — the same
 * class the Web Worker and the benchmark drive — so these assertions cover the
 * disturbance chain, jitter clamping and integrator-reset behaviour that the
 * app actually runs, not a simplified copy of it.
 */
function buildRig(config: ScenarioConfig, hooks: RigHooks = {}) {
  const reacqTimes: number[] = [];
  const lossTimes: number[] = [];
  const transitions: string[] = [];

  const sim = new SimulationRunner(config, {
    onTransition(from, to, fi) {
      transitions.push(`${from}->${to}@${fi}`);
      hooks.onTransition?.(from, to, fi);
    },
    onLossConfirmed(t, fi) {
      lossTimes.push(t);
      hooks.onLossConfirmed?.(t, fi);
    },
    onReacquired(t) {
      reacqTimes.push(t);
      hooks.onReacquired?.(t);
    },
  });

  function runFrames(seconds: number, opts: { killBeaconAfterS?: number; restoreAfterS?: number } = {}) {
    const dt = 1 / config.camera.updateHz;
    const panTiltHistory: { t: number; pan: number; tilt: number }[] = [];
    for (let fi = 1; fi <= seconds * config.camera.updateHz; fi++) {
      const t = sim.simTimeS + dt;
      const kill =
        opts.killBeaconAfterS !== undefined &&
        t >= opts.killBeaconAfterS &&
        (opts.restoreAfterS === undefined || t < opts.restoreAfterS);
      sim.setBeaconKilled(kill);
      sim.step(dt);
      panTiltHistory.push({ t: sim.simTimeS, pan: sim.camera.pan_deg, tilt: sim.camera.tilt_deg });
    }
    return { panTiltHistory, camera: sim.camera };
  }

  return {
    pipeline: sim.pipeline,
    runFrames,
    transitions,
    reacqTimes,
    lossTimes,
    camera: sim.camera,
    config,
    trajectory: sim.trajectory,
  };
}

describe('Closed-loop integration (§17, §33 A–R)', () => {
  test('static-off-center beacon: camera searches, acquires, error → ~0, TRACK reached', () => {
    const base = structuredClone(DEFAULT_CONFIG);
    const cfgRes = validateConfig({
      ...base,
      scenarioName: 'TEST closed-loop static',
      seed: 42,
      durationS: 30,
      beacon: { ...base.beacon, motion: 'straight', speed: 0.1, startX: 1300, startY: 1250 },
    });
    expect(cfgRes.ok).toBe(true);
    if (!cfgRes.ok) return;
    const rig = buildRig(cfgRes.config);
    // Beacon at (1300,1250), camera starts at scene center (1000,1000):
    // beacon is ~343 px away in scene coords — OUTSIDE the 640×480 FOV.
    rig.runFrames(30);
    const r = rig.pipeline.getMetrics().finalize('test-closed-loop');
    expect(r.acquisition_time_s).not.toBeNull();
    expect(r.acquisition_time_s as number).toBeLessThanOrEqual(2.0);
    // PS gate: avg tracking error ≤ 10 px. The mean legitimately includes the
    // slew transient (beacon starts out of FOV — the camera must fly to it).
    expect(r.avg_error_px).not.toBeNull();
    expect(r.avg_error_px as number).toBeLessThanOrEqual(10);
    // Loss policy (docs/08 §1): frames in SEARCH count as lost. The beacon
    // starts OUT of FOV, so pre-acquisition SEARCH frames honestly count —
    // loss must be > 0 (metric honesty) yet under the 5% PS gate.
    expect(r.target_loss_percent).toBeGreaterThan(0);
    expect(r.target_loss_percent).toBeLessThan(5);
    expect(r.pass_fail).not.toBeNull();
    expect(Object.values(r.pass_fail!).every(Boolean)).toBe(true);
    // The camera MUST have moved to bring the beacon into view:
    const last = rig.camera;
    const movedDeg = Math.abs(last.pan_deg) + Math.abs(last.tilt_deg);
    expect(movedDeg).toBeGreaterThan(1.0); // (1300-1000)/160 + (1250-1000)/160 ≈ 3.4°
    // CLOSED-LOOP CONVERGENCE: at the end the viewport center must sit on the
    // beacon (error ≈ 0). The beacon was NEVER moved by the controller — only
    // the camera pose changed (§17: no teleporting the beacon to center).
    const endT = 30;
    const gtEnd = rig.trajectory.at(endT);
    const camEnd = cameraCenterPx(last);
    const finalOffset = Math.hypot(gtEnd.x - camEnd.cx, gtEnd.y - camEnd.cy);
    expect(finalOffset).toBeLessThan(10); // inside the 10 px lock radius
  });

  test('system-level determinism: same seed twice → identical metrics', () => {
    const mk = () => {
      const base = structuredClone(DEFAULT_CONFIG);
      const cfgRes = validateConfig({ ...base, scenarioName: 'TEST determinism', seed: 1234, durationS: 8 });
      if (!cfgRes.ok) throw new Error('config');
      const rig = buildRig(cfgRes.config);
      rig.runFrames(8);
      return rig.pipeline.getMetrics().finalize('det');
    };
    const a = mk();
    const b = mk();
    expect(a.acquisition_time_s).toBe(b.acquisition_time_s);
    expect(a.avg_error_px).toBe(b.avg_error_px);
    expect(a.rmse_px).toBe(b.rmse_px);
    expect(a.target_loss_percent).toBe(b.target_loss_percent);
    expect(a.frames_processed).toBe(b.frames_processed);
  });

  test('loss → PREDICT_REACQUIRE → reacquisition → TRACK (§18)', () => {
    const base = structuredClone(DEFAULT_CONFIG);
    const cfgRes = validateConfig({
      ...base,
      scenarioName: 'TEST loss-reacquire',
      seed: 77,
      durationS: 20,
      beacon: { ...base.beacon, motion: 'straight', speed: 0.6, startX: 1000, startY: 1000 },
    });
    expect(cfgRes.ok).toBe(true);
    if (!cfgRes.ok) return;
    const rig = buildRig(cfgRes.config);
    rig.runFrames(20, { killBeaconAfterS: 10, restoreAfterS: 10.5 }); // 0.5 s outage
    const r = rig.pipeline.getMetrics().finalize('test-reacq');
    expect(rig.lossTimes.length).toBeGreaterThanOrEqual(1);
    expect(rig.reacqTimes.length).toBeGreaterThanOrEqual(1);
    // reacquisition must be well under the 1 s PS gate for a 0.5 s outage
    expect(r.reacquisition_avg_s).not.toBeNull();
    expect(r.reacquisition_avg_s as number).toBeLessThanOrEqual(1.0);
    expect(r.reacquisition_avg_s as number).toBeGreaterThanOrEqual(0.45); // beacon physically absent 0.5 s
    expect(r.pass_fail!.reacquisition).toBe(true);
  });

  test('state machine: single noisy frame does NOT jump straight to TRACK (§14)', () => {
    const base = structuredClone(DEFAULT_CONFIG);
    const cfgRes = validateConfig({
      ...base, scenarioName: 'TEST sm', seed: 5, durationS: 6,
      beacon: { ...base.beacon, motion: 'straight', speed: 0.2, startX: 1100, startY: 1050 },
    });
    if (!cfgRes.ok) throw new Error('config');
    const rig = buildRig(cfgRes.config);
    rig.runFrames(6);
    // First transition must be SEARCH->CANDIDATE (or SEARCH->TRACKING family),
    // never SEARCH->TRACK directly: confirmation frames gate ACQUIRE.
    const first = rig.transitions[0] ?? '';
    expect(first.startsWith('SEARCH->')).toBe(true);
    expect(first).not.toBe('SEARCH->TRACK');
    expect(rig.transitions.some((tr) => tr.includes('TRACK'))).toBe(true);
  });
});
