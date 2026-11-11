/**
 * The Publish card of a game made in an engine: one row per platform the person can act on, each
 * saying only what is true now and ending in its own button (Build on this computer or on Genex
 * Cloud, Publish, Update, Try again), and one big button that does everything (canvas "Publish to
 * every platform", round 3 of its redesign). A row's Build gives players nothing; the big button
 * builds what isn't built and gives players each platform as soon as it is ready.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HOUR_MS, MINUTE_MS } from "../../src/shared/duration.ts";
import {
  CloudBuildFailure,
  CloudBuildState,
  CloudSendState,
  GenexBuildReview,
  type GenexCloudBuild,
  GenexSendStage,
  type GenexNativeRecord,
} from "../../src/shared/genex.ts";
import { NativeArch } from "../../src/shared/play-native.ts";
import { type PublishPlatform, PublishPlatformState, PublishTarget } from "../../src/shared/publish-platforms.ts";
import {
  cardErrors,
  CardErrorKind,
  type CardInput,
  type CardRow,
  CardTone,
  CardWork,
  cardRows,
  followBar,
  followStep,
  leftWords,
  pressPlan,
  sendCalls,
} from "../../src/renderer/panels/plugins/genex/publish-card-view.ts";
import { WebOffer } from "../../src/renderer/panels/plugins/genex/publish-platforms-view.ts";

const NOW = Date.parse("2026-11-06T20:00:00Z");
const at = (agoMs: number): string => new Date(NOW - agoMs).toISOString();
const GAME_CHANGED = at(HOUR_MS);

/** A folder row: the web, or an app ready, older than the game, or missing. */
function platform(target: PublishTarget, state: PublishPlatformState, builtAgo?: number): PublishPlatform {
  const built = state !== PublishPlatformState.Missing && target !== PublishTarget.Web;
  return {
    target,
    state,
    arch: built ? NativeArch.Universal : null,
    bytes: built ? Math.round(3.2 * 1024 ** 3) : 0,
    builtAt: built && builtAgo !== undefined ? at(builtAgo) : null,
    uploads: state === PublishPlatformState.Ready,
    changedAt: GAME_CHANGED,
  };
}

const MISSING = PublishPlatformState.Missing;
const READY = PublishPlatformState.Ready;
const STALE = PublishPlatformState.Stale;

/** An Unreal game's folder on a Mac: a Mac app, nothing for Windows or Linux, no web build. */
const unrealFolder = (mac: PublishPlatformState, builtAgo = 2 * 24 * HOUR_MS): PublishPlatform[] => [
  platform(PublishTarget.Web, MISSING),
  platform(PublishTarget.Mac, mac, builtAgo),
  platform(PublishTarget.Windows, MISSING),
  platform(PublishTarget.Linux, MISSING),
];

/** The states of a build that made its app. */
const ENDED: ReadonlySet<CloudBuildState> = new Set([CloudBuildState.Done, CloudBuildState.Built]);

const cloudBuild = (
  state: CloudBuildState,
  startedAgo: number,
  extra: Partial<GenexCloudBuild> = {},
): GenexCloudBuild => ({
  platform: PublishTarget.Windows,
  jobId: `job-${startedAgo}`,
  state,
  startedAt: at(startedAgo),
  ...(ENDED.has(state) ? { finishedAt: at(startedAgo - 20 * MINUTE_MS) } : {}),
  ...extra,
});

/** A Windows app Genex Cloud built and keeps until a publish asks for it. */
const keptBuild = (startedAgo: number): GenexCloudBuild =>
  cloudBuild(CloudBuildState.Built, startedAgo, { held: true, installedBytes: Math.round(2.9 * 1024 ** 3) });

/** The record of a Mac app sent `sentAgo` ago and Genex Cloud's Windows builds. */
function record(
  sentAgo: number | null,
  builds: GenexCloudBuild[] = [],
  extra: Partial<GenexNativeRecord> = {},
): GenexNativeRecord {
  return {
    supported: true,
    sending: false,
    sent:
      sentAgo === null
        ? []
        : [
            {
              platform: PublishTarget.Mac,
              arch: NativeArch.Universal,
              version: "1",
              sizeBytes: 1,
              publishedAt: at(sentAgo),
            },
          ],
    failed: [],
    cloud: { supported: true, builds },
    ...extra,
  };
}

/** An Unreal game on a Mac: the Mac app is made here, the Windows app on Genex Cloud. */
const unreal = (platforms: PublishPlatform[], native: GenexNativeRecord, more: Partial<CardInput> = {}): CardRow[] =>
  cardRows({
    platforms,
    native,
    now: NOW,
    webOffer: WebOffer.Unavailable,
    madeHere: new Set([PublishTarget.Mac]),
    mac: true,
    ...more,
  });

/** A row as the card says it: its name, dot, line, end note, its own button's words, and the big button's work for it. */
const said = (rows: readonly CardRow[]) =>
  rows.map((row) => [row.name, row.tone, row.status, row.side, row.act?.label ?? null, row.work]);
const rowOf = (rows: readonly CardRow[], target: PublishTarget): CardRow | undefined =>
  rows.find((row) => row.target === target);

/** An Unreal game on a PC: the Windows and Linux apps are made here, one after the other. */
const unrealOnPc = (
  platforms: PublishPlatform[],
  native: GenexNativeRecord,
  more: Partial<CardInput> = {},
): CardRow[] =>
  cardRows({
    platforms,
    native,
    now: NOW,
    webOffer: WebOffer.Unavailable,
    madeHere: new Set([PublishTarget.Windows, PublishTarget.Linux]),
    mac: false,
    ...more,
  });

