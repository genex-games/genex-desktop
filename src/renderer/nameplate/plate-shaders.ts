/**
 * The Pro nameplate's pieces: one WGSL program per piece, drawn on a full-canvas triangle into the
 * plate's own canvas. Every program is the same prelude (the uniforms and the shared helpers), the
 * piece's own `scene`, and the same `fs_main`, which turns the recipe's eight dials on whatever the
 * piece drew: zoom about an anchor, mirror, warp, colour steps, glow, hue, grain and scanlines.
 * The approved prototype's GLSL, ported line for line; the output is opaque.
 */
import { PLATE_SCENES, PlateScene, type PlateRecipe } from "../../shared/plate-recipe.ts";
import { rgb } from "../avatars/draw-kit.ts";

/** Bytes of the per-plate uniform block {@link plateShader} declares. */
export const PLATE_UNIFORM_BYTES = 144;

/** How far the seed moves a plate's clock, in seconds per unit: plates side by side don't move in step. */
const SEED_CLOCK_SHIFT = 0.37;

/**
 * The uniform block's float layout, in the order the WGSL struct declares it. A colour is a vec3f,
 * so the clock, the seed and the pixel ratio fill the fourth floats of the first three.
 */
const Slot = {
  Deep: 0,
  Time: 3,
  Mid: 4,
  Seed: 7,
  Acc: 8,
  Dpr: 11,
  Light: 12,
  Glow: 16,
  Vars: 20,
  /** Eight dials: zoom, speed, warp, mirror, then hue, glow, grain and colour steps. */
  Dials: 24,
  Res: 32,
  /** 1 on a light theme: the piece is drawn on paper (its lightness turned over). */
  Paper: 34,
} as const;

/** The uniforms, the vertex stage and the helpers every piece shares (the prototype's HEAD). */
const PRELUDE = /* wgsl */ `
struct Plate {
  deep: vec3f,
  time_raw: f32,
  mid: vec3f,
  seed: f32,
  acc: vec3f,
  dpr: f32,
  light: vec3f,
  glow: vec3f,
  vars: vec4f,
  // zoom, speed, warp, mirror
  p0: vec4f,
  // hue, glow, grain, colour steps
  p1: vec4f,
  res: vec2f,
  // 1 on a light theme: the piece's lightness is turned over, a pale ground and deep colour.
  paper: f32,
}
@group(0) @binding(0) var<uniform> u: Plate;

// The piece's clock (the prototype's uTime): the plate's seconds at the speed dial's pace.
var<private> clock: f32;

@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[index], 0.0, 1.0);
}

fn ar() -> f32 { return u.res.x / u.res.y; }
// GLSL's mod: the result takes the divisor's sign.
fn modulo(x: f32, y: f32) -> f32 { return x - y * floor(x / y); }
// GLSL's smoothstep written out, so a falling edge (edge0 > edge1) draws as the prototype drew it.
fn hermite(e0: f32, e1: f32, x: f32) -> f32 {
  let k = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return k * k * (3.0 - 2.0 * k);
}
fn h11(n: f32) -> f32 { return fract(sin(n * 12.9898) * 43758.5453); }
fn h21(p0: vec2f) -> f32 {
  var p = fract(p0 * vec2f(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
fn h22(p: vec2f) -> vec2f {
  let n = h21(p);
  return vec2f(n, h21(p + n * 17.31));
}
fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2f(1.0, 0.0)), f.x), mix(h21(i + vec2f(0.0, 1.0)), h21(i + vec2f(1.0, 1.0)), f.x), f.y);
}
fn fbm(p0: vec2f) -> f32 {
  var p = p0;
  var v = 0.0;
  var a = 0.5;
  for (var i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2f(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}
fn bayer2(a0: vec2f) -> f32 {
  let a = floor(a0);
  return fract(dot(a, vec2f(0.5, a.y * 0.75)));
}
fn bayer4(a: vec2f) -> f32 { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
fn rot(a: f32) -> mat2x2f {
  let c = cos(a);
  let s = sin(a);
  return mat2x2f(c, -s, s, c);
}
fn sd_box(p: vec2f, b: vec2f) -> f32 {
  let d = abs(p) - b;
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}
fn ramp(v0: f32) -> vec3f {
  let v = clamp(v0, 0.0, 1.0);
  if (v < 0.33) { return mix(u.deep, u.mid, v / 0.33); }
  if (v < 0.66) { return mix(u.mid, u.acc, (v - 0.33) / 0.33); }
  return mix(u.acc, u.light, (v - 0.66) / 0.34);
}
fn spark(d0: vec2f, s: f32) -> f32 {
  let d = d0 / s;
  return exp(-length(d) * 9.0) * 1.4 + 0.5 * exp(-abs(d.x) * 28.0) * exp(-abs(d.y) * 3.5) + 0.5 * exp(-abs(d.y) * 28.0) * exp(-abs(d.x) * 3.5);
}
`;

/**
 * A light theme's paper: the piece's lightness turned over in OKLab, its hue kept and its colour a
 * little stronger, so a night piece becomes a pale ground with deep colour where its light was.
 */
const PAPER = /* wgsl */ `
fn to_linear(c: vec3f) -> vec3f { return pow(max(c, vec3f(0.0)), vec3f(2.2)); }
fn to_display(c: vec3f) -> vec3f { return pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.2)); }
fn oklab(c: vec3f) -> vec3f {
  let l = pow(max(0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b, 0.0), 1.0 / 3.0);
  let m = pow(max(0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b, 0.0), 1.0 / 3.0);
  let s = pow(max(0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b, 0.0), 1.0 / 3.0);
  return vec3f(
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  );
}
fn oklab_to_linear(c: vec3f) -> vec3f {
  let l0 = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  let m0 = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  let s0 = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  let l = l0 * l0 * l0;
  let m = m0 * m0 * m0;
  let s = s0 * s0 * s0;
  return vec3f(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  );
}
fn on_paper(col: vec3f) -> vec3f {
  var lab = oklab(to_linear(col));
  lab.x = mix(0.97, 0.5, clamp(lab.x, 0.0, 1.0));
  lab = vec3f(lab.x, lab.y * 1.3, lab.z * 1.3);
  return to_display(oklab_to_linear(lab));
}
`;

