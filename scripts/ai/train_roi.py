"""
Two-stage training for TinyBeaconNet (AI plan Phases 2, 4, 13, 15).

  Stage A   real Zenodo laser data        -> real optical-spot appearance
  Stage B   fine-tune on real + synthetic -> the PS-169 domain

The architecture is mirrored EXACTLY in src/engine/nn.ts. If you change a
layer here, change it there; tests/ai-parity.test.ts compares the two
implementations against a fixture written by this script and fails on drift.

MODEL SELECTION USES VALIDATION SPLITS ONLY. The two LOCKED test sets — the
56-image smartphone set (real_test) and the unseen synthetic stress
scenarios (synth_stress_test, AI plan Phase 15) — are loaded once, at the very
end, and only to report a number.
Nothing here reads it to choose an epoch, a threshold or a hyperparameter —
that is the whole point of keeping it locked.

Usage:
    python scripts/ai/train_roi.py [--epochs-a 40] [--epochs-b 40] [--seed 7]

Writes:
    public/models/beacon-roi-v2.bin        little-endian Float32 weights
    public/models/beacon-roi-v2.json       manifest + measured metrics
    tests/fixtures/ai-parity.json          patches + scores for the TS parity test
"""
import argparse
import json
import os
import sys
import datetime
import numpy as np
import torch
import torch.nn as nn

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import PATCH  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
ROI_DIR = os.path.join(ROOT, 'datasets', 'roi')
MODEL_DIR = os.path.join(ROOT, 'public', 'models')
FIXTURE_DIR = os.path.join(ROOT, 'tests', 'fixtures')
MODEL_NAME = 'beacon-roi-v2'

C1, C2, C3, HIDDEN = 8, 12, 16, 16


class TinyBeaconNet(nn.Module):
    """~3k parameters. Small on purpose: it has to run 12 times per frame, in
    JavaScript, inside the same worker as the rest of the engine, at 30 Hz."""

    def __init__(self):
        super().__init__()
        self.conv1 = nn.Conv2d(1, C1, 3, padding=1)
        self.conv2 = nn.Conv2d(C1, C2, 3, padding=1)
        self.conv3 = nn.Conv2d(C2, C3, 3, padding=1)
        self.fc1 = nn.Linear(C3, HIDDEN)
        self.fc2 = nn.Linear(HIDDEN, 1)
        self.pool = nn.MaxPool2d(2, 2)
        self.relu = nn.ReLU()

    def forward(self, x):
        x = self.pool(self.relu(self.conv1(x)))
        x = self.pool(self.relu(self.conv2(x)))
        x = self.relu(self.conv3(x))
        x = x.mean(dim=(2, 3))  # global average pool
        x = self.relu(self.fc1(x))
        return self.fc2(x).squeeze(1)


def load(split):
    d = np.load(os.path.join(ROI_DIR, split + '.npz'))
    X = torch.from_numpy(d['patches']).float().unsqueeze(1)
    y = torch.from_numpy(d['labels']).float()
    return X, y


def augment(X, rng):
    """
    Dihedral flips/rotations plus amplitude and additive-noise jitter.

    Flips and 90-degree rotations are safe here because an optical spot has no
    canonical orientation. Amplitude jitter covers beacon intensity and
    atmospheric attenuation; additive noise covers the sensor-noise axis.
    """
    out = X.clone()
    k = rng.integers(0, 4, size=len(X))
    fl = rng.integers(0, 2, size=len(X))
    for i in range(len(X)):
        if k[i]:
            out[i] = torch.rot90(out[i], int(k[i]), dims=(1, 2))
        if fl[i]:
            out[i] = torch.flip(out[i], dims=(2,))
    amp = torch.from_numpy(rng.uniform(0.75, 1.3, size=(len(X), 1, 1, 1))).float()
    out = out * amp
    noise = torch.from_numpy(
        rng.normal(0, 0.035, size=out.shape)).float()
    return out + noise


@torch.no_grad()
def evaluate(model, X, y, thresh=0.5):
    model.eval()
    logits = []
    for i in range(0, len(X), 4096):
        logits.append(model(X[i:i + 4096]))
    p = torch.sigmoid(torch.cat(logits))
    pred = (p >= thresh).float()
    tp = float(((pred == 1) & (y == 1)).sum())
    fp = float(((pred == 1) & (y == 0)).sum())
    fn = float(((pred == 0) & (y == 1)).sum())
    tn = float(((pred == 0) & (y == 0)).sum())
    acc = (tp + tn) / max(1.0, tp + tn + fp + fn)
    prec = tp / max(1.0, tp + fp)
    rec = tp / max(1.0, tp + fn)
    f1 = 2 * prec * rec / max(1e-9, prec + rec)
    return {'accuracy': acc, 'precision': prec, 'recall': rec, 'f1': f1,
            'tp': tp, 'fp': fp, 'fn': fn, 'tn': tn}


