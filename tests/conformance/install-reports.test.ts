/**
 * What the app tells genex.games about an app build on this computer, a moment at a time, so the
 * Installs report can hold real numbers: the game, the moment, the system family, the build's
 * version, how long a download took, a block's reason or a failure's code, and nothing else. It goes
 * from main as the account, or signed out with the computer's own random id the play report uses;
 * it never holds an install, and a genex.games that does not take it yet (404) is left alone a while.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { type GalleryAnswer, PlayRoute } from "../../src/main/play/gallery.ts";
import {
  type InstallNews,
  installBlockOf,
  installReports,
  NOT_SERVED_PAUSE_MS,
  osFamilyOf,
} from "../../src/main/play/install-reports.ts";
import { nativeInstalls } from "../../src/main/play/native-installs.ts";
import { computerIdOf, nativePlays } from "../../src/main/play/native-plays.ts";
import { runTool } from "../../src/main/play/native-unpack.ts";
import { InstallBlock, InstallMoment, OsFamily } from "../../src/shared/game-analytics.ts";
import type { PlayGameDetail } from "../../src/shared/play.ts";
import {
  InstallFailure,
  InstallPhase,
  NativeArch,
  type NativeBuild,
  type NativeHost,
  NativePlatform,
  WhyNotHere,
  type ZipBuild,
} from "../../src/shared/play-native.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { writeZip, type ZipItem } from "../helpers/zip-writer.ts";

const TOKEN = "tok_secret_0123456789abcdef";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const APPLE_SILICON: NativeHost = { platform: NativePlatform.Mac, arch: NativeArch.Arm64, osVersion: "15.1" };
const LINUX_PC: NativeHost = { platform: NativePlatform.Linux, arch: NativeArch.X64, osVersion: "6.8.0" };

interface Sent {
  route: string;
  method: string | undefined;
  body: unknown;
  token: string | undefined;
}

/** A Mac build row for `version`, made for `arch` and asking for at least `minOs`. */
const macBuild = (version: string, arch: NativeArch = NativeArch.Universal, minOs?: string): NativeBuild => ({
  platform: NativePlatform.Mac,
  arch,
  version,
  sizeBytes: 1024,
  installedBytes: 4096,
  sha256: "a".repeat(64),
  url: `https://cdn.genex.technology/dust-runners/${version}/mac.zip`,
  entry: "Dust Runners.app",
  publishedAt: "2026-11-01T00:00:00.000Z",
  ...(minOs ? { minOs } : {}),
});

/** A reporter over a fresh folder whose reports genex.games answers with `answer`, signed in with `token`. */
async function reporter(
  options: {
    token?: string | (() => string | undefined);
    answer?: (sent: Sent) => Promise<GalleryAnswer>;
    host?: NativeHost;
    silent?: boolean;
    root?: string;
  } = {},
) {
  const root = options.root ?? (await tmpDir("install-reports-"));
  const sent: Sent[] = [];
  const logs: string[] = [];
  const refused: string[] = [];
  let clock = 1_000_000;
  const reports = installReports({
    request: async (route, init) => {
      const one = { route, method: init.method, body: init.body, token: init.token };
      sent.push(one);
      return options.answer ? options.answer(one) : { status: 200, body: { ok: true } };
    },
    token: async () => (typeof options.token === "function" ? options.token() : options.token),
    refused: (token) => refused.push(token),
    playerId: computerIdOf(root),
    host: options.host ?? APPLE_SILICON,
    now: () => clock,
    log: (line) => logs.push(line),
    ...(options.silent ? { silent: true } : {}),
  });
  const pass = (ms: number) => {
    clock += ms;
  };
  return { reports, root, sent, logs, refused, pass };
}

/** What each report carried, in order. */
const bodies = (sent: Sent[]) => sent.map((one) => one.body);

/** The field `key` of the report sent `at` (from the end when negative), or undefined. */
const field = (sent: readonly Sent[], at: number, key: string): unknown => {
  const body = sent.at(at)?.body;
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined;
};

