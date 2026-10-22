/**
 * The Builds bar as the app renders it (its CSS, fonts and the shared dropdown) in a disposable
 * Electron window: tabs up to three builds, the picker past them, its list, focus, Escape and room.
 * Synthetic builds only; no accounts, providers or games.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { fixtureElectronArgs, fixtureElectronEnv, resolveElectron } from "../../scripts/electron-runtime.mjs";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { sourceIdentity } from "../../scripts/studio-dev/files.mjs";

const root = process.cwd();
const out = path.join(root, ".studio-dev/evidence/builds-bar-ui");
await fs.mkdir(out, { recursive: true });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "studio-builds-bar-"));

const source = `
import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {BuildStatus, PlayButton} from './src/renderer/panels/run-graph/chrome.tsx';
import {initializeAppearance} from './src/renderer/appearance/store.ts';
import {RunState} from './src/shared/run-state.ts';
initializeAppearance();
const ASKS=['Keep building the racing game','Keep going with the track and the cars','Keep improving the drift and the boost','MEGA update: night mode, rain and headlights','Please fix the camera shaking on sharp turns','Run a full test drive of every track','Continue where the last Loop stopped','Can you add a garage screen with car colors?','Add a lap timer and a ghost car of my best lap','Put rain and puddle reflections on the night streets','Make the crowd cheer at the finish line','Add a minimap in the corner','Give the police cars sirens','Let me race against two friends'];
const HOUR=3600000;
const build=(i,n)=>{const working=i===n-1;return {runId:'run-'+i,rounds:1,state:working?RunState.Running:RunState.Finished,startedAt:new Date(Date.now()-(n-i)*HOUR).toISOString(),ask:ASKS[i],since:working?Date.now()-61000:null};};
window.fixture={opened:[],escapes:[],observers:0};
// Every ResizeObserver the page makes: a list that re-attaches its watchers on each render makes more.
const Observer=window.ResizeObserver;window.ResizeObserver=class extends Observer{constructor(callback){super(callback);window.fixture.observers++;}};
window.addEventListener('keydown',e=>{if(e.key==='Escape')window.fixture.escapes.push(e.defaultPrevented);});
function Fixture(){
  const [n,setN]=useState(3),[open,setOpen]=useState('run-2'),[width,setWidth]=useState(900),[label,setLabel]=useState('Play');
  Object.assign(window.fixture,{show:(count,openIndex=count-1)=>{setN(count);setOpen('run-'+openIndex);},setWidth,setLabel});
  const builds=Array.from({length:n},(_,i)=>build(i,n));
  const onOpen=id=>{window.fixture.opened.push(id);setOpen(id);};
  return <div data-fixture-bar style={{width}} className="h-[440px] bg-canvas">
    <BuildStatus status={{strong:'Building',rest:'9 of 30 min'}} tabs={{builds,open,onOpen}} action={<PlayButton label={label} onPlay={()=>{}}/>}/>
  </div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);`;
await build({
  stdin: { contents: source, loader: "tsx", resolveDir: root },
  outfile: path.join(out, "fixture.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  logLevel: "silent",
  ...rendererBuildOptions(),
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
app.whenReady().then(async()=>{
const win=new BrowserWindow({width:1000,height:640,show:false,skipTaskbar:true,x:-4000,y:0,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
win.showInactive();const wc=win.webContents,errors=[];
wc.on('console-message',details=>{if(details.level==='error'){errors.push(details.message);console.error('renderer:',details.message);}});
const js=code=>wc.executeJavaScript(code,true),wait=ms=>new Promise(r=>setTimeout(r,ms));
const check=(name,ok)=>{report.checks.push({name,ok});if(!ok)throw new Error(name);console.log('PASS '+name);};
const until=async code=>{for(let n=0;n<60;n++){if(await js(code))return;await wait(50);}throw new Error('Timed out '+code);};
const settles=code=>until(code).then(()=>true,()=>false);
const click=async selector=>{const r=await js('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');wc.sendInputEvent({type:'mouseMove',x:r.x,y:r.y});wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:r.x,y:r.y});wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:r.x,y:r.y});await wait(250);};
const key=async name=>{wc.sendInputEvent({type:'keyDown',keyCode:name});wc.sendInputEvent({type:'keyUp',keyCode:name});await wait(250);};
const capture=async name=>{await wc.capturePage();await wait(120);fs.writeFileSync(out+'/'+name+'.png',(await wc.capturePage()).toPNG());report.artifacts.push(name+'.png');};
const show=async(count,openIndex)=>{await js('window.fixture.show('+count+','+(openIndex??count-1)+')');await wait(150);};
const MENU='[data-slot="dropdown-menu-content"]';
const menuOpen='!!document.querySelector(\''+MENU+'\')';
const tabs='document.querySelectorAll("[data-build-tab]").length';
const picker='!!document.querySelector("[data-build-picker]")';
const close=async()=>{await key('Escape');await until('!'+menuOpen.slice(2));};
try{
await win.loadFile(out+'/index.html');await js('document.fonts.ready');await until('!!document.querySelector("[data-testid=build-status]")');wc.focus();
check('three builds are three tabs beside Play',await settles(tabs+'===3&&!'+picker));
await capture('three-tabs');
await show(4);check('a fourth build turns the bar into one picker',await settles(tabs+'===0&&'+picker));
check('the picker names the open build in full and counts the builds',await js('(()=>{const p=document.querySelector("[data-build-picker]");return p.textContent.includes("MEGA update: night mode, rain and headlights")&&/4$/.test(p.textContent.trim())})()'));

await show(3);await js('document.querySelector("[data-build-tab][aria-selected=true]").focus()');await show(4);
check('focus on a tab moves to the picker when a fourth build arrives',await settles('document.activeElement?.matches("[data-build-picker]")'));
await show(3);check('focus on the picker moves to the open tab when the bar goes back to tabs',await settles('document.activeElement?.matches("[data-build-tab][aria-selected=true]")'));
await js('document.activeElement.blur()');

const shapeAt=async(width,label)=>{await js('window.fixture.setWidth('+width+');window.fixture.setLabel('+JSON.stringify(label)+')');await wait(120);return js(picker+'?"picker":"tabs"');};
const flips=[];for(let width=560;width<=760;width+=8){const short=await shapeAt(width,'Play');const long=await shapeAt(width,'Play latest');const opening=await shapeAt(width,'Opening…');if(short!==long||short!==opening)flips.push(width);}
check('Play\'s label never flips the bar between tabs and the picker',flips.length===0);
check('a narrow bar holds three builds in the picker',(await shapeAt(420,'Play'))==='picker');
check('a wide bar keeps them as tabs',(await shapeAt(900,'Play'))==='tabs');

await show(6);await click('[data-build-picker]');await until(menuOpen);
check('the list holds every build, newest first',await js('[...document.querySelectorAll("[data-build-row]")].map(r=>r.dataset.buildRow).join()==="run-5,run-4,run-3,run-2,run-1,run-0"'));
check('the open build\'s row is checked and filled',await js('(()=>{const r=document.querySelector("[data-build-row=run-5]");return r.dataset.state==="checked"&&getComputedStyle(r).backgroundColor!=="rgba(0, 0, 0, 0)"})()'));
check('rows show the choice their own way: no indicator box, their time or clock at the end',await js('!document.querySelector(\''+MENU+' [data-build-row] .size-4\')&&[...document.querySelectorAll("[data-build-row]")].every(r=>r.lastElementChild.textContent.trim().length>0)'));
check('the list keeps the dropdown\'s shadow when it does not scroll',await js('(()=>{const s=getComputedStyle(document.querySelector(\''+MENU+'\'));return s.maskImage==="none"&&s.boxShadow!=="none"})()'));
check('the picker and its rows show a pointer',await js('[document.querySelector("[data-build-picker]"),...document.querySelectorAll("[data-build-row]")].every(e=>getComputedStyle(e).cursor==="pointer")'));
await capture('list-open');
await key('Escape');
check('Escape closes the list and tells the window it was taken',await settles('!'+menuOpen.slice(2)+'&&window.fixture.escapes.at(-1)===true'));

await click('[data-build-picker]');await until(menuOpen);await click('[data-build-row="run-2"]');
check('picking a row opens that build',await settles('window.fixture.opened.at(-1)==="run-2"&&document.querySelector("[data-build-picker]").textContent.includes("Keep improving the drift and the boost")'));

await show(10);await click('[data-build-picker]');await until(menuOpen);
check('ten builds fit the list without scrolling or a fade',await js('(()=>{const m=document.querySelector(\''+MENU+'\');return m.scrollHeight<=m.clientHeight&&!m.hasAttribute("data-more")})()'));
await close();

await show(14);await click('[data-build-picker]');await until(menuOpen);
check('fourteen builds scroll, with a fade over the last row shown',await settles('document.querySelector(\''+MENU+'\').hasAttribute("data-more")'));
check('the list keeps its shadow while it scrolls',await js('(()=>{const s=getComputedStyle(document.querySelector(\''+MENU+'\'));return s.maskImage==="none"&&s.boxShadow!=="none"})()'));
await close();
const rowInView=id=>'(()=>{const m=document.querySelector(\''+MENU+'\').getBoundingClientRect(),r=document.querySelector("[data-build-row='+id+']").getBoundingClientRect();return r.top>=m.top&&r.bottom<=m.bottom-32+1})()';
await show(14,6);await click('[data-build-picker]');await until(menuOpen);
check('a build from the middle opens in view, with more rows below it',await settles('document.querySelector(\''+MENU+'\').hasAttribute("data-more")&&'+rowInView('run-6')));
check('the fade reaches the list\'s inner bottom edge, so no row scrolls by under it unfaded',await js('(()=>{const m=document.querySelector(\''+MENU+'\'),f=m.querySelector("[data-list-fade]");if(!f)return false;const b=m.getBoundingClientRect().bottom-parseFloat(getComputedStyle(m).borderBottomWidth),r=f.getBoundingClientRect();return Math.abs(r.bottom-b)<0.5&&Math.abs(r.height-32)<0.5})()'));
const watchers=await js('window.fixture.observers');
await js('window.fixture.setLabel("Play latest")');await wait(100);await js('window.fixture.setLabel("Play")');await wait(100);
check('the open list keeps its watchers while the bar re-renders',(await js('window.fixture.observers'))===watchers);
await capture('list-middle');
await close();
await show(14,1);await click('[data-build-picker]');await until(menuOpen);
check('an older open build\'s row is scrolled into view above the fade',await settles(rowInView('run-1')));
check('scrolled to its end, the list drops the fade',await settles('!document.querySelector(\''+MENU+'\').hasAttribute("data-more")'));
await capture('list-scrolled');
check('opened by pointer, the row is not focused',await js('!document.activeElement?.matches("[data-build-row]")'));
await close();
await js('document.querySelector("[data-build-picker]").focus()');await key('Enter');await until(menuOpen);
check('opened by keyboard, focus starts on the open build\'s row',await settles('document.activeElement?.matches("[data-build-row=run-1]")'));
await close();
check('no renderer errors',errors.length===0);
}catch(error){report.error=error.stack;console.error(error);await capture('failure');}
finally{report.result=report.error?'fail':'pass';fs.writeFileSync(out+'/report.json',JSON.stringify(report,null,2));win.destroy();app.exit(report.error?1:0);}});
`,
);
try {
  await new Promise((resolve, reject) => {
    const child = spawn(resolveElectron(), fixtureElectronArgs([path.join(out, "check.cjs")]), {
      env: fixtureElectronEnv(),
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Builds bar UI failed: ${code}`))));
  });
} finally {
  await fs.rm(profile, { recursive: true, force: true });
}
console.log(`Builds bar UI evidence: ${out}`);
