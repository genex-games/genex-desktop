/**
 * Thermal: the picture through a thermal camera, white-hot. Brightness reads as heat on a fine
 * sensor, softly enlarged; the theme's colours are its palette; thin isotherms contour the heat
 * like a survey map, one brighter isotherm sweeping slowly through the levels; edges are traced
 * over it; the gain hunts slowly; heat shimmers upward. The pointer is warm and leaves heat that
 * spreads and cools; the frame's alpha keeps it. A body for the shared prelude (`shared/backdrop-
 * shader.ts`).
 */
export const THERMAL_SHADER = `const THERMAL_ROWS: f32 = 220.0;

fn thermal_heat(st: vec2f) -> f32 {
  return bd_luma(bd_picture(st));
}

// The sensor: the picture read at a coarse grid of pixels, enlarged smoothly between them.
fn thermal_sensor(st: vec2f, rows: f32) -> f32 {
  let grid = vec2f(rows * bd_aspect(), rows);
  let p = st * grid - 0.5;
  let i = floor(p);
  let f = smoothstep(vec2f(0.0), vec2f(1.0), fract(p));
  let a = thermal_heat((i + vec2f(0.5, 0.5)) / grid);
  let b = thermal_heat((i + vec2f(1.5, 0.5)) / grid);
  let c = thermal_heat((i + vec2f(0.5, 1.5)) / grid);
  let d = thermal_heat((i + vec2f(1.5, 1.5)) / grid);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let t = backdrop.time;
  let px = 1.0 / backdrop.resolution;
  let rows = THERMAL_ROWS / backdrop.scale;

  // Heat shimmer rising, and a slow drift of the camera.
  let rise = bd_noise(vec2f(uv.x * 14.0, uv.y * 8.0 + t * 0.6)) - 0.5;
  let st = (uv - 0.5) / 1.05 + 0.5 + vec2f(rise * 0.004, 0.0) + vec2f(sin(t * 0.02), cos(t * 0.016)) * 0.01;
  var heat = thermal_sensor(st, rows);

  // The pointer's heat: laid where it is, spread a little and cooled each frame.
  let last = bd_history(uv);
  let spread = (bd_history(uv + vec2f(px.x * 2.0, 0.0)).a + bd_history(uv - vec2f(px.x * 2.0, 0.0)).a
    + bd_history(uv + vec2f(0.0, px.y * 2.0)).a + bd_history(uv - vec2f(0.0, px.y * 2.0)).a) * 0.25;
  let before = max(mix(last.a, spread, 0.6) - 1.0, 0.0) * exp(-backdrop.delta * 0.7) * step(0.5, last.a);
  let toPointer = (uv - backdrop.pointer) * vec2f(bd_aspect(), 1.0);
  let warmth = max(before, exp(-dot(toPointer, toPointer) * 260.0) * 0.9);

  // The gain hunts between what it calls cold and hot.
  let low = 0.12 + 0.08 * sin(t * 0.1);
  let high = 0.82 + 0.08 * sin(t * 0.08 + 1.3);
  heat = clamp((heat - low) / (high - low), 0.0, 1.3) + warmth;
  let clean = heat;

  // The sensor's fine noise.
  heat += (bd_hash21(uv * backdrop.resolution + fract(t * 29.0) * 43.0) - 0.5) * 0.025;

  // Edges of the picture traced over the heat.
  let e = px * 1.5;
  let gx = thermal_heat(st + vec2f(e.x, 0.0)) - thermal_heat(st - vec2f(e.x, 0.0));
  let gy = thermal_heat(st + vec2f(0.0, e.y)) - thermal_heat(st - vec2f(0.0, e.y));
  let edge = smoothstep(0.06, 0.3, length(vec2f(gx, gy)));

  // Isotherms a pixel wide whatever the heat's slope: seven levels, faint, drifting slowly up
  // through the heat; and one brighter isotherm sweeping up and down.
  let slope = max(fwidth(clean), 0.0005);
  let contour = abs(fract(clean * 7.0 - t * 0.03) - 0.5) / 7.0;
  let contours = (1.0 - smoothstep(0.0, slope * 1.2, abs(contour - 0.5 / 7.0))) * step(0.06, clean);
  let level = 0.25 + 0.5 * (0.5 + 0.5 * sin(t * 0.12));
  let isotherm = (1.0 - smoothstep(slope * 0.8, slope * 2.4, abs(clean - level))) * step(0.06, clean);

  // White-hot in the theme's colours: most of the scene reads cold, only the warmest glows.
  let shaped = pow(clamp(heat, 0.0, 1.6), 2.2);
  var color = backdrop.page.rgb;
  color = bd_glow(color, backdrop.ink.rgb, shaped * mix(0.7, 0.85, backdrop.dark) + max(shaped - 1.0, 0.0) * 0.5);
  color = bd_glow(color, backdrop.ink.rgb, edge * 0.14);
  color = bd_glow(color, backdrop.accent.rgb, contours * 0.35);
  color = mix(color, backdrop.accent.rgb * mix(1.0, 1.5, backdrop.dark), isotherm * 0.9);

  let corner = uv - 0.5;
  color = mix(backdrop.page.rgb, color, 1.0 - dot(corner, corner) * 0.6 * backdrop.dark);
  return vec4f(color, 1.0 + warmth);
}
`;
