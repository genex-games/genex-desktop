/**
 * Antigravity: a delegated harness the studio runs inside its own sandbox (`agy acp`).
 *
 * Recorded from Antigravity CLI 1.5.7 on a signed-in free plan: the handshake, a new session (its
 * models and plan), the signed-out refusal and one build turn. They are replayed by a scripted agent
 * through the engine's `startFn` seam, so the protocol, the sandbox, the session's folder and every
 * ending are exercised without the CLI, an account or the network. Written, not recorded: the
 * cancelled turn's answer, a loaded session's replayed history and Google's quota error.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import { AcpErrorCode, AcpMethod } from "../../src/substrate/engines/acp.ts";
import {
  ANTIGRAVITY_CANCEL_GRACE_MS,
  ANTIGRAVITY_EXIT_GRACE_MS,
  ANTIGRAVITY_STALL_MS,
  ANTIGRAVITY_TOOL_STALL_MS,
  AntigravityEngine,
  type AntigravityInvocation,
  type AntigravityProcess,
  type AntigravitySchedule,
  antigravityBoxEnv,
  antigravityPermission,
  antigravityPersonEnv,
  antigravityProcess,
  antigravitySandbox,
  carryOverAntigravitySignIn,
  failure,
  googleFailure,
} from "../../src/substrate/engines/antigravity.ts";
import {
  ANTIGRAVITY_HOSTS,
  ANTIGRAVITY_LOGIN_ARGV,
  ANTIGRAVITY_SESSION_ARGV,
  AntigravityNotice,
  antigravityModelId,
  antigravityNotice,
  googleSignInPage,
  parseAntigravitySession,
  verificationPage,
} from "../../src/substrate/engines/antigravity-cli.ts";
import {
  ANTIGRAVITY_SIGN_IN_FILE,
  AntigravityAppData,
  antigravityAppData,
  antigravityHome,
  antigravityHomes,
  sandboxedCliHomes,
} from "../../src/substrate/credential-homes.ts";
import { childEnv } from "../../src/substrate/child-env.ts";
import { type DelegateEvent, DelegateEventType, EngineError } from "../../src/substrate/engines/types.ts";
import { EngineStatusCode, LoginSource } from "../../src/shared/engine-descriptor.ts";
import { EngineFailureKind, StopReason } from "../../src/shared/engine-requests.ts";
import { PermissionMode, permissionModesFor } from "../../src/shared/permissions.ts";
import { EngineId, isBeta, isMetered, loginKind } from "../../src/shared/providers.ts";
import { ProcessSandbox, SandboxMachService } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures", "transcripts");
const fixture = (name: string) => readFile(path.join(FIXTURES, name), "utf8");
const json = async (name: string) => JSON.parse(await fixture(name)) as Json;

type Json = Record<string, unknown>;

/** The recorded build turn: what the agent sent after the prompt, in order, and the prompt's answer. */
async function recordedTurn(): Promise<{ sent: Json[]; answer: Json }> {
  const entries = (await fixture("antigravity-build-1.5.7.jsonl"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { dir: string; message: Json });
  const incoming = entries.filter((entry) => entry.dir === "in").map((entry) => entry.message);
  const answer = incoming.find((message) => "result" in message && !("method" in message));
  assert.ok(answer, "the recorded turn ends with the prompt's answer");
  return { sent: incoming.filter((message) => message !== answer), answer: answer.result as Json };
}

/** A scripted answer to opening a session: nothing for the recorded one, a result of its own, or a refusal. */
interface SessionAnswer {
  result?: Json | undefined;
  error?: Json;
}

/** What a scripted agent does with one message of the studio's. */
interface Script {
  /** Answer `session/new` or `session/load`; an `error` refuses it. */
  session?: (message: Json, agent: Scripted) => SessionAnswer | Promise<SessionAnswer>;
  /** Run the prompt: say things, then give its answer (or none, to stay quiet). */
  prompt?: (message: Json, agent: Scripted) => Json | null | Promise<Json | null>;
  /** The CLI keeps its output open after its input is closed: only a stop ends it. */
  lingers?: boolean;
}

/** One scripted `agy acp`: what the studio sent it, and the ways a script speaks and leaves. */
interface Scripted {
  invocation: AntigravityInvocation;
  received: Json[];
  say(message: Json): void;
  exit(code: number, stderr?: string): void;
  stopped: boolean;
}

/** An engine whose sessions are scripted agents, each recorded. */
async function engineWith(
  script: Script = {},
  options: {
    schedule?: AntigravitySchedule;
    now?: () => number;
    logDir?: string;
    /** The person's home, whose `.gemini` the engine carries a sign-in in: the test's own folder when not given. */
    home?: string;
    openPage?: (url: string) => unknown;
  } = {},
) {
  const root = await tmpDir("antigravity-engine-");
  const agents: Scripted[] = [];
  const opened = await json("antigravity-session-new-1.5.7.json");
  const handshake = await json("antigravity-initialize-1.5.7.json");
  const startFn = async (invocation: AntigravityInvocation): Promise<AntigravityProcess> => {
    const lines: string[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    let leave: (exit: { code: number | null; stderr: string }) => void = () => {};
    const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
      leave = resolve;
    });
    const close = (code: number | null, stderr = "") => {
      if (closed) return;
      closed = true;
      leave({ code, stderr });
      wake?.();
    };
    const agent: Scripted = {
      invocation,
      received: [],
      say: (message) => {
        lines.push(JSON.stringify({ jsonrpc: "2.0", ...message }));
        wake?.();
      },
      exit: close,
      stopped: false,
    };
    agents.push(agent);
    const answer = async (message: Json) => {
      const reply = (body: SessionAnswer | null) => body && agent.say({ id: message.id, ...body });
      if (message.method === AcpMethod.Initialize) return reply({ result: handshake });
      if (message.method === AcpMethod.SessionNew || message.method === AcpMethod.SessionLoad)
        return reply({ result: opened, ...(await script.session?.(message, agent)) });
      if (message.method === AcpMethod.SessionSetModel) return reply({ result: {} });
      if (message.method !== AcpMethod.SessionPrompt) return;
      const result = script.prompt ? await script.prompt(message, agent) : { stopReason: "end_turn" };
      return reply(result && { result });
    };
    return {
      send: (line) => {
        const message = JSON.parse(line) as Json;
        agent.received.push(message);
        void answer(message);
      },
      lines: (async function* read() {
        for (;;) {
          while (lines.length) yield lines.shift() as string;
          if (closed) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      })(),
      exited,
      end: () => {
        if (!script.lingers) close(0);
      },
      stop: () => {
        agent.stopped = true;
        close(null);
      },
    };
  };
  const engine = new AntigravityEngine({
    scratchRoot: path.join(root, "scratch"),
    protectedPaths: [path.join(root, "secrets"), path.join(root, "engine-homes")],
    startFn,
    resolveCli: async () => ({ ready: true, path: "/Users/me/.local/bin/agy", version: "1.5.7", detail: "ok" }),
    ...(options.schedule ? { schedule: options.schedule } : {}),
    ...(options.now ? { now: options.now } : {}),
    home: options.home ?? root,
    ...(options.logDir ? { logDir: options.logDir } : {}),
    ...(options.openPage ? { openPage: options.openPage } : {}),
  });
  return { engine, agents, root };
}

async function game(): Promise<string> {
  const dir = await tmpDir("antigravity-game-");
  await writeFile(path.join(dir, "main.js"), "export const x = 1;\n");
  return realpath(dir);
}

/** A clock the test holds: every wait is kept, and the test runs the one it means. */
function heldClock() {
  const waits: Array<{ ms: number; run: () => void; cancelled: boolean }> = [];
  const schedule: AntigravitySchedule = (run, ms) => {
    const wait = { ms, run, cancelled: false };
    waits.push(wait);
    return () => {
      wait.cancelled = true;
    };
  };
  return {
    schedule,
    pending: () => waits.filter((wait) => !wait.cancelled).map((wait) => wait.ms),
    fire(ms: number) {
      const wait = waits.find((entry) => !entry.cancelled && entry.ms === ms);
      assert.ok(wait, `a wait of ${ms} ms is pending`);
      wait.cancelled = true;
      wait.run();
    },
  };
}

/** The sandbox a scripted session was started in: every session but a Bypass build has one. */
function boxOf(invocation: AntigravityInvocation | undefined) {
  assert.ok(invocation?.sandbox, "the session is boxed");
  return invocation.sandbox;
}

const methods = (agent: Scripted | undefined) => (agent?.received ?? []).map((message) => message.method ?? "answer");
const refusal = async () => ({
  result: undefined,
  error: await json("antigravity-session-new-signed-out-1.5.7.json"),
});

describe("Antigravity's sign-in, plan and models", () => {
  it("reads a new session: the models the account can run, the one it starts on, and its plan", async () => {
    const session = parseAntigravitySession(await json("antigravity-session-new-1.5.7.json"));
    // Flipped (effort dial): the CLI lists each thinking level as a model; a model listed at
    // several is one row with the levels on its dial, and one listed at a single level stays.
    assert.deepEqual(
      session.models.map((model) => [model.id, model.label]),
      [
        ["gemini-3.8-flash", "Gemini 3.8 Flash"],
        ["claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"],
        ["claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)"],
        ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
      ],
    );
    const [flash, ...rest] = session.models;
    assert.deepEqual(flash?.efforts, ["low", "medium", "high"], "fastest first, as every dial");
    assert.equal(flash?.defaultEffort, "high", "the level the session starts on");
    assert.deepEqual(
      rest.map((model) => model.efforts),
      [undefined, undefined, undefined],
    );
    assert.deepEqual(
      session.models.filter((model) => model.providerDefault).map((model) => model.id),
      ["gemini-3.8-flash"],
    );
    assert.deepEqual(session.tier, { id: "free-tier", name: "Antigravity Starter Quota" });
    assert.throws(() => parseAntigravitySession({ models: {} }), /could not be read/);
  });

  it("gives a model its levels as a dial, and leaves alone an id that only looks like one", () => {
    const listed = (ids: string[], current = "") => ({
      sessionId: "s",
      models: { currentModelId: current, availableModels: ids.map((modelId) => ({ modelId, name: modelId })) },
    });
    const paid = parseAntigravitySession(
      listed(["gemini-4-argon-high", "gemini-4-argon-low", "gemini-4-hydrogen-xhigh", "gemini-nova"]),
    );
    assert.deepEqual(
      paid.models.map((model) => [model.id, model.efforts, model.defaultEffort]),
      [
        ["gemini-4-argon", ["low", "high"], "high"],
        ["gemini-4-hydrogen-xhigh", undefined, undefined],
        ["gemini-nova", undefined, undefined],
      ],
      "with none started on, the level Google lists first",
    );
    const taken = parseAntigravitySession(listed(["gemini-x", "gemini-x-high", "gemini-x-low"]));
    assert.equal(taken.models.length, 3, "a listed id is never given to a second row");

    const { models } = paid;
    assert.equal(antigravityModelId(models, "gemini-4-argon", "low"), "gemini-4-argon-low");
    assert.equal(antigravityModelId(models, "gemini-4-argon"), "gemini-4-argon-high", "no pick: where it starts");
    assert.equal(antigravityModelId(models, "gemini-4-argon", "max"), "gemini-4-argon-high", "a level it lacks");
    assert.equal(antigravityModelId(models, "gemini-4-argon-low", "high"), "gemini-4-argon-low", "a saved level's id");
    assert.equal(antigravityModelId(models, "gemini-nova", "high"), "gemini-nova");
    // Before anything is listed, an effort comes only with a model that has a dial.
    assert.equal(antigravityModelId([], "gemini-4-argon", "low"), "gemini-4-argon-low");
    assert.equal(antigravityModelId([], "gemini-4-argon-low", "high"), "gemini-4-argon-low");
    assert.equal(antigravityModelId([], "gemini-nova"), "gemini-nova");
  });

  it("starts a turn on the picked model at the picked effort, by the id the CLI lists", async () => {
    const { engine, agents } = await engineWith();
    const cwd = await game();
    const picked = (agent: Scripted | undefined) =>
      agent?.received.find((message) => message.method === AcpMethod.SessionSetModel)?.params;
    await engine.delegate({ cwd, prompt: "Go", model: "gemini-3.8-flash", effort: "low" });
    await engine.delegate({ cwd, prompt: "Go", model: "gemini-3.8-flash" });
    await engine.delegate({ cwd, prompt: "Go", model: "gemini-3.8-flash-medium", effort: "low" });
    // The scripted answer says nothing, which a judge's answer may not: the model was picked before it.
    await assert.rejects(
      engine.complete({ model: "gemini-3.8-flash", effort: "medium", messages: [{ role: "user", content: "?" }] }),
      /no answer/,
    );
    assert.deepEqual(
      agents.map((agent) => (picked(agent) as Json | undefined)?.modelId),
      ["gemini-3.8-flash-low", "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-medium"],
    );
  });

  it("is not installed, signed out, or ready with its plan and models, asking the CLI once until a sign-in", async () => {
    const missing = new AntigravityEngine({ resolveCli: async () => ({ ready: false, detail: "missing" }) });
    assert.equal((await missing.status()).code, EngineStatusCode.NotInstalled);
    assert.equal((await missing.account()).source, LoginSource.None);

    let signedIn = false;
    const { engine, agents } = await engineWith({ session: async () => (signedIn ? {} : refusal()) });
    assert.equal((await engine.status()).code, EngineStatusCode.NeedsLogin, "ACP's sign-in code, not its words");
    assert.deepEqual(await engine.models(), []);
    assert.equal(agents.length, 1, "the answer is kept for a minute");
    assert.deepEqual(methods(agents[0]), ["initialize", "session/new"], "a check opens a session and prompts nothing");
    assert.equal(boxOf(agents[0]?.invocation).writableRoots.includes(agents[0].invocation.cwd), true);

    signedIn = true;
    await engine.refreshModels(true);
    const status = await engine.status();
    assert.equal(status.code, EngineStatusCode.Ready);
    assert.match(status.detail ?? "", /1\.5\.7 · Antigravity Starter Quota/);
    assert.equal((await engine.models()).length, 4);
    assert.equal((await engine.account()).source, LoginSource.System);
    assert.equal(agents.length, 2, "one more check, after the sign-in");
    await assert.rejects(stat(agents[1]?.invocation.cwd ?? ""), "the check's folder is removed");
  });

  it("stays signed in while one of its own sessions runs: no check starts beside a build, whatever one would say", async () => {
    let now = 0;
    let refuse = false;
    let finish: (answer: Json) => void = () => {};
    const { engine, agents } = await engineWith(
      {
        // A check is a session that is never prompted; the build's own session opened before any refusal.
        session: async () => (refuse ? refusal() : {}),
        prompt: () =>
          new Promise<Json>((resolve) => {
            finish = resolve;
          }),
      },
      { now: () => now },
    );
    assert.equal((await engine.status()).code, EngineStatusCode.Ready);
    const prompted = () => agents.some((agent) => methods(agent).includes(AcpMethod.SessionPrompt));
    const build = engine.delegate({ cwd: await game(), prompt: "Build the loot tables" });
    while (!prompted()) await setImmediate();

    // The incident: a check beside a long build was refused, and the chat asked for a sign-in
    // while the build went on working.
    refuse = true;
    now += 23 * 60_000;
    assert.equal((await engine.status()).code, EngineStatusCode.Ready, "the open session is the sign-in's proof");
    assert.equal((await engine.account()).source, LoginSource.System);
    assert.equal((await engine.models()).length, 4);
    assert.equal(agents.length, 2, "the first check and the build: no check ran beside the build");

    finish({ stopReason: "end_turn" });
    assert.equal((await build).ok, true);
    // With no session left to vouch for it, the account is asked again, and a real sign-out shows.
    assert.equal((await engine.status()).code, EngineStatusCode.NeedsLogin);
  });

  it("asks a signed-in account twice before it reads as signed out", async () => {
    let now = 0;
    let refusals = 0;
    const { engine, agents } = await engineWith(
      { session: async () => (refusals-- > 0 ? refusal() : {}) },
      { now: () => now },
    );
    assert.equal((await engine.status()).code, EngineStatusCode.Ready);

    // The CLI answers "sign in" whenever it could not renew the sign-in, a dropped connection included.
    refusals = 1;
    now += 2 * 60_000;
    assert.equal((await engine.status()).code, EngineStatusCode.Ready, "one refusal is asked again");
    assert.equal((await engine.models()).length, 4, "the models stay listed through it");
    assert.equal(agents.length, 3);

    refusals = 2;
    now += 2 * 60_000;
    assert.equal((await engine.status()).code, EngineStatusCode.NeedsLogin, "two in a row are a sign-out");
    assert.equal(agents.length, 5);

    // Signed out is believed at once: nothing is asked twice to say so again.
    refusals = 1;
    now += 2 * 60_000;
    assert.equal((await engine.status()).code, EngineStatusCode.NeedsLogin);
    assert.equal(agents.length, 6);
  });

  it("is a provider the person picks: Beta, its own sign-in, Auto and Plan, never the app's own choice", () => {
    assert.equal(isBeta(EngineId.Antigravity), true);
    assert.equal(isMetered(EngineId.Antigravity), true);
    assert.equal(loginKind(EngineId.Antigravity), "cli");
    // Flipped (Bypass): a chat the person set to Bypass runs Antigravity as them, as Codex and Grok Build do.
    assert.deepEqual(permissionModesFor(EngineId.Antigravity), [
      PermissionMode.Auto,
      PermissionMode.Plan,
      PermissionMode.Bypass,
    ]);
  });
});

describe("an Antigravity build", () => {
  it("runs the recorded turn: allows each tool, mirrors it, and reports the summary, session and tokens", async () => {
    const turn = await recordedTurn();
    const { engine, agents } = await engineWith({
      prompt: async (_message, agent) => {
        for (const message of turn.sent) agent.say(message);
        return turn.answer;
      },
    });
    const cwd = await game();
    const mirrored: DelegateEvent[] = [];
    const result = await engine.delegate({
      cwd,
      prompt: "Create hello.txt",
      model: "gemini-3.8-flash-low",
      onEvent: (event) => mirrored.push(event),
    });
    assert.equal(result.ok, true);
    assert.equal(result.stopReason, StopReason.Completed);
    assert.equal(result.engine, "antigravity");
    assert.equal(result.billing, "subscription", "the plan's quota, never a bill");
    assert.match(result.summary, /^I have created \[hello\.txt\]/);
    assert.equal(result.sessionId, "4342cc8c-a27e-4ee8-b004-6528881493bb");
    assert.equal(result.turns, 3);
    assert.deepEqual(
      [result.usage.input_tokens, result.usage.output_tokens, result.usage.reasoning_tokens],
      [28973, 453, 331],
    );
    const [agent] = agents;
    assert.ok(agent);
    assert.deepEqual(methods(agent), [
      "initialize",
      "session/new",
      "session/set_model",
      "session/prompt",
      "answer",
      "answer",
    ]);
    const allowed = agent.received.filter((message) => !message.method).map((message) => message.result);
    assert.deepEqual(allowed, [
      { outcome: { outcome: "selected", optionId: "allow" } },
      { outcome: { outcome: "selected", optionId: "allow" } },
    ]);
    const asked = agent.received.find((message) => message.method === AcpMethod.SessionNew)?.params as Json;
    assert.equal(asked.cwd, cwd, "the session works in the game");
    const kinds = mirrored.map((event) => event.type);
    assert.equal(kinds[0], DelegateEventType.System, "the session's id first, for a resume");
    assert.ok(kinds.includes(DelegateEventType.TextDelta), "the reply streams");
    assert.equal(kinds.filter((kind) => kind === DelegateEventType.User).length, 2, "two tool results");
    assert.equal(agent.stopped, true, "nothing is left running");
  });

  it("starts `agy acp` in the game, boxed: only the game and Antigravity's own folders, Google's hosts", async () => {
    const { engine, agents, root } = await engineWith();
    const cwd = await game();
    // Linux denies only settings that are there: a deny on a missing path leaves a stand-in file.
    await mkdir(path.join(cwd, ".agents"));
    await engine.delegate({ cwd, prompt: "go", denyReads: ["/Users/me/private"] });
    const invocation = agents[0]?.invocation;
    assert.ok(invocation);
    // Flipped (#870): Genex's own app data folder, never the CLI's default one.
    assert.deepEqual(invocation.argv, ["acp", "--app-data-dir", "antigravity-genex"]);
    assert.equal(invocation.cwd, cwd);
    assert.deepEqual(invocation.domains, [...ANTIGRAVITY_HOSTS]);
    assert.ok(boxOf(invocation).writableRoots.includes(cwd));
    assert.deepEqual(boxOf(invocation).ownHome, antigravityHomes());
    assert.deepEqual(boxOf(invocation).denyWrite, [path.join(cwd, ".agents")]);
    for (const secret of [path.join(root, "secrets"), path.join(root, "engine-homes"), "/Users/me/private"])
      assert.ok(boxOf(invocation).secretPaths.includes(secret), secret);
  });

  it("Bypass runs a build as the person, unboxed, its commands still screened; its reviewer stays boxed", async () => {
    const { engine, agents } = await engineWith();
    const cwd = await game();
    const bypass = { mode: PermissionMode.Bypass, ask: async () => ({ allow: true }) };
    await engine.delegate({ cwd, prompt: "go", permissions: bypass as never });
    await engine.delegate({ cwd, prompt: "Look", permissions: bypass as never, readOnly: true });
    assert.equal(agents[0]?.invocation.sandbox, null, "the build runs as the person");
    assert.equal(agents[0]?.invocation.cwd, cwd);
    assert.ok(boxOf(agents[1]?.invocation), "a read-only session of that chat keeps the box");
    const keychain = await engineWith({
      prompt: async (message, agent) => {
        agent.say({
          id: "ask-1",
          method: AcpMethod.RequestPermission,
          params: {
            sessionId: (message.params as Json).sessionId,
            toolCall: { kind: "execute", rawInput: { CommandLine: "security find-generic-password -s x -w" } },
            options: [
              { optionId: "allow", kind: "allow_once" },
              { optionId: "deny", kind: "reject_once" },
            ],
          },
        });
        while (!agent.received.some((sent) => sent.id === "ask-1")) await setImmediate();
        return { stopReason: "end_turn" };
      },
    });
    await keychain.engine.delegate({ cwd, prompt: "go", permissions: bypass as never });
    const answer = keychain.agents[0]?.received.find((sent) => sent.id === "ask-1");
    assert.deepEqual(answer?.result, { outcome: { outcome: "selected", optionId: "deny" } });
  });

  it("Plan and a read-only session run from a folder of their own, removed after, and only read the game", async () => {
    const { engine, agents } = await engineWith();
    const cwd = await game();
    const asks = { mode: PermissionMode.Plan, ask: async () => ({ allow: true }) };
    await engine.delegate({ cwd, prompt: "Plan it", permissions: asks as never });
    await engine.delegate({ cwd, prompt: "Review it", readOnly: true });
    for (const agent of agents) {
      assert.notEqual(agent.invocation.cwd, cwd);
      assert.ok(!boxOf(agent.invocation).writableRoots.includes(cwd), "the game is not its to change");
      await assert.rejects(stat(agent.invocation.cwd), "its folder is removed");
    }
    const prompt = agents[0]?.received.find((message) => message.method === AcpMethod.SessionPrompt)?.params as Json;
    assert.match(JSON.stringify(prompt.prompt), /PLAN MODE/);
  });

  it("continues an earlier session by loading it, and does not mirror the history it replays", async () => {
    const { engine, agents } = await engineWith({
      session: (message, agent) => {
        agent.say({
          method: AcpMethod.SessionUpdate,
          params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old words" } } },
        });
        return { result: { sessionId: (message.params as Json).sessionId } };
      },
      prompt: (_message, agent) => {
        agent.say({
          method: AcpMethod.SessionUpdate,
          params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "new words" } } },
        });
        return { stopReason: "end_turn" };
      },
    });
    const result = await engine.delegate({ cwd: await game(), prompt: "And then?", resume: "s-1" });
    assert.deepEqual(methods(agents[0]).slice(0, 3), ["initialize", "session/load", "session/prompt"]);
    assert.equal(result.summary, "new words");
    assert.equal(result.sessionId, "s-1");
  });

  it("a session the CLI will not load is a lost one, which the chat starts afresh; a sign-in stays a sign-in", async () => {
    // A chat from before Genex's own folder (#870): its session is saved in the CLI's default one.
    const { engine } = await engineWith({
      session: () => ({ error: { code: AcpErrorCode.Internal, message: "conversation s-1 does not exist" } }),
    });
    const result = await engine.delegate({ cwd: await game(), prompt: "And then?", resume: "s-1" });
    assert.equal(result.ok, false);
    assert.match(result.errorText ?? "", /session not found/i, "the words the chat knows a lost session by");
    assert.match(result.errorText ?? "", /conversation s-1 does not exist/, "with the CLI's own");
    const signedOut = await engineWith({ session: () => refusal() });
    await assert.rejects(
      signedOut.engine.delegate({ cwd: await game(), prompt: "And then?", resume: "s-1" }),
      (err: unknown) => err instanceof EngineError && err.kind === EngineFailureKind.Auth,
    );
    const fresh = await engineWith({
      session: () => ({ error: { code: AcpErrorCode.Internal, message: "no backend" } }),
    });
    const failed = await fresh.engine.delegate({ cwd: await game(), prompt: "go" });
    assert.doesNotMatch(failed.errorText ?? "", /session not found/i, "a new session's failure is not a lost one");
  });

  it("a loaded session whose answer repeats no id keeps the id it was loaded by", async () => {
    // ACP's `session/load` answer carries no session id: only `session/new` gives one.
    const { engine, agents } = await engineWith({ session: () => ({ result: {} }) });
    const result = await engine.delegate({ cwd: await game(), prompt: "And then?", resume: "s-1" });
    assert.equal(result.stopReason, StopReason.Completed);
    assert.equal(result.sessionId, "s-1");
    const prompts = (agents[0]?.received ?? []).filter((message) => message.method === AcpMethod.SessionPrompt);
    assert.deepEqual(
      prompts.map((message) => (message.params as Json).sessionId),
      ["s-1"],
    );
  });

  it("sends the prompt's pictures as pictures, and a judge's question from an empty folder with no tools", async () => {
    const { engine, agents } = await engineWith({
      prompt: (_message, agent) => {
        agent.say({
          method: AcpMethod.SessionUpdate,
          params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "It is fun." } } },
        });
        return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 4 } };
      },
    });
    const cwd = await game();
    await engine.delegate({ cwd, prompt: "Look", images: [{ label: "shot", mimeType: "image/png", data: "aGk=" }] });
    const sent = agents[0]?.received.find((message) => message.method === AcpMethod.SessionPrompt)?.params as Json;
    assert.deepEqual((sent.prompt as Json[])[1], { type: "image", mimeType: "image/png", data: "aGk=" });

    const answer = await engine.complete({ messages: [{ role: "user", content: "Is it fun?" }] });
    assert.equal(answer.message.content, "It is fun.");
    assert.equal(answer.usage.output_tokens, 4);
    assert.notEqual(agents[1]?.invocation.cwd, cwd);
    await assert.rejects(
      engine.complete({ messages: [], tools: [{ name: "x", description: "", parameters: {} }] as never }),
      (err: unknown) => err instanceof EngineError && err.kind === EngineFailureKind.Unavailable,
    );
    await assert.rejects(
      engine.delegate({ cwd, prompt: "", compact: true, resume: "s" }),
      (err: unknown) => err instanceof EngineError && err.kind === EngineFailureKind.Unavailable,
    );
  });
});

