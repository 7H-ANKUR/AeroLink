/// <reference types="bun-types" />
/**
 * FSOC-PAT anti-cheating validation (master prompt §39).
 *
 * These thirteen assertions exist to answer the question a judge is entitled
 * to ask: "how do I know the camera is really tracking, rather than you moving
 * the beacon to the centre and printing nice numbers?"
 *
 * Each test attacks one way the demonstration could be faked. They are written
 * to FAIL LOUDLY if someone later wires ground truth into the perception or
 * control path, teleports the beacon, or decouples the camera from the mount.
 *
 * Run: bun test tests/
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG, validateConfig, type ScenarioConfig } from '../src/engine/config';
import { SimulationRunner } from '../src/engine/simulation';

const SRC = join(import.meta.dir, '..', 'src', 'engine');

function cfg(over: Partial<ScenarioConfig> = {}, beacon: Partial<ScenarioConfig['beacon']> = {}): ScenarioConfig {
  const base = structuredClone(DEFAULT_CONFIG);
  const r = validateConfig({
    ...base,
    seed: 42,
    durationS: 30,
    ...over,
    beacon: { ...base.beacon, ...beacon },
  });
  if (!r.ok) throw new Error('bad test config: ' + JSON.stringify(r.errors));
  return r.config;
}

/** Ground-truth identifiers that must never appear in a perception/control module. */
const GT_TOKENS = /ground_truth|groundTruth|GroundTruthTarget|gt_x|gt_y|gtTuple/;

