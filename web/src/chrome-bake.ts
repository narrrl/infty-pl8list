// The CPU half of chrome (chrome.ts): a shape's mask baked into the texture its
// shader lights. Runs in a worker (chrome-worker.ts), or inline where there is none.

/// A run of the mask that forms one line: its face runs sky to floor over `height`.
export interface Line {
  left: number;
  top: number;
  width: number;
  height: number;
}

/// A mask to bake, in device px.
export interface BakeJob {
  alpha: Uint8ClampedArray;
  w: number;
  h: number;
  bevel: number;
  depth: number;
  lines: Line[];
}

const INF = 1e20;

/// The mask's alpha to the texture the shader lights: RG the surface normal, B
/// the coverage of the metal (face and side wall), A the shadow under it.
export function bake({ alpha, w, h, bevel, depth, lines }: BakeJob): Uint8Array<ArrayBuffer> {
  const n = w * h;
  const cover = new Float32Array(n);
  // Squared distance from inside the shape to its edge, with sub-pixel edges.
  const grid = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = alpha[i * 4 + 3] / 255;
    cover[i] = a;
    grid[i] = a === 1 ? INF : a === 0 ? 0 : Math.max(0, a - 0.5) ** 2;
  }
  edt(grid, w, h);
  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = Math.min(1, Math.sqrt(grid[i]) / bevel);
    // Mostly a flat chamfer, rounded a little at the top.
    height[i] = 0.6 * t + 0.4 * (1 - (1 - t) * (1 - t));
  }
  // How far down its line each pixel is; each line is a plate curved top to
  // bottom, so its face runs from the sky through the horizon to the floor.
  const run = new Float32Array(n).fill(0.5);
  for (const l of lines) {
    const x0 = Math.max(0, Math.floor(l.left)), x1 = Math.min(w, Math.ceil(l.left + l.width));
    const y0 = Math.max(0, Math.floor(l.top)), y1 = Math.min(h, Math.ceil(l.top + l.height + depth));
    for (let y = y0; y < y1; y++) {
      const v = Math.min(1, (y - l.top) / Math.max(1, l.height));
      for (let x = x0; x < x1; x++) run[y * w + x] = v;
    }
  }
  // Slope per px times the bevel width: a bevel at about 55 degrees.
  const k = 0.5 * bevel * 1.4;
  const shadow = depth ? shadowOf(cover, w, h, depth) : null;
  const out = new Uint8Array(n * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const hx = (x + 1 < w ? height[i + 1] : 0) - (x > 0 ? height[i - 1] : 0);
      const hy = (y + 1 < h ? height[i + w] : 0) - (y > 0 ? height[i - w] : 0);
      let nx = -hx * k, ny = hy * k + 0.38 - run[i] * 0.8, nz = 1;
      // The side wall: the nearest face above, up to `depth` px; the further
      // down from it, the more it faces the floor.
      let m = cover[i];
      let up = 0;
      for (let d = 1; m < 1 && d <= depth && y - d >= 0; d++) {
        if (cover[i - d * w] > 0.5) {
          up = d;
          break;
        }
      }
      if (up) {
        const wall = 1 - m;
        const t = up / depth;
        nx *= m;
        ny = ny * m + wall * -(0.4 + 1.2 * t);
        m = 1;
      }
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      out[i * 4] = Math.round((nx / len) * 127.5 + 127.5);
      out[i * 4 + 1] = Math.round((ny / len) * 127.5 + 127.5);
      out[i * 4 + 2] = Math.round(m * 255);
      out[i * 4 + 3] = shadow ? Math.round(shadow[i] * 255) : 0;
    }
  }
  return out;
}

/// The coverage moved down past the side wall and blurred: the shadow it casts.
function shadowOf(cover: Float32Array, w: number, h: number, depth: number): Float32Array {
  const drop = depth + Math.max(1, Math.round(depth * 0.5));
  const r = Math.max(1, Math.round(depth * 0.8));
  let a: Float32Array<ArrayBuffer> = new Float32Array(cover.length);
  for (let y = drop; y < h; y++) a.set(cover.subarray((y - drop) * w, (y - drop + 1) * w), y * w);
  // Two box blurs each way are close enough to a gaussian.
  for (let pass = 0; pass < 2; pass++) {
    a = boxBlur(a, w, h, r, 1, w);
    a = boxBlur(a, h, w, r, w, 1);
  }
  return a;
}

/// Blur runs of `len` values `step` apart, `count` of them `stride` apart.
function boxBlur(src: Float32Array, len: number, count: number, r: number, step: number, stride: number): Float32Array<ArrayBuffer> {
  const dst = new Float32Array(src.length);
  const norm = 1 / (2 * r + 1);
  for (let j = 0; j < count; j++) {
    const o = j * stride;
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[o + Math.min(len - 1, Math.max(0, i)) * step];
    for (let i = 0; i < len; i++) {
      dst[o + i * step] = sum * norm;
      sum += src[o + Math.min(len - 1, i + r + 1) * step] - src[o + Math.max(0, i - r) * step];
    }
  }
  return dst;
}

/// Felzenszwalb and Huttenlocher's distance transform, in place: columns, then rows.
function edt(grid: Float64Array, w: number, h: number): void {
  const size = Math.max(w, h);
  const f = new Float64Array(size), z = new Float64Array(size + 1), v = new Uint16Array(size);
  for (let x = 0; x < w; x++) edt1d(grid, x, w, h, f, v, z);
  for (let y = 0; y < h; y++) edt1d(grid, y * w, 1, w, f, v, z);
}

function edt1d(grid: Float64Array, offset: number, stride: number, length: number, f: Float64Array, v: Uint16Array, z: Float64Array): void {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  f[0] = grid[offset];
  for (let q = 1, k = 0, s = 0; q < length; q++) {
    f[q] = grid[offset + q * stride];
    const q2 = q * q;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2;
    } while (s <= z[k] && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k], qr = q - r;
    grid[offset + q * stride] = f[r] + qr * qr;
  }
}
