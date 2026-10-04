"""
Build ROI-patch datasets for the learned beacon verifier (AI plan Phases 1, 3, 15).

Sources, kept strictly separate:

  real_train / real_valid  Zenodo 385-image Intel D435 set, YOLO format
  synth_train / synth_valid  FSOC simulator output (scripts/gen-synthetic-dataset.ts)
  real_test                Zenodo 56-image smartphone set, COCO format — LOCKED
  synth_stress_test        FSOC stress recipes, disjoint seeds       — LOCKED

PHASE 15 RULE, ENFORCED HERE: the 56 smartphone images are read only into the
`real_test` split. No training or validation split ever touches them, and the
training script refuses to load that file. It is a cross-camera generalisation
check, and it is only worth anything if it stays unseen.

Usage:
    python scripts/ai/build_roi_dataset.py
Output:
    datasets/roi/{real_train,real_valid,synth_train,synth_valid,
                  real_test,synth_stress_test}.npz
"""
import json
import os
import sys
import glob
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import PATCH, crop_patch, normalise_patch, tophat_proposals  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT_DIR = os.path.join(ROOT, 'datasets', 'roi')

# A proposal is a positive only if it lands within this many px of a true spot
# centre. 4 px on a ~10 px spot means the crop is genuinely centred on it.
POS_RADIUS = 4.0
# Negatives must be clearly away from any true spot, so that a slightly
# off-centre crop of the real beacon is never mined as a negative.
NEG_EXCLUSION = 22.0
# Positional jitter applied to positives, px. The runtime crop is centred on
# the classical detector's centroid, which is itself a few px off truth under
# noise, so the model must tolerate that.
POS_JITTER = [(0, 0), (2, -1), (-2, 1), (1, 2), (-1, -2), (3, 0), (0, -3)]


def load_gray(path):
    return np.array(Image.open(path).convert('L'))


def yolo_boxes(label_path, w, h):
    """Read a YOLO label file -> list of (cx, cy, bw, bh) in pixels."""
    if not os.path.exists(label_path):
        return []
    out = []
    for line in open(label_path).read().strip().splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        cx, cy, bw, bh = (float(v) for v in parts[1:5])
        out.append((cx * w, cy * h, bw * w, bh * h))
    return out


def harvest(img, boxes, rng, max_neg=6):
    """
    Turn one image + its true boxes into labelled ROI patches.

    Positives come from the true centres (plus small jitter). Negatives are
    mined with the top-hat proposer and kept only if they are far from every
    true spot — these are the bright-but-wrong things a real scene contains.
    """
    patches, labels = [], []
    for (cx, cy, _bw, _bh) in boxes:
        for (jx, jy) in POS_JITTER:
            patches.append(normalise_patch(crop_patch(img, cx + jx, cy + jy)))
            labels.append(1)

    props = tophat_proposals(img, max_n=24)
    negs = []
    for (px, py) in props:
        if any((px - cx) ** 2 + (py - cy) ** 2 < NEG_EXCLUSION ** 2
               for (cx, cy, _w, _h) in boxes):
            continue
        negs.append((px, py))
    rng.shuffle(negs)
    for (px, py) in negs[:max_neg]:
        patches.append(normalise_patch(crop_patch(img, px, py)))
        labels.append(0)
    return patches, labels


def build_yolo_split(img_dir, label_dir, seed, max_neg=6, limit=None):
    rng = np.random.default_rng(seed)
    files = sorted(glob.glob(os.path.join(img_dir, '*.jpg')) +
                   glob.glob(os.path.join(img_dir, '*.png')))
    if limit:
        files = files[:limit]
    P, L = [], []
    for i, f in enumerate(files):
        img = load_gray(f)
        h, w = img.shape
        stem = os.path.splitext(os.path.basename(f))[0]
        boxes = yolo_boxes(os.path.join(label_dir, stem + '.txt'), w, h)
        p, l = harvest(img, boxes, rng, max_neg=max_neg)
        P.extend(p)
        L.extend(l)
        if (i + 1) % 100 == 0:
            print(f'    {i + 1}/{len(files)} images -> {len(P)} patches', flush=True)
    return np.array(P, dtype=np.float32), np.array(L, dtype=np.int64), len(files)


def build_coco_split(img_dir, ann_path, seed):
    """The LOCKED 56-image smartphone test set. Never used for fitting."""
    rng = np.random.default_rng(seed)
    d = json.load(open(ann_path))
    by_img = {}
    for a in d['annotations']:
        by_img.setdefault(a['image_id'], []).append(a['bbox'])
    P, L = [], []
    for im in d['images']:
        path = os.path.join(img_dir, im['file_name'])
        if not os.path.exists(path):
            continue
        img = load_gray(path)
        boxes = [(x + bw / 2, y + bh / 2, bw, bh)
                 for (x, y, bw, bh) in by_img.get(im['id'], [])]
        p, l = harvest(img, boxes, rng, max_neg=6)
        P.extend(p)
        L.extend(l)
    return np.array(P, dtype=np.float32), np.array(L, dtype=np.int64), len(d['images'])


def save(name, P, L, n_images, note):
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, name + '.npz')
    np.savez_compressed(path, patches=P, labels=L)
    pos = int(L.sum())
    print(f'  {name:12s} {len(L):6d} patches  ({pos} pos / {len(L) - pos} neg)'
          f'  from {n_images} images   [{note}]')


def main():
    print('Building ROI datasets...')
    ds = os.path.join(ROOT, 'datasets')

    print('  real (Zenodo D435, YOLO) ...')
    for split, seed in (('train', 11), ('valid', 12)):
        base = os.path.join(ds, 'train_yolo', 'yolo_format', split)
        P, L, n = build_yolo_split(os.path.join(base, 'images'),
                                   os.path.join(base, 'labels'), seed)
        save(f'real_{split}', P, L, n, 'Stage A pretraining')

    synth_root = os.path.join(ds, 'fsoc_synth')
    if os.path.isdir(synth_root):
        print('  synthetic (FSOC simulator) ...')
        for split, seed in (('train', 21), ('valid', 22)):
            base = os.path.join(synth_root, split)
            P, L, n = build_yolo_split(os.path.join(base, 'images'),
                                       os.path.join(base, 'labels'), seed, max_neg=5)
            save(f'synth_{split}', P, L, n, 'Stage B fine-tuning')
        stress = os.path.join(synth_root, 'test_stress')
        if os.path.isdir(stress):
            # Phase 15: unseen synthetic stress scenarios, LOCKED like real_test.
            P, L, n = build_yolo_split(os.path.join(stress, 'images'),
                                       os.path.join(stress, 'labels'), 23, max_neg=5)
            save('synth_stress_test', P, L, n, 'LOCKED — never fitted on')
    else:
        print('  synthetic: NOT FOUND — run scripts/gen-synthetic-dataset.ts first')

    print('  LOCKED test (Zenodo smartphone, COCO) ...')
    P, L, n = build_coco_split(os.path.join(ds, 'test_coco', 'images'),
                               os.path.join(ds, 'test_coco', 'annotations',
                                            'instances_default.json'), 31)
    save('real_test', P, L, n, 'LOCKED — never fitted on')
    print(f'\nWritten to {OUT_DIR}')


if __name__ == '__main__':
    main()
