/**
 * Which door one host call goes to, or why none: one pure, tested table. Main runs it for every
 * call after reading the request and before reserving anything, so a refusal has no side effect.
 *
 * The rules, in order: AI off answers off; a replay answers from its saved playtest; a game with
 * no grant starts silently only on a free model that is ready, in a game whose scores are not on a
 * leaderboard — every other first use waits for the person's yes; a grant's door must be legal in
 * the call's context and answered by main (genex.games answers the platform doors); a leaderboard
 * session or a shared answer needs a verified door; the Claude plan needs its unlock; and the door
 * must be ready, take JSON when the call needs it and hold the prompt.
 *
 * Browser-safe; nothing here reads a clock, a file or the network.
 */
import {
  AiAuthority,
  AiConsent,
  AiDoor,
  AiErrorCode,
  AiGrantStatus,
  AiProvenance,
  isPlatformDoor,
  PROVENANCE_OF,
} from "./game-ai.ts";

/** Where a call comes from, derived by main from the bridge it arrived on. Wire values: never rename one. */
export const AiContext = {
  /** A harness run, judge, check or offscreen preview: never the network. */
  HarnessRun: "harness-run",
  /** The creator plays their own game in the Live preview (the human partition only). */
  CreateLive: "create-live",
  /** A person plays a published game in Play. */
  DesktopPlay: "desktop-play",
  /** A native player or editor Studio started and no person is attached to. */
  Native: "native",
} as const;
export type AiContext = (typeof AiContext)[keyof typeof AiContext];

/** The host doors each context may use; a door outside its row answers `no_funding`. */
export const LEGAL_DOORS = {
  [AiContext.HarnessRun]: [AiDoor.Tape, AiDoor.Fixture, AiDoor.Local],
  [AiContext.CreateLive]: [
    AiDoor.Tape,
    AiDoor.Fixture,
    AiDoor.Local,
    AiDoor.OpenCode,
    AiDoor.Byok,
    AiDoor.Plan,
    AiDoor.GenexDev,
  ],
  [AiContext.DesktopPlay]: [AiDoor.Local, AiDoor.OpenCode, AiDoor.Byok],
  [AiContext.Native]: [AiDoor.Tape, AiDoor.Fixture, AiDoor.Local],
} as const satisfies Record<AiContext, readonly AiDoor[]>;

/** Whether `door` may be used in `context`. */
export function isLegalDoor(context: AiContext, door: AiDoor): boolean {
  const legal: readonly AiDoor[] = LEGAL_DOORS[context];
  return legal.includes(door);
}

/** One door as main sees it right now. */
export interface DoorReadiness {
  door: AiDoor;
  ready: boolean;
  /** It can be held to a JSON schema (structured output). */
  json: boolean;
  /** A local model is loading; it will be ready soon. */
  loading: boolean;
  /** The longest prompt it takes, in tokens. */
  maxInputTokens: number;
}

/** The model Genex would use for a game that holds no grant yet. */
export interface AiChoice {
  door: AiDoor;
  /** The catalog marks the model free (a model on this Mac, a free OpenCode model). */
  free: boolean;
}

/** A game's grant as routing needs it. */
export interface RouteGrant {
  door: AiDoor;
  status: AiGrantStatus;
}

/** Everything one routing decision reads, gathered by main. */
export interface RouteInput {
  context: AiContext;
  replaying: boolean;
  /** AI is off: everywhere, for this game, or for this preview while a harness drives it. */
  aiOff: boolean;
  /** This game's live grant, or null before its first use. */
  grant: RouteGrant | null;
  /** What Genex would pick for a game with no grant (last used, the maker's pick, the person's best). */
  choice: AiChoice | null;
  authority: AiAuthority;
  /** This session's scores count on a leaderboard (a leaderboard game not played unranked). */
  leaderboard: boolean;
  needsJson: boolean;
  promptTokens: number;
  /** D2: the plan's legal sign-off is in, and this is the creator's own game in Create Live. */
  planUnlocked: boolean;
  doors: readonly DoorReadiness[];
}

