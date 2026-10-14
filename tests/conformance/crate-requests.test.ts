/**
 * The crate request flow (extension ladder level 4, `src/main/crate-requests.ts`) over a fixture
 * registry with no network: an agent can request but never approve (no host method approves,
 * `studio:crates.decide` is native and refused in fixtures, a request never moves a decided
 * one), the person's decision is checked before anything is read, and each crate of the fixture
 * registry ends in the typed state the person-decides policy gives it: an advisory, a licence or a
 * ban refuses even an approved closure, a missing audit only adds a notice, and each verdict
 * names the engine that produced it. A tampered policy refuses before anything is fetched. A
 * declined request leaves no overlay entry, and a build naming that crate is refused
 * `crate-declined` before cargo runs.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createCrateRequests, crateRequestsFor, type CrateRequestDeps } from "../../src/main/crate-requests.ts";
import { assertNativeActionAllowed, ChannelClass, classifyChannel } from "../../src/main/dev/native-policy.ts";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { registerCratesIpc } from "../../src/main/ipc/crates.ts";
import {
  RustBuilds,
  type RustBuildSandboxSpec,
  type RustBuildsOptions,
  type RustStaged,
} from "../../src/main/rust-build.ts";
import { RustBuildRefusal } from "../../src/main/rust-build-diagnostics.ts";
import { CppBuildPurpose } from "../../src/shared/build-problem.ts";
import {
  CrateAuditSource,
  CrateAuditStatus,
  type CrateBlock,
  CrateCheckEngine,
  CrateDecision,
  CrateNotice,
  CrateRefusal,
  CrateRequestState,
} from "../../src/shared/crate-requests.ts";
import { CustomEvent, type CustomEventRecord, customPayload } from "../../src/shared/custom-events.ts";
import { BuildTarget, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import { HARNESS_PARAM_SCHEMAS, HostMethod } from "../../src/shared/harness-api.ts";
import type { ToolchainLock } from "../../src/shared/toolchain.ts";
import { crateOverlayLayout, overlayGrant } from "../../src/substrate/toolchain-store/crate-overlay.ts";
import {
  type BuiltinCrateRules,
  builtinCrateChecker,
  type CrateCheckInput,
  CRATE_BANS,
  CRATE_LICENCE_ALLOW,
} from "../../src/substrate/toolchain-store/crate-check.ts";
import { directoryCrateDownload, directoryCrateIndex } from "../../src/substrate/toolchain-store/crate-vendor-job.ts";
import {
  FIXTURE_ADVISORIES,
  FIXTURE_AUDITS,
  FIXTURE_BASE_LOCK,
  HOSTILE_LICENCE_CRATES,
  writeFixtureRegistry,
} from "../fixtures/crate-registry/registry.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

const RULES: BuiltinCrateRules = {
  licences: CRATE_LICENCE_ALLOW,
  advisories: FIXTURE_ADVISORIES,
  advisoryDb: "fixture",
  advisoryDbDate: "2026-10-08",
  audits: FIXTURE_AUDITS,
  bans: CRATE_BANS,
};
/** The fixture profiles' engine: the built-in rules over the fixtures' snapshot and audit list. */
const CHECKER = async () => ({ ok: true as const, checker: builtinCrateChecker(RULES) });
const LOCK: ToolchainLock = {
  version: 1,
  entries: { rust: { version: "1.99.0", sha12: "0123456789ab" } },
  digest: "0123456789abcdef".repeat(4),
};

type Listener = (event: IpcSender, payload: unknown) => Promise<IpcResult>;
/** A call from Studio's own main frame. */
const FROM_STUDIO: IpcSender = { sender: "studio", senderFrame: "main-frame" };

/** Whether an answer is a view the person declined. */
const isRefusal = (value: unknown): boolean =>
  typeof value === "object" && value !== null && "refusal" in value && value.refusal === CrateRefusal.Declined;

// No row may reach a network: the registry is a folder, and any fetch fails the file.
const realFetch = globalThis.fetch;
const fetched: string[] = [];
before(() => {
  globalThis.fetch = async (input) => {
    fetched.push(String(input));
    throw new Error("no network in the crate request suite");
  };
});
after(() => {
  globalThis.fetch = realFetch;
  assert.deepEqual(fetched, [], "no row fetched anything");
});

