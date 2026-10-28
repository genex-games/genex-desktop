/**
 * A published game's card menu: who gets which items, the shape every change reaches genex.games in,
 * a new cover's checks, and the fixture launch's own genex.games. What the renderer
 * hands main is hostile input: a bad id, a change of the wrong shape or a picture that is not what it
 * says sends nothing, and genex.games' refusals read as refusals.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FixtureAccount, fixtureAccountToken } from "../../src/main/dev/fixture-people.ts";
import { fixturePlayRequest } from "../../src/main/dev/fixture-play.ts";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { type PlayIpcDeps, registerPlayIpc } from "../../src/main/ipc/play.ts";
import { gameLinks } from "../../src/main/play/game-links.ts";
import {
  type GalleryAnswer,
  GalleryError,
  type GalleryRequest,
  playGallery,
  SignInNeeded,
} from "../../src/main/play/gallery.ts";
import { createPlayManage, type PlayManage } from "../../src/main/play/manage.ts";
import { fixtureUpload, playPeople } from "../../src/main/play/people.ts";
import { PLAY_ORIGIN, PlayCategory, type PlayGame, PlayShelf } from "../../src/shared/play.ts";
import {
  isPlayGameChange,
  isTaggedCategories,
  PLAY_COVER_MAX_BYTES,
  PlayCardAction,
  PlayChangeKind,
  PlayChangeOutcome,
  PlayCoverType,
  type PlayGameChange,
  PlayMobileSupport,
  playCardMenu,
} from "../../src/shared/play-manage.ts";

const TOKEN = "genex-cli-token";
const GAME = "cm1";
const COVER = "https://cdn.genex.technology/covers/cm1.webp";

interface Call {
  route: string;
  method: string;
  token?: string;
  body?: unknown;
}

const ok = (body: unknown): GalleryAnswer => ({ status: 200, body });
const answered = (status: number, body: unknown = null): GalleryAnswer => ({ status, body });

/** Manage over a scripted API: each call answers what `answers` says; calls, uploads and `changed` are kept. */
function rig(
  answers: (call: Call) => GalleryAnswer = () => ok({}),
  options: { token?: string | undefined; upload?: number } = {},
) {
  const token = "token" in options ? options.token : TOKEN;
  const calls: Call[] = [];
  const uploads: Array<{ url: string; bytes: number; type: string }> = [];
  let changes = 0;
  const request: GalleryRequest = async (route, init) => {
    const call: Call = { route, method: init.method ?? "GET", ...init };
    calls.push(call);
    return answers(call);
  };
  const manage = createPlayManage({
    request,
    token: async () => token,
    upload: async (url, bytes, type) => {
      uploads.push({ url, bytes: bytes.length, type });
      return options.upload ?? 200;
    },
    changed: () => {
      changes++;
    },
  });
  return { manage, calls, uploads, changes: () => changes };
}

/** A picture of `type`: its signature and a little body. */
function picture(type: PlayCoverType, size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  if (type === PlayCoverType.Webp) {
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);
    bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  } else if (type === PlayCoverType.Png) bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  else bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return bytes;
}

/** The cover routes answering a clean upload, then `commit` for the commit. */
const coverApi =
  (commit: GalleryAnswer, uploadUrl: unknown = "https://uploads.genex.technology/put?sig=1") =>
  (call: Call): GalleryAnswer => {
    if (call.route === `/api/projects/${GAME}/cover/upload-url`) return ok({ uploadUrl, key: "covers/cm1/new.webp" });
    if (call.route === `/api/projects/${GAME}/cover/commit`) return commit;
    return answered(404);
  };

