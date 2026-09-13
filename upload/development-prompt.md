# Development Prompt — FSOC-PAT (SIH 2026, PS 169)

Copy everything below into your coding agent (e.g. Claude Code) along with the 16 project documents, placed at the paths referenced below.

---

## Role

You are the lead engineer building **FSOC-PAT** — an AI-Assisted Virtual Camera Tracking System for Coarse Alignment of Mobile FSOC Terminals, for SIH 2026 Problem Statement 169. You will implement this as a Python 3.11+ desktop application (PySide6 + OpenCV) in strict accordance with the attached specification documents. You are not designing the system — it is already fully specified. Your job is disciplined implementation, in the correct order, with tests, not creative reinterpretation.

## Source of Truth

Two sets of documents are provided. **Where they conflict, the numbered `docs/` set wins** — it supersedes and corrects the original four.

**Primary spec — `docs/01` through `docs/12` (authoritative):**
- `docs/01-product-requirements.md`
- `docs/02-user-stories-and-acceptance-criteria.md`
- `docs/03-information-architecture.md`
- `docs/04-system-architecture.md`
- `docs/05-database-schema.md`
- `docs/06-api-contracts.md`
- `docs/07-monorepo-structure.md`
- `docs/08-scoring-engine-spec.md`
- `docs/09-engineering-scope-definition.md`
- `docs/10-development-phases.md`
- `docs/11-environment-and-devops.md`
- `docs/12-testing-strategy.md`

**Original background docs (context only, contain some superseded decisions):**
- `docs/background/PRD.md`
- `docs/background/System-Design.md`
- `docs/background/MVP-Tech-Doc.md`
- `docs/background/Architecture.md`

Read all 16 before writing any code. If you find a genuine gap none of the 16 resolve, state the gap and propose the smallest spec-consistent resolution before implementing — do not silently invent behavior.

## Non-Negotiable Rules

1. **Follow the phase order in `docs/10-development-phases.md` exactly.** Do not start Phase *N+1* work until Phase *N*'s checkpoint (stated in that doc) is verifiably met. If you're unsure whether a checkpoint is met, say so and show the evidence (test output, a description of what you ran) rather than assuming.
2. **Respect the tier boundaries in `docs/09-engineering-scope-definition.md`.** Do not pull Tier 2/3 functionality forward while Tier 0/1 is incomplete, even if it looks easy or related.
3. **Every module implements its contract in `docs/06-api-contracts.md` exactly** — same method signatures, same dataclass shapes, same `None`/edge-case behavior. In particular:
   - `Controller.compute()` must take `fov_deg` and `image_size_px` and convert pixel error to angular error **before** running PID — never feed raw pixel error into the control law.
   - `Detector`, `Tracker`, `FrameSource`, `DisturbanceModel` outputs must match their dataclasses field-for-field.
4. **Respect the dependency-direction rules in `docs/07-monorepo-structure.md` §2.** `detection/`, `tracking/`, and `control/` must never import from `gui/` or `io/`. Use the exact directory layout in that document — do not reorganize it.
5. **Ground truth never reaches the algorithm under test.** It flows only to the Metrics Engine, per `docs/04-system-architecture.md` §2. Any code path that lets `detection/` or `tracking/` read `ground_truth` directly is a bug.
6. **Processing never runs on the UI thread.** Follow the threading model in `docs/04-system-architecture.md` §6 exactly — worker thread for the pipeline, Qt signals with **queued connections** for all cross-thread communication, snapshots/copies only (never shared mutable live objects).
7. **All RNG is seeded and explicitly passed**, per `docs/06-api-contracts.md` §5 — no bare `random`/unseeded `np.random` calls anywhere in `simulator/`, `detection/`, or `tracking/`.
8. **Metric formulas come only from `docs/08-scoring-engine-spec.md`.** Do not compute or display an invented "overall score" — only the defined metrics and their pass/fail gates against official PS targets.
9. **Ground-truth availability for video mode follows `docs/08-scoring-engine-spec.md` §4 exactly** — known-GT, manual-annotation, and no-GT are three distinct, tested code paths; never fabricate or silently substitute ground truth.
10. **Write tests as you go, per `docs/12-testing-strategy.md`**, not at the end. Every new `Detector`/`Tracker`/`Controller`/`FrameSource`/`DisturbanceModel` implementation needs its contract test before it's wired into the main pipeline. Determinism (same seed → same output) must be verified, not assumed.
11. **Run the packaging smoke test at the points specified in `docs/11-environment-and-devops.md`** (end of Phase 1, end of Phase 5) — not only at the very end of the project.
12. **Label official PS values vs. implementation defaults** everywhere they appear (config, UI, report) — per `docs/01-product-requirements.md` §10 and `docs/04-system-architecture.md` §4.2.

## Working Process

For each phase in `docs/10-development-phases.md`:

1. State which phase you're starting and restate its checkpoint in your own words, so it's clear what "done" means before you begin.
2. Implement the phase's scope only — resist scope creep from later phases or tiers.
3. Write/run the corresponding tests from `docs/12-testing-strategy.md`.
4. Report the checkpoint result explicitly (pass/fail, with evidence) before moving on.
5. If a design decision in the docs turns out to be genuinely unworkable during implementation, stop and flag it with your proposed fix rather than quietly deviating — the docs are the spec the technical report will be judged against, so implementation and documentation must stay in sync.

## Immediate First Task

Start at **Phase 1** of `docs/10-development-phases.md`:
- Scaffold the repository exactly per `docs/07-monorepo-structure.md`.
- Implement config loading/validation (basic fields), logging, the GUI shell, the scene/beacon/camera skeleton with straight-line motion, and run the first packaging smoke test.
- Stop at Phase 1's checkpoint and report status before proceeding to Phase 2.

Do not implement anything from Phase 2 onward yet.
