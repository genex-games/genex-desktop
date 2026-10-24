/**
 * Play's viewer: the studio's own bar (Back, the game's name and facts, Like, Comments, Share, Invite a
 * friend, Remix, Full screen, Exit) is a strip of its own across the window's top, in a layer of its own,
 * and the game fills the window below it, never under it. The bar stays up for the whole game; only its
 * page's full screen (the game's own, or asked for by the bar's Full screen) gives it the whole window. Its
 * Comments covers the window and takes the keyboard. The viewer signs the player in with a ticket when
 * there is a Genex account, shows the cover until the page has loaded (or long enough), and closes from
 * Back, Exit, the guest card's Sign in, Remix or the maker's name. A held Esc in the game moves the
 * keyboard to the bar; Esc there gives it back. A guest with no Genex account is offered the Genex plugin
 * in the bar until its ×.
 */
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ESC_HOLD_MS } from "../../src/main/game-full-screen.ts";
import { type PlayTicket, SignInNeeded, TicketStatus } from "../../src/main/play/gallery.ts";
import {
  EXTERNAL_LINK_GAP_MS,
  externalAddress,
  linkGate,
  playAddress,
  playNavigationAllowed,
} from "../../src/main/play/game-address.ts";
import { closePage, closeWithWindow, dropGameView } from "../../src/main/play/view-drop.ts";
import { NOTE_MS, SHOW_GAME_AFTER_MS } from "../../src/main/play/viewer.ts";
import type { PlayComment } from "../../src/shared/play-comments.ts";
import { NativeAppOffer, NativePlatform, type PlayBarNative } from "../../src/shared/play-native.ts";
import { PLAY_BAR_HEIGHT, PlayControl, PlayNote, PlayViewerPhase } from "../../src/shared/play.ts";
import { esc, MINTED, NOT_MINTED, rig, SIGNED_OUT, saved, settle, WINDOW, WORLD } from "../helpers/play-viewer-rig.ts";

/** A long session in a game: longer than any of the viewer's own timers. */
const LONG_PLAY_MS = 30 * 60_000;
/** Where the game lies: the window below the bar's strip. */
const UNDER_BAR = `0,${PLAY_BAR_HEIGHT} ${WINDOW.width}x${WINDOW.height - PLAY_BAR_HEIGHT}`;
/** The bar's strip across the window's top. */
const BAR_STRIP = `0,0 ${WINDOW.width}x${PLAY_BAR_HEIGHT}`;
/** Long past any delay the bar ever had before it moved. */
const BAR_SETTLED_MS = 10_000;

