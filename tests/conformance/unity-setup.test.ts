/**
 * The Unity setup card for a computer that can't make Unity games yet, and Genex installing Unity
 * for the person from it: Unity Hub from Unity's own download, copied in only when Unity signed it;
 * signing in left to the person; Unity 6 installed through Hub's command line, with its progress
 * and its stop read back for the card; Do it for me doing each in order. Nothing here reaches the
 * network or starts a program: the downloads, programs, processes and disks are the test's.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import type { PluginContext } from "../../src/plugin-sdk/index.d.ts";
import { createUnityBackend, UnityAction, UnityTool } from "../../src/plugins/unity/backend.ts";
import type { Launch } from "../../src/plugins/unity/editor-launch.ts";
import { type EditorsEnv, systemEditorsEnv } from "../../src/plugins/unity/editors.ts";
import {
  hasLicense,
  JobKind,
  JobState,
  readFacts,
  type SetupFacts,
  SetupAction,
  SetupStepId,
  setupCard,
} from "../../src/plugins/unity/setup-steps.ts";
import {
  chooseRelease,
  createInstaller,
  type InstallDeps,
  progressIn,
  releasesIn,
  UNITY_TEAM_ID,
} from "../../src/plugins/unity/unity-install.ts";
import { fakeEditor, macEnv, pluginContext } from "../helpers/unity-editor-stand-in.ts";
import { realTmp } from "../helpers/unity-backend.ts";

const GB = 1024 ** 3;
const EDITOR = { version: "6000.3.26f1", app: "/Applications/Unity/Hub/Editor/6000.3.26f1/Unity.app" };
const facts = (fields: Partial<SetupFacts> = {}): SetupFacts => ({
  hub: undefined,
  signedIn: false,
  editor: undefined,
  job: null,
  ...fields,
});
const row = (card: ReturnType<typeof setupCard>, id: string) => card.steps.find((step) => step.id === id);

describe("the Unity setup card", () => {
  it("asks for all three steps on a computer with nothing, Do it for me included", () => {
    const card = setupCard(facts());
    assert.equal(card.open, true);
    assert.equal(card.intro, "Three steps before the agent can build in Unity.");
    assert.deepEqual(card.primary, { name: SetupAction.SetUp, args: {}, label: "Do it for me" });
    assert.equal(card.doneSays, undefined);
    assert.equal(row(card, SetupStepId.GetHub)?.action?.name, SetupAction.GetHub);
    const signIn = row(card, SetupStepId.SignIn);
    assert.equal(signIn?.you, true, "signing in is the person's own step");
    assert.equal(signIn?.action, undefined, "there is no Hub to open yet");
    assert.equal(row(card, SetupStepId.InstallUnity)?.action, undefined, "nor one to install Unity with");
  });

  it("leaves only what is missing, with its button once Hub is there", () => {
    const card = setupCard(facts({ hub: "/Applications/Unity Hub.app", signedIn: true }));
    assert.equal(card.intro, "One step before the agent can build in Unity.");
    assert.deepEqual(
      card.steps.map((step) => step.done),
      [true, true, false],
    );
    assert.equal(row(card, SetupStepId.InstallUnity)?.action?.name, SetupAction.InstallUnity);
    assert.equal(row(card, SetupStepId.SignIn)?.label, "Signed in to Unity");
  });

  it("offers Don't use Unity while idle and Stop while Genex is at it, in Hide's place", () => {
    assert.deepEqual(setupCard(facts()).secondary, { name: SetupAction.Skip, args: {}, label: "Don't use Unity" });
    const running = { kind: JobKind.Hub, state: JobState.Running };
    assert.deepEqual(setupCard(facts({ job: running })).secondary, { name: SetupAction.Stop, args: {}, label: "Stop" });
    const stopped = {
      kind: JobKind.Editor,
      state: JobState.Failed,
      why: "You stopped the install.",
      stopped: true as const,
    };
    const card = setupCard(facts({ hub: "/H.app", signedIn: true, job: stopped }));
    assert.equal(card.stuckSays, undefined, "a stop the person asked for is no reason to click through Hub");
    assert.equal(row(card, SetupStepId.InstallUnity)?.action?.label, "Try again");
  });

  it("says how far an install got while it runs, and offers no Do it for me then", () => {
    const hub = "/Applications/Unity Hub.app";
    const running = { kind: JobKind.Editor, state: JobState.Running, version: "6000.3.26f1", percent: 41.6 };
    const card = setupCard(facts({ hub, signedIn: true, job: running }));
    assert.equal(card.primary, undefined);
    assert.match(card.intro, /Genex is doing this/);
    const install = row(card, SetupStepId.InstallUnity);
    assert.equal(install?.label, "Installing Unity 6000.3.26f1");
    assert.equal(install?.working, true);
    assert.equal(install?.detail, "42%");
    const downloading = { ...running, phase: "downloading" };
    const card2 = setupCard(facts({ hub, signedIn: true, job: downloading }));
    assert.equal(row(card2, SetupStepId.InstallUnity)?.detail, "Downloading · 42%");
    const installing = { kind: JobKind.Editor, state: JobState.Running, version: "6000.3.26f1", phase: "installing" };
    const card3 = setupCard(facts({ hub, signedIn: true, job: installing }));
    assert.equal(row(card3, SetupStepId.InstallUnity)?.detail, "Installing…");
    assert.equal(install?.action, undefined);

    const download = { kind: JobKind.Hub, state: JobState.Running, done: 40 * 1024 ** 2, total: 160 * 1024 ** 2 };
    assert.equal(row(setupCard(facts({ job: download })), SetupStepId.GetHub)?.detail, "40 of 160 MB");
  });

  it("asks only for the person's sign-in while Do it for me waits for it", () => {
    const waiting = { kind: JobKind.SignIn, state: JobState.Running };
    const card = setupCard(facts({ hub: "/H.app", job: waiting }));
    assert.equal(card.primary, undefined, "Do it for me is already going");
    assert.match(card.intro, /Genex is doing this/);
    const signIn = row(card, SetupStepId.SignIn);
    assert.equal(signIn?.you, true);
    assert.match(String(signIn?.detail), /Unity Hub window/);
    assert.equal(signIn?.action?.label, "Show Unity Hub");
  });

  it("marks a stopped install for the person, with why and Try again", () => {
    const why = "Unity 6 needs about 12 GB; 4.1 GB is free. Free up space, then try again.";
    const stopped = { kind: JobKind.Editor, state: JobState.Failed, version: "6", why };
    const install = row(setupCard(facts({ hub: "/H.app", signedIn: true, job: stopped })), SetupStepId.InstallUnity);
    assert.equal(install?.you, true);
    assert.equal(install?.detail, why);
    assert.equal(install?.action?.label, "Try again");
  });

  it("tells the agent to finish a stopped install in Unity Hub with computer control, unless only the person can fix it", () => {
    const hub = "/H.app";
    const stopped = {
      kind: JobKind.Editor,
      state: JobState.Failed,
      version: "6000.3.26f1",
      why: "It stopped.",
      inHub: true as const,
    };
    const said = String(setupCard(facts({ hub, signedIn: true, job: stopped })).stuckSays);
    assert.match(said, /It stopped\./);
    assert.match(said, /desktop tool/);
    assert.match(said, /Install Editor/);
    assert.match(said, /6000\.3\.26f1/);
    const { inHub: _inHub, ...noHub } = stopped;
    const full = { ...noHub, why: "Unity 6 needs about 12 GB; 4.1 GB is free." };
    const fullSaid = String(setupCard(facts({ hub, signedIn: true, job: full })).stuckSays);
    assert.match(fullSaid, /4\.1 GB is free/);
    assert.doesNotMatch(fullSaid, /desktop tool/, "no clicking frees disk space: the person is told");
    assert.equal(setupCard(facts({ hub, signedIn: true })).stuckSays, undefined, "nothing stopped");
  });

  it("closes once all is done, with what the agent is told", () => {
    const card = setupCard(facts({ hub: "/H.app", signedIn: true, editor: EDITOR }));
    assert.equal(card.open, false);
    assert.equal(card.primary, undefined);
    assert.match(String(card.doneSays), /Unity 6000\.3\.26f1 is installed/);
    assert.match(String(card.doneSays), /unity__new-game/);
  });
});

describe("what the card reads on a Mac", () => {
  it("finds Hub, a license by either of its files, and the newest Unity 6", async () => {
    const env = await macEnv();
    assert.deepEqual(await readFacts(env, null), facts());
    await mkdir(path.join(env.applications, "Unity Hub.app"));
    const editors = path.join(env.applications, "Unity", "Hub", "Editor");
    await fakeEditor(editors, "2022.3.13f1");
    await fakeEditor(editors, "6000.3.26f1");
    const machine = path.join(path.dirname(env.applications), "Library", "Application Support", "Unity");
    await mkdir(machine, { recursive: true });
    await writeFile(path.join(machine, "Unity_lic.ulf"), "<license/>");
    const read = await readFacts(env, null);
    assert.equal(read.hub, path.join(env.applications, "Unity Hub.app"));
    assert.equal(read.signedIn, true, "the machine-wide license counts");
    assert.equal(read.editor?.version, "6000.3.26f1");

    const other = await macEnv();
    const account = path.join(other.home, "Library", "Unity", "licenses");
    await mkdir(account, { recursive: true });
    assert.equal(await hasLicense(other), false);
    await writeFile(path.join(account, "UnityEntitlementLicense.xml"), "<license/>");
    assert.equal(await hasLicense(other), true, "and so does the account's");
  });
});

describe("a made-up Mac for testing the card in the real app", () => {
  it("looks for Hub, editors and the license under the test root, and only an absolute one", () => {
    const env = systemEditorsEnv({ STUDIO_ENGINE_TEST_ROOT: "/tmp/test-mac" }, "darwin");
    assert.equal(env.applications, "/tmp/test-mac/Applications");
    assert.equal(env.home, "/tmp/test-mac/home");
    for (const ignored of [{}, { STUDIO_ENGINE_TEST_ROOT: "relative/mac" }]) {
      const real = systemEditorsEnv(ignored, "darwin");
      assert.equal(real.applications, "/Applications");
    }
  });
});

describe("choosing what to install", () => {
  it("takes the newest final release of the measured line, else the newest final Unity 6", () => {
    const listed = ["7000.0.0a10", "6000.7.0b5", "6000.3.26f1", "6000.3.9f1", "6000.0.85f1", "6000.6.6f1"];
    assert.equal(chooseRelease(listed), "6000.3.26f1");
    assert.equal(chooseRelease(["6000.6.6f1", "6000.0.85f1", "6000.7.0b5"]), "6000.6.6f1");
    assert.equal(chooseRelease(["2022.3.13f1", "7000.0.0a10"]), undefined);
  });

  it("reads Hub's release list through the lines it prints around it", () => {
    const output = `Hub starting\n[\n  { "version": "6000.3.26f1", "architecture": "arm64" },\n  { "version": "6000.6.6f1" }\n]\ndone`;
    assert.deepEqual(releasesIn(output), ["6000.3.26f1", "6000.6.6f1"]);
    for (const nothing of ["", "no list", "[not json]", "{}"]) assert.deepEqual(releasesIn(nothing), []);
    // Hub's own Chromium may log on the same stream, in square brackets, before the list.
    const noisy = `[19294:1015/223654.598386:ERROR:content/browser/backing_store.cc:237] Failed to open LevelDB\n${output}`;
    assert.deepEqual(releasesIn(noisy), ["6000.3.26f1", "6000.6.6f1"]);
  });

  it("reads an install's phase, its last percentage and its last line, through Hub's own noise", () => {
    // As Hub 3.22 prints it: terminal escapes, its progress lines, and Chromium's log lines between.
    const hub = [
      "\u001b[2A\u001b[0JProgress:",
      "[Unity (6000.3.26f1)] downloading 12.00%",
      "[19294:1015/223654.598386:ERROR:content/browser/indexed_db/backing_store.cc:237] Failed to open LevelDB database",
      "\u001b[2A\u001b[0JProgress:",
      "[Unity (6000.3.26f1)] installing 40.5%",
      "[19294:1015/223655.626403:ERROR:content/browser/indexed_db/backing_store.cc:237] Failed to open LevelDB database",
    ].join("\n");
    assert.deepEqual(progressIn(hub), {
      percent: 40.5,
      phase: "installing",
      last: "[Unity (6000.3.26f1)] installing 40.5%",
    });
    assert.deepEqual(progressIn("Error: disk full\n"), { last: "Error: disk full" });
    // After the download Hub validates and installs with no percentage: the phase alone.
    const after = `${hub}\n[Unity (6000.3.26f1)] downloading 99.00%\n[Unity (6000.3.26f1)] installing...`;
    assert.deepEqual(progressIn(after), { phase: "installing", last: "[Unity (6000.3.26f1)] installing..." });
  });
});

/** A promise the test settles itself. */
function gate() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A Mac where Genex installs: downloads, programs, processes, disk and clock the test decides. */
async function installMac(options: { team?: string; freeGb?: number; signedIn?: boolean; hub?: boolean } = {}) {
  const { team = UNITY_TEAM_ID, freeGb = 200, signedIn = true, hub = false } = options;
  const env: EditorsEnv = await macEnv();
  const storage = await realTmp("unity-setup-storage-");
  const ran: string[][] = [];
  const opened: Launch[] = [];
  const started: { command: string; args: string[]; log: string }[] = [];
  /** The processes that run, each with its program. */
  const living = new Map<number, string>();
  let clock = Date.parse("2026-10-15T20:00:00.000Z");
  const license = path.join(env.home, "Library", "Unity", "licenses", "UnityEntitlementLicense.xml");
  const signIn = async () => {
    await mkdir(path.dirname(license), { recursive: true });
    await writeFile(license, "<license/>");
  };
  if (signedIn) await signIn();
  if (hub) await mkdir(path.join(env.applications, "Unity Hub.app"));
  const deps: InstallDeps = {
    env,
    arch: "arm64",
    fetch: (async () => new Response(new Uint8Array(1024), { headers: { "content-length": "1024" } })) as typeof fetch,
    run: async (command, args) => {
      ran.push([command, ...args]);
      if (command.endsWith("ditto")) await mkdir(args[1] ?? "", { recursive: true });
      if (args.includes("-dv")) return { out: "", err: `Identifier=com.unity3d.unityhub\nTeamIdentifier=${team}\n` };
      if (args.includes("--releases")) return { out: '[{"version":"6000.3.26f1"},{"version":"6000.6.6f1"}]', err: "" };
      return { out: "", err: "" };
    },
    start: async (command, args, log) => {
      started.push({ command, args, log });
      await writeFile(log, "Downloading 15%\n");
      living.set(77, command);
      return 77;
    },
    programOf: async (pid) => living.get(pid),
    kill: () => undefined,
    freeBytes: async () => freeGb * GB,
    open: async (launch) => {
      opened.push(launch);
    },
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
  };
  const installer = createInstaller(deps, async () => storage);
  return { env, storage, ran, opened, started, living, installer, signIn, deps };
}

