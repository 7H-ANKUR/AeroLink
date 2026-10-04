/**
 * Candidate track bank + clutter map (AI plan Phases 6, 7).
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY PER-FRAME PERCEPTION CANNOT SOLVE THE DECOY PROBLEM
 *
 * scripts/eval-detectors.ts showed every detector — classical, learned and
 * hybrid — false-locking onto bright decoys in 4-6 of 6 seeds. Tracing those
 * runs gave one mechanism every time: the beacon starts outside the sensor
 * window, the only thing in view is a decoy, it is locked by frame 3, and
 * lock hysteresis then holds it forever — even after the beacon flies into
 * view 150 px away.
 *
 * A single frame cannot fix that. PS-169 lets the beacon be any size from 5
 * to 20 px and the decoys are 6-15 px, so on appearance alone a decoy IS a
 * plausible beacon. What differs is behaviour over time: the decoys are fixed
 * in the world and the beacon — on a MOBILE terminal — is not.
 *
 * WHAT THIS MODULE DOES
 *
 * Every candidate spot, from either perception branch, is associated frame to
 * frame into a short track. Each track's position is expressed in WORLD
 * coordinates using the mount's own pose (pan/tilt encoder angles — the
 * receiver's own state, not ground truth), so the receiver's slew is removed
 * and a static object stays static even while the camera sweeps. Frame-wide
 * shake (jitter, platform drift) moves every object together; when three or
 * more tracks are matched, that common-mode offset is estimated as their
 * median displacement and removed.
 *
 * Each track accumulates evidence — mean CNN score, mean classical
 * descriptors, a least-squares world velocity with its own reliability,
 * persistence — which the learned track verifier (track-verifier.ts) turns
 * into P(this track is the beacon).
 *
 * Tracks that are old enough to judge and are judged to be decoys are written
 * into a CLUTTER MAP (a world-coordinate list of known static clutter, the
 * same idea as a radar clutter map). A cold search then refuses to lock onto
 * known clutter again, which is what breaks the lock-reject-relock loop.
 *
 * NOTHING HERE SEES GROUND TRUTH. Inputs are candidate pixels, CNN scores the
 * system computed, and the system's own mount pose.
 * ────────────────────────────────────────────────────────────────────────
 */
import type { BeaconCandidate } from './detector';

/** The receiver's own pointing state for this frame. */
export interface SensorPose {
  panDeg: number;
  tiltDeg: number;
  pxPerDegX: number;
  pxPerDegY: number;
  width: number;
  height: number;
}

/** Feature order consumed by the track verifier. Mirrored in
 *  scripts/ai/train_track_verifier.py — change both or neither. */
export const TRACK_FEATURES = [
  'ai_mean', // mean CNN appearance score
  'cv_mean', // mean classical composite
  'size_mean', // mean size affinity to the configured beacon size
  'bright_mean', // mean peak brightness / 255
  'speed', // world speed, px/s / 100, capped at 4
  'speed_reliability', // 0..1, grows with history length
  'moving_evidence', // speed * reliability
  'persistence', // hits / (hits + misses)
] as const;
export const N_TRACK_FEATURES = TRACK_FEATURES.length;

const HISTORY = 30; // frames of world position kept per track (~1 s at 30 Hz)
const GATE_CORRECTED_PX = 30; // association gate when common-mode is removed
const GATE_RAW_PX = 60; // gate when it cannot be (fewer than 3 tracks)
const COMMON_MODE_MIN_TRACKS = 3;
const COMMON_MODE_SEARCH_PX = 80;
const MAX_MISSES = 8;
const EMA = 0.2;
const SPEED_CAP = 4; // x100 px/s

/** A track must be at least this old before it may be written as clutter. */
export const CLUTTER_MIN_AGE = 45;
/** ...and judged at most this likely to be the beacon (the same validation-
 *  chosen threshold as fusion.ts DECOY_MAX_P). */
export const CLUTTER_MAX_P = 0.2;
/** World radius within which a candidate is "on" a clutter point, px. */
export const CLUTTER_RADIUS_PX = 30;
const CLUTTER_CAP = 64;

export interface CandidateTrack {
  id: number;
  /** Frames since the track was born. */
  age: number;
  hits: number;
  misses: number;
  /** Last associated image position, px. */
  x: number;
  y: number;
  /** Last common-mode-corrected world position, px (boresight-origin). */
  wx: number;
  wy: number;
  aiMean: number;
  cvMean: number;
  sizeMean: number;
  brightMean: number;
  /** Least-squares world velocity, px/s. */
  vx: number;
  vy: number;
  speedPxS: number;
  speedReliability: number;
  /** Written by the decision engine after the verifier runs. */
  pBeacon: number;
  /** Index of the candidate matched this frame, or -1. */
  matched: number;
  // ring buffer of corrected world positions
  hT: Float64Array;
  hX: Float64Array;
  hY: Float64Array;
  hN: number;
  hHead: number;
}

