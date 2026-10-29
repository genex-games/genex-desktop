/**
 * The Rust template docs check (`scripts/check-template-docs.ts`, run by `verify:context`): an
 * agent with no training data on the genex facade reads only these pages, so every path they name
 * opens in the game folder, every page anchor exists, every compiled snippet is byte-equal to the
 * compiled region it mirrors, and every other Rust snippet calls only names the facade defines.
 * Each row builds a small repository: a template folder, a facade crate and seed skills.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkTemplateDocs, TemplateDocsRule } from "../../scripts/check-template-docs.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TEMPLATE = "src/game-template-rust";
const FACADE_SRC = "native/genex-rust/crates/genex/src";

/** The facade the rows' snippets resolve against: a sky, a moon and a frame with a sun. */
const FACADE = `
pub struct Moon { direction: [f32; 3] }
impl Moon {
    pub fn new(direction: [f32; 3]) -> Moon { Moon { direction } }
    pub fn with_moonlight(self, lux: f32) -> Moon { self }
}
#[derive(Default)]
pub struct SkyParams;
pub struct Frame;
impl<'a> Frame {
    pub fn sun(&mut self, direction: Vec3, color: Color) {}
}
pub use crate::render::{RenderConfig as Render};
`;

/** A compiled example source holding one region a page mirrors. */
const EXAMPLE = `fn look() {
    // region: look/night
    let moon = Moon::new([0.2, 0.6, 0.8]);
    frame.sun(vec3(0.0, -1.0, 0.0), Color::WHITE);
    // endregion
}
`;

async function repo(pages: Record<string, string>): Promise<string> {
  const root = await tmpDir("template-docs-");
  const write = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  write(`${FACADE_SRC}/lib.rs`, FACADE);
  write(`${TEMPLATE}/docs/examples/night/src/game.rs`, EXAMPLE);
  write(`${TEMPLATE}/docs/api/lighting.md`, "# Lighting\n\n## Night sky\n\nThe moon.\n");
  for (const [rel, text] of Object.entries(pages)) write(rel, text);
  return root;
}

/** The rule ids the check reported, in order. */
const rules = (findings: ReturnType<typeof checkTemplateDocs>) => findings.map((finding) => finding.rule);

describe("the template docs' paths open in the game folder", () => {
  it("passes a page whose paths, links and anchors all resolve", async () => {
    const root = await repo({
      [`${TEMPLATE}/CLAUDE.md`]:
        "Read `docs/api/lighting.md`, [the night sky](docs/api/lighting.md#night-sky) and `docs/examples/night/`.\n",
    });
    assert.deepEqual(checkTemplateDocs(root), []);
  });

  const hostile: Array<[string, string, string]> = [
    ["a missing page", "See `docs/api/moon.md`.", TemplateDocsRule.MissingPath],
    ["a missing example folder", "Copy `docs/examples/forest/`.", TemplateDocsRule.MissingPath],
    ["a missing linked page", "[Moon](docs/api/moon.md)", TemplateDocsRule.MissingPath],
    ["a missing anchor", "[Moon](docs/api/lighting.md#the-moon)", TemplateDocsRule.MissingAnchor],
    ["a path outside the game folder", "Copy `native/genex-rust/examples/menus-saves`.", TemplateDocsRule.OutsidePath],
    ["a link that climbs out", "[Repo](../../../../AGENTS.md)", TemplateDocsRule.OutsidePath],
    ["an absolute path", "Open `/etc/passwd.md`.", TemplateDocsRule.OutsidePath],
    [
      "a chapter named by title",
      "a `material` source (see Custom materials and post passes)",
      TemplateDocsRule.TitleReference,
    ],
  ];
  for (const [name, text, rule] of hostile)
    it(`refuses ${name}`, async () => {
      const root = await repo({ [`${TEMPLATE}/docs/api/rendering.md`]: `# Rendering\n\n${text}\n` });
      const findings = checkTemplateDocs(root);
      assert.deepEqual(rules(findings), [rule], JSON.stringify(findings));
      assert.equal(findings[0]?.file, `${TEMPLATE}/docs/api/rendering.md`);
      assert.equal(findings[0]?.line, 3);
    });

  it("reads a seed skill's game-folder paths against the template", async () => {
    const root = await repo({
      "src/harness-seed/skills/look-dev.md": "---\nname: Look dev\ndescription: d\n---\nRead `docs/look-recipes.md`.\n",
    });
    assert.deepEqual(rules(checkTemplateDocs(root)), [TemplateDocsRule.MissingPath]);
  });

  it("leaves fenced code, URLs and the game's own runtime folders alone", async () => {
    const root = await repo({
      [`${TEMPLATE}/CLAUDE.md`]:
        '```toml\npath = "docs/none.md"\n```\n[site](https://example.com/a.md) and `assets/kit/` and `state/` and `src/facets/<slug>.rs`.\n',
    });
    assert.deepEqual(checkTemplateDocs(root), []);
  });
});

