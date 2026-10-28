/**
 * Usage analytics, phase 3: a plugin's install, update or switch says why it failed. Main refuses
 * an install, an update, a reinstall, turning a plugin on and removing one with a typed code beside
 * the same words (`PluginInstallProblem`, `PluginStateRefusal`); the code crosses IPC and reaches
 * `plugin_install_finished`, `plugin_action_finished` and the sidebar's toasts. A plugin failing
 * while it runs says how on `plugins.changed` (`PluginFailure`), which `plugin_failed` re-checks. A
 * declined update is the person's no, never an `ok`. Words, paths and Node codes read as none.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import type { PostHog } from "posthog-js";
import { RewindRefusal } from "../../src/shared/chat-rewind.ts";
import { CodedError, errorCodeIn, errorMessage, isUserCancelled, UserCancelledError } from "../../src/shared/errors.ts";
import {
  type PluginChange,
  PluginChangeReason,
  PluginFailure,
  type PluginIndexEntry,
  type PluginInfo,
  PluginInstallProblem,
  PluginSourceKind,
  PluginStateRefusal,
} from "../../src/shared/plugins.ts";
import { reviewPluginInstall, installLocalPlugin } from "../../src/main/plugin-local-install.ts";
import { inspectPackage } from "../../src/substrate/plugins/manifest.ts";
import { DEFAULT_INDEX_URL, parseGithubSpec, PluginMarketplace } from "../../src/substrate/plugins/marketplace.ts";
import { PluginProcess } from "../../src/substrate/plugins/process.ts";
import {
  ActionOutcome,
  installFinishedProperties,
  PluginAction,
  PluginInstallOrigin,
  PluginInstallSurface,
  pluginActionProperties,
  PluginSurface,
  trackedPluginInstall,
  InstallOutcome,
  UpdatesRunSurface,
  updatesRunProperties,
} from "../../src/renderer/analytics/plugins-page.ts";
import { pluginFailedProperties } from "../../src/renderer/analytics/plugins-records.ts";
import { startAnalytics } from "../../src/renderer/analytics/client.ts";
import { AnalyticsEvent } from "../../src/renderer/analytics/events.ts";
import { createPluginsStore, distinctFailures } from "../../src/renderer/state/plugins.ts";
import { notifyProblem, ToastTone } from "../../src/renderer/state/toasts.ts";
import { problemWords } from "../../src/renderer/words.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";
import { assertClean, crossed, HOSTILE, HOSTILE_THROWS, refusalOf } from "../helpers/failure-codes.ts";
import { copyOfExample, EXAMPLE_PLUGIN, PLUGIN_SDK_BACKEND, pluginFixture } from "../helpers/plugins.ts";
import { removeTree, tmpDir } from "../helpers/tmp.ts";

/** Main's plugin registrar imports electron; this stand-in has the dialogs it may reach answer no. */
const ELECTRON_STUB = `data:text/javascript,${encodeURIComponent(
  [
    "export const dialog = {",
    "  showMessageBox: async () => ({ response: 0 }),",
    "  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),",
    "};",
    "export const shell = { openExternal: async () => {} };",
    'export const app = { getVersion: () => "0.0.0", getPath: () => "/nonexistent" };',
    "export const BrowserWindow = class {};",
    "export default { dialog, shell, app, BrowserWindow };",
  ].join("\n"),
)}`;
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === "electron" ? { url: ELECTRON_STUB, shortCircuit: true } : next(specifier, context),
});
const { createIpcHandle } = await import("../../src/main/ipc-handle.ts");
const { registerPluginsIpc } = await import("../../src/main/ipc/plugins.ts");

const SHA = "a".repeat(40);
const REPO = "acme/studio-plugins";
const SPEC = `${REPO}@${SHA}`;
/** A file past the marketplace's cap for one package file (`FILE_MAX_BYTES`). */
const OVERSIZED_BYTES = 8 * 1024 * 1024 + 1;
/** The longest a watched edit's debounced reload (`WATCH_DEBOUNCE_MS`) may take to settle, in real time. */
const RELOAD_SETTLE_MS = 15_000;

