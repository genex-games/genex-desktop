/**
 * The AI pill's model menu for one game (§14): the chat's model menu, computed by main. It lists
 * the models the doors legal for the game offer now — never a door the game's context may not use,
 * and never Genex credits as a maker's row (credits are the Genex group's: the balance and the
 * maker's pick players on credits get) — grouped by who makes them and named as the chat names
 * them. Each row wears one tag: the maker's pick, Free, plan, or what the game costs on the
 * person's own key when the model check measured it; a model the check found struggling is folded
 * under "may struggle". The top line says what the game's AI costs in the words of how it is paid:
 * free, a share of the plan, credits this session, or this month on the key. No price is guessed.
 */
import {
  AiDoor,
  AiFunding,
  type AiGameKey,
  AiGameKind,
  type AiModelRef,
  AiRequirement,
  creditsOfMicros,
  fundingOf,
  isPlatformDoor,
} from "../../shared/game-ai.ts";
import { AiCheckFit, type AiCheckRow, AiCostLevel, sameModel } from "../../shared/game-ai-check.ts";
import { AiContext, LEGAL_DOORS } from "../../shared/game-ai-route.ts";
import {
  AiMaker,
  type AiMenuGroup,
  type AiMenuRow,
  type AiModelMenu,
  AiModelTag,
  type AiUsageLine,
} from "../../shared/game-ai-views.ts";
import { GENEX_ENGINE } from "./doors/genex-dev.ts";
import type { AiGrantRecord, GameAiClock, GameAiDoorImpl, GameAiGrants, GameAiLedger } from "./types.ts";

/** The most ledger lines one menu reads for a game's credits this session. */
const SESSION_LEDGER_LINES = 500;

/** The groups in the order the menu shows them. */
const MAKER_ORDER: readonly AiMaker[] = [AiMaker.Claude, AiMaker.ChatGpt, AiMaker.Google, AiMaker.Local, AiMaker.Other];

/** Who makes a model on a key or OpenCode, by the provider its id names. */
const MAKER_OF_PROVIDER: ReadonlyArray<readonly [RegExp, AiMaker]> = [
  [/^(anthropic\/|claude)/i, AiMaker.Claude],
  [/^(openai\/|gpt-|o\d)/i, AiMaker.ChatGpt],
  [/^(google\/|gemini|gemma)/i, AiMaker.Google],
];

/** The cost tag a measured cost level wears on the person's own key; free wears Free. */
const TAG_OF_COST = {
  [AiCostLevel.Free]: AiModelTag.Free,
  [AiCostLevel.Low]: AiModelTag.CostLow,
  [AiCostLevel.Medium]: AiModelTag.CostMedium,
  [AiCostLevel.High]: AiModelTag.CostHigh,
} as const satisfies Record<AiCostLevel, AiModelTag>;

/** A model as the chat's catalog names it. */
export interface AiModelFacts {
  label: string;
  /** The narrow bar's shorter name. */
  shortLabel: string;
  /** The catalog marks it free (an OpenCode model anyone may run). */
  free?: boolean;
}

/** What the menu is computed from. */
export interface GameAiMenuDeps {
  clock: GameAiClock;
  doors: ReadonlyMap<AiDoor, GameAiDoorImpl>;
  grants: Pick<GameAiGrants, "live" | "isOff">;
  ledger: Pick<GameAiLedger, "recent">;
  /** The game's name as the library or the catalog shows it. */
  titleOf(game: AiGameKey): Promise<string>;
  /** A model's names (and whether it is free) as the chat's model menu reads them; null when unknown. */
  facts(model: AiModelRef): Promise<AiModelFacts | null>;
  /** The person's Genex credits; null while signed out. */
  balanceCredits(): Promise<number | null>;
  /** The model check of the creator's own game; null for any other game or before a check. */
  check(game: AiGameKey): Promise<{ rows: readonly AiCheckRow[]; recommended: AiModelRef | null } | null>;
  /** When this session began: the menu's credits are counted from it. */
  sessionStartedAt: number;
}

