// Solar flares round the drop: coronal loops, the magnetic arcs that leave a star at
// one point and land at another, played by the music.
//
// - Each kick raises a loop. Where it rises follows the beat, so a riddim, which
//   puts the same kick on the same beat bar after bar, draws the same crown again
//   every bar (`Look.crown` positions, `Look.scatter` off them).
// - The bass line's envelope lifts and drops every loop: each "womb" swells them.
// - Bright knots of plasma run along each loop once per womb.
// - The wobble's filter sets the heat: a dark "oo" glows deep red, a bright "wah"
//   burns yellow to white, and twists the loops.
// - A snare breaks a loop at its top and throws the top out, like an eruption.
// - In a gap (the stop before a drop) the loops sink down and plasma rains back
//   to their feet; the drop then sets everything off at once.
//
// The loops are drawn after the drop, in the same WebGL2 context, added onto it.
// They test against its depth, so the drop hides the parts behind it.

import type { Features } from "../features";
import type { Look } from "./style";

const SEGMENTS = 40; // along each loop
const FLOATS = 16; // per loop in the instance buffer
const RISE = 0.18; // s for a new loop to stand up
const FADE = 0.35; // s for an old one to go
const ERUPT = 0.7; // s from the break until the loop is gone
const KICK_MIN = 0.2; // weaker kicks raise no loop
const SPAN = [0.22, 0.42]; // half the distance between a loop's feet, rad
const WIDTH = 0.03; // across a loop, in radii
const HEAT_SMOOTH = 0.12; // s
const DROP_BURST = 0.55; // the drop rising through this sets off a burst of loops

interface Loop {
  /// Feet, unit vectors in the drop's own space, so they turn with it.
  a: [number, number, number];
  b: [number, number, number];
  age: number;
  /// Seconds it lives, from the tempo.
  life: number;
  /// Seconds since it broke, or -1.
  erupt: number;
  seed: number;
  /// Knots travelled, in loop lengths.
  phase: number;
  height: number;
}

export const FLARE_VERTEX = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec2 aStrip; // along 0..1, across -1..1
layout(location = 1) in vec3 aA;
layout(location = 2) in vec3 aB;
layout(location = 3) in vec4 aP; // height, alpha, heat, seed
layout(location = 4) in vec4 aQ; // erupt 0..1, twist, width, phase

uniform mat4 uProj;
uniform mat3 uRot;
uniform vec3 uScale;
uniform float uLift, uDist, uTime;

out float vT;
out float vSide;
out float vAlpha;
out float vHeat;
out float vPhase;
out float vErupt;

// The loop's centre line at t, in view space.
vec3 along(float t) {
  float om = acos(clamp(dot(aA, aB), -1.0, 1.0));
  vec3 base = om < 0.001 ? aA : (sin((1.0 - t) * om) * aA + sin(t * om) * aB) / sin(om);
  float arch = sin(3.14159265 * t);
  float e = aQ.x;
  // Broken, the legs sink and the top is thrown out.
  float top = smoothstep(0.7, 0.98, arch);
  float h = aP.x * arch * (1.0 - 0.6 * e) + e * (0.25 + 0.5 * e) * top;
  vec3 p = base * (1.0 + h);
  // A twist: the loop winds round its own line, more at the top.
  vec3 side = normalize(cross(base, aB - aA + vec3(1e-4)));
  p += side * aQ.y * 0.06 * sin(t * 12.566 + uTime * 3.0 + aP.w * 6.283) * arch;
  return uRot * p * uScale + vec3(0.0, uLift, -uDist);
}

