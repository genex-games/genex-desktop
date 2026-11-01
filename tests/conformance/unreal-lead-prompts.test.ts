/**
 * What the Unreal lead is told: a lean brief with the owner's whole goal, its time, its hands and
 * eyes, its workers and saving, its run tools spelled the way its engine calls them, and the facts of
 * the template the game is actually built on, never another's — and no rule about how the game should
 * look or in what order it is built; a save point's answer; and the harness's steers, the owner's
 * words to be acted on now. Asserted through each function's output.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GameEngine } from "../../src/harness-seed/loop/game-engine.ts";
import { launchRules } from "../../src/harness-seed/loop/launch-prompts.ts";
import { BRIDGE_TOOL_CMD, EngineId } from "../../src/harness-seed/loop/model-roles.ts";
import { LeadTool } from "../../src/harness-seed/loop/unreal/lead-contract.ts";
import { type Lead, newLeadJournal } from "../../src/harness-seed/loop/unreal/lead-journal.ts";
import {
  type LeadBriefOptions,
  leadBrief,
  SAVE_POINT_WORDS,
  STEER,
} from "../../src/harness-seed/loop/unreal/lead-prompts.ts";
import { runStatusText } from "../../src/harness-seed/loop/unreal/lead-tools.ts";
import type { Run } from "../../src/harness-seed/types/harness.d.ts";
import { TemplateKind } from "../../src/harness-seed/loop/unreal/template-kind.ts";
import { CoreFact } from "../../src/harness-seed/loop/folder-facts.ts";
import { appIdentity } from "../../src/harness-seed/loop/project-prompts.ts";

/** What an Unreal lead's game holds when its options say nothing else. */
const UNREAL_PROJECT = [{ id: CoreFact.UnrealProject, path: "." }];

/**
 * The brief's own words may grow to this, before the goal, the handover, NOTES.md, the template's
 * facts and Genex's identity, which every brief opens with (`appIdentity`).
 */
const BRIEF_CAP_CHARS = 7_000;

const OPTIONS: LeadBriefOptions = {
  engine: EngineId.ClaudeCode,
  project: "/games/tower/unreal/Tower.uproject",
  goal: "A third-person game in an endless concrete tower.",
  title: "Tower",
  template: "",
  templateKind: TemplateKind.ThirdPerson,
  minutes: 180,
  cpp: false,
  offers: { blender: true, genex: true },
  references: [],
  handover: "",
  notes: "",
};

/** A defect the critic saw in two looks in a row. */
const SLAB = {
  defect: "The hero's cloak reads as a black slab from behind",
  fix: "Give the cloak its own cloth piece",
};

/** Vehicle and track words a game that isn't a vehicle game must never hear. */
const VEHICLE_WORDS =
  /vehicle|supercross|motocross|dirt|whoops|GenexRoute|set_route|track_terrain|dirt_material|off-road|bike/i;