describe("the changes the card menu may ask for", () => {
  it("takes each shape the menu's items send", () => {
    const valid: unknown[] = [
      { kind: "mobile", mobileSupport: "desktop_only" },
      { kind: "mobile", mobileSupport: "supported" },
      { kind: "mobile", mobileSupport: null },
      { kind: "tags", categories: [] },
      { kind: "tags", categories: ["arcade", "sports"] },
      { kind: "tags", categories: ["tools", "physics", "vfx"] },
      { kind: "tags", categories: ["assets"] },
      { kind: "remixing", allowed: true },
      { kind: "remixing", allowed: false },
      { kind: "unpublish" },
      { kind: "delete" },
    ];
    for (const change of valid) assert.equal(isPlayGameChange(change), true, JSON.stringify(change));
  });

  it("refuses anything else", () => {
    const invalid: unknown[] = [
      null,
      "delete",
      [],
      {},
      { kind: "drop-table" },
      { kind: "mobile" },
      { kind: "mobile", mobileSupport: "mobile_only" },
      { kind: "tags", categories: "arcade" },
      { kind: "tags", categories: ["games", "arcade"] },
      { kind: "remixing", allowed: "yes" },
      { kind: "remixing", allowed: 1 },
      { kind: "remixing" },
    ];
    for (const change of invalid) assert.equal(isPlayGameChange(change), false, JSON.stringify(change));
  });

  it("takes tags as Save tags stores them: the shelf's marker and short lowercase tags, within its limit", () => {
    const cases: Array<[unknown, boolean]> = [
      [[], true],
      [["arcade"], true],
      [["arcade", "sports", "racing"], true],
      [["arcade", "sports", "racing", "shooter"], false],
      [["arcade", "arcade"], false],
      [["sports", "arcade"], true],
      // A tag from outside the shelf's list is one the game already carried: kept, not refused.
      [["physics"], true],
      [["Arcade"], false],
      [["arcade sports"], false],
      [["tools"], true],
      [["tools", "physics", "terrain"], true],
      [["tools", "physics", "terrain", "vfx"], false],
      [["physics", "tools"], false],
      [["tools", "arcade"], true],
      [["assets", "arcade", "sports", "racing"], false],
      [["featured"], false],
      [["arcade", 7], false],
      [["../etc"], false],
      ["arcade", false],
      [null, false],
    ];
    for (const [categories, expected] of cases)
      assert.equal(isTaggedCategories(categories), expected, JSON.stringify(categories));
  });
});

describe("the card menu a viewer gets", () => {
  it("follows genex.games' own rules: owner, admin, both, someone else, signed out, author unknown", () => {
    const game = (authorId: string | null) => ({ author: { id: authorId, name: "Ann", imageUrl: null } });
    const ownItems = [PlayCardAction.CopyLink, PlayCardAction.Remixing, PlayCardAction.Cover];
    const adminItems = [PlayCardAction.Mobile, PlayCardAction.Tags];
    const end = [PlayCardAction.Unpublish, PlayCardAction.Delete];
    const viewer = (isAdmin: boolean) => ({ accountId: "u1", isAdmin });
    const cases: Array<[string, ReturnType<typeof playCardMenu>]> = [
      ["owner", playCardMenu(game("u1"), viewer(false))],
      ["admin", playCardMenu(game("u2"), viewer(true))],
      ["admin and owner", playCardMenu(game("u1"), viewer(true))],
      ["someone else", playCardMenu(game("u2"), viewer(false))],
      ["signed out", playCardMenu(game("u1"), null)],
      ["author unknown", playCardMenu(game(null), viewer(false))],
    ];
    assert.deepEqual(Object.fromEntries(cases), {
      owner: { game: ownItems, admin: [], end },
      admin: { game: [PlayCardAction.Cover], admin: adminItems, end },
      "admin and owner": { game: ownItems, admin: adminItems, end },
      "someone else": null,
      "signed out": null,
      "author unknown": null,
    });
  });
});

