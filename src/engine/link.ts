/**
 * SIMULATED optical link quality (master prompt §20).
 *
 * ────────────────────────────────────────────────────────────────────────
 * THIS IS A MODEL, NOT A MEASUREMENT.
 *
 * No photodetector, laser, telescope or optical bench exists anywhere in this
 * project. Nothing here is a received optical power. What this module does is
 * answer one question: GIVEN the pointing error the tracker is actually
 * achieving, what would a coarse optical link plausibly look like?
 *
 * Its purpose is to show the downstream consequence of coarse alignment —
 * point the receiver well and the link becomes available; lose the beacon and
 * it drops — so the tracking result reads as a system outcome rather than a
 * number. Every value it produces must be labelled "simulated" in the UI.
 * ────────────────────────────────────────────────────────────────────────
 *
 * Pointing loss uses the standard Gaussian-beam approximation
 *
 *     L(θ) = exp(−2 θ² / θ_div²)          →   L_dB = −10 log10 L(θ)
 *
 * with θ the boresight error and θ_div the assumed beam divergence half-angle.
 * Atmospheric attenuation is a fixed per-condition allowance, in the range
 * normally quoted for short terrestrial FSO paths.
 */
import type { AtmosphereMode } from './types';

export type LinkState = 'IDLE' | 'ACQUIRING' | 'DEGRADED' | 'ACQUIRED' | 'LOST';

export interface LinkTelemetry {
  /** Always true — this is a model. Consumers must label it. */
  simulated: true;
  state: LinkState;
  beaconDetected: boolean;
  /** Boresight error driving the model, degrees (null when not tracking). */
  boresightErrorDeg: number | null;
  atmosphere: AtmosphereMode;
  /** Normalised link quality 0..100, after pointing and atmospheric losses. */
  signalLevelPercent: number;
  pointingLossDb: number;
  atmosphericLossDb: number;
  /** Margin over the demodulation threshold. Negative = link unavailable. */
  linkMarginDb: number;
}

/** Assumed beam divergence half-angle, degrees (IMPL). A coarse-alignment
 *  stage hands over to fine pointing well before a real comms beam width; this
 *  value is chosen so the link degrades across the same angular range the
 *  coarse loop works in. */
const BEAM_DIVERGENCE_DEG = 0.35;

/** Link budget constants (IMPL, dB). */
const TRANSMIT_MARGIN_DB = 22; // clear-air margin over threshold at perfect pointing
const THRESHOLD_DB = 0; // demodulation threshold reference

/** Atmospheric allowance per condition (dB) — fixed per-mode, not measured. */
const ATMOSPHERIC_LOSS_DB: Record<AtmosphereMode, number> = {
  clear: 0.4,
  haze: 3.2,
  fog: 9.5,
  rain: 6.0,
  low_light: 0.8,
};

export interface LinkInput {
  /** Is the detector currently seeing the beacon? */
  beaconDetected: boolean;
  /** Pointing error in pixels (null when there is no estimate). */
  pointingErrorPx: number | null;
  /** Sensor geometry, to convert px → degrees. */
  imageWidthPx: number;
  fovXDeg: number;
  atmosphere: AtmosphereMode;
  /** Tracking state, so the link can distinguish acquiring from locked. */
  tracking: boolean;
  locked: boolean;
}

export function computeLink(i: LinkInput): LinkTelemetry {
  const atmosphericLossDb = ATMOSPHERIC_LOSS_DB[i.atmosphere] ?? 0.4;

  // No estimate at all → the link simply does not exist yet.
  if (i.pointingErrorPx === null || !i.tracking) {
    return {
      simulated: true,
      state: i.beaconDetected ? 'ACQUIRING' : 'IDLE',
      beaconDetected: i.beaconDetected,
      boresightErrorDeg: null,
      atmosphere: i.atmosphere,
      signalLevelPercent: 0,
      pointingLossDb: 99,
      atmosphericLossDb,
      linkMarginDb: -99,
    };
  }

  // px → degrees, the same conversion the controller uses (docs/04 §4.13)
  const thetaDeg = (i.pointingErrorPx / i.imageWidthPx) * i.fovXDeg;

  // Gaussian-beam pointing loss
  const ratio = thetaDeg / BEAM_DIVERGENCE_DEG;
  const couplingEfficiency = Math.exp(-2 * ratio * ratio);
  const pointingLossDb = -10 * Math.log10(Math.max(couplingEfficiency, 1e-12));

  const linkMarginDb = TRANSMIT_MARGIN_DB - pointingLossDb - atmosphericLossDb - THRESHOLD_DB;

  // Signal level: coupling efficiency scaled by the atmospheric allowance.
  const atmosphericTransmission = Math.pow(10, -atmosphericLossDb / 10);
  const signalLevelPercent = clamp(couplingEfficiency * atmosphericTransmission * 100, 0, 100);

  let state: LinkState;
  if (!i.beaconDetected && !i.locked) state = 'LOST';
  else if (linkMarginDb <= 0) state = 'LOST';
  else if (i.locked && linkMarginDb > 6) state = 'ACQUIRED';
  else if (linkMarginDb > 0) state = 'DEGRADED';
  else state = 'ACQUIRING';

  return {
    simulated: true,
    state,
    beaconDetected: i.beaconDetected,
    boresightErrorDeg: thetaDeg,
    atmosphere: i.atmosphere,
    signalLevelPercent: round2(signalLevelPercent),
    pointingLossDb: round2(Math.min(pointingLossDb, 99)),
    atmosphericLossDb: round2(atmosphericLossDb),
    linkMarginDb: round2(Math.max(linkMarginDb, -99)),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
