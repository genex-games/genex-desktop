import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { delegationMirror } from "../../src/main/core/delegation-events.ts";
import type { StudioCore } from "../../src/main/studio-core.ts";
import { SessionActivityRole } from "../../src/shared/chat-activity.ts";
import { ContextSource, measuredContext, validateContextPolicy } from "../../src/shared/context.ts";
import type { EventData } from "../../src/shared/event-log.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { modelKey } from "../../src/renderer/model-key.ts";
import { contextReading } from "../../src/renderer/ui/usage-words.ts";
import { ContextPreferences } from "../../src/substrate/context-settings.ts";
import { LocalSessions } from "../../src/substrate/engines/local-session.ts";
import { DelegateEventType } from "../../src/substrate/engines/types.ts";
import { tmpDir } from "../helpers/tmp.ts";
const context = (payload: Record<string, unknown>) => ({
  data: { type: "custom", event_type: "context_usage", payload },
});
const init = (model: string, session: string, role = "planner") => ({
  data: {
    type: "custom",
    event_type: "delegated.codex",
    payload: {
      engine: "codex",
      requestedModel: model,
      role,
      kind: "system",
      data: { subtype: "init", session_id: session },
    },
  },
});

test("context is provider/model/role specific; unknown remains unknown and compaction clears usage", () => {
  const first = context({
    engine: "codex",
    requestedModel: "sol",
    model: "sol-actual",
    sessionId: "one",
    role: "planner",
    promptTokens: 80,
    contextWindow: 100,
    source: "provider-session",
  });
  const worker = context({
    engine: "codex",
    requestedModel: "sol",
    sessionId: "worker",
    role: "builder",
    promptTokens: 99,
    contextWindow: 100,
  });
  const unrelated = context({
    engine: "claude-code",
    requestedModel: "sonnet",
    promptTokens: 1000,
    contextWindow: 2000,
  });
  assert.equal(measuredContext([first, worker, unrelated], "codex", "sol")?.percent, 80);
  assert.equal(measuredContext([first, worker], "codex", "other"), null);
  assert.equal(measuredContext([first, init("sol", "worker", "builder")], "codex", "sol")?.promptTokens, 80);
  assert.equal(measuredContext([first, init("sol", "two")], "codex", "sol"), null);
  assert.equal(
    measuredContext([first, init("sol", "two"), first], "codex", "sol"),
    null,
    "late measurement from a previous session cannot overwrite the new session",
  );
  assert.equal(measuredContext([first, init("other", "two")], "codex", "sol")?.promptTokens, 80);
  const compact = context({
    engine: "codex",
    requestedModel: "sol",
    role: "planner",
    compacted: true,
    source: "provider-session",
  });
  assert.equal(measuredContext([first, compact], "codex", "sol")?.promptTokens, undefined);
  assert.equal(
    measuredContext(
      [context({ engine: "codex", requestedModel: "default", model: "actual", source: "unavailable" })],
      "codex",
      "default",
    )?.promptTokens,
    undefined,
  );
});

test("context policies persist by model/chat, inherit, validate bounds and refuse a threshold for a provider's CLI", async () => {
  const dir = await tmpDir("context-settings-"),
    file = path.join(dir, "context.json");
  const settings = new ContextPreferences(file);
  await settings.set("bonsai", "small", { mode: "custom", thresholdPercent: 55 });
  assert.equal((await settings.get("bonsai", "small", "chat")).policy.thresholdPercent, 55);
  await Promise.all([
    settings.set("bonsai", "small", { mode: "custom", thresholdPercent: 65 }, "chat"),
    settings.set("bonsai", "large", { mode: "custom", thresholdPercent: 75 }),
  ]);
  const reopened = new ContextPreferences(file);
  assert.equal((await reopened.get("bonsai", "small", "chat")).policy.thresholdPercent, 65);
  await reopened.set("bonsai", "small", null, "chat");
  assert.equal((await reopened.get("bonsai", "small", "chat")).policy.thresholdPercent, 55);
  // Claude Code and Codex compact at their own point: no threshold of ours.
  for (const engine of ["claude-code", "codex"]) {
    await assert.rejects(
      settings.set(engine, "default", { mode: "custom", thresholdPercent: 70 }),
      /applies only to local models/,
    );
    assert.deepEqual(
      [(await settings.get(engine, "default")).owner, (await settings.get(engine, "default")).configurable],
      ["provider", false],
    );
  }
  for (const value of [0, 100, NaN, Infinity])
    assert.throws(() => validateContextPolicy({ mode: "custom", thresholdPercent: value }));
  assert.ok(!/claude-code|codex/.test(await readFile(file, "utf8")));
});

