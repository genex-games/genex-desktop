/**
 * A fake Mac for the Godot plugin: Godot apps where the test puts them (each binary an empty file
 * whose version the fake answers), a runner that records every Godot job and answers it with
 * Godot's recorded words (`tests/fixtures/godot-cli/`), and the plugin's backend over both in an
 * open Genex game, with the host calls it makes recorded. Nothing here starts Godot.
 */
import { mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PluginContext } from "../../src/plugin-sdk/index.d.ts";
import { createGodotBackend } from "../../src/plugins/godot/backend.ts";
import type { EditorEnv, Launch } from "../../src/plugins/godot/editor.ts";
import { BRIDGE_FOLDER } from "../../src/plugins/godot/editor-bridge.ts";
import type { GodotEnv } from "../../src/plugins/godot/find-godot.ts";
import type { GodotInstallDeps } from "../../src/plugins/godot/godot-setup.ts";
import { type GodotCall, GodotJob, type GodotResult, type GodotRunner } from "../../src/plugins/godot/godot-run.ts";
import { tmpDir } from "./tmp.ts";

/** The shipped scripts and templates, read where the source keeps them. */
export const SCRIPTS = path.resolve("src/plugins/godot/scripts");
export const TEMPLATES = path.resolve("src/plugins/godot/templates");
export const ADDON = path.resolve("src/plugins/godot/addon/genex");
/** Godot 4.6.1's own version line. */
export const GODOT_461 = "4.6.1.stable.official.14d19694e";
/** A one-pixel PNG, as a capture saves it. */
export const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** Godot's recorded words, by fixture name. */
export const godotOutput = (name: string) => readFile(path.resolve("tests/fixtures/godot-cli", name), "utf8");

/** One Godot job as the runner was asked for it: the binary and the call. */
export type RanJob = { binary: string; call: GodotCall };

/** How the fake answers a job: its words, or its words and the stills it saves; else a quiet success. */
export type JobAnswers = Partial<Record<GodotJob, string | ((call: GodotCall) => Promise<string>)>>;

/** A play script argument's value (`key=value` after `--`), or "". */
export const playArg = (call: GodotCall, key: string) =>
  call.args
    .slice(call.args.indexOf("--") + 1)
    .find((arg) => arg.startsWith(`${key}=`))
    ?.slice(key.length + 1) ?? "";

/**
 * The play script's answer to a capture: at each frame `shots=` names, a PNG of every camera named
 * (or the first only, for a recording's frame), saved where `out=` says, and Godot's line for each.
 */
export function capturing(cameras: readonly string[]) {
  return async (call: GodotCall) => {
    const prefix = playArg(call, "out");
    const lines: string[] = [];
    for (const shot of playArg(call, "shots").split(";").filter(Boolean)) {
      const [frame = "0", mode = "all"] = shot.split(":");
      const shooting = mode === "first" ? cameras.slice(0, 1) : cameras;
      for (const [index, camera] of shooting.entries()) {
        const file = `${prefix}-${frame}-${index}.png`;
        await writeFile(file, PNG_BYTES);
        lines.push(`GENEX_SHOT ${camera} ${frame} ${file}`);
      }
    }
    return [...lines, `GENEX_PLAYED ${playArg(call, "frames")}`].join("\n");
  };
}

/** A runner that records each job and answers from `answers`; `ended` marks every answer timed out. */
export function recordingRunner(answers: JobAnswers = {}, ended: Partial<GodotResult> = {}) {
  const jobs: RanJob[] = [];
  const run: GodotRunner = async (binary, call) => {
    jobs.push({ binary, call });
    const answer = answers[call.job];
    const output = typeof answer === "function" ? await answer(call) : (answer ?? "");
    return { output, timedOut: false, cancelled: false, ...ended };
  };
  return { run, jobs };
}

/** A Godot app on the fake Mac: its folder, its binary (an empty file) and the version it answers. */
async function placeApp(folder: string, name: string) {
  const binary = path.join(folder, name, "Contents", "MacOS", "Godot");
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, "");
  return realpath(binary);
}

/** Apps to place: where (`applications`, `home-applications`, `downloads`) and the version each answers. */
export type FakeApp = {
  where: "applications" | "home-applications" | "downloads";
  name: string;
  version: string | null;
};

/** A fake Mac with the apps named; `pathDirs` and `binaries` the test may add to. */
export async function fakeMac(
  apps: readonly FakeApp[] = [{ where: "applications", name: "Godot.app", version: GODOT_461 }],
) {
  const root = await realpath(await tmpDir("studio-godot-"));
  const home = path.join(root, "home");
  const applications = path.join(root, "Applications");
  const folders = {
    applications,
    "home-applications": path.join(home, "Applications"),
    downloads: path.join(home, "Downloads"),
  };
  const versions = new Map<string, string | null>();
  for (const app of apps) versions.set(await placeApp(folders[app.where], app.name), app.version);
  const env: GodotEnv = {
    platform: "darwin",
    home,
    pathDirs: [],
    applications,
    binaries: [],
    version: async (binary) => versions.get(binary) ?? null,
    userTemp: async () => path.join(root, "user-temp"),
  };
  return { root, home, env, versions };
}

