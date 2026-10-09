/**
 * The harness seed's rename of a loop run's old name, carried into the files a seed upgrade keeps:
 * a module the in-app agent edited, or one it wrote, still says the old names, which the shipped
 * files no longer export. The upgrade rewrites them (the original backed up), moves an edited copy
 * of a renamed module to its new path, and the harness loads.
 */
import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applySeed } from "../../src/substrate/seed-upgrade.ts";
import { RENAMED_SEED_FILES, RENAMED_SEED_NAMES, renameInSource } from "../../src/substrate/seed-renames.ts";
import { pathExists } from "../../src/substrate/fsx.ts";
import { tmpDir } from "../helpers/tmp.ts";

const SHIPPED = path.resolve(fileURLToPath(new URL("../../src/harness-seed", import.meta.url)));
const OLD_NAME = Object.fromEntries(Object.entries(RENAMED_SEED_NAMES).map(([oldName, newName]) => [newName, oldName]));
/** The old names a comment never keeps either: every one that is not also an English word. */
const COMPOUND_OLD_NAMES = Object.keys(RENAMED_SEED_NAMES).filter((name) => name !== "Night" && name !== "tonight");
const EDIT = "// the agent's own change";

/** Every `.ts` file under `dir`, relative to it. */
async function tsFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await tsFiles(dir, rel)));
    else if (entry.name.endsWith(".ts")) out.push(rel);
  }
  return out;
}

