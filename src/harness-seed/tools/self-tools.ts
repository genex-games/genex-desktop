/**
 * Self-modification — hard constraint #1 (full recursion), PLAN.md §5.3.
 *
 * These tools let the studio rewrite its own loop, tools, skills, prompts and memory policy while
 * it runs. That is the root of the experiment, and it is only survivable because of what the
 * substrate guarantees underneath: every edit is preceded by a snapshot, a restart is the only
 * way to load new code, and a version that cannot boot is rewound by the watchdog without a human.
 *
 * The one thing they cannot touch is the substrate itself — it lives in the app bundle, outside
 * the workspace — which is what keeps "the agent broke containment" off the table.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { MAX_VALUE_CHARS, normalise, shouldRemember } from "../memory/policy.ts";
import type { AnyRecord, HarnessTool, ToolCtx } from "../types/harness.d.ts";
import { HostMethod } from "../loop/host-methods.ts";
import { EventKind, RunEvent } from "../loop/run-events.ts";

const str = (description: string) => ({ type: "string", description });

/**
 * The plain words every self-change carries: the person sees them in Activity, beside the diff
 * and Undo, and never reads your files.
 */
const PLAIN_WORDS_PARAMS = {
  title: str(
    "for the person using the app, who never reads your files: at most eight plain words starting with a verb, saying what you will do differently",
  ),
  summary: {
    type: "array",
    items: { type: "string" },
    description:
      "one to three short plain sentences about the same change, for the same person; no file, tool or skill names",
  },
};

/** What a self-change says about itself: why (for the log), and its plain words (for the person). */
type ChangeWords = { reason: string; title?: unknown; summary?: unknown };

/** A tool call's own words about its change. */
const changeWords = (args: AnyRecord): ChangeWords => ({
  reason: args.reason,
  title: args.title,
  summary: args.summary,
});

/** Paths inside the harness workspace are the agent's own body; nothing outside is reachable. */
function selfPath(ctx: ToolCtx, relative: string): string {
  const base = ctx.workspace;
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`path escapes the harness workspace: ${relative}`);
  }
  return target;
}

/**
 * Change one of your own files (`guardian.write_self`). The host tries the change in a
 * validation fork of this workspace first — code is type-checked with the app's TypeScript 7
 * compiler, and the copy has to boot — then takes a snapshot, writes the file, takes a second
 * snapshot and records the change where the person's Activity and Undo read it. Prompts and
 * skills are write-denied to this process: this is the only way they change.
 */
async function writeSelf(
  ctx: ToolCtx,
  file: string,
  contents: string,
  { reason, title, summary }: ChangeWords,
): Promise<{ ok: true; snapshotId: string } | { ok: false; message: string }> {
  // The host takes the path as the workspace spells it, whatever form it was given in.
  const rel = path.relative(ctx.workspace, selfPath(ctx, file)).split(path.sep).join("/");
  const words = {
    ...(typeof title === "string" ? { title } : {}),
    ...(Array.isArray(summary) ? { summary: summary.filter((line): line is string => typeof line === "string") } : {}),
  };
  const written = await ctx.call(HostMethod.GuardianWriteSelf, { file: rel, contents, reason, ...words });
  return written.ok ? { ok: true, snapshotId: written.snapshotId } : { ok: false, message: written.message };
}

/** The tool result for a refused change: the host's reason, and that nothing was written. */
function notApplied(file: string, reason: string): { ok: false; content: string } {
  return {
    ok: false,
    content: `Not applied: ${file} is unchanged. A copy of you with this change failed the check.\n${reason}`,
  };
}

/**
 * What `remember` says it kept: the fact, and what fitting memory (`normalise`) cut or let go — a
 * fact cut or dropped without a word was lost silently.
 */
