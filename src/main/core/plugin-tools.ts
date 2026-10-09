import { consentAudience, priorConsentDecline } from "./consent-audience.ts";
/**
 * Plugin and connector tools as agents call them: the consent a confirmed tool waits for, the
 * call itself with its durable record, and the MCP servers a plugin declares. Composed by
 * `StudioCore`; its state stays in the core.
 */
import { PluginConsentDeclined, type PluginMcpLaunch } from "../../substrate/plugins/registry.ts";
import { PluginCallCutOff } from "../../substrate/plugins/process.ts";
import { containedReal } from "../../substrate/paths.ts";
import { finishedPayload, roleOf, startedPayload } from "../plugin-activity.ts";
import type { PluginToolStartedPayload } from "../../shared/game-assets.ts";
import {
  CallCutOff,
  type PluginBinding,
  PluginCallBlocker,
  type PluginConsentBy,
  type PluginConsentEvent,
  type PluginInfo,
  type PluginMcpServer,
  PLUGIN_SKILL_TOOL,
  PluginSourceKind,
  type PluginTool,
  PluginToolAudience,
} from "../../shared/plugins.ts";
import type { McpPluginServer } from "../../substrate/mcp/registry.ts";
import { ConnectorCallError, type McpLaunch } from "../../substrate/mcp/client.ts";
import { secretKey } from "../../substrate/mcp/store.ts";
import { genexTelemetryEnv } from "../../substrate/genex-telemetry.ts";
import { type ConnectorCall, type ConnectorToolEvent, McpHealth, type McpChange } from "../../shared/mcp.ts";
import { connectorCallFields, keepCaptures } from "./connector-record.ts";
import { noteCutOff } from "./cut-off-calls.ts";
import { isLockRefused, type LockRefused } from "./plugin-locks.ts";
import { EMPTY_HOOK_REPORT, HookEvent, type HookReport } from "../../shared/plugin-hooks.ts";
import { GenexStudioTool } from "./genex-cli-prompts.ts";
import { type RunCreditCap, RunCreditLedger } from "./run-credits.ts";
import { assertPublishable } from "./genex-publish.ts";
import {
  afterKindChange,
  beforeKindChange,
  isRefused,
  type KindChange,
  type KindChangeRefused,
  madeBy,
} from "./kind-change.ts";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import { mkdir, writeFile } from "node:fs/promises";
import { shortId } from "../../substrate/ids.ts";
import type { LiveToolResult } from "../../substrate/engines/types.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { errorMessage } from "../../shared/errors.ts";
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { UiEvent } from "../../shared/ui-events.ts";

/** Nine minutes: under the Codex bridge's 600 s tool ceiling, so a slow answer still reaches the engine as "declined". */
export const CONSENT_TIMEOUT_MS = 9 * MINUTE_MS;

/** The consent card shows 120 characters of the arguments; the thread keeps this much of them, forever. */
export const CONSENT_ARGS_MAX = 2000;

/** How much of a connector's answer the thread event keeps. The log is a story, not a cache. */
export const CONNECTOR_RESULT_CAP = 4096;

/** An agent may send a connector a big argument, but not an unbounded one. */
export const CONNECTOR_ARGS_CAP = 256 * 1024;

/** The CLI's virtual env path; `src/genex-host/preload.mjs` serves the sign-in record beside it. */
export const GENEX_CREDENTIAL_PATH = "/__studio_genex_credentials__";
/** Where a `node` plugin server reads its bare account token: the pipe itself. */
export const PLUGIN_CREDENTIAL_FD = "/dev/fd/3";

/** A project name, as every path-joining site in this file spells it. */
export const PLUGIN_MCP_PROJECT = /^[a-zA-Z0-9_-]{1,100}$/;

/** The folder a plugin server with no project of its own works in, beside the per-project ones. */
export const PLUGIN_MCP_SHARED = "_shared";

/** Why a plugin's MCP server cannot start, as the connector panel and the agent read it. */
const MESSAGE = {
  exportConfirmation: "Review the files that will be uploaded. Approve only if this staged copy is ready to share.",
  connectorConversation: "Connector calls require a game conversation for consent",
  connectorConfirmation: (name: string) => `Let the agent use ${name}?`,
  unlockFirst: "Unlock this plugin's account first.",
  setSettingFirst: (key: string) => `Set "${key}" in this plugin's settings first.`,
  bundledOnly: "Only the bundled plugin may start a program Studio ships",
  inPlan:
    "The chat is in Plan mode, so this action did not run: plugin and connector actions wait until the plan is approved. Put it in your plan instead.",
  unknownTool: (name: string) => `Unknown tool: ${name}`,
} as const;

/** The answer, never an error, of a plugin call the chat's Plan mode held back. */
const PLAN_ANSWER = { consent: "declined", blocker: PluginCallBlocker.PlanMode, message: MESSAGE.inPlan } as const;

/** The answer, never an error, of a plugin call whose lock was not given in time: like a declined consent. */
const lockAnswer = (refused: LockRefused) =>
  ({
    consent: "declined",
    blocker: PluginCallBlocker.Lock,
    lock: refused.label,
    reason: refused.code,
    message: refused.message,
  }) as const;

/** The answer, never an error, of an agent's call the person declined or whose lock was not given; null for any other failure. */
function declinedAnswer(err: unknown): object | null {
  if (isLockRefused(err)) return lockAnswer(err);
  if (!(err instanceof PluginConsentDeclined)) return null;
  return {
    consent: "declined",
    blocker: "approval_required",
    by: err.by,
    message: CONSENT_DECLINED_MESSAGES[err.by],
  };
}

/** Nothing to let go: a call that needs no lock. */
const NO_RELEASE = (): void => {};

/** The plugin whose MCP server is Studio's own Genex CLI, seeded with a tools workspace. */
const GENEX_PLUGIN_ID = "genex";

/** A manifest env source (`PluginMcpEnvValue`): its prefix, and what follows it. */
const ENV_SOURCE = {
  CredentialFile: "credential-file",
  Literal: "literal:",
  Setting: "setting:",
  Secret: "secret:",
} as const;

