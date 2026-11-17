import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  AUTO_UPDATE_EVERY_MS,
  AUTO_UPDATE_FIRST_CHECK_MS,
  CliAutoUpdateOutcome,
  autoUpdateCodex,
  scheduleCliAutoUpdate,
  type CliAutoUpdateDeps,
} from "../../src/main/cli-auto-update.ts";
import { CliInstallPhase, CliInstallProblem, type CliInstallJob } from "../../src/shared/cli-install.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { installedByCodexInstaller, latestCodexVersion, updateCodingCli } from "../../src/substrate/cli-update.ts";
import { fixtureCodingCli } from "../helpers/external-cli.ts";

const job = (phase: CliInstallPhase): CliInstallJob => ({
  provider: EngineId.Codex,
  phase,
  startedAt: "2026-11-17T18:00:00.000Z",
});

/** A check on the installer's own Codex 0.162.0 with 0.169.0 out, changed per case. */
function world(change: Partial<CliAutoUpdateDeps> = {}): { deps: CliAutoUpdateDeps; updates: string[]; log: string[] } {
  const updates: string[] = [];
  const log: string[] = [];
  const deps: CliAutoUpdateDeps = {
    selected: async () => ({ path: "/home/sam/.local/bin/codex", version: "codex-cli 0.162.0" }),
    owned: async () => true,
    latest: async () => "0.169.0",
    busy: () => false,
    update: async (provider, operation) => {
      updates.push(`${provider} ${operation}`);
      return job(CliInstallPhase.Installed);
    },
    log: (line) => log.push(line),
    ...change,
  };
  return { deps, updates, log };
}

test("the installer's own Codex moves to a newer stable release, and only then", async () => {
  const newer = world();
  assert.equal(await autoUpdateCodex(newer.deps), CliAutoUpdateOutcome.Updated);
  assert.deepEqual(newer.updates, ["codex update"]);
  assert.match(newer.log.join("\n"), /0\.162\.0 to 0\.169\.0/);

  const cases: Array<[string, Partial<CliAutoUpdateDeps>, CliAutoUpdateOutcome]> = [
    ["no Codex", { selected: async () => null }, CliAutoUpdateOutcome.NoCli],
    ["an npm, Homebrew or app copy", { owned: async () => false }, CliAutoUpdateOutcome.NotOwned],
    ["the latest is not known", { latest: async () => null }, CliAutoUpdateOutcome.Unknown],
    [
      "its version is not known",
      { selected: async () => ({ path: "/home/sam/.local/bin/codex" }) },
      CliAutoUpdateOutcome.Unknown,
    ],
    ["already the latest", { latest: async () => "0.162.0" }, CliAutoUpdateOutcome.Current],
    ["newer than the latest stable", { latest: async () => "0.161.0" }, CliAutoUpdateOutcome.Current],
    [
      "an alpha ahead of the latest stable stays",
      { selected: async () => ({ path: "/home/sam/.local/bin/codex", version: "0.170.0-alpha.2" }) },
      CliAutoUpdateOutcome.Current,
    ],
    ["work under way", { busy: () => true }, CliAutoUpdateOutcome.Busy],
  ];
  for (const [name, change, expected] of cases) {
    const quiet = world(change);
    assert.equal(await autoUpdateCodex(quiet.deps), expected, name);
    assert.deepEqual(quiet.updates, [], name);
  }
});

test("an alpha of the latest stable release moves to the release itself", async () => {
  const alpha = world({
    selected: async () => ({ path: "/home/sam/.local/bin/codex", version: "0.169.0-alpha.17.2" }),
  });
  assert.equal(await autoUpdateCodex(alpha.deps), CliAutoUpdateOutcome.Updated);
});

test("work that starts while the versions are read stops the update", async () => {
  let asked = 0;
  const late = world({ busy: () => asked++ > 0 });
  assert.equal(await autoUpdateCodex(late.deps), CliAutoUpdateOutcome.Busy);
  assert.deepEqual(late.updates, []);
});

