/**
 * What a job making an asset is and says, wherever it is shown. The shared words first: what each
 * Genex operation makes and with which tool, where a Genex job is from its own word, which calls
 * make nothing, and what any other tool may declare about its calls (a hostile declaration says
 * nothing). Then what a card or a chat row says from those words: the kind and its drawing, the
 * tool (Genex's routed tool, Blender, or the plugin by its own name and picture), what became of
 * a job that stopped short, and a clock that never runs backwards or overflows.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CALL_PROMPT_MAX,
  GENEX_MAKING_MAX_MS,
  callMaking,
  genexCallMaking,
  genexJobShown,
  genexMaking,
  genexPhase,
  GenexTool,
  isUnderWay,
  keptPrompt,
  MakingKind,
  type MakingJob,
  MakingPhase,
  readToolAsset,
} from "../../src/shared/asset-making.ts";
import { GenexJobStatus, GenexOperation, type GenexJob } from "../../src/shared/genex.ts";
import type { PluginAssetKind } from "../../src/plugin-sdk/index.d.ts";
import { elapsedWords, kindLook, makingView } from "../../src/renderer/asset-making.ts";
import { MakingDrawing } from "../../src/renderer/making-art.ts";
import { genexJobRows } from "../../src/renderer/panels/plugins/genex/genex-view.ts";

// The SDK's kinds and the shared ones are the same words, both ways round.
const sdkKinds: readonly PluginAssetKind[] = Object.values(MakingKind);
const sharedKinds: readonly MakingKind[] = [] as PluginAssetKind[];
void [sdkKinds, sharedKinds];

const START = Date.parse("2026-10-13T12:00:00.000Z");
const job = (over: Partial<MakingJob> = {}): MakingJob => ({
  source: "genex",
  jobId: "job-1",
  at: "2026-10-13T12:00:00.000Z",
  kind: MakingKind.Character,
  tool: GenexTool.Meshy,
  phase: MakingPhase.Making,
  prompt: "Knight in rusted plate armor",
  ...over,
});

describe("Genex's operations in the shared words", () => {
  it("names what each lane makes and the tool it is routed to", () => {
    const lanes: Array<[string, MakingKind, GenexTool | null]> = [
      [GenexOperation.Character, MakingKind.Character, GenexTool.Meshy],
      [GenexOperation.CharacterPreview, MakingKind.Character, GenexTool.Meshy],
      [GenexOperation.CharacterFinalize, MakingKind.Character, GenexTool.Meshy],
      [GenexOperation.Creature, MakingKind.Creature, GenexTool.Meshy],
      [GenexOperation.CharacterImport, MakingKind.Character, GenexTool.Uthana],
      [GenexOperation.Model, MakingKind.Model, GenexTool.Tripo],
      [GenexOperation.ModelImport, MakingKind.Model, GenexTool.Tripo],
      [GenexOperation.ModelSegment, MakingKind.Model, GenexTool.Tripo],
      [GenexOperation.ModelRig, MakingKind.RiggedModel, GenexTool.Tripo],
      [GenexOperation.ModelAnimate, MakingKind.Animation, GenexTool.Tripo],
      [GenexOperation.CharacterAnimate, MakingKind.Animation, null],
      [GenexOperation.CreatureAnimate, MakingKind.Animation, null],
      [GenexOperation.Image, MakingKind.Image, GenexTool.GptImage],
      [GenexOperation.Texture, MakingKind.Texture, GenexTool.NanoBanana],
      [GenexOperation.Video, MakingKind.Video, GenexTool.MiniMax],
      [GenexOperation.Sfx, MakingKind.SoundEffect, GenexTool.ElevenLabs],
      [GenexOperation.Music, MakingKind.Music, GenexTool.ElevenLabs],
      [GenexOperation.Voice, MakingKind.Voice, GenexTool.ElevenLabs],
    ];
    for (const [operation, kind, tool] of lanes) assert.deepEqual(genexMaking(operation), { kind, tool }, operation);
  });

  it("makes nothing of a lookup, a wait, a check, an unknown word or an inherited name", () => {
    const none = [
      GenexOperation.Status,
      GenexOperation.Wait,
      GenexOperation.CharacterMotions,
      GenexOperation.AnimationsSearch,
      GenexOperation.InspectUse,
      GenexOperation.VerifyUse,
      "hologram",
      "constructor",
      "__proto__",
      "toString",
      "",
      null,
      undefined,
    ];
    for (const operation of none) assert.equal(genexMaking(operation), null, String(operation));
  });

  it("reads Genex's word for a job as a phase, and treats a word it does not know as still making", () => {
    const phases: Array<[string | undefined, MakingPhase]> = [
      [GenexJobStatus.Requested, MakingPhase.Queued],
      [GenexJobStatus.Submitting, MakingPhase.Queued],
      [GenexJobStatus.Accepted, MakingPhase.Making],
      [GenexJobStatus.Generating, MakingPhase.Making],
      [GenexJobStatus.ApprovalRequired, MakingPhase.Review],
      [GenexJobStatus.Generated, MakingPhase.NotFetched],
      [GenexJobStatus.Downloaded, MakingPhase.NotInGame],
      [GenexJobStatus.Failed, MakingPhase.Failed],
      [GenexJobStatus.RetrievalFailed, MakingPhase.Failed],
      [GenexJobStatus.Stopped, MakingPhase.Stopped],
      [GenexJobStatus.Canceled, MakingPhase.Stopped],
      [GenexJobStatus.Unresolved, MakingPhase.Unsure],
      ["rendering-frames", MakingPhase.Making],
      ["constructor", MakingPhase.Making],
      [undefined, MakingPhase.Making],
    ];
    for (const [status, phase] of phases) assert.equal(genexPhase(status), phase, String(status));
  });

  it("never spins for a job whose files were delivered and are gone from the game", () => {
    assert.equal(genexPhase(GenexJobStatus.Generating, { delivered: true }), MakingPhase.NotInGame);
    assert.equal(genexPhase(undefined, { delivered: true }), MakingPhase.NotInGame);
    assert.equal(genexPhase(GenexJobStatus.Failed, { delivered: true }), MakingPhase.Failed);
  });

  it("stops believing a job still says it is being made long after any lane would have finished", () => {
    const over = GENEX_MAKING_MAX_MS + 1;
    assert.equal(genexPhase(GenexJobStatus.Accepted, { ageMs: over }), MakingPhase.Unsure);
    assert.equal(genexPhase(GenexJobStatus.Requested, { ageMs: over }), MakingPhase.Unsure);
    assert.equal(
      genexPhase(GenexJobStatus.Accepted, { ageMs: GENEX_MAKING_MAX_MS }),
      MakingPhase.Making,
      "at the limit it still is",
    );
    assert.equal(
      genexPhase(GenexJobStatus.ApprovalRequired, { ageMs: over }),
      MakingPhase.Review,
      "a choice waits on the person",
    );
    assert.equal(genexPhase(GenexJobStatus.Failed, { ageMs: over }), MakingPhase.Failed);
    assert.equal(
      genexPhase(GenexJobStatus.Accepted, { ageMs: null }),
      MakingPhase.Making,
      "a job that never said when stays as it says",
    );
  });

  it("shows no card for an approved review or a call that makes nothing; a record naming no operation is an asset", () => {
    assert.equal(genexJobShown({ operation: GenexOperation.CharacterPreview, status: GenexJobStatus.Approved }), false);
    assert.equal(
      genexJobShown({ operation: GenexOperation.CharacterMotions, status: GenexJobStatus.Generated }),
      false,
    );
    assert.equal(genexJobShown({ operation: GenexOperation.Wait, status: GenexJobStatus.Generating }), false);
    assert.equal(
      genexJobShown({ operation: GenexOperation.Image, status: GenexJobStatus.Failed, generationId: "g" }),
      true,
      "a generation that failed says so",
    );
    assert.equal(genexJobShown({ status: GenexJobStatus.Generating }), true);
  });

  it("shows no card for a request that ended before Genex started a generation for it", () => {
    for (const status of [GenexJobStatus.Failed, GenexJobStatus.Canceled, GenexJobStatus.Stopped])
      assert.equal(genexJobShown({ operation: GenexOperation.Character, status }), false, status);
    assert.equal(
      genexJobShown({ operation: GenexOperation.Character, status: GenexJobStatus.Unresolved }),
      true,
      "a submit whose answer never came may have started one",
    );
  });

  it("stamps a call of Genex's asset tool with its lane, and a lookup with nothing", () => {
    assert.deepEqual(genexCallMaking({ operation: GenexOperation.Texture, prompt: "Mossy cobbles" }), {
      kind: MakingKind.Texture,
      tool: GenexTool.NanoBanana,
      prompt: "Mossy cobbles",
    });
    assert.deepEqual(genexCallMaking({ operation: GenexOperation.CharacterAnimate, prompt: 7 }), {
      kind: MakingKind.Animation,
    });
    assert.equal(genexCallMaking({ operation: GenexOperation.Status }), null);
    assert.equal(genexCallMaking({}), null);
  });
});

describe("what any other tool may say its calls make", () => {
  it("keeps a well-formed declaration and nothing else of it", () => {
    assert.deepEqual(readToolAsset({ kind: "image" }), { kind: MakingKind.Image });
    assert.deepEqual(readToolAsset({ kind: "voice", prompt: "text", tool: " Narrator ", extra: { a: 1 } }), {
      kind: MakingKind.Voice,
      prompt: "text",
      tool: "Narrator",
    });
  });

  it("refuses a declaration that is not one, saying nothing rather than guessing", () => {
    const hostile: unknown[] = [
      null,
      undefined,
      "image",
      ["image"],
      42,
      {},
      { kind: "hologram" },
      { kind: "constructor" },
      { kind: "Image" },
      { kind: "image", prompt: "" },
      { kind: "image", prompt: "   " },
      { kind: "image", prompt: "p".repeat(65) },
      { kind: "image", prompt: 5 },
      { kind: "image", tool: "t".repeat(41) },
      { kind: "image", tool: ["Pixel Lab"] },
      JSON.parse('{"__proto__": {"kind": "image"}}'),
    ];
    for (const value of hostile) assert.equal(readToolAsset(value), null, JSON.stringify(value));
  });

  it("takes a call's prompt from the argument the tool names, else `prompt`, cut to the cap with an ellipsis", () => {
    assert.deepEqual(callMaking({ kind: MakingKind.Model }, { prompt: "A crate" }), {
      kind: MakingKind.Model,
      prompt: "A crate",
    });
    assert.deepEqual(callMaking({ kind: MakingKind.Model, prompt: "name", tool: "Blender" }, { name: "crate" }), {
      kind: MakingKind.Model,
      tool: "Blender",
      prompt: "crate",
    });
    assert.deepEqual(callMaking({ kind: MakingKind.Image }, { prompt: { text: "no" } }), { kind: MakingKind.Image });
    const long = keptPrompt("x".repeat(CALL_PROMPT_MAX + 50));
    assert.equal(long?.length, CALL_PROMPT_MAX);
    assert.ok(long?.endsWith("…"));
    assert.equal(keptPrompt("x".repeat(CALL_PROMPT_MAX)), "x".repeat(CALL_PROMPT_MAX), "a prompt at the cap is whole");
    assert.equal(keptPrompt("  "), undefined);
  });

  it("calls a job still on its way while it is queued, being made or waiting on the person", () => {
    const under = Object.values(MakingPhase).filter(isUnderWay);
    assert.deepEqual(under, [MakingPhase.Queued, MakingPhase.Making, MakingPhase.Review]);
  });
});

describe("what a job says: kind, drawing and tool", () => {
  it("draws and names each kind, and shows the tool its Genex lane is routed to", () => {
    const cases: Array<[MakingKind, GenexTool, string, string, string]> = [
      [MakingKind.Character, GenexTool.Meshy, "Character", MakingDrawing.Character, "Meshy"],
      [MakingKind.Creature, GenexTool.Meshy, "Creature", MakingDrawing.Character, "Meshy"],
      [MakingKind.Model, GenexTool.Tripo, "3D model", MakingDrawing.Model, "Tripo"],
      [MakingKind.RiggedModel, GenexTool.Tripo, "Rigged model", MakingDrawing.Model, "Tripo"],
      [MakingKind.Image, GenexTool.GptImage, "Image", MakingDrawing.Image, "GPT Image"],
      [MakingKind.Texture, GenexTool.NanoBanana, "Texture", MakingDrawing.Texture, "Nano Banana"],
      [MakingKind.Video, GenexTool.MiniMax, "Video", MakingDrawing.Video, "MiniMax"],
      [MakingKind.SoundEffect, GenexTool.ElevenLabs, "Sound effect", MakingDrawing.Sound, "ElevenLabs"],
      [MakingKind.Music, GenexTool.ElevenLabs, "Music", MakingDrawing.Sound, "ElevenLabs"],
      [MakingKind.Voice, GenexTool.ElevenLabs, "Voice", MakingDrawing.Sound, "ElevenLabs"],
    ];
    for (const [kind, tool, title, drawing, name] of cases) {
      const view = makingView(job({ kind, tool }));
      assert.deepEqual([view.title, view.drawing, view.tool.name], [title, drawing, name], kind);
      assert.ok(view.tool.mark?.startsWith("media/tools/"), `${kind} wears its tool's mark`);
    }
  });

  it("shows Genex itself when no one tool makes it, and a kind nobody said as an asset drawn as a model", () => {
    const animation = makingView(job({ kind: MakingKind.Animation, tool: undefined }));
    assert.deepEqual([animation.title, animation.drawing, animation.tool.name], ["Animation", "character", "Genex"]);
    for (const kind of [undefined, "hologram", "constructor", "__proto__"]) {
      const unnamed = makingView(job({ kind: kind as MakingKind | undefined }));
      assert.deepEqual([unnamed.title, unnamed.drawing], ["Asset", MakingDrawing.Model], String(kind));
    }
    assert.equal(makingView(job({ tool: "made-up" })).tool.name, "Genex", "Genex names only its own tools");
  });

  it("names Blender's jobs Blender, and any other plugin's by the tool it names, else by the plugin, with its picture", () => {
    const blender = makingView(job({ source: "blender", tool: undefined }));
    assert.equal(blender.tool.name, "Blender");
    assert.ok(blender.tool.mark);
    const forge = { name: "Sprite Forge", icon: "studio-plugin://sprite-forge/.icon?v=1" };
    assert.deepEqual(makingView(job({ source: "sprite-forge", tool: undefined }), forge).tool, {
      name: "Sprite Forge",
      mark: forge.icon,
    });
    assert.deepEqual(makingView(job({ source: "sprite-forge", tool: "Pixel Lab" }), forge).tool, {
      name: "Pixel Lab",
      mark: forge.icon,
    });
    assert.deepEqual(makingView(job({ source: "my-server", tool: undefined })).tool, { name: "my-server", mark: null });
    assert.deepEqual(makingView(job({ source: "my-server", tool: "  " }), { name: "My server" }).tool, {
      name: "My server",
      mark: null,
    });
  });

  it("keeps the Genex page's names for its generations", () => {
    const genexJob = (operation: string): GenexJob => ({
      id: operation,
      project: "p",
      operation,
      status: GenexJobStatus.Generating,
      files: [],
      createdAt: "2026-10-13T12:00:00.000Z",
    });
    const operations = [GenexOperation.ModelAnimate, GenexOperation.Sfx, GenexOperation.CharacterMotions, "hologram"];
    const rows = genexJobRows(operations.map(genexJob));
    assert.deepEqual(
      rows.map((row) => [row.label, row.icon]),
      [
        ["Asset", "box"],
        ["Animation", "character"],
        ["Sound effect", "sound"],
        ["Animation", "character"],
      ],
    );
    assert.deepEqual(kindLook(MakingKind.Texture).icon, "image");
  });
});

describe("what a job says: where it is, the prompt and what a screen reader hears", () => {
  it("says what became of a job that stopped short in place of its kind", () => {
    assert.equal(makingView(job({ phase: MakingPhase.Failed })).title, "Didn’t finish");
    assert.equal(makingView(job({ phase: MakingPhase.Stopped })).title, "Stopped");
    assert.equal(makingView(job({ phase: MakingPhase.Unsure })).title, "Not confirmed");
    assert.equal(makingView(job({ phase: MakingPhase.NotFetched })).title, "Not downloaded");
    assert.equal(makingView(job({ phase: MakingPhase.NotInGame })).title, "Not in your game");
    assert.equal(makingView(job({ phase: MakingPhase.Review })).title, "Character");
  });

  it("keeps the whole prompt for the tooltip and drops one that is only blank", () => {
    const long = "A".repeat(480);
    assert.equal(makingView(job({ prompt: long })).prompt, long);
    assert.equal(makingView(job({ prompt: "   " })).prompt, null);
    assert.equal(makingView(job({ prompt: undefined })).prompt, null);
  });

  it("says the kind, where it is, the tool and the prompt", () => {
    assert.equal(makingView(job()).label, "Character being made with Meshy. Knight in rusted plate armor");
    assert.equal(makingView(job({ phase: MakingPhase.Queued, prompt: undefined })).label, "Character queued for Meshy");
    assert.equal(
      makingView(job({ phase: MakingPhase.Review, prompt: undefined })).label,
      "Character from Meshy waits for your choice",
    );
    assert.equal(
      makingView(job({ phase: MakingPhase.Failed, prompt: undefined })).label,
      "Character from Meshy: Didn’t finish",
    );
  });
});

describe("what a job says: the clock", () => {
  it("counts up from when the job started, in minutes and seconds, then hours", () => {
    assert.equal(elapsedWords(START, START + 42_000), "0:42");
    assert.equal(elapsedWords(START, START + (12 * 60 + 5) * 1000), "12:05");
    assert.equal(elapsedWords(START, START + (3600 + 2 * 60 + 3) * 1000), "1:02:03");
    assert.equal(elapsedWords(START, START + 99 * 3600 * 1000), "99:00:00");
  });

  it("never runs backwards, never overflows, and shows nothing when the job never said when it started", () => {
    assert.equal(elapsedWords(START, START - 5000), "0:00", "a start a little in the future is now");
    assert.equal(elapsedWords(START, START + 100 * 3600 * 1000), "99+ h");
    assert.equal(elapsedWords(null, START), null);
    assert.equal(elapsedWords(START, Number.NaN), null);
    assert.equal(makingView(job({ at: "not a date" })).startedAt, null);
    assert.equal(makingView(job({ at: undefined })).startedAt, null);
    assert.equal(makingView(job()).startedAt, START);
  });
});
