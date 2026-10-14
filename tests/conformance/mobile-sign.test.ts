/**
 * Mobile signing (`src/substrate/mobile-sign.ts`, M3.6): apksigner and codesign plans for phone
 * builds. Studio's own per-profile Android debug key lives in a protected folder of Genex's, never
 * `~/.android/debug.keystore`; the person's release keystore, password file and provisioning
 * profile are refused inside the games root, Genex's data or `~/.android` after realpath; the
 * harness never reaches device or distribution signing; a password travels by environment only,
 * never in argv, a log line or an error; every hostile row leaves nothing spawned and nothing
 * written; and a signed APK or app differs from the admitted copy only in its signature.
 */
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { inspect, promisify } from "node:util";
import { crc32 } from "node:zlib";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { ExportSigning, type ExportSigningChoice } from "../../src/shared/game-export-contract.ts";
import { ProcessSandbox, type RunRequest, type RunResult } from "../../src/substrate/spawn.ts";
import {
  ANDROID_KEY_PASS_ENV,
  type ApksignerRequest,
  androidDebugKeyPaths,
  apkSignatureOnlyChange,
  apksignerPlan,
  type CodesignRequest,
  codesignIosPlan,
  ensureAndroidDebugKey,
  iosBundleSignatureOnlyChange,
  MobileSignError,
  MobileSignProblem,
  machOSignatureOnlyChange,
  mobileSignRunRequest,
  mobileSignSandboxOptions,
  readBundleFiles,
  runMobileSign,
  signApk,
  signIosApp,
} from "../../src/substrate/mobile-sign.ts";
import { SigningRequester } from "../../src/substrate/windows-sign.ts";
import { macClang, macClangSkip } from "../helpers/macho.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const PASSWORD = "hunter2-correct-horse";
const IDENTITY = "Apple Development: Jane Roe (ABCDE12345)";

interface Rig {
  root: string;
  home: string;
  games: string;
  userData: string;
  staging: string;
  certs: string;
  keyHome: string;
  forbiddenRoots: string[];
}

async function rig(): Promise<Rig> {
  const root = await realpath(await tmpDir("mobile-sign-"));
  const home = path.join(root, "home");
  const games = path.join(root, "AI Games");
  const userData = path.join(root, "userData");
  const staging = path.join(userData, "signing", "export-1");
  const certs = path.join(root, "certs");
  const keyHome = path.join(userData, "signing-keys", "android-debug");
  for (const dir of [home, path.join(home, ".android"), path.join(games, "Rocks"), staging, certs]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(path.join(staging, "unsigned.apk"), unsignedApk());
  return { root, home, games, userData, staging, certs, keyHome, forbiddenRoots: [games, userData] };
}

// ---------- a minimal APK (a stored zip) and a signed copy of it ----------

const ZIP = { Local: 0x04034b50, Central: 0x02014b50, End: 0x06054b50 } as const;
const BLOCK_MAGIC = Buffer.from("APK Sig Block 42", "ascii");
const BLOCK_ID = { V2: 0x7109871a, V3: 0xf05368c0, Padding: 0x42726577, Unknown: 0x12345678 } as const;

function zip(entries: Array<{ name: string; data: Buffer }>, comment = Buffer.alloc(0)): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(ZIP.Local, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(ZIP.Central, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, entry.data);
    centrals.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP.End, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, cd, end, comment]);
}

function pair(id: number, value: Buffer): Buffer {
  const head = Buffer.alloc(12);
  head.writeBigUInt64LE(BigInt(value.length + 4), 0);
  head.writeUInt32LE(id, 8);
  return Buffer.concat([head, value]);
}

function signingBlock(ids: readonly number[]): Buffer {
  const pairs = Buffer.concat(ids.map((id) => pair(id, Buffer.alloc(40, id & 0xff))));
  const size = BigInt(pairs.length + 24);
  const head = Buffer.alloc(8);
  head.writeBigUInt64LE(size, 0);
  const foot = Buffer.alloc(8);
  foot.writeBigUInt64LE(size, 0);
  return Buffer.concat([head, pairs, foot, BLOCK_MAGIC]);
}

/** Where `apk`'s central directory starts and its end record sits. */
function zipEnd(apk: Buffer): { cdOffset: number; end: number } {
  const end = apk.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  return { cdOffset: apk.readUInt32LE(end + 16), end };
}