/** Who made a plugin call: its engine, the run session it works for, and whether it is a build's lead's. */
export interface PluginCallContext {
  engine: string;
  selfCapture?: { runId?: string; facetId?: string; iteration?: number } | null;
  director?: { runId?: string } | null;
  /** A run's sub-agent: its calls are recorded under its run, on its own part (the agent id). */
  attribution?: { runId: string; agentId: string } | null;
  /** The run's Genex credit cap its paid calls count against (`run-credits.ts`); none without one. */
  credits?: RunCreditCap | null;
  /** Who is calling: the harness's own step, or an agent (absent). A tool kept for the harness runs only for the harness. */
  caller?: PluginToolAudience;
  /** A harness step that writes (a chat's checkpoint, a run's save point or editor change): Plan mode holds it back. */
  checkpoint?: boolean;
  /**
   * The worker the call is made by (`workerHolder`): it passes the locks that worker holds for its
   * whole life (an in-place writer's), still giving way to the person. The lead's calls carry none.
   */
  holder?: string;
  /**
   * A build's lead's call, the chat's main agent's: its consent card outlives the chat's turns, as
   * its tool permission cards do, and is asked each time, never answered by an earlier decline in
   * its run, as the chat's own session's.
   */
  lead?: boolean;
}

/** How a connector call is made, beyond its name, arguments and game. */
export interface ConnectorCallOptions {
  /** A build's lead's call: its card and the call outlive the chat's turns, ending with its own session. */
  outlivesTurn?: boolean;
  /**
   * Whether the run the calling session works for covers this call with its own consent, so no card
   * is shown: the Unreal Loop's lead calling its game's engine connector (the host's
   * delegation decides, `DelegationService`). Asked only when Plan mode, a saved "always allow" and
   * Bypass have not settled the call; Plan mode always refuses first.
   */
  runConsent?: () => Promise<boolean>;
  /**
   * The run the calling session works for (a run's worker or sub-agent, the Unreal Loop's lead):
   * its call answers to the Plan mode and Bypass of the chat that run was started in, not to the
   * thread the session reports on.
   */
  runId?: string;
  /** The worker the call is made by, as `PluginCallContext.holder`. */
  holder?: string;
}

export class PluginToolService {
  readonly #core: StudioCore;
  /** What each run's Genex jobs committed, against its cap. */
  readonly #credits = new RunCreditLedger();
  readonly #x: Pick<
    CoreInternals,
    | "activeConnectorCalls"
    | "bypassing"
    | "consent"
    | "cutOffCalls"
    | "hooks"
    | "locks"
    | "mcpSecrets"
    | "planning"
    | "pluginCallAttribution"
  >;

  constructor(
    core: StudioCore,
    x: Pick<
      CoreInternals,
      | "activeConnectorCalls"
      | "bypassing"
      | "consent"
      | "cutOffCalls"
      | "hooks"
      | "locks"
      | "mcpSecrets"
      | "planning"
      | "pluginCallAttribution"
    >,
  ) {
    this.#core = core;
    this.#x = x;
  }

