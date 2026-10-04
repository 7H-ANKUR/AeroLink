/**
 * Learned and hybrid beacon detectors (AI plan Phases 5, 7, 8, 10, 11, 12).
 *
 * ────────────────────────────────────────────────────────────────────────
 * Three learned configurations, all implementing the same `BeaconDetector`
 * interface so the tracker, controller and metrics downstream cannot tell
 * them apart:
 *
 *   `ai`            THE AI BRANCH ON ITS OWN (Mode 2)
 *     the learned branch's own local-contrast proposer (proposer.ts) finds
 *     candidate spots — no classical threshold involved — and TinyBeaconNet
 *     scores each 24x24 crop. Highest score wins.
 *
 *   `ai_fullframe`  FULL-FRAME LEARNED DETECTION (Mode 1)
 *     the same network applied densely over the whole frame (nn.ts,
 *     FullFrameNet). Benchmark-only: it does not fit the frame budget.
 *
 *   `fusion`        CLASSICAL + AI BRANCH + TEMPORAL VERIFICATION
 *     both branches propose independently; their candidate sets are merged;
 *     every candidate is scored by the CNN, associated into a world-frame
 *     candidate track (candidate-tracks.ts) and judged over time by the
 *     learned track verifier (track-verifier.ts); the decision engine
 *     (fusion.ts) arbitrates with the Kalman prediction and lock hysteresis.
 *
 * NO MODEL, NO DETECTOR. Without the weights these classes refuse to
 * construct. They never fall back to "classical CV wearing an AI label".
 * ────────────────────────────────────────────────────────────────────────
 */
import { ClassicalDetector, nowMs, type BeaconCandidate, type DetectorParams } from './detector';
import type { BeaconDetector, DetectorKindId } from './detectors';
import { fuse, SWITCH_PX, type DetectionContext, type TemporalEvidence } from './fusion';
import {
  buildPatchBatch,
  FullFrameNet,
  TinyBeaconNet,
  type BatchScorer,
  type BatchVerifier,
  type ModelManifest,
} from './nn';
import { LocalContrastProposer } from './proposer';
import {
  CandidateTrackBank,
  N_TRACK_FEATURES,
  type CandidateTrack,
  type TrackBankFrame,
} from './candidate-tracks';
import type { TrackVerifier } from './track-verifier';
import type { Detection, DetectionProvenance } from './types';

/** A loaded model plus the metadata that lets a run record name it. */
export interface LoadedModel {
  net: TinyBeaconNet;
  manifest: ModelManifest;
  /** Raw weights — needed to build the full-frame (Mode 1) network. */
  weights?: Float32Array;
  /** Learned track verifier; required by the hybrid detector only. */
  verifier?: TrackVerifier | null;
  /**
   * Optional runtime backend for the CNN (plan2: ONNX Runtime Web). When set,
   * `detectAsync` scores crops through it; `detect` keeps the TypeScript
   * forward pass. Both run the same trained weights.
   */
  scorer?: BatchScorer | null;
  /** Optional runtime backend for the track verifier. */
  batchVerifier?: BatchVerifier | null;
}

/** Runtime label for the in-engine TypeScript forward pass. */
export const TS_RUNTIME = 'typescript (in-engine forward pass)';

/** Score candidates through an async runtime backend, one batched call. */
export async function scoreBatchWith(
  scorer: BatchScorer,
  candidates: BeaconCandidate[],
  frame: Uint8Array,
  width: number,
  height: number,
): Promise<Float32Array> {
  if (candidates.length === 0) return new Float32Array(0);
  const batch = buildPatchBatch(frame, width, height, candidates);
  return scorer.scoreBatch(batch, candidates.length);
}

