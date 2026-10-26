/**
 * The §16 conformance vectors through the shipped `@genex-ai/physics` (the `wasm32` build): every
 * vector in `crates/genex-physics/vectors/` is pinned on the native core, so a pass here means this
 * target gives native's hashes, events, refusals and query answers. The runner is the package's
 * `js/conformance.js` (not packed), the same module the headless Chromium rows load into a page.
 *
 * - Node rows load the package from `GENEX_PHYSICS_PACKAGE` (a folder holding `node.js`, e.g. the
 *   unpacked tarball) or `.studio-dev/build/physics-wasm/` (`node scripts/physics-wasm.ts`); without
 *   it they skip, and `GENEX_REQUIRE_TOOLCHAINS=1` makes its absence a failure. The same file runs
 *   unchanged in a linux/amd64 `node:24` container (see `docs/agent/verification.md`).
 * - The runner's own rows (a changed pin is reported, another build's or contract's vector is
 *   refused before any world exists, a malformed vector is a problem and never a throw) need no build.
 * - Chromium rows launch Playwright's headless Chromium (only with `STUDIO_BROWSER_TESTS=1` and a
 *   Chromium already installed; nothing is downloaded, no window opens). Every request the page makes
 *   is answered from disk by a route; any other request is aborted.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as Physics from "../../native/genex-rust/crates/genex-physics/js/index.d.ts";
import {
  buildWithoutTarget,
  runVector,
  type Vector,
  type VectorOutcome,
} from "../../native/genex-rust/crates/genex-physics/js/conformance.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const JS = path.join(REPO, "native/genex-rust/crates/genex-physics/js");
const VECTORS = path.join(REPO, "native/genex-rust/crates/genex-physics/vectors");
const PACKAGE = process.env.GENEX_PHYSICS_PACKAGE ?? path.join(REPO, ".studio-dev/build/physics-wasm");
const PINNED_BUILD = "genex-physics/0.1.0+contract-1.0+rapier-0.36.0+det";
const WASM_BUILD = `${PINNED_BUILD}+wasm32`;
/** The vector the runner's own rows mutate: one step, a stateHash pin, a short run. */
const SMALL_VECTOR = "key-64-bytes.json";
/** A vector with refusals and event counts pinned, for the mutation rows. */
const REFUSING_VECTOR = "hostile-commands-each.json";
/** The page origin the Chromium rows route; nothing is served from the network. */
const ORIGIN = "http://genex-physics.test";
const BROWSER_TIMEOUT_MS = 300_000;

type Package = typeof Physics;

