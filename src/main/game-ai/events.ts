/**
 * What play-time AI tells the rest of the app: the transient `UiEvent.GameAi` news the bar and
 * Studio react to, and the durable `CustomEvent.GameAiCall` record of each settled call. One place
 * builds both, so the ledger and the service never spell an event name.
 */
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import type { GameAiNotice } from "../../shared/game-ai-views.ts";
import { UiEvent, type UiEventMap } from "../../shared/ui-events.ts";
import type { AiLedgerEntry } from "./types.ts";

/** What pushes a UI event (`StudioCore.emit`, main's `pushUiEvent`), narrowed to play-time AI's. */
export type GameAiEmit = (type: typeof UiEvent.GameAi, payload: UiEventMap[typeof UiEvent.GameAi]) => void;

/** Tell the renderer and the Play bar a piece of play-time AI news. */
export function announceGameAi(emit: GameAiEmit, notice: GameAiNotice): void {
  emit(UiEvent.GameAi, notice);
}

/** A settled call's durable record: counts and money, never text. */
export function gameAiCallRecord(entry: AiLedgerEntry) {
  return customEventData(CustomEvent.GameAiCall, {
    game: entry.game,
    site: entry.site,
    door: entry.door,
    model: entry.model,
    provenance: entry.provenance,
    code: entry.code,
    repaired: entry.repaired,
    inputTokens: entry.usage?.inputTokens ?? null,
    outputTokens: entry.usage?.outputTokens ?? null,
    costMicros: entry.costMicros,
    latencyMs: entry.latencyMs,
  });
}
