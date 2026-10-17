/**
 * Home's live backgrounds: a WGSL fragment shader drawn full screen behind home. Every shader,
 * bundled or made by a model, is a body written against one prelude (its inputs and helpers), so
 * the renderer that draws it and the model that writes it read the same contract. The checks here
 * are the cheap, static ones; the GPU's compiler has the last word (`home-backdrop/gpu.ts`).
 */
import type { MessageImage } from "./event-log.ts";

/** The entry point every shader body declares. */
export const SHADER_ENTRY = "fs_main";
/** The longest shader body kept, in characters. */
export const SHADER_MAX_CHARS = 16_000;
/** The longest description a model is asked to draw, in characters. */
export const SHADER_PROMPT_MAX_CHARS = 600;
/** The longest name a made background keeps, in characters. */
export const SHADER_TITLE_MAX_CHARS = 32;
/** A loop runs at most this many times: every pixel runs it every frame. */
export const SHADER_LOOP_MAX = 64;

/**
 * What every shader body is appended to: the inputs (`backdrop`, the chosen `picture`) and the
 * helpers. Model-facing too: the generation prompt quotes it, so keep its comments accurate.
 */
export const SHADER_PRELUDE = `struct Backdrop {
  ink: vec4f,          // the main colour (rgb; a = 1)
  accent: vec4f,       // the second colour
  page: vec4f,         // the page behind home: paint over this
  resolution: vec2f,   // the canvas in pixels
  pointer: vec2f,      // the pointer in uv (0..1, top-left origin), eased
  time: f32,           // seconds, already scaled by the speed setting
  scale: f32,          // the detail setting, 0.5..2 (1 by default): multiply pattern frequencies
  dark: f32,           // 1 on a dark page, 0 on a light one
  pictureAspect: f32,  // the picture's width / height
  delta: f32,          // seconds since the last frame, scaled by the speed setting
  density: f32,        // pixels per point: resolution / density is the canvas in points
}
@group(0) @binding(0) var<uniform> backdrop: Backdrop;
@group(0) @binding(1) var picture: texture_2d<f32>;
@group(0) @binding(2) var pictureSampler: sampler;
@group(0) @binding(3) var history: texture_2d<f32>;  // the frame this shader drew last, same size
@group(0) @binding(4) var glyphs: texture_2d<f32>;   // BD_GLYPH_COUNT glyphs side by side, white

const BD_PI: f32 = 3.14159265;
const BD_TAU: f32 = 6.28318531;
// Glyphs on the sheet: katakana, then the digits 0-9 (at 46..55), then signs.
const BD_GLYPH_COUNT: f32 = 64.0;

// The canvas's width / height.
fn bd_aspect() -> f32 {
  return backdrop.resolution.x / max(backdrop.resolution.y, 1.0);
}

// uv as centred coordinates: y from -1 (bottom) to 1 (top), x scaled by the aspect.
fn bd_centered(uv: vec2f) -> vec2f {
  return vec2f((uv.x - 0.5) * 2.0 * bd_aspect(), (0.5 - uv.y) * 2.0);
}

// A stable random number in 0..1 for a point.
fn bd_hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}

// Two stable random numbers in 0..1 for a point.
fn bd_hash22(p: vec2f) -> vec2f {
  let n = bd_hash21(p);
  return vec2f(n, bd_hash21(p + n + 17.17));
}

// Smooth value noise in 0..1.
fn bd_noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = bd_hash21(i);
  let b = bd_hash21(i + vec2f(1.0, 0.0));
  let c = bd_hash21(i + vec2f(0.0, 1.0));
  let d = bd_hash21(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Five octaves of noise, in 0..1.
fn bd_fbm(p: vec2f) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var q = p;
  for (var i = 0; i < 5; i++) {
    sum += amp * bd_noise(q);
    q = q * 2.03 + vec2f(1.7, 9.2);
    amp *= 0.5;
  }
  return sum;
}

// A colour's brightness.
fn bd_luma(color: vec3f) -> f32 {
  return dot(color, vec3f(0.2126, 0.7152, 0.0722));
}

// The chosen picture at uv, cut to cover the canvas.
fn bd_picture(uv: vec2f) -> vec3f {
  let screen = bd_aspect();
  var st = uv - 0.5;
  if (screen > backdrop.pictureAspect) {
    st.y *= backdrop.pictureAspect / screen;
  } else {
    st.x *= screen / backdrop.pictureAspect;
  }
  return textureSampleLevel(picture, pictureSampler, st + 0.5, 0.0).rgb;
}

// The frame this shader drew last, at uv. a is 0 until there is one: a first frame starts fresh.
// Colours above 1 are kept (the frame is HDR) and glow. Mix it back in to leave trails.
fn bd_history(uv: vec2f) -> vec4f {
  return textureSampleLevel(history, pictureSampler, uv, 0.0);
}

// The last frame's pixel at p (in pixels, top-left origin), exactly: for moving pixels around.
fn bd_history_pixel(p: vec2f) -> vec4f {
  let size = vec2i(textureDimensions(history));
  return textureLoad(history, clamp(vec2i(floor(p)), vec2i(0), size - 1), 0);
}

// Glyph number index (0..BD_GLYPH_COUNT-1) at local (0..1 across its cell, top-left origin): its coverage, 0..1.
fn bd_glyph(index: f32, local: vec2f) -> f32 {
  let i = clamp(floor(index), 0.0, BD_GLYPH_COUNT - 1.0);
  let inside = step(0.0, local.x) * step(local.x, 1.0) * step(0.0, local.y) * step(local.y, 1.0);
  let at = vec2f((i + clamp(local.x, 0.0, 1.0)) / BD_GLYPH_COUNT, clamp(local.y, 0.0, 1.0));
  return textureSampleLevel(glyphs, pictureSampler, at, 0.0).a * inside;
}

// A tone in the theme's colours. On a dark page it is light: nothing at 0, the accent coming up
// dimly through the middle, the ink at 1, brighter still past 1 (which glows). On a light page
// it is ink: the page at 0, the accent in the middle, the ink at 1.
fn bd_ramp(tone: f32) -> vec3f {
  let t = max(tone, 0.0);
  let mid = smoothstep(0.0, 0.6, t);
  let top = smoothstep(0.45, 1.0, t);
  let lit = backdrop.page.rgb + backdrop.accent.rgb * mid * 0.6 * (1.0 - top) + backdrop.ink.rgb * (top + max(t - 1.0, 0.0));
  let inked = mix(mix(backdrop.page.rgb, backdrop.accent.rgb, mid * 0.75), backdrop.ink.rgb, top);
  return mix(inked, lit, backdrop.dark);
}

// Paints color over base by amount: light adds on a dark page, ink covers on a light one.
fn bd_glow(base: vec3f, color: vec3f, amount: f32) -> vec3f {
  let a = clamp(amount, 0.0, 1.0);
  return mix(mix(base, color, a), base + color * max(amount, 0.0), backdrop.dark);
}
`;

