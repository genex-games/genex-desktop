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
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { EngineId } from "../../src/shared/providers.ts";
import { spawnCommand } from "../../src/substrate/command-launch.ts";
import { cliVersion, resolveCodingCli } from "../../src/substrate/engines/external-cli.ts";
import { GrokEngine, grokEvents, grokOutside, type GrokExec } from "../../src/substrate/engines/grok.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { FAKE_DONE_TEXT, type FakeXai, startFakeXai } from "../helpers/fake-xai-responses.ts";
import { tmpDir } from "../helpers/tmp.ts";

const LIVE = process.env.STUDIO_GROK_CLI_TESTS === "1";
/** How long one scripted turn may take. */
const TURN_TIMEOUT_MS = 120_000;
/** How long the made-up sign-in may take. */
const SIGN_IN_TIMEOUT_MS = 60_000;
/** What the scripted command writes in the session's folder. */
const PROOF = { file: "grok-proof.txt", text: "ok" } as const;
const PROBE_SOURCE = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(PROOF.file)}, ${JSON.stringify(PROOF.text)});\nconsole.log("probe ran");\n`;
/** The variables that point the CLI at the fake instead of xAI, for the test's whole process. */
/** A 64×64 red square: Grok Build attaches no picture smaller than a vision model reads. */
const RED_SQUARE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC";
const FAKE_ENDPOINTS = ["GROK_HOME", "GROK_CLI_CHAT_PROXY_BASE_URL", "GROK_XAI_API_BASE_URL"] as const;

/** The real `grok` binary. */
async function grokBinary(): Promise<string> {
  if (process.env.STUDIO_GROK_BIN) return process.env.STUDIO_GROK_BIN;
  const found = await resolveCodingCli(EngineId.Grok);
  assert.ok(found.status.path, `no grok CLI found: ${found.status.state}`);
  return found.status.path;
}

/**
 * The provider command `grok login` runs. On Windows Grok hands it to `cmd /C` as one argument,
 * which Rust escapes `\"`-style and cmd does not unescape: the paths go unquoted there.
 */
function providerCommand(token: string): string {
  if (process.platform !== "win32") return `"${process.execPath}" "${token}"`;
  assert.ok(!`${process.execPath}${token}`.includes(" "), "unquoted paths without spaces");
  return `${process.execPath} ${token}`;
}

/**
 * A script printing made-up tokens, each a new name: the first expires in ten minutes, every one it
 * renews to in an hour (so a renewal's lead must stay short of a new token's life). It counts what
 * it minted in `minted`.
 */
const renewingToken = (minted: string) => `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const file = ${JSON.stringify(minted)};
const count = existsSync(file) ? Number(readFileSync(file, "utf8")) + 1 : 1;
writeFileSync(file, String(count));
const expires_in = count === 1 ? 600 : 3600;
console.log(JSON.stringify({ access_token: \`renewed-\${count}\`, refresh_token: \`refresh-\${count}\`, expires_in }));
`;

/** `grok login` into `home`, with the made-up token the script at `token` prints. */
async function signIn(binary: string, home: string, token: string): Promise<void> {
  const env = {
    ...process.env,
    GROK_HOME: home,
    GROK_AUTH_PROVIDER_COMMAND: providerCommand(token),
    GROK_DISABLE_AUTOUPDATER: "1",
  };
  const child = spawnCommand(binary, ["login"], { env, stdio: "ignore" });
  // A provider command that fails sends `grok login` to the browser, where it waits for good.
  const timer = setTimeout(() => child.kill(), SIGN_IN_TIMEOUT_MS);
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  clearTimeout(timer);
  assert.equal(code, 0, "grok login with the made-up token");
}