  // ── plugin consent ───────────────────────────────────────────────────────────────────────
  /**
   * An agent asked to run a plugin tool the manifest marks `confirmation`. The question goes
   * into the thread's log as a `plugin_consent` card, the UI is nudged, and the call waits for
   * the user's answer (or the timeout, the turn's end, or Stop); the answer is logged the same
   * way. The registry calls this through `plugins.consent`; nothing an engine can reach does.
   */
  async requestConsent(
    pluginId: string,
    tool: PluginTool,
    args: Record<string, unknown>,
    binding: PluginBinding,
    signal?: AbortSignal,
    exportReview?: PluginConsentEvent["exportReview"],
    options: { offerAlways?: boolean; displayName?: string } = {},
  ): Promise<{ approved: boolean; by: PluginConsentBy; always?: boolean }> {
    const consentId = shortId("consent");
    const attribution = this.#x.pluginCallAttribution.get(binding);
    const threadId = await consentAudience(this.#core, binding, attribution?.runId);
    const name = `${pluginId}__${tool.name}`;
    const declined = await this.#declinedBefore(attribution, threadId, name, args);
    if (declined) return declined;
    const base = {
      consentId,
      pluginId,
      pluginName: options.displayName ?? this.#pluginName(pluginId),
      tool: name,
      args: consentArgsDigest(args),
      project: binding.project,
      ...consentThreads(binding.threadId, threadId, attribution),
      prompt: tool.confirmation ?? "",
      ...(exportReview ? { exportReview } : {}),
      ...(options.offerAlways ? { alwaysOffered: true } : {}),
    };
    const asked: PluginConsentEvent = {
      ...base,
      state: "pending",
      expiresAt: Date.now() + (this.#core.options.consentTimeoutMs ?? CONSENT_TIMEOUT_MS),
    };
    const waitStarted = performance.now();
    const waiting = this.#x.consent.request({
      consentId,
      pluginId,
      tool: name,
      project: binding.project,
      ...(binding.threadId ? { threadId: binding.threadId } : {}),
      ...(signal ? { signal } : {}),
      // A build's lead is not the chat's turn: another turn ending leaves its question waiting.
      ...(attribution?.lead ? { outlivesTurn: true } : {}),
    });
    try {
      await this.#core.append([customEventData(CustomEvent.PluginConsent, { ...asked })], threadId);
      this.#core.emit(UiEvent.PluginConsent, {
        consentId,
        threadId,
        project: binding.project,
        state: asked.state,
      });
    } catch (error) {
      this.#x.consent.resolve(consentId, false);
      await waiting;
      throw error;
    }
    const result = await waiting;
    const answered: PluginConsentEvent = {
      ...base,
      state: result.approved ? "approved" : "declined",
      by: result.by,
      ...(result.always ? { always: true } : {}),
      durationMs: performance.now() - waitStarted,
    };
    await this.#core.append([customEventData(CustomEvent.PluginConsent, { ...answered })], threadId);
    this.#core.emit(UiEvent.PluginConsent, {
      consentId,
      threadId,
      project: binding.project,
      state: answered.state,
    });
    return result;
  }

  /**
   * The answer a run's session already gave: declined once, it is not asked again until the run is
   * resumed. A build's lead, the chat's main agent, is asked each time, as the chat's own session is.
   */
  async #declinedBefore(
    attribution: { runId?: string; lead?: boolean } | undefined,
    threadId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ approved: boolean; by: PluginConsentBy } | null> {
    if (attribution?.lead) return null;
    return priorConsentDecline(this.#core, threadId, attribution?.runId, name, consentArgsDigest(args));
  }

  /**
   * Whether the chat a call answers to — the chat itself, or the chat a run's call reports to —
   * is in Plan mode.
   */
  async #planning(project: string, threadId: string | undefined, runId?: string): Promise<boolean> {
    if (!threadId) return false;
    const binding: PluginBinding = { project, directory: this.#core.games.dirFor(project), threadId };
    return this.#x.planning(await consentAudience(this.#core, binding, runId));
  }

  /** Whether the chat a call answers to is in Bypass, as `#planning` finds that chat. */
  async #bypassing(project: string, threadId: string | undefined, runId?: string): Promise<boolean> {
    if (!threadId) return false;
    const binding: PluginBinding = { project, directory: this.#core.games.dirFor(project), threadId };
    return this.#x.bypassing(await consentAudience(this.#core, binding, runId));
  }

  /** The name a consent card shows: the connector's or plugin's own, else its id. */
  #pluginName(pluginId: string): string {
    return (
      this.#core.mcp.nameOf(pluginId) ??
      this.#core.plugins.list().find((p) => p.manifest.id === pluginId)?.manifest.name ??
      pluginId
    );
  }

  /** A plugin gets the staged public copy only after the person reviews its exact file set. */
  async reviewExport(
    pluginId: string,
    binding: PluginBinding,
    result: { included: string[]; excluded: string[] },
  ): Promise<void> {
    const tool: PluginTool = {
      name: "export_review",
      description: MESSAGE.exportConfirmation,
      confirmation: MESSAGE.exportConfirmation,
      parameters: { type: "object", properties: {} },
    };
    const review = { included: [...result.included].sort(), excluded: [...result.excluded].sort() };
    const grant = await this.requestConsent(pluginId, tool, { files: review.included }, binding, undefined, review);
    if (!grant.approved) throw new PluginConsentDeclined(tool.name, grant.by);
  }

  /**
   * Run a plugin tool for an agent, on either path (an engine's live tool or the harness's
   * `plugins.invoke`). The host writes the `plugin_tool_started` / `plugin_tool` pair around the
   * call so the chat and the Builds graph see it start and end; a declined consent is an answer
   * the agent can read, never an error. A tool only the harness calls is a step of its own loop
   * (an editor poll, a save), not an agent's work: it runs only when the harness says so
   * (`ctx.caller`), with no pair, or a run's polls would bury the calls the chat and the graph are
   * for. A run's call answers to the Plan mode of the chat the run was started in. A tool that
   * changes what the game is (`makes`) is refused while a run of the game is going, and otherwise
   * snapshots the game first and records what it replaced (`kind-change.ts`).
   */
  async invokePluginTool(
    name: string,
    args: Record<string, unknown>,
    binding: PluginBinding,
    signal: AbortSignal | undefined,
    ctx: PluginCallContext,
  ): Promise<unknown> {
    if (this.#harnessStep(name)) return this.#runHarnessStep(name, args, binding, signal, ctx);
    if (!readsSkill(name) && (await this.#planning(binding.project, binding.threadId, callRun(ctx)?.runId)))
      return { ...PLAN_ANSWER };
    // The plugin's own `tool.before` steps, before anything is recorded or held: a block is the answer.
    const before = await this.#ownToolMoment(HookEvent.ToolBefore, name, args, binding, signal, ctx);
    if (before.blocked) return { blocked: before.blocked.reason };
    const kindChange = await this.#beforeKindChange(name, binding);
    if (kindChange && isRefused(kindChange)) return kindChange;
    const started = await this.pluginToolStarted(name, args, binding, ctx);
    let result: unknown;
    try {
      result = await this.#callAgentTool(name, args, binding, signal, ctx);
    } catch (err) {
      await this.pluginToolFinished(started, { error: err }, 0, binding);
      const declined = declinedAnswer(err);
      if (declined) return declined;
      throw err;
    }
    // Counted before the bytes are split off downstream: the record that reaches the log never holds them.
    const returned = (result as { images?: unknown } | null)?.images;
    const count = Array.isArray(returned) ? returned.length : 0;
    await this.pluginToolFinished(started, { result }, count, binding);
    const answered = kindChange ? await afterKindChange(this.#core, kindChange, result) : result;
    const after = await this.#ownToolMoment(HookEvent.ToolAfter, name, args, binding, signal, ctx);
    return withHookNotes(answered, after.notes);
  }

  /**
   * A `tool.*` moment around an agent's call of a plugin's own tool: only that plugin's steps run,
   * told the tool and a digest of its arguments, never the arguments, under the caller's holder (a
   * worker writing in place passes its own locks). A skill read is no action.
   */
  async #ownToolMoment(
    on: typeof HookEvent.ToolBefore | typeof HookEvent.ToolAfter,
    name: string,
    args: Record<string, unknown>,
    binding: PluginBinding,
    signal: AbortSignal | undefined,
    ctx: PluginCallContext,
  ): Promise<HookReport> {
    if (readsSkill(name) || !binding.project) return EMPTY_HOOK_REPORT;
    const runId = callRun(ctx)?.runId;
    return this.#x.hooks.fire(
      on,
      {
        project: binding.project,
        ...(binding.threadId ? { threadId: binding.threadId } : {}),
        ...(runId ? { runId } : {}),
        tool: name,
        args: JSON.stringify(consentArgsDigest(args)),
      },
      { ...(signal ? { signal } : {}), ...(ctx.holder ? { holder: ctx.holder } : {}) },
    );
  }

  /**
   * An agent's call itself, between its records: refused before its card or Genex is asked when it
   * cannot go (a publish of a game Genex cannot export, a run's spent credit cap), its arguments
   * checked and its card answered, then run in its turn at the locks it needs, the person first,
   * the chat showing the call going meanwhile.
   */
  async #callAgentTool(
    name: string,
    args: Record<string, unknown>,
    binding: PluginBinding,
    signal: AbortSignal | undefined,
    ctx: PluginCallContext,
  ): Promise<unknown> {
    // Refused before its consent card: Genex would export an Unreal game's folder as a web game.
    if (name === GenexStudioTool.Publish) await assertPublishable(this.#core, binding.project);
    // Refused before Genex is asked: the run's paid jobs have committed its credit cap.
    const overCap = this.#credits.refusal(name, ctx.credits ?? null);
    if (overCap) throw new Error(overCap);
    // Its arguments are checked and its card answered first: a refused call never waits its turn,
    // and no lock is held while the person reads the card.
    let release = NO_RELEASE;
    const takeTurn = async (): Promise<void> => {
      release = await this.#holdNeeds(name, binding, signal, ctx.holder, callRun(ctx)?.runId);
    };
    try {
      const result = await this.#core.plugins.tool(name, args, binding, signal, undefined, undefined, takeTurn);
      this.#credits.count(name, ctx.credits ?? null, result);
      return result;
    } finally {
      release();
    }
  }

  /** A call to a tool that makes a kind of project in the bound game: refused during its run, else snapshotted first. */
  async #beforeKindChange(name: string, binding: PluginBinding): Promise<KindChange | KindChangeRefused | null> {
    const makes = madeBy(this.#core, name);
    if (makes.length === 0 || !binding.project) return null;
    return beforeKindChange(this.#core, binding.project, name, makes);
  }

  /**
   * A tool its plugin keeps for the harness: it runs only as the harness's own step, never for an
   * agent, and with no records. Plan mode holds back a step the harness marks `checkpoint` (a
   * chat's save, a run's save point, shot, play or editor change); its reads (polls and waits) run
   * while the chat plans.
   */
  async #runHarnessStep(
    name: string,
    args: Record<string, unknown>,
    binding: PluginBinding,
    signal: AbortSignal | undefined,
    ctx: PluginCallContext,
  ): Promise<unknown> {
    if (ctx.caller !== PluginToolAudience.Harness) throw new Error(MESSAGE.unknownTool(name));
    const runId = callRun(ctx)?.runId;
    if (ctx.checkpoint && (await this.#planning(binding.project, binding.threadId, runId))) return { ...PLAN_ANSWER };
    let release = NO_RELEASE;
    try {
      release = await this.#holdNeeds(name, binding, signal, ctx.holder, runId);
      return await this.#core.plugins.tool(name, args, binding, signal, PluginToolAudience.Harness);
    } catch (err) {
      if (isLockRefused(err)) return lockAnswer(err);
      throw err;
    } finally {
      release();
    }
  }

  /**
   * Hold, for one call, the locks the tool or connector `name` needs (`PluginRegistry.needsOf`):
   * in turn behind other holders, and while the person uses what one guards, until the agent's
   * wait runs out (`LockRefused`). A wait on the person is told to the chat the call answers to.
   * Answers the release; a call that needs nothing holds nothing.
   */
  async #holdNeeds(
    name: string,
    binding: PluginBinding,
    signal: AbortSignal | undefined,
    holder: string | undefined,
    runId: string | undefined,
  ): Promise<() => void> {
    const needs = this.#core.plugins.needsOf(name);
    if (!needs.length) return NO_RELEASE;
    const threadId = binding.threadId ? await consentAudience(this.#core, binding, runId) : undefined;
    return this.#x.locks.hold(needs, {
      binding,
      ...(threadId ? { threadId } : {}),
      ...(signal ? { signal } : {}),
      waitMs: this.#x.locks.agentWaitMs,
      holder: holder ?? shortId("call"),
    });
  }

  /** Whether `name` is a tool its plugin keeps for the harness's own calls (`audience: "harness"`). */
  #harnessStep(name: string): boolean {
    const [pluginId = "", tool = ""] = name.split("__");
    const manifest = this.#core.plugins.list().find((p) => p.manifest.id === pluginId)?.manifest;
    return manifest?.tools.find((t) => t.name === tool)?.audience === PluginToolAudience.Harness;
  }

  /**
   * Run one connector tool for an agent, on either path (an engine's live tool or the harness's
   * `mcp.invoke`), and write its records either way: `connector_tool_started` once the call goes
   * out (after consent), and `connector_tool` when it ends, paired by `callId`. They are their own
   * events: a connector is not a plugin, it reaches a service outside this Mac, and reusing
   * `plugin_tool` would put a name in the ledger that no installed plugin answers to.
   *
   * The records hold what the call was and how it ended — never the bytes. The arguments are
   * clipped (`connectorCallFields`); the answer's text is cut to 4 KiB, because a log is a story,
   * not a cache; its pictures are counted and kept in the game's captures folder, and the record
   * lists them. A build's lead's call outlives the chat's turns (`outlivesTurn`): its session's
   * end or a Stop ends it. A live run's call may need no card (`runConsent`).
   */
  async invokeConnectorTool(
    name: string,
    args: Record<string, unknown>,
    binding: { project?: string | null; threadId?: string } | undefined,
    signal?: AbortSignal,
    options: ConnectorCallOptions = {},
  ): Promise<LiveToolResult> {
    const outlivesTurn = options.outlivesTurn === true;
    const started = Date.now();
    const controller = new AbortController();
    this.#x.activeConnectorCalls.set(controller, { ...binding, ...(outlivesTurn ? { outlivesTurn } : {}) });
    const callSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const call = this.#connectorCall(name, args);
    let sent = false;
    let release = NO_RELEASE;
    try {
      await this.#connectorConsent(name, args, binding, callSignal, options);
      release = await this.#holdConnectorNeeds(name, binding, callSignal, options);
      await this.#appendQuietly(customEventData(CustomEvent.ConnectorToolStarted, { ...call }), binding);
      sent = true;
      const result = await this.#core.mcp.tool(name, args, binding, callSignal);
      const text = typeof result === "string" ? result : result.text;
      const images = typeof result === "string" ? [] : (result.images ?? []);
      const captures = await this.#keepConnectorCaptures(binding?.project, images);
      await this.#appendQuietly(
        customEventData(CustomEvent.ConnectorTool, {
          ...call,
          ok: true,
          durationMs: Date.now() - started,
          result: String(text ?? "").slice(0, CONNECTOR_RESULT_CAP),
          ...(images.length ? { images: images.length } : {}),
          ...(captures.length ? { captures } : {}),
        } satisfies ConnectorToolEvent),
        binding,
      );
      return result;
    } catch (err) {
      const cutOff = sent ? connectorCutOff(err, callSignal) : null;
      await this.#connectorFailed(name, call, err, cutOff, Date.now() - started, binding);
      throw err;
    } finally {
      release();
      this.#x.activeConnectorCalls.delete(controller);
    }
  }

  /** The locks a plugin's connector needs, held for its call as a plugin tool's are (after its consent). */
  #holdConnectorNeeds(
    name: string,
    binding: { project?: string | null; threadId?: string } | undefined,
    signal: AbortSignal,
    { holder, runId }: ConnectorCallOptions,
  ): Promise<() => void> {
    if (!binding?.project) return Promise.resolve(NO_RELEASE);
    const bound: PluginBinding = {
      project: binding.project,
      directory: this.#core.games.dirFor(binding.project),
      ...(binding.threadId ? { threadId: binding.threadId } : {}),
    };
    return this.#holdNeeds(name, bound, signal, holder, runId);
  }

  /**
   * A connector call's closing record when it failed. A call cut off before it answered says why
   * (`cutOff`: outcome unknown), and its thread's next delegated session is told to check it.
   */
  async #connectorFailed(
    name: string,
    call: ConnectorCall & { callId: string },
    err: unknown,
    cutOff: CallCutOff | null,
    durationMs: number,
    binding: { threadId?: string } | undefined,
  ): Promise<void> {
    if (cutOff)
      noteCutOff(this.#x.cutOffCalls, binding?.threadId, { tool: name, args: cutOffArgs(call), reason: cutOff });
    await this.#appendQuietly(
      customEventData(CustomEvent.ConnectorTool, {
        ...call,
        ok: false,
        durationMs,
        error: String(errorMessage(err)).slice(0, CONNECTOR_RESULT_CAP),
        ...(cutOff ? { cutOff } : {}),
      } satisfies ConnectorToolEvent),
      binding,
    );
  }

  /** What a connector call is, as its records name it: the connector, its plugin, the tool and the arguments. */
  #connectorCall(name: string, args: Record<string, unknown>): ConnectorCall & { callId: string } {
    const connectorId = name.slice(0, Math.max(0, name.indexOf("__")));
    const exposedName = name.slice(connectorId.length + 2);
    const pluginId = this.#core.mcp.ownerOf(connectorId);
    return {
      callId: shortId("connector"),
      connectorId,
      tool: this.#core.mcp.rawName(name) ?? exposedName,
      exposedName,
      ...(pluginId ? { pluginId } : {}),
      connectorName: this.#connectorName(connectorId),
      ...connectorCallFields(args),
    };
  }

  /** A connector's pictures, kept in its game's captures folder; bookkeeping never fails the call. */
  async #keepConnectorCaptures(
    project: string | null | undefined,
    images: ReadonlyArray<{ data: string }>,
  ): Promise<string[]> {
    if (!project || !images.length) return [];
    try {
      const dir = this.#core.games.dirFor(project);
      await this.#core.assertProjectAllowed(dir);
      return await keepCaptures(dir, images);
    } catch (error) {
      this.#core.options.onLog?.(
        `[core] could not keep ${project}'s connector pictures: ${errorMessage(error)}`,
        "stderr",
      );
      return [];
    }
  }

  /** Bookkeeping never fails a tool call: a log that cannot be written loses the record, not the work. */
  async #appendQuietly(
    record: ReturnType<typeof customEventData>,
    binding: { threadId?: string } | undefined,
  ): Promise<void> {
    await this.#core.append([record], binding?.threadId).catch(() => {});
  }

  /**
   * The person's say before a connector action nobody saved "always allow" for and no live run's
   * own consent covers. A build's lead's card outlives the chat's other turns (`outlivesTurn`), as
   * its call does.
   */
  async #connectorConsent(
    name: string,
    args: Record<string, unknown>,
    binding: { project?: string | null; threadId?: string } | undefined,
    signal: AbortSignal,
    { outlivesTurn = false, runConsent, runId }: ConnectorCallOptions,
  ): Promise<void> {
    if (!binding?.project) throw new Error(MESSAGE.connectorConversation);
    // Before any saved grant: "always allow" is for work the person approved, and a plan is not yet.
    // A run's session answers to the chat its run was started in.
    if (await this.#planning(binding.project, binding.threadId, runId)) throw new Error(MESSAGE.inPlan);
    if (await this.#core.mcp.toolAutoApproved(name, binding.project, signal)) return;
    // Bypass is the person's own "ask me nothing" for this chat; it never lifts Plan, checked above.
    if (await this.#bypassing(binding.project, binding.threadId, runId)) return;
    // The run the person started covers its own builder's editor calls; it never lifts Plan either.
    if (await runConsent?.()) return;
    const split = name.indexOf("__");
    const id = name.slice(0, split);
    const displayName = this.#connectorName(id);
    const tool: PluginTool = {
      name: name.slice(split + 2),
      description: "Connector action",
      parameters: { type: "object", properties: {} },
      confirmation: MESSAGE.connectorConfirmation(displayName),
    };
    const asking: PluginBinding = {
      project: binding.project,
      directory: this.#core.games.dirFor(binding.project),
      ...(binding.threadId ? { threadId: binding.threadId } : {}),
    };
    if (outlivesTurn) this.#x.pluginCallAttribution.set(asking, { lead: true });
    const grant = await this.requestConsent(id, tool, args, asking, signal, undefined, {
      offerAlways: true,
      displayName,
    });
    if (!grant.approved) throw new PluginConsentDeclined(name, grant.by);
    if (grant.always)
      await this.#core.mcp.alwaysAllow(name, binding.project, signal).catch((error: unknown) => {
        // The call itself was approved; only the "from now on" is lost, and the next call asks again.
        this.#core.options.onLog?.(`[core] could not save always allow for ${name}: ${errorMessage(error)}`, "stderr");
      });
  }

  /** A connector as a person knows it: a plugin's by the plugin's own name, else the connector's. */
  #connectorName(id: string): string {
    const owner = this.#core.mcp.ownerOf(id);
    const plugin = owner ? this.#core.plugins.list().find((p) => p.manifest.id === owner)?.manifest.name : undefined;
    return plugin ?? this.#pluginName(id);
  }

  /**
   * Publish one plugin's declared MCP servers as connectors that plugin owns.
   *
   * The manifest names sources, never values, and this is where they become a launch: a script
   * inside the package (or the one CLI Studio itself ships) run as `process.execPath` with
   * `ELECTRON_RUN_AS_NODE`, because a packaged app has no `node` on its PATH; a working directory
   * under the plugin's own storage, never the package, which an update replaces; a `HOME` inside
   * that directory, so a CLI's startup cannot reach the user's own dotfiles; and an environment
   * holding only what the manifest asked for.
   *
   * A credential never travels in that environment. `credential-file` sends it down an anonymous
   * pipe on fd 3, read at the moment the child starts — so a plugin locked or disconnected since
   * it was registered gets an empty pipe rather than a live token. A `node` server gets the bare
   * token and `/dev/fd/3` as the variable; Studio's own Genex CLI (`host-cli`) gets the
   * `GENEX_TOKEN=` line and the virtual path its preload answers.
   *
   * A server whose requirements are not met is published switched off with the reason on it.
   * Listing it is the point: the user can see what is missing and finish it.
   */
  async registerPluginMcpServers(pluginId: string, servers: PluginMcpServer[], launch: PluginMcpLaunch): Promise<void> {
    // Replace the plugin's whole set: a manifest that dropped a server must not leave it running.
    await this.#core.mcp.unregisterPlugin(pluginId);
    const installed = this.#core.plugins.list().find((p) => p.manifest.id === pluginId);
    const pluginName = installed?.manifest.name ?? pluginId;
    const settings = await launch.settings().catch(() => ({}) as Record<string, unknown>);
    const unlocked = (await launch.credential().catch(() => undefined)) !== undefined;
    for (const server of servers) {
      try {
        await this.#core.mcp.registerPluginServer(
          pluginId,
          await this.pluginMcpDefinition(pluginName, installed?.source, server, launch, settings, unlocked),
          this.pluginMcpLaunch(pluginId, server, launch),
        );
      } catch (error) {
        // A tool source that did not appear is not a silent non-event: it is logged and the card
        // hears about it, so a server missing from the list has a reason a person can read.
        const message = errorMessage(error);
        this.#core.options.onLog?.(
          `[core] plugin ${pluginId}: MCP server ${server.id} was not published — ${message}`,
          "stderr",
        );
        this.#core.emit(UiEvent.McpChanged, {
          id: `${pluginId}-${server.id}`,
          health: McpHealth.Failed,
          error: message,
        } satisfies McpChange);
      }
    }
  }

  async pluginMcpDefinition(
    pluginName: string,
    source: PluginInfo["source"] | undefined,
    server: PluginMcpServer,
    launch: PluginMcpLaunch,
    settings: Record<string, unknown>,
    unlocked: boolean,
  ): Promise<McpPluginServer> {
    let unavailable: string | undefined;
    if (server.requires?.credential && !unlocked) unavailable = MESSAGE.unlockFirst;
    for (const key of server.requires?.settings ?? []) {
      const value = settings[key];
      if (value === undefined || value === "") unavailable ??= MESSAGE.setSettingFirst(key);
    }
    // `node` runs a script the package contains, resolved through the same containment check an
    // install uses; `host-cli` runs Studio's own Genex CLI behind the preload that feeds it fd 3.
    // The manifest validator reserves `host-cli` for the id `genex`; an id is not a provenance, so
    // the code that actually starts it asks where the package came from as well.
    if (server.command !== "node" && source !== PluginSourceKind.Bundled) throw new Error(MESSAGE.bundledOnly);
    const args = await pluginMcpArgs(server, launch.packageDir);
    return {
      id: server.id,
      name: `${pluginName} · ${server.id}`,
      // The digest the plugin's install dialog stands behind covers exactly this.
      command: process.execPath,
      args,
      ...(server.toolPolicy ? { toolPolicy: server.toolPolicy } : {}),
      ...(server.maxTools ? { maxTools: server.maxTools } : {}),
      ...(server.callTimeoutMs ? { callTimeoutMs: server.callTimeoutMs } : {}),
      description: server.description,
      ...(server.facts ? { facts: server.facts } : {}),
      ...(unavailable ? { unavailable } : {}),
    };
  }

  pluginMcpLaunch(pluginId: string, server: PluginMcpServer, launch: PluginMcpLaunch): McpLaunch {
    const wantsCredential = Object.values(server.env ?? {}).includes(ENV_SOURCE.CredentialFile);
    const credentialPipe: Pick<McpLaunch, "extraStdio" | "stdioExtra"> = {
      extraStdio: ["pipe"],
      stdioExtra: (child: ChildProcess) => {
        const pipe = child.stdio[3] as Writable | null;
        if (!pipe) return;
        pipe.on("error", () => {
          /* the child may exit before it reads; that is not our failure */
        });
        // Read at the moment the child starts, so a plugin locked or disconnected since it was
        // published closes the pipe empty instead of handing over a live token.
        const content = server.command === "node" ? launch.credential() : launch.credentialFile();
        void content.then(
          (value) => pipe.end(value ?? ""),
          () => pipe.end(""),
        );
      },
    };
    return {
      execPath: process.execPath,
      perProject: server.cwd === "storage:project",
      resolve: async (project) => {
        const dir =
          server.cwd === "storage:project"
            ? await launch.projectStorage(project && PLUGIN_MCP_PROJECT.test(project) ? project : PLUGIN_MCP_SHARED)
            : path.join(await launch.storageRoot(), "mcp");
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const home = path.join(dir, "home");
        await mkdir(home, { recursive: true, mode: 0o700 });
        if (pluginId === GENEX_PLUGIN_ID) {
          // A tools workspace, exactly as the asset adapter seeds one: the CLI then keeps its own
          // bookkeeping here instead of in the game folder or the user's home.
          await mkdir(path.join(dir, ".genex"), { recursive: true, mode: 0o700 });
          await writeFile(
            path.join(dir, ".genex", "workspace.json"),
            `${JSON.stringify({ mode: "tools", version: 1 })}\n`,
          );
        }
        const env = await this.pluginMcpEnv(pluginId, server, launch);
        // Everything secret this start hands the child, so the connection takes it back out of
        // whatever the server answers (SEC-4): stored `secret:` values and the account token.
        const secrets = Object.entries(server.env ?? {}).flatMap(([name, source]) =>
          source.startsWith(ENV_SOURCE.Secret) && env[name] ? [env[name]] : [],
        );
        const token = wantsCredential ? await launch.credential().catch(() => undefined) : undefined;
        if (token) secrets.push(token);
        return { cwd: dir, extraEnv: { ...env, HOME: home }, ...(secrets.length ? { secrets } : {}) };
      },
      ...(wantsCredential ? credentialPipe : {}),
    };
  }

  /**
   * The manifest's env sources turned into values, at the moment the child starts. Studio's own
   * Genex CLI (`host-cli`) also gets the asset adapter's telemetry rule: crash reporting off
   * unless the user turned it on. The manifest's own entries come after, as it declared them.
   */
  async pluginMcpEnv(
    pluginId: string,
    server: PluginMcpServer,
    launch: PluginMcpLaunch,
  ): Promise<Record<string, string>> {
    // A packaged app's `process.execPath` is Electron; without this it would launch a second app.
    const env: Record<string, string> = {
      ELECTRON_RUN_AS_NODE: "1",
      NO_COLOR: "1",
      ...(server.command === "host-cli" ? genexTelemetryEnv(process.env) : {}),
    };
    const settings = await launch.settings().catch(() => ({}) as Record<string, unknown>);
    for (const [name, source] of Object.entries(server.env ?? {})) {
      const value = await this.#envValue(pluginId, server, source, settings);
      if (value !== null) env[name] = value;
    }
    return env;
  }

  /** One manifest env source's value at start, or null when it has none to give. */
  async #envValue(
    pluginId: string,
    server: PluginMcpServer,
    source: string,
    settings: Record<string, unknown>,
  ): Promise<string | null> {
    if (source === ENV_SOURCE.CredentialFile)
      return server.command === "node" ? PLUGIN_CREDENTIAL_FD : GENEX_CREDENTIAL_PATH;
    if (source.startsWith(ENV_SOURCE.Literal)) return source.slice(ENV_SOURCE.Literal.length);
    if (source.startsWith(ENV_SOURCE.Setting)) {
      const value = settings[source.slice(ENV_SOURCE.Setting.length)];
      return value !== undefined && value !== "" ? String(value) : null;
    }
    const stored = await this.#x.mcpSecrets
      ?.get(secretKey(`${pluginId}-${server.id}`, "env", source.slice(ENV_SOURCE.Secret.length)))
      .catch(() => null);
    return stored || null;
  }

  /**
   * One plugin tool call, opened. Every engine path goes through here — the delegated ones from
   * `onLiveTool`, the local harness from the `plugins.invoke` RPC — so the log holds the same
   * pair whoever asked. `runId`/`facetId`/`iteration` sit at the payload's top level because the
   * Builds graph drops any custom event whose top-level `runId` is not the run's.
   */
  async pluginToolStarted(
    name: string,
    args: Record<string, unknown>,
    binding: PluginBinding,
    ctx: PluginCallContext,
  ): Promise<{ callId: string; startedAt: number; payload: PluginToolStartedPayload }> {
    const [pluginId = "", tool = ""] = name.split("__");
    const installed = this.#core.plugins.list().find((p) => p.manifest.id === pluginId);
    const attributed = ctx.attribution ? { runId: ctx.attribution.runId, facetId: ctx.attribution.agentId } : null;
    const asked = callRun(ctx);
    const payload = startedPayload({
      pluginId,
      pluginName: installed?.manifest.name ?? pluginId,
      tool,
      toolName: name,
      args,
      project: binding.project,
      ...(binding.threadId ? { threadId: binding.threadId } : {}),
      ...(asked?.runId ? { runId: asked.runId } : {}),
      ...(asked?.facetId ? { facetId: asked.facetId } : {}),
      ...(asked?.iteration !== undefined ? { iteration: asked.iteration } : {}),
      engine: ctx.engine,
      role: roleOf({
        ...(ctx.director ? { director: ctx.director } : {}),
        ...(ctx.selfCapture ? { selfCapture: ctx.selfCapture } : {}),
        ...(attributed ? { attribution: attributed } : {}),
      }),
    });
    if (asked || ctx.lead)
      this.#x.pluginCallAttribution.set(binding, { ...asked, ...(ctx.lead ? { lead: true } : {}) });
    // Bookkeeping never fails a tool call: a log that cannot be written loses the record, not the work.
    await this.#core
      .append([customEventData(CustomEvent.PluginToolStarted, { ...payload })], binding.threadId)
      .catch(() => {});
    return { callId: payload.callId, startedAt: Date.now(), payload };
  }

  /** The same call, closed: what it answered or what it threw, with the image count taken before the bytes were stripped. */
  async pluginToolFinished(
    started: { startedAt: number; payload: PluginToolStartedPayload },
    outcome: { result: unknown } | { error: unknown },
    images: number,
    binding?: PluginBinding,
  ): Promise<void> {
    if (binding) this.#x.pluginCallAttribution.delete(binding);
    const version = this.#core.plugins.list().find((p) => p.manifest.id === started.payload.pluginId)?.manifest.version;
    const cutOff = "error" in outcome && outcome.error instanceof PluginCallCutOff ? outcome.error.reason : null;
    const { payload: call } = started;
    if (cutOff)
      noteCutOff(this.#x.cutOffCalls, call.threadId, { tool: call.toolName, args: call.args, reason: cutOff });
    const payload = {
      ...finishedPayload(call, { ...outcome, ...(version ? { version } : {}) }, images, Date.now() - started.startedAt),
      ...(cutOff ? { cutOff } : {}),
    };
    await this.#core
      .append([customEventData(CustomEvent.PluginTool, { ...payload })], started.payload.threadId)
      .catch(() => {});
  }
}

