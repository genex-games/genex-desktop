/**
 * Seed upgrades — the fix for the trap that bit twice on day one: the harness workspace was
 * seeded only when missing, so app-shipped fixes never reached an existing install.
 *
 * The invariant under test: **the agent owns its edits, the app owns everything the agent
 * never touched.** Upgrades flow through untouched files; edited files are never overwritten.
 */
import assert from "node:assert/strict";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  applySeed,
  reconcileManifestWithSeedVintages,
  RETIRED_SEED_PATHS,
  SEED_CALL_CHANGES,
  SEED_MOVES,
  type SeedUpgradeReport,
} from "../../src/substrate/seed-upgrade.ts";
import { RENAMED_SEED_FILES, renameInSource } from "../../src/substrate/seed-renames.ts";
import { SEED_CALL_MEMORY_PREFIX, seedCallMemory, seedUpgradedPayload } from "../../src/main/seed-upgrade-notice.ts";
import { pathExists } from "../../src/substrate/fsx.ts";
import { StudioCore } from "../../src/main/studio-core.ts";
import { makeResources } from "../helpers/resources.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { git, STUDIO_COMMITTER } from "../../src/substrate/snapshots.ts";
import { cloneSeededWorkspace } from "../helpers/seed-upgrade-fixture.ts";
import { closeBeforeCleanup, removeTree, tmpDir } from "../helpers/tmp.ts";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { studioActivity } from "../../src/shared/studio-activity.ts";
import { toEntries } from "../../src/renderer/chat-entries.ts";
import type { EventEnvelope } from "../../src/substrate/types.ts";
import { SEED_GENERATED } from "../../scripts/gen-harness-types.ts";
import { OPEN_LOOP_REFUSAL } from "../../src/harness-seed/loop/open-loop-prompts.ts";
import { gameRepo, loopHost } from "../helpers/loop-host.ts";
import { copyProject, Project } from "../helpers/project-fixtures.ts";
import { callIsolated, linkIsolated } from "../helpers/isolated-import.ts";

/** Where an upgrade keeps the agent's copy of `rel`: a renamed module's new path (seed-renames.ts). */
const keptAt = (rel: string): string => RENAMED_SEED_FILES[rel] ?? rel;

/** A renamed module's path before the rename, by its path now. */
const OLD_PATH: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(RENAMED_SEED_FILES).map(([oldPath, newPath]) => [newPath, oldPath]),
);

/** What an older vintage's copy of `rel` exported, wherever the module stood then. */
const vintageExports = (modules: Record<string, string[]>, rel: string): string[] =>
  modules[rel] ?? modules[OLD_PATH[rel] ?? ""] ?? [];

async function rig(): Promise<{ seed: string; ws: string; manifest: string; backup: string }> {
  const root = await tmpDir("seed-upgrade-");
  const seed = path.join(root, "seed");
  await mkdir(path.join(seed, "loop"), { recursive: true });
  await writeFile(path.join(seed, "loop", "main.mjs"), "// v1 main\n");
  await writeFile(path.join(seed, "loop", "turn-loop.mjs"), "// v1 turn loop\n");
  await writeFile(path.join(seed, "package.json"), '{"name":"harness"}\n');
  return {
    seed,
    ws: path.join(root, "workspace"),
    manifest: path.join(root, "manifest.json"),
    backup: path.join(root, "backup"),
  };
}

/**
 * Why a case waits for the integration of phase 5: it pins seed parts this phase removed or changed
 * (moves out of deleted files, step markers in rewritten parts, kept old parts that load the harness).
 * Decision 7 archives a kept part the seed removed or changed incompatibly and lays the seed's copy
 * down (WS2's `substrate/seed-archive.ts`); each case is rewritten against that archive there.
 */
describe("seed upgrade", () => {
  it("first launch seeds the workspace and records what was laid down", async () => {
    const { seed, ws, manifest } = await rig();
    const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
    assert.equal(report.mode, "seeded");
    assert.deepEqual(report.added, ["loop/main.mjs", "loop/turn-loop.mjs", "package.json"]);
    assert.equal(await readFile(path.join(ws, "loop", "main.mjs"), "utf8"), "// v1 main\n");
    assert.ok(await pathExists(manifest));
  });

  it("a shipped fix reaches an existing install when the agent never touched the file", async () => {
    const { seed, ws, manifest, backup } = await rig();
    await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });

    // The app ships a fix (this exact scenario was the day-one trap: a guard fix in
    // turn-loop.mjs that never reached the live install).
    await writeFile(path.join(seed, "loop", "turn-loop.mjs"), "// v2 turn loop with the guard fix\n");
    const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest, backupDir: backup });

    assert.equal(report.mode, "upgraded");
    assert.deepEqual(report.updated, ["loop/turn-loop.mjs"]);
    assert.deepEqual(report.kept, []);
    assert.equal(
      await readFile(path.join(ws, "loop", "turn-loop.mjs"), "utf8"),
      "// v2 turn loop with the guard fix\n",
    );
    // The replaced version is recoverable without git archaeology.
    assert.equal(await readFile(path.join(backup, "loop", "turn-loop.mjs"), "utf8"), "// v1 turn loop\n");
  });

  it("never overwrites a file the agent edited — full recursion means its edits win", async () => {
    const { seed, ws, manifest } = await rig();
    await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });

    await writeFile(path.join(ws, "loop", "turn-loop.mjs"), "// the agent rewrote its own turn loop\n");
    await writeFile(path.join(seed, "loop", "turn-loop.mjs"), "// v2 from the app\n");
    const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });

    assert.deepEqual(report.kept, ["loop/turn-loop.mjs"]);
    assert.equal(
      await readFile(path.join(ws, "loop", "turn-loop.mjs"), "utf8"),
      "// the agent rewrote its own turn loop\n",
    );

    // ...and the manifest still remembers the divergence on the NEXT upgrade too.
    await writeFile(path.join(seed, "loop", "turn-loop.mjs"), "// v3 from the app\n");
    const again = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
    assert.deepEqual(again.kept, ["loop/turn-loop.mjs"]);
    assert.match(await readFile(path.join(ws, "loop", "turn-loop.mjs"), "utf8"), /agent rewrote/);
  });

  it("respects an agent deletion and keeps agent-created files out of the books", async () => {
    const { seed, ws, manifest } = await rig();
    await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });

    await rm(path.join(ws, "package.json"));
    await mkdir(path.join(ws, "memory"), { recursive: true });
    await writeFile(path.join(ws, "memory", "notes.md"), "the agent's own memory\n");
    await writeFile(path.join(seed, "package.json"), '{"name":"harness","version":"2"}\n');

    const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
    assert.deepEqual(report.kept, ["package.json"], "deleting is an edit too");
    assert.equal(await pathExists(path.join(ws, "package.json")), false);
    assert.equal(await readFile(path.join(ws, "memory", "notes.md"), "utf8"), "the agent's own memory\n");
  });

  it("adds a brand-new seed file, unless the agent already grew one at that path", async () => {
    const { seed, ws, manifest } = await rig();
    await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });

    await writeFile(path.join(seed, "loop", "judge.mjs"), "// new in this app version\n");
    await writeFile(path.join(ws, "loop", "homegrown.mjs"), "// the agent wrote this itself\n");
    await writeFile(path.join(seed, "loop", "homegrown.mjs"), "// the app ships one under the same name\n");

    const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
    assert.deepEqual(report.added, ["loop/judge.mjs"]);
    assert.deepEqual(report.kept, ["loop/homegrown.mjs"]);
    assert.equal(await readFile(path.join(ws, "loop", "homegrown.mjs"), "utf8"), "// the agent wrote this itself\n");
  });

  it("migrates a pre-manifest install by treating the whole workspace as untouched", async () => {
    const { seed, ws, manifest } = await rig();
    // An install from before manifests existed: seeded by plain copy, no bookkeeping —
    // exactly the live install that had to be deleted by hand twice.
    await mkdir(path.join(ws, "loop"), { recursive: true });
    await writeFile(path.join(ws, "loop", "main.mjs"), "// v1 main\n");
    await writeFile(path.join(ws, "loop", "turn-loop.mjs"), "// OLD turn loop without the guard fix\n");
    await writeFile(path.join(ws, "package.json"), '{"name":"harness"}\n');

    const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
    assert.equal(report.mode, "upgraded");
    assert.deepEqual(report.updated, ["loop/turn-loop.mjs"]);
    assert.equal(await readFile(path.join(ws, "loop", "turn-loop.mjs"), "utf8"), "// v1 turn loop\n");
    // From now on this install has a manifest like any other.
    assert.ok(await pathExists(manifest));
  });

  it("does nothing (and says so) when everything is already current", async () => {
    const { seed, ws, manifest } = await rig();
    await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
    const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
    assert.equal(report.mode, "unchanged");
    assert.deepEqual([report.added, report.updated, report.kept], [[], [], []]);
  });
});

