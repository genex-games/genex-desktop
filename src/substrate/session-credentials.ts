import { secretStorageIssueOf } from "../shared/secret-storage.ts";

/** Whether this process holds the saved account's token. Reported to the renderer: never rename a value. */
export const CredentialState = {
  Locked: "locked",
  Unlocked: "unlocked",
  Failed: "failed",
} as const;
export type CredentialState = (typeof CredentialState)[keyof typeof CredentialState];

/** The longest token a restored lease may carry. */
const MAX_LEASE_TOKEN_CHARS = 65536;

const MESSAGE = {
  InvalidLease: "Invalid credential lease",
  UnlockFailed:
    "Saved account could not be unlocked. Automatic retries are paused; retry only when you want to allow credential access.",
  SaveFailed: "Credential save failed. Sign-in is stopped; no automatic retry will occur.",
  /** What a locked secret store adds: its own reason, such as the keyring to start. */
  UnlockRefused: (reason: string) => `Saved account could not be unlocked. ${reason} Automatic retries are paused.`,
  SaveRefused: (reason: string) => `Credential save failed. ${reason} Sign-in is stopped.`,
} as const;

/** Explicit host-UI unlock; background reads never open the OS credential store. */
export class SessionCredentials {
  #token: string | null = null;
  #epoch = 0;
  #pending: Promise<void> | undefined;
  /** The error a locked secret store earned, for the host to show in place of a backend's generic one. */
  #refusal: Error | null = null;
  state: CredentialState = CredentialState.Locked;
  private readonly storage: {
    get(): Promise<string | null>;
    set(token: string): Promise<void>;
    clear(): Promise<void>;
  };
  constructor(storage: SessionCredentials["storage"]) {
    this.storage = storage;
  }

  async get(): Promise<string | null> {
    return this.#token;
  }
  /** The token this process holds right now, without waiting: what the log redactor must know. */
  held(): string | null {
    return this.#token;
  }
  /** Restore a host-issued memory lease after backend restart; never reads/writes OS storage. */
  restore(token: string): void {
    if (!token || token.length > MAX_LEASE_TOKEN_CHARS) throw new Error(MESSAGE.InvalidLease);
    ++this.#epoch;
    this.#token = token;
    this.#refusal = null;
    this.state = CredentialState.Unlocked;
  }
  /** Why the last unlock or save was refused by a locked secret store, once; null for any other failure. */
  takeRefusal(): Error | null {
    const refusal = this.#refusal;
    this.#refusal = null;
    return refusal;
  }

  async unlock(): Promise<void> {
    if (this.#pending) return this.#pending;
    if (this.state === CredentialState.Unlocked) return;
    const epoch = this.#epoch;
    this.#pending = (async () => {
      try {
        const token = await this.storage.get();
        if (epoch !== this.#epoch) return;
        this.#token = token;
        this.#refusal = null;
        this.state = CredentialState.Unlocked;
      } catch (error) {
        if (epoch === this.#epoch) this.state = CredentialState.Failed;
        throw this.#failure(error, epoch, MESSAGE.UnlockRefused, MESSAGE.UnlockFailed);
      }
    })();
    try {
      await this.#pending;
    } finally {
      this.#pending = undefined;
    }
  }

  async set(token: string): Promise<void> {
    const epoch = ++this.#epoch;
    try {
      await this.storage.set(token);
    } catch (error) {
      if (epoch === this.#epoch) {
        this.#token = null;
        this.state = CredentialState.Failed;
      }
      throw this.#failure(error, epoch, MESSAGE.SaveRefused, MESSAGE.SaveFailed);
    }
    if (epoch !== this.#epoch) return;
    this.#token = token;
    this.#refusal = null;
    this.state = CredentialState.Unlocked;
  }

  /** The error to raise for a failed storage call: the store's own reason when it is locked, else `generic`. */
  #failure(cause: unknown, epoch: number, refused: (reason: string) => string, generic: string): Error {
    if (!(cause instanceof Error) || secretStorageIssueOf(cause) === null) return new Error(generic);
    const error = new Error(refused(cause.message));
    if (epoch === this.#epoch) this.#refusal = error;
    return error;
  }

  /** Revoke this process's lease without deleting the saved account. */
  lock(): void {
    ++this.#epoch;
    this.#token = null;
    this.#refusal = null;
    this.state = CredentialState.Locked;
  }

  async clear(): Promise<void> {
    this.lock();
    await this.storage.clear();
  }
}
