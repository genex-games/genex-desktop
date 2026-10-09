/**
 * The chat fixtures: a long game chat with a build under way (`chat-history`, `chat-questions`),
 * a short chat whose every message can be rewound to, and the chats a build's feedback leaves
 * behind (`chat-feedback`), plus what each adds once the window is up.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { ChatActivityPhase, SessionActivityRole } from "../../shared/chat-activity.ts";
import { CustomEvent, customEventData, DELEGATED_PREFIX } from "../../shared/custom-events.ts";
import { EventKind, type EventData } from "../../shared/event-log.ts";
import { GrantKind, PLAN_TOOL, RuleScope } from "../../shared/permissions.ts";
import { EngineId } from "../../shared/providers.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import type { StudioCore } from "../studio-core.ts";
import { FIXTURE_MODEL, FixtureName, fixtureRun, SHOT } from "./fixture-kit.ts";
import { ExecutionStatus } from "../../shared/run-state.ts";
import { MINUTE_MS } from "../../shared/duration.ts";

/** Why a chat fixture cannot be seeded. */
const MESSAGE = {
  missingGame: (project: string) => `fixture game ${project} is missing`,
} as const;

/** Messages in the long chat, and reads in its build's tool log (one of them failed). */
const CHAT_MESSAGES = 600;
const TOOL_READS = 55;
const FAILED_READ = 53;
const LAST_READ = TOOL_READS - 1;
/** The time limit the long chat's builds were given, so Mode shows a build's own limit. */
const FIXTURE_BUILD_LIMIT_MS = 30 * MINUTE_MS;

/** A long game chat, and a build under way in it that made a cover and names files in its reply. */
export async function seedChatHistory(core: StudioCore, project: { name: string; dir: string }, threadId: string) {
  await core.store.updateThread(core.mainThread, {
    metadata: { lastEngine: EngineId.Ollama, lastModel: FIXTURE_MODEL },
  });
  // Seeded first, so the long chat stays the most recent game.
  await seedRewindChat(core);
  await core.append(longChat(), threadId);
  const run = fixtureRun({ runId: "fixture-chat-active", project: project.name });
  const append = (...args: Parameters<typeof run>) => core.append([run(...args)], threadId);
  await core.append(
    [
      {
        type: EventKind.Messages,
        messages: [
          { role: "user", content: "Add a wooden bridge and warm light in the village. Create a cover image too." },
        ],
      },
    ],
    threadId,
  );
  await append(CustomEvent.RunStarted, {
    goal: "A bridge and a village at dusk",
    budgets: { wallClockMs: FIXTURE_BUILD_LIMIT_MS },
    engine: EngineId.Ollama,
    model: FIXTURE_MODEL,
  });
  await append(CustomEvent.DirectorWorker, { ...BRIDGE, mode: "single", state: "running" });
  await append(CustomEvent.DirectorWorker, { ...LIGHT, mode: "single", state: "running" });
  await core.append(toolReads(), threadId);
  await makeCover(project.dir, append);
  await append(CustomEvent.DirectorWorker, { ...LIGHT, mode: "single", state: "done" });
  await writeBrief(project.dir);
  await core.append(
    [
      {
        type: EventKind.Messages,
        messages: [
          {
            role: "assistant",
            content:
              // Markdown and images open beside the chat, other files in their app (refused in a
              // fixture profile), and a name that is not a file stays text.
              "The cover is ready (`assets/village-cover.png`), and the village lights are in place. The plan is in [docs/BRIEF.md](docs/BRIEF.md); the lights start in src/main.js, and assets/music/night.mp3 comes next. I’m finishing the bridge so you can cross the river.",
          },
        ],
      },
    ],
    threadId,
  );
}

/** A message the composer sent: its bubble and the queue's receipt. */
function sent(messageId: string, text: string): EventData[] {
  return [
    { type: EventKind.Messages, messages: [{ role: "user", content: text }] },
    customEventData(CustomEvent.CoordinatorMessageQueued, { messageId, action: { text } }),
  ];
}

/** A sent message, answered by a turn of its own. */
function answered(messageId: string, text: string, answer: EventData[]): EventData[] {
  return [
    ...sent(messageId, text),
    customEventData(CustomEvent.CoordinatorMessageProcessing, { messageId }),
    ...answer,
    customEventData(CustomEvent.CoordinatorMessageHandled, { messageId }),
  ];
}

const said = (content: string): EventData => ({
  type: EventKind.Messages,
  messages: [{ role: "assistant", content }],
});

