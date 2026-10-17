/**
 * An engine plugin's `judges` (API 3): blind judges that play the engine's games in its editor, each
 * with a brief from the package, a number of players the engine can open and a probe the host runs
 * once the play is open. Genex keeps the section in canonical form and refuses one it cannot keep,
 * and refuses a package whose brief file is missing or too long.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { judgesFor, MAX_JUDGE_BRIEF_CHARS } from "../../src/shared/plugins.ts";
import { inspectPackage, validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { TOY_PLUGIN } from "../helpers/project-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";

const RAW = JSON.parse(readFileSync(path.join(TOY_PLUGIN, "plugin.json"), "utf8")) as Record<string, unknown>;
const NO_PARAMETERS = { type: "object", properties: {} };

/** The toy plugin's tools, with two more harness tools a probe could name: one that asks, one that holds no lock. */
const TOOLS = [
  ...(RAW.tools as object[]).filter((tool) => (tool as { name: string }).name !== "toy-probe"),
  {
    name: "toy-probe",
    audience: "harness",
    needs: ["toy-editor"],
    description: "Measure the toy play.",
    parameters: NO_PARAMETERS,
  },
  {
    name: "asking-probe",
    audience: "harness",
    needs: ["toy-editor"],
    confirmation: "Measure the play?",
    description: "Measure the toy play after asking.",
    parameters: NO_PARAMETERS,
  },
];

/** The toy manifest with `judges` as given (and any header fields). */
const toyWith = (judges: unknown, header: Record<string, unknown> = {}) => ({
  ...RAW,
  tools: TOOLS,
  judges,
  ...header,
});

/** A judge under test: the toy's crowd, with fields replaced. */
const judge = (fields: Record<string, unknown> = {}) => ({
  id: "crowd",
  label: "Crowd",
  facts: ["toy-project"],
  brief: "judges/crowd.md",
  players: 3,
  probe: "toy-probe",
  ...fields,
});

/** Every `judges` section Genex refuses, by the words that name its fault. */
const refused: Array<[name: string, judges: unknown, header: Record<string, unknown>, words: RegExp]> = [
  ["a section that is not a list", judge(), {}, /judges/],
  ["9 judges", Array.from({ length: 9 }, (_, i) => judge({ id: `judge-${i}` })), {}, /judges/],
  ["the same id twice", [judge(), judge({ label: "Crowd again" })], {}, /"crowd" is declared twice/],
  ["an id that is no id", [judge({ id: "Crowd Judge" })], {}, /judges entry/],
  ["a one-letter id", [judge({ id: "c" })], {}, /judges entry/],
  ["no label", [judge({ label: undefined })], {}, /judges entry/],
  ["a 41-character label", [judge({ label: "C".repeat(41) })], {}, /judges entry/],
  ["a label on two lines", [judge({ label: "Crowd\nnow" })], {}, /judges entry/],
  ["facts that are no fact ids", [judge({ facts: ["Toy Project"] })], {}, /judges entry/],
  ["an empty facts list", [judge({ facts: [] })], {}, /judges entry/],
  ["no brief", [judge({ brief: undefined })], {}, /brief/],
  ["a brief that is not Markdown", [judge({ brief: "judges/crowd.txt" })], {}, /brief/],
  ["a brief in a dot folder", [judge({ brief: ".judges/crowd.md" })], {}, /brief/],
  ["a brief outside the package", [judge({ brief: "../crowd.md" })], {}, /brief|relative/],
  ["a brief at an absolute path", [judge({ brief: "/tmp/crowd.md" })], {}, /brief|relative/],
  ["players 9", [judge({ players: 9 })], {}, /players/],
  ["players 0", [judge({ players: 0 })], {}, /players/],
  ["players that are not whole", [judge({ players: 1.5 })], {}, /players/],
  ["more players than the engine opens", [judge({ players: 4 })], {}, /players/],
  ["a probe the manifest does not declare", [judge({ probe: "measure" })], {}, /probe/],
  ["a probe an agent calls", [judge({ probe: "build" })], {}, /probe/],
  ["a probe that asks the person", [judge({ probe: "asking-probe" })], {}, /probe/],
  ["a probe that does not hold the play's lock", [judge({ probe: "editor-state" })], {}, /probe/],
  ["a plugin that declares no engine", [judge({ players: undefined })], { engine: undefined }, /engine/],
];

