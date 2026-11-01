// The liquid artwork drop: one WebGL2 canvas, moved into the playing card's art slot.
// Browsers allow only a handful of WebGL contexts, so there is one for the whole
// page; cards around it show their artwork as a plain image.

import type { Features } from "../features";
import { icosphere } from "./mesh";
import { FRAGMENT, VERTEX } from "./shaders";
import { Spin } from "./spin";
import type { Look } from "./style";

const FOV = (30 * Math.PI) / 180;
/// The canvas is this much larger than the art slot, so the liquid can spill out.
export const SPILL = 2;
const DIST = SPILL / Math.tan(FOV / 2);
const MORPH_IN = 1.4; // s from flat artwork to liquid
// The jump: a spring that each prominent kick or bass hit kicks upwards. Hits are
// weighed by prominence squared, so only the strongest really make it jump.
const JUMP = 1.9; // upward speed of a full-strength hit, in radii per second
const JUMP_DAMPING = 7; // 1/s; low enough that it jiggles a few times as it lands
const MAX_LIFT = 0.16; // radii
const STRETCH = 0.08; // stretch per unit of speed: long while flying, squashed on landing
const PUMP = 0.7; // size kick of a snare hit
const PUMP_STIFF = 160;
const PUMP_DAMPING = 12;
const THROB = 0.09; // size swing with the bass line's envelope
const WHIRL = 15; // rad/s of hand spin at which it bulges and sloshes the most
const SNARE_ATTACK = 0.03; // s; spikes grow in rather than pop
const SNARE_RELEASE = 0.15; // s
// The play/pause icon: pausing shows the bars, which turn into the play triangle;
// playing turns the triangle back into the bars as they fade.
const ICON_MELT = 0.35; // s the bars show before turning into the triangle
const ICON_FADE = 0.3; // s the bars show after playing starts
const ICON_MORPH = 0.22; // s from one shape to the other
const ICON_IN = 0.05; // s; fades in fast …
const ICON_OUT = 0.12; // … and out a little slower
const CALM = 0.25; // s for the surface to settle down under the icon, and back
const HOVER = 0.45; // how much the bars show while a mouse rests on the playing drop
const TEXTURE_SIZE = 512;
// Quality follows how fast frames come against what this display normally does, so
// a 30 Hz screen is not mistaken for a slow GPU.
const SLOW_RATIO = 1.4; // a frame this much slower than usual is slow …
const SLOW_FOR = 2; // … and this many seconds of them step the quality down
const FAST_FOR = 10; // s of frames on time before it tries one step up again
/// Quality steps: icosphere subdivisions and resolution scale.
const QUALITY: [number, number][] = [[5, 1], [4, 1], [4, 0.6], [3, 0.5]];

const UNIFORMS = [
  "uProj", "uDist", "uTime", "uMorph", "uLevel", "uWobble", "uKick", "uKickAge", "uSnare", "uDrop", "uBass", "uGrowl",
  "uGain", "uSpike", "uStep", "uTwist", "uRipple", "uShock", "uScale", "uLift", "uJelly", "uPointer", "uRot", "uFront",
  "uIcon", "uIconA", "uCalm", "uBusy", "uProgress", "uClock",
  "uArt", "uAccent", "uHue", "uIri", "uMetal", "uHeat",
] as const;

const ease = (dt: number, tau: number) => 1 - Math.exp(-dt / tau);

/// What the page knows about playback, besides the music itself.
export interface DropState {
  playing: boolean;
  /// 0..1 of the track played.
  progress: number;
  /// Waiting for audio.
  buffering: boolean;
  /// A mouse rests on the drop.
  hover: boolean;
}

