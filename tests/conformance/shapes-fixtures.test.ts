/**
 * The five shapes, guarded without an Electron in sight.
 *
 * `tests/fixtures/games` holds five games nobody wrote the studio's contract for. They are only
 * evidence while they stay that way: the moment one of them grows a `studio.json` with a
 * `contractVersion`, a CDN tag, or a second `installStudio`, it is testing the template again and
 * every claim this milestone makes about "any Three.js game" is quietly false. These are the
 * rules that keep them real, and they run in `npm test`, not only in the e2e — a renamed warning
 * or a drifted shape has to fail in seconds, on a laptop, with no window open.
 */
import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { GameWorkspaces, detectProjectShape } from "../../src/substrate/game-workspace.ts";
import { MAX_INPUT_ACTIONS, capActions } from "../../src/substrate/preview-input.ts";
import { normalizeGameTraits } from "../../src/harness-seed/loop/spec.ts";
import { inputProbesFor } from "../../src/harness-seed/loop/kinds.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { MACHINE_WARNINGS, missingWarnings, undeclaredWarnings } from "../../tests/e2e/warning-policy.ts";

const repo = path.resolve(import.meta.dirname, "../..");
const gamesDir = path.join(repo, "tests/fixtures/games");
const seedDir = path.join(repo, "src/harness-seed");

/** The six entries `ls tests/fixtures/games` must print — five games and the page of rules. */
const FIXTURE_IDS = ["bundled-ts", "esm-addons", "inline-raf", "menu-levels", "webgpu-field"] as const;

const MAX_SOURCE_LINES = 300;
const MAX_SOURCE_BYTES = 12 * 1024;
const MIN_README_PARAGRAPH = 200;
/** What a fixture must never carry: the studio's own scaffold, in any of its shapes. */
const SCAFFOLD = ["src/studio.js", "src/studio.d.ts", "docs/CONTRACT.md", "CLAUDE.md", "NOTES.md"];

interface FixtureManifest {
  version: number;
  id: string;
  title: string;
  proves: string[];
  shape: Record<string, unknown>;
  addsAtLeast: string[];
  neverAdded: string[];
  edits: "none" | "two-line-install";
  needsNodeModules: boolean;
  backend: "webgl" | "webgpu";
  game: Record<string, unknown>;
  setup: { gesture?: boolean; actions?: unknown[]; settleMs?: number; verify?: { path: string } } | null;
  cameras: string[];
  expectWarnings: string[];
  allowWarnings: string[];
  delta: Array<{ path: string; min: number }>;
  deterministic: boolean;
  readyBudgetMs: number;
}

async function manifestOf(id: string): Promise<FixtureManifest> {
  return JSON.parse(await readFile(path.join(gamesDir, id, "manifest.json"), "utf8")) as FixtureManifest;
}

/** Every file in a folder, project-relative, with git's bookkeeping and build output left out. */
async function filesIn(dir: string, rel = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") continue;
    const relative = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await filesIn(path.join(dir, entry.name), relative)));
    else found.push(relative);
  }
  return found.sort();
}

const isSource = (file: string): boolean => /\.(html|css|[cm]?js|[cm]?ts)$/.test(file);

/**
 * A URL that leaves the machine. The rule is not "no `https`" — a README may name one — it is
 * that no *source* file may, because a fixture that fetches anything is testing the network.
 */
function remoteUrls(text: string): string[] {
  return [...text.matchAll(/(?:https?:)?\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi)].map((m) => m[0]);
}

/** The `imports` keys of a page's own import map — the only way a browser reads a bare specifier. */
function importMapKeys(html: string): string[] {
  const block = /<script\b[^>]*\btype\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1];
  if (!block) return [];
  return Object.keys((JSON.parse(block) as { imports?: Record<string, unknown> }).imports ?? {});
}

/**
 * The state paths the kinds table's input probes name for this game, for the traits it declares.
 * `delta` entries have to be paths something actually measures; deriving them from
 * `inputProbesFor` rather than from a list in this file means the fixtures follow the kinds table
 * wherever it goes.
 */
function probePaths(game: unknown): Set<string> {
  const traits = normalizeGameTraits(game as never);
  const probes = inputProbesFor(game as never);
  const declared = [traits.mouseLook ? probes.look : null, traits.keyboardMove ? probes.move : null];
  const paths = new Set<string>();
  for (const probe of declared) {
    for (const match of String(probe?.expr ?? "").matchAll(/delta\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      paths.add(match[1]!);
    }
  }
  return paths;
}

async function seedText(): Promise<string> {
  const parts: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(target);
      else parts.push(await readFile(target, "utf8").catch(() => ""));
    }
  };
  await walk(seedDir);
  return parts.join("\n");
}

