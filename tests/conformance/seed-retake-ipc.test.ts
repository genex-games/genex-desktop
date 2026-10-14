/**
 * `studio:seed.retake` (`src/main/ipc/seed.ts`): the person's re-take of the shipped copy of one
 * harness part the agent kept from before Rust games. The shipped copy is laid down, the agent's
 * edit is kept as a patch in a fresh folder under the updates folder, the answer is recorded as a
 * `seed_retake` event and the agent gets a memory note. A malformed payload is refused before
 * anything runs; a hostile path is refused typed by `retakeSeedModule` with nothing written.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { retakeSeed, SEED_RETAKE_MEMORY_PREFIX, type SeedRetakeDeps } from "../../src/main/ipc/seed.ts";
import { SeedRetakeRefusal, type SeedRetakePayload } from "../../src/shared/seed-retake.ts";
import { applySeed } from "../../src/substrate/seed-upgrade.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PART = "loop/judge.ts";
const SHIPPED = "export const judge = 'shipped';\nexport const SERVES_RUST = true;\n";
const AGENT = "export const judge = 'the agent fixed this';\n";

/** A seed and a workspace the seed was applied to, with the agent's edit of `PART`; and recording deps. */
async function rig() {
  const root = await tmpDir("seed-retake-ipc-");
  const seedDir = path.join(root, "seed");
  const workspaceDir = path.join(root, "workspace");
  const manifestFile = path.join(root, "harness-seed-manifest.json");
  const updatesDir = path.join(root, "updates");
  await mkdir(path.join(seedDir, "loop"), { recursive: true });
  await writeFile(path.join(seedDir, PART), SHIPPED);
  await mkdir(workspaceDir, { recursive: true });
  await applySeed({ seedDir, workspaceDir, manifestFile });
  await writeFile(path.join(workspaceDir, PART), AGENT);
  const recorded: SeedRetakePayload[] = [];
  const notes: Array<[string, string]> = [];
  let snapshots = 0;
  const deps: SeedRetakeDeps = {
    dirs: { seedDir, workspaceDir, manifestFile, updatesDir },
    record: async (payload) => void recorded.push(payload),
    note: async (key, text) => void notes.push([key, text]),
    snapshot: async () => void snapshots++,
    now: () => 1_000_000,
  };
  return { root, workspaceDir, updatesDir, deps, recorded, notes, snapshots: () => snapshots };
}

/** Every file under `dir`, relative, or [] when it does not exist. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)));
}

describe("studio:seed.retake", () => {
  it("lays the shipped copy down, keeps the agent's edit as a patch under updates, records it and notes it", async () => {
    const { workspaceDir, updatesDir, deps, recorded, notes, snapshots } = await rig();
    const answer = await retakeSeed(deps, { module: PART });
    assert.ok(answer.ok, JSON.stringify(answer));
    assert.equal(answer.module, PART);
    assert.equal(await readFile(path.join(workspaceDir, PART), "utf8"), SHIPPED, "the workspace runs the shipped copy");
    assert.ok(answer.patchFile.startsWith(path.join(updatesDir, "seed-retake-")), answer.patchFile);
    assert.match(await readFile(answer.patchFile, "utf8"), /the agent fixed this/);
    assert.equal(await readFile(answer.keptFile ?? "", "utf8"), AGENT, "the agent's whole copy is kept too");
    assert.deepEqual(recorded, [{ ok: true, module: PART, patchFile: answer.patchFile, keptFile: answer.keptFile }]);
    assert.equal(notes.length, 1);
    assert.equal(notes[0]?.[0], `${SEED_RETAKE_MEMORY_PREFIX}${PART}`);
    assert.ok(notes[0]?.[1].includes(answer.patchFile), "the note says where the patch is");
    assert.equal(snapshots(), 1, "the harness is snapshotted before it changes");
  });

  it("a part the agent did not change is refused not-kept, recorded, with nothing written", async () => {
    const { workspaceDir, updatesDir, deps, recorded, notes } = await rig();
    await writeFile(path.join(workspaceDir, PART), SHIPPED);
    const answer = await retakeSeed(deps, { module: PART });
    assert.deepEqual(answer, { ok: false, module: PART, code: SeedRetakeRefusal.NotKept });
    assert.deepEqual(recorded, [{ ok: false, module: PART, code: SeedRetakeRefusal.NotKept }]);
    assert.deepEqual(notes, []);
    assert.deepEqual(await filesUnder(updatesDir), []);
  });

  it("hostile module paths are refused typed, and nothing outside or inside the workspace changes", async () => {
    const rows: Array<[string, SeedRetakeRefusal]> = [
      ["../outside.ts", SeedRetakeRefusal.InvalidPath],
      ["/etc/hosts", SeedRetakeRefusal.InvalidPath],
      ["loop\\judge.ts", SeedRetakeRefusal.InvalidPath],
      ["loop/../../escape.ts", SeedRetakeRefusal.InvalidPath],
      ["loop/missing.ts", SeedRetakeRefusal.NotSeedFile],
    ];
    for (const [module, code] of rows) {
      const { root, workspaceDir, updatesDir, deps, notes } = await rig();
      const before = await filesUnder(root);
      const answer = await retakeSeed(deps, { module });
      assert.deepEqual(answer, { ok: false, module, code }, module);
      assert.deepEqual(await filesUnder(root), before, `${module}: no file appeared or went away`);
      assert.equal(await readFile(path.join(workspaceDir, PART), "utf8"), AGENT, `${module}: the agent's copy stays`);
      assert.deepEqual(await filesUnder(updatesDir), [], module);
      assert.deepEqual(notes, [], module);
    }
  });

  it("a malformed payload is refused before anything runs or is recorded", async () => {
    const payloads: unknown[] = [
      undefined,
      null,
      "loop/judge.ts",
      [],
      {},
      { module: 7 },
      { module: "" },
      { module: "x".repeat(1025) },
    ];
    for (const payload of payloads) {
      const { deps, recorded, snapshots } = await rig();
      await assert.rejects(retakeSeed(deps, payload), JSON.stringify(payload));
      assert.deepEqual(recorded, [], JSON.stringify(payload));
      assert.equal(snapshots(), 0, JSON.stringify(payload));
    }
  });
});
