/**
 * Decision engine for the hybrid detector (AI plan Phases 6, 7).
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT `(cv + ai) / 2`
 *
 * Averaging two confidences throws away the two things that actually decide
 * which bright spot is the beacon:
 *
 *   1. WHO IS CONFIDENT ABOUT WHAT. The classical stage is a good detector of
 *      "compact bright blob" and a poor discriminator between blobs. The
 *      learned stage is the reverse. An average lets a confident wrong answer
 *      cancel a correct unconfident one.
 *
 *   2. TIME. Both stages are per-frame; the problem is not. A candidate 7 px
 *      from where the Kalman filter says the beacon should be is evidence in
 *      a way that no single-frame appearance score can be.
 *
 * So this is a weighted score plus hard gates plus lock hysteresis, with the
 * weights changing by track state: during SEARCH there is no prediction to
 * lean on and appearance is all there is, while during TRACK the prior is
 * strong and switching targets should require real evidence.
 *
 * GROUND TRUTH IS NOT AN INPUT HERE AND NEVER WILL BE. Everything below is
 * derived from the observed frame and the tracker's own estimate.
 * ────────────────────────────────────────────────────────────────────────
 */
import type { BeaconCandidate } from './detector';
import type { TrackingStateName } from './types';

/** What the tracker tells the detector about the current estimate. */
export interface DetectionContext {
  state: TrackingStateName;
  /** Kalman position estimate, or null during a cold search. */
  prediction: { x: number; y: number } | null;
  trackAgeFrames: number;
  lostFramesConsecutive: number;
  /**
   * The receiver's own mount pose at exposure (encoder angles), so candidate
   * motion can be measured in the world rather than in the image (Phase 7).
   * Absent for sources with no pose (recorded video).
   */
  pose?: {
    panDeg: number;
    tiltDeg: number;
    pxPerDegX: number;
    pxPerDegY: number;
  } | null;
  /** Frame timestamp, s — for world-velocity regression. */
  timestampS?: number;
}

/**
 * Temporal evidence about one candidate, from the candidate track bank and
 * the learned track verifier (candidate-tracks.ts, track-verifier.ts).
 */
export interface TemporalEvidence {
  trackId: number;
  /** Frames the candidate's track has existed. */
  age: number;
  /** Learned P(this track is the beacon). */
  pBeacon: number;
  /** World speed after removing the receiver's own slew, px/s. */
  speedPxS: number;
  /** Sits on a point already written into the clutter map. */
  onClutter: boolean;
}

export interface FusionWeights {
  cv: number;
  ai: number;
  motion: number;
  shape: number;
  brightness: number;
}

/**
 * Weight sets per regime.
 *
 * The first version of these was chosen by reasoning about what information
 * exists in each state. `scripts/eval-detectors.ts` then measured all three
 * detectors on identical frames and showed that reasoning was wrong in one
 * specific way — see AI_VETO_WEIGHT below — so the AI weight here is now zero
 * and the model contributes through a penalty instead. These numbers were
 * revised in response to measurement, which is recorded rather than quietly
 * absorbed.
 */
export const SEARCH_WEIGHTS: FusionWeights = {
  // Cold search: no prediction exists, so appearance carries the decision.
  cv: 0.58,
  ai: 0,
  motion: 0,
  shape: 0.17,
  brightness: 0.25,
};

export const TRACK_WEIGHTS: FusionWeights = {
  // Locked: the prediction is the strongest single piece of evidence.
  cv: 0.3,
  ai: 0,
  motion: 0.55,
  shape: 0.06,
  brightness: 0.09,
};

/**
 * THE LEARNED MODEL VOTES ONLY AGAINST, NEVER FOR. Measured, not assumed.
 *
 * `scripts/eval-detectors.ts` scored all three detectors on identical frames.
 * The model's strength and its weakness are both large and they point in
 * opposite directions:
 *
 *   false alarms on an empty field   classical 71 -> learned 1    (clear)
 *                                    classical 77 -> learned 10   (jitter)
 *   bright decoys accepted           classical 3444 -> learned 3893
 *
 * It is excellent at "there is nothing here" and worse than classical CV at
 * "this is the right thing", because PS-169 makes the beacon size a free
 * 5-20 px parameter and the scene's decoys are 6-15 px — a strict subset — so
 * "wrong size" is not a property the model is permitted to learn, while the
 * classical stage is handed the configured size for the run.
 *
 * Adding the model's score as a positive term therefore PROMOTES decoys, which
 * is what the first version of this file did. It now contributes only a
 * penalty: a confident rejection counts, a confident acceptance does not
 * override the classical size prior.
 */
