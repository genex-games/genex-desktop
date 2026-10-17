/**
 * Datamosh: the picture as a broken video stream. Between keyframes each macroblock only carries
 * motion, so it drags the pixels it holds along a slow flow and the picture melts; blocks refresh
 * now and then (coarsely quantized, as a starved encoder sends them), sometimes from the wrong
 * place, and a keyframe wave sweeps through every so often to start the melt again. A body for the
 * shared prelude (`shared/backdrop-shader.ts`).
 */
export const DATAMOSH_SHADER = `const MOSH_BLOCKS: f32 = 52.0;

// The picture as a fresh block shows it: quantized to its four corners and banded, in the theme.
fn mosh_fresh(uv: vec2f, cell: vec2f, block: vec2f) -> vec3f {
  let st = uv;
  let half = block * 0.5 / backdrop.resolution;
  let corner = (floor(st / half) + 0.5) * half;
  let coarse = bd_luma(bd_picture(corner));
  let fine = bd_luma(bd_picture(st));
  let luma = mix(fine, coarse, 0.55);
  let tone = mix(1.0 - luma, luma, backdrop.dark);
  return bd_ramp(floor(pow(tone, 2.0) * 7.0 + 0.5) / 7.0 * 0.85);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let t = backdrop.time;
  let px = uv * backdrop.resolution;
  let size = backdrop.resolution.y / MOSH_BLOCKS * backdrop.scale;
  let block = vec2f(size);
  let cell = floor(px / block);
  let blockUv = (cell + 0.5) * block / backdrop.resolution;

  // The flow each block carries, in pixels per second: slow, curling, different per region.
  let flowAt = cell * 0.05 + vec2f(t * 0.025, -t * 0.02);
  let angle = bd_noise(flowAt) * BD_TAU * 2.0;
  let pace = (0.3 + bd_noise(flowAt + 17.0) * 1.1) * backdrop.resolution.y * 0.02;
  let motion = vec2f(cos(angle), sin(angle) * 0.6 + 0.35) * pace * backdrop.delta;

  // When a block refreshes: on its own clock, in a keyframe wave, or when there is nothing yet.
  // Pixels move whole: each block rounds its motion up or down at random, so a slow drift still
  // moves on average at any frame rate instead of rounding away.
  let rounding = bd_hash22(cell + fract(t * 61.7) * 113.0);
  let last = bd_history_pixel(px - motion + rounding - 0.5);
  let tick = floor(t * 0.6);
  let ownRefresh = step(0.988, bd_hash21(cell + tick * 0.37)) * step(fract(t * 0.6), 0.05);
  let wave = fract(t / 14.0) * 1.6 - 0.3;
  let swept = smoothstep(0.08, 0.0, abs(blockUv.x * 0.7 + blockUv.y * 0.3 - wave));
  let fresh = max(max(ownRefresh, swept), 1.0 - step(0.5, last.a));

  // A refresh sometimes lands from the wrong place: a block from elsewhere in the picture.
  let wrong = step(0.9, bd_hash21(cell * 1.7 + tick)) * ownRefresh;
  let source = uv + (bd_hash22(cell + tick) - 0.5) * block * 6.0 / backdrop.resolution * wrong;
  let picture = mosh_fresh(source, cell, block);
  var color = select(last.rgb, picture, fresh > 0.5);
  // The stream slowly heals towards the picture; a block of wrong chroma flashes now and then
  // and is dragged along with the rest.
  color = mix(color, picture, 1.0 - exp(-backdrop.delta * 0.2));
  let tint = step(0.9992, bd_hash21(cell + floor(t * 1.5) * 0.11)) * step(fract(t * 1.5), 0.34);
  color = mix(color, color * 0.4 + backdrop.accent.rgb * 0.8, tint * 0.6);
  return vec4f(color, 1.0);
}
`;
