/**
 * Test-owned production Publish dialog beside the production ChatPanel of the same game: with no
 * cover the dialog asks the plugin to take one, the banner's arrows make a recent frame the kept
 * one, Another cover sends its ask through that game's chat and the banner says a new one is
 * coming until it arrives, and a kept clip plays behind the Picture / Clip switch. The pictures
 * and the clip are drawn here, on a canvas: nothing comes from a real game.
 */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useEffect, useState } from "react";
import manifest from "../../src/plugins/genex/plugin.json" with { type: "json" };
import { ChatPanel } from "../../src/renderer/panels/ChatPanel.tsx";
import { GenexPublishDialog } from "../../src/renderer/panels/plugins/genex/GenexPublish.tsx";
import type { ChatPanelProps } from "../../src/renderer/chat/chat-panel-props.ts";
import { ThreadKind } from "../../src/shared/event-log.ts";
import { ProjectAssetScope, type ProjectAssetRead } from "../../src/shared/game-assets.ts";
import {
  GenexAction,
  type GenexCoverClip,
  GenexCoverOutcome,
  type GenexCoverShot,
  type GenexPublishState,
} from "../../src/shared/genex.ts";
import type { PluginInfo } from "../../src/shared/plugins.ts";
import { CaptureSource, StillMimeType } from "../../src/shared/preview-contract.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const GAME = "cover-game";
const AT = "2026-10-16T10:00:00.000Z";
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing fixture root");
const root = createRoot(rootElement);
const noop = () => {};
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function settle(frames = 10) {
  for (let i = 0; i < frames; i++) await frame();
}

/** Three synthetic frames of one icy world, each lit and framed its own way. */
const LOOKS = [
  { sha: "a", sky: ["#0d2340", "#3d7fb0"], ground: "#dfe9f3", sun: [0.72, 0.28] },
  { sha: "b", sky: ["#241238", "#c0617a"], ground: "#f1dfe6", sun: [0.3, 0.35] },
  { sha: "c", sky: ["#0b1d1a", "#4fa38d"], ground: "#e2f2ec", sun: [0.55, 0.2] },
] as const;

function paint(ctx: CanvasRenderingContext2D, look: (typeof LOOKS)[number], t = 0) {
  const { width: w, height: h } = ctx.canvas;
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, look.sky[0]);
  sky.addColorStop(1, look.sky[1]);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.beginPath();
  ctx.arc(look.sun[0] * w, look.sun[1] * h, h * 0.07, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = look.ground;
  ctx.beginPath();
  ctx.moveTo(0, h * 0.7);
  for (let x = 0; x <= w; x += w / 12) ctx.lineTo(x, h * (0.68 + 0.04 * Math.sin(x / 90 + t)));
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.fill();
  ctx.fillStyle = "#f8fbff";
  ctx.beginPath();
  ctx.arc(w * (0.4 + 0.1 * Math.sin(t)), h * 0.66, h * 0.11, 0, Math.PI * 2);
  ctx.fill();
}

function picture(look: (typeof LOOKS)[number]): string {
  const canvas = document.createElement("canvas");
  canvas.width = 960;
  canvas.height = 540;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2d context");
  paint(ctx, look);
  return canvas.toDataURL("image/jpeg", 0.9).split(",")[1] ?? "";
}

/** A two-second WebM of the first look, the ball rolling, recorded from a canvas. */
async function recordClip(): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = 960;
  canvas.height = 540;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2d context");
  const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: "video/webm" });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  recorder.start();
  const start = performance.now();
  while (performance.now() - start < 2000) {
    paint(ctx, LOOKS[0], (performance.now() - start) / 300);
    await frame();
  }
  recorder.stop();
  await stopped;
  const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

const shotOf = (sha: string): GenexCoverShot => ({
  sha256: sha.repeat(64),
  width: 1920,
  height: 1080,
  mimeType: StillMimeType.Jpeg,
  bytes: 1024,
  source: CaptureSource.Page,
  stats: { lumaMean: 0.4, lumaStdDev: 0.2, nearBlackFraction: 0.1, litFraction: 0.9 },
  takenAt: AT,
});
const clipRecord: GenexCoverClip = {
  sha256: "d".repeat(64),
  mimeType: "video/webm",
  bytes: 1024,
  width: 960,
  height: 540,
  durationMs: 5000,
  motion: 0.6,
  takenAt: AT,
};
const base: GenexPublishState = { version: 1, project: GAME, connected: true };

/** What the fake plugin keeps: the kept frame, the recent ones, and a clip. */
const plugin = {
  kept: null as string | null,
  candidates: [] as string[],
  clip: false,
  owner: false,
  actions: [] as Array<{ name: string; args: unknown }>,
};
function record(): GenexPublishState {
  return {
    ...base,
    cover: {
      shot: plugin.kept ? shotOf(plugin.kept) : null,
      last: plugin.owner ? { kind: GenexCoverOutcome.KeptOwner, at: AT, coverSource: "owner" } : null,
      sending: false,
      candidates: plugin.candidates.map(shotOf),
      clip: plugin.clip ? clipRecord : null,
    },
  };
}

