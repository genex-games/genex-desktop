/**
 * The Genex skills Studio vendors: each `SKILL.md` is a Studio preface, a fixed upstream marker and
 * the upstream bytes unchanged. The upstream part must match what `vendor.json` recorded and, for the
 * CLI's cards, the pinned `@genex-ai/cli-demo` Studio ships, so a pin bump without a refresh fails
 * here (`npm run genex:skills` refreshes). A card vendored ahead of the pin, from a CLI release not
 * on npm yet, names that newer version and says to re-vendor it; once the pin reaches that version,
 * it fails here until the refresh takes it from the published CLI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { buildPlugins } from "../../scripts/build-plugins.mjs";
import {
  CARDS_LICENSE,
  GENEX_CARDS,
  GENEX_SKILL,
  declareVendoredReferences,
  type GenexSkillsVendor,
  isAheadOf,
  manifestDisagreements,
  splitVendoredSkill,
  writeManifest,
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
    else if (entry.name.endsWith(".md")) out.push(path.relative(base, full));
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

/** Whether a card was vendored ahead of the pin: its SKILL.md names a CLI version of its own. */
const aheadCard = (recorded: GenexSkillsVendor, card: string): boolean =>
  recorded.files[`${card}/SKILL.md`]?.version !== undefined;

test("each vendored file's upstream part is what vendor.json recorded, and each card is the pinned CLI's", async () => {
  const recorded = await vendor();
  const expected = [`${GENEX_SKILL}/SKILL.md`];
  for (const card of GENEX_CARDS) {
    if (aheadCard(recorded, card))
      expected.push(...Object.keys(recorded.files).filter((file) => file.startsWith(`${card}/`)));
    else expected.push(...(await markdown(path.join(CARDS, card))).map((f) => `${card}/${f}`));
  }
  assert.deepEqual(Object.keys(recorded.files).sort(), expected.sort(), "every card file is vendored, and only those");
  for (const [file, entry] of Object.entries(recorded.files)) {
    const upstream = await upstreamOf(file);
    assert.equal(sha256(upstream), entry.sha256, `${file} upstream bytes changed without a refresh`);
    assert.equal(Buffer.byteLength(upstream), entry.bytes, file);
    if (file.startsWith(`${GENEX_SKILL}/`)) continue;
    if (entry.version !== undefined) continue;
    assert.equal(upstream, await readFile(path.join(CARDS, file), "utf8"), `${file} matches the pinned CLI`);
  }
});

test("a card vendored ahead of the pin names a newer CLI, and says to take it from the published one", async () => {
  const recorded = await vendor();
  const ahead = Object.entries(recorded.files).filter(([, entry]) => entry.version !== undefined);
  for (const [file, entry] of ahead) {
    assert.ok(
      isAheadOf(entry.version ?? "", recorded.cliVersion),
      `${file} is vendored from ${entry.version}, which the pin ${recorded.cliVersion} has reached: run npm run genex:skills`,
    );
    assert.match(entry.pending ?? "", /re-vendor/i, `${file} says to re-vendor it once that CLI is published`);
    const card = file.split("/")[0] ?? "";
    for (const [other, sibling] of Object.entries(recorded.files))
      if (other.startsWith(`${card}/`))
        assert.equal(sibling.version, entry.version, `${other} comes from the same CLI`);
  }
});

test("a version is ahead of the pin only when it is newer", () => {
  const rows: Array<[string, string, boolean]> = [
    ["1.36.14", "1.36.13", true],
    ["1.37.0", "1.36.13", true],
    ["2.0.0", "1.99.99", true],
    ["1.36.13", "1.36.13", false],
    ["1.36.12", "1.36.13", false],
    ["1.36.14-beta", "1.36.13", false],
    ["", "1.36.13", false],
  ];
  for (const [version, pinned, ahead] of rows)
    assert.equal(isAheadOf(version, pinned), ahead, `${version} vs ${pinned}`);
});

