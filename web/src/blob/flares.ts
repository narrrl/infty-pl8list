// Solar flares round the drop: coronal loops, the arcs that leave a star at one
// point and land at another, played by the music. They are pulled out of the drop
// itself, so they are made of its liquid: the same artwork colours, the same rim in
// the card's accent, the same gloss, and they spring like it does.
//
// - Each kick pulls a loop out. Where it rises follows the beat, so a riddim, which
//   puts the same kick on the same beat bar after bar, draws the same crown again
//   every bar (`Look.crown` positions, `Look.scatter` off them).
// - The bass line's envelope lifts every loop: each "womb" swells them.
// - Light runs along each loop once per womb.
// - The wobble's filter sways the loops: a dark "oo" barely, a bright "wah" more.
// - A snare pinches the top off a loop and throws it out as a drop of its own.
// - In a gap (the stop before a drop) the loops sink back in; the drop then pulls
//   out a burst of them at once.
//
// The loops are drawn after the drop, in the same WebGL2 context, with its depth, so
// their feet sink into it and the drop hides what is behind it.

import type { Features } from "../features";
import type { Look } from "./style";

const SEGMENTS = 32; // along each loop
const SIDES = 10; // round it
const FLOATS = 16; // per loop in the instance buffer
const KICK_MIN = 0.2; // weaker kicks pull out no loop
const SPAN = [0.2, 0.36]; // half the distance between a loop's feet, rad
const WIDTH = 0.024; // the loop's radius at its top, in radii of the drop
const ERUPT = 0.6; // s from the pinch until the thrown top is gone
const DROP_BURST = 0.55; // the drop rising through this pulls out a burst of loops
// Each loop's height is a spring, a little looser than the drop's jump, so it
// overshoots once as it comes out and sinks back softly.
const SPRING = 150;
const DAMPING = 13;

interface Loop {
  /// Feet, unit vectors in the drop's own space, so they turn with it.
  a: [number, number, number];
  b: [number, number, number];
  age: number;
  /// Seconds before it sinks back, from the tempo.
  life: number;
  /// Seconds since its top was pinched off, or -1.
  erupt: number;
  seed: number;
  /// Light travelled along it, in loop lengths.
  phase: number;
  height: number;
  speed: number;
  /// How high it wants to stand.
  goal: number;
}

export const FLARE_VERTEX = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec2 aTube; // along 0..1, round 0..1
layout(location = 1) in vec3 aA;
layout(location = 2) in vec3 aB;
layout(location = 3) in vec4 aP; // height, alpha, grown 0..1, seed
layout(location = 4) in vec4 aQ; // erupt 0..1, sway, width, phase

uniform mat4 uProj;
uniform mat3 uRot;
uniform vec3 uScale;
uniform float uLift, uDist, uTime;

out vec3 vPos;    // view space
out vec3 vNormal; // view space
out vec3 vObj;    // the drop's surface under this point, for the artwork
out float vT;
out float vAlpha;
out float vPhase;

const float PI = 3.14159265;

// The loop's centre line at t, in the drop's own space.
vec3 along(float t) {
  t = clamp(t, 0.0, 1.0);
  float om = acos(clamp(dot(aA, aB), -1.0, 1.0));
  vec3 base = om < 0.001 ? aA : (sin((1.0 - t) * om) * aA + sin(t * om) * aB) / sin(om);
  float arch = sin(PI * t);
  float e = aQ.x;
  // The piece that is pinched off: thrown out while the legs sink back.
  float top = 1.0 - smoothstep(0.12, 0.2, abs(t - 0.5));
  float h = aP.x * arch * (1.0 - e * (1.0 - top)) + e * (0.15 + 0.45 * e) * top;
  // The feet start a little inside, so they come out of the surface, not off it.
  vec3 p = base * (0.93 + 0.07 * arch + h);
  // A slow sway, flowing with the drop's own noise time.
  vec3 side = normalize(cross(base, aB - aA + vec3(1e-4)));
  p += side * aQ.y * 0.05 * sin(t * 6.283 + uTime * 2.0 + aP.w * 6.283) * arch;
  return p;
}

