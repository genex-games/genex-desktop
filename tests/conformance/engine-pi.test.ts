/**
 * Pi: a delegated harness the studio runs inside its own sandbox.
 *
 * Sessions replay a recorded JSON-mode stream (`fixtures/transcripts/pi-*`) through the engine's
 * `execFn` seam, so the translation, the command line, the sandbox and every ending are exercised
 * without the CLI, a provider or the network.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  PiEngine,
  type PiEngineOptions,
  type PiExec,
  type PiInvocation,
  piSandbox,
  stderrFailure,
} from "../../src/substrate/engines/pi.ts";
import { credentialHomes, piAgentDir, sandboxedCliHomes } from "../../src/substrate/credential-homes.ts";
import { hostsFromPiModelsJson, parsePiModels } from "../../src/substrate/engines/pi-cli.ts";
import { translatePiEvent } from "../../src/substrate/engines/pi-events.ts";
import { closePiView, openPiView } from "../../src/substrate/engines/pi-agent-view.ts";
import {
  type PiSignInRenewal,
  piModelProvider,
  piRenewalArgs,
  piRenewsSignIn,
  piSignInRenewals,
  renewPiSignIn,
} from "../../src/substrate/engines/pi-sign-in.ts";
import { SandboxUnavailableError } from "../../src/substrate/sandbox-unavailable.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { EngineError, type DelegateEvent } from "../../src/substrate/engines/types.ts";
import { HOUR_MS } from "../../src/shared/duration.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { gitFile } from "../helpers/git.ts";
import { readFile } from "node:fs/promises";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures", "transcripts");
/** A one-pixel PNG. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const fixture = (name: string) => readFile(path.join(FIXTURES, name), "utf8");
const events = async (name: string) =>
  (await fixture(name))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const ready = async () => ({ ready: true, path: "/usr/local/bin/pi", version: "0.1.0", detail: "ok" });

async function engineWith(
  stream: (invocation: PiInvocation) => AsyncIterable<Record<string, unknown>>,
  where: Pick<PiEngineOptions, "env" | "home" | "platform" | "clock" | "renewSignIn" | "resolveCli"> = {},
) {
  const root = await realpath(await tmpDir("pi-engine-"));
  // A home of the test's own: a resumed session is looked up in Pi's folder there, never this machine's.
  const home = where.home ?? path.join(root, "home");
  const seen: PiInvocation[] = [];
  const execFn: PiExec = (invocation) => {
    seen.push(invocation);
    return stream(invocation);
  };
  const engine = new PiEngine({
    scratchRoot: path.join(root, "scratch"),
    protectedPaths: [path.join(root, "secrets"), path.join(root, "engine-homes")],
    execFn,
    resolveCli: ready,
    listModels: () => fixture("pi-models.txt"),
    // Never this machine's own: a developer's `PI_CODING_AGENT_DIR` would point the tests at their Pi folder.
    env: {},
    ...where,
    home,
  });
  return { engine, seen, root, home };
}

async function* replay(list: Array<Record<string, unknown>>): AsyncGenerator<Record<string, unknown>> {
  for (const event of list) yield event;
}

const COMMITTER = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

async function git(dir: string, ...args: string[]): Promise<void> {
  await gitFile(["-C", dir, ...args], { env: { ...process.env, ...COMMITTER } });
}

/** A session file as Pi 1.5.2 keeps it: in the folder named after where it was started, its header first. */
async function keptSession(home: string, cwd: string, id: string, header: object = {}): Promise<string> {
  const folder = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const dir = path.join(home, ".pi", "agent", "sessions", folder);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  const first = { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd, ...header };
  await writeFile(file, `${JSON.stringify(first)}\n{"type":"message","id":"m1"}\n`);
  return file;
}

async function game(): Promise<string> {
  const dir = await tmpDir("pi-game-");
  await writeFile(path.join(dir, "main.js"), "export const x = 1;\n");
  return dir;
}

describe("Pi's model list", () => {
  it("reads `pi --list-models`: provider/model, limits, thinking and vision", async () => {
    const listed = parsePiModels(await fixture("pi-models.txt"));
    assert.deepEqual(
      listed.map((model) => model.row.id),
      ["anthropic/claude-sonnet-4", "openai/gpt-4.1", "github-copilot/gpt-4o", "acme/custom-bot"],
    );
    const [sonnet, gpt] = listed;
    assert.equal(sonnet?.row.label, "claude-sonnet-4");
    assert.equal(sonnet?.row.contextWindow, 200_000);
    assert.equal(sonnet?.row.maxTokens, 16_400);
    assert.equal(sonnet?.row.supportsThinking, true);
    assert.equal(sonnet?.row.supportsVision, true);
    assert.deepEqual(sonnet?.hosts, ["api.anthropic.com"]);
    assert.equal(gpt?.row.supportsThinking, false);
    assert.deepEqual(gpt?.hosts, ["api.openai.com", "chatgpt.com", "auth.openai.com"]);
    assert.ok(listed[2]?.hosts.includes("api.github.com"), "Copilot reaches GitHub");
    assert.deepEqual(listed[3]?.hosts, [], "an unknown provider gets no wildcard hosts");
    const withStore = parsePiModels(await fixture("pi-models.txt"), {
      acme: ["api.acme.test"],
    });
    assert.deepEqual(withStore[3]?.hosts, ["api.acme.test"], "a custom provider reaches only its models.json host");
    assert.ok(!withStore[3]?.hosts.includes("*.amazonaws.com"));
  });

  it("takes an unknown provider's hosts only from models.json https baseUrl", () => {
    const hosts = hostsFromPiModelsJson(
      JSON.stringify({
        acme: { models: [{ baseUrl: "https://api.acme.test/v1?key=secret" }] },
        openai: { models: [{ baseUrl: "https://api.openai.com/v1" }] },
        local: { models: [{ baseUrl: "http://127.0.0.1:1234" }, { apiKey: "!echo stolen" }] },
      }),
    );
    assert.deepEqual(hosts.acme, ["api.acme.test"]);
    assert.deepEqual(hosts.openai, ["api.openai.com"]);
    assert.equal(hosts.local, undefined);
  });

  it("reads models.json as Pi writes it, providers under `providers`", () => {
    const hosts = hostsFromPiModelsJson(
      JSON.stringify({
        $schema: "https://pi.dev/schemas/models.schema.json",
        providers: {
          acme: { baseUrl: "https://llm.acme.test/v1", api: "openai-completions", apiKey: "!op read acme" },
          local: { baseUrl: "http://localhost:11434/v1", models: [{ id: "qwen" }] },
        },
      }),
    );
    assert.deepEqual(hosts, { acme: ["llm.acme.test"] }, "a custom provider reaches its own baseUrl, nothing else");
    const [custom] = parsePiModels(
      "provider  model  context  max-out  thinking  images\nacme  bot  32K  8K  no  no\n",
      hosts,
    );
    assert.deepEqual(custom?.hosts, ["llm.acme.test"]);
  });

  it("gives Copilot and ChatGPT sign-in the hosts Pi's catalog sends them to", () => {
    const listing = [
      "provider  model  context  max-out  thinking  images",
      "github-copilot  gpt-5  128K  16K  yes  yes",
      "openai-codex  gpt-5.1-codex  272K  128K  yes  yes",
      "deepseek  deepseek-chat  128K  8K  no  no",
    ].join("\n");
    const [copilot, codex, deepseek] = parsePiModels(listing);
    assert.ok(copilot?.hosts.includes("*.githubcopilot.com"), "the Copilot API, not only api.github.com");
    assert.ok(copilot?.hosts.includes("api.github.com"), "where its token is exchanged");
    assert.deepEqual(codex?.hosts, ["chatgpt.com", "auth.openai.com"]);
    assert.deepEqual(deepseek?.hosts, ["api.deepseek.com"]);
  });

  it("skips the header and refuses a listing that is not one", () => {
    assert.deepEqual(parsePiModels(""), []);
    assert.deepEqual(parsePiModels("provider     model                      context  max-out  thinking  images\n"), []);
    assert.throws(() => parsePiModels("Error: something broke\n"), /could not be read/);
  });
});

describe("Pi's status", () => {
  it("says what to do at each step: install, fix the install, sign in, or go", async () => {
    const root = await tmpDir("pi-status-");
    const status = (resolveCli: () => Promise<{ ready: boolean; path?: string; detail: string }>, listing = "") =>
      new PiEngine({ scratchRoot: root, resolveCli, listModels: async () => listing }).status();
    const missing = await status(async () => ({ ready: false, detail: "missing" }));
    assert.equal(missing.code, "not_installed");
    assert.match(missing.remedy ?? "", /Install Pi/);
    const broken = await status(async () => ({
      ready: false,
      path: "/x/pi",
      detail: "Required CLI options are unavailable",
    }));
    assert.equal(broken.code, "error");
    const signedOut = await status(ready);
    assert.equal(signedOut.code, "needs_login");
    assert.match(signedOut.remedy ?? "", /Sign in/);
    const go = await status(ready, await fixture("pi-models.txt"));
    assert.equal(go.code, "ready");
  });
});