/** A Unity game on a Mac: the agent makes any of its apps, and its web version. */
const unity = (platforms: PublishPlatform[], more: Partial<CardInput> = {}): CardRow[] =>
  cardRows({
    platforms,
    native: record(null, [], { cloud: { supported: true, builds: [] } }),
    now: NOW,
    webOffer: WebOffer.Make,
    madeHere: null,
    hostedWeb: false,
    mac: true,
    ...more,
  });

/** A Unity game's folder with a web build and a Mac app, and nothing for Windows or Linux. */
const unityFolder = (): PublishPlatform[] => [
  platform(PublishTarget.Web, READY),
  platform(PublishTarget.Mac, READY, 10 * MINUTE_MS),
  platform(PublishTarget.Windows, MISSING),
  platform(PublishTarget.Linux, MISSING),
];

describe("the Publish card's rows", () => {
  it("says both apps are older than the game, and each row's button says where it is built", () => {
    const rows = unreal(
      unrealFolder(STALE),
      record(2 * 24 * HOUR_MS, [cloudBuild(CloudBuildState.Done, 13 * HOUR_MS)]),
    );
    assert.deepEqual(said(rows), [
      ["Mac", CardTone.Old, "Live · older than your game", null, "Build on Mac", CardWork.Build],
      ["Windows", CardTone.Old, "Live · older than your game", null, "Build on Genex Cloud", CardWork.Cloud],
    ]);
    const built = unreal(
      unrealFolder(READY, 2 * MINUTE_MS),
      record(2 * 24 * HOUR_MS, [cloudBuild(CloudBuildState.Done, 13 * HOUR_MS), keptBuild(HOUR_MS)]),
    );
    assert.deepEqual(said(built), [
      ["Mac", CardTone.Old, "Live · update ready", "3.2 GB", "Update", CardWork.Publish],
      ["Windows", CardTone.Old, "Live · update ready", "2.9 GB", "Update", CardWork.Release],
    ]);
  });

  it("counts a Windows app Genex Cloud built as live: never 'only Mac players'", () => {
    const folder = unrealFolder(READY, 30 * MINUTE_MS);
    const rows = unreal(folder, record(20 * MINUTE_MS, [cloudBuild(CloudBuildState.Done, 40 * MINUTE_MS)]));
    assert.deepEqual(said(rows), [
      ["Mac", CardTone.Live, "Live · up to date", "20 min ago", null, null],
      ["Windows", CardTone.Live, "Live · up to date", "20 min ago", null, null],
    ]);
    assert.equal(pressPlan(rows), null, "no big button once both are up to date");
    assert.deepEqual(
      rows.map((row) => row.live),
      [true, true],
      "each row's menu takes its platform down",
    );
  });

  it("shows no row for a platform this computer can't publish", () => {
    const rows = unreal(
      unrealFolder(READY, 30 * MINUTE_MS),
      record(null, [], { cloud: { supported: false, builds: [] } }),
    );
    assert.deepEqual(
      rows.map((row) => row.target),
      [PublishTarget.Mac],
      "no Windows row without Genex Cloud, no Linux row on a Mac, no web row for Unreal",
    );
  });

  it("says where an app is being built, with its loader and clock in the button's place", () => {
    const building = cloudBuild(CloudBuildState.Building, 8 * MINUTE_MS, { held: true });
    const rows = unreal(unrealFolder(READY, 30 * MINUTE_MS), record(20 * MINUTE_MS, [building]));
    const windows = rowOf(rows, PublishTarget.Windows);
    assert.deepEqual(
      [windows?.tone, windows?.status, windows?.busy, windows?.since, windows?.act, windows?.cloud],
      [CardTone.Working, "On Genex Cloud", "Building", building.startedAt, null, true],
    );
    const asked = new Map([[PublishTarget.Mac, at(5 * MINUTE_MS)]]);
    const mac = unreal(unrealFolder(STALE), record(2 * 24 * HOUR_MS), { asked })[0];
    assert.deepEqual(
      [mac?.tone, mac?.status, mac?.busy, mac?.since, mac?.act, mac?.here],
      [CardTone.Working, "On this Mac", "Building", at(5 * MINUTE_MS), null, true],
    );
    const pc = unrealOnPc(unrealFolder(MISSING), record(null), {
      asked: new Map([[PublishTarget.Windows, at(MINUTE_MS)]]),
    });
    assert.equal(rowOf(pc, PublishTarget.Windows)?.status, "On this PC");
  });

  it("hands the build back to its row once it lands, or when it never does", () => {
    const asked = new Map([[PublishTarget.Mac, at(5 * MINUTE_MS)]]);
    const landed = unreal(unrealFolder(READY, 2 * MINUTE_MS), record(2 * 24 * HOUR_MS), { asked })[0];
    assert.deepEqual(
      [landed?.tone, landed?.status, landed?.act?.label, landed?.work],
      [CardTone.Old, "Live · update ready", "Update", CardWork.Publish],
      "the new build waits for its Update: building gives players nothing",
    );
    const long = new Map([[PublishTarget.Mac, at(3 * HOUR_MS)]]);
    const never = unreal(unrealFolder(MISSING), record(null), { asked: long })[0];
    assert.deepEqual(
      [never?.status, never?.act?.label],
      ["Not built", "Build on Mac"],
      "an ask two hours old was never built",
    );
  });

  it("builds one app at a time on this computer: the next one waits, and says after which", () => {
    const together = new Map([
      [PublishTarget.Windows, at(3 * MINUTE_MS)],
      [PublishTarget.Linux, at(3 * MINUTE_MS)],
    ]);
    const rows = unrealOnPc(unrealFolder(MISSING), record(null), { asked: together });
    assert.deepEqual(
      rows.map((row) => [row.name, row.tone, row.status, row.busy, row.queued, row.act]),
      [
        ["Windows", CardTone.Working, "On this PC", "Building", false, null],
        ["Linux", CardTone.None, "Builds after Windows", null, true, null],
      ],
    );
    const linuxFirst = new Map([
      [PublishTarget.Windows, at(MINUTE_MS)],
      [PublishTarget.Linux, at(3 * MINUTE_MS)],
    ]);
    const other = unrealOnPc(unrealFolder(MISSING), record(null), { asked: linuxFirst });
    assert.deepEqual(
      other.map((row) => [row.name, row.status]),
      [
        ["Windows", "Builds after Linux"],
        ["Linux", "On this PC"],
      ],
      "the one asked for first builds first",
    );
    const folder = unrealFolder(MISSING).map((row) =>
      row.target === PublishTarget.Windows ? platform(PublishTarget.Windows, READY, MINUTE_MS) : row,
    );
    const next = unrealOnPc(folder, record(null), { asked: together });
    assert.deepEqual(
      next.map((row) => [row.name, row.status, row.act?.label ?? null, row.busy]),
      [
        ["Windows", "Ready to publish", "Publish", null],
        ["Linux", "On this PC", null, "Building"],
      ],
      "once the first is built the next one builds",
    );
  });

  it("says a project on its way to Genex Cloud is sending, with its clock", () => {
    const send = { platform: PublishTarget.Windows, startedAt: at(MINUTE_MS), state: CloudSendState.Sending };
    const rows = unreal(
      unrealFolder(READY, 30 * MINUTE_MS),
      record(20 * MINUTE_MS, [], { cloud: { supported: true, builds: [], send } }),
    );
    const windows = rowOf(rows, PublishTarget.Windows);
    assert.deepEqual(
      [windows?.status, windows?.busy, windows?.since, windows?.cloud],
      ["Sending to Genex Cloud", "Building", send.startedAt, true],
    );
  });

  it("carries how far a project on its way to Genex Cloud is, on its own row only", () => {
    const progress = { stage: GenexSendStage.Upload, doneBytes: 4, totalBytes: 10, at: NOW, target: "windows" };
    const send = { platform: PublishTarget.Windows, startedAt: at(MINUTE_MS), state: CloudSendState.Sending, progress };
    const rows = unreal(
      unrealFolder(READY, 30 * MINUTE_MS),
      record(20 * MINUTE_MS, [], { cloud: { supported: true, builds: [], send } }),
    );
    assert.deepEqual(
      rows.map((row) => [row.target, row.progress?.doneBytes]),
      [
        [PublishTarget.Mac, undefined],
        [PublishTarget.Windows, 4],
      ],
    );
  });

  it("carries how far an app being sent is, on the row of the app the CLI names", () => {
    const folder = [platform(PublishTarget.Mac, READY, MINUTE_MS), platform(PublishTarget.Windows, READY, MINUTE_MS)];
    const sending = (target: string | undefined) =>
      unreal(
        folder,
        record(null, [], {
          sending: true,
          progress: {
            stage: GenexSendStage.Upload,
            doneBytes: 7,
            totalBytes: 10,
            at: NOW,
            ...(target ? { target } : {}),
          },
        }),
      ).map((row) => [row.target, row.tone, row.busy, row.progress?.doneBytes]);
    assert.deepEqual(sending("windows-x64"), [
      [PublishTarget.Mac, CardTone.Working, "Publishing", undefined],
      [PublishTarget.Windows, CardTone.Working, "Publishing", 7],
    ]);
    assert.deepEqual(sending("mac-universal"), [
      [PublishTarget.Mac, CardTone.Working, "Publishing", 7],
      [PublishTarget.Windows, CardTone.Working, "Publishing", undefined],
    ]);
    // An app the CLI did not name is on no row: better no bar than one on the wrong app.
    assert.deepEqual(sending(undefined), [
      [PublishTarget.Mac, CardTone.Working, "Publishing", undefined],
      [PublishTarget.Windows, CardTone.Working, "Publishing", undefined],
    ]);
  });

  it("says an update is going when players have an older app of the one being sent", () => {
    const rows = unreal(unrealFolder(READY, 2 * MINUTE_MS), record(2 * 24 * HOUR_MS, [], { sending: true }));
    assert.deepEqual([rows[0]?.status, rows[0]?.busy], ["Sending to Genex", "Updating"]);
  });

  it("keeps the older app live when a cloud build fails: its row tries again, the big button only once the game changed", () => {
    const failedAt = (startedAgo: number, failure: CloudBuildFailure) =>
      cloudBuild(CloudBuildState.Failed, startedAgo, { failure, finishedAt: at(startedAgo - 5 * MINUTE_MS) });
    const windowsOf = (failed: GenexCloudBuild) =>
      rowOf(
        unreal(
          unrealFolder(READY, 30 * MINUTE_MS),
          record(20 * MINUTE_MS, [cloudBuild(CloudBuildState.Done, 2 * 24 * HOUR_MS), failed]),
        ),
        PublishTarget.Windows,
      );
    const same = windowsOf(failedAt(20 * MINUTE_MS, CloudBuildFailure.Compile));
    assert.deepEqual(
      [same?.tone, same?.status, same?.act, same?.work],
      [
        CardTone.Bad,
        "Couldn’t build · the older one is still live",
        { work: CardWork.Cloud, label: "Try again" },
        null,
      ],
      "the same project fails the same way: trying again is the person's call, never the big button's",
    );
    const changed = windowsOf(failedAt(3 * HOUR_MS, CloudBuildFailure.Compile));
    assert.deepEqual(
      [changed?.act?.label, changed?.work],
      ["Try again", CardWork.Cloud],
      "the game changed since: building again can help, so the big button builds it too",
    );
    const spent = windowsOf(failedAt(3 * HOUR_MS, CloudBuildFailure.Quota));
    assert.deepEqual([spent?.act, spent?.work], [null, null], "no builds left: no button that can't help");
  });

  it("says an app Genex reviews is in review, and one it turned down is not approved", () => {
    const pending = record(20 * MINUTE_MS);
    const [sent] = pending.sent;
    if (sent) sent.review = GenexBuildReview.Pending;
    const mac = unreal(unrealFolder(READY, 30 * MINUTE_MS), pending)[0];
    assert.deepEqual(
      [mac?.tone, mac?.status, mac?.act, mac?.work, mac?.live],
      [CardTone.Review, "In review", null, null, true],
    );
    if (sent) sent.review = GenexBuildReview.Rejected;
    const turned = unreal(unrealFolder(READY, 30 * MINUTE_MS), pending)[0];
    assert.deepEqual(
      [turned?.tone, turned?.status, turned?.act, turned?.work],
      [CardTone.Bad, "Not approved", null, null],
    );
    const newer = unreal(unrealFolder(READY, 5 * MINUTE_MS), pending)[0];
    assert.deepEqual(
      [newer?.act?.label, newer?.work],
      ["Publish", CardWork.Publish],
      "a newer build of a turned-down app can go: players never had it",
    );
  });

  it("says an app is not built, built before the game's last change, or ready to publish", () => {
    const windowsKept = record(null, [keptBuild(HOUR_MS)]);
    assert.deepEqual(said(unreal(unrealFolder(MISSING), record(null))), [
      ["Mac", CardTone.None, "Not built", null, "Build on Mac", CardWork.Build],
      ["Windows", CardTone.None, "Not built", null, "Build on Genex Cloud", CardWork.Cloud],
    ]);
    assert.deepEqual(said(unreal(unrealFolder(STALE), windowsKept)), [
      ["Mac", CardTone.None, "Built · older than your game", null, "Build on Mac", CardWork.Build],
      ["Windows", CardTone.Ready, "Ready to publish", "2.9 GB", "Publish", CardWork.Release],
    ]);
    assert.deepEqual(said(unreal(unrealFolder(READY, 10 * MINUTE_MS), windowsKept)), [
      ["Mac", CardTone.Ready, "Ready to publish", "3.2 GB", "Publish", CardWork.Publish],
      ["Windows", CardTone.Ready, "Ready to publish", "2.9 GB", "Publish", CardWork.Release],
    ]);
    assert.deepEqual(
      said(unrealOnPc(unrealFolder(MISSING), record(null))),
      [
        ["Windows", CardTone.None, "Not built", null, "Build on PC", CardWork.Build],
        ["Linux", CardTone.None, "Not built", null, "Build on PC", CardWork.Build],
      ],
      "a PC says PC",
    );
  });

  it("leaves a build Genex no longer keeps out: the app is not built", () => {
    const gone = cloudBuild(CloudBuildState.Failed, 20 * 24 * HOUR_MS, { failure: CloudBuildFailure.Expired });
    const windows = rowOf(unreal(unrealFolder(MISSING), record(null, [gone])), PublishTarget.Windows);
    assert.deepEqual([windows?.status, windows?.work], ["Not built", CardWork.Cloud]);
  });

  it("says nothing of an older failed build once a newer one was built and then dropped", () => {
    const failed = cloudBuild(CloudBuildState.Failed, 30 * 24 * HOUR_MS, {
      failure: CloudBuildFailure.Compile,
      errors: ["error C2065: 'Health': undeclared identifier"],
    });
    const gone = cloudBuild(CloudBuildState.Failed, 20 * 24 * HOUR_MS, { failure: CloudBuildFailure.Expired });
    const native = record(null, [failed, gone]);
    const windows = rowOf(unreal(unrealFolder(MISSING), native), PublishTarget.Windows);
    assert.deepEqual([windows?.tone, windows?.status, windows?.work], [CardTone.None, "Not built", CardWork.Cloud]);
    assert.deepEqual(cardErrors(unrealFolder(MISSING), native), [], "the game has built since: its old error is gone");
  });

  it("says a Windows app Genex Cloud built before the game's last change is older than the game, and builds it again", () => {
    // The game changed an hour ago; Genex Cloud built its Windows app three hours ago and keeps it.
    const older = keptBuild(3 * HOUR_MS);
    assert.deepEqual(said(unreal(unrealFolder(READY, 10 * MINUTE_MS), record(null, [older]))), [
      ["Mac", CardTone.Ready, "Ready to publish", "3.2 GB", "Publish", CardWork.Publish],
      ["Windows", CardTone.None, "Built · older than your game", null, "Build on Genex Cloud", CardWork.Cloud],
    ]);
    const live = record(2 * 24 * HOUR_MS, [cloudBuild(CloudBuildState.Done, 13 * HOUR_MS), older]);
    const windows = rowOf(unreal(unrealFolder(READY, 3 * 24 * HOUR_MS), live), PublishTarget.Windows);
    assert.deepEqual(
      [windows?.tone, windows?.status, windows?.work],
      [CardTone.Old, "Live · older than your game", CardWork.Cloud],
      "players keep the app they have until the new one is built",
    );
  });
});

