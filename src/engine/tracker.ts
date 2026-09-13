/**
 * Tracker: Kalman filter + tracking state machine (docs/04 §4.12).
 *
 *   SEARCH ──candidate──▶ CANDIDATE ──stable──▶ ACQUIRE ──confirm──▶ TRACK
 *      ▲                      │ disconfirm (M frames)        │ │
 *      └──────────────────────┘                              │ └─temporary loss─▶ PREDICT_REACQUIRE
 *                                                            ◀──────── recovered ─┘
 * PREDICT_REACQUIRE ──failed (timeout)──▶ SEARCH
 *
 * update() is called exactly once per frame even when detection is null.
 */
import { Kalman2D } from './kalman';
import type { Detection, TrackState, TrackingStateName } from './types';

export interface TrackerParams {
  acquisitionConfirmFrames: number;
  candidateDisconfirmFrames: number;
  lostTimeoutFrames: number;
  kalmanQ: number;
  kalmanR: number;
}

export interface TrackerEvents {
  onTransition?(from: TrackingStateName, to: TrackingStateName, frameIndex: number): void;
  onAcquired?(acquisitionTimeS: number, frameIndex: number): void;
  onLossConfirmed?(lossTimeS: number, frameIndex: number): void;
  onReacquired?(reacquisitionTimeS: number, frameIndex: number): void;
}

export class Tracker {
  private params: TrackerParams;
  private kalman: Kalman2D;
  private state: TrackingStateName = 'SEARCH';
  private trackAge = 0;
  private lostConsecutive = 0;
  private candidateStreak = 0;
  private candidateMiss = 0;
  private lastSeenS = 0;
  private lossStartS: number | null = null;
  private lastCandidatePos: { x: number; y: number } | null = null;
  private events: TrackerEvents;
  private predicted: { x: number; y: number } | null = null;

  constructor(params: TrackerParams, events: TrackerEvents = {}) {
    this.params = params;
    this.kalman = new Kalman2D(params.kalmanQ, params.kalmanR);
    this.events = events;
  }

  reset(): void {
    this.kalman.reset();
    this.state = 'SEARCH';
    this.trackAge = 0;
    this.lostConsecutive = 0;
    this.candidateStreak = 0;
    this.candidateMiss = 0;
    this.lastSeenS = 0;
    this.lossStartS = null;
    this.lastCandidatePos = null;
    this.predicted = null;
  }

  get currentState(): TrackingStateName {
    return this.state;
  }

  /** Gating hint for multi-candidate selection (docs/04 §4.9). */
  get predictionHint(): { x: number; y: number } | null {
    return this.kalman.isInitialized ? this.kalman.position() : null;
  }

