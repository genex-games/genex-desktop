import { ModelCatalogState } from "../shared/model-catalog.ts";
/**
 * The model picker's rows: every engine's models as choices keyed `engine::model`, and the
 * effort each role runs at once a model is picked.
 */
import { EngineKind, isEngineReady, needsSignIn } from "../shared/engine-descriptor.ts";
import { ReasoningEffort } from "../shared/model-preferences.ts";
import { crossesTo, resolveRoles } from "../shared/model-roles.ts";
import { EngineId, isMetered } from "../shared/providers.ts";
import { modelKey, parseModelKey } from "./model-key.ts";
import { modelBase, modelName, offersLineup, runnableModels, shownModels } from "./model-lineup.ts";
import type { EngineDescriptor } from "./types.ts";
import type { ModelChoice, RoleKey, RoleRecord } from "./ui/ModelMenu.tsx";
import { MODEL_PICKER_WORDS } from "./words.ts";

type EngineModel = EngineDescriptor["models"][number];

/** What the provider-default row says while there is no catalog naming the default model. */
const CATALOG_LABEL = {
  [ModelCatalogState.Loading]: "Loading models…",
  [ModelCatalogState.Ready]: "CLI default",
  [ModelCatalogState.Stale]: "Saved model list",
  [ModelCatalogState.Unavailable]: "Model list unavailable",
} as const;

/** The model id that means "whatever the engine itself is set to". */
const DEFAULT_MODEL = "default";

/** The person's Settings choices of which subscription models the picker shows, per engine and model. */
export type PickerChoices = Readonly<Record<string, Readonly<Record<string, boolean>>>>;

/** Section headers for the subscriptions that sell their vendor's own models. */
const VENDOR_GROUP: Partial<Record<string, string>> = {
  [EngineId.Codex]: MODEL_PICKER_WORDS.chatGptModels,
  [EngineId.ClaudeCode]: MODEL_PICKER_WORDS.claudeModels,
};

/** A model this Mac runs through the studio's own loop: Ollama, Bonsai — never a metered API. */
const isLocalModelEngine = (engine: EngineDescriptor): boolean =>
  engine.kind === EngineKind.Direct && !isMetered(engine.id);

/** Section header a picker row sits under: who makes the models, or this Mac. */
function groupLabel(engine: EngineDescriptor): string {
  if (isLocalModelEngine(engine)) return MODEL_PICKER_WORDS.localModels;
  return VENDOR_GROUP[engine.id] ?? engine.label;
}

/**
 * Only installed local models and concrete subscription models belong in the picker.
 * Model setup remains the entry point for unavailable local providers. Every subscription model
 * is a choice, so a saved pick always resolves; the ones the picker does not list are `hidden`
 * (model-lineup.ts, and the person's Settings `picker` choices).
 */
export function toChoices(engines: EngineDescriptor[], picker: PickerChoices = {}): ModelChoice[] {
  return engines.flatMap((engine) => engineChoices(engine, picker[engine.id], runnableModels(engine.id, engines)));
}

function engineChoices(
  engine: EngineDescriptor,
  picker: PickerChoices[string] | undefined,
  runnable: ReadonlySet<string>,
): ModelChoice[] {
  const ready = isEngineReady(engine);
  if (isLocalModelEngine(engine)) return ready ? engine.models.map((model) => localChoice(engine, model)) : [];
  // A paid provider is set up in Settings, never from the picker: until it is ready its models
  // (OpenRouter's catalog is public) are hidden rows, so a pick saved on one still resolves.
  if (isMetered(engine.id) && !ready) return engine.models.map((model) => subscriptionChoice(engine, model, false));
  const models =
    engine.kind === EngineKind.Direct
      ? apiModelChoices(engine, picker)
      : subscriptionModelChoices(engine, picker, runnable);
  if (models.length > 0) return models;
  return [subscriptionRow(engine, ready)];
}

function localTag(model: EngineModel): string {
  if (!model.supportsTools) return MODEL_PICKER_WORDS.noTools;
  return model.stale ? MODEL_PICKER_WORDS.localStale : MODEL_PICKER_WORDS.local;
}

