/**
 * The Assets canvas's cards for assets still being made, rendered by the production components in
 * Electron with a fake Genex and another plugin: every kind's drawing and tool, the clock, the queued and stopped
 * states, a cut prompt shown whole beside the card on hover, choosing and approving a character's candidate in place,
 * the chat's cards of what its work is making, zoom, resting motion, Reduce Motion and both
 * themes; and a build's Assets panel reading its jobs as the inventory does. No accounts or paid tools.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { build } from "esbuild";
import { sourceIdentity } from "../../scripts/studio-dev/files.mjs";
import { resolveElectron, fixtureElectronArgs, fixtureElectronEnv } from "../../scripts/electron-runtime.mjs";

const root = process.cwd(),
  out = path.join(root, ".studio-dev/evidence/making-cards-ui");
await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "studio-making-"));
const LONG_PROMPT =
  "Knight in rusted plate armor with a torn blue cape, a dented great helm and a longsword on his back, standing in an A-pose";
// The page's side: the fake Genex and the readings the checks make, so each check is one plain call.
const source = `
import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {AssetsPanel} from './src/renderer/panels/inspector/AssetsPanel.tsx';
import {buildRunGraph,buildsView} from './src/renderer/run-graph.ts';
import {fakeStudioApi} from './tests/helpers/fake-studio-api.ts';
import {AssetsCanvas} from './src/renderer/panels/AssetsCanvas.tsx';
import {studio} from './src/renderer/state/studio.ts';
import {MakingTiles} from './src/renderer/chat/MakingTiles.tsx';
import {genexJobShown,genexMaking,genexPhase} from './src/shared/asset-making.ts';
import {initializeAppearance,updateAppearance} from './src/renderer/appearance/store.ts';
initializeAppearance();window.setFixtureTheme=mode=>updateAppearance(p=>({...p,mode}));
const ago=s=>new Date(Date.now()-s*1000).toISOString();
const picture=color=>{const c=document.createElement('canvas');c.width=64;c.height=64;const g=c.getContext('2d');g.fillStyle=color;g.fillRect(0,0,64,64);return c.toDataURL('image/png');};
const PICTURES={1:picture('#c0392b'),2:picture('#27ae60'),3:picture('#2980b9')};
const job=(jobId,operation,pluginStatus,extra={})=>({source:'genex',jobId,operation,pluginStatus,at:ago(42),prompt:operation+' prompt',...extra});
// As main lists Genex's records: what each makes, its tool and phase; approved reviews and lookups never listed.
const listed=j=>{const made=genexMaking(j.operation);return {...j,phase:genexPhase(j.pluginStatus,{delivered:j.delivered}),...(made?{kind:made.kind}:{}),...(made?.tool?{tool:made.tool}:{})};};
const FORGE_ICON=(()=>{const c=document.createElement('canvas');c.width=32;c.height=32;const g=c.getContext('2d');g.fillStyle='#e67e22';g.fillRect(0,0,32,32);return c.toDataURL('image/png');})();
/** Another plugin's call making an image, as the host lists it while it runs. */
const FORGE={source:'sprite-forge',sourceName:'Sprite Forge',jobId:'forge-call',kind:'image',tool:'Pixel Lab',phase:'making',at:ago(12),prompt:'A shop sign'};
let genexRecords=[
  job('character','character','generating',{prompt:${JSON.stringify(LONG_PROMPT)}}),
  job('model','model','generating',{at:ago(118)}),
  job('image','image','accepted'),
  job('texture','texture','generating'),
  job('video','video','generating',{at:ago(3725)}),
  job('sound','sfx','generating',{at:undefined}),
  job('queued','character','requested'),
  job('review-1','character.preview','approval_required'),
  job('remesh','character.finalize','approval_required'),
  job('failed','image','failed',{generationId:'gen-failed'}),
  job('refused','character','failed'),
  job('gone','model','downloaded',{delivered:true}),
  job('approved','character.preview','approved'),
  job('status-call','status','generating'),
];
const inventory=()=>[...genexRecords.filter(r=>genexJobShown({operation:r.operation,status:r.pluginStatus,generationId:r.generationId})).map(listed),FORGE];
const approved=[];
const genexJobs=()=>genexRecords.filter(j=>j.operation.startsWith('character.')).map(j=>({id:j.jobId,project:'fixture',operation:j.operation,status:j.pluginStatus,files:[],createdAt:j.at,...(j.operation==='character.preview'?{approval:{sourceId:'s',images:[1,2,3].map(n=>({label:String(n),dataUrl:PICTURES[n]}))}}:{})}));
const notices=[];
const genex={manifest:{id:'genex',name:'Genex',version:'1.0.0',actions:[{name:'status',label:'Status'},{name:'approve',label:'Approve',confirmation:'Approve this candidate?'}]},source:'bundled',enabled:true,removed:false,health:'ok',state:'enabled'};
const forge={manifest:{id:'sprite-forge',name:'Sprite Forge',version:'1.0.0',actions:[]},source:'local',enabled:true,removed:false,health:'ok',state:'enabled',iconUrl:FORGE_ICON};
window.studio={...fakeStudioApi().api,
  projectModelRigs:async()=>[],
  projectAssets:async project=>({project,assets:[],jobs:inventory(),truncated:false,skipped:[]}),
  pluginsList:async()=>[genex,forge],
  pluginReview:async()=>({ticket:'ticket',message:'Approve?',images:[]}),
  pluginAction:async(id,name,args)=>{
    if(name==='status')return {connected:true,jobs:genexJobs()};
    if(name==='approve'&&args.id==='remesh')throw new Error('Genex could not start the remesh.');
    if(name==='approve'){approved.push(args);genexRecords=genexRecords.map(j=>j.jobId===args.id?{...j,pluginStatus:'approved'}:j);return {ok:true};}
    throw new Error('unexpected action '+name);
  },
  onEvent:()=>()=>{},
};
void studio().plugins.refresh();
const card=id=>document.querySelector('[data-assets-canvas] [data-asset-pending="'+id+'"]');
const chatCard=id=>document.querySelector('[data-chat-making] [data-asset-pending="'+id+'"]');
const inCard=(id,selector)=>card(id)?.querySelector(selector)??null;
window.mk={
  approved:()=>JSON.stringify(approved),
  notices:()=>notices.join('|'),
  count:()=>document.querySelectorAll('[data-assets-canvas] [data-asset-pending]').length,
  groupLabels:()=>[...document.querySelectorAll('[data-assets-canvas] .text-body-sm')].map(n=>n.textContent).join('|'),
  toolMark:id=>inCard(id,'[data-making-tool] img')?.getAttribute('src')===FORGE_ICON,
  chatCards:()=>[...document.querySelectorAll('[data-chat-making] [data-asset-pending]')].map(c=>c.dataset.assetPending+':'+Math.round(c.getBoundingClientRect().width)+'x'+Math.round(c.getBoundingClientRect().height)).join(','),
  chatApproveLabel:id=>chatCard(id)?.querySelector('[data-making-approve]')?.getAttribute('aria-label')??null,
  /** Approve on a chat card: its width, and whether it sits at the card's right edge. */
  chatApprove:id=>{const c=chatCard(id).getBoundingClientRect(),b=chatCard(id).querySelector('[data-making-approve]').getBoundingClientRect();return {w:Math.round(b.width),right:Math.abs(c.right-8-b.right)<2};},
  has:id=>card(id)!==null,
  phase:id=>card(id)?.dataset.making??null,
  art:id=>inCard(id,'canvas')?.dataset.makingArt??null,
  tool:id=>inCard(id,'[data-making-tool]')?.textContent??null,
  marksLoaded:()=>{const marks=[...document.querySelectorAll('[data-making-tool] img')];return marks.length>=9&&marks.every(i=>i.complete&&i.naturalWidth>0);},
  title:id=>inCard(id,'[data-making-title]')?.textContent??null,
  chipsFit:()=>[...document.querySelectorAll('[data-making-tool] .truncate')].every(n=>n.scrollWidth<=n.clientWidth),
  text:id=>card(id)?.textContent??'',
  clock:id=>inCard(id,'[data-making-clock]')?.textContent??null,
  spinner:id=>inCard(id,'.making-spinner')!==null,
  shimmering:()=>[...document.querySelectorAll('[data-assets-canvas] [data-making-title].chat-status-shimmer')].map(t=>t.closest('[data-making]').dataset.making),
  titleColor:id=>getComputedStyle(inCard(id,'[data-making-title]')).color,
  cutWithEllipsis:id=>{const p=inCard(id,'.making-prompt'),c=card(id).getBoundingClientRect(),r=p.getBoundingClientRect();return getComputedStyle(p).textOverflow==='ellipsis'&&p.scrollWidth>p.clientWidth&&r.right<=c.right;},
  tooltip:()=>[...document.querySelectorAll('[data-slot=tooltip-content]')].map(t=>t.textContent).join('|'),
  /** Where the open tooltip sits against a card: its side, whether it keeps off the card, and whether its arrow points at it. */
  tooltipBeside:id=>{const t=document.querySelector('[data-slot=tooltip-content]');if(!t)return null;const a=t.getBoundingClientRect(),c=card(id).getBoundingClientRect(),clear=a.left>=c.right-1||a.right<=c.left+1;return {side:t.dataset.side,clear,arrow:t.querySelector('svg')!==null};},
  ring:id=>getComputedStyle(card(id)).boxShadow,
  picture:id=>{const src=inCard(id,'img.making-picture')?.src;return src?Object.keys(PICTURES).find(n=>PICTURES[n]===src)??'other':null;},
  tabs:id=>[...card(id).querySelectorAll('.making-tab')].map(b=>b.getAttribute('aria-pressed')).join(','),
  pointerCursors:id=>[...card(id).querySelectorAll('button')].every(b=>getComputedStyle(b).cursor==='pointer'),
  approveLabel:id=>inCard(id,'[data-making-approve]')?.getAttribute('aria-label')??null,
  widths:()=>[...document.querySelectorAll('[data-making=making] canvas')].map(c=>c.width),
  background:id=>getComputedStyle(card(id)).backgroundColor,
  ink:id=>getComputedStyle(inCard(id,'canvas')).color,
  stillAnimations:()=>getComputedStyle(document.querySelector('.making-spinner')).animationName==='none'&&getComputedStyle(document.querySelector('[data-making=making] .chat-status-shimmer')).animationName==='none',
  rest:on=>{document.documentElement.dataset.motion=on?'rest':'live';return true;},
  /** A card's painted pixels: how many, their sum of alpha, and their box in CSS pixels. */
  painted:id=>{const c=inCard(id,'canvas'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0,sum=0,x0=1e9,y0=1e9,x1=-1,y1=-1;for(let i=3;i<d.length;i+=4){sum+=d[i];if(d[i]>8){n++;const p=(i-3)/4,x=p%c.width,y=Math.floor(p/c.width);x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);}}const s=c.width/160;return {n,sum,w:(x1-x0)/s,h:(y1-y0)/s,top:y0/s,bottom:y1/s};},
};
// The chat's work: a step whose job is the knight, one whose call is the forge's, one the remesh, and one that landed long ago.
const CALLS=[{ids:['call-1','character'],running:false},{ids:['forge-call'],running:true},{ids:['call-3','remesh'],running:false},{ids:['call-4','landed-gen'],running:false}];
// A build's log: a creature Genex took on and still says it is making two hours on, one it is making, and one it refused.
let seq=0;
const ev=(type,payload)=>({id:'e'+String(++seq).padStart(4,'0'),thread_id:'t',session_id:null,turn_id:null,created_at:new Date(Date.UTC(2026,9,13,10,seq)).toISOString(),data:{type:'custom',event_type:type,payload:{runId:'run_x',...payload}}});
const genexCall=(callId,prompt,reply)=>{const call={callId,pluginId:'genex',pluginName:'Genex Tools',tool:'asset',args:'operation=creature prompt='+prompt};return [ev('plugin_tool_started',call),ev('plugin_tool',{...call,ok:true,...reply})];};
const RUN=buildRunGraph([ev('run_started',{goal:'a keep',project:'fixture'}),
  ...genexCall('c-stale','A soldier in chainmail',{jobId:'j-stale',generationId:'gen-stale',result:'{"status":"accepted"}'}),
  ...genexCall('c-live','A guard captain',{jobId:'j-live',generationId:'gen-live',result:'{"status":"accepted"}'}),
  ...genexCall('c-refused','A refused guard',{jobId:'j-refused',result:'{"status":"failed","error":"Cannot quote this generation"}'})]);
