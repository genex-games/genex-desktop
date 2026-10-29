/**
 * Routing a game that calls a model in play to the AI method, by its typed word (`game.ai`): every
 * builder of such a game finds the method (`skills/llm-games.md`, the workspace's own copy, kept
 * on upgrade) in `.studio/AI.md` and a pointer to it in its brief; a game that declares nothing gets
 * neither. The skill ships in the seed with the procedure the checks hold a game to.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  AI_METHOD_FILE_PATH,
  AI_METHOD_SKILL,
  AI_STARTERS_PATH,
  aiBriefLine,
  aiMethodText,
  writeAiMethodFile,
} from "../../src/harness-seed/loop/ai-game.ts";
import { AiCheckTest, AiRequirement } from "../../src/harness-seed/loop/ai-contract.ts";
import { parseSkill } from "../../src/harness-seed/loop/skills.ts";
import { renderBrief } from "../../src/harness-seed/loop/library.ts";
import { tmpDir } from "../helpers/tmp.ts";

const SEED = path.resolve("src/harness-seed");

/** A workspace whose skill says `body`, and an empty worktree. */
async function workspaceWith(body: string | null) {
  const dir = await tmpDir("ai-method-");
  const workspace = path.join(dir, "workspace");
  const worktree = path.join(dir, "worktree");
  await mkdir(path.join(workspace, "skills"), { recursive: true });
  await mkdir(worktree, { recursive: true });
  if (body !== null)
    await writeFile(
      path.join(workspace, "skills", `${AI_METHOD_SKILL}.md`),
      `---\nname: x\ndescription: y\n---\n${body}`,
    );
  return { workspace, worktree };
}

describe("the AI method reaches every builder of a game that declares AI", () => {
  it("writes the workspace's own copy of the skill, without its front matter, into the worktree", async () => {
    const { workspace, worktree } = await workspaceWith("My edited method.\n");
    const written = await writeAiMethodFile(workspace, worktree, { ai: AiRequirement.Ai });
    assert.equal(written, AI_METHOD_FILE_PATH);
    assert.equal(await readFile(path.join(worktree, AI_METHOD_FILE_PATH), "utf8"), "My edited method.\n");
  });

  it("writes nothing for a game that declares no AI, or one that declares it in words", async () => {
    for (const game of [null, {}, { ai: "yes" }, { kind: "board" }, { ai: true }]) {
      const { workspace, worktree } = await workspaceWith("Method.\n");
      assert.equal(await writeAiMethodFile(workspace, worktree, game), null, JSON.stringify(game));
      await assert.rejects(readFile(path.join(worktree, AI_METHOD_FILE_PATH), "utf8"));
    }
  });

  it("writes nothing when the workspace has no such skill (an agent deleted it)", async () => {
    const { workspace, worktree } = await workspaceWith(null);
    assert.equal(await aiMethodText(workspace), "");
    assert.equal(await writeAiMethodFile(workspace, worktree, { ai: AiRequirement.Optional }), null);
  });

  it("copies the workspace's starters beside it, regular files only, never through a link", async () => {
    const { workspace, worktree } = await workspaceWith("Method.\n");
    const starter = path.join(workspace, "library", "ai-starters", "oracle");
    await mkdir(path.join(starter, "ai", "tapes"), { recursive: true });
    await writeFile(path.join(starter, "README.md"), "An oracle.");
    await writeFile(path.join(starter, "ai", "tapes", "ask.jsonl"), "{}\n");
    const outside = path.join(path.dirname(workspace), "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), "not a starter");
    await symlink(outside, path.join(starter, "linked"));
    await symlink(path.join(outside, "secret.txt"), path.join(starter, "secret.txt"));
    await writeAiMethodFile(workspace, worktree, { ai: AiRequirement.Ai });
    const copied = path.join(worktree, AI_STARTERS_PATH, "oracle");
    assert.deepEqual((await readdir(copied)).sort(), ["README.md", "ai"]);
    assert.equal(await readFile(path.join(copied, "ai", "tapes", "ask.jsonl"), "utf8"), "{}\n");
  });

  it("points the brief at it, saying whether the game may run without AI", () => {
    assert.equal(aiBriefLine(null), "");
    assert.equal(aiBriefLine({ ai: "AI please" }), "");
    assert.match(aiBriefLine({ ai: AiRequirement.Ai }), /cannot run without.*\.studio\/AI\.md/);
    assert.match(aiBriefLine({ ai: AiRequirement.Optional }), /plays on without.*\.studio\/AI\.md/);
    const brief = renderBrief({
      run: { runId: "r1", goal: "an oracle", game: { ai: AiRequirement.Optional } },
      spec: { id: "oracle", title: "Oracle", intent: "answers", identity: [], owns: [], checks: [] },
      iteration: 1,
    } as never);
    assert.match(brief, /\.studio\/AI\.md/);
  });
});

describe("the seed's llm-games skill", () => {
  it("is a skill with a name and a description the index shows", async () => {
    const skill = parseSkill(await readFile(path.join(SEED, "skills", `${AI_METHOD_SKILL}.md`), "utf8"));
    assert.ok(skill.name.length > 0);
    assert.ok(skill.description.length > 0);
  });

  it("names the tools the procedure uses and every check that holds the game to it", async () => {
    const text = await aiMethodText(SEED);
    for (const tool of ["ai_schema_check", "ai_record", "ai_replay", "ai_bench"]) assert.ok(text.includes(tool), tool);
    for (const test of Object.values(AiCheckTest)) assert.ok(text.includes(`ai-${test}`), test);
    for (const starter of ["world-sim", "creature-gen", "agent-arena", "npc-dialogue"])
      assert.ok(text.includes(starter), starter);
  });
});