describe("an app build's install moments on genex.games", () => {
  it("sends each moment's report as the account: the game, the moment, the system family and its own facts only", async () => {
    const { reports, sent } = await reporter({ token: TOKEN });
    const moments: InstallNews[] = [
      { slug: "dust-runners", moment: InstallMoment.Pressed, version: "1.2" },
      { slug: "dust-runners", moment: InstallMoment.Downloaded, version: "1.2", seconds: 41.6 },
      { slug: "dust-runners", moment: InstallMoment.Installed, version: "1.2" },
      { slug: "dust-runners", moment: InstallMoment.Failed, version: "1.2", failure: InstallFailure.NoSpace },
      { slug: "dust-runners", moment: InstallMoment.Opened, version: "1.2" },
      { slug: "dust-runners", moment: InstallMoment.Removed, version: "1.2" },
    ];
    for (const news of moments) await reports.tell(news);
    const about = { slug: "dust-runners", os: OsFamily.MacArm, version: "1.2" };
    const none = { seconds: null, block: null, failure: null };
    assert.deepEqual(bodies(sent), [
      { ...about, ...none, moment: InstallMoment.Pressed },
      { ...about, ...none, moment: InstallMoment.Downloaded, seconds: 42 },
      { ...about, ...none, moment: InstallMoment.Installed },
      { ...about, ...none, moment: InstallMoment.Failed, failure: InstallFailure.NoSpace },
      { ...about, ...none, moment: InstallMoment.Opened },
      { ...about, ...none, moment: InstallMoment.Removed },
    ]);
    for (const one of sent) {
      assert.equal(one.route, PlayRoute.NativeInstall);
      assert.equal(one.method, "POST");
      assert.equal(one.token, TOKEN);
    }
  });

  it("sends Offered and Blocked from a game's page as this computer reads it", async () => {
    const { reports, sent } = await reporter({ token: TOKEN });
    await reports.pageRead("dust-runners", [macBuild("1.2")], null);
    await reports.pageRead("iron-tide", [macBuild("2.0", NativeArch.Universal, "26.0")], null);
    const none = { seconds: null, block: null, failure: null };
    assert.deepEqual(bodies(sent), [
      { slug: "dust-runners", moment: InstallMoment.Offered, os: OsFamily.MacArm, version: "1.2", ...none },
      {
        slug: "iron-tide",
        moment: InstallMoment.Blocked,
        os: OsFamily.MacArm,
        version: null,
        ...none,
        block: InstallBlock.OldSystem,
      },
    ]);
  });

  it("signed out, sends the computer's random id the play report sends, and makes it once", async () => {
    const { reports, root, sent } = await reporter();
    await reports.tell({ slug: "dust-runners", moment: InstallMoment.Pressed, version: "1.2" });
    const body = sent[0]?.body as Record<string, unknown>;
    assert.equal(sent[0]?.token, undefined);
    assert.match(String(body.playerId), UUID);
    assert.deepEqual(Object.keys(body).sort(), [
      "block",
      "failure",
      "moment",
      "os",
      "playerId",
      "seconds",
      "slug",
      "version",
    ]);
    const kept = JSON.parse(await readFile(path.join(root, "player.json"), "utf8"));
    assert.deepEqual(kept, { playerId: body.playerId });

    const playsSent: Sent[] = [];
    const plays = nativePlays({
      root,
      request: async (route, init) => {
        playsSent.push({ route, method: init.method, body: init.body, token: init.token });
        return { status: 200, body: {} };
      },
      token: async () => undefined,
      log: () => {},
    });
    await plays.report("dust-runners");
    assert.equal(field(playsSent, 0, "playerId"), body.playerId, "one id for both reports");
  });

  it("shares one computer id between the play report and install reports made at once", async () => {
    const root = await tmpDir("install-reports-");
    const playerId = computerIdOf(root);
    const ids: unknown[] = [];
    const request = async (_route: string, init: { body?: unknown }): Promise<GalleryAnswer> => {
      ids.push((init.body as { playerId?: string }).playerId);
      return { status: 200, body: {} };
    };
    const token = async () => undefined;
    const plays = nativePlays({ root, request, token, playerId, log: () => {} });
    const reports = installReports({ request, token, playerId, host: LINUX_PC, now: () => 0, log: () => {} });
    await Promise.all([
      plays.report("dust-runners"),
      reports.tell({ slug: "dust-runners", moment: InstallMoment.Opened, version: "1.0" }),
    ]);
    assert.equal(ids.length, 2);
    assert.match(String(ids[0]), UUID);
    assert.equal(ids[1], ids[0]);
  });
});

