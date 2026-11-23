/**
 * Pi sessions with the real Pi CLI, inside Genex's real sandbox.
 *
 * The engine starts each turn as it would for a person (its command line, environment, brief and
 * sandbox); the real CLI runs it against `fake-openai-chat.ts`, a provider of the test's own in a
 * Pi folder of the test's own (`PI_CODING_AGENT_DIR`), signed in with a made-up key. The scripted
 * turn runs one `node` command in the session's folder; other turns continue a chat through Plan and
 * back, and carry a picture. On macOS and Linux every turn runs on a folder of its own that stands
 * for Pi's (`pi-agent-view.ts`), on Windows on Pi's own. The last case gives the real CLI the
 * command Genex renews a sign-in with, on a made-up sign-in that holds. Nothing reaches a provider
 * and no account is used. Opt-in, like every test that needs this machine's own programs: `STUDIO_PI_CLI_TESTS=1`
 * with a `pi` the engine can find (or `STUDIO_PI_BIN`).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { HOUR_MS } from "../../src/shared/duration.ts";
import { EngineStatusCode } from "../../src/shared/engine-descriptor.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { resolveCodingCli } from "../../src/substrate/engines/external-cli.ts";
import { PiEngine, piEvents, type PiExec } from "../../src/substrate/engines/pi.ts";
import { piRenewalArgs, renewPiSignIn } from "../../src/substrate/engines/pi-sign-in.ts";
import { RENEWAL_WAIT_MS } from "../../src/substrate/engines/sign-in-renewal.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import {
  FAKE_CHAT_DONE_TEXT,
  FAKE_CHAT_MODEL,
  FAKE_CHAT_PROVIDER,
  type FakeChat,
  startFakeChat,
} from "../helpers/fake-openai-chat.ts";
import { tmpDir } from "../helpers/tmp.ts";

const LIVE = process.env.STUDIO_PI_CLI_TESTS === "1";
/** How long one scripted turn may take. */
const TURN_TIMEOUT_MS = 120_000;
/** The made-up key the test's Pi folder is signed in with. */
const FAKE_KEY = "genex-fake-key";
/** Pi's own variable for its folder; the test's process carries it, as a person's would. */
const PI_FOLDER = "PI_CODING_AGENT_DIR";
/** What the scripted command writes in the session's folder. */
const PROOF = { file: "pi-proof.txt", text: "ok" } as const;
/** A one-pixel PNG. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PROBE_SOURCE = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(PROOF.file)}, ${JSON.stringify(PROOF.text)});\nconsole.log("probe ran");\n`;

/**
 * Where the fake provider listens. A Linux session has no network of its own and reaches a host
 * only through the sandbox's proxy, which it is told to skip for `127.0.0.1`: there the fake takes
 * another loopback address, which goes through the proxy like a provider's.
 */
const FAKE_HOST = process.platform === "linux" ? "127.0.0.2" : "127.0.0.1";

/** The real `pi` binary. */
async function piBinary(): Promise<string> {
  if (process.env.STUDIO_PI_BIN) return process.env.STUDIO_PI_BIN;
  const found = await resolveCodingCli(EngineId.Pi);
  assert.ok(found.status.path, `no pi CLI found: ${found.status.state}`);
  return found.status.path;
}

