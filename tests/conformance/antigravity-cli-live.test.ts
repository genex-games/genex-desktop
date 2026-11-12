/**
 * Antigravity sessions with the real Antigravity CLI (`agy acp`), inside Genex's real sandbox.
 *
 * The engine starts each turn as it would for a person (its command line, environment and
 * sandbox), on the Google account the CLI on this machine is signed in to: the sign-in check and
 * one short build use that account's plan. Opt-in, like every test that needs this machine's own
 * programs and accounts: `STUDIO_ANTIGRAVITY_CLI_TESTS=1` with a signed-in `agy` the engine can find.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { EngineStatusCode } from "../../src/shared/engine-descriptor.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { childEnv } from "../../src/substrate/child-env.ts";
import { antigravityHome } from "../../src/substrate/credential-homes.ts";
import {
  AntigravityEngine,
  type AntigravityInvocation,
  type AntigravityProcess,
  antigravityProcess,
} from "../../src/substrate/engines/antigravity.ts";
import { resolveCodingCli } from "../../src/substrate/engines/external-cli.ts";
import { ProcessSandbox, type SandboxOptions } from "../../src/substrate/spawn.ts";
import { type DelegateEvent, DelegateEventType } from "../../src/substrate/engines/types.ts";
import { tmpDir } from "../helpers/tmp.ts";

const LIVE = process.env.STUDIO_ANTIGRAVITY_CLI_TESTS === "1";
/** How long one short build may take. */
const TURN_TIMEOUT_MS = 240_000;
/** The cheapest model a plan lists, when it lists it; else the one the session starts on. */
const SMALL_MODEL = "gemini-3.8-flash-low";
/** What the build is asked to write in its folder, and outside it. */
const PROOF = { file: "antigravity-proof.txt", text: "ok" } as const;

/** The Keychain's files, and macOS's own program that reads an item it saved without asking. */
const KEYCHAINS = path.join(os.homedir(), "Library", "Keychains");
const KEYCHAIN_TOOL = "/usr/bin/security";
/** A harmless program standing in for `KEYCHAIN_TOOL` where the test shows a denied program cannot start. */
const STAND_IN_TOOL = "/usr/bin/cal";
/** The hosts a session might need at the least, to learn whether `*.googleapis.com` can be narrowed. */
const NARROW_HOSTS = [
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "oauth2.googleapis.com",
  "www.googleapis.com",
  "accounts.google.com",
  "antigravity.google",
];
type Box = (shipped: SandboxOptions) => SandboxOptions;
const readOnlyKeychain: Box = (shipped) => ({ ...shipped, denyWrite: [...(shipped.denyWrite ?? []), KEYCHAINS] });
const noKeychainTool: Box = (shipped) => ({ ...shipped, secretPaths: [...shipped.secretPaths, KEYCHAIN_TOOL] });
/** The tightest box the diagnostics try: the Keychain read-only and macOS's Keychain program unreadable. */
const tightest: Box = (shipped) => noKeychainTool(readOnlyKeychain(shipped));

/** The session's sandbox as shipped, with each of its two openings taken away, and tightened. */
const BOXES: ReadonlyArray<[string, Box, (readonly string[])?]> = [
  ["as shipped", (shipped) => shipped],
  ["without the Keychain's files", (shipped) => ({ ...shipped, ownHome: [antigravityHome()] })],
  ["without the certificate service", (shipped) => ({ ...shipped, machServices: [] })],
  ["with the Keychain's files read-only", readOnlyKeychain],
  ["without macOS's Keychain program", noKeychainTool],
  ["read-only and without the program", tightest],
  ["with the fewest hosts", (shipped) => shipped, NARROW_HOSTS],
];
/** What the CLI's own words may show in a report: nothing as long as a token. */
const redact = (words: string) => words.replace(/[\w.~+/=-]{24,}/g, "…").slice(-600);

/** Start the real CLI as the engine does, in a sandbox `box` has changed; what it says on stderr goes to `said`. */
function startIn(box: Box, said: string[], hosts?: readonly string[]) {
  return async (invocation: AntigravityInvocation): Promise<AntigravityProcess> => {
    const cli = await resolveCodingCli(EngineId.Antigravity);
    assert.ok(cli.status.path, `no agy CLI found: ${cli.status.state}`);
    const sandbox = await ProcessSandbox.create(box(invocation.sandbox));
    const env = childEnv(cli.env, { base: "contractor", vendor: "antigravity" });
    const set = Object.fromEntries(
      Object.entries(env).filter((pair): pair is [string, string] => pair[1] !== undefined),
    );
    const boxed = { ...invocation, env: set, ...(hosts ? { domains: [...hosts] } : {}) };
    const agent = await antigravityProcess(sandbox, cli.status.path, boxed, () => sandbox.dispose().catch(() => {}));
    void agent.exited.then(({ stderr }) => said.push(stderr));
    return agent;
  };
}

