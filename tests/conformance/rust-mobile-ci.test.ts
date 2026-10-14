/**
 * The Rust · wgpu runtime's phone CI rows (M5.6): `scripts/ci/rust-mobile.ts` owns every check the
 * `rust-mobile.yml` jobs run, so the rows here drive it on any host with no Simulator, emulator,
 * Xcode or Android SDK:
 *
 * - the step table (Simulator boot, install and capture; the Play checks `zipalign -c -P 16` and
 *   `bundletool validate` at targetSdk 36; the 16 KB emulator's page size, smoke and capture) and
 *   `rust-mobile.yml` are held to each other: each job calls its steps once, in order, none under an
 *   `if:` that can skip it, the iOS job runs only on an owner dispatch, and the workflow's bundletool
 *   and emulator-image pins are the script's;
 * - the verdicts: a zipalign that reports a misaligned library, a bundle whose manifest is not
 *   targetSdk 36 / minSdk 29 / permission-free or whose config lacks 16 KB alignment, an emulator
 *   whose kernel page is 4 KB, a lifecycle log with a failure (or none), a crash in the app's own
 *   logcat, and a capture that is blank each have their typed code;
 * - the PNG reader behind the captures (every filter, 8 and 16 bits, hostile headers) and the
 *   non-blank rule: a rendered scene needs many colours, the refusal screen two;
 * - the steps themselves, against stub `xcrun`, `adb`, `zipalign` and `java` executables: the exact
 *   calls they make, in order, that a hostile argument makes none, and that the Simulator the boot
 *   step made is the one the delete step removes.
 *
 * The real row packages the pond's library with the lane (aapt2, zipalign, apksigner, bundletool,
 * JDK from the developer's SDK and dev store) and runs the Play checks over what it made; it skips
 * without those tools and `GENEX_REQUIRE_TOOLCHAINS=1` turns the skip into a failure. Nothing here
 * boots a Simulator or an emulator (containment stage 1).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import {
  ANDROID_16K_IMAGE,
  activityRelaunches,
  BUNDLETOOL_PIN,
  checkAppId,
  checkCaptureFocus,
  checkBundleConfig,
  checkBundleManifest,
  checkPageSize,
  checkScreenshot,
  checkWorkflow,
  crashLines,
  decodePng,
  judgeZipalign,
  MIN_COLOURS,
  makeContext,
  pickDeviceType,
  pickRuntime,
  RustMobileCode,
  RustMobileError,
  runStep,
  sixteenKbImage,
  STEP_TABLE,
  StepId,
  type StepSpec,
  WORKFLOW_ROWS,
  windowInFocus,
} from "../../scripts/ci/rust-mobile.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { ANDROID_PINS } from "../../src/shared/toolchain.ts";
import { DEV_RUST_TOOLCHAIN } from "../helpers/dev-toolchains.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = path.join(REPO, "scripts", "ci", "rust-mobile.ts");
const WORKFLOW = path.join(REPO, ".github", "workflows", "rust-mobile.yml");
const REFUSAL_PREFIX = "genex-rust-mobile: ";
const NO_ERROR = "no error";
const UDID = "0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0";
const IOS_APP_ID = "games.genex.spike.pond";
const ANDROID_APP_ID = "games.genex.game.g0123456789ab";
/** The smoke's streamed system log, started before the app and ended at the verdict. */
const STREAM_CALL = "logcat -b all -v threadtime";
/** The event-log lines a CI run streamed: the launcher's relaunch, then the app's (assetsPaths). */
const RELAUNCH_LOG = [
  "10-12 02:11:27.068  1370  1370 I wm_on_stop_called: [56997930,com.google.android.apps.nexuslauncher.NexusLauncherActivity,handleRelaunchActivity,0]",
  "10-12 02:11:25.811   715   740 I wm_relaunch_resume_activity: [0,229737095,7,games.genex.game.g0123456789ab/android.app.NativeActivity,80000000]",
  "10-12 02:11:31.000   715   740 I wm_relaunch_resume_activity: [0,56997930,5,com.google.android.apps.nexuslauncher/.NexusLauncherActivity,80000080]",
  "10-12 02:11:36.294   715   740 I wm_relaunch_resume_activity: [0,229737095,7,games.genex.game.g0123456789ab/android.app.NativeActivity,80000000]",
  "",
].join("\n");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** The game's activity component on the emulator. */
const ANDROID_COMPONENT = `${ANDROID_APP_ID}/android.app.NativeActivity`;
/** A CI run's capture and activity stack: System UI's not-responding dialog over a black screen. */
const ANR_FIXTURE = path.join(REPO, "tests", "fixtures", "rust-mobile-anr");
/** An activity stack whose window in focus is `title`. */
const focusDump = (title: string): string =>
  `ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)\n  mCurrentFocus=Window{f17cc0b u0 ${title}}\n  mFocusedApp=ActivityRecord{88951430 u0 ${ANDROID_COMPONENT} t7}\n`;
/** The first frame the phone shell presented, as it logs it. */
const FRAME_PRESENTED = JSON.stringify({ event: "frame-presented", rendered: 1, window: [640, 320] });

const workflowText = () => readFile(WORKFLOW, "utf8");

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof RustMobileError, `a typed error, got ${String(error)}`);
    return error.code;
  }
  return NO_ERROR;
}

/** The typed error's detail, or the no-error marker. */
async function detailOfAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof RustMobileError, `a typed error, got ${String(error)}`);
    return error.detail;
  }
  return NO_ERROR;
}

async function codeOfAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof RustMobileError, `a typed error, got ${String(error)}`);
    return error.code;
  }
  return NO_ERROR;
}

// ---- PNG fixtures -----------------------------------------------------------------------------

const crcOf = (bytes: Buffer): number => zlib.crc32(bytes);

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crcOf(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
};

/** One scanline filtered with `type` (0 none, 1 sub, 2 up, 3 average, 4 paeth) over its previous raw row. */
function filterRow(type: number, row: Buffer, prior: Buffer, bpp: number): Buffer {
  const out = Buffer.alloc(row.length + 1);
  out[0] = type;
  for (let i = 0; i < row.length; i++) {
    const left = i >= bpp ? (row[i - bpp] ?? 0) : 0;
    const up = prior[i] ?? 0;
    const upLeft = i >= bpp ? (prior[i - bpp] ?? 0) : 0;
    const predict = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][type] ?? 0;
    out[i + 1] = ((row[i] ?? 0) - predict) & 0xff;
  }
  return out;
}

