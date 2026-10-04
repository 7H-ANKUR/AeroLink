"""
Export the two trained networks to ONNX for ONNX Runtime Web (plan2).

The networks are REBUILT FROM THE SHIPPED WEIGHTS — public/models/
beacon-roi-v2.bin and track-verifier-v1.json — not from a separate
checkpoint, so the ONNX files are the deployed models by construction.

  beacon-roi-v2.onnx
      input  "patches"  float32 [N, 1, 24, 24]  local-background-subtracted
                                                ROIs (nn.ts cropAndNormalise)
      output "p_beacon" float32 [N, 1]          sigmoid probability

  track-verifier-v1.onnx
      input  "features" float32 [N, 8]          raw TRACK_FEATURES rows
      output "p_beacon" float32 [N, 1]          sigmoid probability
      (the train-split standardisation is baked into the graph)

Each file is then run through onnxruntime and compared with PyTorch on the
committed parity fixtures; the export fails if they disagree by > 1e-5.
SHA-256 of each file is written into public/models/onnx-manifest.json.

Usage: python scripts/ai/export_onnx.py
"""
import datetime
import hashlib
import json
import os
import sys

import numpy as np
import torch
import torch.nn as nn

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train_roi import TinyBeaconNet  # noqa: E402  (architecture mirrors nn.ts)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
MODELS = os.path.join(ROOT, 'public', 'models')
FIX = os.path.join(ROOT, 'tests', 'fixtures')
CNN = 'beacon-roi-v2'
VER = 'track-verifier-v1'
OPSET = 17


class CnnWithSigmoid(nn.Module):
    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, x):
        return torch.sigmoid(self.net(x)).unsqueeze(1)


class VerifierGraph(nn.Module):
    """Standardisation + MLP + sigmoid, exactly track-verifier.ts."""

    def __init__(self, w):
        super().__init__()
        n = len(w['features'])
        std = np.array(w['std'], dtype=np.float32)
        std[std <= 1e-6] = 1.0
        self.register_buffer('mean', torch.tensor(w['mean'], dtype=torch.float32))
        self.register_buffer('std', torch.tensor(std))
        self.fc1 = nn.Linear(n, w['hidden'])
        self.fc2 = nn.Linear(w['hidden'], 1)
        with torch.no_grad():
            self.fc1.weight.copy_(torch.tensor(w['w1'], dtype=torch.float32))
            self.fc1.bias.copy_(torch.tensor(w['b1'], dtype=torch.float32))
            self.fc2.weight.copy_(torch.tensor([w['w2']], dtype=torch.float32))
            self.fc2.bias.copy_(torch.tensor([w['b2']], dtype=torch.float32))

    def forward(self, x):
        z = (x - self.mean) / self.std
        return torch.sigmoid(self.fc2(torch.relu(self.fc1(z))))


def load_cnn():
    blob = np.fromfile(os.path.join(MODELS, CNN + '.bin'), dtype='<f4')
    net = TinyBeaconNet()
    order = ['conv1.weight', 'conv1.bias', 'conv2.weight', 'conv2.bias',
             'conv3.weight', 'conv3.bias', 'fc1.weight', 'fc1.bias',
             'fc2.weight', 'fc2.bias']
    sd = net.state_dict()
    o = 0
    for k in order:
        n = sd[k].numel()
        sd[k] = torch.from_numpy(blob[o:o + n].copy()).reshape(sd[k].shape)
        o += n
    assert o == blob.size, f'weights blob has {blob.size} floats, consumed {o}'
    net.load_state_dict(sd)
    net.eval()
    return net


def export(model, dummy, path, in_name, out_name):
    torch.onnx.export(
        model, dummy, path,
        input_names=[in_name], output_names=[out_name],
        dynamic_axes={in_name: {0: 'N'}, out_name: {0: 'N'}},
        opset_version=OPSET, dynamo=False,
    )


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        h.update(f.read())
    return h.hexdigest()


