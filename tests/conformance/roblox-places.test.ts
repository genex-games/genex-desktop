/**
 * The places a Roblox game can build in, through the plugin's backend over a fake Mac whose game
 * folders, storage and Documents are real temporary folders:
 * - Choose your place (`places`): the places open in Studio first, then place files from Studio's
 *   recent list and Documents › Roblox, read only on this press, one row per real path, at most 12;
 *   two Studios with one name are told apart.
 * - Use in this game (`use-place`): a local place links its file where it is; a published place
 *   writes `default.project.json` (recorded as Genex's own) and links it with its ids as strings; a
 *   place never saved links by its name in Studio. A place another live game builds in is refused,
 *   and is free again once that game is gone. Hostile place paths are refused with nothing linked.
 * - New Roblox game (`create`, `new-game`) writes the place, links it and opens it in Studio;
 *   Open Studio opens a game's own place, or brings Studio forward when the place is already open.
 * - The status, the toolbar and the steps card never read Documents.
 * - With the plugin on, the engine choice offers "Roblox game" from the plugin's scaffold.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { engineChoiceRule } from "../../src/harness-seed/loop/unreal-prompts.ts";
import type { PluginContext, PluginScalar } from "../../src/plugin-sdk/index.d.ts";
import { agentsAt, readAgentMarks } from "../../src/plugins/roblox/agent-marks.ts";
import { createRobloxBackend, type RobloxDeps } from "../../src/plugins/roblox/backend.ts";
import { CHECK_CONFIGS } from "../../src/plugins/roblox/check-scripts.ts";
import {
  MAX_PLACES,
  type PlacesAnswer,
  PlaceError,
  PlaceRefusal,
  placeFile,
  SCAN_KEEP_MS,
  type UsePlaceAnswer,
} from "../../src/plugins/roblox/places.ts";
import { placeMatcher, readPlaceLink } from "../../src/plugins/roblox/studio-binding.ts";
import { STUDIO_MAC_APP, systemLocateFs } from "../../src/plugins/roblox/studio-locate.ts";
import { CoreFact } from "../../src/shared/project-facts.ts";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { makeResources } from "../helpers/resources.ts";
import { type HostCall, hostFor, type Mac, makeGame, robloxMac } from "../helpers/roblox-mac.ts";
import { tmpDir } from "../helpers/tmp.ts";

const CONTENTS = `${STUDIO_MAC_APP}/Contents`;
const PLACE_ID = "4483381587";
const UNIVERSE_ID = "1611231458";

const action = async <T>(mac: Mac, name: string, args: Record<string, PluginScalar>, context: PluginContext) =>
  (await createRobloxBackend(mac.deps).action?.(name, args, context)) as T;

const tool = async <T>(mac: Mac, name: string, args: Record<string, PluginScalar>, context: PluginContext) =>
  (await createRobloxBackend(mac.deps).tool?.(name, args, context)) as T;

const linkCalls = (calls: HostCall[]) => calls.filter((call) => call.method === "game.engine.link");

describe("a place file named for Use in this game", () => {
  const refusal = (code: PlaceRefusal) => (error: unknown) => error instanceof PlaceError && error.code === code;

  it("is the real path of a plain .rbxl or .rbxlx file", async () => {
    const dir = await tmpDir("roblox-place-file-");
    for (const name of ["a.rbxl", "b.rbxlx"]) {
      await writeFile(path.join(dir, name), "");
      const real = await systemLocateFs.realpath(path.join(dir, name));
      assert.equal(await placeFile(systemLocateFs, process.platform, path.join(dir, name)), real);
    }
  });

  /** Paths that aren't one plain place file, each refused before anything is linked. */
  const HOSTILE: Array<[string, (dir: string) => Promise<string>, PlaceRefusal, NodeJS.Platform?]> = [
    ["a relative path", async () => "place.rbxlx", PlaceRefusal.BadFile],
    ["a step up", async (dir) => `${dir}/x/../place.rbxlx`, PlaceRefusal.BadFile],
    ["a NUL", async (dir) => `${dir}/pla\u0000ce.rbxlx`, PlaceRefusal.BadFile],
    ["a Windows path on a Mac", async () => "C:\\Users\\maker\\place.rbxlx", PlaceRefusal.BadFile, "darwin"],
    [
      "another extension",
      async (dir) => {
        await writeFile(path.join(dir, "place.rbxm"), "");
        return path.join(dir, "place.rbxm");
      },
      PlaceRefusal.BadFile,
    ],
    ["a missing file", async (dir) => path.join(dir, "gone.rbxlx"), PlaceRefusal.NotPlace],
    [
      "a folder",
      async (dir) => {
        await mkdir(path.join(dir, "folder.rbxlx"));
        return path.join(dir, "folder.rbxlx");
      },
      PlaceRefusal.NotPlace,
    ],
    [
      "a link to a place",
      async (dir) => {
        await writeFile(path.join(dir, "real.rbxlx"), "");
        await symlink(path.join(dir, "real.rbxlx"), path.join(dir, "link.rbxlx"));
        return path.join(dir, "link.rbxlx");
      },
      PlaceRefusal.Linked,
    ],
  ];
  for (const [name, make, code, platform] of HOSTILE)
    it(`refuses ${name}, linking nothing`, {
      skip: name.includes("link") && process.platform === "win32",
    }, async () => {
      const mac = await robloxMac();
      const game = await makeGame(mac, "sky-race", "Sky Race");
      const file = await make(await tmpDir("roblox-place-hostile-"));
      await assert.rejects(placeFile(systemLocateFs, platform ?? process.platform, file), refusal(code));
      const { context, calls } = hostFor(mac, game);
      const answer = await action<UsePlaceAnswer>(mac, "use-place", { file }, context);
      assert.equal(answer.linked, false);
      assert.equal(answer.reason, platform && platform !== process.platform ? PlaceRefusal.BadFile : code);
      assert.deepEqual(linkCalls(calls), [], "nothing linked");
      assert.equal(existsSync(path.join(game.directory, "default.project.json")), false, "nothing written");
    });
});

