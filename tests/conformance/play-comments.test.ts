/**
 * A Play game's comments: main reads a page of them for the game on screen and writes and deletes
 * the account's own on genex.games, naming every game and comment by the id genex.games gave it.
 * The bar's layer follows the viewer's news for the opening it is about, and Comments' pages add up
 * newest first, with how long ago each was written in words.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CommentRoute, playComments, toComment, toCommentsPage } from "../../src/main/play/comments.ts";
import { classifyChannel } from "../../src/main/dev/native-policy.ts";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { type PlayIpcDeps, registerPlayIpc } from "../../src/main/ipc/play.ts";
import type { PlayViewer } from "../../src/main/play/viewer.ts";
import { type GalleryAnswer, type GalleryRequest, SignInNeeded } from "../../src/main/play/gallery.ts";
import {
  BarEscape,
  barEscape,
  barNews,
  CommentsStatus,
  holdToTell,
  NOTHING_TOLD,
  minutesSince,
  NO_COMMENTS,
  withCommentsPage,
  withoutComment,
  withPosted,
} from "../../src/renderer/play/bar-model.ts";
import { PLAY_WORDS } from "../../src/renderer/words.ts";
import { PLAY_ORIGIN, PlayViewerPhase } from "../../src/shared/play.ts";
import { PurchaseAnswer } from "../../src/shared/play-purchase.ts";
import { COMMENT_MAX, COMMENTS_PAGE, commentBody, type PlayComment } from "../../src/shared/play-comments.ts";

const ME = "u-rab";
/** A comment as genex.games serves one. */
const served = (id: string, userId = "u-mira", body = "Love the music") => ({
  id,
  body,
  createdAt: "2026-10-17T09:00:00.000Z",
  author: {
    id: userId,
    name: "Mira",
    image: "https://lh3.googleusercontent.com/a/photo",
    avatarStyle: "generated",
    avatarVariant: 7,
    handle: "mira",
  },
});

/** The comments over a recording fake of genex.games. */
function rig(answer: (route: string, init: Parameters<GalleryRequest>[1]) => GalleryAnswer, token = "T") {
  const calls: Array<{ route: string; method: string; body?: unknown; token?: string }> = [];
  const request: GalleryRequest = async (route, init) => {
    calls.push({ route, method: init.method ?? "GET", body: init.body, token: init.token });
    return answer(route, init);
  };
  const comments = playComments({
    request,
    token: async () => token || undefined,
    now: () => 0,
    me: async () => ME,
  });
  return { comments, calls };
}

