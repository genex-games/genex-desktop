/**
 * The app's Genex account: what it is, sign-in in the browser, cancel and sign-out
 * (`core/genex-account.ts`), and building with Genex's page in the browser.
 */
import { genexBuildPage } from "../../shared/genex-build.ts";
import type { GenexAccount } from "../core/genex-account.ts";
import type { IpcHandle } from "./registrar.ts";

/** What the account's channels answer from. */
export interface GenexAccountIpcDeps {
  account: GenexAccount;
  /** The website the build page is on: genex.games, or the one a development profile points Play at. */
  web: string;
}

/** Register the account's channels. Studio's own UI asks before it signs out; nothing here asks again. */
export function registerGenexAccountIpc(handle: IpcHandle, { account, web }: GenexAccountIpcDeps): void {
  handle("studio:genex-account.read", () => account.view());
  handle("studio:genex-account.sign-in", () => account.signIn());
  handle("studio:genex-account.cancel", () => account.cancel());
  handle("studio:genex-account.sign-out", () => account.signOut());
  handle("studio:genex-account.build", (payload) => {
    const idea = typeof payload?.idea === "string" ? payload.idea : undefined;
    return account.build((code) => genexBuildPage(web, { ...(code ? { code } : {}), ...(idea ? { idea } : {}) }));
  });
}