export const AI_VETO_WEIGHT = 0.3;
/** At or above this the model is not objecting, and contributes nothing. */
export const AI_TRUST = 0.35;

/** Penalty in [-AI_VETO_WEIGHT, 0]. Never positive. */
export function aiVeto(ai: number | null): number {
  if (ai === null || ai >= AI_TRUST) return 0;
  return (AI_VETO_WEIGHT * (ai - AI_TRUST)) / AI_TRUST;
}

/** Below this, the learned model is asserting "not a beacon". */
export const AI_REJECT_BELOW = 0.12;
/** Above this, the learned model is asserting "beacon". */
export const AI_ACCEPT_ABOVE = 0.6;
/** Motion consistency below this counts as "not temporally supported". */
export const WEAK_MOTION = 0.35;
/** Distance at which motion consistency has fallen to 0.5, px. */
export const MOTION_HALF_PX = 45;
/** While locked, a candidate this far from the incumbent is a target switch. */
export const SWITCH_PX = 55;
/** Multiplier applied to a candidate that would switch the lock. */
export const SWITCH_PENALTY = 0.45;

// ---- Track-level evidence (Phase 7) ----
/** Weight of the learned track verifier's opinion, centred on 0.5. */
export const TRACK_WEIGHT = 0.4;
/** Tracks younger than this carry no verifier term: too little history. */
export const TRACK_TRUST_AGE = 6;
/**
 * An established decoy: a track at least this old that the verifier puts at
 * or below DECOY_MAX_P is rejected OUTRIGHT, even if it is exactly where the
 * Kalman filter predicted. This is the rule that breaks a false lock — the
 * filter predicts the decoy precisely BECAUSE it has been tracking the decoy,
 * so temporal support is not evidence of anything in that situation.
 */
export const DECOY_MIN_AGE = 30;
/**
 * Chosen on the track-verifier VALIDATION split (mature tracks, age >= 30),
 * never on the locked test: at P <= 0.20, 83.9 % of decoy samples are
 * rejected while 0.19 % of beacon samples are (0.12 -> 70.6 % / 0.00 %;
 * 0.30 -> 88.7 % / 2.03 %). Re-derive if the verifier is retrained.
 */
export const DECOY_MAX_P = 0.2;
/**
 * A lock switch is exempt from the hysteresis penalty only when the evidence
 * is lopsided: a mature challenger the verifier believes, against an
 * incumbent it does not. On the validation split, P >= 0.75 is reached by
 * 71.1 % of beacon samples (age >= 15) and 2.19 % of decoy samples.
 */
export const VERIFIED_SWITCH_P = 0.75;
export const VERIFIED_SWITCH_AGE = 15;
export const DOUBTED_INCUMBENT_P = 0.35;
/**
 * ...or, relatively: the verifier prefers the challenger over the incumbent
 * by at least this much. Needed because a decoy as bright as the beacon, of
 * the configured size and static, is genuinely ambiguous to the verifier
 * (P ~ 0.5 — slow beacons exist in the data), so it is never "doubted" in
 * absolute terms, yet a mature track at P 0.99 flying past is plainly the
 * better explanation. Found on development seeds, not evaluation seeds.
 */
export const SWITCH_P_MARGIN = 0.35;

/** Does `tv` carry lopsided enough evidence to take the lock? */
export function isVerifiedChallenger(
  tv: TemporalEvidence | null,
  incumbentP: number | null | undefined,
): boolean {
  if (tv === null || incumbentP === null || incumbentP === undefined) return false;
  if (tv.age < VERIFIED_SWITCH_AGE || tv.pBeacon < VERIFIED_SWITCH_P) return false;
  return incumbentP <= DOUBTED_INCUMBENT_P || tv.pBeacon - incumbentP >= SWITCH_P_MARGIN;
}
/**
 * A spot ONLY the AI branch found (below the classical threshold) may start a
 * lock only after its track is this old and the verifier gives it at least
 * this probability. 10 frames = 0.33 s at 30 Hz.
 */
