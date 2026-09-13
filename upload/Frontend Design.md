# FSOC-PAT Frontend Design Specification

## 0. Document Purpose

This document is the frontend source of truth for the FSOC-PAT application:

**AI-Assisted Virtual Camera Tracking System for Coarse Alignment of Mobile Free Space Optical Communication (FSOC) Terminals**

The frontend shall be implemented as a **professional Next.js desktop web interface** for the local simulation/control application or as the visual shell around the Python/PySide6 engine through a future bridge.

The design goal is not to look like a generic "AI dashboard", a SaaS landing page, or a vibecoded prototype.

It must look like a **real aerospace/optical tracking operations console**: restrained, technical, information-dense, precise, calm, and credible.

The UI should communicate:

> "This is a serious engineering instrument used to develop and validate an optical coarse-pointing algorithm."

The frontend must make it visually obvious that the system is actually working:
- the beacon is moving,
- the camera is moving,
- the detector is finding the beacon,
- the tracker is predicting it,
- the controller is generating pan/tilt commands,
- disturbances are affecting the scene,
- and the measured performance is improving or degrading.

---

# 1. Product Design Principles

## 1.1 Primary Principles

### Instrument, not website

The application should feel like instrumentation software, not a marketing website.

Avoid:
- giant hero sections,
- excessive rounded cards,
- excessive gradients,
- glowing neon everywhere,
- random glassmorphism,
- fake 3D illustrations,
- excessive icon usage,
- unnecessary animations.

Use:
- strong hierarchy,
- measured spacing,
- thin technical borders,
- restrained surfaces,
- precise typography,
- data visualization,
- functional controls,
- meaningful motion.

### Evidence over decoration

Every visual element should answer one of these questions:

1. Where is the beacon?
2. Is it detected?
3. Is it being tracked?
4. Where is the virtual camera pointing?
5. How much error exists?
6. What disturbance is active?
7. Is the system inside the PS-169 target?
8. What happened during this run?

### Spatial hierarchy

The screen must visually prioritize:

1. Camera viewport
2. System state
3. Tracking/performance metrics
4. Scenario/control configuration
5. Event logs

The camera viewport is the primary canvas.

---

# 2. Overall Visual Direction

## 2.1 Theme

**Professional dark aerospace laboratory theme**

Base:

- Background: near-black charcoal, not pure black
- Primary surfaces: dark graphite
- Secondary surfaces: slightly elevated graphite
- Borders: neutral low-contrast gray
- Text: soft white
- Secondary text: cool gray
- Positive status: restrained green
- Warning: amber
- Error/lost: red
- Active optical beacon: warm white / pale cyan
- Technical accent: muted cyan-blue

Do not use cyan/purple gradients.

## 2.2 Suggested Color Tokens

```css
:root {
  --bg-0: #0a0d10;
  --bg-1: #0e1216;
  --bg-2: #13181d;
  --bg-3: #181f25;

  --border-1: #252c33;
  --border-2: #313a43;

  --text-0: #f3f6f8;
  --text-1: #c3ccd4;
  --text-2: #7d8994;
  --text-3: #58636d;

  --accent-cyan: #72d9e8;
  --accent-blue: #8faee8;

  --success: #79c99b;
  --warning: #d8b56b;
  --danger: #d87575;

  --beacon: #fff7d8;
  --ground-truth: #90a7ff;
  --prediction: #d7b36e;
}
```

The colors should be used sparingly. The majority of the application remains neutral.

## 2.3 Visual Materials

Use subtle depth through:

- 1px borders
- 8–12px radius
- 10–25px shadows
- very subtle backdrop blur only where useful
- slightly different surface elevations

Avoid:
- giant shadows,
- inflated cards,
- floating widgets with excessive blur,
- glossy effects.

---

# 3. Typography

Use one serious UI family and one optional technical numeric family.

Recommended:

```text
UI:
Inter

Technical / numeric:
IBM Plex Mono
```

Fallback:

```text
system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
```

Numbers that represent measurement should use tabular figures.

Examples:

```text
48.6 FPS
4.21 px
1.12 s
97.1 %
+2.40 °/s
```

Numeric values must visually align between frames.

---

# 4. Layout Philosophy

