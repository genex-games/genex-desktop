/**
 * The big Publish button's follow-through: a press that named platforms not ready yet is kept
 * outside the dialog, and each platform goes to players as soon as it is ready, once, whether the
 * dialog is open or not. Driven here by hand over a made-up Studio: no timer, no window.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import {
  CloudBuildState,
  type GenexCloudBuild,
  type GenexNativeRecord,
  type GenexPublishState,
} from "../../src/shared/genex.ts";
import { NativeArch } from "../../src/shared/play-native.ts";
import type { ExportReview } from "../../src/shared/plugins.ts";
import { type PublishPlatform, PublishPlatformState, PublishTarget } from "../../src/shared/publish-platforms.ts";
import {
  createPublishFollow,
  type FollowHost,
  type FollowRequest,
} from "../../src/renderer/panels/plugins/genex/publish-follow.ts";
import { WebOffer } from "../../src/renderer/panels/plugins/genex/publish-platforms-view.ts";

const START = Date.parse("2026-11-06T20:00:00Z");
const GAME = "genex-strike";
const FILES: ExportReview = { included: ["index.html"], excluded: [] };

/** A made-up Studio: a folder and a record the test changes, a clock it moves, and every send it was asked for. */
function studio() {
  const world = {
    now: START,
    platforms: [] as PublishPlatform[],
    native: {
      supported: true,
      sending: false,
      sent: [],
      failed: [],
      cloud: { supported: true, builds: [] },
    } as GenexNativeRecord,
    sends: [] as string[],
    refuse: "",
    tick: null as (() => void) | null,
    stopped: 0,
  };
  const went = (line: string): Promise<void> => {
    if (world.refuse) return Promise.reject(new Error(world.refuse));
    world.sends.push(line);
    return Promise.resolve();
  };
  const host: FollowHost = {
    platforms: () => Promise.resolve(world.platforms),
    state: (): Promise<GenexPublishState> =>
      Promise.resolve({ version: 1, project: GAME, connected: true, native: world.native }),
    files: () => Promise.resolve(FILES),
    publish: (_project, _files, request, apps) => went(`web+${apps.join("+")} as ${request.name}`),
    publishApps: (_project, _request, platforms, release) =>
      went(`apps ${platforms.join("+")} release ${release.join("+")}`),
    now: () => world.now,
    every: (_ms, tick) => {
      world.tick = tick;
      return () => {
        world.tick = null;
        world.stopped += 1;
      };
    },
  };
  return { world, follow: createPublishFollow(host) };
}

const at = (ms: number): string => new Date(ms).toISOString();

/** A folder row: an app built at `builtAt`, or missing. */
function app(target: PublishTarget, builtAt: number | null): PublishPlatform {
  return {
    target,
    state: builtAt === null ? PublishPlatformState.Missing : PublishPlatformState.Ready,
    arch: builtAt === null ? null : NativeArch.Universal,
    bytes: builtAt === null ? 0 : 3 * 1024 ** 3,
    builtAt: builtAt === null ? null : at(builtAt),
    uploads: builtAt !== null,
    changedAt: at(START - 60 * MINUTE_MS),
  };
}

const cloud = (state: CloudBuildState, held: boolean): GenexCloudBuild => ({
  platform: PublishTarget.Windows,
  jobId: "job-1",
  state,
  startedAt: at(START),
  ...(held ? { held: true } : {}),
});

const sentMac = (when: number): GenexNativeRecord["sent"] => [
  { platform: PublishTarget.Mac, arch: NativeArch.Universal, version: "1", sizeBytes: 1, publishedAt: at(when) },
];

/** A press on a Mac that named the Mac app (asked of the agent) and the Windows app (asked of Genex Cloud). */
const request = (more: Partial<FollowRequest> = {}): FollowRequest => ({
  project: GAME,
  targets: [PublishTarget.Mac, PublishTarget.Windows],
  sent: [],
  update: false,
  name: "Genex Strike",
  remix: false,
  replacesApps: false,
  card: { webOffer: WebOffer.Unavailable, madeHere: new Set([PublishTarget.Mac]), mac: true },
  ...more,
});

