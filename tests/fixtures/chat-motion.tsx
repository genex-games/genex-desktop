/**
 * Test-owned production ChatPanel driven through what a person watches happen in a game chat — a
 * message sent, the work it starts, tools, a streamed reply, a permission question, a build and
 * sent pictures — recording every frame (`motion-recorder.ts`) and how often the transcript's rows
 * were drawn (`PerformanceComponent.TranscriptRow`). No engine, account or network.
 */
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { ChatPanelProps } from "../../src/renderer/chat/chat-panel-props.ts";
import { ChatPanel } from "../../src/renderer/panels/ChatPanel.tsx";
import { ChatActivityPhase, SessionActivityRole } from "../../src/shared/chat-activity.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { SteerDelivery } from "../../src/shared/message-queue.ts";
import type { EngineDescriptor } from "../../src/shared/engine-descriptor.ts";
import { type EventData, type EventEnvelope, EventKind, ThreadKind } from "../../src/shared/event-log.ts";
import { PerformanceComponent } from "../../src/shared/performance.ts";
import { ToolPermissionState } from "../../src/shared/permissions.ts";
import type { ReferenceFrame } from "../../src/shared/protocol.ts";
import { UiEvent, type UiEventMap } from "../../src/shared/ui-events.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";
import { type Held, heldStill, type MotionReport, motionReport, recordFrames } from "./motion-recorder.ts";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing fixture root");
const root = createRoot(rootElement);
const THREAD = "motion-thread";
const PROJECT = "motion-game";
const RUN = "run_motion";
const DATE = "2026-10-02T00:00:00.000Z";
const IDLE = "idle";
/** The harness's status while the chat's own turn runs (statusWords: "Building motion-game"). */
const TURN_STATUS = `claude-code building ${PROJECT}`;
/** How many earlier messages each size of chat holds: two, enough to scroll several screens, and a long session's. */
const HISTORY_MESSAGES = { short: 2, long: 40, huge: 400 } as const;
type ChatSize = keyof typeof HISTORY_MESSAGES;
/** How many tool calls the busy turn makes, and how quickly one follows another. */
const MANY_TOOLS = 30;
const TOOL_GAP_MS = 60;
/** Every how many earlier requests one was sent with pictures, and how many. */
const PICTURE_EVERY = 4;
const PICTURES_PER_MESSAGE = 2;
/** A sent picture's size in pixels: a screenshot scaled down, as the composer keeps it. */
const PICTURE_SIZE = { width: 1280, height: 800 } as const;
const REPLY =
  "The sky now warms toward the horizon at dusk. **The sun sits lower**, and the clouds pick up a soft orange edge as it sets. I kept the night colours as they were, so the stars still come out on time. Try it in the preview and watch the light change over the village.";
const STREAM_PIECE_CHARS = 9;
const STREAM_PIECE_MS = 50;
/** A long code-heavy reply streamed as fast as a quick model writes (about 1,500 characters a second). */
const LONG_REPLY = Array.from(
  { length: 12 },
  (_, i) =>
    `### Step ${i + 1}: the bridge\n\nThe deck stays level with the bank and every plank snaps to the same grid. **Nothing here changes the camera.**\n\n- Keep the planks under one parent.\n- Reuse one material.\n\n\`\`\`js\nexport function buildSection${i}(scene, planks) {\n  const group = new THREE.Group();\n  for (let x = 0; x < planks; x++) group.add(new THREE.Mesh(PLANK, WOOD));\n  scene.add(group);\n  return group;\n}\n\`\`\``,
).join("\n\n");
const LONG_PIECE_CHARS = 12;
const LONG_PIECE_MS = 8;
/** How long the clock scene's work has already run as it opens: its clock reaches 10s within the scene. */
const CLOCK_STARTED_MS = 9_300;
/** How long the host takes to save a message sent to a build's lead, and then to answer the send. */
const SAVE_MS = 60;
const ACK_MS = 60;

const noop = () => {};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let sequence = 0;
function envelope(data: EventData): EventEnvelope {
  return {
    id: `e${String(++sequence).padStart(5, "0")}`,
    thread_id: THREAD,
    session_id: null,
    turn_id: null,
    created_at: DATE,
    data,
  };
}
const said = (role: "user" | "assistant", content: string): EventEnvelope =>
  envelope({ type: EventKind.Messages, messages: [{ role, content }] });
