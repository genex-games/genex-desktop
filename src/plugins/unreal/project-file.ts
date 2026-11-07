/** What an Unreal project file is, the one rule every Unreal module shares. */
import path from "node:path";

/** An Unreal project file's extension, compared without case. */
export const UPROJECT_EXTENSION = ".uproject";

/** Whether a value is an absolute path to a `.uproject`, by the path rules of `platform` (this computer's unless named). */
export function isProjectPath(file: unknown, platform: NodeJS.Platform = process.platform): file is string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  return typeof file === "string" && paths.isAbsolute(file) && paths.extname(file).toLowerCase() === UPROJECT_EXTENSION;
}

/** A project's name: its `.uproject` file's name without the extension. */
export function projectName(file: string): string {
  return path.basename(file, path.extname(file));
}
