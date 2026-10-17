/**
 * What the Unreal lead is told: a lean brief with the owner's whole goal, the look-first discipline,
 * hands and eyes, the checklist, sub-agents and saving, its run tools spelled the way its engine
 * calls them, and the facts of the template the game is actually built on, never another's; the
 * digest a later turn opens with; and the harness's steers, the owner's words to be acted on now.
 * Asserted through each function's output.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GameEngine } from "../../src/harness-seed/loop/game-engine.ts";
import { launchRules } from "../../src/harness-seed/loop/launch-prompts.ts";
import { BRIDGE_TOOL_CMD, EngineId } from "../../src/harness-seed/loop/model-roles.ts";
import { LeadTool } from "../../src/harness-seed/loop/unreal/lead-contract.ts";
import { type Lead, newLeadJournal } from "../../src/harness-seed/loop/unreal/lead-journal.ts";
import {
  digestPrompt,
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
    assert.match(brief, /NOTES\.md/);
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

  it("is the only builder, looks first, and judges by its own clean captures", () => {
    const brief = leadBrief(OPTIONS);
    assert.match(brief, /only builder/);
    assert.match(brief, /ART\.md/);
    assert.match(brief, /first 30 minutes[^\n]*light[^\n]*atmosphere[^\n]*GX_Shot_/);
    assert.match(brief, /run_script[^\n]*unreal\/build\//);
    assert.match(brief, /capture_shot[^\n]*capture_play[^\n]*motion_strip/);
    assert.match(brief, /Gate 0[\s\S]*Gate 1[^\n]*0\.05[^\n]*0\.18[\s\S]*Gate 2/);
    assert.match(brief, /MCP timeout does not cancel/);
    assert.match(brief, /Never save or say done about a change you haven't looked at/);
    assert.match(brief, /what you did not test/);
  });

  it("puts the look first, then the checked cast, then mechanics, and the critic's required items before anything new", () => {
    const brief = leadBrief(OPTIONS);
    assert.match(brief, /ORDER OF WORK[^\n]*the look[^\n]*then the cast[^\n]*front, side and back[^\n]*then mechanics/);
    assert.match(brief, /REQUIRED[^\n]*before any new mechanic/);
  });

  it("names the restart for an editor that renders differently from play, and asks for hero cameras that are key art only", () => {
    const brief = leadBrief(OPTIONS);
    assert.match(brief, /mcp__studio__rebuild_unreal[^\n]*restart/);
    assert.match(brief, /up to 6 of them[^\n]*a test camera gets another name/);
  });

  it("keeps building until Genex says to wrap up, and asks run_status for the time instead of guessing it", () => {
    const brief = leadBrief({ ...OPTIONS, minutes: 54 });
    assert.match(brief, /Never wind down on your own/);
    assert.match(brief, new RegExp(`mcp__studio__${LeadTool.RunStatus}[^\n]*minutes left`));
  });

  it("names a milestone before its first save point, so the owner's graph has columns", () => {
    assert.match(leadBrief(OPTIONS), /before your first save point/);
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
    assert.ok(brief.indexOf("THE CHAT SO FAR") < brief.indexOf("only builder"));
    assert.match(brief, /Built the stair\./);
  });
});

describe("the digest a later turn opens with", () => {
  it("says the time left, the owner's words, the sub-agents' news, the jobs that ended, the last save, the critic and the credits", () => {
    const text = digestPrompt("claude-code", {
      minutesLeft: 95,
      ownerWords: ["make the fog thicker"],
      agentNews: ["blender_model-1 (Katana) done: assets/agents/blender_model-1/katana.glb"],
      lastSave: { label: "Atmosphere pass", minutesAgo: 12 },
      advice: [
        {
          at: 0,
          shots: ["s1.png"],
          question: null,
          milestoneId: "lead",
          round: 2,
          defects: [{ defect: "The key light is flat.", fix: "Lower the sun to 12 degrees." }],
          boldMove: "Drop the camera to the floor of the shaft.",
          gates: [],
        },
      ],
      carried: ["Genex saved your unsaved work as 'Autosave'."],
      jobs: ["Light bake (`run bake`, started by you) failed (exit 1) after 2 min; read it with job_tail j1."],
      credits: { spent: 120, cap: 600 },
      freshEyesDue: null,
      required: [SLAB],
    });
    assert.match(text, /About 95 minutes are left/);
    assert.match(
      text,
      /REQUIRED[^\n]*\n- The hero's cloak reads as a black slab from behind — fix: Give the cloak its own cloth piece/,
    );
    assert.ok(text.indexOf("REQUIRED") < text.indexOf("Workers:"), "the required items lead the digest");
    assert.match(text, /make the fog thicker\nAct on this now/);
    assert.match(text, /katana\.glb/);
    assert.match(text, /Jobs:\n- Light bake \(`run bake`, started by you\) failed/);
    assert.match(text, /'Atmosphere pass', 12 minutes ago/);
    assert.match(text, /The key light is flat\. Fix: Lower the sun/);
    assert.match(text, /Bold move: Drop the camera/);
    assert.match(text, /Autosave/);
    assert.match(text, /120 of 600/);
  });

  it("leaves out what has nothing to say", () => {
    const text = digestPrompt("claude-code", {
      minutesLeft: null,
      ownerWords: [],
      agentNews: [],
      lastSave: null,
      advice: [],
      carried: [],
      jobs: [],
      credits: { spent: 0, cap: null },
      freshEyesDue: null,
      required: [],
    });
    assert.doesNotMatch(text, /owner says|Workers:|Jobs:|critic|REQUIRED/);
    assert.match(text, /No save point yet/);
  });
});

describe("the critic's required items after the digest", () => {
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

  it("call out a nearly black thumbnail as a render to doubt, with the restart named", () => {
    const tone = { p2: 0, p98: 0.03, mean: 0.01, std: 0.01, nearStd: 0.01, farStd: 0.01, saturation: 0, clipped: 0 };
    const dark = { ...POINT, thumbnails: [{ camera: "GX_Shot_Ant", path: "/r/a.jpg", tone }] };
    assert.match(SAVE_POINT_WORDS.Saved(dark), /GX_Shot_Ant:[^\n]*Nearly black[^\n]*rebuild_unreal/);
    const lit = { ...POINT, thumbnails: [{ camera: "GX_Shot_Ant", path: "/r/a.jpg", tone: { ...tone, p98: 0.8 } }] };
    assert.doesNotMatch(SAVE_POINT_WORDS.Saved(lit), /Nearly black/);
  });

  it("follow every save point's answer, before the minutes left", () => {
    const answer = SAVE_POINT_WORDS.Answer(POINT, 40, [SLAB]);
    assert.match(answer, /Saved 'Stair pass'[\s\S]*REQUIRED[\s\S]*black slab[\s\S]*About 40 minutes are left/);
    assert.doesNotMatch(SAVE_POINT_WORDS.Answer(POINT, 40, []), /REQUIRED/);
  });

  it("are in run_status", () => {
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
      boldMove: "",
      gates: [],
      required: [SLAB],
    });
    const lead = { journal, clock: { now: () => 0 }, softDeadline: 60_000 } as unknown as Lead;
    assert.match(runStatusText(lead), /REQUIRED[\s\S]*black slab/);
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

  it("asks for a look and a save point, and at the end for the wrap-up, with the tool spelled for the engine", () => {
    assert.match(STEER.SaveNow(EngineId.ClaudeCode, 15), /15 minutes[\s\S]*Look[\s\S]*mcp__studio__save_point/);
    const wrap = STEER.WrapUp(EngineId.Codex, 12);
    assert.ok(wrap.includes(`${BRIDGE_TOOL_CMD} ${LeadTool.SavePoint}`));
    assert.match(wrap, /"Final"[\s\S]*NOTES\.md[\s\S]*did not test/);
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
    assert.match(said, /one lead builds the whole game[^\n]*open Unreal editor/);
    assert.match(said, /helpers/);
    assert.doesNotMatch(said, /in parallel|as parts|one at a time/);
    const open = launchRules(EngineId.ClaudeCode, { toolName: "start_autopilot" }, GameEngine.Unreal).join("\n");
    assert.doesNotMatch(open, /judges/, "no judge decides an Unreal run's end");
    const web = launchRules(EngineId.ClaudeCode, { toolName: "start_autopilot", hours: 3 }).join("\n");
    assert.match(web, /builders working in parallel/, "the web Loop is unchanged");
    assert.doesNotMatch(web, /look first/);
  });

  it("asks the chat for a goal with the look first, in the user's own words about it, never a list of features", () => {
    const said = launchRules(EngineId.ClaudeCode, { toolName: "start_autopilot", hours: 3 }, GameEngine.Unreal).join(
      "\n",
    );
    assert.match(said, /look first[^\n]*user's own words[^\n]*before mechanics[^\n]*Never[^\n]*list of features/);
  });
});
