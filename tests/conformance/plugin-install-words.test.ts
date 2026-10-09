/**
 * The plugin trust dialog's words, built from the package alone: where the code came from, what it
 * may do, what it starts, which skills it gives agents and what the scan saw. An update marks what
 * is new or changed since the installed version; a first install marks nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type PluginManifest, type PluginScan, PluginSourceKind } from "../../src/shared/plugins.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { actionApprovalDetail, installDetail } from "../../src/main/plugin-install-words.ts";

const bundled = async (id: string): Promise<PluginManifest> =>
  validateManifest(JSON.parse(await readFile(path.resolve("src/plugins", id, "plugin.json"), "utf8")));
const genex = await bundled("genex");
const example = await bundled("example");

const SCANNED: PluginScan = {
  verdict: "caution",
  findings: [{ rule: "child-process", severity: "caution", file: "backend.mjs", line: 12, excerpt: "spawn(" }],
  files: 3,
  bytes: 2048,
  scannedAt: "2026-09-26T00:00:00.000Z",
};

test("characterization: a first install of bundled Genex names every capability, server and skill", () => {
  assert.equal(
    installDetail({ manifest: genex }),
    "Genex Tools 1.6.0 from bundled runs as trusted native code in a crash-isolated child process — not an OS sandbox. Publisher: Genex. Capabilities: credentials, observe, jobs, network, external-auth, project.write, export (new: credentials, observe, jobs, network, external-auth, project.write, export). Starts 2 MCP servers on your Mac, as trusted native code with the environment it declares: creator (creator-mcp.mjs, GENEX_ENV_FILE); blender (Studio's own Genex CLI, GENEX_API_URL, GENEX_BLENDER_URL, GENEX_ENV_FILE). Studio runs 3 tools for it: cli (runs Studio's Genex CLI); cli-paid (runs Studio's Genex CLI, with your consent each time); package (installs Genex packages in the game, with your consent each time). Gives agents 13 skills: creator-mcp, asset-preference, publishing, cover, genex (read on demand), genex-threejs-multiplayer (read on demand), genex-threejs-embed-auth (read on demand), genex-llm-in-games (read on demand), genex-tool-llm (read on demand), genex-monetization (read on demand), genex-tool-publish (read on demand), genex-cover (read on demand), genex-updates (read on demand). Scan: bundled — not scanned.",
  );
});

test("characterization: an update marks new capabilities and servers", () => {
  const before = { ...genex, capabilities: genex.capabilities.slice(0, 3), mcpServers: genex.mcpServers?.slice(0, 1) };
  assert.equal(
    installDetail({ manifest: genex, before }),
    "Genex Tools 1.6.0 from bundled runs as trusted native code in a crash-isolated child process — not an OS sandbox. Publisher: Genex. Capabilities: credentials, observe, jobs, network, external-auth, project.write, export (new: network, external-auth, project.write, export). Starts 2 MCP servers on your Mac, as trusted native code with the environment it declares: creator (creator-mcp.mjs, GENEX_ENV_FILE); blender (new) (Studio's own Genex CLI, GENEX_API_URL, GENEX_BLENDER_URL, GENEX_ENV_FILE). Studio runs 3 tools for it: cli (runs Studio's Genex CLI); cli-paid (runs Studio's Genex CLI, with your consent each time); package (installs Genex packages in the game, with your consent each time). Gives agents 13 skills: creator-mcp, asset-preference, publishing, cover, genex (read on demand), genex-threejs-multiplayer (read on demand), genex-threejs-embed-auth (read on demand), genex-llm-in-games (read on demand), genex-tool-llm (read on demand), genex-monetization (read on demand), genex-tool-publish (read on demand), genex-cover (read on demand), genex-updates (read on demand). Scan: bundled — not scanned.",
  );
});

test("characterization: a scanned local replacement names what it erases, the findings and the note", () => {
  const replaces = { name: "Old Example", publisher: "Someone", origin: { kind: PluginSourceKind.Local } };
  assert.equal(
    installDetail({
      manifest: example,
      origin: { kind: PluginSourceKind.Local },
      scan: SCANNED,
      replaces,
      note: "The index moved.",
    }),
    "It replaces Old Example by Someone (local folder), which has the same id: that plugin's saved account, settings and data will be erased. Plugin SDK example 1.0.0 from local folder runs as trusted native code in a crash-isolated child process — not an OS sandbox. Publisher: Studio development. Capabilities: settings (new: settings). Gives agents 1 skill: greeting. Scan: caution — 1 finding: child-process backend.mjs:12. The index moved.",
  );
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

test("a first install lists every skill it gives agents, unmarked, and says which are read on demand", () => {
  const detail = installDetail({ manifest: withSkills });
  assert.match(detail, /Gives agents 2 skills: greeting, card \(read on demand\)\. Scan:/);
  assert.doesNotMatch(detail, /\(new\)|\(changed/);
});

test("an update marks a skill it adds as new and one whose manifest entry changed as changed", () => {
  const before: PluginManifest = { ...example, skills: [{ name: "greeting", text: "Say hi." }] };
  assert.match(
    installDetail({ manifest: withSkills, before }),
    /Gives agents 2 skills: greeting \(changed\), card \(new, read on demand\)\./,
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
  assert.match(unchanged, /Gives agents 2 skills: greeting, card \(read on demand\)\./);
  const changed = installDetail({ manifest: withSkills, before: withSkills, scan: scan("b"), previousScan: scan("a") });
  assert.match(changed, /Gives agents 2 skills: greeting, card \(changed, read on demand\)\./);
});

test("an update names the skills it removes, even when it leaves none", () => {
  const before: PluginManifest = {
    ...withSkills,
    skills: [...withSkills.skills, { name: "asset-workflow", text: "Old." }, { name: "farewell", text: "Bye." }],
  };
  assert.match(
    installDetail({ manifest: withSkills, before }),
    /Gives agents 2 skills: greeting, card \(read on demand\); removed: asset-workflow, farewell\. Scan:/,
  );
  assert.match(
    installDetail({ manifest: { ...withSkills, skills: [] }, before }),
    /Gives agents no skills; removed: greeting, card, asset-workflow, farewell\. Scan:/,
  );
  assert.doesNotMatch(installDetail({ manifest: withSkills, before: withSkills }), /removed:/);
});

test("a bundled update without scans marks changes from the manifest alone", () => {
  assert.match(
    installDetail({
      manifest: withSkills,
      before: withSkills,
      previousScan: { ...SCANNED, skillDigests: { card: "a" } },
    }),
    /Gives agents 2 skills: greeting, card \(read on demand\)\./,
  );
});

test("tools Studio runs itself are named with what they do and whether each asks first", () => {
  const expected =
    " Studio runs 3 tools for it: cli (runs Studio's Genex CLI); cli-paid (runs Studio's Genex CLI, with your consent each time); package (installs Genex packages in the game, with your consent each time).";
  assert.ok(installDetail({ manifest: genex }).includes(expected));
  const update = installDetail({
    manifest: genex,
    before: { ...genex, tools: genex.tools.filter((t) => t.name !== "package") },
  });
  assert.ok(update.includes("package (new) (installs Genex packages in the game, with your consent each time)."));
  const withoutHostTools = { ...genex, tools: genex.tools.filter((t) => t.host === undefined) };
  assert.doesNotMatch(installDetail({ manifest: withoutHostTools }), /Studio runs/);
});

test("an action's approval shows the arguments it was given, and nothing when there are none", () => {
  for (const none of [undefined, null, {}]) assert.equal(actionApprovalDetail(none), undefined, JSON.stringify(none));
  assert.equal(actionApprovalDetail({ jobId: "job-1" }), '{\n  "jobId": "job-1"\n}');
  assert.equal(actionApprovalDetail(["a"]), '[\n  "a"\n]');
});
