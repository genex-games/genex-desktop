/**
 * The archive on upgrade (phase 5, decision 7). Upgrading into `ARCHIVE_EPOCH`, the app moves what
 * the runs learned and the agent's edits of harness files this seed removes or changes into
 * `<harness workspace>/archive/<date>/`, lays the seed's copies down and never injects the archived
 * files again. It happens once: later upgrades keep the agent's edits as they always have. The
 * archive never writes through a link out of the workspace.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { archiveArtifacts } from "../../src/main/seed-upgrade-notice.ts";
import {
  ARCHIVE_EPOCH,
  ARCHIVE_FOLDER,
  LEARNED_ARTIFACTS,
  LEARNED_PATHS,
  archiveFolderFor,
} from "../../src/substrate/seed-archive.ts";
import { applySeed } from "../../src/substrate/seed-upgrade.ts";
import { tmpDir } from "../helpers/tmp.ts";

const DATE = new Date("2026-10-30T09:00:00Z");
const ARCHIVE = `${ARCHIVE_FOLDER}/2026-10-30`;

/** Write `files` (rel → text) under `dir`. */
async function lay(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
}

const exists = (file: string) =>
  lstat(file).then(
    () => true,
    () => false,
  );

/**
 * A workspace laid down by an older seed (`v1`) and a manifest from before the archive epoch, then
 * the agent's own changes (`edits`) and what the runs learned (`learned`). Answers the folders.
 */
async function olderInstall(options: {
  v1: Record<string, string>;
  edits?: Record<string, string>;
  learned?: Record<string, string>;
}) {
  const root = await tmpDir("seed-archive-");
  const v1 = path.join(root, "seed-v1");
  const ws = path.join(root, "workspace");
  const manifestFile = path.join(root, "manifest.json");
  await lay(v1, options.v1);
  await applySeed({ seedDir: v1, workspaceDir: ws, manifestFile });
  // An install from before the epoch: its manifest says nothing of archiving.
  const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as Record<string, unknown>;
  delete manifest.archiveEpoch;
  await writeFile(manifestFile, JSON.stringify(manifest));
  await lay(ws, { ...(options.edits ?? {}), ...(options.learned ?? {}) });
  return { root, ws, manifestFile };
}

/** The next seed (`v2`), applied over the install as a boot does, on the test's date. */
async function upgrade(install: { root: string; ws: string; manifestFile: string }, v2: Record<string, string>) {
  const seedDir = path.join(install.root, `seed-v2-${Math.random().toString(36).slice(2)}`);
  await lay(seedDir, v2);
  return applySeed({
    seedDir,
    workspaceDir: install.ws,
    manifestFile: install.manifestFile,
    backupDir: path.join(install.root, `backup-${Math.random().toString(36).slice(2)}`),
    now: () => DATE,
  });
}