function workspaces(base: string): GameWorkspaces {
  return new GameWorkspaces({
    root: path.join(base, "library"),
    templateDir: path.join(repo, "src", "game-template"),
    vendorDir: path.join(base, "vendor"),
    indexFile: path.join(base, "projects.json"),
    userData: path.join(base, "userData"),
    homeDir: base,
  });
}

describe("the five shapes", () => {
  it("is exactly five games and the page of rules", async () => {
    const entries = (await readdir(gamesDir)).sort();
    assert.deepEqual(entries, ["README.md", ...FIXTURE_IDS].sort());
  });

  it("carries a manifest at version 1 whose id is the folder", async () => {
    for (const id of FIXTURE_IDS) {
      const manifest = await manifestOf(id);
      assert.equal(manifest.version, 1, `${id}: manifest version`);
      assert.equal(manifest.id, id, `${id}: manifest id is the folder name`);
      assert.ok(manifest.title.length > 0, `${id}: a title`);
      assert.ok(manifest.proves.length >= 3, `${id}: what it proves, in sentences`);
      assert.equal(manifest.edits, "none", `${id}: a game owes the studio no edit`);
      assert.ok(["webgl", "webgpu"].includes(manifest.backend), `${id}: backend`);
      assert.ok(manifest.readyBudgetMs >= 1000 && manifest.readyBudgetMs <= 60_000, `${id}: ready budget`);
    }
  });

  it("says in its README's first paragraph what the shape proves — the paragraph adoption seeds NOTES.md from", async () => {
    for (const id of FIXTURE_IDS) {
      const readme = await readFile(path.join(gamesDir, id, "README.md"), "utf8");
      const paragraph = readme
        .split("\n\n")
        .map((block) => block.trim())
        .find((block) => block.length > 0 && !block.startsWith("#"));
      assert.ok(paragraph, `${id}: README has a paragraph`);
      assert.ok(
        paragraph.length >= MIN_README_PARAGRAPH,
        `${id}: first paragraph is ${paragraph.length} characters, wanted ${MIN_README_PARAGRAPH}`,
      );
    }
  });

  it("keeps every source file under the caps a fixture is read at", async () => {
    for (const id of FIXTURE_IDS) {
      for (const file of await filesIn(path.join(gamesDir, id))) {
        if (!isSource(file)) continue;
        const text = await readFile(path.join(gamesDir, id, file), "utf8");
        assert.ok(
          text.split("\n").length <= MAX_SOURCE_LINES,
          `${id}/${file}: ${text.split("\n").length} lines, cap ${MAX_SOURCE_LINES}`,
        );
        assert.ok(
          Buffer.byteLength(text) <= MAX_SOURCE_BYTES,
          `${id}/${file}: ${Buffer.byteLength(text)} bytes, cap ${MAX_SOURCE_BYTES}`,
        );
      }
    }
  });

  it("fetches nothing: no CDN tag, no remote import, in any source file", async () => {
    for (const id of FIXTURE_IDS) {
      for (const file of await filesIn(path.join(gamesDir, id))) {
        if (!isSource(file)) continue;
        const found = remoteUrls(await readFile(path.join(gamesDir, id, file), "utf8"));
        assert.deepEqual(found, [], `${id}/${file} reaches the network: ${found.join(", ")}`);
      }
    }
    // …and the guard is the kind that can fail: a CDN tag in a page is found.
    assert.deepEqual(
      remoteUrls('<script type="module" src="https://unpkg.com/three@0.185.1/build/three.module.js"></script>'),
      ["https://unpkg.com"],
    );
  });

  it("carries no studio scaffold, and above all no studio.json with a contractVersion", async () => {
    for (const id of FIXTURE_IDS) {
      const files = await filesIn(path.join(gamesDir, id));
      for (const scaffold of SCAFFOLD) {
        assert.ok(!files.includes(scaffold), `${id} carries the studio's ${scaffold}`);
      }
      const meta = await readFile(path.join(gamesDir, id, "studio.json"), "utf8").catch(() => null);
      if (meta !== null) {
        assert.ok(
          !("contractVersion" in (JSON.parse(meta) as Record<string, unknown>)),
          `${id}: studio.json carries contractVersion — detectProjectShape would read this folder as the template`,
        );
      }
      assert.notEqual(
        await detectProjectShape(path.join(gamesDir, id)),
        null,
        `${id} reads as the studio's own template`,
      );
    }
  });

  it("resolves every bare specifier through its own import map, unless it is bundled", async () => {
    for (const id of FIXTURE_IDS) {
      const manifest = await manifestOf(id);
      const html = await readFile(path.join(gamesDir, id, "index.html"), "utf8");
      const keys = importMapKeys(html);
      if (manifest.shape.build) {
        assert.deepEqual(keys, [], `${id} is bundled: its bare specifiers belong to the bundler`);
        continue;
      }
      assert.ok(
        keys.includes("three"),
        `${id}: a no-build own-shape game with no import map is a hard validation problem before its page loads`,
      );
    }
  });

  it("records the shape detectProjectShape actually answers", async () => {
    for (const id of FIXTURE_IDS) {
      const manifest = await manifestOf(id);
      assert.deepEqual(await detectProjectShape(path.join(gamesDir, id)), manifest.shape, `${id}: shape`);
    }
  });

  it("promises what adoption would add, as a relation and never as the template's file list", async () => {
    const base = await tmpDir("studio-shapes-");
    const games = workspaces(base);
    for (const id of FIXTURE_IDS) {
      const manifest = await manifestOf(id);
      const writes = await games.plannedWrites(path.join(gamesDir, id), { template: false });
      for (const file of manifest.addsAtLeast) {
        assert.ok(writes.includes(file), `${id}: adoption no longer writes ${file} (${writes.join(", ")})`);
      }
      for (const file of manifest.neverAdded) {
        assert.ok(!writes.includes(file), `${id}: adoption would write ${file} over the game's own`);
      }
    }
  });

  it("declares traits that survive normalizeGameTraits, and delta paths something measures", async () => {
    for (const id of FIXTURE_IDS) {
      const manifest = await manifestOf(id);
      const normalized = normalizeGameTraits(manifest.game) as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(manifest.game)) {
        if (typeof value !== "boolean") continue;
        assert.equal(normalized[key], value, `${id}: normalizeGameTraits dropped ${key}`);
      }
      assert.deepEqual(
        normalizeGameTraits(normalized) as unknown as Record<string, unknown>,
        normalized,
        `${id}: normalizeGameTraits does not round-trip`,
      );
      const measured = probePaths(manifest.game);
      for (const entry of manifest.delta) {
        assert.ok(entry.min > 0, `${id}: delta ${entry.path} needs a minimum worth measuring`);
        assert.ok(
          measured.has(entry.path),
          `${id}: nothing measures ${entry.path} for this kind (measured: ${[...measured].join(", ") || "nothing"})`,
        );
      }
    }
  });

  it("scripts a setup a preview can really replay", async () => {
    for (const id of FIXTURE_IDS) {
      const manifest = await manifestOf(id);
      if (!manifest.setup) continue;
      const actions = manifest.setup.actions ?? [];
      assert.ok(actions.length > 0 && actions.length <= MAX_INPUT_ACTIONS, `${id}: ${actions.length} setup actions`);
      assert.equal(capActions(actions).length, actions.length, `${id}: an action the preview would drop`);
      assert.ok(manifest.setup.verify?.path, `${id}: a setup with nothing to verify proves nothing landed`);
    }
  });

  it("names warnings the harness seed still says", async () => {
    const seed = await seedText();
    let asserted = 0;
    for (const id of FIXTURE_IDS) {
      const manifest = await manifestOf(id);
      for (const warning of [...manifest.expectWarnings, ...manifest.allowWarnings]) {
        assert.ok(seed.includes(warning), `${id}: no sentence in the harness seed contains "${warning}"`);
        asserted += 1;
      }
    }
    for (const warning of MACHINE_WARNINGS)
      assert.ok(seed.includes(warning), `the tolerated "${warning}" is no longer a sentence the harness writes`);
    assert.ok(asserted > 0, "no fixture expects a warning — the guard would never fail");
    assert.ok(
      !seed.includes("the page shows UI the compositor does not"),
      "the guard is a substring match, not a grep for anything",
    );
  });

  /**
   * `expectWarnings` was a positive list and nothing bounded the other side: four of the five
   * manifests said `[]`, which reads as "this game warns about nothing" and asserted nothing at
   * all. The e2e now fails on any warning no list names, and these are the rules that guard the
   * policy itself — every fixture declares both lists, and a warning that appears out of nowhere
   * is undeclared for a fixture whose lists are empty.
   */
  it("bounds warnings from above: every fixture declares both lists and an unnamed warning is undeclared", async () => {
    for (const id of FIXTURE_IDS) {
      const manifest = await manifestOf(id);
      assert.ok(Array.isArray(manifest.expectWarnings), `${id}: expectWarnings must be a list`);
      assert.ok(Array.isArray(manifest.allowWarnings), `${id}: allowWarnings must be a list, even an empty one`);
      const invented = "this game paints its HUD in the margins of the page";
      assert.deepEqual(
        undeclaredWarnings([invented], manifest),
        [invented],
        `${id}: a warning no list names has to be undeclared`,
      );
      assert.deepEqual(undeclaredWarnings([], manifest), []);
      assert.deepEqual(
        missingWarnings(manifest.expectWarnings, manifest),
        [],
        `${id}: its own expected warnings satisfy it`,
      );
      assert.deepEqual(
        missingWarnings([], manifest),
        manifest.expectWarnings,
        `${id}: a run that warned about nothing is missing everything the fixture expects`,
      );
    }
  });

  it("tolerates the slow-boot warning and nothing else a fixture did not name", async () => {
    const menu = await manifestOf("menu-levels");
    const slow = "the page took 7.4 s to report itself ready — every pass of the run pays that boot";
    assert.deepEqual(undeclaredWarnings([slow], menu), [], "a slow machine is not a failing game");
    assert.deepEqual(
      undeclaredWarnings(
        ["this game paints UI outside the canvas (div#hud) — user:view shows it, the canvas frames do not"],
        menu,
      ),
      [],
      "the warning it names, with the numbers a real run carries",
    );
    const strict = { expectWarnings: [], allowWarnings: [] };
    assert.deepEqual(undeclaredWarnings([slow], strict), []);
    assert.equal(undeclaredWarnings(["a full-screen overlay covers the game (div#menu)"], strict).length, 1);
    // What a permissive list buys, and only that.
    assert.deepEqual(
      undeclaredWarnings(["a full-screen overlay covers the game (div#menu)"], {
        expectWarnings: [],
        allowWarnings: ["a full-screen overlay covers the game"],
      }),
      [],
    );
  });

  it("is the kind of guard that fails: a contractVersion, a CDN tag and a drifted shape are each caught", async () => {
    const base = await tmpDir("studio-shapes-bad-");

    // (1) a fixture that gains a studio.json with contractVersion reads as the studio's template.
    const scaffolded = path.join(base, "scaffolded");
    await cp(path.join(gamesDir, "inline-raf"), scaffolded, { recursive: true });
    await writeFile(
      path.join(scaffolded, "studio.json"),
      `${JSON.stringify({ name: "sweep", title: "Sweep", contractVersion: 1 })}\n`,
    );
    assert.equal(
      await detectProjectShape(scaffolded),
      null,
      "a contractVersion beside the vendored map is the template",
    );

    // (2) a fixture that gains a CDN script tag.
    const remote = path.join(base, "remote");
    await mkdir(remote, { recursive: true });
    const page = await readFile(path.join(gamesDir, "inline-raf/index.html"), "utf8");
    await writeFile(
      path.join(remote, "index.html"),
      page.replace(
        '<script type="importmap">',
        '<script src="https://cdn.jsdelivr.net/npm/three"></script>\n<script type="importmap">',
      ),
    );
    assert.deepEqual(remoteUrls(await readFile(path.join(remote, "index.html"), "utf8")), ["https://cdn.jsdelivr.net"]);

    // (3) a shape that drifted: the same page with a build script is no longer three-modules.
    const built = path.join(base, "built");
    await cp(path.join(gamesDir, "inline-raf"), built, { recursive: true });
    await writeFile(
      path.join(built, "package.json"),
      `${JSON.stringify({ name: "sweep", scripts: { build: "vite build" } })}\n`,
    );
    const drifted = await detectProjectShape(built);
    assert.notDeepEqual(drifted, (await manifestOf("inline-raf")).shape, "a drifted shape is not the recorded one");
    assert.equal(drifted!.kind, "three-vite");
  });
});

