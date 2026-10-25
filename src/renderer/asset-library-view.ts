/**
 * What the Assets tab draws from a game's library states: each card's tag and share line, which
 * cards a modifier click selects, what Save and Share can act on, and what a search finds in the
 * game, the person's library and the community. Pure, so each rule is checked without a window.
 */
import {
  type AssetLibraryState,
  type GameLibraryStates,
  type LibraryAsset,
  LibraryKind,
  SHARE_NAME_MAX,
  type ShareItem,
  ShareMiss,
  shareNameOf,
} from "../shared/asset-library.ts";
import type { ProjectAsset } from "../shared/game-assets.ts";
import type { PlayGame } from "../shared/play.ts";
import { assetTitle } from "./asset-names.ts";
import type { IconName } from "./ui/icons.tsx";

/** Where one share is on its card's line. */
export const ShareStep = { Send: "send", Check: "check", Live: "live", Missed: "missed" } as const;
export type ShareStep = (typeof ShareStep)[keyof typeof ShareStep];

/** A step the line names. */
export type LineStep = typeof ShareStep.Send | typeof ShareStep.Check | typeof ShareStep.Live;

/** The steps the line names, in order. */
export const SHARE_STEPS: readonly LineStep[] = [ShareStep.Send, ShareStep.Check, ShareStep.Live];

/** One share on its card: the name it goes under, its step, and why it missed when it did. */
export interface ShareProgress {
  name: string;
  step: ShareStep;
  /** Why it is not on Play: set when `step` is Missed, and Checking while genex.games still checks. */
  miss: ShareMiss | null;
  /** A refusal's report went to the Genex team. */
  reported: boolean;
  /** genex.games' own words on a refusal, for the report. */
  detail?: string;
}

/** What a refused or failed share offers under its card. */
export const MissAction = { Retry: "retry", Report: "report", Reported: "reported", None: "none" } as const;
export type MissAction = (typeof MissAction)[keyof typeof MissAction];

/** What a card's line shows. */
export const ShareLineKind = { Steps: "steps", Live: "live", Missed: "missed" } as const;

/** A card's line: the steps (the current one bright), the ✓ once on Play, or why it missed and what to do. */
export type ShareLine =
  | { kind: typeof ShareLineKind.Steps; current: ShareStep; checking: boolean }
  | { kind: typeof ShareLineKind.Live }
  | { kind: typeof ShareLineKind.Missed; miss: ShareMiss; action: MissAction };

/** Misses Try again cannot change: the file or its kind can't go on Play. */
const FINAL_MISSES: ReadonlySet<ShareMiss> = new Set([ShareMiss.NotShareable, ShareMiss.KindNotShareable]);

/** What a missed share offers: a report for genex.games' refusal, nothing for a final one, else Try again. */
function missAction(progress: ShareProgress): MissAction {
  if (progress.miss === ShareMiss.Refused) return progress.reported ? MissAction.Reported : MissAction.Report;
  if (progress.miss && FINAL_MISSES.has(progress.miss)) return MissAction.None;
  return MissAction.Retry;
}

/** The line under a card for its share. */
export function shareLineOf(progress: ShareProgress): ShareLine {
  if (progress.step === ShareStep.Live) return { kind: ShareLineKind.Live };
  if (progress.step === ShareStep.Missed) {
    return { kind: ShareLineKind.Missed, miss: progress.miss ?? ShareMiss.Failed, action: missAction(progress) };
  }
  return { kind: ShareLineKind.Steps, current: progress.step, checking: progress.miss === ShareMiss.Checking };
}

/** How many rows a share's line takes under its card: a miss with an action puts the action under its words. */
export function lineRows(progress: ShareProgress): number {
  const line = shareLineOf(progress);
  return line.kind === ShareLineKind.Missed && line.action !== MissAction.None ? 2 : 1;
}

/** How one named step reads against the current one: passed, current, or still ahead. */
export const StepMark = { Done: "done", On: "on", Ahead: "ahead" } as const;
export type StepMark = (typeof StepMark)[keyof typeof StepMark];

/** How `step` reads while the share is at `current`. */
export function stepMark(step: LineStep, current: ShareStep): StepMark {
  const at = SHARE_STEPS.indexOf(step);
  const now = SHARE_STEPS.findIndex((each) => each === current);
  if (at === now) return StepMark.On;
  return at < now ? StepMark.Done : StepMark.Ahead;
}

/** Whether a share is still on its way (its button reads Sharing…). */
export const shareUnderway = (progress: ShareProgress | undefined): boolean =>
  progress?.step === ShareStep.Send || progress?.step === ShareStep.Check;

/** One file's library state, or null when the library has no word on it. */
export function stateOf(library: GameLibraryStates | null, file: string): AssetLibraryState | null {
  if (!library || library.unread) return null;
  return library.states.find((state) => state.file === file) ?? null;
}