export interface ClutterPoint {
  wx: number;
  wy: number;
  hits: number;
}

export interface TrackBankFrame {
  /** Track associated with each input candidate (same index). */
  trackOf: CandidateTrack[];
  /** True when the candidate sits on a known clutter point. */
  onClutter: boolean[];
  /** Estimated frame-wide shake removed this frame, px (null if not estimable). */
  commonMode: { dx: number; dy: number } | null;
}

export class CandidateTrackBank {
  private tracks: CandidateTrack[] = [];
  private clutter: ClutterPoint[] = [];
  private nextId = 1;

  get liveTracks(): readonly CandidateTrack[] {
    return this.tracks;
  }

  get clutterPoints(): readonly ClutterPoint[] {
    return this.clutter;
  }

  reset(): void {
    this.tracks = [];
    this.clutter = [];
    this.nextId = 1;
  }

  /** World position of an image point under the given pose. */
  static toWorld(x: number, y: number, pose: SensorPose): { wx: number; wy: number } {
    return {
      wx: pose.panDeg * pose.pxPerDegX + (x - pose.width / 2),
      wy: pose.tiltDeg * pose.pxPerDegY + (y - pose.height / 2),
    };
  }

  update(
    candidates: BeaconCandidate[],
    aiScores: number[] | null,
    pose: SensorPose,
    tS: number,
  ): TrackBankFrame {
    const n = candidates.length;
    const world = candidates.map((c) => CandidateTrackBank.toWorld(c.x, c.y, pose));

    // Predicted world position of each live track at tS.
    const preds = this.tracks.map((t) => {
      const lastT = t.hN > 0 ? t.hT[(t.hHead - 1 + HISTORY) % HISTORY] : tS;
      const dt = Math.max(0, tS - lastT);
      return { x: t.wx + t.vx * dt, y: t.wy + t.vy * dt };
    });

    // ---- Common-mode (frame-wide shake) estimate ----
    let common: { dx: number; dy: number } | null = null;
    if (this.tracks.length >= COMMON_MODE_MIN_TRACKS && n >= COMMON_MODE_MIN_TRACKS) {
      const dxs: number[] = [];
      const dys: number[] = [];
      for (let k = 0; k < this.tracks.length; k++) {
        let best = -1;
        let bestD = COMMON_MODE_SEARCH_PX;
        for (let i = 0; i < n; i++) {
          const d = Math.hypot(world[i].wx - preds[k].x, world[i].wy - preds[k].y);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
        if (best >= 0) {
          dxs.push(world[best].wx - preds[k].x);
          dys.push(world[best].wy - preds[k].y);
        }
      }
      if (dxs.length >= COMMON_MODE_MIN_TRACKS) common = { dx: median(dxs), dy: median(dys) };
    }
    const offX = common ? common.dx : 0;
    const offY = common ? common.dy : 0;
    const gate = common ? GATE_CORRECTED_PX : GATE_RAW_PX;

    // ---- Greedy nearest-first association ----
    const pairs: Array<{ k: number; i: number; d: number }> = [];
    for (let k = 0; k < this.tracks.length; k++) {
      for (let i = 0; i < n; i++) {
        const d = Math.hypot(world[i].wx - offX - preds[k].x, world[i].wy - offY - preds[k].y);
        if (d <= gate) pairs.push({ k, i, d });
      }
    }
    pairs.sort((a, b) => a.d - b.d);
    const trackTaken = new Uint8Array(this.tracks.length);
    const candTaken = new Int32Array(n).fill(-1);
    for (const p of pairs) {
      if (trackTaken[p.k] || candTaken[p.i] >= 0) continue;
      trackTaken[p.k] = 1;
      candTaken[p.i] = p.k;
    }

    for (const t of this.tracks) t.matched = -1;
    const trackOf: CandidateTrack[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const c = candidates[i];
      const ai = aiScores === null ? 0.5 : aiScores[i];
      const wx = world[i].wx - offX;
      const wy = world[i].wy - offY;
      let t: CandidateTrack;
      if (candTaken[i] >= 0) {
        t = this.tracks[candTaken[i]];
        t.hits++;
        t.misses = 0;
        t.aiMean += EMA * (ai - t.aiMean);
        t.cvMean += EMA * (c.cvConfidence - t.cvMean);
        t.sizeMean += EMA * (c.sizeScore - t.sizeMean);
        t.brightMean += EMA * (c.brightnessScore - t.brightMean);
      } else {
        t = newTrack(this.nextId++, ai, c);
        this.tracks.push(t);
      }
      t.x = c.x;
      t.y = c.y;
      t.wx = wx;
      t.wy = wy;
      pushHistory(t, tS, wx, wy);
      fitVelocity(t);
      t.matched = i;
      trackOf[i] = t;
    }

    // Age every surviving track; retire the ones that stopped being seen.
    const survivors: CandidateTrack[] = [];
    for (const t of this.tracks) {
      t.age++;
      if (t.matched < 0) t.misses++;
      if (t.misses <= MAX_MISSES) survivors.push(t);
    }
    this.tracks = survivors;

    const onClutter = world.map((w) => this.isClutter(w.wx - offX, w.wy - offY));
    return { trackOf, onClutter, commonMode: common };
  }

  /** Feature vector for the verifier, in TRACK_FEATURES order. */
  static features(t: CandidateTrack, out: Float32Array = new Float32Array(N_TRACK_FEATURES)): Float32Array {
    const speed = Math.min(SPEED_CAP, t.speedPxS / 100);
    out[0] = t.aiMean;
    out[1] = t.cvMean;
    out[2] = t.sizeMean;
    out[3] = t.brightMean;
    out[4] = speed;
    out[5] = t.speedReliability;
    out[6] = speed * t.speedReliability;
    out[7] = t.hits / Math.max(1, t.hits + t.misses);
    return out;
  }

  isClutter(wx: number, wy: number): boolean {
    for (const p of this.clutter) {
      if (Math.hypot(p.wx - wx, p.wy - wy) <= CLUTTER_RADIUS_PX) return true;
    }
    return false;
  }

  /**
   * Write tracks that are old enough to judge, and judged to be decoys, into
   * the clutter map. Call after the verifier has set `pBeacon`.
   */
  promoteClutter(): number {
    let added = 0;
    for (const t of this.tracks) {
      if (t.matched < 0 || t.age < CLUTTER_MIN_AGE || t.pBeacon > CLUTTER_MAX_P) continue;
      let merged = false;
      for (const p of this.clutter) {
        if (Math.hypot(p.wx - t.wx, p.wy - t.wy) <= CLUTTER_RADIUS_PX) {
          p.wx += 0.1 * (t.wx - p.wx);
          p.wy += 0.1 * (t.wy - p.wy);
          p.hits++;
          merged = true;
          break;
        }
      }
      if (!merged) {
        if (this.clutter.length >= CLUTTER_CAP) this.clutter.shift();
        this.clutter.push({ wx: t.wx, wy: t.wy, hits: 1 });
        added++;
      }
    }
    return added;
  }
}

function newTrack(id: number, ai: number, c: BeaconCandidate): CandidateTrack {
  return {
    id,
    age: 0,
    hits: 1,
    misses: 0,
    x: c.x,
    y: c.y,
    wx: 0,
    wy: 0,
    aiMean: ai,
    cvMean: c.cvConfidence,
    sizeMean: c.sizeScore,
    brightMean: c.brightnessScore,
    vx: 0,
    vy: 0,
    speedPxS: 0,
    speedReliability: 0,
    pBeacon: 0.5,
    matched: -1,
    hT: new Float64Array(HISTORY),
    hX: new Float64Array(HISTORY),
    hY: new Float64Array(HISTORY),
    hN: 0,
    hHead: 0,
  };
}

function pushHistory(t: CandidateTrack, tS: number, wx: number, wy: number): void {
  t.hT[t.hHead] = tS;
  t.hX[t.hHead] = wx;
  t.hY[t.hHead] = wy;
  t.hHead = (t.hHead + 1) % HISTORY;
  if (t.hN < HISTORY) t.hN++;
}

/**
 * Least-squares slope of world position against time over the history.
 * A regression, not a frame difference: with jitter of a few px per frame a
 * difference is dominated by shake, while a 1 s regression averages it out.
 */
function fitVelocity(t: CandidateTrack): void {
  const n = t.hN;
  if (n < 4) {
    t.vx = 0;
    t.vy = 0;
    t.speedPxS = 0;
    t.speedReliability = 0;
    return;
  }
  let mt = 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mt += t.hT[i];
    mx += t.hX[i];
    my += t.hY[i];
  }
  mt /= n;
  mx /= n;
  my /= n;
  let stt = 0;
  let stx = 0;
  let sty = 0;
  for (let i = 0; i < n; i++) {
    const dt = t.hT[i] - mt;
    stt += dt * dt;
    stx += dt * (t.hX[i] - mx);
    sty += dt * (t.hY[i] - my);
  }
  if (stt <= 1e-9) {
    t.vx = 0;
    t.vy = 0;
  } else {
    t.vx = stx / stt;
    t.vy = sty / stt;
  }
  t.speedPxS = Math.hypot(t.vx, t.vy);
  t.speedReliability = Math.min(1, (n - 1) / 20);
}

function median(xs: number[]): number {
  const v = xs.slice().sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 === 1 ? v[m] : (v[m - 1] + v[m]) / 2;
}
