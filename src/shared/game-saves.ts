/**
 * A Rust · wgpu game's saves and its gameplay UI's session settings as the host speaks them: the
 * `saves` and `uiSettings` ops (`shared/native-contract.ts`), the codes a game refuses them with
 * and the checks every argument goes through before anything is sent. Browser-safe: the renderer
 * words the codes.
 *
 * Copies held to this one: genex-save's `SaveErrorCode` and `SlotName` and genex-ui's
 * `TextErrorCode`, scale range and locale cap, through `tests/fixtures/native-saves.json` (each
 * crate's `tests/wire_fixture.rs`); the harness seed's `loop/native-contract.ts`, through
 * `seed-contracts.test.ts`. A value is appended in all of them together and never renamed.
 */

/** What a `saves` call does (`{op, slot?, label?, envelope?}`). Wire values: never rename one. */
export const SaveOp = {
  /** The slots, their total bytes and the game's quota: `{slots, bytes, quota}`. */
  List: "list",
  /** One slot's decoded envelope, or `{tooLarge, bytes, digest}` past {@link NATIVE_SAVES_ENVELOPE_MAX_BYTES}. */
  Read: "read",
  /** Seed a slot with a fixture envelope, validated and migrated as a load would. */
  Write: "write",
  /** Save the running game into a slot, with an optional label. */
  Save: "save",
  /** Load a slot; the answer comes once it applied: `{tick, checksum, checksumMatch}`. */
  Load: "load",
  /** Delete a slot. */
  Delete: "delete",
} as const;
export type SaveOp = (typeof SaveOp)[keyof typeof SaveOp];

/**
 * Why a game refused a save, load or delete (genex-save's `SaveErrorCode`, in its order). Nothing
 * changed. `save-quota` and `save-unavailable` are genex-core's mirror codes, spelled as it spells
 * them. Wire values: never rename one.
 */
export const SaveErrorCode = {
  SlotInvalid: "save-slot-invalid",
  SlotMissing: "save-slot-missing",
  SlotsFull: "save-slots-full",
  TooLarge: "save-too-large",
  Quota: "save-quota",
  Unavailable: "save-unavailable",
  Corrupt: "save-corrupt",
  FormatUnknown: "save-format-unknown",
  Newer: "save-newer",
  MigrationMissing: "save-migration-missing",
  MigrationFailed: "save-migration-failed",
  SectionInvalid: "save-section-invalid",
  SectionMissing: "save-section-missing",
  Busy: "save-busy",
  LoadTimeout: "save-load-timeout",
  NotConfigured: "save-not-configured",
} as const satisfies Record<string, `save-${string}`>;
export type SaveErrorCode = (typeof SaveErrorCode)[keyof typeof SaveErrorCode];

/**
 * The volatile issue a load reports when it applied but the recomputed state checksum differs
 * from the saved one. Not a refusal: the restored game runs.
 */
export const SAVE_RESTORE_DIVERGED = "save-restore-diverged";

/** Why a game's text could not be shown as asked (genex-ui's `TextErrorCode`, in its order). Wire values. */
export const TextErrorCode = {
  /** A key the loaded locale has no message for (the key is drawn instead). */
  Missing: "text-missing",
  /** A broken `.ftl` entry, a file that is not UTF-8, or a message whose arguments did not resolve. */
  Invalid: "text-invalid",
  /** A text file past its size or key cap. */
  TooLarge: "text-too-large",
  /** A chosen locale the game does not offer (a `uiSettings` locale refuses with it). */
  LocaleUnknown: "text-locale-unknown",
  /** A locale's fallback font is not among the game's assets. */
  FontMissing: "text-font-missing",
} as const satisfies Record<string, `text-${string}`>;
export type TextErrorCode = (typeof TextErrorCode)[keyof typeof TextErrorCode];

/** The most bytes a slot name holds (genex-save's `SLOT_NAME_MAX`). */
export const SAVE_SLOT_NAME_MAX = 32;
/** The most characters a slot's label holds (genex-save's `LABEL_CHARS_MAX`). */
export const SAVE_LABEL_CHARS_MAX = 64;
/**
 * The most bytes of JSON an envelope a `saves` call carries (a `write`) or answers (a `read`) may
 * hold: a request or reply line is at most `NATIVE_LINE_MAX_BYTES` (1 MiB), and this leaves room
 * for the line's own members.
 */
export const NATIVE_SAVES_ENVELOPE_MAX_BYTES = 1024 * 1024 - 4 * 1024;
/** The longest locale tag (genex-ui's `LOCALE_TAG_CHARS_MAX`). */
export const UI_LOCALE_TAG_CHARS_MAX = 35;
/** The smallest and largest UI scale (genex-ui's `UI_SCALE_MIN`, `UI_SCALE_MAX`). */
export const UI_SCALE_MIN = 0.5;
export const UI_SCALE_MAX = 3.0;
/** The text size range, a multiplier of the game's own text size, as the UI scale's. */
export const UI_TEXT_SIZE_MIN = UI_SCALE_MIN;
export const UI_TEXT_SIZE_MAX = UI_SCALE_MAX;
/** The largest safe-area inset, in world pixels: an output's largest side. */
export const UI_SAFE_AREA_MAX_PX = 4096;

