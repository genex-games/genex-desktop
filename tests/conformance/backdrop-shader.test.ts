/**
 * Live backgrounds: a shader body is refused before the GPU sees it when it could never run as a
 * background (its own inputs, no entry, a loop with no small bound), and every bundled preset
 * passes the same checks a made one must.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_MADE_SHADERS, readMadeShaders } from "../../src/renderer/home-backdrop/made-shaders.ts";
import { SHADER_PRESETS } from "../../src/renderer/home-backdrop/presets.ts";
import {
  readsHistory,
  readsPicture,
  SHADER_BODY_FIRST_LINE,
  SHADER_LOOP_MAX,
  SHADER_MAX_CHARS,
  SHADER_TITLE_MAX_CHARS,
  ShaderProblem,
  shaderProblem,
  shaderSource,
} from "../../src/shared/backdrop-shader.ts";

const ENTRY = "@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f";
const body = (inside: string, before = ""): string => `${before}\n${ENTRY} {\n${inside}\n  return vec4f(1.0);\n}`;

describe("a shader body's static checks", () => {
  it("passes a body that only uses the prelude", () => {
    assert.equal(
      shaderProblem(body("let c = bd_glow(backdrop.page.rgb, backdrop.ink.rgb, bd_noise(uv * 4.0));")),
      null,
    );
  });

  it("passes bounded loops of each common shape", () => {
    const loops = [
      "for (var i = 0; i < 8; i++) {}",
      "for (var i: i32 = 0; i < 16; i += 2) {}",
      "for (var k = 0u; k <= 32u; k++) {}",
      `for (var i = 0; i < ${SHADER_LOOP_MAX}; i++) {}`,
    ];
    for (const loop of loops) assert.equal(shaderProblem(body(loop)), null, loop);
  });

  const refused: Array<[string, unknown, ShaderProblem]> = [
    ["nothing", "", ShaderProblem.Empty],
    ["not text", 42, ShaderProblem.Empty],
    ["too long", body(`// ${"x".repeat(SHADER_MAX_CHARS)}`), ShaderProblem.TooLong],
    ["no entry", "fn main() -> f32 { return 1.0; }", ShaderProblem.NoEntry],
    ["a renamed entry", body("").replace("fs_main", "main"), ShaderProblem.NoEntry],
    ["its own binding", body("", "@group(0) @binding(3) var<uniform> extra: vec4f;"), ShaderProblem.OwnInputs],
    [
      "a vertex stage",
      body("", "@vertex fn vs() -> @builtin(position) vec4f { return vec4f(0.0); }"),
      ShaderProblem.OwnInputs,
    ],
    ["a compute stage", body("", "@compute @workgroup_size(1) fn c() {}"), ShaderProblem.OwnInputs],
    ["a feature it may not have", body("", "enable f16;"), ShaderProblem.Directive],
    ["the inputs again", body("", "struct Backdrop { time: f32 }"), ShaderProblem.Redefines],
    ["a helper again", body("", "fn bd_noise(p: vec2f) -> f32 { return 0.0; }"), ShaderProblem.Redefines],
    ["the picture again", body("", "var<private> picture: f32;"), ShaderProblem.Redefines],
    ["the last frame again", body("", "var<private> history: f32;"), ShaderProblem.Redefines],
    ["the glyph sheet again", body("", "var<private> glyphs: f32;"), ShaderProblem.Redefines],
    ["the ramp again", body("", "fn bd_ramp(t: f32) -> vec3f { return vec3f(t); }"), ShaderProblem.Redefines],
    ["a bare loop", body("loop { break; }"), ShaderProblem.UnboundedLoop],
    ["a while loop", body("var i = 0; while (i < 4) { i++; }"), ShaderProblem.UnboundedLoop],
    ["a loop past the cap", body(`for (var i = 0; i < ${SHADER_LOOP_MAX + 1}; i++) {}`), ShaderProblem.UnboundedLoop],
    ["a loop bound by a value", body("for (var i = 0; i < n; i++) {}"), ShaderProblem.UnboundedLoop],
    ["a loop that counts down", body("for (var i = 8; i > 0; i--) {}"), ShaderProblem.UnboundedLoop],
    ["a loop with no bound", body("for (var i = 0; ; i++) { break; }"), ShaderProblem.UnboundedLoop],
  ];
  for (const [name, wgsl, problem] of refused)
    it(`refuses ${name}`, () => {
      assert.equal(shaderProblem(wgsl), problem);
    });

  it("ignores words in comments", () => {
    assert.equal(shaderProblem(body("// loop forever? no: while we wait\n/* @binding(9) */")), null);
  });
});

