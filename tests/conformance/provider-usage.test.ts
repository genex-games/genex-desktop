/** The subscriptions' plan limits as one live state: what each one shows, and when it is read. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { createProviderUsage, type UsageSource } from "../../src/main/core/provider-usage.ts";
import { EngineStatusCode } from "../../src/shared/engine-descriptor.ts";
import { createProviderUsageStore, usageReported } from "../../src/renderer/state/provider-usage.ts";
import { type ProviderUsage, type ProviderUsageReport, UsageState } from "../../src/shared/provider-usage.ts";

const CLAUDE = "claude-code";
const CODEX = "codex";

const reading = (percent: number): ProviderUsage => ({
  measuredAt: "2026-10-22T12:00:00.000Z",
  plan: "max",
  windows: [{ id: "five_hour", label: "5-hour limit", percent }],
});

/** A promise and the hand that settles it. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** A subscription whose status, account and next readings the test sets. */
function fakeSource(over: Partial<UsageSource> & { reads?: Array<() => Promise<ProviderUsage | null>> } = {}) {
  const source = {
    code: EngineStatusCode.Ready as string,
    accountId: "terminal" as string | null,
    asked: 0,
    reads: over.reads ?? [],
  };
  const engine: UsageSource = {
    status: over.status ?? (async () => ({ code: source.code })),
    account: over.account ?? (async () => source.accountId),
    readUsage: async () => {
      source.asked += 1;
      const next = source.reads.shift();
      return next ? next() : null;
    },
  };
  return { source, engine };
}

function rig(sources: Record<string, UsageSource>) {
  const pushes: ProviderUsageReport[][] = [];
  const usage = createProviderUsage({
    engines: [CLAUDE, CODEX],
    source: (id) => sources[id] ?? null,
    push: (reports) => pushes.push(reports),
  });
  const last = (id: string) => pushes.at(-1)?.find((report) => report.engine === id);
  return { usage, pushes, last };
}