describe("Pi's account", () => {
  it("is Pi's own sign-in once it lists a model, and no one's before", async () => {
    const root = await tmpDir("pi-account-");
    const empty = await new PiEngine({
      scratchRoot: root,
      resolveCli: ready,
      listModels: async () => "provider     model                      context  max-out  thinking  images\n",
    }).account();
    assert.equal(empty.source, "none");
    const signedIn = await new PiEngine({
      scratchRoot: root,
      resolveCli: ready,
      listModels: () => fixture("pi-models.txt"),
    }).account();
    assert.equal(signedIn.source, "system");
    assert.deepEqual(signedIn.cli, { state: "ready", path: "/usr/local/bin/pi", version: "0.1.0" });
  });

  it("only a Pi that started and lacks what a session needs is too old; one that cannot start keeps its reason", async () => {
    const root = await tmpDir("pi-account-");
    const cli = async (state?: "missing_runtime" | "incompatible" | "invalid_path") =>
      (
        await new PiEngine({
          scratchRoot: root,
          resolveCli: async () => ({ ready: false, path: "/x/pi", detail: "no", ...(state ? { state } : {}) }),
        }).account()
      ).cli.state;
    assert.equal(await cli("incompatible"), "incompatible", "its help lacks an option: Update needed");
    assert.equal(await cli("missing_runtime"), "missing_runtime", "no Node to start it: not an old Pi");
    assert.equal(await cli("invalid_path"), "invalid_path");
    assert.equal(await cli(), "incompatible");
  });
});

describe("Pi's events", () => {
  it("mirrors JSON-mode text, tools, usage and the session id", async () => {
    const stream = await events("pi-run.jsonl");
    const seen: DelegateEvent[] = [];
    let sessionId: string | undefined;
    let text = "";
    let usage: { input_tokens?: number; output_tokens?: number; cost_usd?: number } = {};
    for (const event of stream) {
      const translated = translatePiEvent(event);
      if (translated.sessionId) sessionId = translated.sessionId;
      if (translated.text) text = translated.text;
      if (translated.usage) usage = { ...usage, ...translated.usage };
      seen.push(...(translated.events as DelegateEvent[]));
    }
    assert.equal(sessionId, "sess-pi-1");
    assert.equal(text, "Hello from Pi.");
    assert.equal(usage.input_tokens, 12);
    assert.equal(usage.output_tokens, 5);
    assert.equal(usage.cost_usd, 0.01);
    assert.ok(seen.some((event) => event.type === "assistant"));
    assert.ok(seen.some((event) => event.type === "user"));
  });
});

describe("Pi's sessions", () => {
  it("runs `pi --mode json` in the game folder, resumes by --session-id, and stops on abort", async () => {
    const cwd = await game();
    const { engine, seen } = await engineWith(() => replay([]));
    const result = await engine.delegate({
      cwd,
      prompt: "Build a hut",
      model: "anthropic/claude-sonnet-4",
      effort: "high",
      onEvent: () => {},
    });
    assert.equal(result.ok, true);
    const first = seen[0];
    assert.ok(first);
    assert.deepEqual(first.argv.slice(0, 2), ["--mode", "json"]);
    assert.ok(first.argv.includes("--no-extensions"));
    assert.ok(
      first.argv.includes("--no-approve"),
      "a game's own Pi files stay untrusted, so Pi never locks trust.json, which the sandbox cannot write",
    );
    assert.ok(!first.argv.includes("--offline"), "a session still needs the model host");
    assert.ok(first.argv.includes("--session-id"));
    assert.ok(first.argv.includes("--model"));
    assert.equal(first.argv[first.argv.indexOf("--model") + 1], "anthropic/claude-sonnet-4");
    assert.equal(first.argv[first.argv.indexOf("--thinking") + 1], "high");
    assert.equal(first.cwd, await realpath(cwd));
    assert.match(first.prompt, /Build a hut/);
    assert.ok(first.sandbox.readableHome?.some((home) => home.includes(".pi")));

    const resumed = await engine.delegate({
      cwd,
      prompt: "Again",
      resume: "sess-pi-1",
      onEvent: () => {},
    });
    assert.equal(resumed.sessionId, "sess-pi-1");
    assert.equal(seen[1]?.argv[seen[1].argv.indexOf("--session-id") + 1], "sess-pi-1");

    const controller = new AbortController();
    controller.abort();
    const stopped = await engine.delegate({
      cwd,
      prompt: "Stop me",
      signal: controller.signal,
      onEvent: () => {},
    });
    assert.equal(stopped.ok, false);
    assert.match(stopped.errorText ?? "", /stopped/i);
  });

  it("a Plan turn after a build forks the chat's session into its own folder, and the next one stays there", async () => {
    const cwd = await realpath(await game());
    const stream = await events("pi-stream.jsonl");
    const { engine, seen, root, home } = await engineWith(() => replay(stream));
    const built = await keptSession(home, cwd, "sess-built");
    // Pi's `--session-id` looks only in the folder it runs from: the build's session is not there.
    const plan = await engine.delegate({
      cwd,
      prompt: "Plan",
      resume: "sess-built",
      readOnly: true,
      onEvent: () => {},
    });
    const first = seen[0];
    assert.ok(first);
    assert.equal(first.argv[first.argv.indexOf("--fork") + 1], built, "the history goes with it");
    assert.ok(!first.argv.includes("--session-id"), "an id made in another folder would start an empty session");
    assert.notEqual(first.cwd, cwd, "a read-only turn still runs from a folder of its own");
    assert.equal(plan.sessionId, "sess-pi-stream", "the fork's own id, which Pi names first, is the one to continue");
    // Pi files the fork under the folder that turn ran from, which is gone when the turn ends.
    await keptSession(home, first.cwd, "sess-pi-stream");
    assert.equal(existsSync(first.cwd), false);
    await engine.delegate({ cwd, prompt: "And then?", resume: "sess-pi-stream", readOnly: true, onEvent: () => {} });
    const second = seen[1];
    assert.equal(second?.cwd, first.cwd, "the same folder again, so Pi continues the session where it is");
    assert.equal(second?.argv[second.argv.indexOf("--session-id") + 1], "sess-pi-stream");
    assert.ok(!second?.argv.includes("--fork"), "no second copy of the history");
    assert.ok(first.cwd.startsWith(path.join(root, "scratch")));
    // The plan is approved: the build runs in the game, where that session is not.
    await engine.delegate({ cwd, prompt: "Do it", resume: "sess-pi-stream", onEvent: () => {} });
    const third = seen[2];
    assert.equal(third?.cwd, cwd);
    assert.match(third?.argv[(third?.argv.indexOf("--fork") ?? 0) + 1] ?? "", /_sess-pi-stream\.jsonl$/);
  });

  it("a session file is believed only by its own header, and never chooses a folder outside the engine's scratch", async () => {
    const cwd = await realpath(await game());
    const { engine, seen, root, home } = await engineWith(() => replay([]));
    const precious = path.join(root, "precious");
    await mkdir(precious, { recursive: true });
    await writeFile(path.join(precious, "keep.txt"), "keep");
    // Sessions are files a sandboxed turn can write: each of these names a folder the engine must not adopt.
    await keptSession(home, precious, "sess-outside");
    await keptSession(home, path.join(root, "scratch", "answer-x"), "sess-not-a-run");
    await keptSession(home, path.join(root, "scratch", "run-x", "deeper"), "sess-deeper");
    await keptSession(home, "relative/run-x", "sess-relative");
    await keptSession(home, path.join(root, "scratch", "run-liar"), "sess-named", { id: "sess-other" });
    for (const id of ["sess-outside", "sess-not-a-run", "sess-deeper", "sess-relative", "sess-named"]) {
      await engine.delegate({ cwd, prompt: "Look", resume: id, readOnly: true, onEvent: () => {} });
      const turn = seen.at(-1);
      assert.match(path.basename(turn?.cwd ?? ""), /^run-/, `${id}: a run folder`);
      assert.equal(path.dirname(turn?.cwd ?? ""), path.join(root, "scratch"), `${id}: of the engine's own`);
      assert.notEqual(path.basename(turn?.cwd ?? ""), "run-liar", `${id}: not one a mismatched header names`);
    }
    assert.equal(await readFile(path.join(precious, "keep.txt"), "utf8"), "keep", "nothing outside was removed");
    for (const hostile of ["../sess-outside", "a/b", "*", "", ".", "sess outside"]) {
      await engine.delegate({ cwd, prompt: "Build", resume: hostile || undefined, onEvent: () => {} });
      assert.ok(!seen.at(-1)?.argv.includes("--fork"), `${JSON.stringify(hostile)} is never looked up as a file`);
    }
  });

  it("continues from the newest file of a session", async () => {
    const cwd = await realpath(await game());
    const { engine, seen, root, home } = await engineWith(() => replay([]));
    const earlier = await keptSession(home, path.join(root, "scratch", "run-earlier"), "sess-twice");
    // Pi names a file by when the session was written, and the engine takes the newest name.
    const later = path.join(path.dirname(earlier), "2026-02-01T00-00-00-000Z_sess-twice.jsonl");
    const header = { type: "session", version: 3, id: "sess-twice", cwd: path.join(root, "scratch", "run-later") };
    await writeFile(later, `${JSON.stringify(header)}\n`);
    await engine.delegate({ cwd, prompt: "Build", resume: "sess-twice", onEvent: () => {} });
    assert.equal(seen[0]?.argv[(seen[0]?.argv.indexOf("--fork") ?? 0) + 1], later);
  });

  it("opens only a regular file under a session's name", {
    skip: process.platform === "win32" && "a pipe and a link under a session's name are made with POSIX tools",
    timeout: 20_000,
  }, async () => {
    const cwd = await realpath(await game());
    const { engine, seen, root, home } = await engineWith(() => replay([]));
    // Sessions are files a sandboxed turn can write: a pipe would hold an open forever, and a link
    // names a file somewhere else.
    const dir = path.dirname(await keptSession(home, path.join(root, "scratch", "run-real"), "sess-real"));
    const header = { type: "session", version: 3, id: "sess-link", cwd: path.join(root, "scratch", "run-link") };
    const elsewhere = path.join(root, "elsewhere.jsonl");
    await writeFile(elsewhere, `${JSON.stringify(header)}\n`);
    await symlink(elsewhere, path.join(dir, "2026-01-01T00-00-00-000Z_sess-link.jsonl"));
    execFileSync("mkfifo", [path.join(dir, "2026-01-01T00-00-00-000Z_sess-pipe.jsonl")]);
    for (const id of ["sess-link", "sess-pipe"]) {
      await engine.delegate({ cwd, prompt: "Build", resume: id, onEvent: () => {} });
      assert.ok(!seen.at(-1)?.argv.includes("--fork"), `${id}: not a session file, so nothing is forked from it`);
    }
  });

  it("a read-only turn never takes a run folder another turn is using", async () => {
    const cwd = await realpath(await game());
    const { engine, seen, root, home } = await engineWith(() => replay([]));
    const busy = path.join(root, "scratch", "run-busy");
    await keptSession(home, busy, "sess-busy");
    // A turn removes its folder when it ends: one that is there belongs to a turn still running.
    await mkdir(busy, { recursive: true });
    await writeFile(path.join(busy, "notes.md"), "another turn's");
    await engine.delegate({ cwd, prompt: "Look", resume: "sess-busy", readOnly: true, onEvent: () => {} });
    const turn = seen.at(-1);
    assert.notEqual(turn?.cwd, busy, "a folder of its own");
    assert.match(path.basename(turn?.cwd ?? ""), /^run-/);
    assert.ok(turn?.argv.includes("--fork"), "so the session is forked into it");
    assert.equal(await readFile(path.join(busy, "notes.md"), "utf8"), "another turn's", "and the other's is kept");
  });

  it("replays a recorded stream into a completed build", async () => {
    const cwd = await game();
    const stream = await events("pi-run.jsonl");
    const { engine } = await engineWith(() => replay(stream));
    const result = await engine.delegate({ cwd, prompt: "Hi", onEvent: () => {} });
    assert.equal(result.ok, true);
    assert.equal(result.summary, "Hello from Pi.");
    assert.equal(result.sessionId, "sess-pi-1");
    assert.equal(result.usage.input_tokens, 12);
  });

  it("throws when compact is asked of Pi", async () => {
    const cwd = await game();
    const { engine } = await engineWith(() => replay([]));
    await assert.rejects(
      () => engine.delegate({ cwd, prompt: "x", compact: true, onEvent: () => {} }),
      (err: unknown) => err instanceof EngineError && err.message.includes("compacts"),
    );
  });
});

