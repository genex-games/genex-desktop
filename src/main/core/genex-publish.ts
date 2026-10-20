/**
 * Publish pressed in Studio's own Publish dialog. Studio draws that dialog: it names the game and
 * offers the exact files that would go online, and its Publish press uploads exactly those, so the
 * press is the person's consent and neither the native dialog nor a chat card asks again. A plugin panel's or toolbar's
 * request for the same action is only relayed by the main frame, so it still goes through the
 * review, ticket and native dialog of `studio:plugins.action`, and an agent's publish asks in chat.
 * Neither the dialog, an agent nor a plugin's own export publishes a game that holds no web game at
 * its root, such as an Unreal game (`assertPublishable`), as a web game; one that holds a ready Mac or
 * Windows app is published from the dialog as its apps (`publishAppsFromDialog`).
 */
import { CoreFact, hasFact } from "../../shared/project-facts.ts";
import { publishesAsWebGame } from "../../shared/project-workspace.ts";
import { cleanGenexTitle, GENEX_PLUGIN_ID, GenexAction } from "../../shared/genex.ts";
import { type ExportReview, type PluginBinding, PluginSourceKind } from "../../shared/plugins.ts";
import type { StudioCore } from "../studio-core.ts";
import { pinnedCliSendsApps } from "../../plugins/genex/native-publish.ts";
import { publishedApps } from "./publish-platforms.ts";

/** Why Publish is refused before Genex is asked anything. */
const MESSAGE = {
  NoGame: "Open a game to publish it",
  GenexUnavailable: "Publishing needs the Genex plugin, which isn't installed",
  NoFileList: "Review the files before publishing",
  UnrealGame: (title: string) => `${title} builds in Unreal; publishing an Unreal game isn't supported yet.`,
  NotWebGame: (title: string) => `${title} isn't a web game, so Genex can't publish it yet.`,
  NoApps: "This game has no Mac or Windows app ready to publish",
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

/**
 * Studio's own Genex, installed: the only plugin whose publish the dialog runs. On or off: Publish
 * belongs to the person's account, and Genex off takes only the agent's tools.
 */
const isUsableGenex = (plugin: InstalledPlugin): boolean =>
  plugin.manifest.id === GENEX_PLUGIN_ID && plugin.source === PluginSourceKind.Bundled && !plugin.removed;

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
 * yet is, one of a kind Genex can't name is not), or one whose web game is in a folder of it (an
 * engine's web export, `webFolderOf`), which goes in the root's place; an Unreal game's folder holds an Unreal project and no web build, and any other kind of
 * project none either. The dialog, an agent's `genex__publish` and a plugin's `export.stage` ask
 * this before anyone is asked anything.
 */
export async function assertPublishable(core: Pick<StudioCore, "games">, project: string): Promise<void> {
  const game = (await core.games.list()).find((g) => g.name === project);
  if (!game || publishesAsWebGame(game)) return;
  if (hasFact(game.facts, CoreFact.UnrealProject))
    throw new PublishRefusedError(PublishRefusal.UnrealGame, MESSAGE.UnrealGame(game.title));
  throw new PublishRefusedError(PublishRefusal.NotWebGame, MESSAGE.NotWebGame(game.title));
}

/** The game the dialog names, bound as Studio allows it to be opened, while Studio's Genex is installed. */
async function boundGame(core: DialogCore, project: unknown): Promise<PluginBinding> {
  if (typeof project !== "string" || !project) throw new Error(MESSAGE.NoGame);
  if (!core.plugins.list().some(isUsableGenex)) throw new Error(MESSAGE.GenexUnavailable);
  const binding = await core.pluginBinding(project);
  if (!binding) throw new Error(MESSAGE.NoGame);
  return binding;
}

/** {@link boundGame} for a game Publish can put online as a web game. */
async function dialogBinding(core: DialogCore, project: unknown): Promise<PluginBinding> {
  const binding = await boundGame(core, project);
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
 * left), after the person approved `review` in the dialog. The game's ready apps, which the dialog
 * lists above its press, go once the web build is public (`publishedApps`).
 */
export async function publishFromDialog(
  core: DialogCore,
  project: unknown,
  review: unknown,
  title?: unknown,
  sendsApps = pinnedCliSendsApps(),
): Promise<void> {
  if (!isExportReview(review)) throw new Error(MESSAGE.NoFileList);
  const binding = await dialogBinding(core, project);
  const name = cleanGenexTitle(title);
  const native = await publishedApps(core, binding.project, sendsApps);
  const args = { ...(name ? { title: name } : {}), ...(native.length > 0 ? { native } : {}) };
  // Genex exports inside this call, so the approval lives exactly as long as it.
  await core.withApprovedExport(GENEX_PLUGIN_ID, binding.project, review, () =>
    core.plugins.action(GENEX_PLUGIN_ID, GenexAction.PublishGallery, args, binding),
  );
}

/**
 * Publish a game that has only apps, no web build (a Unity or Unreal game built for the Mac), from
 * the dialog: its ready apps go to Genex and the game is listed under `title`. The rows the dialog
 * lists above its press name exactly these apps, so the press is the consent. Refused when the game
 * has no ready app, or Studio's Genex CLI cannot send apps.
 */
export async function publishAppsFromDialog(
  core: DialogCore,
  project: unknown,
  title?: unknown,
  sendsApps = pinnedCliSendsApps(),
): Promise<void> {
  const binding = await boundGame(core, project);
  const native = await publishedApps(core, binding.project, sendsApps);
  if (native.length === 0) throw new Error(MESSAGE.NoApps);
  const name = cleanGenexTitle(title);
  await core.plugins.action(
    GENEX_PLUGIN_ID,
    GenexAction.PublishApps,
    { native, ...(name ? { title: name } : {}) },
    binding,
  );
}
