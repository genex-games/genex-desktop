/**
 * The Publish card of a game made in an engine: one row per platform the person can act on, each
 * saying only what is true now, a switch for whether players get it, and one button whose words say
 * what it does (canvas "Publish to every platform", round 4).
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
  type GenexNativeRecord,
} from "../../src/shared/genex.ts";
import { NativeArch } from "../../src/shared/play-native.ts";
import { type PublishPlatform, PublishPlatformState, PublishTarget } from "../../src/shared/publish-platforms.ts";
import {
  busyPress,
  cardErrors,
  CardErrorKind,
  type CardInput,
  type CardRow,
  CardTone,
  CardWork,
  cardRows,
  pressPlan,
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

const cloudBuild = (
  state: CloudBuildState,
  startedAgo: number,
  extra: Partial<GenexCloudBuild> = {},
): GenexCloudBuild => ({
  platform: PublishTarget.Windows,
  jobId: `job-${startedAgo}`,
  state,
  startedAt: at(startedAgo),
  ...(state === CloudBuildState.Done ? { finishedAt: at(startedAgo - 20 * MINUTE_MS) } : {}),
  ...extra,
});

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

const said = (rows: readonly CardRow[]) => rows.map((row) => [row.name, row.tone, row.status, row.side, row.work]);
const NO_SWITCHES = new Map<PublishTarget, boolean>();

describe("the Publish card's rows", () => {
  it("says both apps are older than the game, and how each gets built", () => {
    const rows = unreal(
      unrealFolder(STALE),
      record(2 * 24 * HOUR_MS, [cloudBuild(CloudBuildState.Done, 13 * HOUR_MS)]),
    );
    assert.deepEqual(said(rows), [
      ["Mac", CardTone.Old, "Live · older than your game", "builds on this Mac", CardWork.Build],
      ["Windows", CardTone.Old, "Live · older than your game", "builds on Genex Cloud", CardWork.Cloud],
    ]);
    const build = pressPlan(rows, NO_SWITCHES);
    assert.deepEqual(
      [build?.label, build?.steps],
      ["Build Mac", [{ target: PublishTarget.Mac, work: CardWork.Build }]],
      "the agent builds first: nothing goes to players before a second press",
    );
    const built = unreal(
      unrealFolder(READY, 2 * MINUTE_MS),
      record(2 * 24 * HOUR_MS, [cloudBuild(CloudBuildState.Done, 13 * HOUR_MS)]),
    );
    const update = pressPlan(built, NO_SWITCHES);
    assert.equal(update?.label, "Update Mac and Windows");
    assert.deepEqual(update?.steps, [
      { target: PublishTarget.Mac, work: CardWork.Publish },
      { target: PublishTarget.Windows, work: CardWork.Cloud },
    ]);
  });

  it("counts a Windows app Genex Cloud built as live: never 'only Mac players'", () => {
    const folder = unrealFolder(READY, 30 * MINUTE_MS);
    const rows = unreal(folder, record(20 * MINUTE_MS, [cloudBuild(CloudBuildState.Done, 40 * MINUTE_MS)]));
    assert.deepEqual(said(rows), [
      ["Mac", CardTone.Live, "Live · up to date", "20 min ago", null],
      ["Windows", CardTone.Live, "Live · up to date", "20 min ago", null],
    ]);
    assert.equal(pressPlan(rows, NO_SWITCHES), null, "nothing to press once both are up to date");
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

  it("builds on Genex Cloud with a clock, and the busy button says the wait can be long", () => {
    const building = cloudBuild(CloudBuildState.Building, 8 * MINUTE_MS);
    const rows = unreal(
      unrealFolder(READY, 30 * MINUTE_MS),
      record(20 * MINUTE_MS, [cloudBuild(CloudBuildState.Done, 2 * 24 * HOUR_MS), building]),
    );
    const windows = rows.find((row) => row.target === PublishTarget.Windows);
    assert.deepEqual(
      [windows?.tone, windows?.status, windows?.since, windows?.cloud],
      [CardTone.Working, "Building on Genex Cloud", building.startedAt, true],
    );
    assert.deepEqual(busyPress(rows), { label: "Updating Windows", since: building.startedAt, cloud: true });
  });

  it("says a project on its way to Genex Cloud is sending, with its clock", () => {
    const send = { platform: PublishTarget.Windows, startedAt: at(MINUTE_MS), state: CloudSendState.Sending };
    const rows = unreal(
      unrealFolder(READY, 30 * MINUTE_MS),
      record(20 * MINUTE_MS, [], { cloud: { supported: true, builds: [], send } }),
    );
    const windows = rows.find((row) => row.target === PublishTarget.Windows);
    assert.deepEqual(
      [windows?.status, windows?.since, windows?.cloud],
      ["Sending to Genex Cloud", send.startedAt, true],
    );
  });

  it("keeps the older app live when a cloud build fails, and builds again only once the game changed", () => {
    const failedAt = (startedAgo: number, failure: CloudBuildFailure) =>
      cloudBuild(CloudBuildState.Failed, startedAgo, { failure, finishedAt: at(startedAgo - 5 * MINUTE_MS) });
    const windowsOf = (failed: GenexCloudBuild) =>
      unreal(
        unrealFolder(READY, 30 * MINUTE_MS),
        record(20 * MINUTE_MS, [cloudBuild(CloudBuildState.Done, 2 * 24 * HOUR_MS), failed]),
      ).find((row) => row.target === PublishTarget.Windows);
    const same = windowsOf(failedAt(20 * MINUTE_MS, CloudBuildFailure.Compile));
    assert.deepEqual(
      [same?.tone, same?.status, same?.work],
      [CardTone.Bad, "Couldn’t build · the older one is still live", null],
      "the same project fails the same way: the agent fixes it first",
    );
    const changed = windowsOf(failedAt(3 * HOUR_MS, CloudBuildFailure.Compile));
    assert.equal(changed?.work, CardWork.Cloud, "the game changed since: building again can help");
    const spent = windowsOf(failedAt(3 * HOUR_MS, CloudBuildFailure.Quota));
    assert.equal(spent?.work, null, "no builds left: trying again can't help");
  });

  it("says an app Genex reviews is in review, and one it turned down is not approved", () => {
    const pending = record(20 * MINUTE_MS);
    const [sent] = pending.sent;
    if (sent) sent.review = GenexBuildReview.Pending;
    const mac = unreal(unrealFolder(READY, 30 * MINUTE_MS), pending)[0];
    assert.deepEqual([mac?.tone, mac?.status, mac?.work, mac?.live], [CardTone.Review, "In review", null, true]);
    if (sent) sent.review = GenexBuildReview.Rejected;
    const turned = unreal(unrealFolder(READY, 30 * MINUTE_MS), pending)[0];
    assert.deepEqual([turned?.tone, turned?.status, turned?.work], [CardTone.Bad, "Not approved", null]);
    const newer = unreal(unrealFolder(READY, 5 * MINUTE_MS), pending)[0];
    assert.equal(newer?.work, CardWork.Publish, "a newer build of a turned-down app can go");
  });

  it("says the agent is building an app it was asked for until the new build lands", () => {
    const asked = new Map([[PublishTarget.Mac, at(5 * MINUTE_MS)]]);
    const stale = unreal(unrealFolder(STALE), record(2 * 24 * HOUR_MS), { asked })[0];
    assert.deepEqual(
      [stale?.tone, stale?.status, stale?.since],
      [CardTone.Working, "Building on this Mac", at(5 * MINUTE_MS)],
    );
    const landed = unreal(unrealFolder(READY, 2 * MINUTE_MS), record(2 * 24 * HOUR_MS), { asked })[0];
    assert.deepEqual(
      [landed?.tone, landed?.work],
      [CardTone.Old, CardWork.Publish],
      "the new build waits for the press",
    );
  });
});

describe("the Publish card's button", () => {
  /** A Unity game on a Mac with a web build and a Mac app, published nowhere yet. */
  const unityRows = (): CardRow[] =>
    cardRows({
      platforms: [
        platform(PublishTarget.Web, READY),
        platform(PublishTarget.Mac, READY, 10 * MINUTE_MS),
        platform(PublishTarget.Windows, MISSING),
        platform(PublishTarget.Linux, MISSING),
      ],
      native: record(null, [], { cloud: { supported: true, builds: [] } }),
      now: NOW,
      webOffer: WebOffer.Make,
      madeHere: null,
      hostedWeb: false,
      mac: true,
    });

  it("starts with what is ready switched on and names it", () => {
    const rows = unityRows();
    assert.deepEqual(
      rows.map((row) => [row.name, row.status, row.on, row.work]),
      [
        ["Web", "Not published", true, CardWork.Publish],
        ["Mac", "Not published", true, CardWork.Publish],
        ["Windows", "Not published", false, CardWork.Build],
        ["Linux", "Not published", false, CardWork.Build],
      ],
    );
    assert.equal(pressPlan(rows, NO_SWITCHES)?.label, "Publish to web and Mac");
  });

  it("builds the apps the agent makes first, alone, and counts from three platforms", () => {
    const both = new Map([
      [PublishTarget.Windows, true],
      [PublishTarget.Linux, true],
    ]);
    const build = pressPlan(unityRows(), both);
    assert.deepEqual(
      [build?.label, build?.steps.map((step) => step.work)],
      ["Build Windows and Linux", [CardWork.Build, CardWork.Build]],
    );
    const windowsBuilt = cardRows({
      platforms: [
        platform(PublishTarget.Web, READY),
        platform(PublishTarget.Mac, READY, 10 * MINUTE_MS),
        platform(PublishTarget.Windows, READY, 5 * MINUTE_MS),
        platform(PublishTarget.Linux, MISSING),
      ],
      native: record(null),
      now: NOW,
      webOffer: WebOffer.Make,
      madeHere: null,
      hostedWeb: false,
      mac: true,
    });
    assert.equal(pressPlan(windowsBuilt, NO_SWITCHES)?.label, "Publish to 3 platforms");
  });

  it("publishes an Unreal game's Mac app and has Genex Cloud build its Windows app the first time", () => {
    const rows = unreal(unrealFolder(READY, 10 * MINUTE_MS), record(null));
    assert.deepEqual(said(rows), [
      ["Mac", CardTone.None, "Not published", "3.2 GB", CardWork.Publish],
      ["Windows", CardTone.None, "Not published", "builds on Genex Cloud", CardWork.Cloud],
    ]);
    assert.equal(pressPlan(rows, NO_SWITCHES)?.label, "Publish to Mac and Windows");
  });

  it("takes a live platform down when its switch goes off, and warns", () => {
    const rows = unreal(
      unrealFolder(READY, 30 * MINUTE_MS),
      record(20 * MINUTE_MS, [cloudBuild(CloudBuildState.Done, 40 * MINUTE_MS)]),
    );
    const plan = pressPlan(rows, new Map([[PublishTarget.Windows, false]]));
    assert.deepEqual(plan, {
      label: "Take Windows down",
      steps: [{ target: PublishTarget.Windows, work: CardWork.TakeDown }],
      warn: true,
    });
  });

  it("says both when it updates one platform and takes another down", () => {
    const rows = unreal(
      unrealFolder(READY, 2 * MINUTE_MS),
      record(2 * 24 * HOUR_MS, [cloudBuild(CloudBuildState.Done, 40 * MINUTE_MS)]),
    );
    const plan = pressPlan(rows, new Map([[PublishTarget.Windows, false]]));
    assert.equal(plan?.label, "Update Mac and take Windows down");
    assert.equal(plan?.warn, false);
  });

  it("leaves Genex Cloud out until the game has a page on Genex or this press makes one", () => {
    const rows = unreal(unrealFolder(MISSING), record(null));
    assert.deepEqual(
      rows.map((row) => [row.target, row.work]),
      [
        [PublishTarget.Mac, CardWork.Build],
        [PublishTarget.Windows, CardWork.Cloud],
      ],
    );
    assert.equal(pressPlan(rows, new Map([[PublishTarget.Mac, false]]), false), null, "no page to build on yet");
    assert.equal(pressPlan(rows, new Map([[PublishTarget.Mac, false]]), true)?.label, "Publish to Windows");
  });

  it("says the agent is building while it builds", () => {
    const asked = new Map([[PublishTarget.Mac, at(3 * MINUTE_MS)]]);
    const rows = unreal(unrealFolder(STALE), record(2 * 24 * HOUR_MS), { asked });
    assert.deepEqual(busyPress(rows), { label: "Building Mac", since: at(3 * MINUTE_MS), cloud: false });
  });

  it("says whether the live web version is the game as it is now", () => {
    const web = (publishedAgo: number) =>
      cardRows({
        platforms: [platform(PublishTarget.Web, READY)],
        native: record(null),
        now: NOW,
        webOffer: WebOffer.Make,
        madeHere: null,
        hostedWeb: true,
        webPublishedAt: at(publishedAgo),
        mac: true,
      })[0];
    const current = web(10 * MINUTE_MS);
    assert.deepEqual([current?.status, current?.side, current?.work], ["Live · up to date", "10 min ago", null]);
    const older = web(2 * HOUR_MS);
    assert.deepEqual([older?.status, older?.work], ["Live · older than your game", CardWork.Publish]);
    assert.equal(pressPlan(older ? [older] : [], NO_SWITCHES)?.label, "Update web");
  });

  it("leaves a platform off when its switch is off and it isn't live", () => {
    const rows = unityRows();
    const plan = pressPlan(rows, new Map([[PublishTarget.Web, false]]));
    assert.equal(plan?.label, "Publish to Mac");
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

  it("names an app that didn't reach Genex, and its row leaves the retry to the block", () => {
    const native = record(null, [], {
      failed: [{ platform: PublishTarget.Mac, arch: "universal", error: "HTTP 413" }],
    });
    const folder = unrealFolder(READY, 10 * MINUTE_MS);
    assert.deepEqual(cardErrors(folder, native), [
      { target: PublishTarget.Mac, kind: CardErrorKind.Send, title: "Mac app didn’t send", text: "HTTP 413" },
    ]);
    const mac = unreal(folder, native)[0];
    assert.deepEqual(
      [mac?.status, mac?.work],
      ["Couldn’t send", null],
      "Try again is the block's, not the main button's",
    );
  });

  it("has no block once the app went after all", () => {
    const native = record(5 * MINUTE_MS, [], {
      failed: [{ platform: PublishTarget.Mac, arch: "universal", error: "HTTP 413" }],
    });
    assert.deepEqual(cardErrors(unrealFolder(READY, 10 * MINUTE_MS), native), []);
  });
});
