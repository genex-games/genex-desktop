/**
 * A game from Play on Windows, in an AppContainer of its own (`windows-game-host.ts`): its app
 * read-only, its saves and scratch folders the only places it writes (its AppData goes to the
 * container's own folder), none of the person's files, no network at all, and the person's own
 * desktop, so it has a window, the GPU, sound, the mouse and the keyboard. Windows has no
 * Seatbelt or bubblewrap, and srt-win, the sandbox the agents run in, puts every program on a
 * desktop of its own with no window on screen, so games get this one.
 *
 * The host program is compiled once from its source with the C# compiler every Windows has (.NET
 * Framework 4) into a folder of Genex's own, named by the source's hash. The game ends with the
 * host, which ends with Genex. A Windows game has no way to Genex yet: an AppContainer reaches no
 * loopback port without an administrator's exemption.
 */
import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { MINUTE_MS } from "../../shared/duration.ts";
import { envValue } from "../toolchain.ts";
import type { NativeGameRequest } from "./native-process.ts";
import { treeKiller } from "./native-process.ts";
import { GAME_HOST_SOURCE } from "./windows-game-host.ts";

/** How long the C# compiler may take for the host: a first run on a slow PC takes a few seconds. */
const COMPILE_TIMEOUT_MS = 2 * MINUTE_MS;
/** How many characters of the source's hash name the host's program. */
const HASH_CHARS = 16;
/** The prefix of a game's AppContainer, and the longest name Windows takes for one. */
const CONTAINER_PREFIX = "Genex.Play.";
const CONTAINER_NAME_MAX = 64;
/** What the host says on stdout once the game's window is on screen. */
const WINDOW_LINE = "window";
/** What Genex sends the host to ask the game to close. */
const QUIT_LINE = "quit\n";
/** The parts of the person's environment Windows needs to start a program, and to find the container's folder. */
const PASSED_ENV = [
  "SystemRoot",
  "windir",
  "SystemDrive",
  "PATHEXT",
  "ComSpec",
  "OS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
] as const;

const MESSAGE = {
  NoCompiler: "the C# compiler of .NET Framework 4 is missing",
  Compile: (output: string) => `the game host did not compile: ${output}`,
} as const;

/** Windows' own folder, from the environment. */
const windowsRoot = (env: NodeJS.ProcessEnv) => envValue(env, "SystemRoot") || "C:\\Windows";

