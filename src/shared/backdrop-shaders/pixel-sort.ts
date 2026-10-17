/**
 * Pixel sort: the picture melting into sorted streaks. Inside each run of mid-bright pixels the
 * brighter sink and the darker rise, one comparison per frame between neighbours (an odd-even sort
 * run on the frame before), so the streaks grow and drip while you watch; a slow scan restores the
 * picture column by column and the melt begins again behind it. A body for the shared prelude
 * (`shared/backdrop-shader.ts`).
 */
export const PIXEL_SORT_SHADER = `const SORT_ROWS: f32 = 450.0;

fn sort_tone(st: vec2f) -> f32 {
  let luma = bd_luma(bd_picture(st));
  return mix(1.0 - luma, luma, backdrop.dark);
}

fn sort_color(tone: f32) -> vec3f {
  return bd_ramp(pow(tone, 1.6) * 0.95);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let t = backdrop.time;
  let size = max(1.0, floor(backdrop.resolution.y / (SORT_ROWS / backdrop.scale)));
  let rows = floor(backdrop.resolution.y / size);
  let cell = floor(uv * backdrop.resolution / size);
  let at = (cell + 0.5) * size;
  let mine = bd_history_pixel(at);
  // The frame's alpha keeps which pairs compare: 1.25 on even frames, 1.75 on odd ones.
  let parity = step(1.5, mine.a);
  let next = select(1.25, 1.75, parity < 0.5);
  let picture = sort_tone(at / backdrop.resolution);

  // The scan restores a band of columns, sweeping across every so often; nothing yet restores all.
  let scan = fract(t / 24.0) * 1.3 - 0.15;
  let restored = step(abs(uv.x - scan), 0.012) + step(mine.a, 0.5);
  if (restored > 0.5) {
    return vec4f(sort_color(picture), next);
  }

  // This frame's partner: the cell below on matching rows, the one above on the others.
  let down = (cell.y + parity) % 2.0 < 0.5;
  let partnerCell = cell + vec2f(0.0, select(-1.0, 1.0, down));
  let theirs = bd_history_pixel((partnerCell + 0.5) * size);
  // Runs are the picture's mid-bright stretches; their bounds breathe slowly.
  let low = 0.28 + 0.12 * sin(t * 0.11);
  let high = 0.97;
  let partnerTone = sort_tone((partnerCell + 0.5) * size / backdrop.resolution);
  let inRun = picture > low && picture < high && partnerTone > low && partnerTone < high;
  let inside = partnerCell.y >= 0.0 && partnerCell.y < rows;
  let upper = select(theirs, mine, down);
  let lower = select(mine, theirs, down);
  // Each pair compares on about half the frames, the same draw for both of its cells: the melt
  // goes slower and less evenly.
  let pairTop = min(cell.y, partnerCell.y);
  let turn = bd_hash21(vec2f(cell.x, pairTop) + fract(t * 7.13) * 91.0) < 0.5;
  let swap = turn && inRun && inside && bd_luma(upper.rgb) > bd_luma(lower.rgb) + 0.002;
  let kept = select(mine.rgb, theirs.rgb, swap);
  return vec4f(kept, next);
}
`;
