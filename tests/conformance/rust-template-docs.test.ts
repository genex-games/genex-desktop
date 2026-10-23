/**
 * The Rust game template's agent-facing docs (`src/game-template-rust/CLAUDE.md`,
 * `docs/CONTRACT.md`, the facade reference `docs/GENEX_API.md` and its topic pages `docs/api/*.md`)
 * agree with the contract they describe: every verb and refusal code the contract page names is in
 * the shared vocabularies (and every host verb is named), the reference lists exactly the native
 * features, input kinds and touch phases the app knows, its determinism rules cover what the lane's
 * lint file refuses, the reference is a short index whose topic pages it lists, the facade crate's
 * copy of the index and of every page is byte-equal to the template's, the docs link only to files
 * the folder has, and neither the docs nor the template leak a pinned eval brief to the in-app
 * agent. The Rust eval case is a draft in `evals/cases.md` that never names the stack.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { findLeaks, isolationInputs } from "../../scripts/evals/check-isolation.ts";
import { caseById, readCases } from "../../scripts/evals/cases.ts";
import { CaseMode } from "../../scripts/evals/vocabulary.ts";
import { PageMethod } from "../../src/harness-seed/loop/page-contract.ts";
import {
  NativeEnhancedFeature,
  NativeGpuTier,
  NativeInputKind,
  NativeOp,
  NativeOpError,
  NativeRefusal,
} from "../../src/shared/native-contract.ts";
import { GameStack } from "../../src/shared/game-project.ts";
import { TouchPhase } from "../../src/shared/preview-contract.ts";
import {
  DegradeReason,
  DeviceClass,
  ExposureMode,
  LookKey,
  Metering,
  QualityKey,
  QualityPreset,
  RenderFeature,
  RenderInput,
  RenderSettingsRefusal,
  RenderTomlKey,
  ShadowTomlKey,
  Tonemapper,
} from "../../src/shared/render-quality.ts";
import { RustStageCode } from "../../src/main/rust-stage.ts";
import {
  isTable,
  parseGenexToml,
  parseTomlDocument,
  TomlFloat,
  type TomlTable,
  type TomlValue,
} from "../../src/substrate/genex-toml.ts";
import { GameWorkspaces } from "../../src/substrate/game-workspace.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TEMPLATE = path.join(REPO, "src", "game-template-rust");
const FACADE_ROOT = path.join(REPO, "native", "genex-rust");
/** The reference's index, the same path in the template and in the facade crate. */
const API_INDEX = "docs/GENEX_API.md";
/** The folder of the reference's topic pages, beside the index in both trees. */
const API_PAGES = "docs/api";
/** The most words the index may take: the hooks and the rules, with every other topic on its own page. */
const INDEX_WORDS_MAX = 2000;
const LANE_LINTS = path.join(REPO, "native", "genex-rust", "clippy.toml");
const RUST_CASE_ID = "touch-physics";

/** Words a user's brief never uses and the eval case must not name: the stack is the product's choice. */
const STACK_WORDS = /\b(rust|wgpu|webgpu|genex|rapier|egui|cargo)\b/i;

/**
 * The `window.__studio` names the web shell adds beside the harness's `PageMethod` verbs (the page
 * shapes of the C++ shell), and the frame profile and crash records it binds (PROF-4, CRASH-3).
 */
const PAGE_ONLY_VERBS = [
  "version",
  "state",
  "input",
  "injectInput",
  "eye",
  "player",
  "capture",
  "profile",
  "crashes",
] as const;

/** The refusals a Rust game's run, page or probe can meet; the contract page must name each. */
const GAME_REFUSALS = [
  NativeRefusal.GpuUnsupported,
  NativeRefusal.DeviceLost,
  NativeRefusal.GpuHang,
  NativeRefusal.NativeFeatureMissing,
  NativeRefusal.NativeFeaturesWeb,
  NativeRefusal.GpuPassInvalid,
  NativeRefusal.BuildFailed,
  NativeRefusal.LaneMissing,
] as const;

/**
 * The facade's own vocabularies, as genex's `tests/vocabulary.rs` holds them: the keys `state()`
 * owns (`RUNTIME_KEYS`), the codes `genex::install` panics with (`InstallErrorCode`) and the code
 * a refused registration panics with (`game.gpu_pass`).
 */
const FACADE = JSON.parse(
  readFileSync(path.join(REPO, "tests", "fixtures", "rust-facade-vocabulary.json"), "utf8"),
) as {
  runtimeKeys: string[];
  installRefusals: string[];
  registrationRefusals: string[];
  levelTwoCalls: string[];
  temporalCalls: string[];
  environment: { calls: string[]; kinds: string[]; hdriSun: string[] };
  lights: { calls: string[] };
  instanceGroups: { calls: string[]; refusals: string[] };
  terrain: { calls: string[]; refusals: string[] };
  particles: { calls: string[]; refusals: string[] };
  audio: { calls: string[]; refusals: string[] };
  animation: { calls: string[]; refusals: string[] };
  input: { calls: string[]; refusals: string[] };
  lod: { calls: string[]; refusals: string[] };
  fog: { calls: string[] };
  probes: { calls: string[] };
  decals: { calls: string[] };
  grading: { calls: string[] };
  lens: { calls: string[] };
  nightSky: { calls: string[] };
  subsurface: { calls: string[] };
};

/** Every call group the fixture pins (a top-level entry with a `calls` list), by its key. */
function pinnedCallGroups(): Array<[string, string[]]> {
  return Object.entries(FACADE as Record<string, unknown>).flatMap(([key, entry]) => {
    const calls = (entry as { calls?: unknown } | null)?.calls;
    return Array.isArray(calls) ? [[key, calls as string[]] as [string, string[]]] : [];
  });
}

/**
 * The world's look an in-app agent builds from the built-ins, as the template guide points at it:
 * one entry call of each fixture group the guide must name (a probe and a volume per room, the
 * decals, the air, the grade, the lens and the night sky).
 */
const WORLD_LOOK_ENTRY_CALLS = [
  "frame.reflection_probe",
  "frame.irradiance_volume",
  "frame.decal",
  "Fog::default",
  ".with_volumetric",
  ".grading",
  ".temperature",
  ".depth_of_field",
  ".with_moon",
  ".with_subsurface",
] as const;

/** The most words the template guide's `## World look` rules may take: rules, with the reference holding the how. */
const GUIDE_WORLD_LOOK_WORDS_MAX = 320;

/**
 * What the seed's Rust recipes must sketch, as calls, so a facet that fails a look check is
 * handed the built-in that fixes it: rooms lit by their own probe and volume, and the air and grade;
 * and a facet whose sound a check cannot prove played is handed the audio calls (AU-9).
 */
const RECIPE_SKETCH_CALLS = [
  ["frame.reflection_probe", "frame.irradiance_volume"],
  ["Fog::default", ".with_moon", ".grading", ".exposure_curve"],
  ["gfx.sound", "ctx.audio.play_at"],
] as const;

/** The topic pages of the game systems (stage 2), each of which the template guide routes an agent to. */
const GAME_SYSTEMS_PAGES = [
  "ctx",
  "input",
  "ui",
  "settings",
  "streaming",
  "navigation",
  "characters",
  "animation",
  "audio",
  "saves",
  "net",
  "profiling",
] as const;

