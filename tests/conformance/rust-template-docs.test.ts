/**
 * The Rust game template's agent-facing docs (`src/game-template-rust/CLAUDE.md`,
 * `docs/CONTRACT.md`, `docs/GENEX_API.md`) agree with the contract they describe: every verb and
 * refusal code the contract page names is in the shared vocabularies (and every host verb is
 * named), the facade reference lists exactly the native features, input kinds and touch phases
 * the app knows, its determinism rules cover what the lane's lint file refuses, the two copies of
 * the reference are one byte-equal file, the docs link only to files the folder has, and neither
 * the docs nor the template leak a pinned eval brief to the in-app agent. The Rust eval case is a
 * draft in `evals/cases.md` that never names the stack.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
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

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TEMPLATE = path.join(REPO, "src", "game-template-rust");
const FACADE_DOCS = path.join(REPO, "native", "genex-rust", "docs", "GENEX_API.md");
const LANE_LINTS = path.join(REPO, "native", "genex-rust", "clippy.toml");
const RUST_CASE_ID = "touch-physics";

/** Words a user's brief never uses and the eval case must not name: the stack is the product's choice. */
const STACK_WORDS = /\b(rust|wgpu|webgpu|genex|rapier|egui|cargo)\b/i;

/** The `window.__studio` names the web shell adds beside the harness's `PageMethod` verbs (the page shapes of the C++ shell). */
const PAGE_ONLY_VERBS = ["version", "state", "input", "injectInput", "eye", "player", "capture"] as const;

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
};

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
const api = () => read("docs/GENEX_API.md");

/** The text of the `## <heading>` section, up to the next `## ` heading. */
function section(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  assert.ok(start >= 0, `no "## ${heading}" section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
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

  it("states the destinations' one GPU floor and its tiers", () => {
    const text = contract();
    for (const tier of values(NativeGpuTier)) assert.ok(text.includes(`\`${tier}\``), `tier ${tier} is not named`);
    assert.ok(text.includes("native-enhanced"));
    assert.match(text, /no WebGL|no fallback/i);
  });
});

describe("GENEX_API.md is the facade's reference", () => {
  it("is one byte-equal file with the facade crate's copy", () => {
    assert.equal(api(), readFileSync(FACADE_DOCS, "utf8"));
  });

  it("lists exactly the native features genex.toml accepts", () => {
    const paragraph = /Native features:([\s\S]*?)\.\s/.exec(section(api(), "genex.toml"))?.[1] ?? "";
    assert.deepEqual(ticked(paragraph).sort(), values(NativeEnhancedFeature).sort());
  });

  it("names every input kind and touch phase an injection or a script can carry", () => {
    const text = api();
    for (const kind of values(NativeInputKind)) assert.ok(text.includes(kind), `input kind ${kind} is not named`);
    for (const phase of values(TouchPhase))
      assert.ok(text.includes(`touch_${phase}`), `touch phase ${phase} is not named`);
  });

  it("names every key the state document reserves and every install refusal", () => {
    const text = section(api(), "Hooks");
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

  it("teaches every local-light and emission call, and the template points at them", () => {
    const text = api();
    for (const call of FACADE.lights.calls) assert.ok(text.includes(`${call}(`), `GENEX_API.md teaches ${call}(..)`);
    const guide = read("CLAUDE.md");
    for (const call of ["frame.point_light", "frame.spot_light", "Material::emissive("])
      assert.ok(guide.includes(call), `CLAUDE.md points at ${call}`);
  });

  it("states a determinism rule for everything the lane's lint file refuses", () => {
    const rules = section(api(), "Determinism");
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

describe("GENEX_API.md's Rendering chapter", () => {
  const chapter = () => section(api(), "Rendering");

  it(`is one chapter of at most ${RENDERING_WORDS_MAX} words`, () => {
    assert.ok(wordCount(chapter()) <= RENDERING_WORDS_MAX, `${wordCount(chapter())} words`);
  });

  it("names every value of the renderer vocabularies a game states or reads", () => {
    const named = codeWords(chapter());
    const missing = Object.entries(RENDER_VOCABULARIES).flatMap(([name, vocabulary]) =>
      Object.values(vocabulary)
        .filter((value) => !named.has(value))
        .map((value) => `${name}.${value}`),
    );
    assert.deepEqual(missing, []);
  });

  it("teaches the renderSettings verb's members, the settings panel and the Level-3 stages", () => {
    const named = codeWords(chapter());
    for (const member of RENDER_SETTINGS_MEMBERS) assert.ok(named.has(member), `renderSettings ${member}`);
    for (const word of ["renderSettings", "settings_panel"]) assert.ok(named.has(word), `${word}`);
    const stages = codeWords(section(api(), "Custom GPU passes"));
    for (const stage of PASS_STAGES) assert.ok(stages.has(stage), `stage ${stage} is not named`);
    const inChapter = codeWords(chapter());
    for (const stage of PASS_STAGES) assert.ok(inChapter.has(stage), `the chapter does not list stage ${stage}`);
  });

  it("leaves lights, meshlets and Level 2 to their own sections", () => {
    const headings = api()
      .split("\n")
      .filter((line) => line.startsWith("## "))
      .map((line) => line.slice(3));
    for (const heading of ["Lighting, materials and environment", "Big meshes", "Custom materials and post passes"])
      assert.ok(
        headings.some((line) => line.startsWith(heading)),
        `no "## ${heading}" section`,
      );
  });
});

describe("the template guide's rendering rules", () => {
  const rules = () => section(read("CLAUDE.md"), "Rendering");

  it(`stay rules: at most ${GUIDE_RENDERING_WORDS_MAX} words, and the reference holds the how`, () => {
    assert.ok(wordCount(rules()) <= GUIDE_RENDERING_WORDS_MAX, `${wordCount(rules())} words`);
  });

  it("tell an agent to use presets, state the look in [render], prefer built-ins and test as a phone", () => {
    const named = codeWords(rules());
    for (const word of ["render", "settings_panel", "renderSettings", "mobile-mid", "low", "ultra", "agx-punchy"])
      assert.ok(named.has(word), `the rules do not name ${word}`);
    assert.match(rules(), /never[^.\n]*\bultra\b/i, "the rules forbid a fixed ultra");
    assert.match(rules(), /built-in/i, "the rules prefer the built-ins to a custom pass");
    assert.match(rules(), /api = 2/, "the rules write sources at v2");
  });
});

describe("the seed's Rust recipes cite sections the reference has", () => {
  it("names a GENEX_API.md section in every evidence source", () => {
    const sections = new Set(
      api()
        .split("\n")
        .filter((line) => line.startsWith("## "))
        .map((line) => line.slice(3).trim()),
    );
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

describe("the agent-facing files agree with each other and the folder", () => {
  it("links only to files the template folder has", () => {
    const files = new Set(filesUnder(TEMPLATE));
    for (const page of ["CLAUDE.md", "docs/CONTRACT.md", "docs/GENEX_API.md"]) {
      const named = ticked(read(page)).filter((token) => /^(?:docs|web|assets|references)\/[\w./-]+\.\w+$/.test(token));
      for (const rel of named) assert.ok(files.has(rel), `${page} names ${rel}, which the template does not have`);
    }
  });

  it("CLAUDE.md points at the other two pages and the brief", () => {
    const text = read("CLAUDE.md");
    for (const target of ["docs/GENEX_API.md", "docs/CONTRACT.md", ".studio/BRIEF.md"])
      assert.ok(text.includes(target), `CLAUDE.md does not name ${target}`);
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
