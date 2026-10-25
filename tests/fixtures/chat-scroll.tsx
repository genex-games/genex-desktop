/**
 * Test-owned production ChatPanel holding a long game chat (a hundred and more turns of reports,
 * lists, code and tool work), for scrolling it fast. The runner flings the scroller with real
 * input; the page samples, in every frame it draws, how much of the viewport the transcript left
 * empty. No engine, account or network.
 */
import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { ChatPanelProps } from "../../src/renderer/chat/chat-panel-props.ts";
import { ChatPanel } from "../../src/renderer/panels/ChatPanel.tsx";
import { ChatActivityPhase, SessionActivityRole } from "../../src/shared/chat-activity.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import type { EngineDescriptor } from "../../src/shared/engine-descriptor.ts";
import { type EventData, type EventEnvelope, EventKind, ThreadKind } from "../../src/shared/event-log.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing fixture root");
const root = createRoot(rootElement);
const THREAD = "scroll-thread";
const PROJECT = "golden-boot";
const DATE = "2026-10-02T00:00:00.000Z";
/** How many turns the chat holds: each a request, its tool work and a report. */
const TURNS = 120;
/** How many frames in a row nothing may move before the opened chat counts as settled. */
const SETTLED_FRAMES = 10;
/** The longest an opened chat may take to settle. */
const SETTLE_LIMIT_MS = 5000;
/** While the chat works: a tool call lands this often, and its reply streams a piece this often. */
const WORK_EVENT_MS = 250;
const STREAM_PIECE_MS = 40;
const STREAM_PIECE_CHARS = 12;
const IDLE = "idle";
/** The harness's status while the chat's own turn runs. */
const TURN_STATUS = `claude-code building ${PROJECT}`;

const SENTENCES = [
  "The scoreboard builder's last round is merged and the build starts cleanly after it.",
  "The mini-map is smaller now and sits on the bottom edge, out of the way of the ball.",
  "I changed the camera myself: it slides along the touchline with play instead of swinging round.",
  "I tested it by sprinting into the penalty area, and the view is far less steep.",
  "The goal still shows at a slight angle, which is close to how real TV coverage looks.",
  "Floodlight banks now light the pitch against a black night sky, and the stands sit darker.",
  "The referee follows play at a jog and stops to point at the spot after a foul in the box.",
  "Shots from outside the area now dip late, so a keeper standing off his line can be caught.",
  "Player idle animations shift weight from foot to foot instead of freezing between passes.",
  "The crowd noise swells as the ball nears either box and drops after a wide shot.",
  "No errors appeared in the console while I played two full halves.",
  "I told the gameplay builder to move its shot-aiming hint off the mini-map.",
];
const FILES = ["src/camera.js", "src/scoreboard.js", "src/stadium.js", "src/players.js", "src/referee.js", "src/hud.css"];
const TOOLS = ["Read", "Edit", "Bash", "Grep"];

const pick = <T,>(list: readonly T[], index: number): T => list[index % list.length] as T;
const sentence = (turn: number, at: number): string => pick(SENTENCES, turn * 7 + at * 5);

/** A report as long and as varied as a builder's: paragraphs, and now and then a list, code or a table. */
function report(turn: number): string {
  const paragraphs = Array.from({ length: 2 + (turn % 4) }, (_, p) =>
    Array.from({ length: 2 + ((turn + p) % 3) }, (_, s) => sentence(turn, p * 3 + s)).join(" "),
  );
  const parts = [...paragraphs];
  if (turn % 3 === 0)
    parts.push(
      Array.from({ length: 3 + (turn % 3) }, (_, i) => `- **${pick(["Stadium", "Camera", "Referee", "Crowd", "HUD"], turn + i)}:** ${sentence(turn, i + 9)}`).join("\n"),
    );
  if (turn % 5 === 2)
    parts.push(
      `\`\`\`js\nexport function followPlay(camera, ball, dt) {\n  const target = touchlinePoint(ball.position);\n  camera.position.lerp(target, 1 - Math.exp(-${turn % 9} * dt));\n  camera.lookAt(ball.position.x, 0, ball.position.z * 0.6);\n  return camera;\n}\n\`\`\``,
    );
  if (turn % 7 === 4)
    parts.push("| Part | State |\n| --- | --- |\n| Scoreboard | merged |\n| Camera | merged |\n| Stadium | building |");
  parts.push(`Still working: ${pick(["gameplay balance", "shot outcomes", "the referee", "the stadium's final minutes"], turn)}.`);
  return parts.join("\n\n");
}

