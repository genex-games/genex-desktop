/**
 * Test-owned production ChatPanel beside the production stage strip of the same game: the
 * thread's latest `genex__cover` shoot that kept a shot leaves one card once its turn has ended,
 * the game's kept shot read from Genex's storage (`readProjectAsset`, scope `genex-cover`),
 * captioned Genex cover with Publish, which opens Studio's own Publish dialog through the strip. A
 * running publish or Genex turned off hide Publish; a shot that can no longer be read leaves no card.
 */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import manifest from "../../src/plugins/genex/plugin.json" with { type: "json" };
import { paintAppearance } from "../../src/renderer/appearance/paint.ts";
import { DEFAULT_APPEARANCE } from "../../src/renderer/appearance/themes.ts";
import { ChatPanel } from "../../src/renderer/panels/ChatPanel.tsx";
import { PluginToolbar } from "../../src/renderer/panels/PluginToolbar.tsx";
import type { ChatPanelProps } from "../../src/renderer/chat/chat-panel-props.ts";
import { OPEN_BESIDE_EVENT, type BesideTarget } from "../../src/renderer/open-beside.ts";
import { PLUGIN_SETUP_EVENT } from "../../src/renderer/plugin-setup.ts";
import { studio } from "../../src/renderer/state/studio.ts";
import { Icon } from "../../src/renderer/ui/icons.tsx";
import { ResultButton } from "../../src/renderer/ui/ResultButton.tsx";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { EventKind, ThreadKind, type EventEnvelope } from "../../src/shared/event-log.ts";
import { ProjectAssetScope, type ProjectAssetRead } from "../../src/shared/game-assets.ts";
import { GenexAction, type GenexCoverRecord, GenexCoverOutcome, type GenexPublishState } from "../../src/shared/genex.ts";
import type { PluginInfo } from "../../src/shared/plugins.ts";
import { CaptureSource, StillMimeType } from "../../src/shared/preview-contract.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const GAME = "harbor-run";
const THREAD = `${GAME}-thread`;
const AT = "2026-10-09T10:00:00.000Z";
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing fixture root");
const root = createRoot(rootElement);
const noop = () => {};
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function settle(frames = 10) {
  for (let i = 0; i < frames; i++) await frame();
}

/** A 16:9 frame that reads as a game's: sky, sea, a pier and a boat, in one hue per shot. */
function shotOf(hue: number, width: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.round((width * 9) / 16);
  const g = canvas.getContext("2d");
  if (!g) throw new Error("No canvas");
  g.scale(width / 1280, width / 1280);
  const sky = g.createLinearGradient(0, 0, 0, 430);
  sky.addColorStop(0, `hsl(${hue} 70% 22%)`);
  sky.addColorStop(1, `hsl(${(hue + 30) % 360} 85% 62%)`);
  g.fillStyle = sky;
  g.fillRect(0, 0, 1280, 430);
  g.fillStyle = `hsl(${(hue + 40) % 360} 90% 70%)`;
  g.beginPath();
  g.arc(930, 330, 80, 0, Math.PI * 2);
  g.fill();
  const sea = g.createLinearGradient(0, 430, 0, 720);
  sea.addColorStop(0, `hsl(${(hue + 190) % 360} 55% 32%)`);
  sea.addColorStop(1, `hsl(${(hue + 200) % 360} 60% 12%)`);
  g.fillStyle = sea;
  g.fillRect(0, 430, 1280, 290);
  g.fillStyle = "hsl(28 35% 22%)";
  g.fillRect(0, 470, 520, 34);
  for (let x = 30; x < 520; x += 90) g.fillRect(x, 504, 16, 150);
  g.fillStyle = "hsl(8 70% 48%)";
  g.beginPath();
  g.moveTo(700, 560);
  g.lineTo(980, 560);
  g.lineTo(940, 620);
  g.lineTo(740, 620);
  g.closePath();
  g.fill();
  g.fillStyle = "hsl(40 30% 92%)";
  g.beginPath();
  g.moveTo(835, 380);
  g.lineTo(835, 555);
  g.lineTo(950, 555);
  g.closePath();
  g.fill();
  return canvas.toDataURL("image/jpeg", 0.85).slice("data:image/jpeg;base64,".length);
}
/** The kept shot per scenario: the card's size (asked with `maxPx`) and the whole frame. */
const SHOTS: Record<string, { card: string; whole: string }> = {
  kept: { card: shotOf(18, 960), whole: shotOf(18, 1920) },
  brighter: { card: shotOf(40, 960), whole: shotOf(40, 1920) },
};

