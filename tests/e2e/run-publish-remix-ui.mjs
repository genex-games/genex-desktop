/**
 * The Publish dialog's Allow remixing, in a disposable Electron profile with a fake `window.studio`:
 * a checkbox under the press, ticked unless the person last chose otherwise, sent with the press
 * (apps and web alike); Rights turns the dialog to what remixers can do and Back returns with the
 * tick kept; a project that could not go says why; an older Genex shows no checkbox. Dark and light.
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
const evidence = path.resolve(".studio-dev/evidence", `publish-remix-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "genex-publish-remix-"));
await build({
  entryPoints: ["tests/fixtures/publish-remix.tsx"],
  outfile: path.join(out, "publish-remix.js"),
  bundle: true,
  format: "esm",
  jsx: "automatic",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(
  path.join(out, "publish-remix.html"),
  '<html data-theme="dark"><head><link rel="stylesheet" href="gallery.css"></head><body style="margin:0;background:var(--background)"><div id="root" style="display:flex;width:100vw;height:100vh"></div><script type="module" src="publish-remix.js"></script></body></html>',
);
const boot = path.join(out, "publish-remix.cjs");
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
  await wc.loadFile(${JSON.stringify(path.join(out, "publish-remix.html"))});
  for (const theme of ['dark','light']) {
   // A Unity game with only apps: the checkbox sits under the press, ticked, on one line.
   const apps=await step(theme+'Apps','window.remixRig.open({theme:"'+theme+'"})');
   assert.equal(apps.shown,true);
   assert.equal(apps.checked,true,'ticked when no one chose yet');
   assert.equal(apps.line,'Allow remixing·Rights');
   assert.equal(apps.lineOneRow,true);
   assert.deepEqual(apps.order,['primary','remix'],'under the press');
   assert.deepEqual(apps.above,[{text:'Only Mac and Windows players can play it.',align:'center'}],'one centred line above the press');
   assert.deepEqual(apps.below,[],'nothing else under it');
   report[theme+'Apps']=await capture(theme+'-apps');
   const rights=await step(theme+'Rights','window.remixRig.rights()');
   assert.equal(rights.page.title,'What remixers can do');
   assert.deepEqual(rights.page.headings,['They can','Good to know']);
   assert.equal(rights.page.lines[0],'Copy and change Megastructure’s project to make their own game.');
   report[theme+'Rights']=await capture(theme+'-rights');
  }
  // The tick goes with the press, and an untick stays across a look at Rights.
  await step('appsAgain','window.remixRig.open({})');
  const sent=await step('pressAllowed','window.remixRig.press()');
  assert.deepEqual(sent.published,[{via:'apps',remix:true}]);
  await step('untick','window.remixRig.toggle()');
  await step('rightsAgain','window.remixRig.rights()');
  const terms=await step('terms','window.remixRig.terms()');
  assert.deepEqual(terms.opened,['https://genex.games/terms']);
  const back=await step('back','window.remixRig.back()');
  assert.equal(back.checked,false,'the untick outlasts the page');
  const off=await step('pressOff','window.remixRig.press()');
  assert.deepEqual(off.published.at(-1),{via:'apps',remix:false});
  // The person's last choice is the default next time.
  const last=await step('off','window.remixRig.open({scene:"off"})');
  assert.equal(last.checked,false);
  // A web game: the same checkbox under Publish to the web.
  const web=await step('web','window.remixRig.open({scene:"web"})');
  assert.equal(web.shown,true);
  assert.deepEqual(web.above,[{text:'Anyone with the link can play it.',align:'center'}],'a web game says who plays it above the press too');
  assert.deepEqual(web.below,[]);
  const webSent=await step('webPress','window.remixRig.press()');
  assert.deepEqual(webSent.published,[{via:'web',remix:true}]);
  report.web=await capture('dark-web');
  // A project that could not go says why under the checkbox.
  const big=await step('tooBig','window.remixRig.open({scene:"tooBig"})');
  assert.equal(big.problem,'Its project is too big to remix: Genex keeps up to 2 GB and 5,000 files.');
  report.tooBig=await capture('dark-too-big');
  const notSent=await step('notSent','window.remixRig.open({scene:"notSent"})');
  assert.equal(notSent.problem,'Its project didn’t go, so no one can remix it yet.');
  // An older Genex that can't send a project: no checkbox at all.
  const older=await step('older','window.remixRig.open({scene:"older"})');
  assert.equal(older.shown,false);
  assert.deepEqual(report.errors,[]);
  console.log('PASS Publish remix: Allow remixing sits under the press, ticked by default and sent with it (apps and web); Rights shows what remixers can do and Back keeps the tick; the last choice is the default; a project that did not go says why; an older Genex shows nothing');
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
