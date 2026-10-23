/**
 * Characterization of `StudioCore`'s public surface: the methods and accessors main, the IPC
 * layer and the tests reach it through, and the fields an initialized core exposes.
 *
 * Stage 2 splits this class. Until then any addition, rename or removal here must be a deliberate
 * edit of these lists, so a refactor that silently drops an entry point fails before it ships.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { StudioCore } from "../../src/main/studio-core.ts";
import { type HostExec, probeCommandLineTools } from "../../src/main/core/toolchains.ts";
import { servedToolchainHost } from "../../src/shared/toolchain.ts";
import { coreLite } from "../helpers/core-lite.ts";

const METHODS = [
  "_computerToolsFor",
  "_directorToolsFor",
  "_playtestToolsFor",
  "_runOfGame",
  "acceptStagedProposal",
  "activeBuilders",
  "activityEvents",
  "activityItems",
  "adoptProject",
  "agentScreens",
  "answerPermission",
  "answerPlan",
  "api",
  "append",
  "archiveGame",
  "askToolPermission",
  "assertProjectAllowed",
  "bindThreadToProject",
  "buildPreview",
  "buildProblem",
  "changeQueuedMessage",
  "chatFileTarget",
  "compactThread",
  "connectionSnapshot",
  "createGame",
  "createGameThread",
  "defaultDelegatedEngine",
  "discardStagedProposal",
  "dispatchRun",
  "emit",
  "exportPublicCopy",
  "forgetPermission",
  // What freeing space deletes, and deleting it (studio:storage, studio:storage.free).
  "freeStorage",
  // Create game's location, checked before anything is written (studio:game.location.pick).
  "gameLocation",
  "init",
  "inspectFolder",
  "installPackages",
  "knownSecretValues",
  "landBuild",
  "listAllEvents",
  "liveAssetsLoaded",
  // The build copy Live serves, which Live's Native view builds instead of the game folder.
  "liveRootOf",
  "liveState",
  "loadPreview",
  "loadWebBuild",
  // Home's Make your own writes a live background on the model the user picked (backdrop-generation.ts).
  "makeBackdrop",
  "messageImages",
  // A game started from its first request is named before its folder is made (studio:game.name).
  "nameGame",
  // A game its first message left Untitled takes the name a later message gives it (conversation.ts).
  "nameFromIdea",
  "newRunId",
  "offerBuild",
  "offerLive",
  "permissionSettings",
  "playGameSnapshot",
  // The stage strip's Play/Stop (studio:preview.play, studio:preview.stop).
  "playLive",
  "pluginBinding",
  "presentProjectAssets",
  "previewProjectAsset",
  "projectAssets",
  "projectModelRigs",
  // Studio's protected paths and the export redaction's roots: the phone SDK probe and the redaction refuse a file there (rust-wgpu M5 review).
  "protectedPaths",
  "redactionForbiddenRoots",
  // Publish's file list, shown in Studio's dialog before anything is uploaded (studio:plugins.genex-publish-review).
  "publicCopyFiles",
  "readGameFile",
  "readProjectAsset",
  "readRunStill",
  "checkpointPreview",
  "previewStageVisible",
  "previewForeground",
  "previewSound",
  "reconcileSeedManifest",
  "recover",
  "referenceStills",
  "reloadLive",
  "reloadLiveAssets",
  "reloadPreview",
  "removeGame",
  "renameThread",
  "requestConsent",
  "revealGameFile",
  "requestRunFinish",
  "requestSelfRestart",
  "resolveChatFiles",
  "resolveConsent",
  "resumeAutopilot",
  "retainedAssetFile",
  "retryMention",
  "rewindChat",
  "rewindPreview",
  "rollbackTo",
  "runFeedback",
  "runIdleCheckNow",
  "runPreviewIdentity",
  "saveReferenceFrames",
  "saveRunArtifact",
  // Whether a game is a remix whose setup scripts the person has not trusted (installs, genex__package).
  "scriptsGuarded",
  "selfChangeList",
  "sendUserMessage",
  "setGamesRoot",
  "setPermissionMode",
  "showBuild",
  "snapshot",
  "start",
  "startEngine",
  "stop",
  "stopJob",
  "stopLive",
  "stopRun",
  "stopThread",
  "storageSpace",
  "threadForGame",
  "undoEngineLink",
  "undoRewind",
  "undoSelfChange",
  "updateGame",
  "updateSettings",
  // The files the person approved in that dialog, approved for the one publish it starts.
  "withApprovedExport",
];
// `planReviews` is TypeScript-`private`, which is erased: it is still reachable at run time.
// phonePackages: the admitted phone packages the device launch installs from (rust-wgpu M5 review).
const ACCESSORS = ["assetCheckpoints", "autoResumeAt", "pendingUpdateId", "phonePackages", "planReviews", "settings"];
/** Own enumerable fields after `init()` (true `#private` state is not visible and not listed). */
const FIELDS = [
  "appLook",
  "budget",
  "builds",
  "candidates",
  "contextPreferences",
  // The C++ build lane and the toolchain store.
  "cppBuilds",
  "engineLinks",
  "engines",
  "games",
  "hooks",
  "host",
  "improvements",
  "jobs",
  "journal",
  "layout",
  "locks",
  "mainThread",
  "mcp",
  // Every C++ game the studio started: the Play window, agents' headless runs, embedded ones.
  "nativeRuns",
  "ollamaSidecar",
  "options",
  "pluginServices",
  "plugins",
  "sandbox",
  "screenAccess",
  "snapshotIndex",
  "snapshots",
  "store",
  "toolchains",
  "turns",
];