test("each vendored SKILL.md opens with a Studio preface naming its marker's upstream", async () => {
  const recorded = await vendor();
  for (const skill of [GENEX_SKILL, ...GENEX_CARDS]) {
    const parts = splitVendoredSkill(await readFile(path.join(SKILLS, skill, "SKILL.md"), "utf8"));
    assert.ok(parts.preface.trim().length > 0, `${skill} has a preface`);
    assert.equal(parts.preface, await readFile(path.join(SKILLS, skill, "PREFACE.md"), "utf8"));
    const entry = recorded.files[`${skill}/SKILL.md`];
    assert.equal(parts.version, entry?.version ?? recorded.cliVersion, skill);
    assert.equal(parts.sha256, entry?.sha256, skill);
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

test("Studio's embed SDK pin is at least the version the monetization card's payments require", async () => {
  const card = await readFile(path.join(CARDS, "genex-monetization", "SKILL.md"), "utf8");
  const asked = /Requires `@genex-ai\/embed-sdk` \*\*>= (\d+)\.(\d+)\.(\d+)\*\*/.exec(card);
  assert.ok(asked, "the card names the minimum embed SDK");
  const pinned = GENEX_GAME_PACKAGES["@genex-ai/embed-sdk"].split(".").map(Number);
  const minimum = asked.slice(1).map(Number);
  const order = pinned.map((part, i) => part - (minimum[i] ?? 0)).find((difference) => difference !== 0) ?? 0;
  assert.ok(order >= 0, `Studio pins ${pinned.join(".")}; the card needs ${minimum.join(".")}`);
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
    [
      "a skill Studio writes itself",
      { skills: [{ name: "plugin-author", summary: "Studio's.", file: "skills/plugin-author/SKILL.md" }] },
      [],
      [],
    ],
  ];
  for (const [name, manifest, vendored, expected] of rows) {
    const problems = manifestDisagreements(manifest, vendored);
    assert.equal(problems.length, expected.length, `${name}: ${problems.join("; ")}`);
    expected.forEach((pattern, i) => assert.match(problems[i] ?? "", pattern, name));
  }
});

test("a refresh declares exactly the references it vendored, keeping the declared ones in order", () => {
  const skill = (name: string, references?: string[]) => ({
    name,
    summary: `${name}.`,
    file: `skills/${name}/SKILL.md`,
    ...(references ? { references } : {}),
  });
  const manifest = {
    skills: [
      skill("grown", ["skills/grown/references/b.md"]),
      skill("shrunk", ["skills/shrunk/references/gone.md"]),
      skill("plain"),
      { name: "inline", text: "Hi." },
      skill("plugin-author", ["skills/plugin-author/references/own.md"]),
    ],
  } as Pick<PluginManifest, "skills">;
  const vendored = [
    "grown/SKILL.md",
    "grown/references/c.md",
    "grown/references/a.md",
    "grown/references/b.md",
    "shrunk/SKILL.md",
    "plain/SKILL.md",
  ];
  const declared = declareVendoredReferences(manifest, vendored);
  assert.deepEqual(declared.skills, [
    skill("grown", ["skills/grown/references/b.md", "skills/grown/references/a.md", "skills/grown/references/c.md"]),
    skill("shrunk"),
    skill("plain"),
    { name: "inline", text: "Hi." },
    skill("plugin-author", ["skills/plugin-author/references/own.md"]),
  ]);
  assert.deepEqual(manifestDisagreements(declared, vendored), []);
  assert.deepEqual(manifest.skills[0], skill("grown", ["skills/grown/references/b.md"]), "the input is not changed");
});

test("plugin.json written back by a script keeps the repository's formatting", async () => {
  const dir = await tmpDir("studio-genex-manifest-");
  const file = path.join(dir, "plugin.json");
  await copyFile("src/plugins/genex/plugin.json", file);
  const text = await readFile(file, "utf8");
  await writeManifest(process.cwd(), file, JSON.parse(text));
  assert.equal(await readFile(file, "utf8"), text);
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
