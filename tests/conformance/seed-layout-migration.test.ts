/**
 * The harness workspace's one-time move from the JavaScript layout (`loop/*.mjs`, every install
 * from before the harness was TypeScript) to the TypeScript one — without losing an edit the agent
 * made to its own code (substrate/seed-upgrade.ts `migrateHarnessLayout`, and the boot that runs
 * it only after a validation fork of the migrated self has booted, RecoveryService).
 *
 * The older vintage is built from today's seed: every module type-stripped to JavaScript, renamed
 * `.mjs`, with `.mjs` import specifiers — the shape every such install has — so it really boots.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LAYOUT_MEMORY_KEY } from "../../src/main/core/recovery.ts";
import { applySeed, layoutMigrationPending, migrateHarnessLayout } from "../../src/substrate/seed-upgrade.ts";
import { pathExists } from "../../src/substrate/fsx.ts";
import { studioActivity } from "../../src/shared/studio-activity.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { makeResources } from "../helpers/resources.ts";
import { tmpDir } from "../helpers/tmp.ts";

const shipped = fileURLToPath(new URL("../../src/harness-seed", import.meta.url));
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"'\n]+)\.ts\2/g;

async function files(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await files(dir, child)));
    else out.push(child);
  }
  return out;
}

/**
 * Today's seed as the JavaScript layout had it: `.mjs` modules, `.mjs` specifiers, no types.
 * `without`: modules the TypeScript seed added, which that vintage never shipped.
 */