const custom = (eventType: string, payload: Record<string, unknown> = {}): EventEnvelope =>
  envelope({ type: EventKind.Custom, event_type: eventType, payload: { runId: RUN, project: PROJECT, ...payload } });

const model = { id: "opus", label: "Opus", contextWindow: 200_000, supportsTools: true, supportsVision: true };
const claude: EngineDescriptor = {
  id: "claude-code",
  label: "Claude",
  kind: "delegated",
  supportsSessions: true,
  status: { code: "ready", detail: "" },
  defaultModel: "opus",
  models: [model],
};

/** One sent picture, drawn once: a gradient big enough to take a real decode. */
function drawPicture(): ReferenceFrame {
  const canvas = document.createElement("canvas");
  canvas.width = PICTURE_SIZE.width;
  canvas.height = PICTURE_SIZE.height;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, "#3b6fd8");
    gradient.addColorStop(1, "#f0a24a");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < 400; i++) {
      ctx.fillStyle = `hsl(${(i * 37) % 360} 70% 60%)`;
      ctx.fillRect((i * 97) % canvas.width, (i * 61) % canvas.height, 24, 24);
    }
  }
  const data = canvas.toDataURL("image/png").split(",")[1] ?? "";
  return { label: "screenshot.png", mimeType: "image/png", data };
}
const PICTURE = drawPicture();

const fake = fakeStudioApi();
window.studio = {
  ...fake.api,
  messageImages: async () => Array.from({ length: PICTURES_PER_MESSAGE }, () => PICTURE),
};
let events: EventEnvelope[] = [];
let status = IDLE;
let sent: string[] = [];
/** What the host does with a send before answering it, when a scene says; the newest send's id. */
let host: ((text: string, clientId: string | undefined) => Promise<void>) | null = null;
let lastClientId: string | undefined;
/** When the scene's build card must hold still from (`performance.now()`), when it has one. */
let steadyFrom: number | null = null;
const props: ChatPanelProps = {
  events: [],
  stateEvents: [],
  history: { hasMore: false, paging: false, loadEarlier: async () => {} },
  engines: [claude],
  games: [],
  activeThread: {
    id: THREAD,
    agent_id: "studio",
    created_at: DATE,
    updated_at: DATE,
    latest_event_id: null,
    metadata: { kind: ThreadKind.Game, project: PROJECT },
  },
  status: IDLE,
  busySince: null,
  loading: false,
  sidebarHidden: false,
  onRetryLoad: noop,
  onToggleSidebar: noop,
  onEnginesRefresh: noop,
  onRename: noop,
  onNotice: noop,
  onSend: async (text, options) => {
    sent = [...sent, text];
    lastClientId = options.clientId;
    await host?.(text, options.clientId);
  },
};
function render(): void {
  flushSync(() =>
    root.render(
      <ChatPanel {...props} events={events} stateEvents={events} status={status} busySince={busySince(status)} />,
    ),
  );
}
const startedAt = new Map<string, number>();
const busySince = (value: string): number | null => {
  if (value === IDLE) return null;
  if (!startedAt.has(value)) startedAt.set(value, Date.now());
  return startedAt.get(value) ?? null;
};
const append = (...added: EventEnvelope[]): void => {
  events = [...events, ...added];
  render();
};
const setStatus = (value: string): void => {
  status = value;
  render();
};
const stream = (streamId: string) => ({ threadId: THREAD, streamId });
const delta = (payload: UiEventMap[typeof UiEvent.ChatDelta]) => fake.emit({ type: UiEvent.ChatDelta, payload });

/** An earlier request, with pictures on every few: its row, and the queue's records that saved its pictures. */
function earlierRequest(index: number, pictures: boolean): EventEnvelope[] {
  const text = `Earlier request ${index + 1}: move the lanterns along the bridge.`;
  const row = said("user", text);
  if (!pictures || index % PICTURE_EVERY !== 0) return [row];
  const messageId = `pictures-${index}`;
  const action = { text, attachmentsArtifact: `${messageId}.json`, imageCount: PICTURES_PER_MESSAGE };
  return [
    row,
    custom(CustomEvent.CoordinatorMessageQueued, { messageId, eventId: row.id, action }),
    custom(CustomEvent.CoordinatorMessageHandled, { messageId }),
  ];
}

