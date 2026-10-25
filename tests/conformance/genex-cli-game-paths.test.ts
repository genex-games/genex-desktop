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
import { GenexCliRefusal, GenexCliRefusalCode } from "../../src/main/core/genex-cli-policy.ts";
import { GenexPackageService } from "../../src/main/core/genex-package.ts";
import type { PluginBinding } from "../../src/shared/plugins.ts";
import { PluginHostTool } from "../../src/shared/plugins.ts";
import type { RunRequest, RunResult } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

const ITEM = "sku_phoenix";
const PICTURE = "PNG-frost-axe";
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
    for (const flag of ["image", "model", "package"]) {
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
  options: { price: 1200, ...options },
});
/** A change to a listed item takes the same files, and the person approves it on a card. */
const shopSet = (options: Record<string, unknown>) => ({ command: "shop set", args: ITEM, options });
// A new item's draft runs through the free tool: it asks nobody (`genex-cli-policy.ts`).
const FREE = { paid: false };
const PAID = { paid: true };

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
    assert.equal(run.named.image, PICTURE);
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
    ["shop add without files", shopAdd({}), API_ONLY],
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
