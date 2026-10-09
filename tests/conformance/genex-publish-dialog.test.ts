/**
 * Publish pressed in Studio's own Publish dialog. The dialog Studio draws says what publishing
 * does and then shows the exact files that would go online; publishing that list is the consent,
 * so no native dialog and no chat card ask again. Only for a game Studio may open, only through
 * the bundled Genex plugin while it is on, and only for the very files the person saw.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { EXPORT_APPROVAL_TTL_MS, ExportApprovals } from "../../src/main/core/export-approvals.ts";
import { GenexStudioTool } from "../../src/main/core/genex-cli-prompts.ts";
import {
  PublishRefusal,
  PublishRefusedError,
  publishFromDialog,
  publishReview,
} from "../../src/main/core/genex-publish.ts";
import type { ExportResult } from "../../src/shared/game-project.ts";
import { GENEX_PLUGIN_ID, GenexAction, GenexPublishKind } from "../../src/shared/genex.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { type ExportReview, type PluginBinding, PluginService, PluginSourceKind } from "../../src/shared/plugins.ts";
import { UiEvent, type UiEventMap } from "../../src/shared/ui-events.ts";
import { writeEngineBinding } from "../../src/substrate/game-engine-binding.ts";
import { coreLite } from "../helpers/core-lite.ts";

const GAME = "publish-me";
/** A game that builds in Unreal, beside the rig's web game. */
const UNREAL_GAME = "dirt-track";
const UNREAL_TITLE = "Dirt Track";
const UNREAL_REFUSAL = "Dirt Track builds in Unreal; publishing an Unreal game isn't supported yet.";
type Consent = UiEventMap[typeof UiEvent.PluginConsent];

/** How long a test waits for the host to ask about a file list. */
const ASK_WAIT_MS = 5000;
const ASK_POLL_MS = 20;

/**
 * A real core with one game. Plugin actions are recorded instead of run, except that Genex's
 * publish stages the public copy inside the call, as its backend does.
 */
async function dialogRig() {
  const consents: Consent[] = [];
  const lite = await coreLite({
    // A card nobody expected fails the test as a timed-out decline instead of hanging it.
    consentTimeoutMs: ASK_WAIT_MS,
    onUiEvent: (event) => {
      if (event.type === UiEvent.PluginConsent) consents.push(event.payload as Consent);
    },
  });
  const game = await lite.core.games.scaffold(GAME);
  // A page with nothing to vendor, and a file the export leaves out, so both lists have something.
  await writeFile(path.join(game.dir, "index.html"), "<!DOCTYPE html><title>Fixture</title><h1>Playable</h1>");
  await writeFile(path.join(game.dir, "studio.json"), JSON.stringify({ exportFiles: ["index.html", ".env.local"] }));
  await writeFile(path.join(game.dir, ".env.local"), "FIXTURE_SECRET=private");
  const binding: PluginBinding = { project: GAME, directory: game.dir };
  let stages = 0;
  /** What the Genex backend does once its publish starts: the host stages the public copy. */
  const exportStage = () => {
    const stage = lite.core.pluginServices.exportStage;
    assert.ok(stage);
    return stage(binding, path.join(lite.userData, "publish-stage", String(++stages)), "genex");
  };
  const calls: Array<{ id: string; name: string; args: unknown; binding?: PluginBinding }> = [];
  const staged: ExportReview[] = [];
  lite.core.plugins.action = async (id, name, args, bound) => {
    calls.push({ id, name, args, binding: bound });
    if (name === "publish-gallery") staged.push(await exportStage());
    return {};
  };
  /** The file-list card the host asks in chat. */
  const asked = async (): Promise<Consent> => {
    for (let waited = 0; waited < ASK_WAIT_MS && !consents.some((c) => c.state === "pending"); waited += ASK_POLL_MS)
      await delay(ASK_POLL_MS);
    const pending = consents.find((c) => c.state === "pending");
    assert.ok(pending, "a card asked about the files");
    return pending;
  };
  return { ...lite, game, calls, staged, consents, exportStage, asked };
}

/** Dirt Track, linked to the Unreal project New game puts in its own `unreal/` folder. */
async function addUnrealGame(rig: Awaited<ReturnType<typeof dialogRig>>) {
  const game = await rig.core.games.scaffold(UNREAL_GAME, { title: UNREAL_TITLE });
  const project = path.join(game.dir, "unreal", "DirtTrack.uproject");
  await mkdir(path.dirname(project), { recursive: true });
  await writeFile(project, "{}");
  await writeEngineBinding(game.dir, project);
  return game;
}

