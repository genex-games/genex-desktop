/**
 * Publish for a Roblox game, in a disposable Electron profile with a fake `window.studio`: the card's
 * one press hands the publish to the agent with no other question (the name typed for a first
 * publish goes with it), the card follows it through publishing to Roblox with a link to the game's
 * page, a stop shows the agent's words with Try again, a refused hand-over gives Studio's own clicks,
 * a game with no place offers setup, and where Genex can't click the card gives Studio's clicks. Dark
 * and light.
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
const evidence = path.resolve(".studio-dev/evidence", `roblox-publish-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "genex-roblox-publish-"));
await build({
  entryPoints: ["tests/fixtures/roblox-publish.tsx"],
  outfile: path.join(out, "roblox-publish.js"),
  bundle: true,
  format: "esm",
  jsx: "automatic",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(
  path.join(out, "roblox-publish.html"),
  '<html data-theme="dark"><head><link rel="stylesheet" href="gallery.css"></head><body style="margin:0;background:var(--background)"><div id="root" style="display:flex;width:100vw;height:100vh"></div><script type="module" src="roblox-publish.js"></script></body></html>',
);
const boot = path.join(out, "roblox-publish.cjs");
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
  await wc.loadFile(${JSON.stringify(path.join(out, "roblox-publish.html"))});
  for (const theme of ['dark','light']) {
   // A place never on Roblox: its name, the game's title until the person types another, and one press.
   const first=await step(theme+'First','window.robloxRig.open({theme:"'+theme+'",scene:"first"})');
   assert.equal(first.stage,'ready');
   assert.equal(first.title,'Publish to Roblox');
   assert.equal(first.name,'Sky Race');
   assert.deepEqual(first.primary,{text:'Publish to Roblox',disabled:false});
   report[theme+'First']=await capture(theme+'-first');
   const pub=await step(theme+'Publishing','window.robloxRig.open({theme:"'+theme+'",scene:"publishing"})');
   assert.equal(pub.stage,'publishing');
   assert.deepEqual(pub.steps,['done','current','next']);
   assert.deepEqual(pub.primary,{text:'Publishing…',disabled:true});
   assert.deepEqual(pub.hints,["The agent is publishing in Roblox Studio. Closing this doesn't stop it."]);
   report[theme+'Publishing']=await capture(theme+'-publishing');
   const done=await step(theme+'Published','window.robloxRig.open({theme:"'+theme+'",scene:"published"})');
   assert.equal(done.stage,'published');
   assert.equal(done.published,'Your game is on Roblox');
   assert.equal(done.link,'www.roblox.com/games/7781440219');
   report[theme+'Published']=await capture(theme+'-published');
   const stop=await step(theme+'Stopped','window.robloxRig.open({theme:"'+theme+'",scene:"stopped"})');
   assert.equal(stop.stage,'stopped');
   assert.deepEqual(stop.alerts,["Roblox asks you to verify your age in Studio's Publish window. Answer it there, then try again."]);
   assert.deepEqual(stop.primary,{text:'Try again',disabled:false});
   report[theme+'Stopped']=await capture(theme+'-stopped');
  }
  // One press hands a first publish to the agent under the typed name; the card follows it.
  await step('firstAgain','window.robloxRig.open({scene:"first"})');
  await step('typed','window.robloxRig.name("Sky Racers")');
  const handed=await step('pressFirst','window.robloxRig.press()');
  assert.deepEqual(handed.sent,[{name:'first-publish',args:{name:'Sky Racers'}}],'one action, no other question');
  assert.equal(handed.stage,'publishing');
  // An update sends no name.
  await step('update','window.robloxRig.open({scene:"update"})');
  const updated=await step('pressUpdate','window.robloxRig.press()');
  assert.deepEqual(updated.sent,[{name:'publish-update',args:{}}]);
  // The game's page opens from the card once it is on Roblox.
  await step('publishedAgain','window.robloxRig.open({scene:"published"})');
  const opened=await step('openLink','window.robloxRig.openLink()');
  assert.deepEqual(opened.opened,['https://www.roblox.com/games/7781440219']);
  // A refused hand-over says why and gives Studio's own clicks.
  await step('refused','window.robloxRig.open({scene:"refused"})');
  const refused=await step('pressRefused','window.robloxRig.press()');
  assert.deepEqual(refused.alerts,['The person said no to computer control, so nothing was published.']);
  assert.ok(refused.hints.includes('File › Publish to Roblox'),JSON.stringify(refused.hints));
  report.refused=await capture('dark-refused');
  // No place yet: setup first. Where Genex can't click: Studio's own clicks, no press.
  const none=await step('noPlace','window.robloxRig.open({scene:"noPlace"})');
  assert.equal(none.stage,'no-place');
  assert.deepEqual(none.primary,{text:'Set up Roblox Studio',disabled:false});
  const hand=await step('byHand','window.robloxRig.open({scene:"byHand"})');
  assert.equal(hand.stage,'by-hand');
  assert.equal(hand.primary,null);
  assert.ok(hand.hints.includes('File › Publish to Roblox'));
  report.byHand=await capture('dark-by-hand');
  assert.deepEqual(report.errors,[]);
  console.log('PASS Roblox publish: one press hands the publish to the agent (a first one under the typed name, an update with none); the card follows it to Roblox with a link to the game, shows a stop in the agent’s words with Try again, a refusal with Studio’s clicks, setup for a game with no place, and Studio’s clicks where Genex can’t click');
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
