/**
 * Detector abstraction and registry (master prompt §34, AI plan Phases 5, 8, 10).
 *
 * ────────────────────────────────────────────────────────────────────────
 * Three detectors implement one interface, so the tracker, the controller and
 * the metrics engine downstream are identical in all three configurations and
 * a comparison between them measures perception and nothing else:
 *
 *   cv_classical   threshold -> connected components -> weighted centroid
 *   ai             the learned branch alone: own proposals, scored by a CNN
 *   fusion         both branches + learned temporal verification, arbitrated
 *                  by the decision engine in fusion.ts
 *   ai_fullframe   the CNN applied densely (Mode 1) — benchmark-only
 *
 * THE LEARNED DETECTORS REQUIRE A WEIGHTS FILE AND REFUSE TO RUN WITHOUT ONE.
 *
 * `createDetector('ai', ...)` with no model throws. It does not quietly return
 * the classical detector with an "AI" label attached — that would make every
 * AI claim in the product, the reports and the UI false while still producing
 * plausible-looking numbers, which is the single most damaging thing this file
 * could do. If the model is missing, the product says so.
 *
 * Nothing here ever receives ground truth. `tests/engine-evidence.test.ts`
 * inspects the source of this file and its dependencies and fails if it does.
 * ────────────────────────────────────────────────────────────────────────
 */
import { ClassicalDetector, type DetectorParams } from './detector';
import {
  AiBranchDetector,
  FullFrameAiDetector,
  HybridFusionDetector,
  type LoadedModel,
} from './detector-ai';
import type { DetectionContext } from './fusion';
import type { Detection } from './types';

/** What every detector implementation must satisfy. */
export interface BeaconDetector {
  /** Stable identifier used in run records and the UI. */
  readonly kind: DetectorKindId;
  /** Human label shown in telemetry — never "AI" unless a model really runs. */
  readonly label: string;
  /** True only when the implementation is backed by executable code here. */
  readonly available: boolean;
  /**
   * Detect the beacon in one grayscale frame.
   * `predictHint` is the tracker's current estimate, or null during a cold
   * search. Ground truth is never a parameter and never will be.
   */
  detect(
    frame: Uint8Array,
    width: number,
    height: number,
    tStartMs: number,
    predictHint: { x: number; y: number } | null,
  ): Detection;
  /**
   * Same contract as `detect`, for detectors whose learned stages can run on
   * an asynchronous inference runtime (plan2: ONNX Runtime Web in the worker).
   * Absent on the classical detector, which has no learned stage.
   */
  detectAsync?(
    frame: Uint8Array,
    width: number,
    height: number,
    tStartMs: number,
    predictHint: { x: number; y: number } | null,
  ): Promise<Detection>;
  updateParams?(p: Partial<DetectorParams>): void;
  /**
   * Hand the detector the tracker's own current estimate (AI plan Phase 7).
   *
   * Only the hybrid detector implements this. The value is the system's OWN
   * Kalman state, computed from its own past measurements — using it is
   * tracking. Ground truth is a different thing entirely and is never offered
   * here.
   */
  setContext?(ctx: DetectionContext): void;
}

export type DetectorKindId = 'cv_classical' | 'ai' | 'fusion' | 'ai_fullframe';

/** The classical CV detector — always available, no model required. */
export class ClassicalCVDetector implements BeaconDetector {
  readonly kind = 'cv_classical' as const;
  readonly label = 'CLASSICAL CV';
  readonly available = true;
  private impl: ClassicalDetector;

  constructor(params: DetectorParams) {
    this.impl = new ClassicalDetector(params);
  }

  detect(
    frame: Uint8Array,
    width: number,
    height: number,
    tStartMs: number,
    predictHint: { x: number; y: number } | null,
  ): Detection {
    return this.impl.detect(frame, width, height, tStartMs, predictHint);
  }

  updateParams(p: Partial<DetectorParams>): void {
    this.impl.updateParams(p);
  }
}

export interface DetectorRegistryEntry {
  kind: DetectorKindId;
  label: string;
  /** Whether this kind can run at all in this build. */
  implemented: boolean;
  /** Whether it additionally needs a trained weights file to be present. */
  requiresModel: boolean;
  /**
   * Whether it fits the 30 Hz frame budget. Non-realtime detectors are
   * benchmarked (scripts/eval-detectors.ts) but not offered in the live UI.
   */
  realtime: boolean;
  description: string;
}

export const DETECTOR_REGISTRY: DetectorRegistryEntry[] = [
  {
    kind: 'cv_classical',
    label: 'CLASSICAL CV',
    implemented: true,
    requiresModel: false,
    realtime: true,
    description:
      'Threshold, 4-connectivity labelling, area/aspect filtering and an ' +
      'intensity-weighted centroid. No learned component.',
  },
  {
    kind: 'ai',
    label: 'LEARNED AI BRANCH',
    implemented: true,
    requiresModel: true,
    realtime: true,
    description:
      'The learned branch alone: its own local-contrast proposer (no classical ' +
      'threshold) finds candidate spots and TinyBeaconNet scores a 24x24 crop of ' +
      'each. Trained on the Zenodo laser dataset, fine-tuned on simulator data.',
  },
  {
    kind: 'fusion',
    label: 'HYBRID CV + AI + TEMPORAL',
    implemented: true,
    requiresModel: true,
    realtime: true,
    description:
      'Both branches propose independently; every candidate is scored by the ' +
      'CNN, tracked in world coordinates and judged over time by a learned track ' +
      'verifier, then arbitrated against the Kalman prediction with lock ' +
      'hysteresis and a clutter map of known decoys.',
  },
  {
    kind: 'ai_fullframe',
    label: 'LEARNED FULL-FRAME (MODE 1)',
    implemented: true,
    requiresModel: true,
    realtime: false,
    description:
      'The same network applied densely over the whole frame (plan Phase 12, ' +
      'Mode 1). Benchmarked, but too slow for the 33 ms frame budget on a CPU.',
  },
];

/**
 * Build a detector.
 *
 * `model` may be null only for `cv_classical`. For the learned kinds a null
 * model is an error, not a reason to substitute something else.
 */
export function createDetector(
  kind: DetectorKindId,
  params: DetectorParams,
  model: LoadedModel | null = null,
): BeaconDetector {
  if (kind === 'cv_classical') return new ClassicalCVDetector(params);
  if (model === null) {
    throw new Error(
      `Detector "${kind}" requires a trained model and none was supplied. ` +
        'Run scripts/ai/build_roi_dataset.py then scripts/ai/train_roi.py to ' +
        'produce public/models/beacon-roi-v2.bin, or select the classical ' +
        'detector. This build will not substitute classical CV behind an AI label.',
    );
  }
  if (kind === 'ai') return new AiBranchDetector(params, model);
  if (kind === 'fusion') return new HybridFusionDetector(params, model);
  if (kind === 'ai_fullframe') return new FullFrameAiDetector(params, model);
  throw new Error(`Unknown detector kind "${kind}"`);
}

export function detectorLabel(kind: DetectorKindId): string {
  return DETECTOR_REGISTRY.find((d) => d.kind === kind)?.label ?? kind;
}

export function detectorRequiresModel(kind: DetectorKindId): boolean {
  return DETECTOR_REGISTRY.find((d) => d.kind === kind)?.requiresModel ?? false;
}

export function detectorIsRealtime(kind: DetectorKindId): boolean {
  return DETECTOR_REGISTRY.find((d) => d.kind === kind)?.realtime ?? false;
}
