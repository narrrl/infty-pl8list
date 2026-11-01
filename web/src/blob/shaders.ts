// GLSL for the liquid artwork drop. The vertex shader moves a unit sphere with
// noise driven by the music; the fragment shader shows the artwork through the
// surface, with a rim in the card's accent colour.

// 3D simplex noise by Ian McEwan and Stefan Gustavson (Ashima Arts), MIT licence:
// https://github.com/ashima/webgl-noise
const NOISE = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

export const VERTEX = /* glsl */ `#version 300 es
precision highp float;

in vec3 position;

uniform mat4 uProj;
uniform float uDist;    // camera distance
uniform float uTime;    // flow time, runs with the tempo
uniform float uMorph;   // 0 flat disc (the static artwork), 1 liquid
// Music, see features.ts.
uniform float uLevel, uWobble, uKickAge, uSnare, uDrop, uBass, uGrowl;
// Character of the track, see style.ts.
uniform float uGain, uSpike, uStep, uTwist, uRipple, uShock;
// The jump on prominent hits, from the springs in blob.ts.
uniform vec3 uScale;    // squash and stretch
uniform float uLift;    // upwards
uniform float uJelly;   // extra wobble while a jump rings out, 0..1
uniform vec4 uPointer;  // direction on the sphere, strength

out vec3 vPos;     // view space
out vec3 vNormal;  // view space
out vec2 vFlat;    // front projection of the resting sphere, for the artwork

${NOISE}

// Every layer keeps a floor, so the drop never goes still and nothing snaps in from
// nothing; the music only turns each layer up and down.
float disp(vec3 p) {
  vec3 q = p;
  float a = uTwist * (p.y + 0.3 * sin(uTime)) * (0.5 + uWobble);
  q.xz = mat2(cos(a), -sin(a), sin(a), cos(a)) * q.xz;
  float t = uTime;
  // Big lobes: swell on every "womb" of the bass line.
  float lobes = snoise(q * 1.1 + vec3(0.0, t * 0.35, t * 0.2))
    * (0.07 + 0.05 * uLevel + 0.11 * uBass + 0.08 * uDrop + 0.08 * uJelly);
  // Terraces with soft edges: stiff, but no torn shards.
  float steps = lobes * 10.0;
  lobes = mix(lobes, (floor(steps) + smoothstep(0.3, 0.7, fract(steps))) / 10.0, uStep);
  float sway = snoise(q * 1.7 - vec3(t * 0.5, 0.0, t * 0.3)) * (0.03 + 0.03 * uWobble);
  // Crinkles open up with the wobble's filter: dark "oo" smooth, bright "wah" rough.
  float ripples = snoise(q * 3.2 + vec3(t * 1.3, -t, 0.0)) * (0.012 + 0.035 * uWobble + 0.045 * uGrowl * uBass) * uRipple;
  float n = snoise(q * 2.4 - vec3(0.0, t * 0.6, t * 0.9));
  float spikes = pow(max(n, 0.0), 3.0) * (0.05 + 0.25 * uSnare + 0.15 * uGrowl * uBass + 0.1 * uDrop) * uSpike;
  // After each kick a wave runs from the front of the drop round to the back.
  float angle = acos(clamp(p.z, -1.0, 1.0));
  float wave = exp(-pow((angle - uKickAge * 5.0) * 1.8, 2.0)) * exp(-uKickAge * 2.8) * 0.09 * uShock;
  float dent = -0.18 * uPointer.w * exp(-pow(distance(p, uPointer.xyz) * 2.2, 2.0));
  return clamp((lobes + sway + ripples + spikes + wave) * uGain + dent, -0.3, 0.4);
}

vec3 shape(vec3 p) {
  vec3 s = p * (1.0 + disp(p) * uMorph);
  s.z *= mix(0.04, 1.0, uMorph);
  return s;
}

void main() {
  vec3 p = position;
  // Normal from two displaced neighbours along the surface.
  vec3 t1 = normalize(cross(p, abs(p.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 t2 = cross(p, t1);
  const float e = 0.012;
  vec3 s = shape(p);
  vec3 n = normalize(cross(shape(normalize(p + t1 * e)) - s, shape(normalize(p + t2 * e)) - s));
  if (dot(n, p) < 0.0) n = -n;
  vPos = s * uScale + vec3(0.0, uLift, -uDist);
  vNormal = normalize(n / uScale);
  vFlat = p.xy;
  gl_Position = uProj * vec4(vPos, 1.0);
}
`;

export const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

in vec3 vPos;
in vec3 vNormal;
in vec2 vFlat;

uniform sampler2D uArt;
uniform vec3 uAccent;
uniform float uTime, uMorph, uKick, uDrop, uBass, uGrowl;
uniform float uHue;    // rim hue offset, radians
uniform float uIri;    // how much the rim hue drifts
uniform float uMetal;  // sharper, brighter highlights
uniform float uHeat;   // pulls the rim towards orange

out vec4 outColor;

vec3 hueRotate(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(-vPos);
  float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  // Looking through the surface bends the artwork like water does.
  vec2 bend = n.xy * (0.22 + 0.1 * uDrop) * uMorph;
  vec2 uv = 0.5 + vec2(vFlat.x, -vFlat.y) * 0.48 - vec2(bend.x, -bend.y) * 0.5;
  vec2 split = n.xy * (0.004 + 0.02 * uKick + 0.008 * uGrowl * uBass) * uMorph;
  vec3 art = vec3(texture(uArt, uv + split).r, texture(uArt, uv).g, texture(uArt, uv - split).b);
  art = mix(art, smoothstep(0.0, 1.0, art), 0.6 * uDrop);

  vec3 light = normalize(vec3(-0.5, 0.7, 0.6));
  float spec = pow(max(dot(n, normalize(light + v)), 0.0), mix(40.0, 140.0, uMetal)) * mix(0.35, 0.8, uMetal);
  vec3 rim = hueRotate(uAccent, uHue + uIri * (fres * 3.0 + uTime * 0.3));
  rim = mix(rim, vec3(1.0, 0.35, 0.1), uHeat * 0.6);

  vec3 col = art * mix(1.0, 0.45, fres * uMorph);
  col += rim * fres * (0.5 + 0.7 * uKick + 0.4 * uDrop + 0.5 * uBass) * uMorph;
  col += spec * uMorph;
  outColor = vec4(col, 1.0);
}
`;
