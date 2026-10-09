/**
 * Every git command line the harness runs is built in `loop/git.ts` (with `repo.ts` naming the
 * studio's refs and committer, and `shell.ts` quoting): one place checks the hashes, quotes the
 * messages and writes only the studio's own refs. Four drifted copies of the helper once lived in
 * the director, the classic pipeline, the facet loop and the spike.
 *
 * The seed is scanned as data — its string and template literals, parsed, never matched as source
 * text — for a literal that starts a git command or chains one after a shell operator. Prose that
 * NAMES a git command for a model ("run `git merge <sha>` in your worktree") is not a command
 * line and is not flagged.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import ts from "@typescript/typescript6";

const seedRoot = path.resolve("src/harness-seed");
/**
 * Where git command lines may be written. Flipped: the worker pool owns its one read-only command
 * (`changedSince`, its hash checked by `shell.ts`) and the game folder's fingerprint, written through
 * a throwaway index (`game-change.ts`), because a shipped `git.ts` may gain no key another module
 * reads: an in-app agent's kept older copy would lack it.
 */
const OWNERS = new Set([
  "loop/git.ts",
  "loop/repo.ts",
  "loop/shell.ts",
  "loop/workers/pool-merge.ts",
  "loop/workers/game-change.ts",
]);
/** A git subcommand (or the global options the harness puts before one). */
const SUBCOMMAND = String.raw`(?:-c\s|--no-optional-locks\b|\$\{|(?:add|am|apply|bisect|blame|branch|cat-file|checkout|cherry-pick|clean|clone|commit|config|diff|fetch|for-each-ref|init|log|ls-files|ls-tree|merge|merge-base|merge-file|mv|pull|push|rebase|reset|restore|rev-list|rev-parse|revert|rm|show|show-ref|stash|status|switch|tag|update-index|update-ref|worktree|write-tree)\b)`;
/**
 * A command line: `git <subcommand>` at the start of a literal chunk, after `&&`, `||`, `;`, `|`,
 * `{` or a command substitution's `$(`, and after environment assignments (`GIT_INDEX_FILE=… git`)
 * — or a chunk that ends on `git ` right before a template's interpolation (`git ${AS} …`).
 */
const COMMAND = new RegExp(
  String.raw`(?:^|&&|\|\||[;|{]|\$\()\s*(?:[A-Z_][A-Z0-9_]*=\S+\s+)*git(?:\s+${SUBCOMMAND}|\s*$)`,
);

const seedModules = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? seedModules(full) : entry.name.endsWith(".ts") ? [full] : [];
  });

/** The text of every string and template literal in a module, one entry per chunk a template splits into. */
function literalChunks(file: string, text: string): Array<{ line: number; text: string }> {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const out: Array<{ line: number; text: string }> = [];
  const at = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      out.push({ line: at(node), text: node.text });
    else if (ts.isTemplateExpression(node)) {
      out.push({ line: at(node), text: node.head.text });
      for (const span of node.templateSpans) out.push({ line: at(span.literal), text: span.literal.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** git command lines written outside the owners, as `file:line  literal`. */
function strayCommands(modules: Array<{ rel: string; text: string }>): string[] {
  return modules
    .filter(({ rel }) => !OWNERS.has(rel))
    .flatMap(({ rel, text }) =>
      literalChunks(rel, text)
        .filter((chunk) => COMMAND.test(chunk.text))
        .map((chunk) => `${rel}:${chunk.line}  ${chunk.text.slice(0, 80)}`),
    );
}

const readSeed = (files: string[]) =>
  files.map((file) => ({
    rel: path.relative(seedRoot, file).split(path.sep).join("/"),
    text: readFileSync(file, "utf8"),
  }));

describe("git command lines in the harness seed", () => {
  it("are written only in loop/git.ts (and the repo and shell helpers it builds on)", () => {
    const modules = readSeed(seedModules(seedRoot));
    assert.ok(
      modules.some(({ rel }) => rel === "loop/git.ts"),
      "the scan reads the seed it means to",
    );
    assert.deepEqual(strayCommands(modules), []);
  });

  it("tells a command line from prose that names one", () => {
    const module = (text: string) => [{ rel: "loop/x.ts", text }];
    for (const line of [
      'run("git rev-parse HEAD")',
      "run(`git ${AS} commit -q -m ${m}`)",
      'run(`T=x && mkdir -p "$T" && git show ${a}`)',
      "run(`printf x | base64 -d > f && git add -- f`)",
      'run("git add -A && (git diff --cached --quiet || git commit)")',
      'run(`i="$(git rev-parse --git-path ${name})"`)',
      'run(`cp a b; GIT_INDEX_FILE="$i" git write-tree`)',
      "run(`x && { git add -A; }`)",
    ]) {
      assert.equal(strayCommands(module(line)).length, 1, line);
    }
    for (const prose of [
      'say("Never git push, never edit outside this worktree.")',
      "say(`run \\`git merge ${sha}\\` in your worktree, then \\`git add -A\\` and \\`git commit\\``)",
      'say("a git worktree of the game")',
      'say("fix it in your worktree (git log shows what came in)")',
      "fail(`git failed in facet ${id}: ${command}`)",
      "// git reset --hard\nconst x = 1;",
    ]) {
      assert.deepEqual(strayCommands(module(prose)), [], prose);
    }
  });
});
