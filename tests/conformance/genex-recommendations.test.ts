/**
 * Genex's own craft advice (multiplayer patterns, cover craft, where assets come from) is a plugin of
 * its own, `genex-recommendations`, that Studio ships off: a fresh profile installs it switched off,
 * so no brief carries a line of it and no agent has its skill tool. Turned on, each of its skills is
 * one line in the brief and is read on demand through its own skill tool; the `genex` plugin keeps
 * only Genex's product requirements and API facts.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { GENEX_RECOMMENDATIONS_PLUGIN_ID } from "../../src/shared/plugin-id.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";

const ID = GENEX_RECOMMENDATIONS_PLUGIN_ID;
/** The advice the plugin holds, by skill name. */
const SKILLS = ["multiplayer-patterns", "cover-craft", "asset-sources", "shop-design"];

describe("genex-recommendations", () => {
  let lite: CoreLite;
  before(async () => {
    lite = await coreLite();
  });
  after(() => lite.close());

  const briefLines = () =>
    lite.core.plugins
      .guidance()
      .split("\n")
      .filter((line) => line.startsWith(`[${ID}/`));
  const skillTool = () => lite.core.plugins.tools().find((tool) => tool.name === `${ID}__skill`);

  it("ships with Studio and is off in a new profile: no brief line, no skill tool", () => {
    const installed = lite.core.plugins.list().find((plugin) => plugin.manifest.id === ID);
    assert.ok(installed, "a bundled plugin");
    assert.equal(installed.enabled, false);
    assert.deepEqual(briefLines(), []);
    assert.equal(skillTool(), undefined);
    assert.ok(lite.core.plugins.enabled("genex"), "Genex itself stays on");
  });

  it("turned on, puts one line per skill in the brief and reads each on demand", async () => {
    await lite.core.plugins.setEnabled(ID, true);
    try {
      assert.deepEqual(
        briefLines().map((line) => line.slice(ID.length + 2, line.indexOf("]"))),
        SKILLS,
      );
      assert.ok(skillTool(), "its skill tool is offered");
      const binding = { project: "harbour-run", directory: lite.gamesRoot };
      for (const name of SKILLS) {
        const page = (await lite.core.plugins.tool(`${ID}__skill`, { name }, binding)) as { text: string };
        assert.ok(page.text.length > 200, `${name} reads`);
      }
    } finally {
      await lite.core.plugins.setEnabled(ID, false);
    }
    assert.deepEqual(briefLines(), [], "off again, it is gone from the brief");
  });

  it("holds the advice the genex plugin no longer carries", () => {
    const genex = lite.core.plugins.list().find((plugin) => plugin.manifest.id === "genex");
    const genexSkills = new Set(genex?.manifest.skills.map((skill) => skill.name));
    for (const moved of ["asset-preference", "genex-cover"])
      assert.ok(!genexSkills.has(moved), `${moved} is no longer a genex skill`);
  });
});
