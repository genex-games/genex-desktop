/**
 * The nickname in the renderer and the links Play hands out. The welcome opens once per account on
 * this Mac while genex.games knows no handles (the avatar alone, as before); once it does, its flag
 * is the truth: the welcome with the nickname field opens once for an account that has not chosen
 * one, whichever account it is, and never for one that has, wherever it chose. The field says what
 * a typed handle is in the words both clients use, and Continue waits for a free one (or the
 * account's own). Links go to the website Play links to: a profile by handle, by id while there is
 * none, and X's post page carrying a link.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HandleState } from "../../src/shared/handle.ts";
import { AvatarStyle, type PlayMe } from "../../src/shared/play-people.ts";
import { linkWithoutScheme, profileUrl, xPostUrl } from "../../src/shared/play-share.ts";
import {
  HandleCheckStatus,
  HandleHint,
  HandleNote,
  HandleTone,
  handleFieldView,
  WelcomeKind,
  welcomeFor,
} from "../../src/renderer/play/nickname-model.ts";

const me = (handleChosen: boolean | null, handle: string | null = "rabneba"): PlayMe => ({
  id: "u1",
  name: "Rab Neba",
  handle,
  imageUrl: null,
  avatarVariant: 0,
  pro: false,
  joinedAt: null,
  avatarStyle: AvatarStyle.Generated,
  photoUrl: null,
  avatarVariantKept: true,
  handleChosen,
});
const NOTHING_SEEN = { avatar: false, nickname: false } as const;

describe("which welcome an account gets", () => {
  it("is none signed out", () => {
    assert.equal(welcomeFor(null, NOTHING_SEEN), WelcomeKind.None);
  });

  it("is the avatar alone, once per account on this Mac, while genex.games knows no handles", () => {
    assert.equal(welcomeFor(me(null), NOTHING_SEEN), WelcomeKind.Avatar);
    assert.equal(welcomeFor(me(null), { avatar: true, nickname: false }), WelcomeKind.None);
  });

  it("asks a new account for its nickname, and an account this Mac already welcomed once more", () => {
    assert.equal(welcomeFor(me(false), NOTHING_SEEN), WelcomeKind.Nickname);
    assert.equal(welcomeFor(me(false), { avatar: true, nickname: false }), WelcomeKind.Nickname);
    assert.equal(welcomeFor(me(false, null), NOTHING_SEEN), WelcomeKind.Nickname, "with no handle to prefill yet");
  });

  it("asks only once on this Mac, even when the welcome was closed without saving", () => {
    assert.equal(welcomeFor(me(false), { avatar: true, nickname: true }), WelcomeKind.None);
    assert.equal(welcomeFor(me(false), { avatar: false, nickname: true }), WelcomeKind.None);
  });

  it("is never for an account that chose its nickname, here or on genex.games", () => {
    assert.equal(welcomeFor(me(true), NOTHING_SEEN), WelcomeKind.None);
    assert.equal(welcomeFor(me(true), { avatar: true, nickname: false }), WelcomeKind.None);
  });
});

describe("what the nickname field shows", () => {
  const known = (state: HandleState, suggestions: string[] = []) => ({
    status: HandleCheckStatus.Known,
    check: { handle: "x", state, suggestions },
  });

  it("says each state in the words both clients use, and lets only a free handle or the account's own go on", () => {
    const cases: Array<[HandleState, HandleTone, HandleHint, boolean]> = [
      [HandleState.Free, HandleTone.Ok, HandleHint.ProfileLink, true],
      [HandleState.Yours, HandleTone.Ok, HandleHint.ProfileLink, true],
      [HandleState.Taken, HandleTone.Bad, HandleHint.Try, false],
      [HandleState.Reserved, HandleTone.Bad, HandleHint.Try, false],
      [HandleState.TooShort, HandleTone.Bad, HandleHint.Length, false],
      [HandleState.TooLong, HandleTone.Bad, HandleHint.Length, false],
      [HandleState.LatinOnly, HandleTone.Bad, HandleHint.Letters, false],
      [HandleState.DashEdge, HandleTone.Bad, HandleHint.Letters, false],
    ];
    for (const [state, tone, hint, keepable] of cases) {
      const view = handleFieldView(known(state, ["rab2"]), null);
      assert.deepEqual([view.tone, view.hint, view.keepable], [tone, hint, keepable], state);
    }
  });

  it("shows a reserved handle exactly as a taken one, and Free for the account's own", () => {
    assert.equal(handleFieldView(known(HandleState.Reserved), null).label, HandleState.Taken);
    assert.equal(handleFieldView(known(HandleState.Yours), null).label, HandleState.Free);
  });

  it("offers suggestions only where there is something to try instead", () => {
    assert.deepEqual(handleFieldView(known(HandleState.Taken, ["rab2", "rab-neba"]), null).suggestions, [
      "rab2",
      "rab-neba",
    ]);
    assert.deepEqual(handleFieldView(known(HandleState.LatinOnly, ["rabneba"]), null).suggestions, ["rabneba"]);
    assert.deepEqual(handleFieldView(known(HandleState.Free, ["rab2"]), null).suggestions, []);
    const nothingToTry = handleFieldView(known(HandleState.Taken), null);
    assert.equal(nothingToTry.hint, HandleHint.None, "no lone Try with nothing after it");
  });

  it("waits while genex.games is asked, and says so when it could not be", () => {
    const checking = handleFieldView({ status: HandleCheckStatus.Checking }, null);
    assert.deepEqual(
      [checking.label, checking.tone, checking.hint, checking.keepable],
      [null, null, HandleHint.ProfileLink, false],
    );
    const failed = handleFieldView({ status: HandleCheckStatus.Failed }, null);
    assert.deepEqual([failed.label, failed.hint, failed.keepable], [null, HandleHint.CheckFailed, false]);
  });

  it("puts a save's note in the hint until the handle changes", () => {
    const often = handleFieldView(known(HandleState.Yours), HandleNote.TooManyChanges);
    assert.deepEqual([often.hint, often.keepable], [HandleHint.TooManyChanges, true]);
    assert.equal(handleFieldView(known(HandleState.Free), HandleNote.SaveFailed).hint, HandleHint.SaveFailed);
  });
});

describe("the links Play hands out", () => {
  it("names a profile by its handle, by its id while it has none, on the website Play links to", () => {
    assert.equal(profileUrl("https://genex.games", { id: "u1", handle: "rabneba" }), "https://genex.games/@rabneba");
    assert.equal(profileUrl("https://genex.games", { id: "u_1-x", handle: null }), "https://genex.games/u/u_1-x");
    assert.equal(
      profileUrl("http://localhost:5173", { id: "u1", handle: "rabneba" }),
      "http://localhost:5173/@rabneba",
    );
  });

  it("fills X's post page with the text and the link, each encoded", () => {
    assert.equal(
      xPostUrl("Join me on Genex", "https://genex.games/@rabneba/invite"),
      "https://x.com/intent/post?text=Join%20me%20on%20Genex&url=https%3A%2F%2Fgenex.games%2F%40rabneba%2Finvite",
    );
    assert.equal(
      xPostUrl("a&b=c #d", "https://genex.games/?ref=x&y=1"),
      "https://x.com/intent/post?text=a%26b%3Dc%20%23d&url=https%3A%2F%2Fgenex.games%2F%3Fref%3Dx%26y%3D1",
    );
  });

  it("shows a link without its scheme", () => {
    assert.equal(linkWithoutScheme("https://genex.games/@rabneba/invite"), "genex.games/@rabneba/invite");
    assert.equal(linkWithoutScheme("http://localhost:5173/@rab"), "localhost:5173/@rab");
    assert.equal(linkWithoutScheme("genex.games/@rab"), "genex.games/@rab");
    assert.equal(
      linkWithoutScheme("https://genex.games/@rabneba/invite?ref=k7x2abcd"),
      "genex.games/@rabneba/invite?ref=k7x2abcd",
      "an invite keeps its code",
    );
  });
});