The main application should use a **three-column operations layout**.

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ TOP SYSTEM BAR                                                               │
├───────────────┬───────────────────────────────────────────┬──────────────────┤
│               │                                           │                  │
│ LEFT CONTROL  │            PRIMARY WORKSPACE              │ RIGHT TELEMETRY  │
│ PANEL         │                                           │ PANEL            │
│               │     Camera / Scene / 3D workspace        │                  │
│               │                                           │                  │
│               │                                           │                  │
├───────────────┴───────────────────────────────────────────┴──────────────────┤
│ TIMELINE / ERROR PLOT / STATE HISTORY                                       │
├──────────────────────────────────────────────────────────────────────────────┤
│ EVENT LOG / SYSTEM CONSOLE                                                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

The desktop viewport should be optimized around:

```text
1440 × 900
1600 × 1000
1920 × 1080
```

Do not design around mobile first. This is an engineering desktop application.

A responsive fallback may support smaller displays, but the primary experience is desktop.

---

# 5. Application Shell

## 5.1 Top System Bar

Height:

```text
56–64 px
```

Content:

### Left

```text
FSOC-PAT
Virtual Coarse Alignment Laboratory
```

Use a small monochrome optical/reticle mark.

Do not use a generic rocket icon.

### Center

Live run status:

```text
SIMULATION
● RUNNING
RUN 0042
```

State color should be subtle.

### Right

```text
FPS 48.6
CPU 31%
MEM 1.2 GB
[Pause]
[Stop]
[Settings]
```

The top bar is for system-level status, not detailed metrics.

---

# 6. Navigation

Avoid a large traditional website sidebar.

Use a narrow operational rail:

```text
┌──────┐
│ FSOC │
├──────┤
│ ◉    │  Mission / Run
│ ◫    │  Scenarios
│ ◇    │  Live Tracking
│ ◎    │  Analytics
│ ≡    │  Logs
│ ⚙    │  Settings
└──────┘
```

Width:

```text
64–72 px
```

Tooltips explain each icon.

The active section uses:
- thin cyan indicator,
- slightly elevated background,
- no oversized icon.

---

# 7. Primary Dashboard

The default page is the **Mission Control / Live Run** screen.

## 7.1 Main Composition

```text
┌────────────────────┬────────────────────────────────────┬─────────────────────┐
│ RUN CONFIGURATION  │                                    │ TRACKING STATUS     │
│                    │                                    │                     │
│ Scenario            │                                    │ ● TRACK             │
│ Figure-8            │                                    │                     │
│                    │          CAMERA VIEW                │ Beacon #01          │
│ Beacon              │                                    │ Confidence 0.97     │
│ 10 × 10 px          │                                    │                     │
│                    │                                    │ Position            │
│ FOV                  │              ✦                     │ X 312.4             │
│ 4° × 3°             │              +                     │ Y 228.9             │
│                    │                                    │                     │
│ Pan limit            │                                    │ Error               │
│ 5 °/s                │                                    │ 4.21 px             │
│                    │                                    │                     │
│ Disturbances         │                                    │ Pan +2.40 °/s       │
│ Gaussian ON          │                                    │ Tilt -0.80 °/s      │
│ Jitter ON            │                                    │                     │
├────────────────────┴────────────────────────────────────┴─────────────────────┤
│ ERROR / TRAJECTORY / LOCK TIMELINE                                             │
├────────────────────────────────────────────────────────────────────────────────┤
│ EVENT LOG                                                                       │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

# 8. Camera Viewport

This is the most important UI component.

## 8.1 Camera View

The viewport should feel like an actual scientific imaging monitor.

Use:
- dark image area,
- very thin frame border,
- subtle crosshair,
- reticle ring,
- target box,
- target centroid,
- predicted centroid,
- optional ground-truth marker in development mode.

Example:

```text
┌────────────────────────────────────────────┐
│ CAM-01                         640×480      │
│                                            │
│                                            │
│                    ┌────┐                  │
│                    │  ✦ │                  │
│                    └─┬──┘                  │
│                      │ detection           │
│                      ○ prediction          │
│                                            │
│                         +                  │
│                       center               │
│                                            │
│ FOV 4.0° × 3.0°                 TRACK      │
└────────────────────────────────────────────┘
```

## 8.2 Overlay Legend

```text
✦ Beacon / detected centroid
○ Kalman predicted position
+ Desired camera center
□ Detection bounding box
┄ Ground truth (debug only)
```

The legend must be subtle and compact.

## 8.3 Camera HUD

Top-left:

```text
CAM-01
640 × 480
4.0° × 3.0°
30 Hz
```

Top-right:

```text
TRACK
CONF 0.97
```

Bottom-left:

```text
PAN   +12.42°
TILT   -3.81°
```

Bottom-right:

```text
ERR 4.21 px
```

Do not put ten floating cards inside the viewport.

---

# 9. 3D Scene View

The application should include a **real 3D spatial view**, but it must be technically useful.

Use:

```text
Three.js
@react-three/fiber
@react-three/drei
```

The 3D view is an engineering visualization of:

- target/beacon position,
- virtual camera pose,
- camera optical axis,
- FOV cone,
- target trajectory,
- pan/tilt orientation,
- world frame.

## 9.1 3D Scene

```text
                   ✦ Beacon
                  /|
                 / |
                /  |
           ····/···|···· trajectory
              /
             /
          ╱───────╲
         ╱  FOV    ╲
        ╱           ╲
       📷 Camera