const installCode = (thrown: unknown) => errorCodeIn(PluginInstallProblem, thrown);
const stateCode = (thrown: unknown) => errorCodeIn(PluginStateRefusal, thrown);
/** What a synchronous step threw, as a rejection `refusalOf` carries across IPC. */
const thrownBy = (step: () => unknown): Promise<unknown> => Promise.resolve().then(step);

/** The object id GitHub reports for a blob; staging refuses any byte that does not hash to it. */
const blobSha = (bytes: Buffer) =>
  createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest("hex");

/** GitHub and the index as the marketplace fetches them: routes a test sets, anything else unreachable. */
function network() {
  const routes = new Map<string, () => Response>();
  const fetchImpl = (async (input: unknown) => {
    const route = routes.get(String(input));
    if (!route) throw new TypeError("fetch failed");
    return route();
  }) as unknown as typeof fetch;
  return { routes, fetchImpl };
}
const json = (value: unknown) => () => new Response(JSON.stringify(value));

/** The example plugin's files, as a pinned commit holds them. */
async function exampleFiles(): Promise<Record<string, Buffer>> {
  const files: Record<string, Buffer> = {};
  for (const name of ["plugin.json", "backend.mjs", "panel.html"])
    files[name] = await readFile(path.join(EXAMPLE_PLUGIN, name));
  return files;
}

/** Serve the pinned commit: its tree (with `extra` nodes) and each file's bytes, or `served` in their place. */
function serveCommit(
  routes: Map<string, () => Response>,
  files: Record<string, Buffer>,
  options: Omit<Served, "files"> = {},
): void {
  const tree = Object.entries(files).map(([name, bytes]) => ({
    path: name,
    mode: "100644",
    type: "blob",
    sha: blobSha(bytes),
    size: bytes.length,
  }));
  routes.set(
    `https://api.github.com/repos/${REPO}/git/trees/${SHA}?recursive=1`,
    json({ sha: SHA, truncated: false, tree: [...tree, ...(options.extra ?? [])] }),
  );
  for (const [name, bytes] of Object.entries(files))
    routes.set(
      `https://raw.githubusercontent.com/${REPO}/${SHA}/${name}`,
      () => new Response(new Uint8Array(options.served?.[name] ?? bytes)),
    );
}

/** A marketplace over a fake network in a folder of its own. */
async function marketplaceFixture(offline = false) {
  const root = await tmpDir("studio-plugin-codes-");
  const net = network();
  const marketplace = new PluginMarketplace({ root, studioVersion: "0.1.0", fetchImpl: net.fetchImpl, offline });
  return { root, marketplace, routes: net.routes };
}

/** The example plugin's index entry, as the catalog lists it. */
const entryFor = (over: Partial<PluginIndexEntry> = {}): PluginIndexEntry => ({
  id: "example",
  name: "Plugin SDK example",
  publisher: "Studio development",
  description: "Local SDK example.",
  category: "tools",
  tier: "community",
  repo: REPO,
  sha: SHA,
  version: "1.0.0",
  capabilities: ["settings"],
  ...over,
});
const indexOf = (entries: PluginIndexEntry[]) =>
  json({ version: 1, updatedAt: "2026-10-27T00:00:00.000Z", plugins: entries });

/** Main's plugin channels over `core`, the marketplace `market()` answers and the trust dialog's `confirm`. */
function pluginChannels(
  core: unknown,
  market: () => PluginMarketplace | null,
  confirm: (manifest: { id: string }) => Promise<boolean>,
) {
  type Answer = { ok: true; value: unknown } | { ok: false; error: string; code?: string };
  const listeners = new Map<string, (event: unknown, payload: unknown) => Promise<Answer>>();
  const ipc = {
    handle: (channel: string, listener: (event: unknown, payload: unknown) => Promise<Answer>) =>
      listeners.set(channel, listener),
  };
  const studio = { sender: "studio" };
  registerPluginsIpc(createIpcHandle(ipc as never, { fixture: false, isStudioUi: (event) => event === studio }), {
    core: core as never,
    marketplace: market,
    confirmInstall: (manifest) => confirm(manifest),
    fixtureNativePolicy: false,
    window: () => null,
  });
  return (channel: string, payload: unknown): Promise<Answer> => {
    const listener = listeners.get(channel);
    assert.ok(listener, `main registers ${channel}`);
    return listener(studio, payload);
  };
}