/** The dials on the piece's colour, per pixel (the prototype's MAIN). */
const MAIN = /* wgsl */ `
@fragment fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  clock = u.time_raw * mix(0.45, 2.0, u.p0.y);
  // The prototype's gl_FragCoord counts rows from the bottom; WebGPU's from the top.
  let frag = vec2f(pos.x, u.res.y - pos.y);
  let an = vec2f(u.res.x * 0.68, u.res.y * 0.5);
  var f = (frag - an) * mix(1.55, 0.62, u.p0.x) + an;
  if (u.p0.w > 0.72) {
    f = an - abs(f - an);
  } else if (u.p0.w > 0.48) {
    f.x = an.x - abs(f.x - an.x);
  }
  let wa = u.p0.z * u.p0.z;
  let wq = f / u.res.y;
  let wn = vec2f(noise(wq * 2.2 + vec2f(clock * 0.35, 0.0)), noise(wq * 2.2 + vec2f(7.1, -clock * 0.3))) - 0.5;
  f += wn * wa * u.res.y * 0.45;
  var col = scene(f);
  if (u.p1.w > 0.62) {
    let lv = floor(mix(3.0, 7.0, (u.p1.w - 0.62) / 0.38));
    col = floor(col * lv + bayer4(frag / (1.5 * u.dpr)) * 0.95) / lv;
  }
  col += u.p1.y * col * col * 0.9;
  let to_yiq = mat3x3f(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
  let to_rgb = mat3x3f(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
  var yiq = to_yiq * col;
  let hu = (u.p1.x - 0.5) * 1.5;
  let cs = cos(hu);
  let sn = sin(hu);
  yiq = vec3f(yiq.x, yiq.y * cs - yiq.z * sn, yiq.y * sn + yiq.z * cs);
  col = to_rgb * yiq;
  col += (h21(frag + fract(u.time_raw) * 61.0) - 0.5) * 0.14 * u.p1.z;
  col *= 1.0 - 0.2 * u.p1.z * modulo(floor(frag.y / u.dpr), 2.0);
  col = clamp(col, vec3f(0.0), vec3f(1.0));
  if (u.paper > 0.5) {
    col = on_paper(col);
  }
  return vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

const NEON_RAIN = /* wgsl */ `
fn scene(f: vec2f) -> vec3f {
  let p = f / u.res.y;
  let t = clock;
  var col = mix(u.deep * 0.45, u.deep * 0.75 + u.mid * 0.25, p.y);
  col += u.mid * 0.25 * fbm(p * vec2f(1.0, 3.0) + vec2f(t * 0.05, u.seed));
  for (var k = 0; k < 4; k++) {
    let fk = f32(k);
    let cw = (2.0 + fk * 1.6) * u.dpr;
    let cx = floor(f.x / cw);
    let lx = fract(f.x / cw) - 0.5;
    let sp = (0.5 + fk * 0.35) * (1.0 + h11(cx * 1.3 + fk * 7.0) * 0.9);
    let y = fract(p.y * (0.55 - fk * 0.06) + t * sp + h11(cx * 3.1 + fk + u.seed));
    let len = 0.12 + 0.1 * fk;
    let on = step(0.6 - fk * 0.08, h11(cx * 1.7 + fk * 3.0 + u.seed));
    let streak = hermite(len, 0.0, y) * on;
    let head = hermite(0.03, 0.0, y) * on;
    let wid = 1.0 - smoothstep(0.04, 0.18 + fk * 0.06, abs(lx));
    var c = mix(u.acc, u.light, h11(cx + fk * 2.0));
    c = mix(c, u.glow, step(0.8, h11(cx * 9.0 + fk)));
    col += c * streak * wid * (0.18 + fk * 0.3);
    col += mix(c, vec3f(1.0), 0.6) * head * wid * (0.3 + fk * 0.3);
    col += c * streak * 0.05 * (1.0 + fk);
  }
  for (var k = 0; k < 3; k++) {
    let fk = f32(k);
    let cell = floor(p.x * 4.0 + fk * 0.37);
    let ph = fract(t * (0.55 + 0.2 * fk) + h11(cell * 1.9 + fk * 9.0 + u.seed));
    let cc = vec2f((cell + 0.5 + (h11(cell * 2.3 + fk) - 0.5) * 0.7 - fk * 0.37) / 4.0, 0.06 + 0.04 * h11(cell + fk));
    let d = (p - cc) * vec2f(1.0, 4.5);
    let r = length(d);
    col += mix(u.acc, u.light, 0.5) * hermite(0.014, 0.0, abs(r - ph * 0.3)) * (1.0 - ph) * 0.8;
  }
  col += u.acc * 0.18 * exp(-p.y * 9.0);
  return col;
}
`;

const CODE_RAIN = /* wgsl */ `
// One layer of glyph columns: x is the lit glyphs, y the columns' heads.
fn layer(f: vec2f, cell: f32, spd: f32, seed: f32) -> vec2f {
  let cs = vec2f(cell * 0.78, cell) * u.dpr;
  let ci = floor(f / cs);
  let lf = fract(f / cs);
  let rows = u.res.y / cs.y;
  let y = rows - ci.y;
  let s = spd * (1.0 + h11(ci.x * 3.1 + seed) * 1.5);
  let off = h11(ci.x + seed * 2.0) * 50.0;
  let hd = modulo(clock * s + off, rows + 16.0);
  let dist = hd - y;
  let tr = 5.0 + h11(ci.x * 7.7 + seed) * 8.0;
  let b = select(0.0, pow(max(1.0 - dist / tr, 0.0), 1.5), dist > 0.0 && dist < tr);
  let gp = floor(lf * vec2f(5.0, 7.0));
  let inside = gp.x > 0.0 && gp.x < 4.0 && gp.y > 0.0 && gp.y < 6.0;
  let bit = select(0.0, 1.0, h21(ci * 13.0 + gp * 7.1 + floor(clock * (1.5 + h11(ci.y + seed) * 4.0))) > 0.5);
  let g = select(0.0, bit, inside);
  let head = select(0.0, g, dist > 0.0 && dist < 1.0);
  return vec2f(g * b, head);
}
fn scene(f: vec2f) -> vec3f {
  let p = f / u.res.y;
  var col = u.deep * 0.6 + u.mid * 0.18 * (1.0 - p.y);
  let l0 = layer(f, 5.0, 4.0, u.seed);
  let l1 = layer(f + vec2f(3.0, 0.0), 8.0, 6.0, u.seed + 5.0);
  let l2 = layer(f + vec2f(7.0, 0.0), 12.0, 9.0, u.seed + 11.0);
  col += u.acc * l0.x * 0.22;
  col += u.acc * l1.x * 0.55;
  col += u.acc * l2.x;
  col = mix(col, u.light, l1.y * 0.6);
  col = mix(col, u.light, l2.y);
  col += u.acc * 0.18 * (l1.x + l2.x);
  col += u.acc * 0.35 * step(0.996, fract(p.y * 2.0 - clock * 0.3));
  return col;
}
`;

const FLOW_LINES = /* wgsl */ `
fn scene(f: vec2f) -> vec3f {
  let p = f / u.res.y;
  let t = clock;
  let q = p * vec2f(1.1, 1.5) + u.seed;
  let w = vec2f(fbm(q + vec2f(0.0, t * 0.12)), fbm(q + vec2f(5.2, 1.3) - t * 0.1));
  let psi = fbm(q * 1.2 + w * 1.9 + vec2f(t * 0.07, 0.0));
  let n = psi * 34.0;
  let dn = min(fract(n), 1.0 - fract(n));
  let l = 1.0 - smoothstep(0.0, fwidth(n) * 1.4 + 0.02, dn);
  let phi = fbm(q * 2.2 + w * 2.0 - vec2f(t * 0.35, 0.0)) * 18.0;
  let dash = smoothstep(0.15, 0.85, 0.5 + 0.5 * sin(phi * 3.0 + floor(n) * 1.7 - t * 4.0));
  var col = u.deep * 0.55 + u.mid * 0.25 * smoothstep(0.3, 0.75, psi);
  var lc = mix(u.acc, u.light, fract(floor(n) * 0.37));
  lc = mix(lc, u.glow, step(0.82, fract(floor(n) * 0.61)));
  col += lc * l * (0.22 + 0.95 * dash);
  col += lc * 0.12 * dash * hermite(0.25, 0.0, dn);
  return col;
}
`;

const PIXEL_SORT = /* wgsl */ `
fn scene(f: vec2f) -> vec3f {
  let p = f / u.res.y;
  let t = clock;
  let rh = 1.5 * u.dpr;
  let ri = floor(f.y / rh);
  let ry = ri * rh / u.res.y;
  let q = vec2f(p.x * 1.2, ry * 2.2);
  let base = fbm(q + vec2f(t * 0.15, u.seed) + fbm(q * 2.0 + vec2f(t * 0.07, 0.0)));
  var col = ramp(base * 1.15 - 0.05);
  let x0 = fract(h11(ri * 1.7 + u.seed) + t * (0.05 + 0.1 * h11(ri * 3.1))) * (ar() + 1.2) - 0.6;
  let len = (0.3 + 1.1 * h11(ri * 5.3 + floor(t * 0.5 + h11(ri)))) * step(0.3, h11(ri * 7.7 + floor(t * 0.35 + h11(ri * 2.0))));
  // How far along the row's sorted run this pixel is (the prototype's u).
  let run = (p.x - x0) / max(len, 0.001);
  if (run > 0.0 && run < 1.0) {
    let hv = fbm(vec2f(x0 * 1.2, q.y) + vec2f(t * 0.15, u.seed));
    col = ramp(mix(hv * 1.1 + 0.35, hv * 0.25, run));
    col += u.light * 0.2 * (1.0 - run) * (1.0 - run);
  }
  let glitch = step(0.97, h11(ri * 0.37 + floor(t * 6.0)));
  col = mix(col, u.light, glitch * 0.35);
  col *= 0.9 + 0.1 * modulo(ri, 2.0);
  return col;
}
`;

const FLUID_GRADIENT = /* wgsl */ `
fn scene(f: vec2f) -> vec3f {
  let p = f / u.res.y;
  let t = clock * 0.7;
  var q = p * vec2f(0.9, 1.4) + u.seed;
  q += 0.5 * vec2f(sin(q.y * 2.0 + t), cos(q.x * 1.7 - t * 0.8));
  q += 0.35 * vec2f(sin(q.y * 3.1 - t * 1.2), cos(q.x * 2.3 + t));
  q += 0.2 * vec2f(sin(q.y * 5.3 + t * 1.7), cos(q.x * 4.1 - t * 1.3));
  let v = 0.5 + 0.5 * sin(q.x * 1.6 + q.y * 1.2 + t);
  // The prototype's u.
  let w = 0.5 + 0.5 * sin(q.x * 0.7 - q.y * 2.1 - t * 0.7);
  var col = mix(mix(u.deep, u.mid, v), mix(u.acc, u.light, v), w * w);
  col += u.light * 0.3 * pow(1.0 - abs(v - w), 14.0);
  col += (h21(f + fract(clock) * 37.0) - 0.5) * 0.07;
  return col;
}
`;

const MOIRE = /* wgsl */ `
fn scene(f: vec2f) -> vec3f {
  let p = f / u.res.y;
  let t = clock;
  let c1 = vec2f(ar() * 0.55 + 0.6 * sin(t * 0.31), 0.5 + 0.35 * cos(t * 0.27));
  let c2 = vec2f(ar() * 0.85 + 0.4 * cos(t * 0.23), 0.5 + 0.35 * sin(t * 0.37));
  let g1 = sin(length(p - c1) * 110.0 - t * 2.0);
  let g2 = sin(length(p - c2) * 110.0 + t * 1.5);
  let v = 0.5 + 0.5 * g1 * g2;
  let lines = 0.5 + 0.5 * sin(dot(p, vec2f(cos(t * 0.15), sin(t * 0.15))) * 150.0);
  var col = u.deep * 0.55;
  col = mix(col, mix(u.acc, u.light, v), smoothstep(0.35, 0.95, v) * 0.9);
  col = mix(col, u.mid, 0.18 * lines);
  col += u.acc * 0.15 * exp(-length(p - c2) * 2.0);
  return col;
}
`;

const VORONOI_GLOW = /* wgsl */ `
struct Cell {
  edge: f32,
  d1: f32,
  id: vec2f,
}
fn vor(q: vec2f, t: f32, jit: f32) -> Cell {
  let g = floor(q);
  let fr = fract(q);
  var d1 = 9.0;
  var d2 = 9.0;
  var id1 = g;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let o2 = vec2f(f32(x), f32(y));
      let pt = 0.5 + jit * sin(t * 0.7 + 6.2832 * h22(g + o2));
      let d = length(o2 + pt - fr);
      if (d < d1) {
        d2 = d1;
        d1 = d;
        id1 = g + o2;
      } else if (d < d2) {
        d2 = d;
      }
    }
  }
  return Cell(d2 - d1, d1, id1);
}
fn scene(f: vec2f) -> vec3f {
  let p = f / u.res.y;
  let t = clock;
  var col = u.deep * 0.4 + u.mid * 0.12 * fbm(p * 2.0 + u.seed);
  let jit = mix(0.25, 0.48, u.vars.x);
  for (var layer = 0; layer < 3; layer++) {
    let fl = f32(layer);
    let depth = fl / 2.0;
    let sc = mix(10.0, 3.4, depth) * mix(0.8, 1.25, u.vars.y);
    let q = p * sc + vec2f(t * (0.04 + 0.14 * fl), fl * 3.7) + u.seed + fl * 11.0;
    let cell = vor(q, t, jit);
    let id = cell.id;
    let bright = mix(0.22, 1.0, depth);
    let pulse = 0.5 + 0.5 * sin(t * 2.2 + h21(id) * 30.0);
    let lit = step(0.78, h21(id + floor(t * 0.35 + h21(id * 3.1))));
    let cellc = mix(u.mid, u.acc, h21(id * 1.3)) * (0.12 + 0.45 * pulse * lit) * bright;
    col = mix(col, col * 0.55 + cellc, 0.35 + 0.4 * depth);
    let w = mix(0.02, 0.055, depth);
    let e = hermite(w, 0.0, cell.edge);
    let travel = pow(0.5 + 0.5 * sin((q.x * 0.8 + q.y * 1.3) * 3.0 - t * (3.0 + fl) + h21(id) * 6.0), 10.0);
    var ec = mix(u.acc, u.light, 0.35 * pulse + 0.65 * travel);
    ec = mix(ec, u.glow, step(0.85, h21(id * 7.7)) * 0.6);
    col += ec * e * bright * (0.5 + 1.6 * travel);
    col += u.acc * hermite(0.22, 0.0, cell.edge) * 0.1 * bright;
    col += mix(u.glow, u.light, 0.5) * exp(-cell.d1 * 16.0) * (0.3 + 0.7 * pulse) * lit * bright * 1.2;
    if (u.vars.z > 0.6) {
      col += u.light * 0.5 * hermite(0.01, 0.0, abs(cell.d1 - fract(t * 0.5 + h21(id)) * 0.7)) * bright * lit;
    }
  }
  return col;
}
`;

const ASCII_FIELD = /* wgsl */ `
fn scene(f: vec2f) -> vec3f {
  let cs = vec2f(5.5, 8.0) * u.dpr;
  let ci = floor(f / cs);
  let lf = fract(f / cs);
  let cp = (ci + 0.5) * cs / u.res.y;
  let t = clock;
  let v = fbm(cp * vec2f(1.4, 2.4) + vec2f(t * 0.3, u.seed) + fbm(cp * 3.0 - t * 0.12));
  let level = smoothstep(0.28, 0.82, v);
  let li = floor(level * 7.99);
  let gp = floor(lf * vec2f(5.0, 7.0));
  let inside = gp.x > 0.0 && gp.x < 4.0 && gp.y > 0.0 && gp.y < 6.0;
  let lit = select(0.0, 1.0, inside && h21(gp * vec2f(1.7, 2.3) + li * 13.1) < (li + 0.5) / 8.0);
  let scan = exp(-abs(fract(cp.x * 0.18 - t * 0.25) - 0.5) * 20.0);
  let c = mix(u.mid * 1.3, mix(u.acc, u.light, level), level);
  return u.deep * 0.5 + c * lit * (0.3 + 0.9 * level) + u.light * lit * scan * 0.4;
}
`;

const SIGNAL_LINES = /* wgsl */ `
fn scene(f: vec2f) -> vec3f {
  let p = f / u.res.y;
  let t = clock;
  let px1 = 1.3 * u.dpr / u.res.y;
  let bg = u.deep * 0.45;
  var col = bg;
  for (var k = 0; k < 9; k++) {
    let i = f32(8 - k);
    let base = 0.1 + i * 0.1;
    let cx = ar() * (0.62 + 0.22 * sin(t * 0.23 + i * 0.7 + u.seed));
    // The prototype's pow(x, 2.0), squared outright: pow is undefined below zero.
    let ex = (p.x - cx) * 1.3;
    let env = exp(-ex * ex);
    let h = env * (0.17 * fbm(vec2f(p.x * 7.0 + i * 3.1 - t * 1.6, i + u.seed)) + 0.045 * sin(p.x * 24.0 - t * 4.5 + i));
    let y = base + h;
    if (p.y < y) { col = bg; }
    let d = abs(p.y - y);
    let lc = mix(u.mid * 1.5, mix(u.acc, u.light, env), 0.25 + 0.75 * env);
    col = mix(col, lc, hermite(px1 * 1.4, 0.0, d));
    col += lc * 0.22 * exp(-d / (px1 * 4.0)) * env;
  }
  return col;
}
`;

const TRUCHET_FLOW = /* wgsl */ `
fn scene(f: vec2f) -> vec3f {
  let p = f / u.res.y * 5.0 + vec2f(clock * 0.15, 0.0);
  let t = clock;
  let g = floor(p);
  var fr = fract(p) - 0.5;
  let flip = select(-1.0, 1.0, h21(g + u.seed) > 0.5);
  fr.x *= flip;
  let r1 = fr - vec2f(0.5);
  let r2 = fr + vec2f(0.5);
  let d1 = abs(length(r1) - 0.5);
  let d2 = abs(length(r2) - 0.5);
  let rel = select(r2, r1, d1 < d2);
  let d = min(d1, d2);
  let a = atan2(rel.y, rel.x);
  let flow = fract(a * 2.0 / 3.1416 * flip + t * 0.9 + (g.x + g.y) * 0.5);
  let line = hermite(0.075, 0.035, d);
  var col = u.deep * 0.55;
  col += mix(u.mid, u.acc, 0.4) * line * 0.45;
  col += mix(u.acc, u.light, flow) * line * smoothstep(0.55, 1.0, flow) * 1.3;
  col += u.acc * 0.1 * hermite(0.28, 0.0, d);
  return col;
}
`;

const ELECTRIC = /* wgsl */ `
fn scene(f: vec2f) -> vec3f {
  let p = f / u.res.y;
  let t = clock;
  var col = u.deep * 0.5 + u.mid * 0.15 * (1.0 - p.y);
  for (var k = 0; k < 3; k++) {
    let fk = f32(k);
    let q = p * vec2f(1.4, 2.8) + vec2f(t * (0.45 + fk * 0.25), fk * 4.0 + u.seed);
    let n = fbm(q + fbm(q * 2.0 + t * 1.3) * 0.6);
    let ridge = 1.0 - abs(n * 2.0 - 1.0);
    let bolt = pow(ridge, 16.0 + fk * 8.0);
    var c = mix(u.acc, u.light, 0.35 + 0.3 * fk);
    c = mix(c, u.glow, 0.3 * step(1.5, fk));
    col += c * bolt * (1.3 - fk * 0.3);
    col += c * pow(ridge, 4.0) * 0.06;
  }
  let flash = step(0.93, h11(floor(t * 4.0) + u.seed)) * 0.15;
  col += u.light * flash;
  return col;
}
`;

const KALEIDO = /* wgsl */ `
fn scene(f: vec2f) -> vec3f {
  let p = f / u.res.y;
  let t = clock;
  let cell = floor(p.x);
  let d = vec2f(fract(p.x) - 0.5, p.y - 0.5);
  let dir = modulo(cell, 2.0) * 2.0 - 1.0;
  var a = atan2(d.y, d.x) + t * 0.25 * dir;
  let r = length(d);
  let seg = 6.2832 / 6.0;
  a = modulo(a, seg);
  a = abs(a - seg * 0.5);
  let q = vec2f(cos(a), sin(a)) * r * 3.4;
  let v = fbm(q * 1.6 + cell * 7.1 + u.seed + fbm(q * 2.4 + vec2f(t * 0.2, -t * 0.15)));
  var col = ramp(v * 1.25 - 0.1);
  col = mix(col, u.deep * 0.5, smoothstep(0.62, 0.8, r) * 0.7);
  col += u.light * 0.2 * hermite(0.02, 0.0, abs(fract(r * 5.0 - t * 0.6) - 0.5) - 0.47) * step(r, 0.5);
  return col;
}
`;

const SPECTRUM = /* wgsl */ `
fn scene(f: vec2f) -> vec3f {
  let cs = 3.5 * u.dpr;
  let ci = floor(f / cs);
  let lf = fract(f / cs) - 0.5;
  let p = (ci + 0.5) * cs / u.res.y;
  let t = clock;
  let band = floor(p.x * 9.0);
  let bx = fract(p.x * 9.0);
  let hgt = 0.1 + 0.82 * pow(fbm(vec2f(band * 0.41 + u.seed, t * 1.7)), 1.2) * (0.65 + 0.35 * sin(t * 3.3 + band * 1.7));
  let gap = step(0.84, bx);
  let lit = (1.0 - gap) * step(p.y, hgt);
  let pk = (1.0 - gap) * step(abs(p.y - hgt - 0.07), cs / u.res.y * 0.6);
  let led = hermite(0.46, 0.3, max(abs(lf.x), abs(lf.y)));
  let c = mix(u.acc, u.light, clamp(p.y / max(hgt, 0.01), 0.0, 1.0));
  var col = u.deep * 0.45 + u.mid * 0.1 * led;
  col = mix(col, c, lit * led);
  col = mix(col, u.light, pk * led);
  col += u.acc * 0.12 * exp(-p.y * 6.0);
  return col;
}
`;

const NEON_TUNNEL = /* wgsl */ `
fn scene(f: vec2f) -> vec3f {
  let p = f / u.res.y;
  let t = clock;
  let c = vec2f(ar() * (0.6 + 0.12 * u.vars.w), 0.5);
  var d = rot(t * 0.25) * (p - c);
  d.y *= 1.3;
  let r = select(max(abs(d.x), abs(d.y)), length(d), u.vars.x > 0.5);
  let z = -log(max(r, 0.003)) * 4.5 + t * 1.6;
  let fz = fract(z);
  let ring = 1.0 - smoothstep(0.0, fwidth(z) * 1.5 + 0.03, min(fz, 1.0 - fz));
  let a = atan2(d.y, d.x);
  let sp = abs(fract(a / 6.2832 * 8.0 + 0.5) - 0.5);
  let spoke = hermite(0.035, 0.0, sp);
  let fade = smoothstep(0.0, 0.12, r) * (1.25 - r * 0.5);
  var lc = mix(u.acc, u.light, fract(floor(z) * 0.37));
  lc = mix(lc, u.glow, step(0.8, fract(floor(z) * 0.53)));
  var col = u.deep * 0.5;
  col += lc * ring * fade * 1.5;
  col += u.acc * spoke * fade * 0.3;
  col += mix(u.light, u.acc, 0.4) * exp(-r * 18.0) * 0.9;
  return col;
}
`;

const HYPERSPACE = /* wgsl */ `
fn scene(f: vec2f) -> vec3f {
  let p = f / u.res.y;
  let t = clock;
  let vp = vec2f(ar() * (0.8 + 0.1 * u.vars.w), 0.5);
  var d = p - vp;
  d.y *= 1.7;
  let r = length(d);
  let a = atan2(d.y, d.x);
  var col = u.deep * 0.6 + u.mid * 0.55 * exp(-r * 1.4);
  let bins = 110.0;
  // Which of the bins round the vanishing point this pixel falls in (the prototype's u).
  let slot = (a / 6.2832 + 0.5) * bins;
  let ai = floor(slot);
  let lane = abs(fract(slot) - 0.5);
  for (var k = 0; k < 3; k++) {
    let fk = f32(k);
    let h = h11(ai * 1.7 + fk * 31.0 + u.seed);
    let z = fract(h * 7.0 + t * (0.22 + 0.3 * h11(ai + fk)) * (1.0 + u.vars.x));
    let rs = z * z * 4.5;
    let len = 0.04 + z * 0.7;
    let on = step(0.5, h) * hermite(0.3, 0.0, lane) * smoothstep(rs, rs + 0.02, r) * hermite(rs + len, rs + len * 0.5, r);
    col += mix(u.acc, u.light, h * h) * on * (0.35 + z * 1.3);
  }
  if (u.vars.y > 0.5) {
    let ring = fract(r * 1.1 - t * 0.5);
    col += u.acc * 0.4 * hermite(0.04, 0.0, abs(ring - 0.5) - 0.46) * exp(-r * 0.7);
  }
  col += u.light * exp(-r * 14.0) * 1.3;
  col += u.acc * 0.45 * exp(-r * 3.5);
  return col;
}
`;

const DATAMOSH = /* wgsl */ `
fn base(p: vec2f) -> vec3f {
  let bars = floor(p.x * 6.0 + fbm(vec2f(p.y * 2.0, u.seed)) * 2.0);
  var c = select(u.mid, u.acc, h11(bars + u.seed) > 0.5);
  c = mix(c, u.light, step(0.85, h11(bars * 3.0)));
  return mix(u.deep, c, 0.3 + 0.7 * step(0.42, fbm(p * vec2f(3.0, 8.0) + u.seed)));
}
fn scene(f: vec2f) -> vec3f {
  let t = clock;
  let uv = f / u.res;
  var cc = uv - 0.5;
  cc *= 1.0 + dot(cc, cc) * vec2f(0.02, 0.25);
  var pp = (cc + 0.5) * vec2f(ar(), 1.0);
  let st = floor(t * 8.0);
  let burst = step(0.6, h11(st * 1.7 + u.seed));
  let band = floor(pp.y * 14.0);
  let g = h21(vec2f(band, st + u.seed));
  pp.x += (g - 0.5) * 0.6 * burst * step(0.55, g);
  let bl = floor(pp * vec2f(8.0, 6.0));
  if (h21(bl + st) > 0.93) { pp += (h22(bl + st) - 0.5) * 0.3 * burst; }
  let sp = 0.012 + 0.04 * burst;
  var col = vec3f(base(pp + vec2f(sp, 0.0)).r, base(pp).g, base(pp - vec2f(sp, 0.0)).b);
  col += u.light * 0.3 * hermite(0.025, 0.0, abs(uv.y - fract(t * 0.15))) * (0.5 + 0.5 * h21(vec2f(floor(f.x / (3.0 * u.dpr)), st)));
  col *= 0.8 + 0.2 * modulo(floor(f.y / u.dpr), 2.0);
  col += (h21(f + fract(t) * 91.0) - 0.5) * 0.08;
  col *= 1.0 - 1.2 * dot(cc, cc);
  return col;
}
`;

const HOLO_CARD = /* wgsl */ `
fn scene(f: vec2f) -> vec3f {
  let p = f / u.res.y;
  let t = clock;
  let n = fbm(p * vec2f(1.2, 2.0) + u.seed);
  let ang = p.x * 0.4 + p.y * 0.7 + n * 1.2 + sin(t * 0.4) * 0.3;
  var ir = 0.5 + 0.5 * cos(6.2832 * (ang + vec3f(0.0, 0.33, 0.67)));
  ir = mix(ir, mix(u.acc, u.light, 0.5 + 0.5 * sin(ang * 6.0)), 0.45);
  var col = mix(u.deep, ir, 0.55 + 0.25 * n);
  var h = p * 14.0;
  h.x *= 1.1547;
  h.y += modulo(floor(h.x), 2.0) * 0.5;
  let hf = abs(fract(h) - 0.5);
  col *= 0.9 + 0.15 * smoothstep(0.45, 0.5, max(hf.x * 1.5 + hf.y, hf.y * 2.0));
  let sx = modulo(t * 0.45, ar() + 2.0) - 1.0;
  // The prototype's pow(x, 2.0), squared outright: pow is undefined below zero.
  let sweep = (p.x - sx - p.y * 0.5) * 2.4;
  col += u.light * exp(-sweep * sweep) * 0.5;
  let gq = f / (4.0 * u.dpr);
  let gc = floor(gq);
  let gf = fract(gq) - 0.5;
  col += u.light * step(0.94, h21(gc + u.seed)) * pow(0.5 + 0.5 * sin(t * 4.0 + h21(gc) * 60.0), 8.0) * spark(gf, 0.3) * 0.9;
  return col;
}
`;

const LIQUID_CHROME = /* wgsl */ `
fn scene(f: vec2f) -> vec3f {
  let p = f / u.res.y;
  let t = clock;
  let s = vec2f(1.4, 2.2);
  let o2 = vec2f(t * 0.07, u.seed);
  let w = fbm(p * s + o2);
  let wx = fbm((p + vec2f(0.01, 0.0)) * s + o2);
  let h = p.y * 1.1 + 0.55 * w + 0.2 * sin(p.x * 1.8 + t * 0.35);
  let r = 0.5 + 0.5 * sin(h * 8.0);
  let ey = fract(h * 1.3 + (wx - w) * 4.0);
  var env = mix(u.deep, u.mid, ey * 2.0);
  if (ey > 0.5) { env = mix(u.acc, u.light, (ey - 0.5) * 2.0); }
  var col = mix(env, u.light, pow(r, 12.0) * 0.9);
  col = mix(col, u.deep * 0.6, pow(1.0 - r, 4.0) * 0.5);
  let sq = f / (6.0 * u.dpr);
  let sc = floor(sq);
  let sf = fract(sq) - 0.5;
  col += u.light * step(0.97, h21(sc + floor(t * 2.0))) * pow(r, 6.0) * spark(sf, 0.18);
  return col;
}
`;

const AURORA = /* wgsl */ `
fn sky(p: vec2f, t: f32, hz: f32) -> vec3f {
  var col = mix(u.deep * 0.9, u.deep * 0.5 + u.mid * 0.3, 1.0 - p.y);
  let sc = floor(p * u.res.y / (1.5 * u.dpr));
  if (h21(sc + u.seed) > 0.99) { col += u.light * 0.5 * (0.5 + 0.5 * sin(t * 2.0 + h21(sc) * 40.0)); }
  for (var k = 0; k < 2; k++) {
    let fk = f32(k);
    let base = 0.6 + 0.13 * fk + 0.08 * sin(p.x * 1.3 + t * 0.25 + fk * 2.0 + u.seed) + 0.06 * fbm(vec2f(p.x * 2.0 + t * 0.1, fk));
    let dy = p.y - base;
    let curtain = smoothstep(-0.03, 0.0, dy) * exp(-max(dy, 0.0) * (4.5 + fk * 3.0));
    let rays = 0.55 + 0.45 * fbm(vec2f(p.x * 18.0 + t * 0.6, fk * 3.0));
    var ac = mix(u.acc, u.light, clamp(dy * 3.0, 0.0, 1.0));
    ac = mix(ac, u.glow, 0.35 * fk);
    col += ac * curtain * rays * (1.0 - 0.3 * fk);
  }
  for (var k = 0; k < 3; k++) {
    let fk = f32(k);
    let m = hz + 0.36 - 0.12 * fk + 0.2 * (fbm(vec2f(p.x * (1.4 + fk) + u.seed + fk * 5.0, fk)) - 0.5) + 0.07 * abs(sin(p.x * (3.0 + fk * 2.0) + fk));
    if (p.y < m) {
      let mc = mix(mix(u.mid, u.deep, 0.35), u.deep * 0.3, fk / 2.0);
      let snow = hermite(0.07, 0.0, m - p.y) * step(fk, 1.5);
      col = mix(mc, mix(u.light, mc, 0.35), snow * 0.75);
      col += u.acc * 0.14 * (1.0 - fk / 2.0) * hermite(0.16, 0.0, m - p.y);
    }
  }
  return col;
}
fn scene(f: vec2f) -> vec3f {
  let p = f / u.res.y;
  let t = clock;
  let hz = 0.24;
  if (p.y >= hz) { return sky(p, t, hz); }
  let rp = vec2f(p.x + 0.006 * sin(p.y * 140.0 + t * 2.0), 2.0 * hz - p.y);
  var col = sky(rp, t, hz) * 0.5 + u.deep * 0.2;
  col += u.acc * 0.06 * (0.5 + 0.5 * sin(p.x * 50.0 + t * 1.5 + p.y * 220.0));
  return col;
}
`;

const NEON_CITY = /* wgsl */ `
fn scene(f: vec2f) -> vec3f {
  let px = 1.5 * u.dpr;
  let c = floor(f / px);
  let p = (c + 0.5) * px / u.res.y;
  let t = clock;
  let d = bayer4(c);
  let rows = u.res.y / px;
  let haze = mix(u.mid, u.acc, 0.4);
  let sy = p.y + (d - 0.5) * 0.08;
  var col = haze;
  if (sy > 0.72) {
    col = u.deep;
  } else if (sy > 0.5) {
    col = mix(u.deep, u.mid, 0.55);
  } else if (sy > 0.3) {
    col = mix(u.mid, haze, 0.55);
  }
  if (p.y > 0.5 && h21(c * 1.7 + u.seed) > 0.985) { col = mix(col, u.light, 0.4 + 0.6 * (0.5 + 0.5 * sin(t * 3.0 + h21(c) * 60.0))); }
  let fog = u.vars.x > 0.82;
  let rain = u.vars.x > 0.22 && u.vars.x <= 0.82;
  let mc = vec2f(ar() * (0.62 + 0.25 * u.vars.w), 0.74);
  let mr = length(p - mc);
  if (u.vars.y > 0.25) {
    col += u.light * 0.2 * exp(-mr * 7.0);
    if (mr < 0.12) { col = mix(u.light, vec3f(1.0), 0.35); }
    let crescent = u.vars.y > 0.7 && mr < 0.12 && length(p - mc - vec2f(0.045, 0.03)) < 0.105;
    if (crescent) { col = mix(col, u.deep, 0.9); }
  }
  if (fog) {
    for (var k = 0; k < 2; k++) {
      let fk = f32(k);
      let o2 = vec2f(ar() * (0.45 + 0.35 * fk), 0.0);
      let a = 0.4 * sin(t * 0.35 + fk * 2.0) + (fk - 0.5) * 0.7;
      let dir = vec2f(sin(a), cos(a));
      let rel = p - o2;
      let along = dot(rel, dir);
      let across = abs(rel.x * dir.y - rel.y * dir.x);
      col += u.light * 0.13 * hermite(0.02 + along * 0.06, 0.0, across) * step(0.0, along);
    }
  }
  for (var i = 0; i < 3; i++) {
    let fi = f32(i);
    let depth = fi / 2.0;
    let x = c.x + floor(t * (0.5 + fi * 1.3)) + u.seed * 17.0 + fi * 91.0;
    let bw = 3.0 + fi * 2.0 + floor(h11(fi + u.seed) * 2.0);
    let id = floor(x / bw);
    let lx = modulo(x, bw);
    let lot = h11(id * 3.7 + fi) > 0.86;
    let hg = mix(0.82, 0.46, depth) * (0.5 + 0.5 * h11(id * 7.1 + fi * 3.0 + u.seed));
    let wi = bw - 1.0;
    let in_wall = !lot && lx < wi && p.y < hg;
    if (in_wall) {
      let wall = mix(mix(haze, u.mid, 0.45), u.deep * 0.5, depth);
      col = wall;
      if (hg - p.y < 1.1 / rows) { col = mix(wall, u.acc, 0.3 + 0.45 * depth); }
      if (lx < 1.0) { col = mix(col, u.deep * 0.4, 0.35 * depth); }
      let win = modulo(lx, 2.0) > 0.5 && modulo(c.y + fi, 2.0) > 0.5 && p.y < hg - 2.0 / rows && lx < wi - 0.5;
      let on = h21(vec2f(id * 1.3, c.y) + floor(t * 0.3 * h11(id)) * 0.71);
      if (win && on > mix(0.72, 0.5, depth)) {
        let wc = select(u.light, u.acc, h11(id * 5.1 + c.y) > 0.4);
        col = mix(col, wc, mix(0.3, 1.0, depth));
      }
      let neon_sign = i == 2 && h11(id * 9.3 + u.seed) > 0.68 && lx >= wi - 1.5 && lx < wi - 0.5 && p.y < hg - 0.1 && p.y > hg - 0.5;
      if (neon_sign) {
        let fl = step(0.12, h11(floor(t * 9.0) + id * 3.1));
        col = mix(u.glow, vec3f(1.0), 0.25) * mix(0.35, 1.0, fl);
      }
    }
    let mast = i >= 1 && !lot && h11(id * 4.4 + fi) > 0.72 && abs(lx - floor(wi * 0.5)) < 0.5 && p.y >= hg && p.y < hg + 0.08 + 0.06 * fi;
    if (mast) {
      col = u.deep * 0.5;
      if (p.y > hg + 0.05 + 0.06 * fi) { col = mix(col, vec3f(1.0, 0.15, 0.25), step(0.5, fract(t * 0.8 + id * 0.3))); }
    }
  }
  for (var k = 0; k < 3; k++) {
    let fk = f32(k);
    let ly = 0.36 + 0.14 * fk + 0.05 * h11(fk + u.seed);
    let cx = fract(t * (0.05 + 0.035 * fk) + h11(fk * 3.0 + u.seed)) * (ar() + 0.4) - 0.2;
    let on_car = abs(p.y - ly) < 0.6 / rows && p.x > cx && p.x < cx + 0.06;
    if (on_car) { col = mix(col, select(u.light, vec3f(1.0, 0.28, 0.35), k == 1), 1.0 - (p.x - cx) / 0.06); }
  }
  if (fog) { col = mix(col, haze, 0.38 * (1.0 - p.y)); }
  if (rain) {
    let rx = c.x + c.y * 0.4;
    let cid = floor(rx / 2.0);
    let yy = fract(p.y * 0.8 + t * (1.3 + h11(cid) * 0.6) + h11(cid + u.seed));
    let drop = modulo(rx, 2.0) < 1.0 && yy < 0.1 && h11(cid * 2.3) > 0.5;
    if (drop) { col = mix(col, u.light, 0.4); }
    if (c.y < 2.0) { col = mix(col, u.acc, 0.25 * step(0.5, fract(c.x * 0.2 + t))); }
  }
  return col;
}
`;

/** Each piece's own `scene` (and its helpers), keyed by the piece it draws. */
const SCENE_CODE = {
  [PlateScene.NeonRain]: NEON_RAIN,
  [PlateScene.CodeRain]: CODE_RAIN,
  [PlateScene.FlowLines]: FLOW_LINES,
  [PlateScene.PixelSort]: PIXEL_SORT,
  [PlateScene.FluidGradient]: FLUID_GRADIENT,
  [PlateScene.Moire]: MOIRE,
  [PlateScene.VoronoiGlow]: VORONOI_GLOW,
  [PlateScene.AsciiField]: ASCII_FIELD,
  [PlateScene.SignalLines]: SIGNAL_LINES,
  [PlateScene.TruchetFlow]: TRUCHET_FLOW,
  [PlateScene.Electric]: ELECTRIC,
  [PlateScene.Kaleido]: KALEIDO,
  [PlateScene.Spectrum]: SPECTRUM,
  [PlateScene.NeonTunnel]: NEON_TUNNEL,
  [PlateScene.Hyperspace]: HYPERSPACE,
  [PlateScene.Datamosh]: DATAMOSH,
  [PlateScene.HoloCard]: HOLO_CARD,
  [PlateScene.LiquidChrome]: LIQUID_CHROME,
  [PlateScene.Aurora]: AURORA,
  [PlateScene.NeonCity]: NEON_CITY,
} as const satisfies Record<PlateScene, string>;

/** The WGSL module for piece `sceneIndex` (its index in PLATE_SCENES): `vs_main` covers the canvas, `fs_main` draws it. An unknown index draws the first piece. */
export function plateShader(sceneIndex: number): string {
  const scene = PLATE_SCENES[sceneIndex] ?? PlateScene.NeonRain;
  return plateShaderWith(SCENE_CODE[scene]);
}

/** The WGSL module for a piece's own code (its `fn scene(f: vec2f) -> vec3f` and helpers), on the shared prelude and dials. */
export function plateShaderWith(sceneCode: string): string {
  return `${PRELUDE}${PAPER}${sceneCode}${MAIN}`;
}

/**
 * The uniform block for one draw of `recipe` at `seconds` on the page's clock, into a canvas
 * `width` by `height` device pixels at `dpr` device pixels per CSS pixel, on `paper` for a light
 * theme. The recipe's seed shifts the clock, as the prototype's did; colours are plain `#rrggbb`
 * channels over 255.
 */
export function plateUniforms(
  recipe: PlateRecipe,
  seconds: number,
  width: number,
  height: number,
  dpr: number,
  paper = false,
): Float32Array<ArrayBuffer> {
  const data = new Float32Array(PLATE_UNIFORM_BYTES / 4);
  const { colors, dials } = recipe;
  data.set(rgb(colors.deep), Slot.Deep);
  data.set(rgb(colors.mid), Slot.Mid);
  data.set(rgb(colors.acc), Slot.Acc);
  data.set(rgb(colors.light), Slot.Light);
  data.set(rgb(colors.glow), Slot.Glow);
  data[Slot.Time] = seconds + recipe.seed * SEED_CLOCK_SHIFT;
  data[Slot.Seed] = recipe.seed;
  data[Slot.Dpr] = dpr;
  data.set(recipe.vars, Slot.Vars);
  data.set(
    [dials.zoom, dials.speed, dials.warp, dials.mirror, dials.hue, dials.glow, dials.grain, dials.steps],
    Slot.Dials,
  );
  data.set([width, height], Slot.Res);
  data[Slot.Paper] = paper ? 1 : 0;
  return data;
}
