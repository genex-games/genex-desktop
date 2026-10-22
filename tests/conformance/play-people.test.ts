/**
 * Play's people: main reads the signed-in Genex account, public profiles, friends and people search
 * from genex.games, and writes the account's name, picture, friendships and visibility with the
 * account's token. What the API answers is hostile input (a row without an id is dropped, a picture
 * off Genex's hosts is never handed on, nobody's email is), and a bad id, name, query or picture
 * from the renderer never reaches the network.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  FIXTURE_ACCOUNT_TOKEN,
  FixtureAccount,
  fixtureAccountToken,
  fixturePeopleAnswer,
} from "../../src/main/dev/fixture-people.ts";
import { type GalleryAnswer, type GalleryRequest, PlayRoute, SignInNeeded } from "../../src/main/play/gallery.ts";
import { fixturePlayRequest } from "../../src/main/dev/fixture-play.ts";
import { isAvatarWebp, PeopleRoute, playPeople, toPerson } from "../../src/main/play/people.ts";
import { HandleSaveOutcome, HandleState } from "../../src/shared/handle.ts";
import { PLAY_ORIGIN } from "../../src/shared/play.ts";
import { AvatarStyle, FriendAction, FriendStatus, PresenceVisibility } from "../../src/shared/play-people.ts";

const TOKEN = "genex-cli-token";
const AVATAR = "https://api.genex.games/api/character-assets/avatars/u1/1.webp";

interface Call {
  route: string;
  method: string;
  token?: string;
  body?: unknown;
}

const ok = (body: unknown): GalleryAnswer => ({ status: 200, body });
const status = (code: number): GalleryAnswer => ({ status: code, body: null });

/** People over a scripted API: each call answers what `answers` says, and every call and upload is kept. */
function rig(
  answers: (call: Call) => GalleryAnswer,
  options: { token?: string | undefined; upload?: number; web?: string } = {},
) {
  let token = "token" in options ? options.token : TOKEN;
  const calls: Call[] = [];
  const refused: string[] = [];
  const uploads: Array<{ url: string; bytes: number; type: string }> = [];
  let clock = 1_000_000;
  const request: GalleryRequest = async (route, init) => {
    const call: Call = { route, method: init.method ?? "GET", ...init };
    calls.push(call);
    return answers(call);
  };
  const people = playPeople({
    request,
    token: async () => token,
    now: () => clock,
    upload: async (url, bytes, type) => {
      uploads.push({ url, bytes: bytes.length, type });
      return options.upload ?? 200;
    },
    refused: (value) => refused.push(value),
    web: options.web ?? PLAY_ORIGIN.web,
  });
  return {
    people,
    calls,
    uploads,
    refused,
    advance: (ms: number) => (clock += ms),
    signIn: (value: string | undefined) => {
      token = value;
    },
  };
}

/** The account as `/api/me` and the public profile answer it. */
function accountApi(call: Call): GalleryAnswer {
  if (call.route === PeopleRoute.Me)
    return ok({
      user: {
        id: "u1",
        name: "Rab Neba",
        email: "private@example.com",
        image: AVATAR,
        createdAt: "2026-07-18T10:53:42Z",
      },
      isAdmin: false,
    });
  if (call.route === PeopleRoute.user("u1")) return ok({ user: { id: "u1", name: "Rab Neba", pro: true }, games: [] });
  return status(404);
}

/** A small WebP: the RIFF/WEBP header and a little body. */
function webp(size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  return bytes;
}

