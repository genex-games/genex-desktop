import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readdir, realpath, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  claudeGlobalSkills,
  codexBuilderUse,
  normalizeCodexSkills,
  openCodeGlobalSkills,
  projectSkills,
} from "../../src/main/provider-skills.ts";
import { registerSkillsIpc } from "../../src/main/ipc/skills.ts";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { assertOwnedProject } from "../../src/main/project-policy.ts";
import { GameWorkspaces } from "../../src/substrate/game-workspace.ts";
import { LoginSource } from "../../src/shared/engine-descriptor.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { ProviderBuilderUse, type ProjectSkillInventory } from "../../src/shared/provider-skills.ts";
test("native Codex discovery preserves disabled global skills and excludes project scope", () => {
  const skill = {
    name: "global",
    path: "/home/test/.agents/skills/global/SKILL.md",
    scope: "user",
    enabled: false,
    description: "Example",
  };
  const rows = normalizeCodexSkills({
    data: [
      {
        skills: [
          skill,
          { ...skill },
          { ...skill, name: "project", path: "/game/.agents/skills/project/SKILL.md", scope: "repo" },
          { name: "invalid" },
        ],
      },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.enabled, false);
  assert.equal(rows[0]?.scope, "user");
  assert.deepEqual(normalizeCodexSkills({}), []);
});
test("Claude inventories personal, shared symlinks, commands, managed and installed plugin skills without loading settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "provider-skills-"));
  const home = path.join(root, ".claude"),
    managed = path.join(root, "managed");
  const skill = async (dir: string, name: string) => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Use ${name}\n---\nInstructions`);
  };
  try {
    await skill(path.join(home, "skills/personal"), "Personal");
    await mkdir(path.join(home, "skills/personal/references/a/b/c/d/e/f/g"), { recursive: true });
    await writeFile(
      path.join(home, "skills/personal/SKILL.md"),
      "---\nname: Personal\ndescription: >-\n  A multiline\n  description.\n---\nInstructions",
    );
    await skill(path.join(root, ".agents/skills/shared"), "Shared");
    await symlink(path.join(root, ".agents/skills/shared"), path.join(home, "skills/shared"));
    await skill(path.join(root, "private"), "Secret");
    await symlink(path.join(root, "private"), path.join(home, "skills/escape"));
    await mkdir(path.join(home, "commands"), { recursive: true });
    await writeFile(path.join(home, "commands/legacy.md"), "Legacy instructions");
    const live = path.join(home, "plugins/cache/example/2");
    await skill(path.join(live, "skills/example"), "Current plugin");
    await skill(path.join(home, "plugins/cache/example/1/skills/example"), "Obsolete plugin");
    await writeFile(
      path.join(home, "plugins/installed_plugins.json"),
      JSON.stringify({ plugins: { example: [{ scope: "user", installPath: live }] } }),
    );
    await writeFile(path.join(home, "settings.json"), "unreadable settings must never execute hooks");
    await skill(path.join(managed, "managed"), "Managed");
    const result = await claudeGlobalSkills(home, root, managed);
    assert.deepEqual(
      result.skills.map((s) => s.name),
      ["Current plugin", "legacy", "Managed", "Personal", "Shared"],
    );
    assert.equal(result.warnings.length, 0);
    assert.equal(result.skills.find((s) => s.name === "Personal")?.description, "A multiline description.");
    assert.match(result.note, /not enabled/);
    assert.ok(result.skills.every((s) => s.enabled === undefined));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("missing Claude folders are empty; corrupt plugin metadata remains a visible warning", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "provider-skills-empty-"));
  try {
    assert.equal((await claudeGlobalSkills(root, root, path.join(root, "managed"))).skills.length, 0);
    await mkdir(path.join(root, "plugins"));
    await writeFile(path.join(root, "plugins/installed_plugins.json"), "{broken");
    const result = await claudeGlobalSkills(root, root, path.join(root, "managed"));
    assert.equal(result.warnings.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const KIB = 1024;
const skillFile = (name: string) => `---\nname: ${name}\ndescription: Use ${name}\n---\nInstructions`;

/** Every entry under `dir`, links not followed, with what a write would change. */
async function tree(dir: string): Promise<string[]> {
  const rows: string[] = [];
  const walk = async (at: string): Promise<void> => {
    const info = await lstat(at);
    rows.push(`${path.relative(dir, at)} ${info.mode} ${info.size} ${info.mtimeMs}`);
    if (!info.isDirectory()) return;
    for (const entry of (await readdir(at)).sort()) await walk(path.join(at, entry));
  };
  await walk(dir);
  return rows;
}

/** A games root with one game, `demo`, and a folder outside it; the body gets all three. */
async function withGame<T>(body: (games: string, game: string, outside: string) => Promise<T>): Promise<T> {
  // Real paths: the development containment check refuses a games root reached through a link (/var).
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "project-skills-")));
  const games = path.join(root, "games"),
    game = path.join(games, "demo"),
    outside = path.join(root, "outside");
  try {
    await mkdir(path.join(outside, "stolen"), { recursive: true });
    await writeFile(path.join(outside, "stolen", "SKILL.md"), skillFile("Stolen"));
    await writeFile(path.join(outside, "stolen.md"), "Stolen command");
    await mkdir(path.join(game, ".claude/skills/level-design"), { recursive: true });
    await writeFile(path.join(game, ".claude/skills/level-design/SKILL.md"), skillFile("Level design"));
    await mkdir(path.join(game, ".claude/commands"), { recursive: true });
    await writeFile(path.join(game, ".claude/commands/playtest.md"), "---\ndescription: Play it\n---\nPlay.");
    await mkdir(path.join(game, ".agents/skills/shaders"), { recursive: true });
    await writeFile(path.join(game, ".agents/skills/shaders/SKILL.md"), skillFile("Shaders"));
    return await body(games, game, outside);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a game's project skills and commands are listed with the builders that load them", async () => {
  await withGame(async (_games, game) => {
    const before = await tree(game);
    const { skills, warnings } = await projectSkills(game);
    assert.deepEqual(skills, [
      {
        name: "Level design",
        description: "Use Level design",
        path: ".claude/skills/level-design/SKILL.md",
        kind: "skill",
        engines: [EngineId.ClaudeCode],
      },
      {
        name: "playtest",
        description: "Play it",
        path: ".claude/commands/playtest.md",
        kind: "command",
        engines: [EngineId.ClaudeCode],
      },
      {
        name: "Shaders",
        description: "Use Shaders",
        path: ".agents/skills/shaders/SKILL.md",
        kind: "skill",
        engines: [EngineId.Codex],
      },
    ]);
    assert.deepEqual(warnings, []);
    assert.deepEqual(await tree(game), before);
  });
});

test("one skill folder both builders read is listed once, for both", async () => {
  await withGame(async (_games, game) => {
    await rm(path.join(game, ".agents/skills"), { recursive: true });
    await symlink(path.join(game, ".claude/skills"), path.join(game, ".agents/skills"));
    const { skills } = await projectSkills(game);
    const shared = skills.filter((s) => s.name === "Level design");
    assert.equal(shared.length, 1);
    assert.deepEqual(shared[0]?.engines, [EngineId.ClaudeCode, EngineId.Codex]);
  });
});

/** Hostile game folders: each lists nothing from outside the game and leaves the folder as it was. */
const HOSTILE_PROJECTS: Array<{
  name: string;
  arrange(game: string, outside: string): Promise<void>;
  warns?: boolean;
}> = [
  {
    name: "a skill folder linked outside the game",
    arrange: (game, outside) => symlink(path.join(outside, "stolen"), path.join(game, ".claude/skills/stolen")),
  },
  {
    name: "a SKILL.md linked outside the game",
    arrange: async (game, outside) => {
      await mkdir(path.join(game, ".claude/skills/stolen"));
      await symlink(path.join(outside, "stolen", "SKILL.md"), path.join(game, ".claude/skills/stolen/SKILL.md"));
    },
  },
  {
    name: "a command linked outside the game",
    arrange: (game, outside) => symlink(path.join(outside, "stolen.md"), path.join(game, ".claude/commands/stolen.md")),
  },
  {
    name: "a whole skills root linked outside the game",
    arrange: async (game, outside) => {
      await rm(path.join(game, ".agents/skills"), { recursive: true });
      await symlink(outside, path.join(game, ".agents/skills"));
    },
  },
  {
    name: "the .claude folder linked outside the game",
    arrange: async (game, outside) => {
      await rm(path.join(game, ".claude"), { recursive: true });
      await mkdir(path.join(outside, "skills", "stolen"), { recursive: true });
      await writeFile(path.join(outside, "skills", "stolen", "SKILL.md"), skillFile("Stolen"));
      await symlink(outside, path.join(game, ".claude"));
    },
  },
  {
    name: "a 300 KiB SKILL.md",
    arrange: async (game) => {
      await mkdir(path.join(game, ".claude/skills/huge"));
      await writeFile(
        path.join(game, ".claude/skills/huge/SKILL.md"),
        `${skillFile("Stolen")}\n${"x".repeat(300 * KIB)}`,
      );
    },
    warns: true,
  },
];

for (const row of HOSTILE_PROJECTS)
  test(`project skills: ${row.name} is not listed, and the game is left as it was`, async () => {
    await withGame(async (_games, game, outside) => {
      await row.arrange(game, outside);
      const before = await tree(game);
      const outsideBefore = await tree(outside);
      const { skills, warnings } = await projectSkills(game);
      assert.ok(!skills.some((s) => s.name === "Stolen"), JSON.stringify(skills));
      assert.ok(skills.every((s) => !s.path.startsWith("..") && !path.isAbsolute(s.path)));
      assert.equal(warnings.length > 0, row.warns === true, JSON.stringify(warnings));
      assert.deepEqual(await tree(game), before);
      assert.deepEqual(await tree(outside), outsideBefore);
    });
  });

test("whether Codex's global skills reach builders follows the login they use", () => {
  assert.equal(codexBuilderUse(LoginSource.System), ProviderBuilderUse.BorrowedLogin);
  assert.equal(codexBuilderUse(LoginSource.Env), ProviderBuilderUse.BorrowedLogin);
  assert.equal(codexBuilderUse(LoginSource.Isolated), ProviderBuilderUse.StudioProfile);
  assert.equal(codexBuilderUse(LoginSource.None), ProviderBuilderUse.NoLogin);
});

test("Claude's global skills say they never reach builders", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "provider-skills-builders-"));
  try {
    const result = await claudeGlobalSkills(root, root, path.join(root, "managed"));
    assert.equal(result.builders, ProviderBuilderUse.NotLoaded);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

type Listener = (event: IpcSender, payload: unknown) => Promise<IpcResult>;

/** The skills registrar over a real games root, the development containment check and a recorded skillText. */
function skillsIpc(games: string) {
  const listeners = new Map<string, Listener>();
  const handle = createIpcHandle(
    { handle: (channel, listener) => void listeners.set(channel, listener) },
    { fixture: true, isStudioUi: () => true },
  );
  const reads: unknown[][] = [];
  const workspace = new GameWorkspaces({
    root: games,
    templateDir: games,
    vendorDir: games,
    indexFile: path.join(games, "index.json"),
    userData: games,
  });
  registerSkillsIpc(handle, {
    core: {
      layout: { harnessWs: games } as never,
      games: workspace,
      assertProjectAllowed: (dir: string) => assertOwnedProject(games, dir),
      plugins: {
        skillText: async (...args: unknown[]) => {
          reads.push(args);
          return "text";
        },
      } as never,
    },
    subscription: () => null,
    home: () => games,
  });
  const invoke = (channel: string, payload?: unknown) => {
    const listener = listeners.get(channel);
    assert.ok(listener, `${channel} is not registered`);
    return listener({ sender: "studio", senderFrame: "main-frame" }, payload);
  };
  return { invoke, reads };
}

test("studio:skills.project lists the named game's skills", async () => {
  await withGame(async (games) => {
    const result = await skillsIpc(games).invoke("studio:skills.project", { project: "demo" });
    assert.equal(result.ok, true);
    const inventory = (result as { value: ProjectSkillInventory }).value;
    assert.equal(inventory.project, "demo");
    assert.deepEqual(
      inventory.skills.map((s) => s.name),
      ["Level design", "playtest", "Shaders"],
    );
  });
});

/**
 * Payloads the channel refuses. The name checks hold in every profile; the linked folder is refused
 * only by the development containment root (`executionPolicy.allowedProjectRoot`, set for dev
 * profiles alone), which `skillsIpc` wires in: a normal profile treats a linked game folder as the
 * user's own game. The rows prove the refusal and that nothing is written, not that nothing is read.
 */
const HOSTILE_PROJECT_PAYLOADS: Array<{ name: string; payload: unknown }> = [
  { name: "no payload", payload: undefined },
  { name: "no project", payload: {} },
  { name: "a number", payload: { project: 7 } },
  { name: "a traversal", payload: { project: "../outside" } },
  { name: "an absolute path", payload: { project: "/etc" } },
  { name: "a game folder linked outside the games root, in a development profile", payload: { project: "alias" } },
];

for (const row of HOSTILE_PROJECT_PAYLOADS)
  test(`studio:skills.project refuses ${row.name} and writes nothing`, async () => {
    await withGame(async (games, _game, outside) => {
      await mkdir(path.join(outside, ".claude/skills"), { recursive: true });
      await symlink(path.join(outside, "stolen"), path.join(outside, ".claude/skills/stolen"));
      await symlink(outside, path.join(games, "alias"));
      const before = await tree(path.dirname(games));
      const result = await skillsIpc(games).invoke("studio:skills.project", row.payload);
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.deepEqual(await tree(path.dirname(games)), before);
    });
  });

test("studio:plugins.skill reads a plugin skill's text, and refuses a malformed request before any read", async () => {
  await withGame(async (games) => {
    const ipc = skillsIpc(games);
    const ok = await ipc.invoke("studio:plugins.skill", { id: "genex", name: "multiplayer", file: "refs/rooms.md" });
    assert.deepEqual(ok, { ok: true, value: "text" });
    assert.deepEqual(await ipc.invoke("studio:plugins.skill", { id: "genex", name: "publishing" }), {
      ok: true,
      value: "text",
    });
    for (const payload of [
      undefined,
      {},
      { id: 1, name: "a" },
      { id: "genex", name: {} },
      { id: "genex", name: "a", file: 3 },
    ]) {
      const result = await ipc.invoke("studio:plugins.skill", payload);
      assert.equal(result.ok, false, JSON.stringify(payload));
    }
    assert.deepEqual(ipc.reads, [
      ["genex", "multiplayer", "refs/rooms.md"],
      ["genex", "publishing", undefined],
    ]);
  });
});
test("OpenCode lists installed global skills by name, sorted, never for builders", async () => {
  const config = await mkdtemp(path.join(os.tmpdir(), "opencode-skills-"));
  try {
    for (const [name, description] of [
      ["zebra", "Striped helper"],
      ["alpha", "First helper"],
    ]) {
      await mkdir(path.join(config, "skills", name), { recursive: true });
      await writeFile(
        path.join(config, "skills", name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\n---\n`,
      );
    }
    const inventory = await openCodeGlobalSkills("/nonexistent-home", config, async () => true);
    assert.deepEqual(
      inventory.skills.map((s) => [s.name, s.description]),
      [
        ["alpha", "First helper"],
        ["zebra", "Striped helper"],
      ],
    );
    assert.equal(inventory.provider, "opencode");
    assert.equal(inventory.builders, ProviderBuilderUse.NotLoaded);
    assert.ok(inventory.note.length > 0, "the panel says builders never load these");
  } finally {
    await rm(config, { recursive: true, force: true });
  }
});
test("OpenCode names a missing CLI as the next step, and reads around what it cannot use", async () => {
  const config = await mkdtemp(path.join(os.tmpdir(), "opencode-skills-"));
  try {
    await mkdir(path.join(config, "skills", "broken"), { recursive: true });
    await writeFile(path.join(config, "skills", "broken", "SKILL.md"), "no front matter here\n");
    const withoutCli = await openCodeGlobalSkills("/nonexistent-home", config, async () => false);
    assert.deepEqual(withoutCli.skills, []);
    assert.ok(
      withoutCli.warnings.some((warning) => /Model Providers/.test(warning)),
      "names the next step",
    );
    const partial = await openCodeGlobalSkills("/nonexistent-home", config, async () => true);
    assert.deepEqual(
      partial.skills.map((s) => [s.name, s.description]),
      [["broken", ""]],
      "a skill without front matter still lists under its folder name",
    );
    const absent = await openCodeGlobalSkills("/nonexistent-home", path.join(config, "nope"), async () => true);
    assert.deepEqual(absent.skills, []);
  } finally {
    await rm(config, { recursive: true, force: true });
  }
});
