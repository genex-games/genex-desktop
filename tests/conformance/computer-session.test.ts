/**
 * The computer session over any target: a fake target records what reached it, so the session's
 * own rules — observing after an action, batches, the action budget, the trace and the clock's
 * pacing — are tested without a window.
 */
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { computerSession, type TargetSource } from "../../src/main/core/computer-session.ts";
import { BROWSER_CAPABILITIES, ClockLevel, InputRoute } from "../../src/shared/computer-target.ts";
import type { ComputerTarget } from "../../src/substrate/computer-target.ts";
import type { LiveToolResult } from "../../src/substrate/engines/types.ts";
import { tmpDir } from "../helpers/tmp.ts";

const text = (result: LiveToolResult): string => (typeof result === "string" ? result : result.text);
const images = (result: LiveToolResult): number => (typeof result === "string" ? 0 : (result.images?.length ?? 0));

/** A target that records every call in order, with a clock that can step. */
function fakeTarget(options: { stepAnswers?: number | null; failInputAt?: number } = {}) {
  const calls: string[] = [];
  let inputs = 0;
  const target: ComputerTarget = {
    caps: BROWSER_CAPABILITIES,
    viewSize: () => ({ width: 960, height: 600 }),
    pointer: () => ({ x: 1, y: 2 }),
    screenshot: async ({ surface }) => {
      calls.push(`shot:${surface}`);
      return { jpeg: Buffer.from("jpeg"), stats: null, surface: null };
    },
    input: async (actions) => {
      inputs += 1;
      if (options.failInputAt === inputs) throw new Error("the window went away");
      calls.push(`input:${actions.map((a) => a.type).join("+")}`);
      return { applied: actions.length, route: InputRoute.Browser };
    },
    state: async () => ({ hp: 3 }),
    clock: {
      pause: async () => {
        calls.push("pause");
      },
      start: async () => {
        calls.push("start");
      },
      step: async (ms) => {
        calls.push(`step:${ms}`);
        return options.stepAnswers === undefined ? ms : options.stepAnswers;
      },
    },
    seed: async (seed) => {
      calls.push(`seed:${seed}`);
    },
  };
  return { target, calls };
}

/** A source over one fake target: loads it once, frames go nowhere. */
function sourceOf(target: ComputerTarget): TargetSource {
  let loaded = false;
  return {
    caps: target.caps,
    load: async () => {
      const fresh = !loaded;
      loaded = true;
      return { target, problem: null, note: null, fresh };
    },
    frame: async () => {},
  };
}

async function session(options: Partial<Parameters<typeof computerSession>[2]> & { target?: ComputerTarget } = {}) {
  const fake = options.target ? { target: options.target, calls: [] as string[] } : fakeTarget();
  const frameDir = await tmpDir("computer-session-");
  const s = computerSession(sourceOf(fake.target), "/build", { pacing: "running", frameDir, ...options });
  return { s, calls: fake.calls, frameDir };
}

describe("computer session — observe after an action", () => {
  it("returns the picture with the answer when asked, and saves it as a frame", async () => {
    const { s, calls } = await session();
    const answer = await s.run("computer", { action: "key", text: "w", observe: "screenshot" });
    assert.equal(images(answer), 1);
    assert.match(text(answer), /s1_/);
    assert.deepEqual(calls, ["input:press", "shot:auto"]);
  });

  it("observes by default where the session says so, and never when told none", async () => {
    const { s, calls } = await session({ observeByDefault: true });
    assert.equal(images(await s.run("computer", { action: "key", text: "w" })), 1);
    assert.equal(images(await s.run("computer", { action: "key", text: "w", observe: "none" })), 0);
    assert.deepEqual(calls, ["input:press", "shot:auto", "input:press"]);
    assert.doesNotMatch(
      text(await s.run("computer", { action: "key", text: "w", observe: "none" })),
      /Screenshot to see/,
    );
  });

  it("photographs only the canvas when asked", async () => {
    const { s, calls } = await session();
    await s.run("computer", { action: "key", text: "w", observe: "canvas" });
    assert.equal(calls.at(-1), "shot:canvas");
  });
});