describe("an Antigravity turn that stops or fails", () => {
  it("Stop cancels the turn in the protocol, waits for its answer, and reports the work so far", async () => {
    const clock = heldClock();
    const stop = new AbortController();
    let finish: (answer: Json) => void = () => {};
    const { engine, agents } = await engineWith(
      {
        prompt: (_message, agent) => {
          agent.say({
            method: AcpMethod.SessionUpdate,
            params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Half" } } },
          });
          return new Promise<Json>((resolve) => {
            finish = resolve;
          });
        },
      },
      { schedule: clock.schedule },
    );
    const running = engine.delegate({ cwd: await game(), prompt: "go", signal: stop.signal });
    while (!agents[0]?.received.some((message) => message.method === AcpMethod.SessionPrompt)) await setImmediate();
    await setImmediate();
    stop.abort();
    assert.equal(agents[0]?.received.at(-1)?.method, AcpMethod.SessionCancel);
    assert.ok(clock.pending().includes(ANTIGRAVITY_CANCEL_GRACE_MS), "the CLI is stopped if it never answers");
    finish({ stopReason: "cancelled" });
    const result = await running;
    assert.equal(result.ok, false);
    assert.equal(result.stopReason, StopReason.Stopped);
    assert.equal(result.summary, "Half");
  });

  it("a turn that says nothing is stopped: after ten minutes, or thirty while a tool call is open", async () => {
    const clock = heldClock();
    const { engine, agents } = await engineWith(
      {
        prompt: (_message, agent) => {
          agent.say({
            method: AcpMethod.SessionUpdate,
            params: {
              update: { sessionUpdate: "tool_call", toolCallId: "c1", name: "run_command", status: "in_progress" },
            },
          });
          return null;
        },
      },
      { schedule: clock.schedule },
    );
    const running = engine.delegate({ cwd: await game(), prompt: "go" });
    while (!clock.pending().includes(ANTIGRAVITY_TOOL_STALL_MS)) await setImmediate();
    assert.ok(!clock.pending().includes(ANTIGRAVITY_STALL_MS), "one watch at a time");
    clock.fire(ANTIGRAVITY_TOOL_STALL_MS);
    const result = await running;
    assert.equal(agents[0]?.stopped, true);
    assert.equal(result.stopReason, StopReason.Error);
    assert.match(result.errorText ?? "", /said nothing for 30 min/);
  });

  it("a sign-in during a check is not answered by that check, and a check that failed is not repeated at once", async () => {
    let signedIn = false;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let now = 0;
    const { engine, agents } = await engineWith(
      {
        session: async () => {
          if (signedIn) return {};
          await held;
          return refusal();
        },
      },
      { now: () => now },
    );
    const before = engine.status();
    while (!methods(agents[0]).includes(AcpMethod.SessionNew)) await setImmediate();
    signedIn = true;
    const after = engine.refreshModels(true);
    release();
    assert.equal((await before).code, EngineStatusCode.NeedsLogin, "the check that started signed out");
    await after;
    assert.equal((await engine.status()).code, EngineStatusCode.Ready, "its answer did not replace the sign-in's");
    assert.equal(agents.length, 2);

    const offline = await engineWith(
      { session: () => ({ result: undefined, error: { code: AcpErrorCode.Internal, message: "no network" } }) },
      { now: () => now },
    );
    await assert.rejects(offline.engine.refreshModels());
    await assert.rejects(offline.engine.refreshModels());
    assert.equal(offline.agents.length, 1, "the failure stands for a while");
    now += 20_000;
    await assert.rejects(offline.engine.refreshModels());
    assert.equal(offline.agents.length, 2, "then the CLI is asked again");
    await assert.rejects(offline.engine.refreshModels(true));
    assert.equal(offline.agents.length, 3, "and a sign-in asks at once");
  });

  it("a CLI that keeps its output open after the turn is stopped, so the turn still ends", async () => {
    const clock = heldClock();
    const { engine, agents } = await engineWith({ lingers: true }, { schedule: clock.schedule });
    const turn = engine.delegate({ cwd: await game(), prompt: "go" });
    while (!clock.pending().includes(ANTIGRAVITY_EXIT_GRACE_MS)) await setImmediate();
    assert.equal(agents[0]?.stopped, false);
    clock.fire(ANTIGRAVITY_EXIT_GRACE_MS);
    assert.equal((await turn).stopReason, StopReason.Completed);
    assert.equal(agents[0]?.stopped, true);
  });

  it("a signed-out session is a sign-in failure, and the next status asks the CLI again", async () => {
    let signedIn = true;
    const { engine, agents } = await engineWith({ session: async () => (signedIn ? {} : refusal()) });
    assert.equal((await engine.status()).code, EngineStatusCode.Ready);
    signedIn = false;
    await assert.rejects(
      engine.delegate({ cwd: await game(), prompt: "go" }),
      (err: unknown) => err instanceof EngineError && err.kind === EngineFailureKind.Auth,
    );
    assert.equal((await engine.status()).code, EngineStatusCode.NeedsLogin);
    assert.equal(agents.length, 3, "the check, the turn, the check again");
  });

  it("names a failure by ACP's code or Google's status name, and reports any other with the CLI's own words", async () => {
    assert.equal(googleFailure("RESOURCE_EXHAUSTED: quota exceeded for the plan"), EngineFailureKind.UsageLimit);
    assert.equal(googleFailure("rpc error: code = UNAVAILABLE"), EngineFailureKind.Unavailable);
    assert.equal(googleFailure("You have run out of quota"), null, "words alone decide nothing");
    assert.equal(failure(new Error("boom")).kind, EngineFailureKind.Other);
    assert.equal(
      failure(new Error("agy exited: INTERNAL log line, UNAUTHENTICATED in a tool's output")).kind,
      EngineFailureKind.Other,
      "a CLI's log names no status",
    );

    const { engine } = await engineWith({
      prompt: (message, agent) => {
        agent.say({
          id: message.id,
          error: { code: AcpErrorCode.Internal, message: "RESOURCE_EXHAUSTED: quota exceeded" },
        });
        return null;
      },
    });
    await assert.rejects(
      engine.delegate({ cwd: await game(), prompt: "go" }),
      (err: unknown) => err instanceof EngineError && err.kind === EngineFailureKind.UsageLimit,
    );

    const gone = await engineWith({
      prompt: (_message, agent) => {
        agent.exit(1, "agy: \u001b[31mpanic\u001b[39m in the language server");
        return null;
      },
    });
    const result = await gone.engine.delegate({ cwd: await game(), prompt: "go" });
    assert.equal(result.stopReason, StopReason.Error);
    assert.equal(result.errorText, "agy: panic in the language server");
  });
});

