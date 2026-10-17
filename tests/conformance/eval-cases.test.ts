/**
 * The case file grammar (§6.1): a synthetic case file parses into the typed cases with stable
 * per-case versions, malformed blocks are refused by field, the committed `evals/cases.md` parses
 * into the planned set, holdouts load only from the private file, and a `Start from:` folder
 * resolves only inside the committed fixture games (a hostile table, with no side effect).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  CaseField,
  CaseFileError,
  caseById,
  PRIVATE_CASES_FILE,
  parseCases,
  readCases,
  readHoldoutCases,
  resolveStartFrom,
  START_FROM_ROOT,
} from "../../scripts/evals/cases.ts";
import { DEFAULT_CASE_DEADLINE_MIN } from "../../scripts/evals/case-types.ts";
import { SHORT_DIGEST_PATTERN } from "../../scripts/evals/ledger/types.ts";
import { CaseExposure, CaseMode, CaseVisibility } from "../../scripts/evals/vocabulary.ts";
import { tmpDir } from "../helpers/tmp.ts";

const root = path.resolve(import.meta.dirname, "../..");

const LANTERN = [
  "## C1 · `lantern-walk` — a synthetic case ✅ PINNED",
  "",
  "**Exposure:** none",
  "",
  "> Carry a paper lantern along a winding river path at dusk,",
  "> and light every stone marker before the moon rises.",
  "",
  "**Acceptance:**",
  "",
  "```",
  '[ ] the lantern is carried and visible            <- "Carry a paper lantern"',
  '[ ] KEY: markers can be lit one by one            ← "light every stone marker"',
  "[ ] full assets only: the river glows at dusk",
  "[ ] the moon rising ends the round, and it says",
  "    so on screen",
  "```",
  "",
  "**Control:** the lantern is a tuba that plays the national anthem",
  "",
  "Prose after the checklist is part of the block but not of the brief.",
  "",
  "---",
];

const KITE = [
  "## C2 · `kite-duel` — follow-up and deadline *(draft: owner pins before first baseline)*",
  "",
  "**Mode:** `follow-up`",
  "**Exposure:** dev-tuned (the seed was iterated on kite runs)",
  "**Deadline:** 30 min",
  "",
  "> Two kites duel over a meadow.",
  "",
  "**Follow-ups:**",
  "",
  "1. Now let the wind change direction every minute.",
  "2. Add a score for each cut string,",
  "   shown in the corner.",
  "",
  "**Acceptance:**",
  "",
  "```",
  '[ ] two kites fly                                 <- "Two kites"',
  "```",
  "",
  "**Control:** the meadow is on the surface of Jupiter",
];

const FOLLOW_UP_LINE = /^(?:\*\*Follow-ups:\*\*|1\. |2\. | {3}shown)/;

const CANARY = ["## C8 · `pebble` — machine-only verdict", "", "**Exposure:** none", "", "> A pebble rolls."];

const EDIT = [
  "## C9 · `patch-work` — edit a committed game",
  "",
  "**Mode:** `edit-existing`",
  "**Exposure:** none",
  "**Start from:** `tests/fixtures/evals/games/edit-existing`",
  "",
  "> Add a jump.",
];

const file = (...blocks: string[][]) =>
  ["# Synthetic cases", "", "## Rules", "", "Not a case heading.", "", ...blocks.flat(), "", "# Rotation", ""].join(
    "\n",
  );

/** The file with one line of one block replaced. */
function withLine(block: string[], match: string, replacement: string | null): string[] {
  const index = block.findIndex((line) => line.startsWith(match));
  assert.ok(index >= 0, `fixture has no line starting ${match}`);
  const copy = [...block];
  if (replacement === null) copy.splice(index, 1);
  else copy[index] = replacement;
  return copy;
}

function refused(markdown: string, field: CaseField, visibility?: CaseVisibility): void {
  assert.throws(
    () => parseCases(markdown, visibility),
    (error: unknown) => error instanceof CaseFileError && error.field === field,
    `expected a ${field} refusal`,
  );
}

