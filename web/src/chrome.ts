// Chrome: the playing card's title, its waveform and the logo as heavy, polished
// metal, after chrome lettering on a dark flyer. Drawn by WebGL2, not by CSS.
//
// A shape (glyphs or waveform bars) is drawn as a mask on a 2D canvas and baked
// once, on the CPU and off the main thread (chrome-bake.ts), into a texture: a distance transform gives every edge a bevel
// of a fixed width, the bevel's slope gives the surface normal, a side wall is
// pushed out below the shape and a soft shadow falls under it. Lighting it is
// then one texture fetch and a few lookups into a small painted studio: mostly
// black, a sharp horizon through every letter's face, one white strip above it
// and the card's colour as the floor. Colours split at the steep edges, more on
// kicks, and a highlight follows the pointer.
//
// One WebGL2 context draws straight into a canvas laid over the playing card, so
// nothing is copied per frame. Only the logo, which never moves, is read back
// once into its own canvas.

import { bake, type BakeJob, type Line } from "./chrome-bake";

const MAX_DPR = 2;
const ENV_W = 64;
const ENV_H = 256; // tall, so the horizon stays sharp
const ART_SIZE = 8; // the art is only ever seen blurred, in the floor

/// What a plate shows.
export type Kind = "text" | "wave";

/// A shape on the GPU, drawn at a place on the layer.
export interface Plate {
  kind: Kind;
  /// Place on the layer and size, in device px.
  x: number;
  y: number;
  w: number;
  h: number;
  /// The baked shape as uploaded (RG normal, B coverage, A shadow).
  pixels: Uint8Array | null;
  /// Counts shapes asked for, so a late bake of an old one is dropped.
  job: number;
  tex: WebGLTexture | null;
  /// Waveform: the y of the line the bars stand on, 0..1 from the top.
  floor: number;
}

/// Per-render light and state.
export interface Light {
  /// Card colour as rgb 0..1.
  tint: [number, number, number];
  /// Where the light comes from, -1..1 each way; follows the pointer.
  tilt: [number, number];
  /// Onset envelope, 0..1.
  kick: number;
  /// A highlight sweeping across, 0..1 along the plate; outside that, none.
  sweep: number;
}

export interface WaveState {
  progress: number;
  buffered: number;
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
uniform sampler2D uEnv;
uniform vec2 uSize;
uniform int uKind;
uniform vec3 uTint;
uniform vec2 uTilt;
uniform float uKick;
uniform float uSweep;
uniform float uFloor;
uniform vec2 uWave; // progress, buffered
in vec2 vUv;
out vec4 outColor;

// The studio seen along the reflection of a ray from the viewer off normal n.
vec3 env(vec3 n) {
  vec3 r = reflect(vec3(0.0, 0.0, -1.0), n);
  vec2 at = vec2(0.5 + 0.5 * clamp(r.x * 0.8 + uTilt.x * 0.3, -1.0, 1.0), 0.5 - 0.5 * clamp(r.y + uTilt.y * 0.2, -1.0, 1.0));
  return texture(uEnv, at).rgb;
}

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 px = 1.0 / uSize;
  vec2 at = uv;
  float fade = 1.0;
  bool wave = uKind == 1;
  if (wave && uv.y > uFloor) {
    // Under the line the bars stand on: their reflection, fading out.
    at.y = 2.0 * uFloor - uv.y;
    fade = 0.18 * (1.0 - smoothstep(0.0, 1.0 - uFloor, uv.y - uFloor));
  }
  vec4 s = texture(uShape, at);
  float m = s.b * fade;
  float shadow = s.a * fade;
  // Waveform: a thin, hot playhead from the floor up, and a hairline floor.
  float head = 0.0;
  float floorLine = 0.0;
  if (wave) {
    if (uWave.x > 0.0 && uWave.x < 1.0) head = smoothstep(1.5 * px.x, 0.0, abs(uv.x - uWave.x)) * step(uv.y, uFloor) * smoothstep(0.0, 0.6, uv.y);
    floorLine = smoothstep(1.2 * px.y, 0.0, abs(uv.y - uFloor - px.y)) * 0.35;
  }
  if (m < 0.002 && shadow < 0.002 && head + floorLine < 0.002) discard;