/** Refused for being an Unreal game: by its code, in the words the person reads. */
const refusedAsUnreal = (error: unknown): boolean => {
  assert.ok(error instanceof PublishRefusedError, String(error));
  assert.equal(error.code, PublishRefusal.UnrealGame);
  assert.equal(error.message, UNREAL_REFUSAL);
  return true;
};

test("Publish first shows the files the game would upload, and starts nothing", async () => {
  const rig = await dialogRig();
  try {
    const review = await publishReview(rig.core, GAME);
    assert.deepEqual(review, { included: ["index.html"], excluded: [".env.local"] });
    assert.deepEqual(review.included, [...review.included].sort());
    assert.deepEqual(rig.calls, [], "Genex is asked nothing");
    assert.deepEqual(rig.consents, [], "and nobody is asked anything");
  } finally {
    await rig.close();
  }
});

test("publishing the shown files publishes the open game to the gallery, and they are not asked about again", async () => {
  const rig = await dialogRig();
  try {
    const review = await publishReview(rig.core, GAME);
    await publishFromDialog(rig.core, GAME, review);
    assert.deepEqual(rig.calls, [
      {
        id: "genex",
        name: "publish-gallery",
        args: {},
        binding: { project: GAME, directory: rig.game.dir, threadId: undefined },
      },
    ]);
    assert.equal(rig.staged.length, 1, "Genex staged the public copy");
    assert.deepEqual([...rig.staged[0]!.included].sort(), review.included);
    assert.deepEqual(rig.consents, [], "no card in any chat");
    // The approval ended with that publish: the next export is asked about in chat, as an agent's is.
    const again = rig.exportStage();
    void again.catch(() => {});
    rig.core.resolveConsent((await rig.asked()).consentId, false);
    await assert.rejects(again, /declined/);
  } finally {
    await rig.close();
  }
});

test("the name typed in the dialog reaches Genex as one clean line, and a blank one is left to Genex Tools", async () => {
  const rig = await dialogRig();
  try {
    const titles: Array<[unknown, Record<string, unknown>]> = [
      ["  Rain\nCircuit ", { title: "Rain Circuit" }],
      ["   ", {}],
      [42, {}],
      [undefined, {}],
    ];
    for (const [title, args] of titles) {
      await publishFromDialog(rig.core, GAME, await publishReview(rig.core, GAME), title);
      assert.deepEqual(rig.calls.at(-1)?.args, args, JSON.stringify(title));
    }
  } finally {
    await rig.close();
  }
});

test("files that changed since the dialog showed them are asked about in chat", async () => {
  const rig = await dialogRig();
  try {
    const review = await publishReview(rig.core, GAME);
    const seen = { included: review.included.filter((file) => file !== "index.html"), excluded: review.excluded };
    const publishing = publishFromDialog(rig.core, GAME, seen);
    void publishing.catch(() => {});
    rig.core.resolveConsent((await rig.asked()).consentId, false);
    await assert.rejects(publishing, /declined/);
    assert.deepEqual(rig.staged, [], "Genex got no copy");
  } finally {
    await rig.close();
  }
});

test("Publish refuses anything but a game's name and a file list, and asks Genex nothing", async () => {
  const rig = await dialogRig();
  try {
    const review = await publishReview(rig.core, GAME);
    const projects: unknown[] = [
      undefined,
      null,
      "",
      42,
      {},
      [GAME],
      `../${GAME}`,
      `${GAME}/../../etc`,
      "/etc",
      `${GAME}\0`,
    ];
    for (const project of projects) {
      await assert.rejects(publishReview(rig.core, project), Error, `review ${JSON.stringify(project)}`);
      await assert.rejects(publishFromDialog(rig.core, project, review), Error, JSON.stringify(project));
    }
    const reviews: unknown[] = [
      undefined,
      null,
      {},
      "index.html",
      { included: "index.html", excluded: [] },
      { included: ["index.html"] },
      { included: [1], excluded: [] },
      { included: ["index.html"], excluded: [null] },
    ];
    for (const files of reviews)
      await assert.rejects(publishFromDialog(rig.core, GAME, files), Error, JSON.stringify(files));
    assert.deepEqual(rig.calls, []);
    // Nothing above approved anything: the next export is still asked about.
    const staged = rig.exportStage();
    void staged.catch(() => {});
    rig.core.resolveConsent((await rig.asked()).consentId, false);
    await assert.rejects(staged, /declined/);
  } finally {
    await rig.close();
  }
});