function rememberedWords(key: string, { clipped, dropped }: { clipped: boolean; dropped: string[] }): string {
  return [
    `Remembered ${key}${clipped ? ` (only its first ${MAX_VALUE_CHARS} characters — memory keeps facts short)` : ""}.`,
    dropped.length ? `Memory is full, so the oldest facts were dropped: ${dropped.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export const tools: HarnessTool[] = [
  {
    name: "list_own_files",
    description: "List your own source: loop, tools, skills, prompts, judge, memory.",
    parameters: { type: "object", properties: { dir: str("subdirectory, default '.'") } },
    async execute(args, ctx) {
      const base = selfPath(ctx, args.dir ?? ".");
      const out: string[] = [];
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 4) return;
        for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(full, depth + 1);
          else out.push(path.relative(ctx.workspace, full));
        }
      };
      await walk(base, 0);
      return out.sort().join("\n");
    },
  },

  {
    name: "read_own_file",
    description: "Read one of your own files.",
    parameters: {
      type: "object",
      properties: { file: str("path relative to your workspace, e.g. tools/game-tools.ts") },
      required: ["file"],
    },
    async execute(args, ctx) {
      const contents = await readFile(selfPath(ctx, args.file), "utf8");
      return `\`\`\`\n${contents}\n\`\`\``;
    },
  },

  {
    name: "write_own_file",
    description:
      "Rewrite one of your own files. The change is first tried in a copy of you — a code file (.ts) is type-checked (against the app's own tsconfig, not yours), and the copy has to boot. If it adds type errors or the copy does not start, nothing is written and you get the errors back. Otherwise it is written between two snapshots, so a bad edit is always recoverable, and the person sees it in Activity and can undo it. Editing tools/ takes effect on the next round of this turn; editing loop/ needs restart_studio.",
    parameters: {
      type: "object",
      properties: {
        file: str("path relative to your workspace"),
        contents: str("full new contents"),
        reason: str("why you are changing this — it goes in the log and the self-change diff"),
        ...PLAIN_WORDS_PARAMS,
      },
      required: ["file", "contents", "reason", "title", "summary"],
    },
    async execute(args, ctx) {
      // R4: the judge rubrics are the yardstick this self is measured by — frozen. The sandbox
      // denies the write anyway; this guard just says why instead of a bare EPERM.
      if (args.file === "judge" || args.file.startsWith("judge/")) {
        throw new Error(`judge/ is frozen: the blind critic's rubric is not yours to edit (refused: ${args.file})`);
      }
      const written = await writeSelf(ctx, args.file, args.contents, changeWords(args));
      if (!written.ok) return notApplied(args.file, written.message);
      ctx.notify("selfmod.edited", { file: args.file, reason: args.reason });
      const needsRestart = args.file.startsWith("loop/");
      return {
        ok: true,
        content:
          `Rewrote ${args.file} (tried in a copy of you first; snapshot ${written.snapshotId} taken before). ` +
          (needsRestart
            ? "This is loop code — call restart_studio to load it."
            : "Tools and skills reload on the next round; no restart needed."),
      };
    },
  },

  {
    name: "install_tool",
    description:
      "Create a new tool for yourself: a TypeScript module (Node runs it by stripping its types; erasable syntax only — no enum, namespace or parameter properties) that exports `tools` — an array of { name, description, parameters, execute(args, ctx) }. It is type-checked and booted in a copy of you first; if that fails, nothing is installed and you get the errors back. It becomes callable on the very next round.",
    parameters: {
      type: "object",
      properties: {
        filename: str("e.g. audio-tools.ts"),
        contents: str("full TypeScript module source"),
        reason: str("what this tool is for"),
        ...PLAIN_WORDS_PARAMS,
      },
      required: ["filename", "contents", "reason", "title", "summary"],
    },
    async execute(args, ctx) {
      // `.mjs` is the pre-TypeScript extension, still accepted for a tool written in plain JavaScript.
      if (!/^[a-z0-9-]+\.(?:ts|mjs)$/.test(args.filename)) {
        return { ok: false, content: "filename must look like my-tools.ts (lowercase, .ts)" };
      }
      const written = await writeSelf(ctx, `tools/${args.filename}`, args.contents, changeWords(args));
      if (!written.ok) return notApplied(`tools/${args.filename}`, written.message);
      ctx.notify("selfmod.tool_installed", { file: args.filename, reason: args.reason });
      return `Installed tools/${args.filename} (tried in a copy of you first). It will be in your tool list on the next round — call it to check that it works.`;
    },
  },

  {
    name: "read_skill",
    description: "Read the body of one of your skills.",
    parameters: { type: "object", properties: { slug: str("skill file name without .md") }, required: ["slug"] },
    async execute(args, ctx) {
      const contents = await readFile(selfPath(ctx, path.join("skills", `${args.slug}.md`)), "utf8");
      return contents;
    },
  },

  {
    name: "write_skill",
    description:
      "Create or rewrite a skill. Skills are how you keep what you learn: be concrete — quote exact thresholds, section names and formats. Vague rules do not change behaviour. The change is tried in a copy of you first, and the person sees it in Activity and can undo it.",
    parameters: {
      type: "object",
      properties: {
        slug: str("file name without .md"),
        contents: str("full markdown, starting with --- name: … description: … ---"),
        reason: str("what you learned that made you write this"),
        ...PLAIN_WORDS_PARAMS,
      },
      required: ["slug", "contents", "reason", "title", "summary"],
    },
    async execute(args, ctx) {
      const file = path.join("skills", `${args.slug}.md`);
      const written = await writeSelf(ctx, file, args.contents, changeWords(args));
      if (!written.ok) return notApplied(file, written.message);
      ctx.notify("selfmod.skill_edited", { slug: args.slug, reason: args.reason });
      return `Wrote skills/${args.slug}.md (tried in a copy of you first).`;
    },
  },

  {
    name: "restart_studio",
    description:
      "Restart your own runtime to load changes to loop code. The substrate snapshots you, writes a durable update record, lets this turn finish, then respawns you. You will read the outcome in your own log.",
    parameters: {
      type: "object",
      properties: { reason: str("why you need to restart") },
      required: ["reason"],
    },
    async execute(args, ctx) {
      const queued = await ctx.call(HostMethod.GuardianRebuildAndRestart, { reason: args.reason });
      return {
        ok: true,
        content: `Restart queued (update ${queued.updateId}, snapshot ${queued.snapshotId}). This turn ends here; you will wake up with the new code.`,
        stopTurn: "restart",
      };
    },
  },

  {
    name: "self_history",
    description: "What you have changed about yourself, newest last, with the reasons you gave.",
    parameters: { type: "object", properties: { limit: { type: "number", description: "default 20" } } },
    async execute(args, ctx) {
      const events = await ctx.call(HostMethod.EventsList, {});
      const interesting = new Set<string>([
        RunEvent.SelfEdit,
        RunEvent.ToolInstalled,
        RunEvent.SkillEdited,
        RunEvent.RebuildAndRestartStudio,
        RunEvent.SkilloptAccepted,
        RunEvent.SkilloptRejected,
      ]);
      const rows = events
        .filter((e) => e.data.type === EventKind.Custom && interesting.has(e.data.event_type))
        .slice(-(args.limit ?? 20))
        .map((e) => `- ${e.created_at} ${e.data.event_type}: ${JSON.stringify(e.data.payload)}`);
      return rows.length ? rows.join("\n") : "You have not changed yourself yet.";
    },
  },

  {
    name: "remember",
    description:
      "Store a durable fact about this studio, this machine, or the user's taste. Memory is injected into every prompt, so keep it short and specific.",
    parameters: {
      type: "object",
      properties: { key: str("short key"), value: str("the fact") },
      required: ["key", "value"],
    },
    async execute(args, ctx) {
      // The policy is harness code, so the studio can change what it considers worth keeping.
      if (!shouldRemember(args.key, args.value)) {
        return {
          ok: false,
          content: `Not remembered: "${args.key}" looks transient. Memory is for durable facts — put anything about the current task in the log instead.`,
        };
      }
      const memory = ((await ctx.call(HostMethod.ArtifactRead, { artifactId: "memory" })) ?? {}) as AnyRecord;
      // Re-set, not overwritten in place: a fact just updated is the newest, never the next to go.
      delete memory[args.key];
      memory[args.key] = args.value;
      const fitted = normalise(memory);
      await ctx.call(HostMethod.ArtifactWrite, { artifactId: "memory", value: fitted });
      return rememberedWords(args.key, {
        clipped: fitted[args.key] !== args.value,
        dropped: Object.keys(memory).filter((key) => !(key in fitted)),
      });
    },
  },

  {
    name: "forget",
    description: "Remove a memory that turned out to be wrong or stale.",
    parameters: { type: "object", properties: { key: str("key to remove") }, required: ["key"] },
    async execute(args, ctx) {
      const memory = ((await ctx.call(HostMethod.ArtifactRead, { artifactId: "memory" })) ?? {}) as AnyRecord;
      delete memory[args.key];
      await ctx.call(HostMethod.ArtifactWrite, { artifactId: "memory", value: normalise(memory) });
      return `Forgot ${args.key}.`;
    },
  },

  {
    name: "snapshot_now",
    description: "Take a checkpoint of the current state so you can come back to it.",
    parameters: {
      type: "object",
      properties: { reason: str("what this checkpoint is"), project: str("game project to include") },
      required: ["reason"],
    },
    async execute(args, ctx) {
      const record = await ctx.call(HostMethod.SnapshotCreate, {
        scope: args.project ? "both" : "harness",
        reason: args.reason,
        ...(args.project ? { project: args.project } : {}),
      });
      return `Snapshot ${record.snapshot_id}.`;
    },
  },

  {
    name: "stat_own_file",
    description: "Size and modification time of one of your files.",
    parameters: { type: "object", properties: { file: str("relative path") }, required: ["file"] },
    async execute(args, ctx) {
      const info = await stat(selfPath(ctx, args.file));
      return `${args.file}: ${info.size} bytes, modified ${new Date(info.mtimeMs).toISOString()}`;
    },
  },
];