/** A routing decision: the one door, its provenance and, for a silent first use, how it was agreed. */
export type RouteDecision =
  | { ok: true; door: AiDoor; provenance: AiProvenance; start: typeof AiConsent.Silent | null }
  | { ok: false; code: AiErrorCode };

/** The doors a game may start on with no tap: a free model on this Mac or a free OpenCode model. */
const SILENT_DOORS: readonly AiDoor[] = [AiDoor.Local, AiDoor.OpenCode];

/** What a grant's status answers before its door is looked at; null when it may be used. */
const STATUS_REFUSAL = {
  [AiGrantStatus.Active]: null,
  [AiGrantStatus.WaitingForPlan]: AiErrorCode.WaitingForPlan,
  [AiGrantStatus.Paused]: AiErrorCode.Paused,
  [AiGrantStatus.Off]: AiErrorCode.Off,
  [AiGrantStatus.Replaced]: AiErrorCode.ConsentRequired,
} as const satisfies Record<AiGrantStatus, AiErrorCode | null>;

const readinessOf = (input: RouteInput, door: AiDoor): DoorReadiness | undefined =>
  input.doors.find((row) => row.door === door);

/** Why a door cannot take this call now, or null when it can. */
function readinessProblem(input: RouteInput, door: AiDoor): AiErrorCode | null {
  const row = readinessOf(input, door);
  if (!row) return AiErrorCode.DoorUnavailable;
  if (row.loading) return AiErrorCode.LocalLoading;
  if (!row.ready || (input.needsJson && !row.json)) return AiErrorCode.DoorUnavailable;
  return input.promptTokens > row.maxInputTokens ? AiErrorCode.TooLarge : null;
}

/** A door needs verification: a leaderboard session or a shared answer on an unverified door. */
function needsVerified(input: RouteInput, door: AiDoor): boolean {
  const unverified = PROVENANCE_OF[door] !== AiProvenance.Verified;
  return unverified && (input.leaderboard || input.authority === AiAuthority.Shared);
}

/**
 * Whether a game with no grant may start on `choice` with no tap: a free model on a silent door,
 * legal and ready here, for an answer that stays with this player, in a session no leaderboard
 * counts, with AI on.
 */
export function silentStartAllowed(input: RouteInput): boolean {
  const choice = input.choice;
  if (!choice || input.aiOff || input.leaderboard || input.replaying || input.grant !== null) return false;
  if (!choice.free || !SILENT_DOORS.includes(choice.door) || !isLegalDoor(input.context, choice.door)) return false;
  return !needsVerified(input, choice.door) && readinessProblem(input, choice.door) === null;
}

/** Why the door a grant names cannot take this call, or null when it can. */
function doorProblem(input: RouteInput, door: AiDoor): AiErrorCode | null {
  if (isPlatformDoor(door)) return AiErrorCode.PlatformDoor;
  if (!isLegalDoor(input.context, door)) return AiErrorCode.NoFunding;
  if (needsVerified(input, door)) return AiErrorCode.NeedsVerified;
  if (door === AiDoor.Plan && !input.planUnlocked) return AiErrorCode.PlanNotAllowed;
  return readinessProblem(input, door);
}

/** The one door a call goes to, or why none. Never picks a payer the person did not agree to. */
export function routeCall(input: RouteInput): RouteDecision {
  if (input.aiOff) return { ok: false, code: AiErrorCode.Off };
  if (input.replaying) return { ok: true, door: AiDoor.Tape, provenance: AiProvenance.Replay, start: null };
  if (input.grant === null) {
    if (!input.choice || !silentStartAllowed(input)) return { ok: false, code: AiErrorCode.ConsentRequired };
    const door = input.choice.door;
    return { ok: true, door, provenance: PROVENANCE_OF[door], start: AiConsent.Silent };
  }
  const refused = STATUS_REFUSAL[input.grant.status];
  if (refused) return { ok: false, code: refused };
  const door = input.grant.door;
  const problem = doorProblem(input, door);
  return problem ? { ok: false, code: problem } : { ok: true, door, provenance: PROVENANCE_OF[door], start: null };
}
