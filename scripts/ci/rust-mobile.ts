/**
 * The Rust · wgpu runtime's phone CI rows (M5.6). `rust-mobile.yml` only installs what a row needs and
 * calls `node scripts/ci/rust-mobile.ts --step <id>`; every check lives here so
 * `tests/conformance/rust-mobile-ci.test.ts` can drive it on any host, against stub tools.
 *
 *   node scripts/ci/rust-mobile.ts --table                    the step and workflow tables as JSON
 *   node scripts/ci/rust-mobile.ts --check-workflow <file>    the workflow calls its steps once, in order, gated and pinned
 *   node scripts/ci/rust-mobile.ts --step <id> [flags]        one CI step (typed refusal, exit 1, on failure)
 *
 * Flags: `--evidence <dir>` (records; default `.studio-dev/evidence/rust-mobile-ci`), `--app <.app>` and
 * `--app-id <id>` (the Simulator app and its bundle id; the emulator app's application id), `--out <dir>`
 * (where the Android packages are written and read), `--library-apk <apk>` (the spike APK the pond's
 * `libmain.so` is taken from), `--bundletool <jar>` and `--image <system image id>`.
 *
 * Every step writes `<evidence>/<id>.json`; a failure prints one typed line on stderr and exits 1:
 *   genex-rust-mobile: {"code":"<code>","detail":"<text>"}
 *
 * What the rows prove, and what they do not:
 * - iOS (macOS runner, owner dispatch only): a fresh Simulator boots on this runner, the pond's ad hoc
 *   Simulator `.app` installs and launches, the shell's lifecycle log ends in a WebGPU-core Metal adapter
 *   and its first presented frame (`firstFrameOf`) or the typed `gpu-unsupported` record
 *   (`shellSmokeVerdict`), the screenshot is not blank, and the
 *   Simulator is deleted. No signing identity, no device, no secret. The Simulator's Metal is below
 *   WebGPU core, so the row normally ends in the refusal: the log must then say the designed refusal
 *   screen is shown, naming the record's code (`refusalScreenOf`), and the capture must be that screen
 *   in the colours it logged (`checkRefusalScreen`), never a black window.
 * - Play checks (Linux runner): the lane (`android-package.ts`) packages the pond's real library as the dev
 *   APK and the person-only AAB with throwaway keys made on the runner, bundletool derives the universal
 *   APK Play would make; `zipalign -c -P 16` passes over both APKs, `bundletool validate` passes and the
 *   bundle's manifest is targetSdk 36, minSdk 29 and permission-free with 16 KB alignment in its config.
 *   The lane's tools run unsandboxed here (`sandboxed: false` in the record): the runner is disposable and
 *   `ProcessSandbox` is the app's own Mac and Linux containment, covered by `android-package*.test.ts`.
 * - 16 KB emulator (Linux runner, KVM): the system image is a 16 KB page one and the kernel reports a page
 *   of 16384 bytes, the dev APK installs and starts, its lifecycle log ends as on iOS (Vulkan; after an
 *   adapter, the shell's first presented frame), the app's crash buffer is empty, and the capture is not
 *   blank and was taken with the game's own window in focus (system dialogs closed first; the app's own
 *   not-responding dialog fails it). An emulator below WebGPU core is a recorded
 *   result (the typed refusal screen must then be what is drawn), not a failure.
 * - They do not prove a real device: Adreno and Mali frame times, thermal behaviour and a real iPhone are
 *   the owner device gates (M5.10), and the ARM translation layer of an x86_64 image is not an arm64 phone.
 */
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, openSync, closeSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { ExportSigning } from "../../src/shared/game-export-contract.ts";
import { NativeBackend } from "../../src/shared/native-contract.ts";
import { ANDROID_PINS } from "../../src/shared/toolchain.ts";
import {
  type FirstFrameFacts,
  firstFrameOf,
  type RefusalScreenFacts,
  type Rgb,
  refusalScreenFacts,
  refusalScreenOf,
  ShellSmoke,
  type ShellSmokeVerdict,
  shellSmokeVerdict,
} from "../../src/main/rust-build-mobile.ts";
import {
  ANDROID_ACTIVITIES,
  ANDROID_CONFIG_CHANGES,
  ANDROID_LIBRARY_ENTRY,
  type AndroidPackageContext,
  type AndroidPackageTools,
  AndroidOrientation,
  type AndroidToolSandbox,
  PACKAGED_ACTIVITY,
  packageAndroidAab,
  packageAndroidApk,
  readAndroidPayload,
  readZipEntries,
  zipEntryData,
} from "../../src/substrate/android-package.ts";
import type { RunResult } from "../../src/substrate/spawn.ts";
import { SigningRequester } from "../../src/substrate/windows-sign.ts";
import { type WorkflowJob, workflowJobs } from "./rust-linux-host.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const FORMAT = "genex-rust-mobile/1";
const REFUSAL_PREFIX = "genex-rust-mobile: ";
const FAIL_EXIT = 1;
const DEFAULT_EVIDENCE = path.join(REPO, ".studio-dev", "evidence", "rust-mobile-ci");

const STEP_TIMEOUT_MS = 40 * MINUTE_MS;
const TOOL_TIMEOUT_MS = 5 * MINUTE_MS;
const SIMULATOR_BOOT_TIMEOUT_MS = 10 * MINUTE_MS;
const ADB_TIMEOUT_MS = 2 * MINUTE_MS;
const SMOKE_POLL_MS = 2 * SECOND_MS;
const SMOKE_WAIT_MS = 3 * MINUTE_MS;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const SIMULATOR_NAME = "genex-ci";
const DEVICE_FILE = "ios-sim-device.json";
const IOS_CAPTURE_FILE = "ios-simulator.png";
const ANDROID_CAPTURE_FILE = "android-emulator.png";
const RECORDS_FOLDER = "genex-self-test";
const LIFECYCLE_FILE = "lifecycle.ndjson";
const DEV_APK = "pond-debug.apk";
const BUNDLE = "pond.aab";
const UNIVERSAL_APK = "pond-universal.apk";
const PLAY_APKS = [DEV_APK, UNIVERSAL_APK] as const;
const UPLOAD_ALIAS = "upload";
const KEY_ENV = "GENEX_CI_KEY_PASS";
const APP_ID_MAX_CHARS = 128;
const PAGE_BYTES = 16384;
const ZIP_ALIGN_BYTES = "4";
const ZIP_PAGE_ALIGN_KB = "16";
const UDID = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/;
const APP_ID = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/;
const IMAGE_16K =
  /^system-images;android-(?:3[5-9]|[4-9]\d)(?:\.\d+)?;google_apis(?:_playstore)?_ps16k;(?:x86_64|arm64-v8a)$/;
/** A plain numbered iPhone's device type name (`iPhone 17`), its number captured. */
const PLAIN_IPHONE = /^iPhone (\d{1,3})$/;
const DEVICE_TYPE_ID = /^com\.apple\.CoreSimulator\.SimDeviceType\.[A-Za-z0-9.-]+$/;
const PERMISSION_TAG = /<uses-permission/;
const ALIGNMENT_16K = "PAGE_ALIGNMENT_16K";

/** The 16 KB page system image the emulator rows run: the target API, Google APIs, the runner's architecture. */
export const ANDROID_16K_IMAGE = "system-images;android-36;google_apis_ps16k;x86_64";

/** The bundletool release the Play checks run, and the digest its jar must have (verified here and by the workflow). */
export const BUNDLETOOL_PIN = {
  version: "1.18.3",
  url: "https://github.com/google/bundletool/releases/download/1.18.3/bundletool-all-1.18.3.jar",
  sha256: "a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29",
} as const;

/** The least distinct colours a capture's centre needs: a rendered scene, or the refusal screen's text on its background. */
export const MIN_COLOURS = { Rendered: 16, Refusal: 2 } as const;

/** A capture whose centre is this share one colour (or more) is blank. */
const BLANK_SHARE = 0.999;
/** How far (per channel, 0-255) a captured pixel may sit from a colour the refusal screen logged: the capture is colour-managed. */
const REFUSAL_COLOUR_TOLERANCE = 12;
/** The share of a refusal capture's centre that must be the screen's background, and the least that must be its ink. */
const REFUSAL_BACKGROUND_MIN_SHARE = 0.5;
const REFUSAL_INK_MIN_SHARE = 0.002;
const COLOUR_CAP = 4096;
const PNG_MAX_SIDE = 16384;
const PNG_MAX_PIXELS = 30_000_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** How a step run ended, in its evidence record (wire values). */
export const StepStatus = { Pass: "pass", Fail: "fail" } as const;
export type StepStatus = (typeof StepStatus)[keyof typeof StepStatus];

/** The refusal codes this script prints (wire values). */
export const RustMobileCode = {
  Usage: "usage",
  UnknownStep: "unknown-step",
  WorkflowDrift: "workflow-drift",
  ToolMissing: "tool-missing",
  StepFailed: "step-failed",
  BadRecord: "bad-record",
  BadPng: "bad-png",
  BlankCapture: "blank-capture",
  NotAligned: "not-aligned",
  BundleInvalid: "bundle-invalid",
  ManifestRefused: "manifest-refused",
  ConfigRefused: "config-refused",
  BundletoolPin: "bundletool-pin",
  PageSize: "page-size",
  SmokeFailed: "smoke-failed",
  /** The shell refused the GPU but logged no refusal screen it drew, or one naming another code. */
  RefusalNotShown: "refusal-not-shown",
  /** After a refusal, the capture is not the screen the shell logged (its background and ink). */
  NotRefusalScreen: "not-refusal-screen",
  SimulatorFailed: "simulator-failed",
  PackageFailed: "package-failed",
  /** The emulator's screen did not come awake before the app's start (the app would never resume). */
  DeviceNotReady: "device-not-ready",
  /** The shell admitted the adapter but presented no frame within the smoke's wait. */
  NoFramePresented: "no-frame-presented",
  /** The emulator screenshot was not taken with the game's own window in focus (a system dialog over it). */
  CaptureNotGame: "capture-not-game",
} as const;
export type RustMobileCode = (typeof RustMobileCode)[keyof typeof RustMobileCode];

/** A typed failure of a step. */
export class RustMobileError extends Error {
  code: RustMobileCode;
  detail: string;