/** Classical proposals scored per frame. Bounded so latency is bounded. */
const MAX_CANDIDATES = 12;
/** AI-branch proposals per frame. */
const MAX_AI_PROPOSALS = 6;
/** Minimum local contrast for an AI-branch proposal, grey levels. */
const AI_MIN_CONTRAST = 18;
/** Two branches' spots closer than this are the same spot. */
const SAME_SPOT_PX = 6;

/** Below this the learned branch declines to call anything a beacon. */
const AI_MIN_CONFIDENCE = 0.5;

function emptyDetection(
  method: 'ai' | 'fusion',
  tStartMs: number,
  confidence: number,
  provenance: DetectionProvenance | null,
): Detection {
  return {
    found: false,
    x: null,
    y: null,
    confidence,
    bbox: null,
    method,
    latency_ms: nowMs() - tStartMs,
    provenance,
  };
}

function toDetection(
  method: 'ai' | 'fusion',
  c: BeaconCandidate,
  confidence: number,
  tStartMs: number,
  provenance: DetectionProvenance | null,
): Detection {
  return {
    found: true,
    x: c.x,
    y: c.y,
    confidence,
    bbox: c.bbox,
    method,
    latency_ms: nowMs() - tStartMs,
    provenance,
  };
}

export function scoreAll(
  net: TinyBeaconNet,
  candidates: BeaconCandidate[],
  frame: Uint8Array,
  width: number,
  height: number,
  out: number[],
): number[] {
  out.length = 0;
  for (const c of candidates) out.push(net.scoreAt(frame, width, height, c.x, c.y));
  return out;
}

/**
 * Merge the two branches' candidate sets. A spot both branches found is ONE
 * candidate, marked 'both' and kept with the classical geometry (the
 * threshold centroid is the more accurate one on a clean spot); spots only
 * the learned branch found are appended as 'ai'. Exported so the offline
 * track-dataset harvester builds features exactly as the live detector does.
 */
export function mergeBranchCandidates(
  cvCands: BeaconCandidate[],
  aiProps: BeaconCandidate[],
): BeaconCandidate[] {
  const out: BeaconCandidate[] = cvCands.map((c) => ({ ...c, source: 'cv' as const }));
  const nCv = out.length;
  for (const p of aiProps) {
    let dup = false;
    // Compare against the CLASSICAL candidates only: two AI proposals near
    // each other are not "confirmed by both branches".
    for (let k = 0; k < nCv; k++) {
      const c = out[k];
      if (Math.hypot(c.x - p.x, c.y - p.y) <= SAME_SPOT_PX) {
        c.source = 'both';
        dup = true;
        break;
      }
    }
    if (!dup) out.push(p);
  }
  return out;
}

/** Branch sizes, exported for the offline harvester. */
export const BRANCH_LIMITS = {
  maxCandidates: MAX_CANDIDATES,
  maxAiProposals: MAX_AI_PROPOSALS,
  aiMinContrast: AI_MIN_CONTRAST,
} as const;

/**
 * `ai` — the learned branch on its own.
 *
 * Deliberately has no temporal reasoning and no classical stage: it exists so
 * the benchmark can measure what the learned branch contributes BY ITSELF,
 * separately from what fusion and the temporal verifier add.
 *
 * Two execution paths share every line of logic except where the CNN runs:
 * `detect` scores with the pure-TypeScript forward pass; `detectAsync` scores
 * the same crops through the injected runtime (ONNX Runtime Web in the
 * browser worker). Provenance records which one ran.
 */
export class AiBranchDetector implements BeaconDetector {
  readonly kind: DetectorKindId = 'ai';
  readonly label = 'LEARNED AI BRANCH';
  readonly available = true;
  private proposer: LocalContrastProposer;
  private model: LoadedModel;
  private scores: number[] = [];

  constructor(params: DetectorParams, model: LoadedModel) {
    this.model = model;
    this.proposer = new LocalContrastProposer({
      maxProposals: MAX_CANDIDATES,
      minContrast: AI_MIN_CONTRAST,
      expectedBeaconSize: params.expectedBeaconSize,
    });
  }

