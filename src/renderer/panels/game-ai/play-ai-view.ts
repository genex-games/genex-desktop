/**
 * What Studio's creator surfaces of play-time AI draw, derived from what main answers (`V3-*`
 * canvas boards): the Create pill and its menu's top line, Settings' Games lines, the optional
 * model check's rows, Publish's block, and the engine Live card's line. Pure: every word comes
 * from `renderer/words.ts`, every number from main or genex.games.
 */
import { AiDoor, AiFunding, type AiModelRef, AiRequirement } from "../../../shared/game-ai.ts";
import {
  AiCheckFit,
  type AiCheckResult,
  type AiCheckRow,
  AiCheckState,
  AiCostLevel,
  type AiPublishChoice,
  type AiPublishFacts,
  sameModel,
} from "../../../shared/game-ai-check.ts";
import {
  AI_LOW_CREDITS,
  type AiGameRow,
  AiMaker,
  type AiMenuRow,
  type AiModelMenu,
  type AiStopCard,
  AiStopReason,
} from "../../../shared/game-ai-views.ts";
import { EngineId } from "../../../shared/providers.ts";
import {
  AI_WORDS,
  CREATE_AI_WORDS,
  countWords,
  creditsWords,
  ENGINE_AI_WORDS,
  keySpendWords,
  MODEL_CHECK_WORDS,
  PUBLISH_AI_WORDS,
  AI_SETTINGS_WORDS,
  thisMachine,
  yourPlanWords,
} from "../../words.ts";

/** USD micros in one Genex credit (1 credit = 1¢). */
const MICROS_PER_CREDIT = 10_000;
/** Basis points in one percent. */
const BPS_PER_PERCENT = 100;

/** What the pill shows. Wire-free: a renderer-only vocabulary. */
export const PillState = {
  Loading: "loading",
  Off: "off",
  Playtest: "playtest",
  Choose: "choose",
  Credits: "credits",
  Model: "model",
} as const;
export type PillState = (typeof PillState)[keyof typeof PillState];

/** The pill as drawn: its words, the tag beside them, and whether the balance reads low. */
export interface PillView {
  state: PillState;
  label: string;
  tag: string | null;
  low: boolean;
}

/** Every row the menu lists, the folded ones too. */
const allRows = (menu: AiModelMenu): AiMenuRow[] => [...menu.groups.flatMap((group) => group.rows), ...menu.struggling];

/** The menu's row for a model, or null when the menu does not list it. */
export function rowOf(menu: AiModelMenu | null, model: AiModelRef | null): AiMenuRow | null {
  if (!menu || !model) return null;
  return allRows(menu).find((row) => sameModel(row.model, model)) ?? null;
}

/** The maker of the group a model is listed under, or null. */
export function makerOf(menu: AiModelMenu, model: AiModelRef): AiMaker | null {
  return menu.groups.find((group) => group.rows.some((row) => sameModel(row.model, model)))?.maker ?? null;
}

/** A model's name as the person's menu shows it, else its id. */
export const modelLabel = (menu: AiModelMenu | null, model: AiModelRef): string =>
  rowOf(menu, model)?.label ?? model.model;

const isCredits = (model: AiModelRef): boolean => model.door === AiDoor.GenexCredits;

/** The Create pill: the model it names, "AI off", a saved playtest, or the press that chooses one. */
export function pillView(menu: AiModelMenu | null): PillView {
  if (!menu) return { state: PillState.Loading, label: CREATE_AI_WORDS.pill, tag: null, low: false };
  if (menu.off) return { state: PillState.Off, label: CREATE_AI_WORDS.pillOff, tag: null, low: false };
  if (menu.usage?.funding === AiFunding.Playtest)
    return { state: PillState.Playtest, label: CREATE_AI_WORDS.pillPlaytest, tag: null, low: false };
  if (!menu.current) return { state: PillState.Choose, label: CREATE_AI_WORDS.pillChoose, tag: null, low: false };
  if (isCredits(menu.current)) {
    const balance = menu.genex.balanceCredits;
    const tag = balance === null ? null : countWords(balance);
    return {
      state: PillState.Credits,
      label: CREATE_AI_WORDS.pillCredits,
      tag,
      low: balance !== null && balance <= AI_LOW_CREDITS,
    };
  }
  const row = rowOf(menu, menu.current);
  const tag = row?.funding === AiFunding.Free ? CREATE_AI_WORDS.pillFree : null;
  return { state: PillState.Model, label: row?.label ?? menu.current.model, tag, low: false };
}

