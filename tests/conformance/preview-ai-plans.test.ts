/**
 * A person's own AI plan answering a game's calls in Live: which engines count as a plan that is
 * ready, which of its models a game is offered, how one call is asked of it, and how the helper is
 * started so that it asks the app. The engines here are small stand-ins; no provider is reached.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { GenexCliService } from "../../src/main/core/genex-cli.ts";
import {
  answerOnPlan,
  HostError,
  hostErrorOf,
  parseHostAsk,
  planModels,
  readyPlans,
} from "../../src/main/core/preview-ai-plans.ts";
import { EngineKind, EngineStatusCode } from "../../src/shared/engine-descriptor.ts";
import { EngineFailureKind } from "../../src/shared/engine-requests.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { type CompleteRequest, type Engine, EngineError, type EngineModel } from "../../src/substrate/engines/types.ts";
import { tmpDir } from "../helpers/tmp.ts";

const model = (id: string, extra: Partial<EngineModel> = {}): EngineModel => ({
  id,
  label: id.toUpperCase(),
  contextWindow: 200_000,
  maxTokens: 8_000,
  supportsThinking: false,
  supportsTools: true,
  supportsVision: false,
  ...extra,
});

/** A stand-in engine: its status, its models, and what `complete` does with a request. */
function engine(
  id: string,
  options: {
    ready?: boolean;
    models?: EngineModel[];
    preferred?: string;
    complete?: ((request: CompleteRequest) => Promise<string>) | null;
  } = {},
): Engine & { asked: CompleteRequest[] } {
  const asked: CompleteRequest[] = [];
  const answer = options.complete === undefined ? async () => "Fine." : options.complete;
  return {
    asked,
    id,
    label: id,
    kind: EngineKind.Delegated,
    status: async () => ({
      code: options.ready === false ? EngineStatusCode.NeedsLogin : EngineStatusCode.Ready,
      detail: "",
    }),
    models: async () => options.models ?? [model("sonnet")],
    defaultModel: async () => options.preferred ?? null,
    ...(answer
      ? {
          complete: async (request: CompleteRequest) => {
            asked.push(request);
            const content = await answer(request);
            return {
              message: { role: "assistant", content },
              usage: { engine: id },
              stopReason: "stop",
              model: "m",
              engine: id,
            };
          },
        }
      : {}),
  } as Engine & { asked: CompleteRequest[] };
}

const registry = (engines: Engine[]) => ({
  ids: () => engines.map((one) => one.id),
  get: (id: string) => {
    const found = engines.find((one) => one.id === id);
    if (!found) throw new Error(`no engine ${id}`);
    return found;
  },
});

const ASK = {
  id: "c1",
  modelId: `${EngineId.ClaudeCode}/sonnet`,
  system: "frame",
  user: "Got any answers?",
  maxOutputTokens: 300,
};

