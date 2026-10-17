/**
 * The open-projects fixture: projects that aren't web games, in the records Genex and the one Loop
 * write. Before the window opens ({@link seedOpenProjects}): a Godot-shaped game no plugin knows,
 * whose earlier timed Loop closed in place with no claim a reviewer read; an Unreal plugin project
 * the Unreal plugin's scaffold made (the sidebar names its kind); a plugin loaded from a folder in
 * the profile's data, on, with one tool the person always allowed; a folder that is both a web game
 * and an Unreal project (Live's two tabs); and the web game's chat, where a session offered the
 * Unreal plugin, which is off; and a web game ported to Unreal, whose chat holds the port's turn
 * and the line that asks for the access `app_look` needs. Once the app has started ({@link seedOpenLoops}):
 * the Godot game's Loop going in place, its worker's question waiting in the chat, and the plugin
 * project's Loop, which the reviewer sent back once and which waits for the person to finish in
 * Unreal ({@link openLoopWaitNotice}).
 *
 * No engine, editor or provider runs: the folders are stand-ins and every record is written here.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CustomEvent, customRecord } from "../../shared/custom-events.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { type EventData, EventKind } from "../../shared/event-log.ts";
import { FinishCheckStep } from "../../shared/finish-check.ts";
import { UNREAL_PLUGIN_ID } from "../../shared/observers.ts";
import { AppLookAccessKind } from "../../shared/jobs.ts";
import { GrantKind, RuleScope, ToolPermissionState } from "../../shared/permissions.ts";
import { PluginSourceKind } from "../../shared/plugins.ts";
import { CoreFact, LoopProfile, type ScaffoldRecord } from "../../shared/project-facts.ts";
import { PluginOffer } from "../../shared/project-tools.ts";
import { EngineId } from "../../shared/providers.ts";
import { ExecutionStatus } from "../../shared/run-state.ts";
import { UiEvent, type UiEventMap } from "../../shared/ui-events.ts";
import { poolWorkerId, WorkerIsolation } from "../../shared/workers.ts";
import type { StudioCore } from "../studio-core.ts";
import { FIXTURE_MODEL, fixtureRun } from "./fixture-kit.ts";

/** The fixture's games, the local plugin's always-allowed tool and the worker whose question waits. */
export const OPEN_PROJECTS = {
  godot: "fixture-godot",
  plugin: "fixture-level-tools",
  webAndUnreal: "fixture-lantern-racer",
  ported: "fixture-paper-plane",
  allowedTool: "bake",
  askingWorker: "Export for the web",
} as const;

const GODOT_GAME = { name: OPEN_PROJECTS.godot, title: "Moon base" } as const;
const PLUGIN_GAME = { name: OPEN_PROJECTS.plugin, title: "Level tools" } as const;
/** The command the plugin project's lead was allowed to run. */
const PLUGIN_BUILD_COMMAND = "./build-plugin.sh";
const BOTH_GAME = { name: OPEN_PROJECTS.webAndUnreal, title: "Lantern racer" } as const;
const PORTED_GAME = { name: OPEN_PROJECTS.ported, title: "Paper plane" } as const;

/** The records that say each chat is seeded: one run id per chat, and the web game's card. */
const GODOT_CLOSED_RUN = "fixture-open-godot-earlier";
const GODOT_LOOP_RUN = "fixture-open-godot-loop";
const PLUGIN_LOOP_RUN = "fixture-open-plugin-loop";
const SUGGESTION_ASK = "fixture-open-suggest";
const PORT_TURN = "fixture-open-port";

/** The Godot project's stand-in files: Godot 4's project file and one scene. */
const GODOT_FILES: Readonly<Record<string, string>> = {
  "project.godot": '[application]\n\nconfig/name="Moon base"\nrun/main_scene="res://scenes/main.tscn"\n',
  "scenes/main.tscn": '[gd_scene format=3]\n\n[node name="Main" type="Node3D"]\n',
};

