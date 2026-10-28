/**
 * Building with Genex in the chat (`renderer/genex-build.ts`, `ui/GenexNotice.tsx`): what a Genex
 * model still needs before a message can go, read from its engine's status; the blue notice's line
 * and main step for each; the person's own Claude and ChatGPT plans as the other way; and the
 * notice as the chat draws it, over a held first message and above the composer. Rendered from the
 * plain renderer build with React's server renderer.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { build } from "esbuild";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { EngineStatusCode, EngineStatusReason, type EngineStatus } from "../../src/shared/engine-descriptor.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { GenexNeed, genexNeed, genexNoticeWords, planActions } from "../../src/renderer/genex-build.ts";

const genex = (status: EngineStatus) => ({ id: EngineId.Genex, status });
const QUIET = { held: false, waiting: false, installing: false };

describe("what a Genex model needs before a send", () => {
  it("reads the engine's status, and nothing for a ready, hidden or other engine", () => {
    const rows: Array<[string, EngineStatus, GenexNeed | null]> = [
      ["ready", { code: EngineStatusCode.Ready, detail: "" }, null],
      ["not offered", { code: EngineStatusCode.NotInstalled, detail: "", reason: EngineStatusReason.NotOffered }, null],
      [
        "signed out",
        { code: EngineStatusCode.NeedsLogin, detail: "", reason: EngineStatusReason.NotSignedIn },
        GenexNeed.SignIn,
      ],
      [
        "no plan",
        { code: EngineStatusCode.NeedsLogin, detail: "", reason: EngineStatusReason.NeedsPlan },
        GenexNeed.Plan,
      ],
      [
        "unverified",
        { code: EngineStatusCode.NeedsLogin, detail: "", reason: EngineStatusReason.VerifyEmail },
        GenexNeed.VerifyEmail,
      ],
      [
        "no credits",
        { code: EngineStatusCode.NeedsLogin, detail: "", reason: EngineStatusReason.OutOfCredits },
        GenexNeed.OutOfCredits,
      ],
      [
        "paused",
        { code: EngineStatusCode.NeedsLogin, detail: "", reason: EngineStatusReason.Paused },
        GenexNeed.Paused,
      ],
      [
        "no Claude Code",
        { code: EngineStatusCode.NotInstalled, detail: "", reason: EngineStatusReason.CliMissing },
        GenexNeed.Setup,
      ],
      [
        "no answer",
        { code: EngineStatusCode.Error, detail: "", reason: EngineStatusReason.CheckFailed },
        GenexNeed.Unreachable,
      ],
      ["a sign-in with no reason", { code: EngineStatusCode.NeedsLogin, detail: "" }, GenexNeed.SignIn],
    ];
    for (const [name, status, need] of rows) assert.equal(genexNeed(genex(status)), need, name);
    const signedOut = { code: EngineStatusCode.NeedsLogin, detail: "", reason: EngineStatusReason.NotSignedIn };
    assert.equal(genexNeed({ id: EngineId.ClaudeCode, status: signedOut }), null, "Claude's own sign-in is its card's");
    assert.equal(genexNeed(undefined), null);
  });
});

describe("the Genex notice's words", () => {
  it("names what is missing, and the one step that gets it", () => {
    assert.deepEqual(genexNoticeWords(GenexNeed.SignIn, QUIET), {
      line: "Sign in to Genex and pick Pro or a credit pack to start building.",
      primary: "Continue in browser",
    });
    assert.equal(genexNoticeWords(GenexNeed.Plan, QUIET).primary, "Continue in browser");
    assert.equal(genexNoticeWords(GenexNeed.VerifyEmail, QUIET).primary, "Continue in browser");
    assert.deepEqual(genexNoticeWords(GenexNeed.OutOfCredits, QUIET), {
      line: "You’re out of Genex credits. Everything so far is saved.",
      primary: "Get credits",
    });
    assert.equal(genexNoticeWords(GenexNeed.Paused, QUIET).primary, null, "nothing to press while paused");
    assert.equal(genexNoticeWords(GenexNeed.Setup, QUIET).primary, "Set up");
    assert.equal(genexNoticeWords(GenexNeed.Setup, { ...QUIET, installing: true }).primary, null);
    assert.equal(genexNoticeWords(GenexNeed.Unreachable, QUIET).primary, "Try again");
  });

  it("says a first message waits, and that the browser step is under way", () => {
    assert.equal(
      genexNoticeWords(GenexNeed.SignIn, { ...QUIET, held: true }).line,
      "Sign in to Genex and pick Pro or a credit pack to start building. Your idea waits here.",
    );
    assert.equal(
      genexNoticeWords(GenexNeed.OutOfCredits, { ...QUIET, held: true }).line,
      "You’re out of Genex credits. Your idea waits here.",
    );
    const waiting = genexNoticeWords(GenexNeed.SignIn, { ...QUIET, held: true, waiting: true });
    assert.equal(waiting.line, "Finish on genex.games in your browser. Your idea waits here.");
    assert.equal(waiting.primary, "Continue in browser", "the page can be opened again");
  });

  it("never says Genex AI", () => {
    for (const need of Object.values(GenexNeed))
      for (const held of [false, true])
        assert.doesNotMatch(JSON.stringify(genexNoticeWords(need, { ...QUIET, held })), /Genex AI/, need);
  });
});

describe("the person's own plans on the notice", () => {
  const plans = (claude: boolean, codex: boolean) => [
    { engine: EngineId.ClaudeCode, ready: claude },
    { engine: EngineId.Codex, ready: codex },
  ];

  it("offers a connected Claude plan beside Get credits, and nothing else", () => {
    assert.deepEqual(planActions(GenexNeed.OutOfCredits, plans(true, false)), {
      tint: { engine: EngineId.ClaudeCode, label: "Continue on Claude plan" },
      links: [],
    });
    assert.deepEqual(planActions(GenexNeed.Paused, plans(false, true)).tint, {
      engine: EngineId.Codex,
      label: "Continue on ChatGPT plan",
    });
  });

  it("names each agent as a quiet link otherwise", () => {
    assert.deepEqual(planActions(GenexNeed.SignIn, plans(false, false)), {
      tint: null,
      links: [
        { engine: EngineId.ClaudeCode, label: "Connect Claude Code" },
        { engine: EngineId.Codex, label: "Connect Codex" },
      ],
    });
    assert.deepEqual(
      planActions(GenexNeed.SignIn, plans(true, false)).links.map((link) => link.label),
      ["Continue on Claude plan", "Connect Codex"],
    );
    assert.equal(planActions(GenexNeed.OutOfCredits, plans(false, false)).links.length, 2);
  });
});

/** The notice and the held block as the renderer build compiles them, and React's server renderer. */
async function views() {
  const result = await build({
    stdin: {
      contents: [
        'export { GenexNotice } from "./src/renderer/ui/GenexNotice.tsx";',
        'export { HeldFirstMessage } from "./src/renderer/chat/HeldFirstMessage.tsx";',
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
    plugins: [
      {
        name: "no-studio",
        setup(on) {
          on.onResolve({ filter: /\/App\.tsx$/ }, () => ({ path: "app", namespace: "no-studio" }));
          on.onLoad({ filter: /.*/, namespace: "no-studio" }, () => ({
            contents: "export function App() { return null; }",
            loader: "js",
          }));
        },
      },
    ],
  });
  const code = result.outputFiles[0]?.text ?? "";
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

describe("the Genex notice in the chat", () => {
  const notice = {
    need: GenexNeed.SignIn,
    waiting: false,
    installing: false,
    problem: null,
    plans: [
      { engine: EngineId.ClaudeCode, ready: false },
      { engine: EngineId.Codex, ready: false },
    ],
    onPrimary: () => {},
    onUse: () => {},
  };

  it("draws Genex's mark, its line, Continue in browser and both agents", async () => {
    const { GenexNotice, createElement, renderToStaticMarkup } = await views();
    const html: string = renderToStaticMarkup(createElement(GenexNotice, notice));
    assert.match(html, /data-genex-notice="sign_in"/);
    assert.match(html, /aria-label="Genex"/);
    assert.match(html, /Sign in to Genex and pick Pro or a credit pack to start building\.</);
    assert.match(html, /data-genex-action="primary"[^>]*>Continue in browser</);
    assert.match(html, /data-genex-action="claude-code"[^>]*>Connect Claude Code</);
    assert.match(html, /data-genex-action="codex"[^>]*>Connect Codex</);
  });

  it("says over a held first message that it waits, and while the person is in the browser, that it waits for them", async () => {
    const { GenexNotice, createElement, renderToStaticMarkup } = await views();
    const held: string = renderToStaticMarkup(createElement(GenexNotice, { ...notice, held: true }));
    assert.match(held, /start building\. Your idea waits here\.</);
    const waiting: string = renderToStaticMarkup(createElement(GenexNotice, { ...notice, held: true, waiting: true }));
    assert.match(waiting, /Finish on genex\.games in your browser\. Your idea waits here\.</);
  });

  it("offers Get credits and the connected Claude plan once the credits run out", async () => {
    const { GenexNotice, createElement, renderToStaticMarkup } = await views();
    const plans = [
      { engine: EngineId.ClaudeCode, ready: true },
      { engine: EngineId.Codex, ready: false },
    ];
    const html: string = renderToStaticMarkup(
      createElement(GenexNotice, {
        ...notice,
        need: GenexNeed.OutOfCredits,
        plans,
        problem: "The browser didn’t open.",
      }),
    );
    assert.match(html, /data-genex-action="primary"[^>]*>Get credits</);
    assert.match(html, /data-genex-action="claude-code"[^>]*>Continue on Claude plan</);
    assert.doesNotMatch(html, /Connect Codex/);
    assert.match(html, /role="alert"[^>]*>The browser didn’t open\.</);
  });
});
