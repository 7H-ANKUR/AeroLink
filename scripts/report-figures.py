"""
Figures for the technical report — drawn ONLY from measured artefacts:

  docs/report/data/*.csv                         (scripts/report-timeseries.ts)
  benchmark-results/detector-comparison/summary.json   (scripts/eval-resumable.sh)
  benchmark-results/latency-<host>.json          (scripts/bench-latency.ts)
  benchmark-results/<latest PS-169 run>/aggregate.json (scripts/batch-test.ts)
  public/models/track-verifier-v1.json, beacon-roi-v2.json

Usage:  python scripts/report-figures.py
Writes: docs/report/figures/*.png
"""
import csv
import glob
import json
import os

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
DATA = os.path.join(ROOT, 'docs', 'report', 'data')
FIG = os.path.join(ROOT, 'docs', 'report', 'figures')
os.makedirs(FIG, exist_ok=True)

plt.rcParams.update({
    'font.size': 9, 'axes.titlesize': 10, 'axes.labelsize': 9, 'legend.fontsize': 8,
    'figure.dpi': 150, 'axes.grid': True, 'grid.alpha': 0.3, 'axes.spines.top': False,
    'axes.spines.right': False,
})
C_CV, C_AI, C_HY, C_GT = '#4c72b0', '#dd8452', '#2a9d5c', '#555555'


def load(name):
    with open(os.path.join(DATA, name + '.csv')) as f:
        rows = list(csv.DictReader(f))
    def col(k):
        out = []
        for r in rows:
            v = r[k]
            out.append(float(v) if v not in ('', None) else float('nan'))
        return out
    return rows, col


def save(name):
    plt.tight_layout()
    plt.savefig(os.path.join(FIG, name), bbox_inches='tight')
    plt.close()


# ---- Fig 1: tracking error vs time, classical vs hybrid, same decoy scene ----
_, hy = load('hybrid_decoys_4402')
_, cv = load('classical_decoys_4402')
plt.figure(figsize=(7.2, 2.8))
plt.plot(cv('t'), cv('err_px'), color=C_CV, lw=1, label='Classical CV')
plt.plot(hy('t'), hy('err_px'), color=C_HY, lw=1, label='Hybrid CV + AI + temporal (ONNX Runtime Web)')
plt.axhline(10, color='k', ls='--', lw=0.8, label='PS-169 target 10 px')
plt.yscale('log')
plt.xlabel('time (s)')
plt.ylabel('tracking error (px, log)')
plt.title('Bright decoys, seed 4402: beacon starts outside the FOV, a decoy is in view')
plt.legend(loc='upper right')
save('fig01_error_decoys.png')

# ---- Fig 2: target (ground truth) vs estimate, hybrid ----
plt.figure(figsize=(7.2, 2.8))
plt.plot(hy('t'), hy('gt_x'), color=C_GT, lw=1.2, label='ground truth x (scoring only)')
plt.plot(hy('t'), hy('est_x'), color=C_HY, lw=0.9, ls='--', label='Kalman estimate x')
plt.plot(hy('t'), hy('gt_y'), color='#999999', lw=1.2, label='ground truth y (scoring only)')
plt.plot(hy('t'), hy('est_y'), color=C_AI, lw=0.9, ls='--', label='Kalman estimate y')
plt.xlabel('time (s)')
plt.ylabel('image position (px)')
plt.title('Target vs estimate in the sensor image (hybrid, decoy scene)')
plt.legend(loc='lower right', ncol=2)
save('fig02_target_vs_estimate.png')

# ---- Fig 3: pan / tilt command vs actual mount rate ----
fig, ax = plt.subplots(2, 1, figsize=(7.2, 3.6), sharex=True)
ax[0].plot(hy('t'), hy('cmd_pan'), color=C_CV, lw=0.9, label='PID command')
ax[0].plot(hy('t'), hy('act_pan'), color=C_HY, lw=0.9, ls='--', label='actual mount rate')
ax[0].set_ylabel('pan (°/s)')
ax[0].legend(loc='upper right')
ax[1].plot(hy('t'), hy('cmd_tilt'), color=C_CV, lw=0.9, label='PID command')
ax[1].plot(hy('t'), hy('act_tilt'), color=C_HY, lw=0.9, ls='--', label='actual mount rate')
ax[1].set_ylabel('tilt (°/s)')
ax[1].set_xlabel('time (s)')
ax[0].set_title('Controller command vs achieved mount rate (±5 °/s, 40 °/s² limits)')
save('fig03_pan_tilt.png')

# ---- Fig 4: perception confidences vs time ----
plt.figure(figsize=(7.2, 2.8))
plt.plot(hy('t'), hy('cv_conf'), color=C_CV, lw=0.8, label='CV top confidence')
plt.plot(hy('t'), hy('ai_conf'), color=C_AI, lw=0.8, label='AI (CNN) top score')
plt.plot(hy('t'), hy('track_p'), color=C_HY, lw=1.1, label='track verifier P(beacon), chosen track')
plt.plot(hy('t'), hy('det_conf'), color='k', lw=0.6, alpha=0.6, label='fused confidence')
plt.ylim(-0.02, 1.05)
plt.xlabel('time (s)')
plt.ylabel('confidence / probability')
plt.title('Per-frame confidences, hybrid detector (decoy scene)')
plt.legend(loc='lower right', ncol=2)
save('fig04_confidences.png')

# ---- Fig 5: classical baseline, default scenario ----
_, f8 = load('classical_fig8_42')
plt.figure(figsize=(7.2, 2.4))
plt.plot(f8('t'), f8('err_px'), color=C_CV, lw=0.9)
plt.axhline(10, color='k', ls='--', lw=0.8)
plt.ylim(0, 40)
plt.xlabel('time (s)')
plt.ylabel('tracking error (px)')
plt.title('Default scenario PS169-03 Figure-8 / Clear, classical CV, seed 42')
save('fig05_error_fig8.png')

