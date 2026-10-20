/**
 * Claude's permission questions, in the chat's words: the card's question, what "always" grants
 * and how a request ended. The mode names themselves are Claude Code's (shared/permissions.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  alwaysWords,
  bypassPermissionsWords,
  consentLineWords,
  consentOutcomeWords,
  permissionCommandWords,
  permissionInsteadWords,
  permissionLineWords,
  permissionOutcomeWords,
  permissionRuleWords,
  permissionTitleWords,
} from "../../src/renderer/words.ts";
import { allowedActions } from "../../src/renderer/permission-actions.ts";
import type { PermissionGrant, ToolPermissionEvent } from "../../src/shared/permissions.ts";

const ask = (fields: Partial<ToolPermissionEvent>): Partial<ToolPermissionEvent> => ({
  requestId: "r1",
  project: "game",
  threadId: "t1",
  state: "pending",
  input: {},
  ...fields,
});
const rule = (text: string, scope: "game" | "chat" = "game"): PermissionGrant => ({ kind: "rule", rule: text, scope });

describe("permissionTitleWords", () => {
  it("uses Claude Code's own sentence when it wrote one", () => {
    assert.equal(
      permissionTitleWords(ask({ tool: "Bash", title: "Claude wants to run npm install" })),
      "Claude wants to run npm install",
    );
  });

  it("says what each tool is about to do otherwise", () => {
    assert.equal(
      permissionTitleWords(ask({ tool: "Bash", input: { command: "rm -rf dist" } })),
      "Claude wants to run a command",
    );
    assert.equal(
      permissionTitleWords(ask({ tool: "Edit", input: { file_path: "/Users/me/game/src/main.ts" } })),
      "Claude wants to edit main.ts",
    );
    assert.equal(
      permissionTitleWords(ask({ tool: "Edit", input: { file_path: "C:\\Users\\me\\game\\src\\main.ts" } })),
      "Claude wants to edit main.ts",
      "a Windows path",
    );
    assert.equal(
      permissionTitleWords(ask({ tool: "NotebookEdit", input: { notebook_path: "/tmp/notes.ipynb" } })),
      "Claude wants to edit notes.ipynb",
    );
    assert.equal(
      permissionTitleWords(ask({ tool: "Read", subject: "/Users/me/refs/art.png" })),
      "Claude wants to read /Users/me/refs/art.png",
    );
    assert.equal(
      permissionTitleWords(ask({ tool: "Glob", input: { pattern: "~/Music/**/*.wav" } })),
      "Claude wants to read ~/Music/**/*.wav",
    );
    assert.equal(
      permissionTitleWords(ask({ tool: "WebFetch", input: { url: "https://docs.example.com/guide?x=1" } })),
      "Claude wants to open docs.example.com",
    );
    assert.equal(
      permissionTitleWords(ask({ tool: "WebFetch", subject: "example.org" })),
      "Claude wants to open example.org",
    );
    assert.equal(
      permissionTitleWords(ask({ tool: "mcp__sprites__make_sprite_sheet" })),
      "Claude wants to use make sprite sheet",
    );
    assert.equal(
      permissionTitleWords(ask({ tool: "SandboxNetworkAccess", displayName: "Network access" })),
      "Claude wants to use Network access",
    );
    assert.equal(permissionTitleWords(ask({ tool: "Write" })), "Claude wants to edit a file");
  });

  it("a worker's card names the worker", () => {
    const worker = { id: "w1", title: "Scene builder" };
    // Claude Code's own sentence names Claude: a worker's card says who asks instead.
    assert.equal(
      permissionTitleWords(ask({ tool: "Bash", title: "Claude wants to run npm install", worker })),
      "Scene builder wants to run a command",
    );
    assert.equal(
      permissionTitleWords(ask({ tool: "Edit", input: { file_path: "/Users/me/game/src/main.ts" }, worker })),
      "Scene builder wants to edit main.ts",
    );
    assert.equal(
      permissionTitleWords(ask({ tool: "Read", subject: "/Users/me/refs/art.png", worker })),
      "Scene builder wants to read /Users/me/refs/art.png",
    );
    assert.equal(
      permissionTitleWords(ask({ tool: "mcp__sprites__make_sprite", worker })),
      "Scene builder wants to use make sprite",
    );
    assert.equal(permissionCommandWords(ask({ tool: "Bash", worker })), "Scene builder wants to run a command");
    assert.equal(permissionCommandWords(ask({ tool: "Bash" })), "Claude wants to run a command");
    assert.equal(
      permissionTitleWords(ask({ tool: "Bash", worker: { id: "w2", title: " " } })),
      "A worker wants to run a command",
      "a worker with no title is still not Claude",
    );
  });

  it("the card's own-words row tells the worker, not Claude, what to do instead", () => {
    assert.equal(
      permissionInsteadWords(ask({ tool: "Bash", worker: { id: "w1", title: "Scene builder" } })),
      "Tell the worker what to do instead…",
    );
    assert.equal(permissionInsteadWords(ask({ tool: "Bash" })), "Tell Claude what to do instead…");
  });

  it("a job's card asks in plain words, naming the worker that wants it", () => {
    const job = { title: "Unreal build", command: "make -j8 editor", folder: "." };
    const worker = { id: "w1", title: "Scene builder" };
    assert.equal(
      permissionTitleWords(ask({ tool: "Job", input: job, worker, title: "Claude wants to run Unreal build" })),
      "Scene builder wants to run Unreal build in the background",
    );
    assert.equal(
      permissionTitleWords(
        ask({ tool: "Job", input: job, title: "The lead wants to run Unreal build in the background" }),
      ),
      "The lead wants to run Unreal build in the background",
      "a lead's card keeps its own words",
    );
    assert.equal(
      permissionTitleWords(ask({ tool: "Job", input: job })),
      "Claude wants to run Unreal build in the background",
    );
    assert.equal(
      permissionTitleWords(ask({ tool: "Job", input: {}, worker })),
      "Scene builder wants to run something in the background",
    );
    for (const words of [
      permissionTitleWords(ask({ tool: "Job", input: job, worker })),
      permissionTitleWords(ask({ tool: "Job", input: job })),
    ])
      assert.ok(!words.includes(job.command), `no command in the question: ${words}`);
  });

  it("asks to approve a plan, whatever Claude Code titled it", () => {
    assert.equal(
      permissionTitleWords(ask({ tool: "ExitPlanMode", title: "Exit plan mode?", plan: "1. Add a jump" })),
      "Approve this plan?",
    );
  });
});