/** The seed's recipes, whose `evidence` cites sections of the reference. */
const RECIPES = path.join(REPO, "src", "harness-seed", "library", "recipes");

/** Where the render-presets recipe's sketch moves from its `genex.toml` to its Rust code. */
const RUST_SKETCH_FILE = "// src/game.rs";

/** The most words the reference's `## Rendering` chapter may take: one chapter an agent reads whole. */
const RENDERING_WORDS_MAX = 1500;
/** The most words the template guide's `## Rendering` rules may take: rules, with the reference holding the how. */
const GUIDE_RENDERING_WORDS_MAX = 520;

/** The members of `renderSettings {set}` (`RenderSettingsChange` in `src/shared/render-quality.ts`). */
const RENDER_SETTINGS_MEMBERS = ["preset", "deviceClass", "features", "renderScaleLock", "frameBudgetMs"] as const;

/** The Level-3 stages a `GpuPass` registers at (`PassStage` in genex's `gpu.rs`). */
const PASS_STAGES = ["BeforeCull", "AfterPrepass", "AfterOpaque", "AfterTransparent", "PostHdr", "Post"] as const;

/** The renderer's wire vocabularies a game states or reads; the chapter names each value. */
const RENDER_VOCABULARIES: Record<string, Record<string, string>> = {
  QualityPreset,
  DeviceClass,
  RenderFeature,
  Tonemapper,
  ExposureMode,
  Metering,
  LookKey,
  QualityKey,
  RenderTomlKey,
  ShadowTomlKey,
  DegradeReason,
  RenderInput,
};

const read = (rel: string) => readFileSync(path.join(TEMPLATE, rel), "utf8");
const contract = () => read("docs/CONTRACT.md");
const index = () => read(API_INDEX);

/** The text of the `## <heading>` section, up to the next `## ` heading. */
function section(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  assert.ok(start >= 0, `no "## ${heading}" section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** The titles of `markdown`'s `## ` sections. */
const sectionTitles = (markdown: string): string[] =>
  markdown
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).trim());

/** A topic the index lists: the chapter's title and the page that holds it. */
interface Topic {
  title: string;
  page: string;
}

