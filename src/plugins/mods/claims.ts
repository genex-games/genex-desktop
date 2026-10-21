/**
 * Which mod project put each file in a game, kept per game in the plugin's storage, so two
 * projects modding one game never replace each other's files: a project may only write a file no
 * other project placed, and Remove mod releases only its own.
 */
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteText } from "../../substrate/fsx.ts";

/** Each placed file, by its place and `/`-path (`mods:faster_1.0.0/info.json`), and the project key that placed it. */
export type Claims = Record<string, string>;

/** A placed file's key in the claims. */
export const claimKey = (root: string, rel: readonly string[] | string): string =>
  `${root}:${typeof rel === "string" ? rel : rel.join("/")}`;

/** A game's claims; none before its first install. */
export async function readClaims(file: string): Promise<Claims> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

/** Saves a game's claims. */
export async function writeClaims(file: string, claims: Claims): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWriteText(file, `${JSON.stringify(claims, null, 2)}\n`);
}

/** Applies `change` to a game's claims and saves them. */
export async function updateClaims(file: string, change: (claims: Claims) => void): Promise<void> {
  const claims = await readClaims(file);
  change(claims);
  await writeClaims(file, claims);
}
