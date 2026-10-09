/*! orbkit shaders — MIT License, Copyright (c) 2026 zzzzshawn. Permission is hereby granted, free of
 * charge, to any person obtaining a copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software,
 * and to permit persons to whom the Software is furnished to do so, subject to the following
 * conditions: The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT
 * WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
 * ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR
 * THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
/**
 * The orb families' shaders, ported from orbkit's MIT-licensed orbs
 * (https://github.com/zzzzshawn/orbkit, commit 5dbd641, MIT, Copyright (c) 2026 zzzzshawn; see
 * THIRD-PARTY-NOTICES.md). orbkit's other orbs are under non-commercial terms and are not here.
 * The renderer loads this module on demand: nothing in it runs until an orb family has to draw.
 *
 * Each family keeps orbkit's fragment, renamed `orbMain`, and its parameter and colour defaults.
 * {@link orbFragment} wraps it: the ball is scaled to fill its square (`fill` is the ball's
 * radius in orbkit's frame), and families with `finish` get Genex's sphere light, rim and
 * highlight over a dark glass body.
 */
import { coverHueDegrees, type CoverRecipe, type OrbFamily } from "./cover-recipe.ts";
import { channels, oklch, turnHue } from "./oklch.ts";

/** A shader parameter: uniform `uP_<key>`, its default, and whether it is a rate the clock integrates. */
type OrbParam = readonly [key: string, value: number, clock?: true];
/** A colour input: uniform `uC_<key>` and its default at hue slot 0. */
type OrbColor = readonly [key: string, hex: string];
type OrbShader = {
  /** The ball's radius in orbkit's frame; the wrapper scales it to touch the square's edge. */
  fill: number;
  /** Whether Genex's sphere light, rim and highlight go over it; Terminal, Bricks and Voxel stay as drawn. */
  finish: boolean;
  params: readonly OrbParam[];
  colors: readonly OrbColor[];
  source: string;
};

/** orbkit's shared GLSL: its uniforms, value noise, fbm, the centred UV and tanh. */
const ORB_PRELUDE = `uniform vec2 uRes;
uniform float uTime;   // slow ambient clock (half real-time)
uniform float uAnim;   // flow clock — its speed follows the output volume
uniform float uInput;  // input volume 0..1: user speech energy
uniform float uOutput; // output volume 0..1: agent speech energy

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(11.7, 7.3);
    a *= 0.5;
  }
  return v;
}
vec2 orbUV() { return (2.0 * gl_FragCoord.xy - uRes) / min(uRes.x, uRes.y); }

// GLSL ES 1.0 has no tanh() — it arrived in ES 3.0. Shader-golf listings lean
// on it as a tone-mapper, so it ships here. Clamped against exp() overflow;
// accurate for the non-negative accumulators those shaders produce.
vec3 tanh3(vec3 x) {
  x = clamp(x, -10.0, 10.0);
  vec3 e = exp(2.0 * x);
  return (e - 1.0) / (e + 1.0);
}

`;

/** Genex's wrapper: remaps the fragment so the ball fills the square, then lights it when asked. */
const ORB_FINISH = `
#undef gl_FragColor
#undef gl_FragCoord
uniform float u_fill;
uniform float u_finish;
uniform float u_turn;
uniform vec3 u_rim;
vec3 orbTurn(vec3 c, float a) {
  const mat3 toYiq = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
  const mat3 toRgb = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
  vec3 yiq = toYiq * c;
  float s = sin(a);
  float k = cos(a);
  yiq.yz = vec2(yiq.y * k - yiq.z * s, yiq.y * s + yiq.z * k);
  return clamp(toRgb * yiq, 0.0, 1.0);
}
void main() {
  vec2 c = gl_FragCoord.xy - uRes * 0.5;
  orbFrag = vec4(c * u_fill + uRes * 0.5, gl_FragCoord.zw);
  orbMain();
  vec4 o = orbOut;
  if (u_turn != 0.0) o.rgb = orbTurn(o.rgb, u_turn);
  if (u_finish < 0.5) {
    gl_FragColor = o;
    return;
  }
  vec2 q = c / (uRes * 0.5);
  float r = length(q);
  if (r >= 1.0) {
    gl_FragColor = vec4(0.0);
    return;
  }
  float edge = 1.0 - smoothstep(1.0 - 3.2 / uRes.x, 1.0, r);
  vec3 n = vec3(q, sqrt(max(1.0 - r * r, 0.0)));
  vec3 L = normalize(vec3(-0.55, 0.62, 0.75));
  float lit = smoothstep(-0.35, 0.95, dot(n, L));
  vec3 col = o.rgb + u_rim * 0.07 * (1.0 - o.a);
  col *= 0.32 + 0.85 * lit;
  col += u_rim * pow(1.0 - n.z, 2.0) * (0.22 + 0.78 * lit) * 0.7;
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  col += vec3(pow(max(dot(n, H), 0.0), 36.0) * 0.26);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), edge);
}
`;

