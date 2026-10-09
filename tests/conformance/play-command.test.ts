/**
 * How a Play Protocol game declares itself in studio.json: `"runtime": "bridge"` and a `play`
 * command that must be a plain path inside the project, still inside it once every link is
 * followed. studio.json sits in a folder any contractor writes, so every hostile spelling is
 * dropped at read time and every escape is refused at resolve time.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { TargetRuntime } from "../../src/shared/computer-target.ts";
import { TEMPLATE_SHAPE, readProjectShape, resolvePlayCommand } from "../../src/substrate/project-shape.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A project folder with this studio.json and an executable `bin/game` inside it. */
async function project(meta: unknown): Promise<string> {
  const dir = await realpath(await tmpDir("play-command-"));
  await mkdir(path.join(dir, "bin"), { recursive: true });
  await writeFile(path.join(dir, "bin", "game"), "#!/bin/sh\n");
  await chmod(path.join(dir, "bin", "game"), 0o755);
  await writeFile(path.join(dir, "studio.json"), JSON.stringify(meta));
  return dir;
}

describe("studio.json — a bridge game's runtime and play command", () => {
  it("reads a bridge game's runtime and play command", async () => {
    const dir = await project({ runtime: "bridge", play: { command: "bin/game", args: ["--headless", "--seed=1"] } });
    const shape = await readProjectShape(dir);
    assert.equal(shape.runtime, TargetRuntime.Bridge);
    assert.deepEqual(shape.play, { command: "bin/game", args: ["--headless", "--seed=1"] });
  });

  it("takes a play command without args as one with none", async () => {
    const dir = await project({ runtime: "bridge", play: { command: "bin/game" } });
    assert.deepEqual((await readProjectShape(dir)).play, { command: "bin/game", args: [] });
  });

  it("leaves a browser game's shape exactly as it was: no runtime, no play", async () => {
    const dir = await project({ bootMs: 2000 });
    const shape = await readProjectShape(dir);
    assert.equal("runtime" in shape, false);
    assert.equal("play" in shape, false);
    assert.equal(shape.runtime ?? TargetRuntime.Browser, TargetRuntime.Browser);
  });

  it("keeps a recorded browser shape whole beside a declared runtime", async () => {
    const dir = await project({ entry: "index.html", main: "src/main.js", runtime: "browser" });
    const shape = await readProjectShape(dir);
    assert.equal(shape.runtime, TargetRuntime.Browser);
    assert.equal(shape.entry, TEMPLATE_SHAPE.entry);
  });

  const unusableRuntimes: unknown[] = ["vm", "", 3, null, ["bridge"], { bridge: true }];
  for (const runtime of unusableRuntimes) {
    it(`drops an unknown runtime: ${JSON.stringify(runtime)}`, async () => {
      const dir = await project({ runtime, play: { command: "bin/game" } });
      assert.equal("runtime" in (await readProjectShape(dir)), false);
    });
  }

  const hostilePlays: Array<{ name: string; play: unknown }> = [
    { name: "a parent escape", play: { command: "../outside/game" } },
    { name: "an escape through a middle segment", play: { command: "bin/../../outside/game" } },
    { name: "an absolute path outside", play: { command: "/bin/sh" } },
    { name: "a home path", play: { command: "~/game" } },
    { name: "an option for a name", play: { command: "-rf" } },
    { name: "a shell metacharacter", play: { command: "bin/game; rm -rf ~" } },
    { name: "command substitution", play: { command: "bin/$(whoami)" } },
    { name: "a backslash path", play: { command: "bin\\game" } },
    { name: "an empty command", play: { command: "" } },
    { name: "a numeric command", play: { command: 42 } },
    { name: "no command at all", play: { args: ["--x"] } },
    { name: "a bare string", play: "bin/game" },
    { name: "non-string args", play: { command: "bin/game", args: ["--ok", 7] } },
    { name: "args that are not a list", play: { command: "bin/game", args: "--headless" } },
    { name: "an arg with a NUL byte", play: { command: "bin/game", args: ["a\u0000b"] } },
    { name: "an object arg", play: { command: "bin/game", args: [{ toString: "x" }] } },
  ];
  for (const row of hostilePlays) {
    it(`drops a play command with ${row.name}`, async () => {
      const dir = await project({ runtime: "bridge", play: row.play });
      const shape = await readProjectShape(dir);
      assert.equal("play" in shape, false);
      assert.equal(shape.runtime, TargetRuntime.Bridge, "the runtime stays declared; the source says what is missing");
    });
  }
});

describe("resolvePlayCommand — by real path, inside the project", () => {
  it("answers the command's real path inside the project", async () => {
    const dir = await project({});
    assert.equal(await resolvePlayCommand(dir, { command: "bin/game", args: [] }), path.join(dir, "bin", "game"));
  });

  const escapes: Array<{ name: string; plant: (dir: string, outside: string) => Promise<string> }> = [
    {
      name: "a link to a file outside",
      plant: async (dir, outside) => {
        await symlink(path.join(outside, "evil"), path.join(dir, "bin", "linked"));
        return "bin/linked";
      },
    },
    {
      name: "a linked folder that leads outside",
      plant: async (dir, outside) => {
        await symlink(outside, path.join(dir, "out"));
        return "out/evil";
      },
    },
    { name: "a command that does not exist", plant: async () => "bin/missing" },
    { name: "a parent escape handed in directly", plant: async () => "../evil" },
    { name: "an absolute path handed in directly", plant: async (_dir, outside) => path.join(outside, "evil") },
  ];
  for (const row of escapes) {
    it(`refuses ${row.name}`, async () => {
      const dir = await project({});
      const outside = await realpath(await tmpDir("play-outside-"));
      await writeFile(path.join(outside, "evil"), "#!/bin/sh\necho owned\n");
      const command = await row.plant(dir, outside);
      await assert.rejects(resolvePlayCommand(dir, { command, args: [] }));
    });
  }
});
