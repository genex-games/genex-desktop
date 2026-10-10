import { rendererBuildOptions, rendererBundleReport } from "./renderer-build.mjs";
import { mainStartupReport } from "./main-build.mjs";
import { buildPlugins } from "./build-plugins.mjs";
import { assertThreeLibsListed, stylesheetPackages, writeBundledNotices } from "./third-party-notices.mjs";
import { patchSandboxRuntime } from "./patch-sandbox-runtime.mjs";
await patchSandboxRuntime();
import fsSync from "node:fs";
import { sourceIdentity, safeChild, publishBuild } from "./studio-dev/files.mjs";
import { devRoot, slug } from "./studio-dev/ownership.mjs";
import { SEED_GENERATED } from "./gen-harness-types.ts";
import { packageBin } from "./package-bin.ts";
import { vendorTsc } from "./vendor-tsc.ts";
/**
 * Build — assembles `dist/` for Electron.
 *
 *   dist/main/main.mjs        substrate + app shell (ESM, Electron 43 supports ESM main)
 *   dist/preload/preload.cjs  renderer bridge (sandboxed preloads must be CommonJS)
 *   dist/renderer/*           React UI
 *   dist/resources/*          read-only app resources: the harness seed, the bootstrap, the game
 *                             template, vendored three.js, and the TypeScript 7 compiler the
 *                             in-app type gate runs (dist/resources/tsc, scripts/vendor-tsc.ts)
 *
 * esbuild only, deliberately: one tool, no plugin-compatibility surface, and the game workspaces
 * need no bundler at all (import maps + vendored three).
 */
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const devId = process.argv.find((x) => x.startsWith("--dev-build="))?.slice(12);
if (process.argv.some((x) => x.startsWith("--out") || (x.startsWith("--dev") && !x.startsWith("--dev-build="))))
  throw new Error("Use only --dev-build=<owned-build-id>");
const dist = devId ? safeChild(devRoot(root), `builds/${slug(devId)}`) : path.join(root, "dist");
const sourceBefore = devId ? sourceIdentity(root) : null;
if (devId && (process.argv.includes("--watch") || fsSync.existsSync(dist)))
  throw new Error("Development builds are immutable and cannot watch or overwrite");
const watch = process.argv.includes("--watch");
const release = process.argv.includes("--release");
if (release && (watch || devId)) throw new Error("Release builds cannot watch or use --dev-build");
// React's production build, but for watch and owned development builds (renderer-build.mjs). An
// owned build timed for docs/performance.md asks for production React (`STUDIO_REACT=production`):
// development React times every render and overstates what a packaged app costs.
const timedBuild = Boolean(devId) && process.env.STUDIO_REACT === "production";
// An owned fixture profile's checks read React commit counts (`renderer/performance.tsx`); a timed
// build's production React has no Profiler to count them.
if (process.argv.includes("--commit-counts") && !devId) throw new Error("--commit-counts needs --dev-build");
const commitCounts = process.argv.includes("--commit-counts") && !timedBuild;
const rendererMode = { release, development: watch || (Boolean(devId) && !timedBuild), commitCounts };

/**
 * Kept out of the bundle: Electron itself, and packages that resolve their own binaries.
 * The MCP SDK joins them because the connector client reaches it through deep subpath imports
 * (`client/stdio.js`, `client/streamableHttp.js`, …) and it drags in ajv, express and cross-spawn
 * transitively; forge keeps production dependencies, so those subpaths resolve from node_modules
 * inside the asar exactly as the agent SDK's do.
 */
const external = [
  "electron",
  "node-pty",
  "@anthropic-ai/sandbox-runtime",
  "@anthropic-ai/claude-agent-sdk",
  "@modelcontextprotocol/sdk",
];

const shared = {
  bundle: true,
  metafile: true,
  platform: "node",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
  external,
  define: {
    __STUDIO_REACT__: JSON.stringify(rendererMode.development ? "development" : "production"),
    __STUDIO_DEV_BUILD__: JSON.stringify(devId ? { checkout: fsSync.realpathSync(root), buildId: devId } : null),
  },
};

