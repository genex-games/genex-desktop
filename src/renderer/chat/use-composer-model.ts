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
import { useEffect, useMemo, useState } from "react";
import { crossesTo, normalizeRoles, takesRoles } from "../../shared/model-roles.ts";
import { supportedPreferences, type ModelPreferences } from "../../shared/model-preferences.ts";
import {
  effortScale,
  findChoice,
  nearestEffort,
  resolveChoice,
  toChoices,
  unifiedEffort,
  withRoleEfforts,
} from "../model-choices.ts";
import { autopilotSendOptions } from "../loop-setting.ts";
import { openingRoles, presetRoles, readStoredRoles, storeRoles } from "../role-store.ts";
import { readJson, safeStorage, STORAGE_KEYS, storageKeyFor, type KeyValueStorage } from "../storage.ts";
import { useModelPicker } from "../state/hooks.ts";
import { rememberChatEffort, rememberChatModel, storedChatEffort, storedChatModel } from "../stored-model.ts";
import type { EngineDescriptor, ThreadMeta } from "../types.ts";
import { ThreadKind } from "../../shared/event-log.ts";
import { EngineKind, EngineStatusCode, splitsRoles } from "../../shared/engine-descriptor.ts";
import { modelKey as keyOf, parseModelKey } from "../model-key.ts";
import type { ComposerSendOptions } from "../../shared/composer.ts";
import type { ComposerExtras, ComposerModelProps, ModelChoice, RoleGroup, RoleRecord } from "../ui/PromptBar.tsx";

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
  /**
   * The other ready engines that take roles, and their models: each job may go to those it crosses
   * to (`crossesTo`), never the orchestrator.
   */
  roleOthers: RoleGroup[];
  /** The roles a send carries, efforts resolved (`effectiveRoles`); null where roles do not apply. */
  roles: RoleRecord | null;
}

const modelRow = (m: { id: string; label: string }) => ({ id: m.id, label: m.id === "default" ? "Default" : m.label });
/**
 * Another engine can take the builder or judge role: it takes roles (a session engine, or a
 * completion-only local one), is ready, and has models.
 */
const canTakeRoles = (engine: EngineDescriptor) =>
  takesRoles(engine.id) && engine.status.code === EngineStatusCode.Ready && engine.models.length > 0;

type RoleView = Pick<ComposerModelView, "choices" | "selected" | "selectedEngine" | "rolesApply" | "roleOthers">;

/**
 * The roles as picked: preserve explicit provider/model choices across sign-in failures,
 * and set the orchestrator to the selected
 * model — each model named as the picker names it, at its own default effort.
 */