  updateParams(p: Partial<DetectorParams>): void {
    if (p.expectedBeaconSize !== undefined) {
      this.proposer.updateParams({ expectedBeaconSize: p.expectedBeaconSize });
    }
  }

  get modelName(): string {
    return this.model.manifest.name;
  }

  detect(
    frame: Uint8Array,
    width: number,
    height: number,
    tStartMs: number,
    _predictHint: { x: number; y: number } | null,
  ): Detection {
    const tProp = nowMs();
    const proposals = this.proposer.propose(frame, width, height);
    const propLatency = nowMs() - tProp;
    const tInf = nowMs();
    const scores = scoreAll(this.model.net, proposals, frame, width, height, this.scores);
    return this.decide(proposals, scores, propLatency, nowMs() - tInf, TS_RUNTIME, tStartMs);
  }

  async detectAsync(
    frame: Uint8Array,
    width: number,
    height: number,
    tStartMs: number,
    predictHint: { x: number; y: number } | null,
  ): Promise<Detection> {
    const scorer = this.model.scorer;
    if (!scorer) return this.detect(frame, width, height, tStartMs, predictHint);
    const tProp = nowMs();
    const proposals = this.proposer.propose(frame, width, height);
    const propLatency = nowMs() - tProp;
    const tInf = nowMs();
    const scores = await scoreBatchWith(scorer, proposals, frame, width, height);
    return this.decide(proposals, scores, propLatency, nowMs() - tInf, scorer.runtime, tStartMs);
  }

  private decide(
    proposals: BeaconCandidate[],
    scores: ArrayLike<number>,
    propLatency: number,
    inferenceMs: number,
    runtime: string,
    tStartMs: number,
  ): Detection {
    const base: DetectionProvenance = {
      candidateCount: 0,
      cv: null,
      ai: null,
      spatialAgreementPx: null,
      predictionDistancePx: null,
      chosenBy: 'none',
      aiRejected: 0,
      disagreed: false,
      cvLatencyMs: 0,
      aiLatencyMs: propLatency + inferenceMs,
      fusionLatencyMs: 0,
      aiBranchCount: proposals.length,
      chosenSource: null,
      aiRuntime: runtime,
      aiInferenceMs: inferenceMs,
      aiScored: proposals.length,
    };
    if (proposals.length === 0) return emptyDetection('ai', tStartMs, 0, base);

    let bestIdx = 0;
    for (let i = 1; i < proposals.length; i++) if (scores[i] > scores[bestIdx]) bestIdx = i;
    const best = proposals[bestIdx];
    let rejected = 0;
    for (let i = 0; i < proposals.length; i++) if (scores[i] < AI_MIN_CONFIDENCE) rejected++;
    const provenance: DetectionProvenance = {
      ...base,
      ai: { x: best.x, y: best.y, confidence: scores[bestIdx] },
      chosenBy: 'ai',
      aiRejected: rejected,
      chosenSource: 'ai',
      decisionReason:
        scores[bestIdx] < AI_MIN_CONFIDENCE
          ? `best AI score ${scores[bestIdx].toFixed(3)} below ${AI_MIN_CONFIDENCE}`
          : `highest AI score ${scores[bestIdx].toFixed(3)} of ${proposals.length} proposals`,
    };
    if (scores[bestIdx] < AI_MIN_CONFIDENCE) {
      return emptyDetection('ai', tStartMs, scores[bestIdx], { ...provenance, chosenSource: null });
    }
    return toDetection('ai', best, scores[bestIdx], tStartMs, provenance);
  }
}

/**
 * `ai_fullframe` — Mode 1. The same trained network, applied densely.
 * Benchmark-only (see DETECTOR_REGISTRY.realtime).
 */
