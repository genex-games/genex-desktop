/**
 * Cursor: a delegated harness the studio runs inside its own sandbox (`cursor-agent --print`).
 *
 * Recorded from Cursor's CLI 2026.10.22: the signed-out status and print-mode failure. Written, not
 * recorded (`*-written-*`, until an account records them): the model list, the run stream and the
 * usage-limit failure, from Cursor's documented stream-json shapes and the CLI's own formatter and
 * stream writer. All are replayed through the engine's `execFn` seam, so the translation, the
 * command line, the environment, the sandbox and every ending are exercised without the CLI, an
 * account or the network. The stall and exit watch runs real stand-in processes on a clock the test
 * holds.
 */
import assert from "node:assert/strict";
import { readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  CURSOR_RESULT_EXIT_MS,
  CURSOR_STALL_MS,
  CursorEngine,
  CursorExit,
  type CursorExec,
  type CursorInvocation,
  type CursorSchedule,
  CursorStall,
  connectFailure,
  cursorEvents,
  cursorSessionEnv,
} from "../../src/substrate/engines/cursor.ts";
import {
  CursorAccess,
  cursorSessionArgv,
  parseCursorModels,
  parseCursorStatus,
} from "../../src/substrate/engines/cursor-cli.ts";
import { cursorHomes } from "../../src/substrate/credential-homes.ts";
import { EngineError, type DelegateEvent } from "../../src/substrate/engines/types.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { EngineFailureKind, StopReason } from "../../src/shared/engine-requests.ts";
import { EngineStatusCode, LoginSource } from "../../src/shared/engine-descriptor.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { tmpDir } from "../helpers/tmp.ts";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures", "transcripts");
const fixture = (name: string) => readFile(path.join(FIXTURES, name), "utf8");
const events = async (name: string) =>
  (await fixture(name))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const ready = async () => ({
  ready: true,
  path: "/Users/me/.local/bin/cursor-agent",
  version: "2026.10.22-27dcf5f",
  detail: "ok",
});
const signedIn = async () => JSON.stringify({ status: "authenticated", isAuthenticated: true });

async function* replay(list: Array<Record<string, unknown>>): AsyncGenerator<Record<string, unknown>> {
  for (const event of list) yield event;
}

/** An engine whose sessions replay `stream`, recording each invocation. */
async function engineWith(
  stream: (invocation: CursorInvocation) => AsyncIterable<Record<string, unknown>>,
  options: { readStatus?: () => Promise<string> } = {},
) {
  const root = await tmpDir("cursor-engine-");
  const seen: CursorInvocation[] = [];
  const execFn: CursorExec = (invocation) => {
    seen.push(invocation);
    return stream(invocation);
  };
  const engine = new CursorEngine({
    scratchRoot: path.join(root, "scratch"),
    protectedPaths: [path.join(root, "secrets"), path.join(root, "engine-homes")],
    execFn,
    resolveCli: ready,
    readStatus: options.readStatus ?? signedIn,
    listModels: () => fixture("cursor-models-written-2026.10.22.txt"),
  });
  return { engine, seen, root };
}

async function game(): Promise<string> {
  const dir = await tmpDir("cursor-game-");
  await writeFile(path.join(dir, "main.js"), "export const x = 1;\n");
  return realpath(dir);
}

