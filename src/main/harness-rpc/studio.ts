/** Harness RPC: what a session reads about the studio itself — its context, language, context policy and learning switch. */
import { HostMethod, type HarnessHostHandlers } from "../../shared/harness-api.ts";
import { currentLocale } from "../../shared/i18n.ts";
import { LOCALE_NAMES } from "../../shared/locale.ts";
import type { StudioCore } from "../studio-core.ts";

/** How many recent activity items `studio.context` carries. */
const STUDIO_CONTEXT_ACTIVITY_LIMIT = 30;
/** Characters kept of an activity item's title. */
const CONTEXT_TITLE_CHARS = 500;
/** Characters kept of an activity item's detail. */
const CONTEXT_DETAIL_CHARS = 1500;

export function studioRpc(core: StudioCore) {
  return {
    [HostMethod.StudioContext]: async () => studioContext(core),
    // Main's language: the one its menus speak, resolved from Settings and the computer's list.
    [HostMethod.StudioLanguage]: async () => ({ tag: currentLocale(), name: LOCALE_NAMES[currentLocale()] }),
    [HostMethod.ContextPolicy]: async (p) => core.contextPreferences.get(p.engine, p.model ?? "", p.threadId),
  } satisfies Partial<HarnessHostHandlers>;
}

/** The studio as a session sees it: settings, games and recent activity. */
async function studioContext(core: StudioCore) {
  return {
    settings: core.settings,
    games: (await core.games.list()).map((game) => ({ name: game.name, title: game.title })),
    recentActivity: (await core.activityItems()).slice(0, STUDIO_CONTEXT_ACTIVITY_LIMIT).map((item) => ({
      ...item,
      title: item.title.slice(0, CONTEXT_TITLE_CHARS),
      detail: item.detail.slice(0, CONTEXT_DETAIL_CHARS),
    })),
  };
}
