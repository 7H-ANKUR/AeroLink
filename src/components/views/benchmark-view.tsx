'use client';

/**
 * Video Benchmark view (docs/Frontend-Design §18, docs/03 §6).
 * MP4 30-FPS benchmark mode. Ground-truth availability is shown BEFORE a run
 * starts and the "perception-only" label is persistent — the UI never implies
 * physical re-pointing of recorded footage.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, FileUp, Film, Info, Play, Square, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFsoc, engine } from '@/lib/store';
import {
  VideoBenchmarkRunner,
  type AnnotationFile,
  type VideoBenchmarkProgress,
} from '@/lib/video-benchmark';
import type { RunResult } from '@/engine/types';
import { downloadText, summaryHtml } from '@/engine/export';

interface VideoInfo {
  name: string;
  width: number;
  height: number;
  durationS: number;
  sizeMB: number;
  objectUrl: string;
}

type GtStatus = 'pending' | 'none' | 'manual_annotation' | 'evaluator';

export function BenchmarkView() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const runnerRef = useRef<VideoBenchmarkRunner | null>(null);
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [gtStatus, setGtStatus] = useState<GtStatus>('pending');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<VideoBenchmarkProgress | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const pushLog = useCallback((level: 'INFO' | 'WARN' | 'ERROR' | 'STATE' | 'METRIC', message: string, detail?: string) => {
    engine.pushLog(level, `[BENCH] ${message}`, detail);
  }, []);

  const handleFile = (file: File) => {
    if (result) setResult(null);
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext !== 'mp4' && ext !== 'webm' && ext !== 'mov') {
      pushLog('ERROR', 'Unsupported video', 'Expected MP4 (nominally 30 FPS) — readable video stream');
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    // probe metadata on a detached element — the on-page <video> only renders
    // once videoInfo exists
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.src = objectUrl;
    probe.onloadedmetadata = () => {
      setVideoInfo({
        name: file.name,
        width: probe.videoWidth || 640,
        height: probe.videoHeight || 480,
        durationS: Number.isFinite(probe.duration) ? probe.duration : 0,
        sizeMB: file.size / (1024 * 1024),
        objectUrl,
      });
      setGtStatus('none'); // default: no GT until an annotation file is loaded
      pushLog('INFO', 'Video loaded', `${file.name} · ${probe.videoWidth}×${probe.videoHeight} · ${probe.duration.toFixed(1)}s`);
    };
    probe.onerror = () => {
      pushLog('ERROR', 'Unable to read video stream', 'codec unsupported or corrupt file');
    };
  };

  const startAnalysis = async () => {
    const v = videoRef.current;
    if (!v || !videoInfo) return;
    v.currentTime = 0;
    setRunning(true);
    setResult(null);
    setProgress(null);

    const runner = new VideoBenchmarkRunner(null, {
      onFrame: (img, prog) => {
        setProgress(prog);
        const canvas = previewRef.current;
        if (canvas && img) {
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.putImageData(img, 0, 0);
            // overlays
            const st = prog.state;
            const colors: Record<string, string> = {
              SEARCH: '#7d8994',
              CANDIDATE: '#d8b56b',
              ACQUIRE: '#8faee8',
              TRACK: '#79c99b',
              PREDICT_REACQUIRE: '#d7b36e',
            };
            ctx.strokeStyle = colors[st] ?? '#fff';
            ctx.lineWidth = 1.5;
            if (prog.detection?.found && prog.detection.x !== null && prog.detection.y !== null) {
              ctx.strokeRect(prog.detection.x - 7, prog.detection.y - 7, 14, 14);
              ctx.beginPath();
              ctx.moveTo(prog.detection.x - 5, prog.detection.y);
              ctx.lineTo(prog.detection.x + 5, prog.detection.y);
              ctx.moveTo(prog.detection.x, prog.detection.y - 5);
              ctx.lineTo(prog.detection.x, prog.detection.y + 5);
              ctx.stroke();
            }
            if (prog.isPrediction && prog.x !== null && prog.y !== null) {
              ctx.strokeStyle = '#d7b36e';
              ctx.beginPath();
              ctx.arc(prog.x, prog.y, 7, 0, Math.PI * 2);
              ctx.stroke();
            }
          }
        }
      },
      onLog: pushLog,
      onDone: (res, _csv) => {
        setResult(res);
        setRunning(false);
        engine.lastResult = res;
        engine.lastEventsCsv = _csv;
        void fetch('/api/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ result: res, eventsCsv: _csv }),
        });
        pushLog('INFO', 'Benchmark result saved to registry', res.run_id);
      },
      onError: (msg) => {
        pushLog('ERROR', msg);
        setRunning(false);
      },
    });
    runnerRef.current = runner;
    // annotation loaded before run start (docs/03 §6 — before a run starts)
    if (gtStatus === 'manual_annotation' || gtStatus === 'evaluator') {
      // loaded via loadAnnotation already; runner re-created — re-attach if stored
      if (lastAnnotation) runner.loadAnnotation(lastAnnotation, lastAnnotation.source_video);
    }
    await runner.run(v);
  };

  const [lastAnnotation, setLastAnnotation] = useState<AnnotationFile | null>(null);

  const stopAnalysis = () => {
    runnerRef.current?.stop();
    setRunning(false);
  };

  // cleanup object URL
  useEffect(() => {
    return () => {
      if (videoInfo) URL.revokeObjectURL(videoInfo.objectUrl);
    };
  }, [videoInfo]);

  const gtLabel =
    gtStatus === 'evaluator'
      ? { text: 'KNOWN GT — EVALUATOR FILE', color: 'var(--success)' }
      : gtStatus === 'manual_annotation'
        ? { text: 'MANUALLY ANNOTATED GROUND TRUTH', color: 'var(--warning)' }
        : gtStatus === 'none'
          ? { text: 'NOT AVAILABLE — PERCEPTION-ONLY METRICS', color: 'var(--warning)' }
          : { text: 'LOAD A VIDEO TO DETERMINE', color: 'var(--text-3)' };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4">
      <div className="max-w-5xl mx-auto space-y-4">
        <div>
          <h2 className="text-[16px] font-semibold tracking-[0.14em] text-fsoc-text0">VIDEO BENCHMARK</h2>
          <p className="text-[11px] text-fsoc-text2 mt-0.5">
            External 30-FPS MP4 · perception pipeline (detection → tracking → metrics) on recorded footage
          </p>
        </div>

        {/* persistent perception-only banner */}
        <div className="flex items-start gap-2.5 panel px-4 py-3 border-fsoc-warning/30">
          <AlertTriangle className="w-4 h-4 text-fsoc-warning shrink-0 mt-0.5" />
          <p className="text-[11px] text-fsoc-text1 leading-relaxed">
            <span className="font-semibold text-fsoc-warning">Perception-only benchmark.</span> Pan/tilt commands are
            computed and logged for control-quality analysis, but recorded footage cannot be physically re-pointed.
            {gtStatus === 'none' && videoInfo && ' Without ground truth, error/RMSE are not computable — reference-free metrics are reported instead.'}
          </p>
        </div>

        <div className="grid md:grid-cols-[1fr_340px] gap-4">
          {/* LEFT — input + preview */}
          <div className="space-y-4">
            {!videoInfo ? (
              <label
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const f = e.dataTransfer.files[0];
                  if (f) handleFile(f);
                }}
                className="flex flex-col items-center justify-center gap-3 panel border-dashed cursor-pointer hover:border-fsoc-cyan/40 transition-colors h-64"
              >
                <FileUp className="w-8 h-8 text-fsoc-text3" />
                <div className="text-center">
                  <div className="text-[13px] text-fsoc-text1">Drop MP4 here</div>
                  <div className="text-[11px] text-fsoc-text3 mt-1">or</div>
                  <span className="inline-flex items-center gap-1.5 mt-1 text-[11px] text-fsoc-cyan">
                    <Upload className="w-3 h-3" /> Choose video
                  </span>
                </div>
                <input type="file" accept="video/mp4,video/webm,video/quicktime" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
              </label>
            ) : (
              <div className="panel overflow-hidden">
                <div className="relative bg-[#05070a] aspect-video flex items-center justify-center">
                  <canvas ref={previewRef} width={640} height={480} className={`max-w-full max-h-full object-contain ${running ? '' : 'hidden'}`} style={{ imageRendering: 'pixelated' }} />
                  <video ref={videoRef} src={videoInfo.objectUrl} className={`absolute inset-0 w-full h-full object-contain ${running ? 'w-px h-px opacity-0' : ''}`} playsInline muted />
                </div>
                <div className="px-4 py-3 flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="text-[12px] text-fsoc-text1 truncate">{videoInfo.name}</div>
                    <div className="text-[10px] tnum text-fsoc-text3">
                      {videoInfo.width} × {videoInfo.height} · {videoInfo.sizeMB.toFixed(1)} MB · {videoInfo.durationS.toFixed(1)} s
                    </div>
                  </div>
                  {running ? (
                    <Button variant="secondary" size="sm" className="gap-1.5 h-8" onClick={stopAnalysis}>
                      <Square className="w-3.5 h-3.5" /> Stop
                    </Button>
                  ) : (
                    <Button size="sm" className="gap-1.5 h-8 bg-fsoc-cyan text-[#06272c] hover:bg-fsoc-cyan/85 font-semibold" onClick={startAnalysis}>
                      <Play className="w-3.5 h-3.5" /> Run Perception Pipeline
                    </Button>
                  )}
                </div>
                {running && progress && (
                  <div className="px-4 pb-3">
                    <div className="h-1 bg-fsoc-bg3 rounded overflow-hidden">
                      <div className="h-full bg-fsoc-cyan transition-all" style={{ width: `${Math.min(100, (progress.elapsedS / Math.max(0.1, videoInfo.durationS)) * 100)}%` }} />
                    </div>
                    <div className="flex justify-between text-[9px] tnum text-fsoc-text3 mt-1">
                      <span>frame {progress.frameIndex}</span>
                      <span>{progress.state}</span>
                      <span>{progress.fpsAlgorithm.toFixed(1)} FPS</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* sample video loader */}
            <button
              className="flex items-center gap-2 text-[11px] text-fsoc-text2 hover:text-fsoc-cyan transition-colors"
              onClick={() => {
                fetch('/samples/sample_benchmark_01.mp4')
                  .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('sample unavailable'))))
                  .then((blob) => handleFile(new File([blob], 'sample_benchmark_01.mp4', { type: 'video/mp4' })))
                  .catch(() => pushLog('WARN', 'Sample video unavailable', 'generate it via scripts/generate-sample-video.sh'));
              }}
            >
              <Film className="w-3.5 h-3.5" />
              Load bundled sample video (synthetic beacon, 30 FPS)
            </button>

            {result && <BenchmarkResultCard result={result} />}
          </div>

          {/* RIGHT — ground truth status + metrics */}
          <div className="space-y-3">
            <div className="panel px-4 py-3.5">
              <div className="panel-title mb-2">Ground Truth</div>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full" style={{ background: gtLabel.color }} />
                <span className="text-[11px] font-semibold tracking-wide" style={{ color: gtLabel.color }}>
                  {gtLabel.text}
                </span>
              </div>
              <p className="text-[10px] text-fsoc-text3 leading-relaxed mt-2">
                {gtStatus === 'none'
                  ? 'Error/RMSE/lock-vs-GT are not computable. Reference-free metrics: detection rate, track continuity, re-acquisition events, FPS, confidence.'
                  : gtStatus === 'manual_annotation'
                    ? 'GT derived from sparse click-annotation + linear interpolation — flagged as MANUALLY ANNOTATED, never presented as evaluator ground truth.'
                    : gtStatus === 'evaluator'
                      ? 'Evaluator-supplied reference track — full metric set computable.'
                      : 'Load a video, then optionally attach a GT annotation file (docs/05 §6 schema).'}
              </p>
              <label className="mt-3 inline-flex items-center gap-1.5 text-[10px] text-fsoc-cyan cursor-pointer hover:underline">
                <FileUp className="w-3 h-3" /> Attach GT annotation (JSON)
                <input
                  type="file"
                  accept="application/json"
                  className="sr-only"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f || !videoInfo) {
                      if (f) pushLog('WARN', 'Load a video first, then attach annotation');
                      return;
                    }
                    f.text().then((text) => {
                      try {
                        const a = JSON.parse(text) as AnnotationFile;
                        setLastAnnotation(a);
                        setGtStatus(a.annotation_type === 'evaluator' ? 'evaluator' : 'manual_annotation');
                        pushLog('INFO', 'Annotation attached', `${a.annotated_frames.length} points`);
                      } catch (err) {
                        pushLog('ERROR', 'Invalid annotation JSON', String(err));
                      }
                    });
                  }}
                />
              </label>
            </div>

            <div className="panel px-4 py-3.5">
              <div className="panel-title mb-2.5">Reference-Free Metrics</div>
              {progress ? (
                <div className="space-y-1.5 text-[11px] tnum">
                  <Row label="Frames" value={String(progress.frameIndex)} />
                  <Row label="Algorithm FPS" value={progress.fpsAlgorithm.toFixed(1)} />
                  <Row label="State" value={progress.state} />
                </div>
              ) : (
                <div className="text-[10px] text-fsoc-text3">Metrics appear while the pipeline runs.</div>
              )}
              {result && <ResultMetrics result={result} />}
            </div>

            <div className="panel px-4 py-3.5 flex gap-2.5">
              <Info className="w-3.5 h-3.5 text-fsoc-text3 shrink-0 mt-0.5" />
              <p className="text-[10px] text-fsoc-text3 leading-relaxed">
                The same FrameSource-agnostic pipeline that runs the simulator processes this video — detection,
                Kalman tracking, state machine and metrics are identical (FR-13). Detector and tracker parameters are
                shared with Mission Control.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-fsoc-text2">{label}</span>
      <span className="text-fsoc-text1">{value}</span>
    </div>
  );
}

