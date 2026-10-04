"""
Train the learned track verifier (AI plan Phases 4, 7, 9, 15).

Input: datasets/tracks/{train,valid,test}.csv from scripts/ai/gen-track-dataset.ts
       — one row per (candidate track, frame): the eight TRACK_FEATURES, the
       label (1 = this track is the beacon), recipe id and track age.

Model: MLP 8 -> 12 -> 1 (ReLU, sigmoid), inputs standardised with mean/std
       fitted on TRAIN only. Mirrored in src/engine/track-verifier.ts;
       tests/ai-parity.test.ts pins the two together.

MODEL SELECTION USES THE VALIDATION SPLIT ONLY. `test` comes from a disjoint
seed range and is LOCKED: read once at the end to report a number.

ABLATIONS. The same recipe is re-trained with feature groups removed, so the
docs can say what each source of evidence is actually worth rather than
asserting it:
    no_cnn      the CNN appearance feature zeroed
    no_motion   the three world-motion features zeroed
    cnn_only    only the CNN appearance feature

Usage:  python scripts/ai/train_track_verifier.py [--epochs 30] [--seed 3]
Writes: public/models/track-verifier-v1.json
        tests/fixtures/track-verifier-parity.json
"""
import argparse
import datetime
import json
import os

import numpy as np
import torch
import torch.nn as nn

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
DATA = os.path.join(ROOT, 'datasets', 'tracks')
MODEL_DIR = os.path.join(ROOT, 'public', 'models')
FIXTURE = os.path.join(ROOT, 'tests', 'fixtures', 'track-verifier-parity.json')
NAME = 'track-verifier-v1'

# Mirrored in src/engine/candidate-tracks.ts TRACK_FEATURES.
FEATURES = ['ai_mean', 'cv_mean', 'size_mean', 'bright_mean', 'speed',
            'speed_reliability', 'moving_evidence', 'persistence']
HIDDEN = 12


class Verifier(nn.Module):
    def __init__(self, n):
        super().__init__()
        self.fc1 = nn.Linear(n, HIDDEN)
        self.fc2 = nn.Linear(HIDDEN, 1)

    def forward(self, x):
        return self.fc2(torch.relu(self.fc1(x))).squeeze(1)


def load(split):
    path = os.path.join(DATA, split + '.csv')
    with open(path) as f:
        header = f.readline().strip().split(',')
    assert header[:len(FEATURES)] == FEATURES, f'feature order mismatch in {path}: {header}'
    a = np.loadtxt(path, delimiter=',', skiprows=1, dtype=np.float32)
    X = a[:, :len(FEATURES)]
    y = a[:, len(FEATURES)]
    age = a[:, len(FEATURES) + 2]
    return X, y, age


def metrics(p, y, thresh=0.5):
    pred = (p >= thresh).astype(np.float32)
    tp = float(((pred == 1) & (y == 1)).sum())
    fp = float(((pred == 1) & (y == 0)).sum())
    fn = float(((pred == 0) & (y == 1)).sum())
    tn = float(((pred == 0) & (y == 0)).sum())
    prec = tp / max(1.0, tp + fp)
    rec = tp / max(1.0, tp + fn)
    f1 = 2 * prec * rec / max(1e-9, prec + rec)
    # ROC AUC by rank statistic (no sklearn dependency)
    order = np.argsort(p)
    ranks = np.empty(len(p))
    ranks[order] = np.arange(1, len(p) + 1)
    npos = y.sum()
    nneg = len(y) - npos
    auc = (ranks[y == 1].sum() - npos * (npos + 1) / 2) / max(1.0, npos * nneg)
    return {'precision': prec, 'recall': rec, 'f1': f1, 'auc': float(auc),
            'tp': tp, 'fp': fp, 'fn': fn, 'tn': tn}