describe("Pi with the real CLI", { skip: !LIVE && "set STUDIO_PI_CLI_TESTS=1" }, () => {
  let fake: FakeChat;
  let root: string;
  let agent: string;
  let binary: string;
  let savedFolder: string | undefined;

  before(async () => {
    binary = await piBinary();
    // By its real name: a sandbox grants a folder as it is spelled, and macOS reaches `/tmp` and
    // `/var` through links.
    root = await realpath(await tmpDir("pi-live-"));
    fake = await startFakeChat(FAKE_HOST);
    agent = path.join(root, "pi-home", "agent");
    await mkdir(agent, { recursive: true });
    // A provider Pi does not know, as a person adds one: its endpoint in `models.json`, its key in
    // Pi's sign-in file.
    const models = [{ id: FAKE_CHAT_MODEL, input: ["text", "image"] }];
    const provider = { baseUrl: fake.baseUrl, api: "openai-completions", models };
    await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { [FAKE_CHAT_PROVIDER]: provider } }));
    await writeFile(
      path.join(agent, "auth.json"),
      JSON.stringify({ [FAKE_CHAT_PROVIDER]: { type: "api_key", key: FAKE_KEY } }),
    );
    savedFolder = process.env[PI_FOLDER];
    process.env[PI_FOLDER] = agent;
  });

  after(async () => {
    await fake?.close();
    if (savedFolder === undefined) delete process.env[PI_FOLDER];
    else process.env[PI_FOLDER] = savedFolder;
  });

  /** The engine on the real CLI, its turns in Genex's real sandbox, reaching only the fake. */
  const engine = () => {
    const execFn: PiExec = async function* (invocation) {
      const sandbox = await ProcessSandbox.create(invocation.sandbox);
      try {
        // The fake answers on loopback over plain http, which no provider's host list names.
        yield* piEvents(sandbox, binary, { ...invocation, domains: [FAKE_HOST, "localhost"] });
      } finally {
        await sandbox.dispose();
      }
    };
    return new PiEngine({
      scratchRoot: path.join(root, "scratch"),
      protectedPaths: [path.join(root, "secrets")],
      resolveCli: async () => ({ ready: true, path: binary, version: "live", detail: "" }),
      execFn,
    });
  };

  const model = `${FAKE_CHAT_PROVIDER}/${FAKE_CHAT_MODEL}`;

  async function game(name: string, command: string | null = "node probe.mjs"): Promise<string> {
    fake.next(command);
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "probe.mjs"), PROBE_SOURCE);
    return dir;
  }

  it("is ready on the test's own Pi folder, and lists the model its provider has", async () => {
    const pi = engine();
    const status = await pi.status();
    assert.equal(status.code, EngineStatusCode.Ready, status.detail);
    const listed = (await pi.models()).map((row) => row.id);
    assert.ok(listed.includes(model), `the made-up provider's model among ${listed.join(", ")}`);
  });

  it("builds: Pi reads its sign-in, gets the brief, and its command runs in the game folder", {
    timeout: TURN_TIMEOUT_MS,
  }, async () => {
    const dir = await game("build");
    const before = await readdir(agent);
    const signIn = await readFile(path.join(agent, "auth.json"), "utf8");
    const sentBefore = fake.requests.length;
    const result = await engine().delegate({ cwd: dir, prompt: "Run the probe.", model });
    assert.equal(result.ok, true, result.errorText);
    assert.equal(result.summary, FAKE_CHAT_DONE_TEXT);
    assert.ok(result.sessionId, "a session Continue can resume");
    assert.equal(await readFile(path.join(dir, PROOF.file), "utf8"), PROOF.text);
    assert.match(fake.commandOutput() ?? "", /probe ran/);
    const sent = fake.requests.slice(sentBefore);
    assert.ok(
      sent.some((body) => JSON.stringify(body).includes("Run the probe.")),
      "the brief reached Pi (on Windows only the sandbox's stdin file carries it)",
    );
    const keys = fake.authorizations().slice(sentBefore);
    assert.ok(
      keys.length > 0 && keys.every((sentKey) => sentKey.includes(FAKE_KEY)),
      "every request went out on the key in the person's Pi folder, which the session read",
    );
    assert.equal(existsSync(path.join(agent, "auth.json.lock")), false, "Pi's lock beside its sign-in is released");
    const sessions = await readdir(path.join(agent, "sessions"), { recursive: true });
    assert.ok(sessions.length > 0, "the session's transcript is kept in the person's Pi folder");
    assert.equal(await readFile(path.join(agent, "auth.json"), "utf8"), signIn, "the person's sign-in is as it was");
    // Windows has no folder that stands for Pi's: a session there runs on Pi's own.
    if (process.platform === "win32") return;
    assert.deepEqual(
      await readdir(path.join(agent, "genex")),
      ["work"],
      "the folder the session ran on, with the lock Pi took in it, is gone when the session ends",
    );
    assert.deepEqual(await readdir(path.join(agent, "genex", "work")), [], "and nothing waits to be removed");
    assert.deepEqual(
      (await readdir(agent)).sort(),
      [...new Set([...before, "genex", "sessions"])].sort(),
      "the person's folder gains nothing from a session but its transcripts and Genex's own folder",
    );
  });

  it("resumes: the next turn sends the first one's history", { timeout: 2 * TURN_TIMEOUT_MS }, async () => {
    const dir = await game("resume");
    const first = await engine().delegate({ cwd: dir, prompt: "Run the probe once.", model });
    assert.equal(first.ok, true, first.errorText);
    fake.next(null);
    const sentBefore = fake.requests.length;
    const second = await engine().delegate({ cwd: dir, prompt: "Say what you did.", model, resume: first.sessionId });
    assert.equal(second.ok, true, second.errorText);
    assert.equal(second.sessionId, first.sessionId, "the same session");
    const resumed = fake.requests.slice(sentBefore).some((body) => {
      const sent = JSON.stringify(body);
      return sent.includes("Say what you did.") && sent.includes("Run the probe once.");
    });
    assert.ok(resumed, "the resumed turn read the transcript the first one kept");
  });

  it("a chat keeps its history through Plan and back: Pi forks the session into each turn's folder", {
    timeout: 4 * TURN_TIMEOUT_MS,
  }, async () => {
    const dir = await game("plan");
    const turn = async (prompt: string, resume: string | undefined, readOnly: boolean) => {
      const sentBefore = fake.requests.length;
      const result = await engine().delegate({ cwd: dir, prompt, model, readOnly, ...(resume ? { resume } : {}) });
      assert.equal(result.ok, true, result.errorText);
      fake.next(null);
      return { result, sent: fake.requests.slice(sentBefore).map((body) => JSON.stringify(body)) };
    };
    const told = (sent: string[], ...prompts: string[]) =>
      sent.some((body) => prompts.every((prompt) => body.includes(prompt)));
    const built = await turn("Run the probe once.", undefined, false);
    // Pi looks for a session only in the folder it runs from, and a Plan turn runs from its own.
    const planned = await turn("Plan the next step.", built.result.sessionId, true);
    assert.ok(
      told(planned.sent, "Plan the next step.", "Run the probe once."),
      "the Plan turn read the build's history",
    );
    assert.notEqual(planned.result.sessionId, built.result.sessionId, "as a fork, under an id of its own");
    const again = await turn("And after that?", planned.result.sessionId, true);
    assert.ok(told(again.sent, "And after that?", "Plan the next step.", "Run the probe once."));
    assert.equal(again.result.sessionId, planned.result.sessionId, "the next Plan turn continues that fork in place");
    const done = await turn("Do it.", again.result.sessionId, false);
    assert.ok(
      told(done.sent, "Do it.", "And after that?", "Run the probe once."),
      "the approved plan reaches the build",
    );
  });

  it("a picture attached to a turn reaches the model as a picture", { timeout: TURN_TIMEOUT_MS }, async () => {
    const dir = await game("picture", null);
    const sentBefore = fake.requests.length;
    const images = [{ label: "the bug", mimeType: "image/png", data: PIXEL }];
    const result = await engine().delegate({ cwd: dir, prompt: "What is in this picture?", model, images });
    assert.equal(result.ok, true, result.errorText);
    const sent = fake.requests.slice(sentBefore).map((body) => JSON.stringify(body));
    assert.ok(
      sent.some((body) => body.includes("image_url") && body.includes("data:image/")),
      "Pi takes a picture as an @file argument, read from a folder the sandboxed session reaches",
    );
  });

  it("a one-shot answer comes back with no tools and no session", { timeout: TURN_TIMEOUT_MS }, async () => {
    fake.next(null);
    const response = await engine().complete({ messages: [{ role: "user", content: "Say done." }], model });
    assert.equal(response.message.content, FAKE_CHAT_DONE_TEXT);
  });

  it("a read-only session runs from its own folder, and its sandbox keeps the game as it is", {
    timeout: TURN_TIMEOUT_MS,
  }, async () => {
    const dir = path.join(root, "judge");
    const target = path.join(dir, PROOF.file);
    const write = `node -e "require('node:fs').writeFileSync('${target.replaceAll("\\", "/")}', 'ok')"`;
    await game("judge", write);
    const result = await engine().delegate({ cwd: dir, prompt: "Write into the game.", model, readOnly: true });
    assert.equal(result.ok, true, result.errorText);
    assert.match(
      fake.commandOutput() ?? "",
      /EPERM|EACCES|EROFS|not permitted|denied/i,
      "the sandbox refused the write",
    );
    assert.equal(existsSync(target), false, "the game folder is untouched");
  });

  it("a session cannot read the studio's secrets", { timeout: TURN_TIMEOUT_MS }, async () => {
    const secret = path.join(root, "secrets", "token.txt");
    await mkdir(path.dirname(secret), { recursive: true });
    await writeFile(secret, "genex-secret-words");
    const read = `node -e "console.log(require('node:fs').readFileSync('${secret.replaceAll("\\", "/")}', 'utf8'))"`;
    // Its own folder: a game inside the protected folder could not even start.
    const dir = await game("reads-secret", read);
    const result = await engine().delegate({ cwd: dir, prompt: "Read the secret.", model });
    assert.equal(result.ok, true, result.errorText);
    assert.doesNotMatch(fake.commandOutput() ?? "", /genex-secret-words/, "the secret never reached the model");
    assert.match(fake.commandOutput() ?? "", /EPERM|EACCES|ENOENT|not permitted|denied/i);
  });

  it("the real Pi takes the command Genex renews a sign-in with: one that holds stays as it is, and Pi ends by itself", {
    skip: process.platform === "win32" && "a Windows session runs on Pi's own folder and renews Pi's own file",
    timeout: TURN_TIMEOUT_MS,
  }, async () => {
    // A made-up subscription sign-in with ten hours left: Pi has nothing to renew and calls no one.
    const folder = path.join(root, "renewal-home", "agent");
    await mkdir(folder, { recursive: true });
    const file = path.join(folder, "auth.json");
    const entry = {
      type: "oauth",
      access: FAKE_KEY,
      refresh: "genex-fake-refresh",
      expires: Date.now() + 10 * HOUR_MS,
    };
    const signIn = JSON.stringify({ anthropic: entry });
    await writeFile(file, signIn);
    const renewal = { provider: "anthropic", expires: entry.expires, minExpirySeconds: 300 };
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", [PI_FOLDER]: folder };
    const printed = await promisify(execFile)(binary, piRenewalArgs(renewal), { env, cwd: root });
    assert.equal(printed.stdout.trim(), FAKE_KEY, "Pi knows the command, and what it prints is the token");
    const started = Date.now();
    await renewPiSignIn(binary, { env, cwd: root, renewal });
    assert.ok(Date.now() - started < RENEWAL_WAIT_MS, "Pi ended by itself, well inside a session's wait");
    assert.equal(await readFile(file, "utf8"), signIn, "a sign-in that holds is left as it is");
  });
});