/** Why a shader body was refused before it reached the GPU. */
export const ShaderProblem = {
  Empty: "empty",
  TooLong: "too-long",
  NoEntry: "no-entry",
  /** It declares its own bindings or stages: the prelude owns every input. */
  OwnInputs: "own-inputs",
  /** It redefines a name the prelude already defines. */
  Redefines: "redefines",
  /** A `loop`, `while` or a `for` without a small constant bound: a pixel could never finish. */
  UnboundedLoop: "unbounded-loop",
  /** An `enable` or `requires` directive: a feature the device may not have. */
  Directive: "directive",
} as const;
export type ShaderProblem = (typeof ShaderProblem)[keyof typeof ShaderProblem];

/** Why making a background failed, as the renderer explains it. */
export const ShaderFailure = {
  /** No model can answer: connect one in Settings. */
  NoModel: "no-model",
  /** The model failed, timed out or said nothing usable. */
  NoReply: "no-reply",
  /** The model answered with a shader that fails a static check (`problem`). */
  Refused: "refused",
} as const;
export type ShaderFailure = (typeof ShaderFailure)[keyof typeof ShaderFailure];

/** What a made background is: a filter the chosen picture is seen through, or a scene of its own. */
export const BackdropShaderKind = {
  Filter: "filter",
  Scene: "scene",
} as const;
export type BackdropShaderKind = (typeof BackdropShaderKind)[keyof typeof BackdropShaderKind];

/** What this Mac saw when it drew a made background, told to the model that improves it. */
export const LookFinding = {
  /** Little but the page shows. */
  Empty: "empty",
  /** The moments drawn look the same. */
  Still: "still",
  /** Most of the screen is lit, where a background should mostly sit back. */
  Glaring: "glaring",
  /** The middle, behind home's title and prompt, is busier than the edges. */
  BusyCentre: "busy-centre",
  /** A frame takes too long to draw. */
  Slow: "slow",
} as const;
export type LookFinding = (typeof LookFinding)[keyof typeof LookFinding];

/** The look sent with a background to improve: at most this many images, each at most this much base64. */
export const SHADER_LOOK_IMAGES_MAX = 2;
export const SHADER_LOOK_IMAGE_MAX_CHARS = 1_500_000;
/** The pictures a look may come as. */
export const SHADER_LOOK_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/webp"];

