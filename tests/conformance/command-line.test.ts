import { test } from "node:test";
import assert from "node:assert/strict";
import { CommandLineProblem, joinCommandLine, splitCommandLine } from "../../src/shared/command-line.ts";

test("a command line splits into the words Terminal would pass, and nothing is expanded", () => {
  const cases: Array<[string, string[]]> = [
    ["npx -y @modelcontextprotocol/server-github", ["npx", "-y", "@modelcontextprotocol/server-github"]],
    ["  uvx   mcp-server-fetch  ", ["uvx", "mcp-server-fetch"]],
    ["node '/Users/me/My Server/index.js'", ["node", "/Users/me/My Server/index.js"]],
    ['node "/Users/me/My Server/index.js"', ["node", "/Users/me/My Server/index.js"]],
    ["node /Users/me/My\\ Server/index.js", ["node", "/Users/me/My Server/index.js"]],
    ['run --name ""', ["run", "--name", ""]],
    ["run --name ''", ["run", "--name", ""]],
    ['say "a \\"quoted\\" word"', ["say", 'a "quoted" word']],
    ["say 'single \\ stays'", ["say", "single \\ stays"]],
    ["echo $HOME ~ *.js", ["echo", "$HOME", "~", "*.js"]],
    ["a;b | c && d", ["a;b", "|", "c", "&&", "d"]],
    ["--flag=a' 'b", ["--flag=a b"]],
    ["tab\tseparated\nlines", ["tab", "separated", "lines"]],
    ["npx -y \\\n  @scope/pkg", ["npx", "-y", "@scope/pkg"]],
    ['say "wrapped \\\nline"', ["say", "wrapped line"]],
  ];
  for (const [line, words] of cases) {
    const result = splitCommandLine(line);
    assert.deepEqual(result, { ok: true, words }, line);
  }
});

test("an unfinished quote or a trailing backslash is refused, never guessed", () => {
  const cases: Array<[string, CommandLineProblem]> = [
    ["node 'index.js", CommandLineProblem.UnclosedQuote],
    ['node "index.js', CommandLineProblem.UnclosedQuote],
    ["node index.js\\", CommandLineProblem.TrailingBackslash],
  ];
  for (const [line, problem] of cases) assert.deepEqual(splitCommandLine(line), { ok: false, problem }, line);
  assert.deepEqual(splitCommandLine("   "), { ok: true, words: [] });
});

test("joining quotes only what needs it, and splitting the result gives back the same words", () => {
  assert.equal(
    joinCommandLine(["npx", "-y", "@modelcontextprotocol/server-github"]),
    "npx -y @modelcontextprotocol/server-github",
  );
  assert.equal(joinCommandLine(["node", "/Users/me/My Server/index.js"]), "node '/Users/me/My Server/index.js'");
  const awkward = [
    ["node", ""],
    ["it's", "a test"],
    ["$HOME", "~", "*", "a;b", "|"],
    ['say "hi"', "back\\slash", "new\nline", "tab\there"],
    ["--key=value with space", "ünïcode", "''"],
  ];
  for (const words of awkward) assert.deepEqual(splitCommandLine(joinCommandLine(words)), { ok: true, words });
});
