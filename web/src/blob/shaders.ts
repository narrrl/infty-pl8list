import { SPIKES } from "./ferro";

// GLSL for the liquid artwork drop. The vertex shader moves a unit sphere with
// noise driven by the music and turns it as spin.ts says; the fragment shader shows
// the artwork through the surface, glossy with the card's accent colour.

// 3D simplex noise by Ian McEwan and Stefan Gustavson (Ashima Arts), MIT licence:
// https://github.com/ashima/webgl-noise
export const NOISE = /* glsl */ `
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

// The play/pause icon on the front of the drop, as distances in units of the radius
// (negative inside). Each pause bar is a quad whose corners slide into one half of
// the play triangle, so every step between the two is one clean shape, not two
// faded over each other.
const ICON = /* glsl */ `
// Inigo Quilez's polygon distance, MIT licence, for four corners. Written out edge
// by edge: some phone drivers (Mali) reject an array of vec2 with "no default
// precision", and the whole drop then fails to compile.
void quadEdge(vec2 p, vec2 a, vec2 b, inout float d, inout float s) {
  vec2 e = b - a;
  vec2 w = p - a;
  vec2 q = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
  d = min(d, dot(q, q));
  bvec3 c = bvec3(p.y >= a.y, p.y < b.y, e.x * w.y > e.y * w.x);
  if (all(c) || all(not(c))) s = -s;
}

float sdQuad(vec2 p, vec2 v0, vec2 v1, vec2 v2, vec2 v3) {
  float d = dot(p - v0, p - v0);
  float s = 1.0;
  quadEdge(p, v0, v3, d, s);
  quadEdge(p, v1, v0, d, s);
  quadEdge(p, v2, v1, d, s);
  quadEdge(p, v3, v2, d, s);
  return s * sqrt(d);
}

// 0 pause, 1 play. Corners go bottom left, bottom right, top right, top left.
float sdPlayPause(vec2 p, float t) {
  float k = smoothstep(0.0, 1.0, t);
  // A small swing in the middle of the morph, level again at both ends, so the
  // change reads as a motion and not a dissolve.
  float a = 0.35 * sin(3.14159 * k);
  p = mat2(cos(a), sin(a), -sin(a), cos(a)) * p;
  float left = sdQuad(p,
    mix(vec2(-0.13, -0.16), vec2(-0.12, -0.17), k),
    mix(vec2(-0.05, -0.16), vec2(0.04, -0.079), k),
    mix(vec2(-0.05, 0.16), vec2(0.04, 0.079), k),
    mix(vec2(-0.13, 0.16), vec2(-0.12, 0.17), k));
  float right = sdQuad(p,
    mix(vec2(0.05, -0.16), vec2(0.02, -0.091), k),
    mix(vec2(0.13, -0.16), vec2(0.18, -0.001), k),
    mix(vec2(0.13, 0.16), vec2(0.18, 0.001), k),
    mix(vec2(0.05, 0.16), vec2(0.02, 0.091), k));
  // A smooth union, so the seam between the halves fills in as they meet.
  float h = clamp(0.5 + 0.5 * (right - left) / 0.03, 0.0, 1.0);
  return mix(right, left, h) - 0.03 * h * (1.0 - h) - 0.02;
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
uniform float uLevel, uWobble, uKick, uKickAge, uSnare, uDrop, uBass, uGrowl;
// Character of the track, see style.ts.
uniform float uGain, uSpike, uStep, uTwist, uRipple, uShock;
// The jump on prominent hits, from the springs in blob.ts.
uniform vec3 uScale;    // squash and stretch
uniform float uLift;    // upwards
uniform float uJelly;   // extra wobble while a jump rings out, 0..1
uniform vec4 uPointer;  // direction on the sphere, strength
uniform mat3 uRot;      // turned by hand, object to view space
uniform vec3 uFront;    // towards the viewer, in object space
uniform float uCalm;    // calms the surface while the icon or the loading ring shows
// Ferrofluid spikes (ferro.ts): direction in the drop's own space, height in radii.
uniform vec4 uSpikes[${SPIKES}];
uniform float uSpikeOn; // the tallest spike; 0 skips them all

out vec3 vPos;     // view space
out vec3 vNormal;  // view space
out vec3 vObj;     // the resting sphere; its front projection carries the artwork
out float vSpike;  // how far out on a spike, 0..1

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
  // Thorns: the crests of a finer noise, sharpened into points that shoot out on
  // snares, kicks and drops. 1 - |n| is never negative, so pow() is safe.
  float crest = 1.0 - abs(snoise(q * 4.5 + vec3(t * 0.8, t * 0.5, -t * 0.4)));
  float thorns = pow(crest, 6.0) * (0.02 + 0.2 * uSnare + 0.08 * uKick + 0.12 * uDrop + 0.1 * uGrowl * uBass) * uSpike;
  // After each kick a wave runs from the front of the drop round to the back.
  // Squares are written out: pow() of a negative base is undefined in GLSL, and
  // Mesa really returns NaN for it, which flattened the whole drop on Linux.
  float angle = acos(clamp(dot(p, uFront), -1.0, 1.0));
  float ahead = (angle - uKickAge * 5.0) * 1.8;
  float wave = exp(-ahead * ahead) * exp(-uKickAge * 2.8) * 0.09 * uShock;
  float near = distance(p, uPointer.xyz) * 2.2;
  float dent = -0.18 * uPointer.w * exp(-near * near);
  // Where ferrofluid spikes stand, they take over from the noise's own points, so
  // the cones read clean.
  float ferroOn = smoothstep(0.0, 0.15, uSpikeOn);
  spikes *= 1.0 - 0.8 * ferroOn;
  thorns *= 1.0 - 0.8 * ferroOn;
  // Calmer while the icon shows, so it stays readable.
  return clamp((lobes + sway + ripples + spikes + thorns + wave) * uGain + dent, -0.3, 0.5) * (1.0 - 0.6 * uCalm);
}

