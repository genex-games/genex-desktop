/**
 * A Rust · wgpu game's iPhone package (`src/substrate/ios-package.ts`, M5.1) and its export run
 * (`src/main/core/ios-export-run.ts`): the host-written Info.plist from its fixed table only (a
 * hostile title stays one string, an orientation outside the table is refused), the Xcode gate
 * (a device or distribution build needs Xcode 26 with the iOS 26 SDK), the admitted executable
 * held to the lane's digests and to the artifact's platform, every packaged entry re-verified
 * before signing and inside the IPA, and the export run's refusals before anything is built.
 *
 * The signer is a recording sandbox standing in for `codesign` (it adds `_CodeSignature` and
 * changes nothing else); `ios-package-real.test.ts` runs the real one over a real Simulator build.
 * Nothing here builds, signs with an identity, or launches a Simulator or a device.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { inflateRawSync } from "node:zlib";
import { packageDigest, phonePackageStore } from "../../src/main/core/device-launch.ts";
import { exportIosGame, type IosExportDeps } from "../../src/main/core/ios-export-run.ts";
import type { MobileExportGameRequest } from "../../src/main/core/native-export-run.ts";
import { MobileBuild } from "../../src/main/rust-build-mobile.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import {
  ExportError,
  ExportRefusal,
  ExportSigning,
  type ExportSigningChoice,
  MobileArtifact,
} from "../../src/shared/game-export-contract.ts";
import { DeviceKind } from "../../src/shared/device-launch.ts";
import { BuildTarget, type GameProject, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import { NativeRefusal } from "../../src/shared/native-contract.ts";
import {
  IOS_PRIVACY_CATEGORIES,
  IosOrientation,
  IosPackageRefusal,
  type IosPackageRequest,
  iosInfoPlist,
  iosOrientationsOf,
  iosXcodeRefusal,
  packageIosApp,
} from "../../src/substrate/ios-package.ts";
import type { MobileSignSandbox } from "../../src/substrate/mobile-sign.ts";
import type { RunRequest, RunResult } from "../../src/substrate/spawn.ts";
import type { XcodeSdks } from "../../src/substrate/toolchain-store/xcode-probe.ts";
import { SigningRequester } from "../../src/substrate/windows-sign.ts";
import { iosBinary, iosSimulatorBinary } from "../fixtures/rust-bundles/binaries.ts";
import { tmpDir } from "../helpers/tmp.ts";

const BUNDLE_ID = "games.genex.game.0123456789ab";
const TEAM = "ABCDE12345";
const NOW = Date.UTC(2026, 9, 7, 3, 4);
const XCODE_26: XcodeSdks = { present: true, version: "26.6", iosSdk: "26.5", simulatorSdk: "26.5" };
const XCODE_25: XcodeSdks = { present: true, version: "25.4", iosSdk: "25.4", simulatorSdk: "25.4" };
const NO_XCODE: XcodeSdks = { present: false, version: null, iosSdk: null, simulatorSdk: null };
const SECRET = "sk-test-0123456789abcdefghij";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// ---------- a small reader for the plists the host writes ----------

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (text: string) => text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ENTITIES[name] ?? "");

/** The top-level dict of a plist document, keys in document order (refuses anything unexpected). */
function readPlist(xml: string): { keys: string[]; value: Record<string, PlistValue> } {
  const body = xml.slice(xml.indexOf("<plist"));
  const tokens = [...body.matchAll(/<(\/?)([A-Za-z]+)[^>]*?(\/?)>|([^<]+)/g)]
    .map((m) => ({ close: m[1] === "/", tag: m[2] ?? "", empty: m[3] === "/", text: m[4] ?? null }))
    .filter((t) => t.text === null || t.text.trim() !== "");
  let at = 1;
  const next = () => {
    const token = tokens[at++];
    if (!token) throw new Error("plist ended early");
    return token;
  };
  const textUntil = (tag: string): string => {
    const token = next();
    if (token.text === null) {
      assert.equal(token.tag, tag);
      return "";
    }
    assert.equal(next().tag, tag);
    return decode(token.text);
  };
  const keys: string[] = [];
  const value = (depth: number): PlistValue => {
    const token = next();
    if (token.tag === "true" || token.tag === "false") return token.tag === "true";
    if (token.empty && token.tag === "dict") return {};
    if (token.empty && token.tag === "array") return [];
    if (token.tag === "string") return textUntil("string");
    if (token.tag === "integer") return Number(textUntil("integer"));
    if (token.tag === "array") {
      const items: PlistValue[] = [];
      while (tokens[at]?.close !== true) items.push(value(depth + 1));
      next();
      return items;
    }
    assert.equal(token.tag, "dict", `unexpected <${token.tag}>`);
    const dict: Record<string, PlistValue> = {};
    while (tokens[at]?.close !== true) {
      assert.equal(next().tag, "key");
      const key = textUntil("key");
      if (depth === 0) keys.push(key);
      dict[key] = value(depth + 1);
    }
    next();
    return dict;
  };
  const top = value(0);
  assert.ok(top && typeof top === "object" && !Array.isArray(top));
  return { keys, value: top as Record<string, PlistValue> };
}

