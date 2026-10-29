/**
 * cua-driver embedded in the studio (trycua/cua, MIT; its `EMBEDDING.md`): the studio starts the
 * driver's daemon itself, as its own child (`cua-driver serve --embedded`), on a private endpoint,
 * and talks to it through the driver's MCP proxy (`cua-driver mcp --embedded --socket <path>`).
 *
 * - **macOS.** The endpoint is a Unix socket in a private folder. A child the studio spawns stays in
 *   the studio's macOS responsibility chain, so Accessibility and Screen Recording are the studio's
 *   own grants: no second app in System Settings, no second prompt. The daemon never relaunches
 *   itself through LaunchServices in this mode, which would leave the chain.
 * - **Windows.** The endpoint is a named pipe with a fresh random name; the embedded daemon lets
 *   only the person's own account open it. Windows asks no grant of either process, and the daemon
 *   runs in the person's session, where it can see and move, because the studio started it there.
 *
 * The bundled driver ships with the app (`scripts/vendor-cua-driver.ts` puts it in the resources);
 * an installed one is used only where none is bundled, such as a development build.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SECOND_MS } from "../shared/duration.ts";
import { errorMessage } from "../shared/errors.ts";
import type { CuaCommand } from "./cua-driver-client.ts";

/** The folder in the app's resources the bundled driver lives in. */
export const CUA_DRIVER_DIR = "cua-driver";

/** The driver's executable name on `platform`. */
export function cuaDriverBinary(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "cua-driver.exe" : "cua-driver";
}

/** How long the daemon has to start listening; its own startup is well under a second. */
const START_MS = 10 * SECOND_MS;
/** How often the socket is tried while the daemon starts. */
const START_POLL_MS = 50;
/** How long a stopped daemon has to exit before it is killed. */
const STOP_MS = 3 * SECOND_MS;
/** How much of the daemon's stderr is kept to say why it did not start. */
const MAX_STDERR_CHARS = 2_000;
/** The socket's name in the daemon's private folder: short, as a Unix socket path is limited to 104 bytes. */
const SOCKET_NAME = "d.sock";
/** Where Windows keeps named pipes, and the start of each daemon's pipe name there. */
const PIPE_PREFIX = "\\\\.\\pipe\\genex-cua-";

const MESSAGE = {
  notStarted: (why: string) => `cua-driver did not start: ${why}`,
  exited: (code: number | null) => `it exited (${code ?? "signal"})`,
  timedOut: "it did not listen within 10 s",
} as const;

/**
 * The release app's bundle id (`APP_BUNDLE_ID` in scripts/package-signing.cjs), told to the embedded
 * driver as a label it echoes back. macOS decides whose grants count from the process chain, not this.
 */
export const HOST_BUNDLE_ID = "games.genex.desktop";

/** Where the app's own driver is: `<resources>/cua-driver/cua-driver` (`cua-driver.exe` on Windows). */
export function bundledCuaDriver(resources: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(resources, CUA_DRIVER_DIR, cuaDriverBinary(platform));
}

/** Where one daemon listens: its socket or pipe, and the private folder to remove after it, if any. */
export interface DaemonEndpoint {
  socket: string;
  dir: string | null;
}

/**
 * A new daemon's endpoint: on Windows a named pipe no earlier daemon used (the embedded daemon
 * refuses an endpoint that exists), elsewhere a socket in a private folder (0700) of its own, so no
 * other user can reach it.
 */
export async function daemonEndpoint(platform: NodeJS.Platform = process.platform): Promise<DaemonEndpoint> {
  if (platform === "win32") return { socket: `${PIPE_PREFIX}${randomUUID()}`, dir: null };
  const dir = await mkdtemp(path.join(os.tmpdir(), "genex-cua-"));
  return { socket: path.join(dir, SOCKET_NAME), dir };
}

/**
 * The environment that makes the driver embedded, and keeps it quiet: no product telemetry
 * (`DO_NOT_TRACK` wins over every other telemetry setting) and no background update check, since
 * the app ships the version it was tested with. `CUA_DRIVER_HOST_BUNDLE_ID` is only a label the
 * driver echoes back; trust comes from the responsibility chain.
 */
export function embeddedEnv(hostBundleId: string): Record<string, string> {
  return {
    CUA_DRIVER_EMBEDDED: "1",
    CUA_DRIVER_HOST_BUNDLE_ID: hostBundleId,
    DO_NOT_TRACK: "1",
    CUA_DRIVER_RS_UPDATE_CHECK: "0",
  };
}

/**
 * Asks the embedded daemon to treat its stdin as the app's lifetime pipe: when the app ends, even
 * by a crash that runs no stop, the pipe closes and the daemon exits rather than outliving it (on
 * Windows it would also hold the app's folder open against an update).
 */
const LIFETIME_PIPE_ENV = { CUA_DRIVER_PARENT_LIVENESS_STDIN: "1" } as const;

