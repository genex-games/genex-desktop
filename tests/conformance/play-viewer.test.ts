/**
 * Play's viewer: a game fills the window under the studio's own header (Back, the game's name and
 * facts, Like, Share, Invite a friend, Remix, Exit), drawn by the app above the game's view. It signs
 * the player in with a ticket when there is a Genex account, shows the cover until the page has
 * loaded (or long enough), and closes from Back, Exit, the guest card's Sign in or Remix. A held Esc
 * in the game moves the keyboard to the header; Esc there gives it back. A guest with no Genex
 * account is offered the Genex plugin in the header until its ×.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ESC_HOLD_MS } from "../../src/main/game-full-screen.ts";
import { type PlayTicket, type PlayWorld, SignInNeeded, TicketStatus } from "../../src/main/play/gallery.ts";
import {
  EXTERNAL_LINK_GAP_MS,
  externalAddress,
  linkGate,
  playAddress,
  playNavigationAllowed,
} from "../../src/main/play/game-address.ts";
import { NOTE_MS, type PlayViewerDeps, playViewer, SHOW_GAME_AFTER_MS } from "../../src/main/play/viewer.ts";
import {
  PLAY_BAR_HEIGHT,
  type PlayBarState,
  PlayControl,
  PlayNote,
  type PlayViewerEvent,
  PlayViewerPhase,
} from "../../src/shared/play.ts";

/** A long session in a game: longer than any of the viewer's own timers. */
const LONG_PLAY_MS = 30 * 60_000;
const WINDOW = { width: 1440, height: 900 };

const MINTED: PlayTicket = { status: TicketStatus.Minted, ticket: "T1" };
const SIGNED_OUT: PlayTicket = { status: TicketStatus.SignedOut };
const NOT_MINTED: PlayTicket = { status: TicketStatus.NotMinted };

/** An Esc press in the game: down, or up again. */
const esc = (type: "keyDown" | "keyUp") => ({ type, key: "Escape", isAutoRepeat: false });

const WORLD: PlayWorld = {
  id: "cm1",
  slug: "lost-cathedral",
  title: "Lost Cathedral",
  multiplayer: true,
  likes: 3,
  liked: false,
  remixable: true,
  cloneUrl: "https://git.genex.games/u-1/lost-cathedral.git",
  author: "Simeon M",
  authorId: null,
  plays: 5300,
  online: 8,
};

/** A fake clock whose timers run when the test advances it. */
function fakeClock() {
  let now = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let next = 1;
  return {
    clock: {
      setTimeout: (run: () => void, ms: number) => {
        const id = next++;
        timers.set(id, { at: now + ms, run });
        return id;
      },
      clearTimeout: (id: unknown) => void timers.delete(id as number),
    },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.run();
      }
    },
  };
}

/** Let the viewer's awaited calls settle. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A viewer over recording fakes. */
function rig(overrides: Partial<PlayViewerDeps["gallery"]> & { web?: string } = {}) {
  const { clock, advance } = fakeClock();
  const log: string[] = [];
  const events: PlayViewerEvent[] = [];
  const copied: string[] = [];
  const opened: string[] = [];
  const deps: PlayViewerDeps = {
    gallery: {
      world: async () => WORLD,
      ticket: async () => MINTED,
      setLiked: async (_id, liked) => ({ liked, likes: liked ? 4 : 3 }),
      inviteCode: async () => "abc",
      ...overrides,
    },
    gameUrl: (slug, ticket) => `game:${slug}:${ticket ?? "guest"}`,
    window: { contentSize: () => WINDOW },
    game: {
      open: (url) => {
        opened.push(url);
        log.push("game.open");
      },
      show: (bounds) => log.push(`game.show ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`),
      hide: () => log.push("game.hide"),
      focus: () => log.push("game.focus"),
      close: () => log.push("game.close"),
    },
    focusApp: () => log.push("app.focus"),
    clipboard: (text) => copied.push(text),
    web: overrides.web ?? "https://genex.games",
    emit: (event) => events.push(event),
    clock,
    // Voice chat has its own suite (play-mic.test.ts); these games never ask for a microphone.
    mic: {
      access: async () => true,
      command: () => {},
      menu: () => {},
      openSettings: () => {},
      store: { on: () => false, setOn: () => {}, device: () => null, setDevice: () => {} },
    },
  };
  const viewer = playViewer(deps);
  /** The header as last drawn. */
  const bar = (): PlayBarState | undefined => events.findLast((event) => event.bar)?.bar;
  return { viewer, log, events, bar, copied, opened, advance };
}