describe("Play viewer", () => {
  it("opens a game signed in, its header drawn with the game's likes and facts", async () => {
    const { viewer, events, opened, bar } = rig();
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    assert.deepEqual(events[0], {
      slug: "lost-cathedral",
      openId: 1,
      phase: PlayViewerPhase.Loading,
      bar: {
        title: "Lost Cathedral",
        liked: false,
        likes: 0,
        remixable: false,
        multiplayer: false,
        note: null,
        guestCard: false,
        facts: null,
        mic: null,
        comments: null,
        signedIn: null,
        remixing: false,
        nativeApp: null,
        purchase: null,
      },
    });
    assert.deepEqual(opened, ["game:lost-cathedral:T1"]);
    assert.deepEqual(bar(), {
      title: "Lost Cathedral",
      liked: false,
      likes: 3,
      remixable: true,
      multiplayer: true,
      note: null,
      guestCard: false,
      facts: { author: "Simeon M", authorId: null, plays: 5300, online: 8 },
      mic: null,
      comments: 2,
      signedIn: true,
      remixing: false,
      nativeApp: null,
      purchase: null,
    });
    assert.equal(viewer.showing(), "lost-cathedral");
  });

  it("loads the bar's page again when the app's language changes, so it speaks the new one", async () => {
    const { viewer, log } = rig();
    viewer.warm();
    viewer.languageChanged();
    assert.deepEqual(log, ["bar.warm", "bar.reload"]);
  });

  it("plays as a guest when no ticket can be minted", async () => {
    for (const ticket of [SIGNED_OUT, NOT_MINTED]) {
      const { viewer, opened } = rig({ ticket: async () => ticket });
      viewer.open("lost-cathedral", "Lost Cathedral");
      await settle();
      assert.deepEqual(opened, ["game:lost-cathedral:guest"], ticket.status);
    }
  });

  it("puts the game below the bar once its page has loaded, the bar's strip up from the start", async () => {
    const { viewer, events, log } = rig();
    viewer.open("lost-cathedral", "Lost Cathedral");
    assert.equal(log[0], `bar.show ${BAR_STRIP}`, "the bar is up over the cover");
    await settle();
    assert.ok(log.includes(`game.open ${UNDER_BAR}`), "the page boots at the size it plays at");
    viewer.loaded();
    assert.equal(events.findLast((event) => event.phase !== PlayViewerPhase.Loading)?.phase, PlayViewerPhase.Playing);
    assert.ok(log.includes(`game.show ${UNDER_BAR}`));
    assert.equal(log.at(-1), "game.focus");
  });

  it("shows a slow page anyway after a while", async () => {
    const { viewer, events, advance } = rig();
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    advance(SHOW_GAME_AFTER_MS - 1);
    assert.equal(events.at(-1)?.phase, PlayViewerPhase.Loading);
    advance(1);
    assert.equal(events.at(-1)?.phase, PlayViewerPhase.Playing);
  });

  it("hides the game when the page fails, and loads it afresh when opened again", async () => {
    const { viewer, events, log, opened } = rig();
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    viewer.failed();
    assert.equal(events.at(-1)?.phase, PlayViewerPhase.Failed);
    assert.ok(log.includes("game.hide"));
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    assert.equal(opened.length, 2);
    assert.equal(events.findLast((event) => event.openId === 2)?.phase, PlayViewerPhase.Loading);
  });

  it("follows the window's size, the bar's height kept", async () => {
    const { viewer, log } = rig();
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    viewer.loaded();
    log.length = 0;
    viewer.resized();
    assert.deepEqual(log, [`game.show ${UNDER_BAR}`, `bar.show ${BAR_STRIP}`]);
  });

  it("likes at once and keeps what the server answered", async () => {
    const { viewer, bar } = rig();
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    viewer.control(PlayControl.Like);
    assert.deepEqual([bar()?.liked, bar()?.likes], [true, 4]);
    await settle();
    assert.deepEqual([bar()?.liked, bar()?.likes], [true, 4]);
  });

  it("takes a like back and says why when it cannot be saved", async () => {
    const signedOut = rig({
      setLiked: async () => {
        throw new SignInNeeded();
      },
    });
    signedOut.viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    signedOut.viewer.control(PlayControl.Like);
    await settle();
    assert.deepEqual(
      [signedOut.bar()?.liked, signedOut.bar()?.likes, signedOut.bar()?.note],
      [false, 3, PlayNote.SignIn],
    );
    signedOut.advance(NOTE_MS);
    assert.equal(signedOut.bar()?.note, null);

    const failing = rig({
      setLiked: async () => {
        throw new Error("HTTP 503");
      },
    });
    failing.viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    failing.viewer.control(PlayControl.Like);
    await settle();
    assert.equal(failing.bar()?.note, PlayNote.LikeFailed);
  });

  it("says a game failed when its sign-in ticket can't be read, never loading for good", async () => {
    const { viewer, events, opened } = rig({
      ticket: async () => {
        throw new Error("no window to mint for");
      },
    });
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    assert.equal(opened.length, 0);
    assert.equal(events.at(-1)?.phase, PlayViewerPhase.Failed);
  });

  it("copies the game's page for an invite whose code can't be read", async () => {
    const { viewer, copied, bar } = rig({
      inviteCode: async () => {
        throw new Error("offline");
      },
    });
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    viewer.control(PlayControl.Invite);
    await settle();
    assert.deepEqual(copied, ["https://genex.games/lost-cathedral"]);
    assert.equal(bar()?.note, PlayNote.InviteCopied);
  });

  it("copies the game's page on the website Play links to, a development profile's too", async () => {
    const { viewer, copied } = rig({ web: "http://localhost:5173" });
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    viewer.control(PlayControl.Share);
    viewer.control(PlayControl.Invite);
    await settle();
    assert.deepEqual(copied, ["http://localhost:5173/lost-cathedral", "http://localhost:5173/lost-cathedral?ref=abc"]);
  });

  it("copies the game's page for Share and an invite with the referral code", async () => {
    const { viewer, copied, bar } = rig();
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    viewer.control(PlayControl.Share);
    assert.equal(bar()?.note, PlayNote.Copied);
    viewer.control(PlayControl.Invite);
    await settle();
    assert.deepEqual(copied, ["https://genex.games/lost-cathedral", "https://genex.games/lost-cathedral?ref=abc"]);
    assert.equal(bar()?.note, PlayNote.InviteCopied);
    const guest = rig({ inviteCode: async () => undefined });
    guest.viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    guest.viewer.control(PlayControl.Invite);
    await settle();
    assert.deepEqual(guest.copied, ["https://genex.games/lost-cathedral"]);
  });

  it("gives way at once on Remix: the app makes the copy and shows it being made", async () => {
    const { viewer, events, log } = rig();
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    viewer.control(PlayControl.Remix);
    assert.equal(viewer.showing(), null);
    assert.ok(log.includes("game.close"));
    assert.deepEqual(events.at(-1), { slug: "lost-cathedral", openId: 1, phase: PlayViewerPhase.Closed, remix: true });
  });

  it("takes one like at a time", async () => {
    const answers: Array<() => void> = [];
    const calls: boolean[] = [];
    const { viewer } = rig({
      setLiked: (_id, liked) => {
        calls.push(liked);
        return new Promise((resolve) => answers.push(() => resolve({ liked, likes: liked ? 4 : 3 })));
      },
    });
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    viewer.control(PlayControl.Like);
    viewer.control(PlayControl.Like);
    assert.deepEqual(calls, [true]);
    answers[0]?.();
    await settle();
    viewer.control(PlayControl.Like);
    assert.deepEqual(calls, [true, false]);
  });

  it("loads the game without waiting for its likes", async () => {
    const { viewer, opened } = rig({ world: () => new Promise(() => {}) });
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    assert.deepEqual(opened, ["game:lost-cathedral:T1"]);
  });

  it("closes from Back and Exit", async () => {
    for (const control of [PlayControl.Back, PlayControl.Exit]) {
      const { viewer, events, log } = rig();
      viewer.open("lost-cathedral", "Lost Cathedral");
      await settle();
      viewer.control(control);
      assert.equal(events.at(-1)?.phase, PlayViewerPhase.Closed);
      assert.ok(log.includes("game.close"));
    }
  });

  it("moves the keyboard to the bar on an Esc held in the game, and leaves a tap to the game", async () => {
    const { viewer, events, log, advance } = rig();
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    viewer.loaded();
    viewer.key(esc("keyDown"));
    viewer.key(esc("keyUp"));
    advance(ESC_HOLD_MS);
    assert.ok(!log.includes("bar.focus"), "a tap is the game's");
    viewer.key(esc("keyDown"));
    advance(ESC_HOLD_MS);
    assert.ok(log.includes("bar.focus"));
    assert.equal(events.at(-1)?.focusBar, true);
    assert.equal(viewer.showing(), "lost-cathedral");
    assert.ok(
      events.every((event) => event.phase !== PlayViewerPhase.Closed),
      "the game stays",
    );
  });

  it("counts no hold before the game is on screen, and gives the game the keyboard back from the bar", async () => {
    const { viewer, log, advance } = rig();
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    viewer.key(esc("keyDown"));
    advance(ESC_HOLD_MS);
    assert.ok(!log.includes("bar.focus"), "still loading: the cover's Esc is the app's");
    viewer.key(esc("keyUp"));
    viewer.control(PlayControl.Resume);
    assert.ok(!log.includes("game.focus"), "a game still loading does not take the keyboard");
    viewer.loaded();
    log.length = 0;
    viewer.control(PlayControl.Resume);
    assert.deepEqual(log, ["game.focus"]);
  });

  it("offers a signed-out guest a Genex account in the header once the game plays, and keeps offering it", async () => {
    const { viewer, bar, advance } = rig({ ticket: async () => SIGNED_OUT });
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    assert.equal(bar()?.guestCard, false, "not over the cover");
    viewer.loaded();
    assert.equal(bar()?.guestCard, true);
    advance(LONG_PLAY_MS);
    assert.equal(bar()?.guestCard, true, "it does not go by itself");
  });

  it("offers no guest card to a signed-in player, nor to one whose ticket could not be minted", async () => {
    for (const ticket of [MINTED, NOT_MINTED]) {
      const { viewer, events } = rig({ ticket: async () => ticket });
      viewer.open("lost-cathedral", "Lost Cathedral");
      await settle();
      viewer.loaded();
      assert.ok(
        events.every((event) => !event.bar?.guestCard),
        ticket.status,
      );
    }
  });

  it("takes the guest card away on its × for the rest of the game", async () => {
    const { viewer, bar, advance } = rig({ ticket: async () => SIGNED_OUT });
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    viewer.loaded();
    viewer.control(PlayControl.DismissCard);
    assert.equal(bar()?.guestCard, false);
    advance(LONG_PLAY_MS);
    assert.equal(bar()?.guestCard, false);
  });

  it("closes for the guest card's Sign in, asking the app to sign in to Genex, only for a signed-out guest", async () => {
    const { viewer, events, log } = rig({ ticket: async () => SIGNED_OUT });
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    viewer.loaded();
    viewer.control(PlayControl.Install);
    assert.deepEqual(events.at(-1), {
      slug: "lost-cathedral",
      openId: 1,
      phase: PlayViewerPhase.Closed,
      install: true,
    });
    assert.ok(log.includes("game.close"));
    for (const ticket of [MINTED, NOT_MINTED]) {
      const signedIn = rig({ ticket: async () => ticket });
      signedIn.viewer.open("lost-cathedral", "Lost Cathedral");
      await settle();
      signedIn.viewer.loaded();
      signedIn.viewer.control(PlayControl.Install);
      assert.equal(signedIn.viewer.showing(), "lost-cathedral", ticket.status);
    }
  });

  it("offers the guest card again in the next game, even after its × in the last one", async () => {
    const { viewer, bar } = rig({ ticket: async () => SIGNED_OUT });
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    viewer.loaded();
    viewer.control(PlayControl.DismissCard);
    viewer.control(PlayControl.Back);
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    viewer.loaded();
    assert.equal(bar()?.guestCard, true);
  });

  it("drops what arrives for a game that was left before it answered", async () => {
    let answerTicket: (value: PlayTicket) => void = () => {};
    const { viewer, opened } = rig({ ticket: () => new Promise((resolve) => (answerTicket = resolve)) });
    viewer.open("lost-cathedral", "Lost Cathedral");
    viewer.close();
    answerTicket({ status: TicketStatus.Minted, ticket: "late" });
    await settle();
    assert.deepEqual(opened, []);
  });

  it("ignores a control it does not know, and an address that is not a game", async () => {
    const { viewer, events } = rig();
    viewer.open("../../etc");
    assert.deepEqual(events, []);
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    viewer.control("rm -rf");
    assert.equal(viewer.showing(), "lost-cathedral");
  });
});

