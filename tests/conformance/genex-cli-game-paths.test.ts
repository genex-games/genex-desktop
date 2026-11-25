/**
 * A store item's picture, model and package, and another creator's shared item, through Studio's
 * Genex CLI (marketplace plan 8.1). The CLI never runs in the game, so Studio checks each path an
 * agent names by real path inside the bound game and copies it into the run folder before the run;
 * after `items add`, it moves the folder the CLI wrote into the game's `genex-items/<id>/`, never
 * through a link. Every refusal happens before anything runs or is written, and leaves the game,
 * the folder beside it and the run folders as they were.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { GenexCliService, genexHostPreflight } from "../../src/main/core/genex-cli.ts";
import { boundGameFolder } from "../../src/main/core/genex-bound-game.ts";
import { GenexCliRefusal, GenexCliRefusalCode, SCHEMA_MAX_BYTES } from "../../src/main/core/genex-cli-policy.ts";
import { GenexPackageService } from "../../src/main/core/genex-package.ts";
import type { PluginBinding } from "../../src/shared/plugins.ts";
import { PluginHostTool } from "../../src/shared/plugins.ts";
import type { RunRequest, RunResult } from "../../src/substrate/spawn.ts";
import { pngPicture, webpPicture } from "../helpers/picture.ts";
import { removeTree, tmpDir } from "../helpers/tmp.ts";

const ITEM = "sku_phoenix";
const PICTURE = pngPicture(1024, 1024, "frost-axe");
const MODEL = "glTF-frost-axe";

/** A profile with the game `space-race` published as a draft, its files, and a folder beside the games. */
async function profile() {
  const root = await realpath(await tmpDir("genex-cli-paths-"));
  const userData = path.join(root, "userData");
  const genexStorage = path.join(userData, "engine-homes", "genex");
  const gamesRoot = path.join(root, "AI Games");
  const game = path.join(gamesRoot, "space-race");
  const outside = path.join(root, "elsewhere");
  const hosted = path.join(genexStorage, "publish", "space-race", ".genex");
  for (const dir of [hosted, path.join(game, ".genex", "scratch"), path.join(game, "assets"), outside])
    await mkdir(dir, { recursive: true });
  await mkdir(path.join(root, "resources"), { recursive: true });
  await writeFile(path.join(hosted, "project.json"), JSON.stringify({ id: "proj_1", slug: "space-race-x1" }));
  await writeFile(path.join(game, ".genex", "scratch", "frost-axe.png"), PICTURE);
  await writeFile(path.join(game, "assets", "frost-axe.glb"), MODEL);
  const pack = path.join(game, "items", "frost-axe");
  for (const dir of [path.join(pack, "sub"), path.join(pack, ".git"), path.join(pack, "node_modules", "x")])
    await mkdir(dir, { recursive: true });
  await writeFile(path.join(pack, "README.md"), "Swing it.\n");
  await writeFile(path.join(pack, "sub", "freeze.js"), "export const seconds = 1;\n");
  await writeFile(path.join(pack, ".git", "HEAD"), "ref\n");
  await writeFile(path.join(pack, "node_modules", "x", "index.js"), "\n");
  await writeFile(path.join(outside, "secret.png"), "SECRET");
  await symlink(path.join(outside, "secret.png"), path.join(pack, "secret.png"));
  return { root, userData, genexStorage, gamesRoot, game, outside, scratch: path.join(userData, "scratch") };
}
type Profile = Awaited<ReturnType<typeof profile>>;

/** Every file and link under `dir`, relative, with a file's text or a link's target: a tree to compare. */
async function tree(dir: string, base = dir): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    if (entry.isSymbolicLink()) out[rel] = `-> ${path.relative(base, full)}`;
    else if (entry.isDirectory()) Object.assign(out, await tree(full, base));
    else out[rel] = await readFile(full, "utf8");
  }
  return out;
}

/** What one run saw: its request, and the files its argv named while it ran. */
interface Seen {
  request: RunRequest;
  named: Record<string, Record<string, string> | string>;
}

/** The value after `--flag` in a shell-quoted command line. */
function flagValue(command: string, flag: string): string | null {
  const match = new RegExp(`'--${flag}' '([^']*)'`).exec(command);
  return match?.[1] ?? null;
}

/**
 * A sandbox that runs nothing: it records each run and what its path flags named then, lets `write`
 * act as the CLI in the run folder, and answers `stdout` with `code`.
 */
function fakeSandbox(options: { stdout?: string; code?: number; write?: (cwd: string) => Promise<void> } = {}) {
  const seen: Seen[] = [];
  const run = async (request: RunRequest): Promise<RunResult> => {
    const named: Seen["named"] = {};
    for (const flag of ["image", "model", "package", "schema"]) {
      const value = flagValue(request.command, flag);
      if (!value) continue;
      const stats = await lstat(value);
      named[flag] = stats.isDirectory() ? await tree(value) : await readFile(value, "utf8");
    }
    seen.push({ request, named });
    await options.write?.(request.cwd);
    return {
      code: options.code ?? 0,
      signal: null,
      stdout: options.stdout ?? "{}",
      stderr: "",
      durationMs: 1,
      timedOut: false,
      truncated: false,
      sandboxed: true,
      command: request.command,
      cwd: request.cwd,
    };
  };
  return { run, seen };
}

function service(p: Profile, sandbox: { run: (r: RunRequest) => Promise<RunResult> }) {
  return new GenexCliService({
    run: sandbox.run,
    credentialFile: async () => "GENEX_TOKEN=tok-synthetic\n",
    heldCredentials: () => ["tok-synthetic"],
    runsRoot: path.join(p.userData, "genex-cli"),
    resources: path.join(p.root, "resources"),
    genexStorage: p.genexStorage,
    protectedWrites: () => [p.gamesRoot, p.game],
    boundGame: (binding) =>
      boundGameFolder(binding, { gameDir: (name) => path.join(p.gamesRoot, name), scratch: p.scratch }),
    now: () => Date.UTC(2026, 9, 23, 7, 30),
  });
}

