// Chrome: the playing card's title, its waveform and the logo as bevelled,
// polished metal, after chrome lettering. Drawn by WebGL2, not by CSS.
//
// A shape (glyphs or waveform bars) is drawn as a mask on a 2D canvas. A distance
// transform turns the mask into a height field: every edge is a bevel of a fixed
// width, so thin strokes become sharp ridges, like blades, and thick ones get a
// flat face. A fragment shader then lights it as a mirror: normals from the
// slope, the reflection of a studio around it (softboxes in a pale sky, a dark
// horizon, the card's colour and art as the floor), split per colour channel at
// the steep edges, a highlight that follows the pointer and flares on kicks.
//
// One WebGL2 context, offscreen, serves every plate: each render is copied into
// the plate's own 2D canvas, so a page full of chrome costs one context.

const MAX_DPR = 2;
const ART_SIZE = 64; // the art is only ever seen blurred, in reflections

/// What a plate shows.
export type Kind = "text" | "wave";

/// A surface to draw chrome on: a 2D canvas on the page and its shape on the GPU.
export interface Plate {
  canvas: HTMLCanvasElement;
  kind: Kind;
  /// Size in device px, and the bevel width.
  w: number;
  h: number;
  bevel: number;
  /// The shape as uploaded (R height, G coverage, B height within the line).
  pixels: Uint8Array | null;
  tex: WebGLTexture | null;
  /// Waveform: the y of the line the bars stand on, 0..1 from the top.
  floor: number;
}

/// Per-render light and state.
export interface Light {
  /// Card colour as linear-ish rgb 0..1.
  tint: [number, number, number];
  /// Where the light comes from, -1..1 each way; follows the pointer.
  tilt: [number, number];
  time: number;
  /// Onset envelope, 0..1.
  kick: number;
  /// A highlight sweeping across, 0..1 along the plate; outside that, none.
  sweep: number;
}

export interface WaveState {
  progress: number;
  buffered: number;
  /// The top of the bar being played, 0..1 from the top; for the glint.
  top: number;
}

