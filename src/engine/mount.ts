/**
 * Virtual receiver pan/tilt mount (master prompt §13).
 *
 * Until this module existed the camera pose was driven straight from the
 * controller command: commanded rate and applied rate were the same number,
 * so "the mount responded instantly" and there was nothing to instrument.
 * A real gimbal cannot do that — it has finite angular acceleration, so the
 * actual rate ramps toward the commanded rate and lags it during transients.
 *
 * This class owns that distinction. It is the ONLY thing that moves the
 * camera, so every pose change in the app is traceable to a controller
 * command passing through bounded dynamics:
 *
 *   PID command → rate saturation → acceleration limit → integrate → pose
 *
 * It never sees ground truth. It only sees the command the controller
 * produced and the time step, which is what makes the command→pose evidence
 * check (§21, §39) meaningful rather than decorative.
 */
import type { VirtualCamera } from './camera';
import type { MountTelemetry } from './types';

export type { MountTelemetry };

export class ReceiverMount {
  /** Current achieved rates, deg/s. Persist across frames — this is the
   *  state that makes the mount lag its command. */
  private panRateDegS = 0;
  private tiltRateDegS = 0;
  private maxAccelDegS2: number;

  constructor(maxAccelDegS2: number) {
    this.maxAccelDegS2 = maxAccelDegS2;
  }

  reset(): void {
    this.panRateDegS = 0;
    this.tiltRateDegS = 0;
  }

  get rates(): { pan: number; tilt: number } {
    return { pan: this.panRateDegS, tilt: this.tiltRateDegS };
  }

  /**
   * Advance the mount one step and write the resulting pose into `cam`.
   * Returns full telemetry for the mount panel and the evidence checks.
   */
  step(cam: VirtualCamera, cmdPanDegS: number, cmdTiltDegS: number, dtS: number): MountTelemetry {
    const dt = dtS > 0 ? dtS : 0;

    // 1. Rate saturation — the mount cannot be asked to exceed its maximum.
    const satPan = clampAbs(cmdPanDegS, cam.maxPanSpeedDegS);
    const satTilt = clampAbs(cmdTiltDegS, cam.maxTiltSpeedDegS);
    const rateSaturated =
      Math.abs(cmdPanDegS) > cam.maxPanSpeedDegS + 1e-9 ||
      Math.abs(cmdTiltDegS) > cam.maxTiltSpeedDegS + 1e-9;

    // 2. Acceleration limit — the achieved rate ramps toward the command.
    const dv = this.maxAccelDegS2 * dt;
    const panWant = satPan - this.panRateDegS;
    const tiltWant = satTilt - this.tiltRateDegS;
    const accelLimited = Math.abs(panWant) > dv + 1e-9 || Math.abs(tiltWant) > dv + 1e-9;
    this.panRateDegS += clampAbs(panWant, dv);
    this.tiltRateDegS += clampAbs(tiltWant, dv);

    // 3. Integrate into pose, clamped to mechanical travel.
    const maxPan = (cam.sceneWidth / 2 - cam.resolutionWidth / 2) / cam.pxPerDegX;
    const maxTilt = (cam.sceneHeight / 2 - cam.resolutionHeight / 2) / cam.pxPerDegY;

    const wantPan = cam.pan_deg + this.panRateDegS * dt;
    const wantTilt = cam.tilt_deg + this.tiltRateDegS * dt;
    const nextPan = clamp(wantPan, -maxPan, maxPan);
    const nextTilt = clamp(wantTilt, -maxTilt, maxTilt);
    const travelLimited = Math.abs(wantPan - nextPan) > 1e-9 || Math.abs(wantTilt - nextTilt) > 1e-9;

    // Running into the end stop bleeds off the rate rather than winding it up.
    if (travelLimited) {
      if (nextPan !== wantPan) this.panRateDegS = 0;
      if (nextTilt !== wantTilt) this.tiltRateDegS = 0;
    }

    const actualPan = dt > 0 ? (nextPan - cam.pan_deg) / dt : 0;
    const actualTilt = dt > 0 ? (nextTilt - cam.tilt_deg) / dt : 0;

    cam.pan_deg = nextPan;
    cam.tilt_deg = nextTilt;

    return {
      azimuthDeg: nextPan,
      elevationDeg: nextTilt,
      commandedPanRateDegS: cmdPanDegS,
      commandedTiltRateDegS: cmdTiltDegS,
      actualPanRateDegS: actualPan,
      actualTiltRateDegS: actualTilt,
      rateSaturated,
      accelLimited,
      travelLimited,
      panEffort: Math.min(1, Math.abs(actualPan) / cam.maxPanSpeedDegS),
      tiltEffort: Math.min(1, Math.abs(actualTilt) / cam.maxTiltSpeedDegS),
    };
  }
}

function clampAbs(v: number, max: number): number {
  return v > max ? max : v < -max ? -max : v;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