const bound = (p: Profile, directory = p.game): PluginBinding => ({ project: "space-race", directory, threadId: "t1" });
const shopAdd = (options: Record<string, unknown>) => ({
  command: "shop add",
  args: "Frost Axe",
  options: { price: 1200, image: ".genex/scratch/frost-axe.png", ...options },
});
/** A change to a listed item takes the same files, and the person approves it on a card. */
const shopSet = (options: Record<string, unknown>) => ({ command: "shop set", args: ITEM, options });
// A new item's draft runs through the free tool: it asks nobody (`genex-cli-policy.ts`).
const FREE = { paid: false };
const PAID = { paid: true };

/**
 * A store item's picture fills its card edge to edge, so it is square and big enough to stay sharp
 * there: an arena's classes went up as 768-pixel portraits on black that sat small in the card's
 * placeholder. A picture that is not one is refused before anything runs.
 */
describe("a store item's picture, sized for its card", () => {
  for (const [name, bytes, why] of [
    ["too small", pngPicture(256, 256), /256 × 256.*square, at least 768 × 768/],
    ["not square", pngPicture(1024, 768), /1024 × 768.*square, at least 768 × 768/],
    ["not a PNG or WebP", Buffer.from("GIF89a-frost"), /not a PNG or WebP/],
  ] as const) {
    it(`refuses a picture that is ${name}, and nothing runs`, async () => {
      const p = await profile();
      await writeFile(path.join(p.game, ".genex", "scratch", "frost-axe.png"), bytes);
      const sandbox = fakeSandbox();
      await assert.rejects(service(p, sandbox).run(shopAdd({}), bound(p), FREE), why);
      assert.equal(sandbox.seen.length, 0);
    });
  }

  it("takes a square PNG or WebP of 768 or more", async () => {
    for (const bytes of [pngPicture(768, 768), pngPicture(2048, 2048), webpPicture(1024, 1024)]) {
      const p = await profile();
      await writeFile(path.join(p.game, ".genex", "scratch", "frost-axe.png"), bytes);
      const sandbox = fakeSandbox();
      const answer = await service(p, sandbox).run(shopAdd({}), bound(p), FREE);
      assert.equal(answer.ok, true);
    }
  });
});

describe("a store item's files, from the game into the run folder", () => {
  it("copies the picture, model and package and points the CLI at the copies, leaving the game as it was", async () => {
    const p = await profile();
    const before = await tree(p.gamesRoot);
    const sandbox = fakeSandbox();
    const answer = await service(p, sandbox).run(
      shopAdd({ image: ".genex/scratch/frost-axe.png", model: "./assets/frost-axe.glb", package: "items/frost-axe" }),
      bound(p),
      FREE,
    );
    assert.equal(answer.ok, true);
    const [run] = sandbox.seen;
    assert.ok(run, "the CLI ran");
    assert.equal(run.named.image, PICTURE.toString());
    assert.equal(run.named.model, MODEL);
    assert.deepEqual(
      run.named.package,
      { "README.md": "Swing it.\n", [path.join("sub", "freeze.js")]: "export const seconds = 1;\n" },
      "no .git, node_modules or link leaves the game",
    );
    const runs = path.join(p.userData, "genex-cli");
    for (const flag of ["image", "model", "package"]) {
      const copy = flagValue(run.request.command, flag) ?? "";
      assert.ok(copy.startsWith(`${runs}${path.sep}`), `${flag} names the run folder's copy: ${copy}`);
    }
    assert.deepEqual(await tree(p.gamesRoot), before, "the game is untouched");
    assert.deepEqual(await readdir(runs), [], "the run folder and its copies are gone");
  });

  const hostile: Array<[string, (p: Profile) => Promise<Record<string, unknown>>, RegExp]> = [
    ["a picture behind ../", async () => ({ image: "../elsewhere/secret.png" }), /inside this game/],
    ["an absolute picture", async (p) => ({ image: path.join(p.outside, "secret.png") }), /inside this game/],
    [
      "a link in the game that leads out of it",
      async (p) => {
        await symlink(path.join(p.outside, "secret.png"), path.join(p.game, "assets", "axe.png"));
        return { image: "assets/axe.png" };
      },
      /leads outside this game/,
    ],
    [
      "a file through a linked folder",
      async (p) => {
        await symlink(p.outside, path.join(p.game, "linked"));
        return { image: "linked/secret.png" };
      },
      /leads outside this game/,
    ],
    [
      "a package folder that is a link out of the game",
      async (p) => {
        await symlink(p.outside, path.join(p.game, "linked"));
        return { package: "linked" };
      },
      /leads outside this game/,
    ],
    ["a picture the game does not have", async () => ({ image: "assets/missing.png" }), /names nothing/],
    ["a folder as the picture", async () => ({ image: "assets" }), /not a file/],
    ["a file as the package", async () => ({ package: "assets/frost-axe.glb" }), /not a folder/],
  ];
  for (const [name, options, message] of hostile) {
    it(`refuses ${name} before anything runs or is copied`, async () => {
      const p = await profile();
      const sandbox = fakeSandbox();
      const given = await options(p);
      const before = { games: await tree(p.gamesRoot), outside: await tree(p.outside) };
      const cli = service(p, sandbox);
      await assert.rejects(cli.run(shopAdd(given), bound(p), FREE), (error: unknown) => {
        assert.ok(error instanceof GenexCliRefusal, String(error));
        assert.equal(error.code, GenexCliRefusalCode.InvalidValue);
        assert.match(error.message, message);
        return true;
      });
      await assert.rejects(cli.preflight(shopSet(given), bound(p), PAID), message, "nobody is asked");
      assert.equal(sandbox.seen.length, 0, "nothing ran");
      assert.deepEqual(await tree(p.gamesRoot), before.games);
      assert.deepEqual(await tree(p.outside), before.outside);
      assert.deepEqual(await readdir(path.join(p.userData, "genex-cli")).catch(() => []), []);
    });
  }

  it("refuses a call bound to a folder that is not the game's before anything runs", async () => {
    const p = await profile();
    await writeFile(path.join(p.outside, "frost-axe.png"), PICTURE);
    const sandbox = fakeSandbox();
    await assert.rejects(
      service(p, sandbox).run(shopAdd({ image: "frost-axe.png" }), bound(p, p.outside), FREE),
      /not bound to the game/,
    );
    assert.equal(sandbox.seen.length, 0);
  });

  it("asks the person only about a call whose files the game has", async () => {
    const p = await profile();
    const sandbox = fakeSandbox();
    const cli = service(p, sandbox);
    const packages = new GenexPackageService({
      addPackages: async () => ({ ok: true, lines: [] }),
      gameDir: (name) => path.join(p.gamesRoot, name),
      scratch: p.scratch,
    });
    const preflight = genexHostPreflight(packages, cli);
    const shown = await preflight(
      "genex",
      PluginHostTool.GenexCliPaid,
      shopSet({ image: ".genex/scratch/frost-axe.png" }),
      bound(p),
    );
    assert.equal(shown.command, "shop set");
    assert.equal(shown.image, ".genex/scratch/frost-axe.png");
    await assert.rejects(
      preflight("genex", PluginHostTool.GenexCliPaid, shopSet({ image: "assets/missing.png" }), bound(p)),
      /names nothing/,
    );
    assert.equal(sandbox.seen.length, 0, "a preflight runs nothing");
  });
});