/** Whether a game has AI to show: it picked a model, used one, or had it turned off. */
export const usesAi = (menu: AiModelMenu | null): boolean =>
  menu !== null && (menu.off || menu.current !== null || menu.usage !== null);

/** The menu's top line: what the game's AI costs, in the words of how it is paid (`V3-Pill`). */
export function usageWords(menu: AiModelMenu, platform: string): string | null {
  const usage = menu.usage;
  if (!usage) return null;
  switch (usage.funding) {
    case AiFunding.Plan: {
      const maker = menu.current ? makerOf(menu, menu.current) : null;
      return CREATE_AI_WORDS.usagePlan(yourPlanWords(maker), usage.planUsedPercent);
    }
    case AiFunding.Free:
      return menu.current?.door === AiDoor.Local
        ? CREATE_AI_WORDS.usageFreeHere(thisMachine(platform))
        : CREATE_AI_WORDS.usageFree;
    case AiFunding.Credits:
      return CREATE_AI_WORDS.usageCredits(usage.sessionCredits, usage.balanceCredits);
    case AiFunding.Key:
      return CREATE_AI_WORDS.usageKey(keySpendWords(usage.monthMicros));
    default:
      return CREATE_AI_WORDS.usagePlaytest;
  }
}

/** The one tag a menu row wears, in words. */
export const tagWords = (row: AiMenuRow): string | null => (row.tag ? AI_WORDS.tags[row.tag] : null);

/** What a game in Settings' Games list says: how its AI is paid, and its month's spend when that costs money. */
export function gameLine(row: AiGameRow): string {
  if (!row.on) return AI_SETTINGS_WORDS.gameOff;
  const model = row.modelLabel ?? row.model?.model ?? null;
  switch (row.funding) {
    case AiFunding.Credits:
      return AI_SETTINGS_WORDS.gameCredits(Math.ceil(row.monthMicros / MICROS_PER_CREDIT));
    case AiFunding.Plan:
      return model ? AI_SETTINGS_WORDS.gamePlan(model) : AI_SETTINGS_WORDS.gameNoModel;
    case AiFunding.Free:
      return model ? AI_SETTINGS_WORDS.gameFree(model) : AI_SETTINGS_WORDS.gameNoModel;
    case AiFunding.Key:
      return model ? AI_SETTINGS_WORDS.gameKey(model, keySpendWords(row.monthMicros)) : AI_SETTINGS_WORDS.gameNoModel;
    case AiFunding.Playtest:
      return AI_SETTINGS_WORDS.gamePlaytest;
    default:
      return AI_SETTINGS_WORDS.gameNoModel;
  }
}

// ── the model check ──────────────────────────────────────────────────────────────────────

/** Where a checked model runs, as the check's table names it under the model. */
export function sourceWords(row: Pick<AiCheckRow, "model" | "funding">, platform: string): string {
  const { door, engine } = row.model;
  if (door === AiDoor.Plan || door === AiDoor.PlanWatcher) return yourPlanWords(planMaker(engine));
  if (door === AiDoor.Byok) return MODEL_CHECK_WORDS.rowOpenRouter;
  if (door === AiDoor.OpenCode)
    return row.funding === AiFunding.Free ? MODEL_CHECK_WORDS.rowOpenCodeFree : MODEL_CHECK_WORDS.rowOpenCode;
  return MODEL_CHECK_WORDS.rowHere(thisMachine(platform));
}

/** The maker whose plan an engine runs on, or null when it is not a plan's. */
function planMaker(engine: string): AiMaker | null {
  if (engine === EngineId.ClaudeCode) return AiMaker.Claude;
  if (engine === EngineId.Codex) return AiMaker.ChatGpt;
  return null;
}

/** One row of the check's table. */
export interface CheckRowView {
  key: string;
  model: AiModelRef;
  label: string;
  source: string;
  fit: AiCheckFit;
  fitText: string;
  cost: string;
  reply: string;
  best: boolean;
}

const modelKey = (model: AiModelRef): string => `${model.door}/${model.engine}/${model.model}`;

