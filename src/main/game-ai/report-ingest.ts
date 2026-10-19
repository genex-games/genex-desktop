/**
 * Reports and fit-from-play counts on their way to genex.games: the two ingest routes the contracts
 * name (`AI_REPORT_ROUTE`, `AI_FIT_COUNTS_ROUTE`), the bodies they take, and no account on either:
 * a Report needs no sign-in and says nothing of who sent it, and counts are counts.
 *
 * genex.games keeps only published games' bundles and counts, so a `create:` game's never leaves
 * this Mac, and a bundle over the body cap is refused here rather than sent to be refused. Every
 * answer, and every way the network fails, is read as hostile: a send ends refused, too large or
 * offline, never as a throw at the player. Electron-free: the caller hands it the request.
 */
import {
  AI_FIT_COUNTS_ROUTE,
  AI_FIT_MAX_ROWS,
  type AiFitCountRow,
  readAiFitCountRow,
} from "../../shared/game-ai-check.ts";
import { AiGameKind, type AiGameKey } from "../../shared/game-ai.ts";
import {
  AI_REPORT_MAX_BODY_CHARS,
  AI_REPORT_ROUTE,
  type AiReportBundle,
  AiReportFailure,
  type AiReportOutcome,
} from "../../shared/game-ai-report.ts";
import type { GalleryRequest } from "../play/gallery.ts";
import type { GenexAiPlatform } from "./types.ts";

/** The status genex.games answers a body over its cap with. */
const HTTP_TOO_LARGE = 413;
/** The status of a limit: the send may go again later. */
const HTTP_TOO_MANY = 429;
/** From here on a failure is genex.games' own, not the bundle's. */
const HTTP_SERVER_ERROR = 500;
/** An id genex.games stored a bundle under. */
const STORED_ID_RE = /^[A-Za-z0-9_-]{8,100}$/;

const MESSAGE = {
  CountsRefused: (status: number) => `genex.games refused the fit counts (HTTP ${status})`,
} as const;

/** What the ingest needs: a way to call genex.games' API. */
export interface GenexAiIngestDeps {
  request: GalleryRequest;
}

/** Whether a key names a game genex.games publishes. */
const isPublished = (game: AiGameKey): boolean => game.startsWith(`${AiGameKind.Play}:`);

const isSuccess = (status: number): boolean => status >= 200 && status < 300;

/** A failed send's answer, by its status: the bundle's fault, its size, or genex.games'. */
function failureOf(status: number): AiReportFailure {
  if (status === HTTP_TOO_LARGE) return AiReportFailure.TooLarge;
  if (status === HTTP_TOO_MANY || status >= HTTP_SERVER_ERROR) return AiReportFailure.Offline;
  return AiReportFailure.Refused;
}

/** The id genex.games stored a bundle under, or the bundle's own when its answer names none it can read. */
function storedId(body: unknown, bundle: AiReportBundle): string {
  const id = typeof body === "object" && body !== null && "id" in body ? body.id : null;
  return typeof id === "string" && STORED_ID_RE.test(id) ? id : bundle.id;
}

/** The size a bundle is sent at, in JSON characters; null when it cannot be serialized. */
function bodyChars(bundle: AiReportBundle): number | null {
  try {
    return JSON.stringify(bundle).length;
  } catch {
    return null;
  }
}

/** Rows genex.games takes: well-formed rows of published games. */
const sendable = (rows: readonly AiFitCountRow[]): AiFitCountRow[] =>
  rows.filter((row) => readAiFitCountRow(row) !== null && isPublished(row.game));

/** The two sends `GenexAiPlatform` makes to genex.games' ingest. */
export function genexAiIngest(deps: GenexAiIngestDeps): Pick<GenexAiPlatform, "sendReport" | "sendFitCounts"> {
  const { request } = deps;

  const sendReport = async (bundle: AiReportBundle): Promise<AiReportOutcome> => {
    if (!isPublished(bundle.game.key)) return { ok: false, failure: AiReportFailure.Refused };
    const chars = bodyChars(bundle);
    if (chars === null || chars > AI_REPORT_MAX_BODY_CHARS) return { ok: false, failure: AiReportFailure.TooLarge };
    const answer = await request(AI_REPORT_ROUTE, { method: "POST", body: bundle }).catch(() => null);
    if (!answer) return { ok: false, failure: AiReportFailure.Offline };
    if (!isSuccess(answer.status)) return { ok: false, failure: failureOf(answer.status) };
    return { ok: true, id: storedId(answer.body, bundle) };
  };

  /** Throws on any failure, so the caller keeps the rows for its next send. */
  const sendFitCounts = async (rows: readonly AiFitCountRow[]): Promise<void> => {
    const kept = sendable(rows);
    for (let start = 0; start < kept.length; start += AI_FIT_MAX_ROWS) {
      const body = { rows: kept.slice(start, start + AI_FIT_MAX_ROWS) };
      const answer = await request(AI_FIT_COUNTS_ROUTE, { method: "POST", body });
      if (!isSuccess(answer.status)) throw new Error(MESSAGE.CountsRefused(answer.status));
    }
  };

  return { sendReport, sendFitCounts };
}