/** A ready local model; one that cannot call tools is listed, disabled, with the reason. */
function localChoice(engine: EngineDescriptor, model: EngineModel): ModelChoice {
  return {
    key: modelKey(engine.id, model.id),
    name: model.label,
    group: groupLabel(engine),
    contextWindow: model.contextWindow,
    supportsFast: model.supportsFast,
    supportsSessions: engine.supportsSessions ?? false,
    supportsVision: model.supportsVision,
    ...(model.efforts?.length ? { efforts: model.efforts } : {}),
    ...(model.defaultEffort ? { defaultEffort: model.defaultEffort } : {}),
    tag: localTag(model),
    disabled: !model.supportsTools,
    ...(model.supportsTools ? {} : { title: MODEL_PICKER_WORDS.cannotCallTools }),
  };
}

/**
 * Aliases and pinned versions retain separate request identities. A catalog that names its
 * default model lists that model in place of the provider-default row; without one, the default
 * row stays and says what the catalog is doing.
 */
function subscriptionModelChoices(
  engine: EngineDescriptor,
  picker: PickerChoices[string] | undefined,
  runnable: ReadonlySet<string>,
): ModelChoice[] {
  const concrete = engine.models.filter((model) => model.id !== DEFAULT_MODEL);
  const listed = concrete.some((model) => model.providerDefault) ? concrete : [defaultRow(engine), ...concrete];
  const shown = shownModels(engine.id, concrete, picker, runnable, offersLineup(engine));
  const offersDefault = !UNOFFERED_DEFAULT.has(engine.id);
  const listedNow = (model: EngineModel) => (model.id === DEFAULT_MODEL ? offersDefault : shown.has(model.id));
  return listed.map((model) => subscriptionChoice(engine, model, listedNow(model)));
}

/**
 * A metered API's models (OpenRouter): every one a choice, listed as Settings says, and no default
 * row — an API picks no model on the person's behalf.
 */
function apiModelChoices(engine: EngineDescriptor, picker: PickerChoices[string] | undefined): ModelChoice[] {
  const shown = shownModels(engine.id, engine.models, picker, undefined, offersLineup(engine));
  return engine.models.map((model) => subscriptionChoice(engine, model, shown.has(model.id)));
}

/**
 * Engines whose own CLI default the picker never offers: OpenCode's default can be a model its
 * sign-in cannot run (a free model, or a GPT a ChatGPT plan refuses). The row stays a hidden
 * choice, so a pick saved on it still resolves.
 */
const UNOFFERED_DEFAULT: ReadonlySet<string> = new Set([EngineId.OpenCode]);

/** The provider-default row: the catalog's own, else one made for it. */
function defaultRow(engine: EngineDescriptor): EngineModel {
  return (
    engine.models.find((model) => model.id === DEFAULT_MODEL) ?? {
      id: DEFAULT_MODEL,
      label: `${engine.label} default`,
      contextWindow: 0,
      supportsTools: true,
      supportsVision: true,
    }
  );
}

function subscriptionChoice(engine: EngineDescriptor, model: EngineModel, shown: boolean): ModelChoice {
  const ready = isEngineReady(engine);
  const detail = choiceDetail(engine, model);
  return {
    key: modelKey(engine.id, model.id),
    name: modelName(engine.id, model),
    disabled: !ready,
    ...(!ready ? { tag: subscriptionTag(engine, false, needsSignIn(engine)) } : {}),
    group: groupLabel(engine),
    ...(detail ? { detail } : {}),
    ...(model.note ? { title: model.note } : {}),
    ...(shown ? {} : { hidden: true }),
    ...(model.providerDefault ? { providerDefault: true } : {}),
    ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
    ...(model.free ? { free: true } : {}),
    // Each vendor publishes its own reasoning dial; the effort page offers exactly what
    // the picked model accepts, so a run never dies on a value its CLI refuses.
    contextWindow: model.contextWindow,
    supportsFast: model.supportsFast,
    supportsSessions: engine.supportsSessions ?? engine.kind === EngineKind.Delegated,
    ...(model.efforts?.length ? { efforts: model.efforts } : {}),
    defaultEffort: model.defaultEffort,
  };
}

/** A row's second line: what the default row is doing while no catalog names it, or that a model is free. */
function choiceDetail(engine: EngineDescriptor, model: EngineModel): string | undefined {
  if (model.id === DEFAULT_MODEL && engine.catalog) return CATALOG_LABEL[engine.catalog.state];
  return model.free ? MODEL_PICKER_WORDS.free : undefined;
}