/** The chat as a person opens it: a few messages, enough to scroll several screens, or a long session's. */
function seed(size: ChatSize, pictures = false): void {
  sequence = 0;
  sent = [];
  host = null;
  steadyFrom = null;
  status = IDLE;
  startedAt.clear();
  events = Array.from({ length: HISTORY_MESSAGES[size] }, (_, i) =>
    i % 2 === 0
      ? earlierRequest(i / 2, pictures)
      : [said("assistant", `Done. The lanterns now line both rails of the bridge, ${i} metres apart.`)],
  ).flat();
  flushSync(() => root.render(null));
  render();
}

/** The real composer's text box. */
function composerBox(): HTMLTextAreaElement {
  const box = document.querySelector<HTMLTextAreaElement>('[data-promptbar] textarea[aria-label="Prompt"]');
  if (!box) throw new Error("Missing composer");
  return box;
}

/** Type in the real composer, as a person does. */
async function typeInComposer(text: string): Promise<void> {
  const box = composerBox();
  box.focus();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(box, text);
  box.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(50);
}

/** Press Enter in the real composer. */
function pressEnter(): void {
  composerBox().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
}

/** Type in the real composer and press Enter, as a person does. */
async function sendFromComposer(text: string): Promise<void> {
  await typeInComposer(text);
  pressEnter();
}

const activity = (phase: string) =>
  custom(CustomEvent.SessionActivity, { role: SessionActivityRole.Planner, phase });
const toolCall = (id: string, name: string, path: string) =>
  envelope({ type: EventKind.ToolRequested, tool_call_id: id, request: { name, arguments: { file_path: path } } });
const toolDone = (id: string) =>
  envelope({ type: EventKind.ToolResult, tool_call_id: id, result: { ok: true, content: "ok" } });

/** One turn of the chat's own work: saved, thinking, two tools, a streamed reply, done. */
async function turn(): Promise<void> {
  await sendFromComposer("Make the sky a little warmer at dusk");
  await sleep(70);
  const asked = sent.at(-1) ?? "";
  status = TURN_STATUS;
  append(said("user", asked));
  await sleep(20);
  append(envelope({ type: EventKind.TurnStarted }));
  await sleep(450);
  append(toolCall("read-1", "Read", "src/sky.js"));
  await sleep(420);
  append(toolDone("read-1"), toolCall("edit-1", "Edit", "src/sky.js"));
  await sleep(420);
  append(toolDone("edit-1"), activity(ChatActivityPhase.Responding));
  fake.emit({
    type: UiEvent.ChatStreamStarted,
    payload: { ...stream("stream-1"), afterEventId: events.at(-1)?.id ?? null },
  });
  for (let at = STREAM_PIECE_CHARS; at < REPLY.length + STREAM_PIECE_CHARS; at += STREAM_PIECE_CHARS) {
    delta({ ...stream("stream-1"), delta: REPLY.slice(at - STREAM_PIECE_CHARS, at) });
    await sleep(STREAM_PIECE_MS);
  }
  await sleep(150);
  const reply = said("assistant", REPLY);
  append(reply);
  fake.emit({ type: UiEvent.ChatStreamCommitted, payload: { ...stream("stream-1"), eventId: reply.id } });
  await sleep(30);
  append(envelope({ type: EventKind.TurnEnded, status: "ok" }), activity(ChatActivityPhase.Completed));
  setStatus(IDLE);
  await sleep(900);
}

/** A long reply streamed fast, then saved: what drawing a long reply costs while it moves. */
async function longStream(): Promise<void> {
  status = TURN_STATUS;
  append(said("user", "Write the whole bridge module"), activity(ChatActivityPhase.Responding));
  fake.emit({
    type: UiEvent.ChatStreamStarted,
    payload: { ...stream("stream-long"), afterEventId: events.at(-1)?.id ?? null },
  });
  for (let at = LONG_PIECE_CHARS; at < LONG_REPLY.length + LONG_PIECE_CHARS; at += LONG_PIECE_CHARS) {
    delta({ ...stream("stream-long"), delta: LONG_REPLY.slice(at - LONG_PIECE_CHARS, at) });
    await sleep(LONG_PIECE_MS);
  }
  await sleep(300);
  const reply = said("assistant", LONG_REPLY);
  append(reply);
  fake.emit({ type: UiEvent.ChatStreamCommitted, payload: { ...stream("stream-long"), eventId: reply.id } });
  append(activity(ChatActivityPhase.Completed));
  setStatus(IDLE);
  await sleep(900);
}

