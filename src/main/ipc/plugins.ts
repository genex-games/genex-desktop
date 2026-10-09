/** Plugins: the trust dialogs, reviewed actions, consent answers, and installing from any origin. */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { type BrowserWindow, dialog, shell } from "electron";
import { MINUTE_MS } from "../../shared/duration.ts";
import { isUserCancelled, UserCancelledError } from "../../shared/errors.ts";
import type { StudioInvokePayload } from "../../shared/ipc-channels.ts";
import { isGithubVersion, PluginCapability, type PluginSource, PluginSourceKind } from "../../shared/plugins.ts";
import type { PluginMarketplace } from "../../substrate/plugins/marketplace.ts";
import { scanPackage } from "../../substrate/plugins/scan.ts";
import { publishFromDialog, publishReview } from "../core/genex-publish.ts";
import { createPluginFilePicker } from "../core/plugin-file-picker.ts";
import { assertNativeActionAllowed } from "../dev/native-policy.ts";
import type { ConfirmPluginInstall } from "../plugin-install-dialog.ts";
import { type ActionApprovalDialog, actionApprovalDialog } from "../plugin-install-words.ts";
import { installLocalPlugin } from "../plugin-local-install.ts";
import type { StudioCore } from "../studio-core.ts";
import type { IpcHandle } from "./registrar.ts";

/** A reviewed action must be approved within this long of its review. */
const PLUGIN_APPROVAL_TTL_MS = 5 * MINUTE_MS;
/** Actions that may hand back a browser page to finish signing in (besides the plugin's own `connect`). */
const EXTERNAL_AUTH_ACTIONS = ["terms", "publish-open"];
/** Where a removed plugin is re-acquired from through `restore`, which stages and scans the real code. */
const REACQUIRED_ORIGINS: ReadonlySet<string> = new Set([
  PluginSourceKind.Github,
  PluginSourceKind.Index,
  PluginSourceKind.Catalog,
]);
/** The longest GitHub link a lookup reads; a real one is a fraction of it. */
const GITHUB_LINK_MAX_CHARS = 2048;
/** The longest question a plugin's review may ask in the native dialog. */
const REVIEW_MESSAGE_MAX_CHARS = 2_000;
/** The longest text a plugin's review may show under its question. */
const REVIEW_DETAIL_MAX_CHARS = 4_000;

/** Why a plugin request from the renderer is refused. */
const MESSAGE = {
  invalidConsent: "Invalid consent",
  invalidState: "Invalid state",
  notInIndex: "Plugin is not in the marketplace index",
  noNewerRelease: "No compatible newer release is available for this installed plugin",
  actionUnavailable: "Plugin action unavailable",
  reviewFirst: "Review this action in Studio before approving",
  invalidAuthUrl: "Invalid authentication URL",
  stillStarting: "Studio is still starting",
  notFound: "Plugin not found",
  invalidLink: "Invalid GitHub link",
  invalidReview: `Invalid plugin review: its message and detail are text of at most ${REVIEW_MESSAGE_MAX_CHARS} and ${REVIEW_DETAIL_MAX_CHARS} characters`,
} as const;

export interface PluginsIpcDeps {
  core: StudioCore;
  /** Built with the core; null only while the studio is still starting. */
  marketplace(): PluginMarketplace | null;
  confirmInstall: ConfirmPluginInstall;
  fixtureNativePolicy: boolean;
  /** The studio window, which a panel's file picker opens over; null while it is closed. */
  window(): BrowserWindow | null;
}

/** The words a plugin's review gives the native dialog: its question and the text under it. */
interface ReviewWords {
  message?: string;
  detail?: string;
}

/** A review the user approves in Studio before the action's own dialog asks again. */
interface Approval extends ReviewWords {
  key: string;
  expires: number;
}

/** What the plugin handlers share: their deps and the reviews waiting for approval. */
interface PluginsContext extends PluginsIpcDeps {
  approvals: Map<string, Approval>;
}

type InstalledPlugin = ReturnType<StudioCore["plugins"]["list"]>[number];
type ActionRequest = StudioInvokePayload<"studio:plugins.action">;

