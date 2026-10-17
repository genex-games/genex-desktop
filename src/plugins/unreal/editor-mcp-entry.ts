import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { errorMessage } from "../../shared/errors.ts";
import { agentPlayMarker, NO_AGENT_PLAY } from "./agent-play.ts";
import { createEditorMcp, logCrashWatcher, systemStartWait } from "./editor-mcp.ts";
import { bridgeHome, bridgeProjects } from "./editor-port.ts";

// The host runs one bridge per game, in `<plugin storage>/mcp/<game>` (manifest cwd
// `storage:project`; `_shared` when a call has no game). Setup keeps its records of the set-up
// projects and their ports, the panel its choice, Open in Unreal its Starting record, and the host
// each game's link in that storage. A game's bridge marks the agent's own play in its folder,
// where the plugin's backend reads it for the editor lock.
const { storage, game } = bridgeHome(process.cwd());

try {
  const bridge = createEditorMcp(
    () => bridgeProjects(storage, game),
    fetch,
    logCrashWatcher(),
    systemStartWait(storage),
    game ? agentPlayMarker(process.cwd()) : NO_AGENT_PLAY,
  );
  await bridge.server.connect(new StdioServerTransport());
  // The host owns the lifetime: the bridge holds no editor session between calls.
  process.stdin.once("end", () => {
    void bridge.close();
  });
  process.once("SIGTERM", () => {
    void bridge.close().finally(() => process.exit(0));
  });
} catch (error) {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
}