/** A background that runs, as this Mac drew it: the moments, what stood out, and a frame's cost. */
export interface BackdropLook {
  wgsl: string;
  images: MessageImage[];
  findings: LookFinding[];
  /** Milliseconds a frame took at the measured size; 0 when it was not measured. */
  frameMs: number;
}

/** A request to make a background from a description, on the model the user picked. */
export interface BackdropShaderRequest {
  prompt: string;
  /** A filter over the picture (the default) or a scene of its own. */
  kind?: BackdropShaderKind;
  engine?: string;
  model?: string;
  /** A second try: the body that failed and the compiler's words about it. */
  repair?: { wgsl: string; problem: string };
  /** Another pass on a body that runs, after looking at it. */
  refine?: BackdropLook;
}

/** A made background: a short name and its shader body. */
export interface BackdropShader {
  title: string;
  wgsl: string;
}

/** What making a background returns: the shader, or why there is none. */
export type BackdropShaderResult =
  | { ok: true; shader: BackdropShader }
  | { ok: false; failure: ShaderFailure; problem?: ShaderProblem };

/** Names the prelude defines; a body defining one again does not compile. */
const PRELUDE_NAMES =
  /\b(?:struct\s+Backdrop|var(?:<[^>]*>)?\s+(?:backdrop|picture|pictureSampler|history|glyphs)\b|fn\s+bd_\w+|const\s+BD_\w+)/;
const BINDINGS_OR_STAGES = /@(?:group|binding|vertex|compute)\b/;
const ENTRY = new RegExp(`@fragment\\s+fn\\s+${SHADER_ENTRY}\\s*\\(`);
const DIRECTIVE = /^\s*(?:enable|requires)\b/m;
const UNBOUNDED = /\b(?:loop|while)\b/;
const FOR_HEADER = /\bfor\s*\(([^)]*)\)/g;
/** `var i = 0; i < 16; i++`, with optional types, `u`/`i` suffixes and `+= n` steps. */
const BOUNDED_FOR =
  /^\s*var\s+(\w+)\s*(?::\s*[iuf]32\s*)?=\s*-?\d+(?:\.\d*)?[iuf]?\s*;\s*\1\s*<=?\s*(\d+)(?:\.0*)?[iuf]?\s*;\s*\1\s*(?:\+\+|\+=\s*\d+[iuf]?)\s*$/;

/** `wgsl` without its comments, so a check never matches words in one. */
export function withoutComments(wgsl: string): string {
  return wgsl.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");
}

/** Does every `for` loop have a small constant bound? */
function loopsBounded(code: string): boolean {
  for (const [, header = ""] of code.matchAll(FOR_HEADER)) {
    const bound = BOUNDED_FOR.exec(header);
    if (!bound || Number(bound[2]) > SHADER_LOOP_MAX) return false;
  }
  return true;
}

/** What is wrong with a shader body before the GPU sees it, or null when the static checks pass. */
export function shaderProblem(wgsl: unknown): ShaderProblem | null {
  if (typeof wgsl !== "string" || !wgsl.trim()) return ShaderProblem.Empty;
  if (wgsl.length > SHADER_MAX_CHARS) return ShaderProblem.TooLong;
  const code = withoutComments(wgsl);
  if (BINDINGS_OR_STAGES.test(code)) return ShaderProblem.OwnInputs;
  if (DIRECTIVE.test(code)) return ShaderProblem.Directive;
  if (!ENTRY.test(code)) return ShaderProblem.NoEntry;
  if (PRELUDE_NAMES.test(code)) return ShaderProblem.Redefines;
  if (UNBOUNDED.test(code) || !loopsBounded(code)) return ShaderProblem.UnboundedLoop;
  return null;
}

/** Does the body read the chosen picture? Then the picture picker applies to it. */
export function readsPicture(wgsl: string): boolean {
  return /\b(?:bd_picture|picture|pictureSampler)\b/.test(withoutComments(wgsl));
}

/** Does the body read the frame it drew last? Then it is drawn into two frames, swapped each time. */
export function readsHistory(wgsl: string): boolean {
  return /\b(?:bd_history|bd_history_pixel|history)\b/.test(withoutComments(wgsl));
}

/** The full source the GPU compiles for a body. */
export function shaderSource(body: string): string {
  return `${SHADER_PRELUDE}\n${body}`;
}

/** The line the body starts on in the full source, so a compiler's line numbers can point into the body. */
export const SHADER_BODY_FIRST_LINE = SHADER_PRELUDE.split("\n").length + 1;
