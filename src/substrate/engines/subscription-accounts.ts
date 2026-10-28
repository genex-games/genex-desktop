/**
 * The accounts a subscription CLI (Claude Code, Codex) can run on: the person's Terminal login,
 * Studio's own first login, and any further accounts added in Settings, each with a home of its
 * own so one sign-in never replaces another. Which one runs is a choice kept beside the added
 * homes; until somebody chooses, the engines keep their old order (Studio's own, then Terminal).
 * Presence checks only: no credential is ever opened here.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { atomicWriteText, ensureDir, readJsonIfExists } from "../fsx.ts";
import { t } from "../../shared/i18n.ts";

/** The two accounts every subscription can have, by their fixed ids; added ones are `account-N`. */
export const AccountId = {
  /** The CLI's own login, as used in Terminal. */
  Terminal: "terminal",
  /** Studio's first login of its own (the engine's `engineHome`). */
  Studio: "studio",
} as const;
export type AccountId = (typeof AccountId)[keyof typeof AccountId];

/** An added account's id: `account-2` up to `account-999`. */
const ADDED_ID = /^account-([2-9]|[1-9]\d{1,2})$/;
const ADDED_PREFIX = "account-";
/** The first number an added account takes: Studio's own login is the first. */
const FIRST_ADDED = 2;
/** More added accounts than anyone keeps; the search for a free home stops here. */
const MAX_ADDED = 999;
const CHOICE_FILE = "accounts.json";

/** Why Settings' account change is refused, in the person's language. */
const MESSAGE = {
  unknown: (id: string) => t("No such account: {account}", { account: JSON.stringify(id.slice(0, 40)) }),
  full: () => t("Too many accounts."),
} as const;

/** What the choice file keeps: the account in use and the accounts added, with their emails. */
interface AccountsFile {
  chosen?: string;
  accounts?: Array<{ id: string; email?: string }>;
}

/** One account as Settings lists it. */
export interface AccountEntry {
  id: string;
  home: string;
  email: string | null;
  terminal: boolean;
  signedIn: boolean;
  active: boolean;
}

export interface SubscriptionAccountsOptions {
  /** The CLI's own home: the Terminal login. */
  systemHome: string;
  /** Studio's first own home. */
  studioHome: string;
  /** Where added accounts' homes and the choice file live. */
  root: string;
  /** Whether a home holds a sign-in (presence only). */
  signedIn(home: string): Promise<boolean>;
}

/** Where an engine's added accounts live by default: `accounts/<engine>` beside its first home. */
export function accountsRoot(engineHome: string, engineId: string): string {
  return path.join(path.dirname(engineHome), "accounts", engineId);
}

/** Whether `id` names an account at all: one of the two fixed ones, or an added one. */
function isAccountId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  return id === AccountId.Terminal || id === AccountId.Studio || ADDED_ID.test(id);
}

export class SubscriptionAccounts {
  readonly #options: SubscriptionAccountsOptions;
  /**
   * The last change to the choice file. Each change reads the file and writes it whole, so two at
   * once would lose one: an email kept while the account is forgotten brought the account back.
   */
  #changes: Promise<unknown> = Promise.resolve();

  constructor(options: SubscriptionAccountsOptions) {
    this.#options = options;
  }

