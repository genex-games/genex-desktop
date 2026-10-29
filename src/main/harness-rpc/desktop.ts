/**
 * Harness RPC: the person's computer for the harness's own tool loop (Ollama), the same `desktop`
 * tool session engines are handed (`core/desktop-session.ts`). One session per chat, started afresh
 * on each describe — a turn's tool registry asks once — and asked about on that chat's card. While
 * computer control is off in Settings, every call answers so, and no session or driver starts.
 */
import { HostMethod, type HarnessHostHandlers } from "../../shared/harness-api.ts";
import { DESKTOP_TOOL_NAME } from "../../substrate/computer-tool.ts";
import { computerControlOn, type DesktopSessionPlace, desktopSessionTools } from "../core/desktop-session.ts";
import { DESKTOP_OFF_ANSWER, type DesktopTools } from "../core/desktop-tools.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";

/** Why there is no computer for this call. */
const MESSAGE = {
  noChat: "computer control is asked about in a chat, and this call names none",
  noProject: "open a project first",
  noDriver: "computer control is not available in this build: no cua-driver is bundled or installed",
} as const;

/** One registry of chat sessions per core: the harness's calls outlive any one `api()` table. */
const SESSIONS = new WeakMap<CoreInternals, Map<string, Promise<DesktopTools | null>>>();

function sessionsOf(x: CoreInternals): Map<string, Promise<DesktopTools | null>> {
  const known = SESSIONS.get(x);
  if (known) return known;
  const made = new Map<string, Promise<DesktopTools | null>>();
  SESSIONS.set(x, made);
  return made;
}

/** The chat's session, made on first use and afresh on a describe (which releases the one before). */
async function chatSession(
  core: StudioCore,
  x: CoreInternals,
  place: DesktopSessionPlace,
  describe: boolean,
): Promise<DesktopTools | null> {
  const sessions = sessionsOf(x);
  const key = JSON.stringify([place.binding.project, place.threadId]);
  if (describe) {
    const before = sessions.get(key);
    sessions.delete(key);
    await (await before?.catch(() => null))?.release();
  }
  let made = sessions.get(key);
  if (!made) {
    made = desktopSessionTools(core, x, place);
    sessions.set(key, made);
  }
  const tools = await made;
  if (!tools) sessions.delete(key);
  return tools;
}

/**
 * Stop every `desktop.computer` session: the harness that asked for them has ended, so their
 * drivers close, the computer is let go, and the next harness's first call asks the person again.
 */
export async function releaseHarnessDesktops(x: CoreInternals): Promise<void> {
  const sessions = SESSIONS.get(x);
  if (!sessions) return;
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(all.map(async (made) => (await made.catch(() => null))?.release().catch(() => {})));
}

/** The `desktop.computer` host method: the chat's desktop session for the harness's own tool loop. */
export function desktopRpc(core: StudioCore, x: CoreInternals) {
  return {
    [HostMethod.DesktopComputer]: async (p) => {
      if (!computerControlOn(core)) return { unavailable: DESKTOP_OFF_ANSWER };
      if (!p.threadId) return { unavailable: MESSAGE.noChat };
      const threadId = p.threadId;
      const binding = await core.pluginBinding(p.project, threadId);
      if (!binding) return { unavailable: MESSAGE.noProject };
      const tools = await chatSession(core, x, { binding, threadId }, p.describe === true);
      if (!tools) return { unavailable: computerControlOn(core) ? MESSAGE.noDriver : DESKTOP_OFF_ANSWER };
      const [tool] = tools.liveTools;
      if (p.describe && tool) return { tool };
      return { answer: await tools.onLiveTool(DESKTOP_TOOL_NAME, p.args ?? {}) };
    },
  } satisfies Partial<HarnessHostHandlers>;
}