def train_stage(model, Xtr, ytr, Xva, yva, epochs, lr, seed, label):
    rng = np.random.default_rng(seed)
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)
    lossf = nn.BCEWithLogitsLoss()
    best_f1, best_state, best_epoch = -1.0, None, -1
    print(f'\n--- {label}: {len(Xtr)} train / {len(Xva)} val patches, {epochs} epochs ---')
    for ep in range(epochs):
        model.train()
        perm = torch.from_numpy(rng.permutation(len(Xtr)))
        total = 0.0
        for i in range(0, len(perm), 256):
            idx = perm[i:i + 256]
            xb = augment(Xtr[idx], rng)
            yb = ytr[idx]
            opt.zero_grad()
            loss = lossf(model(xb), yb)
            loss.backward()
            opt.step()
            total += float(loss) * len(idx)
        sched.step()
        m = evaluate(model, Xva, yva)
        # Selection on the VALIDATION split only.
        if m['f1'] > best_f1:
            best_f1, best_epoch = m['f1'], ep
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
        if ep % 5 == 0 or ep == epochs - 1:
            print(f'  epoch {ep:3d}  loss {total / len(Xtr):.4f}  '
                  f'val acc {m["accuracy"]:.4f}  P {m["precision"]:.4f}  '
                  f'R {m["recall"]:.4f}  F1 {m["f1"]:.4f}')
    model.load_state_dict(best_state)
    print(f'  best epoch {best_epoch} (val F1 {best_f1:.4f}) restored')
    return best_f1