describe("Antigravity's box", () => {
  it("allows a tool once, and refuses the keychain's tool, a command it cannot read and one with no command line", () => {
    const options = [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ];
    const answer = (toolCall: Json) =>
      ((antigravityPermission({ toolCall, options }, "/games/pong").outcome ?? {}) as Json).optionId;
    const run = (CommandLine: string) => answer({ kind: "execute", rawInput: { CommandLine } });
    assert.equal(answer({ kind: "edit", rawInput: { Path: "/games/pong/main.js" } }), "allow");
    for (const command of ["ls -la", "npm test", "node .studio/bridge/tool.mjs capture_screenshot --json '{}'"])
      assert.equal(run(command), "allow", command);
    for (const command of [
      "security find-generic-password -s anything -w",
      "/usr/bin/security dump-keychain",
      "cd /tmp && security find-generic-password -s x",
      "sh -c 'security find-generic-password -s x'",
      "echo $(security find-generic-password -s x)",
      "",
    ])
      assert.equal(run(command), "deny", command || "no command line");
    assert.equal(answer({ kind: "execute", rawInput: {} }), "deny", "a command with no command line");
    assert.deepEqual(
      antigravityPermission(
        { toolCall: { kind: "execute", rawInput: { CommandLine: "security list" } }, options: [options[0]] },
        "/games/pong",
      ),
      { outcome: { outcome: "cancelled" } },
      "with no way to refuse offered, the question is left unanswered, never allowed",
    );
  });

  it("every box keeps the sign-in in the CLI's own file, and on Windows that file is in the person's home", () => {
    const home = "C:\\Users\\Ada";
    // The CLI uses its file, not the credential store, when it believes it runs over SSH (1.5.9).
    const fileStore = { SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0", SSH_CLIENT: "127.0.0.1 0 0" };
    assert.deepEqual(
      antigravityBoxEnv("win32", home),
      { ...fileStore, USERPROFILE: home },
      "not the shared sandbox user's store",
    );
    assert.deepEqual(antigravityBoxEnv("linux", home), fileStore, "not the Secret Service");
    // Flipped (one sign-in): a Mac's box is told to use the file too, not left to fall back to it.
    assert.deepEqual(antigravityBoxEnv("darwin", home), fileStore, "the file, never a failed Keychain save first");
  });

  it("its session's sandbox keeps its own folder, where its sign-in file is, and never reaches the Keychain", async () => {
    const home = path.join(os.tmpdir(), "home");
    const keychains = path.join(home, "Library", "Keychains");
    assert.deepEqual(antigravityHomes(home), [path.join(home, ".gemini")]);
    for (const platform of ["darwin", "linux", "win32"] as const)
      assert.equal(sandboxedCliHomes({}, home, platform).includes(keychains), false, `${platform}: no sandbox's own`);
    for (const dir of antigravityHomes(home))
      assert.ok(sandboxedCliHomes({}, home, "darwin").includes(dir), "only a listed home can be a sandbox's own");
    assert.equal(antigravityHome(home), path.join(home, ".gemini"));
    const sandbox = antigravitySandbox({
      runDir: "/games/pong",
      gameDir: "/games/pong",
      gitDirs: ["/games/.git/worktrees/pong"],
      scratchDir: "/scratch/tmp",
      secretPaths: ["/studio/secrets"],
      // Linux denies only settings that are there (game-settings-sandbox.test.ts).
      platform: "darwin",
    });
    assert.deepEqual(sandbox.writableRoots, ["/games/pong", "/games/.git/worktrees/pong"]);
    assert.deepEqual(sandbox.secretPaths, ["/studio/secrets"]);
    assert.deepEqual(sandbox.ownHome, [antigravityHome()]);
    assert.deepEqual(sandbox.machServices, [SandboxMachService.Trust]);
    assert.deepEqual(sandbox.denyWrite, [path.join("/games/pong", ".agents")], "the game's own Antigravity folder");
    const root = await tmpDir("antigravity-keychain-");
    const box = await ProcessSandbox.create({
      ...sandbox,
      writableRoots: [root],
      scratchDir: path.join(root, "scratch"),
      ownHome: [...antigravityHomes(), path.join(os.homedir(), "Library", "Keychains")],
      platform: "darwin",
      enabled: false,
    });
    const userKeychains = path.join(os.homedir(), "Library", "Keychains");
    assert.ok(box.policy.denyRead.includes(userKeychains), "naming the Keychain as its own opens nothing");
    assert.equal(box.policy.allowWrite.includes(userKeychains), false);
    assert.ok(box.policy.allowWrite.includes(antigravityHome()), "its own folder: the sign-in file is renewed there");
  });

  it("on a Mac its sandbox alone may ask the system's certificate checker, and no sandbox opens any other service", async () => {
    const root = await tmpDir("antigravity-box-");
    const box = (machServices: string[] | undefined, platform: NodeJS.Platform) =>
      ProcessSandbox.create({
        writableRoots: [root],
        scratchDir: path.join(root, "scratch"),
        secretPaths: [],
        enabled: false,
        platform,
        ...(machServices ? { machServices } : {}),
      });
    const lookups = async (machServices: string[] | undefined, platform: NodeJS.Platform) => {
      const sandbox = await box(machServices, platform);
      return sandbox.toRuntimeConfig(sandbox.policy).network.allowMachLookup;
    };
    assert.deepEqual(await lookups(["com.apple.trustd.agent"], "darwin"), ["com.apple.trustd.agent"]);
    assert.deepEqual(
      await lookups(["com.apple.trustd.agent", "com.apple.SecurityServer", "*", "com.apple.*"], "darwin"),
      ["com.apple.trustd.agent"],
      "a service the table does not list is never opened",
    );
    assert.equal(await lookups(undefined, "darwin"), undefined, "every other sandbox opens none");
    assert.equal(await lookups(["*"], "darwin"), undefined);
    assert.equal(await lookups(["com.apple.trustd.agent"], "linux"), undefined, "a Mac's services are a Mac's");
  });

  it("its process keeps Antigravity's and Gemini's own variables and no other vendor's or any key", () => {
    const env = childEnv(
      {
        PATH: "/bin",
        ANTIGRAVITY_CLI_HOME: "/Users/me/.gemini",
        GEMINI_API_KEY: "not-for-a-plan",
        ANTHROPIC_API_KEY: "sk-ant",
        CURSOR_API_KEY: "cur",
        CODEX_HOME: "/Users/me/.codex",
      },
      { base: "contractor", vendor: "antigravity" },
    );
    assert.equal(env.ANTIGRAVITY_CLI_HOME, "/Users/me/.gemini");
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.CURSOR_API_KEY, undefined);
    assert.equal(env.CODEX_HOME, undefined);
    const other = childEnv({ PATH: "/bin", ANTIGRAVITY_CLI_HOME: "/x" }, { base: "contractor", vendor: "cursor" });
    assert.equal(other.ANTIGRAVITY_CLI_HOME, undefined, "nor does another CLI's process keep Antigravity's");
  });
});