test("Publish needs the bundled Genex plugin, on", async () => {
  const rig = await dialogRig();
  try {
    const review = await publishReview(rig.core, GAME);
    const installed = rig.core.plugins.list();
    assert.ok(installed.some((p) => p.manifest.id === "genex" && p.source === PluginSourceKind.Bundled));
    const unusable: Array<[string, (p: (typeof installed)[number]) => (typeof installed)[number] | null]> = [
      ["missing", () => null],
      ["off", (p) => ({ ...p, enabled: false })],
      ["removed", (p) => ({ ...p, removed: true })],
      ["not bundled", (p) => ({ ...p, source: PluginSourceKind.Local })],
    ];
    for (const [label, change] of unusable) {
      rig.core.plugins.list = () =>
        installed.flatMap((p) => {
          if (p.manifest.id !== "genex") return [p];
          const changed = change({ ...p, enabled: true, removed: false });
          return changed ? [changed] : [];
        });
      await assert.rejects(publishReview(rig.core, GAME), /Genex/, `review, ${label}`);
      await assert.rejects(publishFromDialog(rig.core, GAME, review), /Genex/, label);
    }
    assert.deepEqual(rig.calls, []);
  } finally {
    await rig.close();
  }
});

test("Publish refuses an Unreal game, whose folder holds no web build, and still publishes a web game", async () => {
  const rig = await dialogRig();
  try {
    await addUnrealGame(rig);
    const review = await publishReview(rig.core, GAME);
    await assert.rejects(publishReview(rig.core, UNREAL_GAME), refusedAsUnreal);
    await assert.rejects(publishFromDialog(rig.core, UNREAL_GAME, review), refusedAsUnreal);
    assert.equal(rig.calls.length, 0, "Genex is asked nothing");
    assert.equal(rig.consents.length, 0, "and nobody is asked anything");
    await publishFromDialog(rig.core, GAME, review);
    assert.deepEqual(
      rig.calls.map((call) => [call.name, call.binding?.project]),
      [[GenexAction.PublishGallery, GAME]],
    );
    assert.equal(rig.staged.length, 1, "Genex staged the web game's public copy");
  } finally {
    await rig.close();
  }
});

test("Publish refuses a folder that holds another kind of project and no web game, by its own code", async () => {
  const rig = await dialogRig();
  try {
    const godot = await rig.core.games.scaffold("lantern-keep", { title: "Lantern Keep" });
    // A Godot project in place of the starter: no page, and no starter recorded in its studio.json.
    await rm(path.join(godot.dir, "index.html"));
    const meta = path.join(godot.dir, "studio.json");
    const { contractVersion: _starter, ...kept } = JSON.parse(await readFile(meta, "utf8")) as Record<string, unknown>;
    await writeFile(meta, JSON.stringify(kept));
    await writeFile(path.join(godot.dir, "project.godot"), "config_version=5\n");
    const refused = (error: unknown): boolean => {
      assert.ok(error instanceof PublishRefusedError, String(error));
      assert.equal(error.code, PublishRefusal.NotWebGame);
      assert.equal(error.message, "Lantern Keep isn't a web game, so Genex can't publish it yet.");
      return true;
    };
    await assert.rejects(publishReview(rig.core, "lantern-keep"), refused);
    assert.equal(rig.calls.length, 0, "Genex is asked nothing");
    assert.equal(rig.consents.length, 0, "and nobody is asked anything");
    assert.deepEqual((await publishReview(rig.core, GAME)).included, ["index.html"], "a web game still is");
  } finally {
    await rig.close();
  }
});