/** Claude's request to run a command, as a pending question and as allowed. */
const permission = (requestId: string, state: string) =>
  custom(CustomEvent.ToolPermission, {
    requestId,
    threadId: THREAD,
    tool: "Bash",
    title: "Claude wants to run npm install three",
    description: "Install three.js",
    input: { command: "npm install three" },
    state,
  });

/** Claude asks before a command; the person allows it a little later. */
async function question(): Promise<void> {
  status = TURN_STATUS;
  append(permission("perm-1", ToolPermissionState.Pending));
  await sleep(1100);
  append(permission("perm-1", ToolPermissionState.Allowed));
  setStatus(IDLE);
  await sleep(900);
}

/**
 * The clock beside the status gains a digit (9s → 10s) while a tool's details stand behind the
 * chevron, goes while Claude asks and comes back once allowed: the chevron after it slides each time.
 */
async function clock(): Promise<void> {
  status = TURN_STATUS;
  startedAt.set(TURN_STATUS, Date.now() - CLOCK_STARTED_MS);
  append(said("user", "Light the lanterns"), envelope({ type: EventKind.TurnStarted }));
  append(toolCall("read-2", "Read", "src/lanterns.js"));
  await sleep(1500);
  append(permission("perm-2", ToolPermissionState.Pending));
  await sleep(900);
  append(permission("perm-2", ToolPermissionState.Allowed));
  await sleep(900);
  append(toolDone("read-2"), envelope({ type: EventKind.TurnEnded, status: "ok" }), activity(ChatActivityPhase.Completed));
  setStatus(IDLE);
  await sleep(900);
}

/** A build starts, runs for a moment and finishes. */
async function build(): Promise<void> {
  status = `run ${RUN}`;
  append(custom(CustomEvent.RunStarted, { goal: "A warmer dusk", budgets: { wallClockMs: 1_800_000 } }));
  await sleep(1300);
  append(custom(CustomEvent.RunFinished, { landed: false, summary: "No new build." }));
  setStatus(IDLE);
  await sleep(900);
}

/** The host saves a message to a build whose lead takes the chat; the send is answered a moment later. */
async function saveForTheLead(text: string, clientId: string | undefined): Promise<void> {
  await sleep(SAVE_MS);
  const row = said("user", text);
  append(row, custom(CustomEvent.CoordinatorMessageQueued, { messageId: clientId, eventId: row.id, action: { text } }));
  await sleep(ACK_MS);
}

/**
 * A message to a running build's lead: sent from the composer, saved, handed to the lead, and the
 * lead's answer. The build's card holds still on the composer from the moment Enter is pressed.
 */
async function steer(): Promise<void> {
  status = `run ${RUN}`;
  // Started now, so the card's clock reads seconds.
  const startedNow = (event: EventEnvelope): EventEnvelope => ({ ...event, created_at: new Date().toISOString() });
  append(
    startedNow(custom(CustomEvent.RunStarted, { goal: "A foggy coast", budgets: { wallClockMs: 18_000_000 } })),
    startedNow(custom(CustomEvent.AutopilotStarted, { director: true, liveChat: true })),
  );
  await sleep(1200);
  host = saveForTheLead;
  await typeInComposer("Make the fog thicker near the water");
  steadyFrom = performance.now();
  pressEnter();
  await sleep(500);
  append(custom(CustomEvent.CoordinatorMessageDelivered, { messageId: lastClientId, into: RUN, how: SteerDelivery.Lead }));
  await sleep(700);
  append(said("assistant", "The fog thickens over the water now; the lead gave it to the coast's part."));
  await sleep(900);
}

