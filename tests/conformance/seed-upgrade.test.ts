/**
 * Seed upgrades — the fix for the trap that bit twice on day one: the harness workspace was
 * seeded only when missing, so app-shipped fixes never reached an existing install.
 *
 * The invariant under test: **the agent owns its edits, the app owns everything the agent
 * never touched.** Upgrades flow through untouched files; edited files are never overwritten.
 */
import assert from "node:assert/strict";
import { appendFile, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  applySeed,
  craftCheckOwners,
  reconcileManifestWithSeedVintages,
  retireMigratedCraftChecks,
  RETIRED_SEED_PATHS,
  SEED_CALL_CHANGES,
  SEED_MOVES,
  SUPERSEDED_CHECKS,
  type SeedUpgradeReport,
} from "../../src/substrate/seed-upgrade.ts";
import { RENAMED_SEED_FILES, RENAMED_SEED_NAMES, renameInSource } from "../../src/substrate/seed-renames.ts";
import {
  SEED_CALL_MEMORY_PREFIX,
  SEED_MOVE_MEMORY_PREFIX,
  seedCallMemory,
  seedMoveMemory,
  seedUpgradedPayload,
} from "../../src/main/seed-upgrade-notice.ts";
import { atomicWriteJson, pathExists } from "../../src/substrate/fsx.ts";
import { StudioCore } from "../../src/main/studio-core.ts";
import { makeResources } from "../helpers/resources.ts";
import { closeBeforeCleanup, tmpDir } from "../helpers/tmp.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { studioActivity } from "../../src/shared/studio-activity.ts";
import { toEntries } from "../../src/renderer/chat-entries.ts";
import type { EventEnvelope } from "../../src/substrate/types.ts";
import { SEED_GENERATED } from "../../scripts/gen-harness-types.ts";

/** Where an upgrade keeps the agent's copy of `rel`: a renamed module's new path (seed-renames.ts). */
const keptAt = (rel: string): string => RENAMED_SEED_FILES[rel] ?? rel;

/** A name an older vintage exported, as an upgrade rewrites it in the agent's kept copy. */
const renamedName = (name: string): string => RENAMED_SEED_NAMES[name] ?? name;

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

