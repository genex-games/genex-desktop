/**
 * Godot's setup card for a Mac without Godot, and Genex installing Godot for the person from it:
 * the newest stable Godot 4 Mac build from Godot's own releases, copied into Applications only when
 * Godot's team signed it; Stop and Don't use Godot; the agent told when Godot is there. Nothing here
 * reaches the network or runs a program: the download, programs and folders are the test's.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createGodotInstaller,
  GODOT_TEAM_ID,
  type GodotInstallDeps,
  GodotJobState,
  GodotSetupAction,
  godotAsset,
  godotSetupCard,
} from "../../src/plugins/godot/godot-setup.ts";
import type { GodotInstall } from "../../src/plugins/godot/find-godot.ts";
import { godotBackendFixture } from "../helpers/godot-fake-engine.ts";
import { tmpDir } from "../helpers/tmp.ts";

const INSTALLED: GodotInstall = {
  binary: "/Applications/Godot.app/Contents/MacOS/Godot",
  app: "/Applications/Godot.app",
  version: { major: 4, minor: 7, patch: 2, status: "stable", mono: false, text: "4.7.2.stable.official" },
  supported: true,
};
const ZIP =
  "https://github.com/godotengine/godot/releases/download/4.7.2-stable/Godot_v4.7.2-stable_macos.universal.zip";
const RELEASE = {
  tag_name: "4.7.2-stable",
  assets: [
    {
      name: "Godot_v4.7.2-stable_mono_macos.universal.zip",
      browser_download_url: ZIP.replace("_macos", "_mono_macos"),
    },
    {
      name: "Godot_v4.7.2-stable_linux.x86_64.zip",
      browser_download_url: ZIP.replace("macos.universal", "linux.x86_64"),
    },
    { name: "Godot_v4.7.2-stable_macos.universal.zip", browser_download_url: ZIP },
  ],
};

describe("Godot's setup card", () => {
  it("offers Do it for me and Don't use Godot on a Mac without Godot", () => {
    const card = godotSetupCard(undefined, null, false);
    assert.equal(card.open, true);
    assert.equal(card.primary?.name, GodotSetupAction.Install);
    assert.equal(card.primary?.label, "Do it for me");
    assert.equal(card.secondary?.label, "Don't use Godot");
    assert.equal(card.steps[0]?.done, false);
  });

  it("says how far the download got, with Stop in Hide's place", () => {
    const card = godotSetupCard(
      undefined,
      { state: GodotJobState.Running, version: "4.7.2", done: 40 * 2 ** 20, total: 170 * 2 ** 20 },
      false,
    );
    assert.equal(card.primary, undefined);
    assert.equal(card.secondary?.name, GodotSetupAction.Stop);
    assert.equal(card.steps[0]?.label, "Downloading Godot 4.7.2");
    assert.equal(card.steps[0]?.detail, "40 of 170 MB");
    assert.equal(card.steps[0]?.working, true);
  });

  it("tells the agent once a step stops, unless the person stopped it", () => {
    const failed = godotSetupCard(undefined, { state: GodotJobState.Failed, why: "Couldn't download Godot." }, false);
    assert.equal(failed.primary?.label, "Try again");
    assert.equal(failed.steps[0]?.you, true);
    assert.match(String(failed.stuckSays), /Couldn't download Godot/);
    const stopped = godotSetupCard(
      undefined,
      { state: GodotJobState.Failed, why: "You stopped it.", stopped: true },
      false,
    );
    assert.equal(stopped.stuckSays, undefined);
  });

  it("closes with what the agent is told: Godot is there, or the person chose not to use it", () => {
    const ready = godotSetupCard(INSTALLED, null, false);
    assert.equal(ready.open, false);
    assert.match(String(ready.doneSays), /Godot 4\.7 is installed/);
    const skipped = godotSetupCard(undefined, null, true);
    assert.equal(skipped.open, false);
    assert.match(String(skipped.doneSays), /web game/);
  });
});

describe("choosing Godot to install", () => {
  it("takes the standard universal Mac build of a stable Godot 4, from Godot's own repository", () => {
    assert.deepEqual(godotAsset(RELEASE), { version: "4.7.2", url: ZIP });
    const elsewhere = { assets: [{ ...RELEASE.assets[2], browser_download_url: "https://example.com/Godot.zip" }] };
    assert.equal(godotAsset(elsewhere), undefined, "only Godot's own download");
    const five = { assets: [{ name: "Godot_v5.0-stable_macos.universal.zip", browser_download_url: ZIP }] };
    assert.equal(godotAsset(five), undefined, "Genex builds with Godot 4");
    for (const nothing of [null, {}, { assets: "x" }]) assert.equal(godotAsset(nothing), undefined);
  });
});

/** A Mac where Genex installs Godot: the release, the zip, the programs and the Applications folder the test decides. */
async function installMac(team = GODOT_TEAM_ID) {
  const root = await tmpDir("godot-install-");
  const applications = path.join(root, "Applications");
  const trash = path.join(root, "home", ".Trash");
  await mkdir(applications, { recursive: true });
  await mkdir(trash, { recursive: true });
  const ran: string[][] = [];
  const deps: GodotInstallDeps = {
    applications,
    trash,
    fetch: (async (url: string) =>
      url.includes("api.github.com")
        ? new Response(JSON.stringify(RELEASE))
        : new Response(new Uint8Array(2048), { headers: { "content-length": "2048" } })) as typeof fetch,
    run: async (command, args) => {
      ran.push([path.basename(command), ...args]);
      if (args[0] === "-x") await mkdir(path.join(args[3] ?? "", "Godot.app"), { recursive: true });
      else if (command.endsWith("ditto")) await mkdir(args[1] ?? "", { recursive: true });
      if (args.includes("-dv")) return { out: "", err: `Identifier=org.godotengine.godot\nTeamIdentifier=${team}\n` };
      return { out: "", err: "" };
    },
  };
  const storage = path.join(root, "storage");
  await mkdir(storage, { recursive: true });
  return { applications, trash, storage, ran, installer: createGodotInstaller(deps, async () => storage), deps };
}

