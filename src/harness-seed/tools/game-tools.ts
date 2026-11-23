/**
 * Building games — the tools the studio uses to do its day job. A Loop's start is not one of them:
 * only a chat's own session is handed it (loop/start-autopilot.ts).
 *
 * Every file operation goes through the substrate rather than `node:fs` so that path containment
 * and change notification stay true no matter how the agent rewrites this file.
 */
import type { AnyRecord, HarnessTool, ToolCtx } from "../types/harness.d.ts";
import { HostMethod } from "../loop/host-methods.ts";
import { StopReason } from "../loop/outage.ts";
import { MINUTE_MS } from "../loop/time.ts";
import { isRecord } from "../loop/json.ts";
import { ProjectStarter, ProjectTool } from "../loop/folder-facts.ts";

/** How long `run_command` lets a command run when the call names no timeout. */
const COMMAND_TIMEOUT_MS = 2 * MINUTE_MS;
/** Bytes in the kilobyte an attached picture's size is said in. */
const KB = 1024;

const str = (description: string) => ({ type: "string", description });

/** Does the call name a folder other than the one this chat is pinned to? */
function pinnedElsewhere(args: AnyRecord, ctx: ToolCtx): boolean {
  return Boolean(ctx.project && args.project && args.project !== ctx.project);
}

/** The folder a file tool works in: the chat's own, or the one named when the chat has none (`error` otherwise). */
function pinProject(args: AnyRecord, ctx: ToolCtx): { project?: string; error?: string } {
  if (ctx.project) {
    if (pinnedElsewhere(args, ctx)) {
      return { error: `This chat is pinned to "${ctx.project}". Do not open "${args.project}".` };
    }
    return { project: ctx.project };
  }
  if (!args.project) return { error: "No project is open in this chat." };
  return { project: args.project };
}

