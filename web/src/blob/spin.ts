// Turning the drop by hand. While held it follows the finger; let go, it keeps the
// speed of the flick, slows down, and a weak spring wobbles it back to face the
// front. A hard flick carries it over the top of the spring a few times first.

const RETURN = 7; // 1/s², spring towards facing the front
const FRICTION = 1.6; // 1/s
const MAX_SPEED = 30; // rad/s
const STALE = 60; // ms; a finger that rested this long before lifting does not fling

type Quat = [number, number, number, number]; // x, y, z, w

export class Spin {
  /// Angular speed, rad/s, as a rotation vector in view space.
  private vel = [0, 0, 0];
  private q: Quat = [0, 0, 0, 1];
  private held = false;
  private turnedAt = 0;
  /// Column-major, object to view space; kept in step with `q`.
  readonly matrix = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

  get speed(): number {
    return Math.hypot(...this.vel);
  }

  reset(): void {
    this.q = [0, 0, 0, 1];
    this.vel = [0, 0, 0];
    this.held = false;
    this.toMatrix();
  }

  hold(on: boolean): void {
    this.held = on;
    if (on || performance.now() - this.turnedAt > STALE) this.vel = [0, 0, 0];
  }

  /// The finger moved by `dx`, `dy` (radii of the drop, y up) at `at` (ms, as
  /// `performance.now()`): the surface under it moves along.
  turn(dx: number, dy: number, at: number): void {
    const a = [-dy, dx, 0];
    this.q = normalize(mul(fromVector(a), this.q));
    const dt = (at - this.turnedAt) / 1000;
    this.turnedAt = at;
    if (dt > 0 && dt < 0.1) {
      for (let i = 0; i < 3; i++) this.vel[i] += (a[i] / Math.max(dt, 0.004) - this.vel[i]) * 0.6;
      const s = this.speed;
      if (s > MAX_SPEED) this.vel = this.vel.map((v) => (v * MAX_SPEED) / s);
    }
    this.toMatrix();
  }

  /// Advance by `dt` seconds. True while it still moves.
  step(dt: number): boolean {
    if (this.held) return true;
    if (this.speed < 0.03 && Math.hypot(...toVector(this.q)) < 0.005) {
      if (this.q[3] !== 1) this.reset();
      return false;
    }
    // Small fixed steps keep the spring stable on slow frames.
    for (let left = Math.min(dt, 0.1); left > 0; left -= 1 / 240) {
      const h = Math.min(left, 1 / 240);
      const off = toVector(this.q);
      for (let i = 0; i < 3; i++) this.vel[i] += (-RETURN * off[i] - FRICTION * this.vel[i]) * h;
      this.q = normalize(mul(fromVector(this.vel.map((v) => v * h)), this.q));
    }
    this.toMatrix();
    return true;
  }

  /// A view-space direction in object space.
  toObject(x: number, y: number, z: number): [number, number, number] {
    const m = this.matrix;
    return [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
  }

  private toMatrix(): void {
    const [x, y, z, w] = this.q;
    this.matrix.set([
      1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w),
      2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
      2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y),
    ]);
  }
}

function mul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function normalize(q: Quat): Quat {
  const l = Math.hypot(...q);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/// Rotation by `|v|` radians around `v`.
function fromVector(v: number[]): Quat {
  const a = Math.hypot(v[0], v[1], v[2]);
  const s = a < 1e-8 ? 0.5 : Math.sin(a / 2) / a;
  return [v[0] * s, v[1] * s, v[2] * s, Math.cos(a / 2)];
}

/// The shortest rotation vector to `q`, so the spring always takes the short way.
function toVector(q: Quat): number[] {
  const [x, y, z, w] = q[3] < 0 ? q.map((c) => -c) : q;
  const s = Math.sqrt(Math.max(0, 1 - w * w));
  const k = s < 1e-6 ? 2 : (2 * Math.acos(Math.min(1, w))) / s;
  return [x * k, y * k, z * k];
}