/** Where a consent card belongs: the asking thread, the chat it shows in, and the run it came from. */
function consentThreads(
  asking: string | undefined,
  shownIn: string,
  attribution: { runId?: string; facetId?: string } | undefined,
): Pick<PluginConsentEvent, "threadId" | "originThreadId" | "runId" | "facetId"> {
  return {
    ...(asking ? { threadId: asking } : {}),
    ...(asking && shownIn !== asking ? { originThreadId: asking } : {}),
    ...(attribution?.runId ? { runId: attribution.runId } : {}),
    ...(attribution?.facetId ? { facetId: attribution.facetId } : {}),
  };
}

/**
 * What the plugin was asked to do, clipped. The call itself still receives the arguments in full —
 * this is only the durable record, and a tool argument can be a whole prompt or a base64 payload,
 * which has no business sitting in the thread log at its original size.
 */
export function consentArgsDigest(args: Record<string, unknown>): Record<string, unknown> {
  const digest: Record<string, unknown> = {};
  let left = CONSENT_ARGS_MAX;
  for (const [key, value] of Object.entries(args)) {
    if (left <= 0) {
      digest["…"] = "clipped";
      break;
    }
    const encoded = typeof value === "string" ? value : JSON.stringify(value);
    const text = typeof encoded === "string" ? encoded : String(value);
    const room = Math.max(1, left - key.length);
    digest[key] = text.length > room ? `${text.slice(0, room - 1)}…` : text;
    left -= key.length + Math.min(text.length, room);
  }
  return digest;
}

