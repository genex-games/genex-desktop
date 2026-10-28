/**
 * The Godot plugin on Windows through its backend's interface, on a fake PC: Genex's own Godot
 * (the host's pinned download, confirmed by the person) offered to the agent once it is in place;
 * the setup card and the panel following the host's install; every Godot job a sandbox job of the
 * host's, with what it reads and writes named, its folders outside the game staged in the
 * project's `.godot` and copied out, its stop passed on and Godot's Windows output read as a
 * Mac's; and the person's editor opened and recognized by its Windows command line. Nothing here
 * starts Godot; `godot-windows-live.test.ts` does, on a Windows runner.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import type { PluginSetupCard } from "../../src/plugin-sdk/index.d.ts";
import { GodotTool } from "../../src/plugins/godot/backend.ts";
import { HookEvent } from "../../src/shared/plugin-hooks.ts";
import { GodotSetupAction } from "../../src/plugins/godot/godot-setup.ts";
import {
  type GodotCall,
  GodotJob,
  type GodotJobScope,
  readStaged,
  windowsRunner,
} from "../../src/plugins/godot/godot-run.ts";
import { unzipCall } from "../../src/plugins/godot/multiplayer.ts";
import { InstallPhase, type RuntimeInstallPhase } from "../../src/shared/model-install.ts";
import type { PluginSandboxRunArgs } from "../../src/shared/plugins.ts";
import {
  capturing,
  GODOT_472,
  godotOutput,
  godotWindowsFixture,
  OWN_GODOT,
  playArg,
  SCRIPTS,
  templatesArchive,
  WINDOWS_CMD,
} from "../helpers/godot-fake-engine.ts";
import { tmpDir } from "../helpers/tmp.ts";

type Answer = Record<string, unknown>;
const git = async (cwd: string, args: string[]) =>
  (await promisify(execFile)("git", ["-c", "core.autocrlf=false", ...args], { cwd })).stdout;
type Fixture = Awaited<ReturnType<typeof godotWindowsFixture>>;
const tool = async (fixture: Fixture, name: string, args = {}, more = {}) =>
  (await fixture.backend.tool?.(name, args, fixture.context(more))) as Answer;
const action = async (fixture: Fixture, name: string, args = {}) =>
  (await fixture.backend.action?.(name, args, fixture.context())) as Answer;
const card = async (fixture: Fixture) => (await action(fixture, GodotSetupAction.Steps)) as unknown as PluginSetupCard;
const MB = 2 ** 20;
/** Godot's Windows build writes CRLF lines and colours its progress even into a file. */
const windowsWords = (text: string) => `\u001b[92m[ DONE ]\u001b[39m\r\n${text.replaceAll("\n", "\r\n")}`;

/** A game whose Godot project New Godot game made on the fake PC, its sandbox requests since cleared. */
async function windowsProject(options: Parameters<typeof godotWindowsFixture>[0] = {}) {
  const fixture = await godotWindowsFixture({ installed: true, ...options });
  await tool(fixture, GodotTool.NewGame, { template: "3d", name: "Valley" });
  fixture.requests.length = 0;
  return { ...fixture, project: path.join(fixture.gameDir, "godot") };
}