describe("a place file named on Windows", () => {
  /** Paths a Windows Genex must refuse before it touches the disk: none reaches the file system. */
  const WIN32_HOSTILE: Array<[string, string]> = [
    ["a Mac path", "/Users/maker/place.rbxlx"],
    ["a network share", "\\\\server\\share\\place.rbxl"],
    ["a step up on a drive", "C:\\x\\..\\place.rbxlx"],
    ["a drive-relative path", "C:place.rbxlx"],
    ["a NUL", "C:\\x\\pla\u0000ce.rbxlx"],
  ];
  for (const [name, file] of WIN32_HOSTILE)
    it(`refuses ${name}, asking the disk nothing`, async () => {
      const asked: string[] = [];
      const fs = {
        ...systemLocateFs,
        lstat: async (target: string) => {
          asked.push(target);
          return undefined;
        },
        realpath: async (target: string) => {
          asked.push(target);
          return target;
        },
      };
      await assert.rejects(
        placeFile(fs, "win32", file),
        (error: unknown) => error instanceof PlaceError && error.code === PlaceRefusal.BadFile,
      );
      assert.deepEqual(asked, [], "nothing was looked up");
    });
});

describe("a Studio is the one a linked place file is open in", () => {
  /** A Studio's listed name against a linked file: only the whole file name or its stem matches. */
  const ROWS: Array<[string, string, boolean]> = [
    ["/g/sky-race/sky-race.rbxlx", "sky-race.rbxlx", true],
    ["/g/sky-race/sky-race.rbxlx", "sky-race", true],
    ["/g/sky-race/sky-race.rbxlx", "Sky-Race.RBXLX", true],
    ["/g/race/race.rbxlx", "sky-race.rbxlx", false],
    ["/g/race/race.rbxlx", "sky-race", false],
    ["/g/a/a.rbxlx", "aa.rbxlx", false],
    ["/g/a/a.rbxlx", "a.rbxlx.rbxlx", false],
    ["C:\\games\\race\\race.rbxl", "race.rbxl", true],
    ["C:\\games\\race\\race.rbxl", "my race.rbxl", false],
  ];
  for (const [project, name, matches] of ROWS)
    it(`${matches ? "matches" : "doesn't match"} ${JSON.stringify(name)} for ${project}`, () => {
      assert.equal(placeMatcher({ project })({ id: "studio", name }), matches);
    });
});

