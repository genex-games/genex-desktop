/**
 * Building games — the tools the studio uses to do its day job.
 *
 * Every file operation goes through the substrate rather than `node:fs` so that path containment
 * and change notification stay true no matter how the agent rewrites this file.
 */
import type { AnyRecord, HarnessTool, ToolCtx } from "../types/harness.d.ts";
import { clampRunHours, MAX_RUN_HOURS } from "../loop/config.ts";
import { HostMethod } from "../loop/host-methods.ts";
import { EngineId } from "../loop/model-roles.ts";
import { StopReason } from "../loop/outage.ts";
import { REFERENCE_MIN_STILLS, ReferenceKind, RunMode } from "../loop/run-events.ts";
import { MINUTE_MS } from "../loop/time.ts";
import { TurnStop } from "../loop/turn-record.ts";
import { isRecord } from "../loop/json.ts";
import { scopeItems } from "../loop/scope.ts";

/** How long `run_command` lets a command run when the call names no timeout. */
const COMMAND_TIMEOUT_MS = 2 * MINUTE_MS;
/** Bytes in the kilobyte an attached picture's size is said in. */
const KB = 1024;
/** How many words of the ask a new folder's name keeps, and how long that name may be. */
const SLUG_WORDS = 3;
const MAX_SLUG_CHARS = 40;
/** The folder a run builds in when its words leave no name. */
const FALLBACK_FOLDER = "game";
/** Words that say nothing about which game this is, left out of its folder's name. */
const SLUG_STOP = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "i",
  "want",
  "make",
  "game",
  "some",
  "kind",
  "just",
  "like",
  "aaa",
  "photoreal",
  "photorealistic",
  "really",
  "very",
]);

const str = (description: string) => ({ type: "string", description });
/**
 * A list parameter. Engines that declare intake fields as strings (claude-code.ts `intakeTool`) send
 * it as a JSON array in a string or one item per line: the registry lets that text through
 * (`acceptJsonString`) and `scopeItems` reads every shape.
 */
const list = (description: string) => ({
  type: "array",
  items: { type: "string" },
  acceptJsonString: true,
  description,
});

/** What a launch's goal is: the user's ask, nothing they did not ask for. */
const GOAL_WORDS = "one paragraph in the user's words; add nothing they did not ask for — put it in cut, or ask";
/** What a launch delivers. */
const IN_SCOPE_WORDS = "what this build delivers, each item in the user's words";
/** What a launch leaves out: a named reference is a look bar, not a feature list. */
const CUT_WORDS =
  "what a game like this often has that this build will not (a reference is a look bar, not a feature list)";

