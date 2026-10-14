/**
 * The optional Windows signing argv (`src/substrate/windows-sign.ts`, D20 = A): `jsign` with the
 * person's own certificate only when they chose to sign, never for the harness, never Genex's
 * certificate; the keystore password travels by environment reference, never in argv, the log
 * line or an error; and every hostile field is refused before any argv exists, with nothing
 * written. The module only builds argv: nothing here runs jsign.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { inspect, promisify } from "node:util";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { JsignStoreType, TIMESTAMP_AUTHORITIES } from "../../src/shared/game-export-contract.ts";
import {
  mergeOverlay,
  ProcessSandbox,
  shellQuote,
  type RunRequest,
  type RunResult,
} from "../../src/substrate/spawn.ts";
import {
  JSIGN_STOREPASS_ENV,
  type JsignRequest,
  jsignPlan,
  jsignPreflight,
  jsignRunRequest,
  jsignSandboxOptions,
  type OwnCertificateChoice,
  runJsign,
  SigningRequester,
  signatureOnlyChange,
  WindowsSignError,
  WindowsSignProblem,
  WindowsSigningKind,
  windowsSignTargets,
} from "../../src/substrate/windows-sign.ts";
import { writePe } from "../helpers/pe.ts";
import { tmpDir } from "../helpers/tmp.ts";

const run = promisify(execFile);
const POSIX = process.platform !== "win32";
const PASSWORD = "hunter2-correct-horse";

interface Rig {
  root: string;
  keystore: string;
  staging: string;
  games: string;
  userData: string;
  targets: string[];
}

async function rig(): Promise<Rig> {
  const root = await realpath(await tmpDir("windows-sign-"));
  const certs = path.join(root, "certs");
  const staging = path.join(root, "staging", "Space Rocks");
  const games = path.join(root, "AI Games");
  const userData = path.join(root, "userData");
  for (const dir of [certs, staging, games, userData]) await mkdir(dir, { recursive: true });
  const keystore = path.join(certs, "me.p12");
  await writeFile(keystore, "not really pkcs12");
  const targets = windowsSignTargets(staging, "Space Rocks.exe");
  for (const file of targets) await writeFile(file, "MZ");
  await writeFile(path.join(staging, "d3dcompiler_47.dll"), "MZ microsoft");
  return { root, keystore, staging, games, userData, targets };
}

function request(r: Rig, choice: Partial<OwnCertificateChoice> = {}, rest: Partial<JsignRequest> = {}): JsignRequest {
  return {
    choice: {
      kind: WindowsSigningKind.OwnCertificate,
      storeType: JsignStoreType.Pkcs12,
      keystore: r.keystore,
      alias: "my-key",
      timestampUrl: TIMESTAMP_AUTHORITIES[0],
      password: PASSWORD,
      ...choice,
    },
    requestedBy: SigningRequester.Person,
    host: StudioPlatform.Mac,
    tool: { file: "/opt/jsign/bin/jsign", args: [] },
    programName: "Space Rocks",
    stagingDir: r.staging,
    targets: r.targets,
    forbiddenRoots: [r.games, r.userData],
    ...rest,
  };
}

async function refusedWith(plan: Promise<unknown>, code: WindowsSignProblem, label: string): Promise<void> {
  await assert.rejects(
    plan,
    (error: unknown) => {
      assert.ok(error instanceof WindowsSignError, label);
      assert.equal(error.code, code, label);
      assert.ok(!inspect(error).includes(PASSWORD), `${label}: the password reached the error`);
      return true;
    },
    label,
  );
}

describe("whether jsign runs at all", () => {
  it("builds nothing for an unsigned export, the default", async () => {
    const r = await rig();
    assert.equal(await jsignPlan({ ...request(r), choice: { kind: WindowsSigningKind.Unsigned } }), null);
  });

  it("refuses the harness asking to sign, before reading anything", async () => {
    const r = await rig();
    const asked = request(r, { keystore: "/nonexistent/x.p12" }, { requestedBy: SigningRequester.Harness });
    await refusedWith(jsignPlan(asked), WindowsSignProblem.HarnessMayNotSign, "harness");
  });
});

describe("the argv for the person's own certificate", () => {
  it("names the store, alias, RFC 3161 timestamp, program name and the exe and ANGLE DLLs", async () => {
    const r = await rig();
    const plan = await jsignPlan(request(r));
    assert.ok(plan);
    assert.equal(plan.file, "/opt/jsign/bin/jsign");
    assert.deepEqual(plan.args, [
      "--storetype",
      "PKCS12",
      "--keystore",
      r.keystore,
      "--alias",
      "my-key",
      "--storepass",
      `env:${JSIGN_STOREPASS_ENV}`,
      "--alg",
      "SHA-256",
      "--tsaurl",
      "http://timestamp.sectigo.com",
      "--tsmode",
      "RFC3161",
      "--name",
      "Space Rocks",
      ...r.targets,
    ]);
    assert.deepEqual(
      r.targets.map((file) => path.basename(file)),
      ["Space Rocks.exe", "libEGL.dll", "libGLESv2.dll"],
    );
  });

  it("keeps the password out of argv and the log line, passing it only by environment", async () => {
    const r = await rig();
    const plan = await jsignPlan(request(r));
    assert.ok(plan);
    assert.ok(!JSON.stringify(plan.args).includes(PASSWORD));
    assert.ok(!plan.display.includes(PASSWORD));
    assert.deepEqual(plan.env, { [JSIGN_STOREPASS_ENV]: PASSWORD });
    assert.deepEqual(plan.secretValues, [PASSWORD]);
  });

  it("passes no password flag and no environment for a token that asks for its PIN itself", async () => {
    const r = await rig();
    const plan = await jsignPlan(request(r, { storeType: JsignStoreType.Yubikey, keystore: null, password: null }));
    assert.ok(plan);
    assert.ok(!plan.args.includes("--storepass"));
    assert.ok(!plan.args.includes("--keystore"));
    assert.deepEqual(plan.env, {});
    assert.deepEqual(plan.secretValues, []);
  });

  it("runs jsign from a jar through the given launcher prefix, proxy properties first", async () => {
    const r = await rig();
    const proxy = ["-Dhttp.proxyHost=127.0.0.1", "-Dhttp.proxyPort=8080"];
    const tool = { file: "/usr/bin/java", args: [...proxy, "-jar", "/opt/jsign/jsign-7.4.jar"] };
    const plan = await jsignPlan(request(r, {}, { tool }));
    assert.ok(plan);
    assert.equal(plan.file, "/usr/bin/java");
    assert.deepEqual(plan.args.slice(0, 5), [...proxy, "-jar", "/opt/jsign/jsign-7.4.jar", "--storetype"]);
  });
});

describe("what the sandboxed jsign run needs", () => {
  it("lets the sandboxed run reach only the chosen timestamp server", async () => {
    const r = await rig();
    for (const timestampUrl of TIMESTAMP_AUTHORITIES) {
      const plan = await jsignPlan(request(r, { timestampUrl }));
      assert.ok(plan);
      assert.deepEqual(plan.allowedDomains, [new URL(timestampUrl).host]);
    }
    const sectigo = await jsignPlan(request(r));
    assert.deepEqual(sectigo?.allowedDomains, ["timestamp.sectigo.com"]);
  });

  it("says when the key is on hardware, so the run needs smart-card access", async () => {
    const r = await rig();
    const file = await jsignPlan(request(r));
    const token = await jsignPlan(request(r, { storeType: JsignStoreType.Yubikey, keystore: null, password: null }));
    const hsm = await jsignPlan(request(r, { storeType: JsignStoreType.Pkcs11 }));
    assert.equal(file?.hardwareToken, false);
    assert.equal(token?.hardwareToken, true);
    assert.equal(hsm?.hardwareToken, true);
  });

  it("uses the keystore's real path, so the file checked is the file signed with", { skip: !POSIX }, async () => {
    const r = await rig();
    const link = path.join(r.root, "link.p12");
    await symlink(r.keystore, link);
    const plan = await jsignPlan(request(r, { keystore: link }));
    assert.ok(plan);
    assert.equal(plan.args[plan.args.indexOf("--keystore") + 1], r.keystore);
  });

  it("writes a log line that a POSIX shell reads back as the same argv", { skip: !POSIX }, async () => {
    const r = await rig();
    const plan = await jsignPlan(request(r, {}, { programName: 'Rock\'s "$(whoami)" `id` $HOME' }));
    assert.ok(plan);
    const { stdout } = await run("/bin/sh", ["-c", `printf '%s\\0' ${plan.display}`]);
    assert.deepEqual(stdout.split("\0").slice(0, -1), [plan.file, ...plan.args]);
  });
});

/** Choice fields refused before any argv exists, with the problem each is refused with. */
const HOSTILE_CHOICES: Array<[string, Partial<OwnCertificateChoice>, WindowsSignProblem]> = [
  ["store type not in the table", { storeType: "PKCS12; rm -rf /" }, WindowsSignProblem.StoreType],
  ["store type in the wrong case", { storeType: "pkcs12" }, WindowsSignProblem.StoreType],
  ["alias that is an option", { alias: "--replace" }, WindowsSignProblem.Alias],
  ["alias that is a short option", { alias: "-x" }, WindowsSignProblem.Alias],
  ["alias that is a dotted option", { alias: ".-x" }, WindowsSignProblem.Alias],
  ["alias with a space", { alias: "my key" }, WindowsSignProblem.Alias],
  ["alias with a newline", { alias: "a\nb" }, WindowsSignProblem.Alias],
  ["empty alias", { alias: "" }, WindowsSignProblem.Alias],
  ["overlong alias", { alias: "a".repeat(65) }, WindowsSignProblem.Alias],
  ["timestamp authority not in the table", { timestampUrl: "https://tsa.example.com" }, WindowsSignProblem.Timestamp],
  [
    "timestamp authority with a path",
    { timestampUrl: "http://timestamp.sectigo.com/../x" },
    WindowsSignProblem.Timestamp,
  ],
  ["empty password", { password: "" }, WindowsSignProblem.Password],
  ["password with a NUL", { password: "a\u0000b" }, WindowsSignProblem.Password],
  ["relative keystore", { keystore: "me.p12" }, WindowsSignProblem.Keystore],
  ["option-shaped keystore, which is relative", { keystore: "-Dx=y" }, WindowsSignProblem.Keystore],
  ["missing keystore", { keystore: "/nonexistent/me.p12" }, WindowsSignProblem.Keystore],
  ["file store without a keystore", { keystore: null }, WindowsSignProblem.Keystore],
  ["token store given a keystore", { storeType: JsignStoreType.Etoken }, WindowsSignProblem.Keystore],
];

