/**
 * What the plugin trust dialog says, built from the package alone (the folders turning it on lets it
 * write in among it), and what an action's approval shows under its question: pure, so the words
 * are tested without Electron.
 * `plugin-install-dialog.ts` and the plugins IPC show them.
 */
import {
  PluginCapability,
  PluginHostTool,
  type PluginInfo,
  type PluginManifest,
  type PluginManifestTool,
  type PluginMcpServer,
  type PluginScan,
  type PluginSkill,
  type PluginSkillChange,
  type PluginSource,
  PluginSourceKind,
  pluginSkillChange,
} from "../shared/plugins.ts";
import { HookEvent } from "../shared/plugin-hooks.ts";
import { startsEnabled } from "../substrate/plugins/registry.ts";
import { type PluginInstallReview, pluginOriginWords } from "./plugin-local-install.ts";

/** How many scan findings the dialog names. */
const SCAN_FINDINGS_NAMED = 6;

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The dialog's words; the names, versions and lists in them come from the package. */
const MESSAGE = {
  install: (name: string, version: string) => `Install ${name} ${version}?`,
  update: (name: string, version: string) => `Update ${name} to ${version}?`,
  replace: (old: string, name: string, version: string) => `Replace ${old} with ${name} ${version}?`,
  installButton: "Install",
  updateButton: "Update",
  replaceButton: "Replace and erase data",
  replaces: (name: string, publisher: string, origin: string) =>
    `This replaces ${name} by ${publisher} (from ${origin}). Its saved account, settings and data will be erased.`,
  source: (origin: string, publisher: string) => `From ${origin}\nPublisher: ${publisher}`,
  unsandboxed: "Its code runs on your computer like an app you install. It isn't sandboxed.",
  asks: "It asks to:",
  servers: (count: number) => `Starts ${plural(count, "program")} for agents:`,
  hostTools: (count: number) => `Genex runs ${plural(count, "tool")} for it:`,
  skills: (count: number, named: string) => `Adds ${plural(count, "skill")} for agents: ${named}.`,
  noSkills: "Adds no skills for agents.",
  removedSkills: (named: string) => ` Removes: ${named}.`,
  notScanned: "Not scanned.",
  scan: (verdict: string, found: string) => `Scan: ${verdict}, ${found}.`,
  noFindings: "no findings",
  finding: (rule: string, file: string, line: number) => `${rule} in ${file}:${line}`,
  genexCli: "the Genex CLI",
  given: (program: string, env: string) => `${program}, given ${env}`,
  withConsent: (does: string) => `${does}, asks you each time`,
  new: "new",
  changed: "changed",
  folders: (count: number) => `Turning it on lets its programs write in ${plural(count, "folder")} outside your games:`,
  localAccess: "It runs with your access: Genex doesn't sandbox its code.",
  startsOff: "It starts off: turn it on in Plugins; each of its tools asks you before it runs.",
  staysOn:
    "It is on and stays on: its new code runs as soon as it loads, and each of its tools asks you again before it runs.",
  steps: (when: string, steps: string) => `${when} at Genex's moments: ${steps}; those steps don't ask you first.`,
  runs: "It runs",
  runsOnceOn: "Once on, it runs",
} as const;

/** What each capability lets a plugin do, as a line under "It asks to:". */
const CAPABILITY_WORDS: ReadonlyMap<string, string> = new Map(
  Object.entries({
    [PluginCapability.Settings]: "keep its own settings",
    [PluginCapability.ProjectRead]: "read files in your games",
    [PluginCapability.ProjectWrite]: "change files in your games",
    [PluginCapability.Jobs]: "run long jobs and report their progress",
    [PluginCapability.Observe]: "load and capture your games as they run",
    [PluginCapability.Credentials]: "save a sign-in for its own account",
    [PluginCapability.ExternalAuth]: "open sign-in pages in your browser",
    [PluginCapability.Network]: "reach the internet",
    [PluginCapability.Export]: "export your games",
    [PluginCapability.NativeRuntime]: "install and run the apps it names, such as Blender",
    [PluginCapability.GameEngine]: "make games of its engine's kind and link them to its projects",
  } satisfies Record<PluginCapability, string>),
);

/** What each tool Genex runs itself does, as the dialog names it. */
const HOST_TOOL_WORDS = {
  [PluginHostTool.GenexCli]: "runs the Genex CLI",
  [PluginHostTool.GenexCliPaid]: "runs the Genex CLI",
  [PluginHostTool.GenexPackage]: "installs Genex packages in the game",
} as const satisfies Record<PluginHostTool, string>;

const bulleted = (heading: string, lines: string[]): string =>
  [heading, ...lines.map((line) => `• ${line}`)].join("\n");

