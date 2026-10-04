/**
 * Local-contrast spot proposer — the AI branch's own eyes (AI plan Phases 5, 10).
 *
 * ────────────────────────────────────────────────────────────────────────
 * The plan's architecture has two INDEPENDENT perception branches:
 *
 *        OBSERVED FRAME
 *          │        │
 *   CLASSICAL CV   AI BRANCH
 *          │        │
 *          └─ DECISION ENGINE
 *
 * Before this file existed the "AI" detector only re-scored candidates the
 * classical threshold had already found, so it could never see a beacon the
 * classical stage missed — it was a verifier bolted onto CV, not a branch.
 *
 * This proposer gives the learned branch its own candidate source, with no
 * global threshold at all. It responds to "small and bright RELATIVE TO ITS
 * SURROUNDINGS" (a difference-of-boxes top-hat), which is exactly the
 * operator used to mine the model's training data in scripts/ai/common.py —
 * so at runtime the model is shown the same kind of proposal it was trained
 * to judge. A dim beacon under a fixed threshold, or one spread thin by blur,
 * still produces a local-contrast peak.
 *
 * The proposer decides nothing. It hands over up to N peaks; the CNN scores
 * them; the decision engine arbitrates.
 *
 * No ground truth, no track state, no configuration of the scene: pixels in,
 * peaks out.
 * ────────────────────────────────────────────────────────────────────────
 */
import type { BeaconCandidate } from './detector';

export interface ProposerParams {
  /** Peaks returned per frame, strongest first. Bounds CNN cost. */
  maxProposals: number;
  /** Minimum inner-minus-outer box contrast, grey levels. */
  minContrast: number;
  /** Nominal beacon area, px² — only for the size-affinity feature. */
  expectedBeaconSize: number;
}

/** Inner box (3x3) suppresses single-pixel salt noise; outer box (31x31) is
 *  the local background, wide enough that a 20 px beacon does not raise its
 *  own background to its own level. */
const INNER_R = 1;
const OUTER_R = 15;
/** Non-maximum-suppression radius, px. */
const NMS_R = 10;
/** Half-width of the window a peak is refined in. */
const REFINE_R = 16;
/** Minimum pixels above half-height for a peak to count as a spot. */
const MIN_SPOT_AREA = 3;

export class LocalContrastProposer {
  private params: ProposerParams;
  private integral: Float64Array = new Float64Array(0);
  private resp: Float32Array = new Float32Array(0);
  private w = 0;
  private h = 0;
  private region: Uint8Array = new Uint8Array((2 * REFINE_R + 1) ** 2);
  private stack: Int32Array = new Int32Array((2 * REFINE_R + 1) ** 2);
  private ring: Float32Array = new Float32Array(8 * (REFINE_R + 1));

  constructor(params: ProposerParams) {
    this.params = params;
  }

  updateParams(p: Partial<ProposerParams>): void {
    this.params = { ...this.params, ...p };
  }

  private ensure(w: number, h: number): void {
    if (this.w === w && this.h === h) return;
    this.w = w;
    this.h = h;
    this.integral = new Float64Array((w + 1) * (h + 1));
    this.resp = new Float32Array(w * h);
  }

