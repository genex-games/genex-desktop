import assert from "node:assert/strict";
import { test } from "node:test";
import { build, type Metafile } from "esbuild";
import { rendererBuildOptions, rendererBundleReport } from "../../scripts/renderer-build.mjs";

const DEVELOPMENT_REACT = /react.*\/cjs\/.*\.development\.js$/;

// React's development build keeps a User Timing measure per component render; shipped in
// `npm start` builds it filled the UI renderer's memory during a long Autopilot run. Only watch
// and owned `--dev-build` builds (`development`) keep it.
const MODES = [
  { name: "watch or owned development", mode: { development: true }, development: true },
  { name: "plain (npm run build, npm start)", mode: {}, development: false },
  { name: "release", mode: { release: true }, development: false },
] as const;

async function bundleReactDom(mode: Parameters<typeof rendererBuildOptions>[0]): Promise<Metafile> {
  const result = await build({
    stdin: {
      contents: 'import {createRoot} from "react-dom/client"; console.log(createRoot)',
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    metafile: true,
    logLevel: "silent",
    platform: "browser",
    ...rendererBuildOptions(mode),
  });
  return result.metafile;
}

for (const { name, mode, development } of MODES) {
  test(`${name} renderer selects the intended React runtime`, async () => {
    const inputs = Object.keys((await bundleReactDom(mode)).inputs);
    assert.equal(
      inputs.some((file) => DEVELOPMENT_REACT.test(file)),
      development,
    );
    if (!development) assert.ok(inputs.some((file) => file.endsWith("react-dom/cjs/react-dom-client.production.js")));
  });
}

test("a release cannot ask for development React", () => {
  assert.throws(() => rendererBuildOptions({ release: true, development: true }));
});

test("the bundle report refuses development React outside a development build", async () => {
  const metafile = await bundleReactDom({ development: true });
  assert.throws(() => rendererBundleReport(metafile, {}), /Development React/);
  assert.throws(() => rendererBundleReport(metafile, { release: true }), /Development React/);
  assert.equal(rendererBundleReport(metafile, { development: true }).react, "development");
  assert.equal(rendererBundleReport(await bundleReactDom({}), {}).react, "production");
});

/** The app's `PerformanceBoundary` as one renderer build compiles it, and React's `Profiler` beside it. */
async function performanceBoundary(mode: Parameters<typeof rendererBuildOptions>[0]) {
  const result = await build({
    stdin: {
      contents:
        'export { PerformanceBoundary } from "./src/renderer/performance.tsx"; export { Profiler } from "react";',
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "esm",
    jsx: "automatic",
    logLevel: "silent",
    platform: "browser",
    ...rendererBuildOptions(mode),
  });
  const code = result.outputFiles[0]?.text ?? "";
  Object.assign(globalThis, { window: globalThis });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

// Development React logs every render inside a Profiler to the performance timeline with a diff of
// its props: around the whole app, that was 70% of a live session's main thread while a run
// streamed, and fast scrolling outran it. Only the fixture builds whose checks read commit counts
// profile renders.
for (const { name, mode, profiled } of [
  { name: "a fixture's owned build", mode: { development: true, commitCounts: true }, profiled: true },
  { name: "a live owned build", mode: { development: true }, profiled: false },
  { name: "a plain build", mode: {}, profiled: false },
  { name: "a packaged build", mode: { release: true }, profiled: false },
]) {
  test(`${name} ${profiled ? "profiles" : "does not profile"} renders`, async () => {
    const { PerformanceBoundary, Profiler } = await performanceBoundary(mode);
    const shown = PerformanceBoundary({ id: "App", children: "app" });
    assert.equal(shown?.type === Profiler, profiled);
    if (!profiled) assert.ok(shown === "app" || shown.props.children === "app", "no Profiler wraps the app");
  });
}

test("only development React can count commits", () => {
  assert.throws(() => rendererBuildOptions({ commitCounts: true }), /development/);
});

/** A renderer build's outputs: the entry, the studio it loads after the language, and one language. */
function splitMetafile(studioInputs: Record<string, object>): Metafile {
  const output = (entryPoint: string, bytes: number, inputs: Record<string, object>, imports: object[] = []) => ({
    entryPoint,
    bytes,
    inputs,
    imports,
    exports: [],
  });
  return {
    inputs: {},
    outputs: {
      "dist/renderer/renderer.js": output("src/renderer/main.tsx", 100, { "src/renderer/main.tsx": {} }, [
        { path: "dist/renderer/chunks/studio-entry.js", kind: "dynamic-import" },
        { path: "dist/renderer/chunks/ru.js", kind: "dynamic-import" },
      ]),
      "dist/renderer/chunks/studio-entry.js": output("src/renderer/studio-entry.tsx", 5_000, studioInputs),
      "dist/renderer/chunks/ru.js": output("src/shared/locales/ru.ts", 9_000_000, { "src/shared/locales/ru.ts": {} }),
    },
  } as unknown as Metafile;
}

test("the eager budget counts the studio the entry loads after the language, never the languages", () => {
  const report = rendererBundleReport(splitMetafile({ "src/renderer/App.tsx": {} }), { release: true });
  assert.equal(report.entryBytes, 5_100);
  assert.throws(
    () => rendererBundleReport(splitMetafile({ "node_modules/three/build/three.module.js": {} }), {}),
    /three\.js/,
  );
});
