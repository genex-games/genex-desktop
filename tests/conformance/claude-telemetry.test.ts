import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { readClaudeTelemetry, withClaudeModelCapabilities } from "../../src/substrate/engines/claude-telemetry.ts";
import { ClaudeCodeEngine } from "../../src/substrate/engines/claude-code.ts";
import { DelegateEventType, type DelegateEvent } from "../../src/substrate/engines/types.ts";
import { ContextSource } from "../../src/shared/context.ts";
import { fixtureCodingCli } from "../helpers/external-cli.ts";
import { tmpDir } from "../helpers/tmp.ts";

// An engine resolves its login homes the moment it is built, and `CLAUDE_CONFIG_DIR` is the first
// home it looks at: the engines below get tmp homes of their own instead.
delete process.env.CLAUDE_CONFIG_DIR;

const USAGE_CONTROL = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";
const CONTEXT_CONTROL = "getContextUsage";
const CONTEXT = { totalTokens: 24000, maxTokens: 200000, percentage: 12, model: "claude-test" };
/** A control that never answers, such as plan usage scanning a large transcript history. */
const never = () => new Promise<never>(() => {});

/**
 * Control requests served the way Claude Code 2.1.281 serves them: one at a time, in arrival order,
 * each answered before the next is read, so one slow request holds up every request behind it.
 */
function fifoControls(handlers: Record<string, () => Promise<unknown>>) {
  const asked: string[] = [];
  let previous: Promise<unknown> = Promise.resolve();
  const controls: Record<string, () => Promise<unknown>> = {};
  for (const [name, answer] of Object.entries(handlers)) {
    controls[name] = () => {
      asked.push(name);
      const reply = previous.then(answer);
      previous = reply.catch(() => undefined);
      return reply;
    };
  }
  return { controls, asked };
}

/** A Claude Code engine with a login of its own, whose SDK `query()` returns `stream`. */
async function engineWithStream(stream: object): Promise<ClaudeCodeEngine> {
  const root = await tmpDir("studio-telemetry-");
  const home = path.join(root, "claude-home");
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, ".credentials.json"), "{}");
  return new ClaudeCodeEngine({
    resolveCli: fixtureCodingCli,
    engineHome: home,
    systemHome: path.join(root, "no-system-login"),
    judgeCwd: path.join(root, "judge"),
    queryFn: (() => stream) as never,
  });
}

/** A stream that answers `controls` and yields `messages`, like the SDK's query object. */
function sessionStream(controls: Record<string, () => Promise<unknown>>, messages: unknown[]): object {
  return {
    ...controls,
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message;
    },
  };
}