describe("computer session — batches and the action budget", () => {
  it("runs a batch in order with one look at the end", async () => {
    const { s, calls } = await session();
    const answer = await s.run("computer", {
      action: "batch",
      actions: [
        { action: "key", text: "w" },
        { action: "left_click", coordinate: "5,5" },
      ],
      observe: "screenshot",
    });
    assert.deepEqual(calls, ["input:press", "input:click", "shot:auto"]);
    assert.equal(images(answer), 1);
    assert.match(text(answer), /2 of 2 steps/);
  });

  it("stops a batch at the first step that fails and names it", async () => {
    const { target, calls } = fakeTarget({ failInputAt: 2 });
    const { s } = await session({ target });
    const answer = await s.run("computer", {
      action: "batch",
      actions: [
        { action: "key", text: "w" },
        { action: "key", text: "a" },
        { action: "key", text: "d" },
      ],
    });
    assert.match(text(answer), /step 2 \(key a\) failed/);
    assert.deepEqual(calls, ["input:press"]);
  });

  it("counts every batch step against the budget, on the host", async () => {
    const { s } = await session({ maxActions: 3 });
    await s.run("computer", {
      action: "batch",
      actions: [
        { action: "key", text: "w" },
        { action: "key", text: "w" },
      ],
    });
    const over = await s.run("computer", {
      action: "batch",
      actions: [
        { action: "key", text: "w" },
        { action: "key", text: "w" },
      ],
    });
    assert.match(text(over), /action budget/);
    const last = await s.run("computer", { action: "key", text: "w" });
    assert.doesNotMatch(text(last), /action budget/);
    assert.match(text(await s.run("computer", { action: "key", text: "w" })), /action budget/);
    assert.doesNotMatch(text(await s.run("computer", { action: "screenshot" })), /action budget/, "looking is free");
  });
});