describe("Play viewer's bar above the game", () => {
  /** A viewer playing Lost Cathedral, its page loaded. */
  async function playing(overrides: Parameters<typeof rig>[0] = {}) {
    const made = rig(overrides);
    made.viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    made.viewer.loaded();
    return made;
  }

  it("stays up for the whole game, loading, playing or failed, never fading, the window's buttons kept", async () => {
    const { viewer, bar, log, advance } = rig();
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    advance(SHOW_GAME_AFTER_MS - 1);
    viewer.loaded();
    advance(LONG_PLAY_MS);
    assert.ok(bar(), "drawn");
    assert.ok(!log.includes("bar.hide"));
    assert.ok(!log.includes("buttons hidden"));
    const failed = rig();
    failed.viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    failed.viewer.failed();
    failed.advance(LONG_PLAY_MS);
    assert.ok(!failed.log.includes("bar.hide"), "it stays over a game that could not load");
  });

  it("stays put for Esc in the game, a tap or a hold", async () => {
    const { viewer, log, advance } = await playing();
    log.length = 0;
    viewer.key(esc("keyDown"));
    viewer.key(esc("keyUp"));
    advance(BAR_SETTLED_MS);
    assert.ok(!log.some((line) => line.startsWith("bar.show") || line.startsWith("bar.hide")));
  });

  it("gives the game the whole window while its page is full screen, and the bar its strip back after", async () => {
    const { viewer, log } = await playing();
    log.length = 0;
    viewer.fullScreen(true);
    assert.deepEqual(log, ["bar.hide", "buttons hidden", `game.show 0,0 ${WINDOW.width}x${WINDOW.height}`]);
    log.length = 0;
    viewer.resized();
    assert.deepEqual(log, [`game.show 0,0 ${WINDOW.width}x${WINDOW.height}`], "the bar stays away while it is");
    log.length = 0;
    viewer.fullScreen(false);
    assert.deepEqual(log, [`bar.show ${BAR_STRIP}`, "buttons shown", `game.show ${UNDER_BAR}`]);
  });

  it("gives the game the keyboard back when full screen puts the bar away holding it", async () => {
    const { viewer, log } = await playing({ barFocused: () => true });
    log.length = 0;
    viewer.fullScreen(true);
    assert.ok(log.includes("game.focus"));
    const quiet = await playing();
    quiet.log.length = 0;
    quiet.viewer.fullScreen(true);
    assert.ok(!quiet.log.includes("game.focus"), "the game has the keyboard already");
  });

  it("shows a game that went full screen while loading across the whole window, and the next game below the bar", async () => {
    const { viewer, log } = rig();
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    viewer.fullScreen(true);
    assert.ok(!log.some((line) => line.startsWith("game.show")), "nothing on screen before it loads");
    viewer.loaded();
    assert.ok(log.includes(`game.show 0,0 ${WINDOW.width}x${WINDOW.height}`));
    viewer.control(PlayControl.Exit);
    log.length = 0;
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    viewer.loaded();
    assert.ok(log.includes(`bar.show ${BAR_STRIP}`));
    assert.ok(log.includes(`game.show ${UNDER_BAR}`));
  });

  it("asks the game's page for its own full screen from the bar's Full screen, once the game plays and nothing covers it", async () => {
    const { viewer, log } = rig();
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    viewer.control(PlayControl.FullScreen);
    assert.ok(!log.includes("game.fullScreen"), "nothing on screen to fill yet");
    viewer.loaded();
    log.length = 0;
    viewer.control(PlayControl.FullScreen);
    assert.deepEqual(log, ["game.fullScreen"], "the page's own full screen: its Esc and the bar's return follow");
    viewer.hold({ comments: true });
    log.length = 0;
    viewer.control(PlayControl.FullScreen);
    assert.deepEqual(log, [], "not under Comments");
    const failed = rig();
    failed.viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    failed.viewer.failed();
    failed.viewer.control(PlayControl.FullScreen);
    assert.ok(!failed.log.includes("game.fullScreen"), "not over a game that could not load");
  });

  it("takes no full screen with no game open", () => {
    const { viewer, log } = rig();
    viewer.fullScreen(true);
    assert.deepEqual(log, []);
  });

  it("lays its layer over the whole window for Comments with the keyboard, and gives the game it back after", async () => {
    const { viewer, log } = await playing();
    log.length = 0;
    viewer.hold({ comments: true });
    assert.deepEqual(log, [`bar.show 0,0 ${WINDOW.width}x${WINDOW.height}`, "buttons shown", "bar.focus"]);
    log.length = 0;
    viewer.hold({ comments: false });
    assert.deepEqual(log, [`bar.show ${BAR_STRIP}`, "buttons shown", "game.focus"]);
  });

  it("leaves the keyboard with Comments opened while the game loads, and keeps it over the window if the game fails", async () => {
    const { viewer, log } = rig();
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    viewer.hold({ comments: true });
    log.length = 0;
    viewer.loaded();
    assert.ok(!log.includes("game.focus"), "the comment field keeps the keyboard");
    const failing = rig();
    failing.viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    failing.viewer.hold({ comments: true });
    failing.log.length = 0;
    failing.viewer.failed();
    assert.ok(!failing.log.some((line) => line.startsWith("bar.")), "the layer stays over the whole window");
  });

  it("says whether a Genex account is there only once the ticket has answered", async () => {
    const signedIn = rig();
    signedIn.viewer.open("lost-cathedral", "Lost Cathedral");
    assert.equal(signedIn.bar()?.signedIn, null, "not known yet: Comments offers neither Sign in nor the field");
    await settle();
    assert.equal(signedIn.bar()?.signedIn, true);
    for (const ticket of [SIGNED_OUT, NOT_MINTED]) {
      const made = rig({ ticket: async () => ticket });
      made.viewer.open("lost-cathedral", "Lost Cathedral");
      await settle();
      assert.equal(made.bar()?.signedIn, ticket === NOT_MINTED, ticket.status);
    }
  });

  it("draws the bar again for a layer page that has just mounted, and only then", async () => {
    const { viewer, events } = rig();
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    const before = events.length;
    viewer.hold({ comments: false });
    assert.equal(events.length, before, "a hold alone draws nothing");
    viewer.hold({ comments: false, ready: true });
    assert.equal(events.length, before + 1);
    assert.equal(events.at(-1)?.bar?.title, "Lost Cathedral");
  });

  it("reads only what holds it, as booleans", async () => {
    const { viewer, log } = await playing();
    log.length = 0;
    viewer.hold({ comments: 1 });
    viewer.hold(null);
    assert.ok(!log.some((line) => line.startsWith("bar.")), "Comments is open only for a true");
  });

  it("puts its layer away and the window's buttons back when the viewer closes", async () => {
    const { viewer, log } = await playing();
    viewer.fullScreen(true);
    log.length = 0;
    viewer.control(PlayControl.Exit);
    assert.deepEqual(log.slice(-2), ["buttons shown", "game.close"]);
  });

  it("closes onto the maker's profile from their name, when the gallery names their account", async () => {
    const named = await playing({ world: async () => ({ ...WORLD, authorId: "u-maker" }) });
    named.viewer.control(PlayControl.Maker);
    assert.deepEqual(named.events.at(-1), {
      slug: "lost-cathedral",
      openId: 1,
      phase: PlayViewerPhase.Closed,
      profile: "u-maker",
    });
    const unnamed = await playing();
    unnamed.viewer.control(PlayControl.Maker);
    assert.equal(unnamed.viewer.showing(), "lost-cathedral");
  });

  it("holds Remix while a remix is being made, and for a game that may not be remixed", async () => {
    const { viewer, bar } = await playing();
    viewer.remixing(true);
    assert.equal(bar()?.remixing, true);
    viewer.control(PlayControl.Remix);
    assert.equal(viewer.showing(), "lost-cathedral");
    viewer.remixing(false);
    assert.equal(bar()?.remixing, false);
    const locked = await playing({ world: async () => ({ ...WORLD, remixable: false }) });
    locked.viewer.control(PlayControl.Remix);
    assert.equal(locked.viewer.showing(), "lost-cathedral");
  });

  it("starts a game opened while a remix is made with Remix waiting", async () => {
    const { viewer, bar } = rig();
    viewer.remixing(true);
    viewer.open("lost-cathedral", "Lost Cathedral");
    assert.equal(bar()?.remixing, true);
  });

  it("shows the game's name as one line, cut to its longest", async () => {
    const { viewer, bar } = rig();
    viewer.open("lost-cathedral", `  Lost\n  ${"Cathedral ".repeat(40)}`);
    assert.equal(bar()?.title.startsWith("Lost Cathedral Cathedral"), true);
    assert.equal(bar()?.title.length, 200);
    viewer.open("lost-cathedral", 42);
    assert.equal(bar()?.title, "");
  });
});

