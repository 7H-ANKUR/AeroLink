/**
 * TinyBeaconNet — pure-TypeScript inference for the learned beacon verifier.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY THE NETWORK IS RE-IMPLEMENTED HERE INSTEAD OF LOADED WITH onnxruntime
 *
 * The engine is pure TypeScript with no browser APIs, which is what lets the
 * identical code run in the Web Worker, in `bun test`, and in every headless
 * benchmark script. Pulling in onnxruntime-web would put a WASM blob and a
 * DOM-ish loader in that path and split the shipped detector from the
 * benchmarked one — precisely the divergence SimulationRunner was created to
 * end.
 *
 * The model is deliberately small enough that its forward pass is ~120 lines
 * of array arithmetic, so it is carried here instead. Training happens offline
 * in PyTorch (scripts/ai/train_roi.py); only the learned weights ship, as a
 * flat little-endian Float32 blob plus a JSON manifest.
 *
 * THIS FILE CONTAINS NO LEARNED KNOWLEDGE ON ITS OWN. Without a weights file
 * there is no model, and the detector that uses it reports itself unavailable
 * rather than falling back to something that invents detections.
 *
 * Architecture (mirrored exactly in scripts/ai/train_roi.py):
 *
 *   input            1 x 24 x 24     local-background-subtracted ROI
 *   conv 3x3 pad 1   1 -> 8          ReLU
 *   maxpool 2x2                      -> 8 x 12 x 12
 *   conv 3x3 pad 1   8 -> 12         ReLU
 *   maxpool 2x2                      -> 12 x 6 x 6
 *   conv 3x3 pad 1   12 -> 16        ReLU
 *   global average pool              -> 16
 *   dense            16 -> 16        ReLU
 *   dense            16 -> 1         sigmoid  = P(this ROI is the beacon)
 *
 *   2,989 learned parameters.
 * ────────────────────────────────────────────────────────────────────────
 */

/** ROI side length in px, at native sensor resolution. */
export const PATCH = 24;
/** Border ring width used to estimate local background. */
export const BG_RING = 2;
/** Divisor applied after background subtraction. */
export const SCALE = 128;
export const CLIP_LO = -1;
export const CLIP_HI = 2;

const C1 = 8;
const C2 = 12;
const C3 = 16;
const HIDDEN = 16;

/** Total Float32 values a valid weights blob must contain. */
export const WEIGHT_COUNT =
  C1 * 1 * 9 + C1 + // conv1
  C2 * C1 * 9 + C2 + // conv2
  C3 * C2 * 9 + C3 + // conv3
  HIDDEN * C3 + HIDDEN + // dense1
  1 * HIDDEN + 1; // dense2

/**
 * Local-background-subtracted ROI crop — the TypeScript twin of
 * `crop_patch` + `normalise_patch` in scripts/ai/common.py.
 *
 * The two must agree to the last bit or the model is being shown something it
 * was never trained on; tests/ai-parity.test.ts pins them against a fixture
 * produced by the Python side.
 *
 * Edge behaviour is replication, not zero fill: a beacon clipped at the frame
 * border is a routine reacquisition case, and a hard black edge there would be
 * an artefact the model never saw in training.
 */
