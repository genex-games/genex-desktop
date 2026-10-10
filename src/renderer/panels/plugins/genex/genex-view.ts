/**
 * The Genex page's reading of the plugin's status: one account state, the credits Genex actually
 * reported, and each generation of the open game in plain words. Pure: the page draws these and
 * never works them out again.
 */
import { MINUTE_MS, SECOND_MS } from "../../../../shared/duration.ts";
import {
  GenexJobStatus,
  GenexOperation,
  type GenexJob,
  type GenexStatus,
  GenexUseStage,
} from "../../../../shared/genex.ts";
import { isReviewImage } from "../../../plugin-actions.ts";
import type { IconName } from "../../../ui/icons.tsx";
import { GENEX_WORDS } from "../../../words.ts";

/** How often the page re-reads Genex while something is under way, and otherwise. */
export const GENEX_ACTIVE_POLL_MS = 5 * SECOND_MS;
export const GENEX_IDLE_POLL_MS = MINUTE_MS;

/**
 * Job states that are still moving on Genex's side. Not `approved`: an approved review's run goes
 * on in a new job, and the review keeps that state for good. Not `generated`: Genex has finished,
 * and the files wait for a wait or a download that nothing starts by itself. Either one kept the
 * page reading every 5 s for as long as it was open, against the account's shared request budget.
 */
const MOVING_JOBS: ReadonlySet<string> = new Set([
  GenexJobStatus.Requested,
  GenexJobStatus.Submitting,
  GenexJobStatus.Accepted,
  GenexJobStatus.Generating,
]);

/** Whether a sign-in or a generation is under way, so the page should look again soon. */
const underWay = (status: GenexStatus | null): boolean =>
  Boolean(status?.authorization) || (status?.jobs ?? []).some((job) => MOVING_JOBS.has(job.status));

/** How long the page waits before reading Genex's status again. */
export const genexPollMs = (status: GenexStatus | null): number =>
  underWay(status) ? GENEX_ACTIVE_POLL_MS : GENEX_IDLE_POLL_MS;

/** Which of the account card's shapes the status calls for. */
export const GenexAccountKind = {
  Loading: "loading",
  SignedOut: "signed-out",
  SigningIn: "signing-in",
  Terms: "terms",
  Checking: "checking",
  Attention: "attention",
  Connected: "connected",
} as const;
export type GenexAccountKind = (typeof GenexAccountKind)[keyof typeof GenexAccountKind];

/** How far Genex reported the balance. */
export const CreditsKind = { Count: "count", Unlimited: "unlimited", Unknown: "unknown" } as const;
export type CreditsKind = (typeof CreditsKind)[keyof typeof CreditsKind];

export type CreditsView =
  | { kind: typeof CreditsKind.Count; count: number }
  | { kind: typeof CreditsKind.Unlimited }
  | { kind: typeof CreditsKind.Unknown };

/** The account card: one shape per step, with only what that step can show. */
export type GenexAccountView =
  | { kind: typeof GenexAccountKind.Loading }
  | { kind: typeof GenexAccountKind.SignedOut; retry: boolean }
  | { kind: typeof GenexAccountKind.SigningIn; code: string }
  | { kind: typeof GenexAccountKind.Terms }
  | { kind: typeof GenexAccountKind.Checking }
  | { kind: typeof GenexAccountKind.Attention; error: string }
  | {
      kind: typeof GenexAccountKind.Connected;
      identity: string | null;
      credits: CreditsView;
      /** Credits this game has used, when the CLI's budget reported a number. */
      spent: number | null;
      /** Asset kinds Genex cannot make right now. */
      paused: string[];
    };

/** Whether a plugin action's answer is a Genex status: a connected flag and a jobs list at least. */
export function isGenexStatus(value: unknown): value is GenexStatus {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { connected?: unknown; jobs?: unknown };
  return typeof candidate.connected === "boolean" && Array.isArray(candidate.jobs);
}

