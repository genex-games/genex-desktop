/** The game library: create, update (with its cover image), archive, remove, and what a game holds. */
import { validateGameCover } from "../../shared/game-library.ts";
import { isGameStack } from "../../shared/game-project.ts";
import type { StudioInvokePayload } from "../../shared/ipc-channels.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import {
  type CreateOptions,
  CreationError,
  creationRefusal,
  isDestinationList,
  ScaffoldCaller,
} from "../../substrate/game-workspace.ts";
import type { RunSummaryReader } from "../run-summary-reader.ts";
import type { StudioCore } from "../studio-core.ts";
import type { IpcHandle } from "./registrar.ts";

/** The longest side a cover image may have, in pixels. */
const COVER_MAX_PX = 512;
/** The reference stills the Builds tab's prompt card shows: how many, and their long side in pixels. */
const PROMPT_CARD_STILLS = 6;
const PROMPT_CARD_STILL_PX = 640;

/** Why a game library request from the renderer is refused. */
const MESSAGE = {
  unreadableCover: "This image could not be read. Choose another image.",
  coverTooLarge: `Cover images must be at most ${COVER_MAX_PX} pixels across.`,
  projectRequired: "Project is required",
  unknownStack: "Choose a stack the studio knows: Three.js or Rust · wgpu.",
  badTargets: "Choose one to four destinations the studio knows, each once.",
  raylibRetired:
    "New C++ · raylib games can't be made any more; existing ones still open, build and export. Make a Rust · wgpu game instead.",
} as const;

/**
 * Electron's main-process modules, loaded by the two handlers that use them, so the registrar
 * itself loads under plain Node and its payload checks are driven in tests (as `secrets.ts` does).
 */
const electron = () => import("electron");

/**
 * Create game's options from the renderer's payload, checked before anything is written: a stack
 * the studio knows, and one to four destinations it knows, none twice; never C++ · raylib, named
 * as the stack or implied by desktop destinations without one (`raylib-creation-retired`). A title
 * that waits for the game's first idea passes through as `provisional`. The sender is a browser.
 */
function createOptions(payload: StudioInvokePayload<"studio:game.create">): CreateOptions {
  const { parent, provisional, stack, targets } = payload;
  if (stack !== undefined && !isGameStack(stack)) throw new Error(MESSAGE.unknownStack);
  if (targets !== undefined && !isDestinationList(targets)) throw new Error(MESSAGE.badTargets);
  const refusal = creationRefusal({ stack, targets });
  if (refusal) throw new CreationError(refusal, MESSAGE.raylibRetired);
  return {
    ...(parent === undefined ? {} : { parent }),
    ...(provisional === true ? { provisional: true } : {}),
    ...(stack === undefined ? {} : { stack }),
    ...(targets === undefined ? {} : { targets }),
    caller: ScaffoldCaller.Person,
  };
}

export interface GamesIpcDeps {
  core: StudioCore;
  runSummaryReader: RunSummaryReader;
  pushUiEvent(event: UiEvent): void;
}

export function registerGamesIpc(handle: IpcHandle, { core, runSummaryReader, pushUiEvent }: GamesIpcDeps): void {
  // Archive = mark the chats (history is forever). Library folders go to Trash; a folder the
  // user opened from elsewhere stays on disk — closing a Cursor workspace does not delete it.
  handle("studio:game.archive", async (payload) => {
    const { dir, trash } = await core.archiveGame(payload.project);
    if (trash) await (await electron()).shell.trashItem(dir).catch(() => {});
    pushUiEvent({ type: UiEvent.GameChanged, payload: { project: payload.project } });
    return true;
  });

  // A chosen folder is the renderer's word for a path: the core checks it by its real path before
  // anything is written, as it does in `studio:game.location.pick`. Stack and destinations are
  // checked here, and again by the library for the person as caller, before a folder is made.
  handle("studio:game.create", async (payload) => core.createGame(payload.title, createOptions(payload)));
  // The request is the user's own words, read by their own model; the name only names a folder later.
  handle("studio:game.name", async (payload) => core.nameGame(payload));
  handle("studio:backdrop.make", async (payload) => core.makeBackdrop(payload));
  handle("studio:game.update", async (payload) => {
    const cover = payload.patch?.cover;
    if (cover?.kind === "image") {
      validateGameCover(cover);
      const image = (await electron()).nativeImage.createFromDataURL(cover.dataUrl);
      if (image.isEmpty()) throw new Error(MESSAGE.unreadableCover);
      const size = image.getSize();
      if (size.width > COVER_MAX_PX || size.height > COVER_MAX_PX) throw new Error(MESSAGE.coverTooLarge);
      cover.dataUrl = image.toDataURL();
    }
    return core.updateGame(payload.project, payload.patch);
  });
  handle("studio:game.remove", async (payload) => core.removeGame(payload.project));
  // The chat line's Undo names a link by its time, so a click on an older line can't undo a newer link.
  handle("studio:game.engine.undo", async (payload) => core.undoEngineLink(payload));
  handle("studio:games", async () => core.games.list());
  handle("studio:snapshots", async () => core.snapshotIndex.all());
  // The reference stills the user gave a game (`<project>/references/`), small, for the Builds tab's prompt card.
  handle("studio:game.references", async (payload) =>
    core.referenceStills(payload.project, { max: PROMPT_CARD_STILLS, maxPx: PROMPT_CARD_STILL_PX }),
  );
  // The Assets stage: what the game holds, joined with the project's own delivery ledger.
  handle("studio:game.asset.preview", async (payload) => core.previewProjectAsset(payload));
  handle("studio:game.asset.present", async (payload) => core.presentProjectAssets(payload));
  handle("studio:game.asset.rigs", async (payload) => core.projectModelRigs(payload));
  handle("studio:game.assets", async (payload) => {
    if (!payload || typeof payload.project !== "string") throw new Error(MESSAGE.projectRequired);
    const events = await runSummaryReader.forProject(payload.project, core.mainThread);
    return core.projectAssets(payload.project, events);
  });
  handle("studio:game.asset.still", async (payload) => core.readProjectAsset(payload));
}