describe("manifest reconcile after a harness restore", () => {
  /** A rig that has lived: seeded on v1, upgraded to v2 (backing v1 up under updates/). */
  async function livedRig() {
    const { seed, ws, manifest } = await rig();
    const updates = path.join(path.dirname(ws), "updates");
    await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
    await writeFile(path.join(seed, "loop", "turn-loop.mjs"), "// v2 turn loop\n");
    await applySeed({
      seedDir: seed,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(updates, "seed-backup-1"),
    });
    return { seed, ws, manifest, updates };
  }

  it("re-owns a restored seed-vintage file so the next boot's upgrade lands again", async () => {
    const { seed, ws, manifest, updates } = await livedRig();
    // The watchdog rewinds the harness to a snapshot from before the upgrade: the workspace
    // holds v1 again while the manifest still records v2 — the exact shape seed-upgrade
    // misreads as an agent edit.
    await writeFile(path.join(ws, "loop", "turn-loop.mjs"), "// v1 turn loop\n");

    const { reconciled } = await reconcileManifestWithSeedVintages({
      workspaceDir: ws,
      manifestFile: manifest,
      seedDir: seed,
      updatesDir: updates,
    });
    assert.deepEqual(reconciled, ["loop/turn-loop.mjs"]);

    const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
    assert.deepEqual(report.updated, ["loop/turn-loop.mjs"], "the shipped fix reaches the restored install");
    assert.deepEqual(report.kept, []);
    assert.equal(await readFile(path.join(ws, "loop", "turn-loop.mjs"), "utf8"), "// v2 turn loop\n");
  });

  it("leaves genuine agent content owned even when it diverges from the manifest", async () => {
    const { seed, ws, manifest, updates } = await livedRig();
    // Content that matches no seed vintage is the agent's, whatever brought it here.
    await writeFile(path.join(ws, "loop", "turn-loop.mjs"), "// the agent's own rewrite\n");

    const { reconciled } = await reconcileManifestWithSeedVintages({
      workspaceDir: ws,
      manifestFile: manifest,
      seedDir: seed,
      updatesDir: updates,
    });
    assert.deepEqual(reconciled, []);

    const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
    assert.deepEqual(report.kept, ["loop/turn-loop.mjs"], "hard constraint #1: the agent's copy wins");
    assert.equal(await readFile(path.join(ws, "loop", "turn-loop.mjs"), "utf8"), "// the agent's own rewrite\n");
  });

  it("is a no-op without backups, without a manifest, and for files that went missing", async () => {
    const { seed, ws, manifest } = await rig();
    // No manifest yet: nothing to reconcile, nothing to throw.
    assert.deepEqual(
      await reconcileManifestWithSeedVintages({
        workspaceDir: ws,
        manifestFile: manifest,
        seedDir: seed,
        updatesDir: path.join(path.dirname(ws), "no-such-updates"),
      }),
      { reconciled: [] },
    );

    await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
    // A rewind can also drop a file entirely; a deletion carries no bytes to match a vintage,
    // so its entry stays exactly as it is.
    await rm(path.join(ws, "loop", "turn-loop.mjs"));
    const { reconciled } = await reconcileManifestWithSeedVintages({
      workspaceDir: ws,
      manifestFile: manifest,
      seedDir: seed,
      updatesDir: path.join(path.dirname(ws), "still-no-updates"),
    });
    assert.deepEqual(reconciled, []);
  });
});

describe("the first launch's harness repository", () => {
  it("is written by git from the shipped seed, so no file the launch just wrote is read back", async () => {
    // Windows scans a file the first time it is read after being written: committing the copied
    // seed made git read back all of it, and a first start on Windows 11 waited minutes on that.
    const { core, resources } = await coreLite();
    const ws = core.layout.harnessWs;
    const shipped = (
      await readdir(path.join(resources, "harness-seed"), { recursive: true, withFileTypes: true })
    ).filter((entry) => entry.isFile()).length;
    const counts = Object.fromEntries(
      (await git(ws, ["count-objects", "-v"]))
        .trim()
        .split("\n")
        .map((line) => line.split(": ") as [string, string]),
    );
    assert.equal(Number(counts.count), 0, "no loose object: the commit went into one pack");
    assert.ok(Number(counts["in-pack"]) > shipped, "every file, tree and the commit are packed");
    assert.equal((await git(ws, ["ls-files"])).trim().split("\n").length, shipped);
    assert.equal((await git(ws, ["status", "--porcelain"])).trim(), "");
    assert.equal(
      (await git(ws, ["log", "--format=%an <%ae>|%s"])).trim(),
      `${STUDIO_COMMITTER.name} <${STUDIO_COMMITTER.email}>|substrate: initial`,
    );
    for (const rel of ["loop/main.ts", "package.json"])
      assert.equal(
        await readFile(path.join(ws, rel), "utf8"),
        await readFile(path.join(resources, "harness-seed", rel), "utf8"),
      );
  });
});

describe("seed upgrade baseline at boot", () => {
  it("a boot that applies seed files snapshots the fresh harness, healthy once it has booted", async () => {
    // Unattended, the watchdog rewound four times to the only healthy harness snapshot there
    // was — an Aug 20 promotion — undoing the newer seed each time. The rewind target must
    // follow the newest applied seed — once it has run: the baseline also pins whatever code
    // the last session left, which may never have booted (MIG-3).
    const resources = await makeResources();
    const userData = path.join(await tmpDir("seed-baseline-"), "userData");
    const boot = async () => {
      const core = new StudioCore({
        paths: { userData, resources },
        engines: [],
        sandbox: false,
        execPath: process.execPath,
        executionPolicy: { runBackgroundImprovement: false },
      });
      await core.init();
      return core;
    };

    const first = await boot();
    assert.equal(
      first.snapshotIndex.newestHealthy("harness"),
      undefined,
      "a first launch seeds; nothing has run yet, so nothing is claimed healthy",
    );

    // The app ships a fix in the seed, then the studio boots again over the same install.
    const shipped = path.join(resources, "harness-seed", "prompts", "operating-rules.md");
    await writeFile(shipped, `${await readFile(shipped, "utf8")}\n<!-- shipped fix -->\n`);
    const second = await boot();
    const baseline = second.snapshotIndex.all().find((record) => /seed upgrade baseline/.test(record.reason));
    assert.ok(baseline?.git.harness, "an applied upgrade pins the fresh harness commit for the watchdog");
    assert.notEqual(baseline.healthy, true, "nothing has run it yet, and there is no healthy self it matches");
    try {
      await second.start();
      assert.equal(
        second.snapshotIndex.newestHealthy("harness")?.snapshot_id,
        baseline.snapshot_id,
        "booted, it is the rewind target",
      );
    } finally {
      await second.stop();
    }
  });
});

