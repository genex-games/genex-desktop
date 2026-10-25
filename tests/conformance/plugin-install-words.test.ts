/**
 * The plugin trust dialog's words, built from the package alone: its question and button, then one
 * block each for where the code came from, what it asks to do, what it starts, which skills it gives
 * agents and what the scan saw. An update marks what is new or changed since the installed version;
 * a first install marks nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type PluginManifest, type PluginScan, type PluginSource, PluginSourceKind } from "../../src/shared/plugins.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import {
  actionApprovalDetail,
  actionApprovalDialog,
  installDetail,
  installPrompt,
} from "../../src/main/plugin-install-words.ts";

const bundled = async (id: string): Promise<PluginManifest> =>
  validateManifest(JSON.parse(await readFile(path.resolve("src/plugins", id, "plugin.json"), "utf8")));
const genex = await bundled("genex");
const example = await bundled("example");

const INDEX: PluginSource = { kind: PluginSourceKind.Index, repo: "genex-games/genex-plugins", sha: "a".repeat(40) };
const LOCAL: PluginSource = { kind: PluginSourceKind.Local, directory: "/Users/me/plugins/example" };

const SCANNED: PluginScan = {
  verdict: "caution",
  findings: [{ rule: "child-process", severity: "caution", file: "backend.mjs", line: 12, excerpt: "spawn(" }],
  files: 3,
  bytes: 2048,
  scannedAt: "2026-09-26T00:00:00.000Z",
};

/** The dialog's blocks, split where it leaves a blank line. */
const blocks = (detail: string): string[] => detail.split("\n\n");

test("characterization: a first install from the catalog gives one block each, in plain words", () => {
  assert.deepEqual(blocks(installDetail({ manifest: genex, origin: INDEX, scan: SCANNED })), [
    "From GitHub genex-games/genex-plugins@aaaaaaaaaaaa (cataloged, not audited)\nPublisher: Genex",
    "Its code runs on your computer like an app you install. It isn't sandboxed.",
    [
      "It asks to:",
      "• save a sign-in for its own account",
      "• load and capture your games as they run",
      "• run long jobs and report their progress",
      "• reach the internet",
      "• open sign-in pages in your browser",
      "• change files in your games",
      "• export your games",
    ].join("\n"),
    [
      "Starts 2 programs for agents:",
      "• creator — creator-mcp.mjs, given GENEX_ENV_FILE",
      "• blender — the Genex CLI, given GENEX_API_URL, GENEX_BLENDER_URL, GENEX_ENV_FILE",
    ].join("\n"),
    [
      "Genex runs 3 tools for it:",
      "• cli — runs the Genex CLI",
      "• cli-paid — runs the Genex CLI, asks you each time",
      "• package — installs Genex packages in the game",
    ].join("\n"),
    "Adds 21 skills for agents: creator-mcp, asset-preference, publishing, publishing-apps, cover, genex, genex-threejs-multiplayer, genex-threejs-embed-auth, genex-llm-in-games, genex-tool-llm, genex-monetization, genex-items, genex-tool-publish, genex-cover, genex-tool-model, genex-tool-character, genex-tool-texture, genex-tool-audio, genex-tool-image, genex-updates, plugin-author.",
    "Scan: caution, 1 finding: child-process in backend.mjs:12.",
  ]);
});

test("an update marks only what is new since the installed version", () => {
  const before = { ...genex, capabilities: genex.capabilities.slice(0, 3), mcpServers: genex.mcpServers?.slice(0, 1) };
  const detail = installDetail({ manifest: genex, origin: INDEX, before });
  assert.match(detail, /• save a sign-in for its own account\n/);
  assert.match(detail, /• reach the internet \(new\)\n/);
  assert.match(detail, /• export your games \(new\)\n/);
  assert.match(detail, /• creator — creator-mcp\.mjs, given GENEX_ENV_FILE\n• blender \(new\) — the Genex CLI/);
});

test("the question and its button say install, update or replace", () => {
  const install = installPrompt({ manifest: example, origin: LOCAL, scan: SCANNED });
  assert.equal(install.message, "Install Plugin SDK example 1.0.0?");
  assert.equal(install.confirm, "Install");
  const update = installPrompt({ manifest: example, origin: LOCAL, before: { ...example, version: "0.9.0" } });
  assert.equal(update.message, "Update Plugin SDK example to 1.0.0?");
  assert.equal(update.confirm, "Update");
  const reinstall = installPrompt({ manifest: example, origin: LOCAL, before: example });
  assert.equal(reinstall.message, "Install Plugin SDK example 1.0.0?", "the same version again is an install");
  const replaces = { name: "Old Example", publisher: "Someone", origin: LOCAL };
  const replace = installPrompt({ manifest: example, origin: INDEX, replaces });
  assert.equal(replace.message, "Replace Old Example with Plugin SDK example 1.0.0?");
  assert.equal(replace.confirm, "Replace and erase data");
  assert.equal(replace.detail, installDetail({ manifest: example, origin: INDEX, replaces }));
});