/** The plugin project as the Unreal plugin's `new-plugin` lays it out: a host project and the plugin in it. */
const PLUGIN_FILES: Readonly<Record<string, string>> = {
  "unreal/LevelToolsHost.uproject": `${JSON.stringify({ FileVersion: 3, EngineAssociation: "5.8" }, null, 2)}\n`,
  "unreal/Plugins/LevelTools/LevelTools.uplugin": `${JSON.stringify({ FileVersion: 3, FriendlyName: "Level Tools", Version: 1 }, null, 2)}\n`,
};

/** The Unreal plugin's tool whose scaffold made the plugin project. */
const NEW_PLUGIN_TOOL = "new-plugin";
/**
 * A web game at the folder's root with an Unreal project beside it, no engine link: Live has a view
 * of each. Its page is a plain canvas, on no import map of the studio's.
 */
const BOTH_FILES: Readonly<Record<string, string>> = {
  "index.html":
    '<!doctype html><html><body style="margin:0;background:#1b1530"><canvas width="800" height="500"></canvas><script>const x=document.querySelector("canvas").getContext("2d");x.fillStyle="#f2b84b";x.fillRect(120,300,560,24);x.fillStyle="#ffffff";x.font="32px sans-serif";x.fillText("Lantern racer",280,200);</script></body></html>\n',
  "unreal/LanternRacer.uproject": `${JSON.stringify({ FileVersion: 3, EngineAssociation: "5.8" }, null, 2)}\n`,
};

/** A web game ported to Unreal: the web files stay as the reference beside the new project. */
const PORTED_FILES: Readonly<Record<string, string>> = {
  "index.html":
    '<!doctype html><html><body style="margin:0;background:#bfe3f5"><canvas width="800" height="500"></canvas></body></html>\n',
  "unreal/PaperPlane.uproject": `${JSON.stringify({ FileVersion: 3, EngineAssociation: "5.8" }, null, 2)}\n`,
};

/** The port's turn: the ask, the Unreal plugin's New game, and the lead's reply. */
const PORTED_ASK = "Port this game to Unreal. Keep how the plane glides.";
const PORT_CALL = { id: "fixture-port-new-game", tool: "unreal__new-game", name: "PaperPlane" } as const;
const PORT_RESULT = "Made PaperPlane in unreal/ and linked it to this game. Genex saved a snapshot of the game first.";
const PORT_REPLY =
  "Genex saved a snapshot before the port, and the web files stay in the folder as the reference. The game is an Unreal project now: I'll go on in Unreal.";

/** The scaffold record that tool leaves in studio.json, when the Unreal plugin isn't there to name it. */
const PLUGIN_SCAFFOLD: ScaffoldRecord = {
  plugin: UNREAL_PLUGIN_ID,
  id: "plugin",
  label: "Unreal plugin",
  facts: [{ fact: CoreFact.UnrealPlugin, files: ["**/*.uplugin"], notUnder: ["**/GenexEditorHelper/"] }],
};

/** The plugin loaded from a folder: its id, folder in the profile's data, manifest and backend. */
const LOCAL_PLUGIN_ID = "moon-tools";
const LOCAL_PLUGIN_FOLDER = "fixture-local-plugin";
const EMPTY_PARAMETERS = { type: "object", properties: {} };
const LOCAL_MANIFEST = {
  apiVersion: 3,
  id: LOCAL_PLUGIN_ID,
  version: "1.0.0",
  name: "Moon tools",
  publisher: "Fixture",
  description: "Bakes the moon base's lighting and tidies its scenes.",
  backend: "backend.mjs",
  capabilities: [],
  tools: [
    { name: OPEN_PROJECTS.allowedTool, description: "Bake the lighting.", parameters: EMPTY_PARAMETERS },
    { name: "tidy", description: "Tidy the scenes.", parameters: EMPTY_PARAMETERS },
  ],
  skills: [],
  panels: [],
  settings: [],
  actions: [],
};
const LOCAL_BACKEND =
  "export async function activate() {\n  return { async tool(name) { return { ran: name }; } };\n}\n";

