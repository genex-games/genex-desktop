/** What an Unreal project file is, the one rule every Unreal module shares. */
import path from "node:path";

/** An Unreal project file's extension, compared without case. */
export const UPROJECT_EXTENSION = ".uproject";

/** Whether a value is an absolute path to a `.uproject`. */
export function isProjectPath(file: unknown): file is string {
  return typeof file === "string" && path.isAbsolute(file) && path.extname(file).toLowerCase() === UPROJECT_EXTENSION;
}

/** A project's name: its `.uproject` file's name without the extension. */
export function projectName(file: string): string {
  return path.basename(file, path.extname(file));
}
