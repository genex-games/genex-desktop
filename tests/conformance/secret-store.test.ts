/**
 * The secret store keeps a value only where the operating system encrypts it. On Linux, Electron's
 * safeStorage answers "available" even with no keyring, encrypting under a fixed key anyone can
 * read (`basic_text`); the store treats that as locked, names why, and writes nothing.
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { SecretStorageIssue } from "../../src/shared/secret-storage.ts";
import type { McpConnector } from "../../src/shared/mcp.ts";
import { McpRegistry } from "../../src/substrate/mcp/registry.ts";
import { McpSessionSecrets } from "../../src/substrate/mcp/session-secrets.ts";
import { materializeSecrets, mcpSecretPort, secretKey, storedSecretFields } from "../../src/substrate/mcp/store.ts";
import { CredentialState, SessionCredentials } from "../../src/substrate/session-credentials.ts";
import {
  SecretStorageUnavailableError,
  SecretStore,
  type SafeStorage,
  safeStorageBackend,
} from "../../src/substrate/secrets.ts";

// Every encryption backend below is a stand-in; the one default-backend call explicitly
// tests the process gate before Electron is imported. Ambient fixture isolation must not
// replace the fake backend's own NoKeyring/EncryptionUnavailable answers.
const previousOsCredentials = process.env.STUDIO_DISABLE_OS_CREDENTIALS;
before(() => {
  delete process.env.STUDIO_DISABLE_OS_CREDENTIALS;
});
after(() => {
  if (previousOsCredentials === undefined) delete process.env.STUDIO_DISABLE_OS_CREDENTIALS;
  else process.env.STUDIO_DISABLE_OS_CREDENTIALS = previousOsCredentials;
});

/** A stand-in for Electron's safeStorage: reversible "encryption", and the Linux backend it reports. */
function fakeSafeStorage(options: { available?: boolean; backend?: string } = {}): SafeStorage {
  return {
    isEncryptionAvailable: () => options.available ?? true,
    encryptString: (text) => Buffer.from(`enc:${text}`, "utf8"),
    decryptString: (data) => data.toString("utf8").replace(/^enc:/, ""),
    ...(options.backend === undefined ? {} : { getSelectedStorageBackend: () => options.backend as never }),
  };
}

async function emptyDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "studio-secret-store-"));
}

/** Does `promise` reject with the typed error for `issue`? */
async function rejectsWith(promise: Promise<unknown>, issue: SecretStorageIssue): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof SecretStorageUnavailableError, String(error));
    assert.equal(error.issue, issue);
    return true;
  });
}

describe("secret store backends", () => {
  it("refuses to open over Linux's basic_text store, and writes nothing", async () => {
    const dir = await emptyDir();
    const backend = safeStorageBackend(fakeSafeStorage({ backend: "basic_text" }));
    await rejectsWith(SecretStore.open(dir, { backend }), SecretStorageIssue.NoKeyring);
    assert.deepEqual(await readdir(dir), []);
  });

  it("reports NoKeyring, not EncryptionUnavailable, when a selected Linux backend cannot start", async () => {
    const backend = safeStorageBackend(fakeSafeStorage({ backend: "gnome_libsecret", available: false }));
    const dir = await emptyDir();
    await rejectsWith(SecretStore.open(dir, { backend }), SecretStorageIssue.NoKeyring);
    await rejectsWith(
      SecretStore.open(await emptyDir(), { backend, allowPlaintext: true }),
      SecretStorageIssue.NoKeyring,
    );
    assert.deepEqual(await readdir(dir), []);
  });

  it("tells a person with no usable keyring what to do, in the app's name", () => {
    const { message } = new SecretStorageUnavailableError(SecretStorageIssue.NoKeyring);
    assert.match(message, /No unlocked system keyring is available/);
    assert.match(message, /Start GNOME Keyring or KWallet and unlock it, then restart Genex\./);
    assert.doesNotMatch(message, /Studio/);
  });

  it("refuses basic_text even when the caller would accept plaintext", async () => {
    const backend = safeStorageBackend(fakeSafeStorage({ backend: "basic_text" }));
    await rejectsWith(
      SecretStore.open(await emptyDir(), { backend, allowPlaintext: true }),
      SecretStorageIssue.NoKeyring,
    );
  });

  it("a store built over basic_text directly still refuses to set", async () => {
    const dir = await emptyDir();
    const store = new SecretStore({ dir, backend: safeStorageBackend(fakeSafeStorage({ backend: "basic_text" })) });
    await rejectsWith(store.set("token", "value"), SecretStorageIssue.NoKeyring);
    assert.deepEqual(await readdir(dir), []);
  });

  for (const backend of ["gnome_libsecret", "kwallet5", undefined]) {
    it(`keeps secrets with ${backend ?? "no Linux backend (macOS, Windows)"}`, async () => {
      const store = await SecretStore.open(await emptyDir(), {
        backend: safeStorageBackend(fakeSafeStorage({ backend })),
      });
      await store.set("token", "value");
      assert.equal(await store.get("token"), "value");
      assert.equal(store.encrypted, true);
    });
  }

  it("names missing OS encryption", async () => {
    const backend = safeStorageBackend(fakeSafeStorage({ available: false }));
    await rejectsWith(SecretStore.open(await emptyDir(), { backend }), SecretStorageIssue.EncryptionUnavailable);
  });

  it("names a process barred from the OS key store", async () => {
    const previous = process.env.STUDIO_DISABLE_OS_CREDENTIALS;
    process.env.STUDIO_DISABLE_OS_CREDENTIALS = "1";
    try {
      await rejectsWith(SecretStore.open(await emptyDir()), SecretStorageIssue.OsCredentialsDisabled);
    } finally {
      if (previous === undefined) delete process.env.STUDIO_DISABLE_OS_CREDENTIALS;
      else process.env.STUDIO_DISABLE_OS_CREDENTIALS = previous;
    }
  });
});

