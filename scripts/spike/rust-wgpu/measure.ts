/**
 * M0a.8 measurements (spike only; M0a.15 ratifies the budgets, M2.12c moves the performance row
 * into the lane's tests): sizes, times and download bytes against the plan's budgets, and the
 * pond's performance row on the Mac.
 *
 *   node scripts/spike/rust-wgpu/measure.ts              # bench, web perf, write measurements.json
 *   node scripts/spike/rust-wgpu/measure.ts bench        # the Mac performance row only (JSON)
 *   node scripts/spike/rust-wgpu/measure.ts web-boot <folder>
 *       # serve only <folder> on 127.0.0.1 to headless Chromium; require `running` on WebGPU core,
 *       # an async capture with >= 16 colours, and report rAF frame intervals (JSON)
 *
 * The default run reads the records cross-all.sh, cross-offline.sh and export-standalone.sh wrote
 * under .studio-dev/evidence/m0a/cross, runs the bench and the web boot, and writes
 * .studio-dev/evidence/m0a/measurements.json. It exits 1 when a record is missing or a row is
 * over its budget; rows nothing here can measure (the raylib v1 fishing baseline, which lives in
 * the owner's games folder, and the C++ lane's warm rebuild, whose toolchain this worktree lacks)
 * are `not-run` with the reason, never a pass. Chromium is Playwright's; nothing is downloaded.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { type Browser, chromium, type Page } from "@playwright/test";
import { MINUTE_MS, SECOND_MS } from "../../../src/shared/duration.ts";

const execFileAsync = promisify(execFile);

const REPO = path.resolve(import.meta.dirname, "../../..");
const HERE = path.join(REPO, "scripts/spike/rust-wgpu");
const RUST_ENV = path.join(HERE, "rust-env.sh");
const BENCH_SOURCE = path.join(HERE, "pond-bench.rs");
const SPIKE_DIR = process.env.GENEX_SPIKE_TOOLCHAIN_DIR ?? path.join(REPO, ".studio-dev/spike-toolchain");
const EVIDENCE = path.join(REPO, ".studio-dev/evidence/m0a");
const CROSS_EVIDENCE = process.env.GENEX_CROSS_EVIDENCE ?? path.join(EVIDENCE, "cross");
const WORK = process.env.GENEX_CROSS_WORK ?? path.join(REPO, ".studio-dev/cross");
const OUTPUT = path.join(EVIDENCE, "measurements.json");

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const BUILD_TIMEOUT_MS = 20 * MINUTE_MS;
const BENCH_TIMEOUT_MS = 5 * MINUTE_MS;
const BOOT_TIMEOUT_MS = 60 * SECOND_MS;
const MAX_OUTPUT_BYTES = 256 * MIB;
const BENCH_FRAMES = 600;
const WEB_FRAMES = 240;
const NONBLANK_MIN_COLOURS = 16;
/** Chromium coarsens rAF timestamps to 0.1 ms, so a 60 Hz interval reads 16.6 to 16.8 ms. */
const WEB_TIMER_RESOLUTION_MS = 0.1;
/** An interval of 1.5 vsyncs at 60 Hz or more means a frame was skipped. */
const MISSED_FRAME_MS = 25;
const CHROMIUM_ARGS: Record<string, string[]> = {
  darwin: ["--enable-unsafe-webgpu", "--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"],
};
const DEFAULT_CHROMIUM_ARGS = ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"];
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

/** The downloads an eager Mac + web setup fetches (plan: host-native and web prewarmed eagerly). */
const EAGER_DOWNLOADS = [
  /^rustc-.*-aarch64-apple-darwin/,
  /^cargo-\d.*-aarch64-apple-darwin/,
  /^clippy-/,
  /^llvm-tools-/,
  /^rust-std-.*-(aarch64-apple-darwin|wasm32-unknown-unknown)/,
  /^wasm-bindgen-/,
  /^binaryen-/,
];