// ---------- a lane output, a profile and a recording codesign ----------

interface Lane {
  out: string;
  outputs: { path: string; sha256: string }[];
}

/** A lane's admitted `out/`: the executable and two assets, with their digests. */
async function laneOut(root: string, exe: Buffer): Promise<Lane> {
  const out = path.join(root, "build", "ios.out");
  await mkdir(path.join(out, "assets", "levels"), { recursive: true });
  await writeFile(path.join(out, "game"), exe, { mode: 0o755 });
  const level = Buffer.from("level one");
  const sprite = Buffer.from("not a program");
  await writeFile(path.join(out, "assets", "levels", "one.txt"), level);
  await writeFile(path.join(out, "assets", "sprite.bin"), sprite);
  return {
    out,
    outputs: [
      { path: "assets/levels/one.txt", sha256: sha256(level) },
      { path: "assets/sprite.bin", sha256: sha256(sprite) },
      { path: "game", sha256: sha256(exe) },
    ],
  };
}

/** A `.mobileprovision` as Apple ships one: a CMS envelope around a plain-text plist. */
async function profile(dir: string, appId: string, team = TEAM): Promise<string> {
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    "<key>Entitlements</key><dict>",
    `<key>application-identifier</key><string>${appId}</string>`,
    `<key>com.apple.developer.team-identifier</key><string>${team}</string>`,
    "<key>get-task-allow</key><true/>",
    "</dict>",
    `<key>TeamIdentifier</key><array><string>${team}</string></array>`,
    "</dict></plist>",
  ].join("\n");
  const file = path.join(dir, "Genex.mobileprovision");
  await writeFile(
    file,
    Buffer.concat([Buffer.from([0x30, 0x80, 0x06, 0x09]), Buffer.from(plist), Buffer.alloc(64, 1)]),
  );
  return file;
}

/** The last argument of a codesign display line: the app, shell-quoted. */
const lastArg = (command: string) => (command.match(/'([^']*)'$/)?.[1] ?? command.split(" ").at(-1) ?? "").trim();

/** A codesign stand-in: records each run and its entitlements, and adds `_CodeSignature/CodeResources`. */
function recordingCodesign(change?: (app: string) => Promise<void>) {
  const runs: RunRequest[] = [];
  const entitlements: string[] = [];
  const sandbox: MobileSignSandbox = {
    async run(request: RunRequest): Promise<RunResult> {
      runs.push(request);
      const named = /'--entitlements' '([^']+)'/.exec(request.command)?.[1];
      if (named) entitlements.push(await readFile(named, "utf8"));
      const app = lastArg(request.command);
      await mkdir(path.join(app, "_CodeSignature"), { recursive: true });
      await writeFile(path.join(app, "_CodeSignature", "CodeResources"), "<plist/>");
      await change?.(app);
      return { code: 0, stdout: "", stderr: "", timedOut: false, sandboxed: true } as RunResult;
    },
  };
  return { sandbox, runs, entitlements };
}

interface Rig {
  root: string;
  lane: Lane;
  exports: string;
  target: string;
  game: string;
}

async function rig(exe: Buffer = iosSimulatorBinary()): Promise<Rig> {
  // By its real path, as the studio's own folders are: the export answers the target's real path.
  const root = await realpath(await tmpDir("studio-ios-package-"));
  const game = path.join(root, "games", "pond");
  await mkdir(game, { recursive: true });
  const exports = path.join(root, "exports");
  await mkdir(exports, { recursive: true });
  return { root, lane: await laneOut(root, exe), exports, target: path.join(exports, "pond.ios"), game };
}