const noop = () => {};
let sequence = 0;
function envelope(data: EventData): EventEnvelope {
  return {
    id: `e${String(++sequence).padStart(6, "0")}`,
    thread_id: THREAD,
    session_id: null,
    turn_id: null,
    created_at: DATE,
    data,
  };
}
const said = (role: "user" | "assistant", content: string): EventEnvelope =>
  envelope({ type: EventKind.Messages, messages: [{ role, content }] });
const custom = (eventType: string, payload: Record<string, unknown>): EventEnvelope =>
  envelope({ type: EventKind.Custom, event_type: eventType, payload: { project: PROJECT, ...payload } });

/** One finished turn: the request, its tool work ("Worked on N steps") and the report. */
function turnEvents(turn: number): EventEnvelope[] {
  const tools = Array.from({ length: 2 + (turn % 6) }, (_, i) => `t${turn}-${i}`);
  return [
    said("user", `${pick(["Make the camera less steep near the goals.", "Darken the stands at night.", "Give the referee assistants."], turn)} ${turn % 2 ? sentence(turn, 1) : ""}`.trim()),
    envelope({ type: EventKind.TurnStarted }),
    ...tools.flatMap((id, i) => [
      envelope({
        type: EventKind.ToolRequested,
        tool_call_id: id,
        request: { name: pick(TOOLS, turn + i), arguments: { file_path: pick(FILES, turn + i) } },
      }),
      envelope({ type: EventKind.ToolResult, tool_call_id: id, result: { ok: true, content: "ok" } }),
    ]),
    said("assistant", report(turn)),
    envelope({ type: EventKind.TurnEnded, status: "ok" }),
  ];
}

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

const fake = fakeStudioApi();
window.studio = fake.api;
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
  onSend: async () => {},
};

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const scroller = (): HTMLElement => {
  const element = document.querySelector<HTMLElement>("[data-chat-scroll]");
  if (!element) throw new Error("Missing conversation scroller");
  return element;
};