describe("Godot on Windows: Genex's own Godot", () => {
  it("offers Godot to the agent once the host's pinned Godot is in place, and not before", async () => {
    const fixture = await godotWindowsFixture();
    const before = await tool(fixture, GodotTool.EngineStatus);
    assert.equal(before.ready, false);
    assert.match(String(before.note), /godot__show-steps/);
    await fixture.runtime.install();
    const after = await tool(fixture, GodotTool.EngineStatus);
    assert.deepEqual([after.ready, after.version], [true, "4.7.2"]);
    assert.match(String(after.note), /godot__new-game/);
  });

  it("leaves out a Godot the person keeps in their profile: Genex's sandbox can't run it", async () => {
    const fixture = await godotWindowsFixture({
      exes: [{ where: "Users/Ada/Downloads/Godot_v4.7.2-stable_win64.exe", version: GODOT_472 }],
    });
    assert.equal((await tool(fixture, GodotTool.EngineStatus)).ready, false);
  });

  it("puts the confirmed download on the card's Do it for me, and the card closes once Godot is in place", async () => {
    const fixture = await godotWindowsFixture();
    const open = await card(fixture);
    assert.equal(open.primary?.name, GodotSetupAction.Download);
    assert.equal(open.primary?.label, "Do it for me");
    assert.match(String(open.steps[0]?.detail), /about 86 MB\. Genex keeps it in its own folder/);
    await action(fixture, GodotSetupAction.Download);
    assert.equal(fixture.hostCalls.filter((call) => call.method === "runtime.install").length, 1);
    const done = await card(fixture);
    assert.equal(done.open, false);
    assert.match(String(done.doneSays), /Godot 4\.7 is installed on this computer/);
  });

  it("fetches the Web template with Godot on Do it for me, so the game exports for the web without Godot's editor", async () => {
    const network = templatesArchive({
      "templates/web_nothreads_release.zip": "web",
      "templates/version.txt": "4.7.2.stable",
    });
    const fixture = await godotWindowsFixture({ templates: network.fetch });
    await action(fixture, GodotSetupAction.Download);
    const templates = path.join(fixture.env.dataHome, "Godot", "export_templates", "4.7.2.stable");
    assert.equal(await readFile(path.join(templates, "web_nothreads_release.zip"), "utf8"), "web");
  });

  it("stops the Web template's fetch with Stop, as it stops Godot's download", async () => {
    const network = templatesArchive({ "templates/web_nothreads_release.zip": "web" });
    let asked: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      asked = resolve;
    });
    // A server that answers the first range only once the fetch is stopped.
    const held = (async (url, init) => {
      if (init?.method === "HEAD") return network.fetch(url, init);
      asked();
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof fetch;
    const fixture = await godotWindowsFixture({ templates: held });
    const downloading = action(fixture, GodotSetupAction.Download);
    await reached;
    await action(fixture, GodotSetupAction.Stop);
    await downloading;
    const templates = path.join(fixture.env.dataHome, "Godot", "export_templates", "4.7.2.stable");
    assert.deepEqual(await readdir(templates).catch(() => []), [], "nothing kept of it");
  });

  it("shows the host's install as it goes: the download, the unpacking, a stop and a failure", async () => {
    const fixture = await godotWindowsFixture();
    const at = (phase: RuntimeInstallPhase, more = {}) => {
      fixture.runtime.record = {
        runtime: "godot",
        phase,
        completed: 0,
        total: 0,
        active: true,
        updatedAt: "",
        ...more,
      };
    };
    at(InstallPhase.Downloading, { completed: 40 * MB, total: 82 * MB });
    const downloading = await card(fixture);
    assert.deepEqual(
      [downloading.steps[0]?.label, downloading.steps[0]?.detail],
      ["Downloading Godot 4", "40 of 82 MB"],
    );
    assert.equal(downloading.primary, undefined);
    assert.equal(downloading.secondary?.name, GodotSetupAction.Stop);
    at(InstallPhase.Extracting);
    assert.equal((await card(fixture)).steps[0]?.label, "Installing Godot 4");
    at(InstallPhase.Cancelled, { active: false });
    const stopped = await card(fixture);
    assert.deepEqual([stopped.primary?.label, stopped.stuckSays], ["Try again", undefined]);
    at(InstallPhase.Failed, { active: false, error: "Runtime digest mismatch" });
    const failed = await card(fixture);
    assert.equal(failed.primary?.name, GodotSetupAction.Download);
    assert.match(String(failed.steps[0]?.detail), /Couldn't install Godot \(Runtime digest mismatch\)/);
    assert.match(String(failed.stuckSays), /Try again is on the card\.$/);
    assert.equal((await action(fixture, "status")).installing !== null, true);
  });

  it("stops the host's install with Stop and with Don't use Godot", async () => {
    const fixture = await godotWindowsFixture();
    await action(fixture, GodotSetupAction.Stop);
    await action(fixture, GodotSetupAction.Skip);
    const cancels = fixture.hostCalls.filter((call) => call.method === "runtime.cancelInstall");
    assert.equal(cancels.length, 2);
    assert.equal((await card(fixture)).open, false);
  });

  it("never runs a Mac's install or opens a download page on Windows", async () => {
    const fixture = await godotWindowsFixture();
    await assert.rejects(action(fixture, GodotSetupAction.Install), /On Windows, Genex downloads Godot itself/);
    await assert.rejects(action(fixture, "get-godot"), /On Windows, Genex downloads Godot itself/);
    assert.deepEqual(fixture.editor.opened, []);
    assert.equal((await action(fixture, "status")).windows, true);
  });
});

describe("Godot on Windows: jobs in Genex's sandbox", () => {
  it("imports and checks as sandbox jobs of Genex's own Godot, reading Godot's Windows output", async () => {
    const check = windowsWords(await godotOutput("check-parse-errors.log"));
    const scripts: string[] = [];
    const fixture = await windowsProject({
      sandbox: async (request) => {
        const script = request.args[request.args.indexOf("-s") + 1];
        if (request.args.includes("-s") && script) scripts.push(await readFile(script, "utf8"));
        return { stderr: request.args.includes("-s") ? check : "" };
      },
    });
    const answer = await tool(fixture, GodotTool.Check);
    assert.equal(answer.ok, false);
    assert.equal(
      (answer.errors as string[])[0],
      'bad.gd:3: Parse Error: Cannot assign a value of type "String" as "int".',
    );
    assert.match(String(answer.summary), /Loaded 6/);
    const own = path.join(fixture.root, OWN_GODOT);
    const [imported, checked] = fixture.requests;
    assert.deepEqual(imported, {
      program: own,
      args: ["--headless", "--path", fixture.project, "--import"],
      reads: [path.dirname(own)],
      writes: [fixture.project],
      timeoutMs: imported?.timeoutMs,
    });
    assert.deepEqual(checked?.reads, [path.dirname(own), SCRIPTS]);
    // The sandbox user can't read the plugin's package: Genex's script is copied into the project's stage.
    const script = checked?.args.at(-1) ?? "";
    assert.equal(path.basename(script), "genex_check.gd");
    assert.equal(script.startsWith(path.join(fixture.project, ".godot", "genex-jobs")), true, script);
    assert.deepEqual(scripts, [await readFile(path.join(SCRIPTS, "genex_check.gd"), "utf8")]);
  });

  it("stages a capture's stills in the project's .godot, copies them out and removes the stage", async () => {
    let staged = "";
    const fixture = await windowsProject({
      sandbox: async (request) => {
        if (!request.args.includes("--position")) return {};
        staged = path.dirname(playArg({ args: request.args } as never, "out"));
        return { stdout: windowsWords(await capturing(["HeroCamera"])({ args: request.args } as never)) };
      },
    });
    const answer = await tool(fixture, GodotTool.Screenshot);
    assert.deepEqual(answer.shots, ["HeroCamera"]);
    assert.equal((answer.images as unknown[]).length, 1);
    assert.equal(
      path.dirname(path.dirname(staged)).startsWith(path.join(fixture.project, ".godot", "genex-jobs")),
      true,
    );
    const capture = fixture.requests.find((request) => request.args.includes("--position"));
    assert.deepEqual(capture?.writes, [fixture.project]);
    assert.deepEqual(await readdir(path.join(fixture.project, ".godot", "genex-jobs")), []);
  });

  it("names a staged folder as its own folder in what Godot says, in Godot's forward slashes too", async () => {
    const fixture = await windowsProject({
      sandbox: (request) => {
        if (!request.args.includes("--position")) return {};
        const out = path.dirname(playArg({ args: request.args } as never, "out"));
        const said = `ERROR: Can't save the still to '${out.replaceAll("\\", "/")}/HeroCamera.png'.\nERROR: Or to '${out}'.`;
        return { stderr: said };
      },
    });
    const refused = await tool(fixture, GodotTool.Screenshot).then(
      () => "",
      (error: Error) => error.message,
    );
    assert.match(refused, /Can't save the still/);
    assert.doesNotMatch(refused, /genex-jobs/, "the stage never reaches the agent");
  });

  it("makes the class reference in a staged folder and keeps it in the plugin's storage", async () => {
    const fixture = await windowsProject({
      sandbox: async (request) => {
        const at = request.args.indexOf("--doctool");
        if (at < 0) return {};
        const classes = path.join(request.args[at + 1] ?? "", "doc", "classes");
        await mkdir(classes, { recursive: true });
        await writeFile(path.join(classes, "Node.xml"), '<class name="Node" inherits="Object"></class>');
        return {};
      },
    });
    assert.match(String(await tool(fixture, GodotTool.ClassReference, { query: "Node" })), /class Node extends Object/);
    const doctool = fixture.requests.find((request) => request.args.includes("--doctool"));
    assert.deepEqual(doctool?.writes, [fixture.project]);
    assert.ok((await readdir(path.join(fixture.storage, "reference"))).length > 0);
  });

  it("puts the person's Web template in the sandbox user's own Godot data folder before a web export", async () => {
    const seen: string[] = [];
    const fixture = await windowsProject({
      sandbox: async (asked) => {
        const copy = asked.args.find((arg) => arg.startsWith("from="));
        if (copy) seen.push(await readFile(copy.slice("from=".length), "utf8"));
        if (copy)
          return { stdout: "GENEX_DATA_COPIED C:/Users/srt-sandbox/AppData/Roaming/Godot/export_templates\r\n" };
        if (!asked.args.includes("--export-release")) return {};
        const page = asked.args.at(-1) ?? "";
        for (const name of ["index.html", "index.pck"]) await writeFile(path.join(path.dirname(page), name), name);
        return {};
      },
    });
    const templates = path.join(fixture.env.dataHome, "Godot", "export_templates", "4.7.2.stable");
    await mkdir(templates, { recursive: true });
    await writeFile(path.join(templates, "web_nothreads_release.zip"), "zip");
    assert.match(String(await tool(fixture, GodotTool.WebExport)), /Exported the game for the web/);
    const copy = fixture.requests.find((request) => request.args.some((arg) => arg.startsWith("from=")));
    const exported = fixture.requests.find((request) => request.args.includes("--export-release"));
    assert.deepEqual(seen, ["zip"], "the template was in the project's stage while the copy ran");
    assert.equal(copy?.args.at(-1), "to=Godot/export_templates/4.7.2.stable/web_nothreads_release.zip");
    assert.equal(path.basename(copy?.args[copy.args.indexOf("-s") + 1] ?? ""), "genex_data.gd");
    assert.equal(
      fixture.requests.indexOf(copy as PluginSandboxRunArgs) <
        fixture.requests.indexOf(exported as PluginSandboxRunArgs),
      true,
    );
    assert.deepEqual(exported?.writes, [fixture.project, path.join(fixture.gameDir, "web")]);
    assert.deepEqual(await readdir(path.join(fixture.project, ".godot", "genex-jobs")), []);
  });

  it("stops a web export before Godot runs when the template couldn't be put in the sandbox user's folder", async () => {
    const fixture = await windowsProject({
      sandbox: (asked) =>
        asked.args.some((arg) => arg.startsWith("from=")) ? { stdout: "GENEX_DATA_FAILED File not found\r\n" } : {},
    });
    const templates = path.join(fixture.env.dataHome, "Godot", "export_templates", "4.7.2.stable");
    await mkdir(templates, { recursive: true });
    await writeFile(path.join(templates, "web_nothreads_release.zip"), "zip");
    await assert.rejects(
      tool(fixture, GodotTool.WebExport),
      /couldn't put Godot's Web export template where its sandbox reads it \(File not found\)/,
    );
    assert.equal(
      fixture.requests.some((request) => request.args.includes("--export-release")),
      false,
    );
  });

  it("makes the class reference in a game with no Godot project yet, in a folder of the job's own it removes", async () => {
    const fixture = await godotWindowsFixture({
      installed: true,
      sandbox: async (request) => {
        const at = request.args.indexOf("--doctool");
        const classes = path.join(request.args[at + 1] ?? "", "doc", "classes");
        await mkdir(classes, { recursive: true });
        await writeFile(path.join(classes, "Node.xml"), '<class name="Node" inherits="Object"></class>');
        return {};
      },
    });
    assert.match(String(await tool(fixture, GodotTool.ClassReference, { query: "Node" })), /class Node extends Object/);
    const [doctool] = fixture.requests;
    assert.equal(path.dirname(doctool?.writes[0] ?? ""), await realpath(fixture.gameDir));
    assert.match(path.basename(doctool?.writes[0] ?? ""), /^genex-godot-job-/);
    assert.deepEqual(await readdir(fixture.gameDir), [".gitignore"]);
  });

  it("keeps a job's own folder out of a checkpoint taken while the job runs", async () => {
    const committed: string[] = [];
    let fixture: Fixture | undefined;
    fixture = await godotWindowsFixture({
      installed: true,
      sandbox: async (request) => {
        const game = fixture?.gameDir ?? "";
        const at = request.args.indexOf("--doctool");
        const classes = path.join(request.args[at + 1] ?? "", "doc", "classes");
        await mkdir(classes, { recursive: true });
        await writeFile(path.join(classes, "Node.xml"), '<class name="Node" inherits="Object"></class>');
        assert.ok(
          (await readdir(game)).some((name) => name.startsWith("genex-godot-job-")),
          "the job's folder is there",
        );
        await git(game, ["add", "-A"]);
        committed.push(...(await git(game, ["diff", "--cached", "--name-only"])).split("\n").filter(Boolean));
        return {};
      },
    });
    await writeFile(path.join(fixture.gameDir, ".gitignore"), "node_modules\n");
    await git(fixture.gameDir, ["init", "-q"]);
    await tool(fixture, GodotTool.ClassReference, { query: "Node" });
    assert.deepEqual(committed, [".gitignore"]);
    assert.equal(
      await readFile(path.join(fixture.gameDir, ".gitignore"), "utf8"),
      "node_modules\ngenex-godot-job-*/\n",
    );
  });

  it("clears the stages a crash left in the game before its first job, and only those, as the sandbox user", async () => {
    const fixture = await windowsProject();
    const stage = STAGE_ID;
    const jobs = path.join(fixture.project, ".godot", "genex-jobs");
    const left = [path.join(fixture.gameDir, `genex-godot-job-${stage}`, "0"), path.join(jobs, stage, "0")];
    // Folders a stage's name doesn't fit: someone else's, never swept.
    const others = [path.join(fixture.gameDir, "genex-godot-job-notes"), path.join(jobs, "mine")];
    for (const folder of [...left, ...others]) await mkdir(folder, { recursive: true });
    const again = await godotWindowsFixture({ installed: true });
    await tool(again, GodotTool.Check, {}, { directory: fixture.gameDir });
    assert.equal((await readdir(fixture.gameDir)).includes(`genex-godot-job-${stage}`), false);
    assert.deepEqual(await readdir(jobs), ["mine"]);
    assert.ok((await readdir(fixture.gameDir)).includes("genex-godot-job-notes"));
    const removed = again.removals.map((request) => Object.values(request.env ?? {}).join(""));
    assert.ok(
      removed.some((line) => line === `rd /s /q "${path.join(jobs, stage)}"`),
      removed.join("\n"),
    );
    for (const request of again.removals) {
      assert.equal(request.program, WINDOWS_CMD, "Windows's own rd, run by the sandbox");
      assert.equal(request.writes.length, 1);
    }
  });

  it("never makes, lists, copies out of or removes anything through a link or a junction in a job's stage", async () => {
    const rows: Array<
      [string, (game: { gameDir: string; project: string }, outside: string) => Promise<void>, RegExp | null]
    > = [
      [
        "the project's .godot",
        async ({ project }, outside) => {
          await rm(path.join(project, ".godot"), { recursive: true, force: true });
          await link(outside, path.join(project, ".godot"));
        },
        /is a link or a junction/,
      ],
      [
        "its genex-jobs",
        async ({ project }, outside) => {
          await rm(path.join(project, ".godot", "genex-jobs"), { recursive: true, force: true });
          await link(outside, path.join(project, ".godot", "genex-jobs"));
        },
        /is a link or a junction/,
      ],
      [
        "a stage left in genex-jobs",
        ({ project }, outside) => link(outside, path.join(project, ".godot", "genex-jobs", STAGE_ID)),
        null,
      ],
      [
        "a job's own folder at the game's root",
        ({ gameDir }, outside) => link(outside, path.join(gameDir, `genex-godot-job-${STAGE_ID}`)),
        null,
      ],
    ];
    for (const [what, plant, refused] of rows) {
      const game = await windowsProject();
      const outside = await outsideFolder();
      const before = await holds(outside);
      await plant(game, outside);
      // A backend started after the link was put there sweeps the game before its first job.
      const again = await godotWindowsFixture({ installed: true });
      const checked = tool(again, GodotTool.Check, {}, { directory: game.gameDir });
      if (refused) await assert.rejects(checked, refused, what);
      else await checked;
      assert.deepEqual(await holds(outside), before, `${what}: nothing outside the game changed`);
      if (refused) assert.deepEqual(again.requests, [], `${what}: Godot never ran`);
    }
    // A link a job leaves in its staged folder is never copied out, nor what it points at.
    const outside = await outsideFolder();
    const fixture = await windowsProject({
      sandbox: async (request) => {
        const at = request.args.indexOf("--doctool");
        if (at < 0) return {};
        const classes = path.join(request.args[at + 1] ?? "", "doc", "classes");
        await mkdir(classes, { recursive: true });
        await writeFile(path.join(classes, "Node.xml"), '<class name="Node" inherits="Object"></class>');
        await link(outside, path.join(classes, "Secrets"));
        return {};
      },
    });
    await tool(fixture, GodotTool.ClassReference, { query: "Node" });
    const kept = (await readdir(path.join(fixture.storage, "reference"), { recursive: true })).map(String);
    assert.equal(
      kept.some((name) => name.includes("Secrets") || name.includes("keep.txt")),
      false,
      kept.join(", "),
    );
    assert.equal((await lstat(path.join(outside, "left", "keep.txt"))).isFile(), true);
  });

  it("never copies out a file read through a junction that was taken out again before the checks", async () => {
    const outside = await outsideFolder();
    const base = await realpath(await tmpDir("godot-stage-read-"));
    const stage = path.join(base, "stage");
    const aside = path.join(base, "aside");
    await mkdir(stage);
    await writeFile(path.join(stage, "notes.txt"), "the stage's own");
    assert.equal(String(await readStaged(base, stage, path.join(stage, "notes.txt"))), "the stage's own");
    // The person's file opened through a junction put in place of the stage, and the stage put back before the checks.
    await rename(stage, aside);
    await link(outside, stage);
    const read = await readStaged(base, stage, path.join(stage, "notes.txt"), async () => {
      // A junction goes with rmdir on Windows, a link with unlink elsewhere: never what it points to.
      await (process.platform === "win32" ? rmdir(stage) : unlink(stage));
      await rename(aside, stage);
    });
    assert.equal(read, null, "the file read isn't the one the stage's name holds now");
  });

  it("never removes what a junction swapped in for a stage while the sandbox removes it points to", async () => {
    const outside = await outsideFolder();
    const before = await holds(outside);
    let swapping = false;
    // The sandbox user's rd, with a junction to the person's folder swapped in for the stage while it works.
    const remove = async (stage: string) => {
      if (!swapping) return rm(stage, { recursive: true, force: true });
      swapping = false;
      await rm(stage, { recursive: true, force: true });
      await link(outside, stage);
      throw Object.assign(new Error("busy"), { code: "EBUSY" });
    };
    const fixture = await windowsProject({ remove });
    swapping = true;
    await tool(fixture, GodotTool.Check);
    assert.deepEqual(await holds(outside), before, "Genex removed nothing through the junction");
    const again = await godotWindowsFixture({ installed: true, remove });
    await tool(again, GodotTool.Check, {}, { directory: fixture.gameDir });
    assert.deepEqual(await holds(outside), before, "nor did the next sweep");
  });

  it("removes a stage Windows still holds once it lets go, and never fails the job when it doesn't", async (t) => {
    const held = (times: number) => {
      const tries: string[] = [];
      const remove = async (folder: string) => {
        tries.push(folder);
        if (tries.length <= times) throw Object.assign(new Error("busy"), { code: "EBUSY" });
        await rm(folder, { recursive: true, force: true });
      };
      return { tries, remove };
    };
    const briefly = held(2);
    const fixture = await windowsProject({ remove: briefly.remove });
    briefly.tries.length = 0;
    await tool(fixture, GodotTool.Check);
    assert.deepEqual(await readdir(path.join(fixture.project, ".godot", "genex-jobs")), []);
    const always = held(Number.POSITIVE_INFINITY);
    const stuck = await windowsProject({ remove: always.remove });
    always.tries.length = 0;
    const logged = t.mock.method(console, "error", () => undefined);
    await tool(stuck, GodotTool.Check);
    const lines = logged.mock.calls.map((call) => String(call.arguments[0]));
    assert.equal(
      lines.filter((line) => line.includes("still there after its removal")).length,
      1,
      "one line in the log",
    );
    // The import's stage is empty and goes by itself at once; the check's holds Genex's script.
    assert.equal(always.tries.length, 7, "one try for the import's stage, six for the check's");
    assert.equal(
      (await readdir(path.join(stuck.project, ".godot", "genex-jobs"))).length,
      1,
      "left for the next sweep",
    );
  });

  it("refuses a project linked from outside the game, never building it, and its save point's stills never throw", async () => {
    const outside = path.join(await realpath(await tmpDir("godot-outside-")), "Elsewhere");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "project.godot"), "config_version=5\n");
    const fixture = await godotWindowsFixture({ installed: true, linked: path.join(outside, "project.godot") });
    await assert.rejects(tool(fixture, GodotTool.Check), /only on a project inside the game's folder/);
    const hook = { on: HookEvent.CheckpointAfter, runId: "run-1" };
    assert.deepEqual(await tool(fixture, GodotTool.HeroShots, {}, { hook }), {});
    assert.deepEqual(fixture.requests, []);
  });

  it("offers and links only projects inside the game on Windows", async () => {
    const fixture = await windowsProject();
    const outside = path.join(fixture.home, "Documents", "Godot Projects", "Moon");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "project.godot"), 'config_version=5\n[application]\nconfig/name="Moon"\n');
    const offered = ((await action(fixture, "status")).projects as Array<{ name: string }>).map((p) => p.name);
    assert.equal(offered.includes("Moon"), false, JSON.stringify(offered));
    await assert.rejects(action(fixture, "use-project", { folder: outside }), /only inside the game's folder/);
  });

  it("starts a job with what its call's budget leaves once its turn comes, or not at all", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holdIn: () => void = () => undefined;
    const bothHeld = new Promise<void>((resolve) => {
      holdIn = resolve;
    });
    let holds = 0;
    const fixture = await windowsProject({
      sandbox: async (request) => {
        if (!request.args.includes("hold")) return {};
        holds += 1;
        if (holds === 2) holdIn();
        await gate;
        return {};
      },
    });
    const clock = { at: 0 };
    const turnOver = () => new Promise<void>((resolve) => setImmediate(resolve));
    const run = windowsRunner(turnOver, WINDOWS_CMD);
    const MINUTE = 60_000;
    const call = (tag: string): GodotCall => ({
      job: GodotJob.Import,
      args: ["--headless", tag],
      cwd: fixture.project,
      reads: [],
      writes: [fixture.project],
      timeoutMs: 8 * MINUTE,
      gpu: false,
    });
    const scope = (budget?: GodotJobScope["budget"], signal = new AbortController().signal): GodotJobScope => ({
      signal,
      host: fixture.context().host,
      game: fixture.gameDir,
      project: fixture.project,
      ...(budget ? { budget } : {}),
    });
    const budget = { until: 2 * MINUTE, now: () => clock.at, least: MINUTE, refusal: "no time left" };
    await run(OWN_GODOT, call("first"), scope(budget));
    assert.equal(fixture.requests.at(-1)?.timeoutMs, 2 * MINUTE, "what the budget leaves, not the job's own 8 minutes");
    // Both turns held: a third job waits, and the call's clock moves on meanwhile. Each job stages
    // its folders on disk before it asks for a turn, so the late job starts only once both holds
    // are in the sandbox: started with them, it could take a turn first, on the old clock.
    const holding = [run(OWN_GODOT, call("hold"), scope()), run(OWN_GODOT, call("hold"), scope())];
    await bothHeld;
    // A job listens for a stop only while it waits its turn (jobTurns in godot-run.ts): then, and
    // only then, the clock moves.
    const lateStop = new AbortController();
    const waiting = new Promise<"waiting">((resolve) => {
      const listen = lateStop.signal.addEventListener.bind(lateStop.signal);
      lateStop.signal.addEventListener = (...args: Parameters<typeof listen>) => {
        if (args[0] === "abort") resolve("waiting");
        listen(...args);
      };
    });
    const late = run(OWN_GODOT, call("late"), scope(budget, lateStop.signal));
    const ended = late.then(
      () => "ran" as const,
      () => "ended" as const,
    );
    assert.equal(await Promise.race([waiting, ended]), "waiting", "the late job waits its turn behind both holds");
    clock.at = 1.5 * MINUTE;
    release();
    await Promise.all(holding);
    await assert.rejects(late, /no time left/);
    assert.equal(
      fixture.requests.some((request) => request.args.includes("late")),
      false,
      "never started with less than its least",
    );
  });

  it("runs at most the host's limit of jobs at once, the others waiting their turn, none refused as busy", async () => {
    const fixture = await windowsProject({ runningReads: 20 });
    const runs = [GodotTool.Check, GodotTool.RunScene, GodotTool.Check].map((name) => tool(fixture, name));
    await Promise.all(runs);
    assert.equal(fixture.peak.most, 2);
    assert.equal(fixture.requests.length, 6);
  });

  it("gets the app templates the agent asks for, where its shell's Godot reads them, and a Mac export's textures", async () => {
    const network = templatesArchive({
      "templates/version.txt": "4.7.2.stable",
      "templates/windows_release_x86_64.exe": "win",
      "templates/windows_release_x86_64_console.exe": "console",
      "templates/macos.zip": "mac",
      "templates/linux_release.x86_64": "linux",
      "templates/linux_release.arm64": "linux arm",
    });
    const fixture = await windowsProject({
      templates: network.fetch,
      sandbox: (request) =>
        request.args.some((arg) => arg.startsWith("from=")) ? { stdout: "GENEX_DATA_COPIED somewhere\r\n" } : {},
    });
    const answer = String(await tool(fixture, GodotTool.ExportTemplates, { platforms: "windows, mac, linux" }));
    assert.match(answer, /export templates for windows, mac, linux are in place/);
    const templates = path.join(fixture.env.dataHome, "Godot", "export_templates", "4.7.2.stable");
    assert.deepEqual((await readdir(templates)).sort(), [
      "linux_release.x86_64",
      "macos.zip",
      "version.txt",
      "windows_release_x86_64.exe",
      "windows_release_x86_64_console.exe",
    ]);
    const placed = fixture.requests.flatMap((request) => request.args.filter((arg) => arg.startsWith("to=")));
    assert.deepEqual(placed, [
      "to=Godot/export_templates/4.7.2.stable/windows_release_x86_64.exe",
      "to=Godot/export_templates/4.7.2.stable/windows_release_x86_64_console.exe",
      "to=Godot/export_templates/4.7.2.stable/macos.zip",
      "to=Godot/export_templates/4.7.2.stable/linux_release.x86_64",
    ]);
    const settings = await readFile(path.join(fixture.project, "project.godot"), "utf8");
    assert.equal(settings.split("textures/vram_compression/import_etc2_astc=true").length, 2, "said once");
    await assert.rejects(tool(fixture, GodotTool.ExportTemplates, { platforms: "ios" }), /web, windows, mac or linux/);
  });

  it("passes a Stop on to the sandbox and starts nothing after it", async () => {
    const stop = new AbortController();
    let holding = false;
    const fixture = await windowsProject({
      sandbox: () => {
        if (!holding) return {};
        stop.abort();
        return { state: "running" };
      },
    });
    holding = true;
    await assert.rejects(tool(fixture, GodotTool.RunScene, {}, { signal: stop.signal }));
    assert.deepEqual(fixture.stopped, ["job-1"]);
    assert.equal(fixture.requests.length, 1);
  });

  it("names why the sandbox didn't start Godot", async () => {
    const fixture = await windowsProject({ sandbox: () => ({ state: "failed", reason: "ENOENT" }) });
    await assert.rejects(tool(fixture, GodotTool.RunScene), /Genex's sandbox didn't start Godot \(ENOENT\)/);
  });
});

