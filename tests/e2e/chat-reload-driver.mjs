/** Actual host status survives a renderer reload, without restarting a pending provider. */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = arg("reload-out"),
  main = arg("reload-main");
const profile = path.dirname(arg("studio-dev-launch"));
const build = JSON.parse(fs.readFileSync(path.resolve(main, "../../build.json"), "utf8"));
const checks = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let wc;
const js = (code) => wc.executeJavaScript(code, true);
async function until(code) {
  for (let n = 0; n < 200; n++) {
    if (await js(code).catch(() => false)) return true;
    await wait(50);
  }
  return false;
}
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
  if (!ok) throw Error(name);
}
async function click(selector) {
  const point = await js(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
  );
  await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...point,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...point,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}
await import(pathToFileURL(main).href);
async function acceptance() {
  try {
    for (let n = 0; n < 300 && !fs.existsSync(path.join(profile, "controller.json")); n++) await wait(100);
    // The window can open a moment after the controller is written.
    for (let n = 0; n < 300 && !BrowserWindow.getAllWindows().length; n++) await wait(100);
    const win = BrowserWindow.getAllWindows()[0];
    wc = win.webContents;
    win.setFocusable(false);
    win.setPosition(-4000, 0);
    win.showInactive();
    wc.debugger.attach("1.3");
    check("owned app is ready", await until(`!!document.querySelector('[aria-label="Prompt"]')`));
    await click('[aria-label="Prompt"]');
    await wc.debugger.sendCommand("Input.insertText", { text: "fixture:pending Keep building until I stop you." });
    await click('[aria-label="Send"]');
    check(
      "pending provider has current status and composer Stop",
      await until(`!!document.querySelector('[aria-label="Stop"]') && !!document.querySelector('[data-chat-status]')`),
    );
    check(
      "host has started the pending operation",
      await until(
        `(async()=>Object.values((await window.studio.bootstrap()).threadStatus??{}).some(s=>s.status!=='idle'))()`,
      ),
    );
    // The session itself is running (not still being prepared): a message now reaches it mid-turn.
    check(
      "the chat session is running",
      await until(
        `(async()=>(await window.studio.events()).events.some(e=>e.data.type==='custom'&&e.data.event_type==='session_activity'&&e.data.payload?.phase==='thinking'))()`,
      ),
    );
    await click('[aria-label="Prompt"]');
    await wc.debugger.sendCommand("Input.insertText", { text: "Add a purple cube" });
    check(
      "follow-up composer is ready to send",
      await until(`!!document.querySelector('[aria-label="Send"]:not(:disabled)')`),
    );
    await click('[aria-label="Send"]');
    // Steer: the running turn reads it at once, so it sits in the conversation above the live
    // status (where it was read), not below the work as waiting input; the work goes on.
    const steeredInPlace = `(()=>{const status=document.querySelector('[data-chat-status]');const rows=[...document.querySelectorAll('[aria-label="Conversation"] [data-chat-entry]')].filter(e=>e.textContent.includes('Add a purple cube'));return rows.length===1 && !document.querySelector('[data-queued-message]') && !!status && !!(rows[0].compareDocumentPosition(status)&Node.DOCUMENT_POSITION_FOLLOWING) && !!document.querySelector('[aria-label="Stop"]');})()`;
    check(
      "a follow-up joins the running turn and reads where the turn read it",
      await until(steeredInPlace),
      await js("document.body.innerText").catch(() => null),
    );
    const delivered = async () =>
      (await js("window.studio.events()")).events.filter(
        (e) => e.data.type === "custom" && e.data.event_type === "coordinator_message_delivered",
      );
    const record = await delivered();
    // Read mid-turn (an engine that takes input) or by interrupting and resuming the session (Codex).
    check(
      "its delivery is recorded once, into the running turn",
      record.length === 1 && ["native", "interrupt"].includes(record[0].data.payload.how),
      record.map((e) => e.data.payload),
    );
    await wc.capturePage();
    await wait(200);
    fs.writeFileSync(path.join(out, "steered-in-place.png"), (await wc.capturePage()).toPNG());
    // A message that cannot join the turn (one for a model that holds no session, which this turn
    // cannot go on with) waits below the work as Sending…, with Remove to withdraw it.
    await js(
      `(async()=>{const sent=(await window.studio.events()).events.find(e=>e.data.type==='custom'&&e.data.event_type==='coordinator_message_queued'&&e.data.payload?.action?.text==='Add a purple cube');await window.studio.send("Add a red sphere",{thread:sent.thread_id,engine:"ollama"});})()`,
    );
    check(
      "a follow-up the turn cannot take waits below the current work as Sending…, with Remove",
      await until(
        `(()=>{const q=document.querySelector('[data-queued-message]');const status=document.querySelector('[data-chat-status]');return !!q?.textContent.includes('Add a red sphere') && q.querySelector('[role="status"]')?.textContent === 'Sending…' && !!q.querySelector('[aria-label="Remove queued message"]') && !q.querySelector('[aria-label="Edit queued message"]') && !!status && !!(status.compareDocumentPosition(q)&Node.DOCUMENT_POSITION_FOLLOWING);})()`,
      ),
    );
    await wc.capturePage();
    await wait(200);
    fs.writeFileSync(path.join(out, "refused-queued.png"), (await wc.capturePage()).toPNG());
    // Remove withdraws it, so reload and Stop below start from the one turn in flight.
    await click('[data-queued-message] [aria-label="Remove queued message"]');
    check(
      "a withdrawn follow-up leaves the transcript",
      await until(
        `!document.querySelector('[data-queued-message]') && !document.querySelector('[aria-label="Conversation"]')?.textContent.includes('Add a red sphere')`,
      ),
    );
    const before = await js("window.studio.bootstrap()");
    const active = Object.entries(before.threadStatus ?? {}).find(([, s]) => s.status !== "idle");
    check(
      "bootstrap carries authoritative active state and start time",
      !!active && active[1].since > 0,
      before.threadStatus,
    );
    await new Promise((resolve) => {
      wc.once("did-finish-load", resolve);
      wc.reload();
    });
    check(
      "reload restores current status and Stop without another provider event",
      await until(`!!document.querySelector('[aria-label="Stop"]') && !!document.querySelector('[data-chat-status]')`),
      await js(
        `(async()=>({text:document.body.innerText,selection:localStorage.getItem('studio.activeThread'),status:(await window.studio.bootstrap()).threadStatus,harness:(await window.studio.bootstrap()).harness}))()`,
      ),
    );
    const after = await js("window.studio.bootstrap()");
    check(
      "reload preserves the original timer start",
      after.threadStatus?.[active[0]]?.since === active[1].since,
      after.threadStatus,
    );
    check("reload keeps the steered message where the turn read it", await until(steeredInPlace));
    check("reload records no second delivery", (await delivered()).length === 1);
    await wc.capturePage();
    await wait(200);
    fs.writeFileSync(path.join(out, "active-after-reload.png"), (await wc.capturePage()).toPNG());
    await click('[aria-label="Stop"]');
    check(
      "restored Stop actually cancels the pending operation",
      await until(`!document.querySelector('[aria-label="Stop"]') && !document.querySelector('[data-chat-status]')`),
    );
    const stopped = await js("window.studio.bootstrap()");
    check(
      "host snapshot settles after cancellation",
      Object.values(stopped.threadStatus ?? {}).every((s) => s.status === "idle"),
      stopped.threadStatus,
    );
    // The turn had read the steered message: Stop leaves it answered there, never asked again.
    const fate = (await js("window.studio.events()")).events
      .filter(
        (e) =>
          e.data.type === "custom" &&
          e.data.event_type.startsWith("coordinator_message_") &&
          e.data.payload?.messageId === record[0].data.payload.messageId,
      )
      .map((e) => e.data.event_type);
    check(
      "Stop leaves the steered message read, not queued again",
      fate.at(-1) === "coordinator_message_delivered" && !fate.includes("coordinator_message_processing"),
      fate,
    );
    await new Promise((resolve) => {
      wc.once("did-finish-load", resolve);
      wc.reload();
    });
    check(
      "second reload keeps settled work idle",
      await until(
        `!!document.querySelector('[aria-label="Send"]') && !document.querySelector('[aria-label="Stop"]') && !document.querySelector('[data-chat-status]')`,
      ),
    );
  } catch (error) {
    checks.push({
      name: "reload acceptance completed",
      ok: false,
      detail: String(error.stack),
      dom: await js("document.body.innerText").catch(() => null),
    });
  } finally {
    fs.writeFileSync(
      path.join(out, "report.json"),
      JSON.stringify(
        {
          buildId: build.buildId,
          sourceDigest: build.sourceDigest,
          outputDigest: build.outputDigest,
          profile: path.basename(profile),
          providers: "fixture",
          electron: process.versions.electron,
          checks,
        },
        null,
        2,
      ),
    );
    app.quit();
  }
}
void acceptance();
