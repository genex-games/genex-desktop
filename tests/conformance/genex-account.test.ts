/**
 * The app's Genex account in main: one view every surface reads (signed out, signing in, signed in,
 * or a sign-in genex.games ended), sign-in through the browser, cancel and sign-out. On the Genex
 * plugin, a removed Genex comes back on the way to signing in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGenexAccount, type GenexAccountPort, pluginAccountPort } from "../../src/main/core/genex-account.ts";
import {
  FIXTURE_SIGN_IN_CODE,
  FIXTURE_SIGN_IN_MS,
  fixtureAccountPort,
} from "../../src/main/dev/fixture-genex-account.ts";
import { devStandAccountPort } from "../../src/main/dev/dev-stand-account.ts";
import { GenexRoute } from "../../src/plugins/genex/http.ts";
import { FixtureAccount, fixtureAccountToken } from "../../src/main/dev/fixture-people.ts";
import type { GalleryAnswer, GalleryRequest } from "../../src/main/play/gallery.ts";
import { fixturePlayRequest } from "../../src/main/dev/fixture-play.ts";
import { playPeople } from "../../src/main/play/people.ts";
import { GenexAccountStatus } from "../../src/shared/genex-account.ts";
import { PLAY_ORIGIN } from "../../src/shared/play.ts";
import { GENEX_PLUGIN_ID, GenexAction } from "../../src/shared/genex.ts";
import { PluginAccountState } from "../../src/shared/plugins.ts";

/**
 * A port the test drives: what the account is, and every call made of it. `held` keeps each
 * connect waiting until the test lets it go, as a slow Genex does.
 */
function fakePort(start: { state?: PluginAccountState; token?: string; held?: boolean } = {}) {
  const calls: string[] = [];
  let state = start.state;
  let token = start.token;
  let release = (): void => {};
  const gate = start.held ? new Promise<void>((go) => (release = go)) : Promise.resolve();
  const port: GenexAccountPort = {
    state: async () => state,
    token: async () => token,
    connect: async () => {
      calls.push("connect");
      await gate;
      if (token) return {};
      state = PluginAccountState.Authorizing;
      return { verifyUrl: "https://genex.games/device?code=ABCD-1234", userCode: "ABCD-1234" };
    },
    cancel: async () => {
      calls.push("cancel");
      state = PluginAccountState.NotConnected;
    },
    disconnect: async () => {
      calls.push("disconnect");
      state = PluginAccountState.NotConnected;
      token = undefined;
    },
    signedIn: async () => {
      calls.push("signed in");
    },
  };
  /** The browser approved the sign-in: the token is saved. */
  const approve = (next: string): void => {
    state = PluginAccountState.Unlocked;
    token = next;
  };
  /** Let every held connect answer, now and from now on. */
  return { port, calls, approve, release: () => release() };
}

/** The account over `port`, with the pages it opened. */
function account(port: GenexAccountPort) {
  const opened: string[] = [];
  const service = createGenexAccount({
    port,
    openSignIn: async (url) => {
      opened.push(url);
    },
  });
  return { service, opened };
}

test("no Genex, a locked store and an empty one all read as signed out", async () => {
  for (const state of [undefined, PluginAccountState.Locked, PluginAccountState.NotConnected]) {
    const { service } = account(fakePort({ state }).port);
    assert.deepEqual(await service.view(), { status: GenexAccountStatus.SignedOut }, String(state));
  }
});

test("signing in opens the browser and reads as signing in with its code, until it is approved", async () => {
  const fake = fakePort({ state: PluginAccountState.NotConnected });
  const { service, opened } = account(fake.port);
  assert.deepEqual(await service.signIn(), { status: GenexAccountStatus.SigningIn, code: "ABCD-1234" });
  assert.deepEqual(opened, ["https://genex.games/device?code=ABCD-1234"]);
  fake.approve("token-1");
  assert.deepEqual(await service.view(), { status: GenexAccountStatus.SignedIn });
  assert.equal(await service.token(), "token-1");
});

test("cancelling a sign-in reads as signed out again", async () => {
  const fake = fakePort({ state: PluginAccountState.NotConnected });
  const { service } = account(fake.port);
  await service.signIn();
  assert.deepEqual(await service.cancel(), { status: GenexAccountStatus.SignedOut });
  assert.deepEqual(fake.calls, ["connect", "cancel"]);
});

