import { MODEL_PICKER_WORDS } from "../words.ts";
/**
 * The composer's model: which model this chat sends with, at what effort, with which roles and
 * preferences. A game chat keeps its own model and effort; roles are kept per engine and
 * preferences per model, and the last picks seed a fresh chat.
 *
 * The rules are pure (`composerOpening`, `resolveComposerModel`, and the effort writes
 * `pinComposerOpening`, `effortOnModelPick`, `rememberEffortPick`) so they are tested in Node; the
 * hook keeps the picks a chat has made in this session and writes them back.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../shared/i18n.ts";
import { normalizeRoles } from "../../shared/model-roles.ts";
import { supportedPreferences, type ModelPreferences } from "../../shared/model-preferences.ts";
import {
  autoChoice,
  effortScale,
  findChoice,
  nearestEffort,
  resolveChoice,
  toChoices,
  unifiedEffort,
  withRoleEfforts,
} from "../model-choices.ts";
import { openingRoles, presetRoles, readStoredRoles, storeRoles } from "../role-store.ts";
import { readJson, safeStorage, STORAGE_KEYS, storageKeyFor, type KeyValueStorage } from "../storage.ts";
import { useEngines, useModelPicker } from "../state/hooks.ts";
import { REREAD_UNAVAILABLE } from "../state/engines.ts";
import { studio } from "../state/studio.ts";
import { rememberChatEffort, rememberChatModel, storedChatEffort, storedChatModel } from "../stored-model.ts";
import type { EngineDescriptor, ThreadMeta } from "../types.ts";
import { ThreadKind } from "../../shared/event-log.ts";
import { ModelCatalogState } from "../../shared/model-catalog.ts";
import { EngineKind, EngineStatusCode, splitsRoles } from "../../shared/engine-descriptor.ts";
import { modelKey as keyOf, parseModelKey } from "../model-key.ts";
import type { ComposerSendOptions } from "../../shared/composer.ts";
import type { ComposerExtras, ComposerModelProps, ModelChoice, RoleRecord } from "../ui/PromptBar.tsx";
import { EffortRefOther, ModelReplaced, ModelSetting, SendBlock } from "../analytics/chat-vocabulary.ts";
import { chatMemory } from "../analytics/chat-memory.ts";
import { effortRef, engineRef, modelPickedProperties } from "../analytics/chat-properties.ts";
import { track } from "../analytics/client.ts";
import { AnalyticsEvent } from "../analytics/events.ts";

/** The jobs beside the chat itself: its workers and its reviewers. */
const HELPER_ROLES = ["builder", "judge"] as const;

/**
 * What a chat opens with: its own remembered model (a fresh game chat inherits the last pick, and
 * Studio keeps its own), and its effort — for a game chat its own pick, else the effort its last
 * turn ran at, else the one saved for its model, else the last picked anywhere
 * (`storedChatEffort`); Studio's is the one saved for its model.
 */
export function composerOpening(
  storage: KeyValueStorage,
  thread: { id: string; meta: ThreadMeta },
): { modelKey: string | null; effort: string | null } {
  const modelKey = storedChatModel(storage, thread.id, thread.meta);
  // An unset last engine reads "undefined" in the key, as it always has in stored effort keys.
  const lastKey = keyOf(`${thread.meta.lastEngine}`, thread.meta.lastModel ?? "");
  return { modelKey, effort: storedChatEffort(storage, thread, modelKey ?? lastKey) };
}

/**
 * Opens a chat on its `composerOpening` and pins it: a game chat keeps the model and effort it
 * opened with, even when the per-model ones change later.
 */
export function pinComposerOpening(
  storage: KeyValueStorage,
  thread: { id: string; meta: ThreadMeta },
): { modelKey: string | null; effort: string | null } {
  const studio = thread.meta.kind !== ThreadKind.Game;
  const opening = composerOpening(storage, thread);
  if (opening.modelKey) rememberChatModel(storage, thread.id, opening.modelKey, studio);
  if (!studio && opening.effort) rememberChatEffort(storage, thread.id, opening.effort);
  return opening;
}

/**
 * The effort a chat takes when a model is picked in it: Studio adopts the one saved for that
 * model; a game chat keeps its own, at the new model's nearest level (`resolveComposerModel`).
 */
export function effortOnModelPick(
  storage: KeyValueStorage,
  studio: boolean,
  key: string,
  current: string | null,
): string | null {
  return studio ? storage.getItem(storageKeyFor.effort(studio, key)) : current;
}

