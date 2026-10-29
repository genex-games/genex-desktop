/**
 * The AI method across a seed upgrade: the shipped `skills/llm-games.md` reaches an install that
 * never touched it, an install whose agent edited it keeps the edit for ever, and a builder of an
 * AI game is handed the workspace's copy — the edited one — not the seed's.
 */
import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { applySeed } from "../../src/substrate/seed-upgrade.ts";
import { AI_METHOD_FILE_PATH, AI_METHOD_SKILL, writeAiMethodFile } from "../../src/harness-seed/loop/ai-game.ts";
import { AiRequirement } from "../../src/harness-seed/loop/ai-contract.ts";
import { tmpDir } from "../helpers/tmp.ts";

const SHIPPED = path.resolve("src/harness-seed", "skills", `${AI_METHOD_SKILL}.md`);
const SKILL = `skills/${AI_METHOD_SKILL}.md`;

/** A seed holding the shipped AI method, an install of it, and a builder's worktree. */
async function installed() {
  const root = await tmpDir("ai-seed-upgrade-");
  const seed = path.join(root, "seed");
  await mkdir(path.join(seed, "skills"), { recursive: true });
  await cp(SHIPPED, path.join(seed, SKILL));
  await writeFile(path.join(seed, "package.json"), '{"name":"harness"}\n');
  const paths = {
    seed,
    ws: path.join(root, "workspace"),
    manifest: path.join(root, "manifest.json"),
    backup: path.join(root, "backup"),
    worktree: path.join(root, "worktree"),
  };
  await mkdir(paths.worktree, { recursive: true });
  await applySeed({ seedDir: seed, workspaceDir: paths.ws, manifestFile: paths.manifest });
  return paths;
}

describe("the AI method across a seed upgrade", () => {
  it("lays the method down on a fresh install and refreshes an untouched copy", async () => {
    const { seed, ws, manifest, backup } = await installed();
    assert.equal(await readFile(path.join(ws, SKILL), "utf8"), await readFile(SHIPPED, "utf8"));
    await writeFile(path.join(seed, SKILL), "---\nname: Games with play-time AI\ndescription: v2\n---\nv2 method\n");
    const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest, backupDir: backup });
    assert.deepEqual(report.updated, [SKILL]);
    assert.match(await readFile(path.join(ws, SKILL), "utf8"), /v2 method/);
  });

  it("keeps the agent's edit through every later upgrade, and hands builders the edited copy", async () => {
    const { seed, ws, manifest, backup, worktree } = await installed();
    const edited = "---\nname: Games with play-time AI\ndescription: mine\n---\nThe agent's own method.\n";
    await writeFile(path.join(ws, SKILL), edited);
    for (const version of ["v2", "v3"]) {
      await writeFile(path.join(seed, SKILL), `---\nname: x\ndescription: ${version}\n---\n${version}\n`);
      const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest, backupDir: backup });
      assert.deepEqual(report.kept, [SKILL], version);
      assert.equal(await readFile(path.join(ws, SKILL), "utf8"), edited, version);
    }
    await writeAiMethodFile(ws, worktree, { ai: AiRequirement.Optional });
    assert.equal(await readFile(path.join(worktree, AI_METHOD_FILE_PATH), "utf8"), "The agent's own method.\n");
  });
});