export function cropAndNormalise(
  frame: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  out: Float32Array,
  ringScratch: Float32Array,
): void {
  const half = PATCH >> 1;
  const x0 = Math.round(cx) - half;
  const y0 = Math.round(cy) - half;

  for (let py = 0; py < PATCH; py++) {
    let sy = y0 + py;
    sy = sy < 0 ? 0 : sy >= height ? height - 1 : sy;
    const row = sy * width;
    const orow = py * PATCH;
    for (let px = 0; px < PATCH; px++) {
      let sx = x0 + px;
      sx = sx < 0 ? 0 : sx >= width ? width - 1 : sx;
      out[orow + px] = frame[row + sx];
    }
  }

  // Median of the BG_RING-wide border ring. Collected in the same order as
  // numpy's concatenation in common.py — irrelevant to the median itself, but
  // it keeps the two implementations readable side by side.
  let n = 0;
  for (let py = 0; py < BG_RING; py++) {
    for (let px = 0; px < PATCH; px++) ringScratch[n++] = out[py * PATCH + px];
  }
  for (let py = PATCH - BG_RING; py < PATCH; py++) {
    for (let px = 0; px < PATCH; px++) ringScratch[n++] = out[py * PATCH + px];
  }
  for (let py = BG_RING; py < PATCH - BG_RING; py++) {
    for (let px = 0; px < BG_RING; px++) ringScratch[n++] = out[py * PATCH + px];
    for (let px = PATCH - BG_RING; px < PATCH; px++) ringScratch[n++] = out[py * PATCH + px];
  }

  const ring = ringScratch.subarray(0, n);
  ring.sort();
  // numpy.median on an even count averages the two central values.
  const mid = n >> 1;
  const bg = n % 2 === 1 ? ring[mid] : (ring[mid - 1] + ring[mid]) / 2;

  for (let i = 0; i < PATCH * PATCH; i++) {
    const v = (out[i] - bg) / SCALE;
    out[i] = v < CLIP_LO ? CLIP_LO : v > CLIP_HI ? CLIP_HI : v;
  }
}

interface ConvWeights {
  w: Float32Array; // [outC][inC][3][3]
  b: Float32Array;
  inC: number;
  outC: number;
}

/** 3x3 convolution, stride 1, zero padding 1 (PyTorch `padding=1`). */
function conv3x3(
  src: Float32Array,
  dst: Float32Array,
  size: number,
  cw: ConvWeights,
): void {
  const { w, b, inC, outC } = cw;
  const plane = size * size;
  for (let oc = 0; oc < outC; oc++) {
    const obase = oc * plane;
    const bias = b[oc];
    for (let i = 0; i < plane; i++) dst[obase + i] = bias;
    for (let ic = 0; ic < inC; ic++) {
      const ibase = ic * plane;
      const kbase = (oc * inC + ic) * 9;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const k = w[kbase + (ky + 1) * 3 + (kx + 1)];
          if (k === 0) continue;
          const yLo = Math.max(0, -ky);
          const yHi = Math.min(size, size - ky);
          const xLo = Math.max(0, -kx);
          const xHi = Math.min(size, size - kx);
          for (let y = yLo; y < yHi; y++) {
            const orow = obase + y * size;
            const irow = ibase + (y + ky) * size + kx;
            for (let x = xLo; x < xHi; x++) {
              dst[orow + x] += k * src[irow + x];
            }
          }
        }
      }
    }
  }
}

function reluInPlace(a: Float32Array, n: number): void {
  for (let i = 0; i < n; i++) if (a[i] < 0) a[i] = 0;
}

/** 2x2 max pooling, stride 2. */
function maxPool2(src: Float32Array, dst: Float32Array, size: number, channels: number): void {
  const half = size >> 1;
  for (let c = 0; c < channels; c++) {
    const sbase = c * size * size;
    const dbase = c * half * half;
    for (let y = 0; y < half; y++) {
      for (let x = 0; x < half; x++) {
        const s = sbase + (y * 2) * size + x * 2;
        const a = src[s];
        const b = src[s + 1];
        const cc = src[s + size];
        const d = src[s + size + 1];
        let m = a > b ? a : b;
        if (cc > m) m = cc;
        if (d > m) m = d;
        dst[dbase + y * half + x] = m;
      }
    }
  }
}

/**
 * The learned verifier. Construct it from a weights blob; there is no default
 * initialisation, because a randomly initialised network that still answers
 * would be indistinguishable from a trained one to everything downstream.
 */
export class TinyBeaconNet {
  private conv1: ConvWeights;
  private conv2: ConvWeights;
  private conv3: ConvWeights;
  private d1w: Float32Array;
  private d1b: Float32Array;
  private d2w: Float32Array;
  private d2b: number;

  // Pre-allocated scratch: inference must not allocate on the frame path.
  private bufA = new Float32Array(C3 * PATCH * PATCH);
  private bufB = new Float32Array(C3 * PATCH * PATCH);
  private hidden = new Float32Array(HIDDEN);
  private pooled = new Float32Array(C3);
  readonly patchBuf = new Float32Array(PATCH * PATCH);
  readonly ringBuf = new Float32Array(PATCH * PATCH);

