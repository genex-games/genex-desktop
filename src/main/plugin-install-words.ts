/**
 * What the plugin trust dialog says, built from the package alone (the folders turning it on lets it
 * write in among it), and what an action's approval
 * shows under its question: pure, so the words are tested without Electron.
 * `plugin-install-dialog.ts` and the plugins IPC show them.
 */
import {
  isFileSkill,
  PluginHostTool,
  type PluginManifest,
  type PluginManifestTool,
  type PluginMcpServer,
  type PluginScan,
  type PluginSkill,
  type PluginSkillChange,
  type PluginSource,
  pluginSkillChange,
} from "../shared/plugins.ts";
import { type PluginInstallReview, pluginOriginWords } from "./plugin-local-install.ts";

/** How many scan findings the dialog names. */
const SCAN_FINDINGS_NAMED = 6;

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

const pluginScanWords = (scan?: PluginScan): string => {
  if (!scan) return "Scan: bundled — not scanned.";
  const named = scan.findings
    .slice(0, SCAN_FINDINGS_NAMED)
    .map((f) => `${f.rule} ${f.file}:${f.line}`)
    .join(", ");
  return `Scan: ${scan.verdict} — ${plural(scan.findings.length, "finding")}${named ? `: ${named}` : ""}.`;
};
/**
 * A plugin's MCP servers are trusted by this dialog and by nothing else — there is no second
 * connector trust prompt for a server the host owns on the plugin's behalf. So the dialog has to
 * say that installing also means letting Studio start those programs, and name what each is given.
 */
const pluginMcpWords = (manifest: PluginManifest, previous?: PluginManifest): string => {
  const servers = manifest.mcpServers ?? [];
  if (!servers.length) return "";
  const before = previous ? new Map((previous.mcpServers ?? []).map((s) => [s.id, JSON.stringify(s)])) : null;
  const named = servers.map((s) => `${s.id}${serverChange(before, s)} (${serverLaunch(s).join(", ")})`).join("; ");
  return ` Starts ${plural(servers.length, "MCP server")} on your Mac, as trusted native code with the environment it declares: ${named}.`;
};

/**
 * A server that is new, or that now runs something else, somewhere else, or on a different
 * environment, is an expansion of exactly the kind a new capability is — so it is marked the
 * same way rather than arriving inside a dialog that reads like the last one. A first install
 * (no `before`) marks nothing.
 */
function serverChange(before: ReadonlyMap<string, string> | null, server: PluginMcpServer): string {
  if (!before) return "";
  const was = before.get(server.id);
  if (was === undefined) return " (new)";
  return was !== JSON.stringify(server) ? " (changed)" : "";
}

/** What a server runs, then the names of the environment it is given. */
function serverLaunch(server: PluginMcpServer): string[] {
  const program = server.command === "host-cli" ? "Studio's own Genex CLI" : (server.args[0] ?? "node");
  return [program, ...Object.keys(server.env ?? {})];
}

/** What each tool Studio runs itself does, as the dialog names it. */
const HOST_TOOL_WORDS = {
  [PluginHostTool.GenexCli]: "runs Studio's Genex CLI",
  [PluginHostTool.GenexCliPaid]: "runs Studio's Genex CLI",
  [PluginHostTool.GenexPackage]: "installs Genex packages in the game",
} as const satisfies Record<PluginHostTool, string>;
const READ_ON_DEMAND = "read on demand";
const WITH_CONSENT = "with your consent each time";

/**
 * Skills reach every agent's brief, so they are disclosed like the servers are: by name, a file
 * skill as read on demand, and on an update each new or changed one marked and each withdrawn one
 * named. A skill is changed when its manifest entry differs or, when both versions were scanned, the
 * bytes of its files do.
 */
function pluginSkillWords(facts: PluginInstallFacts): string {
  const { manifest, before } = facts;
  const change = before
    ? pluginSkillChange({ manifest: before, scan: facts.previousScan }, { manifest, scan: facts.scan })
    : undefined;
  const removed = change?.removed.length ? `; removed: ${change.removed.join(", ")}` : "";
  if (!manifest.skills.length) return removed ? ` Gives agents no skills${removed}.` : "";
  const named = manifest.skills.map((s) => `${s.name}${skillMarks(s, change)}`).join(", ");
  return ` Gives agents ${plural(manifest.skills.length, "skill")}: ${named}${removed}.`;
}

