import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { inlinePanelSdk } from "../src/plugin-sdk/inline-panel-sdk.mjs";
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

async function buildGenex(root, resources, { dependencies }) {
  const target = path.join(resources, "plugins/genex");
  await mkdir(target, { recursive: true });
  for (const file of ["plugin.json", "icon.png", "publish.html"])
    await cp(path.join(root, "src/plugins/genex", file), path.join(target, file));
  await cp(path.join(root, "src/genex-host/preload.mjs"), path.join(target, "preload.mjs"));
  await cp(path.join(root, "src/genex-host/stdio-fetch.mjs"), path.join(target, "stdio-fetch.mjs"));
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

/** Unity's SDK backend and reviewed local UPM package ship as one plugin. */
async function buildUnity(root, resources, sdk) {
  const unity = path.join(resources, "plugins/unity");
  const source = path.join(root, "src/plugins/unity");
  await mkdir(unity, { recursive: true });
  for (const file of ["plugin.json", "icon.svg"]) await cp(path.join(source, file), path.join(unity, file));
  for (const directory of ["skills", "editor-package"])
    await cp(path.join(source, directory), path.join(unity, directory), { recursive: true });
  await writeFile(
    path.join(unity, "panel.html"),
    await inlinePanelSdk(await readFile(path.join(source, "panel.html"), "utf8"), sdk),
  );
  await build({
    ...NODE_BACKEND,
    entryPoints: [path.join(source, "backend.ts")],
    outfile: path.join(unity, "backend.mjs"),
  });
}

/** Copies the SDK and builds the bundled plugins (and the example) into the app's resources. */
export async function buildPlugins(root, resources, { dependencies = true } = {}) {
  await cp(path.join(root, "src/plugin-sdk"), path.join(resources, "plugin-sdk"), { recursive: true });
  await buildGenex(root, resources, { dependencies });
  const sdk = path.join(root, "src/plugin-sdk");
  await buildBlender(root, resources, sdk);
  await buildUnity(root, resources, sdk);
  await mkdir(path.join(resources, "examples"), { recursive: true });
  await cp(path.join(root, "src/plugins/example"), path.join(resources, "examples/example"), { recursive: true });
  const examplePanel = path.join(resources, "examples/example/panel.html");
  await writeFile(examplePanel, await inlinePanelSdk(await readFile(examplePanel, "utf8"), sdk));
  await writeFile(path.join(resources, "catalog.json"), "[]\n");
}
