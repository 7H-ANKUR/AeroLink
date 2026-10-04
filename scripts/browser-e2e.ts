/**
 * plan2 browser verification: the SHIPPED app, in a real Chrome, running the
 * learned stages through ONNX Runtime Web inside the simulation Web Worker.
 *
 *   1. opens the production server (bun run build && bun run start)
 *   2. configures a hybrid run through the app's own store actions
 *      (bright decoys, seed 4402 — the traced false-lock case)
 *   3. starts it and lets it run in the browser
 *   4. reads back what the UI holds: the worker's log (ORT ready, live
 *      runtime parity, perception-chain lines) and the telemetry snapshot the
 *      panels render (detection provenance, Kalman prediction, PID command,
 *      mount response)
 *   5. asserts the chain, saves evidence JSON + screenshots
 *
 * Nothing is mocked: the worker fetches /models/*.onnx and /ort/*.wasm from
 * the server like any user's browser would.
 *
 * Usage: bun scripts/browser-e2e.ts [--url http://localhost:3000] [--seconds 20]
 * Writes: benchmark-results/browser-e2e/{evidence.json,*.png}
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => existsSync(p));

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (k: string, d: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : d;
  };
  const url = arg('--url', 'http://localhost:3000');
  const seconds = Number(arg('--seconds', '20'));
  if (!CHROME) throw new Error('No Chrome/Edge executable found for puppeteer-core.');
  const outDir = join('benchmark-results', 'browser-e2e');
  mkdirSync(outDir, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--window-size=1680,1050'],
    defaultViewport: { width: 1680, height: 1050 },
  });
  const page = await browser.newPage();
  const consoleLines: string[] = [];
  page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${String(e)}`));

  process.stdout.write(`Browser: ${await browser.version()} (${CHROME})\nOpening ${url}/?e2e=1\n`);
  await page.goto(`${url}/?e2e=1`, { waitUntil: 'networkidle2', timeout: 120000 });
  await page.waitForFunction('!!window.__fsoc', { timeout: 60000 });

  // Configure through the app's own store and start the run.
  await page.evaluate((durationS: number) => {
    const store = (window as unknown as { __fsoc: { getState(): Record<string, any> } }).__fsoc;
    const s = store.getState();
    const cfg = structuredClone(s.config);
    cfg.scenarioName = 'plan2 browser E2E — hybrid, bright decoys';
    cfg.seed = 4402;
    cfg.durationS = Math.max(5, durationS + 5);
    cfg.scene.distractorCount = 10;
    cfg.scene.distractorIntensityMin = 0.62;
    cfg.scene.distractorIntensityMax = 0.95;
    cfg.tracking.detector = 'fusion';
    s.setConfig(cfg);
    if (typeof s.setView === 'function') s.setView('laboratory');
    store.getState().startRun();
  }, seconds);

  const t0 = Date.now();
  let mid: unknown = null;
  while (Date.now() - t0 < seconds * 1000) {
    await new Promise((r) => setTimeout(r, 1000));
    if (!mid && Date.now() - t0 > (seconds * 1000) / 2) {
      await page.screenshot({ path: join(outDir, 'mid-run.png') });
      mid = true;
    }
  }
  await page.screenshot({ path: join(outDir, 'end-of-window.png') });
  // The Perception Chain panel (CV / AI / fusion / temporal / control chain)
  // lives lower in the telemetry column: bring it into view and capture it.
  const panelBox = await page.evaluate(() => {
    const title = Array.from(document.querySelectorAll('.panel-title')).find((e) =>
      (e.textContent ?? '').includes('Perception Chain'),
    );
    const panel = title?.closest('.panel') as HTMLElement | null;
    if (!panel) return null;
    panel.scrollIntoView({ block: 'start' });
    const r = panel.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 1040) };
  });
  if (panelBox) {
    await new Promise((r) => setTimeout(r, 400));
    await page.screenshot({ path: join(outDir, 'perception-chain-panel.png'), clip: panelBox });
  }

  const state = await page.evaluate(() => {
    const store = (window as unknown as { __fsoc: { getState(): Record<string, any> } }).__fsoc;
    const s = store.getState();
    return {
      phase: s.phase,
      config: { detector: s.config.tracking.detector, seed: s.config.seed },
      telemetry: s.telemetry,
      logs: (s.logs as Array<Record<string, unknown>>).map((l) => ({
        frame: l.frame,
        level: l.level,
        message: l.message,
        detail: l.detail,
      })),
      crossOriginIsolated: (globalThis as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated ?? null,
    };
  });
  await browser.close();

  const logs = state.logs as Array<{ frame?: number; level: string; message: string; detail?: string }>;
  const t = state.telemetry as Record<string, any> | null;
  const pv = t?.detection?.provenance ?? null;
  const has = (m: string) => logs.find((l) => l.message.includes(m));
  const chainLines = logs.filter((l) => l.message === 'Perception chain');
  const ortChain = chainLines.filter((l) => (l.detail ?? '').includes('onnxruntime-web'));
  const parity = has('Runtime parity on live frame');
  const parityDelta = parity?.detail ? Number(/\|Δ\| ([0-9.e+-]+)/.exec(parity.detail)?.[1]) : NaN;

  const checks: Check[] = [
    { name: 'ONNX Runtime Web session created in the worker', ok: !!has('ONNX Runtime Web ready'), detail: has('ONNX Runtime Web ready')?.detail ?? 'missing' },
    { name: 'no fallback to the TS forward pass', ok: !has('ONNX Runtime Web unavailable'), detail: has('ONNX Runtime Web unavailable')?.detail ?? 'none' },
    { name: 'live-frame runtime parity ORT vs TS < 1e-4', ok: Number.isFinite(parityDelta) && parityDelta < 1e-4, detail: parity?.detail ?? 'missing' },
    { name: 'perception-chain log lines produced by ORT', ok: ortChain.length >= Math.floor(seconds / 2), detail: `${ortChain.length} of ${chainLines.length} chain lines name onnxruntime-web` },
    { name: 'displayed detection provenance: runtime = onnxruntime-web', ok: typeof pv?.aiRuntime === 'string' && pv.aiRuntime.startsWith('onnxruntime-web'), detail: String(pv?.aiRuntime) },
    { name: 'displayed CV result present', ok: pv?.cv != null, detail: JSON.stringify(pv?.cv) },
    { name: 'displayed AI result present (ORT score)', ok: pv?.ai != null && pv.ai.confidence >= 0 && pv.ai.confidence <= 1, detail: JSON.stringify(pv?.ai) },
    { name: 'displayed fusion decision + reason', ok: typeof pv?.chosenBy === 'string' && typeof pv?.decisionReason === 'string', detail: `${pv?.chosenBy} — ${pv?.decisionReason}` },
    { name: 'selected candidate reached the Kalman tracker (TRACK)', ok: t?.track?.state === 'TRACK' && t?.detection?.found === true, detail: `state=${t?.track?.state} det=(${t?.detection?.x?.toFixed?.(1)}, ${t?.detection?.y?.toFixed?.(1)})` },
    { name: 'Kalman prediction displayed', ok: t?.predicted != null, detail: JSON.stringify(t?.predicted) },
    { name: 'PID command displayed', ok: t?.command != null, detail: JSON.stringify(t?.command) },
    { name: 'actual mount response displayed', ok: t?.mount != null && typeof t.mount.actualPanRateDegS === 'number', detail: t?.mount ? `actual ${t.mount.actualPanRateDegS.toFixed(3)}/${t.mount.actualTiltRateDegS.toFixed(3)} °/s, az ${t.mount.azimuthDeg.toFixed(3)}° el ${t.mount.elevationDeg.toFixed(3)}°` : 'missing' },
    { name: 'camera re-pointed by the mount (pose off boresight)', ok: t?.camera != null && Math.hypot(t.camera.pan_deg, t.camera.tilt_deg) > 0.05, detail: JSON.stringify(t?.camera) },
    // Judged over the whole run from the metrics engine (ground truth is used
    // there, and only there). This seed deliberately STARTS on a bright decoy
    // hundreds of px away, so the run mean includes that false-lock second
    // and is reported as measured (see `measured` in evidence.json); the
    // pass criterion is that the lock ends up and stays on the beacon.
    {
      name: 'lock held on the beacon over the run (lock retention ≥ 80 %)',
      ok: typeof t?.metrics?.lockRetentionPercent === 'number' && t.metrics.lockRetentionPercent >= 80,
      detail: `lock retention ${t?.metrics?.lockRetentionPercent?.toFixed?.(1)} % · MEASURED mean error ${t?.metrics?.avgErrorPx?.toFixed?.(2)} px (PS gate 10 px; includes the initial decoy lock) · instantaneous ${t?.errorPx?.toFixed?.(2)} px`,
    },
    { name: 'no page errors', ok: !consoleLines.some((l) => l.startsWith('[pageerror]')), detail: consoleLines.filter((l) => l.startsWith('[pageerror]')).slice(0, 3).join(' | ') || 'none' },
  ];

  const evidence = {
    generatedAt: new Date().toISOString(),
    browser: CHROME,
    url,
    seconds,
    config: state.config,
    phaseAtEnd: state.phase,
    crossOriginIsolated: state.crossOriginIsolated,
    checks,
    measured: {
      lockRetentionPercent: t?.metrics?.lockRetentionPercent ?? null,
      meanErrorPx: t?.metrics?.avgErrorPx ?? null,
      acquisitionTimeS: t?.metrics?.acquisitionTimeS ?? null,
      note: 'Seed 4402 starts locked on a bright decoy; the mean includes that period. Performance is reported by scripts/eval-detectors.ts.',
    },
    finalTelemetry: t
      ? {
          frameIndex: t.frameIndex,
          timestampS: t.timestampS,
          detection: t.detection,
          track: t.track,
          predicted: t.predicted,
          command: t.command,
          mount: t.mount,
          camera: t.camera,
          errorPx: t.errorPx,
          metrics: t.metrics,
        }
      : null,
    systemLog: logs.filter((l) => l.level === 'SYSTEM' || l.level === 'WARN' || l.level === 'ERROR'),
    chainLog: logs.filter((l) => l.message === 'Perception chain' || l.message === 'Kalman → PID → mount').slice(0, 60),
    console: consoleLines.slice(0, 80),
  };
  writeFileSync(join(outDir, 'evidence.json'), JSON.stringify(evidence, null, 2));

  let pass = 0;
  for (const c of checks) {
    if (c.ok) pass++;
    process.stdout.write(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}\n      ${c.detail}\n`);
  }
  process.stdout.write(`\n${pass}/${checks.length} checks passed. Evidence: ${outDir}/evidence.json\n`);
  process.exit(pass === checks.length ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e) + '\n');
  process.exit(2);
});