/** Where a game's calls come from when a person plays it: Play, or Create Live for their own game. */
const contextOf = (game: AiGameKey): AiContext =>
  game.startsWith(`${AiGameKind.Play}:`) ? AiContext.DesktopPlay : AiContext.CreateLive;

/** The doors a game's menu lists: legal where the person plays it, and answered on this Mac by a model. */
function menuDoors(game: AiGameKey): AiDoor[] {
  const legal: readonly AiDoor[] = LEGAL_DOORS[contextOf(game)];
  const notModels: readonly AiDoor[] = [AiDoor.Tape, AiDoor.Fixture];
  return legal.filter((door) => !isPlatformDoor(door) && door !== AiDoor.GenexDev && !notModels.includes(door));
}

/** Who makes a model. */
function makerOf(model: AiModelRef): AiMaker {
  if (model.door === AiDoor.Local) return AiMaker.Local;
  if (model.door === AiDoor.Plan) return AiMaker.Claude;
  return MAKER_OF_PROVIDER.find(([re]) => re.test(model.model))?.[1] ?? AiMaker.Other;
}

/** A model's one tag: the maker's pick, else how it is paid, else what the check measured it costs on a key. */
function tagOf(row: Pick<AiMenuRow, "model" | "funding">, recommended: AiModelRef | null, checked: AiCheckRow | null) {
  if (recommended && recommended.model === row.model.model) return AiModelTag.Best;
  if (row.funding === AiFunding.Free) return AiModelTag.Free;
  if (row.funding === AiFunding.Plan) return AiModelTag.Plan;
  return checked ? TAG_OF_COST[checked.cost] : null;
}

/** What one door offers this game now, as rows. */
async function doorRows(
  deps: GameAiMenuDeps,
  door: GameAiDoorImpl,
  check: { rows: readonly AiCheckRow[]; recommended: AiModelRef | null } | null,
): Promise<AiMenuRow[]> {
  const [readiness, models] = await Promise.all([
    door.readiness().catch(() => null),
    door.models().catch(() => [] as AiModelRef[]),
  ]);
  const ready = readiness?.ready === true && !readiness.loading;
  return Promise.all(
    models.map(async (model) => {
      const facts = await deps.facts(model).catch(() => null);
      const funding = fundingOf(model.door, facts?.free === true);
      const checked = check?.rows.find((row) => sameModel(row.model, model)) ?? null;
      return {
        model,
        label: facts?.label ?? model.model,
        shortLabel: facts?.shortLabel ?? facts?.label ?? model.model,
        funding,
        tag: tagOf({ model, funding }, check?.recommended ?? null, checked),
        fit: checked?.fit ?? null,
        ready,
      };
    }),
  );
}

/** The rows in maker groups; a group of the plan alone says it is paid by the plan. */
function grouped(rows: readonly AiMenuRow[]): AiMenuGroup[] {
  return MAKER_ORDER.flatMap((maker) => {
    const mine = rows.filter((row) => makerOf(row.model) === maker);
    if (!mine.length) return [];
    const fundings = new Set(mine.map((row) => row.funding));
    const only = fundings.size === 1 ? [...fundings][0] : undefined;
    return [{ maker, funding: only === AiFunding.Plan ? AiFunding.Plan : null, rows: mine }];
  });
}

/** Credits a game spent on Genex's lane since this session began. */
async function sessionCredits(deps: GameAiMenuDeps, game: AiGameKey): Promise<number> {
  const lines = await deps.ledger.recent(SESSION_LEDGER_LINES, game).catch(() => []);
  const micros = lines
    .filter((line) => Date.parse(line.at) >= deps.sessionStartedAt && fundingOf(line.door, false) === AiFunding.Credits)
    .reduce((sum, line) => sum + line.costMicros, 0);
  return creditsOfMicros(micros);
}

