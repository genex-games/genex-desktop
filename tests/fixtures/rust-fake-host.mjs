// The fake host for the Rust protocol spike (M0a.3): starts a built genex-studio game the way
// `spawnGame` starts one (fd 3 piped as the fourth stdio slot, a process group of its own, an
// environment of exactly GENEX_STUDIO_FD, GENEX_STUDIO_NONCE, GENEX_STATE_DIR and HOME, stdin
// ignored), hands back the `GameChild` the host's `NativeGamePort` and `NativeRuns` take, and reads
// raw NDJSON off fd 3 for the rows the port itself would never send or accept.
//
//   const game = await startGame({ exe, args, nonce, stateDir });
//   const lines = lineReader(game.child.fd3);
//   await lines.next();            // the next line the game sent, parsed
//   groupAlive(game.pid);          // whether any process of the game's group is left
//
// No sandbox profile: the game box (ProcessSandbox.spawnGame) runs the Rust game in M0b.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Duplex } from "node:stream";

/** How long `lineReader().next()` waits for a line before it rejects. */
const LINE_WAIT_MS = 10_000;

/**
 * The game at `exe`, started with fd 3 as the protocol pipe in its own process group. Resolves
 * once it spawned: `{ child, pid, exited }`, where `child` is a `GameChild` whose `kill` signals
 * the whole group and nothing once the game was reaped.
 *
 * @param {{ exe: string, args?: string[], nonce: string, stateDir: string }} options
 * @returns {Promise<{ child: import("../../src/substrate/spawn.ts").GameChild, pid: number, exited: Promise<import("../../src/substrate/spawn.ts").GameExit> }>}
 */
export async function startGame({ exe, args = [], nonce, stateDir }) {
  await mkdir(path.join(stateDir, "home"), { recursive: true });
  const proc = spawn(exe, args, {
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    detached: true,
    env: {
      GENEX_STUDIO_FD: "3",
      GENEX_STUDIO_NONCE: nonce,
      GENEX_STATE_DIR: stateDir,
      HOME: path.join(stateDir, "home"),
    },
  });
  const exited = new Promise((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })));
  await once(proc, "spawn");
  proc.on("error", () => {});
  const fd3 = proc.stdio[3];
  const pid = proc.pid;
  if (!(fd3 instanceof Duplex) || pid === undefined) throw new Error("the game has no protocol pipe");
  // Once the game is reaped its pid can be reused: a later signal reaches nothing. A group whose
  // leader exited but is not reaped yet answers EPERM on macOS; the exit settles it the same way.
  const kill = (signal) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH" && error.code !== "EPERM") throw error;
    }
  };
  const child = { pid, fd3, stdout: proc.stdout, stderr: proc.stderr, exited, kill };
  return { child, pid, exited };
}

/**
 * Whether any process is left in process group `pgid` (an exited, reaped game leaves none).
 *
 * @param {number} pgid
 * @returns {boolean}
 */
export function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

/**
 * The lines a game writes on `stream`, parsed one by one as they arrive.
 *
 * @param {import("node:stream").Readable} stream
 * @returns {{ next(): Promise<Record<string, unknown>> }}
 */
export function lineReader(stream) {
  const lines = [];
  const waiting = [];
  let buffered = "";
  stream.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
      const text = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      const value = JSON.parse(text);
      const next = waiting.shift();
      if (next) next(value);
      else lines.push(value);
    }
  });
  return {
    /** The next line, parsed; rejects after `LINE_WAIT_MS` with none. */
    next() {
      const ready = lines.shift();
      if (ready !== undefined) return Promise.resolve(ready);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(settle), 1);
          reject(new Error("the game sent no line in time"));
        }, LINE_WAIT_MS);
        const settle = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
        waiting.push(settle);
      });
    },
  };
}
