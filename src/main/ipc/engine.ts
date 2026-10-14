/**
 * The person's engine actions in Studio's window (extension ladder level 5): eject a Rust game's
 * engine into its folder (`studio:engine.eject`), give the store engine back
 * (`studio:engine.uneject`) and set its trust flag for `unsafe` and build scripts
 * (`studio:engine.setTrust`). All three are native (never in a fixture) and have no harness method:
 * an agent can only suggest them in chat. `studio:engine.state` reads what the person's engine rows
 * show (fixture-safe: it changes nothing).
 */
import type { EngineState } from "../../shared/game-conformance.ts";
import type { EngineEjectService } from "../rust-eject.ts";
import type { EngineTrustService } from "../rust-trust.ts";
import type { IpcHandle } from "./registrar.ts";

/** The longest project name an engine action names. */
const MAX_PROJECT_CHARS = 200;

const MESSAGE = {
  badProject: "Name the game whose engine this is.",
  badTrust: "Say whether the game is trusted: true or false.",
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The game a payload names; throws on anything else. */
function namedProject(payload: unknown): string {
  const project = isRecord(payload) ? payload.project : undefined;
  const named = typeof project === "string" && project.length > 0 && project.length <= MAX_PROJECT_CHARS;
  if (!named) throw new Error(MESSAGE.badProject);
  return project;
}

/** The flag a trust payload sets; throws unless it is a boolean. */
function trustedFlag(payload: unknown): boolean {
  const trusted = isRecord(payload) ? payload.trusted : undefined;
  if (typeof trusted !== "boolean") throw new Error(MESSAGE.badTrust);
  return trusted;
}

/** What the engine registrar reaches: the eject and trust services, and the read of a game's engine. */
export interface EngineIpcDeps {
  eject: () => EngineEjectService;
  trust: () => EngineTrustService;
  state: (project: string) => Promise<EngineState>;
}

/** Registers `studio:engine.eject`, `studio:engine.uneject`, `studio:engine.setTrust` and `studio:engine.state`. */
export function registerEngineIpc(handle: IpcHandle, deps: EngineIpcDeps): void {
  handle("studio:engine.eject", async (payload) => await deps.eject().eject(namedProject(payload)));
  handle("studio:engine.uneject", async (payload) => await deps.eject().uneject(namedProject(payload)));
  handle(
    "studio:engine.setTrust",
    async (payload) => await deps.trust().setTrust(namedProject(payload), trustedFlag(payload)),
  );
  handle("studio:engine.state", async (payload) => await deps.state(namedProject(payload)));
}
