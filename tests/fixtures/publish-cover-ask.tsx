/**
 * Test-owned production Publish dialog beside the production ChatPanel of the same game: the
 * dialog asks for a Genex cover only while the plugin reports none to send, and its press closes
 * the dialog and leaves the ask in that game's composer, unsent.
 */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useEffect, useState } from "react";
import manifest from "../../src/plugins/genex/plugin.json" with { type: "json" };
import { ChatPanel } from "../../src/renderer/panels/ChatPanel.tsx";
import { GenexPublishDialog } from "../../src/renderer/panels/plugins/genex/GenexPublish.tsx";
import type { ChatPanelProps } from "../../src/renderer/chat/chat-panel-props.ts";
import { ThreadKind } from "../../src/shared/event-log.ts";
import { GenexAction, GenexCoverOutcome, type GenexPublishState } from "../../src/shared/genex.ts";
import type { PluginInfo } from "../../src/shared/plugins.ts";
import { CaptureSource, StillMimeType } from "../../src/shared/preview-contract.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const GAME = "cover-game";
const AT = "2026-10-09T10:00:00.000Z";
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing fixture root");
const root = createRoot(rootElement);
const noop = () => {};
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function settle(frames = 10) {
  for (let i = 0; i < frames; i++) await frame();
}

const shot = {
  sha256: "a".repeat(64),
  width: 1920,
  height: 1080,
  mimeType: StillMimeType.Png,
  bytes: 1024,
  source: CaptureSource.Page,
  stats: { lumaMean: 0.4, lumaStdDev: 0.2, nearBlackFraction: 0.1, litFraction: 0.9 },
  takenAt: AT,
};
const base: GenexPublishState = { version: 1, project: GAME, connected: true };
const live = { slug: GAME, status: "published", galleryUrl: `https://genex.games/${GAME}`, lastPublishAt: AT } as const;
/** The publish records the plugin answers, by scenario. */
const SCENARIOS: Record<string, GenexPublishState> = {
  none: { ...base, cover: { shot: null, last: null, sending: false } },
  noneSent: { ...base, ...live, cover: { shot: null, last: { kind: GenexCoverOutcome.None, at: AT }, sending: false } },
  shot: { ...base, cover: { shot, last: null, sending: false } },
  sending: { ...base, ...live, cover: { shot: null, last: null, sending: true } },
  /** As the plugin records it when Genex says the owner chose the cover and Studio kept no shot. */
  owner: {
    ...base,
    ...live,
    cover: {
      shot: null,
      last: {
        kind: GenexCoverOutcome.KeptOwner,
        at: AT,
        coverUrl: `https://cdn.genex.games/covers/${GAME}.webp`,
        coverSource: "owner",
      },
      sending: false,
    },
  },
  older: { ...base, ...live },
};

let scenario: GenexPublishState = SCENARIOS.none;
const fake = fakeStudioApi();
fake.stub("pluginAction", async (_id, name) => (name === GenexAction.PublishStatus ? scenario : {}));
window.studio = fake.api;
const genex = { manifest, source: "bundled", enabled: true, removed: false, state: "enabled" } as unknown as PluginInfo;

const sends: string[] = [];
let closes = 0;
const props: ChatPanelProps = {
  events: [],
  stateEvents: [],
  history: { hasMore: false, paging: false, loadEarlier: async () => {} },
  engines: [],
  games: [],
  activeThread: null,
  status: "",
  busySince: null,
  loading: false,
  sidebarHidden: false,
  onRetryLoad: noop,
  onToggleSidebar: noop,
  onEnginesRefresh: noop,
  onRename: noop,
  onNotice: noop,
  onSend: async (text) => {
    sends.push(text);
  },
};
const thread = (project: string) => ({
  id: `${project}-thread`,
  agent_id: "studio",
  created_at: AT,
  updated_at: AT,
  latest_event_id: null,
  metadata: { kind: ThreadKind.Game, project },
});

/** The game's chat, and over the stage the Publish dialog while it is open, closed as the stage strip closes it. */
function Stage({ chatGame, dialogGame }: { chatGame: string; dialogGame: string | null }) {
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => setOpen(dialogGame), [dialogGame]);
  return (
    <div style={{ display: "flex", width: "100%", height: "100%" }}>
      <div style={{ display: "flex", width: 460, height: "100%" }}>
        <ChatPanel {...props} activeThread={thread(chatGame)} />
      </div>
      <div style={{ flex: 1, background: "var(--inset)" }} />
      {open ? (
        <GenexPublishDialog
          plugin={genex}
          project={open}
          onClose={() => {
            closes++;
            setOpen(null);
          }}
        />
      ) : null}
    </div>
  );
}
function render(chatGame: string, dialogGame: string | null) {
  flushSync(() => root.render(<Stage chatGame={chatGame} dialogGame={dialogGame} />));
}

const prompt = () => document.querySelector<HTMLTextAreaElement>('[data-promptbar] textarea[aria-label="Prompt"]');

/** Type into the chat's prompt as a person would, through React's own input event. */
function typeDraft(text: string) {
  const input = prompt();
  if (!input) throw new Error("Missing prompt");
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** What a person sees: the dialog, its cover ask, and the chat's prompt. */
function sample() {
  const ask = document.querySelector<HTMLElement>("[data-genex-cover-ask]");
  const button = ask?.querySelector<HTMLButtonElement>("button") ?? null;
  return {
    dialog: Boolean(document.querySelector('[data-testid="genex-publish"]')),
    stage: document.querySelector("[data-genex-publish-status]")?.getAttribute("data-genex-publish-status") ?? null,
    ask: Boolean(ask),
    askText: ask?.textContent?.trim() ?? null,
    askLabel: button?.getAttribute("aria-label") ?? null,
    askButton: button?.textContent?.trim() ?? null,
    prompt: prompt()?.value ?? null,
    promptFocused: document.activeElement === prompt(),
    closes,
    sends: [...sends],
  };
}

/** The game whose chat is open beside the dialog. */
let chatGame = GAME;

/** Show the dialog over the open chat and wait for the plugin's record in it. */
async function showDialog() {
  render(chatGame, GAME);
  for (let i = 0; i < 100 && !document.querySelector("[data-genex-publish-status]"); i++) await frame();
  await settle();
  return sample();
}

/** Open the dialog over a fresh chat of `chatGame` with the plugin answering `name`, a draft typed first. */
async function open(name: string, options: { draft?: string; chatGame?: string } = {}) {
  scenario = SCENARIOS[name] ?? SCENARIOS.none;
  closes = 0;
  chatGame = options.chatGame ?? GAME;
  flushSync(() => root.render(null));
  render(chatGame, null);
  await settle();
  if (options.draft) typeDraft(options.draft);
  await settle(2);
  return showDialog();
}

/** Open the dialog again over the same chat, its draft as the person left it. */
async function reopen() {
  closes = 0;
  render(chatGame, null);
  await settle(2);
  return showDialog();
}

/** Press the dialog's cover ask, as a person would, and let the dialog go. */
async function press() {
  const button = document.querySelector<HTMLButtonElement>("[data-genex-cover-ask] button");
  if (!button) throw new Error("No cover ask to press");
  button.click();
  await settle(20);
  return sample();
}

Object.assign(window, { coverAsk: { open, reopen, press, sample } });
