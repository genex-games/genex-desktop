/** Real Electron acceptance. Named fixture preparation is separate from asserted UI input. */
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { request, requestWhenReachable } from "../../scripts/studio-dev/client.ts";
import { sourceIdentity, maintained, hash, writeJson } from "../../scripts/studio-dev/files.mjs";
const root = fs.realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const runId = `accept-${Date.now()}`,
  evidence = path.join(root, ".studio-dev/evidence", runId);
fs.mkdirSync(evidence, { recursive: true });
const report = {
  version: 1,
  scenario: "agentic-readiness",
  runId,
  startedAt: new Date().toISOString(),
  source: sourceIdentity(root),
  prerequisites: [
    "macOS display/compositor",
    "installed pinned Electron",
    "local process sandbox",
    "fixture providers; no vendor account",
  ],
  checks: [],
  instances: [],
  artifacts: [],
  limitations: [
    "Native/vendor authorization and packaged-main plus development OS identity combination are not exercised",
    "Game input uses existing PreviewInputAction contract; desktop input uses main-owned CDP",
    "Shared dependency bytes beyond lock/version/path identity are not immutable",
  ],
};
const active = [];
function save() {
  writeJson(path.join(evidence, "report.json"), report);
}
async function check(name, surface, expected, fn) {
  const at = new Date().toISOString(),
    artifactStart = report.artifacts.length;
  try {
    const observed = await fn();
    report.checks.push({
      name,
      surface,
      expected,
      observed: observed ?? "as expected",
      status: "pass",
      at,
      artifacts: [],
    });
    console.log(`PASS ${name}`);
  } catch (e) {
    report.checks.push({
      name,
      surface,
      expected,
      observed: e.stack,
      status: e.code === "missing-prerequisite" ? "unverified" : "fail",
      at,
      artifacts: [],
    });
    console.error(`FAIL ${name}: ${e.message}`);
    // A dialog or menu a failed check leaves open covers the chat for every later check on that
    // window: close it, so the failure is reported once rather than as theirs too.
    for (const i of active) await closeLeftLayers(i).catch(() => {});
  }
  report.checks.at(-1).artifacts = report.artifacts.slice(artifactStart).map((a) => a.file);
  save();
}
async function cli(checkout, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/studio-dev.ts", ...args], {
      cwd: checkout,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.on("data", (b) => {
      out = (out + b).slice(-2 * 1024 * 1024);
    });
    child.stderr.on("data", (b) => {
      err = (err + b).slice(-256 * 1024);
    });
    const timer = setTimeout(() => reject(new Error("CLI timeout; inspect owned instance, no broad kill")), 90000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error((out + err).slice(0, 6000)));
      else {
        try {
          resolve(JSON.parse(out));
        } catch (e) {
          reject(new Error(`invalid CLI output: ${out}`));
        }
      }
    });
  });
}
async function start(checkout, profile, fixture, reuse = false) {
  const identity = await cli(checkout, [
    "start",
    "--profile",
    profile,
    "--fixture",
    fixture,
    ...(reuse ? ["--reuse"] : []),
  ]);
  const instance = {
    checkout,
    profile,
    identity,
    descriptor: JSON.parse(
      fs.readFileSync(path.join(checkout, `.studio-dev/profiles/${profile}/controller.json`), "utf8"),
    ),
  };
  active.push(instance);
  report.instances.push(identity);
  save();
  return instance;
}
const op = async (i, method, params = {}) => {
  try {
    return await request(i.descriptor, { method, params });
  } catch (e) {
    e.message = `${method} ${JSON.stringify(params)}: ${e.message}`;
    throw e;
  }
};
/** Like `op`, for an input whose target may not take pointer input yet (a dialog or menu still opening). */
const reach = async (i, method, params) => {
  try {
    return await requestWhenReachable(i.descriptor, { method, params });
  } catch (e) {
    e.message = `${method} ${JSON.stringify(params)}: ${e.message}`;
    throw e;
  }
};
const snapshot = (i) => op(i, "snapshot", { surface: "desktop" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
      await sleep(150);
    }
  }
  throw new Error(`timeout: Open in Builds for ${runId}`);
}
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout;
  let value;
  while (Date.now() < end) {
    value = await fn();
    if (value) return value;
    await sleep(150);
  }
  throw new Error(`timeout: ${label}`);
}
async function screenshot(i, surface, name) {
  const result = await op(i, "capture", { surface, name });
  const bytes = fs.readFileSync(result.file);
  assert.equal(bytes.subarray(1, 4).toString(), "PNG");
  assert.ok(result.dimensions.width > 100 && result.dimensions.height > 100);
  assert.equal(result.focused, false);
  const dest = path.join(evidence, path.basename(result.file));
  fs.copyFileSync(result.file, dest);
  report.artifacts.push({ ...result, file: path.relative(root, dest), sha256: hash(bytes) });
  return result;
}
/** The orchestrator's model list: one level in when the chat has roles, the panel itself otherwise. */
async function openModelList(i) {
  await op(i, "click", { selector: '[aria-label="Model settings"]' });
  await until(
    async () =>
      (
        await op(i, "snapshot", {
          surface: "desktop",
          scope: '[data-slot="popover-content"][aria-label="Model options"]',
        })
      ).text.length > 0,
    "model options",
  );
  if (
    !(await op(i, "snapshot", { surface: "desktop", scope: '[data-model-view="list"]' }).catch(() => null))?.controls
      ?.length
  )
    await op(i, "click", { selector: '[data-role="planner"]' });
  return until(
    async () =>
      (await op(i, "snapshot", { surface: "desktop", scope: '[data-model-list="planner"]' })).controls.some(
        (c) => c.text?.includes("Fixture v1") && c.tag === "BUTTON",
      ),
    "named model list",
  );
}
async function closeModelPicker(i) {
  // Escape closes the model list first, then the panel.
  for (
    let n = 0;
    n < 3 && (await snapshot(i)).controls.find((c) => c.label === "Model settings")?.expanded === "true";
    n++
  ) {
    await op(i, "key", { surface: "desktop", key: "Escape", code: "Escape", modifiers: [] });
    await sleep(250);
  }
}
/** Is this control the search dialog, or a picker or menu trigger whose layer is still open? */
const leftOpen = (c) =>
  c.label === "Close search" || (c.expanded === "true" && ["Model settings", "Chat actions"].includes(c.label));
