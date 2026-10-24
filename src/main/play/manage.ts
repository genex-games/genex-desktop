/**
 * Managing a published game from its Play card against the genex.games API: the owner's remixing,
 * cover, Unpublish and Delete, and the mobile flag and tags an admin sets. genex.games decides who
 * may (its admin list never leaves it); a refusal throws with its status. Every id, change and
 * picture is checked here before anything is sent. Electron-free, like the gallery: the request, the
 * token and the cover upload come in as deps.
 */
import {
  isPlayCoverType,
  isPlayGameChange,
  isPlayGameId,
  PLAY_COVER_MAX_BYTES,
  type PlayChangeResult,
  PlayChangeKind,
  PlayChangeOutcome,
  PlayCoverRefusal,
  type PlayCoverResult,
  PlayCoverType,
  type PlayGameChange,
} from "../../shared/play-manage.ts";
import { GalleryError, type GalleryRequest, imageUrl, isRecord, SignInNeeded } from "./gallery.ts";

/** HTTP statuses a change reads apart. */
const HTTP_UNAUTHORIZED = 401;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;

/** The routes managing a game uses; `mobile` answers only an account genex.games names an admin. */
export const ManageRoute = {
  mobile: (id: string) => `/api/admin/projects/${encodeURIComponent(id)}/mobile`,
  categories: (id: string) => `/api/projects/${encodeURIComponent(id)}/categories`,
  visibility: (id: string) => `/api/projects/${encodeURIComponent(id)}/visibility`,
  unpublish: (id: string) => `/api/projects/${encodeURIComponent(id)}/unpublish`,
  project: (id: string) => `/api/projects/${encodeURIComponent(id)}`,
  coverUpload: (id: string) => `/api/projects/${encodeURIComponent(id)}/cover/upload-url`,
  coverCommit: (id: string) => `/api/projects/${encodeURIComponent(id)}/cover/commit`,
} as const;

/** The errors genex.games names in a refusal's body. Wire values: never rename one. */
export const ManageError = {
  /** Remixing cannot be turned on here: the game's source is its owner's own repository. */
  ExternalRepo: "external_repo",
  /** The cover was refused; its `reason` says why. */
  CoverRejected: "cover_rejected",
} as const;
export type ManageError = (typeof ManageError)[keyof typeof ManageError];

const MESSAGE = {
  BadGame: "Not a published game",
  BadChange: "Not a change the card menu makes",
  BadCover: "A cover is a WebP, PNG or JPEG picture of at most 8 MB",
  BadUpload: "Genex did not hand back a place to upload the cover",
  UploadFailed: (status: number) => `The cover did not upload (HTTP ${status})`,
} as const;

