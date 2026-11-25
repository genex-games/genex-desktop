/**
 * Play for a game being made: Genex starts the newest app the game's own folder holds for this
 * computer, in the game sandbox and in place (read-only, its saves in Genex's own folder, nothing
 * written into the game), brings a running one forward, and plays nothing older than the game's
 * last change. The core answers `packaging` while the chat's agent packages the game, and only an
 * Unreal game's chat is handed `play_build`.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { callProjectTool, ProjectToolSeat, projectTools } from "../../src/main/core/project-tools.ts";
import type { FoundBuild } from "../../src/main/core/native-builds.ts";
import { isStaleBuild } from "../../src/main/core/publish-platforms.ts";
import { LocalPlays, localSlug, runsHere } from "../../src/main/play/local-plays.ts";
import { type GameProcess, nativeSessions } from "../../src/main/play/native-launch.ts";
import {
  LocalPlayState,
  NativeArch,
  type NativeHost,
  NativeEngine,
  NativePlatform,
} from "../../src/shared/play-native.ts";
import { CoreFact, type GameKind } from "../../src/shared/project-facts.ts";
import { ProjectTool } from "../../src/shared/project-tools.ts";
import type { NativeGameRequest } from "../../src/substrate/plugins/native-process.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

const MAC: NativeHost = { platform: NativePlatform.Mac, arch: NativeArch.Arm64, osVersion: "26.3" };
const APP = "unreal/Builds/Mac/Dust.app";
const BUILT_AT = Date.UTC(2026, 10, 5, 12, 0, 0);
const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Dust</string>
<key>CFBundleIdentifier</key><string>com.dust.Dust</string>
<key>CFBundleName</key><string>Dust</string>
</dict></plist>`;

/** A Mac build as `findNativeBuilds` finds it. */
const macBuild = (fields: Partial<FoundBuild> = {}): FoundBuild => ({
  platform: NativePlatform.Mac,
  arch: NativeArch.Arm64,
  entry: APP,
  folder: APP,
  program: `${APP}/Contents/MacOS/Dust`,
  bytes: 1,
  builtAt: BUILT_AT,
  ...fields,
});

/** A started game the test ends. */
class FakeGame extends EventEmitter implements GameProcess {
  readonly pid: number;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
}

/** Local plays over a temporary game folder with one Mac app, every outside call recorded. */
async function plays(
  options: {
    builds?: FoundBuild[];
    changed?: number;
    host?: NativeHost | null;
    spawnFails?: boolean;
    /** The practice helper Live holds, by game. */
    practice?: Record<string, string>;
  } = {},
) {
  const base = await realpath(await tmpDir("local-plays-"));
  const game = path.join(base, "games", "dust");
  const root = path.join(base, "local-plays");
  await mkdir(path.join(game, APP, "Contents", "MacOS"), { recursive: true });
  await writeFile(path.join(game, APP, "Contents", "Info.plist"), PLIST);
  await writeFile(path.join(game, APP, "Contents", "MacOS", "Dust"), "binary");
  const requests: NativeGameRequest[] = [];
  const shown: number[] = [];
  const local = new LocalPlays({
    root,
    host: options.host === undefined ? MAC : options.host,
    gameDir: async (project) => (project === "dust" || project === "Dust Runners!" ? game : null),
    builds: async () => options.builds ?? [macBuild()],
    lastChange: async () => options.changed ?? BUILT_AT - 5_000,
    stale: isStaleBuild,
    sessions: (placing) =>
      nativeSessions({
        root,
        ...placing,
        // As the app composes it: the helper Live holds for the game a launch's name stands for.
        practice: async (slug) => {
          const key = options.practice?.[placing.project(slug) ?? ""];
          return key ? { key } : null;
        },
        spawn: async (request) => {
          if (options.spawnFails) throw new Error("sandbox-exec refused the profile");
          requests.push(request);
          return new FakeGame(5000 + requests.length);
        },
        hasWindow: async () => true,
        show: async (pid) => {
          shown.push(pid);
        },
        kill: () => {},
        killTree: async () => {},
        probe: { startTime: async () => null },
        clock: { now: () => BUILT_AT, setTimeout: () => 0, clearTimeout: () => {} },
        publish: () => {},
        played: async () => {},
        ended: async () => {},
        log: () => {},
      }),
  });
  const files = async () => (await readdir(game, { recursive: true })).sort();
  return { local, game, root, requests, shown, files };
}

