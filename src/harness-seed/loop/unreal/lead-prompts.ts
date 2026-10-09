/**
 * The Unreal lead's words to its session: the brief its first turn opens with (lean: the whole goal,
 * the look-first discipline, hands and eyes, the checklist, the asset policy, sub-agents, saving,
 * and the facts of the template the game is actually built on), the digest every later turn opens
 * with, the steers the harness sends mid-turn, a fresh session's handover, and the run tools' plain
 * answers. Pure text from plain facts: nothing here reads the run. Tools are spelled the way the
 * session's engine calls them.
 */
import { toolCall } from "../model-roles.ts";
import { type FactRef, ProjectTool } from "../folder-facts.ts";
import { appIdentity } from "../project-prompts.ts";
import { UNREAL_AT_ROOT } from "../workers/identity.ts";
import { unrealRules, unrealWorkHere } from "../unreal-prompts.ts";
import { requiredText } from "./critic-prompts.ts";
import {
  AgentKind,
  type AgentOffers,
  type CriticAdvice,
  type CriticDefect,
  kindOffered,
  HERO_CAMERA_PREFIX,
  type LeadCredits,
  LeadTool,
  MAX_HERO_SHOTS,
  MAX_RUNNING_AGENTS,
  type SavePoint,
  type SavePointShot,
} from "./lead-contract.ts";
import { TemplateKind } from "./template-kind.ts";

/** The Genex editor helper's build toolset: the lead's hands and eyes in the editor. */
export const BUILD_TOOLSET = "genex_build.tools.GenexBuildTools";
/** The Genex editor helper's toolset the harness keeps for itself. */
const LOOP_TOOLSET = "genex_loop";
/** How many hero shots ART.md plans: as many as a save point captures, so every one is seen at each save. */
const ART_HERO_SHOTS = MAX_HERO_SHOTS;
/** A thumbnail whose white point (p98) is under this is nearly black (the Unreal plugin's tone.ts uses the same bound). */
const DARK_THUMBNAIL_WHITE = 0.1;
/** Where the lead's build scripts live, from the game folder. */
export const BUILD_SCRIPTS = "unreal/build";

/** Unreal's Python and out-parameters: said in the brief and in the helper's own code. */
export const PYTHON_TUPLES =
  "Unreal's Python hands a function's out-parameters back in a tuple with its return value: when a call returns a tuple, pick the value you want by its type (isinstance), never by its position.";

/** What each template holds that the lead builds on, by the template the game is built on. */
const TEMPLATE_WORDS = {
  [TemplateKind.Vehicle]:
    "The game mode spawns a wheeled vehicle (Chaos vehicle movement): keep its physics and build the world around how it drives. The template's own track pieces (its landscape, walls and curbs) are demo content: hide or remove what the game doesn't use.",
  [TemplateKind.Combat]:
    "Epic's Combat variant of the third-person template: its character already has a combo, charged attack, damage, an enemy AI (StateTree), ragdoll deaths and a spawner. Reuse them (Python can't author StateTree or animation graphs): attach a weapon to the hand socket, get hit-stop from global time dilation, and tune their numbers.",
  [TemplateKind.ThirdPerson]:
    "Epic's third-person character (a Character with a spring-arm camera): keep its movement and camera; a small figure against big structure is what sells scale.",
  [TemplateKind.FirstPerson]:
    "Epic's first-person character: the camera is the player's eyes, so scale reads through what is near the player; keep its movement.",
  [TemplateKind.Other]: "",
} as const satisfies Record<TemplateKind, string>;

/** What each kind of typed worker makes, as the brief offers them. */
const AGENT_WORDS = {
  [AgentKind.BlenderModel]: "a new hard-surface model or kit pieces, modeled in Local Blender",
  [AgentKind.BlenderPrep]: "weld, decimate, scale, set the pivot, join or make LODs of given models, in Local Blender",
  [AgentKind.GenexCast]: "a character or creature from Genex (Meshy) with its catalog clips",
  [AgentKind.Sound]: "sound effects or music from Genex, delivered as WAV",
  [AgentKind.Texture]: "a texture or decal from Genex, or a Blender bake (whichever is on)",
  [AgentKind.Cpp]: "C++ classes written and compiled in a copy (never in the open editor)",
} as const satisfies Record<AgentKind, string>;