describe("the person's own plans in Live", () => {
  it("counts a subscription that is signed in and can answer one prompt, and nothing else", async () => {
    const plans = await readyPlans(
      registry([
        engine(EngineId.ClaudeCode),
        engine(EngineId.Codex, { ready: false }),
        engine(EngineId.OpenRouter),
        engine(EngineId.Ollama),
      ]),
    );
    assert.deepEqual(
      plans,
      [{ engine: EngineId.ClaudeCode, label: "Claude Code" }],
      "not a signed-out plan, a metered key or a local model",
    );
    assert.deepEqual(
      await readyPlans(registry([engine(EngineId.Codex, { complete: null })])),
      [],
      "a plan that cannot answer one prompt",
    );
    const broken = engine(EngineId.ClaudeCode);
    broken.status = async () => {
      throw new Error("status unreadable");
    };
    assert.deepEqual(await readyPlans(registry([broken])), [], "a plan whose status cannot be read is not ready");
  });

  it("offers a plan's models under the catalog's vendor, its default first, aliases and stale ones left out", async () => {
    const models = [
      model("haiku"),
      model("opus"),
      model("best", { aliasOf: "opus" }),
      model("old", { stale: true }),
      ...Array.from({ length: 8 }, (_, index) => model(`extra-${index}`)),
    ];
    const offered = await planModels(engine(EngineId.ClaudeCode, { models, preferred: "opus" }));
    assert.deepEqual(offered.slice(0, 2), [
      { id: "claude-code/opus", label: "OPUS", vendor: "anthropic" },
      { id: "claude-code/haiku", label: "HAIKU", vendor: "anthropic" },
    ]);
    assert.equal(offered.length, 6, "a budget names at most eight models");
    assert.ok(offered.every((one) => !["claude-code/best", "claude-code/old"].includes(one.id)));
    assert.equal((await planModels(engine(EngineId.Codex)))[0]?.vendor, "openai");
    assert.equal((await planModels(engine("some-other-plan")))[0]?.vendor, "some-other-plan");
  });

  it("asks one prompt with no tools: the helper's framing as the system prompt, the game's request as the turn", async () => {
    const claude = engine(EngineId.ClaudeCode, { complete: async () => "Psst. It's B." });
    const answer = await answerOnPlan(claude, ASK, new AbortController().signal);
    assert.deepEqual(answer, { id: "c1", text: "Psst. It's B." });
    const [request] = claude.asked;
    assert.ok(request);
    assert.deepEqual(
      [request.model, request.systemPrompt, request.messages, request.maxTokens, request.tools],
      ["sonnet", "frame", [{ role: "user", content: "Got any answers?" }], 300, undefined],
    );
    assert.ok((request.timeoutMs ?? 0) > 0, "a call never waits for ever");
    await answerOnPlan(claude, { ...ASK, modelId: "codex/gpt" }, new AbortController().signal);
    assert.equal(claude.asked[1]?.model, undefined, "another plan's model is asked of this plan's default");
  });

  it("says why the plan has no answer in the helper's four words, and never throws", async () => {
    const cases: Array<[EngineFailureKind, HostError]> = [
      [EngineFailureKind.RateLimit, HostError.RateLimited],
      [EngineFailureKind.UsageLimit, HostError.RateLimited],
      [EngineFailureKind.Auth, HostError.SignedOut],
      [EngineFailureKind.Unavailable, HostError.Unavailable],
      [EngineFailureKind.Timeout, HostError.Failed],
      [EngineFailureKind.Other, HostError.Failed],
    ];
    for (const [kind, error] of cases) {
      const failing = engine(EngineId.ClaudeCode, {
        complete: async () => {
          throw new EngineError(kind, EngineId.ClaudeCode, "no");
        },
      });
      assert.deepEqual(await answerOnPlan(failing, ASK, new AbortController().signal), { id: "c1", error }, kind);
    }
    assert.equal(hostErrorOf(new Error("anything else")), HostError.Failed);
    const mute = engine(EngineId.ClaudeCode, { complete: null });
    assert.deepEqual(await answerOnPlan(mute, ASK, new AbortController().signal), {
      id: "c1",
      error: HostError.Unavailable,
    });
  });

  it("hostile table: only a whole question from the helper is one", () => {
    const whole = { event: "ask", ...ASK, outputFormat: "text" };
    assert.deepEqual(parseHostAsk(whole), ASK);
    const notAsks: Array<[string, Record<string, unknown>]> = [
      ["another event", { ...whole, event: "call" }],
      ["no id", { ...whole, id: undefined }],
      ["a number for the text", { ...whole, user: 7 }],
      ["no model", { ...whole, modelId: null }],
      ["no length", { ...whole, maxOutputTokens: "300" }],
      ["an empty object", {}],
    ];
    for (const [why, line] of notAsks) assert.equal(parseHostAsk(line), null, why);
  });
});

describe("the practice helper started for a plan", () => {
  /** A CLI service over a stand-in CLI package of `version`. */
  async function cli(version: string) {
    const root = await tmpDir("studio-plan-cli-");
    const dist = path.join(root, "cli", "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(path.join(root, "cli", "package.json"), JSON.stringify({ version }));
    await writeFile(path.join(dist, "index.js"), "");
    return new GenexCliService({
      run: async () => {
        throw new Error("no command runs here");
      },
      credentialFile: async () => undefined,
      heldCredentials: () => [],
      runsRoot: path.join(root, "runs"),
      resources: path.join(root, "resources"),
      genexStorage: path.join(root, "genex"),
      protectedWrites: () => [],
      cliPath: path.join(dist, "index.js"),
    });
  }

  it("runs in host mode with the person's say-so, signed out, with no project and the network closed", async () => {
    const launch = await (await cli("1.46.1")).practiceLaunch("inn", null, true);
    assert.match(launch.command, /'llm' 'practice' '--host' '--user-approved' '--json'$/);
    assert.doesNotMatch(launch.command, /--live|--max-credits|--env|--api-url/);
    assert.equal(launch.stdin, undefined, "no credential");
    assert.deepEqual(launch.policy.allowedDomains, [], "like made-up answers, it only listens on this computer");
    assert.equal(launch.label, "genex-cli:llm-practice-host");
    const mock = await (await cli("1.46.1")).practiceLaunch("inn", null);
    assert.doesNotMatch(mock.command, /--host/);
  });

  it("is offered only by a pinned CLI whose helper can ask its host", async () => {
    assert.equal(await (await cli("1.46.1")).practiceAsksHost(), true);
    assert.equal(await (await cli("1.47.0")).practiceAsksHost(), true);
    assert.equal(await (await cli("1.46.0")).practiceAsksHost(), false);
    assert.equal(await (await cli("1.46.1-dev.3")).practiceAsksHost(), false, "a prerelease may predate it");
    assert.equal(await (await cli("not a version")).practiceAsksHost(), false);
  });
});
