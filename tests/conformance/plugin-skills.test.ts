/**
 * Plugin skills: the inline `{name,text}` kind and the API 3 file kind (`{name, summary, file,
 * references?}`), the shared helpers both the registry and the planner use, and the manifest and
 * package rules that bound them. Every refused package is also proved untouched: inspecting a
 * package reads it and writes nothing, whatever it declares.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  isFileSkill,
  PLUGIN_SKILL_TOOL,
  PluginHostTool,
  PluginSourceKind,
  type PluginManifest,
  type PluginSkill,
  pluginSkillLine,
  pluginSkillTool,
} from "../../src/shared/plugins.ts";
import { GENEX_GAME_PACKAGES } from "../../src/shared/genex.ts";
import { inspectPackage, pluginSkillDigests, validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { PluginConsentDeclined, PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { copyOfExample, pluginFixture } from "../helpers/plugins.ts";
import { tmpDir } from "../helpers/tmp.ts";

const source = path.resolve("src/plugins/example");
const KIB = 1024;
const exampleManifest: PluginManifest = JSON.parse(await readFile(path.join(source, "plugin.json"), "utf8"));

// biome-ignore lint/suspicious/noExplicitAny: a hostile manifest is any shape a writer may send.
type RawManifest = any;

/** A copy of the bundled example on API 3 with one file skill, edited by `edit`. */
async function withPackage<T>(
  edit: (dir: string, m: RawManifest) => Promise<void> | void,
  body: (dir: string) => Promise<T>,
): Promise<T> {
  const base = await mkdtemp(path.join(os.tmpdir(), "studio-skills-"));
  const dir = path.join(base, "package");
  try {
    await cp(source, dir, { recursive: true });
    await mkdir(path.join(dir, "skills"));
    await writeFile(path.join(dir, "skills", "a.md"), "# A\n\nRead me on demand.\n");
    await writeFile(path.join(dir, "skills", "ref.md"), "reference\n");
    const m = JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf8"));
    m.apiVersion = 3;
    m.skills.push({
      name: "card",
      summary: "A card read on demand.",
      file: "skills/a.md",
      references: ["skills/ref.md"],
    });
    await edit(dir, m);
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify(m, null, 2));
    return await body(dir);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

/** Every entry under `dir` with its kind, size, modification time and content hash. */
async function tree(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of (await readdir(path.join(dir, rel))).sort()) {
    const file = rel ? `${rel}/${entry}` : entry;
    const full = path.join(dir, file);
    const s = await lstat(full);
    if (s.isDirectory()) {
      out.push(`${file}/ ${s.mtimeMs}`, ...(await tree(dir, file)));
      continue;
    }
    const hash = s.isFile()
      ? createHash("sha256")
          .update(await readFile(full))
          .digest("hex")
      : "link";
    out.push(`${file} ${s.size} ${s.mtimeMs} ${hash}`);
  }
  return out;
}

const skill = (m: RawManifest) => m.skills.find((s: RawManifest) => s.name === "card");
const manySkills = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `s${i}`, text: `skill ${i}` }));
const genex = (m: RawManifest) => {
  m.id = "genex";
};
const hostTool = (host: string, confirmation?: string) => ({
  name: "cli",
  description: "Run Studio's Genex CLI.",
  parameters: { type: "object", properties: { args: { type: "string" } } },
  host,
  ...(confirmation ? { confirmation } : {}),
});