const VERTEX = `#version 300 es
out vec2 vUv;
void main() {
  // One triangle over the viewport.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uShape;
uniform sampler2D uArt;
uniform vec2 uSize;
uniform float uBevel;
uniform int uKind;
uniform vec3 uTint;
uniform vec2 uTilt;
uniform float uTime;
uniform float uKick;
uniform float uSweep;
uniform float uFloor;
uniform vec3 uWave; // progress, buffered, top of the playing bar
uniform float uDepth; // px the shapes stand out of the page
in vec2 vUv;
out vec4 outColor;

const float PI = 3.14159265;

vec4 shape(vec2 uv) { return textureLod(uShape, uv, 0.0); }

// The studio the metal reflects; r is the reflected ray, y up, z to the viewer.
vec3 studio(vec3 r) {
  float y = r.y - uTilt.y * 0.22;
  float x = r.x + uTilt.x * 0.35;
  vec3 sky = mix(vec3(0.56, 0.58, 0.64), vec3(1.0), smoothstep(0.04, 0.75, y));
  // Softboxes: a wide bar high up, a narrow strip that drifts.
  sky += 1.3 * smoothstep(0.07, 0.0, abs(y - 0.5));
  sky += 0.9 * smoothstep(0.06, 0.0, abs(x - 0.45 + 0.2 * sin(uTime * 0.21)));
  sky += 0.6 * smoothstep(0.05, 0.0, abs(x + 0.55 - 0.15 * sin(uTime * 0.17 + 1.0)));
  // The floor: the card's colour, with its art in it.
  vec3 art = textureLod(uArt, vec2(fract(x * 0.4 + 0.5), clamp(-y * 1.4, 0.0, 1.0)), 2.5).rgb;
  vec3 tint = mix(vec3(0.62, 0.62, 0.68), uTint, 0.7);
  vec3 floorC = mix(tint, art * 1.4, 0.3) * mix(1.3, 0.2, smoothstep(0.0, 0.7, -y));
  vec3 c = y > 0.0 ? sky : floorC;
  // The dark horizon: sharp above, soft below.
  float lit = y > 0.0 ? smoothstep(0.0, 0.045, y) : smoothstep(0.0, 0.2, -y);
  return c * mix(0.04, 1.0, lit);
}

vec3 shade(vec2 uv, vec2 px, out float cover) {
  vec4 s = shape(uv);
  cover = s.g;
  float hx = shape(uv + vec2(px.x, 0.0)).r - shape(uv - vec2(px.x, 0.0)).r;
  float hy = shape(uv + vec2(0.0, px.y)).r - shape(uv - vec2(0.0, px.y)).r;
  // Slope per px times the bevel width: a bevel at about 55 degrees.
  float k = 0.5 * uBevel * 1.4;
  vec3 n = normalize(vec3(-hx * k, hy * k, 1.0));
  // Each line of text (each bar) is a plate curved top to bottom, so its face
  // runs from sky through the horizon to the floor.
  float along = s.b;
  vec3 face = normalize(vec3(n.xy + vec2(0.0, 0.38 - along * 0.8), n.z));
  float steep = 1.0 - face.z;
  // Split the colours at the steep edges, like a cheap lens does.
  vec3 view = vec3(0.0, 0.0, -1.0);
  float split = 0.08 * steep + 0.01;
  vec3 c;
  c.r = studio(reflect(view, normalize(vec3(face.xy * (1.0 + split), face.z)))).r;
  c.g = studio(reflect(view, face)).g;
  c.b = studio(reflect(view, normalize(vec3(face.xy * (1.0 - split), face.z)))).b;
  // A key light that follows the pointer; kicks make it flare.
  vec3 l = normalize(vec3(uTilt.x * 0.9 - 0.25, -uTilt.y * 0.7 + 0.55, 1.0));
  float spec = pow(max(dot(reflect(-l, face), vec3(0.0, 0.0, 1.0)), 0.0), 48.0);
  c += spec * (0.9 + 2.2 * uKick) * mix(vec3(1.0), uTint, 0.25);
  // The sweep: a bright band slanting across.
  float band = (uv.x - uSweep) * 7.0 + (uv.y - 0.5) * 1.5;
  c += 1.6 * exp(-band * band) * step(-0.5, uSweep) * step(uSweep, 1.5);
  // The crease where a bevel meets the ground darkens.
  c *= mix(0.45, 1.0, smoothstep(0.0, 0.25, s.r));
  return c;
}

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 px = 1.0 / uSize;
  float fade = 1.0;
  vec2 at = uv;
  if (uKind == 1 && uv.y > uFloor) {
    // Under the line the bars stand on: their reflection, fading out.
    at.y = 2.0 * uFloor - uv.y;
    fade = 0.28 * (1.0 - smoothstep(0.0, 1.0 - uFloor, uv.y - uFloor));
  }
  float cover;
  vec3 c = shade(at, px, cover);
  float a = cover * fade;
  // The side wall: the shape has depth, seen a little from above and to the side
  // of where the light is, so it shifts as the pointer moves.
  vec2 dir = normalize(vec2(0.3 - uTilt.x * 0.5, 1.0 - uTilt.y * 0.25));
  vec3 wall = vec3(0.0);
  float wallA = 0.0;
  for (int i = 1; i <= 8; i++) {
    float k = float(i) / 8.0;
    float g = shape(at - dir * k * uDepth * px).g;
    if (g > 0.5) {
      // Bright lip under the face, then darker metal going back.
      vec3 metal = mix(vec3(0.85, 0.85, 0.9), uTint, 0.45);
      float glance = 0.5 + 0.5 * sin(at.x * 40.0 + uTilt.x * 3.0 + uTime * 0.3);
      wall = mix(metal * (0.7 + 0.5 * glance), uTint * 0.12, smoothstep(0.0, 1.0, k));
      wallA = g * fade;
      break;
    }
  }
  c = mix(wall, c, cover);
  a = max(a, wallA);
  if (uKind == 1) {
    // Played bars are chrome; the rest is dark gunmetal, lighter where loaded.
    float played = step(uv.x, uWave.x);
    float loaded = step(uv.x, uWave.y);
    float grey = dot(c, vec3(0.3, 0.59, 0.11));
    vec3 gun = vec3(grey) * mix(0.5, 0.68, loaded) * vec3(0.92, 0.93, 1.0);
    c = mix(gun, c, played);
    a *= mix(mix(0.7, 0.85, loaded), 1.0, played);
    // The floor itself: a hairline of metal, brightest at the playhead.
    float line = smoothstep(1.5 * px.y, 0.0, abs(uv.y - uFloor - px.y));
    float near = exp(-abs(uv.x - uWave.x) * 4.0);
    c = mix(c, vec3(1.0), line * (0.25 + 0.75 * near) * (1.0 - a));
    a = max(a, line * (0.2 + 0.7 * near));
  }
  // Under the metal: a soft shadow below it and a glow of the card's colour.
  float under = textureLod(uShape, at + vec2(0.0, -2.5 * px.y), 2.0).g * fade;
  float halo = textureLod(uShape, at, 3.5).g * fade;
  vec3 col = c * a;
  float alpha = a;
  float glow = halo * (0.35 + 0.5 * uKick) * (uKind == 1 ? 0.3 : 1.0);
  col += uTint * glow * (1.0 - alpha);
  alpha += glow * 0.6 * (1.0 - alpha);
  alpha += under * 0.55 * (1.0 - alpha);
  if (uKind == 1 && uWave.x > 0.0 && uWave.x < 1.0) {
    // A four-point glint on the top of the bar being played.
    vec2 d = (uv - vec2(uWave.x, uWave.z)) * uSize;
    float r = 7.0 + 3.0 * sin(uTime * 2.6) + 6.0 * uKick;
    float rays = exp(-abs(d.x) * 0.9) * exp(-d.y * d.y / (r * r)) + exp(-abs(d.y) * 0.9) * exp(-d.x * d.x / (r * r));
    float core = exp(-dot(d, d) / 6.0);
    float g = clamp(rays + core, 0.0, 1.0);
    col += mix(uTint, vec3(1.0), g) * g;
    alpha = max(alpha, g);
  }
  outColor = vec4(min(col, vec3(alpha)), alpha);
}`;

