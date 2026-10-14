/**
 * Two director workers on a Rust · wgpu template, built in parallel from one starting point and
 * integrated one after the other (M3.14). Each adds a facet: its own `src/facets/<slug>.rs` and its
 * two FACET WIRING lines in `src/main.rs`. Every file each worker wrote is its own by both copies of
 * the ownership rule (the edit-time hook and the seed's reviewer), and the integration composes
 * the merge the way the director's `integrate` does (git.ts `mergeNoFf` resolved by merge.ts
 * `unionMergeMain` with native-loop.ts `wiringFor`): one `src/main.rs` holding both facets' wiring
 * lines, nothing escalated as a conflict, in either order.
 */
import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { mergeNoFf } from "../../src/harness-seed/loop/git.ts";
import { HostMethod } from "../../src/harness-seed/loop/host-methods.ts";
import { unionMergeMain, WIRING_END, WIRING_START } from "../../src/harness-seed/loop/merge.ts";
import { GameStack } from "../../src/harness-seed/loop/native-contract.ts";
import { templateShapeFor, wiringFor } from "../../src/harness-seed/loop/native-loop.ts";
import { STUDIO_AS } from "../../src/harness-seed/loop/repo.ts";
import {
  type ReviewSpec,
  allowedFile as reviewAllowedFile,
  mechanicalReview,
} from "../../src/harness-seed/loop/review.ts";
import type { HarnessCtx } from "../../src/harness-seed/types/harness.d.ts";
import { installsGenex } from "../../src/substrate/game-validation.ts";
import { allowedFile as hookAllowedFile } from "../../src/substrate/ownership.ts";
import { shellExec as sh } from "../helpers/posix-shell.ts";
import { fixtureGit } from "../helpers/snapshot-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TEMPLATE = path.join(REPO, "src", "game-template-rust");
const POSIX_ONLY = process.platform === "win32" ? "not run: a POSIX shell runs the merge" : false;
/** The Rust template's entry, as the night's shape names it. */
const MAIN = "src/main.rs";

/** A facet a worker adds: its module and its two wiring lines. */
function facetFiles(slug: string): { module: string; source: string; wiring: string[] } {
  return {
    module: `src/facets/${slug}.rs`,
    source: `use genex::prelude::*;\n\n/// The ${slug} facet.\npub fn wire<W>(game: &mut Game<W>) {\n    let _ = game;\n}\n`,
    wiring: [`#[path = "facets/${slug}.rs"] mod ${slug};`, `${slug}::wire(&mut game);`],
  };
}