  constructor(code: RustMobileCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "RustMobileError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code: RustMobileCode, detail: string): never {
  throw new RustMobileError(code, detail);
}

/** Step ids (wire values: the workflow's `--step` argument and the record file names). */
export const StepId = {
  IosSimBoot: "ios-sim-boot",
  IosSimInstall: "ios-sim-install",
  IosSimCapture: "ios-sim-capture",
  IosSimDelete: "ios-sim-delete",
  AndroidPackage: "android-package",
  AabValidate: "aab-validate",
  Zipalign16k: "zipalign-16k",
  EmulatorPageSize: "emulator-page-size",
  EmulatorSmoke: "emulator-smoke",
  EmulatorCapture: "emulator-capture",
} as const;
export type StepId = (typeof StepId)[keyof typeof StepId];

/** One row of the step table. */
export interface StepSpec {
  id: StepId;
  title: string;
  /** The flags the step needs, besides `--evidence`. */
  needs: readonly string[];
}

/** The rows, in run order. */
export const STEP_TABLE: readonly StepSpec[] = [
  {
    id: StepId.IosSimBoot,
    title: "A fresh iPhone Simulator is created on the newest available iOS runtime and booted",
    needs: [],
  },
  {
    id: StepId.IosSimInstall,
    title:
      "The Simulator .app installs and launches; its lifecycle log ends in a Metal core adapter and a presented frame, or the typed refusal and its refusal screen shown",
    needs: ["--app", "--app-id"],
  },
  {
    id: StepId.IosSimCapture,
    title:
      "A Simulator screenshot shows a scene after a render, the typed refusal screen in its logged colours after a refusal",
    needs: [],
  },
  { id: StepId.IosSimDelete, title: "The Simulator the boot step made is shut down and deleted", needs: [] },
  {
    id: StepId.AndroidPackage,
    title: "The lane packages the pond's library as a dev APK and an AAB, and bundletool derives the universal APK",
    needs: ["--library-apk", "--out", "--bundletool"],
  },
  {
    id: StepId.AabValidate,
    title: "bundletool validate passes and the bundle is targetSdk 36, minSdk 29, permission-free, 16 KB aligned",
    needs: ["--out", "--bundletool"],
  },
  {
    id: StepId.Zipalign16k,
    title: "zipalign -c -P 16 passes over the dev APK and the universal APK Play would make",
    needs: ["--out"],
  },
  {
    id: StepId.EmulatorPageSize,
    title: "The emulator runs a 16 KB page system image and its kernel reports a 16384-byte page",
    needs: ["--image"],
  },
  {
    id: StepId.EmulatorSmoke,
    title:
      "The dev APK installs and starts on the 16 KB emulator: a Vulkan core adapter and a presented frame, or the typed refusal, no crash",
    needs: ["--out"],
  },
  {
    id: StepId.EmulatorCapture,
    title:
      "An emulator screenshot taken with the game's window in focus is not blank: a scene after a render, the refusal screen after a refusal",
    needs: [],
  },
];

/** A workflow file's job that runs rows of the table. */
export interface WorkflowRow {
  file: string;
  job: string;
  /** The `runs-on` prefix the job must have. */
  runner: string;
  /** The job's `if:` with its whitespace and `${{ }}` removed; null when the job has none. */
  gate: string | null;
  steps: readonly StepId[];
}

const DISPATCH_ONLY = "github.event_name=='workflow_dispatch'";

/** Where each workflow calls this script. */
export const WORKFLOW_ROWS: readonly WorkflowRow[] = [
  {
    file: "rust-mobile.yml",
    job: "ios-simulator",
    runner: "macos-",
    gate: DISPATCH_ONLY,
    steps: [StepId.IosSimBoot, StepId.IosSimInstall, StepId.IosSimCapture, StepId.IosSimDelete],
  },
  {
    file: "rust-mobile.yml",
    job: "android-emulator",
    runner: "ubuntu-",
    gate: null,
    steps: [
      StepId.AndroidPackage,
      StepId.AabValidate,
      StepId.Zipalign16k,
      StepId.EmulatorPageSize,
      StepId.EmulatorSmoke,
      StepId.EmulatorCapture,
    ],
  },
];

/** The pins the workflow's `env:` must carry, as the script holds them. */
const WORKFLOW_PINS: Readonly<Record<string, string>> = {
  BUNDLETOOL_URL: BUNDLETOOL_PIN.url,
  BUNDLETOOL_SHA256: BUNDLETOOL_PIN.sha256,
  AVD_IMAGE: ANDROID_16K_IMAGE,
};

// ---- pure checks ----------------------------------------------------------------------------

/** Whether `id` is a Google APIs 16 KB page system image of Android 15 or later. */
export function sixteenKbImage(id: string): boolean {
  return IMAGE_16K.test(id);
}

/** A bundle id or application id that may reach a device shell: plain dotted identifier segments. */
export function checkAppId(id: string): string {
  const plain = id.length <= APP_ID_MAX_CHARS && APP_ID.test(id);
  if (!plain) fail(RustMobileCode.Usage, `${JSON.stringify(id.slice(0, 60))} is not a plain dotted application id`);
  return id;
}

/** `zipalign -c -P 16 -v 4`: the exit code and the report must both say the file is aligned. */
export function judgeZipalign(code: number | null, output: string): void {
  const clean = code === 0 && /Verification successful/.test(output) && !/BAD|FAILED/.test(output);
  if (!clean)
    fail(
      RustMobileCode.NotAligned,
      `zipalign -c -P 16 exited ${code}: ${output.trim().split("\n").slice(-4).join(" | ") || "no report"}`,
    );
}

/** What a bundle's manifest says, read back. */
export interface BundleManifestFacts {
  minSdk: number;
  targetSdk: number;
}

/** `bundletool dump manifest`: targetSdk and minSdk at the pins, and no `<uses-permission>`. */
export function checkBundleManifest(xml: string): BundleManifestFacts {
  const min = /android:minSdkVersion="(\d+)"/.exec(xml)?.[1];
  const target = /android:targetSdkVersion="(\d+)"/.exec(xml)?.[1];
  const problems: string[] = [];
  if (target !== String(ANDROID_PINS.targetSdk))
    problems.push(`targetSdkVersion ${target ?? "missing"}, needs ${ANDROID_PINS.targetSdk}`);
  if (min !== String(ANDROID_PINS.minSdk))
    problems.push(`minSdkVersion ${min ?? "missing"}, needs ${ANDROID_PINS.minSdk}`);
  if (PERMISSION_TAG.test(xml)) problems.push("it declares a permission");
  if (problems.length > 0) fail(RustMobileCode.ManifestRefused, problems.join("; "));
  return { minSdk: ANDROID_PINS.minSdk, targetSdk: ANDROID_PINS.targetSdk };
}

/** `bundletool dump config`: native libraries are stored and 16 KB page aligned in every APK Play makes. */
export function checkBundleConfig(config: string): void {
  if (!config.includes(ALIGNMENT_16K)) fail(RustMobileCode.ConfigRefused, `the bundle config has no ${ALIGNMENT_16K}`);
}

/** `adb shell getconf PAGE_SIZE` on the 16 KB image: exactly 16384. */
export function checkPageSize(output: string): void {
  if (output.trim() !== String(PAGE_BYTES))
    fail(RustMobileCode.PageSize, `the emulator's page size is ${JSON.stringify(output.trim())}, not ${PAGE_BYTES}`);
}

/** The lines of the app's own crash buffer: those naming its application id. */
export function crashLines(crashLog: string, applicationId: string): string[] {
  return crashLog.split("\n").filter((line) => line.includes(applicationId));
}

/** The newest available iOS Simulator runtime identifier in `simctl list runtimes --json`, or null. */
export function pickRuntime(json: string): string | null {
  try {
    const parsed: unknown = JSON.parse(json);
    const runtimes = (parsed as { runtimes?: unknown } | null)?.runtimes;
    if (!Array.isArray(runtimes)) return null;
    const ids = runtimes
      .filter(
        (r: Record<string, unknown> | null) =>
          r?.platform === "iOS" && r.isAvailable === true && typeof r.identifier === "string",
      )
      .map((r: Record<string, unknown>) => String(r.identifier));
    return ids.at(-1) ?? null;
  } catch {
    return null;
  }
}

/** The device types `simctl list runtimes --json` says `runtime` supports, or null when it names none. */
function supportedDeviceTypes(json: string, runtime: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(json);
    const runtimes = (parsed as { runtimes?: unknown } | null)?.runtimes;
    if (!Array.isArray(runtimes)) return null;
    const entry: unknown = runtimes.find((r: { identifier?: unknown } | null) => r?.identifier === runtime);
    const types = (entry as { supportedDeviceTypes?: unknown } | undefined)?.supportedDeviceTypes;
    return Array.isArray(types) ? types : null;
  } catch {
    return null;
  }
}

/**
 * The newest plain `iPhone <n>` device type `runtime` supports, by its number, from
 * `simctl list runtimes --json`; null when it supports none. The runtime's own list matters: Xcode
 * lists every device type it knows (iPhone 7 among them, newest first), and a new runtime refuses
 * to create the old ones.
 */
export function pickDeviceType(json: string, runtime: string): string | null {
  let best: { number: number; id: string } | null = null;
  for (const type of supportedDeviceTypes(json, runtime) ?? []) {
    const { name, identifier } = (type ?? {}) as { name?: unknown; identifier?: unknown };
    const plain = typeof name === "string" ? PLAIN_IPHONE.exec(name) : null;
    if (!plain || typeof identifier !== "string" || !DEVICE_TYPE_ID.test(identifier)) continue;
    const number = Number(plain[1]);
    if (!best || number > best.number) best = { number, id: identifier };
  }
  return best?.id ?? null;
}

/** A decoded PNG: 8-bit samples (a 16-bit sample keeps its high byte). */
export interface Raster {
  width: number;
  height: number;
  channels: number;
  samples: Uint8Array;
}

const COLOUR_CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 };
const PNG_DEPTHS: ReadonlySet<number> = new Set([8, 16]);

function badPng(detail: string): never {
  return fail(RustMobileCode.BadPng, detail);
}

interface PngHeader {
  width: number;
  height: number;
  depth: number;
  channels: number;
}

/** The chunks of a PNG, each CRC checked; stops at IEND. */
function pngChunks(bytes: Buffer): Array<{ type: string; data: Buffer }> {
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))
    badPng("not a PNG");
  const chunks: Array<{ type: string; data: Buffer }> = [];
  let at = PNG_SIGNATURE.length;
  while (at + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    const end = at + 8 + length;
    if (end + 4 > bytes.length) badPng(`the ${type} chunk is cut off`);
    const data = bytes.subarray(at + 8, end);
    if (zlib.crc32(bytes.subarray(at + 4, end)) !== bytes.readUInt32BE(end)) badPng(`the ${type} chunk's CRC is wrong`);
    chunks.push({ type, data });
    if (type === "IEND") return chunks;
    at = end + 4;
  }
  return badPng("no IEND chunk");
}

