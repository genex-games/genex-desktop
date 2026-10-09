/**
 * The Genex skills Studio vendors: each `SKILL.md` is a Studio preface, a fixed upstream marker and
 * the upstream bytes unchanged. The upstream part must match what `vendor.json` recorded and, for the
 * CLI's cards, the pinned `@genex-ai/cli-demo` Studio ships, so a pin bump without a refresh fails
 * here (`npm run genex:skills` refreshes).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { buildPlugins } from "../../scripts/build-plugins.mjs";
import {
  CARDS_LICENSE,
  GENEX_CARDS,
  GENEX_SKILL,
  type GenexSkillsVendor,
  manifestDisagreements,
  splitVendoredSkill,
} from "../../scripts/refresh-genex-skills.ts";
import { GENEX_GAME_PACKAGES } from "../../src/shared/genex.ts";
import type { PluginManifest } from "../../src/shared/plugins.ts";
import { inspectPackage } from "../../src/substrate/plugins/manifest.ts";
import { tmpDir } from "../helpers/tmp.ts";

const SKILLS = path.resolve("src/plugins/genex/skills");
const require = createRequire(import.meta.url);
const CLI = path.dirname(require.resolve("@genex-ai/cli-demo/package.json"));
const CARDS = path.join(CLI, "templates", "skills");

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const vendor = async (): Promise<GenexSkillsVendor> =>
  JSON.parse(await readFile(path.join(SKILLS, "vendor.json"), "utf8"));

/** Every `.md` file under `dir`, relative to it, sorted. */
async function markdown(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await markdown(full, base)));
    else if (entry.name.endsWith(".md")) out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}

/** The upstream bytes of one vendored file: after the marker for a SKILL.md, the whole file for a reference. */
async function upstreamOf(file: string): Promise<string> {
  const text = await readFile(path.join(SKILLS, file), "utf8");
  return path.basename(file) === "SKILL.md" ? splitVendoredSkill(text).upstream : text;
}

test("the vendored skills track the Genex CLI Studio pins and ships", async () => {
  const pinned = JSON.parse(await readFile("package.json", "utf8")).dependencies["@genex-ai/cli-demo"];
  const installed = JSON.parse(await readFile(path.join(CLI, "package.json"), "utf8")).version;
  const recorded = await vendor();
  assert.equal(recorded.cliVersion, pinned, "vendor.json follows the package.json pin");
  assert.equal(installed, pinned, "node_modules holds the pinned CLI");
  const genex = splitVendoredSkill(await readFile(path.join(SKILLS, GENEX_SKILL, "SKILL.md"), "utf8"));
  assert.match(genex.upstream.split("\n")[2] ?? "", new RegExp(`^version: ${recorded.cliVersion}$`));
  assert.equal(recorded.skillMdVersion, recorded.cliVersion);
});

test("each vendored file's upstream part is what vendor.json recorded, and each card is the pinned CLI's", async () => {
  const recorded = await vendor();
  const expected = [`${GENEX_SKILL}/SKILL.md`];
  for (const card of GENEX_CARDS) expected.push(...(await markdown(path.join(CARDS, card))).map((f) => `${card}/${f}`));
  assert.deepEqual(Object.keys(recorded.files).sort(), expected.sort(), "every card file is vendored, and only those");
  for (const [file, entry] of Object.entries(recorded.files)) {
    const upstream = await upstreamOf(file);
    assert.equal(sha256(upstream), entry.sha256, `${file} upstream bytes changed without a refresh`);
    assert.equal(Buffer.byteLength(upstream), entry.bytes, file);
    if (file.startsWith(`${GENEX_SKILL}/`)) continue;
    assert.equal(upstream, await readFile(path.join(CARDS, file), "utf8"), `${file} matches the pinned CLI`);
  }
});

test("each vendored SKILL.md opens with a Studio preface naming its marker's upstream", async () => {
  const recorded = await vendor();
  for (const skill of [GENEX_SKILL, ...GENEX_CARDS]) {
    const parts = splitVendoredSkill(await readFile(path.join(SKILLS, skill, "SKILL.md"), "utf8"));
    assert.ok(parts.preface.trim().length > 0, `${skill} has a preface`);
    assert.equal(parts.preface, await readFile(path.join(SKILLS, skill, "PREFACE.md"), "utf8"));
    assert.equal(parts.version, recorded.cliVersion, skill);
    assert.equal(parts.sha256, recorded.files[`${skill}/SKILL.md`]?.sha256, skill);
  }
});

