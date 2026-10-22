/**
 * What Godot printed, read: its errors and warnings with the project file and line they name, and
 * the lines Genex's own scripts print (`GENEX_CHECKED`, `GENEX_SHOT`). Godot ends a check or a run
 * with exit code 0 whatever went wrong, so its words are the only verdict. A problem starts with
 * its kind (`SCRIPT ERROR: Parse Error: …`), and the indented `at: <where> (res://file:line)`
 * line below it names the place; a backtrace below that is Godot's own and is skipped.
 */

/** A problem's kind as Godot heads it. Never rename a value: they are Godot's words. */
export const ProblemKind = {
  ScriptError: "SCRIPT ERROR",
  Error: "ERROR",
  Warning: "WARNING",
  UserScriptError: "USER SCRIPT ERROR",
  UserError: "USER ERROR",
  UserWarning: "USER WARNING",
} as const;
export type ProblemKind = (typeof ProblemKind)[keyof typeof ProblemKind];

/** One problem Godot reported: its kind, its words, and the project file and line it names, if any. */
export type GodotProblem = { kind: ProblemKind; message: string; file?: string; line?: number };

/** The most problems one answer lists; the count says how many there were. */
export const MAX_PROBLEMS = 20;
/** The longest message kept of one problem. */
const MESSAGE_CHARS = 400;
const RES_PREFIX = "res://";
const HEAD = /^(SCRIPT ERROR|USER SCRIPT ERROR|USER ERROR|USER WARNING|ERROR|WARNING): (.*)$/;
const AT = /^\s+at: .*\((res:\/\/[^)]+?):(\d+)\)\s*$/;
const ENGINE_AT = /^\s+at: /;
const CHECKED = /^GENEX_CHECKED (\d+)$/m;
const SHOT = /^GENEX_SHOT (\S+) (\d+) (.+\.png)$/gm;
const PLAYED = /^GENEX_PLAYED (\d+)$/m;
const DATA_COPIED = /^GENEX_DATA_COPIED (.+)$/m;
const DATA_FAILED = /^GENEX_DATA_FAILED (.+)$/m;
/**
 * Lines Godot prints about its own surroundings, never about the project: the macOS sandbox Genex
 * runs it in keeps it from the system's certificates, which a game that never goes online ignores.
 */
const ENGINE_NOISE = ["get_system_ca_certificates"] as const;

const isNoise = (where: string) => ENGINE_NOISE.some((noise) => where.includes(noise));
const PROBLEM_KINDS: ReadonlySet<string> = new Set(Object.values(ProblemKind));
const isProblemKind = (value: string): value is ProblemKind => PROBLEM_KINDS.has(value);

/** A problem's project file as the project names it, without `res://`. */
const projectFile = (resPath: string) => resPath.slice(RES_PREFIX.length);

/** The problem a head line starts, and whether the line under it (`next`) places it in the project or in the engine. */
function problemAt(kind: ProblemKind, message: string, next: string | undefined): GodotProblem | null {
  const place = next === undefined ? null : AT.exec(next);
  const text = message.trim().slice(0, MESSAGE_CHARS);
  if (place?.[1] && place[2]) return { kind, message: text, file: projectFile(place[1]), line: Number(place[2]) };
  if (next !== undefined && ENGINE_AT.test(next) && isNoise(next)) return null;
  return { kind, message: text };
}

/** Every problem in Godot's output, in order, each once (Godot repeats some for one cause). */
export function readProblems(output: string): GodotProblem[] {
  const lines = output.split(/\r?\n/);
  const found: GodotProblem[] = [];
  const seen = new Set<string>();
  lines.forEach((line, index) => {
    const head = HEAD.exec(line);
    if (!head?.[1] || head[2] === undefined || !isProblemKind(head[1])) return;
    const problem = problemAt(head[1], head[2], lines[index + 1]);
    if (!problem) return;
    const key = `${problem.kind}|${problem.file ?? ""}|${problem.line ?? ""}|${problem.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(problem);
  });
  return found;
}

/** Whether a problem stops the game working: an error of any kind, never a warning. */
export const isError = (problem: GodotProblem): boolean =>
  problem.kind !== ProblemKind.Warning && problem.kind !== ProblemKind.UserWarning;

/** How many files Genex's check loaded, or null when it never got that far. */
export function checkedCount(output: string): number | null {
  const found = CHECKED.exec(output);
  return found?.[1] ? Number(found[1]) : null;
}

/** One still Genex's play script saved: its camera's name, the frame it was taken at, and its file. */
export type SavedShot = { name: string; frame: number; file: string };

/** The stills Genex's play script says it saved, in order. */
export function savedShots(output: string): SavedShot[] {
  return [...output.matchAll(SHOT)].flatMap((match) =>
    match[1] && match[2] && match[3] ? [{ name: match[1], frame: Number(match[2]), file: match[3] }] : [],
  );
}

/** How many frames Genex's play script played, or null when it stopped before the end. */
export function playedFrames(output: string): number | null {
  const found = PLAYED.exec(output);
  return found?.[1] ? Number(found[1]) : null;
}

/** Whether Genex's data copy (`genex_data.gd`) says it put its file in place, and else why not ("" when it never said). */
export function dataCopied(output: string): { copied: boolean; why: string } {
  if (DATA_COPIED.test(output)) return { copied: true, why: "" };
  return { copied: false, why: DATA_FAILED.exec(output)?.[1]?.trim() ?? "" };
}

/** The problems as one line each, for an answer an agent reads: `file:line: message`. */
export function problemLines(problems: readonly GodotProblem[]): string[] {
  return problems.map((p) => (p.file ? `${p.file}:${p.line ?? 0}: ${p.message}` : `${p.kind}: ${p.message}`));
}