/** `apk` as apksigner leaves it: zero padding to a 4 KiB boundary, the signing block, the same central directory. */
function signedLike(apk: Buffer, options: { ids?: number[]; padByte?: number } = {}): Buffer {
  const { cdOffset, end } = zipEnd(apk);
  const block = signingBlock(options.ids ?? [BLOCK_ID.V2, BLOCK_ID.V3, BLOCK_ID.Padding]);
  const padding = Buffer.alloc((4096 - (cdOffset % 4096)) % 4096, options.padByte ?? 0);
  const tail = Buffer.from(apk.subarray(end));
  tail.writeUInt32LE(cdOffset + padding.length + block.length, 16);
  return Buffer.concat([apk.subarray(0, cdOffset), padding, block, apk.subarray(cdOffset, end), tail]);
}

const unsignedApk = (): Buffer =>
  zip([
    { name: "AndroidManifest.xml", data: Buffer.from("<manifest/>") },
    { name: "lib/arm64-v8a/libmain.so", data: Buffer.alloc(5000, 7) },
    { name: "classes.dex", data: Buffer.from("dex\n035") },
  ]);

// ---------- a minimal linker-signed Mach-O and a re-signed copy ----------

const LC = { Segment64: 0x19, CodeSignature: 0x1d } as const;
const EMBEDDED_SIGNATURE = 0xfade0cc0;

function machOSigned(options: { textByte?: number; signatureBytes?: number; vmsize?: bigint } = {}): Buffer {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x0100000c, 4);
  header.writeUInt32LE(2, 12);
  header.writeUInt32LE(2, 16);
  header.writeUInt32LE(72 + 16, 20);
  const text = Buffer.alloc(4000, options.textByte ?? 0x11);
  const dataoff = 32 + 72 + 16 + text.length;
  const signature = Buffer.alloc(options.signatureBytes ?? 272, 0x5a);
  signature.writeUInt32BE(EMBEDDED_SIGNATURE, 0);
  const linkedit = Buffer.alloc(72);
  linkedit.writeUInt32LE(LC.Segment64, 0);
  linkedit.writeUInt32LE(72, 4);
  linkedit.write("__LINKEDIT", 8, "ascii");
  linkedit.writeBigUInt64LE(options.vmsize ?? 16384n, 32);
  linkedit.writeBigUInt64LE(BigInt(dataoff), 40);
  linkedit.writeBigUInt64LE(BigInt(signature.length), 48);
  const codeSignature = Buffer.alloc(16);
  codeSignature.writeUInt32LE(LC.CodeSignature, 0);
  codeSignature.writeUInt32LE(16, 4);
  codeSignature.writeUInt32LE(dataoff, 8);
  codeSignature.writeUInt32LE(signature.length, 12);
  return Buffer.concat([header, linkedit, codeSignature, text, signature]);
}

// ---------- fakes ----------

/** A sandbox that records every request and answers `answer`. */
function recordingSandbox(answer: Partial<RunResult> = {}, onRun?: (request: RunRequest) => Promise<void>) {
  const runs: RunRequest[] = [];
  return {
    runs,
    async run(request: RunRequest): Promise<RunResult> {
      runs.push(request);
      await onRun?.(request);
      return {
        code: 0,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: 1,
        timedOut: false,
        truncated: false,
        sandboxed: true,
        command: request.command,
        cwd: request.cwd,
        ...answer,
      };
    },
  };
}

async function listing(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).sort();
}

const exists = (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false,
  );

/** A Studio debug key already made: the folder, its password file and a keystore file. */
async function madeDebugKey(r: Rig): Promise<void> {
  const key = androidDebugKeyPaths(r.keyHome);
  await mkdir(r.keyHome, { recursive: true, mode: 0o700 });
  await writeFile(key.passwordFile, "studio-debug-pass\n", { mode: 0o600 });
  await writeFile(key.keystore, "fixture keystore");
}

async function apkRequest(r: Rig, choice: ExportSigningChoice, overrides: Partial<ApksignerRequest> = {}) {
  const input = path.join(r.staging, "unsigned.apk");
  return {
    choice,
    requestedBy: SigningRequester.Person,
    host: StudioPlatform.Mac,
    tool: { file: "/opt/build-tools/apksigner", args: [] },
    stagingDir: r.staging,
    input,
    output: path.join(r.staging, "signed.apk"),
    debugKey: androidDebugKeyPaths(r.keyHome),
    forbiddenRoots: r.forbiddenRoots,
    home: r.home,
    env: { GENEX_TEST_RELEASE_PASS: PASSWORD },
    ...overrides,
  } satisfies ApksignerRequest;
}

const release = (keystore: string, password: { env: string } | { file: string } = { env: "GENEX_TEST_RELEASE_PASS" }) =>
  ({ kind: ExportSigning.AndroidRelease, keystore, alias: "upload", password }) as const;

async function refusal(promise: Promise<unknown>): Promise<MobileSignError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof MobileSignError, `expected a MobileSignError, got ${inspect(error)}`);
  return error;
}