def export_weights(model):
    """Flatten in the exact order src/engine/nn.ts reads them."""
    sd = model.state_dict()
    order = ['conv1.weight', 'conv1.bias', 'conv2.weight', 'conv2.bias',
             'conv3.weight', 'conv3.bias', 'fc1.weight', 'fc1.bias',
             'fc2.weight', 'fc2.bias']
    parts = [sd[k].detach().cpu().numpy().astype('<f4').ravel() for k in order]
    return np.concatenate(parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--epochs-a', type=int, default=40)
    ap.add_argument('--epochs-b', type=int, default=40)
    ap.add_argument('--seed', type=int, default=7)
    a = ap.parse_args()

    torch.manual_seed(a.seed)
    np.random.seed(a.seed)

    Xr, yr = load('real_train')
    Xrv, yrv = load('real_valid')
    Xs, ys = load('synth_train')
    Xsv, ysv = load('synth_valid')

    model = TinyBeaconNet()
    n_params = sum(p.numel() for p in model.parameters())
    print(f'TinyBeaconNet: {n_params} parameters')

    # ---- Stage A: real optical-spot appearance ----
    f1_a = train_stage(model, Xr, yr, Xrv, yrv, a.epochs_a, 2e-3, a.seed,
                       'STAGE A  real Zenodo laser data')
    stage_a_real = evaluate(model, Xrv, yrv)
    stage_a_synth = evaluate(model, Xsv, ysv)
    print(f'  after Stage A: real val F1 {stage_a_real["f1"]:.4f}, '
          f'synthetic val F1 {stage_a_synth["f1"]:.4f}')

    # ---- Stage B: fine-tune into the FSOC domain ----
    # Real data is kept in the mixture rather than discarded: training Stage B
    # on synthetic alone lets the model forget the real-spot appearance that
    # Stage A paid for, which is the failure the two-stage plan exists to avoid.
    Xmix = torch.cat([Xr, Xs])
    ymix = torch.cat([yr, ys])
    Xvalmix = torch.cat([Xrv, Xsv])
    yvalmix = torch.cat([yrv, ysv])
    f1_b = train_stage(model, Xmix, ymix, Xvalmix, yvalmix, a.epochs_b, 1e-3,
                       a.seed + 1, 'STAGE B  real + synthetic FSOC')

    final_real_val = evaluate(model, Xrv, yrv)
    final_synth_val = evaluate(model, Xsv, ysv)

    # ---- LOCKED test set. Read once. Reported, never optimised against. ----
    Xt, yt = load('real_test')
    locked = evaluate(model, Xt, yt)
    print('\n=== LOCKED TEST (56 smartphone images, never trained or selected on) ===')
    print(f'  accuracy {locked["accuracy"]:.4f}  precision {locked["precision"]:.4f}  '
          f'recall {locked["recall"]:.4f}  F1 {locked["f1"]:.4f}')
    print(f'  tp {locked["tp"]:.0f}  fp {locked["fp"]:.0f}  '
          f'fn {locked["fn"]:.0f}  tn {locked["tn"]:.0f}')

    stress = None
    if os.path.exists(os.path.join(ROI_DIR, 'synth_stress_test.npz')):
        Xst, yst = load('synth_stress_test')
        stress = evaluate(model, Xst, yst)
        print('\n=== LOCKED STRESS TEST (unseen synthetic stress scenarios) ===')
        print(f'  accuracy {stress["accuracy"]:.4f}  precision {stress["precision"]:.4f}  '
              f'recall {stress["recall"]:.4f}  F1 {stress["f1"]:.4f}')

    # ---- Export ----
    os.makedirs(MODEL_DIR, exist_ok=True)
    w = export_weights(model)
    with open(os.path.join(MODEL_DIR, MODEL_NAME + '.bin'), 'wb') as f:
        f.write(w.tobytes())

    manifest = {
        'name': MODEL_NAME,
        'architecture':
            'conv3x3(1->8)-pool-conv3x3(8->12)-pool-conv3x3(12->16)-GAP-fc16-fc1',
        'paramCount': int(n_params),
        'patch': PATCH,
        'trainedOn': [
            'Zenodo laser-spot dataset, Intel D435 split (309 train / 76 valid images)',
            'FSOC synthetic dataset generated by scripts/gen-synthetic-dataset.ts '
            '(incl. optical blur and exposure smear)',
        ],
        'metrics': {
            'stageA_real_val_f1': round(stage_a_real['f1'], 4),
            'stageA_synth_val_f1': round(stage_a_synth['f1'], 4),
            'stageB_val_f1': round(f1_b, 4),
            'final_real_val_f1': round(final_real_val['f1'], 4),
            'final_synth_val_f1': round(final_synth_val['f1'], 4),
            'locked_test_accuracy': round(locked['accuracy'], 4),
            'locked_test_precision': round(locked['precision'], 4),
            'locked_test_recall': round(locked['recall'], 4),
            'locked_test_f1': round(locked['f1'], 4),
            **({
                'stress_test_accuracy': round(stress['accuracy'], 4),
                'stress_test_precision': round(stress['precision'], 4),
                'stress_test_recall': round(stress['recall'], 4),
                'stress_test_f1': round(stress['f1'], 4),
            } if stress is not None else {}),
        },
        'createdAt': datetime.datetime.now(datetime.timezone.utc)
                        .replace(microsecond=0).isoformat(),
        'note':
            'Patch-level metrics on held-out ROI crops. These are NOT the '
            'end-to-end PAT gates; those are measured by scripts/batch-test.ts '
            'and scripts/eval-detectors.ts on the closed loop.',
    }
    with open(os.path.join(MODEL_DIR, MODEL_NAME + '.json'), 'w') as f:
        json.dump(manifest, f, indent=2)

    # ---- Parity fixture for the TypeScript implementation ----
    os.makedirs(FIXTURE_DIR, exist_ok=True)
    rng = np.random.default_rng(99)
    idx = rng.choice(len(Xt), size=24, replace=False)
    with torch.no_grad():
        model.eval()
        scores = torch.sigmoid(model(Xt[idx])).numpy()
    fixture = {
        'model': MODEL_NAME,
        'note': 'Written by scripts/ai/train_roi.py. tests/ai-parity.test.ts '
                'runs these same normalised patches through src/engine/nn.ts '
                'and requires the scores to match, so the shipped TypeScript '
                'forward pass cannot silently drift from the trained model.',
        'patches': [Xt[i, 0].numpy().round(6).ravel().tolist() for i in idx],
        'scores': [float(s) for s in scores],
    }
    with open(os.path.join(FIXTURE_DIR, 'ai-parity.json'), 'w') as f:
        json.dump(fixture, f)

    print(f'\nWrote {MODEL_NAME}.bin ({w.nbytes} bytes, {len(w)} floats) '
          f'+ manifest to public/models/')
    print(f'Stage A val F1 {f1_a:.4f} -> Stage B val F1 {f1_b:.4f}')


if __name__ == '__main__':
    main()