/** The shape a game's model call answers in, as the game keeps it in one file. */
const SCHEMA = `${JSON.stringify(
  {
    type: "object",
    properties: { line: { type: "string", maxLength: 240 }, mood: { enum: ["warm", "wary"] } },
    required: ["line", "mood"],
    additionalProperties: false,
  },
  null,
  2,
)}\n`;
const SCHEMA_FILE = "answer.schema.json";
const bench = (schema: unknown) => ({
  command: "llm bench",
  args: "Greet the traveller in one line.",
  options: { "max-credits": 5, schema },
});

/**
 * Genex's pricing card benchmarks with the game's own answer-shape file (`--schema`), and the CLI
 * never runs in the game: the file is a path boundary like a store item's picture. Studio takes one
 * small `.json` file inside the bound game, by real path, and the CLI reads Studio's copy.
 */
describe("a bench's answer-shape file, from the game into the run folder", () => {
  it("copies the schema, points the CLI at the copy and opens the API alone", async () => {
    const p = await profile();
    await writeFile(path.join(p.game, SCHEMA_FILE), SCHEMA);
    const before = await tree(p.gamesRoot);
    const sandbox = fakeSandbox();
    const answer = await service(p, sandbox).run(bench(`./${SCHEMA_FILE}`), bound(p), PAID);
    assert.equal(answer.ok, true);
    const [run] = sandbox.seen;
    assert.ok(run, "the CLI ran");
    assert.equal(run.named.schema, SCHEMA, "the CLI reads the game's schema, byte for byte");
    const runs = path.join(p.userData, "genex-cli");
    const copy = flagValue(run.request.command, "schema") ?? "";
    assert.ok(copy.startsWith(`${runs}${path.sep}`), `schema names the run folder's copy: ${copy}`);
    assert.equal(path.basename(copy), SCHEMA_FILE);
    assert.ok(run.request.command.includes("'--max-credits' '5'"), run.request.command);
    assert.deepEqual(
      run.request.policy?.allowedDomains,
      ["api.genex.games"],
      "a schema goes in the request: no item storage opens for it",
    );
    assert.deepEqual(await tree(p.gamesRoot), before, "the game is untouched");
    assert.deepEqual(await readdir(runs), [], "the run folder and its copy are gone");
  });

  it("takes a schema of exactly the most Genex takes, in a folder of the game", async () => {
    const p = await profile();
    const full = `"${"s".repeat(SCHEMA_MAX_BYTES - 2)}"`;
    await writeFile(path.join(p.game, "assets", "Full.Schema.JSON"), full);
    const sandbox = fakeSandbox();
    const cli = service(p, sandbox);
    const shown = await cli.preflight(bench("assets/Full.Schema.JSON"), bound(p), PAID);
    assert.equal(shown.schema, "assets/Full.Schema.JSON");
    assert.equal(shown["max-credits"], "5");
    assert.equal((await cli.run(bench("assets/Full.Schema.JSON"), bound(p), PAID)).ok, true);
    assert.equal(sandbox.seen[0]?.named.schema, full);
  });

  const hostile: Array<[string, (p: Profile) => Promise<unknown>, RegExp]> = [
    [
      "a schema behind ../",
      async (p) => {
        await writeFile(path.join(p.outside, SCHEMA_FILE), SCHEMA);
        return `../elsewhere/${SCHEMA_FILE}`;
      },
      /inside this game/,
    ],
    [
      "a schema behind ../ in the middle of the path",
      async (p) => {
        await writeFile(path.join(p.outside, SCHEMA_FILE), SCHEMA);
        return `assets/../../elsewhere/${SCHEMA_FILE}`;
      },
      /inside this game/,
    ],
    [
      "an absolute schema outside the game",
      async (p) => {
        await writeFile(path.join(p.outside, SCHEMA_FILE), SCHEMA);
        return path.join(p.outside, SCHEMA_FILE);
      },
      /inside this game/,
    ],
    [
      "the game's own schema by its absolute path",
      async (p) => {
        await writeFile(path.join(p.game, SCHEMA_FILE), SCHEMA);
        return path.join(p.game, SCHEMA_FILE);
      },
      /inside this game/,
    ],
    ["a schema under the home folder", async () => `~/${SCHEMA_FILE}`, /inside this game/],
    [
      "a link in the game that leads to a schema outside it",
      async (p) => {
        await writeFile(path.join(p.outside, SCHEMA_FILE), SCHEMA);
        await symlink(path.join(p.outside, SCHEMA_FILE), path.join(p.game, SCHEMA_FILE));
        return SCHEMA_FILE;
      },
      /leads outside this game/,
    ],
    [
      "a schema through a linked folder",
      async (p) => {
        await writeFile(path.join(p.outside, SCHEMA_FILE), SCHEMA);
        await symlink(p.outside, path.join(p.game, "linked"));
        return `linked/${SCHEMA_FILE}`;
      },
      /leads outside this game/,
    ],
    [
      "a link to a link that leaves the game",
      async (p) => {
        await writeFile(path.join(p.outside, SCHEMA_FILE), SCHEMA);
        await symlink(path.join(p.outside, SCHEMA_FILE), path.join(p.game, "assets", "there.json"));
        await symlink(path.join(p.game, "assets", "there.json"), path.join(p.game, SCHEMA_FILE));
        return SCHEMA_FILE;
      },
      /leads outside this game/,
    ],
    [
      "a folder named like a schema",
      async (p) => {
        await mkdir(path.join(p.game, "schemas.json"));
        return "schemas.json";
      },
      /not a file/,
    ],
    ["a schema the game does not have", async () => "missing.schema.json", /names nothing/],
    [
      "a schema one byte larger than Genex takes",
      async (p) => {
        await writeFile(path.join(p.game, SCHEMA_FILE), `"${"s".repeat(SCHEMA_MAX_BYTES - 1)}"`);
        return SCHEMA_FILE;
      },
      /16 KB/,
    ],
    [
      "a file far too large to be a schema",
      async (p) => {
        await writeFile(path.join(p.game, SCHEMA_FILE), Buffer.alloc(4 * 1024 * 1024, "s"));
        return SCHEMA_FILE;
      },
      /16 KB/,
    ],
    ["a file of another kind", async () => "assets/frost-axe.glb", /takes a \.json file/],
    [
      "a .json link to a file of another kind in the game",
      async (p) => {
        await writeFile(path.join(p.game, ".env"), "KEY=synthetic\n");
        await symlink(path.join(p.game, ".env"), path.join(p.game, SCHEMA_FILE));
        return SCHEMA_FILE;
      },
      /is not a \.json file/,
    ],
    ["a path with a NUL", async () => `answer\u0000.schema.json`, /control characters/],
    ["a path with a line break", async () => `${SCHEMA_FILE}\n--env`, /control characters/],
    ["a path that reads as a flag", async () => "--api-url.json", /not starting with -/],
  ];
  for (const [name, plant, message] of hostile) {
    it(`refuses ${name} before anyone is asked, and reads and copies nothing`, async () => {
      const p = await profile();
      const sandbox = fakeSandbox();
      const call = bench(await plant(p));
      const before = { games: await tree(p.gamesRoot), outside: await tree(p.outside) };
      const cli = service(p, sandbox);
      const refused = (error: unknown) => {
        assert.ok(error instanceof GenexCliRefusal, String(error));
        assert.equal(error.code, GenexCliRefusalCode.InvalidValue);
        assert.match(error.message, message);
        return true;
      };
      await assert.rejects(cli.preflight(call, bound(p), PAID), refused, "nobody is asked");
      await assert.rejects(cli.run(call, bound(p), PAID), refused);
      assert.equal(sandbox.seen.length, 0, "nothing ran");
      assert.deepEqual(await tree(p.gamesRoot), before.games);
      assert.deepEqual(await tree(p.outside), before.outside);
      assert.deepEqual(await readdir(path.join(p.userData, "genex-cli")).catch(() => []), [], "no copy was made");
    });
  }

  it("refuses a schema for a call bound to a folder that is not the game's", async () => {
    const p = await profile();
    await writeFile(path.join(p.outside, SCHEMA_FILE), SCHEMA);
    const sandbox = fakeSandbox();
    await assert.rejects(
      service(p, sandbox).run(bench(SCHEMA_FILE), bound(p, p.outside), PAID),
      /not bound to the game/,
    );
    assert.equal(sandbox.seen.length, 0);
  });

  it("still runs a bench that names no schema, on the hosted project alone", async () => {
    const p = await profile();
    const sandbox = fakeSandbox();
    const call = { command: "llm bench", args: "Greet the traveller.", options: { "max-credits": 5 } };
    assert.equal((await service(p, sandbox).run(call, bound(p, p.outside), PAID)).ok, true);
    assert.equal(flagValue(sandbox.seen[0]?.request.command ?? "", "schema"), null);
  });
});