// ---------- hostile keystores, password files and requests ----------

describe("hostile keystores, password files and callers are refused before anything runs or is written", () => {
  it("a release keystore inside the games root, linked into Genex data, or in ~/.android is refused", async () => {
    const r = await rig();
    const genuine = path.join(r.certs, "release.p12");
    await writeFile(genuine, "keystore");
    const inGames = path.join(r.games, "Rocks", "release.p12");
    await writeFile(inGames, "agent-written keystore");
    const genexSecret = path.join(r.userData, "secrets", "studio.p12");
    await mkdir(path.dirname(genexSecret), { recursive: true });
    await writeFile(genexSecret, "genex's own");
    const linkIntoGenex = path.join(r.certs, "linked.p12");
    await symlink(genexSecret, linkIntoGenex);
    const androidDebug = path.join(r.home, ".android", "debug.keystore");
    await writeFile(androidDebug, "the person's SDK debug key");
    const linkToAndroid = path.join(r.certs, "debug-link.keystore");
    await symlink(androidDebug, linkToAndroid);
    const aFolder = path.join(r.certs, "folder.p12");
    await mkdir(aFolder);
    const rows: Array<[string, string, MobileSignProblem]> = [
      ["inside the games root", inGames, MobileSignProblem.KeystoreForbidden],
      ["a link into Genex's data", linkIntoGenex, MobileSignProblem.KeystoreForbidden],
      ["the person's ~/.android/debug.keystore", androidDebug, MobileSignProblem.KeystoreForbidden],
      ["a link to ~/.android/debug.keystore", linkToAndroid, MobileSignProblem.KeystoreForbidden],
      ["missing", path.join(r.certs, "missing.p12"), MobileSignProblem.Keystore],
      ["a folder", aFolder, MobileSignProblem.Keystore],
      ["relative", "certs/release.p12", MobileSignProblem.Keystore],
    ];
    const before = await listing(r.root);
    const sandbox = recordingSandbox();
    for (const [label, keystore, code] of rows) {
      const error = await refusal(signApk(sandbox, await apkRequest(r, release(keystore))));
      assert.equal(error.code, code, label);
    }
    // The genuine keystore passes the same checks.
    const plan = await apksignerPlan(await apkRequest(r, release(genuine)));
    assert.ok(plan.args.includes(genuine));
    assert.equal(sandbox.runs.length, 0);
    assert.deepEqual(await listing(r.root), before);
  });

  it("a password file inside the games root or linked into Genex data, empty or missing, is refused", async () => {
    const r = await rig();
    const keystore = path.join(r.certs, "release.p12");
    await writeFile(keystore, "keystore");
    const inGames = path.join(r.games, "Rocks", "pass.txt");
    await writeFile(inGames, `${PASSWORD}\n`);
    const genexFile = path.join(r.userData, "pass.txt");
    await writeFile(genexFile, `${PASSWORD}\n`);
    const linked = path.join(r.certs, "pass-link.txt");
    await symlink(genexFile, linked);
    const empty = path.join(r.certs, "empty.txt");
    await writeFile(empty, "\n");
    const huge = path.join(r.certs, "huge.txt");
    await writeFile(huge, "x".repeat(64 * 1024));
    const rows: Array<[string, { env: string } | { file: string }, MobileSignProblem]> = [
      ["a file in the games root", { file: inGames }, MobileSignProblem.PasswordFileForbidden],
      ["a link into Genex's data", { file: linked }, MobileSignProblem.PasswordFileForbidden],
      ["an empty file", { file: empty }, MobileSignProblem.Password],
      ["a file too large to be a password", { file: huge }, MobileSignProblem.Password],
      ["a missing file", { file: path.join(r.certs, "nope.txt") }, MobileSignProblem.Password],
      ["an unset variable", { env: "GENEX_TEST_UNSET_PASS" }, MobileSignProblem.Password],
    ];
    const sandbox = recordingSandbox();
    for (const [label, password, code] of rows) {
      const error = await refusal(signApk(sandbox, await apkRequest(r, release(keystore, password))));
      assert.equal(error.code, code, label);
      assert.ok(!error.message.includes(PASSWORD), label);
    }
    assert.equal(sandbox.runs.length, 0);
  });

  it("the harness never reaches release, device or distribution signing, even with a hostile path", async () => {
    const r = await rig();
    const harness = { requestedBy: SigningRequester.Harness };
    const sandbox = recordingSandbox();
    const apk = await refusal(signApk(sandbox, await apkRequest(r, release(path.join(r.games, "x.p12")), harness)));
    assert.equal(apk.code, MobileSignProblem.HarnessMayNotSign);
    for (const kind of [ExportSigning.IosDevelopment, ExportSigning.IosDistribution] as const) {
      const choice = { kind, identity: IDENTITY, provisioningProfile: path.join(r.games, "x.mobileprovision") };
      const ios = await refusal(signIosApp(sandbox, iosRequest(r, choice, harness)));
      assert.equal(ios.code, MobileSignProblem.HarnessMayNotSign, kind);
    }
    assert.equal(sandbox.runs.length, 0);
  });
});

