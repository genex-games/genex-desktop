/**
 * A Roblox game's cover for Roblox itself: Studio's viewport made into the game icon (512 × 512)
 * and a thumbnail (1920 × 1080), the sizes Roblox's Creator Hub takes. Each is the picture's
 * centred crop to its shape, scaled with what the system already has: `sips` on a Mac,
 * PowerShell's System.Drawing on Windows. Both go in the game's `.genex/roblox-cover/`, which the
 * agent uploads from on the game's Creator Hub page: Roblox takes a game's icon through no API that works
 * without the person's own keys, which Genex never asks for. The viewport's picture waits in a
 * private temporary folder, removed after; the cover folder is the game's own, never one a link
 * leads out of, and a picture that is a link is replaced, never written through.
 */
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { envValue } from "../../substrate/toolchain.ts";
import { bytesSource, imageSize } from "./asset-gate.ts";
import { COVER_PROMPTS } from "./cover-prompts.ts";

/** How long one step of making a picture may take. */
const MAKE_TIMEOUT_MS = 20 * SECOND_MS;
/** How long Studio has to take the viewport's picture. */
const COVER_SHOT_MS = 15 * SECOND_MS;
const SIPS = "/usr/bin/sips";
const WINDOWS_ROOT = "C:\\Windows";
/** The variables PowerShell reads its paths and size from, so no path is ever part of a command. */
const COVER_IN = "GENEX_COVER_IN";
const COVER_OUT = "GENEX_COVER_OUT";
const COVER_WIDTH = "GENEX_COVER_WIDTH";
const COVER_HEIGHT = "GENEX_COVER_HEIGHT";

/** Where in a game folder the cover's pictures go. */
export const COVER_FOLDER = path.join(".genex", "roblox-cover");

/** The cover's pictures, by file name. Wire values: never rename. */
export const CoverPicture = { Icon: "icon", Thumbnail: "thumbnail" } as const;
export type CoverPicture = (typeof CoverPicture)[keyof typeof CoverPicture];

/** A picture's size in pixels. */
export interface PictureSize {
  width: number;
  height: number;
}

/** The size Roblox's Creator Hub takes for each picture. */
export const COVER_SIZES = {
  [CoverPicture.Icon]: { width: 512, height: 512 },
  [CoverPicture.Thumbnail]: { width: 1920, height: 1080 },
} as const satisfies Record<CoverPicture, PictureSize>;

const MESSAGE = {
  notPicture: "Studio's picture is neither a PNG nor a JPEG",
  notOwnFolder: (part: string) => `${part} in the game folder isn't a plain folder`,
} as const;

/** PowerShell's crop and scale: the centred crop to the asked shape, drawn at the asked size, saved as a PNG. */
const POWERSHELL_COVER = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Drawing",
  `$image = [System.Drawing.Image]::FromFile($env:${COVER_IN})`,
  `$width = [int]$env:${COVER_WIDTH}`,
  `$height = [int]$env:${COVER_HEIGHT}`,
  "$scale = [Math]::Min($image.Width / $width, $image.Height / $height)",
  "$cropWidth = [int]($width * $scale)",
  "$cropHeight = [int]($height * $scale)",
  "$left = [int](($image.Width - $cropWidth) / 2)",
  "$top = [int](($image.Height - $cropHeight) / 2)",
  "$from = New-Object System.Drawing.Rectangle($left, $top, $cropWidth, $cropHeight)",
  "$to = New-Object System.Drawing.Rectangle(0, 0, $width, $height)",
  "$bitmap = New-Object System.Drawing.Bitmap($width, $height)",
  "$graphics = [System.Drawing.Graphics]::FromImage($bitmap)",
  "$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic",
  "$graphics.DrawImage($image, $to, $from, [System.Drawing.GraphicsUnit]::Pixel)",
  `$bitmap.Save($env:${COVER_OUT}, [System.Drawing.Imaging.ImageFormat]::Png)`,
  "$graphics.Dispose()",
  "$bitmap.Dispose()",
  "$image.Dispose()",
].join("; ");

/** The centred crop of a `from` picture to the shape of `to`. */
export function centredCrop(from: PictureSize, to: PictureSize): PictureSize {
  const wider = from.width * to.height > from.height * to.width;
  if (wider) return { width: Math.round((from.height * to.width) / to.height), height: from.height };
  return { width: from.width, height: Math.round((from.width * to.height) / to.width) };
}