describe("a change reaching genex.games", () => {
  /** Each change, the call it makes and what genex.games answers. */
  const cases: Array<[PlayGameChange, string, string, unknown, unknown]> = [
    [
      { kind: PlayChangeKind.Mobile, mobileSupport: PlayMobileSupport.DesktopOnly },
      "PATCH",
      "/api/admin/projects/cm1/mobile",
      { mobileSupport: "desktop_only" },
      {},
    ],
    [
      { kind: PlayChangeKind.Mobile, mobileSupport: null },
      "PATCH",
      "/api/admin/projects/cm1/mobile",
      { mobileSupport: null },
      {},
    ],
    [
      { kind: PlayChangeKind.Tags, categories: ["arcade", "sports"] },
      "PATCH",
      "/api/projects/cm1/categories",
      { categories: ["arcade", "sports"] },
      { project: { categories: ["arcade", "sports"] } },
    ],
    [
      { kind: PlayChangeKind.Remixing, allowed: true },
      "PATCH",
      "/api/projects/cm1/visibility",
      { private: false },
      { project: {} },
    ],
    [
      { kind: PlayChangeKind.Remixing, allowed: false },
      "PATCH",
      "/api/projects/cm1/visibility",
      { private: true },
      { project: {} },
    ],
    [{ kind: PlayChangeKind.Unpublish }, "POST", "/api/projects/cm1/unpublish", undefined, { project: {} }],
    [{ kind: PlayChangeKind.Delete }, "DELETE", "/api/projects/cm1", undefined, null],
  ];

  it("goes as genex.games' website sends it, with the account's token, and only the fields it names", async () => {
    for (const [change, method, route, body, answer] of cases) {
      const { manage, calls, changes } = rig(() => ok(answer));
      // Stray fields never reach genex.games: each body is built from the change's own fields.
      const extra: PlayGameChange = Object.assign({}, change, { private: true, userId: "someone" });
      assert.equal((await manage.change(GAME, extra)).outcome, PlayChangeOutcome.Done, change.kind);
      assert.deepEqual(
        calls.map(({ route: r, method: m, token, body: b }) => ({ r, m, token, b })),
        [{ r: route, m: method, token: TOKEN, b: body }],
        JSON.stringify(change),
      );
      assert.equal(changes(), 1, `${change.kind}: the gallery forgets what it kept`);
    }
  });

  it("answers Tags with what genex.games stored", async () => {
    const tags = await rig(() => ok({ project: { categories: ["arcade", 7] } })).manage.change(GAME, {
      kind: PlayChangeKind.Tags,
      categories: ["arcade", "sports"],
    });
    assert.deepEqual(tags, { outcome: PlayChangeOutcome.Done, categories: ["arcade"] });
  });

  it("reads a game whose source is its owner's own repository apart, and changes nothing", async () => {
    const ownRepo = { error: "external_repo", message: "This game lives in your own repository." };
    const { manage, changes } = rig(() => answered(409, ownRepo));
    assert.deepEqual(await manage.change(GAME, { kind: PlayChangeKind.Remixing, allowed: true }), {
      outcome: PlayChangeOutcome.OwnRepo,
    });
    assert.equal(changes(), 0);
    const other = rig(() => answered(409, { error: "conflict" }));
    await assert.rejects(other.manage.change(GAME, { kind: PlayChangeKind.Remixing, allowed: true }), (error) => {
      assert.ok(error instanceof GalleryError);
      return error.status === 409;
    });
  });

  it("throws a refusal with its status, and a refused token as a sign-in, and forgets nothing", async () => {
    for (const status of [403, 404, 500]) {
      const { manage, changes } = rig(() => answered(status));
      await assert.rejects(manage.change(GAME, { kind: PlayChangeKind.Delete }), (error) => {
        assert.ok(error instanceof GalleryError);
        return error.status === status;
      });
      assert.equal(changes(), 0, String(status));
    }
    const ended = rig(() => answered(401));
    await assert.rejects(ended.manage.change(GAME, { kind: PlayChangeKind.Unpublish }), SignInNeeded);
    assert.equal(ended.changes(), 0);
  });

  it("needs the account, and asks nothing without it", async () => {
    const { manage, calls, uploads } = rig(() => ok({}), { token: undefined });
    await assert.rejects(manage.change(GAME, { kind: PlayChangeKind.Delete }), SignInNeeded);
    await assert.rejects(manage.cover(GAME, picture(PlayCoverType.Webp), PlayCoverType.Webp), SignInNeeded);
    assert.deepEqual([calls.length, uploads.length], [0, 0]);
  });

  it("sends nothing for an id that is no gallery id", async () => {
    const { manage, calls, uploads, changes } = rig();
    for (const id of ["../x", "a/b", "", "x".repeat(65), "a b", "%2e%2e", "a?b=1", "a#b", 7, null, undefined]) {
      const bad = id as string;
      await assert.rejects(manage.change(bad, { kind: PlayChangeKind.Delete }), JSON.stringify(id));
      await assert.rejects(manage.cover(bad, picture(PlayCoverType.Webp), PlayCoverType.Webp), JSON.stringify(id));
    }
    assert.deepEqual([calls.length, uploads.length, changes()], [0, 0, 0]);
  });

  it("sends nothing for a change of the wrong shape", async () => {
    const { manage, calls, changes } = rig();
    const wrong: unknown[] = [
      null,
      "delete",
      { kind: "drop-table" },
      { kind: PlayChangeKind.Mobile, mobileSupport: "phone" },
      { kind: PlayChangeKind.Tags, categories: ["games", "arcade"] },
      { kind: PlayChangeKind.Remixing, allowed: "yes" },
      { kind: PlayChangeKind.Remixing },
    ];
    for (const change of wrong)
      await assert.rejects(manage.change(GAME, change as PlayGameChange), JSON.stringify(change));
    assert.deepEqual([calls.length, changes()], [0, 0]);
  });
});

