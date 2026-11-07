/**
 * The composer's model (src/renderer/chat/use-composer-model.ts): what a chat opens with, and what
 * it derives from the engines and its own picks — tested through the pure rules the hook applies.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  composerOpening,
  composerSendOptions,
  effectiveRoles,
  effortOnModelPick,
  pinComposerOpening,
  pickedKeys,
  pickReplaced,
  rememberEffortPick,
  rereadsWanted,
  resolveComposerModel,
  sendBlockOf,
} from "../../src/renderer/chat/use-composer-model.ts";
import { createEnginesStore, REREAD_UNAVAILABLE } from "../../src/renderer/state/engines.ts";
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

describe("a saved model the plan no longer offers", () => {
  const notOffered = (engines: EngineDescriptor[], modelKey: string) =>
    resolveComposerModel({ studio: false, engines, modelKey, effort: null });

  it("opens on a model that runs, so the picker, the panel and the send name the same one", () => {
    const view = notOffered([claude, codex], "codex::gpt-5.5");
    assert.equal(view.selected?.split("::")[0], "claude-code", "the first model the person can run");
    assert.equal(view.selectedEngine?.id, "claude-code");
    assert.ok(!view.choices.some((choice) => choice.key === "codex::gpt-5.5"), "no row for a model nobody can run");
  });

  it("keeps the saved pick while its provider's models are still being read", () => {
    const catalog = (state: string, refreshing = false) =>
      ({ ...codex, catalog: { state, revision: 1, refreshing } }) as EngineDescriptor;
    for (const unsure of [catalog("loading"), catalog("unavailable"), catalog("stale"), catalog("ready", true)])
      assert.equal(
        notOffered([claude, unsure], "codex::gpt-5.5").selected,
        "codex::gpt-5.5",
        `a ${unsure.catalog?.state} list is not proof the model is gone`,
      );
    const listedAgain = resolveComposerModel({
      studio: false,
      engines: [claude, { ...catalog("ready"), catalog: { state: "ready", revision: 2, refreshing: false } }],
      modelKey: "codex::gpt-5.5",
      effort: null,
      rereads: { codex: 1 },
    });
    assert.equal(listedAgain.selected?.split("::")[0], "claude-code");
    assert.equal(
      notOffered([], "codex::gpt-5.5").selected,
      "codex::gpt-5.5",
      "nothing is known before the engines are",
    );
  });

  it("keeps a signed-out provider's pick, where the sign-in is asked for", () => {
    const out: EngineDescriptor = { ...codex, status: { code: "needs_login", detail: "" } };
    assert.equal(notOffered([claude, out], "codex::gpt-5.5").selected?.split("::")[0], "codex");
  });

  it("gives the workers and reviewers of a dropped local model the model that replaced it", () => {
    // Field case (0.1.25): Ollama lost the model every job was on; the chat opened on the one left,
    // and the workers and reviewers were still sent to the model that was gone.
    const left = { ...local, models: [model("small")] };
    const dropped = { planner: "big", builder: "big", judge: "big" };
    const view = resolveComposerModel({
      studio: false,
      engines: [left],
      modelKey: "ollama::big",
      effort: null,
      roles: dropped,
    });
    assert.equal(view.selected, "ollama::small");
    assert.deepEqual(
      { planner: view.roles?.planner, builder: view.roles?.builder, judge: view.roles?.judge },
      { planner: "small", builder: "small", judge: "small" },
    );
    const sent = composerSendOptions({ ...view, preferences: {} }, "ollama::small");
    assert.equal(sent.roles?.builder, "small", "a worker the turn hires runs on the model that is there");

    const reading = { ...left, catalog: { state: "loading", revision: 1, refreshing: false } } as EngineDescriptor;
    const unsure = resolveComposerModel({
      studio: false,
      engines: [reading],
      modelKey: "ollama::small",
      effort: null,
      roles: { planner: "small", builder: "big", judge: "big" },
    });
    assert.equal(unsure.roles?.builder, "big", "a list still being read is not proof the model is gone");
  });

  it("keeps a worker on a signed-out subscription, and moves one whose subscription dropped its model", () => {
    const crossed = {
      planner: "qwen",
      builder: "gpt-old",
      judge: "gpt-old",
      engines: { builder: "codex", judge: "codex" },
    };
    const out: EngineDescriptor = { ...codex, status: { code: "needs_login", detail: "" } };
    const kept = resolveComposerModel({
      studio: false,
      engines: [local, out],
      modelKey: "ollama::qwen",
      effort: null,
      roles: crossed,
    });
    assert.deepEqual(
      kept.roles?.engines,
      { builder: "codex", judge: "codex" },
      "the sign-in is asked for, the pick stays",
    );
    const moved = resolveComposerModel({
      studio: false,
      engines: [local, codex],
      modelKey: "ollama::qwen",
      effort: null,
      roles: crossed,
    });
    assert.deepEqual(
      { builder: moved.roles?.builder, judge: moved.roles?.judge, engines: moved.roles?.engines },
      { builder: "qwen", judge: "qwen", engines: undefined },
      "a model the ready subscription no longer lists falls back to the chat's own preset",
    );
  });
});

describe("a saved model one listing left out", () => {
  // Field case (Windows, 0.1.34): after each restart the chat's OpenCode model was swapped out and
  // every Send refused. OpenCode lists the models of its cached models.dev catalog, and its built-in
  // one while that cache is missing; a later listing named the model again.
  const opencode = (revision: number, refreshing = false): EngineDescriptor => ({
    id: "opencode",
    label: "OpenCode",
    kind: "delegated",
    supportsSessions: true,
    status: { code: "ready", detail: "" },
    defaultModel: null,
    models: [model("openrouter/old-model")],
    catalog: { state: "ready", revision, refreshing },
  });
  const pick = "opencode::openrouter/new-model";
  const view = (engines: EngineDescriptor[], rereads: Record<string, number> = {}) =>
    resolveComposerModel({ studio: false, engines, modelKey: pick, effort: null, rereads });

  it("keeps the pick and asks its provider to list its models again", () => {
    const engines = [claude, opencode(1)];
    assert.equal(view(engines).selected, pick, "one listing is not proof the model is gone");
    const choices = toChoices(engines);
    assert.deepEqual(rereadsWanted({ engines, choices, keys: [pick], rereads: {} }), [
      { engine: "opencode", revision: 1 },
    ]);
    assert.deepEqual(
      rereadsWanted({ engines, choices, keys: [pick], rereads: { opencode: 1 } }),
      [],
      "asked once per run",
    );
    assert.deepEqual(
      rereadsWanted({ engines, choices, keys: ["opencode::openrouter/old-model"], rereads: {} }),
      [],
      "a listed pick needs no second listing",
    );
  });

  it("counts the pick gone only once a newer listing leaves it out too", () => {
    assert.equal(view([claude, opencode(1)], { opencode: 1 }).selected, pick, "the second listing has not landed");
    assert.equal(view([claude, opencode(2, true)], { opencode: 1 }).selected, pick, "the second listing is running");
    const gone = view([claude, opencode(2)], { opencode: 1 });
    assert.equal(gone.selected?.split("::")[0], "claude-code", "the chat opens on a model that runs");
    assert.equal(
      pickReplaced({
        engines: [claude, opencode(2)],
        choices: toChoices([claude, opencode(2)]),
        modelKey: pick,
        selected: gone.selected,
        rereads: { opencode: 1 },
      }),
      "model_dropped",
    );
    assert.equal(
      pickReplaced({
        engines: [claude, opencode(1)],
        choices: toChoices([claude, opencode(1)]),
        modelKey: pick,
        selected: claude.id,
        rereads: {},
      }),
      null,
      "no swap is counted before the second listing",
    );
    const listedNow = { ...opencode(2), models: [model("openrouter/new-model")] };
    assert.equal(view([claude, listedNow], { opencode: 1 }).selected, pick, "the second listing names it");
  });

  it("takes a provider that cannot list again at its first listing", () => {
    assert.equal(view([claude, opencode(1)], { opencode: REREAD_UNAVAILABLE }).selected?.split("::")[0], "claude-code");
  });

  it("asks for the workers' and reviewers' models too", () => {
    const roles = {
      planner: "openrouter/old-model",
      builder: "openrouter/new-model",
      engines: { judge: "codex" },
      judge: "gpt",
    };
    assert.deepEqual(pickedKeys("opencode::openrouter/old-model", roles, "opencode"), [
      "opencode::openrouter/old-model",
      "opencode::openrouter/new-model",
      "codex::gpt",
    ]);
    assert.deepEqual(pickedKeys(null, null, "opencode"), []);
  });
});

describe("listing a provider's models again (engines store)", () => {
  const api = (refused: boolean) => {
    const asked: string[] = [];
    let reads = 0;
    return {
      asked,
      reads: () => reads,
      engines: async () => {
        reads++;
        return [];
      },
      refreshModels: async (provider: string) => {
        asked.push(provider);
        if (refused) throw new Error("unknown provider");
        return true;
      },
    };
  };

  it("asks once per provider, then reads the engines again", async () => {
    const fake = api(false);
    const store = createEnginesStore(fake);
    assert.equal(store.reread("opencode", 3), true);
    assert.equal(store.reread("opencode", 4), false, "a second ask is not made");
    assert.deepEqual(store.getState().rereads, { opencode: 3 });
    await setImmediate();
    await store.refresh();
    assert.deepEqual(fake.asked, ["opencode"]);
    assert.ok(fake.reads() >= 1, "the engines are read again after the listing");
    assert.deepEqual(store.getState().rereads, { opencode: 3 });
  });

  it("marks a provider that cannot list again, so its first listing stands", async () => {
    const store = createEnginesStore(api(true));
    store.reread("ollama", 2);
    await setImmediate();
    assert.deepEqual(store.getState().rereads, { ollama: REREAD_UNAVAILABLE });
  });
});

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
    assert.equal(view.effortApplies, false);
    const toolless = { ...local, models: [model("tiny", { supportsTools: false })] };
    assert.equal(
      resolveComposerModel({ studio: false, engines: [toolless], modelKey: "ollama::tiny", effort: null }).rolesApply,
      false,
      "an engine with no model that can call tools has nothing to split",
    );
    assert.equal(
      resolveComposerModel({ studio: false, engines: [local], modelKey: "gone::model", effort: null }).selected,
      "ollama::qwen",
      "a pick whose provider is gone opens on a model that runs, and the picker names that one",
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

  it("runs the chat on the orchestrator, with the effort the model accepts, the preferences and the roles", () => {
    assert.deepEqual(composerSendOptions(game, "claude-code::opus"), {
      engine: "claude-code",
      model: "opus",
      effort: "low",
      preferences: { fast: true },
      roles,
    });
  });

  it("the roles a game chat picked ride every send, with plan review and pictures beside them and no Loop commission", () => {
    const frames = [{ label: "ref", mimeType: "image/png", data: "AA==" }];
    const sent = composerSendOptions(game, "claude-code::opus", { reviewPlan: true, frames });
    assert.equal(sent.reviewPlan, true);
    assert.deepEqual(sent.frames, frames);
    assert.deepEqual(
      { planner: sent.roles?.planner, plannerEffort: sent.roles?.efforts?.planner },
      { planner: "opus", plannerEffort: "low" },
    );
    assert.equal("autopilot" in sent, false);
    assert.equal("loop" in sent, false);
  });

  it("a local main agent sends a model for each job", () => {
    const lineup = { ...local, models: [model("qwen"), model("coder", { supportsVision: false }), model("vl")] };
    const localView = resolveComposerModel({
      studio: false,
      engines: [lineup],
      modelKey: "ollama::qwen",
      effort: null,
      roles: { planner: "qwen", builder: "coder", judge: "vl" },
    });
    const sent = composerSendOptions({ ...localView, preferences: {} }, "ollama::qwen");
    assert.equal(sent.engine, "ollama");
    assert.equal(sent.model, "qwen", "the chat itself runs on the main agent");
    const { planner, builder, judge, engines } = sent.roles ?? {};
    assert.deepEqual(
      { planner, builder, judge, engines },
      { planner: "qwen", builder: "coder", judge: "vl", engines: undefined },
    );
  });

  it("a subscription's reviewers may be local models; a local worker under it is sent too, and only the worker's start refuses it", () => {
    const claudeView = resolveComposerModel({
      studio: false,
      engines: [claude, local],
      modelKey: "claude-code::opus",
      effort: null,
    });
    const localReviewers = effectiveRoles(
      claudeView,
      { planner: "opus", builder: "sonnet", judge: "qwen", engines: { judge: "ollama" } },
      null,
    );
    const sent = composerSendOptions({ ...claudeView, roles: localReviewers, preferences: {} }, "claude-code::opus");
    const { builder, judge, engines } = sent.roles ?? {};
    assert.deepEqual({ builder, judge, engines }, { builder: "sonnet", judge: "qwen", engines: { judge: "ollama" } });
    const localWorkers = effectiveRoles(
      claudeView,
      { planner: "opus", builder: "qwen", engines: { builder: "ollama" } },
      null,
    );
    const withWorkers = { ...claudeView, roles: localWorkers, preferences: {} };
    assert.equal(sendBlockOf(withWorkers, "claude-code::opus"), null, "a chat message is never blocked by a role");
    assert.equal(composerSendOptions(withWorkers, "claude-code::opus").engine, "claude-code");
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
    const sent = composerSendOptions({ ...localView, roles, preferences: {} }, "ollama::qwen");
    assert.equal(sent.model, "qwen");
    assert.deepEqual(sent.roles?.engines, { builder: "codex", judge: "codex" });
  });

  it("a pick on another engine than the roles' sends that model, with no roles", () => {
    const sent = composerSendOptions(game, "codex::gpt");
    assert.equal(sent.engine, "codex");
    assert.equal(sent.model, "gpt");
    assert.equal(sent.roles, undefined);
    assert.deepEqual(
      composerSendOptions({ ...game, roles: null, studio: true }, null),
      { effort: "low", preferences: { fast: true } },
      "no model picked sends no engine",
    );
  });
});

it("submission rejects an unavailable main model it is handed, never sending it as another; a worker's model blocks nothing", () => {
  const view = resolveComposerModel({
    studio: false,
    engines: [claude, codex],
    modelKey: "codex::gpt-6-sol",
    effort: "high",
  });
  assert.notEqual(view.selected, "codex::gpt-6-sol", "the composer itself opens on a model that runs");
  assert.throws(() => composerSendOptions({ ...view, preferences: {} }, "codex::gpt-6-sol"), /unavailable/i);
  const other = resolveComposerModel({
    studio: false,
    engines: [claude],
    modelKey: "claude-code::opus",
    effort: "high",
    roles: { planner: "opus", builder: "gpt-6-sol", engines: { builder: "codex" } },
  });
  const sent = composerSendOptions({ ...other, preferences: {} }, other.selected);
  assert.equal(sent.roles?.builder, "gpt-6-sol", "the worker's pick goes with the message; its start refuses it");
});

it("a default worker on a signed-out or missing provider blocks no message", () => {
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
    assert.equal(sendBlockOf(view, view.selected), null);
  }
});