let sequence = 0;
const envelope = (data: EventEnvelope["data"]): EventEnvelope => ({
  id: `e${String(++sequence).padStart(4, "0")}`,
  thread_id: THREAD,
  session_id: null,
  turn_id: null,
  created_at: AT,
  data,
});
const said = (role: "user" | "assistant", content: string) =>
  envelope({ type: EventKind.Messages, messages: [{ role, content }] } as EventEnvelope["data"]);
/** A turn's edge as the substrate writes it, carrying the turn's id. */
const turn = (type: typeof EventKind.TurnStarted | typeof EventKind.TurnEnded, turnId: string) => ({
  ...envelope((type === EventKind.TurnEnded ? { type, status: "ok" } : { type }) as EventEnvelope["data"]),
  turn_id: turnId,
});
const custom = (eventType: string, payload: Record<string, unknown>) =>
  envelope({ type: EventKind.Custom, event_type: eventType, payload } as EventEnvelope["data"]);
/** One Genex call as the host records it: started, then finished, its answer's pictures counted. */
function call(tool: string, callId: string, args: string, images: number) {
  const base = {
    callId,
    pluginId: "genex",
    pluginName: "Genex Tools",
    tool,
    toolName: `genex__${tool}`,
    args,
    project: GAME,
    threadId: THREAD,
    engine: "claude-code",
    role: "chat",
    at: AT,
  };
  return [
    custom(CustomEvent.PluginToolStarted, base),
    custom(CustomEvent.PluginTool, { ...base, ok: true, result: "{}", images, durationMs: 2400 }),
  ];
}
const shoot = (callId: string) => call("cover", callId, "operation=shoot", 1);

/** A builder asked for a cover, at work: two candidates, a model, then the winner shot last. */
function coverWork(): EventEnvelope[] {
  return [
    turn(EventKind.TurnStarted, "cover"),
    said("user", "Make this game's Genex cover."),
    ...shoot("first"),
    ...shoot("second"),
    ...call("asset", "boat", "operation=model prompt=a red fishing boat", 1),
    ...shoot("kept"),
  ];
}
/** The same turn, ended with the builder's one line. */
function coverTurn(): EventEnvelope[] {
  return [
    ...coverWork(),
    said("assistant", "The cover is the harbour at sunset, the boat leaving the pier."),
    turn(EventKind.TurnEnded, "cover"),
  ];
}
/** The events each scenario's chat holds, and the shot Genex's storage keeps for the game. */
const SCENARIOS: Record<string, { events: () => EventEnvelope[]; shot: string | null }> = {
  kept: { events: coverTurn, shot: "kept" },
  /** The builder published in the turn: Genex took the kept frame, so the card offers no Publish. */
  published: {
    events: () => [
      ...coverWork(),
      ...call("publish", "publish", "kind=gallery", 0),
      ...call("publish-status", "live", "operation=status", 0),
      said("assistant", "The harbour at sunset is the cover, and the game is live."),
      turn(EventKind.TurnEnded, "cover"),
    ],
    shot: "kept",
  },
  /** The builder still at work after the winner: no card until the turn ends. */
  running: { events: () => [...coverWork(), ...call("cover", "check", "operation=status", 0)], shot: "kept" },
  /** A status check after the winner: the turn's work stays one group, the card after the reply. */
  checked: {
    events: () => [
      ...coverWork(),
      ...call("cover", "check", "operation=status", 0),
      said("assistant", "The cover is the harbour at sunset, the boat leaving the pier."),
      turn(EventKind.TurnEnded, "cover"),
    ],
    shot: "kept",
  },
  turns: {
    events: () => [
      ...coverTurn(),
      turn(EventKind.TurnStarted, "brighter"),
      said("user", "A bit brighter."),
      ...shoot("brighter"),
      said("assistant", "Brighter now: the same harbour an hour earlier."),
      turn(EventKind.TurnEnded, "brighter"),
    ],
    shot: "brighter",
  },
  /** Genex's storage no longer holds a shot for the game (a cleared plugin). */
  lost: { events: coverTurn, shot: null },
};

const genexPlugin = (over: Partial<PluginInfo> = {}) =>
  ({
    manifest,
    source: "bundled",
    enabled: true,
    removed: false,
    state: "enabled",
    health: "ready",
    ...over,
  }) as PluginInfo;
