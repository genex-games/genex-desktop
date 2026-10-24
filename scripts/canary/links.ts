// The public download links a person uses, and the checks that one serves a given release: it
// redirects to that release's asset, and the file it hands out matches the release's SHA256SUMS.
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";

/** The package a canary machine installs, named by how a person gets it. */
export const PackageKind = { Dmg: "dmg", Exe: "exe", Deb: "deb", Rpm: "rpm" } as const;
export type PackageKind = (typeof PackageKind)[keyof typeof PackageKind];

const REPOSITORY = "genex-games/genex-desktop";
const LATEST = `https://github.com/${REPOSITORY}/releases/latest/download`;
/** Where a release's own assets live; a link has reached its release once it points here. */
const RELEASE_ASSET = new RegExp(`^https://github\\.com/${REPOSITORY}/releases/download/([^/]+)/([^/?#]+)$`);
/** Redirects a link may take before it reaches a release asset (genex.games → GitHub is one). */
const MAX_HOPS = 5;

/** Each kind's public link (what the website and README hand out) and the release asset it reaches. */
export const PUBLIC_LINKS = {
  [PackageKind.Dmg]: { url: `${LATEST}/Genex.dmg`, asset: "Genex.dmg" },
  [PackageKind.Exe]: { url: "https://genex.games/desktop/download/windows", asset: "Genex-Setup.exe" },
  [PackageKind.Deb]: { url: `${LATEST}/Genex-linux-amd64.deb`, asset: "Genex-linux-amd64.deb" },
  [PackageKind.Rpm]: { url: `${LATEST}/Genex-linux-x86_64.rpm`, asset: "Genex-linux-x86_64.rpm" },
} as const satisfies Record<PackageKind, { url: string; asset: string }>;

/** How long a published release may take to reach its public links, and how often to look. */
export const LINK_WAIT_MS = 20 * MINUTE_MS;
export const LINK_POLL_MS = 30 * SECOND_MS;

/** The release tag a URL names when it is a release asset called `asset`, or null. */
export function assetTag(url: string, asset: string): string | null {
  const match = RELEASE_ASSET.exec(url);
  return match && match[2] === asset ? decodeURIComponent(match[1] ?? "") : null;
}

/** The URL of one asset of one release. */
export function releaseAssetUrl(tag: string, asset: string): string {
  return `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${asset}`;
}

/** What a public link points at right now: the redirects it took and the release it reached. */
export interface LinkTarget {
  hops: string[];
  tag: string | null;
}

/** Follow `url`'s redirects without downloading until it names a release asset (or stops redirecting). */
export async function resolveLink(url: string, asset: string, fetchImpl: typeof fetch = fetch): Promise<LinkTarget> {
  const hops = [url];
  let current = url;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const tag = assetTag(current, asset);
    if (tag) return { hops, tag };
    const response = await fetchImpl(current, { method: "HEAD", redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) return { hops, tag: null };
    current = new URL(location, current).toString();
    hops.push(current);
  }
  return { hops, tag: assetTag(current, asset) };
}

/** The clock and pause a wait runs on, injectable so a test needs neither. */
export interface WaitClock {
  now: () => number;
  sleep: (ms: number) => Promise<unknown>;
}

/** Whether a link reached the release in time, what it last pointed at, and how long that took. */
export interface LinkWait {
  ok: boolean;
  target: LinkTarget;
  waitedMs: number;
}

/** Poll a public link until it serves `tag`, up to `timeoutMs`; a network error counts as not yet. */
export async function waitForRelease(
  kind: PackageKind,
  tag: string,
  clock: WaitClock,
  { fetchImpl = fetch, timeoutMs = LINK_WAIT_MS, pollMs = LINK_POLL_MS } = {},
): Promise<LinkWait> {
  const { url, asset } = PUBLIC_LINKS[kind];
  const started = clock.now();
  for (;;) {
    const target = await resolveLink(url, asset, fetchImpl).catch((error: Error) => ({
      hops: [url, `error: ${error.message}`],
      tag: null,
    }));
    const waitedMs = clock.now() - started;
    if (target.tag === tag) return { ok: true, target, waitedMs };
    if (waitedMs + pollMs > timeoutMs) return { ok: false, target, waitedMs };
    await clock.sleep(pollMs);
  }
}

/** A SHA256SUMS file (`<hex>  <name>` per line) as name → lowercase hex. */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match?.[1] && match[2]) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

/** Download `url` (following redirects) to `file`; its SHA-256 and size. */
export async function download(
  url: string,
  file: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ sha256: string; bytes: number }> {
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`GET ${url}: HTTP ${response.status}`);
  const hash = createHash("sha256");
  let bytes = 0;
  const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  body.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    bytes += chunk.length;
  });
  await pipeline(body, createWriteStream(file));
  return { sha256: hash.digest("hex"), bytes };
}