describe("the Genex account Play is signed in as", () => {
  it("is null signed out, without a call", async () => {
    const { people, calls } = rig(accountApi, { token: undefined });
    assert.equal(await people.me(), null);
    assert.equal(calls.length, 0);
  });

  it("is the account with its Pro flag and join date, never its email, and is read once a while", async () => {
    const { people, calls, advance } = rig(accountApi);
    const me = await people.me();
    assert.deepEqual(me, {
      id: "u1",
      name: "Rab Neba",
      handle: null,
      imageUrl: null,
      avatarVariant: 0,
      pro: true,
      joinedAt: "2026-07-18T10:53:42.000Z",
      avatarStyle: null,
      photoUrl: null,
      avatarVariantKept: false,
      handleChosen: null,
      isAdmin: false,
    });
    assert.ok(!JSON.stringify(me).includes("example.com"), "no email crosses");
    await people.me();
    assert.equal(calls.filter((c) => c.route === PeopleRoute.Me).length, 1, "kept a while");
    advance(60_000);
    await people.me();
    assert.equal(calls.filter((c) => c.route === PeopleRoute.Me).length, 2, "read again later");
  });

  it("is an admin only when genex.games says so outright", async () => {
    const answer = (isAdmin: unknown) => (call: Call) => {
      const kept = accountApi(call);
      return call.route === PeopleRoute.Me ? ok({ ...(kept.body as object), isAdmin }) : kept;
    };
    const cases: Array<[unknown, boolean]> = [
      [true, true],
      [false, false],
      ["true", false],
      [1, false],
      [undefined, false],
    ];
    for (const [isAdmin, expected] of cases)
      assert.equal((await rig(answer(isAdmin)).people.me())?.isAdmin, expected, JSON.stringify(isAdmin));
  });

  it("shows its photo only when it chose the photo, and keeps the photo it uploaded either way", async () => {
    const answer = (avatarStyle: string) => (call: Call) =>
      call.route === PeopleRoute.Me
        ? ok({ user: { id: "u1", name: "Rab Neba", image: AVATAR, photo: AVATAR, avatarStyle } })
        : accountApi(call);
    const photo = await rig(answer(AvatarStyle.Photo)).people.me();
    assert.equal(photo?.imageUrl, AVATAR);
    assert.equal(photo?.avatarStyle, AvatarStyle.Photo);
    const generated = await rig(answer(AvatarStyle.Generated)).people.me();
    assert.equal(generated?.imageUrl, null, "the generated avatar shows");
    assert.equal(generated?.photoUrl, AVATAR, "the uploaded photo is still there to switch back to");
    assert.equal((await rig(answer("sparkles")).people.me())?.avatarStyle, null, "an unknown style is no style");
  });

  it("switches between its generated avatar and its photo, everywhere at once", async () => {
    const { people, calls } = rig((call) => (call.method === "PATCH" ? ok({ user: {} }) : accountApi(call)));
    await people.setAvatarStyle(AvatarStyle.Photo);
    assert.deepEqual(
      calls.find((c) => c.method === "PATCH"),
      { route: PeopleRoute.MyAccount, method: "PATCH", token: TOKEN, body: { avatarStyle: "photo" } },
    );
    const before = calls.length;
    await assert.rejects(people.setAvatarStyle("sparkles" as AvatarStyle), /avatar style/);
    assert.equal(calls.length, before, "a bad style never reaches the network");
  });

  it("draws the avatar variant it regenerated to, and knows when genex.games keeps one", async () => {
    const answer = (avatarVariant: unknown) => (call: Call) =>
      call.route === PeopleRoute.Me ? ok({ user: { id: "u1", name: "Rab Neba", avatarVariant } }) : accountApi(call);
    const kept = await rig(answer(917_204)).people.me();
    assert.equal(kept?.avatarVariant, 917_204);
    assert.equal(kept?.avatarVariantKept, true);
    for (const bad of [-1, 1.5, 2_147_483_648, "7", undefined]) {
      const me = await rig(answer(bad)).people.me();
      assert.equal(me?.avatarVariant, 0, `${String(bad)} draws the first avatar`);
      assert.equal(me?.avatarVariantKept, false, `${String(bad)} is not a kept variant`);
    }
  });

  it("regenerates to a variant everywhere at once, and never sends a bad one", async () => {
    const { people, calls } = rig((call) => (call.method === "PATCH" ? ok({ user: {} }) : accountApi(call)));
    await people.setAvatarVariant(42);
    assert.deepEqual(
      calls.find((c) => c.method === "PATCH"),
      { route: PeopleRoute.MyAccount, method: "PATCH", token: TOKEN, body: { avatarVariant: 42 } },
    );
    const before = calls.length;
    for (const bad of [-1, 0.5, 2_147_483_648, Number.NaN])
      await assert.rejects(people.setAvatarVariant(bad), /avatar variant/, String(bad));
    assert.equal(calls.length, before, "a bad variant never reaches the network");
  });

  it("is null when Genex refuses the token, and says which token it refused", async () => {
    const { people, refused } = rig(() => status(401));
    assert.equal(await people.me(), null);
    assert.deepEqual(refused, [TOKEN], "the account reads as ended, not as signed out");
  });

  it("ends the sign-in on a 401 from any of the account's calls, not only its own read", async () => {
    const { people, refused } = rig((call) => (call.route === PeopleRoute.Friends ? status(401) : accountApi(call)));
    await assert.rejects(people.friends());
    assert.deepEqual(refused, [TOKEN]);
  });

  it("renames itself with a trimmed 2–20 character name, and sends nothing else", async () => {
    const { people, calls } = rig((call) => (call.method === "PATCH" ? ok({ user: {} }) : accountApi(call)));
    for (const bad of ["", " a ", "x".repeat(21), "   "]) await assert.rejects(people.rename(bad), /2 to 20/);
    assert.equal(calls.length, 0, "a bad name never reaches the network");
    await people.rename("  Rab  ");
    const patch = calls.find((c) => c.method === "PATCH");
    assert.deepEqual(patch, { route: PeopleRoute.MyAccount, method: "PATCH", token: TOKEN, body: { name: "Rab" } });
  });

  it("changes its picture: an upload address, the bytes there, then the commit, in that order", async () => {
    const { people, calls, uploads } = rig((call) => {
      if (call.route === PeopleRoute.AvatarUpload)
        return ok({ uploadUrl: "https://r2.example/avatars/u1.webp?sig=1", key: "avatars/u1/1.webp" });
      if (call.route === PeopleRoute.AvatarCommit) return ok({ user: {} });
      return accountApi(call);
    });
    await people.setAvatar(webp());
    assert.deepEqual(
      calls.filter((c) => c.method === "POST").map((c) => [c.route, c.body]),
      [
        [PeopleRoute.AvatarUpload, { bytes: 64 }],
        [PeopleRoute.AvatarCommit, { key: "avatars/u1/1.webp" }],
      ],
    );
    assert.deepEqual(uploads, [{ url: "https://r2.example/avatars/u1.webp?sig=1", bytes: 64, type: "image/webp" }]);
  });

  it("shows an uploaded photo at once where genex.games keeps the choice, and only there", async () => {
    const slot = { uploadUrl: "https://r2.example/avatars/u1.webp?sig=1", key: "avatars/u1/1.webp" };
    const keeps = (style: string | null) => (call: Call) => {
      if (call.route === PeopleRoute.AvatarUpload) return ok(slot);
      if (call.route === PeopleRoute.AvatarCommit || call.method === "PATCH") return ok({ user: {} });
      if (call.route === PeopleRoute.Me)
        return ok({ user: { id: "u1", name: "Rab Neba", image: AVATAR, photo: AVATAR, avatarStyle: style } });
      return accountApi(call);
    };
    const choosing = rig(keeps(AvatarStyle.Generated));
    await choosing.people.setAvatar(webp());
    assert.deepEqual(
      choosing.calls.filter((c) => c.method === "PATCH").map((c) => c.body),
      [{ avatarStyle: "photo" }],
    );
    const older = rig(keeps(null));
    await older.people.setAvatar(webp());
    assert.equal(older.calls.filter((c) => c.method === "PATCH").length, 0, "no choice to make where none is kept");
  });

  it("uploads nothing that is not a small WebP, and commits nothing that did not upload", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
    const cases: Array<[string, Uint8Array]> = [
      ["a PNG", png],
      ["too large", webp(512 * 1024 + 1)],
      ["too short", new Uint8Array(4)],
    ];
    for (const [name, bytes] of cases) {
      const { people, calls, uploads } = rig(accountApi);
      await assert.rejects(people.setAvatar(bytes), /WebP/, name);
      assert.equal(calls.length + uploads.length, 0, `${name}: nothing sent`);
    }
    const plain = rig((call) =>
      call.route === PeopleRoute.AvatarUpload ? ok({ uploadUrl: "http://r2.example/x", key: "k" }) : accountApi(call),
    );
    await assert.rejects(plain.people.setAvatar(webp()), /upload/);
    assert.equal(plain.uploads.length, 0, "never to a plain-http address");
    const refused = rig(
      (call) =>
        call.route === PeopleRoute.AvatarUpload
          ? ok({ uploadUrl: "https://r2.example/x", key: "k" })
          : accountApi(call),
      { upload: 403 },
    );
    await assert.rejects(refused.people.setAvatar(webp()), /did not upload/);
    assert.equal(refused.calls.filter((c) => c.route === PeopleRoute.AvatarCommit).length, 0, "no commit");
  });

  it("knows a WebP by its header", () => {
    assert.equal(isAvatarWebp(webp()), true);
    assert.equal(isAvatarWebp(new Uint8Array(64)), false);
  });
});

