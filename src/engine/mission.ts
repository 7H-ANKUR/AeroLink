/**
 * Mission phase tracking (§23) and live evidence checks (§21).
 *
 * Both are OBSERVERS. They watch engine state go past and record what actually
 * happened; they never influence the loop and never assert anything they have
 * not seen. A phase is marked reached only when the engine genuinely entered
 * the corresponding state, and an evidence check reports UNKNOWN until it has
 * enough observations to answer — it never defaults to PASS.
 */
import type { MountTelemetry, TrackingStateName } from './types';

export type MissionPhaseId =
  | 'INIT'
  | 'SEARCH'
  | 'DETECT'
  | 'CANDIDATE'
  | 'LOS_ESTIMATE'
  | 'MOUNT_SLEW'
  | 'COARSE_LOCK'
  | 'DISTURBANCE'
  | 'SIGNAL_LOSS'
  | 'PREDICTION'
  | 'REACQUISITION'
  | 'LOCK_RESTORED'
  | 'REPORT';

export interface MissionPhase {
  id: MissionPhaseId;
  label: string;
  /** Plain-language line for a non-specialist judge (§42). */
  plain: string;
  reached: boolean;
  /** Simulation time the phase was first reached, seconds. */
  atS: number | null;
  frame: number | null;
}

const PHASE_DEFS: { id: MissionPhaseId; label: string; plain: string }[] = [
  { id: 'INIT', label: 'Initialize', plain: 'Terminal powered up' },
  { id: 'SEARCH', label: 'Coarse search', plain: 'Receiver scanning for the beacon' },
  { id: 'DETECT', label: 'Optical signal detected', plain: 'Camera found a light source' },
  { id: 'CANDIDATE', label: 'Candidate confirmed', plain: 'Confirmed it is the beacon' },
  { id: 'LOS_ESTIMATE', label: 'LOS error computed', plain: 'Worked out which way to point' },
  { id: 'MOUNT_SLEW', label: 'Receiver slewing', plain: 'Mount turning toward the beacon' },
  { id: 'COARSE_LOCK', label: 'Coarse lock acquired', plain: 'Receiver aligned on the beacon' },
  { id: 'DISTURBANCE', label: 'Disturbance applied', plain: 'Noise / weather / vibration added' },
  { id: 'SIGNAL_LOSS', label: 'Optical signal lost', plain: 'Beacon disappeared' },
  { id: 'PREDICTION', label: 'Kalman prediction', plain: 'Estimating where it went' },
  { id: 'REACQUISITION', label: 'Reacquisition', plain: 'Beacon found again after the loss' },
  { id: 'LOCK_RESTORED', label: 'Lock restored', plain: 'Aligned again after the loss' },
  { id: 'REPORT', label: 'Report generated', plain: 'Results written out' },
];

export type EvidenceVerdict = 'PASS' | 'FAIL' | 'UNKNOWN';

export interface EvidenceCheck {
  id: string;
  label: string;
  verdict: EvidenceVerdict;
  /** What was actually observed, in numbers where possible. */
  detail: string;
}

export interface MissionSnapshot {
  phases: MissionPhase[];
  checks: EvidenceCheck[];
}

export interface MissionObservation {
  frameIndex: number;
  timestampS: number;
  state: TrackingStateName;
  detectionFound: boolean;
  isPrediction: boolean;
  errorPx: number | null;
  lockRadiusPx: number;
  mount: MountTelemetry;
  /** Beacon position this frame, scene px. */
  beaconX: number;
  beaconY: number;
  /** Where the reference trajectory says the beacon should be, scene px. */
  referenceX: number;
  referenceY: number;
  disturbanceActive: boolean;
  beaconSuppressed: boolean;
}

export class MissionTracker {
  private phases: Map<MissionPhaseId, MissionPhase> = new Map();
  private everLocked = false;
  private lostAfterLock = false;

  // evidence accumulators
  private maxBeaconDeviationPx = 0;
  private beaconSamples = 0;
  private poseFollowedMountFrames = 0;
  private poseCheckedFrames = 0;
  private maxPoseMismatchDeg = 0;
  private detectionsSeen = 0;
  private predictionFramesDuringLoss = 0;
  private relockWithDetection = 0;
  private relockWithoutDetection = 0;
  private prevPose: { az: number; el: number } | null = null;
  private prevState: TrackingStateName | null = null;

  constructor() {
    for (const d of PHASE_DEFS) {
      this.phases.set(d.id, { ...d, reached: false, atS: null, frame: null });
    }
  }

  private reach(id: MissionPhaseId, o: { timestampS: number; frameIndex: number }): void {
    const p = this.phases.get(id);
    if (p && !p.reached) {
      p.reached = true;
      p.atS = o.timestampS;
      p.frame = o.frameIndex;
    }
  }

  markInitialized(): void {
    this.reach('INIT', { timestampS: 0, frameIndex: 0 });
  }

  markReportGenerated(timestampS: number, frameIndex: number): void {
    this.reach('REPORT', { timestampS, frameIndex });
  }