function subscriptionTag(engine: EngineDescriptor, ready: boolean, signIn: boolean): string {
  if (ready) return MODEL_PICKER_WORDS.subscription;
  if (signIn) return MODEL_PICKER_WORDS.signIn;
  return engine.status.code.replace(/_/g, " ");
}

/** A subscription with no models to list: one row for the engine, to sign in to or to explain. */
function subscriptionRow(engine: EngineDescriptor, ready: boolean): ModelChoice {
  const signIn = needsSignIn(engine);
  return {
    key: modelKey(engine.id, ""),
    name: engine.label,
    group: groupLabel(engine),
    tag: subscriptionTag(engine, ready, signIn),
    disabled: !ready && !signIn,
    ...(engine.status.remedy ? { title: engine.status.remedy } : {}),
  };
}

/**
 * The rows a job's list offers. The main agent runs on any model; the workers and reviewers on the
 * main agent's own engine, or on a model row of an engine the job may cross to (`crossesTo`). A
 * reviewer looks at screenshots, so a local row that cannot see images is listed, disabled, with
 * the reason.
 */
export function roleChoices(
  choices: ModelChoice[],
  role: RoleKey,
  orchestrator: ModelChoice | undefined,
): ModelChoice[] {
  if (role === "planner" || !orchestrator) return choices;
  const engine = parseModelKey(orchestrator.key).engine;
  const rows = choices.filter((choice) => runsJob(choice, role, engine));
  return role === "judge" ? rows.map(asReviewer) : rows;
}

/** Can this row run the job under a main agent on `engine`: its own engine, or one the job crosses to? */
function runsJob(choice: ModelChoice, role: RoleKey, engine: string): boolean {
  const on = parseModelKey(choice.key).engine;
  if (on === engine) return true;
  // A subscription with no models to list has one row for the engine itself, which runs nothing.
  const modelRow = choice.supportsSessions !== undefined;
  return modelRow && crossesTo(engine, role, on);
}

/** A row in the reviewers' list: one that runs without sessions and cannot see images is disabled. */
function asReviewer(choice: ModelChoice): ModelChoice {
  const blind = choice.supportsSessions === false && choice.supportsVision === false;
  return blind ? { ...choice, disabled: true, title: MODEL_PICKER_WORDS.cannotSeeImages } : choice;
}

/**
 * The row a key names. An unset or default pick is the provider's default: the model its catalog
 * names, else its default row. A saved model the CLI now lists under another id is that model's
 * row (`sameModelChoice`).
 */
export function findChoice(choices: ModelChoice[], key: string | null | undefined): ModelChoice | undefined {
  const exact = choices.find((choice) => choice.key === key);
  if (exact || !key) return exact;
  const parsed = parseModelKey(key);
  const rows = choices.filter((choice) => parseModelKey(choice.key).engine === parsed.engine);
  if (parsed.model && parsed.model !== DEFAULT_MODEL) return sameModelChoice(rows, parsed.model);
  const named = rows.find((choice) => choice.providerDefault);
  return named ?? rows.find((choice) => choice.key === modelKey(parsed.engine, DEFAULT_MODEL));
}

/**
 * One provider's row for a saved model id: the same id but for a context variant, else the alias
 * the CLI resolves to that model. The default row never stands in for a named model.
 */
function sameModelChoice(rows: ModelChoice[], saved: string): ModelChoice | undefined {
  const wanted = modelBase(saved);
  const models = rows.filter((choice) => parseModelKey(choice.key).model !== DEFAULT_MODEL);
  const sameId = models.find((choice) => modelBase(parseModelKey(choice.key).model) === wanted);
  return sameId ?? models.find((choice) => choice.resolvedModel && modelBase(choice.resolvedModel) === wanted);
}

/**
 * Resolve display state. Only a provider default is substituted, by the model its catalog names,
 * so what the picker shows is what runs.
 */
export function resolveChoice(choices: ModelChoice[], key: string | null | undefined): ModelChoice | undefined {
  const parsed = parseModelKey(key);
  const normalized = key && !parsed.model ? modelKey(parsed.engine, DEFAULT_MODEL) : key;
  const exact = findChoice(choices, normalized);
  if (exact) return exact;
  if (key) {
    const requested = parseModelKey(key);
    return { key, name: requested.model || requested.engine, disabled: true, title: MODEL_PICKER_WORDS.unavailable };
  }
  return autoChoice(choices);
}

