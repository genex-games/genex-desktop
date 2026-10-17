/**
 * The Game Animation Sample's Motion Matching in a game: `motion-status` finds the sample among the
 * person's Unreal projects; `add-motion-matching` saves the editor's work, quits Unreal, clones the
 * sample's character folders into the game's Content (its showcase characters left out), merges the
 * settings the game lacks, turns the sample's plugins on, keeps the copied folders out of the game's
 * checkpoints and opens Unreal again. A game with files in the way, a link where the sample's folders
 * go, a config it can't read, a taken trace channel, too little disk or no sample is refused with
 * nothing touched; an add that fails part way is taken back out. The sample here is a small synthetic
 * folder; Unreal, time and the free disk are stand-ins; files are copied for real.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { mergeEngineIni, mergeGameplayTagsIni } from "../../src/plugins/unreal/motion-config.ts";
import { createMotionTools, MotionAddState, type MotionToolsDeps } from "../../src/plugins/unreal/motion-tools.ts";
import { tmpDir } from "../helpers/tmp.ts";

const CHANNEL =
  '+DefaultChannelResponses=(Channel=ECC_GameTraceChannel1,DefaultResponse=ECR_Ignore,bTraceType=True,bStaticObject=False,Name="Traversable")';
const CVAR =
  '+CVarsArray=(Type=CVarInt,Name="DDCvar.FootPlacementMode",ToolTip="",DefaultValueFloat=0.000000,DefaultValueInt=1,DefaultValueBool=False)';
const SAMPLE_ENGINE = [
  "[ConsoleVariables]",
  "p.EnableCharacterAccelerationReplication=1",
  "",
  "[/Script/Engine.DataDrivenConsoleVariableSettings]",
  CVAR,
  "",
  "[/Script/Engine.CollisionProfile]",
  CHANNEL,
  "",
].join("\n");
const SAMPLE_TAGS = [
  "[/Script/GameplayTags.GameplayTagsSettings]",
  "ImportTagsFromConfig=True",
  '+GameplayTagList=(Tag="Traversal.Hurdle",DevComment="")',
  "",
].join("\n");
const GAME_ENGINE = [
  "[/Script/EngineSettings.GameMapsSettings]",
  "GameDefaultMap=/Game/Maps/Town.Town",
  "",
  "[/Script/Engine.CollisionProfile]",
  '+Profiles=(Name="Water",CollisionEnabled=QueryOnly)',
  "",
].join("\n");

describe("the Game Animation Sample's settings in a game's config", () => {
  it("adds the traversal channel, the data-driven and plain console variables the game lacks, once", () => {
    const merged = mergeEngineIni(GAME_ENGINE, SAMPLE_ENGINE);
    assert.ok("text" in merged);
    assert.ok(merged.text.includes("GameDefaultMap=/Game/Maps/Town.Town"), "the game's own settings stay");
    const collision = merged.text.slice(merged.text.indexOf("[/Script/Engine.CollisionProfile]"));
    assert.ok(collision.includes('+Profiles=(Name="Water"'), "its own profiles stay in their section");
    assert.ok(collision.includes(CHANNEL));
    assert.ok(merged.text.includes(CVAR));
    assert.ok(merged.text.includes("p.EnableCharacterAccelerationReplication=1"));
    const again = mergeEngineIni(merged.text, SAMPLE_ENGINE);
    assert.ok("text" in again);
    assert.equal(again.text, merged.text, "a second merge changes nothing");
  });

  it("refuses a game whose first custom trace channel is another's, and keeps one already named for traversal", () => {
    const taken = `${GAME_ENGINE}${CHANNEL.replace('"Traversable"', '"Climbable"')}\n`;
    const refused = mergeEngineIni(taken, SAMPLE_ENGINE);
    assert.ok("conflict" in refused);
    assert.match(refused.conflict, /ECC_GameTraceChannel1 as its "Climbable"/);
    const same = mergeEngineIni(`${GAME_ENGINE}${CHANNEL}\n`, SAMPLE_ENGINE);
    assert.ok("text" in same);
    assert.equal(same.text.split(CHANNEL).length - 1, 1, "the channel is not added twice");
  });

  it("adds the sample's gameplay tags the game lacks, and takes the sample's file when the game has none", () => {
    assert.equal(mergeGameplayTagsIni(null, SAMPLE_TAGS), SAMPLE_TAGS);
    const ours = '[/Script/GameplayTags.GameplayTagsSettings]\n+GameplayTagList=(Tag="Quest.Start",DevComment="")\n';
    const merged = mergeGameplayTagsIni(ours, SAMPLE_TAGS);
    assert.ok(merged.includes('Tag="Quest.Start"'));
    assert.ok(merged.includes('Tag="Traversal.Hurdle"'));
    assert.ok(!merged.includes("ImportTagsFromConfig"), "only tag lines are merged");
  });

  it("writes a file back in its own line endings, and an empty one with no blank line on top", () => {
    const crlf = mergeEngineIni(GAME_ENGINE.replaceAll("\n", "\r\n"), SAMPLE_ENGINE);
    assert.ok("text" in crlf);
    assert.equal(crlf.text.split("\r\n").length - 1, crlf.text.split("\n").length - 1, "every line ends in CRLF");
    assert.ok(
      crlf.text.startsWith("[/Script/EngineSettings.GameMapsSettings]\r\nGameDefaultMap="),
      "its lines are its own",
    );
    const empty = mergeEngineIni("", SAMPLE_ENGINE);
    assert.ok("text" in empty);
    assert.match(empty.text, /^\[/, "the first line is a section");
  });
});

/** A small Game Animation Sample among the person's Unreal projects, and a game with its Unreal project. */
async function world(gameEngine = GAME_ENGINE) {
  const root = await tmpDir("motion-tools-");
  const projects = path.join(root, "Unreal Projects");
  const sample = path.join(projects, "GameAnimationSample");
  const file = async (at: string, text: string) => {
    await mkdir(path.dirname(at), { recursive: true });
    await writeFile(at, text);
  };
  await file(path.join(projects, "Racer", "Racer.uproject"), "{}");
  // A game that got the content earlier: it holds the sample's character but none of its showcase ones.
  await file(path.join(projects, "AAA Arena", "Content", "Blueprints", "SandboxCharacter_CMC.uasset"), "x");
  const plugins = [
    { Name: "PoseSearch", Enabled: true },
    { Name: "Chooser", Enabled: true },
    { Name: "HairStrands", Enabled: false },
  ];
  await file(path.join(sample, "GameAnimationSample.uproject"), JSON.stringify({ FileVersion: 3, Plugins: plugins }));
  for (const asset of [
    "Blueprints/SandboxCharacter_CMC.uasset",
    "Blueprints/RetargetedCharacters/ABP_GenericRetarget.uasset",
    "Blueprints/RetargetedCharacters/BP_Echo.uasset",
    "Characters/UEFN_Mannequin/Meshes/SKM_UEFN_Mannequin.uasset",
    "Characters/Echo/SKM_Echo.uasset",
    "Input/IA_Move.uasset",
    "Audio/Mix.uasset",
    "Audio/Foley/Step.uasset",
  ])
    await file(path.join(sample, "Content", asset), asset);
  await file(path.join(sample, "Config", "DefaultEngine.ini"), SAMPLE_ENGINE);
  await file(path.join(sample, "Config", "DefaultGameplayTags.ini"), SAMPLE_TAGS);
  await file(path.join(sample, "Config", "DefaultNetworkPrediction.ini"), "[/Script/NetworkPrediction]\n");
  const game = path.join(root, "game");
  const project = path.join(game, "unreal", "Town.uproject");
  await file(project, JSON.stringify({ FileVersion: 3, EngineAssociation: "5.8", Plugins: [] }, null, "\t"));
  await file(path.join(game, "unreal", "Config", "DefaultEngine.ini"), gameEngine);
  await file(path.join(game, "unreal", "Content", "Maps", "Town.umap"), "town");
  await file(path.join(game, ".gitignore"), "unreal/Saved/\n");
  return { root, projects, sample, game, project, content: path.join(game, "unreal", "Content") };
}