  /** Mean of the (clamped) box centred on (x, y) with radius r. */
  private boxMean(x: number, y: number, r: number): number {
    const W1 = this.w + 1;
    const x0 = x - r < 0 ? 0 : x - r;
    const y0 = y - r < 0 ? 0 : y - r;
    const x1 = x + r + 1 > this.w ? this.w : x + r + 1;
    const y1 = y + r + 1 > this.h ? this.h : y + r + 1;
    const I = this.integral;
    const s = I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0];
    return s / ((x1 - x0) * (y1 - y0));
  }

  /**
   * Propose spot candidates.
   *
   * Returns BeaconCandidate records so the decision engine can treat both
   * branches' candidates uniformly. `cvConfidence` here is the same composite
   * formula the classical detector uses, computed from THIS branch's own
   * segmentation of the spot — it is a shape/brightness descriptor, not a claim
   * that the classical stage saw it (that is what `source` records).
   */
  propose(frame: Uint8Array, width: number, height: number): BeaconCandidate[] {
    this.ensure(width, height);
    const W1 = width + 1;
    const I = this.integral;

    // Summed-area table.
    for (let y = 0; y < height; y++) {
      let rowSum = 0;
      const row = y * width;
      const iRow = (y + 1) * W1;
      const iPrev = y * W1;
      for (let x = 0; x < width; x++) {
        rowSum += frame[row + x];
        I[iRow + x + 1] = I[iPrev + x + 1] + rowSum;
      }
    }

    // Difference-of-boxes response.
    const resp = this.resp;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        resp[y * width + x] = this.boxMean(x, y, INNER_R) - this.boxMean(x, y, OUTER_R);
      }
    }

    // Local maxima above the contrast floor.
    const minC = this.params.minContrast;
    const peaks: Array<{ x: number; y: number; r: number }> = [];
    for (let y = 1; y < height - 1; y++) {
      const row = y * width;
      for (let x = 1; x < width - 1; x++) {
        const v = resp[row + x];
        if (v < minC) continue;
        if (
          v < resp[row + x - 1] || v < resp[row + x + 1] ||
          v < resp[row - width + x] || v < resp[row + width + x] ||
          v < resp[row - width + x - 1] || v < resp[row - width + x + 1] ||
          v < resp[row + width + x - 1] || v < resp[row + width + x + 1]
        ) continue;
        peaks.push({ x, y, r: v });
      }
    }
    peaks.sort((a, b) => b.r - a.r);

    // Greedy NMS, refining as we go: a peak only counts once it has been
    // segmented into a real spot, so isolated noise pixels cannot crowd a
    // genuine (lower-contrast) spot out of the proposal budget.
    const kept: Array<{ x: number; y: number }> = [];
    const out: BeaconCandidate[] = [];
    const r2 = NMS_R * NMS_R;
    const maxAttempts = this.params.maxProposals * 6;
    let attempts = 0;
    for (const p of peaks) {
      if (out.length >= this.params.maxProposals || attempts >= maxAttempts) break;
      let clash = false;
      for (const k of kept) {
        const dx = k.x - p.x;
        const dy = k.y - p.y;
        if (dx * dx + dy * dy < r2) {
          clash = true;
          break;
        }
      }
      if (clash) continue;
      attempts++;
      const c = this.refine(frame, width, height, p.x, p.y);
      if (c === null) continue;
      kept.push(p);
      out.push(c);
    }
    return out;
  }

  /**
   * Segment the spot around a peak: local background from the median of a
   * ring at REFINE_R, then a 4-connected region of pixels above half the
   * peak's height over that background. Returns the intensity-weighted
   * centroid (weights above background) and the same descriptors the
   * classical detector reports.
   */
  private refine(
    frame: Uint8Array,
    width: number,
    height: number,
    px: number,
    py: number,
  ): BeaconCandidate | null {
    const R = REFINE_R;
    // Ring median for background.
    let n = 0;
    const ring = this.ring;
    for (let d = -R; d <= R; d++) {
      const pts: Array<[number, number]> = [
        [px + d, py - R],
        [px + d, py + R],
      ];
      if (d > -R && d < R) {
        pts.push([px - R, py + d], [px + R, py + d]);
      }
      for (const [x, y] of pts) {
        const cx = x < 0 ? 0 : x >= width ? width - 1 : x;
        const cy = y < 0 ? 0 : y >= height ? height - 1 : y;
        ring[n++] = frame[cy * width + cx];
      }
    }
    const rs = ring.subarray(0, n);
    rs.sort();
    const bg = n % 2 === 1 ? rs[n >> 1] : (rs[(n >> 1) - 1] + rs[n >> 1]) / 2;

    // Peak value near (px, py) — the response peak can sit a pixel off the
    // brightest pixel on a flat-topped spot.
    let peak = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = px + dx;
        const y = py + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const v = frame[y * width + x];
        if (v > peak) peak = v;
      }
    }
    if (peak <= bg) return null;
    const level = bg + 0.5 * (peak - bg);

    const side = 2 * R + 1;
    const region = this.region;
    region.fill(0);
    const stack = this.stack;
    let sp = 0;
    // Seed at the brightest pixel of the 3x3 around the peak.
    let sx = px;
    let sy = py;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = px + dx;
        const y = py + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        if (frame[y * width + x] === peak) {
          sx = x;
          sy = y;
        }
      }
    }
    const lx0 = sx - R;
    const ly0 = sy - R;
    stack[sp++] = R * side + R;
    region[R * side + R] = 1;

    let area = 0;
    let sumW = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let maxI = 0;
    while (sp > 0) {
      const li = stack[--sp];
      const ly = (li / side) | 0;
      const lx = li - ly * side;
      const x = lx0 + lx;
      const y = ly0 + ly;
      const v = frame[y * width + x];
      const wgt = v - bg;
      area++;
      sumW += wgt;
      sumX += x * wgt;
      sumY += y * wgt;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (v > maxI) maxI = v;
      // 4-neighbours inside the window and the frame
      const nbrs = [
        [lx - 1, ly],
        [lx + 1, ly],
        [lx, ly - 1],
        [lx, ly + 1],
      ];
      for (const [nx, ny] of nbrs) {
        if (nx < 0 || ny < 0 || nx >= side || ny >= side) continue;
        const gx = lx0 + nx;
        const gy = ly0 + ny;
        if (gx < 0 || gy < 0 || gx >= width || gy >= height) continue;
        const ni = ny * side + nx;
        if (region[ni] !== 0) continue;
        if (frame[gy * width + gx] < level) continue;
        region[ni] = 1;
        stack[sp++] = ni;
      }
    }
    // An optical spot (PS minimum 5x5 px) covers several pixels above half its
    // height; a single hot pixel (salt noise, a star) does not.
    if (area < MIN_SPOT_AREA || sumW <= 0) return null;

    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const aspect = bw > bh ? bw / bh : bh / bw;
    const sizeScore = sizeAffinity(area, this.params.expectedBeaconSize);
    const shapeScore = 1 / aspect;
    const brightnessScore = maxI / 255;
    const composite = brightnessScore * 0.45 + sizeScore * 0.35 + shapeScore * 0.2;
    return {
      x: sumX / sumW,
      y: sumY / sumW,
      bbox: [minX, minY, bw, bh],
      area,
      maxIntensity: maxI,
      aspect,
      sizeScore,
      shapeScore,
      brightnessScore,
      cvConfidence: composite * 1.25 > 1 ? 1 : composite * 1.25,
      source: 'ai',
    };
  }
}

/** Same size-affinity curve as the classical detector (detector.ts). */
function sizeAffinity(area: number, nominal: number): number {
  const ratio = area / Math.max(1, nominal);
  if (ratio <= 1) return Math.max(0.15, ratio);
  return Math.max(0.1, 1 / ratio);
}
