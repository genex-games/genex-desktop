/**
 * Making a live background from a description: the model the user picked writes a shader body, a
 * filter over the picture or a scene of its own; a body that fails the static checks goes back once
 * with the reason, a compiler's complaint comes back as a repair, a look at a body that runs comes
 * back for a better one, and whatever the model does the panel gets a shader or a typed reason.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeBackdropShader, shaderFromReply } from "../../src/main/core/backdrop-generation.ts";
import {
  BackdropShaderKind,
  LookFinding,
  SHADER_LOOK_IMAGE_MAX_CHARS,
  SHADER_PROMPT_MAX_CHARS,
  ShaderFailure,
  ShaderProblem,
} from "../../src/shared/backdrop-shader.ts";
import type { CompleteRequest, CompleteResponse, Engine } from "../../src/substrate/engines/types.ts";

const GOOD = `fn stripes(uv: vec2f) -> f32 {
  return step(0.5, fract(uv.y * 20.0 * backdrop.scale + backdrop.time));
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(bd_glow(backdrop.page.rgb, backdrop.ink.rgb, stripes(uv) * 0.4), 1.0);
}`;
const reply = (title: string, code: string): string => `Title: ${title}\n\`\`\`wgsl\n${code}\n\`\`\``;

/** An engine that answers completion n with `replies[n]` (or throws it), recording each request. */
function engine(id: string, replies: Array<string | Error>, asked: CompleteRequest[] = []): Engine {
  return {
    id,
    label: id,
    complete: async (request: CompleteRequest): Promise<CompleteResponse> => {
      const answer = replies[asked.length] ?? replies.at(-1) ?? "";
      asked.push(request);
      if (answer instanceof Error) throw answer;
      return { message: { role: "assistant", content: answer } } as CompleteResponse;
    },
  } as unknown as Engine;
}

function deps(engines: Engine[], timeoutMs = 1_000) {
  return {
    engines: {
      get: (id: string) => {
        const found = engines.find((candidate) => candidate.id === id);
        if (!found) throw new Error(`no engine ${id}`);
        return found;
      },
      firstReady: async () => engines[0] ?? null,
    },
    budget: { run: <T>(_work: unknown, work: () => Promise<T>) => work() },
    timeoutMs,
  };
}

describe("a background from a model's reply", () => {
  it("takes the name line and the first code block", () => {
    assert.deepEqual(shaderFromReply(reply("Neon Koi", GOOD), "koi in a neon pond"), { title: "Neon Koi", wgsl: GOOD });
  });

  it("reads a bold name, a bare fence and wrapping quotes", () => {
    const shader = shaderFromReply(`**Title:** "Neon Koi."\n\`\`\`\n${GOOD}\n\`\`\``, "koi");
    assert.deepEqual(shader, { title: "Neon Koi", wgsl: GOOD });
  });

  it("names it from the description when the reply has no name", () => {
    assert.equal(shaderFromReply(`\`\`\`wgsl\n${GOOD}\n\`\`\``, "koi in a neon pond").title, "koi in a neon pond");
  });

  it("cuts a long name on a word", () => {
    const { title } = shaderFromReply(reply("The Extraordinarily Long Neon Koi Pond At Midnight", GOOD), "koi");
    assert.equal(title, "The Extraordinarily Long Neon");
  });

  it("finds no body in a reply with no code", () => {
    assert.equal(shaderFromReply("Title: Koi\nI can't draw that.", "koi").wgsl, "");
  });
});

