/**
 * The Player report inbox's channels (owner decision D9): the reports of the creator's own
 * published game, and Fix with agent, which saves one report's replay as a playtest of that game.
 * A library game's name and a report's id are read here before the host hears them; the host
 * resolves the game through the library by realpath.
 */
import { readAiReportId } from "../../shared/game-ai-report.ts";
import type { GameAiInboxHost } from "../game-ai/types.ts";
import type { IpcHandle } from "./registrar.ts";

const MESSAGE = {
  badProject: "not a game in the library",
  badReport: "not a report of this game",
} as const;

/** The longest library name a channel takes. */
const PROJECT_MAX_CHARS = 255;
/** A library name: one folder name, never a path, a dot segment or a control character. */
const PROJECT_RE = /^[^\p{Cc}/\\]+$/u;

/** A library game's name from the renderer, or a refusal. */
function projectOf(raw: unknown): string {
  const named =
    typeof raw === "string" &&
    raw.length <= PROJECT_MAX_CHARS &&
    PROJECT_RE.test(raw) &&
    raw !== "." &&
    raw !== ".." &&
    raw.trim() === raw;
  if (!named) throw new Error(MESSAGE.badProject);
  return raw;
}

/** Register the inbox's channels over its host. */
export function registerGameAiInboxIpc(handle: IpcHandle, host: GameAiInboxHost): void {
  handle("studio:ai-reports.inbox", async (payload) => host.inbox(projectOf(payload?.project)));
  handle("studio:ai-reports.fix", async (payload) => {
    const project = projectOf(payload?.project);
    const id = readAiReportId(payload?.id);
    if (!id) throw new Error(MESSAGE.badReport);
    return host.inboxFix(project, id);
  });
}