/** The topics the index's `## Topics` table lists, in its order. */
function topics(): Topic[] {
  return section(index(), "Topics")
    .split("\n")
    .flatMap((line) => {
      const row = /^\| ([^|`]+?) \| `([^`]+)` \|/.exec(line);
      return row ? [{ title: row[1] ?? "", page: row[2] ?? "" }] : [];
    });
}

/** The topic pages of the reference under `root`, as `docs/api/<name>.md`, sorted; none without the folder. */
function topicPages(root: string): string[] {
  const dir = path.join(root, API_PAGES);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => `${API_PAGES}/${name}`);
}

/** A topic page's title (its `# ` first line) and the text after it. */
function titled(markdown: string): { title: string; body: string } {
  const [first = "", ...rest] = markdown.split("\n");
  return { title: first.startsWith("# ") ? first.slice(2).trim() : "", body: rest.join("\n") };
}

/** The whole reference an agent can read: the index, then every topic page. */
const api = () => [index(), ...topicPages(TEMPLATE).map(read)].join("\n");

/** Every chapter title of the reference: the index's sections, then the topic pages' titles. */
const chapterTitles = (): string[] => [
  ...sectionTitles(index()),
  ...topicPages(TEMPLATE).map((rel) => titled(read(rel)).title),
];

/** A chapter of the reference: the topic page with that title, or else the index's section. */
function chapter(title: string): string {
  const page = topicPages(TEMPLATE)
    .map((rel) => titled(read(rel)))
    .find((entry) => entry.title === title);
  return page ? page.body : section(index(), title);
}

/** The page the index lists for the chapter `title`. */
function pageOf(title: string): string {
  const topic = topics().find((entry) => entry.title === title);
  assert.ok(topic, `the index lists no "${title}" topic`);
  return topic.page;
}

/** The backticked first cell of every row of the markdown table in `text`. */
function firstCells(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => /^\| `([^`]+)`/.exec(line)?.[1] ?? "");
}

/** The words of `text`'s inline code and fenced blocks: the names a page teaches, split at punctuation. */
function codeWords(text: string): Set<string> {
  const fenced = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
  const inline = [...text.replace(/```[\s\S]*?```/g, "").matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? "");
  const words = [...fenced, ...inline].flatMap((chunk) => chunk.match(/[A-Za-z][A-Za-z0-9_-]*/g) ?? []);
  return new Set(words);
}

/** The game systems' topic pages whose every call is pinned (the docs-to-fixture row). */
const PINNED_CALL_PAGES = [
  "animation",
  "assets",
  "audio",
  "characters",
  "input",
  "navigation",
  "net",
  "profiling",
  "saves",
  "settings",
  "streaming",
  "ui",
] as const;

/**
 * Names those pages call that are not the game systems' facade calls: Rust's and serde_json's own
 * methods, the hooks, the core's older calls (`frame.tag`, `sim.split`, `Pcg32::unit`,
 * `frame.sphere`, `genex::render::settings_button`), egui's `ui.painter` and a game's own helper
 * in the profiling example (`enemy.think`).
 */
const NOT_GAME_SYSTEMS_CALLS = new Set([
  "any",
  "as_bool",
  "as_f64",
  "as_i64",
  "as_mut",
  "as_ref",
  "cloned",
  "collect",
  "contains",
  "expect",
  "extend",
  "fold",
  "from",
  "from_xyz",
  "into",
  "into_iter",
  "is_ok",
  "iter",
  "len",
  "length",
  "map",
  "map_or",
  "ok",
  "ok_or",
  "retain",
  "take",
  "to_owned",
  "to_vec",
  "unwrap_or",
  "on_draw",
  "on_reset",
  "on_ui",
  "on_update",
  "painter",
  "settings_button",
  "sphere",
  "split",
  "tag",
  "think",
  "unit",
]);

/** The method and function names `text` calls in its fenced Rust blocks and inline code (`.x(`, `T::x(`). */
function calledNames(text: string): Set<string> {
  const fenced = [...text.matchAll(/```rust\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
  const inline = [...text.replace(/```[\s\S]*?```/g, "").matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? "");
  const calls = [...fenced, ...inline].flatMap((chunk) => [...chunk.matchAll(/(?:\.|::)([a-z_][a-z0-9_]*)\s*\(/g)]);
  return new Set(calls.map((match) => match[1] ?? ""));
}

/** The words of `text`, split at whitespace. */
const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/** Every backticked token of `text`. */
const ticked = (text: string): string[] => [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? "");

/** The values of a vocabulary object. */
const values = (vocabulary: Record<string, string>): string[] => Object.values(vocabulary);

/** Every file under `dir`, `/`-separated. */
function filesUnder(dir: string, rel = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...filesUnder(dir, child));
    else files.push(child);
  }
  return files;
}

describe("CONTRACT.md names the contract's vocabulary", () => {
  it("lists every host verb, and only host verbs", () => {
    const named = firstCells(section(contract(), "Host verbs")).sort();
    assert.deepEqual(named, values(NativeOp).sort());
  });

  it("lists the page verbs the harness calls, and only names the shell binds", () => {
    const named = firstCells(section(contract(), "Page verbs"));
    for (const verb of values(PageMethod)) assert.ok(named.includes(verb), `page verb ${verb} is not named`);
    const known = new Set<string>([...values(PageMethod), ...PAGE_ONLY_VERBS]);
    for (const verb of named) assert.ok(known.has(verb), `${verb} is not a page verb`);
    assert.equal(new Set(named).size, named.length, "a page verb is listed twice");
  });

  it("names only refusal codes that exist, and every one a game's run can meet", () => {
    const named = firstCells(section(contract(), "Refusals"));
    // The one stage refusal a game can meet before a run exists: an ejected engine's row changed.
    const known = new Set<string>([...values(NativeRefusal), ...values(NativeOpError), RustStageCode.EngineUnrecorded]);
    for (const code of named) assert.ok(known.has(code), `${code} is not a refusal code`);
    for (const code of GAME_REFUSALS) assert.ok(named.includes(code), `refusal ${code} is not named`);
    assert.equal(new Set(named).size, named.length, "a refusal is listed twice");
  });

  it("names every code the renderSettings verb answers a refused argument with", () => {
    const row = section(contract(), "Host verbs")
      .split("\n")
      .find((line) => line.startsWith("| `renderSettings` |"));
    assert.ok(row, "a renderSettings row");
    const named = new Set(ticked(row));
    for (const code of [...values(RenderSettingsRefusal), NativeOpError.BadArgument])
      assert.ok(named.has(code), `the renderSettings row does not name ${code}`);
  });

  it("states the destinations' one GPU floor and its tiers", () => {
    const text = contract();
    for (const tier of values(NativeGpuTier)) assert.ok(text.includes(`\`${tier}\``), `tier ${tier} is not named`);
    assert.ok(text.includes("native-enhanced"));
    assert.match(text, /no WebGL|no fallback/i);
  });
});

describe("GENEX_API.md is a short index of the reference's topic pages", () => {
  it(`takes at most ${INDEX_WORDS_MAX} words: the hooks and the rules, every other topic on its own page`, () => {
    assert.ok(wordCount(index()) <= INDEX_WORDS_MAX, `${wordCount(index())} words`);
  });

  it("lists every topic page once, under the title the page carries", () => {
    const listed = topics();
    assert.ok(listed.length > 0, "the index lists no topic page");
    assert.deepEqual(listed.map((topic) => topic.page).sort(), topicPages(TEMPLATE), "listed pages are the folder's");
    assert.equal(new Set(listed.map((topic) => topic.title)).size, listed.length, "a topic is listed twice");
    for (const topic of listed) assert.equal(titled(read(topic.page)).title, topic.title, topic.page);
  });

  it("gives every chapter one home: the index or one topic page", () => {
    const titles = chapterTitles();
    assert.equal(new Set(titles).size, titles.length, titles.join(", "));
  });

  it("is byte-equal, index and every page, to the facade crate's copy", () => {
    assert.equal(index(), readFileSync(path.join(FACADE_ROOT, API_INDEX), "utf8"));
    assert.deepEqual(topicPages(FACADE_ROOT), topicPages(TEMPLATE), "the two trees hold the same pages");
    for (const page of topicPages(TEMPLATE))
      assert.equal(read(page), readFileSync(path.join(FACADE_ROOT, page), "utf8"), `${page} differs`);
  });
});

describe("GENEX_API.md is the facade's reference", () => {
  it("lists exactly the native features genex.toml accepts", () => {
    const paragraph = /Native features:([\s\S]*?)\.\s/.exec(chapter("genex.toml"))?.[1] ?? "";
    assert.deepEqual(ticked(paragraph).sort(), values(NativeEnhancedFeature).sort());
  });

  it("names every input kind and touch phase an injection or a script can carry", () => {
    const text = api();
    for (const kind of values(NativeInputKind)) assert.ok(text.includes(kind), `input kind ${kind} is not named`);
    for (const phase of values(TouchPhase))
      assert.ok(text.includes(`touch_${phase}`), `touch phase ${phase} is not named`);
  });

  it("names every key the state document reserves and every install refusal", () => {
    const text = chapter("Hooks");
    for (const key of FACADE.runtimeKeys) assert.ok(text.includes(`\`${key}\``), `state key ${key} is not named`);
    for (const code of [...FACADE.installRefusals, ...FACADE.registrationRefusals])
      assert.ok(text.includes(`\`${code}\``), `install refusal ${code} is not named`);
  });

  it("teaches every Level-2 call the facade pins, each as a call", () => {
    const text = api();
    for (const call of FACADE.levelTwoCalls) assert.ok(text.includes(`${call}(`), `GENEX_API.md teaches ${call}(..)`);
  });

  it("teaches every temporal call (draw ids, camera cuts) and the template points at them", () => {
    const text = api();
    for (const call of FACADE.temporalCalls) assert.ok(text.includes(`${call}(`), `GENEX_API.md teaches ${call}(..)`);
    const guide = read("CLAUDE.md");
    for (const call of FACADE.temporalCalls) assert.ok(guide.includes(`${call}(`), `CLAUDE.md names ${call}(..)`);
  });

  it("teaches every environment call and each way an HDR map's sun can go", () => {
    const text = api();
    for (const call of FACADE.environment.calls)
      assert.ok(text.includes(`${call}(`), `GENEX_API.md teaches ${call}(..)`);
    // The wire spelling `off` is the Rust variant `HdriSun::Off`.
    for (const sun of FACADE.environment.hdriSun) {
      const variant = `HdriSun::${sun.charAt(0).toUpperCase()}${sun.slice(1)}`;
      assert.ok(text.includes(variant), `GENEX_API.md names ${variant}`);
    }
    assert.ok(read("CLAUDE.md").includes("frame.environment("), "CLAUDE.md points at frame.environment(..)");
  });

  it("teaches every retained instance group call and refusal", () => {
    const text = api();
    for (const call of FACADE.instanceGroups.calls)
      assert.ok(text.includes(`${call}(`), `GENEX_API.md teaches ${call}(..)`);
    for (const refusal of FACADE.instanceGroups.refusals)
      assert.ok(text.includes(refusal), `GENEX_API.md names ${refusal}`);
  });

  it("teaches every terrain call and refusal", () => {
    const text = api();
    for (const call of FACADE.terrain.calls) assert.ok(text.includes(`${call}(`), `GENEX_API.md teaches ${call}(..)`);
    for (const refusal of FACADE.terrain.refusals) assert.ok(text.includes(refusal), `GENEX_API.md names ${refusal}`);
  });

  it("teaches every particle call and refusal", () => {
    const text = api();
    for (const call of FACADE.particles.calls) assert.ok(text.includes(`${call}(`), `GENEX_API.md teaches ${call}(..)`);
    for (const refusal of FACADE.particles.refusals) assert.ok(text.includes(refusal), `GENEX_API.md names ${refusal}`);
  });

  it("teaches every audio call and refusal on the Audio page the index lists (AU-9)", () => {
    const page = read(pageOf("Audio"));
    for (const call of FACADE.audio.calls) assert.ok(page.includes(`${call}(`), `audio.md teaches ${call}(..)`);
    for (const refusal of FACADE.audio.refusals)
      assert.ok(page.includes(`\`${refusal}\``), `audio.md names ${refusal}`);
  });

  it("teaches every fog call, the volumetric opt-out among them", () => {
    const text = api();
    for (const call of FACADE.fog.calls) assert.ok(text.includes(`${call}(`), `GENEX_API.md teaches ${call}(..)`);
  });

  it("teaches every call of every group the fixture pins, each as a call", () => {
    const text = api();
    const groups = pinnedCallGroups();
    assert.ok(groups.length >= 12, groups.map(([key]) => key).join(", "));
    const missing = groups.flatMap(([key, calls]) =>
      calls.filter((call) => !text.includes(`${call}(`)).map((call) => `${key}: ${call}(..)`),
    );
    assert.deepEqual(missing, []);
  });

  it("teaches every local-light and emission call, and the template points at them", () => {
    const text = api();
    for (const call of FACADE.lights.calls) assert.ok(text.includes(`${call}(`), `GENEX_API.md teaches ${call}(..)`);
    const guide = read("CLAUDE.md");
    for (const call of ["frame.point_light", "frame.spot_light", "Material::emissive("])
      assert.ok(guide.includes(call), `CLAUDE.md points at ${call}`);
  });

  it("states a determinism rule for everything the lane's lint file refuses", () => {
    const rules = chapter("Determinism");
    const lints = readFileSync(LANE_LINTS, "utf8");
    const refused = [...lints.matchAll(/path = "([^"]+)"/g)].map((match) => match[1] ?? "");
    assert.ok(refused.length > 30, "the lint file lists the refused paths");
    const others = refused.filter((entry) => !/^f(32|64)::/.test(entry));
    // A type names itself (`std::collections::HashMap`); a function names its module or crate.
    const names = new Set(
      others.map((entry) => {
        const parts = entry.split("::");
        return /^[A-Z]/.test(parts.at(-1) ?? "") ? (parts.at(-1) ?? "") : (parts.at(-2) ?? "");
      }),
    );
    assert.ok(names.size >= 6);
    for (const name of names) assert.ok(rules.includes(name), `the determinism rules do not name ${name}`);
    assert.ok(rules.includes("f32"), "the transcendental rule names f32's methods");
  });
});

describe("the Input page (IN-15)", () => {
  it("teaches every input call and refusal on the Input page the index lists (IN-15)", () => {
    const page = read(pageOf("Input"));
    for (const call of FACADE.input.calls) assert.ok(page.includes(`${call}(`), `input.md teaches ${call}(..)`);
    for (const refusal of FACADE.input.refusals)
      assert.ok(page.includes(`\`${refusal}\``), `input.md names ${refusal}`);
    assert.ok(read(pageOf("Ctx")).includes("docs/api/input.md"), "the Ctx page links the Input page");
  });

  it("states on the Input page that a prompt is display text and what a replay promises (IN-15)", () => {
    const page = read(pageOf("Input"));
    assert.match(page, /display text/, "a glyph's label is display text");
    assert.match(page, /never (?:keep|store|copy)[^.]*(?:label|glyph)[^.]*world/i, "a label never goes into the world");
    assert.match(page, /\(seed, bindings digest, `TickInput` rows\)/, "the replay promise names its three inputs");
  });
});

describe("the game systems' pages teach only pinned calls", () => {
  it("pins every call the game systems' pages teach (docs to fixture)", () => {
    const pinned = new Set(
      pinnedCallGroups().flatMap(([, calls]) => calls.flatMap((call) => call.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])),
    );
    const unpinned = PINNED_CALL_PAGES.flatMap((page) =>
      [...calledNames(read(`${API_PAGES}/${page}.md`))]
        .filter((name) => !pinned.has(name) && !NOT_GAME_SYSTEMS_CALLS.has(name))
        .map((name) => `${page}.md: ${name}(..)`),
    );
    assert.deepEqual(unpinned, []);
  });
});

describe("GENEX_API.md's Rendering chapter", () => {
  const rendering = () => chapter("Rendering");

  it(`is one chapter of at most ${RENDERING_WORDS_MAX} words`, () => {
    assert.ok(wordCount(rendering()) <= RENDERING_WORDS_MAX, `${wordCount(rendering())} words`);
  });

  it("names every value of the renderer vocabularies a game states or reads", () => {
    const named = codeWords(rendering());
    const missing = Object.entries(RENDER_VOCABULARIES).flatMap(([name, vocabulary]) =>
      Object.values(vocabulary)
        .filter((value) => !named.has(value))
        .map((value) => `${name}.${value}`),
    );
    assert.deepEqual(missing, []);
  });

  it("teaches the renderSettings verb's members, the settings panel and the Level-3 stages", () => {
    const named = codeWords(rendering());
    for (const member of RENDER_SETTINGS_MEMBERS) assert.ok(named.has(member), `renderSettings ${member}`);
    for (const word of ["renderSettings", "settings_panel"]) assert.ok(named.has(word), `${word}`);
    const stages = codeWords(chapter("Custom GPU passes"));
    for (const stage of PASS_STAGES) assert.ok(stages.has(stage), `stage ${stage} is not named`);
    const inChapter = codeWords(rendering());
    for (const stage of PASS_STAGES) assert.ok(inChapter.has(stage), `the chapter does not list stage ${stage}`);
  });

  it("leaves lights, meshlets and Level 2 to their own sections", () => {
    const headings = chapterTitles();
    for (const heading of ["Lighting, materials and environment", "Big meshes", "Custom materials and post passes"])
      assert.ok(
        headings.some((line) => line.startsWith(heading)),
        `no "${heading}" chapter`,
      );
  });
});

describe("the template guide's rendering rules", () => {
  const rules = () => section(read("CLAUDE.md"), "Rendering");

  it(`stay rules: at most ${GUIDE_RENDERING_WORDS_MAX} words, and the reference holds the how`, () => {
    assert.ok(wordCount(rules()) <= GUIDE_RENDERING_WORDS_MAX, `${wordCount(rules())} words`);
    assert.ok(rules().includes(pageOf("Rendering")), "the rules point at the Rendering page");
  });

  it("tell an agent to use presets, state the look in [render], prefer built-ins and test as a phone", () => {
    const named = codeWords(rules());
    for (const word of ["render", "settings_panel", "renderSettings", "mobile-mid", "low", "ultra", "agx-punchy"])
      assert.ok(named.has(word), `the rules do not name ${word}`);
    assert.match(rules(), /never[^.\n]*\bultra\b/i, "the rules forbid a fixed ultra");
    assert.match(rules(), /built-in/i, "the rules prefer the built-ins to a custom pass");
    assert.match(rules(), /api = 2/, "the rules write sources at v2");
  });

  it("give the game's own settings back after testing as a phone, every member with null", () => {
    const reset = /\{set: \{((?:\w+: null(?:, )?)+)\}\}/.exec(rules())?.[1] ?? "";
    const given = reset.split(",").map((pair) => pair.split(":")[0]?.trim());
    assert.deepEqual(new Set(given), new Set(RENDER_SETTINGS_MEMBERS), "the reset names every member");
  });
});

describe("the template guide's world-look rules", () => {
  const rules = () => section(read("CLAUDE.md"), "World look");

  it(`stay rules: at most ${GUIDE_WORLD_LOOK_WORDS_MAX} words, and the reference holds the how`, () => {
    assert.ok(wordCount(rules()) <= GUIDE_WORLD_LOOK_WORDS_MAX, `${wordCount(rules())} words`);
    for (const title of ["Lighting, materials and environment", "Grading and the lens"])
      assert.ok(rules().includes(pageOf(title)), `the rules point at the ${title} page`);
  });

  it("point at the built-ins a world's look is made of, each a call the fixture pins", () => {
    const pinned = new Set(pinnedCallGroups().flatMap(([, calls]) => calls));
    const text = rules();
    for (const call of WORLD_LOOK_ENTRY_CALLS) {
      assert.ok(pinned.has(call), `${call} is a pinned facade call`);
      assert.ok(text.includes(`${call}(`), `the world-look rules do not name ${call}(..)`);
    }
  });

  it("tell an agent to light each room with its own probe and volume and to grade last", () => {
    assert.match(rules(), /each room/i, "a probe and a volume per room");
    assert.match(rules(), /grade[^.\n]*last|last[^.\n]*grade/i, "the grade comes last");
  });
});

describe("the seed's Rust recipes sketch the world's look with pinned calls", () => {
  const rustRecipes = () =>
    readdirSync(RECIPES)
      .filter((name) => name.startsWith("rust.") && name.endsWith(".json"))
      .map(
        (name) =>
          JSON.parse(readFileSync(path.join(RECIPES, name), "utf8")) as { id: string; sketch: string; intent: string },
      );

  it("has a recipe whose sketch calls each set of built-ins together", () => {
    const recipes = rustRecipes();
    for (const calls of RECIPE_SKETCH_CALLS) {
      const found = recipes.find((recipe) => calls.every((call) => recipe.sketch.includes(`${call}(`)));
      assert.ok(found, `no Rust recipe sketches ${calls.join(", ")} together`);
    }
  });

  it("names in its intent only pinned world-look calls the reference teaches", () => {
    const pinned = pinnedCallGroups().flatMap(([, calls]) => calls);
    const text = api();
    for (const recipe of rustRecipes())
      for (const call of pinned.filter((name) => recipe.intent.includes(`${name}(`)))
        assert.ok(text.includes(`${call}(`), `${recipe.id} names ${call}(..), which GENEX_API.md does not teach`);
  });
});

describe("the seed's Rust recipes cite sections the reference has", () => {
  it("names a GENEX_API.md section in every evidence source", () => {
    const sections = new Set(chapterTitles());
    const recipes = readdirSync(RECIPES).filter((name) => name.startsWith("rust.") && name.endsWith(".json"));
    assert.ok(recipes.includes("rust.render-presets.json") && recipes.includes("rust.lighting-materials.json"));
    for (const name of recipes) {
      const recipe = JSON.parse(readFileSync(path.join(RECIPES, name), "utf8")) as {
        evidence: Array<{ source: string }>;
      };
      for (const { source } of recipe.evidence) {
        // "(Ctx: Touch)" cites Ctx; "(Determinism, Facets)" cites two sections; a title may hold a comma itself.
        const cited = /GENEX_API\.md \(([^)]+)\)/.exec(source)?.[1]?.split(":")[0]?.trim();
        if (!cited) continue;
        const named = sections.has(cited) ? [cited] : cited.split(",").map((part) => part.trim());
        for (const heading of named)
          assert.ok(sections.has(heading), `${name} cites "${heading}", which GENEX_API.md has no section for`);
      }
    }
  });
});