/** A pinned commit as served: its files, extra tree nodes, and bytes served in place of the pinned ones. */
interface Served {
  files: Record<string, Buffer>;
  extra?: Array<Record<string, unknown>>;
  served?: Record<string, Buffer>;
}

/** Commits staging refuses, each with the code it is refused with; the last one's plugin.json is not JSON. */
function packageCases(files: Record<string, Buffer>): Array<[string, PluginInstallProblem, Served]> {
  const backend = files["backend.mjs"] ?? Buffer.from("");
  const oversized = { path: "big.bin", mode: "100644", type: "blob", sha: SHA, size: OVERSIZED_BYTES };
  return [
    [
      "a link in the tree",
      PluginInstallProblem.UnsafePackage,
      { files, extra: [{ path: "escape", mode: "120000", type: "blob", sha: SHA }] },
    ],
    ["a file past its cap", PluginInstallProblem.TooLarge, { files, extra: [oversized] }],
    [
      "a file that is not the pinned one",
      PluginInstallProblem.IntegrityMismatch,
      { files, served: { "backend.mjs": Buffer.from("tampered") } },
    ],
    ["no plugin.json", PluginInstallProblem.PackageInvalid, { files: { "backend.mjs": backend } }],
    [
      "a plugin.json that is not JSON",
      PluginInstallProblem.PackageInvalid,
      { files: { ...files, "plugin.json": Buffer.from("{ not json") } },
    ],
  ];
}

/** Wait in real time for `done`, which a watched folder's debounced reload settles. */
async function until(done: () => boolean): Promise<void> {
  for (const end = Date.now() + RELOAD_SETTLE_MS; !done() && Date.now() < end; ) await pause(20);
  assert.ok(done(), "settled in time");
}

