import { expect, test, type Page } from "@playwright/test";
import {
  allocateFixtureOwner,
  declaredPiCredentials,
  disposeStudio,
  launchStudio,
  PlaywrightFixture,
  waitForShell,
  writePiSignedOutUsage,
} from "../helpers/launch.ts";

async function openProviders(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByTestId("settings-dialog");
  await expect(dialog).toBeVisible();
  await page.locator("#settings-tab-providers").click();
  return dialog.locator('[data-provider-row="pi"]');
}

test.describe("provider setup", () => {
  test("first-launch welcome and Pi missing-CLI path render without network", async () => {
    const session = await launchStudio({ fixture: PlaywrightFixture.FirstLaunch });
    try {
      await waitForShell(session.window);
      const next = session.window.locator('[data-onboarding-action="next"]');
      await expect(next).toBeVisible();
      await next.click();
      await expect(session.window.locator('[data-onboarding-action="skip"]')).toBeVisible();
      await session.window.locator('[data-onboarding-action="skip"]').click();
      await expect(session.window.getByRole("button", { name: "Settings", exact: true })).toBeVisible();

      const pi = await openProviders(session.window);
      await expect(pi).toBeVisible();
      await expect(pi.getByText("Pi", { exact: true })).toBeVisible();
      await expect(pi.locator('[data-tone="off"]')).toContainText("Not installed");
      await expect(pi.getByRole("button", { name: "Install guide" })).toBeVisible();
      const declared = declaredPiCredentials();
      if (declared.present) {
        test.info().annotations.push({
          type: "credentials",
          description: `env present (${declared.names.join(", ")}); this spec still uses fixture engines and makes no provider calls`,
        });
      }
    } finally {
      await disposeStudio(session);
    }
  });

  test("signed-out Pi shows the sign-in control without calling a provider", async () => {
    const owner = allocateFixtureOwner(PlaywrightFixture.AppBasics);
    const usage = writePiSignedOutUsage(owner);
    const session = await launchStudio({
      fixture: PlaywrightFixture.AppBasics,
      reuse: owner,
      env: { STUDIO_FIXTURE_USAGE_FILE: usage },
    });
    try {
      await waitForShell(session.window);
      const pi = await openProviders(session.window);
      await expect(pi).toBeVisible();
      await expect(pi.locator('[data-tone="off"]')).toContainText("Not connected");
      await expect(pi.getByRole("button", { name: "Sign in" })).toBeVisible();
      await expect(pi.getByText("Open Pi and type /login to connect a provider.")).toBeVisible();
    } finally {
      await disposeStudio(session);
    }
  });
});
