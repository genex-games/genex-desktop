/**
 * The relay a long-lived Windows process's live input goes through (`substrate/windows-live-input.ts`):
 * only a connection that opens with the token is heard, the first one only, and what it sends
 * reaches the command's stdin byte for byte. Run outside the sandbox: the relay is plain Node.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { findGitBash } from "../../src/substrate/windows-sandbox.ts";
import { LiveInputEnv, openLiveInput } from "../../src/substrate/windows-live-input.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A pause long enough for a refused connection's bytes to have arrived, had they been heard. */
const SETTLE_MS = 200;

async function shell(): Promise<string> {
  if (process.platform !== "win32") return "/bin/bash";
  const bash = await findGitBash();
  assert.ok(bash, "the Windows runner has Git for Windows");
  return bash;
}

/** Start the relay over `command`, collecting the command's stdout. */
async function relay(command: string) {
  const scratchDir = await tmpDir("live-input-");
  const live = await openLiveInput({ command, shell: await shell(), scratchDir });
  const child = spawn(process.execPath, [live.file], {
    env: { ...process.env, ...live.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
  const port = Number(live.env[LiveInputEnv.Port]);
  return { live, child, exited, port, output: () => stdout };
}

/** One connection to the relay that sends `bytes` and stays open; null when nothing listens. */
function connectOnce(port: number, bytes: string): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.on("error", () => {});
      socket.write(bytes);
      resolve(socket);
    });
    socket.once("error", () => resolve(null));
  });
}

/** A connection to the relay as soon as it listens. */
async function rogue(port: number, bytes: string): Promise<net.Socket> {
  for (;;) {
    const socket = await connectOnce(port, bytes);
    if (socket) return socket;
    await delay(20);
  }
}

describe("the live input relay", () => {
  it("hands the command what the host writes after the token, byte for byte, and exits with it", async () => {
    const r = await relay("cat; exit 7");
    r.live.input.write("ünïcode line\n");
    r.live.input.write("second\n");
    assert.equal(await r.live.connect(() => r.child.exitCode === null), true);
    r.live.input.end();
    assert.equal(await r.exited, 7, "the relay exits with the command's code");
    assert.equal(r.output(), "ünïcode line\nsecond\n");
    assert.equal(existsSync(r.live.file), false, "the relay deleted its own file");
  });

  it("never lets a connection without the token reach the command, nor a second one once heard", async () => {
    const rows: Array<{ label: string; bytes: string }> = [
      { label: "a wrong token", bytes: 'not-the-token\n{"op":"evil"}\n' },
      { label: "no newline, then a flood", bytes: "x".repeat(4096) },
      { label: "an empty first line", bytes: '\n{"op":"evil"}\n' },
    ];
    for (const row of rows) {
      const r = await relay("cat");
      const socket = await rogue(r.port, row.bytes);
      await delay(SETTLE_MS);
      assert.equal(
        await r.live.connect(() => r.child.exitCode === null),
        true,
        `${row.label}: the host is still heard`,
      );
      r.live.input.write("from-the-host\n");
      const late = await connectOnce(r.port, `${r.live.env[LiveInputEnv.Token]}\nlate\n`);
      await delay(SETTLE_MS);
      r.live.input.end();
      await r.exited;
      socket.destroy();
      late?.destroy();
      assert.equal(r.output(), "from-the-host\n", `${row.label}: only the host's input arrived`);
    }
  });

  it("keeps the relay's variables out of the command's environment", async () => {
    const names = Object.values(LiveInputEnv).join(" ");
    const r = await relay(`for n in ${names} ELECTRON_RUN_AS_NODE; do printf '%s=%s;' "$n" "\${!n}"; done`);
    await r.live.connect(() => r.child.exitCode === null);
    r.live.input.end();
    await r.exited;
    const empty = [...Object.values(LiveInputEnv), "ELECTRON_RUN_AS_NODE"].map((n) => `${n}=;`).join("");
    assert.equal(r.output(), empty);
    assert.equal(path.isAbsolute(r.live.file), true);
  });
});
