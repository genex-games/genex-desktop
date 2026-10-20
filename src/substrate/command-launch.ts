/**
 * How a host-chosen executable is started on each platform.
 *
 * Windows will not start a `.cmd` or `.bat` file directly (Node refuses it without a shell since
 * CVE-2024-27980), and npm installs every global CLI as one (`%APPDATA%\npm\claude.cmd`).
 *
 * - One of npm's shims is not run at all: it only starts `node <script> %*`, so the host starts that
 *   node and script itself, arguments passed as an array, and cmd.exe never parses them.
 * - Any other script runs through `cmd.exe /d /s /c "<line>"`, the line built here: the file
 *   quoted, a plain word bare, and any other argument quoted for the program behind the script
 *   with every cmd.exe metacharacter escaped with `^` twice. Twice, because a script that hands
 *   its arguments on through `%*` has cmd.exe parse them again: escaped once, an argument holding
 *   `"` would end the quoting on that second parse and a following `&` would start a command of
 *   its own. (`/v:off` keeps `!VAR!` literal.)
 *
 * What cmd.exe cannot carry is refused, never passed: a line break or NUL in an argument, and a
 * `%` or `"` in the script's own path, which is quoted and so beyond `^`.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { envValue, isWindows } from "./toolchain.ts";

/** A Windows command script, which only `cmd.exe` can start. */
const WINDOWS_SCRIPT = /\.(?:cmd|bat)$/i;
/** cmd.exe's metacharacters, each escaped with `^` in a script's command line. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
/**
 * A plain word: no cmd.exe metacharacter and no batch-parameter delimiter (space, `=`, `,`, `;`),
 * so it reads the same after one parse or two and goes bare.
 */
const CMD_PLAIN_WORD = /^[A-Za-z0-9_\-.+@:\\/]+$/;
/** What cmd.exe cannot carry in an argument: a line end ends the command. */
const CMD_UNSAFE_ARGUMENT = /[\r\n\0]/;
/** What the quoted script path cannot hold: `%` expands inside quotes, and a quote ends them. */
const CMD_UNSAFE_PATH = /[%"\r\n\0]/;
/** npm's current shim (cmd-shim 4+): `"%_prog%"  "%dp0%\<script>" %*`, `_prog` a local node.exe or `node`. */
const NPM_SHIM_TARGET = /"%_prog%"\s+"%dp0%\\([^"]+)"\s+%\*/i;
/** npm's older shim: `"%~dp0\node.exe"  "%~dp0\<script>" %*`, else `node "%~dp0\<script>" %*`. */
const OLD_NPM_SHIM_TARGET = /"%~dp0\\node\.exe"\s+"%~dp0\\([^"]+)"\s+%\*/i;
/** The node a shim prefers, beside it. */
const LOCAL_NODE = "node.exe";
/** Node on PATH, which is what a shim runs when there is no local one. */
const PATH_NODE = "node";

const MESSAGE = {
  UnsafeScript: (file: string) => `Refusing to start a command script whose path cmd.exe would rewrite: ${file}`,
  UnsafeArgument: "Refusing a command-script argument that cmd.exe would rewrite",
} as const;

/** The file, arguments and spawn option that start `file` with `args` on `platform`. */
export interface CommandLaunch {
  file: string;
  args: string[];
  /** Windows scripts only: the arguments are one prepared command line, passed as written. */
  windowsVerbatimArguments: boolean;
}

/** How a script is inspected; injectable so the tables run on any host. */
export interface ScriptReader {
  /** The script's text, or null when it cannot be read. */
  readScript: (file: string) => string | null;
  exists: (file: string) => boolean;
}

const DISK: ScriptReader = {
  readScript: (file) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  },
  exists: (file) => existsSync(file),
};

/** Whether `file` is a Windows command script on `platform`. */
export function isCommandScript(file: string, platform: NodeJS.Platform = process.platform): boolean {
  return isWindows(platform) && WINDOWS_SCRIPT.test(file);
}

/**
 * One argument as the program behind a script reads it (the C runtime's quoting: backslashes
 * before a quote doubled, the quote escaped, the whole quoted), then escaped for cmd.exe: once for
 * the command line, and `twice` when the script hands it on through `%*` and cmd.exe parses it again.
 */
export function cmdArgument(arg: string, options: { twice?: boolean } = {}): string {
  if (CMD_UNSAFE_ARGUMENT.test(arg)) throw new Error(MESSAGE.UnsafeArgument);
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  const once = quoted.replace(CMD_META, "^$1");
  return options.twice ? once.replace(CMD_META, "^$1") : once;
}

/**
 * One argument on a script's command line. A script that forwards `%*` has cmd.exe parse its
 * arguments twice, one that reads `%1` itself once, and nothing tells them apart: a plain word
 * reads the same either way and goes bare; anything else is escaped for two parses, which keeps
 * a forwarding script from running what it spells (a direct reader then sees the carets).
 */