/** A stand-in CLI: Node running `source`, in a sandbox that is off. */
async function standIn(source: string) {
  const root = await tmpDir("antigravity-cli-");
  const cli = path.join(root, "cli.cjs");
  await writeFile(cli, source);
  const sandbox = await ProcessSandbox.create({
    writableRoots: [root],
    scratchDir: path.join(root, "scratch"),
    secretPaths: [],
    enabled: false,
  });
  return { sandbox, invocation: { argv: [cli], cwd: root, env: {}, domains: [] } };
}

describe("the Antigravity process", { skip: os.platform() === "win32" && "process groups are POSIX's" }, () => {
  it("writes each line to the CLI and reads each line back, and the CLI leaves by itself once its input ends", async () => {
    const echo = [
      'const lines = require("node:readline").createInterface({ input: process.stdin });',
      'lines.on("line", (line) => console.log(`heard ${line}`));',
      'lines.on("close", () => { console.error("bye"); process.exit(3); });',
    ].join("\n");
    const { sandbox, invocation } = await standIn(echo);
    try {
      const agent = await antigravityProcess(sandbox, process.execPath, invocation);
      agent.send("one");
      agent.send("two");
      const heard: string[] = [];
      for await (const line of agent.lines) {
        heard.push(line);
        if (heard.length === 2) agent.end();
      }
      assert.deepEqual(heard, ["heard one", "heard two"]);
      assert.deepEqual(await agent.exited, { code: 3, stderr: "bye\n" });
    } finally {
      await sandbox.dispose();
    }
  });

  it("stops a CLI that would never leave, and says once it is gone", async () => {
    const { sandbox, invocation } = await standIn("setInterval(() => {}, 1000);\n");
    let gone = 0;
    try {
      const agent = await antigravityProcess(sandbox, process.execPath, invocation, () => gone++);
      agent.stop();
      agent.stop();
      assert.equal((await agent.exited).code, null);
      assert.equal(gone, 1);
    } finally {
      await sandbox.dispose();
    }
  });
});