describe("Play viewer's Comments", () => {
  it("reads the comments of the game on screen by its id, a page at a time", async () => {
    const { viewer, log } = rig();
    viewer.open("lost-cathedral", "Lost Cathedral");
    assert.deepEqual(await viewer.comments(null), { items: [], nextCursor: null });
    await viewer.comments("c20");
    await viewer.comments({ cursor: "c20" });
    assert.deepEqual(
      log.filter((line) => line.startsWith("comments.")),
      ["comments.list cm1 first", "comments.list cm1 c20", "comments.list cm1 first"],
    );
  });

  it("counts a comment posted and one deleted in the bar", async () => {
    const { viewer, bar } = rig();
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    assert.equal(bar()?.comments, 2);
    assert.equal((await viewer.comment("Love it")).body, "Love it");
    assert.equal(bar()?.comments, 3);
    await viewer.uncomment("c9");
    await viewer.uncomment("c8");
    assert.equal(bar()?.comments, 1);
  });

  it("keeps the count when a post or a delete is refused", async () => {
    const { viewer, bar } = rig({
      comments: {
        post: async () => {
          throw new SignInNeeded();
        },
        remove: async () => {
          throw new Error("HTTP 403");
        },
      },
    });
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    await assert.rejects(viewer.comment("Love it"), SignInNeeded);
    await assert.rejects(viewer.uncomment("c1"));
    assert.equal(bar()?.comments, 2);
  });

  it("offers Sign in for the rest of the game once genex.games refuses a write for want of one", async () => {
    const { viewer, bar, events } = rig({
      ticket: async () => NOT_MINTED,
      comments: {
        post: async () => {
          throw new SignInNeeded();
        },
      },
    });
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    viewer.loaded();
    assert.equal(bar()?.signedIn, true, "an account is there, its sign-in ended unseen");
    await assert.rejects(viewer.comment("Love it"), SignInNeeded);
    assert.equal(bar()?.signedIn, false);
    viewer.control(PlayControl.Install);
    assert.equal(events.at(-1)?.install, true, "its Sign in signs in to Genex again");
  });

  it("answers nothing with no game open, nor for a game whose page facts could not be read", async () => {
    const closed = rig();
    await assert.rejects(closed.viewer.comments(null));
    const unread = rig({
      world: async () => {
        throw new Error("offline");
      },
    });
    unread.viewer.open("lost-cathedral", "Lost Cathedral");
    await assert.rejects(unread.viewer.comment("Love it"));
    assert.ok(!unread.log.some((line) => line.startsWith("comments.")));
  });

  it("gives a game left before its post answered no count", async () => {
    let answer: (comment: PlayComment) => void = () => {};
    const { viewer, events } = rig({
      comments: { post: () => new Promise((resolve) => (answer = resolve)) },
    });
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    const posting = viewer.comment("Love it");
    await settle();
    viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    answer(saved("Love it"));
    await posting;
    assert.ok(events.filter((event) => event.openId === 2).every((event) => event.bar?.comments !== 3));
  });
});

