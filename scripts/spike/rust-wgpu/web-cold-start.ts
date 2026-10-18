/**
 * The web cold-start spike (renderer pass 2, A.12; owner decision D5: a pre-warm spike before any
 * wgpu `[patch]`). wgpu 30 creates every pipeline with WebGPU's synchronous
 * `createRenderPipeline`, so Chrome compiles them one after another before the first frame. This
 * measures a packaged web build's cold start (first lit frame) in Playwright's headless Chromium on
 * the Mac's GPU, and what pre-warming the same pipelines with `createRenderPipelineAsync` would buy.
 *
 *   node scripts/spike/rust-wgpu/web-cold-start.ts [--dir <packaged folder>] [--runs 5] [--out <json>]
 *
 * <dir> is a folder `web-showcase.sh` (or the lane) packaged; it defaults to the showcase's in the
 * cargo target folder. Three modes run, each `--runs` times, in a new browser (a fresh profile, so
 * Chrome's shader caches are cold) and interleaved:
 * - `measure`: the page as it ships; the page-side hooks only count and time.
 * - `record` (once, first): every shader module, bind group layout, pipeline layout and pipeline
 *   the page creates up to its first lit frame, written down as JSON.
 * - `prewarm`: the same page, but when the page's `requestDevice` resolves, the recorded pipelines
 *   are created with `create*PipelineAsync` (Dawn compiles them in parallel) and awaited before
 *   wgpu gets the device; wgpu's synchronous calls then find them in Dawn's pipeline cache. This
 *   is the upper bound of a shipped pre-warm (which would need the list at build time), not one.
 * A `warm` row loads the page a second time in the `measure` browser (Chrome's disk cache warm).
 * `--cold-shaders` perturbs every page's WGSL ({@link shaderNonce}) so no shader cache, Chrome's
 * or the system's Metal one, answers it: the first start on a machine that never ran the game.
 *
 * Times are the page's `performance.now()` (from navigation start): `device` when wgpu's device
 * arrives, `firstFrame` when the GPU finished the first frame drawn to the canvas, `running` when
 * the shell's status says so.
 */