test("a token genex.games refused reads as ended; signing in again replaces it", async () => {
  const fake = fakePort({ state: PluginAccountState.Unlocked, token: "old" });
  const { service, opened } = account(fake.port);
  service.refused("old");
  assert.deepEqual(await service.view(), { status: GenexAccountStatus.Ended });
  assert.deepEqual(await service.signIn(), { status: GenexAccountStatus.SigningIn, code: "ABCD-1234" });
  assert.deepEqual(fake.calls, ["disconnect", "connect"], "the refused token goes first");
  assert.equal(opened.length, 1);
  fake.approve("new");
  assert.deepEqual(await service.view(), { status: GenexAccountStatus.SignedIn });
});

test("a refusal of another token never ends the account signed in now", async () => {
  const { service } = account(fakePort({ state: PluginAccountState.Unlocked, token: "current" }).port);
  service.refused("earlier");
  assert.deepEqual(await service.view(), { status: GenexAccountStatus.SignedIn });
});

test("signing in while signed in opens nothing", async () => {
  const fake = fakePort({ state: PluginAccountState.Unlocked, token: "current" });
  const { service, opened } = account(fake.port);
  assert.deepEqual(await service.signIn(), { status: GenexAccountStatus.SignedIn });
  assert.deepEqual(opened, []);
});

test("signing out forgets the account, and a sign-in that ended with it", async () => {
  const fake = fakePort({ state: PluginAccountState.Unlocked, token: "current" });
  const { service } = account(fake.port);
  service.refused("current");
  assert.deepEqual(await service.signOut(), { status: GenexAccountStatus.SignedOut });
  assert.deepEqual(fake.calls, ["disconnect"]);
  fake.approve("current");
  assert.deepEqual(await service.view(), { status: GenexAccountStatus.SignedIn }, "a new sign-in starts clean");
});

test("two presses at once start one sign-in and open one page", async () => {
  const fake = fakePort({ state: PluginAccountState.NotConnected, held: true });
  const { service, opened } = account(fake.port);
  const first = service.signIn();
  const second = service.signIn();
  fake.release();
  assert.deepEqual(await first, await second);
  assert.deepEqual(fake.calls, ["connect"]);
  assert.equal(opened.length, 1);
});

test("a cancel while the sign-in is starting wins: no page opens and the sign-in stops", async () => {
  const fake = fakePort({ state: PluginAccountState.NotConnected, held: true });
  const { service, opened } = account(fake.port);
  const signing = service.signIn();
  const cancelled = await service.cancel();
  fake.release();
  assert.deepEqual(await signing, { status: GenexAccountStatus.SignedOut });
  assert.deepEqual(cancelled, { status: GenexAccountStatus.SignedOut });
  assert.deepEqual(opened, [], "the browser never opens");
  assert.deepEqual(fake.calls, ["cancel", "connect", "cancel"], "the sign-in Genex started late is stopped too");
});

test("a sign-in that finishes turns Genex on once, as does one that reuses the saved account", async () => {
  const fake = fakePort({ state: PluginAccountState.NotConnected });
  const { service } = account(fake.port);
  await service.signIn();
  await service.view();
  assert.ok(!fake.calls.includes("signed in"), "not before the browser approves it");
  fake.approve("token-1");
  await service.view();
  await service.view();
  assert.equal(fake.calls.filter((call) => call === "signed in").length, 1);
  const saved = fakePort({ state: PluginAccountState.Unlocked, token: "token-2" });
  await account(saved.port).service.signIn();
  assert.deepEqual(saved.calls, ["connect", "signed in"]);
  const restored = fakePort({ state: PluginAccountState.Unlocked, token: "token-3" });
  await account(restored.port).service.view();
  assert.deepEqual(restored.calls, [], "an account restored at launch is no sign-in");
});

/** A registry as the plugin port reads it: Genex as listed, and every call made of it. */
function fakeRegistry(genex: { enabled: boolean; removed: boolean } | null) {
  const calls: string[] = [];
  let listed = genex;
  const registry = {
    list: () => (listed ? [{ manifest: { id: GENEX_PLUGIN_ID }, ...listed }] : []),
    accountState: async () => (listed && !listed.removed ? PluginAccountState.NotConnected : undefined),
    hostCredential: async () => undefined,
    restore: async (id: string) => {
      calls.push(`restore ${id}`);
      listed = { enabled: true, removed: false };
    },
    action: async (id: string, name: string) => {
      calls.push(`${name} ${id}`);
      return name === GenexAction.Connect ? { verifyUrl: "https://genex.games/device", userCode: "C0DE" } : {};
    },
    enableForSignIn: async (id: string) => {
      calls.push(`turn on ${id}`);
      return true;
    },
  };
  return { registry, calls };
}