type World = Awaited<ReturnType<typeof world>>;

/** Stand-ins for Unreal: open (answering) until quit, closed until opened; every quit and open recorded. */
function standIns(w: World, open = true, free = 500 * 1024 ** 3) {
  const done: string[] = [];
  let running = open;
  let now = 0;
  const deps: MotionToolsDeps = {
    platform: process.platform,
    project: async () => w.project,
    projectRoots: [w.projects],
    editorCall: async () => ({ saved: true, dirty: [] }),
    editorAnswers: async () => running,
    restart: {
      editors: async () => (running ? 1 : 0),
      quit: async () => {
        done.push("quit");
        running = false;
      },
      open: async () => {
        done.push("open");
        running = true;
      },
    },
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    freeBytes: async () => free,
  };
  return { deps, done };
}

/** The copy paths this computer runs: Node's copy (Linux, Windows) everywhere, and the clone on a Mac. */
const COPY_PLATFORMS = [StudioPlatform.Linux, ...(process.platform === StudioPlatform.Mac ? [StudioPlatform.Mac] : [])];

/** How long a test waits for the add job's real copy at most. */
const SETTLE_LIMIT_MS = 20_000;

/** Waits until the project's add job is no longer adding (its copy runs real processes). */
async function settled(tools: ReturnType<typeof createMotionTools>, w: World) {
  const by = Date.now() + SETTLE_LIMIT_MS;
  while (tools.adding(w.project) && Date.now() < by) await sleep(10);
  return (await tools.status("storage", "town")).adding;
}