it("the files the build generates into the seed ship like any other: added, replaced while untouched, kept once edited", async () => {
  const { seed, ws, manifest } = await rig();
  await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
  const generated = SEED_GENERATED.map(({ seedFile }) => seedFile);
  const ship = async (suffix: string) => {
    for (const { seedFile, generate } of SEED_GENERATED) {
      await mkdir(path.dirname(path.join(seed, seedFile)), { recursive: true });
      await writeFile(path.join(seed, seedFile), generate(process.cwd()) + suffix);
    }
    return applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
  };
  const readWs = (rel: string) => readFile(path.join(ws, rel), "utf8");

  const first = await ship("");
  assert.deepEqual(first.added.filter((rel) => generated.includes(rel)).sort(), [...generated].sort());

  const second = await ship("// next contract\n");
  assert.deepEqual(second.updated.filter((rel) => generated.includes(rel)).sort(), [...generated].sort());
  for (const rel of generated) assert.match(await readWs(rel), /\/\/ next contract\n$/);

  const edited = generated.at(0) ?? assert.fail("the build generates at least one seed file");
  await appendFile(path.join(ws, edited), "// the agent's line\n");
  const third = await ship("// a later contract\n");
  assert.ok(third.kept.includes(edited), "an edited generated file is the agent's");
  assert.match(await readWs(edited), /the agent's line/);
});

describe("seed upgrade: a manifest that forgot a file", () => {
  it("keeps entries for paths the current seed does not ship, so an older build's boot cannot orphan a newer file", async () => {
    const r = await rig();
    await applySeed({ seedDir: r.seed, workspaceDir: r.ws, manifestFile: r.manifest });
    // A newer seed adds a file …
    await writeFile(path.join(r.seed, "loop", "run-inbox.mjs"), "// inbox v1\n");
    await applySeed({ seedDir: r.seed, workspaceDir: r.ws, manifestFile: r.manifest });
    // … then an older build (whose seed lacks it) boots against the same install …
    await rm(path.join(r.seed, "loop", "run-inbox.mjs"));
    await applySeed({ seedDir: r.seed, workspaceDir: r.ws, manifestFile: r.manifest });
    const manifest = JSON.parse(await readFile(r.manifest, "utf8")) as { files: Record<string, string> };
    assert.ok(manifest.files["loop/run-inbox.mjs"], "the entry survives a seed that does not ship the file");
    // … and the newer build's next fix still lands.
    await writeFile(path.join(r.seed, "loop", "run-inbox.mjs"), "// inbox v2\n");
    const report = await applySeed({ seedDir: r.seed, workspaceDir: r.ws, manifestFile: r.manifest });
    assert.deepEqual(report.updated, ["loop/run-inbox.mjs"]);
    assert.equal(await readFile(path.join(r.ws, "loop", "run-inbox.mjs"), "utf8"), "// inbox v2\n");
  });

  it("re-owns an unknown workspace file whose bytes are a backed-up seed vintage, and keeps one that matches no vintage", async () => {
    const r = await rig();
    await applySeed({ seedDir: r.seed, workspaceDir: r.ws, manifestFile: r.manifest });
    const updates = path.join(path.dirname(r.ws), "updates");
    // An earlier upgrade backed up the v1 inbox before replacing it; the manifest later lost the entry.
    await mkdir(path.join(updates, "seed-backup-old", "loop"), { recursive: true });
    await writeFile(path.join(updates, "seed-backup-old", "loop", "run-inbox.mjs"), "// inbox v1\n");
    await writeFile(path.join(r.ws, "loop", "run-inbox.mjs"), "// inbox v1\n");
    await writeFile(path.join(r.ws, "loop", "mine.mjs"), "// the agent's own\n");
    await writeFile(path.join(r.seed, "loop", "run-inbox.mjs"), "// inbox v3\n");
    await writeFile(path.join(r.seed, "loop", "mine.mjs"), "// the seed's idea of mine\n");
    const report = await applySeed({
      seedDir: r.seed,
      workspaceDir: r.ws,
      manifestFile: r.manifest,
      backupDir: r.backup,
      updatesDir: updates,
    });
    assert.deepEqual(report.updated, ["loop/run-inbox.mjs"], JSON.stringify(report));
    assert.deepEqual(report.kept, ["loop/mine.mjs"]);
    assert.equal(await readFile(path.join(r.ws, "loop", "run-inbox.mjs"), "utf8"), "// inbox v3\n");
    assert.equal(await readFile(path.join(r.ws, "loop", "mine.mjs"), "utf8"), "// the agent's own\n");
    assert.ok(await pathExists(path.join(r.backup, "loop", "run-inbox.mjs")), "the replaced vintage is backed up");
  });
});

describe("retiring a seed file the app no longer ships", () => {
  /** The rig, plus one of the retired paths in the older seed the install was created from. */
  async function retiredRig(): Promise<{ seed: string; ws: string; manifest: string; backup: string; rel: string }> {
    const base = await rig();
    const rel = RETIRED_SEED_PATHS[0]!;
    await mkdir(path.join(base.seed, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(base.seed, rel), "# an older build shipped this\n");
    await applySeed({ seedDir: base.seed, workspaceDir: base.ws, manifestFile: base.manifest });
    // The new build's seed no longer carries it: that is what retirement is for.
    await rm(path.join(base.seed, rel));
    return { ...base, rel };
  }

  it("removes an untouched copy, backs it up, and reports it", async () => {
    const { seed, ws, manifest, backup, rel } = await retiredRig();
    const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest, backupDir: backup });
    assert.deepEqual(report.retired, [rel]);
    assert.equal(report.mode, "upgraded", "a retirement is a change");
    assert.equal(await pathExists(path.join(ws, rel)), false, "the workspace no longer carries it");
    assert.equal(await readFile(path.join(backup, rel), "utf8"), "# an older build shipped this\n");
  });

  it("keeps the manifest entry, so an older build cannot resurrect the file", async () => {
    const { seed, ws, manifest, backup, rel } = await retiredRig();
    await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest, backupDir: backup });
    const written = JSON.parse(await readFile(manifest, "utf8")) as {
      files: Record<string, string>;
      retired?: Record<string, string>;
    };
    assert.ok(written.files[rel], "the entry survives the removal");
    assert.ok(written.retired?.[rel], "and is marked retired");

    // An older build, whose seed still ships the file, boots against the same install: with the
    // entry present it reads a deliberate deletion and leaves it deleted.
    await mkdir(path.join(seed, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(seed, rel), "# an older build shipped this\n");
    const older = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest, backupDir: backup });
    assert.ok(older.kept.includes(rel), "the older build keeps it deleted");
    assert.equal(await pathExists(path.join(ws, rel)), false);
  });

  it("retires on the one-time migration too, where the manifest that would remember it does not exist yet", async () => {
    // An install created before the manifest: the workspace is a plain copy of the older seed.
    // Nothing else could ever remove these four — the seed no longer ships them, so they never
    // acquire a manifest entry, and every later boot would read "never the app's file here".
    const base = await rig();
    const rel = RETIRED_SEED_PATHS[0]!;
    await mkdir(path.join(base.ws, path.dirname(rel)), { recursive: true });
    await mkdir(path.join(base.ws, "loop"), { recursive: true });
    await writeFile(path.join(base.ws, rel), "# an older build shipped this\n");
    await writeFile(path.join(base.ws, "loop", "main.mjs"), "// v0 main\n");
    assert.equal(await pathExists(base.manifest), false, "the install predates the manifest");

    const report = await applySeed({
      seedDir: base.seed,
      workspaceDir: base.ws,
      manifestFile: base.manifest,
      backupDir: base.backup,
    });
    assert.deepEqual(report.retired, [rel], JSON.stringify(report));
    assert.equal(await pathExists(path.join(base.ws, rel)), false, "the dead skill is gone from the workspace");
    assert.equal(
      await readFile(path.join(base.backup, rel), "utf8"),
      "# an older build shipped this\n",
      "and is recoverable",
    );

    // The manifest the migration writes remembers the removal both ways: the entry keeps an
    // older build from copying the file straight back in, the mark keeps this one from
    // removing a copy somebody restores later.
    const written = JSON.parse(await readFile(base.manifest, "utf8")) as {
      files: Record<string, string>;
      retired?: Record<string, string>;
    };
    assert.ok(written.files[rel], "the entry the ordinary path carries over is written here");
    assert.ok(written.retired?.[rel]);
    await mkdir(path.join(base.seed, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(base.seed, rel), "# an older build shipped this\n");
    const older = await applySeed({
      seedDir: base.seed,
      workspaceDir: base.ws,
      manifestFile: base.manifest,
      backupDir: base.backup,
    });
    assert.ok(older.kept.includes(rel), JSON.stringify(older));
    assert.equal(await pathExists(path.join(base.ws, rel)), false, "an older build cannot resurrect it");
  });

  it("keeps a copy the agent edited, for ever", async () => {
    const { seed, ws, manifest, backup, rel } = await retiredRig();
    await writeFile(path.join(ws, rel), "# the agent rewrote this one\n");
    const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest, backupDir: backup });
    assert.deepEqual(report.retired, []);
    assert.equal(await readFile(path.join(ws, rel), "utf8"), "# the agent rewrote this one\n");
  });

  it("is idempotent: a second pass finds nothing left to do", async () => {
    const { seed, ws, manifest, backup } = await retiredRig();
    await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest, backupDir: backup });
    const again = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest, backupDir: backup });
    assert.deepEqual(again.retired, []);
    assert.equal(again.mode, "unchanged");
  });

  it("deletes nothing when no backupDir was passed — the crash-recovery reseed", async () => {
    const { seed, ws, manifest, rel } = await retiredRig();
    const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
    assert.deepEqual(report.retired, []);
    assert.equal(await pathExists(path.join(ws, rel)), true, "nothing is removed without somewhere to put it");
  });

  it("never creates the retired paths on a fresh workspace", async () => {
    const { seed, ws, manifest, backup } = await rig();
    const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest, backupDir: backup });
    assert.equal(report.mode, "seeded");
    assert.deepEqual(report.retired, []);
    for (const rel of RETIRED_SEED_PATHS) assert.equal(await pathExists(path.join(ws, rel)), false, rel);
  });

  it("names only paths the shipped seed really has stopped shipping", async () => {
    const shipped = path.resolve(fileURLToPath(new URL("../../src/harness-seed", import.meta.url)));
    for (const rel of RETIRED_SEED_PATHS) {
      assert.equal(
        await pathExists(path.join(shipped, rel)),
        false,
        `${rel} is still shipped — retiring it would delete a live file`,
      );
    }
  });

  it("carries all four outcomes to both surfaces the user reads", () => {
    // A retirement takes a page out of the user's own workspace. `retired` alone marks the
    // report `upgraded`, so a pass that only retires reaches these two renderers with `added`
    // and `updated` empty — and both used to render a sentence counting zero files and a
    // detail list with nothing in it.
    // The payload StudioCore appends at boot, built from the report `applySeed` returns.
    const upgrade = (outcomes: Omit<SeedUpgradeReport, "mode">): EventEnvelope => {
      const payload = seedUpgradedPayload({ mode: "upgraded", ...outcomes });
      assert.ok(payload, "an upgraded seed is always reported");
      return {
        id: "upgrade",
        thread_id: "studio",
        turn_id: null,
        session_id: null,
        created_at: "2026-09-22T00:00:00Z",
        data: { type: "custom", event_type: "seed_upgraded", payload },
      };
    };
    for (const mode of ["seeded", "unchanged"] as const)
      assert.equal(
        seedUpgradedPayload({ mode, added: ["a"], updated: [], kept: [], retired: [], moved: [] }),
        null,
        `${mode} is not news`,
      );
    assert.equal(seedUpgradedPayload(null), null);
    const report = upgrade({
      added: ["loop/new.mjs"],
      updated: ["loop/main.mjs"],
      kept: ["skills/own.md"],
      retired: ["docs/old.md"],
      moved: [],
    });
    assert.deepEqual(
      report.data.type === "custom" && report.data.payload,
      { added: ["loop/new.mjs"], updated: ["loop/main.mjs"], kept: ["skills/own.md"], retired: ["docs/old.md"] },
      "all four outcomes, and nothing else",
    );
    const activity = studioActivity([report])[0]!;
    assert.match(activity.title, /refreshed 2/);
    assert.match(activity.title, /archived 1/);
    for (const file of ["loop/new.mjs", "loop/main.mjs", "skills/own.md", "docs/old.md"])
      assert.ok(activity.detail.includes(file), file);
    assert.match(activity.detail, /Preserved your edits/);
    const chatText = (event: EventEnvelope) =>
      toEntries([event])
        .flatMap((entry) =>
          entry.kind === "activity" ? entry.rows.map((row) => row.text) : "text" in entry ? [entry.text] : [],
        )
        .join("\n");
    assert.match(chatText(report), /refreshed 2.*took away 1.*1 self-edited file kept/);
    const retirement = upgrade({ added: [], updated: [], kept: [], retired: ["docs/old.md"], moved: [] });
    assert.match(studioActivity([retirement])[0]!.title, /archived 1/);
    assert.doesNotMatch(studioActivity([retirement])[0]!.title, /refreshed 0/);
    assert.match(chatText(retirement), /took away 1/);
    assert.doesNotMatch(chatText(retirement), /refreshed 0/);
  });
});

