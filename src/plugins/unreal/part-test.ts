/**
 * A part's play test (`unreal/parts/<Part>/test.json`): what the editor queue does after applying
 * the part, in order — hold an input action or key as the player would, wait, take a play shot,
 * check what the game shows. Builders write it, so it is read as data and checked whole before the
 * queue runs anything: a test with any problem is refused with every problem named.
 */

/**
 * The step kinds a test may hold. `settle` and `drive` are the live builder's play-check steps:
 * the player's pawn comes to rest, then drives the game's `GenexRoute` while frames are taken.
 * Every step's seconds are the play world's game seconds.
 */
export const PartStepKind = {
  Hold: "hold",
  Wait: "wait",
  Shot: "shot",
  Expect: "expect",
  Settle: "settle",
  Drive: "drive",
} as const;
export type PartStepKind = (typeof PartStepKind)[keyof typeof PartStepKind];

/** How much a test may ask of the one editor; a drive's frames count toward `shots`. */
export const PART_TEST_LIMITS = {
  steps: 40,
  shots: 6,
  seconds: 60,
  holdSeconds: 15,
  warmupSeconds: 15,
  settleSeconds: 8,
  driveSeconds: 30,
  driveFrames: 6,
} as const;
/** The warm-up a test gets when it names none: the play world settles before the first step. */
const DEFAULT_WARMUP_SECONDS = 2;
/** The shot a part without its own test gets. */
const DEFAULT_SHOT = "still";
/** A shot's name: it becomes a file name, so never a path. */
const SHOT_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** What a drive's frames are named: `drive-1`, `drive-2`, … numbered on across a test's drives. */
const FRAME_PREFIX = "drive-";
/** Every actor the live builder adds carries `genex:<featureId>`; a tag check names one whole tag. */
export const GENEX_TAG_PREFIX = "genex:";
const GENEX_TAG = /^genex:[A-Za-z0-9_-]{1,64}$/;

/** A drive's frame by its number in the test (from 1). */
export const frameName = (number: number) => `${FRAME_PREFIX}${number}`;

/**
 * A check on the actors carrying `tag`, a whole `genex:` actor tag such as `genex:terrain`: whether
 * any is in the play world (`game_state` lists every actor with a `genex:` tag). The live builder's
 * feature checks read it.
 */
export type TagCheck = { tag: string; exists: boolean };

/**
 * What a check reads: one of the part's actors (by its label), the actors carrying a `genex:` tag,
 * or a field of the player's state.
 */
export type PartCheck =
  | { actor: string; exists: boolean }
  | TagCheck
  | { player: string; atLeast?: number; atMost?: number };

/**
 * Waits until the player's pawn is at rest (under 20 cm/s with its height steady for one game
 * second), at most `seconds` (up to `settleSeconds`); a pawn still moving then is "unsettled".
 */
export type SettleStep = { kind: typeof PartStepKind.Settle; seconds: number };

/**
 * Drives the player's pawn along the game's `GenexRoute` spline for `seconds` (up to
 * `driveSeconds`), taking `frames` evenly spaced play shots (up to `driveFrames`); without a route
 * it holds the throttle only.
 */
export type DriveStep = { kind: typeof PartStepKind.Drive; seconds: number; frames: number };

export type PartStep =
  | { kind: typeof PartStepKind.Hold; name: string; x: number; y: number; seconds: number }
  | { kind: typeof PartStepKind.Wait; seconds: number }
  | { kind: typeof PartStepKind.Shot; name: string }
  | { kind: typeof PartStepKind.Expect; check: PartCheck }
  | SettleStep
  | DriveStep;