describe("the archive on upgrade", () => {
  it("names its folder by the upgrade's date", () => {
    assert.equal(archiveFolderFor(DATE), ARCHIVE);
  });

  it("moves what the runs learned into the archive, keeping each file's path", async () => {
    const learned = {
      "library/games/racer.jsonl": '{"lesson":"wet roads"}\n',
      "library/games/racer.md": "# racer\n",
      "library/contract-lessons.md": "- tag every object\n",
      "library/recipe-stats.json": '{"fog":3}\n',
      "library/checks.json": '{"checks":[{"id":"wet-road"}]}\n',
    };
    for (const rel of Object.keys(learned)) assert.ok(LEARNED_PATHS.some((p) => rel === p || rel.startsWith(`${p}/`)));
    const install = await olderInstall({ v1: { "loop/main.ts": "export {};\n" }, learned });
    const report = await upgrade(install, { "loop/main.ts": "export {};\n" });
    for (const [rel, text] of Object.entries(learned)) {
      assert.equal(await exists(path.join(install.ws, rel)), false, `${rel} is out of the workspace`);
      assert.equal(await readFile(path.join(install.ws, ARCHIVE, rel), "utf8"), text, `${rel} is archived whole`);
    }
    assert.equal(report.archive?.dir, ARCHIVE);
    assert.deepEqual([...(report.archive?.learned ?? [])].sort(), [
      "library/checks.json",
      "library/contract-lessons.md",
      "library/games",
      "library/recipe-stats.json",
    ]);
  });

  it("archives the agent's edit of a file this seed changes, and lays the seed's copy down", async () => {
    const install = await olderInstall({
      v1: { "loop/turn.ts": "export const v = 1;\n", "skills/build.md": "v1\n" },
      edits: { "loop/turn.ts": "export const v = 1; // the agent's own\n" },
    });
    const report = await upgrade(install, { "loop/turn.ts": "export const v = 2;\n", "skills/build.md": "v1\n" });
    assert.equal(await readFile(path.join(install.ws, "loop/turn.ts"), "utf8"), "export const v = 2;\n");
    assert.equal(
      await readFile(path.join(install.ws, ARCHIVE, "loop/turn.ts"), "utf8"),
      "export const v = 1; // the agent's own\n",
    );
    assert.deepEqual(report.archive?.edits, ["loop/turn.ts"]);
    assert.ok(!report.kept.includes("loop/turn.ts"), "not kept: replaced by the seed");
    assert.ok(report.updated.includes("loop/turn.ts"));
  });

  it("keeps an edit of a file this seed leaves as it was", async () => {
    const install = await olderInstall({
      v1: { "loop/turn.ts": "export const v = 1;\n" },
      edits: { "loop/turn.ts": "export const v = 1; // the agent's own\n" },
    });
    const report = await upgrade(install, { "loop/turn.ts": "export const v = 1;\n" });
    assert.equal(
      await readFile(path.join(install.ws, "loop/turn.ts"), "utf8"),
      "export const v = 1; // the agent's own\n",
    );
    assert.deepEqual(report.archive?.edits ?? [], []);
  });

  it("archives the agent's edit of a file this seed no longer ships, and retires an untouched one", async () => {
    const install = await olderInstall({
      v1: { "loop/main.ts": "export {};\n", "loop/judge.ts": "j1\n", "loop/kinds.ts": "k1\n" },
      edits: { "loop/judge.ts": "j1 // the agent's own\n" },
    });
    const report = await upgrade(install, { "loop/main.ts": "export {};\n" });
    assert.equal(await exists(path.join(install.ws, "loop/judge.ts")), false);
    assert.equal(await readFile(path.join(install.ws, ARCHIVE, "loop/judge.ts"), "utf8"), "j1 // the agent's own\n");
    assert.equal(await exists(path.join(install.ws, "loop/kinds.ts")), false, "untouched: retired");
    assert.equal(
      await exists(path.join(install.ws, ARCHIVE, "loop/kinds.ts")),
      false,
      "nothing of the agent's to keep",
    );
    assert.ok(report.retired.includes("loop/kinds.ts"));
    assert.deepEqual(report.archive?.edits, ["loop/judge.ts"]);
  });

  it("archives once: a later upgrade keeps the agent's edits as before", async () => {
    const install = await olderInstall({ v1: { "loop/turn.ts": "v1\n" } });
    await upgrade(install, { "loop/turn.ts": "v2\n" });
    const manifest = JSON.parse(await readFile(install.manifestFile, "utf8")) as { archiveEpoch?: number };
    assert.equal(manifest.archiveEpoch, ARCHIVE_EPOCH);
    await writeFile(path.join(install.ws, "loop/turn.ts"), "v2 // the agent's own\n");
    await lay(install.ws, { "library/contract-lessons.md": "- a new lesson\n" });
    const report = await upgrade(install, { "loop/turn.ts": "v3\n" });
    assert.equal(report.archive, undefined);
    assert.ok(report.kept.includes("loop/turn.ts"));
    assert.equal(await readFile(path.join(install.ws, "loop/turn.ts"), "utf8"), "v2 // the agent's own\n");
    assert.equal(await exists(path.join(install.ws, "library/contract-lessons.md")), true);
  });

  it("a first launch records the epoch and archives nothing", async () => {
    const root = await tmpDir("seed-archive-fresh-");
    const seedDir = path.join(root, "seed");
    await lay(seedDir, { "loop/main.ts": "export {};\n" });
    const manifestFile = path.join(root, "manifest.json");
    const report = await applySeed({ seedDir, workspaceDir: path.join(root, "ws"), manifestFile, now: () => DATE });
    assert.equal(report.archive, undefined);
    const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as { archiveEpoch?: number };
    assert.equal(manifest.archiveEpoch, ARCHIVE_EPOCH);
  });

  it("never writes through a link out of the workspace: a learned link moves as a link, an archive link refuses", async () => {
    const outsideRoot = await tmpDir("seed-archive-outside-");
    const secret = path.join(outsideRoot, "secret.md");
    await writeFile(secret, "not the studio's\n");
    // A learned path that is a link out: the link itself is archived, its target untouched.
    const linked = await olderInstall({ v1: { "loop/main.ts": "export {};\n" } });
    await mkdir(path.join(linked.ws, "library"), { recursive: true });
    await symlink(secret, path.join(linked.ws, "library/contract-lessons.md"));
    await upgrade(linked, { "loop/main.ts": "export {};\n" });
    assert.equal(await readFile(secret, "utf8"), "not the studio's\n");
    assert.equal(await readlink(path.join(linked.ws, ARCHIVE, "library/contract-lessons.md")), secret);
    // An archive folder planted as a link out: nothing is written through it.
    const planted = await olderInstall({
      v1: { "loop/main.ts": "export {};\n" },
      learned: { "library/recipe-stats.json": "{}\n" },
    });
    await symlink(outsideRoot, path.join(planted.ws, ARCHIVE_FOLDER));
    const report = await upgrade(planted, { "loop/main.ts": "export {};\n" });
    assert.equal(report.archive, undefined, "no archive through a link");
    assert.equal(await exists(path.join(outsideRoot, "2026-10-30")), false, "nothing written outside");
    assert.equal(await exists(path.join(planted.ws, "library/recipe-stats.json")), true, "left where it was");
  });

  it("archives the learned artifacts as files and clears them, so no prompt carries them again", async () => {
    const root = await tmpDir("seed-archive-artifacts-");
    const archiveDir = path.join(root, ARCHIVE);
    const records: Record<string, unknown> = {
      memory: { "user taste": "warm palettes", machine: "M3 Max" },
      skillopt_staged: [{ skill: "contract-lessons", lessons: ["tag every object"] }],
      journal_run_1: { kept: true },
    };
    const written: Array<[string, unknown]> = [];
    const archived = await archiveArtifacts(
      {
        read: async (id) => records[id] ?? null,
        write: async (id, value) => void written.push([id, value]),
      },
      archiveDir,
    );
    assert.deepEqual(archived, [...LEARNED_ARTIFACTS]);
    for (const id of LEARNED_ARTIFACTS)
      assert.deepEqual(
        JSON.parse(await readFile(path.join(archiveDir, "artifacts", `${id}.json`), "utf8")),
        records[id],
        `${id} is archived whole`,
      );
    assert.deepEqual(written, [
      ["memory", {}],
      ["skillopt_staged", []],
    ]);
    // Nothing else is touched, and an artifact with nothing in it is not archived.
    const none = await archiveArtifacts(
      { read: async () => null, write: async () => assert.fail("nothing to clear") },
      archiveDir,
    );
    assert.deepEqual(none, []);
  });
});