/** A hostile package, and the refusal it must produce. */
const HOSTILE: Array<[string, (dir: string, m: RawManifest) => Promise<void> | void, RegExp]> = [
  ["a file climbing out of the package", (_d, m) => void (skill(m).file = "../x.md"), /Invalid plugin path/],
  ["an absolute file", (_d, m) => void (skill(m).file = "/etc/passwd"), /Invalid plugin path/],
  ["a file that is not Markdown", (_d, m) => void (skill(m).file = "skills/a.txt"), /Markdown/],
  ["a file in a dot folder", (_d, m) => void (skill(m).file = ".hidden/a.md"), /dot/],
  ["a reference climbing out", (_d, m) => void (skill(m).references = ["../y.md"]), /Invalid plugin path/],
  ["a reference that is not Markdown", (_d, m) => void (skill(m).references = ["skills/y.json"]), /Markdown/],
  ["a duplicate reference", (_d, m) => void (skill(m).references = ["skills/ref.md", "skills/ref.md"]), /reference/],
  ["a reference repeating the file", (_d, m) => void (skill(m).references = ["skills/a.md"]), /reference/],
  [
    "seventeen references",
    (_d, m) => void (skill(m).references = Array.from({ length: 17 }, (_, i) => `skills/r${i}.md`)),
    /reference/,
  ],
  [
    "a symlinked skill file",
    async (dir) => {
      await rm(path.join(dir, "skills", "a.md"));
      await symlink("/etc/hosts", path.join(dir, "skills", "a.md"));
    },
    /links/,
  ],
  [
    "a missing skill file",
    async (dir) => {
      await rm(path.join(dir, "skills", "a.md"));
    },
    /missing/,
  ],
  [
    "a skill file of 200 KiB",
    async (dir) => {
      await writeFile(path.join(dir, "skills", "a.md"), "x".repeat(200 * KIB));
    },
    /too large/,
  ],
  [
    "skill files totalling more than 1 MiB",
    async (dir, m) => {
      const references: string[] = [];
      for (let i = 0; i < 9; i++) {
        await writeFile(path.join(dir, "skills", `big${i}.md`), "x".repeat(120 * KIB));
        references.push(`skills/big${i}.md`);
      }
      skill(m).references = references;
    },
    /1 MiB/,
  ],
  ["33 skills", (_d, m) => void m.skills.push(...manySkills(32)), /at most 32/],
  ["a duplicate skill name", (_d, m) => void m.skills.push({ name: "card", text: "again" }), /duplicate/i],
  ["an empty skill name", (_d, m) => void m.skills.push({ name: "", text: "nameless" }), /Invalid plugin skill/],
  ["an empty text", (_d, m) => void m.skills.push({ name: "blank", text: "" }), /text/],
  ["a 16,001-character text", (_d, m) => void m.skills.push({ name: "long", text: "x".repeat(16_001) }), /text/],
  ["both text and file", (_d, m) => void (skill(m).text = "inline too"), /text or a file/],
  ["neither text nor file", (_d, m) => void m.skills.push({ name: "empty", summary: "nothing" }), /text or a file/],
  ["an empty summary", (_d, m) => void (skill(m).summary = ""), /summary/],
  ["a 301-character summary", (_d, m) => void (skill(m).summary = "x".repeat(301)), /summary/],
  ["a file skill on API 2", (_d, m) => void (m.apiVersion = 2), /apiVersion 3/],
  [
    "a tool named skill beside a file skill",
    (_d, m) => void m.tools.push({ ...m.tools[0], name: PLUGIN_SKILL_TOOL }),
    /reserved/,
  ],
  ["a host tool on a non-Genex plugin", (_d, m) => void m.tools.push(hostTool(PluginHostTool.GenexCli)), /host/],
  [
    "a paid Genex CLI host tool without confirmation",
    (_d, m) => {
      genex(m);
      m.tools.push(hostTool(PluginHostTool.GenexCliPaid));
    },
    /confirmation/,
  ],
  [
    "a Genex package host tool without confirmation",
    (_d, m) => {
      genex(m);
      m.tools.push(hostTool(PluginHostTool.GenexPackage));
    },
    /confirmation/,
  ],
  [
    "an unknown host",
    (_d, m) => {
      genex(m);
      m.tools.push(hostTool("shell", "Runs anything."));
    },
    /host/,
  ],
];

for (const [name, edit, refusal] of HOSTILE) {
  test(`a package with ${name} is refused and left as it was`, async () => {
    await withPackage(edit, async (dir) => {
      const before = await tree(dir);
      await assert.rejects(inspectPackage(dir), refusal);
      assert.deepEqual(await tree(dir), before, "inspecting a package writes nothing");
    });
  });
}

test("a Genex host tool on API 2 is refused", () => {
  const raw = { ...exampleManifest, id: "genex", tools: [...exampleManifest.tools, hostTool(PluginHostTool.GenexCli)] };
  assert.throws(() => validateManifest(raw), /host/);
});

