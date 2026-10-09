/**
 * The Genex Codex lane's host-skill suppression (evals plan §5.3, lane D): an eval-only engine
 * option that disables every `~/.agents/skills/<name>/SKILL.md` by path and turns off Codex's
 * computer-use and browser features, so no operator context reaches the lane. The CLI is
 * injected; what is asserted is the argv the engine hands it, and that reading the skills folder
 * never writes to it.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  CodexEngine,
  type CodexExec,
  HOST_SKILL_DISABLED_FEATURES,
  HostSkills,
  hostSkillSuppressionArgs,
} from "../../src/substrate/engines/codex.ts";
import { fixtureCodingCli } from "../helpers/external-cli.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A fake `codex exec` that records each argv and ends the turn at once. */
function recordingExec() {
  const argvs: string[][] = [];
  const fn: CodexExec = (invocation) => {
    argvs.push(invocation.argv);
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "turn.completed" };
      },
    };
  };
  return { fn, argvs };
}

async function engineWith(options: {
  hostSkills?: HostSkills;
  hostSkillsDir?: string;
  listFeatures?: () => Promise<string>;
}) {
  const root = await tmpDir("studio-eval-codex-");
  const home = path.join(root, "codex-home");
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, "auth.json"), "{}");
  const exec = recordingExec();
  const engine = new CodexEngine({
    resolveCli: fixtureCodingCli,
    engineHome: home,
    systemHome: path.join(root, "no-system-login"),
    executable: "/fake/codex",
    authStatusFn: async () => ({ loggedIn: true, method: "chatgpt", detail: "Logged in using ChatGPT" }),
    execFn: exec.fn,
    ...options,
  });
  return { engine, root, argvs: exec.argvs };
}

/** The `--disable` flags the lane passes, in order. */
const DISABLE_FLAGS = HOST_SKILL_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]);

