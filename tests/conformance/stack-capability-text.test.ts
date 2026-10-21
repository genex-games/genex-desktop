/**
 * What the host tells a game's sessions about its stack (M3.4, the "needs Rust content" sites of
 * `tests/fixtures/stack-split-sites.json`): the capability facts' dependency sentence, the
 * multiplayer preflight and the contract upgrade each answer a Rust · wgpu game with its own words.
 * A Rust game never reads the three.js template's `/vendor/` sentence or the C++ toolchain's, and
 * Genex's JavaScript multiplayer packages are refused by the game's stack, by a named reason,
 * before any package.json is looked at. Driven through the pure builders and the core's harness
 * table, as the harness calls it.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { MULTIPLAYER_REASON, multiplayerReadiness } from "../../src/main/core/generation-prerequisites.ts";
import { CapabilityAudience, planningCapabilities } from "../../src/main/planning-capabilities.ts";
import { BuildTarget, type GameProject, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import { PluginAccountState } from "../../src/shared/plugins.ts";
import { readProjectShape } from "../../src/substrate/game-workspace.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { GameEngine } from "../../src/shared/game-engine.ts";
import { factsOfEngine } from "../../src/shared/project-facts.ts";

/** The three.js template's words: a compiled game never reads them. */
const THREE_WORDS = [/\/vendor\//, /Three\.js/, /import map/, /CDN/];
/** The C++ toolchain's words: a Rust game never reads them. */
const CPP_TOOLCHAIN = [/genex\.cmake/, /FetchContent/, /find_package/, /Emscripten/, /third_party/];
/** …nor the stack's own name, in text written for one game alone. */
const CPP_WORDS = [/C\+\+/, /raylib/, ...CPP_TOOLCHAIN];

/** Every word of another stack that `stack`'s text must not hold. */
const FOREIGN_WORDS = {
  [GameStack.ThreeJs]: CPP_WORDS,
  [GameStack.RaylibCpp]: THREE_WORDS,
  [GameStack.RustWgpu]: [...THREE_WORDS, ...CPP_WORDS],
} as const satisfies Record<GameStack, readonly RegExp[]>;

const EMPTY_CONNECTIONS = { revision: 0, appliedRevision: null, active: false, sources: [] };

describe("the capability facts' dependency sentence is the game's stack's own", () => {
  for (const stack of Object.values(GameStack)) {
    for (const audience of Object.values(CapabilityAudience)) {
      it(`a ${stack} game (${audience}) reads no other stack's toolchain or library words`, () => {
        const template = stack === GameStack.ThreeJs;
        const text = planningCapabilities(1, [], EMPTY_CONNECTIONS, [], template, audience, [], stack);
        for (const word of FOREIGN_WORDS[stack]) assert.doesNotMatch(text, word, `${stack}: ${word}`);
      });
    }
  }

  it("a Rust game is told where its crates come from: genex.toml, the studio's store, nothing fetched", () => {
    const text = planningCapabilities(
      1,
      [],
      EMPTY_CONNECTIONS,
      [],
      false,
      CapabilityAudience.Planning,
      [],
      GameStack.RustWgpu,
    );
    assert.match(text, /genex\.toml/);
    assert.match(text, /Rust · wgpu/);
  });
});

describe("Genex multiplayer readiness by stack: raylib refused, Rust through its web draft (G6 MP-5c)", () => {
  const ready = {
    manifest: true,
    install: true,
    publish: true,
    account: PluginAccountState.Unlocked,
  };

  // Flipped (G6 MP-5c): a Rust game was refused RustGame whatever else was ready; it now plays
  // online through genex-net and its web draft, so it needs neither a package.json nor Genex's npm
  // packages, and is refused only for no web build, the account or the draft route.
  it("a Rust game with a web build is ready on the draft route, with no package.json or npm packages", () => {
    const rust = { manifest: false, install: false, publish: true, account: PluginAccountState.Unlocked };
    assert.deepEqual(multiplayerReadiness({ ...rust, stack: GameStack.RustWgpu, webBuild: true }), {
      ready: true,
      reason: MULTIPLAYER_REASON.RustReady,
      hostedVerified: false,
    });
    for (const word of [...CPP_WORDS, ...THREE_WORDS]) assert.doesNotMatch(MULTIPLAYER_REASON.RustReady, word);
  });

  it("a Rust game is refused, in this order, for no web build, the account, then the draft route", () => {
    const rust: Parameters<typeof multiplayerReadiness>[0] = { ...ready, stack: GameStack.RustWgpu, webBuild: true };
    const reasonOf = (facts: typeof rust) => multiplayerReadiness(facts).reason;
    assert.equal(reasonOf({ ...rust, webBuild: false, account: "locked" }), MULTIPLAYER_REASON.RustNoWeb);
    assert.equal(reasonOf({ ...rust, account: "locked", publish: false }), MULTIPLAYER_REASON.Locked);
    assert.equal(reasonOf({ ...rust, publish: false }), MULTIPLAYER_REASON.NoPublish);
    assert.equal(multiplayerReadiness({ ...rust, webBuild: false }).hostedVerified, false);
  });

  it("a raylib game keeps its reason, and a three.js game is still asked for the rest", () => {
    assert.equal(multiplayerReadiness({ ...ready, stack: GameStack.RaylibCpp }).reason, MULTIPLAYER_REASON.CppGame);
    assert.equal(multiplayerReadiness({ ...ready, stack: GameStack.ThreeJs }).ready, true);
    assert.equal(multiplayerReadiness({ ...ready, stack: null }).ready, true);
  });
});

/** The minimal Rust · wgpu game folder, with a package.json that must not make it a JavaScript game. */
const RUST_FILES: Record<string, string> = {
  "genex.toml": '[game]\ntitle = "Ferris"\n',
  "src/main.rs": "fn main() {}\n",
  "package.json": '{"name":"ferris"}\n',
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

/** A core whose library lists one Rust game, `ferris`, written by hand. */
async function rustLibrary(t: TestContext) {
  const lite = await coreLite({ gamesRoot: await realpath(await tmpDir("stack-text-")) });
  const dir = path.join(lite.gamesRoot, "ferris");
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
  const list = lite.core.games.list.bind(lite.core.games);
  t.mock.method(lite.core.games, "list", async () => [...(await list()).filter((g) => g.name !== "ferris"), ferris]);
  const table = lite.api() as unknown as Record<string, (params: unknown) => Promise<unknown>>;
  const call = (method: string, params: unknown) => {
    const handler = table[method];
    assert.ok(handler, `${method} is a host method`);
    return handler(params);
  };
  return { ...lite, dir, call };
}

describe("the host answers a Rust game's sessions in Rust terms", () => {
  it("capabilities.describe hands a Rust game no /vendor/ and no C++ toolchain sentence", async (t) => {
    const { call, core } = await rustLibrary(t);
    const threadId = await core.store.createThread({ title: "ferris" });
    const text = String(await call("capabilities.describe", { threadId, project: "ferris" }));
    // Plugin tool descriptions may name every stack they refuse; the game's own facts never
    // hand it the template's library sentence or the C++ toolchain's.
    for (const word of [...THREE_WORDS, ...CPP_TOOLCHAIN]) assert.doesNotMatch(text, word, String(word));
    assert.match(text, /This is a Rust · wgpu game/);
  });

  // Flipped (G6 MP-5c): the preflight answered RustGame; a Rust game with a web build is now asked
  // for what its draft route needs, the Genex account first (locked in a fresh profile).
  it("plugins.preflightMultiplayer asks a Rust game with a web build for the account, never for npm packages", async (t) => {
    const { call } = await rustLibrary(t);
    assert.deepEqual(await call("plugins.preflightMultiplayer", { project: "ferris" }), {
      ready: false,
      reason: MULTIPLAYER_REASON.Locked,
      hostedVerified: false,
    });
  });

  it("game.upgradeContract keeps a Rust game's own contract in Rust words and writes nothing", async (t) => {
    const { call, dir } = await rustLibrary(t);
    const before = await bytesIn(dir);
    const answer = (await call("game.upgradeContract", { project: "ferris" })) as {
      upgraded: boolean;
      reason?: string;
    };
    assert.equal(answer.upgraded, false);
    assert.match(String(answer.reason), /genex::install/);
    for (const word of CPP_WORDS) assert.doesNotMatch(String(answer.reason), word);
    assert.deepEqual(await bytesIn(dir), before, "nothing written");
  });
});