/** `use` run with `vars` in the test's own environment, which is then as it was. */
async function withEnv<T>(vars: Record<string, string>, use: () => Promise<T>): Promise<T> {
  const saved = Object.keys(vars).map((name) => [name, process.env[name]] as const);
  Object.assign(process.env, vars);
  try {
    return await use();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
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
    const token = path.join(root, "token.mjs");
    await writeFile(token, 'console.log(JSON.stringify({ access_token: "fake-session-token", expires_in: 3600 }));\n');
    await signIn(binary, process.env.GROK_HOME, token);
  });

  after(async () => {
    await fake?.close();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  /** The engine on the real CLI, its turns in Genex's real sandbox (or a Bypass chat's as the person), reaching only the fake. */
  const engine = (home = process.env.GROK_HOME) => {
    const execFn: GrokExec = async function* (invocation) {
      const env = { ...invocation.env, GROK_CLI_CHAT_PROXY_BASE_URL: fake.proxyUrl };
      if (!invocation.sandbox) {
        yield* grokOutside(binary, { ...invocation, env }, process.env);
        return;
      }
      const sandbox = await ProcessSandbox.create(invocation.sandbox);
      try {
        yield* grokEvents(sandbox, binary, { ...invocation, env, domains: ["127.0.0.1", "localhost"] });
      } finally {
        await sandbox.dispose();
      }
    };
    return new GrokEngine({
      scratchRoot: path.join(root, "scratch"),
      protectedPaths: [path.join(root, "secrets")],
      home,
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
    const left = await readdir(path.join(root, "scratch"), { recursive: true });
    assert.deepEqual(
      left.filter((name) => path.basename(name) === "auth.json"),
      [],
      "no copy of the sign-in outlives the turn (Windows hands each turn one)",
    );
  });

  it("renews a sign-in about to expire as the person, before a build reads its copy (#531)", {
    timeout: TURN_TIMEOUT_MS,
    skip: process.platform !== "win32" && "only a Windows session reads a copy",
  }, async () => {
    const folder = path.join(root, "renewing");
    const home = path.join(folder, ".grok");
    await mkdir(home, { recursive: true });
    const token = path.join(folder, "token.mjs");
    await writeFile(token, renewingToken(path.join(folder, "minted.txt")));
    await signIn(binary, home, token);
    const file = path.join(home, "auth.json");
    const keys = async () =>
      Object.values(JSON.parse(await readFile(file, "utf8"))).map((entry) => (entry as { key?: unknown }).key);
    assert.deepEqual(await keys(), ["renewed-1"], "signed in, ten minutes left");
    // A sign-in from yesterday with ten minutes left, as a week-old one ends.
    const store = JSON.parse(await readFile(file, "utf8")) as Record<string, Record<string, unknown>>;
    for (const entry of Object.values(store)) entry.create_time = new Date(Date.now() - 24 * 3600_000).toISOString();
    await writeFile(file, JSON.stringify(store));
    const sentBefore = fake.modelRequestHeaders().length;
    // Grok's home is the one sessions may use, as the app's own is; the person's own Grok renews
    // through the provider command it signed in with.
    const build = async (name: string) => {
      const dir = await game(name);
      const result = await withEnv({ GROK_HOME: home, GROK_AUTH_PROVIDER_COMMAND: providerCommand(token) }, () =>
        engine(home).delegate({ cwd: dir, prompt: "Run the probe." }),
      );
      assert.equal(result.ok, true, result.errorText);
      assert.equal(await readFile(path.join(dir, PROOF.file), "utf8"), PROOF.text);
    };
    await build("renewing-build");
    assert.deepEqual(await keys(), ["renewed-2"], "the person's own sign-in, renewed");
    await build("renewed-build");
    assert.equal(await readFile(path.join(folder, "minted.txt"), "utf8"), "2", "renewed once, its new hour left alone");
    const sent = fake.modelRequestHeaders().slice(sentBefore);
    assert.ok(sent.length > 0 && sent.every((headers) => headers.includes("renewed-2")), "both builds ran on it");
  });

  it("in a Bypass chat runs as the person, outside the sandbox, and an Auto turn resumes that session inside it", {
    timeout: 2 * TURN_TIMEOUT_MS,
  }, async () => {
    const outside = path.join(root, "outside", PROOF.file);
    await mkdir(path.dirname(outside), { recursive: true });
    // As the read-only session's write: quotes and slashes Grok's Windows shell passes on as they are.
    const write = `node -e "require('node:fs').writeFileSync('${outside.replaceAll("\\", "/")}', 'ok')"`;
    const dir = await game("bypass", write);
    const chat = (mode: string) => ({ mode, ask: async () => ({ decision: "deny" }) }) as never;
    const bypass = await engine().delegate({
      cwd: dir,
      prompt: "Write outside the game.",
      permissions: chat("bypassPermissions"),
    });
    assert.equal(bypass.ok, true, bypass.errorText);
    assert.equal(await readFile(outside, "utf8"), "ok", "no sandbox held a write outside the game");
    // On Windows the sandbox runs as its own user: the session the person's Grok kept must open to it.
    const sentBefore = fake.requests.length;
    const auto = await engine().delegate({
      cwd: dir,
      prompt: "Say what you did.",
      resume: bypass.sessionId,
      permissions: chat("auto"),
    });
    assert.equal(auto.ok, true, auto.errorText);
    assert.equal(auto.sessionId, bypass.sessionId, "the same session, resumed in the sandbox");
    const resumed = fake.requests.slice(sentBefore).some((body) => {
      const sent = JSON.stringify(body);
      return sent.includes("Say what you did.") && sent.includes("Write outside the game.");
    });
    assert.ok(resumed, "the sandboxed turn sent the Bypass turn's history: it read the kept session");
  });

  it("a judge's picture reaches the model: Grok opens the file its prompt names, in the real sandbox", {
    timeout: TURN_TIMEOUT_MS,
  }, async () => {
    fake.nextPicture();
    const response = await engine().complete({
      messages: [
        { role: "user", content: "What colour is it?", images: [{ data: RED_SQUARE_PNG, mimeType: "image/png" }] },
      ],
    });
    assert.equal(response.message.content, FAKE_DONE_TEXT);
    assert.deepEqual(fake.picturesSent(), [`data:image/png;base64,${RED_SQUARE_PNG}`]);
  });

  it("a read-only session runs from its own folder, and its sandbox keeps the game as it is", {
    timeout: TURN_TIMEOUT_MS,
  }, async () => {
    const dir = path.join(root, "judge");
    const target = path.join(dir, PROOF.file);
    // Single quotes inside double ones, and forward slashes: Grok's shell on Windows reads `\"` as
    // the end of the string, not a quote in it, and every shell passes `D:/…` to node as it is.
    const write = `node -e "require('node:fs').writeFileSync('${target.replaceAll("\\", "/")}', 'ok')"`;
    await game("judge", write);
    const result = await engine().delegate({ cwd: dir, prompt: "Write into the game.", readOnly: true });
    assert.equal(result.ok, true, result.errorText);
    assert.match(fake.commandOutput() ?? "", /EPERM|not permitted|denied/i, "the sandbox refused the write");
    assert.equal(existsSync(target), false, "the game folder is untouched");
  });
});