describe("Cursor's model list and sign-in", () => {
  it("reads `cursor-agent models`: each id and name in order, its default marked, names with brackets kept", async () => {
    const rows = parseCursorModels(await fixture("cursor-models-written-2026.10.22.txt"));
    assert.deepEqual(
      rows.map((row) => [row.id, row.label]),
      [
        ["auto", "Auto"],
        ["composer-2.5", "Composer 2.5"],
        ["composer-2.5-fast", "Composer 2.5 (Fast)"],
        ["grok-4.7", "Grok 4.7"],
        ["grok-4.7-fast", "Grok 4.7 (Fast)"],
        ["claude-opus-5-5", "Claude Opus 5.5"],
        ["gpt-5.6-sol", "GPT-5.6 Sol"],
      ],
    );
    assert.deepEqual(
      rows.filter((row) => row.providerDefault).map((row) => row.id),
      ["auto"],
      "the model the account runs when none is named",
    );
    assert.ok(
      rows.every((row) => row.supportsTools && row.contextSource === "unknown"),
      "the list names no context",
    );
  });

  it("reads colour codes past, an empty account as no models, and refuses anything that is no list", () => {
    assert.deepEqual(
      parseCursorModels(
        "\u001b[2mAvailable models\u001b[22m\n\n\u001b[32mauto\u001b[39m \u001b[2m- Auto\u001b[22m\n",
      ).map((row) => row.id),
      ["auto"],
    );
    assert.deepEqual(parseCursorModels("No models available for this account.\n"), []);
    assert.throws(() => parseCursorModels("Error: something broke\n"), /could not be read/);
  });

  it("reads the sign-in from the status's typed field, recorded signed out", async () => {
    assert.deepEqual(parseCursorStatus(await fixture("cursor-status-signed-out-2026.10.22.json")), { signedIn: false });
    assert.deepEqual(parseCursorStatus(await signedIn()), { signedIn: true });
    assert.throws(() => parseCursorStatus("Not logged in\n"), /could not be read/);
    assert.throws(() => parseCursorStatus(JSON.stringify({ message: "Logged in" })), /could not be read/);
  });

  it("is not installed, signed out, or ready with its models, and asks the CLI again only after a sign-in", async () => {
    const missing = new CursorEngine({ resolveCli: async () => ({ ready: false, detail: "missing" }) });
    assert.equal((await missing.status()).code, EngineStatusCode.NotInstalled);
    let asked = 0;
    let answer = await fixture("cursor-status-signed-out-2026.10.22.json");
    const engine = new CursorEngine({
      resolveCli: ready,
      readStatus: async () => {
        asked++;
        return answer;
      },
      listModels: () => fixture("cursor-models-written-2026.10.22.txt"),
    });
    assert.equal((await engine.status()).code, EngineStatusCode.NeedsLogin);
    assert.equal((await engine.account()).source, LoginSource.None);
    assert.equal(asked, 1, "a fresh answer serves the next look");
    answer = await signedIn();
    await engine.refreshModels(true);
    const status = await engine.status();
    assert.equal(status.code, EngineStatusCode.Ready);
    assert.match(status.detail, /Cursor 2026\.10\.22-27dcf5f, 7 model/);
    assert.equal((await engine.account()).source, LoginSource.System, "Cursor's own sign-in, which Genex never reads");
    assert.equal(asked, 2);
  });
});

describe("Cursor's status when the CLI cannot say", () => {
  it("is an error, never a throw or a sign-in, when the sign-in check or the model list fails", async () => {
    const unreadable = new CursorEngine({ resolveCli: ready, readStatus: async () => "Error: socket hang up" });
    const checked = await unreadable.status();
    assert.equal(checked.code, EngineStatusCode.Error);
    assert.match(checked.detail, /sign-in status could not be read/);
    assert.equal((await unreadable.account()).source, LoginSource.None);
    const listing = new CursorEngine({
      resolveCli: ready,
      readStatus: signedIn,
      listModels: async () => "Failed to load models: fetch failed",
    });
    const listed = await listing.status();
    assert.equal(listed.code, EngineStatusCode.Error, "a list that cannot be read is no sign-in problem");
    assert.match(listed.detail, /model list could not be read/);
  });
});