describe("Play viewer's views leaving the window", () => {
  /** A window and a game's view that record what is done to them. */
  function views(destroyed: boolean) {
    const log: string[] = [];
    let closed = false;
    const view = {
      webContents: {
        isDestroyed: () => closed,
        close: () => {
          closed = true;
          log.push("page.close");
        },
      },
    };
    const win = {
      isDestroyed: () => destroyed,
      contentView: { removeChildView: () => void log.push("window.remove") },
      webContents: { focus: () => void log.push("window.focus") },
    };
    return { log, view, win };
  }

  it("closes the game's page even when its window is already gone, so its sound and timers stop", () => {
    const closing = views(true);
    dropGameView(closing.win, closing.view);
    assert.deepEqual(closing.log, ["page.close"]);
    const open = views(false);
    dropGameView(open.win, open.view);
    assert.deepEqual(open.log, ["page.close", "window.remove", "window.focus"]);
    dropGameView(open.win, open.view);
    assert.deepEqual(open.log.slice(3), ["window.remove", "window.focus"], "a page closed once is not closed again");
  });

  it("gives the app the keyboard back with no game's view up yet, and closes a page that is there", () => {
    const early = views(false);
    dropGameView(early.win, null);
    assert.deepEqual(early.log, ["window.focus"]);
    closePage(early.view.webContents);
    closePage(null);
    assert.deepEqual(early.log, ["window.focus", "page.close"]);
  });
});

