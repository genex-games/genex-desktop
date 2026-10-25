/**
 * The Publish dialog's platform rows: the web build as Publish sends it, and the Mac, Windows and
 * Linux apps the game folder holds, ready, built before the game's last change, or not made. A built app shows
 * "Coming soon" until genex.games takes apps, and its players are told they get the web version; an
 * app not made offers to ask the agent, in the game's own words.
 */
import assert from "node:assert/strict";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { publishedApps, publishPlatforms } from "../../src/main/core/publish-platforms.ts";
import { GenexBuildReview, type GenexNativeRecord } from "../../src/shared/genex.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { CoreFact } from "../../src/shared/project-facts.ts";
import { NativeArch } from "../../src/shared/play-native.ts";
import {
  linuxBuildOf,
  type PublishPlatform,
  PublishPlatformState,
  PublishTarget,
} from "../../src/shared/publish-platforms.ts";
import {
  appsInReview,
  appsMadeOnly,
  appsUpToDate,
  appsLabel,
  failureLines,
  gateByPlugin,
  rebuildAsk,
  makesApps,
  nothingToPublish,
  listingLine,
  listsPlatforms,
  onlyApps,
  makeAppAsk,
  makeWebAsk,
  PlatformEnd,
  platformRows,
  reachLine,
  WebOffer,
  webOfferFor,
} from "../../src/renderer/panels/plugins/genex/publish-platforms-view.ts";
import { tmpDir } from "../helpers/tmp.ts";

const CPU_ARM64 = 0x0100000c;
const CPU_X86_64 = 0x01000007;
const T0 = Date.parse("2026-10-20T08:00:00Z");

/** A universal Mac app at `dir/name.app`, its program written at `at`. */
async function macApp(dir: string, name: string, at: number): Promise<void> {
  const bundle = path.join(dir, `${name}.app`, "Contents");
  await mkdir(path.join(bundle, "MacOS"), { recursive: true });
  await writeFile(
    path.join(bundle, "Info.plist"),
    "<plist><dict><key>CFBundleExecutable</key><string>Game</string></dict></plist>",
  );
  const header = Buffer.alloc(8 + 2 * 20);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(CPU_ARM64, 8);
  header.writeUInt32BE(CPU_X86_64, 28);
  const program = path.join(bundle, "MacOS", "Game");
  await writeFile(program, header);
  await utimes(program, new Date(at), new Date(at));
}

/** A 64-bit x86 Linux program at `file`, written at `at`. */
async function linuxProgram(file: string, at: number): Promise<void> {
  const header = Buffer.alloc(64);
  header.writeUInt32BE(0x7f454c46, 0);
  header[4] = 2;
  header[5] = 1;
  header.writeUInt16LE(2, 16);
  header.writeUInt16LE(0x3e, 18);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, header);
  await utimes(file, new Date(at), new Date(at));
}

/** A source file of the game, last changed at `at`. */
async function source(root: string, file: string, at: number): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), "// the game");
  await utimes(path.join(root, file), new Date(at), new Date(at));
}

/** A core that lists one game with `facts`, in `dir`. */
function coreWith(name: string, dir: string, facts: Array<{ id: string; path: string }>) {
  return {
    games: { list: async () => [{ name, facts }] },
    pluginBinding: async (project?: string) => (project === name ? { project: name, directory: dir } : undefined),
  } as unknown as Parameters<typeof publishPlatforms>[0];
}

const byTarget = (rows: PublishPlatform[]) => Object.fromEntries(rows.map((row) => [row.target, row]));

