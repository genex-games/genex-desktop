import type { Activate, PluginContext, PluginScalar } from "../../plugin-sdk/index.d.ts";
import { createHash } from "node:crypto";
import { bridgeRequest, inspectUnityProject, UnityBridgeError } from "./bridge-client.ts";
import { normalUnityParams, safeUnityBatch, UNITY_GROUPS, UnityMethod, unityParams } from "./commands.ts";
import { installUnityBridge, listUnityEditors, launchUnityEditor, createUnityProject } from "./project-setup.ts";

/** Host calls remain SDK-only: this plugin can also be packaged independently of Studio. */
const Host = {
  Settings: "settings.read",
  Emit: "events.emit",
  JobsRead: "jobs.read",
  JobsWrite: "jobs.write",
} as const;
const Action = {
  Status: "status",
  Toolbar: "toolbar-status",
  Install: "install-bridge",
  Launch: "open-editor",
  Create: "create-project",
  Disconnect: "disconnect",
  Connect: "connect",
  Scenes: "scenes",
  Hierarchy: "hierarchy",
  Inspect: "inspect-object",
  Console: "console",
  Verify: "verify",
  Play: "play",
  Stop: "stop",
  Pause: "pause",
  Step: "step",
  Capture: "capture-camera",
  Tests: "run-tests",
  Build: "build-player",
  Job: "job-status",
  CancelJob: "cancel-job",
  BuildScenes: "build-scenes",
  Assets: "assets",
  AssetInspect: "inspect-asset",
} as const;
const Tool = { Status: "status", Batch: "batch", Test: "test", Build: "build", Verify: "verify" } as const;
const CONNECTION_ACTIONS: ReadonlySet<string> = new Set([
  Action.Status,
  Action.Toolbar,
  Action.Disconnect,
  Action.Connect,
]);
const MESSAGE = {
  ChooseProject:
    "Choose a Unity project in this plugin's Project folder setting, then install the bridge and open it in Unity.",
  Unknown: "Unknown Unity tool or operation.",
  Disconnected: "Unity is disconnected. Connect explicitly from the Unity plugin page.",
} as const;

/** A game that is itself a Unity project takes precedence over the explicitly selected linked project. */
async function selectedProject(ctx: PluginContext): Promise<string> {
  if (ctx.directory) {
    const local = await inspectUnityProject(ctx.directory).catch(() => null);
    if (local) return local.root;
  }
  const settings = await ctx.host(Host.Settings);
  const root = String(settings["project-path"] || "").trim();
  if (!root) throw new UnityBridgeError("not_configured", MESSAGE.ChooseProject);
  return (await inspectUnityProject(root)).root;
}

/** Consent to a connection belongs to this project, even when the plugin is reused elsewhere. */
function connectionKey(root: string) {
  const normalized = process.platform === "win32" ? root.toLowerCase().replaceAll("\\", "/") : root;
  return `disconnected-${createHash("sha256").update(normalized).digest("hex")}`;
}

/** The plugin exposes no raw discovery file or authentication token. */
async function status(ctx: PluginContext) {
  const editors = await listUnityEditors();
  try {
    const root = await selectedProject(ctx);
    const disabled = await ctx.host(Host.JobsRead, { id: connectionKey(root) });
    if (disabled === true) return { ready: false, projectRoot: root, editors, detail: MESSAGE.Disconnected };
    const editor = await bridgeRequest(root, UnityMethod.Status, {}, { signal: ctx.signal });
    return { ready: true, projectRoot: root, editors, editor };
  } catch (error) {
    return {
      ready: false,
      editors,
      code: error instanceof UnityBridgeError ? error.code : "not_connected",
      detail: error instanceof Error ? error.message : MESSAGE.ChooseProject,
    };
  }
}

async function call(ctx: PluginContext, method: string, params: Record<string, unknown>) {
  const root = await selectedProject(ctx);
  if ((await ctx.host(Host.JobsRead, { id: connectionKey(root) })) === true) throw new Error(MESSAGE.Disconnected);
  return bridgeRequest(root, method, params, { signal: ctx.signal });
}

