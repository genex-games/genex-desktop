/**
 * A plugin's Live card (`ObserverLive.Card`): what its `status` action answers for the game on the
 * stage, read by the host before any of it is drawn. The plugin says where the game stands in one
 * line, an optional quieter hint, and at most one step: one of its own actions, or its panel. A
 * plugin's text is never markup, never longer than a line, and a button names only an action the
 * plugin declared.
 */

/** The longest line and hint a card shows. */
export const STAGE_CARD_LINE_CHARS = 160;
/** The longest button label a card shows. */
export const STAGE_CARD_LABEL_CHARS = 40;

/** A card's one step: one of the plugin's declared actions, or its own panel. */
export type PluginStageButton = { label: string; action: string } | { label: string; panel: true };

/** A plugin's card, as the stage draws it. */
export interface PluginStageCard {
  line: string;
  hint?: string;
  button?: PluginStageButton;
}

/** Whether `value` is an object whose fields can be read. */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Text of one line: no control, format, line or paragraph separator (no break, no bidi override), not empty. */
const PRINTABLE = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u;

/** Text of one line, nothing that breaks or reorders it, at most `max` characters; null otherwise. */
function oneLine(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return PRINTABLE.test(text) && text.length <= max ? text : null;
}

/** The card's button, when it names a label and either the panel or an action the plugin declared. */
function buttonFrom(value: unknown, actions: ReadonlySet<string>): PluginStageButton | undefined {
  if (!isRecord(value)) return undefined;
  const label = oneLine(value.label, STAGE_CARD_LABEL_CHARS);
  if (!label) return undefined;
  if (value.panel === true) return { label, panel: true };
  const action = typeof value.action === "string" && actions.has(value.action) ? value.action : null;
  return action ? { label, action } : undefined;
}

/**
 * A plugin's answer as a card, or null when it has no line to show. A hint or button that breaks
 * the rules is dropped, never shown in part.
 */
export function stageCardFrom(value: unknown, actions: ReadonlySet<string>): PluginStageCard | null {
  if (!isRecord(value)) return null;
  const line = oneLine(value.line, STAGE_CARD_LINE_CHARS);
  if (!line) return null;
  const hint = oneLine(value.hint, STAGE_CARD_LINE_CHARS);
  const button = buttonFrom(value.button, actions);
  return { line, ...(hint ? { hint } : {}), ...(button ? { button } : {}) };
}