describe("hostile fields are refused before any argv exists", () => {
  for (const [label, choice, code] of HOSTILE_CHOICES) {
    it(`refuses a ${label}`, async () => {
      const r = await rig();
      const before = await readdir(r.root, { recursive: true });
      await refusedWith(jsignPlan(request(r, choice)), code, label);
      assert.deepEqual(await readdir(r.root, { recursive: true }), before);
    });
  }

  it("refuses an existing keystore whose name holds a control character", { skip: !POSIX }, async () => {
    const r = await rig();
    for (const name of ["a\nb.p12", "a\u0007b.p12"]) {
      const keystore = path.join(r.root, "certs", name);
      await writeFile(keystore, "not really pkcs12");
      await refusedWith(jsignPlan(request(r, { keystore })), WindowsSignProblem.Keystore, JSON.stringify(name));
    }
  });

  it("refuses a keystore that is a folder or a FIFO", { skip: !POSIX }, async () => {
    const r = await rig();
    const fifo = path.join(r.root, "certs", "pipe.p12");
    await run("mkfifo", [fifo]);
    await refusedWith(
      jsignPlan(request(r, { keystore: path.join(r.root, "certs") })),
      WindowsSignProblem.Keystore,
      "folder",
    );
    await refusedWith(jsignPlan(request(r, { keystore: fifo })), WindowsSignProblem.Keystore, "fifo");
  });

  it("refuses a keystore inside the games root or userData, also through a link", { skip: !POSIX }, async () => {
    const r = await rig();
    const inGames = path.join(r.games, "Space Rocks", "cert.p12");
    await mkdir(path.dirname(inGames), { recursive: true });
    await writeFile(inGames, "agent-written");
    const inUserData = path.join(r.userData, "signing.p12");
    await writeFile(inUserData, "genex");
    const link = path.join(r.root, "certs", "innocent.p12");
    await symlink(inGames, link);
    for (const keystore of [inGames, inUserData, link]) {
      await refusedWith(jsignPlan(request(r, { keystore })), WindowsSignProblem.KeystoreForbidden, keystore);
    }
  });

  it("refuses a program name that is an option, has control characters or is too long", async () => {
    const r = await rig();
    for (const programName of ["-x", "a\u0007b", "x".repeat(201), ""]) {
      await refusedWith(
        jsignPlan(request(r, {}, { programName })),
        WindowsSignProblem.ProgramName,
        JSON.stringify(programName),
      );
    }
  });

  it("refuses targets outside the staging folder, not .exe/.dll, Microsoft's compiler, links or none", async () => {
    const r = await rig();
    const outside = path.join(r.root, "outside.exe");
    await writeFile(outside, "MZ");
    await writeFile(path.join(r.staging, "notes.txt"), "x");
    const rows: Array<[string, string[]]> = [
      ["outside", [outside]],
      ["climbing out", [path.join(r.staging, "..", "..", "outside.exe")]],
      ["relative", ["Space Rocks.exe"]],
      ["not a PE name", [path.join(r.staging, "notes.txt")]],
      ["Microsoft-signed", [path.join(r.staging, "d3dcompiler_47.dll")]],
      ["missing", [path.join(r.staging, "gone.dll")]],
      ["none", []],
      ["twice", [r.targets[0], r.targets[0]]],
    ];
    const upper = path.join(r.staging, "D3DCompiler_47.dll");
    const caseInsensitive = await access(upper).then(
      () => true,
      () => false,
    );
    if (caseInsensitive) rows.push(["Microsoft-signed, named in another case", [upper]]);
    if (POSIX) {
      const link = path.join(r.staging, "link.dll");
      await symlink(outside, link);
      rows.push(["a link", [link]]);
    }
    for (const [label, targets] of rows) {
      await refusedWith(jsignPlan(request(r, {}, { targets })), WindowsSignProblem.Target, label);
    }
  });

  it("refuses a relative or control-character jsign launcher", async () => {
    const r = await rig();
    for (const tool of [
      { file: "jsign", args: [] },
      { file: "/opt/jsign\n/bin/jsign", args: [] },
      { file: "/usr/bin/java", args: ["-jar", "/opt/a\u0000.jar"] },
    ]) {
      await refusedWith(jsignPlan(request(r, {}, { tool })), WindowsSignProblem.Tool, JSON.stringify(tool));
    }
  });
});

