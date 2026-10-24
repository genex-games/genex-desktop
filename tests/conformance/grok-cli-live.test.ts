/**
 * Grok Build sessions with the real Grok Build CLI, inside Genex's real sandbox.
 *
 * The engine starts each turn as it would for a person (its prompt file, command line,
 * environment and sandbox); the real CLI runs it against `fake-xai-responses.ts` (Grok's session
 * service stood in for, signed in with a made-up token in a Grok home of the test's own), whose
 * scripted turn runs one `node` command in the session's folder. Nothing reaches xAI and no
 * account is used. Opt-in, like every test that needs this machine's own programs:
 * `STUDIO_GROK_CLI_TESTS=1` with a `grok` the engine can find (or `STUDIO_GROK_BIN`).
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { EngineId } from "../../src/shared/providers.ts";
import { spawnCommand } from "../../src/substrate/command-launch.ts";
import { cliVersion, resolveCodingCli } from "../../src/substrate/engines/external-cli.ts";
import { GrokEngine, grokEvents, type GrokExec } from "../../src/substrate/engines/grok.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { FAKE_DONE_TEXT, type FakeXai, startFakeXai } from "../helpers/fake-xai-responses.ts";
import { tmpDir } from "../helpers/tmp.ts";

const LIVE = process.env.STUDIO_GROK_CLI_TESTS === "1";
/** How long one scripted turn may take. */
const TURN_TIMEOUT_MS = 120_000;
/** What the scripted command writes in the session's folder. */
const PROOF = { file: "grok-proof.txt", text: "ok" } as const;
const PROBE_SOURCE = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(PROOF.file)}, ${JSON.stringify(PROOF.text)});\nconsole.log("probe ran");\n`;
/** The variables that point the CLI at the fake instead of xAI, for the test's whole process. */
const FAKE_ENDPOINTS = ["GROK_HOME", "GROK_CLI_CHAT_PROXY_BASE_URL", "GROK_XAI_API_BASE_URL"] as const;

/** The real `grok` binary. */
async function grokBinary(): Promise<string> {
  if (process.env.STUDIO_GROK_BIN) return process.env.STUDIO_GROK_BIN;
  const found = await resolveCodingCli(EngineId.Grok);
  assert.ok(found.status.path, `no grok CLI found: ${found.status.state}`);
  return found.status.path;
}

/** `grok login` into the test's own home, with a made-up token from a script of the test's own. */
async function signIn(binary: string, root: string): Promise<void> {
  const token = path.join(root, "token.mjs");
  await writeFile(token, 'console.log(JSON.stringify({ access_token: "fake-session-token", expires_in: 3600 }));\n');
  const env = {
    ...process.env,
    GROK_AUTH_PROVIDER_COMMAND: `"${process.execPath}" "${token}"`,
    GROK_DISABLE_AUTOUPDATER: "1",
  };
  const child = spawnCommand(binary, ["login"], { env, stdio: "ignore" });
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  assert.equal(code, 0, "grok login with the made-up token");
}

describe("Grok Build with the real CLI", { skip: !LIVE && "set STUDIO_GROK_CLI_TESTS=1" }, () => {
  let fake: FakeXai;
  let root: string;
  let binary: string;
  const saved = new Map<string, string | undefined>();

  before(async () => {
    binary = await grokBinary();
    root = await tmpDir("grok-live-");
    fake = await startFakeXai("node probe.mjs");
    for (const name of FAKE_ENDPOINTS) saved.set(name, process.env[name]);
    process.env.GROK_HOME = path.join(root, "home", ".grok");
    process.env.GROK_CLI_CHAT_PROXY_BASE_URL = fake.proxyUrl;
    process.env.GROK_XAI_API_BASE_URL = fake.proxyUrl.replace("/proxy/v1", "/v1");
    await mkdir(process.env.GROK_HOME, { recursive: true });
    await signIn(binary, root);
  });

  after(async () => {
    await fake?.close();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  /** The engine on the real CLI, its turns in Genex's real sandbox, reaching only the fake. */
  const engine = () => {
    const execFn: GrokExec = async function* (invocation) {
      const sandbox = await ProcessSandbox.create(invocation.sandbox);
      try {
        const env = { ...invocation.env, GROK_CLI_CHAT_PROXY_BASE_URL: fake.proxyUrl };
        yield* grokEvents(sandbox, binary, { ...invocation, env, domains: ["127.0.0.1", "localhost"] });
      } finally {
        await sandbox.dispose();
      }
    };
    return new GrokEngine({
      scratchRoot: path.join(root, "scratch"),
      protectedPaths: [path.join(root, "secrets")],
      home: process.env.GROK_HOME,
      resolveCli: async () => ({ ready: true, path: binary, version: "live", detail: "" }),
      execFn,
    });
  };

  async function game(name: string, command = "node probe.mjs"): Promise<string> {
    fake.next(command);
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "probe.mjs"), PROBE_SOURCE);
    return dir;
  }

  it("says it is signed in to the test's own Grok home, as the CLI reports it", async () => {
    const grok = engine();
    const status = await grok.status();
    assert.equal(status.code, "ready", status.detail);
    assert.equal((await grok.account()).source, "system");
    assert.ok((await grok.models()).length > 0);
    assert.ok(cliVersion("grok 1.0.70 (f50904eaee6c)"));
  });

  it("builds: the scripted command runs in the game folder and the turn ends with Grok's reply", {
    timeout: TURN_TIMEOUT_MS,
  }, async () => {
    const dir = await game("build");
    const result = await engine().delegate({ cwd: dir, prompt: "Run the probe." });
    assert.equal(result.ok, true, result.errorText);
    assert.equal(result.summary, FAKE_DONE_TEXT);
    assert.ok(result.sessionId, "a session Continue can resume");
    assert.equal(await readFile(path.join(dir, PROOF.file), "utf8"), PROOF.text);
    assert.match(fake.commandOutput() ?? "", /probe ran/);
  });

  it("a read-only session runs from its own folder, and its sandbox keeps the game as it is", {
    timeout: TURN_TIMEOUT_MS,
  }, async () => {
    const dir = path.join(root, "judge");
    const target = path.join(dir, PROOF.file);
    const write = `node -e ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(target)}, "ok")`)}`;
    await game("judge", write);
    const result = await engine().delegate({ cwd: dir, prompt: "Write into the game.", readOnly: true });
    assert.equal(result.ok, true, result.errorText);
    assert.match(fake.commandOutput() ?? "", /EPERM|not permitted|denied/i, "the sandbox refused the write");
    assert.equal(existsSync(target), false, "the game folder is untouched");
  });
});