describe("making a background", () => {
  it("asks the picked engine and model once, tool-free, and returns its shader", async () => {
    const asked: CompleteRequest[] = [];
    const other = engine("other", [reply("Wrong", GOOD)]);
    const picked = engine("picked", [reply("Neon Koi", GOOD)], asked);
    const result = await makeBackdropShader(deps([other, picked]), {
      prompt: "koi in a neon pond",
      engine: "picked",
      model: "fast-1",
    });
    assert.deepEqual(result, { ok: true, shader: { title: "Neon Koi", wgsl: GOOD } });
    assert.equal(asked.length, 1);
    assert.equal(asked[0]?.model, "fast-1");
    assert.deepEqual(asked[0]?.tools, []);
    assert.match(asked[0]?.systemPrompt ?? "", /struct Backdrop/);
    assert.match(asked[0]?.messages[0]?.content ?? "", /koi in a neon pond/);
  });

  it("sends a body that fails a static check back once with the reason", async () => {
    const asked: CompleteRequest[] = [];
    const looping = GOOD.replace("return vec4f", "loop { break; }\n  return vec4f");
    const result = await makeBackdropShader(deps([engine("e", [reply("Koi", looping), reply("Koi", GOOD)], asked)]), {
      prompt: "koi",
    });
    assert.equal(result.ok, true);
    assert.equal(asked.length, 2);
    assert.match(asked[1]?.messages[0]?.content ?? "", /loop without a literal bound/);
    assert.match(asked[1]?.messages[0]?.content ?? "", /loop \{ break; \}/);
  });

  it("gives up after the second refusal, naming the check", async () => {
    const asked: CompleteRequest[] = [];
    const result = await makeBackdropShader(deps([engine("e", [reply("Koi", "fn nothing() {}")], asked)]), {
      prompt: "koi",
    });
    assert.deepEqual(result, { ok: false, failure: ShaderFailure.Refused, problem: ShaderProblem.NoEntry });
    assert.equal(asked.length, 2);
  });

  it("asks for a repair with the compiler's words and the failed body", async () => {
    const asked: CompleteRequest[] = [];
    await makeBackdropShader(deps([engine("e", [reply("Koi", GOOD)], asked)]), {
      prompt: "koi",
      repair: { wgsl: "@fragment fn fs_main() {}", problem: "error: unresolved value 'nope'" },
    });
    const content = asked[0]?.messages[0]?.content ?? "";
    assert.match(content, /unresolved value 'nope'/);
    assert.match(content, /@fragment fn fs_main\(\) \{\}/);
  });

  it("says no model when none can complete", async () => {
    const noComplete = { id: "x", label: "x" } as unknown as Engine;
    for (const engines of [[], [noComplete]])
      assert.deepEqual(await makeBackdropShader(deps(engines), { prompt: "koi" }), {
        ok: false,
        failure: ShaderFailure.NoModel,
      });
    assert.deepEqual(await makeBackdropShader(deps([]), { prompt: "koi", engine: "gone" }), {
      ok: false,
      failure: ShaderFailure.NoModel,
    });
  });

  it("says no reply when the model fails or never answers", async () => {
    const failing = engine("e", [new Error("rate limited")]);
    assert.deepEqual(await makeBackdropShader(deps([failing]), { prompt: "koi" }), {
      ok: false,
      failure: ShaderFailure.NoReply,
    });
    const silent = {
      id: "s",
      label: "s",
      complete: () => new Promise<CompleteResponse>(() => {}),
    } as unknown as Engine;
    assert.deepEqual(await makeBackdropShader(deps([silent], 20), { prompt: "koi" }), {
      ok: false,
      failure: ShaderFailure.NoReply,
    });
  });

  it("cuts a long description and drops control characters before the model reads it", async () => {
    const asked: CompleteRequest[] = [];
    await makeBackdropShader(deps([engine("e", [reply("Koi", GOOD)], asked)]), {
      prompt: `koi\u0007${"x".repeat(SHADER_PROMPT_MAX_CHARS * 2)}`,
    });
    const content = asked[0]?.messages[0]?.content ?? "";
    assert.ok(!content.includes("\u0007"));
    assert.ok(content.includes("x".repeat(SHADER_PROMPT_MAX_CHARS - 10)));
    assert.ok(!content.includes("x".repeat(SHADER_PROMPT_MAX_CHARS)));
  });

  const hostile: Array<[string, unknown]> = [
    ["no request", undefined],
    ["no description", {}],
    ["a description that is not text", { prompt: 42 }],
    ["an empty description", { prompt: "   " }],
  ];
  for (const [name, request] of hostile)
    it(`refuses ${name} without asking a model`, async () => {
      const asked: CompleteRequest[] = [];
      await assert.rejects(makeBackdropShader(deps([engine("e", [reply("Koi", GOOD)], asked)]), request as never));
      assert.equal(asked.length, 0);
    });
});