/** The preflight's request: the plan's, without the staged files. */
function preflightOf(planRequest: JsignRequest) {
  const { stagingDir: _stagingDir, targets: _targets, ...rest } = planRequest;
  return rest;
}

describe("the preflight, before anything is staged", () => {
  it("answers null for an unsigned export and refuses the harness before reading anything", async () => {
    const r = await rig();
    const unsigned = preflightOf({ ...request(r), choice: { kind: WindowsSigningKind.Unsigned } });
    assert.equal(await jsignPreflight(unsigned), null);
    const harness = request(r, { keystore: "/nonexistent/x.p12" }, { requestedBy: SigningRequester.Harness });
    await refusedWith(jsignPreflight(preflightOf(harness)), WindowsSignProblem.HarnessMayNotSign, "harness");
  });

  for (const [label, choice, code] of HOSTILE_CHOICES) {
    it(`refuses a ${label} as the full plan does`, async () => {
      const r = await rig();
      await refusedWith(jsignPreflight(preflightOf(request(r, choice))), code, label);
    });
  }

  it("refuses a keystore password when Genex runs on Windows, and a password-free key there passes", async () => {
    const r = await rig();
    const onWindows = request(r, {}, { host: StudioPlatform.Windows });
    const code = WindowsSignProblem.WindowsHostPassword;
    await refusedWith(jsignPreflight(preflightOf(onWindows)), code, "preflight");
    await refusedWith(jsignPlan(onWindows), code, "plan");
    const harness = request(r, {}, { host: StudioPlatform.Windows, requestedBy: SigningRequester.Harness });
    await refusedWith(jsignPreflight(preflightOf(harness)), WindowsSignProblem.HarnessMayNotSign, "harness first");
    const noPassword = request(r, { password: null }, { host: StudioPlatform.Windows });
    assert.deepEqual(await jsignPreflight(preflightOf(noPassword)), { hardwareToken: false });
    for (const host of [StudioPlatform.Mac, StudioPlatform.Linux]) {
      assert.deepEqual(await jsignPreflight(preflightOf(request(r, {}, { host }))), { hardwareToken: false }, host);
    }
  });

  it("says whether the key is on hardware, for a choice that passes", async () => {
    const r = await rig();
    const token = request(r, { storeType: JsignStoreType.Yubikey, keystore: null, password: null });
    assert.deepEqual(await jsignPreflight(preflightOf(request(r))), { hardwareToken: false });
    assert.deepEqual(await jsignPreflight(preflightOf(token)), { hardwareToken: true });
  });
});