describe("profiles", () => {
  const api = (call: Call): GalleryAnswer => {
    if (call.route === PeopleRoute.user("u2"))
      return ok({
        user: {
          id: "u2",
          name: "Mira",
          image: "https://evil.example/x.png",
          createdAt: "2026-08-01T00:00:00Z",
          pro: false,
        },
        games: [
          {
            id: "g1",
            slug: "glass-orchard",
            title: "Glass Orchard",
            playsCount: 3,
            author: { id: "u2", name: "Mira" },
          },
          { id: "g2", title: "no slug" },
        ],
      });
    if (call.route === PeopleRoute.status("u2")) return ok({ status: FriendStatus.Incoming });
    if (call.route === PeopleRoute.userFriends("u2"))
      return ok({
        friends: [
          { id: "u9", name: "Zed", image: null, pro: false, games: 2, since: "2026-09-01T00:00:00Z", mutual: false },
          {
            id: "u8",
            name: "Ama",
            image: AVATAR,
            avatarStyle: "photo",
            playing: { slug: "stick-steel", title: "Stick & Steel" },
            games: 4,
            since: "2026-09-02T00:00:00Z",
            mutual: true,
          },
          { id: "../bad", name: "Path" },
        ],
      });
    return accountApi(call);
  };

  it("draws anyone's public profile, its games, and the viewer's relationship", async () => {
    const { people } = rig(api);
    const profile = await people.profile("u2");
    assert.equal(profile.person.imageUrl, null, "a picture off Genex's hosts is not handed on");
    assert.deepEqual(
      profile.games.map((g) => [g.slug, g.author.id]),
      [["glass-orchard", "u2"]],
    );
    assert.equal(profile.status, FriendStatus.Incoming);
    assert.equal((await people.profile("u1")).status, FriendStatus.Self);
  });

  it("keeps nothing of a profile read under way when a game on it changed", async () => {
    const held: Array<() => void> = [];
    let holding = true;
    let reads = 0;
    const people = playPeople({
      request: async (route, init) => {
        if (route === PeopleRoute.user("u2")) {
          reads += 1;
          if (holding) await new Promise<void>((resolve) => held.push(resolve));
        }
        return api({ route, method: init.method ?? "GET", ...init });
      },
      token: async () => TOKEN,
      now: () => 0,
      upload: async () => 200,
      web: PLAY_ORIGIN.web,
    });
    const reading = people.profile("u2");
    await setImmediate();
    people.forgetProfiles();
    holding = false;
    for (const answer of held.splice(0)) answer();
    await reading;
    await people.profile("u2");
    assert.equal(reads, 2, "read again: the one under way began before the change");
  });

  it("lists their friends, people the viewer knows first, each with their game, games and since when", async () => {
    const { people } = rig(api);
    const { friends } = await people.profile("u2");
    assert.deepEqual(
      friends?.map((f) => [f.id, f.mutual, f.playing?.slug ?? null, f.games, f.since, f.imageUrl]),
      [
        ["u8", true, "stick-steel", 4, "2026-09-02T00:00:00.000Z", AVATAR],
        ["u9", false, null, 2, "2026-09-01T00:00:00.000Z", null],
      ],
    );
  });

  it("counts players when genex.games does, and says nothing it does not", async () => {
    const counted = rig((call) =>
      call.route === PeopleRoute.user("u2")
        ? ok({ user: { id: "u2", name: "Mira" }, games: [], players: 9600 })
        : api(call),
    );
    assert.equal((await counted.people.profile("u2")).players, 9600);
    assert.equal((await rig(api).people.profile("u2")).players, null);
  });

  it("has no friends row for someone else while genex.games does not list them, and the account's own on its own", async () => {
    const own = [{ id: "u5", name: "Juno", image: null, pro: false, playing: null, games: 1 }];
    const older = (call: Call): GalleryAnswer => {
      if (call.route === PeopleRoute.userFriends("u2") || call.route === PeopleRoute.userFriends("u1"))
        return status(404);
      if (call.route === PeopleRoute.Friends) return ok({ friends: own });
      return api(call);
    };
    const { people } = rig(older);
    assert.equal((await people.profile("u2")).friends, null);
    assert.deepEqual(
      (await people.profile("u1")).friends?.map((f) => [f.id, f.games, f.mutual]),
      [["u5", 1, false]],
    );
  });

  it("never shows one viewer's read of a profile to the next one signed in", async () => {
    const { people, calls, signIn } = rig(api);
    await people.profile("u2");
    signIn("token-of-someone-else");
    await people.profile("u2");
    const reads = calls.filter((c) => c.route === PeopleRoute.user("u2")).map((c) => c.token);
    assert.deepEqual(reads, [TOKEN, "token-of-someone-else"], "the profile is read again for the new viewer");
    signIn(undefined);
    await people.profile("u2");
    assert.equal(
      calls.filter((c) => c.route === PeopleRoute.user("u2")).at(-1)?.token,
      undefined,
      "and once signed out",
    );
  });

  it("is None signed out, read without a token", async () => {
    const { people, calls } = rig(api, { token: undefined });
    assert.equal((await people.profile("u2")).status, FriendStatus.None);
    assert.ok(calls.every((c) => c.token === undefined));
  });

  it("refuses an id that is not an account's before any call", async () => {
    const { people, calls } = rig(api);
    for (const id of ["", "../me", "a/b", "x".repeat(65), "u 2"])
      await assert.rejects(people.profile(id), /Not a Genex account/, JSON.stringify(id));
    assert.equal(calls.length, 0);
  });
});