describe("an app build's install moments: refusals and outages", () => {
  it("ends a sign-in genex.games refuses, as the play report does, and reports as this computer instead", async () => {
    const answer = async (one: Sent): Promise<GalleryAnswer> =>
      one.token ? { status: 401, body: { error: "Unauthorized" } } : { status: 200, body: { ok: true } };
    const { reports, sent, refused } = await reporter({ token: TOKEN, answer });
    await reports.tell({ slug: "dust-runners", moment: InstallMoment.Installed, version: "1.2" });
    assert.deepEqual(refused, [TOKEN]);
    assert.deepEqual(
      sent.map((one) => one.token),
      [TOKEN, undefined],
    );
    assert.match(String(field(sent, 1, "playerId")), UUID);
    await reports.tell({ slug: "dust-runners", moment: InstallMoment.Opened, version: "1.2" });
    assert.equal(sent.length, 3);
    assert.equal(sent[2]?.token, undefined, "the refused token is never sent again");
  });

  it("sends nothing in a fixture or smoke launch, and makes no computer id there", async () => {
    const { reports, root, sent } = await reporter({ silent: true });
    await reports.tell({ slug: "dust-runners", moment: InstallMoment.Pressed, version: "1.2" });
    await reports.pageRead("dust-runners", [macBuild("1.2")], null);
    assert.deepEqual(sent, []);
    await assert.rejects(readFile(path.join(root, "player.json")), { code: "ENOENT" });
  });

  it("drops a refused or failed report without throwing, and still sends the next one", async () => {
    const answers: Array<(sent: Sent) => Promise<GalleryAnswer>> = [
      async () => ({ status: 400, body: { error: "Bad request" } }),
      async () => ({ status: 403, body: { error: "launcher_only" } }),
      async () => ({ status: 429, body: null }),
      async () => ({ status: 503, body: null }),
      async () => {
        throw new Error("getaddrinfo ENOTFOUND api.genex.games");
      },
    ];
    for (const answer of answers) {
      const { reports, sent } = await reporter({ token: TOKEN, answer });
      await reports.tell({ slug: "dust-runners", moment: InstallMoment.Pressed, version: "1.2" });
      await reports.tell({ slug: "dust-runners", moment: InstallMoment.Installed, version: "1.2" });
      assert.equal(sent.length, 2, "tried once each, never again");
    }
  });

  it("leaves genex.games alone for a while once it answers that it does not take reports yet", async () => {
    let served = false;
    const answer = async (): Promise<GalleryAnswer> =>
      served ? { status: 200, body: { ok: true } } : { status: 404, body: { error: "Not found" } };
    const { reports, sent, logs, pass } = await reporter({ token: TOKEN, answer });
    await reports.tell({ slug: "dust-runners", moment: InstallMoment.Pressed, version: "1.2" });
    await reports.tell({ slug: "dust-runners", moment: InstallMoment.Downloaded, version: "1.2", seconds: 3 });
    await reports.pageRead("iron-tide", [macBuild("1.0")], null);
    assert.equal(sent.length, 1, "the moments after a 404 are dropped, not sent");
    assert.equal(logs.length, 1);
    assert.ok(!logs[0]?.includes(TOKEN));
    pass(NOT_SERVED_PAUSE_MS - 1);
    await reports.tell({ slug: "dust-runners", moment: InstallMoment.Installed, version: "1.2" });
    assert.equal(sent.length, 1, "still waiting");
    pass(1);
    served = true;
    await reports.tell({ slug: "dust-runners", moment: InstallMoment.Opened, version: "1.2" });
    assert.equal(sent.length, 2, "asked again once the pause is over");
    assert.equal(field(sent, 1, "moment"), InstallMoment.Opened);
  });
});