function pngHeader(chunks: ReadonlyArray<{ type: string; data: Buffer }>): PngHeader {
  const header = chunks[0];
  if (header?.type !== "IHDR" || header.data.length !== 13) return badPng("no IHDR first");
  const width = header.data.readUInt32BE(0);
  const height = header.data.readUInt32BE(4);
  const [depth = 0, colorType = 0, compression = 0, filter = 0, interlace = 0] = [...header.data.subarray(8)];
  const channels = COLOUR_CHANNELS[colorType];
  const sized =
    width >= 1 && height >= 1 && width <= PNG_MAX_SIDE && height <= PNG_MAX_SIDE && width * height <= PNG_MAX_PIXELS;
  if (!sized) badPng(`${width} x ${height} pixels is not a screenshot`);
  if (channels === undefined || !PNG_DEPTHS.has(depth)) badPng(`colour type ${colorType} at ${depth} bits is not read`);
  if (compression !== 0 || filter !== 0 || interlace !== 0) badPng("an interlaced or unknown-method PNG is not read");
  return { width, height, depth, channels };
}

/** Undoes the row filters over `raw` (rows of `1 + rowBytes`); answers the samples, row after row. */
function unfilter(raw: Buffer, height: number, rowBytes: number, bpp: number): Buffer {
  const out = Buffer.alloc(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const type = raw[y * (rowBytes + 1)] ?? 0;
    if (type > 4) badPng(`row ${y} has filter ${type}`);
    unfilterRow(raw, out, { y, type, rowBytes, bpp });
  }
  return out;
}

function unfilterRow(raw: Buffer, out: Buffer, row: { y: number; type: number; rowBytes: number; bpp: number }): void {
  const { y, type, rowBytes, bpp } = row;
  const here = y * rowBytes;
  const above = here - rowBytes;
  for (let i = 0; i < rowBytes; i++) {
    const x = raw[y * (rowBytes + 1) + 1 + i] ?? 0;
    const hasLeft = i >= bpp;
    const left = hasLeft ? (out[here + i - bpp] ?? 0) : 0;
    const up = y > 0 ? (out[above + i] ?? 0) : 0;
    const upLeft = y > 0 && hasLeft ? (out[above + i - bpp] ?? 0) : 0;
    out[here + i] = (x + predictor(type, left, up, upLeft)) & 0xff;
  }
}

function predictor(type: number, left: number, up: number, upLeft: number): number {
  if (type === 1) return left;
  if (type === 2) return up;
  if (type === 3) return (left + up) >> 1;
  if (type !== 4) return 0;
  const p = left + up - upLeft;
  const [pl, pu, pul] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
  if (pl <= pu && pl <= pul) return left;
  return pu <= pul ? up : upLeft;
}

/** Reads a PNG (non-interlaced, grey, grey+alpha, RGB or RGBA at 8 or 16 bits); a typed refusal otherwise. */
export function decodePng(input: Uint8Array): Raster {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const chunks = pngChunks(bytes);
  const header = pngHeader(chunks);
  const idat = chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data);
  if (idat.length === 0) badPng("no IDAT chunk");
  const bytesPer = header.depth / 8;
  const rowBytes = header.width * header.channels * bytesPer;
  const expected = (rowBytes + 1) * header.height;
  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch (error) {
    return badPng(`the pixel data does not inflate: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw.length !== expected) badPng(`the pixel data is ${raw.length} bytes, ${expected} expected`);
  const rows = unfilter(raw, header.height, rowBytes, header.channels * bytesPer);
  const samples = new Uint8Array(header.width * header.height * header.channels);
  for (let i = 0; i < samples.length; i++) samples[i] = rows[i * bytesPer] ?? 0;
  return { width: header.width, height: header.height, channels: header.channels, samples };
}

/** What a capture's centre shows. */
export interface CaptureFacts {
  width: number;
  height: number;
  colours: number;
  /** The share of the centre's pixels that have its commonest colour. */
  dominantShare: number;
}

/** The colours of the centre quarter of a capture (the status bar, notch and navigation bar are not the game). */
function measureCentre(raster: Raster): { colours: number; dominantShare: number } {
  const counts = new Map<number, number>();
  const [x0, x1] = [Math.floor(raster.width / 4), Math.ceil((raster.width * 3) / 4)];
  const [y0, y1] = [Math.floor(raster.height / 4), Math.ceil((raster.height * 3) / 4)];
  let total = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const key = pixelKey(raster, (y * raster.width + x) * raster.channels);
      total += 1;
      const seen = counts.get(key);
      if (seen !== undefined) counts.set(key, seen + 1);
      else if (counts.size < COLOUR_CAP) counts.set(key, 1);
    }
  return { colours: counts.size, dominantShare: total === 0 ? 1 : Math.max(0, ...counts.values()) / total };
}

/** One pixel's colour as a number (grey ignores alpha; the colour types ignore alpha too). */
function pixelKey({ samples, channels }: Raster, at: number): number {
  if (channels < 3) return samples[at] ?? 0;
  return ((samples[at] ?? 0) << 16) | ((samples[at + 1] ?? 0) << 8) | (samples[at + 2] ?? 0);
}

/** A screenshot's PNG must show at least `minColours` colours in its centre and not be (nearly) one colour. */
export function checkScreenshot(png: Uint8Array, minColours: number): CaptureFacts {
  const raster = decodePng(png);
  const { colours, dominantShare } = measureCentre(raster);
  if (colours < minColours || dominantShare > BLANK_SHARE)
    fail(
      RustMobileCode.BlankCapture,
      `the capture's centre has ${colours} colours (${(dominantShare * 100).toFixed(1)}% the commonest), ${minColours} needed: nothing was drawn`,
    );
  return { width: raster.width, height: raster.height, colours, dominantShare };
}

/** A system window title Android gives the not-responding dialog of a process: this, then the process. */
const NOT_RESPONDING_PREFIX = "Application Not Responding: ";
/** `dumpsys`'s line for the window in focus: `mCurrentFocus=Window{<hash> u<user> <title>}`, or `null`. */
const FOCUS_LINE = /^\s*mCurrentFocus=(?:Window\{[0-9a-f]+ u\d+ ([^}\n]+)\}|null)\s*$/m;

/**
 * The title of the window in focus in an activity or window stack dump (an activity's
 * `package/class`, or a system window's title), the first display's; null when none has focus or the
 * dump has no focus line.
 */
export function windowInFocus(dump: string): string | null {
  return FOCUS_LINE.exec(dump)?.[1]?.trim() ?? null;
}

/**
 * An emulator capture is the game's only if the game's own activity window (`component`) had focus:
 * a system dialog over it (seen in a CI run: "System UI isn't responding" over a black screen)
 * passes the colour rule, which reads only the centre the dialog covers. Answers the window in focus.
 */
export function checkCaptureFocus(dump: string, component: string): string {
  const focus = windowInFocus(dump);
  if (focus === component) return focus;
  const app = component.split("/")[0] ?? "";
  if (focus === `${NOT_RESPONDING_PREFIX}${app}`)
    return fail(RustMobileCode.CaptureNotGame, `the app itself is not responding: ${focus} had focus`);
  return fail(
    RustMobileCode.CaptureNotGame,
    `${focus ?? "no window"} had focus when the screen was captured, not ${component}: the capture is not the game's`,
  );
}

/** What a refusal capture's centre shows, besides the non-blank facts. */
export interface RefusalCaptureFacts extends CaptureFacts {
  /** The share of the centre in the screen's background, and in its message ink. */
  backgroundShare: number;
  inkShare: number;
}

/** Whether a captured pixel is `colour`, within what colour management moves it. */
function near(raster: Raster, at: number, colour: Rgb): boolean {
  const { samples, channels } = raster;
  const rgb = channels < 3 ? [samples[at], samples[at], samples[at]] : [samples[at], samples[at + 1], samples[at + 2]];
  return rgb.every((value, c) => Math.abs((value ?? 0) - colour[c]) <= REFUSAL_COLOUR_TOLERANCE);
}

/** The shares of a capture's centre quarter in `background` and in `ink`. */
function centreShares(raster: Raster, background: Rgb, ink: Rgb): { backgroundShare: number; inkShare: number } {
  const [x0, x1] = [Math.floor(raster.width / 4), Math.ceil((raster.width * 3) / 4)];
  const [y0, y1] = [Math.floor(raster.height / 4), Math.ceil((raster.height * 3) / 4)];
  let [total, onBackground, onInk] = [0, 0, 0];
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const at = (y * raster.width + x) * raster.channels;
      total += 1;
      if (near(raster, at, background)) onBackground += 1;
      else if (near(raster, at, ink)) onInk += 1;
    }
  return { backgroundShare: total === 0 ? 0 : onBackground / total, inkShare: total === 0 ? 0 : onInk / total };
}

/**
 * A capture after a refusal must be the screen the shell logged: not blank, its centre mostly the
 * screen's background, with the message's ink on it.
 */
export function checkRefusalScreen(png: Uint8Array, screen: RefusalScreenFacts): RefusalCaptureFacts {
  const facts = checkScreenshot(png, MIN_COLOURS.Refusal);
  const shares = centreShares(decodePng(png), screen.background, screen.ink);
  const isScreen = shares.backgroundShare >= REFUSAL_BACKGROUND_MIN_SHARE && shares.inkShare >= REFUSAL_INK_MIN_SHARE;
  if (!isScreen)
    fail(
      RustMobileCode.NotRefusalScreen,
      `the capture's centre is ${(shares.backgroundShare * 100).toFixed(1)}% the screen's background ${JSON.stringify(screen.background)} and ${(shares.inkShare * 100).toFixed(2)}% its ink ${JSON.stringify(screen.ink)}: the ${screen.code} refusal screen is not what is drawn`,
    );
  return { ...facts, ...shares };
}