describe("Cursor's command line and sandbox", () => {
  it("prints one JSON event per line, trusts its folder, allows every call inside the box, and never updates itself", () => {
    const argv = cursorSessionArgv({
      access: CursorAccess.Build,
      workspace: "/games/pong",
      model: "grok-4.7",
      resume: "s1",
    });
    for (const option of [
      "--print",
      "--stream-partial-output",
      "--trust",
      "--force",
      "--disable-auto-update",
      "--single-turn",
    ])
      assert.ok(argv.includes(option), option);
    assert.deepEqual(argv.slice(argv.indexOf("--output-format"), argv.indexOf("--output-format") + 2), [
      "--output-format",
      "stream-json",
    ]);
    assert.deepEqual(argv.slice(argv.indexOf("--sandbox"), argv.indexOf("--sandbox") + 2), ["--sandbox", "disabled"]);
    assert.deepEqual(argv.slice(-4), ["--model", "grok-4.7", "--resume", "s1"]);
    assert.ok(!argv.includes("--mode"), "a build runs in Cursor's agent mode");
    const answer = cursorSessionArgv({ access: CursorAccess.Answer, workspace: "/tmp/a" });
    assert.deepEqual(answer.slice(answer.indexOf("--mode"), answer.indexOf("--mode") + 2), ["--mode", "ask"]);
    assert.ok(!answer.includes("--model") && !answer.includes("--resume"), "no pick: Cursor's own default");
  });

  it("keeps the sign-in in its file, opens no browser, and names Cursor's folders whoever the sandbox runs it as", () => {
    const at = (...parts: string[]) => path.resolve(path.sep, ...parts);
    const env = cursorSessionEnv({ compileCache: at("scratch", "cc") }, { APPDATA: at("roaming") }, at("Users", "me"));
    assert.equal(env.AGENT_CLI_CREDENTIAL_STORE, "file");
    assert.equal(env.NO_OPEN_BROWSER, "1");
    assert.equal(env.NODE_USE_ENV_PROXY, "1");
    assert.equal(env.NODE_COMPILE_CACHE, at("scratch", "cc"));
    assert.equal(env.CURSOR_CONFIG_DIR, at("Users", "me", ".cursor"));
    assert.equal(env.CURSOR_DATA_DIR, at("Users", "me", ".cursor"));
    assert.equal(env.APPDATA, at("roaming"));
    const relative = cursorSessionEnv(
      { compileCache: "cc" },
      { CURSOR_DATA_DIR: "rel", XDG_CONFIG_HOME: "x" },
      at("h"),
    );
    assert.equal(relative.CURSOR_DATA_DIR, at("h", ".cursor"), "a relative folder is never followed");
    assert.equal(relative.XDG_CONFIG_HOME, undefined);
  });

  it("finds Cursor's settings, chats and sign-in file per platform, never a relative folder", () => {
    const at = (...parts: string[]) => path.resolve(path.sep, ...parts);
    const home = at("Users", "me");
    assert.deepEqual(cursorHomes({}, home, "darwin"), [at("Users", "me", ".cursor")]);
    assert.deepEqual(cursorHomes({}, home, "linux"), [
      at("Users", "me", ".cursor"),
      at("Users", "me", ".config", "cursor"),
    ]);
    assert.deepEqual(cursorHomes({}, home, "win32"), [
      at("Users", "me", ".cursor"),
      at("Users", "me", "AppData", "Roaming", "Cursor"),
    ]);
    assert.deepEqual(
      cursorHomes(
        { CURSOR_CONFIG_DIR: at("cfg"), CURSOR_DATA_DIR: "data", XDG_CONFIG_HOME: at("xdg"), APPDATA: "r" },
        home,
        "win32",
      ),
      [at("Users", "me", ".cursor"), at("cfg"), at("xdg", "cursor"), at("Users", "me", "AppData", "Roaming", "Cursor")],
    );
  });
});

