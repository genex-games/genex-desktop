/** Real composer with deterministic, credential-free gallery data. */
import { useEffect, useState } from 'react';
import { OPEN_SETTINGS_EVENT, type SettingsRequest } from '../../src/renderer/settings-navigation.ts';
import { PromptBar, type ModelChoice, type RoleRecord } from '../../src/renderer/ui/PromptBar.tsx';
import {toChoices, withRoleEfforts, effortScale, unifiedEffort} from '../../src/renderer/model-choices.ts';
import type { EngineDescriptor } from '../../src/renderer/types.ts';
import type { StudioApi } from '../../src/shared/studio-api.ts';
import type { PluginInfo } from '../../src/shared/plugins.ts';
import type { McpConnectorView } from '../../src/shared/mcp.ts';
import { RunState } from '../../src/shared/run-state.ts';
import type { ComposerBuild } from '../../src/renderer/loop-setting.ts';
const galleryModels:ModelChoice[]=[
 {key:'codex::fixture-astra',name:'Astra fixture',group:'OpenAI fixtures',contextWindow:258400,supportsFast:true,supportsSessions:true,efforts:['low','medium','high','xhigh','max','ultra'],defaultEffort:'medium'},
 {key:'claude-code::fixture-opus',name:'Opus fixture',group:'Claude fixtures',contextWindow:1000000,supportsSessions:true,efforts:['low','medium','high','max'],defaultEffort:'high'},
 {key:'ollama::fixture-local',name:'A deliberately long local model name for truncation',group:'Local fixtures',contextWindow:32000,efforts:[],supportsSessions:true},
];
const galleryEngines: EngineDescriptor[] = galleryModels.map(choice=>({
 id:choice.key.split('::')[0]!, label:choice.group!, kind:choice.key.startsWith('ollama')?'direct':'delegated',
 status:{code:'ready',detail:'Fixture ready'},defaultModel:null,supportsSessions:true,
 models:[{id:'default',label:'Provider default',contextWindow:0,supportsTools:true,supportsVision:true},
 {id:choice.key.split('::')[1]!,label:choice.name,contextWindow:choice.contextWindow??0,supportsTools:true,supportsVision:true,efforts:choice.efforts,defaultEffort:choice.defaultEffort,supportsFast:choice.supportsFast}].filter(m=>!choice.key.startsWith('ollama')||m.id!=='default'),
}));
const choices=toChoices([...galleryEngines,{id:'empty-local',label:'Local model (Ollama)',kind:'direct',status:{code:'not_running',detail:'Fixture unavailable'},defaultModel:null,models:[]}]);
const plugins:PluginInfo[]=['Genex fixture','Local Blender'].map((name,index)=>({
 manifest:{apiVersion:3,id:index===0?'fixture':'blender',name,version:'1.0.0',publisher:'Gallery',description:'Gallery fixture',backend:'backend.mjs',capabilities:[],tools:[],skills:[],panels:[],settings:[],actions:[]},
 enabled:index===0,removed:false,health:'ready',state:index===0?'enabled':'not-enabled',source:'bundled',
}));
plugins[0]!.manifest.account={connect:'connect',unlock:'connect',disconnect:'disconnect',status:'status'};
let account:'locked'|'unlocked'='locked';
const connectors=[{connector:{id:'fixture-assets',name:'Genex fixture · Assets',enabled:false,source:{plugin:'fixture',server:'assets'},transport:'stdio',scope:'global',toolPolicy:{},createdAt:'2026-09-20'},health:'disabled',trusted:true,secrets:[],secretsAvailable:false,toolCount:0}] as McpConnectorView[];
if(!window.studio)Object.defineProperty(window,'studio',{value:{
 blenderStatus:async()=>({enabled:false,code:'ready',detail:'Fixture Blender'}),settings:async()=>({blender:false}),
 onEvent:()=>()=>{},setSettings:async()=>({blender:true}),
 pluginsList:async()=>plugins.map(p=>({...p})),mcpList:async()=>connectors,
 connections:async()=>({revision:1,appliedRevision:null,active:false,sources:[{id:'fixture',name:'Genex fixture',kind:'plugin',enabled:true,health:'ready',tools:0,account}]}),
 pluginAction:async()=>{account='unlocked';},
 pluginEnable:async(id:string,enabled:boolean)=>{const plugin=plugins.find(p=>p.manifest.id===id);if(plugin)plugin.enabled=enabled;},
 engines:async()=>[],threads:async()=>[],games:async()=>[],staged:async()=>[],
 // A dropped file's place on disk, as the preload answers it.
 pathOfFile:(file:File)=>`/Users/you/Downloads/${file.name}`,
 // Two subscriptions with fixed plan limits: one high, one nearly spent, and an exhausted model
 // bucket the panel leaves out.
 providerUsage:async()=>[
  {engine:'claude-code',state:'ready',account:'terminal',usage:{measuredAt:new Date().toISOString(),plan:'max',windows:[
   {id:'five_hour',label:'5-hour limit',percent:0,resetsAt:new Date(Date.now()+(3*60+54)*60_000+30_000).toISOString()},
   {id:'seven_day',label:'Weekly · all models',percent:95,resetsAt:new Date(Date.now()+5*86_400_000).toISOString()},
   {id:'model:fable',label:'Weekly · Fable',percent:100,resetsAt:new Date(Date.now()+5*86_400_000).toISOString()}]}},
  {engine:'codex',state:'ready',account:'terminal',usage:{measuredAt:new Date().toISOString(),plan:'pro',windows:[
   {id:'codex:10080',label:'Weekly limit',percent:76,resetsAt:new Date(Date.now()+2*86_400_000).toISOString()}]}},
 ],
 openUrl:async(url:string)=>{document.body.dataset.openedUrl=url;},
} as unknown as StudioApi});
/** The builds a gallery chat can hold: none, running (∞ or 30 m), paused (30 m) or finished. */
const SPECIMEN_BUILDS:Record<string,ComposerBuild|null>={
 none:null,
 'running-inf':{state:RunState.Running,loop:{on:true,hours:null}},
 'running-30':{state:RunState.Running,loop:{on:true,hours:0.5}},
 'paused-30':{state:RunState.Paused,loop:{on:true,hours:0.5}},
 finished:{state:RunState.Finished,loop:{on:true,hours:0.5}},
};
/** Two gallery chats and the build each holds, so the composer's per-chat Loop can be switched. */
function SpecimenSwitches({chat,onChat,build,onBuild}:{chat:string;onChat:(key:string)=>void;build:string;onBuild:(key:string)=>void}){
 const button=(on:boolean)=>`rounded px-1.5 py-0.5 ${on?'bg-hover text-ink':'text-ink-3'}`;
 return <div className="flex flex-wrap gap-1 text-xs">
  {['a','b'].map(id=><button key={id} type="button" data-specimen-chat={id} aria-pressed={chat===`gallery-${id}`} className={button(chat===`gallery-${id}`)} onClick={()=>onChat(`gallery-${id}`)}>Chat {id.toUpperCase()}</button>)}
  {Object.keys(SPECIMEN_BUILDS).map(id=><button key={id} type="button" data-specimen-build={id} aria-pressed={build===id} className={button(build===id)} onClick={()=>onBuild(id)}>{id}</button>)}
 </div>;
}
export function ComposerSpecimen(){
 const [conversationKey,setConversationKey]=useState('gallery-a'),[buildId,setBuildId]=useState('none');
 const build=SPECIMEN_BUILDS[buildId]??null;
 const [running,setRunning]=useState(false),[stops,setStops]=useState(0),[compacts,setCompacts]=useState(0);
 const [model,setModel]=useState(choices[0]!.key),[effort,setEffort]=useState<string|null>(null),[roles,setRoles]=useState<RoleRecord>({planner:'fixture-astra',builder:'fixture-opus',judge:'fixture-astra',engines:{builder:'claude-code'}}),[sent,setSent]=useState('');
 const orchestrator=choices.find(c=>c.key===model);
 const picked=withRoleEfforts(roles,choices,model.split('::')[0]!,null);
 const roleModel=(role:'builder'|'judge')=>choices.find(c=>c.key===`${picked.engines?.[role]??model.split('::')[0]}::${picked[role]??''}`);
 const efforts=effortScale(orchestrator,[roleModel('builder'),roleModel('judge')]);
 const appliedEffort=unifiedEffort(efforts,effort,orchestrator);
 const appliedRoles=withRoleEfforts(roles,choices,model.split('::')[0]!,appliedEffort);
 return <section data-composer-specimen className="space-y-3"><h2 className="text-name">Prompt composer</h2>
  <SpecimenSwitches chat={conversationKey} onChat={setConversationKey} build={buildId} onBuild={setBuildId} />
  <div className="w-full max-w-[388px]"><PromptBar placeholder="Create a game" conversationKey={conversationKey} build={build} coordinating={build?.state===RunState.Running} model={{choices,selected:model,onPick:setModel,effort:appliedEffort,efforts,onEffort:setEffort,roles:appliedRoles,onRoles:setRoles}} stoppable={running} onStop={()=>{setRunning(false);setStops(n=>n+1);}} onCompact={()=>setCompacts(n=>n+1)} onSend={(text,extras)=>{setSent(JSON.stringify({text,extras,roles:appliedRoles,effort:appliedEffort}));setRunning(true);}} /></div>
  <output id="composer-settings" data-running={running} data-stops={stops} data-compacts={compacts} data-effort={appliedEffort} data-roles={JSON.stringify(appliedRoles)} className="text-xs text-ink-3">{sent}</output>
 </section>;
}
/** The composer before any AI model is connected: Enter and Send point at Connect AI model, which opens Model Providers. */
export function NoModelComposerSpecimen(){
 const [sent,setSent]=useState(0),[opened,setOpened]=useState('');
 useEffect(()=>{
  const onOpen=(event:Event)=>setOpened((event as CustomEvent<SettingsRequest>).detail?.section??'');
  window.addEventListener(OPEN_SETTINGS_EVENT,onOpen);
  return ()=>window.removeEventListener(OPEN_SETTINGS_EVENT,onOpen);
 },[]);
 return <section data-composer-specimen-nomodel className="space-y-3"><h2 className="text-name">Prompt composer without a model</h2>
  <div className="w-full max-w-[560px]"><PromptBar placeholder="What do you want to make?" conversationKey="gallery-nomodel" model={{choices:[],selected:null,onPick:()=>{}}} onSend={()=>setSent(n=>n+1)} /></div>
  <output id="nomodel-result" data-sent={sent} data-opened={opened} className="text-xs text-ink-3" />
 </section>;
}
