/**
 * Classical CV beacon detector (docs/04 §4.9, docs/MVP-Tech-Doc §10).
 * Pipeline: grayscale input (already mono) → threshold → connected components
 * → candidate filtering (area / aspect / brightness) → intensity-weighted
 * centroid → composite confidence score.
 *
 * Multi-candidate selection policy (docs/04 §4.9 [NEW]):
 *  - track active  → nearest candidate to predicted position (gated)
 *  - no track      → highest composite score
 * The selection policy is honored by the pipeline via `predictHint`.
 */
import type { Detection } from './types';

export interface DetectorParams {
  threshold: number;
  minAreaPx: number;
  maxAreaPx: number;
  expectedBeaconSize: number; // nominal spot size in px
  /** Composite-confidence floor; weaker candidates are rejected (§8). */
  minConfidence: number;
}

/**
 * One optical spot proposed by the classical stage, with the component
 * statistics the decision engine and the learned detector both need.
 * Purely an observation — nothing here is derived from ground truth.
 */
export interface BeaconCandidate {
  /** Intensity-weighted centroid, image space. */
  x: number;
  y: number;
  bbox: [number, number, number, number];
  area: number;
  maxIntensity: number;
  /** Long side / short side, >= 1. */
  aspect: number;
  sizeScore: number;
  shapeScore: number;
  brightnessScore: number;
  /** Composite classical confidence, ungated by any temporal term. */
  cvConfidence: number;
  /**
   * Which perception branch proposed this spot (AI plan Phase 5): the
   * classical threshold stage, the learned branch's local-contrast proposer,
   * or both (the same spot found independently by each).
   */
  source?: 'cv' | 'ai' | 'both';
}

interface Component {
  area: number;
  sumX: number;
  sumY: number;
  sumW: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  maxIntensity: number;
}

const ALLOWED_METHOD = 'cv' as const;

export class ClassicalDetector {
  private params: DetectorParams;
  private labels: Int32Array = new Int32Array(0);
  private labelW = 0;
  private labelH = 0;
  private stack: Int32Array = new Int32Array(0);

  constructor(params: DetectorParams) {
    this.params = params;
  }

  updateParams(p: Partial<DetectorParams>): void {
    this.params = { ...this.params, ...p };
  }