/**
 * A short game chat whose every message offers Rewind: one from before the queue (no queue
 * record), the first queued one, one a landed build followed, one whose answer failed, and one
 * read into the answer under way. Rewinding to the one the build followed rewinds the chat alone.
 */
export async function seedRewindChat(core: StudioCore): Promise<void> {
  const game = await core.games.scaffold("rewind-chat", { title: "Rewind chat" });
  const thread = await core.threadForGame(game.name);
  const run = fixtureRun({ runId: "fixture-rewind-run", project: game.name });
  const boats = "fixture-rewind-boats";
  const joined = "fixture-rewind-joined";
  await core.append(
    [
      { type: EventKind.Messages, messages: [{ role: "user", content: "Sketch a lantern festival by the river." }] },
      said("Here is a first sketch: lanterns along both banks, a bridge in the middle."),
    ],
    thread,
  );
  await core.append(
    answered("fixture-rewind-first", "Make the lanterns warmer.", [said("The lanterns glow amber now.")]),
    thread,
  );
  await core.append(
    [
      ...answered("fixture-rewind-built", "Build the festival now.", [said("Starting a build for the festival.")]),
      run(CustomEvent.RunStarted, { goal: "A lantern festival", engine: EngineId.ClaudeCode, model: FIXTURE_MODEL }),
      run(CustomEvent.RunFinished, {
        landed: true,
        summary: "The festival is ready to play.",
        executionStatus: ExecutionStatus.Completed,
      }),
    ],
    thread,
  );
  await core.append(
    answered("fixture-rewind-failed", "Add fireworks over the water.", [
      { type: EventKind.Error, message: "The model stopped before it answered." },
    ]),
    thread,
  );
  await core.append(
    [
      ...sent(boats, "Float paper boats down the river."),
      customEventData(CustomEvent.CoordinatorMessageProcessing, { messageId: boats }),
      // Sent while the boats were being answered, and read by that answer.
      ...sent(joined, "And make them glow."),
      customEventData(CustomEvent.CoordinatorMessageSteering, { messageId: joined, into: boats }),
      customEventData(CustomEvent.CoordinatorMessageDelivered, { messageId: joined, into: boats, how: "native" }),
      said("Paper boats drift down the river, each with a small glowing lantern."),
      customEventData(CustomEvent.CoordinatorMessageHandled, { messageId: boats }),
    ],
    thread,
  );
}

const BRIDGE = { workerId: "bridge", title: "Wooden bridge across the river" } as const;
/** The plan the `chat-questions` fixture asks the person to approve. */
const FIXTURE_PLAN =
  "## Moonlit bridge\n\n1. Add a wooden bridge over the river with rope rails.\n2. Light the village with warm lanterns that flicker at dusk.\n3. Let the player cross and hear the planks creak.\n\nFiles: `src/bridge.ts`, `src/lights.ts`.";
const LIGHT = { workerId: "light", title: "Warm lights in the village" } as const;

function longChat(): EventData[] {
  return Array.from({ length: CHAT_MESSAGES }, (_, n) => ({
    type: EventKind.Messages,
    messages: [
      n % 2
        ? {
            role: "assistant",
            content: `Update ${n}: the river path is easier to follow. The game keeps its existing controls and you can try the change in Live.`,
          }
        : { role: "user", content: `Request ${n}: improve the river village.` },
    ],
  }));
}

function toolReads(): EventData[] {
  const tools: EventData[] = [];
  for (let n = 0; n < TOOL_READS; n++) {
    const failed = n === FAILED_READ;
    tools.push({
      type: EventKind.ToolRequested,
      tool_call_id: `read-${n}`,
      // The last read names a file the game has, so its row carries a file link.
      request: { name: "read_file", arguments: { path: n === LAST_READ ? "src/main.js" : `src/village/part-${n}.ts` } },
    });
    tools.push({
      type: EventKind.ToolResult,
      tool_call_id: `read-${n}`,
      result: {
        ok: !failed,
        content: failed
          ? "Could not read the optional texture. The existing material is unchanged."
          : "Read the bridge dimensions and ground height.",
      },
    });
  }
  return tools;
}