void main() {
  float t = aTube.x;
  vec3 c = along(t);
  vec3 ahead = normalize(along(t + 0.01) - along(t - 0.01) + vec3(1e-5));
  vec3 n1 = normalize(cross(ahead, normalize(c)) + vec3(1e-5));
  vec3 n2 = cross(n1, ahead);
  float a = aTube.y * 2.0 * PI;
  vec3 d = cos(a) * n1 + sin(a) * n2;
  // Thick feet that melt into the drop, thinner at the top; thin while it grows.
  float arch = sin(PI * t);
  float foot = 1.0 - arch;
  float r = aQ.z * (1.0 + 2.2 * foot * foot * foot) * aP.z;
  float e = aQ.x;
  if (e > 0.0) {
    // A neck on each side of the top that narrows until it parts.
    float neck = abs(abs(t - 0.5) - 0.16);
    r *= smoothstep(0.0, 0.01 + 0.09 * e, neck);
    r *= 1.0 - 0.6 * e * (1.0 - smoothstep(0.12, 0.2, abs(t - 0.5)));
  }
  vec3 p = c + d * r;
  vPos = uRot * p * uScale + vec3(0.0, uLift, -uDist);
  vNormal = normalize(uRot * d / uScale);
  vObj = normalize(c);
  vT = t;
  vAlpha = aP.y;
  vPhase = aQ.w;
  gl_Position = uProj * vec4(vPos, 1.0);
}
`;

export const FLARE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

in vec3 vPos;
in vec3 vNormal;
in vec3 vObj;
in float vT;
in float vAlpha;
in float vPhase;

uniform sampler2D uArt;
uniform vec3 uAccent;
uniform float uTime, uHue, uIri, uMetal, uHeat;
uniform float uGlow; // the drop's rim brightness from the music
uniform float uRun;  // light running along: 0 none, 1 from the feet, -1 to them

out vec4 outColor;

vec3 hueRotate(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}

// The drop's own shading (shaders.ts), without the refraction: the loops are thin.
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(-vPos);
  float nv = 1.0 - max(dot(n, v), 0.0);
  float fres = nv * nv * nv;
  // The artwork where the loop comes out, blurred into its colours.
  vec3 art = textureLod(uArt, 0.5 + vec2(vObj.x, -vObj.y) * 0.48, 4.5).rgb;
  vec3 rim = hueRotate(uAccent, uHue + uIri * (fres + 0.5 * sin(uTime * 0.3)));
  rim = mix(rim, vec3(1.0, 0.35, 0.1), uHeat * 0.6);
  vec3 slick = 0.5 + 0.5 * cos(6.2831853 * (fres * 1.6 + vec3(0.0, 0.33, 0.67) + uTime * 0.05));
  rim = mix(rim, rim * 0.4 + slick * length(rim) * 0.75, 0.25 + 0.5 * uIri);

  vec3 col = art * mix(0.8, 0.4, fres);
  col += rim * fres * (0.65 + uGlow);
  col += mix(rim, vec3(1.0), 0.5) * fres * fres * (0.3 + 0.8 * uGlow);
  vec3 light = normalize(vec3(-0.5, 0.7, 0.6));
  col += pow(max(dot(n, normalize(light + v)), 0.0), mix(40.0, 140.0, uMetal)) * mix(0.35, 0.8, uMetal);
  vec3 r = reflect(-v, n);
  vec3 env = mix(vec3(0.015), uAccent * 0.5, pow(smoothstep(-0.4, 1.0, r.y), 2.0));
  env += 0.5 * smoothstep(0.92, 0.985, dot(r, normalize(vec3(-0.5, 0.7, 0.5))));
  col += env * (0.1 + 0.5 * fres);
  // Light in the accent runs up both legs, or back down them in a gap.
  float s = 1.0 - abs(vT - 0.5) * 2.0;
  float k = fract(s - vPhase * sign(uRun));
  float run = smoothstep(0.0, 0.08, k) * (1.0 - smoothstep(0.08, 0.4, k)) * abs(uRun);
  col += rim * run * (0.25 + 0.6 * fres);
  // Glassy: the middle lets the page through, the rim holds the colour.
  float a = mix(0.8, 1.0, smoothstep(0.0, 0.5, nv)) * (1.0 - 0.9 * smoothstep(0.8, 1.0, fres)) * vAlpha;
  outColor = vec4(col * a, a);
}
`;

const FLARE_UNIFORMS = [
  "uProj", "uRot", "uScale", "uLift", "uDist", "uTime", "uArt", "uAccent", "uHue", "uIri", "uMetal", "uHeat", "uGlow", "uRun",
] as const;

/// What the drop shares with its loops each frame.
export interface FlareFrame {
  proj: Float32Array;
  dist: number;
  rot: Float32Array;
  scale: [number, number, number];
  lift: number;
  accent: [number, number, number];
  /// The drop's flow time, so the loops sway with its surface.
  time: number;
  /// View direction to the drop's own space (spin.ts).
  toObject: (x: number, y: number, z: number) => [number, number, number];
}

export class Flares {
  private prog!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private inst!: WebGLBuffer;
  private count = 0;
  private u = {} as Record<(typeof FLARE_UNIFORMS)[number], WebGLUniformLocation | null>;
  private data: Float32Array;
  private loops: Loop[] = [];
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
    gl.useProgram(prog);
    gl.uniform1i(this.u.uArt, 0);

