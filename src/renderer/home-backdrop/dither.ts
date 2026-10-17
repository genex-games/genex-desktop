/**
 * The picture effects (lines, dots, characters) drawn over a live background on the GPU, every
 * frame: the shader and its glow are composited into a smaller scene (`pipeline.ts`), and this pass
 * reads it with the picture's settings (levels, gamma, grain, threshold), as a light page reads a
 * picture whichever the theme, drawing each mark in the scene's own colour there.
 * Sizes are in points, as in `draw.ts`, so an effect looks the same over a picture and over a shader.
 */
import { BackdropEffect, type BackdropSettings, DotGrid } from "./settings.ts";

/** Each effect's number in the shader. */
const DITHER_KIND = {
  [BackdropEffect.None]: 0,
  [BackdropEffect.Lines]: 1,
  [BackdropEffect.Dots]: 2,
  [BackdropEffect.Ascii]: 3,
} as const satisfies Record<BackdropEffect, number>;

/** ASCII: a row's height for a character's size, as `draw.ts` sets it. */
export const ASCII_LINE_HEIGHT = 1.2;

/** A glyph sheet's measure: how wide a character is for its size. */
export interface GlyphMeasure {
  advance: number;
  count: number;
}

/** The effect pass. Its marks follow `draw.ts`: a hairline and segments, a turned dot grid, a ramp of glyphs. */
export const DITHER_SHADER = `struct Dither {
  page: vec4f,
  points: vec2f,
  lineCell: vec2f,
  asciiCell: vec2f,
  kind: u32,
  inkIsLight: u32,
  benday: u32,
  glyphCount: u32,
  dotStep: f32,
  dotMin: f32,
  dotMax: f32,
  dotAngle: f32,
  dotCorner: f32,
  dotNoise: f32,
  blackPoint: f32,
  whitePoint: f32,
  gamma: f32,
  grain: f32,
  threshold: f32,
  pixel: f32,
}
@group(0) @binding(0) var<uniform> dither: Dither;
@group(0) @binding(1) var scene: texture_2d<f32>;
@group(0) @binding(2) var sceneSampler: sampler;
@group(0) @binding(3) var glyphs: texture_2d<f32>;

fn dither_hash(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}

// The scene's colour at a point of the frame (in points), and the ink it wants there. A live scene
// is already drawn for its page (light on a dark one, dark on a light one), so it is read as its
// distance from the page, the way a light page reads it: the levels mean the same in both themes.
fn dither_ink(at: vec2f, seed: vec2f) -> vec4f {
  let uv = clamp(at / dither.points, vec2f(0.0), vec2f(1.0));
  let color = textureSampleLevel(scene, sceneSampler, uv, 0.0).rgb;
  let weights = vec3f(0.2126, 0.7152, 0.0722);
  let luminance = dot(color, weights) * 255.0;
  let fromPage = max(luminance - dot(dither.page.rgb, weights) * 255.0, 0.0);
  let value = select(luminance, 255.0 - fromPage, dither.inkIsLight == 1u);
  let span = max(1.0, dither.whitePoint - dither.blackPoint);
  let level = pow(clamp((value - dither.blackPoint) / span, 0.0, 1.0), 1.0 / dither.gamma);
  let ink = 1.0 - clamp(level + (dither_hash(seed) - 0.5) * dither.grain, 0.0, 1.0);
  return vec4f(color, select(ink, 0.0, ink * 255.0 < dither.threshold));
}

// A mark's colour: the scene's there, brought to full brightness on a dark page as its ink grows,
// so a mark where the scene is bare stays the page's colour; as it is on a light page.
fn dither_tint(color: vec3f, ink: f32) -> vec3f {
  let peak = max(max(color.r, color.g), max(color.b, 0.0001));
  let vivid = mix(color, color / peak, smoothstep(0.0, 0.5, ink));
  return select(color, vivid, dither.inkIsLight == 1u);
}

// How much of a pixel lies inside an edge at signed distance d (points; inside is positive).
fn dither_cover(d: f32) -> f32 {
  return clamp(d / dither.pixel + 0.5, 0.0, 1.0);
}

fn dither_lines(p: vec2f) -> vec4f {
  let cell = dither.lineCell;
  let id = floor(p / cell);
  let centre = (id + 0.5) * cell;
  let ink = dither_ink(centre, id);
  let hair = min(0.6, cell.x * 0.3);
  let width = ink.a * cell.x * 0.92;
  let across = abs(p.x - centre.x);
  let inRow = step(abs(p.y - centre.y), cell.y * (1.0 - 0.18) * 0.5);
  let hairline = dither_cover(hair * 0.5 - across) * ink.a;
  let segment = dither_cover(width * 0.5 - across) * inRow * step(hair, width);
  return vec4f(dither_tint(ink.rgb, ink.a), max(hairline, segment));
}

fn dither_dots(p: vec2f) -> vec4f {
  let centre = dither.points * 0.5;
  let c = cos(dither.dotAngle);
  let s = sin(dither.dotAngle);
  let rel = p - centre;
  let q = vec2f(rel.x * c + rel.y * s, -rel.x * s + rel.y * c);
  let stepSize = dither.dotStep;
  let reach = i32(clamp(ceil((dither.dotMax * 0.5 + stepSize * dither.dotNoise * 0.5) / stepSize), 0.0, 2.0));
  let row0 = round(q.y / stepSize);
  var best = vec4f(0.0);
  for (var j = -2; j <= 2; j++) {
    if (abs(j) > reach) { continue; }
    let row = row0 + f32(j);
    let shift = select(0.0, stepSize * 0.5, dither.benday == 1u && abs(row) % 2.0 == 1.0);
    let col0 = round((q.x - shift) / stepSize);
    for (var i = -2; i <= 2; i++) {
      if (abs(i) > reach) { continue; }
      let id = vec2f(col0 + f32(i), row);
      let stray = (vec2f(dither_hash(id), dither_hash(id + 31.7)) - 0.5) * stepSize * dither.dotNoise;
      let place = vec2f(id.x * stepSize + shift, id.y * stepSize) + stray;
      let onFrame = centre + vec2f(place.x * c - place.y * s, place.x * s + place.y * c);
      let ink = dither_ink(onFrame, id);
      let half = (dither.dotMin + ink.a * (dither.dotMax - dither.dotMin)) * 0.5;
      if (half < 0.2) { continue; }
      let radius = min(dither.dotCorner, half);
      let local = abs(q - place) - vec2f(half - radius);
      let inside = dither_cover(radius - length(max(local, vec2f(0.0))));
      if (inside > best.a) { best = vec4f(dither_tint(ink.rgb, ink.a), inside); }
    }
  }
  return best;
}

fn dither_ascii(p: vec2f) -> vec4f {
  let cell = dither.asciiCell;
  let id = floor(p / cell);
  let ink = dither_ink((id + 0.5) * cell, id);
  let count = f32(dither.glyphCount);
  let index = min(count - 1.0, round(ink.a * (count - 1.0)));
  let local = fract(p / cell);
  let glyph = textureSampleLevel(glyphs, sceneSampler, vec2f((index + local.x) / count, local.y), 0.0).a;
  return vec4f(dither_tint(ink.rgb, ink.a), glyph);
}


@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = uv * dither.points;
  var mark = vec4f(0.0);
  if (dither.kind == 1u) {
    mark = dither_lines(p);
  } else if (dither.kind == 2u) {
    mark = dither_dots(p);
  } else {
    mark = dither_ascii(p);
  }
  return vec4f(mix(dither.page.rgb, mark.rgb, mark.a), 1.0);
}
`;