/** The main process, its terminal host and the preload: Node bundles. */
async function nodeContexts() {
  return [
    await esbuild.context({
      ...shared,
      entryPoints: [path.join(root, "src/main/terminal-host.ts")],
      outfile: path.join(dist, "resources/terminal/host.cjs"),
      format: "cjs",
    }),
    await esbuild.context({
      ...shared,
      entryPoints: [path.join(root, "src/main/index.ts")],
      outfile: path.join(dist, "main/main.mjs"),
      format: "esm",
      // ESM output in a CJS-ish host: give bundled deps their expected globals.
      banner: {
        js: [
          "import { createRequire as __createRequire } from 'node:module';",
          "import { fileURLToPath as __fileURLToPath } from 'node:url';",
          "import { dirname as __dirname_fn } from 'node:path';",
          "const require = __createRequire(import.meta.url);",
          "const __filename = __fileURLToPath(import.meta.url);",
          "const __dirname = __dirname_fn(__filename);",
        ].join("\n"),
      },
    }),
    await esbuild.context({
      ...shared,
      entryPoints: [path.join(root, "src/preload/index.ts")],
      outfile: path.join(dist, "preload/preload.cjs"),
      format: "cjs",
    }),
  ];
}

/** The renderer, its Basis decoder worker and the startup loader's scripts: browser bundles. */
async function rendererContexts() {
  return [
    await esbuild.context({
      ...rendererBuildOptions(rendererMode),
      define: {
        ...rendererBuildOptions(rendererMode).define,
        __STUDIO_PERFORMANCE__: JSON.stringify(Boolean(devId)),
      },
      bundle: true,
      platform: "browser",
      metafile: true,
      target: "chrome130",
      sourcemap: true,
      logLevel: "info",
      format: "esm",
      jsx: "automatic",
      entryPoints: [path.join(root, "src/renderer/main.tsx")],
      outdir: path.join(dist, "renderer"),
      entryNames: "renderer",
      chunkNames: "chunks/[name]-[hash]",
      splitting: true,
      loader: { ".css": "css" },
    }),
    await esbuild.context({
      bundle: true,
      platform: "browser",
      target: "chrome130",
      format: "iife",
      logLevel: "info",
      define: { "import.meta.url": "self.location.href" },
      entryPoints: [path.join(root, "src/renderer/asset-basis-worker.js")],
      outfile: path.join(dist, "renderer/decoders/basis/worker-runtime.js"),
    }),
    // The classic script index.html runs before the bundle: the first paint's theme.
    ...(await Promise.all(
      [["src/renderer/appearance/first-paint.ts", "renderer/first-paint.js"]].map(([entry, outfile]) =>
        esbuild.context({
          bundle: true,
          platform: "browser",
          target: "chrome130",
          format: "iife",
          minify: true,
          logLevel: "info",
          entryPoints: [path.join(root, entry)],
          outfile: path.join(dist, outfile),
        }),
      ),
    )),
  ];
}

// The page world: the studio's own code, served onto every game page before the game runs.
// Bundled rather than injected as a string — it is several modules, and observer.ts's
// toString() trick forbids module-level helpers. The shim is a classic script (it must run
// before every module script); the hook is a module (it must follow the import map).
//
// hook.js is its own bundle, addressed by URL: the wrapper module the serve layer generates for
// a page's `three` imports "/vendor/studio/hook.js", and so does hook-entry.js. Bundling the
// hook INTO hook-entry.js would put two copies of it on the same page, each with its own
// records and its own idea of the world — so that specifier stays external in every bundle.
const HOOK_URL = "/vendor/studio/hook.js";
const PAGE_BUNDLES = [
  ["src/page/entry.ts", "resources/vendor/studio/shim.js", "iife"],
  ["src/page/hook.ts", "resources/vendor/studio/hook.js", "esm"],
  ["src/page/hook-entry.ts", "resources/vendor/studio/hook-entry.js", "esm"],
];

async function pageContexts() {
  const contexts = [];
  for (const [entry, outfile, format] of PAGE_BUNDLES) {
    contexts.push(
      await esbuild.context({
        bundle: true,
        platform: "browser",
        metafile: true,
        target: "es2022",
        sourcemap: true,
        logLevel: "info",
        format,
        external: [HOOK_URL],
        entryPoints: [path.join(root, entry)],
        outfile: path.join(dist, outfile),
      }),
    );
  }
  return contexts;
}