describe("hostile debug keys, staged files and hosts are refused before anything runs", () => {
  it("Studio's debug key is never ~/.android's and never through a link; a debug build needs the key made first", async () => {
    const r = await rig();
    const debug = { kind: ExportSigning.AndroidDebug } as const;
    const sandbox = recordingSandbox();
    const missing = await refusal(signApk(sandbox, await apkRequest(r, debug)));
    assert.equal(missing.code, MobileSignProblem.DebugKeyMissing);
    // A key folder inside ~/.android.
    const inAndroid = await refusal(
      signApk(sandbox, await apkRequest(r, debug, { debugKey: androidDebugKeyPaths(path.join(r.home, ".android")) })),
    );
    assert.equal(inAndroid.code, MobileSignProblem.DebugKeyHome);
    // A key whose keystore is a link to the person's SDK debug key.
    await madeDebugKey(r);
    const key = androidDebugKeyPaths(r.keyHome);
    const androidDebug = path.join(r.home, ".android", "debug.keystore");
    await writeFile(androidDebug, "the person's SDK debug key");
    await rm(key.keystore);
    await symlink(androidDebug, key.keystore);
    const linked = await refusal(signApk(sandbox, await apkRequest(r, debug)));
    assert.equal(linked.code, MobileSignProblem.DebugKeyHome);
    // A key folder that is itself a link.
    const elsewhere = path.join(r.root, "elsewhere");
    await mkdir(elsewhere);
    const linkedHome = path.join(r.userData, "signing-keys", "linked");
    await symlink(elsewhere, linkedHome);
    const home = await refusal(
      signApk(sandbox, await apkRequest(r, debug, { debugKey: androidDebugKeyPaths(linkedHome) })),
    );
    assert.equal(home.code, MobileSignProblem.DebugKeyHome);
    assert.equal(sandbox.runs.length, 0);
  });

  it("an input outside staging, a linked input, an existing or outside output, and a relative tool are refused", async () => {
    const r = await rig();
    await madeDebugKey(r);
    const debug = { kind: ExportSigning.AndroidDebug } as const;
    const outside = path.join(r.games, "Rocks", "game.apk");
    await writeFile(outside, unsignedApk());
    const linkedInput = path.join(r.staging, "linked.apk");
    await symlink(outside, linkedInput);
    const existing = path.join(r.staging, "already.apk");
    await writeFile(existing, "x");
    const rows: Array<[string, Partial<ApksignerRequest>, MobileSignProblem]> = [
      ["input outside staging", { input: outside }, MobileSignProblem.Target],
      ["a linked input", { input: linkedInput }, MobileSignProblem.Target],
      ["an output that exists", { output: existing }, MobileSignProblem.Target],
      ["an output outside staging", { output: path.join(r.games, "Rocks", "out.apk") }, MobileSignProblem.Target],
      ["an output that is not an APK", { output: path.join(r.staging, "out.zip") }, MobileSignProblem.Target],
      ["a relative tool", { tool: { file: "apksigner", args: [] } }, MobileSignProblem.Tool],
    ];
    const before = await listing(r.root);
    const sandbox = recordingSandbox();
    for (const [label, overrides, code] of rows) {
      const error = await refusal(signApk(sandbox, await apkRequest(r, debug, overrides)));
      assert.equal(error.code, code, label);
    }
    assert.equal(sandbox.runs.length, 0);
    assert.deepEqual(await listing(r.root), before);
  });

  it("a release password is refused while Genex runs on Windows; Studio's debug key is not", async () => {
    const r = await rig();
    await madeDebugKey(r);
    const keystore = path.join(r.certs, "release.p12");
    await writeFile(keystore, "keystore");
    const windows = { host: StudioPlatform.Windows };
    const error = await refusal(apksignerPlan(await apkRequest(r, release(keystore), windows)));
    assert.equal(error.code, MobileSignProblem.WindowsHostPassword);
    const debug = await apksignerPlan(await apkRequest(r, { kind: ExportSigning.AndroidDebug }, windows));
    assert.ok(debug.args.includes(androidDebugKeyPaths(r.keyHome).keystore));
  });
});

// ---------- passwords never in argv, logs or errors ----------