/** A plugin's cover: the call starting, the file it delivered, and the call finishing. */
async function makeCover(
  dir: string,
  append: (...args: Parameters<ReturnType<typeof fixtureRun>>) => Promise<unknown>,
): Promise<void> {
  await append(CustomEvent.PluginToolStarted, {
    callId: "cover",
    pluginName: "Image studio",
    tool: "generate",
    toolName: "images__generate",
    args: "Village at dusk",
  });
  await fs.mkdir(path.join(dir, "assets"), { recursive: true });
  await fs.writeFile(path.join(dir, "assets", "village-cover.png"), SHOT);
  await append(CustomEvent.AssetDelivered, {
    source: "Image studio",
    jobId: "cover",
    at: new Date().toISOString(),
    files: [{ file: "assets/village-cover.png", kind: "image", bytes: SHOT.length }],
  });
  await append(CustomEvent.PluginTool, {
    callId: "cover",
    pluginName: "Image studio",
    tool: "generate",
    ok: true,
    files: ["assets/village-cover.png"],
  });
}

/** A reply that names files, the way agents do: they open beside the chat. */
async function writeBrief(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, "docs"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "docs", "BRIEF.md"),
    "# Village at dusk\n\nA river village you can cross at night.\n\n## Parts\n\n1. **Wooden bridge** across the river.\n2. **Warm lights** in the cottages.\n\nThe cover lives in `assets/village-cover.png`; see [the notes](NOTES.md).\n",
  );
  await fs.writeFile(
    path.join(dir, "docs", "NOTES.md"),
    "# Notes\n\nLights use a warm orange; the bridge planks are 0.4 m wide.\n",
  );
}

/** Once the window is up: a new build starts in the long chat, a builder mid-read; `chat-questions` also asks. */
export async function activateLiveChat(
  core: StudioCore,
  fixture: { fixture: string; threadId: string; project: string },
) {
  const runId = `fixture-chat-live-${Date.now()}`;
  const run = fixtureRun({ runId, project: fixture.project });
  await core.append(
    [
      run(CustomEvent.RunStarted, {
        goal: "A bridge and a village at dusk",
        budgets: { wallClockMs: FIXTURE_BUILD_LIMIT_MS },
        engine: EngineId.Ollama,
        model: FIXTURE_MODEL,
      }),
      run(CustomEvent.DirectorWorker, { ...BRIDGE, mode: "single", state: "running" }),
      run(CustomEvent.DirectorWorker, { ...LIGHT, mode: "single", state: "done" }),
      run(CustomEvent.SessionActivity, { role: SessionActivityRole.Planner, phase: ChatActivityPhase.Thinking }),
      {
        type: EventKind.Custom,
        event_type: `${DELEGATED_PREFIX}${EngineId.Codex}`,
        payload: {
          runId,
          project: fixture.project,
          role: SessionActivityRole.Builder,
          facetId: "bridge",
          delegationId: "bridge-session",
          kind: "assistant",
          data: { parts: [{ type: "tool_use", id: "read-bridge", name: "Read", input: "src/bridge.ts" }] },
        },
      },
    ],
    fixture.threadId,
  );
  core.emit(UiEvent.ChatMessage, { threadId: fixture.threadId });
  if (fixture.fixture !== FixtureName.ChatQuestions) return;
  await askToUseTexture(core, fixture);
  askPermissions(core, fixture);
}

/**
 * Claude asks before a command and before building from its plan: the real permission ledger and
 * IPC, no model and no command. The answers are durable.
 */
function askPermissions(core: StudioCore, fixture: { threadId: string; project: string }): void {
  // Not awaited: each question waits for the user, and the fixture must finish starting first.
  void core
    .askToolPermission(fixture.project, fixture.threadId, {
      tool: "Bash",
      toolUseId: "fixture-bash",
      input: { command: "npm install three@0.170.0 --save", description: "Install three.js" },
      title: "Claude wants to run npm install three@0.170.0 --save",
      displayName: "Run command",
      description: "Install three.js",
      always: [{ kind: GrantKind.Rule, rule: "Bash(npm install:*)", scope: RuleScope.Game }],
    })
    .catch((error) => console.error("Chat permission fixture failed", error));
  void core
    .askToolPermission(fixture.project, fixture.threadId, {
      tool: PLAN_TOOL,
      toolUseId: "fixture-plan",
      always: [],
      input: { plan: FIXTURE_PLAN },
    })
    .catch((error) => console.error("Chat plan fixture failed", error));
}

/** Real consent ledger/IPC, no plugin invocation or external action. The answer is durable. */
async function askToUseTexture(core: StudioCore, fixture: { threadId: string; project: string }) {
  const game = (await core.games.list()).find((project) => project.name === fixture.project);
  if (!game) throw new Error(MESSAGE.missingGame(fixture.project));
  // Not awaited: the question waits for the user, and the fixture must finish starting first.
  void core
    .requestConsent(
      "Image studio",
      {
        name: "save_texture",
        description: "Save the generated texture",
        parameters: { type: "object", properties: {} },
        confirmation: "Use the new moon texture in this game?",
      },
      { file: "assets/moon-texture.png" },
      { project: fixture.project, directory: game.dir, threadId: fixture.threadId },
    )
    .catch((error) => console.error("Chat question fixture failed", error));
}

