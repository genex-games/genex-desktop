/**
 * Where Windows PowerShell's start goes, measured on a Windows machine (diagnostic): a cold and a warm
 * launch, a command with stdin closed and left open, `-EncodedCommand` with and without
 * `-InputFormat None`, and the window probe's own stages under each way of handing it over.
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { describe, it } from "node:test";
import { driverEnv } from "../../src/substrate/cua-driver-client.ts";
import { WINDOW_PROBE_SCRIPT, windowsPowerShell } from "../../src/substrate/windows-window-probe.ts";

const WINDOWS_ONLY = { skip: process.platform !== "win32" && "measures Windows PowerShell" };
const BASE = ["-NoLogo", "-NoProfile", "-NonInteractive"];
const encoded = (script: string) => Buffer.from(script, "utf16le").toString("base64");

/** Start PowerShell and time its first `lines` lines; stdin is closed at once or left open. */
function timed(args: string[], options: { closeStdin: boolean; lines: number; timeoutMs?: number }) {
  const began = Date.now();
  const child = spawn(windowsPowerShell(process.env), args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: driverEnv(),
  });
  child.stdin.on("error", () => {});
  if (options.closeStdin) child.stdin.end();
  let said = "";
  child.stderr.on("data", (chunk: Buffer) => {
    said += chunk.toString();
  });
  const seen: Array<[number, string]> = [];
  return new Promise<{ seen: Array<[number, string]>; timedOut: boolean; said: string }>((resolve) => {
    const done = (timedOut: boolean) => {
      clearTimeout(timer);
      child.kill();
      resolve({ seen, timedOut, said: said.trim().slice(0, 300) });
    };
    const timer = setTimeout(() => done(true), options.timeoutMs ?? 90_000);
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      seen.push([Date.now() - began, line.slice(0, 100)]);
      if (seen.length >= options.lines) done(false);
    });
    child.once("exit", () => setTimeout(() => done(false), 200));
  });
}

describe("where Windows PowerShell's start goes", () => {
  it("measures each way of starting it", WINDOWS_ONLY, async () => {
    const hello = "[Console]::Out.WriteLine('hello'); [Console]::Out.Flush()";
    const dir = await mkdtemp(path.join(os.tmpdir(), "ps-start-"));
    const file = path.join(dir, "probe.ps1");
    await writeFile(file, WINDOW_PROBE_SCRIPT);
    const runs: Array<[string, string[], { closeStdin: boolean; lines: number }]> = [
      ["cold -Command, stdin closed", [...BASE, "-Command", hello], { closeStdin: true, lines: 1 }],
      ["warm -Command, stdin closed", [...BASE, "-Command", hello], { closeStdin: true, lines: 1 }],
      ["-Command, stdin open", [...BASE, "-Command", hello], { closeStdin: false, lines: 1 }],
      ["-EncodedCommand, stdin open", [...BASE, "-EncodedCommand", encoded(hello)], { closeStdin: false, lines: 1 }],
      [
        "-InputFormat None -EncodedCommand, stdin open",
        [...BASE, "-InputFormat", "None", "-EncodedCommand", encoded(hello)],
        { closeStdin: false, lines: 1 },
      ],
      [
        "probe: -EncodedCommand, stdin open",
        [...BASE, "-EncodedCommand", encoded(WINDOW_PROBE_SCRIPT)],
        { closeStdin: false, lines: 3 },
      ],
      [
        "probe: -InputFormat None -EncodedCommand, stdin open",
        [...BASE, "-InputFormat", "None", "-EncodedCommand", encoded(WINDOW_PROBE_SCRIPT)],
        { closeStdin: false, lines: 3 },
      ],
      [
        "probe: -File, stdin open",
        [...BASE, "-ExecutionPolicy", "Bypass", "-File", file],
        { closeStdin: false, lines: 3 },
      ],
      [
        "probe again: -InputFormat None -EncodedCommand, stdin open",
        [...BASE, "-InputFormat", "None", "-EncodedCommand", encoded(WINDOW_PROBE_SCRIPT)],
        { closeStdin: false, lines: 3 },
      ],
    ];
    for (const [name, args, options] of runs) {
      const result = await timed(args, options);
      console.log(`PSSTART ${JSON.stringify({ name, ...result })}`);
    }
  });
});