describe("Play viewer and the studio window", () => {
  /** The studio window, emitting its events as Electron does, and how often the viewer was closed. */
  function studioWindow() {
    const win = new EventEmitter();
    let closes = 0;
    closeWithWindow(win, () => {
      closes += 1;
    });
    return { win, closes: () => closes };
  }

  it("keeps the game while another window covers the studio's, another desktop shows or it is minimized", () => {
    const { win, closes } = studioWindow();
    // macOS sends `hide` and `show` when the window's occlusion changes: nobody hid it.
    for (const event of ["blur", "hide", "show", "focus", "minimize", "restore"]) win.emit(event);
    assert.equal(closes(), 0);
  });

  it("closes the game when the person closes the window, whether it goes or a run keeps it hidden", () => {
    const kept = studioWindow();
    kept.win.emit("close");
    kept.win.emit("hide");
    assert.equal(kept.closes(), 1);
    const gone = studioWindow();
    gone.win.emit("close");
    gone.win.emit("closed");
    assert.ok(gone.closes() >= 1);
  });

  it("closes the game with a window destroyed without asking to close", () => {
    const { win, closes } = studioWindow();
    win.emit("closed");
    assert.equal(closes(), 1);
  });
});

describe("Play addresses", () => {
  it("carries the ticket, or the guest marker, in the fragment", () => {
    assert.equal(
      playAddress("lost-cathedral", "a.b+c"),
      "https://lost-cathedral.genex.technology/?genex_r=1#genex_ticket=a.b%2Bc",
    );
    assert.equal(
      playAddress("lost-cathedral", undefined),
      "https://lost-cathedral.genex.technology/?genex_r=1#genex_guest=1",
    );
  });

  it("lets a game's page move only within Genex games and the sign-in hop", () => {
    const cases: Array<[string, boolean]> = [
      ["https://lost-cathedral.genex.technology/level-2", true],
      ["https://renamed.genex.technology/", true],
      ["https://genex.games/play/authorize?returnTo=x&guest=ok", true],
      ["https://genex.games/play/authorize?returnTo=x", false],
      ["https://genex.games/play/authorize?guest=no", false],
      ["https://genex.games/", false],
      ["https://genex.games/play/authorize/../login", false],
      ["http://lost-cathedral.genex.technology/", false],
      ["https://genex.technology.evil.example/", false],
      ["https://evilgenex.technology/", false],
      ["https://accounts.google.com/", false],
      ["file:///etc/passwd", false],
      ["javascript:alert(1)", false],
      ["data:text/html,<h1>hi</h1>", false],
      ["not a url", false],
    ];
    for (const [url, allowed] of cases) assert.equal(playNavigationAllowed(url, false), allowed, url);
    assert.equal(playNavigationAllowed("data:text/html,<h1>fixture</h1>", true), true);
    assert.equal(playNavigationAllowed("https://lost-cathedral.genex.technology/", true), false);
  });

  it("sends a game's links to the browser without their fragment, https only, one at a time", () => {
    assert.equal(externalAddress("https://evil.example/collect#genex_ticket=SECRET"), "https://evil.example/collect");
    for (const raw of ["http://a.example/", "file:///etc/passwd", "javascript:alert(1)", "not a url"])
      assert.equal(externalAddress(raw), null, raw);
    let clock = 0;
    const opened: string[] = [];
    const gate = linkGate(
      (url) => opened.push(url),
      () => clock,
    );
    gate("https://a.example/1");
    gate("https://a.example/2");
    clock += EXTERNAL_LINK_GAP_MS;
    gate("https://a.example/3");
    gate("http://a.example/4");
    assert.deepEqual(opened, ["https://a.example/1", "https://a.example/3"]);
  });
});

