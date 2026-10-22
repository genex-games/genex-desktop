/**
 * What the stage's build-problem strip says, pure: the sentence for the problem's typed reason,
 * and the C++ lane's first diagnostics, each once, where it points. `build-problem.tsx` renders it;
 * the conformance tests hold it without a DOM.
 */
import { type BuildDiagnostic, type BuildProblem, BuildProblemCode } from "../../../shared/build-problem.ts";
import { t } from "../../../shared/i18n.ts";
import { missingFor, PrewarmState, type ToolchainStatus } from "../../../shared/toolchain.ts";
import { BUILD_PROBLEM_WORDS, NATIVE_WORDS } from "../../words.ts";

/** The strip's sentences for a command that ran and failed (every build problem before typed reasons). */
const MESSAGE = {
  needsInstall: () => t("Its packages aren’t installed yet."),
  showingLastBuild: () => t("Showing the last working build. The newest changes aren’t included."),
  fix: () => t("Fix the build error, then try again."),
  /** Details' line for an install that failed, and for the build's command with its exit. */
  installFailed: (command: string) => t("{command} failed", { command }),
  exited: (command: string, code: number | null) =>
    t("{command} (exit {code})", { command, code: code ?? t("stopped") }),
  /** Details for a build the PE or ELF gate refused: the file in `out/` and the rule, as the gate named them. */
  gateFile: (file: string, refusal: string) => `Safety check: ${file} (${refusal})`,
} as const;

/** The C++ lane parses at most this many diagnostics; the strip shows no more than that. */
export const DIAGNOSTICS_SHOWN = 3;

/** The one way on the strip offers for a problem. */
export const TroubleAction = {
  /** Its packages are missing: install them. */
  InstallPackages: "install-packages",
  /** A C++ tool it builds with is missing: open the Toolchain sheet. */
  InstallTools: "install-tools",
  /** The C++ tools were set up by an older Genex: open the Toolchain sheet to set them up again. */
  SetUpTools: "set-up-tools",
  /** The C++ tools are installed but their first build was never prepared: open the sheet to finish. */
  FinishSetUp: "finish-set-up",
  TryAgain: "try-again",
} as const;
export type TroubleAction = (typeof TroubleAction)[keyof typeof TroubleAction];

/** What the strip offers for `problem`: install what is missing, or build again. */
export function troubleAction(problem: BuildProblem): TroubleAction {
  const reason = problemReason(problem);
  if (reason === BuildProblemCode.ToolchainMissing) return TroubleAction.InstallTools;
  if (reason === BuildProblemCode.ToolchainStale) return TroubleAction.SetUpTools;
  if (reason === BuildProblemCode.ToolchainUnprepared) return TroubleAction.FinishSetUp;
  return problem.needsInstall && problem.install ? TroubleAction.InstallPackages : TroubleAction.TryAgain;
}

/**
 * `problem` as the store's own status tells it: a lane that says a tool is missing while the store
 * holds every component the destination needs and only its first build is unprepared (or stale)
 * means set-up, not install. Anything else, or a status not read yet, is the lane's own word.
 */
export function reconciledProblem(problem: BuildProblem, status: ToolchainStatus | null): BuildProblem {
  const { target } = problem;
  if (!status || !target || problemReason(problem) !== BuildProblemCode.ToolchainMissing) return problem;
  const missing = missingFor(status, [target]);
  if (missing.components.length > 0 || !missing.prewarm.includes(target)) return problem;
  const stale = status.prewarm?.[target] === PrewarmState.Stale;
  return { ...problem, reason: stale ? BuildProblemCode.ToolchainStale : BuildProblemCode.ToolchainUnprepared };
}

/**
 * What Details shows: a failed package install's lines first, then the command and how it ended
 * with the lines it printed. A build that never started (a typed refusal: no command) shows only
 * the facts it gave, never a made-up command line; none at all means no Details.
 */
export function detailLines(problem: BuildProblem, installLines: readonly string[] | null): string[] {
  const install = installLines ? [MESSAGE.installFailed(problem.install ?? "install"), ...installLines, ""] : [];
  const command = problem.command ? [MESSAGE.exited(problem.command, problem.code)] : [];
  const gate = problem.gate ? [MESSAGE.gateFile(problem.gate.file, problem.gate.refusal)] : [];
  return [...install, ...command, ...gate, ...problem.lines];
}

/** The gate's refusal in words, for a build the safety check refused; null for any other problem or a refusal this renderer does not know. */
function gateWords(problem: BuildProblem): string | null {
  const refusal = problem.gate?.refusal;
  return refusal && Object.hasOwn(NATIVE_WORDS.refusal, refusal) ? NATIVE_WORDS.refusal[refusal] : null;
}

/** The problem's typed reason; absent (a problem from before reasons) or one this renderer does not know reads as a failed command. */
export function problemReason(problem: BuildProblem): BuildProblemCode {
  const { reason } = problem;
  return reason && Object.hasOwn(BUILD_PROBLEM_WORDS, reason) ? reason : BuildProblemCode.CommandFailed;
}

/**
 * What the strip says about the build: why a C++ build never started or was refused by the safety
 * check (with the gate's reason), packages missing, the last working build on show, or an error to fix.
 */
export function troubleWords(problem: BuildProblem): string {
  const reason = problemReason(problem);
  const gate = reason === BuildProblemCode.GateRefused ? gateWords(problem) : null;
  if (gate) return `${BUILD_PROBLEM_WORDS[reason]} ${gate}`;
  if (reason !== BuildProblemCode.CommandFailed) return BUILD_PROBLEM_WORDS[reason];
  if (problem.needsInstall) return MESSAGE.needsInstall();
  return problem.showingLastBuild ? MESSAGE.showingLastBuild() : MESSAGE.fix();
}

/** Where a diagnostic points, as a compiler prints it: `file:line:col`, as much of it as is known. */
export function diagnosticPlace(diagnostic: BuildDiagnostic): string | null {
  if (!diagnostic.file) return null;
  return [diagnostic.file, diagnostic.line, diagnostic.column].filter((part) => part !== null).join(":");
}

/** Every field of a diagnostic: two that say the same thing at the same place are one, and it keys the strip's row. */
export function diagnosticKey(diagnostic: BuildDiagnostic): string {
  return JSON.stringify([diagnostic.tool, diagnostic.file, diagnostic.line, diagnostic.column, diagnostic.message]);
}

/**
 * The diagnostics the strip lists: each once, in the order the lane parsed them, at most
 * {@link DIAGNOSTICS_SHOWN}. An error in a shared header is printed once per file that includes
 * it; three copies of one line would crowd out the next error.
 */
export function shownDiagnostics(diagnostics: readonly BuildDiagnostic[]): BuildDiagnostic[] {
  const seen = new Set<string>();
  const unique = diagnostics.filter((diagnostic) => {
    const key = diagnosticKey(diagnostic);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.slice(0, DIAGNOSTICS_SHOWN);
}