test("characterization: a scanned replacement from a local folder leads with what it erases and ends with the note", () => {
  const replaces = { name: "Old Example", publisher: "Someone", origin: { kind: PluginSourceKind.Local } };
  assert.deepEqual(
    blocks(installDetail({ manifest: example, origin: LOCAL, scan: SCANNED, replaces, note: "The index moved." })),
    [
      "This replaces Old Example by Someone (from a local folder). Its saved account, settings and data will be erased.",
      "From the folder /Users/me/plugins/example\nPublisher: Studio development",
      "Its code runs on your computer like an app you install. It isn't sandboxed.",
      "It runs with your access: Genex doesn't sandbox its code. It starts off: turn it on in Plugins; each of its tools asks you before it runs.",
      "It asks to:\n• keep its own settings",
      "Adds 1 skill for agents: greeting.",
      "Scan: caution, 1 finding: child-process in backend.mjs:12.",
      "The index moved.",
    ],
  );
});

test("a package that asks for nothing and starts nothing leaves those blocks out; one never scanned says so", () => {
  const bare: PluginManifest = { ...example, capabilities: [], skills: [] };
  assert.deepEqual(blocks(installDetail({ manifest: bare })), [
    "From Genex (built in)\nPublisher: Studio development",
    "Its code runs on your computer like an app you install. It isn't sandboxed.",
    "Not scanned.",
  ]);
  const clean: PluginScan = { ...SCANNED, verdict: "safe", findings: [] };
  assert.match(installDetail({ manifest: bare, origin: LOCAL, scan: clean }), /\n\nScan: safe, no findings\.$/);
});

/** The example on API 3 with one inline and one file skill, as a package that declares them. */
const withSkills: PluginManifest = {
  ...example,
  apiVersion: 3,
  skills: [
    { name: "greeting", text: "Say hello." },
    { name: "card", summary: "A card read on demand.", file: "skills/card.md" },
  ],
};

