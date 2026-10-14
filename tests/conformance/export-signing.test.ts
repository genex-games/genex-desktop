/**
 * How an export is signed (`parseExportSigning` in `shared/game-export-contract.ts`): the one check
 * every signing field from the renderer or the harness passes before any `codesign` or `jsign` argv
 * exists. Anything outside the shape is refused `signing-invalid`; what passes is a fresh copy
 * holding only the fields its kind knows, so nothing unchecked reaches an argv. Which destination
 * takes which kind, and who may ask, is `exportSigningFor` (`main/core/native-export-run.ts`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ExportCaller, exportSigningFor } from "../../src/main/core/native-export-run.ts";
import {
  ARTIFACT_SIGNINGS,
  ExportError,
  ExportRefusal,
  ExportSigning,
  type ExportSigningChoice,
  HARNESS_MOBILE_ARTIFACTS,
  JsignStoreType,
  MOBILE_ARTIFACTS,
  MobileArtifact,
  mobileArtifactOf,
  parseExportSigning,
  parseSigningReference,
  SigningReference,
  TIMESTAMP_AUTHORITIES,
} from "../../src/shared/game-export-contract.ts";
import { MOBILE_BUILD_TARGETS } from "../../src/shared/toolchain.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { TargetRefusal } from "../../src/shared/game-targets.ts";

const TEAM = "AB12CD34EF";
const IDENTITY = `Developer ID Application: Jane Roe (${TEAM})`;
const HASH = "0123456789ABCDEF0123456789ABCDEF01234567";

/** A Developer ID choice with one field replaced. */
const developerId = (fields: Record<string, unknown>) => ({
  kind: ExportSigning.DeveloperId,
  identity: IDENTITY,
  keychainProfile: "genex-notary",
  ...fields,
});

const SECTIGO = "http://timestamp.sectigo.com";
const DIGICERT = "http://timestamp.digicert.com";

/** A Windows signature with the person's own certificate, with fields replaced. */
const ownCertificate = (fields: Record<string, unknown>) => ({
  kind: ExportSigning.OwnCertificate,
  storeType: JsignStoreType.Pkcs12,
  keystore: "/Users/pat/keys/genex.p12",
  alias: "genex",
  timestampUrl: SECTIGO,
  password: "correct horse",
  ...fields,
});

/** Asserts `value` is refused as invalid signing. */
function refused(value: unknown, label: string): void {
  assert.throws(
    () => parseExportSigning(value),
    (error: unknown) => error instanceof ExportError && error.code === ExportRefusal.SigningInvalid,
    label,
  );
}

describe("parseExportSigning refuses every hostile signing field", () => {
  const identities: Array<[string, unknown]> = [
    ["an option smuggled as the identity", "-o runtime"],
    ["a NUL inside", "a\0b"],
    ["a newline inside", "a\nb"],
    ["201 characters", `Developer ID Application: ${"x".repeat(162)} (${TEAM})`],
    ["a Developer ID without a team", "Developer ID Application: X"],
    ["a lowercase hash", HASH.toLowerCase()],
    ["an empty identity", ""],
    ["a number", 7],
    ["a control character", `Developer ID Application: Jane\u0007Roe (${TEAM})`],
  ];
  for (const [label, identity] of identities) it(`identity: ${label}`, () => refused(developerId({ identity }), label));

  const profiles: Array<[string, unknown]> = [
    ["a path out", "../x"],
    ["a space", "a b"],
    ["an option", "-p"],
    ["a hidden name", ".hidden"],
    ["65 characters", "a".repeat(65)],
    ["an empty name", ""],
    ["a number", 1],
  ];
  for (const [label, keychainProfile] of profiles)
    it(`keychain profile: ${label}`, () => refused(developerId({ keychainProfile }), label));

  const shapes: Array<[string, unknown]> = [
    ["a number", 1],
    ["an array", [ExportSigning.AdHoc]],
    ["a bare kind string", ExportSigning.AdHoc],
    ["null", null],
    ["nothing", undefined],
    ["Developer ID without an identity", { kind: ExportSigning.DeveloperId }],
    ["a kind this build does not sign with", { kind: "jsign", keystore: "/k.jks" }],
    ["a kind that is no string", { kind: 3 }],
  ];
  for (const [label, value] of shapes) it(`shape: ${label}`, () => refused(value, label));
});