describe("alwaysWords", () => {
  it("names the command prefix a Bash rule allows, and where", () => {
    assert.equal(alwaysWords([rule("Bash(npm test:*)")]), "Always allow npm test commands in this game");
    assert.equal(alwaysWords([rule("Bash(npm test *)", "chat")]), "Always allow npm test commands in this chat");
    assert.equal(alwaysWords([rule("Bash(git push origin main)")]), "Always allow this command in this game");
  });

  it("reads Claude Code's absolute rule paths as plain folders", () => {
    assert.equal(alwaysWords([rule("Read(//Users/me/refs/**)")]), "Always allow reading /Users/me/refs in this game");
    assert.equal(
      alwaysWords([rule("Edit(//Users/me/shared/**)", "chat")]),
      "Always allow editing /Users/me/shared in this chat",
    );
  });

  it("names a domain, a tool, a mode and a folder", () => {
    assert.equal(
      alwaysWords([rule("WebFetch(domain:docs.godotengine.org)")]),
      "Always allow docs.godotengine.org in this game",
    );
    assert.equal(alwaysWords([rule("WebSearch")]), "Always allow WebSearch in this game");
    assert.equal(alwaysWords([rule("mcp__sprites__make_sprite")]), "Always allow make sprite in this game");
    assert.equal(alwaysWords([{ kind: "mode", mode: "acceptEdits" }]), "Allow all edits in this chat");
    assert.equal(
      alwaysWords([{ kind: "directory", path: "/Users/me/refs" }]),
      "Always allow /Users/me/refs in this chat",
    );
  });

  it("names every grant when Claude Code offers several — the choice keeps all of them", () => {
    assert.equal(
      alwaysWords([
        rule("Bash(npm run build:*)"),
        { kind: "directory", path: "/tmp/out" },
        { kind: "mode", mode: "acceptEdits" },
      ]),
      "Always allow npm run build commands in this game, and always allow /tmp/out in this chat, and allow all edits in this chat",
    );
  });
});

