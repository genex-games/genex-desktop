import { expect, test } from "@playwright/test";
import {
  disposeStudio,
  launchStudio,
  PlaywrightFixture,
  stopStudio,
  type StudioSession,
  waitForShell,
} from "../helpers/launch.ts";

test.describe("settings persistence", () => {
  test("keeps the light appearance after a restart of the same profile", async () => {
    let session: StudioSession | undefined;
    session = await launchStudio({ fixture: PlaywrightFixture.AppBasics });
    try {
      await waitForShell(session.window);
      await session.window.getByRole("button", { name: "Settings", exact: true }).click();
      const dialog = session.window.getByTestId("settings-dialog");
      await expect(dialog).toBeVisible();
      await session.window.locator("#settings-tab-appearance").click();
      await session.window.locator('input[name="appearance-mode"][value="light"]').click();
      await expect(session.window.locator("html")).toHaveAttribute("data-theme", "light");
      await dialog.getByRole("button", { name: "Close" }).click();
      const owner = session.owner;
      await stopStudio(session);
      session = await launchStudio({ fixture: PlaywrightFixture.AppBasics, reuse: owner });
      await waitForShell(session.window);
      await expect(session.window.locator("html")).toHaveAttribute("data-theme", "light");
    } finally {
      if (session) await disposeStudio(session);
    }
  });
});