describe("codex host-skill suppression", () => {
  it("keeps a normal launch's skills, and still turns Codex's own computer use and browsers off", async () => {
    // Flipped on purpose (computer-use epic): a normal launch once passed no `--disable` at all, so
    // Codex's own computer use could drive the person's real screen past the studio's consent. The
    // studio's `computer` tool is the only hands an agent has, in every lane.
    const skills = await tmpDir("studio-eval-skills-");
    await mkdir(path.join(skills, "alpha"));
    await writeFile(path.join(skills, "alpha", "SKILL.md"), "# alpha\n");
    const { engine, root, argvs } = await engineWith({ hostSkillsDir: skills });
    await engine.delegate({ cwd: root, prompt: "Build" });
    const argv = argvs[0] ?? [];
    assert.equal(
      argv.some((arg) => arg.startsWith("skills.config=")),
      false,
    );
    assert.deepEqual(argv.slice(-(DISABLE_FLAGS.length + 1), -1), DISABLE_FLAGS);
    assert.equal(argv.at(-1), "-");
  });

  it("disables only the features this Codex knows: an older CLI refuses an unknown feature flag outright", async () => {
    const skills = await tmpDir("studio-eval-skills-");
    const { engine, root, argvs } = await engineWith({
      hostSkillsDir: skills,
      listFeatures: async () => "computer_use  stable  true\nin_app_browser  stable  true\nunrelated  beta  false\n",
    });
    await engine.delegate({ cwd: root, prompt: "Build" });
    const argv = argvs[0] ?? [];
    assert.deepEqual(argv.slice(-5, -1), ["--disable", "computer_use", "--disable", "in_app_browser"]);
    assert.ok(!argv.includes("browser_use_external"), "a feature this CLI does not list is never named");
    const broken = await engineWith({
      hostSkillsDir: skills,
      listFeatures: async () => {
        throw new Error("features: no such command");
      },
    });
    await broken.engine.delegate({ cwd: broken.root, prompt: "Build" });
    assert.equal((broken.argvs[0] ?? []).includes("--disable"), false, "a CLI that cannot list features is sent none");
  });

  it("disables each host skill by path and the browser features, before the stdin prompt", async () => {
    const skills = await tmpDir("studio-eval-skills-");
    await mkdir(path.join(skills, "alpha"));
    await writeFile(path.join(skills, "alpha", "SKILL.md"), "# alpha\n");
    const { engine, root, argvs } = await engineWith({ hostSkills: HostSkills.Suppress, hostSkillsDir: skills });
    await engine.delegate({ cwd: root, prompt: "Build" });
    const argv = argvs[0] ?? [];
    assert.equal(argv.at(-1), "-");
    const tail = argv.slice(-(DISABLE_FLAGS.length + 3), -1);
    assert.deepEqual(tail, [
      "-c",
      `skills.config=[{path=${JSON.stringify(path.join(skills, "alpha", "SKILL.md"))},enabled=false}]`,
      ...DISABLE_FLAGS,
    ]);
  });

  it("with no skills folder, disables only the features and creates nothing", async () => {
    const base = await tmpDir("studio-eval-skills-");
    const missing = path.join(base, "agents", "skills");
    const { engine, root, argvs } = await engineWith({ hostSkills: HostSkills.Suppress, hostSkillsDir: missing });
    await engine.delegate({ cwd: root, prompt: "Build" });
    const argv = argvs[0] ?? [];
    assert.equal(
      argv.some((arg) => arg.startsWith("skills.config=")),
      false,
    );
    assert.deepEqual(argv.slice(-(DISABLE_FLAGS.length + 1), -1), DISABLE_FLAGS);
    assert.deepEqual(await readdir(base), []);
  });

  // Hostile entries in the skills folder: each row names what lies there and the SKILL.md paths
  // (relative to the folder, or to the link's target) that must be disabled. Nothing is written.
  const HOSTILE: Array<{ name: string; lay: (dir: string, outside: string) => Promise<void>; disabled: string[] }> = [
    {
      name: "a folder without SKILL.md is not a skill",
      lay: async (dir) => mkdir(path.join(dir, "empty")),
      disabled: [],
    },
    {
      name: "a plain file at the top is not a skill",
      lay: async (dir) => writeFile(path.join(dir, "SKILL.md"), "# stray\n"),
      disabled: [],
    },
    {
      name: "a quote and a newline in the folder name stay inside the TOML string",
      lay: async (dir) => {
        await mkdir(path.join(dir, 'q"u\note'));
        await writeFile(path.join(dir, 'q"u\note', "SKILL.md"), "# q\n");
      },
      disabled: ['q"u\note/SKILL.md'],
    },
    {
      name: "a linked skill is disabled by its link path and its real path",
      lay: async (dir, outside) => {
        await mkdir(path.join(outside, "real-skill"));
        await writeFile(path.join(outside, "real-skill", "SKILL.md"), "# linked\n");
        await symlink(path.join(outside, "real-skill"), path.join(dir, "linked"));
      },
      disabled: ["linked/SKILL.md", "@outside/real-skill/SKILL.md"],
    },
    {
      name: "a dangling link is skipped",
      lay: async (dir, outside) => symlink(path.join(outside, "gone"), path.join(dir, "dangling")),
      disabled: [],
    },
  ];
  for (const row of HOSTILE) {
    it(`hostile skills folder: ${row.name}`, async () => {
      const skills = await tmpDir("studio-eval-skills-");
      const outside = await tmpDir("studio-eval-outside-");
      await row.lay(skills, outside);
      const before = { skills: await readdir(skills), outside: await readdir(outside) };
      const { engine, root, argvs } = await engineWith({ hostSkills: HostSkills.Suppress, hostSkillsDir: skills });
      await engine.delegate({ cwd: root, prompt: "Build" });
      const realOutside = await realpath(outside);
      const expected = row.disabled.map((rel) =>
        rel.startsWith("@outside/") ? path.join(realOutside, rel.slice("@outside/".length)) : path.join(skills, rel),
      );
      const configArg = (argvs[0] ?? []).find((arg) => arg.startsWith("skills.config="));
      assert.deepEqual(configArg, expected.length ? hostSkillSuppressionArgs(expected)[1] : undefined);
      assert.deepEqual({ skills: await readdir(skills), outside: await readdir(outside) }, before);
    });
  }
});