const live = { slug: GAME, status: "published", galleryUrl: `https://genex.games/${GAME}`, lastPublishAt: AT } as const;
const idle: GenexPublishState = { version: 1, project: GAME, connected: true, ...live };
const running: GenexPublishState = {
  ...idle,
  job: { id: "j1", kind: "gallery", state: "running", phase: "uploading", startedAt: AT },
};
const KEPT_SHA = "a".repeat(64);
/** The kept frame, which the publish re-shot and Genex took. */
const sentCover: GenexCoverRecord = {
  shot: {
    sha256: KEPT_SHA,
    width: 1920,
    height: 1080,
    mimeType: StillMimeType.Jpeg,
    bytes: 240_000,
    source: CaptureSource.Page,
    stats: { lumaMean: 0.42, lumaStdDev: 0.21, nearBlackFraction: 0.04, litFraction: 0.96 },
    takenAt: AT,
  },
  last: { kind: GenexCoverOutcome.Applied, at: AT, sha256: KEPT_SHA },
  sending: false,
};
const published: GenexPublishState = { ...idle, cover: sentCover };

let publishState: GenexPublishState = idle;
let keptShot: string | null = "kept";
const fake = fakeStudioApi();
fake.stub("pluginAction", async (_id, name) => (name === GenexAction.PublishStatus ? publishState : {}));
fake.stub("readProjectAsset", async (request: ProjectAssetRead) => {
  const shot = keptShot ? SHOTS[keptShot] : undefined;
  if (request.scope !== ProjectAssetScope.GenexCover || request.project !== GAME || !shot) return null;
  return { mimeType: "image/jpeg", data: request.maxPx ? shot.card : shot.whole };
});
let plugins: PluginInfo[] = [genexPlugin()];
fake.stub("pluginsList", async () => plugins);
window.studio = fake.api;

/** What the card asked the window for: setup requests by plugin id, and pictures opened beside the chat. */
const setups: string[] = [];
const opened: Array<{ kind: string; name: string; whole: boolean }> = [];
window.addEventListener(PLUGIN_SETUP_EVENT, (event) =>
  setups.push(String((event as globalThis.CustomEvent<{ id?: string }>).detail?.id)),
);
window.addEventListener(OPEN_BESIDE_EVENT, (event) => {
  const target = (event as globalThis.CustomEvent<BesideTarget>).detail;
  if (target.kind !== "image") return;
  const whole = Object.values(SHOTS).some((shot) => target.src.endsWith(shot.whole.slice(-40)));
  opened.push({ kind: target.kind, name: target.name, whole });
});

