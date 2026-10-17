/**
 * Flare: the picture as an early digital camera saw it, pointed into the light. It breathes and
 * drifts; highlights burn past white; rays stream out of the light (the pointer is the light); a
 * CCD smear runs down through what is brightest; the channels part towards the edges; the blacks
 * are milky and the shadows band. Rays and smear are sampled sparsely and settled over frames (the
 * frame's alpha keeps them), so they stay smooth and cheap. A body for the shared prelude
 * (`shared/backdrop-shader.ts`).
 */
export const FLARE_SHADER = `fn flare_luma(st: vec2f) -> f32 {
  return bd_luma(bd_picture(st));
}

fn flare_at(uv: vec2f, t: f32) -> vec2f {
  let zoom = 1.1 + 0.035 * sin(t * 0.025);
  let drift = vec2f(sin(t * 0.015), cos(t * 0.011)) * 0.02 + (backdrop.pointer - 0.5) * 0.025;
  return (uv - 0.5) / zoom + 0.5 + drift;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let t = backdrop.time;
  let dark = backdrop.dark;
  let st = flare_at(uv, t);
  let aspect = vec2f(bd_aspect(), 1.0);

  // The channels part with distance from the centre.
  let spread = (uv - 0.5) * 0.012;
  let core = flare_luma(st);
  let outer = flare_luma(st + spread);
  let inner = flare_luma(st - spread);

  // Rays: light gathered along the line to the light, from a jittered start.
  let light = mix(vec2f(0.5 + sin(t * 0.045) * 0.12, 0.34), backdrop.pointer, 0.65);
  let jitter = bd_hash21(uv * backdrop.resolution + fract(t * 13.7) * 57.0);
  var rays = 0.0;
  for (var i = 0; i < 16; i++) {
    let k = (f32(i) + jitter) / 16.0;
    let p = mix(uv, light, k * 0.85);
    let l = flare_luma(flare_at(p, t));
    rays += max(l - 0.7, 0.0) * (1.0 - k);
  }
  rays = rays / 16.0 * 0.9 / (1.0 + length((uv - light) * aspect) * 2.0);

  // The smear: what burns brightest in this column bleeds down the sensor.
  var smear = 0.0;
  for (var j = 0; j < 8; j++) {
    let y = (f32(j) + bd_hash21(vec2f(jitter, f32(j)))) / 8.0;
    smear += max(flare_luma(flare_at(vec2f(uv.x, y), t)) - 0.93, 0.0);
  }
  smear = smear / 8.0 * 4.0;

  // Settled over frames: the alpha carries the gathered light.
  let last = bd_history(uv);
  let gathered = rays + smear;
  let settled = select(gathered, mix(gathered, last.a - 1.0, 0.82), last.a > 0.5);

  // Exposure: the picture tinted to the accent and pushed past white at the top, the blacks lifted
  // to a haze, the shadows banded.
  let tone = mix(1.0 - core, core, dark);
  var exposed = pow(max(tone, 0.0), 1.15);
  exposed = select(exposed, floor(exposed * 14.0) / 14.0, exposed < 0.3);
  var color = backdrop.page.rgb;
  color = bd_glow(color, backdrop.accent.rgb, smoothstep(0.02, 0.7, exposed) * 0.38 + 0.02);
  color = bd_glow(color, backdrop.ink.rgb, smoothstep(0.5, 1.0, exposed) * 0.5 + smoothstep(0.92, 1.0, exposed) * 0.35 * dark);
  let fringe = mix(1.0 - outer, outer, dark) - mix(1.0 - inner, inner, dark);
  color = bd_glow(color, backdrop.accent.rgb, max(fringe, 0.0) * 1.4);
  color = bd_glow(color, backdrop.ink.rgb, max(-fringe, 0.0) * 1.0);
  color = bd_glow(color, mix(backdrop.ink.rgb, vec3f(1.0), 0.5), settled * mix(0.35, 1.0, dark));

  // The lens: ghosts strung through the centre opposite the light, and a long streak through it.
  var ghosts = 0.0;
  for (var g = 0; g < 4; g++) {
    let k = 0.4 + f32(g) * 0.45;
    let centre = mix(light, vec2f(0.5), 1.0 + k);
    let r = 0.03 + f32(g) * 0.025;
    let d = length((uv - centre) * aspect);
    ghosts += smoothstep(r, r * 0.7, d) * (0.5 - f32(g) * 0.08) + smoothstep(r * 1.05, r, d) * smoothstep(r * 0.85, r, d) * 0.6;
  }
  let streak = exp(-abs(uv.y - light.y) * 240.0) * exp(-abs(uv.x - light.x) * 2.2);
  color = bd_glow(color, backdrop.accent.rgb, ghosts * 0.07 * dark + streak * 0.6);

  // A light leak creeping along one edge, and digital grain.
  let leak = smoothstep(0.55, 0.0, length((uv - vec2f(1.05, 0.15 + 0.1 * sin(t * 0.06))) * aspect));
  color = bd_glow(color, backdrop.accent.rgb, leak * 0.35);
  let grain = bd_hash21(uv * backdrop.resolution + fract(t * 23.0) * 71.0) - 0.5;
  color += grain * 0.03;
  return vec4f(color, 1.0 + settled);
}
`;
