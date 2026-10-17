/**
 * Whether the browser suites can launch Playwright's Chromium headless without downloading one.
 * A headless launch with no channel runs Playwright's headless shell
 * (`chromium_headless_shell-<revision>`, installed beside the full `chromium-<revision>`), so
 * either build of the revision the installed Playwright expects is enough.
 */
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";

/** The full build's revision folder in Playwright's executable path, and the folders above it. */
const REVISION_FOLDER = /^(.*[/\\])chromium-(\d+)[/\\]/;

/**
 * Whether the full Chromium at `executable` (Playwright's `chromium.executablePath()`) or the
 * headless shell of the same revision beside it is on disk.
 */
export function headlessChromiumOnDisk(
  executable: string,
  exists: (candidate: string) => boolean = existsSync,
): boolean {
  if (executable === "") return false;
  if (exists(executable)) return true;
  const revision = REVISION_FOLDER.exec(executable);
  return revision !== null && exists(`${revision[1]}chromium_headless_shell-${revision[2]}`);
}

/** Whether the installed Playwright's headless Chromium is on disk on this machine. */
export function playwrightHeadlessChromiumOnDisk(): boolean {
  let executable = "";
  try {
    executable = chromium.executablePath();
  } catch {
    executable = "";
  }
  return headlessChromiumOnDisk(executable);
}
