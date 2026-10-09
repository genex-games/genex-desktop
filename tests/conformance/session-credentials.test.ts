import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { SessionCredentials } from "../../src/substrate/session-credentials.ts";
import { GenexTools } from "../../src/plugins/genex/adapter.ts";
import { SecretStorageUnavailableError, SecretStore, electronBackend } from "../../src/substrate/secrets.ts";
import { SecretStorageIssue } from "../../src/shared/secret-storage.ts";

test("background reads never unlock; concurrent explicit unlocks share one read", async () => {
  let reads = 0;
  const credentials = new SessionCredentials({
    get: async () => {
      reads++;
      await new Promise((r) => setTimeout(r, 5));
      return "fixture";
    },
    set: async () => {},
    clear: async () => {},
  });
  for (let i = 0; i < 10; i++) assert.equal(await credentials.get(), null);
  assert.equal(reads, 0);
  await Promise.all([credentials.unlock(), credentials.unlock()]);
  assert.equal(reads, 1);
  assert.equal(await credentials.get(), "fixture");
  await credentials.unlock();
  assert.equal(reads, 1);
});

test("cancelled unlock stays failed across refreshes and retries only explicitly", async () => {
  let reads = 0;
  const credentials = new SessionCredentials({
    get: async () => {
      reads++;
      throw new Error("cancelled");
    },
    set: async () => {},
    clear: async () => {},
  });
  await assert.rejects(credentials.unlock(), /Automatic retries are paused/);
  for (let i = 0; i < 10; i++) assert.equal(await credentials.get(), null);
  assert.equal(credentials.state, "failed");
  assert.equal(reads, 1);
  await assert.rejects(credentials.unlock());
  assert.equal(reads, 2);
});

test("a locked secret store names its cause when unlock or save is refused", async () => {
  const refused = () => {
    throw new SecretStorageUnavailableError(SecretStorageIssue.NoKeyring);
  };
  const credentials = new SessionCredentials({
    get: async () => refused(),
    set: async () => refused(),
    clear: async () => {},
  });
  await assert.rejects(credentials.unlock(), /could not be unlocked.*Start GNOME Keyring or KWallet/s);
  assert.equal(credentials.state, "failed");
  assert.match(credentials.takeRefusal()?.message ?? "", /Start GNOME Keyring or KWallet/);
  assert.equal(credentials.takeRefusal(), null, "a refusal is taken once");
  await assert.rejects(credentials.set("fixture"), /save failed.*Start GNOME Keyring or KWallet/s);
  credentials.lock();
  assert.equal(credentials.takeRefusal(), null, "a lock forgets the refusal");
});

test("a refusal is recognised by the issue it carries, not by the store's class", async () => {
  const carrying = (issue: string) => () => {
    throw Object.assign(new Error("the store says so"), { issue });
  };
  const known = new SessionCredentials({
    get: async () => carrying("no-keyring")(),
    set: async () => {},
    clear: async () => {},
  });
  await assert.rejects(known.unlock(), /could not be unlocked\. the store says so Automatic retries are paused\./);
  assert.ok(known.takeRefusal());
  const unknown = new SessionCredentials({
    get: async () => carrying("bogus")(),
    set: async () => {},
    clear: async () => {},
  });
  await assert.rejects(unknown.unlock(), /Automatic retries are paused; retry only when/);
  assert.equal(unknown.takeRefusal(), null, "an issue outside the vocabulary is an ordinary failure");
});

test("a plain storage failure leaves no refusal to pass on", async () => {
  const credentials = new SessionCredentials({
    get: async () => {
      throw new Error("cancelled");
    },
    set: async () => {},
    clear: async () => {},
  });
  await assert.rejects(credentials.unlock(), /Automatic retries are paused/);
  assert.equal(credentials.takeRefusal(), null);
});

test("disconnect prevents an in-flight unlock from restoring a token", async () => {
  let resolve!: (token: string) => void;
  const credentials = new SessionCredentials({
    get: () =>
      new Promise<string>((r) => {
        resolve = r;
      }),
    set: async () => {},
    clear: async () => {},
  });
  const pending = credentials.unlock();
  await credentials.clear();
  resolve("fixture");
  await pending;
  assert.equal(await credentials.get(), null);
  assert.equal(credentials.state, "locked");
});

test("failed save clears the session and never gets retried by reads", async () => {
  let writes = 0;
  const credentials = new SessionCredentials({
    get: async () => null,
    set: async () => {
      writes++;
      throw new Error("cancel");
    },
    clear: async () => {},
  });
  await assert.rejects(credentials.set("fixture"), /no automatic retry/);
  assert.equal(credentials.state, "failed");
  assert.equal(await credentials.get(), null);
  assert.equal(writes, 1);
});

test("disabled OS backend fails before Electron import, even with plaintext requested", async () => {
  const previous = process.env.STUDIO_DISABLE_OS_CREDENTIALS;
  process.env.STUDIO_DISABLE_OS_CREDENTIALS = "1";
  try {
    await assert.rejects(electronBackend(), /OS credential access is disabled/);
    await assert.rejects(SecretStore.open("/unused", { allowPlaintext: true }), /OS credential access is disabled/);
  } finally {
    if (previous === undefined) delete process.env.STUDIO_DISABLE_OS_CREDENTIALS;
    else process.env.STUDIO_DISABLE_OS_CREDENTIALS = previous;
  }
});

test("real Genex adapter status preserves saved ciphertext without opening OS storage", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "studio-locked-credentials-"));
  const previous = process.env.STUDIO_DISABLE_OS_CREDENTIALS;
  process.env.STUDIO_DISABLE_OS_CREDENTIALS = "1";
  try {
    await mkdir(path.join(dir, "credentials"));
    await writeFile(path.join(dir, "credentials/genex.bin"), "synthetic ciphertext");
    const genex = new GenexTools(dir);
    for (let i = 0; i < 3; i++) {
      const status = await genex.status();
      assert.equal(status.connected, false);
      assert.equal(status.credentialState, "locked");
    }
    await assert.rejects(genex.unlock(), /Automatic retries are paused/);
    assert.equal((await genex.status()).credentialState, "failed");
  } finally {
    if (previous === undefined) delete process.env.STUDIO_DISABLE_OS_CREDENTIALS;
    else process.env.STUDIO_DISABLE_OS_CREDENTIALS = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("device approval with a rejected credential save does not retry on status polling", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "studio-denied-save-"));
  let saves = 0,
    polls = 0;
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/cli/device/start")
      res.end(
        JSON.stringify({
          deviceCode: "fixture",
          userCode: "fixture",
          verifyUrl: "https://genex.games/activate",
          expiresIn: 600,
        }),
      );
    else {
      polls++;
      res.end(JSON.stringify({ status: "approved", token: "synthetic-token" }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const genex = new GenexTools(dir, `http://127.0.0.1:${(server.address() as { port: number }).port}`, {
      credentials: {
        get: async () => null,
        set: async () => {
          saves++;
          throw new Error("cancelled");
        },
        clear: async () => {},
      },
    });
    await genex.connect();
    await assert.rejects(genex.status(), /cancelled/);
    for (let i = 0; i < 3; i++) {
      const status = await genex.status();
      assert.equal(status.authorization, undefined);
      assert.equal(status.connected, false);
    }
    assert.equal(saves, 1);
    assert.equal(polls, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
