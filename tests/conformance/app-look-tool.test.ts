/**
 * `app_look` as the agents get it: who is offered it (the chat's own session, a lead and every
 * worker, readers included, in every mode, Plan too), what it answers (the windows on screen, or one
 * window's picture and tree), and what happens while macOS access is missing (the agent is told what
 * the person must turn on, macOS is asked once, and the chat gets one line only the app writes).
 * Real core, fake delegated engines, and the stub port: nothing looks at this Mac's screen.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { runAppLook } from "../../src/main/core/app-look-tool.ts";
import { APP_LOOK_TOOL } from "../../src/main/core/app-look-tool-prompts.ts";
import { customRecord } from "../../src/shared/custom-events.ts";
import type { LiveToolResult } from "../../src/shared/engine-requests.ts";
import { APP_LOOK_TOOL_NAME, type AppLookAccessPayload, AppLookAccessKind } from "../../src/shared/jobs.ts";
import { PERMISSION_MODES, PermissionMode } from "../../src/shared/permissions.ts";
import {
  type AppLookAccessStatus,
  type AppLookPort,
  type AppWindow,
  type ScreenAccess,
  ScreenAccessState,
  stubAppLook,
} from "../../src/substrate/app-look.ts";
import { NeverTouchKind } from "../../src/substrate/engines/never-touch.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { CLAUDE, closeWorkerChats, LOCAL, RUN_ID, workerChat } from "../helpers/worker-chat.ts";

/** A case that would hang on a regression fails within this instead. */
const CASE_TIMEOUT_MS = 60_000;
const APP_LOOK_ACCESS = "app_look_access";

after(closeWorkerChats);

/** macOS access as the test sets it, counting Genex's asks. */
function recordingAccess(status: AppLookAccessStatus) {
  let asked = false;
  const asks: number[] = [];
  const access: ScreenAccess = {
    status: () => status,
    asked: async () => asked,
    askOnce: async () => {
      if (asked) return;
      asked = true;
      asks.push(asks.length + 1);
    },
  };
  return { access, asks };
}

/** A game chat whose core looks through the stub, with the access given. */
async function lookChat(access?: ScreenAccess) {
  const chat = await workerChat({ appLook: stubAppLook(), ...(access ? { screenAccess: access } : {}) });
  return { ...chat, gameDir: await realpath(chat.project.dir) };
}
type Chat = Awaited<ReturnType<typeof lookChat>>;

/** Every file under a folder, relative, sorted; the repository's insides left out. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .filter((file) => !file.startsWith(".git"))
    .sort();
}

/** The tools a session was handed, by name. */
const toolsOf = (request: DelegateRequest | undefined) => (request?.liveTools ?? []).map((tool) => tool.name).sort();

/** A session briefed with `extra` calls app_look with each of `calls` while its turn runs. */
async function looksIn(
  chat: Chat,
  extra: Record<string, unknown>,
  calls: Array<Record<string, unknown>>,
  engine = CLAUDE,
) {
  const answers: LiveToolResult[] = [];
  let seen: DelegateRequest | undefined;
  chat.whileRunning(async (request) => {
    seen = request;
    for (const args of calls) {
      const answer = await request.onLiveTool?.(APP_LOOK_TOOL_NAME, args);
      if (answer !== undefined) answers.push(answer);
    }
  });
  try {
    await chat.delegate(extra, engine);
  } finally {
    chat.whileRunning(async () => {});
  }
  return { answers, request: seen };
}

const textOf = (answer: LiveToolResult | undefined) => (typeof answer === "string" ? answer : (answer?.text ?? ""));
const imagesOf = (answer: LiveToolResult | undefined) => (typeof answer === "string" ? [] : (answer?.images ?? []));

/** The chat's own session answering a message the person sent now. */
const ownTurn = async (chat: Chat) => ({ chatTurn: { messageId: await chat.personSays() } });