/**
 * Every vintage the seed shipped before the archive epoch (phase 5): an agent that edited any of its
 * parts kept them across upgrades, which is why each later change had to keep the older names
 * exported. Upgrading into the epoch (seed-archive.ts) archives every such kept part, of a file
 * this seed changes or no longer ships, and lays the shipped copy down, so the harness that boots
 * is the shipped one: no older copy is left beside it to fail at link time.
 */
describe("seed upgrade into the archive epoch, over every older vintage", () => {
  const shipped = path.resolve(fileURLToPath(new URL("../../src/harness-seed", import.meta.url)));
  const fixtures = path.resolve(fileURLToPath(new URL("../fixtures", import.meta.url)));
  /** A hash no seed file has: the copy an older seed laid down, which the agent then edited. */
  const OLDER_SEED_HASH = "0".repeat(64);

  /** Every part an older vintage exported, by its path as a TypeScript seed names it (a renamed module left out). */
  function olderParts(): Map<string, string[]> {
    const parts = new Map<string, string[]>();
    for (const name of readdirSync(fixtures)
      .filter((file) => /^seed-exports-.*\.json$/.test(file))
      .sort()) {
      const { modules } = JSON.parse(readFileSync(path.join(fixtures, name), "utf8")) as {
        modules: Record<string, string[]>;
      };
      for (const [rel, names] of Object.entries(modules)) {
        const at = rel.replace(/\.mjs$/, ".ts");
        if (!Object.hasOwn(RENAMED_SEED_FILES, at)) parts.set(at, names);
      }
    }
    return parts;
  }

  it("archives each kept older part with the agent's edit, lays the shipped copy down, and the harness loads", async () => {
    const parts = olderParts();
    assert.ok(parts.size > 100, `the vintages name their parts (${parts.size})`);
    const root = await tmpDir("seed-epoch-");
    const { ws, manifest } = await cloneSeededWorkspace(shipped, root);
    // An install from before the epoch whose agent edited every one of those parts of an older seed.
    const body = JSON.parse(await readFile(manifest, "utf8")) as {
      files: Record<string, string>;
      archiveEpoch?: number;
    };
    delete body.archiveEpoch;
    const edits = new Map<string, string>();
    for (const [rel, names] of parts) {
      body.files[rel] = OLDER_SEED_HASH;
      const text = `${names.map((name) => `export const ${name} = () => ${JSON.stringify(name)};`).join("\n")}\n// the agent's own change\n`;
      edits.set(rel, text);
      await mkdir(path.dirname(path.join(ws, rel)), { recursive: true });
      await writeFile(path.join(ws, rel), text);
    }
    await writeFile(manifest, JSON.stringify(body));

    const report = await applySeed({
      seedDir: shipped,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(root, "backup"),
      now: () => new Date("2026-10-30T09:00:00Z"),
    });

    assert.equal(report.archive?.dir, "archive/2026-10-30");
    assert.deepEqual(
      [...(report.archive?.edits ?? [])].sort(),
      [...parts.keys()].sort(),
      "every kept part is archived",
    );
    for (const [rel, text] of edits) {
      // The upgrade's renames (seed-renames.ts) reach the archived copy too.
      assert.equal(
        await readFile(path.join(ws, "archive", "2026-10-30", rel), "utf8"),
        renameInSource(rel, text),
        `${rel}: the agent's copy`,
      );
      const seedCopy = path.join(shipped, rel);
      if (await pathExists(seedCopy))
        assert.equal(await readFile(path.join(ws, rel), "utf8"), await readFile(seedCopy, "utf8"), `${rel}: shipped`);
      else assert.equal(await pathExists(path.join(ws, rel)), false, `${rel}: the seed no longer ships it`);
    }
    assert.deepEqual(report.kept, [], "nothing older is kept beside the shipped harness");
    // What the bootstrap does: import the workspace's own main.ts.
    const main = await linkIsolated(path.join(ws, "loop", "main.ts"));
    assert.equal(main.createStudio, "function");
  });

  it("SEED_MOVES says where each moved name lives now, and the old file passes on that very binding", async () => {
    const load = async (rel: string) =>
      (await import(new URL(`../../src/harness-seed/${rel}`, import.meta.url).href)) as Record<string, unknown>;
    for (const move of SEED_MOVES) {
      const [from, to] = [await load(move.from), await load(move.to)];
      for (const name of move.names) {
        assert.ok(name in to, `${move.to} exports ${name}`);
        assert.equal(from[name], to[name], `${move.from} re-exports ${name} from ${move.to}`);
      }
    }
  });

  it("every call change names a file the seed ships and a marker its copy has", async () => {
    const stale: string[] = [];
    for (const change of SEED_CALL_CHANGES) {
      const text = await readFile(path.join(shipped, change.file), "utf8").catch(() => null);
      if (text === null || !text.includes(change.marker)) stale.push(`${change.file}: ${change.marker}`);
    }
    assert.deepEqual(stale, [], "a kept copy is reported only for a call the shipped copy makes");
  });
});

