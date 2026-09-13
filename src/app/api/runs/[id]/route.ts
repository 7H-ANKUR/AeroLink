import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

/**
 * GET    /api/runs/[id] — full RunResult + events.csv for replay/comparison
 * DELETE /api/runs/[id] — remove a run from the registry
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const run = await db.run.findUnique({ where: { id } });
    if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ run });
  } catch (err) {
    return NextResponse.json({ error: 'registry unavailable', detail: String(err) }, { status: 503 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    await db.run.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: 'delete failed', detail: String(err) }, { status: 500 });
  }
}