describe("Play comments on genex.games", () => {
  it("reads a comment as the list draws it, marking the account's own", () => {
    assert.deepEqual(toComment(served("c1"), ME), {
      id: "c1",
      body: "Love the music",
      at: Date.parse("2026-10-17T09:00:00.000Z"),
      author: { id: "u-mira", name: "Mira", imageUrl: "https://lh3.googleusercontent.com/a/photo", avatarVariant: 7 },
      mine: false,
    });
    assert.equal(toComment(served("c2", ME), ME)?.mine, true);
    assert.equal(toComment(served("c2", ME), null)?.mine, false, "signed out, nothing is the account's");
  });

  it("drops what does not read as a comment, and pictures from hosts the app does not load", () => {
    const broken = [
      null,
      { ...served("c1"), id: "../c1" },
      { ...served("c1"), body: "   " },
      { ...served("c1"), createdAt: "yesterday" },
      { ...served("c1"), author: { id: 42 } },
    ];
    for (const value of broken) assert.equal(toComment(value, ME), null, JSON.stringify(value));
    const elsewhere = { ...served("c1"), author: { ...served("c1").author, image: "http://evil.example/a.png" } };
    assert.equal(toComment(elsewhere, ME)?.author.imageUrl, null);
    const page = toCommentsPage({ items: [served("c1"), null, served("c2")], nextCursor: "c2" }, ME);
    assert.deepEqual(
      page.items.map((comment) => comment.id),
      ["c1", "c2"],
    );
    assert.equal(page.nextCursor, "c2");
    assert.equal(toCommentsPage({ items: [], nextCursor: "a/b" }, ME).nextCursor, null);
    assert.deepEqual(toCommentsPage("nope", ME), { items: [], nextCursor: null });
  });

  it("reads a page of 20, the next from the cursor given, with no token", async () => {
    const { comments, calls } = rig(() => ({ status: 200, body: { items: [served("c1")], nextCursor: null } }));
    const page = await comments.list("cm1", null);
    assert.equal(page.items.length, 1);
    await comments.list("cm1", "c20");
    assert.deepEqual(calls, [
      { route: `${CommentRoute.list("cm1")}?limit=${COMMENTS_PAGE}`, method: "GET", body: undefined, token: undefined },
      {
        route: `${CommentRoute.list("cm1")}?limit=${COMMENTS_PAGE}&cursor=c20`,
        method: "GET",
        body: undefined,
        token: undefined,
      },
    ]);
  });

  it("posts the account's comment trimmed, and answers it as its own", async () => {
    const { comments, calls } = rig(() => ({ status: 201, body: { comment: served("c9", "u-someone", "Hi") } }));
    const saved = await comments.post("cm1", "  Hi  ");
    assert.equal(saved.mine, true);
    assert.deepEqual(calls, [{ route: CommentRoute.list("cm1"), method: "POST", body: { body: "Hi" }, token: "T" }]);
  });

  it("deletes one of the account's comments by its id", async () => {
    const { comments, calls } = rig(() => ({ status: 200, body: { ok: true } }));
    await comments.remove("cm1", "c9");
    assert.deepEqual(calls, [{ route: CommentRoute.one("cm1", "c9"), method: "DELETE", body: undefined, token: "T" }]);
  });

  it("asks for a sign-in signed out, or when genex.games refuses the token", async () => {
    const signedOut = rig(() => ({ status: 201, body: null }), "");
    await assert.rejects(signedOut.comments.post("cm1", "Hi"), SignInNeeded);
    await assert.rejects(signedOut.comments.remove("cm1", "c9"), SignInNeeded);
    assert.deepEqual(signedOut.calls, [], "nothing is sent without an account");
    const refused = rig(() => ({ status: 401, body: null }));
    await assert.rejects(refused.comments.post("cm1", "Hi"), SignInNeeded);
    await assert.rejects(refused.comments.remove("cm1", "c9"), SignInNeeded);
    const forbidden = rig(() => ({ status: 403, body: null }));
    await assert.rejects(forbidden.comments.remove("cm1", "c9"), /HTTP 403/);
  });

  it("sends nothing for an id that is not one, or a comment genex.games would refuse", async () => {
    const hostile = [
      "",
      "../users/me",
      "cm1/../../admin",
      "cm1?x=1",
      "cm1#x",
      "c 1",
      "%2e%2e",
      "a".repeat(65),
      42,
      null,
    ];
    const { comments, calls } = rig(() => ({ status: 200, body: { ok: true } }));
    for (const id of hostile) {
      await assert.rejects(comments.list(id as string, null), String(id));
      await assert.rejects(comments.post(id as string, "Hi"), String(id));
      await assert.rejects(comments.remove(id as string, "c9"), String(id));
      await assert.rejects(comments.remove("cm1", id), String(id));
    }
    for (const body of ["", "   ", "x".repeat(COMMENT_MAX + 1), 42, null])
      await assert.rejects(comments.post("cm1", body), JSON.stringify(body));
    assert.deepEqual(calls, []);
    assert.equal(commentBody("x".repeat(COMMENT_MAX)), "x".repeat(COMMENT_MAX));
  });
});

describe("Who may write comments", () => {
  it("takes a comment's post or delete only from Studio's own page or Play's bar layer", async () => {
    const listeners = new Map<string, (event: IpcSender, payload: unknown) => Promise<IpcResult>>();
    const ipc = {
      handle: (channel: string, listener: (event: IpcSender, payload: unknown) => Promise<IpcResult>) =>
        listeners.set(channel, listener),
    };
    const studio: IpcSender = { sender: "studio", senderFrame: "studio-main" };
    const bar: IpcSender = { sender: "bar", senderFrame: "bar-main" };
    const handle = createIpcHandle(ipc, {
      fixture: false,
      isStudioUi: (event) => event === studio,
      isPlayBar: (event) => event === bar,
    });
    let written = 0;
    for (const channel of ["studio:play.comment", "studio:play.uncomment", "studio:play.comments"] as const)
      handle(channel, async () => {
        written += 1;
        return undefined as never;
      });
    const call = (channel: string, event: IpcSender) => listeners.get(channel)?.(event, {});
    const strangers: IpcSender[] = [
      { sender: "plugin", senderFrame: "plugin-frame" },
      { sender: "bar", senderFrame: "a frame inside the bar" },
      { sender: "game", senderFrame: "game-main" },
    ];
    for (const stranger of strangers)
      for (const channel of ["studio:play.comment", "studio:play.uncomment"]) {
        const answer = await call(channel, stranger);
        assert.equal(answer?.ok, false, `${channel} from ${String(stranger.senderFrame)}`);
      }
    assert.equal(written, 0, "nothing was written for them");
    for (const allowed of [studio, bar]) {
      assert.equal((await call("studio:play.comment", allowed))?.ok, true);
      assert.equal((await call("studio:play.uncomment", allowed))?.ok, true);
    }
    assert.equal((await call("studio:play.comments", strangers[0] as IpcSender))?.ok, true, "reading is anyone's");
    assert.equal(written, 5);
  });
});