/** Watches every context, or builds each once; returns the inputs the one-off builds bundled. */
async function runContexts(contexts) {
  const bundledInputs = new Set();
  for (const context of contexts) {
    if (watch) {
      await context.watch();
      continue;
    }
    const result = await context.rebuild();
    if (Object.values(result.metafile?.outputs ?? {}).some((output) => output.entryPoint === "src/renderer/main.tsx")) {
      const report = rendererBundleReport(result.metafile, rendererMode);
      await writeFile(path.join(dist, "renderer/bundle-report.json"), JSON.stringify(report));
    }
    if (result.metafile) mainStartupReport(result.metafile);
    for (const input of Object.keys(result.metafile?.inputs ?? {})) bundledInputs.add(input);
    await context.dispose();
  }
  return bundledInputs;
}

async function buildAll() {
  if (!devId) await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  const contexts = [...(await nodeContexts()), ...(await rendererContexts()), ...(await pageContexts())];
  const bundledInputs = await runContexts(contexts);
  await buildTheme();
  await copyResources();
  if (watch) watchPlugins();
  if (!watch) await shipBundledNotices(bundledInputs);
  if (devId) publishBuild(root, dist, devId, sourceBefore);
  console.log(`built → ${path.relative(root, dist)}${watch ? " (watching)" : ""}`);
}
/**
 * Plugin packages are copied and bundled by `buildPlugins`, not by esbuild's own watchers, so in
 * watch mode nothing noticed an edit to a plugin until now: the author saved, the app reloaded,
 * and the old backend was still there. Watch the three source trees `copyResources` reads and
 * redo just the plugin step, debounced and serialized so a burst of saves is one rebuild.
 * Dependencies are skipped: the vendored Genex CLI does not change while someone edits a plugin.
 */
function watchPlugins() {
  const resources = path.join(dist, "resources");
  let timer = null;
  let running = Promise.resolve();
  const rebuild = () => {
    running = running.then(async () => {
      try {
        await buildPlugins(root, resources, { dependencies: false });
        console.log("plugins rebuilt");
      } catch (error) {
        console.error(`plugin rebuild failed: ${error.message}`);
      }
    });
  };
  for (const relative of ["src/plugins", "src/plugin-sdk", "src/genex-host"]) {
    try {
      fsSync.watch(path.join(root, relative), { recursive: true }, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(rebuild, 300);
      });
    } catch (error) {
      console.error(`not watching ${relative}: ${error.message}`);
    }
  }
}

/**
 * The UI's stylesheet is the Genex Tailwind design system (src/renderer/theme.css), so the
 * one extra tool in this build is the Tailwind CLI. It scans src/renderer and emits a plain CSS
 * file; nothing else in the pipeline (or in anything the agent edits at runtime) touches it.
 */