test("the Genex port brings back a removed Genex before it signs in, and leaves an off one off", async () => {
  const removed = fakeRegistry({ enabled: false, removed: true });
  const port = pluginAccountPort(removed.registry);
  assert.equal(await port.state(), undefined);
  assert.deepEqual(await port.connect(), { verifyUrl: "https://genex.games/device", userCode: "C0DE" });
  assert.deepEqual(removed.calls, [`restore ${GENEX_PLUGIN_ID}`, `${GenexAction.Connect} ${GENEX_PLUGIN_ID}`]);
  const off = fakeRegistry({ enabled: false, removed: false });
  await pluginAccountPort(off.registry).connect();
  assert.deepEqual(
    off.calls,
    [`${GenexAction.Connect} ${GENEX_PLUGIN_ID}`],
    "nothing turns on before the sign-in ends",
  );
  await pluginAccountPort(off.registry).signedIn();
  assert.deepEqual(off.calls.at(-1), `turn on ${GENEX_PLUGIN_ID}`, "the registry decides whether it turns on");
});

test("the Genex port cancels and signs out through Genex's own actions, and does nothing with no Genex", async () => {
  const on = fakeRegistry({ enabled: true, removed: false });
  const port = pluginAccountPort(on.registry);
  await port.cancel();
  await port.disconnect();
  assert.deepEqual(on.calls, [
    `${GenexAction.CancelConnect} ${GENEX_PLUGIN_ID}`,
    `${GenexAction.Disconnect} ${GENEX_PLUGIN_ID}`,
  ]);
  const none = fakeRegistry(null);
  await pluginAccountPort(none.registry).cancel();
  await pluginAccountPort(none.registry).disconnect();
  assert.deepEqual(none.calls, []);
});

test("a fixture launch's sign-in waits as if in the browser, then signs in as the fixture account", async () => {
  let clock = 0;
  const { service, opened } = account(fixtureAccountPort(null, () => clock));
  assert.deepEqual(await service.view(), { status: GenexAccountStatus.SignedOut });
  assert.deepEqual(await service.signIn(), { status: GenexAccountStatus.SigningIn, code: FIXTURE_SIGN_IN_CODE });
  assert.deepEqual(opened, [], "no page opens");
  clock += FIXTURE_SIGN_IN_MS;
  assert.deepEqual(await service.view(), { status: GenexAccountStatus.SignedIn });
  assert.equal(await service.token(), fixtureAccountToken(FixtureAccount.Full));
  assert.deepEqual(await service.signOut(), { status: GenexAccountStatus.SignedOut });
});

test("a fixture account genex.games refuses reads as ended, and signing in again replaces it", async () => {
  let clock = 0;
  const { service } = account(fixtureAccountPort(FixtureAccount.Ended, () => clock));
  const token = (await service.token()) ?? assert.fail("signed in");
  const people = playPeople({
    request: fixturePlayRequest,
    token: service.token,
    now: () => clock,
    upload: async () => 200,
    refused: service.refused,
    web: PLAY_ORIGIN.web,
  });
  assert.equal(await people.me(), null);
  assert.deepEqual(await service.view(), { status: GenexAccountStatus.Ended });
  assert.equal(token, fixtureAccountToken(FixtureAccount.Ended));
  assert.equal((await service.signIn()).status, GenexAccountStatus.SigningIn);
  clock += FIXTURE_SIGN_IN_MS;
  assert.equal((await service.view()).status, GenexAccountStatus.SignedIn);
  assert.equal((await people.me())?.name !== undefined, true, "the new sign-in reads its account");
});

/**
 * A development copy of genex.games' device sign-in: Start hands out a code and the website's page
 * to approve it, Poll answers pending until the test approves or denies, then the token once.
 */