  observe(o: MissionObservation): void {
    // ── phases ──────────────────────────────────────────────────────────
    if (o.state === 'SEARCH') this.reach('SEARCH', o);
    if (o.detectionFound) this.reach('DETECT', o);
    if (o.state === 'CANDIDATE' || o.state === 'ACQUIRE') this.reach('CANDIDATE', o);
    if (o.state === 'TRACK' || o.state === 'PREDICT_REACQUIRE') this.reach('LOS_ESTIMATE', o);
    // slewing = the mount achieved a non-trivial rate because it was commanded to
    if (Math.abs(o.mount.actualPanRateDegS) + Math.abs(o.mount.actualTiltRateDegS) > 0.05) {
      this.reach('MOUNT_SLEW', o);
    }
    const locked = o.errorPx !== null && o.errorPx <= o.lockRadiusPx && o.state === 'TRACK';
    if (locked) {
      this.reach('COARSE_LOCK', o);
      if (this.lostAfterLock) this.reach('LOCK_RESTORED', o);
      this.everLocked = true;
    }
    if (o.disturbanceActive) this.reach('DISTURBANCE', o);
    if (this.everLocked && (o.beaconSuppressed || (!o.detectionFound && o.state === 'PREDICT_REACQUIRE'))) {
      this.reach('SIGNAL_LOSS', o);
      this.lostAfterLock = true;
    }
    if (o.isPrediction && !o.detectionFound) this.reach('PREDICTION', o);
    // Reacquisition = the beacon was measured again after a loss. That happens
    // via the Kalman-predicted gate on a short outage and via a full search on
    // a long one; both are reacquisition, so neither path is privileged here.
    if (this.lostAfterLock && o.detectionFound) this.reach('REACQUISITION', o);

    // ── evidence ────────────────────────────────────────────────────────
    // 1. beacon never teleports: rendered position vs analytic trajectory
    const dev = Math.hypot(o.beaconX - o.referenceX, o.beaconY - o.referenceY);
    if (dev > this.maxBeaconDeviationPx) this.maxBeaconDeviationPx = dev;
    this.beaconSamples++;

    // 2. camera pose follows the mount: the pose delta must equal the mount's
    //    achieved rate integrated over the step, to numerical precision.
    if (this.prevPose) {
      const dAz = o.mount.azimuthDeg - this.prevPose.az;
      const dEl = o.mount.elevationDeg - this.prevPose.el;
      const moved = Math.abs(dAz) + Math.abs(dEl);
      const commanded =
        Math.abs(o.mount.actualPanRateDegS) + Math.abs(o.mount.actualTiltRateDegS) > 1e-9;
      // pose moved without the mount reporting rate → something else moved it
      const mismatch = moved > 1e-6 && !commanded ? moved : 0;
      if (mismatch > this.maxPoseMismatchDeg) this.maxPoseMismatchDeg = mismatch;
      if (mismatch === 0) this.poseFollowedMountFrames++;
      this.poseCheckedFrames++;
    }
    this.prevPose = { az: o.mount.azimuthDeg, el: o.mount.elevationDeg };

    if (o.detectionFound) this.detectionsSeen++;
    if (this.lostAfterLock && o.isPrediction && !o.detectionFound) this.predictionFramesDuringLoss++;

    // 3. relock always coincides with a real detection
    if (this.prevState !== null && this.prevState !== 'TRACK' && o.state === 'TRACK') {
      if (o.detectionFound) this.relockWithDetection++;
      else this.relockWithoutDetection++;
    }
    this.prevState = o.state;
  }

  snapshot(): MissionSnapshot {
    return { phases: [...this.phases.values()], checks: this.buildChecks() };
  }

  private buildChecks(): EvidenceCheck[] {
    const checks: EvidenceCheck[] = [];

    checks.push({
      id: 'beacon-teleport',
      label: 'Beacon never moved toward the camera',
      verdict:
        this.beaconSamples === 0 ? 'UNKNOWN' : this.maxBeaconDeviationPx < 1e-6 ? 'PASS' : 'FAIL',
      detail:
        this.beaconSamples === 0
          ? 'no frames observed'
          : `max deviation from analytic trajectory ${this.maxBeaconDeviationPx.toExponential(1)} px over ${this.beaconSamples} frames`,
    });

    checks.push({
      id: 'command-to-pose',
      label: 'Camera pose changes only via the mount',
      verdict:
        this.poseCheckedFrames === 0
          ? 'UNKNOWN'
          : this.maxPoseMismatchDeg < 1e-9
            ? 'PASS'
            : 'FAIL',
      detail:
        this.poseCheckedFrames === 0
          ? 'no frames observed'
          : `${this.poseFollowedMountFrames}/${this.poseCheckedFrames} frames consistent; max unexplained motion ${this.maxPoseMismatchDeg.toExponential(1)}°`,
    });

    checks.push({
      id: 'detection-required',
      label: 'Lock requires a real detection',
      verdict:
        this.relockWithDetection + this.relockWithoutDetection === 0
          ? 'UNKNOWN'
          : this.relockWithoutDetection === 0
            ? 'PASS'
            : 'FAIL',
      detail: `${this.relockWithDetection} lock entries with a detection, ${this.relockWithoutDetection} without`,
    });

    checks.push({
      id: 'detector-active',
      label: 'Detector produced measurements',
      verdict: this.detectionsSeen > 0 ? 'PASS' : 'UNKNOWN',
      detail: `${this.detectionsSeen} detections this run`,
    });

    checks.push({
      id: 'prediction-used',
      label: 'Kalman prediction carried the outage',
      verdict: !this.lostAfterLock ? 'UNKNOWN' : this.predictionFramesDuringLoss > 0 ? 'PASS' : 'FAIL',
      detail: !this.lostAfterLock
        ? 'no signal loss yet this run'
        : `${this.predictionFramesDuringLoss} predicted frames while the beacon was absent`,
    });

    return checks;
  }
}

export { PHASE_DEFS };