describe("seed upgrade across the harness step flag", () => {
  const shipped = path.resolve(fileURLToPath(new URL("../../src/harness-seed", import.meta.url)));
  const TURN = "loop/delegated-turn.ts";
  const JOURNAL = "loop/unreal/lead-journal.ts";

  /** A workspace whose chat turn the agent edited: `older` still saves its game's editor itself, without Genex's checkpoint. */
  async function keptTurn(older: boolean) {
    const root = await tmpDir("seed-step-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
    const copy = await readFile(path.join(ws, TURN), "utf8");
    // The older shape: the turn's end save is its own, not Genex's checkpoint.
    const kept = older ? copy.replaceAll("endOfTurnCheckpoint(", "saveUnrealTurn(") : copy;
    await writeFile(path.join(ws, TURN), `${kept}\n// the agent's own change\n`);
    const backupDir = path.join(root, "backup");
    return applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest, backupDir });
  }

  it("a kept chat turn that ends without Genex's checkpoint is reported and noted for the agent; one that takes it is not", async () => {
    const outdated = await keptTurn(true);
    assert.ok(outdated.kept.includes(TURN), "the chat turn is the agent's");
    assert.deepEqual(outdated.outdatedCalls, [TURN]);
    const current = await keptTurn(false);
    assert.ok(current.kept.includes(TURN));
    assert.deepEqual(current.outdatedCalls ?? [], []);

    const memory = seedCallMemory({ "user taste": "warm palettes" }, outdated.outdatedCalls ?? []);
    assert.equal(memory["user taste"], "warm palettes", "the agent's own memory is left alone");
    const note = memory[`${SEED_CALL_MEMORY_PREFIX}${TURN}`];
    assert.equal(typeof note, "string");
    assert.match(note as string, /calls the host the older way/);
    assert.match(note as string, /calls the host the older way/);
    assert.ok((note as string).length <= 300, "one memory value stays within the memory policy's limit");
    assert.deepEqual(
      seedCallMemory(memory, []),
      { "user taste": "warm palettes" },
      "a note that no longer holds is taken back",
    );
  });

  it("a kept tool registry or chat turn whose plugins.tools call names no game is reported once, and noted for the agent", async () => {
    const REGISTRY = "tools/index.ts";
    const root = await tmpDir("seed-step-plugins-tools-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
    // The older shape: the plugin tools asked for with no game, whatever the game holds.
    for (const [file, from] of [
      [REGISTRY, "HostMethod.PluginsTools, { project: options.project ?? null }"],
      [TURN, "HostMethod.PluginsTools, { project }"],
    ] as const) {
      const copy = await readFile(path.join(ws, file), "utf8");
      assert.ok(copy.includes(from), `${file} sends the game`);
      // The chat turn is older still: its harness steps go out like an agent's call too.
      const older = copy.replace(from, "HostMethod.PluginsTools, {}").replaceAll("step: true", "harness: true");
      await writeFile(path.join(ws, file), `${older}\n// the agent's own change\n`);
    }
    const report = await applySeed({
      seedDir: shipped,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(root, "backup"),
    });
    assert.deepEqual([...(report.outdatedCalls ?? [])].sort(), [TURN, REGISTRY].sort(), "each file once");
    const memory = seedCallMemory({}, report.outdatedCalls ?? []);
    for (const file of [REGISTRY, TURN]) {
      const note = String(memory[`${SEED_CALL_MEMORY_PREFIX}${file}`]);
      assert.match(note, /calls the host the older way/, file);
      assert.match(note, /calls the host the older way/, file);
      assert.ok(note.length <= 300, `${file}: one memory value stays within the memory policy's limit`);
    }
  });

  it("a kept local prompt that reads no web rules file is reported once and noted for the agent", async () => {
    const root = await tmpDir("seed-step-web-rules-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
    const file = "loop/prompt.ts";
    const copy = await readFile(path.join(ws, file), "utf8");
    // The older shape: one rules file for every turn, its web rules included.
    const webRules = '"prompts/operating-rules-web.md"';
    assert.ok(copy.includes(webRules), "the shipped copy reads the web rules for a web game");
    await writeFile(path.join(ws, file), `${copy.replaceAll(webRules, '""')}\n// the agent's own change\n`);
    const report = await applySeed({
      seedDir: shipped,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(root, "backup"),
    });
    assert.deepEqual(report.outdatedCalls ?? [], [file], "reported once");
    const note = String(seedCallMemory({}, report.outdatedCalls ?? [])[`${SEED_CALL_MEMORY_PREFIX}${file}`]);
    assert.match(note, /calls the host the older way/);
    assert.ok(note.length <= 300, "one memory value stays within the memory policy's limit");
  });

  // Flipped (phase 5): kept rules are no longer checked for the web rules' sentence; rules from before
  // the archive epoch were archived (seed-archive.ts), and the shipped rules no longer say it.
  it("a kept chat brief from before new games started empty is reported once and noted", async () => {
    const root = await tmpDir("seed-step-first-brief-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
    const brief = "loop/chat-session.ts";
    // The older shape: a brief that never tells a game with no kind to call start_web_game.
    const copy = await readFile(path.join(ws, brief), "utf8");
    assert.ok(copy.includes("pendingKindRule("), "the shipped brief names the first step");
    await writeFile(
      path.join(ws, brief),
      `${copy.replaceAll("pendingKindRule(", "olderRule(")}\n// the agent's own change\n`,
    );
    const report = await applySeed({
      seedDir: shipped,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(root, "backup"),
    });
    assert.deepEqual(report.outdatedCalls ?? [], [brief], "the file once");
    const memory = seedCallMemory({}, report.outdatedCalls ?? []);
    const briefNote = String(memory[`${SEED_CALL_MEMORY_PREFIX}${brief}`]);
    assert.match(briefNote, /calls the host the older way/);
    assert.ok(briefNote.length <= 300, "within the memory policy's limit");
    // The chat turn's note names what the brief now takes.
    const turnNote = String(seedCallMemory({}, [TURN])[`${SEED_CALL_MEMORY_PREFIX}${TURN}`]);
    assert.match(turnNote, /calls the host the older way/);
    assert.ok(turnNote.length <= 300, "within the memory policy's limit");
  });

  it("a kept loop entry, chat turn or chat brief from before chat workers is reported once and noted for the agent", async () => {
    const root = await tmpDir("seed-step-chat-workers-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
    // The older shapes: no "workers" claim, no worker pool around a chat turn, no workers line in the brief.
    const older: ReadonlyArray<readonly [string, readonly string[]]> = [
      ["loop/main.ts", ['"workers"']],
      [TURN, ["withChatWorkers(", "chatWorkersGrant("]],
      ["loop/chat-session.ts", ["WORKERS_BRIEF_LINE"]],
    ];
    for (const [file, markers] of older) {
      let copy = await readFile(path.join(ws, file), "utf8");
      for (const marker of markers) {
        assert.ok(copy.includes(marker), `${file} has ${marker}`);
        copy = copy.replaceAll(marker, "olderShape");
      }
      await writeFile(path.join(ws, file), `${copy}\n// the agent's own change\n`);
    }
    const report = await applySeed({
      seedDir: shipped,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(root, "backup"),
    });
    const files = older.map(([file]) => file);
    assert.deepEqual([...(report.outdatedCalls ?? [])].sort(), [...files].sort(), "each file once");
    const memory = seedCallMemory({}, report.outdatedCalls ?? []);
    for (const file of files) {
      const note = String(memory[`${SEED_CALL_MEMORY_PREFIX}${file}`]);
      assert.match(note, /calls the host the older way/, file);
      assert.ok(note.length <= 300, `${file}: one memory value stays within the memory policy's limit`);
    }
  });

  it("a kept wake loop, wake rules, loop run or journal from before a job's end woke the lead is reported once and noted", async () => {
    const root = await tmpDir("seed-step-job-wake-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
    // The older shapes: no job watch, no job kind, and no cursor kept on the journal.
    const older: ReadonlyArray<readonly [string, string]> = [
      ["loop/director/wake.ts", "watchJobs("],
      ["loop/director/wake-schedule.ts", "JobEnded"],
      ["loop/director/loop-run.ts", "jobsCursor"],
      ["loop/director/journal.ts", "jobsCursor"],
    ];
    for (const [file, marker] of older) {
      const copy = await readFile(path.join(ws, file), "utf8");
      assert.ok(copy.includes(marker), `${file} has ${marker}`);
      await writeFile(path.join(ws, file), `${copy.replaceAll(marker, "olderShape")}\n// the agent's own change\n`);
    }
    const report = await applySeed({
      seedDir: shipped,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(root, "backup"),
    });
    const files = older.map(([file]) => file);
    assert.deepEqual([...(report.outdatedCalls ?? [])].sort(), [...files].sort(), "each file once");
    const memory = seedCallMemory({}, report.outdatedCalls ?? []);
    for (const file of files) {
      const note = String(memory[`${SEED_CALL_MEMORY_PREFIX}${file}`]);
      assert.match(note, /calls the host the older way/, file);
      assert.ok(note.length <= 300, `${file}: one memory value stays within the memory policy's limit`);
    }
  });

  it("a kept director part from before a Loop led in place is reported once and noted", async () => {
    const older: ReadonlyArray<readonly [string, string, RegExp]> = [
      ["loop/director/setup.ts", "prepareOpenLoopRun(", /prepareOpenLoopRun/],
      ["loop/director.ts", "LoopProfile.Open", /LoopProfile\.Open/],
      ["loop/director/wake.ts", "activeWork(", /activeWork/],
      ["loop/director/loop-run.ts", "open?: OpenLoop", /OpenLoop/],
      ["loop/director/loop-run.ts", "open?.clock.now()", /open\?\.clock\.now\(\)/],
      ["loop/director/wake-schedule.ts", "TurnEnd.Continue", /TurnEnd\.Continue/],
      ["loop/director/wake-schedule.ts", "turn.worked", /turn\.worked/],
      ["loop/director/wake.ts", "TurnEnd.Continue", /TurnEnd\.Continue/],
      ["loop/director/wake.ts", "turnReturnedAt", /turnReturnedAt/],
      // A copy that has every call above but not the flag still refuses every Loop in place.
      ["loop/director.ts", "SERVES_OPEN_LOOP", /SERVES_OPEN_LOOP/],
      ["loop/director/setup.ts", "SERVES_OPEN_LOOP", /SERVES_OPEN_LOOP/],
      ["loop/director/wake.ts", "SERVES_OPEN_LOOP", /SERVES_OPEN_LOOP/],
      ["loop/director/wake-schedule.ts", "SERVES_OPEN_LOOP", /SERVES_OPEN_LOOP/],
      ["loop/studio-state.ts", "SERVES_OPEN_LOOP", /SERVES_OPEN_LOOP/],
      ["loop/run-dispatch.ts", "SERVES_OPEN_LOOP", /SERVES_OPEN_LOOP/],
      // After a Loop in place: its launch words and their guard, a finished one found by its journal,
      // a resume in its journal's kind, no reopen, and the chat's status alone.
      ["loop/chat-dispatch.ts", "openLaunchPromise(", /openLaunchPromise/],
      ["loop/chat-dispatch.ts", "finishedInPlace(", /finishedInPlace/],
      ["loop/chat-dispatch.ts", "openLoopServed(", /openLoopServed/],
      ["loop/run-dispatch.ts", "resumedProfile(", /resumedProfile/],
      ["loop/reopen-run.ts", "OPEN_LOOP_REFUSAL.notReopenable", /notReopenable/],
      ["loop/after-loop-run.ts", "inPlace", /inPlace/],
      ["loop/after-loop-run-prompts.ts", "inPlaceControls(", /inPlaceControls/],
    ];
    for (const [file, marker] of older) {
      const root = await tmpDir("seed-step-open-loop-");
      const ws = path.join(root, "workspace");
      const manifest = path.join(root, "manifest.json");
      await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
      const copy = await readFile(path.join(ws, file), "utf8");
      assert.ok(copy.includes(marker), `${file} has ${marker}`);
      await writeFile(path.join(ws, file), `${copy.replaceAll(marker, "olderShape")}\n// the agent's own change\n`);
      const report = await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
      assert.deepEqual(report.outdatedCalls, [file], `${file} without ${marker}`);
      const note = String(seedCallMemory({}, report.outdatedCalls ?? [])[`${SEED_CALL_MEMORY_PREFIX}${file}`]);
      assert.match(note, /calls the host the older way/, file);
      assert.ok(note.length <= 300, `${file}: one memory value stays within the memory policy's limit`);
    }
  });

  it("a kept part from before one Loop led every project is reported once and noted", async () => {
    const older: ReadonlyArray<readonly [string, string, RegExp]> = [
      ["loop/run-dispatch.ts", "loopProfileOf(", /loopProfileOf/],
      ["loop/chat-dispatch.ts", "startsNextOpenLoop(", /startsNextOpenLoop/],
      ["loop/reopen-run.ts", "director?.open", /director\?\.open/],
      ["loop/launch-prompts.ts", "openBuildWords(", /openBuildWords/],
      ["loop/chat-session.ts", "loopProfileOf(", /loopProfileOf/],
      ["loop/studio-state.ts", "NeedsSession", /NeedsSession/],
      // The launch tool's words name no method, and its ∞ answer follows the project's profile.
      ["tools/game-tools.ts", "untilDoneWords(", /untilDoneWords/],
    ];
    for (const [file, marker] of older) {
      const root = await tmpDir("seed-step-one-loop-");
      const ws = path.join(root, "workspace");
      const manifest = path.join(root, "manifest.json");
      await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
      const copy = await readFile(path.join(ws, file), "utf8");
      assert.ok(copy.includes(marker), `${file} has ${marker}`);
      await writeFile(path.join(ws, file), `${copy.replaceAll(marker, "olderShape")}\n// the agent's own change\n`);
      const report = await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
      assert.deepEqual(report.outdatedCalls, [file], `${file} without ${marker}`);
      const note = String(seedCallMemory({}, report.outdatedCalls ?? [])[`${SEED_CALL_MEMORY_PREFIX}${file}`]);
      assert.match(note, /calls the host the older way/, file);
      assert.ok(note.length <= 300, `${file}: one memory value stays within the memory policy's limit`);
    }
  });

  it("a kept lead journal that still makes the runner's plugin call itself is a move, and its callers call from lead-steps.ts", async () => {
    const root = await tmpDir("seed-step-journal-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
    const copy = await readFile(path.join(ws, JOURNAL), "utf8");
    const reexport = 'export { unrealTool } from "./lead-steps.ts";';
    assert.ok(copy.includes(reexport));
    // The older journal made the call itself, like an agent's.
    const ownCall = [
      'export function unrealTool(lead: Pick<Lead, "ctx" | "run" | "threadId">, name: string, args = {}) {',
      "  return lead.ctx.call(HostMethod.PluginsInvoke, { project: lead.run.project, threadId: lead.threadId, name, args });",
      "}",
    ].join("\n");
    await writeFile(path.join(ws, JOURNAL), `${copy.replace(reexport, ownCall)}\n// the agent's own change\n`);
    const report = await applySeed({
      seedDir: shipped,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(root, "backup"),
    });
    assert.ok(report.kept.includes(JOURNAL));
    assert.deepEqual(report.outdatedCalls ?? [], []);
    const move = report.moved.find((m) => m.from === JOURNAL);
    assert.equal(move?.to, "loop/unreal/lead-steps.ts");
    assert.deepEqual(move?.names, ["unrealTool"]);
    // The runner's own plugin calls are the C++ module's now: every other editor step is a plugin's, at
    // Genex's moments. `editor-life.ts` is the shim older kept copies still import, called by nothing.
    assert.deepEqual([...(move?.callers ?? [])].sort(), [
      "loop/unreal/editor-life.ts",
      "loop/unreal/lead-between.ts",
      "loop/unreal/lead.ts",
    ]);
  });

  it("the boot writes an outdated call into the agent's memory, and takes it back once the copy takes Genex's checkpoint", async () => {
    const resources = await makeResources();
    const userData = path.join(await tmpDir("seed-call-boot-"), "userData");
    const boot = async () => {
      // This characterizes seed memory, without agents or a process-wide network bridge.
      const core = new StudioCore({
        paths: { userData, resources },
        engines: [],
        sandbox: false,
        execPath: process.execPath,
        executionPolicy: { runBackgroundImprovement: false },
      });
      closeBeforeCleanup(() => core.stop());
      await core.init();
      return core;
    };
    const memoryOf = async (core: StudioCore) =>
      ((await core.store.readArtifact(core.mainThread, "memory")) ?? {}) as Record<string, unknown>;
    const first = await boot();
    const turn = path.join(first.layout.harnessWs, TURN);
    const shippedTurn = await readFile(turn, "utf8");
    await writeFile(
      turn,
      `${shippedTurn.replaceAll("endOfTurnCheckpoint(", "saveUnrealTurn(")}\n// the agent's own change\n`,
    );

    const second = await boot();
    assert.match(String((await memoryOf(second))[`${SEED_CALL_MEMORY_PREFIX}${TURN}`]), /calls the host the older way/);

    // The agent carries the new call into its copy.
    await writeFile(turn, `${shippedTurn}\n// the agent's own change, on the new shape\n`);
    const third = await boot();
    assert.ok(!(`${SEED_CALL_MEMORY_PREFIX}${TURN}` in (await memoryOf(third))), "the note is gone");
  });
});

/**
 * Steer added names the loop needs to two modules that already shipped. A seed upgrade keeps
 * either file once the agent edited it, so a name steer needs must come from a module of its
 * own: imported from the kept older copy, it fails to link, the harness does not load, and the
 * watchdog rewinds the agent's edits.
 */
describe("seed upgrade across steer", () => {
  const vintage = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/seed-exports-pre-steer.json", import.meta.url)), "utf8"),
  ) as { modules: Record<string, string[]> };
  const shipped = path.resolve(fileURLToPath(new URL("../../src/harness-seed", import.meta.url)));

  it("an agent that edited its message queue and studio state before steer keeps them, and the harness still loads", async () => {
    const root = await tmpDir("seed-steer-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
    // The agent's copies of the older vintage: every name each exported then, and nothing newer.
    for (const [rel, names] of Object.entries(vintage.modules)) {
      const older = names.map((name) => `export const ${name} = () => ${JSON.stringify(name)};`);
      await writeFile(path.join(ws, rel), `${older.join("\n")}\n// the agent's own change\n`);
    }

    const report = await applySeed({
      seedDir: shipped,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(root, "backup"),
    });
    for (const rel of Object.keys(vintage.modules))
      assert.ok(report.kept.includes(keptAt(rel)), `${rel} is the agent's`);

    // What the bootstrap does: import the workspace's own main.ts. A sibling importing a name the
    // kept copies never exported would throw here, at link time.
    const main = await linkIsolated(path.join(ws, "loop", "main.ts"));
    assert.equal(main.createStudio, "function");
  });
});

/**
 * Messages without a queue added switches, waits that end when the person writes, and workers that
 * carry into a Loop, to modules that already shipped. A seed upgrade keeps any of them once the
 * agent edited it, so every name the change needs comes from a module of its own.
 */
describe("seed upgrade across messages without a queue", () => {
  const vintage = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/seed-exports-pre-no-queue.json", import.meta.url)), "utf8"),
  ) as { modules: Record<string, string[]> };
  const shipped = path.resolve(fileURLToPath(new URL("../../src/harness-seed", import.meta.url)));

  it("an agent that edited its queue, chat turn, workers or lead before the change keeps them, and the harness still loads", async () => {
    const root = await tmpDir("seed-no-queue-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
    for (const rel of [
      "loop/steer-switch.ts",
      "loop/steer-switch-prompts.ts",
      "loop/turn-switch.ts",
      "loop/person-wrote.ts",
      "loop/workers/carry.ts",
    ])
      assert.ok(await pathExists(path.join(ws, rel)), `${rel} is seeded`);
    // The agent's copies of the older vintage: every name each exported then, and nothing newer.
    for (const [rel, names] of Object.entries(vintage.modules)) {
      const older = names.map((name) => `export const ${name} = () => ${JSON.stringify(name)};`);
      await writeFile(path.join(ws, rel), `${older.join("\n")}\n// the agent's own change\n`);
    }
    const report = await applySeed({
      seedDir: shipped,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(root, "backup"),
    });
    for (const rel of Object.keys(vintage.modules))
      assert.ok(report.kept.includes(keptAt(rel)), `${rel} is the agent's`);
    const main = await linkIsolated(path.join(ws, "loop", "main.ts"));
    assert.equal(main.createStudio, "function");
  });

  it("a lead goes on hearing the chat in its wrap-up only while the chat's queue and door both keep what it is told", async () => {
    const root = await tmpDir("seed-no-queue-wrap-");
    const wake = (ws: string) => path.join(ws, "loop", "director", "wake.ts");
    const fresh = path.join(root, "fresh");
    await applySeed({ seedDir: shipped, workspaceDir: fresh, manifestFile: path.join(root, "fresh.json") });
    assert.equal(await callIsolated(wake(fresh), "wrapUpKeeps"), true);
    for (const rel of ["loop/message-queue.ts", "loop/live-chat.ts"]) {
      const ws = path.join(root, path.basename(rel, ".ts"));
      const manifest = path.join(root, `${path.basename(rel, ".ts")}.json`);
      await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
      // The agent's copy from before the change: the names it exported then, and nothing newer.
      const older = vintage.modules[rel].map((name) => `export const ${name} = () => ${JSON.stringify(name)};`);
      await writeFile(path.join(ws, rel), `${older.join("\n")}\n// the agent's own change\n`);
      await applySeed({
        seedDir: shipped,
        workspaceDir: ws,
        manifestFile: manifest,
        backupDir: path.join(ws, "..", "b"),
      });
      assert.equal(await callIsolated(wake(ws), "wrapUpKeeps"), false, `${rel} kept from before: the line shuts`);
    }
  });
});

/**
 * Live chat during a build gave the queue, the run's start and the wake loop names they had not
 * exported: the lead's door, the run's close before its self-improvement pass, the line a run's
 * lead takes the chat on. A seed upgrade keeps any of those modules once the agent edited it, so
 * each name live chat needs comes from a module of its own (loop/live-chat.ts,
 * loop/director/lead-line.ts, loop/director/live-prompts.ts); imported from a kept older copy it
 * would fail to link, and the harness would not load.
 */
describe("seed upgrade across live chat", () => {
  const vintage = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/seed-exports-pre-live.json", import.meta.url)), "utf8"),
  ) as { modules: Record<string, string[]> };
  const shipped = path.resolve(fileURLToPath(new URL("../../src/harness-seed", import.meta.url)));

  it("an agent that edited its queue, run start or director before live chat keeps them, and the harness still loads", async () => {
    const root = await tmpDir("seed-live-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
    // The new modules live chat added are laid down beside the agent's older copies.
    for (const rel of ["loop/live-chat.ts", "loop/director/lead-line.ts", "loop/director/live-prompts.ts"])
      assert.ok(await pathExists(path.join(ws, rel)), `${rel} is seeded`);
    // The agent's copies of the older vintage: every name each exported then, and nothing newer.
    for (const [rel, names] of Object.entries(vintage.modules)) {
      const older = names.map((name) => `export const ${name} = () => ${JSON.stringify(name)};`);
      await writeFile(path.join(ws, rel), `${older.join("\n")}\n// the agent's own change\n`);
    }

    const report = await applySeed({
      seedDir: shipped,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(root, "backup"),
    });
    for (const rel of Object.keys(vintage.modules))
      assert.ok(report.kept.includes(keptAt(rel)), `${rel} is the agent's`);

    // What the bootstrap does: import the workspace's own main.ts. Live chat importing a name the
    // kept copies never exported would throw here, at link time.
    const main = await linkIsolated(path.join(ws, "loop", "main.ts"));
    assert.equal(main.createStudio, "function");
  });

  it("a steer-delivery.ts kept from before live chat: a Resume's inbox hands nothing over twice", async () => {
    const root = await tmpDir("seed-live-steer-");
    const ws = path.join(root, "workspace");
    await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: path.join(root, "manifest.json") });
    // The agent's copy from before live chat: its vocabulary has no `Lead`.
    const older = (vintage.modules["loop/steer-delivery.ts"] ?? []).map(
      (name) => `export const ${name} = { Prompt: "prompt", Native: "native", Interrupt: "interrupt" };`,
    );
    await writeFile(path.join(ws, "loop", "steer-delivery.ts"), `${older.join("\n")}\n// the agent's own change\n`);
    const inbox = (await import(pathToFileURL(path.join(ws, "loop", "run-inbox.ts")).href)) as {
      createRunInbox: (
        ctx: unknown,
        at: { threadId: string; runId: string },
      ) => {
        addressed(): Promise<Array<{ facetId: string; text: string }>>;
        backlog(): Promise<string[]>;
      };
    };
    // A steer to the sky worker, already handed over before the pause (no `how`: not a lead's).
    const log = [
      {
        id: "e1",
        data: { type: "custom", event_type: "run_steering", payload: { runId: "r", text: "pinker", facetId: "sky" } },
      },
      {
        id: "e2",
        data: {
          type: "custom",
          event_type: "run_steering_delivered",
          payload: { runId: "r", messageId: "e1", facetId: "sky", stage: "now" },
        },
      },
    ];
    const appended: unknown[] = [];
    const ctx = {
      call: async (method: string, params: { batch?: unknown[] }) => {
        if (method === "events.list") return log;
        if (method === "events.append") appended.push(...(params.batch ?? []));
        return null;
      },
    };
    const resumed = inbox.createRunInbox(ctx, { threadId: "t", runId: "r" });
    assert.deepEqual(await resumed.addressed(), [], "the sky worker was told already");
    assert.deepEqual(await resumed.backlog(), [], "nothing is unread");
    assert.deepEqual(appended, [], "nothing is handed over a second time");
  });

  it("a queue kept from before live chat: the build's start does not say its lead takes the chat", async () => {
    const live = (await import("../../src/harness-seed/loop/live-chat-served.ts")) as {
      serveLiveChat?: (queue: Readonly<Record<string, unknown>>) => void;
      servesLiveChat?: () => boolean;
    };
    assert.equal(typeof live.serveLiveChat, "function", "main.ts tells live chat which queue it wired");
    const older = Object.fromEntries((vintage.modules["loop/message-queue.ts"] ?? []).map((name) => [name, name]));
    try {
      live.serveLiveChat?.(older);
      assert.equal(live.servesLiveChat?.(), false, "an older queue keeps every message behind the build");
      live.serveLiveChat?.(await import("../../src/harness-seed/loop/message-queue.ts"));
      assert.equal(live.servesLiveChat?.(), true, "today's queue hands a message to the lead");
    } finally {
      live.serveLiveChat?.({});
    }
  });
});

/**
 * The same agent after the build: once a lead's run is over, the chat's next message goes to the
 * chat's own session with the run's controls, not to a coordinator. A seed upgrade keeps any module
 * that path touches once the agent edited it, so each name it needs comes from a module of its own
 * (loop/after-loop-run.ts, loop/after-loop-run-prompts.ts); imported from a kept older copy it would fail
 * to link, and the harness would not load. And where a kept older chat turn or brief would give that
 * session no run controls, the chat asks first (`ownSessionAfterNight`) and the coordinator answers.
 */
describe("seed upgrade across the same agent after the build", () => {
  const vintage = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/seed-exports-pre-after-loop-run.json", import.meta.url)), "utf8"),
  ) as { modules: Record<string, string[]> };
  const shipped = path.resolve(fileURLToPath(new URL("../../src/harness-seed", import.meta.url)));
  /** An older copy of a module as the agent kept it: every name it exported then, and nothing newer. */
  const olderCopy = (rel: string): string => {
    const older = vintageExports(vintage.modules, rel).map(
      (name) => `export const ${name} = () => ${JSON.stringify(name)};`,
    );
    // As a seed upgrade leaves the agent's copy: its old names rewritten (seed-renames.ts).
    return renameInSource(rel, `${older.join("\n")}\n// the agent's own change\n`);
  };

  it("an agent that edited its chat turn, its brief or its dispatch before it keeps them, and the harness still loads", async () => {
    const root = await tmpDir("seed-after-run-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
    // The new modules the after-run chat added are laid down beside the agent's older copies.
    for (const rel of ["loop/after-loop-run.ts", "loop/after-loop-run-prompts.ts"])
      assert.ok(await pathExists(path.join(ws, rel)), `${rel} is seeded`);
    for (const rel of Object.keys(vintage.modules)) await writeFile(path.join(ws, rel), olderCopy(rel));

    const report = await applySeed({
      seedDir: shipped,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(root, "backup"),
    });
    for (const rel of Object.keys(vintage.modules))
      assert.ok(report.kept.includes(keptAt(rel)), `${rel} is the agent's`);

    // What the bootstrap does: import the workspace's own main.ts. The after-run chat importing a
    // name the kept copies never exported would throw here, at link time.
    const main = await linkIsolated(path.join(ws, "loop", "main.ts"));
    assert.equal(main.createStudio, "function");
  });

  it("a chat turn, the runner that picks it or its brief kept from before: the chat after a lead's run is the coordinator's again", async () => {
    /** Whether a workspace whose `kept` module is the agent's older copy sends the chat after a run to its own session. */
    const ownSession = async (kept: string | null): Promise<unknown> => {
      const root = await tmpDir("seed-after-run-part-");
      const ws = path.join(root, "workspace");
      await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: path.join(root, "manifest.json") });
      if (kept) await writeFile(path.join(ws, kept), olderCopy(kept));
      const dispatch = (await import(pathToFileURL(path.join(ws, "loop", "chat-dispatch.ts")).href)) as {
        ownSessionAfterLoopRun?: () => boolean;
      };
      return dispatch.ownSessionAfterLoopRun ? dispatch.ownSessionAfterLoopRun() : null;
    };
    assert.equal(await ownSession(null), true, "every part serves it: the chat's own session answers");
    // turn-loop.ts is the runner between the dispatch and the chat turn: a kept one may not hand
    // the turn the run it answers after.
    const parts = ["loop/delegated-turn.ts", "loop/chat-session.ts", "loop/turn-loop.ts"];
    const seen: Array<{ kept: string; ownSession: unknown }> = [];
    for (const kept of parts) seen.push({ kept, ownSession: await ownSession(kept) });
    assert.deepEqual(
      seen,
      parts.map((kept) => ({ kept, ownSession: false })),
      "an older chat turn, runner or brief would give that session no run controls and tell it to pick up where it left off",
    );
  });
});

/**
 * A finished build reopened: after a build whose run seated a lead has finished, a message with
 * Loop on that asks for more reopens the same run with a fresh budget — through the chat's own
 * session, or the run's coordinator (loop/reopen-run.ts, and the run's side loop/director/reopen.ts). A seed upgrade keeps any module that path touches once the
 * agent edited it, so each name the reopen needs comes from a module of its own; imported from a
 * kept older copy it would fail to link, and the harness would not load.
 */
describe("seed upgrade across a finished build reopened", () => {
  const vintage = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/seed-exports-pre-reopen.json", import.meta.url)), "utf8"),
  ) as { modules: Record<string, string[]> };
  const shipped = path.resolve(fileURLToPath(new URL("../../src/harness-seed", import.meta.url)));
  /**
   * An older copy of a module as the agent kept it: every name it exported then, and nothing newer.
   * Its `SERVES_*` marks stay `true`, so a row isolates the one mark the reopen adds.
   */
  const olderCopy = (rel: string): string => {
    const older = vintageExports(vintage.modules, rel).map((name) =>
      name.startsWith("SERVES_")
        ? `export const ${name} = true;`
        : `export const ${name} = () => ${JSON.stringify(name)};`,
    );
    // As a seed upgrade leaves the agent's copy: its old names rewritten (seed-renames.ts).
    return renameInSource(rel, `${older.join("\n")}\n// the agent's own change\n`);
  };

  it("a chat turn, its runner, the after-run words, the coordinator or the run's start kept from before: no finished build reopens through what it serves, and the chat's own session still answers after it", async () => {
    /** What a workspace whose `kept` module is the agent's older copy does after a lead's finished run. */
    const serves = async (kept: string | null): Promise<unknown> => {
      const root = await tmpDir("seed-reopen-part-");
      const ws = path.join(root, "workspace");
      await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: path.join(root, "manifest.json") });
      if (kept) await writeFile(path.join(ws, kept), olderCopy(kept));
      const dispatch = (await import(pathToFileURL(path.join(ws, "loop", "chat-dispatch.ts")).href)) as {
        ownSessionAfterLoopRun?: () => boolean;
        ownSessionReopens?: () => boolean;
        coordinatorReopens?: () => boolean;
      };
      return {
        afterLoopRun: dispatch.ownSessionAfterLoopRun?.() ?? null,
        reopens: dispatch.ownSessionReopens?.() ?? null,
        coordinatorReopens: dispatch.coordinatorReopens?.() ?? null,
      };
    };
    assert.deepEqual(
      await serves(null),
      { afterLoopRun: true, reopens: true, coordinatorReopens: true },
      "every part serves it: the chat's own session, or the run's coordinator, reopens a finished build",
    );
    const rows = [
      // An older chat part would plan on the commission's model, bridge the launch or word the old
      // rules: the session does the work itself, and the coordinator still reopens.
      { kept: "loop/turn-loop.ts", serves: { afterLoopRun: true, reopens: false, coordinatorReopens: true } },
      { kept: "loop/delegated-turn.ts", serves: { afterLoopRun: true, reopens: false, coordinatorReopens: true } },
      {
        kept: "loop/after-loop-run-prompts.ts",
        serves: { afterLoopRun: true, reopens: false, coordinatorReopens: true },
      },
      // An older coordinator or its prompt would never tell it the Loop: it continues the work as with Loop off.
      { kept: "loop/coordinator.ts", serves: { afterLoopRun: true, reopens: true, coordinatorReopens: false } },
      { kept: "loop/coordinator-prompts.ts", serves: { afterLoopRun: true, reopens: true, coordinatorReopens: false } },
      // An older start would read the reopened run's inbox from its start: neither reopens.
      { kept: "loop/run-dispatch.ts", serves: { afterLoopRun: true, reopens: false, coordinatorReopens: false } },
    ];
    const seen: Array<{ kept: string; serves: unknown }> = [];
    for (const { kept } of rows) seen.push({ kept, serves: await serves(kept) });
    assert.deepEqual(seen, rows);
  });
});

