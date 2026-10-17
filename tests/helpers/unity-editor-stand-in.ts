import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PluginContext } from "../../src/plugin-sdk/index.d.ts";
import type { EditorsEnv, UnityEditor } from "../../src/plugins/unity/editors.ts";
import type { PipelineDeps } from "../../src/plugins/unity/pipeline.ts";
import type { ProcessEnv, ProcessRow } from "../../src/plugins/unity/processes.ts";
import { tmpDir } from "./tmp.ts";

/** The port, token and process the stand-in editor's descriptor names unless a test writes its own. */
export const STAND_IN = { pid: 4242, port: 7811, token: "tok-3f9a" } as const;

/** One request the stand-in editor received. */
export type Seen = { url: string; method: string; token: string | null; body: unknown; redirect?: RequestRedirect };
/** What the stand-in answers a request with: a response, a thrown error, or either made on the spot. */
export type Reply = Response | Error | ((seen: Seen) => Response | Error | Promise<Response | Error>);

/** A JSON answer of the editor's server. */
export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
/** The error Node's fetch throws when nothing listens on the port: the request never left. */
export const refusedConnection = () =>
  Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
/** The error Node's fetch throws when the connection drops after the request was sent. */
export const droppedConnection = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });

/** Writes the descriptor Unity's Pipeline package keeps while a project is open in an editor. */
export async function writeDescriptor(
  root: string,
  descriptor: unknown = { pid: STAND_IN.pid, port: STAND_IN.port, evalToken: STAND_IN.token },
): Promise<void> {
  await mkdir(path.join(root, "Library", "Pipeline"), { recursive: true });
  const text = typeof descriptor === "string" ? descriptor : JSON.stringify(descriptor);
  await writeFile(path.join(root, "Library", "Pipeline", ".unity-pipeline-port"), text);
}

/** A Unity project folder by its real path, with the files that make it one. */
export async function unityProject(prefix = "unity-project-"): Promise<string> {
  const root = await realpath(await tmpDir(prefix));
  await mkdir(path.join(root, "ProjectSettings"), { recursive: true });
  await writeFile(path.join(root, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.6.0f1\n");
  return root;
}

/** A Unity project open in an editor: its descriptor is on disk. */
export async function openProject(): Promise<string> {
  const root = await unityProject();
  await writeDescriptor(root);
  return root;
}

/**
 * A stand-in for an editor's Pipeline server: it answers each request with the next reply and
 * records what it was asked, on a clock only `sleep` moves. `alive: false` is an editor that is
 * gone while its descriptor is still on disk; a function says it per process.
 */
export function editor(replies: Reply[], { alive = true }: { alive?: boolean | ((pid: number) => boolean) } = {}) {
  const seen: Seen[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const deps: PipelineDeps = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request: Seen = {
        url: String(input),
        method: init?.method ?? "GET",
        token: new Headers(init?.headers).get("authorization"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        ...(init?.redirect ? { redirect: init.redirect } : {}),
      };
      seen.push(request);
      const next = replies.shift();
      if (!next) throw new Error(`unexpected request ${request.method} ${request.url}`);
      const reply = typeof next === "function" ? await next(request) : next;
      if (reply instanceof Error) throw reply;
      return reply;
    }) as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    alive: (pid) => (typeof alive === "function" ? alive(pid) : alive),
    timeout: () => new AbortController().signal,
  };
  return { deps, seen, sleeps };
}

/** A Mac's folders in a temporary place: a home holding Hub's records folder, and its Applications. */
export async function macEnv(): Promise<EditorsEnv> {
  const base = await realpath(await tmpDir("unity-mac-"));
  const home = path.join(base, "home");
  await mkdir(path.join(home, "Library", "Application Support", "UnityHub"), { recursive: true });
  await mkdir(path.join(base, "Applications"), { recursive: true });
  return {
    platform: "darwin",
    home,
    applications: path.join(base, "Applications"),
    appData: path.join(home, "AppData"),
  };
}

/**
 * An installed editor as Hub lays one out in `folder`, shipping the packages named (`null`: a
 * built-in module, which names no version of its own).
 */
export async function fakeEditor(
  folder: string,
  version: string,
  packages: Record<string, string | null> = {},
): Promise<UnityEditor> {
  const app = path.join(folder, version, "Unity.app");
  const builtIn = path.join(app, "Contents", "Resources", "PackageManager", "BuiltInPackages");
  await mkdir(builtIn, { recursive: true });
  for (const [name, packageVersion] of Object.entries(packages)) {
    await mkdir(path.join(builtIn, name));
    if (packageVersion)
      await writeFile(path.join(builtIn, name, "package.json"), JSON.stringify({ name, version: packageVersion }));
  }
  return { version, app };
}

/**
 * A call's binding as the host hands it to the plugin's backend: the game and its folder (or
 * whatever a test binds), with a host that answers the plugin's storage and nothing else.
 */
export function pluginContext(storage: string, binding: Partial<PluginContext> = {}): PluginContext {
  return {
    ...binding,
    signal: binding.signal ?? new AbortController().signal,
    callId: 1,
    host: (async (method: string) => {
      if (method !== "storage.root") throw new Error(`unexpected host call ${method}`);
      return storage;
    }) as PluginContext["host"],
  };
}

/** A Mac editor's program, as `ps` names it. */
export const EDITOR_PROGRAM = "/Applications/Unity/Hub/Editor/6000.3.10f1/Unity.app/Contents/MacOS/Unity";

/** One process as `ps` lists it. */
export const processRow = (pid: number, exec: string, args: string): ProcessRow => ({
  pid,
  exec,
  args: `${exec} ${args}`.trim(),
});

/** An editor process that has the project at `root` open. */
export const editorRow = (pid: number, root: string): ProcessRow =>
  processRow(pid, EDITOR_PROGRAM, `-projectPath ${root}`);

/**
 * A process table a test fills: `signal` records what was sent, and a process ends on the signals
 * `ends` names for it (on SIGTERM unless said); `end` takes one away as its own exit would.
 */
export function processTable(rows: ProcessRow[] = [], ends: Record<number, NodeJS.Signals[]> = {}) {
  let running = [...rows];
  const sent: Array<[number, NodeJS.Signals]> = [];
  const slept: number[] = [];
  const env: ProcessEnv = {
    list: async () => running,
    signal: (pid, signal) => {
      if (!running.some((row) => row.pid === pid)) throw new Error("ESRCH");
      sent.push([pid, signal]);
      if ((ends[pid] ?? ["SIGTERM"]).includes(signal)) running = running.filter((row) => row.pid !== pid);
    },
    sleep: async (ms) => {
      slept.push(ms);
    },
  };
  return {
    env,
    sent,
    slept,
    running: () => running.map((row) => row.pid),
    start: (row: ProcessRow) => {
      running = [...running, row];
    },
    end: (pid: number) => {
      running = running.filter((row) => row.pid !== pid);
    },
  };
}