```

## 9.2 3D Objects

### Camera

Use a simple technical frustum model.

### Beacon

Use:
- tiny emissive core,
- restrained halo,
- no giant bloom.

### FOV

Transparent wireframe cone.

### Target trajectory

Thin line.

### Ground plane

Optional, very subtle grid.

### Coordinate axes

Small XYZ axis indicator.

---

# 10. Simulation Workspace

The Simulation workspace should let the user configure a scenario without feeling like a giant form.

Use grouped panels.

## 10.1 Scenario

```text
Scenario
──────────────────────────
Preset        Figure-8
Seed          42
Duration      60 s
```

## 10.2 Camera

```text
Camera
──────────────────────────
Resolution    640 × 480
FOV           4.0 × 3.0°
Update rate   30 Hz
Max pan       5 °/s
Max tilt      5 °/s
```

## 10.3 Target

```text
Beacon
──────────────────────────
Count         1
Size          10 × 10 px
Intensity     1.00
Start X       Random
Start Y       Random
Motion        Figure-8
Speed         1.2
```

## 10.4 Disturbance

```text
Disturbance
──────────────────────────
Gaussian       ON
Sigma          4 px

Jitter         ON
Max            8 px/frame

Atmosphere     Haze
Platform       Linear
```

Fields should use compact controls and numeric steppers.

Avoid giant sliders for exact engineering parameters.

---

# 11. Algorithm Panel

The user must be able to see exactly which algorithm is running.

```text
PERCEPTION
Detector
  ● Classical CV
  ○ AI
  ○ Fusion

TRACKING
Tracker
  ● Kalman CV

CONTROL
Controller
  ● PID Angle Space

SEARCH
Pattern
  ● Raster
  ○ Spiral
```

Show advanced parameters only when requested:

```text
Advanced
──────────────
Threshold
Morphology
Min area
Max area
Kalman Q
Kalman R
Kp
Ki
Kd
Deadband
Prediction timeout
```

Use disclosure sections.

---

# 12. Live Tracking Status

The right telemetry panel is the "single source of truth" for run state.

## 12.1 State Header

Large but restrained:

```text
● TRACK
```

Below:

```text
Beacon #01
Acquired 00:01.12
Track age 1,482 frames
```

## 12.2 Position

```text
POSITION
X          312.4 px
Y          228.9 px
VX          34.2 px/s
VY          -8.4 px/s
```

## 12.3 Error

```text
TRACKING ERROR

4.21 px
```

Below:

```text
Target limit
≤ 10 px
```

The official PS target should be visually distinct from internal thresholds.

## 12.4 Control Output

```text
CONTROL

PAN       +2.40 °/s
TILT      -0.80 °/s