/** The plan's budgets ("Toolchain and build store", "Renderer scope", M0a kill criteria). */
const BUDGET = {
  downloadsBytes: 1.5 * GIB,
  eagerStoreBytes: 6 * GIB,
  vendorArchiveBytes: 400 * MIB,
  wasmGzipBytes: 4 * MIB,
  apkBytes: 25 * MIB,
  ipaBytes: 30 * MIB,
  timeToFirstFrameMs: 90 * SECOND_MS,
  coldBuildMs: 10 * MINUTE_MS,
  frameP95Ms: 16.7,
} as const;

/** A measurement row's verdict. */
const RowStatus = { Pass: "pass", Fail: "fail", NotRun: "not-run" } as const;
type RowStatus = (typeof RowStatus)[keyof typeof RowStatus];

interface Row {
  id: string;
  value: number | null;
  budget: number | null;
  unit: string;
  status: RowStatus;
  source: string;
  note?: string;
}

interface Artifact {
  name: string;
  path: string;
  bytes: number;
  gzipBytes: number;
  buildMs: number;
  target?: string;
}

interface CrossRecord {
  destination: string;
  artifacts: Artifact[];
}

interface OfflineRecord {
  networkDenied: boolean;
  coldRelease: { ms: number; sha256: string }[];
  identical: boolean;
  warmReleaseMs: number;
  coldDevMs: number;
  warmDevMs: number;
  coldTargetBytes: number;
  coldWebTargetBytes: number;
  coldWebMs: number;
}

interface WebBoot {
  state: string;
  tier: string;
  backend: string;
  bootMs: number;
  captureColours: number;
  /** rAF intervals longer than MISSED_FRAME_MS (a skipped vsync at 60 Hz). */
  missedFrames: number;
  frameIntervalMs: { p50: number; p95: number; max: number };
  requests: string[];
}

interface ExportRecord {
  mac: { buildMs: number; binaryBytes: number; appGzipBytes: number; bootMs: number; captureColours: number };
  web: { buildMs: number; size: { wasmBytes: number; gzipBytes: number }; boot: WebBoot };
}

interface Bench {
  adapter: string;
  frameMs: { p50: number; p95: number; max: number };
  captureMs: { p50: number; p95: number };
  gpuOpenMs: number;
  pipelineCompileMs: number;
  firstFrameMs: number;
  gpuAllocatedPeakBytes: number;
  peakRssBytes: number;
}

interface CargoMessage {
  reason: string;
  package_id: string;
  target?: { name: string; kind: string[] };
  filenames?: string[];
  linked_libs?: string[];
  linked_paths?: string[];
}

/** Decimal places kept in a time: browsers coarsen `performance.now()` to 0.1 ms anyway. */
const TIME_DECIMALS = 3;

/** The nearest-rank percentile, rounded to TIME_DECIMALS (so 16.700000000000273 reads 16.7). */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const value = sorted[Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)))];
  return Number(value.toFixed(TIME_DECIMALS));
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

/** Bytes under `dir` (du's 1 KiB blocks), 0 when it does not exist. */
async function duBytes(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  const { stdout } = await execFileAsync("du", ["-sk", dir]);
  return Number.parseInt(stdout, 10) * 1024;
}

// ---------------------------------------------------------------------------------------------
// web-boot

