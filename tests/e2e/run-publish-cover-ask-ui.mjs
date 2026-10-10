/**
 * The Publish dialog's cover ask, in a disposable Electron profile with a fake `window.studio`:
 * the production dialog beside the production ChatPanel of the same game. The ask shows only while
 * the Genex plugin reports no cover shot to send and the owner chose none; its press closes the
 * dialog and leaves the ask in that game's composer, focused and unsent.
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
const RUN_TIMEOUT_MS = 60_000;

const out = await buildDesignGallery();
const evidence = path.resolve(".studio-dev/evidence", `publish-cover-ask-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "genex-publish-cover-ask-"));
await build({
  entryPoints: ["tests/fixtures/publish-cover-ask.tsx"],
  outfile: path.join(out, "publish-cover-ask.js"),
  bundle: true,
  format: "esm",
  jsx: "automatic",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(
  path.join(out, "publish-cover-ask.html"),
  '<html data-theme="dark"><head><link rel="stylesheet" href="gallery.css"></head><body style="margin:0;background:var(--background)"><div id="root" style="display:flex;width:100vw;height:100vh"></div><script type="module" src="publish-cover-ask.js"></script></body></html>',
);
const boot = path.join(out, "publish-cover-ask.cjs");
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
const PROMPT="Make this game's Genex cover.";
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1280,height:800,show:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const wc=win.webContents;
 wc.on('console-message',(event)=>{if(event.level==='error')report.errors.push(event.message)});
 const js=(source)=>wc.executeJavaScript(source);
 const capture=async(name)=>{const file=path.join(evidence,name+'.png');fs.writeFileSync(file,(await wc.capturePage()).toPNG());return file;};
 const step=async(name,source)=>{const result=await js(source);report.steps[name]=result;return result;};
 try {
  await wc.loadFile(${JSON.stringify(path.join(out, "publish-cover-ask.html"))});
  // No cover shot and none sent: the quiet line and its press, under the game.
  const none=await step('none','window.coverAsk.open("none")');
  assert.equal(none.dialog,true);
  assert.equal(none.stage,'none');
  assert.equal(none.ask,true,'a game with no cover shot is asked about');
  assert.equal(none.askLabel,"Ask for a cover in this game's chat");
  assert.ok(none.askLabel.startsWith(none.askButton),'the name a voice or a reader uses starts with the words on the button');
  report.noCover=await capture('no-cover');
  // A published game whose last publish found no shot to send: asked about too.
  const noneSent=await step('noneSent','window.coverAsk.open("noneSent")');
  assert.equal(noneSent.stage,'public');
  assert.equal(noneSent.ask,true);
  report.noCoverPublic=await capture('no-cover-public');
  // A shot kept, a send running, the owner's own pick, or a plugin older than covers: nothing asked.
  const shot=await step('shot','window.coverAsk.open("shot")');
  assert.equal(shot.dialog,true);
  assert.equal(shot.ask,false,'a kept shot is not asked for again');
  report.withCover=await capture('with-cover');
  for(const name of ['sending','older'])
   assert.equal((await step(name,'window.coverAsk.open("'+name+'")')).ask,false,name);
  const owner=await step('owner','window.coverAsk.open("owner")');
  assert.equal(owner.dialog,true);
  assert.equal(owner.ask,false,'the owner chose the cover on genex.games: nothing asked over it');
  report.ownerCover=await capture('owner-cover');
  // The press closes the dialog and leaves the ask in this game's composer, focused, unsent.
  await step('beforePress','window.coverAsk.open("none")');
  const pressed=await step('pressed','window.coverAsk.press()');
  assert.equal(pressed.dialog,false,'the dialog closed');
  assert.equal(pressed.closes,1);
  assert.equal(pressed.prompt,PROMPT);
  assert.equal(pressed.promptFocused,true,'the cursor is in the prompt, not on Publish');
  assert.deepEqual(pressed.sends,[],'nothing is sent for the person');
  report.composer=await capture('composer');
  // A draft already typed stays, after the ask.
  await step('draft','window.coverAsk.open("none",{draft:"Add rain to the track"})');
  const kept=await step('draftPressed','window.coverAsk.press()');
  assert.equal(kept.prompt,PROMPT+'\\n\\nAdd rain to the track');
  assert.deepEqual(kept.sends,[]);
  // Pressed again before sending: the ask is in the composer once, the cursor in the prompt.
  const reopened=await step('reopened','window.coverAsk.reopen()');
  assert.equal(reopened.ask,true);
  const twice=await step('pressedTwice','window.coverAsk.press()');
  assert.equal(twice.prompt,PROMPT+'\\n\\nAdd rain to the track','pressed twice, the ask is put in once');
  assert.equal(twice.promptFocused,true);
  assert.deepEqual(twice.sends,[]);
  report.composerTwice=await capture('composer-pressed-twice');
  // Another game's chat never takes this game's ask.
  await step('otherChat','window.coverAsk.open("none",{chatGame:"other-game"})');
  const other=await step('otherPressed','window.coverAsk.press()');
  assert.equal(other.dialog,false);
  assert.equal(other.prompt,'');
  assert.deepEqual(report.errors,[]);
  console.log('PASS Publish dialog cover ask: shown with no shot, hidden otherwise, composes into its game\\'s chat unsent');
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