describe("a new cover", () => {
  it("is asked a place for, put there and committed, each picture type as itself", async () => {
    for (const type of Object.values(PlayCoverType)) {
      const commit = ok({ applied: true, coverUrl: COVER, coverSource: "upload" });
      const { manage, calls, uploads, changes } = rig(coverApi(commit));
      const image = picture(type, 100);
      assert.deepEqual(await manage.cover(GAME, image, type), { applied: true, coverUrl: COVER, refusal: null });
      assert.deepEqual(
        calls.map(({ route, method, token, body }) => [route, method, token, body]),
        [
          ["/api/projects/cm1/cover/upload-url", "POST", TOKEN, { bytes: 100, contentType: type }],
          ["/api/projects/cm1/cover/commit", "POST", TOKEN, { key: "covers/cm1/new.webp" }],
        ],
      );
      assert.deepEqual(uploads, [{ url: "https://uploads.genex.technology/put?sig=1", bytes: 100, type }]);
      assert.equal(changes(), 1);
    }
  });

  it("sends nothing for a picture that is not what it says, empty or too big", async () => {
    const { manage, calls, uploads } = rig(coverApi(ok({ applied: true })));
    const oversize = picture("image/webp", PLAY_COVER_MAX_BYTES + 1);
    const hostile: Array<[unknown, unknown]> = [
      [picture("image/png"), "image/webp"],
      [picture("image/webp"), "image/jpeg"],
      [picture("image/jpeg"), "image/png"],
      [new Uint8Array(0), "image/webp"],
      [new Uint8Array([0x52, 0x49, 0x46, 0x46]), "image/webp"],
      [oversize, "image/webp"],
      [picture("image/png"), "image/gif"],
      [picture("image/png"), "image/svg+xml"],
      [picture("image/png"), ""],
      [Array.from(picture("image/png")), "image/png"],
      ["iVBORw0KGgo=", "image/png"],
      [null, "image/png"],
    ];
    for (const [image, type] of hostile)
      await assert.rejects(
        manage.cover(GAME, image as Uint8Array, type as PlayCoverType),
        `${String(type)} ${String(image instanceof Uint8Array ? image.length : image)}`,
      );
    assert.deepEqual([calls.length, uploads.length], [0, 0]);
  });

  it("puts the picture nowhere but an https place, and commits nothing after a failed upload", async () => {
    for (const uploadUrl of ["http://uploads.genex.technology/put", "file:///etc/passwd", "javascript:alert(1)", 7]) {
      const { manage, calls, uploads } = rig(coverApi(ok({ applied: true }), uploadUrl));
      await assert.rejects(manage.cover(GAME, picture(PlayCoverType.Webp), PlayCoverType.Webp), String(uploadUrl));
      assert.deepEqual([calls.length, uploads.length], [1, 0], String(uploadUrl));
    }
    const failed = rig(coverApi(ok({ applied: true })), { upload: 500 });
    await assert.rejects(failed.manage.cover(GAME, picture(PlayCoverType.Webp), PlayCoverType.Webp));
    assert.deepEqual([failed.calls.length, failed.changes()], [1, 0], "no commit after a failed upload");
  });

  it("reads genex.games keeping the old cover, and why", async () => {
    const rejected = (reason: unknown) => answered(422, { error: "cover_rejected", reason });
    const cases: Array<[GalleryAnswer, unknown]> = [
      [rejected("too_dark"), { applied: false, coverUrl: null, refusal: "too_dark" }],
      [rejected("flat"), { applied: false, coverUrl: null, refusal: "flat" }],
      [rejected("blurry"), { applied: false, coverUrl: null, refusal: "invalid" }],
      [
        ok({ applied: false, coverUrl: COVER, coverSource: "agent", reason: "outranked" }),
        { applied: false, coverUrl: COVER, refusal: "outranked" },
      ],
      [
        ok({ applied: true, coverUrl: "https://evil.example/c.webp", coverSource: "upload" }),
        { applied: true, coverUrl: null, refusal: null },
      ],
    ];
    for (const [commit, expected] of cases) {
      const { manage } = rig(coverApi(commit));
      assert.deepEqual(await manage.cover(GAME, picture(PlayCoverType.Webp), PlayCoverType.Webp), expected);
    }
    const refused = rig(coverApi(answered(422, { error: "other" })));
    await assert.rejects(refused.manage.cover(GAME, picture(PlayCoverType.Webp), PlayCoverType.Webp), GalleryError);
    assert.equal(refused.changes(), 0);
    const kept = rig(coverApi(rejected("flat")));
    await kept.manage.cover(GAME, picture(PlayCoverType.Webp), PlayCoverType.Webp);
    assert.equal(kept.changes(), 0, "a refused cover changed nothing");
  });
});