describe("the seed's render-presets recipe teaches what the template and the verb do", () => {
  const recipe = () =>
    JSON.parse(readFileSync(path.join(RECIPES, "rust.render-presets.json"), "utf8")) as {
      intent: string;
      sketch: string;
    };
  /** The sketch's `genex.toml` part: everything before its first Rust file. */
  const sketchToml = () => recipe().sketch.split(RUST_SKETCH_FILE)[0] ?? "";
  const lookOf = (document: TomlTable): TomlTable => {
    const render = document.render;
    assert.ok(isTable(render), "a [render] table");
    const look = render.look;
    assert.ok(isTable(look), "a [render.look] table");
    return look;
  };
  const lookValue = (value: TomlValue | undefined) => (value instanceof TomlFloat ? value.value : value);

  it("sketches a [render] the manifest parser admits", () => {
    const parsed = parseGenexToml(`[game]\ntitle = "Sketch"\n${sketchToml()}`);
    assert.ok(parsed.ok, JSON.stringify(parsed));
  });

  it("states the template's look: every [render.look] key it names has the template's value", () => {
    const sketched = lookOf(parseTomlDocument(sketchToml()));
    const template = lookOf(parseTomlDocument(read("genex.toml")));
    assert.ok(Object.keys(sketched).length > 0, "the sketch states a look");
    for (const [key, value] of Object.entries(sketched))
      assert.deepEqual(lookValue(value), lookValue(template[key]), `[render.look] ${key}`);
  });

  it("names every renderSettings member it changes and gives each back with null", () => {
    const named = new Set(recipe().intent.match(/[A-Za-z][A-Za-z0-9_-]*/g));
    for (const member of RENDER_SETTINGS_MEMBERS) assert.ok(named.has(member), `renderSettings ${member}`);
    const reset = /\{set: \{((?:\w+: null(?:, )?)+)\}\}/.exec(recipe().intent)?.[1] ?? "";
    const given = reset.split(",").map((pair) => pair.split(":")[0]?.trim());
    assert.deepEqual(new Set(given), new Set(RENDER_SETTINGS_MEMBERS), "the reset names every member");
  });
});