const ORB_SHADERS: Record<OrbFamily, OrbShader> = {
  /** orbkit SHDR-11. */
  orbital: {
    fill: 0.83,
    finish: true,
    params: [
      ["speed", 0.9, true],
      ["rotSpeed", 0.5],
      ["radius", 0.9],
      ["swell", 0.07],
      ["posScale", 0.5],
      ["flowSpeed", 0.35, true],
      ["flowAmp", 0.45],
      ["flowScale", 0.3],
      ["precess", 0.3],
      ["radialPow", 0.5],
      ["radialDecay", 1],
      ["probPow", 0.4],
      ["probGain", 3],
      ["waveFreq", 4],
      ["chromaSpread", 0.18],
      ["glow", 0.9],
      ["metalDark", 0],
      ["baseVis", 0.12],
    ],
    colors: [],
    source: `
const float PI = 3.14159265359;
void orbMain() {
  vec2 uv = orbUV();
  float r2d = length(uv);
  float R = uP_radius + uP_swell * uInput;
  float mask = smoothstep(0.012, -0.012, r2d - R);
  float nr = clamp(r2d / max(R, 0.001), 0.0, 1.0);
  float z = sqrt(max(1.0 - nr * nr, 0.0));

  // uP_speed and uP_flowSpeed arrive pre-integrated as clocks (see
  // OrbParamDef.integrate), so state transitions stay phase-continuous.
  // The state volumes reshape the orbital itself: the params set the base,
  // input/output excitement bends zoom, radial form, probability and chroma,
  // so each state settles into a different interference pattern.
  float posScale = uP_posScale * (0.8 + 0.45 * uOutput + 0.2 * uInput);
  float radialPow = uP_radialPow * (0.7 + 0.8 * uOutput);
  float radialDecay = uP_radialDecay * (1.25 - 0.5 * uOutput);
  float probPow = uP_probPow * (1.3 - 0.55 * uOutput);
  float probGain = uP_probGain * (0.7 + 0.6 * uOutput + 0.5 * uInput);
  float waveFreq = uP_waveFreq * (0.6 + 1.0 * uOutput);
  float chromaSpread = uP_chromaSpread * (0.6 + 0.9 * uOutput + 0.5 * uInput);

  // dome point rotated around Y — the fake 3D of the flat disc
  float animTime = uP_speed; // integrated clock
  float cosT = cos(animTime * uP_rotSpeed);
  float sinT = sin(animTime * uP_rotSpeed);
  vec3 sp = vec3(uv / max(R, 0.001), z) * posScale;
  vec3 pos = vec3(sp.x * cosT - sp.z * sinT, sp.y, sp.x * sinT + sp.z * cosT);

  // precession: the rotation axis itself drifts, so the pattern never
  // settles into a repeating spin
  float tilt = sin(animTime * 0.21 + 1.7) * uP_precess;
  float cx = cos(tilt), sx = sin(tilt);
  pos = vec3(pos.x, pos.y * cx - pos.z * sx, pos.y * sx + pos.z * cx);

  // liquid flow: drifting fbm warps the 3D domain, so the wave function
  // smears and migrates around the sphere instead of wobbling in place.
  // (sampled on pos components — continuous everywhere, no phi seam)
  float flowT = uP_flowSpeed; // integrated clock
  float fAmp = uP_flowAmp * (0.7 + 0.6 * uOutput + 0.4 * uInput);
  vec3 w;
  w.x = fbm(pos.yz * uP_flowScale + vec2(flowT * 0.70, -flowT * 0.40));
  w.y = fbm(pos.zx * uP_flowScale + vec2(-flowT * 0.55, flowT * 0.62) + 3.7);
  w.z = fbm(pos.xy * uP_flowScale + vec2(flowT * 0.50, flowT * 0.85) + 7.1);
  pos += (w - 0.5) * fAmp;

  float r = length(pos) + 0.001;
  float theta = acos(clamp(pos.y / r, -1.0, 1.0));
  float phi = atan(pos.z, pos.x);

  float a0 = 0.5;
  float rho = 2.0 * r / (5.0 * a0);
  float radial = pow(rho, radialPow) * exp(-rho / radialDecay);
  float angular = pow(sin(theta), 3.0) * cos(phi + animTime * 0.2); // single lobe

  float psi = radial * angular;
  float probability = psi * psi;

  // travelling spiral wave — the modulation moves across the surface instead
  // of pulsing in place. The azimuthal harmonic count must be a whole number,
  // else sin(phi * f) doesn't line up across the +/-PI wrap and leaves a
  // vertical meridian seam. Snap it to the nearest integer.
  float waveN = max(1.0, floor(waveFreq + 0.5));
  float wavePhase = phi * waveN + theta * 2.5 - animTime * 2.0;
  probability *= (0.85 + 0.15 * sin(wavePhase));

  // drifting bright patches, like convection cells wandering the surface
  float patches = fbm(pos.xy * 1.6 + vec2(flowT * 0.4, -flowT * 0.3));
  probability *= 0.65 + 0.7 * patches;

  probability = pow(probability, probPow) * probGain;
  probability = clamp(probability, 0.0, 1.0);

  float fresnel = pow(1.0 - z, 1.5);

  // rainbow chromatic aberration
  float chromaOffset = phi * 2.0 + theta * 1.5 + animTime * 0.3 + probability * 3.0;
  vec3 rainbow;
  rainbow.r = sin(chromaOffset) * 0.5 + 0.5;
  rainbow.g = sin(chromaOffset + chromaSpread) * 0.5 + 0.5;
  rainbow.b = sin(chromaOffset + chromaSpread * 2.0) * 0.5 + 0.5;
  rainbow = normalize(rainbow + 0.01) * length(rainbow);

  float bandFreq = chromaOffset * 3.0 + fresnel * 2.4;
  vec3 chromaticBands;
  chromaticBands.r = sin(bandFreq) * 0.5 + 0.5;
  chromaticBands.g = sin(bandFreq + 2.094) * 0.5 + 0.5;
  chromaticBands.b = sin(bandFreq + 4.189) * 0.5 + 0.5;

  vec3 glowColor = mix(rainbow, chromaticBands, 0.12);
  glowColor = pow(glowColor, vec3(0.8));

  vec3 darkMetal = vec3(uP_metalDark);
  vec3 lightMetal = mix(vec3(0.9, 0.92, 0.95), glowColor, 0.7);

  float metalGradient = smoothstep(0.0, 1.0, probability * 0.7 + fresnel * 0.3);
  vec3 metalColor = mix(darkMetal, lightMetal, metalGradient);

  float orbGlow = uP_glow + 0.6 * uOutput;
  float totalGlow = (0.25 + fresnel * 0.6 + probability * 0.8) * orbGlow;
  float glowAmount = clamp(pow(totalGlow, 0.7), 0.0, 1.0);

  vec3 surfaceColor = mix(metalColor, glowColor, glowAmount);

  vec3 normal = vec3(uv / max(R, 0.001), z);
  float specular = pow(max(dot(normal, normalize(vec3(1.0, 1.0, 2.0))), 0.0), 32.0);
  surfaceColor += mix(vec3(1.0), glowColor, 0.6) * specular * 0.4;

  float visibility = clamp(probability * 1.2 + fresnel * 0.3 + uP_baseVis + uInput * 0.15, 0.0, 1.0);

  float a = mask * visibility;
  gl_FragColor = vec4(surfaceColor * a, a);
}
`,
  },
  /** orbkit SHDR-12. */
  bricks: {
    fill: 0.938,
    finish: false,
    params: [
      ["spin", 0.25, true],
      ["tilt", 0.55],
      ["rebuild", 0.4, true],
      ["gap", 0.07],
      ["studs", 18],
      ["radius", 0.95],
      ["patch", 0.35],
      ["stud", 0.85],
      ["seam", 0.6],
      ["gloss", 1],
      ["light", 1],
      ["gain", 1],
      ["contrast", 1],
    ],
    colors: [
      ["brickA", "#c4281c"],
      ["brickB", "#f2cd37"],
      ["brickC", "#1e5aa8"],
      ["brickD", "#00852b"],
      ["brickE", "#f4f4f4"],
    ],
    source: `
#define STEPS 96

// Per-fragment constants, resolved once in main().
vec3 lgCell;  // cell sizes: (stud pitch, brick height, stud pitch)
float lgGap;

// Brick-lookup results (GLSL ES 1.0 has no out-struct ergonomics).
vec3 lgBid;     // unique id of the owning brick
float lgOff;    // long-axis stagger offset of its course, in studs
float lgOrient; // 0: long axis runs along x, 1: along z

mat2 lgRot(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}

/*
  Which 2x4 brick owns this stud cell? Layers alternate their long axis
  and every (layer, row) course staggers by a hashed offset — brickwork
  bonding, so vertical seams never stack.
*/
void lgBrick(vec3 cellIdx) {
  lgOrient = mod(cellIdx.y, 2.0);
  float lc = lgOrient < 0.5 ? cellIdx.x : cellIdx.z;
  float sc = lgOrient < 0.5 ? cellIdx.z : cellIdx.x;
  float srow = floor(sc / 2.0);
  lgOff = floor(hash(vec2(cellIdx.y * 3.17, srow * 7.31)) * 4.0);
  lgBid = vec3(floor((lc + lgOff) / 4.0), cellIdx.y, srow + lgOrient * 913.0);
}

/*
  The world function: inside the ball, minus bricks currently blinked out
  of the outer two courses. Interior cells answer with a single length —
  the brick lookup only runs in the shell.
*/
float lgSolid(vec3 cc) {
  float r = length(cc);
  if (r >= 1.0) return 0.0;
  if (r > 1.0 - 2.2 * lgCell.y) {
    lgBrick(floor(cc / lgCell));
    float blink = fract(hash(lgBid.xy * 0.173 + lgBid.z * 0.089) + uP_rebuild * 0.03);
    if (blink < lgGap) return 0.0; // this brick is off the build right now
  }
  return 1.0;
}

void orbMain() {
  // Volume coupling: agent output stokes the sheen and the gain; user
  // input brightens the key light.
  float glossNow = uP_gloss * (0.7 + 0.9 * uOutput);
  float gainNow = uP_gain * (0.92 + 0.25 * uOutput);
  float lightNow = uP_light * (1.0 + 0.3 * uInput);

  float pitch = 2.0 / clamp(uP_studs, 8.0, 48.0);
  lgCell = vec3(pitch, pitch * 1.2, pitch); // real brick proportion
  lgGap = clamp(uP_gap, 0.0, 0.9);

  float bound = 1.0 + length(lgCell) * 0.5 + 0.001;

  vec2 uv = orbUV() / uP_radius;
  vec3 ro = vec3(uv * bound, 2.6);
  vec3 rd = vec3(0.0, 0.0, -1.0);

  // rotate the RAY into object space (inverse tumble) — the lattice stays
  // axis-aligned and the studs stay up while the ball turns. Light and
  // view rotate along, keeping the sun fixed relative to the viewer.
  mat2 tiltM = lgRot(uP_tilt); // positive tilt looks DOWN at the studs
  mat2 spinM = lgRot(-uP_spin); // integrated clock
  ro.yz = tiltM * ro.yz;
  ro.xz = spinM * ro.xz;
  rd.yz = tiltM * rd.yz;
  rd.xz = spinM * rd.xz;
  vec3 Lo = normalize(vec3(-0.5, 0.7, 0.55));
  Lo.yz = tiltM * Lo.yz;
  Lo.xz = spinM * Lo.xz;
  vec3 Vo = vec3(0.0, 0.0, 1.0);
  Vo.yz = tiltM * Vo.yz;
  Vo.xz = spinM * Vo.xz;

  // DDA needs nonzero direction components — nudge, keep the sign
  vec3 sgn = vec3(
    rd.x >= 0.0 ? 1.0 : -1.0,
    rd.y >= 0.0 ? 1.0 : -1.0,
    rd.z >= 0.0 ? 1.0 : -1.0
  );
  rd = normalize(sgn * max(abs(rd), vec3(1.0e-4)));

  // analytic bounding sphere: empty pixels exit here
  float b = dot(rd, ro);
  float c = dot(ro, ro) - bound * bound;
  float disc = b * b - c;
  if (disc < 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }
  float sq = sqrt(disc);
  vec3 p0 = ro + rd * (-b - sq + pitch * 0.001);
  float tSpan = 2.0 * sq;

  // Amanatides & Woo, anisotropic cells: per-axis sizes throughout
  vec3 vp = floor(p0 / lgCell);
  vec3 tDelta = lgCell / abs(rd);
  vec3 tMax = ((vp + step(vec3(0.0), rd)) * lgCell - p0) / rd;

  float hitF = 0.0;
  vec3 mask = vec3(0.0, 0.0, 1.0); // first-voxel fallback: face the viewer
  float tCur = 0.0;

  for (int i = 0; i < STEPS; i++) {
    if (lgSolid((vp + 0.5) * lgCell) > 0.5) {
      hitF = 1.0;
      break;
    }
    if (tMax.x < tMax.y && tMax.x < tMax.z) {
      tCur = tMax.x;
      tMax.x += tDelta.x;
      vp.x += sgn.x;
      mask = vec3(1.0, 0.0, 0.0);
    } else if (tMax.y < tMax.z) {
      tCur = tMax.y;
      tMax.y += tDelta.y;
      vp.y += sgn.y;
      mask = vec3(0.0, 1.0, 0.0);
    } else {
      tCur = tMax.z;
      tMax.z += tDelta.z;
      vp.z += sgn.z;
      mask = vec3(0.0, 0.0, 1.0);
    }
    if (tCur > tSpan) break; // left the bound: miss
  }

  if (hitF < 0.5) {
    gl_FragColor = vec4(0.0);
    return;
  }

  // the hit cell, its brick, and the struck face
  vec3 cc = (vp + 0.5) * lgCell;
  float r = length(cc);
  vec3 dir = cc / max(r, 1.0e-4);
  lgBrick(vp);
  vec3 n = -mask * sgn;
  vec3 hp = p0 + rd * tCur;

  /*
    Brick colour: a per-brick hash picks one of the five plastic colours.
    The patch parameter slides the pick toward a smooth field over the
    sphere, so 0 is per-brick confetti and 1 is big moulded colour
    regions; the field is range-stretched so all five colours appear.
  */
  float cph = hash(lgBid.xy * 1.37 + lgBid.z * 0.91);
  float rn = noise(dir.xy * 2.6 + 7.0) * 0.5 + noise(dir.yz * 2.6 + 13.0) * 0.5;
  rn = clamp(0.5 + (rn - 0.5) * 2.2, 0.0, 0.999);
  float idx = floor(clamp(mix(cph, rn, clamp(uP_patch, 0.0, 1.0)), 0.0, 0.999) * 5.0);
  vec3 albedo = idx < 0.5 ? uC_brickA
    : (idx < 1.5 ? uC_brickB
    : (idx < 2.5 ? uC_brickC
    : (idx < 3.5 ? uC_brickD : uC_brickE)));
  albedo *= 0.93 + 0.14 * hash(lgBid.xy * 0.53 + lgBid.z * 1.7); // mold variance

  /*
    Seams: distance to the nearest BRICK boundary along each lattice axis,
    from the continuous within-brick coordinates. Only the two axes
    tangent to the struck face draw — stud grid lines never do.
  */
  vec3 sp = hp / lgCell;
  float lcC = lgOrient < 0.5 ? sp.x : sp.z;
  float scC = lgOrient < 0.5 ? sp.z : sp.x;
  float u4 = fract((lcC + lgOff) / 4.0);
  float v2 = fract(scC / 2.0);
  float wY = fract(sp.y);
  float dL = min(u4, 1.0 - u4) * 4.0 * pitch;
  float dS = min(v2, 1.0 - v2) * 2.0 * pitch;
  float dY = min(wY, 1.0 - wY) * lgCell.y;
  float seamD;
  if (mask.y > 0.5) seamD = min(dL, dS);
  else if (mask.x > 0.5) seamD = min(dY, lgOrient < 0.5 ? dS : dL);
  else seamD = min(dY, lgOrient < 0.5 ? dL : dS);
  float seam = (1.0 - smoothstep(0.0, 0.07 * pitch, seamD)) * clamp(uP_seam, 0.0, 1.0);

  /*
    Studs, embossed the way the real brick photographs: the normal tilts
    hard around the stud shoulder so the light wraps it like a cylinder
    edge, the cap lifts, a contact shadow falls on the side facing away
    from the light, and a faint ring engraved into the cap stands in for
    the moulded logo.
  */
  vec3 nEff = n;
  float studF = 0.0;
  float shadowF = 0.0;
  float engrave = 0.0;
  float studAmt = clamp(uP_stud, 0.0, 1.0);
  if (mask.y > 0.5 && n.y > 0.5) {
    vec2 cuv = fract(hp.xz / pitch) - 0.5;
    float sd = length(cuv);
    float rim = smoothstep(0.14, 0.29, sd) * (1.0 - smoothstep(0.29, 0.335, sd));
    vec3 tiltN = normalize(vec3(cuv.x, 0.42, cuv.y));
    nEff = normalize(mix(n, tiltN, rim * studAmt));
    studF = 1.0 - smoothstep(0.285, 0.33, sd);
    vec2 lxz = normalize(Lo.xz + vec2(1.0e-5));
    float away = clamp(dot(normalize(cuv + vec2(1.0e-5)), -lxz), 0.0, 1.0);
    shadowF = smoothstep(0.47, 0.335, sd) * (1.0 - studF) * (0.35 + 0.65 * away);
    engrave = smoothstep(0.11, 0.135, sd) * (1.0 - smoothstep(0.155, 0.18, sd)) * studF;
  }

  // plastic shading: lambert + wrap for roundness + white Blinn sheen,
  // dimmed toward the interior so revealed under-bricks read as inside
  float lam = clamp(dot(nEff, Lo), 0.0, 1.0);
  float wrap = clamp(dot(dir, Lo) * 0.5 + 0.5, 0.0, 1.0);
  float depthDim = mix(1.0, 0.55, clamp((1.0 - r) / (3.0 * lgCell.y), 0.0, 1.0));
  float shade = (0.34 + 0.42 * wrap * wrap + 0.8 * lam * lightNow) * depthDim;

  vec3 col = albedo * shade * (1.0 + 0.1 * studF);
  col *= 1.0 - shadowF * 0.38 * studAmt; // stud contact shadow
  col *= 1.0 - engrave * 0.14 * studAmt; // moulded logo ring

  // chamfered edge: a thin bright bevel line just inside the dark joint,
  // catching the light the way the real brick's edges do
  float bevel = smoothstep(0.05 * pitch, 0.085 * pitch, seamD)
    * (1.0 - smoothstep(0.085 * pitch, 0.16 * pitch, seamD));
  col += albedo * bevel * (0.18 + 0.5 * lam) * clamp(uP_seam, 0.0, 1.0);
  col *= 1.0 - seam * 0.8; // dark joints

  // two-lobe plastic sheen: a sharp hotspot over a broad soft gloss
  float ndh = clamp(dot(nEff, normalize(Lo + Vo)), 0.0, 1.0);
  float spec = pow(ndh, 48.0) + 0.22 * pow(ndh, 8.0);
  col += vec3(1.0) * spec * glossNow * (1.0 - seam) * depthDim;

  col *= gainNow;
  col = pow(max(col, 0.0), vec3(uP_contrast));

  // Surface-lit orb bounded by the hit test: alpha IS coverage, and a hit
  // is fully opaque — premultiplied output, trivially (see shdr-28).
  gl_FragColor = vec4(col, 1.0);
}
`,
  },
  /** orbkit SHDR-13. */
  plasma: {
    fill: 0.81,
    finish: true,
    params: [
      ["speed", 1, true],
      ["spin", 0.2, true],
      ["camDist", 7],
      ["focal", 2.25],
      ["envRadius", 2.6],
      ["swell", 0.15],
      ["tilt", 0.4],
      ["fils", 6],
      ["writhe", 0.9],
      ["writheFreq", 1.6],
      ["sharp", 4],
      ["soft", 0.06],
      ["whiten", 0.008],
      ["coreGain", 1.6],
      ["tipGain", 1.8],
      ["fill", 0.02],
      ["stepClamp", 40],
      ["scatter", 0.012],
      ["exposure", 11],
      ["contrast", 1],
      ["saturation", 1.2],
      ["alphaGain", 2.5],
      ["edge", 1],
    ],
    colors: [
      ["inner", "#ff70d8"],
      ["arc", "#5a5cff"],
      ["tint", "#ffffff"],
    ],
    source: `
#define STEPS 64

// Volume-reactive values, resolved once per fragment in main().
float ionSharp;
float ionWrithe;
float ionCore;
float ionExposure;
float ionRadius;

mat2 ionRot2(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}

vec3 ionRender(vec2 fragCoord) {
  float t = uP_speed;      // integrated clock: filament crawl
  float spinAng = uP_spin; // integrated clock: array precession

  vec2 uv = (2.0 * fragCoord - uRes) / min(uRes.x, uRes.y);
  vec3 ro = vec3(0.0, 0.0, uP_camDist);
  vec3 rd = normalize(vec3(uv, -uP_focal));

  // exact ray/sphere chord — the march never leaves the globe, so no
  // envelope fade is needed and every step length is meaningful
  float proj = dot(-ro, rd);
  float b2 = dot(ro, ro) - proj * proj;
  float half_ = sqrt(max(ionRadius * ionRadius - b2, 0.0));
  float zNear = proj - half_;
  float stepLen = 2.0 * half_ / float(STEPS);
  // per-pixel jitter of the march start: a filament grazed at a shallow
  // angle is crossed periodically by the fixed step grid and renders as a
  // dotted chain — the jitter decorrelates neighbouring rays and melts the
  // dots into plasma grain
  zNear += (hash(fragCoord) - 0.5) * stepLen;

  vec3 acc = vec3(0.0);
  float T = 1.0;

  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * (zNear + (float(i) + 0.5) * stepLen);

    // precess the whole filament array; a static tilt keeps the spin axis
    // off-vertical so the motion reads in 3D
    vec3 pr = p;
    pr.xz = ionRot2(spinAng) * pr.xz;
    pr.yz = ionRot2(uP_tilt) * pr.yz;

    float r = length(pr);
    vec3 dir = pr / max(r, 1e-4);
    float rr = r / max(ionRadius, 1e-3);

    // writhe: bend the sampling direction with radius and time, rooted at
    // the nucleus by the smoothstep so filaments stay attached
    float wr = ionWrithe * smoothstep(0.0, ionRadius * 0.35, r);
    vec3 q = dir * uP_fils;
    q += wr * vec3(
      sin(r * uP_writheFreq        - t * 1.2 + q.y * 1.8),
      sin(r * uP_writheFreq * 0.83 + t * 1.0 + q.z * 1.8),
      sin(r * uP_writheFreq * 1.19 - t * 0.7 + q.x * 1.8));

    // two independent fields over the direction sphere; their joint zero
    // set is the filament curves. Time enters as additive phase only.
    float f1 = sin(q.x + t * 0.70)
             + sin(q.y * 1.31 - t * 0.50)
             + sin(q.z * 1.13 + t * 0.90);
    float f2 = sin(q.y * 1.21 + t * 0.60 + 1.7)
             + sin(q.z * 1.43 - t * 0.80 + 3.1)
             + sin(q.x * 0.87 + t * 0.40 + 5.0);
    float d2 = f1 * f1 + f2 * f2;
    float g = 1.0 / (d2 * ionSharp + uP_soft);

    // flare where a streamer lands on the glass, and the hot nucleus
    g *= 1.0 + uP_tipGain * smoothstep(0.55, 0.95, rr);
    float core = ionCore / (r * r * 8.0 + 0.05);

    // pink near the nucleus, violet-blue at the glass, cores whitened by
    // their own intensity
    vec3 fCol = mix(uC_inner, uC_arc, smoothstep(0.1, 0.75, rr));
    vec3 w = (fCol + vec3(uP_whiten) * g) * g + uC_inner * core + vec3(uP_fill);
    w = min(w, vec3(uP_stepClamp));
    w *= stepLen; // length-fair: limb chords are short and dim correctly

    acc += T * w;
    T *= exp(-dot(w, vec3(0.299, 0.587, 0.114)) * uP_scatter);
    if (T < 0.004) break;
  }

  return acc;
}

void orbMain() {
  // Louder agent output softens and thickens the arcs and quickens the
  // writhe; user input flares the nucleus — the globe answers being spoken
  // to the way the real toy answers a fingertip.
  ionSharp = uP_sharp * (1.0 - 0.25 * uOutput);
  ionWrithe = uP_writhe * (1.0 + 0.6 * uOutput);
  ionCore = uP_coreGain * (1.0 + 1.6 * uInput + 0.4 * uOutput);
  ionExposure = uP_exposure * (1.0 - 0.35 * uOutput);
  ionRadius = uP_envRadius + uP_swell * uInput;

  vec3 acc = ionRender(gl_FragCoord.xy);

  // tanh tone map with a tunable knee, then the usual finishing chain
  vec3 col = tanh3(acc / max(ionExposure, 0.01));
  col = pow(clamp(col, 0.0, 1.0), vec3(uP_contrast));

  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum), col, uP_saturation);
  col *= uC_tint;

  // alpha from the brightest channel — a saturated violet streamer has low
  // luminance but must not go transparent
  float peak = max(col.r, max(col.g, col.b));
  float a = clamp(peak * uP_alphaGain, 0.0, 1.0);

  // analytic silhouette, identical construction to shdr-01: exact
  // ray-to-centre distance against the radius, colour AND alpha
  vec3 mrd = normalize(vec3(orbUV(), -uP_focal));
  float closest = length(cross(vec3(0.0, 0.0, uP_camDist), mrd));
  float band = mix(0.35, 0.012, clamp(uP_edge, 0.0, 1.0));
  float mask = 1.0 - smoothstep(ionRadius * (1.0 - band), ionRadius * 1.005, closest);
  col *= mask;
  a *= mask;

  // Emitted light, so rgb is already premultiplied — do NOT scale by alpha
  // again (see the same note in shdr-31).
  gl_FragColor = vec4(col, a);
}
`,
  },
  /** orbkit SHDR-14. */
  pixel: {
    fill: 0.9,
    finish: true,
    params: [
      ["speed", 0.5, true],
      ["spin", 0.15, true],
      ["radius", 0.9],
      ["cells", 140],
      ["levels", 3],
      ["scale", 1.5],
      ["plasma", 0.9],
      ["light", 0.9],
      ["rim", 0.35],
      ["gain", 1],
      ["contrast", 1.1],
    ],
    colors: [
      ["ink", "#101426"],
      ["paper", "#cfe6ff"],
    ],
    source: `
// 2x2 Bayer base: floor/fract only. (0,0)=0, (1,0)=.5, (0,1)=.75, (1,1)=.25
// — the 0,2,3,1 ordering over 4.
float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x / 2.0 + a.y * a.y * 0.75);
}

// 8x8 by recursion: M8 = M2(a/4)/16 + M2(a/2)/4 + M2(a). No arrays, no
// bitwise — neither exists in GLSL ES 1.0.
float bayer8(vec2 a) {
  return bayer2(a * 0.25) * 0.0625 + bayer2(a * 0.5) * 0.25 + bayer2(a);
}

void orbMain() {
  // Volume coupling: user input deepens the waves, agent output brightens
  // the whole tone ladder — the dot field visibly blooms while it speaks.
  float plasmaAmt = uP_plasma * (1.0 + 0.4 * uInput);
  float gainNow = uP_gain * (0.85 + 0.5 * uOutput);

  /*
    Chunky pixel grid, RESOLUTION-RELATIVE: uP_cells is how many cells span
    the canvas, so a 190px gallery card and a 420px playground orb show the
    same composition — the same wave resolved by the same number of dots.
    Sized in device pixels instead, small canvases collapse to a few dozen
    blotches. All content below samples at the cell centre so every dot is
    one flat square.
  */
  float cellPx = max(min(uRes.x, uRes.y) / max(uP_cells, 8.0), 1.0);
  vec2 pix = floor(gl_FragCoord.xy / cellPx);
  vec2 cellCentre = (pix + 0.5) * cellPx;

  vec2 suv = (2.0 * cellCentre - uRes) / min(uRes.x, uRes.y);
  vec2 uv = suv / uP_radius;
  float r2 = dot(uv, uv);

  // blocky silhouette — cut on the cell grid, deliberately not smoothed
  float mask = 1.0 - step(1.0, r2);

  float z = sqrt(max(1.0 - r2, 0.0));
  vec3 n = vec3(uv, z);

  /*
    The plasma is evaluated in a ROTATING frame: the dome point spins about
    Y on its own integrated clock, so the wavefronts roll around the ball
    instead of sliding across a flat disc. The light stays screen-fixed —
    the form shading holds still while the pattern travels over it.
  */
  float rot = uP_spin; // integrated clock
  float cr = cos(rot);
  float sr = sin(rot);
  vec3 sp = vec3(n.x * cr - n.z * sr, n.y, n.x * sr + n.z * cr);

  float t = uP_speed; // integrated clock

  // the classic demoscene plasma: three interfering sine waves, each on its
  // own direction and rate
  float f = uP_scale;
  float v = sin(sp.x * f * 3.1 + t)
    + sin((sp.y * 0.85 + sp.z * 0.4) * f * 3.6 - t * 1.3)
    + sin((sp.x + sp.y + sp.z) * f * 2.2 + t * 0.7);

  // a ripple source orbiting the dome — expanding rings pushed through the
  // interference; the clock enters only as additive phase
  vec2 src = 0.55 * vec2(cos(t * 0.5), sin(t * 0.5));
  v += sin(length(uv - src) * f * 5.0 - t * 2.2);
  v *= 0.25; // four unit waves back to -1..1

  float lambert = clamp(dot(n, normalize(vec3(-0.45, 0.55, 0.7))), 0.0, 1.0);
  float fres = pow(1.0 - z, 2.0);

  // waves modulated by the dome shading, so the ball stays a ball under
  // the rolling pattern; everything collapses into one luminance
  float lum = (0.5 + 0.5 * v * plasmaAmt) * (0.3 + uP_light * lambert)
    + uP_rim * fres;
  lum = pow(clamp(lum * gainNow, 0.0, 1.0), uP_contrast);

  // ordered dither onto the tone ladder — levels 2 is the classic 1-bit
  // look, higher values keep the grain but add mid-tones
  float steps = max(uP_levels - 1.0, 1.0);
  float q = clamp(floor(lum * steps + bayer8(pix)) / steps, 0.0, 1.0);

  vec3 col = mix(uC_ink, uC_paper, q);

  // Surface-lit orb bounded by a mask: alpha IS coverage, so premultiply —
  // the opposite convention from the emissive orbs (see shdr-31).
  float a = mask;
  gl_FragColor = vec4(col * a, a);
}
`,
  },
  /** orbkit SHDR-16. */
  caustic: {
    fill: 0.895,
    finish: true,
    params: [
      ["flow", 0.9, true],
      ["spin", 0.08, true],
      ["swellRate", 0.6, true],
      ["radius", 0.9],
      ["scale", 9],
      ["warp", 0.8],
      ["edge", 2.2],
      ["split", 0.6],
      ["swell", 0.15],
      ["gain", 1.6],
      ["contrast", 1.1],
      ["light", 0.9],
      ["rim", 0.6],
    ],
    colors: [
      ["deep", "#0b2f6e"],
      ["sun", "#7ff6ff"],
      ["sheen", "#bfe8ff"],
    ],
    source: `
// Volume- and surge-reactive values, resolved once per fragment in main().
float causticWarp;

/*
  The water. The plane is folded on its own sines three times, each octave
  at a literal frequency and on its own share of the clock, so the ripples
  refract the net rather than scroll it. Amplitude is the one control.
*/
vec2 fold(vec2 p, float t) {
  p += causticWarp        * sin(p.yx * 1.31 + vec2( t * 0.90, -t * 0.70));
  p += causticWarp * 0.60 * sin(p.yx * 2.17 + vec2(-t * 1.30,  t * 1.10));
  p += causticWarp * 0.35 * sin(p.yx * 3.73 + vec2( t * 1.90,  t * 1.60));
  return p;
}

/*
  The light. Two crossed families of crest lines, sharpened by the edge
  exponent — the base is 1 - abs(sin), always in [0, 1], so pow is defined —
  with their product added back so the crossings, where wavefronts focus,
  burn hotter than the lines between them.
*/
float net(vec2 p, float t) {
  vec2 q = fold(p, t);
  vec2 s = 1.0 - abs(sin(q));
  vec2 l = pow(s, vec2(uP_edge));
  // Normalised to [0, 1]: the sum peaks at four on a crossing, and left
  // unbounded it drove the tone knee into clipping all three channels,
  // which turns any sun colour white. Bounded, the sun colour survives
  // the knee at the foci and gain is a real brightness rather than a
  // race to white.
  return (l.x + l.y + 2.0 * l.x * l.y) * 0.25;
}

/*
  Triplanar: the plane field read on the three axis planes of the surface
  direction and blended by the fourth power of each component, so each
  plane only shows where it faces squarely. No pole and no seam — the ball
  can turn forever.
*/
float netOn(vec3 sp, float t) {
  vec3 w = sp * sp;
  w *= w;
  w /= (w.x + w.y + w.z);
  float k = uP_scale;
  return w.x * net(sp.yz * k, t) + w.y * net(sp.zx * k, t) + w.z * net(sp.xy * k, t);
}

void orbMain() {
  vec2 uv = orbUV();
  float rd = length(uv);
  float R = uP_radius;
  float mask = smoothstep(0.012, -0.012, rd - R);
  if (mask <= 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  vec2 pl = uv / R;
  float z = sqrt(max(1.0 - dot(pl, pl), 0.0));
  vec3 n = vec3(pl, z);

  // the ball turns about Y on its own integrated clock
  float cr = cos(uP_spin);
  float sr = sin(uP_spin);
  vec3 sp = vec3(n.x * cr - n.z * sr, n.y, n.x * sr + n.z * cr);

  float t = uP_flow; // integrated clock: the water

  /*
    The surge: a round trip on an integrated clock through cos, so it eases
    through both ends and never wraps. It lifts the gain and deepens the
    ripple together — brighter as the water heaves — and uP_swell is how
    much of that a state takes.

    Volume coupling in the family language: the agent's voice brightens the
    light, the user's deepens the water.
  */
  float surge = 0.5 - 0.5 * cos(uP_swellRate);
  float gainNow = uP_gain * mix(1.0, 0.55 + 0.9 * surge, uP_swell) * (0.8 + 0.5 * uOutput);
  causticWarp = uP_warp * mix(1.0, 0.8 + 0.4 * surge, uP_swell) * (1.0 + 0.35 * uInput);

  /*
    Three moments of the fold, one per channel. The LIGHT is the net's
    luminance under the sun colour, so gold is gold at the foci; the
    per-channel disagreement is split off as a zero-mean residual and added
    back scaled by uP_split, so the rainbow is a fringe that rides on the
    edges where they move and vanishes where they hold — never a tint on
    the whole net. Read once with the offset baked in and once without
    would cost the same three evaluations, so the offset is constant and
    the split is a plain amplitude on the residual: safe to stage.
  */
  float ds = 0.09;
  vec3 c = vec3(netOn(sp, t + ds), netOn(sp, t), netOn(sp, t - ds));
  float cLum = dot(c, vec3(1.0 / 3.0));
  vec3 fringe = (c - cLum) * uP_split;

  float lambert = clamp(dot(n, normalize(vec3(-0.45, 0.55, 0.7))), 0.0, 1.0);
  float fres = pow(1.0 - z, 2.5);

  // the floor of the pool, then the light thrown on it — dimmer round the
  // limb, where the floor tilts away from the sun
  vec3 col = uC_deep * (0.35 + 0.65 * uP_light * lambert);
  col += (uC_sun * cLum + fringe) * gainNow * (0.55 + 0.45 * lambert);
  col += uC_sheen * uP_rim * fres;

  col = pow(max(col, vec3(0.0)), vec3(uP_contrast));
  col = tanh3(col);

  // Surface orb bounded by a mask: alpha IS coverage, so premultiply — the
  // opposite convention from the emissive orbs (see shdr-31).
  float a = mask;
  gl_FragColor = vec4(max(col, vec3(0.0)) * a, a);
}
`,
  },
  /** orbkit SHDR-17. */
  tempest: {
    fill: 0.895,
    finish: true,
    params: [
      ["speed", 0.9, true],
      ["spin", 0.12, true],
      ["radius", 0.9],
      ["scale", 2.4],
      ["bands", 6],
      ["shear", 1.1],
      ["warp", 2.2],
      ["churn", 1.4],
      ["gain", 1.15],
      ["contrast", 1.35],
      ["grain", 0.4],
      ["filmGrain", 0.35],
      ["grainSize", 2],
      ["rainbow", 0.65],
      ["flashRate", 1.6],
      ["flash", 1.2],
      ["light", 0.85],
      ["rim", 0.5],
    ],
    colors: [
      ["deep", "#2a0f4e"],
      ["low", "#0fd0c3"],
      ["mid", "#ff5e9d"],
      ["hot", "#ffd166"],
      ["flash", "#eaf4ff"],
    ],
    source: `
const float PI = 3.14159265359;

// Animated white noise, one tap per grain cell per grain frame. The seed
// decorrelates the two taps so field grain and film grain never line up.
float grainNoise(vec2 gpix, float frame, float seed) {
  return hash(gpix + vec2(frame * 13.71 + seed, frame * 7.37 - seed));
}

void orbMain() {
  // Volume coupling: user input churns the warp harder, agent output
  // brightens the field — the lightning gate opens separately below.
  float warpNow = uP_warp * (1.0 + 0.55 * uInput);
  float gainNow = uP_gain * (0.85 + 0.45 * uOutput);

  vec2 uv = orbUV();
  float rd = length(uv);
  float R = uP_radius;
  float mask = smoothstep(0.012, -0.012, rd - R);

  // The storm below costs five fbm evaluations per fragment — skip all of it
  // outside the silhouette instead of computing weather for transparent sky.
  if (mask <= 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  vec2 pl = uv / R;
  float r2 = dot(pl, pl);
  float z = sqrt(max(1.0 - r2, 0.0));
  vec3 n = vec3(pl, z);

  // roll the dome about Y on its own integrated clock
  float cr = cos(uP_spin);
  float sr = sin(uP_spin);
  vec3 sp = vec3(n.x * cr - n.z * sr, n.y, n.x * sr + n.z * cr);

  float t = uP_speed; // integrated clock

  // stereographic wrap: the weather travels around the ball and compresses
  // toward the limb instead of sliding across a flat disc
  vec2 st = sp.xy / (1.3 + sp.z) * uP_scale;

  /*
    Jovian band flow: a uniform stream plus a BOUNDED traveling wave of
    shear, so latitude rings appear to slip past each other. The obvious
    construction — t * sin(latitude) — accumulates the differential forever
    and rakes the field into hairline streaks within seconds of the random
    mount phase; the wave form keeps the shear amplitude fixed while its
    phase travels. sp.y is untouched by the Y-roll, so the bands hold
    horizontal while the dome turns underneath them.
  */
  st.x -= t * 0.3;
  st.x += uP_shear * sin(sp.y * uP_bands - t * 0.45);

  // two-level domain warp, the storm-cloud construction: q says where to
  // look, w says where q said to look, the field reads there
  vec2 q = vec2(
    fbm(st + vec2(0.0, t * 0.35)),
    fbm(st + vec2(5.2, 1.3) - vec2(t * 0.28, 0.0))
  );
  vec2 w = vec2(
    fbm(st + warpNow * q + vec2(1.7, 9.2) + vec2(t * 0.12, 0.0)),
    fbm(st + warpNow * q + vec2(8.3, 2.8) - vec2(0.0, t * 0.1))
  );
  float f = fbm(st + uP_churn * w);

  /*
    Grain tap 1: speckle folded into the FIELD itself, before the gradient,
    so the colour stops below dither into grain instead of smooth bands.
    Refreshed on the ambient clock — the flicker rate stays constant across
    states on purpose (see the header note).
  */
  vec2 gpix = floor(gl_FragCoord.xy / max(uP_grainSize, 1.0));
  float frame = floor(uTime * 48.0);
  float g1 = grainNoise(gpix, frame, 3.1);
  f += (g1 - 0.5) * uP_grain;

  f = pow(clamp(f * gainNow, 0.0, 1.0), uP_contrast);

  // four-stop palette climbing the storm field
  vec3 col = mix(uC_deep, uC_low, smoothstep(0.05, 0.35, f));
  col = mix(col, uC_mid, smoothstep(0.35, 0.62, f));
  col = mix(col, uC_hot, smoothstep(0.62, 0.88, f));

  // iridescent shimmer: a cosine rainbow keyed to the field AND to the warp
  // vector — q varies at storm-cell scale, so the rainbow lands as coherent
  // coloured weather cells instead of hue noise that optically averages to
  // grey — multiplied in so it bends hues without erasing the palette
  vec3 shimmer = 0.5 + 0.5 * cos(2.0 * PI * (f * 0.9 + q.x * 1.1 + t * 0.06 + vec3(0.0, 0.33, 0.67)));
  col = mix(col, col * (0.35 + 1.9 * shimmer), uP_rainbow);

  /*
    Lightning: one hashed gate per flash interval with an exponential decay,
    so most intervals stay dark and some strike. Agent output opens the gate
    — an idle orb flickers occasionally, a speaking one strobes. The strike
    lands hardest on the high-pressure cells of the field.
  */
  float ft = t * uP_flashRate;
  float gate = step(1.0 - (0.1 + 0.5 * uOutput), hash(vec2(floor(ft), 7.7)));
  float flashEnv = gate * exp(-fract(ft) * 6.0);
  // squared so the strike stays inside the storm cells — a linear weight
  // tints the whole ball and reads as the canvas strobing, not as weather
  float high = smoothstep(0.55, 0.95, f);
  col += uC_flash * (flashEnv * uP_flash) * (0.06 + 0.94 * high * high);

  // dome shading keeps the ball a ball under the weather
  float lambert = clamp(dot(n, normalize(vec3(-0.45, 0.55, 0.7))), 0.0, 1.0);
  col *= 0.35 + uP_light * lambert;
  float fres = pow(1.0 - z, 2.5);
  col += uC_flash * uP_rim * fres * (0.4 + 0.35 * flashEnv);

  // grain tap 2: plain film grain over the final colour
  float g2 = grainNoise(gpix, frame, 27.9);
  col *= 1.0 + (g2 - 0.5) * uP_filmGrain;

  // Surface orb bounded by a mask: alpha IS coverage, so premultiply — the
  // opposite convention from the emissive orbs (see shdr-31).
  float a = mask;
  gl_FragColor = vec4(max(col, vec3(0.0)) * a, a);
}
`,
  },
  /** orbkit SHDR-21. */
  nimbus: {
    fill: 0.8,
    finish: true,
    params: [
      ["speed", 10, true],
      ["camDist", 4.4],
      ["focal", 1.8],
      ["radius", 2],
      ["scale", 0.8],
      ["churn", 0.3],
      ["threshold", 0.075],
      ["edgeSoft", 0.8],
      ["density", 3.2],
      ["absorb", 1.4],
      ["shadowAbsorb", 2.4],
      ["shadowLift", 0.55],
      ["aniso", 0.45],
      ["lightSpin", 0.12],
      ["power", 1.9],
      ["ambient", 0.12],
      ["exposure", 1],
      ["alphaGain", 1.5],
    ],
    colors: [
      ["light", "#ffd7a3"],
      ["shadow", "#3a4a8c"],
    ],
    source: `
#define STEPS 56
#define LIGHT_STEPS 4
#define DENSITY_OCT 4
#define AA 1

const float PI = 3.14159265359;

// Volume-reactive values, resolved once per fragment in main().
float nimbusPower;
float nimbusDensity;

/*
  Density inside the sphere.

  The radial term falls to zero at the boundary, which both bounds the volume
  and gives the soft edge for free. The cos-warp folds the sample point a few
  times — the same cheap turbulence the other orbs use — and the threshold
  carves that into clumps rather than an even fog.
*/
float density(vec3 p, float animTime) {
  float shell = 1.0 - length(p) / uP_radius;
  if (shell <= 0.0) return 0.0;

  vec3 q = p * uP_scale;
  float f = 1.0;
  for (int k = 0; k < DENSITY_OCT; k++) {
    q += cos(q.yzx * f + animTime * uP_churn) / f;
    f *= 1.8;
  }

  float n = (sin(q.x) + sin(q.y) + sin(q.z)) / 3.0 * 0.5 + 0.5;
  // smoothstep against the threshold is the clump control: high threshold
  // leaves sparse wisps, low fills the sphere with even fog
  float clump = smoothstep(uP_threshold, 1.0, n);
  return clump * pow(shell, uP_edgeSoft) * nimbusDensity;
}

/*
  Henyey-Greenstein: g > 0 biases scattering forward, which is what gives the
  bloom on the limb facing the light.

  The physical form carries a 1/(4*PI) normalisation. It is dropped here and
  folded into uP_power instead — kept in, the whole term sits around 0.02 and
  the orb renders black unless power is pushed into the hundreds, which makes
  the slider useless.
*/
float phaseHG(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * c, 0.0001), 1.5);
}

vec4 nimbusRender(vec2 fragCoord) {
  float animTime = uP_speed; // integrated clock

  vec2 uv = (2.0 * fragCoord - uRes) / min(uRes.x, uRes.y);
  vec3 ro = vec3(0.0, 0.0, -uP_camDist);
  vec3 rd = normalize(vec3(uv, uP_focal));

  /*
    Light direction, slowly orbiting so the shading is never static.

    The z term is kept POSITIVE — the camera looks along +z, so a light also
    pointing along +z sits behind the cloud. That is the back-lit case, where
    dot(rd, L) approaches 1 and the forward-scattering phase blooms. Put the
    light on the camera's side instead and every ray samples the phase function
    on its back-scatter tail, where it is roughly ten times smaller, and the orb
    goes muddy.
  */
  vec3 L = normalize(vec3(
    cos(animTime * uP_lightSpin) * 0.7,
    0.45,
    sin(animTime * uP_lightSpin) * 0.35 + 0.65
  ));

  float phase = phaseHG(dot(rd, L), uP_aniso);

  // Start the march at the sphere's front face instead of the camera — every
  // step before that contributes nothing, and at 56 steps they are expensive.
  float toCentre = uP_camDist;
  float tStart = max(toCentre - uP_radius, 0.0);
  float span = 2.0 * uP_radius;
  float dt = span / float(STEPS);

  float T = 1.0;
  vec3 scattered = vec3(0.0);

  for (int i = 0; i < STEPS; i++) {
    float t = tStart + (float(i) + 0.5) * dt;
    vec3 p = ro + rd * t;

    float dn = density(p, animTime);
    if (dn > 0.001) {
      // short march toward the light for self-shadowing
      float shadow = 1.0;
      float lstep = uP_radius / float(LIGHT_STEPS);
      for (int k = 1; k <= LIGHT_STEPS; k++) {
        vec3 lp = p + L * (float(k) - 0.5) * lstep;
        shadow *= exp(-density(lp, animTime) * lstep * uP_shadowAbsorb);
      }

      /*
        In-scattered light: warm where lit, cool where the volume shadows
        itself.

        The shadow term appears ONCE, inside the mix. Multiplying by it again
        as a factor — the obvious-looking thing to write — scales the shadowed
        end of the mix toward zero, so the cool colour is always multiplied
        away and the cloud comes out monochrome beige however it is tinted.
        uP_shadowLift is how much light still reaches the shadowed side.
      */
      vec3 lit = mix(uC_shadow * uP_shadowLift, uC_light, shadow);
      scattered += T * dn * dt * lit * phase * nimbusPower;

      T *= exp(-dn * dt * uP_absorb);
      if (T < 0.01) break;
    }
  }

  // a soft ambient body so the unlit side is not pure black
  float body = 1.0 - T;
  scattered += uC_shadow * body * uP_ambient;

  return vec4(scattered, body);
}

void orbMain() {
  /*
    Agent output turns the light up; user input thickens the cloud. Both are
    AMPLITUDES. Churn is deliberately NOT volume-scaled: it multiplies the
    accumulated clock into a phase (animTime * churn), so scaling it by the
    live volume would turn every volume wobble into a phase jump the size of
    the whole clock — the cloud scrambles chaotically on each state change
    instead of gliding, and gets worse the longer the page is open.
  */
  nimbusPower = uP_power * (0.7 + 0.9 * uOutput);
  nimbusDensity = uP_density * (1.0 + 0.35 * uInput);

  vec4 acc = vec4(0.0);
#if AA > 1
  for (int mx = 0; mx < AA; mx++) {
    for (int my = 0; my < AA; my++) {
      vec2 offset = vec2(float(mx), float(my)) / float(AA) - 0.5;
      acc += nimbusRender(gl_FragCoord.xy + offset);
    }
  }
  acc /= float(AA * AA);
#else
  acc = nimbusRender(gl_FragCoord.xy);
#endif

  vec3 col = tanh3(acc.rgb * uP_exposure);
  float a = clamp(acc.a * uP_alphaGain, 0.0, 1.0);

  // Emitted/scattered light, so rgb is already premultiplied — do NOT multiply
  // by alpha again (see the same note in shdr-31).
  gl_FragColor = vec4(col, a);
}
`,
  },
  /** orbkit SHDR-23. */
  terminal: {
    fill: 0.927,
    finish: false,
    params: [
      ["drift", 0.55, true],
      ["scroll", 0.05, true],
      ["speed", 0.5, true],
      ["pulse", 0],
      ["spin", 0.12, true],
      ["radius", 0.9],
      ["cells", 40],
      ["scale", 1.6],
      ["density", 0.48],
      ["dropout", 0.48],
      ["light", 0.6],
      ["rim", 0.45],
      ["gain", 1],
      ["contrast", 1],
    ],
    colors: [
      ["glow", "#57ffc9"],
      ["deep", "#0b3b2d"],
    ],
    source: `
void orbMain() {
  // Volume coupling: user input densifies the glyphs, agent output turns
  // the phosphor up — the matrix visibly burns brighter while it speaks.
  float densBias = uP_density + 0.2 * uInput;
  float gainNow = uP_gain * (0.85 + 0.5 * uOutput);

  // resolution-relative glyph grid — same character count at every size
  float cellPx = max(min(uRes.x, uRes.y) / max(uP_cells, 8.0), 4.0);
  vec2 cellIdx = floor(gl_FragCoord.xy / cellPx);
  vec2 cellCentre = (cellIdx + 0.5) * cellPx;
  vec2 g = fract(gl_FragCoord.xy / cellPx); // 0..1 inside the cell

  vec2 suv = (2.0 * cellCentre - uRes) / min(uRes.x, uRes.y);
  vec2 uv = suv / uP_radius;
  float r2 = dot(uv, uv);

  // blocky silhouette, cut on the cell grid like the rest of the matrix
  float mask = 1.0 - step(1.0, r2);

  float z = sqrt(max(1.0 - r2, 0.0));
  vec3 n = vec3(uv, z);

  // rotating dome, stereographic projection — the weave compresses toward
  // the rim and rolls around the ball as the dome turns
  float rot = uP_spin; // integrated clock
  float cr = cos(rot);
  float sr = sin(rot);
  vec3 sp = vec3(n.x * cr - n.z * sr, n.y, n.x * sr + n.z * cr);
  vec2 p2 = sp.xy / (abs(sp.z) + 1.2) * uP_scale * 3.0;

  /*
    Three motions, one per state, each on its OWN integrated clock so a
    state change morphs the movement instead of jumping it:

      DRIFT   diagonal lava-flow streaming        (idle)
      SCROLL  vertical paging, terminal-style     (thinking)
      PULSE   radial waves radiating from centre  (speaking)

    The clocks are rates in the presets — a rate gliding to zero freezes
    that motion in place, phase intact. The pulse's amplitude is a separate
    non-integrated param, so idle carries no static rings.
  */
  float driftT = uP_drift;   // integrated clock: diagonal stream
  float scrollT = uP_scroll; // integrated clock: vertical paging
  float t = uP_speed;        // integrated clock: pulse phase
  vec2 flow = vec2(driftT * 0.6, -driftT * 0.45 - scrollT);

  float field = fbm(p2 + flow);
  float lambert = clamp(dot(n, normalize(vec3(-0.45, 0.55, 0.7))), 0.0, 1.0);
  float dens = clamp((field - 0.5) * 1.8 + densBias + 0.4 * uP_light * lambert
    + uP_pulse * 0.35 * sin(length(uv) * 5.5 - t * 2.4), 0.0, 1.0);

  /*
    The glyph: four dash rows split by three stripe gaps. Rows light from
    the bottom as density rises — the step() against the row index IS the
    ASCII quantizer, so a cell is always a whole character.
  */
  float rowI = floor(g.y * 4.0);
  float bar = step(0.22, fract(g.y * 4.0)) * step(fract(g.y * 4.0), 0.9);
  float stripe = step(0.18, fract(g.x * 3.0));
  float lit = step(rowI + 0.5, dens * 4.0 * gainNow);
  float glyph = bar * stripe * lit;

  /*
    Blocky dropouts: the same field, resampled on a 2x2 super-grid and
    thresholded. Because whole super-cells fail together, the dark zones
    become hard rectangular holes instead of dim characters.
  */
  vec2 superCentre = (floor(cellIdx / 2.0) * 2.0 + 1.0) * cellPx;
  vec2 sSuv = (2.0 * superCentre - uRes) / min(uRes.x, uRes.y);
  vec2 sUv2 = sSuv / uP_radius;
  float sz = sqrt(max(1.0 - dot(sUv2, sUv2), 0.0));
  vec3 ssp = vec3(sUv2.x * cr - sz * sr, sUv2.y, sUv2.x * sr + sz * cr);
  float superField = fbm(ssp.xy / (abs(ssp.z) + 1.2) * uP_scale * 3.0 + flow);
  float keep = step(uP_dropout, superField + 0.15 * uOutput);
  glyph *= keep;

  // phosphor ramp: deep green floor to hot glow, whitening at the top end
  vec3 glyphCol = mix(uC_deep, uC_glow, dens);
  glyphCol += vec3(0.7, 1.0, 0.9) * pow(dens, 3.0) * 0.35;

  // a dark body under the matrix plus a glow-coloured fresnel rim, so the
  // orb reads as a solid ball and not loose characters
  float fres = pow(1.0 - z, 2.2);
  vec3 col = uC_deep * 0.22 + glyphCol * glyph + uC_glow * fres * uP_rim;

  col = pow(max(col, 0.0), vec3(uP_contrast));

  // Surface-lit orb bounded by a mask: alpha IS coverage, so premultiply —
  // the opposite convention from the emissive orbs (see shdr-31).
  float a = mask;
  gl_FragColor = vec4(col * a, a);
}
`,
  },
  /** orbkit SHDR-24. */
  voxel: {
    fill: 0.896,
    finish: false,
    params: [
      ["spin", 0.22, true],
      ["tilt", 0.45],
      ["drift", 0.12, true],
      ["season", 0.3, true],
      ["shuffle", 0.8, true],
      ["radius", 1.15],
      ["blocks", 64],
      ["rough", 0.45],
      ["scale", 2.4],
      ["sea", 0.5],
      ["trees", 0.75],
      ["cave", 0.4],
      ["ore", 0.12],
      ["glow", 0.9],
      ["core", 0.5],
      ["texture", 0.6],
      ["light", 1],
      ["gain", 1],
      ["contrast", 1],
    ],
    colors: [
      ["grass", "#6abe30"],
      ["dirt", "#6f4a2f"],
      ["stone", "#8a8a90"],
      ["sand", "#dbcf9c"],
      ["water", "#2f66d0"],
      ["leaf", "#3e8f27"],
      ["ore", "#4de3ff"],
      ["lava", "#ff7b26"],
    ],
    source: `
#define STEPS 160

// Per-fragment state, resolved once in main() before the march.
vec3 ckDrift;
float ckVs;
float ckMaxH;
float ckSeaN;
// Climate weights (lush, desert, ice, mesa) plus the cherry grove — a
// partition of unity driven by the integrated season clock — and the tree
// density they imply.
vec4 ckClim;
float ckCherry;
float ckTreeMul;

// Tree-cell lookup results (GLSL ES 1.0 has no out-struct ergonomics).
vec3 ckTreeDir;
float ckTreeH1;
float ckTreeH2;

mat2 ckRot(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}

// Seam-free noise on the direction sphere: tri-planar sum of the prelude's
// 2D value noise, range-stretched (see the header) and clamped so the
// terrain bound stays a true bound.
float ckN3(vec3 p) {
  float v = (noise(p.xy) + noise(p.yz + 19.1) + noise(p.zx + 47.3)) / 3.0;
  return clamp(0.5 + (v - 0.5) * 1.9, 0.0, 1.0);
}

// The raw terrain field for a surface direction, 0..1. Two octaves only —
// the voxel grid quantizes away anything finer.
float ckField(vec3 dir) {
  vec3 q = dir * uP_scale + ckDrift;
  return ckN3(q) * 0.65 + ckN3(q * 2.6 + 31.7) * 0.35;
}

// Local terrain radius. Relief is strictly ADDITIVE above the unit sphere:
// oceans and plains sit exactly on it, mountains climb from the shoreline.
// Under the mesa climate the relief terraces into three-block steps —
// flat-topped buttes and benches, the badlands profile.
float ckTerrain(vec3 dir) {
  // the mesa amplifies its relief into big banded towers
  float h = 1.0 + uP_rough * max(ckField(dir) - ckSeaN, 0.0) * 1.2
    * (1.0 + ckClim.w * 0.8);
  float stepH = 3.0 * ckVs;
  float hq = 1.0 + floor((h - 1.0) / stepH) * stepH;
  return mix(h, hq, ckClim.w * 0.85);
}

// The continent-scale biome field: below 0.3 desert, above 0.58 forest,
// plains between. Drifts with the terrain so biomes move with their land.
float ckBiome(vec3 dir) {
  return ckN3(dir * 1.3 + ckDrift + 57.9);
}

/*
  Which tree cell does this direction fall in? The direction is projected
  onto its dominant cube face and quantized there — every voxel along a
  radial line lands in the same cell, which is what keeps a tree's trunk
  and canopy agreeing across grid levels. The anchor direction is rebuilt
  from the jittered cell centre.
*/
void ckTreeCell(vec3 dir) {
  vec3 ad = abs(dir);
  vec2 fuv;
  float face;
  if (ad.x >= ad.y && ad.x >= ad.z) {
    fuv = dir.yz / ad.x;
    face = dir.x > 0.0 ? 0.0 : 1.0;
  } else if (ad.y >= ad.z) {
    fuv = dir.xz / ad.y;
    face = dir.y > 0.0 ? 2.0 : 3.0;
  } else {
    fuv = dir.xy / ad.z;
    face = dir.z > 0.0 ? 4.0 : 5.0;
  }
  float grid = max(uP_blocks / 6.0, 2.0);
  vec2 cell = floor((fuv * 0.5 + 0.5) * grid);
  ckTreeH1 = hash(cell * 1.17 + face * 19.3);
  ckTreeH2 = hash(cell * 0.71 + face * 7.7 + 9.3);
  vec2 jit = vec2(hash(cell + 7.1 + face), hash(cell + 13.7 + face)) - 0.5;
  vec2 auv = ((cell + 0.5 + jit * 0.3) / grid) * 2.0 - 1.0;
  vec3 cp;
  if (face < 1.5) cp = vec3(face < 0.5 ? 1.0 : -1.0, auv.x, auv.y);
  else if (face < 3.5) cp = vec3(auv.x, face < 2.5 ? 1.0 : -1.0, auv.y);
  else cp = vec3(auv.x, auv.y, face < 4.5 ? 1.0 : -1.0);
  ckTreeDir = normalize(cp);
}

/*
  The world function: what fills this voxel?
    0 air   1 ground   2 trunk   3 leaves
  Ground is the terrain sphere; caves are carved ONLY where the ground has
  risen above the base sphere, so the smooth lowlands stay pristine. Water
  is not a voxel here — ocean surface blocks are painted as water in the
  material pass. Trees grow radially from dry anchors below the tree line,
  dense where the biome says forest.
*/
float ckVoxel(vec3 cc) {
  float r = length(cc);
  vec3 dir = cc / max(r, 1.0e-4);
  if (r < ckMaxH) {
    float h = ckTerrain(dir);
    if (r < h) {
      // carve caves into risen ground only — mountainsides get entrances,
      // the perfect lowland sphere keeps its silhouette
      if (h > 1.0 + 1.5 * ckVs) {
        float cv = ckN3(cc * (uP_scale * 1.9) + 71.3);
        float cw = uP_cave * 0.16 * smoothstep(ckMaxH, ckMaxH - 0.45, r);
        if (abs(cv - 0.5) < cw) return 0.0;
      }
      return 1.0;
    }
  }
  // trees live in a thin shell above the tallest terrain
  if (r < ckMaxH + 8.0 * ckVs && uP_trees > 0.001) {
    ckTreeCell(dir);
    float thrMax = clamp(uP_trees, 0.0, 1.0) * 0.8;
    if (ckTreeH1 > 1.0 - thrMax) {
      // forest density comes from the biome at the ANCHOR, so a whole
      // tree agrees with itself about existing
      float bioA = ckBiome(ckTreeDir);
      float dens = bioA > 0.58 ? 1.0 : (bioA > 0.3 ? 0.25 : 0.0);
      dens *= ckTreeMul; // forests thin out under desert, ice and mesa skies
      if (ckTreeH1 > 1.0 - thrMax * dens) {
        float fA = ckField(ckTreeDir);
        float ha = 1.0 + uP_rough * max(fA - ckSeaN, 0.0) * 1.2;
        // dry land only, below the stone tree line
        if (fA > ckSeaN + 0.015 && ha < 1.0 + uP_rough * 0.42) {
          float lat = length(cc - dot(cc, ckTreeDir) * ckTreeDir);
          if (ckClim.z > 0.5) {
            // ICE SPIKES: the lattice grows tapering packed-ice spires in
            // place of trees. Squaring the height hash makes many stubs
            // and a few tall spires, the ice-plains skyline.
            float spikeH = (2.0 + 6.0 * ckTreeH2 * ckTreeH2) * ckVs;
            float w = mix(1.15, 0.3, clamp((r - ha) / spikeH, 0.0, 1.0)) * ckVs;
            if (lat < w && r > ha - ckVs && r < ha + spikeH) return 3.0;
          } else if (ckClim.w > 0.5) {
            // CACTI: short green columns dotting the badlands flats
            float cacH = (1.5 + 2.0 * ckTreeH2) * ckVs;
            if (lat < 0.6 * ckVs && r > ha - ckVs && r < ha + cacH) return 3.0;
          } else if (ckCherry > 0.5) {
            // CHERRY GROVE: broad flat blossom puffs on short dark trunks —
            // the radial component of the canopy test is stretched, which
            // squashes the puff wide and flat like the cherry grove trees
            float trunkTop = ha + (2.0 + 1.5 * ckTreeH2) * ckVs;
            if (lat < 0.75 * ckVs && r > ha - ckVs && r < trunkTop) return 2.0;
            vec3 dd = cc - ckTreeDir * (trunkTop + 0.6 * ckVs);
            dd += ckTreeDir * dot(dd, ckTreeDir) * 0.8;
            vec3 lv = floor(cc / ckVs);
            float rag = hash(lv.xy * 0.61 + lv.z * 2.23);
            if (length(dd) < (2.2 + 0.5 * rag) * ckVs) return 3.0;
          } else {
            float trunkTop = ha + (2.5 + 2.0 * ckTreeH2) * ckVs;
            if (lat < 0.75 * ckVs && r > ha - ckVs && r < trunkTop) return 2.0;
            vec3 dd = cc - ckTreeDir * (trunkTop + 0.7 * ckVs);
            // canopy radius re-hashed per voxel — ragged blocky foliage
            vec3 lv = floor(cc / ckVs);
            float rag = hash(lv.xy * 0.61 + lv.z * 2.23);
            if (length(dd) < (1.7 + 0.5 * rag) * ckVs) return 3.0;
          }
        }
      }
    }
  }
  return 0.0;
}

void orbMain() {
  // Volume coupling: agent output stokes the glow, the gain and the molten
  // core; user input brightens the key light.
  float glowNow = uP_glow * (0.7 + 1.0 * uOutput);
  float gainNow = uP_gain * (0.9 + 0.3 * uOutput);
  float lightNow = uP_light * (1.0 + 0.3 * uInput);

  // the terrain field drifts on its own integrated clock — in the thinking
  // state it streams, and blocks pop in and out like chunks loading
  ckDrift = vec3(uP_drift * 0.31, uP_drift * 0.17, -uP_drift * 0.23);

  /*
    CLIMATE: the integrated season clock carries the planet through four
    worlds — lush, desert, ice, mesa — on a cycle. The triangular weights
    overlap so exactly two adjacent climates crossfade at any moment, and
    because the clock integrates, changing the season rate never snaps the
    phase: the world just weathers faster or slower.
  */
  // five worlds in crossfade order: lush, cherry, ice, mesa, desert —
  // blossom thaws into snow, terracotta dries into sand
  float t5 = fract(uP_season * 0.05) * 5.0;
  ckClim = vec4(
    clamp(1.0 - min(abs(t5), abs(t5 - 5.0)), 0.0, 1.0), // lush (wraps)
    clamp(1.0 - abs(t5 - 4.0), 0.0, 1.0),               // desert
    clamp(1.0 - abs(t5 - 2.0), 0.0, 1.0),               // ice
    clamp(1.0 - abs(t5 - 3.0), 0.0, 1.0)                // mesa
  );
  ckCherry = clamp(1.0 - abs(t5 - 1.0), 0.0, 1.0);      // cherry grove
  // ice and cherry run HIGH (dense spikes / dense groves); mesa keeps cacti
  ckTreeMul = dot(ckClim, vec4(1.0, 0.15, 0.9, 0.3)) + ckCherry * 0.9;

  ckVs = 2.0 / clamp(uP_blocks, 8.0, 96.0);   // voxel size, planet radius 1
  // sea level in FIELD space: 0.5 puts about half the sphere under water
  ckSeaN = 0.25 + clamp(uP_sea, 0.0, 1.0) * 0.5;
  // tallest possible terrain — sized for the mesa's amplified towers so
  // the viewport holds steady while the seasons turn
  ckMaxH = 1.0 + uP_rough * (1.0 - ckSeaN) * 1.2 * 1.8 + 0.001;
  float bound = ckMaxH + 8.5 * ckVs;          // ...plus the tree shell

  vec2 uv = orbUV() / uP_radius;

  // orthographic camera, viewport sized to the bound so the treetops fit
  vec3 ro = vec3(uv * bound, 2.9);
  vec3 rd = vec3(0.0, 0.0, -1.0);

  // rotate the RAY into object space (inverse tumble) — the grid stays
  // axis-aligned, the planet appears to spin. The light rotates along,
  // keeping the sun fixed relative to the viewer.
  mat2 tiltM = ckRot(uP_tilt); // positive tilt looks DOWN at the north pole
  mat2 spinM = ckRot(-uP_spin); // integrated clock
  ro.yz = tiltM * ro.yz;
  ro.xz = spinM * ro.xz;
  rd.yz = tiltM * rd.yz;
  rd.xz = spinM * rd.xz;
  vec3 Lo = normalize(vec3(-0.5, 0.7, 0.55));
  Lo.yz = tiltM * Lo.yz;
  Lo.xz = spinM * Lo.xz;

  // DDA needs nonzero direction components — nudge, keep the sign
  vec3 sgn = vec3(
    rd.x >= 0.0 ? 1.0 : -1.0,
    rd.y >= 0.0 ? 1.0 : -1.0,
    rd.z >= 0.0 ? 1.0 : -1.0
  );
  rd = normalize(sgn * max(abs(rd), vec3(1.0e-4)));

  // analytic bounding sphere: empty pixels exit here, and the march below
  // only ever walks the chord inside the bound
  float b = dot(rd, ro);
  float c = dot(ro, ro) - bound * bound;
  float disc = b * b - c;
  if (disc < 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }
  float sq = sqrt(disc);
  vec3 p0 = ro + rd * (-b - sq + ckVs * 0.001);
  float tSpan = 2.0 * sq;

  // Amanatides & Woo init: current voxel, per-axis distance to the next
  // grid plane, per-axis crossing stride
  vec3 vp = floor(p0 / ckVs);
  vec3 tDelta = ckVs / abs(rd);
  vec3 tMax = ((vp + step(vec3(0.0), rd)) * ckVs - p0) / rd;

  float mat = 0.0;
  vec3 mask = vec3(0.0, 0.0, 1.0); // first-voxel fallback: face the viewer
  float tCur = 0.0;

  for (int i = 0; i < STEPS; i++) {
    float m = ckVoxel((vp + 0.5) * ckVs);
    if (m > 0.5) {
      mat = m;
      break;
    }
    // step to the next voxel across the nearest grid plane
    if (tMax.x < tMax.y && tMax.x < tMax.z) {
      tCur = tMax.x;
      tMax.x += tDelta.x;
      vp.x += sgn.x;
      mask = vec3(1.0, 0.0, 0.0);
    } else if (tMax.y < tMax.z) {
      tCur = tMax.y;
      tMax.y += tDelta.y;
      vp.y += sgn.y;
      mask = vec3(0.0, 1.0, 0.0);
    } else {
      tCur = tMax.z;
      tMax.z += tDelta.z;
      vp.z += sgn.z;
      mask = vec3(0.0, 0.0, 1.0);
    }
    if (tCur > tSpan) break; // left the bound: miss
  }

  if (mat < 0.5) {
    gl_FragColor = vec4(0.0);
    return;
  }

  // the hit voxel, its radial "up", and the face that was struck
  vec3 cc = (vp + 0.5) * ckVs;
  float r = length(cc);
  vec3 dir = cc / max(r, 1.0e-4);
  vec3 n = -mask * sgn;
  vec3 hp = p0 + rd * tCur;

  // per-voxel hashes: core phase and material variety
  vec2 vseed = vec2(dot(vp, vec3(1.0, 57.0, 113.0)), dot(vp, vec3(27.0, 7.0, 91.0)));
  float h1 = hash(vseed * 0.013);
  float h2 = hash(vseed * 0.029 + 5.7);

  // block-texture grain: a 4x4 hash grid on the struck face
  vec2 uvFace;
  if (mask.x > 0.5) uvFace = hp.yz;
  else if (mask.y > 0.5) uvFace = hp.xz;
  else uvFace = hp.xy;
  float grain = hash(floor(fract(uvFace / ckVs) * 4.0) * 0.37 + vseed * 0.11);
  float texMul = mix(1.0, 0.72 + 0.55 * grain, uP_texture);

  // flat face lambert + radial wrap for roundness + crevice AO
  float lam = clamp(dot(n, Lo), 0.0, 1.0);
  float wrap = clamp(dot(dir, Lo) * 0.5 + 0.5, 0.0, 1.0);
  float ao = 0.55 + 0.45 * clamp(dot(n, dir) * 0.5 + 0.5, 0.0, 1.0);
  float shade = (0.32 + 0.5 * wrap * wrap + 0.85 * lam * lightNow) * ao;

  vec3 col;
  if (mat < 1.5) {
    float f = ckField(dir);
    float h = 1.0 + uP_rough * max(f - ckSeaN, 0.0) * 1.2;
    float depth = h - r;
    float topF = step(depth, ckVs * 1.15);

    /*
      The climate palette. Every material the strata paint with is a
      blend over the four climate weights: snow caps the ice world, the
      mesa runs banded terracotta hashed per RADIAL LAYER (the same band
      wraps the whole planet, the badlands look), desert bleaches the
      land to sand, and lush keeps the tunable colours.
    */
    vec3 snow = vec3(0.92, 0.95, 1.0);
    /*
      Mesa strata: two-block-tall bands hashed per radial layer, weighted
      the way real badlands run — long terracotta stretches broken by
      thin red, white, yellow and dark-brown accent stripes. The same
      band circles the whole planet at its height.
    */
    float layer = hash(vec2(floor(r / (ckVs * 2.0)) * 0.371, 5.3));
    vec3 mesaBand = layer < 0.5 ? vec3(0.74, 0.42, 0.21)
      : (layer < 0.68 ? vec3(0.63, 0.26, 0.15)
      : (layer < 0.8 ? vec3(0.88, 0.79, 0.67)
      : (layer < 0.9 ? vec3(0.84, 0.65, 0.27) : vec3(0.4, 0.25, 0.18))));
    // mesa tops: red-sand flats low down, banded rock on the risen buttes
    vec3 mesaTop = mix(vec3(0.72, 0.38, 0.2), mesaBand, step(1.0 + uP_rough * 0.1, h));
    vec3 climGrass = uC_grass * ckClim.x + uC_sand * ckClim.y
      + snow * ckClim.z + mesaTop * ckClim.w
      + mix(uC_grass, vec3(0.62, 0.85, 0.3), 0.6) * ckCherry; // vivid meadow
    vec3 climDirt = uC_dirt * (ckClim.x + ckClim.y + ckCherry)
      + uC_dirt * vec3(0.75, 0.85, 1.05) * ckClim.z + mesaBand * ckClim.w;
    vec3 climSand = uC_sand * (ckClim.x + ckClim.y + ckCherry)
      + mix(uC_sand, snow, 0.9) * ckClim.z + vec3(0.72, 0.35, 0.2) * ckClim.w;
    vec3 climWater = uC_water * (ckClim.x + ckClim.y + ckCherry)
      + vec3(0.62, 0.82, 0.92) * ckClim.z
      + mix(uC_water, vec3(0.42, 0.3, 0.22), 0.4) * ckClim.w;

    if (topF > 0.5 && f < ckSeaN) {
      // OCEAN: the surface of the perfect sphere painted as water —
      // lighter over coastal shallows, deep blue mid-ocean, with a sun
      // glint and a shimmer on the flow clock. The ice world stills the
      // shimmer and pales the depths: a frozen sheet.
      float deep = clamp((ckSeaN - f) / 0.12, 0.0, 1.0) * (1.0 - 0.55 * ckClim.z);
      vec3 wc = climWater * mix(1.3, 0.55, deep);
      float shim = 0.85 + 0.25 * sin(uAnim * 2.5 + grain * 6.2831 + dir.x * 4.0);
      shim = mix(shim, 1.02, ckClim.z);
      col = wc * (0.45 + 0.55 * wrap) * shim + wc * lam * 0.35;
    } else {
      /*
        LAND. Strata by radial depth below the local surface — grass or
        desert sand on the outward faces of surface blocks, mud with
        hashed stone patches beneath, then ore-seamed stone. Elevation
        overrides the biome: rising ground bares brown hillsides, peaks
        stand as naked stone, and every shore gets a sand band.
      */
      float dirtF = step(depth, ckVs * 2.4);
      float up = clamp(dot(n, dir), 0.0, 1.0);

      vec3 albedo = mix(uC_stone, climDirt, dirtF);
      // stone patches in the exposed mud, below the grass line
      albedo = mix(albedo, uC_stone, dirtF * (1.0 - topF) * step(h2, 0.3));

      float bio = ckBiome(dir);
      float desertF = step(bio, 0.3);
      albedo = mix(albedo, climGrass, topF * step(0.45, up) * (1.0 - desertF));
      albedo = mix(albedo, climSand, desertF * dirtF); // desert sand runs deep
      // elevation bands: brown hillsides, then bare stone peaks — both
      // buried under snow when the ice climate holds (frozen peaks stay
      // white with only crevice shadow, not brown or gray)
      albedo = mix(albedo, climDirt,
        topF * step(1.0 + uP_rough * 0.28, h) * 0.85 * (1.0 - 0.9 * ckClim.z));
      albedo = mix(albedo, uC_stone,
        topF * step(1.0 + uP_rough * 0.45, h) * (1.0 - 0.85 * ckClim.z));
      // beach: a narrow field-space band above the shoreline turns to sand
      albedo = mix(albedo, climSand, topF * step(abs(f - ckSeaN - 0.017), 0.018));

      // the coarse cluster cells serve ore veins AND glacier patches
      vec3 oc = floor(cc / (2.5 * ckVs));
      vec2 oseed = vec2(dot(oc, vec3(1.0, 57.0, 113.0)), dot(oc, vec3(27.0, 7.0, 91.0)));
      float fleck = step(0.5, hash(floor(fract(uvFace / ckVs) * 4.0) * 0.53 + oseed * 0.19));

      // ICE climate: packed-ice blue patches cluster over the risen
      // ground — glacier faces streaking the snowy mountainsides
      float icePatch = ckClim.z * step(hash(oseed * 0.023 + 9.1), 0.5)
        * step(1.0 + uP_rough * 0.06, h);
      albedo = mix(albedo, vec3(0.55, 0.7, 0.92), icePatch * (0.45 + 0.4 * fleck));

      /*
        Ore veins: a coarse cell grid hashes veins into the deep stone, so
        ore comes in multi-block clusters like the cross-section dioramas.
        Each vein rolls a type — diamond (the tunable ore colour), lapis
        (a deep-blue remap of it), or coal (unlit) — and each ore block is
        stone FLECKED with the hue on its texture grain, the way the
        actual ore tile is drawn. Only the flecks glow.
      */
      float veinF = (1.0 - dirtF) * step(1.0 - uP_ore, hash(oseed * 0.017)) * step(h1, 0.8);
      float oreType = hash(oseed * 0.041 + 2.9);
      vec3 oreHue = oreType < 0.4
        ? uC_ore
        : (oreType < 0.75 ? uC_ore * vec3(0.25, 0.45, 1.2) : vec3(0.16));
      float oreLit = oreType < 0.75 ? 1.0 : 0.0;
      albedo = mix(albedo, oreHue, veinF * (0.2 + 0.65 * fleck));
      float twinkle = 0.55 + 0.45 * sin(uP_shuffle + hash(oseed * 0.013) * 37.0); // integrated clock

      // depth below the surface darkens: cave interiors and cleft walls
      // sink into shadow, which makes the glow read as underground
      float depthDim = mix(1.0, 0.62, clamp(depth / max(uP_rough * 0.9, 0.05), 0.0, 1.0));

      // the deeper the rock, the closer to the molten core
      float coreR = 1.0 - uP_rough * 0.6;
      float coreF = uP_core * smoothstep(coreR + 0.15, coreR - 0.05, r);

      vec3 emis = oreHue * veinF * fleck * oreLit * glowNow * twinkle
        + uC_lava * coreF * (0.9 + 0.4 * sin(uP_shuffle * 1.6 + h1 * 51.0))
          * (0.6 + 1.4 * uOutput);

      col = albedo * shade * depthDim + emis;
    }
  } else if (mat < 2.5) {
    // trunk: dark wood, derived from the mud so the palette stays small
    col = uC_dirt * 0.5 * shade;
  } else {
    // leaves: heavier grain reads as foliage clumps. Under the ice climate
    // this material IS the spikes, so it turns packed-ice blue and the
    // grain smooths toward faceted ice.
    vec3 climLeaf = uC_leaf * (ckClim.x + ckClim.y * 0.9)
      + vec3(0.62, 0.76, 0.95) * ckClim.z
      + mix(uC_leaf, vec3(0.45, 0.62, 0.25), 0.5) * ckClim.w // cactus green
      + vec3(0.93, 0.7, 0.82) * ckCherry; // blossom pink
    col = climLeaf * shade;
    float leafGrain = mix(0.5 + 0.9 * grain, 0.85 + 0.3 * grain, ckClim.z);
    texMul = mix(1.0, leafGrain, uP_texture);
  }

  col *= texMul * gainNow;
  col = pow(max(col, 0.0), vec3(uP_contrast));

  // Surface-lit orb bounded by the hit test: alpha IS coverage, and a hit
  // is fully opaque — premultiplied output, trivially (see shdr-28).
  gl_FragColor = vec4(col, 1.0);
}
`,
  },
  /** orbkit SHDR-30. */
  meadow: {
    fill: 0.895,
    finish: true,
    params: [
      ["fall", 0.12, true],
      ["tilt", 0],
      ["drift", 0.2, true],
      ["radius", 0.9],
      ["scale", 4.5],
      ["bulge", 0.25],
      ["ratio", 1.8],
      ["horizon", 0.14],
      ["cloudScale", 1.6],
      ["cloudCover", 0.46],
      ["streakFreq", 5],
      ["streakRad", 0.5],
      ["water", 0.7],
      ["flowerScale", 44],
      ["flowerDensity", 0.55],
      ["flowerSize", 0.26],
      ["frameShade", 0.62],
      ["haze", 0.85],
      ["hazeRange", 0.09],
      ["gain", 1.05],
      ["contrast", 1.05],
      ["saturation", 1.1],
      ["light", 0.35],
      ["rim", 0.55],
    ],
    colors: [
      ["sky", "#4a92e0"],
      ["cloud", "#f7fbff"],
      ["canopy", "#12401f"],
      ["meadow", "#5aa63a"],
      ["water", "#156f6a"],
      ["bloom", "#ff6a3a"],
      ["sheen", "#cfe6ff"],
    ],
    source: `
#define AA 2

// Volume-reactive values, resolved once per fragment in main().
float drosteHaze;
float drosteCloud;
float drosteBloom;

/*
  Arc length around the unit square, in [0,8), counter-clockwise from the
  bottom-right corner — two units per face. Continuous everywhere except
  its single wrap, which lands on a corner.
*/
float squareArc(vec2 q) {
  if (abs(q.x) >= abs(q.y)) {
    if (q.x > 0.0) return q.y + 1.0;
    return 5.0 - q.y;
  }
  if (q.y > 0.0) return 3.0 - q.x;
  return 7.0 + q.x;
}

/*
  Flower colour by hash: mostly white daisies, then the planted warm, then
  the cornflower blues — which reuse the SKY colour rather than adding a
  sixth stop, because that is what keeps them reading as part of the same
  picture instead of as confetti thrown over it.
*/
vec3 drosteFlower(float h) {
  vec3 c = uC_cloud;
  c = mix(c, uC_bloom, step(0.52, h));
  c = mix(c, uC_sky, step(0.86, h));
  return c;
}

vec3 drosteRender(vec2 fragCoord) {
  vec2 uv = (2.0 * fragCoord - uRes) / min(uRes.x, uRes.y);
  float R = max(uP_radius, 0.001);

  // the dome: the front hemisphere of a unit ball, in screen space
  vec2 pl = uv / R;
  float z = sqrt(max(1.0 - dot(pl, pl), 0.0));

  float fall = uP_fall;   // integrated clock: the flight inward
  float drift = uP_drift; // integrated clock: weather

  /*
    The frame tilt is a STATIC angle, not an integrated clock like the roll
    every other orb here gets. Those clocks seed at a random phase per
    mount, which is exactly right for a field with no preferred direction
    and exactly wrong for a picture: it lands the sky down one side of the
    ball and the meadow up the other. This one has an up.
  */
  float sw = uP_tilt;

  // stereographic wrap — the tunnel is inside the ball, and compresses
  // toward the limb the way a texture on a sphere does
  vec2 p = pl / (z + 1.0 + uP_bulge) * uP_scale;
  p = mat2(cos(sw), -sin(sw), sin(sw), cos(sw)) * p;

  /*
    The Chebyshev norm makes the level sets SQUARES. The floor on it is
    what keeps the logarithm finite at the dead centre; the haze below
    covers that last pixel anyway.
  */
  float m = max(max(abs(p.x), abs(p.y)), 0.002);

  float K = max(uP_ratio, 1.05);
  float L = log2(m) / log2(K) + fall;

  vec2 q = p / m;                 // direction, on the unit square boundary
  float sm = pow(K, fract(L));    // this fragment's radius in base-frame units
  vec2 P = q * sm;                // where it lands in the base picture

  float Yn = P.y / K;             // picture height, about -1 at the bottom edge
  float arc = squareArc(q);       // distance around the frame

  // ---- sky -----------------------------------------------------------
  vec3 col = mix(uC_sky * 0.72, uC_sky, clamp(Yn * 1.3, 0.0, 1.0));

  /*
    Cloud and land are both read in BASE-PICTURE coordinates, so every
    frame carries the same weather at its own scale — which is the whole
    point of a picture that contains itself.
  */
  float skyMask = smoothstep(uP_horizon - 0.3, uP_horizon + 0.2, Yn);
  float cl = fbm(P * uP_cloudScale + vec2(drift, drift * 0.3));
  cl = smoothstep(drosteCloud, drosteCloud + 0.16, cl);
  col = mix(col, uC_cloud, cl * (0.2 + 0.8 * skyMask));

  // ---- land ----------------------------------------------------------
  /*
    The smear. Sampled on (distance around the frame, frame index) with a
    low frequency on the second axis, so features run LONG in the
    direction the recursion stretches them — the streaked walls of the
    reference, straight out of the geometry.
  */
  float streak = fbm(vec2(arc * uP_streakFreq, L * uP_streakRad));

  vec3 land = mix(uC_canopy, uC_meadow, smoothstep(0.02, -0.62, Yn));
  land *= 0.42 + 1.25 * streak;

  // water: the low ground holds it where the streak field pools
  float water = smoothstep(0.42, 0.16, streak) * smoothstep(0.05, -0.3, Yn);
  land = mix(land, uC_water, water * uP_water);

  /*
    Flowers, hashed one to a cell on the same (around, index) grid, jittered
    inside it. Densest low in the picture and gone by the horizon.
  */
  vec2 fg = vec2(arc * uP_flowerScale, L * uP_flowerScale * 0.3);
  vec2 fc = floor(fg);
  vec2 ff = fract(fg) - 0.5;
  vec2 dcv = ff - (vec2(hash(fc + 3.7), hash(fc + 19.1)) - 0.5) * 0.6;
  float petal = smoothstep(uP_flowerSize, uP_flowerSize * 0.35, length(dcv));
  float present = step(1.0 - drosteBloom, hash(fc + 51.3));
  float meadow = smoothstep(0.13, -0.38, Yn);
  land = mix(land, drosteFlower(hash(fc + 7.9)), petal * present * meadow);

  float landMask = 1.0 - smoothstep(uP_horizon - 0.12, uP_horizon + 0.16, Yn);
  col = mix(col, land, landMask);

  /*
    The picture's own edge. Darkening across the frame and resetting hard
    at its boundary is not an artefact to smooth away — it draws the
    nested borders the reference is built out of.
  */
  col *= mix(1.0, uP_frameShade, fract(L));

  /*
    Aerial perspective, from the SCREEN radius. Every frame has the same
    fractional part, so depth cannot come from inside a frame — it has to
    come from how far in the fragment sits. This is what makes the middle
    read as far away instead of merely small.
  */
  float deep = 1.0 - smoothstep(0.0, uP_hazeRange, m);
  col = mix(col, uC_sky, deep * drosteHaze);

  col = pow(max(col, vec3(0.0)), vec3(uP_contrast)) * uP_gain;

  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum), col, uP_saturation);

  // dome shading, kept light — this is a window, not a lit surface
  vec3 n = vec3(pl, z);
  float lambert = clamp(dot(n, normalize(vec3(-0.45, 0.55, 0.72))), 0.0, 1.0);
  col *= 0.72 + uP_light * lambert;

  // the glass: a strong fresnel is what turns a picture into a sphere
  // with a world inside it
  float fres = 1.0 - z;
  fres = fres * fres * fres;
  col += uC_sheen * uP_rim * fres;

  return col;
}

void orbMain() {
  // Volume coupling: the user's voice thickens the weather, the agent's
  // clears the haze and brings the meadow into flower.
  drosteCloud = clamp(uP_cloudCover - 0.12 * uInput, 0.02, 0.98);
  drosteHaze = uP_haze * (1.0 - 0.25 * uOutput);
  drosteBloom = clamp(uP_flowerDensity * (1.0 + 0.5 * uOutput), 0.0, 1.0);

  vec2 uv = orbUV();
  float mask = smoothstep(0.012, -0.012, length(uv) - max(uP_radius, 0.001));

  // Two fbm evaluations and a flower grid per sample — none of it worth
  // paying for outside the silhouette.
  if (mask <= 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  vec3 col = vec3(0.0);
#if AA > 1
  for (int mx = 0; mx < AA; mx++) {
    for (int my = 0; my < AA; my++) {
      vec2 off = (vec2(float(mx), float(my)) + 0.5) / float(AA) - 0.5;
      col += drosteRender(gl_FragCoord.xy + off);
    }
  }
  col /= float(AA * AA);
#else
  col = drosteRender(gl_FragCoord.xy);
#endif

  // Surface orb bounded by a mask: alpha IS coverage, so premultiply — the
  // opposite convention from the emissive orbs (see shdr-31).
  float a = mask;
  gl_FragColor = vec4(max(col, vec3(0.0)) * a, a);
}
`,
  },
  /** orbkit SHDR-32. */
  galaxy: {
    fill: 0.895,
    finish: true,
    params: [
      ["spin", 0.06, true],
      ["churn", 0.25, true],
      ["beat", 0.8, true],
      ["twinkle", 1.2, true],
      ["camDist", 7],
      ["focal", 2.25],
      ["envRadius", 2.6],
      ["tilt", 0.85],
      ["arms", 2],
      ["wind", 3.4],
      ["ragged", 3],
      ["armSharp", 2.2],
      ["falloff", 1.7],
      ["thick", 0.035],
      ["bulge", 40],
      ["core", 5],
      ["turbScale", 9],
      ["threshold", 0.35],
      ["density", 14],
      ["absorb", 3.5],
      ["stars", 1.2],
      ["starDensity", 0.5],
      ["starScale", 48],
      ["hueReach", 0.6],
      ["pulse", 0.2],
      ["breathe", 0],
      ["exposure", 1.1],
      ["contrast", 1.15],
      ["saturation", 1.35],
      ["alphaGain", 2],
      ["fill", 0.85],
      ["rim", 0.35],
      ["edge", 1],
      ["edgeFade", 0.98],
    ],
    colors: [
      ["tint", "#ffffff"],
      ["core", "#fff3d6"],
      ["inner", "#7fb4ff"],
      ["outer", "#c46bff"],
      ["deep", "#04050f"],
      ["rim", "#8fb0ff"],
    ],
    source: `
#define STEPS 56
#define TURB_OCT 4

// Volume-reactive values, resolved once per fragment in main().
float galDensity;
float galCore;
float galFalloff;

/*
  The galactic density at a point in the galaxy's own frame: the disc lies
  in xz, the normal is y. Returns the density; writes the arm weight and the
  cylindrical radius for the colour.
*/
float galaxy(vec3 p, float t, out float arm, out float rho) {
  rho = length(p.xz);
  float h = p.y;
  // atan(0, 0) is undefined; the exact axis is all bulge anyway
  float phi = rho > 1e-4 ? atan(p.z, p.x) : 0.0;
  float lr = log(max(rho, 0.02));
  float armPhase = phi * uP_arms - uP_wind * lr;

  // feedback curl turbulence, shared phase
  vec3 q = p * uP_turbScale;
  float f = 1.0;
  for (int k = 0; k < TURB_OCT; k++) {
    q += cos(q.yzx * f + t) / f;
    f *= 1.9;
  }
  float n = (sin(q.x) + sin(q.y) + sin(q.z)) / 3.0 * 0.5 + 0.5;
  float clump = smoothstep(uP_threshold, 1.0, n);

  arm = 0.5 + 0.5 * cos(armPhase + (n - 0.5) * uP_ragged);
  arm = pow(arm, uP_armSharp);

  float scaleH = uP_thick * (0.12 + rho);
  float disc = exp(-rho * galFalloff) * exp(-abs(h) / scaleH);
  float bulge = exp(-dot(p, p) * uP_bulge);

  float dens = disc * (0.08 + 1.6 * arm) * (0.25 + 0.75 * clump) + bulge * galCore;
  return dens * galDensity;
}

/*
  One lattice of hashed stars. Each cell either carries a star or not, at a
  hashed position, with its own twinkle rate; the 3x3 neighbourhood is
  gathered so a star near a cell wall is not clipped.
*/
float starField(vec2 p, float density, float size, float twinkleT) {
  vec2 id = floor(p);
  vec2 f = fract(p);
  float acc = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(float(i), float(j));
      vec2 cid = id + o;
      float h = hash(cid);
      if (h > density) continue;
      vec2 sp = o + vec2(hash(cid + 1.3), hash(cid + 2.7));
      float dd = length(f - sp);
      float tw = 0.55 + 0.45 * sin(twinkleT * (1.5 + 5.0 * hash(cid + 5.1)) + h * 40.0);
      float sz = size * (0.5 + 1.2 * hash(cid + 8.9) * hash(cid + 8.9));
      acc += tw * exp(-dd * dd / (sz * sz)) * (0.4 + 0.6 * h / max(density, 0.001));
    }
  }
  return acc;
}

vec4 galaxyRender(vec2 fragCoord) {
  vec2 uv = (2.0 * fragCoord - uRes) / min(uRes.x, uRes.y);
  vec3 ro = vec3(0.0, 0.0, uP_camDist);
  vec3 rd = normalize(vec3(uv, -uP_focal));

  float t = uP_churn; // integrated clock: the turbulence boils
  float spin = uP_spin; // integrated clock: the disc turns

  // the galaxy frame: tip about x by the tilt, then turn about the disc's
  // own normal
  float ct = cos(uP_tilt);
  float st = sin(uP_tilt);
  float cs = cos(spin);
  float sn = sin(spin);

  vec3 acc = vec3(0.0);
  vec3 T = vec3(1.0);
  // extinction weighted to blue, so thick gas reddens what is behind it
  vec3 absorb = vec3(0.7, 1.0, 1.5) * uP_absorb;

  // march only the span the envelope can light
  float z = max(uP_camDist - uP_envRadius * 1.05, 0.0);
  float zEnd = uP_camDist + uP_envRadius * 1.05;
  float dt = (zEnd - z) / float(STEPS);
  // a hashed start offset per pixel hides the step banding
  z += dt * hash(fragCoord * 0.37);

  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * z;

    // envelope: nothing outside the ball contributes
    float env = 1.0 - smoothstep(uP_envRadius * 0.92, uP_envRadius, length(p));
    if (env > 0.001) {
      // into the galaxy frame
      vec3 g = vec3(p.x, p.y * ct - p.z * st, p.y * st + p.z * ct);
      g = vec3(g.x * cs - g.z * sn, g.y, g.x * sn + g.z * cs);

      float arm = 0.0;
      float rho = 0.0;
      float d = galaxy(g / uP_envRadius, t, arm, rho) * env;

      // the colour ramp, keyed to radius from the core
      vec3 ramp = mix(uC_inner, uC_outer, smoothstep(0.12, uP_hueReach, rho));
      float coreW = exp(-rho * rho * uP_bulge * 0.6);
      vec3 emit = mix(ramp, uC_core, coreW) * (0.6 + 0.6 * arm);

      acc += T * d * emit * dt;
      T *= exp(-d * absorb * dt);
    }

    z += dt;
    if (T.g < 0.004 || z > zEnd) break;
  }

  return vec4(acc, 1.0 - T.g);
}

void orbMain() {
  // The beat: one wave on the core-beat clock, shared by the core flare and
  // the disc's breathing. Both depths are amplitudes, so they stage cleanly.
  float wave = 0.5 + 0.5 * cos(uP_beat);
  galDensity = uP_density * (1.0 + 0.35 * uInput);
  galCore = uP_core * (1.0 + 0.7 * uOutput) * (1.0 + uP_pulse * wave);
  // breathing: the disc's falloff relaxes on the wave, so the whole disc
  // swells outward and draws back — a smooth exponential, safe to sweep
  galFalloff = uP_falloff / (1.0 + uP_breathe * wave);

  vec4 acc = galaxyRender(gl_FragCoord.xy);

  /*
    Stars, at the ray's exact hit with the galactic plane. The plane is the
    tilted xz-plane through the origin; its world normal is the tilted y.
    The lattice lives in the disc's own turning frame, so the stars turn
    with the gas, and the march's transmittance dims them through the dust.
  */
  {
    vec3 ro = vec3(0.0, 0.0, uP_camDist);
    vec3 rd = normalize(vec3(orbUV(), -uP_focal));
    float ct = cos(uP_tilt);
    float st = sin(uP_tilt);
    vec3 N = vec3(0.0, ct, st);
    float denom = dot(N, rd);
    if (abs(denom) > 1e-4) {
      float th = -dot(N, ro) / denom;
      vec3 q = ro + rd * th;
      if (th > 0.0 && dot(q, q) < uP_envRadius * uP_envRadius * 0.9) {
        vec3 g = vec3(q.x, q.y * ct - q.z * st, q.y * st + q.z * ct) / uP_envRadius;
        float cs = cos(uP_spin);
        float sn = sin(uP_spin);
        vec2 gp = vec2(g.x * cs - g.z * sn, g.x * sn + g.z * cs);
        float rho = length(gp);
        float phi = rho > 1e-4 ? atan(gp.y, gp.x) : 0.0;
        float armW = 0.5 + 0.5 * cos(phi * uP_arms - uP_wind * log(max(rho, 0.02)));
        float sf = starField(gp * uP_starScale, uP_starDensity * (0.3 + 0.7 * armW), 0.12, uP_twinkle);
        float veil = 1.0 - acc.a; // what the march let through
        acc.rgb += vec3(1.0, 0.97, 0.9) * sf * uP_stars * exp(-rho * 1.5) * (0.25 + 0.75 * veil);
      }
    }
  }

  // tanh tone map per channel, tunable knee
  vec3 col = tanh3(acc.rgb / max(uP_exposure, 0.01));
  col = pow(clamp(col, 0.0, 1.0), vec3(uP_contrast));

  // saturation about luminance, then the tint
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum), col, uP_saturation);
  col *= uC_tint;

  // alpha from the brightest channel — emitted light (see shdr-18)
  float peak = max(col.r, max(col.g, col.b));
  float a = clamp(peak * uP_alphaGain, 0.0, 1.0);

  // the run behind: a fill so the ball is a solid sphere, not a cut-out
  col += uC_deep * uP_fill;
  a = max(a, uP_fill);

  // Analytic silhouette — identical construction to shdr-01: exact
  // ray-to-centre distance against the radius, colour AND alpha.
  vec3 mrd = normalize(vec3(orbUV(), -uP_focal));
  float closest = length(cross(vec3(0.0, 0.0, uP_camDist), mrd));
  float band = mix(0.35, 0.012, clamp(uP_edge, 0.0, 1.0));
  float mask = 1.0 - smoothstep(uP_envRadius * (1.0 - band), uP_envRadius * 1.005, closest);
  col *= mask;
  a *= mask;

  // a fresnel rim on the glass, inside the mask
  float fres = smoothstep(uP_envRadius * 0.7, uP_envRadius, closest);
  col += uC_rim * uP_rim * fres * fres * mask;

  // safety taper at the frame boundary — colour as well as alpha
  float r2d = length(orbUV());
  float fade = 1.0 - smoothstep(uP_edgeFade, 1.0, r2d);
  col *= fade;
  a *= fade;

  // Emitted light, so rgb is already premultiplied — do NOT scale by alpha
  // again (see the same note in shdr-31).
  gl_FragColor = vec4(col, a);
}
`,
  },
  /** orbkit SHDR-33. */
  thermal: {
    fill: 0.895,
    finish: true,
    params: [
      ["speed", 0.5, true],
      ["spin", 0.05, true],
      ["radius", 0.9],
      ["scale", 3],
      ["freq", 1.4],
      ["warp", 0.6],
      ["lo", 0.42],
      ["hi", 0.74],
      ["gain", 1],
      ["jitter", 0.015],
      ["bands", 7],
      ["banding", 0.85],
      ["contrast", 1],
      ["dither", 0.05],
      ["dots", 46],
      ["dotGain", 1],
      ["dotSoft", 0.12],
      ["misregister", 0.5],
      ["ink", 0.92],
      ["printMix", 0.28],
      ["grain", 0.35],
      ["grainSize", 2],
      ["light", 0.25],
      ["rim", 0.25],
    ],
    colors: [
      ["cold", "#0b0a1e"],
      ["cool", "#3b2a9a"],
      ["warm", "#f05a28"],
      ["hot", "#f6b53a"],
      ["core", "#fff1e6"],
      ["paper", "#f4ecdf"],
    ],
    source: `
const float PI = 3.14159265359;

// Volume-reactive values, resolved once per fragment in main().
float heatGainNow;
float heatJitterNow;

float grainNoise(vec2 gpix, float frame, float seed) {
  return hash(gpix + vec2(frame * 13.71 + seed, frame * 7.37 - seed));
}

mat2 rot2(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}

/*
  One ink screen. Square dots on a grid at angle a, offset o (the
  misregistration), sized by the coverage: coverage 0 is paper, coverage 1
  is a solid. Returns how much of this pixel the ink covers.

  The grid is laid in SCREEN space, not on the wrapped plane: a print is
  flat, and it is the picture that curves round the ball. A screen on the
  wrapped coordinates changes pitch toward the limb and beats against the
  other two into moire rings.
*/
float screen(vec2 uv, float a, vec2 o, float coverage, float soft) {
  vec2 cell = rot2(a) * uv * uP_dots + o;
  vec2 f = fract(cell) - 0.5;
  float d = length(f); // a round dot: reads as tone, not as a grid
  // dot half-size from coverage; sqrt so mid-tones read as mid-tones the
  // way a real screen's area does
  float size = 0.5 * sqrt(clamp(coverage * uP_dotGain, 0.0, 1.0));
  return 1.0 - smoothstep(size - soft, size + soft, d);
}

void orbMain() {
  heatGainNow = uP_gain * (1.0 + 0.6 * uOutput);
  heatJitterNow = uP_jitter * (1.0 + 1.5 * uInput);

  vec2 uv = orbUV();
  float rd = length(uv);
  float R = uP_radius;
  float mask = smoothstep(0.012, -0.012, rd - R);

  if (mask <= 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  vec2 pl = uv / R;
  float r2 = dot(pl, pl);
  float z = sqrt(max(1.0 - r2, 0.0));
  vec3 n = vec3(pl, z);

  // roll the dome about Y on its own integrated clock
  float cr = cos(uP_spin);
  float sr = sin(uP_spin);
  vec3 sp = vec3(n.x * cr - n.z * sr, n.y, n.x * sr + n.z * cr);

  float t = uP_speed; // integrated clock: the sources drift

  // stereographic wrap of the plane onto the ball
  vec2 st = sp.xy / (1.3 + sp.z) * uP_scale;

  /*
    The heat: a drifting, domain-warped noise field with a threshold window
    cut out of it. Two drifts at different rates so the pools travel and
    change shape rather than slide as one sheet; the input jitter is a fast
    wobble on top.
  */
  vec2 p = st * uP_freq + vec2(t * 0.11, -t * 0.07);
  vec2 wp = st * uP_freq * 0.55 + vec2(-t * 0.05, t * 0.08);
  vec2 warp = vec2(noise(wp + 3.1), noise(wp + 9.4)) - 0.5;
  p += warp * uP_warp;
  p += vec2(sin(t * 3.7), cos(t * 4.3)) * heatJitterNow;
  float field = noise(p) * 0.62 + noise(p * 2.1 + 5.3) * 0.26 + noise(p * 4.2 + 1.7) * 0.12;
  float heat = clamp((field - uP_lo) * heatGainNow / max(uP_hi - uP_lo, 0.01), 0.0, 1.0);

  // grain tap 1: dither the field before it is banded, so the contour
  // edges break up into speckle instead of clean steps
  vec2 gpix = floor(gl_FragCoord.xy / max(uP_grainSize, 1.0));
  float frame = floor(uTime * 48.0);
  heat += (grainNoise(gpix, frame, 3.1) - 0.5) * uP_dither;

  // the contours: quantize into bands, blend back with the smooth field
  float banded = floor(heat * uP_bands + 0.5) / uP_bands;
  heat = clamp(mix(heat, banded, uP_banding), 0.0, 1.0);
  heat = pow(heat, uP_contrast);

  // the thermal ramp
  vec3 base = mix(uC_cold, uC_cool, smoothstep(0.0, 0.3, heat));
  base = mix(base, uC_warm, smoothstep(0.3, 0.55, heat));
  base = mix(base, uC_hot, smoothstep(0.55, 0.78, heat));
  base = mix(base, uC_core, smoothstep(0.78, 0.97, heat));

  /*
    The print. Separate the palette into CMY coverage and lay each ink down
    as its own screen; the paper shows through the gaps. The angles are the
    classic offsets, scaled by the misregistration, plus a per-ink shift.
  */
  float soft = uP_dotSoft;
  float mis = uP_misregister;
  float cC = screen(uv, 0.035 * mis, vec2(0.22, 0.12) * mis, 1.0 - base.r, soft);
  float cM = screen(uv, -0.03 * mis, vec2(-0.14, 0.2) * mis, 1.0 - base.g, soft);
  float cY = screen(uv, 0.0, vec2(0.0), 1.0 - base.b, soft);

  vec3 print = uC_paper;
  print *= mix(vec3(1.0), vec3(0.05, 0.62, 0.92), cC * uP_ink);
  print *= mix(vec3(1.0), vec3(0.92, 0.08, 0.48), cM * uP_ink);
  print *= mix(vec3(1.0), vec3(0.98, 0.86, 0.02), cY * uP_ink);

  // the unprinted palette is mixed back a little so the blacks stay black
  // and the screens never wash the whole ball to paper
  vec3 col = mix(base, print, uP_printMix);

  // grain tap 2: paper
  col *= 1.0 + (grainNoise(gpix, frame, 27.9) - 0.5) * uP_grain;

  // dome shading keeps the ball a ball under the print
  float lambert = clamp(dot(n, normalize(vec3(-0.45, 0.55, 0.7))), 0.0, 1.0);
  col *= 1.0 - uP_light * (1.0 - lambert);
  float fres = pow(1.0 - z, 2.5);
  col += uC_paper * uP_rim * fres * 0.5;

  // Surface orb bounded by a mask: alpha IS coverage, so premultiply — the
  // opposite convention from the emissive orbs (see shdr-31).
  float a = mask;
  gl_FragColor = vec4(max(col, vec3(0.0)) * a, a);
}
`,
  },
};