/** The balance a status reports: unlimited, a count, or unknown. */
export function creditsOf(status: GenexStatus): CreditsView {
  if (status.unlimited === true) return { kind: CreditsKind.Unlimited };
  const balance = status.balance;
  return typeof balance === "number" && Number.isFinite(balance)
    ? { kind: CreditsKind.Count, count: balance }
    : { kind: CreditsKind.Unknown };
}

/** The game's spend from the CLI's budget answer, only when it is a real number. */
export function spentOf(allowance: unknown): number | null {
  const spent = (allowance as { spent?: unknown } | null)?.spent;
  return typeof spent === "number" && Number.isFinite(spent) ? spent : null;
}

type Lane = { kind?: unknown; available?: unknown; mock?: unknown; credit?: unknown };

/** A lane Genex cannot serve: paused as a whole, switched off, a stand-in, or out of credit. */
const laneUnavailable = (paused: boolean, lane: Lane): boolean =>
  paused || lane.available === false || lane.mock === true || lane.credit === "exhausted";

function pausedOf(lanes: unknown): string[] {
  const reported = lanes as { paused?: unknown; lanes?: unknown } | null;
  if (!reported || !Array.isArray(reported.lanes)) return [];
  const paused = reported.paused === true;
  return (reported.lanes as Lane[])
    .filter((lane) => laneUnavailable(paused, lane) && typeof lane.kind === "string")
    .map((lane) => String(lane.kind));
}

/** The account card for a status, or Loading before the first one arrives. */
export function genexAccountView(status: GenexStatus | null): GenexAccountView {
  if (!status) return { kind: GenexAccountKind.Loading };
  if (status.authorization) return { kind: GenexAccountKind.SigningIn, code: status.authorization.userCode };
  // Locked is also how a never-connected profile starts, so it reads as signed out: Connect
  // unlocks a saved sign-in first and opens the browser only when there is none.
  if (!status.connected) return { kind: GenexAccountKind.SignedOut, retry: status.credentialState === "failed" };
  if (status.legal?.accepted === false) return { kind: GenexAccountKind.Terms };
  if (status.error) return { kind: GenexAccountKind.Attention, error: status.error };
  if (!status.accountVerified) return { kind: GenexAccountKind.Checking };
  return {
    kind: GenexAccountKind.Connected,
    identity: status.identity,
    credits: creditsOf(status),
    spent: spentOf(status.allowance),
    paused: pausedOf(status.lanes),
  };
}

/** What a generation is for the reader: still working, waiting on them, done, or not. */
export const JobState = {
  Working: "working",
  Review: "review",
  Ready: "ready",
  InGame: "in-game",
  Failed: "failed",
  Stopped: "stopped",
  Unsure: "unsure",
} as const;
export type JobState = (typeof JobState)[keyof typeof JobState];

const JOB_STATE: Partial<Record<string, JobState>> = {
  [GenexJobStatus.ApprovalRequired]: JobState.Review,
  [GenexJobStatus.Downloaded]: JobState.Ready,
  [GenexJobStatus.Failed]: JobState.Failed,
  [GenexJobStatus.RetrievalFailed]: JobState.Failed,
  [GenexJobStatus.Canceled]: JobState.Stopped,
  [GenexJobStatus.Stopped]: JobState.Stopped,
  [GenexJobStatus.Unresolved]: JobState.Unsure,
} satisfies Partial<Record<GenexJobStatus, JobState>>;

/** An asset family: its label on the page and the glyph it wears. */
const ModelFamily = { label: GENEX_WORDS.kind.model, icon: "box" } as const;
const CharacterFamily = { label: GENEX_WORDS.kind.character, icon: "character" } as const;
const AnimationFamily = { label: GENEX_WORDS.kind.animation, icon: "character" } as const;

