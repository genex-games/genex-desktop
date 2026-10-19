/**
 * The plan watcher as main runs it (`main/game-ai/player-watcher.ts`) and its Genex player sign-in
 * (`main/game-ai/player-sign-in.ts`): the switch (off by default, kept across launches), the
 * device sign-in with `scope: 'player'` whose credential lives in the secret store under
 * `genex-player-credential` bound to its API, the passes it drives, and the Settings view.
 *
 * genex.games is a fake fetch; no CLI is spawned (the runner's own tests do that). Timers are held:
 * `fire()` runs what is due and waits for the pass it started.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { memoryKeyStore } from "../../src/substrate/provider-keys.ts";
import { GENEX_PLAYER_CREDENTIAL_SECRET } from "../../src/substrate/provider-keys.ts";
import type { RunRequest, RunResult } from "../../src/substrate/spawn.ts";
import {
  AiWatcherProblem,
  AiWatcherRunner,
  AiWatcherSignIn,
  AiWatcherState,
  readAiWatcherSwitch,
} from "../../src/shared/game-ai-watcher.ts";
import { readPlayerCredential } from "../../src/main/game-ai/player-sign-in.ts";
import { type PlanWatcherDeps, createPlanWatcher, readCliWatcherState } from "../../src/main/game-ai/player-watcher.ts";
import type { RunnerSandboxFactory } from "../../src/main/game-ai/player-runner.ts";

const API = "https://api.genex.games";
const WEB = "https://genex.games";
const START = Date.UTC(2026, 9, 20, 12, 0, 0);
const TOKEN = "player_token_0123456789abcdef";
/** The environment discovery found a CLI with: its own PATH, and a key the studio's shell exported. */
const CLI_ENV = { PATH: "/opt/cli-toolchain/bin", ANTHROPIC_API_KEY: "sk-ant-leak" };

