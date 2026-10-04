'use client';

/**
 * Camera viewport (docs/Frontend-Design §8) — the primary canvas.
 * Renders the live 640x480 sensor frame via rAF from the engine frame
 * buffer, with scientific overlays: crosshair, reticle, detection bbox,
 * intensity-weighted centroid, Kalman prediction, optional ground truth.
 * A subtle acquisition ring animates on state entry to TRACK.
 */
import { useEffect, useRef, useState } from 'react';
import { engine } from '@/lib/engine-client';
import { useFsoc } from '@/lib/store';
import { STATE_COLORS, STATE_LABELS } from '@/components/shell/state-colors';

/**
 * The sensor frame stays dark under the light theme: it is the engine's
 * grayscale frame buffer, not chrome. Mirrors --sensor-void in globals.css
 * (canvas fillStyle cannot resolve a CSS custom property).
 */
const SENSOR_VOID = '#131a28';

export function CameraViewport() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const config = useFsoc((s) => s.config);
  const phase = useFsoc((s) => s.phase);
  const [acqFlash, setAcqFlash] = useState(0);
  const lastStateRef = useRef<string>('SEARCH');

  const showGT = config.debugOverlay.groundTruth;
  const showDet = config.debugOverlay.detection;
  const showPred = config.debugOverlay.prediction;
  const showCenter = config.debugOverlay.cameraCenter;

  // acquire flash
  useEffect(() => {
    const unsub = engine.onFrame(() => {
      const st = engine.latest?.track.state;
      if (st && st !== lastStateRef.current) {
        if (st === 'TRACK') setAcqFlash((v) => v + 1);
        lastStateRef.current = st;
      }
    });
    return unsub;
  }, []);

  // rAF render loop — reads the engine frame buffer directly (no React state)
  useEffect(() => {
    let raf = 0;
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;
    const ctx = canvas.getContext('2d');
    const octx = overlay.getContext('2d');

    const render = () => {
      raf = requestAnimationFrame(render);
      const f = engine.frame;
      if (!ctx || !octx) return;
      const W = canvas.width;
      const H = canvas.height;
      if (f.buf && f.width === W && f.height === H) {
        // draw grayscale frame
        const img = ctx.createImageData(W, H);
        const data = img.data;
        const src = f.buf;
        for (let i = 0, p = 0; i < src.length; i++, p += 4) {
          const v = src[i];
          data[p] = v;
          data[p + 1] = v;
          data[p + 2] = v;
          data[p + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
      } else if (!f.buf) {
        ctx.fillStyle = SENSOR_VOID;
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#6E7C99';
        ctx.font = '12px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('NO SIGNAL — start a run from Mission Control', W / 2, H / 2);
      }

      // ---- overlays ----
      octx.clearRect(0, 0, W, H);
      const snap = engine.latest;
      if (!snap) continue_noSnap(octx, W, H);

      const cx = W / 2;
      const cy = H / 2;

      // camera center crosshair (+)
      if (showCenter) {
        octx.strokeStyle = 'rgba(243,246,248,0.55)';
        octx.lineWidth = 1;
        octx.beginPath();
        octx.moveTo(cx - 10, cy); octx.lineTo(cx + 10, cy);
        octx.moveTo(cx, cy - 10); octx.lineTo(cx, cy + 10);
        octx.stroke();
        // reticle ring at lock radius
        octx.strokeStyle = 'rgba(242,104,42,0.38)';
        octx.setLineDash([3, 4]);
        octx.beginPath();
        octx.arc(cx, cy, config.tracking.lockRadiusPx, 0, Math.PI * 2);
        octx.stroke();
        octx.setLineDash([]);
      }

      if (!snap) return;

      // ground truth (debug) — dashed cross, scene→image via beaconImage coords
      if (showGT && snap.beaconImageX !== null && snap.beaconImageY !== null) {
        const gx = snap.beaconImageX;
        const gy = snap.beaconImageY;
        octx.strokeStyle = 'rgba(144,167,255,0.9)';
        octx.setLineDash([2, 3]);
        octx.beginPath();
        octx.moveTo(gx - 7, gy); octx.lineTo(gx + 7, gy);
        octx.moveTo(gx, gy - 7); octx.lineTo(gx, gy + 7);
        octx.stroke();
        octx.setLineDash([]);
      }

      // detection bbox + centroid
      if (showDet && snap.detection.found && snap.detection.x !== null && snap.detection.y !== null) {
        const [bx, by, bw, bh] = snap.detection.bbox ?? [snap.detection.x - 5, snap.detection.y - 5, 10, 10];
        octx.strokeStyle = 'rgba(242,104,42,0.95)';
        octx.lineWidth = 1;
        octx.strokeRect(bx - 0.5, by - 0.5, bw + 1, bh + 1);
        // centroid cross
        octx.strokeStyle = 'rgba(255,247,216,0.95)';
        octx.beginPath();
        octx.moveTo(snap.detection.x - 5, snap.detection.y);
        octx.lineTo(snap.detection.x + 5, snap.detection.y);
        octx.moveTo(snap.detection.x, snap.detection.y - 5);
        octx.lineTo(snap.detection.x, snap.detection.y + 5);
        octx.stroke();
      }

      // Kalman prediction
      if (showPred && snap.track.is_prediction && snap.track.x !== null && snap.track.y !== null) {
        octx.strokeStyle = 'rgba(215,179,110,0.95)';
        octx.beginPath();
        octx.arc(snap.track.x, snap.track.y, 6, 0, Math.PI * 2);
        octx.moveTo(snap.track.x - 9, snap.track.y);
        octx.lineTo(snap.track.x + 9, snap.track.y);
        octx.stroke();
      }

      // POINTING ERROR VECTOR (master prompt §16, §17).
      // Drawn in every state that has an estimate — not only TRACK — because
      // the whole point is to watch it shrink during acquisition. Labelled with
      // the live magnitude so the convergence is readable, not just visible.
      if (snap.track.x !== null && snap.track.y !== null && snap.track.state !== 'SEARCH') {
        const ex = snap.track.x;
        const ey = snap.track.y;
        const dx = ex - cx;
        const dy = ey - cy;
        const mag = Math.hypot(dx, dy);
        const locked = mag <= config.tracking.lockRadiusPx;
        const col = locked ? 'rgba(53,196,106,0.95)' : 'rgba(242,104,42,0.95)';

        if (mag > 2) {
          octx.strokeStyle = col;
          octx.lineWidth = 1.6;
          octx.beginPath();
          octx.moveTo(cx, cy);
          octx.lineTo(ex, ey);
          octx.stroke();

          // arrow head at the estimate end
          const ang = Math.atan2(dy, dx);
          const head = 7;
          octx.beginPath();
          octx.moveTo(ex, ey);
          octx.lineTo(ex - head * Math.cos(ang - Math.PI / 7), ey - head * Math.sin(ang - Math.PI / 7));
          octx.moveTo(ex, ey);
          octx.lineTo(ex - head * Math.cos(ang + Math.PI / 7), ey - head * Math.sin(ang + Math.PI / 7));
          octx.stroke();

          // magnitude label, offset perpendicular to the vector so it does not
          // sit on top of the line
          const midX = cx + dx * 0.55;
          const midY = cy + dy * 0.55;
          const nx = -dy / (mag || 1);
          const ny = dx / (mag || 1);
          const label = `${mag.toFixed(1)} px`;
          octx.font = '600 11px ui-monospace, monospace';
          octx.textAlign = 'center';
          octx.textBaseline = 'middle';
          const lx = midX + nx * 12;
          const ly = midY + ny * 12;
          const tw = octx.measureText(label).width;
          octx.fillStyle = 'rgba(10,14,22,0.72)';
          octx.fillRect(lx - tw / 2 - 4, ly - 8, tw + 8, 16);
          octx.fillStyle = col;
          octx.fillText(label, lx, ly);
        }
      }
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [config.tracking.lockRadiusPx, showCenter, showDet, showGT, showPred]);

  const stateName = engine.latest?.track.state ?? 'SEARCH';
  const conf = engine.latest?.track.confidence ?? 0;
  const err = engine.latest?.errorPx ?? null;
  const stateColor = phase === 'running' ? STATE_COLORS[stateName] : 'var(--text-3)';

  return (
    <div className="relative h-full w-full select-none" data-acq-flash={acqFlash}>
      <div className="absolute inset-0 border border-fsoc-border1 rounded-lg overflow-hidden bg-[var(--sensor-void)]">
        <canvas
          ref={canvasRef}
          width={config.camera.resolutionWidth}
          height={config.camera.resolutionHeight}
          className="w-full h-full object-contain"
          style={{ imageRendering: 'pixelated' }}
        />
        <canvas ref={overlayRef} width={config.camera.resolutionWidth} height={config.camera.resolutionHeight} className="absolute inset-0 w-full h-full object-contain" />

        {/* HUD top-left: camera identity */}
        <div className="absolute top-3 left-3 text-[10px] leading-relaxed tnum text-fsoc-text1 pointer-events-none">
          <div className="font-semibold tracking-[0.14em] text-fsoc-cyan">CAM-01</div>
          <div className="text-fsoc-text2">
            {config.camera.resolutionWidth} × {config.camera.resolutionHeight}
          </div>
          <div className="text-fsoc-text2">
            FOV {config.camera.fovXDeg.toFixed(1)}° × {config.camera.fovYDeg.toFixed(1)}°
          </div>
          <div className="text-fsoc-text2">{config.camera.updateHz} Hz · MONO</div>
        </div>

        {/* HUD top-right: state + confidence */}
        <div className="absolute top-3 right-3 text-right pointer-events-none">
          <div className="text-[11px] font-bold tracking-[0.16em]" style={{ color: stateColor }}>
            {phase === 'running' || phase === 'paused' ? STATE_LABELS[stateName] : 'STANDBY'}
          </div>
          <div className="text-[10px] tnum text-fsoc-text2">CONF {(conf).toFixed(2)}</div>
        </div>

        {/* HUD bottom-left: pan/tilt */}
        <div className="absolute bottom-3 left-3 text-[10px] tnum text-fsoc-text1 pointer-events-none leading-relaxed">
          <div>
            PAN&nbsp;&nbsp;{(engine.latest?.camera.pan_deg ?? 0) >= 0 ? '+' : ''}
            {(engine.latest?.camera.pan_deg ?? 0).toFixed(2)}°
          </div>
          <div>
            TILT&nbsp;{(engine.latest?.camera.tilt_deg ?? 0) >= 0 ? '+' : ''}
            {(engine.latest?.camera.tilt_deg ?? 0).toFixed(2)}°
          </div>
        </div>

        {/* HUD bottom-right: error */}
        <div className="absolute bottom-3 right-3 text-right pointer-events-none">
          <div className="text-[11px] tnum text-fsoc-text1">
            ERR {err !== null ? `${err.toFixed(2)} px` : '—'}
          </div>
        </div>

        {/* acquisition ring flash */}
        <AcqRing flash={acqFlash} />
      </div>
    </div>
  );
}

function AcqRing({ flash }: { flash: number }) {
  // CSS animation keyed by flash count — plays once per acquisition, no state
  if (flash === 0) return null;
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div key={flash} className="w-16 h-16 rounded-full border-2 border-fsoc-success acquire-ring" />
    </div>
  );
}

function continue_noSnap(octx: CanvasRenderingContext2D, W: number, H: number): void {
  octx.strokeStyle = 'rgba(242,104,42,0.38)';
  octx.lineWidth = 1;
  octx.beginPath();
  octx.moveTo(W / 2 - 10, H / 2);
  octx.lineTo(W / 2 + 10, H / 2);
  octx.moveTo(W / 2, H / 2 - 10);
  octx.lineTo(W / 2, H / 2 + 10);
  octx.stroke();
}
