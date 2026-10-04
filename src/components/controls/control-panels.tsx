'use client';

/**
 * Left control panels (docs/Frontend-Design §10, §11; docs/03 §2 Parameter
 * Panel tabs). Compact engineering controls — numeric steppers, not giant
 * sliders. Fields lock during a run (docs/03 §3). Validation errors surface
 * inline on the offending field (docs/03 §7).
 */
import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { modelManifest, verifierAvailable } from '@/lib/load-model';
import type { ModelManifest } from '@/engine/nn';
import type { DetectorKind } from '@/engine/types';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useFsoc } from '@/lib/store';
import { atmosphereLabel, detectorLabel, motionLabel, platformLabel, searchLabel } from '@/engine/config';
import type { ScenarioConfig } from '@/engine/config';

// ---------- primitives ----------

export function NumField({
  label,
  hint,
  value,
  onChange,
  step = 1,
  min,
  max,
  unit,
  disabled,
  official,
  error,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  disabled?: boolean;
  official?: boolean;
  error?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <Label className="text-[11px] text-fsoc-text2 font-normal" title={hint}>
          {label}
          {official && (
            <span className="ml-1.5 text-[8px] px-1 py-px rounded border border-fsoc-border2 text-fsoc-text3 align-middle" title="Official PS-169 default">
              PS
            </span>
          )}
        </Label>
        {error && <div className="text-[10px] text-fsoc-danger">{error}</div>}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Input
          type="number"
          className="h-7 w-[72px] text-[11px] tnum bg-fsoc-bg0 border-fsoc-border1"
          value={Number.isFinite(value) ? value : ''}
          step={step}
          min={min}
          max={max}
          disabled={disabled}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) onChange(v);
          }}
        />
        {unit && <span className="text-[10px] text-fsoc-text3 w-8">{unit}</span>}
      </div>
    </div>
  );
}