/** The CLI's `items add` in the run folder: the item's folder as it writes it, and its JSON answer. */
async function cliWritesItem(cwd: string): Promise<void> {
  const dir = path.join(cwd, "genex-items", ITEM);
  await mkdir(path.join(dir, "models"), { recursive: true });
  await writeFile(path.join(dir, "item.json"), `${JSON.stringify({ skuId: ITEM, name: "Phoenix Wings" })}\n`);
  await writeFile(path.join(dir, "models", "wings.glb"), "glTF-wings");
}
const ADDED = JSON.stringify({ allowance: { skuId: ITEM }, dir: `genex-items/${ITEM}`, files: ["models/wings.glb"] });
const itemsAdd = { command: "items add", args: ITEM };

describe("another creator's item, into the game (`items add`)", () => {
  it("moves the folder the CLI wrote into the game's genex-items/<id>/ and answers as the CLI did", async () => {
    const p = await profile();
    const sandbox = fakeSandbox({ stdout: ADDED, write: cliWritesItem });
    const answer = await service(p, sandbox).run(itemsAdd, bound(p), { paid: true });
    assert.equal(answer.ok, true);
    assert.deepEqual(answer.output, JSON.parse(ADDED));
    assert.deepEqual(await tree(path.join(p.game, "genex-items")), {
      [path.join(ITEM, "item.json")]: `${JSON.stringify({ skuId: ITEM, name: "Phoenix Wings" })}\n`,
      [path.join(ITEM, "models", "wings.glb")]: "glTF-wings",
    });
    assert.deepEqual(await readdir(path.join(p.userData, "genex-cli")), [], "the run folder is gone");
  });

  it("keeps an earlier copy under .genex/replaced-items, never deleting it", async () => {
    const p = await profile();
    const earlier = path.join(p.game, "genex-items", ITEM);
    await mkdir(earlier, { recursive: true });
    await writeFile(path.join(earlier, "notes.md"), "my changes\n");
    const answer = await service(p, fakeSandbox({ stdout: ADDED, write: cliWritesItem })).run(itemsAdd, bound(p), {
      paid: true,
    });
    assert.equal(answer.ok, true);
    const kept = await readdir(path.join(p.game, ".genex", "replaced-items"));
    assert.equal(kept.length, 1);
    assert.match(kept[0] ?? "", new RegExp(`^${ITEM}-2026-10-23T07-30-00-000Z$`));
    assert.equal(
      await readFile(path.join(p.game, ".genex", "replaced-items", kept[0] ?? "", "notes.md"), "utf8"),
      "my changes\n",
    );
    assert.ok((await lstat(path.join(earlier, "item.json"))).isFile());
  });

  const links: Array<[string, (p: Profile) => Promise<void>]> = [
    ["genex-items is a link out of the game", (p) => symlink(p.outside, path.join(p.game, "genex-items"))],
    [
      "the item's folder is a link out of the game",
      async (p) => {
        await mkdir(path.join(p.game, "genex-items"));
        await symlink(p.outside, path.join(p.game, "genex-items", ITEM));
      },
    ],
    ["genex-items is a file", (p) => writeFile(path.join(p.game, "genex-items"), "x")],
    [
      ".genex/replaced-items, where an earlier copy goes, is a link out of the game",
      async (p) => {
        await mkdir(path.join(p.game, "genex-items", ITEM), { recursive: true });
        await symlink(p.outside, path.join(p.game, ".genex", "replaced-items"));
      },
    ],
  ];
  for (const [name, plant] of links) {
    it(`writes nothing through it when ${name}, and says so`, async () => {
      const p = await profile();
      await plant(p);
      const before = { outside: await tree(p.outside), item: await tree(path.join(p.game, "genex-items", ITEM)) };
      const answer = await service(p, fakeSandbox({ stdout: ADDED, write: cliWritesItem })).run(itemsAdd, bound(p), {
        paid: true,
      });
      assert.equal(answer.ok, false);
      assert.match(String(answer.output), new RegExp(`wrote nothing to genex-items/${ITEM}/`));
      assert.deepEqual(await tree(p.outside), before.outside, "nothing reached the folder beside the games");
      assert.deepEqual(await tree(path.join(p.game, "genex-items", ITEM)), before.item);
    });
  }

  it("refuses a folder the CLI wrote with a link in it", async () => {
    const p = await profile();
    const write = async (cwd: string) => {
      await cliWritesItem(cwd);
      await symlink(path.join(p.outside, "secret.png"), path.join(cwd, "genex-items", ITEM, "secret.png"));
    };
    const answer = await service(p, fakeSandbox({ stdout: ADDED, write })).run(itemsAdd, bound(p), { paid: true });
    assert.equal(answer.ok, false);
    assert.deepEqual(await readdir(path.join(p.game, "genex-items")), [], "no partial copy is left");
  });

  it("refuses a call bound to another folder before the item is added on Genex", async () => {
    const p = await profile();
    const sandbox = fakeSandbox({ stdout: ADDED, write: cliWritesItem });
    await assert.rejects(
      service(p, sandbox).run(itemsAdd, bound(p, p.outside), { paid: true }),
      /not bound to the game/,
    );
    assert.equal(sandbox.seen.length, 0);
  });

  it("moves nothing when the CLI failed, or wrote no folder", async () => {
    const p = await profile();
    const failed = await service(p, fakeSandbox({ code: 1, stdout: "", write: cliWritesItem })).run(
      itemsAdd,
      bound(p),
      {
        paid: true,
      },
    );
    assert.equal(failed.ok, false);
    assert.deepEqual(
      await tree(p.game).then((files) => Object.keys(files).filter((f) => f.startsWith("genex-items"))),
      [],
    );
    const empty = await service(p, fakeSandbox({ stdout: ADDED })).run(itemsAdd, bound(p), { paid: true });
    assert.equal(empty.ok, false);
    assert.match(String(empty.output), /wrote no item folder/);
  });

  it("writes nothing into the game for `items remove` or `items list`", async () => {
    const p = await profile();
    const before = await tree(p.gamesRoot);
    const cli = service(p, fakeSandbox({ stdout: "{}", write: cliWritesItem }));
    assert.equal((await cli.run({ command: "items remove", args: ITEM }, bound(p), { paid: true })).ok, true);
    assert.equal((await cli.run({ command: "items list" }, bound(p), { paid: false })).ok, true);
    assert.deepEqual(await tree(p.gamesRoot), before);
  });
});