/** `text` as the seed wrote it before the rename: old names, old module paths. */
function withOldNames(text: string): string {
  let out = text
    .replace(/(["'][^"'\n]*?)loop-run\.ts(["'])/g, "$1night.ts$2")
    .replace(/(["'][^"'\n]*?)after-loop-run/g, "$1after-night");
  for (const [newName, oldName] of Object.entries(OLD_NAME))
    out = out.replace(new RegExp(`(?<![\\w$])${newName}(?![\\w$])`, "g"), oldName);
  return out;
}

/** The shipped seed as it stood before the rename, written to `dir`. */
async function seedBeforeRename(dir: string): Promise<void> {
  await cp(SHIPPED, dir, { recursive: true });
  for (const [oldPath, newPath] of Object.entries(RENAMED_SEED_FILES))
    await rename(path.join(dir, newPath), path.join(dir, oldPath));
  for (const rel of await tsFiles(dir))
    await writeFile(path.join(dir, rel), withOldNames(await readFile(path.join(dir, rel), "utf8")));
}

/** A workspace seeded with the older seed, then left to `edit`, then upgraded to the shipped one. */
async function upgradedFromBeforeRename(edit: (ws: string) => Promise<void>, { backup = true } = {}) {
  const root = await tmpDir("seed-renames-");
  const older = path.join(root, "older");
  const ws = path.join(root, "workspace");
  const manifestFile = path.join(root, "manifest.json");
  const backupDir = path.join(root, "backup");
  await seedBeforeRename(older);
  await applySeed({ seedDir: older, workspaceDir: ws, manifestFile });
  await edit(ws);
  const report = await applySeed({
    seedDir: SHIPPED,
    workspaceDir: ws,
    manifestFile,
    ...(backup ? { backupDir } : {}),
  });
  return { root, ws, backupDir, report };
}

/** Append the agent's edit to the workspace file at `rel`, and answer what it now holds. */
async function agentEdits(ws: string, rel: string): Promise<string> {
  const file = path.join(ws, rel);
  const text = `${await readFile(file, "utf8")}${EDIT}\n`;
  await writeFile(file, text);
  return text;
}

const hasCompoundOldName = (text: string): boolean =>
  COMPOUND_OLD_NAMES.some((name) => new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(text));

describe("the rename in one module's source", () => {
  it("rewrites the old names and the moved modules' specifiers, wherever the module stands", () => {
    const cases: Array<[rel: string, before: string, after: string]> = [
      [
        "loop/director/journal.ts",
        'import { bindNight, type Night } from "./night.ts";',
        'import { bindLoopRun, type LoopRun } from "./loop-run.ts";',
      ],
      [
        "loop/facet/state.ts",
        'import type { NightState } from "../director/night.ts";',
        'import type { LoopRunState } from "../director/loop-run.ts";',
      ],
      [
        "loop/chat-session.ts",
        'import { afterNightNote } from "./after-night-prompts.ts";',
        'import { afterLoopRunNote } from "./after-loop-run-prompts.ts";',
      ],
      [
        "loop/main.ts",
        'export { nightRefusal } from "./run-dispatch.ts";',
        'export { loopRunRefusal } from "./run-dispatch.ts";',
      ],
      ["loop/director/x.ts", "const { ctx, tonight } = night;", "const { ctx, runLedger } = night;"],
      [
        "loop/director/x.ts",
        "await night.closeTheNight({ land: true });",
        "await night.closeTheLoopRun({ land: true });",
      ],
    ];
    for (const [rel, before, after] of cases) assert.equal(renameInSource(rel, before), after, before);
  });

  it("leaves English, look-alike names and other modules alone, and comments keep their English", () => {
    const untouched = [
      "// what tonight's Night taught us",
      "/**\n * the Night it led, tonight\n */",
      'const prompt = "a race at night";',
      "const knightMove = midnight + nightly;",
      'import { nightly } from "./nightly.ts";',
      'import { slug } from "./director/args.ts";',
    ];
    for (const line of untouched) assert.equal(renameInSource("loop/director/x.ts", line), line, line);
    assert.equal(renameInSource("loop/x.ts", "// bindNight and closeTheNight"), "// bindLoopRun and closeTheLoopRun");
  });

  it("keeps English in strings, template text and patterns, and renames the code beside it", () => {
    const before = [
      'const title = "Night falls on the track"; const run: Night = night;',
      "const brief = `Race tonight.",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: module source with a template in it
      "Night mode: ${night.tonight.map((r) => `${r.part} tonight`).length} laps`;",
      "const quote = /[\"'`]/; const word = /\\bNight\\b/g; let next: Night;",
      'type Counters = Pick<NightData, "tonight">; // the counters tonight',
      "const half = night.rounds / 2; const tally: Night[] = [];",
      'const share = parts[0]! / total; const named = !/"Night"/.test(title); let mine: Night;',
    ].join("\n");
    const after = [
      'const title = "Night falls on the track"; const run: LoopRun = night;',
      "const brief = `Race tonight.",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: module source with a template in it
      "Night mode: ${night.runLedger.map((r) => `${r.part} tonight`).length} laps`;",
      "const quote = /[\"'`]/; const word = /\\bNight\\b/g; let next: LoopRun;",
      'type Counters = Pick<LoopRunData, "runLedger">; // the counters tonight',
      "const half = night.rounds / 2; const tally: LoopRun[] = [];",
      'const share = parts[0]! / total; const named = !/"Night"/.test(title); let mine: LoopRun;',
    ].join("\n");
    assert.equal(renameInSource("loop/director/x.ts", before), after);
  });

  it("finds nothing to rename in a workspace on the current names, every module of it edited", async () => {
    const root = await tmpDir("seed-renames-current-");
    const ws = path.join(root, "workspace");
    const manifestFile = path.join(root, "manifest.json");
    await applySeed({ seedDir: SHIPPED, workspaceDir: ws, manifestFile });
    for (const rel of await tsFiles(ws))
      if (rel.startsWith("loop/") || rel.startsWith("tools/")) await agentEdits(ws, rel);
    const report = await applySeed({
      seedDir: SHIPPED,
      workspaceDir: ws,
      manifestFile,
      backupDir: path.join(root, "b"),
    });
    assert.deepEqual(report.renamed ?? [], [], "a shipped module still says an old name");
  });
});

describe("a seed upgrade across the rename", () => {
  it("rewrites an agent-edited module, moves an edited renamed one, retires the untouched ones, and the harness loads", async () => {
    const edited: Record<string, string> = {};
    const { ws, backupDir, report } = await upgradedFromBeforeRename(async (ws) => {
      edited.journal = await agentEdits(ws, "loop/director/journal.ts");
      edited.night = await agentEdits(ws, "loop/director/night.ts");
      // A tool the agent wrote itself, on the old names.
      edited.tool = 'import { nightClock } from "../loop/director/journal.ts";\nexport const clock = nightClock;\n';
      await writeFile(path.join(ws, "tools", "my-clock.ts"), edited.tool);
    });

    assert.ok(report.kept.includes("loop/director/journal.ts"), "the agent's journal is kept");
    assert.ok(report.kept.includes("loop/director/loop-run.ts"), "its edited night module is kept at the new path");
    assert.deepEqual([...(report.renamed ?? [])].sort(), [
      "loop/director/journal.ts",
      "loop/director/loop-run.ts",
      "tools/my-clock.ts",
    ]);
    for (const rel of ["loop/director/journal.ts", "loop/director/loop-run.ts", "tools/my-clock.ts"]) {
      const text = await readFile(path.join(ws, rel), "utf8");
      assert.ok(!hasCompoundOldName(text), `${rel} still says an old name`);
    }
    for (const rel of ["loop/director/journal.ts", "loop/director/loop-run.ts"])
      assert.ok((await readFile(path.join(ws, rel), "utf8")).includes(EDIT), `${rel} keeps the agent's edit`);

    assert.equal(await pathExists(path.join(ws, "loop/director/night.ts")), false, "the old path is gone");
    for (const oldPath of ["loop/after-night.ts", "loop/after-night-prompts.ts"]) {
      assert.ok(report.retired.includes(oldPath), `${oldPath}, untouched, is retired`);
      assert.equal(await pathExists(path.join(ws, oldPath)), false);
    }
    assert.equal(await readFile(path.join(backupDir, "loop/director/journal.ts"), "utf8"), edited.journal);
    assert.equal(await readFile(path.join(backupDir, "loop/director/night.ts"), "utf8"), edited.night);
    assert.equal(await readFile(path.join(backupDir, "tools/my-clock.ts"), "utf8"), edited.tool);

    // What the bootstrap does: import the workspace's main.ts. An old name a kept module still
    // exported, and a shipped one no longer imported, would throw here at link time.
    const main = (await import(`${pathToFileURL(path.join(ws, "loop", "main.ts")).href}?v=${Date.now()}`)) as {
      createStudio?: unknown;
    };
    assert.equal(typeof main.createStudio, "function");
  });

  it("an edited module at the old path takes the place of the app's untouched copy, never of the agent's", async () => {
    /** A shipped workspace where the agent's older `night.ts` stands beside a `loop-run.ts` that is `mine` or the app's. */
    const upgrade = async (mine: boolean) => {
      const root = await tmpDir("seed-renames-beside-");
      const ws = path.join(root, "workspace");
      const manifestFile = path.join(root, "manifest.json");
      const backupDir = path.join(root, "backup");
      await applySeed({ seedDir: SHIPPED, workspaceDir: ws, manifestFile });
      const shippedText = await readFile(path.join(ws, "loop/director/loop-run.ts"), "utf8");
      await writeFile(path.join(ws, "loop/director/night.ts"), `${withOldNames(shippedText)}${EDIT}\n`);
      if (mine) await writeFile(path.join(ws, "loop/director/loop-run.ts"), `${shippedText}// mine\n`);
      const report = await applySeed({ seedDir: SHIPPED, workspaceDir: ws, manifestFile, backupDir });
      const now = await readFile(path.join(ws, "loop/director/loop-run.ts"), "utf8");
      return { ws, backupDir, report, shippedText, now };
    };

    const overApps = await upgrade(false);
    assert.ok(overApps.report.kept.includes("loop/director/loop-run.ts"));
    assert.ok(overApps.now.includes(EDIT), "the agent's edit now stands at the new path");
    assert.ok(!hasCompoundOldName(overApps.now));
    assert.equal(
      await readFile(path.join(overApps.backupDir, "loop/director/loop-run.ts"), "utf8"),
      overApps.shippedText,
    );
    assert.equal(await pathExists(path.join(overApps.ws, "loop/director/night.ts")), false);

    const overMine = await upgrade(true);
    assert.equal(
      overMine.now,
      `${overMine.shippedText}// mine\n`,
      "the agent's own file at the new path is not replaced",
    );
    assert.equal(await pathExists(path.join(overMine.ws, "loop/director/night.ts")), true, "and the old one is left");
  });

  it("rewrites nothing without a place to back the agent's files up", async () => {
    const edited: Record<string, string> = {};
    const { ws, report } = await upgradedFromBeforeRename(
      async (ws) => {
        edited.journal = await agentEdits(ws, "loop/director/journal.ts");
      },
      { backup: false },
    );
    assert.deepEqual(report.renamed ?? [], []);
    assert.equal(await readFile(path.join(ws, "loop/director/journal.ts"), "utf8"), edited.journal);
  });

  it("never follows a link: a linked module or folder outside the workspace is left as it was", async () => {
    const outside = await tmpDir("seed-renames-outside-");
    const outsideFile = path.join(outside, "night.ts");
    const outsideText = "export function bindNight() {}\n";
    await writeFile(outsideFile, outsideText);
    await mkdir(path.join(outside, "dir"));
    const outsideTool = path.join(outside, "dir", "linked.ts");
    await writeFile(outsideTool, 'import { nightClock } from "../../loop/director/journal.ts";\n');
    const toolText = await readFile(outsideTool, "utf8");

    await upgradedFromBeforeRename(async (ws) => {
      await agentEdits(ws, "loop/director/night.ts");
      await rm(path.join(ws, "loop/director/night.ts"));
      await symlink(outsideFile, path.join(ws, "loop/director/night.ts"));
      await symlink(path.join(outside, "dir"), path.join(ws, "tools", "linked-dir"));
    });

    assert.equal(await readFile(outsideFile, "utf8"), outsideText, "the linked module outside was not rewritten");
    assert.equal(await readFile(outsideTool, "utf8"), toolText, "a file in a linked folder was not rewritten");
    assert.equal(
      await pathExists(path.join(outside, "loop-run.ts")),
      false,
      "nothing was moved beside the link's target",
    );
  });
});