/**
 * Chats a build's feedback leaves: a delivered result, two stopped builds, a failed plan, a failed
 * build, and a reply that hands the user a command its sandbox refused.
 */
export async function seedChatFeedback(core: StudioCore, project: string, threadId: string): Promise<void> {
  await seedDeliveredResult(core);
  for (const [name, title, handoff] of STOPPED_BUILDS) await seedStoppedBuild(core, name, title, handoff);
  await seedFailedPlan(core);
  await seedFailedBuild(core, project, threadId);
  await seedCommandOffer(core);
}

/** A reply that needs ffmpeg the sandbox could not install, offered as a command the user can run. */
async function seedCommandOffer(core: StudioCore): Promise<void> {
  const game = await core.games.scaffold("engine-sounds", { title: "Engine sounds" });
  const thread = await core.threadForGame(game.name);
  await core.append(
    [
      {
        type: EventKind.Messages,
        messages: [
          { role: "user", content: "Convert the engine recordings in assets/src to ogg." },
          {
            role: "assistant",
            content:
              "Converting them needs ffmpeg, and my sandbox can’t download it. Run this once, then I’ll convert the recordings:\n\n```bash\nbrew install ffmpeg\n```",
          },
        ],
      },
    ],
    thread,
  );
}

async function seedDeliveredResult(core: StudioCore): Promise<void> {
  const delivered = await core.games.scaffold("director-result", { title: "Director result" });
  const resultThread = await core.threadForGame(delivered.name);
  const resultRun = "fixture-director-result";
  const run = fixtureRun({ runId: resultRun, project: delivered.name });
  for (const folder of ["base", "judge_1"]) {
    const dir = path.join(core.layout.runs, resultRun, "director", folder);
    await fs.mkdir(dir, { recursive: true });
    const image = path.join(dir, "default.jpg");
    await fs.writeFile(image, SHOT);
    await fs.writeFile(
      path.join(dir, "verdict.json"),
      JSON.stringify({
        commit: "built-base",
        head: "delivered-head",
        target: "integration",
        shots: [{ camera: "default", path: image }],
      }),
    );
  }
  await core.append(
    [
      run(CustomEvent.RunStarted, {
        goal: "Build an arcade football match with responsive passing and shooting.",
        budgets: { wallClockMs: 3_600_000 },
        reference: {
          name: "EA Sports FIFA / EA FC (broadcast camera view) with a very long direction that stays within the build input card",
          kind: "direction",
        },
      }),
      run(CustomEvent.AutopilotStarted, { director: true, facets: [] }),
      run(CustomEvent.AutopilotBase, { ok: true, commit: "built-base" }),
      run(CustomEvent.RunFinished, {
        mode: "director",
        landed: true,
        integrationHead: "delivered-head",
        baseCommit: "empty-scaffold",
        summary: "A football match is ready.",
        executionStatus: ExecutionStatus.Completed,
      }),
    ],
    resultThread,
  );
}

/** Stop, with and without a follow-up waiting: one stopped line with Resume, or the follow-up takes over. */
const STOPPED_BUILDS = [
  ["stopped-build", "Stopped build", false],
  ["stopped-followup", "Stopped with a follow-up", true],
] as const;

async function seedStoppedBuild(core: StudioCore, name: string, title: string, handoff: boolean): Promise<void> {
  const game = await core.games.scaffold(name, { title });
  const thread = await core.threadForGame(game.name);
  const run = fixtureRun({ runId: `fixture-${name}`, project: game.name });
  const messageId = `${name}-question`;
  const queued: EventData[] = [
    { type: EventKind.Messages, messages: [{ role: "user", content: "do you see genex tools? just answer" }] },
    customEventData(CustomEvent.CoordinatorMessageQueued, { messageId }),
  ];
  const handled: EventData[] = [
    customEventData(CustomEvent.CoordinatorMessageProcessing, { messageId }),
    {
      type: EventKind.Messages,
      messages: [
        {
          role: "assistant",
          content: "Yes. Genex is installed for this game and its builders use it when the build continues.",
        },
      ],
    },
    customEventData(CustomEvent.CoordinatorMessageHandled, { messageId }),
  ];
  await core.append(
    [
      { type: EventKind.Messages, messages: [{ role: "user", content: "Build a village with a market." }] },
      run(CustomEvent.RunStarted, {
        goal: "A village with a market",
        engine: EngineId.ClaudeCode,
        model: FIXTURE_MODEL,
      }),
      run(CustomEvent.AutopilotStarted, { director: true, facets: [] }),
      run(CustomEvent.DirectorWorker, {
        workerId: "market",
        title: "Market and town edge polish with lived-in surfaces",
        mode: "loop",
        state: "running",
      }),
      run(CustomEvent.IntegrationMerge, {
        facetId: "market",
        commit: "c0ffee1234",
        head: "stopped-head",
        conflict: false,
        stage: "director",
      }),
      ...(handoff ? queued : []),
      run(CustomEvent.RunFinished, {
        mode: "director",
        landed: false,
        integrationHead: "stopped-head",
        baseCommit: "base-head",
        stoppedBecause: "stopped by the user",
        executionStatus: ExecutionStatus.Paused,
      }),
      run(CustomEvent.AutopilotPaused),
      ...(handoff ? handled : []),
    ],
    thread,
  );
}

