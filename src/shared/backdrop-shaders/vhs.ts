/**
 * VHS: the picture played off a worn tape. Luma is soft and over-sharpened (the white halos on
 * edges); colour runs late and smeared to the right; the tape drifts, a tracking bar rolls
 * through, the head switch frays the bottom lines, and now and then the signal drops out. A body
 * for the shared prelude (`shared/backdrop-shader.ts`).
 */
export const VHS_SHADER = `fn vhs_luma(st: vec2f) -> f32 {
  return bd_luma(bd_picture(st));
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let t = backdrop.time;
  let px = 1.0 / backdrop.resolution;
  let line = floor(uv.y * backdrop.resolution.y * 0.5);
  let field = floor(t * 30.0);

  // The tape: a slow drift and breathing zoom, so a still reads as a recording.
  let zoom = 1.06 + 0.02 * sin(t * 0.035);
  var st = (uv - 0.5) / zoom + 0.5 + vec2f(sin(t * 0.025), cos(t * 0.02)) * 0.012;

  // Tracking: a bar rolls down and lines inside it slip; every line jitters a little.
  let barY = fract(t * 0.035);
  let inBar = smoothstep(0.09, 0.0, abs(uv.y - barY));
  st.x += (bd_noise(vec2f(line * 0.7, t * 7.0)) - 0.5) * 0.05 * inBar;
  st.x += (bd_hash21(vec2f(line, floor(t * 12.0))) - 0.5) * 0.0012;
  // The head switch frays the last lines.
  let bottom = smoothstep(0.94, 0.985, uv.y);
  st.x += bottom * (bd_noise(vec2f(line * 2.3, t * 11.0)) - 0.3) * 0.06;
  // A rare glitch: bands of lines shift for a moment.
  let glitchClock = floor(t * 0.3);
  let glitchOn = step(0.78, bd_hash21(vec2f(glitchClock, 1.0))) * step(fract(t * 0.3), 0.12);
  let bandRow = floor(uv.y * 28.0);
  st.x += glitchOn * step(0.82, bd_hash21(vec2f(bandRow, glitchClock))) * (bd_hash21(vec2f(bandRow, glitchClock + 3.0)) - 0.5) * 0.09;

  // Luma: tape bandwidth softens it, the deck's sharpening rings around every edge.
  let w = px.x * 1.6;
  let soft = vhs_luma(st) * 0.4 + (vhs_luma(st + vec2f(w, 0.0)) + vhs_luma(st - vec2f(w, 0.0))) * 0.3;
  let wide = (vhs_luma(st + vec2f(w * 5.0, 0.0)) + vhs_luma(st - vec2f(w * 5.0, 0.0)) + soft) / 3.0;
  let luma = soft + (soft - wide) * 1.4;
  // Colour runs late: a wide smear read a little to the left, so it trails right of the shapes.
  let late = st - vec2f(w * 7.0, 0.0);
  let smear = (vhs_luma(late) + vhs_luma(late - vec2f(w * 6.0, 0.0)) + vhs_luma(late - vec2f(w * 12.0, 0.0))) / 3.0;
  // The signal's echo, faint and to the right.
  let echo = vhs_luma(st - vec2f(0.014, 0.0));

  let dark = backdrop.dark;
  let tone = mix(1.0 - luma, luma, dark);
  let chroma = smoothstep(0.15, 0.75, mix(1.0 - smear, smear, dark));
  var color = backdrop.page.rgb;
  color = bd_glow(color, backdrop.accent.rgb, chroma * 0.45);
  color = bd_glow(color, backdrop.ink.rgb, smoothstep(0.45, 1.0, tone) * mix(0.7, 0.62, dark) + smoothstep(0.88, 1.05, tone) * dark * 0.6);
  color = bd_glow(color, backdrop.ink.rgb, mix(1.0 - echo, echo, dark) * 0.07);

  // Tape: scanlines, snow, the bar's light, dropouts (a white dash on a line), a frayed bottom.
  let scan = 0.8 + 0.2 * sin(uv.y * backdrop.resolution.y * 2.0);
  color = backdrop.page.rgb + (color - backdrop.page.rgb) * scan;
  let snow = bd_hash21(uv * backdrop.resolution + fract(t * 37.0) * 91.0);
  let dashStart = bd_hash21(vec2f(line, field + 0.5));
  let dropout = step(0.9985, dashStart) * step(abs(uv.x - bd_hash21(vec2f(line + 9.0, field))), 0.04 + dashStart * 0.03);
  color = bd_glow(color, backdrop.ink.rgb, (snow - 0.5) * 0.05 + inBar * 0.06 + snow * (inBar * 0.12 + bottom * 0.4) + dropout * 1.4);
  let corner = uv - 0.5;
  color = mix(backdrop.page.rgb, color, 1.0 - dot(corner, corner) * 0.5 * dark);
  return vec4f(color, 1.0);
}
`;