void main() {
  float t = aStrip.x;
  vec3 v = along(t);
  vec3 ahead = along(min(1.0, t + 0.01)) - along(max(0.0, t - 0.01));
  vec3 across = normalize(cross(ahead, v) + vec3(1e-5));
  // Thicker legs, thin at the top, like the real ones look.
  float arch = sin(3.14159265 * t);
  v += across * aStrip.y * aQ.z * (1.0 - 0.35 * arch);
  vT = t;
  vSide = aStrip.y;
  vAlpha = aP.y;
  vHeat = aP.z;
  vPhase = aQ.w;
  vErupt = aQ.x;
  gl_Position = uProj * vec4(v, 1.0);
}
`;

export const FLARE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

in float vT;
in float vSide;
in float vAlpha;
in float vHeat;
in float vPhase;
in float vErupt;

uniform vec3 uAccent;
uniform float uTint;
uniform float uRain;  // 0..1: plasma runs down to the feet instead of along
uniform float uFlash; // the feet light up on a drop

out vec4 outColor;

// Glowing plasma from cool to hot: deep red, orange, yellow, white.
vec3 heat(float h) {
  vec3 c = mix(vec3(0.45, 0.02, 0.0), vec3(1.0, 0.3, 0.02), smoothstep(0.0, 0.35, h));
  c = mix(c, vec3(1.0, 0.78, 0.25), smoothstep(0.35, 0.7, h));
  return mix(c, vec3(1.0, 0.97, 0.9), smoothstep(0.7, 1.0, h));
}

void main() {
  float across = 1.0 - abs(vSide);
  float core = pow(across, 6.0);
  float glow = pow(across, 1.5);
  // Knots: along the loop, or from its top down both legs while it rains.
  float s = mix(vT, 1.0 - abs(vT - 0.5) * 2.0, uRain);
  float k = fract(s * 2.0 - vPhase);
  float knot = smoothstep(0.0, 0.06, k) * (1.0 - smoothstep(0.06, 0.32, k));
  float feet = 1.0 - smoothstep(0.0, 0.14, min(vT, 1.0 - vT));
  vec3 hot = heat(vHeat);
  vec3 col = hot * (0.35 * glow + 0.8 * core);
  col += heat(min(1.0, vHeat + 0.35)) * knot * (0.3 * glow + 1.1 * core);
  col += heat(min(1.0, vHeat + 0.5)) * feet * glow * (0.25 + 1.2 * uFlash);
  // Leaning towards the card's colours, keeping the brightness.
  col = mix(col, uAccent * dot(col, vec3(0.6)), uTint);
  // A broken loop fades from the break outwards.
  col *= vAlpha * (1.0 - vErupt * smoothstep(0.0, 0.5, 1.0 - abs(vT - 0.5) * 2.0) * 0.5);
  // Added onto what is there; premultiplied, so alpha is the brightest channel.
  outColor = vec4(col, max(col.r, max(col.g, col.b)));
}
`;

const FLARE_UNIFORMS = ["uProj", "uRot", "uScale", "uLift", "uDist", "uTime", "uAccent", "uTint", "uRain", "uFlash"] as const;

/// What the drop shares with its loops each frame.
export interface FlareFrame {
  proj: Float32Array;
  dist: number;
  rot: Float32Array;
  scale: [number, number, number];
  lift: number;
  accent: [number, number, number];
  /// View direction to the drop's own space (spin.ts).
  toObject: (x: number, y: number, z: number) => [number, number, number];
}

export class Flares {
  private prog!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private strip!: WebGLBuffer;
  private inst!: WebGLBuffer;
  private u = {} as Record<(typeof FLARE_UNIFORMS)[number], WebGLUniformLocation | null>;
  private data: Float32Array;
  private loops: Loop[] = [];
  private heat = 0.3;
  private time = 0;
  private lastDrop = 0;
  /// Where on the crown the next loop goes, for tracks with scatter.
  private turn = Math.random();

  constructor(
    private gl: WebGL2RenderingContext,
    private max: number,
  ) {
    this.data = new Float32Array(max * FLOATS);
    this.init();
  }

