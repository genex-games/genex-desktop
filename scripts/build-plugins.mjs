import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { cp, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { inlinePanelFonts, inlinePanelSdk } from "../src/plugin-sdk/inline-panel-sdk.mjs";
const require = createRequire(import.meta.url);

/** A Node backend bundle, as every bundled plugin ships one. */
const NODE_BACKEND = { bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent" };
/** Files of the vendored Genex skills that only `scripts/refresh-genex-skills.ts` reads. */
const GENEX_SKILL_SOURCES = new Set(["PREFACE.md", "vendor.json"]);

/** The package.json of `name` as `from` resolves it, found by walking up when the package hides it. */
async function packageJsonOf(name, from) {
  try {
    return createRequire(from).resolve(`${name}/package.json`);
  } catch {
    let dir = path.dirname(createRequire(from).resolve(name));
    for (;;) {
      try {
        const value = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
        if (value.name === name) return path.join(dir, "package.json");
      } catch {}
      const parent = path.dirname(dir);
      if (parent === dir) throw new Error(`Cannot locate package ${name}`);
      dir = parent;
    }
  }
}

/**
 * Dependency folders the payload leaves out, as `/`-joined paths inside node_modules. They are
 * its deepest paths, and a Windows install fails on any file at 260 characters or more: Sentry's
 * vendored vite, rollup, webpack and esbuild plugins, which only its bundler subpath exports load
 * and the Genex CLI never imports.
 */
const UNLOADED_TREES = [
  "@sentry/server-utils/build/cjs/vendored/@apm-js-collab/code-transformer-bundler-plugins",
  "@sentry/server-utils/build/esm/vendored/@apm-js-collab/code-transformer-bundler-plugins",
];

/**
 * Files no runtime loads: TypeScript declarations and source maps, two thirds of the payload's
 * files. Every first launch copies the payload into the plugin store before the window opens.
 */
const UNLOADED_FILES = /\.(d\.[cm]?ts|map)$/;

/** Is this path (relative to node_modules, at any nesting) a file or inside a tree the payload leaves out? */
const unloaded = (relative) => {
  const inside = `/${relative.split(path.sep).join("/")}/`;
  return UNLOADED_FILES.test(relative) || UNLOADED_TREES.some((tree) => inside.includes(`/${tree}/`));
};

/** Is this path (relative to node_modules) outside it? */
const outsideModules = (relative) =>
  !relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);

/** Copies a runtime dependency and everything it depends on into the plugin's own node_modules. */
async function copyDependencyTree(copying, name, from) {
  const pkg = await packageJsonOf(name, from);
  const meta = JSON.parse(await readFile(pkg, "utf8"));
  if (copying.seen.has(pkg)) return;
  copying.seen.add(pkg);
  const relative = path.relative(copying.dependencyRoot, path.dirname(pkg));
  if (outsideModules(relative)) throw new Error(`Plugin dependency is outside node_modules: ${name}`);
  await cp(path.dirname(pkg), path.join(copying.target, "node_modules", relative), {
    recursive: true,
    filter: (source) => !unloaded(path.relative(copying.dependencyRoot, source)),
  });
  for (const dep of Object.keys(meta.dependencies ?? {})) await copyDependencyTree(copying, dep, pkg);
}

/** The plugin module that knows the SDK's files and writes the preview's connect module. */
const entryPage = (root) => import(pathToFileURL(path.join(root, "src/plugins/genex/entry-page.ts")).href);

/**
 * The browser files of the pinned `@genex-ai/embed-sdk` (its entry and the modules it reaches) into
 * `target`: the Genex plugin connects a published game with them, and template games import them
 * from the app's vendor folder.
 */
export async function copyEmbedSdk(root, target) {
  const { embedSdkFiles } = await entryPage(root);
  const dist = path.join(root, "node_modules/@genex-ai/embed-sdk/dist");
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const file of await embedSdkFiles(dist)) await cp(path.join(dist, file), path.join(target, file));
}

/**
 * The app's vendor copy of the SDK (`vendor/genex/embed-sdk/`) and the connect module beside it,
 * which the preview serves to a template game whose import map names the SDK.
 */