export class FullFrameAiDetector implements BeaconDetector {
  readonly kind: DetectorKindId = 'ai_fullframe';
  readonly label = 'LEARNED FULL-FRAME (MODE 1)';
  readonly available = true;
  private model: LoadedModel;
  private dense: FullFrameNet | null = null;

  constructor(_params: DetectorParams, model: LoadedModel) {
    if (!model.weights) {
      throw new Error('Full-frame detector needs the raw weights (LoadedModel.weights).');
    }
    this.model = model;
  }

  detect(
    frame: Uint8Array,
    width: number,
    height: number,
    tStartMs: number,
    _predictHint: { x: number; y: number } | null,
  ): Detection {
    if (this.dense === null || this.dense.w !== width || this.dense.h !== height) {
      this.dense = new FullFrameNet(this.model.weights as Float32Array, width, height);
    }
    const t0 = nowMs();
    const hit = this.dense.detect(frame);
    const lat = nowMs() - t0;
    const provenance: DetectionProvenance = {
      candidateCount: 0,
      cv: null,
      ai: hit ? { x: hit.x, y: hit.y, confidence: hit.score } : null,
      spatialAgreementPx: null,
      predictionDistancePx: null,
      chosenBy: hit ? 'ai' : 'none',
      aiRejected: 0,
      disagreed: false,
      cvLatencyMs: 0,
      aiLatencyMs: lat,
      fusionLatencyMs: 0,
      aiBranchCount: null,
      chosenSource: hit ? 'ai' : null,
    };
    if (hit === null) return emptyDetection('ai', tStartMs, 0, provenance);
    const half = 6;
    return {
      found: true,
      x: hit.x,
      y: hit.y,
      confidence: hit.score,
      bbox: [hit.x - half, hit.y - half, 2 * half, 2 * half],
      method: 'ai',
      latency_ms: nowMs() - tStartMs,
      provenance,
    };
  }
}

/**
 * `fusion` — classical branch + AI branch + temporal verification.
 *
 * This is the configuration the plan argues for: neither branch wins
 * automatically, the Kalman prediction is a first-class input, and — the part
 * single-frame perception cannot do — every candidate is judged on its
 * behaviour over time by a learned verifier before it may hold the lock.
 *
 * Staged so the synchronous TypeScript path and the asynchronous runtime path
 * (ONNX Runtime Web: CNN and verifier both) execute the SAME decision code on
 * the SAME observed frame; only the inference backend differs, and provenance
 * records which one ran.
 */
export class HybridFusionDetector implements BeaconDetector {
  readonly kind: DetectorKindId = 'fusion';
  readonly label = 'HYBRID CV + AI + TEMPORAL';
  readonly available = true;

  private classical: ClassicalDetector;
  private proposer: LocalContrastProposer;
  private model: LoadedModel;
  private verifier: TrackVerifier;
  private bank = new CandidateTrackBank();
  private feat = new Float32Array(N_TRACK_FEATURES);
  private scores: number[] = [];
  private minConfidence: number;
  /** Last accepted position and its track — the incumbent for hysteresis. */
  private incumbent: { x: number; y: number } | null = null;
  private incumbentTrackId: number | null = null;
  private context: DetectionContext = {
    state: 'SEARCH',
    prediction: null,
    trackAgeFrames: 0,
    lostFramesConsecutive: 0,
  };
  /** Fallback clock when the pipeline supplies no timestamp. */
  private frameCount = 0;

  constructor(params: DetectorParams, model: LoadedModel) {
    if (!model.verifier) {
      throw new Error(
        'The hybrid detector needs the learned track verifier ' +
          '(public/models/track-verifier-v1.json) and none was supplied. ' +
          'Train it with scripts/ai/train_track_verifier.py, or select another detector.',
      );
    }
    this.classical = new ClassicalDetector(params);
    this.proposer = new LocalContrastProposer({
      maxProposals: MAX_AI_PROPOSALS,
      minContrast: AI_MIN_CONTRAST,
      expectedBeaconSize: params.expectedBeaconSize,
    });
    this.model = model;
    this.verifier = model.verifier;
    this.minConfidence = params.minConfidence;
  }