describe("the bundled backgrounds", () => {
  for (const preset of SHADER_PRESETS)
    it(`${preset.name} passes the checks a made one must`, () => {
      assert.equal(shaderProblem(preset.body), null);
    });
});

describe("a shader body in its source", () => {
  it("knows whether it reads the picture", () => {
    assert.equal(readsPicture(body("let c = bd_picture(uv);")), true);
    assert.equal(readsPicture(body("// no bd_picture here\nlet c = uv;")), false);
  });

  it("knows whether it reads the frame it drew last", () => {
    assert.equal(readsHistory(body("let last = bd_history(uv);")), true);
    assert.equal(readsHistory(body("let last = bd_history_pixel(uv * backdrop.resolution);")), true);
    assert.equal(readsHistory(body("// no bd_history here\nlet c = uv;")), false);
  });

  it("starts on the line compiler messages are counted from", () => {
    const lines = shaderSource("first body line\nsecond").split("\n");
    assert.equal(lines[SHADER_BODY_FIRST_LINE - 1], "first body line");
  });
});

describe("made backgrounds read back from this Mac", () => {
  const good = body("let c = bd_glow(backdrop.page.rgb, backdrop.ink.rgb, uv.x);");
  const made = (id: string, at: number, wgsl = good) => ({ id, title: "Neon rain", prompt: "rain", wgsl, at });

  it("keeps entries that pass the checks a new one must, oldest first", () => {
    const read = readMadeShaders(JSON.stringify([made("custom:b", 2), made("custom:a", 1)]));
    assert.deepEqual(
      read.map((entry) => entry.id),
      ["custom:a", "custom:b"],
    );
  });

  it("lets go of what it cannot use, without throwing", () => {
    const hostile: unknown[] = [
      made("custom:loop", 1, body("loop { break; }")),
      made("custom:bind", 2, body("", "@group(0) @binding(9) var<uniform> extra: vec4f;")),
      made("custom:prelude", 3, body("", "var<private> history: f32;")),
      made("preset:phosphor", 4),
      made("custom:../x", 5),
      { ...made("custom:no-at", 6), at: "now" },
      { ...made("custom:no-title", 7), title: 42 },
      null,
      "custom:a",
      [made("custom:nested", 8)],
    ];
    assert.deepEqual(readMadeShaders(JSON.stringify(hostile)), []);
    for (const raw of [null, "", "{", "42", '"text"', "{}"]) assert.deepEqual(readMadeShaders(raw), []);
  });

  it("keeps one of each id, the newest few, names and words cut to their limits", () => {
    const many = Array.from({ length: MAX_MADE_SHADERS + 3 }, (_, index) => made(`custom:m${index}`, index));
    const read = readMadeShaders(JSON.stringify([...many, made("custom:m0", 99)]));
    assert.equal(read.length, MAX_MADE_SHADERS);
    assert.equal(new Set(read.map((entry) => entry.id)).size, read.length);
    const long = readMadeShaders(JSON.stringify([{ ...made("custom:long", 1), title: "x".repeat(500) }]));
    assert.equal(long[0]?.title.length, SHADER_TITLE_MAX_CHARS);
  });
});