function scriptArgument(arg: string): string {
  return CMD_PLAIN_WORD.test(arg) ? arg : cmdArgument(arg, { twice: true });
}

/**
 * The node script one of npm's shims starts, absolute, or null when `text` is not such a shim.
 * `%dp0%` / `%~dp0` is the shim's own folder.
 */
export function npmShimScript(text: string, shim: string): string | null {
  const relative = (NPM_SHIM_TARGET.exec(text) ?? OLD_NPM_SHIM_TARGET.exec(text))?.[1];
  return relative ? path.win32.join(path.win32.dirname(shim), relative) : null;
}

/** `cmd.exe` by its full path, so a PATH entry or working folder can never stand in for it. */
export function commandInterpreter(env: NodeJS.ProcessEnv): string {
  const systemRoot = envValue(env, "SystemRoot") || "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "cmd.exe");
}

/** One of npm's shims, started as the node it would run and its script: no cmd.exe at all. */
function shimLaunch(shim: string, args: readonly string[], reader: ScriptReader): CommandLaunch | null {
  const text = reader.readScript(shim);
  const script = text === null ? null : npmShimScript(text, shim);
  if (!script) return null;
  const localNode = path.win32.join(path.win32.dirname(shim), LOCAL_NODE);
  const node = reader.exists(localNode) ? localNode : PATH_NODE;
  return { file: node, args: [script, ...args], windowsVerbatimArguments: false };
}

/**
 * How to start `file` with `args`: as it is; on Windows one of npm's shims as node and its script;
 * any other command script through cmd.exe. Throws, starting nothing, when the script's path or an
 * argument holds what cmd.exe cannot carry.
 */
export function commandLaunch(
  file: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  reader: ScriptReader = DISK,
): CommandLaunch {
  if (!isCommandScript(file, platform)) return { file, args: [...args], windowsVerbatimArguments: false };
  const direct = shimLaunch(file, args, reader);
  if (direct) return direct;
  if (CMD_UNSAFE_PATH.test(file)) throw new Error(MESSAGE.UnsafeScript(file));
  const line = [`"${file}"`, ...args.map(scriptArgument)].join(" ");
  return {
    file: commandInterpreter(env),
    args: ["/d", "/v:off", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * `spawn` for a host-chosen CLI: a Windows command script as `commandLaunch` decides, with no
 * console window. Stop it with `killProcessTree`: `kill()` would end only cmd.exe.
 */
export function spawnCommand(file: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
  const launch = commandLaunch(file, args);
  return spawn(launch.file, launch.args, {
    ...options,
    windowsHide: true,
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
  });
}

/**
 * What a whole-quoted script line can't carry: a quote ends the quoting, `%` expands inside quotes,
 * `!` expands for a script that turns on delayed expansion, and a control character ends the line.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
const QUOTED_LINE_UNSAFE = /["%!\x00-\x1f]/;
/** A `-Name=value` argument, as Epic's AutomationTool and UnrealBuildTool take one. */
const NAMED_ARGUMENT = /^(-[A-Za-z][A-Za-z0-9_]*=)(.+)$/;
/** A word that reads the same through any number of cmd.exe parses and goes bare (`=` stays in `%*`). */
const QUOTED_LINE_PLAIN = /^[A-Za-z0-9_\-.+@:\\/=]+$/;

/** Why a whole-quoted script line was refused. */
const QUOTED_LINE_MESSAGE = {
  Unsafe: "Refusing a command-script line cmd.exe can't carry: a quote, %, ! or a control character",
  TrailingBackslash: "Refusing a quoted command-script argument that ends in a backslash",
} as const;

/** One argument of a whole-quoted line: a plain word bare, `-Name="value"`, or the whole of it quoted. */
function quotedLineArgument(arg: string): string {
  if (QUOTED_LINE_UNSAFE.test(arg)) throw new Error(QUOTED_LINE_MESSAGE.Unsafe);
  if (QUOTED_LINE_PLAIN.test(arg)) return arg;
  // A backslash before the closing quote would escape it for the program behind the script.
  if (arg.endsWith("\\")) throw new Error(QUOTED_LINE_MESSAGE.TrailingBackslash);
  const named = NAMED_ARGUMENT.exec(arg);
  return named ? `${named[1]}"${named[2]}"` : `"${arg}"`;
}

/**
 * A command script's line with every path whole inside double quotes, for a script that hands its
 * arguments on through `%*` (Epic's RunUAT.bat): inside quotes `&`, `|`, `<`, `>`, `^`, `(`, `)`
 * and spaces stay literal on every parse, and no quote is ever added inside or escaped, so the
 * quoting reads the same the second time. What quotes can't hold is refused, never passed: a quote,
 * `%`, `!` or a control character anywhere, and a backslash ending a quoted argument.
 */
export function quotedScriptLine(file: string, args: readonly string[]): string {
  if (QUOTED_LINE_UNSAFE.test(file)) throw new Error(QUOTED_LINE_MESSAGE.Unsafe);
  return [`"${file}"`, ...args.map(quotedLineArgument)].join(" ");
}
