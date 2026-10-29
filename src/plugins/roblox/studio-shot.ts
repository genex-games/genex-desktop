/**
 * Shrinks a Studio picture that is over the 1 MB a tool answer may carry, with what the system
 * already has: `sips` on a Mac, PowerShell's System.Drawing on Windows. No image library ships with
 * Genex for this. The picture goes through a private temporary folder, which is removed after;
 * PowerShell reads both paths from its environment, so no path is ever part of a command.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SECOND_MS } from "../../shared/duration.ts";
import { envValue } from "../../substrate/toolchain.ts";

/** The longest edge a shrunk picture keeps, in pixels. */
const SHRUNK_EDGE_PX = 1280;
/** The JPEG quality a shrunk picture is saved at, 0–100. */
const SHRUNK_QUALITY = 70;
/** How long a shrink may take. */
const SHRINK_TIMEOUT_MS = 20 * SECOND_MS;
const SIPS = "/usr/bin/sips";
const WINDOWS_ROOT = "C:\\Windows";
/** The variables PowerShell reads the two paths from. */
const SHOT_IN = "GENEX_SHOT_IN";
const SHOT_OUT = "GENEX_SHOT_OUT";

/** PowerShell's shrink: scale the longest edge down, save as JPEG at the set quality. */
const POWERSHELL_SHRINK = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Drawing",
  `$image = [System.Drawing.Image]::FromFile($env:${SHOT_IN})`,
  `$scale = [Math]::Min(1.0, ${SHRUNK_EDGE_PX} / [Math]::Max($image.Width, $image.Height))`,
  "$width = [int][Math]::Max(1, $image.Width * $scale)",
  "$height = [int][Math]::Max(1, $image.Height * $scale)",
  "$bitmap = New-Object System.Drawing.Bitmap($image, $width, $height)",
  "$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }",
  "$params = New-Object System.Drawing.Imaging.EncoderParameters(1)",
  `$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]${SHRUNK_QUALITY})`,
  `$bitmap.Save($env:${SHOT_OUT}, $codec, $params)`,
  "$bitmap.Dispose()",
  "$image.Dispose()",
].join("; ");

/** A picture made smaller: JPEG bytes in, JPEG bytes out; rejects when it can't. */
export type ShrinkShot = (jpeg: Buffer) => Promise<Buffer>;

/** Runs a program to its end with extra environment; rejects when it fails. */
export type ShrinkRun = (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<void>;

/** The command a shrink runs on `platform`, its arguments and extra environment. */
export function shrinkCommand(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  input: string,
  output: string,
): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (platform === "win32") {
    const root = envValue(env, "SystemRoot") || WINDOWS_ROOT;
    const powershell = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const args = ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_SHRINK];
    return { file: powershell, args, env: { [SHOT_IN]: input, [SHOT_OUT]: output } };
  }
  const args = ["-s", "format", "jpeg", "-s", "formatOptions", String(SHRUNK_QUALITY), "-Z", String(SHRUNK_EDGE_PX)];
  return { file: SIPS, args: [...args, input, "--out", output], env: {} };
}

/** A shrink on this computer, through `run` (execFile by default). */
export function systemShrink(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  run: ShrinkRun = execRun,
): ShrinkShot {
  return async (jpeg) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "genex-roblox-shot-"));
    try {
      const input = path.join(dir, "shot.jpeg");
      const output = path.join(dir, "small.jpeg");
      await writeFile(input, jpeg, { mode: 0o600 });
      const command = shrinkCommand(platform, env, input, output);
      await run(command.file, command.args, command.env);
      return await readFile(output);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

const execRun: ShrinkRun = (file, args, extra) =>
  new Promise((resolve, reject) => {
    const options = { timeout: SHRINK_TIMEOUT_MS, windowsHide: true, env: { ...process.env, ...extra } };
    execFile(file, [...args], options, (error) => (error ? reject(error) : resolve()));
  });