it("AG-931 ships new optimizer modules while preserving a self-edited Autopilot loop", async () => {
  const { seed, ws, manifest } = await rig();
  const old = "// earlier Autopilot\n";
  await writeFile(path.join(seed, "loop/autopilot.ts"), old);
  await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
  await writeFile(path.join(ws, "loop/autopilot.ts"), "// user-owned custom loop\n");
  for (const file of ["autopilot.ts", "optimization.ts", "performance.ts"]) {
    await writeFile(path.join(seed, "loop", file), await readFile(path.resolve("src/harness-seed/loop", file)));
  }
  const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
  assert.ok(report.kept.includes("loop/autopilot.ts"));
  assert.ok(report.added.includes("loop/optimization.ts"));
  assert.ok(report.added.includes("loop/performance.ts"));
  assert.equal(await readFile(path.join(ws, "loop/autopilot.ts"), "utf8"), "// user-owned custom loop\n");
  assert.match(await readFile(path.join(ws, "loop/optimization.ts"), "utf8"), /runOptimization/);
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

/**
 * M4.7 — the craft migration runs on live user data. The catalogue on a machine that has had
 * runs is a mixture the seed does not own: only `origin: "seed"` entries are the seed's to
 * move, only an id a shipped recipe owns may be moved at all, the move keeps every statistic,
 * and a keeper whose body this change corrected has to be brought up to date rather than left
 * at its old definition for ever.
 */
describe("the craft migration on an installed catalogue", () => {
  const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const seedCatalogue = JSON.parse(
    readFileSync(path.join(repoRoot, "src/harness-seed/library/checks.json"), "utf8"),
  ) as { checks: Record<string, Record<string, unknown>> };
  const frozen = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/catalogue-af065b2.json"), "utf8"))
    .checks as Record<string, Record<string, unknown>>;

  /** A seed holding the five keepers and just the recipes the cases below need. */
  async function craftRig(withCatalogue = true) {
    const root = await tmpDir("craft-migration-");
    const seed = path.join(root, "seed");
    await mkdir(path.join(seed, "library", "recipes"), { recursive: true });
    await writeFile(path.join(seed, "loop", "..", "package.json"), '{"name":"harness"}\n');
    for (const recipe of ["flora.leaf-cards", "flora.organic-not-solid", "grade.mid-tone-blackpoint"]) {
      await writeFile(
        path.join(seed, "library", "recipes", `${recipe}.json`),
        await readFile(path.join(repoRoot, "src/harness-seed/library/recipes", `${recipe}.json`), "utf8"),
      );
    }
    if (withCatalogue)
      await writeFile(
        path.join(seed, "library", "checks.json"),
        await readFile(path.join(repoRoot, "src/harness-seed/library/checks.json"), "utf8"),
      );
    return {
      seed,
      ws: path.join(root, "workspace"),
      manifest: path.join(root, "manifest.json"),
      backup: path.join(root, "backup"),
    };
  }

  /** What one machine's catalogue looked like the run before the migration. */
  function installed() {
    const entry = (id: string, over: Record<string, unknown>) => ({ ...frozen[id]!, ...over });
    return {
      version: 1,
      checks: {
        // A seeded opinion with a recipe waiting for it, and a run's statistics on it.
        "foliage-is-cards": entry("foliage-is-cards", {
          origin: "seed",
          uses: 7,
          passes: 2,
          catches: 3,
          runs: ["r1", "r2"],
        }),
        // The same body, but a planner wrote this one: not the seed's to move.
        "organic-not-solid": entry("organic-not-solid", { origin: "planner", uses: 4, passes: 4 }),
        // A keeper the seed still ships, at its OLD body (the pitch band).
        "camera-player-eye": entry("camera-player-eye", { origin: "seed", uses: 5, passes: 1 }),
        // A keeper the seed renamed.
        "fire-registers": entry("fire-registers", { origin: "seed", uses: 2, passes: 1 }),
        // A keeper the seed still ships, whose weight and needs changed.
        "player-moved": entry("player-moved", { origin: "seed", uses: 9, passes: 8 }),
        // A seeded opinion with a recipe, never used.
        "grade-band": entry("grade-band", { origin: "seed", uses: 1, passes: 0 }),
        // Something a planner grew that no seed ever knew about.
        "hand-written": {
          kind: "pixel",
          camera: "default",
          expr: "meanLuma > 0.1",
          origin: "planner",
          uses: 1,
          passes: 1,
        },
      },
    };
  }

  async function migrate() {
    const rig = await craftRig();
    await applySeed({ seedDir: rig.seed, workspaceDir: rig.ws, manifestFile: rig.manifest });
    await atomicWriteJson(path.join(rig.ws, "library", "checks.json"), installed());
    const report = await applySeed({
      seedDir: rig.seed,
      workspaceDir: rig.ws,
      manifestFile: rig.manifest,
      backupDir: rig.backup,
    });
    const after = JSON.parse(await readFile(path.join(rig.ws, "library", "checks.json"), "utf8")) as {
      version: number;
      checks: Record<string, Record<string, unknown>>;
      retired?: Record<string, Record<string, unknown>>;
    };
    return { rig, report, after };
  }

  it("moves only what the seed put there and a recipe now owns, keeping every statistic", async () => {
    const { after } = await migrate();
    assert.equal(after.version, 2, "the retired map needs version 2");

    const retired = after.retired ?? {};
    assert.deepEqual(Object.keys(retired).sort(), ["fire-registers", "foliage-is-cards", "grade-band"]);
    assert.equal(retired["foliage-is-cards"]!.uses, 7, "the move keeps the numbers the runs earned");
    assert.equal(retired["foliage-is-cards"]!.passes, 2);
    assert.equal(retired["foliage-is-cards"]!.catches, 3);
    assert.deepEqual(retired["foliage-is-cards"]!.runs, ["r1", "r2"]);
    assert.equal(
      retired["foliage-is-cards"]!.js,
      frozen["foliage-is-cards"]!.js,
      "the whole entry moves, body included",
    );
    assert.equal(retired["foliage-is-cards"]!.retiredTo, "flora.leaf-cards", "and it says where to find it now");
    assert.equal(retired["foliage-is-cards"]!.retiredBy, "seed-upgrade");
    assert.match(String(retired["foliage-is-cards"]!.retiredAt), /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(retired["grade-band"]!.retiredTo, "grade.mid-tone-blackpoint");
    // A seed id the seed dropped by RENAME has no recipe; the superseded map is what retires it.
    assert.equal(retired["fire-registers"]!.retiredTo, "primary-action-registers");

    // A planner's own entry with the same id and the same body is untouched.
    assert.ok(after.checks["organic-not-solid"], "a planner-origin entry is not the seed's to move");
    assert.equal(after.checks["organic-not-solid"]!.uses, 4);
    assert.ok(after.checks["hand-written"], "and neither is anything the runs grew");
  });

  it("refreshes a keeper the seed still ships instead of leaving the old definition for ever", async () => {
    const { after } = await migrate();
    const eye = after.checks["camera-player-eye"]!;
    assert.ok(eye, "a keeper is never retired");
    assert.equal(eye.js, seedCatalogue.checks["camera-player-eye"]!.js, "the definition comes from the seed");
    assert.doesNotMatch(String(eye.js), /pitch/, "the follow-camera band left for the recipe");
    assert.equal(eye.weight, "normal");
    assert.equal(eye.note, seedCatalogue.checks["camera-player-eye"]!.note);
    assert.equal(eye.uses, 5, "the statistics are the install's, not the seed's");
    assert.equal(eye.passes, 1);
    assert.equal(eye.origin, "seed");

    const moved = after.checks["player-moved"]!;
    assert.equal(moved.weight, "normal", "no longer an identity check nobody can measure");
    // needs now names the paths the check's own delta() reads: with "player" alone the early
    // half of the gate could never fire, and a lazily created player read as a pass.
    assert.deepEqual(moved.needs, ["player.x", "player.z"]);
    assert.equal(moved.expr, seedCatalogue.checks["player-moved"]!.expr);
    assert.equal(moved.uses, 9);

    // The three ids the install never had arrive by the ordinary merge.
    for (const id of ["demo-walk", "drawcalls-ceiling", "primary-action-registers"])
      assert.ok(after.checks[id], `${id} reached the install`);
    assert.equal(after.checks["drawcalls-ceiling"]!.expr, seedCatalogue.checks["drawcalls-ceiling"]!.expr);
  });

  it("backs the catalogue up before the first write, and a second boot changes nothing", async () => {
    const { rig, report, after } = await migrate();
    const backedUp = JSON.parse(await readFile(path.join(rig.backup, "library", "checks.json"), "utf8")) as {
      checks: Record<string, unknown>;
    };
    assert.ok(backedUp.checks["foliage-is-cards"], "the pre-migration file is recoverable");
    assert.ok(backedUp.checks["fire-registers"]);
    assert.ok(
      report.updated.some((line) => line.startsWith("library/checks.json (")),
      JSON.stringify(report.updated),
    );

    const before = await readFile(path.join(rig.ws, "library", "checks.json"), "utf8");
    const second = await applySeed({
      seedDir: rig.seed,
      workspaceDir: rig.ws,
      manifestFile: rig.manifest,
      backupDir: rig.backup,
    });
    assert.equal(
      await readFile(path.join(rig.ws, "library", "checks.json"), "utf8"),
      before,
      "idempotent: the second pass writes nothing",
    );
    assert.ok(second.kept.includes("library/checks.json"), JSON.stringify(second));
    const again = JSON.parse(before) as { retired: Record<string, Record<string, unknown>> };
    assert.equal(
      again.retired["foliage-is-cards"]!.retiredAt,
      after.retired!["foliage-is-cards"]!.retiredAt,
      "retiredAt is stamped once",
    );
    // And a retired id is never copied back in by the merge on the next boot.
    assert.equal(again.retired["foliage-is-cards"]!.retiredTo, "flora.leaf-cards");
  });

  it("still copies the catalogue in when a manifest exists and nothing is on disk", async () => {
    const rig = await craftRig(false);
    await applySeed({ seedDir: rig.seed, workspaceDir: rig.ws, manifestFile: rig.manifest });
    assert.equal(await pathExists(path.join(rig.ws, "library", "checks.json")), false);
    // The app ships the catalogue for the first time: the guarded branch must fall through.
    await writeFile(
      path.join(rig.seed, "library", "checks.json"),
      await readFile(path.join(repoRoot, "src/harness-seed/library/checks.json"), "utf8"),
    );
    const report = await applySeed({
      seedDir: rig.seed,
      workspaceDir: rig.ws,
      manifestFile: rig.manifest,
      backupDir: rig.backup,
    });
    assert.ok(report.added.includes("library/checks.json"), JSON.stringify(report));
    const copied = JSON.parse(await readFile(path.join(rig.ws, "library", "checks.json"), "utf8")) as {
      checks: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(copied.checks).sort(), [
      "camera-player-eye",
      "demo-walk",
      "drawcalls-ceiling",
      "player-moved",
      "primary-action-registers",
    ]);
  });

  it("retires nothing when the seed ships no recipes to retrieve from", async () => {
    const root = await tmpDir("craft-no-recipes-");
    const seed = path.join(root, "seed");
    await mkdir(path.join(seed, "library"), { recursive: true });
    await writeFile(
      path.join(seed, "library", "checks.json"),
      await readFile(path.join(repoRoot, "src/harness-seed/library/checks.json"), "utf8"),
    );
    const target = path.join(root, "checks.json");
    await atomicWriteJson(target, installed());
    assert.deepEqual(await retireMigratedCraftChecks(target, seed), { retired: [], refreshed: [] });
    const after = JSON.parse(await readFile(target, "utf8")) as { checks: Record<string, unknown> };
    assert.ok(after.checks["foliage-is-cards"], "an id with nowhere to go stays on the board");
  });

  it("never retires a check the install's own recipes cannot answer for", async () => {
    // The install that has had runs is the one this migration is aimed at, and on it the
    // recipe files are the agent's: written back after every recipe outcome by the build that
    // shipped them, before the stats sidecar existed. The ownership rule KEEPS such a copy —
    // and a copy written before craft existed carries no `kind`, so `normalizeRecipe` reads it
    // as a technique and no craft path (the planner's menu, a plan naming the recipe id, THE
    // FIX's named recipe) can see it. Retiring against the seed's recipes alone struck the
    // check off the board with nowhere left to retrieve it from.
    const rig = await craftRig();
    await applySeed({ seedDir: rig.seed, workspaceDir: rig.ws, manifestFile: rig.manifest });
    const kept = path.join(rig.ws, "library", "recipes", "flora.leaf-cards.json");
    const older = JSON.parse(await readFile(kept, "utf8")) as Record<string, unknown>;
    delete older.kind; // the vintage this install has: written before craft was a kind
    older.stats = { wins: 3, losses: 1 };
    await atomicWriteJson(kept, older);
    await atomicWriteJson(path.join(rig.ws, "library", "checks.json"), installed());

    const report = await applySeed({
      seedDir: rig.seed,
      workspaceDir: rig.ws,
      manifestFile: rig.manifest,
      backupDir: rig.backup,
    });
    assert.ok(report.kept.includes("library/recipes/flora.leaf-cards.json"), JSON.stringify(report.kept));
    const after = JSON.parse(await readFile(path.join(rig.ws, "library", "checks.json"), "utf8")) as {
      checks: Record<string, Record<string, unknown>>;
      retired?: Record<string, Record<string, unknown>>;
    };
    assert.ok(after.checks["foliage-is-cards"], "the check whose recipe this install cannot see stays on the board");
    assert.equal(after.retired?.["foliage-is-cards"], undefined);
    assert.equal(after.checks["foliage-is-cards"]!.uses, 7, "with its statistics untouched");
    // The install keeps its own recipe, and everything it CAN retrieve still leaves the board.
    assert.equal(
      (JSON.parse(await readFile(kept, "utf8")) as { stats: unknown }).stats !== undefined,
      true,
      "the agent's copy is still the agent's",
    );
    assert.ok(after.retired?.["grade-band"], "a check whose recipe this install does have is retired as before");
    assert.equal(after.retired!["grade-band"]!.retiredTo, "grade.mid-tone-blackpoint");
    assert.ok(after.retired?.["fire-registers"], "a rename needs no recipe at all");

    // Nothing points at a recipe the workspace cannot answer with.
    const installedOwners = await craftCheckOwners(rig.ws);
    for (const [id, entry] of Object.entries(after.retired ?? {})) {
      const to = String(entry.retiredTo);
      assert.ok(
        installedOwners.get(id) === to || SUPERSEDED_CHECKS[id] === to,
        `${id} was retired to ${to}, which this install cannot retrieve`,
      );
    }
  });

  it("derives what it may retire from the shipped recipes alone", async () => {
    const owners = await craftCheckOwners(path.join(repoRoot, "src", "harness-seed"));
    assert.equal(owners.size, 41, "one owner per retired opinion");
    assert.equal(owners.get("organic-not-solid"), "flora.organic-not-solid");
    for (const keeper of [
      "camera-player-eye",
      "player-moved",
      "drawcalls-ceiling",
      "demo-walk",
      "primary-action-registers",
    ]) {
      assert.equal(owners.has(keeper), false, `${keeper} is a keeper: no craft recipe claims it`);
    }
    assert.deepEqual(SUPERSEDED_CHECKS, { "fire-registers": "primary-action-registers" });
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
 * The harness structure change (2E-pre) moved code between files and added new ones. A seed
 * upgrade keeps every file the in-app agent edited, so a kept file of the older vintage still
 * imports its siblings by the names they had then — every one must still be exported, or the
 * harness fails to load and the watchdog rewinds the agent's work.
 */
describe("seed upgrade across the harness structure change", () => {
  const vintage = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/seed-exports-2e-pre.json", import.meta.url)), "utf8"),
  ) as {
    modules: Record<string, string[]>;
    directorImports: Record<string, string[]>;
  };
  const shipped = path.resolve(fileURLToPath(new URL("../../src/harness-seed", import.meta.url)));

  it("every module still exports every name the older vintage imported it by", async () => {
    for (const [rel, names] of Object.entries(vintage.modules)) {
      // The vintage was plain .mjs; the same module is TypeScript now.
      const module = (await import(
        new URL(`../../src/harness-seed/${rel.replace(/\.mjs$/, ".ts")}`, import.meta.url).href
      )) as Record<string, unknown>;
      // A kept file's old names are rewritten by the upgrade (seed-renames.ts), so it imports the new ones.
      const missing = names.map(renamedName).filter((name) => !(name in module));
      assert.deepEqual(missing, [], `${rel} stopped exporting what a kept file of the older vintage imports`);
    }
  });

  it("an agent that edited director.ts before the split keeps its monolith, and the harness still loads", async () => {
    const root = await tmpDir("seed-split-");
    const older = path.join(root, "older-seed");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    // The older vintage: today's seed, but with the director as one file that imports its
    // siblings the way the monolith did — and no director/ folder yet.
    await cp(shipped, older, { recursive: true });
    await rm(path.join(older, "loop", "director"), { recursive: true, force: true });
    const imported = Object.values(vintage.directorImports).flat();
    const monolith = [
      ...Object.entries(vintage.directorImports).map(
        ([from, names]) => `import { ${names.join(", ")} } from "${from.replace(/\.mjs$/, ".ts")}";`,
      ),
      `const used = [${imported.join(", ")}];`,
      // What the monolith exported: its own functions, and the one name it passed on from a sibling.
      ...vintage.modules["loop/director.mjs"]!.map((name) =>
        imported.includes(name) ? `export { ${name} };` : `export const ${name} = () => used.length;`,
      ),
    ].join("\n");
    await writeFile(path.join(older, "loop", "director.ts"), `${monolith}\n`);
    assert.equal((await applySeed({ seedDir: older, workspaceDir: ws, manifestFile: manifest })).mode, "seeded");

    // The agent edits its director; then the app ships the split.
    const edited = `${monolith}\n// the agent's own change to its director\n`;
    await writeFile(path.join(ws, "loop", "director.ts"), edited);
    const report = await applySeed({
      seedDir: shipped,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(root, "backup"),
    });

    assert.ok(report.kept.includes("loop/director.ts"), "the agent's director is kept");
    // Flipped by the rename (seed-renames.ts): kept, with the names the seed renamed rewritten.
    assert.equal(
      await readFile(path.join(ws, "loop", "director.ts"), "utf8"),
      renameInSource("loop/director.ts", edited),
    );
    const split = (await readdir(path.join(shipped, "loop", "director"))).filter((name) => name.endsWith(".ts"));
    assert.ok(split.length > 0);
    for (const name of split)
      assert.ok(report.added.includes(`loop/director/${name}`), `loop/director/${name} arrives beside it`);
    assert.deepEqual(report.retired, [], "nothing the split moved is taken away");

    // What the bootstrap does: import the workspace's own main.ts. A kept monolith importing a
    // name its new siblings no longer export would throw here, at link time.
    const main = (await import(`${pathToFileURL(path.join(ws, "loop", "main.ts")).href}?v=${Date.now()}`)) as {
      createStudio?: unknown;
    };
    assert.equal(typeof main.createStudio, "function");
  });

  /**
   * The gauntlet of the older vintage: one file that defines the evidence pass itself, as it did
   * before the move to evidence.ts. Every name it exported then is a plain function here, and
   * `edit` marks it as the agent's.
   */
  const olderGauntlet = (edit: string) =>
    [
      ...vintage.modules["loop/gauntlet.mjs"]!.map(
        (name) => `export async function ${name}() { return ${JSON.stringify(name)}; }`,
      ),
      `// ${edit}`,
    ].join("\n");

  /** An install seeded from the shipped seed whose gauntlet the agent then rewrote as `body` (null: left as shipped). */
  async function editedGauntletInstall(body: string | null) {
    const root = await tmpDir("seed-moved-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
    if (body !== null) await writeFile(path.join(ws, "loop", "gauntlet.ts"), body);
    return { root, ws, manifest };
  }

  it("an agent-edited gauntlet that still defines the evidence pass is kept, and the report says who no longer calls it", async () => {
    const edited = olderGauntlet("the agent's own fix to the evidence pass");
    const { root, ws, manifest } = await editedGauntletInstall(edited);
    const report = await applySeed({
      seedDir: shipped,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(root, "backup"),
    });

    assert.ok(report.kept.includes("loop/gauntlet.ts"), "the agent's gauntlet is kept");
    assert.equal(await readFile(path.join(ws, "loop", "gauntlet.ts"), "utf8"), edited);
    const evidence = report.moved.find((move) => move.from === "loop/gauntlet.ts" && move.to === "loop/evidence.ts");
    assert.ok(evidence, "the move to evidence.ts is reported");
    for (const name of ["gatherEvidence", "withObservationPatience", "observationOnlyFailure"])
      assert.ok(evidence.names.includes(name), name);
    // Every caller that now links to the shipped evidence pass, not to the agent's copy.
    for (const caller of [
      "loop/autopilot.ts",
      // The facet loop's evidence phase (loop/facet-loop.ts is its facade).
      "loop/facet/phases/verify.ts",
      "loop/optimization.ts",
      "loop/spike.ts",
      "loop/director/setup.ts",
    ]) {
      assert.ok(evidence.callers.includes(caller), caller);
    }
    assert.ok(!evidence.callers.includes("loop/gauntlet.ts"), "the kept file is not its own caller");
    assert.ok(
      report.moved.some(
        (move) =>
          move.from === "loop/gauntlet.ts" && move.to === "loop/git.ts" && move.names.includes("unversionedNested"),
      ),
      "unversionedNested moved to git.ts",
    );
    assert.ok(
      !report.moved.some((move) => move.from === "loop/autopilot.ts"),
      "an untouched autopilot is updated, and nothing of its moved away from the agent",
    );

    // Said to the user (the chat card and the Studio activity) and to the agent (its memory).
    const payload = seedUpgradedPayload({ ...report, mode: "upgraded" });
    assert.deepEqual(payload?.moved, report.moved);
    const event: EventEnvelope = {
      id: "upgrade",
      thread_id: "studio",
      turn_id: null,
      session_id: null,
      created_at: "2026-09-22T00:00:00Z",
      data: { type: "custom", event_type: "seed_upgraded", payload: payload! },
    };
    const chat = toEntries([event])
      .flatMap((entry) =>
        entry.kind === "activity" ? entry.rows.map((row) => row.text) : "text" in entry ? [entry.text] : [],
      )
      .join("\n");
    assert.match(chat, /loop\/gauntlet\.ts/);
    assert.match(chat, /loop\/evidence\.ts/);
    assert.match(studioActivity([event])[0]!.detail, /gatherEvidence.*loop\/evidence\.ts/);

    const memory = seedMoveMemory({ "user taste": "warm palettes" }, report.moved);
    assert.equal(memory["user taste"], "warm palettes", "the agent's own memory is left alone");
    const note = memory[`${SEED_MOVE_MEMORY_PREFIX}loop/gauntlet.ts`];
    assert.equal(typeof note, "string");
    assert.match(note as string, /gatherEvidence/);
    assert.match(note as string, /loop\/evidence\.ts/);
    assert.ok((note as string).length <= 300, "one memory value stays within the memory policy's limit");
    assert.deepEqual(
      seedMoveMemory(memory, []),
      { "user taste": "warm palettes" },
      "a note that no longer holds is taken back",
    );

    // The kept older gauntlet still loads beside its new siblings.
    const main = (await import(`${pathToFileURL(path.join(ws, "loop", "main.ts")).href}?v=${Date.now()}`)) as {
      createStudio?: unknown;
    };
    assert.equal(typeof main.createStudio, "function");
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

  it("reports no move for an agent-edited gauntlet of the new vintage, or an untouched one", async () => {
    const newer = await editedGauntletInstall(null);
    await appendFile(path.join(newer.ws, "loop", "gauntlet.ts"), "\n// the agent's change to runGauntlet itself\n");
    const newerReport = await applySeed({
      seedDir: shipped,
      workspaceDir: newer.ws,
      manifestFile: newer.manifest,
      backupDir: path.join(newer.root, "backup"),
    });
    assert.deepEqual(newerReport.moved, [], "a gauntlet that only re-exports the evidence pass keeps no copy of it");

    const untouched = await editedGauntletInstall(null);
    assert.deepEqual(
      (await applySeed({ seedDir: shipped, workspaceDir: untouched.ws, manifestFile: untouched.manifest })).moved,
      [],
    );
  });

  it("the boot writes the move into the agent's memory, and takes it back once it no longer holds", async () => {
    const resources = await makeResources();
    const userData = path.join(await tmpDir("seed-moved-boot-"), "userData");
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
    const first = await boot();
    const gauntlet = path.join(first.layout.harnessWs, "loop", "gauntlet.ts");
    const shippedGauntlet = await readFile(gauntlet, "utf8");
    await writeFile(gauntlet, olderGauntlet("the agent's own fix to the evidence pass"));

    const second = await boot();
    const memory = ((await second.store.readArtifact(second.mainThread, "memory")) ?? {}) as Record<string, unknown>;
    assert.match(String(memory[`${SEED_MOVE_MEMORY_PREFIX}loop/gauntlet.ts`]), /loop\/evidence\.ts/);

    // The agent re-applies its fix where the callers are and drops its copy.
    await writeFile(gauntlet, `${shippedGauntlet}\n// fix moved to evidence.ts\n`);
    const third = await boot();
    const after = ((await third.store.readArtifact(third.mainThread, "memory")) ?? {}) as Record<string, unknown>;
    assert.ok(!(`${SEED_MOVE_MEMORY_PREFIX}loop/gauntlet.ts` in after), "the note is gone");
  });
});

describe("seed upgrade across the harness step flag", () => {
  const shipped = path.resolve(fileURLToPath(new URL("../../src/harness-seed", import.meta.url)));
  const TURN = "loop/delegated-turn.ts";
  const JOURNAL = "loop/unreal/lead-journal.ts";

  /** A workspace whose chat turn the agent edited: `older` keeps sending harness steps like an agent's call. */
  async function keptTurn(older: boolean) {
    const root = await tmpDir("seed-step-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
    const copy = await readFile(path.join(ws, TURN), "utf8");
    // The older shape: a harness step sent like an agent's call.
    const kept = older ? copy.replaceAll("step: true", "harness: true") : copy;
    await writeFile(path.join(ws, TURN), `${kept}\n// the agent's own change\n`);
    const backupDir = path.join(root, "backup");
    return applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest, backupDir });
  }

  it("a kept chat turn that calls plugins.invoke without step: true is reported and noted for the agent; one that sends it is not", async () => {
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
    assert.match(note as string, /step: true/);
    assert.match(note as string, /checkpoint: true/);
    assert.ok((note as string).length <= 300, "one memory value stays within the memory policy's limit");
    assert.deepEqual(
      seedCallMemory(memory, []),
      { "user taste": "warm palettes" },
      "a note that no longer holds is taken back",
    );
  });

  it("a kept copy edited in a way that keeps every new call is never reported", async () => {
    const root = await tmpDir("seed-step-current-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
    const files = [...new Set(SEED_CALL_CHANGES.map((change) => change.file))];
    for (const file of files) await appendFile(path.join(ws, file), "\n<!-- the agent's own change -->\n");
    const report = await applySeed({
      seedDir: shipped,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(root, "backup"),
    });
    for (const file of files) assert.ok(report.kept.includes(file), `${file} is the agent's`);
    assert.deepEqual(report.outdatedCalls ?? [], [], "a current copy calls the new way");
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
      assert.match(note, /plugins\.tools/, file);
      assert.match(note, /project/, file);
      assert.ok(note.length <= 300, `${file}: one memory value stays within the memory policy's limit`);
    }
  });

  it("a kept part that makes a game with no kind where a web game is meant, or has no start for one, is reported once and noted for the agent", async () => {
    const root = await tmpDir("seed-step-scaffold-kind-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
    // The older shapes: a scaffold that names no kind, a run start that starts nothing, no start tool.
    const older: ReadonlyArray<readonly [string, string, string]> = [
      ["loop/chat-dispatch.ts", "kind: ProjectStarter.Web", ""],
      ["loop/autopilot.ts", "kind: ProjectStarter.Web", ""],
      ["loop/director/setup.ts", "kind: ProjectStarter.Web", ""],
      ["loop/gauntlet.ts", "kind: ProjectStarter.Web,", ""],
      ["loop/run-dispatch.ts", "await startWebIfPending(host, run.project, games);", ""],
      ["tools/game-tools.ts", "HostMethod.GameStart", "HostMethod.GameValidate"],
    ];
    for (const [file, from, to] of older) {
      const copy = await readFile(path.join(ws, file), "utf8");
      assert.ok(copy.includes(from), `${file} calls the new way`);
      await writeFile(path.join(ws, file), `${copy.replaceAll(from, to)}\n// the agent's own change\n`);
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
      assert.match(note, /web/, file);
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
    assert.match(note, /operating-rules-web\.md/);
    assert.ok(note.length <= 300, "one memory value stays within the memory policy's limit");
  });

  it("a kept chat brief from before new games started empty, and kept rules that still hold the web rules, are reported once and noted", async () => {
    const root = await tmpDir("seed-step-first-brief-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
    const brief = "loop/chat-session.ts";
    const rules = "prompts/operating-rules.md";
    // The older shapes: a brief that never tells a game with no kind to call start_web_game, and
    // rules that still tell every turn about the web page's preview and window.__studio.
    const copy = await readFile(path.join(ws, brief), "utf8");
    assert.ok(copy.includes("pendingKindRule("), "the shipped brief names the first step");
    await writeFile(
      path.join(ws, brief),
      `${copy.replaceAll("pendingKindRule(", "olderRule(")}\n// the agent's own change\n`,
    );
    const older =
      "1. **Look before you claim.** After changing a game, reload the preview and read `game_state()`.\n2. **Keep the game judgeable.** `window.__studio` must survive every edit.\n";
    await writeFile(path.join(ws, rules), older);
    const report = await applySeed({
      seedDir: shipped,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(root, "backup"),
    });
    assert.ok(report.kept.includes(rules), "the agent's rules are kept");
    assert.deepEqual([...(report.outdatedCalls ?? [])].sort(), [brief, rules].sort(), "each file once");
    const memory = seedCallMemory({}, report.outdatedCalls ?? []);
    const briefNote = String(memory[`${SEED_CALL_MEMORY_PREFIX}${brief}`]);
    assert.match(briefNote, /start_web_game/);
    assert.match(briefNote, /holds/);
    const rulesNote = String(memory[`${SEED_CALL_MEMORY_PREFIX}${rules}`]);
    assert.match(rulesNote, /operating-rules-web\.md/);
    for (const note of [briefNote, rulesNote]) assert.ok(note.length <= 300, "within the memory policy's limit");
    // The chat turn's note names what the brief now takes.
    const turnNote = String(seedCallMemory({}, [TURN])[`${SEED_CALL_MEMORY_PREFIX}${TURN}`]);
    assert.match(turnNote, /facts/);
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
      assert.match(note, /workers/i, file);
      assert.ok(note.length <= 300, `${file}: one memory value stays within the memory policy's limit`);
    }
  });

  it("a kept director part from before its worker tools is reported once and noted for the agent", async () => {
    const root = await tmpDir("seed-step-director-workers-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
    // The older shapes: no worker tools, the old wait, builders with no worker grant, no rejected filter, no reader close.
    const older: ReadonlyArray<readonly [string, readonly string[]]> = [
      ["loop/director/tool-specs.ts", ["WorkerTool."]],
      ["loop/director/tools.ts", ["WorkerTool."]],
      ["loop/director/wake-prompts.ts", ["worker_wait"]],
      ["loop/director/briefs.ts", ["worker_wait"]],
      ["loop/director/workers.ts", ["workerGrant(", "withWorkerRoom("]],
      ["loop/facet/phases/build.ts", ["worker: loop.options.worker"]],
      ["loop/director/wake.ts", ["rejectedNews("]],
      ["loop/director/integrate.ts", ["closeReaders("]],
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
      assert.match(note, /worker/i, file);
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
      assert.match(note, /job/i, file);
      assert.ok(note.length <= 300, `${file}: one memory value stays within the memory policy's limit`);
    }
  });

  it("a kept wake rules file without the job kind still loads the harness, and a job's end it has no kind for still wakes the lead soon", async () => {
    const root = await tmpDir("seed-job-kind-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
    const file = "loop/director/wake-schedule.ts";
    const copy = await readFile(path.join(ws, file), "utf8");
    const withoutKind = copy
      .split("\n")
      .filter((line) => !line.includes("JobEnded") && !line.includes("A job of the run"))
      .join("\n");
    assert.ok(!withoutKind.includes("job_ended"), "the older copy has no job kind");
    await writeFile(path.join(ws, file), `${withoutKind}\n// the agent's own change\n`);
    const report = await applySeed({
      seedDir: shipped,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(root, "backup"),
    });
    assert.ok(report.kept.includes(file), "the agent's copy is kept");
    for (const entry of ["loop/main.ts", "loop/director/wake.ts", "loop/unreal/lead.ts"])
      await import(`${pathToFileURL(path.join(ws, entry)).href}?v=${Date.now()}`);
    const kept = (await import(
      `${pathToFileURL(path.join(ws, file)).href}?v=${Date.now()}`
    )) as typeof import("../../src/harness-seed/loop/director/wake-schedule.ts");
    // The wake loop notes a job's end with the kind the kept copy lacks: a line with no kind, written while the lead rests.
    const now = Date.UTC(2026, 9, 7, 12);
    const due = kept.nextWake({
      now,
      unread: [{ at: now, seq: 11, kind: kept.NoteKind.JobEnded }],
      asleepFromSeq: 10,
      asleepSince: now,
      userWaiting: false,
      finishNew: false,
      running: 1,
      planWindowEndsAt: null,
      workersLimitLiftsAt: null,
      softDeadline: now + 3_600_000,
      wrapping: false,
      idleDue: false,
      idleAsked: false,
      wakesAt: [],
    });
    assert.equal(due?.at, now + kept.WAKE_DEBOUNCE_MS, "it wakes the lead soon");
  });

  it("a kept start_web_game that names no chat, and kept director parts that brief workers without Genex's identity, are reported once and noted", async () => {
    const root = await tmpDir("seed-step-identity-plan-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
    // The older shapes: a start that names no chat, and briefs that open with no identity.
    const older: ReadonlyArray<readonly [string, string, RegExp]> = [
      ["tools/game-tools.ts", "threadId: ctx.threadId", /Plan/],
      ["loop/director/briefs.ts", "builderIdentity(", /identity/],
      ["loop/director/workers.ts", "runIdentity(", /identity/],
      ["loop/director/setup.ts", "runIdentity(", /identity/],
      ["loop/facet/phases/brief.ts", "withIdentity(", /identity/],
    ];
    for (const [file, marker] of older) {
      const copy = await readFile(path.join(ws, file), "utf8");
      assert.ok(copy.includes(marker), `${file} has ${marker}`);
      await writeFile(path.join(ws, file), `${copy.replaceAll(marker, "olderShape(")}\n// the agent's own change\n`);
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
    for (const [file, , says] of older) {
      const note = String(memory[`${SEED_CALL_MEMORY_PREFIX}${file}`]);
      assert.match(note, says, file);
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
    for (const caller of ["loop/unreal/save-point.ts", "loop/unreal/restore.ts", "loop/unreal/lead.ts"])
      assert.ok(move?.callers.includes(caller), caller);
  });

  it("the boot writes an outdated call into the agent's memory, and takes it back once the copy sends the step", async () => {
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
    await writeFile(turn, `${shippedTurn.replaceAll("step: true", "harness: true")}\n// the agent's own change\n`);

    const second = await boot();
    assert.match(String((await memoryOf(second))[`${SEED_CALL_MEMORY_PREFIX}${TURN}`]), /step: true/);

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
    const main = (await import(`${pathToFileURL(path.join(ws, "loop", "main.ts")).href}?v=${Date.now()}`)) as {
      createStudio?: unknown;
    };
    assert.equal(typeof main.createStudio, "function");
  });
});

describe("seed upgrade across the wake loop", () => {
  const vintage = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/seed-exports-pre-wake.json", import.meta.url)), "utf8"),
  ) as { modules: Record<string, string[]> };
  const shipped = path.resolve(fileURLToPath(new URL("../../src/harness-seed", import.meta.url)));

  it("an agent that edited the director's parts before the wake loop keeps them, and the harness still loads", async () => {
    const root = await tmpDir("seed-wake-");
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

    // What the bootstrap does: import the workspace's own main.ts. The wake loop importing a name
    // the kept copies never exported would throw here, at link time.
    const main = (await import(`${pathToFileURL(path.join(ws, "loop", "main.ts")).href}?v=${Date.now()}`)) as {
      createStudio?: unknown;
    };
    assert.equal(typeof main.createStudio, "function");
  });

  /**
   * The run a kept director.ts from before the wake loop builds: it runs the long turn, never
   * calls the wake loop, and its run names no loop (the field did not exist). The new parts it
   * calls must answer it with the long turn's words, or its lead ends its turn — and a non-direction
   * run goes straight to its wrap-up.
   */
  const keptDirectorLoopRun = (over: Record<string, unknown> = {}) => ({
    run: { runId: "run_k", project: "kept", goal: "a plaza", reviewPlan: true },
    resume: false,
    softDeadline: Date.now() + 3_600_000,
    state: { plan: null, planReviewUntil: null, planGo: false, planSaidFrom: 0 },
    journal: { director: {}, plan: {} },
    inbox: { steering: async () => [] },
    appendRun: async () => {},
    saveJournal: async () => {},
    note: () => {},
    ...over,
  });
  const planArgs = {
    summary: "This run: a plaza.",
    workers: JSON.stringify([
      { id: "plaza", title: "Plaza", seam: "the plaza", owns: "src/plaza.js", done: ["a plaza"], minutes: 20 },
    ]),
  };

  it("a kept director.ts from before the wake loop runs the long turn, and the parts it calls answer with the long turn's words", async () => {
    const { setPlan } = await import("../../src/harness-seed/loop/director/workers.ts");
    const kept = String(await setPlan(keptDirectorLoopRun() as never, planArgs));
    assert.match(kept, /your first worker_start waits for their word/, kept);
    assert.doesNotMatch(kept, /End your turn/, kept);
    // Only a run the wake loop drives is told to end its turn.
    const waking = String(await setPlan(keptDirectorLoopRun({ waking: true }) as never, planArgs));
    assert.match(waking, /End your turn now/, waking);
  });
});

/**
 * The full journal gave the run's parts names they had not exported: the clocks a Resume keeps,
 * the record every save writes and the reading of it back. A seed upgrade keeps any of those parts
 * once the agent edited it, so each name the journal needs comes from a module of its own; imported
 * from a kept older copy it would fail to link, and the harness would not load.
 */
describe("seed upgrade across the full journal", () => {
  const vintage = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/seed-exports-pre-journal.json", import.meta.url)), "utf8"),
  ) as { modules: Record<string, string[]> };
  const shipped = path.resolve(fileURLToPath(new URL("../../src/harness-seed", import.meta.url)));

  it("an agent that edited the director's parts before the full journal keeps them, and the harness still loads", async () => {
    const root = await tmpDir("seed-journal-");
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

    // What the bootstrap does: import the workspace's own main.ts. The journal importing a name
    // the kept copies never exported would throw here, at link time.
    const main = (await import(`${pathToFileURL(path.join(ws, "loop", "main.ts")).href}?v=${Date.now()}`)) as {
      createStudio?: unknown;
    };
    assert.equal(typeof main.createStudio, "function");
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
    const main = (await import(`${pathToFileURL(path.join(ws, "loop", "main.ts")).href}?v=${Date.now()}`)) as {
      createStudio?: unknown;
    };
    assert.equal(typeof main.createStudio, "function");
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
 * One session made the run's lead its chat's own session: the seat it takes, the words a lead
 * that writes nothing reads, and the worker a merge conflict goes to. A seed upgrade keeps any of
 * the modules it touches once the agent edited it, so each name one session needs comes from a
 * module of its own (loop/director/lead-session.ts, loop/director/lead-session-prompts.ts,
 * loop/director/conflict-worker.ts); imported from a kept older copy it would fail to link, and the
 * harness would not load.
 */
describe("seed upgrade across one session", () => {
  const vintage = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/seed-exports-pre-one-session.json", import.meta.url)), "utf8"),
  ) as { modules: Record<string, string[]> };
  const shipped = path.resolve(fileURLToPath(new URL("../../src/harness-seed", import.meta.url)));

  it("an agent that edited its director, its chat turn or the run's parts before one session keeps them, and the harness still loads", async () => {
    const root = await tmpDir("seed-one-session-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
    // The new modules one session added are laid down beside the agent's older copies.
    for (const rel of [
      "loop/director/lead-session.ts",
      "loop/director/lead-session-prompts.ts",
      "loop/director/conflict-worker.ts",
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

    // What the bootstrap does: import the workspace's own main.ts. One session importing a name the
    // kept copies never exported would throw here, at link time.
    const main = (await import(`${pathToFileURL(path.join(ws, "loop", "main.ts")).href}?v=${Date.now()}`)) as {
      createStudio?: unknown;
    };
    assert.equal(typeof main.createStudio, "function");
  });

  /** The parts of the run a lead that writes nothing depends on: its words and its hands for one. */
  const LEAD_PARTS = [
    // The lead's strays are set aside with `GIT.snapshotCommit`, which an older git.ts lacks.
    "loop/git.ts",
    "loop/director/briefs.ts",
    "loop/director/integrate.ts",
    "loop/director/journal.ts",
    "loop/director/journal-prompts.ts",
    "loop/director/loop-run.ts",
    "loop/director/setup.ts",
    "loop/director/tools.ts",
    "loop/director/wake.ts",
    "loop/director/wake-prompts.ts",
    "loop/director/workers.ts",
  ];

  it("a part kept from before one session under the new director.ts: the run seats no lead, and a director with its own hands leads", async () => {
    /** Whether a workspace whose `kept` part is the agent's older copy seats a lead on the wake loop. */
    const seats = async (kept: string | null): Promise<unknown> => {
      const root = await tmpDir("seed-one-session-part-");
      const ws = path.join(root, "workspace");
      await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: path.join(root, "manifest.json") });
      if (kept) {
        const older = vintageExports(vintage.modules, kept).map(
          (name) => `export const ${name} = () => ${JSON.stringify(name)};`,
        );
        // As a seed upgrade leaves the agent's copy: its old names rewritten (seed-renames.ts).
        await writeFile(path.join(ws, kept), renameInSource(kept, `${older.join("\n")}\n// the agent's own change\n`));
      }
      const director = (await import(pathToFileURL(path.join(ws, "loop", "director.ts")).href)) as {
        seatsLead?: (loop: string) => boolean;
      };
      return director.seatsLead ? { wake: director.seatsLead("wake"), turn: director.seatsLead("turn") } : null;
    };
    assert.deepEqual(
      await seats(null),
      { wake: true, turn: false },
      "every part serves a lead: a waking run seats one",
    );
    const seen: Array<{ kept: string; seats: unknown }> = [];
    for (const kept of LEAD_PARTS) seen.push({ kept, seats: await seats(kept) });
    assert.deepEqual(
      seen,
      LEAD_PARTS.map((kept) => ({ kept, seats: { wake: false, turn: false } })),
      "an older copy of any part the lead depends on would tell a lead in the game folder to edit and commit in its worktree",
    );
  });

  it("a director.ts kept from before one session: the new parts give its director with its own hands the words for its hands", async () => {
    // A kept director.ts never seats a lead (`run.lead`), so every part it calls reads none.
    const { wakeTools, freshStart, wakeDigest } = await import("../../src/harness-seed/loop/director/wake-prompts.ts");
    const { DIRECTOR_TOOLS } = await import("../../src/harness-seed/loop/director/tool-specs.ts");
    const { priorCommitWords } = await import("../../src/harness-seed/loop/director/journal-prompts.ts");
    const integrate = wakeTools(DIRECTOR_TOOLS).find((tool) => tool.name === "integrate")!;
    assert.match(integrate.description, /resolve it yourself with git in your worktree, then commit/);
    const fresh = freshStart({ why: "lost", brief: "b", rules: "r", notes: [], recent: [], digest: "d" });
    assert.match(fresh, /Read \.studio\/DIRECTOR\.md in your worktree first/);
    const digest = wakeDigest({
      now: 0,
      reasons: [],
      userSays: [],
      finishNew: false,
      happened: [],
      softDeadline: 60_000,
      finalDeadline: 120_000,
      wrapping: false,
      integrationHead: null,
      integrationHealthy: null,
      defects: [],
      workers: [],
      planWindowUntil: null,
      workersLimit: null,
      finishRequested: false,
      card: { runId: "run_k", project: "kept", goal: "a plaza", direction: false, plan: null },
      closing: "",
    });
    assert.match(digest, /Keep \.studio\/DIRECTOR\.md current/);
    assert.doesNotMatch(digest, /You only read while the build runs/);
    const prior = {
      lastCommit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      from: null,
      ref: "refs/studio/runs/run_k/workers/sky",
    };
    assert.match(priorCommitWords(prior), /`git merge a1b2c3d4e5f60718293a4b5c6d7e8f9012345678` in your worktree/);
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
    const main = (await import(`${pathToFileURL(path.join(ws, "loop", "main.ts")).href}?v=${Date.now()}`)) as {
      createStudio?: unknown;
    };
    assert.equal(typeof main.createStudio, "function");
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

  it("an agent that edited its chat turn, its run's start or the run's parts before it keeps them, and the harness still loads", async () => {
    const root = await tmpDir("seed-reopen-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
    // The new modules the reopen added are laid down beside the agent's older copies.
    for (const rel of [
      "loop/reopen-run.ts",
      "loop/reopen-run-prompts.ts",
      "loop/director/reopen.ts",
      "loop/director/reopen-prompts.ts",
    ])
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

    // What the bootstrap does: import the workspace's own main.ts. The reopen importing a name the
    // kept copies never exported would throw here, at link time.
    const main = (await import(`${pathToFileURL(path.join(ws, "loop", "main.ts")).href}?v=${Date.now()}`)) as {
      createStudio?: unknown;
    };
    assert.equal(typeof main.createStudio, "function");
  });

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

  it("the run's clock, wake state and health pass as kept parts read them: a reopened journal starts afresh, a finished one as it was would not", async () => {
    // A kept setup.ts, wake.ts or journal.ts calls these with the journal as it finds it; the reopen
    // leaves them as they were and rewrites the journal instead (director/reopen.ts).
    for (const name of ["nightClock", "restoredWake", "restoreNight"])
      assert.ok(vintage.modules["loop/director/journal.ts"]?.includes(name), `a kept journal.ts has ${name}`);
    const { reopenedJournal } = await import("../../src/harness-seed/loop/director/reopen.ts");
    const { loopRunClock, restoredWake, restoreLoopRun } = await import(
      "../../src/harness-seed/loop/director/journal.ts"
    );
    const { wrapReserveMs } = await import("../../src/harness-seed/loop/director/budgets.ts");
    const HOUR = 3_600_000;
    const now = Date.parse("2026-09-29T21:00:00Z");
    const finished = {
      phase: "done",
      run: { runId: "run_r", project: "plaza", goal: "a dusk plaza", budgets: { wallClockMs: HOUR } },
      director: {
        clock: { workedMs: HOUR },
        wake: { idleAsked: true, wakesAt: [] },
        integrationHealthy: true,
        integrationHead: "b".repeat(40),
        workers: { sky: { id: "sky", state: "done" } },
      },
    };
    const run = { ...finished.run, budgets: { wallClockMs: 2 * HOUR } };
    const reopened = reopenedJournal(finished, run, { at: new Date(now).toISOString(), finishedHead: "a".repeat(40) });
    /** The run a kept setup.ts binds, as restoreNight reads it. */
    const loopRunOn = (priorJournal: unknown) => ({
      resume: true,
      priorJournal,
      run,
      journal: { director: {} },
      state: { ledger: [], integrationHealthy: null as boolean | null, workerLimit: null, log: [], workers: new Map() },
    });
    // setup.ts: nightClock({ saved: resume ? priorJournal?.director?.clock : null, now, totalMs })
    assert.deepEqual(loopRunClock({ saved: reopened.director.clock, now, totalMs: 2 * HOUR }), {
      started: now,
      softDeadline: now + 2 * HOUR - wrapReserveMs(2 * HOUR),
      finalDeadline: now + 2 * HOUR,
    });
    assert.equal(
      loopRunClock({ saved: finished.director.clock, now, totalMs: 2 * HOUR }).started,
      now - HOUR,
      "the finished journal as it was counts its spent hour",
    );
    // wake.ts: restoredWake(run.priorJournal?.director?.wake, now)
    assert.equal(restoredWake(reopened.director.wake, now).idleAsked, false);
    assert.equal(restoredWake(finished.director.wake, now).idleAsked, true);
    // journal.ts: restoreNight carries a boolean integrationHealthy onto the run.
    const fresh = loopRunOn(reopened);
    restoreLoopRun(fresh as never, now);
    assert.equal(fresh.state.integrationHealthy, null);
    const stale = loopRunOn(finished);
    restoreLoopRun(stale as never, now);
    assert.equal(stale.state.integrationHealthy, true);
  });
});

/**
 * Goal-directed generation split a run's completion policy from its reference kind, and every part
 * of the run that decides whether a run spends its hours or ends on verified outcomes asks it.
 * A seed upgrade keeps any of the director's parts once the agent edited it, so each name goal
 * generation needs comes from a module of its own (loop/completion-policy.ts, loop/director/
 * commission.ts, goals.ts, prerequisites.ts, progress.ts, timing.ts, trace.ts); imported from a kept
 * older copy it would fail to link, and the harness would not load.
 */
describe("seed upgrade across goal-directed generation", () => {
  const vintage = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/seed-exports-pre-goals.json", import.meta.url)), "utf8"),
  ) as { modules: Record<string, string[]> };
  const shipped = path.resolve(fileURLToPath(new URL("../../src/harness-seed", import.meta.url)));

  it("any one of the parts it changed, kept from before by an agent that edited it, still loads the harness", async () => {
    // One at a time: goal-directed generation changed the parts that import the new names as well
    // as the parts they import them from, and a kept importer of the older vintage imports nothing
    // new. What breaks is a current part beside one older copy.
    const unlinked: string[] = [];
    for (const [rel, names] of Object.entries(vintage.modules)) {
      const root = await tmpDir("seed-goals-");
      const ws = path.join(root, "workspace");
      const manifest = path.join(root, "manifest.json");
      await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
      // The agent's copy of the older vintage: every name it exported then, and nothing newer.
      const older = names.map((name) => `export const ${name} = () => ${JSON.stringify(name)};`);
      await writeFile(path.join(ws, rel), `${older.join("\n")}\n// the agent's own change\n`);
      const report = await applySeed({
        seedDir: shipped,
        workspaceDir: ws,
        manifestFile: manifest,
        backupDir: path.join(root, "backup"),
      });
      assert.ok(report.kept.includes(keptAt(rel)), `${rel} is the agent's`);

      // What the bootstrap does: import the workspace's own main.ts. A part importing a name the
      // kept copy never exported would throw here, at link time.
      try {
        const main = (await import(pathToFileURL(path.join(ws, "loop", "main.ts")).href)) as { createStudio?: unknown };
        if (typeof main.createStudio !== "function") unlinked.push(`${rel}: main.ts has no createStudio`);
      } catch (err) {
        unlinked.push(`${rel}: ${(err as Error).message}`);
      }
    }
    assert.deepEqual(unlinked, []);
  });
});

/**
 * The judges' evidence (the corner frame, the racing line, the throttle-only bot) added names: the frames a pass takes itself and the bot's probe scope come from modules of their
 * own (loop/pass-frames.ts, loop/throttle-bot.ts), and the new words of kinds.ts and
 * judge-facts.ts are read by namespace, so a current part beside one older copy still links.
 * kinds.ts is not in the vintage: its tables are read as the harness loads, which a stand-in made
 * of functions cannot answer whatever this change did.
 */
describe("seed upgrade across the drive's evidence", () => {
  const vintage = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/seed-exports-pre-drive-evidence.json", import.meta.url)), "utf8"),
  ) as { modules: Record<string, string[]> };
  const shipped = path.resolve(fileURLToPath(new URL("../../src/harness-seed", import.meta.url)));

  it("any one of the parts it changed, kept from before by an agent that edited it, still loads the harness", async () => {
    const unlinked: string[] = [];
    for (const [rel, names] of Object.entries(vintage.modules)) {
      const root = await tmpDir("seed-drive-");
      const ws = path.join(root, "workspace");
      const manifest = path.join(root, "manifest.json");
      await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
      const older = names.map((name) => `export const ${name} = () => ${JSON.stringify(name)};`);
      await writeFile(path.join(ws, rel), `${older.join("\n")}\n// the agent's own change\n`);
      await applySeed({
        seedDir: shipped,
        workspaceDir: ws,
        manifestFile: manifest,
        backupDir: path.join(root, "backup"),
      });
      try {
        const main = (await import(pathToFileURL(path.join(ws, "loop", "main.ts")).href)) as { createStudio?: unknown };
        if (typeof main.createStudio !== "function") unlinked.push(`${rel}: main.ts has no createStudio`);
      } catch (err) {
        unlinked.push(`${rel}: ${(err as Error).message}`);
      }
    }
    assert.deepEqual(unlinked, []);
  });
});

/**
 * The review fixes after b07810e added names some parts import from others. Any part they changed
 * may be one the agent edited and a seed upgrade keeps: each new name comes from a module of its
 * own, or is read by namespace, so a current part beside one older copy still links.
 */
describe("seed upgrade across the review fixes", () => {
  const vintage = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/seed-exports-pre-review-fixes.json", import.meta.url)), "utf8"),
  ) as { modules: Record<string, string[]> };
  const shipped = path.resolve(fileURLToPath(new URL("../../src/harness-seed", import.meta.url)));

  it("any one of the parts they changed, kept from before by an agent that edited it, still loads the harness", async () => {
    const unlinked: string[] = [];
    for (const [rel, names] of Object.entries(vintage.modules)) {
      const root = await tmpDir("seed-review-");
      const ws = path.join(root, "workspace");
      const manifest = path.join(root, "manifest.json");
      await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
      const older = names.map((name) => `export const ${name} = () => ${JSON.stringify(name)};`);
      await writeFile(path.join(ws, rel), `${older.join("\n")}\n// the agent's own change\n`);
      await applySeed({
        seedDir: shipped,
        workspaceDir: ws,
        manifestFile: manifest,
        backupDir: path.join(root, "backup"),
      });
      try {
        const main = (await import(pathToFileURL(path.join(ws, "loop", "main.ts")).href)) as { createStudio?: unknown };
        if (typeof main.createStudio !== "function") unlinked.push(`${rel}: main.ts has no createStudio`);
      } catch (err) {
        unlinked.push(`${rel}: ${(err as Error).message}`);
      }
    }
    assert.deepEqual(unlinked, []);
  });
});

/**
 * Opening the harness to other projects added names that parts which already shipped import: the
 * web check and the runner's checkpoint steps. Any part it changed may be one the agent edited and
 * a seed upgrade keeps at the older vintage, so each new name comes from a module of its own and a
 * current part beside one older copy still links, through the loop and through every local turn's
 * prompt.
 */
describe("seed upgrade across the open harness", () => {
  const vintage = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/seed-exports-pre-open-harness.json", import.meta.url)), "utf8"),
  ) as { modules: Record<string, string[]> };
  const shipped = path.resolve(fileURLToPath(new URL("../../src/harness-seed", import.meta.url)));

  it("any one of the parts it changed, kept from before by an agent that edited it, still loads the harness", async () => {
    const unlinked: string[] = [];
    for (const [rel, names] of Object.entries(vintage.modules)) {
      const root = await tmpDir("seed-open-");
      const ws = path.join(root, "workspace");
      const manifest = path.join(root, "manifest.json");
      await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
      const older = names.map((name) => `export const ${name} = () => ${JSON.stringify(name)};`);
      await writeFile(path.join(ws, rel), `${older.join("\n")}\n// the agent's own change\n`);
      const report = await applySeed({
        seedDir: shipped,
        workspaceDir: ws,
        manifestFile: manifest,
        backupDir: path.join(root, "backup"),
      });
      assert.ok(report.kept.includes(rel), `${rel} is the agent's`);
      for (const entry of ["loop/main.ts", "loop/prompt.ts", "loop/unreal/lead.ts"]) {
        if (entry === rel) continue;
        try {
          await import(pathToFileURL(path.join(ws, entry)).href);
        } catch (err) {
          unlinked.push(`${rel} kept, ${entry}: ${(err as Error).message}`);
        }
      }
    }
    assert.deepEqual(unlinked, []);
  });
});

/**
 * Genex's one worker model changed shipped parts (the chat turn and its brief, the director's
 * tools, builders and wake, the facet's build turn, the local game tools) and gave them new
 * modules to import (`loop/workers/`). Any of those parts may be one the agent edited and a seed
 * upgrade keeps at the older vintage: each new name comes from a module of its own, so a current
 * part beside one older copy still links, through the loop, every local turn's prompt and the
 * Unreal lead.
 */
describe("seed upgrade across the worker model", () => {
  const vintage = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/seed-exports-pre-workers.json", import.meta.url)), "utf8"),
  ) as { modules: Record<string, string[]> };
  const shipped = path.resolve(fileURLToPath(new URL("../../src/harness-seed", import.meta.url)));

  it("any one of the parts it changed, kept from before by an agent that edited it, still loads the harness", async () => {
    const unlinked: string[] = [];
    for (const [rel, names] of Object.entries(vintage.modules)) {
      const root = await tmpDir("seed-workers-");
      const ws = path.join(root, "workspace");
      const manifest = path.join(root, "manifest.json");
      await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
      const older = names.map((name) => `export const ${name} = () => ${JSON.stringify(name)};`);
      await writeFile(path.join(ws, rel), `${older.join("\n")}\n// the agent's own change\n`);
      const report = await applySeed({
        seedDir: shipped,
        workspaceDir: ws,
        manifestFile: manifest,
        backupDir: path.join(root, "backup"),
      });
      assert.ok(report.kept.includes(rel), `${rel} is the agent's`);
      for (const entry of ["loop/main.ts", "loop/prompt.ts", "loop/unreal/lead.ts"]) {
        if (entry === rel) continue;
        try {
          await import(pathToFileURL(path.join(ws, entry)).href);
        } catch (err) {
          unlinked.push(`${rel} kept, ${entry}: ${(err as Error).message}`);
        }
      }
    }
    assert.deepEqual(unlinked, []);
  });
});

/**
 * One lead took over the Unreal Loop: the step machine's modules were retired, and the modules
 * around it changed. A seed upgrade keeps any of those the agent edited at the older vintage, with
 * its imports as they were then (a kept `run-dispatch.ts` still imports the runner from
 * `unreal/live.ts`, a kept `restore.ts` its tool call from `live-journal.ts`), and the new lead
 * imports its siblings by the names they have now. Either way the harness must still load.
 */
describe("seed upgrade across the Unreal lead", () => {
  const vintage = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/seed-exports-pre-lead.json", import.meta.url)), "utf8"),
  ) as {
    modules: Record<string, string[]>;
    imports: Record<string, Record<string, string[]>>;
    retired: Record<string, string[]>;
  };
  const shipped = path.resolve(fileURLToPath(new URL("../../src/harness-seed", import.meta.url)));

  /** A module of the older vintage: its imports as they were, and every name it exported then. */
  function olderModule(rel: string): string {
    const imports = vintage.imports[rel] ?? {};
    const imported = Object.values(imports).flat();
    return [
      ...Object.entries(imports).map(([from, names]) => `import { ${names.join(", ")} } from "${from}";`),
      `const used = [${imported.join(", ")}];`,
      ...(vintage.modules[rel] ?? []).map((name) =>
        imported.includes(name) ? `export { ${name} };` : `export const ${name} = () => used.length;`,
      ),
      "// the agent's own change",
    ].join("\n");
  }

  /** The older seed: today's, with the step machine's modules it shipped then (untouched by the agent). */
  async function olderSeed(): Promise<string> {
    const older = path.join(await tmpDir("seed-lead-older-"), "seed");
    await cp(shipped, older, { recursive: true });
    for (const [rel, names] of Object.entries(vintage.retired)) {
      const stubs = names.map((name) => `export const ${name} = () => ${JSON.stringify(name)};`);
      await writeFile(path.join(older, rel), `${stubs.join("\n")}\n`);
    }
    return older;
  }

  it("any one of the modules it changed, kept from before with its imports as they were, still loads the harness", async () => {
    const older = await olderSeed();
    const unlinked: string[] = [];
    for (const rel of Object.keys(vintage.modules)) {
      const root = await tmpDir("seed-lead-");
      const ws = path.join(root, "workspace");
      const manifest = path.join(root, "manifest.json");
      await applySeed({ seedDir: older, workspaceDir: ws, manifestFile: manifest });
      await writeFile(path.join(ws, rel), `${olderModule(rel)}\n`);
      const report = await applySeed({
        seedDir: shipped,
        workspaceDir: ws,
        manifestFile: manifest,
        backupDir: path.join(root, "backup"),
      });
      assert.ok(report.kept.includes(rel), `${rel} is kept`);
      try {
        const main = (await import(pathToFileURL(path.join(ws, "loop", "main.ts")).href)) as { createStudio?: unknown };
        if (typeof main.createStudio !== "function") unlinked.push(`${rel}: main.ts has no createStudio`);
      } catch (err) {
        unlinked.push(`${rel}: ${(err as Error).message}`);
      }
    }
    assert.deepEqual(unlinked, []);
  });
});