/** A studio library over the repository's templates, in a fresh temporary folder. */
async function library(): Promise<{ games: GameWorkspaces; base: string }> {
  const base = await tmpDir("studio-rust-docs-");
  const vendorDir = path.join(base, "vendor");
  await mkdir(vendorDir, { recursive: true });
  await writeFile(path.join(vendorDir, "three.module.js"), "export const REVISION = '0';\n");
  const games = new GameWorkspaces({
    root: path.join(base, "library"),
    templateDir: path.join(REPO, "src", "game-template"),
    rustTemplateDir: TEMPLATE,
    rustCreation: true,
    vendorDir,
    indexFile: path.join(base, "projects.json"),
    userData: path.join(base, "userData"),
    homeDir: base,
    platform: "darwin",
  });
  return { games, base };
}

describe("a Rust game folder carries the whole reference", () => {
  it("a created game holds the index and every topic page, byte-equal to the template's", async () => {
    const { games } = await library();
    const game = await games.create("Pond", { stack: GameStack.RustWgpu });
    for (const rel of [API_INDEX, ...topicPages(TEMPLATE)])
      assert.equal(await readFile(path.join(game.dir, rel), "utf8"), read(rel), rel);
  });

  it("a Rust folder adopted with its own files is promised the index and every topic page", async () => {
    const { games, base } = await library();
    const own = path.join(base, "own");
    await mkdir(own, { recursive: true });
    await cp(path.join(TEMPLATE, "genex.toml"), path.join(own, "genex.toml"));
    await cp(path.join(TEMPLATE, "src"), path.join(own, "src"), { recursive: true });
    const planned = await games.plannedWrites(own);
    for (const rel of [API_INDEX, ...topicPages(TEMPLATE)]) assert.ok(planned.includes(rel), rel);
  });
});

