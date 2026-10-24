/**
 * A Godot game's web export through the backend on a fake Mac: Genex's preset beside the person's
 * own, the job (the person's Web template linked into its private home, writes only to the project
 * and `web/`), refused before Godot runs without the template, a failure named by Godot's words,
 * and nothing written through a link.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { GodotTool } from "../../src/plugins/godot/backend.ts";
import { HookEvent } from "../../src/shared/plugin-hooks.ts";
import { parseVersion } from "../../src/plugins/godot/find-godot.ts";
import { type GodotCall, GodotJob } from "../../src/plugins/godot/godot-run.ts";
import { templateVersion, WEB_PRESET, withWebPreset } from "../../src/plugins/godot/web-export.ts";
import {
  GODOT_461,
  godotBackendFixture,
  type JobAnswers,
  offlineInstall,
  templatesArchive,
} from "../helpers/godot-fake-engine.ts";
import { tmpDir } from "../helpers/tmp.ts";

const TEMPLATES = "Library/Application Support/Godot/export_templates/4.6.1.stable";

/** Godot's export as the fake runner plays it: the page and its files in the folder it was given. */
async function exported(call: GodotCall): Promise<string> {
  const page = call.args.at(-1) ?? "";
  for (const name of ["index.html", "index.js", "index.wasm", "index.pck"])
    await writeFile(path.join(path.dirname(page), name), name);
  return "";
}

/** A game with a 2D project New Godot game made, the Web template installed or not, and Godot's export answered by `answers`. */
async function gameToExport(
  options: {
    template?: boolean;
    answers?: JobAnswers;
    network?: ReturnType<typeof templatesArchive>;
    now?: () => number;
  } = {},
) {
  const network = options.network ? { install: { ...offlineInstall("/none"), fetch: options.network.fetch } } : {};
  const fixture = await godotBackendFixture({
    answers: { [GodotJob.Export]: exported, ...options.answers },
    ...network,
    ...(options.now ? { now: options.now } : {}),
  });
  await fixture.backend.tool?.(GodotTool.NewGame, { template: "2d", name: "Moon" }, fixture.context());
  fixture.jobs.length = 0;
  if (options.template !== false) {
    await mkdir(path.join(fixture.home, TEMPLATES), { recursive: true });
    await writeFile(path.join(fixture.home, TEMPLATES, "web_nothreads_release.zip"), "zip");
  }
  const exportGame = async () => fixture.backend.tool?.(GodotTool.WebExport, {}, fixture.context());
  return {
    ...fixture,
    project: path.join(fixture.gameDir, "godot"),
    web: path.join(fixture.gameDir, "web"),
    exportGame,
  };
}

