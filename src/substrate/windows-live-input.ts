/**
 * A long-lived process's live input on Windows.
 *
 * srt-win does not pass a sandboxed process's stdin through, and a one-time input file cannot carry
 * a conversation (the Play Protocol's requests). So the command is started under a small relay, run
 * by the studio's own Node inside the same sandbox: the relay listens on a loopback port the host
 * picked (host to sandbox loopback is allowed; sandbox to host is not), starts the command under
 * Git Bash with its stdin piped, and hands it everything the host sends after a one-time token.
 * The command's stdout and stderr are the relay's, so they reach the host as before. The relay
 * exits with the command; a connection with any other first line is dropped and never heard.
 */
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { HarnessInbox } from "./harness-inbox.ts";

/** The variables the relay reads its port, token, shell and command from, removed before the command starts. */
export const LiveInputEnv = {
  Port: "GENEX_INPUT_PORT",
  Token: "GENEX_INPUT_TOKEN",
  Shell: "GENEX_INPUT_SHELL",
  Command: "GENEX_INPUT_COMMAND",
} as const;
export type LiveInputEnv = (typeof LiveInputEnv)[keyof typeof LiveInputEnv];

/**
 * The relay, run as CommonJS by Node (or Electron as Node). It deletes its own file first, takes
 * the first connection whose first line is the token, and stops listening once it has one.
 */
const RELAY_SOURCE = `"use strict";
const fs = require("node:fs");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { timingSafeEqual } = require("node:crypto");
try { fs.rmSync(__filename, { force: true }); } catch {}
const env = { ...process.env };
const take = (name) => { const value = env[name] ?? ""; delete env[name]; return value; };
const port = Number(take(${JSON.stringify(LiveInputEnv.Port)}));
const token = Buffer.from(take(${JSON.stringify(LiveInputEnv.Token)}));
const shell = take(${JSON.stringify(LiveInputEnv.Shell)});
const command = take(${JSON.stringify(LiveInputEnv.Command)});
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(shell, ["-c", command], { env, stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
child.stdin.on("error", () => {});
child.on("error", (error) => { process.stderr.write(String(error) + "\\n"); process.exit(127); });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
let taken = false;
const server = net.createServer((socket) => {
  socket.on("error", () => {});
  if (taken) { socket.destroy(); return; }
  let head = Buffer.alloc(0);
  const onData = (chunk) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf(10);
    if (end === -1) { if (head.length > token.length + 2) socket.destroy(); return; }
    const line = head.subarray(0, end).toString().replace(/\\r$/, "");
    const given = Buffer.from(line);
    if (taken || given.length !== token.length || !timingSafeEqual(given, token)) { socket.destroy(); return; }
    taken = true;
    server.close();
    socket.off("data", onData);
    const rest = head.subarray(end + 1);
    if (rest.length) child.stdin.write(rest);
    socket.pipe(child.stdin);
  };
  socket.on("data", onData);
});
server.listen(port, "127.0.0.1");
`;

/** One process's relay: its file, its variables, and the host's end of its input. */
export interface LiveInput {
  /** The relay's file, for the studio's own Node to run with `ELECTRON_RUN_AS_NODE` set. */
  file: string;
  /** The relay's variables, for the run's environment. */
  env: Record<LiveInputEnv, string>;
  /** The host's end: everything written reaches the command's stdin once the relay answers. */
  input: Writable;
  /** Reach the relay for as long as `alive()` holds; resolves whether it was reached. */
  connect(alive: () => boolean): Promise<boolean>;
  /** Drop the connection and remove the relay's file, if it never ran. */
  close(): Promise<void>;
}

/**
 * Prepare a relay that starts `command` under `shell`, its file written in `scratchDir` (the
 * sandbox reads and writes it; the relay deletes it as it starts).
 */
export async function openLiveInput(options: {
  command: string;
  shell: string;
  scratchDir: string;
}): Promise<LiveInput> {
  const inbox = await HarnessInbox.open();
  const file = path.join(options.scratchDir, `.input-relay-${randomUUID()}.cjs`);
  await writeFile(file, RELAY_SOURCE, { mode: 0o600 });
  const input = new Writable({
    write(chunk: Buffer, _encoding, done) {
      inbox.write(chunk.toString("utf8"));
      done();
    },
    final(done) {
      inbox.end();
      done();
    },
    destroy(error, done) {
      inbox.close();
      done(error);
    },
  });
  return {
    file,
    env: {
      [LiveInputEnv.Port]: String(inbox.port),
      [LiveInputEnv.Token]: inbox.token,
      [LiveInputEnv.Shell]: options.shell,
      [LiveInputEnv.Command]: options.command,
    },
    input,
    connect: (alive) => inbox.connect(alive),
    close: async () => {
      inbox.close();
      await rm(file, { force: true });
    },
  };
}