describe("Play for a game being made", () => {
  it("starts the game folder's newest app here in place, full screen, its saves in Genex's own folder", async () => {
    const { local, game, root, requests, files } = await plays();
    const before = await files();
    assert.deepEqual(await local.play("dust", NativeEngine.Unreal), { state: LocalPlayState.Launched, app: APP });
    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.equal(request?.app, path.join(game, APP), "the app runs where the agent built it");
    assert.equal(request?.binary, path.join(game, APP, "Contents", "MacOS", "Dust"));
    assert.equal(request?.saves, path.join(root, "dust", "saves"));
    assert.ok(request?.scratch.startsWith(root), "its temporary files are Genex's own");
    assert.deepEqual(request?.args, ["-fullscreen"], "Unreal's own full-screen argument");
    assert.equal(request?.bundleId, "com.dust.Dust");
    assert.equal(request?.bundleName, "Dust");
    assert.deepEqual(await files(), before, "nothing is written into the game folder");
  });

  it("brings a running game forward instead of starting a second copy", async () => {
    const { local, requests, shown } = await plays();
    await local.play("dust");
    assert.deepEqual(await local.play("dust"), { state: LocalPlayState.Shown });
    assert.equal(requests.length, 1);
    assert.equal(shown.length >= 1, true);
  });

  it("plays nothing older than the game's last change, nothing for another computer, and nothing where Genex can't", async () => {
    const rows: Array<[string, Parameters<typeof plays>[0], string, LocalPlayState]> = [
      ["an app older than the last change", { changed: BUILT_AT + 2 * 60_000 }, "dust", LocalPlayState.Stale],
      ["no app at all", { builds: [] }, "dust", LocalPlayState.NoBuild],
      [
        "only a Windows program",
        { builds: [macBuild({ platform: NativePlatform.Windows, arch: NativeArch.X64 })] },
        "dust",
        LocalPlayState.NoBuild,
      ],
      ["a game Genex doesn't know", {}, "elsewhere", LocalPlayState.NoBuild],
      ["a computer Genex plays nothing on", { host: null }, "dust", LocalPlayState.Unsupported],
      ["an app that doesn't start", { spawnFails: true }, "dust", LocalPlayState.Failed],
    ];
    for (const [label, options, project, state] of rows) {
      const { local, requests } = await plays(options);
      const answer = await local.play(project);
      assert.equal(answer.state, state, label);
      if (state !== LocalPlayState.Failed) assert.equal(requests.length, 0, `${label}: nothing started`);
    }
  });

  it("a game whose name is no slug plays under one made from its hash", async () => {
    const { local, root, requests } = await plays();
    assert.equal((await local.play("Dust Runners!")).state, LocalPlayState.Launched);
    const slug = localSlug("Dust Runners!");
    assert.match(slug, /^game-[0-9a-f]{12}$/);
    assert.equal(requests[0]?.saves, path.join(root, slug, "saves"));
    assert.equal(localSlug("dust"), "dust");
  });

  it("an app runs here on its own processor, as a universal Mac app, or as an Intel one under Rosetta", () => {
    const intel = { platform: NativePlatform.Mac, arch: NativeArch.X64 };
    assert.equal(runsHere({ platform: NativePlatform.Mac, arch: NativeArch.Universal }, MAC), true);
    assert.equal(runsHere(intel, MAC), false);
    assert.equal(runsHere(intel, { ...MAC, rosetta: true }), true);
    assert.equal(runsHere({ platform: NativePlatform.Linux, arch: NativeArch.Arm64 }, MAC), false);
  });
});