describe("case grammar", () => {
  const cases = parseCases(file(LANTERN, KITE, CANARY, EDIT));
  const [lantern, kite, canary, edit] = cases;

  it("reads the heading, exposure, mode, deadline and the first blockquote as the brief", () => {
    assert.deepEqual(
      cases.map((c) => [c.number, c.id, c.label, c.mode, c.exposure, c.visibility, c.deadlineMin]),
      [
        [1, "lantern-walk", "a synthetic case", CaseMode.Build, CaseExposure.None, CaseVisibility.Public, 90],
        [2, "kite-duel", "follow-up and deadline", CaseMode.FollowUp, CaseExposure.DevTuned, CaseVisibility.Public, 30],
        [8, "pebble", "machine-only verdict", CaseMode.Build, CaseExposure.None, CaseVisibility.Public, 90],
        [9, "patch-work", "edit a committed game", CaseMode.EditExisting, CaseExposure.None, CaseVisibility.Public, 90],
      ],
    );
    assert.equal(DEFAULT_CASE_DEADLINE_MIN, 90);
    assert.equal(
      lantern.brief,
      "Carry a paper lantern along a winding river path at dusk, and light every stone marker before the moon rises.",
    );
    assert.equal(lantern.exposureReason, null);
    assert.equal(kite.exposureReason, "the seed was iterated on kite runs");
  });

  it("parses acceptance lines with both arrows, KEY and assets prefixes, continuations and the control", () => {
    assert.deepEqual(lantern.acceptance, [
      {
        id: "lantern-walk-01",
        text: "the lantern is carried and visible",
        tracesTo: "Carry a paper lantern",
        key: false,
        assetsOnly: false,
        control: false,
      },
      {
        id: "lantern-walk-02",
        text: "markers can be lit one by one",
        tracesTo: "light every stone marker",
        key: true,
        assetsOnly: false,
        control: false,
      },
      {
        id: "lantern-walk-03",
        text: "the river glows at dusk",
        tracesTo: null,
        key: false,
        assetsOnly: true,
        control: false,
      },
      {
        id: "lantern-walk-04",
        text: "the moon rising ends the round, and it says so on screen",
        tracesTo: null,
        key: false,
        assetsOnly: false,
        control: false,
      },
      {
        id: "lantern-walk-05",
        text: "the lantern is a tuba that plays the national anthem",
        tracesTo: null,
        key: false,
        assetsOnly: false,
        control: true,
      },
    ]);
  });

  it("reads follow-ups in order, joining wrapped lines", () => {
    assert.deepEqual(kite.followUps, [
      { index: 1, text: "Now let the wind change direction every minute." },
      { index: 2, text: "Add a score for each cut string, shown in the corner." },
    ]);
    assert.deepEqual(lantern.followUps, []);
  });

  it("gives a machine-only case no checklist and an edit case its start folder", () => {
    assert.deepEqual(canary.acceptance, []);
    assert.equal(canary.startFrom, null);
    assert.equal(edit.startFrom, "tests/fixtures/evals/games/edit-existing");
  });
});

