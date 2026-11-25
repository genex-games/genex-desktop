/**
 * Play-time models for a game being made, played as its own packaged app (`local-play-ai.ts`): which
 * app is handed Live's practice helper, what a helper's key may be, and, in the real game sandbox
 * of this Mac, that such an app reaches its helper's port and nothing else.
 */
import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, describe, it } from "node:test";
import { localPlayAi } from "../../src/main/play/local-play-ai.ts";
import {
  gameGenexEnv,
  gamePractice,
  PRACTICE_KEY_ENV,
  spawnNativeGame,
} from "../../src/substrate/plugins/native-process.ts";
import { tmpDir } from "../helpers/tmp.ts";

const HEX = "0123456789abcdef0123456789abcdef";
const KEY = `41000.${HEX}`;

describe("a practice helper's key, as a game is told it", () => {
  it("is a port on this computer and the helper's token, under the kit's variable", () => {
    assert.equal(PRACTICE_KEY_ENV, "GENEX_LLM_PRACTICE");
    assert.deepEqual(gamePractice({ key: KEY }), { port: 41000, env: { GENEX_LLM_PRACTICE: KEY } });
    assert.deepEqual(gamePractice({ key: `1024.${HEX}` })?.port, 1024, "the lowest port a helper binds");
    assert.deepEqual(gamePractice({ key: `65535.${HEX}` })?.port, 65535);
  });

  const hostile = [
    "",
    ".",
    "41000",
    "41000.",
    `.${HEX}`,
    `0.${HEX}`,
    `80.${HEX}`,
    `1023.${HEX}`,
    `65536.${HEX}`,
    `99999.${HEX}`,
    `041000.${HEX}`,
    `+41000.${HEX}`,
    ` 41000.${HEX}`,
    `41000.${HEX}\n`,
    `41000.${HEX}0`,
    `41000.${HEX.slice(1)}`,
    `41000.${HEX.toUpperCase()}`,
    `41000.${HEX.slice(0, 31)}g`,
    `evil.example:80.${HEX}`,
    `41000@evil.example.${HEX}`,
    `41000/../x.${HEX}`,
    `http://127.0.0.1:41000.${HEX}`,
    `genex_llm_practice=41000.${HEX}`,
    `41000.${HEX}@evil.example`,
  ];
  for (const key of hostile)
    it(`opens and tells nothing for ${JSON.stringify(key)}`, () => {
      assert.equal(gamePractice({ key }), null);
    });

  it("is nothing for a game handed none", () => {
    assert.equal(gamePractice(undefined), null);
  });

  it("is never part of what a game is told about Genex", () => {
    const genex = { GENEX_API_URL: "http://127.0.0.1:41001", GENEX_LLM_PRACTICE: KEY };
    assert.deepEqual(gameGenexEnv(genex), { GENEX_API_URL: "http://127.0.0.1:41001" });
  });
});

describe("the helper a game folder's own app is handed", () => {
  const deps = (platform: NodeJS.Platform, held: Record<string, string>) => {
    const asked: string[] = [];
    const logs: string[] = [];
    return {
      asked,
      logs,
      deps: {
        platform,
        heldKey: (project: string) => {
          asked.push(project);
          return held[project] ?? null;
        },
        log: (line: string) => logs.push(line),
      },
    };
  };

  for (const platform of ["darwin", "linux"] as const)
    it(`is the one Live holds for that game, on ${platform}`, () => {
      const { deps: d, asked, logs } = deps(platform, { inn: KEY });
      assert.deepEqual(localPlayAi(d, "inn"), { key: KEY });
      assert.deepEqual(asked, ["inn"]);
      assert.deepEqual(logs, []);
    });

  it("is none for a game Live holds no helper for", () => {
    const { deps: d, logs } = deps("darwin", { inn: KEY });
    assert.equal(localPlayAi(d, "mill"), null);
    assert.deepEqual(logs, []);
  });

  it("is none on Windows, and the log says why", () => {
    const { deps: d, logs } = deps("win32", { inn: KEY });
    assert.equal(localPlayAi(d, "inn"), null);
    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? "", /inn.*Windows.*reaches no port on this computer.*editor/);
  });

  it("says nothing on Windows for a game with no helper", () => {
    const { deps: d, logs } = deps("win32", {});
    assert.equal(localPlayAi(d, "inn"), null);
    assert.deepEqual(logs, []);
  });
});