/** An editor that records what it opens and answers the process list it is given. */
export function recordingEditor(lines: string[] = []) {
  const opened: Launch[] = [];
  const clock = { at: Date.UTC(2026, 9, 14, 12) };
  let standIn: (() => Promise<void>) | null = null;
  const editor: EditorEnv = {
    open: async (launch) => {
      opened.push(launch);
    },
    commandLines: async () => lines,
    now: () => clock.at,
    sleep: async (ms) => {
      clock.at += ms;
      await standIn?.();
    },
  };
  /** The editor plugin's turn each time the backend waits: it answers what was asked meanwhile. */
  const answerWith = (turn: () => Promise<void>) => {
    standIn = turn;
  };
  return { editor, opened, lines, clock, answerWith };
}

/**
 * The Genex addon's editor plugin in `project`, as a test plays it on the fixture's clock: a
 * heartbeat now (`beat` writes another), and each ask answered by `answer` (null leaves it
 * unanswered), the ops asked kept in order.
 */
export async function editorStandIn(
  recorded: ReturnType<typeof recordingEditor>,
  project: string,
  answer: (op: string) => object | null,
) {
  const folder = path.join(project, BRIDGE_FOLDER);
  await mkdir(folder, { recursive: true });
  const asked: string[] = [];
  const beat = (fields: object = {}) =>
    writeFile(
      path.join(folder, "editor.json"),
      JSON.stringify({ at: recorded.clock.at, playing: false, unsavedScripts: 0, ...fields }),
    );
  await beat();
  recorded.answerWith(async () => {
    for (const name of await readdir(folder)) {
      const id = /^ask-([0-9a-f]+)\.json$/.exec(name)?.[1];
      if (!id) continue;
      const { op } = JSON.parse(await readFile(path.join(folder, name), "utf8"));
      await rm(path.join(folder, name));
      asked.push(op);
      const said = answer(op);
      if (said) await writeFile(path.join(folder, `answer-${id}.json`), JSON.stringify(said));
    }
  });
  return { folder, asked, beat };
}

/** A host call made by the backend: its method and arguments. */
export type HostCall = { method: string; args: unknown };

/**
 * The backend on a fake Mac in an open game (`valley`, its folder `game/`), or outside any game
 * with `game: null`; the host keeps storage in `storage/` and makes a game `made/` when asked.
 */
export async function godotBackendFixture(
  options: {
    apps?: FakeApp[];
    answers?: JobAnswers;
    game?: string | null;
    editorLines?: string[];
    install?: GodotInstallDeps;
  } = {},
) {
  const mac = await fakeMac(options.apps);
  const storage = path.join(mac.root, "storage");
  const gameDir = path.join(mac.root, "game");
  const made = path.join(mac.root, "made");
  await mkdir(storage, { recursive: true });
  await mkdir(gameDir, { recursive: true });
  const runner = recordingRunner(options.answers);
  const recorded = recordingEditor(options.editorLines);
  const backend = createGodotBackend({
    env: mac.env,
    editor: recorded.editor,
    run: runner.run,
    scripts: SCRIPTS,
    templates: TEMPLATES,
    addon: ADDON,
    ...(options.install ? { install: options.install } : {}),
  });
  const hostCalls: HostCall[] = [];
  /** The game's engine link as the host keeps it (`game.engine.link` / `game.engine.read`). */
  let link: { kind: string; project: string; name: string; linkedAt: string } | null = null;
  const host = (async (method: string, args?: unknown) => {
    hostCalls.push({ method, args });
    if (method === "storage.root") return storage;
    if (method === "game.engine.read") return link;
    if (method === "game.engine.steps") return true;
    if (method === "game.engine.link") {
      const project = typeof args === "object" && args !== null && "project" in args ? String(args.project) : "";
      link = { kind: "godot", project, name: path.basename(path.dirname(project)), linkedAt: "2026-10-15T00:00:00Z" };
      return link;
    }
    if (method === "game.create") {
      await mkdir(made, { recursive: true });
      return { project: "made-game", directory: made };
    }
    throw new Error(`unexpected host call ${method}`);
  }) as PluginContext["host"];
  const inGame = options.game !== null;
  const context = (more: Partial<PluginContext> = {}): PluginContext => ({
    ...(inGame ? { project: options.game ?? "valley", directory: gameDir } : {}),
    signal: new AbortController().signal,
    callId: 1,
    host,
    ...more,
  });
  return { ...mac, storage, gameDir, made, backend, runner, jobs: runner.jobs, editor: recorded, hostCalls, context };
}
