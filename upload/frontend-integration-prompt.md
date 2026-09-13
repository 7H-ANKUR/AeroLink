# Development Prompt — FSOC-PAT Frontend + Backend Integration

Copy everything below into your coding agent (e.g. Claude Code) along with the project's 16 documents (see paths below). Use this alongside — not instead of — `development-prompt.md`; that prompt covers the full phased build, this one is a focused prompt for the GUI layer and its wiring to the processing pipeline.

---

## Role

You are building the **GUI layer** of FSOC-PAT (a PySide6 desktop app for SIH 2026 PS 169) and integrating it with the backend processing pipeline (simulator, detector, tracker, controller, metrics engine) that either already exists in this repo or that you are building alongside it. The GUI is not a cosmetic layer — it is how judges interact with the system during the Functional Verification demo, so it must be fully functional, not a mockup.

## Source of Truth (read all before writing code)

- `docs/03-information-architecture.md` — screen inventory, navigation, data ownership per screen. **This defines exactly which screens/panels exist and what each one shows — do not add or remove screens.**
- `docs/04-system-architecture.md` §4.17 and §6 — GUI component and the **threading model** (this is the most safety-critical part of this prompt — read it twice).
- `docs/06-api-contracts.md` — the exact dataclasses (`FramePacket`, `Detection`, `TrackState`, `PanTiltCommand`, `RunResult`) the GUI will receive and display.
- `docs/05-database-schema.md` — `metrics.json`/`RunResult` shape for the Results screen; `events.csv` shape if you build Replay.
- `docs/01-product-requirements.md` §7 (FR-11, FR-17 equivalents) and `docs/02-user-stories-and-acceptance-criteria.md` Epic F/G — acceptance criteria for what the live metrics and results screens must show.
- `docs/09-engineering-scope-definition.md` — which screens belong to which tier. **Build only Tier 0–2 screens (Camera Viewport, Parameter Panel, Live Metrics, Results) unless explicitly told to build Tier 3 (Replay, Comparison, Run History).**

## Non-Negotiable Rules

1. **Threading — this is the rule most likely to be gotten wrong.**
   - The processing loop (frame read → detect → track → control → metrics) runs on a dedicated worker thread (`QThread` or an executor), **never on the UI thread**.
   - All data crossing from the worker thread to the UI thread goes through **Qt signals with queued connections** — never by having the UI thread read a live, worker-owned mutable object directly.
   - Signals must carry **immutable snapshots/copies** of `FramePacket`, `Detection`, `TrackState`, `PanTiltCommand` — not references to objects the worker thread might still be mutating.
   - The UI must remain responsive (able to process Start/Stop/Pause clicks) at all times while a run is active — verify this explicitly, don't just assume it.

2. **The GUI never computes metrics or control logic itself.** It only displays what the `MetricsEngine`/`Tracker`/`Controller` (backend, per `docs/06-api-contracts.md`) produce. If a number needs deriving for display (e.g. formatting), that's fine; if it needs *calculating* per `docs/08-scoring-engine-spec.md`, that calculation belongs in `evaluation/`, not in `gui/`.

3. **Screen inventory and navigation must match `docs/03-information-architecture.md` exactly** — same panels, same tabs, same locked-during-run behavior (Parameter Panel is read-only once a run starts, per that doc §3).

4. **State labels shown in the UI must be a 1:1 mirror of the backend state machine** (`SEARCH`, `CANDIDATE`, `ACQUIRE`, `TRACK`, `PREDICT_REACQUIRE` from `docs/04-system-architecture.md` §4.12) — do not invent additional UI-only states or relabel them.

5. **Official PS targets vs. internal thresholds must be visually distinguished** on the Results screen and anywhere pass/fail is shown, per `docs/01-product-requirements.md` §10 and `docs/08-scoring-engine-spec.md` §2.

6. **Video mode (Mode B) UI must follow `docs/03-information-architecture.md` §6 exactly**: before a run starts, show whether the loaded video has known ground truth, needs manual annotation, or has none; after a run with no GT, swap the error/RMSE cards for the reference-free metric set and show the persistent "perception-only" label. Never let the UI imply physical re-pointing happened on recorded footage.

7. **Config validation errors surface inline on the offending field**, not only in a log panel (per `docs/03-information-architecture.md` §7).

8. **Dependency direction still applies** (`docs/07-monorepo-structure.md` §2): `gui/` may depend on `evaluation/`, `tracking/`, `control/`, `detection/`, `io/`, `simulator/`, `config/` — but nothing in those packages may import from `gui/`. Do not create a backwards import to "make it easier."

## Integration Sequence (do this in order)

1. **Build the GUI shell first against fake/static data** — hardcode a few sample `FramePacket`/`TrackState`/`RunResult` objects and confirm every screen renders correctly and navigation works, before wiring to the real pipeline. This isolates GUI bugs from pipeline bugs.
2. **Wire the worker thread and signal plumbing** using the real `FrameSource` → `Detector` → `Tracker` → `Controller` → `MetricsEngine` chain from the backend, but only for the Camera Viewport + Live Metrics Panel (the minimum needed to see a run happen live).
3. **Add Start/Stop/Pause control** and confirm the UI stays responsive during a run (click Stop mid-run and confirm the worker thread actually stops cleanly, no orphaned thread).
4. **Wire the Parameter Panel** to actually construct and validate a `ScenarioConfig` and pass it to the pipeline on Start — including the locked-during-run behavior.
5. **Wire the Results screen** to a completed run's `RunResult`, including the pass/fail table and (if built) the export button.
6. **Wire Video mode** last, including the three ground-truth-availability UI states.
7. Only after 1–6 are solid: if asked, proceed to Tier 3 (Replay/Comparison/Run History).

## Testing Expectations

- A manual or scripted check that a full run (Start → live updates → Stop/complete → Results) works with zero UI freeze.
- A check that killing/losing the beacon mid-run updates the state label and metrics live, without a UI thread stall.
- A check that Parameter Panel fields are genuinely locked (not just visually greyed out) once a run starts.
- Reference `docs/12-testing-strategy.md` §1 Integration Tests ("cross-thread integration") for the specific pass criteria.

## Immediate First Task

Report which parts of the backend pipeline (per `docs/06-api-contracts.md`) already exist in this repo vs. need stubbing. Then:
1. Scaffold `gui/main_window.py`, `gui/camera_view.py`, `gui/dashboard.py`, `gui/config_panel.py` per `docs/07-monorepo-structure.md`.
2. Build the GUI shell against static sample data (Integration step 1 above).
3. Stop and report before wiring the real worker thread, so the shell can be reviewed first.