export const tools: HarnessTool[] = [
  {
    name: "list_games",
    description: "List the game projects in the studio.",
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx) {
      if (ctx.project) {
        return `This chat is pinned to "${ctx.project}". Do not list or open other folders.\n- ${ctx.project}`;
      }
      const games = await ctx.call(HostMethod.GameList, {});
      return games.length
        ? games.map((g) => `- ${g.name} — ${g.title}`).join("\n")
        : "No games yet. Use new_game to create one.";
    },
  },

  {
    name: "new_game",
    description:
      "Create a new game project. With kind 'web' Genex writes a starter web page; leave kind out for an empty folder you fill yourself.",
    parameters: {
      type: "object",
      properties: {
        name: str("lowercase project id, e.g. 'pong'"),
        title: str("human title"),
        kind: { type: "string", enum: [ProjectStarter.Web], description: "'web' for a starter web page" },
      },
      required: ["name"],
    },
    async execute(args, ctx) {
      if (ctx.project) {
        return `This chat is already working in "${ctx.project}". Do not create another folder. Write files here with write_file.`;
      }
      const web = args.kind === ProjectStarter.Web;
      const project = await ctx.call(HostMethod.GameScaffold, {
        name: args.name,
        title: args.title ?? args.name,
        ...(web ? { kind: ProjectStarter.Web } : {}),
      });
      const content = !web
        ? `Created ${project.name} at ${project.dir}: an empty folder, yours to fill.`
        : `Created ${project.name} at ${project.dir} and loaded it in the preview.`;
      if (web) await ctx.call(HostMethod.PreviewLoad, { project: project.name });
      return { ok: true, content, details: { project: project.name } };
    },
  },

  {
    name: ProjectTool.StartWebGame,
    description:
      "Make this game a web game: Genex writes a starter web page here, which Live shows beside the chat. Only while the folder has no kind yet.",
    parameters: { type: "object", properties: { project: str("project id; defaults to this chat's folder") } },
    async execute(args, ctx) {
      const pin = pinProject(args, ctx);
      if (pin.error) return { ok: false, content: pin.error };
      const project = pin.project as string;
      // The chat this turn answers: while it is in Plan the host writes nothing and says why.
      const started = await ctx.call(HostMethod.GameStart, {
        project,
        starter: ProjectStarter.Web,
        threadId: ctx.threadId,
      });
      if ("blocker" in started) return started.message;
      await ctx.call(HostMethod.PreviewLoad, { project });
      return "Genex wrote the game's page: index.html, which loads src/main.js; both are yours to change. Its import map names three.js r185 (`three`, `three/addons/`, `three/webgpu`, `three/tsl`), which Genex serves from its own copy at /vendor/ for a game that wants it.";
    },
  },

  {
    name: "list_files",
    description:
      "List the files of a game project. Images in references/ or ref/ are stills to look at with read_file.",
    parameters: { type: "object", properties: { project: str("project id; defaults to this chat's folder") } },
    async execute(args, ctx) {
      const pin = pinProject(args, ctx);
      if (pin.error) return { ok: false, content: pin.error };
      const files = await ctx.call(HostMethod.GameTree, {
        project: pin.project!,
      });
      const image = /\.(png|jpe?g|webp|gif)$/i;
      return files
        .map((file) => (image.test(file) ? `${file}  (image — read_file shows you the picture)` : file))
        .join("\n");
    },
  },

  {
    name: "read_file",
    description:
      "Read one file from this project's folder, or an absolute path the user named (stills in another folder). Text comes back as text. Images are shown as pictures — look at them.",
    parameters: {
      type: "object",
      properties: {
        project: str("project id; defaults to this chat's folder"),
        file: str("path relative to the project, or an absolute path the user named"),
      },
      required: ["file"],
    },
    async execute(args, ctx) {
      const pin = pinProject(args, ctx);
      if (pin.error) return { ok: false, content: pin.error };
      const contents = await ctx.call(HostMethod.GameRead, {
        project: pin.project!,
        file: args.file,
      });
      if (isRecord(contents) && contents.kind === "image") {
        return {
          ok: true,
          content: `Attached ${args.file} (${Math.round(contents.bytes / KB)} KB). Look at the picture.`,
          images: [{ mimeType: contents.mimeType, data: contents.data, label: args.file }],
        };
      }
      return `\`\`\`\n${contents}\n\`\`\``;
    },
  },

  {
    name: "write_file",
    description:
      "Write a file in a game project (creates or overwrites). Reload the preview afterwards to see the change.",
    parameters: {
      type: "object",
      properties: {
        project: str("project id; defaults to this chat's folder"),
        file: str("path relative to the project"),
        contents: str("full file contents"),
      },
      required: ["file", "contents"],
    },
    async execute(args, ctx) {
      const pin = pinProject(args, ctx);
      if (pin.error) return { ok: false, content: pin.error };
      const result = await ctx.call(HostMethod.GameWrite, {
        project: pin.project!,
        file: args.file,
        contents: args.contents,
      });
      return `Wrote ${args.file} (${result.bytes} bytes).`;
    },
  },

  {
    name: "check_game",
    description:
      "Static check of a project: its entry point is present and the page loads nothing the preview cannot reach.",
    parameters: { type: "object", properties: { project: str("project id; defaults to this chat's folder") } },
    async execute(args, ctx) {
      const pin = pinProject(args, ctx);
      if (pin.error) return { ok: false, content: pin.error };
      const result = await ctx.call(HostMethod.GameValidate, {
        project: pin.project!,
      });
      const lines = [result.ok ? "OK" : "PROBLEMS:", ...result.problems.map((p) => `- ${p}`)];
      if (result.warnings.length) lines.push("WARNINGS:", ...result.warnings.map((w) => `- ${w}`));
      return { ok: result.ok, content: lines.join("\n") };
    },
  },

  {
    name: "export_game",
    description: "Export a game as a self-contained web bundle that can be hosted anywhere.",
    parameters: { type: "object", properties: { project: str("project id") }, required: ["project"] },
    async execute(args, ctx) {
      const pin = pinProject(args, ctx);
      if (pin.error) return { ok: false, content: pin.error };
      const result = await ctx.call(HostMethod.GameExport, {
        project: pin.project!,
      });
      return `Exported to ${result.dir}.`;
    },
  },

  {
    name: "delegate_to_contractor",
    description:
      "Hand a well-specified build task to a vendor harness (Claude Code or Codex, whichever subscription is signed in) working in the game workspace. Use for large, mechanical work: write a complete brief, with how to tell the task is done.",
    parameters: {
      type: "object",
      properties: {
        project: str("project id"),
        brief: str("complete instructions, including the acceptance check"),
        engine: str("engine id — omit to use whichever subscription is signed in"),
      },
      required: ["project", "brief"],
    },
    async execute(args, ctx) {
      const pin = pinProject(args, ctx);
      if (pin.error) return { ok: false, content: pin.error };
      const result = await ctx.call(HostMethod.EngineDelegate, {
        ...(args.engine ? { engine: args.engine } : {}),
        project: pin.project!,
        prompt: args.brief,
      });
      return {
        ok: result.ok,
        content: result.ok
          ? `Contractor finished in ${result.turns} turns: ${result.summary}`
          : `Contractor stopped after ${result.turns} turns (${result.stopReason ?? StopReason.Error}): ${result.summary}`,
        details: { usage: result.usage },
      };
    },
  },

  {
    name: "run_command",
    description:
      "Run a shell command inside the sandbox (no network, writes limited to the workspaces). Use for git, grep, or file inspection. Your own code (loop/, tools/, types/, tsconfig.json, package.json) is read-only here: change it with write_own_file or install_tool.",
    parameters: {
      type: "object",
      properties: {
        command: str("shell command"),
        project: str("run inside this project's directory (optional)"),
        timeoutMs: { type: "number", description: "default 120000" },
      },
      required: ["command"],
    },
    async execute(args, ctx) {
      if (pinnedElsewhere(args, ctx)) {
        return {
          ok: false,
          content: `This chat is pinned to "${ctx.project}". Do not open "${args.project}".`,
        };
      }
      const project = args.project || ctx.project;
      const result = await ctx.call(HostMethod.RunExec, {
        command: args.command,
        ...(project ? { project } : {}),
        timeoutMs: args.timeoutMs ?? COMMAND_TIMEOUT_MS,
      });
      const body = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      return {
        ok: result.code === 0,
        content: `exit ${result.code}${result.timedOut ? " (timed out)" : ""}\n${body || "(no output)"}`,
      };
    },
  },
];