export class LiquidBlob {
  readonly canvas = document.createElement("canvas");
  /// Called if the GPU drops the context; the page shows plain art until `onRestored`.
  onLost: (() => void) | null = null;
  onRestored: (() => void) | null = null;
  /// Turning it by hand.
  readonly spin = new Spin();
  private gl: WebGL2RenderingContext;
  private u = {} as Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;
  private vao!: WebGLVertexArrayObject;
  private buffers: WebGLBuffer[] = [];
  private count = 0;
  private tex!: WebGLTexture;
  private quality: number;
  private look: Look | null = null;
  private accent: [number, number, number] = [1, 0.3, 0.43];
  private ready = false;
  private gen = 0;
  private morph = 0;
  private time = 0;
  private pointer = [0, 0, 1, 0];
  private pointerGoal = [0, 0, 1, 0];
  private slow = 0;
  private fast = 0;
  /// Usual frame time of this display, s.
  private usual = 1 / 60;
  /// Seconds on time needed before stepping up; doubles each time a step up fails.
  private fastFor = FAST_FOR;
  private steppedUp = false;
  /// Springs, position and speed: the jump (upwards) and the pump (size).
  private jump = [0, 0];
  private pump = [0, 0];
  private snare = 0;
  /// The icon: its shape (0 pause, 1 play), how much it shows, and since when the
  /// playing state is what it is. `iconFor` is null until the first frame of a track.
  private iconShape = 1;
  private iconAlpha = 0;
  private iconFor: boolean | null = null;
  private iconAge = 0;
  /// Take the next playing state as it is, without showing a change.
  private settle = false;
  private busy = 0;
  private calm = 0;

  /// Null where WebGL2 is not available.
  static create(touch: boolean): LiquidBlob | null {
    try {
      return new LiquidBlob(touch);
    } catch (err) {
      console.warn("liquid visuals off:", (err as Error).message);
      return null;
    }
  }

