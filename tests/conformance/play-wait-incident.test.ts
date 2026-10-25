/**
 * PW incident (the owner's "Opening…" wait): a person's Play waited minutes behind a run's checks.
 * The person's window was reserved past the agents' ceiling for browser windows only; a Play that
 * needs a native lease (a desktop build) queued behind the agents' native leases. Each row holds
 * every lease the agents may hold and asserts the person's Play takes its own at once, browser or
 * native, and that the agents' own ceilings are unchanged by it. The lane's side (build slots and
 * the shared target) is `rust-build.test.ts`'s "PW incident" rows.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { NATIVE_LEASES_MAX } from "../../src/shared/native-contract.ts";
import {
  PERSON_NATIVE_LEASES_MAX,
  PERSON_WINDOWS_MAX,
  PreviewActor,
  PreviewPool,
} from "../../src/substrate/preview-pool.ts";
import type { PreviewPort } from "../../src/substrate/preview-port.ts";

const live = {} as PreviewPort;
/** How long a lease that should be given at once may take before the row calls it a wait. */
const AT_ONCE_MS = 200;

function pool(max = 2): PreviewPool {
  return new PreviewPool({
    live,
    max,
    createHeadless: async () => ({}) as PreviewPort,
    createNative: async () => ({}) as PreviewPort,
  });
}

/** Whether `taking` settled within {@link AT_ONCE_MS}. */
async function atOnce(taking: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void taking.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await sleep(AT_ONCE_MS);
  return settled;
}

/** Every native lease and every hidden window the agents may hold, held. */
async function agentsHoldEverything(previews: PreviewPool): Promise<void> {
  for (let i = 0; i < NATIVE_LEASES_MAX; i++)
    await previews.acquire({ label: `judge-${i}`, owner: "run", target: BuildTarget.Mac });
  for (let i = 0; i < previews.max; i++) await previews.acquire({ label: `builder-${i}`, owner: "run" });
}

const PLAYS = [
  { view: "the browser (Play latest, a run card's Play)", target: undefined },
  { view: "Native (the Mac build)", target: BuildTarget.Mac },
  { view: "Native on a Linux host", target: BuildTarget.Linux },
  { view: "Native on a Windows host", target: BuildTarget.Windows },
] as const;

describe("a person's Play never queues behind agents' leases (PW incident)", () => {
  for (const play of PLAYS) {
    it(`takes the person's own lease at once in ${play.view} while a run holds every agent's lease`, async () => {
      const previews = pool();
      await agentsHoldEverything(previews);
      const taking = previews.acquire({
        label: "preview-candidate:ferris",
        by: PreviewActor.Person,
        ...(play.target ? { target: play.target } : {}),
      });
      assert.equal(await atOnce(taking), true, "the person's Play waited for an agent's lease");
      const lease = await taking;
      assert.equal(previews.leaseOf(lease.handle)?.native, play.target !== undefined);
      assert.equal(previews.personLeaseCount, 1);
    });
  }

  it("keeps the agents' native ceiling: an agent past it still waits, and a second Play waits like an agent", async () => {
    const previews = pool();
    await agentsHoldEverything(previews);
    const person = await previews.acquire({ label: "play", by: PreviewActor.Person, target: BuildTarget.Mac });
    const agent = previews.acquire({ label: "judge-late", owner: "run", target: BuildTarget.Mac });
    assert.equal(await atOnce(agent), false, "an agent took the person's native lease");
    const second = previews.acquire({ label: "play-again", by: PreviewActor.Person, target: BuildTarget.Mac });
    assert.equal(await atOnce(second), false, "the person has one native lease of their own at a time");
    assert.equal(PERSON_NATIVE_LEASES_MAX, PERSON_WINDOWS_MAX);
    await previews.release(person.handle);
    assert.equal(await atOnce(Promise.race([agent, second])), true, "a given-back person's lease lets the next in");
    await previews.disposeAll();
  });

  it("gives the person's native lease back to the person, never to the agents' count", async () => {
    const previews = pool();
    const person = await previews.acquire({ label: "play", by: PreviewActor.Person, target: BuildTarget.Mac });
    assert.equal(previews.nativeLeaseCount, 1);
    for (let i = 0; i < NATIVE_LEASES_MAX; i++)
      assert.equal(await atOnce(previews.acquire({ label: `judge-${i}`, target: BuildTarget.Mac })), true);
    await previews.release(person.handle);
    assert.equal(
      await atOnce(previews.acquire({ label: "play", by: PreviewActor.Person, target: BuildTarget.Mac })),
      true,
    );
  });
});
