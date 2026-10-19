/**
 * The export's AI scan (owner decision D5): `genex-ai` is the only supported way for a game to use
 * a model, so an export is checked for the two ways a game goes around it.
 *  - **A vendor's key** in any exported file (text or binary) stops the export: a key in a public
 *    game is a key anyone can spend. The refusal names the file, the line and the vendor, never the
 *    key itself.
 *  - **A vendor's API host** a file reaches by URL (`https://`, `wss://`, `//`) lets the export go on
 *    with a warning and a hint for the agent: Play refuses such a request (`ai_direct_blocked`), so
 *    the game's AI would not work there.
 *
 * Both read the one vendor table in `shared/ai-vendors.ts`, so every near miss it lets through (a
 * prefix in prose, a host that only looks like a vendor's) passes here too.
 */
import { lstat } from "node:fs/promises";
import path from "node:path";
import { AiVendor, aiVendorOfHost, findAiKeys } from "../shared/ai-vendors.ts";
import type { ExportAiHost } from "../shared/game-project.ts";
import { readRegularFile } from "./fsx.ts";

/** Past this a file is an asset too large to read whole; the credential scan skips it as well. */
export const EXPORT_AI_SCAN_MAX_BYTES = 32 * 1024 * 1024;
/** The most vendor hosts one export reports. */
export const EXPORT_AI_MAX_HOSTS = 20;

/** What the agent is told when its game reaches a vendor's API directly. */
export const EXPORT_AI_HINT =
  "This game calls an AI service directly, which Genex blocks while people play it. Make every model call through genex-ai (createAi) instead, and keep no API key in the game.";

/** Each vendor's name as a person reads it. */
const VENDOR_NAME = {
  [AiVendor.OpenAi]: "OpenAI",
  [AiVendor.Anthropic]: "Anthropic",
  [AiVendor.Google]: "Google AI",
  [AiVendor.OpenRouter]: "OpenRouter",
  [AiVendor.Mistral]: "Mistral",
  [AiVendor.Groq]: "Groq",
  [AiVendor.Together]: "Together AI",
  [AiVendor.Fireworks]: "Fireworks AI",
  [AiVendor.DeepSeek]: "DeepSeek",
  [AiVendor.Xai]: "xAI",
  [AiVendor.Cohere]: "Cohere",
  [AiVendor.Perplexity]: "Perplexity",
  [AiVendor.Replicate]: "Replicate",
  [AiVendor.Fal]: "fal",
} as const satisfies Record<AiVendor, string>;

const MESSAGE = {
  KeyLeaked: (file: string, line: number, vendor: AiVendor) =>
    `Export stopped: ${file} (line ${line}) holds a ${VENDOR_NAME[vendor]} API key. Remove it from the game: anyone who plays a published game can read its files, and games reach models only through genex-ai.`,
} as const;

/**
 * A URL's host after its `//`: an optional user part, then the host's own characters. The host ends
 * at the first character a hostname cannot hold (`:`, `/`, `?`, a quote).
 */
const URL_HOST = /\/\/(?:[^\s/@"'`<>]*@)?([A-Za-z0-9.-]+)/g;

/** A vendor key one text holds: whose, and on which line (from 1). */
export interface AiKeyFound {
  vendor: AiVendor;
  line: number;
}

/** What one text holds: the vendor keys in it, and the vendor hosts it reaches, each host once. */
export interface AiTextScan {
  keys: AiKeyFound[];
  hosts: Array<{ host: string; vendor: AiVendor }>;
}

/** The line (from 1) of an offset in `text`. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let at = text.indexOf("\n"); at !== -1 && at < index; at = text.indexOf("\n", at + 1)) line += 1;
  return line;
}

/** The vendor hosts a text reaches by URL, each once, at most {@link EXPORT_AI_MAX_HOSTS}. */
function vendorHosts(text: string): AiTextScan["hosts"] {
  const hosts: AiTextScan["hosts"] = [];
  for (const match of text.matchAll(URL_HOST)) {
    const host = (match[1] ?? "").toLowerCase().replace(/\.+$/, "");
    const vendor = host ? aiVendorOfHost(host) : null;
    if (!vendor || hosts.some((known) => known.host === host)) continue;
    hosts.push({ host, vendor });
    if (hosts.length >= EXPORT_AI_MAX_HOSTS) break;
  }
  return hosts;
}

/** The vendor keys and API hosts in one text. Pure; never throws. */
export function scanTextForAi(text: string): AiTextScan {
  const keys = findAiKeys(text).map((hit) => ({ vendor: hit.vendor, line: lineAt(text, hit.index) }));
  return { keys, hosts: vendorHosts(text) };
}

/** What an export holds: the first vendor key (if any) and the vendor hosts its files reach. */
export interface ExportAiScan {
  key: (AiKeyFound & { file: string }) | null;
  hosts: ExportAiHost[];
}

/**
 * Scan the staged files `files` (relative to `staging`, posix) for vendor keys and hosts. A file
 * over {@link EXPORT_AI_SCAN_MAX_BYTES} is not read; bytes are read as Latin-1, so a key inside a
 * binary asset is found as one in a script is. Stops at the first key.
 */
export async function scanExportForAi(staging: string, files: readonly string[]): Promise<ExportAiScan> {
  const hosts: ExportAiHost[] = [];
  for (const file of files) {
    const absolute = path.join(staging, file);
    if ((await lstat(absolute)).size > EXPORT_AI_SCAN_MAX_BYTES) continue;
    const scan = scanTextForAi((await readRegularFile(absolute, EXPORT_AI_SCAN_MAX_BYTES)).toString("latin1"));
    const [key] = scan.keys;
    if (key) return { key: { ...key, file }, hosts };
    for (const found of scan.hosts) {
      if (hosts.length >= EXPORT_AI_MAX_HOSTS || hosts.some((known) => known.host === found.host)) continue;
      hosts.push({ file, ...found });
    }
  }
  return { key: null, hosts };
}

/** The refusal of an export that holds a vendor key: the file, the line and the vendor, never the key. */
export const exportKeyRefusal = (key: AiKeyFound & { file: string }): string =>
  MESSAGE.KeyLeaked(key.file, key.line, key.vendor);