describe("Play viewer: a web game's native app", () => {
  const offer = (kind: PlayBarNative["offer"], percent = 0): PlayBarNative => ({
    offer: kind,
    platform: NativePlatform.Mac,
    bytes: 1_400,
    percent,
  });

  /** A viewer whose game has a native app offered as `current` says, every press recorded. */
  function nativeRig(start: PlayBarNative | null) {
    let current = start;
    const presses: string[] = [];
    const made = rig({
      nativeApp: {
        offer: async () => current,
        press: async (slug) => {
          presses.push(slug);
        },
      },
    });
    return { ...made, presses, set: (next: PlayBarNative | null) => (current = next) };
  }

  it("shows the app's pill once it is read, and follows an install as it goes", async () => {
    const { viewer, bar, set } = nativeRig(offer(NativeAppOffer.Install));
    viewer.open("skate", "SKATE");
    await settle();
    assert.deepEqual(bar()?.nativeApp, offer(NativeAppOffer.Install));
    set(offer(NativeAppOffer.Installing, 38));
    viewer.nativeChanged();
    await settle();
    assert.deepEqual(bar()?.nativeApp, offer(NativeAppOffer.Installing, 38));
  });

  it("installs from the pill while the web game keeps playing, and does nothing while it installs", async () => {
    const { viewer, presses, events, set } = nativeRig(offer(NativeAppOffer.Install));
    viewer.open("skate", "SKATE");
    await settle();
    viewer.control(PlayControl.NativeApp);
    await settle();
    assert.deepEqual(presses, ["skate"]);
    assert.ok(!events.some((event) => event.phase === PlayViewerPhase.Closed), "the web game stays");
    set(offer(NativeAppOffer.Installing, 10));
    viewer.nativeChanged();
    await settle();
    viewer.control(PlayControl.NativeApp);
    await settle();
    assert.deepEqual(presses, ["skate"]);
  });

  it("plays the installed app in its own window: the viewer gives way first", async () => {
    const { viewer, presses, events } = nativeRig(offer(NativeAppOffer.Ready));
    viewer.open("skate", "SKATE");
    await settle();
    viewer.control(PlayControl.NativeApp);
    await settle();
    assert.equal(events.at(-1)?.phase, PlayViewerPhase.Closed);
    assert.deepEqual(presses, ["skate"]);
  });

  it("offers no pill for a game with no app here, nor where Genex plays no native game", async () => {
    const none = nativeRig(null);
    none.viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    assert.equal(none.bar()?.nativeApp, null);
    const plain = rig();
    plain.viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    plain.viewer.control(PlayControl.NativeApp);
    assert.equal(plain.bar()?.nativeApp, null);
  });
});