describe("a subscription's plan limits", () => {
  it("show checking, then the reading, for the account in use", async () => {
    const claude = fakeSource({ reads: [async () => reading(23)] });
    const { usage, pushes } = rig({ [CLAUDE]: claude.engine });
    await usage.refresh([CLAUDE]);
    assert.deepEqual(
      pushes.slice(0, 2).map((reports) => reports.map(({ state, account }) => ({ state, account }))),
      [[{ state: UsageState.Checking, account: "terminal" }], [{ state: UsageState.Ready, account: "terminal" }]],
    );
    assert.equal(usage.snapshot()[0]?.usage?.windows[0]?.percent, 23);
  });

  it("are read for each subscription on its own: a slow one never holds another back", async () => {
    const slow = deferred<ProviderUsage | null>();
    const claude = fakeSource({ reads: [() => slow.promise] });
    const codex = fakeSource({ reads: [async () => reading(1)] });
    const { usage, last } = rig({ [CLAUDE]: claude.engine, [CODEX]: codex.engine });
    const all = usage.refresh();
    await usage.refresh([CODEX]);
    assert.equal(last(CODEX)?.state, UsageState.Ready, "Codex shows while Claude is still being read");
    assert.equal(last(CLAUDE)?.state, UsageState.Checking);
    slow.resolve(reading(10));
    await all;
    assert.equal(last(CLAUDE)?.state, UsageState.Ready);
  });

  it("keep the last numbers on screen while the same account is read again", async () => {
    const again = deferred<ProviderUsage | null>();
    const claude = fakeSource({ reads: [async () => reading(23), () => again.promise] });
    const { usage, last } = rig({ [CLAUDE]: claude.engine });
    await usage.refresh();
    const second = usage.refresh();
    while (claude.source.asked < 2) await tick();
    assert.equal(last(CLAUDE)?.state, UsageState.Checking);
    assert.equal(last(CLAUDE)?.usage?.windows[0]?.percent, 23, "no flicker to empty on a refresh");
    again.resolve(reading(24));
    await second;
    assert.equal(last(CLAUDE)?.usage?.windows[0]?.percent, 24);
  });

  it("never show the last account's numbers after a switch", async () => {
    const next = deferred<ProviderUsage | null>();
    const claude = fakeSource({ reads: [async () => reading(23), () => next.promise] });
    const { usage, pushes, last } = rig({ [CLAUDE]: claude.engine });
    await usage.refresh();
    claude.source.accountId = "account-2";
    const switched = usage.refresh();
    next.resolve(reading(5));
    await switched;
    const afterSwitch = pushes.flat().filter((report) => report.account === "account-2");
    assert.ok(
      afterSwitch.every((report) => report.usage?.windows[0]?.percent !== 23),
      "the new account never carries the old account's limits",
    );
    assert.equal(afterSwitch[0]?.state, UsageState.Checking);
    assert.equal(afterSwitch[0]?.usage, null);
    assert.equal(last(CLAUDE)?.usage?.windows[0]?.percent, 5);
  });

  it("say the plan shares none when the provider answers without limits", async () => {
    const codex = fakeSource({ reads: [async () => null] });
    const { usage, last } = rig({ [CODEX]: codex.engine });
    await usage.refresh();
    assert.equal(last(CODEX)?.state, UsageState.NotShared);
  });

  it("say a read failed instead of reporting no limits, keeping the account's last numbers", async () => {
    const claude = fakeSource({
      reads: [
        async () => reading(23),
        async () => {
          throw new Error("the CLI did not answer in time");
        },
      ],
    });
    const { usage, last } = rig({ [CLAUDE]: claude.engine });
    await usage.refresh();
    await usage.refresh();
    assert.equal(last(CLAUDE)?.state, UsageState.Failed);
    assert.equal(last(CLAUDE)?.usage?.windows[0]?.percent, 23);
  });

  it("ask for a sign-in when a shown account signs out, and never list a subscription never signed in", async () => {
    const claude = fakeSource({ reads: [async () => reading(23)] });
    const codex = fakeSource();
    codex.source.code = EngineStatusCode.NeedsLogin;
    const { usage, last } = rig({ [CLAUDE]: claude.engine, [CODEX]: codex.engine });
    await usage.refresh();
    assert.equal(last(CODEX), undefined, "a subscription never signed in is not a plan of this person's");
    claude.source.code = EngineStatusCode.NeedsLogin;
    await usage.refresh();
    assert.equal(last(CLAUDE)?.state, UsageState.SignedOut);
    assert.equal(last(CLAUDE)?.usage, null);
    assert.equal(claude.source.asked, 1, "a signed-out account's limits are not asked for");
  });

  it("join a read under way, and read once more when the account may have changed during it", async () => {
    const first = deferred<ProviderUsage | null>();
    const claude = fakeSource({ reads: [() => first.promise, async () => reading(30)] });
    const { usage, last } = rig({ [CLAUDE]: claude.engine });
    const reads = [usage.refresh(), usage.refresh(), usage.refresh()];
    while (claude.source.asked < 1) await tick();
    reads.push(usage.refreshShown(), usage.refreshShown());
    first.resolve(reading(20));
    await Promise.all(reads);
    assert.equal(claude.source.asked, 2, "panel refreshes join the read; a sign-in or switch during it costs one more");
    assert.equal(last(CLAUDE)?.usage?.windows[0]?.percent, 30);
  });

  it("read again only the subscriptions already shown after a sign-in, switch or recheck", async () => {
    const claude = fakeSource({ reads: [async () => reading(23), async () => reading(24)] });
    const codex = fakeSource({ reads: [async () => reading(1)] });
    const { usage } = rig({ [CLAUDE]: claude.engine, [CODEX]: codex.engine });
    await usage.refresh([CLAUDE]);
    await usage.refreshShown();
    assert.equal(claude.source.asked, 2);
    assert.equal(codex.source.asked, 0, "a plan nobody looked at is not read on every engine change");
  });
});