/** What Pi loads or runs from its folder, there or not: never a session's to write. */
const PI_LOADS = [
  "settings.json",
  "trust.json",
  "models.json",
  "models-store.json",
  "mcp.json",
  "keybindings.json",
  "AGENTS.md",
  "AGENTS.override.md",
  "CLAUDE.md",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
  "extensions",
  "skills",
  "prompts",
  "themes",
  "npm",
  "git",
  "bin",
  "tools",
];
/** Whether a grant on one of `roots` reaches `file`. */
const reaches = (roots: readonly string[], file: string): boolean =>
  roots.some((root) => file === root || file.startsWith(`${root}${path.sep}`));

/** The game a policy is asked about, spelled as this system spells a path. */
const GAME = path.join(path.sep, "game");
/** Systems whose sessions run on the folder that stands for Pi's. */
const VIEW_PLATFORMS = ["darwin", "linux"] as const;
const NO_LINKS = process.platform === "win32" && "the folder is made of links, which Windows keeps for administrators";

describe("Pi's sandbox", () => {
  it("on macOS and Linux a session writes the game, the folder that stands for Pi's and its transcripts, never Pi's folder", () => {
    const home = path.join(path.sep, "home", "dev");
    const agent = path.join(home, ".pi", "agent");
    const view = path.join(agent, "genex", "agent-1-session");
    for (const platform of VIEW_PLATFORMS) {
      const sandbox = piSandbox({
        runDir: GAME,
        gameDir: GAME,
        gitDirs: [],
        scratchDir: "/tmp/scratch",
        secretPaths: ["/secrets"],
        home,
        env: {},
        platform,
        agentView: view,
        exists: () => true,
      });
      const writes = (file: string) => reaches(sandbox.writableRoots, file);
      assert.ok(writes(path.join(GAME, "main.js")));
      assert.ok(writes(path.join(agent, "sessions", "--game--", "1.jsonl")), "a session keeps its transcripts");
      assert.ok(writes(path.join(view, "auth.json.lock")), "Pi makes a lock folder even to read its sign-in");
      assert.ok(writes(path.join(view, "auth.json")), "and saves a renewed sign-in into the session's own copy");
      assert.ok(!sandbox.writableRoots.includes(agent), `${platform}: never Pi's folder whole`);
      for (const leaf of ["auth.json", "auth.json.lock", ...PI_LOADS])
        assert.ok(
          !writes(path.join(agent, leaf)),
          `${platform}: nothing in the person's folder is a session's: ${leaf}`,
        );
      assert.ok(!writes(path.join(agent, "genex", "work", "out")), "nor what Genex is taking out");
      assert.ok(!writes(path.join(agent, "genex", "agent-1-other", "auth.json")), "nor another session's folder");
      assert.equal(sandbox.ownHome, undefined, "`~/.pi` is not a write grant: a session must not rewrite it");
      assert.deepEqual(sandbox.readableHome, [path.join(home, ".pi")], "the CLI still reads its sign-ins");
      assert.ok(sandbox.secretPaths.includes("/secrets"));
      assert.deepEqual(sandbox.denyWrite, [path.join(GAME, ".pi")], "a game's own .pi is not the session's to plant");
    }
  });

  it("the session's folder and the transcripts are granted by Pi's real folder when it is reached through a link", () => {
    const real = path.join(path.sep, "real", "agent");
    const sandbox = piSandbox({
      runDir: GAME,
      gameDir: GAME,
      gitDirs: [],
      scratchDir: "/tmp/scratch",
      secretPaths: [],
      home: path.join(path.sep, "home", "dev"),
      env: {},
      platform: "darwin",
      agentDir: real,
      agentView: path.join(real, "genex", "agent-1-session"),
    });
    assert.ok(sandbox.writableRoots.includes(path.join(real, "genex", "agent-1-session")));
    assert.ok(sandbox.writableRoots.includes(path.join(real, "sessions")));
  });

  it("a game's missing .pi is denied on macOS and left alone on Linux, where a deny would put a stand-in file in the game", () => {
    const gamePi = path.join(GAME, ".pi");
    const denies = (platform: NodeJS.Platform, there: string[]) =>
      piSandbox({
        runDir: GAME,
        gameDir: GAME,
        gitDirs: [],
        scratchDir: "/tmp/scratch",
        secretPaths: [],
        env: {},
        home: path.join(path.sep, "home", "dev"),
        platform,
        exists: (file) => there.includes(file),
      }).denyWrite;
    assert.deepEqual(denies("linux", []), [], "the build's `git add -A` refuses a .pi that is no regular file");
    assert.deepEqual(denies("linux", [gamePi]), [gamePi], "a .pi that is there is denied");
    assert.deepEqual(denies("darwin", []), [gamePi], "macOS denies a path that is not there yet");
  });

  it("the policy leaves Pi's home readable and out of the write denies that would cut its grants", async () => {
    const home = os.homedir();
    const piHome = path.join(home, ".pi");
    const agent = path.join(piHome, "agent");
    const box = await ProcessSandbox.create({
      ...piSandbox({
        runDir: GAME,
        gameDir: GAME,
        gitDirs: [],
        scratchDir: "/tmp/pi-scratch",
        secretPaths: [],
        env: {},
        platform: "darwin",
        agentView: path.join(agent, "genex", "agent-1-session"),
      }),
      enabled: false,
    });
    const writes = (file: string) => reaches(box.policy.allowWrite, file);
    assert.ok(writes(path.join(agent, "sessions")), "a session writes its transcripts");
    assert.ok(
      writes(path.join(agent, "genex", "agent-1-session", "auth.json.lock")),
      "and Pi's lock beside its own sign-in",
    );
    for (const planted of ["auth.json", ...PI_LOADS])
      assert.ok(!writes(path.join(agent, planted)), `a session cannot plant agent/${planted}, which runs outside it`);
    assert.ok(!box.policy.denyRead.includes(piHome), "the CLI reads its own sign-ins");
    assert.ok(!box.policy.denyWrite.includes(piHome), "a deny on the whole store would cut the write grant inside it");
  });

  it("on Windows a session writes Pi's own folder, which it runs in as the sandbox's own user", () => {
    const agent = path.join("/Users/dev", ".pi", "agent");
    const sandbox = piSandbox({
      runDir: GAME,
      gameDir: GAME,
      gitDirs: [],
      scratchDir: "/tmp/scratch",
      secretPaths: [],
      env: {},
      home: "/Users/dev",
      platform: "win32",
    });
    assert.ok(
      sandbox.writableRoots.includes(agent),
      "Windows grants whole folders, and Pi makes its lock folder beside auth.json",
    );
    assert.ok(!sandbox.writableRoots.includes(path.join("/Users/dev", ".pi")), "never the folder above it");
    assert.deepEqual(sandbox.readableHome, [path.join("/Users/dev", ".pi")]);
    assert.deepEqual(sandbox.denyWrite, [path.join(GAME, ".pi")]);
  });

  it("in the real sandbox a session takes Pi's locks, renews its own copy of the sign-in and keeps its transcripts, and plants nothing Pi loads", {
    skip: process.platform === "win32" && "Windows grants last a whole session: pi-cli-live.test.ts runs them",
  }, async (t) => {
    const root = await realpath(await tmpDir("pi-box-"));
    const home = path.join(root, "home");
    const agent = path.join(home, ".pi", "agent");
    const game = path.join(root, "game");
    await mkdir(path.join(agent, "extensions"), { recursive: true });
    await mkdir(game, { recursive: true });
    await writeFile(path.join(game, "main.js"), "export const x = 1;\n");
    await writeFile(path.join(agent, "auth.json"), "{}");
    await writeFile(path.join(agent, "settings.json"), "{}");
    // The folder Pi is pointed at (`PI_CODING_AGENT_DIR`): the one that stands for Pi's own.
    const { dir: view, agent: agentDir } = await openPiView(agent);
    const own = ["auth.json", "extensions", "genex", "sessions", "settings.json"];
    const sandbox = await ProcessSandbox.create(
      piSandbox({
        runDir: game,
        gameDir: game,
        gitDirs: [],
        scratchDir: path.join(root, "scratch"),
        secretPaths: [],
        env: {},
        home,
        agentView: view,
        agentDir,
      }),
    );
    try {
      const started = await sandbox.ensureReady().catch((err: unknown) => err);
      if (started instanceof SandboxUnavailableError) return t.skip(`no sandbox on this machine: ${started.message}`);
      if (started) throw started;
      const run = (command: string) => sandbox.run({ command, cwd: game });
      // proper-lockfile's lock is a folder made beside the file's real path and removed again; Pi
      // takes one even to read its sign-in, its settings and its model store.
      assert.equal(path.dirname(await realpath(path.join(view, "auth.json"))), view, "the lock's place");
      for (const file of ["auth.json", "settings.json", "models-store.json"]) {
        const lock = await run(`mkdir "${path.join(view, file)}.lock" && rmdir "${path.join(view, file)}.lock"`);
        assert.equal(lock.code, 0, `Pi makes its lock folder beside ${file}: ${lock.stderr}`);
      }
      const kept = await run(`mkdir -p "${view}/sessions/game" && echo turn > "${view}/sessions/game/1.jsonl"`);
      assert.equal(kept.code, 0, `a session keeps its transcript: ${kept.stderr}`);
      assert.equal(await readFile(path.join(agent, "sessions", "game", "1.jsonl"), "utf8"), "turn\n");
      const renewed = await run(`echo '{"renewed":true}' > "${path.join(view, "auth.json")}"`);
      assert.equal(renewed.code, 0, `Pi saves a renewed sign-in for the session: ${renewed.stderr}`);
      assert.equal(await readFile(path.join(view, "auth.json"), "utf8"), '{"renewed":true}\n');
      assert.equal(await readFile(path.join(agent, "auth.json"), "utf8"), "{}", "never into the person's own file");
      // What Pi loads, in the person's folder: the entries that are there, and the ones that are not.
      const loaded = ["auth.json", "settings.json", path.join("extensions", "planted.ts"), "models.json"];
      for (const leaf of [...loaded, "APPEND_SYSTEM.md"]) await run(`echo planted > "${path.join(agent, leaf)}"`);
      // The same entries through the session's own folder, where each is a link to the person's.
      for (const leaf of ["settings.json", path.join("extensions", "planted.ts")])
        await run(`echo planted > "${path.join(view, leaf)}"`);
      await run(`mkdir "${path.join(agent, "skills")}"`);
      await run(`mkdir "${path.join(agent, "auth.json.lock")}"`);
      await run(`rm "${path.join(agent, "settings.json")}"`);
      await run(`echo staged > "${path.join(agent, "genex", "work", "staged")}"`);
      // The session's folder itself, left closed to its owner: it is still removed when the session ends.
      await run(`chmod 500 "${view}"`);
      assert.equal(await readFile(path.join(agent, "auth.json"), "utf8"), "{}", "Pi's sign-in is never a session's");
      assert.equal(await readFile(path.join(agent, "settings.json"), "utf8"), "{}", "nor are Pi's settings");
      assert.deepEqual(await readdir(path.join(agent, "extensions")), [], "nor code Pi later runs outside the sandbox");
      assert.deepEqual(await readdir(path.join(agent, "genex", "work")), [], "nor what Genex puts in the folder");
      const build = await run("git init -q . && git add -A && ls -A");
      assert.equal(build.code, 0, `the build's own commit takes every file of the game: ${build.stderr}`);
      assert.deepEqual(
        build.stdout.split("\n").filter(Boolean).sort(),
        [".git", "main.js"],
        "no stand-in .pi in the game",
      );
      const seen = await run(`ls -A "${agent}"`);
      assert.deepEqual(
        seen.stdout.split("\n").filter(Boolean).sort(),
        own,
        "a session sees Pi's folder as it is: no stand-in for a file Pi does not have, and nothing it planted",
      );
    } finally {
      await sandbox.dispose();
    }
    assert.deepEqual((await readdir(agent)).sort(), own, "and nothing else is left in the person's Pi folder");
    await closePiView(view);
    assert.deepEqual(await readdir(path.join(agent, "genex")), ["work"], "the session's folder goes when it ends");
    assert.deepEqual(await readdir(path.join(agent, "genex", "work")), [], "with all the session left in it");
    assert.deepEqual((await readdir(agent)).sort(), own);
  });

  it("a model Pi has not listed yet still reaches its provider, and only a provider Pi knows", async () => {
    const stream = await events("pi-stream.jsonl");
    const { engine, seen } = await engineWith(() => replay(stream));
    const cwd = await game();
    // No model list has been read: the app has just started, or `pi --list-models` failed.
    const reached = async (model: string) => {
      await engine.delegate({ cwd, prompt: "build", model, onEvent: () => {} });
      return seen.at(-1)?.domains;
    };
    assert.deepEqual(await reached("anthropic/claude-not-listed"), ["api.anthropic.com"]);
    for (const hostile of ["acme/bot", "__proto__/bot", "constructor/bot", "toString/bot", "/bot", "bot", "anthropic"])
      assert.deepEqual(await reached(hostile), [], `${hostile} names no provider Pi knows, so no host opens`);
  });

  it("on Windows every session is told where Pi's own folder is, whoever the sandbox runs it as", async () => {
    const stream = await events("pi-stream.jsonl");
    const home = await realpath(await tmpDir("pi-home-"));
    const { engine, seen } = await engineWith(() => replay(stream), { env: {}, home, platform: "win32" });
    await engine.delegate({ cwd: await game(), prompt: "build", onEvent: () => {} });
    assert.equal(
      seen[0]?.env.PI_CODING_AGENT_DIR,
      path.join(home, ".pi", "agent"),
      "Windows runs the session as the sandbox's own user, whose home holds no Pi sign-in",
    );
    assert.ok(!existsSync(path.join(home, ".pi", "agent", "genex")), "and no folder is made to stand for Pi's");
  });

  it("on macOS and Linux every session runs on a folder of its own that stands for Pi's, gone when it ends", {
    skip: NO_LINKS,
  }, async () => {
    const stream = await events("pi-stream.jsonl");
    for (const platform of VIEW_PLATFORMS) {
      const home = await realpath(await tmpDir("pi-home-"));
      const agent = path.join(home, ".pi", "agent");
      await mkdir(agent, { recursive: true });
      await writeFile(path.join(agent, "auth.json"), '{"signed":"in"}');
      await writeFile(path.join(agent, "models.json"), "{}");
      // What the session's Pi finds in its folder while it runs.
      const found: Array<{ signIn: string; models: string }> = [];
      const { engine, seen } = await engineWith(
        (invocation) => {
          const view = invocation.env.PI_CODING_AGENT_DIR ?? "";
          found.push({
            signIn: readFileSync(path.join(view, "auth.json"), "utf8"),
            models: realpathSync(path.join(view, "models.json")),
          });
          return replay(stream);
        },
        { env: {}, home, platform },
      );
      await engine.delegate({ cwd: await game(), prompt: "build", onEvent: () => {} });
      await engine.complete({ messages: [{ role: "user", content: "judge" }] });
      assert.equal(seen.length, 2);
      for (const session of seen) {
        const view = session.env.PI_CODING_AGENT_DIR ?? "";
        assert.equal(path.dirname(view), path.join(agent, "genex"), `${platform}: a build and a one-shot answer alike`);
        assert.ok(session.sandbox.writableRoots.includes(view), "which the session writes");
        assert.ok(session.sandbox.writableRoots.includes(path.join(agent, "sessions")), "with Pi's transcripts");
        assert.ok(!reaches(session.sandbox.writableRoots, path.join(agent, "auth.json")), "never Pi's own sign-in");
        assert.ok(!session.sandbox.writableRoots.includes(agent), "and never Pi's own folder");
        assert.equal(existsSync(view), false, "gone when the session ends");
      }
      assert.notEqual(seen[0]?.env.PI_CODING_AGENT_DIR, seen[1]?.env.PI_CODING_AGENT_DIR, "one folder a session");
      assert.deepEqual(found, [
        { signIn: '{"signed":"in"}', models: path.join(agent, "models.json") },
        { signIn: '{"signed":"in"}', models: path.join(agent, "models.json") },
      ]);
      assert.deepEqual(await readdir(path.join(agent, "genex")), ["work"]);
    }
  });

  it("a session that fails or is stopped leaves no folder behind either", { skip: NO_LINKS }, async () => {
    const home = await realpath(await tmpDir("pi-home-"));
    const own = path.join(home, ".pi", "agent", "genex");
    const failing = await engineWith(
      // biome-ignore lint/correctness/useYield: a session that dies before its first event
      async function* () {
        throw new Error("Pi exited with 1");
      },
      { env: {}, home, platform: "linux" },
    );
    const failed = await failing.engine.delegate({ cwd: await game(), prompt: "build", onEvent: () => {} });
    assert.equal(failed.ok, false);
    assert.equal(failing.seen.length, 1, "the session did start");
    assert.deepEqual(await readdir(own), ["work"]);
    await assert.rejects(failing.engine.complete({ messages: [{ role: "user", content: "judge" }] }), /exited with 1/);
    assert.deepEqual(await readdir(own), ["work"]);

    // Stopped by the person while Pi answers: the folder is there during the turn, and gone after it.
    const stream = await events("pi-stream.jsonl");
    const controller = new AbortController();
    let during: string[] = [];
    const stopping = await engineWith(
      async function* () {
        yield stream[0] ?? {};
        during = await readdir(own);
        controller.abort();
      },
      { env: {}, home, platform: "linux" },
    );
    const stopped = await stopping.engine.delegate({
      cwd: await game(),
      prompt: "build",
      signal: controller.signal,
      onEvent: () => {},
    });
    assert.equal(stopped.ok, false);
    assert.match(stopped.errorText ?? "", /stopped/i);
    assert.equal(during.length, 2, "the session's folder beside the work folder while it runs");
    assert.deepEqual(await readdir(own), ["work"]);
  });

  it("a Pi folder reached through a link is granted by its real path, where Pi makes its locks", {
    skip: NO_LINKS,
  }, async () => {
    const stream = await events("pi-stream.jsonl");
    const root = await realpath(await tmpDir("pi-linked-"));
    const kept = path.join(root, "kept", "agent");
    await mkdir(kept, { recursive: true });
    await mkdir(path.join(root, "home", ".pi"), { recursive: true });
    await symlink(kept, path.join(root, "home", ".pi", "agent"));
    for (const platform of VIEW_PLATFORMS) {
      const { engine, seen } = await engineWith(() => replay(stream), {
        env: {},
        home: path.join(root, "home"),
        platform,
      });
      await engine.delegate({ cwd: await game(), prompt: "build", onEvent: () => {} });
      const view = seen[0]?.env.PI_CODING_AGENT_DIR ?? "";
      assert.equal(
        path.dirname(view),
        path.join(kept, "genex"),
        `${platform}: Pi locks the path its sign-in resolves to`,
      );
      assert.ok(seen[0]?.sandbox.writableRoots.includes(view));
      assert.ok(seen[0]?.sandbox.writableRoots.includes(path.join(kept, "sessions")), "the transcripts beside it");
    }
  });

  it("follows a Pi folder the person moved with PI_CODING_AGENT_DIR", async () => {
    const home = await realpath(await tmpDir("pi-home-"));
    const moved = path.join(await realpath(await tmpDir("pi-moved-")), "agent");
    const env = { PI_CODING_AGENT_DIR: moved };
    assert.equal(piAgentDir(env, home), moved);
    assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "~/pi-data" }, home), path.join(home, "pi-data"), "Pi expands ~");
    assert.equal(
      piAgentDir({ PI_CODING_AGENT_DIR: "relative/agent" }, home),
      path.join(home, ".pi", "agent"),
      "a relative folder is never granted: it would mean a different place in every session",
    );
    for (const homes of [credentialHomes([], env, home), sandboxedCliHomes(env, home)])
      assert.ok(homes.includes(moved), "the moved folder holds the sign-ins, so it is fenced like ~/.pi");
    const stream = await events("pi-stream.jsonl");
    const { engine, seen } = await engineWith(() => replay(stream), { env, home });
    await engine.delegate({ cwd: await game(), prompt: "build", onEvent: () => {} });
    const [session] = seen;
    const roots = session?.sandbox.writableRoots ?? [];
    assert.ok(reaches([moved], session?.env.PI_CODING_AGENT_DIR ?? ""), "Pi is pointed into the moved folder");
    assert.ok(reaches(roots, path.join(moved, "sessions", "--game--", "1.jsonl")), "its transcripts go there");
    assert.ok(session?.sandbox.readableHome?.includes(moved), "and it reads its sign-ins there");
    if (process.platform !== "win32")
      assert.ok(!reaches(roots, path.join(moved, "settings.json")), "and writes none of what Pi loads there");
  });

  it("a building session in a linked worktree writes its Git metadata; a read-only session does not", async () => {
    const repo = await realpath(await tmpDir("pi-repo-"));
    await writeFile(path.join(repo, "main.js"), "export const x = 1;\n");
    await git(repo, "init", "-q");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "first");
    const worker = path.join(await realpath(await tmpDir("pi-worker-")), "copy");
    await git(repo, "worktree", "add", "-q", "--detach", worker);
    const gitDir = await realpath(path.join(repo, ".git", "worktrees", "copy"));
    const commonDir = await realpath(path.join(repo, ".git"));
    const stream = await events("pi-stream.jsonl");
    const { engine, seen } = await engineWith(() => replay(stream));
    await engine.delegate({ cwd: worker, prompt: "build", onEvent: () => {} });
    await engine.delegate({ cwd: worker, prompt: "look", readOnly: true, onEvent: () => {} });
    const [builder, reader] = seen;
    for (const dir of [gitDir, commonDir]) {
      assert.ok(builder?.sandbox.writableRoots.includes(dir), `the build commits through ${dir}, outside its folder`);
      assert.ok(!reader?.sandbox.writableRoots.includes(dir), `a read-only session writes no Git metadata (${dir})`);
    }
  });
});