test("a valid file skill and the bundled Genex host tools keep their canonical form", async () => {
  await withPackage(
    (_d, m) => {
      genex(m);
      m.tools.push(hostTool(PluginHostTool.GenexCli));
      m.tools.push({ ...hostTool(PluginHostTool.GenexCliPaid, "Spends Genex credits."), name: "cli-paid" });
      skill(m).extra = "dropped";
    },
    async (dir) => {
      const m = await inspectPackage(dir);
      assert.deepEqual(m.skills.at(-1), {
        name: "card",
        summary: "A card read on demand.",
        file: "skills/a.md",
        references: ["skills/ref.md"],
      });
      assert.deepEqual(
        m.tools.map((t) => [t.name, t.host, t.confirmation]),
        [
          ["greet", undefined, undefined],
          ["shout", undefined, "The example plugin wants to shout your text back."],
          ["cli", PluginHostTool.GenexCli, undefined],
          ["cli-paid", PluginHostTool.GenexCliPaid, "Spends Genex credits."],
        ],
      );
      assert.deepEqual(m.skills[0], exampleManifest.skills[0], "an inline skill stays {name,text}");
    },
  );
});

/** The skill shapes API 1 and 2 manifests loaded with before skills were checked: all still load. */
const LEGACY_SKILLS = [
  { name: "greeting", text: "Hello.", file: "skills/ignored.md" },
  { name: "blank", text: "" },
  { name: "greeting", text: "Again." },
];
/** The example as an API 1 manifest: that version has no tool confirmation and no toolbar. */
const onApi1 = (m: RawManifest) => {
  m.apiVersion = 1;
  m.tools = m.tools.map(({ confirmation: _asks, ...tool }: RawManifest) => tool);
  delete m.toolbar;
};

test("an API 1 or 2 manifest's skills load as they always did: a stray key ignored, empty text kept, a repeat dropped", () => {
  for (const apiVersion of [1, 2]) {
    const raw: RawManifest = {
      ...structuredClone(exampleManifest),
      apiVersion,
      skills: structuredClone(LEGACY_SKILLS),
    };
    if (apiVersion === 1) onApi1(raw);
    assert.deepEqual(
      validateManifest(raw).skills,
      [
        { name: "greeting", text: "Hello." },
        { name: "blank", text: "" },
      ],
      `API ${apiVersion}`,
    );
  }
});

test("an installed API 1 plugin with those skills is still enabled after a restart", async () => {
  const f = await pluginFixture();
  try {
    const dir = await copyOfExample(f.root, "legacy", (m) => {
      m.id = "legacy";
      onApi1(m);
      m.skills = structuredClone(LEGACY_SKILLS);
    });
    await f.registry.installLocal(dir, PluginSourceKind.Local);
    f.registry.cancel();
    const restarted = new PluginRegistry(f.registry.root, f.seeds, f.registry.bootstrap, async () => ({}));
    await restarted.init();
    const legacy = restarted.list().find((p) => p.manifest.id === "legacy");
    restarted.cancel();
    assert.equal(legacy?.enabled, true);
    assert.equal(legacy?.error, undefined);
  } finally {
    await f.close();
  }
});

test("a tool named skill is an ordinary tool when the plugin has no file skill", () => {
  const m = structuredClone(exampleManifest);
  m.tools.push({ ...m.tools[0], name: PLUGIN_SKILL_TOOL });
  assert.equal(validateManifest(m).tools.at(-1)?.name, PLUGIN_SKILL_TOOL);
});

test("skill digests follow the bytes of the text, the file and every reference", async () => {
  const digests = async (edit: (dir: string, m: RawManifest) => Promise<void> | void) =>
    withPackage(edit, async (dir) => pluginSkillDigests(dir, await inspectPackage(dir)));
  const base = await digests(() => {});
  assert.deepEqual(Object.keys(base).sort(), ["card", "greeting"]);
  assert.ok(Object.values(base).every((d) => /^[0-9a-f]{64}$/.test(d)));
  assert.deepEqual(await digests(() => {}), base, "the same bytes give the same digests");
  const reference = await digests((dir) => writeFile(path.join(dir, "skills", "ref.md"), "changed\n"));
  assert.notEqual(reference.card, base.card, "a changed reference changes its skill's digest");
  assert.equal(reference.greeting, base.greeting);
  const text = await digests((_d, m) => void (m.skills[0].text = `${m.skills[0].text} More.`));
  assert.notEqual(text.greeting, base.greeting);
  assert.equal(text.card, base.card);
});