describe("an app build's install moments: a game's page and what a report holds", () => {
  it("tells Offered or Blocked once per game per start of Genex, and nothing for a game here already or with no app", async () => {
    const { reports, sent } = await reporter({ token: TOKEN });
    const builds = [macBuild("1.2")];
    await reports.pageRead("dust-runners", builds, null);
    await reports.pageRead("dust-runners", builds, null);
    await reports.pageRead("iron-tide", [macBuild("1.0", NativeArch.X64)], null);
    await reports.pageRead("iron-tide", [macBuild("1.0", NativeArch.X64)], null);
    await reports.pageRead("web-only", [], null);
    const installed = {
      installed: [
        {
          slug: "puck-rush",
          title: "Puck Rush",
          coverUrl: null,
          version: "1.0",
          platform: NativePlatform.Mac,
          arch: NativeArch.Universal,
          bytes: 1,
          installedAt: "2026-11-01T00:00:00.000Z",
          lastPlayedAt: null,
        },
      ],
      progress: [],
    };
    await reports.pageRead("puck-rush", builds, installed);
    const installing = {
      installed: [],
      progress: [
        {
          slug: "frigate",
          version: "1.2",
          phase: InstallPhase.Downloading,
          receivedBytes: 1,
          totalBytes: 2,
          bytesPerSecond: null,
          etaMs: null,
          failure: null,
        },
      ],
    };
    await reports.pageRead("frigate", builds, installing);
    assert.deepEqual(
      sent.map((one) => [(one.body as { slug: string }).slug, (one.body as { moment: string }).moment]),
      [
        ["dust-runners", InstallMoment.Offered],
        ["iron-tide", InstallMoment.Blocked],
      ],
    );
  });

  it("sends nothing for a name that is not a game address", async () => {
    const { reports, sent } = await reporter({ token: TOKEN });
    for (const slug of ["../dust-runners", "Dust Runners", "", "a/b"]) {
      await reports.tell({ slug, moment: InstallMoment.Pressed, version: "1.2" });
      await reports.pageRead(slug, [macBuild("1.2")], null);
    }
    assert.deepEqual(sent, []);
  });

  it("sends a download's time as whole seconds, never below zero, and a missing version as none", async () => {
    const { reports, sent } = await reporter({ token: TOKEN });
    for (const seconds of [0.2, -3, Number.NaN, Number.POSITIVE_INFINITY])
      await reports.tell({ slug: "dust-runners", moment: InstallMoment.Downloaded, version: "1.2", seconds });
    await reports.tell({ slug: "dust-runners", moment: InstallMoment.Pressed, version: "" });
    assert.deepEqual(
      sent.map((one) => (one.body as { seconds: number | null }).seconds),
      [0, 0, null, null, null],
    );
    assert.equal(field(sent, -1, "version"), null);
  });
});