export function registerPluginsIpc(handle: IpcHandle, deps: PluginsIpcDeps): void {
  const { core } = deps;
  // The modeller (AG-930): detection status, and the one-click download into the studio's folder.
  const ctx: PluginsContext = { ...deps, approvals: new Map() };
  // The user's answer to a consent card. Studio UI only: the main-frame guard above covers the
  // channel, and the core's RPC table has no equivalent, so no agent can approve its own request.
  handle("studio:plugins.consent", async (p) => {
    const always = p?.always ?? false;
    if (typeof p?.consentId !== "string" || typeof p.approved !== "boolean" || typeof always !== "boolean")
      throw new Error(MESSAGE.invalidConsent);
    return { resolved: core.resolveConsent(p.consentId, p.approved, always) };
  });
  handle("studio:plugins.list", async () => core.plugins.list());
  handle("studio:plugins.catalog", async () => core.plugins.catalog());
  handle("studio:plugins.enable", async (p) => {
    if (typeof p.enabled !== "boolean") throw new Error(MESSAGE.invalidState);
    await core.plugins.setEnabled(p.id, p.enabled);
  });
  handle("studio:plugins.remove", async (p) => core.plugins.remove(p.id));
  handle("studio:plugins.panel", async (p) => ({
    ...(await core.plugins.panel(p.id, p.panel)),
    url: `studio-plugin://${p.id}/${p.panel}`,
  }));
  handle("studio:plugins.settings", async (p) => core.plugins.settings(p.id));
  handle("studio:plugins.setting", async (p) => core.plugins.setSetting(p.id, p.key, p.value));
  handle("studio:plugins.review", async (p) => {
    const info = await core.plugins.review(p.id, p.name, p.args, await core.pluginBinding(p.project));
    const words = reviewWords(info);
    return { ...info, ticket: issueTicket(ctx, actionKey(p.id, p.name, p.args, p.project), words) };
  });
  handle("studio:plugins.action", async (p) => runPluginAction(ctx, p));
  // A panel's Choose file. The panel host checked the request; main checks it again, and the plugin.
  const chooseFile = createPluginFilePicker({
    window: deps.window,
    showOpenDialog: (window, options) => dialog.showOpenDialog(window, options),
    plugins: () => core.plugins.list(),
  });
  handle("studio:plugins.choose-file", async (p) => chooseFile(p?.id, p?.request));
  // Studio's own Publish dialog: its Publish press is the consent to the files it lists, so nothing asks again.
  handle("studio:plugins.genex-publish-review", async (p) => publishReview(core, p?.project));
  handle("studio:plugins.genex-publish", async (p) => publishFromDialog(core, p?.project, p?.review, p?.title));
  handle("studio:plugins.install", async (p) => installPlugin(ctx, p.id));
  handle("studio:plugins.index", async (p) => requireMarketplace(ctx).index(p?.refresh === true, core.plugins.list()));
  handle("studio:plugins.install-github", async (p) => installFromGithub(ctx, p.spec));
  handle("studio:plugins.lookup-github", async (p) => {
    if (typeof p?.link !== "string" || p.link.length > GITHUB_LINK_MAX_CHARS) throw new Error(MESSAGE.invalidLink);
    if (p.version !== undefined && !isGithubVersion(p.version)) throw new Error(MESSAGE.invalidLink);
    return requireMarketplace(ctx).lookupGithub(p.link, p.version);
  });
  handle("studio:plugins.github-versions", async (p) => {
    if (typeof p?.repo !== "string" || p.repo.length > GITHUB_LINK_MAX_CHARS) throw new Error(MESSAGE.invalidLink);
    return requireMarketplace(ctx).githubVersions(p.repo);
  });
  handle("studio:plugins.update", async (p) => {
    const market = requireMarketplace(ctx);
    await market.index(true, core.plugins.list());
    const entry = market.entry(p.id);
    if (!entry) throw new Error(MESSAGE.notInIndex);
    if (!market.updates(core.plugins.list()).some((update) => update.id === p.id))
      throw new Error(MESSAGE.noNewerRelease);
    await installFromIndex(ctx, p.id, entry.capabilities);
  });
  handle("studio:plugins.watch", async (p) => {
    if (typeof p.enabled !== "boolean") throw new Error(MESSAGE.invalidState);
    await core.plugins.watch(p.id, p.enabled);
  });
}

function actionKey(id: string, name: string, args: unknown, project?: string): string {
  return JSON.stringify({ id, name, args, project });
}

/** Is `value` absent, or text of at most `max` characters? */
const optionalText = (value: unknown, max: number): value is string | undefined =>
  value === undefined || (typeof value === "string" && value.length <= max);

/**
 * The question and text a plugin's review gives the native dialog, refused unless each is bounded
 * text: the dialog shows them as the plugin wrote them. An empty question is no question.
 */