  constructor(weights: Float32Array) {
    if (weights.length !== WEIGHT_COUNT) {
      throw new Error(
        `TinyBeaconNet: weights blob has ${weights.length} floats, expected ${WEIGHT_COUNT}. ` +
          'The file does not match this architecture — refusing to run a mismatched model.',
      );
    }
    let o = 0;
    const take = (n: number): Float32Array => {
      const s = weights.subarray(o, o + n);
      o += n;
      return s;
    };
    this.conv1 = { w: take(C1 * 1 * 9), b: take(C1), inC: 1, outC: C1 };
    this.conv2 = { w: take(C2 * C1 * 9), b: take(C2), inC: C1, outC: C2 };
    this.conv3 = { w: take(C3 * C2 * 9), b: take(C3), inC: C2, outC: C3 };
    this.d1w = take(HIDDEN * C3);
    this.d1b = take(HIDDEN);
    this.d2w = take(1 * HIDDEN);
    this.d2b = take(1)[0];
  }

  /**
   * Score one normalised ROI. Returns P(beacon) in [0,1].
   * `patch` must be PATCH*PATCH values produced by `cropAndNormalise`.
   */
  forward(patch: Float32Array): number {
    const a = this.bufA;
    const b = this.bufB;

    // 1 x 24 x 24 -> 8 x 24 x 24 -> pool -> 8 x 12 x 12
    conv3x3(patch, a, PATCH, this.conv1);
    reluInPlace(a, C1 * PATCH * PATCH);
    maxPool2(a, b, PATCH, C1);

    // 8 x 12 x 12 -> 12 x 12 x 12 -> pool -> 12 x 6 x 6
    conv3x3(b, a, 12, this.conv2);
    reluInPlace(a, C2 * 12 * 12);
    maxPool2(a, b, 12, C2);

    // 12 x 6 x 6 -> 16 x 6 x 6
    conv3x3(b, a, 6, this.conv3);
    reluInPlace(a, C3 * 6 * 6);

    // Global average pool
    const pooled = this.pooled;
    for (let c = 0; c < C3; c++) {
      let s = 0;
      const base = c * 36;
      for (let i = 0; i < 36; i++) s += a[base + i];
      pooled[c] = s / 36;
    }

    // Dense 16 -> 16, ReLU
    const h = this.hidden;
    for (let i = 0; i < HIDDEN; i++) {
      let s = this.d1b[i];
      const base = i * C3;
      for (let c = 0; c < C3; c++) s += this.d1w[base + c] * pooled[c];
      h[i] = s > 0 ? s : 0;
    }

    // Dense 16 -> 1, sigmoid
    let z = this.d2b;
    for (let i = 0; i < HIDDEN; i++) z += this.d2w[i] * h[i];
    return 1 / (1 + Math.exp(-z));
  }

  /** Crop, normalise and score in one call. */
  scoreAt(
    frame: Uint8Array,
    width: number,
    height: number,
    cx: number,
    cy: number,
  ): number {
    cropAndNormalise(frame, width, height, cx, cy, this.patchBuf, this.ringBuf);
    return this.forward(this.patchBuf);
  }
}

/**
 * An inference runtime that scores a BATCH of normalised ROIs asynchronously
 * (plan2: ONNX Runtime Web in the browser worker). The engine stays free of
 * I/O and runtime dependencies: the concrete scorer is built at the edge
 * (src/lib/ort-runtime.ts for the worker, scripts/lib/ort-runtime.ts for Bun)
 * and handed in through LoadedModel.
 */
export interface BatchScorer {
  /** e.g. 'onnxruntime-web 1.30.0 (wasm)'. Recorded in provenance. */
  readonly runtime: string;
  /** `patches` holds n * PATCH * PATCH floats; returns n probabilities. */
  scoreBatch(patches: Float32Array, n: number): Promise<Float32Array>;
}

/** Async twin of the track verifier for a runtime backend: n feature rows. */
export interface BatchVerifier {
  readonly runtime: string;
  predictBatch(features: Float32Array, n: number): Promise<Float32Array>;
}