function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="panel">
      <button
        className="w-full flex items-center justify-between px-3 py-2 text-left"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="panel-title">{title}</span>
        <ChevronDown className={`w-3.5 h-3.5 text-fsoc-text3 transition-transform duration-150 ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && <div className="px-3 pb-3 pt-0.5 space-y-2.5">{children}</div>}
    </div>
  );
}

// ---------- main panel ----------

export function ControlPanels() {
  const config = useFsoc((s) => s.config);
  const setConfig = useFsoc((s) => s.setConfig);
  const locked = useFsoc((s) => s.configLocked);
  const errors = useFsoc((s) => s.configErrors);
  const errFor = (path: string) => errors.find((e) => e.path.endsWith(path))?.message;

  const patch = (fn: (draft: ScenarioConfig) => void) => {
    const draft = structuredClone(config);
    fn(draft);
    setConfig(draft);
  };

  const d = locked;

  return (
    <div className="h-full overflow-y-auto pr-1 space-y-2.5">
      <Section title="Scenario">
        <NumField label="Seed" hint="Deterministic run seed" value={config.seed} onChange={(v) => patch((c) => { c.seed = Math.floor(v); })} disabled={d} error={errFor('seed')} />
        <NumField label="Duration" value={config.durationS} onChange={(v) => patch((c) => { c.durationS = v; })} min={5} max={600} unit="s" disabled={d} error={errFor('durationS')} />
        <NumField label="Distractors" hint="Static decoy bright spots in the scene" value={config.scene.distractorCount} onChange={(v) => patch((c) => { c.scene.distractorCount = Math.floor(v); })} min={0} max={12} disabled={d} />
        <div className="flex items-center justify-between gap-2">
          <Label className="text-[11px] text-fsoc-text2 font-normal">Motion</Label>
          <Select value={config.beacon.motion} onValueChange={(v) => patch((c) => { c.beacon.motion = v as ScenarioConfig['beacon']['motion']; })} disabled={d}>
            <SelectTrigger className="h-7 w-[128px] text-[11px] bg-fsoc-bg0 border-fsoc-border1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-fsoc-bg2 border-fsoc-border2 text-[11px]">
              {(['straight', 'circular', 'figure8', 'random', 'spiral', 'sinusoidal'] as const).map((m) => (
                <SelectItem key={m} value={m}>{motionLabel(m)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </Section>

      <Section title="Camera">
        <NumField label="Resolution" official value={config.camera.resolutionWidth} onChange={(v) => patch((c) => { c.camera.resolutionWidth = Math.floor(v); })} unit="px" disabled={d} error={errFor('resolutionWidth')} />
        <NumField label="Height" official value={config.camera.resolutionHeight} onChange={(v) => patch((c) => { c.camera.resolutionHeight = Math.floor(v); })} unit="px" disabled={d} />
        <NumField label="FOV ×" official hint="Horizontal field of view — PS default 4.0°" value={config.camera.fovXDeg} onChange={(v) => patch((c) => { c.camera.fovXDeg = v; })} step={0.5} unit="°" disabled={d} error={errFor('fovXDeg')} />
        <NumField label="FOV Y" official hint="Vertical field of view — PS default 3.0°" value={config.camera.fovYDeg} onChange={(v) => patch((c) => { c.camera.fovYDeg = v; })} step={0.5} unit="°" disabled={d} />
        <NumField label="Update rate" official hint="PS minimum 30 Hz" value={config.camera.updateHz} onChange={(v) => patch((c) => { c.camera.updateHz = Math.floor(v); })} unit="Hz" disabled={d} />
        <NumField label="Max pan" official value={config.camera.maxPanSpeedDegS} onChange={(v) => patch((c) => { c.camera.maxPanSpeedDegS = v; })} step={0.5} unit="°/s" disabled={d} />
        <NumField label="Max tilt" official value={config.camera.maxTiltSpeedDegS} onChange={(v) => patch((c) => { c.camera.maxTiltSpeedDegS = v; })} step={0.5} unit="°/s" disabled={d} />
      </Section>

      <Section title="Beacon">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-[11px] text-fsoc-text2 font-normal">Shape</Label>
          <Select value={config.beacon.shape} onValueChange={(v) => patch((c) => { c.beacon.shape = v as ScenarioConfig['beacon']['shape']; })} disabled={d}>
            <SelectTrigger className="h-7 w-[128px] text-[11px] bg-fsoc-bg0 border-fsoc-border1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-fsoc-bg2 border-fsoc-border2 text-[11px]">
              {(['square', 'circle'] as const).map((sh) => (
                <SelectItem key={sh} value={sh}>{sh === 'square' ? 'Square' : 'Circle'}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <NumField label="Size" official hint="PS row 10: 5–20 px, default 10×10" value={config.beacon.sizePx} onChange={(v) => patch((c) => { c.beacon.sizePx = Math.floor(v); })} min={5} max={20} unit="px" disabled={d} error={errFor('sizePx')} />
        <NumField label="Intensity" value={config.beacon.intensity} onChange={(v) => patch((c) => { c.beacon.intensity = v; })} step={0.05} min={0.2} max={1} disabled={d} />
        <NumField label="Speed" hint="Trajectory speed multiplier" value={config.beacon.speed} onChange={(v) => patch((c) => { c.beacon.speed = v; })} step={0.1} disabled={d} />
        <NumField label="Blink period" hint="Beacon disappears briefly every N s (loss demo). 0 = never" value={config.beacon.blinkPeriodS} onChange={(v) => patch((c) => { c.beacon.blinkPeriodS = v; })} step={1} min={0} unit="s" disabled={d} />
      </Section>

      <Section title="Disturbance" defaultOpen={false}>
        <NumField label="Salt & pepper" official hint="PS suggests 10% option" value={config.noise.saltPepperPercent} onChange={(v) => patch((c) => { c.noise.saltPepperPercent = v; })} unit="%" disabled={d} />
        <NumField label="Gaussian σ" official hint="PS max std-dev 20" value={config.noise.gaussianSigma} onChange={(v) => patch((c) => { c.noise.gaussianSigma = v; })} unit="" disabled={d} />
        <NumField label="Optical blur" hint="PSF Gaussian σ applied to every spot (defocus / turbulence). 0 = ideal optics" value={config.beacon.blurSigmaPx ?? 0} onChange={(v) => patch((c) => { c.beacon.blurSigmaPx = v; })} step={0.25} min={0} max={4} unit="px" disabled={d} />
        <NumField label="Exposure" hint="Sensor exposure time — motion during it smears the beacon and, while slewing, the whole scene. 0 = no motion blur" value={config.camera.exposureMs ?? 0} onChange={(v) => patch((c) => { c.camera.exposureMs = v; })} step={1} min={0} max={33} unit="ms" disabled={d} />
        <div className="flex items-center justify-between">
          <Label className="text-[11px] text-fsoc-text2 font-normal">Poisson</Label>
          <Switch checked={config.noise.poissonEnabled} onCheckedChange={(v) => patch((c) => { c.noise.poissonEnabled = v; })} disabled={d} />
        </div>
        <div className="flex items-center justify-between">
          <Label className="text-[11px] text-fsoc-text2 font-normal">Jitter</Label>
          <Switch checked={config.jitter.enabled} onCheckedChange={(v) => patch((c) => { c.jitter.enabled = v; })} disabled={d} />
        </div>
        <NumField label="Jitter max" official hint="PS max ±20 px/frame" value={config.jitter.maxPxPerFrame} onChange={(v) => patch((c) => { c.jitter.maxPxPerFrame = v; })} unit="px/f" disabled={d} />
        <div className="flex items-center justify-between gap-2">
          <Label className="text-[11px] text-fsoc-text2 font-normal">Atmosphere</Label>
          <Select value={config.atmosphere.mode} onValueChange={(v) => patch((c) => { c.atmosphere.mode = v as ScenarioConfig['atmosphere']['mode']; })} disabled={d}>
            <SelectTrigger className="h-7 w-[128px] text-[11px] bg-fsoc-bg0 border-fsoc-border1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-fsoc-bg2 border-fsoc-border2 text-[11px]">
              {(['clear', 'haze', 'fog', 'rain', 'low_light'] as const).map((m) => (
                <SelectItem key={m} value={m}>{atmosphereLabel(m)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between gap-2">
          <Label className="text-[11px] text-fsoc-text2 font-normal">Platform</Label>
          <Select value={config.platformMotion.mode} onValueChange={(v) => patch((c) => { c.platformMotion.mode = v as ScenarioConfig['platformMotion']['mode']; })} disabled={d}>
            <SelectTrigger className="h-7 w-[128px] text-[11px] bg-fsoc-bg0 border-fsoc-border1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-fsoc-bg2 border-fsoc-border2 text-[11px]">
              {(['none', 'linear', 'circular', 'random', 'spiral', 'figure8'] as const).map((m) => (
                <SelectItem key={m} value={m}>{platformLabel(m)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <NumField label="Platform max" official hint="PS max ±20 px/frame" value={config.platformMotion.maxPxPerFrame} onChange={(v) => patch((c) => { c.platformMotion.maxPxPerFrame = v; })} unit="px/f" disabled={d} />
      </Section>

      <Section title="Perception / Tracking / Control" defaultOpen={false}>
        <div className="flex items-center justify-between gap-2">
          <Label className="text-[11px] text-fsoc-text2 font-normal">Detector</Label>
          <div className="text-[11px] text-fsoc-text1">{detectorLabel(config.tracking.detector)}</div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <Label className="text-[11px] text-fsoc-text2 font-normal">Tracker</Label>
          <div className="text-[11px] text-fsoc-text1">Kalman CV</div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <Label className="text-[11px] text-fsoc-text2 font-normal">Controller</Label>
          <div className="text-[11px] text-fsoc-text1">PID Angle Space</div>
        </div>
        <div className="h-px bg-fsoc-border1" />
        <NumField label="Lock radius" hint="Within this distance from center counts as locked" value={config.tracking.lockRadiusPx} onChange={(v) => patch((c) => { c.tracking.lockRadiusPx = Math.floor(v); })} unit="px" disabled={d} />
        <NumField label="Acquire confirm" hint="Consecutive confirmations required to enter TRACK" value={config.tracking.acquisitionConfirmFrames} onChange={(v) => patch((c) => { c.tracking.acquisitionConfirmFrames = Math.floor(v); })} unit="f" disabled={d} />
        <NumField label="Lost timeout" hint="Prediction frames before global re-search" value={config.tracking.lostTimeoutFrames} onChange={(v) => patch((c) => { c.tracking.lostTimeoutFrames = Math.floor(v); })} unit="f" disabled={d} />
        <NumField label="Threshold" value={config.tracking.threshold} onChange={(v) => patch((c) => { c.tracking.threshold = Math.floor(v); })} min={20} max={250} disabled={d} />
        <NumField label="Kalman Q" value={config.tracking.kalmanQ} onChange={(v) => patch((c) => { c.tracking.kalmanQ = v; })} step={0.1} disabled={d} />
        <NumField label="Kalman R" value={config.tracking.kalmanR} onChange={(v) => patch((c) => { c.tracking.kalmanR = v; })} step={0.5} disabled={d} />
        <NumField label="Kp" value={config.tracking.kp} onChange={(v) => patch((c) => { c.tracking.kp = v; })} step={0.1} disabled={d} />
        <NumField label="Ki" value={config.tracking.ki} onChange={(v) => patch((c) => { c.tracking.ki = v; })} step={0.05} disabled={d} />
        <NumField label="Kd" value={config.tracking.kd} onChange={(v) => patch((c) => { c.tracking.kd = v; })} step={0.05} disabled={d} />
        <NumField label="Deadband" value={config.tracking.deadbandDeg} onChange={(v) => patch((c) => { c.tracking.deadbandDeg = v; })} step={0.01} unit="°" disabled={d} />
        <div className="h-px bg-fsoc-border1" />
        <DetectorSelect disabled={d} />
        <div className="flex items-center justify-between gap-2">
          <Label className="text-[11px] text-fsoc-text2 font-normal">Search pattern</Label>
          <Select value={config.tracking.searchPattern} onValueChange={(v) => patch((c) => { c.tracking.searchPattern = v as 'raster' | 'spiral'; })} disabled={d}>
            <SelectTrigger className="h-7 w-[128px] text-[11px] bg-fsoc-bg0 border-fsoc-border1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-fsoc-bg2 border-fsoc-border2 text-[11px]">
              <SelectItem value="raster">Raster</SelectItem>
              <SelectItem value="spiral">Spiral</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </Section>

      <Section title="Debug Overlay">
        <div className="flex items-center justify-between">
          <Label className="text-[11px] text-fsoc-text2 font-normal">Ground truth</Label>
          <Switch checked={config.debugOverlay.groundTruth} onCheckedChange={(v) => patch((c) => { c.debugOverlay.groundTruth = v; })} />
        </div>
        <div className="flex items-center justify-between">
          <Label className="text-[11px] text-fsoc-text2 font-normal">Detection</Label>
          <Switch checked={config.debugOverlay.detection} onCheckedChange={(v) => patch((c) => { c.debugOverlay.detection = v; })} />
        </div>
        <div className="flex items-center justify-between">
          <Label className="text-[11px] text-fsoc-text2 font-normal">Prediction</Label>
          <Switch checked={config.debugOverlay.prediction} onCheckedChange={(v) => patch((c) => { c.debugOverlay.prediction = v; })} />
        </div>
        <div className="flex items-center justify-between">
          <Label className="text-[11px] text-fsoc-text2 font-normal">Camera center</Label>
          <Switch checked={config.debugOverlay.cameraCenter} onCheckedChange={(v) => patch((c) => { c.debugOverlay.cameraCenter = v; })} />
        </div>
        <p className="text-[10px] text-fsoc-text3 leading-relaxed pt-1">
          {searchLabel(config.tracking.searchPattern)} scan is used while SEARCH has no candidate.
        </p>
      </Section>
    </div>
  );
}

/**
 * Perception-path selector (AI plan Phase 11).
 *
 * The learned options are DISABLED when no weights file is deployed, rather
 * than offered and then failing at run start — and the panel says why. There
 * is no configuration in which the UI claims a learned detector while the
 * classical one runs.
 */
function DetectorSelect({ disabled }: { disabled: boolean }) {
  const config = useFsoc((s) => s.config);
  const setConfig = useFsoc((s) => s.setConfig);
  const [manifest, setManifest] = useState<ModelManifest | null>(null);
  const [hasVerifier, setHasVerifier] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.all([modelManifest(), verifierAvailable()]).then(([m, v]) => {
      if (!alive) return;
      setManifest(m);
      setHasVerifier(v);
      setChecked(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const hasModel = manifest !== null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-[11px] text-fsoc-text2 font-normal">Perception</Label>
        <Select
          value={config.tracking.detector}
          onValueChange={(v) => {
            const draft = structuredClone(config);
            draft.tracking.detector = v as DetectorKind;
            setConfig(draft);
          }}
          disabled={disabled}
        >
          <SelectTrigger className="h-7 w-[168px] text-[11px] bg-fsoc-bg0 border-fsoc-border1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-fsoc-bg2 border-fsoc-border2 text-[11px]">
            <SelectItem value="cv_classical">Classical CV</SelectItem>
            <SelectItem value="ai" disabled={!hasModel}>
              Learned AI branch
            </SelectItem>
            <SelectItem value="fusion" disabled={!hasModel || !hasVerifier}>
              Hybrid CV + AI + temporal
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="text-[10px] text-fsoc-text3 leading-relaxed">
        {!checked
          ? 'Checking for a trained model…'
          : hasModel
            ? `Model ${manifest.name}: ${manifest.paramCount} parameters, locked-test F1 ${manifest.metrics.locked_test_f1}.${hasVerifier ? ' Track verifier deployed.' : ' Track verifier missing — hybrid unavailable.'} Tracker, controller and metrics are identical for all three, so switching changes perception only. (Full-frame Mode 1 is benchmark-only: it exceeds the 33 ms frame budget.)`
            : 'No trained model is deployed, so only classical CV is available. Build one with scripts/ai/build_roi_dataset.py then scripts/ai/train_roi.py.'}
      </p>
    </div>
  );
}
