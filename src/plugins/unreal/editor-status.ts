/**
 * Where the user's Unreal stands for Genex, in one word for the Unreal toolbar button's dot and
 * the panel: Set up, Not open, Starting or Ready, Add for an open game that isn't made in Unreal,
 * and Not installed while no Unreal Genex works with is installed.
 * Ready needs both the project's own port answering as Epic's server and an editor process
 * running. The toolbar asks every so often, so its status is cheap: the plugin's own records, one
 * check that the editor process runs, and one MCP handshake on the project's own port; no folder
 * scans, no project files read. An editor whose own log says Epic's server couldn't listen on the
 * project's port will never answer, so it is never Starting, and a wait for it ends at once.
 */
import { lstat } from "node:fs/promises";
import path from "node:path";
import type { PluginToolbarStatus } from "../../plugin-sdk/index.d.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { t } from "../../shared/i18n.ts";
import { justLaunched, readStarting, retireStarting, type Starting, stillStarting } from "./editor-launch.ts";
import { PortBlockedError } from "./editor-log.ts";
import { chosenProject, linkedProject, listSetUpProjects, type SetUpProject, wantsUnreal } from "./editor-port.ts";
import { projectName } from "./project-file.ts";
import { findEngines, installEngineVersion, type SetupEnv } from "./setup.ts";

/** Where the chosen project stands: not set up, set up but not open, starting, or answering. */
export const Connection = { SetUp: "set-up", NotOpen: "not-open", Starting: "starting", Ready: "ready" } as const;
export type Connection = (typeof Connection)[keyof typeof Connection];

/** Where a set-up project's editor that doesn't answer stands for a call that could wait for it. */
export const EditorStart = { Starting: "starting", PortBlocked: "port-blocked", NotStarting: "not-starting" } as const;
export type EditorStart = (typeof EditorStart)[keyof typeof EditorStart];

/** What reading a project's start needs from the computer: whether an editor runs, and the project's own log. */
export type StartEnv = Pick<SetupEnv, "editorRunning" | "editorLog">;

/** What decides the connection: setup, Unreal's answer, its process, and Genex's own launch. */
export type ConnectionFacts = {
  setUp: boolean;
  answering: boolean;
  running: boolean;
  /** When Genex opened this project, if it did. */
  starting: Starting | undefined;
  /** When this project's editor opened, by its own log, while it is still loading (opened outside Genex too). */
  loading?: Starting;
  /** This project's open log says the editor finished loading, so a silent editor is no longer starting. */
  loaded?: boolean;
  /** This project's open log says Epic's server couldn't listen on its port, so it will never answer. */
  portBlocked?: boolean;
  /** This project's own log is open, so Unreal has this very project open; unknown while unread. */
  open?: boolean;
  now: number;
};

/**
 * What the project's own log says while its editor runs: since when it loads, or that it has
 * loaded, whether Epic's server couldn't listen on the project's port, and whether the log is
 * still open, so Unreal has this very project open (yes when there is no log to read).
 */
/** What a project's own log says while an editor runs; `openUnsure` when nothing could tell whether an editor holds it. */
export type LogFacts = {
  loading: Starting | undefined;
  loaded: boolean;
  portBlocked: boolean;
  open: boolean;
  openUnsure: boolean;
};

/** A set-up project's own log, read for its own port: its `.uproject`, its folder and its port. */
const ownLog = (project: { project: string; port: number }) => ({
  file: project.project,
  directory: path.dirname(project.project),
  port: project.port,
});

/** A Genex launch and a log opened this close together are the same start. */
const SAME_START_MS = MINUTE_MS;

/** A loading editor can go about a minute without a log line; a log quiet this long is not loading. */
const LOG_FRESH_MS = 3 * MINUTE_MS;

const SECONDS_PER_MINUTE = 60;

/** The toolbar button's tooltip, in the person's words. */
const MESSAGE = {
  SetUpAny: () => t("Set up an Unreal project for Genex."),
  SetUp: (name: string) => t("Set up {name} for Genex.", { name }),
  NotOpen: (name: string) => t("{name} isn't open in Unreal.", { name }),
  NotAnswering: (name: string) => t("Unreal is open, but {name} isn't answering.", { name }),
  PortBlocked: (name: string) =>
    t("Unreal couldn't use the port Genex gave {name}. Quit Unreal and open it again from the Unreal button.", {
      name,
    }),
  Starting: (name: string, elapsed: string) => t("Opening {name} in Unreal… {elapsed}", { name, elapsed }),
  Ready: (name: string) => t("Connected to {name}.", { name }),
  AddToGame: () => t("Make this game in Unreal"),
  GetUnreal: (version: string) => t("Get Unreal Engine {version} to make games in Unreal.", { version }),
} as const;

/** The Unreal button's grey: the toolbar draws `info` in the muted ink. */
const MUTED = "info" as const satisfies PluginToolbarStatus["tone"];

/**
 * The toolbar's badge for each connection, drawn as a dot: green once Ready, amber while Starting,
 * grey otherwise. Its word, where the project stands as a state and never a verb, is the tooltip's
 * first line.
 */