/** The refusal screen a smoke's log names must be shown and name the refusal record's code. */
function judgeRefusalScreen(screen: RefusalScreenFacts | null): RefusalScreenFacts {
  if (screen === null)
    return fail(
      RustMobileCode.RefusalNotShown,
      "the shell refused the GPU but logged no refusal screen with its colours",
    );
  if (!screen.shown)
    fail(
      RustMobileCode.RefusalNotShown,
      `the shell could not draw the ${screen.code} refusal screen: the window stays empty`,
    );
  if (screen.code !== screen.recordCode)
    fail(
      RustMobileCode.RefusalNotShown,
      `the refusal screen names ${screen.code}, the refusal record ${screen.recordCode || "nothing"}`,
    );
  return screen;
}

/** A phone shell's smoke verdict: a failure, a wrong adapter or no outcome at all fails the row. */
function judgeSmoke(verdict: ShellSmokeVerdict): ShellSmokeVerdict {
  if (!verdict.pass) fail(RustMobileCode.SmokeFailed, `${verdict.outcome}: ${verdict.detail}`);
  return verdict;
}

/** The colours a capture needs after a smoke that ended as `outcome`. */
function minColoursAfter(outcome: unknown): number {
  return outcome === ShellSmoke.Adapter ? MIN_COLOURS.Rendered : MIN_COLOURS.Refusal;
}

// ---- the workflow check ---------------------------------------------------------------------

const ALWAYS_REACHED = new Set(["", "!cancelled()", "always()"]);
const normalCondition = (condition: string | null) => (condition ?? "").replace(/\$\{\{|\}\}|\s/g, "");

function drift(detail: string): never {
  return fail(RustMobileCode.WorkflowDrift, detail);
}

/** The ids a job passes to `--step`, in order, each with its step's own `if:` normalised. */
function jobCalls(job: WorkflowJob): Array<{ id: string; condition: string }> {
  return job.steps.flatMap((step) =>
    [...step.run.matchAll(/scripts\/ci\/rust-mobile\.ts --step ([A-Za-z0-9-]+)/g)].map((match) => ({
      id: match[1] ?? "",
      condition: normalCondition(step.ifCondition),
    })),
  );
}

function checkRow(file: string, row: WorkflowRow, job: WorkflowJob): void {
  if (!(job.runsOn ?? "").startsWith(row.runner))
    drift(`${row.job} must run on ${row.runner}*, it runs on ${job.runsOn}`);
  const gate = job.ifCondition === null ? null : normalCondition(job.ifCondition);
  if (gate !== row.gate)
    drift(
      `${row.job} must have ${row.gate === null ? "no if" : `if: ${row.gate}`}, it has ${job.ifCondition ?? "no if"}`,
    );
  const known = new Set<string>(STEP_TABLE.map((step) => step.id));
  const calls = jobCalls(job);
  for (const call of calls)
    if (!known.has(call.id)) fail(RustMobileCode.UnknownStep, `${file} calls --step ${call.id}`);
  for (const call of calls)
    if (!ALWAYS_REACHED.has(call.condition))
      drift(`${file} calls --step ${call.id} under \`if: ${call.condition}\`, which can skip it`);
  if (calls.map((call) => call.id).join() !== row.steps.join())
    drift(
      `${file}'s ${row.job} job calls ${calls.map((call) => call.id).join(", ") || "nothing"}, the table says ${row.steps.join(", ")}`,
    );
}

/** The workflow's pinned values (`NAME: value` lines) are the script's, each stated once. */
function checkPins(file: string, text: string): void {
  for (const [name, value] of Object.entries(WORKFLOW_PINS)) {
    const found = [...text.matchAll(new RegExp(`^\\s+${name}:\\s*(\\S+)\\s*$`, "gm"))].map((match) => match[1]);
    if (found.length !== 1 || found[0] !== value)
      drift(`${file}'s ${name} is ${found.join(", ") || "missing"}, the script pins ${value}`);
  }
}

/** A workflow calls its rows' steps once each, in the table's order, no step-level `if:` can skip one, and its pins are the script's. */
export function checkWorkflow(file: string, text: string): void {
  const rows = WORKFLOW_ROWS.filter((candidate) => candidate.file === file);
  if (rows.length === 0) fail(RustMobileCode.UnknownStep, `${file} is not a workflow the table names`);
  const jobs = workflowJobs(text);
  for (const row of rows) {
    const job = jobs.find((candidate) => candidate.name === row.job) ?? drift(`${file} has no ${row.job} job`);
    checkRow(file, row, job);
  }
  checkPins(file, text);
}

// ---- running things -------------------------------------------------------------------------

/** The flags a step reads. */
const FLAG_NAMES = ["--app", "--app-id", "--out", "--library-apk", "--bundletool", "--image"] as const;
type FlagName = (typeof FLAG_NAMES)[number];
type Flags = Partial<Record<FlagName, string>>;

/** What a step run knows. */
export interface Context {
  evidence: string;
  env: NodeJS.ProcessEnv;
  flags: Flags;
  /** The digest the bundletool jar must have. */
  bundletoolSha256: string;
  /** How long a smoke waits between reads of the lifecycle log, and for how long in all. */
  pollMs: number;
  waitMs: number;
}

/** A context with the defaults a CI run has; a test passes what it stubs. */
export function makeContext(partial: Partial<Context> & { evidence: string }): Context {
  return {
    env: process.env,
    flags: {},
    bundletoolSha256: BUNDLETOOL_PIN.sha256,
    pollMs: SMOKE_POLL_MS,
    waitMs: SMOKE_WAIT_MS,
    ...partial,
  };
}

/** What a step reports into its record. */
type Facts = Record<string, unknown>;

interface ExecResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  missing: boolean;
}

function exec(file: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { encoding: "buffer", env, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        const code = error ? (error as { code?: unknown }).code : 0;
        resolve({
          code: typeof code === "number" ? code : null,
          stdout,
          stderr,
          missing: code === "ENOENT",
        });
      },
    );
  });
}

const textOf = (result: ExecResult): string => `${result.stdout.toString("utf8")}${result.stderr.toString("utf8")}`;

/** A tool that could not be started is `tool-missing`; one that ran is the caller's to judge. */
async function run(
  file: string,
  args: readonly string[],
  ctx: Context,
  timeoutMs = TOOL_TIMEOUT_MS,
): Promise<ExecResult> {
  const result = await exec(file, args, ctx.env, timeoutMs);
  if (result.missing) fail(RustMobileCode.ToolMissing, `${file} is not on this runner`);
  return result;
}

async function writeRecord(ctx: Context, id: string, record: Facts): Promise<void> {
  await mkdir(ctx.evidence, { recursive: true });
  await writeFile(
    path.join(ctx.evidence, `${id}.json`),
    `${JSON.stringify({ format: FORMAT, step: id, ...record }, null, 2)}\n`,
  );
}

async function readRecord(ctx: Context, id: string): Promise<Facts | null> {
  const text = await readFile(path.join(ctx.evidence, `${id}.json`), "utf8").catch(() => null);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Facts) : null;
  } catch {
    return null;
  }
}

/** A prior step's record, which must have passed. */
async function passedRecord(ctx: Context, id: StepId): Promise<Facts> {
  const record = await readRecord(ctx, id);
  if (record === null || record.status !== StepStatus.Pass)
    return fail(
      RustMobileCode.BadRecord,
      `${id} has not passed on this run (${path.join(ctx.evidence, `${id}.json`)})`,
    );
  return record;
}

const flagOf = (ctx: Context, flag: FlagName): string =>
  ctx.flags[flag] ?? fail(RustMobileCode.Usage, `${flag} is required for this step`);

/** `--app-id`, or the application id the package step recorded. */
async function applicationIdOf(ctx: Context): Promise<string> {
  const given = ctx.flags["--app-id"];
  if (given !== undefined) return checkAppId(given);
  const recorded = (await passedRecord(ctx, StepId.AndroidPackage)).applicationId;
  if (typeof recorded !== "string") return fail(RustMobileCode.BadRecord, "the package record names no applicationId");
  try {
    return checkAppId(recorded);
  } catch {
    return fail(RustMobileCode.BadRecord, "the package record's applicationId is not a plain application id");
  }
}

/** An existing regular file (no final link) of the flag's path, with the suffix. */
async function fileOf(ctx: Context, flag: FlagName, suffix: string): Promise<string> {
  const file = flagOf(ctx, flag);
  const info = path.isAbsolute(file) && file.endsWith(suffix) ? await lstat(file).catch(() => null) : null;
  if (!info?.isFile()) fail(RustMobileCode.Usage, `${flag} must be an existing absolute ${suffix} file, not a link`);
  return file;
}

// ---- iOS Simulator --------------------------------------------------------------------------

const xcrunOf = (ctx: Context): string => ctx.env.GENEX_XCRUN || "xcrun";

const simctl = (ctx: Context, args: readonly string[], timeoutMs = TOOL_TIMEOUT_MS) =>
  run(xcrunOf(ctx), ["simctl", ...args], ctx, timeoutMs);

/** A simctl call that must succeed. */
async function simctlOk(ctx: Context, args: readonly string[], timeoutMs = TOOL_TIMEOUT_MS): Promise<string> {
  const result = await simctl(ctx, args, timeoutMs);
  if (result.code !== 0)
    fail(
      RustMobileCode.SimulatorFailed,
      `simctl ${args.join(" ")} exited ${result.code}: ${textOf(result).trim().slice(0, 300)}`,
    );
  return result.stdout.toString("utf8");
}

async function stepIosSimBoot(ctx: Context): Promise<Facts> {
  const runtimes = await simctlOk(ctx, ["list", "runtimes", "--json"]);
  const runtime = pickRuntime(runtimes);
  if (runtime === null) fail(RustMobileCode.SimulatorFailed, "no available iOS Simulator runtime on this runner");
  const deviceType = pickDeviceType(runtimes, runtime);
  if (deviceType === null) fail(RustMobileCode.SimulatorFailed, `${runtime} supports no plain iPhone device type`);
  const udid = (await simctlOk(ctx, ["create", SIMULATOR_NAME, deviceType, runtime])).trim();
  if (!UDID.test(udid))
    fail(
      RustMobileCode.SimulatorFailed,
      `simctl create answered ${JSON.stringify(udid.slice(0, 60))}, not a device id`,
    );
  await writeRecord(ctx, DEVICE_FILE.replace(/\.json$/, ""), { udid, runtime, deviceType });
  await simctlOk(ctx, ["boot", udid]);
  await simctlOk(ctx, ["bootstatus", udid, "-b"], SIMULATOR_BOOT_TIMEOUT_MS);
  return {
    udid,
    runtime,
    deviceType,
    summary: `iOS Simulator booted: ${deviceType.split(".").at(-1)} on ${runtime.split(".").at(-1)}`,
  };
}