/**
 * Keeps an effort picked in a chat: a game chat's as its own, and every chat's as its model's,
 * which still seeds fresh chats on that model. Null forgets both.
 */
export function rememberEffortPick(
  storage: KeyValueStorage,
  chat: { threadId: string | undefined; studio: boolean; modelKey: string | null },
  value: string | null,
): void {
  if (!chat.studio && chat.threadId) rememberChatEffort(storage, chat.threadId, value);
  const perModel = storageKeyFor.effort(chat.studio, chat.modelKey);
  if (value) storage.setItem(perModel, value);
  else storage.removeItem(perModel);
}

export interface ComposerModelView {
  studio: boolean;
  choices: ModelChoice[];
  /** The pick as the choices resolve it (provider defaults remain defaults). */
  selected: string | null;
  selectedEngine: EngineDescriptor | undefined;
  /**
   * The levels the one effort control offers: the orchestrator's own, or — when it has none —
   * the other roles' (model-choices.ts `effortScale`).
   */
  efforts: string[];
  /** The one effort every role runs at (each at the closest level its model accepts). */
  effort: string | undefined;
  /** The effort the chat itself (the orchestrator) sends with. */
  plannerEffort: string | undefined;
  /** Whether the effort control applies: some role's model has a reasoning dial. */
  effortApplies: boolean;
  /** Game chats on an engine that splits roles (`splitsRoles`) give each job its own model. */
  rolesApply: boolean;
  roleModels: Array<{ id: string; label: string }>;
  /** The roles a send carries, efforts resolved (`effectiveRoles`); null where roles do not apply. */
  roles: RoleRecord | null;
}

const modelRow = (m: { id: string; label: string }) => ({
  id: m.id,
  label: m.id === "default" ? t("Default") : m.label,
});
type RoleView = Pick<ComposerModelView, "choices" | "selected" | "selectedEngine" | "rolesApply">;

/**
 * The roles as picked: preserve explicit provider/model choices across sign-in failures,
 * and set the orchestrator to the selected
 * model — each model named as the picker names it, at its own default effort.
 */
function rolePicks(
  view: RoleView,
  roles: RoleRecord | null,
  engines: readonly EngineDescriptor[] = [],
  rereads: Rereads = {},
): RoleRecord | null {
  if (!view.rolesApply) return null;
  if (!roles || !view.selectedEngine) return null;
  const next = normalizeRoles(view.selectedEngine.id, roles);
  if (!next) return null;
  next.planner = parseModelKey(view.selected).model || undefined;
  const offered = withoutDroppedModels(next, view, { engines, rereads });
  return withRoleEfforts(offered, view.choices, view.selectedEngine.id, null);
}

/**
 * A worker's or reviewer's model its provider no longer offers, known for sure (`noLongerOffered`),
 * goes back to the preset for the chat's own pick: the chat already opened on a model that runs,
 * and no worker or reviewer may be hired onto a model that is gone. A provider that is signed out
 * or not listed keeps its job, where the sign-in is asked for.
 */
function withoutDroppedModels(roles: RoleRecord, view: RoleView, listings: Listings): RoleRecord {
  const engine = view.selectedEngine?.id;
  if (!engine) return roles;
  const dropped = HELPER_ROLES.filter((role) => {
    const provider = roles.engines?.[role] ?? engine;
    const listed = listings.engines.some((candidate) => candidate.id === provider);
    const choice = resolveChoice(view.choices, keyOf(provider, roles[role] ?? ""));
    return listed && noLongerOffered(choice, view.choices, listings);
  });
  if (!dropped.length) return roles;
  const preset = presetRoles(engine, roles.planner, view.choices);
  const next: RoleRecord = { ...roles };
  for (const role of dropped) next[role] = preset[role];
  const crossed = Object.entries(roles.engines ?? {}).filter(([role]) => !dropped.some((gone) => gone === role));
  if (crossed.length) next.engines = Object.fromEntries(crossed);
  else delete next.engines;
  return next;
}

/** The roles a send carries: the picks (`rolePicks`), every role at the one effort its model accepts. */
export function effectiveRoles(
  view: RoleView,
  roles: RoleRecord | null,
  effort: string | null | undefined,
): RoleRecord | null {
  const picks = rolePicks(view, roles);
  return picks && view.selectedEngine
    ? withRoleEfforts(picks, view.choices, view.selectedEngine.id, effort ?? null)
    : null;
}

/** Engine id → the catalog revision a re-read of its models was asked at (`state/engines.ts`). */
export type Rereads = Readonly<Record<string, number>>;

