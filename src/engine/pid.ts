/**
 * Coarse camera controller — PID in ANGLE space (docs/04 §4.13 [FIX]).
 *
 * The pixel error is converted to angular error using fov_deg and
 * image_size_px BEFORE the control law — never feed raw pixel error into
 * the PID. Output is a rate command in deg/s.
 *
 * Safety behavior: output saturation at max pan/tilt speed, integral
 * clamping (anti-windup), deadband, integrator reset on SEARCH/ACQUIRE
 * entry, dt=0 handled explicitly.
 */
import type { PanTiltCommand } from './types';

export interface ControllerParams {
  kp: number;
  ki: number;
  kd: number;
  deadbandDeg: number;
  maxPanSpeedDegS: number;
  maxTiltSpeedDegS: number;
  searchPattern: 'raster' | 'spiral';
}

export class PIDAngleController {
  private params: ControllerParams;
  private integPan = 0;
  private integTilt = 0;
  private prevAnglePan: number | null = null;
  private prevAngleTilt: number | null = null;
  private scanPhase = 0;
  private lastUSec = 0;

  constructor(params: ControllerParams) {
    this.params = params;
  }

  resetIntegrator(): void {
    this.integPan = 0;
    this.integTilt = 0;
    this.prevAnglePan = null;
    this.prevAngleTilt = null;
  }

  updateParams(p: Partial<ControllerParams>): void {
    this.params = { ...this.params, ...p };
  }

  /**
   * docs/06 §4 contract. When target_xy is null, emits a scan/search command
   * (never zero — the camera must keep moving during SEARCH).
   */
  compute(
    target_xy: [number, number] | null,
    center_xy: [number, number],
    fov_deg: [number, number],
    image_size_px: [number, number],
    dt_s: number,
    scanSpeedScale = 1,
  ): PanTiltCommand {
    if (target_xy === null) {
      return this.scanCommand(dt_s, scanSpeedScale);
    }

    const [tx, ty] = target_xy;
    const [cx, cy] = center_xy;
    const [fw, fh] = image_size_px;
    const [fovX, fovY] = fov_deg;

    // 1. Image error (pixels)
    const ex = tx - cx;
    const ey = ty - cy;
    // 2. Convert to angular error BEFORE the PID
    const angleX = (ex / fw) * fovX;
    const angleY = (ey / fh) * fovY;

    // deadband around center
    if (Math.abs(angleX) < this.params.deadbandDeg && Math.abs(angleY) < this.params.deadbandDeg) {
      return { pan_deg_s: 0, tilt_deg_s: 0 };
    }

    // 3. PID per axis in angle space; dt=0 → skip derivative/integral update
    const dt = dt_s > 0 ? dt_s : 0;
    const dPan = this.prevAnglePan !== null && dt > 0 ? (angleX - this.prevAnglePan) / dt : 0;
    const dTilt = this.prevAngleTilt !== null && dt > 0 ? (angleY - this.prevAngleTilt) / dt : 0;
    this.prevAnglePan = angleX;
    this.prevAngleTilt = angleY;

    this.integPan = clamp(this.integPan + angleX * dt, -8, 8); // anti-windup clamp
    this.integTilt = clamp(this.integTilt + angleY * dt, -8, 8);

    let uPan = this.params.kp * angleX + this.params.ki * this.integPan + this.params.kd * dPan;
    let uTilt = this.params.kp * angleY + this.params.ki * this.integTilt + this.params.kd * dTilt;

    // 4. Output is directly a deg/s rate command; saturate at configured maxima
    uPan = clamp(uPan, -this.params.maxPanSpeedDegS, this.params.maxPanSpeedDegS);
    uTilt = clamp(uTilt, -this.params.maxTiltSpeedDegS, this.params.maxTiltSpeedDegS);

    this.lastUSec = uPan;
    void this.lastUSec;
    return { pan_deg_s: uPan, tilt_deg_s: uTilt };
  }

  /** Deterministic scan pattern while searching (raster sweep or spiral). */
  private scanCommand(dtS: number, scale: number): PanTiltCommand {
    this.scanPhase += dtS * 0.55 * scale;
    const p = this.scanPhase;
    if (this.params.searchPattern === 'raster') {
      // horizontal sweep with vertical stepping
      const pan = Math.sin(p * Math.PI);
      const tilt = Math.sin(p * Math.PI * 0.18) * 1.4;
      return { pan_deg_s: pan * 3.2 * scale, tilt_deg_s: tilt * 1.2 * scale };
    }
    // spiral scan
    const pan = Math.cos(p * 2.4) * Math.sin(p * 0.5);
    const tilt = Math.sin(p * 2.4) * Math.sin(p * 0.5);
    return { pan_deg_s: pan * 3.0 * scale, tilt_deg_s: tilt * 2.2 * scale };
  }
}

/**
 * Search-strategy helper: produces a scan target (in scene pixels) that
 * follows an EXPANDING Lissajous sweep around the scene center — starts
 * concentrated near the boresight (where a freshly-launched terminal expects
 * the beacon) and grows to full-scene coverage. The controller then PID-drives
 * the camera onto this point, so search speed respects pan/tilt limits.
 */