/** `entry` with `added` right after its FACET WIRING opening line, indented as that line is. */
function withWiring(entry: string, added: readonly string[]): string {
  const lines = entry.split("\n");
  const at = lines.findIndex((line) => WIRING_START.test(line));
  assert.ok(at >= 0, "the Rust template's entry has a FACET WIRING block");
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

/** A ctx whose `run.exec` runs the command in its folder, as the host's does in a worktree. */
function shellCtx(): HarnessCtx {
  const call = async (method: string, params: { command: string; cwd: string }) => {
    assert.equal(method, HostMethod.RunExec);
    return sh(params.command, params.cwd);
  };
  return { call } as unknown as HarnessCtx;
}

/** The integration worktree on the template, and one worker worktree per slug forked from it. */
async function parallelWorkers(
  slugs: readonly string[],
): Promise<{ integration: string; workers: Array<{ slug: string; worktree: string }> }> {
  const integration = await tmpDir("studio-director-parallel-");
  await cp(TEMPLATE, integration, { recursive: true });
  await fixtureGit(integration, ["init", "-q", "-b", "integration"]);
  await fixtureGit(integration, ["add", "-A"]);
  await fixtureGit(integration, ["commit", "-q", "-m", "template"]);
  const workers: Array<{ slug: string; worktree: string }> = [];
  for (const slug of slugs) {
    const worktree = path.join(await tmpDir(`studio-director-worker-${slug}-`), "wt");
    await fixtureGit(integration, ["worktree", "add", "-q", "-b", `worker/${slug}`, worktree, "integration"]);
    workers.push({ slug, worktree });
  }
  return { integration, workers };
}

/** What one worker builds: its facet module, its wiring lines and its notes, committed. */
async function buildFacet(worktree: string, slug: string): Promise<string[]> {
  const facet = facetFiles(slug);
  await mkdir(path.join(worktree, "src", "facets"), { recursive: true });
  await writeFile(path.join(worktree, facet.module), facet.source);
  const entry = await readFile(path.join(worktree, MAIN), "utf8");
  await writeFile(path.join(worktree, MAIN), withWiring(entry, facet.wiring));
  await mkdir(path.join(worktree, "docs", "notes"), { recursive: true });
  await writeFile(path.join(worktree, "docs", "notes", `NOTES.${slug}.md`), `# ${slug}\n`);
  await fixtureGit(worktree, ["add", "-A"]);
  await fixtureGit(worktree, ["commit", "-q", "-m", `worker ${slug}`]);
  return facet.wiring;
}

/** The worker's files and diff since the fork, as the hook and the reviewer would read them. */
async function assertOwnsItsWork(worktree: string, slug: string): Promise<void> {
  const spec: ReviewSpec = { id: slug, owns: [`src/facets/${slug}.rs`] };
  const files = (await fixtureGit(worktree, ["diff", "--name-only", "integration", "HEAD"]))
    .split("\n")
    .filter(Boolean);
  assert.ok(files.includes(MAIN), `${slug} wired itself in`);
  for (const file of files) {
    assert.equal(hookAllowedFile(file, spec, false), true, `hook: ${slug} may write ${file}`);
    assert.equal(reviewAllowedFile(file, spec, false), true, `review: ${slug} may write ${file}`);
  }
  const diff = await fixtureGit(worktree, ["diff", "integration", "HEAD", "--", ":(exclude)*.md"]);
  const findings = mechanicalReview(diff, spec, { ownsMain: false, stack: GameStack.RustWgpu });
  assert.deepEqual(findings, [], `${slug}'s review is clean`);
}

/** Integrate one worker's head the way the director does: merge, union-merging the wiring block alone. */
async function integrate(integration: string, slug: string) {
  const ctx = shellCtx();
  const commit = await fixtureGit(integration, ["rev-parse", `worker/${slug}`]);
  const shape = templateShapeFor(["web"], GameStack.RustWgpu);
  assert.equal(shape?.main, MAIN, "the night plans a Rust template with its entry");
  return mergeNoFf(ctx, { cwd: integration }, commit, {
    message: `director: integrate ${slug}`,
    noEdit: true,
    listConflicts: true,
    rpcErrors: "fail",
    resolve: () =>
      unionMergeMain((command) => sh(command, integration), {
        message: `director: integrate ${slug} (union on FACET WIRING)`,
        ...wiringFor(shape, false),
      }),
  });
}

describe("two director workers on a Rust template merge without a conflict", () => {
  for (const order of [
    ["fish", "shop"],
    ["shop", "fish"],
  ] as const) {
    it(`integrates ${order.join(" then ")}: one src/main.rs with both facets' wiring`, {
      skip: POSIX_ONLY,
    }, async () => {
      const slugs = ["fish", "shop"] as const;
      const { integration, workers } = await parallelWorkers(slugs);
      // Both workers build before either is integrated: they forked from the same head.
      const wiring = await Promise.all(workers.map(({ slug, worktree }) => buildFacet(worktree, slug)));
      await Promise.all(workers.map(({ slug, worktree }) => assertOwnsItsWork(worktree, slug)));

      const [first, second] = order;
      const merged1 = await integrate(integration, first);
      assert.equal(merged1.ok, true, JSON.stringify(merged1));
      assert.equal(merged1.ok && merged1.union, false, "the first merge is clean");
      const merged2 = await integrate(integration, second);
      assert.equal(merged2.ok, true, JSON.stringify(merged2));
      assert.equal(
        merged2.ok && merged2.union,
        true,
        "the second meets the first in the wiring block and is union-merged",
      );

      const text = await readFile(path.join(integration, MAIN), "utf8");
      assert.doesNotMatch(text, /^(<{7}|={7}|>{7})/m, "no conflict markers");
      const lines = wiringLines(text);
      assert.deepEqual([...lines].sort(), wiring.flat().sort(), "both facets' two wiring lines, once each");
      assert.ok(installsGenex(text), "the merged entry still hands the game to genex::install");
      for (const slug of slugs)
        assert.ok((await readFile(path.join(integration, "src", "facets", `${slug}.rs`), "utf8")).includes(slug));
      assert.equal(await fixtureGit(integration, ["status", "--porcelain"]), "", "both merges are committed");
      const log = await sh(`git ${STUDIO_AS} log --format=%s -3`, integration);
      assert.match(log.stdout, new RegExp(`integrate ${second} \\(union on FACET WIRING\\)`));
    });
  }
});
