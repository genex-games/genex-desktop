import { GENEX_PLUGIN_ID } from "../../shared/genex.ts";
import { PluginAccountState } from "../../shared/plugins.ts";
import type { StudioCore } from "../studio-core.ts";
import type { HarnessHostApi } from "../../shared/harness-api.ts";
import { takesGenexPackages } from "./genex-package.ts";

type Readiness = HarnessHostApi["plugins.preflightMultiplayer"]["result"];

/** Capability readiness never asserts remote authentication, install approval, or hosted gameplay success. */
export function multiplayerReadiness(facts: {
  manifest: boolean;
  install: boolean;
  publish: boolean;
  account: string | undefined;
}): Readiness {
  if (!facts.manifest)
    return {
      ready: false,
      reason: "The game needs a package.json (or to be made from Studio's template) before SDK installation.",
      hostedVerified: false,
    };
  if (!facts.install)
    return {
      ready: false,
      reason: "Enable Genex's pinned SDK installation tool before online work.",
      hostedVerified: false,
    };
  if (facts.account !== PluginAccountState.Unlocked)
    return {
      ready: false,
      reason: "Connect or unlock Genex before online work; account readiness is unavailable.",
      hostedVerified: false,
    };
  if (!facts.publish)
    return {
      ready: false,
      reason: "Enable the consented Genex draft publishing route before online work.",
      hostedVerified: false,
    };
  return {
    ready: true,
    reason:
      "Pinned SDK installation and a hosted draft route are available. Both still require their normal approvals; multiplayer needs a real hosted two-client test.",
    hostedVerified: false,
  };
}

/** Read host-owned capability and account state without network access, credentials, installs or publishing. */
export async function preflightMultiplayer(core: StudioCore, project: string, threadId?: string): Promise<Readiness> {
  const binding = await core.pluginBinding(project, threadId);
  if (!binding) throw new Error("Open a game before checking prerequisites");
  const tools = new Set(core.plugins.tools().map((tool) => tool.name));
  return multiplayerReadiness({
    manifest: await takesGenexPackages(binding.directory),
    install: tools.has("genex__package"),
    publish: tools.has("genex__publish"),
    account: await core.plugins.accountState(GENEX_PLUGIN_ID),
  });
}
