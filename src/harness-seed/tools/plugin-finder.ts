/**
 * Finding a Genex plugin, for a local model's chat: `plugins_find` lists the plugins that are on,
 * those installed but off, and those in Genex's catalog (never another source); `plugins_suggest`
 * shows the person a card to turn one on. Neither turns a plugin on: only the person's click does.
 * The same tools a delegated chat session is handed by the host, by the same names.
 */
import { ProjectTool } from "../loop/folder-facts.ts";
import { HostMethod } from "../loop/host-methods.ts";
import { TurnStop } from "../loop/turn-record.ts";
import type { HarnessTool } from "../types/harness.d.ts";

/** Told to a tool called with no game open. */
const NO_PROJECT = "Open a project first.";

export const tools: HarnessTool[] = [
  {
    name: ProjectTool.PluginsFind,
    description:
      "Find a Genex plugin for a kind of project or a tool the person named. Read-only: it lists the plugins that are on, those installed but off, and those in Genex's catalog, and says what to do next. Give `fact` (a kind of project, e.g. godot-project or unreal-project) or `text` (words such as an engine's name), or both. An engine's own plugins are files in the project, not Genex plugins.",
    parameters: {
      type: "object",
      properties: {
        fact: { type: "string", description: "A kind of project, e.g. godot-project, unreal-project, blender-assets." },
        text: { type: "string", description: "Words to look for in a plugin's name or description, e.g. Unreal." },
      },
    },
    async execute(args, ctx) {
      const answer = await ctx.call(HostMethod.PluginsFind, {
        project: ctx.project ?? null,
        fact: typeof args.fact === "string" ? args.fact : null,
        text: typeof args.text === "string" ? args.text : null,
      });
      return JSON.stringify(answer);
    },
  },

  {
    name: ProjectTool.PluginsSuggest,
    description:
      "Show the person a card to turn on, or install, a Genex plugin that plugins_find listed as off or in the catalog. Only the person's click turns it on, so your reply ends here.",
    parameters: {
      type: "object",
      properties: {
        plugin: { type: "string", description: "The plugin's id, as plugins_find listed it." },
        reason: {
          type: "string",
          description: "One sentence for the person: why this plugin helps with what they asked.",
        },
      },
      required: ["plugin", "reason"],
    },
    async execute(args, ctx) {
      if (!ctx.project) return { ok: false, content: NO_PROJECT };
      const answer = await ctx.call(HostMethod.PluginsSuggest, {
        project: ctx.project,
        threadId: ctx.threadId,
        plugin: String(args.plugin ?? ""),
        reason: typeof args.reason === "string" ? args.reason : "",
      });
      // The card waits for the person: the turn ends with it, as a question asked does.
      return answer.shown
        ? { ok: true, content: answer.message, stopTurn: TurnStop.Done }
        : { ok: false, content: answer.message };
    },
  },
];
