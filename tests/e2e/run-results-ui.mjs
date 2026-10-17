/** Render production result components with local media; no accounts or paid tools. */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { build } from "esbuild";
import { sourceIdentity } from "../../scripts/studio-dev/files.mjs";
import { resolveElectron, fixtureElectronArgs, fixtureElectronEnv } from "../../scripts/electron-runtime.mjs";
import { motionGlb } from "../helpers/glb.ts";
const root = process.cwd(),
  out = path.join(root, ".studio-dev/evidence/results-ui");
await fs.mkdir(out, { recursive: true });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "studio-results-"));
const model = (await fs.readFile("tests/fixtures/asset-previews/animated.glb")).toString("base64");
const tone = (await fs.readFile("tests/fixtures/asset-previews/tone.wav")).toString("base64");
// An animation-only file of the sample model's rig: Genex delivers a character's extra actions so.
const walk = motionGlb("Walk", ["Animated local model"]).toString("base64");
const source = `
import {createRoot} from 'react-dom/client';
import {fakeStudioApi} from './tests/helpers/fake-studio-api.ts';
import {useState,useRef} from 'react';
import {AssetResults} from './src/renderer/chat/AssetResults.tsx';
import {gltfRig,glbJsonLength} from './src/shared/model-rig.ts';
import {AssetsCanvas} from './src/renderer/panels/AssetsCanvas.tsx';
import {studio} from './src/renderer/state/studio.ts';
import {RunOutcome} from './src/renderer/panels/RunOutcome.tsx';
import {LearningSummary} from './src/renderer/chat/LearningSummary.tsx';
import {VirtualTranscript} from './src/renderer/chat/VirtualTranscript.tsx';
import {ResultButton} from './src/renderer/ui/ResultButton.tsx';
import {initializeAppearance,updateAppearance} from './src/renderer/appearance/store.ts';
initializeAppearance();window.setFixtureTheme=mode=>updateAppearance(p=>({...p,mode}));
const image={mimeType:'image/svg+xml',data:btoa('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#252e36"/><circle cx="630" cy="115" r="55" fill="#c7bf92"/><path d="M0 370L180 130L380 410L550 210L800 420V500H0Z" fill="#526357"/><path d="M0 450L200 330L420 450L700 340L800 400V500H0Z" fill="#394c45"/></svg>')};
const assets=['tree.glb','rock.glb','broken.glb'].map((file,i)=>({file:'assets/'+file,kind:'model',source:'genex',bytes:1024,mtime:'2026-09-22',jobId:'generation-'+i,at:'2026-09-'+(22-i)}));
const bytes=value=>Uint8Array.from(atob(value),char=>char.charCodeAt(0));
const modelBytes=file=>bytes(file.includes('broken')?'bm90IGEgZ2xi':file.includes('-walk')?${JSON.stringify(walk)}:${JSON.stringify(model)});
const rigOf=file=>{const b=modelBytes(file);const n=glbJsonLength(b.subarray(0,20));return n?gltfRig(file,JSON.parse(new TextDecoder().decode(b.subarray(20,20+n)))):null;};
window.studio={...fakeStudioApi().api,projectModelRigs:async({files})=>files.filter(f=>f.endsWith('.glb')).map(rigOf).filter(Boolean),readRunStill:async path=>{await new Promise(r=>setTimeout(r,350));if(path==='missing')return null;return image;},readProjectAsset:async()=>image,previewProjectAsset:async({file})=>file.endsWith('.wav')?{mimeType:'audio/wav',data:bytes(${JSON.stringify(tone)})}:({mimeType:'model/gltf-binary',data:modelBytes(file)}),presentProjectAssets:async({files})=>files.filter(file=>!file.includes('missing')),projectAssets:async project=>({project,assets:assets.slice(0,window.assetCount??assets.length),truncated:false,skipped:[]}),onEvent:()=>()=>{},revealProject:async()=>{window.revealed=true;}};
const summary={project:'fixture',runId:'result',execution:'completed',landed:true,head:'head',base:'base',deliveredHead:'head',deliveredSourceHead:'head',completeHistory:true,reason:null,learning:null,tasks:[],counts:{integrations:1,accepted:1,rejected:0,stopped:0,failed:0,superseded:0,running:0,queued:0,completedUnevaluated:0},evidence:[{id:'capture',head:'head',category:'visual',status:'passed',label:'Is there a giant mushroom?',note:'Technical observation',capture:'capture',source:'fixture'},{id:'checks',head:'head',category:'interaction',status:'incomplete',label:'Interaction check',note:null,source:'fixture'}]};
// Every painted frame of the next mounted assets canvas's camera while cards show: a jump between frames is a visible jolt.
window.recordCanvasFrames=()=>{const before=document.querySelector('[data-assets-canvas]');const frames=[];let on=true;const tick=()=>{const canvas=document.querySelector('[data-assets-canvas]');const layer=canvas?.querySelector('[data-grid-scale] + div');frames.push(canvas!==before&&layer&&canvas.querySelector('[data-asset-card]')?layer.style.transform:null);if(on)requestAnimationFrame(tick);};requestAnimationFrame(tick);window.stopCanvasFrames=()=>{on=false;return frames.filter(Boolean);};return true;};
function Fixture(){const [canvasKey,setCanvasKey]=useState(0);const [canvasProject,setCanvasProject]=useState('fixture');window.remountCanvas=name=>{setCanvasProject(name);setCanvasKey(k=>k+1);};window.showOneAsset=async()=>{window.assetCount=1;const library=studio().library;await new Promise(resolve=>{const stop=library.subscribe(state=>{if(state.assets.fixture?.value?.assets.length===1){stop();resolve();}});library.refreshAssets('fixture');});setCanvasKey(k=>k+1)};const [assetKey,setAssetKey]=useState(0);window.remountAsset=()=>setAssetKey(k=>k+1);const [notice,setNotice]=useState(''),[rows,setRows]=useState([{id:'first'}]);const scroller=useRef(null),follow=useRef(false);return <main className="grid grid-cols-2 gap-8 p-6 font-sans">
<section data-results-chat className="min-w-0 space-y-5"><AssetResults key={assetKey} deliveries={[{project:'fixture',source:'genex',jobId:'tree',at:'2026-09-22',files:[assets[0]]}]} onOpenAssets={()=>setNotice('Assets opened')}/><div data-audio-results><AssetResults deliveries={[{project:'fixture',source:'genex',jobId:'0d99db96-677f-436b-abcf-5da04d1e06cf',at:'2026-09-22',files:[{file:'assets/genex/0d99db96-677f-436b-abcf-5da04d1e06cf/referee-whistle-one-sharp-short-blast-st-cmucttyj.wav',kind:'audio',bytes:1}]},{project:'fixture',source:'genex',jobId:'build',at:'2026-09-22',files:[{file:'assets/genex/missing/crowd.wav',kind:'audio',bytes:1},{file:'assets/missing.png',kind:'image',bytes:1}]}]} onOpenAssets={()=>setNotice('Assets opened')}/></div><div data-animated-results><AssetResults deliveries={[{project:'fixture',source:'genex',jobId:'knight',at:'2026-09-22',files:[{file:'assets/knight.glb',kind:'model',bytes:1},{file:'assets/knight-walk.glb',kind:'model',bytes:1}]}]} onOpenAssets={()=>setNotice('Assets opened')}/></div><div data-build-updated className="flex items-center gap-3 text-chat text-ink-3"><span>Build updated</span><ResultButton onClick={()=>setNotice('Live opened')}>See it</ResultButton></div><RunOutcome conversation summary={summary} onPlay={()=>setNotice('Build opened')}/><LearningSummary text="4 past tasks reviewed · 1 proposed · 0 applied · 0 rejected" onOpenStudio={()=>setNotice('Studio opened')}/><output id="notice">{notice}</output></section>
<section className="min-w-0"><div className="relative h-[360px]"><AssetsCanvas key={canvasKey} project={canvasProject} onNotice={setNotice}/></div><div ref={scroller} id="motion-scroll" className="h-32 overflow-auto"><VirtualTranscript items={rows} scroller={scroller} follow={follow} renderItem={row=><p className="text-chat">{row.id}</p>}/></div><ResultButton id="append" onClick={()=>setRows(r=>[...r,{id:'new-'+r.length}])}>Append update</ResultButton><ResultButton id="prepend" onClick={()=>setRows(r=>[{id:'history-'+r.length},...r])}>Load history</ResultButton></section></main>};createRoot(document.getElementById('root')).render(<Fixture/>);`;
await build({
  stdin: { contents: source, loader: "tsx", resolveDir: root },
  outfile: path.join(out, "fixture.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
await fs.writeFile(
  path.join(out, "input.css"),
  `@import "${path.join(root, "src/renderer/theme.css")}";\n@source "${path.join(root, "src/renderer")}";`,
);
execFileSync(
  process.execPath,
  [
    "node_modules/@tailwindcss/cli/dist/index.mjs",
    "-i",
    path.join(out, "input.css"),
    "-o",
    path.join(out, "fixture.css"),
  ],
  { stdio: "pipe" },
);
await fs.cp("src/renderer/fonts", path.join(out, "fonts"), { recursive: true });
await fs.writeFile(
  path.join(out, "index.html"),
  '<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>',
);
const identity = { source: sourceIdentity(root), profile, providers: "synthetic fixture only" };
await fs.writeFile(
  path.join(out, "check.cjs"),
  String.raw`
const {app,BrowserWindow}=require('electron'),fs=require('node:fs');
app.setPath('userData',${JSON.stringify(profile)});
const report={identity:${JSON.stringify(identity)},checks:[],artifacts:[]},out=${JSON.stringify(out)};
app.whenReady().then(async()=>{const win=new BrowserWindow({width:1080,height:900,show:false,focusable:false,skipTaskbar:true,x:-4000,y:0,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});win.showInactive();const wc=win.webContents,errors=[];wc.on('console-message',details=>{if(details.level==='error'){errors.push(details.message);console.error('renderer:',details.message);}});
const js=code=>wc.executeJavaScript(code,true),wait=ms=>new Promise(r=>setTimeout(r,ms));
const check=(name,ok)=>{report.checks.push({name,ok});if(!ok)throw new Error(name);console.log('PASS '+name);};
const until=async(code)=>{for(let n=0;n<120;n++){if(await js(code))return;await wait(100);}throw new Error('Timed out '+code);};
const settles=code=>until(code).then(()=>true,()=>false);
const pointer=async(selector,click=false)=>{const r=await js('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');wc.sendInputEvent({type:'mouseMove',x:Math.round(r.x),y:Math.round(r.y)});if(click){wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:Math.round(r.x),y:Math.round(r.y)});wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:Math.round(r.x),y:Math.round(r.y)});}await wait(200);};
const capture=async name=>{await wc.capturePage();await wait(120);fs.writeFileSync(out+'/'+name+'.png',(await wc.capturePage()).toPNG());report.artifacts.push(name+'.png');};
try{await win.loadFile(out+'/index.html');await js('document.fonts.ready');await until('document.querySelector("[data-chat-assets] [data-thumbnail-state=ready]") && document.querySelector("[data-run-capture] img")?.complete');
check('inline model renders actual thumbnail',await js('document.querySelector("[data-chat-assets] img").naturalWidth>100'));
await until('document.querySelector("[data-audio-strip] input[type=range]")');
check('audio is one thin strip with a readable name',await js('(()=>{const r=document.querySelector("[data-audio-strip]");return document.querySelectorAll("[data-audio-strip]").length===1&&r.getBoundingClientRect().height<=44&&r.textContent.includes("Referee whistle one sharp short blast st")&&!r.textContent.includes("cmucttyj")})()'));
check('files missing from the game folder are not shown',await js('!document.querySelector("[data-audio-results]").innerHTML.includes("missing")&&!document.querySelector("[data-audio-results]").textContent.includes("Preview unavailable")'));
check('waveform reflects the decoded sound',await js('[...document.querySelectorAll("[data-audio-strip] span[style]")].some(b=>parseFloat(b.style.height)>12)'));
await pointer('[data-audio-strip] button[aria-label^=Play]',true);await until('document.querySelector("[data-audio-strip] button[aria-label^=Pause]")');
check('audio plays in place',true);await pointer('[data-audio-strip] button[aria-label^=Pause]',true);await until('document.querySelector("[data-audio-strip] button[aria-label^=Play]")');
check('audio strip controls use pointer cursors',await js('[...document.querySelectorAll("[data-audio-strip] button,[data-audio-strip] input")].every(e=>getComputedStyle(e).cursor==="pointer")'));
await pointer('[data-build-updated]');check('the strip shows its length at rest',await settles('getComputedStyle(document.querySelector("[data-audio-strip] .audio-time")).opacity==="1"&&getComputedStyle(document.querySelector("[data-audio-strip] [data-open-assets]")).opacity==="0"'));
await pointer('[data-audio-strip]');check('hover swaps the length for Open in Assets at the strip\'s end',await settles('getComputedStyle(document.querySelector("[data-audio-strip] [data-open-assets]")).opacity==="1"&&getComputedStyle(document.querySelector("[data-audio-strip] .audio-time")).opacity==="0"'));await capture('audio-hover');await pointer('[data-run-capture]');
check('capture expanded without diagnostic controls',await js('!!document.querySelector("[data-run-capture] img") && !/View capture|Technical details|Checks incomplete|Is there a giant/.test(document.querySelector("[data-chat-outcome]").textContent)'));
await js('window.remountAsset()');await wait(50);check('cached media remounts without a new fade',await js('getComputedStyle(document.querySelector("[data-chat-assets] img")).animationName==="none"'));
check('history initially has no entrance',await js('!document.querySelector("[data-chat-entry].chat-entry-arriving")'));
check('the card shows nothing on its picture at rest',await js('getComputedStyle(document.querySelector("[data-chat-assets] .asset-corner")).opacity==="0"&&!document.querySelector("[data-chat-assets] .asset-tile .result-button")'));
check('an animation file rides on its model\'s card instead of a card of its own',await js('document.querySelectorAll("[data-animated-results] .asset-tile").length===1&&document.querySelector("[data-animated-results] [data-asset-clips]")?.textContent==="1 animation"'));
await capture('results-dark');await pointer('[data-chat-assets] .asset-tile');
check('hover shows Open in Assets in the top corner',await settles('(()=>{const c=getComputedStyle(document.querySelector("[data-chat-assets] .asset-corner"));return c.opacity==="1"&&c.top==="8px"&&c.right==="8px"})()'));
check('card controls have pointer cursors',await js('[...document.querySelectorAll("[data-chat-assets] button")].every(e=>getComputedStyle(e).cursor==="pointer")'));
await capture('asset-hover');await pointer('[data-chat-assets] button[aria-label^=Preview]',true);await until('document.querySelector("[data-preview-ready=true] canvas")');
check('model dialog has no visible title or metadata',await js('document.querySelector("[role=dialog] h2").parentElement.classList.contains("sr-only") && !document.querySelector("[role=dialog]").innerText.includes("No embedded animations")'));
check('a model opens playing its first clip, in one animations bar',await settles('document.querySelector("[role=group][aria-label=Animations] button[aria-pressed=true]")&&Number(document.querySelector("[data-testid=asset-preview] canvas").dataset.animationTime)>0.05'));
await capture('model-dialog');
await pointer('[role=dialog] [aria-label=Close]',true);await until('!document.querySelector("[role=dialog]")');
check('closing model restores preview focus',await js('document.activeElement.matches("[data-chat-assets] button[aria-label^=Preview]")'));
await pointer('[data-animated-results] button[aria-label^=Preview]',true);await until('document.querySelector("[data-preview-ready=true] canvas")');
check('the model plays its animation files after its own clips',await settles('[...document.querySelectorAll("[role=group][aria-label=Animations] button[aria-pressed]")].map(b=>b.textContent).at(-1)==="Knight walk"'));
await pointer('[role=dialog] [aria-label=Close]',true);await until('!document.querySelector("[role=dialog]")');
await pointer('[data-chat-assets] .asset-tile');await pointer('[data-chat-assets] [data-open-assets]',true);check('Open in Assets works',await js('document.querySelector("#notice").textContent==="Assets opened"'));
await pointer('[data-build-updated] button',true);check('See it works',await js('document.querySelector("#notice").textContent==="Live opened"'));
await pointer('[data-chat-outcome] button:not([data-open-build])',true);check('Play works',await js('document.querySelector("#notice").textContent==="Build opened"'));
await js('document.querySelector("[data-results-chat] .chat-disclosure").click()');await wait(100);
check('learning only shows nonzero linked counts',await js('!document.querySelector("[data-results-chat]").textContent.includes("0 applied") && [...document.querySelectorAll("[data-results-chat] p button")].map(b=>b.textContent).join("|")==="4 past tasks reviewed|1 proposed"'));
await js('document.querySelector("[data-results-chat] p button").click()');check('learning opens Studio',await js('document.querySelector("#notice").textContent==="Studio opened"'));
await js('document.querySelector("#append").click()');check('new appended row fades',await js('!!document.querySelector("[data-chat-entry=\\"new-1\\"].chat-entry-arriving")'));await wait(200);
await js('document.querySelector("#prepend").click()');check('loaded history never fades',await js('!document.querySelector("[data-chat-entry=\\"history-2\\"].chat-entry-arriving")'));
check('asset grid has no per-file metadata',await js('!document.querySelector("[data-assets-canvas]").innerText.match(/job |MB|Source:|Usage unverified/)'));
await pointer('[data-asset-card="assets/broken.glb"] button',true);await until('document.querySelector("[role=dialog] [role=alert]")');await capture('model-error');
check('bad model has recovery control',await js('document.querySelector("[role=dialog]").textContent.includes("Reveal in Finder")'));await pointer('[role=dialog] [aria-label=Close]',true);await until('!document.querySelector("[role=dialog]")');
const LAYER='document.querySelector("[data-assets-canvas] [data-grid-scale] + div").style.transform';
await js('window.recordCanvasFrames()');await js('window.remountCanvas("fresh")');await until('document.querySelectorAll("[data-asset-card]").length===3');await wait(400);
const fresh=await js('window.stopCanvasFrames()');check('a canvas opened for the first time is fitted before its first paint',fresh.length>0&&fresh.every(t=>t===fresh.at(-1))&&fresh.at(-1)!=="translate(0px, 0px) scale(1)");
await pointer('[data-assets-canvas] button[aria-label="Zoom into the assets canvas"]',true);await wait(100);const left=await js(LAYER);
await js('window.recordCanvasFrames()');await js('window.remountCanvas("fresh")');await wait(400);
const back=await js('window.stopCanvasFrames()');check('a canvas the user moved comes back where it was left, from its first frame',back.length>0&&back.every(t=>t===left)&&(await js(LAYER))===left);
await js('window.recordCanvasFrames()');await js('window.remountCanvas("fixture")');await until('document.querySelectorAll("[data-asset-card]").length===3');await wait(400);
const refit=await js('window.stopCanvasFrames()');check('a canvas nobody moved comes back fitted, from its first frame',refit.length>0&&refit.every(t=>t===fresh.at(-1)));
await js('window.showOneAsset()');await until('document.querySelectorAll("[data-asset-card]").length===1');await wait(100);check('single asset fits at natural size',await js('document.querySelector("[data-assets-canvas]").textContent.includes("100%")'));await capture('single-asset');
await js('window.setFixtureTheme("light")');await wait(200);check('light theme uses light surfaces',await js('getComputedStyle(document.body).backgroundColor!=="rgb(31, 31, 31)"'));await capture('results-light');
wc.debugger.attach('1.3');await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
check('reduced motion disables preview fade',await js('getComputedStyle(document.querySelector(".asset-thumbnail")).animationName==="none"'));
wc.setZoomFactor(2);await wait(250);check('200% zoom has no horizontal overflow',await js('document.documentElement.scrollWidth<=innerWidth'));await capture('results-zoom');
check('no unexpected renderer errors',errors.filter(e=>!e.includes('not a valid GLB')).length===0);
}catch(error){report.error=error.stack;console.error(error);await capture('failure');}finally{report.result=report.error?'fail':'pass';fs.writeFileSync(out+'/report.json',JSON.stringify(report,null,2));win.destroy();app.exit(report.error?1:0);}});
`,
);
try {
  await new Promise((resolve, reject) => {
    const child = spawn(resolveElectron(), fixtureElectronArgs([path.join(out, "check.cjs")]), {
      env: fixtureElectronEnv(),
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("Results UI failed: " + code))));
  });
} finally {
  await fs.rm(profile, { recursive: true, force: true });
}
console.log("Results UI evidence: " + out);