/** The run session a call works for, or null for a chat's own call. */
type CallRun = { runId?: string; facetId?: string; iteration?: number };

/**
 * The run session a plugin call works for, as its context names it. The same order the Blender
 * record uses: a sub-agent's own attribution first, then the worker that owns the worktree, then
 * the modelling ask, then the director's own session.
 */
function callRun(ctx: PluginCallContext): CallRun | null {
  const attributed = ctx.attribution ? { runId: ctx.attribution.runId, facetId: ctx.attribution.agentId } : null;
  const sources = [attributed, ctx.selfCapture, ctx.director].filter((s): s is CallRun => !!s);
  return sources.find((s) => typeof s.runId === "string" && s.runId) ?? null;
}

/**
 * Why a connector call that went out ended with its outcome unknown: the harness's end cut it off
 * (its signal's reason), or the connector said the app it drives went away mid-call. Null for any
 * other failure, whose outcome its error states.
 */
function connectorCutOff(err: unknown, signal: AbortSignal): CallCutOff | null {
  if (signal.aborted && signal.reason instanceof PluginCallCutOff) return signal.reason.reason;
  if (err instanceof PluginCallCutOff) return err.reason;
  if (err instanceof ConnectorCallError && err.outcomeUnknown) return CallCutOff.AppLost;
  return null;
}