describe("the Publish card's web row", () => {
  const web = (more: Partial<CardInput>, row: Partial<PublishPlatform> = {}): CardRow | undefined =>
    unity([{ ...platform(PublishTarget.Web, READY), ...row }], { native: record(null), ...more })[0];

  it("says whether the live web version is the game as it is now", () => {
    const current = web({ hostedWeb: true, webPublishedAt: at(10 * MINUTE_MS) });
    assert.deepEqual(
      [current?.status, current?.side, current?.act, current?.work],
      ["Live · up to date", "10 min ago", null, null],
    );
    const older = web({ hostedWeb: true, webPublishedAt: at(2 * HOUR_MS) });
    assert.deepEqual(
      [older?.tone, older?.status, older?.act?.label, older?.work],
      [CardTone.Old, "Live · update ready", "Update", CardWork.Publish],
      "the folder holds the newer build: Update sends it",
    );
  });

  it("takes a web build made after the last publish as newer than what players have, with no source changed", () => {
    // An engine's web build in the game's web folder: the folder says when it was made (`builtAt`).
    const built = (builtAgo: number) =>
      web(
        { hostedWeb: true, webPublishedAt: at(2 * HOUR_MS), mac: false },
        { builtAt: at(builtAgo), changedAt: at(3 * 24 * HOUR_MS) },
      );
    const rebuilt = built(20 * MINUTE_MS);
    assert.deepEqual([rebuilt?.status, rebuilt?.work], ["Live · update ready", CardWork.Publish]);
    const published = built(3 * HOUR_MS);
    assert.deepEqual(
      [published?.status, published?.side, published?.work],
      ["Live · up to date", "2 hours ago", null],
      "the build players have",
    );
    const sameBuild = built(2 * HOUR_MS - 30 * 1000);
    assert.equal(sameBuild?.status, "Live · up to date", "a file written within a minute of the publish is that build");
  });

  it("never calls the web version of a game Genex no longer lists live: the row offers Publish again", () => {
    // Genex keeps serving the build of a game taken back to a draft, and an upload since stamped the
    // last publish: the banner says Not published, so the row may not say Live and hide the button.
    const listedAs = (listed: boolean | undefined) =>
      web(
        { hostedWeb: true, ...(listed === undefined ? {} : { listed }), webPublishedAt: at(MINUTE_MS), mac: false },
        { changedAt: at(3 * 24 * HOUR_MS) },
      );
    const draft = listedAs(false);
    assert.deepEqual(
      [draft?.status, draft?.live, draft?.act?.label, draft?.work],
      ["Ready to publish", false, "Publish", CardWork.Publish],
      "a draft's web build waits for Publish",
    );
    const listed = listedAs(true);
    assert.deepEqual([listed?.status, listed?.side, listed?.work], ["Live · up to date", "1 min ago", null]);
    assert.equal(
      listedAs(undefined)?.status,
      "Live · up to date",
      "while Genex has not said, the build it plays counts",
    );
  });

  it("says the web version is on its way while it is published, in the publish's own words", () => {
    const progress = { stage: GenexSendStage.Upload, doneBytes: 4, totalBytes: 10, at: NOW };
    const going = web({ webSend: { status: "Uploading", since: at(MINUTE_MS), progress } });
    assert.deepEqual(
      [going?.tone, going?.status, going?.busy, going?.since, going?.progress?.doneBytes, going?.act, going?.work],
      [CardTone.Working, "Uploading", "Publishing", at(MINUTE_MS), 4, null, null],
    );
    const update = web({ hostedWeb: true, webSend: { status: "", since: null } });
    assert.deepEqual([update?.status, update?.busy], ["Sending to Genex", "Updating"]);
  });

  it("offers to build the web version the agent can make, and says so while it does", () => {
    const missing = [platform(PublishTarget.Web, MISSING)];
    const offered = unity(missing)[0];
    assert.deepEqual(
      [offered?.status, offered?.act?.label, offered?.work],
      ["Not built", "Build on Mac", CardWork.Build],
    );
    const asked = new Map([[PublishTarget.Web, at(MINUTE_MS)]]);
    const building = unity(missing, { asked })[0];
    assert.deepEqual([building?.status, building?.busy], ["On this Mac", "Building"]);
    assert.equal(web({ asked })?.status, "Ready to publish", "the build landed: the ask is answered");
    assert.deepEqual(unity(missing, { webOffer: WebOffer.Unavailable }), [], "no row for a web version nothing makes");
  });
});