  private constructor(private touch: boolean) {
    const gl = this.canvas.getContext("webgl2", { antialias: true, premultipliedAlpha: true });
    if (!gl) throw new Error("no WebGL2");
    this.gl = gl;
    this.canvas.className = "liquid-canvas";
    this.quality = touch ? 1 : 0;
    this.canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault(); // or it never comes back
      this.ready = false;
      this.onLost?.();
    });
    this.canvas.addEventListener("webglcontextrestored", () => {
      try {
        this.init();
      } catch (err) {
        console.warn("liquid visuals not restored:", (err as Error).message);
        return;
      }
      this.onRestored?.();
    });
    this.init();
  }

  get lost(): boolean {
    return this.gl.isContextLost();
  }

  /// Everything on the GPU; again after a lost context comes back.
  private init(): void {
    const gl = this.gl;
    const prog = gl.createProgram();
    gl.attachShader(prog, this.shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(prog, this.shader(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.bindAttribLocation(prog, 0, "position");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "link failed");
    gl.useProgram(prog);
    for (const name of UNIFORMS) this.u[name] = gl.getUniformLocation(prog, name);
    this.vao = gl.createVertexArray();
    this.buffers = [];
    this.buildMesh();
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(this.u.uArt, 0);
    gl.uniformMatrix4fv(this.u.uProj, false, perspective(FOV, 1, 0.1, 20));
    gl.uniform1f(this.u.uDist, DIST);
    gl.enable(gl.DEPTH_TEST);
    // The edge fades into the page; the canvas is premultiplied.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
  }

  private shader(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "compile failed");
    return s;
  }

  private buildMesh(): void {
    const gl = this.gl;
    const mesh = icosphere(QUALITY[this.quality][0]);
    for (const b of this.buffers) gl.deleteBuffer(b);
    gl.bindVertexArray(this.vao);
    const pos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const idx = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    this.buffers = [pos, idx];
    this.count = mesh.indices.length;
  }

  /// Show a new track in `slot`. Resolves once its artwork is on the GPU, which is
  /// when the slot's own image can be hidden.
  /// `tint` colours the stand-in when there is no artwork.
  async mount(slot: HTMLElement, look: Look, art: string | null, initial: string, tint: string): Promise<boolean> {
    if (this.canvas.parentElement !== slot) slot.append(this.canvas);
    const gen = ++this.gen;
    this.look = look;
    this.ready = false;
    this.morph = 0;
    this.slow = this.fast = 0;
    this.spin.reset();
    this.iconFor = null;
    const source = await artwork(art, initial, tint).catch(() => artwork(null, initial, tint));
    if (gen !== this.gen || this.gl.isContextLost()) return false;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.ready = true;
    return true;
  }

  /// Rim colour, as CSS `hsl()` from color.ts or any `#rrggbb`.
  setAccent(css: string | null): void {
    this.accent = parseColor(css) ?? [1, 0.3, 0.43];
  }

  /// Pointer over the slot: x, y from the centre in units of the art's radius
  /// (y up); `on` false when it left or was lifted.
  setPointer(x: number, y: number, on: boolean): void {
    const r = Math.hypot(x, y);
    const [dx, dy, dz] = r < 1 ? [x, y, Math.sqrt(1 - r * r)] : [x / r, y / r, 0];
    this.pointerGoal = [dx, dy, dz, on && r < 1.4 ? 1 : 0];
  }

  /// The playing state just flipped and flipped back (a double-tap): let the icon
  /// go without playing out the change.
  settleIcon(): void {
    this.settle = true;
  }

  /// Draw one frame. Returns true while it still moves without music (morphing in,
  /// settling, spinning, following the pointer, showing the icon).
  frame(f: Features, dt: number, s: DropState): boolean {
    const look = this.look;
    if (!look || !this.ready) return false;
    const gl = this.gl;
    const { playing } = s;
    if (playing) this.watch(dt);
    const scale = this.density() * QUALITY[this.quality][1];
    const w = Math.round(this.canvas.clientWidth * scale), h = Math.round(this.canvas.clientHeight * scale);
    if (!w || !h) return false;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);

    this.morph = Math.min(1, this.morph + dt / MORPH_IN);
    const morph = this.morph * this.morph * (3 - 2 * this.morph);
    // The liquid flows with the tempo, faster when the music moves more.
    this.time += dt * look.flow * (playing ? 0.6 + 0.8 * f.wobble + 0.6 * f.drop : 0.25);
    const k = 1 - Math.exp(-dt / 0.15);
    for (let i = 0; i < 4; i++) this.pointer[i] += (this.pointerGoal[i] - this.pointer[i]) * k;
    const spinning = this.spin.step(dt);
    const showing = this.showIcon(s, dt);
    const moving = this.bounce(f, dt, look);

    const u = this.u;
    gl.uniform1f(u.uTime, this.time);
    gl.uniform1f(u.uClock, (performance.now() / 1000) % 1000);
    gl.uniform1f(u.uMorph, morph);
    gl.uniform1f(u.uLevel, (f.sub + f.low) / 2);
    gl.uniform1f(u.uWobble, f.wobble);
    gl.uniform1f(u.uKick, f.kick);
    gl.uniform1f(u.uKickAge, f.kickAge);
    gl.uniform1f(u.uDrop, f.drop);
    gl.uniform1f(u.uBass, f.bass * look.throb);
    gl.uniform1f(u.uGrowl, f.growl);
    this.snare += (f.snare - this.snare) * ease(dt, f.snare > this.snare ? SNARE_ATTACK : SNARE_RELEASE);
    gl.uniform1f(u.uSnare, this.snare);
    gl.uniform1f(u.uGain, look.gain);
    gl.uniform1f(u.uSpike, look.spike);
    gl.uniform1f(u.uStep, look.step);
    gl.uniform1f(u.uTwist, look.twist);
    gl.uniform1f(u.uRipple, look.ripple);
    gl.uniform1f(u.uShock, look.shock);
    gl.uniform1f(u.uIri, look.iri);
    gl.uniform1f(u.uMetal, look.metal);
    gl.uniform1f(u.uHeat, look.heat);
    gl.uniform1f(u.uHue, look.hue);
    gl.uniform3fv(u.uAccent, this.accent);
    // The pointer and the front are in view space; the noise turns with the drop.
    const [px, py, pz, pw] = this.pointer;
    gl.uniform4f(u.uPointer, ...this.spin.toObject(px, py, pz), pw);
    gl.uniform3f(u.uFront, ...this.spin.toObject(0, 0, 1));
    gl.uniformMatrix3fv(u.uRot, false, this.spin.matrix);

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_SHORT, 0);
    return this.morph < 1 || moving || spinning || showing || this.pointer[3] > 0.01 || this.pointerGoal[3] > 0;
  }

  /// Canvas pixels per CSS pixel at full quality. Phones stay at 1 for the battery.
  /// Low-density desktop screens render at 2 and scale down, which smooths the
  /// edges and the icon that would otherwise fall on too few pixels.
  private density(): number {
    const dpr = devicePixelRatio || 1;
    if (this.touch) return Math.min(dpr, 1);
    return dpr < 1.5 ? 2 : 1.5;
  }

  /// Step the springs and set the jump uniforms. True while they still move.
  private bounce(f: Features, dt: number, look: Look): boolean {
    const [jump, pump] = [this.jump, this.pump];
    if (f.kickHit) jump[1] += JUMP * look.bounce * f.kickHit ** 2;
    if (f.snareHit) pump[1] += PUMP * look.bounce * f.snareHit ** 2;
    // The size also follows the bass and the drop, through the same spring.
    const pumpRest = 0.04 * f.low + 0.05 * f.drop;
    // Small fixed steps keep the springs stable on slow frames.
    for (let left = Math.min(dt, 0.1); left > 0; left -= 1 / 240) {
      const h = Math.min(left, 1 / 240);
      jump[1] += (-look.stiff * jump[0] - JUMP_DAMPING * jump[1]) * h;
      jump[0] += jump[1] * h;
      pump[1] += (-PUMP_STIFF * (pump[0] - pumpRest) - PUMP_DAMPING * pump[1]) * h;
      pump[0] += pump[1] * h;
    }
    jump[0] = Math.min(MAX_LIFT, Math.max(-MAX_LIFT / 2, jump[0]));
    // Long while it flies up, squashed as it comes down and lands.
    const stretch = 1 + Math.min(0.18, Math.max(-0.15, jump[1] * STRETCH + Math.min(0, jump[0]) * 1.2));
    // Each "womb" of the bass line swells the whole drop.
    const size = 1 + pump[0] + THROB * look.throb * f.bass;
    // Spun fast it flattens out a little, like dough, and sloshes.
    const whirl = Math.min(1, this.spin.speed / WHIRL);
    const side = (size / Math.sqrt(stretch)) * (1 + 0.08 * whirl);
    const u = this.u;
    this.gl.uniform3f(u.uScale, side, size * stretch * (1 - 0.06 * whirl), side);
    this.gl.uniform1f(u.uLift, Math.max(0, jump[0]));
    this.gl.uniform1f(u.uJelly, Math.min(1, Math.abs(jump[1]) * 0.4 + Math.abs(pump[1]) * 0.6 + 0.5 * whirl));
    return Math.abs(jump[0]) + Math.abs(jump[1]) + Math.abs(pump[1]) > 0.002;
  }

  /// Step the play/pause icon, the loading ring and the calm under them, and set
  /// their uniforms. True while any of them still moves.
  private showIcon(s: DropState, dt: number): boolean {
    const { playing } = s;
    if (this.iconFor === null) {
      // A new track: no pop, just what holds now.
      this.iconShape = playing ? 0 : 1;
      this.iconAlpha = this.calm = playing ? 0 : 1;
      this.iconAge = 1;
    } else if (this.iconFor !== playing) {
      this.iconAge = 0;
      // Pausing starts from the bars; jump to them only while nothing shows.
      if (!playing && this.iconAlpha < 0.2) this.iconShape = 0;
    }
    if (this.settle) {
      this.iconAge = ICON_MELT + ICON_FADE;
      this.settle = false;
    }
    this.iconFor = playing;
    this.iconAge += dt;
    const [shape, alpha] = !playing
      ? [this.iconAge < ICON_MELT ? 0 : 1, 1]
      : [0, this.iconAge < ICON_FADE ? 1 : s.hover ? HOVER : 0];
    // The shape moves at a steady pace; the shader eases it.
    const step = dt / ICON_MORPH;
    this.iconShape += Math.max(-step, Math.min(step, shape - this.iconShape));
    this.iconAlpha += (alpha - this.iconAlpha) * ease(dt, alpha > this.iconAlpha ? ICON_IN : ICON_OUT);
    const busy = s.buffering ? 1 : 0;
    this.busy += (busy - this.busy) * ease(dt, 0.15);
    const calm = Math.max(alpha, busy);
    this.calm += (calm - this.calm) * ease(dt, CALM);

    const u = this.u;
    this.gl.uniform1f(u.uIcon, this.iconShape);
    this.gl.uniform1f(u.uIconA, this.iconAlpha);
    this.gl.uniform1f(u.uBusy, this.busy);
    this.gl.uniform1f(u.uCalm, this.calm);
    this.gl.uniform1f(u.uProgress, s.progress);
    return (
      s.buffering ||
      this.iconAge < ICON_MELT ||
      Math.abs(shape - this.iconShape) > 0.001 ||
      Math.abs(alpha - this.iconAlpha) > 0.005 ||
      Math.abs(calm - this.calm) > 0.005 ||
      this.busy > 0.005
    );
  }

  /// Stepped down to the lowest quality: the GPU had trouble keeping up.
  get struggling(): boolean {
    return this.quality === QUALITY.length - 1;
  }

  /// Step the quality down when frames keep coming in slow, and back up once they
  /// have been on time for a while.
  private watch(dt: number): void {
    // The usual frame time drops quickly to what the display does and creeps up only slowly.
    this.usual = Math.min(1 / 24, this.usual + (dt - this.usual) * (dt < this.usual ? 0.2 : 0.004));
    const late = dt > this.usual * SLOW_RATIO + 0.002;
    this.slow = late ? this.slow + dt : Math.max(0, this.slow - dt);
    this.fast = late ? 0 : this.fast + dt;
    const best = this.touch ? 1 : 0;
    if (this.slow >= SLOW_FOR && this.quality < QUALITY.length - 1) {
      // Stepping up did not hold: wait longer before the next try.
      if (this.steppedUp) this.fastFor *= 2;
      this.steppedUp = false;
      this.setQuality(this.quality + 1);
    } else if (this.fast >= this.fastFor && this.quality > best) {
      this.steppedUp = true;
      this.setQuality(this.quality - 1);
    }
  }

  private setQuality(q: number): void {
    this.slow = this.fast = 0;
    const before = QUALITY[this.quality][0];
    this.quality = q;
    if (QUALITY[q][0] !== before) this.buildMesh();
  }
}