describe("Antigravity's real CLI in the real sandbox", { skip: !LIVE && "STUDIO_ANTIGRAVITY_CLI_TESTS=1" }, () => {
  async function engineAndGame() {
    const root = await realpath(await tmpDir("antigravity-live-"));
    const game = path.join(root, "game");
    const outside = path.join(root, "outside");
    await mkdir(game, { recursive: true });
    await mkdir(outside, { recursive: true });
    const engine = new AntigravityEngine({ scratchRoot: path.join(root, "scratch"), protectedPaths: [outside] });
    return { engine, game, outside };
  }

  it("reads the sign-in from inside the sandbox: ready, with the plan's models", async () => {
    const { engine } = await engineAndGame();
    const status = await engine.status();
    assert.equal(status.code, EngineStatusCode.Ready, `${status.code}: ${status.detail}`);
    const models = await engine.models();
    assert.ok(models.length > 0, "the plan lists a model");
    console.log(`antigravity live: ${status.detail}; models: ${models.map((model) => model.id).join(", ")}`);
  });

  it("says which of the sandbox's two openings the sign-in needs", async () => {
    for (const [name, box, hosts] of BOXES) {
      const { game } = await engineAndGame();
      const said: string[] = [];
      const engine = new AntigravityEngine({
        scratchRoot: path.join(game, "..", "scratch"),
        startFn: startIn(box, said, hosts),
      });
      const status = await engine.status();
      if (box === BOXES[0]?.[1]) assert.equal(status.code, EngineStatusCode.Ready, status.detail);
      console.log(`antigravity live: ${name}: ${status.code}; stderr: ${redact(said.join(" ").trim()) || "(none)"}`);
    }
  });

  it("a program the sandbox may not read cannot be started in it", async () => {
    const { game } = await engineAndGame();
    const sandbox = await ProcessSandbox.create({
      writableRoots: [game],
      scratchDir: path.join(game, "..", "tmp"),
      secretPaths: [STAND_IN_TOOL],
    });
    try {
      const run = await sandbox.run({ command: STAND_IN_TOOL, cwd: game, timeoutMs: 20_000 });
      console.log(`antigravity live: denied program: code=${run.code} stderr=${run.stderr.trim().slice(-200)}`);
      assert.notEqual(run.code, 0, "the denied program did not run");
    } finally {
      await sandbox.dispose();
    }
  });

  it("continues a session from another folder, in the tightest box, and remembers the turn before", {
    timeout: TURN_TIMEOUT_MS * 3,
  }, async () => {
    const { game } = await engineAndGame();
    const said: string[] = [];
    const engine = new AntigravityEngine({
      scratchRoot: path.join(game, "..", "scratch"),
      startFn: startIn(tightest, said),
    });
    const listed = (await engine.models()).some((model) => model.id === SMALL_MODEL);
    const model = listed ? { model: SMALL_MODEL } : {};
    const first = await engine.delegate({
      cwd: game,
      prompt: "Remember this word for later: PLUM. Reply with only: OK",
      ...model,
      timeoutMs: TURN_TIMEOUT_MS,
    });
    console.log(
      `antigravity live: first turn ok=${first.ok} session=${Boolean(first.sessionId)} ${first.errorText ?? ""}`,
    );
    assert.equal(first.ok, true, first.errorText ?? first.stopReason);
    assert.ok(first.sessionId);
    // A read-only turn runs from a scratch folder of its own: the session is loaded from elsewhere.
    const second = await engine.delegate({
      cwd: game,
      prompt: "Which word did I ask you to remember? Reply with only that word.",
      resume: first.sessionId,
      readOnly: true,
      ...model,
      timeoutMs: TURN_TIMEOUT_MS,
    });
    console.log(
      `antigravity live: resumed ok=${second.ok} same=${second.sessionId === first.sessionId} said=${second.summary.slice(0, 80)} error=${second.errorText ?? ""}; stderr: ${redact(said.join(" ").trim()) || "(none)"}`,
    );
    assert.equal(second.ok, true, second.errorText ?? second.stopReason);
    assert.match(second.summary, /PLUM/i);
  });

  it("builds in the game's folder, and cannot write the folder beside it", {
    timeout: TURN_TIMEOUT_MS * 2,
  }, async () => {
    const { engine, game, outside } = await engineAndGame();
    const listed = (await engine.models()).some((model) => model.id === SMALL_MODEL);
    const mirrored: DelegateEvent[] = [];
    const beside = path.join(outside, PROOF.file);
    const result = await engine.delegate({
      cwd: game,
      prompt: [
        `Create a file named ${PROOF.file} in the current folder containing exactly: ${PROOF.text}`,
        `Then run this command and tell me what it printed: echo ${PROOF.text} > ${beside}`,
      ].join("\n"),
      ...(listed ? { model: SMALL_MODEL } : {}),
      timeoutMs: TURN_TIMEOUT_MS,
      onEvent: (event) => mirrored.push(event),
    });
    console.log(
      `antigravity live: ok=${result.ok} stop=${result.stopReason} turns=${result.turns} error=${result.errorText ?? ""}`,
    );
    assert.equal(result.ok, true, result.errorText ?? result.stopReason);
    assert.equal((await readFile(path.join(game, PROOF.file), "utf8")).trim(), PROOF.text);
    assert.equal(existsSync(beside), false, "the folder beside the game is not the session's to write");
    assert.ok(result.sessionId, "a session to continue");
    assert.ok((result.usage.input_tokens ?? 0) > 0, "the turn's tokens");
    assert.ok(
      mirrored.some((event) => event.type === DelegateEventType.User),
      "a tool's result reached the log",
    );
  });
});
