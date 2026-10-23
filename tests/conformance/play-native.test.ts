/**
 * Native builds of a Play game: the app's copy of the draft contract genex.games will serve. Every
 * row on the wire is hostile input: a build is kept only when its address is https on a build host
 * the app trusts, its checksum and sizes are sane and its entry stays inside the archive. A game the
 * API says nothing new about stays today's web game.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildFor,
  compareOsVersions,
  FIXTURE_BUILD_HOST,
  hasWebBuild,
  InstallPhase,
  NATIVE_ARCHIVE_MAX_BYTES,
  NATIVE_BUILD_HOSTS,
  NATIVE_BUILDS_MAX,
  NativeArch,
  type NativeBuild,
  type NativeHost,
  NativePlatform,
  NativeAppOffer,
  nativeAppOffer,
  type NativeInstalls,
  nativeOf,
  parseNativeBuilds,
  platformsOf,
  playableHere,
  whyNotHere,
  WhyNotHere,
} from "../../src/shared/play-native.ts";
import { thisComputer } from "../../src/main/play/native-host.ts";

const HOST = "builds.example.test";
const HOSTS: ReadonlySet<string> = new Set([HOST]);
const SHA = "a".repeat(64);

/** A build row as the API serves it. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    platform: "mac",
    arch: "universal",
    version: "1.3.0",
    sizeBytes: 1_200_000_000,
    installedBytes: 1_400_000_000,
    sha256: SHA,
    url: `https://${HOST}/dust-runners/1.3.0/mac.zip`,
    entry: "Dust Runners.app",
    minOs: "13.0",
    publishedAt: "2026-10-17T10:00:00.000Z",
    ...overrides,
  };
}

const MAC_ARM: NativeHost = { platform: NativePlatform.Mac, arch: NativeArch.Arm64, osVersion: "15.1" };
const MAC_INTEL: NativeHost = { platform: NativePlatform.Mac, arch: NativeArch.X64, osVersion: "14.0" };
const WINDOWS: NativeHost = { platform: NativePlatform.Windows, arch: NativeArch.X64, osVersion: "10.0.22631" };
const LINUX: NativeHost = { platform: NativePlatform.Linux, arch: NativeArch.X64, osVersion: "6.8.0" };

const build = (overrides: Partial<NativeBuild> = {}): NativeBuild => {
  const [parsed] = parseNativeBuilds([row()], HOSTS);
  assert.ok(parsed);
  return { ...parsed, ...overrides };
};

describe("Native build rows", () => {
  it("keeps a well-formed row as the contract spells it", () => {
    assert.deepEqual(parseNativeBuilds([row()], HOSTS), [
      {
        platform: "mac",
        arch: "universal",
        version: "1.3.0",
        sizeBytes: 1_200_000_000,
        installedBytes: 1_400_000_000,
        sha256: SHA,
        url: `https://${HOST}/dust-runners/1.3.0/mac.zip`,
        entry: "Dust Runners.app",
        minOs: "13.0",
        publishedAt: "2026-10-17T10:00:00.000Z",
      },
    ]);
  });

  it("reads anything that is not a list as no builds", () => {
    for (const value of [undefined, null, "mac", 3, { platform: "mac" }]) {
      assert.deepEqual(parseNativeBuilds(value, HOSTS), [], String(value));
    }
  });

  it("drops each hostile row and keeps the good ones beside it", () => {
    const hostile: Array<[string, Record<string, unknown>]> = [
      ["plain http", { url: `http://${HOST}/a.zip` }],
      ["a host the app does not trust", { url: "https://evil.example/a.zip" }],
      ["a lookalike host", { url: `https://${HOST}.evil.example/a.zip` }],
      ["a port", { url: `https://${HOST}:8443/a.zip` }],
      ["credentials in the address", { url: `https://user:pw@${HOST}/a.zip` }],
      ["no address", { url: undefined }],
      ["not an address", { url: "dust runners" }],
      ["a short checksum", { sha256: "abc" }],
      ["a checksum that is not hex", { sha256: "z".repeat(64) }],
      ["no size", { sizeBytes: 0 }],
      ["a negative size", { sizeBytes: -5 }],
      ["a fractional size", { sizeBytes: 1.5 }],
      ["a size over the cap", { sizeBytes: NATIVE_ARCHIVE_MAX_BYTES + 1 }],
      ["no unpacked size", { installedBytes: 0 }],
      ["an entry climbing out", { entry: "../Dust Runners.app" }],
      ["an entry inside a climb", { entry: "Games/../../Dust Runners.app" }],
      ["an absolute entry", { entry: "/Applications/Dust Runners.app" }],
      ["a Windows drive entry", { platform: "windows", arch: "x64", entry: "C:/Game/Dust.exe" }],
      ["a backslash entry", { platform: "windows", arch: "x64", entry: "Dust\\Dust.exe" }],
      ["a control character", { entry: "Dust\nRunners.app" }],
      ["a Mac entry that is not an app bundle", { entry: "DustRunners" }],
      ["a Mac app nested in a folder", { entry: "Build/Dust Runners.app" }],
      ["a Windows entry that is not an exe", { platform: "windows", arch: "x64", entry: "Dust.bat" }],
      ["an unknown platform", { platform: "amiga" }],
      ["an unknown architecture", { arch: "ppc" }],
      ["a universal Windows build", { platform: "windows", arch: "universal", entry: "Dust.exe" }],
      ["no version", { version: "" }],
      ["a version with spaces", { version: "1.0 beta" }],
      ["a minimum OS that is not a version", { minOs: "Sonoma" }],
      ["no publish date", { publishedAt: "yesterday" }],
    ];
    for (const [why, overrides] of hostile) {
      const good = row({ arch: "arm64", url: `https://${HOST}/good.zip` });
      const kept = parseNativeBuilds([row(overrides), good], HOSTS);
      assert.deepEqual(
        kept.map((one) => one.url),
        [`https://${HOST}/good.zip`],
        why,
      );
    }
  });

  it("trusts no build host at all until the app is told one", () => {
    assert.deepEqual(parseNativeBuilds([row()], new Set()), []);
  });

  it("downloads a released game's builds from genex.games' CDN only", () => {
    const on = (url: string) => parseNativeBuilds([row({ url })], NATIVE_BUILD_HOSTS).length;
    assert.equal(on("https://cdn.genex.technology/builds/dust-runners/1.3.0/mac-universal.zip"), 1);
    for (const url of [
      "https://dust-runners.genex.technology/builds/mac.zip",
      "https://assets.genex.technology/builds/mac.zip",
      "https://cdn.genex.technology.evil.example/mac.zip",
      "https://cdn.genex.technology:8443/mac.zip",
      "http://cdn.genex.technology/mac.zip",
      `https://${FIXTURE_BUILD_HOST}/mac.zip`,
    ])
      assert.equal(on(url), 0, url);
  });

  it("keeps a Windows build in a folder of its own, and an absent minimum OS", () => {
    const [windows] = parseNativeBuilds(
      [row({ platform: "windows", arch: "x64", entry: "Dust Runners/DustRunners.exe", minOs: undefined })],
      HOSTS,
    );
    assert.equal(windows?.entry, "Dust Runners/DustRunners.exe");
    assert.equal(windows && "minOs" in windows, false);
  });

  it("keeps one row per platform and architecture, the first, and at most a handful", () => {
    const twice = parseNativeBuilds([row({ version: "2" }), row({ version: "1" })], HOSTS);
    assert.deepEqual(
      twice.map((one) => one.version),
      ["2"],
    );
    const many = Array.from({ length: NATIVE_BUILDS_MAX + 5 }, (_, i) =>
      row({ platform: "linux", arch: i % 2 ? "x64" : "arm64", entry: `game-${i}`, version: String(i) }),
    );
    assert.ok(parseNativeBuilds(many, HOSTS).length <= NATIVE_BUILDS_MAX);
  });

  it("lowercases a checksum spelled in capitals", () => {
    const [kept] = parseNativeBuilds([row({ sha256: "AB".repeat(32) })], HOSTS);
    assert.equal(kept?.sha256, "ab".repeat(32));
  });
});

describe("A game's native side", () => {
  it("is absent for an item that names no builds: today's web game", () => {
    assert.equal(nativeOf({ title: "Lost Cathedral" }, HOSTS), undefined);
    assert.equal(nativeOf({ builds: [] }, HOSTS), undefined);
  });

  it("reads whether a web build is there (absent means yes), and the engine it was made with", () => {
    assert.deepEqual(nativeOf({ builds: [row()], web: false, engine: "unity" }, HOSTS), {
      web: false,
      engine: "unity",
      builds: [build()],
    });
    assert.equal(nativeOf({ builds: [row()] }, HOSTS)?.web, true);
    assert.equal(nativeOf({ builds: [row()], engine: "Unity 6!" }, HOSTS)?.engine, null);
  });

  it("keeps a native-only game whose rows were all refused, so it is not mistaken for a web game", () => {
    assert.deepEqual(nativeOf({ builds: [row({ url: "http://evil.example/a.zip" })], web: false }, HOSTS), {
      web: false,
      engine: null,
      builds: [],
    });
  });

  it("answers web build and platforms from what was read", () => {
    const web = {};
    assert.equal(hasWebBuild(web), true);
    assert.deepEqual(platformsOf(web), []);
    const native = {
      native: {
        web: false,
        engine: null,
        builds: [
          build({ platform: NativePlatform.Windows, arch: NativeArch.X64 }),
          build(),
          build({ arch: NativeArch.Arm64 }),
        ],
      },
    };
    assert.equal(hasWebBuild(native), false);
    assert.deepEqual(platformsOf(native), [NativePlatform.Mac, NativePlatform.Windows]);
  });
});

describe("The build for this computer", () => {
  const universal = build();
  const arm = build({ arch: NativeArch.Arm64, version: "arm" });
  const intel = build({ arch: NativeArch.X64, version: "intel" });
  const windows = build({
    platform: NativePlatform.Windows,
    arch: NativeArch.X64,
    entry: "Dust.exe",
    minOs: "10.0.19041",
  });

  it("prefers this Mac's own architecture, then a universal app", () => {
    assert.equal(buildFor([universal, arm, intel], MAC_ARM), arm);
    assert.equal(buildFor([universal, intel], MAC_ARM), universal);
    assert.equal(buildFor([arm, universal, intel], MAC_INTEL), intel);
    assert.equal(buildFor([arm, universal], MAC_INTEL), universal);
  });

  it("offers an Intel-only app on Apple silicon only through Rosetta, and an Apple silicon app on Intel nothing", () => {
    assert.equal(buildFor([intel], MAC_ARM), null);
    assert.equal(buildFor([intel], { ...MAC_ARM, rosetta: true }), intel);
    assert.equal(buildFor([intel, universal], { ...MAC_ARM, rosetta: true }), universal, "a native app first");
    assert.equal(buildFor([intel, arm], { ...MAC_ARM, rosetta: true }), arm, "an Apple silicon app first");
    assert.equal(buildFor([arm], MAC_INTEL), null);
    assert.equal(buildFor([arm], { ...MAC_INTEL, rosetta: true }), null);
  });

  it("offers nothing for a macOS older than the build asks for", () => {
    assert.equal(buildFor([build({ minOs: "16.0" })], MAC_ARM), null);
    assert.ok(buildFor([build({ minOs: "15.1" })], MAC_ARM));
    assert.ok(buildFor([build({ minOs: "15" })], MAC_ARM));
  });

  it("offers Windows its own processor's build where its system is met, and nothing built for another", () => {
    assert.equal(buildFor([universal, windows], WINDOWS), windows);
    assert.equal(buildFor([windows], { ...WINDOWS, arch: NativeArch.Arm64 }), null);
    assert.equal(buildFor([{ ...windows, minOs: "10.0.26100" }], WINDOWS), null);
    assert.equal(buildFor([universal], WINDOWS), null);
  });

  it("offers Linux this computer's own processor's build, and nothing built for another", () => {
    const linuxX64 = build({ platform: NativePlatform.Linux, arch: NativeArch.X64, entry: "Dust/Dust.x86_64" });
    const linuxArm = build({ platform: NativePlatform.Linux, arch: NativeArch.Arm64, entry: "Dust/Dust.arm64" });
    assert.equal(buildFor([universal, windows, linuxArm, linuxX64], LINUX), linuxX64);
    assert.equal(buildFor([linuxX64], { ...LINUX, arch: NativeArch.Arm64 }), null);
    assert.equal(buildFor([universal, windows], LINUX), null);
    assert.equal(buildFor([{ ...linuxX64, minOs: "99.0" }], LINUX)?.version, linuxX64.version, "no kernel minimum");
  });

  it("plays a game here when it has a web build or a build for this computer", () => {
    assert.equal(playableHere({}, MAC_ARM), true);
    const nativeOnly = (builds: NativeBuild[]) => ({ native: { web: false, engine: null, builds } });
    assert.equal(playableHere(nativeOnly([universal]), MAC_ARM), true);
    assert.equal(playableHere(nativeOnly([windows]), MAC_ARM), false);
    assert.equal(playableHere(nativeOnly([]), MAC_ARM), false);
    assert.equal(playableHere({ native: { web: true, engine: null, builds: [windows] } }, MAC_ARM), true);
  });

  it("says why nothing installs here: none was made for this system, or this computer can't run it", () => {
    const linuxX64 = build({ platform: NativePlatform.Linux, arch: NativeArch.X64, entry: "Dust/Dust.x86_64" });
    assert.equal(whyNotHere([universal, windows], MAC_ARM), null, "a build installs");
    assert.equal(whyNotHere([universal, windows], WINDOWS), null, "Windows installs its own");
    assert.deepEqual(whyNotHere([universal, linuxX64], WINDOWS), { why: WhyNotHere.NoBuild });
    assert.deepEqual(whyNotHere([{ ...windows, minOs: "10.0.26100" }], WINDOWS), {
      why: WhyNotHere.OldSystem,
      minOs: "10.0.26100",
    });
    assert.deepEqual(whyNotHere([windows], MAC_ARM), { why: WhyNotHere.NoBuild });
    assert.deepEqual(whyNotHere([], LINUX), { why: WhyNotHere.NoBuild });
    assert.deepEqual(whyNotHere([build({ minOs: "16.0" }), build({ minOs: "15.4", version: "b" })], MAC_ARM), {
      why: WhyNotHere.OldSystem,
      minOs: "15.4",
    });
    assert.deepEqual(whyNotHere([arm], MAC_INTEL), { why: WhyNotHere.AppleSilicon });
    assert.deepEqual(whyNotHere([intel], MAC_ARM), { why: WhyNotHere.Rosetta });
    assert.deepEqual(
      whyNotHere([{ ...arm, minOs: "16.0" }], MAC_INTEL),
      { why: WhyNotHere.AppleSilicon },
      "the chip first",
    );
    assert.deepEqual(whyNotHere([linuxX64], { ...LINUX, arch: NativeArch.Arm64 }), { why: WhyNotHere.Processor });
  });

  it("compares OS versions by their numbers", () => {
    assert.equal(compareOsVersions("13.0", "13"), 0);
    assert.ok(compareOsVersions("13.10", "13.9") > 0);
    assert.ok(compareOsVersions("10.0.19041", "10.0.22631") < 0);
    assert.ok(compareOsVersions("27.0.1", "15.0") > 0);
  });
});

describe("This computer", () => {
  it("is named as the builds' contract spells it, Rosetta asked only on Apple silicon", () => {
    let asked = 0;
    const rosetta = () => {
      asked++;
      return true;
    };
    assert.deepEqual(thisComputer("darwin", "arm64", "15.1", rosetta), { ...MAC_ARM, rosetta: true });
    assert.deepEqual(thisComputer("darwin", "x64", "14.0", rosetta), MAC_INTEL);
    assert.deepEqual(thisComputer("win32", "x64", "10.0.22631", rosetta), WINDOWS);
    assert.equal(asked, 1);
  });

  it("is a Linux computer by its kernel release's numbers", () => {
    assert.deepEqual(thisComputer("linux", "x64", "6.8.0-45-generic"), LINUX);
    assert.deepEqual(thisComputer("linux", "arm64", "6.8.0"), { ...LINUX, arch: NativeArch.Arm64 });
    assert.equal(thisComputer("linux", "x64", "generic-6.8"), undefined);
  });

  it("is unknown for a platform or processor the contract has no name for, or no system version", () => {
    assert.equal(thisComputer("freebsd", "x64", "14.0"), undefined);
    assert.equal(thisComputer("darwin", "ppc", "10.5"), undefined);
    assert.equal(thisComputer("darwin", "arm64", ""), undefined);
  });
});

describe("The viewer's native-app pill", () => {
  const webFirst = { slug: "skate", native: { web: true, engine: "unity", builds: [build()] } };
  const installs = (parts: Partial<NativeInstalls> = {}): NativeInstalls => ({
    installed: [],
    progress: [],
    host: MAC_ARM,
    ...parts,
  });
  const installed = {
    slug: "skate",
    title: "SKATE",
    coverUrl: null,
    version: "1.3.0",
    platform: NativePlatform.Mac,
    arch: NativeArch.Universal,
    bytes: 1_300_000_000,
    installedAt: "2026-10-19T00:00:00.000Z",
    lastPlayedAt: null,
  };

  it("offers a web game's app to install, its progress while it installs, and Play once installed", () => {
    assert.deepEqual(nativeAppOffer(webFirst, installs()), {
      offer: NativeAppOffer.Install,
      platform: NativePlatform.Mac,
      bytes: 1_400_000_000,
      percent: 0,
    });
    const downloading = {
      slug: "skate",
      version: "1.3.0",
      phase: InstallPhase.Downloading,
      receivedBytes: 456_000_000,
      totalBytes: 1_200_000_000,
      etaMs: null,
      failure: null,
    };
    assert.equal(nativeAppOffer(webFirst, installs({ progress: [downloading] }))?.percent, 38);
    assert.equal(nativeAppOffer(webFirst, installs({ installed: [installed] }))?.offer, NativeAppOffer.Ready);
  });

  it("offers nothing for a native-only game, a game with no build here, or where no native game plays", () => {
    assert.equal(nativeAppOffer({ ...webFirst, native: { ...webFirst.native, web: false } }, installs()), null);
    assert.equal(nativeAppOffer({ ...webFirst, native: { ...webFirst.native, builds: [] } }, installs()), null);
    assert.equal(nativeAppOffer(webFirst, installs({ host: null })), null);
    assert.equal(nativeAppOffer({ slug: "lost-cathedral" }, installs()), null);
  });
});
