/**
 * The composer's model (src/renderer/chat/use-composer-model.ts): what a chat opens with, and what
 * it derives from the engines and its own picks — tested through the pure rules the hook applies.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  composerOpening,
  composerSendOptions,
  effectiveRoles,
  effortOnModelPick,
  pinComposerOpening,
  rememberEffortPick,
  resolveComposerModel,
} from "../../src/renderer/chat/use-composer-model.ts";
import {
  autopilotSendOptions,
  composerExtras,
  composerLoopView,
  lastLoop,
  loopCommissions,
  pinChatLoop,
  rememberChatLoop,
  reportCommissions,
  storedChatLoop,
} from "../../src/renderer/loop-setting.ts";
import { openingRoles, presetRoles } from "../../src/renderer/role-store.ts";
import { toChoices } from "../../src/renderer/model-choices.ts";
import type { KeyValueStorage } from "../../src/renderer/storage.ts";
import type { EngineDescriptor } from "../../src/shared/engine-descriptor.ts";

const storage = (seed: Record<string, string> = {}): KeyValueStorage => {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
};

const model = (id: string, extra: Partial<EngineDescriptor["models"][number]> = {}) => ({
  id,
  label: id,
  contextWindow: 200_000,
  supportsTools: true,
  supportsVision: true,
  ...extra,
});
const claude: EngineDescriptor = {
  id: "claude-code",
  label: "Claude",
  kind: "delegated",
  supportsSessions: true,
  status: { code: "ready", detail: "" },
  defaultModel: null,
  models: [model("default"), model("opus", { efforts: ["low", "high"] }), model("sonnet")],
};
const codex: EngineDescriptor = {
  id: "codex",
  label: "Codex",
  kind: "delegated",
  supportsSessions: true,
  status: { code: "ready", detail: "" },
  defaultModel: null,
  models: [model("gpt", { efforts: ["medium"] })],
};
const signedOut: EngineDescriptor = { ...codex, id: "codex-out", status: { code: "needs_login", detail: "" } };
const local: EngineDescriptor = {
  id: "ollama",
  label: "Ollama",
  kind: "direct",
  status: { code: "ready", detail: "" },
  defaultModel: null,
  models: [model("qwen"), model("tiny", { supportsTools: false })],
};

describe("what a chat opens with", () => {
  it("a game chat keeps its own pick; a fresh one inherits the last pick, then its last turn's engine", () => {
    const store = storage({
      "studio.model.chat-a": "codex::gpt",
      "studio.model.last": "claude-code::opus",
      "studio.effort.codex::gpt": "medium",
    });
    assert.deepEqual(composerOpening(store, { id: "chat-a", meta: { kind: "game" } }), {
      modelKey: "codex::gpt",
      effort: "medium",
    });
    assert.equal(composerOpening(store, { id: "fresh", meta: { kind: "game" } }).modelKey, "claude-code::opus");
    assert.equal(
      composerOpening(store, { id: "fresh", meta: { kind: "game", lastEngine: "codex", lastModel: "gpt" } }).modelKey,
      "codex::gpt",
    );
  });

  it("a game chat's effort falls back to its last turn's, then to the last effort picked anywhere; Studio's does not", () => {
    const store = storage({ "studio.effort": "low" });
    assert.equal(composerOpening(store, { id: "g", meta: { kind: "game", lastEffort: "high" } }).effort, "high");
    assert.equal(composerOpening(store, { id: "g", meta: { kind: "game" } }).effort, "low");
    assert.equal(composerOpening(store, { id: "s", meta: { kind: "studio" } }).effort, null);
    assert.equal(
      composerOpening(
        storage({ "studio.studioChat.model": "codex::gpt", "studio.studioChat.effort.codex::gpt": "medium" }),
        { id: "s", meta: {} },
      ).effort,
      "medium",
      "Studio keeps its own model and effort apart",
    );
  });
});

describe("a game chat's own effort", () => {
  it("the effort its last turn ran at beats the effort saved for its model", () => {
    const store = storage({ "studio.model.g": "codex::gpt", "studio.effort.codex::gpt": "medium" });
    assert.equal(composerOpening(store, { id: "g", meta: { kind: "game", lastEffort: "high" } }).effort, "high");
  });

  it("an effort picked in the chat beats the one its last turn ran at", () => {
    const store = storage({
      "studio.model.g": "codex::gpt",
      "studio.effort.codex::gpt": "medium",
      "studio.threadEffort.g": "low",
    });
    assert.equal(composerOpening(store, { id: "g", meta: { kind: "game", lastEffort: "high" } }).effort, "low");
  });

  // Intended flip (c4563ce): picking a model in a game chat used to adopt that model's saved effort.
  it("picking another model keeps a game chat's effort; Studio adopts the model's saved one", () => {
    const store = storage({
      "studio.effort.claude-code::opus": "high",
      "studio.studioChat.effort.claude-code::opus": "high",
    });
    assert.equal(effortOnModelPick(store, false, "claude-code::opus", "low"), "low");
    assert.equal(effortOnModelPick(store, true, "claude-code::opus", "low"), "high");
  });

  it("an effort picked in a game chat is the one it reopens with, over its last turn's and its model's", () => {
    const store = storage({ "studio.model.g": "codex::gpt", "studio.effort.codex::gpt": "medium" });
    rememberEffortPick(store, { threadId: "g", studio: false, modelKey: "codex::gpt" }, "low");
    assert.equal(composerOpening(store, { id: "g", meta: { kind: "game", lastEffort: "high" } }).effort, "low");
    assert.equal(store.getItem("studio.effort.codex::gpt"), "low", "and it seeds fresh chats on that model");

    rememberEffortPick(store, { threadId: "g", studio: false, modelKey: "codex::gpt" }, null);
    assert.equal(composerOpening(store, { id: "g", meta: { kind: "game", lastEffort: "high" } }).effort, "high");
  });

  it("an effort picked in Studio stays Studio's and never becomes a game chat's own", () => {
    const store = storage();
    rememberEffortPick(store, { threadId: "s", studio: true, modelKey: "codex::gpt" }, "low");
    assert.equal(store.getItem("studio.threadEffort.s"), null);
    assert.equal(store.getItem("studio.studioChat.effort.codex::gpt"), "low");
  });

  it("opening a game chat pins its effort, so a later per-model change does not move it", () => {
    const store = storage({ "studio.model.g": "codex::gpt", "studio.effort.codex::gpt": "medium" });
    const game = { id: "g", meta: { kind: "game" as const } };
    assert.equal(pinComposerOpening(store, game).effort, "medium");
    assert.equal(store.getItem("studio.threadEffort.g"), "medium");
    store.setItem("studio.effort.codex::gpt", "high");
    assert.equal(composerOpening(store, game).effort, "medium");

    const studioChat = { id: "s", meta: { kind: "studio" as const } };
    const studioStore = storage({
      "studio.studioChat.model": "codex::gpt",
      "studio.studioChat.effort.codex::gpt": "low",
    });
    assert.equal(pinComposerOpening(studioStore, studioChat).effort, "low");
    assert.equal(studioStore.getItem("studio.threadEffort.s"), null, "Studio pins no effort of its own");
  });
});

describe("what the composer derives", () => {
  it("resolves the pick, the effort the model accepts, and whether roles and effort apply", () => {
    const view = resolveComposerModel({
      studio: false,
      engines: [claude, codex, local],
      modelKey: "claude-code::opus",
      effort: "high",
    });
    assert.equal(view.selected, "claude-code::opus");
    assert.equal(view.effort, "high");
    assert.equal(view.effortApplies, true);
    assert.equal(view.rolesApply, true, "a game chat on a session engine splits the work into roles");
    assert.deepEqual(
      view.roleModels.map((m) => m.label),
      ["Default", "opus", "sonnet"],
    );
    assert.deepEqual(
      view.roleOthers.map((group) => group.engine),
      ["codex", "ollama"],
      "another ready engine that takes roles, never a signed-out one",
    );
    assert.equal(
      resolveComposerModel({ studio: false, engines: [claude], modelKey: "claude-code::opus", effort: "max" }).effort,
      undefined,
      "an unknown provider default omits the effort override",
    );
    assert.equal(
      resolveComposerModel({ studio: false, engines: [claude], modelKey: "claude-code::sonnet", effort: "high" })
        .effort,
      undefined,
      "a model with no efforts sends none",
    );
    assert.equal(
      resolveComposerModel({ studio: true, engines: [claude], modelKey: "claude-code::opus", effort: null }).rolesApply,
      false,
      "Studio's chat has one model",
    );
  });

  it("a local engine with a tool model splits the work into roles, and has effort only when it exposes efforts", () => {
    const view = resolveComposerModel({
      studio: false,
      engines: [local, signedOut],
      modelKey: "ollama::qwen",
      effort: null,
    });
    assert.equal(view.rolesApply, true, "a completion-only engine still gives each job its own model");
    assert.deepEqual(view.roleOthers, [], "its workers and reviewers stay on it");
    assert.equal(view.effortApplies, false);
    const toolless = { ...local, models: [model("tiny", { supportsTools: false })] };
    assert.equal(
      resolveComposerModel({ studio: false, engines: [toolless], modelKey: "ollama::tiny", effort: null }).rolesApply,
      false,
      "an engine with no model that can call tools has nothing to split",
    );
    assert.equal(
      resolveComposerModel({ studio: false, engines: [local], modelKey: "gone::model", effort: null }).selected,
      "gone::model",
      "an explicit pick must not become another provider",
    );
  });

  it("preserves the orchestrator and explicit roles when a subscription signs out", () => {
    const view = resolveComposerModel({
      studio: false,
      engines: [claude, codex],
      modelKey: "claude-code::sonnet",
      effort: null,
    });
    const roles = effectiveRoles(
      view,
      { planner: "opus", builder: "gpt", judge: "sonnet", engines: { builder: "codex" } },
      null,
    );
    assert.equal(roles?.planner, "sonnet", "the trigger names the orchestrator");
    assert.equal(roles?.engines?.builder, "codex");
    const alone = resolveComposerModel({
      studio: false,
      engines: [claude],
      modelKey: "claude-code::sonnet",
      effort: null,
    });
    assert.equal(
      effectiveRoles(alone, { planner: "opus", builder: "gpt", judge: "sonnet", engines: { builder: "codex" } }, null)
        ?.engines?.builder,
      "codex",
      "Codex signing out must not switch workers to Claude",
    );
    assert.equal(
      effectiveRoles(
        resolveComposerModel({ studio: true, engines: [claude], modelKey: "claude-code::sonnet", effort: null }),
        { planner: "opus" },
        null,
      ),
      null,
    );
  });
});

describe("the roles a pick opens with", () => {
  const lineup: EngineDescriptor = {
    ...local,
    models: [
      model("coder", { supportsVision: false }),
      model("tiny", { supportsTools: false }),
      model("vl"),
      model("qwen"),
    ],
  };
  const choices = toChoices([claude, lineup]);

  it("gives every job the pick, but on a local engine a pick that cannot see images leaves reviewing to one that can", () => {
    assert.deepEqual(presetRoles("ollama", "qwen", choices), { planner: "qwen", builder: "qwen", judge: "qwen" });
    assert.deepEqual(
      presetRoles("ollama", "coder", choices),
      { planner: "coder", builder: "coder", judge: "vl" },
      "the first installed model that calls tools and sees images",
    );
    assert.deepEqual(
      presetRoles("ollama", "coder", toChoices([{ ...lineup, models: [model("coder", { supportsVision: false })] }])),
      { planner: "coder", builder: "coder", judge: "coder" },
      "with none installed the pick reviews, as before",
    );
    assert.deepEqual(presetRoles("claude-code", "opus", choices), { planner: "opus", builder: "opus", judge: "opus" });
  });

  it("opens a local engine with no saved roles on that preset", () => {
    const store = storage();
    assert.equal(openingRoles(store, "ollama", "coder", choices).judge, "vl");
    assert.equal(openingRoles(store, "ollama", "qwen", choices).judge, "vl", "and keeps what it stamped");
  });
});

describe("one effort for every role", () => {
  it("offers the orchestrator's levels, or the roles' when it has none, and runs each role at its nearest level", () => {
    const picks = { planner: "opus", builder: "gpt", judge: "opus", engines: { builder: "codex" } };
    const view = resolveComposerModel({
      studio: false,
      engines: [claude, codex],
      modelKey: "claude-code::opus",
      effort: "high",
      roles: picks,
    });
    assert.deepEqual(view.efforts, ["low", "high"], "the orchestrator's own scale");
    assert.equal(view.plannerEffort, "high");
    assert.deepEqual(
      view.roles?.efforts,
      { planner: "high", builder: "medium", judge: "high" },
      "the workers' model has only medium",
    );
    const quiet = resolveComposerModel({
      studio: false,
      engines: [claude, codex],
      modelKey: "claude-code::sonnet",
      effort: "medium",
      roles: picks,
    });
    assert.deepEqual(
      quiet.efforts,
      ["low", "medium", "high"],
      "an orchestrator without a dial offers the roles' levels",
    );
    assert.equal(quiet.effortApplies, true);
    assert.equal(quiet.plannerEffort, undefined, "the orchestrator itself sends none");
  });
});

describe("what a send carries", () => {
  const view = resolveComposerModel({
    studio: false,
    engines: [claude, codex],
    modelKey: "claude-code::opus",
    effort: "low",
  });
  const roles = effectiveRoles(view, { planner: "opus", builder: "sonnet", judge: "sonnet" }, "low");
  const game = { ...view, roles, preferences: { fast: true } };

  it("runs the chat on the orchestrator, with the effort the model accepts and the preferences", () => {
    assert.deepEqual(composerSendOptions(game, "claude-code::opus", { autopilot: true }), {
      engine: "claude-code",
      model: "opus",
      effort: "low",
      preferences: { fast: true },
    });
  });

  it("commissions a timed build with its roles, only while no build belongs to the chat", () => {
    const extras = { autopilot: { hours: 3, frames: [], reviewPlan: true }, reviewPlan: true };
    const sent = composerSendOptions(game, "claude-code::opus", { autopilot: true, extras });
    assert.equal(sent.reviewPlan, true);
    assert.deepEqual(
      sent.autopilot && {
        hours: sent.autopilot.hours,
        reviewPlan: sent.autopilot.reviewPlan,
        planner: sent.autopilot.roles?.planner,
        plannerEffort: sent.autopilot.roles?.efforts?.planner,
      },
      { hours: 3, reviewPlan: true, planner: "opus", plannerEffort: "low" },
    );
    assert.equal(
      composerSendOptions(game, "claude-code::opus", { autopilot: false, extras }).autopilot,
      undefined,
      "a message to a running build is not a new commission",
    );
    const noCap = composerSendOptions(game, "claude-code::opus", {
      autopilot: true,
      extras: { autopilot: { hours: null, frames: [] } },
    });
    assert.equal("hours" in (noCap.autopilot ?? {}), false, "no cap sends no hours");
  });

  it("commissions a local build with a model for each job", () => {
    const lineup = { ...local, models: [model("qwen"), model("coder", { supportsVision: false }), model("vl")] };
    const localView = resolveComposerModel({
      studio: false,
      engines: [lineup],
      modelKey: "ollama::qwen",
      effort: null,
      roles: { planner: "qwen", builder: "coder", judge: "vl" },
    });
    const sent = composerSendOptions({ ...localView, preferences: {} }, "ollama::qwen", {
      autopilot: true,
      extras: { autopilot: { hours: 1, frames: [] } },
    });
    assert.equal(sent.engine, "ollama");
    assert.equal(sent.model, "qwen", "the chat itself runs on the main agent");
    const { planner, builder, judge, engines } = sent.autopilot?.roles ?? {};
    assert.deepEqual(
      { planner, builder, judge, engines },
      {
        planner: "qwen",
        builder: "coder",
        judge: "vl",
        engines: undefined,
      },
    );
  });

  it("a subscription's reviewers may be local models, its workers may not", () => {
    const claudeView = resolveComposerModel({
      studio: false,
      engines: [claude, local],
      modelKey: "claude-code::opus",
      effort: null,
    });
    const commission = { autopilot: true, extras: { autopilot: { hours: 1, frames: [] } } };
    const localReviewers = effectiveRoles(
      claudeView,
      { planner: "opus", builder: "sonnet", judge: "qwen", engines: { judge: "ollama" } },
      null,
    );
    const sent = composerSendOptions(
      { ...claudeView, roles: localReviewers, preferences: {} },
      "claude-code::opus",
      commission,
    );
    const { builder, judge, engines } = sent.autopilot?.roles ?? {};
    assert.deepEqual({ builder, judge, engines }, { builder: "sonnet", judge: "qwen", engines: { judge: "ollama" } });
    const localWorkers = effectiveRoles(
      claudeView,
      { planner: "opus", builder: "qwen", engines: { builder: "ollama" } },
      null,
    );
    assert.throws(
      () =>
        composerSendOptions({ ...claudeView, roles: localWorkers, preferences: {} }, "claude-code::opus", commission),
      /unavailable/,
      "a local worker under a subscription is refused before the build, never sent to the subscription",
    );
  });

  it("a local main agent may hand its workers and reviewers to a signed-in subscription", () => {
    const localView = resolveComposerModel({
      studio: false,
      engines: [local, codex],
      modelKey: "ollama::qwen",
      effort: null,
    });
    const roles = effectiveRoles(
      localView,
      { planner: "qwen", builder: "gpt", judge: "gpt", engines: { builder: "codex", judge: "codex" } },
      null,
    );
    const sent = composerSendOptions({ ...localView, roles, preferences: {} }, "ollama::qwen", {
      autopilot: true,
      extras: { autopilot: { hours: 1, frames: [] } },
    });
    assert.equal(sent.model, "qwen");
    assert.deepEqual(sent.autopilot?.roles?.engines, { builder: "codex", judge: "codex" });
  });

  it("a pick on another engine than the roles' sends that model, with no roles", () => {
    const sent = composerSendOptions(game, "codex::gpt", {
      autopilot: true,
      extras: { autopilot: { hours: 1, frames: [] } },
    });
    assert.equal(sent.engine, "codex");
    assert.equal(sent.model, "gpt");
    assert.equal(sent.autopilot?.roles, undefined);
    assert.deepEqual(
      composerSendOptions({ ...game, roles: null, studio: true }, null, { autopilot: true }),
      { effort: "low", preferences: { fast: true } },
      "no model picked sends no engine",
    );
  });
});

describe("what a chat's Loop is", () => {
  const view = resolveComposerModel({ studio: false, engines: [claude], modelKey: "claude-code::opus", effort: null });
  const game = { ...view, roles: null, preferences: {} };
  const infinite = { on: true, hours: null };
  const halfHour = { on: true, hours: 0.5 };
  /** What the chat's composer would send now, through the real send contract. */
  const sendFrom = (store: KeyValueStorage, threadId: string) =>
    composerSendOptions(game, "claude-code::opus", {
      autopilot: true,
      extras: composerExtras({
        gameMode: true,
        view: composerLoopView({ own: storedChatLoop(store, threadId), build: null }),
        reviewPlan: false,
        frames: [],
      }),
    });

  it("keeps a chat's ∞ when another chat picks 30 m (the reported leak)", () => {
    const store = storage({ "studio.composer.loop": "1", "studio.autopilotHours": "inf" });
    pinChatLoop(store, "A");
    rememberChatLoop(store, "B", halfHour);
    assert.deepEqual(storedChatLoop(store, "A"), infinite);
    const sent = sendFrom(store, "A");
    assert.ok(sent.autopilot, "A still commissions a Loop");
    assert.equal("hours" in sent.autopilot, false, "A's build is until satisfied, not B's 30 m");
    assert.equal(sendFrom(store, "B").autopilot?.hours, 0.5);
  });

  it("keeps a chat's Loop off when another chat turns it on", () => {
    const store = storage({ "studio.composer.loop": "0" });
    pinChatLoop(store, "A");
    rememberChatLoop(store, "B", halfHour);
    assert.equal(storedChatLoop(store, "A").on, false);
    assert.equal(sendFrom(store, "A").autopilot, undefined);
  });

  it("a fresh chat starts from the last pick, which the global keys keep", () => {
    const store = storage();
    rememberChatLoop(store, "B", halfHour);
    assert.deepEqual(storedChatLoop(store, "C"), halfHour);
    assert.deepEqual(lastLoop(store), halfHour);
    assert.equal(store.getItem("studio.composer.loop"), "1");
    assert.equal(store.getItem("studio.autopilotHours"), "0.5");
    pinChatLoop(store, "B");
    assert.deepEqual(storedChatLoop(store, "B"), halfHour, "pinning never overwrites a chat's own pick");
  });

  it("Off keeps the saved time", () => {
    const store = storage();
    rememberChatLoop(store, "A", { on: false, hours: 2 });
    assert.equal(store.getItem("studio.autopilotHours"), "2");
    assert.equal(store.getItem("studio.composer.loop"), "0");
    assert.deepEqual(storedChatLoop(store, "A"), { on: false, hours: 2 });
  });

  it("a malformed chat value falls back to the last pick", () => {
    const globals = { "studio.composer.loop": "1", "studio.autopilotHours": "1" };
    for (const bad of ["{not json", JSON.stringify({ on: true, hours: 99 }), JSON.stringify({ on: "yes", hours: 1 })]) {
      assert.deepEqual(storedChatLoop(storage({ ...globals, "studio.loop.A": bad }), "A"), { on: true, hours: 1 }, bad);
    }
    assert.deepEqual(storedChatLoop(storage(globals)), { on: true, hours: 1 }, "no chat reads the last pick");
  });

  it("Mode shows the chat's own Loop with no build or after it finished, and a running or paused build's own limit", () => {
    const own = halfHour;
    assert.deepEqual(composerLoopView({ own, build: null }), { shown: own, editable: true });
    assert.deepEqual(composerLoopView({ own, build: { state: "running", loop: infinite } }), {
      shown: infinite,
      editable: false,
    });
    assert.deepEqual(composerLoopView({ own: infinite, build: { state: "paused", loop: halfHour } }), {
      shown: halfHour,
      editable: false,
    });
    assert.deepEqual(
      composerLoopView({ own, build: { state: "running", loop: null } }).shown,
      infinite,
      "a build whose limit was not kept reads as Loop",
    );
    assert.deepEqual(
      composerLoopView({ own, build: { state: "finished", loop: infinite } }),
      { shown: own, editable: true },
      "after a finished build Mode is the chat's own Loop again, not the build's",
    );
  });

  it("keeps Review plan and the Loop's commission for a finished chat and drops both for a paused one", () => {
    const own = halfHour;
    const extrasFor = (state: "paused" | "finished") =>
      composerExtras({
        gameMode: true,
        view: composerLoopView({ own, build: { state, loop: infinite } }),
        reviewPlan: true,
        frames: [],
      });
    assert.deepEqual(extrasFor("finished"), { reviewPlan: true, autopilot: { hours: 0.5, frames: [] } });
    assert.deepEqual(extrasFor("paused"), {});
    const frames = [{ label: "a", mimeType: "image/png", data: "x" }];
    assert.deepEqual(
      composerExtras({
        gameMode: false,
        view: composerLoopView({ own, build: null }),
        reviewPlan: true,
        frames,
      }),
      { frames },
      "the Studio chat sends its pictures, never a commission",
    );
  });

  it("a Loop commissions a chat with no build or a finished one, never a running or paused build", () => {
    assert.equal(loopCommissions(null), true);
    assert.equal(loopCommissions(undefined), true);
    assert.equal(loopCommissions({ state: "finished" }), true);
    assert.equal(loopCommissions({ state: "running" }), false);
    assert.equal(loopCommissions({ state: "paused" }), false);
  });

  it("a command's result commissions only a chat with no build yet, while a typed message commissions a finished one too", () => {
    assert.equal(reportCommissions(null), true);
    assert.equal(reportCommissions(undefined), true);
    for (const state of ["running", "paused", "finished"] as const)
      assert.equal(reportCommissions({ state }), false, `${state}: a result never commissions`);
    assert.equal(loopCommissions({ state: "finished" }), true);
  });
});