describe("case versions and visibility", () => {
  const cases = parseCases(file(LANTERN, KITE, CANARY, EDIT));
  const [lantern, kite, canary, edit] = cases;

  it("versions each case by its own block, so editing one case never moves another", () => {
    for (const c of cases) {
      assert.match(c.version, SHORT_DIGEST_PATTERN);
      assert.match(c.checklistVersion, SHORT_DIGEST_PATTERN);
    }
    assert.equal(new Set(cases.map((c) => c.version)).size, cases.length);
    const reworded = parseCases(
      file(withLine(LANTERN, "> and light", "> and light every marker."), KITE, CANARY, EDIT),
    );
    assert.notEqual(reworded[0].version, lantern.version);
    assert.equal(reworded[0].checklistVersion, lantern.checklistVersion, "the checklist did not change");
    assert.deepEqual(
      reworded.slice(1).map((c) => c.version),
      cases.slice(1).map((c) => c.version),
    );
    const reordered = parseCases(file(KITE, CANARY, EDIT, LANTERN));
    assert.deepEqual(
      reordered.map((c) => [c.id, c.version]),
      [kite, canary, edit, lantern].map((c) => [c.id, c.version]),
      "a block's version does not depend on its neighbours or the separators around it",
    );
  });

  it("moves checklistVersion when an item or the control changes", () => {
    const item = parseCases(file(withLine(LANTERN, "[ ] the lantern", '[ ] the lantern glows <- "lantern"')))[0];
    const control = parseCases(file(withLine(LANTERN, "**Control:**", "**Control:** the river is lemonade")))[0];
    assert.notEqual(item.checklistVersion, lantern.checklistVersion);
    assert.notEqual(control.checklistVersion, lantern.checklistVersion);
  });

  it("finds a case by id", () => {
    assert.equal(caseById(cases, "pebble")?.number, 8);
    assert.equal(caseById(cases, "missing"), undefined);
  });

  it("marks every case holdout when read as the private file, and refuses a public one there", () => {
    const holdouts = parseCases(file(LANTERN), CaseVisibility.Holdout);
    assert.equal(holdouts[0].visibility, CaseVisibility.Holdout);
    refused(
      file(["## C3 · `hid` — hidden", "**Visibility:** holdout", "**Exposure:** none", "> Hi."]),
      CaseField.Visibility,
    );
    refused(
      file(["## C3 · `hid` — hidden", "**Visibility:** public", "**Exposure:** none", "> Hi."]),
      CaseField.Visibility,
      CaseVisibility.Holdout,
    );
  });
});