const pictures = new Map<string, string>();
let clipData = "";
const fake = fakeStudioApi();
fake.stub("pluginAction", async (_id, name, args) => {
  plugin.actions.push({ name, args });
  if (name === GenexAction.CoverAuto) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    plugin.kept = "a";
    plugin.candidates = ["a"];
  }
  if (name === GenexAction.CoverPick) plugin.kept = String((args as { sha256: string }).sha256)[0] ?? null;
  return name === GenexAction.PublishStatus || name.startsWith("cover") ? record() : {};
});
fake.stub("readProjectAsset", async (read: ProjectAssetRead) => {
  if (read.scope === ProjectAssetScope.GenexCoverClip)
    return plugin.clip ? { mimeType: "video/webm", data: clipData } : null;
  if (read.scope !== ProjectAssetScope.GenexCover || !plugin.kept) return null;
  return { mimeType: "image/jpeg", data: pictures.get(plugin.kept) ?? "" };
});
window.studio = fake.api;
const genex = { manifest, source: "bundled", enabled: true, removed: false, state: "enabled" } as unknown as PluginInfo;

const sends: string[] = [];
const props: ChatPanelProps = {
  events: [],
  stateEvents: [],
  history: { hasMore: false, paging: false, loadEarlier: async () => {} },
  engines: [],
  games: [],
  activeThread: {
    id: `${GAME}-thread`,
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
  onSend: async (text) => {
    sends.push(text);
  },
};

function Stage({ open }: { open: boolean }) {
  const [shown, setShown] = useState(open);
  useEffect(() => setShown(open), [open]);
  return (
    <div style={{ display: "flex", width: "100%", height: "100%" }}>
      <div style={{ display: "flex", width: 460, height: "100%" }}>
        <ChatPanel {...props} />
      </div>
      <div style={{ flex: 1, background: "var(--inset)" }} />
      {shown ? <GenexPublishDialog plugin={genex} project={GAME} onClose={() => setShown(false)} /> : null}
    </div>
  );
}

const q = <T extends Element>(selector: string) => document.querySelector<T>(selector);
/** What a person sees on the banner. */
function sample() {
  const banner = q<HTMLElement>(".genex-publish-banner");
  return {
    dialog: Boolean(q('[data-testid="genex-publish"]')),
    shot: banner?.hasAttribute("data-shot") ?? false,
    busy: q("[data-genex-cover-busy]")?.textContent?.trim() ?? null,
    another: q("[data-genex-another-cover]")?.getAttribute("data-genex-another-cover") ?? null,
    arrows: document.querySelectorAll(".genex-publish-arrow").length,
    dots: q(".genex-publish-pips")?.getAttribute("aria-label") ?? null,
    field: Boolean(q("[data-genex-cover-ask]")),
    hint: q(".genex-publish-hint")?.textContent?.trim() ?? null,
    show: q(".genex-publish-show")
      ? [...document.querySelectorAll(".genex-publish-show-option")].map((b) => b.getAttribute("aria-pressed"))
      : null,
    playing: (() => {
      const v = q<HTMLVideoElement>(".genex-publish-clip");
      return v ? !v.paused : null;
    })(),
    actions: plugin.actions.map((a) => a.name).filter((n) => n !== GenexAction.PublishStatus),
    sends: [...sends],
    prompt: q<HTMLTextAreaElement>('[data-promptbar] textarea[aria-label="Prompt"]')?.value ?? null,
  };
}

async function until(check: () => boolean, frames = 200) {
  for (let i = 0; i < frames && !check(); i++) await frame();
}

/** Open the dialog with the fake plugin holding `kept` among `candidates`, and a clip or not. */
async function open(state: { kept?: string | null; candidates?: string[]; clip?: boolean; owner?: boolean } = {}) {
  if (!pictures.size) for (const look of LOOKS) pictures.set(look.sha, picture(look));
  if (state.clip && !clipData) clipData = await recordClip();
  Object.assign(plugin, { kept: null, candidates: [], clip: false, owner: false, actions: [] }, state);
  sends.length = 0;
  flushSync(() => root.render(null));
  flushSync(() => root.render(<Stage open />));
  await until(() => Boolean(q("[data-genex-publish-status]")));
  await settle(20);
  return sample();
}

/** Wait for the banner to show a kept frame. */
async function untilShot() {
  await until(() => Boolean(q(".genex-publish-banner[data-shot]")), 900);
  await settle(10);
  return sample();
}

async function press(selector: string) {
  const button = q<HTMLButtonElement>(selector);
  if (!button) throw new Error(`Nothing to press at ${selector}`);
  button.click();
  await settle(20);
  return sample();
}

/** Type what the new cover should show and press Make. */
async function make(want: string) {
  const input = q<HTMLInputElement>("[data-genex-cover-ask] input");
  if (!input) throw new Error("No field");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, want);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle(2);
  return press("[data-genex-cover-ask] button[type=submit]");
}

/** A new frame arrives, as the agent's shoot would leave it. */
async function arrive(sha: string) {
  plugin.kept = sha;
  plugin.candidates = [sha, ...plugin.candidates.filter((c) => c !== sha)];
  // The dialog reads the record on its own cadence: the wait ends once it has.
  await until(() => !q("[data-genex-cover-busy]"), 900);
  await settle(10);
  return sample();
}

/** Press the banner's next-cover arrow. */
const next = () => press('[aria-label="Next cover"]');

Object.assign(window, { publishCover: { open, untilShot, press, next, make, arrive, sample, settle } });
