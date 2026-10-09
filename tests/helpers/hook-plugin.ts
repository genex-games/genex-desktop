/**
 * A local test plugin, `hk`, that hooks Genex's moments for games holding a `*.hkproj` file (fact
 * `hk-project`). Its harness tools `save`, `tidy`, `flush`, `shot`, `ready`, `check` and `probe` log each
 * call (`{tool, hook}`, what `context.hook` told it) to a file beside the package, never in the game
 * folder a restore would put back (with the game's commit at the time), and answer from a script file the test writes: by `<on>:<tool>`,
 * else by tool; a list answers its entries in turn (the last one repeats); `{throws}` throws, and
 * `{writes}` first writes that file into the game's folder (a kind made).
 * `save` and `tidy` (a step of the run's start, a turn's end and health) need the lock `desk`,
 * whose person-first probe is `probe`. `paint` is its agent tool (it needs the desk too), and
 * `new-desk` its kind tool (it makes a desk game), whose readiness `ready` answers; `hk2`, a second
 * plugin with no hooks, has the agent tool `wave`; `hk3` hooks one checkpoint step, `note`, that
 * needs no lock, for games holding a `*.hklite` file.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpDir } from "./tmp.ts";

/** The test plugin's id, and the second plugin's. */
export const HOOK_PLUGIN = "hk";
export const OTHER_PLUGIN = "hk2";
export const LIGHT_PLUGIN = "hk3";
/** The fact a game with a `*.hklite` file holds, which only `hk3` hooks. */
export const LIGHT_FACT = "hk-lite";
/** The fact a game with a `*.hkproj` file holds. */
export const HOOK_FACT = "hk-project";
/** The label of the plugin's lock. */
export const DESK_LABEL = "Desk";

/**
 * The backend: log the call, then answer from the script. Its log and script are named by absolute
 * path: an installed plugin runs from its own copy of the package, not from the folder it came from.
 */
const backend = (log: string, script: string) => `
import { execFileSync } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const LOG = ${JSON.stringify(log)};
const SCRIPT = ${JSON.stringify(script)};
const turns = new Map();
export async function activate() {
  return {
    async tool(name, args, ctx) {
      let head = null;
      try { head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ctx.directory, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch {}
      await appendFile(LOG, JSON.stringify({ tool: name, hook: ctx.hook ?? null, args, head }) + "\\n");
      const script = JSON.parse(await readFile(SCRIPT, "utf8").catch(() => "{}"));
      const key = ctx.hook ? ctx.hook.on + ":" + name : name;
      let answer = script[key] ?? script[name] ?? {};
      if (Array.isArray(answer)) {
        const turn = turns.get(key) ?? 0;
        turns.set(key, turn + 1);
        answer = answer[Math.min(turn, answer.length - 1)];
      }
      if (answer && typeof answer.throws === "string") throw new Error(answer.throws);
      if (answer && typeof answer.writes === "string") {
        await writeFile(path.join(ctx.directory, answer.writes), "{}\\n");
        const { writes, ...rest } = answer;
        return rest;
      }
      return answer;
    },
  };
}
`;

const EMPTY = { type: "object", properties: {} };

/** What the lock's probe answers unless a script says otherwise: nobody is at the desk, nothing unsaved said. */
const NOBODY_AT_THE_DESK = { personActive: false };

/** A harness tool of the test plugin. */
const harnessTool = (name: string, needs?: string[]) => ({
  name,
  audience: "harness",
  description: `The ${name} step.`,
  parameters: EMPTY,
  ...(needs ? { needs } : {}),
});

/** The test plugin's hooks, each for games holding its fact. */
const HOOKS: Array<[string, string]> = [
  ["checkpoint.before", "save"],
  ["checkpoint.before", "flush"],
  ["checkpoint.after", "shot"],
  ["restore.before", "save"],
  ["restore.after", "ready"],
  ["health", "check"],
  ["run.prepare", "ready"],
  ["turn.start", "check"],
  ["tool.before", "save"],
  ["tool.after", "flush"],
  ["run.prepare", "tidy"],
  ["turn.end", "tidy"],
  ["health", "tidy"],
];