describe("a Cursor session", () => {
  it("streams the reply, mirrors every tool call, and ends with its summary, session and tokens", async () => {
    const { engine, seen, root } = await engineWith(async function* () {
      yield* replay(await events("cursor-run-written-2026.10.22.jsonl"));
    });
    const cwd = await game();
    const mirrored: DelegateEvent[] = [];
    const result = await engine.delegate({
      cwd,
      prompt: "Make the paddle faster.",
      model: "grok-4.7",
      onEvent: (event) => mirrored.push(event),
    });
    assert.equal(result.ok, true);
    assert.equal(result.engine, "cursor");
    assert.equal(result.billing, "subscription", "Cursor's own models run on the person's plan");
    assert.equal(
      result.summary,
      "The paddle now moves at 7 instead of 4.",
      "the last stretch, not every stretch run together",
    );
    assert.equal(result.sessionId, "3c1d0a52-6a7e-4b1f-9a55-0f6f2e1a9b10");
    assert.deepEqual(
      [
        result.usage.input_tokens,
        result.usage.output_tokens,
        result.usage.cache_read_tokens,
        result.usage.cache_write_tokens,
      ],
      [1200, 240, 8000, 300],
    );
    const deltas = mirrored.filter((event) => event.type === "text_delta").map((event) => event.payload);
    assert.deepEqual(deltas, [
      { streamId: "stretch-0", delta: "I'll read " },
      { streamId: "stretch-0", delta: "the game first." },
      { streamId: "stretch-1", delta: "The paddle now moves " },
      { streamId: "stretch-1", delta: "at 7 instead of 4." },
    ]);
    const uses = mirrored
      .filter((event) => event.type === "assistant")
      .flatMap((event) => (event.payload as { parts: Array<{ type: string; name?: string; text?: string }> }).parts);
    assert.deepEqual(
      uses.filter((part) => part.type === "tool_use").map((part) => part.name),
      ["Read", "Edit", "mcp__studio__checkpoint", "Bash"],
      "a bridge command reads as the studio tool it is",
    );
    assert.ok(uses.some((part) => part.type === "thinking" && part.text === "The paddle speed lives in src/main.js."));
    const results = mirrored
      .filter((event) => event.type === "user")
      .flatMap((event) => (event.payload as { parts: Array<{ is_error: boolean; content: string }> }).parts);
    assert.deepEqual(
      results.map((part) => part.is_error),
      [false, false, false, true],
    );
    assert.match(results[3]?.content ?? "", /exit 1\nnpm error Missing script/);
    assert.ok(
      mirrored.some((event) => event.type === "system" && (event.payload as { model?: string }).model === "Grok 4.7"),
    );

    const [invocation] = seen;
    assert.ok(invocation);
    assert.ok(!invocation.argv.includes("Make the paddle faster."), "the brief never rides argv");
    assert.match(invocation.prompt, /^Make the paddle faster\./);
    assert.match(invocation.prompt, /OFF LIMITS/);
    assert.equal(invocation.cwd, cwd);
    assert.deepEqual(
      invocation.argv.slice(invocation.argv.indexOf("--workspace"), invocation.argv.indexOf("--workspace") + 2),
      ["--workspace", cwd],
    );
    assert.ok(invocation.domains.includes("*.cursor.sh"));
    assert.ok(invocation.sandbox.writableRoots.includes(cwd));
    assert.deepEqual(invocation.sandbox.ownHome, cursorHomes(), "Cursor's own folders, in this sandbox alone");
    assert.deepEqual(invocation.sandbox.denyWrite, [path.join(cwd, ".cursor")]);
    assert.ok(invocation.sandbox.secretPaths.includes(path.join(root, "secrets")));
  });

  it("plans from a scratch folder, plays blind without the game, and resumes the session it is given", async () => {
    const { engine, seen } = await engineWith(async function* () {
      yield* replay(await events("cursor-run-written-2026.10.22.jsonl"));
    });
    const cwd = await game();
    const asks = { allow: [], directories: [], protectWrites: [], ask: async () => ({ decision: "deny" }) as never };
    await engine.delegate({
      cwd,
      prompt: "Plan it",
      resume: "s-1",
      permissions: { ...asks, mode: PermissionMode.Plan },
    });
    await engine.delegate({ cwd, prompt: "Play it", blind: true, readOnly: true });
    const [plan, blind] = seen;
    assert.ok(plan && blind);
    assert.notEqual(plan.cwd, cwd, "Plan runs from a folder of its own");
    assert.ok(!plan.sandbox.writableRoots.includes(cwd), "and cannot change the game");
    assert.match(plan.prompt, /PLAN MODE/);
    assert.deepEqual(plan.argv.slice(-2), ["--resume", "s-1"]);
    assert.ok(blind.sandbox.secretPaths.includes(cwd), "a blind judge reads none of the build");
    assert.match(blind.prompt, /YOU JUDGE BY PLAYING/);
  });

  it("answers a judge in Cursor's ask mode from an empty folder, with the critic's rules", async () => {
    const { engine, seen } = await engineWith(async function* () {
      yield* replay(await events("cursor-run-written-2026.10.22.jsonl"));
    });
    const answer = await engine.complete({ messages: [{ role: "user", content: "Is it fun?" }], model: "auto" });
    assert.equal(answer.message.content, "I'll read the game first.The paddle now moves at 7 instead of 4.");
    const [invocation] = seen;
    assert.ok(invocation?.argv.includes("ask"));
    assert.match(invocation?.prompt ?? "", /Answer only from what is written/);
    await assert.rejects(
      engine.complete({
        messages: [{ role: "user", content: "x" }],
        tools: [{ name: "t", description: "", parameters: {} }],
      }),
      (err: unknown) => err instanceof EngineError && err.kind === EngineFailureKind.Unavailable,
    );
  });

  it("refuses Compact now: Cursor compacts its own sessions", async () => {
    const { engine } = await engineWith(async function* () {});
    await assert.rejects(
      engine.delegate({ cwd: await game(), prompt: "", compact: true, resume: "s" }),
      (err: unknown) => err instanceof EngineError && err.kind === EngineFailureKind.Unavailable,
    );
  });
});

