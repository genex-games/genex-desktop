/** Refinement acceptance through real desktop input in owned, credential-disabled fixtures. */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "../../scripts/studio-dev/client.ts";
import { sourceIdentity } from "../../scripts/studio-dev/files.mjs";

const root = process.cwd(),
  runId = `ux-${Date.now()}`,
  evidence = path.join(root, ".studio-dev/evidence", runId);
fs.mkdirSync(evidence, { recursive: true });
const report = {
  runId,
  source: sourceIdentity(root),
  checks: [],
  instances: [],
  artifacts: [],
  limitations: ["Fixture providers only; no live accounts, downloads or paid requests."],
};
const active = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const save = () => fs.writeFileSync(path.join(evidence, "report.json"), JSON.stringify(report, null, 2) + "\n");
async function cli(args) {
  return await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["scripts/studio-dev.ts", ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (err += b));
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code !== 0) return reject(new Error(out + err));
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(e);
      }
    });
  });
}
async function start(suffix, fixture) {
  const profile = `${runId}-${suffix}`;
  const identity = await cli(["start", "--profile", profile, "--fixture", fixture]);
  const i = {
    profile,
    identity,
    descriptor: JSON.parse(fs.readFileSync(path.join(root, `.studio-dev/profiles/${profile}/controller.json`), "utf8")),
  };
  active.push(i);
  report.instances.push(identity);
  return i;
}
const op = async (i, method, params = {}) => {
  try {
    return await request(i.descriptor, { method, params });
  } catch (e) {
    e.message = `${method} ${JSON.stringify(params)}: ${e.message}`;
    throw e;
  }
};
const snap = (i, scope) => op(i, "snapshot", { surface: "desktop", ...(scope ? { scope } : {}) });
async function until(fn, label) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    if (await fn()) return;
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}
/**
 * Two toggles in one place: the same x, and centres within half a pixel (the chat header's 1px
 * bottom border sits inside its 48px, so its middle is 23.5px down).
 */