const LOOK = { mimeType: "image/jpeg", data: "aGVsbG8=" };

/** The first message the model got for `request`. */
async function firstAsked(request: Record<string, unknown>) {
  const asked: CompleteRequest[] = [];
  await makeBackdropShader(deps([engine("e", [reply("Koi", GOOD)], asked)]), { prompt: "koi", ...request });
  return asked[0]?.messages[0];
}

describe("a filter or a scene, and another pass after a look", () => {
  it("asks for a filter over the picture by default, with one of Genex's own filters as the standard", async () => {
    for (const kind of [undefined, BackdropShaderKind.Filter, "chrome"]) {
      const content = (await firstAsked({ kind }))?.content ?? "";
      assert.match(content, /Make it a filter/);
      assert.match(content, /MOSH_BLOCKS/);
    }
  });

  it("asks for a scene of its own when the user wants one", async () => {
    const content = (await firstAsked({ kind: BackdropShaderKind.Scene }))?.content ?? "";
    assert.match(content, /scene of its own/);
    assert.match(content, /RAIN_ROW_POINTS/);
    assert.doesNotMatch(content, /Make it a filter/);
  });

  it("shows the model its body as drawn, with what stood out and a frame's cost", async () => {
    const message = await firstAsked({
      kind: BackdropShaderKind.Scene,
      refine: { wgsl: GOOD, images: [LOOK], findings: [LookFinding.Still, LookFinding.BusyCentre], frameMs: 5.23 },
    });
    assert.deepEqual(message?.images, [LOOK]);
    const content = message?.content ?? "";
    assert.match(content, /three moments/);
    assert.match(content, /hardly moves/);
    assert.match(content, /Calm the centre/);
    assert.match(content, /5\.2 ms/);
    assert.ok(content.includes(GOOD));
  });

  it("tells an engine shown no picture that the body runs, in words alone", async () => {
    const message = await firstAsked({ refine: { wgsl: GOOD, images: [], findings: [], frameMs: 0 } });
    assert.equal(message?.images, undefined);
    assert.match(message?.content ?? "", /compiles and runs/);
    assert.doesNotMatch(message?.content ?? "", /What stood out|ms at/);
  });

  const hostileLooks: Array<[string, Record<string, unknown>, unknown]> = [
    ["a page in place of a picture", { images: [{ mimeType: "text/html", data: "aGVsbG8=" }] }, undefined],
    ["markup in place of bytes", { images: [{ mimeType: "image/png", data: "<script>alert(1)</script>" }] }, undefined],
    [
      "a picture past the size kept",
      { images: [{ ...LOOK, data: "A".repeat(SHADER_LOOK_IMAGE_MAX_CHARS + 4) }] },
      undefined,
    ],
    ["more pictures than are shown", { images: [LOOK, LOOK, LOOK] }, [LOOK, LOOK]],
    ["pictures that are not a list", { images: "aGVsbG8=" }, undefined],
  ];
  for (const [name, look, shown] of hostileLooks)
    it(`shows the model only pictures it may see: ${name}`, async () => {
      const message = await firstAsked({ refine: { wgsl: GOOD, findings: [], frameMs: 0, ...look } });
      assert.deepEqual(message?.images, shown);
    });

  it("tells the model only findings it knows, and a frame's cost within reason", async () => {
    const content =
      (
        await firstAsked({
          refine: { wgsl: GOOD, images: [], findings: ["make-it-red", LookFinding.Empty], frameMs: 1e9 },
        })
      )?.content ?? "";
    assert.match(content, /almost empty/);
    assert.doesNotMatch(content, /make-it-red/);
    assert.match(content, /10000\.0 ms/);
    for (const frameMs of [Number.NaN, -3, "9"])
      assert.doesNotMatch((await firstAsked({ refine: { wgsl: GOOD, images: [], frameMs } }))?.content ?? "", / ms at/);
  });

  it("asks for a new background when the look holds no body", async () => {
    for (const refine of [{ images: [LOOK] }, { wgsl: "  ", images: [LOOK] }, "look"]) {
      const message = await firstAsked({ refine });
      assert.equal(message?.images, undefined);
      assert.doesNotMatch(message?.content ?? "", /You wrote the shader/);
    }
  });
});