describe("the app's copy of the plan limits", () => {
  const ready: ProviderUsageReport = {
    engine: CLAUDE,
    state: UsageState.Ready,
    account: "terminal",
    usage: reading(23),
  };

  it("keeps waiting on an empty first answer, which only means reads are on their way", async () => {
    const answers: ProviderUsageReport[][] = [[], [ready]];
    const store = createProviderUsageStore({ providerUsage: async () => answers.shift() ?? [] });
    store.refresh();
    await tick();
    assert.equal(store.getState().reports, null, "an empty first answer never reads as no plans");
    store.setState((state) => usageReported(state, [ready]), true);
    assert.equal(store.getState().reports?.[0]?.state, UsageState.Ready);
  });

  it("asks main again on hover only after a while, and at once on Try again", async () => {
    let asked = 0;
    let clock = 0;
    const store = createProviderUsageStore(
      {
        providerUsage: async () => {
          asked += 1;
          return [ready];
        },
      },
      () => clock,
    );
    store.refresh();
    store.refresh();
    assert.equal(asked, 1, "a second hover right after the first asks nothing");
    store.refresh(true);
    assert.equal(asked, 2, "Try again always asks");
    clock += 60_000;
    store.refresh();
    assert.equal(asked, 3);
  });

  it("says main could not be asked only when there is nothing to show instead", async () => {
    const store = createProviderUsageStore({
      providerUsage: async () => {
        throw new Error("main is restarting");
      },
    });
    store.refresh();
    await tick();
    assert.equal(store.getState().failed, true);
    store.setState((state) => usageReported(state, [ready]), true);
    store.refresh(true);
    await tick();
    assert.equal(store.getState().failed, false, "a shown answer stays instead of a failure line");
    assert.equal(store.getState().reports?.length, 1);
  });
});

describe("a plan's limits around an account change", () => {
  it("never keep numbers read while the account changed under them", async () => {
    let accountId = "terminal";
    let asked = 0;
    const source: UsageSource = {
      status: async () => ({ code: EngineStatusCode.Ready }),
      account: async () => accountId,
      readUsage: async () => {
        asked += 1;
        if (asked === 1) {
          // The switch lands while the old account's (cached) numbers are being handed back.
          accountId = "account-2";
          return reading(80);
        }
        return reading(5);
      },
    };
    const { usage, pushes, last } = rig({ [CLAUDE]: source });
    await usage.refresh();
    const paired = pushes.flat().filter((report) => report.account === "account-2");
    assert.ok(
      paired.every((report) => report.usage?.windows[0]?.percent !== 80),
      "the new account never shows the old account's numbers",
    );
    assert.equal(asked, 2, "the new account is read at once");
    assert.equal(last(CLAUDE)?.usage?.windows[0]?.percent, 5);
  });

  it("show a shown plan whose engine errors as failed, instead of making it vanish", async () => {
    let code: string = EngineStatusCode.Ready;
    const source: UsageSource = {
      status: async () => ({ code }),
      account: async () => "terminal",
      readUsage: async () => reading(23),
    };
    const { usage, last } = rig({ [CLAUDE]: source });
    await usage.refresh();
    code = EngineStatusCode.Error;
    await usage.refresh();
    assert.equal(last(CLAUDE)?.state, UsageState.Failed);
    assert.equal(last(CLAUDE)?.usage?.windows[0]?.percent, 23);
  });
});

describe("a plan's read that cannot settle", () => {
  it("ends as failed, never checking for good, when the account keeps changing", async () => {
    let flip = 0;
    const source: UsageSource = {
      status: async () => ({ code: EngineStatusCode.Ready }),
      account: async () => `account-${(flip++ % 2) + 2}`,
      readUsage: async () => reading(10),
    };
    const { usage, last } = rig({ [CLAUDE]: source });
    await usage.refresh();
    assert.equal(last(CLAUDE)?.state, UsageState.Failed, "Try again shows instead of an endless shimmer");
    assert.equal(last(CLAUDE)?.usage, null);
  });

  it("keeps good numbers when only the second look at the account fails", async () => {
    let looks = 0;
    const source: UsageSource = {
      status: async () => ({ code: EngineStatusCode.Ready }),
      account: async () => {
        looks += 1;
        if (looks === 2) throw new Error("accounts file busy");
        return "terminal";
      },
      readUsage: async () => reading(23),
    };
    const { usage, last } = rig({ [CLAUDE]: source });
    await usage.refresh();
    assert.equal(last(CLAUDE)?.state, UsageState.Ready);
    assert.equal(last(CLAUDE)?.usage?.windows[0]?.percent, 23);
  });

  it("shows a shown plan as failed when its engine cannot even say its status", async () => {
    let broken = false;
    const source: UsageSource = {
      status: async () => {
        if (broken) throw new Error("probe crashed");
        return { code: EngineStatusCode.Ready };
      },
      account: async () => "terminal",
      readUsage: async () => reading(23),
    };
    const { usage, last } = rig({ [CLAUDE]: source });
    await usage.refresh();
    broken = true;
    await usage.refresh();
    assert.equal(last(CLAUDE)?.state, UsageState.Failed);
  });
});