function assertSamePlace(a, b, message) {
  assert.equal(a.x, b.x, message);
  assert.ok(Math.abs(a.y - b.y) <= 0.5, `${message}: ${a.y} vs ${b.y}`);
}
/** An earlier build opens from its result card in the chat: scroll the conversation up to it. */
async function openBuildFromChat(i, runId) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    try {
      await op(i, "click", { selector: `button[data-open-build="${runId}"]` });
      return;
    } catch (e) {
      if (!/target-not-visible/.test(e.message)) throw e;
      await op(i, "scroll", { surface: "desktop", selector: "[data-chat-scroll]", deltaX: 0, deltaY: -600 });
      await pause(150);
    }
  }
  throw new Error(`Timed out: Open in Builds for ${runId}`);
}
async function check(name, fn) {
  try {
    await fn();
    report.checks.push({ name, status: "pass" });
    console.log(`PASS ${name}`);
  } catch (e) {
    report.checks.push({ name, status: "fail", detail: e.stack });
    console.error(`FAIL ${name}: ${e.message}`);
    const current = active.at(-1);
    if (current) {
      try {
        fs.writeFileSync(
          path.join(evidence, `failure-${report.checks.length}.json`),
          JSON.stringify(await snap(current), null, 2),
        );
        await capture(current, `failure-${report.checks.length}`);
      } catch {}
    }
  }
  save();
}
async function capture(i, name) {
  await op(i, "capture", { surface: "desktop", name: `${name}-paint` });
  await pause(350);
  const result = await op(i, "capture", { surface: "desktop", name });
  report.artifacts.push(result);
  save();
}
try {
  const i = await start("app", "sidebar");
  await check("sidebar toggles and Command-K reveals and focuses search", async () => {
    const hide = await op(i, "click", { selector: '[aria-label="Hide sidebar"]' });
    await until(async () => (await snap(i)).state.sidebarOpen === "false", "sidebar collapsed");
    assert.ok(!(await snap(i)).controls.some((c) => c.thread === "studio"));
    await capture(i, "sidebar-hidden");
    await op(i, "key", { surface: "desktop", key: "k", code: "KeyK", modifiers: ["Meta"] });
    await until(
      async () => (await snap(i)).state.sidebarOpen === "false" && (await snap(i)).activeTag === "INPUT",
      "search focus",
    );
    await op(i, "key", { surface: "desktop", key: "Escape", code: "Escape" });
    await until(async () => !(await snap(i)).controls.some((c) => c.label === "Close search"), "search closed");
    const show = await op(i, "click", { selector: '[aria-label="Show sidebar"]' });
    await until(async () => (await snap(i)).state.sidebarOpen === "true", "sidebar restored");
    assertSamePlace(show, hide, "the chat header's toggle keeps the sidebar's place");
  });
  await check("Studio shows its own chat beside Activity and preserves unsent game text", async () => {
    await op(i, "type", { selector: '[aria-label="Prompt"]', text: "Unsent game idea", replace: true });
    await op(i, "click", { selector: 'nav [data-thread="studio"]' });
    await until(
      async () => (await snap(i)).state.room === "studio" && (await snap(i)).controls.some((c) => c.label === "Prompt"),
      "Studio chat",
    );
    await snap(i, '[data-testid="review-panel"]');
    assert.equal((await snap(i)).controls.find((c) => c.label === "Prompt").value, "");
    assert.ok(!(await snap(i)).controls.some((c) => c.label === "Export game"));
    await op(i, "type", { selector: '[aria-label="Prompt"]', text: "Unsent Studio question", replace: true });
    await capture(i, "studio-chat-review");
    await op(i, "key", { surface: "desktop", key: "1", code: "Digit1", modifiers: ["Meta"] });
    await until(
      async () => (await snap(i)).state.activeThread === i.identity.selection.activeThread,
      "return to same game chat",
    );
    assert.equal((await snap(i)).controls.find((c) => c.label === "Prompt").value, "Unsent game idea");
    await op(i, "type", { selector: '[aria-label="Prompt"]', text: "", replace: true });
  });
  await check("Plugins opens as a page and preserves workspace keyboard navigation", async () => {
    await op(i, "scroll", { surface: "desktop", selector: "[data-sidebar-scroll]", deltaX: 0, deltaY: -1200 });
    await op(i, "click", { selector: 'nav [aria-label="Plugins"]' });
    await until(async () => {
      try {
        await snap(i, "[data-plugins-page]");
        return true;
      } catch {
        return false;
      }
    }, "Plugins page");
    await op(i, "key", { surface: "desktop", key: "2", code: "Digit2", modifiers: ["Meta"] });
    assert.equal((await snap(i)).state.room, "studio");
    await op(i, "click", { selector: 'nav [aria-label="Plugins"]' });
    await capture(i, "sidebar-plugins");
    const hide = await op(i, "click", { selector: '[aria-label="Hide sidebar"]' });
    await until(async () => (await snap(i)).state.sidebarOpen === "false", "sidebar collapsed over Plugins");
    const show = await op(i, "click", { selector: '[data-plugins-page] [aria-label="Show sidebar"]' });
    await until(async () => (await snap(i)).state.sidebarOpen === "true", "sidebar restored over Plugins");
    assertSamePlace(show, hide, "the Plugins toolbar's toggle keeps the sidebar's place");
    await op(i, "key", { surface: "desktop", key: "1", code: "Digit1", modifiers: ["Meta"] });
    await until(async () => (await snap(i)).state.room === "build", "Plugins closed");
  });
  await check("chat title editing cancels with Escape and preserves the original", async () => {
    await op(i, "click", { selector: '[data-chat-header] button[aria-label^="Rename game:"]' });
    await until(async () => (await snap(i)).controls.some((c) => c.label === "Game name"), "rename input");
    await op(i, "type", {
      selector: '[data-chat-header] input[aria-label="Game name"]',
      text: "Discard this edit",
      replace: true,
    });
    await op(i, "key", { surface: "desktop", key: "Escape", code: "Escape" });
    await until(
      async () => (await snap(i)).controls.some((c) => c.label === "Rename game: Fixture Game"),
      "original title",
    );
  });
  // Every fixture model names a game started from home the same (`fixture-engines.ts`).
  const made = { title: "Tiny Island Fishing", project: "tiny-island-fishing" };
  await check(
    "New game is home: its first message makes a folder, and search opens its only conversation",
    async () => {
      await op(i, "key", { surface: "desktop", key: "n", code: "KeyN", modifiers: ["Meta"] });
      await until(async () => (await snap(i)).state.room === "home", "home");
      await until(async () => (await snap(i)).activeTag === "TEXTAREA", "home's composer focused");
      assert.ok(!(await snap(i)).controls.some((c) => c.label === "Game name"), "no New game dialog");
      await capture(i, "new-game-home");
      await op(i, "type", {
        selector: '[data-home-composer] [aria-label="Prompt"]',
        text: "A snowy temple to explore",
        replace: true,
      });
      await op(i, "key", { surface: "desktop", key: "Enter", code: "Enter" });
      await until(async () => (await snap(i)).state.project === made.project, "new folder selected");
      await until(async () => (await snap(i)).state.room !== "home", "new conversation");
      const first = (await snap(i)).state.activeThread;
      await op(i, "click", { selector: '[aria-label="Search games"]' });
      await op(i, "type", { selector: 'input[aria-label="Search games"]', text: "zzqxv", replace: true });
      await until(async () => (await snap(i)).text.includes("No games for"), "no results");
      await op(i, "type", { selector: 'input[aria-label="Search games"]', text: "tiny", replace: true });
      await until(
        async () => (await snap(i, "#game-search-results")).controls.some((c) => c.text?.includes(made.title)),
        "search result",
      );
      await capture(i, "game-search");
      await op(i, "key", { surface: "desktop", key: "Enter", code: "Enter" });
      await until(async () => !(await snap(i)).controls.some((c) => c.label === "Close search"), "result opened");
      assert.equal((await snap(i)).state.activeThread, first);
      await op(i, "click", { selector: 'nav [data-project="fixture-game"]' });
    },
  );
  await check("pin, rename and delete menu preserve files and update the library", async () => {
    await op(i, "click", { selector: `[aria-label="Actions for ${made.title}"]` });
    await capture(i, "game-actions");
    await op(i, "click", { selector: '[data-game-action="pin"]' });
    await until(
      async () =>
        (await snap(i, "nav")).controls.filter((c) => c.thread && c.thread !== "studio")[0]?.text === made.title,
      "pin moved first",
    );
    await op(i, "click", { selector: `[aria-label="Actions for ${made.title}"]` });
    await op(i, "click", { selector: '[data-game-action="rename"]' });
    await op(i, "type", { selector: '[role="dialog"] input', text: "Snow Temple II", replace: true });
    await op(i, "click", { selector: '[role="dialog"] button[type="submit"]' });
    await until(async () => (await snap(i, "nav")).text.includes("Snow Temple II"), "name saved");
    await op(i, "click", { selector: '[aria-label="Actions for Snow Temple II"]' });
    await op(i, "click", { selector: '[data-game-action="cover"]' });
    await capture(i, "image-preview");
    await op(i, "key", { surface: "desktop", key: "Escape", code: "Escape" });
    await until(async () => !(await snap(i)).controls.some((c) => c.label === "Close"), "image dialog closed");
    await op(i, "click", { selector: `nav [data-project="${made.project}"]` });
    await until(async () => (await snap(i)).state.project === made.project, "game selected before removal");
    await op(i, "click", { selector: '[aria-label="Actions for Snow Temple II"]' });
    await op(i, "click", { selector: '[data-game-action="delete"]' });
    await capture(i, "delete-game");
    assert.match((await snap(i, '[role="dialog"]')).text, /files and conversation history stay/);
    await op(i, "key", { surface: "desktop", key: "Tab", code: "Tab" });
    await op(i, "click", { selector: '[role="dialog"] button[data-delete-game]' });
    await until(async () => !(await snap(i, "nav")).text.includes("Snow Temple II"), "game removed");
    assert.ok(fs.existsSync(path.join(i.identity.roots.games, made.project, "studio.json")), "folder is retained");
    // Intentionally flipped: removing the game on the stage used to open Studio; it opens home.
    await until(
      async () => (await snap(i)).state.room === "home" && (await snap(i)).state.project === "",
      "removed game leaves active workspace",
    );
    assert.ok(
      !(await snap(i)).controls.some((c) => c.label === "Game to review"),
      "the activity feed has no game selector",
    );
    await op(i, "click", { selector: 'nav [data-project="fixture-game"]' });
  });
  await check("only the brand, search and New game remain above a scrolled library", async () => {
    await capture(i, "sidebar-default");
    await op(i, "scroll", { surface: "desktop", selector: "[data-sidebar-scroll]", deltaX: 0, deltaY: 540 });
    await until(async () => {
      try {
        await snap(i, 'nav[data-scrolled="true"]');
        return true;
      } catch {
        return false;
      }
    }, "scrolled state");
    await capture(i, "sidebar-scrolled");
    await op(i, "click", { selector: '[aria-label="Search games"]' });
    await until(
      async () =>
        (await snap(i)).controls.some((c) => c.label === "Close search") && (await snap(i)).activeTag === "INPUT",
      "search opened from scrolled library",
    );
    await op(i, "key", { surface: "desktop", key: "Escape", code: "Escape" });
    await until(
      async () => !(await snap(i)).controls.some((c) => c.label === "Close search"),
      "search closed before scrolling",
    );
    await op(i, "scroll", { surface: "desktop", selector: "[data-sidebar-scroll]", deltaX: 0, deltaY: -1000 });
    await until(async () => {
      try {
        await snap(i, 'nav[data-scrolled="false"]');
        return true;
      } catch {
        return false;
      }
    }, "scroll reset");
  });
  await capture(i, "build");
  await op(i, "click", { selector: 'nav [data-thread="studio"]' });
  await until(async () => (await snap(i)).state.room === "studio", "Review");
  await check("an empty Activity says what Harness is and leads back to the game", async () => {
    // Activity loads after the room opens; the empty state is what it settles on.
    await until(
      async () => /A self-improving harness/.test((await snap(i, '[data-testid="review-panel"]')).text),
      "empty Activity",
    );
    const panel = await snap(i, '[data-testid="review-panel"]');
    assert.ok(panel.controls.some((c) => c.text === "Start building" && !c.disabled && c.cursor === "pointer"));
    assert.ok(
      !panel.controls.some(
        (c) => /Harness settings|Start a timed run|Model Providers/.test(c.text ?? "") || c.tag === "TEXTAREA",
      ),
      "no settings or run form in Activity",
    );
  });
  await capture(i, "review");
  await op(i, "click", { selector: 'nav [aria-label="Settings"]' });
  await op(i, "click", { selector: "#settings-tab-harness" });
  await check("Settings → Harness holds automatic suggestions and maximum workers", async () => {
    await until(async () => {
      const section = await snap(i, "[data-harness-settings]");
      return (
        /Maximum concurrent workers/.test(section.text) && section.controls.some((c) => c.label === "More workers")
      );
    }, "Harness settings");
  });
  await capture(i, "settings");
  await op(i, "key", { surface: "desktop", key: "Escape", code: "Escape" });
  const history = await start("history", "build-history");
  await op(history, "click", { selector: 'button[data-stage-action="builds"]' });
  await until(async () => (await snap(history)).stage.stageView === "builds", "Builds");
  await check("build revision details open and close independently", async () => {
    await until(async () => {
      try {
        await op(history, "click", { scope: "[data-stage-view]", selector: '[data-graph-node="final"]' });
        return true;
      } catch {
        return false;
      }
    }, "the build node loaded");
    const details = '[data-graph-panel="final"] [data-panel-row="technical-details"]';
    await op(history, "click", { scope: "[data-stage-view]", selector: details });
    const detail = await snap(history, '[data-stage-view] [data-testid="build-details"]');
    assert.match(detail.text, /Available revision:/);
    assert.match(detail.text, /recorded integration/);
    await op(history, "click", { scope: "[data-stage-view]", selector: details });
    await until(async () => {
      try {
        await snap(history, '[data-stage-view] [data-testid="build-details"]');
        return false;
      } catch {
        return true;
      }
    }, "technical details closed");
    await op(history, "click", {
      scope: "[data-stage-view]",
      selector: '[data-graph-panel="final"] button[aria-label="Close (Esc)"]',
    });
  });
  await check("Studio round trip preserves the selected build history", async () => {
    await openBuildFromChat(history, "fixture-build-1");
    const selected = (await snap(history)).stage.selectedRun;
    await op(history, "click", { selector: 'nav [data-thread="studio"]' });
    await until(async () => (await snap(history)).state.room === "studio", "Studio");
    await op(history, "key", { surface: "desktop", key: "1", code: "Digit1", modifiers: ["Meta"] });
    await until(async () => (await snap(history)).state.room === "build", "game workspace");
    assert.equal((await snap(history)).stage.stageView, "builds");
    assert.equal((await snap(history)).stage.selectedRun, selected);
  });
  await capture(history, "build-history");
} catch (error) {
  report.checks.push({ name: "acceptance flow", status: "fail", detail: error.stack });
  console.error(error.stack);
} finally {
  for (const i of active.reverse()) {
    try {
      await cli(["stop", "--profile", i.profile]);
      await cli(["clean", "--profile", i.profile]);
    } catch (e) {
      report.checks.push({ name: `clean ${i.profile}`, status: "fail", detail: e.message });
    }
  }
  report.result = report.checks.some((c) => c.status === "fail") ? "fail" : "pass";
  save();
  console.log(`UX refinement: ${report.result}; ${path.relative(root, path.join(evidence, "report.json"))}`);
  if (report.result !== "pass") process.exitCode = 1;
}