/** A sandbox stand-in that records the request and answers as jsign would, echoing what it was given. */
function fakeSandbox(answer: Partial<RunResult> = {}): {
  sandbox: { run(request: RunRequest): Promise<RunResult> };
  seen: RunRequest[];
} {
  const seen: RunRequest[] = [];
  return {
    seen,
    sandbox: {
      async run(runRequest) {
        seen.push(runRequest);
        return {
          code: 0,
          signal: null,
          stdout: `signing with ${runRequest.env?.[JSIGN_STOREPASS_ENV] ?? ""}`,
          stderr: `password=${runRequest.env?.[JSIGN_STOREPASS_ENV] ?? ""} rejected? no`,
          durationMs: 1,
          timedOut: false,
          truncated: false,
          sandboxed: true,
          command: runRequest.command,
          cwd: runRequest.cwd,
          ...answer,
        };
      },
    },
  };
}

describe("the sandboxed jsign run", () => {
  it("runs the plan's argv in the staging folder, password only in env, network only to the timestamp host", {
    skip: !POSIX,
  }, async () => {
    const r = await rig();
    const plan = await jsignPlan(request(r));
    assert.ok(plan);
    const jsign = jsignRunRequest(plan);
    const { stdout } = await run("/bin/sh", ["-c", `printf '%s\\0' ${jsign.request.command}`]);
    assert.deepEqual(stdout.split("\0").slice(0, -1), [plan.file, ...plan.args]);
    assert.ok(!jsign.request.command.includes(PASSWORD));
    assert.equal(jsign.request.cwd, r.staging);
    assert.deepEqual(jsign.request.env, { [JSIGN_STOREPASS_ENV]: PASSWORD });
    assert.deepEqual(jsign.request.policy?.allowedDomains, ["timestamp.sectigo.com"]);
    assert.deepEqual(jsign.request.policy?.allowWrite, [r.staging]);
    assert.deepEqual(jsign.secretValues, [PASSWORD]);
    assert.deepEqual(jsign.targets, r.targets);
    assert.ok((jsign.request.timeoutMs ?? 0) > 0);
  });

  it("in its own sandbox writes only its staging folder and private scratch, and reaches only the timestamp host", async () => {
    const r = await rig();
    const plan = await jsignPlan(request(r));
    assert.ok(plan);
    const signingRoot = path.dirname(r.staging);
    const scratch = path.join(r.root, "signing-scratch");
    const agentRoot = path.join(r.root, "workspaces");
    const options = jsignSandboxOptions({
      staging: r.staging,
      scratch,
      secretPaths: [path.join(r.userData, "secrets")],
      // The studio's base denies, the signing folder among them: the staging folder inside it stays writable.
      denyWrite: [signingRoot, agentRoot],
    });
    const sandbox = await ProcessSandbox.create({ ...options, enabled: false });
    try {
      const effective = mergeOverlay(sandbox.policy, jsignRunRequest(plan).request.policy ?? {});
      assert.deepEqual([...new Set(effective.allowWrite)].sort(), [scratch, r.staging].sort());
      assert.deepEqual(effective.allowedDomains, ["timestamp.sectigo.com"]);
      assert.ok(effective.denyWrite.includes(agentRoot), "the agents' folders stay denied");
      assert.ok(!effective.denyWrite.includes(signingRoot), "no deny voids the staging folder");
      assert.ok(effective.denyRead.includes(path.join(r.userData, "secrets")));
    } finally {
      await sandbox.dispose();
    }
  });

  it("hands Java the sandbox's proxy through JAVA_TOOL_OPTIONS when the host knows it", async () => {
    const r = await rig();
    const plan = await jsignPlan(request(r, { password: null, storeType: JsignStoreType.Pkcs12 }));
    assert.ok(plan);
    const jsign = jsignRunRequest(plan, { proxy: { host: "127.0.0.1", port: 8080 } });
    assert.deepEqual(jsign.request.env, {
      JAVA_TOOL_OPTIONS:
        "-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=8080 -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=8080",
    });
    assert.equal(jsignRunRequest(plan).request.env?.JAVA_TOOL_OPTIONS, undefined);
  });

  it("refuses a proxy that is not a host name and a port", async () => {
    const r = await rig();
    const plan = await jsignPlan(request(r));
    assert.ok(plan);
    const rows = [
      { host: "127.0.0.1 -Dx=y", port: 8080 },
      { host: "a\nb", port: 8080 },
      { host: "", port: 8080 },
      { host: "localhost", port: 0 },
      { host: "localhost", port: 65_536 },
      { host: "localhost", port: 80.5 },
    ];
    for (const proxy of rows) assert.throws(() => jsignRunRequest(plan, { proxy }), TypeError, JSON.stringify(proxy));
  });

  it("refuses a key on a token or HSM: the sandbox gives jsign no smart-card access", async () => {
    const r = await rig();
    const token = await jsignPlan(request(r, { storeType: JsignStoreType.Yubikey, keystore: null, password: null }));
    assert.ok(token);
    assert.throws(
      () => jsignRunRequest(token),
      (error: unknown) => error instanceof WindowsSignError && error.code === WindowsSignProblem.HardwareToken,
    );
  });

  it("runs through the sandbox and never lets the password reach the output it answers", async () => {
    const r = await rig();
    const plan = await jsignPlan(request(r));
    assert.ok(plan);
    const { sandbox, seen } = fakeSandbox();
    const jsign = jsignRunRequest(plan);
    const result = await runJsign(sandbox, jsign);
    assert.deepEqual(seen, [jsign.request]);
    assert.equal(result.code, 0);
    assert.ok(!result.stdout.includes(PASSWORD) && !result.stderr.includes(PASSWORD));
    assert.match(result.stderr, /\[redacted\]/);
  });
});