const temps: string[] = [];
after(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

interface Seen {
  route: string;
  method: string;
  auth: string | null;
  body: unknown;
}

type Answer = { status: number; body: unknown };

/** A fake genex.games: each route answers from `routes`, a heartbeat and an empty queue by default. */
function fakeGenex(routes: Record<string, (body: unknown) => Answer> = {}) {
  const seen: Seen[] = [];
  const defaults: Record<string, (body: unknown) => Answer> = {
    "/api/cli/device/start": () => ({
      status: 200,
      body: {
        userCode: "ABCD-EFGH",
        deviceCode: "dev_1",
        verifyUrl: `${WEB}/device?code=ABCD-EFGH`,
        expiresIn: 600,
        interval: 5,
      },
    }),
    "/api/cli/device/poll": () => ({ status: 200, body: { status: "pending" } }),
    "/api/runtime/player/policy": () => ({
      status: 200,
      body: {
        version: "p1",
        minVersion: "0.1.0",
        latestVersion: "0.1.0",
        pollIntervalSeconds: 5,
        backoff: { initialSeconds: 5, maxSeconds: 300, factor: 2, jitterRatio: 0 },
      },
    }),
    "/api/runtime/player/watchers/heartbeat": () => ({
      status: 200,
      body: {
        watcherId: "watcher_1",
        minVersion: "0.1.0",
        latestVersion: "0.1.0",
        policyVersion: "p1",
        pollIntervalSeconds: 5,
      },
    }),
    "/api/runtime/external/generations": () => ({ status: 200, body: { generations: [] } }),
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    seen.push({ route: url.pathname, method: init?.method ?? "GET", auth: headers.get("authorization"), body });
    const answer = (routes[url.pathname] ?? defaults[url.pathname] ?? (() => ({ status: 404, body: null })))(body);
    return new Response(answer.body === null ? null : JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

/** Held timers: `fire()` runs every callback due now. */
function heldTimers() {
  let next = 1;
  const pending = new Map<number, () => void>();
  return {
    timers: {
      setTimeout: (fn: () => void) => {
        const id = next++;
        pending.set(id, fn);
        return id;
      },
      clearTimeout: (id: unknown) => {
        pending.delete(id as number);
      },
    },
    due: () => pending.size,
    run: () => {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const fn of callbacks) fn();
    },
  };
}

async function rig(over: Partial<PlanWatcherDeps> = {}, routes: Record<string, (body: unknown) => Answer> = {}) {
  const dir = await tmp("plan-watcher-service-");
  const genex = fakeGenex(routes);
  const held = heldTimers();
  const opened: string[] = [];
  const lines: string[] = [];
  let notified = 0;
  const credential = memoryKeyStore();
  const deps: PlanWatcherDeps = {
    api: API,
    web: WEB,
    version: "0.1.11",
    platform: "darwin",
    label: "Genex on Studio Mac",
    home: dir,
    env: { PATH: process.env.PATH },
    credential,
    stateFile: path.join(dir, "game-ai", "watcher.json"),
    tmpRoot: path.join(dir, "tmp"),
    canaryDir: path.join(dir, "canary"),
    sandbox: async () => assert.fail("no box is made: no CLI is found"),
    findCli: async () => null,
    codexSignedIn: async () => false,
    planUsage: async () => null,
    keepForBuildingPercent: async () => 50,
    cliWatcher: async () => false,
    openSignIn: async (url) => {
      opened.push(url);
    },
    notify: () => {
      notified += 1;
    },
    log: (line) => lines.push(line),
    clock: { now: () => START },
    timers: held.timers,
    fetch: genex.fetchImpl,
    random: () => 0.5,
    ...over,
  };
  const watcher = createPlanWatcher(deps);
  /** Run what is due and wait for the pass or the poll it started. */
  const fire = async () => {
    held.run();
    await watcher.idle();
  };
  return { watcher, deps, genex, held, opened, lines, credential, fire, notified: () => notified, dir };
}

/** A stored credential bound to `api`. */
const stored = (api = API, expiresAt = new Date(START + 86_400_000).toISOString()) =>
  JSON.stringify({ v: 1, api, token: TOKEN, expiresAt });

describe("the plan watcher's switch and view", () => {
  it("is off by default, signed out, and names nothing it answers with", async () => {
    const { watcher } = await rig();
    await watcher.start();
    const view = await watcher.view();
    assert.equal(view.enabled, false);
    assert.equal(view.state, AiWatcherState.Off);
    assert.equal(view.signIn, AiWatcherSignIn.SignedOut);
    assert.deepEqual(view.runners, []);
    assert.equal(view.problem, null);
  });

  it("keeps the switch and the watcher id across launches", async () => {
    const first = await rig({}, {});
    await first.credential.write(stored());
    await first.watcher.start();
    await first.watcher.setEnabled(true);
    await first.fire();
    await first.watcher.stop();
    const saved = JSON.parse(await readFile(first.deps.stateFile, "utf8")) as { enabled: boolean; watcherId: string };
    assert.deepEqual(saved, { v: 1, enabled: true, watcherId: "watcher_1" });
    const second = createPlanWatcher({ ...first.deps });
    await second.start();
    assert.equal((await second.view()).enabled, true);
    first.held.run();
    await second.idle();
    const beats = first.genex.seen.filter((call) => call.route.endsWith("/heartbeat"));
    assert.equal(
      (beats.at(-1)?.body as { watcherId?: string } | undefined)?.watcherId,
      "watcher_1",
      "the second launch reuses its id",
    );
    await second.stop();
  });

  it("a switch file that is not one it wrote reads as off", async () => {
    for (const junk of [
      "{",
      "[]",
      '{"v":1,"enabled":"yes"}',
      '{"v":2,"enabled":true}',
      '{"v":1,"enabled":true,"watcherId":"../x"}',
    ]) {
      const { watcher, deps } = await rig();
      await import("node:fs/promises").then((fs) => fs.mkdir(path.dirname(deps.stateFile), { recursive: true }));
      await writeFile(deps.stateFile, junk);
      await watcher.start();
      assert.equal((await watcher.view()).enabled, junk.includes('"watcherId":"../x"'), junk);
      await watcher.stop();
    }
  });
});

describe("the Genex player sign-in", () => {
  it("asks genex.games for a player credential and opens its page in the browser", async () => {
    const { watcher, genex, opened } = await rig();
    await watcher.start();
    const view = await watcher.signIn();
    assert.equal(view.signIn, AiWatcherSignIn.SigningIn);
    assert.equal(view.code, "ABCD-EFGH");
    assert.deepEqual(genex.seen[0]?.body, { label: "Genex on Studio Mac", scope: "player" });
    assert.equal(genex.seen[0]?.auth, null, "a sign-in carries no credential");
    assert.equal(opened.length, 1);
    assert.match(opened[0] ?? "", /^https:\/\/genex\.games\/device\?code=ABCD-EFGH/);
  });

  it("stores an approved player credential bound to its API, and never shows it", async () => {
    const { watcher, credential, fire } = await rig(
      {},
      { "/api/cli/device/poll": () => ({ status: 200, body: { status: "approved", scope: "player", token: TOKEN } }) },
    );
    await watcher.start();
    await watcher.signIn();
    await fire();
    const view = await watcher.view();
    assert.equal(view.signIn, AiWatcherSignIn.SignedIn);
    assert.equal(view.code, null);
    assert.equal(JSON.stringify(view).includes(TOKEN), false);
    const kept = readPlayerCredential(await credential.read(), API, START);
    assert.equal(kept?.token, TOKEN);
    assert.equal(kept?.api, API);
  });

  const refusedPolls: Array<[string, Answer]> = [
    ["a full account credential", { status: 200, body: { status: "approved", scope: "cli", token: TOKEN } }],
    ["an approval naming no scope", { status: 200, body: { status: "approved", token: TOKEN } }],
    [
      "a token with a space",
      { status: 200, body: { status: "approved", scope: "player", token: "a b c d e f g h i j k l" } },
    ],
    ["a declined card", { status: 200, body: { status: "denied" } }],
    ["an expired code", { status: 410, body: null }],
  ];
  for (const [what, answer] of refusedPolls) {
    it(`stores nothing for ${what}`, async () => {
      const { watcher, credential, fire } = await rig({}, { "/api/cli/device/poll": () => answer });
      await watcher.start();
      await watcher.signIn();
      await fire();
      assert.equal(await credential.read(), null);
      assert.notEqual((await watcher.view()).signIn, AiWatcherSignIn.SignedIn);
    });
  }

  const refusedStarts: Array<[string, Answer]> = [
    [
      "a page off the website",
      {
        status: 200,
        body: { userCode: "C", deviceCode: "d", verifyUrl: "https://evil.example/device", expiresIn: 600, interval: 5 },
      },
    ],
    [
      "a plain-http page",
      {
        status: 200,
        body: { userCode: "C", deviceCode: "d", verifyUrl: "http://genex.games/device", expiresIn: 600, interval: 5 },
      },
    ],
    [
      "no device code",
      { status: 200, body: { userCode: "C", verifyUrl: `${WEB}/device`, expiresIn: 600, interval: 5 } },
    ],
    ["a server without the player sign-in", { status: 404, body: null }],
  ];
  for (const [what, answer] of refusedStarts) {
    it(`opens nothing for ${what}`, async () => {
      const { watcher, opened } = await rig({}, { "/api/cli/device/start": () => answer });
      await watcher.start();
      await assert.rejects(watcher.signIn());
      assert.deepEqual(opened, []);
      assert.equal((await watcher.view()).signIn, AiWatcherSignIn.SignedOut);
    });
  }

  it("cancelling stops the polls; signing out forgets the credential", async () => {
    const { watcher, credential, held } = await rig();
    await watcher.start();
    await watcher.signIn();
    assert.equal((await watcher.cancelSignIn()).signIn, AiWatcherSignIn.SignedOut);
    assert.equal(held.due(), 0, "no poll is left waiting");
    await credential.write(stored());
    await watcher.stop();
    await watcher.start();
    assert.equal((await watcher.view()).signIn, AiWatcherSignIn.SignedIn);
    assert.equal((await watcher.signOut()).signIn, AiWatcherSignIn.SignedOut);
    assert.equal(await credential.read(), null);
  });

  it("a secret store that will not keep the credential ends the sign-in, and nothing is left unhandled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const locked = {
        ...memoryKeyStore(),
        write: async () => {
          throw new Error("secret storage is locked");
        },
      };
      const { watcher, fire, lines } = await rig(
        { credential: locked },
        {
          "/api/cli/device/poll": () => ({ status: 200, body: { status: "approved", scope: "player", token: TOKEN } }),
        },
      );
      await watcher.start();
      await watcher.signIn();
      await fire();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal((await watcher.view()).signIn, AiWatcherSignIn.SignedOut);
      assert.ok(
        lines.some((line) => /could not be kept/.test(line)),
        lines.join(" | "),
      );
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a Settings notice that throws stops nothing", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { watcher, credential, fire, held } = await rig({
        notify: () => {
          throw new Error("no window");
        },
      });
      await credential.write(stored());
      await watcher.start();
      await watcher.setEnabled(true).catch(() => {});
      watcher.building(true);
      await fire();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
      assert.equal(held.due(), 1, "the next pass is still scheduled");
      await watcher.stop();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a credential from another genex.games, or one that expired, reads as signed out", () => {
    assert.equal(readPlayerCredential(stored("https://api.dev.genex.games"), API, START), null);
    assert.equal(readPlayerCredential(stored(API, new Date(START - 1).toISOString()), API, START), null);
    for (const junk of [null, "", "{", '{"v":1}', JSON.stringify({ v: 1, api: API, token: 5, expiresAt: "x" })])
      assert.equal(readPlayerCredential(junk, API, START), null, String(junk));
  });

  it("the secret is kept under its stored name", () => {
    assert.equal(GENEX_PLAYER_CREDENTIAL_SECRET, "genex-player-credential");
  });
});

