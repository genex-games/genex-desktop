/**
 * `genex__cli` in a development profile pointed at a stand (a local or test copy of genex.games,
 * `play/origins.ts`): the Studio-run Genex CLI talks to the stand's API with the stand's own account,
 * the one the profile signed in to, never to genex.games with the Genex plugin's account. Without a
 * stand it keeps genex.games and the plugin's account. Drives a real core with an injected sandbox:
 * nothing runs and nothing leaves the machine.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { GENEX_PLUGIN_ID } from "../../src/main/core/genex-cli.ts";
import { GENEX_CLI_PROMPT } from "../../src/main/core/genex-cli-prompts.ts";
import { PluginHostTool } from "../../src/shared/plugins.ts";
import type { RunRequest, RunResult } from "../../src/substrate/spawn.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";

const STAND_API = "http://localhost:3000";
const STAND_TOKEN = "stand-session-token-synthetic";

let lite: CoreLite | null = null;
afterEach(async () => {
  await lite?.close();
  lite = null;
});

/** The core's sandbox, recording each run and answering a CLI that printed `{}`. */
function recordRuns(core: CoreLite["core"]): RunRequest[] {
  const seen: RunRequest[] = [];
  core.sandbox.run = async (request: RunRequest): Promise<RunResult> => {
    seen.push(request);
    return {
      code: 0,
      signal: null,
      stdout: "{}\n",
      stderr: "",
      durationMs: 1,
      timedOut: false,
      truncated: false,
      sandboxed: true,
      command: request.command,
      cwd: request.cwd,
    };
  };
  return seen;
}

/** Run `genex doctor` the way an agent's `genex__cli` call does. */
async function doctor(core: CoreLite["core"]): Promise<unknown> {
  const run = core.plugins.hostTool;
  assert.ok(run, "the core wires the Genex host tools");
  return run(
    GENEX_PLUGIN_ID,
    PluginHostTool.GenexCli,
    { command: "doctor" },
    { project: "space-race", directory: "", threadId: "t1" },
  );
}

describe("the Genex host tools' CLI in a development profile on a stand", () => {
  it("runs against the stand's API with the stand's own account", async () => {
    lite = await coreLite({ genexStand: { api: STAND_API, token: async () => STAND_TOKEN } });
    const seen = recordRuns(lite.core);
    lite.core.plugins.hostCredentialFile = async () => "GENEX_TOKEN=plugin-token-synthetic\n";
    await doctor(lite.core);
    const [request] = seen;
    assert.ok(request);
    assert.equal(request.stdin, `GENEX_TOKEN=${STAND_TOKEN}\n`);
    assert.match(request.command, /--api-url 'http:\/\/localhost:3000'/);
    assert.equal(request.env?.GENEX_API_URL, STAND_API);
    assert.deepEqual(request.policy?.allowedDomains, ["localhost"]);
    assert.doesNotMatch(request.command, /api\.genex\.games/);
  });

  it("says the account is locked, and runs nothing, while the profile is not signed in to the stand", async () => {
    lite = await coreLite({ genexStand: { api: STAND_API, token: async () => undefined } });
    const seen = recordRuns(lite.core);
    // The Genex plugin's account is never lent to a stand.
    lite.core.plugins.hostCredentialFile = async () => "GENEX_TOKEN=plugin-token-synthetic\n";
    await assert.rejects(doctor(lite.core), { message: GENEX_CLI_PROMPT.Locked });
    assert.deepEqual(seen, []);
  });

  it("never hands the CLI a stand token that could carry a second line", async () => {
    lite = await coreLite({ genexStand: { api: STAND_API, token: async () => `${STAND_TOKEN}\nGENEX_API_URL=x` } });
    const seen = recordRuns(lite.core);
    // The Genex plugin's account is never lent to a stand.
    lite.core.plugins.hostCredentialFile = async () => "GENEX_TOKEN=plugin-token-synthetic\n";
    await assert.rejects(doctor(lite.core), { message: GENEX_CLI_PROMPT.Locked });
    assert.deepEqual(seen, []);
  });

  it("keeps genex.games and the Genex plugin's account without a stand", async () => {
    lite = await coreLite();
    const seen = recordRuns(lite.core);
    const asked: string[] = [];
    // The Genex plugin's account, unlocked: what the registry hands a host-run CLI.
    lite.core.plugins.hostCredentialFile = async (id: string) => {
      asked.push(id);
      return "GENEX_TOKEN=plugin-token-synthetic\n";
    };
    await doctor(lite.core);
    const [request] = seen;
    assert.ok(request);
    assert.deepEqual(asked, [GENEX_PLUGIN_ID]);
    assert.equal(request.stdin, "GENEX_TOKEN=plugin-token-synthetic\n");
    assert.match(request.command, /--api-url 'https:\/\/api\.genex\.games'/);
    assert.deepEqual(request.policy?.allowedDomains, ["api.genex.games"]);
  });
});
