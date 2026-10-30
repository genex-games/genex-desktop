import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { validateCoverSurface } from "../../src/shared/cover-shader.ts";
import {
  ALL_COVER_LOOKS,
  COVER_FAMILIES,
  COVER_HUE_SLOTS,
  COVER_LOOKS,
  COVER_PALETTES,
  COVER_SEED_MAX,
  COVER_TOOL,
  CoverEdge,
  coverEdge,
  coverLookKey,
  coverLookName,
  coverRecipeFromTool,
  coverShaderSeed,
  OrbFamily,
  pickCoverLook,
  validateCoverRecipe,
  type CoverLook,
  type CoverRecipe,
} from "../../src/shared/cover-recipe.ts";
import { oklch, turnHue } from "../../src/shared/oklch.ts";
import { displayCover, replaceableCover, validateGameCover, type GameCover } from "../../src/shared/game-library.ts";
import { gameCoverUrl } from "../../src/shared/game-cover.ts";
import { GameWorkspaces } from "../../src/substrate/game-workspace.ts";
import { startRig } from "../helpers/studio-rig.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { createToolRegistry, loadToolModules } from "../../src/harness-seed/tools/index.ts";

const surface = "return mix(vec3(0.1,0.3,0.5), vec3(0.7,0.9,0.6), noise(p * 3.0));";
/** A repeatable random source, so a failing allocation replays the same way. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
// Host lifecycle tests inject a renderer. Actual GPU compilation/pixels are tested in Electron.
const poster =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";

it("recipes cover the 21 named looks and 12 orb families in 9 hue slots, and reject anything else", () => {
  assert.equal(COVER_LOOKS.length, 21);
  assert.deepEqual(Object.keys(COVER_PALETTES), ["clouds", "aurora", "bands", "marble", "ember", "ocean"]);
  assert.equal(COVER_FAMILIES.length, 18);
  assert.equal(ALL_COVER_LOOKS.length, 21 + 12 * COVER_HUE_SLOTS);
  for (const [family, palette] of COVER_LOOKS)
    validateGameCover({ kind: "recipe", family, palette, seed: 2718, motion: 0.6 });
  for (const family of Object.values(OrbFamily))
    for (let hue = 0; hue < COVER_HUE_SLOTS; hue++) validateGameCover({ kind: "recipe", family, hue, seed: 9 });
  const base: CoverRecipe = { kind: "recipe", family: "clouds", palette: "night", seed: 3 };
  const orb: CoverRecipe = { kind: "recipe", family: OrbFamily.Plasma, hue: 2, seed: 3 };
  for (const bad of [
    { ...base, family: "lava" },
    { ...base, palette: "lava" },
    { ...base, family: "ember", palette: "night" },
    { ...base, seed: -1 },
    { ...base, seed: 1.5 },
    { ...base, seed: 65536 },
    { ...base, motion: 2 },
    { ...base, motion: "fast" },
    { ...base, placeholder: false },
    { ...base, surface },
    { ...base, hue: 1 },
    { ...orb, palette: "violet" },
    { ...orb, hue: undefined },
    { ...orb, hue: COVER_HUE_SLOTS },
    { ...orb, hue: 1.5 },
    { ...orb, hue: -1 },
  ])
    assert.throws(() => validateCoverRecipe(bad), JSON.stringify(bad));
  assert.throws(
    () => coverRecipeFromTool({ family: "clouds", palette: "lava" }),
    /Unknown cover look clouds\/lava.*kept.*ember: lava/,
  );
  assert.deepEqual(coverRecipeFromTool({ family: "ocean", palette: "alien", seed: 7, motion: 0.2 }), {
    kind: "recipe",
    family: "ocean",
    palette: "alien",
    seed: 7,
    motion: 0.2,
  });
  const rolled = coverRecipeFromTool({ family: "bands", palette: "rose" });
  assert.ok(Number.isInteger(rolled.seed) && !("placeholder" in rolled), "a chosen look is not a placeholder");
  assert.equal(coverLookName({ family: OrbFamily.Plasma, hue: 6 }), "Plasma · 240°");
  assert.equal(coverLookName({ family: "ember", palette: "violet" }), "Ember · violet");
});

it("no two games share a look until every look of the family is taken", () => {
  const random = seededRandom(7);
  const taken: CoverLook[] = [];
  for (let n = 0; n < ALL_COVER_LOOKS.length; n++) taken.push(pickCoverLook(taken, {}, random));
  assert.equal(new Set(taken.map(coverLookKey)).size, ALL_COVER_LOOKS.length, "every look once before any repeats");
  const firstRound = taken.slice(0, COVER_FAMILIES.length).map((look) => look.family);
  assert.deepEqual(new Set(firstRound), new Set(COVER_FAMILIES), "the least-used family goes first");
  const extra = pickCoverLook(taken, {}, random);
  validateCoverRecipe({ kind: "recipe", ...extra, seed: 1 });
});

it("an orb family's new hue slot is the free one farthest from its others", () => {
  const taken: CoverLook[] = [
    { family: OrbFamily.Plasma, hue: 0 },
    { family: OrbFamily.Plasma, hue: 3 },
    { family: OrbFamily.Galaxy, hue: 6 },
  ];
  for (let n = 0; n < 5; n++)
    assert.deepEqual(pickCoverLook(taken, { family: OrbFamily.Plasma }, Math.random), {
      family: OrbFamily.Plasma,
      hue: 6,
    });
});

it("the builder names a family; Genex keeps its look free of every other game's", () => {
  const taken: CoverLook[] = [
    { family: "ember", palette: "violet" },
    { family: "ember", palette: "lava" },
    { family: OrbFamily.Plasma, hue: 0 },
  ];
  const ember = coverRecipeFromTool({ family: "ember", palette: "violet", seed: 4 }, taken);
  assert.deepEqual(ember, { kind: "recipe", family: "ember", palette: "toxic", seed: 4 });
  const plasma = coverRecipeFromTool({ family: "plasma", palette: "violet", seed: 5 }, taken);
  assert.equal(plasma.family, OrbFamily.Plasma);
  assert.equal(plasma.palette, undefined, "orb families take a hue, not a palette");
  assert.notEqual(plasma.hue, 0);
  const full = ["lava", "violet", "toxic"].map((palette) => ({ family: "ember" as const, palette }));
  assert.equal(
    coverRecipeFromTool({ family: "ember", palette: "lava" }, full).palette,
    "lava",
    "a full family repeats",
  );
  assert.throws(() => coverRecipeFromTool({ family: "comet" }), /Unknown cover look comet/);
});

it("an orb cover's still keeps its family colours, turned to its hue", () => {
  const still = (hue: number) =>
    decodeURIComponent(gameCoverUrl({ kind: "recipe", family: OrbFamily.Caustic, hue, seed: 4 }));
  assert.match(still(0), /^data:image\/svg\+xml,<svg/);
  assert.doesNotMatch(still(0), /<script|onload|href=|<image/);
  assert.notEqual(still(0), still(3));
  assert.equal(turnHue("#3c44c4", 0), "#3c44c4");
  const [lightness, , hue] = oklch("#5d8df0");
  const [turnedLightness, , turnedHue] = oklch(turnHue("#5d8df0", 120));
  assert.ok(Math.abs(turnedLightness - lightness) < 0.01, "a hue turn keeps lightness");
  const turn = (((turnedHue - hue) * 180) / Math.PI + 360) % 360;
  assert.ok(Math.abs(turn - 120) < 1, `turned by ${turn}°`);
  assert.equal(coverEdge({ kind: "recipe", family: OrbFamily.Voxel, hue: 0, seed: 1 }), CoverEdge.Ragged);
  assert.equal(coverEdge({ kind: "recipe", family: OrbFamily.Plasma, hue: 0, seed: 1 }), CoverEdge.Round);
  assert.equal(coverEdge({ kind: "recipe", family: "clouds", palette: "genex", seed: 1 }), CoverEdge.Round);
});

it("the sphere program draws every valid recipe seed as that seed modulo 997", () => {
  // The cover poster (main/game-cover-renderer.ts) and the live sphere both pass the seed through
  // coverShaderSeed, so a game's poster and its animation start from the same noise offset.
  for (let seed = 0; seed <= COVER_SEED_MAX; seed++) assert.equal(coverShaderSeed(seed), seed % 997);
});

it("the tool schema carries the looks as enums, and the seeded harness tool matches it", async () => {
  const { family, palette } = COVER_TOOL.parameters.properties;
  assert.deepEqual(family.enum, COVER_FAMILIES);
  assert.deepEqual(new Set(palette.enum), new Set(COVER_LOOKS.map(([, name]) => name)));
  assert.deepEqual(COVER_TOOL.parameters.required, ["family"]);
  const { modules } = await loadToolModules(path.resolve("src/harness-seed"));
  const seeded = modules.flatMap((module) => module.tools).find((tool) => tool.name === COVER_TOOL.name);
  assert.ok(seeded, "the harness seed ships the recipe tool");
  assert.deepEqual(seeded.parameters, COVER_TOOL.parameters);
  assert.equal(seeded.description, COVER_TOOL.description);
  assert.ok(
    !modules.flatMap((module) => module.tools).some((tool) => tool.name === "set_game_cover_shader"),
    "new harnesses no longer author GLSL",
  );
});

it("records from before recipes each get a look of their own, without rewriting them", () => {
  const oldDefault: GameCover = {
    kind: "shader",
    version: 1,
    surface: "return vec3(0.5);",
    seed: 145,
    poster,
    custom: false,
  };
  const saved = JSON.stringify(oldDefault);
  const shown = displayCover(oldDefault)!;
  assert.equal(shown.kind, "recipe");
  validateGameCover(shown);
  assert.deepEqual(displayCover(oldDefault), shown, "deterministic");
  assert.equal(JSON.stringify(oldDefault), saved, "display resolution must not mutate persisted defaults");
  const looks = new Set(
    Array.from({ length: 40 }, (_, seed) => {
      const look = displayCover({ ...oldDefault, seed })!;
      return look.kind === "recipe" ? `${look.family}/${look.palette}` : "";
    }),
  );
  assert.ok(looks.size >= 12, `old defaults spread across looks (${looks.size})`);
  assert.deepEqual(displayCover(undefined, "snow-temple"), displayCover(undefined, "snow-temple"));
  assert.notDeepEqual(displayCover(undefined, "snow-temple"), displayCover(undefined, "moon-racer"));
  assert.deepEqual(displayCover(), { kind: "recipe", family: "clouds", palette: "genex", seed: 23, placeholder: true });
  for (const version of [1, 2] as const) {
    const custom: GameCover = { ...oldDefault, version, custom: true };
    assert.equal(displayCover(custom), custom);
    assert.equal(gameCoverUrl(custom), poster);
    validateGameCover(custom);
    assert.equal(replaceableCover(custom), false);
  }
  const uploaded: GameCover = { kind: "image", dataUrl: poster };
  assert.equal(displayCover(uploaded), undefined);
  assert.equal(gameCoverUrl(uploaded), poster);
  assert.equal(replaceableCover(uploaded), false);
  assert.equal(displayCover({ kind: "procedural", seed: 1, style: "world", palette: 0 }), undefined);
  const still = decodeURIComponent(gameCoverUrl({ kind: "recipe", family: "ember", palette: "lava", seed: 4 }));
  assert.match(still, /^data:image\/svg\+xml,<svg/);
  assert.doesNotMatch(still, /<script|onload|href=|<image/);
  assert.equal(replaceableCover(), true);
  assert.equal(replaceableCover(oldDefault), true);
  assert.equal(
    replaceableCover({ kind: "recipe", family: "clouds", palette: "day", seed: 1, placeholder: true }),
    true,
  );
  assert.equal(replaceableCover({ kind: "recipe", family: "clouds", palette: "day", seed: 1 }), false);
});

it("legacy cover grammar names what it refused", () => {
  const refusals: Array<[string, RegExp]> = [
    [`return vec3(${"sin(".repeat(17)}time${")".repeat(17)});`, /nest at most 16 levels/],
    [`return vec3(${Array(65).fill("sin(time)").join("+")});`, /at most 64 calls/],
    ["return vec3(foo);", /Unknown cover variable: foo\./],
    ["float time = 1.0; return vec3(time);", /Reserved or duplicate cover variable: time\./],
    ["return vec3(1.0));", /Unbalanced cover expression/],
    ["return vec3((1.0);", /Unbalanced cover expression/],
    ["float a = (time = 1.0); return vec3(a);", /Assignments are allowed only in declarations/],
    ["vec3 c = vec3(1.0); float b = 1.0;", /declarations followed by one final return/],
  ];
  for (const [bad, message] of refusals) assert.throws(() => validateCoverSurface(bad), message, bad);
  validateCoverSurface("vec3 c = p.zyx; return c.bgr;");
});

it("legacy cover grammar still permits bounded math and rejects code, loops and unbounded expansion", () => {
  validateCoverSurface(surface);
  validateCoverSurface("float a = sin(time * 1e-2); return vec3(p.xy, a);");
  for (const bad of [
    "while (true) {}",
    "for(int i=0;i<100;i++){} return vec3(1.0);",
    "#define X 1\nreturn vec3(X);",
    "return texture2D(image,p.xy).rgb;",
    "return surfaceColor(p,time,seed);",
    "return gl_FragColor.rgb;",
    "return vec3(0.0); return vec3(1.0);",
    "p = vec3(0.0); return p;",
    "float a = (time = 1.0); return vec3(a);",
    "return vec3(1.0);// hi",
    "return vec3(" + "sin(".repeat(17) + "time" + ")".repeat(17) + ");",
    "return vec3(" + Array(65).fill("sin(time)").join("+") + ");",
    " ".repeat(2401),
    "return vec3(1.0)",
    "return vec3(foo);",
  ])
    assert.throws(() => validateCoverSurface(bad), bad);
  assert.throws(() =>
    validateGameCover({
      kind: "shader",
      version: 1,
      custom: true,
      seed: 1,
      surface,
      poster: "data:image/svg+xml,<svg/>",
    }),
  );
});

it("a new game is born with a look; the first one is always Clouds in the Genex sky", async () => {
  const rig = await startRig({ replies: [] });
  try {
    const first = await rig.core.createGame("First game");
    assert.deepEqual(
      { ...first.cover, seed: 0 },
      { kind: "recipe", family: "clouds", palette: "genex", seed: 0, placeholder: true },
    );
    const covers = [];
    for (let n = 0; n < 6; n++) covers.push((await rig.core.createGame(`Next ${n}`)).cover);
    for (const cover of covers) {
      assert.equal(cover?.kind, "recipe");
      validateGameCover(cover!);
      assert.equal(replaceableCover(cover), true);
    }
    const looks = [first.cover, ...covers].map((cover) => coverLookKey(cover as CoverRecipe));
    assert.equal(new Set(looks).size, looks.length, "no two new games share a look");
    const restarted = new GameWorkspaces(rig.core.games);
    for (let n = 0; n < 6; n++)
      assert.deepEqual((await restarted.presentation(`next-${n}`)).cover, covers[n], "the roll is kept");
    await rig.core.games.ensureCover("next-0");
    assert.deepEqual(
      (await rig.core.games.presentation("next-0")).cover,
      covers[0],
      "a later brief keeps the rolled look",
    );
    // An opened folder without a look keeps the one its row already showed.
    const opened = await rig.core.games.scaffold("opened-folder");
    assert.equal(opened.cover, undefined);
    await rig.core.games.ensureCover(opened.name);
    assert.deepEqual((await rig.core.games.presentation(opened.name)).cover, displayCover(undefined, opened.name));
  } finally {
    await rig.stop();
  }
});

it("the builder picks a recipe once; it stays bound to its game and never replaces an upload", async () => {
  const rig = await startRig({ replies: [] });
  try {
    rig.core.options.renderGameCover = async () => {
      throw Error("recipes never render in the main process");
    };
    const api = rig.core.api() as unknown as Record<string, (args: any) => Promise<any>>;
    for (const engine of ["claude-code", "codex", "bonsai"]) {
      const game = await rig.core.createGame(`Cover ${engine}`),
        threadId = await rig.core.threadForGame(game.name);
      const before = await readFile(path.join(game.dir, "studio.json"), "utf8");
      let mode = "create";
      let chosen = "";
      rig.core.engines.register({
        id: engine,
        label: "fixture",
        kind: "delegated",
        supportsSessions: true,
        status: async () => ({ code: "ready", detail: "fixture" }),
        models: async () => [],
        delegate: async (request: DelegateRequest) => {
          const tool = request.liveTools?.find((tool) => tool.name === COVER_TOOL.name);
          if (mode === "create") {
            assert.ok(tool);
            // Flipped (phase 5): the tool is offered with no standing nudge to pick a look.
            assert.doesNotMatch(request.prompt, /set_game_cover once/);
            await assert.rejects(
              request.onLiveTool!(COVER_TOOL.name, { family: "clouds", palette: "lava" }),
              /Unknown cover look/,
            );
            const saved = String(
              await request.onLiveTool!(COVER_TOOL.name, { family: "ember", palette: "violet", seed: 11 }),
            );
            // The family is kept; a palette another game already shows moves to a free one.
            chosen = saved.match(/Ember · (\w+)/)?.[1] ?? "";
            assert.ok(chosen, saved);
            if (engine === "claude-code") assert.equal(chosen, "violet", "a free palette is kept as asked");
          } else assert.equal(tool, undefined, "chosen covers and read-only sessions do not receive the tool");
          return { ok: true, engine, summary: "fixture", turns: 1, usage: {} };
        },
      } as never);
      await api["engine.delegate"]!({
        engine,
        project: game.name,
        threadId,
        prompt: "Build a tidal garden",
        model: "fixture-model",
      });
      mode = "existing";
      await api["engine.delegate"]!({ engine, project: game.name, threadId, prompt: "Continue" });
      const stored = (await new GameWorkspaces(rig.core.games).presentation(game.name)).cover;
      assert.deepEqual(stored, { kind: "recipe", family: "ember", palette: chosen, seed: 11 });
      assert.equal(
        await readFile(path.join(game.dir, "studio.json"), "utf8"),
        before,
        "artwork is not written into the game",
      );
      const next = await rig.core.createGame(`Read only ${engine}`);
      await api["engine.delegate"]!({ engine, project: next.name, prompt: "Inspect", readOnly: true });
    }
    const game = await rig.core.createGame("Local cover"),
      threadId = await rig.core.threadForGame(game.name);
    const registry = await createToolRegistry(
      { workspace: rig.core.layout.harnessWs, call: (name: string, args: any) => api[name]!(args) } as never,
      { project: game.name },
    );
    assert.ok(registry.names().includes(COVER_TOOL.name));
    const response = await registry.execute(
      { name: COVER_TOOL.name, arguments: { family: "marble", palette: "jade" } },
      { project: game.name, threadId, call: (name: string, args: any) => api[name]!(args) } as never,
    );
    assert.equal(response.ok, true);
    assert.match(response.content, /Marble · \w+/, "the family is kept; a taken palette moves");
    assert.equal((await rig.core.games.presentation(game.name)).cover?.kind, "recipe");
    const other = await rig.core.createGame("Other cover");
    await assert.rejects(
      api["game.setCover"]!({ project: other.name, threadId, family: "clouds", palette: "day" }),
      /bound/,
    );
    await rig.core.updateGame(other.name, { cover: { kind: "image", dataUrl: poster } });
    assert.match(await api["game.setCover"]!({ project: other.name, family: "clouds", palette: "day" }), /kept/);
    assert.deepEqual((await rig.core.games.presentation(other.name)).cover, { kind: "image", dataUrl: poster });
    const candidate = await createToolRegistry(
      {
        workspace: rig.core.layout.harnessWs,
        call: () => {
          throw Error("unexpected");
        },
      } as never,
      { candidateId: "fixture" },
    );
    assert.ok(!candidate.names().includes(COVER_TOOL.name));
  } finally {
    await rig.stop();
  }
});

it("harnesses from before recipes can still author a custom GLSL cover; failures and uploads keep the previous one", async () => {
  const rig = await startRig({ replies: [] });
  try {
    const api = rig.core.api() as unknown as Record<string, (args: any) => Promise<any>>;
    let renders = 0;
    rig.core.options.renderGameCover = async (code) => {
      validateCoverSurface(code);
      renders++;
      return poster;
    };
    const game = await rig.core.createGame("Legacy cover");
    const result = await api["game.setCoverShader"]!({ project: game.name, surface });
    assert.equal(result.images[0].mimeType, "image/png");
    const stored = (await rig.core.games.presentation(game.name)).cover;
    assert.ok(stored?.kind === "shader");
    assert.deepEqual(
      { ...stored, seed: 0 },
      { kind: "shader", version: 2, surface, seed: 0, poster, custom: true },
      "the placeholder recipe gives way to the custom shader",
    );
    assert.match(await api["game.setCoverShader"]!({ project: game.name, surface }), /preserved/);
    assert.equal(renders, 1);
    const race = await rig.core.createGame("Cover race");
    const before = (await rig.core.games.presentation(race.name)).cover;
    rig.core.options.renderGameCover = async () => {
      throw Error("compile failed");
    };
    await assert.rejects(api["game.setCoverShader"]!({ project: race.name, surface }), /compile failed/);
    assert.deepEqual((await rig.core.games.presentation(race.name)).cover, before);
    rig.core.options.renderGameCover = async () => {
      await rig.core.updateGame(race.name, { cover: { kind: "image", dataUrl: poster } });
      return poster;
    };
    assert.match(await api["game.setCoverShader"]!({ project: race.name, surface }), /newer image was preserved/);
    assert.deepEqual((await rig.core.games.presentation(race.name)).cover, { kind: "image", dataUrl: poster });
  } finally {
    await rig.stop();
  }
});