describe("the Publish card's big button", () => {
  it("publishes what is ready and builds the rest, in one press", () => {
    const rows = unity(unityFolder());
    assert.deepEqual(
      rows.map((row) => [row.name, row.status, row.act?.label]),
      [
        ["Web", "Ready to publish", "Publish"],
        ["Mac", "Ready to publish", "Publish"],
        ["Windows", "Not built", "Build on Mac"],
        ["Linux", "Not built", "Build on Mac"],
      ],
    );
    assert.deepEqual(pressPlan(rows), {
      label: "Publish to all platforms",
      note: "Publishes Web and Mac now, Windows and Linux once they are built.",
      steps: [
        { target: PublishTarget.Windows, work: CardWork.Build },
        { target: PublishTarget.Linux, work: CardWork.Build },
        { target: PublishTarget.Web, work: CardWork.Publish },
        { target: PublishTarget.Mac, work: CardWork.Publish },
      ],
      follow: [PublishTarget.Web, PublishTarget.Mac, PublishTarget.Windows, PublishTarget.Linux],
      update: false,
    });
  });

  it("says nothing under it when all it does is send what is ready", () => {
    const rows = unreal(unrealFolder(READY, 40 * MINUTE_MS), record(null, [keptBuild(HOUR_MS)]));
    const plan = pressPlan(rows);
    assert.deepEqual(
      [plan?.label, plan?.note, plan?.steps],
      [
        "Publish to all platforms",
        null,
        [
          { target: PublishTarget.Mac, work: CardWork.Publish },
          { target: PublishTarget.Windows, work: CardWork.Release },
        ],
      ],
    );
  });

  it("builds both apps of an Unreal game on a Mac first, and says which one is slow", () => {
    const plan = pressPlan(unreal(unrealFolder(MISSING), record(null)));
    assert.deepEqual(plan, {
      label: "Publish to all platforms",
      note: "Builds Mac and Windows first. Windows can take up to an hour.",
      steps: [
        { target: PublishTarget.Mac, work: CardWork.Build },
        { target: PublishTarget.Windows, work: CardWork.Cloud },
      ],
      follow: [PublishTarget.Mac, PublishTarget.Windows],
      update: false,
    });
  });

  it("builds the app Genex Cloud makes too, beside one a row already builds", () => {
    const asked = new Map([[PublishTarget.Mac, at(2 * MINUTE_MS)]]);
    const plan = pressPlan(unreal(unrealFolder(MISSING), record(null), { asked }));
    assert.deepEqual(
      [plan?.note, plan?.steps, plan?.follow],
      [
        "Builds Windows too. It can take up to an hour.",
        [{ target: PublishTarget.Windows, work: CardWork.Cloud }],
        [PublishTarget.Mac, PublishTarget.Windows],
      ],
      "the build a row started is followed too: it goes to players once built",
    );
  });

  it("publishes the app that is built now and the other once it is built", () => {
    const plan = pressPlan(unreal(unrealFolder(READY, 10 * MINUTE_MS), record(null)));
    assert.deepEqual(
      [plan?.note, plan?.steps],
      [
        "Publishes Mac now, Windows once it is built.",
        [
          { target: PublishTarget.Windows, work: CardWork.Cloud },
          { target: PublishTarget.Mac, work: CardWork.Publish },
        ],
      ],
      "Mac never waits for Windows",
    );
  });

  it("builds the apps this PC makes, then publishes them by itself", () => {
    const live = { hostedWeb: true, webPublishedAt: at(MINUTE_MS) };
    const folder = [platform(PublishTarget.Web, READY), ...unrealFolder(MISSING).slice(1)];
    const rows = unrealOnPc(folder, record(null), live);
    assert.equal(rows[0]?.status, "Live · up to date");
    const plan = pressPlan(rows);
    assert.deepEqual(
      [plan?.label, plan?.note, plan?.follow],
      [
        "Publish to all platforms",
        "Builds Windows and Linux, then publishes them by itself.",
        [PublishTarget.Windows, PublishTarget.Linux],
      ],
    );
  });

  it("updates every platform players have: builds them again, or sends the one that is built", () => {
    const both = unreal(
      unrealFolder(STALE),
      record(2 * 24 * HOUR_MS, [cloudBuild(CloudBuildState.Done, 13 * HOUR_MS)]),
    );
    const again = pressPlan(both);
    assert.deepEqual(
      [again?.label, again?.note, again?.update],
      ["Update all platforms", "Builds Mac and Windows again, then updates them by itself.", true],
    );
    const held = cloudBuild(CloudBuildState.Building, 14 * MINUTE_MS, { held: true });
    const one = unreal(
      unrealFolder(READY, 2 * MINUTE_MS),
      record(2 * 24 * HOUR_MS, [cloudBuild(CloudBuildState.Done, 13 * HOUR_MS), held]),
    );
    const plan = pressPlan(one);
    assert.deepEqual(
      [plan?.label, plan?.note, plan?.steps],
      [
        "Update all platforms",
        "Updates Mac now, Windows once it is built.",
        [
          { target: PublishTarget.Mac, work: CardWork.Publish },
          { target: PublishTarget.Windows, work: CardWork.Release },
        ],
      ],
      "players have the game: the app Genex Cloud still builds is promised to them now",
    );
  });

  it("names what it builds in the rows' order, a build a row started among them", () => {
    const asked = new Map([[PublishTarget.Mac, at(MINUTE_MS)]]);
    const rows = unreal(
      unrealFolder(STALE),
      record(2 * 24 * HOUR_MS, [cloudBuild(CloudBuildState.Done, 13 * HOUR_MS)]),
      { asked },
    );
    assert.equal(rowOf(rows, PublishTarget.Mac)?.busy, "Building");
    assert.equal(pressPlan(rows)?.note, "Builds Mac and Windows again, then updates them by itself.");
  });

  it("follows a build a row started on its own: it goes to players once built", () => {
    const asked = new Map([[PublishTarget.Mac, at(3 * MINUTE_MS)]]);
    const rows = unreal(unrealFolder(MISSING), record(null, [], { cloud: { supported: false, builds: [] } }), {
      asked,
    });
    assert.deepEqual(pressPlan(rows), {
      label: "Publish to all platforms",
      note: "Publishes Mac once it is built.",
      steps: [],
      follow: [PublishTarget.Mac],
      update: false,
    });
  });

  it("never promises an app Genex Cloud still builds to a game with nothing to play", () => {
    const send = {
      platform: PublishTarget.Windows,
      startedAt: at(MINUTE_MS),
      state: CloudSendState.Sending,
      held: true,
    };
    const rows = unreal(unrealFolder(MISSING), record(null, [], { cloud: { supported: true, builds: [], send } }));
    const plan = pressPlan(rows);
    assert.deepEqual(
      [plan?.steps, plan?.follow],
      [[{ target: PublishTarget.Mac, work: CardWork.Build }], [PublishTarget.Mac, PublishTarget.Windows]],
      "Windows waits for the first app that goes: the follow promises it then",
    );
    const held = cloudBuild(CloudBuildState.Building, 5 * MINUTE_MS, { held: true });
    const live = unreal(unrealFolder(READY, 30 * MINUTE_MS), record(MINUTE_MS, [held]));
    const promised = pressPlan(live);
    assert.deepEqual(
      [promised?.label, promised?.note, promised?.steps],
      [
        "Publish to all platforms",
        "Publishes Windows once it is built.",
        [{ target: PublishTarget.Windows, work: CardWork.Release }],
      ],
      "Mac players have the game: Windows follows when built",
    );
  });

  it("has nothing to do for an app that is on its way to players already", () => {
    const released = cloudBuild(CloudBuildState.Building, 26 * MINUTE_MS);
    const rows = unreal(unrealFolder(READY, 30 * MINUTE_MS), record(MINUTE_MS, [released]));
    assert.deepEqual(said(rows), [
      ["Mac", CardTone.Live, "Live · up to date", "1 min ago", null, null],
      ["Windows", CardTone.Working, "On Genex Cloud", null, null, null],
    ]);
    assert.equal(pressPlan(rows), null, "nothing left to press: Windows goes live by itself");
    // A build asked for without keeping (a game with a page, from the platforms list) is no kept app.
    const send = { platform: PublishTarget.Windows, startedAt: at(MINUTE_MS), state: CloudSendState.Sending };
    const going = unreal(
      unrealFolder(READY, 30 * MINUTE_MS),
      record(20 * MINUTE_MS, [], { cloud: { supported: true, builds: [], send } }),
    );
    const windows = rowOf(going, PublishTarget.Windows);
    assert.deepEqual([windows?.making, windows?.work], [false, null]);
    assert.equal(pressPlan(going), null);
  });

  it("leaves a platform whose build failed to its own Try again", () => {
    const failed = cloudBuild(CloudBuildState.Failed, 20 * MINUTE_MS, {
      failure: CloudBuildFailure.Compile,
      finishedAt: at(15 * MINUTE_MS),
    });
    const rows = unreal(unrealFolder(READY, 30 * MINUTE_MS), record(20 * MINUTE_MS, [failed]));
    assert.deepEqual(
      rows.map((row) => [row.name, row.status, row.act?.label ?? null]),
      [
        ["Mac", "Live · up to date", null],
        ["Windows", "Couldn’t build", "Try again"],
      ],
    );
    assert.equal(pressPlan(rows), null, "a failed build stops only its own platform, and nothing else needs doing");
  });
});