describe("friends", () => {
  const api = (call: Call): GalleryAnswer => {
    if (call.route === PeopleRoute.Friends)
      return ok({
        friends: [
          {
            id: "u2",
            name: "Mira",
            image: null,
            pro: false,
            playing: { slug: "stick-steel", title: "Stick & Steel" },
            games: 3,
          },
          { id: "u3", name: "Tomás", image: AVATAR, pro: true, playing: { slug: "../x", title: "bad" } },
          { id: "../evil", name: "Path" },
          { id: "u4", name: "" },
          { id: "u2", name: "Mira again" },
        ],
      });
    if (call.route === PeopleRoute.Requests)
      return ok({
        incoming: [{ id: "u5", name: "Juno", requestedAt: "2026-10-12T09:00:00Z" }],
        outgoing: [{ id: "u6", name: "Ola", requestedAt: "not a date" }],
      });
    if (call.route === PeopleRoute.Visibility) return ok({ presenceVisibility: "hidden" });
    if (call.route === PlayRoute.Referral)
      return ok({ code: "abc", link: "https://genex.games/?ref=abc", inviterBonus: 100 });
    return status(404);
  };

  it("reads the whole Friends page at once, keeping only rows that name a person", async () => {
    const { people } = rig(api);
    const page = await people.friends();
    assert.deepEqual(
      page.friends.map((f) => [f.id, f.playing?.slug ?? null, f.games]),
      [
        ["u2", "stick-steel", 3],
        ["u3", null, null],
      ],
    );
    assert.deepEqual(
      page.incoming.map((r) => r.id),
      ["u5"],
    );
    assert.deepEqual(page.outgoing, [], "a request without a date is dropped");
    assert.equal(page.visibility, PresenceVisibility.Hidden);
    assert.equal(page.inviteLink, "https://genex.games/?ref=abc");
    assert.equal(page.inviteBonus, 100);
  });

  it("hands on an invite link only on genex.games itself", async () => {
    for (const link of ["http://genex.games/?ref=a", "https://evil.example/?ref=a", "javascript:alert(1)"]) {
      const { people } = rig((call) => (call.route === PlayRoute.Referral ? ok({ link }) : api(call)));
      assert.equal((await people.friends()).inviteLink, null, link);
    }
  });

  it("needs the account", async () => {
    const { people, calls } = rig(api, { token: undefined });
    await assert.rejects(people.friends(), SignInNeeded);
    assert.equal(calls.length, 0);
  });

  it("sends each action to its route, and answers the relationship after it", async () => {
    const { people, calls } = rig((call) =>
      call.route === PeopleRoute.Requests ? ok({ status: "friends", user: {} }) : ok({}),
    );
    assert.equal(await people.act(FriendAction.Add, "u7"), FriendStatus.Friends, "a reciprocal ask accepts");
    assert.equal(await people.act(FriendAction.Accept, "u7"), FriendStatus.Friends);
    assert.equal(await people.act(FriendAction.Withdraw, "u7"), FriendStatus.None);
    assert.equal(await people.act(FriendAction.Remove, "u7"), FriendStatus.None);
    assert.deepEqual(
      calls.map((c) => [c.method, c.route, c.body ?? null]),
      [
        ["POST", PeopleRoute.Requests, { userId: "u7" }],
        ["POST", PeopleRoute.accept("u7"), null],
        ["DELETE", PeopleRoute.request("u7"), null],
        ["DELETE", PeopleRoute.friend("u7"), null],
      ],
    );
  });

  it("reads a refused token as signed out, and refuses a bad id before any call", async () => {
    const refused = rig(() => status(401));
    await assert.rejects(refused.people.act(FriendAction.Add, "u7"), SignInNeeded);
    const { people, calls } = rig(() => ok({}));
    await assert.rejects(people.act(FriendAction.Add, "../u7"), /Not a Genex account/);
    assert.equal(calls.length, 0);
  });

  it("sets who sees the game the account is in", async () => {
    const { people, calls } = rig(() => ok({ presenceVisibility: "hidden" }));
    assert.equal(await people.setVisibility(PresenceVisibility.Hidden), PresenceVisibility.Hidden);
    assert.deepEqual(calls[0], {
      route: PeopleRoute.Visibility,
      method: "PATCH",
      token: TOKEN,
      body: { presenceVisibility: "hidden" },
    });
  });
});