describe("this computer and its blocks as genex.games counts them", () => {
  it("names the system family of each computer Genex runs on", () => {
    const cases: Array<[NativeHost, OsFamily]> = [
      [APPLE_SILICON, OsFamily.MacArm],
      [{ ...APPLE_SILICON, rosetta: true }, OsFamily.MacArm],
      [{ platform: NativePlatform.Mac, arch: NativeArch.X64, osVersion: "13.6" }, OsFamily.MacIntel],
      [{ platform: NativePlatform.Windows, arch: NativeArch.X64, osVersion: "10.0.26100" }, OsFamily.Windows],
      [{ platform: NativePlatform.Windows, arch: NativeArch.Arm64, osVersion: "10.0.26100" }, OsFamily.Windows],
      [LINUX_PC, OsFamily.Linux],
      [{ platform: NativePlatform.Linux, arch: NativeArch.Arm64, osVersion: "6.8.0" }, OsFamily.Linux],
    ];
    for (const [host, family] of cases) assert.equal(osFamilyOf(host), family, `${host.platform} ${host.arch}`);
  });

  it("folds each reason a page gives for no build into the blocks genex.games counts", () => {
    const intelMac: NativeHost = { platform: NativePlatform.Mac, arch: NativeArch.X64, osVersion: "13.6" };
    const armLinux: NativeHost = { platform: NativePlatform.Linux, arch: NativeArch.Arm64, osVersion: "6.8.0" };
    const armWindows: NativeHost = { platform: NativePlatform.Windows, arch: NativeArch.Arm64, osVersion: "10.0" };
    const cases: Array<[WhyNotHere, NativeHost, InstallBlock]> = [
      [WhyNotHere.OldSystem, APPLE_SILICON, InstallBlock.OldSystem],
      [WhyNotHere.OldSystem, intelMac, InstallBlock.OldSystem],
      [WhyNotHere.AppleSilicon, intelMac, InstallBlock.MacIntel],
      [WhyNotHere.Processor, armLinux, InstallBlock.LinuxArm],
      [WhyNotHere.Processor, LINUX_PC, InstallBlock.Other],
      [WhyNotHere.Processor, armWindows, InstallBlock.Other],
      [WhyNotHere.Rosetta, APPLE_SILICON, InstallBlock.Other],
      [WhyNotHere.NoBuild, armLinux, InstallBlock.Other],
      [WhyNotHere.NoBuild, APPLE_SILICON, InstallBlock.Other],
      [WhyNotHere.System, LINUX_PC, InstallBlock.Other],
    ];
    for (const [why, host, block] of cases)
      assert.equal(installBlockOf(why, host), block, `${why} on ${host.platform} ${host.arch}`);
  });
});

const BUILD_HOST = "builds.example.test";
const ELF_X64 = 0x3e;

/** A 64-bit little-endian ELF program's header for x64. */
function elfX64(): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32BE(0x7f454c46, 0);
  bytes[4] = 2;
  bytes[5] = 1;
  bytes.writeUInt16LE(2, 16);
  bytes.writeUInt16LE(ELF_X64, 18);
  return bytes;
}

/** A Linux build, as `genex native publish` zips it. */
const LINUX_ITEMS: ZipItem[] = [
  { name: "Dust Runners/" },
  { name: "Dust Runners/Dust.x86_64", data: elfX64(), mode: 0o100755 },
];

/** A Linux catalog row for `archive`. */
const linuxBuild = (archive: Buffer, overrides: Partial<ZipBuild> = {}): ZipBuild => ({
  platform: NativePlatform.Linux,
  arch: NativeArch.X64,
  version: "1.0",
  sizeBytes: archive.length,
  installedBytes: archive.length * 4 + 1024 ** 2,
  sha256: createHash("sha256").update(archive).digest("hex"),
  url: `https://${BUILD_HOST}/dust-runners/1.0/linux.zip`,
  entry: "Dust Runners/Dust.x86_64",
  publishedAt: "2026-11-01T00:00:00.000Z",
  ...overrides,
});

/** A game's page with `builds`, as the catalog answers it. */
const gamePage = (slug: string, builds: NativeBuild[]): PlayGameDetail => ({
  id: `id-${slug}`,
  slug,
  title: "Dust Runners",
  description: "",
  coverUrl: null,
  clipUrl: null,
  multiplayer: false,
  plays: 0,
  online: null,
  author: { id: null, name: "Kir", imageUrl: null },
  remixable: false,
  assetKind: null,
  native: { web: false, engine: "unity", builds },
  likes: 0,
  liked: false,
  comments: 0,
  shots: [],
  updatedAt: null,
});

/**
 * An installer of `builds` on a Linux computer whose download takes `downloadMs` of its clock, held
 * until `hold` settles when one is given; every moment it tells is kept, through `moment` when given.
 */
