/**
 * Test-owned production ChatPanel whose saved model cannot take a message: its provider is listed
 * but not ready, and needs no sign-in. Send must say so at the model, keep the prompt and send nothing.
 */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ChatPanel } from "../../src/renderer/panels/ChatPanel.tsx";
import type { ChatPanelProps } from "../../src/renderer/chat/chat-panel-props.ts";
import { EngineKind, EngineStatusCode, type EngineDescriptor } from "../../src/shared/engine-descriptor.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { ThreadKind } from "../../src/shared/event-log.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing fixture root");
const root = createRoot(rootElement);
const noop = () => {};
const date = "2026-11-07T00:00:00.000Z";
const model = (id: string, label: string) => ({ id, label, contextWindow: 200_000, supportsTools: true, supportsVision: true });
const engines: EngineDescriptor[] = [
  {
    id: EngineId.ClaudeCode,
    label: "Claude Code",
    kind: EngineKind.Delegated,
    defaultModel: null,
    status: { code: EngineStatusCode.Ready, detail: "Fixture ready" },
    models: [model("fixture-opus", "Opus fixture")],
  },
  {
    // The saved pick's provider: listed, but it does not answer right now.
    id: EngineId.OpenCode,
    label: "OpenCode",
    kind: EngineKind.Delegated,
    defaultModel: null,
    status: { code: EngineStatusCode.Error, detail: "Fixture provider is down" },
    models: [model("fixture-big-pickle", "Big Pickle fixture")],
  },
];
const fake = fakeStudioApi();
window.studio = fake.api;
const sent: string[] = [];
const props: ChatPanelProps = {
  events: [],
  stateEvents: [],
  history: { hasMore: false, paging: false, loadEarlier: async () => {} },
  engines,
  games: [],
  activeThread: {
    id: "unavailable-thread",
    agent_id: "studio",
    created_at: date,
    updated_at: date,
    latest_event_id: null,
    metadata: {
      kind: ThreadKind.Game,
      project: "unavailable-game",
      lastEngine: EngineId.OpenCode,
      lastModel: "fixture-big-pickle",
    },
  },
  status: "idle",
  busySince: null,
  loading: false,
  sidebarHidden: false,
  onRetryLoad: noop,
  onToggleSidebar: noop,
  onEnginesRefresh: noop,
  onRename: noop,
  onNotice: noop,
  onSend: async (text) => {
    sent.push(text);
  },
};

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const frames = async (count: number) => {
  for (let i = 0; i < count; i++) await frame();
};
const query = <T extends Element>(selector: string) => document.querySelector<T>(selector);

/** Types into the prompt as React hears typing. */
function type(text: string): void {
  const input = query<HTMLTextAreaElement>("[data-promptbar] textarea");
  if (!input) throw new Error("Missing prompt");
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setValue?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** What the composer shows: the draft, Send's state, the model button and the tooltip that is up. */
function sample() {
  const chip = query<HTMLButtonElement>('[data-promptbar] [aria-label="Model settings"]');
  return {
    draft: query<HTMLTextAreaElement>("[data-promptbar] textarea")?.value ?? null,
    send: query<HTMLButtonElement>('[data-promptbar] [aria-label="Send"]')?.dataset.state ?? null,
    model: chip?.textContent ?? null,
    nudge: chip?.dataset.nudge ?? null,
    tip: [...document.querySelectorAll("[data-slot=tooltip-content]")].map((tip) => tip.textContent ?? "").join(" | "),
    status: [...document.querySelectorAll('[data-promptbar] [role="status"]')].map((s) => s.textContent).join(" "),
    sent: [...sent],
  };
}

/** Send on the unavailable model: what the composer shows before and right after. */
async function sendOnUnavailable() {
  flushSync(() => root.render(<ChatPanel {...props} />));
  await frames(20);
  type("Make the fox jump higher");
  await frames(4);
  const typed = sample();
  query<HTMLButtonElement>('[data-promptbar] [aria-label="Send"]')?.click();
  await frames(12);
  return { typed, blocked: sample() };
}

/** Pick a model that runs, then send the kept prompt. */
async function sendAfterPick() {
  query<HTMLButtonElement>('[data-promptbar] [aria-label="Model settings"]')?.click();
  await frames(12);
  // With roles the button opens the jobs first; the main agent's row opens its model list.
  query<HTMLButtonElement>('[data-role="planner"]')?.click();
  await frames(12);
  const row = [...document.querySelectorAll<HTMLButtonElement>("[data-list-row]")].find((button) =>
    button.textContent?.includes("Opus fixture"),
  );
  row?.click();
  await frames(12);
  const picked = sample();
  query<HTMLButtonElement>('[data-promptbar] [aria-label="Send"]')?.click();
  await frames(12);
  return { picked, after: sample() };
}
Object.assign(window, { sendOnUnavailable, sendAfterPick });