describe("a followed press of the big button", () => {
  const MAC_AND_WINDOWS = [PublishTarget.Mac, PublishTarget.Windows];

  it("waits while the apps are built, and gives players nothing", () => {
    const asked = new Map([[PublishTarget.Mac, at(2 * MINUTE_MS)]]);
    const held = cloudBuild(CloudBuildState.Building, 2 * MINUTE_MS, { held: true });
    const rows = unreal(unrealFolder(MISSING), record(null, [held]), { asked });
    assert.deepEqual(followStep(rows, MAC_AND_WINDOWS), { send: [], left: MAC_AND_WINDOWS });
  });

  it("sends the app that landed, and promises the one Genex Cloud still builds with it", () => {
    const asked = new Map([[PublishTarget.Mac, at(20 * MINUTE_MS)]]);
    const held = cloudBuild(CloudBuildState.Building, 20 * MINUTE_MS, { held: true });
    const rows = unreal(unrealFolder(READY, 2 * MINUTE_MS), record(null, [held]), { asked });
    assert.deepEqual(followStep(rows, MAC_AND_WINDOWS), {
      send: [
        { target: PublishTarget.Mac, work: CardWork.Publish },
        { target: PublishTarget.Windows, work: CardWork.Release },
      ],
      left: MAC_AND_WINDOWS,
    });
  });

  it("sends the app Genex Cloud built first on its own: each goes live as soon as it is ready", () => {
    const asked = new Map([[PublishTarget.Mac, at(40 * MINUTE_MS)]]);
    const rows = unreal(unrealFolder(MISSING), record(null, [keptBuild(50 * MINUTE_MS)]), { asked });
    assert.deepEqual(followStep(rows, MAC_AND_WINDOWS), {
      send: [{ target: PublishTarget.Windows, work: CardWork.Release }],
      left: MAC_AND_WINDOWS,
    });
  });

  it("sends only the platforms the press named", () => {
    const rows = unreal(unrealFolder(READY, 40 * MINUTE_MS), record(null, [keptBuild(50 * MINUTE_MS)]));
    assert.deepEqual(followStep(rows, [PublishTarget.Windows]), {
      send: [{ target: PublishTarget.Windows, work: CardWork.Release }],
      left: [PublishTarget.Windows],
    });
  });

  it("keeps a platform while it is sent, and lets it go once players have it", () => {
    const sending = unreal(unrealFolder(READY, 2 * MINUTE_MS), record(null, [], { sending: true }));
    assert.deepEqual(followStep(sending, [PublishTarget.Mac]), { send: [], left: [PublishTarget.Mac] });
    const live = unreal(unrealFolder(READY, 30 * MINUTE_MS), record(MINUTE_MS));
    assert.deepEqual(followStep(live, [PublishTarget.Mac]), { send: [], left: [] });
  });

  it("never sends again what was just sent: the record takes a moment to say it is on its way", () => {
    const rows = unreal(unrealFolder(READY, 2 * MINUTE_MS), record(null));
    const settling = new Set([PublishTarget.Mac]);
    assert.deepEqual(followStep(rows, [PublishTarget.Mac], settling), { send: [], left: [PublishTarget.Mac] });
  });

  it("lets a platform go as soon as players have it, however lately it was sent", () => {
    const live = unreal(unrealFolder(READY, 30 * MINUTE_MS), record(MINUTE_MS));
    const settling = new Set([PublishTarget.Mac]);
    assert.deepEqual(followStep(live, [PublishTarget.Mac], settling), { send: [], left: [] });
  });

  it("stops following a platform whose build failed or never landed, and only that one", () => {
    const failed = cloudBuild(CloudBuildState.Failed, 20 * MINUTE_MS, { failure: CloudBuildFailure.Compile });
    const asked = new Map([[PublishTarget.Mac, at(20 * MINUTE_MS)]]);
    const rows = unreal(unrealFolder(MISSING), record(null, [failed]), { asked });
    assert.deepEqual(followStep(rows, MAC_AND_WINDOWS), { send: [], left: [PublishTarget.Mac] });
    const never = unreal(unrealFolder(MISSING), record(null, [failed]), {
      asked: new Map([[PublishTarget.Mac, at(3 * HOUR_MS)]]),
    });
    assert.deepEqual(followStep(never, MAC_AND_WINDOWS), { send: [], left: [] });
  });

  it("says how many of the card's platforms players have while it goes", () => {
    const asked = new Map([[PublishTarget.Linux, at(MINUTE_MS)]]);
    const folder = [
      platform(PublishTarget.Web, READY),
      platform(PublishTarget.Mac, READY, 30 * MINUTE_MS),
      platform(PublishTarget.Windows, READY, 2 * MINUTE_MS),
      platform(PublishTarget.Linux, MISSING),
    ];
    const rows = unity(folder, {
      native: record(20 * MINUTE_MS, [], { sending: true }),
      hostedWeb: true,
      webPublishedAt: at(40 * MINUTE_MS),
      asked,
    });
    assert.deepEqual(followBar(rows, false), {
      label: "Publishing to all platforms · 2 of 4 live",
      note: "Each one goes live as soon as it’s ready. You can close this window.",
    });
    assert.equal(followBar(rows, true).label, "Updating all platforms · 2 of 4 updated");
  });
});

