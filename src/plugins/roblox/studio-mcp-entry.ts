import os from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { errorMessage } from "../../shared/errors.ts";
import { bridgeHome, readPlaceLink } from "./studio-binding.ts";
import { createStudioClient, systemStudioClientDeps } from "./studio-client.ts";
import { type LocateDeps, locateStudio, studioRunning, systemLocateFs, systemRun } from "./studio-locate.ts";
import { createStudioMcp } from "./studio-mcp.ts";
import { systemShrink } from "./studio-shot.ts";

// The host runs one connection per game, in `<plugin storage>/mcp/<game>` (manifest cwd
// `storage:project`; `_shared` when a call has no game), with HOME pointed at a folder of its own
// there. StudioMCP still gets the person's real home: the client takes it from the system's user
// record, never from HOME. The game's link is the host's record in the plugin's storage, and the
// binding file and the busy mark live in this folder.
const folder = process.cwd();
const { storage, game } = bridgeHome(folder);
const locateDeps: LocateDeps = {
  platform: process.platform,
  env: process.env,
  home: os.userInfo().homedir,
  fs: systemLocateFs,
  run: systemRun,
};
const clientDeps = systemStudioClientDeps(async () => {
  const location = await locateStudio(locateDeps);
  return location.installed ? location.install.mcp : undefined;
});

try {
  const bridge = createStudioMcp({
    client: createStudioClient(clientDeps),
    folder,
    link: () => readPlaceLink(storage, game),
    running: () => studioRunning(locateDeps),
    shrink: systemShrink(),
    now: Date.now,
  });
  await bridge.server.connect(new StdioServerTransport());
  // The host owns the lifetime: ending the connection ends its StudioMCP too.
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