/** A profile with one Rust game (`pond`), the fixture registry and a shared download cache. */
async function profile(parent?: string, overrides: Partial<CrateRequestDeps> = {}) {
  const root = parent ?? (await realpath(await tmpDir("crate-requests-")));
  const registry = await writeFixtureRegistry(path.join(root, "registry"));
  const store = path.join(root, `profile-${Math.random().toString(36).slice(2)}`, "toolchains");
  const game = path.join(root, "games", "pond");
  await mkdir(game, { recursive: true });
  await writeFile(path.join(game, "genex.toml"), '[game]\ntitle = "Pond"\n');
  const events: CustomEventRecord[] = [];
  let ids = 0;
  const service = createCrateRequests({
    store,
    downloadCache: path.join(root, "download-cache"),
    index: directoryCrateIndex(registry),
    download: directoryCrateDownload(registry),
    checker: CHECKER,
    locked: async () => FIXTURE_BASE_LOCK,
    rustGame: async (project) => (project === "pond" ? { dir: game } : null),
    rustGames: async () => ["pond"],
    record: async (batch) => {
      events.push(...batch);
    },
    newId: () => `crq-${++ids}`,
    ...overrides,
  });
  return { root, store, game, events, service, registry, layout: crateOverlayLayout(store) };
}

/** Requests `name@version` for `pond` as the agent would, then decides it as the person. */
async function decided(
  service: Awaited<ReturnType<typeof profile>>["service"],
  name: string,
  version: string,
  approvals: { buildScripts?: boolean; procMacros?: boolean } = {},
) {
  const asked = await service.request({ project: "pond", name, version, reason: "the game needs it" });
  return await service.decide({ requestId: asked.requestId, decision: CrateDecision.Approve, ...approvals });
}

describe("an agent files a crate request only against a game it may work on", () => {
  it("refuses a game outside the allowed project root, and files nothing", async () => {
    const outside = await realpath(await tmpDir("crate-requests-elsewhere-"));
    const lite = await coreLite({ executionPolicy: { allowedProjectRoot: outside, runBackgroundImprovement: false } });
    try {
      await lite.core.games.scaffold("ferris", { stack: GameStack.RustWgpu, targets: [BuildTarget.Mac] });
      const api = lite.api() as unknown as Record<string, (params: unknown) => Promise<unknown>>;
      const request = api[HostMethod.CratesRequest];
      assert.ok(request);
      await assert.rejects(request({ project: "ferris", name: "tidy", version: "1.0.0", reason: "x" }));
      const listed = await crateRequestsFor(lite.core)
        .list("ferris")
        .catch(() => []);
      assert.deepEqual(listed, [], "nothing was filed");
    } finally {
      await lite.close();
    }
  });
});

