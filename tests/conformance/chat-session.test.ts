/**
 * Chat = one folder + one contractor session. These helpers are the load-bearing shape:
 * a follow-up never guesses a sibling game, and "keep going" without a session still
 * carries the original ask instead of briefing a blank new job.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildContractorBrief,
  isContinueAsk,
  lastContractorSession,
  originalAsk,
  resolveChatProject,
} from "../../src/harness-seed/loop/chat-session.ts";
import { GameEngine } from "../../src/harness-seed/loop/game-engine.ts";
import { runDelegatedTurn } from "../../src/harness-seed/loop/delegated-turn.ts";
import { launchRules } from "../../src/harness-seed/loop/launch-prompts.ts";
import { fencedCommand } from "../../src/shared/terminal.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";

type ChatMessage = { role: string; content: string };

describe("chat session helpers", () => {
  it("recognises keep-going phrasing, including a stretched keep", () => {
    assert.equal(isContinueAsk("keeep going plz"), true);
    assert.equal(isContinueAsk("Keep going from where we left off."), true);
    assert.equal(isContinueAsk("continue"), true);
    assert.equal(isContinueAsk("resume the build"), true);
    assert.equal(isContinueAsk("I want a rainy night city"), false);
  });

  it("never guesses a project from preview or newest-game", () => {
    const games = [
      { name: "older", dir: "/games/older" },
      { name: "newer", dir: "/games/newer" },
    ];
    assert.equal(resolveChatProject({}, games), null);
    assert.equal(resolveChatProject({ project: "missing" }, games), null);
    assert.equal(resolveChatProject({ newProject: true, project: "older" }, games), null);
    assert.equal(resolveChatProject({ project: "older" }, games), "older");
  });

  it("skips keep-going lines when finding the original ask", () => {
    assert.equal(
      originalAsk([
        { role: "user", content: "Keep going" },
        { role: "user", content: "Build a megastructure of rusted walkways" },
        { role: "user", content: "Keep going from where we left off." },
      ] as ChatMessage[]),
      "Build a megastructure of rusted walkways",
    );
  });

  it("a keep-going brief without resume includes the original ask", () => {
    const brief = buildContractorBrief({
      ask: "Keep going",
      messages: [
        { role: "user", content: "Make Blame! — a vertical megastructure" },
        { role: "assistant", content: "Handing this to the contractor." },
        { role: "user", content: "Keep going" },
      ] as ChatMessage[],
      folderLabel: "AI Games/blame",
    });
    assert.match(brief, /Make Blame!/);
    assert.match(brief, /Latest instruction:\nKeep going/);
    assert.match(brief, /this workspace \(folder `AI Games\/blame`\)/);
    assert.doesNotMatch(brief, /You are resuming your own session/);
  });

  it("a resume brief is a short pickup, not a re-brief of the original job", () => {
    const brief = buildContractorBrief({
      ask: "Keep going",
      messages: [{ role: "user", content: "Make Blame!" }] as ChatMessage[],
      resume: true,
      folderLabel: "AI Games/blame",
    });
    assert.match(brief, /resuming your own session/i);
    assert.doesNotMatch(brief, /Original request/);
  });

  it("reads the last contractor session from the log, newest last", () => {
    const found = lastContractorSession(
      [
        {
          data: {
            type: "custom",
            event_type: "delegation_incomplete",
            payload: { sessionId: "ses_old", engine: "vendor", project: "older" },
          },
        },
        {
          data: {
            type: "custom",
            event_type: "contractor_session",
            payload: { sessionId: "ses_ok", engine: "vendor", project: "older" },
          },
        },
      ],
      "vendor",
    );
    assert.deepEqual(found, { sessionId: "ses_ok", engine: "vendor", project: "older" });
  });

  it("tells a chat build to hand a blocked step to the user in a block the chat can run", () => {
    const brief = buildContractorBrief({ ask: "Add engine sounds" });
    const fence = /one command on a single line in a ```(\w+) block/.exec(brief)?.[1];
    assert.ok(fence, "the brief names the fence a command for the user goes in");
    assert.equal(fencedCommand("brew install ffmpeg", fence), "brew install ffmpeg");
  });

  it("talks like a person first: small talk gets a short reply, no tools and nothing about the studio", () => {
    for (const brief of [
      buildContractorBrief({ ask: "Hello", fresh: true }),
      buildContractorBrief({ ask: "hi", ownShape: true, shape: { main: "src/game.ts" } }),
    ]) {
      const talk = brief.search(/greeting/i);
      assert.ok(talk >= 0, "the brief says how to answer a greeting");
      assert.ok(talk < brief.search(/CLAUDE\.md/), "before any rule about building");
    }
    const loop = launchRules("claude-code", { toolName: "start_unattended_run" }).join("\n");
    assert.ok(
      loop.search(/greeting/i) >= 0 && loop.search(/greeting/i) < loop.search(/ask_user/),
      "a Loop chat replies before it asks",
    );
  });

  it("briefs a brand-new game's first message as a blank page, and a built one's as code to continue", () => {
    const fresh = buildContractorBrief({ ask: "Hello", fresh: true, folderLabel: "AI Games/untitled-game" });
    assert.doesNotMatch(fresh, /existing code/);
    assert.match(fresh, /nothing has been built/i);
    assert.match(buildContractorBrief({ ask: "Hello", folderLabel: "AI Games/arena" }), /existing code/);
  });
});

describe("a chat's first message in a game", () => {
  /** The brief a game's first message is delegated with, its folder at `commits` commits and `changes` uncommitted. */
  async function briefFor({
    commits,
    changes = "",
    prior = [] as ChatMessage[],
  }: {
    commits: string;
    changes?: string;
    prior?: ChatMessage[];
  }) {
    const prompts: string[] = [];
    const recorder = ctxRecorder({
      threadId: "t1",
      unknown: { value: null },
      handlers: {
        "events.messages": () => [...prior, { role: "user", content: "Hello" }],
        "events.list": () => [],
        "game.list": () => [{ name: "untitled-game", title: "Untitled game", dir: "/g/untitled-game" }],
        "game.contentStamp": () => ({ all: "same", source: "same" }),
        "run.exec": (params) => {
          const command = String(params.command);
          if (command.includes("rev-list")) return { code: 0, stdout: `${commits}\n`, stderr: "" };
          if (command.includes("status")) return { code: 0, stdout: changes, stderr: "" };
          return { code: 1, stdout: "", stderr: "unexpected" };
        },
        "engine.delegate": (params) => {
          prompts.push(String(params.prompt));
          return { ok: true, engine: "claude-code", turns: 1, usage: {}, sessionId: "s1", summary: "Hi!" };
        },
      },
    });
    await runDelegatedTurn(recorder.ctx as never, {
      threadId: "t1",
      turnId: "turn-1",
      text: "Hello",
      engine: "claude-code",
      engineLabel: "Claude Code",
      project: "untitled-game",
    });
    return prompts[0] ?? "";
  }

  it("is a blank page when nothing has been made in the game since the studio made it", async () => {
    assert.match(await briefFor({ commits: "1" }), /nothing has been built/i);
  });

  it("continues from the code once anything has been made, or the chat is already talking", async () => {
    assert.match(await briefFor({ commits: "3" }), /existing code/);
    assert.match(await briefFor({ commits: "1", changes: " M src/main.js\n" }), /existing code/);
    assert.doesNotMatch(
      await briefFor({ commits: "1", prior: [{ role: "user", content: "Make a fishing game" }] }),
      /nothing has been built/i,
    );
  });
});

