/**
 * macOS and Linux: keeping the person's own Pi sign-in ahead of a session's copy of it.
 *
 * A session runs on a copy of Pi's sign-in (`pi-agent-view.ts`), and nothing is copied back. Pi
 * renews a subscription sign-in with five minutes left, and Anthropic and OpenAI take each refresh
 * token once: a renewal kept in a session's copy would leave the person's own file holding a spent
 * one, and Pi would say to sign in again. So before a session copies the file, the person's own Pi
 * renews a sign-in that would not outlast the session, on the host, writing its own file under its
 * own lock: `pi auth print-bearer-token --provider <id> --min-expiry <n>s` renews a sign-in with
 * less than that left and prints the token, which goes nowhere (stdout is closed to it). No
 * session opens, no extension loads and no model is called.
 *
 * Of the sign-in file Genex uses only which providers hold a subscription sign-in and when each
 * expires; a token is never taken from it, kept or passed on. Windows needs none of this: a session there runs on Pi's own folder and
 * its renewals are the person's. Read from Pi 1.5.2 (`dist/main.js` `runAuthCommand`,
 * `dist/cli/credential-print.js`, `pi-ai` `dist/auth/resolve.js`).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { meetsMinimumVersion } from "./codex-dynamic-tools.ts";
import {
  RENEWAL_CAP_MS,
  RENEWAL_WAIT_MS,
  renewalLeadSeconds,
  SESSION_SIGN_IN_HOLD_MS,
  within,
} from "./sign-in-renewal.ts";
import { spawnCommand } from "../command-launch.ts";
import { stopChild } from "../process-tree.ts";

/** Pi's sign-in file in its folder. */
export const PI_SIGN_IN = "auth.json";
/** How Pi marks a subscription sign-in, which it renews; a stored key has another type. Pi's own spelling. */
const SUBSCRIPTION = "oauth";
/** The first Pi with `auth print-bearer-token`: an older one would take the words as a prompt. */
const PI_RENEWAL_SINCE = "0.83.0";
/** Pi's own lead: it renews a sign-in five minutes before it expires, whatever it is asked. */
const PI_OWN_LEAD_SECONDS = 300;
/** A provider's id as Pi's own providers spell one: nothing Pi could read as an option. */
const PROVIDER_ID = /^[A-Za-z0-9][\w.-]*$/;

/** Which provider's sign-in to renew, when it expires as the file says, and the lead that makes Pi renew it now. */
export interface PiSignInRenewal {
  provider: string;
  expires: number;
  minExpirySeconds: number;
}

type Entries = Record<string, unknown>;

function isEntries(value: unknown): value is Entries {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pi's sign-in file as its providers' entries; null for text that is no such file. */
function signInEntries(text: string): Entries | null {
  try {
    const store: unknown = JSON.parse(text);
    return isEntries(store) ? store : null;
  } catch {
    return null;
  }
}

/** When a provider's subscription sign-in expires; null for a stored key, or an entry Pi could not renew. */
function subscriptionExpiry(entry: unknown): number | null {
  const renewable = isEntries(entry) && entry.type === SUBSCRIPTION && typeof entry.refresh === "string";
  if (!renewable) return null;
  const expires = entry.expires;
  return typeof expires === "number" && Number.isFinite(expires) ? expires : null;
}

/** When `provider`'s subscription sign-in in Pi's file expires, or null when the file does not say. */
export function piSignInExpiry(text: string | null, provider: string): number | null {
  const entries = text === null ? null : signInEntries(text);
  return entries && Object.hasOwn(entries, provider) ? subscriptionExpiry(entries[provider]) : null;
}

/** The provider a `provider/model` id names; none for an id with no provider. */
export function piModelProvider(model: string | undefined): string | undefined {
  const cut = model?.indexOf("/") ?? -1;
  return cut > 0 ? model?.slice(0, cut) : undefined;
}

/**
 * The renewals Pi's sign-in needs before a session copies it, the first to expire first.
 * `provider` is the one the session's model runs on; with none named, every subscription sign-in
 * counts, since Pi picks the model. One is due with less than `SESSION_SIGN_IN_HOLD_MS` left, or
 * less than half a token's life where `life` knows one (Pi's file does not say when a token was
 * minted, so a life is what a renewal showed): the lead that makes it due then stays short of a
 * new token's life. None when each holds, when there is no subscription sign-in to renew, and for
 * a file that is not Pi's sign-in.
 */
export function piSignInRenewals(
  text: string,
  at: { now: number; provider?: string; life?: (provider: string) => number | undefined },
): PiSignInRenewal[] {
  const entries = signInEntries(text);
  if (!entries) return [];
  const named = at.provider;
  const providers = named === undefined ? Object.keys(entries) : [named].filter((id) => Object.hasOwn(entries, id));
  return providers
    .flatMap((provider) => {
      const expires = PROVIDER_ID.test(provider) ? subscriptionExpiry(entries[provider]) : null;
      if (expires === null) return [];
      const life = at.life?.(provider);
      const hold = life === undefined ? SESSION_SIGN_IN_HOLD_MS : Math.min(SESSION_SIGN_IN_HOLD_MS, life / 2);
      const left = expires - at.now;
      return left < hold ? [{ provider, expires, left }] : [];
    })
    .sort((a, b) => a.left - b.left)
    .map(({ provider, expires, left }) => ({
      provider,
      expires,
      minExpirySeconds: renewalLeadSeconds(left, PI_OWN_LEAD_SECONDS),
    }));
}

/** Pi's sign-in file in its folder `agent` as text, or null when there is none to read. */
export async function readPiSignIn(agent: string): Promise<string | null> {
  return readFile(path.join(agent, PI_SIGN_IN), "utf8").catch(() => null);
}

/** Can this Pi renew a sign-in when asked (`pi --version`)? One whose version cannot be read is not asked. */
export function piRenewsSignIn(version: string | undefined): boolean {
  return meetsMinimumVersion(version, PI_RENEWAL_SINCE);
}

/** What the person's own Pi is started with to renew `renewal`'s sign-in. */
export function piRenewalArgs(renewal: PiSignInRenewal): string[] {
  return ["auth", "print-bearer-token", "--provider", renewal.provider, "--min-expiry", `${renewal.minExpirySeconds}s`];
}

/**
 * Has the person's own Pi renew one provider's sign-in, run on the host as the person's terminal
 * would (`piRenewalArgs`): Pi renews a sign-in with less than the asked lead left, writes its own
 * file under its own lock and exits, within a quarter of a minute. What it prints is the token,
 * so none of its output is read or kept. Resolves once Pi exits, or after `waitMs` with the file
 * as it is; Pi is left to finish until `capMs`, since stopping it between the provider's answer
 * and its write would leave a spent refresh token, and is stopped only then.
 */
export async function renewPiSignIn(
  binary: string,
  options: { env: Record<string, string>; cwd: string; renewal: PiSignInRenewal; waitMs?: number; capMs?: number },
): Promise<void> {
  const child = spawnCommand(binary, piRenewalArgs(options.renewal), {
    cwd: options.cwd,
    env: options.env,
    stdio: "ignore",
  });
  const closed = new Promise<void>((resolve) => {
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
  const done = within(closed, options.capMs ?? RENEWAL_CAP_MS)
    .then(() => stopChild(child, { signal: "SIGTERM" }))
    .catch(() => {});
  await within(done, options.waitMs ?? RENEWAL_WAIT_MS);
}