test("context arrives within the deadline from a CLI that answers controls one at a time", async () => {
  const { controls, asked } = fifoControls({
    [USAGE_CONTROL]: never,
    [CONTEXT_CONTROL]: async () => CONTEXT,
  });
  const result = await readClaudeTelemetry(controls, { deadlineMs: 20 });
  assert.equal(result.context?.promptTokens, 24000, "context must not queue behind a plan-usage request");
  assert.equal(result.context?.percent, 12);
  assert.ok(!asked.includes(USAGE_CONTROL), "running-session telemetry never asks for plan usage");
});
test("a caller with nowhere to report context never asks for it", async () => {
  const { controls, asked } = fifoControls({ [CONTEXT_CONTROL]: async () => CONTEXT });
  const result = await readClaudeTelemetry(
    { supportedModels: async () => [{ value: "claude-test" }], ...controls },
    { deadlineMs: 20, readContext: false },
  );
  assert.equal(result.models?.[0]?.value, "claude-test");
  assert.equal(result.context, undefined);
  assert.deepEqual(asked, []);
});
test("a slow model list does not erase context usage", async () => {
  const result = await readClaudeTelemetry(
    {
      supportedModels: () => new Promise(() => {}),
      getContextUsage: async () => CONTEXT,
    },
    { deadlineMs: 20 },
  );
  assert.equal(result.context?.promptTokens, 24000);
  assert.equal(result.context?.percent, 12);
  assert.equal(result.models, undefined);
});
test("unsupported or throwing controls do not discard successful model discovery", async () => {
  const result = await readClaudeTelemetry(
    {
      supportedModels: async () => [{ value: "claude-test" }],
      getContextUsage: () => {
        throw new Error("Unavailable");
      },
    },
    { deadlineMs: 20 },
  );
  assert.equal(result.models?.[0]?.value, "claude-test");
  assert.equal(result.context, undefined);
});
test("invalid context measurements stay unknown", async () => {
  for (const maxTokens of [NaN, Infinity, 0, -1])
    assert.equal(
      (
        await readClaudeTelemetry(
          { getContextUsage: async () => ({ totalTokens: 10, maxTokens, model: "test" }) },
          { deadlineMs: 20 },
        )
      ).context,
      undefined,
    );
});
test("a running session reports its context and never asks the CLI for plan usage", async () => {
  const { controls, asked } = fifoControls({
    [USAGE_CONTROL]: never,
    [CONTEXT_CONTROL]: async () => CONTEXT,
  });
  const engine = await engineWithStream(
    sessionStream(controls, [
      { type: "system", subtype: "init", session_id: "ses_context", model: "claude-test", tools: [] },
      { type: "assistant", message: { content: [{ type: "text", text: "Built." }] } },
      { type: "result", subtype: "success", is_error: false, result: "Built.", num_turns: 1, usage: {} },
    ]),
  );
  const events: DelegateEvent[] = [];
  await engine.delegate({
    cwd: await tmpDir("claude-telemetry-run-"),
    prompt: "Build",
    onEvent: (event) => events.push(event),
  });
  // The reading is not awaited by the run: let its already-answered controls settle.
  await setImmediate();
  assert.deepEqual(
    events.filter((event) => event.type === DelegateEventType.ContextUsage).map((event) => event.payload),
    [
      {
        promptTokens: 24000,
        contextWindow: 200000,
        percent: 12,
        model: "claude-test",
        sessionId: "ses_context",
        source: ContextSource.Provider,
      },
    ],
  );
  assert.ok(!asked.includes(USAGE_CONTROL), "a running session's control channel is never held by plan usage");
});
test("a judge asks its CLI for neither plan usage nor a context nobody reads", async () => {
  const { controls, asked } = fifoControls({
    [USAGE_CONTROL]: never,
    [CONTEXT_CONTROL]: async () => CONTEXT,
  });
  const verdict = '{"pick":"A"}';
  const engine = await engineWithStream(
    sessionStream(controls, [
      { type: "system", subtype: "init", model: "claude-test", tools: [] },
      { type: "assistant", message: { content: [{ type: "text", text: verdict }] } },
      { type: "result", subtype: "success", is_error: false, result: verdict, num_turns: 1, usage: {} },
    ]),
  );
  const response = await engine.complete({ messages: [{ role: "user", content: "BUILD A vs BUILD B" }] });
  await setImmediate();
  assert.equal(response.message.content, verdict);
  assert.deepEqual(asked, []);
});
test("provider names and distinct context variants replace the Studio shortlist", () => {
  const row = (id: string, label: string) => ({
    id,
    label,
    contextWindow: 0,
    maxTokens: 64000,
    supportsTools: true,
    supportsVision: true,
    supportsThinking: true,
  });
  const rows = withClaudeModelCapabilities(
    [row("claude-fable-5-1", "Fable 5.1"), row("opus", "Opus")],
    [
      {
        value: "claude-fable-5-1[1m]",
        resolvedModel: "claude-fable-5-1",
        displayName: "Fable",
        supportedEffortLevels: ["low", "xhigh"],
      },
      {
        value: "opus[1m]",
        resolvedModel: "claude-opus-new[1m]",
        displayName: "Opus (1M context)",
        supportedEffortLevels: ["high"],
      },
      { value: "claude-new-model", displayName: "New model", supportsFastMode: true },
      { value: "claude-new-model", displayName: "Duplicate" },
    ],
  );
  assert.deepEqual(
    rows.map((row) => row.label),
    ["Fable", "Opus (1M context)", "New model"],
  );
  assert.deepEqual(rows[0]?.efforts, ["low", "xhigh"]);
  assert.deepEqual(rows[1]?.efforts, ["high"]);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["claude-fable-5-1[1m]", "opus[1m]", "claude-new-model"],
  );
  assert.equal(rows[2]?.contextSource, "unknown");
  assert.equal(rows[2]?.contextWindow, 0);
  assert.equal(rows[2]?.supportsFast, true);
});

/** Plan usage as the CLI answers it, with the 5-hour window at `percent`. */
const planUsage = (percent: number) => ({
  rate_limits_available: true,
  rate_limits: { five_hour: { utilization: percent, resets_at: null } },
});

test("plan usage read for the account before a switch is never shown or kept for the next one", async () => {
  const root = await tmpDir("studio-usage-switch-");
  const home = path.join(root, "claude-home");
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, ".credentials.json"), "{}");
  let answerFirst: (value: unknown) => void = () => {};
  const firstAnswer = new Promise<unknown>((resolve) => {
    answerFirst = resolve;
  });
  let firstAsked: () => void = () => {};
  const asked = new Promise<void>((resolve) => {
    firstAsked = resolve;
  });
  const answers = [() => firstAnswer, async () => planUsage(80)];
  const engine = new ClaudeCodeEngine({
    resolveCli: fixtureCodingCli,
    engineHome: home,
    systemHome: path.join(root, "no-system-login"),
    judgeCwd: path.join(root, "judge"),
    authStatusFn: async () => ({ loggedIn: true, detail: "" }),
    queryFn: (() => {
      const answer = answers.shift() ?? (async () => null);
      if (answers.length === 1) firstAsked();
      return sessionStream({ [USAGE_CONTROL]: answer }, []);
    }) as never,
  });
  const before = engine.readUsage();
  await asked;
  await engine.recheckLogin();
  const after = engine.readUsage();
  answerFirst(planUsage(10));
  assert.equal((await after)?.windows[0]?.percent, 80, "the read after the switch asks the new account");
  assert.equal((await before)?.windows[0]?.percent, 80, "the earlier read answers with the new account's limits");
  assert.equal(engine.usageSnapshot()?.windows[0]?.percent, 80, "the old account's limits are never kept");
});