/** A connector call's arguments as a cut-off notice repeats them: the toolset's tool and its own arguments. */
function cutOffArgs(call: ConnectorCall): string {
  const named = [call.toolset, call.toolName].filter(Boolean).join(".");
  const args = call.args ? JSON.stringify(call.args) : "";
  return [named, args].filter(Boolean).join(" ");
}

/**
 * A tool's answer with its plugin's `tool.after` notes: after a text answer's words, else under
 * `genex.notes` beside the answer's own fields (and beside a note Genex already added there).
 */
function withHookNotes(result: unknown, notes: HookReport["notes"]): unknown {
  if (!notes.length) return result;
  const texts = notes.map((note) => note.text);
  if (typeof result === "string") return [result, ...texts].filter(Boolean).join("\n\n");
  if (!isRecordValue(result)) return { answer: result ?? null, genex: { notes: texts } };
  return { ...result, genex: { ...genexFields(result.genex), notes: texts } };
}

/** What an answer already holds under `genex`: a note Genex added is kept beside the plugin's notes. */
function genexFields(genex: unknown): Record<string, unknown> {
  if (typeof genex === "string") return { note: genex };
  return isRecordValue(genex) ? genex : {};
}

const isRecordValue = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A plugin's skill tool: reading how to use the plugin is planning, never an action. */
function readsSkill(name: string): boolean {
  return name.slice(name.indexOf("__") + 2) === PLUGIN_SKILL_TOOL;
}

