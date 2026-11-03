import { expect, test } from "@playwright/test";
import {
  disposeStudio,
  fatalRendererProblems,
  launchStudio,
  PlaywrightFixture,
  waitForShell,
} from "../helpers/launch.ts";

test.describe("app launch", () => {
  test("opens the main window without fatal renderer errors", async () => {
    const session = await launchStudio({ fixture: PlaywrightFixture.AppBasics });
    try {
      await waitForShell(session.window);
      await expect(session.window.locator('[data-game="fixture-game"]')).toBeVisible();
      await expect(session.window.locator("[data-chat-composer] [data-promptbar]")).toBeVisible();
      expect(fatalRendererProblems(session), fatalRendererProblems(session).join("\n")).toEqual([]);
    } finally {
      await disposeStudio(session);
    }
  });
});