function buildTheme() {
  // Its package's own entry, run by this Node: node_modules/.bin holds a shell script on Windows.
  const args = [
    packageBin("@tailwindcss/cli", "tailwindcss", root),
    "-i",
    path.join(root, "src/renderer/theme.css"),
    "-o",
    path.join(dist, "renderer/theme.css"),
    ...(watch ? ["--watch"] : ["--minify"]),
  ];
  const child = spawn(process.execPath, args, { stdio: ["ignore", "inherit", "inherit"] });
  if (watch) return Promise.resolve(); // keeps running alongside the esbuild watchers
  return new Promise((resolve, reject) => {
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tailwind exited ${code}`))));
    child.on("error", reject);
  });
}

async function copyResources() {
  const resources = path.join(dist, "resources");
  await mkdir(path.join(resources, "windows-native"), { recursive: true });
  for (const file of ["windows-native.cs", "windows-native.ps1"])
    await cp(path.join(root, "src/substrate/plugins", file), path.join(resources, "windows-native", file));
  await mkdir(resources, { recursive: true });

  // The agent-editable self, seeded into userData on first launch.
  await cp(path.join(root, "src/harness-seed"), path.join(resources, "harness-seed"), { recursive: true });
  // Its copy of the host RPC contract (the types and the `HostMethod` names), generated from
  // src/shared/harness-api.ts as it is now: the seed cannot import src/shared, and a stale
  // committed copy must not ship.
  for (const { seedFile, generate } of SEED_GENERATED)
    await writeFile(path.join(resources, "harness-seed", seedFile), generate(root));
  // The compiler that type-checks the agent's own code edits before they are accepted — copied
  // from the platform package npm already installed, never downloaded (substrate/type-gate.ts).
  const tsc = await vendorTsc(root, resources);
  console.log(
    `vendored tsc: ${Object.entries(tsc.bytes)
      .map(([id, bytes]) => `${id} ${(bytes / 1024 / 1024).toFixed(1)} MB`)
      .join(", ")}`,
  );
  await buildPlugins(root, resources);
  // The stable bootstrap — shipped, never edited by the agent.
  await cp(path.join(root, "src/genex-host"), path.join(resources, "genex-host"), { recursive: true });
  await cp(path.join(root, "src/harness-boot"), path.join(resources, "harness-boot"), { recursive: true });
  // The game template.
  await cp(path.join(root, "src/game-template"), path.join(resources, "game-template"), { recursive: true });

  // Every library three.js vendors (copied below for games, two decoders for the Assets viewer)
  // has its license in THIRD-PARTY-NOTICES.md, which ships beside each copy.
  const threeLibs = path.join(root, "node_modules/three/examples/jsm/libs");
  assertThreeLibsListed(threeLibs, await readFile(path.join(root, "THIRD-PARTY-NOTICES.md"), "utf8"));
  await mkdir(path.join(dist, "renderer/decoders"), { recursive: true });
  await cp(path.join(root, "THIRD-PARTY-NOTICES.md"), path.join(dist, "renderer/decoders/THIRD-PARTY-NOTICES.md"));
  // The Assets viewer decodes compressed models entirely offline.
  for (const folder of ["basis", "draco/gltf"]) {
    await cp(
      path.join(root, "node_modules/three/examples/jsm/libs", folder),
      path.join(dist, "renderer/decoders", folder),
      { recursive: true },
    );
  }
  await cp(path.join(root, "src/renderer/asset-basis-entry.js"), path.join(dist, "renderer/decoders/basis/worker.js"));
  // Vendored three.js: games run with no network and no package manager.
  const vendor = path.join(resources, "vendor");
  await mkdir(vendor, { recursive: true });
  await cp(path.join(root, "node_modules/three/build/three.module.js"), path.join(vendor, "three.module.js"));
  await cp(path.join(root, "node_modules/three/build/three.core.js"), path.join(vendor, "three.core.js"));
  for (const file of ["three.webgpu.js", "three.tsl.js"])
    await cp(path.join(root, "node_modules/three/build", file), path.join(vendor, file));
  await cp(path.join(root, "node_modules/three/examples/jsm"), path.join(vendor, "three/examples/jsm"), {
    recursive: true,
  });
  await cp(path.join(root, "node_modules/three/LICENSE"), path.join(vendor, "three-LICENSE"));
  await cp(path.join(root, "THIRD-PARTY-NOTICES.md"), path.join(vendor, "THIRD-PARTY-NOTICES.md"));
  await writeFile(
    path.join(vendor, "VERSION.json"),
    `${JSON.stringify(
      {
        three: JSON.parse(
          await (await import("node:fs/promises")).readFile(path.join(root, "node_modules/three/package.json"), "utf8"),
        ).version,
        vendoredAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );

  // Renderer shell + vendored fonts (offline app; the CSP admits no font host).
  await cp(path.join(root, "src/renderer/index.html"), path.join(dist, "renderer/index.html"));
  await cp(path.join(root, "src/renderer/fonts"), path.join(dist, "renderer/fonts"), {
    recursive: true,
    filter: (source) => !source.endsWith("urls.txt"),
  });
  // Bundled media (the Genex promo's video and poster, rendered from design/genex-promo-video).
  await cp(path.join(root, "src/renderer/media"), path.join(dist, "renderer/media"), { recursive: true });
}

await buildAll();

/**
 * Ship the notices of everything bundled: esbuild's inputs, the packages the stylesheet imports
 * (the Tailwind CLI compiles those), vendored three.js and node-pty (scripts/third-party-notices.mjs).
 */
async function shipBundledNotices(bundledInputs) {
  const stylesheet = await readFile(path.join(root, "src/renderer/theme.css"), "utf8");
  const inputs = [
    ...bundledInputs,
    ...stylesheetPackages(stylesheet),
    "node_modules/three/build/three.module.js",
    "node_modules/node-pty/lib/index.js",
  ];
  await writeBundledNotices({ root, dist, inputs });
}
