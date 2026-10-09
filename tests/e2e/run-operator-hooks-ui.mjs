/**
 * The stable hooks an unattended operator presses through dev control: the production Resume
 * buttons (morning card and chat line) and the first-launch welcome's Next / Skip for now / Start
 * building, rendered in a disposable Electron profile with a fake `window.studio`.
 */
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveElectron, fixtureElectronArgs, fixtureElectronEnv } from "../../scripts/electron-runtime.mjs";
import { sourceIdentity } from "../../scripts/studio-dev/files.mjs";

/** The whole check, from Electron's start to its exit. */
const RUN_TIMEOUT_MS = 60_000;

const out = await mkdtemp(path.join(os.tmpdir(), "genex-operator-hooks-out-"));
const evidence = path.resolve(".studio-dev/evidence", `operator-hooks-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "genex-operator-hooks-"));
await build({
  entryPoints: ["tests/fixtures/operator-hooks.tsx"],
  outfile: path.join(out, "operator-hooks.js"),
  bundle: true,
  format: "esm",
  jsx: "automatic",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(
  path.join(out, "operator-hooks.html"),
  '<html data-theme="dark"><body><div id="root" style="width:1080px;height:800px"></div><script type="module" src="operator-hooks.js"></script></body></html>',
);
const boot = path.join(out, "operator-hooks.cjs");
await writeFile(
  boot,
  `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(profile)});
const report={source:${JSON.stringify(sourceIdentity(process.cwd()))},profile:${JSON.stringify(profile)},providers:'synthetic',errors:[]};
report.electron=process.versions.electron;
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1080,height:900,show:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const wc=win.webContents;
 wc.on('console-message',(event)=>{if(event.level==='error')report.errors.push(event.message)});
 try {
  await wc.loadFile(${JSON.stringify(path.join(out, "operator-hooks.html"))});
  const r=await wc.executeJavaScript('window.runOperatorHookChecks()');
  report.result=r;
  const resume={tag:'BUTTON',text:'Resume',label:null,inFoot:false};
  // Morning card: one Resume carrying the run, its title as it was; pressing it resumes once.
  assert.deepEqual(r.morning.paused.map(({tag,text,label,inFoot,value,title})=>({tag,text,label,inFoot,value,title})),[{...resume,value:'run_paused',title:'Pick the build up where it left off'}]);
  assert.match(r.morning.paused[0].className,/result-button/);
  assert.equal(r.morning.clicks,1);
  assert.deepEqual(r.morning.finished,[]);
  assert.equal(r.morning.resumeButtons,0);
  // A card with no run id still offers Resume, but no hook that names no run.
  assert.deepEqual(r.morning.unnamed,{hooks:[],resumeButtons:1});
  // Chat line: the paused run's Resume carries its id and calls resumeAutopilot with it; none while another run works.
  assert.deepEqual(r.line.offered.map(({tag,text,label,inFoot,value,title})=>({tag,text,label,inFoot,value,title})),[{...resume,value:'run_line',title:null}]);
  assert.deepEqual(r.line.calls,[['run_line']]);
  assert.deepEqual(r.line.whileRunning,[]);
  // Welcome: Next, then Connect offers Skip for now until something is connected, Start building after.
  for(const welcome of [r.signedOut,r.signedIn]){
   assert.deepEqual(welcome.first.map((a)=>[a.value,a.text]),[['next','Next']]);
   assert.match(welcome.first[0].className,/ onboarding-cta$/);
  }
  assert.deepEqual(r.signedOut.connect.map((a)=>[a.value,a.text]),[['skip','Skip for now']]);
  assert.match(r.signedOut.connect[0].className,/onboarding-swap/);
  assert.equal(r.signedOut.startButtons,0);
  assert.deepEqual(r.signedIn.connect.map((a)=>[a.value,a.text,a.inFoot]),[['start','Start building',true]]);
  assert.match(r.signedIn.connect[0].className,/onboarding-cta onboarding-rise/);
  assert.equal(r.signedIn.skipButtons,0);
  assert.deepEqual(report.errors,[]);
  console.log('PASS operator hooks: Resume (morning card, chat line) and welcome Next / Skip for now / Start building');
 } catch(error) { report.failure=error.stack; console.error(error); }
 fs.writeFileSync(${JSON.stringify(path.join(evidence, "report.json"))},JSON.stringify(report,null,2));
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
  await rm(out, { recursive: true, force: true });
}
console.log(evidence);
