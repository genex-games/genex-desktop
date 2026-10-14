/**
 * The game conformance suite's verdict primitives, shared by its checks (`game-conformance.ts`)
 * and its renderer checks (`game-conformance-render.ts`): a check's typed failure, its result rows,
 * and how one contract verb is sent and judged.
 */
import {
  type ConformanceCheck,
  type ConformanceCheckResult,
  ConformanceOutcome,
  ConformanceProblem,
} from "../../shared/game-conformance.ts";
import { NativeError, NativeOpError, NativeRefusal } from "../../shared/native-contract.ts";
import { NativeExitError, NativeOpRefusedError } from "../../substrate/native-game-port.ts";

const MESSAGE = {
  verb: (op: string, why: string) => `${op}: ${why}`,
  answered: (op: string) => `${op} answered outside its contract`,
} as const;

/** A check that cannot pass, with its typed code. */
export class CheckFailure extends Error {
  readonly code: ConformanceProblem;
  constructor(code: ConformanceProblem, detail: string) {
    super(detail);
    this.name = "CheckFailure";
    this.code = code;
  }
}

/** One check's result row. */
export const result = (
  check: ConformanceCheck,
  outcome: ConformanceOutcome,
  code: ConformanceProblem | null = null,
  detail: string | null = null,
): ConformanceCheckResult => ({ check, outcome, code, detail });

/** A passing row. */
export const passed = (check: ConformanceCheck): ConformanceCheckResult => result(check, ConformanceOutcome.Pass);

/** A failing row for whatever the check threw. */
export const failed = (check: ConformanceCheck, error: unknown): ConformanceCheckResult => {
  const failure = asFailure(error);
  return result(check, ConformanceOutcome.Fail, failure.code, failure.message);
};

/** An answer every shape the port accepted passes. */
export const always = () => true;

/** The host's refusals that say the bytes on disk are not what the game declared. */
const CAPTURE_REFUSALS: Partial<Record<NativeRefusal, ConformanceProblem>> = {
  [NativeRefusal.CaptureDigest]: ConformanceProblem.CaptureDigest,
  [NativeRefusal.CaptureTooLarge]: ConformanceProblem.CaptureFile,
};

/** The typed failure behind anything a check threw. */
export function asFailure(error: unknown, op = ""): CheckFailure {
  if (error instanceof CheckFailure) return error;
  const why = error instanceof Error ? error.message : String(error);
  const detail = op ? MESSAGE.verb(op, why) : why;
  if (error instanceof NativeOpRefusedError) {
    const missing = error.gameError === NativeOpError.UnknownOp;
    return new CheckFailure(missing ? ConformanceProblem.VerbMissing : ConformanceProblem.VerbFailed, detail);
  }
  if (error instanceof NativeExitError) return new CheckFailure(ConformanceProblem.GameEnded, detail);
  if (error instanceof NativeError) return new CheckFailure(nativeProblem(error.refusal), detail);
  return new CheckFailure(ConformanceProblem.VerbFailed, detail);
}

/** A refusal the port ended the game with, as the check's code. */
function nativeProblem(refusal: NativeRefusal): ConformanceProblem {
  if (refusal === NativeRefusal.ReplyInvalid) return ConformanceProblem.VerbInvalid;
  return CAPTURE_REFUSALS[refusal] ?? ConformanceProblem.GameEnded;
}

/** One verb: its answer, or a typed failure naming it; `valid` checks what the answer says it did. */
export async function verb<T>(op: string, call: () => Promise<T>, valid: (answer: T) => boolean): Promise<T> {
  let answer: T;
  try {
    answer = await call();
  } catch (error) {
    throw asFailure(error, op);
  }
  if (!valid(answer)) throw new CheckFailure(ConformanceProblem.VerbInvalid, MESSAGE.answered(op));
  return answer;
}

/** Runs `check` into a result: a pass, or the failure it threw. */
export async function judged(check: ConformanceCheck, run: () => Promise<void>): Promise<ConformanceCheckResult> {
  try {
    await run();
    return passed(check);
  } catch (error) {
    return failed(check, error);
  }
}