describe("Use in this game", () => {
  it("links a local place file where it is, by its real path", async () => {
    const mac = await robloxMac();
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const file = path.join(mac.home, "Documents", "Roblox", "Sky Race.rbxl");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "");
    const { context, calls } = hostFor(mac, game);
    const answer = await action<UsePlaceAnswer>(mac, "use-place", { file }, context);
    assert.equal(answer.linked, true, answer.message);
    assert.deepEqual(
      linkCalls(calls).map((call) => call.args),
      [{ project: await systemLocateFs.realpath(file) }],
    );
    assert.equal(existsSync(path.join(game.directory, "default.project.json")), false);
  });

  it("links a published place through default.project.json, recorded as Genex's, with its ids as strings", async () => {
    const mac = await robloxMac({
      studios: [{ id: "studio-a", name: `Obby ${PLACE_ID}`, placeId: PLACE_ID, universeId: UNIVERSE_ID }],
    });
    const game = await makeGame(mac, "obby", "Obby");
    const { context, calls, methods } = hostFor(mac, game);
    const answer = await action<UsePlaceAnswer>(mac, "use-place", { studio: "studio-a" }, context);
    assert.equal(answer.linked, true, answer.message);
    const project = path.join(game.directory, "default.project.json");
    assert.deepEqual(
      linkCalls(calls).map((call) => call.args),
      [{ project, remote: { placeId: PLACE_ID, universeId: UNIVERSE_ID }, name: `Obby ${PLACE_ID}` }],
    );
    const rojo = JSON.parse(await readFile(project, "utf8"));
    assert.equal(rojo.tree.$className, "DataModel");
    const record = JSON.parse(await readFile(path.join(game.directory, ".genex", "roblox.json"), "utf8"));
    assert.ok(record.written.includes("default.project.json"), "Genex's own, so the script sync stays on");
    assert.ok(methods().indexOf("game.snapshot") < methods().indexOf("game.engine.link"), "a snapshot first");
    assert.deepEqual(await readPlaceLink(mac.storage, game.project), { project, placeId: PLACE_ID });
  });

  it("links a place never saved by its name in Studio, which then finds that Studio and no other", async () => {
    const mac = await robloxMac({ studios: [{ id: "studio-a", name: "Place1" }] });
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const { context, calls } = hostFor(mac, game);
    const answer = await action<UsePlaceAnswer>(mac, "use-place", { studio: "studio-a" }, context);
    assert.equal(answer.linked, true, answer.message);
    const project = path.join(game.directory, "default.project.json");
    assert.deepEqual(
      linkCalls(calls).map((call) => call.args),
      [{ project, name: "Place1" }],
      "the chat names the place, not its project file",
    );
    const link = await readPlaceLink(mac.storage, game.project);
    assert.deepEqual(link, { project, name: "Place1" });
    const matches = placeMatcher(link as NonNullable<typeof link>);
    assert.equal(matches({ id: "x", name: "Place1" }), true);
    assert.equal(matches({ id: "y", name: "Place2" }), false);
    assert.equal(matches({ id: "z", name: "default.project.json" }), false);
  });

  it("links a saved place open in Studio to its file, found in Studio's recent list", async () => {
    const mac = await robloxMac();
    const file = path.join(mac.home, "Places", "p18-cli.rbxlx");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "");
    mac.state.recents = [file];
    mac.state.studios = [{ id: "studio-a", name: "p18-cli.rbxlx" }];
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const { context, calls } = hostFor(mac, game);
    const answer = await action<UsePlaceAnswer>(mac, "use-place", { studio: "studio-a" }, context);
    assert.equal(answer.linked, true, answer.message);
    assert.deepEqual(
      linkCalls(calls).map((call) => call.args),
      [{ project: await systemLocateFs.realpath(file) }],
    );
  });

  it("tells two Studios with one name apart in the list, and won't link either by that name", async () => {
    const mac = await robloxMac({
      studios: [
        { id: "studio-a", name: "Place1" },
        { id: "studio-b", name: "Place1" },
      ],
    });
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const { context, calls } = hostFor(mac, game);
    const places = await action<PlacesAnswer>(mac, "places", {}, context);
    assert.deepEqual(
      places.open.map((row) => [row.studio, row.label]),
      [
        ["studio-a", "Place1"],
        ["studio-b", "Place1 (2)"],
      ],
    );
    const answer = await action<UsePlaceAnswer>(mac, "use-place", { studio: "studio-b" }, context);
    assert.equal(answer.linked, false);
    assert.equal(answer.reason, PlaceRefusal.SameName);
    assert.match(answer.message, /Place1/);
    assert.deepEqual(linkCalls(calls), []);
    assert.equal(existsSync(path.join(game.directory, "default.project.json")), false);
  });

  it("refuses a place another live game builds in, and frees it once that game is gone", async () => {
    const mac = await robloxMac();
    const file = path.join(mac.home, "Places", "shared.rbxlx");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "");
    mac.state.recents = [file];
    const first = await makeGame(mac, "sky-race", "Sky Race");
    const second = await makeGame(mac, "rally", "Rally");
    const one = hostFor(mac, first);
    assert.equal((await action<UsePlaceAnswer>(mac, "use-place", { file }, one.context)).linked, true);
    const two = hostFor(mac, second);
    const refused = await action<UsePlaceAnswer>(mac, "use-place", { file }, two.context);
    assert.equal(refused.linked, false);
    assert.equal(refused.reason, PlaceRefusal.Taken);
    assert.equal(refused.message, "shared already builds in Sky Race.");
    assert.deepEqual(linkCalls(two.calls), []);
    const listed = await action<PlacesAnswer>(mac, "places", {}, two.context);
    assert.equal(listed.files.find((row) => row.name === "shared.rbxlx")?.linkedTo, "Sky Race");
    // Linking it again in the game that has it is no conflict.
    assert.equal((await action<UsePlaceAnswer>(mac, "use-place", { file }, hostFor(mac, first).context)).linked, true);
    await rm(first.directory, { recursive: true, force: true });
    const freed = await action<UsePlaceAnswer>(mac, "use-place", { file }, hostFor(mac, second).context);
    assert.equal(freed.linked, true, freed.message);
  });

  it("a link the host refuses leaves the game's place as it was, still its own", async () => {
    const mac = await robloxMac({ studios: [{ id: "studio-b", name: "Place1" }] });
    const file = path.join(mac.home, "Places", "shared.rbxlx");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "");
    const first = await makeGame(mac, "sky-race", "Sky Race");
    const second = await makeGame(mac, "rally", "Rally");
    const one = hostFor(mac, first);
    assert.equal((await action<UsePlaceAnswer>(mac, "use-place", { file }, one.context)).linked, true);
    const refusing: PluginContext = {
      ...one.context,
      host: (async (method: string, args?: Record<string, unknown>) => {
        if (method === "game.engine.link") throw new Error("The game is busy");
        return one.context.host(method as never, args as never);
      }) as unknown as PluginContext["host"],
    };
    const answer = await action<UsePlaceAnswer>(mac, "use-place", { studio: "studio-b" }, refusing);
    assert.equal(answer.reason, PlaceRefusal.Refused);
    const taken = await action<UsePlaceAnswer>(mac, "use-place", { file }, hostFor(mac, second).context);
    assert.equal(taken.reason, PlaceRefusal.Taken, "the first game still builds in its place");
  });

  it("refuses a published place another live game builds in, by its id", async () => {
    const studios = [{ id: "studio-a", name: `Obby ${PLACE_ID}`, placeId: PLACE_ID, universeId: UNIVERSE_ID }];
    const mac = await robloxMac({ studios });
    const first = await makeGame(mac, "obby", "Obby");
    const second = await makeGame(mac, "obby-two", "Obby Two");
    assert.equal(
      (await action<UsePlaceAnswer>(mac, "use-place", { studio: "studio-a" }, hostFor(mac, first).context)).linked,
      true,
    );
    const two = hostFor(mac, second);
    const refused = await action<UsePlaceAnswer>(mac, "use-place", { studio: "studio-a" }, two.context);
    assert.equal(refused.reason, PlaceRefusal.Taken);
    assert.equal(existsSync(path.join(second.directory, "default.project.json")), false, "nothing written");
  });

  it("refuses a Studio that is no longer open", async () => {
    const mac = await robloxMac();
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const answer = await action<UsePlaceAnswer>(mac, "use-place", { studio: "gone" }, hostFor(mac, game).context);
    assert.equal(answer.reason, PlaceRefusal.NotListed);
  });

  it("needs an open game", async () => {
    const mac = await robloxMac({ studios: [{ id: "studio-a", name: "Place1" }] });
    const answer = await action<UsePlaceAnswer>(
      mac,
      "use-place",
      { studio: "studio-a" },
      hostFor(mac, undefined).context,
    );
    assert.equal(answer.reason, PlaceRefusal.NoGame);
  });
});