describe("Play viewer", () => {
  it("opens a game signed in, its header drawn with the game's likes and facts", async () => {
    const { viewer, events, opened, bar } = rig();
    viewer.open("lost-cathedral");
    await settle();
    assert.deepEqual(events[0], {
      slug: "lost-cathedral",
      openId: 1,
      phase: PlayViewerPhase.Loading,
      bar: {
        liked: false,
        likes: 0,
        remixable: false,
        note: null,
        guestCard: false,
        facts: null,
        mic: null,
      },
    });
    assert.deepEqual(opened, ["game:lost-cathedral:T1"]);
    assert.deepEqual(bar(), {
      liked: false,
      likes: 3,
      remixable: true,
      note: null,
      guestCard: false,
      facts: { author: "Simeon M", authorId: null, plays: 5300, online: 8 },
      mic: null,
    });
    assert.equal(viewer.showing(), "lost-cathedral");
  });

  it("plays as a guest when no ticket can be minted", async () => {
    for (const ticket of [SIGNED_OUT, NOT_MINTED]) {
      const { viewer, opened } = rig({ ticket: async () => ticket });
      viewer.open("lost-cathedral");
      await settle();
      assert.deepEqual(opened, ["game:lost-cathedral:guest"], ticket.status);
    }
  });

  it("puts the game under the header, across the rest of the window, once its page has loaded", async () => {
    const { viewer, events, log } = rig();
    viewer.open("lost-cathedral");
    await settle();
    viewer.loaded();
    assert.equal(events.at(-1)?.phase, PlayViewerPhase.Playing);
    assert.ok(log.includes(`game.show 0,${PLAY_BAR_HEIGHT} ${WINDOW.width}x${WINDOW.height - PLAY_BAR_HEIGHT}`));
    assert.equal(log.at(-1), "game.focus");
  });

  it("shows a slow page anyway after a while", async () => {
    const { viewer, events, advance } = rig();
    viewer.open("lost-cathedral");
    await settle();
    advance(SHOW_GAME_AFTER_MS - 1);
    assert.equal(events.at(-1)?.phase, PlayViewerPhase.Loading);
    advance(1);
    assert.equal(events.at(-1)?.phase, PlayViewerPhase.Playing);
  });

  it("hides the game when the page fails, and loads it afresh when opened again", async () => {
    const { viewer, events, log, opened } = rig();
    viewer.open("lost-cathedral");
    await settle();
    viewer.failed();
    assert.equal(events.at(-1)?.phase, PlayViewerPhase.Failed);
    assert.ok(log.includes("game.hide"));
    viewer.open("lost-cathedral");
    await settle();
    assert.equal(opened.length, 2);
    assert.equal(events.findLast((event) => event.openId === 2)?.phase, PlayViewerPhase.Loading);
  });

  it("follows the window's size, the header's height kept", async () => {
    const { viewer, log } = rig();
    viewer.open("lost-cathedral");
    await settle();
    viewer.loaded();
    log.length = 0;
    viewer.resized();
    assert.deepEqual(log, [`game.show 0,${PLAY_BAR_HEIGHT} ${WINDOW.width}x${WINDOW.height - PLAY_BAR_HEIGHT}`]);
  });

  it("likes at once and keeps what the server answered", async () => {
    const { viewer, bar } = rig();
    viewer.open("lost-cathedral");
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
    signedOut.viewer.open("lost-cathedral");
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
    failing.viewer.open("lost-cathedral");
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
    viewer.open("lost-cathedral");
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
    viewer.open("lost-cathedral");
    await settle();
    viewer.control(PlayControl.Invite);
    await settle();
    assert.deepEqual(copied, ["https://genex.games/lost-cathedral"]);
    assert.equal(bar()?.note, PlayNote.InviteCopied);
  });

  it("copies the game's page on the website Play links to, a development profile's too", async () => {
    const { viewer, copied } = rig({ web: "http://localhost:5173" });
    viewer.open("lost-cathedral");
    await settle();
    viewer.control(PlayControl.Share);
    viewer.control(PlayControl.Invite);
    await settle();
    assert.deepEqual(copied, ["http://localhost:5173/lost-cathedral", "http://localhost:5173/lost-cathedral?ref=abc"]);
  });

  it("copies the game's page for Share and an invite with the referral code", async () => {
    const { viewer, copied, bar } = rig();
    viewer.open("lost-cathedral");
    await settle();
    viewer.control(PlayControl.Share);
    assert.equal(bar()?.note, PlayNote.Copied);
    viewer.control(PlayControl.Invite);
    await settle();
    assert.deepEqual(copied, ["https://genex.games/lost-cathedral", "https://genex.games/lost-cathedral?ref=abc"]);
    assert.equal(bar()?.note, PlayNote.InviteCopied);
    const guest = rig({ inviteCode: async () => undefined });
    guest.viewer.open("lost-cathedral");
    await settle();
    guest.viewer.control(PlayControl.Invite);
    await settle();
    assert.deepEqual(guest.copied, ["https://genex.games/lost-cathedral"]);
  });

  it("gives way at once on Remix: the app makes the copy and shows it being made", async () => {
    const { viewer, events, log } = rig();
    viewer.open("lost-cathedral");
    await settle();
    viewer.control(PlayControl.Remix);
    assert.equal(viewer.showing(), null);
    assert.ok(log.includes("game.close"));
    assert.deepEqual(events.at(-1), { slug: "lost-cathedral", openId: 1, phase: PlayViewerPhase.Closed });
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
    viewer.open("lost-cathedral");
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
    viewer.open("lost-cathedral");
    await settle();
    assert.deepEqual(opened, ["game:lost-cathedral:T1"]);
  });

  it("closes from Back and Exit", async () => {
    for (const control of [PlayControl.Back, PlayControl.Exit]) {
      const { viewer, events, log } = rig();
      viewer.open("lost-cathedral");
      await settle();
      viewer.control(control);
      assert.equal(events.at(-1)?.phase, PlayViewerPhase.Closed);
      assert.ok(log.includes("game.close"));
    }
  });

  it("moves the keyboard to the header on an Esc held in the game, and leaves a tap to the game", async () => {
    const { viewer, events, log, advance } = rig();
    viewer.open("lost-cathedral");
    await settle();
    viewer.loaded();
    viewer.key(esc("keyDown"));
    viewer.key(esc("keyUp"));
    advance(ESC_HOLD_MS);
    assert.ok(!log.includes("app.focus"), "a tap is the game's");
    viewer.key(esc("keyDown"));
    advance(ESC_HOLD_MS);
    assert.equal(log.at(-1), "app.focus");
    assert.equal(events.at(-1)?.focusBar, true);
    assert.equal(viewer.showing(), "lost-cathedral");
    assert.ok(
      events.every((event) => event.phase !== PlayViewerPhase.Closed),
      "the game stays",
    );
  });

  it("counts no hold before the game is on screen, and gives the game the keyboard back from the header", async () => {
    const { viewer, log, advance } = rig();
    viewer.open("lost-cathedral");
    await settle();
    viewer.key(esc("keyDown"));
    advance(ESC_HOLD_MS);
    assert.ok(!log.includes("app.focus"), "still loading: the cover's Esc is the app's");
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
    viewer.open("lost-cathedral");
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
      viewer.open("lost-cathedral");
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
    viewer.open("lost-cathedral");
    await settle();
    viewer.loaded();
    viewer.control(PlayControl.DismissCard);
    assert.equal(bar()?.guestCard, false);
    advance(LONG_PLAY_MS);
    assert.equal(bar()?.guestCard, false);
  });

  it("closes for the guest card's Sign in, asking the app to sign in to Genex, only for a signed-out guest", async () => {
    const { viewer, events, log } = rig({ ticket: async () => SIGNED_OUT });
    viewer.open("lost-cathedral");
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
      signedIn.viewer.open("lost-cathedral");
      await settle();
      signedIn.viewer.loaded();
      signedIn.viewer.control(PlayControl.Install);
      assert.equal(signedIn.viewer.showing(), "lost-cathedral", ticket.status);
    }
  });

  it("offers the guest card again in the next game, even after its × in the last one", async () => {
    const { viewer, bar } = rig({ ticket: async () => SIGNED_OUT });
    viewer.open("lost-cathedral");
    await settle();
    viewer.loaded();
    viewer.control(PlayControl.DismissCard);
    viewer.control(PlayControl.Back);
    viewer.open("lost-cathedral");
    await settle();
    viewer.loaded();
    assert.equal(bar()?.guestCard, true);
  });

  it("drops what arrives for a game that was left before it answered", async () => {
    let answerTicket: (value: PlayTicket) => void = () => {};
    const { viewer, opened } = rig({ ticket: () => new Promise((resolve) => (answerTicket = resolve)) });
    viewer.open("lost-cathedral");
    viewer.close();
    answerTicket({ status: TicketStatus.Minted, ticket: "late" });
    await settle();
    assert.deepEqual(opened, []);
  });

  it("ignores a control it does not know, and an address that is not a game", async () => {
    const { viewer, events } = rig();
    viewer.open("../../etc");
    assert.deepEqual(events, []);
    viewer.open("lost-cathedral");
    await settle();
    viewer.control("rm -rf");
    assert.equal(viewer.showing(), "lost-cathedral");
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