test("a skill's line is its summary, or the first line of its text", () => {
  const inline: PluginSkill = { name: "a", text: "\n  First line.  \nSecond line." };
  const file: PluginSkill = { name: "b", summary: "Read on demand.", file: "skills/b.md" };
  assert.equal(isFileSkill(inline), false);
  assert.equal(isFileSkill(file), true);
  assert.equal(pluginSkillLine(inline), "First line.");
  assert.equal(pluginSkillLine(file), "Read on demand.");
  assert.equal(pluginSkillLine({ name: "c", text: "" }), "");
});

test("the synthetic skill tool exists only for a plugin with file skills and names them", () => {
  assert.equal(pluginSkillTool(exampleManifest), undefined);
  const m: PluginManifest = {
    ...exampleManifest,
    apiVersion: 3,
    skills: [
      ...exampleManifest.skills,
      { name: "card", summary: "A card.", file: "skills/a.md", references: ["skills/r.md"] },
      { name: "other", summary: "Another.", file: "skills/o.md" },
    ],
  };
  const tool = pluginSkillTool(m);
  assert.ok(tool);
  assert.equal(tool.name, `example__${PLUGIN_SKILL_TOOL}`);
  assert.equal(tool.confirmation, undefined, "reading a skill needs no consent");
  assert.deepEqual(tool.parameters.required, ["name"]);
  assert.deepEqual(
    Object.entries(tool.parameters.properties).map(([key, spec]) => [key, spec.type]),
    [
      ["name", "string"],
      ["file", "string"],
      ["offset", "number"],
    ],
  );
  assert.match(tool.description, /card/);
  assert.match(tool.description, /other/);
  assert.doesNotMatch(tool.description, /greeting/, "an inline skill is already in the brief");
});

test("the Genex game packages are exact pins", () => {
  assert.deepEqual(Object.keys(GENEX_GAME_PACKAGES).sort(), ["@genex-ai/embed-sdk", "@genex-ai/multiplayer"]);
  for (const version of Object.values(GENEX_GAME_PACKAGES)) assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.match(GENEX_GAME_PACKAGES["@genex-ai/multiplayer"], /^0\.16\.\d+$/, "the multiplayer card asks for ^0.16.0");
});

// ── The registry serves file skills ─────────────────────────────────────────────────────────────

/** A line only the card's body holds: guidance and facts must never carry it. */
const BODY_SENTINEL = "CARD-BODY-SENTINEL-7f3a";
const CARD_BODY = `# Card\n\n${BODY_SENTINEL}\nRead the reference for details.\n`;
const REFERENCE_BODY = "# Reference\n\nThe details.\n";

/**
 * A registry with the bundled example and a local `fixture` plugin on API 3: one inline skill
 * (`greeting`, from the example) and one file skill (`card`) with one reference. `skills/other.md`
 * sits in the package but no skill declares it.
 */
async function skillRegistry(edit?: (dir: string, m: RawManifest) => Promise<void> | void) {
  const f = await pluginFixture();
  const dir = await copyOfExample(f.root, "fixture-source", (m) => {
    m.id = "fixture";
    m.name = "Fixture";
    m.apiVersion = 3;
    m.skills.push({
      name: "card",
      summary: "A card read on demand.",
      file: "skills/a.md",
      references: ["skills/ref.md"],
    });
  });
  await mkdir(path.join(dir, "skills"));
  await writeFile(path.join(dir, "skills", "a.md"), CARD_BODY);
  await writeFile(path.join(dir, "skills", "ref.md"), REFERENCE_BODY);
  await writeFile(path.join(dir, "skills", "other.md"), "undeclared\n");
  if (edit) {
    const m = JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf8"));
    await edit(dir, m);
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify(m));
  }
  await f.registry.installLocal(dir, PluginSourceKind.Local);
  const game = path.join(f.root, "game");
  await mkdir(game);
  return { ...f, source: dir, binding: { project: "game", directory: game } };
}