/** What the game in the sandbox reports: the variables it was started with and what it could reach. */
interface Report {
  practice: string | null;
  api: string | null;
  ticket: string | null;
  helper: string;
  other: string;
}

/** The game: a script that prints its Genex variables and what a GET of each port answered. */
const GAME = `
const get = (port) => fetch("http://127.0.0.1:" + port + "/").then((r) => r.text(), (e) => "refused: " + (e.cause?.code ?? e.message));
const [helper, other] = await Promise.all([get(process.argv[2]), get(process.argv[3])]);
console.log(JSON.stringify({
  practice: process.env.GENEX_LLM_PRACTICE ?? null,
  api: process.env.GENEX_API_URL ?? null,
  ticket: process.env.GENEX_EMBED_TICKET ?? null,
  helper, other,
}));
`;

const closing: Array<() => unknown> = [];
after(async () => {
  for (const close of closing.reverse()) await close();
});

/** A server on this Mac that answers `says`, and its port. */
async function listener(says: string): Promise<number> {
  const server = http.createServer((_request, response) => response.end(says));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closing.push(() => new Promise((resolve) => server.close(resolve)));
  return (server.address() as AddressInfo).port;
}

/** Run the game in Play's own sandbox with `key` as its practice helper; what it reported. */
async function play(key: string | null, ports: { helper: number; other: number }): Promise<Report> {
  const root = await realpath(await tmpDir("local-play-ai-"));
  const saves = path.join(root, "saves");
  const scratch = path.join(root, "scratch");
  await mkdir(saves, { recursive: true });
  await mkdir(scratch, { recursive: true });
  const script = path.join(saves, "game.mjs");
  await writeFile(script, GAME);
  const child = await spawnNativeGame({
    binary: await realpath(process.execPath),
    app: path.dirname(path.dirname(await realpath(process.execPath))),
    saves,
    scratch,
    bundleId: "games.genex.play.practice-proof",
    bundleName: "Practice Proof",
    args: [script, String(ports.helper), String(ports.other)],
    ...(key === null ? {} : { practice: { key } }),
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    err += chunk.toString("utf8");
  });
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  const line = out.trim().split("\n").at(-1) ?? "";
  assert.ok(line.startsWith("{"), `the game said nothing (exit ${code}): ${err.slice(-1500)}`);
  return JSON.parse(line) as Report;
}

describe("a game being made in Play's sandbox on this Mac", { skip: process.platform !== "darwin" }, () => {
  it("reaches its practice helper, is told its key, and reaches nothing else", async () => {
    const ports = { helper: await listener("the helper"), other: await listener("another program") };
    const key = `${ports.helper}.${HEX}`;
    const told = await play(key, ports);
    assert.equal(told.practice, key, "the key is in its environment");
    assert.equal(told.helper, "the helper", "its helper's port answers");
    assert.match(told.other, /^refused/, "another port on this Mac does not");
    assert.deepEqual([told.api, told.ticket], [null, null], "it is given no address of Genex's and no sign-in");
  });

  it("reaches nothing and is told nothing when the key is not one", async () => {
    const ports = { helper: await listener("the helper"), other: await listener("another program") };
    const told = await play(`${ports.helper}.not-a-token`, ports);
    assert.equal(told.practice, null);
    assert.match(told.helper, /^refused/);
    assert.match(told.other, /^refused/);
  });

  it("reaches nothing with no helper, as before", async () => {
    const ports = { helper: await listener("the helper"), other: await listener("another program") };
    const told = await play(null, ports);
    assert.equal(told.practice, null);
    assert.match(told.helper, /^refused/);
  });
});