describe("people search", () => {
  it("sends a query of 2–40 characters, and answers each person with the viewer's relationship", async () => {
    const { people, calls } = rig(() =>
      ok({
        people: [{ id: "u8", name: "Milo", image: null, pro: true, status: "outgoing", games: 7 }, { name: "no id" }],
      }),
    );
    assert.deepEqual(await people.search(" m "), { people: [], unavailable: false });
    assert.deepEqual(await people.search("x".repeat(41)), { people: [], unavailable: false });
    assert.equal(calls.length, 0, "too short or too long sends nothing");
    const found = await people.search(" mi ");
    assert.deepEqual(found.people, [
      {
        id: "u8",
        name: "Milo",
        handle: null,
        imageUrl: null,
        avatarVariant: 0,
        pro: true,
        status: "outgoing",
        games: 7,
      },
    ]);
    assert.equal(calls[0]?.route, `${PeopleRoute.Search}?q=mi`);
  });

  it("says search is not there yet when genex.games has no such route", async () => {
    const { people } = rig(() => status(404));
    assert.deepEqual(await people.search("mira"), { people: [], unavailable: true });
  });
});

describe("the fixture launch's people", () => {
  const noGames = { games: () => [] };

  it("answers a public profile signed out, and nothing else", () => {
    assert.equal(fixturePeopleAnswer(PeopleRoute.user("fx-mira-kova"), { method: "GET" }, noGames)?.status, 200);
    assert.equal(fixturePeopleAnswer(PeopleRoute.user("fx-nobody"), {}, noGames)?.status, 404);
    assert.equal(fixturePeopleAnswer(PeopleRoute.Friends, {}, noGames)?.status, 401);
    assert.equal(fixturePeopleAnswer(PeopleRoute.Me, { token: "someone-else" }, noGames)?.status, 401);
    assert.equal(fixturePeopleAnswer(PlayRoute.Feed, {}, noGames), null, "the gallery's routes are not its");
  });

  it("is a signed-in account with friends, requests and search under its token", async () => {
    const request: GalleryRequest = async (route, init) =>
      fixturePeopleAnswer(route, init, noGames) ?? { status: 404, body: null };
    const people = playPeople({
      request,
      token: async () => FIXTURE_ACCOUNT_TOKEN,
      now: () => 0,
      upload: async () => 200,
      web: PLAY_ORIGIN.web,
    });
    assert.equal((await people.me())?.name, "Rab Neba");
    const page = await people.friends();
    assert.ok(page.friends.length > 0 && page.incoming.length > 0 && page.outgoing.length > 0);
    assert.ok(page.friends[0]?.playing, "whoever is playing comes first");
    const juno = page.incoming[0]?.id ?? "";
    assert.equal(await people.act(FriendAction.Accept, juno), FriendStatus.Friends);
    assert.ok(
      (await people.friends()).friends.some((f) => f.id === juno),
      "the accepted request is a friend now",
    );
    assert.ok((await people.search("mi")).people.length > 0);
  });
});

describe("a person's avatar", () => {
  it("is their photo only when they chose one on a host the app loads from; everyone else is generated", () => {
    const person = (fields: Record<string, unknown>) => toPerson({ id: "u1", name: "Ann", image: AVATAR, ...fields });
    assert.equal(person({ avatarStyle: "photo" })?.imageUrl, AVATAR);
    assert.equal(person({ avatarStyle: "generated" })?.imageUrl, null);
    assert.equal(person({})?.imageUrl, null, "while genex.games does not say, the generated avatar shows");
    assert.equal(person({ avatarStyle: "photo", image: "https://evil.example/a.png" })?.imageUrl, null);
  });
});