def train(Xtr, ytr, Xva, yva, epochs, seed, mask=None, verbose=True):
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    mean = Xtr.mean(axis=0)
    std = Xtr.std(axis=0)
    std[std < 1e-6] = 1.0
    m = mask if mask is not None else np.ones(len(FEATURES), dtype=np.float32)

    def prep(X):
        return torch.from_numpy(((X - mean) / std) * m).float()

    Xt, Xv = prep(Xtr), prep(Xva)
    yt = torch.from_numpy(ytr).float()
    model = Verifier(len(FEATURES))
    # NO class re-weighting. The decision engine reads this output as a
    # probability (it rejects a track at P <= 0.12 and trusts one at >= 0.75),
    # so it must be calibrated. Re-weighting the positives inflates every
    # output: the first version did, and put a bright static decoy — a
    # situation that is the beacon 8 % of the time in the data — at 0.42.
    lossf = nn.BCEWithLogitsLoss()
    opt = torch.optim.Adam(model.parameters(), lr=3e-3)
    best, best_state, best_ep = float('inf'), None, -1
    yv = torch.from_numpy(yva).float()
    for ep in range(epochs):
        model.train()
        perm = torch.from_numpy(rng.permutation(len(Xt)))
        for i in range(0, len(perm), 1024):
            idx = perm[i:i + 1024]
            opt.zero_grad()
            loss = lossf(model(Xt[idx]), yt[idx])
            loss.backward()
            opt.step()
        with torch.no_grad():
            model.eval()
            zv = model(Xv)
            vloss = float(nn.functional.binary_cross_entropy_with_logits(zv, yv))
            pv = torch.sigmoid(zv).numpy()
        mv = metrics(pv, yva)
        # Validation-only selection, on log-loss: a proper scoring rule, so
        # the chosen epoch is the best-CALIBRATED one, not merely the one with
        # the best F1 at an arbitrary 0.5 threshold.
        if vloss < best:
            best, best_ep = vloss, ep
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
        if verbose and (ep % 5 == 0 or ep == epochs - 1):
            print(f'  epoch {ep:3d}  val logloss {vloss:.4f}  F1 {mv["f1"]:.4f}  AUC {mv["auc"]:.4f}')
    model.load_state_dict(best_state)
    if verbose:
        print(f'  best epoch {best_ep} (val log-loss {best:.4f}) restored')
    return model, mean, std, m