/**
 * Crop + normalise a set of candidate centres into one contiguous batch —
 * the exact preprocessing the TypeScript forward pass uses (cropAndNormalise),
 * so every runtime is fed identical inputs.
 */
export function buildPatchBatch(
  frame: Uint8Array,
  width: number,
  height: number,
  centres: Array<{ x: number; y: number }>,
): Float32Array {
  const P = PATCH * PATCH;
  const buf = new Float32Array(Math.max(1, centres.length) * P);
  const ring = new Float32Array(P);
  const tmp = new Float32Array(P);
  for (let i = 0; i < centres.length; i++) {
    cropAndNormalise(frame, width, height, centres[i].x, centres[i].y, tmp, ring);
    buf.set(tmp, i * P);
  }
  return buf;
}

/** Metadata shipped beside the weights, so a run record can name its model. */
export interface ModelManifest {
  name: string;
  architecture: string;
  paramCount: number;
  patch: number;
  /** Datasets the weights were fitted on, in order. */
  trainedOn: string[];
  /** Measured on the locked test split; see scripts/ai/train_roi.py. */
  metrics: Record<string, number>;
  createdAt: string;
}

/** Decode a little-endian Float32 weights blob. */
export function decodeWeights(bytes: ArrayBuffer | Uint8Array): Float32Array {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.byteLength % 4 !== 0) {
    throw new Error(`weights blob length ${u8.byteLength} is not a multiple of 4`);
  }
  // Copy rather than alias: the source may be a non-aligned slice.
  const out = new Float32Array(u8.byteLength / 4);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

/**
 * MODE 1 — full-frame learned detection (AI plan Phase 12).
 *
 * The plan asks for full-frame detection and ROI verification to be built
 * behind the same interface and BENCHMARKED, not assumed. This is the
 * full-frame arm: TinyBeaconNet applied fully convolutionally to the whole
 * 640x480 frame, with the SAME trained weights.
 *
 * How the ROI network becomes a dense detector:
 *   - the three conv/pool stages run over the whole frame (stride 4 overall);
 *   - the ROI net's global average over its 6x6 conv3 map becomes a sliding
 *     6x6 average over the full conv3 map (stride 1 in feature space, i.e.
 *     every 4 px in the image);
 *   - the two dense layers are applied at every position -> a P(beacon)
 *     heatmap. Cell (i, j) corresponds to a 24x24 window at (4j, 4i).
 *
 * Two approximations, stated rather than hidden: (1) the ROI net subtracts
 * the median of each patch's own border ring; densely that is replaced by a
 * 25x25 local mean, which is not identical; (2) interior windows see real
 * neighbours where the ROI net saw zero padding. So this is the same network,
 * not bit-identical outputs — and its accuracy is measured, not asserted.
 *
 * It is too slow for the 33 ms frame budget on a CPU, which is the finding
 * the benchmark reports; DETECTOR_REGISTRY marks it non-realtime so the live
 * UI does not offer it.
 */
export class FullFrameNet {
  private conv1w: Float32Array;
  private conv1b: Float32Array;
  private conv2w: Float32Array;
  private conv2b: Float32Array;
  private conv3w: Float32Array;
  private conv3b: Float32Array;
  private d1w: Float32Array;
  private d1b: Float32Array;
  private d2w: Float32Array;
  private d2b: number;
  private inBuf: Float32Array;
  private bgBuf: Float32Array;
  private integral: Float64Array;
  private a: Float32Array;
  private b: Float32Array;
  private chanSums: Float64Array[];
  private pooled = new Float32Array(C3);
  private hidden = new Float32Array(HIDDEN);
  readonly w: number;
  readonly h: number;