const UNIFORMS = ["uShape", "uArt", "uSize", "uBevel", "uKind", "uTint", "uTilt", "uTime", "uKick", "uSweep", "uFloor", "uWave", "uDepth"] as const;

export class Chrome {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private u: Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null> = {} as never;
  private art: WebGLTexture | null = null;
  private plates = new Set<Plate>();

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.canvas = gl.canvas as HTMLCanvasElement;
    this.canvas.addEventListener("webglcontextlost", (e) => e.preventDefault());
    this.canvas.addEventListener("webglcontextrestored", () => {
      this.init();
      for (const p of this.plates) {
        p.tex = null;
        if (p.pixels) this.upload(p);
      }
    });
    this.init();
  }

  static create(): Chrome | null {
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, alpha: true });
      return gl ? new Chrome(gl) : null;
    } catch {
      return null;
    }
  }

  get lost(): boolean {
    return this.gl.isContextLost();
  }

  private init(): void {
    const gl = this.gl;
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "compile failed");
      gl.attachShader(prog, s);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "link failed");
    gl.useProgram(prog);
    for (const name of UNIFORMS) this.u[name] = gl.getUniformLocation(prog, name);
    gl.uniform1i(this.u.uShape, 0);
    gl.uniform1i(this.u.uArt, 1);
    gl.bindVertexArray(gl.createVertexArray());
    gl.clearColor(0, 0, 0, 0);
    this.art = null;
    this.setArt(null, "#ff4d6d");
  }

  /// What the floor of the studio shows: the card's art, or its colour.
  setArt(img: HTMLImageElement | null, color: string): void {
    const gl = this.gl;
    const c = document.createElement("canvas");
    c.width = c.height = ART_SIZE;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, ART_SIZE, ART_SIZE);
    if (img) ctx.drawImage(img, 0, 0, ART_SIZE, ART_SIZE);
    this.art ??= gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.art);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
  }

  plate(canvas: HTMLCanvasElement, kind: Kind): Plate {
    const p: Plate = { canvas, kind, w: 0, h: 0, bevel: 1, pixels: null, tex: null, floor: 1 };
    this.plates.add(p);
    return p;
  }

  drop(p: Plate): void {
    if (p.tex) this.gl.deleteTexture(p.tex);
    p.tex = null;
    p.pixels = null;
    this.plates.delete(p);
  }

  /// Give `p` its shape: `draw` paints the mask in CSS px onto a canvas of
  /// `w` x `h` CSS px and returns, per painted region, the line it belongs to
  /// (for the face's sky-to-floor run). `bevel` is in CSS px.
  shape(p: Plate, w: number, h: number, bevel: number, draw: (ctx: CanvasRenderingContext2D) => Line[]): void {
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    const mask = document.createElement("canvas");
    mask.width = W;
    mask.height = H;
    const ctx = mask.getContext("2d", { willReadFrequently: true })!;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#fff";
    const lines = draw(ctx);
    const alpha = ctx.getImageData(0, 0, W, H).data;
    p.w = W;
    p.h = H;
    p.bevel = bevel * dpr;
    p.canvas.width = W;
    p.canvas.height = H;
    p.pixels = heights(alpha, W, H, p.bevel, lines.map((l) => ({ top: l.top * dpr, height: l.height * dpr, left: l.left * dpr, width: l.width * dpr })));
    this.upload(p);
  }

  private upload(p: Plate): void {
    const gl = this.gl;
    p.tex ??= gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, p.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, p.w, p.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, p.pixels);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /// Light `p` and copy the result onto its canvas.
  render(p: Plate, light: Light, wave?: WaveState): void {
    const gl = this.gl;
    if (!p.tex || gl.isContextLost()) return;
    const c = this.canvas;
    if (c.width < p.w || c.height < p.h) {
      c.width = Math.max(c.width, p.w);
      c.height = Math.max(c.height, p.h);
    }
    gl.viewport(0, 0, p.w, p.h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, p.tex);
    gl.uniform2f(this.u.uSize, p.w, p.h);
    gl.uniform1f(this.u.uBevel, p.bevel);
    gl.uniform1f(this.u.uDepth, p.bevel * (p.kind === "wave" ? 1.2 : 1.6));
    gl.uniform1i(this.u.uKind, p.kind === "wave" ? 1 : 0);
    gl.uniform3fv(this.u.uTint, light.tint);
    gl.uniform2fv(this.u.uTilt, light.tilt);
    gl.uniform1f(this.u.uTime, light.time);
    gl.uniform1f(this.u.uKick, light.kick);
    gl.uniform1f(this.u.uSweep, light.sweep);
    gl.uniform1f(this.u.uFloor, p.floor);
    gl.uniform3f(this.u.uWave, wave?.progress ?? 0, wave?.buffered ?? 0, wave?.top ?? 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // The viewport sits at the bottom left of the GL canvas.
    const ctx = p.canvas.getContext("2d")!;
    ctx.clearRect(0, 0, p.w, p.h);
    ctx.drawImage(c, 0, c.height - p.h, p.w, p.h, 0, 0, p.w, p.h);
  }
}

