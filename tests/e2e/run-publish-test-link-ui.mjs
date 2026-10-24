/**
 * The Publish dialog's test link, in a disposable Electron profile with a fake `window.studio`: it
 * shows under "Publish to the web" before the first publish and under the public link once live
 * changes wait, never when the draft is the live build; its line names a second player only for a
 * multiplayer game; nothing overflows the dialog; and the main press still publishes once.
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
const evidence = path.resolve(".studio-dev/evidence", `publish-test-link-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "genex-publish-test-link-"));
await build({
  entryPoints: ["tests/fixtures/publish-test-link.tsx"],
  outfile: path.join(out, "publish-test-link.js"),
  bundle: true,
  format: "esm",
  jsx: "automatic",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(
  path.join(out, "publish-test-link.html"),
  '<html data-theme="dark"><head><link rel="stylesheet" href="gallery.css"></head><body style="margin:0;background:var(--background)"><div id="root" style="display:flex;width:100vw;height:100vh"></div><script type="module" src="publish-test-link.js"></script></body></html>',
);
const boot = path.join(out, "publish-test-link.cjs");
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
  await wc.loadFile(${JSON.stringify(path.join(out, "publish-test-link.html"))});
  // No tested draft yet: today's dialog, untouched.
  const fresh=await step('fresh','window.testLink.open("fresh")');
  assert.equal(fresh.dialog,true);
  assert.equal(fresh.primary,'Publish to the web');
  assert.equal(fresh.testText,null,'no tested draft, no test link');
  assert.deepEqual(fresh.hints,['Anyone with the link can play it.'],'the intro stays when there is no test line');
  report.fresh=await capture('fresh');
  // Before the first publish, a tested draft: the test link under the main press, one line under it.
  const draft=await step('draft','window.testLink.open("draft")');
  assert.deepEqual(draft.order,['primary','test']);
  assert.ok(draft.testText.startsWith('Test link:'),draft.testText);
  assert.ok(draft.testText.includes('preview--cathedral-chess.genex.technology'),draft.testText);
  assert.equal(draft.testCopyLabel,'Copy the test link');
  assert.equal(draft.note,'Friends can play it before you publish.','a single-player game is not told about a second player');
  assert.deepEqual(draft.hints,[],'the test line stands in for the intro');
  assert.equal(draft.overflow,false,'nothing pokes out of the dialog');
  report.draft=await capture('draft');
  const draftMp=await step('draftMp','window.testLink.open("draft",{multiplayer:true})');
  assert.equal(draftMp.note,'Friends can play it before you publish. Open it in a private window to join as another player.');
  assert.equal(draftMp.overflow,false);
  report.draftMultiplayer=await capture('draft-multiplayer');
  // Live with newer changes: Publish update, the labelled public link, then the test link.
  const newer=await step('newer','window.testLink.open("newer",{multiplayer:true})');
  assert.equal(newer.stage,'public');
  assert.equal(newer.primary,'Publish update');
  assert.deepEqual(newer.order,['primary','public','test']);
  assert.ok(newer.publicText.startsWith('Public:'),newer.publicText);
  assert.ok(newer.publicText.includes('genex.games/cathedral-chess'),newer.publicText);
  assert.equal(newer.note,'Try your changes before you update. Open it in a private window to join as another player.');
  assert.equal(newer.overflow,false);
  report.newer=await capture('live-newer');
  // Live and the draft is the publish's own build: no test link.
  const same=await step('same','window.testLink.open("same",{multiplayer:true})');
  assert.equal(same.testText,null,'the live build is not offered as a test');
  assert.deepEqual(same.order,['primary','public']);
  report.same=await capture('live-same');
  // The main press publishes exactly as before: once, this game, its name.
  await step('beforeDraftPress','window.testLink.open("draft",{multiplayer:true})');
  const pressedDraft=await step('pressedDraft','window.testLink.press()');
  assert.deepEqual(pressedDraft.publishes,[{game:'cathedral-chess',title:'Cathedral Chess'}]);
  await step('beforeUpdatePress','window.testLink.open("newer",{multiplayer:true})');
  const pressedUpdate=await step('pressedUpdate','window.testLink.press()');
  assert.equal(pressedUpdate.publishes.length,2,'Publish update publishes too');
  assert.deepEqual(pressedUpdate.publishes[1],{game:'cathedral-chess',title:'Cathedral Chess'});
  assert.deepEqual(report.errors,[]);
  console.log('PASS Publish dialog test link: shown only for builds players lack, labelled, fits, and Publish still publishes once');
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
