/**
 * A downloaded game's play reaching genex.games. Most native builds never sign in to Genex, so a
 * game people install and play kept a play count of 0: Play now reports the play once the game's
 * window is on screen. genex.games counts each person once per game, as it does a web play: the
 * signed-in account, or, signed out, this computer's own id, kept beside the installed games.
 */
import assert from "node:assert/strict";
import { readFile, readlink, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { type GalleryAnswer, PlayRoute } from "../../src/main/play/gallery.ts";
import { nativePlays } from "../../src/main/play/native-plays.ts";
import { tmpDir } from "../helpers/tmp.ts";

const TOKEN = "tok_secret_0123456789abcdef";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Sent {
  route: string;
  method: string | undefined;
  body: unknown;
  token: string | undefined;
}

/** A reporter over a fresh folder whose calls genex.games answers with `answer`, signed in with `token`. */
async function reporter(
  options: {
    token?: string | (() => string | undefined);
    answer?: (sent: Sent) => Promise<GalleryAnswer>;
    root?: string;
  } = {},
) {
  const root = options.root ?? (await tmpDir("native-plays-"));
  const sent: Sent[] = [];
  const logs: string[] = [];
  const refused: string[] = [];
  const plays = nativePlays({
    root,
    request: async (route, init) => {
      const one = { route, method: init.method, body: init.body, token: init.token };
      sent.push(one);
      return options.answer ? options.answer(one) : { status: 200, body: { ok: true, counted: true } };
    },
    token: async () => (typeof options.token === "function" ? options.token() : options.token),
    refused: (token) => refused.push(token),
    log: (line) => logs.push(line),
  });
  return { plays, root, sent, logs, refused };
}

/** The id each report sent, in order. */
const playerIds = (sent: Sent[]) => sent.map((one) => (one.body as { playerId?: string }).playerId);

describe("a downloaded game's play on genex.games", () => {
  it("counts under the signed-in account and sends no id of this computer", async () => {
    const { plays, root, sent } = await reporter({ token: TOKEN });
    await plays.report("dust-runners");
    assert.deepEqual(sent, [
      { route: PlayRoute.NativePlay, method: "POST", body: { slug: "dust-runners" }, token: TOKEN },
    ]);
    await assert.rejects(readFile(path.join(root, "player.json")), { code: "ENOENT" });
  });

  it("signed out, sends this computer's own id: one id, made once, kept across launches of Genex", async () => {
    const first = await reporter();
    await Promise.all([first.plays.report("dust-runners"), first.plays.report("iron-tide")]);
    const [id, again] = playerIds(first.sent);
    assert.match(id ?? "", UUID);
    assert.equal(again, id, "two games at once share the computer's one id");
    assert.deepEqual(
      first.sent.map((one) => [one.route, one.token]),
      [
        [PlayRoute.NativePlay, undefined],
        [PlayRoute.NativePlay, undefined],
      ],
    );

    const kept = JSON.parse(await readFile(path.join(first.root, "player.json"), "utf8"));
    assert.deepEqual(kept, { playerId: id });

    const restarted = await reporter({ root: first.root });
    await restarted.plays.report("dust-runners");
    assert.deepEqual(playerIds(restarted.sent), [id], "the next start of Genex reads the same id");
  });

  it("ends a sign-in genex.games refuses, and counts the play as this computer's instead", async () => {
    const answer = async (one: Sent): Promise<GalleryAnswer> =>
      one.token ? { status: 401, body: { error: "Unauthorized" } } : { status: 200, body: { ok: true, counted: true } };
    const { plays, sent, logs, refused } = await reporter({ token: TOKEN, answer });
    await plays.report("dust-runners");
    assert.deepEqual(refused, [TOKEN]);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0]?.body, { slug: "dust-runners" });
    assert.equal(sent[1]?.token, undefined, "the second report carries no token");
    assert.match(playerIds(sent)[1] ?? "", UUID);
    assert.deepEqual(logs, []);

    await plays.report("iron-tide");
    assert.deepEqual(
      sent.slice(2).map((one) => one.token),
      [undefined],
      "the next play goes signed out at once, never with the refused token",
    );
  });

  it("counts under the account again once it signs in anew after a refusal", async () => {
    let current = TOKEN;
    const answer = async (one: Sent): Promise<GalleryAnswer> =>
      one.token === TOKEN ? { status: 401, body: { error: "Unauthorized" } } : { status: 200, body: { ok: true } };
    const { plays, sent } = await reporter({ token: () => current, answer });
    await plays.report("dust-runners");
    current = "tok_fresh_fedcba9876543210";
    await plays.report("iron-tide");
    assert.deepEqual(sent.at(-1), {
      route: PlayRoute.NativePlay,
      method: "POST",
      body: { slug: "iron-tide" },
      token: "tok_fresh_fedcba9876543210",
    });
  });

  it("drops a refused or failed report with a log line that carries no token, and never throws", async () => {
    const answers: Array<(sent: Sent) => Promise<GalleryAnswer>> = [
      async () => ({ status: 404, body: { error: "Not found" } }),
      async () => ({ status: 503, body: null }),
      async () => {
        throw new Error("getaddrinfo ENOTFOUND api.genex.games");
      },
    ];
    for (const answer of answers) {
      const { plays, sent, logs } = await reporter({ token: TOKEN, answer });
      await plays.report("dust-runners");
      assert.equal(sent.length, 1, "tried once, never again");
      assert.equal(logs.length, 1);
      assert.match(logs[0] ?? "", /dust-runners/);
      assert.ok(!logs[0]?.includes(TOKEN));
    }
  });

  it("counts nothing for a name that is not a game address", async () => {
    const { plays, sent } = await reporter({ token: TOKEN });
    await plays.report("../dust-runners");
    assert.deepEqual(sent, []);
  });
});

describe("this computer's kept id for play counts", () => {
  it("keeps a kept id it cannot read now, and drops that play instead of counting this computer again", async () => {
    const root = await tmpDir("native-plays-");
    const file = path.join(root, "player.json");
    await symlink(file, file);
    const { plays, sent, logs } = await reporter({ root });
    await plays.report("dust-runners");
    assert.deepEqual(sent, []);
    assert.equal(logs.length, 1);
    assert.equal(await readlink(file), file, "the kept file is as it was");
  });

  it("replaces a kept id that is not one it made", async () => {
    const root = await tmpDir("native-plays-");
    for (const kept of ["not json", JSON.stringify({ playerId: "../../etc" }), JSON.stringify({ playerId: 7 })]) {
      await writeFile(path.join(root, "player.json"), kept);
      const { plays, sent } = await reporter({ root });
      await plays.report("dust-runners");
      assert.match(playerIds(sent)[0] ?? "", UUID, kept);
    }
  });
});