/** The tag a card or a tile wears: Shared once on Play, else Saved, else none. */
export const CardTag = { Saved: "saved", Shared: "shared" } as const;
export type CardTag = (typeof CardTag)[keyof typeof CardTag];

/** The tag of a game file's library state or of a library asset, which carry the same marks. */
export function cardTagOf(marks: Pick<AssetLibraryState, "saved" | "shared"> | null): CardTag | null {
  if (marks?.shared?.live) return CardTag.Shared;
  return marks?.saved ? CardTag.Saved : null;
}

/** What stands for an asset of each kind while it has no picture of its own. */
export const KIND_GLYPH = {
  [LibraryKind.Model]: "box",
  [LibraryKind.Image]: "image",
  [LibraryKind.Sound]: "sound",
  [LibraryKind.Video]: "video",
} as const satisfies Record<LibraryKind, IconName>;

/** Whether Save can act on a file: it is in the library, or a kind genex.games takes from the app. */
export function canSave(state: AssetLibraryState | null): boolean {
  return state?.saveable === true;
}

/** Whether Share can act on a file: Genex made it and it is not on Play already. */
export const canShare = (state: AssetLibraryState | null): boolean => Boolean(state?.shareable && !state.shared?.live);

/**
 * The selection after a Cmd- or Shift-click on `file`: the file goes in or out. A selection starts
 * from the card already selected by a plain click, as a Finder selection does.
 */
export function toggledSelection(selection: ReadonlySet<string>, single: string | null, file: string): Set<string> {
  const next = new Set(selection.size > 0 || !single ? selection : [single]);
  if (next.has(file)) next.delete(file);
  else next.add(file);
  return next;
}

/**
 * What the bar's Save and Share act on for a selection: the files Save can take that are not saved
 * yet, and the ones Share can take that are not being shared already.
 */
export function selectionActions(
  library: GameLibraryStates | null,
  files: ReadonlySet<string>,
  shares: Readonly<Record<string, ShareProgress>> = {},
): { save: string[]; share: string[] } {
  const states = [...files].map((file) => stateOf(library, file)).filter((state) => state !== null);
  return {
    save: states.filter((state) => canSave(state) && !state.saved).map((state) => state.file),
    share: states.filter((state) => canShare(state) && !shareUnderway(shares[state.file])).map((state) => state.file),
  };
}

/** The name an asset is offered under on Play: what it was made from, else its file name as words. */
export const offeredName = (asset: ProjectAsset): string =>
  shareNameOf(asset.prompt ?? assetTitle(asset.file), asset.file);

/** A typed name as it goes on Play: trimmed, and no longer than Play takes. */
export const cleanName = (name: string): string => name.trim().slice(0, SHARE_NAME_MAX);

/** The items Share sends, or null while a name is empty. */
export function shareItemsOf(names: ReadonlyArray<{ file: string; name: string }>): ShareItem[] | null {
  const items = names.map(({ file, name }) => ({ file, name: cleanName(name) }));
  return items.every((item) => item.name.length > 0) ? items : null;
}

/** An asset's page on genex.games. */
export const sharedAssetUrl = (web: string, slug: string): string => `${web}/world/${encodeURIComponent(slug)}`;

/** The most results one search group lists; the layer scrolls them. */
export const SEARCH_GROUP_MAX = 30;

/** A search's words, lowercased; none for a blank search. */
export const searchWords = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean);

/** Whether every word appears in `text`. */
const hasEvery = (text: string, words: readonly string[]): boolean => {
  const haystack = text.toLowerCase();
  return words.every((word) => haystack.includes(word));
};

/** The game's own cards a search finds: every word in the file's name or in what it was made from. */
export function gameMatches(assets: readonly ProjectAsset[], query: string): ProjectAsset[] {
  const words = searchWords(query);
  if (words.length === 0) return [];
  return assets
    .filter((asset) => hasEvery(`${assetTitle(asset.file)} ${asset.file} ${asset.prompt ?? ""}`, words))
    .slice(0, SEARCH_GROUP_MAX);
}

/** The generations this game already holds, by its files and their library states. */
export function generationsInGame(assets: readonly ProjectAsset[], library: GameLibraryStates | null): Set<string> {
  const ids = new Set<string>();
  for (const asset of assets) if (asset.generationId) ids.add(asset.generationId);
  for (const state of library?.states ?? []) if (state.generationId) ids.add(state.generationId);
  return ids;
}

/** The library's answer without what this game already holds. */
export function libraryMatches(found: readonly LibraryAsset[], inGame: ReadonlySet<string>): LibraryAsset[] {
  return found.filter((asset) => !inGame.has(asset.id)).slice(0, SEARCH_GROUP_MAX);
}

/** Community assets found, without the ones this game shared itself. */
export function communityMatches(found: readonly PlayGame[], library: GameLibraryStates | null): PlayGame[] {
  const own = new Set((library?.states ?? []).map((state) => state.shared?.slug).filter(Boolean));
  return found.filter((game) => !own.has(game.slug)).slice(0, SEARCH_GROUP_MAX);
}