  vec3 n = vec3(s.rg * 2.0 - 1.0, 0.0);
  n.z = sqrt(max(0.0, 1.0 - dot(n.xy, n.xy)));
  // Split the colours at the steep edges, like a cheap lens; a kick pushes it.
  float split = 0.015 + (1.0 - n.z) * (0.05 + 0.3 * uKick);
  vec3 c;
  c.r = env(normalize(vec3(n.xy * (1.0 + split), n.z))).r;
  c.g = env(n).g;
  c.b = env(normalize(vec3(n.xy * (1.0 - split), n.z))).b;
  // A key light that follows the pointer; kicks make it flare.
  vec3 l = normalize(vec3(uTilt.x * 0.9 - 0.25, -uTilt.y * 0.7 + 0.55, 1.0));
  float spec = pow(max(dot(reflect(-l, n), vec3(0.0, 0.0, 1.0)), 0.0), 64.0);
  c += spec * (0.7 + 1.8 * uKick) * mix(vec3(1.0), uTint, 0.3);
  // The sweep: a narrow bright band slanting across.
  float band = (uv.x - uSweep) * 12.0 + (uv.y - 0.5) * 2.0;
  c += 1.4 * exp(-band * band) * step(-0.5, uSweep) * step(uSweep, 1.5);
  if (wave) {
    // Played bars are chrome; the rest is dark gunmetal, lighter where loaded.
    float played = step(uv.x, uWave.x);
    float loaded = step(uv.x, uWave.y);
    float grey = dot(c, vec3(0.3, 0.59, 0.11));
    vec3 gun = vec3(grey) * mix(0.45, 0.65, loaded) * vec3(0.92, 0.93, 1.0);
    c = mix(gun, c, played);
    m *= mix(mix(0.75, 0.9, loaded), 1.0, played);
  }
  vec3 col = c * m;
  float a = m;
  vec3 hot = mix(uTint, vec3(1.0), 0.25) * 1.4;
  col = mix(col, hot, head);
  a = max(a, head);
  col += vec3(0.8) * floorLine * (1.0 - a);
  a += floorLine * (1.0 - a);
  a += shadow * 0.65 * (1.0 - a);
  outColor = vec4(min(col, vec3(a)), a);
}`;

const UNIFORMS = ["uShape", "uEnv", "uSize", "uKind", "uTint", "uTilt", "uKick", "uSweep", "uFloor", "uWave"] as const;

export class Chrome {
  /// The layer laid over the playing card.
  readonly canvas: HTMLCanvasElement;
  /// Called once the GPU gave the context back; everything should be drawn again.
  onRestored: (() => void) | null = null;
  readonly dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
  private gl: WebGL2RenderingContext;
  private u: Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null> = {} as never;
  /// The studio as the playing card colours it, and as the logo sees it.
  private env: WebGLTexture | null = null;
  private baseEnv: WebGLTexture | null = null;
  private art: { img: HTMLImageElement | null; color: string } = { img: null, color: "#ff4d6d" };
  private plates = new Set<Plate>();
  private baker = new Baker();

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
      this.onRestored?.();
    });
    this.init();
  }

  static create(): Chrome | null {
    try {
      const canvas = document.createElement("canvas");
      canvas.className = "chrome-layer";
      canvas.setAttribute("aria-hidden", "true");
      const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, alpha: true, depth: false, stencil: false });
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
    gl.uniform1i(this.u.uEnv, 1);
    gl.bindVertexArray(gl.createVertexArray());
    gl.clearColor(0, 0, 0, 0);
    this.baseEnv = this.paintEnv(gl.createTexture(), null, "#ff4d6d");
    this.env = this.paintEnv(gl.createTexture(), this.art.img, this.art.color);
  }

  /// What the floor of the studio shows: the card's art, or its colour.
  setArt(img: HTMLImageElement | null, color: string): void {
    this.art = { img, color };
    this.env = this.paintEnv(this.env, img, color);
  }

  /// Paint the studio into `tex`. Rows run from straight up to straight down.
  private paintEnv(tex: WebGLTexture | null, img: HTMLImageElement | null, color: string): WebGLTexture | null {
    const gl = this.gl;
    const c = document.createElement("canvas");
    c.width = ENV_W;
    c.height = ENV_H;
    const ctx = c.getContext("2d")!;
    const half = ENV_H / 2;
    // The sky: black overhead, rising to white at the horizon.
    const sky = ctx.createLinearGradient(0, 0, 0, half);
    sky.addColorStop(0, "#000000");
    sky.addColorStop(0.3, "#16181d");
    sky.addColorStop(0.62, "#626876");
    sky.addColorStop(0.9, "#eef1f6");
    sky.addColorStop(1, "#ffffff");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, ENV_W, half);
    // One softbox strip high up, and a faint narrow one to the side.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, half * 0.38, ENV_W, 3);
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fillRect(ENV_W * 0.74, 0, 2, half * 0.9);
    // The floor: black at the horizon, the card's colour and art further down.
    ctx.fillStyle = color;
    ctx.fillRect(0, half, ENV_W, half);
    if (img) {
      // Drawn tiny and stretched up: a blur for free.
      const small = document.createElement("canvas");
      small.width = small.height = ART_SIZE;
      small.getContext("2d")!.drawImage(img, 0, 0, ART_SIZE, ART_SIZE);
      ctx.globalAlpha = 0.35;
      ctx.drawImage(small, 0, half, ENV_W, half);
      ctx.globalAlpha = 1;
    }
    const dark = ctx.createLinearGradient(0, half, 0, ENV_H);
    dark.addColorStop(0, "rgba(0,0,0,1)");
    dark.addColorStop(0.1, "rgba(0,0,0,0.7)");
    dark.addColorStop(1, "rgba(0,0,0,0.1)");
    ctx.fillStyle = dark;
    ctx.fillRect(0, half, ENV_W, half);
    tex ??= gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
    return tex;
  }

  /// Size the layer to `w` x `h` CSS px. Clears it.
  layout(w: number, h: number): void {
    const W = Math.max(1, Math.round(w * this.dpr)), H = Math.max(1, Math.round(h * this.dpr));
    if (this.canvas.width !== W) this.canvas.width = W;
    if (this.canvas.height !== H) this.canvas.height = H;
  }

  plate(kind: Kind): Plate {
    const p: Plate = { kind, x: 0, y: 0, w: 0, h: 0, pixels: null, job: 0, tex: null, floor: 1 };
    this.plates.add(p);
    return p;
  }

  drop(p: Plate): void {
    if (p.tex) this.gl.deleteTexture(p.tex);
    p.tex = null;
    p.pixels = null;
    p.job++;
    this.plates.delete(p);
  }

  /// Put `p` at `x`, `y` CSS px from the layer's top left.
  place(p: Plate, x: number, y: number): void {
    p.x = Math.round(x * this.dpr);
    p.y = Math.round(y * this.dpr);
  }

  /// Give `p` its shape: `draw` paints the mask in CSS px onto a canvas of
  /// `w` x `h` CSS px and returns, per painted region, the line it belongs to
  /// (for the face's sky-to-floor run). `bevel` and `depth` (of the side wall
  /// and the shadow; 0 for none) are in CSS px. Resolves once the shape is on
  /// the GPU, or false if it was dropped or asked for again in the meantime.
  async shape(p: Plate, w: number, h: number, bevel: number, depth: number, draw: (ctx: CanvasRenderingContext2D) => Line[]): Promise<boolean> {
    const dpr = this.dpr;
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    const mask = document.createElement("canvas");
    mask.width = W;
    mask.height = H;
    const ctx = mask.getContext("2d", { willReadFrequently: true })!;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#fff";
    const lines = draw(ctx);
    const alpha = ctx.getImageData(0, 0, W, H).data;
    const scaled = lines.map((l) => ({ top: l.top * dpr, height: l.height * dpr, left: l.left * dpr, width: l.width * dpr }));
    const job = ++p.job;
    const pixels = await this.baker.bake({ alpha, w: W, h: H, bevel: bevel * dpr, depth: Math.round(depth * dpr), lines: scaled });
    if (job !== p.job) return false;
    p.w = W;
    p.h = H;
    p.pixels = pixels;
    this.upload(p);
    return true;
  }

  private upload(p: Plate): void {
    const gl = this.gl;
    p.tex ??= gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, p.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, p.w, p.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, p.pixels);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /// Empty the layer, before its plates are drawn again.
  clear(): void {
    if (this.lost) return;
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  /// Light `p` at its place on the layer.
  render(p: Plate, light: Light, wave?: WaveState): void {
    this.draw(p, p.x, this.canvas.height - p.y - p.h, light, this.env, wave);
  }

  /// Light `p` once, off screen, and keep the picture in `target`: for a plate
  /// that never moves.
  still(p: Plate, target: HTMLCanvasElement, light: Light): void {
    const gl = this.gl;
    if (!p.tex || gl.isContextLost()) return;
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, p.w, p.h);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.draw(p, 0, 0, light, this.baseEnv);
    const px = new Uint8Array(p.w * p.h * 4);
    gl.readPixels(0, 0, p.w, p.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);
    // GL's rows run bottom up and its colour is premultiplied; ImageData's are not.
    const img = new ImageData(p.w, p.h);
    const row = p.w * 4;
    for (let y = 0; y < p.h; y++) {
      for (let i = 0, from = (p.h - 1 - y) * row, to = y * row; i < row; i += 4) {
        const a = px[from + i + 3];
        const k = a ? 255 / a : 0;
        img.data[to + i] = px[from + i] * k;
        img.data[to + i + 1] = px[from + i + 1] * k;
        img.data[to + i + 2] = px[from + i + 2] * k;
        img.data[to + i + 3] = a;
      }
    }
    target.width = p.w;
    target.height = p.h;
    target.getContext("2d")!.putImageData(img, 0, 0);
  }

  private draw(p: Plate, x: number, y: number, light: Light, env: WebGLTexture | null, wave?: WaveState): boolean {
    const gl = this.gl;
    if (!p.tex || gl.isContextLost()) return false;
    gl.viewport(x, y, p.w, p.h);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, env);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, p.tex);
    gl.uniform2f(this.u.uSize, p.w, p.h);
    gl.uniform1i(this.u.uKind, p.kind === "wave" ? 1 : 0);
    gl.uniform3fv(this.u.uTint, light.tint);
    gl.uniform2fv(this.u.uTilt, light.tilt);
    gl.uniform1f(this.u.uKick, light.kick);
    gl.uniform1f(this.u.uSweep, light.sweep);
    gl.uniform1f(this.u.uFloor, p.floor);
    gl.uniform2f(this.u.uWave, wave?.progress ?? 0, wave?.buffered ?? 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }
}

/// Bakes shapes in a worker; inline where the worker cannot start.
class Baker {
  private worker: Worker | null = null;
  private next = 1;
  private waiting = new Map<number, { job: BakeJob; done: (pixels: Uint8Array) => void }>();

  constructor() {
    try {
      this.worker = new Worker(new URL("./chrome-worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e: MessageEvent<{ id: number; pixels: Uint8Array }>) => {
        this.waiting.get(e.data.id)?.done(e.data.pixels);
        this.waiting.delete(e.data.id);
      };
      this.worker.onerror = () => this.inline();
    } catch {
      this.worker = null;
    }
  }

  bake(job: BakeJob): Promise<Uint8Array> {
    if (!this.worker) return Promise.resolve(bake(job));
    const id = this.next++;
    return new Promise((done) => {
      this.waiting.set(id, { job, done });
      this.worker!.postMessage({ ...job, id });
    });
  }

  /// The worker failed: bake what it was given here, and everything after.
  private inline(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const { job, done } of this.waiting.values()) done(bake(job));
    this.waiting.clear();
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

let probe: CanvasRenderingContext2D | null = null;

/// "#rrggbb", "rgb(...)" or "hsl(...)" to rgb 0..1, through the page's own parser.
export function rgb(color: string): [number, number, number] {
  probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const d = probe.getImageData(0, 0, 1, 1).data;
  return [d[0] / 255, d[1] / 255, d[2] / 255];
}