/** The Loops' asks, and their lead's own row and save points as the open Loop writes them. */
const GODOT_EARLIER_ASK = "Build the moon base's walls and a door that opens.";
const GODOT_ASK = "Light the moon base and make it play in a browser.";
const PLUGIN_ASK = "Add a toolbar button that places a lamp at the camera.";
const PORT_ASK = "Make this game in Unreal.";
const LEAD_ROW = { workerId: "lead", title: "Lead", mode: "single" } as const;
const LEAD_RUNNING = "running";
const LEAD_DONE = "done";
/** The verdict source a save point's round carries (the seed's `SAVE_POINT_VERDICT_SOURCE`). */
const SAVE_POINT_SOURCE = "lead";
/** The in-place Loop's close when its time ran out with no reviewer's yes (the seed's `OPEN_END.timeUpNoClaim`). */
const OPEN_TIME_UP = "the Loop's time ran out before a reviewer accepted the goal; here is where it stands";
/** How long the earlier timed Loop was given. */
const EARLIER_LOOP_MS = 60 * MINUTE_MS;

/** The Godot Loop's worker who asks before it exports, and the command it asks about. */
const EXPORTER = {
  workerId: poolWorkerId("w1"),
  title: OPEN_PROJECTS.askingWorker,
  isolation: WorkerIsolation.Copy,
  task: "Export the game for the web and check it opens in a browser.",
};
const EXPORT_COMMAND = 'godot --headless --export-release "Web" build/index.html';

/** The plugin project's lead's claim, and the reviewer's two reasons for sending it back. */
const PLUGIN_CLAIM = "The toolbar button places a lamp where the camera looks.";
const PLUGIN_NOT_YET = [
  "No picture shows the button in the toolbar.",
  "The lamp appears at the world's origin, not at the camera.",
];

/** The Unreal plugin's editor lock label, as its manifest names it: what the person is waited on to finish in. */
const UNREAL_LOCK_LABEL = "Unreal";

const said = (role: "user" | "assistant", content: string): EventData => ({
  type: EventKind.Messages,
  messages: [{ role, content }],
});

/** Records of one run. */
type Scoped = ReturnType<typeof fixtureRun>;

/** Whether the chat's log already holds a record naming this id (the seed writes each once). */
async function seeded(core: StudioCore, threadId: string, id: string): Promise<boolean> {
  return (await core.store.listEvents(threadId)).some((e) => {
    const payload = customRecord(e.data)?.payload;
    return payload?.runId === id || payload?.messageId === id;
  });
}