LIMIT
PAN        5.00 °/s
TILT       5.00 °/s
```

---

# 13. Performance Cards

Use a compact grid:

```text
┌─────────────┬─────────────┬─────────────┐
│ FPS         │ AVG ERROR   │ LOCK        │
│ 48.6        │ 4.21 px     │ 97.1 %      │
├─────────────┼─────────────┼─────────────┤
│ ACQ         │ RE-ACQ      │ LOSS        │
│ 1.12 s      │ 0.54 s      │ 2.3 %       │
└─────────────┴─────────────┴─────────────┘
```

Each card includes:

- current value,
- unit,
- tiny trend indicator,
- benchmark status.

Example:

```text
FPS
48.6
✓ ≥ 20 FPS
```

Never use huge "100/100" gamification.

---

# 14. Benchmark Compliance View

Create a dedicated panel called:

**PS-169 Benchmark**

It should show the official requirements directly.

```text
PS-169 BENCHMARK

Acquisition Time
1.12 s
TARGET ≤ 2.00 s
PASS

Average Tracking Error
4.21 px
TARGET ≤ 10 px
PASS

Target Loss
2.30 %
TARGET < 5 %
PASS

Re-acquisition
0.54 s
TARGET ≤ 1.00 s
PASS

Algorithm FPS
48.6
TARGET ≥ 20 FPS
PASS
```

Use restrained pass/fail indicators.

This is especially important for the SIH demonstration.

---

# 15. Charts

The frontend must prioritize engineering charts over decorative graphics.

## 15.1 Tracking Error

Line chart:

```text
error px
 20 │
 15 │       ╭─╮
 10 │───────┼─╰──── target
  5 │  ╭─╮  │
  0 │──╯ ╰────────────
     time →
```

Show:
- current value,
- mean,
- max,
- official 10 px threshold.

## 15.2 Target vs Camera Center

Plot:

```text
Ground truth
Detected
Prediction
Camera center
```

This makes the controller behavior understandable.

## 15.3 Lock Timeline

Horizontal state strip:

```text
SEARCH  ACQUIRE  TRACK──────────────  PREDICT  TRACK
```

Use small state bands, not large colorful blocks.

## 15.4 Pan/Tilt Output

Two synchronized traces:

```text
PAN rate
TILT rate
```

Show configured limits.

---

# 16. Event Log

The bottom log should behave like an engineering console.

```text
14:02:31.012  INFO   Simulation started        run=0042
14:02:31.442  DETECT Beacon candidate          conf=0.92
14:02:31.712  STATE  CANDIDATE → ACQUIRE
14:02:32.124  STATE  ACQUIRE → TRACK
14:02:32.124  METRIC Acquisition              1.12s
14:02:36.820  DIST   Camera jitter             7.4px
14:02:37.014  TRACK  Prediction engaged
14:02:37.412  STATE  PREDICT → TRACK
```

Use monospace.

Provide:
- severity filter,
- search,
- pause/follow tail,
- copy,
- export.

---

# 17. Scenario Builder

Provide a professional scenario-builder experience.

## Scenario List

```text
SCENARIOS

PS169-01  Straight / Clear
PS169-02  Circular / Clear
PS169-03  Figure-8 / Clear
PS169-04  Random / Clear
PS169-05  Gaussian Noise
PS169-06  Salt & Pepper
PS169-07  Poisson
PS169-08  Camera Jitter
PS169-09  Haze
PS169-10  Fog
PS169-11  Rain
PS169-12  Low Light
PS169-13  Platform Motion
PS169-14  High Disturbance
```

Each scenario should show:
- seed,
- duration,
- disturbance profile,
- expected difficulty.

---

# 18. Video Benchmark Mode

The external MP4 mode must be visually distinct from simulation.

Header:

```text
VIDEO BENCHMARK
External 30 FPS MP4
```

## Input Area

```text
┌───────────────────────────────────────┐
│ Drop MP4 here                         │
│                                       │
│ or                                    │
│ [Choose video]                        │
└───────────────────────────────────────┘
```

After loading:

```text
sample_test_01.mp4
1920 × 1080
30.00 FPS
Duration 45.2 s
```

## Ground Truth Status

Clearly show:

```text
GROUND TRUTH
● Known GT
```

or:

```text
GROUND TRUTH
● Manual annotation required
```

or:

```text
GROUND TRUTH
● Not available
Perception-only metrics
```

When no ground truth exists, do not fake tracking-error numbers.

Show reference-free metrics instead.

---

# 19. Manual Annotation UI

For video with no ground truth:

```text
FRAME 120 / 1356

              ✦
           Click beacon
