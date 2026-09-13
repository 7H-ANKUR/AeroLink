# 11 — Environment & DevOps

## 1. Development Environment

| Layer | Tool / Version |
|---|---|
| Language | Python 3.11+ |
| GUI | PySide6 |
| CV | OpenCV |
| Numerics | NumPy, SciPy |
| AI (optional) | PyTorch (training/experimentation), ONNX Runtime or TorchScript (deployment) |
| Video I/O | OpenCV/FFmpeg-backed reader |
| Charts | Matplotlib |
| Tabular data | Pandas |
| Config format | YAML |
| Testing | Pytest |
| Packaging | PyInstaller |
| Lint/format | ruff, black |
| Import boundary enforcement | import-linter (or equivalent), enforcing `07-monorepo-structure.md` §2 |
| VCS | Git |

Setup:
```bash
python -m venv .venv
source .venv/bin/activate          # or .venv\Scripts\activate on Windows
pip install -r requirements.txt -r requirements-dev.txt
```

Avoid introducing a heavy 3D engine — a deterministic 2D image-space simulation is sufficient for the coarse-tracking control loop (per `04-system-architecture.md`).

## 2. Local Run Commands

```bash
python -m app.main                       # launch GUI
pytest tests/unit tests/contract          # fast checks
pytest tests/integration tests/scenario   # slower, full-pipeline checks
ruff check . && black --check .           # lint/format gate
```

## 3. Threading & Determinism in Dev
- Never test the processing loop by calling it directly on the UI thread, even for a "quick check" — this hides the exact class of bug flagged in `04-system-architecture.md` §6. Use the same worker-thread + queued-signal path in dev as in the packaged build.
- All RNG use goes through an explicitly seeded `np.random.Generator` passed down from the scenario config — no bare `random.random()` or unseeded `np.random` calls anywhere in `simulator/`, `detection/`, or `tracking/` (enforced by code review / a grep-based CI check).

## 4. CI Pipeline (recommended minimum)

```text
on: push / pull_request
  1. ruff check + black --check
  2. import-linter (dependency-direction check, 07 §2)
  3. pytest tests/unit tests/contract        (must pass — these gate merges)
  4. pytest tests/integration                 (must pass)
  5. pytest tests/scenario -m "not slow"       (must pass; full scenario suite runs nightly/manually)
```
`tests/scenario` includes the repeated-seed benchmark gate from `08-scoring-engine-spec.md` §5 — the full multi-seed sweep is expensive and can be a manual/nightly job rather than blocking every commit, but must run at least once before each phase checkpoint in `10-development-phases.md`.

## 5. Packaging Pipeline — moved early deliberately (see risk in `01-product-requirements.md` §11)

```bash
pyinstaller packaging/pyinstaller.spec
```

`packaging/build_and_smoke_test.sh` should:
1. Build the executable.
2. Copy it (plus `scenarios/`, `samples/`, `models/` if present) to a directory with no reference to the dev `.venv` or source tree.
3. Launch it and run a scripted minimal scenario (Tier 0 skeleton) headlessly or via a short manual checklist.
4. Report executable size — track this over time; PyTorch/ONNX dependencies can push size into the hundreds of MB to GB range, which matters if judges' machines have limited disk or no internet for a large transfer.

This smoke test is required at the end of **Phase 1** and again at the end of **Phase 5** (`10-development-phases.md`), not only at final submission — packaging failures discovered the day before Functional Verification are the single most avoidable failure mode for this kind of project.

## 6. Environment Variants to Test On
- At least one machine that never had the Python dev environment installed.
- At least one machine without a discrete GPU (classical pipeline must run fully; AI path, if present, must degrade gracefully — `01-product-requirements.md` §11 risk table).
- Lowest-spec laptop realistically available to the team, to sanity-check the ≥20 FPS / ≥30 Hz targets under real constraints, not just on a dev workstation.

## 7. Configuration & Secrets
- No credentials or API keys are required for core operation (fully offline).
- If the optional Tier-3 local monitoring API (`06-api-contracts.md` §7) is built, it binds to `127.0.0.1` only — never exposed on a network interface.
- `config/default.yaml` is the only checked-in config; user-saved scenarios and all `exports/` output are git-ignored.

## 8. Release Checklist (maps to `01-product-requirements.md` §14)
- [ ] Clean-machine install/launch verified this week (not from memory of an earlier test).
- [ ] Version tag matches `app/version.py` and appears in every `RunResult`.
- [ ] `docs/` (this file set) matches actual behavior — no stale claims about features not yet built.
- [ ] Sample scenarios and sample MP4 ship inside the package, not fetched at runtime.
- [ ] User manual screenshots match the current GUI, not an earlier iteration.