/** A test the queue can run: its warm-up, its steps and the shots they take (a drive's frames among them). */
export type PartTest = { warmupSeconds: number; steps: PartStep[]; shots: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const inRange = (value: number, low: number, high: number) => value >= low && value <= high;

type Read = { step?: PartStep; problem?: string };

function readHold(raw: Record<string, unknown>, at: string): Read {
  const { hold, x = 1, y = 0, seconds = 1 } = raw;
  if (typeof hold !== "string" || !hold.trim()) return { problem: `${at}: hold names no input action or key` };
  if (!isNumber(x) || !inRange(x, -1, 1)) return { problem: `${at}: x must be from -1 to 1` };
  if (!isNumber(y) || !inRange(y, -1, 1)) return { problem: `${at}: y must be from -1 to 1` };
  if (!isNumber(seconds) || !inRange(seconds, 0, PART_TEST_LIMITS.holdSeconds))
    return { problem: `${at}: seconds must be from 0 to ${PART_TEST_LIMITS.holdSeconds}` };
  return { step: { kind: PartStepKind.Hold, name: hold.trim(), x, y, seconds } };
}

/** Whether `raw` holds exactly the keys of `wanted`. */
const hasKeys = (raw: Record<string, unknown>, wanted: string[]) =>
  Object.keys(raw).sort().join(",") === [...wanted].sort().join(",");

/** A player check's bounds: at least one, each a number, and nothing else beside `player`. */
function readPlayerCheck(raw: Record<string, unknown>): PartCheck | undefined {
  const bounds = ["atLeast", "atMost"].filter((k) => k in raw);
  if (typeof raw.player !== "string" || bounds.length === 0 || !hasKeys(raw, ["player", ...bounds])) return undefined;
  if (bounds.some((k) => !isNumber(raw[k]))) return undefined;
  return {
    player: raw.player,
    ...(isNumber(raw.atLeast) ? { atLeast: raw.atLeast } : {}),
    ...(isNumber(raw.atMost) ? { atMost: raw.atMost } : {}),
  };
}

/**
 * A check as a test (or the live builder's play-check) writes it: `{actor, exists}`, `{tag,
 * exists}` with a whole `genex:` tag, or `{player, atLeast and/or atMost}`; exactly those keys.
 */
export function readPartCheck(raw: unknown): PartCheck | undefined {
  if (!isRecord(raw)) return undefined;
  const exists = typeof raw.exists === "boolean" ? raw.exists : undefined;
  if (typeof raw.actor === "string" && exists !== undefined && hasKeys(raw, ["actor", "exists"]))
    return { actor: raw.actor, exists };
  if (typeof raw.tag === "string" && exists !== undefined && hasKeys(raw, ["tag", "exists"]))
    return GENEX_TAG.test(raw.tag) ? { tag: raw.tag, exists } : undefined;
  return readPlayerCheck(raw);
}

/** One step kind as a test writes it: its key, and how a step holding that key reads. */
type StepReader = (raw: Record<string, unknown>, at: string) => Read;

const readWait: StepReader = (raw, at) => {
  const seconds = raw.wait;
  if (!isNumber(seconds) || seconds < 0) return { problem: `${at}: wait must be a number of seconds, 0 or more` };
  return { step: { kind: PartStepKind.Wait, seconds } };
};

const readShot: StepReader = (raw, at) => {
  const name = raw.shot;
  if (typeof name !== "string" || !SHOT_NAME.test(name))
    return { problem: `${at}: a shot's name is letters, digits, - and _ (at most 64)` };
  return { step: { kind: PartStepKind.Shot, name } };
};

const readExpect: StepReader = (raw, at) => {
  const check = readPartCheck(raw.expect);
  if (!check)
    return { problem: `${at}: expect is {actor, exists}, {tag: "genex:…", exists} or {player, atLeast and/or atMost}` };
  return { step: { kind: PartStepKind.Expect, check } };
};

const readSettle: StepReader = (raw, at) => {
  const seconds = raw.settle;
  if (!isNumber(seconds) || seconds <= 0 || seconds > PART_TEST_LIMITS.settleSeconds)
    return { problem: `${at}: settle must be more than 0 and at most ${PART_TEST_LIMITS.settleSeconds} seconds` };
  return { step: { kind: PartStepKind.Settle, seconds } };
};

const readDrive: StepReader = (raw, at) => {
  const { drive: seconds, frames = 0 } = raw;
  if (!isNumber(seconds) || seconds <= 0 || seconds > PART_TEST_LIMITS.driveSeconds)
    return { problem: `${at}: drive must be more than 0 and at most ${PART_TEST_LIMITS.driveSeconds} seconds` };
  if (!Number.isInteger(frames) || !inRange(Number(frames), 0, PART_TEST_LIMITS.driveFrames))
    return { problem: `${at}: a drive's frames must be a whole number from 0 to ${PART_TEST_LIMITS.driveFrames}` };
  return { step: { kind: PartStepKind.Drive, seconds, frames: Number(frames) } };
};

/** Each step kind by the key a test writes it with. */
const STEP_READERS: ReadonlyArray<[string, StepReader]> = [
  [PartStepKind.Hold, readHold],
  [PartStepKind.Wait, readWait],
  [PartStepKind.Shot, readShot],
  [PartStepKind.Expect, readExpect],
  [PartStepKind.Settle, readSettle],
  [PartStepKind.Drive, readDrive],
];

function readStep(raw: unknown, index: number): Read {
  const at = `step ${index + 1}`;
  if (!isRecord(raw)) return { problem: `${at} is not an object` };
  const reader = STEP_READERS.find(([key]) => key in raw)?.[1];
  if (reader) return reader(raw, at);
  return { problem: `${at} is none of ${STEP_READERS.map(([key]) => key).join(", ")}` };
}

/** The game seconds a step plays for: a hold's, a wait's, a settle's at most and a drive's. */
function stepSeconds(step: PartStep): number {
  if (step.kind === PartStepKind.Shot || step.kind === PartStepKind.Expect) return 0;
  return step.seconds;
}

/** The shots a test's steps take, in order: each shot's name, and each drive's frames numbered on across the test. */
function shotsOf(steps: PartStep[]): string[] {
  const shots: string[] = [];
  let frames = 0;
  for (const step of steps) {
    if (step.kind === PartStepKind.Shot) shots.push(step.name);
    if (step.kind !== PartStepKind.Drive) continue;
    for (let i = 0; i < step.frames; i++) shots.push(frameName(++frames));
  }
  return shots;
}

/** What a test's steps add up to, against the limits. */
function limitProblems(steps: PartStep[], shots: string[]): string[] {
  const problems: string[] = [];
  if (steps.length > PART_TEST_LIMITS.steps) problems.push(`a test has at most ${PART_TEST_LIMITS.steps} steps`);
  if (shots.length > PART_TEST_LIMITS.shots) problems.push(`a test takes at most ${PART_TEST_LIMITS.shots} shots`);
  const twice = shots.filter((name, i) => shots.indexOf(name) !== i);
  if (twice.length) problems.push(`shot ${twice[0]} is taken twice`);
  const seconds = steps.reduce((sum, step) => sum + stepSeconds(step), 0);
  if (seconds > PART_TEST_LIMITS.seconds) problems.push(`a test plays for at most ${PART_TEST_LIMITS.seconds} seconds`);
  return problems;
}

/** A part's test as the queue runs it, or every problem with it. No test: one shot after the warm-up. */
export function parsePartTest(raw: unknown): { ok: true; test: PartTest } | { ok: false; problems: string[] } {
  if (raw === undefined)
    return {
      ok: true,
      test: {
        warmupSeconds: DEFAULT_WARMUP_SECONDS,
        steps: [{ kind: PartStepKind.Shot, name: DEFAULT_SHOT }],
        shots: [DEFAULT_SHOT],
      },
    };
  if (!isRecord(raw)) return { ok: false, problems: ["test.json must be an object with steps"] };
  if (!Array.isArray(raw.steps)) return { ok: false, problems: ["test.json's steps must be a list"] };
  const warmup = raw.warmupSeconds ?? DEFAULT_WARMUP_SECONDS;
  const problems: string[] = [];
  if (!isNumber(warmup) || !inRange(warmup, 0, PART_TEST_LIMITS.warmupSeconds))
    problems.push(`warmupSeconds must be from 0 to ${PART_TEST_LIMITS.warmupSeconds}`);
  const read = raw.steps.map(readStep);
  problems.push(...read.flatMap((r) => (r.problem ? [r.problem] : [])));
  const steps = read.flatMap((r) => (r.step ? [r.step] : []));
  const shots = shotsOf(steps);
  problems.push(...limitProblems(steps, shots));
  if (problems.length) return { ok: false, problems };
  return { ok: true, test: { warmupSeconds: Number(warmup), steps, shots } };
}