export async function vendorEmbedSdk(root, vendor) {
  const { previewConnectScript } = await entryPage(root);
  await copyEmbedSdk(root, path.join(vendor, "genex/embed-sdk"));
  await writeFile(path.join(vendor, "genex/connect.js"), previewConnectScript());
}

async function buildGenex(root, resources, { dependencies }) {
  const target = path.join(resources, "plugins/genex");
  await mkdir(target, { recursive: true });
  for (const file of ["plugin.json", "icon.png", "publish.html"])
    await cp(path.join(root, "src/plugins/genex", file), path.join(target, file));
  await cp(path.join(root, "src/genex-host/preload.mjs"), path.join(target, "preload.mjs"));
  // The vendored skills ship even in a dependency-free build: each SKILL.md already holds its preface.
  await cp(path.join(root, "src/plugins/genex/skills"), path.join(target, "skills"), {
    recursive: true,
    filter: (source) => !GENEX_SKILL_SOURCES.has(path.basename(source)),
  });
  await build({
    ...NODE_BACKEND,
    entryPoints: [path.join(root, "src/plugins/genex/backend.ts")],
    outfile: path.join(target, "backend.mjs"),
    external: ["electron"],
  });
  await build({
    ...NODE_BACKEND,
    entryPoints: [path.join(root, "src/plugins/genex/creator-mcp-entry.ts")],
    outfile: path.join(target, "creator-mcp.mjs"),
    banner: { js: "import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  await copyEmbedSdk(root, path.join(target, "embed-sdk"));
  if (!dependencies) return;
  const copying = { target, dependencyRoot: await realpath(path.join(root, "node_modules")), seen: new Set() };
  await copyDependencyTree(copying, "@genex-ai/cli-demo", require.resolve("@genex-ai/cli-demo/package.json"));
}

async function buildBlender(root, resources, sdk) {
  const blender = path.join(resources, "plugins/blender");
  await mkdir(blender, { recursive: true });
  for (const file of ["plugin.json", "icon.png"])
    await cp(path.join(root, "src/plugins/blender", file), path.join(blender, file));
  await writeFile(
    path.join(blender, "panel.html"),
    await inlinePanelSdk(await readFile(path.join(root, "src/plugins/blender/panel.html"), "utf8"), sdk),
  );
  // A file URL: a bare Windows path (D:\...) is not an import specifier.
  const { BLENDER_WRAPPER_PY } = await import(pathToFileURL(path.join(root, "src/plugins/blender/wrapper.ts")).href);
  await writeFile(path.join(blender, "wrapper.py"), BLENDER_WRAPPER_PY);
  await build({
    ...NODE_BACKEND,
    entryPoints: [path.join(root, "src/plugins/blender/backend.ts")],
    outfile: path.join(blender, "backend.mjs"),
  });
}

async function buildUnreal(root, resources, sdk) {
  const unreal = path.join(resources, "plugins/unreal");
  await mkdir(unreal, { recursive: true });
  for (const file of ["plugin.json", "icon.svg"])
    await cp(path.join(root, "src/plugins/unreal", file), path.join(unreal, file));
  // Genex's own type goes in as data: a panel can load no font from anywhere else.
  const panel = await inlinePanelSdk(await readFile(path.join(root, "src/plugins/unreal/panel.html"), "utf8"), sdk);
  await writeFile(
    path.join(unreal, "panel.html"),
    await inlinePanelFonts(panel, path.join(root, "src/renderer/fonts")),
  );
  // The editor helper is Unreal's own plugin, copied whole into a game's Plugins folder at setup.
  await cp(path.join(root, "src/plugins/unreal/GenexEditorHelper"), path.join(unreal, "GenexEditorHelper"), {
    recursive: true,
    filter: (source) => path.basename(source) !== "__pycache__",
  });
  await build({
    ...NODE_BACKEND,
    entryPoints: [path.join(root, "src/plugins/unreal/backend.ts")],
    outfile: path.join(unreal, "backend.mjs"),
  });
  await build({
    ...NODE_BACKEND,
    entryPoints: [path.join(root, "src/plugins/unreal/editor-mcp-entry.ts")],
    outfile: path.join(unreal, "editor-mcp.mjs"),
    banner: { js: "import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);" },
  });
}

/** The Roblox helper's file name, in the package and in Studio's Plugins folder. */
const ROBLOX_HELPER_FILE = "GenexStudioHelper.rbxmx";
/** Enum.RunContext.Plugin's value in a place file. */
const RUN_CONTEXT_PLUGIN = 3;

/** A Luau literal of a JSON-able value: plain ASCII text, numbers, lists and string-keyed tables. */
function luauLiteral(value, indent = "\t") {
  if (typeof value === "string") {
    if (!/^[\x20-\x7e]*$/.test(value)) throw new Error(`The Roblox helper's constants hold plain text only: ${value}`);
    return JSON.stringify(value);
  }
  if (typeof value === "number") return String(value);
  const inner = `${indent}\t`;
  if (Array.isArray(value)) return `{ ${value.map((item) => luauLiteral(item, inner)).join(", ")} }`;
  const keys = Object.keys(value).sort();
  return `{\n${keys.map((key) => `${inner}${key} = ${luauLiteral(value[key], inner)},`).join("\n")}\n${indent}}`;
}

/**
 * The helper's `constants` module, generated from the plugin's TypeScript so the two sides of the
 * helper link never disagree. `version` is the helper's own, from `helper/VERSION`.
 */
async function robloxHelperConstants(root, version) {
  const module = (file) => import(pathToFileURL(path.join(root, file)).href);
  const protocol = await module("src/plugins/roblox/helper-protocol.ts");
  const { HELPER_PATH } = await module("src/plugins/roblox/helper-socket.ts");
  const { MAX_PLAY_PLAYERS } = await module("src/shared/engine-play.ts");
  const values = {
    PROTOCOL: protocol.HELPER_PROTOCOL,
    PORTS: [...protocol.HELPER_PORTS],
    PATH: HELPER_PATH,
    SESSION_MARKER: protocol.SESSION_MARKER,
    MAX_FRAME_BYTES: protocol.MAX_HELPER_FRAME_BYTES,
    MAX_SCRIPT_SOURCE_BYTES: protocol.MAX_SCRIPT_SOURCE_BYTES,
    MAX_CHUNK_CHARS: protocol.MAX_CHUNK_CHARS,
    MAX_CHUNKS: protocol.MAX_CHUNKS,
    CHUNK_BYTES: protocol.CHUNK_BYTES,
    PLACE_PART_MAX_BYTES: protocol.PLACE_PART_MAX_BYTES,
    SCRIPT_SERVICES: [...protocol.SCRIPT_SERVICES],
    PLACE_SERVICES: [...protocol.PLACE_SERVICES],
    SERVICES_PART: protocol.SERVICES_PART,
    TERRAIN_PART: protocol.TERRAIN_PART,
    MODEL_PART: protocol.MODEL_PART,
    MODEL_MAGIC: protocol.MODEL_MAGIC,
    MAX_PLAYERS: MAX_PLAY_PLAYERS,
    Message: protocol.HelperMessage,
    ErrorCode: protocol.HelperErrorCode,
  };
  const fields = Object.keys(values)
    .sort()
    .map((key) => `\t${key} = ${luauLiteral(values[key])},`);
  return [
    "--!strict",
    "-- The values the helper shares with Genex: the protocol, the ports, the names and the limits.",
    "-- Generated by scripts/build-plugins.mjs from the Roblox plugin's TypeScript; never edit by hand.",
    `local GENEX_HELPER_VERSION = ${version}`,
    "",
    "return table.freeze({",
    "\tHELPER_VERSION = GENEX_HELPER_VERSION,",
    ...fields,
    "})",
    "",
  ].join("\n");
}

/** Luau source as a CDATA section; a `]]>` inside it is split across two sections. */
const cdata = (source) => `<![CDATA[${source.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;

/** One script item of the helper's model: its class, name and source, and the items inside it. */
function rbxmxItem(item, referent, inner = "", depth = 1) {
  const tab = "\t".repeat(depth);
  const runContext =
    item.className === "Script" ? `\n${tab}\t\t<token name="RunContext">${RUN_CONTEXT_PLUGIN}</token>` : "";
  const disabled = item.className === "Script" ? `\n${tab}\t\t<bool name="Disabled">false</bool>` : "";
  return [
    `${tab}<Item class="${item.className}" referent="${referent}">`,
    `${tab}\t<Properties>`,
    `${tab}\t\t<string name="Name">${item.name}</string>${disabled}${runContext}`,
    `${tab}\t\t<ProtectedString name="Source">${cdata(item.source)}</ProtectedString>`,
    `${tab}\t</Properties>`,
    inner,
    `${tab}</Item>`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * The Genex helper as the readable `.rbxmx` model Set up copies into Studio's Plugins folder: the
 * entry Script (`helper/init.luau`, run context Plugin) holding one ModuleScript per other
 * `helper/*.luau` file and the generated `constants`. The same tree always gives the same bytes.
 * Refuses a `helper/VERSION` other than the plugin's `HELPER_VERSION`.
 */
export async function robloxHelperModel(root) {
  const dir = path.join(root, "src/plugins/roblox/helper");
  const version = Number((await readFile(path.join(dir, "VERSION"), "utf8")).trim());
  const { HELPER_VERSION } = await import(pathToFileURL(path.join(root, "src/plugins/roblox/setup.ts")).href);
  if (!Number.isSafeInteger(version) || version !== HELPER_VERSION)
    throw new Error(`helper/VERSION says ${version}; the plugin's HELPER_VERSION is ${HELPER_VERSION}.`);
  const files = (await readdir(dir)).filter((file) => file.endsWith(".luau")).sort();
  if (!files.includes("init.luau") || files.includes("constants.luau"))
    throw new Error("The Roblox helper needs helper/init.luau, and its constants module is generated.");
  const modules = [{ name: "constants", source: await robloxHelperConstants(root, version) }];
  for (const file of files.filter((name) => name !== "init.luau"))
    modules.push({ name: file.slice(0, -".luau".length), source: await readFile(path.join(dir, file), "utf8") });
  modules.sort((a, b) => (a.name < b.name ? -1 : 1));
  const children = modules
    .map((module, index) => rbxmxItem({ ...module, className: "ModuleScript" }, `RBXGENEX${index + 1}`, "", 2))
    .join("\n");
  const entry = {
    className: "Script",
    name: "GenexStudioHelper",
    source: await readFile(path.join(dir, "init.luau"), "utf8"),
  };
  return [
    '<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">',
    rbxmxItem(entry, "RBXGENEX0", children),
    "</roblox>",
    "",
  ].join("\n");
}

/** Assembles the helper into the package, as Set up finds it beside the backend. */
async function buildRobloxHelper(root, roblox) {
  await writeFile(path.join(roblox, ROBLOX_HELPER_FILE), await robloxHelperModel(root));
}

async function buildRoblox(root, resources, sdk) {
  const roblox = path.join(resources, "plugins/roblox");
  await mkdir(roblox, { recursive: true });
  for (const file of ["plugin.json", "icon.svg"])
    await cp(path.join(root, "src/plugins/roblox", file), path.join(roblox, file));
  await cp(path.join(root, "src/plugins/roblox/skills"), path.join(roblox, "skills"), { recursive: true });
  // The judges' briefs, and their probes' Luau beside the backend that sends it to Studio.
  await cp(path.join(root, "src/plugins/roblox/judges"), path.join(roblox, "judges"), { recursive: true });
  for (const file of ["cheat-remotes.luau", "phone-check.luau"])
    await cp(path.join(root, "src/plugins/roblox", file), path.join(roblox, file));
  // New Roblox game's Baseplate, beside the backend that writes it.
  await cp(path.join(root, "src/plugins/roblox/templates"), path.join(roblox, "templates"), { recursive: true });
  // The Genex helper Set up copies into Studio's Plugins folder.
  await buildRobloxHelper(root, roblox);
  const panel = await inlinePanelSdk(await readFile(path.join(root, "src/plugins/roblox/panel.html"), "utf8"), sdk);
  await writeFile(
    path.join(roblox, "panel.html"),
    await inlinePanelFonts(panel, path.join(root, "src/renderer/fonts")),
  );
  await build({
    ...NODE_BACKEND,
    entryPoints: [path.join(root, "src/plugins/roblox/backend.ts")],
    outfile: path.join(roblox, "backend.mjs"),
  });
  // The Roblox Studio connection: a copied package can't reach the repository's node_modules, so
  // the MCP SDK is bundled in.
  await build({
    ...NODE_BACKEND,
    entryPoints: [path.join(root, "src/plugins/roblox/studio-mcp-entry.ts")],
    outfile: path.join(roblox, "studio-mcp.mjs"),
    banner: { js: "import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);" },
  });
}

async function buildGodot(root, resources, sdk) {
  const source = path.join(root, "src/plugins/godot");
  const godot = path.join(resources, "plugins/godot");
  await mkdir(godot, { recursive: true });
  for (const file of ["plugin.json", "icon.svg"]) await cp(path.join(source, file), path.join(godot, file));
  const panel = await inlinePanelSdk(await readFile(path.join(source, "panel.html"), "utf8"), sdk);
  await writeFile(path.join(godot, "panel.html"), await inlinePanelFonts(panel, path.join(root, "src/renderer/fonts")));
  // Genex's own GDScript (the check and the plays), the new-game templates and the addon a set-up
  // game carries (the Play Protocol autoload), read beside the backend.
  for (const folder of ["scripts", "templates", "addon"])
    await cp(path.join(source, folder), path.join(godot, folder), { recursive: true });
  await build({
    ...NODE_BACKEND,
    entryPoints: [path.join(source, "backend.ts")],
    outfile: path.join(godot, "backend.mjs"),
  });
}

async function buildUnity(root, resources, sdk) {
  const unity = path.join(resources, "plugins/unity");
  await mkdir(unity, { recursive: true });
  await cp(path.join(root, "src/plugins/unity/plugin.json"), path.join(unity, "plugin.json"));
  // Genex's own type goes in as data: a panel can load no font from anywhere else.
  const panel = await inlinePanelSdk(await readFile(path.join(root, "src/plugins/unity/panel.html"), "utf8"), sdk);
  await writeFile(path.join(unity, "panel.html"), await inlinePanelFonts(panel, path.join(root, "src/renderer/fonts")));
  await build({
    ...NODE_BACKEND,
    entryPoints: [path.join(root, "src/plugins/unity/backend.ts")],
    outfile: path.join(unity, "backend.mjs"),
  });
  await build({
    ...NODE_BACKEND,
    entryPoints: [path.join(root, "src/plugins/unity/editor-mcp-entry.ts")],
    outfile: path.join(unity, "editor-mcp.mjs"),
    banner: { js: "import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);" },
  });
}

/** Copies the SDK and builds the bundled plugins (and the example) into the app's resources. */
export async function buildPlugins(root, resources, { dependencies = true } = {}) {
  await cp(path.join(root, "src/plugin-sdk"), path.join(resources, "plugin-sdk"), { recursive: true });
  await buildGenex(root, resources, { dependencies });
  const sdk = path.join(root, "src/plugin-sdk");
  await buildBlender(root, resources, sdk);
  await buildUnreal(root, resources, sdk);
  await buildGodot(root, resources, sdk);
  await buildUnity(root, resources, sdk);
  await buildRoblox(root, resources, sdk);
  await mkdir(path.join(resources, "examples"), { recursive: true });
  await cp(path.join(root, "src/plugins/example"), path.join(resources, "examples/example"), { recursive: true });
  const examplePanel = path.join(resources, "examples/example/panel.html");
  await writeFile(examplePanel, await inlinePanelSdk(await readFile(examplePanel, "utf8"), sdk));
  await writeFile(path.join(resources, "catalog.json"), "[]\n");
}