describe("parseExportSigning refuses every hostile own-certificate field", () => {
  const rows: Array<[string, Record<string, unknown>]> = [
    ["store type in lower case", { storeType: "pkcs12" }],
    ["a store type jsign does not take", { storeType: "PFX" }],
    ["no store type", { storeType: undefined }],
    ["a relative keystore", { keystore: "k.p12" }],
    ["a keystore climbing out", { keystore: "../k.p12" }],
    ["a keystore that reads as an option", { keystore: "-k" }],
    ["a keystore with a control character", { keystore: "/keys/k\u0007.p12" }],
    ["a keystore with a newline", { keystore: "/keys/k\n.p12" }],
    ["a keystore with a C1 control character", { keystore: "/keys/k\u0085.p12" }],
    ["a keystore of 1,025 characters", { keystore: `/${"a".repeat(1024)}` }],
    ["a network keystore", { keystore: "\\\\server\\share\\k.p12" }],
    ["a drive-relative keystore", { keystore: "C:k.p12" }],
    ["a keystore that is no string", { keystore: 7 }],
    ["an alias that reads as an option", { alias: "-alias" }],
    ["an alias with a space", { alias: "a b" }],
    ["an empty alias", { alias: "" }],
    ["an alias of 65 characters", { alias: `a${"b".repeat(64)}` }],
    ["no alias", { alias: undefined }],
    ["a timestamp server off the list", { timestampUrl: "http://evil.example" }],
    ["a listed server over https", { timestampUrl: "https://timestamp.sectigo.com" }],
    ["a listed server with a path", { timestampUrl: "http://timestamp.sectigo.com/extra" }],
    ["a listed server in upper case", { timestampUrl: "HTTP://TIMESTAMP.SECTIGO.COM" }],
    ["no timestamp server", { timestampUrl: undefined }],
    ["a password with a NUL", { password: "a\0b" }],
    ["a password of 1,025 characters", { password: "x".repeat(1025) }],
    ["a password that is no string", { password: 42 }],
  ];
  for (const [label, fields] of rows) it(label, () => refused(ownCertificate(fields), label));
});

