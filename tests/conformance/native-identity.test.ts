/**
 * Who a native game Play starts on this Mac is told the player is. Genex mints a sign-in ticket only
 * for a game the player agreed may know who they are (App Review 4.7.3, per game and account): Play
 * asks once, records the agreement on Genex, and mints again; a player who says no, a refusal or a
 * failure plays as a guest. Before this, every native game played as a guest, silently.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  forgetNativeIdentity,
  type IdentityAsk,
  type NativeIdentityDeps,
  nativeTicket,
} from "../../src/main/play/native-identity.ts";
import { type PlayTicket, TicketDelivery, TicketStatus } from "../../src/main/play/gallery.ts";

const SLUG = "colored-cubes";
const minted = (ticket: string): PlayTicket => ({ status: TicketStatus.Minted, ticket });
const consent: PlayTicket = { status: TicketStatus.ConsentRequired, projectId: "cm1" };

/** A Play whose mints answer in turn, whose player answers `yes`, and that records what was asked and done. */
function play(mints: PlayTicket[], { yes = true, shares = true }: { yes?: boolean; shares?: boolean } = {}) {
  const log: string[] = [];
  const deps: NativeIdentityDeps = {
    ticket: async (slug, delivery) => {
      log.push(`mint ${slug} ${delivery}`);
      return mints.shift() ?? { status: TicketStatus.NotMinted };
    },
    ask: async (question: IdentityAsk) => {
      log.push(`ask ${question.slug}`);
      return yes;
    },
    share: async (projectId) => {
      log.push(`share ${projectId}`);
      return shares;
    },
    shared: async (slug, projectId) => {
      log.push(`remember ${slug} ${projectId}`);
    },
  };
  return { deps, log };
}

describe("a native game's sign-in", () => {
  it("signs the player in at once where the game may already know them, asking nothing", async () => {
    const { deps, log } = play([minted("T1")]);
    assert.equal(await nativeTicket(deps, SLUG), "T1");
    assert.deepEqual(log, [`mint ${SLUG} ${TicketDelivery.Native}`]);
  });

  it("asks once where the game may not know them yet, records the yes on Genex, and signs them in", async () => {
    const { deps, log } = play([consent, minted("T2")]);
    assert.equal(await nativeTicket(deps, SLUG), "T2");
    assert.deepEqual(log, [
      `mint ${SLUG} native`,
      `ask ${SLUG}`,
      "share cm1",
      `remember ${SLUG} cm1`,
      `mint ${SLUG} native`,
    ]);
  });

  it("plays as a guest when the player says no, is signed out, or Genex refuses, records nothing and asks no more", async () => {
    const no = play([consent], { yes: false });
    assert.equal(await nativeTicket(no.deps, SLUG), undefined);
    assert.deepEqual(no.log, [`mint ${SLUG} native`, `ask ${SLUG}`]);

    const signedOut = play([{ status: TicketStatus.SignedOut }]);
    assert.equal(await nativeTicket(signedOut.deps, SLUG), undefined);
    assert.deepEqual(signedOut.log, [`mint ${SLUG} native`], "a signed-out player is never asked");

    const unshared = play([consent], { shares: false });
    assert.equal(await nativeTicket(unshared.deps, SLUG), undefined);
    assert.deepEqual(unshared.log, [`mint ${SLUG} native`, `ask ${SLUG}`, "share cm1"]);

    const again = play([consent, consent]);
    assert.equal(await nativeTicket(again.deps, SLUG), undefined, "a second refusal is not asked about again");
    assert.equal(again.log.filter((line) => line.startsWith("ask")).length, 1);
  });
});

describe("a native game the player stops sharing who they are with", () => {
  it("withdraws the agreement on Genex, then forgets it here; a failure keeps it shown, and a game that knows nobody calls nothing", async () => {
    const log: string[] = [];
    const deps = (forgets: boolean, project: string | null) => ({
      projectOf: async () => project,
      forget: async (projectId: string) => {
        log.push(`forget ${projectId}`);
        return forgets;
      },
      knowsYou: async (slug: string, projectId: string | null) => {
        log.push(`knows ${slug} ${projectId}`);
      },
    });
    await forgetNativeIdentity(deps(true, "cm1"), SLUG);
    assert.deepEqual(log.splice(0), ["forget cm1", `knows ${SLUG} null`]);
    await assert.rejects(forgetNativeIdentity(deps(false, "cm1"), SLUG), /couldn't stop sharing/);
    assert.deepEqual(log.splice(0), ["forget cm1"], "still shown as sharing");
    await forgetNativeIdentity(deps(true, null), SLUG);
    assert.deepEqual(log, []);
  });
});