async function momentInstaller(
  builds: NativeBuild[],
  archive: Buffer,
  options: { downloadMs?: number; hold?: Promise<void>; moment?: (news: InstallNews) => void } = {},
) {
  const root = path.join(await realpath(await tmpDir("install-moments-")), "installed-games");
  const told: InstallNews[] = [];
  let clock = 5_000_000;
  let downloading: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    downloading = resolve;
  });
  const fetchImpl = (async (_input: string | URL, init?: RequestInit) => {
    const signal = init?.signal;
    signal?.throwIfAborted();
    clock += options.downloadMs ?? 0;
    const { hold } = options;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        controller.enqueue(new Uint8Array(archive.subarray(0, 16)));
        downloading();
        if (hold) await hold;
        if (signal?.aborted) return controller.error(signal.reason);
        controller.enqueue(new Uint8Array(archive.subarray(16)));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-length": String(archive.length) } });
  }) as typeof fetch;
  const installs = nativeInstalls({
    root,
    host: LINUX_PC,
    hosts: new Set([BUILD_HOST]),
    game: async (slug) => gamePage(slug, builds),
    fetch: fetchImpl,
    run: runTool,
    freeBytes: async () => 100 * 1024 ** 3,
    now: () => clock,
    publish: () => {},
    moment: options.moment ?? ((news) => told.push(news)),
  });
  return { installs, told, started };
}

const MOMENTS_SKIP = process.platform === "win32" ? "a Linux build's execute bits need a unix disk" : false;

describe("the installer's moments", { skip: MOMENTS_SKIP }, () => {
  it("tells Pressed, Downloaded with the seconds the download took, then Installed, and Removed", async () => {
    const archive = writeZip(LINUX_ITEMS);
    const { installs, told } = await momentInstaller([linuxBuild(archive)], archive, { downloadMs: 12_400 });
    await installs.install("dust-runners");
    await installs.idle();
    await installs.uninstall("dust-runners");
    assert.deepEqual(told, [
      { slug: "dust-runners", moment: InstallMoment.Pressed, version: "1.0" },
      { slug: "dust-runners", moment: InstallMoment.Downloaded, version: "1.0", seconds: 12.4 },
      { slug: "dust-runners", moment: InstallMoment.Installed, version: "1.0" },
      { slug: "dust-runners", moment: InstallMoment.Removed, version: "1.0" },
    ]);
  });

  it("tells a failure by its code, and a press for a game with no build here as not offered", async () => {
    const archive = writeZip(LINUX_ITEMS);
    const broken = await momentInstaller([linuxBuild(archive, { sha256: "0".repeat(64) })], archive);
    await broken.installs.install("dust-runners");
    await broken.installs.idle();
    assert.deepEqual(
      broken.told.map((news) => [news.moment, "failure" in news ? news.failure : null]),
      [
        [InstallMoment.Pressed, null],
        [InstallMoment.Downloaded, null],
        [InstallMoment.Failed, InstallFailure.Checksum],
      ],
    );
    const elsewhere = await momentInstaller([macBuild("1.0")], archive);
    await elsewhere.installs.install("dust-runners");
    await elsewhere.installs.idle();
    assert.deepEqual(elsewhere.told, [
      { slug: "dust-runners", moment: InstallMoment.Pressed, version: null },
      { slug: "dust-runners", moment: InstallMoment.Failed, version: null, failure: InstallFailure.NotOffered },
    ]);
  });

  it("tells nothing more once an install is cancelled, and nothing for a removal of what is not here", async () => {
    const archive = writeZip(LINUX_ITEMS);
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { installs, told, started } = await momentInstaller([linuxBuild(archive)], archive, { hold });
    await installs.install("dust-runners");
    await started;
    await installs.cancel("dust-runners");
    release();
    await installs.idle();
    await installs.uninstall("dust-runners");
    assert.deepEqual(
      told.map((news) => news.moment),
      [InstallMoment.Pressed],
    );
  });

  it("installs as it would with no reporter when telling a moment throws", async () => {
    const archive = writeZip(LINUX_ITEMS);
    const { installs } = await momentInstaller([linuxBuild(archive)], archive, {
      moment: () => {
        throw new Error("the reporter broke");
      },
    });
    await installs.install("dust-runners");
    await installs.idle();
    assert.equal((await installs.record("dust-runners"))?.version, "1.0");
    await installs.uninstall("dust-runners");
    assert.equal(await installs.record("dust-runners"), null);
  });
});