/** orbkit tunes its motion to real seconds; the sphere clock runs 1.6× that, so orbs take 0.6 of it. */
const ORB_PACE = 0.6;
/** orbkit's voice inputs at rest: no one speaking, a little agent output. */
const ORB_INPUT = 0,
  ORB_OUTPUT = 0.3;
/** Colours no hue turns: a white tint and white highlights. */
const isNeutral = (key: string, hex: string): boolean => key === "tint" || hex === "#ffffff";
/** The rim light for a family without colour inputs. */
const PALE_RIM = [0.62, 0.72, 1.0];

/** A family's complete fragment shader: prelude, its uniforms, its own code and Genex's wrapper. */
export function orbFragment(family: OrbFamily): string {
  const shader = ORB_SHADERS[family];
  const declarations = [
    ...shader.params.map(([key]) => `uniform float uP_${key};`),
    ...shader.colors.map(([key]) => `uniform vec3 uC_${key};`),
  ].join("\n");
  return `precision highp float;
vec4 orbOut;
vec4 orbFrag;
#define gl_FragColor orbOut
#define gl_FragCoord orbFrag
${ORB_PRELUDE}
${declarations}
${shader.source}
${ORB_FINISH}`;
}

/** The most colourful of a family's colours, lifted toward white: the ball's rim light. */
function rimLight(colors: readonly string[]): number[] {
  const [richest] = [...colors].sort((a, b) => oklch(b)[1] - oklch(a)[1]);
  if (!richest) return PALE_RIM;
  return channels(richest).map((v) => 0.45 * v + 0.55 * Math.min(1, v * 1.4 + 0.25));
}

/** Every uniform an orb family's fragment reads at `time` on the sphere clock, for a `size` square. */
export function orbUniforms(recipe: CoverRecipe, size: number, time: number): Record<string, number | number[]> {
  const shader = ORB_SHADERS[recipe.family as OrbFamily];
  const degrees = coverHueDegrees(recipe);
  const t = time * ORB_PACE;
  const uniforms: Record<string, number | number[]> = {
    uRes: [size, size],
    uTime: t * 0.5,
    uAnim: t,
    uInput: ORB_INPUT,
    uOutput: ORB_OUTPUT,
    u_fill: shader.fill,
    u_finish: shader.finish ? 1 : 0,
    u_turn: shader.colors.length ? 0 : (degrees * Math.PI) / 180,
  };
  for (const [key, value, clock] of shader.params) uniforms[`uP_${key}`] = clock ? value * t : value;
  const turned: string[] = [];
  for (const [key, hex] of shader.colors) {
    const neutral = isNeutral(key, hex);
    const color = neutral ? hex : turnHue(hex, degrees);
    if (!neutral) turned.push(color);
    uniforms[`uC_${key}`] = channels(color);
  }
  uniforms.u_rim = rimLight(turned);
  return uniforms;
}
