/**
 * A creator's Mac app signed and notarized under their own Apple Developer ID before Publish sends it,
 * so it opens from a download without macOS's "Apple could not verify" wall. Genex never signs with an
 * identity of its own and holds no Apple secret:
 * - the certificate is the creator's "Developer ID Application" identity in their login keychain;
 * - Apple's notary is reached through the keychain profile they stored once with
 *   `xcrun notarytool store-credentials` (named in the Genex plugin's settings).
 *
 * Every Mach-O program inside the app is signed (hardened runtime, secure timestamp), deepest
 * first, then the app. A zip of it goes to Apple's notary and waits for its answer, and the ticket is
 * stapled to the app. Each step runs a system tool by its full path, with no shell. A step that fails
 * says why by code and stops there: the app then goes as it was built (ad hoc), as it does for a
 * creator who chose no notarization.
 */
import { execFile } from "node:child_process";
import { lstat, mkdtemp, open, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MINUTE_MS } from "../../shared/duration.ts";
import { type GenexNativeSent, MacNotarizeFailure } from "../../shared/genex.ts";

/** The plugin's settings for notarizing: whether to, with which identity, and through which notary profile. */
export const MacSigningSetting = {
  Notarize: "mac-notarize",
  Identity: "mac-signing-identity",
  NotaryProfile: "mac-notary-profile",
} as const;
export type MacSigningSetting = (typeof MacSigningSetting)[keyof typeof MacSigningSetting];

/** The keychain profile name the setup tells creators to store, used when the setting is empty. */
export const DEFAULT_NOTARY_PROFILE = "genex-notary";

const FAILURES: ReadonlySet<string> = new Set(Object.values(MacNotarizeFailure));
/** Whether `value` is a failure's code rather than an identity's name. */
const isFailure = (value: string): value is MacNotarizeFailure => FAILURES.has(value);

/** How long one signing step may take. */
const SIGN_TIMEOUT_MS = 5 * MINUTE_MS;
/** How long Apple's notary may take to answer: usually minutes, at worst much longer. */
const NOTARY_TIMEOUT_MS = 45 * MINUTE_MS;
/** The most programs a bundle is searched for, and the deepest folder: an app is not a whole disk. */
const MAX_BUNDLE_ENTRIES = 50_000;

const SECURITY = "/usr/bin/security";
const CODESIGN = "/usr/bin/codesign";
const DITTO = "/usr/bin/ditto";
const XCRUN = "/usr/bin/xcrun";

/** The first four bytes of a Mach-O program: 32- and 64-bit in either order, and a universal one. */
const MACH_O_MAGICS: ReadonlySet<string> = new Set([
  "feedface",
  "feedfacf",
  "cefaedfe",
  "cffaedfe",
  "cafebabe",
  "bebafeca",
]);
/** A Developer ID Application identity as `security find-identity` lists it. */
const DEVELOPER_ID = /"(Developer ID Application: [^"]+)"/;
/** The notary's answer for an accepted submission. */
const ACCEPTED = "Accepted";

