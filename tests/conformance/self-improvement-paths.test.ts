/**
 * Applying a learned suggestion writes into the harness workspace, which the sandboxed harness can
 * also write (and plant links in). The host is not sandboxed, so a suggestion lands only on a file
 * whose every folder really lies in the workspace: a link on the way, at the file or at its
 * folder, refuses the suggestion and leaves everything outside the workspace as it was.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { SuggestionRefused, type StagedRecord } from "../../src/main/self-changes.ts";
import { coreLite, type CoreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

const LESSONS_FILE = "library/contract-lessons.md";
const PAYLOAD = "<plist>planted by the harness</plist>\n";
const OUTSIDE_SECRET = "a file the harness must never rewrite\n";
const SKILL = "facet-decomposition";

const SYMLINKS = { skip: process.platform === "win32" && "planting symbolic links needs privileges on Windows" };

/** Every file under `dir` with its text, so a row can assert nothing there changed. */
async function contents(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    out[path.relative(dir, file)] = await readFile(file, "utf8");
  }
  return out;
}

const lessonsRecord = (currentText: string): StagedRecord => ({
  target: "lessons",
  skill: "contract-lessons",
  file: LESSONS_FILE,
  currentText,
  proposedText: PAYLOAD,
  edits: [],
  gate: { accept: true },
  rationale: "test",
  at: "2026-10-06T00:00:00.000Z",
});

const skillRecord = (currentText: string): StagedRecord => ({
  skill: SKILL,
  file: `skills/${SKILL}.md`,
  currentText,
  proposedText: PAYLOAD,
  edits: [],
  gate: { accept: true },
  rationale: "test",
  at: "2026-10-06T00:00:01.000Z",
});

interface HostileRow {
  name: string;
  /** Plants the link (or the odd file) in the workspace; returns the record the harness stages. */
  plant: (ws: string, outside: string) => Promise<StagedRecord>;
}

const HOSTILE: HostileRow[] = [
  {
    name: "a dangling link at the lessons file",
    plant: async (ws, outside) => {
      await mkdir(path.join(ws, "library"), { recursive: true });
      await symlink(path.join(outside, "x.plist"), path.join(ws, LESSONS_FILE));
      return lessonsRecord("");
    },
  },
  {
    name: "a lessons file linked to an existing outside file",
    plant: async (ws, outside) => {
      await mkdir(path.join(ws, "library"), { recursive: true });
      await symlink(path.join(outside, "secret.txt"), path.join(ws, LESSONS_FILE));
      return lessonsRecord(OUTSIDE_SECRET);
    },
  },
  {
    name: "a library folder linked to an outside folder",
    plant: async (ws, outside) => {
      await rm(path.join(ws, "library"), { recursive: true, force: true });
      await symlink(outside, path.join(ws, "library"));
      return lessonsRecord("");
    },
  },
  {
    name: "a library folder linked to an outside folder that does not exist",
    plant: async (ws, outside) => {
      await rm(path.join(ws, "library"), { recursive: true, force: true });
      await symlink(path.join(outside, "LaunchAgents"), path.join(ws, "library"));
      return lessonsRecord("");
    },
  },
  {
    name: "a library folder linked to another folder of the workspace",
    plant: async (ws) => {
      await rm(path.join(ws, "library"), { recursive: true, force: true });
      await symlink(path.join(ws, "prompts"), path.join(ws, "library"));
      return lessonsRecord("");
    },
  },
  {
    name: "a library that is a file, not a folder",
    plant: async (ws) => {
      await rm(path.join(ws, "library"), { recursive: true, force: true });
      await writeFile(path.join(ws, "library"), "not a folder\n");
      return lessonsRecord("");
    },
  },
  {
    name: "a skill file linked to an existing outside file",
    plant: async (ws, outside) => {
      await rm(path.join(ws, "skills", `${SKILL}.md`), { force: true });
      await symlink(path.join(outside, "secret.txt"), path.join(ws, "skills", `${SKILL}.md`));
      return skillRecord(OUTSIDE_SECRET);
    },
  },
];

async function stage(lite: CoreLite, record: StagedRecord): Promise<void> {
  await lite.core.store.writeArtifact(lite.core.mainThread, "skillopt_staged", [record]);
}

describe("applying a learned suggestion stays inside the harness workspace", () => {
  for (const row of HOSTILE) {
    it(`refuses ${row.name}, and nothing outside the workspace changes`, SYMLINKS, async () => {
      const lite = await coreLite();
      const ws = lite.core.layout.harnessWs;
      const outside = await tmpDir("self-improvement-outside-");
      await writeFile(path.join(outside, "secret.txt"), OUTSIDE_SECRET);
      const outsideBefore = await contents(outside);
      const promptsBefore = await contents(path.join(ws, "prompts"));
      const record = await row.plant(ws, outside);
      await stage(lite, record);

      await assert.rejects(
        lite.core.acceptStagedProposal(0, "auto", { at: record.at, skill: record.skill }),
        SuggestionRefused,
        "a refusal the automatic sweep discards instead of retrying",
      );
      assert.deepEqual(await contents(outside), outsideBefore, "nothing outside the workspace was written");
      assert.deepEqual(await contents(path.join(ws, "prompts")), promptsBefore, "nor a folder the link led to");
      await lite.close();
    });
  }

  it("still starts the lessons file when its folder is missing", async () => {
    const lite = await coreLite();
    const ws = lite.core.layout.harnessWs;
    await rm(path.join(ws, "library"), { recursive: true, force: true });
    const record = lessonsRecord("");
    await stage(lite, record);
    await lite.core.acceptStagedProposal(0, "human", { at: record.at, skill: record.skill });
    assert.equal(await readFile(path.join(ws, LESSONS_FILE), "utf8"), PAYLOAD);
    await lite.close();
  });
});