describe("the passes it drives", () => {
  it("answers only while on and signed in, and says no CLI here can answer", async () => {
    const { watcher, credential, genex, fire } = await rig();
    await credential.write(stored());
    await watcher.start();
    await fire();
    assert.equal(genex.seen.length, 0, "off: genex.games hears nothing");
    await watcher.setEnabled(true);
    await fire();
    const beat = genex.seen.find((call) => call.route.endsWith("/heartbeat"));
    assert.equal(beat?.auth, `Bearer ${TOKEN}`);
    assert.deepEqual((beat?.body as { runners: string[] } | undefined)?.runners, []);
    const view = await watcher.view();
    assert.equal(view.state, AiWatcherState.Online);
    assert.equal(view.problem, AiWatcherProblem.NoRunner);
    await watcher.stop();
  });

  it("yields while a build runs: presence only, nothing listed", async () => {
    const { watcher, credential, genex, fire } = await rig({
      findCli: async (runner) => (runner === AiWatcherRunner.Claude ? { binary: "/opt/claude", env: CLI_ENV } : null),
      sandbox: passingProbe(),
    });
    await credential.write(stored());
    await watcher.start();
    watcher.building(true);
    await watcher.setEnabled(true);
    await fire();
    assert.equal((await watcher.view()).state, AiWatcherState.Yielding);
    assert.equal(watcher.state().state, AiWatcherState.Yielding);
    assert.equal(genex.seen.filter((call) => call.route === "/api/runtime/external/generations").length, 0);
    watcher.building(false);
    await watcher.idle();
    assert.equal(
      genex.seen.filter((call) => call.route === "/api/runtime/external/generations").length,
      1,
      "a build ending lists the queue at once",
    );
    await watcher.stop();
  });

  it("a credential genex.games refuses ends the sign-in and is forgotten", async () => {
    const { watcher, credential, fire } = await rig(
      {},
      { "/api/runtime/player/watchers/heartbeat": () => ({ status: 401, body: null }) },
    );
    await credential.write(stored());
    await watcher.start();
    await watcher.setEnabled(true);
    await fire();
    const view = await watcher.view();
    assert.equal(view.signIn, AiWatcherSignIn.Ended);
    assert.equal(view.state, AiWatcherState.SignedOut);
    assert.equal(await credential.read(), null);
  });

  it("a version floor stops it and asks for an update", async () => {
    const { watcher, credential, genex, fire, held } = await rig(
      {},
      { "/api/runtime/player/policy": () => ({ status: 426, body: { minVersion: "0.2.0", latestVersion: "0.2.1" } }) },
    );
    await credential.write(stored());
    await watcher.start();
    await watcher.setEnabled(true);
    await fire();
    assert.equal((await watcher.view()).problem, AiWatcherProblem.UpdateRequired);
    assert.equal(held.due(), 0, "no next pass is scheduled");
    assert.equal(genex.seen.filter((call) => call.route.endsWith("/heartbeat")).length, 0);
  });

  it("genex.games not answering is a problem it keeps trying through", async () => {
    const { watcher, credential, fire, held } = await rig({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await credential.write(stored());
    await watcher.start();
    await watcher.setEnabled(true);
    await fire();
    assert.equal((await watcher.view()).problem, AiWatcherProblem.Unreachable);
    assert.equal(held.due(), 1, "the next pass is scheduled");
    await watcher.stop();
  });

  it("a nudge runs the next pass now; stop leaves nothing scheduled", async () => {
    const { watcher, credential, genex, fire, held } = await rig({
      findCli: async (runner) => (runner === AiWatcherRunner.Claude ? { binary: "/opt/claude", env: CLI_ENV } : null),
      sandbox: passingProbe(),
    });
    await credential.write(stored());
    await watcher.start();
    await watcher.setEnabled(true);
    await fire();
    const before = genex.seen.length;
    watcher.nudge();
    await watcher.idle();
    assert.ok(genex.seen.length > before, "the nudge polled at once");
    await watcher.stop();
    assert.equal(held.due(), 0);
    await fire();
    assert.equal(watcher.state().state, AiWatcherState.Off, "a stopped watcher answers nothing");
    assert.equal((await watcher.view()).enabled, true, "stopping keeps the person's switch");
  });

  it("turning it off forgets nothing and polls nothing more", async () => {
    const { watcher, credential, genex, fire } = await rig();
    await credential.write(stored());
    await watcher.start();
    await watcher.setEnabled(true);
    await fire();
    const view = await watcher.setEnabled(false);
    assert.equal(view.state, AiWatcherState.Off);
    const before = genex.seen.length;
    await fire();
    assert.equal(genex.seen.length, before);
    assert.equal(await credential.read(), stored());
  });
});

/** A box whose canary read is refused and whose CLI says it is signed in. */
function passingProbe(): RunnerSandboxFactory {
  return async () => ({
    run: async (request: RunRequest): Promise<RunResult> => ({
      code: request.command.includes("auth") || request.command.includes("login") ? 0 : 1,
      signal: null,
      stdout: request.command.includes("auth")
        ? '{"loggedIn":true}'
        : request.command.includes("login")
          ? "Logged in using ChatGPT"
          : "",
      stderr: "",
      durationMs: 1,
      timedOut: false,
      truncated: false,
      sandboxed: true,
      command: request.command,
      cwd: request.cwd,
    }),
    dispose: async () => {},
  });
}

describe("what it answers with", () => {
  it("advertises Claude Code once its probe passes, and holds Codex when its read-deny check fails", async () => {
    // Codex's box is the one with no home of its own opened: there the canary reads.
    const boxEnvs: Array<Record<string, string>> = [];
    const factory: RunnerSandboxFactory = async (box) => ({
      run: async (request) => {
        boxEnvs.push(request.env ?? {});
        const auth = request.command.includes("auth");
        const codexBox = box.ownHome.length === 0;
        return {
          code: auth || codexBox ? 0 : 1,
          signal: null,
          stdout: auth ? '{"loggedIn":true}' : "",
          stderr: "",
          durationMs: 1,
          timedOut: false,
          truncated: false,
          sandboxed: true,
          command: request.command,
          cwd: request.cwd,
        };
      },
      dispose: async () => {},
    });
    const { watcher, credential, genex, fire } = await rig({
      findCli: async (runner) => ({
        binary: runner === AiWatcherRunner.Claude ? "/opt/claude" : "/opt/codex",
        env: CLI_ENV,
      }),
      codexSignedIn: async () => true,
      sandbox: factory,
    });
    await credential.write(stored());
    await watcher.start();
    await watcher.setEnabled(true);
    await fire();
    const view = await watcher.view();
    assert.deepEqual(view.runners, [AiWatcherRunner.Claude]);
    assert.equal(view.codexHeld, true);
    assert.ok(boxEnvs.length > 0);
    for (const env of boxEnvs) {
      assert.equal(env.PATH, CLI_ENV.PATH, "each CLI runs with the PATH it was found with");
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
    }
    const beat = genex.seen.find((call) => call.route.endsWith("/heartbeat"));
    assert.deepEqual((beat?.body as { runners: string[] } | undefined)?.runners, ["claude"]);
    await watcher.stop();
  });
});

describe("genex player on the same Mac", () => {
  async function stateFile(content: string | null): Promise<string> {
    const home = await tmp("plan-watcher-cli-");
    if (content !== null) {
      await import("node:fs/promises").then((fs) => fs.mkdir(path.join(home, ".genex"), { recursive: true }));
      await writeFile(path.join(home, ".genex", "player-state.json"), content);
    }
    return home;
  }
  const fresh = new Date(START - 30_000).toISOString();

  it("reads as answering when its state names a live process that beat recently", async () => {
    const home = await stateFile(JSON.stringify({ v: 1, pid: process.pid, lastHeartbeatAt: fresh }));
    assert.equal(await readCliWatcherState(home, START), true);
  });

  const notAnswering: Array<[string, string | null]> = [
    ["no state file", null],
    ["junk", "{"],
    ["an array", "[]"],
    [
      "a stale heartbeat",
      JSON.stringify({ v: 1, pid: process.pid, lastHeartbeatAt: new Date(START - 10 * 60_000).toISOString() }),
    ],
    ["no heartbeat yet", JSON.stringify({ v: 1, pid: process.pid, lastHeartbeatAt: null })],
    ["a pid that is no number", JSON.stringify({ v: 1, pid: "1", lastHeartbeatAt: fresh })],
    ["a negative pid (a process group)", JSON.stringify({ v: 1, pid: -1, lastHeartbeatAt: fresh })],
    ["an unknown shape version", JSON.stringify({ v: 2, pid: process.pid, lastHeartbeatAt: fresh })],
    [
      "a file past its bound",
      JSON.stringify({ v: 1, pid: process.pid, lastHeartbeatAt: fresh, pad: "x".repeat(200_000) }),
    ],
  ];
  for (const [what, content] of notAnswering) {
    it(`reads as not answering with ${what}`, async () => {
      assert.equal(await readCliWatcherState(await stateFile(content), START), false);
    });
  }

  it("a state file that is a link is not followed", async () => {
    const home = await stateFile(null);
    const target = path.join(await tmp("plan-watcher-link-"), "state.json");
    await writeFile(target, JSON.stringify({ v: 1, pid: process.pid, lastHeartbeatAt: fresh }));
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(home, ".genex"), { recursive: true });
    await fs.symlink(target, path.join(home, ".genex", "player-state.json"));
    assert.equal(await readCliWatcherState(home, START), false);
  });
});

describe("the switch payload from the renderer", () => {
  const bad: unknown[] = [
    null,
    undefined,
    true,
    "on",
    [],
    {},
    { enabled: "true" },
    { enabled: 1 },
    { enabled: true, extra: 1 },
  ];
  for (const payload of bad)
    it(`refuses ${JSON.stringify(payload)}`, () => assert.equal(readAiWatcherSwitch(payload), null));
  it("reads on and off", () => {
    assert.equal(readAiWatcherSwitch({ enabled: true }), true);
    assert.equal(readAiWatcherSwitch({ enabled: false }), false);
  });
});