/** The engines as main describes them, and which of them listed their models again. */
interface Listings {
  engines: readonly EngineDescriptor[];
  rereads: Rereads;
}

/**
 * A saved pick its provider no longer offers (a model the plan dropped, a provider gone), known for
 * sure: the provider is ready with a fresh model list that left it out twice (`listedAgain`), or
 * is not there at all. The chat then opens on a model that runs instead, and the picker, the panel
 * and the send all name that one. A pick whose provider is still reading its models, or is signed
 * out (the sign-in is asked for), stays.
 */
function noLongerOffered(
  choice: ModelChoice | undefined,
  choices: readonly ModelChoice[],
  listings: Listings,
): boolean {
  if (!choice || choices.includes(choice) || !listings.engines.length) return false;
  const engine = parseModelKey(choice.key).engine;
  if (!listings.engines.some((candidate) => candidate.id === engine)) return true;
  const missing = listingWithout(choice, choices, listings.engines);
  return missing !== undefined && listedAgain(missing, listings.rereads);
}

/**
 * The ready provider whose fresh, complete list leaves a saved pick out; undefined while the pick
 * is listed, its provider is not ready, or its list is loading, stale or failed (it may still name it).
 */
function listingWithout(
  choice: ModelChoice | undefined,
  choices: readonly ModelChoice[],
  engines: readonly EngineDescriptor[],
): EngineDescriptor | undefined {
  if (!choice || choices.includes(choice)) return undefined;
  const engine = engines.find((candidate) => candidate.id === parseModelKey(choice.key).engine);
  if (engine?.status.code !== EngineStatusCode.Ready) return undefined;
  const catalog = engine.catalog;
  const settled = !catalog || (catalog.state === ModelCatalogState.Ready && !catalog.refreshing);
  return settled ? engine : undefined;
}

/**
 * Has the provider listed its models again since a pick went missing from its list: one listing
 * is not proof, since a first one after launch can be partial (OpenCode lists its built-in catalog
 * while its cached one is missing). A provider with no catalog revisions is taken at its word.
 */
function listedAgain(engine: EngineDescriptor, rereads: Rereads): boolean {
  const asked = rereads[engine.id];
  if (!engine.catalog) return true;
  return asked !== undefined && engine.catalog.revision > asked;
}

/**
 * The providers to ask for their models again (`EnginesStore.reread`): ready ones whose fresh list
 * leaves out the chat's pick or one of its workers' or reviewers' models, not asked yet this run,
 * each with the catalog revision the missing pick was seen at.
 */
export function rereadsWanted(input: {
  engines: readonly EngineDescriptor[];
  choices: ModelChoice[];
  keys: ReadonlyArray<string | null>;
  rereads: Rereads;
}): Array<{ engine: string; revision: number }> {
  const wanted = new Map<string, number>();
  for (const key of input.keys) {
    if (!key) continue;
    const engine = listingWithout(resolveChoice(input.choices, key), input.choices, input.engines);
    if (!engine?.catalog || input.rereads[engine.id] !== undefined) continue;
    wanted.set(engine.id, engine.catalog.revision);
  }
  return [...wanted].map(([engine, revision]) => ({ engine, revision }));
}

/** The keys a chat's picks name: its own model, and its workers' and reviewers' on their providers. */
export function pickedKeys(modelKey: string | null, roles: RoleRecord | null, engine: string | undefined): string[] {
  const own = modelKey ? [modelKey] : [];
  if (!roles || !engine) return own;
  const helpers = HELPER_ROLES.flatMap((role) =>
    roles[role] ? [keyOf(roles.engines?.[role] ?? engine, roles[role] ?? "")] : [],
  );
  return [...own, ...helpers];
}

/**
 * Why the chat's saved pick was swapped for another model it can run on (`resolveComposerModel`):
 * its provider is gone, or the provider dropped the model; null when the pick stands.
 */
export function pickReplaced(input: {
  engines: EngineDescriptor[];
  choices: ModelChoice[];
  modelKey: string | null;
  selected: string | null;
  rereads?: Rereads;
}): ModelReplaced | null {
  const { engines, choices, modelKey, selected } = input;
  if (!modelKey || selected === null) return null;
  const resolved = resolveChoice(choices, modelKey);
  const listings = { engines, rereads: input.rereads ?? {} };
  if (!noLongerOffered(resolved, choices, listings) || resolved?.key === selected) return null;
  const engine = parseModelKey(modelKey).engine;
  return engines.some((candidate) => candidate.id === engine) ? ModelReplaced.ModelDropped : ModelReplaced.ProviderGone;
}

