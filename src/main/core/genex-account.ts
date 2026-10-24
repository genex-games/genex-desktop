/**
 * The app's Genex account in main: the one view the plate, Settings and Publish read, sign-in in the
 * browser, cancel, and sign-out (Studio's own UI asks first). It rides on the Genex plugin's account
 * (`pluginAccountPort`), which the registry keeps while Genex is off (`PluginRegistry.appAccount`),
 * or on a fixture launch's. Only genex.games refusing the token ends a sign-in (`refused`): going
 * offline never does. Electron-free; the browser comes in as a dep.
 */
import { GenexAccountStatus, type GenexAccountView } from "../../shared/genex-account.ts";
import { GENEX_PLUGIN_ID, GenexAction } from "../../shared/genex.ts";
import { PluginAccountState, type PluginInfo } from "../../shared/plugins.ts";
import type { PluginRegistry } from "../../substrate/plugins/registry.ts";

/** What the app's Genex account rides on: the Genex plugin's account, or a fixture launch's. */
export interface GenexAccountPort {
  /** The account's state, or undefined while no Genex is installed. */
  state(): Promise<PluginAccountState | undefined>;
  /** The account's token while it is signed in. */
  token(): Promise<string | undefined>;
  /** Start a browser sign-in: the page that finishes it and the code it shows (none when already signed in). */
  connect(): Promise<{ verifyUrl?: unknown; userCode?: unknown }>;
  /** Stop a sign-in under way. */
  cancel(): Promise<void>;
  /** Forget the account on this Mac. */
  disconnect(): Promise<void>;
  /** A sign-in this account started has finished: what the account rides on may turn on for it. */
  signedIn(): Promise<void>;
  /** Whether the signed-in account still has Genex's updated terms to accept; a port that cannot tell has none. */
  termsPending?(): Promise<boolean>;
}

export interface GenexAccountDeps {
  port: GenexAccountPort;
  /** Open the page that finishes a sign-in in the person's browser. */
  openSignIn(url: string): Promise<void>;
}

/** A signed-in account, with Genex's updated terms when they still wait for the person. */
async function signedInView(port: GenexAccountPort): Promise<GenexAccountView> {
  // An unanswered question about the terms is no reason to stop anyone: it reads as none pending.
  const termsPending = (await port.termsPending?.().catch(() => false)) === true;
  return { status: GenexAccountStatus.SignedIn, ...(termsPending ? { termsPending: true } : {}) };
}

/** The app's Genex account over `deps`. */
export function createGenexAccount(deps: GenexAccountDeps) {
  const { port } = deps;
  /** The token genex.games last refused: while it is the account's, the sign-in has ended. */
  let refusedToken: string | null = null;
  /** The code of the sign-in this account started, shown while it waits. */
  let code: string | undefined;
  /** The sign-in being started, which a second press joins instead of opening another page. */
  let starting: Promise<GenexAccountView> | null = null;
  /** Counts sign-ins and cancels: a sign-in started before the latest cancel opens nothing. */
  let attempt = 0;
  /** A sign-in this account started is waiting for the browser: once it is signed in, `signedIn` runs. */
  let awaiting = false;

  const view = async (): Promise<GenexAccountView> => {
    const state = await port.state();
    if (state === PluginAccountState.Authorizing)
      return code ? { status: GenexAccountStatus.SigningIn, code } : { status: GenexAccountStatus.SigningIn };
    code = undefined;
    const token = state === PluginAccountState.Unlocked ? await port.token() : undefined;
    const signedIn = Boolean(token) && token !== refusedToken;
    if (awaiting && signedIn) await port.signedIn();
    awaiting = false;
    if (!token) return { status: GenexAccountStatus.SignedOut };
    return signedIn ? signedInView(port) : { status: GenexAccountStatus.Ended };
  };

  /** Sign in in the browser; a refused token is forgotten first, or the sign-in would reuse it. */
  const startSignIn = async (): Promise<GenexAccountView> => {
    const mine = ++attempt;
    const token = await port.token();
    if (token && token === refusedToken) await port.disconnect();
    refusedToken = null;
    awaiting = true;
    const answer = await port.connect();
    // Cancelled while Genex was starting it: the sign-in Genex began after the cancel stops too.
    if (mine !== attempt) {
      await port.cancel();
      return view();
    }
    code = typeof answer.userCode === "string" ? answer.userCode : undefined;
    if (typeof answer.verifyUrl === "string") await deps.openSignIn(answer.verifyUrl);
    return view();
  };

  const signIn = (): Promise<GenexAccountView> => {
    starting ??= startSignIn().finally(() => {
      starting = null;
    });
    return starting;
  };

  const cancel = async (): Promise<GenexAccountView> => {
    attempt++;
    code = undefined;
    awaiting = false;
    await port.cancel();
    return view();
  };

  const signOut = async (): Promise<GenexAccountView> => {
    refusedToken = null;
    awaiting = false;
    await port.disconnect();
    return view();
  };

  return {
    view,
    signIn,
    cancel,
    signOut,
    /** The token Play's calls carry, while signed in. */
    token: (): Promise<string | undefined> => port.token(),
    /** genex.games answered 401 to `token`: the account reads as ended until it signs in again. */
    refused(token: string): void {
      refusedToken = token;
    },
  };
}

/** The app's Genex account as `createGenexAccount` makes it. */
export type GenexAccount = ReturnType<typeof createGenexAccount>;

/** What the plugin port reads and runs of the registry. */
type AccountRegistry = Pick<PluginRegistry, "accountState" | "hostCredential" | "action" | "enableForSignIn"> & {
  list(): Array<Pick<PluginInfo, "enabled" | "removed"> & { manifest: Pick<PluginInfo["manifest"], "id"> }>;
  restore(id: string): Promise<unknown>;
};

/**
 * The Genex plugin's account as the app's. Its actions run whether Genex is on or off; signing in
 * brings back a Genex that was removed (an older build let the person remove it), and once it
 * finishes turns Genex on, unless the person turned it off themselves (`enableForSignIn`).
 */
export function pluginAccountPort(plugins: AccountRegistry): GenexAccountPort {
  const installed = (): boolean => plugins.list().some((p) => p.manifest.id === GENEX_PLUGIN_ID && !p.removed);
  const run = async (name: GenexAction): Promise<void> => {
    if (installed()) await plugins.action(GENEX_PLUGIN_ID, name, {});
  };
  return {
    state: async () => (installed() ? plugins.accountState(GENEX_PLUGIN_ID) : undefined),
    token: () => plugins.hostCredential(GENEX_PLUGIN_ID),
    connect: async () => {
      if (!installed()) await plugins.restore(GENEX_PLUGIN_ID);
      const answer: unknown = await plugins.action(GENEX_PLUGIN_ID, GenexAction.Connect, {});
      return answer && typeof answer === "object" ? answer : {};
    },
    cancel: () => run(GenexAction.CancelConnect),
    disconnect: () => run(GenexAction.Disconnect),
    signedIn: async () => {
      await plugins.enableForSignIn(GENEX_PLUGIN_ID);
    },
    termsPending: async () => {
      if (!installed()) return false;
      const answer: unknown = await plugins.action(GENEX_PLUGIN_ID, GenexAction.TermsStatus, {});
      return isTermsAnswer(answer) && answer.pending === true;
    },
  };
}

/** The Genex plugin's `terms-status` answer. */
function isTermsAnswer(answer: unknown): answer is { pending: unknown } {
  return typeof answer === "object" && answer !== null && "pending" in answer;
}