function devStand(start: Record<string, unknown> = {}) {
  const calls: Array<{ route: string; body: unknown }> = [];
  let decision: "pending" | "approved" | "denied" = "pending";
  const request: GalleryRequest = async (route, init): Promise<GalleryAnswer> => {
    calls.push({ route, body: init.body });
    if (route === GenexRoute.DeviceStart)
      return {
        status: 200,
        body: {
          userCode: "WXYZ-2345",
          deviceCode: "d".repeat(43),
          verifyUrl: "http://localhost:5173/c/WXYZ-2345",
          expiresIn: 600,
          interval: 2,
          ...start,
        },
      };
    if (decision === "approved") return { status: 200, body: { status: "approved", token: "stand-token" } };
    return { status: 200, body: { status: decision } };
  };
  return { request, calls, decide: (next: typeof decision) => (decision = next) };
}

test("a development profile signs in on its own genex.games copy, in the browser, for the launch only", async () => {
  let clock = 0;
  const stand = devStand();
  const { service, opened } = account(
    devStandAccountPort({ request: stand.request, now: () => clock, web: "http://localhost:5173" }),
  );
  assert.deepEqual(await service.view(), { status: GenexAccountStatus.SignedOut });
  assert.deepEqual(await service.signIn(), { status: GenexAccountStatus.SigningIn, code: "WXYZ-2345" });
  assert.deepEqual(opened, ["http://localhost:5173/c/WXYZ-2345"], "the copy's own website approves it");
  clock += 5_000;
  assert.equal((await service.view()).status, GenexAccountStatus.SigningIn, "pending while it waits");
  stand.decide("approved");
  clock += 2_000;
  assert.equal(
    (await service.view()).status,
    GenexAccountStatus.SigningIn,
    "polled no faster than genex.games' own floor, whatever the copy asks",
  );
  clock += 3_000;
  assert.deepEqual(await service.view(), { status: GenexAccountStatus.SignedIn });
  assert.equal(await service.token(), "stand-token");
  assert.deepEqual(
    stand.calls.filter((c) => c.route === GenexRoute.DevicePoll).map((c) => c.body),
    [{ deviceCode: "d".repeat(43) }, { deviceCode: "d".repeat(43) }],
  );
  assert.deepEqual(await service.signOut(), { status: GenexAccountStatus.SignedOut });
  assert.equal(await service.token(), undefined, "signing out forgets the token");
});

test("a development sign-in the browser denied, or that ran out, signs nobody in", async () => {
  let clock = 0;
  const denied = devStand();
  const deny = account(
    devStandAccountPort({ request: denied.request, now: () => clock, web: "http://localhost:5173" }),
  );
  await deny.service.signIn();
  denied.decide("denied");
  clock += 5_000;
  assert.deepEqual(await deny.service.view(), { status: GenexAccountStatus.SignedOut });
  const expired = devStand({ expiresIn: 5 });
  const late = account(
    devStandAccountPort({ request: expired.request, now: () => clock, web: "http://localhost:5173" }),
  );
  await late.service.signIn();
  clock += 6_000;
  assert.deepEqual(await late.service.view(), { status: GenexAccountStatus.SignedOut });
});

test("a development sign-in whose copy names no lifetime keeps waiting for the browser", async () => {
  let clock = 0;
  const stand = devStand({ expiresIn: undefined });
  const { service } = account(
    devStandAccountPort({ request: stand.request, now: () => clock, web: "http://localhost:5173" }),
  );
  await service.signIn();
  clock += 60_000;
  assert.equal((await service.view()).status, GenexAccountStatus.SigningIn, "not dropped at once");
  stand.decide("approved");
  clock += 5_000;
  assert.deepEqual(await service.view(), { status: GenexAccountStatus.SignedIn });
});

test("a development sign-in opens only a page of the website Play links to", async () => {
  for (const start of [
    { verifyUrl: "https://evil.example/c/WXYZ-2345" },
    { verifyUrl: "https://genex.games/c/WXYZ-2345" },
    { verifyUrl: "javascript:alert(1)" },
    { deviceCode: 7 },
    { userCode: null },
  ]) {
    const stand = devStand(start);
    const { service, opened } = account(
      devStandAccountPort({ request: stand.request, now: () => 0, web: "http://localhost:5173" }),
    );
    await assert.rejects(service.signIn(), JSON.stringify(start));
    assert.deepEqual(opened, [], JSON.stringify(start));
    assert.deepEqual(await service.view(), { status: GenexAccountStatus.SignedOut });
  }
});