/** A model picked in the composer, with the one before it. */
function trackModelPick(pick: {
  key: string;
  previousKey: string | null;
  choices: readonly ModelChoice[];
  engines: readonly EngineDescriptor[];
}): void {
  const engine = parseModelKey(pick.key).engine;
  const picked = {
    key: pick.key,
    previousKey: pick.previousKey,
    free: pick.choices.some((choice) => choice.key === pick.key && choice.free === true),
    engineKind: pick.engines.find((candidate) => candidate.id === engine)?.kind,
  };
  track(AnalyticsEvent.ModelPicked, modelPickedProperties(chatMemory, picked, Date.now()));
}

/**
 * A saved pick swapped without a word to the person, counted once per chat and pick, and whether a
 * second listing of its provider's models left it out too (false: the provider could not list again).
 */
function useReplacedPick(
  threadId: string | undefined,
  modelKey: string | null,
  replaced: ModelReplaced | null,
  rereads: Rereads,
): void {
  const counted = useRef<string | null>(null);
  useEffect(() => {
    if (!replaced || !modelKey) return;
    const mark = `${threadId}\n${modelKey}`;
    if (counted.current === mark) return;
    counted.current = mark;
    const engine = parseModelKey(modelKey).engine;
    const asked = rereads[engine];
    track(AnalyticsEvent.ModelPickReplaced, {
      engine: engineRef(engine),
      reason: replaced,
      listed_again: asked !== undefined && asked !== REREAD_UNAVAILABLE,
    });
  }, [threadId, modelKey, replaced, rereads]);
}

/** Asks each provider whose list left out a saved pick to list its models again (once per run). */
function useRereadMissingPicks(wanted: Array<{ engine: string; revision: number }>): void {
  const signature = wanted.map(({ engine, revision }) => `${engine}@${revision}`).join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the signature names every wanted re-read
  useEffect(() => {
    for (const { engine, revision } of wanted)
      if (studio().engines.reread(engine, revision))
        track(AnalyticsEvent.ModelListReread, { engine: engineRef(engine) });
  }, [signature]);
}

/** Everything the composer derives from the engines and the chat's own picks (roles and effort). */
export function resolveComposerModel(input: {
  studio: boolean;
  engines: EngineDescriptor[];
  choices?: ModelChoice[];
  modelKey: string | null;
  effort: string | null;
  roles?: RoleRecord | null;
  /** Which providers listed their models again since a pick went missing (`EnginesStore.reread`). */
  rereads?: Rereads;
}): ComposerModelView {
  const choices = [...(input.choices ?? toChoices(input.engines))];
  const rereads = input.rereads ?? {};
  const resolved = resolveChoice(choices, input.modelKey);
  const dropped = noLongerOffered(resolved, choices, { engines: input.engines, rereads });
  const choice = dropped ? (autoChoice(choices) ?? resolved) : resolved;
  if (choice && !choices.some((row) => row.key === choice.key)) choices.push(choice);
  const selected = choice?.key ?? null;
  const selectedChoice = choices.find((choice) => choice.key === selected);
  const selectedEngine = input.engines.find((engine) => engine.id === parseModelKey(selected).engine);
  const rolesApply = Boolean(
    !input.studio && selectedEngine && splitsRoles(selectedEngine) && selectedEngine.models.length > 0,
  );
  const view: RoleView = { choices, selected, selectedEngine, rolesApply };
  // One effort for every role: the control offers the orchestrator's levels, and each worker and
  // judge model runs at the closest level it accepts.
  const picks = rolePicks(view, input.roles ?? null, input.engines, rereads);
  const roleChoice = (role: "builder" | "judge"): ModelChoice | undefined =>
    picks && selectedEngine
      ? findChoice(choices, `${picks.engines?.[role] ?? selectedEngine.id}::${picks[role] ?? ""}`)
      : undefined;
  const efforts = effortScale(selectedChoice, picks ? [roleChoice("builder"), roleChoice("judge")] : []);
  const effort = unifiedEffort(efforts, input.effort, selectedChoice);
  return {
    studio: input.studio,
    ...view,
    efforts,
    effort,
    plannerEffort: nearestEffort(effort, selectedChoice?.efforts),
    effortApplies: efforts.length > 0,
    roleModels: rolesApply && selectedEngine ? selectedEngine.models.map(modelRow) : [],
    roles: picks && selectedEngine ? withRoleEfforts(picks, choices, selectedEngine.id, effort) : null,
  };
}