function serveFolder(folder: string, requests: string[]): http.Server {
  const files = new Set(readdirSync(folder));
  return http.createServer((req, res) => {
    const name = new URL(req.url ?? "/", "http://127.0.0.1").pathname.replace(/^\//, "") || "index.html";
    requests.push(name);
    // Only the folder's own top-level files: no traversal, no other host path.
    if (!files.has(name)) {
      res.writeHead(404).end();
      return;
    }
    const type = CONTENT_TYPES[path.extname(name)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    readFile(path.join(folder, name)).then(
      (bytes) => res.end(bytes),
      () => res.writeHead(500).end(),
    );
  });
}

async function shellStatus(page: Page): Promise<{ state: string; receipt: { tier: string; backend: string } | null }> {
  return page.evaluate(() => {
    const shell = (window as unknown as { GenexShell: { status: { state: string; receipt: unknown } } }).GenexShell;
    return shell.status as { state: string; receipt: { tier: string; backend: string } | null };
  });
}

async function captureColours(page: Page): Promise<number> {
  return page.evaluate(async (limit) => {
    const studio = (window as unknown as { __studio: { captureRaw(): Promise<{ bgra: Uint8Array }> } }).__studio;
    const { bgra } = await studio.captureRaw();
    const seen = new Set<number>();
    for (let i = 0; i + 3 < bgra.length && seen.size < limit; i += 4) {
      seen.add((bgra[i] << 16) | (bgra[i + 1] << 8) | bgra[i + 2]);
    }
    return seen.size;
  }, 4096);
}

async function frameIntervals(page: Page): Promise<number[]> {
  return page.evaluate(
    (count) =>
      new Promise<number[]>((resolve) => {
        const stamps: number[] = [];
        const tick = (now: number) => {
          stamps.push(now);
          if (stamps.length > count) resolve(stamps.slice(1).map((t, i) => t - stamps[i]));
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    WEB_FRAMES,
  );
}

async function bootPage(browser: Browser, origin: string): Promise<WebBoot> {
  const page = await browser.newPage();
  const started = Date.now();
  await page.goto(`${origin}/index.html`);
  await page.waitForFunction(
    () => (window as unknown as { GenexShell?: { status: { state: string } } }).GenexShell?.status.state !== "starting",
    undefined,
    { timeout: BOOT_TIMEOUT_MS },
  );
  const bootMs = Date.now() - started;
  const status = await shellStatus(page);
  if (status.state !== "running") throw new Error(`the web export did not boot: ${JSON.stringify(status)}`);
  const colours = await captureColours(page);
  if (colours < NONBLANK_MIN_COLOURS) throw new Error(`the web export's capture has ${colours} colours`);
  const intervals = (await frameIntervals(page)).sort((a, b) => a - b);
  return {
    state: status.state,
    tier: status.receipt?.tier ?? "",
    backend: status.receipt?.backend ?? "",
    bootMs,
    captureColours: colours,
    missedFrames: intervals.filter((ms) => ms > MISSED_FRAME_MS).length,
    frameIntervalMs: {
      p50: percentile(intervals, 50),
      p95: percentile(intervals, 95),
      max: Number((intervals.at(-1) ?? 0).toFixed(TIME_DECIMALS)),
    },
    requests: [],
  };
}

/** Serve `folder` alone and boot it in headless Chromium. */
export async function webBoot(folder: string): Promise<WebBoot> {
  const requests: string[] = [];
  const server = serveFolder(folder, requests);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({
    headless: true,
    args: CHROMIUM_ARGS[process.platform] ?? DEFAULT_CHROMIUM_ARGS,
  });
  try {
    const boot = await bootPage(browser, origin);
    const outside = requests.filter((name) => name !== "favicon.ico" && !existsSync(path.join(folder, name)));
    if (outside.length > 0) throw new Error(`the export asked for files it does not carry: ${outside.join(", ")}`);
    return { ...boot, requests: [...new Set(requests)] };
  } finally {
    await browser.close();
    server.close();
  }
}

// ---------------------------------------------------------------------------------------------
// bench

/** The pond's release build through the env helper; answers Cargo's JSON messages. */
async function buildPond(): Promise<CargoMessage[]> {
  const { stdout } = await execFileAsync(
    "bash",
    [
      RUST_ENV,
      "cargo",
      "build",
      "-p",
      "pond",
      "--bin",
      "pond",
      "--release",
      "--offline",
      "--locked",
      "--message-format=json",
    ],
    { maxBuffer: MAX_OUTPUT_BYTES, timeout: BUILD_TIMEOUT_MS },
  );
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as CargoMessage);
}

/** The crates the bench names, with the version line where the graph holds two. */
const BENCH_EXTERNS: Record<string, string> = {
  genex: "",
  genex_platform_web: "",
  genex_render: "",
  pond_game: "",
  wgpu: "@30.",
  objc2: "@0.6.",
  objc2_metal: "@0.3.",
  serde_json: "",
};

function rlibOf(messages: readonly CargoMessage[], crate: string, version: string): string {
  const hit = messages.find(
    (m) =>
      m.reason === "compiler-artifact" &&
      m.target?.name.replaceAll("-", "_") === crate &&
      m.package_id.includes(version) &&
      m.filenames?.some((f) => f.endsWith(".rlib")),
  );
  const rlib = hit?.filenames?.find((f) => f.endsWith(".rlib"));
  if (!rlib) throw new Error(`cargo reported no rlib for ${crate}${version}`);
  return rlib;
}

function rustcArgs(messages: readonly CargoMessage[], out: string): string[] {
  const externs = Object.entries(BENCH_EXTERNS).map(
    ([crate, version]) => `--extern=${crate}=${rlibOf(messages, crate, version)}`,
  );
  const deps = path.dirname(rlibOf(messages, "pond_game", ""));
  const scripts = messages.filter((m) => m.reason === "build-script-executed");
  const libs = scripts.flatMap((m) => (m.linked_libs ?? []).map((lib) => `-l${lib}`));
  const libPaths = scripts.flatMap((m) => (m.linked_paths ?? []).map((dir) => `-L${dir}`));
  return [
    "rustc",
    "--edition=2024",
    "--crate-type=bin",
    "--crate-name=pond_bench",
    "-Copt-level=3",
    `-Ldependency=${deps}`,
    ...externs,
    ...libPaths,
    ...libs,
    "-o",
    out,
    BENCH_SOURCE,
  ];
}

/** Bytes after "maximum resident set size" in `/usr/bin/time -l` output. */
function peakRss(stderr: string): number {
  const match = /(\d+)\s+maximum resident set size/.exec(stderr);
  return match ? Number(match[1]) : 0;
}

/** Build the pond, compile pond-bench.rs against it and run it. */
export async function bench(): Promise<Bench> {
  const messages = await buildPond();
  const out = path.join(WORK, "bench", "pond-bench");
  await mkdir(path.dirname(out), { recursive: true });
  await execFileAsync("bash", [RUST_ENV, ...rustcArgs(messages, out)], {
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: BUILD_TIMEOUT_MS,
  });
  const { stdout, stderr } = await execFileAsync("/usr/bin/time", ["-l", out, String(BENCH_FRAMES)], {
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: BENCH_TIMEOUT_MS,
  });
  const line = stdout.split("\n").find((l) => l.startsWith("{"));
  if (!line) throw new Error(`pond-bench printed no record: ${stderr}`);
  return { ...(JSON.parse(line) as Omit<Bench, "peakRssBytes">), peakRssBytes: peakRss(stderr) };
}

// ---------------------------------------------------------------------------------------------
// sizes

async function downloadBytes(): Promise<{ eager: number; all: number; files: Record<string, number> }> {
  const dir = path.join(SPIKE_DIR, "downloads");
  const files: Record<string, number> = {};
  let eager = 0;
  let all = 0;
  for (const name of readdirSync(dir)) {
    const bytes = (await stat(path.join(dir, name))).size;
    files[name] = bytes;
    all += bytes;
    if (EAGER_DOWNLOADS.some((pattern) => pattern.test(name))) eager += bytes;
  }
  return { eager, all, files };
}

/** gzip -6 bytes of a tar of the vendored crates, streamed (nothing is written). */
async function vendorArchiveBytes(): Promise<number> {
  const { stdout } = await execFileAsync(
    "bash",
    ["-c", 'tar -C "$1" -cf - vendor | gzip -6 | wc -c', "vendor-size", SPIKE_DIR],
    { timeout: BUILD_TIMEOUT_MS },
  );
  return Number.parseInt(stdout.trim(), 10);
}

/** The store an eager Mac + web profile holds: sysroot, vendored crates, web tools, prewarm. */
async function eagerStoreBytes(offline: OfflineRecord): Promise<number> {
  const parts = await Promise.all(
    ["sysroot", "vendor", "cargo-home", "tools/bin", "tools/binaryen"].map((p) => duBytes(path.join(SPIKE_DIR, p))),
  );
  return parts.reduce((a, b) => a + b, 0) + offline.coldTargetBytes + offline.coldWebTargetBytes;
}

// ---------------------------------------------------------------------------------------------
// rows

function row(
  id: string,
  value: number | null,
  budget: number | null,
  unit: string,
  source: string,
  note?: string,
): Row {
  const measured = value !== null && Number.isFinite(value);
  let status: RowStatus = RowStatus.NotRun;
  if (measured) status = budget === null || value <= budget ? RowStatus.Pass : RowStatus.Fail;
  return { id, value: measured ? value : null, budget, unit, status, source, ...(note ? { note } : {}) };
}

function artifact(cross: CrossRecord, name: string, target?: string): Artifact {
  const hit = cross.artifacts.find((a) => a.name === name && (target === undefined || a.target === target));
  if (!hit) throw new Error(`no ${name} artifact in the ${cross.destination} record`);
  return hit;
}

interface Inputs {
  android: CrossRecord;
  ios: CrossRecord;
  offline: OfflineRecord;
  exported: ExportRecord;
  bench: Bench;
  web: WebBoot;
  downloads: { eager: number; all: number };
  vendor: number;
  store: number;
}

function sizeRows(i: Inputs): Row[] {
  const apk = artifact(i.android, "pond");
  const ipa = artifact(i.ios, "pond", "aarch64-apple-ios");
  return [
    row(
      "downloads-eager-mac-web",
      i.downloads.eager + i.vendor,
      BUDGET.downloadsBytes,
      "bytes",
      "spike downloads + vendor archive",
    ),
    row(
      "downloads-all-destinations",
      i.downloads.all + i.vendor,
      null,
      "bytes",
      "spike downloads + vendor archive",
      "informational: every destination's archives",
    ),
    row("eager-store", i.store, BUDGET.eagerStoreBytes, "bytes", "sysroot + vendor + web tools + host/web prewarm"),
    row("vendor-archive", i.vendor, BUDGET.vendorArchiveBytes, "bytes", "tar | gzip -6 of the vendored crates"),
    row("wasm-gzip", i.exported.web.size.gzipBytes, BUDGET.wasmGzipBytes, "bytes", "export.json web.size"),
    row(
      "apk-proxy",
      apk.gzipBytes,
      BUDGET.apkBytes,
      "bytes",
      "android.json pond gzip -9",
      "proxy: the game's arm64 code compressed; the APK itself is M0a.16",
    ),
    row(
      "ipa-proxy",
      ipa.gzipBytes,
      BUDGET.ipaBytes,
      "bytes",
      "ios.json device pond gzip -9",
      "proxy: the device binary compressed; the IPA itself is M0a.16",
    ),
  ];
}

function timeRows(i: Inputs): Row[] {
  const coldMax = Math.max(...i.offline.coldRelease.map((b) => b.ms));
  return [
    row("cold-build-release", coldMax, BUDGET.coldBuildMs, "ms", "offline.json (kill: > 10-minute prewarm step)"),
    row("warm-rebuild-release", i.offline.warmReleaseMs, null, "ms", "offline.json", "C++ lane comparison not-run"),
    row("warm-rebuild-dev", i.offline.warmDevMs, null, "ms", "offline.json", "C++ lane comparison not-run"),
    row(
      "warm-rebuild-vs-cpp-lane",
      null,
      2,
      "ratio",
      "kill: > 2x the C++ lane",
      "not-run: the raylib toolchain (cmake, raylib, emsdk) is not installed in this worktree's dev store",
    ),
    row(
      "time-to-first-frame-web",
      i.offline.coldWebMs + i.web.bootMs,
      BUDGET.timeToFirstFrameMs,
      "ms",
      "cold offline web build + browser boot",
    ),
  ];
}

function performanceRows(i: Inputs): Row[] {
  return [
    row(
      "mac-frame-p95",
      i.bench.frameMs.p95,
      BUDGET.frameP95Ms,
      "ms",
      "pond-bench (headless, unthrottled, GPU waited)",
    ),
    row("mac-frame-p50", i.bench.frameMs.p50, null, "ms", "pond-bench"),
    row("mac-startup-first-frame", i.bench.firstFrameMs, null, "ms", "pond-bench"),
    row("mac-pipeline-compile", i.bench.pipelineCompileMs, null, "ms", "pond-bench"),
    row("mac-capture-latency-p50", i.bench.captureMs.p50, null, "ms", "pond-bench"),
    row("mac-peak-rss", i.bench.peakRssBytes, null, "bytes", "/usr/bin/time -l"),
    row("mac-gpu-allocated-peak", i.bench.gpuAllocatedPeakBytes, null, "bytes", "MTLDevice currentAllocatedSize"),
    row(
      "web-frame-interval-p95",
      i.web.frameIntervalMs.p95,
      BUDGET.frameP95Ms + WEB_TIMER_RESOLUTION_MS,
      "ms",
      "headless Chromium rAF over the running shell",
      "budget 16.7 ms plus Chromium's 0.1 ms timestamp resolution; rAF is vsync-paced, see web-missed-frames",
    ),
    row("web-missed-frames", i.web.missedFrames, 0, "frames", `rAF intervals > ${MISSED_FRAME_MS} ms of ${WEB_FRAMES}`),
    row(
      "mac-p95-vs-raylib-fishing",
      null,
      0.1,
      "regression",
      "plan: <= 10% p95 regression",
      "not-run: the raylib v1 fishing game lives in the owner's games folder, which agents never touch",
    ),
  ];
}

async function readRecords(): Promise<Pick<Inputs, "android" | "ios" | "offline" | "exported">> {
  const names = ["android.json", "ios.json", "offline.json", "export.json", "windows.json", "linux.json"];
  const missing = names.filter((name) => !existsSync(path.join(CROSS_EVIDENCE, name)));
  if (missing.length > 0)
    throw new Error(`missing records (run cross-all.sh and export-standalone.sh): ${missing.join(", ")}`);
  return {
    android: await readJson<CrossRecord>(path.join(CROSS_EVIDENCE, "android.json")),
    ios: await readJson<CrossRecord>(path.join(CROSS_EVIDENCE, "ios.json")),
    offline: await readJson<OfflineRecord>(path.join(CROSS_EVIDENCE, "offline.json")),
    exported: await readJson<ExportRecord>(path.join(CROSS_EVIDENCE, "export.json")),
  };
}

async function crossArtifacts(): Promise<Record<string, Artifact[]>> {
  const out: Record<string, Artifact[]> = {};
  for (const destination of ["windows", "linux", "android", "ios"]) {
    const record = await readJson<CrossRecord>(path.join(CROSS_EVIDENCE, `${destination}.json`));
    out[destination] = record.artifacts.map(({ name, target, bytes, gzipBytes, buildMs }) => ({
      name,
      path: "",
      target,
      bytes,
      gzipBytes,
      buildMs,
    }));
  }
  return out;
}

async function measureAll(): Promise<number> {
  const records = await readRecords();
  // One at a time: the performance rows must not share the machine with each other or with tar.
  const benchResult = await bench();
  const web = await webBoot(path.join(WORK, "export/pond-web"));
  const downloads = await downloadBytes();
  const vendor = await vendorArchiveBytes();
  const store = await eagerStoreBytes(records.offline);
  const inputs: Inputs = { ...records, bench: benchResult, web, downloads, vendor, store };
  const rows = [...sizeRows(inputs), ...timeRows(inputs), ...performanceRows(inputs)];
  const linux = await readJson<{ toolchain: unknown }>(path.join(CROSS_EVIDENCE, "linux.json"));
  const result = {
    format: "genex-m0a-measurements/1",
    measuredAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, adapter: benchResult.adapter },
    q7: {
      confirmed: true,
      linuxToolchain: linux.toolchain,
      note: "zig 0.16.0 + cargo-zigbuild 0.23.4, Linux targets only",
    },
    rows,
    crossArtifacts: await crossArtifacts(),
    offline: records.offline,
    bench: benchResult,
    web,
    downloads,
  };
  await writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`measure: wrote ${OUTPUT}`);
  for (const r of rows)
    console.log(`${r.status.padEnd(8)} ${r.id} ${r.value ?? "-"} ${r.unit} (budget ${r.budget ?? "-"})`);
  return rows.some((r) => r.status === RowStatus.Fail) ? 1 : 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, folder] = argv;
  if (command === "web-boot" && folder) {
    console.log(JSON.stringify(await webBoot(path.resolve(folder))));
    return 0;
  }
  if (command === "bench") {
    console.log(JSON.stringify(await bench()));
    return 0;
  }
  if (command !== undefined) {
    console.error("usage: measure.ts [bench | web-boot <folder>]");
    return 2;
  }
  return measureAll();
}

process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`measure: ${error instanceof Error ? error.message : String(error)}`);
  return 1;
});