export const AI_ONLY_MIN_AGE = 10;
export const AI_ONLY_MIN_P = 0.5;

export type ChosenBy =
  | 'cv-only'
  | 'agreement'
  | 'ai-override'
  | 'temporal-override'
  | 'track-verified'
  | 'none';

export interface CandidateVerdict {
  candidate: BeaconCandidate;
  cvConfidence: number;
  /** null when no learned model is loaded. */
  aiConfidence: number | null;
  motionConsistency: number;
  distanceToPredictionPx: number | null;
  fusionScore: number;
  rejected: boolean;
  rejectReason: string | null;
}

export interface FusionDecision {
  /** Index into the input candidate array, or null if nothing survived. */
  index: number | null;
  confidence: number;
  chosenBy: ChosenBy;
  verdicts: CandidateVerdict[];
  /** How many candidates the AI gate threw out. */
  aiRejected: number;
  /** How many the track-level gates (established decoy, clutter) threw out. */
  trackRejected: number;
  /** True when CV's top pick and AI's top pick were different candidates. */
  disagreed: boolean;
}

/**
 * Temporal consistency: how well a candidate agrees with the Kalman estimate.
 * Returns a neutral 0.5 when there is no prediction, so a cold search is not
 * silently penalised for the absence of evidence it cannot have.
 */
export function motionConsistency(
  candidate: BeaconCandidate,
  prediction: { x: number; y: number } | null,
): { score: number; distance: number | null } {
  if (prediction === null) return { score: 0.5, distance: null };
  const d = Math.hypot(candidate.x - prediction.x, candidate.y - prediction.y);
  // Soft, not a cliff: a hard radius gate makes reacquisition brittle when the
  // estimate has drifted during an outage.
  const r = d / MOTION_HALF_PX;
  return { score: 1 / (1 + r * r), distance: d };
}

export interface FusionOptions {
  /** Previous frame's chosen position, for lock hysteresis. */
  incumbent: { x: number; y: number } | null;
  /** Composite floor applied during cold search only (mirrors detector.ts). */
  minConfidence: number;
  /**
   * Per-candidate temporal evidence (same index as `candidates`), or null
   * when no track bank / verifier is running. Absent evidence casts no vote.
   */
  temporal?: Array<TemporalEvidence | null> | null;
  /** The verifier's current opinion of the incumbent's track, if known. */
  incumbentP?: number | null;
}

/**
 * Score every candidate and pick one.
 *
 * `aiScores` is null when no learned model is loaded. An absent model must not
 * look like a model that disagrees, so it simply casts no veto — it does not
 * contribute a score of zero, which would penalise every candidate equally.
 */