describe("a Godot game's web export", () => {
  it("names the template folder Godot looks in", () => {
    const rows: Array<[string, string]> = [
      [GODOT_461, "4.6.1.stable"],
      ["4.3.stable.official.77dcf97d8", "4.3.stable"],
      ["4.5.rc2.mono.official.abc", "4.5.rc2.mono"],
    ];
    for (const [line, folder] of rows) {
      const version = parseVersion(line);
      assert.ok(version, line);
      assert.equal(templateVersion(version), folder, line);
    }
  });

  it("adds Genex's preset once, after the person's own", () => {
    assert.match(withWebPreset(""), /^\[preset\.0\]\n\nname="Genex Web"\nplatform="Web"/);
    const theirs = '[preset.0]\n\nname="macOS"\nplatform="macOS"\n\n[preset.0.options]\n\n[preset.3]\n\nname="Linux"\n';
    const added = withWebPreset(theirs);
    assert.ok(added.startsWith(theirs.trimEnd()), "the person's presets stay");
    assert.match(added, /\[preset\.4\]\n\nname="Genex Web"/);
    assert.match(added, /variant\/thread_support=false/);
    assert.equal(withWebPreset(added), added, "twice is once");
  });

  it("exports into web/ with the person's template linked in, writing only the project and web/", async () => {
    const game = await gameToExport();
    const answer = String(await game.exportGame());
    assert.match(answer, /Exported the game for the web into web\/ \(4 files\)/);
    const [job] = game.jobs;
    assert.equal(job?.call.job, GodotJob.Export);
    assert.deepEqual(job?.call.args, [
      "--headless",
      "--path",
      game.project,
      "--export-release",
      WEB_PRESET,
      path.join(game.web, "index.html"),
    ]);
    assert.deepEqual(job?.call.writes, [game.project, game.web]);
    assert.deepEqual(
      job?.call.writePrefixes,
      [path.join(game.root, "user-temp", "tmpproject.binary")],
      "and the one file Godot writes, under names of its own, in macOS's own temporary folder",
    );
    assert.deepEqual(job?.call.reads, [path.join(game.home, TEMPLATES)]);
    assert.deepEqual(job?.call.homeLinks, [{ at: TEMPLATES, to: path.join(game.home, TEMPLATES) }]);
    assert.match(await readFile(path.join(game.project, "export_presets.cfg"), "utf8"), /name="Genex Web"/);
    assert.deepEqual((await readdir(game.web)).sort(), [
      ".gdignore",
      "index.html",
      "index.js",
      "index.pck",
      "index.wasm",
    ]);
  });

  it("is refused before Godot runs when the Web template is missing and can't be fetched, and says how to get it", async () => {
    const game = await gameToExport({ template: false });
    await assert.rejects(
      game.exportGame(),
      /Web export template isn't on this computer and Genex couldn't fetch it: [\s\S]*offline[\s\S]*Manage Export Templates/,
    );
    assert.deepEqual(game.jobs, []);
    assert.equal(await lstat(game.web).catch(() => null), null, "no web folder made");
  });

  it("fetches the missing Web template from Godot's own templates archive by ranges, then exports", async () => {
    const network = templatesArchive({
      "templates/version.txt": "4.6.1.stable",
      "templates/web_nothreads_release.zip": "the web template",
      "templates/macos.zip": "x".repeat(100_000),
    });
    const game = await gameToExport({ template: false, network });
    assert.match(String(await game.exportGame()), /Exported the game for the web/);
    assert.equal(
      await readFile(path.join(game.home, TEMPLATES, "web_nothreads_release.zip"), "utf8"),
      "the web template",
    );
    assert.equal(await readFile(path.join(game.home, TEMPLATES, "version.txt"), "utf8"), "4.6.1.stable");
    assert.equal(
      await lstat(path.join(game.home, TEMPLATES, "macos.zip")).catch(() => null),
      null,
      "only what was asked",
    );
    assert.equal(
      network.urls[0],
      "https://github.com/godotengine/godot/releases/download/4.6.1-stable/Godot_v4.6.1-stable_export_templates.tpz",
    );
    assert.equal(network.asked.includes("all"), false, "never the whole archive");
    network.asked.length = 0;
    await game.exportGame();
    assert.deepEqual(network.asked, [], "a template already there is kept");
  });

  it("fits a template's fetch and Godot's export into the one call, never starting an export it can't finish", async () => {
    const MINUTE = 60_000;
    /** A network whose first request takes `minutes` on the call's clock. */
    const slow = (minutes: number) => {
      const clock = { at: 0 };
      const network = templatesArchive({
        "templates/version.txt": "4.6.1.stable",
        "templates/web_nothreads_release.zip": "the web template",
      });
      const served = network.fetch;
      let first = true;
      const fetch = (async (...args: Parameters<typeof served>) => {
        if (first) clock.at += minutes * MINUTE;
        first = false;
        return served(...args);
      }) as typeof served;
      return { network: { ...network, fetch }, now: () => clock.at };
    };
    const quick = slow(0);
    const fresh = await gameToExport({ template: false, network: quick.network, now: quick.now });
    await fresh.exportGame();
    assert.equal(fresh.jobs[0]?.call.timeoutMs, 8 * MINUTE, "a quick fetch leaves Godot its whole export time");
    const long = slow(7.5);
    const late = await gameToExport({ template: false, network: long.network, now: long.now });
    await late.exportGame();
    const timeout = late.jobs[0]?.call.timeoutMs ?? 0;
    assert.ok(timeout <= 9 * MINUTE - 7.5 * MINUTE, `the export gets what the fetch left: ${timeout} ms`);
    const longer = slow(8);
    const none = await gameToExport({ template: false, network: longer.network, now: longer.now });
    await assert.rejects(none.exportGame(), /took most of this call's time[\s\S]*export again/);
    assert.deepEqual(none.jobs, [], "no export started that the call would cut");
  });

  it("refuses a template that arrives damaged, keeping nothing of it", async () => {
    const network = templatesArchive({ "templates/web_nothreads_release.zip": "the web template" });
    const crc = network.archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 16;
    network.archive.writeUInt32LE(network.archive.readUInt32LE(crc) ^ 1, crc);
    const game = await gameToExport({ template: false, network });
    await assert.rejects(game.exportGame(), /arrived damaged/);
    assert.deepEqual(await readdir(path.join(game.home, TEMPLATES)).catch(() => []), []);
  });

  it("names what Godot said when it wrote no export", async () => {
    const failing = 'ERROR: Cannot export project with preset "Genex Web" due to configuration errors.\n';
    const game = await gameToExport({ answers: { [GodotJob.Export]: failing } });
    await assert.rejects(game.exportGame(), /web export didn't finish: ERROR: Cannot export project/);
  });

  it("keeps the web build as the game is: after a turn or a restore that changed the project, never otherwise", async () => {
    const game = await gameToExport();
    const at = async (on: HookEvent) =>
      (await game.backend.tool?.(GodotTool.KeepWebBuild, {}, game.context({ hook: { on } }))) as Record<
        string,
        unknown
      >;
    assert.deepEqual(await at(HookEvent.TurnEnd), {});
    assert.equal(game.jobs.filter((j) => j.call.job === GodotJob.Export).length, 1, "the first turn's end makes it");
    assert.deepEqual(await at(HookEvent.TurnEnd), {});
    assert.equal(game.jobs.filter((j) => j.call.job === GodotJob.Export).length, 1, "nothing changed: not again");
    assert.deepEqual(await at(HookEvent.CheckpointAfter), {}, "only at a turn's end or after a restore");
    const later = new Date(Date.now() + 60_000);
    await utimes(path.join(game.project, "main.tscn"), later, later);
    assert.deepEqual(await at(HookEvent.RestoreAfter), {});
    assert.equal(game.jobs.filter((j) => j.call.job === GodotJob.Export).length, 2, "a changed project: again");
  });

  it("keeps no web build without the Web template, never fetching it, and a failed one is a note, never a block", async () => {
    const none = await gameToExport({ template: false });
    const at = async (fixture: typeof none) =>
      (await fixture.backend.tool?.(
        GodotTool.KeepWebBuild,
        {},
        fixture.context({ hook: { on: HookEvent.TurnEnd } }),
      )) as Record<string, unknown>;
    assert.deepEqual(await at(none), {});
    assert.deepEqual(none.jobs, []);
    // Nor does a turn's end fetch the template, on any turn: Do it for me and web-export do.
    const network = templatesArchive({ "templates/web_nothreads_release.zip": "the web template" });
    const reachable = await gameToExport({ template: false, network });
    for (const on of [HookEvent.TurnEnd, HookEvent.RestoreAfter, HookEvent.TurnEnd])
      await reachable.backend.tool?.(GodotTool.KeepWebBuild, {}, reachable.context({ hook: { on } }));
    assert.deepEqual(network.asked, [], "nothing asked of the network");
    assert.deepEqual(reachable.jobs, []);
    const failing = await gameToExport({ answers: { [GodotJob.Export]: "ERROR: Cannot export project.\n" } });
    assert.match(String((await at(failing)).note), /web build in web\/ wasn't refreshed/);
  });

  it("writes nothing through a link", async () => {
    const outside = await tmpDir("studio-godot-web-outside-");
    const rows: Array<[string, (game: Awaited<ReturnType<typeof gameToExport>>) => Promise<void>]> = [
      ["web/", (game) => symlink(outside, game.web)],
      [
        "web/.gdignore",
        async (game) => {
          await mkdir(game.web);
          await symlink(path.join(outside, "marker"), path.join(game.web, ".gdignore"));
        },
      ],
      [
        "export_presets.cfg",
        (game) => symlink(path.join(outside, "presets"), path.join(game.project, "export_presets.cfg")),
      ],
    ];
    for (const [what, plant] of rows) {
      const game = await gameToExport();
      await plant(game);
      await assert.rejects(game.exportGame(), /is a link/, what);
      assert.deepEqual(game.jobs, [], what);
    }
    assert.deepEqual(await readdir(outside), [], "nothing outside the game");
  });
});