describe("the Unreal lead's brief", () => {
  it("stays lean: the brief's own words fit the cap", () => {
    const brief = leadBrief(OPTIONS).replace(appIdentity({ folderLabel: "", facts: UNREAL_PROJECT }), "");
    assert.ok(brief.length <= BRIEF_CAP_CHARS, `${brief.length} characters`);
  });

  it("carries the owner's goal whole, however long", () => {
    const goal = `${"A tower of stairs and bridges in fog. ".repeat(90)}The last line matters.`;
    assert.ok(goal.length > 3000);
    assert.ok(leadBrief({ ...OPTIONS, goal }).includes(goal));
  });

  it("says the game folder holds the lead's project, notes and scripts, never only its notes, and names no title as a folder", () => {
    const brief = leadBrief(OPTIONS);
    assert.doesNotMatch(brief, /holds only the game's notes/);
    assert.doesNotMatch(brief, /folder `Tower`/);
    assert.doesNotMatch(brief, /keep NOTES\.md|current with what you built/i, "no upkeep of notes is ordered");
  });

  it("offers only the workers the plugins on now can run, by the worker types they declare", () => {
    const sub = (brief: string) => brief.slice(brief.indexOf("WORKERS:"), brief.indexOf("SAVING"));
    // The worker types the plugins that are on declare decide (`plugins.workerTypes`).
    const declared = sub(leadBrief({ ...OPTIONS, offers: { blender: true, genex: true, types: ["blender_model"] } }));
    assert.match(declared, /blender_model/);
    assert.doesNotMatch(declared, /blender_prep|genex_cast|  - sound|texture:/);
    // A host that could not list them: the kinds' own tools decide, as before.
    const noBlender = sub(leadBrief({ ...OPTIONS, offers: { blender: false, genex: true } }));
    assert.doesNotMatch(noBlender, /blender_model|blender_prep/);
    assert.match(noBlender, /genex_cast/);
    assert.match(noBlender, /texture: [^\n]*Genex/, "a texture still comes from Genex");
    const noGenex = sub(leadBrief({ ...OPTIONS, offers: { blender: true, genex: false } }));
    assert.doesNotMatch(noGenex, /genex_cast|  - sound/);
    assert.match(noGenex, /blender_model/);
    const neither = leadBrief({ ...OPTIONS, offers: { blender: false, genex: false } });
    assert.doesNotMatch(neither, /blender_model|genex_cast|texture:/);
  });

  it("tells a third-person game nothing about vehicles or tracks", () => {
    for (const kind of [TemplateKind.ThirdPerson, TemplateKind.Combat, TemplateKind.FirstPerson, TemplateKind.Other])
      assert.doesNotMatch(leadBrief({ ...OPTIONS, templateKind: kind }), VEHICLE_WORDS, kind);
  });

  it("tells each game its own template's facts", () => {
    assert.match(leadBrief({ ...OPTIONS, templateKind: TemplateKind.Combat }), /Combat variant[^\n]*combo/);
    assert.match(leadBrief({ ...OPTIONS, templateKind: TemplateKind.Vehicle }), /wheeled vehicle/);
    const facts = "Game mode: BP_ThirdPersonGameMode spawns BP_ThirdPersonCharacter as the player.";
    assert.match(leadBrief({ ...OPTIONS, template: facts }), /THE TEMPLATE:[\s\S]*BP_ThirdPersonCharacter/);
  });

  // Flipped (phase 5): no's never stop a Loop, and the reviewer is a second opinion the lead asks for.
  it("tells the lead its finish closes the run, and a review is a second opinion it may ask for", () => {
    for (const untilFinish of [true, false, undefined]) {
      const brief = leadBrief({ ...OPTIONS, untilFinish });
      assert.match(
        brief,
        /finish with a summary closes the run; with review=yes a reviewer[^\n]*its no decides nothing/,
      );
      assert.doesNotMatch(brief, /no's in a row|stop the Loop/);
    }
  });

  it("names its hands and eyes, and no rule about the look, a checklist or an order of work", () => {
    const brief = leadBrief(OPTIONS);
    assert.match(brief, /run_script[^\n]*unreal\/build\//);
    assert.match(brief, /capture_shot[^\n]*capture_play[^\n]*motion_strip/);
    assert.match(brief, /MCP timeout does not cancel/);
    // Flipped (phase 5): the look-first pipeline, ART.md, the tone gates and hero cameras are gone.
    for (const rule of [
      /ART\.md/,
      /Gate 0/,
      /first 30 minutes/,
      /ORDER OF WORK/,
      /REQUIRED/,
      /only builder/,
      /up to 6 of them/,
    ])
      assert.doesNotMatch(brief, rule);
  });

  it("names the restart for an editor that renders differently from play", () => {
    assert.match(leadBrief(OPTIONS), /mcp__studio__rebuild_unreal[^\n]*renders differently from play/);
  });

  it("asks run_status for the time instead of guessing it, and the time is a cap", () => {
    const brief = leadBrief({ ...OPTIONS, minutes: 54 });
    assert.match(brief, new RegExp(`mcp__studio__${LeadTool.RunStatus}[^\n]*minutes left`));
    assert.match(brief, /a cap rather than a quota/);
    // Flipped (phase 5): no cadence rule tells it to keep building until Genex says to wrap up.
    assert.doesNotMatch(brief, /Never wind down on your own/);
  });

  it("names what a milestone is: a column on the owner's graph", () => {
    assert.match(leadBrief(OPTIONS), /milestone names what you work on now \(a column on the owner's Builds graph\)/);
  });

  it("spells its run tools the way its engine calls them", () => {
    assert.match(leadBrief(OPTIONS), new RegExp(`mcp__studio__${LeadTool.SavePoint}`));
    const codex = leadBrief({ ...OPTIONS, engine: EngineId.Codex });
    assert.ok(codex.includes(`${BRIDGE_TOOL_CMD} ${LeadTool.WorkerStart}`));
    assert.doesNotMatch(codex, /mcp__studio__/);
  });

  it("offers C++ sub-agents only when the game can take C++", () => {
    assert.doesNotMatch(leadBrief(OPTIONS), /- cpp:/);
    assert.match(leadBrief({ ...OPTIONS, cpp: true }), /- cpp:/);
  });

  it("opens a fresh session with its handover and NOTES.md before the rules", () => {
    const brief = leadBrief({
      ...OPTIONS,
      handover: "THE CHAT SO FAR: make it foggy",
      notes: "# Tower\nBuilt the stair.",
    });
    assert.ok(brief.indexOf("THE CHAT SO FAR") < brief.indexOf("HANDS AND EYES"));
    assert.match(brief, /Built the stair\./);
  });
});

describe("a save point's answer", () => {
  const POINT = {
    label: "Stair pass",
    snapshotId: "snap-3",
    at: 0,
    summary: "",
    thumbnails: [],
    milestoneId: "lead",
    round: 3,
    auto: false,
    logErrors: [],
  };

  // Flipped (phase 5): no tone gate calls a thumbnail too dark, and no critic's item is required.
  it("says what was saved, Unreal's new log errors and the minutes left, and judges no picture", () => {
    const tone = { p2: 0, p98: 0.03, mean: 0.01, std: 0.01, nearStd: 0.01, farStd: 0.01, saturation: 0, clipped: 0 };
    const dark = { ...POINT, thumbnails: [{ camera: "GX_Shot_Ant", path: "/r/a.jpg", tone }] };
    const answer = SAVE_POINT_WORDS.Answer(dark, 40);
    assert.match(answer, /Saved 'Stair pass' \(snapshot snap-3\)[\s\S]*no new errors[\s\S]*About 40 minutes are left/);
    assert.doesNotMatch(answer, /Nearly black|REQUIRED/);
  });

  it("are not in run_status as required items", () => {
    const journal = newLeadJournal({ runId: "r1", goal: "", project: "tower" } as unknown as Run, {
      folder: "/games/tower",
      chatSession: false,
      sessionId: null,
      bookmarked: null,
      engine: undefined,
      model: null,
    });
    journal.critiques.push({
      at: 0,
      shots: ["a.png"],
      question: null,
      milestoneId: "lead",
      round: 1,
      defects: [],
      required: [SLAB],
    });
    const lead = { journal, clock: { now: () => 0 }, softDeadline: 60_000 } as unknown as Lead;
    assert.doesNotMatch(runStatusText(lead), /REQUIRED|black slab/);
  });
});

describe("the harness's steers into the lead's turn", () => {
  it("asks the lead to act on the owner's words now, not when it fits the run", () => {
    const said = STEER.OwnerWords("use Blender for the stairs");
    assert.match(said, /use Blender for the stairs/);
    assert.match(
      said,
      /Act on this now unless it conflicts with the edit you are in the middle of; then do it right after\./,
    );
    assert.doesNotMatch(said, /when it fits/);
  });

  it("says what a crash may have lost, and where a cold restore went", () => {
    assert.match(
      STEER.Crashed("14:05", "Atmosphere pass"),
      /crashed at 14:05[\s\S]*since save point 'Atmosphere pass' may be lost/,
    );
    assert.match(STEER.Crashed("14:05", null), /since the run began/);
    assert.match(STEER.Restored("14:05", "Atmosphere pass"), /back to save point 'Atmosphere pass'/);
  });
});

describe("the Unreal Loop as a Loop chat describes it", () => {
  it("is one lead building the whole game in the open editor with small helpers, not parts written in parallel", () => {
    const rules = launchRules(EngineId.ClaudeCode, { toolName: "start_autopilot", hours: 3 }, GameEngine.Unreal);
    const said = rules.join("\n");
    assert.match(said, /one lead works in the open Unreal editor, with helpers in copies of the game/);
    assert.doesNotMatch(said, /in parallel|as parts|one at a time/);
    const open = launchRules(EngineId.ClaudeCode, { toolName: "start_autopilot" }, GameEngine.Unreal).join("\n");
    assert.doesNotMatch(open, /judges/, "no judge decides an Unreal run's end");
    const web = launchRules(EngineId.ClaudeCode, { toolName: "start_autopilot", hours: 3 }).join("\n");
    assert.doesNotMatch(web, /look first/);
  });

  // Flipped (phase 5): the chat is not told how to write a goal (the look first, before mechanics).
  it("asks the chat for the goal in the user's words, with no rule about the look", () => {
    const said = launchRules(EngineId.ClaudeCode, { toolName: "start_autopilot", hours: 3 }, GameEngine.Unreal).join(
      "\n",
    );
    assert.match(said, /with the goal in the user's words/);
    assert.doesNotMatch(said, /look first|before mechanics|list of features/);
  });
});