describe("Who may answer a purchase sheet", () => {
  /** Play's channels over a recording registrar, with a viewer that records the answers it is handed. */
  function channels(fixture: boolean) {
    const listeners = new Map<string, (event: IpcSender, payload: unknown) => Promise<IpcResult>>();
    const ipc = {
      handle: (channel: string, listener: (event: IpcSender, payload: unknown) => Promise<IpcResult>) =>
        listeners.set(channel, listener),
    };
    const studio: IpcSender = { sender: "studio", senderFrame: "studio-main" };
    const bar: IpcSender = { sender: "bar", senderFrame: "bar-main" };
    const handle = createIpcHandle(ipc, {
      fixture,
      isStudioUi: (event) => event === studio,
      isPlayBar: (event) => event === bar,
    });
    const answered: unknown[] = [];
    const viewer = { answerPurchase: (value: unknown) => void answered.push(value) } as unknown as PlayViewer;
    const unused = {} as unknown;
    registerPlayIpc(handle, {
      gallery: unused as PlayIpcDeps["gallery"],
      remix: async () => "",
      viewer: () => viewer,
      people: unused as PlayIpcDeps["people"],
      creators: unused as PlayIpcDeps["creators"],
      credits: unused as PlayIpcDeps["credits"],
      manage: unused as PlayIpcDeps["manage"],
      web: PLAY_ORIGIN.web,
      share: () => {},
      installs: () => null,
      sessions: () => null,
      reveal: () => {},
    });
    const call = (event: IpcSender, payload: unknown) => listeners.get("studio:play.purchase")?.(event, payload);
    return { call, answered, studio, bar };
  }

  it("takes an answer only from Play's bar layer: never Studio's own page, a game, a plugin or a frame in the bar", async () => {
    const { call, answered, studio, bar } = channels(false);
    const pay = { sheet: 1, answer: PurchaseAnswer.Pay };
    const strangers: IpcSender[] = [
      studio,
      { sender: "game", senderFrame: "game-main" },
      { sender: "plugin", senderFrame: "plugin-frame" },
      { sender: "bar", senderFrame: "a frame inside the bar" },
    ];
    for (const stranger of strangers) {
      const answer = await call(stranger, pay);
      assert.equal(answer?.ok, false, String(stranger.senderFrame));
    }
    assert.deepEqual(answered, [], "no answer reached the viewer");
    assert.equal((await call(bar, pay))?.ok, true);
    assert.deepEqual(answered, [pay], "the viewer reads the page's answer itself");
  });

  it("answers the bar in a fixture launch too: its purchases come from the fixture's own coin", async () => {
    assert.equal(classifyChannel("studio:play.purchase"), "fixture-safe");
    const { call, answered, bar } = channels(true);
    assert.equal((await call(bar, { sheet: 2, answer: PurchaseAnswer.Cancel }))?.ok, true);
    assert.equal(answered.length, 1);
  });
});