  updateParams(p: Partial<DetectorParams>): void {
    this.classical.updateParams(p);
    if (p.expectedBeaconSize !== undefined) {
      this.proposer.updateParams({ expectedBeaconSize: p.expectedBeaconSize });
    }
    if (p.minConfidence !== undefined) this.minConfidence = p.minConfidence;
  }

  get modelName(): string {
    return this.model.manifest.name;
  }

  /**
   * Hand the detector the tracker's current state and the mount's own pose.
   * Both are the system's OWN quantities; ground truth is never offered here.
   */
  setContext(ctx: DetectionContext): void {
    this.context = ctx;
    if (ctx.state === 'SEARCH') {
      this.incumbent = null;
      this.incumbentTrackId = null;
    }
  }

  detect(
    frame: Uint8Array,
    width: number,
    height: number,
    tStartMs: number,
    predictHint: { x: number; y: number } | null,
  ): Detection {
    const g = this.gather(frame, width, height, predictHint);
    const tInf = nowMs();
    const scores = scoreAll(this.model.net, g.candidates, frame, width, height, this.scores);
    const inferenceMs = nowMs() - tInf;
    const tTemp = nowMs();
    const bank = this.updateBank(g, scores, width, height);
    let probs: ArrayLike<number> | null = null;
    if (bank !== null) {
      const rows = this.featureRows(bank.trackOf);
      const out = new Float32Array(bank.trackOf.length);
      for (let i = 0; i < bank.trackOf.length; i++) {
        out[i] = this.verifier.predict(rows.subarray(i * N_TRACK_FEATURES, (i + 1) * N_TRACK_FEATURES));
      }
      probs = out;
    }
    return this.decide(g, scores, bank, probs, nowMs() - tTemp, inferenceMs, TS_RUNTIME, tStartMs);
  }