/** Wait until the chat's rows stop moving (they settle as they are measured). */
async function settled(): Promise<void> {
  const rows = () =>
    `${scroller().scrollTop}|${[...document.querySelectorAll("[data-chat-entry]")].map((row) => row.getBoundingClientRect().top).join()}`;
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

let events: EventEnvelope[] = [];
let status = IDLE;
let busySince: number | null = null;

function render(): void {
  const panel = <ChatPanel {...props} events={events} stateEvents={events} status={status} busySince={busySince} />;
  // Owned builds run development React under StrictMode (renderer/studio-entry.tsx); the fixture matches its build.
  root.render(process.env.NODE_ENV === "development" ? <StrictMode>{panel}</StrictMode> : panel);
}
const append = (...added: EventEnvelope[]): void => {
  events = [...events, ...added];
  render();
};

/** Open the long chat fresh, as a person does: at its newest message, nothing above measured yet. */
async function openChat(): Promise<{ entries: number; scrollHeight: number; clientHeight: number }> {
  stopWork();
  sequence = 0;
  status = IDLE;
  busySince = null;
  events = Array.from({ length: TURNS }, (_, turn) => turnEvents(turn)).flat();
  flushSync(() => root.render(null));
  flushSync(render);
  await settled();
  const element = scroller();
  return {
    entries: Number(document.querySelector<HTMLElement>("[data-chat-transcript]")?.dataset.totalEntries ?? 0),
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  };
}

const STREAM = { threadId: THREAD, streamId: "stream-work" };
let work: ReturnType<typeof setInterval>[] = [];
let streamed = "";

/** The chat starts a turn and keeps working: tool calls land and the reply streams while the reader scrolls. */
function startWork(): void {
  stopWork();
  status = TURN_STATUS;
  busySince = Date.now();
  append(said("user", "Give the referee assistants."), envelope({ type: EventKind.TurnStarted }));
  append(custom(CustomEvent.SessionActivity, { role: SessionActivityRole.Planner, phase: ChatActivityPhase.Responding }));
  fake.emit({ type: UiEvent.ChatStreamStarted, payload: { ...STREAM, afterEventId: events.at(-1)?.id ?? null } });
  streamed = "";
  const text = report(TURNS);
  let call = 0;
  work = [
    setInterval(() => {
      const id = `work-${++call}`;
      append(
        envelope({ type: EventKind.ToolRequested, tool_call_id: id, request: { name: pick(TOOLS, call), arguments: { file_path: pick(FILES, call) } } }),
        envelope({ type: EventKind.ToolResult, tool_call_id: id, result: { ok: true, content: "ok" } }),
      );
    }, WORK_EVENT_MS),
    setInterval(() => {
      const piece = text.slice(streamed.length % text.length, (streamed.length % text.length) + STREAM_PIECE_CHARS);
      streamed += piece;
      fake.emit({ type: UiEvent.ChatDelta, payload: { ...STREAM, delta: piece } });
    }, STREAM_PIECE_MS),
  ];
}

/** The turn ends: its reply is saved and the chat goes idle. */
function stopWork(): void {
  if (!work.length) return;
  for (const timer of work) clearInterval(timer);
  work = [];
  const reply = said("assistant", streamed);
  append(reply);
  fake.emit({ type: UiEvent.ChatStreamCommitted, payload: { ...STREAM, eventId: reply.id } });
  status = IDLE;
  busySince = null;
  append(envelope({ type: EventKind.TurnEnded, status: "ok" }));
}

/** Where the runner aims its input: the scroller's middle, in viewport pixels, and its painted band. */
function scrollerBox(): { x: number; y: number; top: number; bottom: number; left: number; right: number } {
  const rect = scroller().getBoundingClientRect();
  return {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    top: rect.top,
    bottom: rect.bottom,
    left: rect.left,
    right: rect.right,
  };
}

/** Move to the very top or bottom without input, and wait until it holds there. */
async function scrollToEdge(edge: "top" | "bottom"): Promise<number> {
  const element = scroller();
  element.scrollTop = edge === "top" ? 0 : element.scrollHeight;
  await settled();
  element.scrollTop = edge === "top" ? 0 : element.scrollHeight;
  await settled();
  return element.scrollTop;
}

/** One drawn frame: where the scroll was and how much of the viewport no row covered. */
interface ScrollFrame {
  at: number;
  scrollTop: number;
  /** Viewport pixels inside the transcript that no mounted row covers (its placeholder space). */
  uncovered: number;
  mounted: number;
}

/** Viewport pixels of the transcript that no mounted row covers in this frame. */
function uncoveredPx(): number {
  const transcript = document.querySelector("[data-chat-transcript]");
  if (!transcript) return 0;
  const view = scroller().getBoundingClientRect();
  const band = transcript.getBoundingClientRect();
  const top = Math.max(view.top, band.top);
  const bottom = Math.min(view.bottom, band.bottom);
  if (bottom <= top) return 0;
  const rows = [...transcript.querySelectorAll<HTMLElement>(":scope > [data-chat-entry]")]
    .map((row) => row.getBoundingClientRect())
    .filter((rect) => rect.bottom > top && rect.top < bottom)
    .sort((a, b) => a.top - b.top);
  let covered = 0;
  let reach = top;
  for (const rect of rows) {
    const from = Math.max(reach, rect.top);
    const to = Math.min(bottom, rect.bottom);
    if (to > from) covered += to - from;
    reach = Math.max(reach, to);
  }
  return Math.round(bottom - top - covered);
}

let frames: ScrollFrame[] = [];
let longTasks: number[] = [];
let sampling = false;
let tasks: PerformanceObserver | null = null;

/** Sample every drawn frame (read just after it was drawn) and the long tasks, until `stopSampling`. */
function startSampling(): void {
  frames = [];
  longTasks = [];
  sampling = true;
  tasks = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push(Math.round(entry.duration));
  });
  tasks.observe({ type: "longtask" });
  const start = performance.now();
  const tick = (): void => {
    if (!sampling) return;
    const at = Math.round(performance.now() - start);
    setTimeout(() => {
      if (!sampling) return;
      frames.push({
        at,
        scrollTop: Math.round(scroller().scrollTop),
        uncovered: uncoveredPx(),
        mounted: Number(document.querySelector<HTMLElement>("[data-chat-transcript]")?.dataset.mountedEntries ?? 0),
      });
    }, 0);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function stopSampling(): { frames: ScrollFrame[]; longTasks: number[] } {
  sampling = false;
  tasks?.disconnect();
  return { frames, longTasks };
}

Object.assign(window, { openChat, scrollerBox, scrollToEdge, startSampling, stopSampling, startWork, stopWork });