describe("the agent-facing files agree with each other and the folder", () => {
  it("links only to files the template folder has", () => {
    const files = new Set(filesUnder(TEMPLATE));
    for (const page of ["CLAUDE.md", "docs/CONTRACT.md", API_INDEX, ...topicPages(TEMPLATE)]) {
      const named = ticked(read(page)).filter((token) => /^(?:docs|web|assets|references)\/[\w./-]+\.\w+$/.test(token));
      for (const rel of named) assert.ok(files.has(rel), `${page} names ${rel}, which the template does not have`);
    }
  });

  it("CLAUDE.md points at the other two pages and the brief", () => {
    const text = read("CLAUDE.md");
    for (const target of ["docs/GENEX_API.md", "docs/CONTRACT.md", ".studio/BRIEF.md"])
      assert.ok(text.includes(target), `CLAUDE.md does not name ${target}`);
  });

  it("CLAUDE.md routes to every game-systems page and names the action map as an input source", () => {
    const text = read("CLAUDE.md");
    for (const page of GAME_SYSTEMS_PAGES)
      assert.ok(text.includes(`docs/api/${page}.md`), `CLAUDE.md does not route to docs/api/${page}.md`);
    assert.ok(section(text, "Game systems"), "CLAUDE.md has a Game systems section");
    const inputRule = text.slice(text.indexOf("4. **"), text.indexOf("5. **"));
    assert.ok(inputRule.includes("ctx.actions"), "rule 4 lists ctx.actions among the input sources");
  });

  it("CLAUDE.md carries the rules the lane enforces: probes, demos, touch, the HUD and determinism", () => {
    const text = read("CLAUDE.md");
    for (const word of ["probe", "demo", "ctx.touches", "on_ui", "ctx.rng", "genex::math", "genex::Map"])
      assert.ok(text.includes(word), `CLAUDE.md does not mention ${word}`);
  });

  it("leaks no eval brief or checklist phrase to the in-app agent", () => {
    const { briefs, terms } = isolationInputs(readCases(REPO));
    const files = filesUnder(TEMPLATE)
      .filter((rel) => /\.(?:md|toml|rs|html)$/.test(rel) && statSync(path.join(TEMPLATE, rel)).isFile())
      .map((rel) => ({ path: `src/game-template-rust/${rel}`, text: read(rel) }));
    assert.ok(files.length >= 8);
    const report = findLeaks(briefs, terms, files);
    assert.deepEqual(report.leaks, []);
    assert.ok(report.sentences > 0);
  });
});

describe("the Rust eval case", () => {
  const rustCase = caseById(readCases(REPO), RUST_CASE_ID);

  it("is a build case with one control and one KEY item, and never names the stack", () => {
    assert.ok(rustCase, `evals/cases.md has no ${RUST_CASE_ID} case`);
    assert.equal(rustCase.mode, CaseMode.Build);
    assert.equal(rustCase.acceptance.filter((item) => item.control).length, 1);
    assert.equal(rustCase.acceptance.filter((item) => item.key).length, 1);
    assert.doesNotMatch(rustCase.brief, STACK_WORDS);
    for (const item of rustCase.acceptance) assert.doesNotMatch(item.text, STACK_WORDS);
  });

  it("asks for what the facade's verbs can probe: touch input, physics and a score on screen", () => {
    assert.ok(rustCase);
    const asked = `${rustCase.brief}\n${rustCase.acceptance.map((item) => item.text).join("\n")}`;
    for (const axis of [/touch|tap|flick/i, /physic|topple|knock/i, /score|count/i]) assert.match(asked, axis);
  });
});

/** The seed's asset recipes (C-24): the Rust techniques an agent retrieves for asset work. */
const ASSET_RECIPES = ["rust.cc0-assets", "rust.texture-usage", "rust.asset-budgets"] as const;
/** The most words the template guide's `## Assets` rules may take: rules, with the reference holding the how. */
const GUIDE_ASSETS_WORDS_MAX = 300;
/** What a seed recipe's menu note and intent may take (`harness-seed/loop/library.ts` clips past these). */
const RECIPE_NOTE_CHARS_MAX = 160;
const RECIPE_INTENT_CHARS_MAX = 1200;

interface SeedRecipe {
  id: string;
  runtime: string;
  pack: string;
  kind: string;
  origin: string;
  note: string;
  intent: string;
  sketch: string;
  evidence: Array<{ source: string }>;
}
const seedRecipe = (id: string): SeedRecipe =>
  JSON.parse(readFileSync(path.join(RECIPES, `${id}.json`), "utf8")) as SeedRecipe;

describe("the template guide's Assets rules (C-24)", () => {
  const rules = () => section(read("CLAUDE.md"), "Assets");

  it(`stay rules: at most ${GUIDE_ASSETS_WORDS_MAX} words, and the reference holds the how`, () => {
    assert.ok(wordCount(rules()) <= GUIDE_ASSETS_WORDS_MAX, `${wordCount(rules())} words`);
    for (const page of ["docs/api/assets.md", "docs/api/drawing.md", "docs/api/genex-toml.md"])
      assert.ok(rules().includes(page), `the Assets rules point at ${page}`);
  });

  it("name the CC0 tools, the texture row, the budgets and the keys a capture shows", () => {
    for (const word of [
      "cc0__search",
      "cc0__fetch",
      "genex-assets.lock",
      "[[texture]]",
      "budget_mb",
      "[[asset_group]]",
      "assets-over-ceiling",
      "texture-uncompressed",
      "missingModels",
    ])
      assert.ok(rules().includes(word), `the Assets rules name ${word}`);
  });
});

describe("the seed's asset recipes (C-24)", () => {
  it("ship as Rust techniques the library keeps whole, citing sections the reference has", () => {
    const sections = new Set(chapterTitles());
    for (const id of ASSET_RECIPES) {
      assert.ok(existsSync(path.join(RECIPES, `${id}.json`)), `${id} is in the seed`);
      const recipe = seedRecipe(id);
      assert.equal(recipe.id, id);
      assert.equal(recipe.runtime, GameStack.RustWgpu, `${id} is a Rust recipe`);
      assert.deepEqual([recipe.pack, recipe.kind, recipe.origin], ["rust", "technique", "seed"], id);
      assert.ok(recipe.note.length <= RECIPE_NOTE_CHARS_MAX, `${id}'s note is ${recipe.note.length} characters`);
      assert.ok(recipe.intent.length <= RECIPE_INTENT_CHARS_MAX, `${id}'s intent is ${recipe.intent.length}`);
      const cited = recipe.evidence.flatMap(({ source }) => /GENEX_API\.md \(([^)]+)\)/.exec(source)?.[1] ?? []);
      assert.ok(cited.length > 0, `${id} cites the reference`);
      for (const heading of cited) assert.ok(sections.has(heading), `${id} cites "${heading}"`);
    }
  });

  it("sketch genex.toml rows the build accepts", () => {
    for (const id of ["rust.texture-usage", "rust.asset-budgets"]) {
      const parsed = parseGenexToml(`[game]\ntitle = "Sketch"\n${seedRecipe(id).sketch.replace("# genex.toml\n", "")}`);
      assert.ok(parsed.ok, `${id}: ${JSON.stringify(parsed)}`);
    }
  });

  it("teach the codes the import and the renderer answer with", () => {
    const texture = seedRecipe("rust.texture-usage").intent;
    for (const code of ["texture-uncompressed", "texture-family-refused", "tangents-runtime"])
      assert.ok(texture.includes(code), `rust.texture-usage names ${code}`);
    const budgets = seedRecipe("rust.asset-budgets").intent;
    for (const code of ["assets-over-budget", "assets-over-ceiling", "triangles-over-budget", "not-preloaded"])
      assert.ok(budgets.includes(code), `rust.asset-budgets names ${code}`);
    const cc0 = seedRecipe("rust.cc0-assets");
    for (const word of ["cc0__search", "cc0__fetch", "missingModels", "gfx.assets().model"])
      assert.ok(`${cc0.intent}\n${cc0.sketch}`.includes(word), `rust.cc0-assets names ${word}`);
  });
});