/** A game's stand-in files, written once into its folder. */
async function writeFiles(dir: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

/** Seeds what the window shows when it opens: the two games, the local plugin, and the two chats' earlier records. */
export async function seedOpenProjects(core: StudioCore, project: string, threadId: string): Promise<void> {
  const godot = await core.games.makeEmpty(GODOT_GAME.name, { title: GODOT_GAME.title });
  await writeFiles(godot.dir, GODOT_FILES);
  const plugin = await core.games.makeEmpty(PLUGIN_GAME.name, { title: PLUGIN_GAME.title });
  await writeFiles(plugin.dir, PLUGIN_FILES);
  const scaffold = core.plugins.scaffoldOf(UNREAL_PLUGIN_ID, NEW_PLUGIN_TOOL) ?? PLUGIN_SCAFFOLD;
  await core.games.recordPort(PLUGIN_GAME.name, [], scaffold);
  await core.threadForGame(PLUGIN_GAME.name);
  const both = await core.games.makeEmpty(BOTH_GAME.name, { title: BOTH_GAME.title });
  await writeFiles(both.dir, BOTH_FILES);
  await core.threadForGame(BOTH_GAME.name);
  await seedPortedGame(core);
  await installLocalPlugin(core, godot);
  if (!(await seeded(core, threadId, SUGGESTION_ASK))) await core.append(unrealSuggestion(project), threadId);
  const godotThread = await core.threadForGame(GODOT_GAME.name);
  if (!(await seeded(core, godotThread, GODOT_CLOSED_RUN)))
    await core.append(earlierGodotLoop(GODOT_GAME.name), godotThread);
}

/**
 * The web game ported to Unreal: its folder, the port recorded as the Unreal plugin's New game
 * records it (the web game it replaced), and its chat's port turn with the access line.
 */
async function seedPortedGame(core: StudioCore): Promise<void> {
  const ported = await core.games.makeEmpty(PORTED_GAME.name, { title: PORTED_GAME.title });
  await writeFiles(ported.dir, PORTED_FILES);
  const replaced = (await core.games.factsOf(PORTED_GAME.name)).filter((fact) => fact.id === CoreFact.WebGame);
  await core.games.recordPort(PORTED_GAME.name, replaced);
  const thread = await core.threadForGame(PORTED_GAME.name);
  if (!(await seeded(core, thread, PORT_TURN))) await core.append(portTurn(PORTED_GAME.name), thread);
}

/** The port's turn, then the line asking for the access `app_look` needs to look at the editor. */
function portTurn(project: string): EventData[] {
  return [
    said("user", PORTED_ASK),
    {
      type: EventKind.ToolRequested,
      tool_call_id: PORT_CALL.id,
      request: { name: PORT_CALL.tool, arguments: { name: PORT_CALL.name } },
    },
    { type: EventKind.ToolResult, tool_call_id: PORT_CALL.id, result: { ok: true, content: PORT_RESULT } },
    {
      type: EventKind.Custom,
      event_type: CustomEvent.AppLookAccess,
      payload: { messageId: PORT_TURN, project, missing: [AppLookAccessKind.Screen, AppLookAccessKind.Accessibility] },
    },
    said("assistant", PORT_REPLY),
  ];
}

/**
 * The plugin from a folder in the profile's data: loaded (it starts off), turned on, and one tool
 * always allowed. The fixture stands in for the person's Always allow on that tool's card, as the
 * consent tests do; the plugin's other tool still asks every time.
 */
async function installLocalPlugin(core: StudioCore, binding: { name: string; dir: string }): Promise<void> {
  const registry = core.plugins;
  const known = registry.list().find((plugin) => plugin.manifest.id === LOCAL_PLUGIN_ID);
  if (known?.allowedTools?.length) return;
  const dir = path.join(path.dirname(core.layout.runs), LOCAL_PLUGIN_FOLDER);
  await writeFiles(dir, {
    "plugin.json": `${JSON.stringify(LOCAL_MANIFEST, null, 2)}\n`,
    "backend.mjs": LOCAL_BACKEND,
  });
  if (!known) await registry.installLocal(dir, PluginSourceKind.Local, []);
  await registry.setEnabled(LOCAL_PLUGIN_ID, true);
  const ask = registry.consent;
  registry.consent = async () => ({ approved: true, by: "user", always: true });
  try {
    await registry.prepareTool(
      `${LOCAL_PLUGIN_ID}__${OPEN_PROJECTS.allowedTool}`,
      {},
      {
        project: binding.name,
        directory: binding.dir,
      },
    );
  } finally {
    registry.consent = ask;
  }
}

/** The person asked for Unreal in the web game; the session offered the Unreal plugin, which is off. */
function unrealSuggestion(project: string): EventData[] {
  return [
    said("user", PORT_ASK),
    {
      type: EventKind.Custom,
      event_type: CustomEvent.PluginSuggested,
      payload: {
        messageId: SUGGESTION_ASK,
        pluginId: UNREAL_PLUGIN_ID,
        name: "Unreal",
        description: "Build games in Unreal Engine.",
        offer: PluginOffer.TurnOn,
        reason: "Unreal is installed, but the Unreal plugin is off, so I can't open or build an Unreal project yet.",
        project,
      },
    },
    said("assistant", "Turn the Unreal plugin on and I'll start, or tell me to go on without it."),
  ];
}

/** An open Loop's start: the ask, the run, and the lead's own row at work. */
function openStart(run: Scoped, ask: string, extra: Record<string, unknown> = {}): EventData[] {
  return [
    said("user", ask),
    run(CustomEvent.RunStarted, { goal: ask, engine: EngineId.ClaudeCode, model: FIXTURE_MODEL, ...extra }),
    run(CustomEvent.AutopilotStarted, { director: true, maxParallel: 2, facets: [], workerRecords: true }),
    run(CustomEvent.DirectorWorker, { ...LEAD_ROW, state: LEAD_RUNNING }),
  ];
}

/** A save point as the open Loop draws it: a kept round of the lead's row, and its merge into the folder. */
function savePoint(run: Scoped, project: string, round: number, label: string, summary: string): EventData[] {
  const snapshot = `fixture-save-${project}-${round}`;
  return [
    run(CustomEvent.FacetIteration, {
      facetId: LEAD_ROW.workerId,
      facetTitle: LEAD_ROW.title,
      iteration: round,
      winner: "challenger",
      verdictSource: SAVE_POINT_SOURCE,
      reason: summary,
      satisfied: false,
      summary,
      label,
      snapshot,
      shots: [],
      move: { what: `${label}: ${summary}`, delivered: true },
    }),
    run(CustomEvent.IntegrationMerge, {
      project,
      facetId: LEAD_ROW.workerId,
      round,
      iteration: round,
      snapshot,
      conflict: false,
    }),
  ];
}

/** The Godot game's earlier timed Loop: one save point, then its hours and grace ran out with no claim read. */
function earlierGodotLoop(project: string): EventData[] {
  const run = fixtureRun({ runId: GODOT_CLOSED_RUN, project });
  const label = "Walls and door";
  const summary = "the walls stand and the door opens";
  const notChecked = "Not checked by a reviewer: the time ran out before a claim.";
  return [
    ...openStart(run, GODOT_EARLIER_ASK, { budgets: { wallClockMs: EARLIER_LOOP_MS } }),
    ...savePoint(run, project, 1, label, summary),
    run(CustomEvent.DirectorWorker, { ...LEAD_ROW, state: LEAD_DONE }),
    run(CustomEvent.RunFinished, {
      profile: LoopProfile.Open,
      victory: false,
      landed: true,
      stoppedBecause: OPEN_TIME_UP,
      facets: { [LEAD_ROW.workerId]: { stoppedBecause: null, iterations: 1, satisfied: null } },
      executionStatus: ExecutionStatus.Completed,
      summary: `One save point: ${label} (${summary}). ${notChecked}`,
      notDone: [notChecked],
      savePoints: [{ label, snapshotId: `fixture-save-${project}-1` }],
      lastCheckpoint: `fixture-save-${project}-1`,
    }),
  ];
}

/** Writes the two Loops still going, once, after the app has started (its start closes runs an earlier app left open). */
export async function seedOpenLoops(core: StudioCore): Promise<void> {
  const godotThread = await core.threadForGame(GODOT_GAME.name);
  if (!(await seeded(core, godotThread, GODOT_LOOP_RUN)))
    await core.append(godotLoop(GODOT_GAME.name, godotThread), godotThread);
  const pluginThread = await core.threadForGame(PLUGIN_GAME.name);
  if (!(await seeded(core, pluginThread, PLUGIN_LOOP_RUN)))
    await core.append(pluginLoop(PLUGIN_GAME.name, pluginThread), pluginThread);
}

/** The Godot game's Loop going in place: one save point, and a worker that asks before it exports. */
function godotLoop(project: string, threadId: string): EventData[] {
  const run = fixtureRun({ runId: GODOT_LOOP_RUN, project });
  return [
    ...openStart(run, GODOT_ASK),
    ...savePoint(run, project, 1, "Lights", "the base's lamps light the corridors"),
    run(CustomEvent.WorkerStarted, EXPORTER),
    {
      type: EventKind.Custom,
      event_type: CustomEvent.ToolPermission,
      payload: {
        requestId: "fixture-open-worker-ask",
        project,
        threadId,
        tool: "Bash",
        title: `Claude wants to run ${EXPORT_COMMAND}`,
        displayName: "Run command",
        description: "Export the game for the web",
        subject: EXPORT_COMMAND,
        input: { command: EXPORT_COMMAND, description: "Export the game for the web" },
        always: [{ kind: GrantKind.Rule, rule: "Bash(godot --headless:*)", scope: RuleScope.Chat }],
        worker: { id: EXPORTER.workerId, title: EXPORTER.title },
        state: ToolPermissionState.Pending,
      },
    },
  ];
}

/**
 * The plugin project's Loop going in place: one save point, the lead's two answered requests, and
 * its next call waits on the editor.
 */
function pluginLoop(project: string, threadId: string): EventData[] {
  const run = fixtureRun({ runId: PLUGIN_LOOP_RUN, project });
  return [
    ...openStart(run, PLUGIN_ASK),
    ...savePoint(run, project, 1, "Button", "the toolbar shows the lamp button"),
    ...answeredAsks(project, threadId),
    run(CustomEvent.FinishCheck, { round: 1, step: FinishCheckStep.Checking, claim: PLUGIN_CLAIM }),
    run(CustomEvent.FinishCheck, {
      round: 1,
      step: FinishCheckStep.Rejected,
      reasons: PLUGIN_NOT_YET,
      rejections: 1,
    }),
  ];
}

/**
 * The lead's requests in the plugin project's chat, answered, so each reads as one line: the
 * Unreal editor always allowed, and a build command allowed once.
 */
function answeredAsks(project: string, threadId: string): EventData[] {
  const consent = {
    consentId: "fixture-open-unreal-call",
    pluginId: "unreal-editor",
    pluginName: "Unreal Engine",
    tool: "unreal-editor__call_tool",
    args: { toolset_name: "editor_toolset.toolsets.actor", tool_name: "spawn_actor" },
    project,
    threadId,
    prompt: "Let the agent use Unreal Engine?",
    alwaysOffered: true,
  };
  const command = {
    requestId: "fixture-open-lead-build",
    project,
    threadId,
    tool: "Bash",
    title: `Claude wants to run ${PLUGIN_BUILD_COMMAND}`,
    displayName: "Run command",
    subject: PLUGIN_BUILD_COMMAND,
    input: { command: PLUGIN_BUILD_COMMAND },
    always: [],
  };
  const custom = (event_type: string, payload: Record<string, unknown>): EventData =>
    ({ type: EventKind.Custom, event_type, payload }) as EventData;
  return [
    custom(CustomEvent.PluginConsent, { ...consent, state: "pending" }),
    custom(CustomEvent.PluginConsent, { ...consent, state: "approved", by: "user", always: true }),
    custom(CustomEvent.ToolPermission, { ...command, state: ToolPermissionState.Pending }),
    custom(CustomEvent.ToolPermission, {
      ...command,
      state: ToolPermissionState.Allowed,
      by: "user",
      granted: "once",
    }),
  ];
}

/**
 * What the app announces while the plugin project's Loop waits for the person to finish in Unreal:
 * its editor lock's label, read from the Unreal plugin's manifest when it is installed.
 */
export function openLoopWaitNotice(core: StudioCore, threadId: string): UiEventMap[typeof UiEvent.PersonFirst] {
  const unreal = core.plugins.list().find((plugin) => plugin.manifest.id === UNREAL_PLUGIN_ID);
  const label = unreal?.manifest.locks?.[0]?.label ?? UNREAL_LOCK_LABEL;
  return { project: PLUGIN_GAME.name, threadId, label, waiting: true };
}

/** Announces the plugin project's wait once the window listens. */
export async function announceOpenLoopWait(core: StudioCore): Promise<void> {
  const threadId = await core.threadForGame(PLUGIN_GAME.name);
  core.emit(UiEvent.PersonFirst, openLoopWaitNotice(core, threadId));
}