describe("Pi's sign-in before a session copies it", () => {
  const MODEL = "anthropic/claude-sonnet";
  /** A Pi that has the renewal command. */
  const current = async () => ({ ready: true, path: "/usr/local/bin/pi", version: "1.5.2", detail: "ok" });
  /** The first renewal a sign-in file needs, or null. */
  const piSignInRenewal = (text: string, at: Parameters<typeof piSignInRenewals>[1]) =>
    piSignInRenewals(text, at)[0] ?? null;
  /** Pi's sign-in file with one subscription sign-in, as Pi 1.5.2 writes it. */
  const subscription = (access: string, expires: number, more: Record<string, unknown> = {}) =>
    JSON.stringify({ anthropic: { type: "oauth", access, refresh: `refresh-${access}`, expires }, ...more });

  it("knows when a subscription sign-in would not outlast a session, and the lead that makes Pi renew it now", () => {
    const now = Date.parse("2026-11-19T12:00:00Z");
    const renewal = (expires: unknown, at: { provider?: string; life?: number } = {}) =>
      piSignInRenewal(JSON.stringify({ anthropic: { type: "oauth", access: "a", refresh: "r", expires } }), {
        now,
        ...(at.provider === undefined ? {} : { provider: at.provider }),
        life: () => at.life,
      });
    const soon = renewal(now + 10 * 60_000);
    assert.equal(soon?.provider, "anthropic");
    assert.equal(soon?.expires, now + 10 * 60_000);
    assert.ok((soon?.minExpirySeconds ?? 0) > 10 * 60, "ten minutes left: a lead past that makes Pi renew at once");
    assert.equal(renewal(now - HOUR_MS)?.minExpirySeconds, 300, "expired: Pi's own lead does it");
    assert.equal(renewal(now + 8 * HOUR_MS), null, "eight hours left");
    assert.equal(renewal(now + 10 * 60_000, { provider: "anthropic" })?.provider, "anthropic");
    assert.equal(renewal(now + 10 * 60_000, { provider: "openai-codex" }), null, "another provider's session");
    // A token that lasts an hour is renewed with half of it left, so a new one is never due too.
    assert.equal(renewal(now + 40 * 60_000, { life: HOUR_MS }), null, "forty minutes left of an hour");
    const hourly = renewal(now + 20 * 60_000, { life: HOUR_MS })?.minExpirySeconds ?? 0;
    assert.ok(hourly > 20 * 60 && hourly < 30 * 60, `twenty minutes left of an hour: ${hourly}`);
    assert.ok(renewal(now + 40 * 60_000), "and before a renewal showed how long a token lasts, it is due");

    const two = JSON.stringify({
      "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: now + 30 * 60_000 },
      anthropic: { type: "oauth", access: "a", refresh: "r", expires: now + 60 * 60_000 },
      openrouter: { type: "api_key", key: "k", expires: now },
    });
    assert.deepEqual(
      piSignInRenewals(two, { now }).map((renewal) => renewal.provider),
      ["openai-codex", "anthropic"],
      "with no model named Pi picks one: every subscription sign-in that is due, the first to expire first",
    );
    assert.equal(piSignInRenewal(two, { now, provider: "anthropic" })?.provider, "anthropic");
    assert.equal(piSignInRenewal(two, { now, provider: "openrouter" }), null, "a stored key is not renewed");
    assert.equal(piSignInRenewal(two, { now, provider: "toString" }), null, "only the file's own entries");
  });

  it("renews nothing for a file that is not Pi's sign-in, an entry Pi could not renew, or a name Pi would read as an option", () => {
    const now = Date.parse("2026-11-19T12:00:00Z");
    const soon = now + 60_000;
    const hostileFiles = ["", "not json", "null", "[]", '"text"', "7", '{"anthropic": null}', '{"anthropic": "oauth"}'];
    for (const text of hostileFiles) assert.equal(piSignInRenewal(text, { now }), null, JSON.stringify(text));
    const hostileEntries: Array<Record<string, unknown>> = [
      { type: "api_key", key: "!touch planted", expires: soon },
      { type: "oauth", access: "a", expires: soon },
      { type: "oauth", access: "a", refresh: 7, expires: soon },
      { type: "oauth", access: "a", refresh: "r" },
      { type: "oauth", access: "a", refresh: "r", expires: String(soon) },
      { type: "oauth", access: "a", refresh: "r", expires: null },
      { type: "OAuth", access: "a", refresh: "r", expires: soon },
    ];
    for (const entry of hostileEntries)
      assert.equal(piSignInRenewal(JSON.stringify({ anthropic: entry }), { now }), null, JSON.stringify(entry));
    const good = { type: "oauth", access: "a", refresh: "r", expires: soon };
    for (const name of ["--model", "-e", "", "a b", "x;y", "$(id)", "../up", "a/b"])
      assert.equal(piSignInRenewal(JSON.stringify({ [name]: good }), { now }), null, JSON.stringify(name));
    assert.equal(piSignInRenewal(JSON.stringify({ "github-copilot": good }), { now })?.provider, "github-copilot");
  });

  it("names a model's provider, asks only a Pi that has the command, and asks it for one provider", () => {
    assert.equal(piModelProvider("anthropic/claude-sonnet"), "anthropic");
    assert.equal(piModelProvider("openrouter/meta/llama"), "openrouter");
    for (const model of [undefined, "", "sonnet", "/sonnet"]) assert.equal(piModelProvider(model), undefined);
    for (const version of ["0.83.0", "1.5.2", "pi 1.0.0"]) assert.equal(piRenewsSignIn(version), true, version);
    // An older Pi has no `auth` command and would take the words as a prompt.
    for (const version of [undefined, "", "live", "0.82.9", "0.83.0-beta.1"])
      assert.equal(piRenewsSignIn(version), false, String(version));
    assert.deepEqual(piRenewalArgs({ provider: "anthropic", expires: 0, minExpirySeconds: 660 }), [
      "auth",
      "print-bearer-token",
      "--provider",
      "anthropic",
      "--min-expiry",
      "660s",
    ]);
  });

  it("on macOS and Linux has the person's own Pi renew a sign-in about to expire before a session copies it, once", {
    skip: NO_LINKS,
  }, async () => {
    // What a session renews stays in its copy, and the provider takes the person's refresh token once.
    const recorded = await events("pi-stream.jsonl");
    for (const platform of VIEW_PLATFORMS) {
      const home = await realpath(await tmpDir("pi-renew-"));
      const agent = path.join(home, ".pi", "agent");
      await mkdir(agent, { recursive: true });
      const file = path.join(agent, "auth.json");
      let now = Date.now();
      await writeFile(file, subscription("access-1", now + 10 * 60_000));
      const asked: PiSignInRenewal[] = [];
      const renewSignIn = async (binary: string, renewal: PiSignInRenewal) => {
        assert.equal(binary, "/usr/local/bin/pi", "the person's own Pi");
        asked.push(renewal);
        await writeFile(file, subscription("access-2", now + 8 * HOUR_MS));
      };
      const found: string[] = [];
      const stream = (invocation: PiInvocation) => {
        const copy = path.join(invocation.env.PI_CODING_AGENT_DIR ?? "", "auth.json");
        found.push(JSON.parse(readFileSync(copy, "utf8")).anthropic.access);
        return replay(recorded);
      };
      const { engine } = await engineWith(stream, {
        home,
        platform,
        renewSignIn,
        clock: () => now,
        resolveCli: current,
      });
      await Promise.all([
        engine.delegate({ cwd: await game(), prompt: "x", model: MODEL }),
        engine.delegate({ cwd: await game(), prompt: "y", model: MODEL }),
      ]);
      await engine.complete({ messages: [{ role: "user", content: "judge" }], model: MODEL });
      assert.deepEqual(
        found,
        ["access-2", "access-2", "access-2"],
        `${platform}: every session copies the renewed one`,
      );
      assert.equal(asked.length, 1, "one renewal for the sessions that waited on it, none once renewed");
      assert.equal(asked[0]?.provider, "anthropic");
      assert.ok((asked[0]?.minExpirySeconds ?? 0) > 10 * 60, "a lead that makes Pi renew it at once");

      // Eight hours is what the renewal showed a token lasts: the next is due with two hours left.
      now += 5 * HOUR_MS;
      await engine.delegate({ cwd: await game(), prompt: "x", model: MODEL });
      assert.equal(asked.length, 1, "three hours left: it holds");
      now += 2 * HOUR_MS;
      await engine.delegate({ cwd: await game(), prompt: "x", model: MODEL });
      assert.equal(asked.length, 2, "an hour left: renewed again");
      await engine.delegate({ cwd: await game(), prompt: "x", model: "openrouter/meta/llama" });
      await writeFile(file, subscription("access-3", now + 60_000, { openrouter: { type: "api_key", key: "k" } }));
      await engine.delegate({ cwd: await game(), prompt: "x", model: "openrouter/meta/llama" });
      assert.equal(asked.length, 2, "a session on a stored key renews no one's sign-in");
    }
  });

  it("leaves a sign-in a renewal could not change for a while, and the session gets what there is", {
    skip: NO_LINKS,
  }, async () => {
    const home = await realpath(await tmpDir("pi-renew-"));
    const agent = path.join(home, ".pi", "agent");
    await mkdir(agent, { recursive: true });
    const file = path.join(agent, "auth.json");
    let now = Date.now();
    await writeFile(file, subscription("dead", now - 60_000));
    const asked: PiSignInRenewal[] = [];
    const found: string[] = [];
    const stream = (invocation: PiInvocation) => {
      const copy = path.join(invocation.env.PI_CODING_AGENT_DIR ?? "", "auth.json");
      found.push(JSON.parse(readFileSync(copy, "utf8")).anthropic.access);
      return replay([]);
    };
    const offline = async (_binary: string, renewal: PiSignInRenewal) => {
      asked.push(renewal);
      throw new Error("offline");
    };
    const { engine } = await engineWith(stream, {
      home,
      platform: "linux",
      renewSignIn: offline,
      clock: () => now,
      resolveCli: current,
    });
    await engine.delegate({ cwd: await game(), prompt: "x", model: MODEL });
    await engine.delegate({ cwd: await game(), prompt: "x", model: MODEL });
    assert.equal(asked.length, 1, "not asked again at once");
    assert.deepEqual(found, ["dead", "dead"], "the session still starts, and says what Pi says");
    now += 10 * 60_000;
    await engine.delegate({ cwd: await game(), prompt: "x", model: MODEL });
    assert.equal(asked.length, 2, "and is tried again later: the failure may have passed");
    await writeFile(file, subscription("signed-in-again", now + 60_000));
    await engine.delegate({ cwd: await game(), prompt: "x", model: MODEL });
    assert.equal(asked.length, 3, "a sign-in that changed is asked about at once");
  });

  it("learns how long a provider's tokens last, renews every due sign-in when Pi picks the model, and asks no Pi too old", {
    skip: NO_LINKS,
  }, async () => {
    const home = await realpath(await tmpDir("pi-renew-"));
    const agent = path.join(home, ".pi", "agent");
    await mkdir(agent, { recursive: true });
    const file = path.join(agent, "auth.json");
    let now = Date.now();
    const signIns = (anthropic: number, codex: number) =>
      subscription("a", anthropic, { "openai-codex": { type: "oauth", access: "c", refresh: "r", expires: codex } });
    // Codex's sign-in is dead and no renewal brings it back; Anthropic's tokens last an hour.
    const dead = now - HOUR_MS;
    await writeFile(file, signIns(now + 10 * 60_000, dead));
    const asked: string[] = [];
    const renewSignIn = async (_binary: string, renewal: PiSignInRenewal) => {
      asked.push(renewal.provider);
      if (renewal.provider === "anthropic") await writeFile(file, signIns(now + HOUR_MS, dead));
    };
    const where = { home, platform: "linux", renewSignIn, clock: () => now } as const;
    const { engine } = await engineWith(() => replay([]), { ...where, resolveCli: current });
    await engine.delegate({ cwd: await game(), prompt: "x" });
    assert.deepEqual(asked, ["openai-codex", "anthropic"], "no model named: each due sign-in, not only the first");
    now += 20 * 60_000;
    await engine.delegate({ cwd: await game(), prompt: "x" });
    assert.deepEqual(
      asked.slice(2),
      ["openai-codex"],
      "forty minutes left of an hour holds; the dead one is tried again",
    );
    now += 60_000;
    await engine.delegate({ cwd: await game(), prompt: "x" });
    assert.equal(asked.length, 3, "and waits after that, holding up no one");
    now += 19 * 60_000;
    await engine.delegate({ cwd: await game(), prompt: "x", model: MODEL });
    assert.deepEqual(asked.slice(3), ["anthropic"], "twenty minutes left of an hour: renewed");

    // An older Pi has no `auth` command and would take the words as a prompt, outside the sandbox.
    await writeFile(file, signIns(now + 60_000, dead));
    for (const version of ["0.82.9", undefined]) {
      const old = await engineWith(() => replay([]), {
        ...where,
        resolveCli: async () => ({
          ready: true,
          path: "/usr/local/bin/pi",
          detail: "ok",
          ...(version ? { version } : {}),
        }),
      });
      await old.engine.delegate({ cwd: await game(), prompt: "x", model: MODEL });
      assert.equal(old.seen.length, 1, "the session starts");
    }
    assert.equal(asked.length, 4, "a Pi too old, or one whose version cannot be read, is asked nothing");
  });

  it("on Windows asks for no renewal: a session there runs on Pi's own folder and renews Pi's own file", async () => {
    const home = await realpath(await tmpDir("pi-renew-"));
    const agent = path.join(home, ".pi", "agent");
    await mkdir(agent, { recursive: true });
    await writeFile(path.join(agent, "auth.json"), subscription("access-1", Date.now() + 60_000));
    const asked: PiSignInRenewal[] = [];
    const { engine, seen } = await engineWith(() => replay([]), {
      home,
      platform: "win32",
      resolveCli: current,
      renewSignIn: async (_binary, renewal) => {
        asked.push(renewal);
      },
    });
    await engine.delegate({ cwd: await game(), prompt: "x", model: MODEL });
    assert.equal(seen.length, 1);
    assert.deepEqual(asked, []);
  });

  it("waits only so long on a renewal, which Pi finishes and writes without being stopped, its output unread", {
    skip: process.platform === "win32" && "a shell script stands in for pi",
  }, async () => {
    // Stopping Pi between the provider's answer and its write would leave the person a spent refresh token.
    const root = await realpath(await tmpDir("pi-renewal-"));
    const log = path.join(root, "log.txt");
    const file = path.join(root, "auth.json");
    await writeFile(file, subscription("access-1", Date.now() + 60_000));
    const script = path.join(root, "pi.mjs");
    await writeFile(
      script,
      `import { appendFileSync, writeFileSync } from "node:fs";
const log = (line) => appendFileSync(${JSON.stringify(log)}, line + "\\n");
log(process.argv.slice(2).join(" ") + " in " + process.cwd());
process.on("SIGTERM", () => { log("stopped"); process.exit(1); });
setTimeout(() => {
  writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(subscription("access-2", Date.now() + 8 * HOUR_MS))});
  process.stdout.write("the-token\\n");
  log("renewed");
}, 1500);
`,
    );
    const pi = path.join(root, "pi");
    await writeFile(pi, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
    const started = Date.now();
    await renewPiSignIn(pi, {
      env: { PATH: process.env.PATH ?? "" },
      cwd: root,
      renewal: { provider: "anthropic", expires: 0, minExpirySeconds: 120 },
      waitMs: 200,
    });
    assert.ok(Date.now() - started < 1_200, "the session went on without the renewal");
    const deadline = Date.now() + 5_000;
    while (!(await readFile(log, "utf8").catch(() => "")).includes("renewed") && Date.now() < deadline) await sleep(50);
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
      `auth print-bearer-token --provider anthropic --min-expiry 120s in ${root}`,
      "renewed",
    ]);
    assert.equal(JSON.parse(await readFile(file, "utf8")).anthropic.access, "access-2");

    // A Pi that never ends is stopped at the cap, and only then.
    const hung = path.join(root, "hung");
    await writeFile(
      hung,
      `#!/bin/sh\nexec "${process.execPath}" -e 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000)'\n`,
      { mode: 0o755 },
    );
    const before = Date.now();
    await renewPiSignIn(hung, {
      env: { PATH: process.env.PATH ?? "" },
      cwd: root,
      renewal: { provider: "anthropic", expires: 0, minExpirySeconds: 120 },
      waitMs: 5_000,
      capMs: 300,
    });
    const took = Date.now() - before;
    // A timer may fire a few milliseconds early by the clock.
    assert.ok(took >= 250 && took < 4_000, `stopped at the cap, and the wait ended with it: ${took} ms`);
  });
});