/**
 * What the agent reads when its plugin request was not approved — an answer, never an error. A
 * card nobody answered is not a no: the person may be away, so the agent carries on and asks later.
 */
export const CONSENT_DECLINED_MESSAGES: Record<PluginConsentBy, string> = {
  user: "The user declined this request. Do not retry unless they ask.",
  timeout: `Nobody answered within ${CONSENT_TIMEOUT_MS / MINUTE_MS} minutes. The user may be away, so this is not a no: carry on with other work and ask again later.`,
  stop: "The turn was stopped before the user answered.",
  turn: "The turn was stopped before the user answered.",
  restart: "The studio restarted before the user answered. Ask again before trying this action.",
};

export const requireFromHere = createRequire(import.meta.url);

/**
 * How a plugin MCP server starts: a `node` server runs the package's own script (resolved through
 * the containment check an install uses), `host-cli` runs Studio's Genex CLI behind its preload.
 */
async function pluginMcpArgs(server: PluginMcpServer, packageDir: string): Promise<string[]> {
  if (server.command === "node") {
    const [script = "", ...rest] = server.args;
    return [await containedReal(packageDir, script), ...rest];
  }
  // A file URL: on Windows Node reads a bare `C:\…` after --import as a URL with the scheme `c:`.
  const preload = pathToFileURL(await containedReal(packageDir, "preload.mjs")).href;
  return ["--import", preload, genexCliPath(packageDir), ...server.args];
}

/**
 * The Genex CLI, resolved the way the asset adapter resolves it: the plugin's own copy when the
 * package ships one, Studio's otherwise, and rewritten out of the asar either way — a packaged
 * app cannot spawn a file that only exists inside the archive.
 */
export function genexCliPath(packageDir: string): string {
  let pkg: string;
  try {
    pkg = createRequire(path.join(packageDir, "package.json")).resolve("@genex-ai/cli-demo/package.json");
  } catch {
    pkg = requireFromHere.resolve("@genex-ai/cli-demo/package.json");
  }
  return path.join(path.dirname(pkg), "dist/index.js").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
}
