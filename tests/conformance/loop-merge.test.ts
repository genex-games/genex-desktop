/**
 * The seed's union merge of the FACET WIRING block (`loop/merge.ts`) on each template's real entry:
 * two facets merged in parallel that both add the same wiring line end with that line once, and
 * every line either side added stays. For a Rust · wgpu entry each facet adds two lines (its
 * `#[path = "facets/<slug>.rs"] mod <slug>;` and its `<slug>::wire(&mut game);`), so the block's
 * dedupe has to cover both, and the merged entry must still hand the game to `genex::install`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { unionMergeMain, WIRING_END, WIRING_START } from "../../src/harness-seed/loop/merge.ts";
import { STUDIO_AS } from "../../src/harness-seed/loop/repo.ts";
import { installsGenex } from "../../src/substrate/game-validation.ts";
import { shellExec as sh } from "../helpers/posix-shell.ts";
import { fixtureGit } from "../helpers/snapshot-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const POSIX_ONLY = process.platform === "win32" ? "not run: a POSIX shell runs the merge" : false;

/** One template's entry and the wiring lines a facet adds to it. */
interface EntryCase {
  name: string;
  template: string;
  main: string;
  facet: (slug: string) => string[];
}

const ENTRIES: readonly EntryCase[] = [
  {
    name: "Three.js",
    template: "src/game-template",
    main: "src/main.js",
    facet: (slug) => [`import { wire as wire_${slug} } from "./facets/${slug}.js"; wire_${slug}(game);`],
  },
  {
    name: "C++ · raylib",
    template: "src/game-template-cpp",
    main: "src/main.cpp",
    facet: (slug) => [`void wire_${slug}(studio::Game&); wire_${slug}(game);`],
  },
  {
    name: "Rust · wgpu",
    template: "src/game-template-rust",
    main: "src/main.rs",
    facet: (slug) => [`#[path = "facets/${slug}.rs"] mod ${slug};`, `${slug}::wire(&mut game);`],
  },
];

/** `entry` with `added` inserted right after its FACET WIRING opening line, indented as that line is. */
function withWiring(entry: string, added: readonly string[]): string {
  const lines = entry.split("\n");
  const at = lines.findIndex((line) => WIRING_START.test(line));
  assert.ok(at >= 0, "the entry has a FACET WIRING block");
  const indent = /^\s*/.exec(lines[at] ?? "")?.[0] ?? "";
  return [...lines.slice(0, at + 1), ...added.map((line) => `${indent}${line}`), ...lines.slice(at + 1)].join("\n");
}

/** The trimmed, non-empty lines strictly inside the wiring block. */
function wiringLines(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => WIRING_START.test(line));
  const end = lines.findIndex((line) => WIRING_END.test(line));
  return lines
    .slice(start + 1, end)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** A repository holding the template's entry, with branch `theirs` and `main` each wiring their own facets. */
async function divergedRepo(entry: EntryCase, ours: readonly string[], theirs: readonly string[]): Promise<string> {
  const base = readFileSync(path.join(REPO, entry.template, entry.main), "utf8");
  const worktree = await tmpDir("studio-loop-merge-");
  await mkdir(path.join(worktree, path.dirname(entry.main)), { recursive: true });
  await fixtureGit(worktree, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(worktree, entry.main), base);
  await fixtureGit(worktree, ["add", "-A"]);
  await fixtureGit(worktree, ["commit", "-q", "-m", "template"]);
  await fixtureGit(worktree, ["checkout", "-q", "-b", "theirs"]);
  await writeFile(path.join(worktree, entry.main), withWiring(base, theirs));
  await fixtureGit(worktree, ["commit", "-q", "-am", "theirs"]);
  await fixtureGit(worktree, ["checkout", "-q", "main"]);
  await writeFile(path.join(worktree, entry.main), withWiring(base, ours));
  await fixtureGit(worktree, ["commit", "-q", "-am", "ours"]);
  return worktree;
}

describe("two facets wiring the same line into a template's entry merge to one copy of it", () => {
  for (const entry of ENTRIES) {
    it(`${entry.name}: ${entry.main}`, { skip: POSIX_ONLY }, async () => {
      const shared = entry.facet("fishing");
      // Crossed, so git cannot trim the shared lines off the conflict: the union holds them twice.
      const ours = [...entry.facet("shop"), ...shared];
      const theirs = [...shared, ...entry.facet("weather")];
      const worktree = await divergedRepo(entry, ours, theirs);
      const conflicted = await sh(`git ${STUDIO_AS} merge -q theirs`, worktree);
      assert.equal(conflicted.code, 1, `the parallel wiring conflicts: ${conflicted.stderr}`);

      const merged = await unionMergeMain((command: string) => sh(command, worktree), { main: entry.main });
      assert.equal(merged.ok, true, merged.reason);
      assert.equal(merged.duplicates, shared.length, "each shared line was dropped once");

      const text = await readFile(path.join(worktree, entry.main), "utf8");
      const wiring = wiringLines(text);
      assert.equal(new Set(wiring).size, wiring.length, `no wiring line twice:\n${wiring.join("\n")}`);
      const templateWiring = wiringLines(readFileSync(path.join(REPO, entry.template, entry.main), "utf8"));
      assert.deepEqual(
        [...wiring].sort(),
        [...new Set([...templateWiring, ...ours, ...theirs])].sort(),
        "the template's own lines and every line either facet added stay",
      );
      assert.equal(await fixtureGit(worktree, ["status", "--porcelain"]), "", "the merge is committed");
      if (entry.main.endsWith(".rs")) assert.ok(installsGenex(text), "the merged entry still installs the game");
    });
  }
});