describe("the template docs' Rust snippets", () => {
  it("passes a compiled snippet byte-equal to its region, at any indentation", async () => {
    const root = await repo({
      [`${TEMPLATE}/docs/look-recipes.md`]:
        "# Looks\n\n<!-- compiled: look/night -->\n```rust\nlet moon = Moon::new([0.2, 0.6, 0.8]);\nframe.sun(vec3(0.0, -1.0, 0.0), Color::WHITE);\n```\n",
    });
    assert.deepEqual(checkTemplateDocs(root), []);
  });

  it("refuses a compiled snippet that drifted from its region, and one whose region is gone", async () => {
    const root = await repo({
      [`${TEMPLATE}/docs/look-recipes.md`]:
        "# Looks\n\n<!-- compiled: look/night -->\n```rust\nlet moon = Moon::new(dir);\n```\n\n<!-- compiled: look/forest -->\n```rust\nlet x = 1;\n```\n",
    });
    assert.deepEqual(rules(checkTemplateDocs(root)), [TemplateDocsRule.SnippetDrift, TemplateDocsRule.SnippetRegion]);
  });

  it("passes calls the facade defines, derived defaults, re-exports and the snippet's own types", async () => {
    const root = await repo({
      [`${TEMPLATE}/docs/api/lighting.md`]:
        "# Lighting\n\n## Night sky\n\n```rust\nuse genex::Render;\nstruct Mine;\nimpl Mine { fn new() -> Mine { Mine } }\nlet sky = SkyParams::default();\nlet moon = Moon::new([0.0, 1.0, 0.0]).with_moonlight(0.3);\nlet mine = Mine::new();\nframe.sun(dir, Color::WHITE);\n```\nInline `Moon::new([0.0, 1.0, 0.0])` too.\n",
    });
    assert.deepEqual(checkTemplateDocs(root), []);
  });

  const unknown: Array<[string, string]> = [
    ["an associated call the type lacks", "let moon = Moon::from_angle(0.3);"],
    ["a type the facade lacks", "let sky = Sky::overcast();"],
    ["a builder the facade lacks", "let moon = Moon::new(d).with_phase(0.5);"],
    ["a frame call the facade lacks", "frame.moon(d);"],
    ["an import the facade lacks", "use genex::render::Skybox;"],
  ];
  for (const [name, code] of unknown)
    it(`refuses ${name}`, async () => {
      const root = await repo({ [`${TEMPLATE}/docs/api/sky.md`]: `# Sky\n\n\`\`\`rust\n${code}\n\`\`\`\n` });
      const findings = checkTemplateDocs(root);
      assert.deepEqual(rules(findings), [TemplateDocsRule.UnknownName], JSON.stringify(findings));
      assert.equal(findings[0]?.line, 4);
    });

  it("refuses an unknown associated call named inline in prose", async () => {
    const root = await repo({ [`${TEMPLATE}/CLAUDE.md`]: "Light it with `Moon::full(direction)`.\n" });
    assert.deepEqual(rules(checkTemplateDocs(root)), [TemplateDocsRule.UnknownName]);
  });
});

describe("the shipped template docs", () => {
  it("pass the check", () => {
    const findings = checkTemplateDocs(REPO);
    assert.deepEqual(
      findings.map((finding) => `${finding.file}:${finding.line} ${finding.rule} ${finding.text}`),
      [],
    );
  });
});
