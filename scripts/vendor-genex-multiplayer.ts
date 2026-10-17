/**
 * Build Studio's own copy of Genex's multiplayer SDK into the app's vendor folder, for games made
 * from the template (`GENEX_MULTIPLAYER_VENDOR` in src/shared/genex.ts names the files,
 * `GENEX_GAME_PACKAGES` the version; the embed SDK is copied as it ships by
 * `scripts/build-plugins.mjs`). One esbuild pass with shared chunks: the multiplayer entry and its
 * schema entry must share one copy of Colyseus's schema, or a state class defined with one is
 * unknown to the other. Beside the code: LICENSES.md, every bundled package's license text, which
 * an exported game carries with the files it uses, and VERSION.json.
 *
 * Built from what `npm ci` installed, never downloaded; a version that is not the pinned one
 * stops the build, so a game is never told one version and served another.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as esbuild from "esbuild";
import { GENEX_GAME_PACKAGES, GENEX_MULTIPLAYER_VENDOR, type GenexGamePackage } from "../src/shared/genex.ts";
import { noticeFiles, packageOf } from "./third-party-notices.mjs";

/** The package this builds. */
const MULTIPLAYER: GenexGamePackage = "@genex-ai/multiplayer";

/** Each served file's name under the folder (without `.js`), and the specifier esbuild resolves it from. */
const ENTRY_POINTS = {
  [path.posix.basename(GENEX_MULTIPLAYER_VENDOR.Entry, ".js")]: MULTIPLAYER,
  [path.posix.basename(GENEX_MULTIPLAYER_VENDOR.Schema, ".js")]: `${MULTIPLAYER}/schema`,
};

export interface VendoredGenexSdk {
  /** The files esbuild read, relative to the repository root, for the app's NOTICE.md. */
  inputs: string[];
  /** Bytes of JavaScript written. */
  bytes: number;
}

/** The installed version of a pinned package; throws when it is not the pin. */
async function installedPin(root: string, name: GenexGamePackage): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(root, "node_modules", name, "package.json"), "utf8"));
  if (manifest.version !== GENEX_GAME_PACKAGES[name]) {
    throw new Error(`${name} ${manifest.version} is installed, but Studio pins ${GENEX_GAME_PACKAGES[name]}`);
  }
  return manifest.version;
}

/**
 * A package's notice from THIRD-PARTY-NOTICES.md (its `### <name> <version>` section, up to the
 * next heading), for a package that ships no license file of its own; null when it has none.
 */
function projectNotice(notices: string, name: string, version: string): string | null {
  const heading = `### ${name} ${version}\n`;
  const start = notices.indexOf(heading);
  if (start === -1) return null;
  const body = notices.slice(start + heading.length);
  const end = body.search(/^#{2,3} /m);
  return (end === -1 ? body : body.slice(0, end)).trim();
}

/** Every bundled package's license text, one section each, sorted by name. */
async function licenses(root: string, inputs: string[]): Promise<string> {
  const notices = await readFile(path.join(root, "THIRD-PARTY-NOTICES.md"), "utf8");
  const packages = new Map<string, { name: string; version: string; license: string; texts: string[] }>();
  for (const input of inputs) {
    const found = packageOf(root, input);
    if (!found || packages.has(found.dir)) continue;
    const { name, version, license } = found.pkg;
    const files = noticeFiles(found.dir);
    const texts = await Promise.all(
      files.map(async (file) => (await readFile(path.join(found.dir, file), "utf8")).trim()),
    );
    const fallback = texts.length === 0 ? projectNotice(notices, name, version) : null;
    if (texts.length === 0 && fallback === null)
      throw new Error(`${name} ${version} ships no license file and THIRD-PARTY-NOTICES.md has no section for it`);
    packages.set(found.dir, { name, version, license, texts: fallback === null ? texts : [fallback] });
  }
  const sections: string[] = ["# Licenses of the Genex multiplayer SDK Studio serves to games", ""];
  const sorted = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const pkg of sorted)
    sections.push(`## ${pkg.name} ${pkg.version} (${pkg.license})`, "", ...pkg.texts.flatMap((text) => [text, ""]));
  return `${sections.join("\n").trimEnd()}\n`;
}

/**
 * Bundle the multiplayer SDK into `vendorDir/genex/multiplayer`, with its licenses and version
 * beside it. esbuild resolves the entries from the repository's own node_modules, as a browser
 * bundler resolves the imports.
 */
export async function vendorGenexMultiplayer(root: string, vendorDir: string): Promise<VendoredGenexSdk> {
  const versions = { [MULTIPLAYER]: await installedPin(root, MULTIPLAYER) };
  const outdir = path.join(vendorDir, GENEX_MULTIPLAYER_VENDOR.Dir);
  const result = await esbuild.build({
    absWorkingDir: root,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    metafile: true,
    logLevel: "warning",
    entryPoints: ENTRY_POINTS,
    outdir,
    chunkNames: "chunk-[hash]",
  });
  const inputs = Object.keys(result.metafile.inputs);
  await writeFile(path.join(outdir, "LICENSES.md"), await licenses(root, inputs));
  await writeFile(path.join(outdir, "VERSION.json"), `${JSON.stringify(versions, null, 2)}\n`);
  const bytes = Object.values(result.metafile.outputs).reduce((sum, output) => sum + output.bytes, 0);
  return { inputs, bytes };
}
