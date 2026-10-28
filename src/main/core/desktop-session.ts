/**
 * One chat's computer control, as the studio hands it out: the `desktop` tool over the core's
 * desktop registry, its consent asked on a card in that chat (the studio's own, never a plugin's),
 * and its frames drawn on an agent screen. Delegation (session engines) and `desktop.computer`
 * (the harness's own loop, for Ollama) both make it here, so every engine gets the same thing.
 */
import path from "node:path";
import { type AgentScreen, ScreenRole } from "../../shared/agent-screen.ts";
import { t } from "../../shared/i18n.ts";
import { type PluginBinding, StudioConsentSource } from "../../shared/plugins.ts";
import { DESKTOP_TOOL_NAME } from "../../substrate/computer-tool.ts";
import type { DesktopApp } from "../../substrate/desktop-driver.ts";
import type { StudioCore, CoreInternals } from "../studio-core.ts";
import { targetFramePort } from "./computer-tools.ts";
import { safePathSegment } from "./run-shots.ts";
import {
  assistGrants,
  assistOpensPages,
  assistPageRefusal,
  declaredEngineApps,
  declaredPlayerApps,
} from "./desktop-assist.ts";
import { engineAppRefusal } from "./desktop-target.ts";
import { DesktopQuestion, type DesktopTools } from "./desktop-tools.ts";

/**
 * What the person reads on the consent card (a short question, one line under it) and the agent
 * screen. The stop shortcut is never in it: Stop in the chat stops the agent.
 */
const MESSAGE = {
  label: () => t("your computer"),
  session: () => t("Let the agent see your screen in this chat?"),
  sessionNote: () => t("It asks before each app."),
  app: (app: string) => t("Let the agent use {app}?", { app }),
  unnamedApp: () => t("Let the agent use this app?"),
  appNote: () => t("It can click and type there."),
  /** The agent's words, never the person's: English. */
  noBrowser: "this computer opens no pages in the person's browser",
} as const;

/** Who asks for computer control on the consent card: the studio itself, never a plugin. */
export const DESKTOP_CONSENT_SOURCE = StudioConsentSource.Desktop;

/** The consent card's tool: the `desktop` tool, asked about before it moves anything. */
const DESKTOP_CONSENT_TOOL = {
  name: DESKTOP_TOOL_NAME,
  description: "control of this computer",
  parameters: { type: "object" as const, properties: {} },
};

/** What the person is asked, and the line under it: computer control for the session, or one app. */
function consentWords(question: DesktopQuestion, app: DesktopApp | undefined): { prompt: string; note: string } {
  if (question !== DesktopQuestion.App || !app) return { prompt: MESSAGE.session(), note: MESSAGE.sessionNote() };
  const name = app.name || app.bundleId;
  return { prompt: name ? MESSAGE.app(name) : MESSAGE.unnamedApp(), note: MESSAGE.appNote() };
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

/** A chat's yes to computer control: the session's, and each app's, with the stop count it was given at. */
interface ChatYes {
  stopsAll: number;
  session: boolean;
  apps: Set<string>;
}

/** Every chat's yes, per core: it lasts the chat's turns until the person stops it. */
const CHAT_YES = new WeakMap<object, Map<string, ChatYes>>();

function chatYesOf(core: object): Map<string, ChatYes> {
  const known = CHAT_YES.get(core);
  if (known) return known;
  const made = new Map<string, ChatYes>();
  CHAT_YES.set(core, made);
  return made;
}

/** How a chat's yes knows an app: its bundle id (or Windows exe), else its name. */
const appKey = (app: DesktopApp): string => app.bundleId ?? app.name;

/**
 * Chat `threadId`'s yes to computer control, read and kept across its turns: it holds while no stop
 * of every session came since it was given (`stopsAll`).
 */
function chatYes(core: object, threadId: string, stopsAll: () => number) {
  const yes = chatYesOf(core);
  const kept = (): ChatYes | null => {
    const held = yes.get(threadId);
    return held && held.stopsAll === stopsAll() ? held : null;
  };
  return {
    covers: (question: DesktopQuestion, app?: DesktopApp): boolean => {
      const held = kept();
      if (!held) return false;
      return question === DesktopQuestion.App && app ? held.apps.has(appKey(app)) : held.session;
    },
    keep: (question: DesktopQuestion, app?: DesktopApp): void => {
      const held = kept() ?? { stopsAll: stopsAll(), session: false, apps: new Set<string>() };
      if (question === DesktopQuestion.App && app) held.apps.add(appKey(app));
      else held.session = true;
      yes.set(threadId, held);
    },
  };
}

/**
 * The person stopped chat `threadId` (Stop): its yes to computer control ends, and its next turn
 * asks again. The stop shortcut and turning control off end every chat's (`stopsAll`).
 */
export function forgetChatComputerYes(core: object, threadId: string): void {
  chatYesOf(core).delete(threadId);
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
    label: MESSAGE.label(),
    project: place.binding.project,
    runId: null,
    facetId: null,
    role: ScreenRole.Operator,
  };
  const grants = assistGrants(core);
  const yes = chatYes(core, place.threadId, () => desktop.stopsAll());
  const ask = async (question: DesktopQuestion, app?: DesktopApp): Promise<boolean> => {
    if (yes.covers(question, app)) return true;
    // The person's press (or the card they approved) for this turn's assist already said yes to the
    // session and the grant's apps; any other app (their browser, for the game's page) is asked.
    const grant = grants.forTurn(place.threadId, place.turn);
    const covered = !app || (app.bundleId !== null && grant?.apps.has(app.bundleId) === true);
    if (grant?.asked && covered) return true;
    const { prompt, note } = consentWords(question, app);
    const tool = { ...DESKTOP_CONSENT_TOOL, confirmation: prompt };
    const asked = app ? { app: app.name, bundleId: app.bundleId } : {};
    const answer = await x.pluginTools.requestConsent(
      DESKTOP_CONSENT_SOURCE,
      tool,
      asked,
      place.binding,
      place.signal,
      undefined,
      { note },
    );
    if (answer.approved) yes.keep(question, app);
    return answer.approved;
  };
  // An engine's editor is driven only by its plugin's setup assist, in the turn that answers it,
  // read afresh on every action.
  const engineApps = (app: DesktopApp) => {
    const grant = grants.forTurn(place.threadId, place.turn);
    return engineAppRefusal(app, {
      declared: declaredEngineApps(core.plugins.list()),
      players: declaredPlayerApps(core.plugins.list()),
      granted: grant?.apps ?? null,
      others: grant ? assistOpensPages(grant, core.plugins.list()) : false,
    });
  };
  // The turn answering an assist the person pressed starts with the plugin's app in front, where the
  // task's clicks go, and gets it back when it reopens behind Genex: nothing else it may click (the
  // Dock, Stage Manager, a PC's taskbar) could bring it there.
  const keepInFront = () => {
    const grant = grants.forTurn(place.threadId, place.turn);
    const [app] = grant?.asked ? grant.apps : [];
    return app ?? null;
  };
  // A page of the task this turn answers, on a host its engine declares: the grant's own, never any other.
  const openPage = async (address: URL): Promise<string | null> => {
    const refusal = assistPageRefusal(address, grants.forTurn(place.threadId, place.turn), core.plugins.list());
    if (refusal) return refusal;
    return (await desktop.openPage(address.href)) ? null : MESSAGE.noBrowser;
  };
  const tools = desktop.toolsFor({
    enabled: () => computerControlOn(core),
    keepInFront,
    openPage,
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
