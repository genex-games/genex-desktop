/**
 * The chat's review cards (mockups A2, C2, C3, C4, D2) in a disposable Electron profile over a fake
 * `window.studio`: each game's newest record is its live card as Genex's word now draws it, every
 * older one a history line, which opens read only to what it said then; Fix with agent presses through
 * the native IPC; a review of another game raises a toast with [Open]. Dark and light screens. No card
 * says the check takes seconds or that Genex checks public games again.
 */
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildDesignGallery } from "../../scripts/design-gallery.mjs";
import { fixtureElectronArgs, fixtureElectronEnv, resolveElectron } from "../../scripts/electron-runtime.mjs";
import { sourceIdentity } from "../../scripts/studio-dev/files.mjs";

/** The whole check, from Electron's start to its exit. */
const RUN_TIMEOUT_MS = 120_000;

const out = await buildDesignGallery();
const evidence = path.resolve(".studio-dev/evidence", `chat-review-card-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "genex-chat-review-card-"));
await build({
  entryPoints: ["tests/fixtures/chat-review-card.tsx"],
  outfile: path.join(out, "chat-review-card.js"),
  bundle: true,
  format: "esm",
  jsx: "automatic",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(
  path.join(out, "chat-review-card.html"),
  '<html data-theme="dark"><head><link rel="stylesheet" href="gallery.css"></head><body style="margin:0;background:var(--background)"><div id="root"></div><script type="module" src="chat-review-card.js"></script></body></html>',
);
const boot = path.join(out, "chat-review-card.cjs");
await writeFile(
  boot,
  `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(profile)});
const evidence=${JSON.stringify(evidence)};
const report={source:${JSON.stringify(sourceIdentity(process.cwd()))},profile:${JSON.stringify(profile)},providers:'synthetic',steps:{},errors:[]};
report.buildId=report.source.sourceDigest;
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1460,height:1100,show:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const wc=win.webContents;
 wc.on('console-message',(event)=>{if(event.level==='error')report.errors.push(event.message)});
 const js=(source)=>wc.executeJavaScript(source);
 const capture=async(name)=>{const file=path.join(evidence,name+'.png');fs.writeFileSync(file,(await wc.capturePage()).toPNG());return file;};
 try {
  await wc.loadFile(${JSON.stringify(path.join(out, "chat-review-card.html"))});
  for (const theme of ['dark','light']) {
   const seen=await js('window.chatReviewRig.open({theme:"'+theme+'"})');
   report.steps[theme]=seen;
   const scene=(name)=>seen.scenes.find((one)=>one.scene===name);
   assert.match(scene('checking').title,/^Checking your Mac app\\d/);
   assert.match(scene('checking-fixes').title,/^Checking your fixes/);
   assert.deepEqual(scene('checking-fixes').history.map((line)=>line.split('·')[0].trim()),['Not approved','3 fixes sent']);
   assert.equal(scene('live').live,'live');
   assert.equal(scene('live').title,'Midnight Asphalt is live!');
   assert.deepEqual(scene('live').presses,['Copy link','Open on Genex']);
   assert.equal(scene('live-update').title,'Version 1.3.0 is live');
   assert.equal(scene('restored').title,'Midnight Asphalt is public again');
   assert.deepEqual(scene('restored').lines,["Someone from the Genex team agreed it's fine."]);
   assert.equal(scene('not-approved').title,"Can't publish yet: 1 thing to fix");
   assert.deepEqual(scene('not-approved').presses,['Fix with agent','Request human review']);
   assert.equal(scene('taken-down').title,'Taken down: 3 things to fix');
   assert.deepEqual(scene('taken-down').history.map((line)=>line.split('·')[0].trim()),['Published']);
   assert.equal(scene('fix-sent').link,"Don't ask automatically");
   assert.deepEqual(scene('fix-stopped').presses,['Fix again']);
   assert.doesNotMatch(seen.text,/few seconds|keeps checking|checks public games/i);
   assert.deepEqual(seen.toasts,[{text:'Lost Cathedral is public again',action:'Open'}]);
   const opened=await js('window.chatReviewRig.expand("taken-down")');
   assert.deepEqual(opened.settled,[{title:'Midnight Asphalt is live!',lines:['Anyone can find it on Genex.'],presses:0}]);
   report[theme]=await capture(theme+'-chat-review-cards');
  }
  const toasted=await js('window.chatReviewRig.openToast()');
  assert.deepEqual(toasted.toastOpened,['cathedral']);
  assert.deepEqual(toasted.toasts,[],'pressed, the toast goes');
  const fixed=await js('window.chatReviewRig.press("not-approved","fix")');
  assert.deepEqual(fixed.pressed,['fix:not-approved']);
  assert.deepEqual(report.errors,[]);
  console.log('PASS Chat review cards: checking, checking fixes, live with its link, an update, public again, not approved, taken down, a fix on its way and one that stopped, with history lines that open read only; Fix with agent presses through the native IPC; another game public again toasts with Open');
 } catch(error) { report.failure=error.stack; console.error(error); await capture('failure').catch(()=>{}); }
 fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify(report,null,2));
 app.exit(report.failure?1:0);
});`,
);
try {
  const child = spawn(resolveElectron(), fixtureElectronArgs([boot]), { env: fixtureElectronEnv(), stdio: "inherit" });
  const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
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