describe("add-motion-matching", () => {
  it("clones the sample's character folders into the game, merges its settings and plugins, keeps them out of checkpoints, and reopens Unreal", async () => {
    const w = await world();
    const { deps, done } = standIns(w);
    const tools = createMotionTools(deps);
    const before = await tools.status("storage", "town");
    assert.deepEqual(before, { sample: w.sample, inGame: false, adding: { state: MotionAddState.Idle } });
    const answer = await tools.add("storage", "town", w.game);
    assert.ok("started" in answer);
    assert.match(answer.note, /about 10 minutes/);
    const adding = await settled(tools, w);
    assert.equal(adding.state, MotionAddState.Done, adding.error);
    assert.deepEqual(done, ["quit", "open"]);
    const has = (inner: string) => existsSync(path.join(w.content, inner));
    assert.ok(has("Blueprints/SandboxCharacter_CMC.uasset"));
    assert.ok(has("Blueprints/RetargetedCharacters/ABP_GenericRetarget.uasset"));
    assert.ok(has("Characters/UEFN_Mannequin/Meshes/SKM_UEFN_Mannequin.uasset"));
    assert.ok(has("Input/IA_Move.uasset"));
    assert.ok(!has("Blueprints/RetargetedCharacters/BP_Echo.uasset"), "the showcase characters stay out");
    assert.ok(!has("Characters/Echo/SKM_Echo.uasset"));
    assert.ok(has("Maps/Town.umap"), "the game's own content stays");
    const project = JSON.parse(await readFile(w.project, "utf8")) as { Plugins: Array<{ Name: string }> };
    assert.deepEqual(project.Plugins.map((plugin) => plugin.Name).sort(), ["Chooser", "PoseSearch"]);
    const engine = await readFile(path.join(w.game, "unreal", "Config", "DefaultEngine.ini"), "utf8");
    assert.ok(engine.includes(CHANNEL) && engine.includes("GameDefaultMap=/Game/Maps/Town.Town"));
    assert.ok(existsSync(path.join(w.game, "unreal", "Config", "DefaultNetworkPrediction.ini")));
    const ignored = await readFile(path.join(w.game, ".gitignore"), "utf8");
    assert.ok(ignored.startsWith("unreal/Saved/\n"), "the game's own ignores stay first");
    assert.ok(ignored.includes("/unreal/Content/Blueprints/\n"));
    assert.ok(ignored.includes("/unreal/Content/Characters/UEFN_Mannequin/\n"));
    assert.ok(!ignored.includes("/unreal/Content/Maps/"), "the game's own content stays in checkpoints");
    assert.deepEqual(await tools.add("storage", "town", w.game), { already: true });
    assert.equal((await tools.status("storage", "town")).inGame, true);
  });

  it("refuses a game that already has a file where the sample's go, touching nothing", async () => {
    const w = await world();
    await mkdir(path.join(w.content, "Input"), { recursive: true });
    await writeFile(path.join(w.content, "Input", "IA_Move.uasset"), "the game's own");
    const { deps, done } = standIns(w);
    const tools = createMotionTools(deps);
    await assert.rejects(tools.add("storage", "town", w.game), /Input\/IA_Move\.uasset/);
    assert.deepEqual(done, [], "Unreal was not quit");
    assert.ok(!existsSync(path.join(w.content, "Blueprints")), "nothing was copied");
    assert.equal(await readFile(path.join(w.content, "Input", "IA_Move.uasset"), "utf8"), "the game's own");
  });

  it("refuses a game whose first custom trace channel is another's before Unreal is touched", async () => {
    const w = await world(`${GAME_ENGINE}${CHANNEL.replace('"Traversable"', '"Climbable"')}\n`);
    const { deps, done } = standIns(w);
    await assert.rejects(createMotionTools(deps).add("storage", "town", w.game), /"Climbable"/);
    assert.deepEqual(done, []);
    assert.ok(!existsSync(path.join(w.content, "Blueprints")));
  });

  it("says where to get the sample when none is among the person's Unreal projects", async () => {
    const w = await world();
    const { deps, done } = standIns(w);
    const tools = createMotionTools({ ...deps, projectRoots: [path.join(w.root, "elsewhere")] });
    await assert.rejects(tools.add("storage", "town", w.game), /Fab or the Epic Games Launcher/);
    assert.equal((await tools.status("storage", "town")).sample, null);
    assert.deepEqual(done, []);
  });

  it("refuses a sample whose folders hold a link, copying nothing", async () => {
    const w = await world();
    const { symlink } = await import("node:fs/promises");
    await symlink("/etc", path.join(w.sample, "Content", "Input", "outside"));
    const { deps, done } = standIns(w);
    await assert.rejects(createMotionTools(deps).add("storage", "town", w.game), /is a link/);
    assert.deepEqual(done, []);
    assert.ok(!existsSync(path.join(w.content, "Blueprints")));
  });

  for (const platform of COPY_PLATFORMS)
    it(`keeps only what the copy adds out of checkpoints: the game's own folders and files in them stay in (${platform})`, async () => {
      const w = await world();
      await mkdir(path.join(w.content, "Audio"), { recursive: true });
      await writeFile(path.join(w.content, "Audio", "Theme.uasset"), "the game's own");
      const { deps } = standIns(w);
      const tools = createMotionTools({ ...deps, platform });
      await tools.add("storage", "town", w.game);
      const end = await settled(tools, w);
      assert.equal(end.state, MotionAddState.Done, end.error);
      assert.equal(await readFile(path.join(w.content, "Audio", "Theme.uasset"), "utf8"), "the game's own");
      assert.ok(existsSync(path.join(w.content, "Audio", "Mix.uasset")), "the sample's file joins the game's folder");
      const ignored = (await readFile(path.join(w.game, ".gitignore"), "utf8")).split("\n");
      assert.ok(ignored.includes("/unreal/Content/Audio/Foley/"), "a folder the copy made");
      assert.ok(ignored.includes("/unreal/Content/Audio/Mix.uasset"), "a file the copy put in the game's own folder");
      assert.ok(!ignored.includes("/unreal/Content/Audio/"), "the game's own folder stays in checkpoints");
    });

  it("refuses a game whose Content folder the sample's files go in is a link, writing nothing through it", async () => {
    const w = await world();
    const outside = path.join(w.root, "outside");
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(w.content, "Input"));
    const { deps, done } = standIns(w);
    await assert.rejects(
      createMotionTools(deps).add("storage", "town", w.game),
      /Content\/Input in the game's project is a link/,
    );
    assert.deepEqual(done, [], "Unreal was not quit");
    assert.deepEqual(await readdir(outside), [], "nothing was written through the link");
    assert.ok(!existsSync(path.join(w.content, "Blueprints")));
  });

  it("refuses a game whose config Genex can't read, rather than writing over it", async () => {
    const w = await world();
    const engine = path.join(w.game, "unreal", "Config", "DefaultEngine.ini");
    const elsewhere = path.join(w.root, "shared-engine.ini");
    await writeFile(elsewhere, GAME_ENGINE);
    const { unlink } = await import("node:fs/promises");
    await unlink(engine);
    await symlink(elsewhere, engine);
    const { deps, done } = standIns(w);
    await assert.rejects(createMotionTools(deps).add("storage", "town", w.game), /couldn't read .*DefaultEngine\.ini/);
    assert.deepEqual(done, []);
    assert.equal(await readFile(elsewhere, "utf8"), GAME_ENGINE);
  });

  it("refuses a game without the disk for the sample's content, before Unreal is touched", async () => {
    const w = await world();
    const { deps, done } = standIns(w, true, 1024 ** 3);
    await assert.rejects(createMotionTools(deps).add("storage", "town", w.game), /needs about \d+ GB free/);
    assert.deepEqual(done, []);
  });

  it("takes an add that failed part way back out: the copied files, then the settings as they were, and reopens Unreal", async () => {
    const w = await world();
    // The sample's .uproject is read last, for its plugins: one Genex can't read fails the add after the copy.
    await writeFile(path.join(w.sample, "GameAnimationSample.uproject"), "{ not json");
    const projectBefore = await readFile(w.project, "utf8");
    const { deps, done } = standIns(w);
    const tools = createMotionTools(deps);
    await tools.add("storage", "town", w.game);
    const adding = await settled(tools, w);
    assert.equal(adding.state, MotionAddState.Failed);
    assert.deepEqual(done, ["quit", "open"], "the editor the job closed is open again");
    for (const folder of ["Blueprints", "Characters", "Input", "Audio"])
      assert.ok(!existsSync(path.join(w.content, folder)), `${folder} was taken back out`);
    assert.ok(existsSync(path.join(w.content, "Maps", "Town.umap")), "the game's own content stays");
    const config = path.join(w.game, "unreal", "Config");
    assert.equal(await readFile(path.join(config, "DefaultEngine.ini"), "utf8"), GAME_ENGINE);
    assert.ok(!existsSync(path.join(config, "DefaultGameplayTags.ini")));
    assert.ok(!existsSync(path.join(config, "DefaultNetworkPrediction.ini")));
    assert.equal(await readFile(w.project, "utf8"), projectBefore);
    assert.equal(await readFile(path.join(w.game, ".gitignore"), "utf8"), "unreal/Saved/\n");
  });

  it("finds the sample, not a game that got its content earlier", async () => {
    const w = await world();
    const { deps } = standIns(w);
    assert.equal((await createMotionTools(deps).status("storage", "town")).sample, w.sample);
  });
});