describe("parseExportSigning accepts each kind and copies only its fields", () => {
  const rows: Array<[string, unknown, ExportSigningChoice]> = [
    ["none", { kind: ExportSigning.None, identity: IDENTITY }, { kind: ExportSigning.None }],
    ["ad hoc", { kind: ExportSigning.AdHoc, extra: "-o runtime" }, { kind: ExportSigning.AdHoc }],
    [
      "Developer ID with a notary profile",
      developerId({}),
      { kind: ExportSigning.DeveloperId, identity: IDENTITY, keychainProfile: "genex-notary" },
    ],
    [
      "Developer ID by certificate hash, no notary profile",
      { kind: ExportSigning.DeveloperId, identity: HASH },
      { kind: ExportSigning.DeveloperId, identity: HASH, keychainProfile: null },
    ],
    [
      "Developer ID with a null profile",
      developerId({ keychainProfile: null }),
      { kind: ExportSigning.DeveloperId, identity: IDENTITY, keychainProfile: null },
    ],
    [
      "a 200-character identity",
      developerId({ identity: `Developer ID Application: ${"x".repeat(161)} (${TEAM})` }),
      {
        kind: ExportSigning.DeveloperId,
        identity: `Developer ID Application: ${"x".repeat(161)} (${TEAM})`,
        keychainProfile: "genex-notary",
      },
    ],
    [
      "a 64-character profile",
      developerId({ keychainProfile: `p${"a".repeat(63)}` }),
      { kind: ExportSigning.DeveloperId, identity: IDENTITY, keychainProfile: `p${"a".repeat(63)}` },
    ],
    [
      "own certificate in a PKCS12 file, an unknown field dropped",
      ownCertificate({ identity: IDENTITY, extra: "-x" }),
      {
        kind: ExportSigning.OwnCertificate,
        storeType: JsignStoreType.Pkcs12,
        keystore: "/Users/pat/keys/genex.p12",
        alias: "genex",
        timestampUrl: SECTIGO,
        password: "correct horse",
      },
    ],
    [
      "own certificate on a YubiKey: no keystore, no password",
      ownCertificate({ storeType: JsignStoreType.Yubikey, keystore: null, password: null, timestampUrl: DIGICERT }),
      {
        kind: ExportSigning.OwnCertificate,
        storeType: JsignStoreType.Yubikey,
        keystore: null,
        alias: "genex",
        timestampUrl: DIGICERT,
        password: null,
      },
    ],
    [
      "own certificate at a Windows path, keystore and password absent",
      ownCertificate({ keystore: "C:\\keys\\genex.pfx", password: undefined }),
      {
        kind: ExportSigning.OwnCertificate,
        storeType: JsignStoreType.Pkcs12,
        keystore: "C:\\keys\\genex.pfx",
        alias: "genex",
        timestampUrl: SECTIGO,
        password: null,
      },
    ],
    [
      "own certificate at the longest keystore, alias and password",
      ownCertificate({ keystore: `/${"k".repeat(1023)}`, alias: `a${"b".repeat(63)}`, password: "p".repeat(1024) }),
      {
        kind: ExportSigning.OwnCertificate,
        storeType: JsignStoreType.Pkcs12,
        keystore: `/${"k".repeat(1023)}`,
        alias: `a${"b".repeat(63)}`,
        timestampUrl: SECTIGO,
        password: "p".repeat(1024),
      },
    ],
  ];
  for (const [label, value, expected] of rows)
    it(label, () => {
      const parsed = parseExportSigning(value);
      assert.deepEqual(parsed, expected);
      assert.notEqual(parsed, value, "a fresh copy, never the caller's object");
    });
});

describe("which signing each destination takes, and who may ask for it (exportSigningFor)", () => {
  const ownCert = ownCertificate({});
  const identity = developerId({});

  it("absent: a Mac app ad hoc, every other destination unsigned", () => {
    const rows: Array<[BuildTarget, ExportSigningChoice]> = [
      [BuildTarget.Web, { kind: ExportSigning.None }],
      [BuildTarget.Mac, { kind: ExportSigning.AdHoc }],
      [BuildTarget.Windows, { kind: ExportSigning.None }],
      [BuildTarget.Linux, { kind: ExportSigning.None }],
    ];
    for (const [destination, expected] of rows)
      assert.deepEqual(exportSigningFor(destination, undefined, ExportCaller.Person), expected, destination);
  });

  it("Windows takes none or the person's own certificate; Linux none only", () => {
    assert.deepEqual(exportSigningFor(BuildTarget.Windows, { kind: "none" }, ExportCaller.Person), {
      kind: ExportSigning.None,
    });
    assert.deepEqual(exportSigningFor(BuildTarget.Linux, { kind: "none" }, ExportCaller.Harness), {
      kind: ExportSigning.None,
    });
    const signed = exportSigningFor(BuildTarget.Windows, ownCert, ExportCaller.Person);
    assert.equal(signed.kind, ExportSigning.OwnCertificate);
    assert.notEqual(signed, ownCert, "a fresh copy");
  });

  it("any other destination and kind is signing-invalid", () => {
    const rows: Array<[string, BuildTarget, unknown]> = [
      ["own certificate for Linux", BuildTarget.Linux, ownCert],
      ["ad hoc for Linux", BuildTarget.Linux, { kind: "adhoc" }],
      ["Developer ID for Linux", BuildTarget.Linux, identity],
      ["Developer ID for Windows", BuildTarget.Windows, identity],
      ["ad hoc for Windows", BuildTarget.Windows, { kind: "adhoc" }],
      ["own certificate for a Mac app", BuildTarget.Mac, ownCert],
      ["own certificate for the browser", BuildTarget.Web, ownCert],
      ["a hostile own certificate for Windows", BuildTarget.Windows, ownCertificate({ alias: "-alias" })],
    ];
    for (const [label, destination, value] of rows)
      assert.throws(
        () => exportSigningFor(destination, value, ExportCaller.Person),
        (error: unknown) => error instanceof ExportError && error.code === ExportRefusal.SigningInvalid,
        label,
      );
  });

  it("the harness asking for the person's own certificate is harness-may-not-sign", () => {
    for (const [label, destination, value] of [
      ["own certificate for Windows", BuildTarget.Windows, ownCert],
      ["Developer ID for a Mac app", BuildTarget.Mac, identity],
    ] as const)
      assert.throws(
        () => exportSigningFor(destination, value, ExportCaller.Harness),
        (error: unknown) => error instanceof ExportError && error.code === ExportRefusal.HarnessMayNotSign,
        label,
      );
  });
});