describe("malformed case files are refused by field", () => {
  const rows: [string, string, CaseField][] = [
    ["no case at all", "# Nothing\n\nJust prose.\n", CaseField.Heading],
    ["a C-heading with the wrong separators", file(["## C4 - `bad` - label", "> Hi."]), CaseField.Heading],
    ["an id that is not a slug", file(withLine(CANARY, "## C8", "## C8 · `Bad_Id` — x")), CaseField.Id],
    [
      "an id the ledger guard would refuse as a secret",
      file(withLine(CANARY, "## C8", "## C8 · `sk-8ball` — x")),
      CaseField.Id,
    ],
    ["a duplicate id", file(CANARY, withLine(CANARY, "## C8", "## C7 · `pebble` — again")), CaseField.Id],
    ["a duplicate number", file(CANARY, withLine(CANARY, "## C8", "## C8 · `other` — again")), CaseField.Number],
    ["no brief", file(withLine(CANARY, "> A pebble", null)), CaseField.Brief],
    ["no exposure", file(withLine(CANARY, "**Exposure:**", null)), CaseField.Exposure],
    ["an unknown exposure", file(withLine(CANARY, "**Exposure:**", "**Exposure:** tuned")), CaseField.Exposure],
    [
      "dev-tuned without a reason",
      file(withLine(CANARY, "**Exposure:**", "**Exposure:** dev-tuned")),
      CaseField.Exposure,
    ],
    ["none with a reason", file(withLine(CANARY, "**Exposure:**", "**Exposure:** none (why)")), CaseField.Exposure],
    ["a repeated field", file([...CANARY, "**Exposure:** none"]), CaseField.Exposure],
    ["an unknown mode", file(withLine(EDIT, "**Mode:**", "**Mode:** `remix`")), CaseField.Mode],
    ["a malformed deadline", file(withLine(KITE, "**Deadline:**", "**Deadline:** soon")), CaseField.Deadline],
    ["a zero deadline", file(withLine(KITE, "**Deadline:**", "**Deadline:** 0 min")), CaseField.Deadline],
    ["a checklist without a control", file(withLine(LANTERN, "**Control:**", null)), CaseField.Control],
    ["a control without a checklist", file([...CANARY, "", "**Control:** a tuba"]), CaseField.Control],
    [
      "an empty acceptance block",
      file([...CANARY, "**Acceptance:**", "```", "```", "**Control:** x"]),
      CaseField.Acceptance,
    ],
    [
      "an acceptance label with no fence",
      file([...CANARY, "**Acceptance:**", "", "**Control:** x"]),
      CaseField.Acceptance,
    ],
    ["a ticked item", file(withLine(LANTERN, "[ ] the lantern", "[x] the lantern is lit")), CaseField.Acceptance],
    [
      "a stray line before the first item",
      file(withLine(LANTERN, "[ ] the lantern", "the lantern")),
      CaseField.Acceptance,
    ],
    [
      "a follow-up case without follow-ups",
      file(KITE.filter((line) => !FOLLOW_UP_LINE.test(line))),
      CaseField.FollowUps,
    ],
    ["a stray line in the follow-ups", file(withLine(KITE, "1. Now", "Now, the wind.")), CaseField.FollowUps],
    ["follow-ups on a build case", file([...CANARY, "**Follow-ups:**", "1. More."]), CaseField.FollowUps],
    ["an edit case without a start folder", file(withLine(EDIT, "**Start from:**", null)), CaseField.StartFrom],
    [
      "a start folder on a build case",
      file([...CANARY, "**Start from:** `tests/fixtures/evals/games/x`"]),
      CaseField.StartFrom,
    ],
    [
      "a start folder outside the fixture games",
      file(withLine(EDIT, "**Start from:**", "**Start from:** `../outside`")),
      CaseField.StartFrom,
    ],
    [
      "a start folder that climbs",
      file(withLine(EDIT, "**Start from:**", "**Start from:** `tests/fixtures/evals/games/../../x`")),
      CaseField.StartFrom,
    ],
    [
      "an absolute start folder",
      file(withLine(EDIT, "**Start from:**", "**Start from:** `/etc`")),
      CaseField.StartFrom,
    ],
  ];
  for (const [name, markdown, field] of rows) it(name, () => refused(markdown, field));
});

describe("the committed case file", () => {
  const cases = readCases(root);

  it("holds the planned public set, each case versioned and public", () => {
    assert.deepEqual(
      cases.map((c) => [c.id, c.mode]),
      [
        ["medieval-village", CaseMode.Build],
        ["shooter", CaseMode.Build],
        ["mini-golf", CaseMode.Build],
        ["vague-brief", CaseMode.Build],
        ["canary", CaseMode.Build],
        ["edit-existing", CaseMode.EditExisting],
        ["follow-up", CaseMode.FollowUp],
        ["long-horizon", CaseMode.LongHorizon],
        ["vague-unreal-on", CaseMode.Build],
        ["unreal-plugin-off", CaseMode.Build],
        ["port-to-unreal", CaseMode.EditExisting],
        ["godot-no-plugin", CaseMode.FollowUp],
        ["loop-finish-check", CaseMode.LongHorizon],
        ["timed-wrap-up", CaseMode.LongHorizon],
        ["godot-loop", CaseMode.LongHorizon],
      ],
    );
    for (const c of cases) assert.equal(c.visibility, CaseVisibility.Public);
  });

  it("labels the village dev-tuned and keeps every other case untuned", () => {
    const tuned = cases.filter((c) => c.exposure === CaseExposure.DevTuned).map((c) => c.id);
    assert.deepEqual(tuned, ["medieval-village"]);
    assert.ok(caseById(cases, "medieval-village")?.exposureReason);
  });

  it("gives the canary no checklist and every other case exactly one control", () => {
    for (const c of cases) {
      const controls = c.acceptance.filter((item) => item.control).length;
      assert.equal(controls, c.id === "canary" ? 0 : 1, c.id);
    }
    assert.deepEqual(caseById(cases, "canary")?.acceptance, []);
  });

  it("keeps the ported pinned village checklist: nine items, one KEY, one assets-only", () => {
    const items = (caseById(cases, "medieval-village")?.acceptance ?? []).filter((item) => !item.control);
    assert.equal(items.length, 9);
    assert.equal(items.filter((item) => item.key).length, 1);
    assert.equal(items.filter((item) => item.assetsOnly).length, 1);
  });

  it("starts the edit case from a committed fixture game with an entry page", () => {
    const edit = caseById(cases, "edit-existing");
    assert.ok(edit);
    const folder = resolveStartFrom(root, edit);
    assert.ok(fs.statSync(path.join(folder, "index.html")).isFile());
    assert.ok(caseById(cases, "follow-up")?.followUps.length);
    assert.ok((caseById(cases, "long-horizon")?.deadlineMin ?? 0) > DEFAULT_CASE_DEADLINE_MIN);
  });
});