/** The check's table, row by row as main ordered it. */
export function checkRows(result: AiCheckResult, platform: string): CheckRowView[] {
  return result.rows.map((row) => ({
    key: modelKey(row.model),
    model: row.model,
    label: row.label,
    source: sourceWords(row, platform),
    fit: row.fit,
    fitText:
      row.fit === AiCheckFit.Untested
        ? MODEL_CHECK_WORDS.untested
        : MODEL_CHECK_WORDS.fitLabel(row.fitted, row.moments),
    cost: AI_WORDS.cost[row.cost],
    reply:
      row.medianLatencyMs === null ? MODEL_CHECK_WORDS.noReply : MODEL_CHECK_WORDS.replySeconds(row.medianLatencyMs),
    best: result.recommended !== null && sameModel(result.recommended, row.model),
  }));
}

/** "a, b and c". */
function listWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** What the check ran on, as its intro says: "your plans, your OpenRouter key and this Mac". */
export function checkSources(rows: readonly AiCheckRow[], platform: string): string {
  const plans = new Set(
    rows
      .filter((row) => row.model.door === AiDoor.Plan || row.model.door === AiDoor.PlanWatcher)
      .map((row) => row.model.engine),
  );
  const parts: string[] = [];
  if (plans.size > 1) parts.push(MODEL_CHECK_WORDS.sourcePlans);
  if (plans.size === 1) parts.push(MODEL_CHECK_WORDS.sourcePlan);
  if (rows.some((row) => row.model.door === AiDoor.Byok)) parts.push(MODEL_CHECK_WORDS.sourceKey);
  if (rows.some((row) => row.model.door === AiDoor.OpenCode)) parts.push(MODEL_CHECK_WORDS.sourceOpenCode);
  if (rows.some((row) => row.model.door === AiDoor.Local)) parts.push(thisMachine(platform));
  return listWords(parts);
}

/** The check dialog's words above its table, by where the check stands. */
export function checkIntro(result: AiCheckResult, game: string, platform: string): string {
  switch (result.state) {
    case AiCheckState.Empty:
      return MODEL_CHECK_WORDS.empty(game);
    case AiCheckState.Checking:
      return MODEL_CHECK_WORDS.checking(result.progress?.done ?? 0, result.progress?.total ?? result.rows.length);
    case AiCheckState.Failed:
      return MODEL_CHECK_WORDS.failed;
    case AiCheckState.Done:
      return MODEL_CHECK_WORDS.done(result.moments, result.rows.length, checkSources(result.rows, platform));
    default:
      return MODEL_CHECK_WORDS.ready(thisMachine(platform));
  }
}

/** The line under the table: why the first model that struggles does, for the creator. */
export function strugglesLine(result: AiCheckResult): string | null {
  const row = result.rows.find((candidate) => candidate.fit === AiCheckFit.Struggles);
  return row ? MODEL_CHECK_WORDS.why(row.label, row.note, row.fitted, row.moments) : null;
}

// ── Publish ──────────────────────────────────────────────────────────────────────────────

/** The press beside "Best with": Change the pick with a check, Check models without one. */
export const BestWithAction = { Change: "change", Check: "check" } as const;
export type BestWithAction = (typeof BestWithAction)[keyof typeof BestWithAction];

/** Publish's play-time AI block as drawn. */
export interface PublishAiView {
  bestWith: string | null;
  action: BestWithAction;
  /** "Without a check, players see no fit tags and no AI cost level." */
  noCheck: boolean;
  /** "AI cost for players", null without a check. */
  cost: { marks: string; name: string } | { free: string } | null;
  /** The leaderboard switch and the creator's share show for a game that needs AI. */
  leaderboard: boolean;
  share: string | null;
}

/** Whether Publish shows the block at all: the game has played with AI, or been checked. */
export const publishShowsAi = (facts: AiPublishFacts | null): boolean =>
  facts !== null && (facts.playtested || facts.check !== null);

/** A share in basis points as Publish reads it: "10", "12.5". */
const sharePercent = (bps: number): string => `${Number((bps / BPS_PER_PERCENT).toFixed(2))}`;