/** A name with its marks in brackets, or the bare name when it has none. */
const marked = (name: string, marks: readonly string[]): string =>
  marks.length ? `${name} (${marks.join(", ")})` : name;

/** What it asks to do, each capability new since the installed version marked. */
function capabilityBlock(manifest: PluginManifest, before: PluginManifest | undefined): string | undefined {
  if (!manifest.capabilities.length) return undefined;
  const had = before ? new Set(before.capabilities) : null;
  const lines = manifest.capabilities.map((c) =>
    marked(CAPABILITY_WORDS.get(c) ?? c, had && !had.has(c) ? [MESSAGE.new] : []),
  );
  return bulleted(MESSAGE.asks, lines);
}

/**
 * A plugin's MCP servers are trusted by this dialog and by nothing else — there is no second
 * connector trust prompt for a server the host owns on the plugin's behalf. So the dialog has to
 * say that installing also means letting Genex start those programs, and name what each is given.
 */
function serverBlock(manifest: PluginManifest, previous: PluginManifest | undefined): string | undefined {
  const servers = manifest.mcpServers ?? [];
  if (!servers.length) return undefined;
  const before = previous ? new Map((previous.mcpServers ?? []).map((s) => [s.id, JSON.stringify(s)])) : null;
  const lines = servers.map((s) => `${marked(s.id, serverChange(before, s))} — ${serverLaunch(s)}`);
  return bulleted(MESSAGE.servers(servers.length), lines);
}

/**
 * A server that is new, or that now runs something else, somewhere else, or on a different
 * environment, is an expansion of exactly the kind a new capability is — so it is marked the
 * same way rather than arriving inside a dialog that reads like the last one. A first install
 * (no `before`) marks nothing.
 */
function serverChange(before: ReadonlyMap<string, string> | null, server: PluginMcpServer): string[] {
  if (!before) return [];
  const was = before.get(server.id);
  if (was === undefined) return [MESSAGE.new];
  return was !== JSON.stringify(server) ? [MESSAGE.changed] : [];
}

/** What a server runs, then the names of the environment it is given. */
function serverLaunch(server: PluginMcpServer): string {
  const program = server.command === "host-cli" ? MESSAGE.genexCli : (server.args[0] ?? "node");
  const env = Object.keys(server.env ?? {});
  return env.length ? MESSAGE.given(program, env.join(", ")) : program;
}

/** Tools Genex runs itself rather than the plugin's code, named with what each does. */
function hostToolBlock(manifest: PluginManifest, before: PluginManifest | undefined): string | undefined {
  const tools = manifest.tools.filter((t) => t.host);
  if (!tools.length) return undefined;
  const had = before ? new Set(before.tools.filter((t) => t.host).map((t) => t.name)) : null;
  const lines = tools.map((t) => `${marked(t.name, had && !had.has(t.name) ? [MESSAGE.new] : [])} — ${hostToolUse(t)}`);
  return bulleted(MESSAGE.hostTools(tools.length), lines);
}

function hostToolUse(tool: PluginManifestTool): string {
  const does = tool.host ? HOST_TOOL_WORDS[tool.host] : "";
  return tool.confirmation ? MESSAGE.withConsent(does) : does;
}

/**
 * Skills reach every agent's brief, so they are disclosed like the servers are: by name, and on an
 * update each new or changed one marked and each withdrawn one named. A skill is changed when its
 * manifest entry differs or, when both versions were scanned, the bytes of its files do.
 */
function skillBlock(facts: PluginInstallFacts): string | undefined {
  const { manifest, before } = facts;
  const change = before
    ? pluginSkillChange({ manifest: before, scan: facts.previousScan }, { manifest, scan: facts.scan })
    : undefined;
  const removed = change?.removed.length ? MESSAGE.removedSkills(change.removed.join(", ")) : "";
  if (!manifest.skills.length) return removed ? `${MESSAGE.noSkills}${removed}` : undefined;
  const named = manifest.skills.map((s) => marked(s.name, skillMarks(s, change))).join(", ");
  return `${MESSAGE.skills(manifest.skills.length, named)}${removed}`;
}

function skillMarks(skill: PluginSkill, change: PluginSkillChange | undefined): string[] {
  return [
    ...(change?.added.includes(skill.name) ? [MESSAGE.new] : []),
    ...(change?.changed.includes(skill.name) ? [MESSAGE.changed] : []),
  ];
}

