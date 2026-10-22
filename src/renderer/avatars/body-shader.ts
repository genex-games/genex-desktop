/**
 * The generated avatar's body: one WGSL program with a branch per body (the recipe's
 * `bodyIndex`), drawn on a full-canvas triangle into the body's own canvas. A lit sphere that
 * turns slowly, in the recipe's palette, with its hue turned in YIQ, premultiplied for the page.
 * The approved prototype's GLSL, ported line for line.
 */
import type { AvatarRecipe } from "../../shared/avatar-recipe.ts";
import { cellsAcross, rgb } from "./draw-kit.ts";

/** Bytes of the per-avatar uniform block: four colours, then eight floats. */
export const BODY_UNIFORM_BYTES = 96;

/** The uniform block's float layout, in the order {@link BODY_SHADER} declares it. */
export const BodyUniform = {
  /** Four palette colours, each a vec4 (rgb, unused). */
  Colors: 0,
  Time: 16,
  Seed: 17,
  Body: 18,
  /** One pixel, in the sphere's -1..1 units: how soft the edge is. */
  Pixel: 19,
  Turn: 20,
  /** How many cells across the pixel-art bodies (CRT, glitch rows, halftone) use. */
  Cells: 21,
  /** How bright a galaxy's stars are, 0..1. */
  Stars: 22,
  /** A galaxy's star colour: 0 white, 1 the palette's second colour. */
  StarTint: 23,
} as const;

/** How a galaxy's stars show: their brightness and how far they lean from white to the palette's blue. */
export interface StarLook {
  strength: number;
  tint: number;
}

/** Stars as every galaxy avatar has them: bright white. */
export const BRIGHT_STARS: StarLook = { strength: 1, tint: 0 };