describe("installing Unity Hub for the person", () => {
  it("copies Unity's own Hub into Applications after checking Unity signed it, leaving no download behind", async () => {
    const mac = await installMac();
    await mac.installer.getHub();
    assert.deepEqual(
      mac.ran.map((call) => path.basename(call[0] ?? "")),
      ["hdiutil", "codesign", "codesign", "spctl", "ditto", "hdiutil"],
      "mount, check Unity's signature and Gatekeeper's verdict, copy, unmount",
    );
    assert.deepEqual(mac.ran[1]?.slice(1, 4), ["--verify", "--deep", "--strict"]);
    assert.ok(mac.ran[1]?.some((arg) => arg.startsWith("-R=anchor apple generic") && arg.includes(UNITY_TEAM_ID)));
    assert.equal(mac.ran[5]?.[1], "detach");
    // Copied beside under another name and renamed into place: a half-copied Hub never reads as installed.
    assert.notEqual(mac.ran[4]?.[2], path.join(mac.env.applications, "Unity Hub.app"));
    assert.equal(path.dirname(mac.ran[4]?.[2] ?? ""), mac.env.applications);
    assert.deepEqual(await readdir(mac.env.applications), ["Unity Hub.app"], "in Applications, and nothing else left");
    assert.equal(await mac.installer.job(), null);
    assert.deepEqual(await readdir(path.join(mac.storage, "unity-setup")), ["mount"], "the disk image is gone");
  });

  it("copies nothing that another team signed, and says so on the card", async () => {
    const mac = await installMac({ team: "ABCDE12345" });
    await assert.rejects(mac.installer.getHub(), /isn't signed by Unity/);
    assert.ok(!mac.ran.some((call) => call[0]?.endsWith("ditto")), "nothing is copied into Applications");
    assert.ok(mac.ran.at(-1)?.includes("detach"), "the image is still unmounted");
    const job = await mac.installer.job();
    assert.equal(job?.state, JobState.Failed);
    assert.match(String(job?.why), /isn't signed by Unity/);
  });
});

describe("installing Unity 6 through Hub", () => {
  it("starts Hub's install of the chosen release on its own, and the card follows it to its stop", async () => {
    const mac = await installMac({ hub: true });
    await mac.installer.installEditor();
    const hubProgram = path.join(mac.env.applications, "Unity Hub.app", "Contents", "MacOS", "Unity Hub");
    assert.deepEqual(
      mac.started.map((run) => [run.command, run.args]),
      [[hubProgram, ["--", "--headless", "install", "--version", "6000.3.26f1", "--architecture", "arm64"]]],
    );
    assert.deepEqual(await mac.installer.job(), {
      kind: JobKind.Editor,
      version: "6000.3.26f1",
      percent: 15,
      state: JobState.Running,
    });
    await mac.installer.installEditor();
    assert.equal(mac.started.length, 1, "a running install is never started twice");

    await writeFile(mac.started[0]?.log ?? "", "Downloading 15%\nError: the download was interrupted\n");
    mac.living.clear();
    const stopped = await mac.installer.job();
    assert.equal(stopped?.state, JobState.Failed);
    assert.equal(stopped?.inHub, true, "Hub's own window may finish what its command line could not");
    assert.match(String(stopped?.why), /stopped: Error: the download was interrupted/);

    // Hub says it is done, but put Unity somewhere Genex doesn't look (another install folder).
    await writeFile(
      mac.started[0]?.log ?? "",
      "[Unity (6000.3.26f1)] installed successfully.\nAll Tasks Completed Successfully.\n",
    );
    const elsewhere = await mac.installer.job();
    assert.match(String(elsewhere?.why), /says it installed Unity 6000\.3\.26f1/);
    assert.doesNotMatch(String(elsewhere?.why), /stopped/);

    await fakeEditor(path.join(mac.env.applications, "Unity", "Hub", "Editor"), "6000.3.26f1");
    assert.equal(await mac.installer.job(), null, "an install that ended with Unity there is done");
  });

  it("shows the install as started while Hub lists its releases, and says why when listing fails", async () => {
    const mac = await installMac({ hub: true });
    const listed = gate();
    const asked = gate();
    const run = mac.deps.run;
    mac.deps.run = async (command, args, timeoutMs) => {
      if (args.includes("--releases")) {
        asked.resolve();
        await listed.promise;
      }
      return run(command, args, timeoutMs);
    };
    const installing = mac.installer.installEditor();
    await asked.promise;
    assert.deepEqual(await mac.installer.job(), { kind: JobKind.Editor, state: JobState.Running });
    listed.resolve();
    await installing;
    assert.equal((await mac.installer.job())?.state, JobState.Running, "now Hub's own install");

    const broken = await installMac({ hub: true });
    broken.deps.run = async (command, args, timeoutMs) => {
      if (args.includes("--releases")) throw new Error("Unity Hub didn't answer");
      return run(command, args, timeoutMs);
    };
    await assert.rejects(broken.installer.installEditor(), /Unity Hub didn't answer/);
    const failed = await broken.installer.job();
    assert.equal(failed?.state, JobState.Failed);
    assert.match(String(failed?.why), /Unity Hub didn't answer/);
    assert.equal(failed?.inHub, true);
  });

  it("starts nothing without room for Unity, and says how much is free", async () => {
    const mac = await installMac({ hub: true, freeGb: 4.1 });
    await assert.rejects(mac.installer.installEditor(), /needs about 12 GB; 4\.1 GB is free/);
    assert.deepEqual(mac.started, []);
    const full = await mac.installer.job();
    assert.match(String(full?.why), /4\.1 GB is free/);
    assert.equal(full?.inHub, undefined, "only the person frees space");
  });
});

describe("stopping what Genex is doing", () => {
  it("ends Hub's install by its process group and shows it stopped, for Try again", async () => {
    const mac = await installMac({ hub: true });
    const signalled: [number, string][] = [];
    mac.deps.kill = (pid, signal) => {
      signalled.push([pid, signal]);
      mac.living.delete(Math.abs(pid));
    };
    await mac.installer.installEditor();
    await mac.installer.stop();
    assert.deepEqual(signalled, [[-77, "SIGTERM"]]);
    const job = await mac.installer.job();
    assert.equal(job?.state, JobState.Failed);
    assert.equal(job?.stopped, true);
    assert.match(String(job?.why), /You stopped/);
  });

  it("starts no install when Stop comes while Hub lists its releases, and ends the listing", async () => {
    const mac = await installMac({ hub: true });
    const listed = gate();
    const asked = gate();
    const run = mac.deps.run;
    let listing: AbortSignal | undefined;
    mac.deps.run = async (command, args, timeoutMs, signal) => {
      if (args.includes("--releases")) {
        listing = signal;
        asked.resolve();
        await listed.promise;
      }
      return run(command, args, timeoutMs, signal);
    };
    mac.installer.setUp();
    await asked.promise;
    const stopping = mac.installer.stop();
    listed.resolve();
    await stopping;
    assert.equal(listing?.aborted, true, "Hub's listing is told to end");
    assert.deepEqual(mac.started, [], "no install once stopped");
    const job = await mac.installer.job();
    assert.equal(job?.stopped, true);
    assert.match(String(job?.why), /You stopped/);
  });

  it("opens no Hub when Stop comes while Hub is copied into Applications", async () => {
    const mac = await installMac({ signedIn: false });
    const run = mac.deps.run;
    let stopping: Promise<void> | undefined;
    mac.deps.run = async (command, args, timeoutMs, signal) => {
      const answer = await run(command, args, timeoutMs, signal);
      if (command.endsWith("ditto")) stopping ??= mac.installer.stop();
      return answer;
    };
    mac.installer.setUp();
    await mac.installer.running();
    await stopping;
    assert.deepEqual(mac.opened, [], "Hub is not opened for a sign-in after Stop");
    assert.deepEqual(await readdir(mac.env.applications), [], "no Hub is put in place after Stop");
    assert.equal((await mac.installer.job())?.stopped, true);
  });

  it("never takes another program that got an ended install's process id for the install", async () => {
    const mac = await installMac({ hub: true });
    const signalled: number[] = [];
    mac.deps.kill = (pid) => {
      signalled.push(pid);
    };
    await mac.installer.installEditor();
    const hub = mac.living.get(77) ?? "";
    mac.living.set(77, "/Applications/Safari.app/Contents/MacOS/Safari");
    assert.equal((await mac.installer.job())?.state, JobState.Failed, "Hub's install has ended");
    mac.living.set(77, hub);
    assert.equal(
      (await mac.installer.job())?.state,
      JobState.Failed,
      "an install once seen ended stays ended, whatever later runs as its id",
    );
    await mac.installer.stop();
    assert.deepEqual(signalled, [], "nothing is signalled");
    await mac.installer.installEditor();
    assert.equal(mac.started.length, 2, "Try again starts the install again");
  });

  it("stops Do it for me while it waits for the sign-in, and starts nothing after", async () => {
    const mac = await installMac({ signedIn: false, hub: true });
    let stopping: Promise<void> | undefined;
    mac.deps.sleep = async () => {
      // The person presses Stop while Genex waits; the press itself waits for Do it for me to end.
      stopping ??= mac.installer.stop();
    };
    mac.installer.setUp();
    await mac.installer.running();
    await stopping;
    await mac.signIn();
    assert.deepEqual(mac.started, [], "no install once stopped");
    assert.equal((await mac.installer.job())?.stopped, true);
  });
});

describe("Do it for me", () => {
  it("installs Hub, opens it for the person's sign-in, waits for it, then installs Unity 6", async () => {
    const mac = await installMac({ signedIn: false });
    const seen: unknown[] = [];
    mac.deps.sleep = async () => {
      seen.push(await mac.installer.job());
      await mac.signIn();
    };
    mac.installer.setUp();
    await mac.installer.running();
    assert.deepEqual(mac.opened, [
      { command: "/usr/bin/open", args: ["-a", path.join(mac.env.applications, "Unity Hub.app")], detached: false },
    ]);
    assert.deepEqual(seen, [{ kind: JobKind.SignIn, state: JobState.Running }], "the card waits on the sign-in");
    assert.equal(mac.started.length, 1, "Unity 6's install started once the person signed in");
  });

  it("stops waiting when nobody signs in, and installs nothing", async () => {
    const mac = await installMac({ signedIn: false, hub: true });
    mac.installer.setUp();
    await mac.installer.running();
    assert.equal(mac.opened.length, 1);
    assert.deepEqual(mac.started, []);
  });
});

describe("the agent's show-steps", () => {
  /** A call's binding whose host also shows a steps card, counting each it shows. */
  function contextShowing(storage: string, game: string, shown: { count: number }): PluginContext {
    const base = pluginContext(storage, { project: "lantern", directory: game });
    return {
      ...base,
      host: (async (method: string) => {
        if (method === "storage.root") return storage;
        assert.equal(method, "game.engine.steps");
        shown.count++;
        return true;
      }) as PluginContext["host"],
    };
  }

  it("closes the card on Don't use Unity, telling the agent to offer a web game, until the agent shows it again", async () => {
    const mac = await installMac({ hub: true });
    const game = await realTmp("unity-game-");
    const backend = createUnityBackend({
      now: mac.deps.now,
      editors: mac.env,
      open: mac.deps.open,
      pipeline: undefined as never,
      processes: undefined as never,
      idleMs: async () => undefined,
      install: mac.deps,
    });
    const context = contextShowing(mac.storage, game, { count: 0 });
    const steps = async () => (await backend.action?.(UnityAction.Steps, {}, context)) as ReturnType<typeof setupCard>;
    assert.equal((await steps()).open, true);
    await backend.action?.(UnityAction.Skip, {}, context);
    const skipped = await steps();
    assert.equal(skipped.open, false);
    assert.match(String(skipped.doneSays), /web game/);
    await backend.tool?.(UnityTool.ShowSteps, {}, context);
    assert.equal((await steps()).open, true, "the person changed their mind");
  });

  it("puts the card in the chat while a step is open, and says Unity is ready when none is", async () => {
    const mac = await installMac({ hub: true });
    const game = await realTmp("unity-game-");
    const backend = createUnityBackend({
      now: mac.deps.now,
      editors: mac.env,
      open: mac.deps.open,
      pipeline: undefined as never,
      processes: undefined as never,
      idleMs: async () => undefined,
      install: mac.deps,
    });
    const shown = { count: 0 };
    const context = contextShowing(mac.storage, game, shown);
    assert.match(String(await backend.tool?.(UnityTool.ShowSteps, {}, context)), /setup card is in the chat/);
    assert.equal(shown.count, 1);
    const card = (await backend.action?.(UnityAction.Steps, {}, context)) as ReturnType<typeof setupCard>;
    assert.equal(card.steps.find((step) => !step.done)?.id, SetupStepId.InstallUnity);

    await fakeEditor(path.join(mac.env.applications, "Unity", "Hub", "Editor"), "6000.3.26f1");
    assert.match(String(await backend.tool?.(UnityTool.ShowSteps, {}, context)), /no setup card to show/);
    assert.equal(shown.count, 1, "nothing is shown once Unity is ready");
  });
});
