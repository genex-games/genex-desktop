/**
 * A tool that makes a kind of project is refused while a run of the game is going, except one that
 * only links the game to a project it already holds: a tool that declares `links` (the parameter
 * naming the project file) runs during the run when that file, by its real path, is a project file
 * of its plugin's engine inside the game's own folder, where the game already holds the engine's
 * kind. Nothing about the game changes under the run, so no snapshot is taken. Every other path is
 * refused as before, with nothing run and nothing taken (castle-artillery: the lead made its Unreal
 * project by hand mid-run, `use-project` was refused, and no Resume could start the Loop again).
 */
import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { EventKind } from "../../src/shared/event-log.ts";
import { PluginSourceKind } from "../../src/shared/plugins.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { personAllowsLocalTools } from "../helpers/plugins.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PLUGIN = "linker";
const KIND = "link-project";
const EXTENSION = ".linkproj";
/** The tool that links a project (`links: "project"`), and one that makes a project and links nothing. */
const USE = `${PLUGIN}__use-project`;
const NEW = `${PLUGIN}__new-game`;
const USED = "Linked the game to its project.";

/**
 * A local engine plugin whose project files are `.linkproj` files kept in the game's folder: its
 * `detect` finds them (never under `vendor/`), and its backend notes each call in `calls`.
 */
async function linkerPackage(calls: string): Promise<string> {
  const dir = await tmpDir("studio-linker-plugin-");
  const project = { type: "string", description: "The project file." };
  const manifest = {
    apiVersion: 3,
    id: PLUGIN,
    version: "1.0.0",
    name: "Linker",
    publisher: "Genex tests",
    description: "Links games to link projects.",
    backend: "backend.mjs",
    capabilities: ["game-engine"],
    detect: [{ fact: KIND, files: [`**/*${EXTENSION}`], notUnder: ["**/vendor/"] }],
    engine: { id: PLUGIN, label: "Linker", projectFiles: [EXTENSION], fact: KIND, projectInFolder: true },
    tools: [
      {
        name: "use-project",
        description: "Link this game to a link project.",
        parameters: { type: "object", properties: { project } },
        makes: [KIND],
        links: "project",
      },
      {
        name: "new-game",
        description: "Make this game's link project.",
        parameters: { type: "object", properties: { project } },
        makes: [KIND],
      },
    ],
    skills: [],
    panels: [],
    settings: [],
    actions: [],
  };
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
  await writeFile(
    path.join(dir, "backend.mjs"),
    `import { appendFile } from "node:fs/promises";
export async function activate() {
  return {
    async tool(name) {
      await appendFile(${JSON.stringify(calls)}, name + "\\n");
      return ${JSON.stringify(USED)};
    },
  };
}\n`,
  );
  return dir;
}

/** The backend's noted calls, by tool name. */
const callsIn = (file: string) =>
  readFile(file, "utf8").then(
    (text) => text.split("\n").filter(Boolean),
    () => [] as string[],
  );

/** How many game snapshots the log holds. */
async function gameSnapshots(lite: CoreLite): Promise<number> {
  const events = await lite.core.listAllEvents();
  return events.filter((event) => event.data.type === EventKind.SnapshotCreated && event.data.git.game).length;
}

/** The places a hostile path is built from: the game's folder and a folder outside every game. */
interface Places {
  dir: string;
  outside: string;
}

/**
 * A web game holding its own link project in `world/` and an unlisted one in `vendor/`, a link
 * project outside every game, and links from inside the game to it.
 */
async function gameWithProject(lite: CoreLite, project: string): Promise<Places> {
  await lite.core.games.scaffold(project);
  const dir = lite.core.games.dirFor(project);
  const outside = await tmpDir("studio-linker-outside-");
  await writeFile(path.join(outside, `Other${EXTENSION}`), "{}\n");
  await mkdir(path.join(dir, "world"), { recursive: true });
  await writeFile(path.join(dir, "world", `World${EXTENSION}`), "{}\n");
  await mkdir(path.join(dir, "vendor"), { recursive: true });
  await writeFile(path.join(dir, "vendor", `Vendored${EXTENSION}`), "{}\n");
  await symlink(path.join(outside, `Other${EXTENSION}`), path.join(dir, "world", `Linked${EXTENSION}`));
  await symlink(outside, path.join(dir, "elsewhere"));
  return { dir, outside };
}