/** What the pass needs beyond the settings: the frame in points, the page, and the glyph sheet. */
export interface DitherFrame {
  points: [number, number];
  density: number;
  page: [number, number, number, number];
  inkIsLight: boolean;
  glyphs: GlyphMeasure;
}

/** The pass's `dither` uniform for an effect over a frame. */
export function ditherUniform(settings: BackdropSettings, frame: DitherFrame) {
  const [width] = frame.points;
  const glyphSize = width / settings.asciiColumns / frame.glyphs.advance;
  return {
    page: frame.page,
    points: frame.points,
    lineCell: [width / settings.lineColumns, frame.points[1] / settings.lineRows],
    asciiCell: [width / settings.asciiColumns, glyphSize * ASCII_LINE_HEIGHT],
    kind: DITHER_KIND[settings.effect],
    inkIsLight: frame.inkIsLight ? 1 : 0,
    benday: settings.dotGrid === DotGrid.Benday ? 1 : 0,
    glyphCount: Math.max(1, frame.glyphs.count),
    dotStep: settings.dotStep,
    dotMin: settings.dotMin,
    dotMax: settings.dotMax,
    dotAngle: (settings.dotAngle * Math.PI) / 180,
    dotCorner: settings.dotCorner,
    dotNoise: settings.dotNoise,
    blackPoint: settings.blackPoint,
    whitePoint: settings.whitePoint,
    gamma: settings.gamma,
    grain: settings.grain,
    threshold: settings.threshold,
    pixel: 1 / frame.density,
  };
}