/** A folder outside the game with what a person keeps there. */
async function outsideFolder(): Promise<string> {
  const folder = path.join(await realpath(await tmpDir("godot-stage-outside-")), "Documents");
  await mkdir(path.join(folder, "left"), { recursive: true });
  await writeFile(path.join(folder, "left", "keep.txt"), "mine");
  await writeFile(path.join(folder, "notes.txt"), "mine too");
  return folder;
}

/** What an outside folder holds now: its names and the file a removal through a link would take. */
async function holds(folder: string) {
  const names = (await readdir(folder, { recursive: true })).map(String).sort();
  return { names, keep: await readFile(path.join(folder, "left", "keep.txt"), "utf8") };
}

/** A junction on Windows (no privilege needed), a link elsewhere: the backend runs as the person either way. */
const link = (target: string, at: string) => symlink(target, at, process.platform === "win32" ? "junction" : "dir");

/** A stage's name as Genex gives one: a UUID. */
const STAGE_ID = "0b6f3c55-7d0e-4b7e-9a51-2f8c6d1e4a90";

describe("Godot on Windows: the person's editor", () => {
  it("opens the project in Genex's own Godot as a window of its own", async () => {
    const fixture = await windowsProject();
    await action(fixture, "open-editor");
    assert.deepEqual(fixture.editor.opened, [
      {
        command: path.join(fixture.root, OWN_GODOT),
        args: ["--path", fixture.project, "--editor"],
        detached: true,
      },
    ]);
  });

  it("knows the editor that has the project open by its Windows command line, whatever its slashes and case", async () => {
    const fixture = await windowsProject();
    const project = fixture.project.replaceAll(path.sep, "/").toUpperCase();
    fixture.editor.lines.push(`Godot_v4.7.2-stable_win64.exe --path ${project} --editor`);
    assert.equal((await action(fixture, "status")).editorOpen, true);
    fixture.editor.lines.splice(0, 1, `Godot_v4.7.2-stable_win64.exe --headless --path ${project} --import`);
    assert.equal((await action(fixture, "status")).editorOpen, false);
  });
});

describe("Godot on Windows: Genex multiplayer's native part", () => {
  it("unpacks the Colyseus release with Windows's own tar, never one on the PATH", () => {
    const entries = ["addons/colyseus/plugin.cfg"];
    assert.deepEqual(unzipCall("C:\\s\\release.zip", entries, "C:\\s\\unpacked", "win32", { SystemRoot: "D:\\Win" }), {
      command: "D:\\Win\\System32\\tar.exe",
      args: ["-xf", "C:\\s\\release.zip", "-C", "C:\\s\\unpacked", ...entries],
    });
    for (const env of [{}, { SystemRoot: "Windows" }])
      assert.equal(unzipCall("z", entries, "u", "win32", env).command, "C:\\Windows\\System32\\tar.exe");
    assert.deepEqual(unzipCall("/s/release.zip", entries, "/s/unpacked", "darwin"), {
      command: "/usr/bin/unzip",
      args: ["-q", "-o", "/s/release.zip", ...entries, "-d", "/s/unpacked"],
    });
  });
});