```

Tools:

```text
[Previous]
[Next]
[Mark Point]
[Clear]
[Save GT]
```

Show an annotation timeline below.

Sparse annotations may be interpolated for internal analysis.

The UI must clearly label such results as:

```text
MANUALLY ANNOTATED GROUND TRUTH
```

Never present it as official evaluator ground truth.

---

# 20. Results Screen

After a run:

```text
RUN COMPLETE
Figure-8 + Haze
Run #0042
```

Then:

### Summary

```text
Acquisition       1.12 s
Average Error     4.21 px
RMSE              5.63 px
Loss              2.30 %
Re-acquisition    0.54 s
Algorithm FPS     48.4
```

### Benchmark

```text
PS-169
5 / 5 targets passed
```

### Visuals

- tracking error chart,
- lock timeline,
- target/camera trajectory,
- pan/tilt commands.

### Actions

```text
[Export JSON]
[Export CSV]
[Export HTML]
[Replay]
[Compare]
```

---

# 21. Replay Experience

Replay should not re-run the simulation.

It should reconstruct the run from recorded event data.

```text
RUN #0042
00:00 ────────────●──────────── 01:00

▶ Play     ◀ 10f     10f ▶
```

Camera viewport replays:
- detection,
- prediction,
- target,
- center,
- state,
- controller output.

Optional side panel:

```text
Frame 1823
GT           311.0, 229.0
Detected     312.4, 228.9
Predicted    311.8, 229.3
Error        4.21 px
State        TRACK
Pan          +2.40 °/s
```

---

# 22. Experiment Comparison

Provide a technical comparison table:

```text
                     RUN A         RUN B        Δ
-------------------------------------------------------
Detector             Classical      AI           -
Avg Error             5.82 px        4.21 px      -27.7%
RMSE                  7.10 px        5.63 px      -20.7%
Loss                  6.2 %          2.3 %        -3.9 pp
Acquisition           1.42 s         1.12 s       -0.30 s
FPS                   61.2           48.4         -12.8
```

This supports algorithm experiments.

---

# 23. 3D Motion Visualization

The 3D environment should not become a game.

## Camera controls

- orbit
- pan
- zoom
- reset
- top/front/side views

## Optional layers

```text
☑ FOV
☑ Target trajectory
☑ Ground truth
☑ Camera axis
☐ Grid
☐ Platform motion
```

## Camera Frustum

Use the actual configured FOV.

The visualization must update when FOV changes.

---

# 24. Animation Rules

The frontend should have motion, but motion must explain the system.

## Good motion

- beacon movement,
- camera frustum rotation,
- pan/tilt orientation,
- chart streaming,
- state transition,
- target acquisition ring,
- subtle viewport reticle animation.

## Bad motion

- floating cards,
- bouncing buttons,
- arbitrary background particles,
- continuous glow pulses,
- overdone page transitions.

### Timing

```text
micro interaction: 100–160 ms
panel transition:   180–240 ms
major state change: 250–400 ms
```

Use easing that feels mechanical and controlled.

---

# 25. 3D Landing / Welcome Screen

A welcome screen is allowed, but keep it extremely minimal.

It should not look like a SaaS landing page.

Example:

```text
FSOC-PAT
Virtual Coarse Alignment Laboratory

Software environment for simulation,
visual tracking and coarse optical alignment.

[Launch Laboratory]

System
Simulation
Video Benchmark
Results
```

Behind it:

A very subtle animated 3D camera frustum and moving beacon.

No:
- huge hero text,
- stock satellite image,
- glowing earth,
- generic AI brain graphic.

---

# 26. Empty States

Every empty state must teach the user what to do.

Example:

```text
NO ACTIVE RUN

Create or select a simulation scenario
to begin coarse-alignment tracking.

[Open Scenarios]
```

Video:

```text
NO VIDEO LOADED

Load a 30-FPS MP4 benchmark video
to start perception analysis.

[Choose Video]
```

---

# 27. Loading States

Never show a generic "Loading...".

Use contextual language:

```text
Initializing virtual camera...
Generating deterministic trajectory...
Preparing disturbance chain...
Starting detector...
```

For model loading:

```text
Loading AI detector
42 MB / 78 MB
```

---

# 28. Error Handling

Errors must be actionable.

Bad:

```text
Something went wrong.
```

Good:

```text
Unable to start simulation