function ResultMetrics({ result }: { result: RunResult }) {
  return (
    <div className="mt-3 pt-3 border-t border-fsoc-border1 space-y-1.5 text-[11px] tnum">
      <Row label="Algorithm FPS" value={result.fps_measured.toFixed(1)} />
      <Row label="Detection rate" value={result.detection_rate_percent !== null ? `${result.detection_rate_percent.toFixed(1)} %` : '—'} />
      <Row label="Track continuity" value={result.track_continuity_frames !== null ? `${result.track_continuity_frames} f` : '—'} />
      <Row label="Avg confidence" value={result.avg_detection_confidence !== null ? result.avg_detection_confidence.toFixed(2) : '—'} />
      {result.avg_error_px !== null && <Row label="Avg error (GT)" value={`${result.avg_error_px.toFixed(2)} px`} />}
      {result.rmse_px !== null && <Row label="RMSE (GT)" value={`${result.rmse_px.toFixed(2)} px`} />}
    </div>
  );
}

function BenchmarkResultCard({ result }: { result: RunResult }) {
  const pf = result.pass_fail;
  return (
    <div className="panel px-4 py-3.5">
      <div className="flex items-center justify-between mb-2.5">
        <span className="panel-title">Benchmark Complete</span>
        <span className="text-[9px] tnum text-fsoc-text3">{result.run_id}</span>
      </div>
      <ResultMetrics result={result} />
      {pf && (
        <div className="mt-3 flex gap-1.5 flex-wrap">
          {Object.entries(pf).map(([k, v]) => (
            <span key={k} className={`text-[9px] px-1.5 py-0.5 rounded border ${v ? 'border-fsoc-success/40 text-fsoc-success' : 'border-fsoc-danger/40 text-fsoc-danger'}`}>
              {k} {v ? 'PASS' : 'FAIL'}
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2 mt-3">
        <Button variant="secondary" size="sm" className="h-7 text-[10px]" onClick={() => downloadText(`${result.run_id}-metrics.json`, JSON.stringify(result, null, 2), 'application/json')}>
          Export JSON
        </Button>
        <Button variant="secondary" size="sm" className="h-7 text-[10px]" onClick={() => downloadText(`${result.run_id}-summary.html`, summaryHtml(result), 'text/html')}>
          Export HTML report
        </Button>
      </div>
    </div>
  );
}