/** A slot name's shape: lowercase letters, digits and dashes, not starting with a dash. */
const SLOT_NAME = /^[a-z0-9][a-z0-9-]*$/;
/** A locale tag's shape: a language subtag, then subtags joined by `-` or `_` (genex-ui parses it in full). */
const LOCALE_TAG = /^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*$/;

/** A `saves` argument as the host sends it. */
export type SavesArg =
  | { op: typeof SaveOp.List }
  | { op: typeof SaveOp.Read | typeof SaveOp.Load | typeof SaveOp.Delete; slot: string }
  | { op: typeof SaveOp.Save; slot: string; label?: string }
  | { op: typeof SaveOp.Write; slot: string; envelope: Record<string, unknown> };

/** The UI's left, top, right and bottom safe-area insets, in world pixels. */
export type UiSafeArea = [left: number, top: number, right: number, bottom: number];

/**
 * A `uiSettings` change, a session layer over the game's defaults: a member left out stays, a
 * null gives the game's own back, and no member at all reads the settings in force.
 */
export interface UiSettingsArg {
  locale?: string | null;
  scale?: number | null;
  safeArea?: UiSafeArea | null;
  textSize?: number | null;
}

/** An argument the host sends, or why it refused it (`bad-argument`: nothing is sent). */
export type GameArgCheck<T> = { ok: true; arg: T } | { ok: false };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const SAVE_OPS: ReadonlySet<string> = new Set<SaveOp>(Object.values(SaveOp));
const isSaveOp = (value: unknown): value is SaveOp => typeof value === "string" && SAVE_OPS.has(value);

/** Whether `value` is a slot name a game may be asked for: the shape only (a game refuses reserved names itself). */
export function isSafeSlotName(value: unknown): value is string {
  return typeof value === "string" && value.length <= SAVE_SLOT_NAME_MAX && SLOT_NAME.test(value);
}

const isLabel = (value: unknown): value is string =>
  typeof value === "string" && [...value].length <= SAVE_LABEL_CHARS_MAX;

/** The UTF-8 size of `value` as JSON, or null when it is not JSON (a cycle, a BigInt). */
function jsonBytes(value: unknown): number | null {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return null;
  }
}

const isEnvelope = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const bytes = jsonBytes(value);
  return bytes !== null && bytes <= NATIVE_SAVES_ENVELOPE_MAX_BYTES;
};

/** The members of a checked `saves` argument a game reads (it ignores any other). */
function savesArgOf(op: SaveOp, arg: Record<string, unknown>): SavesArg | null {
  if (op === SaveOp.List) return { op };
  const { slot, label, envelope } = arg;
  if (!isSafeSlotName(slot)) return null;
  if (op === SaveOp.Save) {
    if (label === undefined) return { op, slot };
    return isLabel(label) ? { op, slot, label } : null;
  }
  if (op === SaveOp.Write) return isEnvelope(envelope) ? { op, slot, envelope } : null;
  return { op, slot };
}

/**
 * A `saves` argument checked before anything is sent: an op the game knows, a slot name of a safe
 * shape, a label within its cap and a `write`'s envelope a JSON object a line can carry. Anything
 * else is refused (`bad-argument`), and the game is never asked.
 */
export function checkSavesArg(arg: unknown): GameArgCheck<SavesArg> {
  if (!isRecord(arg) || !isSaveOp(arg.op)) return { ok: false };
  const checked = savesArgOf(arg.op, arg);
  return checked ? { ok: true, arg: checked } : { ok: false };
}

/** A finite number inside `[min, max]`. */
const isWithin = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const isInset = (value: unknown): boolean => isWithin(value, 0, UI_SAFE_AREA_MAX_PX);
const isLocaleTag = (value: unknown): value is string =>
  typeof value === "string" && value.length <= UI_LOCALE_TAG_CHARS_MAX && LOCALE_TAG.test(value);
const isSafeArea = (value: unknown): value is UiSafeArea =>
  Array.isArray(value) && value.length === 4 && value.every(isInset);

/** Each member's check; null always passes (it gives the game's own value back). */
const UI_SETTING_CHECKS = {
  locale: isLocaleTag,
  scale: (value: unknown) => isWithin(value, UI_SCALE_MIN, UI_SCALE_MAX),
  safeArea: isSafeArea,
  textSize: (value: unknown) => isWithin(value, UI_TEXT_SIZE_MIN, UI_TEXT_SIZE_MAX),
} as const satisfies Record<keyof UiSettingsArg, (value: unknown) => boolean>;

/**
 * A `uiSettings` argument checked before anything is sent: no argument reads; otherwise each
 * member given is null or in its shape and range (a locale tag, a scale and text size in
 * 0.5..3, four insets). Anything else is refused (`bad-argument`), and the game is never asked;
 * a well-formed locale the game does not offer is the game's to refuse (`text-locale-unknown`).
 */
export function checkUiSettingsArg(arg: unknown): GameArgCheck<UiSettingsArg> {
  if (arg === undefined) return { ok: true, arg: {} };
  if (!isRecord(arg)) return { ok: false };
  const change: Record<string, unknown> = {};
  for (const [member, check] of Object.entries(UI_SETTING_CHECKS)) {
    const value = arg[member];
    if (value === undefined) continue;
    if (value !== null && !check(value)) return { ok: false };
    change[member] = Array.isArray(value) ? [...value] : value;
  }
  return { ok: true, arg: change };
}
