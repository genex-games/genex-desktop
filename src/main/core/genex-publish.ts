/**
 * Publish pressed in Studio's own Publish dialog. Studio draws that dialog: it names the game and
 * offers the exact files that would go online, and its Publish press uploads exactly those, so the
 * press is the person's consent and neither the native dialog nor a chat card asks again. A plugin panel's or toolbar's
 * request for the same action is only relayed by the main frame, so it still goes through the
 * review, ticket and native dialog of `studio:plugins.action`, and an agent's publish asks in chat.
 * Neither the dialog, an agent nor a plugin's own export publishes a game that holds no web game at
 * its root, such as an Unreal game (`assertPublishable`).
 */
import { CoreFact, hasFact, servedAsWebGame } from "../../shared/project-facts.ts";
import { cleanGenexTitle, GENEX_PLUGIN_ID, GenexAction } from "../../shared/genex.ts";
import { type ExportReview, type PluginBinding, PluginSourceKind } from "../../shared/plugins.ts";
import type { StudioCore } from "../studio-core.ts";

/** Why Publish is refused before Genex is asked anything. */
const MESSAGE = {
  NoGame: "Open a game to publish it",
  GenexUnavailable: "Turn on Genex Tools to publish",
  NoFileList: "Review the files before publishing",
  UnrealGame: (title: string) => `${title} builds in Unreal; publishing an Unreal game isn't supported yet.`,
  NotWebGame: (title: string) => `${title} isn't a web game, so Genex can't publish it yet.`,
} as const;

/** Why a game can't be published at all, by code: callers act on it, never on its words. */
export const PublishRefusal = { UnrealGame: "unreal-game", NotWebGame: "not-web-game" } as const;
export type PublishRefusal = (typeof PublishRefusal)[keyof typeof PublishRefusal];

/** A publish refused for what the game is, with a code a caller can act on. */
export class PublishRefusedError extends Error {
  readonly code: PublishRefusal;
  constructor(code: PublishRefusal, message: string) {
    super(message);
    this.name = "PublishRefusedError";
    this.code = code;
  }
}

type InstalledPlugin = ReturnType<StudioCore["plugins"]["list"]>[number];
type DialogCore = Pick<StudioCore, "games" | "plugins" | "pluginBinding" | "publicCopyFiles" | "withApprovedExport">;

/** Studio's own Genex, on: the only plugin whose publish the dialog runs. */
const isUsableGenex = (plugin: InstalledPlugin): boolean =>
  plugin.manifest.id === GENEX_PLUGIN_ID &&
  plugin.source === PluginSourceKind.Bundled &&
  plugin.enabled &&
  !plugin.removed;

const isFileList = (files: unknown): files is string[] =>
  Array.isArray(files) && files.every((file) => typeof file === "string");

/** A file list as the renderer sent it back: both lists, every entry a path. */
const isExportReview = (review: unknown): review is ExportReview =>
  typeof review === "object" &&
  review !== null &&
  "included" in review &&
  isFileList(review.included) &&
  "excluded" in review &&
  isFileList(review.excluded);

/**
 * Refuses a game Publish can't put online, by what its folder holds. Publish exports the game
 * folder as a web game, so only a game served as a web game at its root may go (one with no kind
 * yet is, one of a kind Genex can't name is not); an Unreal game's folder holds an Unreal project and no web build, and any other kind of
 * project none either. The dialog, an agent's `genex__publish` and a plugin's `export.stage` ask
 * this before anyone is asked anything.
 */
export async function assertPublishable(core: Pick<StudioCore, "games">, project: string): Promise<void> {
  const game = (await core.games.list()).find((g) => g.name === project);
  if (!game || servedAsWebGame(game)) return;
  if (hasFact(game.facts, CoreFact.UnrealProject))
    throw new PublishRefusedError(PublishRefusal.UnrealGame, MESSAGE.UnrealGame(game.title));
  throw new PublishRefusedError(PublishRefusal.NotWebGame, MESSAGE.NotWebGame(game.title));
}

/** The game the dialog names, bound as Studio allows it to be opened, while Studio's Genex is on. */
async function dialogBinding(core: DialogCore, project: unknown): Promise<PluginBinding> {
  if (typeof project !== "string" || !project) throw new Error(MESSAGE.NoGame);
  if (!core.plugins.list().some(isUsableGenex)) throw new Error(MESSAGE.GenexUnavailable);
  const binding = await core.pluginBinding(project);
  if (!binding) throw new Error(MESSAGE.NoGame);
  await assertPublishable(core, binding.project);
  return binding;
}

/** The files Publish would put online for `project`, for the dialog to show. Nothing is uploaded. */
export async function publishReview(core: DialogCore, project: unknown): Promise<ExportReview> {
  const binding = await dialogBinding(core, project);
  return core.publicCopyFiles(binding.project);
}

/**
 * Publish `project` to the Genex gallery under `title` (cleaned; the plugin picks the name when none is
 * left), after the person approved `review` in the dialog.
 */
export async function publishFromDialog(
  core: DialogCore,
  project: unknown,
  review: unknown,
  title?: unknown,
): Promise<void> {
  if (!isExportReview(review)) throw new Error(MESSAGE.NoFileList);
  const binding = await dialogBinding(core, project);
  const name = cleanGenexTitle(title);
  // Genex exports inside this call, so the approval lives exactly as long as it.
  await core.withApprovedExport(GENEX_PLUGIN_ID, binding.project, review, () =>
    core.plugins.action(GENEX_PLUGIN_ID, GenexAction.PublishGallery, name ? { title: name } : {}, binding),
  );
}