/** The Simulator the boot step made, from its record. */
async function simulatorOf(ctx: Context): Promise<{ udid: string } | null> {
  const record = await readRecord(ctx, DEVICE_FILE.replace(/\.json$/, ""));
  if (record === null) return null;
  const udid = record.udid;
  if (typeof udid !== "string" || !UDID.test(udid))
    return fail(RustMobileCode.BadRecord, `${DEVICE_FILE} does not hold a Simulator id`);
  return { udid };
}

async function bootedSimulator(ctx: Context): Promise<string> {
  const device = await simulatorOf(ctx);
  return device?.udid ?? fail(RustMobileCode.BadRecord, "no Simulator was created on this run: run ios-sim-boot first");
}

/** The shell's lifecycle log in the app's data container, or "". */
const readLog = (file: string) => readFile(file, "utf8").catch(() => "");

/** A smoke's verdict and, after an admitted adapter, the first frame the shell presented (null: none yet). */
interface SmokeRead {
  verdict: ShellSmokeVerdict;
  frame: FirstFrameFacts | null;
}

/** Whether a smoke has read all it waits for: a terminal verdict, and after an adapter the first frame. */
const settled = ({ verdict, frame }: SmokeRead): boolean =>
  verdict.outcome !== ShellSmoke.NoOutcome && (verdict.outcome !== ShellSmoke.Adapter || frame !== null);

/**
 * Polls `read` until it answers a terminal verdict (after an adapter, also the first frame the shell
 * presented) or the wait is spent; answers the last read.
 */
async function pollVerdict(
  ctx: Context,
  read: () => Promise<string>,
  backend: typeof NativeBackend.Metal | typeof NativeBackend.Vulkan,
): Promise<SmokeRead> {
  const attempts = Math.max(1, Math.ceil(ctx.waitMs / ctx.pollMs));
  let last: SmokeRead = { verdict: shellSmokeVerdict("", backend), frame: null };
  for (let attempt = 0; attempt < attempts; attempt++) {
    const log = await read();
    last = { verdict: shellSmokeVerdict(log, backend), frame: firstFrameOf(log) };
    if (settled(last)) return last;
    await sleep(ctx.pollMs);
  }
  return last;
}

/**
 * An admitted adapter must have presented a frame (seen in a CI run: the smoke passed
 * on the adapter alone and the capture showed no scene); a refusal draws its screen instead.
 */
function judgeFirstFrame(ctx: Context, { verdict, frame }: SmokeRead): FirstFrameFacts | undefined {
  if (verdict.outcome !== ShellSmoke.Adapter) return undefined;
  if (frame !== null) return frame;
  return fail(
    RustMobileCode.NoFramePresented,
    `the shell admitted ${verdict.detail} but presented no frame within ${Math.round(ctx.waitMs / SECOND_MS)} s`,
  );
}

/** Polls `read` until its newest refusal screen is shown or the wait is spent; answers the last one read. */
async function pollRefusalScreen(ctx: Context, read: () => Promise<string>): Promise<RefusalScreenFacts | null> {
  const attempts = Math.max(1, Math.ceil(ctx.waitMs / ctx.pollMs));
  let screen: RefusalScreenFacts | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    screen = refusalScreenOf(await read());
    if (screen?.shown) return screen;
    await sleep(ctx.pollMs);
  }
  return screen;
}

/** The refusal screen a capture after `smoke` must show, from the smoke's record; null after a render. */
function refusalScreenAfter(smoke: Facts, step: StepId): RefusalScreenFacts | null {
  if (smoke.outcome !== ShellSmoke.GpuUnsupported) return null;
  const screen = refusalScreenFacts(smoke.refusalScreen);
  if (screen === null || !screen.shown)
    return fail(RustMobileCode.BadRecord, `${step} recorded a refusal without the refusal screen it drew`);
  return screen;
}

async function stepIosSimInstall(ctx: Context): Promise<Facts> {
  const app = flagOf(ctx, "--app");
  const info = path.isAbsolute(app) && app.endsWith(".app") ? await lstat(app).catch(() => null) : null;
  if (!info?.isDirectory()) fail(RustMobileCode.Usage, "--app must be an existing absolute .app folder, not a link");
  const appId = checkAppId(flagOf(ctx, "--app-id"));
  const udid = await bootedSimulator(ctx);
  await simctlOk(ctx, ["install", udid, app]);
  await simctlOk(ctx, ["launch", udid, appId]);
  const data = (await simctlOk(ctx, ["get_app_container", udid, appId, "data"])).trim();
  if (!path.isAbsolute(data)) fail(RustMobileCode.SimulatorFailed, "simctl get_app_container did not answer a folder");
  const records = path.join(data, "Documents", RECORDS_FOLDER);
  const read = () => readLog(path.join(records, LIFECYCLE_FILE));
  const smoke = await pollVerdict(ctx, read, NativeBackend.Metal);
  const { verdict } = smoke;
  const refused = verdict.outcome === ShellSmoke.GpuUnsupported;
  const screen = refused ? await pollRefusalScreen(ctx, read) : null;
  await cp(records, path.join(ctx.evidence, RECORDS_FOLDER), { recursive: true, force: true }).catch(() => undefined);
  judgeSmoke(verdict);
  const firstFrame = judgeFirstFrame(ctx, smoke);
  const refusalScreen = refused ? judgeRefusalScreen(screen) : undefined;
  const shown = refusalScreen ? `, the ${refusalScreen.code} refusal screen shown` : "";
  return {
    appId,
    outcome: verdict.outcome,
    detail: verdict.detail,
    firstFrame,
    refusalScreen,
    summary: `iOS Simulator smoke: ${verdict.outcome}: ${verdict.detail}${shown}`,
  };
}

async function stepIosSimCapture(ctx: Context): Promise<Facts> {
  const udid = await bootedSimulator(ctx);
  const smoke = await passedRecord(ctx, StepId.IosSimInstall);
  const screen = refusalScreenAfter(smoke, StepId.IosSimInstall);
  const file = path.join(ctx.evidence, IOS_CAPTURE_FILE);
  await simctlOk(ctx, ["io", udid, "screenshot", "--type=png", file]);
  const png = await readFile(file).catch(() => Buffer.alloc(0));
  if (screen !== null) {
    const facts = checkRefusalScreen(png, screen);
    return {
      file: IOS_CAPTURE_FILE,
      afterOutcome: smoke.outcome,
      refusalCode: screen.code,
      ...facts,
      summary: `iOS Simulator capture: the ${screen.code} refusal screen (${(facts.backgroundShare * 100).toFixed(1)}% background, ${(facts.inkShare * 100).toFixed(2)}% ink)`,
    };
  }
  const facts = checkScreenshot(png, MIN_COLOURS.Rendered);
  return {
    file: IOS_CAPTURE_FILE,
    afterOutcome: smoke.outcome,
    ...facts,
    summary: `iOS Simulator capture: ${facts.colours} colours`,
  };
}

async function stepIosSimDelete(ctx: Context): Promise<Facts> {
  const device = await simulatorOf(ctx);
  if (device === null) return { deleted: false };
  await simctl(ctx, ["shutdown", device.udid]);
  await simctlOk(ctx, ["delete", device.udid]);
  await rm(path.join(ctx.evidence, DEVICE_FILE), { force: true });
  return { deleted: true, udid: device.udid };
}

// ---- Android tools --------------------------------------------------------------------------

interface SdkTools {
  sdk: string;
  adb: string;
  buildTools: string;
}

/** The SDK the runner provides, its `adb` and the newest build-tools of the pinned major. */
async function sdkOf(ctx: Context): Promise<SdkTools> {
  const sdk = ctx.env.ANDROID_HOME || ctx.env.ANDROID_SDK_ROOT;
  if (!sdk) return fail(RustMobileCode.ToolMissing, "ANDROID_HOME names no Android SDK");
  const versions = await readdir(path.join(sdk, "build-tools")).catch(() => [] as string[]);
  const pinned = versions
    .filter((version) => version.startsWith(`${ANDROID_PINS.buildToolsMajor}.`))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const newest = pinned.at(-1);
  if (newest === undefined)
    return fail(RustMobileCode.ToolMissing, `no build-tools ${ANDROID_PINS.buildToolsMajor}.x under ${sdk}`);
  return { sdk, adb: path.join(sdk, "platform-tools", "adb"), buildTools: path.join(sdk, "build-tools", newest) };
}

/** The JDK 21 home the runner provides. */
function javaHomeOf(ctx: Context): string {
  const home = ctx.env.GENEX_CI_JAVA_HOME || ctx.env.JAVA_HOME_21_X64 || ctx.env.JAVA_HOME;
  if (!home || !existsSync(path.join(home, "bin", "java")))
    return fail(RustMobileCode.ToolMissing, "no JDK 21 (JAVA_HOME_21_X64, JAVA_HOME)");
  return home;
}

/** The bundletool jar, at the pinned digest. */
async function bundletoolOf(ctx: Context): Promise<string> {
  const jar = ctx.flags["--bundletool"] ?? ctx.env.GENEX_BUNDLETOOL_JAR;
  const bytes = jar === undefined ? null : await readFile(jar).catch(() => null);
  if (jar === undefined || bytes === null) return fail(RustMobileCode.ToolMissing, "no bundletool jar (--bundletool)");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== ctx.bundletoolSha256)
    fail(RustMobileCode.BundletoolPin, `${jar} digests to ${digest}, the pin is ${ctx.bundletoolSha256}`);
  return jar;
}

/** The package folder: it exists. */
async function outOf(ctx: Context): Promise<string> {
  const out = flagOf(ctx, "--out");
  const info = path.isAbsolute(out) ? await lstat(out).catch(() => null) : null;
  if (!info?.isDirectory()) fail(RustMobileCode.Usage, "--out must be an existing absolute folder");
  return out;
}

/** A package the package step made: a regular file in the package folder. */
async function packageFile(out: string, name: string): Promise<string> {
  const file = path.join(out, name);
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile()) fail(RustMobileCode.BadRecord, `${file} is missing: run android-package first`);
  return file;
}

// ---- Android package, Play checks -------------------------------------------------------------