describe("computer session — the trace", () => {
  it("writes one row per action with its route, frame and cursor", async () => {
    const { s, frameDir } = await session();
    await s.run("computer", { action: "key", text: "w", observe: "screenshot" });
    await s.run("computer", { action: "state" });
    const rows = (await readFile(path.join(frameDir, "trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].action, "key");
    assert.equal(rows[0].route, InputRoute.Browser);
    assert.match(rows[0].frame, /s1_/);
    assert.deepEqual(rows[0].cursor, { x: 1, y: 2 });
    assert.equal(rows[1].action, "state");
    assert.equal(rows[1].route, null);
    assert.equal(s.trace().steps, 2);
    assert.equal(s.trace().path, path.join(frameDir, "trace.jsonl"));
  });

  it("numbers on past what an earlier process left in the folder: no trace is appended to, no frame overwritten", async () => {
    const frameDir = await tmpDir("computer-session-");
    await writeFile(path.join(frameDir, "trace.jsonl"), '{"i":1,"action":"key"}\n');
    await writeFile(path.join(frameDir, "s7_after-key.jpg"), "earlier");
    const { target } = fakeTarget();
    const s = computerSession(sourceOf(target), "/build", { pacing: "running", frameDir });
    const answer = await s.run("computer", { action: "key", text: "w", observe: "screenshot" });
    assert.match(text(answer), /s8_after-key/);
    assert.equal(s.trace().path, path.join(frameDir, "trace-2.jsonl"));
    assert.equal(await readFile(path.join(frameDir, "trace.jsonl"), "utf8"), '{"i":1,"action":"key"}\n');
    assert.equal(await readFile(path.join(frameDir, "s7_after-key.jpg"), "utf8"), "earlier");
  });
});

describe("computer session — the clock", () => {
  it("a paced session pauses after load and runs the clock only during a move", async () => {
    const { s, calls } = await session({ pacing: "paced" });
    await s.run("computer", { action: "key", text: "w" });
    assert.deepEqual(calls, ["pause", "start", "input:press", "pause"]);
  });

  it("a stepped session seeds, pauses, and steps exact time after each move and through a wait", async () => {
    const { s, calls } = await session({ pacing: "stepped", seed: 7 });
    await s.run("computer", { action: "key", text: "w" });
    await s.run("computer", { action: "wait", duration: 0.5 });
    // Flipped on purpose (review finding): a stroke on a stepped clock is its down, a few frames of
    // game time, and its up, so a game that reads keys once a frame sees it; then the settle step.
    assert.deepEqual(calls, ["seed:7", "pause", "input:down", "step:50", "input:up", "step:120", "step:500"]);
    assert.equal(s.trace().deterministic, true);
  });

  it("a stepped session whose target cannot step falls back to pacing and marks the trace", async () => {
    const { target, calls } = fakeTarget({ stepAnswers: null });
    const { s } = await session({ pacing: "stepped", target });
    await s.run("computer", { action: "key", text: "w" });
    await s.run("computer", { action: "key", text: "w" });
    assert.equal(s.trace().deterministic, false);
    assert.deepEqual(
      calls.slice(-3),
      ["start", "input:press", "pause"],
      "it paces with start/pause once stepping failed",
    );
  });

  it("a target without a holdable clock is never paused, whatever the role", async () => {
    const { target, calls } = fakeTarget();
    const { s } = await session({
      pacing: "paced",
      target: { ...target, caps: { ...BROWSER_CAPABILITIES, clock: ClockLevel.None } },
    });
    await s.run("computer", { action: "key", text: "w" });
    assert.deepEqual(calls, ["input:press"]);
  });
});

describe("computer session — review findings", () => {
  it("a held key on a stepped clock is held for that much game time, not wall time", async () => {
    const { s, calls } = await session({ pacing: "stepped", seed: 3 });
    await s.run("computer", { action: "hold_key", text: "w", duration: 2 });
    assert.deepEqual(calls, ["seed:3", "pause", "input:down", "step:2000", "input:up", "step:120"]);
  });

  it("reads what the loaded target can do: a clock it cannot step is paced, and the trace never claims a replay", async () => {
    const { target, calls } = fakeTarget();
    const unstepped: ComputerTarget = {
      ...target,
      caps: { ...BROWSER_CAPABILITIES, clock: ClockLevel.None },
      clock: { pause: target.clock!.pause, start: target.clock!.start },
    };
    // The source promises more than the game delivers, as a Play Protocol game does before `hello`.
    let loaded = false;
    const source: TargetSource = {
      caps: BROWSER_CAPABILITIES,
      load: async () => {
        const fresh = !loaded;
        loaded = true;
        return { target: unstepped, problem: null, note: null, fresh };
      },
      frame: async () => {},
    };
    const s = computerSession(source, "/build", { pacing: "stepped", frameDir: await tmpDir("cs-caps-") });
    await s.run("computer", { action: "key", text: "w" });
    assert.ok(!calls.some((call) => call.startsWith("step")), "nothing stepped");
    assert.ok(!calls.includes("pause"), "a clock that cannot be held is not paused");
    assert.equal(s.trace().deterministic, false);
  });

  it("says when the game took only part of a move, and a batch stops where the game refused everything", async () => {
    const { target } = fakeTarget();
    let taken = 0;
    const picky: ComputerTarget = {
      ...target,
      input: async (actions) => ({ applied: Math.min(taken, actions.length), route: InputRoute.Bridge }),
    };
    const { s, frameDir } = await session({ target: picky });
    assert.match(
      text(await s.run("computer", { action: "key", text: "w" })),
      /PARTLY — key w: 0 of 1 input actions were taken/,
    );
    const stopped = await s.run("computer", {
      action: "batch",
      actions: [
        { action: "key", text: "w" },
        { action: "key", text: "a" },
      ],
    });
    assert.match(text(stopped), /step 1 \(key w\) failed: every input of that step was refused/);
    taken = 5;
    assert.match(text(await s.run("computer", { action: "key", text: "w" })), /^OK — key w/);
    const rows = (await readFile(path.join(frameDir, "trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.deepEqual(rows[0].applied, { taken: 0, planned: 1 });
  });

  it("an action that throws is answered as an error and still written to the trace", async () => {
    const { target } = fakeTarget({ failInputAt: 1 });
    const { s, frameDir } = await session({ target });
    const answer = await s.run("computer", { action: "key", text: "w" });
    assert.equal(typeof answer !== "string" && answer.isError, true);
    assert.match(text(answer), /key failed: the window went away/);
    const rows = (await readFile(path.join(frameDir, "trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(rows[0].failed, "the window went away");
  });

  it("two sessions in one folder never overwrite each other's frames or trace", async () => {
    const frameDir = await tmpDir("cs-shared-");
    const a = computerSession(sourceOf(fakeTarget().target), "/build", { pacing: "running", frameDir });
    const b = computerSession(sourceOf(fakeTarget().target), "/build", { pacing: "running", frameDir });
    await a.run("computer", { action: "screenshot" });
    await b.run("computer", { action: "screenshot" });
    assert.notEqual(a.trace().path, b.trace().path);
    const frames = (await readdir(frameDir)).filter((f) => f.endsWith(".jpg"));
    assert.equal(frames.length, 2, frames.join(","));
  });
});

describe("computer session — named game actions", () => {
  it("hands act to the target, held for its duration of game time, and refuses it where there are none", async () => {
    const { target, calls } = fakeTarget();
    const acting: ComputerTarget = {
      ...target,
      caps: { ...BROWSER_CAPABILITIES, actions: true },
      act: async (list) => {
        calls.push(`act:${list.map((a) => `${a.action}/${a.state}/${a.ticks ?? 0}`).join(",")}`);
        return { applied: list.length, route: InputRoute.Bridge };
      },
    };
    const { s } = await session({ target: acting, pacing: "stepped", seed: 1 });
    await s.run("computer", { action: "act", text: "jump" });
    await s.run("computer", { action: "act", text: "run", duration: 1 });
    assert.deepEqual(calls, ["seed:1", "pause", "act:jump/press/0", "step:120", "act:run/hold/60", "step:1000"]);
    const plain = await session();
    assert.match(text(await plain.s.run("computer", { action: "act", text: "jump" })), /not available/);
  });
});

describe("computer session — why a game refused", () => {
  it("names the game's own reason when it took only part of a move", async () => {
    const { target } = fakeTarget();
    const pending = [{ op: "key", code: "unsupported", message: "no keyboard in this build" }];
    const refusing: ComputerTarget = {
      ...target,
      input: async () => ({ applied: 0, route: InputRoute.Bridge }),
      refusals: () => pending.splice(0),
    };
    const { s } = await session({ target: refusing });
    assert.match(
      text(await s.run("computer", { action: "key", text: "w" })),
      /PARTLY .*\(key: no keyboard in this build\)/,
    );
  });
});

describe("computer session — bringing an app to the front", () => {
  it("hands bring_to_front to a target that can, says why when it could not, and refuses it elsewhere", async () => {
    const { target, calls } = fakeTarget();
    const desk: ComputerTarget = {
      ...target,
      caps: { ...BROWSER_CAPABILITIES, apps: true },
      front: async (app, window) => {
        calls.push(window ? `front:${app}:${window}` : `front:${app}`);
        return app === "chrome.exe" ? `${app} did not come to the front` : null;
      },
    };
    const { s } = await session({ target: desk });
    assert.match(
      text(await s.run("computer", { action: "bring_to_front", text: "msedge.exe" })),
      /^OK — bring msedge\.exe to the front/,
    );
    assert.match(
      text(await s.run("computer", { action: "bring_to_front", text: "chrome.exe" })),
      /bring_to_front did not happen: chrome\.exe did not come to the front/,
    );
    assert.match(text(await s.run("computer", { action: "bring_to_front" })), /bring_to_front needs text=<app>/);
    assert.match(
      text(
        await s.run("computer", {
          action: "bring_to_front",
          text: "com.Roblox.RobloxStudio",
          window: " spinning-colored-block ",
        }),
      ),
      /^OK — bring com\.Roblox\.RobloxStudio \(spinning-colored-block\) to the front/,
      "one of the app's windows, by part of its title",
    );
    assert.deepEqual(calls, [
      "front:msedge.exe",
      "front:chrome.exe",
      "front:com.Roblox.RobloxStudio:spinning-colored-block",
    ]);
    const plain = await session();
    assert.match(
      text(await plain.s.run("computer", { action: "bring_to_front", text: "msedge.exe" })),
      /not available/,
    );
  });
});

describe("computer session — opening a page in the person's browser", () => {
  it("hands open_page to a target that can, says why when it could not, and refuses it elsewhere", async () => {
    const { target, calls } = fakeTarget();
    const desk: ComputerTarget = {
      ...target,
      caps: { ...BROWSER_CAPABILITIES, apps: true },
      openPage: async (address) => {
        calls.push(`page:${address}`);
        return address.startsWith("https://create.example.com/") ? null : "that page is not this task's";
      },
    };
    const { s } = await session({ target: desk });
    assert.match(
      text(await s.run("computer", { action: "open_page", text: "https://create.example.com/icon" })),
      /^OK — open create\.example\.com in the browser/,
    );
    assert.match(
      text(await s.run("computer", { action: "open_page", text: "https://elsewhere.example/" })),
      /open_page did not happen: that page is not this task's/,
    );
    assert.match(
      text(await s.run("computer", { action: "open_page" })),
      /open_page needs text=<an https:\/\/ address>/,
    );
    assert.deepEqual(calls, ["page:https://create.example.com/icon", "page:https://elsewhere.example/"]);
    const plain = await session();
    assert.match(
      text(await plain.s.run("computer", { action: "open_page", text: "https://create.example.com/icon" })),
      /not available/,
    );
  });
});
