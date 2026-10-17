/**
 * How a published copy is connected to Genex. A game that brings no embed SDK of its own gets
 * Studio's copy of it and a module that calls `initEmbed()` with the game's project, loaded by its
 * entry page, so genex.games can sign its players in or let them play as guests, whatever engine
 * made the page. The page edits themselves are `shared/genex-page.ts`.
 */
import { init, parse } from "es-module-lexer";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GENEX_EMBED_VENDOR, type GenexGameManifest } from "../../shared/genex.ts";
import { connectModuleSrc, withConnectScript } from "../../shared/genex-page.ts";
import { isInside } from "../../substrate/paths.ts";

/** Where the SDK and the connect module sit in a published copy, beside its entry page. */
const PUBLISHED_VENDOR = "vendor";
const ENTRY_PAGE = "index.html";
/** The SDK's module every other one is reached from. */
const SDK_ENTRY = "index.js";
/** The longest slug the connect module accepts. */
const MAX_SLUG_CHARS = 100;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
/** The hosts a plain-http address may name: only this Mac's own, where a fixture Genex runs. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

const MESSAGE = {
  InvalidSlug: (slug: string) => `Genex named this game's project "${slug}", which a page cannot be connected to`,
  InvalidAddress: (value: string) => `Not a Genex address a page can be connected to: ${value}`,
  NoOrigin: "A page cannot be connected to Genex without the origin genex.games serves it from",
  SdkImport: (file: string, ref: string) => `The embed SDK's ${file} imports ${ref}, which Studio cannot publish`,
} as const;

/** The project and environment a published page connects to. */
export interface GenexConnection {
  slug: string;
  apiUrl: string;
  dashboardOrigins: readonly string[];
}

/** An https address, or plain http on this Mac (a fixture Genex). */
function isGenexAddress(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  } catch {
    return false;
  }
}

function checkedConnection({ slug, apiUrl, dashboardOrigins }: GenexConnection): GenexConnection {
  if (slug.length > MAX_SLUG_CHARS || !SLUG.test(slug)) throw new Error(MESSAGE.InvalidSlug(slug));
  if (!isGenexAddress(apiUrl)) throw new Error(MESSAGE.InvalidAddress(apiUrl));
  if (!dashboardOrigins.length) throw new Error(MESSAGE.NoOrigin);
  for (const origin of dashboardOrigins) {
    const exact = isGenexAddress(origin) && new URL(origin).origin === origin;
    if (!exact) throw new Error(MESSAGE.InvalidAddress(origin));
  }
  return { slug, apiUrl, dashboardOrigins };
}

/** What a published copy's connect module says about itself. */
const PUBLISHED_HEADING = [
  "// Written by Genex Studio when it published this game. It connects the game to Genex as it",
  "// boots, so genex.games can sign its players in or let them play as guests. The games host names",
  "// the environment it serves the game from in window.__GENEX__.",
];
/** What the preview's connect module says about itself. */
const PREVIEW_HEADING = [
  "// Genex Studio's preview connects a game that loads the Genex SDK through this module. On the",
  "// preview's own address the SDK runs in local test mode: no account and no network. Publishing",
  "// to Genex replaces this module with one that names the game's project.",
];
/** What the preview's module names: nothing the local test mode sends anywhere. */
const PREVIEW_CONNECTION: GenexConnection = {
  slug: "studio-preview",
  apiUrl: "https://api.genex.games",
  dashboardOrigins: ["https://genex.games"],
};

function connectModule(heading: readonly string[], { slug, apiUrl, dashboardOrigins }: GenexConnection): string {
  const sdk = path.posix.relative(path.posix.dirname(GENEX_EMBED_VENDOR.Connect), GENEX_EMBED_VENDOR.Entry);
  return [
    ...heading,
    `import { initEmbed } from "./${sdk}";`,
    "",
    "const served = window.__GENEX__ ?? {};",
    "initEmbed({",
    `  slug: ${JSON.stringify(slug)},`,
    `  apiUrl: served.apiUrl ?? ${JSON.stringify(apiUrl)},`,
    `  dashboardOrigins: served.dashboardOrigins ?? ${JSON.stringify(dashboardOrigins)},`,
    "});",
    "",
  ].join("\n");
}

/**
 * The module that connects a published page to Genex as it boots. It names the game's project; the
 * games host names the environment it serves the page from, and Studio's own answer stands in where
 * it does not.
 */
export function connectScript(connection: GenexConnection): string {
  return connectModule(PUBLISHED_HEADING, checkedConnection(connection));
}

/** The connect module in the app's vendor folder, which Studio's preview serves to a template game that loads the SDK. */
export function previewConnectScript(): string {
  return connectModule(PREVIEW_HEADING, PREVIEW_CONNECTION);
}

/** The modules a file of the SDK imports, as names inside its folder: only its own siblings may be named. */
async function siblingImports(dir: string, file: string): Promise<string[]> {
  const [imports] = parse(await readFile(path.join(dir, file), "utf8"));
  const names: string[] = [];
  for (const { n: ref } of imports) {
    if (ref === undefined) continue;
    const target = path.resolve(dir, path.dirname(file), ref);
    if (!ref.startsWith("./") || !isInside(dir, target)) throw new Error(MESSAGE.SdkImport(file, ref));
    names.push(path.relative(dir, target).split(path.sep).join("/"));
  }
  return names;
}

/**
 * The files of the browser SDK in `dir` a page needs: its entry and every module reached from it,
 * sorted. An SDK that imports a package or anything outside its folder is refused, never published.
 */
export async function embedSdkFiles(dir: string): Promise<string[]> {
  await init;
  const reached = new Set<string>();
  const queue = [SDK_ENTRY];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (reached.has(file)) continue;
    reached.add(file);
    queue.push(...(await siblingImports(dir, file)));
  }
  return [...reached].sort();
}

/**
 * Whether a game brings the embed SDK itself, and so calls `initEmbed()` itself. Multiplayer alone
 * does not: a template game that maps Studio's multiplayer copy is still connected by Studio.
 */
export function bringsOwnSdk(manifest: GenexGameManifest | undefined): boolean {
  return Object.hasOwn(manifest?.dependencies ?? {}, "@genex-ai/embed-sdk");
}

/**
 * Connect the copy in `dist` to Genex: Studio's SDK from `sdkDir` and the connect module go beside
 * its entry page, which loads the module. Everything is checked before anything is written.
 */
export async function connectPublishedCopy(dist: string, sdkDir: string, connection: GenexConnection): Promise<void> {
  const script = connectScript(connection);
  const files = await embedSdkFiles(sdkDir);
  const vendor = path.join(dist, PUBLISHED_VENDOR);
  const sdkTarget = path.join(vendor, GENEX_EMBED_VENDOR.Sdk);
  for (const file of files) {
    await mkdir(path.dirname(path.join(sdkTarget, file)), { recursive: true });
    await copyFile(path.join(sdkDir, file), path.join(sdkTarget, file));
  }
  await writeFile(path.join(vendor, GENEX_EMBED_VENDOR.Connect), script);
  const entry = path.join(dist, ENTRY_PAGE);
  await writeFile(entry, withConnectScript(await readFile(entry, "utf8"), connectModuleSrc(`./${PUBLISHED_VENDOR}`)));
}
