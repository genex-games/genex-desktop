/**
 * A follow-up sent while the chat works waits below that work as Sending…: one no turn has taken yet
 * can be removed, one handed to the running turn no longer can.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build, type Plugin } from "esbuild";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { CHAT_WORDS } from "../../src/renderer/words.ts";

/**
 * The bubble reads the chat's file store, which has no snapshot outside a window, so it renders
 * as nothing here: these tests read the line under it.
 */
const bareBubble: Plugin = {
  name: "bare-bubble",
  setup(plugin) {
    plugin.onResolve({ filter: /\/chat\/UserMessage\.tsx$/ }, () => ({ path: "UserMessage", namespace: "bare" }));
    plugin.onLoad({ filter: /.*/, namespace: "bare" }, () => ({
      contents: "export const UserMessage = () => null;",
      loader: "js",
    }));
  },
};

/** The waiting messages as the plain renderer build compiles them, and React's server renderer. */
async function waitingMessages() {
  const result = await build({
    stdin: {
      contents: [
        'export { QueuedMessage, SendingMessage } from "./src/renderer/panels/QueuedMessage.tsx";',
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
    plugins: [bareBubble],
    ...rendererBuildOptions(),
  });
  const code = result.outputFiles[0]?.text ?? "";
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

/** The line under a message: its markup inside the message's own element. */
const lineOf = (markup: string): string => markup.replace(/^<div[^>]*>/, "").replace(/<\/div>$/, "");

test("a waiting follow-up reads Sending…, offers Remove until a turn takes it, and keeps the line of a message on its way", async () => {
  const { QueuedMessage, SendingMessage, createElement, renderToStaticMarkup } = await waitingMessages();
  const props = { threadId: "chat-a", messageId: "m1", text: "and add rain", onNotice: () => {} };
  const waiting: string = renderToStaticMarkup(createElement(QueuedMessage, props));
  assert.match(waiting, /^<div data-queued-message="m1"/, "smoke runners still find it by its message");
  assert.match(waiting, new RegExp(`<span role="status">${CHAT_WORDS.sendingMessage}</span>`));
  assert.doesNotMatch(waiting, /Queued/);
  assert.match(waiting, /aria-label="Remove queued message"/, "one no turn took yet can be withdrawn");
  const handed: string = renderToStaticMarkup(createElement(QueuedMessage, { ...props, sending: true }));
  assert.match(handed, new RegExp(`<span role="status">${CHAT_WORDS.sendingMessage}</span>`));
  assert.doesNotMatch(handed, /<button/, "handed to the running turn: nothing to withdraw");
  const onItsWay: string = renderToStaticMarkup(createElement(SendingMessage, { text: "and add rain" }));
  assert.equal(lineOf(handed), lineOf(onItsWay), "nothing moves when a message on its way starts to wait");
});