Camera FOV must be greater than 0°.

Field: Camera → FOV

[Fix parameter]
```

For video:

```text
Unsupported video

Expected:
MP4
Readable video stream
Nominal 30 FPS

Detected:
codec unsupported
```

---

# 29. Accessibility

The engineering interface must not depend only on color.

Every state uses:

- icon,
- label,
- color.

Example:

```text
✓ PASS
! WARNING
× FAIL
● ACTIVE
```

Keyboard shortcuts:

```text
Space       Start/Pause
Esc         Stop
R           Reset camera
L           Toggle logs
G           Toggle ground truth
C           Toggle controls
1           Camera view
2           3D scene
3           Analytics
```

---

# 30. Technical Stack

Recommended frontend:

```text
Next.js 15+
TypeScript
Tailwind CSS
shadcn/ui (used selectively, not wholesale)
Lucide icons
React Three Fiber
Three.js
Recharts
Zustand
Zod
```

Optional:

```text
Framer Motion
```

Use Framer Motion only for purposeful transitions.

## Rendering

Primary 3D:

```text
@react-three/fiber
@react-three/drei
three
```

Charts:

```text
Recharts
```

State:

```text
Zustand
```

Validation:

```text
Zod
```

---

# 31. Frontend Architecture

```text
app/
├── layout.tsx
├── page.tsx
├── laboratory/
│   ├── page.tsx
│   ├── simulation/
│   ├── benchmark/
│   ├── analytics/
│   ├── replay/
│   └── scenarios/
│
components/
├── shell/
│   ├── top-bar.tsx
│   ├── command-rail.tsx
│   └── status-bar.tsx
│
├── camera/
│   ├── camera-viewport.tsx
│   ├── camera-overlay.tsx
│   ├── reticle.tsx
│   └── telemetry-hud.tsx
│
├── scene/
│   ├── scene-3d.tsx
│   ├── beacon.tsx
│   ├── camera-frustum.tsx
│   ├── trajectory-line.tsx
│   └── scene-controls.tsx
│
├── controls/
│   ├── scenario-panel.tsx
│   ├── camera-panel.tsx
│   ├── beacon-panel.tsx
│   ├── disturbance-panel.tsx
│   └── algorithm-panel.tsx
│
├── telemetry/
│   ├── tracking-status.tsx
│   ├── performance-cards.tsx
│   ├── benchmark-panel.tsx
│   └── control-output.tsx
│
├── charts/
│   ├── tracking-error-chart.tsx
│   ├── lock-timeline.tsx
│   ├── trajectory-chart.tsx
│   └── control-output-chart.tsx
│
├── logs/
│   ├── event-log.tsx
│   └── log-filters.tsx
│
├── results/
│   ├── results-summary.tsx
│   ├── pass-fail-table.tsx
│   ├── report-actions.tsx
│   └── comparison-table.tsx
│
└── ui/
    ├── button.tsx
    ├── input.tsx
    ├── select.tsx
    ├── slider.tsx
    └── panel.tsx
```

---

# 32. State Model

The frontend should mirror the backend state machine exactly.

```text
SEARCH
CANDIDATE
ACQUIRE
TRACK
PREDICT_REACQUIRE
```

Do not invent a different UI state naming system.

Example:

```text
Backend:
PREDICT_REACQUIRE

Frontend:
PREDICT / REACQUIRE
```

The mapping must remain one-to-one.

---

# 33. Frontend Data Contracts

The frontend should consume typed objects that mirror the backend contracts.

Example:

```ts
type Detection = {
  found: boolean
  x: number | null
  y: number | null
  confidence: number
  bbox: [number, number, number, number] | null
  method: "cv" | "ai" | "fusion"
  latency_ms: number
}

type TrackState = {
  state:
    | "SEARCH"
    | "CANDIDATE"
    | "ACQUIRE"
    | "TRACK"
    | "PREDICT_REACQUIRE"

  x: number | null
  y: number | null
  vx: number | null
  vy: number | null
  confidence: number
  track_age_frames: number
  lost_frames_consecutive: number
  is_prediction: boolean
}