/** A run tool as the session's engine calls it. */
const runTool = (engine: string | undefined, tool: LeadTool) => toolCall(engine, tool);

/** What the brief is written from. */
export type LeadBriefOptions = {
  /** The session's engine, which spells the tools. */
  engine: string | undefined;
  /** The game's Unreal project file. */
  project: string | null | undefined;
  /** The owner's goal, whole. */
  goal: string;
  /** The game's name as the user knows it. */
  title: string;
  /** The template's facts for the actual template ("" when unknown), and which template it is. */
  template: string;
  templateKind: TemplateKind;
  /** The run's working time, in minutes (null for a run with no end). */
  minutes: number | null;
  /** Whether the game can take C++. */
  cpp: boolean;
  /** The plugin tools its workers can be offered, and the worker types the plugins that are on declare. */
  offers: AgentOffers;
  /** The game's `references/` files, by game-folder path. */
  references: string[];
  /** The fresh session's handover from the chat, and NOTES.md ("" when none). */
  handover: string;
  notes: string;
  /** What the game's folder holds (`game.list`'s `facts`); absent: the Unreal project the lead works in. */
  facts?: readonly FactRef[];
  /** The game folder as a brief names it (its last two parts); absent: named as the game's folder. */
  folderLabel?: string;
};

/** The lead's brief: its first turn's prompt. */
export function leadBrief(options: LeadBriefOptions): string {
  const { engine, project, title } = options;
  return [
    appIdentity({ folderLabel: options.folderLabel ?? "", facts: options.facts ?? UNREAL_AT_ROOT }),
    options.handover,
    notesText(options.notes),
    `You are the lead of this Unreal Loop and its only builder: you build the whole game "${title}" yourself, live in the user's open Unreal Editor, and judge it by your own captures. Small workers may make pieces for you; nobody else touches the editor.`,
    `THE GOAL, in the owner's words:\n${options.goal}`,
    timeText(engine, options.minutes),
    unrealRules(engine, project, { ownFiles: true }).join("\n"),
    lookFirstText(options.references),
    handsAndEyesText(),
    CHECKLIST,
    assetText(engine, options.offers),
    agentsText(engine, options),
    savingText(engine),
    templateText(options),
    // The game folder is the lead's seat: no folder label, which the title is not.
    unrealWorkHere(project, ""),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function notesText(notes: string): string {
  return notes.trim() ? `NOTES.md as it stands (your memory from before):\n${notes.trim()}` : "";
}

function timeText(engine: string | undefined, minutes: number | null): string {
  if (minutes === null) return "TIME: the run goes on until the owner stops it. Work continuously; never wait idle.";
  return `TIME: about ${minutes} minutes of work. Work continuously; a turn that ends is picked up again at once. Never wind down on your own guess of the time: keep building until Genex tells you to wrap up, and ask ${runTool(engine, LeadTool.RunStatus)} when you want the minutes left.`;
}

function lookFirstText(references: readonly string[]): string {
  const refs = references.length
    ? `The owner's references are in references/: ${references.join(", ")}. Look at them first.`
    : "references/ is empty: consider asking a texture worker for 2–3 concept images of the look before you commit to it.";
  return `LOOK FIRST:
- First write ART.md from the goal: palette, light, scale rules, materials, mood, and ${ART_HERO_SHOTS} hero shots. ${refs}
- In your first 30 minutes, on a greybox: remove the template's sky, set the light, the atmosphere (volumetric fog, local fog, light shafts), a manual exposure and the grade, and place the hero cameras as CameraActors named ${HERO_CAMERA_PREFIX}<name> (save points capture up to ${MAX_HERO_SHOTS} of them; a test camera gets another name).
- ORDER OF WORK: the look, then the cast (a character replaces a stand-in only once you have seen it in play from the front, side and back, holding what it carries, and it beats what it replaces), then mechanics, each judged inside that look.`;
}

function handsAndEyesText(): string {
  return `HANDS AND EYES (the toolset ${BUILD_TOOLSET}, through the Unreal tools):
- Hands: run_script runs a Python file of yours in ${BUILD_SCRIPTS}/ with the full unreal module and the gx library, in one undo transaction. Keep one idempotent script per system (gx.scope(tag) clears what it made last time) and run it again after each edit. execute_tool_script is for small queries only. Repeated pieces are instanced (gx.instances), never placed one actor per call.
- Eyes: capture_shot from a named camera, capture_play while the game plays, motion_strip for movement. Each answers the image, its tone numbers and the fps. Never judge by an editor window capture. Never save or say done about a change you haven't looked at.
- An MCP timeout does not cancel an edit: look before you run it again.
- ${PYTHON_TUPLES}
- Never call the ${LOOP_TOOLSET} toolset: it is Genex's own.`;
}

/** The checklist every capture is judged against: a clean frame, the tone numbers, the art questions. */
const CHECKLIST = `THE CHECKLIST, on every capture (any "no" is your next task):
- Gate 0, a clean frame: no editor UI, no template sky, default floor or grey material, nothing floating, no z-fighting, no BasicShapes left in the look.
- Gate 1, the tone numbers: a black point (p2) of 0.05 or less, contrast (std) of 0.18 or more, and the far band calmer than the near one (farStd below nearStd).
- Gate 2, the art: one key light you can name, the focal point the brightest thing, a figure that gives scale, at most one warm accent, real materials with variation, and a frame that would work as key art with the HUD hidden.
- Performance: Nanite on heavy meshes, instancing for repeats, at least 30 fps while playing.`;

function assetText(engine: string | undefined, offers: LeadBriefOptions["offers"]): string {
  // Genex's plugin search is the lead's: its card shows in the chat the run was started in.
  const find = toolCall(engine, ProjectTool.PluginsFind);
  const suggest = toolCall(engine, ProjectTool.PluginsSuggest);
  const missing = [
    offers.blender ? "" : "Local Blender isn't on, so no Blender workers this run.",
    offers.genex ? "" : "Genex Tools isn't on, so no Genex characters, sound or textures this run.",
  ].filter(Boolean);
  return [
    `ASSETS: Blender first for hard-surface work (weapons, kit pieces, props); Genex's Meshy lanes for characters and creatures; images only for decals, signage and UI, never a photo standing in for 3D; nothing from BasicShapes in the shipped look. When nothing on meets a wish, say so once and use the next tool, or find a Genex plugin with ${find} (${suggest} shows the person its card). Follow Genex jobs with genex__asset status and wait: the genex-creator tools ask the owner first, who may be away.`,
    ...missing,
  ].join(" ");
}

function agentsText(engine: string | undefined, options: Pick<LeadBriefOptions, "cpp" | "offers">): string {
  const kinds = Object.values(AgentKind).filter((kind) => kindOffered(kind, options.offers, options.cpp));
  const lines = kinds.map((kind) => `  - ${kind}: ${AGENT_WORDS[kind]}`);
  const tool = (name: LeadTool) => runTool(engine, name);
  return `WORKERS: ${tool(LeadTool.WorkerStart)} with a type below starts one in a copy of the game while you keep building (at most ${MAX_RUNNING_AGENTS} at once). Its task is all it sees: what to make, its size in metres, style, pivot and where it goes. Genex lands its files in assets/agents/<id>/ with a manifest and the exact import call, and tells you; import and place it yourself, then ${tool(LeadTool.WorkerMark)} it used or rejected so the news stops. No type: a generic worker (isolation read, copy or lock). ${tool(LeadTool.WorkerStatus)} and ${tool(LeadTool.WorkerWait)} follow them.
${lines.join("\n")}
- ${runTool(engine, LeadTool.Critic)}: fresh eyes beside the references and ART.md, at each milestone and every 45–60 minutes; show it the player's view and the player's character. It advises, but its REQUIRED items (a defect seen in two looks in a row) come before any new mechanic, space or feature.`;
}

function savingText(engine: string | undefined): string {
  const tool = (name: LeadTool) => runTool(engine, name);
  return `SAVING AND THE RUN:
- ${tool(LeadTool.SavePoint)} after you have looked: Genex saves all, snapshots the game and captures the hero cameras. Save often, at least every 15 minutes of work; never while the game plays.
- ${tool(LeadTool.Milestone)} names what you work on now (a column on the owner's Builds graph): name one before your first save point and a new one whenever you move to another part of the game (the look, a space, combat, a creature, the finish). ${tool(LeadTool.Rewind)} goes back to a save point between turns, your own undo.
- ${tool(LeadTool.RebuildUnreal)} restarts Unreal between turns: after C++ changes in unreal/Source (never Live Coding), or when the editor renders differently from play.
- Act on the owner's words when they come in, right after the edit you are in.
- NOTES.md in this folder is your memory across compactions and sessions: keep it current (what is built, how, what is next).
- ${tool(LeadTool.Note)} leaves the owner one line.
- Your last words are honest: what you built, and what you did not test.`;
}

function templateText(options: Pick<LeadBriefOptions, "template" | "templateKind">): string {
  const words = TEMPLATE_WORDS[options.templateKind];
  const facts = options.template ? `What the template has:\n${options.template}` : "";
  const text = [words, facts].filter(Boolean).join("\n");
  return text ? `THE TEMPLATE:\n${text}` : "";
}

/** What a digest says: the facts the harness gathered since the lead's last turn. */
export type LeadDigest = {
  minutesLeft: number | null;
  /** The owner's words the lead has not had yet. */
  ownerWords: string[];
  /** Each finished sub-agent's news (manifest summary and import calls), repeated until the lead marks it. */
  agentNews: string[];
  /** The last save point and how long ago, null before the first. */
  lastSave: { label: string; minutesAgo: number } | null;
  /** The critic's answers the lead has not had yet. */
  advice: CriticAdvice[];
  /** What happened between turns: an autosave, a rewind, a crash and its reopen. */
  carried: string[];
  /** The run's jobs that ended since the lead last heard, one line each (loop/jobs/prompts.ts). */
  jobs: string[];
  credits: LeadCredits;
  /** Minutes since the critic last looked (or since the run began), when it is time for fresh eyes; else null. */
  freshEyesDue: number | null;
  /** The critic's required items still open (a defect it saw in two looks in a row). */
  required: CriticDefect[];
};

/** One critic answer, in a few lines. */
function adviceText(advice: CriticAdvice): string {
  const defects = advice.defects.map((d) => `  - ${d.defect} Fix: ${d.fix}`);
  return [`- On ${advice.shots.join(", ")}:`, ...defects, `  Bold move: ${advice.boldMove}`].join("\n");
}

/** The digest's lines, each a section only when it says something. */
function digestSections(engine: string | undefined, digest: LeadDigest): string[] {
  const list = (lines: readonly string[]) => lines.map((line) => `- ${line}`).join("\n");
  const save = digest.lastSave
    ? `Last save point: '${digest.lastSave.label}', ${digest.lastSave.minutesAgo} minutes ago.`
    : "No save point yet.";
  const cap = digest.credits.cap === null ? "" : ` of ${digest.credits.cap}`;
  return [
    digest.ownerWords.length ? `${STEER.OwnerWords(digest.ownerWords.join("\n"))}` : "",
    requiredText(digest.required),
    digest.agentNews.length ? `Workers:\n${list(digest.agentNews)}` : "",
    digest.jobs.length ? `Jobs:\n${list(digest.jobs)}` : "",
    digest.carried.length ? `Since your last turn:\n${list(digest.carried)}` : "",
    digest.advice.length ? `The critic's advice:\n${digest.advice.map(adviceText).join("\n")}` : "",
    digest.freshEyesDue === null ? "" : STEER.FreshEyes(engine, digest.freshEyesDue),
    save,
    `Genex credits spent: ${digest.credits.spent}${cap}.`,
  ].filter(Boolean);
}

/** A later turn's prompt: the digest, then "go on". */
export function digestPrompt(engine: string | undefined, digest: LeadDigest): string {
  const left = digest.minutesLeft === null ? "" : ` About ${digest.minutesLeft} minutes are left.`;
  return [
    `YOUR NEXT TURN of the Unreal Loop.${left}`,
    ...digestSections(engine, digest),
    "Go on from NOTES.md and what you see: look, fix what the checklist says, build the next thing, save when you have looked.",
  ].join("\n\n");
}

/** What the harness steers into the lead's turn; a steer that names a run tool spells it for the session's engine. */
export const STEER = {
  /** The owner's words: act on them now unless they conflict with the edit under way, then right after. */
  OwnerWords: (words: string): string =>
    `The owner says:\n${words}\nAct on this now unless it conflicts with the edit you are in the middle of; then do it right after.`,
  /** A sub-agent finished: its news. */
  AgentNews: (news: string): string => `Worker news:\n${news}`,
  /** A job of the run ended: its line. */
  JobEnded: (line: string): string => `Job news:\n${line}`,
  /** The critic hasn't looked for this many minutes: fresh eyes on the best captures. */
  FreshEyes: (engine: string | undefined, minutesSince: number): string =>
    `No fresh eyes on the game for ${minutesSince} minutes: call ${runTool(engine, LeadTool.Critic)} with your best recent captures. It advises; you decide.`,
  /** Unsaved work since the last save point for this many minutes: look, then save. */
  SaveNow: (engine: string | undefined, minutesSince: number): string =>
    `About ${minutesSince} minutes of work since your last save point. Look at it now (capture_shot or capture_play), then call ${runTool(engine, LeadTool.SavePoint)}.`,
  /** Unreal crashed at `at` and was reopened; work since the save point `label` may be lost. */
  Crashed: (at: string, label: string | null): string =>
    `Unreal crashed at ${at} and was reopened. Unsaved work since ${label ? `save point '${label}'` : "the run began"} may be lost: check the level and continue.`,
  /** Unreal could not be reopened, so the game went back to the save point `label`. */
  Restored: (at: string, label: string): string =>
    `Unreal crashed at ${at} and couldn't be reopened on the level as it was, so Genex put the game back to save point '${label}' and reopened it. Look at the level as it is now before you go on.`,
  /** The run's end is near: fix visible defects, set the hero cameras, save "Final", update NOTES.md. */
  WrapUp: (engine: string | undefined, minutesLeft: number): string =>
    `About ${minutesLeft} minutes are left: wrap up. Fix the defects you can see, set the hero cameras (${HERO_CAMERA_PREFIX}…), call ${runTool(engine, LeadTool.SavePoint)} with label "Final", update NOTES.md, and end with honest words: what you built and what you did not test.`,
} as const;

/** Why a session was handed over, in the handover's words. */
export const HANDOVER_WHY = {
  ContextFull: "its context was full",
  ResumeFailed: "it could not be resumed",
} as const;

/** A fresh session's handover: why the last one ended, and where the run stands. */
export function handoverWords(options: { why: string; status: string }): string {
  return `You take over this Unreal Loop's lead from a session that ended (${options.why}). Read NOTES.md and ART.md in this folder first: they say what was built, how and why.\n\nWhere the run stands:\n${options.status}`;
}

/** What a turn carries from between turns. */
export const CARRIED = {
  Autosaved: (label: string) => `Your turn ended with unsaved work, so Genex saved it as '${label}'.`,
  NotAutosaved: (why: string) => `Your turn ended with unsaved work, and Genex couldn't save it: ${clause(why)}.`,
  Rewound: (label: string) => `Genex put the game back to save point '${label}' before this turn, as you asked.`,
  NoRewind: (label: string, why: string) => `Genex couldn't go back to '${label}': ${clause(why)}.`,
  Rebuilt: "Genex restarted Unreal (building the game's C++ first, when it has any) before this turn.",
  NotBuilt: (why: string, label: string) =>
    `Your C++ didn't build (${why}), so Genex went back to save point '${label}' and reopened Unreal. Fix the C++ before you rebuild again.`,
  Resumed: "The run was paused and goes on now: look at the level as it is before you build.",
  TurnHeld: (why: string) => `Genex didn't start your last turn: ${clause(why)}.`,
} as const;

/** Words without the full stop they may end with, to go on in a sentence. */
function clause(words: string): string {
  return words.trim().replace(/[.]+$/, "");
}

/** The run tools' plain answers. */
export const LEAD_TOOL_WORDS = {
  Noted: "ok",
  UnknownTool: (name: string) => `Unknown tool: ${name}`,
  Rebuild: (reason: string) =>
    `Genex rebuilds Unreal when this turn ends (${reason}): it saves, closes Unreal, builds the game's C++ and opens it again. Keep NOTES.md current and end your turn when you are ready.`,
  Rewind: (label: string) =>
    `Genex goes back to '${label}' when this turn ends: it saves, closes Unreal, restores that save point and reopens it. End your turn when you are ready.`,
  NoSavePoint: (label: string, known: readonly string[]) =>
    `There is no save point '${label}'.${known.length ? ` The save points: ${known.join(", ")}.` : " There are none yet."}`,
  Milestone: (title: string) => `Now working on: ${title}. Your next save points land in its column.`,
  NeedsMilestone: "A milestone needs an id and a title.",
  /** A save point the lead named nothing: its number in the run. */
  DefaultLabel: (n: number) => `Save point ${n}`,
  NoReason: "no reason given",
} as const;

/** How many of a save point's new log errors its answer names before it counts the rest. */
const NAMED_LOG_LINES = 3;

/** A nearly black thumbnail's warning: the render, more likely than the grade, has gone wrong. */
const SAVE_POINT_DARK = `Nearly black: unless the scene is meant to be this dark, the editor is rendering it wrong (play may look right); restart Unreal with ${LeadTool.RebuildUnreal}.`;

/** A number of a capture's tone as an answer quotes it. */
const toneNumber = (n: number) => n.toFixed(2);

/** One thumbnail's line: its camera and its tone numbers. */
function thumbnailLine(shot: SavePointShot): string {
  const { tone } = shot;
  if (!tone) return `- ${shot.camera}: no tone numbers.`;
  const dark = tone.p98 < DARK_THUMBNAIL_WHITE ? ` ${SAVE_POINT_DARK}` : "";
  return `- ${shot.camera}: black point p2 ${toneNumber(tone.p2)}, white p98 ${toneNumber(tone.p98)}, contrast std ${toneNumber(tone.std)}, near/far std ${toneNumber(tone.nearStd)}/${toneNumber(tone.farStd)}, saturation ${toneNumber(tone.saturation)}.${dark}`;
}

/** The new log errors' line. */
function logLine(lines: readonly string[]): string {
  if (!lines.length) return "Unreal's log: no new errors since the last save point.";
  const more = lines.length > NAMED_LOG_LINES ? ` (and ${lines.length - NAMED_LOG_LINES} more)` : "";
  return `Unreal's log has ${lines.length} new errors since the last save point: ${lines.slice(0, NAMED_LOG_LINES).join(" | ")}${more}`;
}

/** `save_point`'s answers. */
export const SAVE_POINT_WORDS = {
  Busy: "A save point is already being made. Wait for its answer.",
  Refused: (why: string) => `No save point: ${why}`,
  /** How long the run goes on after a save: a lead that guesses its own time winds down early. */
  GoOn: (minutesLeft: number) =>
    `About ${minutesLeft} minutes are left: keep building the next thing in this turn; Genex tells you when to wrap up.`,
  /** A save point's whole answer: what was saved, the critic's required items still open, and the minutes left. */
  Answer: (point: SavePoint, minutesLeft: number, required: readonly CriticDefect[]): string =>
    [SAVE_POINT_WORDS.Saved(point), requiredText(required), SAVE_POINT_WORDS.GoOn(minutesLeft)]
      .filter(Boolean)
      .join("\n"),
  Saved: (point: SavePoint) =>
    [
      `Saved '${point.label}' (snapshot ${point.snapshotId}).`,
      ...(point.notes ?? [logLine(point.logErrors ?? [])]),
      point.thumbnails.length
        ? `Thumbnails:\n${point.thumbnails.map(thumbnailLine).join("\n")}`
        : `No hero camera was captured: place CameraActors named ${HERO_CAMERA_PREFIX}<name>.`,
    ].join("\n"),
} as const;

/** `run_status`'s lines. */
export const RUN_STATUS = {
  Left: (minutes: number) => `About ${minutes} minutes are left in the run.`,
  Milestone: (title: string) => `Working on: ${title}.`,
  SavePoints: (labels: readonly string[]) =>
    labels.length ? `Save points, newest last: ${labels.join(", ")}.` : "No save point yet.",
  Credits: (spent: number, cap: number | null) => `Genex credits spent: ${spent}${cap === null ? "" : ` of ${cap}`}.`,
} as const;