  constructor(weights: Float32Array, width: number, height: number) {
    if (weights.length !== WEIGHT_COUNT) {
      throw new Error('FullFrameNet: weights blob does not match the architecture');
    }
    let o = 0;
    const take = (n: number): Float32Array => {
      const s = weights.subarray(o, o + n);
      o += n;
      return s;
    };
    this.conv1w = take(C1 * 1 * 9);
    this.conv1b = take(C1);
    this.conv2w = take(C2 * C1 * 9);
    this.conv2b = take(C2);
    this.conv3w = take(C3 * C2 * 9);
    this.conv3b = take(C3);
    this.d1w = take(HIDDEN * C3);
    this.d1b = take(HIDDEN);
    this.d2w = take(HIDDEN);
    this.d2b = take(1)[0];
    this.w = width;
    this.h = height;
    this.inBuf = new Float32Array(width * height);
    this.bgBuf = new Float32Array(width * height);
    this.integral = new Float64Array((width + 1) * (height + 1));
    const maxPlane = Math.max(C1 * width * height, C2 * (width >> 1) * (height >> 1));
    this.a = new Float32Array(maxPlane);
    this.b = new Float32Array(maxPlane);
    const cw = (width >> 2) + 1;
    const chh = (height >> 2) + 1;
    this.chanSums = Array.from({ length: C3 }, () => new Float64Array(cw * chh));
  }

  /** Run the dense network; returns the best window, or null if none clears 0.5. */
  detect(frame: Uint8Array): { x: number; y: number; score: number } | null {
    const { w, h } = this;
    const W1 = w + 1;
    const I = this.integral;
    // Local background: 25x25 mean via summed-area table.
    for (let y = 0; y < h; y++) {
      let rs = 0;
      for (let x = 0; x < w; x++) {
        rs += frame[y * w + x];
        I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + rs;
      }
    }
    const R = 12;
    for (let y = 0; y < h; y++) {
      const y0 = y - R < 0 ? 0 : y - R;
      const y1 = y + R + 1 > h ? h : y + R + 1;
      for (let x = 0; x < w; x++) {
        const x0 = x - R < 0 ? 0 : x - R;
        const x1 = x + R + 1 > w ? w : x + R + 1;
        const s = I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0];
        const bg = s / ((x1 - x0) * (y1 - y0));
        this.bgBuf[y * w + x] = bg;
        const v = (frame[y * w + x] - bg) / SCALE;
        this.inBuf[y * w + x] = v < CLIP_LO ? CLIP_LO : v > CLIP_HI ? CLIP_HI : v;
      }
    }

    convRect(this.inBuf, this.a, w, h, this.conv1w, this.conv1b, 1, C1);
    reluInPlace(this.a, C1 * w * h);
    poolRect(this.a, this.b, w, h, C1);
    const w2 = w >> 1;
    const h2 = h >> 1;
    convRect(this.b, this.a, w2, h2, this.conv2w, this.conv2b, C1, C2);
    reluInPlace(this.a, C2 * w2 * h2);
    poolRect(this.a, this.b, w2, h2, C2);
    const w4 = w2 >> 1;
    const h4 = h2 >> 1;
    convRect(this.b, this.a, w4, h4, this.conv3w, this.conv3b, C2, C3);
    reluInPlace(this.a, C3 * w4 * h4);

    // Sliding 6x6 average per channel via a per-channel summed-area table,
    // then the dense head at every position.
    const outW = w4 - 5;
    const outH = h4 - 5;
    if (outW <= 0 || outH <= 0) return null;
    const CW = w4 + 1;
    const chanSums = this.chanSums;
    for (let c = 0; c < C3; c++) {
      const ci = chanSums[c];
      const base = c * w4 * h4;
      for (let y = 0; y < h4; y++) {
        let rs = 0;
        for (let x = 0; x < w4; x++) {
          rs += this.a[base + y * w4 + x];
          ci[(y + 1) * CW + x + 1] = ci[y * CW + x + 1] + rs;
        }
      }
    }
    let bestZ = -Infinity;
    let bi = 0;
    let bj = 0;
    for (let i = 0; i < outH; i++) {
      for (let j = 0; j < outW; j++) {
        for (let c = 0; c < C3; c++) {
          const ci = chanSums[c];
          const s = ci[(i + 6) * CW + j + 6] - ci[i * CW + j + 6] - ci[(i + 6) * CW + j] + ci[i * CW + j];
          this.pooled[c] = s / 36;
        }
        for (let k = 0; k < HIDDEN; k++) {
          let s = this.d1b[k];
          const base = k * C3;
          for (let c = 0; c < C3; c++) s += this.d1w[base + c] * this.pooled[c];
          this.hidden[k] = s > 0 ? s : 0;
        }
        let z = this.d2b;
        for (let k = 0; k < HIDDEN; k++) z += this.d2w[k] * this.hidden[k];
        if (z > bestZ) {
          bestZ = z;
          bi = i;
          bj = j;
        }
      }
    }
    const score = 1 / (1 + Math.exp(-bestZ));
    if (score < 0.5) return null;

