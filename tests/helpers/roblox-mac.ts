/**
 * A fake Mac for the Roblox Studio plugin's backend whose home, storage and game folders are real
 * temporary folders: Studio's app is a stand-in (installed or not), whether it runs and answers is
 * the test's to set, StudioMCP lists the Studios the test opens, and Studio's recent places come
 * from a stand-in `defaults`. `hostFor` is Genex's side of a plugin call in one game: it keeps links
 * as the host does (the record in the plugin's storage and the mirror in the game's studio.json),
 * makes games, takes snapshots and answers Do it for me as the test says.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PluginContext, PluginEngineAssistAnswer } from "../../src/plugin-sdk/index.d.ts";
import type { RobloxDeps } from "../../src/plugins/roblox/backend.ts";
import { systemCheckRun } from "../../src/plugins/roblox/check-scripts.ts";
import type { StudioClient, StudioToolResult } from "../../src/plugins/roblox/studio-client.ts";
import type { Launch } from "../../src/plugins/roblox/studio-launch.ts";
import { type LocateStat, STUDIO_MAC_APP, systemLocateFs } from "../../src/plugins/roblox/studio-locate.ts";
import { shippedHelper } from "./roblox-helper.ts";
import { tmpDir } from "./tmp.ts";

const SHIPPED_HELPER = await shippedHelper();
const CONTENTS = `${STUDIO_MAC_APP}/Contents`;
const STUDIO_FILES = [`${CONTENTS}/MacOS/RobloxStudio`, `${CONTENTS}/MacOS/StudioMCP`, `${CONTENTS}/Info.plist`];

/** An open Studio as StudioMCP lists it, and what its place says of itself. */
export interface OpenStudio {
  id: string;
  name: string;
  placeId?: string;
  universeId?: string;
}

/** What the fake Mac starts as: by default Studio is installed, set up and running. */
export interface RobloxMacOptions {
  installed?: boolean;
  /** Genex's setup record is in the plugin's storage. */
  setUp?: boolean;
  running?: boolean;
  /** Studio answers Genex while it runs (by default whenever it runs). */
  answering?: boolean;
  studios?: OpenStudio[];
  recents?: string[];
  /** Genex can click in Studio here (computer control); true unless said otherwise. */
  canClick?: boolean;
}