describe("the network a run that moves an item's files opens", () => {
  // Genex hands out signed links to its object storage (Cloudflare R2) for an item's picture, model
  // and package; a run whose network reached the API alone could never move those bytes.
  const API_ONLY = ["api.genex.games"];
  const WITH_STORAGE = ["api.genex.games", "*.r2.cloudflarestorage.com"];
  const calls: Array<[string, { command: string; args?: string; options?: Record<string, unknown> }, string[]]> = [
    ["shop add with a picture", shopAdd({ image: ".genex/scratch/frost-axe.png" }), WITH_STORAGE],
    [
      "shop set with a model",
      { command: "shop set", args: ITEM, options: { model: "assets/frost-axe.glb" } },
      WITH_STORAGE,
    ],
    [
      "shop set with a package",
      { command: "shop set", args: ITEM, options: { package: "items/frost-axe" } },
      WITH_STORAGE,
    ],
    ["items add", itemsAdd, WITH_STORAGE],
    ["shop set without files", { command: "shop set", args: ITEM, options: { price: 300 } }, API_ONLY],
    ["items remove", { command: "items remove", args: ITEM }, API_ONLY],
  ];
  for (const [name, call, domains] of calls) {
    it(`opens ${domains === WITH_STORAGE ? "Genex's item storage beside the API" : "the API alone"} for ${name}`, async () => {
      const p = await profile();
      const sandbox = fakeSandbox({ stdout: ADDED, write: cliWritesItem });
      await service(p, sandbox).run(call, bound(p), call.command === "shop add" ? FREE : PAID);
      const [run] = sandbox.seen;
      assert.ok(run, "the CLI ran");
      assert.deepEqual(run.request.policy?.allowedDomains, domains);
    });
  }
});

/**
 * A native game declares the AI budget its players approve on its Genex page (`genex llm budget`),
 * and the CLI reads the declaration from the folder it runs in: `genex.modelBudget` in package.json,
 * else `modelBudget` in genex.json. Studio never runs the CLI in the game, so it copies the
 * declaration alone into the run folder, under the name of the file that held it, from a plain file
 * of the game's own folder and never through a link. Nothing is ever written into the game.
 */