/** One run of a system tool: its exit code and what it printed. */
export type NotarizeRun = (
  file: string,
  args: readonly string[],
  options: { signal: AbortSignal; timeoutMs: number },
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** What notarizing needs from the computer. */
export interface NotarizeDeps {
  run: NotarizeRun;
}

/** The creator's choice in the plugin's settings: the identity (empty: the keychain's only one) and the profile. */
export interface MacSigning {
  identity: string;
  profile: string;
}

/** A setting that names something: text that isn't empty and can't read as an option. */
const nameIn = (value: unknown): string => {
  const name = typeof value === "string" ? value.trim() : "";
  return name.startsWith("-") ? "" : name;
};

/**
 * The creator's notarizing as the plugin's settings hold it, or null unless they turned it on: their
 * identity (empty: the keychain's only one) and their notary profile ({@link DEFAULT_NOTARY_PROFILE}
 * when they named none).
 */
export function macSigningOf(settings: Record<string, unknown>): MacSigning | null {
  if (settings[MacSigningSetting.Notarize] !== true) return null;
  return {
    identity: nameIn(settings[MacSigningSetting.Identity]),
    profile: nameIn(settings[MacSigningSetting.NotaryProfile]) || DEFAULT_NOTARY_PROFILE,
  };
}

/** The most a tool's output is kept: an identity list or the notary's answer is small. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** A finished tool's exit code: 0 when it succeeded, its own code when it failed, null when it never exited. */
function exitCodeOf(error: { code?: unknown } | null): number | null {
  if (!error) return 0;
  return typeof error.code === "number" ? error.code : null;
}

/** The computer's runner: the tool by its full path, no shell, its own deadline, stopped with `signal`. */
export const systemNotarizeRun: NotarizeRun = (file, args, { signal, timeoutMs }) =>
  new Promise((resolve) => {
    execFile(file, [...args], { signal, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout, stderr) => {
      resolve({ code: exitCodeOf(error), stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** What became of notarizing one app. */
export type NotarizeOutcome = { notarized: true; identity: string } | { failure: MacNotarizeFailure };

/** The Developer ID Application identities in `security find-identity -v -p codesigning` output. */
export function developerIds(output: string): string[] {
  return output
    .split("\n")
    .map((line) => DEVELOPER_ID.exec(line)?.[1])
    .filter((name): name is string => typeof name === "string");
}

/** The identity to sign with: `wanted` when the keychain has it, else the keychain's only one; why not otherwise. */
export function pickIdentity(found: readonly string[], wanted: string): string | MacNotarizeFailure {
  if (wanted) return found.includes(wanted) ? wanted : MacNotarizeFailure.NoIdentity;
  if (found.length > 1) return MacNotarizeFailure.ManyIdentities;
  return found[0] ?? MacNotarizeFailure.NoIdentity;
}

/** Whether `file` starts as a Mach-O program does. */
async function isMachO(file: string): Promise<boolean> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return false;
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(4), 0, 4, 0);
    return bytesRead === 4 && MACH_O_MAGICS.has(buffer.toString("hex"));
  } finally {
    await handle.close();
  }
}

/** The Mach-O programs inside the bundle `app`, deepest first, never through a link. */
export async function machOFiles(app: string): Promise<string[]> {
  const found: Array<{ file: string; depth: number }> = [];
  const pending: Array<{ dir: string; depth: number }> = [{ dir: app, depth: 0 }];
  let seen = 0;
  for (let next = pending.pop(); next && seen < MAX_BUNDLE_ENTRIES; next = pending.pop()) {
    const entries = await readdir(next.dir, { withFileTypes: true }).catch(() => []);
    seen += entries.length;
    for (const entry of entries) {
      const at = path.join(next.dir, entry.name);
      if (entry.isDirectory()) pending.push({ dir: at, depth: next.depth + 1 });
      else if (entry.isFile() && (await isMachO(at))) found.push({ file: at, depth: next.depth + 1 });
    }
  }
  return found.sort((a, b) => b.depth - a.depth || a.file.localeCompare(b.file)).map((entry) => entry.file);
}

/** codesign's words for one file: forced, hardened runtime, Apple's secure timestamp, the creator's identity. */
const signArgs = (identity: string, file: string): string[] => [
  "--force",
  "--options",
  "runtime",
  "--timestamp",
  "--sign",
  identity,
  file,
];

/** Whether `app` is a Mac app bundle in a plain folder: absolute, named `.app`, a real folder, never a link. */
async function isAppBundle(app: string): Promise<boolean> {
  if (!path.isAbsolute(app) || !app.toLowerCase().endsWith(".app")) return false;
  const info = await lstat(app).catch(() => null);
  return info?.isDirectory() === true && !info.isSymbolicLink();
}

/** The notary's status out of `notarytool submit --output-format json`, or null when it isn't Apple's answer. */
function notaryStatus(stdout: string): string | null {
  try {
    const answer: unknown = JSON.parse(stdout);
    const status = typeof answer === "object" && answer !== null ? (answer as { status?: unknown }).status : null;
    return typeof status === "string" ? status : null;
  } catch {
    return null;
  }
}

/** Signs every program inside `app`, then `app`; false at the first one codesign refuses. */
async function signAll(app: string, identity: string, deps: NotarizeDeps, signal: AbortSignal): Promise<boolean> {
  for (const file of [...(await machOFiles(app)), app]) {
    const signed = await deps.run(CODESIGN, signArgs(identity, file), { signal, timeoutMs: SIGN_TIMEOUT_MS });
    if (signed.code !== 0) return false;
  }
  return true;
}

/** Sends a zip of the signed `app` to Apple's notary through `profile` and waits; why not when it isn't accepted. */
async function submit(
  app: string,
  profile: string,
  deps: NotarizeDeps,
  signal: AbortSignal,
): Promise<MacNotarizeFailure | null> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "genex-notarize-"));
  try {
    const zip = path.join(scratch, `${path.basename(app, ".app")}.zip`);
    const zipped = await deps.run(DITTO, ["-c", "-k", "--keepParent", app, zip], {
      signal,
      timeoutMs: SIGN_TIMEOUT_MS,
    });
    if (zipped.code !== 0) return MacNotarizeFailure.Submit;
    const args = ["notarytool", "submit", zip, "--keychain-profile", profile, "--wait", "--output-format", "json"];
    const answer = await deps.run(XCRUN, args, { signal, timeoutMs: NOTARY_TIMEOUT_MS });
    const status = answer.code === 0 ? notaryStatus(answer.stdout) : null;
    if (status === null) return MacNotarizeFailure.Submit;
    return status === ACCEPTED ? null : MacNotarizeFailure.Rejected;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Sign `app` with the creator's Developer ID (`signing.identity`, else the keychain's only one),
 * notarize it through their stored profile (`signing.profile`, else {@link DEFAULT_NOTARY_PROFILE})
 * and staple the ticket. Answers the identity it went under, or why it stopped.
 */
export async function notarizeMacApp(
  app: string,
  signing: MacSigning,
  deps: NotarizeDeps,
  signal: AbortSignal,
): Promise<NotarizeOutcome> {
  if (!(await isAppBundle(app))) return { failure: MacNotarizeFailure.NotAnApp };
  if (signal.aborted) return { failure: MacNotarizeFailure.Stopped };
  const listed = await deps.run(SECURITY, ["find-identity", "-v", "-p", "codesigning"], {
    signal,
    timeoutMs: SIGN_TIMEOUT_MS,
  });
  const identity = pickIdentity(developerIds(listed.stdout), signing.identity.trim());
  if (isFailure(identity)) return { failure: identity };
  if (!(await signAll(app, identity, deps, signal))) return { failure: MacNotarizeFailure.Sign };
  const refused = await submit(app, signing.profile.trim() || DEFAULT_NOTARY_PROFILE, deps, signal);
  if (refused) return { failure: signal.aborted ? MacNotarizeFailure.Stopped : refused };
  const stapled = await deps.run(XCRUN, ["stapler", "staple", app], { signal, timeoutMs: SIGN_TIMEOUT_MS });
  if (stapled.code !== 0) return { failure: MacNotarizeFailure.Staple };
  return { notarized: true, identity };
}

/** `sent` as the record keeps it: notarized, or why notarizing the creator asked for did not happen. */
export function withNotarizing(sent: GenexNativeSent, outcome: NotarizeOutcome | null): GenexNativeSent {
  if (!outcome) return sent;
  return "notarized" in outcome ? { ...sent, notarized: true } : { ...sent, notarizeFailure: outcome.failure };
}