describe("Google's refusals the CLI writes as a turn's reply", () => {
  /** An engine whose every turn is Google's refusal as Antigravity CLI 1.5.9 says it, and the CLI's log of it. */
  async function refusedEngine(options: { log?: string | null; openPage?: (url: string) => unknown } = {}) {
    const recorded = await json("antigravity-verification-required-1.5.9.json");
    const logDir = await tmpDir("antigravity-log-");
    const prompt: Script["prompt"] = async (message, agent) => {
      if (options.log !== null)
        await writeFile(path.join(logDir, "acp-server-20261122_150700-23584.log"), options.log ?? String(recorded.log));
      agent.say({
        method: AcpMethod.SessionUpdate,
        params: { sessionId: (message.params as Json).sessionId, update: recorded.update },
      });
      return recorded.answer as Json;
    };
    return engineWith({ prompt }, { logDir, ...(options.openPage ? { openPage: options.openPage } : {}) });
  }

  it("a reply that is only the CLI's notice is no answer: a game is never named by it", () => {
    assert.equal(antigravityNotice("\n⚠ Verification Required\n"), AntigravityNotice.VerificationRequired);
    assert.equal(antigravityNotice("⚠️ Something Else"), "Something Else");
    for (const reply of ["Done: the paddle moves.", "⚠ Careful:\nthe build changed three files", "⚠", ""])
      assert.equal(antigravityNotice(reply), null, JSON.stringify(reply));
    assert.equal(antigravityNotice(`⚠ ${"x".repeat(81)}`), null, "a notice is one short line");
  });

  it("Google's verification fails the turn and opens Google's page from the CLI's log, once", async () => {
    const opened: string[] = [];
    const { engine } = await refusedEngine({ openPage: (url) => opened.push(url) });
    const cwd = await game();
    for (const _ of [1, 2]) {
      const result = await engine.delegate({ cwd, prompt: "make pong" });
      assert.equal(result.ok, false, "not a finished build");
      assert.equal(result.stopReason, StopReason.Error);
      assert.match(result.errorText ?? "", /verify your Google account/);
      assert.match(result.errorText ?? "", /opened Google's page/);
    }
    assert.deepEqual(opened, [
      "https://accounts.google.com/v3/signin/continue?plt=TEST-PLT&continue=https://developers.google.com/gemini-code-assist/auth/auth_success_gemini&flowName=GlifWebSignIn",
    ]);
    await assert.rejects(
      engine.complete({ messages: [{ role: "user", content: "Name this game" }] }),
      (err: unknown) => err instanceof EngineError && /verify your Google account/.test(err.message),
      "a one-shot answer (the game's name) fails too",
    );
    assert.equal(opened.length, 1, "the same page is not opened again");
  });

  it("a model's own reply that starts with the warning sign is still the model's answer", async () => {
    const { engine } = await engineWith({
      prompt: async (message, agent) => {
        agent.say({
          method: AcpMethod.SessionUpdate,
          params: {
            sessionId: (message.params as Json).sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "⚠️ Texture missing, used a fallback colour" },
            },
          },
        });
        return { stopReason: "end_turn" };
      },
    });
    const result = await engine.delegate({ cwd: await game(), prompt: "go" });
    assert.equal(result.ok, true, "only a notice Genex knows fails a turn");
    assert.equal(result.summary, "⚠️ Texture missing, used a fallback colour");
  });

  it("without the page in a log, or with no browser to open, the turn says where to sign in again", async () => {
    for (const options of [{ log: null }, { log: "nothing of Google's here\n" }, {}]) {
      const opened: string[] = [];
      const withBrowser = "log" in options;
      const { engine } = await refusedEngine({
        ...options,
        ...(withBrowser ? { openPage: (url) => opened.push(url) } : {}),
      });
      const result = await engine.delegate({ cwd: await game(), prompt: "go" });
      assert.equal(result.ok, false);
      assert.match(result.errorText ?? "", /Settings › Model Providers/);
      assert.deepEqual(opened, []);
    }
  });

  it("opens only Google's own sign-in host over https, whatever the log names", () => {
    const log = (url: string) => `"validation_url": "${url}"`;
    for (const url of [
      "http://accounts.google.com/v3/signin",
      "https://accounts.google.com.evil.example/v3",
      "https://evil.example/?accounts.google.com",
      "https://user:pass@accounts.google.com/v3",
      "https://accounts.google.com:8443/v3",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "not a url",
    ])
      assert.equal(verificationPage(log(url)), null, url);
    assert.equal(
      verificationPage(log("https://accounts.google.com/v3/signin?a=1\\u0026b=2")),
      "https://accounts.google.com/v3/signin?a=1&b=2",
    );
    assert.equal(
      googleSignInPage("https://accounts.google.com/o/oauth2/auth?x=1"),
      "https://accounts.google.com/o/oauth2/auth?x=1",
    );
  });

  it("names the plan for the limits panel, with no limit Google would not share", async () => {
    const { engine } = await engineWith();
    const usage = await engine.readUsage();
    assert.equal(usage?.plan, "Antigravity Starter Quota");
    assert.deepEqual(usage?.windows, []);
    const signedOut = await engineWith({ session: refusal });
    assert.equal(await signedOut.engine.readUsage(), null);
  });

  it("a Bypass build runs on the same sign-in as the boxed sessions: the CLI's own file", async () => {
    const { engine, agents } = await engineWith();
    const bypass = { mode: PermissionMode.Bypass, ask: async () => ({ allow: true }) };
    await engine.delegate({ cwd: await game(), prompt: "go", permissions: bypass as never });
    const build = agents.find((agent) => agent.invocation.sandbox === null);
    assert.ok(build, "the build ran as the person");
    assert.deepEqual(
      { SSH_CONNECTION: build.invocation.env.SSH_CONNECTION, SSH_CLIENT: build.invocation.env.SSH_CLIENT },
      antigravityPersonEnv(),
      "never the Keychain, which may hold another Google account",
    );
  });
});

