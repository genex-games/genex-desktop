/**
 * A Python 3 on this machine's PATH, for tests that run Python the product runs inside Unreal or
 * with Unreal's own interpreter. It is `python3` on a Mac or Linux and usually `python` on Windows,
 * where `python3` may be the Store's placeholder that only opens the Store.
 */
import { spawnSync } from "node:child_process";

/** The names a Python 3 goes by, in the order they are tried. */
const PYTHON_NAMES = ["python3", "python"] as const;

/** A Python 3 found on PATH: the name it runs by and its version. */
export type FoundPython = { command: string; version: [number, number] };

/** The first of `python3` and `python` that runs and is Python 3, or undefined. */
export function findPython3(): FoundPython | undefined {
  for (const command of PYTHON_NAMES) {
    const probe = spawnSync(command, ["-c", "import sys; print(sys.version_info[0], sys.version_info[1])"], {
      encoding: "utf8",
    });
    if (probe.status !== 0) continue;
    const [major = 0, minor = 0] = probe.stdout.trim().split(" ").map(Number);
    if (major === 3) return { command, version: [major, minor] };
  }
  return undefined;
}