function iosRequest(r: Rig, choice: ExportSigningChoice, overrides: Partial<CodesignRequest> = {}): CodesignRequest {
  return {
    choice,
    requestedBy: SigningRequester.Person,
    tool: { file: "/usr/bin/codesign", args: [] },
    stagingDir: r.staging,
    app: path.join(r.staging, "Toy.app"),
    entitlements: null,
    forbiddenRoots: r.forbiddenRoots,
    home: r.home,
    ...overrides,
  };
}

describe("a signing password never reaches argv, the log line, an error or the output", () => {
  it("apksigner reads the release password by an env reference; argv and the log line never hold it", async () => {
    const r = await rig();
    const keystore = path.join(r.certs, "release.p12");
    await writeFile(keystore, "keystore");
    const passFile = path.join(r.certs, "pass.txt");
    await writeFile(passFile, `${PASSWORD}\nsecond line ignored\n`);
    for (const password of [{ env: "GENEX_TEST_RELEASE_PASS" }, { file: passFile }]) {
      const plan = await apksignerPlan(await apkRequest(r, release(keystore, password)));
      assert.deepEqual(plan.env, { [ANDROID_KEY_PASS_ENV]: PASSWORD });
      assert.deepEqual(plan.secretValues, [PASSWORD]);
      assert.ok(plan.args.includes(`env:${ANDROID_KEY_PASS_ENV}`));
      assert.ok(plan.args.join(" ").includes("--alignment-preserved"));
      assert.ok(!plan.args.some((arg) => arg.includes(PASSWORD)));
      assert.ok(!plan.display.includes(PASSWORD));
      const run = mobileSignRunRequest(plan);
      assert.ok(!run.request.command.includes(PASSWORD));
      assert.deepEqual(run.request.policy?.allowedDomains, []);
      assert.deepEqual(run.request.policy?.allowWrite, [r.staging]);
    }
  });

  it("what the signer prints is redacted, and a failed signing's error never holds the password", async () => {
    const r = await rig();
    const keystore = path.join(r.certs, "release.p12");
    await writeFile(keystore, "keystore");
    const plan = await apksignerPlan(await apkRequest(r, release(keystore)));
    const echoing = recordingSandbox({ stdout: `using ${PASSWORD}`, stderr: `bad password ${PASSWORD}` });
    const result = await runMobileSign(echoing, mobileSignRunRequest(plan));
    assert.ok(!result.stdout.includes(PASSWORD) && !result.stderr.includes(PASSWORD));
    assert.match(result.stderr, /\[redacted\]/);
    const failing = recordingSandbox({ code: 1, stderr: `keystore password was incorrect: ${PASSWORD}` });
    const error = await refusal(signApk(failing, await apkRequest(r, release(keystore))));
    assert.equal(error.code, MobileSignProblem.SignerFailed);
    assert.ok(!inspect(error, { depth: 5 }).includes(PASSWORD));
    assert.match(error.output, /\[redacted\]/);
    assert.equal(await exists(path.join(r.staging, "signed.apk")), false);
  });
});

// ---------- what a signature may change ----------

