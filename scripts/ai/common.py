"""
Shared preprocessing for the FSOC-PAT learned detector.

EVERYTHING IN THIS FILE HAS A BYTE-COMPATIBLE TWIN IN TYPESCRIPT.

The Python side is used for training only. At runtime the model executes in
src/engine/nn.ts + src/engine/detector-ai.ts, in pure TypeScript, inside the
same Web Worker as the rest of the engine. If the preprocessing here and the
preprocessing there ever diverge, the model is being fed something it was not
trained on, so tests/ai-parity.test.ts pins them against a stored fixture.

Keep the two implementations in step. If you change PATCH, BG_RING, SCALE or
the clipping bounds, change them in src/engine/nn.ts too and regenerate the
parity fixture.
"""
import numpy as np

# ---- Patch geometry (mirrored in src/engine/nn.ts) ----
PATCH = 24          # ROI side, px, at native sensor resolution
BG_RING = 2         # width of the border ring used for local background
SCALE = 128.0       # divisor after background subtraction
CLIP_LO = -1.0
CLIP_HI = 2.0


def crop_patch(img, cx, cy):
    """
    Extract a PATCH x PATCH window centred on (cx, cy) with edge replication.

    `img` is a 2-D uint8/float array. Returns float32 of shape (PATCH, PATCH).
    Edge replication (rather than zero fill) matters: a beacon clipped at the
    frame border is a real and frequent case during reacquisition, and zero
    padding would hand the model a hard black edge that never occurs mid-frame.
    """
    h, w = img.shape
    half = PATCH // 2
    x0 = int(round(cx)) - half
    y0 = int(round(cy)) - half
    xs = np.clip(np.arange(x0, x0 + PATCH), 0, w - 1)
    ys = np.clip(np.arange(y0, y0 + PATCH), 0, h - 1)
    return img[np.ix_(ys, xs)].astype(np.float32)


def normalise_patch(patch):
    """
    Local-background subtraction.

    The public Zenodo images are laser spots on lit indoor surfaces (mean grey
    ~102); the FSOC simulator renders a beacon on a dark sky (background ~18).
    Feeding raw levels would make the DC level a perfect train/test giveaway
    and teach the model nothing transferable. Subtracting the median of the
    patch border removes that offset while PRESERVING the spot's amplitude
    above its own surroundings, which is real evidence and must survive.
    """
    ring = np.concatenate([
        patch[:BG_RING, :].ravel(),
        patch[-BG_RING:, :].ravel(),
        patch[BG_RING:-BG_RING, :BG_RING].ravel(),
        patch[BG_RING:-BG_RING, -BG_RING:].ravel(),
    ])
    bg = float(np.median(ring))
    return np.clip((patch - bg) / SCALE, CLIP_LO, CLIP_HI).astype(np.float32)


def box_blur(img, k):
    """Separable box blur via summed-area table; k must be odd."""
    r = k // 2
    pad = np.pad(img.astype(np.float32), r, mode='edge')
    csum = np.cumsum(np.cumsum(pad, axis=0), axis=1)
    csum = np.pad(csum, ((1, 0), (1, 0)), mode='constant')
    h, w = img.shape
    y0, x0 = np.arange(h), np.arange(w)
    Y0, X0 = np.meshgrid(y0, x0, indexing='ij')
    total = (csum[Y0 + k, X0 + k] - csum[Y0, X0 + k]
             - csum[Y0 + k, X0] + csum[Y0, X0])
    return total / (k * k)


def tophat_proposals(img, max_n=24, k=15, min_contrast=12.0, nms_radius=10):
    """
    Local-contrast spot proposals: img - boxblur(img, k), then greedy NMS peaks.

    A GLOBAL brightness threshold is the wrong proposal mechanism for the real
    dataset — measured over the 285 labelled training images, the laser spot
    sits at the 91st brightness percentile on average and is the frame maximum
    in only 21 % of them. Windows, lamps and white walls are all brighter. A
    top-hat responds to "small and bright RELATIVE TO ITS SURROUNDINGS", which
    is what an optical spot actually is, and works unchanged on the simulator's
    dark-sky frames.

    Used to mine hard negatives for training. It is NOT the runtime proposal
    path — at runtime the classical detector in src/engine/detector.ts proposes
    candidates and the model scores its crops.
    """
    f = img.astype(np.float32)
    resp = f - box_blur(f, k)
    h, w = resp.shape
    flat = resp.ravel()
    order = np.argsort(flat)[::-1]
    picks = []
    taken = np.zeros((h, w), dtype=bool)
    r2 = nms_radius * nms_radius
    for idx in order[:max_n * 400]:
        if len(picks) >= max_n:
            break
        if flat[idx] < min_contrast:
            break
        y, x = divmod(int(idx), w)
        if taken[y, x]:
            continue
        ok = True
        for (py, px) in picks:
            if (py - y) ** 2 + (px - x) ** 2 < r2:
                ok = False
                break
        if not ok:
            continue
        picks.append((y, x))
        y0, y1 = max(0, y - nms_radius), min(h, y + nms_radius + 1)
        x0, x1 = max(0, x - nms_radius), min(w, x + nms_radius + 1)
        taken[y0:y1, x0:x1] = True
    return [(float(x), float(y)) for (y, x) in picks]