/** A plan that failed on a model limit, waiting for another model. */
async function seedFailedPlan(core: StudioCore): Promise<void> {
  const recovery = await core.games.scaffold("model-recovery", { title: "Model recovery" });
  const recoveryThread = await core.threadForGame(recovery.name);
  const review = {
    id: "fixture-failed-plan",
    state: "failed" as const,
    text: "fixture:plan-unavailable: make a football game",
    error: "You have reached your model limit. Choose another model.",
    options: {
      thread: recoveryThread,
      engine: EngineId.ClaudeCode,
      model: FIXTURE_MODEL,
      reviewPlan: true,
      autopilot: { hours: 1 },
    },
  };
  await core.store.updateThread(recoveryThread, {
    metadata: { planReview: review, lastEngine: EngineId.ClaudeCode, lastModel: FIXTURE_MODEL },
  });
  const { options: _options, ...reviewPayload } = review;
  await core.append([customEventData(CustomEvent.PlanReview, reviewPayload)], recoveryThread);
}

/** A build of the fixture game whose starting point ran out of time. */
async function seedFailedBuild(core: StudioCore, project: string, threadId: string): Promise<void> {
  const run = fixtureRun({ runId: "fixture-feedback" });
  const lostTime = "The starting point could not be built before its time limit.";
  await core.append(
    [
      {
        type: EventKind.Messages,
        messages: [
          { role: "user", content: "Can we make a Morrowind scene?" },
          {
            role: "assistant",
            content:
              "**test-4** (folder `AI Games/test-4`) — Claude Code (opus) · medium effort conducts the build interview itself and starts the run when it has what it needs.",
          },
        ],
      },
      run(CustomEvent.RunStarted, { project, engine: EngineId.Codex, model: FIXTURE_MODEL, goal: "A Morrowind scene" }),
      run(CustomEvent.AutopilotDecision, { plain: "The studio is building the starting point first." }),
      {
        type: EventKind.ToolRequested,
        tool_call_id: "fixture-command",
        request: { name: "run_command", arguments: { command: "npm run build" } },
      },
      { type: EventKind.ToolResult, tool_call_id: "fixture-command", result: { ok: false, content: lostTime } },
      run(CustomEvent.AutopilotDecision, { plain: lostTime }),
      run(CustomEvent.RunFinished, {
        project,
        landed: false,
        executionStatus: ExecutionStatus.Completed,
        summary: "No playable build was delivered. The starting-point attempt used the available working time.",
        stoppedBecause: "time budget exhausted",
      }),
      customEventData(CustomEvent.SkilloptPass, { tasks: 8, staged: 1, accepted: 0, rejected: 0 }),
    ],
    threadId,
  );
}

/** Once the window is up: two builds whose plans wait for a go, one to approve and one to change. */
export async function activatePlanReviews(core: StudioCore): Promise<void> {
  for (const name of ["plan-approval", "plan-changes"]) {
    const project =
      (await core.games.list()).find((game) => game.name === name) ??
      (await core.games.scaffold(name, { title: name }));
    const threadId = await core.threadForGame(project.name);
    const run = fixtureRun({ runId: `fixture-${name}-${Date.now()}` });
    await core.append(
      [
        run(CustomEvent.RunStarted, {
          project: project.name,
          goal: "A small night scene",
          engine: EngineId.Codex,
          model: FIXTURE_MODEL,
        }),
        run(CustomEvent.AutopilotPlanReview, {
          summary: "Build a small night scene with mushroom trees.",
          waitMinutes: 20,
        }),
      ],
      threadId,
    );
  }
}