describe("an engine plugin's judges", () => {
  for (const [name, judges, header, words] of refused) {
    it(`refuses ${name}`, () => {
      assert.throws(() => validateManifest(toyWith(judges, header)), words);
    });
  }

  it("refuses judges on API 2", () => {
    const v2 = {
      apiVersion: 2,
      id: "kiln",
      version: "1.0.0",
      name: "Kiln",
      publisher: "Genex tests",
      description: "A manifest whose judges are under test.",
      backend: "backend.mjs",
      capabilities: [],
      tools: [],
      skills: [],
      panels: [],
      settings: [],
      actions: [],
      judges: [judge({ players: undefined, probe: undefined })],
    };
    assert.throws(() => validateManifest(v2), /judges requires apiVersion 3/);
  });

  it("keeps a judge in canonical form: known fields only, in a fixed order", () => {
    const kept = validateManifest(
      toyWith([
        {
          probe: "toy-probe",
          players: 3,
          brief: "judges/crowd.md",
          facts: ["toy-project"],
          label: "Crowd",
          id: "crowd",
        },
        { label: "Plain", id: "plain", brief: "judges/plain.md", later: "a field a later Genex reads" },
      ]),
    );
    assert.deepEqual(
      JSON.stringify(kept.judges),
      JSON.stringify([judge(), { id: "plain", label: "Plain", brief: "judges/plain.md" }]),
    );
  });

  it("allows one player on an engine that declares no play of several", () => {
    const engine = { ...(RAW.engine as object), play: undefined };
    const kept = validateManifest(toyWith([judge({ players: 1, probe: undefined })], { engine }));
    assert.equal(kept.judges?.[0]?.players, 1);
    assert.throws(() => validateManifest(toyWith([judge({ players: 2, probe: undefined })], { engine })), /players/);
  });

  it("reaches a game by its facts: a judge naming none reaches every game the plugin plays", () => {
    const judges = [judge(), { id: "plain", label: "Plain", brief: "judges/plain.md" }];
    const toy = { facts: [{ id: "toy-project", path: ".", source: "link" }] } as never;
    const other = { facts: [{ id: "other-project", path: ".", source: "rule" }] } as never;
    assert.deepEqual(
      judgesFor(judges, toy).map((j) => j.id),
      ["crowd", "plain"],
    );
    assert.deepEqual(
      judgesFor(judges, other).map((j) => j.id),
      ["plain"],
    );
  });
});

/** A copy of the toy package with its judges as given and its brief files written as given. */
async function toyPackage(judges: unknown, briefs: Record<string, string>): Promise<string> {
  const dir = path.join(await tmpDir("studio-judge-package-"), "toy-engine");
  await cp(TOY_PLUGIN, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(dir, "plugin.json"), "utf8")) as Record<string, unknown>;
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify({ ...manifest, tools: TOOLS, judges }, null, 2));
  for (const [file, text] of Object.entries(briefs)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text);
  }
  return dir;
}

describe("a judge's brief file, read at install", () => {
  it("is refused when missing", async () => {
    const dir = await toyPackage([judge({ brief: "judges/missing.md" })], {});
    await assert.rejects(inspectPackage(dir), /brief judges\/missing\.md is missing/);
  });

  it(`is refused past ${MAX_JUDGE_BRIEF_CHARS} characters, and kept at exactly that many`, async () => {
    const long = await toyPackage([judge({ brief: "judges/long.md" })], {
      "judges/long.md": "a".repeat(MAX_JUDGE_BRIEF_CHARS + 1),
    });
    await assert.rejects(inspectPackage(long), /brief judges\/long\.md is too long/);
    const full = await toyPackage([judge({ brief: "judges/full.md" })], {
      "judges/full.md": "é".repeat(MAX_JUDGE_BRIEF_CHARS),
    });
    assert.equal((await inspectPackage(full)).judges?.[0]?.brief, "judges/full.md");
  });

  it("is refused when it is a folder", async () => {
    const dir = await toyPackage([judge({ brief: "judges/folder.md" })], { "judges/folder.md/inside.md": "x" });
    await assert.rejects(inspectPackage(dir), /brief judges\/folder\.md is not a plain file/);
  });

  it("the toy engine plugin's own judges load, each with its brief", async () => {
    const manifest = await inspectPackage(TOY_PLUGIN);
    assert.deepEqual(
      manifest.judges?.map(({ id, players, probe }) => ({ id, players, probe })),
      [
        { id: "crowd", players: 3, probe: "toy-probe" },
        { id: "plain", players: undefined, probe: undefined },
      ],
    );
  });
});
