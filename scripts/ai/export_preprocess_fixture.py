"""
Write the preprocessing parity fixture (tests/fixtures/ai-preprocess.json).

The model score fixture (written by train_roi.py) checks that the TypeScript
forward pass reproduces the trained network. It does NOT check that the
TypeScript crop-and-normalise reproduces the Python one — and a mismatch there
would be worse, because the model would still return confident-looking numbers
for patches it was never trained on.

This script covers that gap with raw frames, including the cases most likely to
diverge: a spot at the exact frame corner (edge replication), a spot on a
bright background (the real-dataset regime), and an even-count median.

Usage: python scripts/ai/export_preprocess_fixture.py
"""
import json
import os
import sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import PATCH, crop_patch, normalise_patch  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'tests', 'fixtures', 'ai-preprocess.json')

W, H = 48, 40


def make_frame(rng, background, spot_xy, spot_level, spot_size):
    f = np.clip(rng.normal(background, 6.0, size=(H, W)), 0, 255)
    if spot_xy is not None:
        cx, cy = spot_xy
        r = spot_size // 2
        y0, y1 = max(0, cy - r), min(H, cy + r + 1)
        x0, x1 = max(0, cx - r), min(W, cx + r + 1)
        f[y0:y1, x0:x1] = spot_level
    return f.astype(np.uint8)


def main():
    rng = np.random.default_rng(4242)
    cases = []

    specs = [
        # (background, spot position, level, size, crop centre, why)
        (18, (24, 20), 240, 9, (24, 20), 'dark sky, centred beacon'),
        (102, (30, 12), 205, 11, (30, 12), 'bright background, real-dataset regime'),
        (18, (0, 0), 235, 9, (0, 0), 'top-left corner: edge replication'),
        (18, (47, 39), 235, 9, (47, 39), 'bottom-right corner: edge replication'),
        (60, (24, 20), 70, 15, (24, 20), 'spot barely above background'),
        (18, None, 0, 0, (24, 20), 'empty frame, noise only'),
        (200, (10, 30), 60, 7, (10, 30), 'dark spot on bright field'),
        (18, (24, 20), 255, 20, (18, 14), 'crop deliberately off-centre'),
    ]

    for (bg, spot, level, size, centre, why) in specs:
        frame = make_frame(rng, bg, spot, level, size)
        patch = normalise_patch(crop_patch(frame, centre[0], centre[1]))
        cases.append({
            'why': why,
            'width': W,
            'height': H,
            'frame': frame.ravel().tolist(),
            'cx': centre[0],
            'cy': centre[1],
            'expected': [round(float(v), 7) for v in patch.ravel()],
        })

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump({
            'note': 'Written by scripts/ai/export_preprocess_fixture.py. '
                    'tests/ai-parity.test.ts runs cropAndNormalise() from '
                    'src/engine/nn.ts over these frames and requires the '
                    'result to match scripts/ai/common.py exactly.',
            'patch': PATCH,
            'cases': cases,
        }, f)
    print(f'wrote {len(cases)} preprocessing cases to {OUT}')


if __name__ == '__main__':
    main()
