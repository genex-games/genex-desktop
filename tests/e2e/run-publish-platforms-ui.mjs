/**
 * The Publish dialog's platform rows, in a disposable Electron profile with a fake `window.studio`:
 * a game made in an engine lists the web, Mac, Windows and Linux above the presses, each detail on one
 * line; a built Mac app says "Coming soon" and the line under the rows says its players get the
 * web version; Make with agent sends the ask to the game's chat and the row says it was asked; a
 * build older than the game's last change says so; once the CLI sends apps, the line says Publish
 * sends the Mac app and its row says Sending…, On Genex or Not sent (with why), or In review and Not
 * approved (with why) for an app Genex reviews first; a web game with no
 * app shows no rows. Dark and
 * light screens.
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
const evidence = path.resolve(".studio-dev/evidence", `publish-platforms-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "genex-publish-platforms-"));
await build({
  entryPoints: ["tests/fixtures/publish-platforms.tsx"],
  outfile: path.join(out, "publish-platforms.js"),
  bundle: true,
  format: "esm",
  jsx: "automatic",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(
  path.join(out, "publish-platforms.html"),
  '<html data-theme="dark"><head><link rel="stylesheet" href="gallery.css"></head><body style="margin:0;background:var(--background)"><div id="root" style="display:flex;width:100vw;height:100vh"></div><script type="module" src="publish-platforms.js"></script></body></html>',
);
const boot = path.join(out, "publish-platforms.cjs");
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
 const win=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const wc=win.webContents;
 wc.on('console-message',(event)=>{if(event.level==='error')report.errors.push(event.message)});
 const js=(source)=>wc.executeJavaScript(source);
 const capture=async(name)=>{const file=path.join(evidence,name+'.png');fs.writeFileSync(file,(await wc.capturePage()).toPNG());return file;};
 const step=async(name,source)=>{const result=await js(source);report.steps[name]=result;return result;};
 try {
  await wc.loadFile(${JSON.stringify(path.join(out, "publish-platforms.html"))});
  for (const theme of ['dark','light']) {
   // A game made in Unity with a Mac app built: four rows above Publish, each detail on one line.
   const engine=await step(theme+'Engine','window.platformsRig.open({theme:"'+theme+'"})');
   assert.equal(engine.listed,true);
   assert.deepEqual(engine.rows.map((row)=>[row.target,row.name,row.detail,row.end]),[
    ['web','Web','Plays right away',null],
    ['mac','Mac app','Apple silicon and Intel · built 5 min ago','Coming soon'],
    ['windows','Windows app','Not made yet','Make with agent'],
    ['linux','Linux app','Not made yet','Make with agent'],
   ]);
   assert.equal(engine.rows[1].size,'1.4 GB');
   assert.equal(engine.reach,'Mac, Windows and Linux players get the web version.');
   assert.deepEqual(engine.order,['platforms','primary'],'the rows sit above the presses');
   assert.equal(engine.oneLine,true,'each detail is one line');
   assert.equal(engine.overflow,false);
   report[theme+'Engine']=await capture(theme+'-engine');
  }
  // Make with agent: the ask goes to the game's chat at once, the dialog stays open and the row says so.
  const made=await step('make','window.platformsRig.make("windows")');
  assert.equal(made.closed,0,'the dialog stays open');
  assert.deepEqual(made.composed,[{project:'dust-runners',text:'Make a Windows app of Dust Runners so I can publish it for Windows players.',send:true}]);
  assert.equal(made.rows[2].end,'Asked the agent');
  report.asked=await capture('light-asked');
  const madeLinux=await step('makeLinux','window.platformsRig.make("linux")');
  assert.deepEqual(madeLinux.composed.at(-1),{project:'dust-runners',text:'Make a Linux app of Dust Runners so I can publish it for Linux players.',send:true});
  assert.equal(madeLinux.rows[3].end,'Asked the agent');
  // A Mac app built before the game's last change says so.
  const stale=await step('stale','window.platformsRig.open({scene:"stale"})');
  assert.equal(stale.rows[1].detail,'Built before your last change');
  assert.equal(stale.rows[1].state,'stale');
  assert.equal(stale.rows[1].end,'Build again','the agent builds it again');
  report.stale=await capture('dark-stale');
  // Once the Genex CLI sends apps: Publish says it sends the Mac app, then how the send went.
  const apps=await step('apps','window.platformsRig.open({scene:"apps"})');
  assert.equal(apps.reach,'Publish also sends the Mac and Linux apps. Windows players get the web version.');
  assert.equal(apps.rows[1].end,null,'nothing at the end before Publish');
  assert.deepEqual([apps.rows[3].detail,apps.rows[3].size,apps.rows[3].end],['64-bit PCs · built 5 min ago','700 MB',null]);
  report.apps=await capture('dark-apps');
  const sending=await step('appsSending','window.platformsRig.open({scene:"appsSending"})');
  assert.equal(sending.rows[1].end,'Sending…');
  const sent=await step('appsSent','window.platformsRig.open({scene:"appsSent"})');
  assert.equal(sent.rows[1].end,'On Genex');
  assert.equal(sent.rows[3].end,'On Genex','the Linux app too');
  report.appsSent=await capture('dark-apps-sent');
  const refused=await step('appsFailed','window.platformsRig.open({scene:"appsFailed"})');
  assert.equal(refused.rows[1].end,'Not sent');
  assert.deepEqual(refused.failures,["Couldn’t send the Mac app: Couldn't get an upload token (HTTP 413)."]);
  assert.equal(refused.overflow,false);
  report.appsFailed=await capture('dark-apps-failed');
  // A game with only a Mac app (no web build): Publish publishes the app under its own words.
  const only=await step('appsOnly','window.platformsRig.open({scene:"appsOnly"})');
  assert.equal(only.primary,'Publish Mac app');
  assert.equal(only.reach,'Only Mac players can play it.');
  assert.deepEqual([only.rows[0].detail,only.rows[0].end],['Not made yet','Make with agent'],'the agent can make its web version');
  assert.equal(only.hint,null,'the line above the press says who plays it: no second line under it');
  report.appsOnly=await capture('dark-apps-only');
  const pressed=await step('appsOnlyPress','window.platformsRig.press()');
  assert.deepEqual(pressed.published,[{via:'apps',title:'Dust Runners'}],'the apps go, never a web copy');
  const held=await step('appsHeld','window.platformsRig.open({scene:"appsHeld"})');
  assert.deepEqual(held.failures,['Sent for review. It appears in Play once Genex approves it.']);
  assert.equal(held.rows[1].end,'On Genex');
  // Someone other than an admin sent it: Genex reviews it first, and may turn it down with why.
  const review=await step('appsReview','window.platformsRig.open({scene:"appsReview"})');
  assert.deepEqual(review.failures,['Sent for review. It appears in Play once Genex approves it.']);
  assert.equal(review.rows[1].end,'In review');
  assert.equal(review.primary,null,'the same app sent again would change nothing');
  assert.equal(review.overflow,false);
  report.appsReview=await capture('dark-apps-review');
  const rejected=await step('appsRejected','window.platformsRig.open({scene:"appsRejected"})');
  assert.equal(rejected.rows[1].end,'Not approved');
  assert.deepEqual(rejected.failures,['Genex didn’t approve the Mac app: It opens a shell.']);
  assert.equal(rejected.primary,'Publish Mac app','a turned-down app can go again');
  report.appsRejected=await capture('dark-apps-rejected');
  // A Unity game with no app yet, then with one Studio cannot send yet: its press waits and says why.
  const unity=await step('unityNoApp','window.platformsRig.open({scene:"unityNoApp"})');
  assert.equal(unity.listed,true);
  assert.equal(unity.primaryDisabled,true);
  assert.equal(unity.reach,'Make a web version or a Mac, Windows or Linux app first, then publish it here.');
  assert.deepEqual(unity.rows.map((row)=>row.end),['Make with agent','Make with agent','Make with agent','Make with agent']);
  report.unityNoApp=await capture('dark-unity-no-app');
  // Its web row asks the agent for a web version, as the app rows ask for apps.
  const webAsk=await step('makeWeb','window.platformsRig.make("web")');
  assert.deepEqual(webAsk.composed,[{project:'dust-runners',text:'Make a web version of Dust Runners so I can publish it on the web.',send:true}]);
  assert.equal(webAsk.rows[0].end,'Asked the agent');
  // An Unreal game has no web export: its web row says so and offers nothing.
  const unreal=await step('unreal','window.platformsRig.open({scene:"unreal"})');
  assert.deepEqual([unreal.rows[0].detail,unreal.rows[0].end],['Unreal games don’t run in a browser',null]);
  report.unreal=await capture('dark-unreal');
  const soon=await step('unitySoon','window.platformsRig.open({scene:"unitySoon"})');
  assert.equal(soon.primaryDisabled,true);
  assert.equal(soon.rows[1].end,'Coming soon');
  assert.equal(soon.reach,'Publishing Mac, Windows and Linux apps comes with the next Genex update.');
  // An app Studio can send, through a Genex plugin from before apps: the line says to update it.
  const oldPlugin=await step('unityOldPlugin','window.platformsRig.open({scene:"unityOldPlugin"})');
  assert.equal(oldPlugin.primaryDisabled,true);
  assert.equal(oldPlugin.reach,'Update the Genex plugin in Plugins to publish apps.');
  // A web game with no app: the dialog as it was, no rows.
  const plain=await step('web','window.platformsRig.open({scene:"web"})');
  assert.equal(plain.listed,false);
  report.web=await capture('dark-web');
  assert.deepEqual(report.errors,[]);
  console.log('PASS Publish platforms: engine game lists web, Mac, Windows and Linux; Make with agent sends the ask and keeps the dialog; apps go with Publish and say how they went; a game with only an app publishes it; a Unity game with nothing to send waits and says why, and asks the agent for a web version; an Unreal game says it has none; stale says so; web game unchanged');
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
