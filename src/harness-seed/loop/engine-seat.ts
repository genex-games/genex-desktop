/**
 * Which engines can lead a Loop in place, on a project that isn't a web game: the chat's own
 * session, resumed, that the host seats as an agent in the game folder. The one Loop's own rule,
 * read by the chat's launch and by the run's start alike; the host's copy of the kind it seats is
 * `EngineKind.Delegated` (held by seed-contracts).
 */

/** How the host lists an engine it runs as an agent in the folder (`engine.describe`, the app's `EngineKind.Delegated`). */
export const SEATED_ENGINE_KIND = "delegated";

/**
 * Whether an engine can lead a Loop in place: the chat's own session, resumed, that the host seats
 * as an agent in the folder (its jobs, its looks at the project's app, its workers). An engine Genex
 * drives itself (Ollama, Bonsai, OpenRouter) leads none, though it may keep a session; nor does an
 * agent that says it keeps none.
 */
export function leadsInPlace(descriptor: { kind?: string; supportsSessions?: boolean } | null | undefined): boolean {
  return descriptor?.kind === SEATED_ENGINE_KIND && descriptor.supportsSessions !== false;
}