/** A launch's in-scope and cut lists as the run carries them to its scope (chat-dispatch.ts `intakeRun`); none when unnamed. */
function scopeArgs(args: AnyRecord): { inScope?: string[]; cut?: string[] } {
  const inScope = scopeItems(args.in_scope);
  const cut = scopeItems(args.cut);
  return { ...(inScope.length ? { inScope } : {}), ...(cut.length ? { cut } : {}) };
}

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
      "Create a new game project from the three.js template. The template already satisfies the studio contract (window.__studio), so the first screenshot works immediately.",
    parameters: {
      type: "object",
      properties: { name: str("lowercase project id, e.g. 'pong'"), title: str("human title") },
      required: ["name"],
    },
    async execute(args, ctx) {
      if (ctx.project) {
        return `This chat is already working in "${ctx.project}". Do not create another folder. Write files here with write_file.`;
      }
      const project = await ctx.call(HostMethod.GameScaffold, { name: args.name, title: args.title ?? args.name });
      await ctx.call(HostMethod.PreviewLoad, { project: args.name });
      return `Created ${project.name} at ${project.dir} and loaded it in the preview.`;
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
        ...(ctx.candidateId ? { candidateId: ctx.candidateId } : {}),
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
        ...(ctx.candidateId ? { candidateId: ctx.candidateId } : {}),
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
        ...(ctx.candidateId ? { candidateId: ctx.candidateId } : {}),
      });
      return `Wrote ${args.file} (${result.bytes} bytes).`;
    },
  },

  {
    name: "check_game",
    description:
      "Static check of a project before judging it: entry point present, studio contract installed, no Math.random (which would make two builds incomparable).",
    parameters: { type: "object", properties: { project: str("project id; defaults to this chat's folder") } },
    async execute(args, ctx) {
      const pin = pinProject(args, ctx);
      if (pin.error) return { ok: false, content: pin.error };
      const result = await ctx.call(HostMethod.GameValidate, {
        project: pin.project!,
        ...(ctx.candidateId ? { candidateId: ctx.candidateId } : {}),
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
        ...(ctx.candidateId ? { candidateId: ctx.candidateId } : {}),
      });
      return `Exported to ${result.dir}.`;
    },
  },

  {
    name: "delegate_to_contractor",
    description:
      "Hand a well-specified build task to a vendor harness (Claude Code or Codex, whichever subscription is signed in) working in the game workspace. Use for large, mechanical work. Write the brief carefully: the brief is the part you control and improve.",
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
      "Run a shell command inside the sandbox (no network, writes limited to the workspaces). Use for git, grep, or file inspection. Your own code (loop/, tools/, memory/, types/, tsconfig.json, package.json) is read-only here: change it with write_own_file or install_tool.",
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

  {
    name: "start_unattended_run",
    description:
      "Start a timed build — only when Loop is on and the ask is to build the game or change it substantially, never for research, a plan or a small change. Know first what the game is and how it should look; when nobody said, ask_user instead. It starts from this folder as you leave it when your reply ends: call it once, last, then recap.",
    parameters: {
      type: "object",
      properties: {
        goal: str(GOAL_WORDS),
        direction: str("the feeling bar — AAA photoreal rainy city, etc. Titles optional"),
        project: str("folder slug for a chat that has no folder yet, lowercase; a chat already bound to one keeps it"),
        notes: str("optional extra for the critic"),
        in_scope: list(IN_SCOPE_WORDS),
        cut: list(CUT_WORDS),
      },
      required: ["goal", "direction"],
    },
    async execute(args, ctx) {
      const loop = ctx.loop;
      const noHours = typeof loop?.hours !== "number" || loop.hours <= 0;
      if (!loop || noHours) {
        return {
          ok: false,
          content: "Loop is off in the composer. Ask the user to turn on Loop and set hours, then call this again.",
        };
      }
      const frames = attachedFrames(loop.frames);
      const kind = referenceKind(frames);
      // This slug only ever names a chat that has no folder yet: the launch stamps the chat's
      // own folder over it (turn-loop) and a bound thread wins outright (main.ts). It used to
      // outrank the binding, and the run then built in a second, empty folder while the user
      // typed into the chat attached to the first.
      const project = slugProject(args.project || args.direction || args.goal);
      const hours = clampRunHours(loop.hours);
      const { engine: builderEngine, model: builderModel } = commissionedBuilder(loop, ctx);
      const run = {
        goal: String(args.goal).trim(),
        project,
        reference: {
          name: String(args.direction).trim() || String(args.goal).trim(),
          shots: [],
          kind,
          ...(args.notes ? { notes: String(args.notes).trim() } : {}),
          ...(frames.length ? { frames } : {}),
        },
        hours,
        engine: builderEngine,
        ...(builderModel ? { model: builderModel } : {}),
        ...scopeArgs(args),
      };
      return {
        ok: true,
        content: `Starting ${hours}h${towardTheBar(kind, run.reference.name, frames.length)}`,
        stopTurn: TurnStop.LaunchRun,
        details: { run },
      };
    },
  },

  {
    name: "start_autopilot",
    description:
      "Launch a build — only when Loop is on and the ask is to build the game or change it substantially, never for research, a plan or a small change. Know first what the game is and how it should look; when nobody said, ask_user instead. The build decomposes into facets, builds each against a blind critic, and integrates; it starts from this folder as you leave it when your reply ends. Call it once, last, then recap.",
    parameters: {
      type: "object",
      properties: {
        goal: str(GOAL_WORDS),
        direction: str("the visual/feeling bar — a named game or film, or a described feeling"),
        project: str("folder slug for a chat that has no folder yet, lowercase; a chat already bound to one keeps it"),
        notes: str("optional extra for the critics — what makes the reference good"),
        textual_reference: str("if the user had no images: the game/film they named as the vibe"),
        in_scope: list(IN_SCOPE_WORDS),
        cut: list(CUT_WORDS),
      },
      required: ["goal", "direction"],
    },
    async execute(args, ctx) {
      const autopilot = ctx.autopilot;
      if (!autopilot) {
        return {
          ok: false,
          content:
            "No hours are set in the composer. Ask the user to pick hours there (∞ until satisfied, or a number of hours), then call this again.",
        };
      }
      const frames = attachedFrames(autopilot.frames);
      const kind = referenceKind(frames);
      // This slug only ever names a chat that has no folder yet: the launch stamps the chat's
      // own folder over it (turn-loop) and a bound thread wins outright (main.ts). It used to
      // outrank the binding, and the run then built in a second, empty folder while the user
      // typed into the chat attached to the first.
      const project = slugProject(args.project || args.direction || args.goal);
      // No cap set means run until the critics are satisfied — with a 24h safety ceiling so a
      // wedged run can never hold the machine forever.
      const capped = typeof autopilot.hours === "number" && autopilot.hours > 0;
      const hours = capped ? clampRunHours(autopilot.hours) : MAX_RUN_HOURS;
      const notes = criticNotes(args);
      // Same leak guard as start_unattended_run: the interview's borrowed local model must not
      // become the contractor's model.
      const { engine: builderEngine, model: builderModel } = commissionedBuilder(autopilot, ctx);
      const run = {
        goal: String(args.goal).trim(),
        project,
        mode: RunMode.Autopilot,
        reference: {
          name: String(args.textual_reference || args.direction).trim() || String(args.goal).trim(),
          shots: [],
          kind,
          ...(notes ? { notes } : {}),
          ...(frames.length ? { frames } : {}),
        },
        hours,
        // ∞ is its own fact, not the 24h ceiling above: the app reads it back as "until satisfied".
        ...(capped ? {} : { untilSatisfied: true }),
        engine: builderEngine,
        ...(builderModel ? { model: builderModel } : {}),
        // The composer's roles panel: orchestrator / workers / judges, applied at launch
        // (model-roles.ts) — the interview's own model is never inferred as the builders'.
        ...(autopilot.roles && typeof autopilot.roles === "object" ? { roles: autopilot.roles } : {}),
        ...(autopilot.reviewPlan === true ? { reviewPlan: true } : {}),
        ...scopeArgs(args),
      };
      const clock = capped ? `Building for up to ${hours} h` : `Building until the critics are satisfied`;
      return {
        ok: true,
        content: `${clock}${towardTheBar(kind, run.reference.name, frames.length)}`,
        stopTurn: TurnStop.LaunchRun,
        details: { run },
      };
    },
  },
];