/**
 * One Loop for every project changed shipped parts (the run's dispatch and its runner vocabulary,
 * the chat's dispatch, brief and launch words, the reopen, the director's setup, session, wake and
 * run record, SkillOpt) and gave them new modules to import (`loop/director/open/`,
 * `loop/loop-switch.ts`, `loop/engine-seat.ts`, `loop/open-loop-prompts.ts`, `loop/builtin-hooks.ts`, `loop/loop-skills.ts`).
 * Any of those parts may be one the agent edited and a seed upgrade keeps at the older vintage: each
 * new name comes from a module of its own, so a current part beside one older copy still links,
 * through the loop, every local turn's prompt and the Unreal runner.
 */
describe("seed upgrade across one Loop for every project", () => {
  const shipped = path.resolve(fileURLToPath(new URL("../../src/harness-seed", import.meta.url)));

  it("a kept part that doesn't serve a Loop in place refuses such a Loop at its start, with words, and is noticed", {
    timeout: 120_000,
  }, async () => {
    const OPEN_LOOP_PARTS = [
      "loop/director.ts",
      "loop/director/setup.ts",
      "loop/director/wake.ts",
      "loop/director/wake-schedule.ts",
      "loop/director/open/contract.ts",
      "loop/builtin-hooks.ts",
      "loop/studio-state.ts",
      "loop/run-dispatch.ts",
    ];
    /** The run's start: the chat's launch reads it beside the parts. */
    const RUN_START = "loop/run-dispatch.ts";
    const outcomes: Array<{
      part: string;
      refused: unknown;
      delegated: number;
      noticed: boolean;
      launch: string;
      promised: boolean;
    }> = [];
    for (const part of OPEN_LOOP_PARTS) {
      const root = await tmpDir("seed-open-guard-");
      const { ws, manifest } = await cloneSeededWorkspace(shipped, root);
      // The agent's copy from before Loops on any project: everything else as shipped, but no flag.
      const copy = await readFile(path.join(ws, part), "utf8");
      const older = copy.replace(/^export const SERVES_OPEN_LOOP = true;$/m, "");
      assert.notEqual(older, copy, `${part} carries the flag`);
      await writeFile(path.join(ws, part), `${older}\n// the agent's own change\n`);
      const report = await applySeed({
        seedDir: shipped,
        workspaceDir: ws,
        manifestFile: manifest,
        backupDir: path.join(root, "backup"),
      });
      const dir = await gameRepo(await copyProject(Project.GodotGame, path.join(root, "game")));
      const host = loopHost({ dir, facts: [{ id: "godot-project", path: "." }], run: { runId: "run-guard" } });
      const { handleRunStart } = (await import(pathToFileURL(path.join(ws, "loop/run-dispatch.ts")).href)) as {
        handleRunStart: (studio: unknown, action: unknown) => Promise<void>;
      };
      const ctx = host.rec.ctx;
      const studio = {
        host: ctx,
        cancels: new Set<string>(),
        stoppedMessages: new Set<string>(),
        moodBoards: new Map(),
        activeRuns: new Map(),
        startingRuns: new Map(),
        orphanRuns: new Map(),
        scoped: () => ctx,
      };
      // A kept older start can't refuse itself: the chat's launch refuses for it.
      if (part !== RUN_START)
        await handleRunStart(studio, { type: "run_start", threadId: host.threadId, run: structuredClone(host.run) });
      // The chat's launch says it before any promise: the run could not keep one.
      const chat = loopHost({ dir, facts: [{ id: "godot-project", path: "." }], threadId: "t-launch" });
      const { launchFromIntake } = (await import(pathToFileURL(path.join(ws, "loop/chat-dispatch.ts")).href)) as {
        launchFromIntake: (studio: unknown, ctx: unknown, action: unknown, spec: unknown) => Promise<void>;
      };
      const chatStudio = { ...studio, host: chat.rec.ctx, scoped: () => chat.rec.ctx };
      const spec = { goal: "A level the player walks through.", engine: "claude-code", mode: "autopilot", hours: 3 };
      const launch = await launchFromIntake(
        chatStudio,
        chat.rec.ctx,
        { threadId: chat.threadId, project: chat.game.name },
        spec,
      ).then(
        () => "launched",
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
      const promised = chat.rec
        .paramsOf("events.append")
        .some((params) => JSON.stringify(params.batch).includes('"role":"assistant"'));
      outcomes.push({
        part,
        refused: host.appended("run_finished")[0]?.stoppedBecause,
        delegated: host.rec.paramsOf("engine.delegate").length,
        noticed: (report.outdatedCalls ?? []).includes(part) || !SEED_CALL_CHANGES.some((row) => row.file === part),
        launch,
        promised,
      });
      await removeTree(root);
    }
    assert.deepEqual(
      outcomes,
      OPEN_LOOP_PARTS.map((part) => ({
        part,
        refused: part === RUN_START ? undefined : OPEN_LOOP_REFUSAL.openLoopNeedsUpdate,
        delegated: 0,
        noticed: true,
        launch: OPEN_LOOP_REFUSAL.openLoopNeedsUpdate,
        promised: false,
      })),
    );
  });
});

/**
 * Genex's moments changed parts of the harness (the chat turn, its brief and offer, the director's
 * start, wake, tools and builders, the worker pool, the Unreal lead's modules) and gave them a module
 * to import (`loop/hooks.ts`). Any of those parts may be one the agent edited and a seed upgrade keeps
 * at the older vintage: each new name comes from a module of its own, so a current part beside one
 * older copy still links, through the loop, every local turn's prompt and the Unreal lead.
 */
describe("seed upgrade across Genex's moments", () => {
  const shipped = path.resolve(fileURLToPath(new URL("../../src/harness-seed", import.meta.url)));

  it("a kept host-method table without the moments', locks' and finish check's methods is reported once and noted for the agent", async () => {
    const root = await tmpDir("seed-moments-methods-");
    const { ws, manifest } = await cloneSeededWorkspace(shipped, root);
    const file = "loop/host-methods.ts";
    const copy = await readFile(path.join(ws, file), "utf8");
    const newer = [
      "LocksHold",
      "LocksRelease",
      "CheckpointTake",
      "HooksFire",
      "ObserversCapture",
      "FinishReview",
      "FinishSettle",
    ];
    const older = copy
      .split("\n")
      .filter((line) => !newer.some((name) => line.trim().startsWith(`${name}:`)))
      .join("\n");
    assert.notEqual(older, copy, "the shipped table has the newer methods");
    await writeFile(path.join(ws, file), `${older}\n// the agent's own change\n`);
    const report = await applySeed({
      seedDir: shipped,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(root, "backup"),
    });
    assert.deepEqual(report.outdatedCalls ?? [], [file], "reported once");
    const note = String(seedCallMemory({}, report.outdatedCalls ?? [])[`${SEED_CALL_MEMORY_PREFIX}${file}`]);
    assert.match(note, /calls the host the older way/);
    assert.match(note, /calls the host the older way/);
    assert.match(note, /calls the host the older way/);
    assert.match(note, /calls the host the older way/);
    assert.ok(note.length <= 300, "one memory value stays within the memory policy's limit");
    await removeTree(root);
  });
});