/** Batch validation and confirmation routing happen before any request is accepted remotely. */
export async function unityTool(
  name: string,
  args: Record<string, PluginScalar>,
  ctx: PluginContext,
): Promise<unknown> {
  if (name === Tool.Status) return status(ctx);
  if (name === Tool.Batch) return call(ctx, UnityMethod.Batch, safeUnityBatch(args.params));
  const params = unityParams(args.params);
  if (name === Tool.Test) return call(ctx, UnityMethod.JobStart, { ...params, kind: "tests" });
  if (name === Tool.Build) return call(ctx, UnityMethod.JobStart, { ...params, kind: "build", confirmed: true });
  if (name === Tool.Verify) return call(ctx, UnityMethod.Verify, params);
  const group = UNITY_GROUPS[name];
  const method = group?.operations[String(args.operation || "")];
  if (!method) throw new Error(MESSAGE.Unknown);
  const checked = group.confirmation ? params : normalUnityParams(method, params);
  const result = await call(ctx, method, { ...checked, ...(group.confirmation ? { confirmed: true } : {}) });
  if (name !== "capture" || !result || typeof result !== "object") return result;
  const { base64, ...metadata } = result as Record<string, unknown>;
  if (typeof base64 !== "string") return result;
  return { ...metadata, images: [{ label: "Unity capture", mimeType: "image/png", data: base64 }] };
}

async function connectionAction(name: string, ctx: PluginContext) {
  if (name === Action.Status) return status(ctx);
  if (name === Action.Toolbar) {
    const state = await status(ctx);
    return {
      title: state.ready ? "Unity Editor connected" : state.detail,
      badge: state.ready ? "Connected" : "Setup",
      tone: state.ready ? "ok" : "info",
    };
  }
  if (name === Action.Disconnect) {
    await ctx.host(Host.JobsWrite, { id: connectionKey(await selectedProject(ctx)), value: true });
    return { connected: false };
  }
  const root = await selectedProject(ctx);
  await bridgeRequest(root, UnityMethod.Status, {}, { signal: ctx.signal });
  await ctx.host(Host.JobsWrite, { id: connectionKey(root), value: false });
  return status(ctx);
}

async function unityAction(name: string, args: Record<string, unknown>, ctx: PluginContext) {
  if (CONNECTION_ACTIONS.has(name)) return connectionAction(name, ctx);
  if (name === Action.Create) return createConnectedProject(args, ctx);
  const methods: Record<string, string> = {
    [Action.Scenes]: UnityMethod.SceneList,
    [Action.Hierarchy]: UnityMethod.Hierarchy,
    [Action.Inspect]: UnityMethod.ObjectInspect,
    [Action.Console]: UnityMethod.Console,
    [Action.Verify]: UnityMethod.Verify,
    [Action.Play]: UnityMethod.Play,
    [Action.Stop]: UnityMethod.Stop,
    [Action.Pause]: UnityMethod.Pause,
    [Action.Step]: UnityMethod.Step,
    [Action.Capture]: UnityMethod.CameraCapture,
    [Action.Job]: UnityMethod.JobStatus,
    [Action.CancelJob]: UnityMethod.JobCancel,
    [Action.BuildScenes]: UnityMethod.BuildScenes,
    [Action.Assets]: UnityMethod.AssetSearch,
    [Action.AssetInspect]: UnityMethod.AssetInspect,
  };
  if (methods[name]) return call(ctx, methods[name], normalUnityParams(methods[name], args));
  if (name === Action.Tests) return call(ctx, UnityMethod.JobStart, { ...unityParams(args), kind: "tests" });
  if (name === Action.Build)
    return call(ctx, UnityMethod.JobStart, { ...unityParams(args), kind: "build", confirmed: true });
  const root = await selectedProject(ctx);
  if (name === Action.Install) return installUnityBridge(root, ctx.signal);
  if (name === Action.Launch) return launchUnityEditor(root, String(args.editor || ""));
  throw new Error(MESSAGE.Unknown);
}

async function createConnectedProject(args: Record<string, unknown>, ctx: PluginContext) {
  const created = await createUnityProject(String(args.path || ""), String(args.version || ""), ctx.signal);
  try {
    const installed = await installUnityBridge(created.projectRoot, ctx.signal);
    return { ...created, installed: installed.installed };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Project created at ${created.projectRoot}. Bridge installation needs attention: ${detail}`);
  }
}

/** Side-effect-free activation: no project is read and no Editor is launched until a real invocation. */
export const activate: Activate = () => ({
  tool: unityTool,
  action: unityAction,
  async review(name, args, ctx) {
    const root = name === Action.Create ? String(args.path || "") : await selectedProject(ctx);
    return { message: `Unity project: ${root}\nOperation: ${name}\n${JSON.stringify(args, null, 2)}` };
  },
});