/**
 * The row a pick falls back to when none was made: the first usable row the picker lists, on a
 * provider the studio may choose by itself. Never a paid one (OpenRouter, OpenCode): the person
 * picks those. A free model is chosen only when every row the picker lists is one.
 */
export function autoChoice(choices: readonly ModelChoice[]): ModelChoice | undefined {
  const usable = choices.filter((choice) => !choice.disabled && !choice.hidden);
  const own = usable.find((choice) => !isMetered(parseModelKey(choice.key).engine));
  if (own) return own;
  return usable.every((choice) => choice.free) ? usable[0] : undefined;
}

export function effectiveEffort(model: ModelChoice | undefined, value?: string | null): string | undefined {
  if (!model?.efforts?.length) return undefined;
  return value && model.efforts.includes(value) ? value : model.defaultEffort;
}

/** Every reasoning level a provider names, fastest first: a level's place here is its rank. */
const EFFORT_LADDER: readonly string[] = [
  ReasoningEffort.None,
  ReasoningEffort.Minimal,
  ReasoningEffort.Low,
  ReasoningEffort.Medium,
  ReasoningEffort.High,
  ReasoningEffort.Xhigh,
  ReasoningEffort.Max,
  ReasoningEffort.Ultra,
];
const effortRank = (effort: string): number => {
  const rank = EFFORT_LADDER.indexOf(effort);
  return rank < 0 ? EFFORT_LADDER.indexOf(ReasoningEffort.Medium) : rank;
};

/** The level a model accepts that is closest to the one chosen, the faster one on a tie. */
export function nearestEffort(value: string | null | undefined, efforts: string[] | undefined): string | undefined {
  if (!value || !efforts?.length) return undefined;
  if (efforts.includes(value)) return value;
  const target = effortRank(value);
  return [...efforts].sort(
    (a, b) => Math.abs(effortRank(a) - target) - Math.abs(effortRank(b) - target) || effortRank(a) - effortRank(b),
  )[0];
}

/**
 * The levels the one effort control offers: the orchestrator's own, since its name sits beside
 * the control. Only when it has none (a local model without a dial) do the other roles' levels
 * stand in.
 */
export function effortScale(
  orchestrator: ModelChoice | undefined,
  others: Array<ModelChoice | undefined> = [],
): string[] {
  if (orchestrator?.efforts?.length) return orchestrator.efforts;
  return [...new Set(others.flatMap((model) => model?.efforts ?? []))].sort((a, b) => effortRank(a) - effortRank(b));
}

/** Use a supported choice, then the reported default; unknown defaults send no override. */
export function unifiedEffort(
  scale: string[],
  value: string | null | undefined,
  orchestrator?: ModelChoice,
): string | undefined {
  if (!scale.length) return undefined;
  if (value && scale.includes(value)) return value;
  return nearestEffort(orchestrator?.defaultEffort, scale);
}

const ROLES = ["planner", "builder", "judge"] as const;

/** The model a role asks for: its own pick, else — on the orchestrator's engine — the preset's. */
function wantedModel(picked: string | undefined, onOrchestratorEngine: boolean, preset: string | undefined): string {
  if (picked === DEFAULT_MODEL) return DEFAULT_MODEL;
  if (picked) return picked;
  return onOrchestratorEngine ? (preset ?? "") : "";
}

/**
 * Use the same named models in the picker and the send payload. One effort serves every role:
 * each model runs at the closest level it accepts, or at its own default when none is chosen.
 */
export function withRoleEfforts(
  roles: RoleRecord,
  choices: ModelChoice[],
  engine: string,
  effort?: string | null,
): RoleRecord {
  const next = { ...roles, efforts: { ...roles.efforts } };
  const preset = resolveRoles(engine, roles.planner);
  for (const role of ROLES) {
    const provider = role === "planner" ? engine : (roles.engines?.[role] ?? engine);
    const wanted = wantedModel(roles[role], provider === engine, preset[role]);
    const model = resolveChoice(choices, modelKey(provider, wanted));
    if (!model) continue;
    const picked = parseModelKey(model.key);
    if (picked.engine !== provider) continue;
    // An alias is still what the run asks its CLI for; only the picker shows it as the model.
    next[role] = picked.model === DEFAULT_MODEL ? undefined : picked.model || undefined;
    next.efforts[role] = nearestEffort(effort, model.efforts) ?? effectiveEffort(model, null);
  }
  return next;
}