/** A home with the CLI's default folder holding `token` as its sign-in file. */
async function homeWith(token: string | null = "signed-in"): Promise<string> {
  const home = await realpath(await tmpDir("antigravity-home-"));
  await mkdir(antigravityAppData(home, AntigravityAppData.Cli), { recursive: true });
  if (token !== null)
    await writeFile(path.join(antigravityAppData(home, AntigravityAppData.Cli), ANTIGRAVITY_SIGN_IN_FILE), token);
  return home;
}

/** Genex's own copy of the sign-in in `home`. */
const genexFile = (home: string) => path.join(antigravityAppData(home), ANTIGRAVITY_SIGN_IN_FILE);

/** What a session that may write in `~/.gemini` could plant in the CLI's folder, by name. */
function plantsBeside(secret: string, outside: string): ReadonlyArray<[string, (home: string) => Promise<void>]> {
  return [
    [
      "the sign-in file is a link to another file",
      async (home) => {
        await symlink(secret, path.join(antigravityAppData(home, AntigravityAppData.Cli), ANTIGRAVITY_SIGN_IN_FILE));
      },
    ],
    [
      "the CLI's folder is a link to another folder",
      async (home) => {
        await mkdir(path.join(outside, "cli"), { recursive: true });
        await writeFile(path.join(outside, "cli", ANTIGRAVITY_SIGN_IN_FILE), "elsewhere");
        await symlink(path.join(outside, "cli"), antigravityAppData(home, AntigravityAppData.Cli));
      },
    ],
    [
      "the sign-in file is a FIFO, which would hold the read open",
      async (home) => {
        execFileSync("mkfifo", [path.join(antigravityAppData(home, AntigravityAppData.Cli), ANTIGRAVITY_SIGN_IN_FILE)]);
      },
    ],
  ];
}