describe("a Cursor turn that fails", () => {
  it("names the failure by the Connect code the CLI printed, never by its words", async () => {
    assert.equal(connectFailure(await fixture("cursor-usage-limit-written-2026.10.22.txt")), EngineFailureKind.UsageLimit);
    assert.equal(connectFailure("ConnectError: [unauthenticated] token expired"), EngineFailureKind.Auth);
    assert.equal(connectFailure("ConnectError: [unavailable] upstream"), EngineFailureKind.Unavailable);
    assert.equal(connectFailure("ConnectError: [permission_denied] not on your plan"), null);
    assert.equal(connectFailure("You've hit your usage limit"), null, "words alone decide nothing");
    const said = await fixture("cursor-usage-limit-written-2026.10.22.txt");
    const { engine } = await engineWith(async function* () {
      yield* replay((await events("cursor-run-written-2026.10.22.jsonl")).slice(0, 2));
      throw new CursorExit(1, said, true);
    });
    await assert.rejects(
      engine.delegate({ cwd: await game(), prompt: "go" }),
      (err: unknown) => err instanceof EngineError && err.kind === EngineFailureKind.UsageLimit,
    );
  });

  it("is a sign-in failure when the CLI stopped before its session and says no account is signed in", async () => {
    const said = await fixture("cursor-print-signed-out-2026.10.22.txt");
    let status = await signedIn();
    const { engine } = await engineWith(
      async function* () {
        yield* replay([]);
        throw new CursorExit(1, said, false);
      },
      { readStatus: async () => status },
    );
    status = await fixture("cursor-status-signed-out-2026.10.22.json");
    await assert.rejects(
      engine.delegate({ cwd: await game(), prompt: "go" }),
      (err: unknown) => err instanceof EngineError && err.kind === EngineFailureKind.Auth,
    );
  });

  it("reports any other ending as the CLI's words, keeping the session to continue", async () => {
    const { engine } = await engineWith(async function* () {
      yield* replay((await events("cursor-run-written-2026.10.22.jsonl")).slice(0, 1));
      throw new CursorExit(1, "Error: Cannot use this model: nope. Available models: auto", true);
    });
    const result = await engine.delegate({ cwd: await game(), prompt: "go", model: "nope" });
    assert.equal(result.ok, false);
    assert.equal(result.stopReason, StopReason.Error);
    assert.match(result.errorText ?? "", /Cannot use this model: nope/);
    assert.equal(result.sessionId, "3c1d0a52-6a7e-4b1f-9a55-0f6f2e1a9b10");
  });

  it("ends as stopped when the person stops it", async () => {
    const controller = new AbortController();
    const { engine } = await engineWith(async function* (invocation) {
      yield* replay((await events("cursor-run-written-2026.10.22.jsonl")).slice(0, 1));
      controller.abort();
      await setImmediate();
      invocation.signal.throwIfAborted();
    });
    const result = await engine.delegate({ cwd: await game(), prompt: "go", signal: controller.signal });
    assert.equal(result.stopReason, StopReason.Stopped);
  });
});