    // A tube: rings of SIDES + 1 points (the seam twice) at SEGMENTS + 1 steps.
    const ring = SIDES + 1;
    const tube = new Float32Array((SEGMENTS + 1) * ring * 2);
    for (let i = 0; i <= SEGMENTS; i++) for (let j = 0; j < ring; j++) tube.set([i / SEGMENTS, j / SIDES], (i * ring + j) * 2);
    const idx = new Uint16Array(SEGMENTS * SIDES * 6);
    let o = 0;
    for (let i = 0; i < SEGMENTS; i++) {
      for (let j = 0; j < SIDES; j++) {
        const p = i * ring + j, q = p + ring;
        idx.set([p, q, p + 1, p + 1, q, q + 1], o);
        o += 6;
      }
    }
    this.count = idx.length;

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const pos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.bufferData(gl.ARRAY_BUFFER, tube, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
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

  /// Step the loops by `dt` and draw them. `strength` 0 lets them sink back.
  /// True while there are loops left.
  frame(f: Features, dt: number, look: Look, playing: boolean, strength: number, period: number, view: FlareFrame): boolean {
    const on = playing && strength > 0;
    if (on && f.kickHit >= KICK_MIN && f.gap < 0.5) this.spawn(f, look, period, view);
    // The drop: a burst all round.
    if (on && f.drop > DROP_BURST && this.lastDrop <= DROP_BURST) {
      for (let i = 0; i < Math.ceil(this.max / 2); i++) this.spawn(f, look, period, view, true);
    }
    this.lastDrop = f.drop;
    if (on && f.snareHit >= look.erupt) {
      const victim = this.loops.filter((l) => l.erupt < 0 && l.height > 0.5 * l.goal * look.arch).sort((x, y) => y.age - x.age)[0];
      if (victim) victim.erupt = 0;
    }

    // Light runs once along a loop per womb, or with the beat while there is no wobble.
    const rate = f.wobbleRate > 0.3 ? f.wobbleRate : 0.5 / period;
    const lift = look.arch * (0.35 + 0.5 * f.bass + 0.25 * f.drop) * (1 - 0.85 * f.gap);
    this.loops = this.loops.filter((l) => {
      l.age += dt;
      l.phase += dt * rate;
      if (l.erupt >= 0) l.erupt += dt;
      // Without music, or past its life, it sinks back in.
      const sinking = !on || l.age > l.life;
      const goal = sinking ? 0 : lift * l.goal;
      for (let left = Math.min(dt, 0.1); left > 0; left -= 1 / 240) {
        const h = Math.min(left, 1 / 240);
        l.speed += (-SPRING * (l.height - goal) - DAMPING * l.speed) * h;
        l.height += l.speed * h;
      }
      if (l.erupt >= ERUPT) return false;
      return !(sinking && l.height < 0.01 && l.speed <= 0);
    });
    if (!this.loops.length) return false;

    const d = this.data;
    const n = Math.min(this.loops.length, this.max);
    // As thick as it is out: a loop grows out of the surface and sinks back thin.
    const full = Math.max(0.05, 0.6 * look.arch);
    const sway = 0.3 + 1.2 * f.growl * f.bass + 0.4 * f.wobble;
    for (let i = 0; i < n; i++) {
      const l = this.loops[i];
      const grown = Math.min(1, Math.max(0, l.height) / full);
      const e = l.erupt < 0 ? 0 : l.erupt / ERUPT;
      d.set([
        ...l.a, ...l.b,
        Math.max(0, l.height), Math.min(1, strength + (on ? 0 : 1)), Math.sqrt(grown), l.seed,
        e, sway, WIDTH * (1 + 0.3 * f.drop + 0.2 * f.bass), l.phase,
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
    gl.uniform1f(u.uTime, view.time);
    gl.uniform3fv(u.uAccent, view.accent);
    gl.uniform1f(u.uHue, look.hue);
    gl.uniform1f(u.uIri, look.iri);
    gl.uniform1f(u.uMetal, look.metal);
    gl.uniform1f(u.uHeat, look.heat);
    gl.uniform1f(u.uGlow, 0.9 * f.kick + 0.5 * f.drop + 0.5 * f.bass * look.throb);
    gl.uniform1f(u.uRun, f.gap > 0.5 ? -1 : Math.min(1, 0.3 + f.bass + f.wobble));
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, d, 0, n * FLOATS);
    gl.drawElementsInstanced(gl.TRIANGLES, this.count, gl.UNSIGNED_SHORT, 0, n);
    gl.bindVertexArray(null);
    return true;
  }

  /// A new loop where the beat says: round the rim of the drop as seen, straddling
  /// it, so it arcs out past the edge.
  private spawn(f: Features, look: Look, period: number, view: FlareFrame, anywhere = false): void {
    if (this.loops.length >= this.max) {
      // The oldest that is not breaking sinks back to make room.
      const oldest = this.loops.reduce((o, l) => (l.erupt < 0 && l.age > o.age ? l : o), this.loops[0]);
      oldest.life = Math.min(oldest.life, oldest.age);
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
    const z = -0.1 + Math.random() * 0.35;
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
      speed: 0,
      goal: 0.85 + 0.3 * Math.random(),
    });
  }
}
