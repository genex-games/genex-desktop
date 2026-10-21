/**
 * Publish pressed in Studio's own Publish dialog. Studio draws that dialog: it names the game and
 * offers the exact files that would go online, and its Publish press uploads exactly those, so the
 * press is the person's consent and neither the native dialog nor a chat card asks again. A plugin panel's or toolbar's
 * request for the same action is only relayed by the main frame, so it still goes through the
 * review, ticket and native dialog of `studio:plugins.action`, and an agent's publish asks in chat.
 * Neither the dialog, an agent nor a plugin's own export publishes a game that holds no web game at
 * its root, such as an Unreal game (`assertPublishable`). A Rust · wgpu game publishes its web
 * export, the lane's packaged page (G6 MP-5c), and one with no web build is refused `no-web-export`.
 */
import path from "node:path";
import { BuildTarget, destinationsOf, type GameProject, GameStack, stackOf } from "../../shared/game-project.ts";
import { CoreFact, hasFact, servedAsWebGame } from "../../shared/project-facts.ts";
import { cleanGenexTitle, GENEX_PLUGIN_ID, GenexAction } from "../../shared/genex.ts";
import { type ExportReview, type PluginBinding, PluginSourceKind } from "../../shared/plugins.ts";
import { readRegularFile } from "../../substrate/fsx.ts";
import { readGenexToml } from "../../substrate/genex-toml.ts";
import { containedReal } from "../../substrate/paths.ts";
import type { StudioCore } from "../studio-core.ts";

/** Why Publish is refused before Genex is asked anything. */
const MESSAGE = {
  NoGame: "Open a game to publish it",
  GenexUnavailable: "Turn on Genex Tools to publish",
  NoFileList: "Review the files before publishing",
  UnrealGame: (title: string) => `${title} builds in Unreal; publishing an Unreal game isn't supported yet.`,
  NotWebGame: (title: string) => `${title} isn't a web game, so Genex can't publish it yet.`,
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
  if (!game) return;
  // A Rust game goes online as its lane's web export, whatever facts its folder shows.
  if (stackOf(game.shape) === GameStack.RustWgpu) {
    if (await lacksRustWebBuild(game))
      throw new PublishRefusedError(PublishRefusal.NoWebExport, MESSAGE.NoWebExport(game.title));
    return;
  }
  if (servedAsWebGame(game)) return;
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