/** One step of making a picture: a program, its arguments and the environment it adds. */
export interface CoverCommand {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** The steps that make the picture `output` of `size` from `input`, a picture of `from` pixels, on `platform`. */
export function coverCommands(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  from: PictureSize,
  size: PictureSize,
  input: string,
  output: string,
): CoverCommand[] {
  if (platform === "win32") {
    const root = envValue(env, "SystemRoot") || WINDOWS_ROOT;
    const powershell = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const vars = {
      [COVER_IN]: input,
      [COVER_OUT]: output,
      [COVER_WIDTH]: String(size.width),
      [COVER_HEIGHT]: String(size.height),
    };
    return [{ file: powershell, args: ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_COVER], env: vars }];
  }
  const crop = centredCrop(from, size);
  // sips crops about the centre and writes a PNG whatever came in, then scales that PNG in place.
  const cropped = ["-s", "format", "png", "-c", String(crop.height), String(crop.width), input, "--out", output];
  return [
    { file: SIPS, args: cropped, env: {} },
    { file: SIPS, args: ["-z", String(size.height), String(size.width), output], env: {} },
  ];
}

/** Runs a program to its end with extra environment; rejects when it fails. */
export type CoverRun = (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<void>;

const execRun: CoverRun = (file, args, extra) =>
  new Promise((resolve, reject) => {
    const options = { timeout: MAKE_TIMEOUT_MS, windowsHide: true, env: { ...process.env, ...extra } };
    execFile(file, [...args], options, (error) => (error ? reject(error) : resolve()));
  });

/** The game's cover folder, made where missing; refused when any part of it is a link or a file. */
async function coverFolder(game: string): Promise<string> {
  let at = game;
  for (const part of COVER_FOLDER.split(path.sep)) {
    at = path.join(at, part);
    const info = await lstat(at).catch(() => null);
    if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error(MESSAGE.notOwnFolder(part));
    if (!info) await mkdir(at);
  }
  return at;
}

/**
 * The game's cover from `picture` (Studio's PNG or JPEG): each picture made in the game's cover
 * folder; the paths answered by picture.
 */
export async function makeCover(
  picture: Buffer,
  game: string,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; run?: CoverRun } = {},
): Promise<Record<CoverPicture, string>> {
  const from = await imageSize(bytesSource(picture));
  if (!from) throw new Error(MESSAGE.notPicture);
  const folder = await coverFolder(game);
  const dir = await mkdtemp(path.join(os.tmpdir(), "genex-roblox-cover-"));
  try {
    const input = path.join(dir, `viewport.${from.format}`);
    await writeFile(input, picture, { mode: 0o600 });
    const made = {} as Record<CoverPicture, string>;
    for (const name of Object.values(CoverPicture)) {
      const output = path.join(folder, `${name}.png`);
      // A link there is replaced, never written through.
      await rm(output, { force: true });
      const steps = coverCommands(
        options.platform ?? process.platform,
        options.env ?? process.env,
        from,
        COVER_SIZES[name],
        input,
        output,
      );
      for (const step of steps) await (options.run ?? execRun)(step.file, step.args, step.env);
      made[name] = output;
    }
    return made;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** What `cover-pictures` reads of its game: whether Studio is connected, its viewport and the folder. */
export interface CoverDeps {
  bound: () => boolean;
  shot: (timeoutMs: number) => Promise<{ data: string } | null>;
  folder: string | undefined;
  make: (picture: Buffer, folder: string) => Promise<Record<CoverPicture, string>>;
}

/** `cover-pictures`: the game's cover from Studio's viewport now, in the agent's words. */
export async function coverPictures(deps: CoverDeps): Promise<string> {
  if (!deps.folder) return COVER_PROMPTS.NoFolder;
  if (!deps.bound()) return COVER_PROMPTS.Unbound;
  const shot = await deps.shot(COVER_SHOT_MS).catch(() => null);
  if (!shot) return COVER_PROMPTS.NoShot;
  try {
    const made = await deps.make(Buffer.from(shot.data, "base64"), deps.folder);
    const icon = made[CoverPicture.Icon];
    return COVER_PROMPTS.Made(path.dirname(icon), path.basename(icon), path.basename(made[CoverPicture.Thumbnail]));
  } catch (error) {
    return COVER_PROMPTS.NotMade(errorMessage(error));
  }
}