const OPERATION: Partial<Record<string, { label: string; icon: IconName }>> = {
  [GenexOperation.Model]: ModelFamily,
  [GenexOperation.ModelImport]: ModelFamily,
  [GenexOperation.ModelSegment]: ModelFamily,
  [GenexOperation.ModelRig]: { label: GENEX_WORDS.kind.rig, icon: "character" },
  [GenexOperation.ModelAnimate]: AnimationFamily,
  [GenexOperation.Character]: CharacterFamily,
  [GenexOperation.CharacterPreview]: CharacterFamily,
  [GenexOperation.CharacterFinalize]: CharacterFamily,
  [GenexOperation.CharacterImport]: CharacterFamily,
  [GenexOperation.Creature]: { label: GENEX_WORDS.kind.creature, icon: "character" },
  [GenexOperation.CharacterAnimate]: AnimationFamily,
  [GenexOperation.CreatureAnimate]: AnimationFamily,
  [GenexOperation.CharacterMotions]: AnimationFamily,
  [GenexOperation.Image]: { label: GENEX_WORDS.kind.image, icon: "image" },
  [GenexOperation.Texture]: { label: GENEX_WORDS.kind.texture, icon: "image" },
  [GenexOperation.Video]: { label: GENEX_WORDS.kind.video, icon: "image" },
  [GenexOperation.Sfx]: { label: GENEX_WORDS.kind.sfx, icon: "sound" },
  [GenexOperation.Music]: { label: GENEX_WORDS.kind.music, icon: "sound" },
  [GenexOperation.Voice]: { label: GENEX_WORDS.kind.voice, icon: "sound" },
};
const UNKNOWN_OPERATION = { label: GENEX_WORDS.kind.asset, icon: "box" } as const;

/** One generation, as the page lists it. */
export interface GenexJobRow {
  id: string;
  label: string;
  icon: IconName;
  /** The delivered file's name, when there is one. */
  file: string | null;
  state: JobState;
  /** What it cost after refunds, or null when Genex reported no charge. */
  credits: string | null;
  error: string | null;
  /** What a review waits on: numbered candidates, one `null` for a remesh, or nothing. */
  candidates: Array<number | null>;
  /** Each candidate's picture by its number, when its review could show it; a remesh has none. */
  pictures: Partial<Record<number, string>>;
}

function stateOf(job: GenexJob): JobState {
  const state = JOB_STATE[job.status] ?? JobState.Working;
  const inGame = job.use?.stage === GenexUseStage.Integrated || job.use?.stage === GenexUseStage.Verified;
  return state === JobState.Ready && inGame ? JobState.InGame : state;
}

function creditWords(job: GenexJob): string | null {
  const charged = job.creditsCharged ?? 0;
  if (charged <= 0) return null;
  const net = charged - (job.creditsRefunded ?? 0);
  return net <= 0 ? GENEX_WORDS.refunded : GENEX_WORDS.credits(net);
}

/** The character candidates a preview offers, one remesh for a finalize. */
const PREVIEW_CANDIDATES = [1, 2, 3];

function candidatesOf(job: GenexJob, state: JobState): Array<number | null> {
  if (state !== JobState.Review) return [];
  return job.operation === GenexOperation.CharacterPreview ? PREVIEW_CANDIDATES : [null];
}

/** The candidates' pictures, so the person chooses by looking before any review opens. */
function picturesOf(job: GenexJob, candidates: Array<number | null>): Partial<Record<number, string>> {
  const pictures: Partial<Record<number, string>> = {};
  for (const candidate of candidates) {
    if (candidate === null) continue;
    const image = job.approval?.images?.find((each) => each.label === String(candidate));
    if (isReviewImage(image?.dataUrl)) pictures[candidate] = image.dataUrl;
  }
  return pictures;
}

const fileName = (file: string | undefined): string | null => (file ? (file.split("/").pop() ?? file) : null);

/** The game's generations, newest first. */
export function genexJobRows(jobs: readonly GenexJob[]): GenexJobRow[] {
  return [...jobs].reverse().map((job) => {
    const family = OPERATION[job.operation] ?? UNKNOWN_OPERATION;
    const state = stateOf(job);
    const candidates = candidatesOf(job, state);
    return {
      id: job.id,
      label: family.label,
      icon: family.icon,
      file: fileName(job.preferredFile ?? job.files[0]),
      state,
      credits: creditWords(job),
      error: job.error ?? null,
      candidates,
      pictures: picturesOf(job, candidates),
    };
  });
}
