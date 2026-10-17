/**
 * The Genex CLI follower (`scripts/follow-genex-cli.ts`): which npm versions count as newer, the
 * plugin's patch bump, and that every hand-maintained version mention still holds today's pins, so a
 * reworded file fails here on its own pull request instead of on the next unattended bump.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isNewer, nextPatch, rewriteMention, VERSION_MENTIONS } from "../../scripts/follow-genex-cli.ts";

test("only a strictly higher x.y.z counts as newer", () => {
  const cases: [string, string, boolean][] = [
    ["1.36.5", "1.36.4", true],
    ["1.37.0", "1.36.9", true],
    ["2.0.0", "1.99.99", true],
    ["1.36.10", "1.36.9", true],
    ["1.36.4", "1.36.4", false],
    ["1.36.3", "1.36.4", false],
    ["1.35.99", "1.36.0", false],
  ];
  for (const [candidate, current, expected] of cases) {
    assert.equal(isNewer(candidate, current), expected, `${candidate} vs ${current}`);
  }
});

test("a prerelease or malformed version is refused rather than compared", () => {
  for (const bad of ["1.37.0-beta.1", "1.37", "v1.37.0", ""]) {
    assert.throws(() => isNewer(bad, "1.36.4"), /plain x\.y\.z/);
  }
});

test("the plugin moves one patch version per bump", () => {
  assert.equal(nextPatch("1.6.4"), "1.6.5");
  assert.equal(nextPatch("1.9.9"), "1.9.10");
});

test("a mention rewrites every occurrence and refuses a file whose wording moved", () => {
  const mention = { file: "x.md", pattern: "(v{v})", of: "cli" } as const;
  assert.equal(rewriteMention("a (v1.0.0) b (v1.0.0)", mention, "1.0.0", "1.0.1"), "a (v1.0.1) b (v1.0.1)");
  assert.throws(() => rewriteMention("a v1.0.0", mention, "1.0.0", "1.0.1"), /x\.md: no longer contains/);
});

test("every version mention holds today's pinned CLI and plugin versions", async () => {
  const cli = JSON.parse(await readFile("package.json", "utf8")).dependencies["@genex-ai/cli-demo"];
  const plugin = JSON.parse(await readFile("src/plugins/genex/plugin.json", "utf8")).version;
  for (const mention of VERSION_MENTIONS) {
    const text = await readFile(mention.file, "utf8");
    const version = mention.of === "cli" ? cli : plugin;
    assert.doesNotThrow(() => rewriteMention(text, mention, version, "9.9.9"), mention.file);
  }
});
