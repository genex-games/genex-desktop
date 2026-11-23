/**
 * OpenCode 2.x sessions with the real OpenCode CLI, inside Genex's real sandbox.
 *
 * The engine starts each session as it would for a person (its command line, environment and
 * sandbox); the real CLI runs it against `fake-openai-chat.ts` (a provider in an OpenCode config
 * folder of the test's own, signed in with a made-up key), whose scripted turn runs one `node` command in the session's
 * folder. Nothing reaches a model provider and no account is used. Opt-in, like every test that
 * needs this machine's own programs: `STUDIO_OPENCODE_CLI_TESTS=1` with an `opencode` 2.x the
 * engine can find (or `STUDIO_OPENCODE_BIN`).
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { EngineId } from "../../src/shared/providers.ts";
import { runCommand } from "../../src/substrate/engines/claude-cli.ts";
import { resolveCodingCli } from "../../src/substrate/engines/external-cli.ts";
import {
  OpenCodeEngine,
  type OpenCodeExec,
  openCodeEvents,
  openCodeSessionFolders,
} from "../../src/substrate/engines/opencode.ts";
import { LoopbackProtocol } from "../../src/substrate/linux-loopback-bridge.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { anyLoopbackPort } from "../../src/main/core/genex-room.ts";
import {
  FAKE_CHAT_DONE_TEXT,
  FAKE_CHAT_MODEL,
  FAKE_CHAT_PROVIDER,
  type FakeChat,
  startFakeChat,
} from "../helpers/fake-openai-chat.ts";
import { tmpDir } from "../helpers/tmp.ts";

const LIVE = process.env.STUDIO_OPENCODE_CLI_TESTS === "1";
/** How long one scripted turn may take. */
const TURN_TIMEOUT_MS = 120_000;
/** How long the CLI may take to say its version. */
const VERSION_TIMEOUT_MS = 30_000;
/** What the scripted command writes in the session's folder. */
const PROOF = { file: "opencode-proof.txt", text: "ok" } as const;
/** The words the probe prints when a server's password reaches the session's commands. */
const PASSWORD_SEEN = "server password visible";
const PROBE_SOURCE = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(PROOF.file)}, ${JSON.stringify(PROOF.text)});\nif (process.env.OPENCODE_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD) console.log(${JSON.stringify(PASSWORD_SEEN)});\nconsole.log("probe ran");\n`;
/** How many ports below a free one the made-up fenced range spans. */
const FENCED_PORTS = 5;
/** OpenCode's own name for its shell tool. */
const SHELL_TOOL = "shell";
/** The model the session picks, as OpenCode names it. */
const MODEL = `${FAKE_CHAT_PROVIDER}/${FAKE_CHAT_MODEL}`;
/**
 * Where the fake provider listens. Newer 2.x reaches `127.0.0.1` past the sandbox's proxy, which a
 * Mac session may; a Linux session's loopback is its own and a Windows session's is fenced, and
 * both reach `127.0.0.2`, another address of this computer's own, through the proxy.
 */
const FAKE_HOST = process.platform === "darwin" ? "127.0.0.1" : "127.0.0.2";

/** OpenCode's config naming the fake as a provider. */
const providerConfig = (baseURL: string): string =>
  JSON.stringify({
    provider: {
      [FAKE_CHAT_PROVIDER]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Genex fake",
        options: { baseURL, apiKey: "fake-key" },
        models: { [FAKE_CHAT_MODEL]: { name: "Fake model" } },
      },
    },
  });

/** The folders OpenCode keeps its config, sign-ins, logs and catalog in: the test's own. */
const OWN_FOLDERS = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;

/** The real `opencode` binary. */
async function openCodeBinary(): Promise<string> {
  if (process.env.STUDIO_OPENCODE_BIN) return process.env.STUDIO_OPENCODE_BIN;
  const found = await resolveCodingCli(EngineId.OpenCode);
  assert.ok(found.status.path, `no opencode CLI found: ${found.status.state}`);
  return found.status.path;
}

describe("OpenCode 2.x with the real CLI", { skip: !LIVE && "set STUDIO_OPENCODE_CLI_TESTS=1" }, () => {
  let fake: FakeChat;
  let root: string;
  let binary: string;
  let version: string;
  const saved = new Map<string, string | undefined>();

  before(async () => {
    binary = await openCodeBinary();
    version = (await runCommand(binary, ["--version"], { env: process.env, timeoutMs: VERSION_TIMEOUT_MS })).stdout;
    root = await tmpDir("opencode-live-");
    fake = await startFakeChat(FAKE_HOST, SHELL_TOOL);
    for (const name of OWN_FOLDERS) {
      saved.set(name, process.env[name]);
      process.env[name] = path.join(root, "home", name.toLowerCase());
      await mkdir(path.join(process.env[name], "opencode"), { recursive: true });
    }
    await writeFile(
      path.join(process.env.XDG_CONFIG_HOME ?? "", "opencode", "opencode.json"),
      providerConfig(fake.baseUrl),
    );
  });

  after(async () => {
    await fake?.close();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  /**
   * The engine on the real CLI, its sessions in Genex's real sandbox, reaching only the fake. With
   * `fenced`, the sandbox says its loopback is fenced to that range, as Windows' is.
   */
  const engine = (fenced?: readonly [number, number]) => {
    const execFn: OpenCodeExec = async function* (invocation) {
      // As the studio's own sandbox grants OpenCode's folders at its start (on Windows a session runs
      // as the sandbox's own user, who may read nothing else): here, the test's own folders and its config.
      const configDir = path.join(process.env.XDG_CONFIG_HOME ?? "", "opencode");
      const writableRoots = [...invocation.sandbox.writableRoots, ...openCodeSessionFolders(), configDir];
      const sandbox = await ProcessSandbox.create({ ...invocation.sandbox, writableRoots });
      const session = {
        spawnLongLived: (request: Parameters<ProcessSandbox["spawnLongLived"]>[0]) => sandbox.spawnLongLived(request),
        enabled: sandbox.enabled,
        loopbackPorts: () => fenced ?? sandbox.loopbackPorts(),
      };
      try {
        yield* openCodeEvents(session, binary, { ...invocation, domains: [...invocation.domains, FAKE_HOST] });
      } finally {
        await sandbox.dispose();
      }
    };
    return new OpenCodeEngine({
      scratchRoot: path.join(root, "scratch"),
      protectedPaths: [path.join(root, "secrets")],
      resolveCli: async () => ({ ready: true, path: binary, version, detail: "" }),
      listModels: async () => JSON.stringify({ data: [] }),
      execFn,
      mcpTools: false,
    });
  };

  /** One build in a folder of its own: the scripted command ran there and the turn ended with the reply. */
  async function builds(name: string, fenced?: readonly [number, number]): Promise<void> {
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "probe.mjs"), PROBE_SOURCE);
    fake.next("node probe.mjs");
    const result = await engine(fenced).delegate({ cwd: dir, prompt: "Run the probe.", model: MODEL });
    assert.equal(result.ok, true, result.errorText);
    assert.equal(result.summary, FAKE_CHAT_DONE_TEXT);
    assert.ok(result.sessionId, "a session Continue can resume");
    assert.equal(await readFile(path.join(dir, PROOF.file), "utf8"), PROOF.text);
    assert.match(fake.commandOutput() ?? "", /probe ran/);
    assert.doesNotMatch(
      fake.commandOutput() ?? "",
      new RegExp(PASSWORD_SEEN),
      "no command of the session reads its server's password",
    );
  }

  it("builds: the session reaches its own server, the scripted command runs in the game folder and the turn ends with the reply (#825)", {
    timeout: TURN_TIMEOUT_MS,
  }, async () => {
    await builds("build");
  });

  it("builds on a server Genex starts on a port of a fenced range, as on Windows (#825)", {
    timeout: TURN_TIMEOUT_MS,
    // A Linux session's loopback is its own: a server in it is not seen from here, and nothing fences it.
    skip: process.platform === "linux" && "Linux gives each session a loopback of its own",
  }, async () => {
    const top = await anyLoopbackPort(LoopbackProtocol.Tcp);
    await builds("fenced", process.platform === "win32" ? undefined : [top - FENCED_PORTS, top]);
  });
});
