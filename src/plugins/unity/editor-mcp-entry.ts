import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { errorMessage } from "../../shared/errors.ts";
import { agentPlayMarker, NO_AGENT_PLAY } from "./agent-play.ts";
import { agentUseMarker } from "./editor-idle.ts";
import { createEditorMcp } from "./editor-mcp.ts";
import { systemPipelineDeps } from "./pipeline.ts";
import { bridgeHome, rememberedProject } from "./project-folder.ts";

// The host runs one bridge per game, in `<plugin storage>/mcp/<game>` (manifest cwd
// `storage:project`; `_shared` when a call has no game). The backend keeps each game's Unity
// project in that storage, where this reads it for every call. A game's bridge marks the agent's
// own play in its folder, where the backend reads it for the editor lock, and each command it
// sends, where the backend reads it before it closes an idle editor.
const { storage, game } = bridgeHome(process.cwd());

try {
  const agentPlay = game ? agentPlayMarker(process.cwd()) : NO_AGENT_PLAY;
  const noteUse = game ? agentUseMarker(process.cwd()) : async () => {};
  const bridge = createEditorMcp(() => rememberedProject(storage, game), systemPipelineDeps, agentPlay, noteUse);
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
