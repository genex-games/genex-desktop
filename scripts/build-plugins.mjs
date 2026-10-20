import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

/** The CC0 Library: its manifest, its panel with the SDK inlined, and its backend bundled with the CC0 fetch core. */
async function buildCc0(root, resources, sdk) {
  const cc0 = path.join(resources, "plugins/cc0");
  await mkdir(cc0, { recursive: true });
  await cp(path.join(root, "src/plugins/cc0/plugin.json"), path.join(cc0, "plugin.json"));
  await writeFile(
    path.join(cc0, "panel.html"),
    await inlinePanelSdk(await readFile(path.join(root, "src/plugins/cc0/panel.html"), "utf8"), sdk),
  );
  await build({
    ...NODE_BACKEND,
    entryPoints: [path.join(root, "src/plugins/cc0/backend.ts")],
    outfile: path.join(cc0, "backend.mjs"),
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

/** Copies the SDK and builds the bundled plugins (and the example) into the app's resources. */
export async function buildPlugins(root, resources, { dependencies = true } = {}) {
  await cp(path.join(root, "src/plugin-sdk"), path.join(resources, "plugin-sdk"), { recursive: true });
  await buildGenex(root, resources, { dependencies });
  const sdk = path.join(root, "src/plugin-sdk");
  await buildBlender(root, resources, sdk);
  await buildCc0(root, resources, sdk);
  await buildUnreal(root, resources, sdk);
  await mkdir(path.join(resources, "examples"), { recursive: true });
  await cp(path.join(root, "src/plugins/example"), path.join(resources, "examples/example"), { recursive: true });
  const examplePanel = path.join(resources, "examples/example/panel.html");
  await writeFile(examplePanel, await inlinePanelSdk(await readFile(examplePanel, "utf8"), sdk));
  await writeFile(path.join(resources, "catalog.json"), "[]\n");
}
