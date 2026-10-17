/**
 * Phosphor: katakana rain on a tube. Each drop's head glides down, white hot, and burns a stepped
 * trail into the phosphor that cools from the ink to the accent; the glyphs it passes stay lit a
 * while. Smaller, dimmer rain falls slower further back. The picture shows through: the rain is
 * brighter where it is bright. A glyph row's height in points, at size 1: small, so the rain reads
 * as text. A body for the shared prelude (`shared/backdrop-shader.ts`).
 */
export const PHOSPHOR_SHADER = `const RAIN_ROW_POINTS: f32 = 9.5;
const RAIN_ASPECT: f32 = 0.714;

struct Drop {
  head: f32,     // the head's row, continuous
  length: f32,   // its tail, in rows
}

fn rain_drop(column: f32, t: f32, rows: f32, layer: f32) -> Drop {
  let speed = 0.8 + bd_hash21(vec2f(column, 1.0 + layer)) * 1.6;
  let length = 10.0 + bd_hash21(vec2f(column, 2.0 + layer)) * 26.0;
  let span = rows + length + bd_hash21(vec2f(column, 5.0 + layer)) * rows * 0.9;
  let head = fract(t * speed / span + bd_hash21(vec2f(column, 3.0 + layer))) * span;
  return Drop(head, length);
}

// The tail's light at a row behind a head (1 just behind it, 0 past its end).
fn rain_tail(drop: Drop, row: f32) -> f32 {
  let behind = floor(drop.head) - row;
  let fade = pow(clamp(1.0 - behind / drop.length, 0.0, 1.0), 1.6);
  return step(1.0, behind) * fade;
}

fn rain_index(cell: vec2f, t: f32, rate: f32) -> f32 {
  let pick = floor(t * rate + bd_hash21(cell) * 31.0);
  return floor(bd_hash21(cell * 1.37 + pick * 0.173) * BD_GLYPH_COUNT);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let t = backdrop.time;
  let page = backdrop.page.rgb;
  let row = RAIN_ROW_POINTS * backdrop.scale * backdrop.density;
  let rows = backdrop.resolution.y / row;
  let size = vec2f(row * RAIN_ASPECT, row);

  // Now and then a band of rows slips sideways for a moment.
  let tearClock = floor(t * 1.5);
  let band = floor(uv.y * 36.0);
  let torn = step(0.965, bd_hash21(vec2f(band, tearClock)));
  let tear = torn * floor((bd_hash21(vec2f(band + 3.0, tearClock)) - 0.5) * 8.0) * size.x;
  let px = uv * backdrop.resolution + vec2f(tear, 0.0);
  let at = px / size;
  let cell = floor(at);
  let local = fract(at);

  let first = rain_drop(cell.x, t, rows, 0.0);
  let second = rain_drop(cell.x, t * 0.85 + 40.0, rows, 10.0);
  let tail = max(rain_tail(first, cell.y), rain_tail(second, cell.y) * 0.5);

  // The picture at the cell, as light.
  let centre = (cell + 0.5) * size / backdrop.resolution;
  let shown = bd_luma(bd_picture(centre));
  let image = smoothstep(0.1, 0.92, mix(1.0 - shown, shown, backdrop.dark));

  // The glyphs in place: lit by the tails, and faintly by the picture everywhere.
  let mirrored = vec2f(1.0 - local.x, local.y) * 1.12 - 0.06;
  let glyph = bd_glyph(rain_index(cell, t, 0.15 + bd_hash21(cell + 7.0) * 0.7), mirrored);
  let still = glyph * (image * image * 0.1 + pow(image, 6.0) * 0.35);
  let falling = glyph * tail * (0.6 + image * 1.4);

  // The heads glide between rows, changing glyph every few frames.
  let firstHead = bd_glyph(rain_index(vec2f(cell.x, floor(first.head)), t, 12.0), vec2f(mirrored.x, (at.y - first.head) * 1.12 - 0.06));
  let secondHead = bd_glyph(rain_index(vec2f(cell.x + 0.5, floor(second.head)), t, 12.0), vec2f(mirrored.x, (at.y - second.head) * 1.12 - 0.06));
  let hot = max(firstHead, secondHead * 0.55) * (0.8 + image * 1.4);

  // Further back: a finer grid, offset so its columns fall between these, slower and dimmer.
  let deepSize = size / 1.8;
  let deepAt = (px + vec2f(deepSize.x * 0.37, 0.0)) / deepSize;
  let deepCell = floor(deepAt);
  let deepLocal = fract(deepAt);
  let deep = rain_drop(deepCell.x + 300.0, t * 0.6, rows * 1.8, 20.0);
  let deepGlyph = bd_glyph(rain_index(deepCell + 300.0, t, 0.8), vec2f(1.0 - deepLocal.x, deepLocal.y) * 1.12 - 0.06);
  let deepHead = step(abs(deepCell.y - floor(deep.head)), 0.5);
  let behind = deepGlyph * (rain_tail(deep, deepCell.y) * 0.3 + deepHead * 0.7) * (0.5 + image) * (1.0 - glyph);

  let cooled = mix(backdrop.accent.rgb, backdrop.ink.rgb, tail * tail);
  var light = cooled * falling + backdrop.ink.rgb * still + mix(backdrop.ink.rgb, vec3f(1.0), 0.7) * hot * 1.6;
  light += mix(backdrop.accent.rgb, backdrop.ink.rgb, 0.3) * behind;
  let toPointer = (uv - backdrop.pointer) * vec2f(bd_aspect(), 1.0);
  light *= 1.0 + exp(-dot(toPointer, toPointer) * 10.0) * 0.5;

  // The phosphor's memory: how lit each pixel was, kept in the frame's alpha (1 + level) and
  // fading; shown in steps, as a digital eye reads a phosphor, cooled to the accent.
  let last = bd_history(uv);
  let memory = max(last.a - 1.0, 0.0) * exp(-backdrop.delta * 0.9) * step(0.5, last.a);
  let now = bd_luma(light);
  let ghost = backdrop.accent.rgb * mix(1.8, 1.0, memory) * floor(memory * 12.0) / 12.0 * (0.18 + glyph * 0.9);

  let lit = page + max(light, ghost);
  let covered = clamp(falling + still + hot + behind * 0.6, 0.0, 1.0);
  let inked = mix(page - (vec3f(1.0) - backdrop.ink.rgb) * covered, backdrop.accent.rgb, floor(memory * 12.0) / 12.0 * (0.12 + glyph * 0.6) * (1.0 - covered));
  let color = mix(inked, lit, backdrop.dark);

  // The tube: fine scanlines and darker corners.
  let scan = 0.88 + 0.12 * sin(px.y * 1.7);
  let corner = uv - 0.5;
  let vignette = 1.0 - dot(corner, corner) * 0.8;
  return vec4f(mix(color, page + (color - page) * scan * vignette, backdrop.dark), 1.0 + max(now, memory));
}
`;