describe("the fixture tree stays out of the studio's way", () => {
  it("is excluded from the repository's typecheck: these are games of their own, not the studio's code", async () => {
    const config = JSON.parse(await readFile(path.join(repo, "tsconfig.json"), "utf8")) as { exclude?: string[] };
    assert.ok(config.exclude?.includes("tests/fixtures/games"), "tsconfig excludes the fixture games");
    assert.ok(
      config.exclude?.includes("node_modules"),
      "exclude replaces TypeScript's default list, so node_modules has to be named again",
    );
  });

  it("needs no install of its own: only the bundled fixture wants node_modules, and it is linked, never fetched", async () => {
    for (const id of FIXTURE_IDS) {
      const manifest = await manifestOf(id);
      assert.equal(manifest.needsNodeModules, id === "bundled-ts", `${id}: needsNodeModules`);
      const files = await filesIn(path.join(gamesDir, id));
      assert.ok(
        !files.some((file) => /(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock)$/.test(file)),
        `${id}: a lockfile`,
      );
    }
    // The one fixture with a package.json builds with what this repository already installs.
    const pkg = JSON.parse(await readFile(path.join(gamesDir, "bundled-ts/package.json"), "utf8")) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const repoPkg = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8")) as {
      devDependencies?: Record<string, string>;
    };
    assert.ok(pkg.scripts?.build, "bundled-ts declares a build script");
    for (const name of Object.keys(pkg.devDependencies ?? {})) {
      assert.ok(repoPkg.devDependencies?.[name], `bundled-ts wants ${name}, which this repository does not install`);
    }
    assert.ok(
      !("vite" in (pkg.devDependencies ?? {})),
      "three-vite is the studio's word for the bundled shape, not a claim vite is installed",
    );
  });
});