function scanBlock(scan: PluginScan | undefined): string {
  if (!scan) return MESSAGE.notScanned;
  const named = scan.findings
    .slice(0, SCAN_FINDINGS_NAMED)
    .map((f) => MESSAGE.finding(f.rule, f.file, f.line))
    .join(", ");
  const found = scan.findings.length ? `${plural(scan.findings.length, "finding")}: ${named}` : MESSAGE.noFindings;
  return MESSAGE.scan(scan.verdict, found);
}

/**
 * Turning a plugin on approves its `folders` as places its programs (and the workers and jobs that
 * run them) may write outside the games, and installing turns it on: so the dialog names each with
 * why, an update marking the new ones.
 */
function folderBlock(manifest: PluginManifest, before: PluginManifest | undefined): string | undefined {
  const folders = manifest.folders ?? [];
  if (!folders.length) return undefined;
  const had = before ? new Set((before.folders ?? []).map((f) => f.path)) : null;
  const lines = folders.map((f) => `${marked(f.path, had && !had.has(f.path) ? [MESSAGE.new] : [])} — ${f.why}`);
  return bulleted(MESSAGE.folders(folders.length), lines);
}

/** Each of Genex's moments as the trust dialog names it. */
const MOMENT_WORDS: Record<HookEvent, string> = {
  [HookEvent.RunPrepare]: "before a Loop starts",
  [HookEvent.RunEnd]: "when a Loop ends",
  [HookEvent.TurnStart]: "when a turn starts",
  [HookEvent.TurnEnd]: "when a turn ends",
  [HookEvent.CheckpointBefore]: "before a save point",
  [HookEvent.CheckpointAfter]: "after a save point",
  [HookEvent.RestoreBefore]: "before a restore",
  [HookEvent.RestoreAfter]: "after a restore",
  [HookEvent.WorkerStart]: "when a worker starts",
  [HookEvent.WorkerEnd]: "when a worker ends",
  [HookEvent.ToolBefore]: "before its tools run",
  [HookEvent.ToolAfter]: "after its tools run",
  [HookEvent.Health]: "on health checks",
  [HookEvent.Crash]: "after a crash",
  [HookEvent.Finish]: "when a Loop finishes",
};

/** The steps of a plugin Genex runs on its own besides its hooks, each named when the manifest declares it. */
const OWN_STEP_WORDS = {
  observers: "when a reviewer checks a finish",
  personFirst: "while it holds a lock, to see whether you are using it",
  ready: "before a project of its kind is made",
} as const;

/** Every step of the plugin Genex runs without a card: its hooks' moments, its observers, its person-first probes and its readiness checks. */
function ownSteps(manifest: PluginManifest): string[] {
  const moments = [...new Set((manifest.hooks ?? []).map((hook) => MOMENT_WORDS[hook.on]))];
  const declared = {
    observers: (manifest.observers ?? []).length > 0,
    personFirst: (manifest.locks ?? []).some((lock) => lock.personFirst !== undefined),
    ready: manifest.tools.some((tool) => tool.ready !== undefined),
  };
  const others = (Object.keys(OWN_STEP_WORDS) as Array<keyof typeof OWN_STEP_WORDS>).filter((step) => declared[step]);
  return [...moments, ...others.map((step) => OWN_STEP_WORDS[step])];
}

/**
 * A plugin from a local folder runs with the person's access and starts off, each of its tools
 * asking before an agent runs it; every
 * step Genex runs on its own (hooks, observers, person-first probes, readiness checks) is named,
 * and runs without asking once it is on. Loading again one that is on keeps it on (`staysOn`): its
 * new code runs at once, and its tools ask again.
 */
function localAccessBlock(
  manifest: PluginManifest,
  origin: PluginSource | undefined,
  staysOn: boolean,
): string | undefined {
  if (origin?.kind !== PluginSourceKind.Local) return undefined;
  const steps = ownSteps(manifest);
  const state = `${MESSAGE.localAccess} ${staysOn ? MESSAGE.staysOn : MESSAGE.startsOff}`;
  if (!steps.length) return state;
  return `${state} ${MESSAGE.steps(staysOn ? MESSAGE.runs : MESSAGE.runsOnceOn, steps.join(", "))}`;
}

/**
 * What the trust dialog says of the installed version a package updates: a replacement is a new
 * plugin, not an update of the one it erases (every capability and server is new); an update
 * brings the installed scan (so a scanned update can say which skills' bytes changed); `staysOn` is
 * whether it will be on once loaded, by the registry's own rule (`startsEnabled`).
 */
export function installUpdateFacts(
  list: readonly PluginInfo[],
  manifest: PluginManifest,
  origin: PluginSource | undefined,
  previous: PluginManifest | undefined,
  replacing: boolean,
) {
  const before = replacing ? undefined : previous;
  const installed = list.find((p) => p.manifest.id === manifest.id);
  const source = origin?.kind ?? PluginSourceKind.Bundled;
  const staysOn = startsEnabled(source, installed, replacing);
  return { before, previousScan: before ? installed?.scan : undefined, staysOn };
}