/** The one package copy the registry installed for `id`. */
async function installedCopy(registry: PluginRegistry, id: string): Promise<string> {
  const base = path.join(registry.root, "packages", id);
  const [copy] = await readdir(base);
  assert.ok(copy, `an installed copy of ${id}`);
  return path.join(base, copy);
}

test("guidance indexes a file skill by its summary and the tool that reads it, never its body", async () => {
  const f = await skillRegistry();
  try {
    const guidance = f.registry.guidance();
    assert.match(guidance, /\[fixture\/card\] A card read on demand\. Read it with fixture__skill \{"name":"card"\}/);
    assert.match(guidance, /\[fixture\/greeting\]\nUse example__greet/, "an inline skill is still joined whole");
    assert.doesNotMatch(guidance, new RegExp(BODY_SENTINEL));
  } finally {
    await f.close();
  }
});

test("one snapshot carries the tools, the guidance and the applied set, and no tool carries a host", async () => {
  const f = await skillRegistry();
  try {
    const snapshot = f.registry.snapshot();
    const names = snapshot.tools.map((t) => t.name);
    assert.ok(names.includes("fixture__skill"), names.join(", "));
    assert.ok(!names.includes("example__skill"), "a plugin with no file skill has no skill tool");
    assert.ok(snapshot.tools.every((t) => !Object.hasOwn(t, "host")));
    assert.equal(snapshot.guidance, f.registry.guidance());
    assert.deepEqual(snapshot.tools, f.registry.tools());
    assert.deepEqual(snapshot.applied, {
      plugins: ["example", "fixture"],
      skills: ["example/greeting", "fixture/greeting", "fixture/card"],
    });
  } finally {
    await f.close();
  }
});

test("the skill tool reads the declared file and each declared reference, in the host", async () => {
  const f = await skillRegistry();
  try {
    const card = await f.registry.tool("fixture__skill", { name: "card" }, f.binding);
    assert.deepEqual(card, {
      plugin: "fixture",
      skill: "card",
      file: "skills/a.md",
      references: ["skills/ref.md"],
      text: CARD_BODY,
      offset: 0,
    });
    const reference = await f.registry.tool("fixture__skill", { name: "card", file: "skills/ref.md" }, f.binding);
    assert.equal((reference as { text: string }).text, REFERENCE_BODY);
    assert.equal((reference as { file: string }).file, "skills/ref.md");
  } finally {
    await f.close();
  }
});

/** A skill read that must be refused with its reason, and leave the game and the package as they were. */
const LISTED = /exactly as listed/;
const HOSTILE_READS: Array<[string, Record<string, unknown>, RegExp, ((copy: string) => Promise<void>)?]> = [
  ["the manifest", { name: "card", file: "plugin.json" }, LISTED],
  ["the backend through a declared folder", { name: "card", file: "skills/../backend.mjs" }, LISTED],
  ["a dotted spelling of the declared file", { name: "card", file: "skills/./a.md" }, LISTED],
  ["an undeclared file in the package", { name: "card", file: "skills/other.md" }, LISTED],
  ["an absolute path", { name: "card", file: "/etc/hosts" }, LISTED],
  ["an unknown skill", { name: "nothing" }, /no skill named "nothing"/],
  ["an inline skill", { name: "greeting" }, /no skill named "greeting"/],
  ["a skill name that is not text", { name: 7 }, /Invalid tool input: name/],
  ["no skill name", {}, /Missing name/],
  ["an undeclared argument", { name: "card", path: "backend.mjs" }, /Invalid tool input: path/],
  ["a negative offset", { name: "card", offset: -1 }, /offset/],
  ["a fractional offset", { name: "card", offset: 1.5 }, /offset/],
  ["an offset past the end", { name: "card", offset: CARD_BODY.length + 1 }, /offset/],
  [
    "a declared file swapped for a link after install",
    { name: "card" },
    /escapes/,
    async (copy) => {
      await rm(path.join(copy, "skills", "a.md"));
      const outside = path.join(await tmpDir("plugin-skill-escape-"), "private.txt");
      await writeFile(outside, "synthetic host-only file");
      await symlink(outside, path.join(copy, "skills", "a.md"));
    },
  ],
  [
    "a declared file grown past its cap after install",
    { name: "card" },
    /too large/,
    (copy) => writeFile(path.join(copy, "skills", "a.md"), "x".repeat(129 * KIB)),
  ],
];