/** `bytes` as jsign leaves them: padded to 8 bytes, a WIN_CERTIFICATE appended, the security directory and checksum set. */
function fakeSigned(bytes: Uint8Array, padding = 0): Buffer {
  const image = Buffer.from(bytes);
  const optional = image.readUInt32LE(0x3c) + 24;
  const plus = image.readUInt16LE(optional) === 0x20b;
  const security = optional + (plus ? 112 : 96) + 4 * 8;
  const padded = Buffer.concat([image, Buffer.alloc(((8 - (image.length % 8)) % 8) + padding)]);
  const blob = Buffer.from("fake PKCS#7 SignedData");
  const certificate = Buffer.alloc(Math.ceil((8 + blob.length) / 8) * 8);
  certificate.writeUInt32LE(certificate.length, 0);
  certificate.writeUInt16LE(0x0200, 4);
  certificate.writeUInt16LE(0x0002, 6);
  blob.copy(certificate, 8);
  const signed = Buffer.concat([padded, certificate]);
  signed.writeUInt32LE(padded.length, security);
  signed.writeUInt32LE(certificate.length, security + 4);
  signed.writeUInt32LE(0x1234abcd, optional + 64);
  return signed;
}

describe("what a signature may change", () => {
  const exe = writePe({ imports: ["libGLESv2.dll", "KERNEL32.dll"] }).bytes;
  const odd = Buffer.concat([Buffer.from(exe), Buffer.from([1, 2, 3])]);

  it("accepts a signature appended to the very bytes, with or without alignment padding", () => {
    assert.equal(signatureOnlyChange(exe, fakeSigned(exe)), true);
    assert.equal(signatureOnlyChange(odd, fakeSigned(odd)), true);
  });

  it("refuses anything more than a signature", () => {
    const signed = fakeSigned(exe);
    const changed = Buffer.from(signed);
    changed[0x200] ^= 0xff;
    const notAtEnd = Buffer.concat([signed, Buffer.from("tail")]);
    const dirtyPadding = fakeSigned(odd);
    dirtyPadding[odd.length] = 7;
    const rows: Array<[string, Uint8Array, Uint8Array]> = [
      ["a body byte changed", exe, changed],
      ["bytes after the signature", exe, notAtEnd],
      ["non-zero padding", odd, dirtyPadding],
      ["eight bytes of padding, more than alignment needs", exe, fakeSigned(exe, 8)],
      ["no signature at all", exe, exe],
      ["another file's signature", odd, fakeSigned(exe)],
      ["not a PE", Buffer.from("not a pe"), Buffer.from("not a pe either")],
      ["truncated", exe, signed.subarray(0, 0x40)],
    ];
    for (const [label, original, after] of rows) assert.equal(signatureOnlyChange(original, after), false, label);
  });
});

