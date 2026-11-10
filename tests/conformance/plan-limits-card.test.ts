/**
 * A plan's card in the composer's context and usage panel draws every limit the account reports:
 * the plan's own, then a model's own weekly limit (Fable's) when the plan meters that model.
 * Rendered from the plain renderer build with React's server renderer.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { normalizeClaudeUsage, type ProviderUsageReport, UsageState } from "../../src/shared/provider-usage.ts";
import { EngineId } from "../../src/shared/providers.ts";

/** The card's body as the plain renderer build compiles it, and React's server renderer. */
async function planCard() {
  const result = await build({
    stdin: {
      contents: [
        'export { PlanBody } from "./src/renderer/ui/ComposerLimits.tsx";',
        'export { createElement } from "react";',
        'export { renderToStaticMarkup } from "react-dom/server.edge";',
      ].join("\n"),
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "esm",
    jsx: "automatic",
    logLevel: "silent",
    platform: "browser",
    ...rendererBuildOptions(),
  });
  const code = result.outputFiles[0]?.text ?? "";
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

/** A Claude plan's report as main hands it over, from the account's own answer. */
const claudeReport = (rateLimits: Record<string, unknown>): ProviderUsageReport => ({
  engine: EngineId.ClaudeCode,
  state: UsageState.Ready,
  account: "terminal",
  usage: normalizeClaudeUsage({ subscription_type: "max", rate_limits_available: true, rate_limits: rateLimits }),
});

/** Each limit the card draws, in order: its name and the percent its meter shows. */
const drawnLimits = (html: string): string[] =>
  [...html.matchAll(/role="progressbar" aria-label="([^"]+)"[^>]*aria-valuenow="(\d+)"/g)].map(
    ([, name, percent]) => `${name} ${percent}%`,
  );

const WEEK = { utilization: 41, resets_at: "2026-11-10T16:00:00Z" };
const FIVE_HOURS = { utilization: 12, resets_at: "2026-11-10T12:00:00Z" };

// Fable has a weekly limit of its own on the Max plan: the card left it out, so a person at Fable's
// limit saw only "Weekly · all models" with room to spare.
test("a plan's card draws a model's own weekly limit after the plan's", async () => {
  const { PlanBody, createElement, renderToStaticMarkup } = await planCard();
  const report = claudeReport({
    five_hour: FIVE_HOURS,
    seven_day: WEEK,
    model_scoped: [{ display_name: "Fable", utilization: 63, resets_at: "2026-11-12T16:00:00Z" }],
  });
  const html: string = renderToStaticMarkup(createElement(PlanBody, { report, onRetry: () => {} }));
  assert.deepEqual(drawnLimits(html), ["5-hour limit 12%", "Weekly · all models 41%", "Weekly · Fable 63%"], html);
});

test("a plan that meters no model on its own draws only the plan's limits", async () => {
  const { PlanBody, createElement, renderToStaticMarkup } = await planCard();
  const report = claudeReport({ five_hour: FIVE_HOURS, seven_day: WEEK });
  const html: string = renderToStaticMarkup(createElement(PlanBody, { report, onRetry: () => {} }));
  assert.deepEqual(drawnLimits(html), ["5-hour limit 12%", "Weekly · all models 41%"], html);
});