test("a first install lists every skill it gives agents, unmarked", () => {
  const detail = installDetail({ manifest: withSkills, origin: LOCAL });
  assert.match(detail, /\n\nAdds 2 skills for agents: greeting, card\.\n\n/);
  assert.doesNotMatch(detail, /\(new\)|\(changed/);
});

test("an update marks a skill it adds as new and one whose manifest entry changed as changed", () => {
  const before: PluginManifest = { ...example, skills: [{ name: "greeting", text: "Say hi." }] };
  assert.match(
    installDetail({ manifest: withSkills, origin: LOCAL, before }),
    /Adds 2 skills for agents: greeting \(changed\), card \(new\)\./,
  );
});

test("a scanned update marks a file skill whose bytes changed, and an unchanged one plainly", () => {
  const scan = (card: string): PluginScan => ({ ...SCANNED, skillDigests: { greeting: "g", card } });
  const unchanged = installDetail({
    manifest: withSkills,
    before: withSkills,
    scan: scan("b"),
    previousScan: scan("b"),
  });
  assert.match(unchanged, /Adds 2 skills for agents: greeting, card\./);
  const changed = installDetail({ manifest: withSkills, before: withSkills, scan: scan("b"), previousScan: scan("a") });
  assert.match(changed, /Adds 2 skills for agents: greeting, card \(changed\)\./);
});

test("an update names the skills it removes, even when it leaves none", () => {
  const before: PluginManifest = {
    ...withSkills,
    skills: [...withSkills.skills, { name: "asset-workflow", text: "Old." }, { name: "farewell", text: "Bye." }],
  };
  assert.match(
    installDetail({ manifest: withSkills, before }),
    /Adds 2 skills for agents: greeting, card\. Removes: asset-workflow, farewell\.\n\n/,
  );
  assert.match(
    installDetail({ manifest: { ...withSkills, skills: [] }, before }),
    /\n\nAdds no skills for agents\. Removes: greeting, card, asset-workflow, farewell\.\n\n/,
  );
  assert.doesNotMatch(installDetail({ manifest: withSkills, before: withSkills }), /Removes:/);
});

test("an update without scans marks changes from the manifest alone", () => {
  assert.match(
    installDetail({
      manifest: withSkills,
      before: withSkills,
      previousScan: { ...SCANNED, skillDigests: { card: "a" } },
    }),
    /Adds 2 skills for agents: greeting, card\./,
  );
});

test("tools Genex runs itself are named with what they do and whether each asks first", () => {
  const update = installDetail({
    manifest: genex,
    before: { ...genex, tools: genex.tools.filter((t) => t.name !== "package") },
  });
  assert.match(update, /\n• cli — runs the Genex CLI\n/);
  assert.match(update, /\n• package \(new\) — installs Genex packages in the game\n/);
  const withoutHostTools = { ...genex, tools: genex.tools.filter((t) => t.host === undefined) };
  assert.doesNotMatch(installDetail({ manifest: withoutHostTools }), /Genex runs/);
});

test("an action's approval shows the arguments it was given, and nothing when there are none", () => {
  for (const none of [undefined, null, {}]) assert.equal(actionApprovalDetail(none), undefined, JSON.stringify(none));
  assert.equal(actionApprovalDetail({ jobId: "job-1" }), '{\n  "jobId": "job-1"\n}');
  assert.equal(actionApprovalDetail(["a"]), '[\n  "a"\n]');
});

test("a reviewed action asks the plugin's own question, in its own words, under the action's own name", () => {
  const action = { label: "Set up", confirmation: "Set up this Unreal project for Genex?" };
  const args = { project: "/Users/me/Lyra/Lyra.uproject" };
  const reviewed = actionApprovalDialog({
    plugin: "Unreal",
    action,
    review: {
      message: "Set up Lyra for Genex?",
      detail: "• Turns on Epic's MCP plugins\n• Adds the Genex editor helper",
    },
    args,
  });
  assert.deepEqual(reviewed, {
    title: "Unreal: Set up",
    message: "Set up Lyra for Genex?",
    detail: "• Turns on Epic's MCP plugins\n• Adds the Genex editor helper",
    buttons: ["Cancel", "Set up"],
  });
  const questionOnly = actionApprovalDialog({ plugin: "Unreal", action, review: { message: "Set up Lyra?" }, args });
  assert.equal(questionOnly.detail, undefined, "a reviewed action never falls back to its arguments as JSON");
  assert.deepEqual(questionOnly.buttons, ["Cancel", "Set up"]);
  for (const review of [{}, { detail: "• words without a question" }, { message: "" }]) {
    const unreviewed = actionApprovalDialog({ plugin: "Unreal", action, review, args });
    assert.equal(unreviewed.message, action.confirmation, JSON.stringify(review));
    assert.equal(unreviewed.detail, actionApprovalDetail(args), JSON.stringify(review));
    assert.deepEqual(unreviewed.buttons, ["Cancel", "Approve"], JSON.stringify(review));
  }
});

test("names the folders outside the games a plugin's programs will write in, each with why, marking new ones on an update", () => {
  const log = { path: "~/Library/Application Support/Toy/Logs", why: "The toy engine writes its log here" };
  const cache = { path: "/private/tmp/toy-cache", why: "Shaders it compiles" };
  const manifest: PluginManifest = { ...example, apiVersion: 3, folders: [log, cache] };
  const first = installDetail({ manifest });
  for (const part of [log.path, log.why, cache.path, cache.why]) assert.ok(first.includes(part), part);
  assert.match(first, /write in 2 folders outside your games/);
  assert.doesNotMatch(first, /\(new\)/, "a first install marks nothing");

  const update = installDetail({ manifest, before: { ...manifest, folders: [log] } });
  assert.ok(update.includes(`${cache.path} (new)`), update);
  assert.ok(!update.includes(`${log.path} (new)`), update);

  assert.doesNotMatch(installDetail({ manifest: example }), /folders outside/, "nothing for a plugin without folders");
});

test("loading again a local plugin that is on says it stays on and its new code runs at once", () => {
  const origin = { kind: PluginSourceKind.Local, directory: "/Users/someone/genex-plugins/example" } as const;
  const update = installDetail({ manifest: example, origin, before: example, staysOn: true });
  assert.match(update, /It runs with your access: Genex doesn't sandbox its code\./);
  assert.match(
    update,
    /It is on and stays on: its new code runs as soon as it loads, and each of its tools asks you again before it runs\./,
  );
  assert.doesNotMatch(update, /starts off/);
  const first = installDetail({ manifest: example, origin });
  assert.match(first, /It starts off: turn it on in Plugins; each of its tools asks you before it runs\./);
  const whileOff = installDetail({ manifest: example, origin, before: example, staysOn: false });
  assert.match(whileOff, /It starts off/, "an update of a plugin that is off stays off");
});