describe("the fixture accounts", () => {
  const catalog = {
    games: (authorId: string) => (authorId === "fx-simeon-m" ? [{ id: "g", slug: "s", title: "S" }] : []),
  };
  const me = (account: (typeof FixtureAccount)[keyof typeof FixtureAccount]) =>
    fixturePeopleAnswer(PeopleRoute.user("fx-rab-neba"), { token: fixtureAccountToken(account) }, catalog)?.body as {
      games: unknown[];
    };

  it("sign in under their own tokens, with no games, one, or the full set", () => {
    assert.equal(fixtureAccountToken(FixtureAccount.Full), FIXTURE_ACCOUNT_TOKEN);
    assert.equal(me(FixtureAccount.New).games.length, 0);
    assert.equal(me(FixtureAccount.Fresh).games.length, 1);
    assert.equal(me(FixtureAccount.Full).games.length, 1);
    assert.equal(
      fixturePeopleAnswer(PeopleRoute.Me, { token: fixtureAccountToken(FixtureAccount.Quiet) }, catalog)?.status,
      200,
    );
  });

  it("starts a new account with nobody: no friends and no requests", () => {
    const token = fixtureAccountToken(FixtureAccount.New);
    const friends = fixturePeopleAnswer(PeopleRoute.Friends, { token }, catalog)?.body as { friends: unknown[] };
    const asks = fixturePeopleAnswer(PeopleRoute.Requests, { token }, catalog)?.body as { incoming: unknown[] };
    assert.equal(friends.friends.length, 0);
    assert.equal(asks.incoming.length, 0);
    const full = fixtureAccountToken(FixtureAccount.Full);
    const theirs = fixturePeopleAnswer(PeopleRoute.Friends, { token: full }, catalog)?.body as { friends: unknown[] };
    assert.ok(theirs.friends.length > 0, "the other accounts keep theirs");
  });

  it("keeps a photo it uploaded, and refuses Photo before there is one", async () => {
    const token = fixtureAccountToken(FixtureAccount.Full);
    const before = fixturePeopleAnswer(
      PeopleRoute.MyAccount,
      { method: "PATCH", token, body: { avatarStyle: "photo" } },
      catalog,
    );
    assert.equal(before?.status, 400);
    fixturePeopleAnswer(PeopleRoute.AvatarCommit, { method: "POST", token, body: { key: "k" } }, catalog);
    const after = fixturePeopleAnswer(PeopleRoute.Me, { token }, catalog)?.body as {
      user: { avatarStyle: string; photo: string };
    };
    assert.equal(after.user.avatarStyle, "generated", "the upload keeps the picture; the choice is its own write");
    assert.match(after.user.photo, /^data:image\/svg\+xml/);
    fixturePeopleAnswer(PeopleRoute.MyAccount, { method: "PATCH", token, body: { avatarStyle: "generated" } }, catalog);
  });

  it("keeps a regenerated avatar for the next read, in a new session as in the one that chose it", async () => {
    const session = () =>
      playPeople({
        request: fixturePlayRequest,
        token: async () => fixtureAccountToken(FixtureAccount.Full),
        now: () => 0,
        upload: async () => 200,
        web: PLAY_ORIGIN.web,
      });
    const chosen = await session().setAvatarVariant(917_204);
    assert.equal(chosen?.avatarVariant, 917_204, "the session that chose it reads it back");
    const next = await session().me();
    assert.equal(next?.avatarVariant, 917_204, "a new session reads what was kept");
    assert.equal(next?.avatarVariantKept, true);
    await session().setAvatarVariant(0);
  });

  it("keeps a regenerated avatar, and a refused write changes nothing beside it", () => {
    const token = fixtureAccountToken(FixtureAccount.Full);
    const patch = (body: unknown) =>
      fixturePeopleAnswer(PeopleRoute.MyAccount, { method: "PATCH", token, body }, catalog)?.status;
    const account = () => {
      const answer = fixturePeopleAnswer(PeopleRoute.Me, { token }, catalog);
      assert.ok(answer, "the fixture answers /api/me");
      return (answer.body as { user: { name: string; avatarVariant: number } }).user;
    };
    assert.equal(account().avatarVariant, 0);
    assert.equal(patch({ avatarVariant: 917_204 }), 200);
    assert.equal(account().avatarVariant, 917_204);
    assert.equal(patch({ avatarVariant: -1, name: "Renamed" }), 400);
    assert.notEqual(account().name, "Renamed", "a refused write keeps the name too");
    assert.equal(account().avatarVariant, 917_204);
    assert.equal(patch({ avatarVariant: 0 }), 200);
  });
});