export function fuse(
  candidates: BeaconCandidate[],
  aiScores: number[] | null,
  context: DetectionContext,
  opts: FusionOptions,
): FusionDecision {
  const verdicts: CandidateVerdict[] = [];
  if (candidates.length === 0) {
    return {
      index: null,
      confidence: 0,
      chosenBy: 'none',
      verdicts,
      aiRejected: 0,
      trackRejected: 0,
      disagreed: false,
    };
  }

  const locked = context.state === 'TRACK';
  // The positive weights already sum to 1 without an AI term, so an absent
  // model needs no redistribution: it simply casts no veto.
  const w = context.prediction !== null ? TRACK_WEIGHTS : SEARCH_WEIGHTS;

  let aiRejected = 0;
  let trackRejected = 0;
  let bestIdx: number | null = null;
  let bestScore = -1;
  let bestCvIdx = 0;
  let bestAiIdx = 0;
  let bestCvVal = -1;
  let bestAiVal = -1;

  // ---- Is the Kalman prediction itself suspect? ----
  // The prediction is derived from the incumbent's history. When the verifier
  // doubts the incumbent AND vouches for a mature challenger, proximity to
  // that prediction is circular evidence — it just says "close to the thing
  // we were already following". In that case it is scored as neutral for
  // everyone, so the switch is decided on the remaining evidence.
  const predictionDoubted = (opts.temporal ?? []).some((t) =>
    isVerifiedChallenger(t, opts.incumbentP),
  );

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const ai = aiScores === null ? null : aiScores[i];
    const mcRaw = motionConsistency(c, context.prediction);
    const mc = predictionDoubted ? { score: 0.5, distance: mcRaw.distance } : mcRaw;

    if (c.cvConfidence > bestCvVal) {
      bestCvVal = c.cvConfidence;
      bestCvIdx = i;
    }
    if (ai !== null && ai > bestAiVal) {
      bestAiVal = ai;
      bestAiIdx = i;
    }

    const tv = opts.temporal?.[i] ?? null;

    let score =
      w.cv * c.cvConfidence +
      w.motion * mc.score +
      w.shape * c.shapeScore +
      w.brightness * c.brightnessScore +
      aiVeto(ai); // <= 0 always; see AI_VETO_WEIGHT

    // ---- Track-level learned evidence (Phase 7) ----
    // The verifier judged this candidate's whole history — appearance over
    // time plus world motion — so it is allowed to vote in both directions,
    // unlike the single-frame CNN.
    if (tv !== null && tv.age >= TRACK_TRUST_AGE) {
      score += TRACK_WEIGHT * (tv.pBeacon - 0.5);
    }

    let rejected = false;
    let reason: string | null = null;

    // ---- Hard gate: the model says no AND nothing supports it in time ----
    // The second clause matters. A beacon clipped at the frame edge, or seen
    // through fog, can score badly on appearance; if it is nonetheless sitting
    // where the filter predicted, that is evidence and the gate must not fire.
    //
    // NO PREDICTION IS NOT NEUTRAL SUPPORT — IT IS NO SUPPORT.
    // `motionConsistency` returns 0.5 during a cold search so that candidates
    // are not penalised for evidence they cannot have. Reading that 0.5 as
    // "supported" disabled this gate for the whole of SEARCH, which is exactly
    // when a false lock is formed: measured, the hybrid detector inherited the
    // classical detector's 71 false alarms per 3,150 empty frames instead of
    // the learned model's 1.
    // A doubted prediction supports nothing (see predictionDoubted above).
    const temporallySupported =
      context.prediction !== null && !predictionDoubted && mcRaw.score >= WEAK_MOTION;
    if (ai !== null && ai < AI_REJECT_BELOW && !temporallySupported) {
      rejected = true;
      reason = `learned model rejected (${ai.toFixed(3)}) with no temporal support`;
      aiRejected++;
    }

    // ---- Hard gate: an AI-branch-only spot needs the model's vote ----
    // The local-contrast proposer is deliberately permissive (it exists to
    // find what the threshold misses); what it finds is only worth locking
    // onto if the CNN positively believes it, or the track already predicts it.
    if (!rejected && c.source === 'ai' && ai !== null && ai < AI_ACCEPT_ABOVE && !temporallySupported) {
      rejected = true;
      reason = `AI-branch proposal not confirmed by the model (${ai.toFixed(3)})`;
      aiRejected++;
    }
    // ...and, when temporal evidence is available, the verifier's too. A spot
    // the classical threshold cannot see at all is exactly where dim static
    // clutter lives; it may only START a lock once its track has shown
    // beacon-like behaviour. Measured on development seeds: without this the
    // hybrid chased a dim decoy during the cold search, dragged the camera
    // away from the scan, and took 6-10 s to find a blinking beacon that the
    // classical detector acquired in ~1 s.
    if (
      !rejected &&
      c.source === 'ai' &&
      !temporallySupported &&
      opts.temporal !== null &&
      opts.temporal !== undefined &&
      (tv === null || tv.age < AI_ONLY_MIN_AGE || tv.pBeacon < AI_ONLY_MIN_P)
    ) {
      rejected = true;
      reason = 'AI-branch-only spot not yet verified over time';
      trackRejected++;
    }

    // ---- Hard gate: an established decoy is never the answer ----
    // Deliberately NOT waived by temporal support: once the loop has locked a
    // decoy, the Kalman filter predicts the decoy, so "it is where we expected"
    // is circular. Only the verifier's judgement of the track's own history
    // can break that.
    if (!rejected && tv !== null && tv.age >= DECOY_MIN_AGE && tv.pBeacon <= DECOY_MAX_P) {
      rejected = true;
      reason = `track verifier: established decoy (p=${tv.pBeacon.toFixed(3)} over ${tv.age} frames)`;
      trackRejected++;
    }

    // ---- Hard gate: known static clutter, during a cold search ----
    // Without this the loop rejects a decoy, searches, re-finds the same
    // decoy, locks it as a fresh track, and repeats. The clutter map
    // remembers where rejected decoys are in the world.
    if (!rejected && tv !== null && tv.onClutter && !temporallySupported) {
      rejected = true;
      reason = 'known static clutter (clutter map)';
      trackRejected++;
    }

    // ---- Lock hysteresis: switching target needs more than a tie ----
    // Without this a bright decoy drifting into frame steals the lock the
    // moment it outscores the beacon by any margin at all. The one exemption
    // is lopsided track evidence: a mature challenger the verifier believes,
    // against an incumbent it doubts or clearly prefers less — the false-lock
    // recovery path.
    if (!rejected && locked && opts.incumbent !== null) {
      const dSwitch = Math.hypot(c.x - opts.incumbent.x, c.y - opts.incumbent.y);
      const verifiedSwitch = isVerifiedChallenger(tv, opts.incumbentP);
      if (dSwitch > SWITCH_PX && !verifiedSwitch) score *= SWITCH_PENALTY;
    }

    if (!rejected && score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }

    verdicts.push({
      candidate: c,
      cvConfidence: c.cvConfidence,
      aiConfidence: ai,
      motionConsistency: mc.score,
      distanceToPredictionPx: mc.distance,
      fusionScore: score,
      rejected,
      rejectReason: reason,
    });
  }

  if (bestIdx === null) {
    return {
      index: null,
      confidence: 0,
      chosenBy: 'none',
      verdicts,
      aiRejected,
      trackRejected,
      disagreed: false,
    };
  }

  // The model can no longer win by promotion, only by eliminating rivals, so
  // "the model's favourite was chosen" now means the field agreed with it
  // after vetoes were applied.
  const disagreed = aiScores !== null && bestCvIdx !== bestAiIdx;
  let chosenBy: ChosenBy;
  if (aiScores === null) {
    chosenBy = 'cv-only';
  } else if (
    bestIdx !== bestCvIdx &&
    (opts.temporal?.[bestIdx]?.pBeacon ?? 0) >= VERIFIED_SWITCH_P
  ) {
    // The classical favourite lost to a candidate the track verifier vouched
    // for — the decision was made on temporal evidence.
    chosenBy = 'track-verified';
  } else if (!disagreed) {
    chosenBy = 'agreement';
  } else if (bestIdx === bestAiIdx) {
    chosenBy = 'ai-override';
  } else if (bestIdx !== bestCvIdx) {
    // Neither stage's favourite won — the prediction broke the tie.
    chosenBy = 'temporal-override';
  } else {
    chosenBy = 'cv-only';
  }

  // The fused score is already a convex combination of [0,1] terms, so it is
  // in range; the 1.15 lift compensates for the shape/brightness terms rarely
  // saturating, matching the scale the classical detector reports.
  const confidence = Math.max(0, Math.min(1, bestScore * 1.15));

  // Cold-search floor, same rule and same reasoning as detector.ts: with no
  // prediction, a weak candidate is almost certainly clutter, and locking onto
  // it is worse than continuing to search. With a prediction the floor must
  // NOT apply or reacquisition of an edge-clipped beacon is blocked.
  if (context.prediction === null && confidence < opts.minConfidence) {
    return {
      index: null,
      confidence,
      chosenBy: 'none',
      verdicts,
      aiRejected,
      trackRejected,
      disagreed,
    };
  }

  return { index: bestIdx, confidence, chosenBy, verdicts, aiRejected, trackRejected, disagreed };
}