/// A run of the mask that forms one line: its face runs sky to floor over `height`.
export interface Line {
  left: number;
  top: number;
  width: number;
  height: number;
}

const INF = 1e20;

/// The mask's alpha to RGBA: R the bevelled height, G the coverage, B how far
/// down its line a pixel is.
function heights(alpha: Uint8ClampedArray, w: number, h: number, bevel: number, lines: Line[]): Uint8Array {
  const n = w * h;
  // Squared distance from inside the shape to its edge, with sub-pixel edges.
  const grid = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = alpha[i * 4 + 3] / 255;
    grid[i] = a === 1 ? INF : a === 0 ? 0 : Math.max(0, a - 0.5) ** 2;
  }
  edt(grid, w, h);
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const t = Math.min(1, Math.sqrt(grid[i]) / bevel);
    // Mostly a flat chamfer, rounded a little at the top.
    const height = 0.6 * t + 0.4 * (1 - (1 - t) * (1 - t));
    out[i * 4] = Math.round(height * 255);
    out[i * 4 + 1] = alpha[i * 4 + 3];
    out[i * 4 + 3] = 255;
  }
  for (const l of lines) {
    const x0 = Math.max(0, Math.floor(l.left)), x1 = Math.min(w, Math.ceil(l.left + l.width));
    const y0 = Math.max(0, Math.floor(l.top)), y1 = Math.min(h, Math.ceil(l.top + l.height));
    for (let y = y0; y < y1; y++) {
      const v = Math.round(((y - l.top) / Math.max(1, l.height)) * 255);
      for (let x = x0; x < x1; x++) out[(y * w + x) * 4 + 2] = v;
    }
  }
  return out;
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

/// Paint `el`'s text, character by character where the page laid it out, into
/// a mask whose origin is `pad` CSS px up and left of `el`. Returns its lines.
export function textMask(el: HTMLElement, pad: number, ctx: CanvasRenderingContext2D): Line[] {
  const box = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  ctx.textBaseline = "alphabetic";
  const m = ctx.measureText("Hg");
  const range = document.createRange();
  const lines = new Map<number, Line>();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent || "";
    for (let i = 0; i < text.length; i++) {
      // Surrogate pairs stay together.
      const len = text.codePointAt(i)! > 0xffff ? 2 : 1;
      const ch = text.slice(i, i + len);
      range.setStart(node, i);
      range.setEnd(node, i + len);
      i += len - 1;
      if (!ch.trim()) continue;
      const r = range.getClientRects()[0];
      if (!r) continue;
      const left = r.left - box.left + pad, top = r.top - box.top + pad;
      const ascent = m.fontBoundingBoxAscent ?? r.height * 0.8;
      ctx.fillText(ch, left, top + ascent);
      const key = Math.round(top);
      const line = lines.get(key);
      if (line) {
        line.width = left + r.width - line.left;
      } else {
        lines.set(key, { left, top, width: r.width, height: r.height });
      }
    }
  }
  return [...lines.values()];
}

/// "#rrggbb", "rgb(...)" or "hsl(...)" to rgb 0..1, through the page's own parser.
export function rgb(color: string): [number, number, number] {
  const c = document.createElement("canvas").getContext("2d")!;
  c.fillStyle = color;
  c.fillRect(0, 0, 1, 1);
  const d = c.getImageData(0, 0, 1, 1).data;
  return [d[0] / 255, d[1] / 255, d[2] / 255];
}
