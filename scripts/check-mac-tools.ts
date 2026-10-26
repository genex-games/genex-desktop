import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { maskSource, vocabularyFiles } from "./check-vocabulary.ts";

// Most developer programs in macOS's /usr/bin (`lipo`, `otool`, `xcrun`, `clang`, `python3`…) only
// stand in for Xcode's copy: on a Mac without Apple's developer tools they fail, and may ask to
// install the tools. Genex's players are not developers, so shipped code never runs one: it reads
// the file itself (a Mach-O header) or uses a tool macOS ships (`ditto`, `codesign`, `plutil`).
// This check refuses a stand-in named by its /usr/bin path or as a process's program, in src/**.
// It knows nothing about types, so it matches only those two narrow shapes.

/** The /usr/bin programs that run a developer tool from Xcode (each one the same xcselect stand-in). */
export const XCODE_STAND_INS: readonly string[] = [
  "DeRez",
  "GetFileInfo",
  "ResMerger",
  "Rez",
  "SetFile",
  "SplitForks",
  "ar",
  "as",
  "asa",
  "bison",
  "bm4",
  "c++",
  "c++filt",
  "c89",
  "c99",
  "cc",
  "clang",
  "clang++",
  "clangd",
  "cmpdylib",
  "codesign_allocate",
  "cpp",
  "ctags",
  "ctf_insert",
  "dsymutil",
  "dwarfdump",
  "dyld_info",
  "flex",
  "flex++",
  "g++",
  "gatherheaderdoc",
  "gcc",
  "gcov",
  "git",
  "git-receive-pack",
  "git-shell",
  "git-upload-archive",
  "git-upload-pack",
  "gm4",
  "gnumake",
  "gperf",
  "hdxml2manxml",
  "headerdoc2html",
  "indent",
  "install_name_tool",
  "ld",
  "lex",
  "libtool",
  "lipo",
  "lldb",
  "llvm-g++",
  "llvm-gcc",
  "lorder",
  "m4",
  "make",
  "mig",
  "nm",
  "nmedit",
  "objdump",
  "otool",
  "pagestuff",
  "pip3",
  "python3",
  "ranlib",
  "resolveLinks",
  "rpcgen",
  "segedit",
  "size",
  "sourcekit-lsp",
  "strings",
  "strip",
  "swift",
  "swiftc",
  "unifdef",
  "unifdefall",
  "vtool",
  "xcodebuild",
  "xcrun",
  "xml2man",
  "yacc",
];

/**
 * Stand-ins Genex runs on purpose, each with its reason. Git: Create's version history, Publish and
 * Remix run `git` by name; on a Mac without the developer tools the app puts its own git first on
 * PATH (`ensureMacGit` in `substrate/git-policy.ts`), and Play asks `hostGitRuns` before
 * Remix, so a player's Mac never runs the stand-in.
 */
const RUN_ON_PURPOSE: ReadonlySet<string> = new Set(["git"]);

/** Code that only runs on a developer's Mac: the development fixtures build their test games with Xcode. */
const DEVELOPER_ONLY = ["src/main/dev/"];

/** One stand-in run: where it is, which tool, and the line it sits on. */
export interface StandInFinding {
  file: string;
  line: number;
  tool: string;
  text: string;
}

const escape = (name: string) => name.replace(/[+]/g, "\\+");
const REFUSED = XCODE_STAND_INS.filter((tool) => !RUN_ON_PURPOSE.has(tool))
  .map(escape)
  .join("|");
/** A literal that is a stand-in's /usr/bin path, whole. */
const BY_PATH = new RegExp(String.raw`["\x60]/usr/bin/(${REFUSED})["\x60]`, "g");
/** A literal stand-in name as the program a process call starts. */
const BY_NAME = new RegExp(
  String.raw`(?:\b(?:execFile|execFileSync|spawn|spawnSync|exec|execSync|run)|#run)\(\s*["\x60](${REFUSED})["\x60]`,
  "g",
);

/** The 1-based line of an offset. */
const lineAt = (text: string, offset: number) => text.slice(0, offset).split("\n").length;

/** Every Xcode stand-in one file runs, by its repository path: one per tool and line. */
export function findXcodeStandIns(file: string, source: string): StandInFinding[] {
  if (DEVELOPER_ONLY.some((tree) => file.startsWith(tree))) return [];
  const masked = maskSource(source);
  const lines = source.split("\n");
  const findings = new Map<string, StandInFinding>();
  for (const match of [...masked.matchAll(BY_PATH), ...masked.matchAll(BY_NAME)]) {
    const tool = match[1] ?? "";
    const line = lineAt(masked, match.index ?? 0);
    const key = `${tool}:${line}`;
    if (!findings.has(key)) findings.set(key, { file, line, tool, text: (lines[line - 1] ?? "").trim() });
  }
  return [...findings.values()].sort((a, b) => a.line - b.line);
}

/** Every checked file: the app's own code in src/, as the vocabulary check walks it. */
export const macToolFiles = (root: string): string[] => vocabularyFiles(root, ["src"]);

/** The report lines for every stand-in the files run; empty when there is none. */
export function checkMacTools(root: string, files: readonly string[] = macToolFiles(root)): string[] {
  return files.flatMap((file) =>
    findXcodeStandIns(file, fs.readFileSync(path.join(root, file), "utf8")).map(
      (f) =>
        `${f.file}:${f.line}: runs ${f.tool}, a stand-in for Xcode's that a player's Mac doesn't have — read the file in the app or use macOS's own tool\n    ${f.text}`,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd();
  const started = performance.now();
  const files = macToolFiles(root);
  const errors = checkMacTools(root, files);
  const ms = Math.round(performance.now() - started);
  if (errors.length) {
    console.error(errors.join("\n"));
    console.error(`Mac tools: ${errors.length} Xcode stand-in(s); see AGENTS.md, Engineering foundations.`);
    process.exitCode = 1;
  } else console.log(`Mac tools: no Xcode stand-ins in ${files.length} files (${ms} ms)`);
}