function reviewWords(info: unknown): ReviewWords {
  if (!info || typeof info !== "object") return {};
  const { message, detail } = info as Record<string, unknown>;
  const bounded = optionalText(message, REVIEW_MESSAGE_MAX_CHARS) && optionalText(detail, REVIEW_DETAIL_MAX_CHARS);
  if (!bounded) throw new Error(MESSAGE.invalidReview);
  return { ...(message ? { message } : {}), ...(detail ? { detail } : {}) };
}

/** Remember a review for {@link PLUGIN_APPROVAL_TTL_MS}, dropping the ones that expired. */
function issueTicket(ctx: PluginsContext, key: string, words: ReviewWords): string {
  for (const [ticket, value] of ctx.approvals) if (value.expires < Date.now()) ctx.approvals.delete(ticket);
  const ticket = randomUUID();
  ctx.approvals.set(ticket, { key, expires: Date.now() + PLUGIN_APPROVAL_TTL_MS, ...words });
  return ticket;
}

/** Spend a ticket: the review it names, while it is fresh and for exactly this action; null otherwise. */
function takeApproval(ctx: PluginsContext, ticket: string | undefined, key: string): Approval | null {
  if (!ticket) return null;
  const approval = ctx.approvals.get(ticket);
  ctx.approvals.delete(ticket);
  if (!approval || approval.expires < Date.now() || approval.key !== key) return null;
  return approval;
}

async function runPluginAction(ctx: PluginsContext, p: ActionRequest) {
  const { core } = ctx;
  const plugin = core.plugins.list().find((x) => x.manifest.id === p.id && x.enabled && !x.removed);
  const action = plugin?.manifest.actions.find((a) => a.name === p.name);
  if (!plugin || !action) throw new Error(MESSAGE.actionUnavailable);
  // An action that starts or opens an app or writes outside the plugin's storage never runs in a fixture.
  if (action.native) assertNativeActionAllowed(ctx.fixtureNativePolicy, "studio:plugins.native-action");
  if (action.confirmation) {
    const approval = takeApproval(ctx, p.ticket, actionKey(p.id, p.name, p.args, p.project));
    if (!approval) throw new Error(MESSAGE.reviewFirst);
    assertNativeActionAllowed(ctx.fixtureNativePolicy, "studio:plugins.approval");
    const approved = await confirmAction(
      actionApprovalDialog({ plugin: plugin.manifest.name, action, review: approval, args: p.args }),
    );
    if (!approved) throw new UserCancelledError();
  }
  const result = await core.plugins.action(p.id, p.name, p.args, await core.pluginBinding(p.project));
  if (result?.verifyUrl && opensSignIn(plugin, p.name)) await openVerifyUrl(ctx, result.verifyUrl);
  return result;
}

/** The native dialog in front of a reviewed action, Cancel first and the default; true when confirmed. */
async function confirmAction(box: ActionApprovalDialog): Promise<boolean> {
  const choice = await dialog.showMessageBox({ type: "question", ...box, defaultId: 0, cancelId: 0 });
  return choice.response === 1;
}

/** Does this action of an external-auth plugin hand back a page to finish signing in? */
function opensSignIn(plugin: InstalledPlugin, name: string): boolean {
  const signInActions = [plugin.manifest.account?.connect ?? "connect", ...EXTERNAL_AUTH_ACTIONS];
  return signInActions.includes(name) && plugin.manifest.capabilities.includes(PluginCapability.ExternalAuth);
}

async function openVerifyUrl(ctx: PluginsContext, verifyUrl: string): Promise<void> {
  // Fixture profiles never open the browser, whichever plugin action asks.
  assertNativeActionAllowed(ctx.fixtureNativePolicy, "studio:open-url");
  const url = new URL(verifyUrl);
  if (url.protocol !== "https:") throw new Error(MESSAGE.invalidAuthUrl);
  await shell.openExternal(url.href);
}

function requireMarketplace(ctx: PluginsContext): PluginMarketplace {
  const marketplace = ctx.marketplace();
  if (!marketplace) throw new Error(MESSAGE.stillStarting);
  return marketplace;
}

/** Run an install step; the user saying no to its dialog is not a failure. */
async function unlessCancelled(step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (e) {
    if (!isUserCancelled(e)) throw e;
  }
}

