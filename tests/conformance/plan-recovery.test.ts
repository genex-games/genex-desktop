/**
 * A plan that could not be prepared says how to recover by its typed failure (`PlanReview.failure`),
 * never by reading its error's words: sign-in trouble asks to reconnect, a limit or an unavailable
 * model asks for another one, and anything else, or a record written before failures were kept, is
 * the plain Try again.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build, type Plugin } from "esbuild";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { PlanReviewState } from "../../src/shared/composer.ts";
import { EngineFailureKind } from "../../src/shared/engine-requests.ts";

/** Stand-ins for what reads the window's stores, which have no snapshot outside a window. */
const STAND_INS: Record<string, string> = {
  ChatQuestion: "export const AnswerKeyCaps = () => null; export const useAnswerKeys = () => undefined;",
  FileText: "export const FileText = ({ text }) => text;",
};
const windowless: Plugin = {
  name: "windowless",
  setup(plugin) {
    plugin.onResolve({ filter: /\/(chat\/ChatQuestion|ui\/FileText)\.tsx$/ }, (args) => ({
      path: args.path.replace(/^.*\/(\w+)\.tsx$/, "$1"),
      namespace: "stand-in",
    }));
    plugin.onLoad({ filter: /.*/, namespace: "stand-in" }, (args) => ({
      contents: STAND_INS[args.path],
      loader: "js",
    }));
  },
};

/** The plan card as the plain renderer build compiles it, and React's server renderer. */
async function planCard() {
  const result = await build({
    stdin: {
      contents: [
        'export { PlanQuestion } from "./src/renderer/chat/PlanQuestion.tsx";',
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
    plugins: [windowless],
    ...rendererBuildOptions(),
  });
  const code = result.outputFiles[0]?.text ?? "";
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

test("a failed plan's recovery follows its failure kind, and words alone decide nothing", async () => {
  const { PlanQuestion, createElement, renderToStaticMarkup } = await planCard();
  const card = (failure: EngineFailureKind | undefined, error: string): string =>
    renderToStaticMarkup(
      createElement(PlanQuestion, {
        review: { id: "review-1", state: PlanReviewState.Failed, text: "plan a rainy city", error, failure },
        busy: false,
        onAnswer: async () => undefined,
        onRevise: () => undefined,
      }),
    );
  assert.match(card(EngineFailureKind.Auth, "Request failed"), /Reconnect your model/);
  for (const failure of [EngineFailureKind.RateLimit, EngineFailureKind.UsageLimit, EngineFailureKind.Unavailable])
    assert.match(card(failure, "Request failed"), /This model is unavailable/, failure);
  assert.match(card(EngineFailureKind.Other, "Request failed"), /Couldn’t prepare the plan/);
  assert.match(
    card(undefined, "401 unauthorized: sign in again, your usage limit was reached"),
    /Couldn’t prepare the plan/,
    "a record with no failure is not read for sign-in or limit words",
  );
});