// The spikes: cones with hollow flanks and a sharp tip, as ferrofluid stands over a
// magnet. Wider at the base the taller they grow. Stepped tracks get sharper ones.
// Returns the height and, in yz, its slope along t1 and t2: worked out here rather
// than by sampling the neighbours, which would run the loop three times.
// The test is on uniforms only, so every vertex takes the same branch.
vec3 ferro(vec3 p, vec3 t1, vec3 t2) {
  if (uSpikeOn < 0.002) return vec3(0.0);
  float sharp = 2.0 + 1.5 * uStep;
  vec3 h = vec3(0.0);
  for (int i = 0; i < ${SPIKES}; i++) {
    vec4 s = uSpikes[i];
    float w = 0.1 + 0.55 * s.w;
    vec3 d = p - s.xyz;
    float len = length(d);
    float c = len / w;
    if (c < 1.0) {
      float k = pow(1.0 - c, sharp - 1.0);
      vec3 grad = -sharp * s.w * k * d / (max(len, 1e-4) * w);
      h += vec3(s.w * k * (1.0 - c), dot(grad, t1), dot(grad, t2));
    }
  }
  return h * (1.0 - 0.8 * uCalm);
}

void main() {
  vec3 p = position;
  // The surface is the sphere pushed out by h. Its normal tips against the slope of
  // h, taken from two neighbours a small step along the surface.
  vec3 t1 = normalize(cross(p, abs(p.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 t2 = cross(p, t1);
  const float e = 0.012;
  vec3 fe = ferro(p, t1, t2) * uMorph;
  float h0 = disp(p) * uMorph;
  float g1 = (disp(p + t1 * e) * uMorph - h0) / e + fe.y;
  float g2 = (disp(p + t2 * e) * uMorph - h0) / e + fe.z;
  float h = h0 + fe.x;
  vSpike = clamp(fe.x / 0.2, 0.0, 1.0);
  vec3 n = p * (1.0 + h) - g1 * t1 - g2 * t2;
  // Flattened into the static artwork while it morphs in; the normal scales the other way.
  float depth = mix(0.04, 1.0, uMorph);
  n = normalize(vec3(n.xy, n.z / depth));
  vec3 s = p * (1.0 + h);
  s.z *= depth;
  vPos = uRot * s * uScale + vec3(0.0, uLift, -uDist);
  vNormal = normalize(uRot * n / uScale);
  vObj = p;
  gl_Position = uProj * vec4(vPos, 1.0);
}
`;

export const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

in vec3 vPos;
in vec3 vNormal;
in vec3 vObj;
in float vSpike;

uniform sampler2D uArt;
uniform vec3 uAccent;
uniform float uTime, uMorph, uKick, uSnare, uDrop, uBass, uGrowl;
uniform float uHue;    // rim hue offset, radians
uniform float uIri;    // how much the rim hue drifts
uniform float uMetal;  // sharper, brighter highlights
uniform float uHeat;   // pulls the rim towards orange
uniform float uIcon;     // 0 pause, 1 play; between them one morphs into the other
uniform float uIconA;    // how much the icon shows
uniform float uBusy;     // loading: a short arc runs round the ring instead
uniform float uProgress; // 0..1 played, on the ring
uniform float uClock;    // s, wall clock

out vec4 outColor;

${ICON}

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
  vec2 uv = 0.5 + vec2(vObj.x, -vObj.y) * 0.48 - vec2(bend.x, -bend.y) * 0.5;
  vec2 split = n.xy * (0.001 + 0.003 * uKick + 0.002 * uSnare) * uMorph;
  // Turned sideways the projection smears; blur it into flowing colour instead.
  float blur = 4.0 * pow(1.0 - abs(vObj.z), 3.0) * uMorph;
  vec3 art = vec3(texture(uArt, uv + split, blur).r, texture(uArt, uv, blur).g, texture(uArt, uv - split, blur).b);
  float luminance = dot(art, vec3(0.2126, 0.7152, 0.0722));
  vec3 trace = mix(vec3(luminance), art, 0.22);
  // Preserve the flat artwork during entry; blackened metal takes over as it morphs.
  art = mix(art, vec3(0.035, 0.038, 0.042) + trace * 0.22, uMorph);

  vec3 light = normalize(vec3(-0.5, 0.7, 0.6));
  float spec = pow(max(dot(n, normalize(light + v)), 0.0), mix(40.0, 140.0, uMetal)) * mix(0.35, 0.8, uMetal);
  // The hue sways around the accent but never leaves it, so the drop stays in the
  // card's colours.
  vec3 rim = hueRotate(mix(vec3(0.72), uAccent, 0.16), uHue + uIri * (fres + 0.5 * sin(uTime * 0.3)));
  rim = mix(rim, vec3(1.0, 0.35, 0.1), uHeat * 0.6);
  // Oil-slick fringes: each channel cycles at its own phase across the edge, worn
  // over the accent, more for iridescent tracks.
  vec3 slick = 0.5 + 0.5 * cos(6.2831853 * (fres * 1.6 + vec3(0.0, 0.33, 0.67) + uTime * 0.05));
  rim = mix(rim, rim * 0.4 + slick * length(rim) * 0.75, 0.035 + 0.08 * uIri);
  // The fresnel per channel, red reaching in further than blue: a lens fringe.
  float nv = 1.0 - max(dot(n, v), 0.0);
  vec3 fresC = vec3(nv * nv * nv * mix(1.0, nv, -0.35), fres, nv * nv * nv * mix(1.0, nv, 0.35));
  // A thin, hot edge that flares on hits.
  float edge = fres * fres;

  // Out on a spike the liquid turns to ink, like ferrofluid: the artwork darkens and
  // the gloss takes over.
  vec3 col = art * mix(1.0, 0.45, fres * uMorph) * (1.0 - 0.6 * vSpike);
  col += rim * fresC * (0.3 + 0.35 * uKick + 0.15 * uDrop + 0.12 * uBass) * uMorph;
  col += mix(rim, vec3(1.0), 0.5) * edge * (0.15 + 0.45 * uKick + 0.25 * uDrop) * uMorph;
  col += spec * (1.0 + 0.8 * vSpike) * uMorph;
  // Gloss: a dark room lit by the accent from above, and one soft window. They stay
  // put while the surface turns under them, which is what makes a spin read.
  vec3 r = reflect(-v, n);
  vec3 env = mix(vec3(0.015), mix(vec3(0.5), uAccent * 0.5, 0.12), pow(smoothstep(-0.4, 1.0, r.y), 2.0));
  env += 0.5 * smoothstep(0.92, 0.985, dot(r, normalize(vec3(-0.5, 0.7, 0.5))));
  col += env * (0.1 + 0.5 * fres + 0.5 * vSpike) * uMorph;
  // The icon sits on a disc of frosted glass, painted onto the surface so it turns
  // with the drop: the artwork behind it blurred and dimmed, lit along its rim. A
  // ring round it shows how much has played, or runs while the track loads.
  // Skipped while nothing of it shows; the test is on uniforms only, so every
  // pixel takes the same branch and fwidth() inside it stays sound.
  if (max(uIconA, uBusy) > 0.002) {
    vec2 ip = vObj.xy;
    float front = smoothstep(0.35, 0.6, vObj.z) * uMorph;
    float show = max(uIconA, uBusy) * front;
    float disc = length(ip) - 0.36;
    float da = fwidth(disc);
    float inDisc = 1.0 - smoothstep(-da, da, disc);
    vec3 frost = textureLod(uArt, 0.5 + vec2(ip.x, -ip.y) * 0.48, 5.0).rgb * 0.3 + uAccent * 0.03;
    frost += 0.35 * (1.0 - smoothstep(0.0, 0.025, abs(disc + 0.01))) * smoothstep(-0.3, 0.35, ip.y);
    col = mix(col, frost, show * inDisc);

    float ringD = abs(length(ip) - 0.41) - 0.011;
    float ra = fwidth(ringD);
    float ring = (1.0 - smoothstep(-ra, ra, ringD)) * front;
    float turn = fract(atan(ip.x, ip.y) / 6.2831853 + 1.0); // 0 at the top, clockwise
    float played = 1.0 - smoothstep(uProgress - 0.003, uProgress + 0.003, turn);
    float seg = fract(turn - uClock * 0.9);
    float arc = smoothstep(0.0, 0.04, seg) * (1.0 - smoothstep(0.18, 0.28, seg));
    col = mix(col, mix(vec3(0.32), uAccent, played), ring * uIconA * (1.0 - uBusy));
    col = mix(col, mix(vec3(0.25), vec3(0.96), arc), ring * uBusy);

    float dIcon = sdPlayPause(ip, uIcon);
    float ia = fwidth(dIcon);
    float ink = 1.0 - smoothstep(-ia, ia, dIcon);
    col = mix(col, vec3(0.96), front * uIconA * (1.0 - uBusy) * ink);
  }
  // The very edge fades out, so the drop sits in the page instead of on it.
  float a = 1.0 - 0.9 * smoothstep(0.8, 1.0, fres) * uMorph;
  outColor = vec4(col * a, a);
}
`;