  async detectAsync(
    frame: Uint8Array,
    width: number,
    height: number,
    tStartMs: number,
    predictHint: { x: number; y: number } | null,
  ): Promise<Detection> {
    const scorer = this.model.scorer;
    if (!scorer) return this.detect(frame, width, height, tStartMs, predictHint);
    const g = this.gather(frame, width, height, predictHint);
    const tInf = nowMs();
    const scores = await scoreBatchWith(scorer, g.candidates, frame, width, height);
    const inferenceMs = nowMs() - tInf;
    const tTemp = nowMs();
    const bank = this.updateBank(g, scores, width, height);
    let probs: ArrayLike<number> | null = null;
    if (bank !== null) {
      const n = bank.trackOf.length;
      if (n === 0) {
        probs = new Float32Array(0);
      } else if (this.model.batchVerifier) {
        probs = await this.model.batchVerifier.predictBatch(this.featureRows(bank.trackOf), n);
      } else {
        const rows = this.featureRows(bank.trackOf);
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          out[i] = this.verifier.predict(rows.subarray(i * N_TRACK_FEATURES, (i + 1) * N_TRACK_FEATURES));
        }
        probs = out;
      }
    }
    const runtime = this.model.batchVerifier ? scorer.runtime : `${scorer.runtime} + TS verifier`;
    return this.decide(g, scores, bank, probs, nowMs() - tTemp, inferenceMs, runtime, tStartMs);
  }

  // ---- stages ----

  private gather(
    frame: Uint8Array,
    width: number,
    height: number,
    predictHint: { x: number; y: number } | null,
  ): {
    cvCands: BeaconCandidate[];
    aiProps: BeaconCandidate[];
    candidates: BeaconCandidate[];
    cvLatency: number;
    propLatency: number;
    ctx: DetectionContext;
  } {
    this.frameCount++;
    // Branch 1: classical. Branch 2: learned, with its own proposals. Both
    // read the SAME observed frame buffer.
    const tCv = nowMs();
    const cvCands = this.classical.detectCandidates(frame, width, height, MAX_CANDIDATES);
    const cvLatency = nowMs() - tCv;
    const tProp = nowMs();
    const aiProps = this.proposer.propose(frame, width, height);
    const candidates = mergeBranchCandidates(cvCands, aiProps);
    const propLatency = nowMs() - tProp;
    const ctx: DetectionContext =
      this.context.prediction !== null || predictHint === null
        ? this.context
        : { ...this.context, prediction: predictHint };
    return { cvCands, aiProps, candidates, cvLatency, propLatency, ctx };
  }

  private updateBank(
    g: { candidates: BeaconCandidate[]; ctx: DetectionContext },
    scores: ArrayLike<number>,
    width: number,
    height: number,
  ): TrackBankFrame | null {
    if (!g.ctx.pose || g.candidates.length === 0) return null;
    return this.bank.update(
      g.candidates,
      Array.from(scores),
      { ...g.ctx.pose, width, height },
      g.ctx.timestampS ?? this.frameCount / 30,
    );
  }

  private featureRows(tracks: CandidateTrack[]): Float32Array {
    const rows = new Float32Array(Math.max(1, tracks.length) * N_TRACK_FEATURES);
    for (let i = 0; i < tracks.length; i++) {
      CandidateTrackBank.features(tracks[i], this.feat);
      rows.set(this.feat, i * N_TRACK_FEATURES);
    }
    return rows;
  }

  private decide(
    g: {
      cvCands: BeaconCandidate[];
      aiProps: BeaconCandidate[];
      candidates: BeaconCandidate[];
      cvLatency: number;
      propLatency: number;
      ctx: DetectionContext;
    },
    scores: ArrayLike<number>,
    bank: TrackBankFrame | null,
    probs: ArrayLike<number> | null,
    temporalLatency: number,
    inferenceMs: number,
    runtime: string,
    tStartMs: number,
  ): Detection {
    const { cvCands, aiProps, candidates, cvLatency, propLatency, ctx } = g;
    const aiLatency = propLatency + inferenceMs;

    if (candidates.length === 0) {
      this.incumbent = null;
      return emptyDetection('fusion', tStartMs, 0, {
        candidateCount: 0,
        cv: null,
        ai: null,
        spatialAgreementPx: null,
        predictionDistancePx: null,
        chosenBy: 'none',
        aiRejected: 0,
        disagreed: false,
        cvLatencyMs: cvLatency,
        aiLatencyMs: aiLatency,
        fusionLatencyMs: 0,
        aiBranchCount: aiProps.length,
        chosenSource: null,
        trackRejected: 0,
        clutterPoints: this.bank.clutterPoints.length,
        liveTracks: this.bank.liveTracks.length,
        temporalLatencyMs: 0,
        aiRuntime: runtime,
        aiInferenceMs: inferenceMs,
        aiScored: 0,
        decisionReason: 'no candidate from either branch',
      });
    }

    // ---- Temporal verification (Phase 7) ----
    let temporal: Array<TemporalEvidence | null> | null = null;
    let incumbentP: number | null = null;
    if (bank !== null && probs !== null) {
      temporal = bank.trackOf.map((t, i) => {
        t.pBeacon = probs[i];
        return {
          trackId: t.id,
          age: t.age,
          pBeacon: t.pBeacon,
          speedPxS: t.speedPxS,
          onClutter: bank.onClutter[i],
        };
      });
      if (this.incumbentTrackId !== null) {
        const inc = this.bank.liveTracks.find((t) => t.id === this.incumbentTrackId);
        if (inc) incumbentP = inc.pBeacon;
      }
      this.bank.promoteClutter();
    }

    const tFuse = nowMs();
    const scoreArr = Array.from(scores);
    const decision = fuse(candidates, scoreArr, ctx, {
      incumbent: this.incumbent,
      minConfidence: this.minConfidence,
      temporal,
      incumbentP,
    });
    const fusionLatency = nowMs() - tFuse;

    const cvTop = cvCands.length > 0 ? cvCands[0] : null;
    let aiIdx = 0;
    for (let i = 1; i < scoreArr.length; i++) if (scoreArr[i] > scoreArr[aiIdx]) aiIdx = i;
    const aiTop = candidates[aiIdx];

    const chosen = decision.index === null ? null : candidates[decision.index];
    const chosenTv = decision.index === null || temporal === null ? null : temporal[decision.index];
    const chosenVerdict = decision.index === null ? null : decision.verdicts[decision.index];
    const rejectedReasons = decision.verdicts.filter((v) => v.rejected).map((v) => v.rejectReason);
    const provenance: DetectionProvenance = {
      candidateCount: cvCands.length,
      cv: cvTop ? { x: cvTop.x, y: cvTop.y, confidence: cvTop.cvConfidence } : null,
      ai: { x: aiTop.x, y: aiTop.y, confidence: scoreArr[aiIdx] },
      spatialAgreementPx: cvTop ? Math.hypot(cvTop.x - aiTop.x, cvTop.y - aiTop.y) : null,
      predictionDistancePx:
        chosen !== null && ctx.prediction !== null
          ? Math.hypot(chosen.x - ctx.prediction.x, chosen.y - ctx.prediction.y)
          : null,
      chosenBy: decision.chosenBy,
      aiRejected: decision.aiRejected,
      disagreed: decision.disagreed,
      cvLatencyMs: cvLatency,
      aiLatencyMs: aiLatency,
      fusionLatencyMs: fusionLatency,
      aiBranchCount: aiProps.length,
      chosenSource: chosen ? chosen.source ?? 'cv' : null,
      trackId: chosenTv ? chosenTv.trackId : null,
      trackAgeFrames: chosenTv ? chosenTv.age : null,
      trackP: chosenTv ? chosenTv.pBeacon : null,
      trackSpeedPxS: chosenTv ? chosenTv.speedPxS : null,
      trackRejected: decision.trackRejected,
      clutterPoints: this.bank.clutterPoints.length,
      liveTracks: this.bank.liveTracks.length,
      temporalLatencyMs: temporalLatency,
      aiRuntime: runtime,
      aiInferenceMs: inferenceMs,
      aiScored: candidates.length,
      chosenFusionScore: chosenVerdict ? chosenVerdict.fusionScore : null,
      decisionReason:
        chosen === null
          ? rejectedReasons.length > 0
            ? `all rejected — ${rejectedReasons[0]}`
            : 'below cold-search confidence floor'
          : `${decision.chosenBy} of ${candidates.length} (${cvCands.length} CV, ${aiProps.length} AI)` +
            (rejectedReasons.length > 0 ? `; ${rejectedReasons.length} rejected` : ''),
    };

    if (chosen === null) {
      this.incumbent = null;
      return emptyDetection('fusion', tStartMs, decision.confidence, provenance);
    }

    // A deliberate move to a different object while holding a lock is a
    // target switch, not a measurement of the old target.
    const holding = ctx.state === 'TRACK' || ctx.state === 'PREDICT_REACQUIRE';
    const newTarget =
      holding &&
      this.incumbent !== null &&
      chosenTv !== null &&
      this.incumbentTrackId !== null &&
      chosenTv.trackId !== this.incumbentTrackId &&
      Math.hypot(chosen.x - this.incumbent.x, chosen.y - this.incumbent.y) > SWITCH_PX;

    this.incumbent = { x: chosen.x, y: chosen.y };
    this.incumbentTrackId = chosenTv ? chosenTv.trackId : null;
    const det = toDetection('fusion', chosen, decision.confidence, tStartMs, provenance);
    if (newTarget) det.newTarget = true;
    return det;
  }
}