const BADGE = {
  [Connection.SetUp]: { badge: () => t("Not set up"), tone: MUTED },
  [Connection.NotOpen]: { badge: () => t("Not open"), tone: MUTED },
  [Connection.Starting]: { badge: () => t("Starting"), tone: "warn" },
  [Connection.Ready]: { badge: () => t("Ready"), tone: "ok" },
} as const satisfies Record<Connection, { badge: () => string; tone: PluginToolbarStatus["tone"] }>;

/** A connection's badge as the toolbar draws it: its word and tone, with a dot. */
function badgeOf(connection: Connection): PluginToolbarStatus {
  const { badge, tone } = BADGE[connection];
  return { badge: badge(), tone, dot: true };
}

/** What an open game with no Unreal project says: no dot on every web game, only that the button can start one. */
const addStatus = (): PluginToolbarStatus => ({ tone: MUTED, title: MESSAGE.AddToGame() });

/** What the button says while no Unreal Genex works with is installed: the panel shows how to get it. */
const getStatus = (): PluginToolbarStatus => ({
  badge: t("Not installed"),
  tone: MUTED,
  dot: true,
  title: MESSAGE.GetUnreal(installEngineVersion()),
});

/**
 * Where a project stands, from what is known about it. An answer on its port counts only while an
 * editor process runs: without one, whatever answers there is not this project's editor. A project
 * that is still starting reads as Starting whether or not it is set up, so the panel never offers
 * to quit an editor that is loading.
 */
export function connectionOf(facts: ConnectionFacts): Connection {
  if (facts.setUp && facts.answering && facts.running) return Connection.Ready;
  if (startingSince(facts)) return Connection.Starting;
  return facts.setUp ? Connection.NotOpen : Connection.SetUp;
}

/**
 * Since when the project is starting: never once its own log says Epic's server couldn't listen on
 * its port; Genex's own launch for its first seconds; never once the project's own log says it
 * loaded; Genex's launch while its log loads from that same start, or while the starting window
 * lasts; else the log while it loads (opened outside Genex).
 */
export function startingSince(facts: ConnectionFacts): Starting | undefined {
  if (facts.portBlocked) return undefined;
  const own = facts.starting;
  if (justLaunched(own, facts.now)) return own;
  if (facts.loaded) return undefined;
  const sameStart = own && facts.loading && Math.abs(facts.loading.at - own.at) < SAME_START_MS;
  if (sameStart || stillStarting(own, facts.running, facts.now)) return own;
  return facts.loading;
}

/**
 * The project's own editor loading, read from its log for its own port: since when it loads while
 * that log is open, names this project, hasn't said it loaded and changed lately; or that it has
 * loaded; and whether Epic's server couldn't listen on the port. Read only while an editor runs
 * and the project doesn't answer, so a status stays cheap otherwise.
 */
export async function loadingOf(
  env: Pick<SetupEnv, "editorLog">,
  project: { file: string; directory: string; port: number | null },
  now: number,
): Promise<LogFacts> {
  const log = await env.editorLog?.({
    file: project.file,
    directory: project.directory,
    port: project.port ?? undefined,
  });
  if (!log?.open) {
    const unknown = !env.editorLog;
    return { loading: undefined, loaded: false, portBlocked: false, open: unknown, openUnsure: unknown };
  }
  const portBlocked = log.portBlocked === true;
  const openUnsure = log.openUnsure === true;
  if (log.loaded) return { loading: undefined, loaded: true, portBlocked, open: true, openUnsure };
  const quiet = now - log.mtime;
  const fresh = quiet > -LOG_FRESH_MS && quiet < LOG_FRESH_MS;
  const loading = fresh ? { project: project.file, at: log.openedAt } : undefined;
  return { loading, loaded: false, portBlocked, open: true, openUnsure };
}

/**
 * Whether a set-up project's editor answers on its own port. When it doesn't and its own open log
 * says Epic's server couldn't listen on that port, it never will: this throws
 * {@link PortBlockedError}, so a wait for it ends at once instead of running out.
 */
export async function answersOrBlocked(env: SetupEnv, project: { project: string; port: number }): Promise<boolean> {
  if (await env.editorAnswers(project.port, project.project)) return true;
  const log = await env.editorLog?.(ownLog(project));
  if (log?.open && log.portBlocked) throw new PortBlockedError(project.port);
  return false;
}

/**
 * Where a set-up project's editor that doesn't answer stands: Starting by the toolbar's own rule
 * ({@link startingSince}: Genex's launch record in `storage`, a running editor and the project's
 * own log); PortBlocked once an editor runs and that open log says Epic's server couldn't listen
 * on the project's port, so it never will; else NotStarting. Only reads.
 */