  update(detection: Detection | null, timestampS: number, frameIndex: number, dtS: number): TrackState {
    const prev = this.state;

    // 1. Predict regardless of measurement availability
    const pred = this.kalman.predict(Math.max(dtS, 1e-3));
    this.predicted = this.kalman.isInitialized ? pred : null;

    if (detection && detection.found && detection.x !== null && detection.y !== null) {
      // Spatial-consistency gate (temporal scoring, docs/MVP-Tech-Doc §10):
      // a candidate that jumps far from the previous one is a NEW candidate
      // (e.g. a rain streak) and restarts confirmation instead of feeding
      // the streak counter.
      const jumpLimitPx = 50;
      const jumped =
        this.lastCandidatePos !== null &&
        Math.hypot(detection.x - this.lastCandidatePos.x, detection.y - this.lastCandidatePos.y) > jumpLimitPx;
      this.lastCandidatePos = { x: detection.x, y: detection.y };
      if (jumped && (this.state === 'CANDIDATE' || this.state === 'ACQUIRE')) {
        this.candidateStreak = 1;
      }

      this.kalman.correct(detection.x, detection.y);
      this.lostConsecutive = 0;
      this.lastSeenS = timestampS;

      switch (this.state) {
        case 'SEARCH':
          this.state = 'CANDIDATE';
          this.candidateStreak = 1;
          this.candidateMiss = 0;
          break;
        case 'CANDIDATE':
          this.candidateStreak++;
          this.candidateMiss = 0;
          if (this.candidateStreak >= 2) {
            this.state = 'ACQUIRE';
          }
          break;
        case 'ACQUIRE':
          this.candidateStreak++;
          this.candidateMiss = 0;
          if (this.candidateStreak >= this.params.acquisitionConfirmFrames) {
            this.state = 'TRACK';
            // if this confirmation ends a loss period, it is a RE-acquisition
            if (this.lossStartS !== null) {
              const rt = timestampS - this.lossStartS;
              this.lossStartS = null;
              this.events.onReacquired?.(rt, frameIndex);
            } else {
              this.events.onAcquired?.(timestampS, frameIndex);
            }
          }
          break;
        case 'TRACK':
          this.trackAge++;
          if (this.lossStartS !== null) {
            const rt = timestampS - this.lossStartS;
            this.lossStartS = null;
            this.events.onReacquired?.(rt, frameIndex);
            this.state = 'TRACK';
          }
          break;
        case 'PREDICT_REACQUIRE':
          // recovered
          this.state = 'TRACK';
          if (this.lossStartS !== null) {
            const rt = timestampS - this.lossStartS;
            this.lossStartS = null;
            this.events.onReacquired?.(rt, frameIndex);
          }
          break;
      }
    } else {
      this.lostConsecutive++;
      switch (this.state) {
        case 'CANDIDATE':
          this.candidateMiss++;
          if (this.candidateMiss >= this.params.candidateDisconfirmFrames) {
            this.state = 'SEARCH'; // explicit disconfirmation path
            this.candidateStreak = 0;
            this.kalman.reset();
          }
          break;
        case 'ACQUIRE':
          this.candidateMiss++;
          if (this.candidateMiss >= this.params.candidateDisconfirmFrames) {
            this.state = 'SEARCH';
            this.candidateStreak = 0;
            this.kalman.reset();
          }
          break;
        case 'TRACK':
          if (this.lostConsecutive >= 2) {
            this.state = 'PREDICT_REACQUIRE';
            this.lossStartS = timestampS;
            this.events.onLossConfirmed?.(timestampS, frameIndex);
          }
          break;
        case 'PREDICT_REACQUIRE':
          if (this.lostConsecutive >= this.params.lostTimeoutFrames) {
            this.state = 'SEARCH';
            this.trackAge = 0;
            this.kalman.reset();
            // NOTE: lossStartS is intentionally kept — reacquisition via the
            // normal SEARCH→CANDIDATE→ACQUIRE path must still measure the
            // full loss→recovery interval (docs/08 §1).
          }
          break;
        case 'SEARCH':
          break;
      }
    }

    if (this.state !== prev) {
      this.events.onTransition?.(prev, this.state, frameIndex);
    }

    const pos = this.kalman.isInitialized ? this.kalman.position() : null;
    const vel = this.kalman.isInitialized ? this.kalman.velocity() : null;
    const isPrediction =
      this.state === 'PREDICT_REACQUIRE' ||
      ((this.state === 'TRACK' || this.state === 'CANDIDATE' || this.state === 'ACQUIRE') &&
        (!detection || !detection.found));

    const confidence =
      detection && detection.found
        ? detection.confidence
        : Math.max(0, 0.9 * Math.exp(-this.lostConsecutive / 8));

    return {
      state: this.state,
      x: pos ? pos.x : null,
      y: pos ? pos.y : null,
      vx: vel ? vel.vx : null,
      vy: vel ? vel.vy : null,
      confidence,
      track_age_frames: this.trackAge,
      lost_frames_consecutive: this.lostConsecutive,
      is_prediction: isPrediction,
    };
  }
}