/** An iOS device or distribution signing with fields replaced. */
const iosSigning = (kind: string, fields: Record<string, unknown> = {}) => ({
  kind,
  identity:
    kind === ExportSigning.IosDistribution
      ? `Apple Distribution: Jane Roe (${TEAM})`
      : `Apple Development: Jane Roe (${TEAM})`,
  provisioningProfile: "/Users/pat/Profiles/genex.mobileprovision",
  ...fields,
});

/** An Android release signing with the person's own keystore, with fields replaced. */
const androidRelease = (fields: Record<string, unknown> = {}) => ({
  kind: ExportSigning.AndroidRelease,
  keystore: "/Users/pat/keys/release.jks",
  alias: "genex",
  password: { env: "GENEX_RELEASE_PASSWORD" },
  ...fields,
});

describe("phone signing kinds: what each phone takes, and who may ask (M3.0)", () => {
  it("parses each phone kind into a fresh copy holding only its fields; a password is a reference, never the secret", () => {
    const rows: Array<[string, unknown, ExportSigningChoice]> = [
      [
        "iOS development, an unknown field dropped",
        iosSigning(ExportSigning.IosDevelopment, { extra: "--force" }),
        {
          kind: ExportSigning.IosDevelopment,
          identity: `Apple Development: Jane Roe (${TEAM})`,
          provisioningProfile: "/Users/pat/Profiles/genex.mobileprovision",
        },
      ],
      [
        "iOS distribution by certificate hash",
        iosSigning(ExportSigning.IosDistribution, { identity: HASH }),
        {
          kind: ExportSigning.IosDistribution,
          identity: HASH,
          provisioningProfile: "/Users/pat/Profiles/genex.mobileprovision",
        },
      ],
      [
        "Android debug: Studio's own per-profile key",
        { kind: ExportSigning.AndroidDebug, keystore: "/x" },
        { kind: ExportSigning.AndroidDebug },
      ],
      [
        "Android release, password from the environment",
        androidRelease(),
        {
          kind: ExportSigning.AndroidRelease,
          keystore: "/Users/pat/keys/release.jks",
          alias: "genex",
          password: { env: "GENEX_RELEASE_PASSWORD" },
        },
      ],
      [
        "Android release, password from a file",
        androidRelease({ password: { file: "/Users/pat/keys/release.pass", env: "IGNORED" } }),
        {
          kind: ExportSigning.AndroidRelease,
          keystore: "/Users/pat/keys/release.jks",
          alias: "genex",
          password: { file: "/Users/pat/keys/release.pass" },
        },
      ],
    ];
    for (const [label, value, expected] of rows) {
      const parsed = parseExportSigning(value);
      assert.deepEqual(parsed, expected, label);
      assert.notEqual(parsed, value, `${label}: a fresh copy`);
    }
  });

  it("refuses every hostile phone signing field as signing-invalid", () => {
    const rows: Array<[string, unknown]> = [
      ["a Developer ID name for an iOS device build", iosSigning(ExportSigning.IosDevelopment, { identity: IDENTITY })],
      [
        "a distribution name for a development build",
        iosSigning(ExportSigning.IosDevelopment, { identity: `Apple Distribution: Jane Roe (${TEAM})` }),
      ],
      ["an identity read as an option", iosSigning(ExportSigning.IosDistribution, { identity: "-s" })],
      [
        "an identity with a newline",
        iosSigning(ExportSigning.IosDevelopment, { identity: `Apple Development: Jane\nRoe (${TEAM})` }),
      ],
      ["no provisioning profile", iosSigning(ExportSigning.IosDevelopment, { provisioningProfile: undefined })],
      [
        "a relative provisioning profile",
        iosSigning(ExportSigning.IosDevelopment, { provisioningProfile: "genex.mobileprovision" }),
      ],
      [
        "a profile that is not a .mobileprovision",
        iosSigning(ExportSigning.IosDevelopment, { provisioningProfile: "/etc/passwd" }),
      ],
      [
        "a profile with a control character",
        iosSigning(ExportSigning.IosDistribution, { provisioningProfile: "/a\u0000.mobileprovision" }),
      ],
      ["a release keystore that is relative", androidRelease({ keystore: "release.jks" })],
      ["a release keystore on a UNC path", androidRelease({ keystore: "\\\\server\\share\\release.jks" })],
      ["an alias read as an option", androidRelease({ alias: "-alias" })],
      ["a password written out", androidRelease({ password: "hunter2" })],
      ["a password from a lower-case variable", androidRelease({ password: { env: "path" } })],
      ["a password from a relative file", androidRelease({ password: { file: "release.pass" } })],
      ["a password reference naming nothing", androidRelease({ password: {} })],
    ];
    for (const [label, value] of rows) refused(value, label);
  });

  it("an iOS app is ad hoc for the Simulator unless the person signs it; an Android build takes Studio's debug key", () => {
    assert.deepEqual(exportSigningFor(BuildTarget.Ios, undefined, ExportCaller.Person), { kind: ExportSigning.AdHoc });
    assert.deepEqual(exportSigningFor(BuildTarget.Android, undefined, ExportCaller.Harness), {
      kind: ExportSigning.AndroidDebug,
    });
    assert.deepEqual(exportSigningFor(BuildTarget.Ios, { kind: "adhoc" }, ExportCaller.Harness), {
      kind: ExportSigning.AdHoc,
    });
    assert.equal(
      exportSigningFor(BuildTarget.Ios, iosSigning(ExportSigning.IosDistribution), ExportCaller.Person).kind,
      ExportSigning.IosDistribution,
    );
    assert.equal(
      exportSigningFor(BuildTarget.Android, androidRelease(), ExportCaller.Person).kind,
      ExportSigning.AndroidRelease,
    );
  });

  it("a phone kind for another destination, or a desktop kind for a phone, is signing-invalid", () => {
    const rows: Array<[string, BuildTarget, unknown]> = [
      ["iOS development for a Mac app", BuildTarget.Mac, iosSigning(ExportSigning.IosDevelopment)],
      ["Android release for Windows", BuildTarget.Windows, androidRelease()],
      ["Android debug for iOS", BuildTarget.Ios, { kind: ExportSigning.AndroidDebug }],
      ["iOS distribution for Android", BuildTarget.Android, iosSigning(ExportSigning.IosDistribution)],
      ["Developer ID for iOS", BuildTarget.Ios, developerId({})],
      ["unsigned Android", BuildTarget.Android, { kind: "none" }],
      ["own certificate for Android", BuildTarget.Android, ownCertificate({})],
    ];
    for (const [label, destination, value] of rows)
      assert.throws(
        () => exportSigningFor(destination, value, ExportCaller.Person),
        (error: unknown) => error instanceof ExportError && error.code === ExportRefusal.SigningInvalid,
        label,
      );
  });

  it("the harness is refused iOS device and distribution signing and the Android release keystore: harness-may-not-sign", () => {
    for (const [label, destination, value] of [
      ["iOS development", BuildTarget.Ios, iosSigning(ExportSigning.IosDevelopment)],
      ["iOS distribution", BuildTarget.Ios, iosSigning(ExportSigning.IosDistribution)],
      ["Android release keystore", BuildTarget.Android, androidRelease()],
    ] as const)
      assert.throws(
        () => exportSigningFor(destination, value, ExportCaller.Harness),
        (error: unknown) => error instanceof ExportError && error.code === ExportRefusal.HarnessMayNotSign,
        label,
      );
  });
});