/**
 * Electron's safeStorage keeps its key in a Keychain item named after the app, so after the rename
 * to Genex every secret saved by "AI Game Studio" is under a key this app does not hold. Such a
 * value is missing (the account or connector needs reconnecting), never a crash or a wrong value.
 */
describe("a secret saved under another app's key reads as missing", () => {
  /** The safeStorage of an app whose key is not the one the files were encrypted with. */
  const otherKey = (decrypted: () => string): SafeStorage => ({
    ...fakeSafeStorage(),
    decryptString: () => decrypted(),
  });
  const refusesToDecrypt = otherKey(() => {
    throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
  });
  /** What survives a wrong key's padding check by chance: bytes that are not the stored text. */
  const decryptsToGarbage = otherKey(() => "�\u0003�x�");

  async function savedByTheOldApp(key: string, value: string): Promise<string> {
    const dir = await emptyDir();
    const old = await SecretStore.open(dir, { backend: safeStorageBackend(fakeSafeStorage()) });
    await old.set(key, value);
    return dir;
  }

  for (const [name, safeStorage] of [
    ["a decrypt that throws", refusesToDecrypt],
    ["a decrypt that yields garbage", decryptsToGarbage],
  ] as const) {
    it(`${name} is a missing value, and a new value replaces it`, async () => {
      const dir = await savedByTheOldApp("genex", "TOKEN");
      const store = await SecretStore.open(dir, { backend: safeStorageBackend(safeStorage) });
      assert.equal(await store.get("genex"), null);
      const fresh = await SecretStore.open(dir, { backend: safeStorageBackend(fakeSafeStorage()) });
      await fresh.set("genex", "NEW");
      assert.equal(await fresh.get("genex"), "NEW");
    });
  }

  it("a store that is locked right now stays locked rather than reading as missing", async () => {
    const dir = await savedByTheOldApp("genex", "TOKEN");
    let available = true;
    const store = await SecretStore.open(dir, {
      backend: safeStorageBackend({ ...refusesToDecrypt, isEncryptionAvailable: () => available }),
    });
    available = false;
    await rejectsWith(store.get("genex"), SecretStorageIssue.EncryptionUnavailable);
  });

  it("the Genex account unlocks signed out, so it asks to sign in again instead of failing", async () => {
    const dir = await savedByTheOldApp("genex", "TOKEN");
    const store = await SecretStore.open(dir, { backend: safeStorageBackend(refusesToDecrypt) });
    const credentials = new SessionCredentials({
      get: () => store.get("genex"),
      set: (token) => store.set("genex", token),
      clear: () => store.delete("genex"),
    });
    await credentials.unlock();
    assert.equal(credentials.state, CredentialState.Unlocked);
    assert.equal(await credentials.get(), null);
  });

  it("an MCP connector's saved value is absent, so the connector shows it as not set", async () => {
    const connector: McpConnector = {
      id: "echo",
      name: "Echo",
      transport: "stdio",
      command: "echo",
      env: ["API_KEY"],
      enabled: true,
      scope: "global",
      toolPolicy: {},
      createdAt: new Date(0).toISOString(),
    };
    const dir = await savedByTheOldApp(secretKey("echo", "env", "API_KEY"), "KEY");
    const store = await SecretStore.open(dir, { backend: safeStorageBackend(refusesToDecrypt) });
    const port = new McpSessionSecrets(store);
    await port.unlock(connector);
    assert.deepEqual(await materializeSecrets(port, connector, "env"), {});
    assert.deepEqual(await storedSecretFields(store, connector), []);
  });
});

describe("connectors say why secrets cannot be stored", () => {
  it("the MCP port answers the issue instead of a store", async () => {
    // Plain Node has no Electron safeStorage: the store is locked for want of OS encryption.
    const opened = await mcpSecretPort(await emptyDir());
    assert.equal(opened.port, null);
    assert.equal(opened.locked, SecretStorageIssue.EncryptionUnavailable);
  });

  it("every connector view carries the issue", async () => {
    const root = await emptyDir();
    const registry = new McpRegistry({
      file: path.join(root, "connectors.json"),
      secrets: null,
      secretsLocked: SecretStorageIssue.NoKeyring,
    });
    await registry.init();
    const view = await registry.save({
      id: "echo",
      name: "Echo",
      transport: "http",
      url: "https://example.test/mcp",
      enabled: false,
      scope: "global",
      toolPolicy: {},
      createdAt: new Date().toISOString(),
    });
    assert.equal(view.secretsAvailable, false);
    assert.equal(view.secretsLocked, SecretStorageIssue.NoKeyring);
    await registry.close();
  });
});
