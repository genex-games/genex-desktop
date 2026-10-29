/**
 * The plan watcher's production parts (`main/game-ai/player-watcher-host.ts`): the name this Mac
 * shows on genex.games' watcher list, the platform tag the heartbeat reports, where its files go,
 * and the box each job runs in (a real `ProcessSandbox`, here with Seatbelt off).
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { memoryKeyStore } from "../../src/substrate/provider-keys.ts";
import {
  planWatcherDeps,
  platformTag,
  runnerSandboxes,
  watcherLabel,
} from "../../src/main/game-ai/player-watcher-host.ts";

const temps: string[] = [];
after(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("the name and platform genex.games is told", () => {
  const labels: Array<[string, string]> = [
    ["Ivans-MacBook-Pro.local", "Genex on Ivans-MacBook-Pro"],
    ["studio", "Genex on studio"],
    ["", "Genex on this Mac"],
    ["   ", "Genex on this Mac"],
    ["evil\u0000host\nname", "Genex on evilhostname"],
    ["<script>alert(1)</script>", "Genex on scriptalert1script"],
    ["x".repeat(200), `Genex on ${"x".repeat(48)}`],
  ];
  for (const [hostname, label] of labels) {
    it(`labels ${JSON.stringify(hostname.slice(0, 30))} as ${JSON.stringify(label.slice(0, 40))}`, () => {
      assert.equal(watcherLabel(hostname), label);
      assert.ok(watcherLabel(hostname).length <= 64);
    });
  }

  it("tags the platform the way genex.games' heartbeat route takes it", () => {
    assert.equal(platformTag("darwin"), "darwin");
    assert.equal(platformTag("win32"), "win32");
    assert.equal(platformTag("Linux OS!"), "linuxos");
    assert.equal(platformTag(""), "unknown");
    assert.equal(platformTag("a".repeat(80)).length, 40);
  });
});

describe("the watcher's files", () => {
  it("keeps the switch, the probe's canary and the jobs' folders where no other part looks", () => {
    const deps = planWatcherDeps({
      origins: { api: "https://api.genex.games", web: "https://genex.games", games: "https://genex.technology" },
      version: "0.1.11",
      userData: "/Users/p/Library/Application Support/Genex",
      secretsDir: "/Users/p/Library/Application Support/Genex/secrets",
      protectedPaths: [],
      credential: memoryKeyStore(),
      home: "/Users/p",
      hostname: "studio",
      platform: "darwin",
      tmpRoot: "/private/var/folders/x/T",
      planUsage: async () => null,
      keepForBuildingPercent: async () => 50,
      openSignIn: async () => {},
      notify: () => {},
      log: () => {},
    });
    assert.equal(deps.stateFile, "/Users/p/Library/Application Support/Genex/game-ai/watcher.json");
    assert.equal(deps.canaryDir, "/Users/p/Library/Application Support/Genex/game-ai/probe");
    assert.ok(deps.canaryDir.startsWith(`${deps.home}/`), "the canary sits inside the home folder every job is denied");
    assert.equal(deps.tmpRoot, "/private/var/folders/x/T/genex-player");
    assert.equal(deps.label, "Genex on studio");
    assert.equal(deps.platform, "darwin");
    assert.equal(deps.api, "https://api.genex.games");
  });
});

describe("the box a job runs in", () => {
  it("runs in the job's own folder and leaves nothing running", async () => {
    const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "plan-watcher-host-")));
    temps.push(cwd);
    const sandbox = await runnerSandboxes([], { enabled: false })({ cwd, ownHome: [] });
    try {
      const result = await sandbox.run({ command: "pwd", cwd, timeoutMs: 10_000 });
      assert.equal(result.code, 0);
      assert.equal(await realpath(result.stdout.trim()), cwd);
    } finally {
      await sandbox.dispose();
    }
  });
});