describe("Pi's JSON stream", () => {
  it("takes one reply's usage from the last snapshot, not the sum of every delta", async () => {
    const cwd = await game();
    const stream = await events("pi-stream.jsonl");
    const mirrored: DelegateEvent[] = [];
    const { engine } = await engineWith(() => replay(stream));
    const result = await engine.delegate({ cwd, prompt: "Hi", onEvent: (event) => mirrored.push(event) });
    assert.equal(result.ok, true);
    assert.equal(result.summary, "Hello from Pi.");
    assert.equal(result.turns, 1, "one assistant reply is one turn");
    assert.equal(result.usage.input_tokens, 100, "cumulative input, not 100+100");
    assert.equal(result.usage.output_tokens, 2, "cumulative output, not 1+2");
    assert.equal(result.usage.cost_usd, 0.02);
    const assistants = mirrored.filter((event) => event.type === "assistant");
    assert.equal(assistants.length, 1, "message_end is the one chat row, not each delta");
    assert.ok(
      mirrored.some((event) => event.type === "text_delta"),
      "deltas still stream for the live display",
    );
  });

  it("a rate-limit retry that gives up is a failure, not an empty success", async () => {
    const cwd = await game();
    const stream = await events("pi-error.jsonl");
    const { engine } = await engineWith(() => replay(stream));
    await assert.rejects(
      engine.delegate({ cwd, prompt: "Hi", onEvent: () => {} }),
      (err: unknown) => err instanceof EngineError && err.kind === "rate_limit",
    );
  });

  it("a retry that succeeds after message_end error is a success, not a leftover failure", async () => {
    const cwd = await game();
    const stream = await events("pi-retry.jsonl");
    const mirrored: DelegateEvent[] = [];
    const { engine } = await engineWith(() => replay(stream));
    const result = await engine.delegate({ cwd, prompt: "Hi", onEvent: (event) => mirrored.push(event) });
    assert.equal(result.ok, true);
    assert.equal(result.summary, "Hello after retry.");
    assert.ok(
      !mirrored.some((event) => event.type === "result" && (event.payload as { subtype?: string }).subtype === "error"),
    );
  });

  it("an expired sign-in says to sign in to Pi again", async () => {
    const cwd = await game();
    const stream = await events("pi-expired.jsonl");
    const { engine } = await engineWith(() => replay(stream));
    await assert.rejects(
      engine.delegate({ cwd, prompt: "Hi", onEvent: () => {} }),
      (err: unknown) => err instanceof EngineError && err.kind === "auth" && /sign in to Pi again/i.test(err.message),
    );
  });

  it("a read-only auth.json that cannot refresh says to sign in to Pi again", async () => {
    const cwd = await game();
    const stream = await events("pi-eperm.jsonl");
    const { engine } = await engineWith(() => replay(stream));
    await assert.rejects(
      engine.delegate({ cwd, prompt: "Hi", onEvent: () => {} }),
      (err: unknown) => err instanceof EngineError && err.kind === "auth" && /sign in to Pi again/i.test(err.message),
    );
  });

  it("Pi dying because auth.json cannot be written says to sign in again", async () => {
    const cwd = await game();
    const { engine } = await engineWith(async function* () {
      yield { type: "session", id: "sess-eperm" };
      throw new Error(
        "Credential store modify failed for openai: EPERM: operation not permitted, open '/Users/dev/.pi/agent/auth.json'",
      );
    });
    await assert.rejects(
      engine.delegate({ cwd, prompt: "Hi", onEvent: () => {} }),
      (err: unknown) => err instanceof EngineError && err.kind === "auth" && /sign in to Pi again/i.test(err.message),
    );
  });

  it("a refresh the provider refuses with OAuth's invalid_grant says to sign in to Pi again", async () => {
    const cwd = await game();
    const refused = [
      // The live run's shape: Pi names no status at the head, only inside its own words.
      'OAuth refresh failed for openai-codex (400): {"error":"invalid_grant","error_description":"expired"}',
      // A provider status at the head is read first, and a 400 would otherwise read as a refused model.
      '400: {"error":"invalid_grant","error_description":"Refresh token revoked"}',
    ];
    for (const errorMessage of refused) {
      const { engine } = await engineWith(async function* () {
        yield { type: "session", id: "sess-grant" };
        yield { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage } };
        yield { type: "agent_end", willRetry: false };
      });
      await assert.rejects(
        engine.delegate({ cwd, prompt: "Hi", model: "openai-codex/gpt-5", onEvent: () => {} }),
        (err: unknown) => err instanceof EngineError && err.kind === "auth" && /sign in to Pi again/i.test(err.message),
        errorMessage,
      );
    }
  });

  it("Pi dying on a refused refresh (invalid_grant) says to sign in again, not the raw error", async () => {
    const cwd = await game();
    const { engine } = await engineWith(async function* () {
      yield { type: "session", id: "sess-grant-exit" };
      throw stderrFailure('Error: OAuth refresh failed (400): {"error":"invalid_grant"}', 1);
    });
    await assert.rejects(
      engine.delegate({ cwd, prompt: "Hi", onEvent: () => {} }),
      (err: unknown) =>
        err instanceof EngineError &&
        err.kind === "auth" &&
        /sign in to Pi again/i.test(err.message) &&
        !/invalid_grant/.test(err.message),
    );
  });

  it("a word that only contains invalid_grant is not OAuth's code", async () => {
    const cwd = await game();
    const { engine } = await engineWith(async function* () {
      yield { type: "session", id: "sess-grant-word" };
      yield {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "tool said invalid_granted_scope",
        },
      };
      yield { type: "agent_end", willRetry: false };
    });
    const result = await engine.delegate({ cwd, prompt: "Hi", onEvent: () => {} });
    assert.equal(result.stopReason, "error");
    assert.match(result.errorText ?? "", /invalid_granted_scope/);
  });

  it("reads a provider status only where Pi puts it, at the head of the error", () => {
    const failure = (errorMessage: string) =>
      translatePiEvent({
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage },
      }).pendingFailure;
    assert.equal(failure('401: {"error":{"message":"invalid key"}}')?.status, 401);
    assert.equal(failure("429 rate limited")?.status, 429, "Pi's retry errors carry the status first");
    assert.equal(
      failure('500: {"error":{"message":"upstream said 429"}}')?.status,
      500,
      "a number in the body is text",
    );
    assert.equal(failure("Bad Request: model not found")?.status, null, "no status, no guess");
  });

  it("a failure that only reads like a sign-in problem is not one", async () => {
    const cwd = await game();
    const { engine } = await engineWith(async function* () {
      yield { type: "session", id: "sess-prose" };
      yield {
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: "not signed in, said the proxy" },
      };
      yield { type: "agent_end", willRetry: false };
    });
    const result = await engine.delegate({ cwd, prompt: "Hi", onEvent: () => {} });
    assert.equal(result.stopReason, "error");
    assert.match(result.errorText ?? "", /said the proxy/);
  });

  it("a permission failure on a file that is not the credential store is not a sign-in problem", async () => {
    const cwd = await game();
    const { engine } = await engineWith(async function* () {
      yield { type: "session", id: "sess-eperm-other" };
      yield {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "EPERM: operation not permitted, open '/game/out.js'",
        },
      };
      yield { type: "agent_end", willRetry: false };
    });
    const result = await engine.delegate({ cwd, prompt: "Hi", onEvent: () => {} });
    assert.equal(result.stopReason, "error");
    assert.match(result.errorText ?? "", /out\.js/);
  });

  it("keeps a credential out of the error a failed Pi process leaves in the chat", () => {
    const failed = stderrFailure("Error: provider rejected Bearer sk-live-abc123def456", 1);
    assert.doesNotMatch(failed.message, /sk-live-abc123def456/);
    assert.match(failed.message, /\[redacted\]/);
    assert.match(stderrFailure("\n", 2).message, /exited with 2/);
  });

  it("a refused model ends as an error, not an empty answer", async () => {
    const cwd = await game();
    const stream = await events("pi-refusal.jsonl");
    const { engine } = await engineWith(() => replay(stream));
    const result = await engine.delegate({ cwd, prompt: "Hi", model: "anthropic/claude-sonnet-4", onEvent: () => {} });
    assert.equal(result.ok, false);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorText ?? "", /model not found/i);
  });

  it("a non-zero exit after events is a failure", async () => {
    const cwd = await game();
    const { engine } = await engineWith(async function* () {
      yield { type: "session", id: "sess-exit" };
      throw new Error("Pi exited with 1");
    });
    const result = await engine.delegate({ cwd, prompt: "Hi", onEvent: () => {} });
    assert.equal(result.ok, false);
    assert.match(result.errorText ?? "", /exited with 1/);
  });
});

