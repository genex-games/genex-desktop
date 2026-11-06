/**
 * A game from Play on Windows for real, through Genex's game host in an AppContainer of its own
 * (`windows-game.ts`): with a way to Genex it reaches Genex's API over the internet and still no
 * port on this computer's loopback; with none it reaches nothing. The "game" is a copy of Windows'
 * own curl.exe, which writes the answer into its saves folder (it has no stdout). The container's profile is
 * made first without the internet, as a game played before Windows games went online had it, so
 * the internet must come from the start, not from the profile. Windows only.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { PLAY_ORIGIN } from "../../src/shared/play.ts";
import type { GameGenexEnv } from "../../src/substrate/plugins/native-process.ts";
import { windowsGames, type WindowsGames } from "../../src/substrate/plugins/windows-game.ts";
import { tmpDir } from "../helpers/tmp.ts";

const SKIP = process.platform !== "win32" && "Windows only";
/** One container for every case, so the first one makes its profile without the internet. */
const BUNDLE_ID = "games.genex.play.genex-live-network";
/** How long curl waits for an answer, in seconds, before it gives up. */
const CURL_MAX_SECONDS = "20";
const HEADERS_FILE = "headers.txt";
const BODY_FILE = "body.txt";

let games: WindowsGames;
let loopback: Server;
let loopbackHits = 0;

/** What the game did: the host's exit code (curl's own), whether an answer came, and the host's errors. */
interface Played {
  code: number | null;
  answered: boolean;
  errors: string;
}

/** Plays curl as a game: `url` asked for, told `genex` (and its container online) when there is one. */
async function play(url: string, genex?: GameGenexEnv): Promise<Played> {
  const root = await tmpDir("wgame-live-");
  const [app, saves, scratch] = ["app", "saves", "scratch"].map((name) => path.join(root, name));
  for (const dir of [app, saves, scratch]) await mkdir(dir, { recursive: true });
  const binary = path.join(app, "curl.exe");
  await copyFile(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "curl.exe"), binary);
  const headers = path.join(saves, HEADERS_FILE);
  const args = ["-sS", "--max-time", CURL_MAX_SECONDS, "-o", path.join(saves, BODY_FILE), "-D", headers, url];
  const child = await games.spawn({
    binary,
    app,
    saves,
    scratch,
    bundleId: BUNDLE_ID,
    bundleName: "Genex live network",
    args,
    ...(genex ? { genex: { ports: [], env: genex } } : {}),
  });
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => {
    errors += text;
  });
  const [code] = (await once(child, "exit")) as [number | null];
  // curl makes the headers file before it connects: an answer is one that wrote a status line there.
  const written = existsSync(headers) ? await readFile(headers, "utf8") : "";
  return { code, answered: /^HTTP\//.test(written), errors };
}

describe("a Windows game's network, for real", { skip: SKIP }, () => {
  before(async () => {
    games = windowsGames(await tmpDir("wgame-host-"));
    loopback = createServer((_request, response) => {
      loopbackHits += 1;
      response.end("reached");
    });
    loopback.listen(0, "127.0.0.1");
    await once(loopback, "listening");
  });

  after(() => {
    loopback?.close();
  });

  it("reaches nothing with no way to Genex", async () => {
    const played = await play(`${PLAY_ORIGIN.api}/`);
    assert.notEqual(played.code, 0, played.errors);
    assert.equal(played.answered, false);
  });

  it("reaches Genex's API with a way to Genex, its profile made without the internet", async () => {
    const played = await play(`${PLAY_ORIGIN.api}/`, { GENEX_API_URL: PLAY_ORIGIN.api });
    assert.equal(played.code, 0, played.errors);
    assert.equal(played.answered, true);
  });

  it("still reaches no port on this computer's loopback with a way to Genex", async () => {
    const { port } = loopback.address() as AddressInfo;
    const played = await play(`http://127.0.0.1:${port}/`, { GENEX_API_URL: PLAY_ORIGIN.api });
    assert.notEqual(played.code, 0, played.errors);
    assert.equal(played.answered, false);
    assert.equal(loopbackHits, 0, "the loopback server saw no request");
  });
});