function hookManifest() {
  return {
    apiVersion: 3,
    id: HOOK_PLUGIN,
    version: "1.0.0",
    name: "Hook demo",
    publisher: "Studio tests",
    description: "Steps at Genex's moments, for games with a desk.",
    backend: "backend.mjs",
    capabilities: [],
    detect: [{ fact: HOOK_FACT, files: ["**/*.hkproj"] }],
    locks: [{ id: "desk", label: DESK_LABEL, per: "project", personFirst: "probe" }],
    tools: [
      {
        name: "paint",
        description: "Paint the desk.",
        parameters: { type: "object", properties: { color: { type: "string" } } },
        needs: ["desk"],
      },
      {
        name: "new-desk",
        description: "Make this game a desk game.",
        parameters: EMPTY,
        makes: [HOOK_FACT],
        ready: "ready",
      },
      harnessTool("save", ["desk"]),
      harnessTool("tidy", ["desk"]),
      harnessTool("flush"),
      harnessTool("shot"),
      harnessTool("ready"),
      harnessTool("check"),
      harnessTool("probe"),
    ],
    hooks: HOOKS.map(([on, tool]) => ({ on, tool, facts: [HOOK_FACT] })),
    skills: [],
    panels: [],
    settings: [],
    actions: [],
  };
}

function otherManifest() {
  return {
    apiVersion: 3,
    id: OTHER_PLUGIN,
    version: "1.0.0",
    name: "Hook neighbour",
    publisher: "Studio tests",
    description: "A plugin with no hooks.",
    backend: "backend.mjs",
    capabilities: [],
    tools: [{ name: "wave", description: "Wave.", parameters: EMPTY }],
    skills: [],
    panels: [],
    settings: [],
    actions: [],
  };
}

function lightManifest() {
  return {
    apiVersion: 3,
    id: LIGHT_PLUGIN,
    version: "1.0.0",
    name: "Hook lamp",
    publisher: "Studio tests",
    description: "A checkpoint step that needs no lock.",
    backend: "backend.mjs",
    capabilities: [],
    detect: [{ fact: LIGHT_FACT, files: ["**/*.hklite"] }],
    tools: [harnessTool("note")],
    hooks: [{ on: "checkpoint.before", tool: "note", facts: [LIGHT_FACT] }],
    skills: [],
    panels: [],
    settings: [],
    actions: [],
  };
}

/** One logged call: the tool, what it was told of the moment, its arguments, and the game's commit then. */
export interface HookCall {
  tool: string;
  hook: Record<string, unknown> | null;
  args: Record<string, unknown>;
  head: string | null;
}

/** A package folder written to a tmp dir, with its log and script. */
export interface HookPackage {
  dir: string;
  /** Every call so far, in order. */
  calls(): Promise<HookCall[]>;
  /** Each call as `<on>:<tool>` (or the tool alone outside a moment). */
  trail(): Promise<string[]>;
  /** Replace the script (the probe answers that nobody is at the desk unless it says otherwise), and empty the log. */
  script(answers: Record<string, unknown>): Promise<void>;
}

async function writePackage(manifest: object): Promise<HookPackage> {
  const dir = await tmpDir("studio-hook-plugin-");
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
  const log = path.join(dir, "hooks.log");
  const scriptFile = path.join(dir, "script.json");
  await writeFile(path.join(dir, "backend.mjs"), backend(log, scriptFile));
  const calls = async (): Promise<HookCall[]> =>
    (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as HookCall);
  return {
    dir,
    calls,
    trail: async () => (await calls()).map((call) => (call.hook ? `${String(call.hook.on)}:${call.tool}` : call.tool)),
    script: async (answers) => {
      await writeFile(scriptFile, JSON.stringify({ probe: NOBODY_AT_THE_DESK, ...answers }));
      await writeFile(log, "");
    },
  };
}

/** The `hk` package, ready to install from its folder. */
export const hookPackage = (): Promise<HookPackage> => writePackage(hookManifest());
/** The `hk2` package: an agent tool and no hooks. */
export const otherPackage = (): Promise<HookPackage> => writePackage(otherManifest());
/** The `hk3` package: one checkpoint step that needs no lock. */
export const lightPackage = (): Promise<HookPackage> => writePackage(lightManifest());