for (const [name, args, refusal, tamper] of HOSTILE_READS) {
  test(`a skill read of ${name} is refused and writes nothing`, async () => {
    const f = await skillRegistry();
    try {
      const copy = await installedCopy(f.registry, "fixture");
      await tamper?.(copy);
      const before = [await tree(f.binding.directory), await tree(copy)];
      await assert.rejects(f.registry.tool("fixture__skill", args, f.binding), refusal);
      assert.deepEqual([await tree(f.binding.directory), await tree(copy)], before);
      for (const entry of [".claude", ".agents", "AGENTS.md"])
        await assert.rejects(lstat(path.join(f.binding.directory, entry)), { code: "ENOENT" });
    } finally {
      await f.close();
    }
  });
}

test("a long skill file is read in pages that join back to the whole file", async () => {
  const long = Array.from({ length: 3_000 }, (_, i) => `line ${i} of a long card\n`).join("");
  const f = await skillRegistry((dir) => writeFile(path.join(dir, "skills", "a.md"), long));
  try {
    let text = "";
    let offset: number | undefined = 0;
    let pages = 0;
    while (offset !== undefined) {
      const page = (await f.registry.tool("fixture__skill", { name: "card", offset }, f.binding)) as {
        text: string;
        offset: number;
        nextOffset?: number;
      };
      assert.equal(page.offset, offset);
      assert.ok(page.text.length <= 24_000, `a page is at most 24,000 characters (${page.text.length})`);
      text += page.text;
      offset = page.nextOffset;
      pages++;
    }
    assert.equal(text, long);
    assert.equal(pages, Math.ceil(long.length / 24_000));
  } finally {
    await f.close();
  }
});