describe("nicknames", () => {
  /** `/api/me` with these extra fields on its user. */
  const meWith = (fields: Record<string, unknown>) => (call: Call) =>
    call.route === PeopleRoute.Me ? ok({ user: { id: "u1", name: "Rab Neba", ...fields } }) : accountApi(call);

  it("reads a server without handles as one: no handle, and no welcome to ask for one", async () => {
    const me = await rig(accountApi).people.me();
    assert.equal(me?.handle, null);
    assert.equal(me?.handleChosen, null, "absent is not false: nothing reopens the welcome");
  });

  it("reads the account's handle and whether it chose it, each only when well formed", async () => {
    const chosen = await rig(meWith({ handle: "rabneba", handleChosen: true })).people.me();
    assert.deepEqual([chosen?.handle, chosen?.handleChosen], ["rabneba", true]);
    const backfilled = await rig(meWith({ handle: "rabneba", handleChosen: false })).people.me();
    assert.deepEqual([backfilled?.handle, backfilled?.handleChosen], ["rabneba", false]);
    const unreached = await rig(meWith({ handle: null, handleChosen: false })).people.me();
    assert.deepEqual([unreached?.handle, unreached?.handleChosen], [null, false]);
    for (const handle of ["RabNeba", "rab--neba", "../x", 7, ""]) {
      const me = await rig(meWith({ handle, handleChosen: true })).people.me();
      assert.equal(me?.handle, null, JSON.stringify(handle));
    }
    for (const handleChosen of ["yes", 1, null]) {
      const me = await rig(meWith({ handle: "rabneba", handleChosen })).people.me();
      assert.equal(me?.handleChosen, null, JSON.stringify(handleChosen));
    }
  });

  it("gives every person the handle the API names, or none", () => {
    assert.equal(toPerson({ id: "u2", name: "Mira", handle: "mira" })?.handle, "mira");
    assert.equal(toPerson({ id: "u2", name: "Mira" })?.handle, null);
    assert.equal(toPerson({ id: "u2", name: "Mira", handle: "Mira K" })?.handle, null);
  });

  it("judges a handle's shape and the account's own at once, asking genex.games only about the rest", async () => {
    const { people, calls } = rig((call) =>
      call.route.startsWith(PeopleRoute.HandleCheck)
        ? ok({ handle: "rab", state: "taken", suggestions: ["rabneba2", "BAD", "rab-n", "rab3", "rab4"] })
        : meWith({ handle: "rabneba", handleChosen: false })(call),
    );
    assert.deepEqual(await people.checkHandle("rn"), { handle: "rn", state: HandleState.TooShort, suggestions: [] });
    assert.deepEqual(await people.checkHandle("@RabNeba"), {
      handle: "rabneba",
      state: HandleState.Yours,
      suggestions: [],
    });
    assert.equal(calls.filter((c) => c.route.startsWith(PeopleRoute.HandleCheck)).length, 0);
    const taken = await people.checkHandle(" Rab ");
    assert.deepEqual(taken, { handle: "rab", state: HandleState.Taken, suggestions: ["rabneba2", "rab-n", "rab3"] });
    const asked = calls.filter((c) => c.route.startsWith(PeopleRoute.HandleCheck));
    assert.deepEqual(
      asked.map((c) => [c.route, c.token]),
      [[`${PeopleRoute.HandleCheck}?handle=rab`, TOKEN]],
    );
  });

  it("reads a check that names no known state as a failed read, never as free", async () => {
    for (const body of [{ state: "available" }, { state: null }, null, "free"]) {
      const { people } = rig((call) => (call.route.startsWith(PeopleRoute.HandleCheck) ? ok(body) : accountApi(call)));
      await assert.rejects(people.checkHandle("rabbit"), JSON.stringify(body));
    }
    const signedOut = rig(accountApi, { token: undefined });
    await assert.rejects(signedOut.people.checkHandle("rabbit"), SignInNeeded);
    assert.equal(signedOut.calls.length, 0);
  });

  it("saves a handle, then reads the account again", async () => {
    let chosen = false;
    const { people, calls } = rig((call) => {
      if (call.method === "PATCH") {
        chosen = true;
        return ok({ user: { id: "u1", handle: "rab-neba", handleChosen: true } });
      }
      return meWith({ handle: chosen ? "rab-neba" : "rabneba", handleChosen: chosen })(call);
    });
    assert.equal((await people.me())?.handleChosen, false);
    const saved = await people.setHandle(" @Rab-Neba ");
    assert.deepEqual(
      calls.filter((c) => c.method === "PATCH"),
      [{ route: PeopleRoute.MyAccount, method: "PATCH", token: TOKEN, body: { handle: "rab-neba" } }],
    );
    assert.equal(saved.outcome, HandleSaveOutcome.Saved);
    assert.deepEqual(
      saved.outcome === HandleSaveOutcome.Saved ? [saved.me?.handle, saved.me?.handleChosen] : null,
      ["rab-neba", true],
      "the cached account is read again",
    );
  });

  it("refuses a handle of the wrong shape before any call", async () => {
    const { people, calls } = rig(accountApi);
    assert.deepEqual(await people.setHandle("rab--neba"), {
      outcome: HandleSaveOutcome.Refused,
      check: { handle: "rab--neba", state: HandleState.DashEdge, suggestions: [] },
    });
    assert.equal(calls.length, 0);
  });

  it("reads genex.games' refusals into what the field shows", async () => {
    const refusing = (answer: GalleryAnswer) => rig((call) => (call.method === "PATCH" ? answer : accountApi(call)));
    const taken = await refusing({
      status: 400,
      body: { error: "handle_taken", suggestions: ["rab2", "rab-neba", "../x"] },
    }).people.setHandle("rab");
    assert.deepEqual(taken, {
      outcome: HandleSaveOutcome.Refused,
      check: { handle: "rab", state: HandleState.Taken, suggestions: ["rab2", "rab-neba"] },
    });
    const invalid = await refusing({
      status: 400,
      body: { error: "handle_invalid", problem: "too_long" },
    }).people.setHandle("rabbit");
    assert.deepEqual(invalid, {
      outcome: HandleSaveOutcome.Refused,
      check: { handle: "rabbit", state: HandleState.TooLong, suggestions: [] },
    });
    const often = await refusing({ status: 429, body: { error: "handle_changes_exhausted" } }).people.setHandle(
      "rabbit",
    );
    assert.deepEqual(often, { outcome: HandleSaveOutcome.TooManyChanges });
    // Only genex.games' own word for it: a plain rate limit is no verdict on the handle.
    await assert.rejects(
      refusing({ status: 429, body: { error: "Too many requests" } }).people.setHandle("rabbit"),
      /429/,
    );
    // A refusal that names no shape problem ("yours", "free") must not read as one the field could pass.
    for (const problem of ["yours", "free", "taken"]) {
      await assert.rejects(
        refusing({ status: 400, body: { error: "handle_invalid", problem } }).people.setHandle("rabbit"),
        /400/,
        problem,
      );
    }
    await assert.rejects(
      refusing({ status: 400, body: { error: "something else" } }).people.setHandle("rabbit"),
      /400/,
    );
    await assert.rejects(refusing({ status: 500, body: null }).people.setHandle("rabbit"), /500/);
    await assert.rejects(refusing(status(401)).people.setHandle("rabbit"), SignInNeeded);
  });

  it("hands on an invite link only on the website Play links to", async () => {
    const referral = (link: string) => (call: Call) =>
      call.route === PlayRoute.Referral ? ok({ code: "abc", link, inviterBonus: 100 }) : ok({});
    const handleLink = "https://genex.games/@rabneba/invite?ref=k7x2abcd";
    assert.equal((await rig(referral(handleLink)).people.friends()).inviteLink, handleLink, "its code kept");
    const local = "http://localhost:5173/@rabneba/invite?ref=k7x2abcd";
    assert.equal((await rig(referral(local), { web: "http://localhost:5173" }).people.friends()).inviteLink, local);
    assert.equal(
      (await rig(referral(handleLink), { web: "http://localhost:5173" }).people.friends()).inviteLink,
      null,
      "another website's link is not handed on",
    );
    assert.equal((await rig(referral(local)).people.friends()).inviteLink, null);
  });
});