describe("the core's Play for a game being made", () => {
  it("is unsupported with no launcher, and plays an Unreal game full screen with one", async () => {
    const engines: Array<string | null> = [];
    const answers = [{ state: LocalPlayState.Launched, app: APP }];
    const { core, close } = await coreLite({
      localPlays: {
        play: async (_project, engine) => {
          engines.push(engine);
          return answers.shift() ?? { state: LocalPlayState.NoBuild };
        },
      },
    });
    try {
      await core.games.scaffold("dust", { title: "Dust" });
      assert.deepEqual(await core.playGameBuild("dust"), { state: LocalPlayState.Launched, app: APP });
      assert.deepEqual(await core.playGameBuild("dust"), { state: LocalPlayState.NoBuild });
      assert.deepEqual(engines, [null, null], "a web game's folder plays with no engine's arguments");
    } finally {
      await close();
    }
    const bare = await coreLite();
    try {
      await bare.core.games.scaffold("dust", { title: "Dust" });
      assert.deepEqual(await bare.core.playGameBuild("dust"), { state: LocalPlayState.Unsupported });
    } finally {
      await bare.close();
    }
  });

  it("while a chat of the game waits for a package its agent started, Play with no fresh app answers packaging", async () => {
    const { core, close, api } = await coreLite({
      localPlays: { play: async () => ({ state: LocalPlayState.Stale, app: APP }) },
    });
    try {
      await core.plugins.setEnabled("unreal", true);
      await core.games.scaffold("dust", { title: "Dust" });
      const threadId = await core.threadForGame("dust");
      assert.equal((await core.playGameBuild("dust")).state, LocalPlayState.Stale);
      core.plugins.tool = (async () => ({ started: true, system: "Mac" })) as never;
      const invoke = (api() as unknown as Record<string, (input: unknown) => Promise<unknown>>)["plugins.invoke"];
      await invoke?.({ project: "dust", threadId, name: "unreal__package-game", args: {} });
      assert.deepEqual(await core.playGameBuild("dust"), { state: LocalPlayState.Packaging, app: APP });
    } finally {
      core.plugins.cancel();
      await close();
    }
  });

  it("hands play_build to an Unreal game's own chat only, and answers what Genex did", async () => {
    const unreal: GameKind = { facts: [{ id: CoreFact.UnrealProject, path: "." }] };
    const web: GameKind = { facts: [{ id: CoreFact.WebGame, path: "." }] };
    const named = (game: GameKind, seat: ProjectToolSeat) => projectTools(game, seat).map((tool) => tool.name);
    assert.ok(named(unreal, ProjectToolSeat.Chat).includes(ProjectTool.PlayBuild));
    assert.ok(!named(web, ProjectToolSeat.Chat).includes(ProjectTool.PlayBuild));
    for (const seat of [ProjectToolSeat.Lead, ProjectToolSeat.Worker, ProjectToolSeat.Reviewer, ProjectToolSeat.None])
      assert.ok(!named(unreal, seat).includes(ProjectTool.PlayBuild), seat);
    const said: Record<string, RegExp> = {
      [LocalPlayState.Launched]: /started unreal\/Builds\/Mac\/Dust\.app full screen/,
      [LocalPlayState.Stale]: /built before the game's last change.*unreal__package-game.*end your turn/,
      [LocalPlayState.NoBuild]: /no app for this computer.*unreal__package-game/,
      [LocalPlayState.Packaging]: /still running: end your turn/,
    };
    for (const [state, words] of Object.entries(said)) {
      const { core, close } = await coreLite({
        localPlays: { play: async () => ({ state: state as LocalPlayState, app: APP }) },
      });
      try {
        await core.games.scaffold("dust", { title: "Dust" });
        const text = await callProjectTool(core, null as never, ProjectTool.PlayBuild, {}, { project: "dust" });
        assert.match(String(text), words, state);
      } finally {
        await close();
      }
    }
  });

  it("hands the folder's own app the helper Live holds for that game, by the game's own name", async () => {
    const key = `41000.${"b".repeat(32)}`;
    // A name that is no slug is launched under a made-up one: the helper is still found by the game's name.
    const { local, requests } = await plays({ practice: { "Dust Runners!": key } });
    assert.equal((await local.play("Dust Runners!")).state, LocalPlayState.Launched);
    assert.deepEqual(requests[0]?.practice, { key });
    assert.equal(requests[0]?.genex, undefined, "and nothing of Genex's own: no address, no sign-in");
    const other = await plays({ practice: { "another game": key } });
    assert.equal((await other.local.play("dust")).state, LocalPlayState.Launched);
    assert.equal(other.requests[0]?.practice, undefined, "a game Live holds no helper for is handed none");
  });
});