/**
 * The seed's game-systems recipes (EP-R1): one Rust technique per area, and the pinned calls its
 * sketch makes, each of which the reference teaches.
 */
const GAME_SYSTEMS_RECIPES: Record<string, readonly string[]> = {
  "rust.animated-characters": [
    "gfx.character",
    ".clip",
    "Animator::simple",
    ".play",
    ".crossfade",
    ".play_once",
    ".update",
    "Character::spawn",
    ".drive",
    "frame.character",
    ".transform",
    ".feet",
  ],
  "rust.nav-agents": [
    "game.navigation",
    ".nav_config",
    "NavInput::new",
    ".with_static_colliders",
    "NavMesh::bake",
    "nav.add_mesh",
    "NavAgent::new",
    "nav.add_agent",
    "nav.move_to",
    "nav.update",
    "nav.desired_velocity",
    "nav.set_position",
    "nav.status",
    "frame.nav_debug",
    "NavDebug::mesh",
    ".with_paths",
    "nav.probe",
  ],
  "rust.streamed-world": [
    "TerrainTiles::procedural",
    "game.streaming",
    "Streaming::grid",
    ".sim_radius",
    ".view_radius",
    "game.cell_content",
    "CellBuild::default",
    ".thing",
    "inputs.scatter",
    ".group",
    ".colliders_content",
    "game.stream_colliders",
    "sim.stream.set_anchor",
    "sim.stream.entered",
    "cell.cell",
    "sim.stream.left",
  ],
  "rust.lod-impostors": [
    "gfx.assets().compound",
    ".with_impostor",
    "Impostor::hemi",
    ".with_levels",
    ".with_lod_bias",
    ".lod_refusal",
    "game.impostor_bake",
  ],
  "rust.input-controls": [
    "game.input",
    "ActionMap::new",
    ".context",
    "Context::new",
    ".button",
    ".axis2",
    ".when",
    "game.touch_controls",
    "TouchControls::new",
    ".stick",
    ".show",
    "ctx.actions.axis2",
    "ctx.actions.fired",
    "ctx.actions.glyph",
    "ctx.actions.enable",
    "ctx.actions.disable",
    "controls_panel",
  ],
  "rust.menus-saves": [
    "game.ui",
    "UiConfig::new",
    ".locales",
    "game.saves",
    "SaveConfig::schema",
    ".autosave",
    "game.save_world",
    "ctx.slots",
    "slots.events",
    "slots.save",
    "slots.load",
    "Menu::new",
    ".item",
    ".back",
    "Toasts::push",
    "Toasts::show",
    "ui.ctx",
  ],
  "rust.terrain": [
    "Terrain::from_fn",
    ".with_layers",
    "TerrainLayer::flat",
    "Grass::meadow",
    ".with_grass",
    "TerrainTexel::blend",
    ".with_control",
    "Scatter::new",
    "terrain.scatter",
    "terrain.height",
    "frame.terrain",
  ],
  "rust.multiplayer": [
    "game.net",
    "NetConfig::new",
    ".publish_hz",
    ".decimals",
    ".interp_delay_ticks",
    "sim.net.status",
    "sim.net.connect",
    "sim.net.leave",
    "sim.net.set_me",
    "sim.net.events",
    "sim.net.remotes",
    ".state_raw",
    "sim.net.is_host",
    "sim.net.connected",
    "sim.net.set_shared",
    "driver.net",
  ],
  "rust.crash-records": ["genex::profile_scope!", "ScopeName::new", "genex::profile::counter"],
};

/** The seed skill a Rust game's lead reads before reaching past the facade (UIS-19 adds its menu and save lines). */
const LADDER_SKILL = path.join(REPO, "src", "harness-seed", "skills", "rust-extension-ladder.md");

/**
 * Names the game-systems sketches call that the reference shows no call of: Rust's own methods
 * (`clone`, `count`, `is_err`, `is_none_or`) and `genex::math`'s, which the determinism rules name
 * without calling (`round`, `sin`, `cos`).
 */
const SKETCH_STD_CALLS = new Set([
  "abs",
  "and_then",
  "clone",
  "count",
  "first",
  "get",
  "is_err",
  "is_none_or",
  "is_some",
  "is_some_and",
  "min",
  "round",
  "sin",
  "cos",
]);

