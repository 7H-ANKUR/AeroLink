import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import type { RunResult } from '@/engine/types';

/**
 * Run registry API (docs/05 §5, docs/06 §7).
 * GET /api/runs        — list recent runs (newest first)
 * POST /api/runs       — persist a completed RunResult + events.csv
 * DELETE /api/runs     — clear registry
 */
export async function GET() {
  try {
    const runs = await db.run.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        runId: true,
        mode: true,
        scenarioName: true,
        scenarioSeed: true,
        detector: true,
        tracker: true,
        controller: true,
        durationS: true,
        fpsMeasured: true,
        acquisitionTimeS: true,
        avgErrorPx: true,
        maxErrorPx: true,
        rmsePx: true,
        targetLossPercent: true,
        lockRetentionPercent: true,
        reacquisitionAvgS: true,
        processingAvgMs: true,
        groundTruthSource: true,
        passFail: true,
        createdAt: true,
      },
    });
    return NextResponse.json({ runs });
  } catch (err) {
    return NextResponse.json({ error: 'registry unavailable', detail: String(err) }, { status: 503 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { result: RunResult; eventsCsv?: string | null };
    const r = body.result;
    if (!r || !r.run_id) {
      return NextResponse.json({ error: 'invalid payload' }, { status: 400 });
    }
    const saved = await db.run.create({
      data: {
        runId: r.run_id,
        mode: r.mode,
        scenarioName: r.scenario_name,
        scenarioSeed: r.scenario_seed,
        detector: r.detector,
        tracker: r.tracker,
        controller: r.controller,
        durationS: r.duration_s,
        fpsMeasured: r.fps_measured,
        acquisitionTimeS: r.acquisition_time_s,
        avgErrorPx: r.avg_error_px,
        maxErrorPx: r.max_error_px,
        rmsePx: r.rmse_px,
        p95ErrorPx: r.p95_error_px,
        targetLossPercent: r.target_loss_percent,
        lockRetentionPercent: r.lock_retention_percent,
        reacquisitionAvgS: r.reacquisition_avg_s,
        reacquisitionMaxS: r.reacquisition_max_s,
        reacquisitionEvents: r.reacquisition_events,
        processingAvgMs: r.processing_avg_ms,
        detectionRatePercent: r.detection_rate_percent,
        avgConfidence: r.avg_detection_confidence,
        groundTruthSource: r.ground_truth_source,
        passFail: JSON.stringify(r.pass_fail),
        resultJson: JSON.stringify(r),
        eventsCsv: body.eventsCsv ?? null,
      },
    });
    return NextResponse.json({ ok: true, id: saved.id });
  } catch (err) {
    return NextResponse.json({ error: 'save failed', detail: String(err) }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    await db.run.deleteMany({});
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: 'delete failed', detail: String(err) }, { status: 500 });
  }
}
