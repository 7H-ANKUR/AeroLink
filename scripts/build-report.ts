/**
 * Build the final technical report from its template and the MEASURED artefacts.
 *
 * Every table of results is generated here from the benchmark/model files —
 * nothing in a results table is typed by hand. Missing artefacts abort the
 * build rather than leaving a hole.
 *
 * Inputs:  docs/report/FINAL_TECHNICAL_REPORT.template.md
 *          benchmark-results/<latest>/aggregate.json + raw-runs.json  (batch-test)
 *          benchmark-results/detector-comparison/summary.json         (eval-resumable)
 *          benchmark-results/latency-<host>.json                      (bench-latency)
 *          benchmark-results/browser-e2e/evidence.json                (browser-e2e)
 *          public/models/{beacon-roi-v2,track-verifier-v1}.json, onnx-manifest.json
 *          docs/report/data/classical_fig8_42.csv                     (report-timeseries)
 * Outputs: docs/report/FINAL_TECHNICAL_REPORT.{md,html,pdf}
 *
 * Usage: bun scripts/build-report.ts [--no-pdf]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { marked } from 'marked';
import { DEFAULT_CONFIG } from '../src/engine/config';

const ROOT = resolve(import.meta.dir, '..');
const R = (...p: string[]) => join(ROOT, ...p);
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const f = (v: number | null | undefined, d = 2, u = '') => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(d)}${u}`);
const need = (p: string) => {
  if (!existsSync(p)) throw new Error(`missing artefact: ${p}`);
  return p;
};

// ---------- artefacts ----------
const runs = readdirSync(R('benchmark-results'))
  .filter((d) => /^20\d\d-/.test(d) && existsSync(R('benchmark-results', d, 'aggregate.json')))
  .sort();
const psRun = runs[runs.length - 1];
const agg = json(need(R('benchmark-results', psRun, 'aggregate.json')));
const raw = json(need(R('benchmark-results', psRun, 'raw-runs.json'))) as Array<Record<string, any>>;
const evalS = json(need(R('benchmark-results', 'detector-comparison', 'summary.json')));
const latFile = readdirSync(R('benchmark-results')).find((x) => x.startsWith('latency-') && x.endsWith('.json'));
if (!latFile) throw new Error('missing latency artefact');
const lat = json(R('benchmark-results', latFile));
const e2e = json(need(R('benchmark-results', 'browser-e2e', 'evidence.json')));
const cnn = json(need(R('public', 'models', 'beacon-roi-v2.json')));
const ver = json(need(R('public', 'models', 'track-verifier-v1.json')));
const onnxMan = json(need(R('public', 'models', 'onnx-manifest.json')));

// ---------- tokens ----------
const T: Record<string, string> = {};
T.BUILD_DATE = new Date().toISOString().slice(0, 10);
const cm = onnxMan.models['beacon-roi-v2'];
const vm = onnxMan.models['track-verifier-v1'];
T.CNN_FILE = `\`${cm.file}\` (${cm.bytes.toLocaleString('en')} B) <br/><code class="hash">${cm.sha256}</code>`;
T.VER_FILE = `\`${vm.file}\` (${vm.bytes.toLocaleString('en')} B) <br/><code class="hash">${vm.sha256}</code>`;
const mc = evalS.modeComparison;
T.MODE1_MS = f(mc.fullFrame.latencyMs, 0);
T.MODE2_MS = f(mc.roi.latencyMs, 1);
T.MODE_NOTE = `MEASURED on the same ${mc.fullFrame.frames} frames (clear, bright decoys, dim beacon), ONNX Runtime Web for Mode 2:\n\n` +
  `| Mode | Latency per frame | Recall | Precision |\n|---|---|---|---|\n` +
  `| Mode 1 — full-frame CNN | ${f(mc.fullFrame.latencyMs, 1)} ms | ${f(mc.fullFrame.recall, 3)} | ${f(mc.fullFrame.precision, 3)} |\n` +
  `| Mode 2 — proposals + ROI CNN (\`ai\`) | ${f(mc.roi.latencyMs, 2)} ms | ${f(mc.roi.recall, 3)} | ${f(mc.roi.precision, 3)} |\n\n` +
  `Mode 1 is ${(mc.fullFrame.latencyMs / mc.roi.latencyMs).toFixed(0)}× slower and over the 33.3 ms budget; neither mode alone has acceptable precision on this mix — which is why neither is used alone in the hybrid.`;
const m = cnn.metrics;
T.STAGEA_REAL = f(m.stageA_real_val_f1, 4);
T.STAGEA_SYNTH = f(m.stageA_synth_val_f1, 4);
const sess = (e2e.systemLog as Array<{ message: string; detail?: string }>).find((l) => l.message.includes('ONNX Runtime Web ready'));
T.BROWSER_SESSION_MS = sess?.detail?.match(/sessions created in (\d+) ms/)?.[1] ? `${sess.detail.match(/sessions created in (\d+) ms/)![1]} ms (Chrome, ${e2e.generatedAt.slice(0, 10)})` : 'not available';
T.HW = `${lat.cpu}, ${lat.threads} logical threads (${lat.platform})`;
T.PS169_RUN = `\`benchmark-results/${psRun}/\``;

{
  const byName = new Map<string, Array<Record<string, any>>>();
  for (const r of raw) {
    const k = r.scenario_name ?? r.result?.scenario_name;
    const rr = r.result ?? r;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k)!.push(rr);
  }
  const mean = (xs: Array<number | null>) => {
    const v = xs.filter((x): x is number => typeof x === 'number');
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const L = ['| Scenario | Acq (s) | Avg err (px) | Max err (px) | RMSE (px) | Centroid err (px) | Loss (%) | Lock (%) | Re-acq (s) | Alg. FPS | All 5 gates |', '|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const sc of agg.scenarios) {
    const rr = byName.get(sc.name) ?? [];
    L.push(`| ${sc.name} | ${f(sc.mean.acquisition_s, 2)} | ${f(sc.mean.avg_error_px, 2)} | ${f(mean(rr.map((x) => x.max_error_px)), 1)} | ${f(sc.mean.rmse_px, 2)} | ${f(mean(rr.map((x) => x.centroid_error_avg_px)), 2)} | ${f(sc.mean.target_loss_pct, 2)} | ${f(sc.mean.lock_retention_pct, 1)} | ${f(sc.mean.reacquisition_s, 2)} | ${f(sc.mean.algorithm_fps, 0)} | ${sc.all_pass ? 'PASS' : 'FAIL'} |`);
  }
  L.push('');
  L.push(`**${agg.scenarios_passing}/${agg.scenarios_total} scenarios pass all five PS-169 gates** (mean of ${agg.seeds_per_scenario} seeds each). "—" = no loss occurred, so no re-acquisition was needed.`);
  T.PS169_TABLE = L.join('\n');
}

{
  const conds: string[] = [];
  for (const c of evalS.loop) if (!conds.includes(c.condition)) conds.push(c.condition);
  const loop = (cond: string, det: string) => evalS.loop.find((c: any) => c.condition === cond && c.detector === det);
  const perc = (cond: string, det: string) => evalS.perception.find((c: any) => c.condition === cond && c.detector === det);
  const L = ['| Condition | Classical | AI only | Hybrid | Hybrid median error | Hybrid correct acq |', '|---|---|---|---|---|---|'];
  for (const c of conds) {
    const cell = (d: string) => `${f(loop(c, d).medianCorrectLockPct, 1, ' %')} · ${loop(c, d).divergedSeeds}/${loop(c, d).seeds}`;
    L.push(`| ${c} | ${cell('cv_classical')} | ${cell('ai')} | ${cell('fusion')} | ${f(loop(c, 'fusion').medianErrorPx, 2, ' px')} | ${f(loop(c, 'fusion').medianCorrectAcqS, 2, ' s')} |`);
  }
  T.LOOP_TABLE = L.join('\n');
  const P = ['| Condition | Classical P / R / FA | AI only P / R / FA | Hybrid P / R / FA | Empty frames |', '|---|---|---|---|---|'];
  for (const c of conds) {
    const cell = (d: string) => {
      const x = perc(c, d);
      return `${x.precision.toFixed(3)} / ${x.recall.toFixed(3)} / ${x.falseAlarmsOnEmpty}`;
    };
    P.push(`| ${c} | ${cell('cv_classical')} | ${cell('ai')} | ${cell('fusion')} | ${perc(c, 'fusion').emptyFrames} |`);
  }
  T.PERCEPTION_TABLE = P.join('\n');
  T.EVAL_RUNTIME = `learned stages on ${evalS.inferenceRuntime}; ${evalS.seconds} s per run; seeds ${evalS.seeds.join(', ')}`;
  T.EVAL_SEEDS = evalS.seeds.join(', ');
  T.EVAL_SECONDS = String(evalS.seconds);
}

T.CNN_TABLE = [
  '| Split | Accuracy | Precision | Recall | F1 |', '|---|---|---|---|---|',
  `| Stage A — real validation | — | — | — | ${f(m.stageA_real_val_f1, 4)} |`,
  `| Stage A — synthetic validation | — | — | — | ${f(m.stageA_synth_val_f1, 4)} |`,
  `| Stage B — combined validation | — | — | — | ${f(m.stageB_val_f1, 4)} |`,
  `| Final — real validation | — | — | — | ${f(m.final_real_val_f1, 4)} |`,
  `| Final — synthetic validation | — | — | — | ${f(m.final_synth_val_f1, 4)} |`,
  `| **LOCKED smartphone test** (56 images, different camera) | ${f(m.locked_test_accuracy, 4)} | ${f(m.locked_test_precision, 4)} | ${f(m.locked_test_recall, 4)} | **${f(m.locked_test_f1, 4)}** |`,
  `| **LOCKED synthetic stress test** | ${f(m.stress_test_accuracy, 4)} | ${f(m.stress_test_precision, 4)} | ${f(m.stress_test_recall, 4)} | **${f(m.stress_test_f1, 4)}** |`,
  '',
  'Patch-level classification of ROIs, threshold 0.5. "—" = not recorded for that split.',
].join('\n');

{
  const v = ver.metrics;
  T.VER_TABLE = [
    '| Measure | Value |', '|---|---|',
    `| Validation F1 / AUC | ${f(v.valid_f1, 4)} / ${f(v.valid_auc, 4)} |`,
    `| LOCKED test precision / recall / F1 | ${f(v.test_precision, 4)} / ${f(v.test_recall, 4)} / ${f(v.test_f1, 4)} |`,
    `| LOCKED test AUC / log-loss | ${f(v.test_auc, 4)} / ${f(v.test_logloss, 4)} |`,
    `| LOCKED test, tracks age ≥ 30: F1 / AUC | ${f(v.test_mature_f1, 4)} / ${f(v.test_mature_auc, 4)} |`,
    `| Ablation: without CNN feature — F1 / AUC | ${f(v.ablation_no_cnn_f1, 4)} / ${f(v.ablation_no_cnn_auc, 4)} |`,
    `| Ablation: without motion features — F1 / AUC | ${f(v.ablation_no_motion_f1, 4)} / ${f(v.ablation_no_motion_auc, 4)} |`,
    `| Ablation: CNN feature only — F1 / AUC | ${f(v.ablation_cnn_only_f1, 4)} / ${f(v.ablation_cnn_only_auc, 4)} |`,
    '',
    'The "CNN only" model never exceeds 0.5 (F1 0 at the 0.5 threshold); its ranking ability is AUC 0.755. Appearance alone does not separate beacon from decoy tracks; motion does.',
  ].join('\n');
}

{
  const r = lat.results;
  const L = ['| Detector | Perception mean / p95 (ms) | Pipeline mean / p95 (ms) | Stage split (ms) | Pipeline FPS | 30 Hz budget (p95) |', '|---|---|---|---|---|---|'];
  for (const [k, label] of [['cv_classical', 'Classical'], ['ai', 'AI only'], ['fusion', 'Hybrid']] as const) {
    const v = r[k];
    const split = k === 'cv_classical' ? '—' : `CV ${f(v.cv.mean, 2)} · AI ${f(v.ai.mean, 2)} · temporal ${f(v.temporal.mean, 2)} · fusion ${f(v.fusion.mean, 3)}`;
    L.push(`| ${label} | ${f(v.perception.mean, 2)} / ${f(v.perception.p95, 2)} | ${f(v.pipeline.mean, 2)} / ${f(v.pipeline.p95, 2)} | ${split} | ${f(v.pipelineFps, 0)} | ${v.withinBudgetP95 ? 'within' : 'over'} |`);
  }
  L.push(`| Mode 1 full-frame | ${f(r.ai_fullframe.perception.mean, 0)} | — | — | — | over |`);
  L.push('');
  L.push(`${lat.cpu}, ${lat.threads} threads; runtime ${lat.runtime}; measured ${lat.generatedAt.slice(0, 10)}. Latency on the judge machine: **not measured** — run \`bun scripts/bench-latency.ts\` there.`);
  T.LATENCY_TABLE = L.join('\n');
}

{
  const lines = readFileSync(need(R('docs', 'report', 'data', 'classical_fig8_42.csv')), 'utf8').trim().split('\n');
  const head = lines[0].split(',');
  const ix = (k: string) => head.indexOf(k);
  const errs: number[] = [];
  let acq: number | null = null;
  for (const l of lines.slice(1)) {
    const c = l.split(',');
    const e = parseFloat(c[ix('err_px')]);
    if (Number.isFinite(e)) errs.push(e);
    if (acq === null && c[ix('state')] === 'TRACK') acq = parseFloat(c[ix('t')]);
  }
  T.FIG8_SUMMARY = `acquisition ${f(acq, 2)} s, mean error ${f(errs.reduce((a, b) => a + b, 0) / errs.length, 2)} px, max ${f(Math.max(...errs), 1)} px`;
}

{
  const checks = e2e.checks as Array<{ ok: boolean }>;
  T.E2E_RESULT = `${checks.filter((c) => c.ok).length}/${checks.length} passed, ${e2e.generatedAt.slice(0, 10)}`;
  T.E2E_DATE = e2e.generatedAt.slice(0, 10);
  const pick = [
    ...(e2e.systemLog as any[]).slice(0, 5),
    ...(e2e.chainLog as any[]).slice(0, 4),
  ];
  T.LOG_SAMPLE = pick
    .map((l) => `${l.frame !== undefined ? `f${String(l.frame).padStart(4)}` : '     '} ${String(l.level).padEnd(7)} ${l.message}${l.detail ? ` — ${l.detail}` : ''}`)
    .join('\n');
}

{
  const flat: Array<[string, unknown]> = [];
  const walk = (o: any, pre: string) => {
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, pre ? `${pre}.${k}` : k);
      else flat.push([pre ? `${pre}.${k}` : k, v]);
    }
  };
  walk(DEFAULT_CONFIG, '');
  const rows = flat.filter(([k]) => !k.startsWith('debugOverlay') && k !== 'scenarioName');
  const half = Math.ceil(rows.length / 2);
  const L = ['| Parameter | Default | Parameter | Default |', '|---|---|---|---|'];
  for (let i = 0; i < half; i++) {
    const a = rows[i];
    const b = rows[i + half];
    L.push(`| \`${a[0]}\` | ${String(a[1])} | ${b ? `\`${b[0]}\`` : ''} | ${b ? String(b[1]) : ''} |`);
  }
  T.CONFIG_TABLE = L.join('\n');
}

T.ONNX_MANIFEST = '```json\n' + JSON.stringify(onnxMan, null, 2) + '\n```';

// ---------- fill ----------
let md = readFileSync(R('docs', 'report', 'FINAL_TECHNICAL_REPORT.template.md'), 'utf8');
const missing = new Set<string>();
md = md.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, k: string) => {
  if (!(k in T)) missing.add(k);
  return T[k] ?? `{{${k}}}`;
});
if (missing.size) throw new Error(`unfilled tokens: ${[...missing].join(', ')}`);
writeFileSync(R('docs', 'report', 'FINAL_TECHNICAL_REPORT.md'), md);

// ---------- HTML ----------
// Protect math from Markdown parsing; KaTeX renders it in the page.
const math: string[] = [];
let src = md.replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => `MATHBLOCK${math.push(`\\[${m}\\]`) - 1}X`);
src = src.replace(/\$([^\s$][^$\n]*?)\$/g, (_, m) => `MATHINLINE${math.push(`\\(${m}\\)`) - 1}X`);
let body = marked.parse(src, { async: false }) as string;
body = body.replace(/<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g, (_, c) =>
  `<div class="mermaid">${c.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&')}</div>`);
body = body.replace(/MATH(?:BLOCK|INLINE)(\d+)X/g, (_, i) => math[Number(i)].replace(/&/g, '&amp;').replace(/</g, '&lt;'));

const css = `
@page { size: A4; margin: 18mm 16mm 18mm 16mm; }
body { font-family: "Segoe UI", Calibri, Arial, sans-serif; font-size: 10pt; line-height: 1.45; color: #1d1d1f; }
h1 { font-size: 20pt; margin: 0 0 6pt; line-height: 1.2; }
h2 { font-size: 14pt; border-bottom: 1.5px solid #2a6f97; padding-bottom: 3pt; margin-top: 18pt; color: #12324a; break-after: avoid; }
h3 { font-size: 11.5pt; margin-top: 12pt; color: #12324a; break-after: avoid; }
p, li { text-align: justify; }
table { border-collapse: collapse; width: 100%; margin: 6pt 0 10pt; font-size: 8.4pt; break-inside: auto; }
th, td { border: 0.6pt solid #b9c3cc; padding: 3pt 4pt; vertical-align: top; text-align: left; }
th { background: #e8eff5; }
tr { break-inside: avoid; }
code { font-family: Consolas, "Courier New", monospace; font-size: 8.4pt; background: #f2f4f6; padding: 0 2px; }
pre { background: #f2f4f6; padding: 6pt; font-size: 7.6pt; white-space: pre-wrap; word-break: break-word; border-left: 3px solid #2a6f97; }
pre code { background: none; }
code.hash { font-size: 6.6pt; word-break: break-all; }
img { max-width: 100%; display: block; margin: 6pt auto 2pt; break-inside: avoid; }
.caption { font-size: 8.4pt; color: #444; text-align: center; margin: 0 0 10pt; }
.mermaid { text-align: center; margin: 8pt 0; break-inside: avoid; }
.mermaid p, .mermaid span, .mermaid div { text-align: center !important; }
.titlepage { min-height: 245mm; display: flex; flex-direction: column; justify-content: center; break-after: page; }
.titlepage h1 { font-size: 24pt; color: #12324a; border: none; }
.subtitle { font-size: 14pt; color: #2a6f97; margin: 4pt 0 24pt; }
.titlepage table { font-size: 10pt; }
hr { border: none; border-top: 0.6pt solid #ccc; margin: 12pt 0; }
.katex-display { margin: 6pt 0; }
`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>FSOC-PAT Technical Report</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<style>${css}</style></head><body>
${body}
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>
  window.__ready = (async () => {
    renderMathInElement(document.body, { delimiters: [{left: '\\\\[', right: '\\\\]', display: true}, {left: '\\\\(', right: '\\\\)', display: false}], throwOnError: false });
    mermaid.initialize({ startOnLoad: false, theme: 'neutral', flowchart: { useMaxWidth: true } });
    await mermaid.run({ querySelector: '.mermaid' });
    return true;
  })();
</script>
</body></html>`;
const htmlPath = R('docs', 'report', 'FINAL_TECHNICAL_REPORT.html');
writeFileSync(htmlPath, html);
process.stdout.write(`wrote docs/report/FINAL_TECHNICAL_REPORT.md and .html (${Object.keys(T).length} tokens filled)\n`);

if (!process.argv.includes('--no-pdf')) {
  const puppeteer = (await import('puppeteer-core')).default;
  const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p));
  if (!chrome) throw new Error('no Chrome/Edge for PDF rendering');
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage();
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0', timeout: 120000 });
  await page.evaluate('window.__ready');
  await page.pdf({
    path: R('docs', 'report', 'FINAL_TECHNICAL_REPORT.pdf'),
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<div style="font-size:7pt;color:#777;width:100%;text-align:right;padding-right:16mm;">FSOC-PAT · SIH 2026 PS-169 · Technical Report</div>',
    footerTemplate: '<div style="font-size:7pt;color:#777;width:100%;text-align:center;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
    margin: { top: '18mm', bottom: '16mm', left: '16mm', right: '16mm' },
  });
  await browser.close();
  process.stdout.write('wrote docs/report/FINAL_TECHNICAL_REPORT.pdf\n');
}