describe("the seed's game-systems recipes (EP-R1)", () => {
  it("ship as Rust techniques the library keeps whole", () => {
    for (const id of Object.keys(GAME_SYSTEMS_RECIPES)) {
      assert.ok(existsSync(path.join(RECIPES, `${id}.json`)), `${id} is in the seed`);
      const recipe = seedRecipe(id);
      assert.equal(recipe.id, id);
      assert.equal(recipe.runtime, GameStack.RustWgpu, `${id} is a Rust recipe`);
      assert.deepEqual([recipe.pack, recipe.kind, recipe.origin], ["rust", "technique", "seed"], id);
      assert.ok(recipe.note.length <= RECIPE_NOTE_CHARS_MAX, `${id}'s note is ${recipe.note.length} characters`);
      assert.ok(recipe.intent.length <= RECIPE_INTENT_CHARS_MAX, `${id}'s intent is ${recipe.intent.length}`);
      assert.ok(
        recipe.evidence.some(({ source }) => /GENEX_API\.md \(/.test(source)),
        `${id} cites the reference`,
      );
    }
  });

  it("sketch each area's pinned calls, every one of which the reference teaches", () => {
    const pinned = new Set(pinnedCallGroups().flatMap(([, calls]) => calls));
    const text = api();
    for (const [id, calls] of Object.entries(GAME_SYSTEMS_RECIPES)) {
      const { sketch } = seedRecipe(id);
      for (const call of calls) {
        assert.ok(pinned.has(call), `${id}: ${call} is a pinned facade call`);
        assert.ok(text.includes(`${call}(`), `${id}: the reference does not teach ${call}(..)`);
        assert.ok(sketch.includes(`${call}(`), `${id}'s sketch does not call ${call}(..)`);
      }
    }
  });

  it("call nothing in their sketches the reference does not name", () => {
    // A name the reference calls (`.x(`, `T::x(`) or writes as a builder step in prose (`` `with_speed(..)` ``).
    const builderSteps = ticked(api()).flatMap((token) => /^([a-z_][a-z0-9_]*)\(/.exec(token)?.[1] ?? []);
    const taught = new Set([...calledNames(api()), ...builderSteps]);
    for (const id of Object.keys(GAME_SYSTEMS_RECIPES)) {
      const sketch = seedRecipe(id).sketch;
      const called = [...sketch.matchAll(/(?:\.|::)([a-z_][a-z0-9_]*)\s*\(/g)].map((match) => match[1] ?? "");
      const unknown = [...new Set(called)].filter(
        (name) => !taught.has(name) && !NOT_GAME_SYSTEMS_CALLS.has(name) && !SKETCH_STD_CALLS.has(name),
      );
      assert.deepEqual(unknown, [], `${id} calls names the reference never calls`);
    }
  });

  it("teach a menu walked by key, a slot saved and loaded, and the load's checksumMatch (UIS-19)", () => {
    const { intent } = seedRecipe("rust.menus-saves");
    for (const word of ["state().hud.widgets", "ctx.slots()", "lastLoad.checksumMatch"])
      assert.ok(intent.includes(word), `rust.menus-saves names ${word}`);
    const skill = readFileSync(LADDER_SKILL, "utf8");
    for (const word of ["state().hud.widgets", "ctx.slots()", "lastLoad.checksumMatch", "docs/api/saves.md"])
      assert.ok(skill.includes(word), `the ladder skill names ${word}`);
  });

  it("name every LOD refusal and the registration a streamed model's impostor needs (LOD-23)", () => {
    const { intent } = seedRecipe("rust.lod-impostors");
    for (const refusal of FACADE.lod.refusals)
      assert.ok(intent.includes(refusal), `rust.lod-impostors names ${refusal}`);
    assert.ok(intent.includes("game.impostor_bake("), "rust.lod-impostors names game.impostor_bake");
    assert.ok(seedRecipe("rust.streamed-world").intent.includes("game.impostor_bake("), "the streamed world names it");
    const rules = section(read("CLAUDE.md"), "Game systems");
    assert.ok(rules.includes("game.impostor_bake("), "the guide's far things name game.impostor_bake");
  });

  it("sketch genex.toml rows the build accepts", () => {
    const toml = seedRecipe("rust.lod-impostors").sketch.split(RUST_SKETCH_FILE)[0] ?? "";
    assert.ok(toml.includes("lod_threshold_px") && toml.includes("far_density"), "the per-class LOD keys");
    const parsed = parseGenexToml(`[game]\ntitle = "Sketch"\n${toml.replace(/^#.*\n/, "")}`);
    assert.ok(parsed.ok, JSON.stringify(parsed));
  });

  it("are what the template guide's Game systems rules point at", () => {
    const rules = section(read("CLAUDE.md"), "Game systems");
    assert.ok(rules.includes("docs/api/drawing.md"), "far things route to the Drawing page");
    assert.ok(rules.includes(".with_impostor("), "the guide names impostors");
    assert.match(rules, /by (?:its|their) feet/, "the guide says a character stands by its feet");
    assert.ok(rules.includes("docs/api/input.md"), "input routes to the Input page");
  });
});

/** The game systems a `genex.toml` table switches (`[physics]`, `[audio]`, ...), as the manifest parser reads them. */
function switchedSystems(): string[] {
  const parsed = parseGenexToml(`[game]\ntitle = "Switches"\n`);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return Object.entries(parsed.manifest).flatMap(([key, value]) => (typeof value === "boolean" ? [key] : []));
}

/** The codes a switched-off system's calls are refused with, as the facade pins them (`nav-disabled`, ...). */
const SWITCH_REFUSALS = [...FACADE.installRefusals, ...FACADE.animation.refusals, ...FACADE.audio.refusals].filter(
  (code) => code.endsWith("-disabled"),
);

/** The `genex.toml` part of a sketch: everything before its first Rust file. */
const sketchToml = (sketch: string): string => sketch.split(/^\/\/ src\//m)[0] ?? "";

/** The system recipes whose sketches must switch on what they call, with the tables each needs on. */
const RECIPE_SWITCHES: Record<string, readonly string[]> = {
  "rust.streamed-world": ["streaming"],
  "rust.nav-agents": ["nav", "animation"],
  "rust.animated-characters": ["animation"],
  // Gate GR: the template ships audio off too, so its web export stays under 90% of the budget.
  "rust.audio-checks": ["audio"],
};

describe("the in-app agent knows every game system and its switch (R-32)", () => {
  const rules = () => section(read("CLAUDE.md"), "Game systems");

  it("the Game systems rules name each genex.toml switch and the code a switched-off system answers", () => {
    const systems = switchedSystems();
    assert.ok(systems.length >= 5, `the parser switches ${systems.join(", ")}`);
    for (const system of systems) assert.ok(rules().includes(`[${system}]`), `the rules name the [${system}] switch`);
    assert.ok(SWITCH_REFUSALS.length >= 4, `the facade pins ${SWITCH_REFUSALS.join(", ")}`);
    for (const code of SWITCH_REFUSALS) assert.ok(rules().includes(`\`${code}\``), `the rules name ${code}`);
  });

  it("the Game systems rules route a streamed world to the pack reader, its digest and named groups", () => {
    for (const call of ["CellPacks::from_table(", "genex::digest", "sim.stream.require(", "sim.stream.ready("])
      assert.ok(rules().includes(call), `the rules name ${call}`);
  });

  it("the Game systems rules teach only calls the fixture pins", () => {
    const pinned = new Set(
      pinnedCallGroups().flatMap(([, calls]) => calls.flatMap((call) => call.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])),
    );
    const unpinned = [...calledNames(rules())].filter((name) => !pinned.has(name) && !NOT_GAME_SYSTEMS_CALLS.has(name));
    assert.deepEqual(unpinned, []);
  });

  it("each system recipe's sketch switches on the tables its calls need, in rows the build accepts", () => {
    for (const [id, systems] of Object.entries(RECIPE_SWITCHES)) {
      const toml = sketchToml(seedRecipe(id).sketch);
      const parsed = parseGenexToml(`[game]\ntitle = "Sketch"\n${toml.replace(/^#.*\n/gm, "")}`);
      assert.ok(parsed.ok, `${id}: ${JSON.stringify(parsed)}`);
      const manifest = parsed.manifest as unknown as Record<string, unknown>;
      for (const system of systems) {
        assert.ok(toml.includes(`[${system}]`), `${id}'s sketch has a [${system}] row`);
        assert.equal(manifest[system], true, `${id} switches ${system} on`);
        assert.ok(toml.includes(`${system}-disabled`), `${id} names what a switched-off ${system} answers`);
      }
    }
  });

  it("the feet recipe teaches a Rust game to stand a character by its feet, with pinned calls", () => {
    const recipe = seedRecipe("characters.feet-on-the-ground") as SeedRecipe & { port?: string };
    const text = `${recipe.intent}\n${recipe.port ?? ""}`;
    for (const call of ["Character::spawn(", "terrain.height(", ".feet(", "plant_feet("])
      assert.ok(text.includes(call), `characters.feet-on-the-ground names ${call}`);
  });

  it("CLAUDE.own.md and the ladder skill name every switched-off system's code", () => {
    const own = read("CLAUDE.own.md");
    const skill = readFileSync(LADDER_SKILL, "utf8");
    assert.ok(own.includes("docs/api/"), "CLAUDE.own.md routes to the topic pages");
    for (const code of SWITCH_REFUSALS) {
      assert.ok(own.includes(code), `CLAUDE.own.md names ${code}`);
      assert.ok(skill.includes(code), `the ladder skill names ${code}`);
    }
  });
});