describe("Play's manage channels", () => {
  type Listener = (event: IpcSender, payload: unknown) => Promise<IpcResult>;
  const studio = { sender: "studio", senderFrame: "main-frame" };

  /** Play's channels with only manage live: every call it gets is kept; `sender` is who calls. */
  function channels(sender: IpcSender = studio) {
    const listeners = new Map<string, Listener>();
    const handle = createIpcHandle(
      { handle: (channel, listener) => listeners.set(channel, listener) },
      { fixture: true, isStudioUi: (event) => event === studio },
    );
    const asked: unknown[][] = [];
    const record =
      (name: string) =>
      async (...args: unknown[]) => {
        asked.push([name, ...args]);
        return null as never;
      };
    const manage: PlayManage = { change: record("change"), cover: record("cover") };
    const unused = {} as unknown;
    registerPlayIpc(handle, {
      gallery: unused as PlayIpcDeps["gallery"],
      gameLinks: gameLinks(),
      remix: async () => "",
      remixReady: async () => ({}),
      viewer: () => null,
      installs: () => null,
      here: () => null,
      sessions: () => null,
      reveal: () => {},
      people: unused as PlayIpcDeps["people"],
      creators: unused as PlayIpcDeps["creators"],
      credits: unused as PlayIpcDeps["credits"],
      manage,
      web: PLAY_ORIGIN.web,
      share: () => {},
    });
    const invoke = (channel: string, payload?: unknown) => {
      const listener = listeners.get(channel);
      assert.ok(listener, `${channel} is not registered`);
      return listener(sender, payload);
    };
    return { invoke, asked };
  }

  it("answer only Studio's own window: a game's or a plugin page's frame changes no game", async () => {
    const { invoke, asked } = channels({ sender: "game", senderFrame: "game-frame" });
    const image = picture(PlayCoverType.Png);
    assert.equal(
      (await invoke("studio:play.manage", { gameId: GAME, change: { kind: PlayChangeKind.Delete } })).ok,
      false,
    );
    assert.equal(
      (await invoke("studio:play.cover", { gameId: GAME, image, contentType: PlayCoverType.Png })).ok,
      false,
    );
    assert.deepEqual(asked, []);
  });

  it("hand manage a well-formed id, change and picture, in a fixture launch too", async () => {
    const { invoke, asked } = channels();
    const image = picture("image/png");
    const change = { kind: PlayChangeKind.Delete };
    assert.equal((await invoke("studio:play.manage", { gameId: GAME, change })).ok, true);
    assert.equal((await invoke("studio:play.cover", { gameId: GAME, image, contentType: "image/png" })).ok, true);
    assert.deepEqual(asked, [
      ["change", GAME, change],
      ["cover", GAME, image, "image/png"],
    ]);
  });

  it("refuse a bad id, change, picture or type before manage sees it", async () => {
    const { invoke, asked } = channels();
    const image = picture("image/png");
    const refused = [
      ["studio:play.manage", { gameId: "../x", change: { kind: PlayChangeKind.Delete } }],
      ["studio:play.manage", { gameId: GAME, change: { kind: "drop-table" } }],
      ["studio:play.manage", { gameId: GAME }],
      ["studio:play.manage", undefined],
      ["studio:play.cover", { gameId: "", image, contentType: "image/png" }],
      ["studio:play.cover", { gameId: GAME, image: Array.from(image), contentType: "image/png" }],
      ["studio:play.cover", { gameId: GAME, image: "iVBORw0KGgo=", contentType: "image/png" }],
      ["studio:play.cover", { gameId: GAME, image, contentType: "image/gif" }],
    ] as const;
    for (const [channel, payload] of refused)
      assert.equal((await invoke(channel, payload)).ok, false, `${channel} ${JSON.stringify(payload)}`);
    assert.deepEqual(asked, []);
  });
});

