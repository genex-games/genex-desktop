/** MCP connectors, and the native trust dialog in front of a connector that starts a program. */
import { dialog, shell } from "electron";
import { UserCancelledError } from "../../shared/errors.ts";
import { type McpConnector, McpTransport } from "../../shared/mcp.ts";
import { launchDigest, validateConnector } from "../../substrate/mcp/store.ts";
import { resolveExecutable } from "../../substrate/mcp/client.ts";
import { toolchain } from "../../substrate/toolchain.ts";
import { assertNativeActionAllowed } from "../dev/native-policy.ts";
import type { StudioCore } from "../studio-core.ts";
import type { IpcHandle } from "./registrar.ts";

/** Why a connector cannot be added under the id it asks for. */
const MESSAGE = {
  pluginOwnsId: "A plugin is already installed under that id — give this connector a different one",
  pluginServerOwnsId: "An installed plugin declares an MCP server under that id — give this connector a different one",
} as const;

export interface McpIpcDeps {
  core: StudioCore;
  fixtureNativePolicy: boolean;
}

export function registerMcpIpc(handle: IpcHandle, { core, fixtureNativePolicy }: McpIpcDeps): void {
  /**
   * MCP connectors. The registry validates the connector itself (id class, transport exclusivity,
   * absolute working directory, https-or-loopback urls, argument caps, env and header name
   * shapes); these handlers add the two things it deliberately does not know about — the plugin
   * ids it shares a tool namespace with, and the native trust dialog that has to be answered
   * before Studio starts a program on this Mac.
   */
  handle("studio:mcp.list", async (project) => core.mcp.list(listScope(project)));
  handle("studio:connections", async (p) => core.connectionSnapshot(p?.threadId, p?.project));
  handle("studio:mcp.save", async (p) => {
    const draft: Partial<McpConnector> = p?.connector ?? {};
    if (typeof draft.id === "string") assertIdFreeOfPlugins(core, draft.id);
    const known = (await core.mcp.list()).find((view) => view.connector.id === draft.id)?.connector;
    const connector = validateConnector({
      ...draft,
      createdAt: draft.createdAt ?? known?.createdAt ?? new Date().toISOString(),
    });
    const launchChanged =
      connector.transport === McpTransport.Stdio && launchDigest(connector) !== known?.trustedLaunch;
    if (!launchChanged) return core.mcp.save(connector, p.secrets);
    assertNativeActionAllowed(fixtureNativePolicy, "studio:mcp.trust");
    if (!(await confirmTrust(connector))) throw new UserCancelledError();
    return core.mcp.save(connector, p.secrets, { trust: true });
  });
  handle("studio:mcp.remove", async (p) => core.mcp.remove(p.id));
  handle("studio:mcp.test", async (p) => core.mcp.test(p.id));
  handle("studio:mcp.connect", async (p) =>
    core.mcp.connect(p.id, p.project ?? null, async (url) => {
      assertNativeActionAllowed(fixtureNativePolicy, "studio:mcp.authorize");
      await shell.openExternal(url);
    }),
  );
  handle("studio:mcp.cancel-authorization", async (p) => core.mcp.cancelAuthorization(p.id));
  handle("studio:mcp.disconnect-account", async (p) => core.mcp.disconnectAccount(p.id));
  handle("studio:mcp.tools", async (p) => core.mcp.tools(p.id));
  handle("studio:mcp.forget-always", async (p) => {
    if (typeof p?.id !== "string") throw new Error("Invalid connector id");
    await core.mcp.forgetAlwaysAllowed(p.id);
  });
}

/** A project name lists that project's connectors, null the global ones, anything else all of them. */
function listScope(project: unknown): string | null | undefined {
  if (typeof project === "string") return project;
  return project === null ? null : undefined;
}

/**
 * A connector and a plugin both publish tools as `<id>__<tool>`: one id answered by two
 * sources is a tool call that reaches whichever was merged last.
 */
function assertIdFreeOfPlugins(core: StudioCore, id: string): void {
  const installed = core.plugins.list();
  if (installed.some((x) => x.manifest.id === id)) throw new Error(MESSAGE.pluginOwnsId);
  // A plugin's own server is published as `<pluginId>-<serverId>`. A user connector under that
  // name answers for it whenever the plugin is switched off and is overwritten when it is on.
  const declaresServer = installed.some((x) =>
    (x.manifest.mcpServers ?? []).some((s) => `${x.manifest.id}-${s.id}` === id),
  );
  if (declaresServer) throw new Error(MESSAGE.pluginServerOwnsId);
}

/** The native trust dialog in front of a connector that starts a program; true when trusted. */
async function confirmTrust(connector: McpConnector): Promise<boolean> {
  // The file that will run, found on the login PATH the way Connect finds it (GPX-7).
  const program = await resolveExecutable(connector.command ?? "", (await toolchain()).path);
  const choice = await dialog.showMessageBox({
    type: "warning",
    title: "Trust connector",
    message: `Run ${connector.command} for ${connector.name}?`,
    detail: `Studio starts this program on your Mac as trusted native code with the environment variables you named. A separate process is crash isolation, not a security sandbox.\nProgram: ${program ?? "not found on your login PATH yet"}\nArguments: ${connector.args?.join(" ") || "none"}\nWorking directory: ${connector.cwd ?? "the studio's own"}\nEnvironment variables: ${connector.env?.join(", ") || "none"}`,
    buttons: ["Cancel", "Trust"],
    defaultId: 0,
    cancelId: 0,
  });
  return choice.response === 1;
}
