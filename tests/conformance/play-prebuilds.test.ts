/**
 * Play's background builds (`src/main/core/play-prebuilds.ts`, lane PW): a healthy integrated
 * commit's Play copy is built for the browser and this computer's desktop before the person presses
 * Play; a newer commit cancels the older one's; one prebuild runs at a time; none starts without
 * room on the builds' disk; a lock change builds each game's last commit again. Over recording deps:
 * the lane's own priority and `nice` are `rust-build.test.ts`'s PW rows.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  healthyBuilds,
  PREBUILD_FREE_MIN_BYTES,
  type PlayPrebuildDeps,
  PlayPrebuilds,
} from "../../src/main/core/play-prebuilds.ts";
import { CustomEvent, customEventData } from "../../src/shared/custom-events.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";

/** Deps that record every copy and build; with `hold`, builds wait (or for their cancel) until `release()` opens them all. */
function recording(options: { free?: number | null; hold?: boolean } = {}) {
  const copies: string[] = [];
  const builds: Array<{ project: string; dir: string; target: BuildTarget; signal: AbortSignal }> = [];
  const logs: string[] = [];
  const announced: string[] = [];
  let release = () => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deps: PlayPrebuildDeps = {
    copy: async (project, commit) => {
      copies.push(`${project}@${commit}`);
      return `/scratch/show/${project}-${commit}`;
    },
    build: async (project, dir, target, signal) => {
      builds.push({ project, dir, target, signal });
      if (!options.hold) return;
      await Promise.race([opened, new Promise((resolve) => signal.addEventListener("abort", resolve))]);
    },
    targets: async () => [BuildTarget.Web, BuildTarget.Mac],
    freeBytes: async () => (options.free === undefined ? 50 * PREBUILD_FREE_MIN_BYTES : options.free),
    announce: (project, commit, since) => announced.push(`${project}@${commit}:${since === null ? "end" : "start"}`),
    log: (line) => logs.push(line),
  };
  return { deps, copies, builds, logs, announced, release: () => release() };
}

describe("Play's background builds", () => {
  it("builds a commit's Play copy for the browser, then this computer's desktop", async () => {
    const deps = recording();
    await new PlayPrebuilds(deps.deps).queue("ferris", "c1");
    assert.deepEqual(deps.copies, ["ferris@c1"]);
    assert.deepEqual(
      deps.builds.map((build) => [build.dir, build.target]),
      [
        ["/scratch/show/ferris-c1", BuildTarget.Web],
        ["/scratch/show/ferris-c1", BuildTarget.Mac],
      ],
    );
    assert.deepEqual(deps.announced, ["ferris@c1:start", "ferris@c1:end"], "Live's line hears it start and end");
  });

  it("a newer commit cancels the older one's prebuild of the same game, and asking twice builds once", async () => {
    const deps = recording({ hold: true });
    const prebuilds = new PlayPrebuilds(deps.deps);
    const older = prebuilds.queue("ferris", "c1");
    void prebuilds.queue("ferris", "c1");
    await new Promise((resolve) => setImmediate(resolve));
    const newer = prebuilds.queue("ferris", "c2");
    await older;
    assert.equal(deps.builds[0]?.signal.aborted, true, "the older build was cancelled");
    deps.release();
    await newer;
    assert.deepEqual(deps.copies, ["ferris@c1", "ferris@c2"]);
    assert.ok(!deps.builds.some((build) => build.dir.endsWith("c1") && build.target === BuildTarget.Mac));
  });

  it("runs one prebuild at a time across games", async () => {
    const deps = recording({ hold: true });
    const prebuilds = new PlayPrebuilds(deps.deps);
    const first = prebuilds.queue("ferris", "c1");
    const second = prebuilds.queue("pond", "p1");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(deps.copies, ["ferris@c1"], "the second game waits for the first's prebuild");
    deps.release();
    await Promise.all([first, second]);
    assert.deepEqual(deps.copies, ["ferris@c1", "pond@p1"]);
  });

  for (const free of [PREBUILD_FREE_MIN_BYTES - 1, 0, null]) {
    it(`starts nothing with ${free === null ? "an unreadable disk" : `${free} bytes free`}, and says so`, async () => {
      const deps = recording({ free });
      await new PlayPrebuilds(deps.deps).queue("ferris", "c1");
      assert.deepEqual(deps.copies, []);
      assert.deepEqual(deps.builds, []);
      assert.equal(deps.logs.length, 1);
    });
  }

  it("a lock change builds each game's last commit again", async () => {
    const deps = recording();
    const prebuilds = new PlayPrebuilds(deps.deps);
    await prebuilds.queue("ferris", "c1");
    await prebuilds.queue("ferris", "c2");
    await prebuilds.queue("pond", "p1");
    deps.copies.length = 0;
    await prebuilds.lockChanged();
    assert.deepEqual(deps.copies.sort(), ["ferris@c2", "pond@p1"]);
  });

  it("a build that throws is a log line, and the next prebuild still runs", async () => {
    const deps = recording();
    deps.deps.build = async () => {
      throw new Error("lane gone");
    };
    const prebuilds = new PlayPrebuilds(deps.deps);
    await prebuilds.queue("ferris", "c1");
    await prebuilds.queue("pond", "p1");
    assert.equal(deps.logs.length, 2);
    assert.deepEqual(deps.copies, ["ferris@c1", "pond@p1"]);
  });
});

describe("which appended events start a prebuild", () => {
  const envelope = (data: ReturnType<typeof customEventData>): EventEnvelope =>
    ({ id: "e", threadId: "t", at: "", data }) as unknown as EventEnvelope;
  it("a healthy integration's head, never a broken one's or a head that is no commit name", () => {
    const head = "a".repeat(40);
    const events = [
      envelope(customEventData(CustomEvent.IntegrationHealth, { head, ok: true, problems: [] })),
      envelope(customEventData(CustomEvent.IntegrationHealth, { head: "b".repeat(40), ok: false, problems: ["x"] })),
      envelope(customEventData(CustomEvent.IntegrationHealth, { head: "--upload-pack=x", ok: true, problems: [] })),
      envelope(
        customEventData(CustomEvent.IntegrationMerge, {
          facetId: "f",
          commit: head,
          head,
          conflict: false,
          stage: "director",
        }),
      ),
    ];
    assert.deepEqual(healthyBuilds(events), [{ head, project: null }]);
  });
});
