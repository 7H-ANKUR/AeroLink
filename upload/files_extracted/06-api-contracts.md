# 06 — API Contracts

FSOC-PAT is a single-process desktop application with no external network API in its MVP/Tier-2 form. "API contracts" here means the **internal module interfaces** that different implementations (classical vs. AI detector, PID vs. adaptive controller, simulation vs. video source) must satisfy so components are swappable, testable in isolation, and comparable across runs. A minimal optional local HTTP API for remote monitoring is defined in §7 as a Tier-3 stretch item — not required for the core deliverable.

## 1. `FrameSource`

```python
class FrameSource(Protocol):
    def start(self) -> None: ...
    def read(self) -> FramePacket | None: ...   # None on EOF/stream end
    def stop(self) -> None: ...
    def metadata(self) -> SourceMetadata: ...
```

```python
@dataclass
class FramePacket:
    frame: np.ndarray            # HxW or HxWx1 (monochrome default)
    timestamp_s: float
    frame_index: int
    ground_truth: GroundTruthTarget | None   # populated in simulation; None or annotation-derived in video mode

@dataclass
class SourceMetadata:
    mode: Literal["simulation", "video"]
    fps: float
    resolution: tuple[int, int]
    has_ground_truth: bool
```

Implementations: `SimulationFrameSource`, `VideoFileFrameSource`, optional dev-only `WebcamFrameSource`. Callers (detector/preprocessing) must not branch on `mode` — behavior differences are confined to the source implementation.

## 2. `Detector`

```python
class Detector(Protocol):
    def detect(self, frame: np.ndarray) -> Detection: ...

@dataclass
class Detection:
    found: bool
    x: float | None
    y: float | None
    confidence: float            # [0, 1]
    bbox: tuple[int, int, int, int] | None   # x, y, w, h
    method: Literal["cv", "ai", "fusion"]
    latency_ms: float
```

Every detector (classical, AI, fused) returns this exact shape. The fusion detector's `method` field must reflect which underlying detector actually supplied the winning candidate, not always `"fusion"` — required for provenance reporting (`04-system-architecture.md` §4.9).

## 3. `Tracker`

```python
class Tracker(Protocol):
    def update(self, detection: Detection | None, timestamp_s: float) -> TrackState: ...
    def reset(self) -> None: ...

@dataclass
class TrackState:
    state: Literal["SEARCH", "CANDIDATE", "ACQUIRE", "TRACK", "PREDICT_REACQUIRE"]
    x: float | None
    y: float | None
    vx: float | None
    vy: float | None
    confidence: float
    track_age_frames: int
    lost_frames_consecutive: int
    is_prediction: bool          # true when x,y came from Kalman prediction, not a fresh detection
```

`update()` is called exactly once per frame, even when `detection is None` (missed frame) — the tracker is responsible for its own prediction/timeout/state-transition logic per `04-system-architecture.md` §4.12.

## 4. `Controller`

```python
class Controller(Protocol):
    def compute(self, target_xy: tuple[float, float] | None,
                center_xy: tuple[float, float],
                fov_deg: tuple[float, float],
                image_size_px: tuple[int, int],
                dt_s: float) -> PanTiltCommand: ...
    def reset_integrator(self) -> None: ...

@dataclass
class PanTiltCommand:
    pan_deg_s: float
    tilt_deg_s: float
```

**Contract detail (fixes the unit-mismatch issue found in review):** implementations must convert `target_xy`/`center_xy` pixel error to angular error using `fov_deg` and `image_size_px` **inside `compute()`, before** applying any control law. `fov_deg` and `image_size_px` are therefore required parameters of the contract, not optional — a controller cannot correctly implement this interface using pixel error alone. See `04-system-architecture.md` §4.13 for the exact conversion.

When `target_xy is None` (no target/prediction available), `compute()` must return a scan/search command per the configured search strategy, not a zero command — zero would leave the camera motionless during SEARCH.

## 5. `DisturbanceModel`

```python
class DisturbanceModel(Protocol):
    def apply(self, frame: np.ndarray, state: DisturbanceState, rng: np.random.Generator) -> np.ndarray: ...
```

Disturbance models receive an explicit `rng` (never global random state) so runs are reproducible under a fixed seed. Multiple `DisturbanceModel` instances are chained; each must be a pure function of `(frame, state, rng)` with no side effects outside the returned frame.

## 6. `MetricsEngine` / `ReportGenerator`

```python
class MetricsEngine(Protocol):
    def on_frame(self, frame_index: int, timestamp_s: float,
                 ground_truth: tuple[float, float] | None,
                 track_state: TrackState,
                 command: PanTiltCommand,
                 processing_ms: float) -> None: ...
    def finalize(self) -> RunResult: ...

class ReportGenerator(Protocol):
    def export(self, run_result: RunResult, events_path: str, out_dir: str) -> None: ...
```

`RunResult` matches the `metrics.json` schema in `05-database-schema.md` §4 exactly — the two documents must be kept in sync; `RunResult` is the dataclass, `metrics.json` is its serialized form.

## 7. Optional Local Monitoring API (Tier 3, stretch)

If time permits, a minimal read-only local HTTP endpoint (e.g. `http://127.0.0.1:8765`) can expose live run state for a second screen or judge dashboard, without adding a network dependency to core operation (still fully offline-capable if this is disabled).

| Endpoint | Method | Returns |
|---|---|---|
| `/run/current` | GET | Current `TrackState` + `PanTiltCommand` snapshot |
| `/run/current/metrics` | GET | Streaming metrics snapshot (subset of `RunResult`) |
| `/runs` | GET | List of `run_id`s from the SQLite registry |
| `/runs/{run_id}` | GET | Full `RunResult` for a completed run |

This is explicitly **not required** for any evaluation stage and must not be built before Tier 0–2 are complete and demo-ready.

## 8. Contract Testing Requirement

Every concrete implementation of the five core protocols (`FrameSource`, `Detector`, `Tracker`, `Controller`, `DisturbanceModel`) must pass a shared contract test suite (schema shape, value ranges, `dt=0` handling, `None`-input handling) before being wired into the main pipeline — see `12-testing-strategy.md` §Contract Tests.