async function javascriptSeed(root: string, without: readonly string[] = []): Promise<string> {
  const older = path.join(root, "older-seed");
  await cp(shipped, older, { recursive: true });
  for (const rel of without) await rm(path.join(older, rel));
  await rm(path.join(older, "types"), { recursive: true, force: true });
  await rm(path.join(older, "tsconfig.json"), { force: true });
  for (const rel of await files(older)) {
    if (!rel.endsWith(".ts") || !/^(loop|tools|memory)\//.test(rel)) continue;
    const source = await readFile(path.join(older, rel), "utf8");
    const js = stripTypeScriptTypes(source).replace(
      SPECIFIER,
      (_whole, lead: string, quote: string, stem: string) => `${lead}${quote}${stem}.mjs${quote}`,
    );
    await writeFile(path.join(older, rel.replace(/\.ts$/, ".mjs")), js);
    await rm(path.join(older, rel));
  }
  return older;
}

const EDIT = "\n// the agent's own change to its turn loop\n";
const TOOL =
  'import { clip } from "../loop/text.mjs";\nexport const tools = [{ name: "keep", description: "d", parameters: { type: "object", properties: {} }, async execute() { return clip("a durable fact", 40); } }];\n';

/** An install seeded from the JavaScript vintage, then edited by its agent: one edit, one deletion, one tool of its own. */
async function javascriptInstall(
  ws: string,
  manifest: string,
  root: string,
  without: readonly string[] = [],
): Promise<{ older: string; edited: string }> {
  const older = await javascriptSeed(root, without);
  assert.equal((await applySeed({ seedDir: older, workspaceDir: ws, manifestFile: manifest })).mode, "seeded");
  const edited = `${await readFile(path.join(ws, "loop", "turn-loop.mjs"), "utf8")}${EDIT}`;
  await writeFile(path.join(ws, "loop", "turn-loop.mjs"), edited);
  await rm(path.join(ws, "tools", "cover-tools.mjs"));
  await writeFile(path.join(ws, "tools", "keep-tools.mjs"), TOOL);
  return { older, edited };
}

/**
 * What an older build of the app does to a migrated workspace: its crash-recovery reseed lays its
 * seed over the files, and it rewrites the manifest knowing nothing of layouts.
 */
async function downgrade(ws: string, manifest: string, older: string): Promise<void> {
  const body = JSON.parse(await readFile(manifest, "utf8")) as {
    files: Record<string, string>;
    retired?: Record<string, string>;
  };
  await cp(older, ws, { recursive: true, force: true });
  for (const rel of await files(older))
    body.files[rel] = createHash("sha256")
      .update(await readFile(path.join(older, rel)))
      .digest("hex");
  await writeFile(manifest, JSON.stringify({ files: body.files, ...(body.retired ? { retired: body.retired } : {}) }));
}

async function importMain(ws: string, file: string): Promise<{ createStudio?: unknown }> {
  return (await import(`${pathToFileURL(path.join(ws, "loop", file)).href}?v=${Date.now()}`)) as {
    createStudio?: unknown;
  };
}

describe("seed upgrade across the move to TypeScript", () => {
  async function setup(without: readonly string[] = []) {
    const root = await tmpDir("seed-layout-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    const updates = path.join(root, "updates");
    await mkdir(updates, { recursive: true });
    const install = await javascriptInstall(ws, manifest, root, without);
    // The seed this build ships, as a copy the test may compare against.
    const seed = path.join(root, "seed");
    await cp(shipped, seed, { recursive: true });
    return { root, ws, manifest, updates, seed, ...install };
  }

  it("holds the TypeScript modules back while the workspace still runs its JavaScript, which keeps booting", async () => {
    const { ws, manifest, updates, seed } = await setup();
    const report = await applySeed({
      seedDir: seed,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(updates, "seed-backup-1"),
      updatesDir: updates,
    });

    const deferred = report.deferred ?? [];
    assert.ok(deferred.includes("loop/main.ts") && deferred.includes("loop/turn-loop.ts"));
    assert.ok(deferred.includes("tools/cover-tools.ts"), "the agent's deletion is the migration's to carry over");
    assert.equal(
      await pathExists(path.join(ws, "loop", "main.ts")),
      false,
      "no main.ts to shadow the agent's edited loop",
    );
    assert.ok(
      report.added.includes("types/host-api.d.ts") && report.added.includes("tsconfig.json"),
      "files with no JavaScript predecessor still arrive",
    );
    assert.equal(typeof (await importMain(ws, "main.mjs")).createStudio, "function", "the JavaScript self still loads");
    assert.ok(await layoutMigrationPending({ seedDir: seed, workspaceDir: ws, manifestFile: manifest }));
  });

  it("removes untouched modules, keeps edited ones as TypeScript, carries deletions and repoints specifiers", async () => {
    const { ws, manifest, updates, edited, seed } = await setup();
    await applySeed({
      seedDir: seed,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(updates, "seed-backup-1"),
      updatesDir: updates,
    });
    const report = await migrateHarnessLayout({
      seedDir: seed,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(updates, "seed-backup-2"),
      updatesDir: updates,
    });

    assert.ok(report.removed.includes("loop/main.mjs"));
    assert.deepEqual(report.renamed, ["loop/turn-loop.ts"]);
    assert.deepEqual(report.deleted, ["tools/cover-tools.ts"]);
    assert.deepEqual(report.stranded, []);
    assert.ok(report.rewritten.includes("tools/keep-tools.mjs") && report.rewritten.includes("loop/turn-loop.ts"));

    // Untouched: the shipped TypeScript, the JavaScript backed up as a seed vintage.
    assert.equal(
      await readFile(path.join(ws, "loop", "main.ts"), "utf8"),
      await readFile(path.join(seed, "loop", "main.ts"), "utf8"),
    );
    assert.equal(await pathExists(path.join(ws, "loop", "main.mjs")), false);
    assert.ok(await pathExists(path.join(updates, "seed-backup-2", "loop", "main.mjs")));
    // Edited: the agent's content, specifiers now naming the modules that exist.
    const kept = await readFile(path.join(ws, "loop", "turn-loop.ts"), "utf8");
    assert.ok(kept.endsWith(EDIT), "the agent's edit survives the rename");
    assert.equal(kept, edited.replace(/(["'])(\.{1,2}\/[^"'\n]+)\.mjs\1/g, "$1$2.ts$1"), "only the specifiers changed");
    assert.equal(
      await readFile(path.join(updates, "harness-edits-2", "loop", "turn-loop.mjs"), "utf8"),
      edited,
      "the original is backed up outside the seed vintages",
    );
    assert.equal(await pathExists(path.join(ws, "tools", "cover-tools.ts")), false, "deleted stays deleted");
    assert.match(
      await readFile(path.join(ws, "tools", "keep-tools.mjs"), "utf8"),
      /from "\.\.\/loop\/text\.ts"/,
      "the agent's own tool follows the move",
    );
    assert.equal((await readdir(path.join(ws, "loop"))).filter((name) => name.endsWith(".mjs")).length, 0);
    assert.equal(JSON.parse(await readFile(manifest, "utf8")).layoutVersion, 2);

    // The migrated self loads, and the next upgrade keeps what the migration decided.
    assert.equal(typeof (await importMain(ws, "main.ts")).createStudio, "function");
    const next = await applySeed({
      seedDir: seed,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(updates, "seed-backup-3"),
      updatesDir: updates,
    });
    assert.ok(next.kept.includes("loop/turn-loop.ts") && next.kept.includes("tools/cover-tools.ts"));
    assert.equal(next.deferred, undefined);
    assert.equal(await readFile(path.join(ws, "loop", "turn-loop.ts"), "utf8"), kept);
    assert.equal(await layoutMigrationPending({ seedDir: seed, workspaceDir: ws, manifestFile: manifest }), null);
  });

  it("migrates again after a rewind to a snapshot from before the move", async () => {
    const { ws, manifest, updates, older, edited, seed } = await setup();
    const options = { seedDir: seed, workspaceDir: ws, manifestFile: manifest, updatesDir: updates };
    await applySeed({ ...options, backupDir: path.join(updates, "seed-backup-1") });
    await migrateHarnessLayout({ ...options, backupDir: path.join(updates, "seed-backup-2") });

    // What a restore of the older snapshot does: the JavaScript files are back, the TypeScript gone.
    await cp(path.join(older, "loop", "main.mjs"), path.join(ws, "loop", "main.mjs"));
    await writeFile(path.join(ws, "loop", "turn-loop.mjs"), edited);
    await rm(path.join(ws, "loop", "main.ts"));
    await rm(path.join(ws, "loop", "turn-loop.ts"));

    const upgrade = await applySeed({ ...options, backupDir: path.join(updates, "seed-backup-3") });
    assert.ok(upgrade.deferred?.includes("loop/main.ts"), "not read as the agent deleting main.ts");
    assert.ok(await layoutMigrationPending(options));
    const again = await migrateHarnessLayout({ ...options, backupDir: path.join(updates, "seed-backup-4") });
    assert.deepEqual([again.removed, again.renamed], [["loop/main.mjs"], ["loop/turn-loop.ts"]]);
    assert.equal(
      await readFile(path.join(ws, "loop", "main.ts"), "utf8"),
      await readFile(path.join(seed, "loop", "main.ts"), "utf8"),
    );
    assert.ok((await readFile(path.join(ws, "loop", "turn-loop.ts"), "utf8")).endsWith(EDIT));
  });

  it("migrates again after a rewind to a snapshot from before the upgrade, bringing back the files that tree never had", async () => {
    // Modules the TypeScript seed split out of the JavaScript ones, which that vintage never had.
    const newModules = ["loop/git.ts", "loop/health-check.ts", "loop/config.ts"];
    const { root, ws, manifest, updates, seed } = await setup(newModules);
    const options = { seedDir: seed, workspaceDir: ws, manifestFile: manifest, updatesDir: updates };
    // The JavaScript self exactly as it ran before the app update: no git.ts, no types/, no tsconfig.
    const preUpgrade = path.join(root, "pre-upgrade");
    await cp(ws, preUpgrade, { recursive: true });
    await applySeed({ ...options, backupDir: path.join(updates, "seed-backup-1") });
    await migrateHarnessLayout({ ...options, backupDir: path.join(updates, "seed-backup-2") });

    // A restore of that snapshot (reset --hard, clean): the upgrade's own files go with it.
    await rm(ws, { recursive: true, force: true });
    await cp(preUpgrade, ws, { recursive: true });
    const introduced = [...newModules, "types/harness.d.ts", "types/host-api.d.ts", "tsconfig.json"];
    for (const rel of introduced)
      assert.equal(await pathExists(path.join(ws, rel)), false, `${rel} is not in the restored tree`);

    const upgrade = await applySeed({ ...options, backupDir: path.join(updates, "seed-backup-3") });
    assert.deepEqual(
      upgrade.kept.filter((rel) => introduced.includes(rel)),
      [],
      "not reported as the agent's deletions",
    );
    assert.ok(await layoutMigrationPending(options));
    const again = await migrateHarnessLayout({ ...options, backupDir: path.join(updates, "seed-backup-4") });
    for (const rel of introduced) {
      assert.equal(
        await readFile(path.join(ws, rel), "utf8"),
        await readFile(path.join(seed, rel), "utf8"),
        `${rel}: not the agent's deletion, the tree never had it`,
      );
    }
    assert.deepEqual(again.restored, [...introduced].sort());
    assert.deepEqual(again.deleted, [], "the agent's deletion from before the upgrade is carried as it was");
    assert.equal(await pathExists(path.join(ws, "tools", "cover-tools.ts")), false);
    assert.ok((await readFile(path.join(ws, "loop", "turn-loop.ts"), "utf8")).endsWith(EDIT));
    assert.equal(typeof (await importMain(ws, "main.ts")).createStudio, "function", "the migrated self loads");
  });

  it("replaces an edited tools/index.mjs, which could load only JavaScript tools, and backs the edit up", async () => {
    const { ws, manifest, updates, seed } = await setup();
    const options = { seedDir: seed, workspaceDir: ws, manifestFile: manifest, updatesDir: updates };
    const index = path.join(ws, "tools", "index.mjs");
    const edited = `${await readFile(index, "utf8")}\n// the agent's own change to its tool registry\n`;
    await writeFile(index, edited);
    await applySeed({ ...options, backupDir: path.join(updates, "seed-backup-1") });
    const report = await migrateHarnessLayout({ ...options, backupDir: path.join(updates, "seed-backup-2") });

    assert.deepEqual(report.replaced, ["tools/index.mjs"]);
    assert.ok(!report.renamed.includes("tools/index.ts"));
    assert.equal(
      await readFile(path.join(ws, "tools", "index.ts"), "utf8"),
      await readFile(path.join(seed, "tools", "index.ts"), "utf8"),
    );
    assert.equal(await pathExists(index), false);
    assert.equal(
      await readFile(path.join(updates, "harness-edits-2", "tools", "index.mjs"), "utf8"),
      edited,
      "the edit is recoverable",
    );
    const registry = (await import(`${pathToFileURL(path.join(ws, "tools", "index.ts")).href}?v=${Date.now()}`)) as {
      loadToolModules(ws: string): Promise<{ modules: Array<{ name: string }>; broken: unknown[] }>;
    };
    const { modules, broken } = await registry.loadToolModules(ws);
    const shippedTools = (await readdir(path.join(seed, "tools"))).filter(
      (name) => name.endsWith(".ts") && name !== "index.ts" && name !== "cover-tools.ts",
    );
    assert.deepEqual(broken, []);
    for (const name of shippedTools)
      assert.ok(
        modules.some((module) => module.name === name),
        `${name} is registered`,
      );
    assert.equal(await layoutMigrationPending(options), null);
  });

  it("notices a workspace an older build of the app ran after the move", async () => {
    const { ws, manifest, updates, seed, older } = await setup();
    const options = { seedDir: seed, workspaceDir: ws, manifestFile: manifest, updatesDir: updates };
    await applySeed({ ...options, backupDir: path.join(updates, "seed-backup-1") });
    await migrateHarnessLayout({ ...options, backupDir: path.join(updates, "seed-backup-2") });
    assert.equal(
      (await applySeed({ ...options, backupDir: path.join(updates, "seed-backup-3") })).downgraded,
      undefined,
    );

    // What the older build leaves behind: its manifest (it knows nothing of layouts) and its seed.
    await downgrade(ws, manifest, older);
    const upgrade = await applySeed({ ...options, backupDir: path.join(updates, "seed-backup-4") });
    assert.equal(upgrade.downgraded, true);
    assert.equal(
      (await applySeed({ ...options, backupDir: path.join(updates, "seed-backup-5") })).downgraded,
      undefined,
      "said once",
    );
  });

  it("leaves an edited module beside a TypeScript file of the same name, which wins", async () => {
    const { ws, manifest, updates, seed } = await setup();
    const options = { seedDir: seed, workspaceDir: ws, manifestFile: manifest, updatesDir: updates };
    await writeFile(path.join(ws, "loop", "turn-loop.ts"), "// the agent already wrote a TypeScript turn loop\n");
    const report = await migrateHarnessLayout({ ...options, backupDir: path.join(updates, "seed-backup-1") });
    assert.deepEqual(report.stranded, ["loop/turn-loop.mjs"]);
    assert.equal(
      await readFile(path.join(ws, "loop", "turn-loop.ts"), "utf8"),
      "// the agent already wrote a TypeScript turn loop\n",
    );
    assert.ok(
      (await readFile(path.join(updates, "harness-edits-1", "loop", "turn-loop.mjs"), "utf8")).endsWith(EDIT),
      "the unused edit is backed up",
    );
    assert.equal(await pathExists(path.join(ws, "loop", "turn-loop.mjs")), false);
    assert.equal(await layoutMigrationPending(options), null, "nothing is left to migrate at every launch");
  });

  it("treats a pre-manifest install as the app's throughout", async () => {
    const root = await tmpDir("seed-layout-premanifest-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    const seed = path.join(root, "seed");
    await cp(shipped, seed, { recursive: true });
    await cp(await javascriptSeed(root), ws, { recursive: true });
    await writeFile(
      path.join(ws, "loop", "turn-loop.mjs"),
      `${await readFile(path.join(ws, "loop", "turn-loop.mjs"), "utf8")}${EDIT}`,
    );
    await applySeed({
      seedDir: seed,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(root, "seed-backup-1"),
    });
    const report = await migrateHarnessLayout({
      seedDir: seed,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(root, "seed-backup-2"),
    });
    assert.deepEqual(report.renamed, [], "an install from before the manifest predates every self-edit");
    assert.equal(
      await readFile(path.join(ws, "loop", "turn-loop.ts"), "utf8"),
      await readFile(path.join(seed, "loop", "turn-loop.ts"), "utf8"),
    );
  });
});

describe("the boot that migrates", () => {
  /** A core whose userData already holds a JavaScript install, as an app update finds it. */
  async function javascriptCore(options: { resources?: string; mainTail?: string } = {}) {
    const lite = await coreLite({ init: false, ...(options.resources ? { resources: options.resources } : {}) });
    const manifest = path.join(lite.userData, "harness-seed-manifest.json");
    const install = await javascriptInstall(lite.core.layout.harnessWs, manifest, path.dirname(lite.userData));
    if (options.mainTail)
      await writeFile(
        path.join(lite.core.layout.harnessWs, "loop", "main.mjs"),
        `${await readFile(path.join(lite.core.layout.harnessWs, "loop", "main.mjs"), "utf8")}${options.mainTail}`,
      );
    await lite.core.init();
    return { ...lite, manifest, ...install };
  }

  const migrations = async (lite: {
    core: { listAllEvents(): Promise<Array<{ data: { type: string; event_type?: string; payload?: unknown } }>> };
  }) =>
    (await lite.core.listAllEvents())
      .filter((event) => event.data.type === "custom" && event.data.event_type === "harness_layout_migrated")
      .map((event) => event.data.payload as Record<string, unknown>);

  it("moves the workspace to TypeScript once a fork of it has booted, keeps the agent's edit, and reports its type errors", async () => {
    const lite = await javascriptCore();
    await lite.core.start();
    assert.equal(lite.core.host.state, "ready");
    const ws = lite.core.layout.harnessWs;
    assert.ok(await pathExists(path.join(ws, "loop", "main.ts")));
    assert.equal(await pathExists(path.join(ws, "loop", "main.mjs")), false);
    assert.ok((await readFile(path.join(ws, "loop", "turn-loop.ts"), "utf8")).endsWith(EDIT));

    const [payload, ...more] = await migrations(lite);
    assert.equal(more.length, 0);
    assert.equal(payload!.ok, true);
    assert.deepEqual(payload!.renamed, ["loop/turn-loop.ts"]);
    // Type-stripped JavaScript is not strict TypeScript: the agent hears about it, the boot does not wait.
    assert.match(String(payload!.typeErrors), /loop\/turn-loop\.ts\(\d+,\d+\): error TS/);
    const reasons = lite.core.snapshotIndex
      .all()
      .filter((record) => record.healthy)
      .map((record) => record.reason);
    assert.ok(reasons.includes("after harness layout migration"), "the migrated self booted live: a rewind target");
    assert.ok(
      !reasons.includes("before harness layout migration"),
      "the self before it never booted in this test: no rewind target",
    );
    const card = studioActivity((await lite.core.listAllEvents()) as never).find(
      (item) => item.title === "App update moved Studio’s code to TypeScript",
    );
    assert.ok(card?.attention && /Type errors to fix/.test(card.detail));
    const memory = (await lite.core.store.readArtifact<Record<string, string>>(lite.core.mainThread, "memory")) ?? {};
    assert.match(
      memory[LAYOUT_MEMORY_KEY] ?? "",
      /Your edited loop\/turn-loop\.ts kept their content and still run, but have \d+ type errors/,
      "the agent hears it in every prompt",
    );

    // Done once: the next launch finds nothing to migrate.
    await lite.core.host.stop();
    await lite.core.start();
    assert.equal((await migrations(lite)).length, 1);
  });

  it("keeps the JavaScript tree running when the migrated copy does not start, and retries only once something changed", async () => {
    // An edit only the JavaScript layout satisfies: a specifier no rewrite can see.
    const tail = '\nconst probe = "./turn-loop" + ".mjs";\nawait import(probe);\n';
    const resources = await makeResources();
    const lite = await javascriptCore({ resources, mainTail: tail });
    await lite.core.start();
    assert.equal(lite.core.host.state, "ready", "the bootstrap's fallback boots the JavaScript self");
    const ws = lite.core.layout.harnessWs;
    assert.ok(await pathExists(path.join(ws, "loop", "main.mjs")));
    assert.equal(await pathExists(path.join(ws, "loop", "main.ts")), false, "the live workspace was never migrated");
    assert.ok((await readFile(path.join(ws, "loop", "turn-loop.mjs"), "utf8")).endsWith(EDIT));
    const [failed] = await migrations(lite);
    assert.equal(failed!.ok, false);
    assert.match(String(failed!.error), /did not start/);
    assert.ok(
      studioActivity((await lite.core.listAllEvents()) as never).some(
        (item) => item.attention && /could not move Studio’s code to TypeScript/.test(item.title),
      ),
    );

    // The same seed and the same modules: not tried again at every launch.
    await lite.core.host.stop();
    await lite.core.start();
    assert.equal((await migrations(lite)).length, 1);

    // The next app update is a new attempt.
    const operating = path.join(resources, "harness-seed", "prompts", "operating-rules.md");
    await writeFile(operating, `${await readFile(operating, "utf8")}\n<!-- next update -->\n`);
    await lite.core.host.stop();
    await lite.core.init();
    await lite.core.start();
    assert.equal((await migrations(lite)).length, 2);
    assert.equal(lite.core.host.state, "ready");
  });

  const customEvents = async (
    lite: {
      core: { listAllEvents(): Promise<Array<{ data: { type: string; event_type?: string; payload?: unknown } }>> };
    },
    name: string,
  ) =>
    (await lite.core.listAllEvents()).filter((event) => event.data.type === "custom" && event.data.event_type === name);

  it("rewinds to the last self that ran when neither the migrated copy nor the edited JavaScript starts, instead of reseeding", async () => {
    const resources = await makeResources();
    const lite = await javascriptCore({ resources });
    const ws = lite.core.layout.harnessWs;
    const good = await lite.core.snapshot("harness", "the self that ran", undefined, true);
    // The last session's edit, never booted: the app was quit before a restart tried it.
    const main = path.join(ws, "loop", "main.mjs");
    const ran = await readFile(main, "utf8");
    await writeFile(main, `${ran}\nthrow new Error("broken at load");\n`);
    // Then the app updates: a new seed, applied over what that session left.
    const operating = path.join(resources, "harness-seed", "prompts", "operating-rules.md");
    await writeFile(operating, `${await readFile(operating, "utf8")}\n<!-- next update -->\n`);
    await lite.core.init();
    await lite.core.start();

    assert.equal(lite.core.host.state, "ready");
    for (const reason of ["seed upgrade baseline", "before harness layout migration"]) {
      const record = lite.core.snapshotIndex.all().findLast((entry) => entry.reason === reason);
      assert.ok(record, `${reason}: the self as it was is still snapshotted`);
      assert.notEqual(record.healthy, true, `${reason}: code that never booted is no rewind target`);
    }
    const restored = (await lite.core.listAllEvents()).find((event) => event.data.type === "workspace_restored");
    assert.equal(
      (restored?.data as { snapshot_id?: string } | undefined)?.snapshot_id,
      good.snapshot_id,
      "the rewind lands on the self that ran",
    );
    assert.equal(
      (await customEvents(lite, "harness_reseeded")).length,
      0,
      "the agent's last good self is not thrown away",
    );
    assert.equal(await readFile(main, "utf8"), ran);
  });

  it("falls back to the JavaScript tree when the migrated self starts in its trial copy but not live", async () => {
    // An edit whose migrated copy runs only inside the validation fork.
    const tail =
      '\nif (new URL(import.meta.url).pathname.endsWith(".ts") && !import.meta.url.includes("/layout-migration/")) throw new Error("only in the trial");\n';
    const lite = await javascriptCore({ mainTail: tail });
    await lite.core.snapshot("harness", "the self that ran", undefined, true);
    await lite.core.start();

    assert.equal(lite.core.host.state, "ready");
    const ws = lite.core.layout.harnessWs;
    assert.ok(await pathExists(path.join(ws, "loop", "main.mjs")), "the JavaScript self runs again");
    assert.equal(await pathExists(path.join(ws, "loop", "main.ts")), false);
    const after = lite.core.snapshotIndex.all().find((record) => record.reason === "after harness layout migration");
    assert.notEqual(after?.healthy, true, "the migrated self did not start live, so it is no rewind target");
    const [moved, failed, ...more] = await migrations(lite);
    assert.deepEqual([moved!.ok, failed!.ok, more.length], [true, false, 0]);
    assert.match(String(failed!.error), /did not start/);
    assert.equal((await customEvents(lite, "harness_reseeded")).length, 0);

    // Not tried again unchanged at every launch.
    await lite.core.host.stop();
    await lite.core.start();
    assert.equal((await migrations(lite)).length, 2);
    assert.equal(lite.core.host.state, "ready");
  });

  it("says so when an older build of the app ran the workspace after the move, naming the edits it made meanwhile", async () => {
    const lite = await javascriptCore();
    await lite.core.start();
    await lite.core.host.stop();
    const ws = lite.core.layout.harnessWs;
    await downgrade(ws, lite.manifest, lite.older);
    const turnLoop = path.join(ws, "loop", "turn-loop.mjs");
    await writeFile(turnLoop, `${await readFile(turnLoop, "utf8")}\n// edited while the older build ran\n`);

    await lite.core.init();
    await lite.core.start();
    assert.equal(lite.core.host.state, "ready");
    const [notice, ...more] = await customEvents(lite, "harness_downgraded");
    assert.equal(more.length, 0);
    assert.deepEqual((notice!.data.payload as { stranded?: string[] }).stranded, ["loop/turn-loop.mjs"]);
    const card = studioActivity((await lite.core.listAllEvents()) as never).find((item) =>
      /older version of the app/.test(item.title),
    );
    assert.ok(card?.attention && /loop\/turn-loop\.mjs/.test(card.detail));

    await lite.core.host.stop();
    await lite.core.start();
    assert.equal((await customEvents(lite, "harness_downgraded")).length, 1, "said once");
  });

  it("a reset to the shipped self takes the JavaScript modules away, backed up", async () => {
    const lite = await javascriptCore();
    await lite.core.start("cold_start", { resetHarness: true });
    assert.equal(lite.core.host.state, "ready");
    const ws = lite.core.layout.harnessWs;
    assert.deepEqual(
      (await readdir(path.join(ws, "loop"))).filter((name) => name.endsWith(".mjs")),
      [],
    );
    const backups = (await readdir(lite.core.layout.updates)).filter((name) => name.startsWith("reseed-backup-"));
    assert.equal(backups.length, 1);
    assert.ok(
      (await readFile(path.join(lite.core.layout.updates, backups[0]!, "loop", "turn-loop.mjs"), "utf8")).endsWith(
        EDIT,
      ),
      "the agent's edit is recoverable",
    );
    assert.equal(
      await layoutMigrationPending({
        seedDir: path.join(lite.resources, "harness-seed"),
        workspaceDir: ws,
        manifestFile: lite.manifest,
      }),
      null,
    );
    assert.equal((await migrations(lite)).length, 0);
  });
});