/** A busy turn: many tools, one after another, then a short reply. */
async function tools(): Promise<void> {
  status = TURN_STATUS;
  append(said("user", "Tidy up every lantern file"), envelope({ type: EventKind.TurnStarted }));
  await sleep(300);
  for (let i = 0; i < MANY_TOOLS; i++) {
    const id = `tool-${i}`;
    append(toolCall(id, i % 3 === 0 ? "Edit" : "Read", `src/lanterns/part-${i}.js`));
    await sleep(TOOL_GAP_MS);
    append(toolDone(id));
  }
  append(said("assistant", "Every lantern file is tidy now."));
  append(envelope({ type: EventKind.TurnEnded, status: "ok" }), activity(ChatActivityPhase.Completed));
  setStatus(IDLE);
  await sleep(900);
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
/** How far the pictures scene scrolls in one frame, px: a brisk scroll. */
const SCROLL_STEP_PX = 120;

/** The conversation's scroller. */
function scroller(): HTMLElement {
  const element = document.querySelector<HTMLElement>("[data-chat-scroll]");
  if (!element) throw new Error("Missing conversation");
  return element;
}

/** Scroll the conversation to its end a step a frame, as a person scrolling back down does. */
async function scrollDown(): Promise<void> {
  const element = scroller();
  while (element.scrollTop + element.clientHeight < element.scrollHeight - 1) {
    element.scrollTop += SCROLL_STEP_PX;
    await frame();
  }
  await sleep(300);
}

/**
 * Sent pictures that were already shown come back: scrolled back down to after they were scrolled
 * far out of sight (their rows left the window), and the chat opened again after another one.
 */
async function pictures(): Promise<void> {
  await scrollDown();
  flushSync(() => root.render(null));
  await sleep(120);
  render();
  await sleep(600);
}

/** Before the pictures scene records: its pictures loaded, then scrolled far out of sight. */
async function beforePictures(): Promise<void> {
  await sleep(600);
  scroller().scrollTop = 0;
  await sleep(600);
}

const SCENES = { turn, question, clock, build, longStream, steer, tools, pictures } as const;
type Scene = keyof typeof SCENES;

/** How many frames in a row nothing may move before the seeded chat counts as settled. */
const SETTLED_FRAMES = 10;
/** The longest a seeded chat may take to settle. */
const SETTLE_LIMIT_MS = 3000;

/** Wait until the opened chat's rows stop moving (they settle as they are measured). */
async function settled(): Promise<void> {
  const rows = () =>
    [...document.querySelectorAll("[data-chat-entry]")].map((row) => row.getBoundingClientRect().top).join();
  const until = performance.now() + SETTLE_LIMIT_MS;
  let still = 0;
  let last = rows();
  while (still < SETTLED_FRAMES && performance.now() < until) {
    await frame();
    const now = rows();
    still = now === last ? still + 1 : 0;
    last = now;
  }
}

/** How many times the transcript's rows have been drawn (mounted or updated) so far. */
const rowCommits = (): number => window.__studioPerformance?.[PerformanceComponent.TranscriptRow]?.commits ?? 0;

/**
 * Play one scene in a chat of a size (`true` is long, `false` short) and report what moved and how
 * many times its rows were drawn; `record: false` only plays it (to time the app alone).
 */
async function runMotionScene(
  scene: Scene,
  size: ChatSize | boolean = true,
  record = true,
): Promise<MotionReport & { scene: Scene; held?: Held; rowCommits: number }> {
  const chat: ChatSize = typeof size === "string" ? size : size ? "long" : "short";
  seed(chat, scene === "pictures");
  await sleep(400);
  await settled();
  const rowsOnScreen = () =>
    [...document.querySelectorAll<HTMLElement>("[data-chat-entry]")].map((row) => `row:${row.dataset.chatEntry}`);
  // History is every row the chat already had: scrolled away from, too.
  const history = new Set(rowsOnScreen());
  if (scene === "pictures") {
    await beforePictures();
    for (const row of rowsOnScreen()) history.add(row);
  }
  const drawnBefore = rowCommits();
  if (!record) {
    await SCENES[scene]();
    return { scene, ...motionReport({ frames: [], longTasks: [] }, history), rowCommits: rowCommits() - drawnBefore };
  }
  const start = performance.now();
  const stop = recordFrames();
  await SCENES[scene]();
  const recording = stop();
  const drawn = rowCommits() - drawnBefore;
  // Kept for a closer look at a failure (`window.lastMotionFrames`).
  Object.assign(window, { lastMotionFrames: recording.frames });
  const from = steadyFrom === null ? null : steadyFrom - start;
  const held = from === null ? {} : { held: heldStill(recording.frames.filter((frame) => frame.at >= from), "build", "composer") };
  return { scene, ...motionReport(recording, history), ...held, rowCommits: drawn };
}

Object.assign(window, { runMotionScene });