describe("Pi's plan and one-shot answers", () => {
  it("keeps bash in Plan so the studio tools bridge can run", async () => {
    const cwd = await game();
    const { engine, seen } = await engineWith(() => replay([]));
    await engine.delegate({
      cwd,
      prompt: "Plan it",
      permissions: {
        mode: PermissionMode.Plan,
        allow: [],
        directories: [],
        protectWrites: [],
        ask: async () => ({ decision: "allow" as const }),
      },
      interviewTools: [{ name: "ask_user", description: "ask", parameters: { type: "object", properties: {} } }],
      onEvent: () => {},
    });
    const tools = seen[0]?.argv[seen[0].argv.indexOf("--tools") + 1] ?? "";
    assert.match(tools, /\bbash\b/, "Plan still has bash for node .studio/bridge/tool.mjs");
  });

  it("answers a judge with no tools", async () => {
    const stream = await events("pi-run.jsonl");
    const { engine, seen } = await engineWith(() => replay(stream));
    const response = await engine.complete({
      systemPrompt: "You judge builds.",
      messages: [{ role: "user", content: "A or B?" }],
    });
    assert.equal(response.message.content, "Hello from Pi.");
    assert.equal(response.engine, "pi");
    assert.ok(seen[0]?.argv.includes("--no-tools"));
    await assert.rejects(
      engine.complete({
        messages: [{ role: "user", content: "x" }],
        tools: [{ name: "t", description: "t", parameters: { type: "object", properties: {} } }],
      }),
      /no studio tools/,
    );
  });
  it("a session's and a judge's pictures reach Pi as file arguments, from a folder the session reads", async () => {
    const stream = await events("pi-run.jsonl");
    const pictures: Array<{ argument: string; bytes: string; prompt: string }> = [];
    const { engine, root } = await engineWith((invocation) => {
      for (const argument of invocation.argv.filter((value) => value.startsWith("@")))
        pictures.push({
          argument,
          bytes: readFileSync(argument.slice(1)).toString("base64"),
          prompt: invocation.prompt,
        });
      return replay(stream);
    });
    const image = { label: "the bug", mimeType: "image/png", data: PIXEL };
    await engine.delegate({ cwd: await game(), prompt: "Fix this", images: [image], onEvent: () => {} });
    await engine.complete({ messages: [{ role: "user", content: "A or B?", images: [image] }] });
    assert.equal(
      pictures.length,
      2,
      "Pi takes a picture only as an @file argument: one for the build, one for the judge",
    );
    for (const picture of pictures) {
      const file = picture.argument.slice(1);
      assert.equal(picture.bytes, PIXEL, "the picture's own bytes, there while Pi runs");
      assert.match(file, /\.png$/);
      assert.ok(file.startsWith(path.join(root, "scratch")), "in the engine's own scratch, which every sandbox grants");
      assert.equal(existsSync(file), false, "and gone when the turn ends");
      assert.doesNotMatch(picture.prompt, /@/, "an @path inside the prompt's text is only text to Pi");
    }
  });

  it("a turn whose pictures cannot be written leaves no folder behind", async () => {
    const { engine, root, seen } = await engineWith(() => replay([]));
    // The pictures' folder is under the engine's scratch: a file in its place refuses every picture.
    await mkdir(path.join(root, "scratch"), { recursive: true });
    await writeFile(path.join(root, "scratch", "tmp"), "in the way");
    const image = { label: "the bug", mimeType: "image/png", data: PIXEL };
    const cwd = await game();
    const refused = (err: NodeJS.ErrnoException) => err.code === "EEXIST" || err.code === "ENOTDIR";
    await assert.rejects(
      engine.complete({ messages: [{ role: "user", content: "A or B?", images: [image] }] }),
      refused,
    );
    await assert.rejects(
      engine.delegate({ cwd, prompt: "Look", readOnly: true, images: [image], onEvent: () => {} }),
      refused,
    );
    assert.equal(seen.length, 0, "no session starts without its pictures");
    assert.deepEqual(await readdir(path.join(root, "scratch")), ["tmp"], "no answer or run folder is left");
  });
});