describe("Publish's platform rows from the game folder", () => {
  it("lists the web build, a ready Mac app and a Windows app not made yet", async () => {
    const root = await tmpDir("publish-platforms-");
    await source(root, "src/main.js", T0);
    await macApp(path.join(root, "Builds", "Mac"), "Dust Runners", T0 + 10 * MINUTE_MS);
    const rows = byTarget(await publishPlatforms(coreWith("dust", root, []), "dust", false));
    assert.deepEqual(
      [rows.web.state, rows.web.uploads],
      [PublishPlatformState.Ready, true],
      "a web game's own build is what Publish sends",
    );
    assert.equal(rows.mac.state, PublishPlatformState.Ready);
    assert.equal(rows.mac.arch, NativeArch.Universal);
    assert.ok(rows.mac.bytes > 0);
    assert.equal(rows.mac.uploads, false, "a CLI without `genex native` sends no app");
    assert.deepEqual(
      [rows.windows.state, rows.windows.bytes, rows.windows.builtAt],
      [PublishPlatformState.Missing, 0, null],
    );
  });

  it("calls an app built before the game's last change old, and an engine game's web row not made", async () => {
    const root = await tmpDir("publish-platforms-");
    await macApp(path.join(root, "Builds", "Mac"), "Dust Runners", T0);
    await source(root, "Assets/Scripts/Player.cs", T0 + 20 * MINUTE_MS);
    const engine = [{ id: CoreFact.UnrealProject, path: "." }];
    const rows = byTarget(await publishPlatforms(coreWith("dust", root, engine), "dust"));
    assert.equal(rows.mac.state, PublishPlatformState.Stale);
    assert.deepEqual([rows.web.state, rows.web.uploads], [PublishPlatformState.Missing, false]);
  });

  it("keeps an app built within a minute of the last change ready, whatever the engine's caches do", async () => {
    const root = await tmpDir("publish-platforms-");
    await macApp(path.join(root, "Builds", "Mac"), "Dust Runners", T0);
    await source(root, "Assets/Scripts/Player.cs", T0 + 30_000);
    // An engine's own caches and history change all the time: they are not the game's change.
    await source(root, "Library/ShaderCache/a.bin", T0 + 40 * MINUTE_MS);
    await source(root, ".git/index", T0 + 40 * MINUTE_MS);
    const rows = byTarget(await publishPlatforms(coreWith("dust", root, []), "dust"));
    assert.equal(rows.mac.state, PublishPlatformState.Ready);
  });

  it("sends a ready app with Publish once the CLI can, and never one built before the last change", async () => {
    const root = await tmpDir("publish-platforms-");
    await source(root, "Assets/Scripts/Player.cs", T0);
    await macApp(path.join(root, "Builds", "Mac"), "Dust Runners", T0 + 10 * MINUTE_MS);
    const core = coreWith("dust", root, []);
    assert.equal(byTarget(await publishPlatforms(core, "dust", true)).mac.uploads, true);
    assert.deepEqual(await publishedApps(core, "dust", true), ["Builds/Mac/Dust Runners.app"]);
    assert.deepEqual(await publishedApps(core, "dust", false), [], "an older CLI sends none");
    await source(root, "Assets/Scripts/Player.cs", T0 + 30 * MINUTE_MS);
    assert.equal(byTarget(await publishPlatforms(core, "dust", true)).mac.uploads, false);
    assert.deepEqual(await publishedApps(core, "dust", true), []);
  });

  it("keeps an app ready when only notes, editor state or Finder's files changed after it", async () => {
    const root = await tmpDir("publish-platforms-");
    await source(root, "unity/Assets/Scripts/TicTacToe.cs", T0);
    await macApp(path.join(root, "unity", "Builds", "Mac"), "Simple Fast Tic Tac Toe", T0 + 10 * MINUTE_MS);
    // What an agent and the editor write after a build: the game is the same game.
    const later = T0 + 30 * MINUTE_MS;
    await source(root, "NOTES.md", later);
    await source(root, "unity/UserSettings/Layouts/default-6000.dwlt", later);
    await source(root, ".studio/player.log", later);
    await source(root, "unity/.DS_Store", later);
    await source(root, "unity/Assets/.DS_Store", later);
    await source(root, "unity/.vscode/settings.json", later);
    await source(root, "unity/build.log", later);
    const rows = byTarget(await publishPlatforms(coreWith("ttt", root, []), "ttt", true));
    assert.equal(rows.mac.state, PublishPlatformState.Ready);
    await source(root, "unity/ProjectSettings/ProjectSettings.asset", later);
    const changed = byTarget(await publishPlatforms(coreWith("ttt", root, []), "ttt", true));
    assert.equal(changed.mac.state, PublishPlatformState.Stale, "a project setting is the game's");
  });

  it("lists a Linux app beside the others, and sends it with Publish while it is not older than the game", async () => {
    const root = await tmpDir("publish-platforms-");
    await source(root, "unity/Assets/Scripts/Player.cs", T0);
    await mkdir(path.join(root, "unity", "Builds", "Linux", "Dust_Data"), { recursive: true });
    await linuxProgram(path.join(root, "unity", "Builds", "Linux", "Dust.x86_64"), T0 + 10 * MINUTE_MS);
    const core = coreWith("dust", root, []);
    const rows = await publishPlatforms(core, "dust", true);
    assert.deepEqual(
      rows.map((row) => row.target),
      [PublishTarget.Web, PublishTarget.Mac, PublishTarget.Windows, PublishTarget.Linux],
    );
    const linux = byTarget(rows).linux;
    assert.deepEqual([linux?.state, linux?.arch, linux?.uploads], [PublishPlatformState.Ready, NativeArch.X64, true]);
    assert.deepEqual(await publishedApps(core, "dust", true), ["unity/Builds/Linux/Dust.x86_64"]);
    await source(root, "unity/Assets/Scripts/Player.cs", T0 + 30 * MINUTE_MS);
    assert.equal(byTarget(await publishPlatforms(core, "dust", true)).linux?.state, PublishPlatformState.Stale);
    assert.deepEqual(await publishedApps(core, "dust", true), []);
  });

  it("keeps an Unreal Linux package ready when only its own files are newer than its program", async () => {
    const root = await tmpDir("publish-platforms-");
    await source(root, "Source/Dust/Dust.cpp", T0);
    const pack = path.join(root, "Packaged", "Linux");
    await linuxProgram(path.join(pack, "Dust", "Binaries", "Linux", "Dust-Linux-Shipping"), T0 + 10 * MINUTE_MS);
    // Staging writes the paks and the starter after the program: they are the build's, not the game's.
    await source(root, "Packaged/Linux/Dust/Content/Paks/Dust-Linux.pak", T0 + 20 * MINUTE_MS);
    await source(root, "Packaged/Linux/Dust.sh", T0 + 20 * MINUTE_MS);
    const rows = byTarget(await publishPlatforms(coreWith("dust", root, []), "dust", true));
    assert.equal(rows.linux?.state, PublishPlatformState.Ready);
  });

  it("refuses a game that is not in the library", async () => {
    const root = await tmpDir("publish-platforms-");
    const core = coreWith("dust", root, []);
    await assert.rejects(publishPlatforms(core, "elsewhere"));
    await assert.rejects(publishPlatforms(core, "../dust"));
    await assert.rejects(publishPlatforms(core, 7));
  });
});

