/**
 * The genex-terms fixture: signed in as the account with Genex's updated terms still to accept
 * (`FixtureAccount.Terms`), so the sidebar shows "Genex terms updated" with Review, and the game's
 * chat holds a Genex image call that went no further than the terms, with Review under its work.
 */
import { CustomEvent } from "../../shared/custom-events.ts";
import { EventKind } from "../../shared/event-log.ts";
import { GENEX_PLUGIN_ID, GenexBlocked } from "../../shared/genex.ts";
import type { StudioCore } from "../studio-core.ts";
import { fixtureRun } from "./fixture-kit.ts";

/** The call's id, shared by its start and its end. */
const CALL_ID = "fixture-genex-terms-call";

/** A request for a picture, the Genex call the terms held up, and the agent's answer. */
export async function seedGenexTerms(core: StudioCore, project: string, threadId: string): Promise<void> {
  const call = fixtureRun({
    callId: CALL_ID,
    pluginId: GENEX_PLUGIN_ID,
    pluginName: "Genex",
    tool: "image",
    toolName: "genex__image",
    project,
    role: "chat",
  });
  await core.append(
    [
      {
        type: EventKind.Messages,
        messages: [{ role: "user", content: "Make a cover picture of the harbour at dawn." }],
      },
      call(CustomEvent.PluginToolStarted, { args: "harbour at dawn" }),
      call(CustomEvent.PluginTool, {
        ok: true,
        result: '{"status":"failed","blocked":"terms"}',
        blocked: GenexBlocked.Terms,
        images: 0,
        durationMs: 100_000,
      }),
      {
        type: EventKind.Messages,
        messages: [
          {
            role: "assistant",
            content: "Genex updated its terms, so I couldn't make the picture yet. Review them, then I'll try again.",
          },
        ],
      },
    ],
    threadId,
  );
}