/** Runs each lane tool directly: the runner is disposable and holds nothing of anyone's (see the file's header). */
function passThroughSandbox(): AndroidToolSandbox {
  return {
    run: (request) =>
      new Promise<RunResult>((resolve) => {
        const started = Date.now();
        execFile(
          "/bin/sh",
          ["-c", request.command],
          { cwd: request.cwd, env: { ...request.env }, timeout: request.timeoutMs, maxBuffer: MAX_OUTPUT_BYTES },
          (error, stdout, stderr) => {
            const code = error ? (error as { code?: unknown }).code : 0;
            resolve({
              code: typeof code === "number" ? code : null,
              signal: null,
              stdout: String(stdout),
              stderr: String(stderr),
              durationMs: Date.now() - started,
              timedOut: error !== null && (error as { killed?: boolean }).killed === true,
              truncated: false,
              sandboxed: false,
              command: request.command,
              cwd: request.cwd,
            });
          },
        );
      }),
    dispose: async () => undefined,
  };
}

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The pond's `libmain.so` out of the spike's APK. */
async function libraryOf(apk: string): Promise<Buffer> {
  const entry = readZipEntries(await readFile(apk)).find((each) => each.name === ANDROID_LIBRARY_ENTRY);
  return entry ? zipEntryData(entry) : fail(RustMobileCode.BadRecord, `${apk} has no ${ANDROID_LIBRARY_ENTRY}`);
}

const MANIFEST = {
  applicationId: "games.genex.game.g0123456789ab",
  label: "Genex CI Pond",
  versionCode: 1,
  versionName: "1.0",
  orientation: AndroidOrientation.Landscape,
} as const;

/** A throwaway PKCS12 upload key made on the runner. */
async function makeUploadKey(javaHome: string, keystore: string, password: string, ctx: Context): Promise<void> {
  await mkdir(path.dirname(keystore), { recursive: true });
  const keytool = path.join(javaHome, "bin", "keytool");
  const args = ["-genkeypair", "-noprompt", "-keystore", keystore, "-storetype", "PKCS12", "-alias", UPLOAD_ALIAS];
  args.push("-keyalg", "RSA", "-keysize", "2048", "-validity", "2", "-dname", "CN=Genex CI Throwaway");
  args.push("-storepass", password, "-keypass", password);
  const made = await run(keytool, args, ctx);
  if (made.code !== 0) fail(RustMobileCode.PackageFailed, `keytool exited ${made.code}`);
}

/** The universal APK Play would make from the bundle, taken out of bundletool's `.apks`. */
async function universalApk(
  ctx: Context,
  java: string,
  jar: string,
  bundle: string,
  keystore: string,
  password: string,
  work: string,
): Promise<Buffer> {
  const apks = path.join(work, "pond.apks");
  const keys = [
    `--ks=${keystore}`,
    `--ks-pass=pass:${password}`,
    `--ks-key-alias=${UPLOAD_ALIAS}`,
    `--key-pass=pass:${password}`,
  ];
  const made = await run(
    java,
    ["-jar", jar, "build-apks", "--mode=universal", `--bundle=${bundle}`, `--output=${apks}`, ...keys],
    ctx,
  );
  if (made.code !== 0)
    fail(RustMobileCode.PackageFailed, `bundletool build-apks exited ${made.code}: ${textOf(made).slice(0, 300)}`);
  const entry = readZipEntries(await readFile(apks)).find((each) => each.name === "universal.apk");
  return entry ? zipEntryData(entry) : fail(RustMobileCode.PackageFailed, "bundletool's .apks holds no universal.apk");
}

async function stepAndroidPackage(ctx: Context): Promise<Facts> {
  const { buildTools, sdk } = await sdkOf(ctx);
  const javaHome = javaHomeOf(ctx);
  const jar = await bundletoolOf(ctx);
  const library = await libraryOf(await fileOf(ctx, "--library-apk", ".apk"));
  const out = await outOf(ctx);
  const tools: AndroidPackageTools = {
    aapt2: path.join(buildTools, "aapt2"),
    zipalign: path.join(buildTools, "zipalign"),
    apksigner: path.join(buildTools, "apksigner"),
    androidJar: path.join(sdk, "platforms", ANDROID_PINS.platform, "android.jar"),
    javaHome,
    bundletoolJar: jar,
  };
  for (const [name, file] of Object.entries(tools))
    if (!existsSync(file)) fail(RustMobileCode.ToolMissing, `${name} is not at ${file}`);
  for (const name of [DEV_APK, BUNDLE, UNIVERSAL_APK]) await rm(path.join(out, name), { force: true });
  const work = await mkdtemp(path.join(os.tmpdir(), "genex-mobile-ci-"));
  try {
    const password = randomBytes(18).toString("hex");
    const context: AndroidPackageContext = {
      tools,
      sandboxFor: async () => passThroughSandbox(),
      stagingRoot: path.join(work, "staging"),
      secretPaths: [],
      denyWrite: [],
      secretValues: [password],
      signer: {
        host: process.platform === "darwin" ? StudioPlatform.Mac : StudioPlatform.Linux,
        home: path.join(work, "home"),
        env: { [KEY_ENV]: password },
        forbiddenRoots: [],
        keyHome: path.join(work, "keys", "android-debug"),
      },
    };
    const gameOut = path.join(work, "game.out");
    await mkdir(gameOut);
    await writeFile(path.join(gameOut, "game"), library);
    const payload = await readAndroidPayload(gameOut, [{ path: "game", sha256: sha256Of(library) }]);
    const dev = await packageAndroidApk(context, {
      manifest: MANIFEST,
      payload,
      notices: [],
      signing: { kind: ExportSigning.AndroidDebug },
      requestedBy: SigningRequester.Harness,
      target: path.join(out, DEV_APK),
    });
    const keystore = path.join(work, "person", "release.p12");
    await makeUploadKey(javaHome, keystore, password, ctx);
    const bundle = await packageAndroidAab(context, {
      manifest: MANIFEST,
      payload,
      notices: [],
      signing: { kind: ExportSigning.AndroidRelease, keystore, alias: UPLOAD_ALIAS, password: { env: KEY_ENV } },
      requestedBy: SigningRequester.Person,
      target: path.join(out, BUNDLE),
    });
    const universal = await universalApk(
      ctx,
      path.join(javaHome, "bin", "java"),
      jar,
      bundle.file,
      keystore,
      password,
      work,
    );
    await writeFile(path.join(out, UNIVERSAL_APK), universal);
    const files = [
      { name: DEV_APK, sha256: dev.sha256, bytes: dev.bytes },
      { name: BUNDLE, sha256: bundle.sha256, bytes: bundle.bytes },
      { name: UNIVERSAL_APK, sha256: sha256Of(universal), bytes: universal.length },
    ];
    return {
      applicationId: MANIFEST.applicationId,
      library: { bytes: library.length, sha256: sha256Of(library) },
      files,
      sandboxed: false,
      bundletool: BUNDLETOOL_PIN.version,
      summary: `Android packages: ${files.map((file) => `${file.name} ${file.bytes} bytes`).join(", ")}`,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function stepAabValidate(ctx: Context): Promise<Facts> {
  const javaHome = javaHomeOf(ctx);
  const jar = await bundletoolOf(ctx);
  const bundle = await packageFile(await outOf(ctx), BUNDLE);
  const java = path.join(javaHome, "bin", "java");
  const bundletool = async (...args: string[]) => run(java, ["-jar", jar, ...args, `--bundle=${bundle}`], ctx);
  const validated = await bundletool("validate");
  if (validated.code !== 0)
    fail(
      RustMobileCode.BundleInvalid,
      `bundletool validate exited ${validated.code}: ${textOf(validated).trim().slice(0, 400)}`,
    );
  const manifest = checkBundleManifest((await bundletool("dump", "manifest")).stdout.toString("utf8"));
  checkBundleConfig((await bundletool("dump", "config")).stdout.toString("utf8"));
  return {
    bundle: BUNDLE,
    bundletool: BUNDLETOOL_PIN.version,
    minSdk: manifest.minSdk,
    targetSdk: manifest.targetSdk,
    alignment: ALIGNMENT_16K,
    summary: `Play checks: bundletool validate passes, targetSdk ${manifest.targetSdk}, ${ALIGNMENT_16K}`,
  };
}

async function stepZipalign16k(ctx: Context): Promise<Facts> {
  const { buildTools } = await sdkOf(ctx);
  const out = await outOf(ctx);
  const reports: string[] = [];
  for (const name of PLAY_APKS) {
    const file = await packageFile(out, name);
    const result = await run(
      path.join(buildTools, "zipalign"),
      ["-c", "-P", ZIP_PAGE_ALIGN_KB, "-v", ZIP_ALIGN_BYTES, file],
      ctx,
    );
    judgeZipalign(result.code, textOf(result));
    reports.push(`${name}: ${textOf(result).trim().split("\n").at(-1)}`);
  }
  return {
    checked: [...PLAY_APKS],
    reports,
    summary: `Play checks: zipalign -c -P 16 passes over ${PLAY_APKS.join(" and ")}`,
  };
}

// ---- Android emulator -------------------------------------------------------------------------

const adbOf = async (ctx: Context): Promise<string> => (await sdkOf(ctx)).adb;

const adb = async (ctx: Context, args: readonly string[]): Promise<ExecResult> =>
  run(await adbOf(ctx), args, ctx, ADB_TIMEOUT_MS);

async function stepEmulatorPageSize(ctx: Context): Promise<Facts> {
  const image = flagOf(ctx, "--image");
  if (!sixteenKbImage(image))
    fail(RustMobileCode.PageSize, `${JSON.stringify(image.slice(0, 80))} is not a 16 KB page system image`);
  const result = await adb(ctx, ["shell", "getconf", "PAGE_SIZE"]);
  checkPageSize(result.stdout.toString("utf8"));
  return { image, pageBytes: PAGE_BYTES, summary: `Android emulator: ${image}, kernel page ${PAGE_BYTES} bytes` };
}

/**
 * What makes the emulator's screen stay awake and unlocked for the app's start. The emulator sets
 * `screen_off_timeout` itself after the boot, but `adb root` restarting adbd under it loses that
 * command (`adb: device offline`); an activity started behind a sleeping or locked screen gets no
 * window, so it never resumes (pass-1 gate: `am start` timed out, the log held only `launched`).
 */
const WAKE_COMMANDS: readonly (readonly string[])[] = [
  ["shell", "settings", "put", "system", "screen_off_timeout", "2147483647"],
  ["shell", "svc", "power", "stayon", "true"],
  ["shell", "input", "keyevent", "KEYCODE_WAKEUP"],
  ["shell", "wm", "dismiss-keyguard"],
];
/** `dumpsys power`'s line for a screen that is on. */
const AWAKE_LINE = /mWakefulness=Awake/;
/** The whole system log, streamed from before the start to the verdict (the ring buffer wraps). */
const LOGCAT_STREAM_ARGS = ["logcat", "-b", "all", "-v", "threadtime"] as const;
/** How many times an adb read that answered nothing is asked again, and the wait between. */
const EMPTY_READ_RETRIES = 2;
const EMPTY_READ_WAIT_MS = 2 * SECOND_MS;
/** How many times the dev APK's install is tried, and the wait between in smoke polls (10 s in CI). */
const INSTALL_ATTEMPTS = 3;
const INSTALL_RETRY_POLLS = 5;

/** The evidence files a smoke keeps beside `logcat.txt`: the app's lifecycle log and the system log's tail. */
const EMULATOR_LIFECYCLE_EVIDENCE = "lifecycle.txt";
const EMULATOR_LOGCAT_TAIL_EVIDENCE = "logcat-tail.txt";
/** How many of the system log's last lines a smoke keeps. */
const LOGCAT_TAIL_LINES = 4000;

/** The evidence of where the app stands: `am start`'s answer, the activity stack, and the app's own log lines. */
const EMULATOR_APP_EVIDENCE = {
  start: "am-start.txt",
  activities: "activities.txt",
  appLog: "logcat-app.txt",
  stream: "logcat-stream.txt",
  ready: "device-ready.txt",
  memory: "meminfo.txt",
} as const;

/** An adb read, asked again while it answers nothing (adb under a starved emulator may). */
async function adbRead(ctx: Context, args: readonly string[]): Promise<string> {
  let text = "";
  for (let attempt = 0; attempt <= EMPTY_READ_RETRIES; attempt++) {
    if (attempt > 0) await sleep(Math.min(EMPTY_READ_WAIT_MS, ctx.pollMs));
    text = (await adb(ctx, args)).stdout.toString("utf8");
    if (text.trim() !== "") return text;
  }
  return text;
}

/**
 * Keep `am start`'s answer, the activity stack and, while the app runs, every log line of its
 * process. Answers the app's process id, or null when none runs.
 */
async function keepAppState(ctx: Context, appId: string, started: string): Promise<string | null> {
  await writeFile(path.join(ctx.evidence, EMULATOR_APP_EVIDENCE.start), started);
  const activities = await adbRead(ctx, ["shell", "dumpsys", "activity", "activities"]);
  await writeFile(path.join(ctx.evidence, EMULATOR_APP_EVIDENCE.activities), activities);
  const pid = (await adbRead(ctx, ["shell", "pidof", appId])).trim().split(/\s+/)[0] ?? "";
  if (!/^\d+$/.test(pid)) return null;
  const own = await adb(ctx, ["logcat", "-d", "--pid", pid]);
  await writeFile(path.join(ctx.evidence, EMULATOR_APP_EVIDENCE.appLog), own.stdout);
  return pid;
}

/** Wakes and unlocks the screen to stay on, then waits for `dumpsys power` to say it is awake. */
async function readyScreen(ctx: Context): Promise<void> {
  for (const command of WAKE_COMMANDS) await adb(ctx, command);
  const attempts = Math.max(1, Math.ceil(ctx.waitMs / ctx.pollMs));
  let power = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    power = (await adb(ctx, ["shell", "dumpsys", "power"])).stdout.toString("utf8");
    if (AWAKE_LINE.test(power)) break;
    await adb(ctx, ["shell", "input", "keyevent", "KEYCODE_WAKEUP"]);
    await sleep(ctx.pollMs);
  }
  const wakefulness = power.split("\n").find((line) => line.includes("mWakefulness=")) ?? "";
  await writeFile(path.join(ctx.evidence, EMULATOR_APP_EVIDENCE.ready), `${wakefulness.trim()}\n`);
  if (!AWAKE_LINE.test(power))
    fail(
      RustMobileCode.DeviceNotReady,
      `the emulator's screen is not awake (${wakefulness.trim() || "no wakefulness in dumpsys power"}): an app started now gets no window`,
    );
}

/** The whole system log streamed into the evidence until `stop`. */
async function streamLogcat(ctx: Context): Promise<{ stop: () => Promise<void> }> {
  const file = path.join(ctx.evidence, EMULATOR_APP_EVIDENCE.stream);
  const fd = openSync(file, "w");
  const child = spawn(await adbOf(ctx), [...LOGCAT_STREAM_ARGS], { env: ctx.env, stdio: ["ignore", fd, fd] });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  return {
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
      closeSync(fd);
    },
  };
}

/** The event log's relaunch of an activity: `[user, token, task, component, changes in hex]`. */
const RELAUNCH_LINE = /\bwm_relaunch(?:_resume)?_activity: \[\d+,\d+,\d+,([^,\]]+),([0-9a-f]{1,8})\]/;

