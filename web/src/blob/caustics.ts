// Caustics: the light that falls through the drop and lands on the wall behind it,
// focused by the liquid into a moving net of bright lines in the artwork's colours
// and the accent. Drawn before the drop, over the whole canvas, so the drop sits in
// its own light. It fades out well inside the canvas, so no edge of it shows.
//
// - The net flows with the drop's own noise time, and the wobble's filter warps it.
// - Each womb of the bass line thickens the lines; the drop brightens them.
// - After each kick a ring of light runs outwards, as the wave runs over the drop.
// - In a gap the light nearly goes out.

import type { Features } from "../features";
import { NOISE } from "./shaders";
import type { Look } from "./style";

const VERTEX = /* glsl */ `#version 300 es
out vec2 vNdc;
void main() {
  // One triangle over the whole canvas.
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  vNdc = p;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

in vec2 vNdc;

uniform sampler2D uArt;
uniform vec3 uAccent;
uniform vec3 uScale;
uniform float uSpill;   // the canvas's half width, in radii of the drop
uniform float uLift;
uniform float uTime, uKick, uKickAge, uBass, uDrop, uGap, uGrowl;
uniform float uHue, uIri, uHeat;
uniform float uAmount;  // 0 none, 1 full

out vec4 outColor;

${NOISE}

vec3 hueRotate(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}

void main() {
  vec2 world = vNdc * uSpill;
  // The light comes from the upper left, so its pool lies a little below and right,
  // and stretches and squashes with the drop.
  vec2 s = (world - vec2(0.15, uLift - 0.2)) / uScale.xy;
  float r = length(s);
  float pool = (1.0 - smoothstep(0.8, 1.75, r)) * (1.0 - smoothstep(uSpill * 0.72, uSpill * 0.95, length(world)));
  // Every pixel that gets no light, or lies behind the body of the drop, skips the noise.
  float behind = length((world - vec2(0.0, uLift)) / uScale.xy);
  if (pool * uAmount < 0.003 || behind < 0.8) {
    outColor = vec4(0.0);
    return;
  }
  float t = uTime;
  vec3 q = vec3(s * 2.3, t * 0.3);
  // A cheap swirl rather than more noise: this runs for most of the canvas.
  vec2 warp = vec2(sin(q.y * 1.3 + t * 0.7), cos(q.x * 1.1 - t * 0.5));
  q.xy += warp * (0.35 + 0.4 * uGrowl);
  // Thin lines that thicken on each womb: the crests of the noise, sharpened.
  float sharp = mix(10.0, 5.0, clamp(uBass + 0.5 * uDrop, 0.0, 1.0));
  float net = pow(1.0 - abs(snoise(q)), sharp);
  net += 0.6 * pow(1.0 - abs(snoise(q * 1.9 + vec3(4.0, 2.0, t * 0.2))), sharp + 3.0);
  float ahead = (r - 0.95 - uKickAge * 1.4) * 5.0;
  float ring = exp(-ahead * ahead) * exp(-uKickAge * 2.5);

  vec3 art = textureLod(uArt, 0.5 + vec2(s.x, -s.y) * 0.3, 6.0).rgb;
  vec3 rim = hueRotate(uAccent, uHue + uIri * (net + 0.5 * sin(t * 0.3)));
  rim = mix(rim, vec3(1.0, 0.35, 0.1), uHeat * 0.6);
  vec3 light = min(mix(rim, art * 1.5 + 0.08, 0.45), vec3(1.0));
  float k = net * (0.3 + 0.4 * uBass + 0.7 * uKick + 0.5 * uDrop + 1.6 * ring) + 0.05 * (uBass + uDrop);
  float a = clamp(k * pool * uAmount * (1.0 - 0.8 * uGap), 0.0, 0.6);
  // Premultiplied, and never brighter than its own alpha allows.
  outColor = vec4(light * a, a * max(light.r, max(light.g, light.b)));
}
`;

const UNIFORMS = [
  "uArt", "uAccent", "uScale", "uSpill", "uLift", "uTime", "uKick", "uKickAge", "uBass", "uDrop", "uGap", "uGrowl",
  "uHue", "uIri", "uHeat", "uAmount",
] as const;

/// What the drop shares with its light each frame.
export interface CausticFrame {
  spill: number;
  scale: [number, number, number];
  lift: number;
  time: number;
  accent: [number, number, number];
  /// 0 none, 1 full.
  amount: number;
}

export class Caustics {
  private prog!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private u = {} as Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;

  constructor(private gl: WebGL2RenderingContext) {
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "caustics shader failed");
      gl.attachShader(prog, s);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "caustics link failed");
    this.prog = prog;
    for (const name of UNIFORMS) this.u[name] = gl.getUniformLocation(prog, name);
    gl.useProgram(prog);
    gl.uniform1i(this.u.uArt, 0);
    this.vao = gl.createVertexArray();
  }

  /// Draw the light behind the drop. Leaves depth testing off; the caller turns it on.
  draw(f: Features, look: Look, c: CausticFrame): void {
    if (c.amount < 0.003) return;
    const gl = this.gl;
    const u = this.u;
    gl.useProgram(this.prog);
    gl.uniform3fv(u.uAccent, c.accent);
    gl.uniform3f(u.uScale, ...c.scale);
    gl.uniform1f(u.uSpill, c.spill);
    gl.uniform1f(u.uLift, c.lift);
    gl.uniform1f(u.uTime, c.time);
    gl.uniform1f(u.uKick, f.kick);
    gl.uniform1f(u.uKickAge, f.kickAge);
    gl.uniform1f(u.uBass, f.bass * look.throb);
    gl.uniform1f(u.uDrop, f.drop);
    gl.uniform1f(u.uGap, f.gap);
    gl.uniform1f(u.uGrowl, f.growl);
    gl.uniform1f(u.uHue, look.hue);
    gl.uniform1f(u.uIri, look.iri);
    gl.uniform1f(u.uHeat, look.heat);
    gl.uniform1f(u.uAmount, c.amount * look.caustics * 0.22);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);
  }
}