describe("only the person approves a crate request", () => {
  it("has no host method that approves, decides or vendors: agents only request", () => {
    const crateMethods = Object.values(HostMethod).filter((method) => method.startsWith("crates."));
    assert.deepEqual(crateMethods, [HostMethod.CratesRequest]);
  });

  it("classifies the decision as native (refused in fixtures) and the list as fixture-safe", () => {
    assert.equal(classifyChannel("studio:crates.decide"), ChannelClass.Native);
    assert.throws(() => assertNativeActionAllowed(true, "studio:crates.decide"));
    assert.doesNotThrow(() => assertNativeActionAllowed(false, "studio:crates.decide"));
    assert.equal(classifyChannel("studio:crates.list"), ChannelClass.FixtureSafe);
  });

  const hostileParams: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["a climbing name", { name: "../tidy", version: "1.0.0" }],
    ["a name with a slash", { name: "a/b", version: "1.0.0" }],
    ["an empty name", { name: "", version: "1.0.0" }],
    ["a requirement, not a version", { name: "tidy", version: "^1.0" }],
    ["a partial version", { name: "tidy", version: "1" }],
    ["a shell word in the version", { name: "tidy", version: "1.0.0; rm -rf /" }],
  ];
  for (const [label, params] of hostileParams) {
    it(`refuses ${label} in crates.request before anything runs`, () => {
      const parsed = HARNESS_PARAM_SCHEMAS[HostMethod.CratesRequest].safeParse({ project: "pond", ...params });
      assert.equal(parsed.success, false);
    });
  }

  it("carries no decision through crates.request params", () => {
    const parsed = HARNESS_PARAM_SCHEMAS[HostMethod.CratesRequest].safeParse({
      project: "pond",
      name: "tidy",
      version: "1.0.0",
      decision: CrateDecision.Approve,
      buildScripts: true,
    });
    assert.ok(!parsed.success || !("decision" in parsed.data), "a decision never reaches the handler");
  });

  it("answers a request pending, the same request with its own id, and never approves it", async () => {
    const { service, events, layout } = await profile();
    const first = await service.request({ project: "pond", name: "tidy", version: "1.0.0", reason: "layout" });
    const again = await service.request({ project: "pond", name: "tidy", version: "1.0.0" });
    assert.deepEqual(first, { requestId: "crq-1", state: CrateRequestState.Pending, refusal: null });
    assert.deepEqual(again, first);
    assert.equal(events.filter((event) => customPayload(event, CustomEvent.CrateRequest)).length, 1);
    const grant = await overlayGrant(layout, "pond");
    assert.ok(grant.ok);
    assert.deepEqual(grant.crates, [], "a request alone vendors nothing");
  });

  it("refuses a request for a game that is not a Rust game, and for a crate already on the reviewed list", async () => {
    const { service } = await profile();
    await assert.rejects(service.request({ project: "elsewhere", name: "tidy", version: "1.0.0" }));
    await assert.rejects(service.request({ project: "pond", name: "noise", version: "0.9.0" }));
  });

  it("keeps a declined request declined when the agent asks again", async () => {
    const { service, layout } = await profile();
    const asked = await service.request({ project: "pond", name: "tidy", version: "1.0.0" });
    const view = await service.decide({ requestId: asked.requestId, decision: CrateDecision.Decline });
    assert.equal(view.state, CrateRequestState.Refused);
    assert.equal(view.refusal, CrateRefusal.Declined);
    const again = await service.request({ project: "pond", name: "tidy", version: "1.0.0" });
    assert.deepEqual(again, {
      requestId: asked.requestId,
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.Declined,
    });
    const grant = await overlayGrant(layout, "pond");
    assert.ok(grant.ok);
    assert.deepEqual(grant.crates, [], "a declined request leaves no overlay entry");
    assert.deepEqual(await readdir(layout.root).then((names) => names.sort()), ["requests.json"]);
  });

  const hostileDecisions: ReadonlyArray<readonly [string, unknown]> = [
    ["nothing", null],
    ["a list", ["crq-1", CrateDecision.Approve]],
    ["a numeric id", { requestId: 1, decision: CrateDecision.Approve }],
    ["an unknown decision", { requestId: "crq-1", decision: "yes" }],
    ["an overlong id", { requestId: "c".repeat(101), decision: CrateDecision.Approve }],
    [
      "a build-script flag that is not a boolean",
      { requestId: "crq-1", decision: CrateDecision.Approve, buildScripts: "true" },
    ],
  ];
  for (const [label, decision] of hostileDecisions) {
    it(`refuses ${label} as a decision with nothing read or recorded`, async () => {
      const { service, events, layout } = await profile();
      await service.request({ project: "pond", name: "tidy", version: "1.0.0" });
      const before = events.length;
      await assert.rejects(service.decide(decision));
      assert.equal(events.length, before);
      const grant = await overlayGrant(layout, "pond");
      assert.ok(grant.ok && grant.crates.length === 0);
      assert.equal((await service.list("pond"))[0]?.state, CrateRequestState.Pending);
    });
  }

  it("refuses a decision on an unknown request and a second decision on the same one", async () => {
    const { service } = await profile();
    await assert.rejects(service.decide({ requestId: "crq-404", decision: CrateDecision.Approve }));
    const asked = await service.request({ project: "pond", name: "tidy", version: "1.0.0" });
    await service.decide({ requestId: asked.requestId, decision: CrateDecision.Decline });
    await assert.rejects(service.decide({ requestId: asked.requestId, decision: CrateDecision.Approve }));
  });

  /** The two channels as Studio's window reaches them, in a fixture profile or a real one. */
  function channels(service: Awaited<ReturnType<typeof profile>>["service"], fixture: boolean) {
    const listeners = new Map<string, Listener>();
    const handle = createIpcHandle(
      { handle: (channel, listener) => void listeners.set(channel, listener) },
      { fixture, isStudioUi: () => true },
    );
    registerCratesIpc(handle, () => service);
    const call = async (channel: string, payload: unknown) => {
      const listener = listeners.get(channel);
      assert.ok(listener, channel);
      return await listener(FROM_STUDIO, payload);
    };
    return { call };
  }

  it("refuses studio:crates.decide in a fixture profile and passes the person's decision in a real one", async () => {
    const { service, events } = await profile();
    const asked = await service.request({ project: "pond", name: "tidy", version: "1.0.0" });
    const decision = { requestId: asked.requestId, decision: CrateDecision.Decline };
    const before = events.length;
    const refused = await channels(service, true).call("studio:crates.decide", decision);
    assert.equal(refused.ok, false);
    assert.equal(events.length, before, "a fixture's decision records nothing");
    const listed = await channels(service, true).call("studio:crates.list", { project: "pond" });
    assert.ok(listed.ok && Array.isArray(listed.value) && listed.value.length === 1);
    const badList = await channels(service, false).call("studio:crates.list", { project: 42 });
    assert.equal(badList.ok, false);
    const decided = await channels(service, false).call("studio:crates.decide", decision);
    assert.ok(decided.ok);
    assert.equal(decided.ok && isRefusal(decided.value), true);
  });

  it("files a game's [[crate_request]] rows as pending requests when the list is read", async () => {
    const { service, game, events } = await profile();
    const toml = '[game]\ntitle = "Pond"\n\n[[crate_request]]\nname = "tidy"\nversion = "1.0.0"\nreason = "layout"\n';
    await writeFile(path.join(game, "genex.toml"), toml);
    const listed = await service.list("pond");
    assert.deepEqual(
      listed.map(({ name, version, reason, state }) => ({ name, version, reason, state })),
      [{ name: "tidy", version: "1.0.0", reason: "layout", state: CrateRequestState.Pending }],
    );
    await service.list("pond");
    assert.equal(events.length, 1, "a row is filed once");
  });
});