describe("the big Publish button's follow-through", () => {
  it("gives players each app as soon as it is built, once, and ends when both are live", async () => {
    const { world, follow } = studio();
    world.platforms = [app(PublishTarget.Mac, null), app(PublishTarget.Windows, null)];
    world.native.cloud = { supported: true, builds: [cloud(CloudBuildState.Building, true)] };
    follow.remember(GAME, [PublishTarget.Mac]);
    follow.start(request());
    assert.deepEqual(follow.following(GAME)?.targets, [PublishTarget.Mac, PublishTarget.Windows]);
    assert.ok(world.tick, "the follow reads again by itself while a press is under way");

    await follow.tick(GAME);
    assert.deepEqual(world.sends, [], "nothing is built yet: players get nothing");

    // The agent's Mac build lands; Genex Cloud still builds the Windows app.
    world.now += 10 * MINUTE_MS;
    world.platforms = [app(PublishTarget.Mac, world.now - MINUTE_MS), app(PublishTarget.Windows, null)];
    await follow.tick(GAME);
    assert.deepEqual(world.sends, ["apps mac release windows"], "the Mac app goes, and Windows is promised with it");
    assert.equal(follow.following(GAME)?.sends, 1);

    // The record hasn't said the app is on its way yet: nothing is sent twice.
    world.now += 5 * SECOND_MS;
    await follow.tick(GAME);
    assert.equal(world.sends.length, 1);

    // The Mac app is live; Genex Cloud's build, asked for by the publish, is on its way to players.
    world.now += 5 * MINUTE_MS;
    world.native.sent = sentMac(world.now);
    world.native.cloud = { supported: true, builds: [cloud(CloudBuildState.Building, false)] };
    await follow.tick(GAME);
    assert.deepEqual(follow.following(GAME)?.targets, [PublishTarget.Windows]);

    world.now += 30 * MINUTE_MS;
    world.native.cloud = {
      supported: true,
      builds: [{ ...cloud(CloudBuildState.Done, false), finishedAt: at(world.now) }],
    };
    await follow.tick(GAME);
    assert.equal(follow.following(GAME), null, "both are live: the follow is over");
    assert.equal(world.sends.length, 1);
    assert.equal(world.stopped, 1, "and it stops reading");
  });

  it("publishes the web version with the files as they are then, under the name as pressed", async () => {
    const { world, follow } = studio();
    const web: PublishPlatform = { ...app(PublishTarget.Web, START), arch: null, bytes: 0 };
    world.platforms = [web];
    follow.start(
      request({ targets: [PublishTarget.Web], card: { webOffer: WebOffer.Make, madeHere: null, mac: true } }),
    );
    await follow.tick(GAME);
    assert.deepEqual(world.sends, ["web+ as Genex Strike"]);
  });

  it("never sends again what the press itself sent", async () => {
    const { world, follow } = studio();
    world.platforms = [app(PublishTarget.Mac, START - MINUTE_MS)];
    follow.start(request({ targets: [PublishTarget.Mac], sent: [PublishTarget.Mac] }));
    await follow.tick(GAME);
    assert.deepEqual(world.sends, [], "the press sent it a moment ago");
    // Long after, its row still says ready: the send didn't take, and the row's own button is the way.
    world.now += 5 * MINUTE_MS;
    await follow.tick(GAME);
    assert.deepEqual(world.sends, []);
    assert.equal(follow.following(GAME), null);
  });

  it("keeps why a send was refused, and stops following that platform", async () => {
    const { world, follow } = studio();
    world.platforms = [app(PublishTarget.Mac, START - MINUTE_MS)];
    world.refuse = "Sign in to Genex first.";
    follow.start(request({ targets: [PublishTarget.Mac] }));
    await follow.tick(GAME);
    assert.equal(follow.error(GAME), "Sign in to Genex first.");
    assert.equal(follow.following(GAME), null);
    world.refuse = "";
    follow.start(request({ targets: [PublishTarget.Mac] }));
    assert.equal(follow.error(GAME), "", "a new press starts clean");
  });

  it("stops following a platform whose build never lands, and tells who listens", async () => {
    const { world, follow } = studio();
    world.platforms = [app(PublishTarget.Mac, null)];
    follow.remember(GAME, [PublishTarget.Mac]);
    let told = 0;
    const off = follow.subscribe(() => {
      told += 1;
    });
    follow.start(request({ targets: [PublishTarget.Mac] }));
    await follow.tick(GAME);
    assert.ok(follow.following(GAME), "the agent may still be building");
    const before = told;
    await follow.tick(GAME);
    assert.equal(told, before, "nothing changed: nobody is told");
    world.now += 3 * 60 * MINUTE_MS;
    await follow.tick(GAME);
    assert.equal(follow.following(GAME), null, "an ask two hours old was never built");
    assert.ok(told > before);
    off();
  });

  it("remembers what the card asked the agent for, by game", () => {
    const { world, follow } = studio();
    follow.remember(GAME, [PublishTarget.Windows]);
    world.now += MINUTE_MS;
    follow.remember(GAME, [PublishTarget.Linux]);
    assert.deepEqual(
      [...follow.asked(GAME)],
      [
        [PublishTarget.Windows, at(START)],
        [PublishTarget.Linux, at(START + MINUTE_MS)],
      ],
    );
    assert.equal(follow.asked("another-game").size, 0);
  });
});