function prototypeSurface() {
  const methods: string[] = [];
  const accessors: string[] = [];
  for (const name of Object.getOwnPropertyNames(StudioCore.prototype)) {
    if (name === "constructor") continue;
    const descriptor = Object.getOwnPropertyDescriptor(StudioCore.prototype, name)!;
    if (descriptor.get || descriptor.set) accessors.push(name);
    else if (typeof descriptor.value === "function") methods.push(name);
  }
  return { methods: methods.sort(), accessors: accessors.sort() };
}

test("StudioCore prototype exposes exactly the golden public methods and accessors", () => {
  const surface = prototypeSurface();
  assert.deepEqual(
    surface.methods,
    [...METHODS].sort(),
    "a change to StudioCore's public methods must update this list deliberately",
  );
  assert.deepEqual(surface.accessors, [...ACCESSORS].sort());
  assert.deepEqual(
    Object.getOwnPropertyNames(StudioCore).filter((n) => !["length", "name", "prototype"].includes(n)),
    [],
    "no static members",
  );
});

test("an initialized StudioCore exposes exactly the golden public fields", async () => {
  const { core } = await coreLite();
  assert.deepEqual(Object.keys(core).sort(), [...FIELDS].sort());
});

test("before any install the toolchain status is the empty store on this host, and Stop cancels C++ builds", async (t) => {
  const lite = await coreLite();
  const status = await lite.core.toolchains.status();
  // A Windows host serves no toolchain (its C++ lane does not run there, `cppLaneRunsOn`), so it
  // names no host and no part without a download.
  const host = servedToolchainHost(process.platform, process.arch);
  // Every Genex build bundles the pinned ANGLE builds and Linux headers, so a supported host has
  // no component waiting for publication even before its first install.
  assert.deepEqual(
    { ...status, clt: typeof status.clt.present },
    {
      host,
      clt: "boolean",
      installed: [],
      lock: null,
      job: null,
      storeBytes: 0,
      ...(host ? { unhosted: [] } : {}),
    },
  );
  // Composer Stop and the studio's own stop end every C++ build in flight; with none, nothing fails.
  const cancelled = t.mock.method(lite.core.cppBuilds, "cancelAll");
  await lite.core.stopThread("no-such-thread").catch(() => {});
  assert.equal(cancelled.mock.callCount(), 1);
  await lite.close();
  assert.equal(cancelled.mock.callCount(), 2);
});

test("the Command Line Tools probe runs only xcode-select -p and pkgutil, and nothing off a Mac", async () => {
  const XCODE_SELECT = "/usr/bin/xcode-select";
  const PKGUTIL = "/usr/bin/pkgutil";
  const cases: Array<{
    name: string;
    answers: Record<string, { code: number | null; stdout: string }>;
    expected: unknown;
    ran: string[];
  }> = [
    {
      name: "the Command Line Tools",
      answers: {
        [XCODE_SELECT]: { code: 0, stdout: "/Library/Developer/CommandLineTools\n" },
        [PKGUTIL]: {
          code: 0,
          stdout: "package-id: com.apple.pkg.CLTools_Executables\nversion: 26.6.0.0.1.1750000000\n",
        },
      },
      expected: { present: true, version: "26.6.0.0.1.1750000000" },
      ran: [XCODE_SELECT, PKGUTIL],
    },
    {
      name: "Xcode selected, no Command Line Tools package",
      answers: {
        [XCODE_SELECT]: { code: 0, stdout: "/Applications/Xcode.app/Contents/Developer\n" },
        [PKGUTIL]: { code: 1, stdout: "" },
      },
      expected: { present: true, version: null },
      ran: [XCODE_SELECT, PKGUTIL],
    },
    {
      name: "nothing selected",
      answers: { [XCODE_SELECT]: { code: 2, stdout: "" } },
      expected: { present: false, version: null },
      ran: [XCODE_SELECT],
    },
    {
      name: "xcode-select missing",
      answers: { [XCODE_SELECT]: { code: null, stdout: "" } },
      expected: { present: false, version: null },
      ran: [XCODE_SELECT],
    },
  ];
  for (const row of cases) {
    const ran: string[][] = [];
    const exec: HostExec = async (file, args) => {
      ran.push([file, ...args]);
      return { stderr: "", ...(row.answers[file] ?? { code: null, stdout: "" }) };
    };
    assert.deepEqual(await probeCommandLineTools(exec, "darwin"), row.expected, row.name);
    assert.deepEqual(
      ran.map(([file]) => file),
      row.ran,
      row.name,
    );
    assert.deepEqual(ran[0], [XCODE_SELECT, "-p"], row.name);
  }
  for (const platform of ["linux", "win32"] as const) {
    const ran: string[] = [];
    const exec: HostExec = async (file) => {
      ran.push(file);
      return { code: 0, stdout: "x", stderr: "" };
    };
    assert.deepEqual(await probeCommandLineTools(exec, platform), { present: false, version: null }, platform);
    assert.deepEqual(ran, [], platform);
  }
});