/** What a picture of each cover type starts with, byte by byte from `at`. */
const COVER_SIGNATURES: Record<PlayCoverType, ReadonlyArray<{ at: number; bytes: readonly number[] }>> = {
  [PlayCoverType.Webp]: [
    { at: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
    { at: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  ],
  [PlayCoverType.Png]: [{ at: 0, bytes: [0x89, 0x50, 0x4e, 0x47] }],
  [PlayCoverType.Jpeg]: [{ at: 0, bytes: [0xff, 0xd8, 0xff] }],
};
/** The shortest picture worth a look: a WebP's header. */
const COVER_MIN_BYTES = 12;

/** Whether `bytes` are a picture of `type` genex.games takes as a cover: its signature, and not too big. */
export function isCoverPicture(bytes: unknown, type: unknown): boolean {
  if (!(bytes instanceof Uint8Array) || !isPlayCoverType(type)) return false;
  if (bytes.length < COVER_MIN_BYTES || bytes.length > PLAY_COVER_MAX_BYTES) return false;
  return COVER_SIGNATURES[type].every(({ at, bytes: expected }) =>
    expected.every((byte, offset) => bytes[at + offset] === byte),
  );
}

/** What managing a game needs: a way to call the API, the account token, the cover upload and a way to say something changed. */
export interface PlayManageDeps {
  request: GalleryRequest;
  /** The unlocked Genex account's token, or undefined while there is none. */
  token(): Promise<string | undefined>;
  /** PUT `bytes` to a presigned `url` with `contentType`; the answer's HTTP status. */
  upload(url: string, bytes: Uint8Array, contentType: string): Promise<number>;
  /** A write went through: what the gallery kept is stale. */
  changed(): void;
  /** A fixture launch: its drawn covers are let through. */
  localImages?: boolean;
}

const isSuccess = (status: number): boolean => status >= 200 && status < 300;
const errorOf = (body: unknown): unknown => (isRecord(body) ? body.error : null);

/** A write's answer: SignInNeeded for a refused token, GalleryError for any other non-2xx. */
function checked(route: string, answer: { status: number; body: unknown }): unknown {
  if (answer.status === HTTP_UNAUTHORIZED) throw new SignInNeeded();
  if (!isSuccess(answer.status)) throw new GalleryError(route, answer.status);
  return answer.body;
}

/** The call a change makes: its method, route and the body genex.games' website sends. */
function changeCall(
  id: string,
  change: PlayGameChange,
): { method: "PATCH" | "POST" | "DELETE"; route: string; body?: unknown } {
  switch (change.kind) {
    case PlayChangeKind.Mobile:
      return { method: "PATCH", route: ManageRoute.mobile(id), body: { mobileSupport: change.mobileSupport } };
    case PlayChangeKind.Tags:
      return { method: "PATCH", route: ManageRoute.categories(id), body: { categories: [...change.categories] } };
    case PlayChangeKind.Remixing:
      return { method: "PATCH", route: ManageRoute.visibility(id), body: { private: !change.allowed } };
    case PlayChangeKind.Unpublish:
      return { method: "POST", route: ManageRoute.unpublish(id) };
    case PlayChangeKind.Delete:
      return { method: "DELETE", route: ManageRoute.project(id) };
  }
}

/** What a change that went through answers: Tags what was stored. */
function changeResult(change: PlayGameChange, body: unknown): PlayChangeResult {
  if (change.kind !== PlayChangeKind.Tags) return { outcome: PlayChangeOutcome.Done };
  const project = isRecord(body) && isRecord(body.project) ? body.project : {};
  const stored = Array.isArray(project.categories) ? project.categories : change.categories;
  return { outcome: PlayChangeOutcome.Done, categories: stored.filter((tag) => typeof tag === "string") };
}

/** The refusal a reason genex.games gives names, or undefined for one it does not. */
const knownRefusal = (reason: unknown): PlayCoverRefusal | undefined =>
  Object.values(PlayCoverRefusal).find((refusal) => refusal === reason);

/** The commit's answer: shown at once, kept back and why, or a refusal of another kind thrown. */
function coverResult(route: string, answer: { status: number; body: unknown }, local: boolean): PlayCoverResult {
  const body = isRecord(answer.body) ? answer.body : {};
  if (answer.status === HTTP_UNPROCESSABLE && body.error === ManageError.CoverRejected)
    return { applied: false, coverUrl: null, refusal: knownRefusal(body.reason) ?? PlayCoverRefusal.Invalid };
  checked(route, answer);
  const applied = body.applied === true;
  const kept = applied ? null : PlayCoverRefusal.Invalid;
  return { applied, coverUrl: imageUrl(body.coverUrl, local), refusal: knownRefusal(body.reason) ?? kept };
}

/** The place genex.games handed back for the cover: an https address and its key, else it throws. */
function uploadSlot(body: unknown): { url: string; key: string } {
  const url = isRecord(body) ? body.uploadUrl : null;
  const key = isRecord(body) ? body.key : null;
  if (typeof url !== "string" || typeof key !== "string" || !key) throw new Error(MESSAGE.BadUpload);
  try {
    if (new URL(url).protocol === "https:") return { url, key };
  } catch {
    // An address that does not parse is no place to put the picture.
  }
  throw new Error(MESSAGE.BadUpload);
}

/** Managing published games over `deps`. */
export function createPlayManage(deps: PlayManageDeps) {
  const { request, upload, changed } = deps;
  const local = deps.localImages === true;

  /** The token, or SignInNeeded. */
  const auth = async (): Promise<string> => {
    const value = await deps.token();
    if (!value) throw new SignInNeeded();
    return value;
  };

  /** Change a published game as the card menu asks; nothing is sent for an id or a change of the wrong shape. */
  const change = async (gameId: string, asked: PlayGameChange): Promise<PlayChangeResult> => {
    if (!isPlayGameId(gameId)) throw new Error(MESSAGE.BadGame);
    if (!isPlayGameChange(asked)) throw new Error(MESSAGE.BadChange);
    const { method, route, body } = changeCall(gameId, asked);
    const answer = await request(route, { method, token: await auth(), ...(body === undefined ? {} : { body }) });
    const ownRepo = answer.status === HTTP_CONFLICT && errorOf(answer.body) === ManageError.ExternalRepo;
    if (asked.kind === PlayChangeKind.Remixing && ownRepo) return { outcome: PlayChangeOutcome.OwnRepo };
    const result = changeResult(asked, checked(route, answer));
    changed();
    return result;
  };

  /**
   * Make a picture a game's cover: ask where to put it, put it there, commit it. Nothing is sent for
   * a picture that is not what its type says; genex.games may keep the old cover, and says why.
   */
  const cover = async (gameId: string, image: Uint8Array, contentType: PlayCoverType): Promise<PlayCoverResult> => {
    if (!isPlayGameId(gameId)) throw new Error(MESSAGE.BadGame);
    if (!isCoverPicture(image, contentType)) throw new Error(MESSAGE.BadCover);
    const key = await auth();
    const slotRoute = ManageRoute.coverUpload(gameId);
    const body = { bytes: image.length, contentType };
    const slot = uploadSlot(checked(slotRoute, await request(slotRoute, { method: "POST", token: key, body })));
    const status = await upload(slot.url, image, contentType);
    if (!isSuccess(status)) throw new Error(MESSAGE.UploadFailed(status));
    const commitRoute = ManageRoute.coverCommit(gameId);
    const committed = await request(commitRoute, { method: "POST", token: key, body: { key: slot.key } });
    const result = coverResult(commitRoute, committed, local);
    if (result.applied) changed();
    return result;
  };

  return { change, cover };
}

/** Managing published games, as `createPlayManage` makes it. */
export type PlayManage = ReturnType<typeof createPlayManage>;