  /** The home an account signs in to, or null for an id that is no account's. */
  homeFor(id: string): string | null {
    if (!isAccountId(id)) return null;
    if (id === AccountId.Terminal) return this.#options.systemHome;
    if (id === AccountId.Studio) return this.#options.studioHome;
    return path.join(this.#options.root, id);
  }

  /** The account a home belongs to, or null for a home that is none of them. */
  idFor(home: string | null): string | null {
    if (!home) return null;
    const resolved = path.resolve(home);
    if (resolved === path.resolve(this.#options.systemHome)) return AccountId.Terminal;
    if (resolved === path.resolve(this.#options.studioHome)) return AccountId.Studio;
    const id = path.relative(path.resolve(this.#options.root), resolved);
    return ADDED_ID.test(id) ? id : null;
  }

  /** The account the person chose, or null while nobody has (or the choice cannot be read). */
  async chosen(): Promise<string | null> {
    const chosen = (await this.#read()).chosen;
    return isAccountId(chosen) ? chosen : null;
  }

  /**
   * Every account Studio knows: the Terminal login when it holds a sign-in, Studio's own when it
   * does or was remembered, and each added one that finished signing in once.
   */
  async list(): Promise<AccountEntry[]> {
    const file = await this.#read();
    const remembered = new Map((file.accounts ?? []).filter((a) => isAccountId(a?.id)).map((a) => [a.id, a]));
    const ids: string[] = [];
    if (await this.#options.signedIn(this.#options.systemHome)) ids.push(AccountId.Terminal);
    if (remembered.has(AccountId.Studio) || (await this.#options.signedIn(this.#options.studioHome)))
      ids.push(AccountId.Studio);
    for (const id of remembered.keys()) if (ADDED_ID.test(id)) ids.push(id);
    const entries = await Promise.all(ids.map((id) => this.#entry(id, remembered.get(id)?.email)));
    const active = (await this.chosen()) ?? entries.find((entry) => !entry.terminal && entry.signedIn)?.id;
    const inUse = active ?? entries.find((entry) => entry.signedIn)?.id;
    return entries.map((entry) => ({ ...entry, active: entry.id === inUse }));
  }

  async #entry(id: string, email: string | undefined): Promise<AccountEntry> {
    const home = this.homeFor(id) ?? "";
    return {
      id,
      home,
      email: email ?? null,
      terminal: id === AccountId.Terminal,
      signedIn: await this.#options.signedIn(home),
      active: false,
    };
  }

  /** Run on `id` from now on. Refused for an id no account stands behind. */
  async choose(id: string): Promise<void> {
    if (!isAccountId(id)) throw new Error(MESSAGE.unknown(String(id)));
    await this.#change(async () => {
      const known = (await this.list()).some((entry) => entry.id === id);
      if (!known) throw new Error(MESSAGE.unknown(id));
      await this.#write({ ...(await this.#read()), chosen: id });
    });
  }

  /**
   * A home for one more account, not yet listed: the first added id nobody remembers. A home left
   * by a sign-in that never finished is emptied, so its leftovers never sign anybody in.
   */
  newAccount(): Promise<{ id: string; home: string }> {
    return this.#change(() => this.#newAccount());
  }

  async #newAccount(): Promise<{ id: string; home: string }> {
    const remembered = new Set((await this.#read()).accounts?.map((account) => account.id));
    for (let n = FIRST_ADDED; n <= MAX_ADDED; n++) {
      const id = `${ADDED_PREFIX}${n}`;
      if (remembered.has(id)) continue;
      const home = path.join(this.#options.root, id);
      await rm(home, { recursive: true, force: true });
      await ensureDir(home);
      return { id, home };
    }
    throw new Error(MESSAGE.full());
  }

  /**
   * Keep an account that signed in, with the email its CLI told now. One that told none keeps no
   * email: the person signed in may not be the one an earlier email named.
   */
  async remember(id: string, details: { email?: string | null }): Promise<void> {
    // The Terminal login is the CLI's own: Studio lists it whenever it holds a sign-in.
    if (id === AccountId.Terminal) return;
    if (!isAccountId(id)) throw new Error(MESSAGE.unknown(String(id)));
    const { email } = details;
    await this.#change(async () => {
      const file = await this.#read();
      const others = (file.accounts ?? []).filter((account) => account.id !== id);
      await this.#write({ ...file, accounts: [...others, { id, ...(email ? { email } : {}) }] });
    });
  }

  /** Drop an account from the list; a choice of it goes too. Its home is the caller's to clear. */
  async forget(id: string): Promise<void> {
    if (!isAccountId(id)) throw new Error(MESSAGE.unknown(String(id)));
    await this.#change(async () => {
      const file = await this.#read();
      const accounts = (file.accounts ?? []).filter((account) => account.id !== id);
      const { chosen, ...rest } = file;
      await this.#write({ ...rest, accounts, ...(chosen && chosen !== id ? { chosen } : {}) });
    });
  }

  /** Run `change` once every change asked before it has finished, whether or not those failed. */
  #change<T>(change: () => Promise<T>): Promise<T> {
    const next = this.#changes.then(change, change);
    this.#changes = next.catch(() => {});
    return next;
  }

  async #read(): Promise<AccountsFile> {
    const file = await readJsonIfExists<AccountsFile>(path.join(this.#options.root, CHOICE_FILE)).catch(() => null);
    return file && typeof file === "object" ? file : {};
  }

  async #write(file: AccountsFile): Promise<void> {
    await atomicWriteText(path.join(this.#options.root, CHOICE_FILE), `${JSON.stringify(file, null, 2)}\n`, {
      mode: 0o600,
    });
  }
}
