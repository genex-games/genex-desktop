/**
 * Building games — the tools the studio uses to do its day job.
 *
 * Every file operation goes through the substrate rather than `node:fs` so that path containment
 * and change notification stay true no matter how the agent rewrites this file.
 */
import type { AnyRecord, HarnessTool, ToolCtx } from "../types/harness.d.ts";
import { clampRunHours, hoursNamed, MAX_RUN_HOURS } from "../loop/config.ts";
import { HostMethod } from "../loop/host-methods.ts";
import { EngineId } from "../loop/model-roles.ts";
import { StopReason } from "../loop/outage.ts";
import { REFERENCE_MIN_STILLS, ReferenceKind, RunMode } from "../loop/run-events.ts";
import { MINUTE_MS } from "../loop/time.ts";
import { TurnStop } from "../loop/turn-record.ts";
import { isRecord } from "../loop/json.ts";
import { BuildTarget, GameStack } from "../loop/native-contract.ts";
import { nightStack, scaffoldFor } from "../loop/native-loop.ts";
import { LoopProfile, loopProfileOf, ProjectStarter, ProjectTool } from "../loop/folder-facts.ts";
import { OPEN_LAUNCH_WORDS } from "../loop/open-loop-prompts.ts";
import { UNTIL_DONE_WORDS } from "../loop/until-done-prompts.ts";
import { scopeItems } from "../loop/scope.ts";

/**
 * These tools give an existing C++ · raylib game's builds their time and never ask for a new one
 * (raylib creation is retired). run-dispatch.ts and chat-dispatch.ts refuse a raylib night on a
 * kept copy without this mark.
 */
export const SERVES_NATIVE = true;

/**
 * These tools make a Rust · wgpu game for any desktop or phone destination (`targets`), read a
 * Rust game's stack by its kind and give its cargo builds their time (`COMMAND_TIMEOUT_MS`):
 * run-dispatch.ts refuses a Rust night on a kept copy without this mark.
 */
export const SERVES_RUST = true;

/**
 * How long `run_command` lets a command run when the call names no timeout: a compiled build takes
 * longer. The app's copy is `src/shared/toolchain.ts` (seed-contracts.test.ts holds the two equal).
 */
export const COMMAND_TIMEOUT_MS: Readonly<Record<GameStack, number>> = {
  [GameStack.ThreeJs]: 2 * MINUTE_MS,
  [GameStack.RaylibCpp]: 10 * MINUTE_MS,
  // A cargo build is a compiled build too: it gets the C++ build's time until the Rust lane measures its own.
  [GameStack.RustWgpu]: 10 * MINUTE_MS,
};
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
/** Where people will play, as a tool parameter: any of the studio's destinations. */
const targetsParam = (description: string) => ({
  type: "array",
  items: { type: "string", enum: Object.values(BuildTarget) },
  description,
});
/** What a launch tool says about `targets`. */
const LAUNCH_TARGETS =
  "only for a game this chat has no folder for yet: where people will play it. Leave it out for the browser (three.js); any of macos, windows, linux, ios or android makes it a Rust · wgpu game (add web to build it for the browser too)";

/** What a launch tool's run carries of `targets`: the destinations a compiled game's intake chose, nothing for the browser. */
function launchTargets(targets: unknown): { targets?: BuildTarget[] } {
  const asked = scaffoldFor(targets);
  return asked.targets ? { targets: asked.targets } : {};
}

/** The time a command gets in `project` when the call names none, by the game's stack. */
async function commandTimeout(ctx: ToolCtx, project: string | null | undefined): Promise<number> {
  if (!project) return COMMAND_TIMEOUT_MS[GameStack.ThreeJs];
  const games = await ctx.call(HostMethod.GameList, {}).catch(() => []);
  return COMMAND_TIMEOUT_MS[nightStack(games.find((g) => g.name === project) ?? null)];
}

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

/**
 * A launch's hours, for a Loop an Auto chat was asked for in words (delegated-turn.ts `autoLaunchFor`
 * bridges this tool only while it has them); with Loop on the composer's hours win.
 */
const LOOP_HOURS_WORDS =
  "The hours the user named, digits only (3, 1.5); 0 when they said until done; leave it out when they named none (the Loop switch's hours, if on, else until done).";

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

/**
 * The Loop a chat's own turn asks for in words, when no Loop switch's commission reached the call (a
 * direct engine's tool loop, Loop off): the hours named, else until done. None in a run's turn, a
 * coordinator's follow-up or the Studio's own chat: those never start a Loop.
 */
