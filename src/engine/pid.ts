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
export class ScanPattern {
  private phase = 0;
  constructor(
    private pattern: 'raster' | 'spiral',
    private sceneWidth: number,
    private sceneHeight: number,
  ) {}

  /** Scan target in scene px for time dt. */
  step(dtS: number, scale: number): { x: number; y: number } {
    this.phase += dtS * 0.24 * scale;
    const p = this.phase;
    // expanding amplitude: ±25% coverage at start → full scene by ~4 s
    const amp = Math.min(1, 0.25 + p * 0.62);
    const ax = this.sceneWidth * 0.36 * amp;
    const ay = this.sceneHeight * 0.36 * amp;
    if (this.pattern === 'raster') {
      // wide horizontal sweep with slow vertical stepping (raster coverage)
      return {
        x: this.sceneWidth / 2 + ax * Math.sin(p * Math.PI),
        y: this.sceneHeight / 2 + ay * Math.sin(p * Math.PI * 0.11),
      };
    }
    // spiral-ish Lissajous
    return {
      x: this.sceneWidth / 2 + ax * Math.sin(p) * Math.cos(p * 0.21),
      y: this.sceneHeight / 2 + ay * Math.sin(p * 1.31) * Math.cos(p * 0.13),
    };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
