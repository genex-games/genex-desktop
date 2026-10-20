import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { AccountId, SubscriptionAccounts } from "../../src/substrate/engines/subscription-accounts.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A home that holds a sign-in, as the CLIs leave one: a JSON file in it. */
async function signIn(home: string): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, "auth.json"), "{}");
}

async function store(options: { terminal?: boolean; studio?: boolean } = {}) {
  const root = await tmpDir("studio-accounts-");
  const systemHome = path.join(root, "system");
  const studioHome = path.join(root, "engine-homes", "codex");
  if (options.terminal) await signIn(systemHome);
  if (options.studio) await signIn(studioHome);
  const accounts = new SubscriptionAccounts({
    systemHome,
    studioHome,
    root: path.join(root, "engine-homes", "accounts", "codex"),
    signedIn: async (home) => (await readdir(home).catch(() => [])).length > 0,
  });
  return { accounts, root, systemHome, studioHome };
}

describe("subscription accounts", () => {
  it("lists the Terminal login and Studio's own login, the Studio one in use when nothing was chosen", async () => {
    const { accounts } = await store({ terminal: true, studio: true });
    const list = await accounts.list();
    assert.deepEqual(
      list.map(({ id, terminal, signedIn, active }) => ({ id, terminal, signedIn, active })),
      [
        { id: AccountId.Terminal, terminal: true, signedIn: true, active: false },
        { id: AccountId.Studio, terminal: false, signedIn: true, active: true },
      ],
    );
  });

  it("lists only the Terminal login when Studio has none of its own", async () => {
    const { accounts } = await store({ terminal: true });
    const list = await accounts.list();
    assert.deepEqual(
      list.map(({ id, active }) => ({ id, active })),
      [{ id: AccountId.Terminal, active: true }],
    );
  });

  it("gives each added account its own home beside the others, and lists it once it is remembered", async () => {
    const { accounts, root, systemHome, studioHome } = await store({ terminal: true });
    const added = await accounts.newAccount();
    assert.equal(path.dirname(added.home), path.join(root, "engine-homes", "accounts", "codex"));
    assert.notEqual(added.home, systemHome);
    assert.notEqual(added.home, studioHome);
    assert.equal((await accounts.list()).length, 1, "an account still signing in is not listed");
    await signIn(added.home);
    await accounts.remember(added.id, { email: "work@example.com" });
    const second = (await accounts.list()).find((entry) => entry.id === added.id);
    assert.equal(second?.email, "work@example.com");
    assert.equal(second?.signedIn, true);
    assert.equal((await accounts.newAccount()).id === added.id, false, "a remembered account's home is never reused");
  });

  it("reuses the home of an added account whose sign-in never finished, emptied first", async () => {
    const { accounts } = await store();
    const first = await accounts.newAccount();
    await signIn(first.home);
    const again = await accounts.newAccount();
    assert.equal(again.id, first.id);
    assert.deepEqual(await readdir(again.home).catch(() => []), []);
  });

  it("uses the chosen account from then on, and keeps the choice", async () => {
    const { accounts, systemHome } = await store({ terminal: true, studio: true });
    await accounts.choose(AccountId.Terminal);
    assert.equal(await accounts.chosen(), AccountId.Terminal);
    assert.equal(accounts.homeFor(AccountId.Terminal), systemHome);
    const active = (await accounts.list()).filter((entry) => entry.active).map((entry) => entry.id);
    assert.deepEqual(active, [AccountId.Terminal]);
  });

  it("finds the account a home belongs to", async () => {
    const { accounts, systemHome, studioHome } = await store();
    const added = await accounts.newAccount();
    assert.equal(accounts.idFor(systemHome), AccountId.Terminal);
    assert.equal(accounts.idFor(studioHome), AccountId.Studio);
    assert.equal(accounts.idFor(added.home), added.id);
    assert.equal(accounts.idFor("/somewhere/else"), null);
  });

  it("a sign-in that reports no email keeps none of the account's earlier one", async () => {
    const { accounts } = await store({ studio: true });
    await accounts.remember(AccountId.Studio, { email: "before@example.com" });
    await accounts.remember(AccountId.Studio, { email: null });
    assert.equal((await accounts.list()).find((entry) => entry.id === AccountId.Studio)?.email, null);
  });

  it("forgets an account: it leaves the list, and a choice of it is dropped", async () => {
    const { accounts } = await store({ terminal: true });
    const added = await accounts.newAccount();
    await signIn(added.home);
    await accounts.remember(added.id, {});
    await accounts.choose(added.id);
    await accounts.forget(added.id);
    assert.equal(await accounts.chosen(), null);
    assert.deepEqual(
      (await accounts.list()).map((entry) => entry.id),
      [AccountId.Terminal],
    );
  });

  it("changes asked at the same time each land, one after another in the order asked", async () => {
    const { accounts } = await store({ studio: true });
    const added = await accounts.newAccount();
    await signIn(added.home);
    await accounts.remember(added.id, {});
    // As in Settings: an email lookup keeps its answer while the person forgets that account.
    await Promise.all([
      accounts.remember(added.id, { email: "old@example.com" }),
      accounts.forget(added.id),
      accounts.remember(AccountId.Studio, { email: "me@example.com" }),
    ]);
    assert.deepEqual(
      (await accounts.list()).map(({ id, email }) => ({ id, email })),
      [{ id: AccountId.Studio, email: "me@example.com" }],
    );
    assert.equal((await accounts.newAccount()).id, added.id, "the forgotten account's id is free again");
  });

  it("refuses ids that are not an account's, and touches nothing for them", async () => {
    const { accounts, root } = await store({ terminal: true });
    const hostile = [
      "",
      "..",
      "../system",
      "account-1/../../x",
      "/etc",
      "account-",
      "ACCOUNT-2",
      "account-2 ",
      "x".repeat(300),
    ];
    for (const id of hostile) {
      assert.equal(accounts.homeFor(id), null, id);
      await assert.rejects(accounts.choose(id), Error, id);
      await assert.rejects(accounts.remember(id, {}), Error, id);
    }
    assert.equal(await accounts.chosen(), null);
    assert.deepEqual(await readdir(path.join(root, "engine-homes")).catch(() => []), []);
  });

  it("refuses to choose a known id that has no account behind it", async () => {
    const { accounts } = await store({ terminal: true });
    await assert.rejects(accounts.choose("account-7"));
    await assert.rejects(accounts.choose(AccountId.Studio));
  });

  it("reads a damaged choice file as no choice", async () => {
    const { accounts, root } = await store({ terminal: true });
    const file = path.join(root, "engine-homes", "accounts", "codex", "accounts.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{not json");
    assert.equal(await accounts.chosen(), null);
    assert.equal((await accounts.list()).length, 1);
  });
});