test("Studio's multiplayer package pin satisfies the range the multiplayer card asks for", async () => {
  const card = await readFile(path.join(CARDS, "genex-threejs-multiplayer", "SKILL.md"), "utf8");
  const asked = /npm i @genex-ai\/multiplayer@\^(\d+)\.(\d+)\.(\d+)/.exec(card);
  assert.ok(asked, "the card names a caret range");
  const [major, minor, patch] = GENEX_GAME_PACKAGES["@genex-ai/multiplayer"].split(".").map(Number);
  // A caret range below 1.0.0 is minor-locked: same major and minor, patch at least the one asked.
  assert.equal(major, Number(asked[1]));
  assert.equal(minor, Number(asked[2]));
  assert.ok((patch ?? -1) >= Number(asked[3]));
});

test("a Genex payload built without dependencies carries the skills, without prefaces, within the skill caps", async () => {
  const resources = await tmpDir("studio-genex-skills-");
  await buildPlugins(process.cwd(), resources, { dependencies: false });
  const target = path.join(resources, "plugins", "genex");
  await inspectPackage(target);
  const shipped = await markdown(path.join(target, "skills"));
  assert.ok(!shipped.some((f) => path.basename(f) === "PREFACE.md"), "a preface ships only inside its SKILL.md");
  const sources = (await markdown(SKILLS)).filter((f) => path.basename(f) !== "PREFACE.md");
  assert.deepEqual(shipped, sources);
  for (const file of shipped)
    assert.equal(
      await readFile(path.join(target, "skills", file), "utf8"),
      await readFile(path.join(SKILLS, file), "utf8"),
    );
});

test("plugin.json declares every vendored file, and vendors every file it declares", async () => {
  const manifest = JSON.parse(await readFile("src/plugins/genex/plugin.json", "utf8"));
  assert.deepEqual(manifestDisagreements(manifest, Object.keys((await vendor()).files)), []);
});

test("a manifest and a vendored set disagree exactly where a file is on one side only", () => {
  const card = (references?: string[]) =>
    ({
      skills: [
        { name: "card", summary: "A card.", file: "skills/card/SKILL.md", ...(references ? { references } : {}) },
      ],
    }) as Pick<PluginManifest, "skills">;
  const rows: Array<[string, Pick<PluginManifest, "skills">, string[], RegExp[]]> = [
    ["agreeing", card(["skills/card/references/a.md"]), ["card/SKILL.md", "card/references/a.md"], []],
    [
      "a declared reference not vendored",
      card(["skills/card/references/a.md"]),
      ["card/SKILL.md"],
      [/declared but not vendored/],
    ],
    ["a vendored reference not declared", card(), ["card/SKILL.md", "card/references/b.md"], [/vendored but no skill/]],
    ["an inline skill only", { skills: [{ name: "inline", text: "Hi." }] }, [], []],
  ];
  for (const [name, manifest, vendored, expected] of rows) {
    const problems = manifestDisagreements(manifest, vendored);
    assert.equal(problems.length, expected.length, `${name}: ${problems.join("; ")}`);
    expected.forEach((pattern, i) => assert.match(problems[i] ?? "", pattern, name));
  }
});

test("the cards carry the pinned CLI's own MIT license, in the source tree and in every build", async () => {
  const license = await readFile(path.join(CLI, "LICENSE"), "utf8");
  assert.match(license, /^MIT License/);
  assert.equal(await readFile(path.join(SKILLS, CARDS_LICENSE), "utf8"), license);
  assert.equal((await vendor()).license?.sha256, sha256(license));
  const resources = await tmpDir("studio-genex-license-");
  await buildPlugins(process.cwd(), resources, { dependencies: false });
  assert.equal(await readFile(path.join(resources, "plugins", "genex", "skills", CARDS_LICENSE), "utf8"), license);
});