@torch.no_grad()
def predict(model, X, mean, std, m):
    model.eval()
    return torch.sigmoid(model(torch.from_numpy(((X - mean) / std) * m).float())).numpy()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--epochs', type=int, default=30)
    ap.add_argument('--seed', type=int, default=3)
    a = ap.parse_args()

    Xtr, ytr, _ = load('train')
    Xva, yva, _ = load('valid')
    print(f'train {len(ytr)} samples ({int(ytr.sum())} beacon) | '
          f'valid {len(yva)} ({int(yva.sum())} beacon)')

    print('\n--- full model ---')
    model, mean, std, mask = train(Xtr, ytr, Xva, yva, a.epochs, a.seed)
    val = metrics(predict(model, Xva, mean, std, mask), yva)

    # ---- LOCKED test. Read once. ----
    Xte, yte, age_te = load('test')
    pte = predict(model, Xte, mean, std, mask)
    test = metrics(pte, yte)
    mature = age_te >= 30
    test_mature = metrics(pte[mature], yte[mature])
    print('\n=== LOCKED TEST (disjoint recipes, never selected on) ===')
    print(f'  all tracks        P {test["precision"]:.4f}  R {test["recall"]:.4f}  '
          f'F1 {test["f1"]:.4f}  AUC {test["auc"]:.4f}')
    print(f'  tracks age >= 30  P {test_mature["precision"]:.4f}  R {test_mature["recall"]:.4f}  '
          f'F1 {test_mature["f1"]:.4f}  AUC {test_mature["auc"]:.4f}')

    # Calibration on the locked test: mean predicted P vs observed rate.
    bins = np.linspace(0, 1, 6)
    calib = []
    print('\n  calibration (locked test): predicted -> observed')
    for lo, hi in zip(bins[:-1], bins[1:]):
        sel = (pte >= lo) & (pte < hi if hi < 1 else pte <= hi)
        if sel.sum() > 0:
            calib.append([round(float(pte[sel].mean()), 3), round(float(yte[sel].mean()), 3), int(sel.sum())])
            print(f'    {lo:.1f}-{hi:.1f}: mean P {pte[sel].mean():.3f}  observed {yte[sel].mean():.3f}  (n={int(sel.sum())})')

    # ---- Ablations (validation-selected, reported on the locked test) ----
    idx = {f: i for i, f in enumerate(FEATURES)}
    ablations = {
        'no_cnn': [idx['ai_mean']],
        'no_motion': [idx['speed'], idx['speed_reliability'], idx['moving_evidence']],
        'cnn_only': [i for f, i in idx.items() if f != 'ai_mean'],
    }
    abl = {}
    print('\n--- ablations (locked test) ---')
    for name, drop in ablations.items():
        mk = np.ones(len(FEATURES), dtype=np.float32)
        mk[drop] = 0.0
        am, amean, astd, amask = train(Xtr, ytr, Xva, yva, a.epochs, a.seed, mask=mk, verbose=False)
        r = metrics(predict(am, Xte, amean, astd, amask), yte)
        abl[name] = {'f1': round(r['f1'], 4), 'auc': round(r['auc'], 4),
                     'precision': round(r['precision'], 4), 'recall': round(r['recall'], 4)}
        print(f'  {name:10s} F1 {r["f1"]:.4f}  AUC {r["auc"]:.4f}')

    # ---- Export ----
    sd = model.state_dict()
    out = {
        'name': NAME,
        'features': FEATURES,
        'mean': [float(v) for v in mean],
        'std': [float(v) for v in std],
        'hidden': HIDDEN,
        'w1': sd['fc1.weight'].numpy().astype(float).tolist(),
        'b1': sd['fc1.bias'].numpy().astype(float).tolist(),
        'w2': sd['fc2.weight'].numpy()[0].astype(float).tolist(),
        'b2': float(sd['fc2.bias'].numpy()[0]),
        'metrics': {
            'valid_f1': round(val['f1'], 4),
            'valid_auc': round(val['auc'], 4),
            'test_precision': round(test['precision'], 4),
            'test_recall': round(test['recall'], 4),
            'test_f1': round(test['f1'], 4),
            'test_auc': round(test['auc'], 4),
            'test_mature_f1': round(test_mature['f1'], 4),
            'test_mature_auc': round(test_mature['auc'], 4),
            'test_logloss': round(float(-np.mean(yte * np.log(np.clip(pte, 1e-6, 1)) + (1 - yte) * np.log(np.clip(1 - pte, 1e-6, 1)))), 4),
            **{f'ablation_{k}_f1': v['f1'] for k, v in abl.items()},
            **{f'ablation_{k}_auc': v['auc'] for k, v in abl.items()},
        },
        'calibration': calib,
        'trainedOn': 'datasets/tracks/train.csv — candidate tracks harvested from '
                     'the shipped SimulationRunner by scripts/ai/gen-track-dataset.ts',
        'createdAt': datetime.datetime.now(datetime.timezone.utc)
                        .replace(microsecond=0).isoformat(),
    }
    os.makedirs(MODEL_DIR, exist_ok=True)
    with open(os.path.join(MODEL_DIR, NAME + '.json'), 'w') as f:
        json.dump(out, f, indent=1)

    # Parity fixture: raw feature rows + PyTorch scores.
    rng = np.random.default_rng(5)
    pick = rng.choice(len(Xte), size=32, replace=False)
    with open(FIXTURE, 'w') as f:
        json.dump({
            'model': NAME,
            'note': 'Written by scripts/ai/train_track_verifier.py. '
                    'tests/ai-parity.test.ts runs these rows through '
                    'src/engine/track-verifier.ts and requires the same scores.',
            'rows': [[float(v) for v in Xte[i]] for i in pick],
            'scores': [float(pte[i]) for i in pick],
        }, f)
    print(f'\nWrote public/models/{NAME}.json and the parity fixture.')


if __name__ == '__main__':
    main()
