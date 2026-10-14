/**
 * Crate requests in Studio's window (extension ladder level 4): the list of what agents asked for
 * (`studio:crates.list`, fixture-safe: a read of the profile's own records and the games'
 * `[[crate_request]]` rows) and the person's decision on one (`studio:crates.decide`, native: it
 * lets new code into the profile's vendored overlay). Agents only request (`crates.request`); the
 * person alone decides, here.
 */
import type { CrateRequestService } from "../crate-requests.ts";
import type { IpcHandle } from "./registrar.ts";

/** The longest project name a list names. */
const MAX_PROJECT_CHARS = 200;

const MESSAGE = {
  badProject: "Name one game, or none for every game's crate requests.",
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The game a list names, or undefined for every game; throws on anything else. */
function listedProject(payload: unknown): string | undefined {
  const project = isRecord(payload) ? payload.project : undefined;
  if (project === undefined) return undefined;
  const named = typeof project === "string" && project.length > 0 && project.length <= MAX_PROJECT_CHARS;
  if (!named) throw new Error(MESSAGE.badProject);
  return project;
}

/** Registers `studio:crates.list` and `studio:crates.decide` over the profile's crate request service. */
export function registerCratesIpc(handle: IpcHandle, crates: () => CrateRequestService): void {
  handle("studio:crates.list", async (payload) => await crates().list(listedProject(payload)));
  // The decision's shape is checked by the service before anything is read.
  handle("studio:crates.decide", async (decision) => await crates().decide(decision));
}
