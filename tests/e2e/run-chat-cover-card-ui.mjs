/**
 * The chat's Genex cover card, in a disposable Electron profile with a fake `window.studio`: the
 * production ChatPanel beside the production stage strip of the same game. The thread's latest
 * `genex__cover` shoot that kept a shot leaves one card once the turn that took it has ended: the
 * game's kept shot (read from Genex's storage by the game's name), captioned Genex cover, with
 * Publish, which opens Studio's own Publish dialog through the strip. A running publish, Genex
 * turned off or a kept frame Genex already took hide Publish; a shot that can no longer be read
 * leaves no card.
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
const RUN_TIMEOUT_MS = 90_000;

const out = await buildDesignGallery();
const evidence = path.resolve(".studio-dev/evidence", `chat-cover-card-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "genex-chat-cover-card-"));
await build({
  entryPoints: ["tests/fixtures/chat-cover-card.tsx"],
  outfile: path.join(out, "chat-cover-card.js"),
  bundle: true,
  format: "esm",
  jsx: "automatic",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(
  path.join(out, "chat-cover-card.html"),
  '<html data-theme="dark"><head><link rel="stylesheet" href="gallery.css"></head><body style="margin:0;background:var(--background)"><div id="root" style="display:flex;width:100vw;height:100vh"></div><script type="module" src="chat-cover-card.js"></script></body></html>',
);
const boot = path.join(out, "chat-cover-card.cjs");
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
 const win=new BrowserWindow({width:1280,height:820,show:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const wc=win.webContents;
 wc.on('console-message',(event)=>{if(event.level==='error')report.errors.push(event.message)});
 const js=(source)=>wc.executeJavaScript(source);
 const capture=async(name)=>{const file=path.join(evidence,name+'.png');fs.writeFileSync(file,(await wc.capturePage()).toPNG());return file;};
 const step=async(name,source)=>{const result=await js(source);report.steps[name]=result;return result;};
 try {
  await wc.loadFile(${JSON.stringify(path.join(out, "chat-cover-card.html"))});
  // Two candidates, a model and the winner in one turn: one card, the kept shot, once the turn has ended.
  const kept=await step('kept','window.coverCard.open("kept")');
  assert.equal(kept.cards.length,1,'one card for the thread');
  const [card]=kept.cards;
  assert.equal(card.callId,'kept','the card follows the last shot');
  assert.equal(card.label,'Genex cover');
  assert.equal(card.caption,'Genex cover');
  assert.equal(card.image.loaded,true,'the kept shot is drawn');
  assert.equal(card.image.shot,'kept');
  assert.equal(card.image.alt,"This game's Genex cover");
  assert.equal(card.image.ratio,1.78,'16:9');
  assert.ok(card.image.width>=300&&card.image.width<=420,'large enough to judge, never wider than a result card: '+card.image.width);
  assert.equal(card.publish,'Publish');
  assert.ok(card.publishLabel.startsWith(card.publish),'the name a voice or a reader uses starts with the words on the button');
  assert.deepEqual(card.publishType,card.resultButtonType,'Publish is set as the result buttons of the chat are (Play), only its fill is the accent');
  assert.equal(card.afterReply,true,'the card follows the builder\\'s line, as the turn ends');
  assert.deepEqual(kept.work,['Worked on 4 steps'],'every shot and the model stay in the work, as rows');
  assert.deepEqual(card.cursors,['pointer','pointer'],'the picture and Publish show the pointer');
  assert.ok(kept.reads.length>=1);
  for(const read of kept.reads) assert.deepEqual(Object.keys(read).sort(),['maxPx','project','scope'],'the card names the game and the scope, never a file');
  await js('window.coverCard.reveal()');
  report.card=await capture('cover-card');
  await js('window.coverCard.theme("light")');
  report.cardLight=await capture('cover-card-light');
  await js('window.coverCard.theme("dark")');
  // The picture opens the whole shot beside the chat.
  const picture=await step('picture','window.coverCard.openPicture()');
  assert.deepEqual(picture.opened,[{kind:'image',name:'Genex cover',whole:true}]);
  // Publish opens Studio's own Publish dialog through the stage strip, for this game.
  const pressed=await step('pressed','window.coverCard.press()');
  assert.deepEqual(pressed.setups,['genex']);
  assert.equal(pressed.dialog,true,'the Publish dialog is open');
  report.dialog=await capture('publish-dialog');
  // A publish already running, or Genex off: the card stays, Publish does not.
  const publishing=await step('publishing','window.coverCard.open("kept",{publishing:true})');
  assert.equal(publishing.cards.length,1);
  assert.equal(publishing.cards[0].publish,null,'no Publish while a publish runs');
  const off=await step('genexOff','window.coverCard.open("kept",{genex:"off"})');
  assert.equal(off.cards.length,1);
  assert.equal(off.cards[0].caption,'Genex cover');
  assert.equal(off.cards[0].publish,null,'no Publish while Genex is off');
  await js('window.coverCard.reveal()');
  report.genexOff=await capture('cover-card-genex-off');
  // The builder published in the turn and Genex took the kept frame: the card is done, with no Publish.
  const sent=await step('sent','window.coverCard.open("published",{sent:true})');
  assert.equal(sent.cards.length,1);
  assert.equal(sent.cards[0].publish,null,'nothing is left to publish for this cover');
  assert.deepEqual(sent.work,['Worked on 6 steps']);
  await js('window.coverCard.reveal()');
  report.sent=await capture('cover-card-sent');
  // The builder still at work after the winner: no card, so Publish never sits beside a cover still being chosen.
  const running=await step('running','window.coverCard.open("running")');
  assert.deepEqual(running.cards,[]);
  assert.deepEqual(running.work,['Worked on 5 steps']);
  // A tool after the winner: the turn's work stays one group, the card after the builder's line.
  const checked=await step('checked','window.coverCard.open("checked")');
  assert.deepEqual(checked.work,['Worked on 5 steps']);
  assert.equal(checked.cards.length,1);
  assert.equal(checked.cards[0].afterReply,true);
  // A later turn's kept shot takes the card; the earlier turn keeps only its rows.
  const turns=await step('turns','window.coverCard.open("turns")');
  assert.deepEqual(turns.cards.map((c)=>c.callId),['brighter']);
  assert.equal(turns.cards[0].image.shot,'brighter');
  assert.deepEqual(turns.work,['Worked on 4 steps','Worked on 1 step']);
  // A shot Genex's storage no longer holds leaves no card.
  const gone=await step('gone','window.coverCard.open("lost")');
  assert.deepEqual(gone.cards,[]);
  assert.deepEqual(report.errors,[]);
  console.log('PASS chat cover card: the latest kept shot once its turn ends, Publish opens the dialog, hidden while publishing, with Genex off or once the frame went out, gone with its shot');
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
