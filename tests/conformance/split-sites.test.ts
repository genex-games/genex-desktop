/**
 * The main process's stack split (M1.3): every place that asked "is this a C++ · raylib game?" now
 * asks the question it meant. A compiled game (raylib, and Rust · wgpu) is built only through the
 * build-lane seam (`core.gameBuilds`), never by the browser build and never exported as a raw
 * folder; a Rust game reaches the Rust lane, which builds no browser yet (`target-unbuilt`) and
 * runs nothing. A harness lease declares the stacks its harness serves: one that declares none predates
 * Rust and is refused for a Rust game, as an untargeted lease is for a raylib game. The sites
 * still waiting for Rust-specific content are listed as data for M3.4
 * (`tests/fixtures/stack-split-sites.json`). Driven through the core's substrate table and its
 * public methods, as the harness and the studio window call them.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { BuildProblemCode, CppBuildPurpose } from "../../src/shared/build-problem.ts";
import { ExportRefusal } from "../../src/shared/game-export-contract.ts";
import {
  BuildTarget,
  type GameProject,
  GameStack,
  ProjectKind,
  destinationsOf,
} from "../../src/shared/game-project.ts";
import { TargetRefusal } from "../../src/shared/game-targets.ts";
import { NativeRefusal } from "../../src/shared/native-contract.ts";
import { SnapshotScope } from "../../src/shared/event-log.ts";
import { LOCK_FILE_OF_STACK } from "../../src/shared/toolchain.ts";
import { FIXTURE_RUST_GAME, seedRustGame } from "../../src/main/dev/fixture-toolchains.ts";
import { FixtureName, isFixtureName } from "../../src/main/dev/fixture-kit.ts";
import { validateGameDir } from "../../src/substrate/game-validation.ts";
import { readProjectShape, ScaffoldCaller } from "../../src/substrate/game-workspace.ts";
import type { PreviewPort } from "../../src/substrate/preview-port.ts";
import { type CoreApi, coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { GameEngine } from "../../src/shared/game-engine.ts";
import { factsOfEngine } from "../../src/shared/project-facts.ts";

/** One harness method by name, called with params the way the harness sends them. */
function harness(api: CoreApi) {
  const table = api as unknown as Record<string, (params: unknown) => Promise<unknown>>;
  return (method: string, params: unknown): Promise<unknown> => {
    const handler = table[method];
    assert.ok(handler, `${method} is a host method`);
    return handler(params);
  };
}

/** A preview port that counts its loads and keeps what it was told. */
function fakePort() {
  const record = { loads: 0, notes: [] as Array<{ level: string; message: string }> };
  const port: PreviewPort = {
    load: async () => {
      record.loads++;
      return "";
    },
    reload: async () => {},
    screenshot: async () => Buffer.alloc(0),
    evaluate: async () => null,
    studioState: async () => ({}),
    studioCall: async () => ({}),
    input: async () => ({ ok: true, applied: 0, width: 1, height: 1 }),
    consoleEntries: () => [],
    note: (level, message) => void record.notes.push({ level, message }),
    status: () => ({
      project: null,
      url: null,
      crashed: false,
      unresponsive: false,
      loadError: null,
      consoleErrors: null,
    }),
  };
  return { port, record };
}

/** The minimal Rust · wgpu game folder: genex.toml, a crate, and the studio.json a scaffold records. */
const RUST_FILES: Record<string, string> = {
  "genex.toml": '[game]\nname = "ferris"\n',
  "Cargo.toml": '[package]\nname = "ferris"\nversion = "0.1.0"\nedition = "2024"\n',
  "src/main.rs": "fn main() {}\n",
  "studio.json": `${JSON.stringify({
    stack: GameStack.RustWgpu,
    kind: ProjectKind.RustWgpu,
    main: "src/main.rs",
    targets: [BuildTarget.Web, BuildTarget.Mac],
  })}\n`,
};