describe("each fixture crate ends in its typed state", () => {
  const rows: ReadonlyArray<{
    label: string;
    name: string;
    version: string;
    approvals?: { buildScripts?: boolean; procMacros?: boolean };
    state: CrateRequestState;
    refusal: CrateRefusal | null;
    closureSize?: number;
    /** The notice a vendored closure carries (default none). */
    notice?: CrateNotice | null;
    /** The advisories a refused closure names. */
    advisories?: string[];
    /** The crates a refused closure names, and why each. */
    blocked?: CrateBlock[];
  }> = [
    {
      label: "a plain MIT crate",
      name: "tidy",
      version: "1.0.0",
      state: CrateRequestState.Vendored,
      refusal: null,
      closureSize: 1,
    },
    {
      label: "a crate with a dependency (optional and dev ones left out)",
      name: "outer",
      version: "0.4.0",
      state: CrateRequestState.Vendored,
      refusal: null,
      closureSize: 2,
    },
    {
      label: "a feature a dependent turns on brings its optional dependency",
      name: "featured",
      version: "0.1.0",
      state: CrateRequestState.Vendored,
      refusal: null,
      closureSize: 4,
    },
    {
      label: "a crate reusing the store's locked fastrand",
      name: "sharer",
      version: "0.1.0",
      state: CrateRequestState.Vendored,
      refusal: null,
      closureSize: 1,
    },
    {
      label: "a build script without its approval",
      name: "buildy",
      version: "0.2.0",
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.BuildScript,
    },
    {
      label: "a build script with its approval",
      name: "buildy",
      version: "0.2.0",
      approvals: { buildScripts: true },
      state: CrateRequestState.Vendored,
      refusal: null,
    },
    {
      label: "a proc macro without its approval",
      name: "macroish",
      version: "0.1.0",
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.ProcMacro,
    },
    {
      label: "a proc macro with only the build-script approval",
      name: "macroish",
      version: "0.1.0",
      approvals: { buildScripts: true },
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.ProcMacro,
    },
    {
      label: "a proc macro with its approval",
      name: "macroish",
      version: "0.1.0",
      approvals: { procMacros: true },
      state: CrateRequestState.Vendored,
      refusal: null,
    },
    {
      label: "an advisory in the pinned snapshot",
      name: "leaky",
      version: "0.3.0",
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.Advisory,
    },
    {
      label: "a copyleft licence",
      name: "copyleft",
      version: "1.0.0",
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.Licence,
      blocked: [{ refusal: CrateRefusal.Licence, name: "copyleft", version: "1.0.0", detail: "GPL-3.0-only" }],
    },
    {
      label: "a dependency's copyleft licence, named as the dependency's",
      name: "wrapper",
      version: "0.1.0",
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.Licence,
      blocked: [{ refusal: CrateRefusal.Licence, name: "copyleft", version: "1.0.0", detail: "GPL-3.0-only" }],
    },
    {
      label: "no licence at all",
      name: "unlicensed",
      version: "1.0.0",
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.Licence,
    },
    {
      // Flipped (option C): a missing audit was `crate-unvetted`; the person's approval now decides.
      label: "a crate no trusted source audited: added on the approval, with its notice",
      name: "fresh",
      version: "0.1.0",
      state: CrateRequestState.Vendored,
      refusal: null,
      notice: CrateNotice.Unaudited,
    },
    {
      label: "a known vulnerability, though approved",
      name: "smallvec",
      version: "1.6.0",
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.Advisory,
      advisories: ["RUSTSEC-2021-0003"],
      blocked: [{ refusal: CrateRefusal.Advisory, name: "smallvec", version: "1.6.0", detail: "RUSTSEC-2021-0003" }],
    },
    {
      label: "an unsound advisory, though approved",
      name: "lru",
      version: "0.12.0",
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.Advisory,
      advisories: ["RUSTSEC-2026-0002", "RUSTSEC-2026-0253"],
    },
    {
      label: "an informational notice, though approved",
      name: "plutonium",
      version: "0.5.0",
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.Advisory,
      advisories: ["RUSTSEC-2020-0011"],
    },
    {
      label: "a known vulnerability, though build scripts and proc macros were approved too",
      name: "smallvec",
      version: "1.6.0",
      approvals: { buildScripts: true, procMacros: true },
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.Advisory,
      advisories: ["RUSTSEC-2021-0003"],
    },
    {
      label: "an unmaintained notice, which the policy lets through",
      name: "paste",
      version: "1.0.15",
      state: CrateRequestState.Vendored,
      refusal: null,
    },
    {
      label: "a withdrawn advisory, which the policy lets through",
      name: "humantime",
      version: "2.1.0",
      state: CrateRequestState.Vendored,
      refusal: null,
    },
    {
      label: "a crate the vendored-set policy bans",
      name: "glow",
      version: "0.13.0",
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.Banned,
      blocked: [{ refusal: CrateRefusal.Banned, name: "glow", version: "0.13.0", detail: null }],
    },
    {
      label: "a second version of a locked crate",
      name: "twin",
      version: "0.1.0",
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.DuplicateVersion,
    },
    {
      label: "a yanked version",
      name: "oldie",
      version: "0.1.0",
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.Yanked,
    },
    {
      label: "a yanked version of a live crate",
      name: "tidy",
      version: "1.0.1",
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.Yanked,
    },
    {
      label: "a crate the registry does not have",
      name: "nothere",
      version: "1.0.0",
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.NotFound,
    },
    {
      label: "bytes the index's sha256 does not name",
      name: "wrongsum",
      version: "0.1.0",
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.OverlayTampered,
    },
    {
      label: "an archive that climbs out of its folder",
      name: "climber",
      version: "0.1.0",
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.OverlayTampered,
    },
  ];
  for (const row of rows) {
    it(`${row.label}: ${row.refusal ?? row.state}`, async () => {
      const { service, layout, events, root } = await profile();
      const view = await decided(service, row.name, row.version, row.approvals);
      assert.equal(view.state, row.state);
      assert.equal(view.refusal, row.refusal);
      if (row.closureSize !== undefined) assert.equal(view.closureSize, row.closureSize);
      if (row.state === CrateRequestState.Vendored) {
        assert.equal(view.check?.notice, row.notice ?? null, JSON.stringify(view.check));
        assert.equal(view.check?.licenceAllowed, true);
      }
      if (row.advisories) assert.deepEqual(view.check?.advisories, row.advisories);
      if (row.blocked) assert.deepEqual(view.check?.blocked, row.blocked);
      const grant = await overlayGrant(layout, "pond");
      assert.ok(grant.ok);
      const granted = grant.crates.map((crate) => crate.name);
      assert.equal(granted.includes(row.name), row.state === CrateRequestState.Vendored);
      const decisions = events.map((event) => customPayload(event, CustomEvent.CrateDecision)).filter(Boolean);
      assert.equal(decisions.at(-1)?.state, row.state);
      assert.equal(decisions.at(-1)?.refusal, row.refusal);
      // The job and its incoming archives are gone, and nothing climbed out of them.
      assert.deepEqual(await readdir(layout.jobs).catch(() => []), []);
      assert.deepEqual(await readdir(layout.incoming).catch(() => []), []);
      assert.ok(!(await readdir(root)).includes("escaped.txt"));
    });
  }

  it("refuses a request for one of the engine's own crates: one the store's lock holds off the reviewed list", async () => {
    const locked = async () => [...FIXTURE_BASE_LOCK, { name: "tidy", version: "1.0.0" }];
    const { service, layout } = await profile(undefined, { locked });
    const view = await decided(service, "tidy", "1.0.0");
    assert.deepEqual([view.state, view.refusal], [CrateRequestState.Refused, CrateRefusal.EngineCrate]);
    assert.equal(view.closureSize ?? 0, 0, "the person is never shown an empty closure that passes");
    const grant = await overlayGrant(layout, "pond");
    assert.ok(grant.ok);
    assert.deepEqual(
      grant.crates.map((crate) => crate.name),
      [],
      "nothing granted",
    );
  });

  it("adds nothing without an advisory snapshot, and waits for the person again: crate-checker-unavailable", async () => {
    // Flipped: this was refused `crate-advisory` for good; a missing checker is its own typed code,
    // and the request waits so the person can approve again once the checker is there.
    let snapshot: BuiltinCrateRules["advisories"] = null;
    const checker = async () => ({
      ok: true as const,
      checker: builtinCrateChecker({ ...RULES, advisories: snapshot }),
    });
    const { service, layout } = await profile(undefined, { checker });
    const asked = await service.request({ project: "pond", name: "tidy", version: "1.0.0" });
    const view = await service.decide({ requestId: asked.requestId, decision: CrateDecision.Approve });
    assert.deepEqual([view.state, view.refusal], [CrateRequestState.Pending, CrateRefusal.CheckerUnavailable]);
    const grant = await overlayGrant(layout, "pond");
    assert.ok(grant.ok && grant.crates.length === 0);
    snapshot = RULES.advisories;
    const again = await service.decide({ requestId: asked.requestId, decision: CrateDecision.Approve });
    assert.deepEqual([again.state, again.refusal], [CrateRequestState.Vendored, null]);
  });

  it("clears an earlier refusal once the person approves again: the approved record and event carry none", async () => {
    let snapshot: BuiltinCrateRules["advisories"] = null;
    const seen: Array<{ state: CrateRequestState; refusal: CrateRefusal | null }> = [];
    let service: Awaited<ReturnType<typeof profile>>["service"] | null = null;
    const checker = async () => ({
      ok: true as const,
      checker: {
        check: async (input: CrateCheckInput) => {
          const [mid] = (await service?.list("pond")) ?? [];
          if (mid) seen.push({ state: mid.state, refusal: mid.refusal });
          return await builtinCrateChecker({ ...RULES, advisories: snapshot }).check(input);
        },
      },
    });
    const made = await profile(undefined, { checker });
    service = made.service;
    const asked = await service.request({ project: "pond", name: "tidy", version: "1.0.0" });
    const first = await service.decide({ requestId: asked.requestId, decision: CrateDecision.Approve });
    assert.equal(first.refusal, CrateRefusal.CheckerUnavailable);
    snapshot = RULES.advisories;
    await service.decide({ requestId: asked.requestId, decision: CrateDecision.Approve });
    assert.deepEqual(seen.at(-1), { state: CrateRequestState.Approved, refusal: null }, "the ledger mid-check");
    const approved = made.events
      .map((event) => customPayload(event, CustomEvent.CrateDecision))
      .filter((payload) => payload?.state === CrateRequestState.Approved)
      .at(-1);
    assert.equal(approved?.refusal, null, "the approved event carries no stale refusal");
    assert.equal(approved?.check, null);
  });

  it("waits for the person again when the check itself failed, with its own code: crate-check-failed", async () => {
    const checker = async () => ({
      ok: true as const,
      checker: {
        check: async () => ({
          ok: false as const,
          refusal: CrateRefusal.CheckFailed,
          detail: "the crate checker did not finish in time",
          report: null,
        }),
      },
    });
    const { service, layout } = await profile(undefined, { checker });
    const view = await decided(service, "tidy", "1.0.0");
    assert.deepEqual([view.state, view.refusal], [CrateRequestState.Pending, CrateRefusal.CheckFailed]);
    const grant = await overlayGrant(layout, "pond");
    assert.ok(grant.ok && grant.crates.length === 0);
  });

  it("says no audit list was asked, rather than unaudited, when no trusted source's list is installed", async () => {
    const checker = async () => ({ ok: true as const, checker: builtinCrateChecker({ ...RULES, audits: {} }) });
    const { service } = await profile(undefined, { checker });
    const view = await decided(service, "tidy", "1.0.0");
    assert.equal(view.state, CrateRequestState.Vendored);
    assert.ok(view.check?.audits.every((row) => row.status === CrateAuditStatus.Unavailable));
    assert.equal(view.check?.notice, CrateNotice.NoAuditLists);
  });

  it("refuses with crate-policy-tampered before anything is fetched, and adds nothing", async () => {
    const asked: string[] = [];
    const tampered = async () => ({
      ok: false as const,
      refusal: CrateRefusal.PolicyTampered,
      detail: "the shipped crate policy is not the pinned one",
    });
    const { service, layout, root, registry } = await profile(undefined, { checker: tampered });
    const index = directoryCrateIndex(registry);
    const counting = await profile(root, {
      checker: tampered,
      index: {
        versions: async (name) => {
          asked.push(name);
          return await index.versions(name);
        },
      },
    });
    for (const run of [service, counting.service]) {
      const view = await decided(run, "tidy", "1.0.0");
      assert.deepEqual([view.state, view.refusal], [CrateRequestState.Refused, CrateRefusal.PolicyTampered]);
      assert.equal(view.check, null, "no check ran");
    }
    assert.deepEqual(asked, [], "the registry was never asked");
    assert.deepEqual(await readdir(path.join(root, "download-cache")).catch(() => []), [], "nothing was fetched");
    for (const found of [layout, counting.layout]) {
      const grant = await overlayGrant(found, "pond");
      assert.ok(grant.ok && grant.crates.length === 0);
      assert.deepEqual(await readdir(found.vendor).catch(() => []), []);
    }
  });

  it("names the engine and every trusted source's answer, in the view, the ledger and the decision event", async () => {
    const { service, events, store } = await profile();
    const view = await decided(service, "tidy", "1.0.0");
    assert.equal(view.state, CrateRequestState.Vendored);
    assert.deepEqual(view.check, {
      engine: CrateCheckEngine.Builtin,
      engineVersion: null,
      auditEngine: CrateCheckEngine.Builtin,
      auditEngineVersion: null,
      advisoryDb: "fixture",
      advisoryDbDate: "2026-10-08",
      advisories: [],
      blocked: [],
      licenceAllowed: true,
      audits: Object.values(CrateAuditSource).map((source) => ({
        source,
        status: source === CrateAuditSource.Mozilla ? CrateAuditStatus.Audited : CrateAuditStatus.Unavailable,
      })),
      notice: null,
    });
    const decision = events
      .map((event) => customPayload(event, CustomEvent.CrateDecision))
      .filter(Boolean)
      .at(-1);
    assert.deepEqual(decision?.check, view.check);
    const reread = createCrateRequests({
      store,
      downloadCache: path.join(store, "..", "cache"),
      index: { versions: async () => null },
      download: async () => {},
      checker: CHECKER,
      locked: async () => [],
      rustGame: async () => null,
      rustGames: async () => [],
      record: async () => {},
    });
    assert.deepEqual((await reread.list("pond"))[0]?.check, view.check, "the ledger keeps the report");
  });

  it("shows the person the licence, closure size and flags once the closure is read", async () => {
    const { service } = await profile();
    const view = await decided(service, "buildy", "0.2.0");
    assert.equal(view.licence, "MIT");
    assert.equal(view.closureSize, 1);
    assert.equal(view.buildScripts, true);
    assert.equal(view.procMacros, false);
  });
});

