/**
 * Test-owned production MorningCard, Resume line and first-launch welcome: the stable hooks an
 * unattended operator presses through dev control (`data-run-resume`, `data-onboarding-action`),
 * next to the words, labels and classes that stay as they were.
 */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ReactNode } from "react";
import { MorningCard } from "../../src/renderer/panels/MorningCard.tsx";
import { TranscriptEntry, type TranscriptContext } from "../../src/renderer/chat/TranscriptEntry.tsx";
import { EntryAction, EntryKind } from "../../src/renderer/chat-entries.ts";
import { Onboarding } from "../../src/renderer/onboarding/Onboarding.tsx";
import { EngineStatusCode } from "../../src/shared/engine-descriptor.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing fixture root");
const root = createRoot(rootElement);
const fake = fakeStudioApi({ resumeAutopilot: async () => true });
window.studio = fake.api;
const noop = () => {};
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function settle(frames = 10) {
  for (let i = 0; i < frames; i++) await frame();
}
function render(node: ReactNode) {
  flushSync(() => root.render(null));
  flushSync(() => root.render(node));
}
/** Every element a selector matches: its text, title, aria-label, classes and hook value. */
function found(selector: string, hook: string) {
  return [...document.querySelectorAll<HTMLElement>(selector)].map((element) => ({
    tag: element.tagName,
    text: element.textContent?.trim() ?? "",
    title: element.getAttribute("title"),
    label: element.getAttribute("aria-label"),
    className: element.className,
    value: element.getAttribute(hook),
    inFoot: Boolean(element.closest(".onboarding-foot")),
  }));
}
const resumes = () => found("[data-run-resume]", "data-run-resume");
const actions = () => found("[data-onboarding-action]", "data-onboarding-action");
const buttonText = (text: string) =>
  [...document.querySelectorAll("button")].filter((button) => button.textContent?.trim() === text).length;

async function morningCard() {
  let resumed = 0;
  const card = (paused: boolean, runId: string | null = "run_paused") => (
    <MorningCard
      runId={runId}
      rounds={3}
      kept={1}
      undone={2}
      landed={false}
      paused={paused}
      stoppedBecause="Claude's session limit"
      summary={null}
      project="racer"
      commit={null}
      before={null}
      after={null}
      onResume={() => resumed++}
    />
  );
  render(card(true));
  await settle();
  const paused = resumes();
  document.querySelector<HTMLElement>('[data-run-resume="run_paused"]')?.click();
  await settle(2);
  const clicks = resumed;
  render(card(false));
  await settle();
  const finished = { hooks: resumes(), resumeButtons: buttonText("Resume") };
  render(card(true, null));
  await settle();
  const unnamed = { hooks: resumes(), resumeButtons: buttonText("Resume") };
  return { paused, clicks, finished: finished.hooks, resumeButtons: finished.resumeButtons, unnamed };
}

async function resumeLine() {
  const context: TranscriptContext = {
    activeRunId: null,
    pausedRunId: "run_line",
    project: "racer",
    threadId: "t-racer",
    images: new Map(),
    onNotice: noop,
    onApprovePlan: async () => {},
    onRevisePlan: noop,
  };
  const entry = {
    kind: EntryKind.Action,
    id: "e-paused",
    tag: "STOPPED",
    text: "The build stopped.",
    action: EntryAction.Resume,
    runId: "run_line",
  } as const;
  render(<TranscriptEntry entry={entry} context={context} />);
  await settle();
  const offered = resumes();
  document.querySelector<HTMLElement>('[data-run-resume="run_line"]')?.click();
  await settle(2);
  const calls = fake.callsOf("resumeAutopilot");
  render(<TranscriptEntry entry={entry} context={{ ...context, activeRunId: "run_other" }} />);
  await settle();
  return { offered, calls, whileRunning: resumes() };
}

/** Claude Code as the Connect screen reads it: signed in, or waiting for a sign-in. */
function claude(ready: boolean) {
  return {
    id: EngineId.ClaudeCode,
    label: "Claude Code",
    kind: "cli",
    models: [],
    status: { code: ready ? EngineStatusCode.Ready : EngineStatusCode.NeedsLogin, detail: "" },
    account: { source: "none", afterSignOut: "signed-out", cli: { state: "ready" } },
  } as never;
}

async function welcome(ready: boolean) {
  render(<Onboarding engines={[claude(ready)]} onEnginesRefresh={noop} onReady={async () => {}} onFinish={noop} />);
  await settle();
  const first = actions();
  document.querySelector<HTMLElement>('[data-onboarding-action="next"]')?.click();
  await settle(30);
  return { first, connect: actions(), startButtons: buttonText("Start building"), skipButtons: buttonText("Skip for now") };
}

async function runOperatorHookChecks() {
  const morning = await morningCard();
  const line = await resumeLine();
  const signedOut = await welcome(false);
  const signedIn = await welcome(true);
  render(null);
  return { morning, line, signedOut, signedIn };
}

Object.assign(window, { runOperatorHookChecks });