describe("Antigravity's own app data folder (#870)", () => {
  it("every `agy acp` Genex starts keeps to Genex's folder: the sign-in, each session, a Bypass build", async () => {
    const own = ["--app-data-dir", AntigravityAppData.Genex];
    assert.deepEqual(ANTIGRAVITY_LOGIN_ARGV, ["acp", "--login", ...own]);
    assert.deepEqual(ANTIGRAVITY_SESSION_ARGV, ["acp", ...own]);
    assert.equal(antigravityAppData("/Users/me"), path.join("/Users/me", ".gemini", "antigravity-genex"));
    const { engine, agents } = await engineWith();
    const bypass = { mode: PermissionMode.Bypass, ask: async () => ({ allow: true }) };
    await engine.delegate({ cwd: await game(), prompt: "go", permissions: bypass as never });
    assert.ok(agents.length > 0);
    for (const agent of agents) assert.deepEqual(agent.invocation.argv, ["acp", ...own]);
    // Still inside the sandbox's own folder: the sign-in file is renewed there.
    assert.ok(antigravityHomes("/Users/me").some((dir) => antigravityAppData("/Users/me").startsWith(dir + path.sep)));
  });

  it("carries the sign-in Genex kept in the CLI's folder over once, private, and never over its own", async () => {
    const home = await homeWith("old-sign-in");
    assert.equal(await carryOverAntigravitySignIn(home), true);
    assert.equal(await readFile(genexFile(home), "utf8"), "old-sign-in");
    if (process.platform !== "win32") assert.equal((await stat(genexFile(home))).mode & 0o777, 0o600);
    await writeFile(path.join(antigravityAppData(home, AntigravityAppData.Cli), ANTIGRAVITY_SIGN_IN_FILE), "outside");
    assert.equal(await carryOverAntigravitySignIn(home), false, "a sign-in in Genex's folder is never replaced");
    assert.equal(await readFile(genexFile(home), "utf8"), "old-sign-in");
    const ran = await homeWith("outside agy's sign-in");
    await mkdir(antigravityAppData(ran));
    assert.equal(await carryOverAntigravitySignIn(ran), false, "Genex's agy already ran: its folder is its own");
    assert.equal(await stat(genexFile(ran)).catch(() => null), null, "a signed-out Genex stays signed out");
    const none = await homeWith(null);
    assert.equal(await carryOverAntigravitySignIn(none), false, "nothing to carry: the person signs in once");
    assert.equal(await stat(antigravityAppData(none)).catch(() => null), null, "and nothing is made");
    const empty = await realpath(await tmpDir("antigravity-home-"));
    assert.equal(await carryOverAntigravitySignIn(empty), false, "no `.gemini` at all");
  });

  it("copies nothing through a link a session could plant in `~/.gemini`", {
    skip: process.platform === "win32" ? "links need privileges on Windows" : false,
  }, async () => {
    const outside = await realpath(await tmpDir("antigravity-outside-"));
    const secret = path.join(outside, "id_ed25519");
    await writeFile(secret, "private key");
    for (const [name, plant] of plantsBeside(secret, outside)) {
      const home = await realpath(await tmpDir("antigravity-home-"));
      await mkdir(antigravityHome(home), { recursive: true });
      if (!name.startsWith("the CLI's folder")) await mkdir(antigravityAppData(home, AntigravityAppData.Cli));
      await plant(home);
      assert.equal(await carryOverAntigravitySignIn(home), false, name);
      assert.equal(await stat(genexFile(home)).catch(() => null), null, `${name}: nothing copied`);
    }
    const linked = await homeWith("old-sign-in");
    const target = path.join(outside, "genex-elsewhere");
    await mkdir(target);
    await symlink(target, antigravityAppData(linked));
    assert.equal(await carryOverAntigravitySignIn(linked), false, "Genex's folder is a link: it is there, so no copy");
    assert.deepEqual(await readdir(target), [], "nothing written through it");
  });

  it("the engine carries the sign-in over before its first session, and reads Google's page from Genex's logs", async () => {
    const home = await homeWith("old-sign-in");
    const recorded = await json("antigravity-verification-required-1.5.9.json");
    const logs = path.join(antigravityAppData(home), "log");
    const prompt: Script["prompt"] = async (message, agent) => {
      await mkdir(logs, { recursive: true });
      await writeFile(path.join(logs, "acp-server-20261124_090000-1.log"), String(recorded.log));
      agent.say({
        method: AcpMethod.SessionUpdate,
        params: { sessionId: (message.params as Json).sessionId, update: recorded.update },
      });
      return recorded.answer as Json;
    };
    const opened: string[] = [];
    const { engine } = await engineWith({ prompt }, { home, openPage: (url) => opened.push(url) });
    await engine.delegate({ cwd: await game(), prompt: "make pong" });
    assert.equal(await readFile(genexFile(home), "utf8"), "old-sign-in", "carried over before the session");
    assert.equal(opened.length, 1, "Google's page, from the log in Genex's own folder");
  });
});
