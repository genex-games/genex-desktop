/**
 * One chat's computer control, as the studio hands it out: the `desktop` tool over the core's
 * desktop registry, its consent asked on a card in that chat (the studio's own, never a plugin's),
 * and its frames drawn on an agent screen. Delegation (session engines) and `desktop.computer`
 * (the harness's own loop, for Ollama) both make it here, so every engine gets the same thing.
 */
import path from "node:path";
import { type AgentScreen, ScreenRole } from "../../shared/agent-screen.ts";
import { type PluginBinding, StudioConsentSource } from "../../shared/plugins.ts";
import { DESKTOP_TOOL_NAME } from "../../substrate/computer-tool.ts";
import type { DesktopApp } from "../../substrate/desktop-driver.ts";
import type { StudioCore, CoreInternals } from "../studio-core.ts";
import { targetFramePort } from "./computer-tools.ts";
import { safePathSegment } from "./run-shots.ts";
import { assistGrants, declaredEngineApps, declaredPlayerApps } from "./desktop-assist.ts";
import { engineAppRefusal } from "./desktop-target.ts";
import { DesktopQuestion, type DesktopTools } from "./desktop-tools.ts";

/** What the person reads on the consent card and the agent screen. */
const MESSAGE = {
  label: "your computer",
  session:
    "Let this chat's agent see your screen and use your computer during this session? Each app it reaches asks you first. Stop it any time with Stop, or Control-Option-Command-Escape (⌃⌥⌘Esc).",
  app: (app: string) => `Let this chat's agent use ${app}? It can click, type and read what ${app} shows.`,
} as const;

/** Who asks for computer control on the consent card: the studio itself, never a plugin. */
export const DESKTOP_CONSENT_SOURCE = StudioConsentSource.Desktop;

/** The consent card's tool: the `desktop` tool, asked about before it moves anything. */
const DESKTOP_CONSENT_TOOL = {
  name: DESKTOP_TOOL_NAME,
  description: "control of this computer",
  parameters: { type: "object" as const, properties: {} },
};

/** What the person is asked: computer control for the session, or one app. */
function consentPrompt(question: DesktopQuestion, app: DesktopApp | undefined): string {
  if (question === DesktopQuestion.App && app) return MESSAGE.app(app.name || app.bundleId || "this app");
  return MESSAGE.session;
}

/** Where a chat's computer control is asked about, and what stops a question waiting. */
export interface DesktopSessionPlace {
  binding: PluginBinding;
  /** The chat the consent card lands in, and the screen's identity. */
  threadId: string;
  /** The chat turn this session answers (its message's queue id): a setup assist's grant ends with it. */
  turn?: string;
  signal?: AbortSignal;
}

/** Whether the person turned computer control on (Settings → Permissions; off by default). */
export function computerControlOn(core: Pick<StudioCore, "settings">): boolean {
  return core.settings.computerControl;
}

/**
 * The `desktop` tool for one chat, where computer control is on and a desktop driver is installed;
 * null otherwise, without looking for the driver while it is off. Nothing moves before the person
 * answers its card in that chat — once for the session, then once per app — and turned off later,
 * every further call answers so.
 */
export async function desktopSessionTools(
  core: StudioCore,
  x: Pick<CoreInternals, "pluginTools" | "previews">,
  place: DesktopSessionPlace,
): Promise<DesktopTools | null> {
  const desktop = core.options.desktop;
  if (!desktop || !computerControlOn(core)) return null;
  if (!(await desktop.available())) return null;
  const screen: AgentScreen = {
    handle: `${DESKTOP_TOOL_NAME}:${place.threadId}`,
    label: MESSAGE.label,
    project: place.binding.project,
    runId: null,
    facetId: null,
    role: ScreenRole.Operator,
  };
  const ask = async (question: DesktopQuestion, app?: DesktopApp): Promise<boolean> => {
    const tool = { ...DESKTOP_CONSENT_TOOL, confirmation: consentPrompt(question, app) };
    const asked = app ? { app: app.name, bundleId: app.bundleId } : {};
    const answer = await x.pluginTools.requestConsent(DESKTOP_CONSENT_SOURCE, tool, asked, place.binding, place.signal);
    return answer.approved;
  };
  const grants = assistGrants(core);
  // An engine's editor is driven only by its plugin's setup assist, in the turn that answers it,
  // read afresh on every action.
  const engineApps = (app: DesktopApp) =>
    engineAppRefusal(app, {
      declared: declaredEngineApps(core.plugins.list()),
      players: declaredPlayerApps(core.plugins.list()),
      granted: grants.forTurn(place.threadId, place.turn)?.apps ?? null,
    });
  const tools = desktop.toolsFor({
    enabled: () => computerControlOn(core),
    engineApps,
    frameDir: path.join(core.layout.scratch, "desktop", safePathSegment(place.threadId)),
    ask,
    frame: async (shown, jpeg, caption, act) => {
      x.previews.openScreen(screen);
      await x.previews.frame(targetFramePort(shown), screen, jpeg, caption, act);
    },
  });
  const { turn } = place;
  if (!turn) return tools;
  return {
    ...tools,
    release: async () => {
      grants.turnEnded(place.threadId, turn);
      await tools.release();
    },
  };
}