/**
 * Coarse-acquisition search pattern (master prompt §11).
 *
 * An EXPANDING serpentine raster, centred on wherever the receiver was pointing
 * when the lock dropped. The swept box starts about one field of view wide and
 * grows until it covers the scene.
 *
 * That shape is not decorative — it is what the two failure modes demand, and
 * they demand opposite things:
 *
 *  - A SHORT outage (a blink, a brief occultation) ends with the beacon back
 *    almost exactly where it vanished. A sweep that immediately marches across
 *    the scene abandons it: measured target loss 1.6 % -> 44.6 % on a blinking
 *    beacon when a full-scene raster was used from the first frame.
 *
 *  - A LONG blackout ends with the beacon somewhere else entirely, so the sweep
 *    must eventually cover everything. The previous expanding Lissajous stepped
 *    vertically about nine times slower than horizontally, so it never really
 *    covered the field: a 7 s blackout took 24 s to recover.
 *
 * Starting local and expanding satisfies both, and the motion is bounded by the
 * mount's own slew rate so the camera actually follows the scan point instead
 * of chasing one it can never reach.
 */
export class ScanPattern {
  private travelled = 0;
  private elapsedS = 0;
  private rowPitchPx: number;
  private pointSpeedPxS: number;
  private growthPxS: number;
  private startHalfW: number;
  private startHalfH: number;
  private originX: number;
  private originY: number;

  constructor(
    private pattern: 'raster' | 'spiral',
    private sceneWidth: number,
    private sceneHeight: number,
    opts?: {
      viewportWidthPx?: number;
      viewportHeightPx?: number;
      slewRateDegS?: number;
      pxPerDeg?: number;
      rateFactor?: number;
      /** Seconds for the swept box to grow from one FOV to the whole scene. */
      expandS?: number;
    },
  ) {
    const vw = opts?.viewportWidthPx ?? 640;
    const vh = opts?.viewportHeightPx ?? 480;
    const rate = (opts?.slewRateDegS ?? 5) * (opts?.rateFactor ?? 1);
    const ppd = opts?.pxPerDeg ?? 160;
    // 70 % of viewport height leaves overlap between rows, so a target sitting
    // on a row boundary is not stepped over.
    this.rowPitchPx = Math.max(40, vh * 0.7);
    this.pointSpeedPxS = Math.max(1, rate * ppd);
    // Start tight. A wider opening box sweeps more empty scene before reaching
    // a target that is only just out of view: at 0.6 x viewport the standing
    // integration case (beacon 343 px off-boresight) took 10.4 s to acquire
    // against a 2 s gate; at 0.35 it is found almost immediately and the box
    // still expands to cover the scene for the long-blackout case.
    this.startHalfW = vw * 0.35;
    this.startHalfH = vh * 0.35;
    const expandS = opts?.expandS ?? 12;
    this.growthPxS = Math.max(1, (Math.max(sceneWidth, sceneHeight) / 2) / expandS);
    this.originX = sceneWidth / 2;
    this.originY = sceneHeight / 2;
  }

  /** Start the sweep at a point — normally the boresight on entry to SEARCH. */
  setOrigin(x: number, y: number): void {
    this.originX = x;
    this.originY = y;
    this.travelled = 0;
    this.elapsedS = 0;
  }

  /** Move the sweep centre without restarting the expansion. */
  moveOrigin(x: number, y: number): void {
    this.originX = x;
    this.originY = y;
  }

  /** Back to a cold, scene-centred search. */
  resetOrigin(): void {
    this.setOrigin(this.sceneWidth / 2, this.sceneHeight / 2);
  }

  get origin(): { x: number; y: number } {
    return { x: this.originX, y: this.originY };
  }

  /** Seconds until the swept box reaches the whole scene. */
  get fullCoverageTimeS(): number {
    return Math.max(this.sceneWidth, this.sceneHeight) / 2 / this.growthPxS;
  }

  /** Scan target in scene px after advancing dt seconds. */
  step(dtS: number, scale: number): { x: number; y: number } {
    const k = Math.max(0.05, scale);
    this.elapsedS += dtS;
    this.travelled += dtS * this.pointSpeedPxS * k;

    // box grows from one FOV to the full scene
    const halfW = Math.min(this.sceneWidth / 2, this.startHalfW + this.elapsedS * this.growthPxS);
    const halfH = Math.min(this.sceneHeight / 2, this.startHalfH + this.elapsedS * this.growthPxS);

    const x0 = Math.max(0, this.originX - halfW);
    const x1 = Math.min(this.sceneWidth, this.originX + halfW);
    const y0 = Math.max(0, this.originY - halfH);
    const y1 = Math.min(this.sceneHeight, this.originY + halfH);
    const boxW = Math.max(1, x1 - x0);
    const boxH = Math.max(1, y1 - y0);
    const rows = Math.max(1, Math.ceil(boxH / this.rowPitchPx));

    if (this.pattern === 'spiral') {
      const ang = (this.travelled / Math.max(1, this.pointSpeedPxS)) * 2.2;
      const rad = Math.min(halfW, halfH) * (0.35 + 0.65 * Math.abs(Math.sin(ang * 0.31)));
      return {
        x: clamp(this.originX + Math.cos(ang) * rad, 0, this.sceneWidth),
        y: clamp(this.originY + Math.sin(ang) * rad, 0, this.sceneHeight),
      };
    }

    const total = boxW * rows;
    const along = ((this.travelled % total) + total) % total;
    const row = Math.min(rows - 1, Math.floor(along / boxW));
    const inRow = along - row * boxW;
    // serpentine: alternate rows run the other way so the path is continuous
    const x = row % 2 === 0 ? x0 + inRow : x1 - inRow;
    const y = y0 + (row + 0.5) * (boxH / rows);
    return { x: clamp(x, 0, this.sceneWidth), y: clamp(y, 0, this.sceneHeight) };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
