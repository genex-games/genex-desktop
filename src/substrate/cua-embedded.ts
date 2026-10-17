/**
 * cua-driver embedded in the studio (trycua/cua, MIT; its `EMBEDDING.md`): the studio starts the
 * driver's daemon itself, as its own child (`cua-driver serve --embedded`), on a private socket, and
 * talks to it through the driver's MCP proxy (`cua-driver mcp --embedded --socket <path>`). A child
 * the studio spawns stays in the studio's macOS responsibility chain, so Accessibility and Screen
 * Recording are the studio's own grants: no second app in System Settings, no second prompt. The
 * daemon never relaunches itself through LaunchServices in this mode, which would leave the chain.
 *
 * The bundled driver ships with the app (`scripts/vendor-cua-driver.ts` puts it in the resources);
 * an installed one is used only where none is bundled, such as a development build.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SECOND_MS } from "../shared/duration.ts";
import { errorMessage } from "../shared/errors.ts";
import type { CuaCommand } from "./cua-driver-client.ts";

/** The folder in the app's resources the bundled driver lives in, and its executable's name. */
export const CUA_DRIVER_DIR = "cua-driver";
export const CUA_DRIVER_BINARY = "cua-driver";

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

/** Where the app's own driver is: `<resources>/cua-driver/cua-driver`. */
export function bundledCuaDriver(resources: string): string {
  return path.join(resources, CUA_DRIVER_DIR, CUA_DRIVER_BINARY);
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

/** The studio's own driver daemon: the proxy command that reaches it, a restart, and the stop. */
export interface EmbeddedCuaDriver {
  /** The MCP proxy's command for the running daemon, started first when none runs. */
  command(): Promise<CuaCommand>;
  /** Stop the daemon so the next command starts a fresh one (macOS caches a process's grants). */
  restart(): Promise<void>;
  /** Stop the daemon and remove its socket. */
  stop(): Promise<void>;
}

/** One running daemon: its process, its private folder and socket, and why it ended if it did. */
interface Daemon {
  child: ChildProcess;
  dir: string;
  socket: string;
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

/** Wait for the daemon to listen; refuse with its own words when it exits first or never listens. */
async function untilListening(daemon: Daemon, said: () => string): Promise<void> {
  const deadline = Date.now() + START_MS;
  while (Date.now() < deadline) {
    const ended = daemon.ended();
    if (ended !== null) throw new Error(MESSAGE.notStarted(said() || ended));
    const ready = await access(daemon.socket, constants.F_OK).then(
      () => listening(daemon.socket),
      () => false,
    );
    if (ready) return;
    await sleep(START_POLL_MS);
  }
  throw new Error(MESSAGE.notStarted(said() || MESSAGE.timedOut));
}

/** Stop one daemon: a polite signal, then a kill, then its folder. */
async function stopDaemon(daemon: Daemon): Promise<void> {
  if (daemon.child.exitCode === null && daemon.child.signalCode === null) {
    daemon.child.kill("SIGTERM");
    const stopped = await Promise.race([daemon.exited.then(() => true), sleep(STOP_MS).then(() => false)]);
    if (!stopped) daemon.child.kill("SIGKILL");
  }
  await rm(daemon.dir, { recursive: true, force: true });
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
    // A private folder (0700) of its own: no other user can reach the socket.
    const dir = await mkdtemp(path.join(os.tmpdir(), "genex-cua-"));
    const socket = path.join(dir, SOCKET_NAME);
    // Spawned directly, never through `open`: that would hand it to LaunchServices and out of the chain.
    const child = spawn(driver.command, [...driver.args, "serve", "--embedded", "--socket", socket], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
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
    const daemon: Daemon = { child, dir, socket, exited, ended: () => ended };
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