type PanTiltCommand = {
  pan_deg_s: number
  tilt_deg_s: number
}
```

The frontend must not silently rename units.

---

# 34. Live Data Transport

The preferred integration pattern is:

```text
Simulation / Python Engine
        │
        ▼
Typed Event Stream
        │
        ▼
Frontend Adapter
        │
        ▼
Zustand Store
        │
        ├── Camera View
        ├── Telemetry
        ├── Charts
        └── Event Log
```

Possible transport options:

### Development

WebSocket / local event server.

### Desktop integration

Local bridge between Next.js frontend and Python process.

### Future embedded desktop

Tauri/Electron shell around Next.js.

The frontend must not hard-code transport assumptions into visual components.

---

# 35. Performance Requirements

The UI must remain responsive while the simulation runs at ≥20 FPS processing speed and a default camera update rate of 30 Hz.

Important rule:

**Do not render every raw backend event directly into React state.**

Use:
- sampled chart updates,
- buffered telemetry,
- requestAnimationFrame for viewport animation,
- throttled event-log rendering,
- memoized charts.

Target UI performance:

```text
60 FPS visual interaction
No visible UI freeze during simulation
No uncontrolled DOM growth
```

---

# 36. Responsive Behavior

Primary target:

```text
1440 × 900 and above
```

At 1200–1439 px:

```text
collapse left control groups
maintain camera viewport
```

Below 1100 px:

```text
three columns → two columns
```

Below 850 px:

```text
desktop warning:
"FSOC-PAT Laboratory is optimized for desktop engineering workflows."
```

Do not redesign the application into a mobile card dashboard.

---

# 37. Dark Theme Details

Panels should be visually separated without obvious cards everywhere.

Example surfaces:

```text
Application       #0a0d10
Panel              #0e1216
Elevated panel     #13181d
Hover              #181f25
Border             #252c33
```

Use hairline borders.

Panel radius:

```text
8px–12px
```

Avoid:

```text
20px+
```

because that makes the UI feel like consumer SaaS.

---

# 38. Design Tokens

```ts
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  "2xl": 32,
}

export const radius = {
  sm: 6,
  md: 8,
  lg: 12,
}

export const typography = {
  label: "12px",
  body: "14px",
  value: "22px",
  heroValue: "32px",
}
```

---

# 39. Component Rules

## Buttons

Primary:

```text
Start Run
```

Secondary:

```text
Pause
Reset
Save Scenario
```

Danger:

```text
Stop Run
```

Do not make every action a filled button.

## Inputs

Use compact engineering controls.

Good:

```text
FOV
[ 4.0 ] ° × [ 3.0 ] °
```

Bad:

```text
FOV
[giant rounded card slider]
```

## Tooltips

Use for advanced concepts:

- FOV
- acquisition timeout
- prediction timeout
- Kalman Q/R
- lock radius

---

# 40. Beacon Visualization

The beacon should be one of the strongest visual signals.

In 2D:

```text
       ✦
     ╱   ╲
    │  ●  │
     ╲   ╱
```

In 3D:
- central emissive point,
- small halo,
- no exaggerated bloom.

When detected:

```text
BEACON ACQUIRED
```

show a short acquisition ring animation.

When lost:

```text
TARGET LOST
```

use a brief red state transition, then return to neutral tracking colors.

---

# 41. Target Tracking Demonstration Mode

Add a toggle:

```text
DEBUG OVERLAY
☑ Ground truth
☑ Detection
☑ Prediction
☑ Camera center
☑ FOV
```

This is important for development and judge demonstration.

A judge should be able to see:

```text
ground truth ✕
detected      ○
prediction    △
camera center +
```

in one view.

---

# 42. "Proof of Work" Mode

Create a dedicated optional panel called:

**Tracking Proof**

It shows:

```text
GROUND TRUTH
      ✕
      │
DETECTED
      ○
      │
PREDICTED
      △
      │
CAMERA CENTER
      +