/** The studio's own driver daemon: the proxy command that reaches it, a restart, and the stop. */
export interface EmbeddedCuaDriver {
  /** The MCP proxy's command for the running daemon, started first when none runs. */
  command(): Promise<CuaCommand>;
  /** Stop the daemon so the next command starts a fresh one (macOS caches a process's grants). */
  restart(): Promise<void>;
  /** Stop the daemon and remove its socket. */
  stop(): Promise<void>;
}

/** One running daemon: its process, its endpoint, and why it ended if it did. */
interface Daemon extends DaemonEndpoint {
  child: ChildProcess;
  exited: Promise<void>;
  /** Why the process ended (it exited, or could not be run at all), or null while it runs. */
  ended: () => string | null;
}

/** Whether something accepts connections on `socket` now. */
function listening(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(socket);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

/** Whether the daemon's socket file is there yet; a named pipe is seen only by connecting to it. */
function socketPresent(daemon: Daemon): Promise<boolean> {
  if (daemon.dir === null) return Promise.resolve(true);
  return access(daemon.socket, constants.F_OK).then(
    () => true,
    () => false,
  );
}

/** Wait for the daemon to listen; refuse with its own words when it exits first or never listens. */
async function untilListening(daemon: Daemon, said: () => string): Promise<void> {
  const deadline = Date.now() + START_MS;
  while (Date.now() < deadline) {
    const ended = daemon.ended();
    if (ended !== null) throw new Error(MESSAGE.notStarted(said() || ended));
    const ready = (await socketPresent(daemon)) && (await listening(daemon.socket));
    if (ready) return;
    await sleep(START_POLL_MS);
  }
  throw new Error(MESSAGE.notStarted(said() || MESSAGE.timedOut));
}

/**
 * Stop one daemon: close its lifetime pipe, which it takes for an orderly shutdown on both systems
 * (a signal ends a Windows process at once), then a kill, then its folder.
 */
async function stopDaemon(daemon: Daemon): Promise<void> {
  if (daemon.child.exitCode === null && daemon.child.signalCode === null) {
    daemon.child.stdin?.end();
    const stopped = await Promise.race([daemon.exited.then(() => true), sleep(STOP_MS).then(() => false)]);
    if (!stopped) daemon.child.kill("SIGKILL");
  }
  if (daemon.dir !== null) await rm(daemon.dir, { recursive: true, force: true });
}

/**
 * The studio's embedded driver. `driver` is the driver's own command (the bundled executable, or a
 * stand-in and its arguments in a test); `env` is what the driver may see of the studio's
 * environment. Starts coalesce; a daemon that dies is started again on the next command.
 */
export function embeddedCuaDriver(
  driver: CuaCommand,
  options: { hostBundleId: string; env: Record<string, string> },
): EmbeddedCuaDriver {
  const env = { ...options.env, ...embeddedEnv(options.hostBundleId) };
  let running: Promise<Daemon> | null = null;
  let current: Daemon | null = null;
  const proxy = (daemon: Daemon): CuaCommand => ({
    command: driver.command,
    args: [...driver.args, "mcp", "--embedded", "--socket", daemon.socket],
    env,
  });
  const start = async (): Promise<Daemon> => {
    const endpoint = await daemonEndpoint();
    // Spawned directly, never through `open`: that would hand it to LaunchServices and out of the
    // chain. No console window opens for it on Windows.
    const child = spawn(driver.command, [...driver.args, "serve", "--embedded", "--socket", endpoint.socket], {
      env: { ...env, ...LIFETIME_PIPE_ENV },
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    // The lifetime pipe stays open, unwritten, until the daemon or the app ends.
    child.stdin?.on("error", () => {});
    let said = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      said = `${said}${chunk.toString()}`.slice(-MAX_STDERR_CHARS);
    });
    let ended: string | null = null;
    // A driver that cannot be run at all reports an error, and may never report an exit.
    const exited = new Promise<void>((resolve) => {
      child.once("exit", (code) => {
        ended ??= MESSAGE.exited(code);
        resolve();
      });
      child.once("error", (error) => {
        ended ??= errorMessage(error);
        resolve();
      });
    });
    const daemon: Daemon = { ...endpoint, child, exited, ended: () => ended };
    try {
      await untilListening(daemon, () => said.trim());
    } catch (error) {
      await stopDaemon(daemon);
      throw error;
    }
    // The app quitting takes its daemon with it, even when no orderly stop runs.
    const reap = () => child.kill("SIGKILL");
    process.once("exit", reap);
    void exited.then(() => {
      process.removeListener("exit", reap);
      if (current === daemon) running = null;
    });
    current = daemon;
    return daemon;
  };
  const stop = async (): Promise<void> => {
    const daemon = await running?.catch(() => null);
    running = null;
    current = null;
    if (daemon) await stopDaemon(daemon);
  };
  return {
    command: async () => {
      running ??= start().catch((error: unknown) => {
        running = null;
        throw error;
      });
      return proxy(await running);
    },
    restart: stop,
    stop,
  };
}
