/** Real question answers, model inheritance and quiet run feedback in an owned fixture. */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request } from "../../scripts/studio-dev/client.ts";
import { pressStageView } from "./stage-views.mjs";
const exec = promisify(execFile),
  root = process.cwd(),
  profile = `chat-feedback-${Date.now()}`;
const evidence = path.join(root, ".studio-dev/evidence", profile);
fs.mkdirSync(evidence, { recursive: true });
const report = {
  profile,
  checks: [],
  artifacts: [],
  limitations: ["Fixture providers only; no live account or paid generation."],
};
let descriptor,
  started = false;
const save = () => fs.writeFileSync(path.join(evidence, "report.json"), JSON.stringify(report, null, 2) + "\n");
const cli = async (args) =>
  JSON.parse(
    (await exec(process.execPath, ["scripts/studio-dev.ts", ...args], { cwd: root, maxBuffer: 4 * 1024 * 1024 }))
      .stdout,
  );
const attach = () => {
  descriptor = JSON.parse(fs.readFileSync(path.join(root, `.studio-dev/profiles/${profile}/controller.json`), "utf8"));
};
const op = async (method, params = {}) => {
  try {
    return await request(descriptor, { method, params });
  } catch (e) {
    e.message += ` ${method} ${JSON.stringify(params)}`;
    throw e;
  }
};
const click = (selector) => op("click", { selector });
const snap = () => op("snapshot", { surface: "desktop", limit: 200 });
const key = (key, code = key) => op("key", { surface: "desktop", key, code });
const type = (selector, text) => op("type", { selector, text, replace: true });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await fn()) return;
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function capture(name) {
  await op("capture", { surface: "desktop", name: `${name}-paint` });
  await pause(150);
  report.artifacts.push(await op("capture", { surface: "desktop", name }));
  save();
}
async function check(name, fn) {
  try {
    await fn();
    report.checks.push({ name, status: "pass" });
    console.log(`PASS ${name}`);
  } catch (e) {
    report.checks.push({ name, status: "fail", detail: e.stack });
    throw e;
  } finally {
    save();
  }
}
const question = "[data-chat-question]";
const events = (thread) =>
  fs
    .readdirSync(path.join(report.identity.roots.core, "exoharness/agents/studio/conversations", thread, "events"))
    .filter((f) => f.endsWith(".json"))
    .map((f) =>
      JSON.parse(
        fs.readFileSync(
          path.join(report.identity.roots.core, "exoharness/agents/studio/conversations", thread, "events", f),
          "utf8",
        ),
      ),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
/** New game is home: its first message makes the game (the fixture model names it) and asks for the interview. */
async function launchAndAsk() {
  const before = (await snap()).state.project;
  await click('[aria-label="Create game"]');
  // Home's composer is not a target until home's view transition has finished.
  await until(async () => {
    try {
      await type('[data-home-composer] [aria-label="Prompt"]', "Make a night scene");
      return true;
    } catch (e) {
      if (e.code === "target-not-visible") return false;
      throw e;
    }
  }, "home's composer");
  await key("Enter");
  await until(async () => {
    const { state } = await snap();
    return state.room === "build" && Boolean(state.activeThread) && state.project !== before;
  }, "the new game's chat");
  await until(async () => {
    const s = await snap();
    return (
      s.text.includes("Where should the scene take place?") &&
      s.controls.some((c) => c.text === "Send answer") &&
      !s.controls.some((c) => c.label === "Stop")
    );
  }, "interview question");
  return (await snap()).state.activeThread;
}
async function answered() {
  await until(async () => {
    const s = await snap();
    return !s.controls.some((c) => c.text === "Send answer") && s.text.includes("A coast at night, understood.");
  }, "provider resumes after answer");
}
try {
  report.identity = await cli(["start", "--profile", profile, "--fixture", "chat-feedback"]);
  started = true;
  attach();
  await check("routine updates have no fake questions, host handoffs or duplicate build clock", async () => {
    const s = await snap();
    assert.ok(!s.controls.some((c) => /Change it|Write a reply|Start new build/.test(c.text)));
    assert.doesNotMatch(s.text, /conducts the build interview|context restored|Build · .*total/);
    assert.match(s.text, /could not be built/);
    assert.ok(!s.controls.some((c) => c.text === "Play it"));
    const learning = events((await snap()).state.activeThread).find((e) => e.data.event_type === "skillopt_pass");
    const line = await snap();
    assert.match(line.text, /Harness learned 1 thing from this build\./);
    assert.doesNotMatch(
      line.text,
      /past tasks reviewed|0 applied|0 rejected|facet-decomposition|Technical details|Checks incomplete/,
    );
    await click(`[data-chat-entry="${learning.id}:learning"] [data-learning-line] button`);
    await until(async () => (await snap()).state.room === "studio", "learning opens Studio");
    await click(`nav [data-thread="${learning.thread_id}"]`);
    await capture("outcome-and-learning");
    // After a finished build Mode is the chat's own Loop again: no new-build choice, the time limit to pick.
    await click('[aria-label="Mode"]');
    const options = await op("snapshot", { surface: "desktop", scope: '[aria-label="Mode options"]', limit: 40 });
    assert.doesNotMatch(options.text, /new build/i);
    assert.ok(!options.controls.some((c) => /new build/i.test(c.text ?? "")));
    const limit = await op("snapshot", { surface: "desktop", scope: '[aria-label="Loop time limit"]', limit: 20 });
    assert.ok(limit.controls.some((c) => c.text === "Custom"));
    await capture("mode-after-finished-build");
    await key("Escape");
    assert.match((await snap()).controls.find((c) => c.label === "Mode")?.text ?? "", /Loop$/);
  });
  await check(
    "unavailable plans offer model recovery, preserve the request and retry on the chosen provider",
    async () => {
      await click('nav [data-project="model-recovery"]');
      await until(async () => (await snap()).text.includes("This model is unavailable"), "recovery banner");
      let s = await snap();
      assert.ok(!s.controls.some((c) => c.text === "Approve" || c.text === "Make changes"));
      for (const text of ["Choose model", "Model providers", "Try again", "Dismiss"])
        assert.ok(s.controls.some((c) => c.text === text && c.cursor === "pointer"));
      await capture("model-unavailable");
      await click("[data-model-recovery] button:nth-child(2)");
      await until(async () => (await snap()).controls.some((c) => c.text === "Model Providers"), "provider settings");
      await key("Escape");
      await pause(300);
      await click("[data-model-recovery] button:first-child");
      await click('[data-role="planner"]');
      await click('[data-model-choice="codex::fixture-v1"]');
      await key("Escape");
      await click("[data-model-recovery] button:nth-child(3)");
      await until(
        async () => (await snap()).controls.some((c) => c.text === "Approve" && !c.disabled),
        "retry produced a reviewable plan",
      );
      await capture("recovered-plan");
      await click("[data-plan-cancel]");
    },
  );
  await check(
    "a direct build shows connected cards and revision-matched captures without empty worker stages",
    async () => {
      await click('nav [data-project="director-result"]');
      await until(async () => {
        const s = await snap();
        return !s.text.includes("Loading conversation") && s.controls.some((c) => c.text === "Builds");
      }, "director conversation loaded");
      await pressStageView(click, "builds");
      await key("0", "Digit0");
      await until(async () => {
        const s = await snap();
        return (
          s.text.includes("You asked") && s.text.includes("Your build") && s.images.filter((i) => i.loaded).length >= 2
        );
      }, "saved run captures");
      await click('[data-graph-node="start"]');
      // Flipped: the start card no longer names the build length (AG-968); a finished build shows none.
      await until(async () => (await snap()).text.includes("Started from"), "the start card");
      const s = await snap();
      assert.doesNotMatch(
        s.text,
        /Your prompt|No reference images|0 tasks contributed|0 integrations|Optimization|never judged/,
      );
      await capture("direct-build-graph");
    },
  );
  let thread;
  await check("a newly created game inherits the selected provider and model", async () => {
    await click('[aria-label="Model settings"]');
    await click('[data-role="planner"]');
    await click('[data-model-choice="codex::fixture-v1"]');
    await key("Escape");
    thread = await launchAndAsk();
    const handoff = events(thread).find((e) => e.data.event_type === "contractor_handoff").data.payload;
    assert.equal(handoff.engine, "codex");
    assert.equal(handoff.model, "fixture-v1");
    // Flipped (step 1): the handoff names the Loop chat's launch tool instead of `interview: true`.
    assert.match(String(handoff.launch), /^start_(autopilot|unattended_run)$/);
    report.modelInheritance = { engine: handoff.engine, model: handoff.model };
    await capture("question");
  });
  await check("choice selection waits for confirmation and preserves an existing draft", async () => {
    assert.ok((await snap()).controls.some((c) => c.text === "Send answer" && c.disabled));
    await type('[aria-label="Prompt"]', "Keep this draft");
    await click(`${question} input[value="0"]`);
    await pause(300);
    assert.ok((await snap()).controls.some((c) => c.text === "Send answer" && !c.disabled));
    assert.equal(
      events(thread)
        .filter((e) => e.data.type === "messages")
        .flatMap((e) => e.data.messages)
        .filter((m) => m.role === "user").length,
      1,
    );
    await click(`${question} button[type="submit"]`);
    await answered();
    assert.equal((await snap()).controls.find((c) => c.label === "Prompt")?.value, "Keep this draft");
    assert.equal(
      events(thread)
        .filter((e) => e.data.type === "messages")
        .flatMap((e) => e.data.messages)
        .filter((m) => m.role === "user" && m.content === "Ashlands").length,
      1,
    );
    assert.ok(
      events(thread)
        .filter((e) => e.data.type === "turn_ended")
        .every((e) => e.data.status === "ok"),
    );
    await capture("answered");
  });
  await check("an unanswered question survives restart and accepts a custom response", async () => {
    thread = await launchAndAsk();
    await click(`${question} [data-question-chat]`);
    assert.ok((await snap()).controls.some((c) => c.text === "Answer question"));
    assert.equal((await snap()).activeTag, "TEXTAREA");
    report.restartedIdentity = await cli(["restart", "--profile", profile]);
    attach();
    await click(`nav [data-thread="${thread}"]`);
    await until(async () => (await snap()).controls.some((c) => c.text === "Send answer"), "question restored");
    await type(`${question} [data-question-own] input[type="text"]`, "Actually, a coast at night");
    assert.ok(
      (await snap()).controls.some((c) => c.text === "Send answer" && !c.disabled),
      "typing picks the own answer",
    );
    await key("Enter");
    await answered();
    const log = events(thread);
    assert.ok(!log.some((e) => e.data.event_type === "run_started"));
    assert.match(
      String(log.filter((e) => e.data.event_type === "contractor_handoff").at(-1).data.payload.launch),
      /^start_(autopilot|unattended_run)$/,
    );
    assert.match((await snap()).text, /Actually, a coast at night/);
    await capture("custom-answer");
  });
  await check("held run plans receive approval and custom changes immediately, without a queued turn", async () => {
    for (const choice of ["approval", "changes"]) {
      await click(`nav [data-project="plan-${choice}"]`);
      // The run settled by the restart resolves its outcome after the card appears, one line taller,
      // moving the choices a row down: a click measured before that lands on the other choice.
      await until(async () => {
        const s = await snap();
        return s.controls.some((c) => c.value === "approve") && s.text.includes("No new build");
      }, "held plan below the settled run");
      thread = (await snap()).state.activeThread;
      await click(`${question} input[value="${choice === "approval" ? "approve" : "revise"}"]`);
      await click(`${question} button[type="submit"]`);
      if (choice === "changes") {
        await type('[aria-label="Prompt"]', "Use warmer lighting");
        await key("Enter");
      }
      await until(() => events(thread).some((e) => e.data.event_type === "run_steering"), "plan answer delivered");
      assert.match(
        events(thread).find((e) => e.data.event_type === "run_steering").data.payload.text,
        choice === "approval" ? /go$/ : /Use warmer lighting$/,
      );
      assert.ok(!events(thread).some((e) => e.data.event_type === "message_queued"));
      await until(
        async () => !(await snap()).controls.some((c) => c.value === "approve"),
        "plan answer reflected in the chat",
      );
    }
  });
} catch (error) {
  report.error = error.stack;
  console.error(error);
  if (descriptor) {
    try {
      fs.writeFileSync(path.join(evidence, "failure.json"), JSON.stringify(await snap(), null, 2));
      await capture("failure");
    } catch {}
  }
} finally {
  if (started)
    try {
      await cli(["stop", "--profile", profile]);
      await cli(["clean", "--profile", profile]);
    } catch (e) {
      report.error ??= e.stack;
    }
  report.result = report.error ? "fail" : "pass";
  save();
  console.log(`Chat feedback UI: ${report.result}; ${path.relative(root, path.join(evidence, "report.json"))}`);
  if (report.error) process.exitCode = 1;
}
