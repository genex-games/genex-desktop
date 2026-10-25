/** The game library: create, update (with its cover image), archive, remove, and what a game holds. */
import { nativeImage, shell } from "electron";
import { validateGameCover } from "../../shared/game-library.ts";
import { t } from "../../shared/i18n.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import type { RunSummaryReader } from "../run-summary-reader.ts";
import type { StudioCore } from "../studio-core.ts";
import type { IpcHandle } from "./registrar.ts";

/** The longest side a cover image may have, in pixels. */
const COVER_MAX_PX = 512;
/** The reference stills the Builds tab's prompt card shows: how many, and their long side in pixels. */
const PROMPT_CARD_STILLS = 6;
const PROMPT_CARD_STILL_PX = 640;

/**
 * Why a game library request from the renderer is refused: the cover's words reach the person,
 * `projectRequired` only a malformed call from our own renderer.
 */
const MESSAGE = {
  unreadableCover: () => t("This image could not be read. Choose another image."),
  coverTooLarge: () => t("Cover images must be at most {pixels} pixels across.", { pixels: COVER_MAX_PX }),
  projectRequired: "Project is required",
} as const;

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
    if (trash) await shell.trashItem(dir).catch(() => {});
    pushUiEvent({ type: UiEvent.GameChanged, payload: { project: payload.project } });
    return true;
  });

  // A chosen folder is the renderer's word for a path: the core checks it by its real path before
  // anything is written, as it does in `studio:game.location.pick`.
  handle("studio:game.create", async (payload) =>
    core.createGame(payload.title, {
      ...(payload.parent === undefined ? {} : { parent: payload.parent }),
      ...(payload.provisional === true ? { provisional: true } : {}),
    }),
  );
  // The request is the user's own words, read by their own model; the name only names a folder later.
  handle("studio:game.name", async (payload) => core.nameGame(payload));
  handle("studio:backdrop.make", async (payload) => core.makeBackdrop(payload));
  handle("studio:game.update", async (payload) => {
    const cover = payload.patch?.cover;
    if (cover?.kind === "image") {
      validateGameCover(cover);
      const image = nativeImage.createFromDataURL(cover.dataUrl);
      if (image.isEmpty()) throw new Error(MESSAGE.unreadableCover());
      const size = image.getSize();
      if (size.width > COVER_MAX_PX || size.height > COVER_MAX_PX) throw new Error(MESSAGE.coverTooLarge());
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
