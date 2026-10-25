/**
 * One check grammar (M4.8a).
 *
 * The vocabulary a planner writes checks in used to exist in three drifted copies: the planner
 * skill's SLOW_UPDATE region, the fallback autopilot uses when an install's skill predates typed
 * specs, and the director's `worker_start` tool schema. They had already stopped agreeing about
 * which helpers are in scope. `renderCheckGrammar` is now the only place the grammar is written,
 * and the skill ships the marker `{{check-grammar}}` where its copy used to be.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import * as pathMod from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHECK_GRAMMAR_HEADER,
  CHECK_GRAMMAR_MARKER,
  CHECK_KINDS,
  expandCheckGrammar,
  renderCheckGrammar,
} from "../../src/harness-seed/loop/spec.ts";
import { applyEdits } from "../../src/harness-seed/loop/skills.ts";
import { DIRECTOR_TOOLS } from "../../src/harness-seed/loop/director.ts";

const seedDir = pathMod.resolve(fileURLToPath(new URL("../../src/harness-seed", import.meta.url)));
const templateDir = pathMod.resolve(fileURLToPath(new URL("../../src/game-template", import.meta.url)));

function skill(): string {
  return readFileSync(pathMod.join(seedDir, "skills", "facet-decomposition.md"), "utf8");
}

/** The `<!-- SLOW_UPDATE -->…<!-- SLOW_UPDATE -->` region SkillOpt may not edit. */
function protectedRegion(text: string): string {
  const marker = "<!-- SLOW_UPDATE -->";
  const start = text.indexOf(marker);
  const end = text.indexOf(marker, start + marker.length);
  assert.ok(start >= 0 && end > start, "the skill still carries a protected region");
  return text.slice(start, end + marker.length);
}

