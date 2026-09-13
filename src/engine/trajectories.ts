/**
 * Target trajectory generators (docs/MVP-Tech-Doc §8, docs/04 §4.4).
 * Required: straight, circular, figure8, random. Optional: spiral, sinusoidal.
 * All generators are pure functions of time and produce scene-pixel
 * positions plus velocity estimates.
 */
import type { MotionMode } from './types';
import type { Rng } from './rng';

export interface TrajectoryInit {
  mode: MotionMode;
  speed: number;
  sceneWidth: number;
  sceneHeight: number;
  startX: number | null;
  startY: number | null;
  margin: number;
  rng: Rng;
}

export interface TrajectoryState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface TrajectoryImpl {
  at(t: number): TrajectoryState;
}

/** Straight line with bounce off scene bounds (triangle-wave position). */
class Straight implements TrajectoryImpl {
  private x0: number;
  private y0: number;
  private vx: number;
  private vy: number;
  private minX: number;
  private maxX: number;
  private minY: number;
  private maxY: number;
  private spanX: number;
  private spanY: number;

  constructor(init: TrajectoryInit, rng: Rng) {
    const speed = 60 * init.speed; // px/s at multiplier 1
    const angle = rng() * Math.PI * 2;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    this.minX = init.margin;
    this.maxX = init.sceneWidth - init.margin;
    this.minY = init.margin;
    this.maxY = init.sceneHeight - init.margin;
    this.spanX = this.maxX - this.minX;
    this.spanY = this.maxY - this.minY;
    this.x0 = init.startX ?? this.minX + rng() * this.spanX;
    this.y0 = init.startY ?? this.minY + rng() * this.spanY;
  }

  at(t: number): TrajectoryState {
    const u = this.x0 - this.minX + this.vx * t;
    const v = this.y0 - this.minY + this.vy * t;
    const x = triangle(u, this.spanX) + this.minX;
    const y = triangle(v, this.spanY) + this.minY;
    // velocity sign flips at each bounce
    const dirX = Math.sign(Math.sin((Math.PI * u) / (this.spanX || 1))) || 1;
    const dirY = Math.sign(Math.cos((Math.PI * v) / (this.spanY || 1))) || 1;
    return { x, y, vx: Math.abs(this.vx) * dirX, vy: Math.abs(this.vy) * dirY };
  }
}

/** Triangle wave bounce within [0, span]. */
function triangle(u: number, span: number): number {
  if (span <= 0) return 0;
  const m = ((u % (2 * span)) + 2 * span) % (2 * span);
  return m <= span ? m : 2 * span - m;
}

/** Circular orbit CENTERED ON THE START POSITION — the beacon begins at
 *  (startX, startY) at t=0 and circles around it (pos = start + r·(cos(ωt)−1, sin(ωt))). */
class Circular implements TrajectoryImpl {
  private cx: number;
  private cy: number;
  private r: number;
  private w: number; // angular rate rad/s

  constructor(init: TrajectoryInit, rng: Rng) {
    this.cx = init.startX ?? init.sceneWidth / 2;
    this.cy = init.startY ?? init.sceneHeight / 2;
    const maxR = Math.min(this.cx, this.cy, init.sceneWidth - this.cx, init.sceneHeight - this.cy) - init.margin;
    this.r = Math.min(maxR, 90 + rng() * 220);
    this.w = 0.35 * init.speed; // rad/s
  }

  at(t: number): TrajectoryState {
    const a = this.w * t;
    const x = this.cx + this.r * (Math.cos(a) - 1);
    const y = this.cy + this.r * Math.sin(a);
    return {
      x,
      y,
      vx: -this.r * this.w * Math.sin(a),
      vy: this.r * this.w * Math.cos(a),
    };
  }
}

/** Lissajous figure-8: x = A sin(wt), y = B sin(2wt + phi). */
class Figure8 implements TrajectoryImpl {
  private cx: number;
  private cy: number;
  private a: number;
  private b: number;
  private w: number;
  private phi: number;

  constructor(init: TrajectoryInit, rng: Rng) {
    this.cx = init.startX ?? init.sceneWidth / 2;
    this.cy = init.startY ?? init.sceneHeight / 2;
    this.a = Math.min(init.sceneWidth / 2 - init.margin, 520);
    this.b = Math.min(init.sceneHeight / 2 - init.margin, 300);
    this.w = 0.45 * init.speed;
    this.phi = rng() * Math.PI;
  }

  at(t: number): TrajectoryState {
    const wt = this.w * t;
    return {
      x: this.cx + this.a * Math.sin(wt),
      y: this.cy + this.b * Math.sin(2 * wt + this.phi),
      vx: this.a * this.w * Math.cos(wt),
      vy: 2 * this.b * this.w * Math.cos(2 * wt + this.phi),
    };
  }
}