function request(r: Rig, overrides: Partial<IosPackageRequest> = {}): IosPackageRequest {
  return {
    artifact: MobileArtifact.SimulatorApp,
    out: r.lane.out,
    outputs: r.lane.outputs,
    notices: [],
    bundleId: BUNDLE_ID,
    title: "Pond",
    fallbackName: "pond",
    orientations: [IosOrientation.LandscapeLeft, IosOrientation.LandscapeRight],
    signing: { kind: ExportSigning.AdHoc },
    requestedBy: SigningRequester.Harness,
    xcode: XCODE_26,
    source: r.game,
    target: r.target,
    exportsRoot: r.exports,
    stagingRoot: path.join(r.root, "staging"),
    secretValues: [SECRET],
    now: () => NOW,
    signer: { sandbox: recordingCodesign().sandbox, forbiddenRoots: [r.game], home: r.root },
    ...overrides,
  };
}

/** The refusal `work` threw, checked to be an `ExportError`. */
async function refusal(work: Promise<unknown>): Promise<ExportError> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof ExportError, `expected an ExportError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected a refusal");
}

const exists = (file: string) =>
  lstat(file).then(
    () => true,
    () => false,
  );

/** Every file under `dir`, `/`-separated, sorted. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

/** A stored or deflated zip's entries by name (no zip64). */
function zipEntries(zip: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let at = 0;
  while (zip.readUInt32LE(at) === 0x04034b50) {
    const method = zip.readUInt16LE(at + 8);
    const size = zip.readUInt32LE(at + 18);
    const nameLength = zip.readUInt16LE(at + 26);
    const extra = zip.readUInt16LE(at + 28);
    const name = zip.subarray(at + 30, at + 30 + nameLength).toString("utf8");
    const start = at + 30 + nameLength + extra;
    const stored = zip.subarray(start, start + size);
    if (!name.endsWith("/")) entries.set(name, method === 8 ? inflateRawSync(stored) : Buffer.from(stored));
    at = start + size;
  }
  return entries;
}

// ---------- the Info.plist ----------

const INFO_KEYS = [
  "CFBundleDevelopmentRegion",
  "CFBundleDisplayName",
  "CFBundleExecutable",
  "CFBundleIcons",
  "CFBundleIcons~ipad",
  "CFBundleIdentifier",
  "CFBundleInfoDictionaryVersion",
  "CFBundleName",
  "CFBundlePackageType",
  "CFBundleShortVersionString",
  "CFBundleSupportedPlatforms",
  "CFBundleVersion",
  "DTPlatformName",
  "DTPlatformVersion",
  "DTSDKName",
  "DTXcode",
  "LSRequiresIPhoneOS",
  "MinimumOSVersion",
  "UIDeviceFamily",
  "UILaunchScreen",
  "UIRequiredDeviceCapabilities",
  "UIRequiresFullScreen",
  "UIStatusBarHidden",
  "UISupportedInterfaceOrientations",
  "UISupportedInterfaceOrientations~ipad",
];

describe("the iPhone app's Info.plist is written from its fixed table only", () => {
  const plistInput = {
    bundleId: BUNDLE_ID,
    title: "Pond",
    name: "Pond",
    orientations: [IosOrientation.LandscapeLeft, IosOrientation.LandscapeRight],
    artifact: MobileArtifact.SimulatorApp,
    xcode: XCODE_26,
    now: NOW,
  };

  it("names the identity, the launch screen, iOS 16 and the Simulator SDK it was built with", () => {
    const { keys, value } = readPlist(iosInfoPlist(plistInput));
    assert.deepEqual(keys, INFO_KEYS);
    assert.equal(value.CFBundleIdentifier, BUNDLE_ID);
    assert.equal(value.CFBundleExecutable, "game");
    assert.equal(value.CFBundlePackageType, "APPL");
    assert.equal(value.MinimumOSVersion, "16.0");
    assert.deepEqual(value.CFBundleSupportedPlatforms, ["iPhoneSimulator"]);
    assert.equal(value.DTPlatformName, "iphonesimulator");
    assert.equal(value.DTSDKName, "iphonesimulator26.5");
    assert.equal(value.DTXcode, "2660");
    assert.equal(value.CFBundleVersion, "2026.1007.304");
    assert.deepEqual(value.UILaunchScreen, {});
    assert.deepEqual(value.UIRequiredDeviceCapabilities, ["arm64", "metal"]);
    assert.deepEqual(value.UISupportedInterfaceOrientations, [
      "UIInterfaceOrientationLandscapeLeft",
      "UIInterfaceOrientationLandscapeRight",
    ]);
    assert.deepEqual(value.UIDeviceFamily, [1, 2]);
  });

  it("an IPA names the device platform and SDK", () => {
    const { value } = readPlist(iosInfoPlist({ ...plistInput, artifact: MobileArtifact.Ipa }));
    assert.deepEqual(value.CFBundleSupportedPlatforms, ["iPhoneOS"]);
    assert.equal(value.DTSDKName, "iphoneos26.5");
  });

  it("a hostile title with XML entities stays one escaped string and adds no key", () => {
    const title = `Pond & <Co> "q" 'a'</string><key>UIFileSharingEnabled</key><true/><string>\u0007`;
    const { keys, value } = readPlist(iosInfoPlist({ ...plistInput, title, name: title }));
    assert.deepEqual(keys, INFO_KEYS);
    assert.equal(value.UIFileSharingEnabled, undefined);
    assert.equal(value.CFBundleDisplayName, title.replace("\u0007", "").slice(0, 64));
  });

  it("refuses a bundle id Studio did not choose before writing anything", () => {
    assert.throws(
      () => iosInfoPlist({ ...plistInput, bundleId: "com.example.</string>" }),
      (error: unknown) => error instanceof ExportError && error.refusal === IosPackageRefusal.Identity,
    );
  });

  const refused: Array<[string, unknown]> = [
    ["an orientation outside the table", ["landscape-left", "UIInterfaceOrientationPortrait"]],
    ["no orientation", []],
    ["the same orientation twice", ["portrait", "portrait"]],
    ["not a list", "portrait"],
  ];
  for (const [label, orientations] of refused) {
    it(`refuses ${label}, typed`, () => {
      assert.throws(
        () => iosOrientationsOf(orientations),
        (error: unknown) => error instanceof ExportError && error.refusal === IosPackageRefusal.Orientation,
      );
    });
  }

  it("keeps the table's orientations in the order asked", () => {
    assert.deepEqual(iosOrientationsOf(["portrait", "landscape-right"]), [
      IosOrientation.Portrait,
      IosOrientation.LandscapeRight,
    ]);
  });
});

// ---------- the Xcode gate ----------

describe("the Xcode gate", () => {
  it("refuses a device or distribution build with an Xcode older than 26, typed", () => {
    assert.equal(iosXcodeRefusal(MobileArtifact.Ipa, XCODE_25), "xcode-too-old");
    assert.equal(iosXcodeRefusal(MobileArtifact.Ipa, { ...XCODE_26, iosSdk: "18.4" }), "ios-sdk-missing");
    assert.equal(iosXcodeRefusal(MobileArtifact.Ipa, NO_XCODE), "xcode-missing");
    assert.equal(iosXcodeRefusal(MobileArtifact.Ipa, XCODE_26), null);
  });

  it("lets a Simulator build run with any Xcode that has a Simulator SDK", () => {
    assert.equal(iosXcodeRefusal(MobileArtifact.SimulatorApp, XCODE_25), null);
    assert.equal(
      iosXcodeRefusal(MobileArtifact.SimulatorApp, { ...XCODE_26, simulatorSdk: null }),
      "simulator-sdk-missing",
    );
  });

  it("an IPA with Xcode 25 is refused toolchain-unusable before anything is read, signed or written", async () => {
    const r = await rig(iosBinary());
    const codesign = recordingCodesign();
    const choice: ExportSigningChoice = {
      kind: ExportSigning.IosDevelopment,
      identity: `Apple Development: Pat (${TEAM})`,
      provisioningProfile: await profile(r.root, `${TEAM}.*`),
    };
    const error = await refusal(
      packageIosApp(
        request(r, {
          artifact: MobileArtifact.Ipa,
          signing: choice,
          requestedBy: SigningRequester.Person,
          xcode: XCODE_25,
          signer: { sandbox: codesign.sandbox, forbiddenRoots: [r.game], home: r.root },
        }),
      ),
    );
    assert.equal(error.code, ExportRefusal.ToolchainUnusable);
    assert.equal(error.refusal, "xcode-too-old");
    assert.equal(codesign.runs.length, 0);
    assert.equal(await exists(r.target), false);
  });
});

// ---------- the Simulator app ----------

describe("a Simulator app", () => {
  it("is the admitted executable, the assets, the host's files and the notices, signed and receipted", async () => {
    const r = await rig();
    const codesign = recordingCodesign();
    const made = await packageIosApp(
      request(r, { signer: { sandbox: codesign.sandbox, forbiddenRoots: [r.game], home: r.root } }),
    );
    assert.equal(made.artifact, path.join(r.target, "Pond.app"));
    const files = await filesUnder(made.artifact);
    assert.deepEqual(files, [
      "AppIcon60x60@2x.png",
      "AppIcon60x60@3x.png",
      "AppIcon76x76@2x~ipad.png",
      "AppIcon83.5x83.5@2x~ipad.png",
      "Info.plist",
      "PkgInfo",
      "PrivacyInfo.xcprivacy",
      "_CodeSignature/CodeResources",
      "assets/levels/one.txt",
      "assets/sprite.bin",
      "game",
      "notices/NOTICES.txt",
    ]);
    assert.deepEqual(await readFile(path.join(made.artifact, "game")), iosSimulatorBinary());
    assert.equal(((await lstat(path.join(made.artifact, "game"))).mode & 0o777).toString(8), "755");
    const icon = await readFile(path.join(made.artifact, "AppIcon60x60@2x.png"));
    assert.deepEqual([...icon.subarray(1, 4)], [...Buffer.from("PNG")]);
    assert.equal(icon.readUInt32BE(16), 120);
    assert.equal(codesign.runs.length, 1);
    assert.match(codesign.runs[0]?.command ?? "", /^'\/usr\/bin\/codesign' '--force' '--sign' '-' '--timestamp=none'/);
    assert.equal(readPlist(codesign.entitlements[0] ?? "").keys.length, 0, "a Simulator app's entitlements are empty");
    assert.equal(await exists(path.join(r.target, "entitlements.plist")), false);
    const marker = JSON.parse(await readFile(path.join(r.target, ".studio-export.json"), "utf8"));
    assert.equal(marker.destination, BuildTarget.Ios);
    assert.equal(marker.artifact, MobileArtifact.SimulatorApp);
    assert.deepEqual(marker.xcode, { version: "26.6", sdk: "iphonesimulator26.5" });
    assert.equal(marker.minimumOS, "16.0");
    assert.equal(made.receipt.xcode.version, "26.6");
  });

  it("declares the required-reason APIs a Rust game's runtime calls, and no tracking", async () => {
    const r = await rig();
    const made = await packageIosApp(request(r));
    const { value } = readPlist(await readFile(path.join(made.artifact, "PrivacyInfo.xcprivacy"), "utf8"));
    assert.equal(value.NSPrivacyTracking, false);
    assert.deepEqual(value.NSPrivacyTrackingDomains, []);
    assert.deepEqual(value.NSPrivacyCollectedDataTypes, []);
    const declared = (value.NSPrivacyAccessedAPITypes as Array<Record<string, PlistValue>>).map(
      (entry) => entry.NSPrivacyAccessedAPIType,
    );
    assert.deepEqual(declared, Object.keys(IOS_PRIVACY_CATEGORIES));
  });

  it("refuses an executable whose bytes are not the ones the lane admitted", async () => {
    const r = await rig();
    const outputs = r.lane.outputs.map((o) => (o.path === "game" ? { ...o, sha256: "0".repeat(64) } : o));
    const error = await refusal(packageIosApp(request(r, { outputs })));
    assert.equal(error.code, ExportRefusal.BuildChanged);
    assert.equal(error.refusal, IosPackageRefusal.EntryChanged);
    assert.equal(error.file, "game");
    assert.equal(await exists(r.target), false);
  });

  it("refuses an asset the lane did not admit", async () => {
    const r = await rig();
    await writeFile(path.join(r.lane.out, "assets", "late.txt"), "added after admission");
    const error = await refusal(packageIosApp(request(r)));
    assert.equal(error.code, ExportRefusal.BuildChanged);
    assert.equal(await exists(r.target), false);
  });

  it("refuses a packaged entry whose digest changed after staging, before it is signed", async () => {
    const r = await rig();
    const codesign = recordingCodesign();
    const error = await refusal(
      packageIosApp(
        request(r, {
          signer: { sandbox: codesign.sandbox, forbiddenRoots: [r.game], home: r.root },
          afterStage: async (app) => writeFile(path.join(app, "assets", "sprite.bin"), "swapped"),
        }),
      ),
    );
    assert.equal(error.code, ExportRefusal.BuildChanged);
    assert.equal(error.refusal, IosPackageRefusal.EntryChanged);
    assert.equal(error.file, "assets/sprite.bin");
    assert.equal(codesign.runs.length, 0);
    assert.equal(await exists(r.target), false);
  });

  it("refuses a file the stager did not write, before it is signed", async () => {
    const r = await rig();
    const error = await refusal(
      packageIosApp(request(r, { afterStage: async (app) => writeFile(path.join(app, "extra.dylib"), "x") })),
    );
    assert.equal(error.refusal, IosPackageRefusal.EntryChanged);
    assert.equal(error.file, "extra.dylib");
  });

  it("refuses a device executable for the Simulator, and a Simulator one for an IPA", async () => {
    const device = await rig(iosBinary());
    const error = await refusal(packageIosApp(request(device)));
    assert.equal(error.code, ExportRefusal.AdmissionRefused);
    assert.equal(error.refusal, IosPackageRefusal.PlatformMismatch);
    const sim = await rig();
    const ipa = await refusal(
      packageIosApp(
        request(sim, {
          artifact: MobileArtifact.Ipa,
          requestedBy: SigningRequester.Person,
          signing: {
            kind: ExportSigning.IosDevelopment,
            identity: `Apple Development: Pat (${TEAM})`,
            provisioningProfile: await profile(sim.root, `${TEAM}.*`),
          },
        }),
      ),
    );
    assert.equal(ipa.refusal, IosPackageRefusal.PlatformMismatch);
  });

  it("refuses an executable the Rust iOS gate refuses (rustc's 10.0 default)", async () => {
    const r = await rig(iosSimulatorBinary({ minos: "10.0" }));
    const error = await refusal(packageIosApp(request(r)));
    assert.equal(error.code, ExportRefusal.AdmissionRefused);
    assert.equal(error.refusal, NativeRefusal.WrongMachine);
  });

  it("refuses a game file holding a credential Studio holds, before it is signed", async () => {
    const r = await rig();
    await writeFile(path.join(r.lane.out, "assets", "sprite.bin"), `key=${SECRET}`);
    const outputs = r.lane.outputs.map((o) =>
      o.path === "assets/sprite.bin" ? { ...o, sha256: sha256(Buffer.from(`key=${SECRET}`)) } : o,
    );
    const codesign = recordingCodesign();
    const error = await refusal(
      packageIosApp(request(r, { outputs, signer: { sandbox: codesign.sandbox, forbiddenRoots: [], home: r.root } })),
    );
    assert.equal(error.code, ExportRefusal.SecretFound);
    assert.equal(codesign.runs.length, 0);
  });

  it("refuses a signer that changed more than the signature", async () => {
    const r = await rig();
    const codesign = recordingCodesign(async (app) => writeFile(path.join(app, "assets", "sprite.bin"), "changed"));
    const error = await refusal(
      packageIosApp(request(r, { signer: { sandbox: codesign.sandbox, forbiddenRoots: [], home: r.root } })),
    );
    assert.equal(error.code, ExportRefusal.SigningFailed);
    assert.equal(await exists(r.target), false);
  });
});

// ---------- the IPA ----------

describe("an IPA", () => {
  async function ipaRequest(r: Rig, appId: string, overrides: Partial<IosPackageRequest> = {}) {
    const choice: ExportSigningChoice = {
      kind: ExportSigning.IosDevelopment,
      identity: `Apple Development: Pat (${TEAM})`,
      provisioningProfile: await profile(r.root, appId),
    };
    return request(r, {
      artifact: MobileArtifact.Ipa,
      signing: choice,
      requestedBy: SigningRequester.Person,
      ...overrides,
    });
  }

  it("is Payload/<Name>.app zipped, every entry the signed app's, with the profile's identity entitlements", async () => {
    const r = await rig(iosBinary());
    const codesign = recordingCodesign();
    const signer = { sandbox: codesign.sandbox, forbiddenRoots: [r.game], home: r.root };
    const made = await packageIosApp(await ipaRequest(r, `${TEAM}.*`, { signer }));
    assert.equal(made.artifact, path.join(r.target, "Pond.ipa"));
    assert.deepEqual(await filesUnder(r.target), [".studio-export.json", "Pond.ipa", "README.txt"]);
    const entries = zipEntries(await readFile(made.artifact));
    assert.ok(entries.has("Payload/Pond.app/embedded.mobileprovision"));
    assert.ok(entries.has("Payload/Pond.app/_CodeSignature/CodeResources"));
    assert.deepEqual(entries.get("Payload/Pond.app/game"), iosBinary());
    assert.equal(
      readPlist(entries.get("Payload/Pond.app/Info.plist")?.toString("utf8") ?? "").value.CFBundleIdentifier,
      BUNDLE_ID,
    );
    const { value } = readPlist(codesign.entitlements[0] ?? "");
    assert.deepEqual(value, {
      "application-identifier": `${TEAM}.${BUNDLE_ID}`,
      "com.apple.developer.team-identifier": TEAM,
      "get-task-allow": true,
    });
  });

  it("a distribution signing gets no debugger entitlement", async () => {
    const r = await rig(iosBinary());
    const codesign = recordingCodesign();
    const base = await ipaRequest(r, `${TEAM}.${BUNDLE_ID}`, {
      signer: { sandbox: codesign.sandbox, forbiddenRoots: [r.game], home: r.root },
    });
    const signing = {
      ...base.signing,
      kind: ExportSigning.IosDistribution,
      identity: `Apple Distribution: Pat (${TEAM})`,
    };
    await packageIosApp({ ...base, signing: signing as ExportSigningChoice });
    assert.equal(readPlist(codesign.entitlements[0] ?? "").value["get-task-allow"], false);
  });

  it("refuses a provisioning profile that does not cover the game's bundle id", async () => {
    const r = await rig(iosBinary());
    const error = await refusal(packageIosApp(await ipaRequest(r, `${TEAM}.com.example.other`)));
    assert.equal(error.code, ExportRefusal.SigningInvalid);
    assert.equal(error.refusal, IosPackageRefusal.ProvisioningProfile);
    assert.equal(await exists(r.target), false);
  });

  it("is refused to the harness before anything is read", async () => {
    const r = await rig(iosBinary());
    const codesign = recordingCodesign();
    const base = await ipaRequest(r, `${TEAM}.*`, {
      signer: { sandbox: codesign.sandbox, forbiddenRoots: [], home: r.root },
    });
    const error = await refusal(packageIosApp({ ...base, requestedBy: SigningRequester.Harness }));
    assert.equal(error.code, ExportRefusal.HarnessMayNotSign);
    assert.equal(codesign.runs.length, 0);
  });

  it("refuses a signing that does not make the artifact asked for", async () => {
    const r = await rig();
    const error = await refusal(packageIosApp(request(r, { artifact: MobileArtifact.Ipa })));
    assert.equal(error.code, ExportRefusal.SigningInvalid);
  });
});

// ---------- the export run ----------

describe("the iPhone export run", () => {
  const game: GameProject = {
    name: "pond",
    dir: "/games/pond",
    title: "Pond",
    shape: { kind: ProjectKind.RustWgpu },
    destinations: { stack: GameStack.RustWgpu, targets: [BuildTarget.Mac, BuildTarget.Ios] },
  } as unknown as GameProject;

  function runRequest(overrides: Partial<MobileExportGameRequest> = {}): MobileExportGameRequest {
    return {
      destination: BuildTarget.Ios,
      game,
      targetDir: "/exports/pond.ios",
      signing: { kind: ExportSigning.AdHoc },
      artifact: MobileArtifact.SimulatorApp,
      person: false,
      ...overrides,
    };
  }

  function deps(overrides: Partial<IosExportDeps> = {}): IosExportDeps & { builds: MobileBuild[] } {
    const builds: MobileBuild[] = [];
    return {
      builds,
      host: StudioPlatform.Mac,
      games: { bundleIdFor: async () => BUNDLE_ID },
      build: async (_game, build) => {
        builds.push(build);
        return null;
      },
      xcode: async () => XCODE_26,
      notices: async () => ({ ok: true, notices: [] }),
      signer: { sandbox: recordingCodesign().sandbox, forbiddenRoots: [], home: "/home" },
      stagingRoot: "/staging",
      exportsRoot: "/exports",
      secretValues: () => [],
      ...overrides,
    };
  }

  it("refuses lane-missing when the core has not wired the iOS lane", async () => {
    const error = await refusal(exportIosGame(runRequest()));
    assert.equal(error.code, ExportRefusal.LaneMissing);
  });

  it("is refused off a Mac before anything is built", async () => {
    const d = deps({ host: StudioPlatform.Linux });
    const error = await refusal(exportIosGame(runRequest(), d));
    assert.equal(error.code, ExportRefusal.MacBuildsNeedAMac);
    assert.deepEqual(d.builds, []);
  });

  it("refuses a game that does not name the iPhone", async () => {
    const d = deps();
    const mac = { ...game, destinations: { stack: GameStack.RustWgpu, targets: [BuildTarget.Mac] } };
    const error = await refusal(exportIosGame(runRequest({ game: mac }), d));
    assert.equal(error.code, ExportRefusal.NotADestination);
    assert.deepEqual(d.builds, []);
  });

  it("refuses the harness an IPA before anything is built", async () => {
    const d = deps();
    const signing: ExportSigningChoice = {
      kind: ExportSigning.IosDevelopment,
      identity: `Apple Development: Pat (${TEAM})`,
      provisioningProfile: "/keys/Genex.mobileprovision",
    };
    const error = await refusal(exportIosGame(runRequest({ artifact: MobileArtifact.Ipa, signing }), d));
    assert.equal(error.code, ExportRefusal.HarnessMayNotSign);
    assert.deepEqual(d.builds, []);
  });

  it("refuses an IPA with an Xcode older than 26 before anything is built", async () => {
    const d = deps({ xcode: async () => XCODE_25 });
    const signing: ExportSigningChoice = {
      kind: ExportSigning.IosDistribution,
      identity: `Apple Distribution: Pat (${TEAM})`,
      provisioningProfile: "/keys/Genex.mobileprovision",
    };
    const asked = runRequest({ artifact: MobileArtifact.Ipa, signing, person: true });
    const error = await refusal(exportIosGame(asked, d));
    assert.equal(error.code, ExportRefusal.ToolchainUnusable);
    assert.equal(error.refusal, "xcode-too-old");
    assert.deepEqual(d.builds, []);
  });

  it("builds the Simulator triple for a Simulator app and the device triple for an IPA; a failed build is build-failed", async () => {
    const d = deps();
    assert.equal((await refusal(exportIosGame(runRequest(), d))).code, ExportRefusal.BuildFailed);
    const signing: ExportSigningChoice = {
      kind: ExportSigning.IosDevelopment,
      identity: `Apple Development: Pat (${TEAM})`,
      provisioningProfile: "/keys/Genex.mobileprovision",
    };
    await refusal(exportIosGame(runRequest({ artifact: MobileArtifact.Ipa, signing, person: true }), d));
    assert.deepEqual(d.builds, [MobileBuild.IosSimulator, MobileBuild.IosDevice]);
  });

  it("packages the admitted Simulator build with its notices into the export folder", async () => {
    const r = await rig();
    const d = deps({
      build: async () => ({ out: r.lane.out, outputs: r.lane.outputs, buildLock: path.join(r.root, "Cargo.lock") }),
      stagingRoot: path.join(r.root, "staging"),
      exportsRoot: r.exports,
      signer: { sandbox: recordingCodesign().sandbox, forbiddenRoots: [r.game], home: r.root },
    });
    const real = { ...game, dir: r.game } as GameProject;
    const result = await exportIosGame(runRequest({ game: real, targetDir: r.target }), d);
    assert.equal(result.destination, BuildTarget.Ios);
    assert.equal(result.artifact, path.join(r.target, "Pond.app"));
    assert.ok(result.included.includes("Pond.app/game"));
    assert.ok(result.included.includes("Pond.app/notices/NOTICES.txt"));
  });

  it("admits the signed Simulator app from staging for the person's device launch; an IPA admits nothing", async () => {
    const r = await rig();
    const store = phonePackageStore(path.join(r.root, "phone-packages"));
    const staged: string[] = [];
    const d = deps({
      build: async () => ({ out: r.lane.out, outputs: r.lane.outputs, buildLock: path.join(r.root, "Cargo.lock") }),
      stagingRoot: path.join(r.root, "staging"),
      exportsRoot: r.exports,
      signer: { sandbox: recordingCodesign().sandbox, forbiddenRoots: [r.game], home: r.root },
      admitSimulatorApp: async (project, app) => {
        staged.push(app);
        await store.admit(project, BuildTarget.Ios, [DeviceKind.Simulator], app);
      },
    });
    const real = { ...game, dir: r.game } as GameProject;
    const result = await exportIosGame(runRequest({ game: real, targetDir: r.target }), d);
    assert.equal(staged.length, 1);
    assert.ok(
      staged[0]?.startsWith(path.join(r.root, "staging")),
      "admitted from the host's staging, never the exports folder",
    );
    const admitted = await store.digestOf("pond", BuildTarget.Ios, DeviceKind.Simulator);
    assert.equal(
      admitted,
      await packageDigest(result.artifact ?? "", BuildTarget.Ios),
      "the exported app is the admitted one",
    );
    assert.equal(await store.digestOf("pond", BuildTarget.Ios, DeviceKind.Phone), null, "never a phone install");
    // A failed admission fails the export and leaves the target as it was.
    const failing = deps({
      ...d,
      admitSimulatorApp: async () => {
        throw new Error("admission failed");
      },
    });
    const before = await filesUnder(r.target);
    await assert.rejects(exportIosGame(runRequest({ game: real, targetDir: r.target }), failing), /admission failed/);
    assert.deepEqual(await filesUnder(r.target), before);
  });

  it("refuses missing-notice when a crate has no licence entry, before packaging", async () => {
    const r = await rig();
    const d = deps({
      build: async () => ({ out: r.lane.out, outputs: r.lane.outputs, buildLock: "/lock" }),
      notices: async () => ({ ok: false, refusal: "crate-unlicensed", detail: "glam 0.33.12" }),
    });
    const error = await refusal(exportIosGame(runRequest({ game: { ...game, dir: r.game } as GameProject }), d));
    assert.equal(error.code, ExportRefusal.MissingNotice);
  });
});