    // Refine around the winning window. The conv stack's receptive field
    // reaches past the 24x24 window, so the winning cell can sit beside the
    // spot rather than on it: search a wider neighbourhood for the brightest
    // local-contrast pixel, then take the weighted centroid of the pixels
    // above half its height within the spot's own 24x24 neighbourhood.
    const cx0 = bj * 4 + PATCH / 2;
    const cy0 = bi * 4 + PATCH / 2;
    const SR = 20;
    let peak = -Infinity;
    let px = cx0;
    let py = cy0;
    for (let y = Math.max(0, cy0 - SR); y < Math.min(h, cy0 + SR); y++) {
      for (let x = Math.max(0, cx0 - SR); x < Math.min(w, cx0 + SR); x++) {
        const v = frame[y * w + x] - this.bgBuf[y * w + x];
        if (v > peak) {
          peak = v;
          px = x;
          py = y;
        }
      }
    }
    const ox = Math.max(0, px - PATCH / 2);
    const oy = Math.max(0, py - PATCH / 2);
    let sw = 0;
    let sx = 0;
    let sy = 0;
    for (let y = oy; y < Math.min(h, oy + PATCH); y++) {
      for (let x = ox; x < Math.min(w, ox + PATCH); x++) {
        const v = frame[y * w + x] - this.bgBuf[y * w + x];
        if (v < peak * 0.5) continue;
        sw += v;
        sx += x * v;
        sy += y * v;
      }
    }
    if (sw <= 0) return { x: px, y: py, score };
    return { x: sx / sw, y: sy / sw, score };
  }
}

/** Rectangular 3x3 convolution, stride 1, zero padding 1. */
function convRect(
  src: Float32Array,
  dst: Float32Array,
  w: number,
  h: number,
  kw: Float32Array,
  kb: Float32Array,
  inC: number,
  outC: number,
): void {
  const plane = w * h;
  for (let oc = 0; oc < outC; oc++) {
    const obase = oc * plane;
    const bias = kb[oc];
    for (let i = 0; i < plane; i++) dst[obase + i] = bias;
    for (let ic = 0; ic < inC; ic++) {
      const ibase = ic * plane;
      const kbase = (oc * inC + ic) * 9;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const k = kw[kbase + (ky + 1) * 3 + (kx + 1)];
          if (k === 0) continue;
          const yLo = Math.max(0, -ky);
          const yHi = Math.min(h, h - ky);
          const xLo = Math.max(0, -kx);
          const xHi = Math.min(w, w - kx);
          for (let y = yLo; y < yHi; y++) {
            const orow = obase + y * w;
            const irow = ibase + (y + ky) * w + kx;
            for (let x = xLo; x < xHi; x++) dst[orow + x] += k * src[irow + x];
          }
        }
      }
    }
  }
}

/** Rectangular 2x2 max pool, stride 2. */
function poolRect(
  src: Float32Array,
  dst: Float32Array,
  w: number,
  h: number,
  channels: number,
): void {
  const w2 = w >> 1;
  const h2 = h >> 1;
  for (let c = 0; c < channels; c++) {
    const sbase = c * w * h;
    const dbase = c * w2 * h2;
    for (let y = 0; y < h2; y++) {
      for (let x = 0; x < w2; x++) {
        const s = sbase + y * 2 * w + x * 2;
        const p = src[s];
        const q = src[s + 1];
        const r = src[s + w];
        const t = src[s + w + 1];
        let m = p > q ? p : q;
        if (r > m) m = r;
        if (t > m) m = t;
        dst[dbase + y * w2 + x] = m;
      }
    }
  }
}