function rolePicks(view: RoleView, roles: RoleRecord | null): RoleRecord | null {
  if (!view.rolesApply) return null;
  if (!roles || !view.selectedEngine) return null;
  const next = normalizeRoles(view.selectedEngine.id, roles);
  if (!next) return null;
  next.planner = parseModelKey(view.selected).model || undefined;
  return withRoleEfforts(next, view.choices, view.selectedEngine.id, null);
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

/** Everything the composer derives from the engines and the chat's own picks (roles and effort). */
export function resolveComposerModel(input: {
  studio: boolean;
  engines: EngineDescriptor[];
  choices?: ModelChoice[];
  modelKey: string | null;
  effort: string | null;
  roles?: RoleRecord | null;
}): ComposerModelView {
  const choices = [...(input.choices ?? toChoices(input.engines))];
  const choice = resolveChoice(choices, input.modelKey);
  if (choice && !choices.some((row) => row.key === choice.key)) choices.push(choice);
  const selected = choice?.key ?? null;
  const selectedChoice = choices.find((choice) => choice.key === selected);
  const selectedEngine = input.engines.find((engine) => engine.id === parseModelKey(selected).engine);
  const rolesApply = Boolean(
    !input.studio && selectedEngine && splitsRoles(selectedEngine) && selectedEngine.models.length > 0,
  );
  const roleOthers: RoleGroup[] =
    rolesApply && selectedEngine
      ? input.engines
          .filter((engine) => engine.id !== selectedEngine.id && canTakeRoles(engine))
          .map((engine) => ({ engine: engine.id, label: engine.label, models: engine.models.map(modelRow) }))
      : [];
  const view: RoleView = { choices, selected, selectedEngine, rolesApply, roleOthers };
  // One effort for every role: the control offers the orchestrator's levels, and each worker and
  // judge model runs at the closest level it accepts.
  const picks = rolePicks(view, input.roles ?? null);
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
 * What a send carries. `key` is the model the send goes with (the pick, or for a timed build with
 * no pick, the first usable model). The interview and the plan run on the orchestrator; the
 * builders' and judges' models ride along in the commission and are applied at launch
 * (model-roles.ts). `autopilot` is false while the chat's build runs or is paused (`loopCommissions`).
 */
export function composerSendOptions(
  model: Pick<ComposerModelView, "studio" | "selectedEngine" | "plannerEffort" | "choices" | "roleOthers"> & {
    roles: RoleRecord | null;
    preferences: ModelPreferences;
  },
  key: string | null,
  input: { autopilot: boolean; extras?: ComposerExtras },
): ComposerSendOptions {
  const { engine, model: pickedModel } = parseModelKey(key);
  const roles = model.roles && engine === model.selectedEngine?.id ? model.roles : null;
  requireAvailableChoice(model.choices, key);
  const commission = input.autopilot && input.extras?.autopilot;
  if (commission) requireAvailableRoles(model, engine, roles);
  const sendModel = !model.studio && roles ? (roles.planner ?? "") : pickedModel;
  const extras = input.extras;
  const explicitModel = isExplicitModel(sendModel);
  return {
    ...(engine ? { engine } : {}),
    ...(explicitModel ? { model: sendModel } : {}),
    ...(model.plannerEffort ? { effort: model.plannerEffort } : {}),
    preferences: model.preferences,
    ...(extras?.reviewPlan ? { reviewPlan: true } : {}),
    ...(extras?.frames?.length ? { frames: extras.frames } : {}),
    ...(extras?.autopilot && input.autopilot ? { autopilot: autopilotSendOptions(extras.autopilot, roles) } : {}),
  };
}

function isExplicitModel(model: string | undefined): boolean {
  return Boolean(model) && model !== "default";
}

function requireAvailableRoles(
  model: Pick<ComposerModelView, "choices" | "roleOthers">,
  engine: string,
  roles: RoleRecord | null,
): void {
  if (!roles) return;
  for (const role of ["builder", "judge"] as const) {
    const provider = roles.engines?.[role] ?? engine;
    const ready = model.roleOthers.some((group) => group.engine === provider);
    const available = provider === engine || (ready && crossesTo(engine, role, provider));
    if (!available) throw new Error(MODEL_PICKER_WORDS.unavailable);
    requireAvailableChoice(model.choices, keyOf(provider, roles[role] ?? ""));
  }
}

function requireAvailableChoice(choices: ModelChoice[], key: string | null): void {
  if (!key) return;
  const choice = resolveChoice(choices, key);
  if (!choice || choice.disabled) throw new Error(MODEL_PICKER_WORDS.unavailable);
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
  const choices = useMemo(() => toChoices(engines, picker), [engines, picker]);
  const view = useMemo(
    () => resolveComposerModel({ studio, engines, choices, modelKey, effort, roles }),
    [studio, engines, choices, modelKey, effort, roles],
  );
  const { selected, selectedEngine, rolesApply } = view;

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
    setRoles(next);
    storeRoles(storage, selectedEngine.id, next);
    // The trigger names the orchestrator: the model the chat itself runs on.
    const key = keyOf(selectedEngine.id, next.planner ?? "");
    setModelKey(key);
    if (thread) rememberChatModel(storage, thread.id, key);
  };

  const pickEffort = (value: string | null): void => {
    setEffort(value);
    rememberEffortPick(storage, { threadId, studio, modelKey: selected }, value);
  };

  return {
    ...view,
    preferences,
    setModelKey,
    remember: (id, key) => rememberChatModel(storage, id, key, studio),
    bar: {
      choices,
      selected,
      onPick: pickModel,
      roles: sendRoles,
      ...(rolesApply ? { onRoles: pickRoles } : {}),
      ...(view.effortApplies ? { effort: view.effort ?? null, efforts: view.efforts, onEffort: pickEffort } : {}),
    },
  };
}