describe("the fixture launch's genex.games", () => {
  const FULL = fixtureAccountToken(FixtureAccount.Full);
  const ADMIN = fixtureAccountToken(FixtureAccount.Admin);
  const gallery = playGallery({
    request: fixturePlayRequest,
    token: async () => FULL,
    now: () => 0,
    localImages: true,
  });
  const as = (token: string | undefined) =>
    createPlayManage({
      request: fixturePlayRequest,
      token: async () => token,
      upload: fixtureUpload,
      changed: gallery.forget,
      localImages: true,
    });
  /** Every page of Featured: the fixture's catalog runs past its first page. */
  const gamesTab = async (): Promise<PlayGame[]> => {
    const games: PlayGame[] = [];
    let cursor: string | null = null;
    do {
      const page = await gallery.feed({ category: PlayCategory.Featured, cursor });
      games.push(...page.games);
      cursor = page.nextCursor;
    } while (cursor);
    return games;
  };
  const bySlug = async (slug: string): Promise<PlayGame> => {
    const found = (await gamesTab()).find((game) => game.slug === slug);
    assert.ok(found, `${slug} is in the catalog`);
    return found;
  };

  const me = (token: string) =>
    playPeople({
      request: fixturePlayRequest,
      token: async () => token,
      now: () => 0,
      upload: fixtureUpload,
      web: PLAY_ORIGIN.web,
    }).me();

  it("names the admin account an admin, and every other account not", async () => {
    assert.equal((await me(ADMIN))?.isAdmin, true);
    assert.equal((await me(FULL))?.isAdmin, false);
  });

  it("gives the account its own games, so the owner's menu shows on them, and the admin's on any", async () => {
    const account = await me(FULL);
    assert.ok(account);
    const viewer = { accountId: account.id, isAdmin: false };
    for (const slug of ["snowball", "claude-of-duty"])
      assert.deepEqual(playCardMenu(await bySlug(slug), viewer)?.game.length, 3, `${slug} is the account's own`);
    const cathedral = await bySlug("lost-cathedral");
    assert.equal(playCardMenu(cathedral, viewer), null);
    assert.deepEqual(playCardMenu(cathedral, { ...viewer, isAdmin: true })?.admin, [
      PlayCardAction.Mobile,
      PlayCardAction.Tags,
    ]);
  });

  it("carries the mobile flags and tags the menu reads on its cards", async () => {
    assert.deepEqual((await bySlug("skate")).curation, {
      mobileSupport: PlayMobileSupport.DesktopOnly,
      mobileAuto: null,
      categories: ["games", "sports"],
      remixOff: true,
    });
    assert.equal((await bySlug("wildfire")).curation?.mobileAuto, PlayMobileSupport.DesktopOnly);
  });

  it("keeps the admin's mobile flag and tags for the launch, and refuses the flag to anyone else", async () => {
    const admin = as(ADMIN);
    const silence = await bySlug("the-long-silence");
    await admin.change(silence.id, { kind: PlayChangeKind.Mobile, mobileSupport: PlayMobileSupport.Supported });
    await admin.change(silence.id, { kind: PlayChangeKind.Tags, categories: ["arcade", "racing"] });
    const after = await bySlug("the-long-silence");
    assert.equal(after.curation?.mobileSupport, PlayMobileSupport.Supported);
    assert.deepEqual(after.curation?.categories, ["arcade", "racing"], "saved without the marker, still on Games");
    const snowball = await bySlug("snowball");
    await assert.rejects(
      as(FULL).change(snowball.id, { kind: PlayChangeKind.Mobile, mobileSupport: null }),
      (error) => error instanceof GalleryError && error.status === 403,
      "the mobile flag is the admin's alone, even on the account's own game",
    );
  });

  it("turns remixing off and on for the launch, and refuses it for a game in its own repository", async () => {
    const owner = as(FULL);
    const snowball = await bySlug("snowball");
    assert.equal(snowball.curation?.remixOff, false);
    await owner.change(snowball.id, { kind: PlayChangeKind.Remixing, allowed: false });
    assert.equal((await bySlug("snowball")).curation?.remixOff, true);
    await owner.change(snowball.id, { kind: PlayChangeKind.Remixing, allowed: true });
    assert.equal((await bySlug("snowball")).remixable, true);
    const duty = await bySlug("claude-of-duty");
    assert.equal(duty.curation?.remixOff, true);
    assert.deepEqual(await owner.change(duty.id, { kind: PlayChangeKind.Remixing, allowed: true }), {
      outcome: PlayChangeOutcome.OwnRepo,
    });
  });

  it("refuses someone else's game and a signed-out call, and lets the admin take any game down", async () => {
    const cathedral = await bySlug("lost-cathedral");
    await assert.rejects(
      as(FULL).change(cathedral.id, { kind: PlayChangeKind.Delete }),
      (error) => error instanceof GalleryError && error.status === 403,
    );
    const prototype = await bySlug("prototype-12");
    await as(ADMIN).change(prototype.id, { kind: PlayChangeKind.Unpublish });
    assert.ok(!(await gamesTab()).some((game) => game.slug === "prototype-12"));
    await assert.rejects(as(undefined).change(cathedral.id, { kind: PlayChangeKind.Delete }), SignInNeeded);
    await assert.rejects(
      as(fixtureAccountToken(FixtureAccount.Ended)).change(cathedral.id, { kind: PlayChangeKind.Delete }),
      SignInNeeded,
    );
    assert.ok(await bySlug("lost-cathedral"), "still published");
  });

  it("takes a new cover for the launch with no socket", async () => {
    const snowball = await bySlug("snowball");
    const result = await as(FULL).cover(snowball.id, picture(PlayCoverType.Webp), PlayCoverType.Webp);
    assert.equal(result.applied, true);
    assert.match(result.coverUrl ?? "", /^data:image\/svg\+xml/);
    assert.equal((await bySlug("snowball")).coverUrl, result.coverUrl);
  });

  it("takes an unpublished or deleted game out of the feed and search", async () => {
    const owner = as(FULL);
    const duty = await bySlug("claude-of-duty");
    assert.equal((await gallery.search("Claude of Duty")).length, 1);
    await owner.change(duty.id, { kind: PlayChangeKind.Unpublish });
    assert.ok(!(await gamesTab()).some((game) => game.slug === "claude-of-duty"));
    assert.deepEqual(await gallery.search("Claude of Duty"), [], "and the search catalog");
    const snowball = await bySlug("snowball");
    await owner.change(snowball.id, { kind: PlayChangeKind.Delete });
    assert.ok(!(await gamesTab()).some((game) => game.slug === "snowball"), "a deleted one too");
  });
});

