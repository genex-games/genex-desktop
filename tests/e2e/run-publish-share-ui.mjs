/**
 * The Publish dialog's row that shares the game's assets on Play, in a disposable Electron profile
 * with a fake `window.studio`: the row shows only signed in, above the presses, on one line, its
 * switch off; with the switch on, the game going live shares exactly the assets not on Play yet
 * under their names, and the success screen says so in one line (a bare ✓, or the misses in
 * orange with Try again, which sends only those). Dark and light screens of each state.
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
const evidence = path.resolve(".studio-dev/evidence", `publish-share-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "genex-publish-share-"));
await build({
  entryPoints: ["tests/fixtures/publish-share.tsx"],
  outfile: path.join(out, "publish-share.js"),
  bundle: true,
  format: "esm",
  jsx: "automatic",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(
  path.join(out, "publish-share.html"),
  '<html data-theme="dark"><head><link rel="stylesheet" href="gallery.css"></head><body style="margin:0;background:var(--background)"><div id="root" style="display:flex;width:100vw;height:100vh"></div><script type="module" src="publish-share.js"></script></body></html>',
);
const boot = path.join(out, "publish-share.cjs");
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
report.electron=process.versions.electron;
const NAMES=['Giant mushroom tree with a tall twisted stem','Chitin hut with a round door','Silt strider, a giant insect mount','Stadium crowd erupting after a goal','Iron street lantern on a post'];
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const wc=win.webContents;
 wc.on('console-message',(event)=>{if(event.level==='error')report.errors.push(event.message)});
 const js=(source)=>wc.executeJavaScript(source);
 const capture=async(name)=>{const file=path.join(evidence,name+'.png');fs.writeFileSync(file,(await wc.capturePage()).toPNG());return file;};
 const step=async(name,source)=>{const result=await js(source);report.steps[name]=result;return result;};
 try {
  await wc.loadFile(${JSON.stringify(path.join(out, "publish-share.html"))});
  // Signed out: today's dialog asks for the account; no row.
  const out=await step('signedOut','window.shareRig.open({signedIn:false})');
  assert.equal(out.row,null,'no row while signed out');
  for (const theme of ['dark','light']) {
   // Signed in, five Genex assets not on Play: the row above Publish, one line, pictures, switch off.
   const fresh=await step(theme+'Fresh','window.shareRig.open({theme:"'+theme+'"})');
   assert.equal(fresh.stage,'draft');
   assert.deepEqual(fresh.row,{text:'Share its 5 assets on Play',thumbs:3});
   assert.equal(fresh.oneLine,true,'the row is one line');
   assert.equal(fresh.switchOn,false,'off by default');
   assert.deepEqual(fresh.order,['share','primary'],'the row sits just above the presses');
   assert.equal(fresh.overflow,false);
   report[theme+'Off']=await capture(theme+'-row-off');
   const on=await step(theme+'On','window.shareRig.toggle()');
   assert.equal(on.switchOn,true);
   report[theme+'On']=await capture(theme+'-row-on');
   // It goes live: exactly the five are shared under their names, and the line says so.
   const shared=await step(theme+'Shared','window.shareRig.publish()');
   assert.equal(shared.celebrating,true);
   assert.deepEqual(shared.shares,[NAMES]);
   assert.deepEqual(shared.line,{outcome:'shared',text:'5 assets on Play',action:null});
   assert.equal(shared.row,null,'the row gives way to the line');
   report[theme+'Success']=await capture(theme+'-success');
   // Two miss: orange, with Try again, which sends only those two.
   await step(theme+'Again','window.shareRig.open({theme:"'+theme+'",mode:"misses"})');
   await step(theme+'AgainOn','window.shareRig.toggle()');
   const missed=await step(theme+'Missed','window.shareRig.publish()');
   assert.deepEqual(missed.line,{outcome:'missed',text:'2 couldn’t be shared',action:'Try again'});
   report[theme+'Missed']=await capture(theme+'-missed');
   const retried=await step(theme+'Retried','window.shareRig.retry()');
   assert.deepEqual(retried.shares[1],NAMES.slice(0,2));
   assert.deepEqual(retried.line,{outcome:'shared',text:'5 assets on Play',action:null});
  }
  // Closed with the switch on before it went live: reopening says so, and Share now's line stays
  // through the re-read that follows it (misses with Try again; then a bare ✓, no row back).
  for (const mode of ['misses','live']) {
   await step(mode+'Closing','window.shareRig.open()');
   await step(mode+'ClosingOn','window.shareRig.toggle()');
   const reopened=await step(mode+'Reopened','window.shareRig.reopen()');
   assert.deepEqual(reopened.line,{outcome:'not-shared',text:'5 assets not on Play yet',action:'Share now'});
   if (mode==='misses') report.notShared=await capture('dark-not-shared');
   const now=await step(mode+'SharedNow','window.shareRig.shareNow("'+mode+'")');
   assert.deepEqual(now.shares,[NAMES]);
   assert.deepEqual(now.line,mode==='misses'?{outcome:'missed',text:'2 couldn’t be shared',action:'Try again'}:{outcome:'shared',text:'5 assets on Play',action:null});
  }
  // The switch left off: going live shares nothing and says nothing.
  await step('offAgain','window.shareRig.open()');
  const quiet=await step('offLive','window.shareRig.publish()');
  assert.equal(quiet.celebrating,true);
  assert.deepEqual(quiet.shares,[]);
  assert.equal(quiet.line,null);
  assert.deepEqual(report.errors,[]);
  console.log('PASS Publish share row: signed in only, one line, off by default; live shares exactly the unshared assets and says how it went');
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