/** A core with the linker plugin installed and turned on, where its calls are noted, and the game's run going when `running`. */
async function linkerCore(running: boolean) {
  const lite = await coreLite();
  const calls = path.join(await tmpDir("studio-linker-calls-"), "calls.log");
  await lite.core.plugins.installLocal(await linkerPackage(calls), PluginSourceKind.Local, []);
  await lite.core.plugins.setEnabled(PLUGIN, true);
  // The person allows its tools: these cases are about the run's guard, not the card.
  personAllowsLocalTools(lite.core.plugins);
  const project = "castle";
  const places = await gameWithProject(lite, project);
  if (running) lite.core.pluginServices.runningGames = async () => [{ project, directory: places.dir, title: project }];
  const api = lite.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
  const call = api["plugins.invoke"];
  if (!call) throw new Error("the core's api has no plugins.invoke");
  const threadId = await lite.core.createGameThread(project);
  const invoke = (name: string, args: Record<string, unknown>) => call({ project, threadId, name, args });
  const close = async () => {
    lite.core.plugins.cancel();
    await lite.close();
  };
  return { lite, calls, places, invoke, close };
}

/** The refusal a kind-changing call answers while the game's run is going. */
const refusedForRun = (answer: unknown): boolean => (answer as { refused?: unknown } | null)?.refused === "run_going";

/** The `project` arguments that must never pass for the game's own: each refused, nothing run, nothing taken. */
const HOSTILE: ReadonlyArray<readonly [string, (places: Places) => unknown]> = [
  ["a project file outside the game", ({ outside }) => path.join(outside, `Other${EXTENSION}`)],
  [
    "a `..` path that leaves the game",
    ({ dir, outside }) => `${dir}/world/../${path.relative(dir, path.join(outside, `Other${EXTENSION}`))}`,
  ],
  ["a link in the game to a project outside it", ({ dir }) => path.join(dir, "world", `Linked${EXTENSION}`)],
  ["a path through a linked folder", ({ dir }) => path.join(dir, "elsewhere", `Other${EXTENSION}`)],
  ["a path relative to the game", () => path.join("world", `World${EXTENSION}`)],
  ["a project's name, not a path", () => "World"],
  ["a file of another kind in the game", ({ dir }) => path.join(dir, "index.html")],
  ["a project file the game does not have", ({ dir }) => path.join(dir, "world", `Gone${EXTENSION}`)],
  ["a project file where the game holds no project", ({ dir }) => path.join(dir, "vendor", `Vendored${EXTENSION}`)],
  ["a number", () => 42],
  ["no project at all", () => undefined],
];

describe("a tool that links the game to a project it already holds", () => {
  it("runs while the game's run is going, naming the game's own project file, and takes no snapshot", async () => {
    const { lite, calls, places, invoke, close } = await linkerCore(true);
    try {
      const answer = await invoke(USE, { project: path.join(places.dir, "world", `World${EXTENSION}`) });
      assert.equal(refusedForRun(answer), false, `not refused: ${JSON.stringify(answer)}`);
      assert.match(JSON.stringify(answer), /Linked the game/);
      assert.deepEqual(await callsIn(calls), ["use-project"], "the backend ran once");
      assert.equal(await gameSnapshots(lite), 0, "nothing changes under the run, so no snapshot");
    } finally {
      await close();
    }
  });

  it("is refused for every other project while the run is going, with nothing run and nothing taken", async () => {
    const { lite, calls, places, invoke, close } = await linkerCore(true);
    try {
      for (const [label, argument] of HOSTILE) {
        const value = argument(places);
        const answer = await invoke(USE, value === undefined ? {} : { project: value });
        assert.ok(refusedForRun(answer), `${label}: refused, got ${JSON.stringify(answer)}`);
      }
      assert.deepEqual(await callsIn(calls), [], "the backend never ran");
      assert.equal(await gameSnapshots(lite), 0, "no snapshot");
    } finally {
      await close();
    }
  });

  it("a tool that makes a project without declaring `links` is still refused during the run", async () => {
    const { calls, places, invoke, close } = await linkerCore(true);
    try {
      const answer = await invoke(NEW, { project: path.join(places.dir, "world", `World${EXTENSION}`) });
      assert.ok(refusedForRun(answer), JSON.stringify(answer));
      assert.deepEqual(await callsIn(calls), []);
    } finally {
      await close();
    }
  });

  it("outside a run it is a kind change as before: the game is snapshotted first", async () => {
    const { lite, calls, places, invoke, close } = await linkerCore(false);
    try {
      await invoke(USE, { project: path.join(places.dir, "world", `World${EXTENSION}`) });
      assert.deepEqual(await callsIn(calls), ["use-project"]);
      assert.equal(await gameSnapshots(lite), 1, "one game snapshot before the call");
    } finally {
      await close();
    }
  });
});