/**
 * What a send carries. `key` is the model the send goes with. The chat runs on the orchestrator; the
 * workers' and judges' models (`roles`) ride along on every send where the roles panel applies: the
 * chat's own workers take them, and so does a Loop the turn starts (model-roles.ts).
 */
export function composerSendOptions(
  model: Pick<ComposerModelView, "studio" | "selectedEngine" | "plannerEffort" | "choices"> & {
    roles: RoleRecord | null;
    preferences: ModelPreferences;
  },
  key: string | null,
  extras?: ComposerExtras,
): ComposerSendOptions {
  const { engine, model: pickedModel } = parseModelKey(key);
  const roles = model.studio ? null : sendRoles(model, engine);
  if (sendBlockOf(model, key)) throw new Error(MODEL_PICKER_WORDS.unavailable);
  const sendModel = roles ? (roles.planner ?? "") : pickedModel;
  const explicitModel = isExplicitModel(sendModel);
  return {
    ...(engine ? { engine } : {}),
    ...(explicitModel ? { model: sendModel } : {}),
    ...(model.plannerEffort ? { effort: model.plannerEffort } : {}),
    preferences: model.preferences,
    ...(extras?.reviewPlan ? { reviewPlan: true } : {}),
    ...(extras?.frames?.length ? { frames: extras.frames } : {}),
    ...(extras?.mentions?.length ? { mentions: extras.mentions } : {}),
    ...(roles ? { roles } : {}),
  };
}

function isExplicitModel(model: string | undefined): boolean {
  return Boolean(model) && model !== "default";
}

/** The roles a send on this engine carries: the chat's own, when the send goes with its selected engine. */
function sendRoles(model: Pick<ComposerModelView, "selectedEngine"> & { roles: RoleRecord | null }, engine: string) {
  return model.roles && engine === model.selectedEngine?.id ? model.roles : null;
}

/** The model is offered and can be picked (no key asks for nothing). */
function choiceAvailable(choices: ModelChoice[], key: string | null): boolean {
  if (!key) return true;
  const choice = resolveChoice(choices, key);
  return Boolean(choice && !choice.disabled);
}

/**
 * Why a send on this model cannot go: the model is no longer offered; null when it can. A role's
 * model never blocks a message: only the worker or judge call that needs it is refused.
 * `composerSendOptions` refuses exactly these.
 */
export function sendBlockOf(model: Pick<ComposerModelView, "choices">, key: string | null): SendBlock | null {
  return choiceAvailable(model.choices, key) ? null : SendBlock.ModelUnavailable;
}

/** The model a chat shows: its pick made this session, else the one it remembers. */
function pickedKey(
  pick: { thread?: string; key: string | null },
  thread: { id: string; meta: ThreadMeta } | null,
  storage: KeyValueStorage,
): string | null {
  if (pick.thread === thread?.id) return pick.key;
  return thread ? storedChatModel(storage, thread.id, thread.meta) : null;
}

export interface ComposerModel extends ComposerModelView {
  preferences: ModelPreferences;
  /** The object PromptBar takes. */
  bar: ComposerModelProps;
  /** Select a model without the preset and sign-in side effects of a pick (Continue on a local model). */
  setModelKey(key: string | null): void;
  /** A send remembers the model it went with, for this chat and (a game chat's) for the next new one. */
  remember(threadId: string, key: string): void;
}