describe("installing Godot for the person", () => {
  it("unpacks Godot's zip and copies Godot.app into Applications once Godot's team signed it", async () => {
    const mac = await installMac();
    mac.installer.install();
    await mac.installer.running();
    assert.deepEqual(
      mac.ran.map((call) => call[0]),
      ["ditto", "codesign", "codesign", "spctl", "ditto"],
      "unpack, check the signature and Gatekeeper's verdict, copy",
    );
    assert.deepEqual(await readdir(mac.applications), ["Godot.app"]);
    assert.equal(mac.installer.job(), null);
  });

  it("copies nothing another team signed, says so, and leaves no download behind", async () => {
    const mac = await installMac("ABCDE12345");
    mac.installer.install();
    await mac.installer.running();
    assert.deepEqual(await readdir(mac.applications), []);
    assert.match(String(mac.installer.job()?.why), /isn't signed by the Godot team/);
    assert.deepEqual(await readdir(mac.storage), [], "the download and its unpacked copy are gone");
  });

  it("replaces an older Godot.app in Applications, moving the older one to the Trash", async () => {
    const mac = await installMac();
    const older = path.join(mac.applications, "Godot.app");
    await mkdir(older);
    await writeFile(path.join(older, "version"), "4.2");
    mac.installer.install();
    await mac.installer.running();
    assert.equal(mac.installer.job(), null, "installed");
    assert.deepEqual(await readdir(mac.applications), ["Godot.app"]);
    assert.deepEqual(await readdir(older), [], "the new Godot is in place");
    assert.equal(await readFile(path.join(mac.trash, "Godot.app", "version"), "utf8"), "4.2", "the older one is kept");
  });

  it("stops while Godot unpacks: nothing is checked or copied after, and the download is gone", async () => {
    const mac = await installMac();
    const run = mac.deps.run;
    let stopping: Promise<void> | undefined;
    mac.deps.run = async (command, args, timeoutMs, signal) => {
      const answer = await run(command, args, timeoutMs, signal);
      if (args[0] === "-x") stopping ??= mac.installer.stop();
      return answer;
    };
    mac.installer.install();
    await mac.installer.running();
    await stopping;
    assert.deepEqual(
      mac.ran.map((call) => call[0]),
      ["ditto"],
      "only the unpacking ran",
    );
    assert.deepEqual(await readdir(mac.applications), []);
    assert.deepEqual(await readdir(mac.storage), []);
    assert.equal(mac.installer.job()?.stopped, true);
  });
});

describe("Godot's card in a game's chat", () => {
  it("shows the card while Godot is missing, closes on Don't use Godot, and shows again when the agent asks", async () => {
    const mac = await installMac();
    const fixture = await godotBackendFixture({ apps: [], install: mac.deps });
    const steps = async () =>
      (await fixture.backend.action?.(GodotSetupAction.Steps, {}, fixture.context())) as ReturnType<
        typeof godotSetupCard
      >;
    assert.match(
      String(await fixture.backend.tool?.("show-steps", {}, fixture.context())),
      /setup card is in the chat/,
    );
    assert.ok(fixture.hostCalls.some((call) => call.method === "game.engine.steps"));
    assert.equal((await steps()).open, true);
    await fixture.backend.action?.(GodotSetupAction.Skip, {}, fixture.context());
    assert.equal((await steps()).open, false);
    await fixture.backend.tool?.("show-steps", {}, fixture.context());
    assert.equal((await steps()).open, true);
  });

  it("points the agent at the card when it asks for a new game without Godot", async () => {
    const fixture = await godotBackendFixture({ apps: [] });
    await assert.rejects(
      Promise.resolve(fixture.backend.tool?.("new-game", { template: "3d", name: "Valley" }, fixture.context())),
      /godot__show-steps/,
    );
  });
});