describe("a signed APK differs from the admitted copy only in its signing block", () => {
  it("apksigner's shape (zero padding, a v2/v3 block, the same central directory) passes", () => {
    const apk = unsignedApk();
    assert.equal(apkSignatureOnlyChange(apk, signedLike(apk)), true);
    assert.equal(apkSignatureOnlyChange(apk, signedLike(apk, { ids: [BLOCK_ID.V3] })), true);
    const commented = zip([{ name: "a", data: Buffer.from("b") }], Buffer.from("zip comment"));
    assert.equal(apkSignatureOnlyChange(commented, signedLike(commented)), true);
  });

  it("any other change fails", () => {
    const apk = unsignedApk();
    const signed = signedLike(apk);
    const { cdOffset, end } = zipEnd(signed);
    const flipped = (at: number) => {
      const copy = Buffer.from(signed);
      copy[at] ^= 0xff;
      return copy;
    };
    const rows: Array<[string, Buffer, Buffer]> = [
      ["unsigned", apk, apk],
      ["an entry's byte changed", apk, flipped(40)],
      ["a central directory byte changed", apk, flipped(cdOffset + 20)],
      ["the end record's entry count changed", apk, flipped(end + 8)],
      ["bytes appended", apk, Buffer.concat([signed, Buffer.from("x")])],
      ["non-zero padding", apk, signedLike(apk, { padByte: 1 })],
      ["only verity padding, no signature scheme", apk, signedLike(apk, { ids: [BLOCK_ID.Padding] })],
      ["an unknown block entry", apk, signedLike(apk, { ids: [BLOCK_ID.V2, BLOCK_ID.Unknown] })],
      ["the admitted copy was already signed", signed, signedLike(signed)],
      ["an entry added", apk, signedLike(zip([{ name: "extra", data: Buffer.from("x") }]))],
      ["not a zip", Buffer.from("nope"), Buffer.from("nope either")],
      ["truncated", apk, signed.subarray(0, signed.length - 30)],
    ];
    for (const [label, original, after] of rows) assert.equal(apkSignatureOnlyChange(original, after), false, label);
  });

  it("signApk refuses an output that changed more than the signature, and removes it", async () => {
    const r = await rig();
    await madeDebugKey(r);
    const tampering = recordingSandbox({}, async () => {
      const apk = await readFile(path.join(r.staging, "unsigned.apk"));
      const signed = signedLike(apk);
      signed[40] ^= 0xff;
      await writeFile(path.join(r.staging, "signed.apk"), signed);
    });
    const error = await refusal(signApk(tampering, await apkRequest(r, { kind: ExportSigning.AndroidDebug })));
    assert.equal(error.code, MobileSignProblem.SignatureChanged);
    assert.equal(await exists(path.join(r.staging, "signed.apk")), false);
    const honest = recordingSandbox({}, async () => {
      const apk = await readFile(path.join(r.staging, "unsigned.apk"));
      await writeFile(path.join(r.staging, "signed.apk"), signedLike(apk));
    });
    const signed = await signApk(honest, await apkRequest(r, { kind: ExportSigning.AndroidDebug }));
    assert.equal(signed.output, path.join(r.staging, "signed.apk"));
    assert.equal(honest.runs.length, 1);
  });
});

describe("a signed iOS app differs from the admitted copy only in its signatures", () => {
  it("a Mach-O whose code signature and __LINKEDIT grew passes; any other change fails", () => {
    const original = machOSigned();
    assert.equal(machOSignatureOnlyChange(original, machOSigned({ signatureBytes: 18320, vmsize: 32768n })), true);
    const changedCode = machOSigned({ textByte: 0x12, signatureBytes: 18320 });
    const rows: Array<[string, Buffer]> = [
      ["code changed", changedCode],
      ["identical (nothing signed)", original],
      ["appended after the signature", Buffer.concat([machOSigned({ signatureBytes: 300 }), Buffer.alloc(8)])],
      ["not a Mach-O", Buffer.from("nope")],
      ["truncated", machOSigned({ signatureBytes: 300 }).subarray(0, 100)],
    ];
    for (const [label, after] of rows) {
      const expected = label === "identical (nothing signed)";
      assert.equal(machOSignatureOnlyChange(original, after), expected, label);
    }
  });

  it("a bundle may gain only _CodeSignature/CodeResources; every other file stays or changes only its signature", () => {
    const original = new Map([
      ["Toy", machOSigned()],
      ["Info.plist", Buffer.from("<plist/>")],
      ["embedded.mobileprovision", Buffer.from("profile")],
    ]);
    const signed = new Map([
      ["Toy", machOSigned({ signatureBytes: 9000 })],
      ["Info.plist", Buffer.from("<plist/>")],
      ["embedded.mobileprovision", Buffer.from("profile")],
      ["_CodeSignature/CodeResources", Buffer.from("<plist/>")],
    ]);
    assert.equal(iosBundleSignatureOnlyChange(original, signed), true);
    const rows: Array<[string, Map<string, Buffer>]> = [
      ["a file added", new Map([...signed, ["Frameworks/evil.dylib", Buffer.from("x")]])],
      ["Info.plist changed", new Map([...signed, ["Info.plist", Buffer.from("<plist>changed</plist>")]])],
      ["a file removed", new Map([...signed].filter(([name]) => name !== "embedded.mobileprovision"))],
      ["the executable's code changed", new Map([...signed, ["Toy", machOSigned({ textByte: 0x22 })]])],
    ];
    for (const [label, after] of rows) assert.equal(iosBundleSignatureOnlyChange(original, after), false, label);
  });

  it("a bundle with a link in it is refused before signing", async () => {
    const r = await rig();
    const app = path.join(r.staging, "Toy.app");
    await mkdir(app);
    await writeFile(path.join(app, "Toy"), machOSigned());
    await symlink(path.join(r.userData), path.join(app, "escape"));
    const sandbox = recordingSandbox();
    const error = await refusal(signIosApp(sandbox, iosRequest(r, { kind: ExportSigning.AdHoc })));
    assert.equal(error.code, MobileSignProblem.Target);
    assert.equal(sandbox.runs.length, 0);
    await refusal(readBundleFiles(app));
  });

  it("a provisioning profile inside the games root or Genex data is refused; a genuine one is embedded", async () => {
    const r = await rig();
    const app = path.join(r.staging, "Toy.app");
    await mkdir(app);
    await writeFile(path.join(app, "Toy"), machOSigned());
    const inGames = path.join(r.games, "Rocks", "dev.mobileprovision");
    await writeFile(inGames, "profile");
    const genuine = path.join(r.certs, "dev.mobileprovision");
    await writeFile(genuine, "genuine profile");
    const sandbox = recordingSandbox();
    const choice = (provisioningProfile: string) =>
      ({ kind: ExportSigning.IosDevelopment, identity: IDENTITY, provisioningProfile }) as const;
    const error = await refusal(signIosApp(sandbox, iosRequest(r, choice(inGames))));
    assert.equal(error.code, MobileSignProblem.ProvisioningProfileForbidden);
    assert.equal(await exists(path.join(app, "embedded.mobileprovision")), false);
    assert.equal(sandbox.runs.length, 0);
    const plan = await codesignIosPlan(iosRequest(r, choice(genuine)));
    assert.deepEqual(plan.args.slice(0, 4), ["--force", "--sign", IDENTITY, "--timestamp=none"]);
    assert.equal(plan.args.at(-1), await realpath(app));
    assert.equal(plan.provisioningProfile, genuine);
    assert.deepEqual(plan.allowedDomains, []);
  });
});

