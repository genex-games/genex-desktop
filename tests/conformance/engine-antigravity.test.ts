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
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
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
  antigravityPermission,
  antigravityProcess,
  antigravitySandbox,
  failure,
  googleFailure,
} from "../../src/substrate/engines/antigravity.ts";
import { ANTIGRAVITY_HOSTS, parseAntigravitySession } from "../../src/substrate/engines/antigravity-cli.ts";
import {
  antigravityHome,
  antigravityHomes,
  antigravityKeychain,
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
async function engineWith(script: Script = {}, options: { schedule?: AntigravitySchedule; now?: () => number } = {}) {
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
    assert.deepEqual(
      session.models.map((model) => [model.id, model.label]),
      [
        ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
        ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"],
        ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
        ["claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"],
        ["claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)"],
        ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
      ],
    );
    assert.deepEqual(
      session.models.filter((model) => model.providerDefault).map((model) => model.id),
      ["gemini-3.8-flash-high"],
    );
    assert.deepEqual(session.tier, { id: "free-tier", name: "Antigravity Starter Quota" });
    assert.throws(() => parseAntigravitySession({ models: {} }), /could not be read/);
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
    assert.equal((await engine.models()).length, 6);
    assert.equal((await engine.account()).source, LoginSource.System);
    assert.equal(agents.length, 2, "one more check, after the sign-in");
    await assert.rejects(stat(agents[1]?.invocation.cwd ?? ""), "the check's folder is removed");
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
    await engine.delegate({ cwd, prompt: "go", denyReads: ["/Users/me/private"] });
    const invocation = agents[0]?.invocation;
    assert.ok(invocation);
    assert.deepEqual(invocation.argv, ["acp"]);
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

  it("its session's sandbox may keep its own folder and, on a Mac alone, read the Keychain it signs in from", () => {
    const home = path.join(os.tmpdir(), "home");
    assert.deepEqual(antigravityHomes(home, "darwin"), [
      path.join(home, ".gemini"),
      path.join(home, "Library", "Keychains"),
    ]);
    assert.deepEqual(antigravityHomes(home, "linux"), [path.join(home, ".gemini")]);
    assert.deepEqual(antigravityHomes(home, "win32"), [path.join(home, ".gemini")]);
    for (const dir of antigravityHomes(home, "darwin"))
      assert.ok(sandboxedCliHomes({}, home, "darwin").includes(dir), "only a listed home can be a sandbox's own");
    assert.equal(antigravityHome(home), path.join(home, ".gemini"));
    const sandbox = antigravitySandbox({
      runDir: "/games/pong",
      gameDir: "/games/pong",
      gitDirs: ["/games/.git/worktrees/pong"],
      scratchDir: "/scratch/tmp",
      secretPaths: ["/studio/secrets"],
    });
    assert.deepEqual(sandbox.writableRoots, ["/games/pong", "/games/.git/worktrees/pong"]);
    assert.deepEqual(sandbox.secretPaths, ["/studio/secrets"]);
    assert.deepEqual(sandbox.machServices, [SandboxMachService.Trust]);
    assert.deepEqual(
      sandbox.denyWrite,
      [path.join("/games/pong", ".agents"), ...antigravityKeychain()],
      "the game's own Antigravity folder and the Keychain's files are never written",
    );
    assert.deepEqual(antigravityKeychain(home, "darwin"), [path.join(home, "Library", "Keychains")]);
    assert.deepEqual(antigravityKeychain(home, "linux"), []);
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