/** The top line: what the game's AI costs, in the words of how its grant is paid. */
async function usageOf(
  deps: GameAiMenuDeps,
  grant: AiGrantRecord,
  free: boolean,
  balance: number | null,
): Promise<AiUsageLine> {
  const funding = fundingOf(grant.door, free);
  switch (funding) {
    case AiFunding.Plan: {
      const share = await deps.doors
        .get(grant.door)
        ?.usage?.()
        .catch(() => null);
      return { funding, planUsedPercent: share?.usedPercent ?? 0, resetsAt: share?.resetsAt ?? null };
    }
    case AiFunding.Credits:
      return { funding, sessionCredits: await sessionCredits(deps, grant.game), balanceCredits: balance };
    case AiFunding.Key:
      return { funding, monthMicros: grant.monthMicros };
    case AiFunding.Free:
      return { funding };
    case AiFunding.Playtest:
      return { funding };
  }
}

/** The maker's pick on Genex credits, when genex.games' lane offers that same model. */
async function creditsPick(deps: GameAiMenuDeps, recommended: AiModelRef | null): Promise<AiModelRef | null> {
  if (!recommended) return null;
  const offered = await deps.doors
    .get(AiDoor.GenexDev)
    ?.models()
    .catch(() => [] as AiModelRef[]);
  const pick: AiModelRef = { door: AiDoor.GenexDev, engine: GENEX_ENGINE, model: recommended.model };
  return offered?.some((model) => sameModel(model, pick)) ? pick : null;
}

/** Every row the doors legal for `game` offer now. */
async function rowsFor(
  deps: GameAiMenuDeps,
  game: AiGameKey,
  check: { rows: readonly AiCheckRow[]; recommended: AiModelRef | null } | null,
): Promise<AiMenuRow[]> {
  const doors = menuDoors(game).flatMap((id) => deps.doors.get(id) ?? []);
  return (await Promise.all(doors.map((door) => doorRows(deps, door, check)))).flat();
}

/** The Genex group: the balance, and the maker's pick on credits with its name. */
async function genexGroup(
  deps: GameAiMenuDeps,
  balance: number | null,
  pick: AiModelRef | null,
): Promise<AiModelMenu["genex"]> {
  const recommended = await creditsPick(deps, pick);
  const facts = recommended ? await deps.facts(recommended).catch(() => null) : null;
  return {
    signedIn: balance !== null,
    balanceCredits: balance,
    recommended,
    recommendedLabel: recommended ? (facts?.label ?? recommended.model) : null,
  };
}

/** The game's model menu, computed now. */
export function createGameAiMenu(deps: GameAiMenuDeps): (game: AiGameKey) => Promise<AiModelMenu> {
  return async (game) => {
    const own = game.startsWith(`${AiGameKind.Create}:`);
    const [title, balance, check] = await Promise.all([
      deps.titleOf(game).catch(() => game),
      deps.balanceCredits().catch(() => null),
      own ? deps.check(game).catch(() => null) : Promise.resolve(null),
    ]);
    const rows = await rowsFor(deps, game, check);
    const off = deps.grants.isOff(game);
    const grant = off ? null : deps.grants.live(game);
    const free = grant ? rows.find((row) => sameModel(row.model, grant.model))?.funding === AiFunding.Free : false;
    return {
      game,
      title,
      current: grant?.model ?? null,
      usage: grant ? await usageOf(deps, grant, free, balance) : null,
      genex: await genexGroup(deps, balance, check?.recommended ?? null),
      groups: grouped(rows.filter((row) => row.fit !== AiCheckFit.Struggles)),
      struggling: rows.filter((row) => row.fit === AiCheckFit.Struggles),
      off,
      // genex.games keeps no listing of a game's leaderboard choice that Studio can read: none is claimed.
      leaderboard: false,
      requires: grant?.requires ?? AiRequirement.Optional,
    };
  };
}