// ---------- the debug key and the signer's own sandbox ----------

describe("Studio's per-profile Android debug key", () => {
  it("is made once in its own folder by keytool in a sandbox writing only there, its password private", async () => {
    const r = await rig();
    const key = androidDebugKeyPaths(r.keyHome);
    const sandbox = recordingSandbox({}, async (request) => {
      await writeFile(key.keystore, "made by keytool");
      assert.deepEqual(request.policy?.allowWrite, [await realpath(r.keyHome)]);
      assert.ok(request.env && Object.values(request.env).length === 1);
      assert.ok(!request.command.includes(Object.values(request.env)[0]));
    });
    const tool = { file: "/opt/jdk/bin/keytool", args: [] };
    await ensureAndroidDebugKey(sandbox, { key, tool, home: r.home });
    assert.equal(sandbox.runs.length, 1);
    if (process.platform !== "win32") {
      assert.equal((await stat(r.keyHome)).mode & 0o777, 0o700);
      assert.equal((await stat(key.passwordFile)).mode & 0o777, 0o600);
    }
    await ensureAndroidDebugKey(sandbox, { key, tool, home: r.home });
    assert.equal(sandbox.runs.length, 1, "an existing key is kept");
    const intoAndroid = await refusal(
      ensureAndroidDebugKey(sandbox, {
        key: androidDebugKeyPaths(path.join(r.home, ".android", "genex")),
        tool,
        home: r.home,
      }),
    );
    assert.equal(intoAndroid.code, MobileSignProblem.DebugKeyHome);
    assert.equal(await exists(path.join(r.home, ".android", "genex")), false);
  });

  it("the signer's sandbox writes only its staging and reads the key folder no other process may", () => {
    const secrets = ["/u/secrets", "/u/signing-keys/android-debug", "/home/.genex"];
    const options = mobileSignSandboxOptions({
      staging: "/u/signing/export-1",
      scratch: "/u/signing/scratch-1",
      secretPaths: secrets,
      denyWrite: ["/u/signing", "/games"],
      keyHome: "/u/signing-keys/android-debug",
    });
    assert.deepEqual(options.writableRoots, ["/u/signing/export-1"]);
    assert.deepEqual(options.secretPaths, ["/u/secrets", "/home/.genex"]);
    assert.deepEqual(options.denyWrite, ["/games"]);
    const release = mobileSignSandboxOptions({
      staging: "/u/signing/export-1",
      scratch: "/u/signing/scratch-1",
      secretPaths: secrets,
      denyWrite: [],
    });
    assert.deepEqual(release.secretPaths, secrets, "a release signer never reads Studio's debug key");
    assert.throws(
      () =>
        mobileSignSandboxOptions({
          staging: "/u/s",
          scratch: "/u/t",
          secretPaths: ["/u"],
          denyWrite: [],
          keyHome: "/u/signing-keys/android-debug",
        }),
      /key folder/,
    );
  });
});

// ---------- real tools, where this machine has them ----------

const CODESIGN = "/usr/bin/codesign";

function iosSimSkip(): string | false {
  const clang = macClangSkip();
  if (clang) return clang;
  const sdk = spawnSync("/usr/bin/xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"], { encoding: "utf8" });
  return sdk.status === 0 && existsSync(CODESIGN) ? false : "not run: no iOS Simulator SDK";
}