it("submission rejects an unavailable explicit main model or worker instead of substituting", () => {
  const view = resolveComposerModel({
    studio: false,
    engines: [claude, codex],
    modelKey: "codex::gpt-6-sol",
    effort: "high",
  });
  assert.equal(view.selected, "codex::gpt-6-sol");
  assert.ok(view.choices.some((row) => row.key === view.selected && row.disabled));
  assert.throws(
    () => composerSendOptions({ ...view, preferences: {} }, view.selected, { autopilot: false }),
    /unavailable/i,
  );
  const other = resolveComposerModel({
    studio: false,
    engines: [claude],
    modelKey: "claude-code::opus",
    effort: "high",
    roles: { planner: "opus", builder: "gpt-6-sol", engines: { builder: "codex" } },
  });
  assert.throws(
    () =>
      composerSendOptions({ ...other, preferences: {} }, other.selected, {
        autopilot: true,
        extras: { autopilot: { hours: null, frames: [] } },
      }),
    /unavailable/i,
  );
});

it("submission rejects a default worker on a signed-out or missing provider", () => {
  for (const engines of [
    [claude, { ...codex, models: [], status: { code: "needs_login" as const, detail: "" } }],
    [claude],
  ]) {
    const view = resolveComposerModel({
      studio: false,
      engines,
      modelKey: "claude-code::opus",
      effort: null,
      roles: { planner: "opus", builder: "default", engines: { builder: "codex" } },
    });
    assert.throws(
      () =>
        composerSendOptions({ ...view, preferences: {} }, view.selected, {
          autopilot: true,
          extras: { autopilot: { hours: null, frames: [] } },
        }),
      /unavailable/i,
    );
  }
});

describe("a send's Loop commission", () => {
  it("drops ∞ hours and empty pictures, and carries plan review and roles only when set", () => {
    const frames = [{ label: "ref", mimeType: "image/png", data: "AA==" }];
    const roles = { planner: "opus", builder: "default" };
    assert.deepEqual(autopilotSendOptions({ hours: null, frames: [] }, null), {});
    assert.deepEqual(autopilotSendOptions({ hours: 2, frames, reviewPlan: true }, roles), {
      hours: 2,
      frames,
      reviewPlan: true,
      roles,
    });
    assert.deepEqual(autopilotSendOptions({ hours: 0.5, frames: [], reviewPlan: false }, null), { hours: 0.5 });
  });
});