/** The reference stills the composer attached, without empty slots. */
function attachedFrames(frames: AnyRecord[] | null | undefined): AnyRecord[] {
  return (frames ?? []).filter((frame: AnyRecord | null) => frame?.data);
}

/** Two or more stills are a picture reference; fewer, a described direction. */
function referenceKind(frames: readonly AnyRecord[]): ReferenceKind {
  return frames.length >= REFERENCE_MIN_STILLS ? ReferenceKind.Reference : ReferenceKind.Direction;
}

/** What the critics are told beyond the direction: the user's notes and the vibe they named. */
function criticNotes(args: AnyRecord): string {
  const vibe = args.textual_reference ? `the user names "${args.textual_reference}" as the vibe` : "";
  return [args.notes, vibe]
    .map((s) => String(s ?? "").trim())
    .filter(Boolean)
    .join("; ");
}

/**
 * Who builds the commissioned run. ctx.model is whatever this interview chat ran on. When a
 * contractor is the builder the chat borrowed a local model — that model belongs to the chat,
 * never to the builder.
 */
function commissionedBuilder(commission: AnyRecord, ctx: ToolCtx): { engine: string; model: string | undefined } {
  const engine = commission.builderEngine ?? ctx.engine ?? EngineId.Ollama;
  const model = commission.builderModel ?? (engine === ctx.engine ? ctx.model : undefined);
  return { engine, model };
}

/** The launch line's second half: the bar the run builds toward. */
function towardTheBar(kind: string, name: string, stills: number): string {
  if (kind === ReferenceKind.Reference) return ` toward "${name}" with ${stills} stills as the bar.`;
  return ` toward "${name}" — the feeling is the bar.`;
}

/** A new folder's name from the words of the ask: its first few telling words, joined by dashes. */
function slugProject(text: unknown): string {
  const words = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/\s+/)
    .filter((word) => word && !SLUG_STOP.has(word));
  return (words.slice(0, SLUG_WORDS).join("-") || FALLBACK_FOLDER).slice(0, MAX_SLUG_CHARS);
}