function vectorFiles(): string[] {
  return readdirSync(VECTORS)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function readVector(file: string): Vector {
  return JSON.parse(readFileSync(path.join(VECTORS, file), "utf8"));
}

function needsPackage(): { skip?: string } {
  if (existsSync(path.join(PACKAGE, "node.js"))) return {};
  const missing = `the physics package (${PACKAGE}; node scripts/physics-wasm.ts)`;
  if (process.env.GENEX_REQUIRE_TOOLCHAINS === "1") throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${missing} absent`);
  return { skip: `not run: ${missing} absent` };
}

const gate = needsPackage();
const physics: Package | undefined = gate.skip
  ? undefined
  : await import(pathToFileURL(path.join(PACKAGE, "node.js")).href);

function pkg(): Package {
  assert.ok(physics, "the package loaded");
  return physics;
}

function passes(outcome: VectorOutcome, file: string): void {
  assert.deepEqual(outcome.problems, [], `${file}: ${outcome.problems.join("; ")}`);
  assert.ok(outcome.checks > 0, `${file}: at least one pinned value was compared`);
}

/** A package whose `World.create` only counts, to prove a refused vector opens no world. */
function countingPackage(buildId: string): { physics: Package; created: () => number } {
  let created = 0;
  const create = () => {
    created += 1;
    return { ok: false, code: "internal", detail: "a counting stand-in" };
  };
  const physics = { buildId: () => buildId, World: { create } } as unknown as Package;
  return { physics, created: () => created };
}

describe("@genex-ai/physics: every conformance vector in wasm32 matches native (§16)", gate, () => {
  it("is the wasm32 build of the core the vectors are pinned on", () => {
    assert.equal(pkg().buildId(), WASM_BUILD);
    assert.equal(buildWithoutTarget(pkg().buildId()), PINNED_BUILD);
  });

  for (const file of gate.skip ? [] : vectorFiles()) {
    it(`${file} gives its native pins`, () => passes(runVector(pkg(), readVector(file)), file));
  }
});

describe("the conformance runner reports what differs and refuses what it cannot judge", () => {
  it("strips the target from a buildId, and leaves a buildId without one as it is", () => {
    assert.equal(buildWithoutTarget(WASM_BUILD), PINNED_BUILD);
    assert.equal(buildWithoutTarget(`${PINNED_BUILD}+aarch64-macos`), PINNED_BUILD);
    assert.equal(buildWithoutTarget("genex-physics/0.1.0"), "genex-physics/0.1.0");
  });

  const builds: [string, unknown][] = [
    ["another version", "genex-physics/9.9.9+contract-1.0+rapier-0.36.0+det"],
    ["a buildId with its target", WASM_BUILD],
    ["an empty build", ""],
    ["no build", undefined],
    ["a number", 42],
  ];
  for (const [name, build] of builds) {
    it(`refuses a vector pinned on ${name}, naming both builds, before any world exists`, () => {
      const vector = { ...readVector(SMALL_VECTOR), build } as Vector;
      const { physics, created } = countingPackage(WASM_BUILD);
      const outcome = runVector(physics, vector);
      assert.equal(outcome.problems.length, 1);
      assert.match(outcome.problems[0], /^build: /);
      assert.ok(outcome.problems[0].includes(PINNED_BUILD), outcome.problems[0]);
      assert.equal(created(), 0, "no world was made");
      assert.equal(outcome.checks, 0);
    });
  }

  const malformed: [string, unknown][] = [
    ["another contract", { ...readVector(SMALL_VECTOR), contract: "2.0" }],
    ["no steps", { ...readVector(SMALL_VECTOR), steps: undefined }],
    ["steps that are not a list", { ...readVector(SMALL_VECTOR), steps: { 0: {} } }],
    ["no world", { ...readVector(SMALL_VECTOR), world: null }],
    ["a static world that is not an object", { ...readVector(SMALL_VECTOR), static: "boxes" }],
    ["an unknown mode", { ...readVector(SMALL_VECTOR), mode: "all" }],
    ["not an object", "vector"],
    ["null", null],
  ];
  for (const [name, vector] of malformed) {
    it(`reports a vector with ${name} as one problem, without a throw or a world`, () => {
      const { physics, created } = countingPackage(WASM_BUILD);
      const outcome = runVector(physics, vector as Vector);
      assert.equal(outcome.problems.length, 1, outcome.problems.join("; "));
      assert.equal(created(), 0, "no world was made");
    });
  }
});

describe("the conformance runner on the real package catches a changed pin", gate, () => {
  it("reports a changed stateHash pin with the step, the field and both values", () => {
    const vector = readVector(SMALL_VECTOR);
    const expect = vector.steps[0].expect as Record<string, unknown>;
    const pinned = expect.stateHash as string;
    expect.stateHash = "0000000000000000";
    const outcome = runVector(pkg(), vector);
    assert.equal(outcome.problems.length, 1, outcome.problems.join("; "));
    assert.match(outcome.problems[0], /step 0: stateHash/);
    assert.ok(outcome.problems[0].includes(pinned), "names what this build gave");
  });

  it("reports a changed refusal and a dropped event", () => {
    const vector = readVector(REFUSING_VECTOR);
    const refusing = vector.steps.findIndex((entry) => Array.isArray(entry.expect?.refused));
    assert.ok(refusing >= 0, `${REFUSING_VECTOR} pins a refusal`);
    const expect = vector.steps[refusing].expect as Record<string, unknown>;
    expect.refused = [[0, "internal"]];
    const outcome = runVector(pkg(), vector);
    assert.ok(
      outcome.problems.some((problem) => problem.includes(`step ${refusing}: refused`)),
      outcome.problems.join("; "),
    );

    const withEvents = vectorFiles()
      .map((file) => ({ file, vector: readVector(file) }))
      .flatMap(({ file, vector }) =>
        vector.steps.map((entry, index) => ({ file, vector, index, events: entry.expect?.events })),
      )
      .find(({ events }) => Array.isArray(events) && events.length > 0);
    assert.ok(withEvents, "some vector pins events");
    (withEvents.vector.steps[withEvents.index].expect as Record<string, unknown>).events = (
      withEvents.events as unknown[]
    ).slice(1);
    const dropped = runVector(pkg(), withEvents.vector);
    assert.ok(
      dropped.problems.some((problem) => problem.includes(`step ${withEvents.index}: events`)),
      `${withEvents.file}: ${dropped.problems.join("; ")}`,
    );
  });

  it("reports an expectation it does not know instead of passing it", () => {
    const vector = readVector(SMALL_VECTOR);
    (vector.steps[0].expect as Record<string, unknown>).speed = 1;
    const outcome = runVector(pkg(), vector);
    assert.equal(outcome.problems.length, 1, outcome.problems.join("; "));
    assert.match(outcome.problems[0], /step 0: speed/);
  });
});

/** Why the Chromium rows cannot run here, or undefined when they can. */
async function browserSkip(): Promise<string | undefined> {
  if (gate.skip) return gate.skip;
  if (process.env.STUDIO_BROWSER_TESTS !== "1") return "launches Chromium; set STUDIO_BROWSER_TESTS=1 to run";
  const { playwrightHeadlessChromiumOnDisk } = await import("../helpers/playwright-chromium.ts");
  if (!playwrightHeadlessChromiumOnDisk()) return "not run: Playwright's headless Chromium is not installed";
  return undefined;
}

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".html": "text/html",
};

/** The file a page path maps to: `/pkg/…` the package, `/runner/conformance.js`, `/vectors/…`. */
function routed(pathname: string): string | undefined {
  const roots: [string, string][] = [
    ["/pkg/", PACKAGE],
    ["/vectors/", VECTORS],
  ];
  if (pathname === "/runner/conformance.js") return path.join(JS, "conformance.js");
  for (const [prefix, root] of roots) {
    if (!pathname.startsWith(prefix)) continue;
    const file = path.resolve(root, `.${pathname.slice(prefix.length - 1)}`);
    return file.startsWith(`${root}${path.sep}`) && existsSync(file) ? file : undefined;
  }
  return undefined;
}

/** What the page reports: the browser, the build and each vector's outcome. */
interface BrowserReport {
  userAgent: string;
  buildId: string;
  outcomes: { file: string; outcome: VectorOutcome }[];
}

const browserGate = { skip: await browserSkip(), timeout: BROWSER_TIMEOUT_MS };

describe("@genex-ai/physics in headless Chromium: every conformance vector matches native", browserGate, () => {
  it("loads the browser entry with init() and passes every vector", async (t) => {
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== ORIGIN) return route.abort();
        if (url.pathname === "/")
          return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>v</title>" });
        const file = routed(url.pathname);
        if (!file) return route.fulfill({ status: 404, body: "" });
        return route.fulfill({
          contentType: CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
          body: readFileSync(file),
        });
      });
      await page.goto(`${ORIGIN}/`);
      const modules = { physics: "/pkg/index.js", runner: "/runner/conformance.js" };
      const report: BrowserReport = await page.evaluate(
        async ({ files, modules }) => {
          const physics: Package = await import(modules.physics);
          const runner: { runVector: typeof runVector } = await import(modules.runner);
          await physics.init();
          const outcomes = [];
          for (const file of files) {
            const vector = await (await fetch(`/vectors/${file}`)).json();
            outcomes.push({ file, outcome: runner.runVector(physics, vector) });
          }
          return { userAgent: navigator.userAgent, buildId: physics.buildId(), outcomes };
        },
        { files: vectorFiles(), modules },
      );
      t.diagnostic(`browser: ${report.userAgent}`);
      assert.equal(report.buildId, WASM_BUILD);
      assert.deepEqual(
        report.outcomes.map(({ file }) => file),
        vectorFiles(),
      );
      for (const { file, outcome } of report.outcomes) passes(outcome, file);
    } finally {
      await browser.close();
    }
  });
});