describe("Choose your place", () => {
  it("lists open Studios first, then place files from Studio's recent list and Documents, one row each", async () => {
    const mac = await robloxMac({ studios: [{ id: "studio-a", name: "Place1" }] });
    const documents = path.join(mac.home, "Documents", "Roblox");
    const elsewhere = path.join(mac.home, "Places");
    await mkdir(documents, { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(documents, "server.rbxl"), "");
    await writeFile(path.join(documents, "notes.txt"), "");
    await writeFile(path.join(elsewhere, "race.rbxlx"), "");
    mac.state.recents = [path.join(elsewhere, "race.rbxlx"), path.join(documents, "server.rbxl"), "/nowhere/x.rbxl"];
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const places = await action<PlacesAnswer>(mac, "places", {}, hostFor(mac, game).context);
    assert.deepEqual(
      places.open.map((row) => [row.label, row.kind]),
      [["Place1", "unsaved"]],
    );
    assert.deepEqual(places.files.map((row) => row.name).sort(), ["race.rbxlx", "server.rbxl"]);
    assert.ok(
      mac.touched.some((file) => file.startsWith(documents)),
      "the press reads Documents › Roblox",
    );
    assert.ok(mac.ran.includes("/usr/bin/defaults"), "and Studio's recent list");
  });

  it("asks each open Studio for its place under the busy mark of the game bound to it, so the ask never reads as the person", async () => {
    const mac = await robloxMac({
      studios: [
        { id: "studio-a", name: "Place1" },
        { id: "studio-b", name: "Obby" },
      ],
    });
    const bound = path.join(mac.storage, "mcp", "other-game");
    await mkdir(bound, { recursive: true });
    await writeFile(
      path.join(bound, "studio.json"),
      JSON.stringify({ studioId: "studio-a", session: "s-1", at: mac.deps.now() }),
    );
    const studio = mac.deps.studio;
    assert.ok(studio);
    const marked: Array<[unknown, boolean]> = [];
    mac.deps.studio = {
      studios: studio.studios,
      callTool: async (name, args, options) => {
        const marks = await readAgentMarks(bound, mac.deps.now());
        marked.push([args.studio_id, marks.busy !== undefined && marks.busy.until === undefined]);
        return studio.callTool(name, args, options);
      },
    };
    const game = await makeGame(mac, "sky-race", "Sky Race");
    await action<PlacesAnswer>(mac, "places", {}, hostFor(mac, game).context);
    assert.deepEqual(marked.sort(), [
      ["studio-a", true],
      ["studio-b", false],
    ]);
    const after = await readAgentMarks(bound, mac.deps.now());
    assert.equal(agentsAt(after, mac.deps.now(), mac.deps.now()), true, "what Studio reports of it is Genex's");
  });

  it("lists at most 12 place files, and keeps a scan for a while", async () => {
    const mac = await robloxMac();
    const documents = path.join(mac.home, "Documents", "Roblox");
    await mkdir(documents, { recursive: true });
    for (let n = 0; n < 20; n++) await writeFile(path.join(documents, `place-${n}.rbxl`), "");
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const backend = createRobloxBackend(mac.deps);
    const list = async () => (await backend.action?.("places", {}, hostFor(mac, game).context)) as PlacesAnswer;
    assert.equal((await list()).files.length, MAX_PLACES);
    const reads = mac.touched.filter((file) => file === documents).length;
    await list();
    assert.equal(mac.touched.filter((file) => file === documents).length, reads, "kept: no second scan");
    mac.advance(SCAN_KEEP_MS);
    await list();
    assert.equal(mac.touched.filter((file) => file === documents).length, reads + 1, "scanned again once it lapsed");
  });

  it("named by an agent, a file there is not read, and the answer links it by its label in Studio, not the panel", async () => {
    const mac = await robloxMac();
    const file = path.join(mac.home, "Documents", "Roblox", "Sky Race.rbxl");
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const backend = createRobloxBackend(mac.deps);
    const answer = String(await backend.tool?.("use-project", { project: file }, hostFor(mac, game).context));
    assert.match(answer, /roblox__places/);
    assert.doesNotMatch(answer, /panel|Use in this game/);
    assert.deepEqual(
      mac.touched.filter((touched) => touched.includes(`${path.sep}Documents`)),
      [],
      "macOS would ask the person for Documents",
    );
  });

  it("is never read by the status, the toolbar or the steps card", async () => {
    const mac = await robloxMac({ studios: [{ id: "studio-a", name: "Place1" }] });
    const game = await makeGame(mac, "sky-race", "Sky Race");
    for (const name of ["status", "toolbar-status", "steps"]) await action(mac, name, {}, hostFor(mac, game).context);
    assert.deepEqual(
      mac.touched.filter((file) => file.includes(`${path.sep}Documents`)),
      [],
      "macOS would ask the person for Documents",
    );
    assert.equal(mac.ran.includes("/usr/bin/defaults"), false, "nor Studio's recent list");
  });
});

describe("New Roblox game", () => {
  it("writes the place into the open game, links it and opens it in Studio with EditFile", async () => {
    const mac = await robloxMac({ running: false });
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const { context, calls, methods } = hostFor(mac, game);
    const answer = await action<{ created: boolean; file: string }>(mac, "create", {}, context);
    assert.equal(answer.created, true);
    const file = path.join(game.directory, "sky-race.rbxlx");
    assert.equal(answer.file, file);
    assert.ok(existsSync(file));
    assert.ok(methods().indexOf("game.snapshot") < methods().indexOf("game.engine.link"), "a snapshot first");
    assert.deepEqual(
      linkCalls(calls).map((call) => call.args),
      [{ project: file }],
    );
    assert.deepEqual(mac.launches, [
      { file: `${CONTENTS}/MacOS/RobloxStudio`, args: ["--task", "EditFile", "--localPlaceFile", file] },
    ]);
    const ignore = await readFile(path.join(game.directory, ".gitignore"), "utf8");
    assert.match(ignore, /^\*\.rbxl\.lock$/m);
    assert.match(ignore, /^\*\.rbxlx\.lock$/m);
    assert.equal(
      await readFile(path.join(game.directory, "selene.toml"), "utf8"),
      CHECK_CONFIGS["selene.toml"],
      "a new game starts with the Luau checks' settings",
    );
    assert.equal(await readFile(path.join(game.directory, "stylua.toml"), "utf8"), CHECK_CONFIGS["stylua.toml"]);
  });

  it("once Studio lists the new place, the list marks it this game's and another game can't take it", async () => {
    const mac = await robloxMac({ running: false });
    const game = await makeGame(mac, "sky-race", "Sky Race");
    await action(mac, "create", {}, hostFor(mac, game).context);
    // Studio lists a saved local place by its file name; the new file is in no recent list yet.
    mac.state.studios = [{ id: "studio-new", name: "sky-race.rbxlx" }];
    const own = await action<PlacesAnswer>(mac, "places", {}, hostFor(mac, game).context);
    assert.equal(own.open[0]?.here, true);
    const other = await makeGame(mac, "rally", "Rally");
    const theirs = await action<PlacesAnswer>(mac, "places", {}, hostFor(mac, other).context);
    assert.equal(theirs.open[0]?.linkedTo, "Sky Race");
    const taken = await action<UsePlaceAnswer>(mac, "use-place", { studio: "studio-new" }, hostFor(mac, other).context);
    assert.equal(taken.reason, PlaceRefusal.Taken);
  });

  it("with no game open makes a Genex game for it and links the place there", async () => {
    const mac = await robloxMac({ running: false });
    const { context, calls, made } = hostFor(mac, undefined);
    const answer = await action<{ created: boolean; game?: { project: string } }>(mac, "create", {}, context);
    assert.equal(answer.created, true);
    assert.equal(made.length, 1);
    assert.deepEqual(answer.game, { project: made[0]?.project });
    const link = linkCalls(calls)[0]?.args;
    assert.equal(link?.game, made[0]?.project);
    assert.equal(path.dirname(String(link?.project)), made[0]?.directory);
  });

  it("is the agent's new-game in an open game, and refused outside one", async () => {
    const mac = await robloxMac({ running: false });
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const words = await tool<string>(mac, "new-game", {}, hostFor(mac, game).context);
    assert.match(words, /sky-race\.rbxlx/);
    assert.equal(mac.launches.length, 1);
    await assert.rejects(tool(mac, "new-game", {}, hostFor(mac, undefined).context), /game/i);
  });

  it("says whether a new Roblox game can be made here", async () => {
    const mac = await robloxMac();
    const answer = await tool<{ ready: boolean; note: string }>(
      mac,
      "engine-status",
      {},
      hostFor(mac, undefined).context,
    );
    assert.equal(answer.ready, true);
    assert.match(answer.note, /Roblox Studio 0\.743/);
  });
});

describe("Open in Studio and Quit Studio", () => {
  it("opens the game's published place with EditPlace, and brings Studio forward when it is already open", async () => {
    const mac = await robloxMac({
      studios: [{ id: "studio-a", name: `Obby ${PLACE_ID}`, placeId: PLACE_ID, universeId: UNIVERSE_ID }],
    });
    const game = await makeGame(mac, "obby", "Obby");
    await action(mac, "use-place", { studio: "studio-a" }, hostFor(mac, game).context);
    await action(mac, "open-studio", {}, hostFor(mac, game).context);
    assert.deepEqual(mac.launches, [{ file: "/usr/bin/open", args: ["-a", STUDIO_MAC_APP] }], "already open: forward");
    mac.state.studios = [];
    await action(mac, "open-studio", {}, hostFor(mac, game).context);
    assert.deepEqual(mac.launches[1], {
      file: `${CONTENTS}/MacOS/RobloxStudio`,
      args: ["--task", "EditPlace", "--placeId", PLACE_ID, "--universeId", UNIVERSE_ID],
    });
  });

  it("Restart Studio opens the game's own place again, not Studio alone, so Studio can answer Genex", async () => {
    const mac = await robloxMac({
      studios: [{ id: "studio-a", name: `Obby ${PLACE_ID}`, placeId: PLACE_ID, universeId: UNIVERSE_ID }],
    });
    const game = await makeGame(mac, "obby", "Obby");
    await action(mac, "use-place", { studio: "studio-a" }, hostFor(mac, game).context);
    const run = mac.deps.run;
    mac.deps.run = (async (file: string, args: readonly string[]) => {
      // Studio's normal quit closes it: its window and its MCP listing are gone.
      if (file === "/usr/bin/osascript") {
        mac.state.running = false;
        mac.state.studios = [];
      }
      return run(file, args);
    }) as RobloxDeps["run"];
    await action(mac, "restart-studio", {}, hostFor(mac, game).context);
    assert.deepEqual(mac.launches.at(-1), {
      file: `${CONTENTS}/MacOS/RobloxStudio`,
      args: ["--task", "EditPlace", "--placeId", PLACE_ID, "--universeId", UNIVERSE_ID],
    });
  });

  it("quits Studio normally, and not while a Loop uses it", async () => {
    const mac = await robloxMac();
    const busy = hostFor(mac, undefined, { runs: [{ game: "sky-race", title: "Sky Race", project: "/x.rbxlx" }] });
    const refused = await action<{ quit: boolean; message: string }>(mac, "quit-studio", {}, busy.context);
    assert.equal(refused.quit, false);
    assert.match(refused.message, /Sky Race/);
    assert.equal(mac.ran.includes("/usr/bin/osascript"), false, "nothing asked of Studio");
    mac.deps.run = (async (file: string, args: readonly string[]) => {
      if (file === "/usr/bin/osascript") mac.state.running = false;
      if (file === "/usr/bin/pgrep") return mac.state.running ? { code: 0, stdout: "1\n" } : { code: 1, stdout: "" };
      return { code: 0, stdout: "" };
    }) as RobloxDeps["run"];
    const done = await action<{ quit: boolean }>(mac, "quit-studio", {}, hostFor(mac, undefined).context);
    assert.equal(done.quit, true);
  });
});

describe("the engine choice", () => {
  it('offers "Roblox game" from the plugin\'s scaffold while the plugin is on', async () => {
    const resources = await makeResources({ tsc: false });
    const root = await tmpDir("roblox-scaffold-");
    const plugins = path.join(resources, "plugins");
    const registry = new PluginRegistry(
      path.join(root, "installed"),
      plugins,
      path.join(resources, "plugin-sdk", "backend.mjs"),
      async () => null,
    );
    await registry.init();
    try {
      const web = [{ id: CoreFact.WebGame, path: "." }];
      const offered = () => registry.snapshot(web).kinds?.filter((kind) => kind.plugin === "roblox") ?? [];
      // Genex seeds the plugin off; a bare registry turns bundled plugins on, so it is turned off here.
      await registry.setEnabled("roblox", false);
      assert.deepEqual(offered(), [], "off: not offered");
      await registry.setEnabled("roblox", true);
      const kinds = offered();
      assert.deepEqual(
        kinds.map((kind) => [kind.tool, kind.label, kind.asksReady]),
        [["roblox__new-game", "Roblox game", true]],
      );
      assert.match(engineChoiceRule("claude-code", null, kinds), /"Roblox game"/);
    } finally {
      registry.cancel();
    }
  });
});