const NOW = T0 + 5 * MINUTE_MS;
const WEB: PublishPlatform = {
  target: PublishTarget.Web,
  state: PublishPlatformState.Ready,
  arch: null,
  bytes: 0,
  builtAt: null,
  uploads: true,
};
const MAC: PublishPlatform = {
  target: PublishTarget.Mac,
  state: PublishPlatformState.Ready,
  arch: NativeArch.Universal,
  bytes: 1.4 * 1024 ** 3,
  builtAt: new Date(T0).toISOString(),
  uploads: false,
};
const WINDOWS_READY: PublishPlatform = {
  target: PublishTarget.Windows,
  state: PublishPlatformState.Ready,
  arch: NativeArch.X64,
  bytes: 900 * 1024 ** 2,
  builtAt: new Date(T0).toISOString(),
  uploads: true,
};
const LINUX: PublishPlatform = {
  target: PublishTarget.Linux,
  state: PublishPlatformState.Ready,
  arch: NativeArch.X64,
  bytes: 700 * 1024 ** 2,
  builtAt: new Date(T0).toISOString(),
  uploads: true,
};
const WINDOWS: PublishPlatform = {
  target: PublishTarget.Windows,
  state: PublishPlatformState.Missing,
  arch: null,
  bytes: 0,
  builtAt: null,
  uploads: false,
};