def main():
    import onnxruntime as ort

    # ---- CNN ----
    net = load_cnn()
    cnn = CnnWithSigmoid(net).eval()
    cnn_path = os.path.join(MODELS, CNN + '.onnx')
    export(cnn, torch.zeros(2, 1, 24, 24), cnn_path, 'patches', 'p_beacon')
    fx = json.load(open(os.path.join(FIX, 'ai-parity.json')))
    X = np.array(fx['patches'], dtype=np.float32).reshape(-1, 1, 24, 24)
    with torch.no_grad():
        ref = cnn(torch.from_numpy(X)).numpy().ravel()
    sess = ort.InferenceSession(cnn_path, providers=['CPUExecutionProvider'])
    got = sess.run(None, {'patches': X})[0].ravel()
    d_cnn = float(np.max(np.abs(got - ref)))
    d_fix = float(np.max(np.abs(got - np.array(fx['scores']))))
    print(f'{CNN}.onnx  max|ort - torch| = {d_cnn:.2e}  max|ort - fixture| = {d_fix:.2e}')
    assert d_cnn < 1e-5 and d_fix < 1e-4, 'CNN ONNX export does not reproduce the model'

    # ---- Verifier ----
    w = json.load(open(os.path.join(MODELS, VER + '.json')))
    ver = VerifierGraph(w).eval()
    ver_path = os.path.join(MODELS, VER + '.onnx')
    export(ver, torch.zeros(2, len(w['features'])), ver_path, 'features', 'p_beacon')
    vfx = json.load(open(os.path.join(FIX, 'track-verifier-parity.json')))
    R = np.array(vfx['rows'], dtype=np.float32)
    with torch.no_grad():
        vref = ver(torch.from_numpy(R)).numpy().ravel()
    vs = ort.InferenceSession(ver_path, providers=['CPUExecutionProvider'])
    vgot = vs.run(None, {'features': R})[0].ravel()
    d_ver = float(np.max(np.abs(vgot - vref)))
    d_vfix = float(np.max(np.abs(vgot - np.array(vfx['scores']))))
    print(f'{VER}.onnx  max|ort - torch| = {d_ver:.2e}  max|ort - fixture| = {d_vfix:.2e}')
    assert d_ver < 1e-5 and d_vfix < 1e-4, 'verifier ONNX export does not reproduce the model'

    manifest = {
        'generatedAt': datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat(),
        'exporter': f'torch {torch.__version__} (TorchScript exporter), opset {OPSET}',
        'models': {
            CNN: {
                'file': CNN + '.onnx',
                'sha256': sha256(cnn_path),
                'bytes': os.path.getsize(cnn_path),
                'sourceWeights': CNN + '.bin',
                'sourceWeightsSha256': sha256(os.path.join(MODELS, CNN + '.bin')),
                'input': {'name': 'patches', 'dtype': 'float32', 'shape': ['N', 1, 24, 24],
                          'preprocessing': 'crop 24x24 at candidate centroid (edge replication), '
                                           'subtract median of 2-px border ring, /128, clip [-1, 2]'},
                'output': {'name': 'p_beacon', 'dtype': 'float32', 'shape': ['N', 1],
                           'meaning': 'sigmoid P(ROI contains the beacon)'},
                'parity': {'maxAbsVsTorch': d_cnn, 'maxAbsVsFixture': d_fix},
            },
            VER: {
                'file': VER + '.onnx',
                'sha256': sha256(ver_path),
                'bytes': os.path.getsize(ver_path),
                'sourceWeights': VER + '.json',
                'sourceWeightsSha256': sha256(os.path.join(MODELS, VER + '.json')),
                'input': {'name': 'features', 'dtype': 'float32', 'shape': ['N', len(w['features'])],
                          'features': w['features']},
                'output': {'name': 'p_beacon', 'dtype': 'float32', 'shape': ['N', 1],
                           'meaning': 'sigmoid P(candidate track is the beacon), calibrated'},
                'parity': {'maxAbsVsTorch': d_ver, 'maxAbsVsFixture': d_vfix},
            },
        },
    }
    with open(os.path.join(MODELS, 'onnx-manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=2)
    print('wrote public/models/onnx-manifest.json')


if __name__ == '__main__':
    main()