const props: ChatPanelProps = {
  events: [],
  stateEvents: [],
  history: { hasMore: false, paging: false, loadEarlier: async () => {} },
  engines: [],
  games: [],
  activeThread: {
    id: THREAD,
    agent_id: "studio",
    created_at: AT,
    updated_at: AT,
    latest_event_id: null,
    metadata: { kind: ThreadKind.Game, project: GAME },
  },
  status: "",
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

/** The game's chat on the left; on the right the stage with its strip, where Publish opens its dialog. */
function render(events: EventEnvelope[]) {
  flushSync(() =>
    root.render(
      <div style={{ display: "flex", width: "100%", height: "100%" }}>
        <div style={{ display: "flex", width: 520, height: "100%" }}>
          <ChatPanel {...props} events={events} stateEvents={events} />
        </div>
        {/* The chat's result button as a build card draws Play, out of view: what Publish is measured against. */}
        <div aria-hidden style={{ position: "absolute", left: -9999, top: 0 }}>
          <ResultButton data-reference-result-button tabIndex={-1}>
            <Icon name="play" size={12} className="fill-current" />
            Play
          </ResultButton>
        </div>
        <div style={{ flex: 1, background: "var(--inset)", padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <PluginToolbar plugins={plugins} project={GAME} emptyGame={false} onNotice={noop} onOpenChange={noop} />
          </div>
        </div>
      </div>,
    ),
  );
}

/** The shot a picture shows, by the scenario whose bytes it carries. */
const shotIn = (img: HTMLImageElement): string | null =>
  Object.keys(SHOTS).find((key) => img.src.endsWith(SHOTS[key]?.card.slice(-40) ?? "")) ?? null;

/** How a button is set: its height, its type and its glyph's size. */
function buttonType(button: HTMLElement | null) {
  if (!button) return null;
  const style = getComputedStyle(button);
  const glyph = button.querySelector("svg")?.getBoundingClientRect();
  return {
    height: Math.round(button.getBoundingClientRect().height),
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    glyph: glyph ? Math.round(glyph.width) : null,
  };
}

/** The chat's result button (Play on a build card), as the reference Publish is set against. */
const resultButtonType = () => buttonType(document.querySelector<HTMLElement>("[data-reference-result-button]"));

/** One card as a person meets it: its picture, caption and Publish, and where it sits. */
function cardView(card: HTMLElement) {
  const reply = [...document.querySelectorAll("[data-chat-scroll] p")].find((p) => p.textContent?.startsWith("The cover is"));
  const publish = card.querySelector<HTMLButtonElement>("[data-genex-cover-publish]");
  const img = card.querySelector("img");
  const box = img?.getBoundingClientRect();
  return {
    callId: card.dataset.genexCover,
    label: card.getAttribute("aria-label"),
    caption: card.querySelector("p")?.textContent ?? null,
    image: img
      ? {
          loaded: img.complete && img.naturalWidth > 0,
          shot: shotIn(img),
          alt: img.alt,
          ratio: box ? Math.round((box.width / box.height) * 100) / 100 : null,
          width: box ? Math.round(box.width) : null,
        }
      : null,
    publish: publish?.textContent?.trim() ?? null,
    publishLabel: publish?.getAttribute("aria-label") ?? null,
    publishType: buttonType(publish),
    resultButtonType: resultButtonType(),
    publishFill: publish ? getComputedStyle(publish).backgroundColor : null,
    cursors: [...card.querySelectorAll("button")].map((button) => getComputedStyle(button).cursor),
    afterReply: reply ? Boolean(card.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_PRECEDING) : null,
  };
}

/** What a person sees: each card, the work rows, the dialog, and what the card asked for. */
function sample() {
  return {
    cards: [...document.querySelectorAll<HTMLElement>("[data-genex-cover]")].map(cardView),
    work: [...document.querySelectorAll("[data-chat-scroll] button, [data-chat-scroll] summary")]
      .map((el) => el.textContent?.trim() ?? "")
      .filter((text) => /^Worked on/.test(text)),
    dialog: Boolean(document.querySelector('[data-testid="genex-publish"]')),
    setups: [...setups],
    opened: [...opened],
    reads: fake.callsOf("readProjectAsset").map(([request]) => request),
  };
}

/** The publish record a scenario's chat reads: a publish running, the kept frame sent, or idle. */
function recordFor(options: { publishing?: boolean; sent?: boolean }): GenexPublishState {
  if (options.publishing) return running;
  return options.sent ? published : idle;
}

/** Open a chat holding scenario `name`, Genex as `genex` says, a publish idle, running or done with the kept frame. */
async function open(name: string, options: { genex?: "on" | "off"; publishing?: boolean; sent?: boolean } = {}) {
  const scenario = SCENARIOS[name] ?? SCENARIOS.kept;
  publishState = recordFor(options);
  plugins = options.genex === "off" ? [genexPlugin({ enabled: false, state: "disabled" })] : [genexPlugin()];
  keptShot = scenario.shot;
  setups.length = 0;
  opened.length = 0;
  fake.calls.length = 0;
  sequence = 0;
  flushSync(() => root.render(null));
  await studio().plugins.refresh();
  render(scenario.events());
  for (let i = 0; i < 200; i++) {
    await frame();
    const images = [...document.querySelectorAll<HTMLImageElement>("[data-genex-cover] img")];
    if (images.length && images.every((img) => img.complete && img.naturalWidth > 0)) break;
    // No card to wait for: a chat with none, or one whose shot is gone.
    if (!document.querySelector("[data-genex-cover]") && i > 30) break;
  }
  await settle(20);
  return sample();
}

/** Press the card's Publish, as a person would, and let the strip open its dialog. */
async function press() {
  const button = document.querySelector<HTMLButtonElement>("[data-genex-cover-publish]");
  if (!button) throw new Error("No Publish on the cover card");
  button.click();
  for (let i = 0; i < 100 && !document.querySelector('[data-testid="genex-publish"]'); i++) await frame();
  await settle(20);
  return sample();
}

/** Press the card's picture, which opens the whole shot beside the chat. */
async function openPicture() {
  const picture = document.querySelector<HTMLButtonElement>("[data-genex-cover] button:not([data-genex-cover-publish])");
  if (!picture) throw new Error("No picture on the cover card");
  picture.click();
  for (let i = 0; i < 50 && opened.length === 0; i++) await frame();
  return sample();
}

/** Scroll the chat so the card sits in view for a capture. */
function reveal() {
  document.querySelector("[data-genex-cover]")?.scrollIntoView({ block: "center" });
}

/** The theme variables painted last, so a theme painted after them removes the ones it leaves out. */
let painted: ReadonlySet<string> = new Set();

/** Draw the page in the light or the dark theme, once the surfaces' colour transitions have ended. */
async function theme(name: "light" | "dark") {
  painted = paintAppearance(document.documentElement, DEFAULT_APPEARANCE, name, null, painted);
  await settle(30);
}

Object.assign(window, { coverCard: { open, press, openPicture, sample, reveal, theme } });