/** A Mac with Roblox Studio, whose home, storage and games are real folders. */
export async function robloxMac(options: RobloxMacOptions = {}) {
  // By real path, as linked places come back (macOS: /var is a link to /private/var).
  const root = await realpath(await tmpDir("roblox-places-"));
  const home = path.join(root, "home");
  const storage = path.join(root, "storage");
  const games = path.join(root, "games");
  for (const dir of [home, storage, games]) await mkdir(dir, { recursive: true });
  if (options.setUp ?? true) {
    await mkdir(path.join(storage, "setup"));
    await writeFile(path.join(storage, "setup", "record.json"), "{}");
  }
  const state = {
    installed: options.installed ?? true,
    running: options.running ?? true,
    answering: options.answering,
    studios: options.studios ?? [],
    recents: options.recents ?? [],
  };
  const touched: string[] = [];
  const ran: string[] = [];
  const launches: Launch[] = [];
  let clock = 1_000_000;
  const appDirs = new Set(["/Applications", STUDIO_MAC_APP]);
  const fakeStat = (file: string): LocateStat | undefined => {
    if (file === "/Applications") return { file: false, directory: true, link: false, mtimeMs: 0 };
    if (!state.installed) return undefined;
    if (appDirs.has(file)) return { file: false, directory: true, link: false, mtimeMs: 0 };
    if (STUDIO_FILES.includes(file)) return { file: true, directory: false, link: false, mtimeMs: 0 };
    return undefined;
  };
  const isApp = (file: string) => appDirs.has(file) || STUDIO_FILES.includes(file);
  const recentsXml = () =>
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<plist><dict>",
      "<key>LoggedInUsersStore</key><string>not read</string>",
      ...state.recents.flatMap((file, at) => [
        `<key>9172881962rbxRecentFiles_v03.${at}name</key>`,
        `<string>${file.replaceAll("&", "&amp;")}</string>`,
      ]),
      "</dict></plist>",
    ].join("\n");
  const studio: Pick<StudioClient, "studios" | "callTool"> = {
    studios: async () => state.studios.map(({ id, name }) => ({ id, name })),
    callTool: async (name, args): Promise<StudioToolResult> => {
      const open = state.studios.find((entry) => entry.id === args.studio_id);
      if (name !== "execute_luau" || !open)
        return { content: [{ type: "text", text: "no such Studio" }], isError: true };
      const text = `genex-place ${open.placeId ?? "0"} ${open.universeId ?? "0"} ${open.name}`;
      return { content: [{ type: "text", text }] };
    },
  };
  const deps: RobloxDeps = {
    platform: "darwin",
    env: { HOME: home },
    home,
    run: async (file, args) => {
      ran.push(file);
      if (file === "/usr/bin/plutil") return { code: 0, stdout: "0.743.0.7431133\n" };
      if (file === "/usr/bin/pgrep") return state.running ? { code: 0, stdout: "8620\n" } : { code: 1, stdout: "" };
      if (file === "/usr/bin/defaults" && args[0] === "export") return { code: 0, stdout: recentsXml() };
      if (file === "/usr/bin/osascript") return { code: 0, stdout: "" };
      throw new Error(`spawn ${file} ENOENT`);
    },
    fs: {
      async lstat(file) {
        touched.push(file);
        return isApp(file) ? fakeStat(file) : systemLocateFs.lstat(file);
      },
      async realpath(file) {
        touched.push(file);
        return isApp(file) ? file : systemLocateFs.realpath(file);
      },
      async readdir(dir) {
        touched.push(dir);
        return systemLocateFs.readdir(dir);
      },
    },
    answers: async () => state.answering ?? state.running,
    canClick: () => options.canClick ?? true,
    studio,
    helper: SHIPPED_HELPER,
    install: {
      fetch: (async () => {
        throw new TypeError("no network in this test");
      }) as typeof fetch,
      run: async (file) => {
        throw new Error(`spawn ${file} ENOENT`);
      },
      tempRoot: path.join(root, "temp"),
    },
    // The Luau checks as on an Apple silicon Mac whatever runs the test, with no network.
    luau: {
      arch: "arm64",
      run: systemCheckRun,
      fetch: (async () => {
        throw new TypeError("no network in this test");
      }) as typeof fetch,
      unpack: async (file) => {
        throw new Error(`spawn ${file} ENOENT`);
      },
    },
    open: async (launch) => {
      launches.push(launch);
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return {
    deps,
    home,
    storage,
    games,
    state,
    touched,
    ran,
    launches,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

export type Mac = Awaited<ReturnType<typeof robloxMac>>;

/** A Genex game the host keeps: its name, title and folder. */
export interface Game {
  project: string;
  title: string;
  directory: string;
}

/** Makes a Genex game folder titled `title`. */
export async function makeGame(mac: Mac, project: string, title: string): Promise<Game> {
  const directory = path.join(mac.games, project);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "studio.json"), `${JSON.stringify({ title })}\n`);
  return { project, title, directory };
}

/** What the host was asked, by method, in order. */
export type HostCall = { method: string; args: Record<string, unknown> };

/**
 * A plugin call's context in `game` (or none), over a host that keeps links as Genex does: the
 * record in the plugin's storage (`links/<game>.json`) and the mirror in the game's studio.json.
 */
export function hostFor(
  mac: Mac,
  game: Game | undefined,
  options: { runs?: unknown[]; assist?: (args: unknown) => PluginEngineAssistAnswer } = {},
) {
  const calls: HostCall[] = [];
  const made: Game[] = [];
  const linkIn = async (target: Game, args: Record<string, unknown>) => {
    const project = await systemLocateFs.realpath(String(args.project));
    const link = {
      kind: "roblox",
      project,
      linkedAt: new Date(0).toISOString(),
      ...(args.remote ? { remote: args.remote } : {}),
    };
    await mkdir(path.join(mac.storage, "links"), { recursive: true });
    await writeFile(path.join(mac.storage, "links", `${target.project}.json`), JSON.stringify(link));
    const meta = JSON.parse(await readFile(path.join(target.directory, "studio.json"), "utf8"));
    await writeFile(path.join(target.directory, "studio.json"), JSON.stringify({ ...meta, engine: link }));
    return { ...link, name: path.basename(project).replace(/\.(rbxlx?|project\.json)$/, "") };
  };
  const readLink = async (target: Game) => {
    const record = await readFile(path.join(mac.storage, "links", `${target.project}.json`), "utf8").catch(() => "");
    if (!record) return null;
    const link = JSON.parse(record);
    return existsSync(link.project) ? link : null;
  };
  const host = (async (method: string, args: Record<string, unknown> = {}) => {
    calls.push({ method, args });
    if (method === "storage.root") return mac.storage;
    if (method === "game.snapshot") return { snapshotId: "snap-1" };
    if (method === "game.engine.steps") return Boolean(game);
    if (method === "game.engine.runs") return options.runs ?? [];
    if (method === "game.engine.assist")
      return (options.assist ?? (() => ({ started: false, reason: "unavailable" })))(args);
    if (method === "game.create") {
      const created = await makeGame(mac, `made-${made.length + 1}`, String(args.title));
      made.push(created);
      return { project: created.project, directory: created.directory };
    }
    if (method === "game.engine.link") {
      const target = typeof args.game === "string" ? made.find((g) => g.project === args.game) : game;
      if (!target) throw new Error("Project required");
      return linkIn(target, args);
    }
    if (method === "game.engine.read") {
      if (!game) throw new Error("Project required");
      return readLink(game);
    }
    throw new Error(`No ${method} here`);
  }) as PluginContext["host"];
  const context: PluginContext = {
    signal: new AbortController().signal,
    callId: 1,
    host,
    ...(game ? { project: game.project, directory: game.directory } : {}),
  };
  return { context, calls, made, methods: () => calls.map((call) => call.method) };
}
