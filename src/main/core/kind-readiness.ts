/**
 * The engine card's readiness of each kind on offer: for a game with no kind yet, each kind tool
 * that declares a `ready` harness tool is asked through it whether its kind can be made here now,
 * and with which words the card offers it (`PluginKindOffer.ready`, `note`). Genex never names a
 * plugin's tool for it: the manifest says which one answers. A plugin that doesn't answer in time,
 * or answers oddly, leaves its kind as listed.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import { type PluginBinding, type PluginKindOffer, PluginToolAudience } from "../../shared/plugins.ts";
import type { GameKind } from "../../shared/project-facts.ts";
import type { StudioCore } from "../studio-core.ts";

/** How long a kind's plugin may take to say whether its kind can be made here. */
export const READY_ASK_MS = 5 * SECOND_MS;
/** The most characters of a readiness note the card offers. */
const READY_NOTE_CHARS = 2_000;

/** The harness tool a kind tool names as its readiness (`tools[].ready`), by the kind's agent name; null when none. */
function readyToolOf(core: StudioCore, kind: PluginKindOffer): string | null {
  const [plugin, tool] = kind.tool.split("__");
  const manifest = core.plugins.list().find((info) => info.manifest.id === plugin)?.manifest;
  const ready = manifest?.tools.find((declared) => declared.name === tool)?.ready;
  return ready ? `${plugin}__${ready}` : null;
}

/** One answer within `READY_ASK_MS`, or null. */
async function askInTime(ask: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
  const stop = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      stop.abort();
      resolve(null);
    }, READY_ASK_MS);
  });
  try {
    return await Promise.race([ask(stop.signal).catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** One kind with its plugin's answer read: `ready` only as a boolean, `note` only as text. */
async function withReadiness(
  core: StudioCore,
  binding: PluginBinding,
  kind: PluginKindOffer,
): Promise<PluginKindOffer> {
  const name = readyToolOf(core, kind);
  if (!name) return kind;
  const answer = await askInTime((signal) =>
    core.plugins.tool(name, {}, binding, signal, PluginToolAudience.Harness, READY_ASK_MS),
  );
  const record = typeof answer === "object" && answer !== null ? (answer as Record<string, unknown>) : {};
  const note = typeof record.note === "string" ? record.note.trim().slice(0, READY_NOTE_CHARS) : "";
  return {
    ...kind,
    ...(typeof record.ready === "boolean" ? { ready: record.ready } : {}),
    ...(note ? { note } : {}),
  };
}

/**
 * The kinds on offer for a game, each with its readiness when the game has no kind yet (only then
 * does the card ask which kind it builds); a game with a kind gets them as listed.
 */
export async function kindsWithReadiness(
  core: StudioCore,
  project: string | null | undefined,
  game: GameKind,
  kinds: PluginKindOffer[],
): Promise<PluginKindOffer[]> {
  if (!project || kinds.length === 0 || game.facts.length > 0) return kinds;
  const binding = await core.pluginBinding(project).catch(() => undefined);
  if (!binding) return kinds;
  return Promise.all(kinds.map((kind) => withReadiness(core, binding, kind)));
}