/** Bounded random walk with smoothed velocity (no per-frame teleporting). */
class RandomMotion implements TrajectoryImpl {
  private x: number;
  private y: number;
  private vx: number;
  private vy: number;
  private minX: number;
  private maxX: number;
  private minY: number;
  private maxY: number;
  private speed: number;
  private rng: Rng;
  private tLast: number;

  constructor(init: TrajectoryInit) {
    this.minX = init.margin;
    this.maxX = init.sceneWidth - init.margin;
    this.minY = init.margin;
    this.maxY = init.sceneHeight - init.margin;
    this.x = init.startX ?? this.minX + (this.maxX - this.minX) * init.rng();
    this.y = init.startY ?? this.minY + (this.maxY - this.minY) * init.rng();
    this.vx = 0;
    this.vy = 0;
    this.speed = 90 * init.speed;
    this.rng = init.rng;
    this.tLast = 0;
  }

  at(t: number): TrajectoryState {
    const dt = Math.max(0, t - this.tLast);
    if (dt > 0) {
      // retarget occasionally
      if (this.rng() < Math.min(0.9, dt * 0.6)) {
        const ang = this.rng() * Math.PI * 2;
        const sp = this.speed * (0.4 + 0.6 * this.rng());
        this.vx = this.vx * 0.55 + Math.cos(ang) * sp * 0.45;
        this.vy = this.vy * 0.55 + Math.sin(ang) * sp * 0.45;
      }
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      if (this.x < this.minX) {
        this.x = this.minX;
        this.vx = Math.abs(this.vx);
      }
      if (this.x > this.maxX) {
        this.x = this.maxX;
        this.vx = -Math.abs(this.vx);
      }
      if (this.y < this.minY) {
        this.y = this.minY;
        this.vy = Math.abs(this.vy);
      }
      if (this.y > this.maxY) {
        this.y = this.maxY;
        this.vy = -Math.abs(this.vy);
      }
      this.tLast = t;
    }
    return { x: this.x, y: this.y, vx: this.vx, vy: this.vy };
  }
}

/** Outward spiral centered on the start position (radius grows from 0). */
class Spiral implements TrajectoryImpl {
  private cx: number;
  private cy: number;
  private w: number;
  private growth: number;
  private maxR: number;

  constructor(init: TrajectoryInit) {
    this.cx = init.startX ?? init.sceneWidth / 2;
    this.cy = init.startY ?? init.sceneHeight / 2;
    this.w = 0.6 * init.speed;
    this.maxR = Math.min(this.cx, this.cy, init.sceneWidth - this.cx, init.sceneHeight - this.cy) - init.margin;
    this.growth = 18 * init.speed;
  }

  at(t: number): TrajectoryState {
    const a = this.w * t;
    const r = Math.min(this.maxR, this.growth * t);
    return {
      x: this.cx + r * Math.cos(a),
      y: this.cy + r * Math.sin(a),
      vx: -r * this.w * Math.sin(a) + this.growth * Math.cos(a),
      vy: r * this.w * Math.cos(a) + this.growth * Math.sin(a),
    };
  }
}

/** Horizontal sweep with slow vertical drift, centered on start position. */
class Sinusoidal implements TrajectoryImpl {
  private cx: number;
  private cy: number;
  private a: number;
  private b: number;
  private w: number;
  private drift: number;

  constructor(init: TrajectoryInit) {
    this.cx = init.startX ?? init.sceneWidth / 2;
    this.cy = init.startY ?? init.sceneHeight / 2;
    this.a = Math.min(init.sceneWidth / 2 - init.margin - Math.abs(this.cx - init.sceneWidth / 2), 600);
    this.b = Math.min(init.sceneHeight / 2 - init.margin - Math.abs(this.cy - init.sceneHeight / 2), 180);
    this.w = 0.5 * init.speed;
    this.drift = 14 * init.speed;
  }

  at(t: number): TrajectoryState {
    const y = clamp(this.cy + this.b * Math.sin(this.w * t) + this.drift * t * 0.08, this.cy - this.b, this.cy + this.b);
    return {
      x: this.cx + this.a * Math.sin(this.w * t * 0.7),
      y,
      vx: this.a * this.w * 0.7 * Math.cos(this.w * t * 0.7),
      vy: this.b * this.w * Math.cos(this.w * t),
    };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function createTrajectory(init: TrajectoryInit): { at(t: number): TrajectoryState } {
  const rng = init.rng;
  switch (init.mode) {
    case 'straight':
      return new Straight(init, rng);
    case 'circular':
      return new Circular(init, rng);
    case 'figure8':
      return new Figure8(init, rng);
    case 'random':
      return new RandomMotion(init);
    case 'spiral':
      return new Spiral(init);
    case 'sinusoidal':
      return new Sinusoidal(init);
  }
}
