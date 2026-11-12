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
import path from "node:path";
import { describe, it } from "node:test";
import { EngineStatusCode } from "../../src/shared/engine-descriptor.ts";
import { AntigravityEngine } from "../../src/substrate/engines/antigravity.ts";
import { type DelegateEvent, DelegateEventType } from "../../src/substrate/engines/types.ts";
import { tmpDir } from "../helpers/tmp.ts";

const LIVE = process.env.STUDIO_ANTIGRAVITY_CLI_TESTS === "1";
/** How long one short build may take. */
const TURN_TIMEOUT_MS = 240_000;
/** The cheapest model a plan lists, when it lists it; else the one the session starts on. */
const SMALL_MODEL = "gemini-3.8-flash-low";
/** What the build is asked to write in its folder, and outside it. */
const PROOF = { file: "antigravity-proof.txt", text: "ok" } as const;

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