describe("the check grammar has one source", () => {
  it("names every check kind exactly once", () => {
    const text = renderCheckGrammar();
    for (const kind of CHECK_KINDS) {
      const named = text.match(new RegExp(`^\\s*- ${kind}: `, "gm")) ?? [];
      assert.equal(named.length, 1, `${kind} is described exactly once`);
    }
  });

  it("takes its kinds from the caller, so a path that omits `metric` keeps omitting it", () => {
    // The planner's fallback deliberately has no `metric`: a kind that appeared there silently
    // would be a kind the planner started writing with no ratchet behind it in that path.
    const planner = renderCheckGrammar({
      kinds: ["scene", "pixel", "probe", "demo", "vision", "play"],
      helpers: false,
    });
    assert.equal(planner.includes("- metric:"), false);
    assert.ok(planner.includes("- scene:") && planner.includes("- play:"));
  });

  it("yields one line per kind with helpers off, and the helper lists with them on", () => {
    const compact = renderCheckGrammar({ helpers: false });
    assert.equal(compact.split("\n").length, CHECK_KINDS.length, "one line per kind, nothing else");
    for (const line of compact.split("\n")) assert.match(line, /^- [a-z]+: \{"kind":/);
    assert.equal(compact.includes("Helpers in scope:"), false);

    const full = renderCheckGrammar();
    assert.ok(full.length > compact.length, "the full grammar says more, not less");
    assert.match(full, /Helpers in scope: scene, renderer, camera, state, player, objects\(tag\)/);
    assert.match(full, /`needs` names up to four dotted paths/);
  });

  it("indents under a header and stands alone without one", () => {
    const headed = renderCheckGrammar({ header: CHECK_GRAMMAR_HEADER, helpers: false });
    assert.equal(headed.split("\n")[0], CHECK_GRAMMAR_HEADER);
    assert.match(headed.split("\n")[1]!, /^ {2}- scene: /);
    assert.match(renderCheckGrammar({ helpers: false }).split("\n")[0]!, /^- scene: /);
  });
});

describe("the planner skill ships the marker, not a copy", () => {
  it("carries {{check-grammar}} once, inside the SLOW_UPDATE region, with no second copy", () => {
    const text = skill();
    assert.equal(text.split(CHECK_GRAMMAR_MARKER).length - 1, 1, "the marker appears once");
    assert.ok(protectedRegion(text).includes(CHECK_GRAMMAR_MARKER), "the marker is inside the protected region");
    assert.equal(text.includes("Helpers in scope:"), false, "the skill no longer carries its own copy");
    assert.equal(text.includes("- Check shapes (fields per kind):"), false, "nor its own header");
  });

  it("expands to the grammar under the header the copy used to carry", () => {
    const expanded = expandCheckGrammar(skill());
    assert.equal(expanded.includes(CHECK_GRAMMAR_MARKER), false, "nothing is left to expand");
    assert.ok(expanded.includes(renderCheckGrammar({ header: CHECK_GRAMMAR_HEADER, helpers: true })), "verbatim");
    for (const kind of CHECK_KINDS) assert.ok(expanded.includes(`- ${kind}: `), `${kind} reaches the planner`);
  });

  it("leaves an older self-edited copy alone", () => {
    // A workspace whose SkillOpt-edited skill predates the marker keeps its own text: this is a
    // replace, never an assertion, so nothing breaks on an install that never saw the marker.
    const vintage = "Rules that never change:\n- some older text the analyst wrote\n";
    assert.equal(expandCheckGrammar(vintage), vintage);
  });

  it("cannot be edited away by SkillOpt", () => {
    const text = skill();
    const result = applyEdits(text, [
      { op: "replace", anchor: CHECK_GRAMMAR_MARKER, text: "- scene: whatever the analyst likes" },
      { op: "delete", anchor: CHECK_GRAMMAR_MARKER },
    ]);
    assert.equal(result.applied.length, 0, "neither edit lands");
    assert.equal(result.rejected.length, 2);
    for (const { reason } of result.rejected) assert.match(String(reason), /protected region/);
    assert.equal(result.text, text, "the file is untouched");
  });
});

describe("the director's tool schemas stay small", () => {
  it("does not grow, and the compact grammar is the shape it will shrink into", () => {
    // Claude ships these as an MCP schema and the Codex bridge prints them in full at the head
    // of every session, so their size is a per-turn tax on the director's context. The ceiling
    // is a ratchet: today's size, so nothing can be added without deciding to. The director's
    // own diet (M4.8b) brought it down from 17,001 to 16,912 — the three-line tool block, the
    // rendered check grammar and the clamped memory. Goal-directed generation then spent 1,491
    // bytes (16,995 to 18,486) on required outcomes the lead cannot mark passed itself —
    // goal_update, a worker's and a playtest's goal, a playtest's scenario, and a plan's
    // scope_instruction and multiplayer outcomes — and that spend is kept deliberately. So is
    // `wrap_up` (18,498 to 18,876, after trimming finish's user_asked): the user's ask to finish
    // had no tool, and words in the chat alone never stopped a worker. Computer use then spent 219
    // bytes (18,876 to 19,095) on playtest's goal_state, the state a blind judge plays to and the
    // studio verifies, also deliberately. So is wrap_up's next_goal and next_hours (19,095 to
    // 19,291): "stop it and start a new one" had no way to start the new Loop without the person.
    // The 15,000-byte target is NOT met; what is left is the fifteen tool descriptions themselves,
    // and cutting those is its own change.
    const size = JSON.stringify(DIRECTOR_TOOLS).length;
    assert.ok(size <= 19_300, `DIRECTOR_TOOLS serialises to ${size} bytes, over the ratchet`);

    // What the worker_start checks description is meant to become: the same grammar, one line
    // per kind, with no helper enumeration a tool schema cannot afford.
    const compact = renderCheckGrammar({
      kinds: ["scene", "pixel", "probe", "demo", "vision", "play"],
      helpers: false,
    });
    assert.ok(compact.length < 1_986, "the compact grammar is smaller than the copy it replaces");
  });
});

describe("the pages a builder is handed", () => {
  const page = (rel: string) => readFileSync(pathMod.join(templateDir, rel), "utf8");

  it("keeps CLAUDE.md to five rules on one screen", () => {
    const text = page("CLAUDE.md");
    assert.ok(text.split("\n").length <= 31, `CLAUDE.md is ${text.split("\n").length} lines`);
    const rules = text.match(/^\d+\. /gm) ?? [];
    assert.deepEqual(rules, ["1. ", "2. ", "3. ", "4. ", "5. "]);
  });

  it("keeps CONTRACT.md to the tables, including the one written for a game the studio did not write", () => {
    const text = page("docs/CONTRACT.md");
    // 121 after M4.8a's diet; 127 once the three harness-owned modules became real `###`
    // sections rather than bold run-ins (`projects.test.ts` looks for the Assets heading, and
    // CLAUDE.md rule 5 sends a builder to it by name); 150 with M4's attachment paragraph, the
    // two-line install and the `bootMs`/`game` rows — the words three lanes asked this page for.
    assert.ok(text.split("\n").length <= 150, `CONTRACT.md is ${text.split("\n").length} lines`);
    // prompts/optimization.md and judge/optimization-preserve.md grade against this paragraph:
    // it is the only written contract for a custom runtime, and cutting it cut the definition.
    assert.equal(text.split("app-owned observer").length - 1, 1);
    assert.match(text, /## Optimization-stage observation/);
    assert.match(text, /## Renderers/, "the WebGPU sentences have a home");
  });

  it("keeps CLAUDE.own.md's four substitution tokens where game-workspace fills them in", () => {
    const text = page("CLAUDE.own.md");
    for (const token of ["__ENTRY_MAIN__", "__SERVED_ENTRY__", "__BUILD_LINE__", "__BUILD_RULE__"]) {
      assert.ok(text.includes(token), `${token} is still substituted`);
    }
  });

  it("numbers CLAUDE.own.md's rules 1..6 with no gap or repeat, with a build and without", () => {
    // Rule 6 is hard-coded in game-workspace.ts's ownRules: renumbering here silently produces a
    // page with two rule 5s or no rule 6.
    const text = page("CLAUDE.own.md");
    const numbers = (body: string) => (body.match(/^(\d+)\. /gm) ?? []).map((line) => Number(line.trim().slice(0, -1)));
    assert.deepEqual(numbers(text.replace("__BUILD_RULE__", "")), [1, 2, 3, 4, 5]);
    assert.deepEqual(
      numbers(text.replace("__BUILD_RULE__", "6. **Run `npm run build` before you finish**")),
      [1, 2, 3, 4, 5, 6],
    );
  });

  it("ships exactly the two skills the run code reads", () => {
    // director.md and facet-decomposition.md are read by name; four more used to ship and were
    // read by nothing, which is what RETIRED_SEED_PATHS now takes off an install.
    assert.deepEqual(readdirSync(pathMod.join(seedDir, "skills")).sort(), ["director.md", "facet-decomposition.md"]);
  });
});
