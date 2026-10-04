/**
 * Kalman filter — constant-velocity model (docs/04 §4.11, docs/MVP-Tech-Doc §12).
 * State x = [px, py, vx, vy]^T
 */
export class Kalman2D {
  // State and covariance
  private s = [0, 0, 0, 0];
  private P: number[][] = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  private q: number;
  private r: number;
  private initialized = false;
  private lastDt = 0;

  constructor(q: number, r: number) {
    this.q = q;
    this.r = r;
  }

  reset(): void {
    this.initialized = false;
    this.lastDt = 0;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  /** Predict one step forward with dt seconds. Returns predicted position. */
  predict(dt: number): { x: number; y: number } {
    if (!this.initialized) {
      return { x: this.s[0], y: this.s[1] };
    }
    const d = dt > 0 ? dt : this.lastDt > 0 ? this.lastDt : 1 / 30;
    const [px, py, vx, vy] = this.s;
    // x' = F x
    this.s[0] = px + vx * d;
    this.s[1] = py + vy * d;
    // P' = F P F^T + Q  (F acts on position/velocity rows)
    const P = this.P;
    const q = this.q;
    const P00 = P[0][0] + d * (P[2][0] + P[0][2]) + d * d * P[2][2] + q;
    const P01 = P[0][1] + d * (P[2][1] + P[0][3]) + d * d * P[2][3];
    const P02 = P[0][2] + d * P[2][2];
    const P03 = P[0][3] + d * P[2][3];
    const P11 = P[1][1] + d * (P[3][1] + P[1][3]) + d * d * P[3][3] + q;
    const P12 = P[1][2] + d * P[3][2];
    const P13 = P[1][3] + d * P[3][3];
    const P22 = P[2][2] + q * 0.5;
    const P33 = P[3][3] + q * 0.5;
    P[0][0] = P00; P[0][1] = P01; P[0][2] = P02; P[0][3] = P03;
    P[1][0] = P01; P[1][1] = P11; P[1][2] = P12; P[1][3] = P13;
    P[2][0] = P02; P[2][1] = P12; P[2][2] = P22; P[2][3] = 0;
    P[3][0] = P03; P[3][1] = P13; P[3][2] = 0; P[3][3] = P33;
    this.lastDt = d;
    return { x: this.s[0], y: this.s[1] };
  }

  /** Measurement update with a detected position. */
  correct(zx: number, zy: number): void {
    if (!this.initialized) {
      this.s[0] = zx;
      this.s[1] = zy;
      this.s[2] = 0;
      this.s[3] = 0;
      this.P = [
        [this.r, 0, 0, 0],
        [0, this.r, 0, 0],
        [0, 0, 25, 0],
        [0, 0, 0, 25],
      ];
      this.initialized = true;
      return;
    }
    // H = [[1,0,0,0],[0,1,0,0]], R = r*I
    const P = this.P;
    const S00 = P[0][0] + this.r;
    const S01 = P[0][1];
    const S10 = P[1][0];
    const S11 = P[1][1] + this.r;
    const det = S00 * S11 - S01 * S10;
    if (det === 0) return;
    const i00 = S11 / det;
    const i01 = -S01 / det;
    const i10 = -S10 / det;
    const i11 = S00 / det;

    const y0 = zx - this.s[0];
    const y1 = zy - this.s[1];

    // K = P H^T S^-1
    const K00 = P[0][0] * i00 + P[0][1] * i10;
    const K01 = P[0][0] * i01 + P[0][1] * i11;
    const K10 = P[1][0] * i00 + P[1][1] * i10;
    const K11 = P[1][0] * i01 + P[1][1] * i11;
    const K20 = P[2][0] * i00 + P[2][1] * i10;
    const K21 = P[2][0] * i01 + P[2][1] * i11;
    const K30 = P[3][0] * i00 + P[3][1] * i10;
    const K31 = P[3][0] * i01 + P[3][1] * i11;

    this.s[0] += K00 * y0 + K01 * y1;
    this.s[1] += K10 * y0 + K11 * y1;
    this.s[2] += K20 * y0 + K21 * y1;
    this.s[3] += K30 * y0 + K31 * y1;

    // P = (I - K H) P
    const nP: number[][] = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          const KHk = k === 0 ? (row === 0 ? K00 : row === 1 ? K10 : row === 2 ? K20 : K30)
                    : k === 1 ? (row === 0 ? K01 : row === 1 ? K11 : row === 2 ? K21 : K31)
                    : 0;
          const ikh = (row === k ? 1 : 0) - KHk;
          sum += ikh * P[k][col];
        }
        nP[row][col] = sum;
      }
    }
    this.P = nP;
  }

  position(): { x: number; y: number } {
    return { x: this.s[0], y: this.s[1] };
  }

  velocity(): { vx: number; vy: number } {
    return { vx: this.s[2], vy: this.s[3] };
  }
}