describe("private holdouts", () => {
  it("reads no holdouts when the private file is absent", async () => {
    const home = await tmpDir("eval-cases-");
    assert.deepEqual(readHoldoutCases(home), []);
  });

  it("reads the private file as holdout cases", async () => {
    const home = await tmpDir("eval-cases-");
    fs.writeFileSync(path.join(home, PRIVATE_CASES_FILE), file(LANTERN));
    const holdouts = readHoldoutCases(home);
    assert.deepEqual(
      holdouts.map((c) => [c.id, c.visibility]),
      [["lantern-walk", CaseVisibility.Holdout]],
    );
  });

  it("refuses a relative evals home", () => {
    assert.throws(() => readHoldoutCases("relative/home"), CaseFileError);
  });
});

describe("start folders resolve only inside the committed fixture games", () => {
  async function tree() {
    const repo = await tmpDir("eval-start-");
    const games = path.join(repo, START_FROM_ROOT);
    const outside = path.join(repo, "outside");
    fs.mkdirSync(path.join(games, "good"), { recursive: true });
    fs.writeFileSync(path.join(games, "good", "index.html"), "<!doctype html>");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(games, "a-file"), "not a folder");
    fs.symlinkSync(outside, path.join(games, "escape"));
    fs.symlinkSync(path.join(games, "good"), path.join(games, "alias"));
    return repo;
  }
  const snapshot = (dir: string) => fs.readdirSync(dir, { recursive: true }).map(String).sort();
  const edit = (startFrom: string | null) => ({ id: "patch-work", startFrom });

  it("returns the real folder of a valid start", async () => {
    const repo = await tree();
    assert.equal(
      resolveStartFrom(repo, edit(`${START_FROM_ROOT}/good`)),
      fs.realpathSync(path.join(repo, START_FROM_ROOT, "good")),
    );
  });

  const hostile: [string, string | null][] = [
    ["no start folder", null],
    ["a symlink out of the fixture games", `${START_FROM_ROOT}/escape`],
    ["a symlink to another fixture game", `${START_FROM_ROOT}/alias`],
    ["a missing folder", `${START_FROM_ROOT}/missing`],
    ["a file, not a folder", `${START_FROM_ROOT}/a-file`],
    ["the fixture games root itself", START_FROM_ROOT],
    ["a climb out", `${START_FROM_ROOT}/../../../outside`],
    ["an absolute path", "/etc"],
    ["a backslash path", `${START_FROM_ROOT}\\good`],
  ];
  for (const [name, startFrom] of hostile) {
    it(`refuses ${name}, touching nothing`, async () => {
      const repo = await tree();
      const before = snapshot(repo);
      assert.throws(
        () => resolveStartFrom(repo, edit(startFrom)),
        (error: unknown) => error instanceof CaseFileError && error.field === CaseField.StartFrom,
      );
      assert.deepEqual(snapshot(repo), before);
    });
  }
});