/** What the dialog says about the id a replacement erases, or nothing for a plain install. */
function replacementBlock(replaces: PluginInstallReview["replaces"]): string | undefined {
  if (!replaces) return undefined;
  return MESSAGE.replaces(replaces.name, replaces.publisher, pluginOriginWords(replaces.origin));
}

/** What the trust dialog is built from. */
export interface PluginInstallFacts {
  manifest: PluginManifest;
  origin?: PluginSource;
  /** The static scan of this package; absent for bundled code. */
  scan?: PluginScan;
  /** The installed version this package updates; absent on a first install or a replacement. */
  before?: PluginManifest;
  /** The update keeps an installed plugin that is on: it stays on, its new code running at once. */
  staysOn?: boolean;
  /** The installed version's scan, which a scanned update's skill digests are compared with. */
  previousScan?: PluginScan;
  replaces?: PluginInstallReview["replaces"];
  /** Anything the user must weigh besides the package itself. */
  note?: string;
}

/**
 * The trust dialog's body, one block per fact with a blank line between: what a replacement erases,
 * where the code came from, that it is not sandboxed (and, from a local folder, whether it is on and
 * the steps it runs unasked), what it asks to do, what it starts, where it may write, which skills
 * it adds, what the scan saw, and the note. A block with nothing to say is left out.
 */
export function installDetail(facts: PluginInstallFacts): string {
  const { manifest, origin, scan, before, replaces, note, staysOn = false } = facts;
  return [
    replacementBlock(replaces),
    MESSAGE.source(pluginOriginWords(origin), manifest.publisher),
    MESSAGE.unsandboxed,
    localAccessBlock(manifest, origin, staysOn),
    capabilityBlock(manifest, before),
    serverBlock(manifest, before),
    folderBlock(manifest, before),
    hostToolBlock(manifest, before),
    skillBlock(facts),
    scanBlock(scan),
    note,
  ]
    .filter((block): block is string => Boolean(block))
    .join("\n\n");
}

/** The trust dialog: its question, its body and the button that agrees. */
export interface InstallPrompt {
  message: string;
  detail: string;
  confirm: string;
}

/** Install, update (another version of the installed plugin) or replace (another plugin's id). */
export function installPrompt(facts: PluginInstallFacts): InstallPrompt {
  const { manifest, before, replaces } = facts;
  const detail = installDetail(facts);
  if (replaces)
    return {
      message: MESSAGE.replace(replaces.name, manifest.name, manifest.version),
      detail,
      confirm: MESSAGE.replaceButton,
    };
  if (before && before.version !== manifest.version)
    return { message: MESSAGE.update(manifest.name, manifest.version), detail, confirm: MESSAGE.updateButton };
  return { message: MESSAGE.install(manifest.name, manifest.version), detail, confirm: MESSAGE.installButton };
}

/** The arguments an approved action runs with, under its question; none, and nothing shows (never `{}`). */
export function actionApprovalDetail(args: unknown): string | undefined {
  const empty = args === undefined || args === null || (typeof args === "object" && Object.keys(args).length === 0);
  return empty ? undefined : JSON.stringify(args, null, 2);
}

/** The confirm button of an action no review described. */
const APPROVE = "Approve";
const CANCEL = "Cancel";

/** What a confirmed action's native dialog shows; `buttons` is always Cancel, then the confirm button. */
export interface ActionApprovalDialog {
  title: string;
  message: string;
  detail?: string;
  buttons: [cancel: string, confirm: string];
}

/**
 * A confirmed action's native dialog. When the plugin's review asked its own question, the dialog
 * asks that, shows the review's own words under it (never the arguments as JSON) and confirms with
 * the action's name; otherwise it asks the manifest's confirmation over the arguments, with Approve.
 */
export function actionApprovalDialog(input: {
  plugin: string;
  action: { label: string; confirmation?: string };
  review: { message?: string; detail?: string };
  args: unknown;
}): ActionApprovalDialog {
  const { plugin, action, review, args } = input;
  const title = `${plugin}: ${action.label}`;
  if (review.message) {
    const detail = review.detail ? { detail: review.detail } : {};
    return { title, message: review.message, ...detail, buttons: [CANCEL, action.label] };
  }
  const detail = actionApprovalDetail(args);
  const message = action.confirmation ?? action.label;
  return { title, message, ...(detail ? { detail } : {}), buttons: [CANCEL, APPROVE] };
}