export function useComposerModel({
  thread,
  engines,
  onEnginesRefresh,
  storage = safeStorage(),
}: {
  thread: { id: string; meta: ThreadMeta } | null;
  engines: EngineDescriptor[];
  onEnginesRefresh: () => void;
  storage?: KeyValueStorage;
}): ComposerModel {
  const threadId = thread?.id;
  const studio = thread?.meta.kind !== ThreadKind.Game;
  const [pick, setPick] = useState<{ thread?: string; key: string | null }>({ key: null });
  const [roles, setRoles] = useState<RoleRecord | null>(null);
  const [effort, setEffort] = useState<string | null>(() => storage.getItem(STORAGE_KEYS.effort) || null);
  const [preferences, setPreferences] = useState<ModelPreferences>({});
  const modelKey = pickedKey(pick, thread, storage);
  const setModelKey = (key: string | null): void => setPick({ thread: threadId, key });
  const picker = useModelPicker((state) => state.choices);
  const rereads = useEngines((state) => state.rereads);
  const choices = useMemo(() => toChoices(engines, picker), [engines, picker]);
  const view = useMemo(
    () => resolveComposerModel({ studio, engines, choices, modelKey, effort, roles, rereads }),
    [studio, engines, choices, modelKey, effort, roles, rereads],
  );
  const { selected, selectedEngine, rolesApply } = view;
  const keys = pickedKeys(modelKey, rolesApply ? roles : null, selectedEngine?.id);
  useRereadMissingPicks(rereadsWanted({ engines, choices, keys, rereads }));
  useReplacedPick(threadId, modelKey, pickReplaced({ engines, choices, modelKey, selected, rereads }), rereads);

  // A chat opens on its own pick, and a game chat keeps the model and effort it opened with.
  // Keyed on the chat alone: a pick made in it must not be re-read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the opening is read once per chat
  useEffect(() => {
    if (!thread) return;
    const opening = pinComposerOpening(storage, thread);
    setModelKey(opening.modelKey);
    setEffort(opening.effort);
  }, [threadId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: preferences follow the selected model
  useEffect(() => {
    // Fast mode is not offered yet, so a choice saved by an earlier build must not apply unseen.
    const { fast: _fast, ...offered } = readJson<ModelPreferences>(
      storageKeyFor.preferences(studio, selected),
      {},
      storage,
    );
    setPreferences(supportedPreferences(offered, choices.find((choice) => choice.key === selected) ?? {}));
  }, [selected, choices, studio]);

  // The roles panel's picks are kept per engine, through the one migration (role-store.ts).
  // biome-ignore lint/correctness/useExhaustiveDependencies: roles open once per engine
  useEffect(() => {
    if (!rolesApply || !selectedEngine) {
      setRoles(null);
      return;
    }
    setRoles(openingRoles(storage, selectedEngine.id, parseModelKey(selected).model || undefined, choices));
  }, [rolesApply, selectedEngine?.id]);

  const sendRoles = view.roles;

  const pickModel = (key: string): void => {
    trackModelPick({ key, previousKey: selected, choices, engines });
    setModelKey(key);
    setEffort((current) => effortOnModelPick(storage, studio, key, current));
    if (thread) rememberChatModel(storage, thread.id, key, studio);
    // A model row is a preset: it fills all three roles from the policy table.
    const { engine: engineId, model: modelId } = parseModelKey(key);
    const engine = engines.find((e) => e.id === engineId);
    const fillsRoles = !studio && engine !== undefined && splitsRoles(engine);
    if (fillsRoles) {
      const saved = readStoredRoles(storage, engineId);
      const preset = {
        ...(saved ?? presetRoles(engineId, modelId || undefined, choices)),
        planner: modelId || undefined,
        efforts: { ...saved?.efforts, planner: undefined },
      };
      setRoles(preset);
      storeRoles(storage, engineId, preset);
    }
    // Picking a subscription is when it is worth asking whether its session is really alive:
    // a credential file outlives a dead login, and the composer should say so before the send.
    if (engine?.kind === EngineKind.Delegated) void window.studio.recheckEngines(engineId).then(onEnginesRefresh);
  };

  const pickRoles = (next: RoleRecord): void => {
    if (!selectedEngine) return;
    track(AnalyticsEvent.ModelSettingsChanged, { setting: ModelSetting.Roles });
    setRoles(next);
    storeRoles(storage, selectedEngine.id, next);
    // The trigger names the orchestrator: the model the chat itself runs on.
    const key = keyOf(selectedEngine.id, next.planner ?? "");
    setModelKey(key);
    if (thread) rememberChatModel(storage, thread.id, key);
  };

  const pickEffort = (value: string | null): void => {
    track(AnalyticsEvent.ModelSettingsChanged, {
      setting: ModelSetting.Effort,
      effort: effortRef(value) ?? EffortRefOther.Default,
    });
    setEffort(value);
    rememberEffortPick(storage, { threadId, studio, modelKey: selected }, value);
  };

  return {
    ...view,
    preferences,
    setModelKey,
    remember: (id, key) => rememberChatModel(storage, id, key, studio),
    bar: {
      // The resolved list: a saved pick that is no longer listed stays in it, so the picker names
      // the model the chat really sends with instead of falling back to another row.
      choices: view.choices,
      selected,
      onPick: pickModel,
      roles: sendRoles,
      ...(rolesApply ? { onRoles: pickRoles } : {}),
      ...(view.effortApplies ? { effort: view.effort ?? null, efforts: view.efforts, onEffort: pickEffort } : {}),
    },
  };
}