describe("the gallery after a change", () => {
  it("reads its first pages, counts and search catalog again once it forgets them", async () => {
    const calls: string[] = [];
    const gallery = playGallery({
      request: async (route) => {
        calls.push(route.split("?")[0] ?? "");
        return ok({ items: [], buckets: {}, values: {} });
      },
      token: async () => undefined,
      now: () => 0,
    });
    const readAll = async () => {
      await gallery.feed({ category: PlayCategory.Featured });
      await gallery.shelves();
      await gallery.search("cathedral", PlayShelf.Games);
    };
    await readAll();
    await readAll();
    assert.equal(calls.length, 3, "kept a while");
    gallery.forget();
    await readAll();
    assert.equal(calls.length, 6, "read again after a change");
  });

  it("keeps nothing of a read that was under way when it forgot", async () => {
    const calls: string[] = [];
    const held: Array<() => void> = [];
    const gallery = playGallery({
      request: (route) => {
        calls.push(route.split("?")[0] ?? "");
        // Every read waits until the test lets it answer.
        return new Promise((resolve) => held.push(() => resolve(ok({ items: [], buckets: {}, values: {} }))));
      },
      token: async () => undefined,
      now: () => 0,
    });
    const readAll = () =>
      Promise.all([
        gallery.feed({ category: PlayCategory.Featured }),
        gallery.shelves(),
        gallery.search("cathedral", PlayShelf.Games),
      ]);
    const underWay = readAll();
    gallery.forget();
    for (const answer of held.splice(0)) answer();
    await underWay;
    const again = readAll();
    assert.equal(calls.length, 6, "each read goes out again: the one under way was older than the change");
    for (const answer of held.splice(0)) answer();
    await again;
  });
});