describe("permissionLineWords", () => {
  it("says an answered request in one line: what came of it, then what it was about", () => {
    const install = { tool: "Bash", input: { command: "npm install three" }, by: "user" } as const;
    assert.equal(
      permissionLineWords(ask({ ...install, state: "allowed", granted: "once" })),
      "Allowed · npm install three",
    );
    assert.equal(
      permissionLineWords(ask({ ...install, state: "allowed", granted: "always" })),
      "Always allowed · npm install three",
    );
    assert.equal(
      permissionLineWords(ask({ ...install, state: "denied", message: "Use pnpm instead" })),
      "Denied · npm install three",
    );
    assert.equal(
      permissionLineWords(ask({ ...install, state: "denied", by: "turn" })),
      "Withdrawn when the turn ended · npm install three",
    );
  });

  it("names a command by its first line, a file by its path, a page by its host and any other tool by its name", () => {
    const allowed = { state: "allowed", by: "user", granted: "once" } as const;
    assert.equal(
      permissionLineWords(ask({ ...allowed, tool: "Bash", input: { command: "npm test\nnpm run build" } })),
      "Allowed · npm test",
    );
    assert.equal(
      permissionLineWords(ask({ ...allowed, tool: "Edit", input: { file_path: "/games/isle/src/main.js" } })),
      "Allowed · /games/isle/src/main.js",
    );
    assert.equal(
      permissionLineWords(ask({ ...allowed, tool: "WebFetch", input: { url: "https://threejs.org/docs/" } })),
      "Allowed · threejs.org",
    );
    assert.equal(permissionLineWords(ask({ ...allowed, tool: "Bash", input: {} })), "Allowed · a command");
  });

  it("says a plan's answer alone, with the mode it continues in", () => {
    const plan = { tool: "ExitPlanMode", plan: "1. Jump", by: "user" } as const;
    assert.equal(permissionLineWords(ask({ ...plan, state: "allowed", mode: "auto" })), "Plan approved · Auto");
    assert.equal(permissionLineWords(ask({ ...plan, state: "denied", message: "Smaller" })), "Denied · the plan");
  });
});

describe("permissionOutcomeWords", () => {
  it("says how the person answered", () => {
    assert.equal(
      permissionOutcomeWords(ask({ tool: "Bash", state: "allowed", by: "user", granted: "once" })),
      "Allowed",
    );
    assert.equal(
      permissionOutcomeWords(ask({ tool: "Bash", state: "allowed", by: "user", granted: "always" })),
      "Always allowed",
    );
    assert.equal(permissionOutcomeWords(ask({ tool: "Bash", state: "denied", by: "user" })), "Denied");
    assert.equal(
      permissionOutcomeWords(ask({ tool: "Bash", state: "denied", by: "user", message: "Use pnpm instead" })),
      "Denied · Use pnpm instead",
    );
    assert.equal(
      permissionOutcomeWords(
        ask({ tool: "ExitPlanMode", plan: "1. Jump", state: "allowed", by: "user", mode: "acceptEdits" }),
      ),
      "Plan approved · Accept edits",
    );
    assert.equal(
      permissionOutcomeWords(
        ask({ tool: "ExitPlanMode", plan: "1. Jump", state: "allowed", by: "user", mode: "default" }),
      ),
      "Plan approved · Manual",
    );
  });

  it("says when the work ending withdrew the question", () => {
    assert.equal(
      permissionOutcomeWords(ask({ tool: "Bash", state: "denied", by: "stop" })),
      "Withdrawn when the work stopped",
    );
    assert.equal(
      permissionOutcomeWords(ask({ tool: "Bash", state: "denied", by: "turn" })),
      "Withdrawn when the turn ended",
    );
    assert.equal(
      permissionOutcomeWords(ask({ tool: "Bash", state: "denied", by: "restart" })),
      "Withdrawn by a restart",
    );
    assert.equal(
      permissionOutcomeWords(ask({ tool: "Bash", state: "denied", by: "timeout" })),
      "Withdrawn: nobody answered",
    );
    assert.equal(
      permissionOutcomeWords(ask({ tool: "Bash", state: "allowed", by: "mode", granted: "once" })),
      "Allowed in Bypass",
    );
  });
});

