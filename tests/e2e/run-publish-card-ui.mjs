/**
 * The Publish card of a game made in an engine, in a disposable Electron profile with a fake
 * `window.studio`: skeleton rows and no button until the game folder has answered; an Unreal game on a
 * Mac whose apps are older than the game says so on each row with where it gets built, and its button
 * builds the Mac app first ("Build Mac"), then updates both; Genex Cloud building shows its clock, the
 * busy button and "It can take up to an hour."; a done card has no button; a failed cloud build keeps
 * the older app live with its errors; a first publish names both platforms; a switch turned off takes
 * that app down with an amber button; a Unity game lists its four platforms. No row says "Public:", and
 * no Share assets line shows. Dark screens, and the main ones in light.
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
const evidence = path.resolve(".studio-dev/evidence", `publish-card-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "genex-publish-card-"));
await build({
  entryPoints: ["tests/fixtures/publish-card.tsx"],
  outfile: path.join(out, "publish-card.js"),
  bundle: true,
  format: "esm",
  jsx: "automatic",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(
  path.join(out, "publish-card.html"),
  '<html data-theme="dark"><head><link rel="stylesheet" href="gallery.css"></head><body style="margin:0;background:var(--background)"><div id="root" style="display:flex;width:100vw;height:100vh"></div><script type="module" src="publish-card.js"></script></body></html>',
);
const boot = path.join(out, "publish-card.cjs");
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
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1100,height:1000,show:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false,zoomFactor:1}});
 const wc=win.webContents;
 wc.on('console-message',(event)=>{if(event.level==='error')report.errors.push(event.message)});
 const js=(source)=>wc.executeJavaScript(source);
 const capture=async(name)=>{const file=path.join(evidence,name+'.png');fs.writeFileSync(file,(await wc.capturePage()).toPNG());return file;};
 const step=async(name,source)=>{const result=await js(source);report.steps[name]=result;return result;};
 const rows=(seen)=>seen.rows.map((row)=>[row.name,row.status,row.side]);
 const clean=(name,seen)=>{
  assert.equal(seen.overflow,false,name+': nothing runs past the card');
  assert.doesNotMatch(seen.text,/Public:/,name+': no "Public:" word');
  assert.equal(seen.share,false,name+': no Share assets line');
  assert.doesNotMatch(seen.text,/Only Mac players/,name);
 };
 try {
  await wc.loadFile(${JSON.stringify(path.join(out, "publish-card.html"))});
  // While the folder is read: skeleton rows, no status, no button.
  const loading=await step('loading','window.cardRig.open({scene:"loading"})');
  assert.equal(loading.loading,true);
  assert.equal(loading.primary,null,'no button before the folder has answered');
  report.loading=await capture('dark-0-loading');
  const answered=await step('answered','window.cardRig.answer()');
  assert.equal(answered.loading,false);
  for (const theme of ['dark','light']) {
   // Both apps older than the game: each row says where it gets built; the agent builds the Mac app first.
   const old=await step(theme+'Old','window.cardRig.open({scene:"old",theme:"'+theme+'"})');
   assert.deepEqual(rows(old),[
    ['Mac','Live · older than your game','builds on this Mac'],
    ['Windows','Live · older than your game','builds on Genex Cloud'],
   ]);
   assert.equal(old.primary,'Build Mac');
   clean('old',old);
   report[theme+'Old']=await capture(theme+'-1-old');
  }
  await step('darkOldAgain','window.cardRig.open({scene:"old",theme:"dark"})');
  const buildPress=await step('buildPress','window.cardRig.press()');
  assert.equal(buildPress.composed.length,1,'the agent is asked once');
  assert.match(buildPress.composed[0].text,/Build the Mac app of genex-strike again/);
  assert.deepEqual(buildPress.asked,[],'building sends nothing to Genex');
  assert.deepEqual(rows(buildPress)[0],['Mac','Building on this Mac',null]);
  assert.equal(buildPress.primary,'Update Windows','Windows can update while the Mac app builds');
  report.buildPress=await capture('dark-2-building-mac');
  // The Mac app lands and the agent's turn ends: the open card sees it, with no reopening.
  const landed=await step('landed','window.cardRig.land()');
  assert.deepEqual(rows(landed)[0],['Mac','Live · older than your game','3.2 GB'],'the card follows the folder');
  assert.equal(landed.primary,'Update Mac and Windows');
  // The Mac app landed: one press updates both.
  const built=await step('built','window.cardRig.open({scene:"built"})');
  assert.deepEqual(rows(built),[
   ['Mac','Live · older than your game','3.2 GB'],
   ['Windows','Live · older than your game','builds on Genex Cloud'],
  ]);
  assert.equal(built.primary,'Update Mac and Windows');
  report.built=await capture('dark-3-built');
  const updated=await step('updated','window.cardRig.press()');
  assert.deepEqual(updated.asked,['apps:mac','cloud:windows'],'the Mac app goes and Genex Cloud builds Windows');
  // Genex Cloud builds: its clock, the busy button and the line under it.
  for (const theme of ['dark','light']) {
   const building=await step(theme+'Building','window.cardRig.open({scene:"building",theme:"'+theme+'"})');
   assert.deepEqual(building.rows.map((row)=>[row.name,row.status,row.switch]),[
    ['Mac','Live · up to date',true],
    ['Windows','Building on Genex Cloud',false],
   ]);
   assert.match(building.rows[1].clock??'',/\\d/,'a clock in place of the switch');
   assert.match(building.primary??'',/^Updating Windows/);
   assert.equal(building.primaryDisabled,true);
   assert.equal(building.note,'It can take up to an hour.');
   clean('building',building);
   report[theme+'Building']=await capture(theme+'-4-building-cloud');
  }
  // Done: nothing to press.
  const done=await step('done','window.cardRig.open({scene:"done"})');
  assert.deepEqual(rows(done).map((one)=>one.slice(0,2)),[['Mac','Live · up to date'],['Windows','Live · up to date']]);
  assert.equal(done.primary,null);
  clean('done',done);
  report.done=await capture('dark-5-done');
  // A switch off: the button takes that app down, in amber.
  const off=await step('off','window.cardRig.toggle("windows")');
  assert.equal(off.primary,'Take Windows down');
  assert.equal(off.warn,true);
  report.takeDown=await capture('dark-6-take-down');
  const down=await step('down','window.cardRig.press()');
  assert.deepEqual(down.asked.filter((one)=>!one.startsWith('review:')),['publish-remove-app:windows']);
  // A failed Genex Cloud build of the game as it is: the older app stays live, and a block under the rows
  // names it, never its log, with Send to agent and Copy; the main button has nothing to do.
  const failed=await step('failed','window.cardRig.open({scene:"failed"})');
  assert.deepEqual(rows(failed)[1],['Windows','Couldn’t build · the older one is still live',null]);
  assert.deepEqual(failed.blocks.map((one)=>[one.target,one.text,one.send,one.copy]),[['windows','Windows build error'+'Send to agent',true,true]]);
  assert.doesNotMatch(failed.text,/FVector|C2065/,'the log never shows');
  assert.equal(failed.primary,null,'the error is not the main button');
  clean('failed',failed);
  report.failed=await capture('dark-7-failed');
  const sentFix=await step('sendFix','window.cardRig.block("send")');
  assert.match(sentFix.composed[0]?.text??'',/FVector/,'the agent gets the whole log');
  assert.deepEqual(sentFix.blocks.map((one)=>[one.sent,one.send]),[[true,false]],'the block says the agent is on it');
  assert.match(sentFix.blocks[0].text,/^Agent is fixing the Windows build/);
  report.sentFix=await capture('dark-7b-agent-fixing');
  // A send that didn't reach Genex: its block tries it again, the main button stays out of it.
  const unsent=await step('sendFailed','window.cardRig.open({scene:"sendFailed"})');
  assert.deepEqual(unsent.blocks.map((one)=>[one.target,one.retry,one.copy]),[['mac',true,true]]);
  assert.doesNotMatch(unsent.text,/HTTP 413/,'the words of the CLI never show');
  assert.equal(unsent.primary,null);
  report.sendFailed=await capture('dark-7c-send-failed');
  const retried=await step('retry','window.cardRig.block("retry")');
  assert.deepEqual(retried.asked,['apps:mac'],'Try again sends that app again');
  // A first publish: the Mac app goes, Genex Cloud builds Windows once the page is there.
  const first=await step('first','window.cardRig.open({scene:"first"})');
  assert.deepEqual(rows(first),[['Mac','Not published','3.2 GB'],['Windows','Not published','builds on Genex Cloud']]);
  assert.equal(first.primary,'Publish to Mac and Windows');
  clean('first',first);
  report.first=await capture('dark-8-first');
  // A Unity game with all four platforms.
  for (const theme of ['dark','light']) {
   const unity=await step(theme+'Unity','window.cardRig.open({scene:"unity",theme:"'+theme+'"})');
   assert.deepEqual(unity.rows.map((row)=>[row.name,row.status,row.on]),[
    ['Web','Live · up to date',true],
    ['Mac','Live · up to date',true],
    ['Windows','Not published',true],
    ['Linux','Not published',false],
   ]);
   assert.equal(unity.primary,'Publish to Windows');
   clean('unity',unity);
   report[theme+'Unity']=await capture(theme+'-9-unity');
  }
  const linux=await step('linuxOn','window.cardRig.toggle("linux")');
  assert.equal(linux.primary,'Build Linux','an app the agent makes is built first, alone');
  assert.deepEqual(report.errors,[]);
  console.log('PASS Publish card: skeleton rows before the folder answers; older apps say where they get built and build first, and an open card sees the build land; Genex Cloud shows its clock and the hour line; done has no button; a switch off takes an app down in amber; a failed cloud build keeps the older app live and its block hands the log to the agent, never showing it; a failed send has a block that tries again; a first publish names both; a Unity game lists four platforms; no "Public:", no Share assets');
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