/** The C# compiler of .NET Framework 4, 64-bit where there is one. */
export function frameworkCompiler(env: NodeJS.ProcessEnv = process.env, exists = existsSync): string | null {
  const root = windowsRoot(env);
  const candidates = ["Framework64", "Framework"].map((framework) =>
    path.win32.join(root, "Microsoft.NET", framework, "v4.0.30319", "csc.exe"),
  );
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/** A game's AppContainer name: Genex's prefix and the game's own id, only characters Windows allows. */
export function containerName(bundleId: string): string {
  const own = bundleId.replace(/^games\.genex\.play\./, "").replace(/[^A-Za-z0-9.-]/g, "-");
  return `${CONTAINER_PREFIX}${own}`.slice(0, CONTAINER_NAME_MAX);
}

/** What the host is asked to start, as it reads it. */
export interface GameHostRequest {
  container: string;
  displayName: string;
  binary: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  reads: string[];
  writes: string[];
  parent: number;
}

/**
 * The host's request for `request`: the game's own container, its app the one folder it reads,
 * its saves and scratch folders the ones it writes, and an environment of Windows' own folders,
 * the profile's (which Windows needs to make the container's folder) and its scratch as TEMP.
 */
export function gameHostRequest(
  request: NativeGameRequest,
  env: NodeJS.ProcessEnv = process.env,
  parent = process.pid,
): GameHostRequest {
  const root = windowsRoot(env);
  const passed = Object.fromEntries(
    PASSED_ENV.flatMap((name) => {
      const value = envValue(env, name);
      return value ? [[name, value]] : [];
    }),
  );
  return {
    container: containerName(request.bundleId),
    displayName: request.bundleName || request.bundleId,
    binary: request.binary,
    args: [...(request.args ?? [])],
    cwd: path.dirname(request.binary),
    env: {
      ...passed,
      PATH: [path.win32.join(root, "System32"), root, path.win32.join(root, "System32", "Wbem")].join(";"),
      TEMP: request.scratch,
      TMP: request.scratch,
    },
    reads: [request.app],
    writes: [request.saves, request.scratch],
    parent,
  };
}

/** Compiles the host into `dir` once per source, by its hash; the same program after that. */
async function compiledHost(dir: string, env: NodeJS.ProcessEnv): Promise<string> {
  const hash = createHash("sha256").update(GAME_HOST_SOURCE).digest("hex").slice(0, HASH_CHARS);
  const exe = path.join(dir, `genex-game-host-${hash}.exe`);
  if (existsSync(exe)) return exe;
  const compiler = frameworkCompiler(env);
  if (!compiler) throw new Error(MESSAGE.NoCompiler);
  await mkdir(dir, { recursive: true });
  const source = path.join(dir, `genex-game-host-${hash}.cs`);
  const partial = `${exe}.${process.pid}.partial`;
  await writeFile(source, GAME_HOST_SOURCE);
  const args = ["-nologo", "-optimize", "-target:exe", "-r:System.Web.Extensions.dll", `-out:${partial}`, source];
  try {
    await promisify(execFile)(compiler, args, { timeout: COMPILE_TIMEOUT_MS, windowsHide: true });
  } catch (error) {
    const output = (error as { stdout?: string }).stdout ?? String(error);
    throw new Error(MESSAGE.Compile(output.trim().split("\n").slice(0, 3).join(" ")));
  } finally {
    await rm(source, { force: true });
  }
  await rename(partial, exe).catch(async (error: unknown) => {
    // Another Genex compiled the same source meanwhile.
    await rm(partial, { force: true });
    if (!existsSync(exe)) throw error;
  });
  return exe;
}

/** A started game host: its stdin for Genex's requests, its output for the caller. */
type HostProcess = ChildProcessByStdio<Writable, Readable, Readable>;

/** What the launcher gets on Windows: the start, the window check, the bring-forward and the quit. */
export interface WindowsGames {
  spawn(request: NativeGameRequest): Promise<HostProcess>;
  hasWindow(pid: number): Promise<boolean>;
  show(pid: number): Promise<void>;
  /** Ask a game to close (its windows get WM_CLOSE); a host Genex didn't start is ended. */
  kill(pid: number, signal: NodeJS.Signals): void;
}

/**
 * Games on Windows, their host compiled into `hostDir`: each started in its AppContainer, counted
 * on screen once its host says its window is, and asked to close through its host's stdin.
 */
export function windowsGames(hostDir: string, env: NodeJS.ProcessEnv = process.env): WindowsGames {
  const hosts = new Map<number, HostProcess>();
  const shown = new Set<number>();
  return {
    async spawn(p) {
      const request = {
        ...p,
        binary: await realpath(p.binary),
        app: await realpath(p.app),
        saves: await realpath(p.saves),
        scratch: await realpath(p.scratch),
      };
      const exe = await compiledHost(hostDir, env);
      const file = path.join(request.scratch, "game-host.json");
      await writeFile(file, JSON.stringify(gameHostRequest(request, env)));
      const child = spawn(exe, [file], { detached: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const pid = child.pid;
      if (pid) hosts.set(pid, child);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (text: string) => {
        if (pid && text.split(/\r?\n/).includes(WINDOW_LINE)) shown.add(pid);
      });
      child.stdin.on("error", () => undefined);
      const killAll = treeKiller(child);
      child.once("exit", () => {
        if (pid) {
          hosts.delete(pid);
          shown.delete(pid);
        }
        void killAll();
      });
      return child;
    },
    async hasWindow(pid) {
      return shown.has(pid);
    },
    // The host brings the window forward when it first appears; Windows lets no background program take the front later.
    async show() {},
    kill(pid, signal) {
      const host = hosts.get(Math.abs(pid));
      if (host?.stdin.writable) {
        host.stdin.write(QUIT_LINE);
        return;
      }
      process.kill(Math.abs(pid), signal);
    },
  };
}