/** A lead of the chat's run that sits in the game folder and leads a build of its own (a web lead). */
async function webLead(chat: Chat) {
  const root = await chat.copyOf(RUN_ID, `integration-${Math.random().toString(16).slice(2)}`);
  return {
    readOnly: true,
    director: {
      runId: RUN_ID,
      threadId: chat.threadId,
      project: chat.game,
      root,
      setup: null,
      tools: [],
      chatSession: true,
    },
  };
}

/** The chat's access rows. */
async function accessRows(chat: Chat): Promise<AppLookAccessPayload[]> {
  return (await chat.core.store.listEvents(chat.threadId)).flatMap((event) => {
    const custom = customRecord(event.data);
    return custom?.event_type === APP_LOOK_ACCESS ? [custom.payload as unknown as AppLookAccessPayload] : [];
  });
}

describe("app_look", () => {
  it("app_look is offered to the chat's own session, a lead and every worker, readers included, in every mode, Plan too", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await lookChat();
    for (const mode of PERMISSION_MODES) {
      await chat.core.setPermissionMode(chat.threadId, mode);
      const seats: Array<[string, Record<string, unknown>]> = [
        ["the chat's own session", await ownTurn(chat)],
        ["a lead", await webLead(chat)],
        ["a writing worker", chat.runWorker()],
        ["a reader worker", chat.runWorker("r1", chat.worktree, { readOnly: true })],
      ];
      for (const [label, brief] of seats) {
        const { request } = await looksIn(chat, brief, []);
        assert.ok(toolsOf(request).includes(APP_LOOK_TOOL_NAME), `${mode}: ${label}`);
      }
    }
    await chat.core.setPermissionMode(chat.threadId, PermissionMode.Auto);
    const reader = await looksIn(chat, chat.runWorker("r1", chat.worktree, { readOnly: true }), []);
    assert.deepEqual(toolsOf(reader.request), [APP_LOOK_TOOL_NAME], "a reader gets no other host tool");
    const none: Array<[string, Record<string, unknown>, string?]> = [
      ["an unseated builder", { cwd: chat.worktree }],
      ["the coordinator", { coordinator: { runId: RUN_ID }, readOnly: true }],
      ["the chat's own session on a local model", await ownTurn(chat), LOCAL],
    ];
    for (const [label, brief, engine] of none) {
      const { request } = await looksIn(chat, brief, [], engine);
      assert.ok(!toolsOf(request).includes(APP_LOOK_TOOL_NAME), label);
    }
  });

  it("answers a picture and a tree, and lists windows when asked for none", { timeout: CASE_TIMEOUT_MS }, async () => {
    const chat = await lookChat();
    await chat.core.setPermissionMode(chat.threadId, PermissionMode.Plan);
    const { answers } = await looksIn(chat, chat.runWorker("r1", chat.worktree, { readOnly: true }), [
      {},
      { app: "Fixture App" },
      { window: "1" },
      { app: "Nothing Here" },
    ]);
    const [listed, byApp, byId, missing] = answers;
    assert.match(textOf(listed), /1 · Fixture App — Fixture Window/);
    assert.deepEqual(imagesOf(listed), [], "a list has no picture");
    for (const looked of [byApp, byId]) {
      assert.match(textOf(looked), /^Fixture App — Fixture Window \(window 1\)\nAXWindow "Fixture Window"/);
      assert.deepEqual(
        imagesOf(looked).map((image) => image.mimeType),
        ["image/jpeg"],
      );
    }
    assert.match(textOf(missing), /No window on screen matches/);
    assert.equal(typeof missing === "object" && missing.isError, true);
  });

  it("with access missing it tells the agent what the person must turn on, and the chat gets one line", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { access, asks } = recordingAccess({ screen: ScreenAccessState.NotDetermined, accessibility: false });
    const chat = await lookChat(access);
    const { answers } = await looksIn(chat, await ownTurn(chat), [{ app: "Fixture App" }, {}]);
    for (const answer of answers) {
      assert.match(textOf(answer), /Screen Recording and Accessibility for Genex in System Settings/);
      assert.match(textOf(answer), /do not retry until they say it is on/);
      assert.deepEqual(imagesOf(answer), [], "no picture");
    }
    assert.deepEqual(asks, [1], "macOS is asked once");
    assert.deepEqual(await accessRows(chat), [
      { project: chat.game, missing: [AppLookAccessKind.Screen, AppLookAccessKind.Accessibility] },
    ]);
    await looksIn(chat, chat.runWorker(), [{}]);
    assert.equal((await accessRows(chat)).length, 1, "one line per chat");
    const append = chat.api["events.append"];
    assert.ok(append, "the harness's append");
    await assert.rejects(
      append({
        threadId: chat.threadId,
        batch: [{ type: "custom", event_type: APP_LOOK_ACCESS, payload: { project: chat.game, missing: [] } }],
      }),
      "the harness cannot write it",
    );
  });

  it("app_look saves its picture inside the session's folder when asked, and never elsewhere", {
    timeout: CASE_TIMEOUT_MS,
    skip: process.platform === "win32" && "links need privileges on Windows",
  }, async () => {
    const chat = await lookChat();
    const outside = await realpath(await tmpDir("studio-look-outside-"));
    await symlink(outside, path.join(chat.gameDir, "linked"));
    const stub = (await stubAppLook().look({ id: 1 } as never)) as { image: { data: string } };
    const picture = Buffer.from(stub.image.data, "base64");
    const own = await looksIn(chat, await ownTurn(chat), [{ app: "Fixture App", save: "shots/w.jpg" }]);
    assert.deepEqual(await readFile(path.join(chat.gameDir, "shots", "w.jpg")), picture, "kept in the game folder");
    assert.match(textOf(own.answers[0]), /Saved the picture as shots\/w\.jpg/);
    assert.equal(imagesOf(own.answers[0]).length, 1, "and the picture is still answered");
    const worker = await looksIn(chat, chat.runWorker(), [{ app: "Fixture App", save: "w.jpg" }]);
    assert.ok(existsSync(path.join(chat.worktree, "w.jpg")), "a worker keeps it in its own folder");
    assert.ok(!existsSync(path.join(chat.gameDir, "w.jpg")), "never in the game folder it doesn't work in");
    assert.match(textOf(worker.answers[0]), /Saved the picture as w\.jpg/);

    const before = await filesUnder(chat.gameDir);
    const outsideBefore = await filesUnder(outside);
    const hostile = ["../w.jpg", path.join(outside, "abs.jpg"), "w.png", "linked/w.jpg", "a/../../w.jpg", ""];
    const refused = await looksIn(
      chat,
      await ownTurn(chat),
      hostile.map((save) => ({ app: "Fixture App", save })),
    );
    await chat.core.setPermissionMode(chat.threadId, PermissionMode.Plan);
    const plan = await looksIn(chat, await ownTurn(chat), [{ app: "Fixture App", save: "plan.jpg" }]);
    await chat.core.setPermissionMode(chat.threadId, PermissionMode.Auto);
    const reader = await looksIn(chat, chat.runWorker("r1", chat.worktree, { readOnly: true }), [
      { app: "Fixture App", save: "reader.jpg" },
    ]);
    const answers = [...refused.answers, ...plan.answers, ...reader.answers];
    assert.equal(answers.length, hostile.length + 2);
    for (const answer of answers) {
      assert.match(textOf(answer), /The picture was not saved/);
      assert.equal(imagesOf(answer).length, 1, "the picture is answered all the same");
    }
    assert.deepEqual(await filesUnder(chat.gameDir), before, "nothing was written in the game folder");
    assert.deepEqual(await filesUnder(outside), outsideBefore, "nor outside it");
    assert.ok(!existsSync(path.join(chat.worktree, "reader.jpg")), "a reader keeps nothing");
    assert.ok(!existsSync(path.join(path.dirname(chat.gameDir), "w.jpg")));
  });

  it("a save into a folder it never touches is refused before any folder is made", async () => {
    const folder = await realpath(await tmpDir("studio-look-never-"));
    const other = path.join(folder, "other");
    await mkdir(other);
    const neverTouch = { roots: [{ path: other, kind: NeverTouchKind.OtherGame }], open: [] };
    const caller = { project: "p", chatThreadId: null, save: { folder, neverTouch, planning: async () => false } };
    const core = { screenAccess: null, appLook: stubAppLook() } as never;
    for (const save of ["other/new/deeper/x.jpg", "other/x.jpg"]) {
      const answer = await runAppLook(core, { app: "Fixture App", save }, caller);
      assert.match(textOf(answer), /The picture was not saved/, save);
    }
    assert.deepEqual(await filesUnder(folder), ["other"], "no folder was made, nothing was written");
  });

  it("a save in a session's folder reached through a link is kept in its real folder", async () => {
    const root = await realpath(await tmpDir("studio-look-linked-"));
    const real = path.join(root, "games", "level-tools");
    await mkdir(real, { recursive: true });
    await symlink(path.join(root, "games"), path.join(root, "alias"));
    const folder = path.join(root, "alias", "level-tools");
    const neverTouch = { roots: [], open: [] };
    const caller = { project: "p", chatThreadId: null, save: { folder, neverTouch, planning: async () => false } };
    const core = { screenAccess: null, appLook: stubAppLook() } as never;
    const answer = await runAppLook(core, { app: "Fixture App", save: "Saved/Shots/w.jpg" }, caller);
    assert.doesNotMatch(textOf(answer), /The picture was not saved/);
    assert.ok(existsSync(path.join(real, "Saved", "Shots", "w.jpg")), "kept in the folder the link names");
  });

  it("never looks at an app computer control never drives, nor at Genex's own windows, and never lists them", async () => {
    const at = (id: number, app: string, bundleId: string, pid = 100 + id): AppWindow => ({
      id,
      app,
      bundleId,
      pid,
      title: `${app} window`,
      bounds: { x: 0, y: 0, width: 400 + id, height: 300 },
      onScreen: true,
    });
    const refused: AppWindow[] = [
      at(2, "System Settings", "com.apple.systempreferences"),
      at(3, "System Settings", "com.apple.SystemSettings"),
      at(4, "SecurityAgent", "com.apple.SecurityAgent"),
      at(5, "loginwindow", "com.apple.loginwindow"),
      at(6, "KeePassXC", "com.keepassxc.keepassxc"),
      at(7, "1Password", "com.1password.1password"),
      at(8, "Genex", "games.genex.desktop"),
      at(9, "Electron", "com.github.Electron", process.pid),
    ];
    const game = at(1, "Toy Game", "com.example.toy-game");
    const looked: number[] = [];
    const port: AppLookPort = {
      windows: async () => [game, ...refused],
      look: async (window) => {
        looked.push(window.id);
        return { window, image: null, tree: "AXWindow", truncated: false };
      },
    };
    const core = { screenAccess: null, appLook: port } as never;
    const caller = { project: "p", chatThreadId: null };
    const listed = textOf(await runAppLook(core, {}, caller));
    assert.match(listed, /1 · Toy Game/);
    for (const window of refused) {
      assert.doesNotMatch(listed, new RegExp(`^${window.id} ·`, "m"), `${window.app} is not listed`);
      for (const args of [{ window: String(window.id) }, { app: window.bundleId ?? "" }]) {
        const answer = await runAppLook(core, args, caller);
        assert.match(textOf(answer), /Genex does not look at/, `${window.app} by ${Object.keys(args)[0]}`);
        assert.deepEqual(imagesOf(answer), []);
      }
    }
    assert.deepEqual(looked, [], "no refused window was ever looked at");
    await runAppLook(core, { app: "Toy Game" }, caller);
    assert.deepEqual(looked, [1]);
  });

  it("its spec takes which window to look at, and where to keep its picture", () => {
    assert.equal(APP_LOOK_TOOL.name, APP_LOOK_TOOL_NAME);
    assert.deepEqual(Object.keys(APP_LOOK_TOOL.parameters.properties ?? {}).sort(), ["app", "save", "window"]);
    assert.deepEqual(APP_LOOK_TOOL.parameters.required ?? [], [], "all are optional");
    assert.match(APP_LOOK_TOOL.description, /cannot click or type/);
  });
});