async function closeLeftLayers(i) {
  for (let n = 0; n < 3 && (await snapshot(i)).controls.some(leftOpen); n++) {
    await op(i, "key", { surface: "desktop", key: "Escape", code: "Escape", modifiers: [] });
    await sleep(250);
  }
}
async function stop(i) {
  const result = await cli(i.checkout, ["stop", "--profile", i.profile]);
  active.splice(active.indexOf(i), 1);
  return result;
}
function prepareCheckout(name) {
  const dest = path.join(root, ".studio-dev/checkouts", runId, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", root, dest], { stdio: "pipe" });
  execFileSync("git", ["reset", "--quiet", "HEAD"], { cwd: dest, stdio: "pipe" });
  for (const file of maintained(root)) {
    fs.mkdirSync(path.dirname(path.join(dest, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(dest, file));
  }
  fs.cpSync(path.join(root, "docs"), path.join(dest, "docs"), { recursive: true });
  fs.symlinkSync(path.join(root, "node_modules"), path.join(dest, "node_modules"), "dir");
  writeJson(path.join(dest, ".ag933-checkout-owner.json"), {
    version: 1,
    runId,
    source: root,
    purpose: "disposable acceptance checkout; no existing worktree modified",
  });
  return dest;
}
let a, b, sentinel;
try {
  const checkoutA = prepareCheckout("a"),
    checkoutB = prepareCheckout("b");
  a = await start(checkoutA, "fixture", "run-controls");
  b = await start(checkoutB, "fixture", "app-basics");
  sentinel = await start(root, `${runId}-sentinel`, "sentinel");
  await check(
    "parallel roots and actual build identity",
    "lifecycle",
    "two separate Git checkouts plus sentinel; all roots distinct and unfocused",
    async () => {
      for (const key of ["electron", "session", "core", "games"])
        assert.equal(new Set([a, b, sentinel].map((i) => i.identity.roots[key])).size, 3);
      for (const i of [a, b, sentinel]) {
        const s = await op(i, "status");
        assert.equal(s.stale, false);
        assert.equal(s.window.focused, false);
        assert.equal(s.readiness, "ready");
        assert.equal(s.harness.shippedDigest, s.harness.runtimeDigest);
        assert.equal(
          s.electron,
          JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).devDependencies.electron,
        );
        assert.ok(s.window.title.includes(s.profileId) && s.window.title.includes(s.buildId));
        assert.ok(!(await snapshot(i)).text.includes("Dev b-"));
      }
      return [a, b, sentinel].map((i) => ({ checkout: i.checkout, profile: i.profile, pid: i.identity.pid }));
    },
  );
  await check(
    "duplicate profile cannot launch",
    "lifecycle",
    "explicit refusal, original identity unchanged",
    async () => {
      await assert.rejects(
        cli(a.checkout, ["start", "--profile", a.profile, "--reuse", "--fixture", "run-controls"]),
        /running|ownership/,
      );
      assert.equal((await op(a, "status")).instanceId, a.identity.instanceId);
    },
  );
  await check(
    "Build Review navigation and ranked game search",
    "desktop",
    "room/project/thread observed from real DOM and CSS resolved",
    async () => {
      await op(b, "click", { selector: 'nav [data-thread="studio"]' });
      await until(async () => (await snapshot(b)).state.room === "studio", "Studio workspace");
      await op(b, "key", { surface: "desktop", key: "1", code: "Digit1", modifiers: ["Meta"] });
      await until(async () => (await snapshot(b)).state.room === "build", "Build keyboard shortcut");
      await op(b, "key", { surface: "desktop", key: "k", code: "KeyK", modifiers: ["Meta"] });
      await reach(b, "type", {
        selector: 'input[aria-label="Search games"]',
        text: "no matching project",
        replace: true,
      });
      await until(async () => (await snapshot(b)).text.includes("No games for"), "no results");
      await op(b, "type", { selector: 'input[aria-label="Search games"]', text: "Fixture", replace: true });
      await until(
        async () =>
          (await op(b, "snapshot", { surface: "desktop", scope: "#game-search-results" })).controls.some((c) =>
            c.text?.includes("Fixture Game"),
          ),
        "search results",
      );
      await op(b, "key", { surface: "desktop", key: "Enter", code: "Enter" });
      await until(async () => !(await snapshot(b)).controls.some((c) => c.label === "Close search"), "search closed");
      await openModelList(b);
      await closeModelPicker(b);
      await until(
        async () => (await snapshot(b)).controls.find((c) => c.label === "Model settings")?.expanded === "false",
        "model menu closed",
      );
      const s = await snapshot(b);
      assert.equal(s.state.project, "fixture-game");
      assert.match(s.style.font, /Zalando Sans SemiExpanded/);
      assert.notEqual(s.style.background, "rgba(0, 0, 0, 0)");
      await screenshot(b, "desktop", "app-basics");
      return s.state;
    },
  );
  await check(
    "background Unicode, newline, Send and durable coordinator response",
    "desktop",
    "Unicode/newline input reaches coordinator without new commission",
    async () => {
      await op(a, "type", { selector: '[aria-label="Prompt"]', text: "Привет 🌿", replace: true });
      await op(a, "key", { surface: "desktop", key: "Enter", code: "Enter", modifiers: ["Shift"] });
      const s = await snapshot(a);
      assert.equal(s.controls.find((c) => c.label === "Prompt").value, "Привет 🌿\n");
      await op(a, "click", { selector: 'button[aria-label="Send"]' });
      await until(
        async () => (await snapshot(a)).text.includes("Fixture response. No new build was started."),
        "coordinator response",
      );
      const events = (await op(a, "logs", { surface: "core", limit: 200 })).entries;
      assert.equal(events.filter((e) => e.data.type === "custom" && e.data.event_type === "run_started").length, 2);
      assert.ok(!events.some((e) => e.data.event_type === "run_registered"));
      assert.equal((await op(a, "status")).window.focused, false);
      return { commissions: 2, response: "Fixture response. No new build was started." };
    },
  );
  await check(
    "build history pointer navigation and graph details",
    "desktop",
    "earlier run and actual saved health/capture visible",
    async () => {
      await openBuildFromChat(a, "fixture-build-1");
      await until(async () => {
        const s = await snapshot(a);
        return s.stage.selectedRun === "fixture-build-1" && s.text.includes("River and bridge");
      }, "earlier history graph");
      // The selected run changes before its complete host summary has arrived. Wait for the
      // actual pointer target to become visible; chat text alone can belong to the earlier render.
      await reach(a, "click", { selector: '[data-graph-node="start"]' });
      await until(
        async () => (await snapshot(a)).text.includes("Fixture base: camera views were identical"),
        "base health",
      );
      await until(
        async () =>
          (await op(a, "snapshot", { surface: "desktop", scope: '[data-testid="build-capture"]' })).images.some(
            (i) => i.loaded,
          ),
        "saved base capture loaded",
      );
      await screenshot(a, "desktop", "build-history");
      await assert.rejects(op(a, "capture", { surface: "game", name: "unavailable-game" }), /missing-prerequisite/);
      return (await snapshot(a)).stage;
    },
  );
  await check(
    "real Stop pointer-down aborts controlled pending coordinator",
    "desktop",
    "engine AbortSignal rejection and durable turn end",
    async () => {
      const coreLog = async () => (await op(a, "logs", { surface: "core", limit: 200 })).entries;
      const before = new Set((await coreLog()).filter((e) => e.data.type === "turn_started").map((e) => e.turn_id));
      await op(a, "type", {
        selector: '[aria-label="Prompt"]',
        text: "fixture:pending cancellation proof",
        replace: true,
      });
      await op(a, "click", { selector: 'button[aria-label="Send"]' });
      await until(async () => (await snapshot(a)).controls.some((c) => c.label === "Stop"), "pending Stop");
      // This message's own turn, with its engine at work: a Stop before it begins ends it before any
      // engine runs, which is not the abort this check is about. An earlier turn is never taken for it.
      const pending = await until(async () => {
        const entries = await coreLog();
        const started = entries.findIndex((e) => e.data.type === "turn_started" && !before.has(e.turn_id));
        if (started < 0) return false;
        const working = entries
          .slice(started)
          .some((e) => e.data.event_type === "session_activity" && e.data.payload?.phase === "thinking");
        return working ? entries[started].turn_id : false;
      }, "the controlled pending turn's engine to start");
      assert.ok(pending, "the controlled pending turn started");
      await op(a, "click", { selector: '[data-promptbar] button[aria-label="Stop"]' });
      const entries = await until(async () => {
        const entries = (await op(a, "logs", { surface: "core", limit: 200 })).entries;
        return entries.some(
          (e) =>
            e.turn_id === pending &&
            e.data.event_type === "session_activity" &&
            e.data.payload?.phase === "interrupted",
        ) && entries.some((e) => e.turn_id === pending && e.data.type === "turn_ended" && e.data.status === "cancelled")
          ? entries
          : false;
      }, "durable cancellation");
      fs.writeFileSync(path.join(evidence, "cancellation-events.json"), JSON.stringify(entries, null, 2));
      report.artifacts.push({
        surface: "core",
        file: path.relative(root, path.join(evidence, "cancellation-events.json")),
      });
      await screenshot(a, "desktop", "run-controls");
      return { abortObserved: true, turnEndObserved: true };
    },
  );
  await check(
    "game state input and separate compositor capture",
    "game",
    "fixture state/input changes and two distinct actual images",
    async () => {
      const before = await op(b, "game.state");
      assert.equal(before.fixture, 1);
      await op(b, "game.input", { actions: [{ type: "click", x: 0.2, y: 0.2 }] });
      const after = await op(b, "game.state");
      assert.ok(after.clicks > before.clicks);
      const game = await screenshot(b, "game", "game-surface"),
        desktop = await screenshot(b, "desktop", "desktop-separate");
      assert.notEqual(hash(fs.readFileSync(game.file)), hash(fs.readFileSync(desktop.file)));
      assert.equal((await op(b, "status")).window.focused, false);
      return { before, after };
    },
  );
  await check(
    "chat picker preserves or occludes the native game by overlap",
    "desktop/game",
    "non-overlapping options preserve the game; overlapping model list occludes it, then Escape restores it",
    async () => {
      await op(b, "click", { selector: '[aria-label="Model settings"]' });
      await until(
        async () =>
          (
            await op(b, "snapshot", {
              surface: "desktop",
              scope: '[data-slot="popover-content"][aria-label="Model options"]',
            })
          ).text.includes("Main agent"),
        "model options",
      );
      await screenshot(b, "desktop", "genex-model-options");
      await screenshot(b, "game", "genex-visible-under-chat-picker");
      await op(b, "click", { selector: '[data-role="planner"]' });
      await until(
        async () =>
          (await op(b, "snapshot", { surface: "desktop", scope: '[data-model-list="planner"]' })).controls.some(
            (c) => c.text?.includes("Fixture v1") && c.tag === "BUTTON",
          ),
        "named model list",
      );
      await screenshot(b, "desktop", "genex-model-list");
      // The named list extends over the game pane at the acceptance window size.
      // Native content must yield to the DOM overlay, then return when it closes.
      assert.equal((await op(b, "status")).selection.stageView, "live");
      await assert.rejects(
        op(b, "capture", { surface: "game", name: "genex-occluded-model-list" }),
        /missing-prerequisite/,
      );
      await closeModelPicker(b);
      await until(
        async () => (await snapshot(b)).controls.find((c) => c.label === "Model settings")?.expanded === "false",
        "picker closed",
      );
      await sleep(300);
      await screenshot(b, "game", "genex-restored-game");
      return { optionsPreserveGame: true, overlappingListOccludesGame: true, visibleAfterEscape: true };
    },
  );
  await check(
    "fixture native action is blocked in the real main route",
    "desktop",
    "Export fails explicitly before external Finder action",
    async () => {
      assert.ok((await snapshot(b)).controls.some((c) => c.label === "Chat actions"));
      // Every stage-strip control — Studio's own and any plugin toolbar button — must stay uniquely
      // labelled: control.ts refuses an ambiguous selector, so a duplicate label is an unreachable
      // control. This is what the manifest's reserved-label and aria-uniqueness rules protect.
      const strip = (await op(b, "snapshot", { surface: "desktop", scope: "[data-stage-strip]" })).controls
        .map((c) => c.label)
        .filter(Boolean);
      assert.equal(new Set(strip).size, strip.length, `duplicate stage-strip control label: ${strip.join(", ")}`);
      await op(b, "click", { selector: '[data-chat-header] button[aria-label="Chat actions"]' });
      await reach(b, "click", { selector: '[data-chat-action="export"]' });
      // The toast sentence-cases what the studio throws (renderer words.ts problemWords), so match the reason, not its casing.
      await until(
        async () => (await snapshot(b)).text.toLowerCase().includes("unsupported-in-fixture"),
        "native guard error",
      );
    },
  );
  await check(
    "wrong identity capability and invalid/ambiguous target failures",
    "controller",
    "explicit non-pass and no cross-instance action",
    async () => {
      await assert.rejects(
        request({ ...a.descriptor, instanceId: randomUUID() }, { method: "status", params: {} }),
        /wrong-instance/,
      );
      await assert.rejects(
        request({ ...a.descriptor, capability: "0".repeat(64) }, { method: "stop", params: {} }),
        /wrong-instance/,
      );
      await assert.rejects(op(b, "click", { selector: "button" }), /ambiguous-selector/);
      await assert.rejects(op(b, "click", { selector: "[" }), /invalid-selector/);
      await assert.rejects(op(b, "click", { selector: ".no-such-target" }), /target-not-visible/);
      await assert.rejects(
        op(b, "cpu.stop", { surface: "desktop", profileId: "never-started" }),
        /missing-prerequisite/,
      );
      assert.equal((await op(a, "status")).readiness, "ready");
    },
  );
  await check(
    "selected renderer CPU heap and bounded trace",
    "diagnostics",
    "real parseable CPU/heap/trace files and overlap failure",
    async () => {
      await op(b, "cpu.start", { surface: "desktop", profileId: "cpu" });
      await assert.rejects(op(b, "cpu.start", { surface: "desktop", profileId: "duplicate" }), /busy/);
      await snapshot(b);
      const cpu = await op(b, "cpu.stop", { surface: "desktop", profileId: "cpu" });
      assert.ok(JSON.parse(fs.readFileSync(cpu.file, "utf8")).nodes.length > 0);
      const heap = await op(b, "heap", { surface: "desktop", name: "heap" });
      assert.ok(JSON.parse(fs.readFileSync(heap.file, "utf8")).snapshot);
      await op(b, "trace.start", { traceId: "timeline", durationMs: 1500, categories: ["devtools.timeline"] });
      await snapshot(b);
      const trace = await op(b, "trace.stop", { traceId: "timeline" });
      assert.ok(JSON.parse(fs.readFileSync(trace.file, "utf8")).traceEvents.length > 0);
      report.artifacts.push(cpu, heap, trace);
      return { cpu: cpu.file, heapBytes: heap.bytes, traceBytes: trace.bytes };
    },
  );
  // A third app continues actual pending work while the selected checkout restarts.
  await op(sentinel, "type", {
    selector: '[aria-label="Prompt"]',
    text: "fixture:pending sentinel remains active",
    replace: true,
  });
  await op(sentinel, "click", { selector: 'button[aria-label="Send"]' });
  await sleep(800);
  const sentinelEvents = (await op(sentinel, "logs", { surface: "core", limit: 200 })).entries,
    sentinelGame = hash(fs.readFileSync(path.join(sentinel.identity.roots.games, "fixture-game/index.html")));
  const bHistory = (await op(b, "logs", { surface: "core", limit: 200 })).entries;
  await check(
    "evolved profile stale-build rejection and restart noninterference",
    "lifecycle",
    "preserved runtime self-edit; new build; sentinel and second checkout untouched",
    async () => {
      const runtimeFile = path.join(a.identity.roots.core, "workspaces/harness/prompts/identity.md"),
        sourceFile = path.join(a.checkout, "src/harness-seed/prompts/identity.md");
      fs.appendFileSync(runtimeFile, "\n<!-- AG-933 runtime self-edit -->\n");
      const evolved = fs.readFileSync(runtimeFile, "utf8");
      fs.appendFileSync(sourceFile, "\n<!-- AG-933 shipped seed change -->\n");
      assert.equal((await op(a, "status")).stale, true);
      await assert.rejects(op(a, "click", { selector: 'nav [data-thread="studio"]' }), /stale-build/);
      const old = a.identity.buildId;
      await stop(a);
      a = await start(checkoutA, "fixture", "run-controls", true);
      assert.notEqual(a.identity.buildId, old);
      assert.equal(fs.readFileSync(runtimeFile, "utf8"), evolved);
      assert.ok(a.identity.harness.divergentPaths.includes("prompts/identity.md"));
      const fresh = await start(checkoutA, "fresh", "app-basics");
      assert.equal(fresh.identity.harness.runtimeDigest, fresh.identity.harness.shippedDigest);
      await stop(fresh);
      assert.deepEqual((await op(sentinel, "logs", { surface: "core", limit: 200 })).entries, sentinelEvents);
      assert.equal(
        hash(fs.readFileSync(path.join(sentinel.identity.roots.games, "fixture-game/index.html"))),
        sentinelGame,
      );
      assert.deepEqual((await op(b, "logs", { surface: "core", limit: 200 })).entries, bHistory);
      assert.equal((await op(sentinel, "status")).window.focused, false);
      assert.ok((await snapshot(sentinel)).controls.some((c) => c.label === "Stop"));
      return { oldBuild: old, newBuild: a.identity.buildId, divergence: a.identity.harness.divergentPaths };
    },
  );
  await check(
    "clean owned disposable state preserves durable evidence",
    "lifecycle",
    "stopped profile removed and evidence survives",
    async () => {
      const dir = b.identity.evidenceRoot;
      const rendererLogs = await op(b, "logs", { surface: "desktop", limit: 200 });
      assert.ok(
        !rendererLogs.entries.some((e) => e.level === "error" || e.level === "3"),
        "unexpected renderer error in app-basics",
      );
      const logFile = path.join(evidence, "app-basics-renderer-logs.json");
      writeJson(logFile, { version: 1, ...rendererLogs });
      report.artifacts.push({ surface: "desktop", file: path.relative(root, logFile) });
      await assert.rejects(cli(b.checkout, ["clean", "--profile", b.profile]), /running|ownership/);
      await stop(b);
      await cli(b.checkout, ["clean", "--profile", b.profile]);
      assert.ok(fs.existsSync(dir));
      assert.ok(!fs.existsSync(path.join(b.checkout, `.studio-dev/profiles/${b.profile}`)));
      return { evidencePreserved: dir };
    },
  );
  for (const i of active) {
    const identity = await op(i, "status");
    report.instances.push({ ...identity, reportCompletion: true });
    for (const surface of ["desktop", "game", "harness", "stdout", "stderr"]) {
      const logs = await op(i, "logs", { surface, limit: 200 });
      writeJson(path.join(evidence, `${i.profile}-${identity.instanceId}-${surface}-logs.json`), {
        version: 1,
        ...logs,
      });
      if (surface === "desktop")
        assert.ok(!logs.entries.some((e) => e.level === "error" || e.level === "3"), "unexpected renderer error");
    }
  }
} catch (e) {
  report.checks.push({
    name: "scenario setup/execution",
    surface: "lifecycle",
    expected: "fixture instances ready",
    observed: e.stack,
    status: process.platform !== "darwin" ? "unverified" : "fail",
    at: new Date().toISOString(),
  });
} finally {
  for (const i of [...active]) {
    try {
      await stop(i);
    } catch (e) {
      report.checks.push({
        name: `cleanup ${i.profile}`,
        surface: "lifecycle",
        status: "fail",
        expected: "authenticated shutdown and actual process exit",
        observed: e.message,
        at: new Date().toISOString(),
      });
    }
  }
  report.finishedAt = new Date().toISOString();
  report.result = report.checks.some((c) => c.status === "fail")
    ? "fail"
    : report.checks.some((c) => c.status === "unverified")
      ? "unverified"
      : "pass";
  save();
  console.log(`Agentic readiness: ${report.result}; ${path.relative(root, path.join(evidence, "report.json"))}`);
  process.exitCode = report.result === "pass" ? 0 : report.result === "fail" ? 1 : 2;
}
