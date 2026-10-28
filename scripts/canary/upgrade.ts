// Upgrade mode on a Windows machine (canary.yml `upgrade_from`): the owner installs an earlier
// release, whose first start sets the sandbox up for its own srt-win, then installs the build under
// test over it as an update. That build must ask for the sandbox's update on the card that says so,
// raise exactly one approval prompt for it, and come up on the updated sandbox with the earlier
// profile's games and kept grants. windows/uac-approver.ps1 approves each prompt as the owner at the
// desktop would, and writes one line per prompt; this module reads the app's log and those lines.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SECOND_MS } from "../../src/shared/duration.ts";
import { download, PackageKind, PUBLIC_LINKS, parseSha256Sums, releaseAssetUrl } from "./links.ts";
import type { Verdict } from "./platforms.ts";
import { StepOutcome } from "./results.ts";
import { powershell } from "./shell.ts";

/**
 * The setup screen's problem for a sandbox an earlier release set up: main logs `sandbox unavailable`
 * with the setup check's words (src/substrate/windows-sandbox.ts `MESSAGE.OtherRelease`), or with
 * srt-win's own when its `reinstall_required` comes first.
 */
const UPGRADE_PROBLEM =
  /\[main\] sandbox unavailable: not-provisioned[^\n]*(?:set up by another release|set up by a different release|reinstall)[^\n]*/i;
/** The line each approval prompt leaves in the evidence folder (windows/uac-approver.ps1). */
export const APPROVALS_FILE = "uac.jsonl";
/** What the run writes right before it presses Update, for the helper to turn prompting on. */
export const PROMPTS_ON_FILE = "prompts-on";
/** What the helper writes once Windows asks for each elevation. */
export const PROMPTS_SWITCHED_FILE = "prompts-switched";
/** The button the update card offers (src/renderer/words.ts `SANDBOX_SETUP_WORDS.windows.reinstall.update`). */
export const UPDATE_BUTTON = "Update";
/** The game the earlier release is given before its first start, so its kept grants cover one. */
export const SEEDED_GAME = "canary-kept-game";
/** Files in the seeded game's dependency tree: enough that a grant walking it takes a moment. */
const SEEDED_FILES = 2_000;
const SEEDED_FILES_PER_FOLDER = 100;
const CLICK_SCRIPT = path.join(import.meta.dirname, "windows", "click-button.ps1");

/** The update card's problem line in the log since the build's start, or null while there is none. */
export function upgradeCardLine(log: string): string | null {
  return UPGRADE_PROBLEM.exec(log)?.[0] ?? null;
}

/** One approval prompt the helper saw: when, how it was approved, and its screenshot's file name. */
export interface ApprovalPrompt {
  n: number;
  at: string;
  approved: string;
  shot: string;
}

/** The prompts in the helper's file, oldest first; a line that is not one is left out. */
export function readApprovals(text: string): ApprovalPrompt[] {
  const prompts: ApprovalPrompt[] = [];
  for (const raw of text.split(/\r?\n/)) {
    // Windows PowerShell's UTF-8 starts the file with a byte-order mark.
    const line = raw.replace(/^\uFEFF/, "");
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<ApprovalPrompt>;
      if (typeof parsed.at === "string" && typeof parsed.n === "number")
        prompts.push({
          n: parsed.n,
          at: parsed.at,
          approved: String(parsed.approved ?? ""),
          shot: String(parsed.shot ?? ""),
        });
    } catch {
      /* a line the helper was still writing */
    }
  }
  return prompts;
}

/** The prompts raised from `fromMs` to `toMs`: those the Update button's setup asked for. */
export function approvalsBetween(prompts: readonly ApprovalPrompt[], fromMs: number, toMs: number): ApprovalPrompt[] {
  return prompts.filter((prompt) => {
    const at = Date.parse(prompt.at);
    return at >= fromMs && at <= toMs;
  });
}

/**
 * One approval for the update, as a person approves one prompt; none or more fails. Without the
 * helper (`helperReady` false) Windows never asked: the update elevated without a prompt to count.
 */
export function approvalVerdict(prompts: readonly ApprovalPrompt[], helperReady = true): Verdict {
  if (!helperReady)
    return {
      outcome: StepOutcome.Fail,
      detail: "the approval helper was not running: Windows elevated the update without asking (approver-start.log)",
    };
  const said = prompts.map((prompt) => `#${prompt.n} at ${prompt.at} (${prompt.approved}, ${prompt.shot})`).join("; ");
  if (prompts.length === 1) return { outcome: StepOutcome.Pass, detail: `one approval prompt: ${said}` };
  return { outcome: StepOutcome.Fail, detail: `${prompts.length} approval prompts${said ? `: ${said}` : ""}` };
}

/** The earlier release's Windows installer, by its tag, checked against that release's SHA256SUMS. */
export async function fetchEarlierRelease(tag: string, dir: string): Promise<{ file: string; detail: string }> {
  const { asset } = PUBLIC_LINKS[PackageKind.Exe];
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, asset);
  const sums = parseSha256Sums(await (await fetch(releaseAssetUrl(tag, "SHA256SUMS"))).text());
  const got = await download(releaseAssetUrl(tag, asset), file);
  const expected = sums.get(asset);
  if (expected !== got.sha256)
    throw new Error(`${tag} ${asset} sha256 ${got.sha256}, SHA256SUMS says ${expected ?? "nothing"}`);
  return { file, detail: `${tag} ${asset} ${got.bytes} bytes sha256 ${got.sha256}` };
}

/**
 * A game in the earlier release's library before its first start: that start grants it with
 * Genex's own entries and denies its `.claude` folder, which the build under test finds on disk.
 */
export async function seedGame(userData: string): Promise<string> {
  const game = path.join(userData, "workspaces", "games", SEEDED_GAME);
  await mkdir(path.join(game, ".claude"), { recursive: true });
  await writeFile(path.join(game, "index.html"), "<!doctype html><title>Kept</title><canvas></canvas>\n");
  await writeFile(path.join(game, ".claude", "settings.json"), "{}\n");
  for (let index = 0; index < SEEDED_FILES; index++) {
    const folder = path.join(game, "node_modules", `pkg-${Math.floor(index / SEEDED_FILES_PER_FOLDER)}`);
    if (index % SEEDED_FILES_PER_FOLDER === 0) await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, `module-${index}.js`), `module.exports = ${index};\n`);
  }
  return game;
}

/** Press the button named `name` in Genex's window through UI Automation, within `timeoutMs`. */
export async function pressButton(name: string, timeoutMs: number): Promise<Verdict> {
  const script = await readFile(CLICK_SCRIPT, "utf8");
  const ran = await powershell(script, { name, seconds: String(Math.round(timeoutMs / SECOND_MS)) });
  const said = `${ran.stdout}${ran.stderr}`.trim();
  return ran.code === 0
    ? { outcome: StepOutcome.Pass, detail: said }
    : { outcome: StepOutcome.Fail, detail: said || `no "${name}" button in ${timeoutMs / SECOND_MS} s` };
}