describe("phase 3 analytics: a plugin's install, update or switch says why it failed", () => {
  it("the marketplace refuses a spec and a download with a code beside the same words", async () => {
    const spec = await refusalOf(thrownBy(() => parseGithubSpec("acme/x")));
    assert.equal(installCode(spec), PluginInstallProblem.InvalidSpec);
    assert.match(errorMessage(spec), /40-character commit sha/, "the words stay as they were");
    const offline = await marketplaceFixture(true);
    assert.equal(installCode(await refusalOf(offline.marketplace.stageGithub(SPEC))), PluginInstallProblem.Offline);

    const { marketplace, routes } = await marketplaceFixture();
    const unreachable = await refusalOf(marketplace.stageGithub(SPEC));
    assert.equal(installCode(unreachable), PluginInstallProblem.DownloadFailed, "no network");
    assert.equal(errorMessage(unreachable), "fetch failed");
    routes.set(
      `https://api.github.com/repos/${REPO}/git/trees/${SHA}?recursive=1`,
      () => new Response("", { status: 404 }),
    );
    const missing = await refusalOf(marketplace.stageGithub(SPEC));
    assert.equal(installCode(missing), PluginInstallProblem.DownloadFailed);
    assert.equal(errorMessage(missing), "Repository tree download failed (404)");
  });

  it("the marketplace refuses a package it stages and an index entry with a code", async () => {
    const { marketplace, routes } = await marketplaceFixture();
    const files = await exampleFiles();
    for (const [label, code, served] of packageCases(files)) {
      serveCommit(routes, served.files, served);
      assert.equal(installCode(await refusalOf(marketplace.stageGithub(SPEC))), code, label);
    }
    const notJson = await refusalOf(marketplace.stageGithub(SPEC));
    const parsed = await thrownBy(() => JSON.parse("{ not json")).catch((error: unknown) => error);
    assert.equal(errorMessage(notJson), errorMessage(parsed), "a manifest's own words stay as they were");

    routes.set(DEFAULT_INDEX_URL, indexOf([entryFor({ minStudioVersion: "99.0.0" })]));
    await marketplace.index(true);
    const target = {} as never;
    const newer = await refusalOf(marketplace.installIndex("example", target));
    assert.equal(installCode(newer), PluginInstallProblem.NeedsNewerStudio);
    const absent = await refusalOf(marketplace.installIndex("absent", target));
    assert.equal(installCode(absent), PluginInstallProblem.NotFound);
  });

  it("the registry refuses an install, a switch, a removal and a reinstall with a code", async () => {
    const f = await pluginFixture();
    try {
      const absentOn = await refusalOf(f.registry.setEnabled("absent", true));
      assert.equal(stateCode(absentOn), PluginStateRefusal.InstallFirst);
      assert.equal(errorMessage(absentOn), "Install the plugin first");
      assert.equal(installCode(await refusalOf(f.registry.remove("absent"))), PluginInstallProblem.NotFound);
      f.registry.appAccount = { id: "example", actions: [] };
      assert.equal(stateCode(await refusalOf(f.registry.remove("example"))), PluginStateRefusal.KeepsAccount);
      f.registry.appAccount = undefined;
      const taken = await copyOfExample(f.root, "taken");
      assert.equal(installCode(await refusalOf(f.registry.installLocal(taken))), PluginInstallProblem.IdTaken);

      const broken = await copyOfExample(f.root, "broken", (m) => {
        m.id = "broken";
      });
      await writeFile(path.join(broken, "plugin.json"), "{ not json");
      const invalid = await refusalOf(f.registry.installLocal(broken));
      assert.equal(installCode(invalid), PluginInstallProblem.PackageInvalid);
      const own = await inspectPackage(broken).catch((error: unknown) => error);
      assert.equal(errorMessage(invalid), errorMessage(own), "the words stay as they were");
      assert.ok(own instanceof SyntaxError, "inspecting a folder outside an install keeps its own error");

      // Loaded from a folder, it starts off: its backend is proven when the person turns it on.
      const crash = await copyOfExample(f.root, "crash", (m) => {
        m.id = "crash";
      });
      await writeFile(path.join(crash, "backend.mjs"), "process.exit(3);\n");
      await f.registry.installLocal(crash);
      assert.equal(
        installCode(await refusalOf(f.registry.setEnabled("crash", true))),
        PluginInstallProblem.BackendFailed,
      );

      const mine = await copyOfExample(f.root, "mine", (m) => {
        m.id = "mine";
      });
      await f.registry.installLocal(mine);
      await f.registry.setEnabled("mine", true);
      const wider = await copyOfExample(f.root, "wider", (m) => {
        m.id = "mine";
        m.version = "1.1.0";
        m.capabilities = ["settings", "network"];
      });
      assert.equal(installCode(await refusalOf(f.registry.installLocal(wider))), PluginInstallProblem.NeedsReview);

      const gone = await copyOfExample(f.root, "gone", (m) => {
        m.id = "gone";
      });
      await f.registry.installLocal(gone);
      await f.registry.remove("gone");
      await removeTree(gone);
      assert.equal(installCode(await refusalOf(f.registry.restore("gone"))), PluginInstallProblem.SourceGone);
      assert.equal(
        installCode(await refusalOf(f.registry.installCatalog("absent", []))),
        PluginInstallProblem.NotFound,
      );
      assert.equal(installCode(await refusalOf(f.registry.allowUnlisted("absent"))), PluginInstallProblem.NotFound);
    } finally {
      await f.close();
    }
  });

  it("loading a local folder again refuses a folder that is gone or changed, and a connector's id, with a code", async () => {
    const f = await pluginFixture();
    try {
      const yes = async () => true;
      const nowhere = path.join(f.root, "nowhere");
      assert.equal(
        installCode(await refusalOf(installLocalPlugin(f.registry, nowhere, yes))),
        PluginInstallProblem.SourceGone,
      );
      const other = await copyOfExample(f.root, "other", (m) => {
        m.id = "other";
      });
      const changed = await refusalOf(installLocalPlugin(f.registry, other, yes, "was-here"));
      assert.equal(installCode(changed), PluginInstallProblem.SourceGone);
      const manifest = await inspectPackage(other);
      const origin = { kind: PluginSourceKind.Local, directory: other };
      const connector = await refusalOf(thrownBy(() => reviewPluginInstall(f.registry, manifest, origin, ["other"])));
      assert.equal(installCode(connector), PluginInstallProblem.IdTaken);
    } finally {
      await f.close();
    }
  });

  it("main's install and update channels answer with the code; a declined update is the person's no", async () => {
    const { marketplace, routes } = await marketplaceFixture();
    const files = await exampleFiles();
    const manifest = JSON.parse(String(files["plugin.json"]));
    const installed = {
      manifest: { ...manifest, version: "0.9.0" },
      source: PluginSourceKind.Index,
      enabled: true,
      removed: false,
      health: "idle",
      state: "enabled",
      origin: { kind: PluginSourceKind.Index, repo: REPO, sha: "b".repeat(40) },
    };
    const core = { plugins: { list: () => [installed], catalog: async () => [] } };
    let market: PluginMarketplace | null = null;
    const asked: string[] = [];
    const call = pluginChannels(
      core,
      () => market,
      async (shown) => {
        asked.push(shown.id);
        return false;
      },
    );
    const starting = await call("studio:plugins.update", { id: "example" });
    assert.equal(starting.ok === false && starting.code, PluginInstallProblem.NotReady);
    market = marketplace;
    routes.set(DEFAULT_INDEX_URL, indexOf([entryFor()]));
    const absent = await call("studio:plugins.update", { id: "absent" });
    assert.equal(absent.ok === false && absent.code, PluginInstallProblem.NotFound);
    const typo = await call("studio:plugins.install-github", { spec: "acme/x" });
    assert.equal(typo.ok === false && typo.code, PluginInstallProblem.InvalidSpec);

    serveCommit(routes, files);
    const declined = await call("studio:plugins.update", { id: "example" });
    assert.deepEqual(asked, ["example"], "the trust dialog asked about the staged code");
    assert.equal(declined.ok, false, "a no to an update is not an update");
    assert.ok(declined.ok === false && isUserCancelled(new Error(declined.error)), "it is the person's no");
    assert.equal(declined.ok === false && declined.code, undefined, "and no failure's code");
    const githubDeclined = await call("studio:plugins.install-github", { spec: SPEC });
    assert.equal(githubDeclined.ok, true, "a no to an install still resolves, as before");
  });

  it("plugin_install_finished and plugin_action_finished carry the code, never the words", async () => {
    const press = {
      origin: PluginInstallOrigin.Github,
      surface: PluginInstallSurface.GithubDialog,
      id: null,
      source: null,
    };
    const download = await crossed(new CodedError(PluginInstallProblem.DownloadFailed, "Plugin download failed (503)"));
    assert.equal(installFinishedProperties(press, null, true, 5, download).code, PluginInstallProblem.DownloadFailed);
    assert.equal(installFinishedProperties(press, null, false, 5).code, undefined, "an install that ended has no code");
    const action = {
      action: PluginAction.Enable,
      plugin: { manifest: { id: "unity" }, source: PluginSourceKind.Index } as PluginInfo,
      surface: PluginSurface.PluginsPage,
    };
    const first = await crossed(new CodedError(PluginStateRefusal.InstallFirst, "Install the plugin first"));
    assert.equal(pluginActionProperties(action, ActionOutcome.Failed, 3, first).code, PluginStateRefusal.InstallFirst);
    const probe = await crossed(new CodedError(PluginInstallProblem.BackendFailed, "Plugin process exited (1)"));
    assert.equal(
      pluginActionProperties(action, ActionOutcome.Failed, 3, probe).code,
      PluginInstallProblem.BackendFailed,
    );
    assert.equal(
      pluginActionProperties(action, ActionOutcome.Ok, 3).code,
      undefined,
      "an action that went has no code",
    );
    const no = await crossed(new UserCancelledError());
    assert.equal(pluginActionProperties(action, ActionOutcome.Cancelled, 3, no).code, undefined, "a no is no failure");
    const rewind = await crossed(new CodedError(RewindRefusal.Busy, "busy"));
    assert.equal(
      installFinishedProperties(press, null, true, 5, rewind).code,
      null,
      "another domain's code is not one",
    );
    for (const [label, thrown] of HOSTILE_THROWS) {
      const refused = await crossed(thrown);
      const install = installFinishedProperties(press, null, true, 5, refused);
      const failed = pluginActionProperties(action, ActionOutcome.Failed, 3, refused);
      assert.equal(install.code, null, label);
      assert.equal(failed.code, null, label);
      assertClean(label, install);
      assertClean(label, failed);
    }
  });

  it("an install the person declines is not installed, never a failure; one that fails says its code", async () => {
    const captured: Array<{ event: string; properties: Record<string, unknown> }> = [];
    const posthog = {
      init: () => undefined,
      has_opted_out_capturing: () => false,
      opt_in_capturing: () => undefined,
      register: () => undefined,
      stopSessionRecording: () => undefined,
      capture: (event: string, properties: Record<string, unknown>) => captured.push({ event, properties }),
    } as unknown as PostHog;
    await startAnalytics({ key: "phc_test", host: "https://eu.i.posthog.com" }, { replay: false }, async () => ({
      posthog,
    }));
    const press = {
      origin: PluginInstallOrigin.Index,
      surface: PluginInstallSurface.ListingPage,
      id: "unity",
      source: null,
    };
    const declined = await crossed(new UserCancelledError());
    const failed = await crossed(new CodedError(PluginInstallProblem.CatalogMismatch, "Catalog manifest mismatch"));
    for (const thrown of [declined, failed])
      await assert.rejects(
        trackedPluginInstall(
          press,
          () => Promise.reject(thrown),
          async () => null,
          () => 0,
        ),
      );
    const finished = captured.filter((sent) => sent.event === AnalyticsEvent.PluginInstallFinished);
    assert.deepEqual(
      finished.map((sent) => [sent.properties.outcome, sent.properties.code]),
      [
        [InstallOutcome.NotInstalled, undefined],
        [InstallOutcome.Failed, PluginInstallProblem.CatalogMismatch],
      ],
    );
  });

  it("a backend's process says it exited", async () => {
    const root = await tmpDir("studio-plugin-exit-");
    const entry = path.join(root, "backend.mjs");
    await writeFile(entry, "process.exit(4);\n");
    const failures: string[] = [];
    const backend = new PluginProcess(
      PLUGIN_SDK_BACKEND,
      entry,
      async () => ({}),
      (_words: string, failure?: string) => failures.push(String(failure)),
    );
    await assert.rejects(backend.call("tool", "x", {}));
    backend.stop();
    assert.deepEqual(failures, [PluginFailure.BackendExited]);
  });

  it("a backend that exits and a refused reload say which on plugins.changed", async () => {
    const f = await pluginFixture();
    try {
      const changes: PluginChange[] = [];
      f.registry.onChange = (change) => changes.push(change);
      const crash = await copyOfExample(f.root, "crash", (m) => {
        m.id = "crash";
      });
      await writeFile(
        path.join(crash, "backend.mjs"),
        "export async function activate(){return {tool(){process.exit(9)}}}",
      );
      await f.registry.installLocal(crash);
      await f.registry.setEnabled("crash", true);
      f.registry.consent = async () => ({ approved: true, by: "user" });
      await assert.rejects(f.registry.tool("crash__greet", { name: "Ada" }, f.binding));
      assert.deepEqual(changes.at(-1), {
        id: "crash",
        reason: PluginChangeReason.Failed,
        failure: PluginFailure.BackendExited,
      });

      const edits: Array<() => void> = [];
      f.registry.watchFolder = (_directory, onChange) => {
        edits.push(onChange);
        return { close() {} };
      };
      const watched = await copyOfExample(f.root, "watched", (m) => {
        m.id = "watched";
      });
      await f.registry.installLocal(watched);
      await f.registry.setEnabled("watched", true);
      await f.registry.watch("watched", true);
      await writeFile(path.join(watched, "plugin.json"), "{ not json");
      for (const edit of edits) edit();
      await until(() =>
        changes.some((change) => change.id === "watched" && change.reason === PluginChangeReason.Failed),
      );
      const refused = changes.find((change) => change.id === "watched" && change.reason === PluginChangeReason.Failed);
      assert.equal(refused?.failure, PluginFailure.ReloadRefused);
      await f.registry.watch("watched", false);
    } finally {
      await f.close();
    }
  });

  it("plugin_failed re-checks how a plugin failed; a forged failure reads as none", () => {
    const list = [{ manifest: { id: "mine" }, source: PluginSourceKind.Local } as PluginInfo];
    const exited = { id: "mine", reason: PluginChangeReason.Failed, failure: PluginFailure.BackendExited };
    assert.deepEqual(pluginFailedProperties(exited, list), {
      plugin_ref: "local",
      failure: PluginFailure.BackendExited,
    });
    const forged: unknown[] = [...HOSTILE, 3, null, {}, "failed", PluginInstallProblem.BackendFailed, "backend_exited"];
    for (const failure of forged) {
      const sent = pluginFailedProperties({ id: "mine", reason: PluginChangeReason.Failed, failure } as never, list);
      assert.equal(sent?.failure, null, JSON.stringify(failure));
      assertClean(String(failure), sent ?? {});
    }
  });

  it("Update plugins counts failed and declined updates apart, and toasts each problem once with its code", async () => {
    const download = await crossed(new CodedError(PluginInstallProblem.DownloadFailed, "Plugin download failed (503)"));
    const declined = await crossed(new UserCancelledError());
    const plugin = (id: string, over: Partial<PluginInfo> = {}) =>
      ({
        manifest: { id, name: id, version: "1.0.0" },
        source: PluginSourceKind.Bundled,
        enabled: true,
        removed: false,
        health: "idle",
        state: "enabled",
        ...over,
      }) as PluginInfo;
    const fake = fakeStudioApi({
      pluginsList: async () => [plugin("genex", { availableVersion: "1.5.0" }), plugin("blender")],
      pluginsIndex: async () => ({
        url: "https://plugins.example.invalid/index.json",
        studioVersion: "0.1.0",
        fetchedAt: 1,
        stale: false,
        entries: [],
        updates: [{ id: "blender", installedVersion: "1.0.0", version: "2.0.0", sha: SHA }],
      }),
      pluginInstall: () => Promise.reject(download),
      pluginUpdate: () => Promise.reject(declined),
    });
    const store = createPluginsStore(fake.api);
    await Promise.all([store.refresh(), store.refreshIndex()]);
    assert.deepEqual(await store.updateAll(), [download], "a no is not a failure to toast");
    assert.deepEqual(store.getState().lastRun, { failed: 1, declined: 1 });
    const run = updatesRunProperties({
      surface: UpdatesRunSurface.SidebarButton,
      chosen: 2,
      skipped: 0,
      notUpdated: 2,
      failed: 1,
      declined: 1,
      startedAt: 0,
      now: 10,
    });
    assert.equal(run.failed, 1);
    assert.equal(run.declined, 1);

    const again = await crossed(new CodedError(PluginInstallProblem.DownloadFailed, "Plugin download failed (503)"));
    const other = await crossed(new CodedError(PluginInstallProblem.TooLarge, "Plugin download exceeds 1 byte"));
    assert.deepEqual(distinctFailures([download, again, other]), [download, other], "one cause is said once");
    const toasts: Array<[string, unknown, unknown]> = [];
    for (const failure of distinctFailures([download, again, other]))
      notifyProblem((text, tone, code) => toasts.push([text, tone, code]))(failure);
    assert.deepEqual(toasts, [
      [problemWords(download), ToastTone.Error, PluginInstallProblem.DownloadFailed],
      [problemWords(other), ToastTone.Error, PluginInstallProblem.TooLarge],
    ]);
  });
});
