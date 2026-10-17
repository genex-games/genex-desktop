/** Long-history and streaming acceptance using real input in an owned fixture. */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "../../scripts/studio-dev/client.ts";
import { sourceIdentity } from "../../scripts/studio-dev/files.mjs";
const root = process.cwd(),
  profile = `chat-ui-${Date.now()}`,
  evidence = path.join(root, ".studio-dev/evidence", profile);
fs.mkdirSync(evidence, { recursive: true });
/** Longer than one tick of a running clock (a second), so a measurement cannot fall between ticks. */
const CLOCK_WINDOW_MS = 1500;
const selectedCheck = process.argv.find((arg) => arg.startsWith("--check="))?.slice(8);
const report = {
  profile,
  selectedCheck,
  source: sourceIdentity(root),
  checks: [],
  artifacts: [],
  measurements: [],
  limitations: [
    "Synthetic fixture providers. No live accounts or paid generations. CPU profile covers only the renderer.",
  ],
};
let descriptor,
  started = false;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const save = () => fs.writeFileSync(path.join(evidence, "report.json"), JSON.stringify(report, null, 2) + "\n");
async function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/studio-dev.ts", ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(out + err));
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(e);
      }
    });
  });
}
const op = async (method, params = {}) => {
  try {
    return await request(descriptor, { method, params });
  } catch (e) {
    e.message = `${method} ${JSON.stringify(params)}: ${e.message}`;
    throw e;
  }
};
const snap = () => op("snapshot", { surface: "desktop", limit: 300 });
const scroll = (deltaY) => op("scroll", { surface: "desktop", selector: "[data-chat-scroll]", deltaX: 0, deltaY });
async function until(fn, label) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    if (await fn()) return;
    await pause(80);
  }
  throw new Error(`Timed out: ${label}`);
}
async function capture(name) {
  await op("capture", { surface: "desktop", name: `${name}-paint` });
  await pause(250);
  report.artifacts.push(await op("capture", { surface: "desktop", name }));
  save();
}
async function check(name, fn) {
  if (
    selectedCheck &&
    !name.includes(selectedCheck) &&
    !(selectedCheck === "generated" && name.startsWith("permission"))
  )
    return;
  try {
    await fn();
    report.checks.push({ name, status: "pass" });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, status: "fail", detail: error.stack });
    console.error(`FAIL ${name}: ${error.message}`);
    if (descriptor)
      try {
        fs.writeFileSync(
          path.join(evidence, `failure-${report.checks.length}.json`),
          JSON.stringify(await snap(), null, 2),
        );
        await capture(`failure-${report.checks.length}`);
      } catch {}
    throw error;
  } finally {
    save();
  }
}
async function stableChat() {
  let previous = "",
    same = 0;
  await until(async () => {
    const s = (await snap()).chat;
    const signature = JSON.stringify([s.scrollTop, s.scrollHeight, s.mounted, s.firstEntry]);
    same = signature === previous ? same + 1 : 0;
    previous = signature;
    if (same >= 3) return true;
    await pause(100);
    return false;
  }, "transcript measurements settle");
}
const latest = async () => {
  await scroll(10000);
  await stableChat();
};
// Looks the given way first, then the other way: the target's distance from the end moves whenever the transcript's tail changes.
async function clickInChat(selector, direction = 1) {
  for (let n = 0; n < 30; n++) {
    await stableChat();
    try {
      return await op("click", { selector });
    } catch (e) {
      if (e.code !== "target-not-visible") throw e;
    }
    await scroll((n < 8 ? direction : -direction) * 300);
    await pause(100);
  }
  throw new Error(`Could not scroll to ${selector}`);
}
// The dock shows one waiting card at a time, so its controls never scroll out of reach. It glides
// to each new card's height, and a control still clipped by that glide is tried again.
async function clickQuestion(selector) {
  for (let n = 0; ; n++) {
    try {
      return await op("click", { selector });
    } catch (e) {
      if (e.code !== "target-not-visible" || n >= 10) throw e;
    }
    await pause(100);
  }
}
try {
  report.identity = await cli(["start", "--profile", profile, "--fixture", "chat-questions"]);
  started = true;
  descriptor = JSON.parse(fs.readFileSync(path.join(root, `.studio-dev/profiles/${profile}/controller.json`), "utf8"));
  await check("permission question stays reachable and submits only after explicit confirmation", async () => {
    await until(async () => (await snap()).text.includes("Use the new moon texture in this game?"), "question visible");
    assert.equal((await snap()).stage.stageView, "builds", "an active run opens the Builds panel");
    // Claude's own cards (a command, then a plan) and the plugin's wait one at a time, in the order
    // they were asked, the rest counted instead of stacked into a scroll of their own.
    const shown = async () =>
      (await op("snapshot", { surface: "desktop", scope: "[data-pending-questions] > div", limit: 40 })).text;
    const showing = (title, more) =>
      until(
        async () => {
          const text = await shown();
          const count = (await snap()).text.match(/\d more waiting/)?.[0] ?? "";
          return text.includes(title) && count === more;
        },
        `${title} on show, ${more || "nothing"} behind it`,
      );
    await showing("Claude wants to run a command", "2 more waiting");
    assert.doesNotMatch(await shown(), /Approve this plan\?|Use the new moon texture/, "one card at a time");
    const continues = async () => (await snap()).controls.filter((c) => c.text === "Continue").length;
    assert.equal(await continues(), 1, "only the card on show offers Continue");
    assert.ok((await snap()).controls.some((c) => c.text === "Continue" && c.disabled));
    const command = '[data-pending-questions] [data-chat-question]:has(input[value="deny"])';
    await clickQuestion(command + ' input[value="deny"]');
    await pause(500);
    assert.ok(
      (await snap()).controls.some((c) => c.text === "Continue" && !c.disabled),
      "selection must not auto-submit",
    );
    await clickQuestion(command + ' [aria-label="Put question aside"]');
    await until(
      async () => (await snap()).controls.some((c) => c.text === "Review permission request"),
      "the card put aside",
    );
    await op("key", { surface: "desktop", key: "Enter", code: "Enter" });
    await until(
      async () => (await snap()).controls.some((c) => c.text === "Continue" && !c.disabled),
      "reopen preserves selection",
    );
    await capture("permission-question");
    // Answer every card (deny the command, approve the plan asking first, decline the plugin), so the
    // build is the only thing still running: a waiting question keeps the chat's own busy line up instead.
    await clickQuestion(command + ' button[type="submit"]');
    await showing("Approve this plan?", "1 more waiting");
    const plan = '[data-pending-questions] [data-chat-question]:has(input[value="default"])';
    await clickQuestion(plan + ' input[value="default"]');
    await clickQuestion(plan + ' button[type="submit"]');
    await showing("Use the new moon texture in this game?", "");
    const form = '[data-pending-questions] [data-chat-question]:has(input[value="decline"])';
    await clickQuestion(form + ' input[value="decline"]');
    await clickQuestion(form + ' button[type="submit"]');
    await until(
      async () => (await continues()) === 0 && (await snap()).text.includes("Declined"),
      "durable answer, nothing left waiting",
    );
    await latest();
  });
  await check("opens at the latest reply with a bounded transcript and collapsed tools", async () => {
    await until(async () => {
      const s = await snap();
      return s.chat && s.chat.scrollHeight - s.chat.clientHeight - s.chat.scrollTop < 3;
    }, "initial bottom");
    const s = await snap();
    report.measurements.push({ phase: "initial", ...s.chat });
    assert.ok(s.chat.total > 20 && s.chat.total < 160);
    assert.ok(s.chat.mounted < s.chat.total);
    assert.equal(s.chat.toolRows, 0);
    assert.equal(s.chat.toolDetails, 0);
    // One status for the build, one line at a time: no list of parts under it (they live on Builds).
    assert.ok(!s.chatLayout.some((row) => row.kind === "worker"), "no worker rows under the build status");
    assert.doesNotMatch(s.text, /Warm lights in the villageFinished/);
    // The build is its one card: the part at work in one line, and on the right its clock and cap.
    assert.match(s.text, /BuildingWooden bridge across the river · working\d+[hms](?: \d+[ms])?up to 30m/);
    // Only the build runs now (the question is answered): chat shows the build row, not its own working status.
    assert.ok(!s.chatLayout.some((row) => row.kind === "status"), "a running build is not chat work");
    const build = await op("snapshot", {
      surface: "desktop",
      scope: "[data-chat-scroll] [data-build-status]",
      limit: 20,
    });
    assert.match(build.text, /^Building/);
    // Mode names the running build's own Loop: a 30-minute limit leads with its time. Intentionally
    // flipped: Mode opens during the build, read-only, for the chat's "Don't wait for me" switch.
    const mode = (await op("snapshot", { surface: "desktop", scope: "[data-promptbar]", limit: 40 })).controls.find(
      (c) => c.label === "Mode",
    );
    assert.equal(mode?.text, "30m Loop", "Mode shows the running build's limit");
    assert.equal(mode?.disabled, false, "Mode opens during the build; its Loop is shown, not changed");
    assert.ok(
      build.controls.some((c) => c.text === "Building" && c.title === "Open in Builds"),
      "the build card opens Builds",
    );
    report.measurements.push({ phase: "reference-geometry", rows: s.chatLayout });
    assert.ok(
      !s.controls.some((c) => c.text === "Play it"),
      "a build with no delivered revision offers no Play it action",
    );
    assert.equal(s.chat.overflowX, 0);
    await capture("current-task");
  });
  await check("generated image loads, opens a modal and opens the project Assets view", async () => {
    await op("click", { selector: "[data-stage-action=live]" });
    await until(async () => (await snap()).stage.stageView === "live", "native Live visible");
    await op("game.state");
    await scroll(-350);
    await pause(300);
    await until(async () => (await snap()).images.some((i) => i.alt === "Asset preview" && i.loaded), "image preview");
    await clickInChat('[data-chat-assets] button[aria-label="Preview village-cover.png"]', -1);
    await until(
      async () => (await snap()).images.some((i) => i.alt === "village-cover.png" && i.loaded),
      "image modal",
    );
    await capture("image-result");
    await op("click", { selector: "[data-testid=asset-preview] [aria-label=Close]" });
    await until(
      async () => !(await snap()).controls.some((c) => c.label === "See the picture at full size"),
      "pointer closes modal over Live",
    );
    await clickInChat('[data-chat-assets] button[aria-label="Preview village-cover.png"]', -1);
    await until(
      async () => (await snap()).controls.some((c) => c.label === "See the picture at full size"),
      "image reopened",
    );
    await op("key", { surface: "desktop", key: "Escape", code: "Escape" });
    await until(
      async () => !(await snap()).controls.some((c) => c.label === "See the picture at full size"),
      "keyboard closes image",
    );
    await clickInChat("[data-open-assets]");
    await until(async () => (await snap()).stage.stageView === "assets", "Assets view");
  });
  await check("tool groups mount a bounded page, preserve failures, and reveal results on demand", async () => {
    await latest();
    await clickInChat("[data-work-log]:has(> button > span.text-orange) > button", -1);
    await until(async () => (await snap()).chat.toolRows === 30, "tool rows expanded");
    const s = await snap();
    assert.equal(s.chat.toolRows, 30);
    assert.equal(s.chat.toolDetails, 0);
    assert.match(s.text, /1 failed/);
    assert.ok(s.chatLayout.filter((row) => row.kind === "tool").every((row) => row.height >= 24));
    await scroll(1000);
    await pause(300);
    await clickInChat('[data-tool-state="failed"] [data-tool-toggle]');
    await until(async () => (await snap()).chat.toolDetails === 1, "failed tool result");
    assert.match((await snap()).text, /Could not read the optional texture/);
    await capture("tool-result");
  });
  await check("earlier history loads ahead of the reader and keeps their place", async () => {
    await latest();
    const before = await snap();
    assert.doesNotMatch(before.text, /Load earlier messages/);
    // Two screens below the loaded top: within reach, so the next page loads before the top is ever reached.
    const reading = before.chat.clientHeight * 2;
    await scroll(reading - before.chat.scrollTop);
    await until(async () => (await snap()).chat.total > before.chat.total, "the next page loads ahead");
    await stableChat();
    const after = (await snap()).chat;
    // The page landed above the reader: the scroll grew by its height instead of the rows jumping down.
    assert.ok(after.scrollTop > reading + after.clientHeight, `kept place at ${after.scrollTop}`);
  });
  await check("loading old pages keeps rendering bounded and lets the reader return to latest", async () => {
    await op("cpu.start", { surface: "desktop", profileId: "history-scroll" });
    for (let n = 0; n < 7; n++) {
      await scroll(-10000);
      await pause(180);
    }
    await until(async () => (await snap()).chat.total > 500, "older pages loaded");
    const s = await snap();
    report.measurements.push({ phase: "history-loaded", ...s.chat });
    assert.ok(s.chat.mounted < 55);
    assert.equal(s.chat.overflowX, 0);
    assert.ok(s.chat.scrollTop < s.chat.scrollHeight - s.chat.clientHeight - 500);
    await capture("older-history");
    await op("click", { selector: "[data-chat-scroll] + button" });
    await until(async () => {
      const s = await snap();
      return s.chat.scrollHeight - s.chat.clientHeight - s.chat.scrollTop < 3;
    }, "jump to latest");
    report.artifacts.push(await op("cpu.stop", { surface: "desktop", profileId: "history-scroll" }));
  });
  await check("thread navigation preserves drafts and resets the selected history page", async () => {
    const beforeTyping = (await snap()).performance?.ChatConversation?.commits;
    assert.equal(typeof beforeTyping, "number", "fixture exposes conversation commit count");
    // The running build's clock ticks inside the conversation, and a draft may re-render late: the
    // window spans more than a tick, so either would count.
    const build = await op("snapshot", {
      surface: "desktop",
      scope: "[data-chat-scroll] [data-build-status]",
      limit: 20,
    });
    assert.match(build.text, /\d+[hms](?: \d+[ms])?up to 30m$/, "the build's clock is in the conversation");
    await op("type", { selector: '[aria-label="Prompt"]', text: "Keep this game idea", replace: true });
    await pause(CLOCK_WINDOW_MS);
    assert.equal(
      (await snap()).performance.ChatConversation.commits,
      beforeTyping,
      "typing commits no conversation subtree",
    );
    await op("click", { selector: 'nav [data-thread="studio"]' });
    await until(async () => (await snap()).state.room === "studio", "Studio chat");
    await op("key", { surface: "desktop", key: "1", code: "Digit1", modifiers: ["Meta"] });
    await until(
      async () =>
        (await snap()).state.room === "build" &&
        (await snap()).controls.find((c) => c.label === "Prompt")?.value === "Keep this game idea",
      "draft restored",
    );
    assert.ok((await snap()).chat.total < 160);
    await op("type", { selector: '[aria-label="Prompt"]', text: "", replace: true });
  });
  await check("real delta events render before completion and reconcile to one durable reply", async () => {
    await op("click", { selector: 'nav [data-thread="studio"]' });
    await until(async () => (await snap()).state.room === "studio", "Studio chat");
    await pause(300); // The pane transition completes after the selected room changes.
    await op("type", { selector: '[aria-label="Prompt"]', text: "fixture:stream", replace: true });
    await op("key", { surface: "desktop", key: "Enter", code: "Enter" });
    let writing;
    await until(async () => {
      const s = await snap();
      writing = s.chatLayout.find((row) => row.kind === "status");
      return s.chat?.streaming && s.text.includes("Writing a reply") && writing;
    }, "partial reply with writing status");
    // The chat's own work: a shimmering status line, no spinner.
    assert.equal(writing.spinnerCount, 0);
    assert.equal(writing.shimmer, "shimmer-text");
    report.measurements.push({ phase: "status-geometry", row: writing });
    await capture("streaming");
    await op("key", { surface: "desktop", key: "1", code: "Digit1", modifiers: ["Meta"] });
    await until(async () => (await snap()).state.room === "build", "switch during stream");
    assert.equal((await snap()).chat.streaming, false, "another game never shows the Studio reply");
    await op("click", { selector: 'nav [data-thread="studio"]' });
    await until(
      async () => (await snap()).state.room === "studio" && (await snap()).text.includes("Fixture Studio reply:"),
      "stream prefix survives navigation",
    );
    await until(async () => {
      const s = await snap();
      return !s.chat.streaming && s.text.includes("instruction changes in Activity.");
    }, "durable reply");
    assert.equal(((await snap()).text.match(/Fixture Studio reply:/g) ?? []).length, 1);
    await capture("stream-complete");
  });
  await check("every message offers Rewind, and one a build followed rewinds the conversation alone", async () => {
    const rewind = "Rewind to before this message";
    const offered = async () => (await snap()).controls.filter((c) => c.label === rewind).length;
    await op("click", { selector: 'nav [data-project="rewind-chat"]' });
    await until(async () => (await snap()).text.includes("And make them glow."), "the rewind chat");
    await stableChat();
    // Six messages: one from before the queue, the first, one a build followed, one whose answer
    // failed, one answered, and one read into that answer.
    await until(async () => (await offered()) === 6, "Rewind beside every message");
    await op("click", {
      selector: `[data-chat-entry]:nth-child(3 of [data-chat-entry$=":user"]) [aria-label="${rewind}"]`,
    });
    const dialog = '[data-testid="rewind-dialog"]';
    await until(async () => (await snap()).text.includes("a build changed the game after this message"), "why");
    const shown = await op("snapshot", { surface: "desktop", scope: dialog, limit: 20 });
    assert.match(shown.text, /Only the conversation rewinds: a build changed the game after this message/);
    assert.doesNotMatch(shown.text, /Restore game files/, "no switch when the files cannot come back");
    assert.ok(
      shown.controls.some((c) => c.text === "Rewind chat" && !c.disabled),
      "the button still rewinds the chat",
    );
    await capture("rewind-chat-only");
    await op("key", { surface: "desktop", key: "Escape", code: "Escape" });
    await until(async () => !(await snap()).text.includes("Rewind to before this message?"), "dialog closed");
    assert.equal(await offered(), 6, "cancelled: the chat is as it was");
  });
} catch (error) {
  report.error = error.stack;
} finally {
  if (started)
    try {
      await cli(["stop", "--profile", profile]);
      await cli(["clean", "--profile", profile]);
    } catch (error) {
      report.checks.push({ name: "owned profile cleanup", status: "fail", detail: error.message });
    }
  report.result = report.error || report.checks.some((c) => c.status === "fail") ? "fail" : "pass";
  save();
  console.log(`Chat UI: ${report.result}; ${path.relative(root, path.join(evidence, "report.json"))}`);
  if (report.result !== "pass") process.exitCode = 1;
}
