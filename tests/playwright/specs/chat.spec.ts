import { expect, test } from "@playwright/test";
import { disposeStudio, launchStudio, PlaywrightFixture, waitForShell } from "../helpers/launch.ts";

test.describe("chat", () => {
  test("sends a prompt and renders the fixture engine reply offline", async () => {
    const session = await launchStudio({ fixture: PlaywrightFixture.AppBasics });
    try {
      await waitForShell(session.window);
      await session.window.locator('[data-game="fixture-game"]').click();
      const composer = session.window.locator("[data-chat-composer] [data-promptbar]");
      const prompt = composer.locator('textarea[aria-label="Prompt"]');
      await expect(prompt).toBeVisible();
      await prompt.fill("Say hello in one sentence.");
      await composer.locator('button[aria-label="Send"]').click();
      await expect(session.window.locator("[data-chat-transcript]")).toContainText(
        "I can build a small scene with a clear sense of place.",
        { timeout: 60_000 },
      );
    } finally {
      await disposeStudio(session);
    }
  });
});