/** Publish's block, from what main read and what the creator chose. */
export function publishAiView(
  facts: AiPublishFacts,
  requires: AiRequirement | null,
  labelOf: (model: AiModelRef) => string,
): PublishAiView {
  const best = facts.bestWith ?? facts.playtestModel;
  const checked = facts.fits !== null && facts.bestWith !== null;
  let bestWith: string | null = null;
  if (best && facts.fits && checked) bestWith = PUBLISH_AI_WORDS.fits(labelOf(best), facts.fits.fitted, facts.fits.of);
  else if (best) bestWith = PUBLISH_AI_WORDS.playtested(labelOf(best));
  let cost: PublishAiView["cost"] = null;
  if (facts.cost === AiCostLevel.Free) cost = { free: PUBLISH_AI_WORDS.costFree };
  else if (facts.cost) cost = { marks: AI_WORDS.cost[facts.cost], name: AI_WORDS.costName[facts.cost] };
  const needs = requires === AiRequirement.Ai;
  const share =
    needs && facts.creatorShareBps !== null ? PUBLISH_AI_WORDS.share(sharePercent(facts.creatorShareBps)) : null;
  const action = checked ? BestWithAction.Change : BestWithAction.Check;
  return { bestWith, action, noCheck: !checked, cost, leaderboard: needs, share };
}

/** What Publish sends of the block: nothing until the creator chose, and a leaderboard only for a game that needs AI. */
export function publishChoice(requires: AiRequirement | null, leaderboard: boolean): AiPublishChoice | null {
  if (!requires) return null;
  return { requires, leaderboard: requires === AiRequirement.Ai && leaderboard };
}

// ── the engine Live card ─────────────────────────────────────────────────────────────────

/** The engine card dot's tone: AI at work, waiting on the person, stopped, or off. */
export const AiLineTone = { Ready: "ready", Waiting: "waiting", Stopped: "stopped", Off: "off" } as const;
export type AiLineTone = (typeof AiLineTone)[keyof typeof AiLineTone];

/** The engine Live card's AI line: its words, and the press that chooses a model when one is due. */
export interface EngineAiLineView {
  text: string;
  choose: boolean;
  tone: AiLineTone;
}

/** A stop card's line on the engine card. */
function stoppedWords(card: AiStopCard): string {
  switch (card.reason) {
    case AiStopReason.OutOfCredits:
      return ENGINE_AI_WORDS.stopped.outOfCredits;
    case AiStopReason.PlanResting:
      return ENGINE_AI_WORDS.stopped.planResting(card.resetsAt);
    case AiStopReason.DailyAlert:
      return ENGINE_AI_WORDS.stopped.dailyAlert;
    case AiStopReason.NeedsAiOff:
      return ENGINE_AI_WORDS.stopped.needsAiOff;
    case AiStopReason.NotAnswering:
      return ENGINE_AI_WORDS.stopped.notAnswering;
    default:
      return ENGINE_AI_WORDS.stopped.struggles(card.modelLabel ?? card.model?.model ?? "");
  }
}

/** The line for a model in use. */
function runningWords(menu: AiModelMenu, model: AiModelRef, platform: string): string {
  if (isCredits(model)) return ENGINE_AI_WORDS.credits;
  const row = rowOf(menu, model);
  const label = row?.shortLabel ?? row?.label ?? model.model;
  if (menu.usage?.funding === AiFunding.Plan)
    return ENGINE_AI_WORDS.plan(yourPlanWords(makerOf(menu, model)), menu.usage.planUsedPercent);
  if (row?.funding === AiFunding.Key) return ENGINE_AI_WORDS.key(label);
  if (model.door === AiDoor.Local) return ENGINE_AI_WORDS.freeHere(label, thisMachine(platform));
  return ENGINE_AI_WORDS.free(label);
}

/**
 * The engine card's line, or null while the game has not used AI: a stop first, then a card
 * waiting for the person, then off, a saved playtest, or the model at work.
 */
export function engineAiLine(
  menu: AiModelMenu | null,
  pending: { stop: AiStopCard | null; consent: boolean },
  platform: string,
): EngineAiLineView | null {
  if (pending.stop) return { text: stoppedWords(pending.stop), choose: false, tone: AiLineTone.Stopped };
  if (pending.consent) return { text: ENGINE_AI_WORDS.waiting, choose: true, tone: AiLineTone.Waiting };
  if (!menu || (!menu.off && menu.usage === null)) return null;
  if (menu.off) return { text: ENGINE_AI_WORDS.off, choose: false, tone: AiLineTone.Off };
  if (menu.usage?.funding === AiFunding.Playtest)
    return { text: ENGINE_AI_WORDS.playtest, choose: false, tone: AiLineTone.Ready };
  if (!menu.current) return { text: ENGINE_AI_WORDS.waiting, choose: true, tone: AiLineTone.Waiting };
  return { text: runningWords(menu, menu.current, platform), choose: false, tone: AiLineTone.Ready };
}

/** A balance as Settings shows it: "1,240 credits". */
export const balanceWords = (credits: number): string => creditsWords(credits);
