import { type GameProject, GameStack, stackOf } from "../../shared/game-project.ts";
import { GENEX_PLUGIN_ID } from "../../shared/genex.ts";
import { PluginAccountState } from "../../shared/plugins.ts";
import type { StudioCore } from "../studio-core.ts";
import type { HarnessHostApi } from "../../shared/harness-api.ts";
import { lacksRustWebBuild } from "./genex-publish.ts";
import { takesGenexPackages } from "./genex-package.ts";

type Readiness = HarnessHostApi["plugins.preflightMultiplayer"]["result"];

/** Why online work is or is not ready, as the director's decision card and its chat say it. */
export const MULTIPLAYER_REASON = {
  CppGame:
    "Genex online play adds Genex's JavaScript packages, which a C++ · raylib game cannot add. Build multiplayer in a browser (three.js) game.",
  RustNoWeb:
    "This Rust · wgpu game has no web build (Browser is not among its destinations, or genex.toml declares native-only GPU features), so it has no Genex draft to play online.",
  RustReady:
    "Turn on [net] enabled in genex.toml, export the web build, publish a draft, and test it in two windows. Studio's Live is a loopback room: multiplayer needs a real hosted two-client test.",
  NoManifest: "The game needs a package.json (or to be made from Studio's template) before SDK installation.",
  NoInstall: "Enable Genex's pinned SDK installation tool before online work.",
  Locked: "Connect or unlock Genex before online work; account readiness is unavailable.",
  NoPublish: "Enable the consented Genex draft publishing route before online work.",
  Ready:
    "Pinned SDK installation and a hosted draft route are available. Both still require their normal approvals; multiplayer needs a real hosted two-client test.",
} as const;

/** What readiness is read from: the host's own state, never the network. */
interface ReadinessFacts {
  manifest: boolean;
  install: boolean;
  publish: boolean;
  account: string | undefined;
  stack?: GameStack | null;
  /** A Rust game's: whether it has a web build to publish as a draft (absent: yes). */
  webBuild?: boolean;
}

const notReady = (reason: string): Readiness => ({ ready: false, reason, hostedVerified: false });

/**
 * Capability readiness never asserts remote authentication, install approval, or hosted gameplay
 * success. A C++ · raylib game is answered first, by its stack's reason: Genex's packages are
 * JavaScript, and a package.json would not make them its own. A Rust · wgpu game plays online
 * through genex-net and its web draft (G6 MP-5c): it needs a web build, the account and the draft
 * route, never a package.json or Genex's npm packages.
 */
export function multiplayerReadiness(facts: ReadinessFacts): Readiness {
  if (facts.stack === GameStack.RaylibCpp) return notReady(MULTIPLAYER_REASON.CppGame);
  if (facts.stack === GameStack.RustWgpu) return rustReadiness(facts);
  if (!facts.manifest) return notReady(MULTIPLAYER_REASON.NoManifest);
  if (!facts.install) return notReady(MULTIPLAYER_REASON.NoInstall);
  if (facts.account !== PluginAccountState.Unlocked) return notReady(MULTIPLAYER_REASON.Locked);
  if (!facts.publish) return notReady(MULTIPLAYER_REASON.NoPublish);
  return { ready: true, reason: MULTIPLAYER_REASON.Ready, hostedVerified: false };
}

/** A Rust game's readiness: its web build, then the account, then the draft route. */
function rustReadiness(facts: ReadinessFacts): Readiness {
  if (facts.webBuild === false) return notReady(MULTIPLAYER_REASON.RustNoWeb);
  if (facts.account !== PluginAccountState.Unlocked) return notReady(MULTIPLAYER_REASON.Locked);
  if (!facts.publish) return notReady(MULTIPLAYER_REASON.NoPublish);
  return { ready: true, reason: MULTIPLAYER_REASON.RustReady, hostedVerified: false };
}

/** The library's game `project`, or null when the library has no such game. */
async function gameNamed(core: StudioCore, project: string): Promise<GameProject | null> {
  return (await core.games.list().catch(() => [])).find((listed) => listed.name === project) ?? null;
}

/** Read host-owned capability and account state without network access, credentials, installs or publishing. */
export async function preflightMultiplayer(core: StudioCore, project: string, threadId?: string): Promise<Readiness> {
  const binding = await core.pluginBinding(project, threadId);
  if (!binding) throw new Error("Open a game before checking prerequisites");
  // The bound game's own listing, as its builders are handed it (the web game's view, by stack).
  const game = await gameNamed(core, project);
  const stack = game ? stackOf(game.shape) : null;
  const tools = new Set(core.plugins.snapshot([], undefined, stack).tools.map((tool) => tool.name));
  const webBuild = game && stack === GameStack.RustWgpu ? !(await lacksRustWebBuild(game)) : true;
  return multiplayerReadiness({
    manifest: await takesGenexPackages(binding.directory),
    install: tools.has("genex__package"),
    publish: tools.has("genex__publish"),
    account: await core.plugins.accountState(GENEX_PLUGIN_ID),
    stack,
    webBuild,
  });
}
