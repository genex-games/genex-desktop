/** What the model reads when it makes a live background for home (`backdrop-generation.ts`). Model-facing. */
import {
  BackdropShaderKind,
  LookFinding,
  SHADER_ENTRY,
  SHADER_LOOP_MAX,
  SHADER_PRELUDE,
  ShaderProblem,
} from "../../shared/backdrop-shader.ts";
import { DATAMOSH_SHADER } from "../../shared/backdrop-shaders/datamosh.ts";
import { PHOSPHOR_SHADER } from "../../shared/backdrop-shaders/phosphor.ts";

/** Each static check's failure, told to the model that wrote the shader. */
export const SHADER_PROBLEM_WORDS = {
  [ShaderProblem.Empty]: "The reply held no WGSL code block.",
  [ShaderProblem.TooLong]: "The shader is too long. Write a shorter one.",
  [ShaderProblem.NoEntry]: `There is no \`@fragment fn ${SHADER_ENTRY}(@location(0) uv: vec2f) -> @location(0) vec4f\`.`,
  [ShaderProblem.OwnInputs]: "It declares its own @group, @binding or stage. Use only the prelude's inputs.",
  [ShaderProblem.Redefines]:
    "It redefines a prelude name (Backdrop, backdrop, picture, pictureSampler, history, glyphs, BD_* or bd_*).",
  [ShaderProblem.UnboundedLoop]: `It has a loop without a literal bound of at most ${SHADER_LOOP_MAX}. Use only for (var i = 0; i < N; i++).`,
  [ShaderProblem.Directive]: "It uses enable or requires. Remove them.",
} as const satisfies Record<ShaderProblem, string>;

/** The instruction for the tool-free completions that write and improve a background shader. */
export const BACKDROP_SYSTEM_PROMPT = `You write WGSL fragment shaders for the animated background of Genex, a desktop app for making video games. The background fills the home screen behind a title and a prompt box in the middle, so keep the centre calm enough to read text over; put the boldest detail toward the edges and the bottom. House style: serious and cybernetic, overexposed and digital, a little experimental: terminals, signal and sensor glitches, retro-futurist games, anime, Y2K; clean shapes over muddy noise.

Your code is appended to this prelude, which already declares every input and helper:

\`\`\`wgsl
${SHADER_PRELUDE}\`\`\`

Craft:
- One strong idea, carried out with restraint and detail, like a title sequence rather than a demo. Name the idea in a comment on the first line.
- Detail at two or three scales: a large slow form, a middle structure, a fine texture (grain, scanlines, a pixel grid, glyphs) kept faint.
- Motion slow and continuous: drifting, scanning, decaying, settling. Nothing strobes or flashes; a glitch is brief and rare.
- Tone over hue: home often draws the background through a line, dot or character effect that reads only its brightness, and always faintly behind the interface. Give it clear lights and darks, bands and edges; most of the screen near the page, a few things bright.
- Things that remember (trails, smears, phosphor, heat, a sort in progress) are what make it feel alive: keep them in the frame before (bd_history).

Rules:
- Write only helper functions and the entry point \`@fragment fn ${SHADER_ENTRY}(@location(0) uv: vec2f) -> @location(0) vec4f\`. uv runs 0..1 from the top-left corner.
- Never redeclare a prelude name (Backdrop, backdrop, picture, pictureSampler, history, glyphs, BD_*, bd_*). No @group, @binding, @vertex or @compute, no enable or requires.
- Paint over backdrop.page.rgb with backdrop.ink.rgb and backdrop.accent.rgb, mostly through bd_glow and bd_ramp, so it suits a dark page and a light one alike. Other hues sparingly.
- The frame is HDR: on a dark page, colours above 1.0 bloom into a glow around them. Use that for hot highlights, not for whole areas.
- For trails, smears or anything that remembers, read the frame drawn last with bd_history(uv) (or bd_history_pixel for exact pixels) and decay it by backdrop.delta, never by a fixed amount per frame. Its alpha is 0 before the first frame. The alpha you return is not shown: it comes back as bd_history(uv).a next frame, so you may keep a value there (keep it above 0.5, for example 1.0 + value); without history, return alpha 1.0.
- For characters, bd_glyph(index, local) draws one of BD_GLYPH_COUNT glyphs (katakana, the digits, signs) in a cell.
- Animate with backdrop.time, smoothly. Let backdrop.pointer move something subtly. Multiply pattern frequencies by backdrop.scale; size things in points through backdrop.density so they look the same on every screen.
- It runs for every pixel of a laptop screen at 60 frames a second: keep it cheap. Loops only as \`for (var i = 0; i < N; i++)\` with a literal N of at most ${SHADER_LOOP_MAX}; never loop or while. Read the picture at most a dozen times a pixel.
- WGSL is strict: write floats as 1.0, never mix int and float, use select(falseValue, trueValue, condition) instead of ?:, x - y * floor(x / y) for a modulo, atan2(y, x). Call fwidth, dpdx and dpdy only at the top level of a function, never inside an if or a loop. Declare with let (constant) or var (mutable).

Reply with exactly two parts and nothing else: a line "Title: " followed by a name of two or three words, then one \`\`\`wgsl code block holding the whole shader.`;