describe("what a press sends", () => {
  it("sends the apps behind the web publish, and what Genex Cloud made on its own after it", () => {
    assert.deepEqual(
      sendCalls([
        { target: PublishTarget.Web, work: CardWork.Publish },
        { target: PublishTarget.Mac, work: CardWork.Publish },
        { target: PublishTarget.Windows, work: CardWork.Release },
      ]),
      { web: [PublishTarget.Mac], apps: { platforms: [], release: [PublishTarget.Windows] } },
    );
  });

  it("sends the web version alone, with no app behind it", () => {
    assert.deepEqual(sendCalls([{ target: PublishTarget.Web, work: CardWork.Publish }]), { web: [], apps: null });
  });

  it("sends apps on their own, with what Genex Cloud made", () => {
    assert.deepEqual(
      sendCalls([
        { target: PublishTarget.Mac, work: CardWork.Publish },
        { target: PublishTarget.Windows, work: CardWork.Release },
      ]),
      { web: null, apps: { platforms: [PublishTarget.Mac], release: [PublishTarget.Windows] } },
    );
    assert.deepEqual(sendCalls([{ target: PublishTarget.Mac, work: CardWork.Build }]), { web: null, apps: null });
  });

  it("says how long a send has left to the minute, never less than one", () => {
    assert.deepEqual([20 * 1000, 2 * MINUTE_MS, 2 * MINUTE_MS + 1, HOUR_MS + 20 * MINUTE_MS].map(leftWords), [
      "1m left",
      "2m left",
      "3m left",
      "1h 20m left",
    ]);
  });
});