/** A clock the test holds: every wait is kept, and the test runs the one it means. */
function heldClock() {
  const waits: Array<{ ms: number; run: () => void; cancelled: boolean }> = [];
  const schedule: CursorSchedule = (run, ms) => {
    const wait = { ms, run, cancelled: false };
    waits.push(wait);
    return () => {
      wait.cancelled = true;
    };
  };
  const fire = (ms: number) => {
    const wait = waits.findLast((candidate) => candidate.ms === ms && !candidate.cancelled);
    assert.ok(wait, `a wait of ${ms} ms is pending`);
    wait.cancelled = true;
    wait.run();
  };
  return { schedule, fire, pending: () => waits.filter((wait) => !wait.cancelled).map((wait) => wait.ms) };
}

/** A stand-in CLI: Node running `source`, in a sandbox that is off, its process group its own. */
async function standIn(source: string) {
  const root = await tmpDir("cursor-cli-");
  const cli = path.join(root, "cli.cjs");
  await writeFile(cli, source);
  const sandbox = await ProcessSandbox.create({
    writableRoots: [root],
    scratchDir: path.join(root, "scratch"),
    secretPaths: [],
    enabled: false,
  });
  const invocation = {
    argv: [cli],
    cwd: root,
    prompt: "go",
    env: {},
    signal: new AbortController().signal,
    domains: [],
  };
  return { sandbox, invocation };
}

describe("a Cursor turn's watch", { skip: os.platform() === "win32" && "process groups are POSIX's" }, () => {
  it("stops a CLI that prints nothing for too long, and says it stalled", async () => {
    const { sandbox, invocation } = await standIn("setInterval(() => {}, 1000);\n");
    const clock = heldClock();
    try {
      const reading = (async () => {
        for await (const _event of cursorEvents(sandbox, process.execPath, invocation, clock.schedule));
      })();
      await setImmediate();
      assert.deepEqual(clock.pending(), [CURSOR_STALL_MS]);
      clock.fire(CURSOR_STALL_MS);
      await assert.rejects(
        reading,
        (err: unknown) => err instanceof CursorStall && /printed nothing for 10 min/.test(err.message),
      );
    } finally {
      await sandbox.dispose();
    }
  });

  it("stops a CLI that keeps running after its result, and keeps the turn", async () => {
    const result = JSON.stringify({ type: "result", subtype: "success", result: "done", session_id: "s" });
    const { sandbox, invocation } = await standIn(
      `process.stdout.write(${JSON.stringify(`${result}\n`)});\nsetInterval(() => {}, 1000);\n`,
    );
    const clock = heldClock();
    const seen: Array<Record<string, unknown>> = [];
    try {
      const reading = (async () => {
        for await (const event of cursorEvents(sandbox, process.execPath, invocation, clock.schedule)) seen.push(event);
      })();
      while (!seen.length) await setImmediate();
      assert.ok(clock.pending().includes(CURSOR_RESULT_EXIT_MS));
      clock.fire(CURSOR_RESULT_EXIT_MS);
      await reading;
      assert.deepEqual(
        seen.map((event) => event.type),
        ["result"],
      );
    } finally {
      await sandbox.dispose();
    }
  });

  it("explains an exit without a result by what the CLI said on stderr", async () => {
    const said = (await fixture("cursor-print-signed-out-2026.10.22.txt")).trim();
    const { sandbox, invocation } = await standIn(
      `process.stderr.write(${JSON.stringify(said)}); process.exitCode = 1;\n`,
    );
    try {
      await assert.rejects(
        (async () => {
          for await (const _event of cursorEvents(sandbox, process.execPath, invocation, heldClock().schedule));
        })(),
        (err: unknown) => err instanceof CursorExit && err.code === 1 && !err.started && err.message === said,
      );
    } finally {
      await sandbox.dispose();
    }
  });
});