function loopAskedInChat(args: AnyRecord, ctx: ToolCtx): AnyRecord | null {
  if (ctx.runId || ctx.followupOf || ctx.studioThread) return null;
  const hours = hoursNamed(args.hours);
  return hours > 0 ? { hours } : {};
}

/** The Loop a launch is for: the Loop switch's commission, else the one the chat asked for in words. */
const autopilotOf = (args: AnyRecord, ctx: ToolCtx): AnyRecord | null => ctx.autopilot ?? loopAskedInChat(args, ctx);

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
      "Create a new game project. With kind 'web' Genex writes its three.js starter, which already satisfies the studio contract (window.__studio), so the first screenshot works immediately. Leave kind out for an empty folder you fill yourself. With a desktop or phone destination in targets (macos, windows, linux, ios, android) it is a Rust · wgpu game from the Rust template, built by the studio for each destination; add web to targets to build it for the browser too.",
    parameters: {
      type: "object",
      properties: {
        name: str("lowercase project id, e.g. 'pong'"),
        title: str("human title"),
        kind: { type: "string", enum: [ProjectStarter.Web], description: "'web' for the three.js starter" },
        targets: targetsParam(
          "where people will play it — leave it out for a browser game; name a desktop destination only when the user asked for one",
        ),
      },
      required: ["name"],
    },
    async execute(args, ctx) {
      if (ctx.project) {
        return `This chat is already working in "${ctx.project}". Do not create another folder. Write files here with write_file.`;
      }
      const web = args.kind === ProjectStarter.Web;
      // A desktop or phone destination asks for the Rust template, whatever kind says.
      const compiled = scaffoldFor(args.targets);
      const project = await ctx.call(HostMethod.GameScaffold, {
        name: args.name,
        title: args.title ?? args.name,
        ...(web ? { kind: ProjectStarter.Web } : {}),
        ...compiled,
      });
      if (!web && !compiled.kind) return `Created ${project.name} at ${project.dir}: an empty folder, yours to fill.`;
      await ctx.call(HostMethod.PreviewLoad, { project: args.name });
      return `Created ${project.name} at ${project.dir} and loaded it in the preview.`;
    },
  },

  {
    name: ProjectTool.StartWebGame,
    description:
      "Make this game a web game: Genex writes its three.js starter here, which Live shows beside the chat. Only while the folder has no kind yet.",
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
      return "The web starter is in the folder; build on it.";
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
    name: "request_crate",
    description:
      "Rust games only: ask the person for one extra crate at one exact version (extension ladder level 4). " +
      "Only the person approves, in Studio's window; the answer is pending, vendored or refused with a typed code " +
      "(crate-declined, crate-advisory, crate-licence, crate-banned, crate-build-script, crate-proc-macro, …); " +
      "a known security advisory, a licence off the list or a banned crate refuses it even after the person approves. " +
      'Once vendored, name it in genex.toml under [crates] at that exact version (tidy = "=1.0.0"). ' +
      "Prefer the facade and the reviewed crates (noise, fastrand, pathfinding) first.",
    parameters: {
      type: "object",
      properties: {
        project: str("project id; defaults to this chat's folder"),
        name: str("the crate's registry name"),
        version: str("one exact version, MAJOR.MINOR.PATCH"),
        reason: str("one sentence for the person: what the game needs it for"),
      },
      required: ["name", "version", "reason"],
    },
    async execute(args, ctx) {
      const pin = pinProject(args, ctx);
      if (pin.error) return { ok: false, content: pin.error };
      const answer = await ctx.call(HostMethod.CratesRequest, {
        project: pin.project!,
        name: String(args.name ?? ""),
        version: String(args.version ?? ""),
        ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
      });
      const refused = answer.refusal ? ` (${answer.refusal})` : "";
      return {
        ok: !answer.refusal,
        content: `Crate request ${answer.requestId} for ${args.name} ${args.version}: ${answer.state}${refused}.`,
      };
    },
  },

  {
    name: "check_conformance",
    description:
      "Rust games only: run the game conformance suite on the game's current Mac build (every verb, seed determinism, " +
      "the capture digest, Stop and reap) and record the answer for that build. Read-only for the game: it builds, " +
      "starts and stops its own headless copies. An ejected game's Live, capture and export wait for a passing run " +
      "on each new build (conformance-required): run this after every engine/ change, and fix the check it names. " +
      "Working in a playable worktree, pass its root: a worktree's build is judged on its own.",
    parameters: {
      type: "object",
      properties: {
        project: str("project id; defaults to this chat's folder"),
        root: str("a playable worktree of the game to judge instead of its folder; omit for the folder"),
        demo: str("the demo the determinism check plays; the game's first demo when omitted"),
      },
      required: [],
    },
    async execute(args, ctx) {
      const pin = pinProject(args, ctx);
      if (pin.error || !pin.project) return { ok: false, content: pin.error ?? "No project is open in this chat." };
      const report = await ctx.call(HostMethod.GameConformance, {
        project: pin.project,
        ...(typeof args.root === "string" && args.root ? { root: args.root } : {}),
        ...(typeof args.demo === "string" && args.demo ? { demo: args.demo } : {}),
      });
      const build = report.buildDigest ? ` on build ${report.buildDigest.slice(0, 12)}` : "";
      const lines = report.checks.map(
        (c) => `- ${c.check}: ${c.outcome}${c.code ? ` (${c.code})` : ""}${c.detail ? ` — ${c.detail}` : ""}`,
      );
      return {
        ok: report.passed,
        content: [`Conformance ${report.passed ? "passed" : "failed"}${build}.`, ...lines].join("\n"),
      };
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
        timeoutMs: {
          type: "number",
          description: `default ${COMMAND_TIMEOUT_MS[GameStack.ThreeJs]} (${COMMAND_TIMEOUT_MS[GameStack.RaylibCpp]} in a C++ · raylib game, ${COMMAND_TIMEOUT_MS[GameStack.RustWgpu]} in a Rust · wgpu game)`,
        },
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
        timeoutMs: args.timeoutMs ?? (await commandTimeout(ctx, project)),
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
        targets: targetsParam(LAUNCH_TARGETS),
      },
      required: ["goal", "direction"],
    },
    async execute(args, ctx) {
      const loop = ctx.loop;
      const noHours = typeof loop?.hours !== "number" || loop.hours <= 0;
      if (!loop || noHours) {
        return {
          ok: false,
          content:
            "No Loop hours reached this call, so nothing started. Start the Loop with start_autopilot and the hours the user named instead.",
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
        // Where people will play a game this chat has no folder for yet (a desktop or phone one is Rust · wgpu).
        ...launchTargets(args.targets),
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
      "Launch a build (a Loop) — when Loop is on and the ask is to build the game or change it substantially, or, Loop on or off, when the user asks for a Loop in words; never for research, a plan or a small change. Know first what the game is and how it should look; when nobody said, ask_user instead. The build runs as the launch rules say for this project; it starts from this folder as you leave it when your reply ends. Call it once, last, then recap.",
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
        targets: targetsParam(LAUNCH_TARGETS),
        hours: { type: "number", description: LOOP_HOURS_WORDS },
      },
      required: ["goal", "direction"],
    },
    async execute(args, ctx) {
      const autopilot = autopilotOf(args, ctx);
      if (!autopilot) {
        return {
          ok: false,
          content: "A Loop starts from the chat, not from a build's own turn: nothing started.",
        };
      }
      const frames = attachedFrames(autopilot.frames);
      const kind = referenceKind(frames);
      // This slug only ever names a chat that has no folder yet: the launch stamps the chat's
      // own folder over it (turn-loop) and a bound thread wins outright (main.ts). It used to
      // outrank the binding, and the run then built in a second, empty folder while the user
      // typed into the chat attached to the first.
      const project = slugProject(args.project || args.direction || args.goal);
      // No cap set means run until what was asked is verified and nothing blocks it — with a 24h
      // safety ceiling so a wedged run can never hold the machine forever.
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
        // Where people will play a game this chat has no folder for yet (a desktop or phone one is Rust · wgpu).
        ...launchTargets(args.targets),
      };
      const clock = capped ? `Building for up to ${hours} h` : await untilDoneWords(ctx, ctx.project ?? project);
      return {
        ok: true,
        content: `${clock}${towardTheBar(kind, run.reference.name, frames.length)}`,
        stopTurn: TurnStop.LaunchRun,
        details: { run },
      };
    },
  },
];

/** How an ∞ build runs, as the launch tool answers: a web game's until what was asked is verified, any other project's until a reviewer's yes. */
async function untilDoneWords(ctx: ToolCtx, project: string): Promise<string> {
  // A game list Genex can't read leaves the web words, as before.
  const listed = await Promise.resolve()
    .then(() => ctx.call(HostMethod.GameList, {}))
    .catch(() => null);
  const game = Array.isArray(listed) ? listed.find((one) => one?.name === project) : undefined;
  return game && loopProfileOf(game) === LoopProfile.Open ? OPEN_LAUNCH_WORDS.building : `Building ${UNTIL_DONE_WORDS}`;
}

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