export async function editorStart(
  env: StartEnv,
  storage: string,
  project: { project: string; port: number },
  now: number,
): Promise<EditorStart> {
  const [record, running] = await Promise.all([readStarting(storage), env.editorRunning()]);
  const log = running ? await loadingOf(env, ownLog(project), now) : undefined;
  const facts = { setUp: true, answering: false, running, starting: startingOf(record, project.project), ...log, now };
  if (facts.portBlocked) return EditorStart.PortBlocked;
  return startingSince(facts) ? EditorStart.Starting : EditorStart.NotStarting;
}

/** Time since a launch as the panel's timer shows it: minutes and two-digit seconds. */
export function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / SECOND_MS));
  return `${Math.floor(seconds / SECONDS_PER_MINUTE)}:${String(seconds % SECONDS_PER_MINUTE).padStart(2, "0")}`;
}

/**
 * The words for a set-up project in each state but Set up: an editor that runs without it answering
 * has it open but silent, unless its own log says Unreal has another project open instead.
 */
function titleOf(connection: Connection, project: SetUpProject, facts: ConnectionFacts): string {
  const { name } = project;
  if (connection === Connection.Ready) return MESSAGE.Ready(name);
  if (facts.running && facts.portBlocked) return MESSAGE.PortBlocked(name);
  const since = startingSince(facts);
  if (connection === Connection.Starting && since) return MESSAGE.Starting(name, elapsedText(facts.now - since.at));
  const silent = facts.running && facts.open !== false;
  return silent ? MESSAGE.NotAnswering(name) : MESSAGE.NotOpen(name);
}

/** What the button reports on: a set-up project's state, or the status to show when there is none. */
type Subject = { project: SetUpProject } | { status: PluginToolbarStatus };

/**
 * The project the open game is linked to, while its `.uproject` is still a plain file there (not a
 * link to one, not a folder, not gone); undefined for a game that builds on the web. The host's
 * record is read without following links.
 */
async function gameProject(storage: string, game: string): Promise<string | undefined> {
  const file = await linkedProject(storage, game);
  const info = file ? await lstat(file).catch(() => null) : null;
  return info?.isFile() ? file : undefined;
}

/** The status of a project that isn't set up, in words that name it. */
const needsSetUp = (title: string): PluginToolbarStatus => ({ ...badgeOf(Connection.SetUp), title });

/** With no game open: the project chosen in the panel (else the first set-up one). */
async function panelSubject(storage: string): Promise<Subject> {
  const chosen = await chosenProject(storage);
  const setUp = await listSetUpProjects(storage);
  const project = chosen ? setUp.find((p) => p.project === chosen) : setUp[0];
  if (project) return { project };
  return { status: needsSetUp(chosen ? MESSAGE.SetUp(projectName(chosen)) : MESSAGE.SetUpAny()) };
}

/** With a game open: its own project, whatever another game or the panel chose; Add without one. */
async function gameSubject(storage: string, game: string): Promise<Subject> {
  const linked = await gameProject(storage, game);
  if (!linked) return { status: addStatus() };
  const project = (await listSetUpProjects(storage)).find((p) => p.project === linked);
  return project ? { project } : { status: needsSetUp(MESSAGE.SetUp(projectName(linked))) };
}

/**
 * The Unreal toolbar button's status, `shown` on a game whose chat chose Unreal before its project
 * could be made (the button is scoped to Unreal projects, which a linked game has). Not installed while
 * no Unreal Genex works with is installed. Otherwise, with a game open it is that game's: Add while
 * the game has no Unreal project, else its own project's state, named. With no game open it is the
 * project chosen in the panel (else the first set-up one). Only a port from Genex's own setup
 * records is ever asked. The one write is removing this project's own Starting record once it answers.
 */
export async function toolbarStatus(
  env: SetupEnv,
  storage: string,
  now: number,
  game?: string,
): Promise<PluginToolbarStatus> {
  const [status, wanted] = await Promise.all([gameStatus(env, storage, now, game), wantsUnreal(storage, game)]);
  return wanted ? { ...status, shown: true } : status;
}

/** The button's status before the strip's `shown`: see {@link toolbarStatus}. */
async function gameStatus(env: SetupEnv, storage: string, now: number, game?: string): Promise<PluginToolbarStatus> {
  // Epic's list of installed engines is one small file: cheap enough for every toolbar ask.
  if (!(await findEngines(env)).some((engine) => engine.supported)) return getStatus();
  const subject = game ? await gameSubject(storage, game) : await panelSubject(storage);
  if ("status" in subject) return subject.status;
  const { project } = subject;
  const [answering, running, starting] = await Promise.all([
    env.editorAnswers(project.port, project.project),
    env.editorRunning(),
    readStarting(storage),
  ]);
  if (answering) await retireStarting(storage, project.project);
  const log = running && !answering ? await loadingOf(env, ownLog(project), now) : undefined;
  const facts = { setUp: true, answering, running, starting: startingOf(starting, project.project), ...log, now };
  const connection = connectionOf(facts);
  return { ...badgeOf(connection), title: titleOf(connection, project, facts) };
}

/** The Starting record when it is this project's. */
export function startingOf(starting: Starting | undefined, project: string | undefined): Starting | undefined {
  return starting && starting.project === project ? starting : undefined;
}