test("later context samples retain the recorded checkpoint time only for the same session", () => {
  const at = "2026-09-20T22:10:32.255Z";
  const checkpoint = {
    created_at: at,
    ...context({ engine: "bonsai", model: "local", sessionId: "one", compacted: true }),
  };
  const measurement = context({
    engine: "bonsai",
    model: "local",
    sessionId: "one",
    promptTokens: 25,
    contextWindow: 100,
  });
  const answer = measuredContext([checkpoint, measurement], "bonsai", "local");
  assert.equal(answer?.percent, 25);
  assert.equal(answer?.lastCompactedAt, at);
  assert.equal(
    measuredContext(
      [
        checkpoint,
        context({ engine: "bonsai", model: "local", sessionId: "two", promptTokens: 20, contextWindow: 100 }),
      ],
      "bonsai",
      "local",
    )?.lastCompactedAt,
    undefined,
  );
  assert.equal(
    measuredContext(
      [checkpoint, context({ engine: "bonsai", model: "local", promptTokens: 20, contextWindow: 100 })],
      "bonsai",
      "local",
    )?.lastCompactedAt,
    undefined,
  );
  assert.equal(
    measuredContext(
      [context({ engine: "bonsai", model: "local", sessionId: "one", compacted: true })],
      "bonsai",
      "local",
    )?.lastCompactedAt,
    undefined,
    "missing time remains unknown",
  );
});

test("local resume validates identity before any disk read; model changes cannot race an active session", async () => {
  const root = await tmpDir("context-resume-"),
    cwd = path.join(root, "game");
  await mkdir(cwd);
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  const sessions = new LocalSessions({
    root: path.join(root, "sessions"),
    protectedPaths: [],
    contextWindow: 10000,
    complete: async () => {
      started();
      await gate;
      return {
        engine: "bonsai",
        model: "small",
        message: { role: "assistant", content: "done" },
        usage: {},
        stopReason: "stop",
      };
    },
  });
  await assert.rejects(
    sessions.run({ cwd, prompt: "inspect", readOnly: true, resume: "../outside" }, "small"),
    /Invalid local session id/,
  );
  let id = "";
  const pending = sessions.run(
    {
      cwd,
      prompt: "inspect",
      readOnly: true,
      onEvent: (e) => {
        if (e.type === "system") id = String((e.payload as any).session_id ?? id);
      },
    },
    "small",
  );
  await ready;
  await assert.rejects(
    sessions.run({ cwd, prompt: "continue", readOnly: true, resume: id }, "large"),
    /already running/,
  );
  release();
  assert.equal((await pending).ok, true);
});

test("an alias changing its canonical target discards the previous model's measured context", () => {
  const previous = context({
    engine: "claude-code",
    requestedModel: "sonnet",
    model: "claude-sonnet-5",
    promptTokens: 80,
    contextWindow: 100,
  });
  assert.equal(measuredContext([previous], "claude-code", "sonnet", "claude-sonnet-5")?.percent, 80);
  assert.equal(measuredContext([previous], "claude-code", "sonnet", "claude-sonnet-5-5"), null);
});

/** The chat's own session as the real mirror records it, asked for `requestedModel` (none: the default pick). */
function mirroredSession(engine: EngineId, requestedModel: string | undefined) {
  const events: Array<{ data: EventData }> = [];
  const core = {
    append: async (batch: EventData[]) => {
      events.push(...batch.map((data) => ({ data })));
      return "event";
    },
    emit: () => {},
    options: {},
  };
  const mirror = delegationMirror({
    core: core as unknown as StudioCore,
    threadId: "chat",
    requestThreadId: "chat",
    project: "game",
    engineId: engine,
    requestedModel,
    activityScope: { delegationId: "lead", role: SessionActivityRole.Planner },
  });
  return { events, onEvent: mirror.onEvent };
}

/** The model Claude Code reports it ran for a default pick. */
const CLI_DEFAULT = "claude-opus-5-5[1m]";
/** The model a local session falls back to when the chat names none. */
const LOCAL_FALLBACK = "local-1";