const BUILDS=buildsView(RUN,null,{project:'fixture',assets:[],jobs:[{source:'genex',jobId:'gen-stale',phase:'unsure'},{source:'genex',jobId:'gen-live',phase:'making'}],truncated:false,skipped:[]});
const noop=()=>{};
function BuildsPanel(){return <div className="relative h-[640px] w-[600px]"><AssetsPanel graph={BUILDS} assets={BUILDS.nodes.find(n=>n.kind==='assets')} blender={null} project="fixture" onPrev={noop} onNext={noop} onClose={noop} onLight={noop} onOpenJob={noop}/></div>;}
window.mk.showBuilds=()=>{window.showBuilds();return true;};
window.mk.buildsText=()=>document.querySelector('[data-graph-panel=assets]')?.textContent??'';
window.mk.buildsShimmers=()=>document.querySelectorAll('[data-graph-panel=assets] .graph-shimmer').length;
function Fixture(){const [builds,setBuilds]=useState(false);window.showBuilds=()=>setBuilds(true);if(builds)return <main className="p-4 font-sans"><BuildsPanel/></main>;return <main className="flex gap-4 p-4 font-sans"><div className="relative h-[640px] w-[1080px]"><AssetsCanvas project="fixture" onNotice={text=>notices.push(text)}/></div><div className="w-[26rem]"><MakingTiles project="fixture" calls={CALLS} onNotice={text=>notices.push(text)}/></div></main>;}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
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
await fs.cp("src/renderer/media/tools", path.join(out, "media/tools"), { recursive: true });
await fs.writeFile(
  path.join(out, "index.html"),
  '<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>',
);
const identity = { source: sourceIdentity(root), profile, providers: "synthetic fixture only" };
const KINDS = ["character", "model", "image", "texture", "video", "sound"];
await fs.writeFile(
  path.join(out, "check.cjs"),
  String.raw`
const {app,BrowserWindow}=require('electron'),fs=require('node:fs');
app.setPath('userData',${JSON.stringify(profile)});
const report={identity:${JSON.stringify(identity)},checks:[],artifacts:[]},out=${JSON.stringify(out)};
const KINDS=${JSON.stringify(KINDS)},LONG_PROMPT=${JSON.stringify(LONG_PROMPT)};
app.whenReady().then(async()=>{const win=new BrowserWindow({width:1560,height:720,show:false,focusable:false,skipTaskbar:true,x:-4000,y:0,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});win.showInactive();const wc=win.webContents,errors=[];wc.on('console-message',details=>{if(details.level==='error'){errors.push(details.message);console.error('renderer:',details.message);}});
const js=code=>wc.executeJavaScript(code,true),wait=ms=>new Promise(r=>setTimeout(r,ms));
// One reading of the page: mk.<name>(...args), the arguments passed as JSON.
const mk=(name,...args)=>js('mk.'+name+'('+args.map(a=>JSON.stringify(a)).join(',')+')');
const check=(name,ok)=>{report.checks.push({name,ok:Boolean(ok)});if(!ok)throw new Error(name);console.log('PASS '+name);};
const until=async(read)=>{for(let n=0;n<120;n++){if(await read())return true;await wait(100);}return false;};
const pointer=async(selector,click=false)=>{const r=await js('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');wc.sendInputEvent({type:'mouseMove',x:Math.round(r.x),y:Math.round(r.y)});if(click){wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:Math.round(r.x),y:Math.round(r.y)});wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:Math.round(r.x),y:Math.round(r.y)});}await wait(250);};
const capture=async name=>{await wc.capturePage();await wait(120);fs.writeFileSync(out+'/'+name+'.png',(await wc.capturePage()).toPNG());report.artifacts.push(name+'.png');};
const card=id=>'[data-asset-pending="'+id+'"]';
const moves=async id=>{const a=await mk('painted',id);await wait(400);const b=await mk('painted',id);return a.sum!==b.sum;};
try{
await win.loadFile(out+'/index.html');await js('document.fonts.ready');await js('window.setFixtureTheme("dark")');
check('the cards appear',await until(async()=>(await mk('count'))>0));await wait(600);
check('a card per job that makes something, none for an approved review, a call that makes nothing or a request refused before it started',(await mk('count'))===12&&!(await mk('has','approved'))&&!(await mk('has','status-call'))&&!(await mk('has','refused')));
check('another plugin\'s call is a card in its own group, named by its plugin, showing the tool it names with the plugin\'s icon',(await mk('groupLabels')).split('|').includes('Sprite Forge')&&(await mk('tool','forge-call'))==='Pixel Lab'&&(await until(()=>mk('toolMark','forge-call'))));
check('the chat shows the cards of what its work is still making, at the canvas\'s size, and none for what landed',await until(async()=>(await mk('chatCards'))==='character:184x168,forge-call:184x168,remesh:376x344'));
for(const kind of KINDS)check(kind+' draws its own subject',(await mk('art',kind))===kind);
const tools=[];for(const kind of KINDS)tools.push(await mk('tool',kind));
check('each card names the tool Genex routes its kind to: '+tools.join(', '),JSON.stringify(tools)===JSON.stringify(["Meshy","Tripo","GPT Image","Nano Banana","MiniMax","ElevenLabs"]));
check('each tool wears its mark',await until(()=>mk('marksLoaded')));
check('every tool name fits its chip',await mk('chipsFit'));
check('the kind is the title, the prompt below it',(await mk('title','model'))==='3D model'&&(await mk('text','model')).includes('model prompt'));
check('a running job shows how long it has run',/^1:5\d$/.test(await mk('clock','model'))&&/^1:02:0\d$/.test(await mk('clock','video')));
const before=await mk('clock','character');await wait(1200);
check('the clock moves on',(await mk('clock','character'))!==before);
check('a job that never said when it started shows only the spinner',(await mk('clock','sound'))===''&&(await mk('spinner','sound')));
const shimmering=await mk('shimmering');
check('only the seven cards being made shimmer',shimmering.length===7&&shimmering.every(p=>p==='making'));
check('a queued job says Queued, with no clock',(await mk('text','queued')).includes('Queued')&&(await mk('clock','queued'))===null);
check('a failed job says it did not finish, in its own colour',(await mk('title','failed'))==='Didn’t finish'&&(await mk('titleColor','failed'))!==(await mk('titleColor','model')));
check('a delivered job whose files left the game never spins',(await mk('phase','gone'))==='not-in-game'&&(await mk('title','gone'))==='Not in your game'&&(await mk('clock','gone'))===null);
for(const kind of KINDS){const p=await mk('painted',kind);check(kind+' draws inside its area, below the chip and above the label',p.n>200&&p.top>=16&&p.bottom<=110);}
check('a card being made moves',await moves('character'));
check('a queued card is still',!(await moves('queued')));
check('a long prompt is cut with an ellipsis inside the card',await mk('cutWithEllipsis','character'));
await pointer(card('character')+' canvas');await wait(400);
check('hovering the drawing shows no tooltip',(await mk('tooltip'))==='');
await pointer(card('model')+' [data-making-prompt]');await wait(400);
check('a prompt the line shows whole gets no tooltip',(await mk('tooltip'))==='');
await pointer(card('character')+' [data-making-prompt]');
check('hovering a cut prompt shows it whole',await until(async()=>(await mk('tooltip')).includes(LONG_PROMPT)));
const beside=await mk('tooltipBeside','character');
check('the tooltip opens to the right of the card, off it, with its arrow',beside?.side==='right'&&beside.clear&&beside.arrow);
await capture('making-cards-dark');
await pointer('main');await wait(300);
check('a review wears the accent ring',(await mk('ring','review-1')).includes('1.5px'));
check('a review shows its first candidate once Genex answers',await until(async()=>(await mk('picture','review-1'))==='1'));
check('a review offers its three candidates and Approve, all with pointer cursors',(await mk('tabs','review-1'))==='true,false,false'&&(await mk('pointerCursors','review-1')));
await pointer(card('review-1')+' .making-tab:nth-child(2)',true);
check('a tab shows that candidate',await until(async()=>(await mk('picture','review-1'))==='2'&&(await mk('tabs','review-1'))==='false,true,false'));
check('Approve names the candidate it approves',(await mk('approveLabel','review-1'))==='Approve candidate 2');
await capture('making-review');
await pointer(card('review-1')+' [data-making-approve]',true);
check('Approve approves the candidate shown, through the plugin',await until(async()=>(await mk('approved'))===JSON.stringify([{id:'review-1',candidate:2}])));
check('an approved review leaves the canvas',await until(async()=>!(await mk('has','review-1'))));
check('the chat\'s card waiting on a choice is two cards wide and tall, and offers the same Approve',(await mk('chatApproveLabel','remesh'))==='Approve the remesh');
const chatApprove=await mk('chatApprove','remesh');
check('its Approve keeps a canvas card\'s width, at the right: '+chatApprove.w+'px',chatApprove.w===168&&chatApprove.right);
check('a remesh offers one Approve, with no candidate tabs and no picture',(await mk('tabs','remesh'))===''&&(await mk('picture','remesh'))===null&&(await mk('approveLabel','remesh'))==='Approve the remesh');
await pointer(card('remesh')+' [data-making-approve]',true);
check('an approval that fails says why, and the card stays',await until(async()=>(await mk('notices')).includes('Genex could not start the remesh'))&&(await mk('has','remesh')));
const big=await mk('widths');
await pointer('[aria-label="Zoom into the assets canvas"]',true);await pointer('[aria-label="Zoom into the assets canvas"]',true);await wait(900);
const zoomed=await mk('widths');
check('the drawings stay sharp as the canvas zooms in',zoomed.some((w,i)=>w>big[i]));
await pointer('[aria-label="Fit every asset"]',true);await wait(600);
await mk('rest',true);await wait(150);
check('motion rests while nobody looks',!(await moves('character')));
await mk('rest',false);await wait(300);
check('and moves again when someone does',await moves('character'));
const darkCard=await mk('background','model'),darkInk=await mk('ink','model');
await js('window.setFixtureTheme("light")');await wait(400);
check('light theme draws on its own card, in its own ink',(await mk('background','model'))!==darkCard&&(await mk('ink','model'))!==darkInk);
await capture('making-cards-light');
wc.debugger.attach('1.3');await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await wait(400);
check('Reduce Motion stills the drawings, the spinner and the shimmer',!(await moves('character'))&&(await mk('stillAnimations')));
// Painted pixels include the strokes' width and the glow's blur around the geometry (making-art.test.ts bounds that).
for(const kind of KINDS){const p=await mk('painted',kind);check(kind+' is about half the card: '+Math.round(p.w)+'×'+Math.round(p.h),p.w<=80&&p.h<=68);}
await mk('showBuilds');
check('a build\'s Assets panel lists a job Genex still says it is making two hours on as Not confirmed, still, and no request it refused',await until(async()=>{const t=await mk('buildsText');return t.includes('Making · 1')&&t.includes('Not confirmed · 1')&&t.includes('A soldier in chainmail')&&!t.includes('A refused guard')&&!t.includes('Failed');})&&(await mk('buildsShimmers'))===1);
await capture('builds-assets-panel');
check('no unexpected renderer errors',errors.length===0);
}catch(error){report.error=error.stack;console.error(error);await capture('failure').catch(()=>{});}finally{report.result=report.error?'fail':'pass';fs.writeFileSync(out+'/report.json',JSON.stringify(report,null,2));win.destroy();app.exit(report.error?1:0);}});
`,
);
// A script that does not parse would leave Electron waiting with no window: refuse it here instead.
execFileSync(process.execPath, ["--check", path.join(out, "check.cjs")], { stdio: "inherit" });
try {
  await new Promise((resolve, reject) => {
    const child = spawn(resolveElectron(), fixtureElectronArgs([path.join(out, "check.cjs")]), {
      env: fixtureElectronEnv(),
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("Making cards UI failed: " + code))));
  });
} finally {
  await fs.rm(profile, { recursive: true, force: true });
}
console.log("Making cards UI evidence: " + out);