/** The `android:configChanges` names of a change mask; a bit no name covers stays in hex. */
function configChangeNames(mask: number): string[] {
  const names = ANDROID_CONFIG_CHANGES.filter(([, bit]) => (mask & bit) !== 0).map(([name]) => name);
  const known = ANDROID_CONFIG_CHANGES.reduce((all, [, bit]) => all | bit, 0);
  const rest = mask & ~known;
  return rest === 0 ? names : [...names, `0x${(rest >>> 0).toString(16)}`];
}

/**
 * Each relaunch the system made of `component` (its event-log lines), as the configuration changes
 * it was for. NativeActivity cannot survive one, so a relaunch explains an app that never resumed.
 */
export function activityRelaunches(log: string, component: string): string[][] {
  return log.split("\n").flatMap((line) => {
    const match = RELAUNCH_LINE.exec(line);
    if (match?.[1] !== component || match[2] === undefined) return [];
    return [configChangeNames(Number.parseInt(match[2], 16))];
  });
}

/** The low-memory killer's lines that ended the app's process. */
export function lowMemoryKills(log: string, appId: string): string[] {
  return log.split("\n").filter((line) => line.includes("lowmemorykiller") && line.includes(`'${appId}'`));
}

/** A smoke's no-outcome failure, with what the evidence shows: the start's answer, a kill, a gone process. */
function noOutcomeDetail(
  verdict: ShellSmokeVerdict,
  facts: { started: string; kills: string[]; relaunches: string[][]; pid: string | null },
): string {
  const status = facts.started
    .split("\n")
    .find((line) => line.startsWith("Status:"))
    ?.trim();
  const parts = [`${verdict.outcome}: ${verdict.detail}`];
  if (status) parts.push(`am start: ${status}`);
  if (facts.kills.length > 0)
    parts.push(`the low-memory killer ended the app: ${facts.kills[0]?.trim().slice(0, 200)}`);
  const [relaunch] = facts.relaunches;
  if (relaunch)
    parts.push(`the system relaunched the activity for ${relaunch.join("|")} (${facts.relaunches.length} times)`);
  if (facts.pid === null) parts.push("no app process at the end");
  return parts.join("; ");
}

/**
 * Waits for the package service to answer (`pm path android` exits 0). Right after a boot and
 * `adb root`, the system server can still be starting it: CI's installs failed with "Failure
 * calling service package: Broken pipe".
 */
async function packageServiceReady(ctx: Context): Promise<void> {
  const attempts = Math.max(1, Math.ceil(ctx.waitMs / ctx.pollMs));
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(ctx.pollMs);
    if ((await adb(ctx, ["shell", "pm", "path", "android"])).code === 0) return;
  }
  fail(RustMobileCode.DeviceNotReady, "the emulator's package service did not answer: nothing can be installed");
}

/** `adb install -r`, tried {@link INSTALL_ATTEMPTS} times (a busy system server drops the pipe); a failure keeps each answer. */
async function installApk(ctx: Context, apk: string): Promise<void> {
  const answers: string[] = [];
  for (let attempt = 0; attempt < INSTALL_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(ctx.pollMs * INSTALL_RETRY_POLLS);
    const installed = await adb(ctx, ["install", "-r", apk]);
    if (installed.code === 0) return;
    answers.push(`exit ${installed.code}: ${textOf(installed).trim().slice(0, 200)}`);
  }
  fail(RustMobileCode.SmokeFailed, `adb install failed ${INSTALL_ATTEMPTS} times: ${answers.join(" | ")}`);
}

const lifecyclePath = (appId: string) => `/data/data/${appId}/files/${RECORDS_FOLDER}/${LIFECYCLE_FILE}`;

/** The app's lifecycle log: read as root (a `google_apis` image allows `adb root`), else through `run-as` (a debuggable app). */
async function emulatorLog(ctx: Context, appId: string): Promise<string> {
  const asRoot = await adb(ctx, ["shell", "cat", lifecyclePath(appId)]);
  const text = asRoot.code === 0 ? asRoot.stdout.toString("utf8") : "";
  if (text.trim() !== "") return text;
  const viaRunAs = await adb(ctx, ["shell", "run-as", appId, "cat", `files/${RECORDS_FOLDER}/${LIFECYCLE_FILE}`]);
  return viaRunAs.code === 0 ? viaRunAs.stdout.toString("utf8") : "";
}