test("a default pick's reading is measured for the default pick, not only for the model its CLI ran", () => {
  const session = mirroredSession(EngineId.ClaudeCode, undefined);
  session.onEvent({
    type: DelegateEventType.System,
    payload: { subtype: "init", model: CLI_DEFAULT, session_id: "s1" },
  });
  session.onEvent({
    type: DelegateEventType.ContextUsage,
    payload: { promptTokens: 50_000, contextWindow: 1_000_000, percent: 5, model: CLI_DEFAULT, sessionId: "s1" },
  });
  for (const pick of ["default", ""])
    assert.equal(measuredContext(session.events, EngineId.ClaudeCode, pick, CLI_DEFAULT)?.promptTokens, 50_000, pick);
  assert.equal(
    measuredContext(session.events, EngineId.ClaudeCode, "opus"),
    null,
    "an explicit pick is another session",
  );
  session.onEvent({
    type: DelegateEventType.Context,
    payload: {
      engine: EngineId.ClaudeCode,
      sessionId: "s1",
      model: CLI_DEFAULT,
      source: ContextSource.Provider,
      compacted: true,
    },
  });
  const compacted = measuredContext(session.events, EngineId.ClaudeCode, "default", CLI_DEFAULT);
  assert.deepEqual([compacted?.compacted, compacted?.promptTokens], [true, undefined], "the compaction is recognised");

  const codex = mirroredSession(EngineId.Codex, undefined);
  codex.onEvent({
    type: DelegateEventType.Context,
    payload: {
      engine: EngineId.Codex,
      sessionId: "c1",
      model: "gpt-5.5",
      requestedModel: null,
      promptTokens: 30,
      contextWindow: 100,
    },
  });
  assert.equal(measuredContext(codex.events, EngineId.Codex, "default")?.promptTokens, 30);
});

test("an explicit pick's reading stays its own, and a local session's reading stays with the model it measured", () => {
  const explicit = mirroredSession(EngineId.ClaudeCode, "opus");
  explicit.onEvent({
    type: DelegateEventType.System,
    payload: { subtype: "init", model: "claude-opus-5-5", session_id: "s2" },
  });
  explicit.onEvent({
    type: DelegateEventType.ContextUsage,
    payload: { promptTokens: 40_000, contextWindow: 1_000_000, percent: 4, model: "claude-opus-5-5", sessionId: "s2" },
  });
  assert.equal(measuredContext(explicit.events, EngineId.ClaudeCode, "opus", "claude-opus-5-5")?.promptTokens, 40_000);
  assert.equal(
    measuredContext(explicit.events, EngineId.ClaudeCode, "default"),
    null,
    "the default pick is another session",
  );
  assert.equal(measuredContext(explicit.events, EngineId.ClaudeCode, ""), null);

  const local = mirroredSession(EngineId.Bonsai, undefined);
  local.onEvent({
    type: DelegateEventType.Context,
    payload: {
      engine: EngineId.Bonsai,
      sessionId: "l1",
      model: LOCAL_FALLBACK,
      requestedModel: LOCAL_FALLBACK,
      promptTokens: 20,
      contextWindow: 100,
    },
  });
  assert.equal(measuredContext(local.events, EngineId.Bonsai, LOCAL_FALLBACK)?.promptTokens, 20);
});

test("a local session with no pick shows its compaction, not the preflight reading it replaced", () => {
  const local = mirroredSession(EngineId.Bonsai, undefined);
  // The exact count before a request (`bonsai.ts` #preflight, relayed by the local session).
  local.onEvent({
    type: DelegateEventType.Context,
    payload: {
      engine: EngineId.Bonsai,
      model: LOCAL_FALLBACK,
      requestedModel: LOCAL_FALLBACK,
      promptTokens: 900,
      contextWindow: 1000,
      source: ContextSource.NativeTokenizer,
      phase: "preflight",
      sessionId: "l1",
    },
  });
  // The boundary the local session writes once it has summarised (`local-session.ts`): it names no pick.
  local.onEvent({
    type: DelegateEventType.Context,
    payload: {
      engine: EngineId.Bonsai,
      model: LOCAL_FALLBACK,
      sessionId: "l1",
      source: ContextSource.NativeTokenizer,
      compacted: true,
      checkpointId: "c1",
      thresholdPercent: 80,
    },
  });
  const measured = measuredContext(local.events, EngineId.Bonsai, LOCAL_FALLBACK);
  assert.deepEqual([measured?.compacted, measured?.promptTokens], [true, undefined]);
  const reading = contextReading({
    modelKey: modelKey(EngineId.Bonsai, LOCAL_FALLBACK),
    usage: measured,
    contexts: [],
  });
  assert.equal(reading.summary, "Compacted · measured again after the next reply");
});
