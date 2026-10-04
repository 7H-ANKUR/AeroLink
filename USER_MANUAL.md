# FSOC-PAT — User Manual

**Virtual Coarse Alignment Laboratory** · SIH 2026, Problem Statement 169

This manual covers installing the application, running it, and reading what it tells you.
For the architecture and the component-by-component audit see `README.md` and
`IMPLEMENTATION_STATUS.md`.

> **Software only.** There is no laser, telescope, gimbal or photodetector in this system, and
> nothing here has been tested against optical hardware. Where the interface says *virtual
> receiver*, *virtual pan/tilt mount* or *simulated optical link*, that is meant literally.

---

## 1. Installation

Requires [Bun](https://bun.sh) 1.x. No internet access, API keys or cloud services are needed.

```bash
bun install
bun run db:generate     # Prisma client for the local run registry
bun run dev             # http://localhost:3000
```

For the packaged build:

```bash
bun run build
bun run start
```

The only persistent state is `db/custom.db`, a local SQLite file holding completed runs.
`DATABASE_URL` in `.env` points at it with a repo-relative path — do not change it to an absolute
path, or the registry will break on other machines.

---

## 2. First run — the judge demonstration

On the launch screen press **RUN JUDGE DEMONSTRATION**.

Nothing needs configuring. It runs a fixed-seed 60-second scenario that forces the complete
acquisition chain to happen in order. Watch these four regions:

| Region | What to watch |
|---|---|
| **Optical Acquisition** strip (top) | Phases light up as the engine reaches them — never before |
| **Camera viewport** (centre) | The error vector shrinking as the receiver converges |
| **Receiver Mount** panel (right) | Commanded rate vs actual rate diverging during each slew |
| **Event Log** (bottom) | DETECT → TRACK → CONTROL → MOUNT → LOCK, with real numbers |

Timeline of the demonstration:

```
t+0     receiver searching; beacon near the FOV edge, moving on a figure-8
t+1.2   optical candidate detected
t+1.47  coarse lock acquired
t+18    haze and sensor noise injected
t+24    platform vibration and camera jitter injected
t+31    conditions restored to clear
t+34    beacon occulted for 7 seconds  ← the stress case
t+34.9  Kalman prediction engaged (0.93 s), then an active search sweep (8.57 s)
t+41    beacon returns to the scene
t+43.6  lock restored — 2.63 s after the beacon reappeared
t+60    run ends, report available
```

To run the same thing without a browser: `bun scripts/judge-demo.ts`.

---

## 3. Live simulation

**LAUNCH LABORATORY** on the launch screen, or the top rail icon, opens Mission Control.

- **Start / pause** — `Space`, or the button in the top bar
- **Stop** — `Esc`
- **Ground-truth overlay** — `G`
- **Kill beacon** — `K`

The left column configures the run. It is locked while a run is in progress; stop the run to change
anything. Scenario, camera, and beacon parameters marked **PS** are values fixed by the problem
statement — the input ranges are constrained to what PS-169 allows, so you cannot accidentally
configure an out-of-spec camera.

---

## 4. Disturbance controls

Disturbances affect **what the camera sees**. They never touch ground truth, which is why the
measured error stays meaningful when you turn them on.

| Control | Effect |
|---|---|
| Salt & pepper | Impulse noise, percentage of pixels |
| Gaussian σ | Zero-mean sensor noise, PS maximum 20 grey levels |
| Poisson | Intensity-dependent shot noise |
| Camera jitter | Viewport shake, PS maximum ±20 px/frame |
| Platform motion | Slow mount drift: linear, circular, random, spiral, figure-8 |
| Atmosphere | Clear, haze, fog, rain, low light — contrast and brightness reduction |

Raise Gaussian σ while a run is locked and watch the detector confidence fall in the telemetry
panel while the tracking error rises. The beacon's true position is unchanged; only the
observation degrades.

---

## 4a. Choosing the perception path

**Tracking → Perception** in the left control panel selects which detector runs:

| Option | What runs |
|---|---|
| **Classical CV** | Threshold, connected components, intensity-weighted centroid. No learned component. |
| **Learned AI branch** | The learned branch on its own: a local-contrast proposer (no threshold) finds candidate spots and a trained CNN scores a 24×24 crop of each; the highest-scoring one wins. |
| **Hybrid CV + AI + temporal** | Both branches propose independently. Every candidate is scored by the CNN, followed as a track in world coordinates, and judged over time by a learned track verifier; the decision engine then weighs this against the Kalman prediction, with lock hysteresis and a clutter map of known decoys. |

The tracker, controller, mount and metrics are identical in all three, so switching changes
perception and nothing else — which is what makes comparing them meaningful. (A fourth,
full-frame learned detector exists for the benchmark only; it is too slow for the live loop.)

The learned options are **disabled unless a trained model is deployed** at
`public/models/beacon-roi-v2.bin`, and the hybrid additionally needs
`public/models/track-verifier-v1.json`. They are never silently substituted with classical CV: a
run configured for a learned detector with no model present fails and says so. See
`docs/AI-DETECTOR.md` for how the models were trained and what they were measured to do.

The **Perception Chain** panel on the right shows, for the current frame, what each branch
proposed, what the model scored it, how far the chosen candidate was from the Kalman prediction,
and — for the hybrid — the chosen candidate's track: its age, world speed, the verifier's
P(beacon), how many candidates were rejected as known decoys, and the size of the clutter map.
With classical CV selected the panel says plainly that no learned model is active.

**Optical blur** and **Exposure** (Disturbance section) add a Gaussian optical point-spread
function and exposure motion smear. Both default to 0, the setting every published benchmark
was measured with.

---

## 5. Signal-loss demonstration

Press **K**, or the **KILL BEACON (LOSS DEMO)** button at the bottom of the telemetry panel.

The beacon is removed from the rendered scene — not hidden from the metrics, actually not drawn.
The detector genuinely stops seeing it. What follows is real behaviour, not a script:

```
TRACK              lock held
  ↓ 2 missed frames
PREDICT_REACQUIRE  Kalman propagates the estimate; no measurements
  ↓ 1 s lost timeout
SEARCH             the mount physically sweeps, expanding from the boresight
  ↓ a real detection
CANDIDATE → ACQUIRE → TRACK
```

Short outages (under about a second) recover during the prediction phase, typically in ~0.1 s.
Long blackouts force the full search. In the judge demonstration a 7-second blackout relocks
**2.63 s after the beacon comes back** — the mount has to sweep back to wherever the beacon
reappeared, which takes real time under the rate and acceleration limits.

**Reading the reacquisition number honestly:** the reported reacquisition time runs from
loss-confirmed to relock, so it *includes* the time the beacon was absent. A 7-second blackout can
therefore never meet the 1-second PS gate — no algorithm could. The demonstration reports both the
gate result and the post-visibility relock time, which is the figure that actually measures the
software.

---

## 6. Replay

**Replay** in the left rail lists completed runs from the registry.

Select a run to load its stored per-frame timeline. Transport controls: step back, play/pause, step
forward, and a scrub slider.

Everything on the screen is driven by the same cursor into that one timeline — the scene view, the
receiver-mount schematic, the tracking-error trace with its cursor marker, and the state timeline.
Scrub to any frame and all of them show that frame. Nothing is re-simulated; you are looking at
recorded engine state.

Use the state timeline to jump to the interesting moment: the colour changes at each state
transition, so a loss and its recovery are visible at a glance.

---

## 7. MP4 benchmark

**Benchmark** in the left rail. Load a 30-fps MP4.

This mode is **perception only**, and the interface says so. Recorded pixels cannot be re-pointed
by a controller, so the detector and tracker run on the decoded frames while the controller's
commands are computed and logged but cannot close the loop. Any product that claimed otherwise
would be claiming something physically impossible.

Without a ground-truth file the geometric metrics (tracking error, RMSE, target loss against truth)
are reported as unavailable rather than estimated. What you still get: detection rate, processing
FPS, confidence statistics, track continuity and reacquisition events.

With an evaluator-supplied ground-truth file, the geometric metrics are enabled.

Headless equivalent: `bun scripts/mp4-demo.ts <file.mp4>`.

---

## 8. Reports and export

A run generates three artefacts:

| File | Contents |
|---|---|
| `metrics.json` | The complete `RunResult`: every metric plus the exact config that produced it |
| `events.csv` | One row per frame, 19 columns — the timeline replay reads |
| `summary-report.html` | Human-readable report with the PS-169 gate table |

Completed runs are also written to the local registry and appear in Analytics, Replay and
Comparison.

The benchmark writes its own evidence tree:

```bash
bun scripts/batch-test.ts
# → benchmark-results/<timestamp>/raw-runs.json    all 70 runs, config included
#   benchmark-results/<timestamp>/aggregate.json   per-scenario means + gate verdicts
#   benchmark-results/<timestamp>/per-seed.csv     one row per seeded run
```

---

## 9. Reading the telemetry

### Tracking state

| State | Meaning |
|---|---|
| `SEARCH` | No target. The mount is sweeping. |
| `CANDIDATE` | Something detected, not yet confirmed. |
| `ACQUIRE` | Confirming over consecutive frames. |
| `TRACK` | Locked and following. |
| `PREDICT_REACQUIRE` | Measurements lost; the Kalman filter is propagating. |

### Two different errors — this distinction matters

| Metric | What it measures |
|---|---|
| **Centroiding error** | Detector centroid vs true beacon position. How good the *computer vision* is. Typically 0.8 px. |
| **Tracking error** | Kalman estimate vs true position. How good the *whole loop* is, including lag during slews. |

The PS benchmark stages grade centroiding error by name. They are not the same number and the
application reports them separately.

### Receiver mount

**Commanded** rate is what the controller asked for. **Actual** rate is what the mount achieved.
They differ during every transient because the mount has finite angular acceleration — if they were
always identical the mount would be a fiction. Saturation reads `SLEWING` while accelerating,
`RATE LIMITED` at the speed limit, `TRAVEL LIMIT` at the end of mechanical travel.

### Simulated optical link

A model of what a link would do given the achieved pointing error. Not a measurement. It exists to
show the consequence of alignment: signal level and margin rise as the error falls, and the link
drops when the beacon is lost.

### Evidence panel

Integrity checks computed live from the run:

| Check | Passing means |
|---|---|
| Beacon never moved toward the camera | The rendered beacon matched its analytic trajectory exactly |
| Camera pose changes only via the mount | Every pose change is accounted for by mount motion |
| Lock requires a real detection | No lock was entered without a measurement |
| Detector produced measurements | The detector is actually running |
| Kalman prediction carried the outage | Prediction genuinely bridged the loss |

`N/A` means the run has not done that thing yet — it is never a silent pass.

---

## 10. Troubleshooting

**Analytics/Replay/Comparison are empty, `/api/runs` returns 503**
The registry cannot open the database. Check `DATABASE_URL` in `.env` is `file:../db/custom.db` and
run `bun run db:generate`. An absolute path from another machine is the usual cause.

**Nothing appears in the viewport; it says NO SIGNAL**
No run is active. Press `Space` or use Start Run. The viewport shows the engine's frame buffer, so
with no run there is genuinely nothing to show.

**"ENGINE OFFLINE"**
The Web Worker failed to start. Check the browser console. The UI deliberately shows no telemetry
in this state rather than displaying stale or invented values.

**Acquisition never completes**
Check the Evidence panel: if *Detector state* reads `DETECTOR OFF`, the diagnostic switch is
engaged and acquisition cannot complete — that is what the switch demonstrates. The same applies to
`CONTROLLER OFF`, where the mount will never move.

**The run fails a PS-169 gate**
That is the honest result for the configuration you chose. Gates are computed from the run, never
assumed. Heavy disturbance, a fast beacon or a long blackout will legitimately fail them — the
14 benchmark scenarios are the calibrated reference.

**`bun run build` fails on `cp`**
Older revisions used `cp -r`, which Bun's Windows shell rejects. It is `cp -R` now; if you have
edited `package.json`, restore the `-R`.

**Benchmark numbers differ slightly between machines**
Algorithm FPS is machine-dependent — it measures your CPU. Acquisition, error, loss and
reacquisition are deterministic for a given seed and should match exactly.