test("a disabled plugin's skills leave the brief and its skill tool answers nothing", async () => {
  const f = await skillRegistry();
  try {
    await f.registry.setEnabled("fixture", false);
    await assert.rejects(
      f.registry.tool("fixture__skill", { name: "card" }, f.binding),
      /Plugin fixture is unavailable/,
    );
    assert.doesNotMatch(f.registry.guidance(), /\[fixture\//);
    assert.ok(!f.registry.tools().some((t) => t.name.startsWith("fixture__")));
    assert.deepEqual(f.registry.snapshot().applied, { plugins: ["example"], skills: ["example/greeting"] });
  } finally {
    await f.close();
  }
});

test("the Skills page reads a skill's text for installed plugins, disabled ones included, and never a removed one", async () => {
  const f = await skillRegistry();
  try {
    assert.equal(await f.registry.skillText("fixture", "card"), CARD_BODY);
    assert.equal(await f.registry.skillText("fixture", "card", "skills/ref.md"), REFERENCE_BODY);
    assert.match(await f.registry.skillText("fixture", "greeting"), /^Use example__greet/);
    await f.registry.setEnabled("fixture", false);
    assert.equal(await f.registry.skillText("fixture", "card"), CARD_BODY, "a disabled plugin is still listed");
    await assert.rejects(f.registry.skillText("fixture", "card", "skills/other.md"));
    await assert.rejects(f.registry.skillText("fixture", "greeting", "skills/ref.md"));
    await assert.rejects(f.registry.skillText("fixture", "nothing"));
    await f.registry.remove("fixture");
    await assert.rejects(f.registry.skillText("fixture", "card"));
    await assert.rejects(f.registry.skillText("nobody", "card"));
  } finally {
    await f.close();
  }
});

/** A local package that takes the Genex id with a host tool: a package from a folder, whatever its id. */
async function genexHostPackage(root: string) {
  return copyOfExample(root, "genex-host", (m) => {
    m.id = "genex";
    m.name = "Genex";
    m.apiVersion = 3;
    m.tools.push(hostTool(PluginHostTool.GenexCli));
    m.tools.push({ ...hostTool(PluginHostTool.GenexCliPaid, "Spends Genex credits."), name: "cli-paid" });
  });
}

test("a host tool from a local folder never reaches the host hook, whatever its id", async () => {
  const f = await pluginFixture();
  try {
    const calls: unknown[] = [];
    f.registry.hostTool = async (...args) => calls.push(args);
    await f.registry.installLocal(await genexHostPackage(f.root), PluginSourceKind.Local);
    assert.ok(
      f.registry.tools().every((t) => !Object.hasOwn(t, "host")),
      "the agent never sees host",
    );
    await assert.rejects(f.registry.tool("genex__cli", { args: "doctor" }, f.binding), /bundled/);
    assert.deepEqual(calls, []);
  } finally {
    await f.close();
  }
});

test("a bundled host tool runs through the host hook after consent, and fails closed without a hook", async () => {
  const f = await pluginFixture();
  try {
    const calls: unknown[][] = [];
    f.registry.hostTool = async (...args) => {
      calls.push(args.slice(0, 4));
      return { ran: args[1] };
    };
    await f.registry.installLocal(await genexHostPackage(f.root), PluginSourceKind.Bundled);
    assert.ok(
      f.registry.tools().every((t) => !Object.hasOwn(t, "host")),
      "the agent never sees host",
    );
    assert.deepEqual(await f.registry.tool("genex__cli", { args: "doctor" }, f.binding), {
      ran: PluginHostTool.GenexCli,
    });
    assert.deepEqual(calls, [["genex", PluginHostTool.GenexCli, { args: "doctor" }, f.binding]]);

    f.registry.consent = async () => ({ approved: false, by: "user" });
    f.registry.hostToolConsent = (_id, _host, args) => args;
    await assert.rejects(f.registry.tool("genex__cli-paid", { args: "llm bench" }, f.binding), PluginConsentDeclined);
    assert.equal(calls.length, 1, "a declined paid tool never runs");

    f.registry.hostTool = undefined;
    await assert.rejects(f.registry.tool("genex__cli", { args: "doctor" }, f.binding), /unavailable/i);
  } finally {
    await f.close();
  }
});

test("a consented host tool asks about the call as the host describes it, and asks nobody about one it refuses", async () => {
  const f = await pluginFixture();
  try {
    const asked: unknown[] = [];
    const ran: unknown[] = [];
    f.registry.hostTool = async (...args) => ran.push(args);
    f.registry.hostToolConsent = (_id, host, args) => {
      if (args.args === "refused") throw new Error("refused by the host");
      return { host, shown: "by Studio" };
    };
    f.registry.consent = async (_id, _tool, args) => {
      asked.push(args);
      return { approved: true, by: "user" };
    };
    await f.registry.installLocal(await genexHostPackage(f.root), PluginSourceKind.Bundled);
    await f.registry.tool("genex__cli-paid", { args: "llm bench" }, f.binding);
    assert.deepEqual(asked, [{ host: PluginHostTool.GenexCliPaid, shown: "by Studio" }]);

    await assert.rejects(f.registry.tool("genex__cli-paid", { args: "refused" }, f.binding), /refused by the host/);
    f.registry.hostToolConsent = undefined;
    await assert.rejects(f.registry.tool("genex__cli-paid", { args: "llm bench" }, f.binding), /unavailable/i);
    assert.equal(asked.length, 1, "a refused or undescribed call asks nobody");
    assert.equal(ran.length, 1, "and never runs");
  } finally {
    await f.close();
  }
});

test("a host credential file is served only for a live plugin, and only once its account is unlocked", async () => {
  const f = await pluginFixture();
  try {
    assert.equal(await f.registry.hostCredentialFile("example"), undefined, "no unlock, no credential");
    await f.registry.setEnabled("example", false);
    await assert.rejects(f.registry.hostCredentialFile("example"), /unavailable/);
    await assert.rejects(f.registry.hostCredentialFile("nobody"), /unavailable/);
  } finally {
    await f.close();
  }
});