/** Every file under `dir` with its bytes, sorted: what "nothing was written" compares. */
async function bytesIn(dir: string): Promise<Array<[string, string]>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const listed: Array<[string, string]> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const rel = path.relative(dir, path.join(entry.parentPath, entry.name));
    listed.push([rel, (await readFile(path.join(dir, rel))).toString("base64")]);
  }
  return listed.sort(([a], [b]) => (a < b ? -1 : 1));
}

/**
 * A core whose library holds one raylib game (`pong`, scaffolded) and one Rust game (`ferris`,
 * written by hand: a minimal folder whose own files make it Rust, independent of the template). The
 * library lists the Rust game with the shape its files make it.
 */
async function studio(t: TestContext) {
  const live = fakePort();
  const hidden: Array<ReturnType<typeof fakePort>> = [];
  const lite = await coreLite({
    gamesRoot: await realpath(await tmpDir("split-sites-")),
    preview: live.port,
    createHeadlessPreview: async () => {
      const made = fakePort();
      hidden.push(made);
      return made.port;
    },
  });
  const { core, gamesRoot } = lite;
  await core.games.scaffold("pong", {
    title: "Pong",
    stack: GameStack.RaylibCpp,
    caller: ScaffoldCaller.Internal,
    targets: [BuildTarget.Web],
  });
  const dir = path.join(gamesRoot, "ferris");
  for (const [rel, text] of Object.entries(RUST_FILES)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
  const shape = await readProjectShape(dir);
  assert.equal(shape.kind, ProjectKind.RustWgpu, "the folder is a Rust game by its own files");
  const ferris: GameProject = {
    name: "ferris",
    dir,
    title: "Ferris",
    createdAt: new Date(0).toISOString(),
    pathLabel: "~/AI Games/ferris",
    library: true,
    facts: factsOfEngine(GameEngine.Web),
    shape,
    built: false,
    destinations: { stack: GameStack.RustWgpu, targets: [BuildTarget.Web, BuildTarget.Mac] },
  };
  const list = core.games.list.bind(core.games);
  t.mock.method(core.games, "list", async () => [...(await list()).filter((game) => game.name !== "ferris"), ferris]);
  const cpp = t.mock.method(core.cppBuilds, "ensure", async () => ({
    ok: false,
    output: null,
    lastGood: null,
    problem: null,
    ran: false,
  }));
  const browser = t.mock.method(core.builds, "ensure");
  return { ...lite, call: harness(lite.api()), live, hidden, ferris, cpp, browser };
}

describe("a compiled game is built only through the build-lane seam", () => {
  it("Live's web build of a raylib game reaches the C++ lane with exactly the input it always had", async (t) => {
    const { core, cpp, browser } = await studio(t);
    const pong = (await core.games.list()).find((game) => game.name === "pong");
    assert.ok(pong);
    await core.loadPreview({ project: "pong" });
    assert.equal(cpp.mock.callCount(), 1);
    assert.deepEqual(cpp.mock.calls[0]?.arguments[0], {
      project: "pong",
      dir: core.games.dirFor("pong"),
      shape: pong.shape,
      target: BuildTarget.Web,
      destinations: destinationsOf(pong),
      purpose: CppBuildPurpose.Live,
      lock: null,
      recordLock: true,
    });
    assert.equal(browser.mock.callCount(), 0, "a C++ game never runs the browser build");
  });

  it("a Rust game's preview reaches the Rust lane, which builds no browser yet: no C++ build, no browser build, and the console says why", async (t) => {
    const { core, cpp, browser, live } = await studio(t);
    await core.loadPreview({ project: "ferris" });
    assert.equal(cpp.mock.callCount(), 0, "the raylib lane never sees a Rust game");
    assert.equal(browser.mock.callCount(), 0, "a Rust game is never built as a browser game");
    assert.ok(
      live.record.notes.some((note) => note.level === "error"),
      JSON.stringify(live.record.notes),
    );
  });

  // Flipped (M2a): was lane-missing; the core's Rust lane now answers, refusing the browser
  // (`target-unbuilt`) before anything is staged, which the export reports as a failed build.
  it("game.export of a Rust game's browser copy fails its Rust build, and exports and stages nothing", async (t) => {
    const { core, call, cpp } = await studio(t);
    const before = await readdir(core.layout.exports).catch(() => []);
    await assert.rejects(
      call("game.export", { project: "ferris" }),
      (error: { code?: unknown }) => error.code === ExportRefusal.BuildFailed,
    );
    assert.deepEqual(await readdir(core.layout.exports).catch(() => []), before, "nothing under exports");
    assert.deepEqual(await readdir(core.layout.rustBuilds).catch(() => []), [], "nothing staged");
    assert.equal(cpp.mock.callCount(), 0);
  });

  // Flipped (M2a): was lane-missing; the Rust lane answers the browser with its typed refusal.
  // Flipped (M2.12c): was unsupported-host (`target-unbuilt`); the web builder is registered, so
  // a profile with no Rust store is refused toolchain-missing, still before anything builds.
  it("native.build of a Rust game's browser answers the Rust lane's refusal before anything builds", async (t) => {
    const { core, call, cpp } = await studio(t);
    const built = (await call("native.build", { project: "ferris", target: BuildTarget.Web })) as {
      ok: boolean;
      output: string | null;
      problem: { reason?: string } | null;
    };
    assert.equal(built.ok, false);
    assert.equal(built.output, null);
    assert.equal(built.problem?.reason, BuildProblemCode.ToolchainMissing);
    assert.deepEqual(await readdir(core.layout.rustBuilds).catch(() => []), [], "nothing staged");
    assert.equal(cpp.mock.callCount(), 0);
  });

  it("game.upgradeContract leaves a Rust game as it is, and says so", async (t) => {
    const { call, ferris } = await studio(t);
    const before = await bytesIn(ferris.dir);
    const result = (await call("game.upgradeContract", { project: "ferris" })) as {
      upgraded: boolean;
      reason?: string;
    };
    assert.equal(result.upgraded, false);
    assert.equal(typeof result.reason, "string");
    assert.deepEqual(await bytesIn(ferris.dir), before, "no JavaScript contract was written");
  });
});

describe("a lease declares the stacks its harness serves", () => {
  /** A load through `handle`, answered as its refusal (null when it was not refused). */
  async function refusalOf(api: CoreApi, project: string, handle: string) {
    return api["preview.load"]({ project, handle }).then(
      () => null,
      (error: unknown) => (error as { refusal?: string }).refusal ?? String(error),
    );
  }

  it("a lease whose harness declares no stacks is refused for a Rust game before anything loads", async (t) => {
    const { api, hidden, cpp } = await studio(t);
    for (const target of [undefined, BuildTarget.Web]) {
      const { handle } = await api()["preview.acquire"]({ label: "evidence", ...(target ? { target } : {}) });
      assert.equal(await refusalOf(api(), "ferris", handle), NativeRefusal.HarnessPredatesNative, String(target));
    }
    assert.deepEqual(
      hidden.map((made) => made.record.loads),
      hidden.map(() => 0),
      "nothing was loaded",
    );
    assert.equal(cpp.mock.callCount(), 0, "nothing was built");
  });

  it("a lease that declares rust-wgpu is not refused for it, and an undeclared lease still loads a three.js game", async (t) => {
    const { api, core } = await studio(t);
    const declared = await api()["preview.acquire"]({
      label: "evidence",
      target: BuildTarget.Web,
      stacks: [GameStack.ThreeJs, GameStack.RaylibCpp, GameStack.RustWgpu],
    });
    assert.notEqual(await refusalOf(api(), "ferris", declared.handle), NativeRefusal.HarnessPredatesNative);
    await core.games.scaffold("orbit", { title: "Orbit" });
    const undeclared = await api()["preview.acquire"]({ label: "evidence" });
    assert.equal(await refusalOf(api(), "orbit", undeclared.handle), null);
  });

  it("a Rust night on a harness that kept a pre-Rust part is refused by that module's name, declared lease or not", async (t) => {
    const { api, core, hidden, cpp } = await studio(t);
    const kept = path.join(core.layout.harnessWs, "loop", "native-loop.ts");
    // A copy from before Rust games: the agent's edit, and no SERVES_RUST mark (the seed's own has one).
    const preRust = (await readFile(kept, "utf8")).replace(/export const SERVES_RUST = true;/, "");
    await writeFile(kept, `${preRust}\n// the agent's own change, from before Rust\n`);
    for (const stacks of [[GameStack.ThreeJs, GameStack.RaylibCpp, GameStack.RustWgpu], undefined]) {
      const { handle } = await api()["preview.acquire"]({
        label: "evidence",
        target: BuildTarget.Web,
        ...(stacks ? { stacks } : {}),
      });
      const refused = await api()
        ["preview.load"]({ project: "ferris", handle })
        .then(
          () => null,
          (error: { refusal?: string; message?: string }) => error,
        );
      assert.equal(refused?.refusal, NativeRefusal.HarnessPredatesNative, JSON.stringify(stacks));
      assert.match(refused?.message ?? "", /loop\/native-loop\.ts/, "the kept module is named");
    }
    assert.deepEqual(
      hidden.map((made) => made.record.loads),
      hidden.map(() => 0),
      "nothing was loaded",
    );
    assert.equal(cpp.mock.callCount(), 0, "nothing was built");
  });

  it("preview.acquire refuses a stacks list naming a stack it does not know, and leases nothing", async (t) => {
    const { api, hidden } = await studio(t);
    for (const stacks of [["unity"], "rust-wgpu", [GameStack.RustWgpu, 7]]) {
      await assert.rejects(
        api()["preview.acquire"]({ label: "evidence", stacks } as never),
        Error,
        JSON.stringify(stacks),
      );
    }
    assert.equal(hidden.length, 0, "no window was opened");
  });
});

describe("the rust-game fixture", () => {
  it("is a named fixture whose seed is a Rust game in the library, with no Rust toolchain", async () => {
    assert.ok(isFixtureName(FixtureName.RustGame));
    const { core } = await coreLite({ gamesRoot: await realpath(await tmpDir("split-sites-fixture-")) });
    await seedRustGame(core);
    await seedRustGame(core);
    const game = (await core.games.list()).find((listed) => listed.name === FIXTURE_RUST_GAME.name);
    assert.ok(game, "the Rust game is in the library");
    assert.equal(game.shape.kind, ProjectKind.RustWgpu);
    const lock = path.join(core.layout.toolchains, LOCK_FILE_OF_STACK[GameStack.RustWgpu]);
    assert.equal(await stat(lock).catch(() => null), null, "no Rust toolchain lock");
    // Scaffolded from the shipped template: a folder the Rust contract accepts, no cargo files of its own.
    const validation = await validateGameDir(game.dir);
    assert.deepEqual([validation.ok, validation.codes], [true, []], validation.problems.join("; "));
    assert.equal(await stat(path.join(game.dir, "Cargo.toml")).catch(() => null), null, "no Cargo.toml");
  });
});

/** One classified site, as `tests/fixtures/stack-split-sites.json` lists it. */
interface SplitSite {
  file: string;
  site: string;
  bucket: string;
  owner: string;
  note: string;
}

const SPLIT_SITES = path.resolve(import.meta.dirname, "../fixtures/stack-split-sites.json");
const BUCKETS = ["compiled", "raylib-specific", "needs-rust-content"];

describe("the split sites, as data for the packages that fill them", () => {
  it("every listed site names its file, its bucket and the package that owns it", async () => {
    const data = JSON.parse(await readFile(SPLIT_SITES, "utf8")) as { sites: SplitSite[] };
    assert.ok(data.sites.length > 0);
    for (const site of data.sites) {
      assert.ok(BUCKETS.includes(site.bucket), `${site.file} ${site.site}: ${site.bucket}`);
      assert.match(site.owner, /^M\d+\.\d+$/, `${site.file} ${site.site}`);
      assert.ok(site.note.length > 0, `${site.file} ${site.site}`);
      const file = await stat(path.resolve(import.meta.dirname, "../..", site.file)).catch(() => null);
      assert.ok(file?.isFile(), site.file);
    }
    const keys = data.sites.map((site) => `${site.file}#${site.site}`);
    assert.equal(new Set(keys).size, keys.length, "no site is listed twice");
    const third = data.sites.filter((site) => site.bucket === "needs-rust-content");
    assert.ok(third.length > 0 && third.every((site) => site.owner === "M3.4"), "the third bucket is M3.4's");
  });
});

describe("a newer Genex's game is read-only to every host writer", () => {
  /** A core whose library holds `fjord`, made by a newer Genex: a kind and stack this one does not know. */
  async function newer(t: TestContext) {
    const lite = await coreLite({ gamesRoot: await realpath(await tmpDir("split-sites-newer-")) });
    const dir = path.join(lite.gamesRoot, "fjord");
    await mkdir(path.join(dir, "src"), { recursive: true });
    const studioJson = {
      title: "Fjord",
      kind: "rust-bevy",
      stack: "rust-bevy",
      entry: "index.html",
      main: "src/main.rs",
    };
    await writeFile(path.join(dir, "studio.json"), `${JSON.stringify(studioJson)}\n`);
    await writeFile(path.join(dir, "src", "main.rs"), "fn main() {}\n");
    await writeFile(path.join(dir, "index.html"), "<!doctype html><title>Fjord</title>\n");
    const delegated = t.mock.fn(async () => ({ ok: true, engine: "fake-delegate", summary: "", turns: 1, usage: {} }));
    lite.core.engines.register({
      id: "fake-delegate",
      label: "Fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: delegated,
    } as never);
    return { ...lite, dir, call: harness(lite.api()), delegated };
  }

  const kindUnsupported = (error: { code?: unknown }) => error.code === TargetRefusal.KindUnsupported;

  it("is listed read-only, and game.write, game.upgradeContract and a snapshot are refused typed with nothing written", async (t) => {
    const { core, dir, call } = await newer(t);
    const fjord = (await core.games.list()).find((game) => game.name === "fjord");
    assert.equal(fjord?.shape.readOnly, TargetRefusal.KindUnsupported);
    const before = await bytesIn(dir);
    await assert.rejects(
      call("game.write", { project: "fjord", file: "src/main.rs", contents: "// x\n" }),
      kindUnsupported,
    );
    await assert.rejects(call("game.write", { project: "fjord", file: "notes.md", contents: "x\n" }), kindUnsupported);
    await assert.rejects(call("game.upgradeContract", { project: "fjord" }), kindUnsupported);
    await assert.rejects(core.snapshot(SnapshotScope.Game, "before a night", "fjord"), kindUnsupported);
    assert.deepEqual(await bytesIn(dir), before, "nothing was written into the folder");
    assert.equal((await readdir(dir)).includes(".git"), false, "no history was started in it");
  });

  it("starts no agent in it: engine.delegate is refused typed before the engine is asked", async (t) => {
    const { core, dir, call, delegated } = await newer(t);
    const threadId = await core.createGameThread("fjord");
    const before = await bytesIn(dir);
    await assert.rejects(
      call("engine.delegate", { engine: "fake-delegate", project: "fjord", threadId, prompt: "build" }),
      kindUnsupported,
    );
    assert.equal(delegated.mock.callCount(), 0, "no agent was started");
    assert.deepEqual(await bytesIn(dir), before);
  });
});
