/**
 * Publish pressed in Studio's own Publish dialog. Studio draws that dialog: it names the game and
 * offers the exact files that would go online, and its Publish press uploads exactly those, so the
 * press is the person's consent and neither the native dialog nor a chat card asks again. A plugin panel's or toolbar's
 * request for the same action is only relayed by the main frame, so it still goes through the
 * review, ticket and native dialog of `studio:plugins.action`, and an agent's publish asks in chat.
 * Neither the dialog, an agent nor a plugin's own export publishes a game that holds no web game at
 * its root, such as an Unreal game (`assertPublishable`), as a web game; one that holds a ready Mac or
 * Windows app is published from the dialog as its apps (`publishAppsFromDialog`). A Rust · wgpu game publishes its web
 * export, the lane's packaged page (G6 MP-5c), and one with no web build is refused `no-web-export`.
 */
import path from "node:path";
import { BuildTarget, destinationsOf, type GameProject, GameStack, stackOf } from "../../shared/game-project.ts";
import { CoreFact, hasFact } from "../../shared/project-facts.ts";
import { publishesAsWebGame } from "../../shared/project-workspace.ts";
import { cleanGenexTitle, GENEX_PLUGIN_ID, GenexAction } from "../../shared/genex.ts";
import { type ExportReview, type PluginBinding, PluginSourceKind } from "../../shared/plugins.ts";
import { readRegularFile } from "../../substrate/fsx.ts";
import { readGenexToml } from "../../substrate/genex-toml.ts";
import { containedReal } from "../../substrate/paths.ts";
import type { StudioCore } from "../studio-core.ts";
import { pinnedCliSendsApps } from "../../plugins/genex/native-publish.ts";
import { publishedApps } from "./publish-platforms.ts";
import { t } from "../../shared/i18n.ts";

/** Why Publish is refused before Genex is asked anything. */
const MESSAGE = {
  NoGame: () => t("Open a game to publish it"),
  GenexUnavailable: () => t("Publishing needs the Genex plugin, which isn't installed"),
  NoFileList: () => t("Review the files before publishing"),
  UnrealGame: (title: string) =>
    t("{title} builds in Unreal; publishing an Unreal game isn't supported yet.", { title }),
  NotWebGame: (title: string) => t("{title} isn't a web game, so Genex can't publish it yet.", { title }),
  NoApps: () => t("This game has no Mac, Windows or Linux app ready to publish"),
  NoWebExport: (title: string) =>
    `${title} has no web build, so Genex can't publish it: add Browser to its destinations and keep genex.toml free of [gpu] native_features.`,
} as const;

/** Why a game can't be published at all, by code: callers act on it, never on its words. */
export const PublishRefusal = {
  UnrealGame: "unreal-game",
  NotWebGame: "not-web-game",
  /** A Rust · wgpu game with no web build: Browser is not a destination, or it declares native-only GPU features. */
  NoWebExport: "no-web-export",
} as const;
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
  if (!game) return;
  // A Rust game goes online as its lane's web export, whatever facts its folder shows.
  if (stackOf(game.shape) === GameStack.RustWgpu) {
    if (await lacksRustWebBuild(game))
      throw new PublishRefusedError(PublishRefusal.NoWebExport, MESSAGE.NoWebExport(game.title));
    return;
  }
  if (publishesAsWebGame(game)) return;
  if (hasFact(game.facts, CoreFact.UnrealProject))
    throw new PublishRefusedError(PublishRefusal.UnrealGame, MESSAGE.UnrealGame(game.title));
  throw new PublishRefusedError(PublishRefusal.NotWebGame, MESSAGE.NotWebGame(game.title));
}

/**
 * Whether a Rust · wgpu game has no web build to publish: Browser is not among its destinations,
 * or its genex.toml declares native-only GPU features. A genex.toml that does not parse is left to
 * the export, which refuses it with its own code.
 */
export async function lacksRustWebBuild(game: Pick<GameProject, "dir" | "destinations">): Promise<boolean> {
  if (!destinationsOf(game).targets.includes(BuildTarget.Web)) return true;
  const parsed = await readGenexToml(game.dir).catch(() => null);
  return parsed?.ok === true && parsed.manifest.nativeFeatures.length > 0;
}

/** A project name the publish workspace holds a folder for: one plain path segment. */
const PROJECT_NAME = /^[a-zA-Z0-9_-]+$/;
/** The most of a binding record the host reads. */
const BINDING_MAX_BYTES = 64 * 1024;

/**
 * The game's Genex binding: the slug of the draft Genex holds for `project`, from the Genex
 * plugin's publish workspace under `genexStorage` (`publish/<project>/.genex/project.json`),
 * resolved by realpath inside it. Null when there is no draft yet or the record is not one.
 * A networked Rust export bakes it in for the relay (G6 MP-5b, `rust-build.ts`).
 */
export async function genexDraftSlug(genexStorage: string, project: string): Promise<string | null> {
  if (!PROJECT_NAME.test(project)) return null;
  try {
    const file = await containedReal(genexStorage, path.join("publish", project, ".genex", "project.json"));
    const meta: unknown = JSON.parse((await readRegularFile(file, BINDING_MAX_BYTES)).toString("utf8"));
    const slug = typeof meta === "object" && meta !== null && "slug" in meta ? meta.slug : null;
    return typeof slug === "string" && slug.length > 0 ? slug : null;
  } catch {
    return null;
  }
}

/** The dialog's Allow remixing as the publish's argument: sent only when the dialog said yes or no. */
const remixArg = (remix: unknown): { remix?: boolean } => (typeof remix === "boolean" ? { remix } : {});

/** The game the dialog names, bound as Studio allows it to be opened, while Studio's Genex is installed. */
async function boundGame(core: DialogCore, project: unknown): Promise<PluginBinding> {
  if (typeof project !== "string" || !project) throw new Error(MESSAGE.NoGame());
  if (!core.plugins.list().some(isUsableGenex)) throw new Error(MESSAGE.GenexUnavailable());
  const binding = await core.pluginBinding(project);
  if (!binding) throw new Error(MESSAGE.NoGame());
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
  remix?: unknown,
): Promise<void> {
  if (!isExportReview(review)) throw new Error(MESSAGE.NoFileList());
  const binding = await dialogBinding(core, project);
  const name = cleanGenexTitle(title);
  const native = await publishedApps(core, binding.project, sendsApps);
  const args = { ...(name ? { title: name } : {}), ...(native.length > 0 ? { native } : {}), ...remixArg(remix) };
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
  remix?: unknown,
): Promise<void> {
  const binding = await boundGame(core, project);
  const native = await publishedApps(core, binding.project, sendsApps);
  if (native.length === 0) throw new Error(MESSAGE.NoApps());
  const name = cleanGenexTitle(title);
  await core.plugins.action(
    GENEX_PLUGIN_ID,
    GenexAction.PublishApps,
    { native, ...(name ? { title: name } : {}), ...remixArg(remix) },
    binding,
  );
}