it("real codesign in its own sandbox ad hoc signs a Simulator app and changes only its signature", {
  skip: iosSimSkip(),
}, async () => {
  const r = await rig();
  const app = path.join(r.staging, "Toy.app");
  await mkdir(app);
  const source = path.join(r.root, "m.c");
  await writeFile(source, "int main(void){return 0;}\n");
  const sdk = spawnSync("/usr/bin/xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"], { encoding: "utf8" });
  await macClang([
    "-isysroot",
    sdk.stdout.trim(),
    "-target",
    "arm64-apple-ios17.0-simulator",
    "-o",
    path.join(app, "Toy"),
    source,
  ]);
  await writeFile(
    path.join(app, "Info.plist"),
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Toy</string><key>CFBundleIdentifier</key><string>dev.genex.toy</string></dict></plist>',
  );
  const sandbox = await ProcessSandbox.create(
    mobileSignSandboxOptions({
      staging: r.staging,
      scratch: path.join(r.root, "scratch"),
      secretPaths: [path.join(r.userData, "secrets")],
      denyWrite: [r.games],
    }),
  );
  try {
    const signed = await signIosApp(
      sandbox,
      iosRequest(r, { kind: ExportSigning.AdHoc }, { tool: { file: CODESIGN, args: [] } }),
    );
    assert.ok(signed.files.includes("_CodeSignature/CodeResources"));
  } finally {
    await sandbox.dispose();
  }
});

/**
 * apksigner and keytool from the Android SDK `ANDROID_HOME` names (opt-in: never a default path)
 * and the Mac's JDK, or why the row is skipped.
 */
function androidTools(): { apksigner: string; keytool: string } | string {
  // The JDK is found through the Mac's java_home, which another host (the Linux runner) lacks.
  if (process.platform !== "darwin") return "not run: the JDK lookup is the Mac's java_home";
  const sdk = process.env.ANDROID_HOME;
  if (!sdk) return "not run: ANDROID_HOME names no Android SDK";
  const buildTools = path.join(sdk, "build-tools");
  if (!existsSync(buildTools)) return "not run: no Android SDK build-tools";
  const versions = (spawnSync("/bin/ls", [buildTools], { encoding: "utf8" }).stdout ?? "").trim().split("\n").sort();
  const apksigner = path.join(buildTools, versions.at(-1) ?? "", "apksigner");
  const javaHome = spawnSync("/usr/libexec/java_home", [], { encoding: "utf8" });
  const keytool = path.join((javaHome.stdout ?? "").trim(), "bin", "keytool");
  const found = existsSync(apksigner) && javaHome.status === 0 && existsSync(keytool);
  return found ? { apksigner, keytool } : "not run: no apksigner or JDK";
}

const tools = androidTools();

it("real keytool and apksigner, each in its own sandbox, make Studio's key and change only the signature", {
  skip: typeof tools === "string" ? tools : false,
}, async () => {
  if (typeof tools === "string") return;
  const r = await rig();
  const key = androidDebugKeyPaths(r.keyHome);
  const javaHome = path.dirname(path.dirname(tools.keytool));
  const readable = [javaHome, path.dirname(tools.apksigner)];
  const make = async (staging: string, keyHome?: string) =>
    ProcessSandbox.create({
      ...mobileSignSandboxOptions({
        staging,
        scratch: path.join(r.root, `scratch-${path.basename(staging)}`),
        secretPaths: [r.keyHome, path.join(r.userData, "secrets")],
        denyWrite: [r.games],
        keyHome,
      }),
      readableRoots: readable,
    });
  await mkdir(r.keyHome, { recursive: true, mode: 0o700 });
  const keygen = await make(await realpath(r.keyHome), r.keyHome);
  try {
    await ensureAndroidDebugKey(keygen, { key, tool: { file: tools.keytool, args: [] }, home: r.home });
  } finally {
    await keygen.dispose();
  }
  assert.equal((await stat(key.keystore)).isFile(), true);
  await chmod(key.keystore, 0o600);
  const signer = await make(r.staging, r.keyHome);
  try {
    const request = await apkRequest(
      r,
      { kind: ExportSigning.AndroidDebug },
      {
        tool: { file: tools.apksigner, args: [] },
        toolEnv: { JAVA_HOME: javaHome },
      },
    );
    const signed = await signApk(signer, request);
    assert.equal(apkSignatureOnlyChange(await readFile(request.input), await readFile(signed.output)), true);
    const verify = await execFileAsync(tools.apksigner, ["verify", "--min-sdk-version", "29", signed.output]);
    assert.equal(typeof verify.stdout, "string");
  } finally {
    await signer.dispose();
  }
});