import { createReadStream } from "node:fs";
import { lstat, realpath, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";
import { randomInt } from "node:crypto";
import { type Browser, chromium } from "@playwright/test";
import { SECOND_MS } from "../../../src/shared/duration.ts";

const REPO = path.resolve(import.meta.dirname, "../../..");
const DEFAULT_DIR = path.join(REPO, ".studio-dev", "cargo-target", "genex-web", "showcase");
const DEFAULT_RUNS = 5;
/** How many distinct perturbed literals `--cold-shaders` draws from (0.5 + k * 1e-7). */
const NONCE_STEPS = 2000;
/** How long a page may take to its first lit frame. */
const FIRST_FRAME_TIMEOUT_MS = 120 * SECOND_MS;
/** Chromium's WebGPU on the Mac's GPU (Metal), as tests/conformance/rust-web-render.test.ts. */
const CHROMIUM_ARGS = ["--enable-unsafe-webgpu", "--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"];
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

const Mode = { Measure: "measure", Record: "record", Prewarm: "prewarm", Warm: "warm" } as const;
type Mode = (typeof Mode)[keyof typeof Mode];

/** What the page-side hooks report. */
interface ColdReport {
  device: number | null;
  prewarmed: number | null;
  firstFrame: number | null;
  running: number | null;
  renderPipelines: number;
  computePipelines: number;
  shaderModules: number;
  prewarmPipelines: number;
  prewarmErrors: number;
  recording: string | null;
}

/** What the page-side hooks are told: record, pre-warm from a recording, perturb the shaders. */
interface Hooks {
  record: boolean;
  recording: string | null;
  /** Every `0.5` in the WGSL the page sends is this literal instead (a fresh one per page). */
  nonce: string | null;
}

/**
 * A float literal near 0.5 unique to one page load: with `--cold-shaders` each load's WGSL, and so
 * the MSL Dawn writes, differs, so neither Chrome's nor the system's Metal shader cache can answer
 * it (a first-ever cold start); the numbers drawn change by at most 2e-4, which a timing ignores.
 * Two loads draw the same literal once in {@link NONCE_STEPS}: such a load is as fast as a warm
 * one, so the summary takes medians.
 */
function shaderNonce(): string {
  return (0.5 + randomInt(1, NONCE_STEPS) * 1e-7).toFixed(7);
}

/** One measured page load. */
interface Row extends ColdReport {
  mode: Mode;
  run: number;
}

/** A static server over one packaged folder. */
async function serve(root: string): Promise<{ origin: string; close: () => void }> {
  const server = http.createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    const file = path.join(root, path.normalize(pathname));
    const stat = await lstat(file).catch(() => null);
    if (!file.startsWith(`${root}${path.sep}`) || !stat?.isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

/**
 * The page-side hooks, serialized into the page before its scripts run: counts and times on
 * GPUDevice's creation calls, the first canvas frame's completion, and (with a recording) the
 * pre-warm inside `requestDevice`.
 */
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: a function serialized into the page, whole.
function pageHooks(options: Hooks): void {
  type Json = Record<string, unknown>;
  const report = {
    device: null as number | null,
    prewarmed: null as number | null,
    firstFrame: null as number | null,
    running: null as number | null,
    renderPipelines: 0,
    computePipelines: 0,
    shaderModules: 0,
    prewarmPipelines: 0,
    prewarmErrors: 0,
    recording: null as string | null,
  };
  (window as unknown as { __cold: typeof report }).__cold = report;
  const ids = new WeakMap<object, number>();
  const rec = { objects: [] as Json[], pipelines: [] as Json[] };
  let frameOpen = false;
  const refOf = (value: unknown): unknown => {
    if (value && typeof value === "object" && ids.has(value)) return { $ref: ids.get(value) };
    if (Array.isArray(value)) return value.map(refOf);
    if (value && typeof value === "object") {
      const out: Json = {};
      for (const key in value) out[key] = refOf((value as Json)[key]);
      return out;
    }
    return value;
  };
  const remember = (made: object, kind: string, desc: unknown): void => {
    if (!options.record) return;
    ids.set(made, rec.objects.length);
    rec.objects.push({ kind, desc: refOf(desc) });
  };
  // The WebGPU interfaces by name (the project's TypeScript has no WebGPU types).
  type Fn = (this: unknown, ...args: unknown[]) => unknown;
  type Gpu = Record<string, (desc: unknown) => unknown>;
  const proto = (name: string) =>
    (globalThis as unknown as Record<string, { prototype: Record<string, Fn> }>)[name].prototype;
  const device = proto("GPUDevice");
  const wrap = (name: string, kind: string, count: () => void) => {
    const original = device[name];
    device[name] = function (this: unknown, desc: unknown) {
      count();
      const code = (desc as { code?: string }).code;
      const sent = options.nonce && code ? { ...(desc as Json), code: code.replaceAll("0.5", options.nonce) } : desc;
      const made = original.call(this, sent) as object;
      if (kind === "render" || kind === "compute") {
        if (options.record && report.firstFrame === null) rec.pipelines.push({ kind, desc: refOf(desc) });
      } else remember(made, kind, desc);
      return made;
    };
  };
  wrap("createShaderModule", "module", () => report.shaderModules++);
  wrap("createBindGroupLayout", "bgl", () => {});
  wrap("createPipelineLayout", "layout", () => {});
  wrap("createRenderPipeline", "render", () => report.renderPipelines++);
  wrap("createComputePipeline", "compute", () => report.computePipelines++);
  const canvas = proto("GPUCanvasContext");
  const getTexture = canvas.getCurrentTexture;
  canvas.getCurrentTexture = function (this: unknown) {
    if (report.firstFrame === null) frameOpen = true;
    return getTexture.call(this);
  };
  const queue = proto("GPUQueue");
  const submit = queue.submit;
  queue.submit = function (this: unknown, buffers: unknown) {
    submit.call(this, buffers);
    if (!frameOpen) return;
    frameOpen = false;
    (this as { onSubmittedWorkDone(): Promise<void> }).onSubmittedWorkDone().then(() => {
      if (report.firstFrame !== null) return;
      report.firstFrame = performance.now();
      if (options.record) report.recording = JSON.stringify(rec);
    });
  };
  const revive = (made: unknown[], value: unknown): unknown => {
    if (Array.isArray(value)) return value.map((v) => revive(made, v));
    if (value && typeof value === "object") {
      if ("$ref" in value) return made[(value as { $ref: number }).$ref];
      const out: Json = {};
      for (const key in value) out[key] = revive(made, (value as Json)[key]);
      return out;
    }
    return value;
  };
  const prewarm = async (gpu: Gpu, recording: string): Promise<void> => {
    const plan = JSON.parse(recording) as typeof rec;
    const made: unknown[] = [];
    const create: Record<string, string> = {
      module: "createShaderModule",
      bgl: "createBindGroupLayout",
      layout: "createPipelineLayout",
    };
    for (const object of plan.objects) made.push(gpu[create[object.kind as string]](revive(made, object.desc)));
    report.prewarmPipelines = plan.pipelines.length;
    await Promise.all(
      plan.pipelines.map((p) => {
        const call = p.kind === "render" ? "createRenderPipelineAsync" : "createComputePipelineAsync";
        return (gpu[call](revive(made, p.desc)) as Promise<unknown>).catch(() => {
          report.prewarmErrors++;
        });
      }),
    );
  };
  const adapter = proto("GPUAdapter");
  const requestDevice = adapter.requestDevice;
  adapter.requestDevice = async function (this: unknown, desc?: unknown) {
    const gpu = (await requestDevice.call(this, desc)) as Gpu;
    report.device = performance.now();
    if (options.recording) {
      await prewarm(gpu, options.recording);
      report.prewarmed = performance.now();
    }
    return gpu;
  };
  const poll = () => {
    const state = (window as unknown as { GenexShell?: { status: { state: string } } }).GenexShell?.status.state;
    if (state === "running") report.running = performance.now();
    else setTimeout(poll, 5);
  };
  poll();
}

/** One page load in `browser`; its report. */
async function load(browser: Browser, origin: string, hooks: Hooks): Promise<ColdReport> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(pageHooks, { ...hooks, nonce: hooks.nonce === null ? null : shaderNonce() });
  await page.goto(`${origin}/index.html`);
  await page.waitForFunction(
    () => (window as unknown as { __cold: ColdReport }).__cold.firstFrame !== null,
    undefined,
    { timeout: FIRST_FRAME_TIMEOUT_MS },
  );
  const report = await page.evaluate(() => (window as unknown as { __cold: ColdReport }).__cold);
  await context.close();
  return report;
}

/** A load in a browser of its own (cold caches), and with `warm` a second load in the same one. */
async function coldLoad(origin: string, hooks: Hooks, warm: boolean): Promise<ColdReport[]> {
  const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
  try {
    const reports = [await load(browser, origin, hooks)];
    if (warm) reports.push(await load(browser, origin, hooks));
    return reports;
  } finally {
    await browser.close();
  }
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

/** Each mode's median first lit frame and device time, in ms. */
function summary(rows: Row[]): Record<string, { firstFrame: number; device: number; runs: number }> {
  const out: Record<string, { firstFrame: number; device: number; runs: number }> = {};
  for (const mode of Object.values(Mode)) {
    const mine = rows.filter((row) => row.mode === mode);
    if (mine.length === 0) continue;
    out[mode] = {
      firstFrame: median(mine.map((row) => row.firstFrame ?? Number.NaN)),
      device: median(mine.map((row) => row.device ?? Number.NaN)),
      runs: mine.length,
    };
  }
  return out;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      dir: { type: "string" },
      runs: { type: "string" },
      out: { type: "string" },
      "cold-shaders": { type: "boolean" },
    },
  });
  const dir = await realpath(values.dir ?? DEFAULT_DIR);
  const runs = Number(values.runs ?? DEFAULT_RUNS);
  const nonce = values["cold-shaders"] ? "on" : null;
  const served = await serve(dir);
  const rows: Row[] = [];
  try {
    const [recorded] = await coldLoad(served.origin, { record: true, recording: null, nonce }, false);
    rows.push({ ...recorded, mode: Mode.Record, run: 0, recording: null });
    const recording = recorded?.recording ?? null;
    if (!recording) throw new Error("the record run wrote no recording");
    for (let run = 1; run <= runs; run++) {
      const [cold, warm] = await coldLoad(served.origin, { record: false, recording: null, nonce }, true);
      if (cold) rows.push({ ...cold, mode: Mode.Measure, run });
      if (warm) rows.push({ ...warm, mode: Mode.Warm, run });
      const [prewarmed] = await coldLoad(served.origin, { record: false, recording, nonce }, false);
      if (prewarmed) rows.push({ ...prewarmed, mode: Mode.Prewarm, run });
      console.log(
        `run ${run}: ${rows
          .slice(-3)
          .map((row) => `${row.mode} ${row.firstFrame?.toFixed(0)} ms`)
          .join(", ")}`,
      );
    }
  } finally {
    served.close();
  }
  const result = { dir, runs, summary: summary(rows), rows };
  console.log(JSON.stringify(result.summary, null, 2));
  if (values.out) await writeFile(values.out, `${JSON.stringify(result, null, 2)}\n`);
}

await main();