describe("the fixture accounts' nicknames", () => {
  const catalog = { games: () => [] };
  const session = (account: (typeof FixtureAccount)[keyof typeof FixtureAccount]) =>
    playPeople({
      request: fixturePlayRequest,
      token: async () => fixtureAccountToken(account),
      now: () => 0,
      upload: async () => 200,
      web: PLAY_ORIGIN.web,
    });

  it("give everyone a handle, and ask a new account and the nickname account to choose theirs", async () => {
    const full = await session(FixtureAccount.Full).me();
    assert.deepEqual([full?.handle, full?.handleChosen], ["rabneba", true]);
    assert.equal((await session(FixtureAccount.New).me())?.handleChosen, false);
    const unchosen = await session(FixtureAccount.Nickname).me();
    assert.deepEqual([unchosen?.handle, unchosen?.handleChosen], ["rabneba", false]);
    const friends = await session(FixtureAccount.Full).friends();
    assert.ok(
      friends.friends.every((f) => f.handle !== null),
      "every friend has a handle",
    );
    assert.equal(friends.inviteLink, "https://genex.games/@rabneba/invite?ref=fixture1");
  });

  it("answer a check as genex.games would: a few names taken, Genex's own words kept, the account's own its", async () => {
    const people = session(FixtureAccount.Full);
    const states = async (handles: string[]) =>
      Promise.all(handles.map(async (handle) => (await people.checkHandle(handle)).state));
    assert.deepEqual(
      await states(["rab", "max", "neo", "simeonm", "admin", "genex", "my-genex-games", "rabneba", "zebra"]),
      [
        HandleState.Taken,
        HandleState.Taken,
        HandleState.Taken,
        HandleState.Taken,
        HandleState.Reserved,
        HandleState.Reserved,
        HandleState.Reserved,
        HandleState.Yours,
        HandleState.Free,
      ],
    );
    assert.deepEqual((await people.checkHandle("rab")).suggestions, ["rabneba", "rab-neba", "rab2"]);
    assert.equal(
      fixturePeopleAnswer(`${PeopleRoute.HandleCheck}?handle=rab`, { token: undefined }, catalog)?.status,
      401,
      "signed out, nothing is checked",
    );
  });

  it("save a free handle for the launch, and refuse a taken one with handles to try", async () => {
    const people = session(FixtureAccount.Nickname);
    const refused = await people.setHandle("max");
    assert.equal(refused.outcome, HandleSaveOutcome.Refused);
    assert.equal((await people.me())?.handleChosen, false, "a refusal changes nothing");
    const saved = await people.setHandle("rab-neba");
    assert.equal(saved.outcome, HandleSaveOutcome.Saved);
    const me = await session(FixtureAccount.Nickname).me();
    assert.deepEqual([me?.handle, me?.handleChosen], ["rab-neba", true]);
    assert.equal(
      (await session(FixtureAccount.Full).friends()).inviteLink,
      "https://genex.games/@rab-neba/invite?ref=fixture1",
    );
    await people.setHandle("rabneba");
  });
});