describe('§39 anti-cheating validation', () => {
  // ── 1. beacon trajectory is independent of camera pose ──────────────────
  test('1. beacon trajectory is identical with and without the controller', () => {
    // Same seed, same trajectory object: sample the reference path directly.
    const withCtl = new SimulationRunner(cfg());
    const withoutCtl = new SimulationRunner(
      cfg({ tracking: { ...DEFAULT_CONFIG.tracking, controllerEnabled: false } } as Partial<ScenarioConfig>),
    );

    const a: { x: number; y: number }[] = [];
    const b: { x: number; y: number }[] = [];
    withCtl.runFor(10, (s) => a.push({ x: s.beacon.x_px, y: s.beacon.y_px }));
    withoutCtl.runFor(10, (s) => b.push({ x: s.beacon.x_px, y: s.beacon.y_px }));

    expect(a.length).toBe(b.length);
    // The camera moved a lot in one case and not at all in the other; the
    // beacon path must be bit-identical regardless.
    for (let i = 0; i < a.length; i++) {
      expect(a[i].x).toBeCloseTo(b[i].x, 9);
      expect(a[i].y).toBeCloseTo(b[i].y, 9);
    }
    // ...and the rendered path must equal the analytic trajectory evaluated
    // independently at the same instant — i.e. nothing nudged the beacon
    // toward the camera (no teleporting).
    const ref = withCtl.trajectory.at(withCtl.simTimeS);
    expect(a[a.length - 1].x).toBeCloseTo(ref.x, 6);
    expect(a[a.length - 1].y).toBeCloseTo(ref.y, 6);
  });

  // ── 2/3/4. ground truth cannot reach controller, detector or tracker ────
  test('2. controller source contains no ground-truth access', () => {
    expect(GT_TOKENS.test(readFileSync(join(SRC, 'pid.ts'), 'utf8'))).toBe(false);
  });

  test('3. detector source contains no ground-truth access', () => {
    expect(GT_TOKENS.test(readFileSync(join(SRC, 'detector.ts'), 'utf8'))).toBe(false);
  });

  test('4. tracker and Kalman sources contain no ground-truth access', () => {
    expect(GT_TOKENS.test(readFileSync(join(SRC, 'tracker.ts'), 'utf8'))).toBe(false);
    expect(GT_TOKENS.test(readFileSync(join(SRC, 'kalman.ts'), 'utf8'))).toBe(false);
  });

  // ── 5. camera pose changes because of controller + mount ────────────────
  test('5. camera pose moves under control and stays put without it', () => {
    const on = new SimulationRunner(cfg({}, { motion: 'straight', speed: 0.1, startX: 1300, startY: 1250 }));
    on.runFor(20);
    const movedOn = Math.abs(on.camera.pan_deg) + Math.abs(on.camera.tilt_deg);

    const off = new SimulationRunner(
      cfg(
        { tracking: { ...DEFAULT_CONFIG.tracking, controllerEnabled: false } } as Partial<ScenarioConfig>,
        { motion: 'straight', speed: 0.1, startX: 1300, startY: 1250 },
      ),
    );
    off.runFor(20);
    const movedOff = Math.abs(off.camera.pan_deg) + Math.abs(off.camera.tilt_deg);

    expect(movedOn).toBeGreaterThan(1.0);
    expect(movedOff).toBe(0); // zero command → mount never moves
  });

  // ── 6. changing PID gains changes the actual response ───────────────────
  test('6. PID gains materially change the closed-loop response', () => {
    const run = (kp: number) => {
      const c = cfg({ tracking: { ...DEFAULT_CONFIG.tracking, kp } } as Partial<ScenarioConfig>, {
        motion: 'straight',
        speed: 0.1,
        startX: 1300,
        startY: 1250,
      });
      const sim = new SimulationRunner(c);
      // Sample during the SLEW, not after it. Gains govern the transient; by
      // steady state both settle on the same static target, so comparing the
      // endpoint discriminates nothing (measured 0.042° apart at t=12 s).
      sim.runFor(1.2);
      return sim.camera.pan_deg;
    };
    const slow = run(0.4);
    const fast = run(3.0);
    expect(Math.abs(fast - slow)).toBeGreaterThan(0.1);
  });

  // ── 7. disabling the controller prevents alignment ──────────────────────
  test('7. without the controller the pointing error does not converge', () => {
    const mk = (controllerEnabled: boolean) => {
      const sim = new SimulationRunner(
        cfg({ tracking: { ...DEFAULT_CONFIG.tracking, controllerEnabled } } as Partial<ScenarioConfig>, {
          motion: 'straight',
          speed: 0.1,
          startX: 1300,
          startY: 1250,
        }),
      );
      sim.runFor(20);
      return sim.finalize('ctl-' + controllerEnabled);
    };
    const on = mk(true);
    const off = mk(false);
    expect(on.acquisition_time_s).not.toBeNull();
    // With no control the loop cannot establish and hold a lock the way it does
    // with control: lock retention must be strictly worse.
    expect(on.lock_retention_percent ?? 0).toBeGreaterThan(off.lock_retention_percent ?? 0);
  });

  // ── 8. a different beacon trajectory changes tracking behaviour ─────────
  test('8. changing the trajectory changes the measured result', () => {
    const fig8 = new SimulationRunner(cfg({}, { motion: 'figure8' }));
    fig8.runFor(20);
    const a = fig8.finalize('fig8');

    const circ = new SimulationRunner(cfg({}, { motion: 'circular' }));
    circ.runFor(20);
    const b = circ.finalize('circ');

    expect(a.avg_error_px).not.toBe(b.avg_error_px);
  });

  // ── 9. disturbances change the observation, never the ground truth ──────
  test('9. noise changes observed pixels but leaves ground truth identical', () => {
    const clean = new SimulationRunner(cfg());
    const noisy = new SimulationRunner(
      cfg({
        noise: { saltPepperPercent: 8, gaussianSigma: 15, poissonEnabled: true },
      } as Partial<ScenarioConfig>),
    );

    const gtClean: number[] = [];
    const gtNoisy: number[] = [];
    let framesDiffer = false;
    const cleanFrames: Uint8Array[] = [];

    clean.runFor(3, (s) => {
      gtClean.push(s.beacon.x_px, s.beacon.y_px);
      cleanFrames.push(new Uint8Array(s.frame));
    });
    let i = 0;
    noisy.runFor(3, (s) => {
      gtNoisy.push(s.beacon.x_px, s.beacon.y_px);
      const ref = cleanFrames[i++];
      if (ref && !framesDiffer) {
        for (let k = 0; k < ref.length; k += 97) {
          if (ref[k] !== s.frame[k]) {
            framesDiffer = true;
            break;
          }
        }
      }
    });

    expect(framesDiffer).toBe(true); // observation changed
    expect(gtNoisy).toEqual(gtClean); // ground truth did not
  });

  // ── 10. signal loss produces a genuine detector dropout ─────────────────
  test('10. killing the beacon makes the detector report nothing', () => {
    const sim = new SimulationRunner(cfg({}, { motion: 'straight', speed: 0.3 }));
    sim.runFor(6); // establish a lock first
    let foundWhileAlive = 0;
    sim.runFor(2, (s) => {
      if (s.pipeline.detection.found) foundWhileAlive++;
    });

    sim.setBeaconKilled(true);
    let foundWhileDead = 0;
    sim.runFor(2, (s) => {
      if (s.pipeline.detection.found) foundWhileDead++;
    });

    expect(foundWhileAlive).toBeGreaterThan(0);
    expect(foundWhileDead).toBe(0);
  });

  // ── 11. Kalman prediction is actually used during the dropout ───────────
  test('11. the tracker predicts through a dropout instead of going blank', () => {
    const sim = new SimulationRunner(cfg({}, { motion: 'straight', speed: 0.3 }));
    sim.runFor(8);
    sim.setBeaconKilled(true);

    let sawPredictionState = false;
    let estimateKeptMoving = false;
    let prev: { x: number; y: number } | null = null;

    sim.runFor(1, (s) => {
      const t = s.pipeline.track;
      if (t.state === 'PREDICT_REACQUIRE' || t.is_prediction) sawPredictionState = true;
      if (t.x !== null && t.y !== null) {
        if (prev && (Math.abs(t.x - prev.x) > 1e-6 || Math.abs(t.y - prev.y) > 1e-6)) {
          estimateKeptMoving = true;
        }
        prev = { x: t.x, y: t.y };
      }
    });

    expect(sawPredictionState).toBe(true);
    expect(estimateKeptMoving).toBe(true); // propagated by the filter, not frozen
  });

  // ── 12. reacquisition requires a real re-detection ──────────────────────
  test('12. lock is not restored while the beacon is still absent', () => {
    const sim = new SimulationRunner(cfg({}, { motion: 'straight', speed: 0.3 }));
    sim.runFor(8);
    sim.setBeaconKilled(true);
    sim.runFor(2); // outage past the lost timeout (measured recovery ~0.1 s)

    let relockedWhileDead = false;
    sim.runFor(3, (s) => {
      if (s.pipeline.track.state === 'TRACK' && !s.pipeline.detection.found) {
        // TRACK with no measurement at all for this long would mean the lock
        // was restored without evidence.
        relockedWhileDead = true;
      }
    });
    expect(relockedWhileDead).toBe(false);

    // Restore the beacon: a real detection must be what brings the lock back.
    sim.setBeaconKilled(false);
    let recovered = false;
    sim.runFor(12, (s) => {
      if (s.pipeline.track.state === 'TRACK' && s.pipeline.detection.found) recovered = true;
    });
    expect(recovered).toBe(true);
  });

  // ── 13. ground truth is used only by the evaluation layer ───────────────
  test('13. ground truth reaches metrics only, and the detector never sees it', () => {
    // The metrics engine is the only engine module permitted to mention GT.
    expect(GT_TOKENS.test(readFileSync(join(SRC, 'metrics.ts'), 'utf8'))).toBe(true);

    // The detector's signature takes pixels and a prediction hint — nothing else.
    const detectorSrc = readFileSync(join(SRC, 'detector.ts'), 'utf8');
    expect(detectorSrc).toContain('predictHint');
    expect(GT_TOKENS.test(detectorSrc)).toBe(false);

    // With the detector disabled no lock can be established, which could not be
    // true if the pipeline were quietly reading ground truth to fake detections.
    const blind = new SimulationRunner(
      cfg({ tracking: { ...DEFAULT_CONFIG.tracking, detectorEnabled: false } } as Partial<ScenarioConfig>),
    );
    blind.runFor(15);
    const r = blind.finalize('blind');
    expect(r.acquisition_time_s).toBeNull();
    expect(r.detection_rate_percent).toBe(0);
  });

  // ── 14. mount motion changes what the camera observes (§9 item 7) ───────
  test('14. mount motion changes the observed frame', () => {
    // Same scene, same beacon, same seed. One run is allowed to slew; the other
    // has the controller disabled so the mount never moves. If the pixels the
    // detector sees were not a function of mount pose, these would be identical.
    const moving = new SimulationRunner(cfg({}, { motion: 'straight', speed: 0.1, startX: 1300, startY: 1250 }));
    const still = new SimulationRunner(
      cfg(
        { tracking: { ...DEFAULT_CONFIG.tracking, controllerEnabled: false } } as Partial<ScenarioConfig>,
        { motion: 'straight', speed: 0.1, startX: 1300, startY: 1250 },
      ),
    );
    let movingFrame: Uint8Array | null = null;
    let stillFrame: Uint8Array | null = null;
    moving.runFor(6, (s) => { movingFrame = new Uint8Array(s.frame); });
    still.runFor(6, (s) => { stillFrame = new Uint8Array(s.frame); });

    expect(movingFrame).not.toBeNull();
    expect(stillFrame).not.toBeNull();
    const a = movingFrame as unknown as Uint8Array;
    const b = stillFrame as unknown as Uint8Array;
    let differing = 0;
    for (let i = 0; i < a.length; i += 13) if (a[i] !== b[i]) differing++;
    expect(differing).toBeGreaterThan(0);
    // and the mount really did move in one case and not the other
    expect(Math.abs(moving.camera.pan_deg)).toBeGreaterThan(0.5);
    expect(still.camera.pan_deg).toBe(0);
  });

  // ── 15. a 7-second blackout drives the full recovery chain (§5, §9) ──────
  test('15. seven-second blackout: dropout, prediction, search, real re-detection', () => {
    const sim = new SimulationRunner(cfg({}, { motion: 'straight', speed: 0.3 }));
    const states = new Set<string>();
    let detectionsDuringBlackout = 0;
    let predictedFrames = 0;

    sim.runFor(8); // establish a lock
    expect(sim.pipeline.getMetrics().eventRows.at(-1)?.tracking_state).toBe('TRACK');

    sim.setBeaconKilled(true);
    sim.runFor(7, (s) => {
      states.add(s.pipeline.track.state);
      if (s.pipeline.detection.found) detectionsDuringBlackout++;
      if (s.pipeline.track.is_prediction) predictedFrames++;
    });

    // the detector genuinely saw nothing for the whole blackout
    expect(detectionsDuringBlackout).toBe(0);
    // prediction ran, and the loss escalated all the way to an active search
    expect(predictedFrames).toBeGreaterThan(0);
    expect(states.has('PREDICT_REACQUIRE')).toBe(true);
    expect(states.has('SEARCH')).toBe(true);

    // the mount actually swept while searching
    const panBefore = sim.camera.pan_deg;
    sim.runFor(1);
    expect(Math.abs(sim.camera.pan_deg - panBefore)).toBeGreaterThan(0);

    // restoring the beacon must produce a REAL detection before any relock
    sim.setBeaconKilled(false);
    let relockFrame = -1;
    let hadDetectionFirst = false;
    let i = 0;
    sim.runFor(25, (s) => {
      i++;
      if (s.pipeline.detection.found && relockFrame < 0) hadDetectionFirst = true;
      if (s.pipeline.track.state === 'TRACK' && relockFrame < 0) relockFrame = i;
    });
    expect(hadDetectionFirst).toBe(true);
    expect(relockFrame).toBeGreaterThan(0);
  });
});