/**
 * Streams recorded from a real `pi --mode json` (1.4.0) against a local stand-in endpoint
 * (`fixtures/transcripts/pi-recorded/README.md`): Pi's own events, retries, stop reasons and usage.
 */
describe("Pi's recorded JSON stream", () => {
  const recorded = (name: string) => events(path.join("pi-recorded", `${name}.jsonl`));
  const run = async (name: string) => {
    const cwd = await game();
    const stream = await recorded(name);
    const mirrored: DelegateEvent[] = [];
    const { engine } = await engineWith(() => replay(stream));
    const settled = engine
      .delegate({ cwd, prompt: "Say hello", onEvent: (event) => mirrored.push(event) })
      .then((result) => ({ result, error: null }))
      .catch((error: unknown) => ({ result: null, error }));
    return { ...(await settled), mirrored };
  };
  const errorRows = (mirrored: DelegateEvent[]) =>
    mirrored.filter((event) => event.type === "result" && (event.payload as { subtype?: string }).subtype === "error");

  it("adds one reply's usage once, from message_end, however many deltas carried it", async () => {
    const { result, mirrored } = await run("ok");
    assert.equal(result?.ok, true);
    assert.equal(result?.usage.input_tokens, 120, "five message_update snapshots of 120 are still 120");
    assert.equal(result?.usage.output_tokens, 7);
    assert.equal(mirrored.filter((event) => event.type === "text_delta").length, 3, "each delta streams live");
  });

  it("sums usage across replies, one message_end each", async () => {
    const { result } = await run("tool");
    assert.equal(result?.ok, true);
    assert.equal(result?.summary, "Done: genex.");
    assert.equal(result?.usage.input_tokens, 250, "100 + 150");
    assert.equal(result?.usage.output_tokens, 12, "5 + 7");
  });

  it("makes one chat row per reply, not one per delta, and does not repeat the text", async () => {
    const { result, mirrored } = await run("ok");
    const rows = mirrored.filter((event) => event.type === "assistant");
    assert.equal(rows.length, 1);
    assert.equal(result?.turns, 1);
    assert.equal(result?.summary, "Hello from Pi.");
    const said = JSON.stringify(rows[0]?.payload);
    assert.equal(said.split("Hello from Pi.").length - 1, 1, "message_end's text appears once");
  });

  it("a rate limit Pi gave up retrying is a rate-limit failure, not an empty success", async () => {
    const { result, error } = await run("ratelimit");
    assert.equal(result, null);
    assert.ok(error instanceof EngineError && error.kind === "rate_limit", String(error));
  });

  it("a retry that then succeeds ends as that success, with no error left in the chat", async () => {
    const { result, mirrored } = await run("flaky");
    assert.equal(result?.ok, true);
    assert.equal(result?.summary, "Hello from Pi.");
    assert.equal(result?.usage.input_tokens, 120, "the failed attempt reported no usage");
    assert.deepEqual(errorRows(mirrored), []);
  });

  it("a model the provider does not have is an error with the provider's words", async () => {
    const { result, error } = await run("badmodel");
    const said = result?.errorText ?? (error instanceof Error ? error.message : "");
    assert.notEqual(result?.ok, true);
    assert.match(said, /does not exist/);
  });

  it("a 401 says to sign in to Pi again", async () => {
    const { error } = await run("auth");
    assert.ok(error instanceof EngineError && error.kind === "auth", String(error));
    assert.match(error.message, /sign in to Pi again/i);
  });

  it("a filtered reply with no text is an error, not an empty answer", async () => {
    const { result } = await run("refusal");
    assert.equal(result?.ok, false);
    assert.equal(result?.stopReason, "error");
    assert.match(result?.errorText ?? "", /content_filter/);
  });

  it("no network is an error once Pi stops retrying", async () => {
    const { result, error } = await run("nonetwork");
    const said = result?.errorText ?? (error instanceof Error ? error.message : "");
    assert.notEqual(result?.ok, true);
    assert.match(said, /Connection error/);
  });

  it("reads the failed message inside a nested stream error, not [object Object]", () => {
    const translated = translatePiEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "error",
        reason: "error",
        error: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limited" },
      },
    });
    assert.equal(translated.pendingFailure?.message, "429 rate limited");
    assert.equal(translated.pendingFailure?.status, 429);
  });
});