describe("Play comments in the bar's layer", () => {
  const comment = (id: string): PlayComment => ({
    id,
    body: id,
    at: 0,
    author: { id: "u-1", name: "Mira", imageUrl: null, avatarVariant: 0 },
    mine: false,
  });

  it("follows the opening its news is about, and leaves nothing once that one closes", () => {
    const loading = barNews(null, { slug: "a", openId: 1, phase: PlayViewerPhase.Loading });
    assert.deepEqual(loading, { slug: "a", openId: 1, phase: PlayViewerPhase.Loading, bar: null, focusAsks: 0 });
    const asked = barNews(loading, { slug: "a", openId: 1, phase: PlayViewerPhase.Playing, focusBar: true });
    assert.equal(asked?.focusAsks, 1);
    assert.equal(asked?.phase, PlayViewerPhase.Playing);
    const next = barNews(asked, { slug: "b", openId: 2, phase: PlayViewerPhase.Loading });
    assert.equal(next?.slug, "b");
    assert.equal(next?.focusAsks, 0);
    assert.equal(
      barNews(next, { slug: "a", openId: 1, phase: PlayViewerPhase.Closed }),
      next,
      "an earlier game's closing",
    );
    assert.equal(barNews(next, { slug: "a", openId: 1, phase: PlayViewerPhase.Playing }), next);
    assert.equal(barNews(next, { slug: "b", openId: 2, phase: PlayViewerPhase.Closed }), null);
  });

  it("tells main what holds the bar only when it changes, asking for the bar again after mounting or a new game", () => {
    const first = holdToTell(NOTHING_TOLD, { held: false, comments: false });
    assert.deepEqual(first?.payload, { held: false, comments: false, ready: true });
    assert.equal(holdToTell(first?.key ?? "", { held: false, comments: false }), null, "nothing new");
    const hovered = holdToTell(first?.key ?? "", { held: true, comments: false, ready: true });
    assert.deepEqual(hovered?.payload, { held: true, comments: false }, "only the first word asks for the bar");
    assert.deepEqual(holdToTell(NOTHING_TOLD, { held: true, comments: false })?.payload, {
      held: true,
      comments: false,
      ready: true,
    });
  });

  it("acts on a fresh Esc only: back to a playing game, out of one still loading or failed, never over Comments", () => {
    const fresh = { repeat: false, commentsOpen: false, sheetOpen: false };
    assert.equal(barEscape(PlayViewerPhase.Playing, fresh), BarEscape.Resume);
    assert.equal(barEscape(PlayViewerPhase.Loading, fresh), BarEscape.Leave);
    assert.equal(barEscape(PlayViewerPhase.Failed, fresh), BarEscape.Leave);
    assert.equal(
      barEscape(PlayViewerPhase.Playing, { ...fresh, repeat: true }),
      BarEscape.None,
      "a held Esc repeating",
    );
    assert.equal(barEscape(PlayViewerPhase.Loading, { ...fresh, commentsOpen: true }), BarEscape.None);
    assert.equal(barEscape(undefined, fresh), BarEscape.None);
  });

  it("adds pages newest first, each comment once, with a post on top and a delete gone", () => {
    const first = withCommentsPage(NO_COMMENTS, { items: [comment("c3"), comment("c2")], nextCursor: "c2" }, false);
    assert.equal(first.status, CommentsStatus.Ready);
    const more = withCommentsPage(first, { items: [comment("c2"), comment("c1")], nextCursor: null }, true);
    assert.deepEqual(
      more.items.map((item) => item.id),
      ["c3", "c2", "c1"],
    );
    assert.equal(more.nextCursor, null);
    const posted = withPosted(more, comment("c4"));
    assert.equal(posted.items[0]?.id, "c4");
    assert.deepEqual(
      withoutComment(posted, "c2").items.map((item) => item.id),
      ["c4", "c3", "c1"],
    );
  });

  it("says how long ago a comment was written in whole units, spelled out", () => {
    const ago = PLAY_WORDS.comments.ago;
    const minute = 60_000;
    const cases: Array<[number, string]> = [
      [0, "just now"],
      [1, "1 minute ago"],
      [59, "59 minutes ago"],
      [60, "1 hour ago"],
      [24 * 60, "1 day ago"],
      [21 * 24 * 60, "21 days ago"],
      [90 * 24 * 60, "3 months ago"],
      [800 * 24 * 60, "2 years ago"],
    ];
    for (const [minutes, words] of cases) assert.equal(ago(minutesSince(0, minutes * minute)), words, words);
    assert.equal(minutesSince(10 * minute, 0), 0, "a clock a little behind reads as just now");
    assert.equal(PLAY_WORDS.comments.title(0), "Comments");
    assert.equal(PLAY_WORDS.comments.title(1), "1 Comment");
    assert.equal(PLAY_WORDS.comments.title(26), "26 Comments");
  });
});

describe("Esc in the bar's layer under a purchase sheet", () => {
  it("leaves Esc to a purchase sheet while one is open: it never resumes the game or leaves under it", () => {
    const sheet = { repeat: false, commentsOpen: false, sheetOpen: true };
    assert.equal(barEscape(PlayViewerPhase.Playing, sheet), BarEscape.None, "the game stays covered");
    assert.equal(barEscape(PlayViewerPhase.Loading, sheet), BarEscape.None, "the viewer stays open");
    assert.equal(barEscape(PlayViewerPhase.Failed, sheet), BarEscape.None);
  });
});