describe("Publish's platform rows as the dialog says them", () => {
  it("says what each build runs on, when it was built, its size and what the row offers", () => {
    const rows = platformRows([WEB, MAC, WINDOWS], NOW);
    assert.deepEqual(
      rows.map((row) => [row.name, row.detail, row.end]),
      [
        ["Web", "Plays right away", PlatformEnd.None],
        ["Mac app", "Apple silicon and Intel · built 5 min ago", PlatformEnd.Soon],
        ["Windows app", "Not made yet", PlatformEnd.Make],
      ],
    );
    assert.match(rows[1]?.size ?? "", /GB/);
    assert.equal(rows[2]?.size, null);
    const stale = platformRows([{ ...MAC, state: PublishPlatformState.Stale }], NOW)[0];
    assert.equal(stale?.detail, "Built before your last change");
    const sent = platformRows([{ ...MAC, uploads: true }], NOW)[0];
    assert.equal(sent?.end, PlatformEnd.None, "an app Publish sends offers nothing more");
  });

  it("says where an Unreal game's app for another system is packaged, and offers no agent for it", () => {
    const unreal = [{ id: CoreFact.UnrealProject, path: "unreal" }];
    assert.equal(appsMadeOnly(unreal, "darwin"), PublishTarget.Mac);
    assert.equal(appsMadeOnly(unreal, "win32"), PublishTarget.Windows);
    assert.equal(appsMadeOnly([{ id: CoreFact.UnityProject, path: "unity" }], "darwin"), null, "Unity builds any");
    const missingMac = { ...MAC, state: PublishPlatformState.Missing, arch: null, bytes: 0, builtAt: null };
    const staleLinux = { ...LINUX, state: PublishPlatformState.Stale };
    const onMac = platformRows(
      [WEB, missingMac, WINDOWS, staleLinux],
      NOW,
      undefined,
      WebOffer.Unavailable,
      PublishTarget.Mac,
    );
    assert.deepEqual(
      onMac.slice(1).map((row) => [row.name, row.detail, row.end]),
      [
        ["Mac app", "Not made yet", PlatformEnd.Make],
        ["Windows app", "Package it on a Windows PC", PlatformEnd.None],
        ["Linux app", "Built before your last change", PlatformEnd.None],
      ],
    );
    const onWindows = platformRows(
      [missingMac, WINDOWS_READY],
      NOW,
      undefined,
      WebOffer.Unavailable,
      PublishTarget.Windows,
    );
    assert.deepEqual(
      onWindows.map((row) => [row.detail, row.end]),
      [
        ["Package it on a Mac", PlatformEnd.None],
        ["64-bit PCs · built 5 min ago", PlatformEnd.None],
      ],
      "this computer's own app goes as before",
    );
  });

  it("names a Linux app, what it runs on and its players", () => {
    const rows = platformRows([WEB, MAC, WINDOWS, LINUX, { ...LINUX, arch: NativeArch.Arm64 }], NOW);
    assert.deepEqual(
      rows.slice(3).map((row) => [row.name, row.detail]),
      [
        ["Linux app", "64-bit PCs · built 5 min ago"],
        ["Linux app", "Arm PCs · built 5 min ago"],
      ],
    );
    const missing = { ...LINUX, state: PublishPlatformState.Missing, arch: null, bytes: 0, builtAt: null };
    assert.equal(platformRows([missing], NOW)[0]?.end, PlatformEnd.Make);
    assert.equal(
      makeAppAsk(PublishTarget.Linux, "Dust Runners"),
      "Make a Linux app of Dust Runners so I can publish it for Linux players.",
    );
    assert.equal(
      reachLine([WEB, { ...MAC, uploads: true }, WINDOWS, LINUX]),
      "Publish also sends the Mac and Linux apps. Windows players get the web version.",
    );
    const noWeb = { ...WEB, state: PublishPlatformState.Missing, uploads: false };
    assert.equal(appsLabel([noWeb, MAC, WINDOWS, LINUX]), "Publish Linux app");
    assert.equal(reachLine([noWeb, MAC, WINDOWS, LINUX]), "Only Linux players can play it.");
  });

  it("says when a build was made in words a person reads", () => {
    const at = (ms: number) => platformRows([{ ...MAC, builtAt: new Date(NOW - ms).toISOString() }], NOW)[0]?.detail;
    assert.equal(at(10_000), "Apple silicon and Intel · built just now");
    assert.equal(at(3 * 60 * MINUTE_MS), "Apple silicon and Intel · built 3 hours ago");
    assert.equal(at(2 * 24 * 60 * MINUTE_MS), "Apple silicon and Intel · built 2 days ago");
  });

  it("lists platforms for an engine game or a folder with an app, and not for a plain web game", () => {
    assert.equal(listsPlatforms([WEB, { ...MAC, state: PublishPlatformState.Missing }, WINDOWS], false), false);
    assert.equal(listsPlatforms([WEB, { ...MAC, state: PublishPlatformState.Missing }, WINDOWS], true), true);
    assert.equal(listsPlatforms([WEB, MAC, WINDOWS], false), true);
  });

  it("tells which players get the web version, and which apps go with Publish", () => {
    assert.equal(reachLine([WEB, MAC, WINDOWS]), "Mac and Windows players get the web version.");
    assert.equal(
      reachLine([WEB, { ...MAC, uploads: true }, WINDOWS]),
      "Publish also sends the Mac app. Windows players get the web version.",
    );
    assert.equal(
      reachLine([WEB, { ...MAC, uploads: true }, WINDOWS_READY]),
      "Publish also sends the Mac and Windows apps.",
    );
    assert.equal(
      reachLine([{ ...WEB, state: PublishPlatformState.Missing }, MAC, WINDOWS]),
      "Publishing Mac, Windows and Linux apps comes with the next Genex update.",
      "a game with no web build says why its press waits",
    );
  });

  it("says on an app's row that it is being sent, is on Genex, or was not sent and why", () => {
    const ready = { ...MAC, uploads: true };
    const record = (over: Partial<GenexNativeRecord>): GenexNativeRecord => ({
      supported: true,
      sending: false,
      sent: [],
      failed: [],
      ...over,
    });
    const macEnd = (native?: GenexNativeRecord) => platformRows([WEB, ready, WINDOWS], NOW, native)[1]?.end;
    assert.equal(macEnd(), PlatformEnd.None, "before Publish, the line under the rows says it goes");
    assert.equal(macEnd(record({ sending: true })), PlatformEnd.Sending);
    const live = { platform: "mac", arch: "universal", version: "1.0+3f2a9c1d0e4b", sizeBytes: 1, publishedAt: "" };
    assert.equal(
      macEnd(record({ sent: [{ ...live, publishedAt: new Date(T0 + MINUTE_MS).toISOString() }] })),
      PlatformEnd.Sent,
    );
    assert.equal(
      macEnd(record({ sent: [{ ...live, publishedAt: new Date(T0 - MINUTE_MS).toISOString() }] })),
      PlatformEnd.None,
      "a build made after the one on Genex goes with the next Publish",
    );
    const failed = record({
      failed: [{ platform: "mac", arch: "", error: "Couldn't get an upload token (HTTP 413)." }],
    });
    assert.equal(macEnd(failed), PlatformEnd.Failed);
    assert.deepEqual(failureLines([WEB, ready, WINDOWS], failed), [
      "Couldn’t send the Mac app: Couldn't get an upload token (HTTP 413).",
    ]);
    assert.deepEqual(failureLines([WEB, ready, WINDOWS], record({})), []);
    const reviewed = (review: GenexBuildReview, reviewReason?: string) =>
      record({
        sent: [
          {
            ...live,
            publishedAt: new Date(T0 + MINUTE_MS).toISOString(),
            review,
            ...(reviewReason && { reviewReason }),
          },
        ],
      });
    assert.equal(macEnd(reviewed(GenexBuildReview.Pending)), PlatformEnd.Review);
    assert.equal(macEnd(reviewed(GenexBuildReview.Approved)), PlatformEnd.Sent);
    assert.equal(macEnd(reviewed(GenexBuildReview.Rejected)), PlatformEnd.Rejected);
    assert.deepEqual(failureLines([WEB, ready, WINDOWS], reviewed(GenexBuildReview.Rejected, "It opens a shell.")), [
      "Genex didn’t approve the Mac app: It opens a shell.",
    ]);
    assert.deepEqual(failureLines([WEB, ready, WINDOWS], reviewed(GenexBuildReview.Rejected)), [
      "Genex didn’t approve the Mac app.",
    ]);
  });

  it("has nothing new to send for a game whose apps are all on Genex already", () => {
    const noWeb = { ...WEB, state: PublishPlatformState.Missing, uploads: false };
    const ready = { ...MAC, uploads: true };
    const live = { platform: "mac", arch: "universal", version: "1.0+3f2a9c1d0e4b", sizeBytes: 1 };
    const native = (publishedAt: number, over: Partial<GenexNativeRecord> = {}): GenexNativeRecord => ({
      supported: true,
      sending: false,
      sent: [{ ...live, publishedAt: new Date(publishedAt).toISOString() }],
      failed: [],
      ...over,
    });
    assert.equal(appsUpToDate([noWeb, ready, WINDOWS], native(T0 + MINUTE_MS)), true);
    assert.equal(appsUpToDate([noWeb, ready, WINDOWS], native(T0 - MINUTE_MS)), false, "a newer build waits to go");
    assert.equal(appsUpToDate([noWeb, ready, WINDOWS], native(T0 + MINUTE_MS, { sending: true })), false);
    assert.equal(
      appsUpToDate([noWeb, ready, WINDOWS_READY], native(T0 + MINUTE_MS)),
      false,
      "the Windows app is not sent",
    );
    assert.equal(appsUpToDate([WEB, ready], native(T0 + MINUTE_MS)), false, "a web game always publishes its build");
    assert.equal(appsUpToDate([noWeb, ready], undefined), false, "never published");
    const reviewed = (review: GenexBuildReview) =>
      native(T0 + MINUTE_MS, { sent: [{ ...live, publishedAt: new Date(T0 + MINUTE_MS).toISOString(), review }] });
    assert.equal(appsUpToDate([noWeb, ready], reviewed(GenexBuildReview.Pending)), true, "Genex reviews what went");
    assert.equal(
      appsUpToDate([noWeb, ready], reviewed(GenexBuildReview.Rejected)),
      false,
      "a turned-down app goes again",
    );
  });

  it("publishes a game that has only apps as its apps, and says how its listing went", () => {
    const noWeb = { ...WEB, state: PublishPlatformState.Missing, uploads: false };
    const ready = { ...MAC, uploads: true };
    assert.equal(onlyApps([noWeb, ready, WINDOWS]), true);
    assert.equal(onlyApps([WEB, ready, WINDOWS]), false, "a web game publishes as one");
    assert.equal(onlyApps([noWeb, MAC, WINDOWS]), false, "an app that cannot go is nothing to publish");
    assert.equal(appsLabel([noWeb, ready, WINDOWS]), "Publish Mac app");
    assert.equal(appsLabel([noWeb, ready, WINDOWS_READY]), "Publish Mac and Windows apps");
    assert.equal(reachLine([noWeb, ready, WINDOWS]), "Only Mac players can play it.");
    const record = (over: Partial<GenexNativeRecord>): GenexNativeRecord => ({
      supported: true,
      sending: false,
      sent: [
        { platform: "mac", arch: "universal", version: "1", sizeBytes: 1, publishedAt: new Date(NOW).toISOString() },
      ],
      failed: [],
      ...over,
    });
    const rows = [noWeb, ready, WINDOWS];
    assert.equal(listingLine(rows, record({ listing: { state: "published", detail: null } })), null);
    assert.equal(
      listingLine(rows, record({ listing: { state: "held", detail: null } })),
      "Sent for review. It appears in Play once Genex approves it.",
    );
    assert.equal(
      listingLine(rows, record({})),
      "The apps are on Genex, but the game isn’t in the gallery yet. Publish again to list it.",
    );
    assert.equal(listingLine(rows, record({ sending: true })), null, "nothing is said while the apps go");
    const turnedDown = record({});
    turnedDown.sent = turnedDown.sent.map((app) => ({ ...app, review: GenexBuildReview.Rejected }));
    assert.equal(listingLine(rows, turnedDown), null, "a turned-down app says why on its own line");
    assert.equal(listingLine([WEB, ready, WINDOWS], record({})), null, "a web game is listed by its web publish");
  });

  it("knows a game with only apps waits for Genex's review: no celebration until then", () => {
    const noWeb = { ...WEB, state: PublishPlatformState.Missing, uploads: false };
    const ready = { ...MAC, uploads: true };
    const app = {
      platform: "mac",
      arch: "universal",
      version: "1",
      sizeBytes: 1,
      publishedAt: new Date(NOW).toISOString(),
    };
    const record = (...reviews: (GenexBuildReview | undefined)[]): GenexNativeRecord => ({
      supported: true,
      sending: false,
      sent: reviews.map((review) => ({ ...app, ...(review && { review }) })),
      failed: [],
    });
    assert.equal(appsInReview([noWeb, ready], record(GenexBuildReview.Pending)), true);
    assert.equal(appsInReview([noWeb, ready], record(GenexBuildReview.Pending, GenexBuildReview.Approved)), false);
    assert.equal(appsInReview([noWeb, ready], record(undefined)), false, "a Genex without review lists it at once");
    assert.equal(appsInReview([WEB, ready], record(GenexBuildReview.Pending)), false, "its web version went live");
    assert.equal(appsInReview([noWeb, ready], { ...record(GenexBuildReview.Pending), sending: true }), false);
    assert.equal(appsInReview([noWeb, ready], undefined), false);
  });

  it("offers Publish for apps to a Unity, Godot or Unreal game, by its facts", () => {
    assert.equal(makesApps([{ id: CoreFact.UnityProject, path: "unity" }]), true);
    assert.equal(makesApps([{ id: CoreFact.GodotProject, path: "godot" }]), true);
    assert.equal(makesApps([{ id: CoreFact.UnrealProject, path: "." }]), true);
    assert.equal(makesApps([{ id: CoreFact.WebGame, path: "." }]), false);
    assert.equal(makesApps([{ id: CoreFact.BlenderAssets, path: "." }]), false);
    assert.equal(makesApps([]), false);
  });

  it("says what a game made in an engine needs before Publish can send anything", () => {
    const noWeb = { ...WEB, state: PublishPlatformState.Missing, uploads: false };
    const noMac = { ...MAC, state: PublishPlatformState.Missing, arch: null, bytes: 0, builtAt: null };
    assert.equal(nothingToPublish([noWeb, noMac, WINDOWS]), true);
    assert.equal(reachLine([noWeb, noMac, WINDOWS]), "Make a Mac, Windows or Linux app first, then publish it here.");
    assert.equal(
      reachLine([noWeb, noMac, WINDOWS], false, WebOffer.Make),
      "Make a web version or a Mac, Windows or Linux app first, then publish it here.",
      "a Unity or Godot game can start with its web version",
    );
    assert.equal(nothingToPublish([noWeb, MAC, WINDOWS]), true, "an app Studio cannot send yet");
    assert.equal(
      reachLine([noWeb, MAC, WINDOWS]),
      "Publishing Mac, Windows and Linux apps comes with the next Genex update.",
    );
    assert.equal(nothingToPublish([noWeb, { ...MAC, uploads: true }, WINDOWS]), false);
    assert.equal(nothingToPublish([WEB, noMac, WINDOWS]), false, "a web game publishes its web build");
  });

  it("offers to build an app again when it is older than the game's last change, and says so", () => {
    const noWeb = { ...WEB, state: PublishPlatformState.Missing, uploads: false };
    const stale = { ...MAC, state: PublishPlatformState.Stale, uploads: false };
    assert.equal(platformRows([noWeb, stale, WINDOWS], NOW)[1]?.end, PlatformEnd.Rebuild);
    assert.equal(platformRows([WEB, stale, WINDOWS], NOW)[1]?.end, PlatformEnd.Rebuild, "a web game's too");
    assert.equal(
      reachLine([noWeb, stale, WINDOWS]),
      "The Mac app is older than your last change: build it again, then publish.",
    );
    assert.equal(
      rebuildAsk(PublishTarget.Mac, "Simple Fast Tic Tac Toe"),
      "Build the Mac app of Simple Fast Tic Tac Toe again so I can publish it.",
    );
  });

  it("sends apps only through a Genex plugin that can, and says to update an older one", () => {
    const noWeb = { ...WEB, state: PublishPlatformState.Missing, uploads: false };
    const ready = { ...MAC, uploads: true };
    const record = (supported: boolean): GenexNativeRecord => ({ supported, sending: false, sent: [], failed: [] });
    assert.deepEqual(gateByPlugin([noWeb, ready, WINDOWS], record(true)).platforms[1], ready);
    const older = gateByPlugin([noWeb, ready, WINDOWS], undefined);
    assert.equal(older.platforms[1]?.uploads, false, "a plugin from before apps answers no record");
    assert.equal(older.behind, true);
    assert.equal(reachLine(older.platforms, older.behind), "Update the Genex plugin in Plugins to publish apps.");
    assert.equal(gateByPlugin([noWeb, ready, WINDOWS], record(false)).behind, true);
    assert.equal(gateByPlugin([noWeb, MAC, WINDOWS], undefined).behind, false, "nothing it could send anyway");
  });

  it("asks the agent for an app in the game's own name", () => {
    assert.equal(
      makeAppAsk(PublishTarget.Windows, "Dust Runners"),
      "Make a Windows app of Dust Runners so I can publish it for Windows players.",
    );
  });

  it("offers a Unity or Godot game a web version from the agent, and tells an Unreal game it has none", () => {
    const noWeb = { ...WEB, state: PublishPlatformState.Missing, uploads: false };
    const webRow = (offer: WebOffer) => platformRows([noWeb, MAC, WINDOWS], NOW, undefined, offer)[0];
    assert.deepEqual(
      [
        webOfferFor([{ id: CoreFact.UnityProject, path: "unity" }]),
        webOfferFor([{ id: CoreFact.GodotProject, path: "." }]),
      ],
      [WebOffer.Make, WebOffer.Make],
    );
    assert.equal(webOfferFor([{ id: CoreFact.UnrealProject, path: "." }]), WebOffer.Unavailable);
    assert.equal(webOfferFor([{ id: CoreFact.WebGame, path: "." }]), WebOffer.Quiet);
    assert.deepEqual([webRow(WebOffer.Make)?.detail, webRow(WebOffer.Make)?.end], ["Not made yet", PlatformEnd.Make]);
    assert.deepEqual(
      [webRow(WebOffer.Unavailable)?.detail, webRow(WebOffer.Unavailable)?.end],
      ["Unreal games don’t run in a browser", PlatformEnd.None],
    );
    assert.deepEqual(
      [webRow(WebOffer.Quiet)?.detail, webRow(WebOffer.Quiet)?.end],
      ["Not set up for the web", PlatformEnd.None],
    );
    const ready = platformRows([WEB, MAC, WINDOWS], NOW, undefined, WebOffer.Make)[0];
    assert.equal(ready?.end, PlatformEnd.None, "a web version made already offers nothing");
    assert.equal(
      makeWebAsk("Simple Fast Tic Tac Toe"),
      "Make a web version of Simple Fast Tic Tac Toe so I can publish it on the web.",
    );
  });
});

describe("what a Linux build ships", () => {
  it("is a Unity or Godot program's own folder, and an Unreal package's root", () => {
    assert.deepEqual(linuxBuildOf("unity/Builds/Linux/Dust.x86_64"), {
      folder: "unity/Builds/Linux",
      entry: "Dust.x86_64",
    });
    assert.deepEqual(linuxBuildOf("Packaged/Linux/Dust/Binaries/Linux/Dust-Linux-Shipping"), {
      folder: "Packaged/Linux",
      entry: "Dust/Binaries/Linux/Dust-Linux-Shipping",
    });
    assert.deepEqual(linuxBuildOf("Pack/Dust/Binaries/LinuxArm64/Dust"), {
      folder: "Pack",
      entry: "Dust/Binaries/LinuxArm64/Dust",
    });
  });

  it("is nothing for a program at the game folder's root, whose folder would be the whole game", () => {
    assert.equal(linuxBuildOf("Dust.x86_64"), null);
  });
});