  /// Everything on the GPU; again after a lost context comes back.
  init(): void {
    const gl = this.gl;
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, FLARE_VERTEX], [gl.FRAGMENT_SHADER, FLARE_FRAGMENT]] as const) {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "flare shader failed");
      gl.attachShader(prog, s);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "flare link failed");
    this.prog = prog;
    for (const name of FLARE_UNIFORMS) this.u[name] = gl.getUniformLocation(prog, name);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const strip = new Float32Array((SEGMENTS + 1) * 4);
    for (let i = 0; i <= SEGMENTS; i++) strip.set([i / SEGMENTS, -1, i / SEGMENTS, 1], i * 4);
    this.strip = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.strip);
    gl.bufferData(gl.ARRAY_BUFFER, strip, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.inst = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    const stride = FLOATS * 4;
    for (const [loc, size, offset] of [[1, 3, 0], [2, 3, 3], [3, 4, 6], [4, 4, 10]]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset * 4);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
  }

  /// A new track: no loops carried over.
  reset(): void {
    this.loops = [];
    this.lastDrop = 0;
  }

  /// Fewer loops on slow devices.
  setMax(max: number): void {
    this.max = max;
    if (this.loops.length > max) this.loops.length = max;
    if (this.data.length < max * FLOATS) {
      this.data = new Float32Array(max * FLOATS);
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
      gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    }
  }

  get active(): boolean {
    return this.loops.length > 0;
  }

  /// Step the loops by `dt` and draw them. `strength` 0 lets them die out.
  /// True while there are loops left.
  frame(f: Features, dt: number, look: Look, playing: boolean, strength: number, period: number, view: FlareFrame): boolean {
    const on = playing && strength > 0;
    this.time += dt;
    this.heat += (Math.min(1, 0.3 + 0.55 * f.growl * Math.max(0.4, f.bass) + 0.35 * f.drop) - this.heat) * (1 - Math.exp(-dt / HEAT_SMOOTH));
    if (on && f.kickHit >= KICK_MIN && f.gap < 0.5) this.spawn(f, look, period, view);
    // The drop: a burst all round.
    if (on && f.drop > DROP_BURST && this.lastDrop <= DROP_BURST) {
      for (let i = 0; i < Math.ceil(this.max / 2); i++) this.spawn(f, look, period, view, true);
    }
    this.lastDrop = f.drop;
    if (on && f.snareHit >= look.erupt) {
      const victim = this.loops.filter((l) => l.erupt < 0 && l.age > RISE).sort((x, y) => y.age - x.age)[0];
      if (victim) victim.erupt = 0;
    }

    // Knots run once along a loop per womb, or with the beat while there is no wobble.
    const rate = f.wobbleRate > 0.3 ? f.wobbleRate : 0.5 / period;
    const want = look.arch * (0.3 + 0.55 * f.bass + 0.3 * f.drop) * (1 - 0.8 * f.gap);
    const follow = 1 - Math.exp(-dt / 0.06);
    this.loops = this.loops.filter((l) => {
      l.age += dt;
      l.phase += dt * rate * (1 - 0.5 * f.gap);
      l.height += (want * (0.85 + 0.3 * l.seed) - l.height) * follow;
      if (l.erupt >= 0) l.erupt += dt;
      // Without music they go, quicker than they would.
      if (!on) l.life = Math.min(l.life, l.age + FADE);
      return l.erupt < ERUPT && l.age < l.life;
    });
    if (!this.loops.length) return false;

    const d = this.data;
    const n = Math.min(this.loops.length, this.max);
    for (let i = 0; i < n; i++) {
      const l = this.loops[i];
      const rise = Math.min(1, l.age / RISE);
      const fade = Math.min(1, (l.life - l.age) / FADE);
      const alpha = rise * rise * (3 - 2 * rise) * Math.max(0, fade) * Math.max(strength, on ? 0 : 1);
      const e = l.erupt < 0 ? 0 : l.erupt / ERUPT;
      d.set([
        ...l.a, ...l.b,
        l.height * rise, alpha * (1 - e * e), this.heat, l.seed,
        e, 0.2 + 1.2 * f.growl * f.bass + 0.3 * f.wobble, WIDTH * (1 + 0.6 * f.drop), l.phase,
        0, 0,
      ], i * FLOATS);
    }

    const gl = this.gl;
    const u = this.u;
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(u.uProj, false, view.proj);
    gl.uniformMatrix3fv(u.uRot, false, view.rot);
    gl.uniform3f(u.uScale, ...view.scale);
    gl.uniform1f(u.uLift, view.lift);
    gl.uniform1f(u.uDist, view.dist);
    gl.uniform1f(u.uTime, this.time);
    gl.uniform3fv(u.uAccent, view.accent);
    gl.uniform1f(u.uTint, look.tint);
    gl.uniform1f(u.uRain, f.gap);
    gl.uniform1f(u.uFlash, f.drop);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, d, 0, n * FLOATS);
    // Added on, tested against the drop but not hiding each other.
    gl.depthMask(false);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, (SEGMENTS + 1) * 2, n);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(true);
    gl.bindVertexArray(null);
    return true;
  }

  /// A new loop where the beat says: round the rim of the drop as seen, straddling
  /// it, so it arcs out past the edge.
  private spawn(f: Features, look: Look, period: number, view: FlareFrame, anywhere = false): void {
    if (this.loops.length >= this.max) {
      // The oldest that is not breaking makes room.
      const oldest = this.loops.reduce((o, l) => (l.erupt < 0 && l.age > o.age ? l : o), this.loops[0]);
      oldest.life = Math.min(oldest.life, oldest.age + FADE);
      if (this.loops.length >= this.max + 2) return;
    }
    const crown = Math.max(1, Math.round(look.crown));
    let slot: number;
    if (anywhere) slot = Math.random() * crown;
    else if (look.scatter === 0) slot = Math.round(f.bar * crown) % crown;
    else {
      this.turn = (this.turn + 1 + (Math.random() - 0.5) * look.scatter) % crown;
      slot = this.turn;
    }
    // Upright crowns read best: the first slot sits at the top.
    const angle = Math.PI / 2 - (slot / crown) * Math.PI * 2;
    const z = -0.1 + Math.random() * 0.4;
    const r = Math.sqrt(1 - z * z);
    const c: [number, number, number] = [Math.cos(angle) * r, Math.sin(angle) * r, z];
    const tx = -Math.sin(angle), ty = Math.cos(angle);
    const span = SPAN[0] + Math.random() * (SPAN[1] - SPAN[0]);
    const foot = (sgn: number) => {
      const x = c[0] + tx * span * sgn, y = c[1] + ty * span * sgn, zz = c[2];
      const len = Math.hypot(x, y, zz);
      return view.toObject(x / len, y / len, zz / len);
    };
    this.loops.push({
      a: foot(1),
      b: foot(-1),
      age: 0,
      life: look.life * period * (0.9 + 0.2 * Math.random()),
      erupt: -1,
      seed: Math.random(),
      phase: Math.random(),
      height: 0,
    });
  }
}
