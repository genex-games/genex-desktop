/**
 * Genex's pages in the person's real browser: a sign-in to finish, the terms, a game's page. Only an
 * https address opens (or, in a development profile, a page of the website it points Play at),
 * tagged `s=desktop` with its code kept, and a fixture launch opens none.
 */
import { shell } from "electron";
import { PLAY_ORIGIN } from "../shared/play.ts";
import { assertNativeActionAllowed } from "./dev/native-policy.ts";
import { genexPageAddress } from "./play/origins.ts";

/**
 * Open `address` in the browser, unless this is a fixture launch (which throws instead). `web` is
 * the website Play links to: a page of it opens as it is, even a development one's plain http.
 */
export async function openGenexPage(
  fixtureNativePolicy: boolean,
  address: string,
  web: string = PLAY_ORIGIN.web,
): Promise<void> {
  assertNativeActionAllowed(fixtureNativePolicy, "studio:open-url");
  await shell.openExternal(genexPageAddress(address, web));
}