describe("the Publish card's error blocks", () => {
  it("names a failed Genex Cloud build and hands over its whole log, never showing it", () => {
    const failed = cloudBuild(CloudBuildState.Failed, 10 * MINUTE_MS, {
      failure: CloudBuildFailure.Compile,
      errors: ["Weapon.cpp(88): 'FVector' undeclared", "Weapon.cpp(90): ';' expected"],
    });
    const errors = cardErrors(unrealFolder(READY, 30 * MINUTE_MS), record(20 * MINUTE_MS, [failed]));
    assert.deepEqual(errors, [
      {
        target: PublishTarget.Windows,
        kind: CardErrorKind.Build,
        title: "Windows build error",
        text: "Weapon.cpp(88): 'FVector' undeclared\nWeapon.cpp(90): ';' expected",
      },
    ]);
  });

  it("names an app that didn't reach Genex, and its row sends it again", () => {
    const native = record(null, [], {
      failed: [{ platform: PublishTarget.Mac, arch: "universal", error: "HTTP 413" }],
    });
    const folder = unrealFolder(READY, 10 * MINUTE_MS);
    assert.deepEqual(cardErrors(folder, native), [
      { target: PublishTarget.Mac, kind: CardErrorKind.Send, title: "Mac app didn’t send", text: "HTTP 413" },
    ]);
    const mac = unreal(folder, native)[0];
    assert.deepEqual(
      [mac?.status, mac?.act, mac?.work],
      ["Couldn’t send", { work: CardWork.Publish, label: "Try again" }, null],
      "Try again is the row's own, never the big button's",
    );
  });

  it("names a Windows build that didn't start, and its row starts it again", () => {
    const send = {
      platform: PublishTarget.Windows,
      startedAt: at(2 * MINUTE_MS),
      state: CloudSendState.Failed,
      error: "This account has used its builds for this month.",
    };
    const native = record(null, [], { cloud: { supported: true, builds: [], send } });
    const folder = unrealFolder(MISSING);
    assert.deepEqual(cardErrors(folder, native), [
      {
        target: PublishTarget.Windows,
        kind: CardErrorKind.Start,
        title: "Windows build didn’t start",
        text: "This account has used its builds for this month.",
      },
    ]);
    const asked = new Map([[PublishTarget.Mac, at(2 * MINUTE_MS)]]);
    const rows = unreal(folder, native, { asked });
    const windows = rowOf(rows, PublishTarget.Windows);
    assert.deepEqual(
      [windows?.tone, windows?.status, windows?.act, windows?.work],
      [CardTone.Bad, "Couldn’t send", { work: CardWork.Cloud, label: "Try again" }, null],
    );
    assert.equal(rowOf(rows, PublishTarget.Mac)?.busy, "Building", "the Mac app builds on");
    const closed = { platform: PublishTarget.Windows, startedAt: at(2 * MINUTE_MS), state: CloudSendState.Failed };
    const stopped = record(null, [], { cloud: { supported: true, builds: [], send: closed } });
    assert.deepEqual(
      cardErrors(folder, stopped).map((error) => [error.kind, error.text]),
      [[CardErrorKind.Start, ""]],
      "stopped with Studio: no words to copy",
    );
  });

  it("has no block once the app went after all", () => {
    const native = record(5 * MINUTE_MS, [], {
      failed: [{ platform: PublishTarget.Mac, arch: "universal", error: "HTTP 413" }],
    });
    assert.deepEqual(cardErrors(unrealFolder(READY, 10 * MINUTE_MS), native), []);
  });
});