/** What each kind of background asks of the shader, with one of Genex's own as the standard. */
const KIND_WORDS = {
  [BackdropShaderKind.Filter]: `Make it a filter: the chosen picture seen through a camera, a sensor, a screen, a print or a broken signal. Read bd_picture(uv) for every pixel and keep the picture recognisable: its shapes and its light come through, and you decide how they are drawn (tones mapped into the theme with bd_ramp, quantised, displaced, smeared, scanned, sampled on a grid). The user picks the picture, so it must work on any photo.

One of Genex's own filters, for its standard of craft (do not copy it):
\`\`\`wgsl
${DATAMOSH_SHADER}\`\`\``,
  [BackdropShaderKind.Scene]: `Make it a scene of its own, drawn from nothing; read the picture only if the description asks for it.

One of Genex's own backgrounds, for its standard of craft (do not copy it):
\`\`\`wgsl
${PHOSPHOR_SHADER}\`\`\``,
} as const satisfies Record<BackdropShaderKind, string>;

/** Each finding from drawing the shader, told to the model improving it. */
const FINDING_WORDS = {
  [LookFinding.Empty]: "It came out almost empty: little but the page shows. Give it presence.",
  [LookFinding.Still]: "It hardly moves: the moments look the same. Give it slow, continuous motion.",
  [LookFinding.Glaring]:
    "Most of the screen is lit. It is a background: keep most of it near the page and let details glow.",
  [LookFinding.BusyCentre]:
    "The middle, behind home's title and prompt, is busier than the edges. Calm the centre; put the boldest detail toward the edges and the bottom.",
  [LookFinding.Slow]: "It is slow to draw. Make it cheaper: fewer loop steps and picture reads per pixel.",
} as const satisfies Record<LookFinding, string>;

/** The message that asks for a background from a description. */
export function backdropRequest(description: string, kind: BackdropShaderKind): string {
  return `Make a background: ${description}

${KIND_WORDS[kind]}`;
}

/** How a repair begins, after the request: a fixture engine knows a repair by it. */
export const REPAIR_OPENING = "Your shader failed.";

/** The message that asks again after the shader failed: the code and why. */
export function backdropRepair(description: string, kind: BackdropShaderKind, wgsl: string, problem: string): string {
  return `${backdropRequest(description, kind)}

${REPAIR_OPENING} Fix it and reply in the same format.

Problem:
${problem}

Your shader:
\`\`\`wgsl
${wgsl}
\`\`\``;
}

/** What the look shows and what stood out, in words. */
export interface LookWords {
  findings: readonly LookFinding[];
  frameMs: number;
  /** Whether the picture shows the look at all: an engine may take only text. */
  shown: boolean;
}

/** The message that asks for a better version after drawing the shader: how it looks and what stood out. */
export function backdropRefine(description: string, kind: BackdropShaderKind, wgsl: string, look: LookWords): string {
  const seen = look.shown
    ? "Attached is how it draws on home: three moments a few seconds apart, left to right, on the theme's page with the user's colours."
    : "It compiles and runs on home.";
  const cost = look.frameMs > 0 ? ` A frame takes ${look.frameMs.toFixed(1)} ms at 1920×1200.` : "";
  const findings = look.findings.map((finding) => `- ${FINDING_WORDS[finding]}`).join("\n");
  return `${backdropRequest(description, kind)}

You wrote the shader below. ${seen}${cost}
${findings ? `\nWhat stood out:\n${findings}\n` : ""}
Look at it as an art director would, then make it better: keep what works, make the idea read at a glance, sharpen what is muddy, calm what is noisy, and fix anything above. Reply in the same format with the whole shader.

Your shader:
\`\`\`wgsl
${wgsl}
\`\`\``;
}