interface PngSpec {
  width: number;
  height: number;
  colorType: number;
  depth: number;
  interlace?: number;
  /** A sample (0-255 for 8 bits, the high byte for 16) per pixel and channel. */
  sample: (x: number, y: number, channel: number) => number;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

function png(spec: PngSpec): Buffer {
  const channels = CHANNELS[spec.colorType] ?? 1;
  const bytes = (spec.depth / 8) * channels;
  const rows: Buffer[] = [];
  let prior = Buffer.alloc(spec.width * bytes);
  for (let y = 0; y < spec.height; y++) {
    const row = Buffer.alloc(spec.width * bytes);
    for (let x = 0; x < spec.width; x++)
      for (let c = 0; c < channels; c++) {
        const value = spec.sample(x, y, c);
        if (spec.depth === 16) row.writeUInt16BE(value * 257, (x * channels + c) * 2);
        else row[x * channels + c] = value;
      }
    rows.push(filterRow(y % 5, row, prior, bytes));
    prior = row;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(spec.width, 0);
  header.writeUInt32BE(spec.height, 4);
  header[8] = spec.depth;
  header[9] = spec.colorType;
  header[12] = spec.interlace ?? 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const SIDE = 40;
/** A scene: a gradient of many colours. */
const scene = (): Buffer =>
  png({
    width: SIDE,
    height: SIDE,
    colorType: 6,
    depth: 8,
    sample: (x, y, c) => (c === 3 ? 255 : (x * 6 + y * (c + 1) * 3) % 256),
  });
/** A frame of one flat colour. */
const flat = (): Buffer =>
  png({ width: SIDE, height: SIDE, colorType: 2, depth: 8, sample: (_x, _y, c) => [12, 34, 56][c] ?? 0 });
/** The refusal screen: a background and a block of text-coloured pixels in the middle. */
const refusal = (): Buffer =>
  png({
    width: SIDE,
    height: SIDE,
    colorType: 2,
    depth: 8,
    sample: (x, y, c) => (x > 12 && x < 28 && y > 16 && y < 22 ? 240 : ([10, 20, 30][c] ?? 0)),
  });
/** The colours the phone shell's refusal screen is drawn in, as its `refusal-screen` event logs them (mobile/refusal.rs). */
const SCREEN_PALETTE = { background: [16, 18, 24], ink: [236, 238, 242], codeInk: [150, 156, 168] } as const;
type Rgb = readonly [number, number, number];
/** A refusal screen as a Simulator captures it: a status bar, the background, the message in ink and the code line quieter. */
const refusalScreen = (palette: { background: Rgb; ink: Rgb; codeInk: Rgb } = SCREEN_PALETTE): Buffer =>
  png({
    width: SIDE,
    height: SIDE,
    colorType: 2,
    depth: 8,
    sample: (x, y, c) => {
      if (y < 3) return (x * 7 + c * 50) % 256;
      if (y > 14 && y < 19 && x > 6 && x < 34 && (x + y) % 3 !== 0) return palette.ink[c] ?? 0;
      if (y > 21 && y < 25 && x > 12 && x < 28 && x % 2 === 0) return palette.codeInk[c] ?? 0;
      return palette.background[c] ?? 0;
    },
  });
/** A black game frame under a status bar: only the top rows differ. */
const blackUnderStatusBar = (): Buffer =>
  png({ width: SIDE, height: SIDE, colorType: 2, depth: 8, sample: (x, y, c) => (y < 3 ? (x * 7 + c * 50) % 256 : 0) });

describe("the PNG reader and the non-blank rule", () => {
  it("reads every filter at 8 and 16 bits and every colour type a screenshot tool writes", () => {
    for (const colorType of [0, 2, 4, 6])
      for (const depth of [8, 16]) {
        const raster = decodePng(
          png({ width: 7, height: 11, colorType, depth, sample: (x, y, c) => (x * 31 + y * 17 + c * 5) % 256 }),
        );
        assert.equal(raster.width, 7);
        assert.equal(raster.height, 11);
        assert.equal(raster.channels, CHANNELS[colorType]);
        for (const [x, y, c] of [
          [0, 0, 0],
          [6, 10, 0],
          [3, 5, (CHANNELS[colorType] ?? 1) - 1],
        ] as const)
          assert.equal(
            raster.samples[(y * 7 + x) * raster.channels + c],
            (x * 31 + y * 17 + c * 5) % 256,
            `type ${colorType} depth ${depth} at ${x},${y},${c}`,
          );
      }
  });

  /** The PNG with IHDR bytes overwritten and its CRC redone: a header a hostile tool might write. */
  const withHeader = (bytes: Buffer, patch: Record<number, number>): Buffer => {
    const out = Buffer.from(bytes);
    for (const [at, value] of Object.entries(patch)) out[16 + Number(at)] = value;
    out.writeUInt32BE(crcOf(out.subarray(12, 29)), 29);
    return out;
  };

  it("refuses what is not a readable PNG, typed", () => {
    const good = scene();
    const badCrc = Buffer.from(good);
    badCrc[good.indexOf("IDAT") + 6] ^= 0xff;
    const rows: Array<[string, Buffer | Uint8Array]> = [
      ["empty", Buffer.alloc(0)],
      ["not a PNG", Buffer.from("GIF89a-not-a-png-at-all-really")],
      ["truncated", good.subarray(0, 50)],
      ["bad CRC", badCrc],
      ["interlaced", withHeader(good, { 12: 1 })],
      ["palette", withHeader(good, { 9: 3 })],
      ["one-bit", withHeader(good, { 8: 1 })],
      ["a width beyond the screenshot cap", withHeader(good, { 0: 0x00, 1: 0x01, 2: 0x00, 3: 0x00 })],
      ["a height of zero", withHeader(good, { 4: 0, 5: 0, 6: 0, 7: 0 })],
      ["a header that does not match the pixel data", withHeader(good, { 3: SIDE + 1 })],
      ["no IDAT", Buffer.concat([PNG_SIGNATURE, good.subarray(8, 33), chunk("IEND", Buffer.alloc(0))])],
    ];
    for (const [name, bytes] of rows)
      assert.equal(
        codeOf(() => decodePng(bytes)),
        RustMobileCode.BadPng,
        name,
      );
  });

  it("accepts a scene, a refusal screen and refuses a blank or black frame, by what the capture must show", () => {
    assert.ok(checkScreenshot(scene(), MIN_COLOURS.Rendered).colours >= MIN_COLOURS.Rendered);
    assert.equal(checkScreenshot(refusal(), MIN_COLOURS.Refusal).width, SIDE);
    assert.equal(
      codeOf(() => checkScreenshot(refusal(), MIN_COLOURS.Rendered)),
      RustMobileCode.BlankCapture,
    );
    for (const [name, bytes] of [
      ["one flat colour", flat()],
      ["black under a status bar", blackUnderStatusBar()],
    ] as const) {
      assert.equal(
        codeOf(() => checkScreenshot(bytes, MIN_COLOURS.Refusal)),
        RustMobileCode.BlankCapture,
        name,
      );
      assert.equal(
        codeOf(() => checkScreenshot(bytes, MIN_COLOURS.Rendered)),
        RustMobileCode.BlankCapture,
        name,
      );
    }
  });
});

// Seen in a CI run: the emulator capture passed on System UI's "isn't responding"
// dialog over a black screen. The colour rule reads only the capture's centre, which the dialog
// covered, so the capture is also judged by the window in focus when it was taken.
describe("the window in focus when the emulator capture is taken", () => {
  it("CI's capture of a System UI dialog passes the colour rule; the window in focus refuses it", async () => {
    const png = await readFile(path.join(ANR_FIXTURE, "android-emulator.png"));
    const activities = await readFile(path.join(ANR_FIXTURE, "activities.txt"), "utf8");
    assert.ok(
      checkScreenshot(png, MIN_COLOURS.Rendered).colours >= MIN_COLOURS.Rendered,
      "the colour rule alone passes",
    );
    assert.equal(windowInFocus(activities), "Application Not Responding: com.android.systemui");
    assert.equal(
      codeOf(() => checkCaptureFocus(activities, ANDROID_COMPONENT)),
      RustMobileCode.CaptureNotGame,
    );
    assert.equal(checkCaptureFocus(focusDump(ANDROID_COMPONENT), ANDROID_COMPONENT), ANDROID_COMPONENT);
  });

  it("only the game's own activity window counts as the game in focus", () => {
    const refused: Array<[string, string]> = [
      ["no focus line", "ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)\n"],
      ["no window in focus", "  mCurrentFocus=null\n"],
      ["the launcher", focusDump("com.google.android.apps.nexuslauncher/.NexusLauncherActivity")],
      ["the game's own not-responding dialog", focusDump(`Application Not Responding: ${ANDROID_APP_ID}`)],
      ["another activity of a longer package", focusDump(`${ANDROID_APP_ID}x/android.app.NativeActivity`)],
      ["a longer class name", focusDump(`${ANDROID_COMPONENT}2`)],
      ["the notification shade", focusDump("NotificationShade")],
    ];
    for (const [label, dump] of refused)
      assert.equal(
        codeOf(() => checkCaptureFocus(dump, ANDROID_COMPONENT)),
        RustMobileCode.CaptureNotGame,
        label,
      );
    const ownAnr = focusDump(`Application Not Responding: ${ANDROID_APP_ID}`);
    assert.match(
      (() => {
        try {
          checkCaptureFocus(ownAnr, ANDROID_COMPONENT);
        } catch (error) {
          return error instanceof RustMobileError ? error.detail : "";
        }
        return NO_ERROR;
      })(),
      /the app itself is not responding/,
    );
    // The first display's focus is the one the screenshot shows.
    const two = `${focusDump(ANDROID_COMPONENT)}  mCurrentFocus=Window{1 u0 Application Not Responding: com.android.systemui}\n`;
    assert.equal(windowInFocus(two), ANDROID_COMPONENT);
  });
});

// ---- the verdicts -------------------------------------------------------------------------------

describe("the Play and emulator verdicts", () => {
  it("names the configuration changes the system relaunched the app's activity for, and only its own", () => {
    const component = `${ANDROID_APP_ID}/android.app.NativeActivity`;
    assert.deepEqual(activityRelaunches(RELAUNCH_LOG, component), [["assetsPaths"], ["assetsPaths"]]);
    const mixed = "I wm_relaunch_activity: [0,1,7,games.genex.game.g0123456789ab/android.app.NativeActivity,4]\n";
    assert.deepEqual(activityRelaunches(mixed, component), [["locale"]]);
    const unknown =
      "I wm_relaunch_resume_activity: [0,1,7,games.genex.game.g0123456789ab/android.app.NativeActivity,8000080]\n";
    assert.deepEqual(activityRelaunches(unknown, component), [["orientation", "0x8000000"]]);
    const hostile = [
      "I wm_relaunch_resume_activity: [0,1,7,games.genex.game.g0123456789ab/android.app.NativeActivityX,80000000]",
      "I wm_relaunch_resume_activity: [0,1,7,games.genex.game.g0123456789ab/android.app.NativeActivity,zz]",
      "I wm_on_stop_called: [1,games.genex.game.g0123456789ab/android.app.NativeActivity,80000000]",
      "",
    ].join("\n");
    assert.deepEqual(activityRelaunches(hostile, component), []);
  });

  it("zipalign -c -P 16: the exit code and the report must both say aligned", () => {
    const ok = "Verifying alignment of pond.apk (4)...\n  lib/arm64-v8a/libmain.so (OK)\nVerification successful\n";
    assert.equal(
      codeOf(() => judgeZipalign(0, ok)),
      NO_ERROR,
    );
    const rows: Array<[string, number, string]> = [
      ["a non-zero exit", 1, ok],
      ["a BAD entry", 0, ok.replace("(OK)", "(BAD - 4096)")],
      ["a FAILED report", 0, "Verification FAILED\n"],
      ["no report at all", 0, ""],
    ];
    for (const [name, code, output] of rows)
      assert.equal(
        codeOf(() => judgeZipalign(code, output)),
        RustMobileCode.NotAligned,
        name,
      );
  });

  const manifest = (over: Record<string, string> = {}) =>
    [
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="games.genex.game.g0123456789ab">',
      `  <uses-sdk android:minSdkVersion="${over.min ?? "29"}" android:targetSdkVersion="${over.target ?? String(ANDROID_PINS.targetSdk)}" />`,
      over.extra ?? "",
      "</manifest>",
    ].join("\n");

  it("bundletool dump manifest: targetSdk 36, minSdk 29, no permission", () => {
    assert.equal(
      codeOf(() => checkBundleManifest(manifest())),
      NO_ERROR,
    );
    const rows: Array<[string, string]> = [
      ["target 35", manifest({ target: "35" })],
      ["target 360", manifest({ target: "360" })],
      ["min 28", manifest({ min: "28" })],
      ["a permission", manifest({ extra: '<uses-permission android:name="android.permission.INTERNET" />' })],
      ["no uses-sdk", "<manifest />"],
    ];
    for (const [name, xml] of rows)
      assert.equal(
        codeOf(() => checkBundleManifest(xml)),
        RustMobileCode.ManifestRefused,
        name,
      );
  });

  it("bundletool dump config: 16 KB alignment for native libraries", () => {
    const config = '{"optimizations":{"uncompressNativeLibraries":{"enabled":true,"alignment":"PAGE_ALIGNMENT_16K"}}}';
    assert.equal(
      codeOf(() => checkBundleConfig(config)),
      NO_ERROR,
    );
    for (const bad of [config.replace("16K", "4K"), "{}", ""])
      assert.equal(
        codeOf(() => checkBundleConfig(bad)),
        RustMobileCode.ConfigRefused,
        bad,
      );
  });

  it("the emulator image is a 16 KB page one and the kernel's page size says so", () => {
    assert.equal(sixteenKbImage(ANDROID_16K_IMAGE), true);
    assert.match(ANDROID_16K_IMAGE, /^system-images;android-36;google_apis_ps16k;x86_64$/);
    for (const bad of [
      "system-images;android-36;google_apis;x86_64",
      "system-images;android-34;google_apis;x86_64",
      "system-images;android-36;google_apis_ps16k",
      "system-images;android-36;google_apis_ps16k;x86_64; rm -rf /",
      "",
    ])
      assert.equal(sixteenKbImage(bad), false, bad);
    assert.equal(
      codeOf(() => checkPageSize("16384\n")),
      NO_ERROR,
    );
    for (const bad of ["4096\n", "", "sixteen", "16384 4096", "163840"])
      assert.equal(
        codeOf(() => checkPageSize(bad)),
        RustMobileCode.PageSize,
        JSON.stringify(bad),
      );
  });

  it("only the app's own crash lines count", () => {
    const text = [
      `E AndroidRuntime: FATAL EXCEPTION: main`,
      `E AndroidRuntime: Process: ${ANDROID_APP_ID}, PID: 4242`,
      "F libc    : Fatal signal 11 (SIGSEGV) in tid 77 (other.app)",
      `F DEBUG   : pid: 4242, tid: 4242, name: ${ANDROID_APP_ID}  >>> ${ANDROID_APP_ID} <<<`,
    ].join("\n");
    assert.equal(crashLines(text, ANDROID_APP_ID).length, 2);
    assert.deepEqual(crashLines("F libc : Fatal signal 11 (other.app)", ANDROID_APP_ID), []);
    assert.deepEqual(crashLines("", ANDROID_APP_ID), []);
  });

  it("picks the newest available iPhone Simulator runtime", () => {
    const runtimes = JSON.stringify({
      runtimes: [
        { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-5", platform: "iOS", isAvailable: true },
        { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5", platform: "iOS", isAvailable: true },
        { identifier: "com.apple.CoreSimulator.SimRuntime.tvOS-26-5", platform: "tvOS", isAvailable: true },
        { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-27-0", platform: "iOS", isAvailable: false },
      ],
    });
    assert.equal(pickRuntime(runtimes), "com.apple.CoreSimulator.SimRuntime.iOS-26-5");
    for (const bad of [
      "",
      "not json",
      "[]",
      "{}",
      '{"runtimes":[{"platform":"iOS","isAvailable":false,"identifier":"x"}]}',
    ])
      assert.equal(pickRuntime(bad), null, bad);
  });

  it("picks the newest plain iPhone the chosen runtime supports, in whatever order simctl lists them", () => {
    const type = (name: string) => ({
      name,
      identifier: `com.apple.CoreSimulator.SimDeviceType.${name.replace(/ /g, "-")}`,
      productFamily: name.startsWith("iPad") ? "iPad" : "iPhone",
    });
    const RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-26-5";
    // Xcode 26 lists device types newest first; iPhone 7 is listed but iOS 26.5 cannot run it.
    const xcode26 = ["iPhone 17 Pro", "iPhone 17e", "iPhone Air", "iPhone 17", "iPhone 16", "iPad Pro 13-inch"];
    const runtimes = (supported: string[]) =>
      JSON.stringify({
        runtimes: [
          {
            identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-5",
            platform: "iOS",
            isAvailable: true,
            supportedDeviceTypes: ["iPhone 7", "iPhone 16"].map(type),
          },
          { identifier: RUNTIME, platform: "iOS", isAvailable: true, supportedDeviceTypes: supported.map(type) },
        ],
      });
    const IPHONE_17 = "com.apple.CoreSimulator.SimDeviceType.iPhone-17";
    assert.equal(pickDeviceType(runtimes(xcode26), RUNTIME), IPHONE_17);
    assert.equal(pickDeviceType(runtimes([...xcode26].reverse()), RUNTIME), IPHONE_17);
    assert.equal(pickDeviceType(runtimes(["iPhone Air", "iPad Pro 13-inch"]), RUNTIME), null);
    assert.equal(pickDeviceType(runtimes(xcode26), "com.apple.CoreSimulator.SimRuntime.iOS-99-0"), null);
    for (const bad of ["", "not json", "{}", '{"runtimes":[{"identifier":"x","supportedDeviceTypes":"iPhone 17"}]}'])
      assert.equal(pickDeviceType(bad, RUNTIME), null, bad);
  });

  it("a bundle id reaches a device shell only if it is a plain dotted identifier", () => {
    for (const ok of [IOS_APP_ID, ANDROID_APP_ID, "a.b"])
      assert.equal(
        codeOf(() => checkAppId(ok)),
        NO_ERROR,
        ok,
      );
    for (const bad of [
      "",
      "pond",
      "games.genex.pond; rm -rf /sdcard",
      "games.genex.pond && id",
      "games.genex.$(id)",
      "games.genex.`id`",
      "games..genex",
      ".games.genex",
      "games.genex.",
      "games.1genex",
      "games.genex.pond\nid",
      "games.genex.pond/../../x",
      `games.${"a".repeat(200)}`,
    ])
      assert.equal(
        codeOf(() => checkAppId(bad)),
        RustMobileCode.Usage,
        JSON.stringify(bad),
      );
  });
});

// ---- the step table and the workflow ------------------------------------------------------------

describe("the step table and rust-mobile.yml", () => {
  it("names the Simulator rows, the Play checks and the 16 KB emulator rows, in order", () => {
    const ids = STEP_TABLE.map((step) => step.id);
    assert.deepEqual(ids, [
      StepId.IosSimBoot,
      StepId.IosSimInstall,
      StepId.IosSimCapture,
      StepId.IosSimDelete,
      StepId.AndroidPackage,
      StepId.AabValidate,
      StepId.Zipalign16k,
      StepId.EmulatorPageSize,
      StepId.EmulatorSmoke,
      StepId.EmulatorCapture,
    ]);
    assert.equal(new Set(ids).size, ids.length);
    for (const step of STEP_TABLE) assert.ok(step.title.length > 20, `${step.id} has a title`);
  });

  it("the workflow rows cover every step once and the workflow calls them as the table says", async () => {
    const covered = WORKFLOW_ROWS.flatMap((row) => row.steps);
    assert.deepEqual([...covered].sort(), STEP_TABLE.map((step) => step.id).sort());
    assert.equal(
      codeOf(() => checkWorkflow("rust-mobile.yml", "")),
      RustMobileCode.WorkflowDrift,
    );
    checkWorkflow("rust-mobile.yml", await workflowText());
  });

  it("a workflow that drops, doubles, reorders, conditions or misplaces a call is refused", async () => {
    const text = await workflowText();
    const call = (id: string) => `scripts/ci/rust-mobile.ts --step ${id}`;
    const mutate = (edit: (text: string) => string) => () => checkWorkflow("rust-mobile.yml", edit(text));
    assert.equal(
      codeOf(mutate((t) => t.replace(call(StepId.EmulatorSmoke), "echo skipped"))),
      RustMobileCode.WorkflowDrift,
    );
    assert.equal(
      codeOf(
        mutate((t) =>
          t.replace(
            call(StepId.EmulatorCapture),
            `${call(StepId.EmulatorCapture)} && node ${call(StepId.EmulatorCapture)}`,
          ),
        ),
      ),
      RustMobileCode.WorkflowDrift,
    );
    const swapped = (t: string) =>
      t
        .replace(call(StepId.AabValidate), "@@A@@")
        .replace(call(StepId.Zipalign16k), call(StepId.AabValidate))
        .replace("@@A@@", call(StepId.Zipalign16k));
    assert.equal(codeOf(mutate(swapped)), RustMobileCode.WorkflowDrift);
    const conditioned = (t: string) =>
      t.replace(
        /( *)- name: ([^\n]*)\n( *)run: \|\n( *)node scripts\/ci\/rust-mobile.ts --step emulator-smoke/,
        "$1- name: $2\n$1  if: failure()\n$3run: |\n$4node scripts/ci/rust-mobile.ts --step emulator-smoke",
      );
    assert.equal(codeOf(mutate(conditioned)), RustMobileCode.WorkflowDrift);
    assert.equal(
      codeOf(() => checkWorkflow("rust-linux-host.yml", text)),
      RustMobileCode.UnknownStep,
    );
    assert.equal(
      codeOf(mutate((t) => t.replace(call("emulator-capture"), call("emulator-captur")))),
      RustMobileCode.UnknownStep,
    );
  });

  it("the Simulator job runs only on an owner dispatch, on a Mac, and always tears the Simulator down", async () => {
    const text = await workflowText();
    assert.equal(
      codeOf(() =>
        checkWorkflow("rust-mobile.yml", text.replace(/^( {4})if: github\.event_name == 'workflow_dispatch'\n/m, "")),
      ),
      RustMobileCode.WorkflowDrift,
    );
    assert.equal(
      codeOf(() => checkWorkflow("rust-mobile.yml", text.replace(/runs-on: macos-[\w.-]+/, "runs-on: ubuntu-24.04"))),
      RustMobileCode.WorkflowDrift,
    );
    assert.equal(
      codeOf(() => checkWorkflow("rust-mobile.yml", text.replace(/runs-on: ubuntu-[\w.-]+/, "runs-on: macos-26"))),
      RustMobileCode.WorkflowDrift,
    );
    assert.equal(
      codeOf(() =>
        checkWorkflow(
          "rust-mobile.yml",
          text.replace(/(\n +)if: always\(\)(\n +run: [^\n]*ios-sim-delete)/, "$1if: success()$2"),
        ),
      ),
      RustMobileCode.WorkflowDrift,
    );
  });

  it("the workflow carries the script's bundletool and 16 KB image pins, and the pin is a release URL", async () => {
    const text = await workflowText();
    assert.equal(
      codeOf(() => checkWorkflow("rust-mobile.yml", text.replace(BUNDLETOOL_PIN.sha256, "0".repeat(64)))),
      RustMobileCode.WorkflowDrift,
    );
    assert.equal(
      codeOf(() =>
        checkWorkflow(
          "rust-mobile.yml",
          text.replace(ANDROID_16K_IMAGE, "system-images;android-36;google_apis;x86_64"),
        ),
      ),
      RustMobileCode.WorkflowDrift,
    );
    assert.match(BUNDLETOOL_PIN.sha256, /^[0-9a-f]{64}$/);
    assert.ok(BUNDLETOOL_PIN.url.startsWith("https://github.com/google/bundletool/releases/download/"));
    assert.ok(BUNDLETOOL_PIN.url.includes(BUNDLETOOL_PIN.version));
  });
});

// ---- the command line ---------------------------------------------------------------------------

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runScript(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env, cwd: REPO, timeout: 5 * MINUTE_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (error as { code?: unknown }).code : 0;
        resolve({ code: typeof code === "number" ? code : 1, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

const refusalOf = (run: Run): { code: string; detail: string } | null => {
  const line = run.stderr.split("\n").find((l) => l.startsWith(REFUSAL_PREFIX));
  return line ? (JSON.parse(line.slice(REFUSAL_PREFIX.length)) as { code: string; detail: string }) : null;
};

describe("the command line", () => {
  it("prints the tables, checks the real workflow and refuses a bad invocation with a typed line", async () => {
    const table = await runScript(["--table"]);
    assert.equal(table.code, 0);
    const printed = JSON.parse(table.stdout) as { steps: StepSpec[] };
    assert.deepEqual(
      printed.steps.map((s) => s.id),
      STEP_TABLE.map((s) => s.id),
    );
    assert.equal((await runScript(["--check-workflow", WORKFLOW])).code, 0);
    const unknown = await runScript(["--step", "no-such-step"]);
    assert.equal(unknown.code, 1);
    assert.equal(refusalOf(unknown)?.code, RustMobileCode.UnknownStep);
    for (const args of [[], ["--table", "--step", "ios-sim-boot"], ["--bogus"], ["--step"]]) {
      const run = await runScript(args);
      assert.equal(run.code, 1, args.join(" "));
      assert.equal(refusalOf(run)?.code, RustMobileCode.Usage, args.join(" "));
    }
  });
});

// ---- the steps, against stub tools ----------------------------------------------------------------

interface Stubs {
  dir: string;
  evidence: string;
  calls: () => Promise<string[]>;
  put: (name: string, bytes: Buffer | string) => Promise<void>;
}

async function stubs(): Promise<Stubs> {
  const dir = await tmpDir("rust-mobile-ci-");
  await mkdir(path.join(dir, "evidence"));
  return {
    dir,
    evidence: path.join(dir, "evidence"),
    calls: async () =>
      (await readFile(path.join(dir, "calls.log"), "utf8").catch(() => "")).split("\n").filter(Boolean),
    put: (name, bytes) => writeFile(path.join(dir, name), bytes),
  };
}

async function executable(file: string, body: string): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

const XCRUN = `
D="$GENEX_STUB_DIR"
echo "$*" >> "$D/calls.log"
[ "$1" = simctl ] || exit 64
[ -f "$D/fail-$2" ] && { echo "simctl $2 failed" >&2; exit 1; }
case "$2" in
  list) case "$3" in runtimes) cat "$D/runtimes.json";; esac;;
  create) echo "${UDID}";;
  get_app_container) echo "$D/data";;
  io) cp "$D/screenshot.png" "$6";;
esac
exit 0`;

const RUNTIMES = JSON.stringify({
  runtimes: [
    {
      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
      platform: "iOS",
      isAvailable: true,
      supportedDeviceTypes: ["iPhone 17 Pro", "iPhone 17", "iPhone 16e"].map((name) => ({
        name,
        identifier: `com.apple.CoreSimulator.SimDeviceType.${name.replace(/ /g, "-")}`,
        productFamily: "iPhone",
      })),
    },
  ],
});
/** An admitted adapter whose shell never presented a frame (a CI run's log). */
const ADAPTER_ONLY_LOG = `${JSON.stringify({ event: "launched" })}\n${JSON.stringify({
  event: "gpu",
  receipt: JSON.stringify({ tier: "core", backend: "metal", adapter: "Apple M3 (Simulator)" }),
})}\n`;
const ADAPTER_LOG = `${ADAPTER_ONLY_LOG}${FRAME_PRESENTED}\n`;
const REFUSAL_RECORD = JSON.stringify({
  event: "gpu-unsupported",
  code: "gpu-unsupported",
  detail: "the Simulator's GPU family is below core",
});
const SCREEN_EVENT = {
  event: "refusal-screen",
  shown: true,
  code: "gpu-unsupported",
  window: [1179, 2556],
  ...SCREEN_PALETTE,
};
/** A refusal and the designed screen the shell drew for it. */
const REFUSED_LOG = `${REFUSAL_RECORD}\n${JSON.stringify(SCREEN_EVENT)}\n`;
/** A refusal whose shell drew no screen (the iOS shell before its hook: a black capture). */
const REFUSED_WITHOUT_SCREEN_LOG = `${REFUSAL_RECORD}\n`;
const FAILED_LOG = `${JSON.stringify({ event: "failed", code: "no-surface", detail: "no window" })}\n`;

interface IosRig extends Stubs {
  app: string;
  ctx: (flags?: Record<string, string>) => ReturnType<typeof makeContext>;
}

async function iosRig(): Promise<IosRig> {
  const s = await stubs();
  const xcrun = await executable(path.join(s.dir, "bin", "xcrun"), XCRUN);
  await s.put("runtimes.json", RUNTIMES);
  await s.put("screenshot.png", scene());
  await mkdir(path.join(s.dir, "data", "Documents", "genex-self-test"), { recursive: true });
  await writeFile(path.join(s.dir, "data", "Documents", "genex-self-test", "lifecycle.ndjson"), ADAPTER_LOG);
  const app = path.join(s.dir, "Pond.app");
  await mkdir(app);
  await writeFile(path.join(app, "Info.plist"), "plist");
  return {
    ...s,
    app,
    ctx: (flags = {}) =>
      makeContext({
        evidence: s.evidence,
        env: { ...process.env, GENEX_XCRUN: xcrun, GENEX_STUB_DIR: s.dir },
        flags: { "--app": app, "--app-id": IOS_APP_ID, ...flags },
        pollMs: 5,
        waitMs: 100,
      }),
  };
}

const spec = (id: string): StepSpec => {
  const found = STEP_TABLE.find((step) => step.id === id);
  assert.ok(found, id);
  return found;
};

const recordOf = async (evidence: string, id: string) =>
  JSON.parse(await readFile(path.join(evidence, `${id}.json`), "utf8")) as Record<string, unknown>;

describe("the Simulator steps", () => {
  it("boot, install, capture and delete: the calls, the records and a Simulator that is removed", async () => {
    const rig = await iosRig();
    await runStep(rig.ctx(), spec(StepId.IosSimBoot));
    await runStep(rig.ctx(), spec(StepId.IosSimInstall));
    await runStep(rig.ctx(), spec(StepId.IosSimCapture));
    await runStep(rig.ctx(), spec(StepId.IosSimDelete));
    assert.deepEqual(await rig.calls(), [
      "simctl list runtimes --json",
      "simctl create genex-ci com.apple.CoreSimulator.SimDeviceType.iPhone-17 com.apple.CoreSimulator.SimRuntime.iOS-26-5",
      `simctl boot ${UDID}`,
      `simctl bootstatus ${UDID} -b`,
      `simctl install ${UDID} ${rig.app}`,
      `simctl launch ${UDID} ${IOS_APP_ID}`,
      `simctl get_app_container ${UDID} ${IOS_APP_ID} data`,
      expectedScreenshotCall(rig),
      `simctl shutdown ${UDID}`,
      `simctl delete ${UDID}`,
    ]);
    const install = await recordOf(rig.evidence, StepId.IosSimInstall);
    assert.equal(install.status, "pass");
    assert.equal(install.outcome, "adapter");
    const capture = await recordOf(rig.evidence, StepId.IosSimCapture);
    assert.equal(capture.status, "pass");
    assert.ok(Number(capture.colours) >= MIN_COLOURS.Rendered);
    assert.ok(
      existsSync(path.join(rig.evidence, "genex-self-test", "lifecycle.ndjson")),
      "the shell's records are kept as evidence",
    );
    assert.ok(existsSync(path.join(rig.evidence, "ios-simulator.png")));
  });

  const expectedScreenshotCall = (rig: Stubs) =>
    `simctl io ${UDID} screenshot --type=png ${path.join(rig.evidence, "ios-simulator.png")}`;

  it("a typed GPU refusal is a recorded pass and its capture must show the typed refusal screen", async () => {
    const rig = await iosRig();
    await writeFile(path.join(rig.dir, "data", "Documents", "genex-self-test", "lifecycle.ndjson"), REFUSED_LOG);
    await runStep(rig.ctx(), spec(StepId.IosSimBoot));
    await runStep(rig.ctx(), spec(StepId.IosSimInstall));
    const install = await recordOf(rig.evidence, StepId.IosSimInstall);
    assert.equal(install.outcome, "gpu-unsupported");
    assert.deepEqual(install.refusalScreen, {
      shown: true,
      code: "gpu-unsupported",
      recordCode: "gpu-unsupported",
      ...SCREEN_PALETTE,
    });
    await rig.put("screenshot.png", refusalScreen());
    await runStep(rig.ctx(), spec(StepId.IosSimCapture));
    const capture = await recordOf(rig.evidence, StepId.IosSimCapture);
    assert.equal(capture.status, "pass");
    assert.equal(capture.refusalCode, "gpu-unsupported");
    await rig.put("screenshot.png", flat());
    assert.equal(await codeOfAsync(() => runStep(rig.ctx(), spec(StepId.IosSimCapture))), RustMobileCode.BlankCapture);
    assert.equal((await recordOf(rig.evidence, StepId.IosSimCapture)).status, "fail");
  });

  it("a failure event, a missing log and a blank rendered capture each fail with their code", async () => {
    const rig = await iosRig();
    await runStep(rig.ctx(), spec(StepId.IosSimBoot));
    const log = path.join(rig.dir, "data", "Documents", "genex-self-test", "lifecycle.ndjson");
    await writeFile(log, FAILED_LOG);
    assert.equal(await codeOfAsync(() => runStep(rig.ctx(), spec(StepId.IosSimInstall))), RustMobileCode.SmokeFailed);
    await writeFile(log, "");
    assert.equal(await codeOfAsync(() => runStep(rig.ctx(), spec(StepId.IosSimInstall))), RustMobileCode.SmokeFailed);
    await writeFile(log, ADAPTER_LOG);
    await runStep(rig.ctx(), spec(StepId.IosSimInstall));
    await rig.put("screenshot.png", refusal());
    assert.equal(await codeOfAsync(() => runStep(rig.ctx(), spec(StepId.IosSimCapture))), RustMobileCode.BlankCapture);
  });

  // Seen in a CI run: an admitted adapter is not a drawn frame.
  it("an adapter whose shell presents no frame fails the install typed, its records kept", async () => {
    const rig = await iosRig();
    await runStep(rig.ctx(), spec(StepId.IosSimBoot));
    await writeFile(path.join(rig.dir, "data", "Documents", "genex-self-test", "lifecycle.ndjson"), ADAPTER_ONLY_LOG);
    const detail = await detailOfAsync(() => runStep(rig.ctx(), spec(StepId.IosSimInstall)));
    assert.match(detail, /Apple M3 \(Simulator\) \(metal, core\)/);
    assert.match(detail, /presented no frame/);
    assert.equal((await recordOf(rig.evidence, StepId.IosSimInstall)).code, RustMobileCode.NoFramePresented);
    assert.ok(existsSync(path.join(rig.evidence, "genex-self-test", "lifecycle.ndjson")));
  });

  it("no runtime, a refused create and a failed boot are typed, and a created Simulator is still deleted", async () => {
    const none = await iosRig();
    await none.put("runtimes.json", "{}");
    assert.equal(await codeOfAsync(() => runStep(none.ctx(), spec(StepId.IosSimBoot))), RustMobileCode.SimulatorFailed);
    assert.deepEqual(
      (await none.calls()).filter((call) => /create|boot/.test(call)),
      [],
    );
    const refused = await iosRig();
    await refused.put("fail-create", "");
    assert.equal(
      await codeOfAsync(() => runStep(refused.ctx(), spec(StepId.IosSimBoot))),
      RustMobileCode.SimulatorFailed,
    );
    const broken = await iosRig();
    await broken.put("fail-bootstatus", "");
    assert.equal(
      await codeOfAsync(() => runStep(broken.ctx(), spec(StepId.IosSimBoot))),
      RustMobileCode.SimulatorFailed,
    );
    await runStep(broken.ctx(), spec(StepId.IosSimDelete));
    assert.deepEqual((await broken.calls()).slice(-2), [`simctl shutdown ${UDID}`, `simctl delete ${UDID}`]);
  });

  it("delete with nothing to delete passes and touches nothing; a tampered device record is refused", async () => {
    const rig = await iosRig();
    await runStep(rig.ctx(), spec(StepId.IosSimDelete));
    assert.deepEqual(await rig.calls(), []);
    assert.equal((await recordOf(rig.evidence, StepId.IosSimDelete)).deleted, false);
    await writeFile(path.join(rig.evidence, "ios-sim-device.json"), JSON.stringify({ udid: "booted; rm -rf ~" }));
    assert.equal(await codeOfAsync(() => runStep(rig.ctx(), spec(StepId.IosSimDelete))), RustMobileCode.BadRecord);
    assert.equal(await codeOfAsync(() => runStep(rig.ctx(), spec(StepId.IosSimInstall))), RustMobileCode.BadRecord);
    assert.deepEqual(await rig.calls(), []);
  });

  it("hostile --app and --app-id make no simctl call", async () => {
    const rig = await iosRig();
    await runStep(rig.ctx(), spec(StepId.IosSimBoot));
    const before = (await rig.calls()).length;
    const file = path.join(rig.dir, "plain-file.app");
    await writeFile(file, "not a bundle");
    const link = path.join(rig.dir, "Link.app");
    await symlink(rig.app, link);
    const rows: Array<[string, Record<string, string>, string]> = [
      ["a file named .app", { "--app": file }, RustMobileCode.Usage],
      ["a missing bundle", { "--app": path.join(rig.dir, "Gone.app") }, RustMobileCode.Usage],
      ["a link to a bundle", { "--app": link }, RustMobileCode.Usage],
      ["a folder that is not an .app", { "--app": rig.dir }, RustMobileCode.Usage],
      ["a relative path", { "--app": "Pond.app" }, RustMobileCode.Usage],
      ["an injecting bundle id", { "--app-id": "games.genex.pond; rm -rf ~" }, RustMobileCode.Usage],
      ["a bundle id with a newline", { "--app-id": "games.genex.pond\nid" }, RustMobileCode.Usage],
    ];
    for (const [name, flags, code] of rows)
      assert.equal(await codeOfAsync(() => runStep(rig.ctx(flags), spec(StepId.IosSimInstall))), code, name);
    assert.equal((await rig.calls()).length, before, "no simctl call was made for a hostile argument");
  });
});

// ---- the Android steps against stub tools ---------------------------------------------------------

const ADB = `
D="$GENEX_STUB_DIR"
echo "$*" >> "$D/calls.log"
# An empty answer for the first N reads of the activity stack (an adb that answered nothing).
empty_reads() { n=$(cat "$D/empty-reads" 2>/dev/null || echo 0); [ "$n" -gt 0 ] && { echo $((n - 1)) > "$D/empty-reads"; return 0; }; return 1; }
# Counts one failure down from the file $1 (a package service or an install that fails N times).
fails_left() { n=$(cat "$D/$1" 2>/dev/null || echo 0); [ "$n" = never ] && return 0; [ "$n" -gt 0 ] && { echo $((n - 1)) > "$D/$1"; return 0; }; return 1; }
# The window in focus: another (foreign-title, System UI's not-responding dialog by default) for the
# first N reads, then the game's activity; or as focus-script lists them (game, foreign, none).
focus_line() {
  if [ -f "$D/focus-script" ]; then
    set -- $(cat "$D/focus-script"); next="\${1:-game}"; [ $# -gt 0 ] && shift; echo "$*" > "$D/focus-script"
    if [ "$next" = foreign ]; then echo "  mCurrentFocus=Window{3855267 u0 Application Not Responding: com.android.systemui}"; return; fi
    if [ "$next" = none ]; then echo "  mCurrentFocus=null"; return; fi
    echo "  mCurrentFocus=Window{f17cc0b u0 ${ANDROID_COMPONENT}}"; return
  fi
  if fails_left foreign-focus; then echo "  mCurrentFocus=Window{3855267 u0 $(cat "$D/foreign-title" 2>/dev/null || echo 'Application Not Responding: com.android.systemui')}";
  else echo "  mCurrentFocus=Window{f17cc0b u0 ${ANDROID_COMPONENT}}"; fi
}
case "$1 $2 $3" in
  "shell pm path") fails_left pm-failures && { echo "cmd: Can't find service: package" >&2; exit 20; }; echo "package:/system/framework/framework-res.apk"; exit 0;;
  "shell getprop sys.boot_completed") echo 1;;
  "shell getconf PAGE_SIZE") cat "$D/pagesize";;
  "shell am start"*) cat "$D/am-start.txt" 2>/dev/null || echo "Starting: Intent";;
  "exec-out screencap -p"*) cat "$D/screen.png";;
  "shell dumpsys power") cat "$D/power.txt" 2>/dev/null || echo "  mWakefulness=Awake";;
  "shell dumpsys activity") empty_reads || { echo "ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)"; focus_line; };;
  "shell am broadcast") echo "Broadcast completed: result=0";;
  "shell cat /proc/meminfo") echo "MemAvailable:    1024000 kB";;
  "logcat -b all") cat "$D/stream.txt" 2>/dev/null; exit 0;;
esac
case "$1" in
  root) cat "$D/root.txt" 2>/dev/null || echo "restarting adbd as root";;
  install) fails_left install-failures && { echo "adb: failed to install $3: cmd: Failure calling service package: Broken pipe (32)"; exit 1; }; echo Success;;
  logcat) cat "$D/logcat.txt" 2>/dev/null;;
  shell) case "$2" in
    cat) [ "$3" = /proc/meminfo ] && exit 0; [ -f "$D/lifecycle.ndjson" ] && cat "$D/lifecycle.ndjson" || exit 1;;
    run-as) exit 1;;
    pidof) cat "$D/pid.txt" 2>/dev/null || echo 4242;;
  esac;;
esac
exit 0`;

const ZIPALIGN = `
D="$GENEX_STUB_DIR"
echo "zipalign $*" >> "$D/calls.log"
cat "$D/zipalign.out"
exit "$(cat "$D/zipalign.code" 2>/dev/null || echo 0)"`;

const JAVA = `
D="$GENEX_STUB_DIR"
echo "java $*" >> "$D/calls.log"
case "$*" in
  *" validate "*) cat "$D/validate.out" 2>/dev/null; exit "$(cat "$D/validate.code" 2>/dev/null || echo 0)";;
  *"dump manifest"*) cat "$D/manifest.xml";;
  *"dump config"*) cat "$D/config.json";;
esac
exit 0`;

/** The emulator's admitted adapter, as the phone shell logs it. */
const VULKAN_ADAPTER = JSON.stringify({
  event: "gpu",
  receipt: { tier: "core", backend: "vulkan", adapter: "SwiftShader" },
});

const GOOD_MANIFEST = `<manifest package="${ANDROID_APP_ID}">\n<uses-sdk android:minSdkVersion="29" android:targetSdkVersion="36" />\n</manifest>\n`;
const GOOD_CONFIG = '{"optimizations":{"uncompressNativeLibraries":{"alignment":"PAGE_ALIGNMENT_16K"}}}';

interface AndroidRig extends Stubs {
  sdk: string;
  java: string;
  jar: string;
  out: string;
  ctx: (flags?: Record<string, string>, env?: NodeJS.ProcessEnv) => ReturnType<typeof makeContext>;
}

async function androidRig(): Promise<AndroidRig> {
  const s = await stubs();
  const sdk = path.join(s.dir, "sdk");
  await executable(path.join(sdk, "platform-tools", "adb"), ADB);
  for (const version of ["34.0.0", "36.0.0"]) {
    await executable(path.join(sdk, "build-tools", version, "zipalign"), ZIPALIGN);
    await executable(path.join(sdk, "build-tools", version, "aapt2"), "exit 1");
    await executable(path.join(sdk, "build-tools", version, "apksigner"), "exit 1");
  }
  await mkdir(path.join(sdk, "platforms", "android-36"), { recursive: true });
  await writeFile(path.join(sdk, "platforms", "android-36", "android.jar"), "jar");
  const java = path.join(s.dir, "jdk");
  await executable(path.join(java, "bin", "java"), JAVA);
  const jar = path.join(s.dir, "bundletool.jar");
  await writeFile(jar, "pretend bundletool");
  const out = path.join(s.dir, "out");
  await mkdir(out);
  await writeFile(path.join(out, "pond.aab"), "aab");
  await writeFile(path.join(out, "pond-debug.apk"), "apk");
  await writeFile(path.join(out, "pond-universal.apk"), "apk");
  await s.put("zipalign.out", "Verification successful\n");
  await s.put("pagesize", "16384\n");
  await s.put("manifest.xml", GOOD_MANIFEST);
  await s.put("config.json", GOOD_CONFIG);
  await s.put("screen.png", scene());
  await s.put("lifecycle.ndjson", `${VULKAN_ADAPTER}\n${FRAME_PRESENTED}\n`);
  await writeFile(
    path.join(s.evidence, `${StepId.AndroidPackage}.json`),
    JSON.stringify({ status: "pass", applicationId: ANDROID_APP_ID }),
  );
  return {
    ...s,
    sdk,
    java,
    jar,
    out,
    ctx: (flags = {}, env = {}) =>
      makeContext({
        evidence: s.evidence,
        env: { ...process.env, ANDROID_HOME: sdk, GENEX_CI_JAVA_HOME: java, GENEX_STUB_DIR: s.dir, ...env },
        flags: { "--out": out, "--bundletool": jar, "--image": ANDROID_16K_IMAGE, ...flags },
        bundletoolSha256: createHash("sha256").update("pretend bundletool").digest("hex"),
        pollMs: 5,
        waitMs: 100,
      }),
  };
}

describe("the Simulator's refusal screen", () => {
  it("after a refusal a capture in other colours is not the refusal screen, however many colours it has", async () => {
    const rig = await iosRig();
    await writeFile(path.join(rig.dir, "data", "Documents", "genex-self-test", "lifecycle.ndjson"), REFUSED_LOG);
    await runStep(rig.ctx(), spec(StepId.IosSimBoot));
    await runStep(rig.ctx(), spec(StepId.IosSimInstall));
    const white = [255, 255, 255] as const;
    for (const [name, bytes] of [
      [
        "the same layout in another palette",
        refusalScreen({ background: [60, 90, 140], ink: [240, 200, 40], codeInk: white }),
      ],
      ["white text on black", refusalScreen({ background: [0, 0, 0], ink: white, codeInk: white })],
      [
        "the background with no text",
        refusalScreen({ ...SCREEN_PALETTE, ink: SCREEN_PALETTE.background, codeInk: SCREEN_PALETTE.background }),
      ],
      ["a rendered scene", scene()],
    ] as const) {
      await rig.put("screenshot.png", bytes);
      assert.equal(
        await codeOfAsync(() => runStep(rig.ctx(), spec(StepId.IosSimCapture))),
        name === "the background with no text" ? RustMobileCode.BlankCapture : RustMobileCode.NotRefusalScreen,
        name,
      );
    }
  });

  it("a refusal with no refusal screen fails the install: none logged, one not shown, or one naming another code", async () => {
    const rig = await iosRig();
    await runStep(rig.ctx(), spec(StepId.IosSimBoot));
    const log = path.join(rig.dir, "data", "Documents", "genex-self-test", "lifecycle.ndjson");
    const notShown = JSON.stringify({ ...SCREEN_EVENT, shown: false });
    const otherCode = JSON.stringify({ ...SCREEN_EVENT, code: "native-feature-missing" });
    const noColours = JSON.stringify({ ...SCREEN_EVENT, background: [16, 18], ink: "white" });
    for (const [name, text] of [
      ["no screen logged", REFUSED_WITHOUT_SCREEN_LOG],
      ["a screen that could not be drawn", `${REFUSAL_RECORD}\n${notShown}\n`],
      ["a screen naming another code", `${REFUSAL_RECORD}\n${otherCode}\n`],
      ["a screen without its colours", `${REFUSAL_RECORD}\n${noColours}\n`],
    ] as const) {
      await writeFile(log, text);
      assert.equal(
        await codeOfAsync(() => runStep(rig.ctx(), spec(StepId.IosSimInstall))),
        RustMobileCode.RefusalNotShown,
        name,
      );
    }
    await writeFile(log, `${REFUSAL_RECORD}\n${notShown}\n${JSON.stringify(SCREEN_EVENT)}\n`);
    await runStep(rig.ctx(), spec(StepId.IosSimInstall));
  });

  it("a capture after a refusal whose install record lost its screen is refused, not judged", async () => {
    const rig = await iosRig();
    await runStep(rig.ctx(), spec(StepId.IosSimBoot));
    await rig.put("screenshot.png", refusalScreen());
    for (const refusalScreenFacts of [
      undefined,
      { ...SCREEN_PALETTE, shown: true },
      { shown: true, code: "gpu-unsupported" },
    ]) {
      await writeFile(
        path.join(rig.evidence, `${StepId.IosSimInstall}.json`),
        JSON.stringify({ status: "pass", outcome: "gpu-unsupported", refusalScreen: refusalScreenFacts }),
      );
      assert.equal(await codeOfAsync(() => runStep(rig.ctx(), spec(StepId.IosSimCapture))), RustMobileCode.BadRecord);
    }
  });
});

describe("the Play check steps", () => {
  it("zipalign -c -P 16 runs over the dev APK and the universal APK; a misaligned one is refused", async () => {
    const rig = await androidRig();
    await runStep(rig.ctx(), spec(StepId.Zipalign16k));
    const calls = (await rig.calls()).filter((call) => call.startsWith("zipalign"));
    assert.deepEqual(calls, [
      `zipalign -c -P 16 -v 4 ${path.join(rig.out, "pond-debug.apk")}`,
      `zipalign -c -P 16 -v 4 ${path.join(rig.out, "pond-universal.apk")}`,
    ]);
    await rig.put("zipalign.code", "1");
    assert.equal(await codeOfAsync(() => runStep(rig.ctx(), spec(StepId.Zipalign16k))), RustMobileCode.NotAligned);
    assert.equal((await recordOf(rig.evidence, StepId.Zipalign16k)).status, "fail");
  });

  it("uses the newest build-tools at the pinned major and refuses a missing tool, typed", async () => {
    const rig = await androidRig();
    await runStep(rig.ctx(), spec(StepId.Zipalign16k));
    assert.ok((await rig.calls()).every((call) => !call.includes("34.0.0")));
    const old = await androidRig();
    const { rm } = await import("node:fs/promises");
    await rm(path.join(old.sdk, "build-tools", "36.0.0"), { recursive: true });
    assert.equal(await codeOfAsync(() => runStep(old.ctx(), spec(StepId.Zipalign16k))), RustMobileCode.ToolMissing);
    const noSdk = await androidRig();
    assert.equal(
      await codeOfAsync(() =>
        runStep(noSdk.ctx({}, { ANDROID_HOME: "", ANDROID_SDK_ROOT: "" }), spec(StepId.Zipalign16k)),
      ),
      RustMobileCode.ToolMissing,
    );
  });

  it("bundletool validate, then the manifest at targetSdk 36 and the 16 KB config", async () => {
    const rig = await androidRig();
    await runStep(rig.ctx(), spec(StepId.AabValidate));
    const aab = path.join(rig.out, "pond.aab");
    assert.deepEqual(
      (await rig.calls()).filter((call) => call.startsWith("java")).map((call) => call.replace(rig.jar, "<jar>")),
      [
        `java -jar <jar> validate --bundle=${aab}`,
        `java -jar <jar> dump manifest --bundle=${aab}`,
        `java -jar <jar> dump config --bundle=${aab}`,
      ],
    );
    await rig.put("manifest.xml", GOOD_MANIFEST.replace('"36"', '"35"'));
    assert.equal(await codeOfAsync(() => runStep(rig.ctx(), spec(StepId.AabValidate))), RustMobileCode.ManifestRefused);
    await rig.put("manifest.xml", GOOD_MANIFEST);
    await rig.put("config.json", "{}");
    assert.equal(await codeOfAsync(() => runStep(rig.ctx(), spec(StepId.AabValidate))), RustMobileCode.ConfigRefused);
    await rig.put("config.json", GOOD_CONFIG);
    await rig.put("validate.code", "1");
    assert.equal(await codeOfAsync(() => runStep(rig.ctx(), spec(StepId.AabValidate))), RustMobileCode.BundleInvalid);
  });

  it("a bundletool jar that is not the pinned bytes is refused before it runs", async () => {
    const rig = await androidRig();
    const ctx = makeContext({ ...rig.ctx(), bundletoolSha256: BUNDLETOOL_PIN.sha256 });
    assert.equal(await codeOfAsync(() => runStep(ctx, spec(StepId.AabValidate))), RustMobileCode.BundletoolPin);
    assert.deepEqual(
      (await rig.calls()).filter((call) => call.startsWith("java")),
      [],
    );
  });

  it("a package that is missing is refused, not skipped", async () => {
    const rig = await androidRig();
    const { rm } = await import("node:fs/promises");
    await rm(path.join(rig.out, "pond.aab"));
    assert.equal(await codeOfAsync(() => runStep(rig.ctx(), spec(StepId.AabValidate))), RustMobileCode.BadRecord);
    await rm(path.join(rig.out, "pond-debug.apk"));
    assert.equal(await codeOfAsync(() => runStep(rig.ctx(), spec(StepId.Zipalign16k))), RustMobileCode.BadRecord);
  });
});

describe("the 16 KB emulator steps", () => {
  it("page size: the image is a 16 KB one and the kernel reports 16384", async () => {
    const rig = await androidRig();
    await runStep(rig.ctx(), spec(StepId.EmulatorPageSize));
    assert.deepEqual(await rig.calls(), ["shell getconf PAGE_SIZE"]);
    await rig.put("pagesize", "4096\n");
    assert.equal(await codeOfAsync(() => runStep(rig.ctx(), spec(StepId.EmulatorPageSize))), RustMobileCode.PageSize);
    const stale = rig.ctx({ "--image": "system-images;android-36;google_apis;x86_64" });
    assert.equal(await codeOfAsync(() => runStep(stale, spec(StepId.EmulatorPageSize))), RustMobileCode.PageSize);
  });

  // Flipped (pass-1 gate): the smoke also keeps the lifecycle log it read, the system log's tail,
  // `am start`'s answer, the activity stack and the app's own log lines as evidence, so a run with
  // no outcome says where the app stopped.
  // Flipped (pass-1 fix, Android cluster): before the install the smoke waits for the package
  // service to answer (`pm path android`); CI's installs failed with a broken pipe to it.
  // Flipped (pass-1 gate round 3): before the start the smoke makes the screen stay awake and
  // unlocked (the emulator's own post-boot `screen_off_timeout` is lost when `adb root` restarts adbd
  // under it), and asserts it awake; it keeps the free memory, and streams the whole system log from
  // before the start to the verdict (the ring buffer wrapped before it was read).
  it("smoke: root, install, wake, start, read the lifecycle log, read the app's crash log, keep the logs", async () => {
    const rig = await androidRig();
    await rig.put("stream.txt", "I genex   : streamed line\n");
    await runStep(rig.ctx(), spec(StepId.EmulatorSmoke));
    const apk = path.join(rig.out, "pond-debug.apk");
    const lifecycle = `shell cat /data/data/${ANDROID_APP_ID}/files/genex-self-test/lifecycle.ndjson`;
    const calls = await rig.calls();
    assert.deepEqual(
      calls.filter((call) => call !== STREAM_CALL),
      [
        "wait-for-device",
        "root",
        "wait-for-device",
        "shell pm path android",
        `install -r ${apk}`,
        "shell settings put system screen_off_timeout 2147483647",
        "shell svc power stayon true",
        "shell input keyevent KEYCODE_WAKEUP",
        "shell wm dismiss-keyguard",
        "shell dumpsys power",
        "shell cat /proc/meminfo",
        `shell am start -W -n ${ANDROID_APP_ID}/android.app.NativeActivity`,
        lifecycle,
        "logcat -d -b crash",
        "logcat -d -s genex:V AndroidRuntime:E DEBUG:V",
        lifecycle,
        "logcat -d -t 4000",
        "shell dumpsys activity activities",
        `shell pidof ${ANDROID_APP_ID}`,
        `logcat -d --pid 4242`,
      ],
    );
    assert.equal(calls.filter((call) => call === STREAM_CALL).length, 1, "the system log is streamed once");
    const record = await recordOf(rig.evidence, StepId.EmulatorSmoke);
    assert.equal(record.status, "pass");
    assert.equal(record.outcome, "adapter");
    const { readFile } = await import("node:fs/promises");
    assert.match(await readFile(path.join(rig.evidence, "lifecycle.txt"), "utf8"), /"event":"gpu"/);
    assert.match(await readFile(path.join(rig.evidence, "logcat-stream.txt"), "utf8"), /streamed line/);
    assert.match(await readFile(path.join(rig.evidence, "device-ready.txt"), "utf8"), /mWakefulness=Awake/);
    assert.match(await readFile(path.join(rig.evidence, "meminfo.txt"), "utf8"), /MemAvailable/);
  });

  it("smoke: a screen that stays asleep is refused typed, and the app is never started", async () => {
    const rig = await androidRig();
    await rig.put("power.txt", "  mWakefulness=Asleep\n");
    assert.equal(
      await codeOfAsync(() => runStep(rig.ctx(), spec(StepId.EmulatorSmoke))),
      RustMobileCode.DeviceNotReady,
    );
    const calls = await rig.calls();
    assert.ok(calls.filter((call) => call === "shell dumpsys power").length > 1, "the wake is polled, not read once");
    assert.equal(
      calls.some((call) => call.startsWith("shell am start")),
      false,
    );
  });

  it("smoke: a run with no outcome names what the evidence shows: the start's answer, a low-memory kill, a gone process", async () => {
    const rig = await androidRig();
    const { rm } = await import("node:fs/promises");
    await rm(path.join(rig.dir, "lifecycle.ndjson"));
    await rig.put("am-start.txt", "Status: timeout\nLaunchState: UNKNOWN (-1)\nWaitTime: 15760\n");
    await rig.put(
      "stream.txt",
      `10-11 19:23:01.000   208   208 I lowmemorykiller: Kill '${ANDROID_APP_ID}' (4242), uid 10213, oom_score_adj 200 to free 300000kB rss; reason: min watermark is breached\n`,
    );
    await rig.put("pid.txt", "");
    const detail = await detailOfAsync(() => runStep(rig.ctx(), spec(StepId.EmulatorSmoke)));
    assert.match(detail, /^no-outcome: /);
    assert.match(detail, /am start: Status: timeout/);
    assert.match(detail, /low-memory killer ended the app/);
    assert.match(detail, /no app process/);
  });

  // Seen in a CI run: SystemUI's theme overlays relaunched the activity for an
  // undeclared assetsPaths change before its window came; the app never resumed and onDestroy
  // blocked. The no-outcome detail now names the relaunch and the changes it was for.
  it("smoke: a run with no outcome names a relaunch of the app's activity and the changes it was for", async () => {
    const rig = await androidRig();
    const { rm } = await import("node:fs/promises");
    await rm(path.join(rig.dir, "lifecycle.ndjson"));
    await rig.put("am-start.txt", "Status: timeout\nLaunchState: UNKNOWN (-1)\nWaitTime: 14092\n");
    await rig.put("stream.txt", RELAUNCH_LOG);
    const detail = await detailOfAsync(() => runStep(rig.ctx(), spec(StepId.EmulatorSmoke)));
    assert.match(detail, /^no-outcome: /);
    assert.match(detail, /the system relaunched the activity for assetsPaths/);
  });

  it("smoke: the install waits for the package service and is tried again after a broken pipe", async () => {
    const rig = await androidRig();
    await rig.put("pm-failures", "2");
    await rig.put("install-failures", "2");
    await runStep(rig.ctx(), spec(StepId.EmulatorSmoke));
    const calls = await rig.calls();
    assert.equal(
      calls.filter((call) => call === "shell pm path android").length,
      3,
      "the service is polled until it answers",
    );
    assert.equal(calls.filter((call) => call.startsWith("install -r ")).length, 3, "the install is tried again");
    assert.ok(
      calls.lastIndexOf("shell pm path android") < calls.findIndex((call) => call.startsWith("install -r ")),
      "nothing is installed before the service answers",
    );
    assert.equal((await recordOf(rig.evidence, StepId.EmulatorSmoke)).status, "pass");
  });

  it("smoke: an install that keeps failing ends typed with every attempt; a service that never answers installs nothing", async () => {
    const rig = await androidRig();
    await rig.put("install-failures", "never");
    const detail = await detailOfAsync(() => runStep(rig.ctx(), spec(StepId.EmulatorSmoke)));
    assert.match(detail, /^adb install failed 3 times: /);
    assert.match(detail, /Broken pipe/);
    assert.equal((await rig.calls()).filter((call) => call.startsWith("install -r ")).length, 3);
    const quiet = await androidRig();
    await quiet.put("pm-failures", "never");
    assert.equal(
      await codeOfAsync(() => runStep(quiet.ctx(), spec(StepId.EmulatorSmoke))),
      RustMobileCode.DeviceNotReady,
    );
    assert.equal(
      (await quiet.calls()).some((call) => call.startsWith("install ")),
      false,
    );
  });

  it("smoke: an activity stack read that answers nothing is read again", async () => {
    const rig = await androidRig();
    await rig.put("empty-reads", "2");
    await runStep(rig.ctx(), spec(StepId.EmulatorSmoke));
    const reads = (await rig.calls()).filter((call) => call === "shell dumpsys activity activities");
    assert.equal(reads.length, 3);
    const { readFile } = await import("node:fs/promises");
    assert.match(await readFile(path.join(rig.evidence, "activities.txt"), "utf8"), /ACTIVITY MANAGER/);
  });

  it("smoke: a typed GPU refusal passes as recorded; a failure event, no log and a crash do not", async () => {
    const rig = await androidRig();
    await rig.put("lifecycle.ndjson", REFUSED_LOG);
    await runStep(rig.ctx(), spec(StepId.EmulatorSmoke));
    assert.equal((await recordOf(rig.evidence, StepId.EmulatorSmoke)).outcome, "gpu-unsupported");
    await rig.put("lifecycle.ndjson", FAILED_LOG);
    assert.equal(await codeOfAsync(() => runStep(rig.ctx(), spec(StepId.EmulatorSmoke))), RustMobileCode.SmokeFailed);
    await rig.put("lifecycle.ndjson", ADAPTER_LOG.replace('"metal"', '"vulkan"'));
    await rig.put("logcat.txt", `F DEBUG   : pid: 1, name: ${ANDROID_APP_ID}  >>> ${ANDROID_APP_ID} <<<\n`);
    assert.equal(await codeOfAsync(() => runStep(rig.ctx(), spec(StepId.EmulatorSmoke))), RustMobileCode.SmokeFailed);
    const { rm } = await import("node:fs/promises");
    await rm(path.join(rig.dir, "lifecycle.ndjson"));
    await rm(path.join(rig.dir, "logcat.txt"));
    assert.equal(await codeOfAsync(() => runStep(rig.ctx(), spec(StepId.EmulatorSmoke))), RustMobileCode.SmokeFailed);
  });

  // Seen in a CI run: the smoke passed on an admitted adapter whose shell had
  // presented nothing; the capture five seconds later showed no scene.
  it("smoke: an adapter whose shell presents no frame fails typed after its evidence is kept", async () => {
    const rig = await androidRig();
    await rig.put(
      "lifecycle.ndjson",
      `${VULKAN_ADAPTER}\n${JSON.stringify({ event: "surface-created", configured: true })}\n`,
    );
    const detail = await detailOfAsync(() => runStep(rig.ctx(), spec(StepId.EmulatorSmoke)));
    assert.match(detail, /SwiftShader \(vulkan, core\)/);
    assert.match(detail, /presented no frame/);
    const record = await recordOf(rig.evidence, StepId.EmulatorSmoke);
    assert.equal(record.code, RustMobileCode.NoFramePresented);
    const lifecycle = `shell cat /data/data/${ANDROID_APP_ID}/files/genex-self-test/lifecycle.ndjson`;
    assert.ok(
      (await rig.calls()).filter((call) => call === lifecycle).length > 2,
      "the log is read until the wait is spent",
    );
    assert.match(await readFile(path.join(rig.evidence, "lifecycle.txt"), "utf8"), /surface-created/);
    assert.ok(existsSync(path.join(rig.evidence, "activities.txt")), "the activity stack is kept");
  });

  it("smoke: an adb that cannot root falls back to run-as and still ends typed", async () => {
    const rig = await androidRig();
    await rig.put("root.txt", "adbd cannot run as root in production builds");
    const { rm } = await import("node:fs/promises");
    await rm(path.join(rig.dir, "lifecycle.ndjson"));
    assert.equal(await codeOfAsync(() => runStep(rig.ctx(), spec(StepId.EmulatorSmoke))), RustMobileCode.SmokeFailed);
    assert.ok(
      (await rig.calls()).some((call) => call.startsWith(`shell run-as ${ANDROID_APP_ID} cat files/genex-self-test`)),
    );
  });

  it("capture: a scene is accepted after a render, a refusal screen after a refusal, a black frame never", async () => {
    const rig = await androidRig();
    await writeFile(
      path.join(rig.evidence, `${StepId.EmulatorSmoke}.json`),
      JSON.stringify({ status: "pass", outcome: "adapter" }),
    );
    await runStep(rig.ctx(), spec(StepId.EmulatorCapture));
    assert.ok(existsSync(path.join(rig.evidence, "android-emulator.png")));
    await rig.put("screen.png", refusal());
    assert.equal(
      await codeOfAsync(() => runStep(rig.ctx(), spec(StepId.EmulatorCapture))),
      RustMobileCode.BlankCapture,
    );
    await writeFile(
      path.join(rig.evidence, `${StepId.EmulatorSmoke}.json`),
      JSON.stringify({ status: "pass", outcome: "gpu-unsupported" }),
    );
    await runStep(rig.ctx(), spec(StepId.EmulatorCapture));
    await rig.put("screen.png", blackUnderStatusBar());
    assert.equal(
      await codeOfAsync(() => runStep(rig.ctx(), spec(StepId.EmulatorCapture))),
      RustMobileCode.BlankCapture,
    );
    await rig.put("screen.png", "not a png");
    assert.equal(await codeOfAsync(() => runStep(rig.ctx(), spec(StepId.EmulatorCapture))), RustMobileCode.BadPng);
  });

  // Seen in a CI run: System UI's not-responding dialog had focus when the screen
  // was captured. A system dialog in focus is closed and the capture waits for the game's window;
  // the focus before and after the screenshot must both be the game.
  it("capture: a system dialog in focus is closed, and the screen is captured once the game's window has focus", async () => {
    const rig = await androidRig();
    await writeFile(
      path.join(rig.evidence, `${StepId.EmulatorSmoke}.json`),
      JSON.stringify({ status: "pass", outcome: "adapter" }),
    );
    await rig.put("foreign-focus", "2");
    await runStep(rig.ctx(), spec(StepId.EmulatorCapture));
    const focus = "shell dumpsys activity activities";
    const close = "shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS";
    assert.deepEqual(await rig.calls(), [focus, close, focus, close, focus, "exec-out screencap -p", focus]);
    const record = await recordOf(rig.evidence, StepId.EmulatorCapture);
    assert.equal(record.status, "pass");
    assert.equal(record.focus, ANDROID_COMPONENT);
    assert.deepEqual(record.closedDialogs, [
      "Application Not Responding: com.android.systemui",
      "Application Not Responding: com.android.systemui",
    ]);
    assert.match(
      await readFile(path.join(rig.evidence, "capture-focus.txt"), "utf8"),
      /mCurrentFocus=.*NativeActivity/,
    );
  });

  it("capture: a dialog that never clears fails typed with the screen kept; the game's own not-responding dialog is never closed", async () => {
    const rig = await androidRig();
    await writeFile(
      path.join(rig.evidence, `${StepId.EmulatorSmoke}.json`),
      JSON.stringify({ status: "pass", outcome: "adapter" }),
    );
    await rig.put("foreign-focus", "never");
    const detail = await detailOfAsync(() => runStep(rig.ctx(), spec(StepId.EmulatorCapture)));
    assert.match(detail, /Application Not Responding: com\.android\.systemui/);
    assert.equal((await recordOf(rig.evidence, StepId.EmulatorCapture)).code, RustMobileCode.CaptureNotGame);
    assert.ok(existsSync(path.join(rig.evidence, "android-emulator.png")), "what the screen showed is kept");
    const own = await androidRig();
    await writeFile(
      path.join(own.evidence, `${StepId.EmulatorSmoke}.json`),
      JSON.stringify({ status: "pass", outcome: "adapter" }),
    );
    await own.put("foreign-focus", "never");
    await own.put("foreign-title", `Application Not Responding: ${ANDROID_APP_ID}`);
    const ownDetail = await detailOfAsync(() => runStep(own.ctx(), spec(StepId.EmulatorCapture)));
    assert.match(ownDetail, /the app itself is not responding/);
    const calls = await own.calls();
    assert.equal(
      calls.some((call) => call.includes("CLOSE_SYSTEM_DIALOGS")),
      false,
      "the game's own dialog is evidence, never closed",
    );
    assert.equal(calls.filter((call) => call === "shell dumpsys activity activities").length, 1);
  });

  // Seen in a CI run: between windows no window has focus (`mCurrentFocus=null`), and
  // the record listed "null" three times among the dialogs it closed.
  it("capture: no window in focus is waited out, with nothing closed and no dialog named for it", async () => {
    const rig = await androidRig();
    await writeFile(
      path.join(rig.evidence, `${StepId.EmulatorSmoke}.json`),
      JSON.stringify({ status: "pass", outcome: "adapter" }),
    );
    await rig.put("focus-script", "foreign none none game game");
    await runStep(rig.ctx(), spec(StepId.EmulatorCapture));
    const focus = "shell dumpsys activity activities";
    const close = "shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS";
    assert.deepEqual(await rig.calls(), [focus, close, focus, focus, focus, "exec-out screencap -p", focus]);
    const record = await recordOf(rig.evidence, StepId.EmulatorCapture);
    assert.equal(record.status, "pass");
    assert.deepEqual(record.closedDialogs, ["Application Not Responding: com.android.systemui"]);
  });

  it("capture: focus that leaves the game during the screenshot takes it again", async () => {
    const rig = await androidRig();
    await writeFile(
      path.join(rig.evidence, `${StepId.EmulatorSmoke}.json`),
      JSON.stringify({ status: "pass", outcome: "adapter" }),
    );
    // The game, then a dialog right after the shot, then the game for good.
    await rig.put("focus-script", "game foreign game game");
    await runStep(rig.ctx(), spec(StepId.EmulatorCapture));
    const calls = await rig.calls();
    assert.equal(calls.filter((call) => call === "exec-out screencap -p").length, 2);
    assert.equal((await recordOf(rig.evidence, StepId.EmulatorCapture)).status, "pass");
  });

  it("a hostile application id never reaches adb", async () => {
    const rig = await androidRig();
    const calls = (await rig.calls()).length;
    for (const bad of ["games.genex.x; reboot", "games.genex.x\nid", "$(id)", ""])
      assert.equal(
        await codeOfAsync(() => runStep(rig.ctx({ "--app-id": bad }), spec(StepId.EmulatorSmoke))),
        RustMobileCode.Usage,
        JSON.stringify(bad),
      );
    assert.equal((await rig.calls()).length, calls);
  });
});

// ---- the real row ---------------------------------------------------------------------------------

const REQUIRED = process.env.GENEX_REQUIRE_TOOLCHAINS === "1";
const POND_APK = path.resolve(REPO, ".studio-dev/spike-mobile/out/android/pond-native-activity-debug.apk");
const REAL_BUNDLETOOL = path.join(DEV_RUST_TOOLCHAIN, "tools", "bundletool", "bundletool.jar");
const REAL_JAVA_HOME = path.join(DEV_RUST_TOOLCHAIN, "tools", "jdk", "Contents", "Home");

/** Why the real row cannot run, or null. A throw under `GENEX_REQUIRE_TOOLCHAINS=1`. */
function realSkip(): string | null {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const buildTools = sdk ? path.join(sdk, "build-tools") : "";
  const hasBuildTools =
    existsSync(buildTools) && readdirSync(buildTools).some((v) => v.startsWith(`${ANDROID_PINS.buildToolsMajor}.`));
  const missing = [
    [sdk, "ANDROID_HOME (the Android SDK)"],
    [hasBuildTools || undefined, `build-tools ${ANDROID_PINS.buildToolsMajor}`],
    [existsSync(REAL_BUNDLETOOL) || undefined, "the dev store's bundletool"],
    [existsSync(path.join(REAL_JAVA_HOME, "bin", "java")) || undefined, "the dev store's JDK"],
    [existsSync(POND_APK) || undefined, "the M0a pond APK"],
  ].find(([have]) => !have);
  if (!missing) return null;
  const why = `not run: ${missing[1]} absent`;
  if (REQUIRED) throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${why}`);
  return why;
}

const realReason = realSkip();

describe("the Play checks over what the lane really makes", { skip: realReason ?? false }, () => {
  it("packages the pond's library, then zipalign -c -P 16 and bundletool validate pass at targetSdk 36", async () => {
    const out = await tmpDir("rust-mobile-ci-real-");
    const evidence = path.join(out, "evidence");
    await mkdir(evidence);
    const sha = createHash("sha256")
      .update(await readFile(REAL_BUNDLETOOL))
      .digest("hex");
    const ctx = makeContext({
      evidence,
      env: { ...process.env, GENEX_CI_JAVA_HOME: REAL_JAVA_HOME },
      flags: { "--out": out, "--library-apk": POND_APK, "--bundletool": REAL_BUNDLETOOL },
      bundletoolSha256: sha,
    });
    await runStep(ctx, spec(StepId.AndroidPackage));
    for (const file of ["pond-debug.apk", "pond.aab", "pond-universal.apk"])
      assert.ok(existsSync(path.join(out, file)), file);
    const packaged = await recordOf(evidence, StepId.AndroidPackage);
    assert.equal(packaged.sandboxed, false);
    assert.match(String(packaged.applicationId), /^games\.genex\.game\.g[0-9a-f]{12}$/);
    await runStep(ctx, spec(StepId.AabValidate));
    await runStep(ctx, spec(StepId.Zipalign16k));
    const validated = await recordOf(evidence, StepId.AabValidate);
    assert.equal(validated.targetSdk, ANDROID_PINS.targetSdk);
    assert.equal(validated.alignment, "PAGE_ALIGNMENT_16K");
    const aligned = await recordOf(evidence, StepId.Zipalign16k);
    assert.deepEqual(aligned.checked, ["pond-debug.apk", "pond-universal.apk"]);
  });
});