/// The artwork cropped square, or a gradient in `tint` with the artist's initial.
async function artwork(src: string | null, initial: string, tint: string): Promise<HTMLCanvasElement> {
  const c = document.createElement("canvas");
  c.width = c.height = TEXTURE_SIZE;
  const ctx = c.getContext("2d")!;
  if (src) {
    const img = new Image();
    img.src = src;
    await img.decode();
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  } else {
    // Dark enough that the initial and the rim light read, light enough that the
    // drop does not sink into the page.
    // `tint` is `hsl(h s% l%)` from color.ts; only its lightness changes.
    const shade = (l: number) => tint.replace(/[\d.]+%\s*\)$/, `${l}%)`);
    const g = ctx.createLinearGradient(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
    g.addColorStop(0, shade(42));
    g.addColorStop(1, shade(14));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
    ctx.fillStyle = "#ffffffcc";
    ctx.font = `700 ${TEXTURE_SIZE * 0.4}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initial, TEXTURE_SIZE / 2, TEXTURE_SIZE / 2);
  }
  return c;
}

function perspective(fov: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fov / 2);
  const nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

/// `hsl(h s% l%)` (as color.ts makes them) or `#rrggbb`, as 0..1 RGB.
function parseColor(css: string | null): [number, number, number] | null {
  if (!css) return null;
  const hex = css.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const m = css.match(/hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/);
  if (!m) return null;
  const h = +m[1] / 360, s = +m[2] / 100, l = +m[3] / 100;
  const a = s * Math.min(l, 1 - l);
  const ch = (n: number) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [ch(0), ch(8), ch(4)];
}