/** The shader: `vs_main` covers the canvas, `fs_main` draws the body. */
export const BODY_SHADER = /* wgsl */ `
struct Body {
  c0: vec4f,
  c1: vec4f,
  c2: vec4f,
  c3: vec4f,
  time: f32,
  seed: f32,
  body: f32,
  px: f32,
  turn: f32,
  cells: f32,
  stars: f32,
  star_tint: f32,
}
@group(0) @binding(0) var<uniform> u: Body;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn vs_main(@builtin(vertex_index) index: u32) -> VsOut {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let p = corners[index];
  var out: VsOut;
  out.position = vec4f(p, 0.0, 1.0);
  out.uv = p * 0.5 + 0.5;
  return out;
}

const PI = 3.14159265;

fn h11(n: f32) -> f32 { return fract(sin(n * 12.9898) * 43758.5453); }
fn h21(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn hash3(p0: vec3f) -> f32 {
  var p = fract(p0 * 0.3183099 + vec3f(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
fn noise(p: vec3f) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  let a = mix(mix(hash3(i), hash3(i + vec3f(1.0, 0.0, 0.0)), f.x), mix(hash3(i + vec3f(0.0, 1.0, 0.0)), hash3(i + vec3f(1.0, 1.0, 0.0)), f.x), f.y);
  let b = mix(mix(hash3(i + vec3f(0.0, 0.0, 1.0)), hash3(i + vec3f(1.0, 0.0, 1.0)), f.x), mix(hash3(i + vec3f(0.0, 1.0, 1.0)), hash3(i + vec3f(1.0, 1.0, 1.0)), f.x), f.y);
  return mix(a, b, f.z);
}
fn fbm(p: vec3f) -> f32 {
  return 0.5 * noise(p) + 0.25 * noise(p * 2.03 + vec3f(1.7)) + 0.125 * noise(p * 4.07 + vec3f(3.1)) + 0.0625 * noise(p * 8.13 + vec3f(5.3));
}
fn rainbow(t: f32) -> vec3f { return 0.5 + 0.5 * cos(6.28318 * (t + vec3f(0.0, 0.33, 0.67))); }
fn bayer2(a0: vec2f) -> f32 { let a = floor(a0); return fract(dot(a, vec2f(0.5, a.y * 0.75))); }
fn bayer4(a: vec2f) -> f32 { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
fn spin(n: vec3f, a: f32, tilt: f32) -> vec3f {
  let m = vec3f(n.x, n.y * cos(tilt) - n.z * sin(tilt), n.y * sin(tilt) + n.z * cos(tilt));
  return vec3f(m.x * cos(a) + m.z * sin(a), m.y, -m.x * sin(a) + m.z * cos(a));
}
fn modulo(x: f32, y: f32) -> f32 { return x - y * floor(x / y); }
fn line(d: f32, width: f32) -> f32 { return 1.0 - smoothstep(0.0, width, d); }

// CRT dither: the sphere drawn on a coarse grid in four palette steps, with scanlines.
fn crt(q: vec2f) -> vec4f {
  let cp = floor((q * 0.5 + 0.5) * u.cells);
  let cq = ((cp + 0.5) / u.cells) * 2.0 - 1.0;
  let c2 = dot(cq, cq);
  if (c2 >= 1.0) { return vec4f(0.0); }
  let cn = vec3f(cq, sqrt(1.0 - c2));
  let pp = spin(cn, u.time * 0.15 + u.seed * 2.39, 0.35);
  let light = normalize(vec3f(-0.55, 0.62, 0.75));
  let v = (dot(cn, light) * 0.5 + 0.5) * 0.95 + (fbm(pp * 1.7 + vec3f(u.seed * 1.31, u.seed * 0.77, u.seed * 2.03)) - 0.5) * 0.9;
  let lv = clamp(v + (bayer4(cp) - 0.5) * 0.3, 0.0, 0.999);
  let idx = floor(lv * 4.0);
  var col = u.c3.rgb;
  if (idx < 0.5) { col = u.c0.rgb; } else if (idx < 1.5) { col = u.c1.rgb; } else if (idx < 2.5) { col = u.c2.rgb; }
  col *= 0.86 + 0.14 * modulo(cp.y, 2.0);
  return vec4f(col, 1.0);
}

struct Sphere {
  q: vec2f,
  r: f32,
  n: vec3f,
  p: vec3f,
  so: vec3f,
  light: vec3f,
  dl: f32,
  lit: f32,
  fres: f32,
  lon: f32,
  lat: f32,
  r2: f32,
}

fn vapor(s: Sphere) -> vec3f {
  let t = u.time;
  let y = s.q.y;
  let top = mix(u.c1.rgb, u.c0.rgb, smoothstep(-0.15, 0.85, y));
  var col = mix(u.c2.rgb, top, smoothstep(-0.95, 0.05, y));
  col *= 0.8 + 0.3 * s.lit;
  let k = max(0.0, 0.25 - y);
  let f = fract((y + t * 0.05) * 8.0);
  let cut = step(f, 0.1 + k * 0.62) * step(y, 0.25);
  let depth = 0.06 + k;
  let gx = abs(fract(s.q.x / depth * 0.35 + 0.5) - 0.5);
  let gy = abs(fract(0.22 / depth + t * 0.5) - 0.5);
  let grid = max(line(gx, 0.07), line(gy, 0.09));
  let under = vec3f(0.04, 0.01, 0.1) + u.c3.rgb * grid * 0.95;
  col = mix(col, under, cut);
  return col + u.c3.rgb * s.fres * 0.55;
}

fn matrix(s: Sphere) -> vec3f {
  let t = u.time;
  let cols = 20.0;
  let lc = (s.lon + PI) / (2.0 * PI) * cols;
  let ci = floor(lc);
  let yy = (s.lat + PI * 0.5) / PI;
  let rows = 15.0;
  let ri = floor(yy * rows);
  let sp = 0.35 + 0.65 * h11(ci + u.seed);
  let head = fract(-t * sp * 0.32 + h11(ci * 3.1 + u.seed));
  let dist = fract(ri / rows - head);
  let trail = exp(-dist * 6.0);
  let cell = vec2f(fract(lc), fract(yy * rows));
  let gc = floor(cell * vec2f(3.0, 5.0));
  let flick = floor(t * 4.0 + h11(ci + ri) * 10.0);
  let glyph = step(0.42, h21(gc + vec2f(ci * 7.0 + flick * 0.37, ri * 13.0)));
  let inset = step(0.15, cell.x) * step(cell.x, 0.85) * step(0.08, cell.y) * step(cell.y, 0.92);
  let b = glyph * inset * trail;
  let headc = step(dist, 1.0 / rows);
  let col = u.c0.rgb + u.c3.rgb * (0.35 + 0.4 * s.lit) + u.c1.rgb * b * 1.25 + u.c2.rgb * b * headc * 0.9;
  return col + u.c1.rgb * s.fres * 0.45;
}

fn holo(s: Sphere) -> vec3f {
  let t = u.time;
  let l1 = abs(fract(s.lat / PI * 10.0) - 0.5);
  let cl = max(cos(s.lat), 0.15);
  let l2 = abs(fract(s.lon / (2.0 * PI) * 18.0) - 0.5);
  let grid = max(line(l1, 0.07), line(l2, 0.06 / cl));
  let nb = vec3f(s.q, -sqrt(1.0 - s.r2));
  let pb = spin(nb, t * 0.15 + u.seed * 2.39, 0.35);
  let latb = asin(clamp(pb.y, -1.0, 1.0));
  let lonb = atan2(pb.x, pb.z);
  let gb = max(line(abs(fract(latb / PI * 10.0) - 0.5), 0.07), line(abs(fract(lonb / (2.0 * PI) * 18.0) - 0.5), 0.06 / max(cos(latb), 0.15)));
  let sweep = (s.q.y - (fract(t * 0.22) * 2.6 - 1.3)) * 7.0;
  let scan = exp(-sweep * sweep);
  let ink = mix(u.c1.rgb, u.c2.rgb, 0.5 + 0.5 * s.q.y);
  return u.c0.rgb + ink * grid * (0.5 + 0.5 * s.n.z) + ink * gb * 0.22 + u.c3.rgb * scan * 0.28 * (grid + 0.3) + ink * s.fres * 0.9;
}

fn circuit(s: Sphere) -> vec3f {
  let t = u.time;
  let suv = vec2f((s.lon + PI) / (2.0 * PI) * 22.0, (s.lat + PI * 0.5) / PI * 11.0);
  let id = floor(suv);
  var f = fract(suv) - 0.5;
  if (h21(id + u.seed) > 0.5) { f.x = -f.x; }
  let d1 = abs(length(f - vec2f(0.5)) - 0.5);
  let d2 = abs(length(f + vec2f(0.5)) - 0.5);
  let d = min(d1, d2);
  let wire = 1.0 - smoothstep(0.045, 0.085, d);
  var ang = atan2(f.y + 0.5, f.x + 0.5);
  if (d1 < d2) { ang = atan2(f.y - 0.5, f.x - 0.5); }
  let pulse = smoothstep(0.82, 1.0, sin(ang * 2.0 + (id.x + id.y * 1.3) * 1.7 - t * 3.0));
  let pad = (1.0 - smoothstep(0.1, 0.14, length(f))) * step(0.82, h21(id * 1.3 + u.seed));
  let metal = mix(u.c0.rgb, u.c1.rgb, fbm(s.p * 3.0 + s.so)) * (0.45 + 0.85 * s.lit);
  let col = metal + u.c2.rgb * wire * 0.7 + u.c3.rgb * wire * pulse * 1.5 + u.c2.rgb * pad * 0.9;
  return col + u.c3.rgb * s.fres * 0.35;
}

fn toon(s: Sphere) -> vec3f {
  var band = mix(0.0, 0.5, smoothstep(-0.12, -0.06, s.dl));
  band = mix(band, 1.0, smoothstep(0.52, 0.58, s.dl));
  var col = mix(u.c0.rgb, u.c2.rgb, 0.6);
  if (band < 0.25) { col = u.c1.rgb; } else if (band < 0.75) { col = u.c0.rgb; }
  let hairs = smoothstep(0.55, 0.6, fbm(vec3f(s.p.x * 2.0, s.p.y * 7.0, s.p.z * 2.0) + s.so));
  col = mix(col, u.c1.rgb, hairs * 0.25 * (1.0 - band));
  let rim = smoothstep(0.55, 0.6, s.fres) * smoothstep(0.1, 0.4, dot(normalize(vec2f(s.q.x, s.q.y) + 0.0001), vec2f(0.6, -0.5)));
  col = mix(col, u.c3.rgb, rim * 0.9);
  var hp = s.q - vec2f(-0.4, 0.42);
  hp = mat2x2f(0.8, -0.6, 0.6, 0.8) * hp;
  let e = length(hp * vec2f(1.0, 2.4));
  let gloss = 1.0 - smoothstep(0.17, 0.19, e);
  let dot2 = 1.0 - smoothstep(0.055, 0.07, length(s.q - vec2f(-0.14, 0.62)));
  col = mix(col, vec3f(1.0), max(gloss, dot2) * 0.95);
  return mix(col, u.c1.rgb * 0.45, smoothstep(0.93, 0.965, s.r));
}

fn glitch(s: Sphere) -> vec3f {
  let t = u.time;
  let w = sin((s.p.x + s.p.y) * 9.0 + t * 0.8);
  var b = mix(u.c2.rgb, u.c0.rgb, step(0.25, w));
  b = mix(b, u.c1.rgb, step(0.86, sin(s.p.y * 21.0 - t * 1.3)));
  var col = b * (0.45 + 0.75 * s.lit) + u.c3.rgb * s.fres * 0.3;
  return col * (0.9 + 0.1 * step(0.5, fract(s.q.y * u.cells * 0.5)));
}

fn chrome(s: Sphere) -> vec3f {
  let t = u.time;
  var r = reflect(vec3f(0.0, 0.0, -1.0), s.n);
  let wobble = vec2f(fbm(s.p * 1.8 + s.so + vec3f(t * 0.08)), fbm(s.p * 1.8 + s.so.yzx - vec3f(t * 0.07)));
  r = vec3f(r.xy + (wobble - 0.5) * 0.5, r.z);
  let hy = r.y;
  let sky = mix(u.c3.rgb, u.c0.rgb, smoothstep(0.0, 0.75, hy));
  let ground = mix(u.c1.rgb * 0.35, u.c1.rgb, smoothstep(-0.9, -0.05, hy));
  var env = ground;
  if (hy > 0.0) { env = sky; }
  env += u.c2.rgb * exp(-abs(hy) * 24.0) * 0.9;
  env += 0.22 * smoothstep(0.95, 1.0, sin(r.x * 13.0 + r.y * 4.0));
  var col = env * (0.78 + 0.3 * s.lit) + vec3f(pow(max(dot(normalize(r), s.light), 0.0), 36.0)) * 1.1;
  return col + rainbow(s.n.z * 0.9 + t * 0.05) * s.fres * 0.3;
}

fn halftone(s: Sphere) -> vec3f {
  let shade = clamp(1.0 - s.lit, 0.0, 1.0);
  let g = mat2x2f(0.7071, -0.7071, 0.7071, 0.7071) * ((s.q * 0.5 + 0.5) * u.cells * 0.75);
  let cell = fract(g) - 0.5;
  let rad = sqrt(shade) * 0.62;
  let dm = 1.0 - smoothstep(rad - 0.1, rad + 0.02, length(cell));
  let blob = smoothstep(0.5, 0.54, fbm(s.p * 1.4 + s.so));
  var base = mix(u.c0.rgb, u.c2.rgb, blob * 0.9);
  base = mix(base, u.c3.rgb, smoothstep(0.62, 0.66, fbm(s.p * 2.3 + s.so.zxy)) * 0.9);
  let col = mix(base, u.c1.rgb, dm * 0.85);
  return mix(col, u.c1.rgb, smoothstep(0.9, 0.935, s.r));
}

fn foil(s: Sphere) -> vec3f {
  let t = u.time;
  let th = dot(s.n, normalize(vec3f(0.3, 0.5, 1.0))) * 1.4 + fbm(s.p * 2.2 + s.so) * 1.3 + t * 0.05;
  let base = mix(u.c1.rgb, u.c0.rgb, s.lit);
  var col = mix(base, rainbow(th), 0.5 + 0.35 * s.fres) * (0.65 + 0.55 * s.lit);
  let sc = floor(s.p * 16.0);
  let sp = h21(sc.xy + sc.z * 7.1 + u.seed);
  let tw = pow(max(0.0, sin(t * 2.6 + sp * 40.0)), 10.0);
  col += vec3f(1.0) * step(0.9, sp) * tw * 1.3;
  return col + vec3f(pow(max(dot(reflect(vec3f(0.0, 0.0, -1.0), s.n), s.light), 0.0), 28.0)) * 0.9;
}

fn neon(s: Sphere) -> vec3f {
  let t = u.time;
  let g1 = exp(-abs(fract(s.p.y * 2.0 + 0.5) - 0.5) * 26.0);
  let p2 = vec3f(s.p.x, s.p.y * cos(1.05) - s.p.z * sin(1.05), s.p.y * sin(1.05) + s.p.z * cos(1.05));
  let g2 = exp(-abs(p2.x) * 24.0);
  let g3 = exp(-abs(fract(p2.y * 1.5 + t * 0.2) - 0.5) * 30.0) * 0.6;
  var col = u.c0.rgb * (0.5 + 0.7 * s.lit) + u.c1.rgb * g1 * 1.15 + u.c2.rgb * g2 * 1.15 + u.c3.rgb * g3;
  col += vec3f(1.0) * (pow(g1, 8.0) + pow(g2, 8.0)) * 0.55;
  return col + mix(u.c1.rgb, u.c2.rgb, 0.5) * s.fres * 0.45;
}

fn galaxy(s: Sphere) -> vec3f {
  let t = u.time;
  let pp = s.p * 1.4 + s.so;
  let neb = fbm(pp + vec3f(fbm(pp * 1.3) * 1.4));
  let neb2 = fbm(pp * 2.1 + 3.0);
  var col = u.c0.rgb + u.c1.rgb * smoothstep(0.42, 0.8, neb) * 0.95 + u.c2.rgb * smoothstep(0.55, 0.85, neb2) * 0.75;
  let sc = floor(s.p * 28.0);
  let st = h21(sc.xy * 1.3 + sc.z * 3.7 + u.seed);
  let star = mix(vec3f(1.0), u.c1.rgb, u.star_tint) * u.stars;
  col += star * step(0.955, st) * (0.55 + 0.45 * sin(t * 2.0 + st * 50.0));
  col += u.c3.rgb * s.fres * 0.85;
  return col + vec3f(pow(max(dot(s.n, normalize(s.light + vec3f(0.0, 0.0, 1.0))), 0.0), 40.0)) * 0.45;
}

fn body(q: vec2f) -> vec4f {
  if (u.body > 0.5 && u.body < 1.5) { return crt(q); }
  let r2 = dot(q, q);
  if (r2 >= 1.0) { return vec4f(0.0); }
  var s: Sphere;
  s.q = q;
  s.r2 = r2;
  s.r = sqrt(r2);
  s.n = vec3f(q, sqrt(1.0 - r2));
  s.p = spin(s.n, u.time * 0.15 + u.seed * 2.39, 0.35);
  s.so = vec3f(u.seed * 1.31, u.seed * 0.77, u.seed * 2.03);
  s.light = normalize(vec3f(-0.55, 0.62, 0.75));
  s.dl = dot(s.n, s.light);
  s.lit = smoothstep(-0.35, 0.95, s.dl);
  s.fres = pow(1.0 - s.n.z, 2.0);
  s.lon = atan2(s.p.x, s.p.z);
  s.lat = asin(clamp(s.p.y, -1.0, 1.0));
  let edge = 1.0 - smoothstep(1.0 - u.px * 1.6, 1.0, s.r);
  var col: vec3f;
  let k = u.body;
  if (k < 0.5) { col = vapor(s); }
  else if (k < 2.5) { col = matrix(s); }
  else if (k < 3.5) { col = holo(s); }
  else if (k < 4.5) { col = circuit(s); }
  else if (k < 5.5) { col = toon(s); }
  else if (k < 6.5) { col = glitch(s); }
  else if (k < 7.5) { col = chrome(s); }
  else if (k < 8.5) { col = halftone(s); }
  else if (k < 9.5) { col = foil(s); }
  else if (k < 10.5) { col = neon(s); }
  else { col = galaxy(s); }
  return vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), edge);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  var q = uv * 2.0 - 1.0;
  var c: vec4f;
  if (u.body > 5.5 && u.body < 6.5) {
    // Glitch: torn rows in bursts, and the channels pulled apart.
    let st = floor(u.time * 7.0);
    let burst = step(0.7, h11(st * 1.7 + u.seed));
    let band = floor((q.y + 1.0) * 8.0);
    let g = h21(vec2f(band, st + u.seed));
    q.x += (g - 0.5) * 0.3 * burst * step(0.5, g);
    let split = 0.03 + 0.06 * burst;
    let a = body(q + vec2f(split, 0.0));
    let b = body(q);
    let d = body(q - vec2f(split, 0.0));
    c = vec4f(a.r, b.g, d.b, max(a.a, max(b.a, d.a)));
  } else {
    c = body(q);
  }
  let toY = mat3x3f(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
  let toR = mat3x3f(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
  var yiq = toY * c.rgb;
  let cs = cos(u.turn);
  let sn = sin(u.turn);
  yiq = vec3f(yiq.x, yiq.y * cs - yiq.z * sn, yiq.y * sn + yiq.z * cs);
  let o = clamp(toR * yiq, vec3f(0.0), vec3f(1.0));
  return vec4f(o * c.a, c.a);
}
`;

/** The uniform block for one body at `t` seconds of its own clock, drawn `pixels` across. */
export function bodyUniforms(
  recipe: AvatarRecipe,
  t: number,
  pixels: number,
  stars: StarLook = BRIGHT_STARS,
): Float32Array<ArrayBuffer> {
  const data = new Float32Array(BODY_UNIFORM_BYTES / 4);
  for (const [slot, hex] of recipe.palette.entries()) data.set(rgb(hex), BodyUniform.Colors + slot * 4);
  data[BodyUniform.Time] = t + recipe.seed * 3.1 + 1.7;
  data[BodyUniform.Seed] = recipe.seed;
  data[BodyUniform.Body] = recipe.bodyIndex;
  data[BodyUniform.Pixel] = 2 / pixels;
  data[BodyUniform.Turn] = recipe.turn;
  data[BodyUniform.Cells] = cellsAcross(pixels);
  data[BodyUniform.Stars] = stars.strength;
  data[BodyUniform.StarTint] = stars.tint;
  return data;
}