describe("a licence the host cannot read, or a licence file outside the crate, is refused before any checker runs", () => {
  /** A checker that passes every closure (as an empty one) and records each closure it was asked about. */
  const passing = (asked: string[][]) => async () => ({
    ok: true as const,
    checker: {
      check: async (input: CrateCheckInput) => {
        asked.push(input.crates.map((crate) => crate.name));
        return await builtinCrateChecker(RULES).check({ ...input, crates: [] });
      },
    },
  });
  for (const crate of HOSTILE_LICENCE_CRATES) {
    it(`${crate.name} (${(crate.licenceLines ?? []).join("; ")}): crate-licence, nothing adopted`, async () => {
      const asked: string[][] = [];
      const { service, layout, root } = await profile(undefined, { checker: passing(asked) });
      const view = await decided(service, crate.name, crate.version);
      assert.deepEqual(
        [view.state, view.refusal],
        [CrateRequestState.Refused, CrateRefusal.Licence],
        JSON.stringify(view),
      );
      assert.ok(!asked.some((names) => names.includes(crate.name)), "the checker never saw it");
      const grant = await overlayGrant(layout, "pond");
      assert.ok(grant.ok && grant.crates.length === 0, "nothing adopted");
      assert.deepEqual(await readdir(layout.vendor).catch(() => []), []);
      assert.deepEqual(await readdir(layout.jobs).catch(() => []), []);
      assert.ok(!(await readdir(root)).includes("escaped.txt"));
    });
  }
});

