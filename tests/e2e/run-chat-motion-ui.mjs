/**
 * How the production ChatPanel moves while a person watches: a message sent, the work, its status
 * and clock, tools, a streamed reply, a permission question, a build and a message to a build's
 * lead (its card holds still), in a short and a long
 * chat, with normal and reduced motion. Synthetic events in a disposable Electron profile; no
 * engine, account or network. Evidence: .studio-dev/evidence/chat-motion-<time>/report.json.
 */
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildDesignGallery } from "../../scripts/design-gallery.mjs";
import { fixtureElectronArgs, fixtureElectronEnv, resolveElectron } from "../../scripts/electron-runtime.mjs";
import { sourceIdentity } from "../../scripts/studio-dev/files.mjs";

const RUN_TIMEOUT_MS = 180_000;
const out = await buildDesignGallery();
const evidence = path.resolve(".studio-dev/evidence", `chat-motion-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "genex-chat-motion-"));
await build({
  entryPoints: ["tests/fixtures/chat-motion.tsx"],
  outfile: path.join(out, "chat-motion.js"),
  bundle: true,
  format: "esm",
  jsx: "automatic",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(
  path.join(out, "chat-motion.html"),
  '<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="gallery.css"></head><body><div id="root" style="display:flex;height:860px"></div><script type="module" src="chat-motion.js"></script></body></html>',
);
const boot = path.join(out, "chat-motion.cjs");
await writeFile(
  boot,
  String.raw`
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
app.setPath('userData',${JSON.stringify(profile)});
const report={source:${JSON.stringify(sourceIdentity(process.cwd()))},profile:${JSON.stringify(profile)},providers:'synthetic',electron:process.versions.electron,scenes:[],failures:[],errors:[]};
const fail=(name,detail)=>report.failures.push({name,detail});
app.whenReady().then(async()=>{
 // Shown, but parked off screen: a window that is never shown never draws a frame.
 const win=new BrowserWindow({width:640,height:900,show:false,focusable:false,skipTaskbar:true,x:-4000,y:0,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 win.showInactive();
 const wc=win.webContents;
 wc.on('console-message',(event)=>{if(event.level==='error')report.errors.push(event.message)});
 try {
  await wc.loadFile(${JSON.stringify(path.join(out, "chat-motion.html"))});
  await wc.executeJavaScript('document.fonts.ready.then(()=>true)');
  wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Performance.enable');
  // Main-thread time a scene costs, from Chromium's own counters (seconds → ms).
  const cpu=async()=>Object.fromEntries((await wc.debugger.sendCommand('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
  const spent=(a,b)=>Object.fromEntries(['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration'].map(k=>[k,Math.round((b[k]-a[k])*1000)]));
  for(const motion of ['no-preference','reduce']) {
   await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:motion}]});
   for(const [scene,long] of [['turn',true],['turn',false],['question',true],['clock',true],['build',true],['longStream',true],['steer',true]]) {
    const before=await cpu();
    const result=await wc.executeJavaScript('window.runMotionScene('+JSON.stringify(scene)+','+long+')');
    const cost=spent(before,await cpu());
    const name=motion+' '+scene+(long?' long':' short');
    report.scenes.push({name,motion,long,cost,...result});
    console.log(name+': '+result.frames+' frames, '+result.jumps.length+' jumps, '+result.pops.length+' pops, '+result.flashes.length+' flashes, '+result.animatedFrames+' animated, '+result.longFrames+' long frames, '+result.longTasks+' long tasks ('+result.longTaskMs+' ms), main thread '+cost.TaskDuration+' ms (script '+cost.ScriptDuration+', layout '+cost.LayoutDuration+', style '+cost.RecalcStyleDuration+')');
    if(result.flashes.length) fail(name+': a status label flashed',result.flashes);
    // Held still: on show in every frame, never moved by as much as the recorder's jump (6px).
    if(result.held&&(result.held.missing>0||result.held.driftPx>=6)) fail(name+': the build card left or moved',result.held);
    if(motion==='reduce') {
     if(result.animatedFrames>0) fail(name+': reduced motion still animates',result.animatedFrames);
     continue;
    }
    if(result.jumps.length) fail(name+': parts jumped in one frame',result.jumps);
    if(result.pops.length) fail(name+': parts popped in or out',result.pops);
   }
  }
  fs.writeFileSync(${JSON.stringify(path.join(evidence, "chat.png"))},(await wc.capturePage()).toPNG());
 } catch(error) { report.failure=error.stack; console.error(error); }
 if(report.errors.length) fail('renderer errors',report.errors);
 fs.writeFileSync(${JSON.stringify(path.join(evidence, "report.json"))},JSON.stringify(report,null,2));
 for(const failure of report.failures) console.error('FAIL '+failure.name+' '+JSON.stringify(failure.detail).slice(0,600));
 app.exit(report.failure||report.failures.length?1:0);
});`,
);
try {
  const child = spawn(resolveElectron(), fixtureElectronArgs([boot]), { env: fixtureElectronEnv(), stdio: "inherit" });
  const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    if (code !== 0) throw new Error(`chat motion check failed (${code}); see ${evidence}/report.json`);
    console.log(`PASS chat motion; ${path.relative(process.cwd(), path.join(evidence, "report.json"))}`);
  } finally {
    clearTimeout(timer);
  }
} finally {
  await rm(profile, { recursive: true, force: true });
}
