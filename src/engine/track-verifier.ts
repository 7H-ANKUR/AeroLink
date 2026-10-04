/**
 * Learned track verifier — P(this candidate track is the beacon)
 * (AI plan Phases 5, 7: "AI confidence + CV confidence + spatial consistency +
 * temporal consistency should determine the decision").
 *
 * ────────────────────────────────────────────────────────────────────────
 * The CNN in nn.ts judges ONE 24x24 crop. It cannot tell a bright decoy from
 * the beacon, because in PS-169 they can look identical in a single frame.
 * This model judges a whole candidate TRACK: its mean CNN score, its mean
 * classical descriptors, how fast it moves in the world once the receiver's
 * own slew is removed, how reliable that motion estimate is, and how
 * persistently it has been seen (features: candidate-tracks.ts).
 *
 * It is a small MLP (8 -> 12 -> 1) trained offline in PyTorch on tracks
 * harvested from the shipped SimulationRunner (scripts/ai/gen-track-dataset.ts,
 * scripts/ai/train_track_verifier.py). Ground truth is used there to LABEL
 * tracks, and nowhere at runtime. Only the weights ship, as JSON; the forward
 * pass below is pinned to PyTorch by tests/ai-parity.test.ts.
 *
 * WHAT IT CAN AND CANNOT KNOW. It learns what the training data shows: in
 * PS-169 the beacon rides a mobile terminal and the decoys are fixed in the
 * world, so world motion is strong evidence. A beacon that is genuinely
 * stationary among equally bright, equally sized stationary decoys is not
 * separable by any of these features — or by anything else in a single
 * wavelength band without modulation. That limit is documented, not hidden.
 * ────────────────────────────────────────────────────────────────────────
 */
import { N_TRACK_FEATURES, TRACK_FEATURES } from './candidate-tracks';

export interface TrackVerifierWeights {
  name: string;
  features: string[];
  /** Input standardisation, fitted on the training split only. */
  mean: number[];
  std: number[];
  hidden: number;
  /** [hidden][features] */
  w1: number[][];
  b1: number[];
  /** [hidden] */
  w2: number[];
  b2: number;
  metrics: Record<string, number>;
  createdAt: string;
}

export class TrackVerifier {
  readonly name: string;
  readonly manifest: TrackVerifierWeights;
  private mean: Float32Array;
  private std: Float32Array;
  private w1: Float32Array;
  private b1: Float32Array;
  private w2: Float32Array;
  private b2: number;
  private hidden: number;
  private hbuf: Float32Array;

  constructor(w: TrackVerifierWeights) {
    if (
      w.features.length !== N_TRACK_FEATURES ||
      w.features.some((f, i) => f !== TRACK_FEATURES[i])
    ) {
      throw new Error(
        `TrackVerifier: weights were trained on features [${w.features.join(', ')}] ` +
          `but the engine produces [${TRACK_FEATURES.join(', ')}]. Refusing to run a mismatched model.`,
      );
    }
    if (w.w1.length !== w.hidden || w.w1.some((r) => r.length !== N_TRACK_FEATURES) || w.w2.length !== w.hidden) {
      throw new Error('TrackVerifier: weight shapes do not match the declared architecture.');
    }
    this.name = w.name;
    this.manifest = w;
    this.hidden = w.hidden;
    this.mean = Float32Array.from(w.mean);
    this.std = Float32Array.from(w.std.map((s) => (s > 1e-6 ? s : 1)));
    this.w1 = Float32Array.from(w.w1.flat());
    this.b1 = Float32Array.from(w.b1);
    this.w2 = Float32Array.from(w.w2);
    this.b2 = w.b2;
    this.hbuf = new Float32Array(w.hidden);
  }

  /** P(beacon) for one feature vector in TRACK_FEATURES order. */
  predict(f: Float32Array): number {
    const H = this.hidden;
    const F = N_TRACK_FEATURES;
    for (let j = 0; j < H; j++) {
      let s = this.b1[j];
      const base = j * F;
      for (let i = 0; i < F; i++) s += this.w1[base + i] * ((f[i] - this.mean[i]) / this.std[i]);
      this.hbuf[j] = s > 0 ? s : 0;
    }
    let z = this.b2;
    for (let j = 0; j < H; j++) z += this.w2[j] * this.hbuf[j];
    return 1 / (1 + Math.exp(-z));
  }
}