describe("a build naming a refused crate is refused with its code before cargo runs", () => {
  /** A lane whose stager names `dependencies` and whose sandbox records what it was asked. */
  async function lane(root: string, grantFor: RustBuildsOptions["crateGrant"], dependencies: readonly string[]) {
    const vendor = path.join(root, "store-vendor");
    await mkdir(path.join(vendor, "fastrand-2.5.0"), { recursive: true });
    const specs: RustBuildSandboxSpec[] = [];
    const runs: string[] = [];
    const builds = new RustBuilds({
      root: path.join(root, "rust-builds"),
      sandbox: async (spec) => {
        specs.push(spec);
        return {
          run: async (request) => {
            runs.push(request.command);
            return {
              code: 1,
              signal: null,
              stdout: "",
              stderr: "stopped by the test",
              durationMs: 0,
              timedOut: false,
              truncated: false,
              sandboxed: false,
              command: request.command,
              cwd: request.cwd,
            };
          },
          dispose: async () => {},
        };
      },
      locate: async () => ({
        ok: true,
        toolchain: { bin: path.join(root, "bin"), vendor, clippyConf: root, reads: [] },
      }),
      currentLock: async () => LOCK,
      stage: async (): Promise<RustStaged> => ({ ok: true, dependencies }),
      emit: () => {},
      platform: "darwin",
      cores: 8,
      denyWrite: [],
      writeLock: async () => {},
      exec: async (file) => ({ code: 0, stdout: file.endsWith("xcode-select") ? "/clt\n" : "/sdk\n", stderr: "" }),
      crateGrant: grantFor,
    });
    return { builds, specs, runs, vendor };
  }

  it("crate-declined for a declined crate, and nothing runs", async () => {
    const { service, game, root } = await profile();
    const asked = await service.request({ project: "pond", name: "tidy", version: "1.0.0" });
    await service.decide({ requestId: asked.requestId, decision: CrateDecision.Decline });
    const { builds, runs } = await lane(root, (project) => service.grantFor(project), ["genex", "tidy"]);
    const outcome = await builds.ensure(
      {
        project: "pond",
        dir: game,
        shape: {
          entry: "index.html",
          main: "src/main.rs",
          build: null,
          install: null,
          own: false,
          kind: ProjectKind.RustWgpu,
          serve: ".",
        },
        destinations: { stack: GameStack.RustWgpu, targets: [BuildTarget.Mac] },
      },
      BuildTarget.Mac,
      CppBuildPurpose.Live,
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.rust?.refusal, RustBuildRefusal.DependencyNotAllowed);
    assert.deepEqual(
      outcome.rust?.crate,
      { name: "tidy", refusal: CrateRefusal.Declined },
      "typed, never read out of the line",
    );
    assert.ok(!runs.some((command) => command.includes("cargo")), "no cargo ran");
  });
});