test("Publish refuses a folder of its own files of a kind no rule knows: it is served as no web game", async () => {
  const rig = await dialogRig();
  try {
    const own = await rig.core.games.scaffold("kite-script", { title: "Kite Script" });
    await rm(path.join(own.dir, "index.html"));
    await rm(path.join(own.dir, "src"), { recursive: true, force: true });
    const meta = path.join(own.dir, "studio.json");
    const { contractVersion: _starter, ...kept } = JSON.parse(await readFile(meta, "utf8")) as Record<string, unknown>;
    await writeFile(meta, JSON.stringify(kept));
    await writeFile(path.join(own.dir, "main.py"), "print('kite')\n");
    const refused = (error: unknown): boolean => {
      assert.ok(error instanceof PublishRefusedError, String(error));
      assert.equal(error.code, PublishRefusal.NotWebGame);
      return true;
    };
    await assert.rejects(publishReview(rig.core, "kite-script"), refused);
    assert.equal(rig.calls.length, 0, "Genex is asked nothing");
  } finally {
    await rig.close();
  }
});

test("an agent's genex__publish refuses an Unreal game before anyone is asked, and still reaches Genex for a web game", async () => {
  const rig = await dialogRig();
  try {
    await addUnrealGame(rig);
    const reached: Array<{ name: string; project: string }> = [];
    // Consent and the backend both sit behind the registry's tool call: reaching it is reaching Genex.
    rig.core.plugins.tool = async (name, _args, binding) => {
      reached.push({ name, project: binding.project });
      return {};
    };
    const publish = (project: string) =>
      rig.api()[HostMethod.PluginsInvoke]({
        project,
        name: GenexStudioTool.Publish,
        args: { operation: GenexPublishKind.Gallery },
      });
    await assert.rejects(publish(UNREAL_GAME), refusedAsUnreal);
    assert.equal(reached.length, 0, "Genex is asked nothing");
    assert.equal(rig.consents.length, 0, "and no card asks to publish it");
    await publish(GAME);
    assert.deepEqual(reached, [{ name: GenexStudioTool.Publish, project: GAME }]);
  } finally {
    await rig.close();
  }
});

test("a Genex panel's own publish refuses an Unreal game at export.stage before anyone is asked, and still stages a web game", async () => {
  const rig = await dialogRig();
  try {
    const unreal = await addUnrealGame(rig);
    // What Genex's backend calls once a panel's or toolbar's publish action reached it.
    const stage = (binding: PluginBinding) =>
      rig.core.pluginServices.call(GENEX_PLUGIN_ID, PluginService.ExportStage, {}, binding) as Promise<ExportResult>;
    await assert.rejects(stage({ project: UNREAL_GAME, directory: unreal.dir }), refusedAsUnreal);
    assert.equal(rig.consents.length, 0, "no card asks about an Unreal game's files");
    const staged = stage({ project: GAME, directory: rig.game.dir });
    rig.core.resolveConsent((await rig.asked()).consentId, true);
    assert.deepEqual((await staged).included, ["index.html"], "the web game's public copy is staged");
  } finally {
    await rig.close();
  }
});

test("an approved file list is spent once, by its own plugin and game, within its time", () => {
  let now = 0;
  const approvals = new ExportApprovals(() => now);
  const files: ExportReview = { included: ["index.html", "assets/a.png"], excluded: [".env"] };
  const reordered: ExportReview = { included: ["assets/a.png", "index.html"], excluded: [".env"] };

  approvals.approve("genex", GAME, files);
  assert.equal(approvals.take("other", GAME, files), false, "another plugin's export");
  assert.equal(approvals.take("genex", "other-game", files), false, "another game's export");
  assert.equal(approvals.take("genex", GAME, reordered), true, "the same files in any order");
  assert.equal(approvals.take("genex", GAME, files), false, "spent");

  const changes: Array<[string, ExportReview]> = [
    ["a file added", { included: [...files.included, "secret.txt"], excluded: [".env"] }],
    ["a file gone", { included: ["index.html"], excluded: [".env"] }],
    ["an exclusion gone", { included: files.included, excluded: [] }],
  ];
  for (const [label, exported] of changes) {
    approvals.approve("genex", GAME, files);
    assert.equal(approvals.take("genex", GAME, exported), false, label);
    assert.equal(approvals.take("genex", GAME, files), false, `${label}: a mismatch spends the approval`);
  }

  approvals.approve("genex", GAME, files);
  approvals.withdraw("genex", GAME);
  assert.equal(approvals.take("genex", GAME, files), false, "withdrawn when its publish ended");

  approvals.approve("genex", GAME, files);
  now += EXPORT_APPROVAL_TTL_MS + 1;
  assert.equal(approvals.take("genex", GAME, files), false, "expired");
});