```

And:

```text
Pixel error        4.21 px
Angular error      0.026°
Prediction residual 1.8 px
Controller output  +2.40 °/s
```

The goal is to visually prove that the pipeline is functioning.

---

# 43. PS-169 Compliance Display

Use a persistent benchmark badge:

```text
PS-169
4 / 5 PASS
```

Clicking it opens the complete compliance table.

Never claim compliance when a metric is not computable.

---

# 44. Design for Demo Day

The default demo flow should be:

```text
1. Open FSOC-PAT
2. Choose PS-169 Figure-8 scenario
3. Click Start
4. Beacon enters camera FOV
5. Detection appears
6. State becomes TRACK
7. Camera follows target
8. Enable jitter + Gaussian noise
9. Error increases briefly
10. Kalman prediction activates
11. Target is reacquired
12. Results show metrics
13. Open PS-169 benchmark panel
14. Export report
15. Load external MP4 benchmark
16. Run perception pipeline
```

The UI should allow this without navigating through many screens.

---

# 45. What the Design Must NOT Look Like

Avoid a visual style like:

```text
Huge gradient hero
+
glass cards
+
purple AI glow
+
3D earth
+
floating orb
+
random graphs
+
"AI POWERED" badges
```

That will look like a generated portfolio project.

Instead:

```text
Dark engineering console
+
camera viewport
+
3D optical frustum
+
measured telemetry
+
precise controls
+
scientific charts
+
event stream
+
benchmark evidence
```

This is the intended visual identity.

---

# 46. Suggested Page Map

```text
/
└── Launch / System Overview

/laboratory
└── Main live operations dashboard

/laboratory/scenarios
└── Scenario library + builder

/laboratory/benchmark
└── MP4 benchmark mode

/laboratory/analytics
└── Results + metrics

/laboratory/replay
└── Historical run replay

/laboratory/comparison
└── Run-to-run comparison

/settings
└── Application configuration
```

---

# 47. Final Frontend Architecture

```text
                         FSOC-PAT FRONTEND
                                │
                         Next.js + TypeScript
                                │
             ┌──────────────────┼──────────────────┐
             │                  │                  │
             ▼                  ▼                  ▼
         2D Camera           3D Scene          Telemetry
         Viewport             Viewer             HUD
             │                  │                  │
             └──────────────────┼──────────────────┘
                                │
                         Zustand Store
                                │
         ┌──────────────────────┼──────────────────────┐
         │                      │                      │
         ▼                      ▼                      ▼
      Detector               Tracker               Controller
      events                events                 commands
         │                      │                      │
         └──────────────────────┼──────────────────────┘
                                │
                           Metrics Engine
                                │
                   ┌────────────┴────────────┐
                   ▼                         ▼
                Charts                  Event Log
                   │                         │
                   └────────────┬────────────┘
                                ▼
                           Run Results
                                │
                  ┌─────────────┼─────────────┐
                  ▼             ▼             ▼
                JSON          CSV          HTML
```

---

# 48. Definition of Frontend Done

The frontend is considered complete when:

- The main dashboard clearly shows the live camera feed.
- The moving beacon is visually obvious.
- Detection, prediction and camera center overlays are visible.
- Camera pan/tilt movement is visible.
- Simulation controls are configurable without editing files.
- Disturbances can be enabled/disabled from the UI.
- SEARCH/CANDIDATE/ACQUIRE/TRACK/PREDICT_REACQUIRE state is visible.
- FPS, acquisition, error, lock, loss, reacquisition and processing metrics are visible.
- PS-169 benchmark targets are displayed separately from internal thresholds.
- Error and trajectory charts update during runs.
- Event logs show meaningful state transitions.
- Results can be exported.
- MP4 benchmark mode is accessible.
- Ground-truth availability is explicitly communicated.
- Replay can visualize a completed run.
- The 3D view shows camera pose, FOV, beacon and trajectory.
- The application never implies that recorded MP4 footage was physically re-pointed.
- The UI remains responsive during a live run.
- The visual language looks like professional engineering software rather than a generic AI/SaaS dashboard.

---

# 49. Final Design Statement

FSOC-PAT should feel like a **virtual optical tracking laboratory**.

The central visual story is:

```text
SCENE
  ↓
BEACON
  ↓
CAMERA
  ↓
DETECTION
  ↓
TRACKING
  ↓
CONTROL
  ↓
CAMERA MOVEMENT
  ↓
METRICS
  ↓
PROOF
```

Every screen should reinforce that loop.

The application should be visually impressive because of the **quality of the simulation, 3D optical geometry, live telemetry and evidence of algorithmic behavior**, not because of decorative UI effects.