/** Asserts `run` throws the export refusal `code`. */
function refusedWith(run: () => unknown, code: ExportRefusal, label: string): void {
  assert.throws(run, (error: unknown) => error instanceof ExportError && error.code === code, label);
}

describe("the phone artifacts and the signings each takes (M5.0)", () => {
  it("names the artifacts in their wire spellings: the Simulator app and the IPA on iOS, the dev APK and the AAB on Android", () => {
    assert.deepEqual(Object.values(MobileArtifact), ["simulator-app", "ipa", "apk-dev", "aab"]);
    assert.deepEqual(MOBILE_ARTIFACTS, {
      [BuildTarget.Ios]: [MobileArtifact.SimulatorApp, MobileArtifact.Ipa],
      [BuildTarget.Android]: [MobileArtifact.ApkDev, MobileArtifact.Aab],
    });
    assert.deepEqual(MOBILE_BUILD_TARGETS, [BuildTarget.Ios, BuildTarget.Android]);
  });

  it("a phone destination takes exactly the signings of its artifacts, and its default signing makes its first artifact", () => {
    for (const target of MOBILE_BUILD_TARGETS) {
      const artifacts: readonly MobileArtifact[] = MOBILE_ARTIFACTS[target];
      const signings: readonly ExportSigning[] = artifacts.flatMap((artifact) => ARTIFACT_SIGNINGS[artifact]);
      for (const kind of Object.values(ExportSigning)) {
        const takes = signings.includes(kind);
        if (takes) assert.equal(artifacts.includes(mobileArtifactOf(target, kind)), true, kind);
        else refusedWith(() => mobileArtifactOf(target, kind), ExportRefusal.SigningInvalid, `${target} ${kind}`);
      }
      const byDefault = exportSigningFor(target, undefined, ExportCaller.Harness);
      assert.equal(mobileArtifactOf(target, byDefault.kind), artifacts[0], target);
    }
    assert.equal(mobileArtifactOf(BuildTarget.Ios, ExportSigning.AdHoc), MobileArtifact.SimulatorApp);
    assert.equal(mobileArtifactOf(BuildTarget.Ios, ExportSigning.IosDevelopment), MobileArtifact.Ipa);
    assert.equal(mobileArtifactOf(BuildTarget.Ios, ExportSigning.IosDistribution), MobileArtifact.Ipa);
    assert.equal(mobileArtifactOf(BuildTarget.Android, ExportSigning.AndroidDebug), MobileArtifact.ApkDev);
    assert.equal(mobileArtifactOf(BuildTarget.Android, ExportSigning.AndroidRelease), MobileArtifact.Aab);
  });

  it("the harness makes only the Simulator app and the dev APK: every signing of an IPA or an AAB is harness-may-not-sign", () => {
    assert.deepEqual(HARNESS_MOBILE_ARTIFACTS, [MobileArtifact.SimulatorApp, MobileArtifact.ApkDev]);
    const fields = {
      [ExportSigning.IosDevelopment]: iosSigning(ExportSigning.IosDevelopment),
      [ExportSigning.IosDistribution]: iosSigning(ExportSigning.IosDistribution),
      [ExportSigning.AndroidRelease]: androidRelease(),
    } as Partial<Record<ExportSigning, unknown>>;
    const harness = new Set<MobileArtifact>(HARNESS_MOBILE_ARTIFACTS);
    for (const target of MOBILE_BUILD_TARGETS)
      for (const artifact of MOBILE_ARTIFACTS[target] as readonly MobileArtifact[]) {
        if (harness.has(artifact)) continue;
        for (const kind of ARTIFACT_SIGNINGS[artifact]) {
          const value = fields[kind];
          assert.ok(value, `${artifact} ${kind} has a choice row`);
          refusedWith(
            () => exportSigningFor(target, value, ExportCaller.Harness),
            ExportRefusal.HarnessMayNotSign,
            `${artifact} ${kind}`,
          );
          assert.equal(exportSigningFor(target, value, ExportCaller.Person).kind, kind, `${artifact} ${kind} person`);
        }
      }
  });

  it("a signing-reference pick names a keystore, a provisioning profile or a password file, nothing else", () => {
    assert.deepEqual(Object.values(SigningReference), ["keystore", "provisioning-profile", "password-file"]);
    for (const kind of Object.values(SigningReference)) assert.equal(parseSigningReference({ kind }), kind);
    for (const value of [undefined, null, "keystore", { kind: "certificate" }, { kind: ["keystore"] }, []])
      refusedWith(() => parseSigningReference(value), ExportRefusal.SigningInvalid, JSON.stringify(value) ?? "?");
  });
});