async function stepEmulatorSmoke(ctx: Context): Promise<Facts> {
  const appId = await applicationIdOf(ctx);
  const apk = await packageFile(await outOf(ctx), DEV_APK);
  await adb(ctx, ["wait-for-device"]);
  await adb(ctx, ["root"]);
  await adb(ctx, ["wait-for-device"]);
  await packageServiceReady(ctx);
  await installApk(ctx, apk);
  await mkdir(ctx.evidence, { recursive: true });
  await readyScreen(ctx);
  await writeFile(
    path.join(ctx.evidence, EMULATOR_APP_EVIDENCE.memory),
    (await adb(ctx, ["shell", "cat", "/proc/meminfo"])).stdout,
  );
  const component = `${appId}/${ANDROID_ACTIVITIES[PACKAGED_ACTIVITY].className}`;
  const stream = await streamLogcat(ctx);
  let started: ExecResult;
  let smoke: SmokeRead;
  try {
    started = await adb(ctx, ["shell", "am", "start", "-W", "-n", component]);
    smoke = await pollVerdict(ctx, () => emulatorLog(ctx, appId), NativeBackend.Vulkan);
  } finally {
    await stream.stop();
  }
  const crashes = crashLines((await adb(ctx, ["logcat", "-d", "-b", "crash"])).stdout.toString("utf8"), appId);
  const logcat = await adb(ctx, ["logcat", "-d", "-s", "genex:V", "AndroidRuntime:E", "DEBUG:V"]);
  await writeFile(path.join(ctx.evidence, "logcat.txt"), logcat.stdout);
  // Pass-1 gate: a run that wrote no outcome left nothing to read; keep what the app and the
  // system logged, so the next failure says where the app stopped.
  await writeFile(path.join(ctx.evidence, EMULATOR_LIFECYCLE_EVIDENCE), await emulatorLog(ctx, appId));
  const everything = await adb(ctx, ["logcat", "-d", "-t", String(LOGCAT_TAIL_LINES)]);
  await writeFile(path.join(ctx.evidence, EMULATOR_LOGCAT_TAIL_EVIDENCE), everything.stdout);
  const pid = await keepAppState(ctx, appId, textOf(started));
  const { verdict } = smoke;
  if (verdict.outcome === ShellSmoke.NoOutcome) {
    const streamed = await readFile(path.join(ctx.evidence, EMULATOR_APP_EVIDENCE.stream), "utf8").catch(() => "");
    const kills = lowMemoryKills(streamed, appId);
    const relaunches = activityRelaunches(streamed, component);
    fail(RustMobileCode.SmokeFailed, noOutcomeDetail(verdict, { started: textOf(started), kills, relaunches, pid }));
  }
  judgeSmoke(verdict);
  if (crashes.length > 0)
    fail(RustMobileCode.SmokeFailed, `the app crashed: ${crashes.slice(0, 3).join(" | ").slice(0, 400)}`);
  const firstFrame = judgeFirstFrame(ctx, smoke);
  return {
    appId,
    outcome: verdict.outcome,
    detail: verdict.detail,
    firstFrame,
    summary: `Android emulator smoke: ${verdict.outcome}: ${verdict.detail}`,
  };
}

/** What closes the system's dialogs (an emulator's "System UI isn't responding" among them). */
const CLOSE_SYSTEM_DIALOGS = ["shell", "am", "broadcast", "-a", "android.intent.action.CLOSE_SYSTEM_DIALOGS"] as const;
/** The activity stack read for the window in focus (its format is the one CI's image prints). */
const FOCUS_READ = ["shell", "dumpsys", "activity", "activities"] as const;
/** The activity stack read with the screenshot that was judged. */
const CAPTURE_FOCUS_EVIDENCE = "capture-focus.txt";

/** A screenshot and the activity stack read right after it. */
interface FocusedShot {
  png: Buffer;
  dump: string;
  /** The windows in focus closed as system dialogs before it. */
  closed: string[];
}

/** The game's own not-responding dialog: evidence, never closed. */
const ownNotResponding = (dump: string, appId: string): boolean =>
  windowInFocus(dump) === `${NOT_RESPONDING_PREFIX}${appId}`;

/**
 * A screenshot taken with the game's window in focus before and after it: a system dialog in focus
 * is closed, no window in focus is waited out, and the shot waits for the game, within the smoke's
 * wait. Answers the last shot taken
 * (taken anyway at the end, so the screen is kept as evidence) and the stack read after it.
 */
async function screenshotInFocus(ctx: Context, appId: string, component: string): Promise<FocusedShot> {
  const attempts = Math.max(1, Math.ceil(ctx.waitMs / ctx.pollMs));
  const closed: string[] = [];
  let dump = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    dump = await adbRead(ctx, FOCUS_READ);
    if (ownNotResponding(dump, appId)) break;
    const focus = windowInFocus(dump);
    if (focus !== component) {
      // No window in focus (between windows) is waited out: there is no dialog to close.
      if (focus !== null) {
        closed.push(focus);
        await adb(ctx, CLOSE_SYSTEM_DIALOGS);
      }
      await sleep(ctx.pollMs);
      continue;
    }
    const png = (await adb(ctx, ["exec-out", "screencap", "-p"])).stdout;
    dump = await adbRead(ctx, FOCUS_READ);
    if (windowInFocus(dump) === component) return { png, dump, closed };
  }
  return { png: (await adb(ctx, ["exec-out", "screencap", "-p"])).stdout, dump, closed };
}

async function stepEmulatorCapture(ctx: Context): Promise<Facts> {
  const smoke = await passedRecord(ctx, StepId.EmulatorSmoke);
  const appId = await applicationIdOf(ctx);
  const component = `${appId}/${ANDROID_ACTIVITIES[PACKAGED_ACTIVITY].className}`;
  const shot = await screenshotInFocus(ctx, appId, component);
  await mkdir(ctx.evidence, { recursive: true });
  await writeFile(path.join(ctx.evidence, ANDROID_CAPTURE_FILE), shot.png);
  await writeFile(path.join(ctx.evidence, CAPTURE_FOCUS_EVIDENCE), shot.dump);
  const focus = checkCaptureFocus(shot.dump, component);
  const facts = checkScreenshot(shot.png, minColoursAfter(smoke.outcome));
  return {
    file: ANDROID_CAPTURE_FILE,
    afterOutcome: smoke.outcome,
    focus,
    closedDialogs: shot.closed,
    ...facts,
    summary: `Android emulator capture: ${facts.colours} colours, ${focus} in focus`,
  };
}

// ---- steps ----------------------------------------------------------------------------------

const EXECUTORS: Record<StepId, (ctx: Context) => Promise<Facts>> = {
  [StepId.IosSimBoot]: stepIosSimBoot,
  [StepId.IosSimInstall]: stepIosSimInstall,
  [StepId.IosSimCapture]: stepIosSimCapture,
  [StepId.IosSimDelete]: stepIosSimDelete,
  [StepId.AndroidPackage]: stepAndroidPackage,
  [StepId.AabValidate]: stepAabValidate,
  [StepId.Zipalign16k]: stepZipalign16k,
  [StepId.EmulatorPageSize]: stepEmulatorPageSize,
  [StepId.EmulatorSmoke]: stepEmulatorSmoke,
  [StepId.EmulatorCapture]: stepEmulatorCapture,
};

function addToSummary(ctx: Context, line: unknown): void {
  const file = ctx.env.GITHUB_STEP_SUMMARY;
  if (typeof line === "string" && file) appendFileSync(file, `- ${line}\n`);
}

/** Runs one step: its record is written whatever happens; a failure is rethrown typed after it. */
export async function runStep(ctx: Context, spec: StepSpec): Promise<void> {
  const started = Date.now();
  const timer = setTimeout(() => {
    process.stderr.write(
      `${REFUSAL_PREFIX}${JSON.stringify({ code: RustMobileCode.StepFailed, detail: `${spec.id} exceeded ${STEP_TIMEOUT_MS} ms` })}\n`,
    );
    process.exit(FAIL_EXIT);
  }, STEP_TIMEOUT_MS);
  timer.unref();
  try {
    const { summary, ...facts } = await EXECUTORS[spec.id](ctx);
    await writeRecord(ctx, spec.id, { status: StepStatus.Pass, title: spec.title, ms: Date.now() - started, ...facts });
    addToSummary(ctx, summary);
  } catch (error) {
    const typed =
      error instanceof RustMobileError ? error : new RustMobileError(RustMobileCode.StepFailed, String(error));
    await writeRecord(ctx, spec.id, {
      status: StepStatus.Fail,
      title: spec.title,
      ms: Date.now() - started,
      code: typed.code,
      detail: typed.detail,
    });
    addToSummary(ctx, `${spec.id} failed: ${typed.code}: ${typed.detail}`);
    throw typed;
  } finally {
    clearTimeout(timer);
  }
}

// ---- command line ---------------------------------------------------------------------------

type Mode = "table" | "check-workflow" | "step";

interface Options {
  mode: Mode;
  value: string | null;
  flags: Flags;
  evidence: string | null;
}

const ONE_OF = "one of --table, --check-workflow, --step";

const MODE_FLAGS = { "--step": "step", "--check-workflow": "check-workflow" } as const satisfies Record<string, Mode>;

function parseArgs(args: string[]): Options {
  const options: Options = { mode: "table", value: null, flags: {}, evidence: null };
  let chosen = false;
  const choose = (mode: Mode, value: string | null) => {
    if (chosen) fail(RustMobileCode.Usage, ONE_OF);
    chosen = true;
    options.mode = mode;
    options.value = value;
  };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i] ?? "";
    if (flag === "--table") {
      choose("table", null);
      continue;
    }
    if (!isKnownFlag(flag)) fail(RustMobileCode.Usage, `unknown argument ${flag}`);
    const value = args[i + 1] ?? fail(RustMobileCode.Usage, `${flag} needs a value`);
    i += 1;
    const mode = Object.entries(MODE_FLAGS).find(([name]) => name === flag)?.[1];
    if (mode) choose(mode, value);
    else if (flag === "--evidence") options.evidence = value;
    else options.flags[flagNamed(flag)] = value;
  }
  if (!chosen) fail(RustMobileCode.Usage, ONE_OF);
  return options;
}

function isKnownFlag(flag: string): boolean {
  return flag === "--evidence" || flag in MODE_FLAGS || FLAG_NAMES.some((name) => name === flag);
}

function flagNamed(flag: string): FlagName {
  return FLAG_NAMES.find((candidate) => candidate === flag) ?? fail(RustMobileCode.Usage, `unknown argument ${flag}`);
}

async function main(args: string[]): Promise<number> {
  const options = parseArgs(args);
  if (options.mode === "table") {
    process.stdout.write(`${JSON.stringify({ steps: STEP_TABLE, workflows: WORKFLOW_ROWS }, null, 2)}\n`);
    return 0;
  }
  if (options.mode === "check-workflow") {
    const file = String(options.value);
    checkWorkflow(path.basename(file), await readFile(file, "utf8"));
    return 0;
  }
  const spec =
    STEP_TABLE.find((step) => step.id === options.value) ?? fail(RustMobileCode.UnknownStep, String(options.value));
  const ctx = makeContext({ evidence: path.resolve(options.evidence ?? DEFAULT_EVIDENCE), flags: options.flags });
  await runStep(ctx, spec);
  process.stderr.write(`rust-mobile: ${spec.id}: ${StepStatus.Pass}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      const typed =
        error instanceof RustMobileError ? error : new RustMobileError(RustMobileCode.StepFailed, String(error));
      process.stderr.write(`${REFUSAL_PREFIX}${JSON.stringify({ code: typed.code, detail: typed.detail })}\n`);
      process.exit(FAIL_EXIT);
    },
  );
}
