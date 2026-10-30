/** Real Studio input in a disposable app. Model responses and history are explicitly synthetic. */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = arg("studio-out"),
  main = arg("studio-main");
const launch = JSON.parse(fs.readFileSync(arg("studio-dev-launch"), "utf8"));
const profile = path.dirname(arg("studio-dev-launch"));
const build = JSON.parse(fs.readFileSync(path.resolve(main, "../../build.json"), "utf8"));
const checks = [],
  captures = [],
  measurements = [],
  errors = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) console.error(name, detail ?? "");
};
let win, wc;
const js = (code) => wc.executeJavaScript(code, true);
const until = async (code) => {
  for (let n = 0; n < 160; n++) {
    if (await js(code).catch(() => false)) return true;
    await wait(50);
  }
  return false;
};
const click = async (selector) => {
  const point = await js(
    `(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)throw Error('Missing '+${JSON.stringify(selector)}); e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
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
  await wait(180);
};
const key = async (key) => {
  const p = {
    key,
    code: key,
    windowsVirtualKeyCode: { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40 }[key] ?? 0,
    modifiers: 0,
  };
  await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
    type: "keyDown",
    ...p,
    ...(key === "Enter" ? { text: "\r" } : {}),
  });
  await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...p });
  await wait(180);
};
const type = async (text) => {
  await click('[aria-label="Prompt"]');
  await wc.debugger.sendCommand("Input.insertText", { text });
};
const capture = async (name) => {
  await wait(200);
  const file = path.join(out, `${name}.png`);
  fs.writeFileSync(file, (await wc.capturePage()).toPNG());
  captures.push(file);
};
const nativeVisible = () =>
  win.contentView.children.some(
    (view) => view.webContents && view.webContents !== wc && view.getVisible() && view.getBounds().width > 0,
  );
await import(pathToFileURL(main).href);

async function acceptance() {
  try {
    for (let n = 0; n < 300 && !fs.existsSync(path.join(profile, "controller.json")); n++) await wait(100);
    if (!fs.existsSync(path.join(profile, "controller.json"))) throw new Error("Owned Studio fixture did not start");
    win = BrowserWindow.getAllWindows()[0];
    wc = win.webContents;
    wc.on("console-message", (event) => {
      if (event.level === "error" || event.level === 3) errors.push(event.message);
    });
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    await until(`!!document.querySelector('nav [data-thread="studio"]')`);
    await click('nav [data-thread="studio"]');
    check(
      "feed loads runs from both games beyond the bootstrap tail",
      await until(`document.querySelectorAll('[data-activity-kind="run"]').length===3`),
    );
    check("Studio hides native game", !nativeVisible());
    check(
      "Studio composer offers images, one model menu and Send",
      await js(
        `!!document.querySelector('[data-studio-composer] [aria-label="Attach images"]') && !!document.querySelector('[data-studio-composer] [data-model-menu] [aria-label="Model settings"]') && !document.querySelector('[data-studio-composer] [aria-label="Add"],[data-studio-composer] [aria-label="Mode"]')`,
      ),
    );
    check(
      "run rows begin collapsed with a plain outcome",
      await js(
        `!document.querySelector('[data-activity-kind="run"] [data-testid="run-outcome"]') && document.querySelector('[data-studio-feed]').textContent.includes('No build')`,
      ),
    );
    check(
      "Studio records stay out of the Studio chat and Activity shows no upkeep list",
      await js(
        `!!document.querySelector('[data-studio-intro]') && !/Workspace restored|facet-decomposition|What was learned/.test(document.querySelector('[data-studio-chat]').textContent) && !/Restored Studio|upkeep/i.test(document.querySelector('[data-testid="review-panel"]').textContent) && !document.querySelector('[data-studio-problem]')`,
      ),
    );
    await capture("studio-overview");

    await click("[data-harness-guide-open]");
    check(
      "How it works beside the Harness title opens the guide to the loop",
      await until(
        `(() => {const d=document.querySelector('[data-testid="harness-guide"]');return !!d && d.textContent.includes('How Harness works') && d.querySelectorAll('[data-harness-steps] li').length===4 && !d.textContent.includes('On this page');})()`,
      ),
    );
    await capture("harness-guide");
    await key("Escape");
    check(
      "the guide closes back to its button",
      await until(
        `!document.querySelector('[data-testid="harness-guide"]') && document.activeElement?.hasAttribute('data-harness-guide-open')`,
      ),
    );

    await click('[data-studio-composer] [aria-label="Model settings"]');
    check(
      "Harness model menu is the model list itself, without roles or effort",
      await until(
        `(() => {const v=document.querySelector('[aria-label="Model options"] [data-model-view="list"]');if(!v)return false;return !!v.querySelector('[data-model-choice]') && [...v.querySelectorAll('button')].at(-1)?.textContent==='Add more models' && !/Workers|Reviewers|Main agent|Effort/.test(v.textContent);})()`,
      ),
    );
    check(
      "Harness composer offers the same effort pill",
      await js(`!!document.querySelector('[data-studio-composer] [aria-label^="Effort:"]')`),
    );
    await key("Escape");
    const learningSwitch = '[data-learning-switch] [role="switch"]';
    check(
      "Self-improvement is one switch at the top right of Studio, on by default",
      await until(
        `(() => {const s=document.querySelector(${JSON.stringify(learningSwitch)}),h=document.querySelector('[data-testid="review-panel"] header');if(!s||!h)return false;const a=s.getBoundingClientRect(),b=h.getBoundingClientRect();return s.getAttribute('aria-checked')==='true' && b.right-a.right<24 && a.top>=b.top && a.bottom<=b.bottom;})()`,
      ),
    );
    await click(learningSwitch);
    check(
      "switched off, Studio says it is not learning",
      await until(
        `document.querySelector(${JSON.stringify(learningSwitch)}).getAttribute('aria-checked')==='false' && document.querySelector('[data-studio-learned]').textContent.includes('Self-improvement is off')`,
      ),
    );
    await click("[data-learning-switch]");
    check(
      "the label turns it back on",
      await until(`document.querySelector(${JSON.stringify(learningSwitch)}).getAttribute('aria-checked')==='true'`),
    );

    await type("hi");
    await key("Enter");
    check(
      "Studio sends through model completion and renders a reply",
      await until(
        `document.querySelector('[data-studio-chat]').textContent.includes('Fixture Studio reply') && !document.querySelector('[data-studio-composer] [aria-label="Stop"]')`,
      ),
    );
    await type("follow up: how does Studio learn?");
    await key("Enter");
    check(
      "follow-up receives a distinct model reply",
      await until(`document.querySelector('[data-studio-chat]').textContent.includes('Fixture follow-up')`),
    );

    // A synthetic dropped file uses the production image decoding and Send path through main.
    await js(
      `(() => {const canvas=document.createElement('canvas');canvas.width=40;canvas.height=40;const ctx=canvas.getContext('2d');ctx.fillStyle='#8877aa';ctx.fillRect(0,0,40,40);return new Promise(resolve=>canvas.toBlob(blob=>{const data=new DataTransfer();data.items.add(new File([blob],'studio-reference.png',{type:'image/png'}));document.querySelector('[data-studio-composer]').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:data}));resolve(true);},'image/png'));})()`,
    );
    check(
      "drop decodes an attached image",
      await until(`!!document.querySelector('[aria-label="Attached images"] img')`),
    );
    await type("Describe this screenshot");
    await capture("studio-image-draft");
    await key("Enter");
    check(
      "image bytes reach the Studio provider",
      await until(`document.querySelector('[data-studio-chat]').textContent.includes('Received 1 attached image')`),
    );
    check(
      "the sent image shows above its message",
      await until(`!!document.querySelector('[data-studio-chat] [data-message-images] img')?.naturalWidth`),
    );

    await until(`!document.querySelector('[data-studio-composer] [aria-label="Stop"]')`);
    await type("fixture:pending");
    await key("Enter");
    check(
      "pending Studio generation exposes Stop",
      await until(`!!document.querySelector('[data-studio-composer] [aria-label="Stop"]')`),
    );
    await wait(650);
    await click('[data-studio-composer] [aria-label="Stop"]');
    check(
      "Stop settles the real pending completion",
      await until(`!document.querySelector('[data-studio-composer] [aria-label="Stop"]')`),
    );
    check(
      "an intentional Stop is not presented as an error",
      await js(
        `document.querySelector('[data-studio-chat]').textContent.includes('Stopped') && !document.querySelector('[data-studio-chat]').textContent.includes('Something went wrong')`,
      ),
    );
    await type("fixture:failure");
    await key("Enter");
    check(
      "empty model reply is visible and recoverable",
      await until(`document.querySelector('[data-studio-chat]').textContent.includes('empty reply')`),
    );
    await until(`!document.querySelector('[data-studio-composer] [aria-label="Stop"]')`);
    await type("follow up after the error");
    await key("Enter");
    check(
      "chat remains usable after failure and cancellation",
      await until(
        `[...document.querySelectorAll('[data-studio-chat] .prose')].filter(reply=>!reply.closest('[data-studio-intro]')).length>=4 && !document.querySelector('[data-studio-composer] [aria-label="Stop"]')`,
      ),
    );
    // A file copied in Finder carries its name as text too; the picture is what gets pasted.
    check(
      "pasting a copied image adds it without its file name",
      (await js(
        `new Promise(resolve=>{const canvas=document.createElement('canvas');canvas.width=20;canvas.height=20;canvas.getContext('2d').fillRect(0,0,20,20);canvas.toBlob(blob=>{const data=new DataTransfer();data.items.add(new File([blob],'pasted-shot.png',{type:'image/png'}));data.setData('text/plain','pasted-shot.png');const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data});document.querySelector('[data-studio-composer] textarea').dispatchEvent(event);resolve(event.defaultPrevented);},'image/png');})`,
      )) && (await until(`!!document.querySelector('[aria-label="Attached images"] img[alt="pasted-shot"]')`)),
    );
    await click('[aria-label="Remove pasted-shot"]');
    await capture("studio-chat");

    await click('[data-activity-kind="run"] > button');
    check(
      "an expanded run says plainly what it delivered",
      await until(
        `document.querySelector('[data-activity-kind="run"] .disclosure-body[data-open="true"]')?.textContent.includes('Your game is as you left it')`,
      ),
    );
    check(
      "an expanded run shows its result and actions, not the technical report",
      await js(
        `!document.querySelector('[data-activity-kind="run"] [data-testid="run-outcome"]') && !document.querySelector('[data-activity-kind="run"] .disclosure-body button.chat-disclosure') && !!document.querySelector('[aria-label="Open game chat for Ashlands walk"]')`,
      ),
    );
    await capture("studio-run-details");
    await type("Keep this Studio draft");
    await click('[aria-label="Open game chat for Ashlands walk"]');
    check(
      "Open game chat navigates to the run’s game",
      await until(
        `document.querySelector('[data-studio-state]')?.dataset.room==='build' && document.querySelector('[data-chat-header]').textContent.includes('Ashlands walk')`,
      ),
    );
    check(
      "game composer retains its model and tool controls",
      await js(
        `!!document.querySelector('[data-promptbar] [aria-label="Model settings"]') && !document.querySelector('[data-studio-composer]')`,
      ),
    );
    await click('nav [data-thread="studio"]');
    check(
      "Studio draft survives navigation",
      await until(`document.querySelector('[aria-label="Prompt"]')?.value==='Keep this Studio draft'`),
    );

    const fonts = await js(
      `(() => {const root=document.querySelector('[data-testid="review-panel"]');const nodes=[...root.querySelectorAll('*')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()));return {sizes:[...new Set(nodes.map(e=>getComputedStyle(e).fontSize))],weights:[...new Set(nodes.map(e=>getComputedStyle(e).fontWeight))]};})()`,
    );
    measurements.push(fonts);
    check(
      "Studio has three sizes and two weights",
      fonts.sizes.every((size) => ["14px", "15px", "18px"].includes(size)) &&
        fonts.weights.every((weight) => ["400", "500"].includes(weight)),
      fonts,
    );
    check(
      "Activity keeps no settings or run form beyond the Self-improvement switch",
      await js(
        `[...document.querySelectorAll('[data-testid="review-panel"] [role="switch"]')].every(s=>s.closest('[data-learning-switch]')) && !document.querySelector('[data-testid="review-panel"] textarea')`,
      ),
    );

    await click('nav [aria-label="Settings"]');
    await click("#settings-tab-harness");
    check(
      "Maximum workers and automatic suggestions live in Settings",
      await until(
        `(() => {const b=document.querySelector('[data-harness-settings]');return !!b && b.textContent.includes('Maximum concurrent workers') && b.querySelector('output')?.textContent==='4' && !!b.querySelector('[role="switch"]');})()`,
      ),
    );
    const autoResume = (state) =>
      until(
        `(() => {const s=document.querySelector('[data-harness-auto-resume]');return !!s && s.getAttribute('role')==='switch' && s.getAttribute('aria-checked')==='${state}' && !s.disabled;})()`,
      );
    check("Resume builds automatically is on by default", await autoResume("true"));
    await click("[data-harness-auto-resume]");
    check("Resume builds automatically turns off", await autoResume("false"));
    await click("#settings-tab-appearance");
    await click("#settings-tab-harness");
    check("Resume builds automatically stays off when Settings → Harness opens again", await autoResume("false"));
    await click("#settings-tab-appearance");
    await click('input[name="appearance-mode"][value="light"]');
    await key("Escape");
    await js(`document.querySelector('[data-testid="review-panel"]').scrollTop=0`);
    await capture("studio-light");
    wc.setZoomFactor(2);
    win.setContentSize(1440, 900);
    await wait(350);
    const fit = await js(
      `(() => {const p=document.querySelector('[data-testid="review-panel"]'),c=document.querySelector('[data-studio-chat]'),s=document.querySelector('[data-studio-composer] [aria-label="Send"]'),r=s.getBoundingClientRect();return {panel:p.scrollWidth-p.clientWidth,chat:c.scrollWidth-c.clientWidth,page:document.documentElement.scrollWidth-innerWidth,sendRight:r.right,sendBottom:r.bottom,width:innerWidth,height:innerHeight};})()`,
    );
    measurements.push(fit);
    check(
      "200% zoom keeps feed and composer within their panes",
      fit.panel <= 1 && fit.chat <= 1 && fit.page <= 1 && fit.sendRight <= fit.width && fit.sendBottom <= fit.height,
      fit,
    );
    await capture("studio-200-percent");
    wc.setZoomFactor(1);
    win.setContentSize(1080, 720);
    await wait(250);
    await capture("studio-compact");
    await wc.debugger.sendCommand("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await click('[data-activity-kind="improvement"] > button');
    check(
      "disclosures remain usable with reduced motion",
      await js(
        `document.querySelector('[data-activity-kind="improvement"] > button').getAttribute('aria-expanded')==='true'`,
      ),
    );
    check("no renderer errors", errors.length === 0, errors);
  } catch (error) {
    check("Studio acceptance completed", false, error.stack);
    if (wc) await capture("failure").catch(() => {});
  } finally {
    fs.writeFileSync(
      path.join(out, "report.json"),
      JSON.stringify(
        {
          buildId: build.buildId,
          sourceDigest: build.sourceDigest,
          outputDigest: build.outputDigest,
          profile: launch.profileId,
          providers: "fixture; no accounts or network",
          electron: process.versions.electron,
          checks,
          captures,
          measurements,
          limitations: [
            "Synthetic model replies establish routing, context transport and lifecycle, not live vendor quality or authentication. Native file picker not exercised.",
          ],
        },
        null,
        2,
      ),
    );
    app.quit();
  }
}
void acceptance();