  detect(
    frame: Uint8Array,
    width: number,
    height: number,
    tStartMs: number,
    predictHint: { x: number; y: number } | null,
  ): Detection {
    const components = this.extractComponents(frame, width, height);

    if (components.length === 0) {
      return {
        found: false,
        x: null,
        y: null,
        confidence: 0,
        bbox: null,
        method: ALLOWED_METHOD,
        latency_ms: nowMs() - tStartMs,
      };
    }

    // Candidate scoring: brightness x size x shape (+ temporal proximity gate)
    let best: Component | null = null;
    let bestScore = -1;
    for (const c of components) {
      const w = c.maxX - c.minX + 1;
      const h = c.maxY - c.minY + 1;
      const aspect = w > h ? w / h : h / w;
      const sizeScore = sizeAffinity(c.area, this.params.expectedBeaconSize);
      const shapeScore = 1 / aspect; // square-ish spots preferred (PS default square)
      const brightnessScore = c.maxIntensity / 255;
      // brightness-weighted: the optical beacon is by far the brightest
      // object in the frame — a dim decoy must never outrank it
      let score = brightnessScore * 0.45 + sizeScore * 0.35 + shapeScore * 0.2;
      if (predictHint) {
        const cx = c.sumX / c.sumW;
        const cy = c.sumY / c.sumW;
        const dist = Math.hypot(cx - predictHint.x, cy - predictHint.y);
        const gate = dist < 60 ? 1 : dist < 140 ? 0.4 : 0.05; // sticky-track gating
        score *= gate;
      }
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }

    const c = best as Component;
    const bestConfidence = clamp01(bestScore * 1.25);
    // Confidence floor — COLD SEARCH ONLY.
    //
    // With no active track, a weak candidate is almost certainly clutter (a
    // rain streak, a noise blob), and accepting it makes the tracker lock onto
    // junk while the beacon is out of frame.
    //
    // With a prediction hint, temporal consistency is itself evidence (§8:
    // "when locked, prefer candidates consistent with predicted position"), and
    // the floor must NOT apply: a beacon clipped at the frame edge scores low
    // on size affinity, and rejecting it blocks reacquisition. Measured: the
    // floor applied unconditionally drove blink-scenario target loss from
    // 1.56 % to 61.7 %.
    if (predictHint === null && bestConfidence < this.params.minConfidence) {
      return {
        found: false,
        x: null,
        y: null,
        confidence: bestConfidence,
        bbox: null,
        method: ALLOWED_METHOD,
        latency_ms: nowMs() - tStartMs,
      };
    }
    // Intensity-weighted centroid (docs/04 §4.10 — the PS evaluates
    // "centroiding error" specifically, so we use the weighted centroid).
    const cx = c.sumX / c.sumW;
    const cy = c.sumY / c.sumW;
    const confidence = bestConfidence;

    return {
      found: true,
      x: cx,
      y: cy,
      confidence,
      bbox: [c.minX, c.minY, c.maxX - c.minX + 1, c.maxY - c.minY + 1],
      method: ALLOWED_METHOD,
      latency_ms: nowMs() - tStartMs,
    };
  }
  /**
   * Connected-component extraction, shared by `detect()` and
   * `detectCandidates()`. 4-connectivity, iterative flood fill — no recursion,
   * bounded memory. Only components inside the area window survive.
   */
  private extractComponents(frame: Uint8Array, width: number, height: number): Component[] {
    const { threshold, minAreaPx, maxAreaPx } = this.params;
    const n = width * height;
    if (this.labelW !== width || this.labelH !== height) {
      this.labels = new Int32Array(n);
      this.labelW = width;
      this.labelH = height;
      this.stack = new Int32Array(n);
    } else {
      this.labels.fill(0);
    }

    const labels = this.labels;
    const stack = this.stack;
    const components: Component[] = [];
    let nextLabel = 1;

    for (let i = 0; i < n; i++) {
      if (frame[i] < threshold || labels[i] !== 0) continue;
      const comp: Component = {
        area: 0,
        sumX: 0,
        sumY: 0,
        sumW: 0,
        minX: width,
        minY: height,
        maxX: 0,
        maxY: 0,
        maxIntensity: 0,
      };
      let sp = 0;
      stack[sp++] = i;
      labels[i] = nextLabel;
      while (sp > 0) {
        const idx = stack[--sp];
        const y = (idx / width) | 0;
        const x = idx - y * width;
        const v = frame[idx];
        comp.area++;
        comp.sumX += x * v;
        comp.sumY += y * v;
        comp.sumW += v;
        if (v > comp.maxIntensity) comp.maxIntensity = v;
        if (x < comp.minX) comp.minX = x;
        if (x > comp.maxX) comp.maxX = x;
        if (y < comp.minY) comp.minY = y;
        if (y > comp.maxY) comp.maxY = y;
        // 4-neighbours
        if (x > 0) {
          const l = idx - 1;
          if (frame[l] >= threshold && labels[l] === 0) {
            labels[l] = nextLabel;
            stack[sp++] = l;
          }
        }
        if (x < width - 1) {
          const r = idx + 1;
          if (frame[r] >= threshold && labels[r] === 0) {
            labels[r] = nextLabel;
            stack[sp++] = r;
          }
        }
        if (y > 0) {
          const u = idx - width;
          if (frame[u] >= threshold && labels[u] === 0) {
            labels[u] = nextLabel;
            stack[sp++] = u;
          }
        }
        if (y < height - 1) {
          const d = idx + width;
          if (frame[d] >= threshold && labels[d] === 0) {
            labels[d] = nextLabel;
            stack[sp++] = d;
          }
        }
      }
      nextLabel++;
      if (comp.area >= minAreaPx && comp.area <= maxAreaPx) {
        components.push(comp);
      }
    }
    return components;
  }

  /**
   * Multi-candidate output — the CV half of the hybrid detector.
   *
   * `detect()` collapses the component list to a single answer because the
   * classical pipeline has to commit. The fusion engine must NOT: it needs
   * every plausible optical spot so the learned model can score each one and
   * the decision engine can weigh them against the Kalman prediction.
   *
   * The scores here are deliberately UNGATED — no `predictHint` term is
   * applied. Temporal reasoning belongs to the decision engine (fusion.ts),
   * which has the track state and the lock hysteresis; baking a proximity
   * multiplier in here would apply it twice.
   *
   * Ground truth is not a parameter and never will be.
   */
  detectCandidates(
    frame: Uint8Array,
    width: number,
    height: number,
    maxCandidates = 12,
  ): BeaconCandidate[] {
    const components = this.extractComponents(frame, width, height);
    const out: BeaconCandidate[] = [];
    for (const c of components) {
      const w = c.maxX - c.minX + 1;
      const h = c.maxY - c.minY + 1;
      const aspect = w > h ? w / h : h / w;
      const sizeScore = sizeAffinity(c.area, this.params.expectedBeaconSize);
      const shapeScore = 1 / aspect;
      const brightnessScore = c.maxIntensity / 255;
      const composite = brightnessScore * 0.45 + sizeScore * 0.35 + shapeScore * 0.2;
      out.push({
        x: c.sumX / c.sumW,
        y: c.sumY / c.sumW,
        bbox: [c.minX, c.minY, w, h],
        area: c.area,
        maxIntensity: c.maxIntensity,
        aspect,
        sizeScore,
        shapeScore,
        brightnessScore,
        cvConfidence: clamp01(composite * 1.25),
        source: 'cv',
      });
    }
    out.sort((a, b) => b.cvConfidence - a.cvConfidence);
    return out.length > maxCandidates ? out.slice(0, maxCandidates) : out;
  }

}

function sizeAffinity(area: number, nominal: number): number {
  const ratio = area / Math.max(1, nominal);
  // 1.0 at nominal size, decaying for larger deviations
  if (ratio <= 1) return Math.max(0.15, ratio);
  return Math.max(0.1, 1 / ratio);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