describe("a native game's AI budget declaration, from the game into the run folder (`llm budget`)", () => {
  const DECLARED = {
    models: ["genex/small"],
    perCallMaxCredits: 2,
    disclosure: { periodLabel: "session", estimatedCallsPerPeriod: 40, estimatedCreditsPerPeriod: 30 },
  };
  const OTHER = { models: ["genex/large"], perCallMaxCredits: 9 };
  /** A game's package.json with a declaration among the rest of it. */
  const packageWith = (modelBudget: unknown) =>
    JSON.stringify({ name: "space-race", scripts: { build: "vite build" }, genex: { slug: "x", modelBudget } });
  const FILE_MAX_BYTES = 256 * 1024;
  const DECLARATION_MAX_BYTES = 16 * 1024;
  const budget = (action: string) => ({ command: "llm budget", args: action });

  /** The pinned CLI's own package, where Studio reads which release it is. */
  async function pinnedCli(p: Profile, version: string | null = "1.46.2"): Promise<void> {
    const dir = path.join(p.root, "resources", "plugins", "genex", "node_modules", "@genex-ai", "cli-demo");
    await mkdir(dir, { recursive: true });
    if (version !== null) await writeFile(path.join(dir, "package.json"), JSON.stringify({ version }));
  }

  /** A sandbox that records, for each run, the two declaration files as the CLI finds them in its folder. */
  function budgetSandbox() {
    const folders: Array<{ package: unknown; settings: unknown }> = [];
    const parsed = async (file: string): Promise<unknown> => {
      const text = await readFile(file, "utf8").catch(() => null);
      return text === null ? null : JSON.parse(text);
    };
    const sandbox = fakeSandbox({
      stdout: JSON.stringify({ command: "llm budget status", status: "ok" }),
      write: async (cwd) => {
        folders.push({
          package: await parsed(path.join(cwd, "package.json")),
          settings: await parsed(path.join(cwd, "genex.json")),
        });
      },
    });
    return { ...sandbox, folders };
  }

  it("copies package.json's declaration alone, which wins over genex.json's, and leaves the game as it was", async () => {
    const p = await profile();
    await pinnedCli(p);
    await writeFile(path.join(p.game, "package.json"), packageWith(DECLARED));
    await writeFile(path.join(p.game, "genex.json"), JSON.stringify({ modelBudget: OTHER }));
    const before = await tree(p.gamesRoot);
    const sandbox = budgetSandbox();
    const cli = service(p, sandbox);
    assert.deepEqual(await cli.preflight(budget("set"), bound(p), PAID), { command: "llm budget", args: "set" });
    assert.equal(sandbox.seen.length, 0, "asking runs nothing");
    const answer = await cli.run(budget("set"), bound(p), PAID);
    assert.equal(answer.ok, true);
    assert.equal(answer.note, undefined);
    assert.deepEqual(sandbox.folders, [{ package: { genex: { modelBudget: DECLARED } }, settings: null }]);
    const [run] = sandbox.seen;
    assert.ok(run, "the CLI ran");
    assert.match(run.request.command, /'llm' 'budget' 'set' --env /);
    assert.doesNotMatch(run.request.command, /user-approved/, "it spends nothing: no approval flag");
    assert.deepEqual(run.request.policy?.allowedDomains, ["api.genex.games"]);
    const runs = path.join(p.userData, "genex-cli");
    assert.ok(run.request.cwd.startsWith(`${runs}${path.sep}`), "never the game");
    assert.deepEqual(await tree(p.gamesRoot), before, "the game is byte-identical");
    assert.deepEqual(await readdir(runs), [], "the run folder and its copy are gone");
  });

  const fromSettings: Array<[string, (p: Profile) => Promise<void>]> = [
    ["has no package.json", async () => undefined],
    [
      "has a package.json that declares none",
      (p) => writeFile(path.join(p.game, "package.json"), JSON.stringify({ name: "space-race", genex: { slug: "x" } })),
    ],
    [
      "has a package.json with no Genex settings",
      (p) => writeFile(path.join(p.game, "package.json"), JSON.stringify({ name: "space-race", modelBudget: OTHER })),
    ],
    ["has a package.json that is not JSON", (p) => writeFile(path.join(p.game, "package.json"), "{ not json")],
    ["has a package.json that is a list", (p) => writeFile(path.join(p.game, "package.json"), "[1]")],
  ];
  for (const [name, plant] of fromSettings) {
    it(`copies genex.json's declaration when the game ${name}, as the CLI would read it there`, async () => {
      const p = await profile();
      await pinnedCli(p);
      await plant(p);
      await writeFile(path.join(p.game, "genex.json"), JSON.stringify({ title: "Space Race", modelBudget: DECLARED }));
      const before = await tree(p.gamesRoot);
      const sandbox = budgetSandbox();
      const answer = await service(p, sandbox).run(budget("status"), bound(p), FREE);
      assert.equal(answer.ok, true);
      assert.deepEqual(sandbox.folders, [{ package: null, settings: { modelBudget: DECLARED } }]);
      assert.deepEqual(await tree(p.gamesRoot), before);
    });
  }

  it("copies nothing for a game that declares none, and the CLI answers for itself", async () => {
    const p = await profile();
    await pinnedCli(p);
    await writeFile(path.join(p.game, "package.json"), JSON.stringify({ name: "space-race" }));
    await writeFile(path.join(p.game, "genex.json"), JSON.stringify({ title: "Space Race" }));
    const before = await tree(p.gamesRoot);
    const sandbox = budgetSandbox();
    const cli = service(p, sandbox);
    for (const [action, tool] of [
      ["status", FREE],
      ["set", PAID],
      ["clear", PAID],
    ] as const) {
      const answer = await cli.run(budget(action), bound(p), tool);
      assert.equal(answer.ok, true);
      assert.equal(answer.note, undefined);
    }
    assert.deepEqual(sandbox.folders, Array(3).fill({ package: null, settings: null }));
    assert.deepEqual(await tree(p.gamesRoot), before);
  });

  for (const [name, value] of [
    ["text", "cheap"],
    ["a list", [DECLARED]],
    ["null", null],
    ["a number", 5],
  ] as const) {
    it(`passes on a declaration that is ${name}, so the CLI names the file that holds it`, async () => {
      const p = await profile();
      await pinnedCli(p);
      await writeFile(path.join(p.game, "package.json"), packageWith(value));
      await writeFile(path.join(p.game, "genex.json"), JSON.stringify({ modelBudget: OTHER }));
      const sandbox = budgetSandbox();
      await service(p, sandbox).run(budget("set"), bound(p), PAID);
      assert.deepEqual(sandbox.folders, [{ package: { genex: { modelBudget: value } }, settings: null }]);
    });
  }

  it("takes a file and a declaration of exactly the most it reads", async () => {
    const p = await profile();
    await pinnedCli(p);
    const full = { note: "n".repeat(DECLARATION_MAX_BYTES - '{"note":""}'.length) };
    const head = JSON.stringify({ modelBudget: full }).slice(0, -1);
    const padded = `${head},"pad":"${"p".repeat(FILE_MAX_BYTES - head.length - ',"pad":""}'.length)}"}`;
    assert.equal(Buffer.byteLength(padded), FILE_MAX_BYTES);
    await writeFile(path.join(p.game, "genex.json"), padded);
    const sandbox = budgetSandbox();
    await service(p, sandbox).run(budget("status"), bound(p), FREE);
    assert.deepEqual(sandbox.folders, [{ package: null, settings: { modelBudget: full } }]);
  });

  /** A declaration elsewhere on the disk, which no link or `..` may bring in. */
  const plantOutside = (p: Profile, file: string) =>
    writeFile(
      path.join(p.outside, file),
      file === "package.json" ? packageWith(OTHER) : JSON.stringify({ modelBudget: OTHER }),
    );
  const unread: Array<[string, (p: Profile) => Promise<void>, RegExp]> = [
    [
      "a package.json that is a link to a file outside the game",
      async (p) => {
        await plantOutside(p, "package.json");
        await symlink(path.join(p.outside, "package.json"), path.join(p.game, "package.json"));
      },
      /package\.json.*not a plain file/,
    ],
    [
      "a package.json that is a link reaching outside through ../",
      async (p) => {
        await plantOutside(p, "package.json");
        await symlink("../../elsewhere/package.json", path.join(p.game, "package.json"));
      },
      /package\.json.*not a plain file/,
    ],
    [
      "a package.json that is a link to another file of the game",
      async (p) => {
        await writeFile(path.join(p.game, "assets", "package.json"), packageWith(OTHER));
        await symlink(path.join("assets", "package.json"), path.join(p.game, "package.json"));
      },
      /package\.json.*not a plain file/,
    ],
    [
      "a package.json that is a link to nothing",
      (p) => symlink(path.join(p.outside, "gone.json"), path.join(p.game, "package.json")),
      /package\.json.*not a plain file/,
    ],
    [
      "a package.json that is a folder",
      async (p) => {
        await mkdir(path.join(p.game, "package.json"));
        await writeFile(path.join(p.game, "package.json", "genex.json"), JSON.stringify({ modelBudget: OTHER }));
      },
      /package\.json.*not a plain file/,
    ],
    [
      "a package.json larger than 256 KB",
      (p) =>
        writeFile(
          path.join(p.game, "package.json"),
          `${packageWith(OTHER).slice(0, -1)},"pad":"${"p".repeat(FILE_MAX_BYTES)}"}`,
        ),
      /package\.json.*larger than 256 KB/,
    ],
    [
      "a genex.json that is a link to a file outside the game",
      async (p) => {
        await plantOutside(p, "genex.json");
        await symlink(path.join(p.outside, "genex.json"), path.join(p.game, "genex.json"));
      },
      /genex\.json.*not a plain file/,
    ],
    [
      "a genex.json that is a link reaching outside through ../",
      async (p) => {
        await plantOutside(p, "genex.json");
        await symlink("../../elsewhere/genex.json", path.join(p.game, "genex.json"));
      },
      /genex\.json.*not a plain file/,
    ],
    [
      "a genex.json larger than 256 KB",
      (p) =>
        writeFile(
          path.join(p.game, "genex.json"),
          JSON.stringify({ modelBudget: OTHER, pad: "p".repeat(FILE_MAX_BYTES) }),
        ),
      /genex\.json.*larger than 256 KB/,
    ],
  ];
  for (const [name, plant, told] of unread) {
    it(`reads no declaration from ${name}: nothing is copied, and the agent is told why`, async () => {
      const p = await profile();
      await pinnedCli(p);
      await plant(p);
      // A declaration in the second file is not sent in place of one Studio could not read in the first.
      const settings = path.join(p.game, "genex.json");
      if (!(await lstat(settings).catch(() => null)))
        await writeFile(settings, JSON.stringify({ modelBudget: DECLARED }));
      const before = { games: await tree(p.gamesRoot), outside: await tree(p.outside) };
      const sandbox = budgetSandbox();
      const cli = service(p, sandbox);
      const answer = await cli.run(budget("set"), bound(p), PAID);
      assert.deepEqual(sandbox.folders, [{ package: null, settings: null }], "the CLI finds no declaration");
      assert.match(String(answer.note), told);
      assert.match(String(answer.note), /as if the game's folder declared none/);
      assert.deepEqual(await tree(p.gamesRoot), before.games, "the game is byte-identical");
      assert.deepEqual(await tree(p.outside), before.outside);
      assert.deepEqual(await readdir(path.join(p.userData, "genex-cli")), [], "no copy outlives the run");
    });
  }

  for (const file of ["package.json", "genex.json"]) {
    it(`refuses a declaration in ${file} larger than 16 KB before anyone is asked, and runs nothing`, async () => {
      const p = await profile();
      await pinnedCli(p);
      const large = { note: "n".repeat(DECLARATION_MAX_BYTES) };
      const text = file === "package.json" ? packageWith(large) : JSON.stringify({ modelBudget: large });
      await writeFile(path.join(p.game, file), text);
      const before = await tree(p.gamesRoot);
      const sandbox = budgetSandbox();
      const cli = service(p, sandbox);
      const refused = (error: unknown) => {
        assert.ok(error instanceof GenexCliRefusal, String(error));
        assert.equal(error.code, GenexCliRefusalCode.InvalidValue);
        assert.match(error.message, new RegExp(`modelBudget in ${file.replace(".", "\\.")} is larger than 16 KB`));
        return true;
      };
      await assert.rejects(cli.preflight(budget("set"), bound(p), PAID), refused, "nobody is asked");
      await assert.rejects(cli.run(budget("set"), bound(p), PAID), refused);
      await assert.rejects(cli.run(budget("status"), bound(p), FREE), refused);
      assert.equal(sandbox.seen.length, 0, "nothing ran");
      assert.deepEqual(await tree(p.gamesRoot), before);
      assert.deepEqual(await readdir(path.join(p.userData, "genex-cli")).catch(() => []), []);
    });
  }

  const foreign: Array<[string, (p: Profile) => string]> = [
    ["a folder beside the games", (p) => p.outside],
    ["a folder reached from the game through ../", (p) => `${p.game}/../../elsewhere`],
  ];
  for (const [name, directory] of foreign) {
    it(`refuses a call bound to ${name}, whose declaration is not the game's`, async () => {
      const p = await profile();
      await pinnedCli(p);
      await writeFile(path.join(p.outside, "package.json"), packageWith(OTHER));
      const sandbox = budgetSandbox();
      const cli = service(p, sandbox);
      await assert.rejects(cli.preflight(budget("set"), bound(p, directory(p)), PAID), /not bound to the game/);
      await assert.rejects(cli.run(budget("set"), bound(p, directory(p)), PAID), /not bound to the game/);
      await assert.rejects(cli.run(budget("status"), bound(p, directory(p)), FREE), /not bound to the game/);
      assert.equal(sandbox.seen.length, 0);
    });
  }

  it("needs the game's hosted project, as every command on the game's Genex page does", async () => {
    const p = await profile();
    await pinnedCli(p);
    await writeFile(path.join(p.game, "package.json"), packageWith(DECLARED));
    await removeTree(path.join(p.genexStorage, "publish"));
    const sandbox = budgetSandbox();
    await assert.rejects(service(p, sandbox).run(budget("status"), bound(p), FREE), /no hosted Genex project/);
    assert.equal(sandbox.seen.length, 0);
  });

  const tooOld: Array<[string, string | null]> = [
    ["the release before it", "1.46.1"],
    ["an older release", "1.35.3"],
    ["a prerelease that may predate it", "1.46.2-dev.4"],
    ["a version that does not read as one", "next"],
    ["a CLI whose package cannot be read", null],
  ];
  for (const [name, version] of tooOld) {
    it(`says so, and runs nothing, when the pinned CLI is ${name}`, async () => {
      const p = await profile();
      await pinnedCli(p, version);
      await writeFile(path.join(p.game, "package.json"), packageWith(DECLARED));
      const before = await tree(p.gamesRoot);
      const sandbox = budgetSandbox();
      const cli = service(p, sandbox);
      const refused = (error: unknown) => {
        assert.ok(error instanceof GenexCliRefusal, String(error));
        assert.equal(error.code, GenexCliRefusalCode.Unavailable);
        assert.match(error.message, /cannot declare an AI budget yet/);
        assert.match(error.message, /after an update of Genex/);
        assert.match(error.message, /Unreal editor/);
        return true;
      };
      await assert.rejects(cli.run(budget("status"), bound(p), FREE), refused);
      await assert.rejects(cli.preflight(budget("set"), bound(p), PAID), refused, "nobody is asked");
      await assert.rejects(cli.run(budget("clear"), bound(p), PAID), refused);
      assert.equal(sandbox.seen.length, 0, "nothing ran");
      assert.deepEqual(await tree(p.gamesRoot), before);
      assert.deepEqual(await readdir(path.join(p.userData, "genex-cli")).catch(() => []), []);
    });
  }

  for (const version of ["1.46.2", "1.46.3", "1.47.0", "2.0.0"]) {
    it(`runs on pinned CLI ${version}`, async () => {
      const p = await profile();
      await pinnedCli(p, version);
      const sandbox = budgetSandbox();
      assert.equal((await service(p, sandbox).run(budget("status"), bound(p), FREE)).ok, true);
      assert.equal(sandbox.seen.length, 1);
    });
  }

  it("leaves every other command to a CLI older than the budget's", async () => {
    const p = await profile();
    await pinnedCli(p, "1.46.1");
    const sandbox = budgetSandbox();
    assert.equal((await service(p, sandbox).run({ command: "llm status" }, bound(p), FREE)).ok, true);
    assert.deepEqual(sandbox.folders, [{ package: null, settings: null }]);
  });

  // `genex llm calls` (the game's recent AI calls one by one, and why each failed) came with CLI
  // 1.46.4: an older pinned CLI does not know the word, so Studio says so instead of running it.
  const beforeCalls: Array<[string, string | null]> = [
    ["the release before it", "1.46.3"],
    ["a prerelease that may predate it", "1.46.4-dev.1"],
    ["a version that does not read as one", "next"],
    ["a CLI whose package cannot be read", null],
  ];
  for (const [name, version] of beforeCalls) {
    it(`says the game's calls cannot be listed yet, and runs nothing, when the pinned CLI is ${name}`, async () => {
      const p = await profile();
      await pinnedCli(p, version);
      const sandbox = budgetSandbox();
      const refused = (error: unknown) => {
        assert.ok(error instanceof GenexCliRefusal, String(error));
        assert.equal(error.code, GenexCliRefusalCode.Unavailable);
        assert.match(error.message, /cannot list a game's AI calls yet/);
        assert.match(error.message, /after an update of Genex/);
        assert.match(error.message, /llm usage/);
        return true;
      };
      await assert.rejects(service(p, sandbox).run({ command: "llm calls" }, bound(p), FREE), refused);
      await assert.rejects(
        service(p, sandbox).run({ command: "llm calls", options: { failed: true, limit: 5 } }, bound(p), FREE),
        refused,
      );
      assert.equal(sandbox.seen.length, 0, "nothing ran");
      assert.deepEqual(await readdir(path.join(p.userData, "genex-cli")).catch(() => []), []);
    });
  }

  for (const version of ["1.46.4", "1.47.0", "2.0.0"]) {
    it(`lists the game's calls on pinned CLI ${version}`, async () => {
      const p = await profile();
      await pinnedCli(p, version);
      const sandbox = budgetSandbox();
      const answer = await service(p, sandbox).run(
        { command: "llm calls", options: { failed: true, limit: 5 } },
        bound(p),
        FREE,
      );
      assert.equal(answer.ok, true);
      const command = sandbox.seen[0]?.request.command ?? "";
      assert.ok(command.includes("'llm' 'calls' '--failed' '--limit' '5'"), command);
      assert.ok(command.endsWith("--no-auth --json"), command);
    });
  }

  it("leaves `llm usage` to a CLI older than the one that lists calls", async () => {
    const p = await profile();
    await pinnedCli(p, "1.46.3");
    const sandbox = budgetSandbox();
    assert.equal((await service(p, sandbox).run({ command: "llm usage" }, bound(p), FREE)).ok, true);
  });
});