function skillMarks(skill: PluginSkill, change: PluginSkillChange | undefined): string {
  const marks = [
    ...(change?.added.includes(skill.name) ? ["new"] : []),
    ...(change?.changed.includes(skill.name) ? ["changed"] : []),
    ...(isFileSkill(skill) ? [READ_ON_DEMAND] : []),
  ];
  return marks.length ? ` (${marks.join(", ")})` : "";
}

/** Tools Studio runs itself rather than the plugin's code, named with what each does. */
function hostToolWords(manifest: PluginManifest, before: PluginManifest | undefined): string {
  const tools = manifest.tools.filter((t) => t.host);
  if (!tools.length) return "";
  const had = before ? new Set(before.tools.filter((t) => t.host).map((t) => t.name)) : null;
  const named = tools.map((t) => `${t.name}${had && !had.has(t.name) ? " (new)" : ""} (${hostToolUse(t)})`).join("; ");
  return ` Studio runs ${plural(tools.length, "tool")} for it: ${named}.`;
}

function hostToolUse(tool: PluginManifestTool): string {
  const does = tool.host ? HOST_TOOL_WORDS[tool.host] : "";
  return tool.confirmation ? `${does}, ${WITH_CONSENT}` : does;
}

/**
 * Turning a plugin on approves its `folders` as places its programs (and the workers and jobs that
 * run them) may write outside the games, and installing turns it on: so the dialog names each with
 * why, an update marking the new ones.
 */
function pluginFolderWords(manifest: PluginManifest, before: PluginManifest | undefined): string {
  const folders = manifest.folders ?? [];
  if (!folders.length) return "";
  const had = before ? new Set((before.folders ?? []).map((f) => f.path)) : null;
  const named = folders.map((f) => `${f.path}${had && !had.has(f.path) ? " (new)" : ""} (${f.why})`).join("; ");
  return ` Turning it on lets its programs write in ${plural(folders.length, "folder")} outside your games: ${named}.`;
}

/** What the dialog says about the id a replacement erases, or nothing for a plain install. */
function replacementWords(replaces: PluginInstallReview["replaces"]): string {
  if (!replaces) return "";
  return `It replaces ${replaces.name} by ${replaces.publisher} (${pluginOriginWords(replaces.origin)}), which has the same id: that plugin's saved account, settings and data will be erased. `;
}

/** What the trust dialog is built from. */
export interface PluginInstallFacts {
  manifest: PluginManifest;
  origin?: PluginSource;
  /** The static scan of this package; absent for bundled code. */
  scan?: PluginScan;
  /** The installed version this package updates; absent on a first install or a replacement. */
  before?: PluginManifest;
  /** The installed version's scan, which a scanned update's skill digests are compared with. */
  previousScan?: PluginScan;
  replaces?: PluginInstallReview["replaces"];
  /** Anything the user must weigh besides the package itself. */
  note?: string;
}

/** The trust dialog's body: where the code came from, what it may do, and what the scan saw. */
export function installDetail(facts: PluginInstallFacts): string {
  const { manifest, origin, scan, before, replaces, note } = facts;
  const added = manifest.capabilities.filter((c) => !(before?.capabilities ?? []).includes(c));
  const capabilities = `${manifest.capabilities.join(", ") || "none"}${added.length ? ` (new: ${added.join(", ")})` : ""}`;
  return `${replacementWords(replaces)}${manifest.name} ${manifest.version} from ${pluginOriginWords(origin)} runs as trusted native code in a crash-isolated child process — not an OS sandbox. Publisher: ${manifest.publisher}. Capabilities: ${capabilities}.${pluginMcpWords(manifest, before)}${pluginFolderWords(manifest, before)}${hostToolWords(manifest, before)}${pluginSkillWords(facts)} ${pluginScanWords(scan)}${note ? ` ${note}` : ""}`;
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