describe("the brief of a game that builds in Unreal", () => {
  const PROJECT = "/Users/me/Unreal Projects/Valley/Valley.uproject";
  const SHAPE = { entry: "index.html", main: "src/main.ts", build: "npm run build" };
  /** The web page's contract, its engine and its randomness rule: none of it is an Unreal game's. */
  const WEB_PAGE = /window\.__studio|three\.?js|installStudio|Math\.random|deterministic/i;

  it("builds in the open Unreal Editor through the Unreal tools, into the linked project", () => {
    const brief = buildContractorBrief({
      ask: "Add a lighthouse",
      folderLabel: "AI Games/fog-valley",
      engine: "claude-code",
      gameEngine: GameEngine.Unreal,
      engineProject: PROJECT,
    });
    assert.ok(
      brief.includes("the Unreal editor connector's tools, as the Unreal plugin's skill describes"),
      "names the editor connector, whose tools the plugin's skill describes",
    );
    assert.doesNotMatch(brief, /unreal-editor__/, "never spells a connector tool's name");
    assert.ok(brief.includes(PROJECT), "says the work lands in the linked project");
    assert.match(brief, /NOTES\.md/);
    assert.match(brief, /Blueprint/);
    assert.match(brief, /file watchers/);
    assert.doesNotMatch(brief, WEB_PAGE);
  });

  it("a folder the user brought is still an Unreal game, never a page to install the contract in", () => {
    const brief = buildContractorBrief({
      ask: "Add a lighthouse",
      shape: SHAPE,
      ownShape: true,
      contractMissing: true,
      engine: "codex",
      gameEngine: GameEngine.Unreal,
      engineProject: PROJECT,
    });
    assert.match(brief, /the Unreal editor connector's tools/);
    assert.doesNotMatch(brief, WEB_PAGE);
    assert.doesNotMatch(brief, /npm run build|src\/main\.ts/, "the web shape's entry and build are not its");
  });

  it("a resumed Unreal session is reminded where its work lands", () => {
    const brief = buildContractorBrief({
      ask: "Keep going",
      resume: true,
      folderLabel: "AI Games/fog-valley",
      gameEngine: GameEngine.Unreal,
      engineProject: PROJECT,
    });
    assert.ok(brief.includes(PROJECT));
    assert.doesNotMatch(brief, WEB_PAGE);
  });

  it("a Loop chat in an Unreal game is told a build is the Unreal Loop, one lead building in the open editor", () => {
    const launch = { toolName: "start_autopilot", hours: 1, project: "fog-valley" };
    const unreal = buildContractorBrief({
      ask: "make me a survival game in a misty valley",
      folderLabel: "AI Games/fog-valley",
      engine: "claude-code",
      gameEngine: GameEngine.Unreal,
      engineProject: PROJECT,
      launch,
    });
    assert.match(unreal, /mcp__studio__start_autopilot/);
    assert.match(unreal, /one lead builds the whole game itself in the open Unreal editor/);
    assert.match(unreal, /small helpers/);
    const web = buildContractorBrief({
      ask: "a pong game",
      folderLabel: "AI Games/pong",
      engine: "claude-code",
      launch,
    });
    assert.doesNotMatch(web, /Unreal|one lead/);
  });

  it("a web game's brief is the web brief, word for word", () => {
    const briefs = [
      { ask: "a pong game", scaffolded: true, folderLabel: "AI Games/pong", engine: "claude-code" },
      { ask: "add fog", shape: SHAPE, ownShape: true, contractMissing: true, engine: "codex" },
      { ask: "Keep going", resume: true, folderLabel: "AI Games/pong" },
    ];
    for (const options of briefs) {
      const web = buildContractorBrief(options);
      assert.equal(buildContractorBrief({ ...options, gameEngine: GameEngine.Web }), web);
      assert.doesNotMatch(web, /Unreal/);
    }
    const template = buildContractorBrief(briefs[0]!);
    assert.match(template, /keep window\.__studio \(seed\/start\/pause\/step\/state\/debugCamera\) working/);
    assert.match(template, /The game's work happens in this workspace/);
  });
});
