/** Production ChatPanel on a model that cannot take a message: Send says why at the model, in a disposable Electron profile. */
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildDesignGallery } from "../../scripts/design-gallery.mjs";
import { resolveElectron, fixtureElectronArgs, fixtureElectronEnv } from "../../scripts/electron-runtime.mjs";
import { sourceIdentity } from "../../scripts/studio-dev/files.mjs";

const out = await buildDesignGallery();
const evidence = path.resolve(".studio-dev/evidence", `chat-model-unavailable-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "genex-chat-model-unavailable-"));
await build({
  entryPoints: ["tests/fixtures/chat-model-unavailable.tsx"],
  outfile: path.join(out, "chat-model-unavailable.js"),
  bundle: true,
  format: "esm",
  jsx: "automatic",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(
  path.join(out, "chat-model-unavailable.html"),
  '<html data-theme="dark"><head><link rel="stylesheet" href="gallery.css"></head><body><div id="root" style="display:flex;height:800px"></div><script type="module" src="chat-model-unavailable.js"></script></body></html>',
);
const boot = path.join(out, "chat-model-unavailable.cjs");
await writeFile(
  boot,
  `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(profile)});
const report={source:${JSON.stringify(sourceIdentity(process.cwd()))},profile:${JSON.stringify(profile)},providers:'synthetic',checks:[],errors:[]};
report.buildId=report.source.sourceDigest;
report.electron=process.versions.electron;
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1080,height:900,show:false,focusable:false,skipTaskbar:true,x:-4000,y:0,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 // Shown off screen: a window never shown paints no frames, and the checks wait on frames.
 win.showInactive();
 const wc=win.webContents;
 wc.on('console-message',(event)=>{if(event.level==='error')report.errors.push(event.message)});
 try {
  await wc.loadFile(${JSON.stringify(path.join(out, "chat-model-unavailable.html"))});
  const held=await wc.executeJavaScript('window.sendOnUnavailable()');
  fs.writeFileSync(${JSON.stringify(path.join(evidence, "held.png"))},(await wc.capturePage()).toPNG());
  const recovered=await wc.executeJavaScript('window.sendAfterPick()');
  report.checks.push(held,recovered);
  const {typed,blocked}=held,{picked,after}=recovered;
  assert.equal(typed.model,'Big Pickle fixture','the chat shows the model it would send with');
  assert.equal(typed.send,'blocked','Send reads as blocked while the model cannot take a message');
  assert.deepEqual(blocked.sent,[],'nothing is sent on a model that cannot take it');
  assert.equal(blocked.draft,'Make the fox jump higher','the prompt stays as written');
  assert.ok(blocked.nudge,'Send lights up the model button');
  assert.match(blocked.tip,/isn.t available right now/,'a tooltip at the model says why');
  assert.match(blocked.tip,/another model/,'and what to do');
  assert.match(blocked.status,/isn.t available right now/,'a screen reader hears it too');
  assert.equal(picked.model,'Opus fixture');
  assert.equal(picked.send,'ready','a model that runs makes Send ready again');
  assert.equal(picked.nudge,null,'and puts the model button out at once');
  assert.equal(picked.tip,'','with its tooltip');
  assert.deepEqual(after.sent,['Make the fox jump higher'],'the kept prompt goes on the new model');
  assert.deepEqual(report.errors,[]);
  console.log('PASS ChatPanel says why Send went nowhere on an unavailable model, and sends once another is picked');
 } catch(error) { report.failure=error.stack; console.error(error); }
 fs.writeFileSync(${JSON.stringify(path.join(evidence, "chat.png"))},(await wc.capturePage()).toPNG());
 fs.writeFileSync(${JSON.stringify(path.join(evidence, "report.json"))},JSON.stringify(report,null,2));
 app.exit(report.failure?1:0);
});`,
);
try {
  const child = spawn(resolveElectron(), fixtureElectronArgs([boot]), { env: fixtureElectronEnv(), stdio: "inherit" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    if (code !== 0) process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
} finally {
  await rm(profile, { recursive: true, force: true });
}
console.log(evidence);