describe("the export refusals", () => {
  it("an export refusal carries the gate's refusal and the file it is about, or nulls", () => {
    const refused = new ExportError(ExportRefusal.AdmissionRefused, "not admitted", {
      refusal: "foreign-import",
      file: "game.exe",
    });
    assert.deepEqual(
      [refused.code, refused.refusal, refused.file],
      ["admission-refused", "foreign-import", "game.exe"],
    );
    const plain = new ExportError(ExportRefusal.BuildFailed, "failed");
    assert.deepEqual([plain.refusal, plain.file], [null, null]);
  });

  it("append the desktop exports' refusals after every older value, in their wire spellings", () => {
    const values = Object.values(ExportRefusal);
    // Flipped (M7.3): the conformance gate's `conformance-required` is appended after them.
    assert.deepEqual(values.slice(-7), [
      "build-changed",
      "toolchain-unusable",
      "signing-failed",
      "target-refused",
      "missing-notice",
      "archive-refused",
      "conformance-required",
    ]);
    assert.equal(values.indexOf(TargetRefusal.MacBuildsNeedAMac), values.length - 8);
  });

  it("name the signing kinds, the mobile ones appended, and the one table of store types and timestamp servers", () => {
    // Flipped (M3.0): the phone signing kinds are appended after the four desktop ones.
    assert.deepEqual(Object.values(ExportSigning), [
      "none",
      "adhoc",
      "developer-id",
      "own-certificate",
      "ios-development",
      "ios-distribution",
      "android-debug",
      "android-release",
    ]);
    assert.deepEqual(Object.values(JsignStoreType), ["PKCS12", "JKS", "PKCS11", "YUBIKEY", "PIV", "ETOKEN"]);
    assert.deepEqual(TIMESTAMP_AUTHORITIES, [SECTIGO, DIGICERT]);
  });

  it("keep their wire spellings, the Mac one TargetRefusal's own", () => {
    assert.equal(ExportRefusal.SigningInvalid, "signing-invalid");
    assert.equal(ExportRefusal.SigningUnavailable, "signing-unavailable");
    assert.equal(ExportRefusal.HarnessMayNotSign, "harness-may-not-sign");
    assert.equal(ExportRefusal.AdmissionRefused, "admission-refused");
    assert.equal(ExportRefusal.MacBuildsNeedAMac, TargetRefusal.MacBuildsNeedAMac);
    assert.equal(new Set(Object.values(ExportRefusal)).size, Object.values(ExportRefusal).length);
  });
});