describe("a settled plugin or connector question", () => {
  it("is one line as Claude's own are: how it ended, then whose it was", () => {
    const line = (outcome: Parameters<typeof consentOutcomeWords>[0]) =>
      consentLineWords(consentOutcomeWords(outcome), "Unreal Engine");
    assert.equal(line({ state: "approved", by: "user", always: true }), "Always allowed · Unreal Engine");
    assert.equal(line({ state: "approved", by: "user" }), "Allowed · Unreal Engine");
    assert.equal(line({ state: "approved", by: "mode" }), "Allowed · Unreal Engine");
    assert.equal(line({ state: "declined", by: "user" }), "Declined · Unreal Engine");
    assert.equal(line({ state: "declined", by: "timeout" }), "Nobody answered · Unreal Engine");
  });
});

describe("bypassPermissionsWords", () => {
  it("names the machine Bypass reaches as the studio's own system calls it", () => {
    assert.match(bypassPermissionsWords("darwin"), /anywhere on this Mac without asking/);
    assert.match(bypassPermissionsWords(""), /this Mac/, "macOS's words until main has said");
    for (const platform of ["win32", "linux"])
      assert.equal(
        bypassPermissionsWords(platform),
        "Claude will run commands and change files anywhere on this computer without asking. Rewind restores only the game folder.",
        platform,
      );
  });
});

describe("Settings → Permissions: what is always allowed, by action", () => {
  it("says a saved rule in plain words, keeping the raw rule for anything it does not know", () => {
    const cases: Array<[string, string]> = [
      ["Bash(npm install:*)", "Run npm install"],
      ["Bash(git status)", "Run git status"],
      ["WebFetch(domain:threejs.org)", "Open pages on threejs.org"],
      ["Read(//Users/you/refs/**)", "Read files in ~/refs"],
      ["Edit(//Users/you/Games/kart/**)", "Edit files in ~/Games/kart"],
      ["Read(//c/Users/you/refs/**)", "Read files in ~/refs"],
      ["Edit(C:\\Users\\you\\Games\\kart)", "Edit files in ~\\Games\\kart"],
      ["Read(src/**)", "Read files in src"],
      ["mcp__genex__make_sound", "mcp__genex__make_sound"],
    ];
    for (const [rule, words] of cases) assert.equal(permissionRuleWords(rule), words, rule);
  });

  it("groups each action once, with every game that allows it, the most shared first", () => {
    const actions = allowedActions([
      { project: "angler", title: "Island Angler", rules: ["Bash(npm test:*)", "Bash(npm install:*)"] },
      { project: "rally", title: "Neon Rally", rules: ["Bash(npm install:*)", "WebFetch(domain:kenney.nl)"] },
      { project: "gone", title: "", rules: [] },
    ]);
    assert.deepEqual(
      actions.map((action) => [action.rule, action.games.map((game) => game.project)]),
      [
        ["Bash(npm install:*)", ["angler", "rally"]],
        ["Bash(npm test:*)", ["angler"]],
        ["WebFetch(domain:kenney.nl)", ["rally"]],
      ],
    );
  });
});