/** Cataloged installs and updates: the pinned commit is staged and scanned first, so the dialog describes the real code. */
async function installFromIndex(ctx: PluginsContext, id: string, capabilities: string[]): Promise<void> {
  const known = ctx.core.plugins.list().find((x) => x.manifest.id === id);
  const current = known && !known.removed ? known.manifest : undefined;
  await unlessCancelled(() =>
    requireMarketplace(ctx).installIndex(id, ctx.core.plugins, capabilities, (manifest, scan, origin) =>
      ctx.confirmInstall(manifest, origin, scan, current),
    ),
  );
}

async function installPlugin(ctx: PluginsContext, id: string | undefined): Promise<void> {
  const { core, confirmInstall } = ctx;
  if (!id) return pickLocalPlugin(ctx);
  const catalog = await core.plugins.catalog();
  const curated = catalog.some((x) => x.manifest.id === id);
  const known = core.plugins.list().find((x) => x.manifest.id === id);
  const removedLocal = known?.removed && known.origin?.kind === PluginSourceKind.Local && known.origin.directory;
  if (known && removedLocal) {
    await installLocalPlugin(core.plugins, removedLocal, confirmInstall, known.manifest.id);
    return;
  }
  // Nothing installed and nothing curated under that id: it is a marketplace entry, installed from the index.
  const entry = !known && !curated ? ctx.marketplace()?.entry(id) : undefined;
  if (entry) return installFromIndex(ctx, id, entry.capabilities);
  // A removed plugin that came from a commit, an index entry or a curated release is re-acquired
  // through `restore`, which stages and scans the real code and asks about that. Asking here first
  // would describe the record's old manifest and a scan nobody ran.
  const reacquired = known?.removed && !known.unlisted && REACQUIRED_ORIGINS.has(known.origin?.kind ?? "");
  if (reacquired) return unlessCancelled(() => core.plugins.restore(id));
  return installReviewed(ctx, id, catalog, known);
}

/** Install or restore after the user reviewed the manifest (and, for unlisted code, a fresh scan). */
async function installReviewed(
  ctx: PluginsContext,
  id: string,
  catalog: Awaited<ReturnType<StudioCore["plugins"]["catalog"]>>,
  known: InstalledPlugin | undefined,
): Promise<void> {
  const { core, confirmInstall } = ctx;
  const curated = catalog.find((x) => x.manifest.id === id);
  const manifest =
    known?.source === PluginSourceKind.Bundled
      ? core.plugins.bundledManifest(known.manifest.id)
      : (curated?.manifest ?? known?.manifest);
  if (!manifest) throw new Error(MESSAGE.notFound);
  // Code on disk is read where it lies, so the dialog reports the package the user is about to trust.
  const scanTarget = known?.unlisted ? known.origin?.directory : undefined;
  const scan = scanTarget ? await scanPackage(scanTarget, manifest) : undefined;
  const origin: PluginSource | undefined = curated ? { kind: PluginSourceKind.Catalog } : known?.origin;
  if (!(await confirmInstall(manifest, origin, scan, known && !known.unlisted ? known.manifest : undefined))) return;
  if (curated) await core.plugins.installCatalog(id, manifest.capabilities);
  else if (known?.unlisted) await core.plugins.allowUnlisted(id, manifest.capabilities, scan);
  // A removed plugin goes back to where it came from: bundled seeds, the folder it was loaded from,
  // or — through the registry's re-acquire hook — the curated release or the commit its origin pins.
  else await core.plugins.restore(id, manifest.capabilities);
}

async function pickLocalPlugin(ctx: PluginsContext): Promise<void> {
  const picked = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    title: "Load a local plugin package",
  });
  const [directory] = picked.filePaths;
  if (picked.canceled || !directory) return;
  await installLocalPlugin(ctx.core.plugins, directory, ctx.confirmInstall);
}

async function installFromGithub(ctx: PluginsContext, spec: string): Promise<void> {
  const { core } = ctx;
  const staged = await requireMarketplace(ctx).stageGithub(spec);
  try {
    const known = core.plugins.list().find((x) => x.manifest.id === staged.manifest.id);
    const current = known && !known.removed ? known.manifest : undefined;
    if (!(await ctx.confirmInstall(staged.manifest, staged.origin, staged.scan, current))) return;
    await core.plugins.installLocal(
      staged.stage,
      PluginSourceKind.Github,
      staged.manifest.capabilities,
      staged.origin,
      staged.scan,
    );
  } finally {
    await fs.rm(staged.stage, { recursive: true, force: true });
  }
}