it("a real signing sandbox writes only its private staging and scratch, and reports its filtering proxy", {
  skip: process.platform !== "darwin",
}, async () => {
  const r = await rig();
  const scratch = path.join(r.root, "private-scratch");
  const secret = path.join(r.userData, "credential.txt");
  await writeFile(secret, "fixture credential");
  const sandbox = await ProcessSandbox.create(
    jsignSandboxOptions({
      staging: r.staging,
      scratch,
      secretPaths: [secret],
      denyWrite: [r.games, r.userData],
    }),
  );
  try {
    const proxy = sandbox.networkProxy();
    assert.equal(proxy?.host, "127.0.0.1");
    assert.ok(proxy && proxy.port > 0 && proxy.port <= 65535);
    const q = shellQuote;
    const outcome = await sandbox.run({
      cwd: r.staging,
      command: [
        `touch ${q(path.join(r.staging, "allowed"))} && echo staging-ok;`,
        `touch ${q(path.join(scratch, "allowed"))} && echo scratch-ok;`,
        `touch ${q(path.join(r.games, "escaped"))} && echo games-written;`,
        `touch ${q(path.join(r.userData, "escaped"))} && echo user-data-written;`,
        `cat ${q(secret)} && echo credential-read;`,
        "true",
      ].join(" "),
    });
    assert.equal(outcome.sandboxed, true);
    assert.deepEqual(outcome.stdout.trim().split("\n"), ["staging-ok", "scratch-ok"]);
    for (const folder of [r.games, r.userData]) {
      assert.equal(
        await access(path.join(folder, "escaped")).then(
          () => true,
          () => false,
        ),
        false,
      );
    }
  } finally {
    await sandbox.dispose();
  }
});
