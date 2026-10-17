/**
 * The Publish dialog's cover, in a disposable Electron profile with a fake `window.studio`: the
 * production dialog beside the production ChatPanel of the same game. With no cover Studio takes
 * one; the arrows pick a recent frame; Another cover sends its ask through that chat and the banner
 * waits for the new frame; a kept clip plays behind its switch; the owner's cover is never touched.
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
const evidence = path.resolve(".studio-dev/evidence", `publish-cover-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "genex-publish-cover-"));
await build({
  entryPoints: ["tests/fixtures/publish-cover.tsx"],
  outfile: path.join(out, "publish-cover.js"),
  bundle: true,
  format: "esm",
  jsx: "automatic",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(
  path.join(out, "publish-cover.html"),
  '<html data-theme="dark"><head><link rel="stylesheet" href="gallery.css"></head><body style="margin:0;background:var(--background)"><div id="root" style="display:flex;width:100vw;height:100vh"></div><script type="module" src="publish-cover.js"></script></body></html>',
);
const boot = path.join(out, "publish-cover.cjs");
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
 const win=new BrowserWindow({width:1280,height:800,show:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const wc=win.webContents;
 wc.on('console-message',(event)=>{if(event.level==='error')report.errors.push(event.message)});
 const js=(source)=>wc.executeJavaScript(source);
 const capture=async(name)=>{const file=path.join(evidence,name+'.png');fs.writeFileSync(file,(await wc.capturePage()).toPNG());return file;};
 const step=async(name,source)=>{const result=await js(source);report.steps[name]=result;return result;};
 try {
  await wc.loadFile(${JSON.stringify(path.join(out, "publish-cover.html"))});
  // No cover yet: the dialog asks the plugin to take one and says so on the banner, then shows it.
  const none=await step('none','window.publishCover.open({})');
  assert.equal(none.dialog,true);
  assert.equal(none.busy,'Taking a cover','the banner says a cover is being taken');
  assert.deepEqual(none.actions,['cover-auto']);
  report.taking=await capture('taking');
  const taken=await step('taken','window.publishCover.untilShot()');
  assert.equal(taken.shot,true,'the cover Studio took is on the banner');
  assert.equal(taken.another,'picture','Another cover is offered');
  assert.equal(taken.arrows,0,'one frame: nothing to flip');
  report.cover=await capture('cover');
  // Three recent frames: dots and arrows; an arrow makes the next one the kept frame.
  const three=await step('three','window.publishCover.open({kept:"b",candidates:["c","b","a"]})');
  assert.deepEqual(three.actions,[],'a kept shot: Studio takes none');
  assert.equal(three.arrows,2);
  assert.equal(three.dots,'Cover 2 of 3');
  report.flip=await capture('flip');
  const next=await step('next','window.publishCover.next()');
  assert.ok(next.actions.includes('cover-pick'),'the arrow picks a frame');
  const picked=await step('picked','window.publishCover.settle(30).then(()=>window.publishCover.sample())');
  assert.equal(picked.dots,'Cover 3 of 3','the older frame is kept now');
  // Another cover: the field, Make sends the ask through this game's chat, the banner waits for it.
  await step('another','window.publishCover.press("[data-genex-another-cover]")');
  const field=await step('field','window.publishCover.sample()');
  assert.equal(field.field,true,'the field takes the foot');
  report.field=await capture('another-field');
  const made=await step('made','window.publishCover.make("closer on the snowball at sunset")');
  const ASK='Make another Genex cover for this game: closer on the snowball at sunset';
  // Sent through the chat's own send; a chat with no model to send to keeps it in its composer.
  assert.ok(made.sends.includes(ASK)||made.prompt===ASK,'the ask reached the chat: '+JSON.stringify(made));
  assert.equal(made.dialog,true,'the dialog stays open');
  assert.equal(made.busy?.startsWith('New cover'),true,'the banner says one is coming');
  assert.equal(made.hint,'The new one shows here when it’s ready.');
  report.making=await capture('making');
  const arrived=await step('arrived','window.publishCover.arrive("c")');
  assert.equal(arrived.busy,null,'a new frame ends the wait');
  assert.equal(arrived.another,'picture');
  // A kept clip plays behind its switch, and Another asks for a clip there.
  const clip=await step('clip','window.publishCover.open({kept:"a",candidates:["a"],clip:true})');
  assert.deepEqual(clip.show,['false','true'],'the clip shows first');
  assert.equal(clip.another,'clip');
  const playing=await step('playing','window.publishCover.settle(40).then(()=>window.publishCover.sample())');
  assert.equal(playing.playing,true,'the clip plays');
  report.clip=await capture('clip');
  // The owner's cover on genex.games: nothing is taken and nothing is offered over it.
  const owner=await step('owner','window.publishCover.open({owner:true})');
  assert.deepEqual(owner.actions,[]);
  assert.equal(owner.another,null);
  assert.deepEqual(report.errors,[]);
  console.log('PASS Publish dialog cover: taken when missing, flipped, asked for again, clip shown');
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