# ---- Fig 6: correct-lock % by condition and detector ----
s = json.load(open(os.path.join(ROOT, 'benchmark-results', 'detector-comparison', 'summary.json')))
conds = []
for c in s['loop']:
    if c['condition'] not in conds:
        conds.append(c['condition'])
def cell(cond, det, key):
    return next(c[key] for c in s['loop'] if c['condition'] == cond and c['detector'] == det)
import numpy as np  # noqa: E402
x = np.arange(len(conds))
w = 0.27
plt.figure(figsize=(7.4, 3.4))
for i, (det, col, lab) in enumerate([('cv_classical', C_CV, 'Classical'), ('ai', C_AI, 'AI only'), ('fusion', C_HY, 'Hybrid')]):
    vals = [cell(c, det, 'medianCorrectLockPct') or 0 for c in conds]
    plt.bar(x + (i - 1) * w, vals, w, color=col, label=lab)
plt.xticks(x, [c.replace(' (below threshold)', '').replace(' (reacquisition)', '').replace('Optical blur + motion smear', 'Blur + smear') for c in conds], rotation=45, ha='right')
plt.ylabel('median correct-lock (%)')
plt.title('Closed loop: time locked on the TRUE beacon (6 seeds, ONNX Runtime Web)')
plt.legend(ncol=1, loc='center left', bbox_to_anchor=(1.01, 0.5))
save('fig06_correct_lock.png')

# ---- Fig 7: latency per detector (this machine) ----
lat = json.load(open(glob.glob(os.path.join(ROOT, 'benchmark-results', 'latency-*.json'))[0]))
dets = ['cv_classical', 'ai', 'fusion']
means = [lat['results'][d]['pipeline']['mean'] for d in dets]
p95 = [lat['results'][d]['pipeline']['p95'] for d in dets]
plt.figure(figsize=(5.2, 2.6))
xx = np.arange(len(dets))
plt.bar(xx - 0.18, means, 0.36, color=C_HY, label='mean')
plt.bar(xx + 0.18, p95, 0.36, color='#9ccfb0', label='p95')
plt.axhline(1000 / 30, color='k', ls='--', lw=0.8, label='30 Hz budget (33.3 ms)')
plt.xticks(xx, ['Classical', 'AI only', 'Hybrid'])
plt.ylabel('pipeline time per frame (ms)')
plt.title(f"Per-frame latency — {lat['cpu']}")
plt.legend()
save('fig07_latency.png')

# ---- Fig 8: PS-169 14-scenario benchmark (classical) ----
runs = sorted(glob.glob(os.path.join(ROOT, 'benchmark-results', '20*', 'aggregate.json')))
agg = json.load(open(runs[-1]))
names = [sc['id'] for sc in agg['scenarios']]
acq = [sc['mean']['acquisition_s'] for sc in agg['scenarios']]
err = [sc['mean']['avg_error_px'] for sc in agg['scenarios']]
fig, ax = plt.subplots(1, 2, figsize=(7.4, 2.8))
ax[0].bar(names, acq, color=C_CV)
ax[0].axhline(2.0, color='k', ls='--', lw=0.8)
ax[0].set_title('Acquisition time (s), gate ≤ 2 s')
ax[0].tick_params(axis='x', rotation=90)
ax[1].bar(names, err, color=C_CV)
ax[1].axhline(10, color='k', ls='--', lw=0.8)
ax[1].set_title('Average tracking error (px), gate ≤ 10 px')
ax[1].tick_params(axis='x', rotation=90)
save('fig08_ps169_benchmark.png')

# ---- Fig 9: track verifier calibration (locked test) ----
v = json.load(open(os.path.join(ROOT, 'public', 'models', 'track-verifier-v1.json')))
cal = v.get('calibration', [])
plt.figure(figsize=(3.4, 3.0))
plt.plot([0, 1], [0, 1], 'k--', lw=0.8, label='perfect calibration')
plt.plot([c[0] for c in cal], [c[1] for c in cal], 'o-', color=C_HY, label='track verifier')
plt.xlabel('mean predicted P')
plt.ylabel('observed beacon rate')
plt.title('Verifier calibration (locked test)')
plt.legend(loc='upper left')
save('fig09_verifier_calibration.png')

# ---- Fig 10: CNN training stages ----
m = json.load(open(os.path.join(ROOT, 'public', 'models', 'beacon-roi-v2.json')))['metrics']
labels = ['Stage A\nreal val', 'Stage A\nsynthetic val', 'Final\nreal val', 'Final\nsynthetic val', 'LOCKED\nsmartphone test', 'LOCKED\nstress test']
vals = [m['stageA_real_val_f1'], m['stageA_synth_val_f1'], m['final_real_val_f1'], m['final_synth_val_f1'], m['locked_test_f1'], m['stress_test_f1']]
plt.figure(figsize=(6.4, 2.6))
bars = plt.bar(labels, vals, color=[C_AI, C_AI, C_HY, C_HY, '#333333', '#333333'])
for b, val in zip(bars, vals):
    plt.text(b.get_x() + b.get_width() / 2, val + 0.01, f'{val:.3f}', ha='center', fontsize=7)
plt.ylim(0, 1.1)
plt.ylabel('F1')
plt.title('TinyBeaconNet (beacon-roi-v2): F1 after each training stage')
save('fig10_cnn_training.png')

print('figures written to', FIG)
for f in sorted(os.listdir(FIG)):
    print(' ', f)
