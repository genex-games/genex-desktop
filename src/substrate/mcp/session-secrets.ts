import type { McpConnector } from "../../shared/mcp.ts";
import { isCredentialName } from "../../shared/redact.ts";
import { McpSecretsLocked, secretKey, type SecretPort } from "./store.ts";
import { t } from "../../shared/i18n.ts";

/** What the person's own Connect reads when a lock overtook its unlock. */
const MESSAGE = {
  Cancelled: () => t("Connection cancelled"),
} as const;

const keysOf = (connector: McpConnector): string[] => [
  ...(connector.env ?? []).map((n) => secretKey(connector.id, "env", n)),
  ...(connector.headers ?? []).map((n) => secretKey(connector.id, "header", n)),
];

/** Values are unlocked once by Connect. Listing/discovery only uses the memory lease. */
export class McpSessionSecrets implements SecretPort {
  readonly storage: SecretPort;
  #values = new Map<string, string | null>();
  /** Keys the user cleared this session: absent on purpose, never read back from the store. */
  #cleared = new Set<string>();
  #epochs = new Map<string, number>();
  #pending = new Map<string, Promise<boolean>>();
  constructor(storage: SecretPort) {
    this.storage = storage;
  }
  get(key: string): Promise<string | null> {
    if (!this.#values.has(key)) return Promise.reject(new McpSecretsLocked());
    return Promise.resolve(this.#values.get(key) ?? null);
  }
  async set(key: string, value: string): Promise<void> {
    await this.storage.set(key, value);
    this.#values.set(key, value);
    this.#cleared.delete(key);
  }
  /** A value the user cleared is known to be absent: the lease holds that, rather than going back to locked. */
  async delete(key: string): Promise<void> {
    this.#values.delete(key);
    await this.storage.delete(key);
    this.#values.set(key, null);
    this.#cleared.add(key);
  }
  list(): Promise<string[]> {
    return this.storage.list();
  }
  /**
   * The credential values unlocked this session, for Studio's redactor and export check. Never
   * read from storage. A connector keeps its config in the store too (`BASE_URL`, `ALLOWED_DIR`);
   * only values under a credential name (`isCredentialName`) count, so a public URL is not one.
   */
  heldValues(): string[] {
    const values: string[] = [];
    for (const [key, value] of this.#values)
      if (typeof value === "string" && isCredentialName(key.slice(key.lastIndexOf(".") + 1))) values.push(value);
    return values;
  }
  lock(id: string): void {
    this.#epochs.set(id, (this.#epochs.get(id) ?? 0) + 1);
    for (const key of this.#values.keys()) if (key.startsWith(`mcp.${id}.`)) this.#values.delete(key);
    for (const key of this.#cleared) if (key.startsWith(`mcp.${id}.`)) this.#cleared.delete(key);
  }
  /** A declared env or header value of this connector has not been unlocked this session. */
  locked(connector: McpConnector): boolean {
    return keysOf(connector).some((key) => !this.#values.has(key));
  }
  /**
   * The values of `keys` the lease should ask the store for: any it does not hold, and any it
   * holds as unanswered (null) unless the user cleared it. A still-unanswered value is kept out.
   */
  async #readUnheld(keys: string[]): Promise<Map<string, string | null>> {
    const found = new Map<string, string | null>();
    for (const key of keys) {
      const held = this.#values.has(key);
      const settled = this.#values.get(key) !== null || this.#cleared.has(key);
      if (held && settled) continue;
      const value = await this.storage.get(key);
      if (!held || value !== null) found.set(key, value);
    }
    return found;
  }
  /**
   * Resolves true when it loaded a value the lease did not hold, so a process started before it is
   * stale. A value the store did not answer last time (a Keychain prompt dismissed) is asked for
   * again; one the user cleared is not.
   */
  async unlock(connector: McpConnector): Promise<boolean> {
    const id = connector.id;
    const existing = this.#pending.get(id);
    if (existing) return existing;
    const epoch = this.#epochs.get(id) ?? 0;
    const keys = keysOf(connector);
    const pending = (async () => {
      const found = await this.#readUnheld(keys);
      if ((this.#epochs.get(id) ?? 0) !== epoch) throw new Error(MESSAGE.Cancelled());
      for (const [key, value] of found) this.#values.set(key, value);
      return found.size > 0;
    })().finally(() => {
      if (this.#pending.get(id) === pending) this.#pending.delete(id);
    });
    this.#pending.set(id, pending);
    return pending;
  }
}