test("a failed or refused background update is logged and never thrown", async () => {
  const failed = world({
    update: async () => ({ ...job(CliInstallPhase.Failed), problem: CliInstallProblem.Installer }),
  });
  assert.equal(await autoUpdateCodex(failed.deps), CliAutoUpdateOutcome.Failed);
  const refused = world({
    update: async () => {
      throw new Error("busy");
    },
  });
  assert.equal(await autoUpdateCodex(refused.deps), CliAutoUpdateOutcome.Failed);
  assert.match(refused.log.join("\n"), /busy/);
  const offline = world({
    latest: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(await autoUpdateCodex(offline.deps), CliAutoUpdateOutcome.Failed);
  assert.deepEqual(offline.updates, []);
});

test("the check runs once soon after launch and then on a slow clock, until stopped", () => {
  const set: Array<{ kind: string; ms: number; fn: () => void }> = [];
  const cleared: unknown[] = [];
  let runs = 0;
  const stop = scheduleCliAutoUpdate(
    async () => {
      runs++;
    },
    {
      setTimeout: (fn, ms) => set[set.push({ kind: "once", ms, fn }) - 1],
      setInterval: (fn, ms) => set[set.push({ kind: "every", ms, fn }) - 1],
      clear: (timer) => cleared.push(timer),
    },
  );
  assert.deepEqual(
    set.map(({ kind, ms }) => [kind, ms]),
    [
      ["once", AUTO_UPDATE_FIRST_CHECK_MS],
      ["every", AUTO_UPDATE_EVERY_MS],
    ],
  );
  assert.equal(runs, 0);
  for (const timer of set) timer.fn();
  assert.equal(runs, 2);
  stop();
  assert.deepEqual(cleared, set);
});

test("only a Codex inside the installer's own folder is the installer's, on each system", async () => {
  const cases: Array<[string, NodeJS.Platform, string, string, string, boolean]> = [
    [
      "the installer's command on macOS and Linux",
      "linux",
      "/home/sam",
      "/home/sam/.local/bin/codex",
      "/home/sam/.codex/packages/standalone/releases/0.169.0-x86_64-unknown-linux-musl/bin/codex",
      true,
    ],
    [
      "the installer's command on Windows",
      "win32",
      "C:\\Users\\Sam",
      "C:\\Users\\Sam\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
      "c:\\users\\sam\\.codex\\packages\\standalone\\releases\\0.169.0\\bin\\codex.exe",
      true,
    ],
    [
      "Homebrew",
      "darwin",
      "/Users/sam",
      "/opt/homebrew/bin/codex",
      "/opt/homebrew/Cellar/codex/0.169.0/bin/codex",
      false,
    ],
    [
      "npm",
      "linux",
      "/home/sam",
      "/home/sam/.npm-global/bin/codex",
      "/home/sam/.npm-global/lib/node_modules/@openai/codex/bin/codex.js",
      false,
    ],
    [
      "the ChatGPT app",
      "darwin",
      "/Users/sam",
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
      false,
    ],
    [
      "a folder that only starts like the installer's",
      "linux",
      "/home/sam",
      "/home/sam/bin/codex",
      "/home/sam/.codex/packages/standalone-old/bin/codex",
      false,
    ],
    [
      "a path that climbs out of the installer's folder",
      "linux",
      "/home/sam",
      "/home/sam/bin/codex",
      "/home/sam/.codex/packages/other/codex",
      false,
    ],
    [
      "another person's installer folder",
      "linux",
      "/home/sam",
      "/usr/local/bin/codex",
      "/home/eve/.codex/packages/standalone/bin/codex",
      false,
    ],
  ];
  for (const [name, platform, home, executable, target, expected] of cases) {
    const real = async (file: string): Promise<string> => (file === executable ? target : file);
    assert.equal(await installedByCodexInstaller(executable, { home, real, platform }), expected, name);
  }
  const broken = async (): Promise<string> => {
    throw new Error("ENOENT");
  };
  assert.equal(
    await installedByCodexInstaller("/home/sam/.local/bin/codex", {
      home: "/home/sam",
      real: broken,
      platform: "linux",
    }),
    false,
    "a link that leads nowhere",
  );
});

test("the latest Codex is a stable release named by OpenAI, else by GitHub, else unknown", async () => {
  const answers = (table: Record<string, () => Response>) => {
    const asked: string[] = [];
    const fetchFn = async (url: string): Promise<Response> => {
      asked.push(new URL(url).hostname);
      const answer = table[new URL(url).hostname];
      if (!answer) throw new Error("ERR_NAME_NOT_RESOLVED");
      return answer();
    };
    return { asked, fetchFn };
  };
  const json =
    (body: unknown, status = 200) =>
    () =>
      new Response(JSON.stringify(body), { status });

  const first = answers({ "releases.openai.com": json({ tag_name: "rust-v0.169.0" }) });
  assert.equal(await latestCodexVersion(first.fetchFn), "0.169.0");
  assert.deepEqual(first.asked, ["releases.openai.com"]);

  const fallback = answers({ "api.github.com": json({ tag_name: "rust-v0.168.1" }) });
  assert.equal(await latestCodexVersion(fallback.fetchFn), "0.168.1");

  const hostile: Array<[string, () => Response]> = [
    ["an alpha", json({ tag_name: "rust-v0.170.0-alpha.3" })],
    ["a beta", json({ tag_name: "rust-v0.170.0-beta.1" })],
    ["another tag", json({ tag_name: "v0.169.0" })],
    ["a version with a command in it", json({ tag_name: "rust-v0.169.0; rm -rf ~" })],
    ["no tag", json({ version: "0.169.0" })],
    ["a refusal", json({ tag_name: "rust-v0.169.0" }, 403)],
    ["not JSON", () => new Response("<html>")],
  ];
  for (const [name, answer] of hostile) {
    const source = answers({ "releases.openai.com": answer, "api.github.com": answer });
    assert.equal(await latestCodexVersion(source.fetchFn), null, name);
  }
  assert.equal(await latestCodexVersion(answers({}).fetchFn), null, "offline");
});

test("Update on the installer's own Codex runs the installer, never `codex update`, and other copies never run it", async () => {
  const home = path.join(path.sep, "home", "sam");
  const owned = path.join(home, ".local", "bin", "codex");
  const target = path.join(home, ".codex", "packages", "standalone", "releases", "0.162.0", "bin", "codex");
  const real = async (file: string): Promise<string> => (file === owned ? target : file);
  const steps: string[] = [];
  const result = await updateCodingCli(EngineId.Codex, owned, {
    resolve: async (provider) => ({ ...(await fixtureCodingCli(provider)), path: owned }),
    run: async () => assert.fail("the installer's Codex was asked to update itself"),
    install: async (provider) => {
      steps.push(`install ${provider}`);
      return { ok: true };
    },
    invalidate: () => steps.push("invalidate"),
    real,
    home,
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(steps, ["install codex", "invalidate"]);

  const failed = await updateCodingCli(EngineId.Codex, owned, {
    resolve: async (provider) => ({ ...(await fixtureCodingCli(provider)), path: owned }),
    install: async () => ({ ok: false, problem: CliInstallProblem.Download, detail: "answered 403", httpStatus: 403 }),
    invalidate: () => assert.fail("a failed update invalidated the working CLI"),
    real,
    home,
  });
  assert.deepEqual(failed, { ok: false, problem: CliInstallProblem.Download, detail: "answered 403", httpStatus: 403 });

  // The same folder under another provider's name, and a Homebrew Codex, update themselves.
  for (const [provider, executable] of [
    [EngineId.Grok, owned],
    [EngineId.Codex, "/opt/homebrew/bin/codex"],
  ] as const) {
    const ran: string[] = [];
    const self = await updateCodingCli(provider, executable, {
      resolve: async (which) => ({ ...(await fixtureCodingCli(which)), path: executable }),
      run: async (binary, args) => {
        ran.push(`${binary} ${args.join(" ")}`);
        return { code: 0, stdout: "", stderr: "" };
      },
      install: async () => assert.fail("another copy was handed to the installer"),
      invalidate: () => {},
      real,
      home,
    });
    assert.deepEqual(self, { ok: true }, executable);
    assert.deepEqual(ran, [`${executable} update`], executable);
  }
});
