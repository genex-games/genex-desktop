/** The app's Genex account: what it is, sign-in in the browser, cancel and sign-out (`core/genex-account.ts`). */
import type { GenexAccount } from "../core/genex-account.ts";
import type { IpcHandle } from "./registrar.ts";

/** What the account's channels answer from. */
export interface GenexAccountIpcDeps {
  account: GenexAccount;
}

/** Register the account's channels. Studio's own UI asks before it signs out; nothing here asks again. */
export function registerGenexAccountIpc(handle: IpcHandle, { account }: GenexAccountIpcDeps): void {
  handle("studio:genex-account.read", () => account.view());
  handle("studio:genex-account.sign-in", () => account.signIn());
  handle("studio:genex-account.cancel", () => account.cancel());
  handle("studio:genex-account.sign-out", () => account.signOut());
}
