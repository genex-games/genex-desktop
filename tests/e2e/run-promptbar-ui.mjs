import { testEvidence } from "../../scripts/test-evidence.mjs";
/** Real pointer/keyboard interactions against the production composer and shared primitives. */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildDesignGallery } from "../../scripts/design-gallery.mjs";
import { resolveElectron, fixtureElectronArgs, fixtureElectronEnv } from "../../scripts/electron-runtime.mjs";
const out = await buildDesignGallery(),
  profile = await mkdtemp(path.join(os.tmpdir(), "studio-composer-ui-"));
const evidence = testEvidence("composer", process.env.COMPOSER_EVIDENCE);
const fs = await import("node:fs/promises");
await fs.mkdir(evidence, { recursive: true });
const boot = path.join(out, "composer-check.cjs");
await writeFile(
  boot,
  String.raw`
const {app,BrowserWindow}=require('electron'),fs=require('node:fs');
app.setPath('userData',${JSON.stringify(profile)});
const checks=[],errors=[],captures=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function check(name,ok,detail){checks.push({name,status:ok?'pass':'fail',detail});console.log(ok?'PASS':'FAIL',name,detail??'');}
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1080,height:900,show:false,focusable:false,skipTaskbar:true,x:-4000,y:0,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}}),wc=win.webContents;
 wc.on('console-message',(event,...args)=>{if(event.level==='error'||event.level===3||args[0]===3)errors.push(event.message??args[1]);});
 win.showInactive();wc.debugger.attach('1.3');
 const cdp=(method,params)=>wc.debugger.sendCommand(method,params);
 const js=code=>wc.executeJavaScript(code,true);
 const mouse=e=>cdp('Input.dispatchMouseEvent',{type:({mouseMove:'mouseMoved',mouseDown:'mousePressed',mouseUp:'mouseReleased'})[e.type],x:e.x,y:e.y,button:e.button??'none',buttons:e.type==='mouseDown'?1:0,clickCount:e.clickCount??0});
 const insertText=text=>cdp('Input.insertText',{text});
 const element=(s,expr)=>js('(()=>{const e=document.querySelector('+JSON.stringify(s)+');return e?('+expr+'):null})()');
 const key=async(keyCode,modifiers=[])=>{const k=({Down:'ArrowDown',Up:'ArrowUp',Left:'ArrowLeft',Right:'ArrowRight',Space:' '})[keyCode]??keyCode,p={key:k,code:keyCode==='Space'?'Space':k,windowsVirtualKeyCode:({Enter:13,Escape:27,Tab:9,Backspace:8,ArrowDown:40,ArrowUp:38,ArrowLeft:37,ArrowRight:39,Home:36,End:35,' ':32})[k]??0,modifiers:modifiers.reduce((n,k)=>n|({meta:4,shift:8,control:2,alt:1})[k],0)};await cdp('Input.dispatchKeyEvent',{type:'keyDown',...p,...(k==='Enter'?{text:'\r'}:k===' '?{text:' '}:{} )});await cdp('Input.dispatchKeyEvent',{type:'keyUp',...p});await wait(280);};
 const click=async(s)=>{const p=await element(s,'(e.scrollIntoView({block:"nearest"}),{x:e.getBoundingClientRect().x+e.getBoundingClientRect().width/2,y:e.getBoundingClientRect().y+e.getBoundingClientRect().height/2})');if(!p)throw new Error('Missing '+s+': '+await js('JSON.stringify({viewport:{width:innerWidth,height:innerHeight,scale:visualViewport.scale},active:document.activeElement?.outerHTML,panels:[...document.querySelectorAll("[data-slot=popover-content]")].map(e=>({label:e.getAttribute("aria-label"),open:e.hasAttribute("data-open")})),model:document.querySelector("[aria-label=\\\"Model settings\\\"]")?.outerHTML})'));await mouse({type:'mouseMove',...p});await mouse({type:'mouseDown',button:'left',clickCount:1,...p});await mouse({type:'mouseUp',button:'left',clickCount:1,...p});await wait(300);};
 const close=async()=>{await mouse({type:'mouseMove',x:0,y:0});for(let i=0;i<6 && await js('Boolean(document.querySelector("[data-slot=popover-content][data-open]"))');i++)await key('Escape');if(await js('Boolean(document.querySelector("[data-slot=popover-content][data-open]"))'))throw new Error('Picker did not close: '+await js('JSON.stringify({active:document.activeElement?.outerHTML,panels:[...document.querySelectorAll("[data-slot=popover-content]")].map(e=>({label:e.getAttribute("aria-label"),open:e.hasAttribute("data-open")}))})'));await element('[data-promptbar]','e.scrollIntoView({block:"center"})');};
 const capture=async(name)=>{await wc.capturePage();await wait(250);const file=${JSON.stringify(evidence)}+'/'+name+'.png';fs.writeFileSync(file,(await wc.capturePage()).toPNG());captures.push(file);};
 try{
 await win.loadFile(${JSON.stringify(path.join(out, "index.html"))});await js('document.fonts.ready.then(()=>true)');await wait(400);await element('[data-promptbar]','e.scrollIntoView({block:"center"})');
 const settings=()=>js('JSON.parse(document.querySelector("#composer-settings").textContent||"{}")');
 const view=()=>js('document.querySelector("[data-model-view]")?.dataset.modelView??null');
 const open=label=>js('Boolean(document.querySelector("[data-slot=popover-content][aria-label=\\"'+label+'\\"][data-open]"))');
 const ownLoop=async(chat,on,hours)=>{const v=await js('JSON.parse(localStorage.getItem("studio.loop.gallery-'+chat+'")||"null")');return v?.on===on&&v?.hours===hours;};
 // What Mode says, with its ∞ when it shows one: "∞ Loop", "2h Loop" (a time limit) or "Auto".
 const MODE_WORDS='(e.querySelector("[data-icon=infinity]")?"∞ ":"")+e.textContent';
 const mode=()=>element('[aria-label="Mode"]','({text:'+MODE_WORDS+',disabled:e.disabled,opacity:getComputedStyle(e).opacity})');
 check('empty Send is disabled',await element('[data-promptbar] [aria-label="Send"]','e.disabled'));
 check('fresh composer defaults to Loop',await element('[data-promptbar] [aria-label="Mode"]',MODE_WORDS+'==="∞ Loop"'));
 check('all toolbar buttons and nested icons have pointer cursors',await js('[...document.querySelectorAll("[data-composer-toolbar] button:enabled, [data-composer-toolbar] button:enabled svg")].every(e=>getComputedStyle(e).cursor==="pointer")'));
 check('Add is a filled 30px circle the size of Send',await js('(()=>{const a=document.querySelector("[aria-label=\\"Add images and more\\"]"),s=document.querySelector("[data-promptbar] [aria-label=Send]"),r=a.getBoundingClientRect(),q=s.getBoundingClientRect();return r.width===30&&q.width===30&&r.height===q.height&&getComputedStyle(a).backgroundColor!=="rgba(0, 0, 0, 0)"})()'));
 check('composer keeps a 7px bottom inset and a 26px radius',await element('[data-promptbar] .composer-panel','getComputedStyle(e).paddingBottom==="7px"&&getComputedStyle(e).borderTopLeftRadius==="26px"'));
 await capture('default');
 const plus=await element('[aria-label="Add images and more"]','({x:e.getBoundingClientRect().x+15,y:e.getBoundingClientRect().y+15})');
 await mouse({type:'mouseMove',...plus});await wait(700);
 check('Add has a tooltip naming its @ shortcut',await js('[...document.querySelectorAll("[data-slot=tooltip-content]")].some(e=>e.textContent.includes("Add images and more")&&e.querySelector("kbd")?.textContent==="@")'));
 await capture('tooltip-add');await mouse({type:'mouseMove',x:0,y:0});await wait(300);

 // Intentionally flipped: Plan mode left Mode for Add, a row that turns it on and a bulb that shows it.
 const SPECIMEN='[data-composer-specimen]',BULB=SPECIMEN+' [data-plan-mode-off]',ADD_PLAN='[data-slot=popover-content][aria-label="Add"][data-open] [data-plan-mode-row]';
 check('Plan mode defaults off: no bulb',!(await element(BULB,'true')));
 await click(SPECIMEN+' [aria-label="Add images and more"]');
 check('Add offers Plan mode after Images as a row that turns it on',await element(ADD_PLAN,'e.tagName==="BUTTON"&&e.previousElementSibling?.textContent.includes("Images")&&e.textContent.includes("Turn plan mode on")&&Boolean(e.querySelector("[data-icon=bulb]"))'),await element(ADD_PLAN,'e.textContent'));
 await click(ADD_PLAN);
 check('the row closes Add and shows the bulb behind a hairline, and the box asks what to plan',!(await open('Add'))&&Boolean(await element(BULB,'e.querySelector("[data-icon=bulb]")'))&&Boolean(await element(SPECIMEN+' .composer-divider','true'))&&await element(SPECIMEN+' textarea','e.placeholder==="Describe what to plan…"'),await element(SPECIMEN+' textarea','e.placeholder'));
 await capture('plan-mode-on');
 await click(BULB);
 check('the bulb turns Plan mode off',!(await element(BULB,'true'))&&await element(SPECIMEN+' textarea','e.placeholder!=="Describe what to plan…"'));
 await click(SPECIMEN+' [aria-label="Add images and more"]');
 check('while off, the row says it turns Plan mode on',await element(ADD_PLAN,'e.textContent.includes("Turn plan mode on")'));
 await close();
 await click('[aria-label="Mode"]');check('Mode holds only the Loop: Plan mode is in Add',!(await element('[aria-label="Mode options"] [aria-label="Plan mode"]','true')));
 check('one Loop control offers Off, until satisfied, presets and Custom',await js('[...document.querySelectorAll("[aria-label=\\"Loop time limit\\"] [role=radio]")].map(e=>e.textContent).join("|")==="Off|∞|30 m|1 h|2 h|Custom"')&&await element('[aria-label="Loop time limit"] [aria-checked="true"]','e.dataset.value==="inf"'));
 check('Loop time options fit without clipping',await js('[...document.querySelectorAll("[aria-label=\\"Loop time limit\\"] [role=radio]")].every(e=>e.scrollWidth<=e.clientWidth)'));
 await click('[aria-label="Loop time limit"] [data-value="0.5"]');
 check('a preset saves its time and names it on the trigger',await js('localStorage.getItem("studio.autopilotHours")==="0.5"')&&await ownLoop('a',true,0.5)&&await element('[aria-label="Mode"]',MODE_WORDS+'==="30m Loop"'));
 await click('[aria-label="Loop time limit"] [data-value="custom"]');
 check('Custom starts from the current time',await element('[aria-label="Custom time limit"]','e.value==="30 m"'));
 await click('[aria-label="15 minutes more"]');check('the stepper adds 15 minutes',await js('localStorage.getItem("studio.autopilotHours")==="0.75"')&&await ownLoop('a',true,0.75));
 await element('[aria-label="Custom time limit"]','(e.focus(),e.select(),true)');await insertText('1h 15m');await key('Enter');
 check('a typed duration is parsed and saved',await js('localStorage.getItem("studio.autopilotHours")==="1.25"')&&await ownLoop('a',true,1.25)&&await element('[aria-label="Custom time limit"]','e.value==="1 h 15 m"')&&await open('Mode options'));
 await capture('mode-custom');
 await element('[aria-label="Loop time limit"] [aria-checked="true"]','e.focus()');await key('Left');
 check('arrow keys move the Loop choice',await js('localStorage.getItem("studio.autopilotHours")==="2"')&&await ownLoop('a',true,2)&&await element('[aria-label="Mode"]',MODE_WORDS+'==="2h Loop"'));
 await key('Home');
 check('Off turns Loop off and keeps the saved time',await js('localStorage.getItem("studio.composer.loop")==="0" && localStorage.getItem("studio.autopilotHours")==="2"')&&await ownLoop('a',false,2)&&await element('[aria-label="Mode"]',MODE_WORDS+'==="Auto"'));
 await capture('mode-off');await close();

 check('the toolbar reads ring, model, effort, then Send',await js('(()=>{const t=document.querySelector("[data-composer-toolbar]");const at=s=>[...t.querySelectorAll("button")].indexOf(t.querySelector(s));return at("[aria-label=\\"Context and usage\\"]")<at("[aria-label=\\"Model settings\\"]")&&at("[aria-label=\\"Model settings\\"]")<at("[aria-label^=\\"Effort:\\"]")&&at("[aria-label^=\\"Effort:\\"]")<at("[aria-label=Send]")})()'));
 check('the model button names only the orchestrator; effort is its own filled pill',await element('[aria-label="Model settings"]','e.textContent==="Astra fixture"')&&await element('[aria-label^="Effort:"]','e.textContent==="High" && getComputedStyle(e).backgroundColor!=="rgba(0, 0, 0, 0)"'));
 check('Fast mode is not offered anywhere in the composer',await js('!document.querySelector("[data-promptbar]").textContent.includes("Fast")'));
 await click('[aria-label="Model settings"]');
 check('the model panel lists the three jobs with their models and no effort controls',await js('(()=>{const rows=[...document.querySelectorAll("[data-model-view=roles] [data-role-row]")];return rows.map(r=>r.querySelector(".picker-role-name").textContent).join("|")==="Main agent|Workers|Reviewers"&&rows.map(r=>r.querySelector(".picker-role-model").textContent).join("|")==="Astra fixture|Opus fixture|Astra fixture"&&!document.querySelector("[aria-label=\\"Model options\\"] [role=radiogroup], [aria-label=\\"Model options\\"] .picker-pill")})()'));
 check('Workers and Reviewers carry an info icon; the main agent does not',await js('["planner","builder","judge"].map(r=>Boolean(document.querySelector("[data-role="+r+"] .picker-role-info"))).join()==="false,true,true"'));
 check('workers and reviewers stay choosable and quieter than the main agent, with no Loop note',await js('(()=>{const v=document.querySelector("[data-model-view=roles]");return v.querySelector("[data-role=builder]").hasAttribute("data-quiet")&&v.querySelector("[data-role=judge]").hasAttribute("data-quiet")&&!v.querySelector("[data-role=planner]").hasAttribute("data-quiet")&&!v.querySelector(".picker-action")})()'));
 check('opening the panel focuses the orchestrator row',await js('document.activeElement?.dataset.role==="planner"'));
 await capture('model-roles');
 await close();await click('[aria-label="Mode"]');await click('[aria-label="Loop time limit"] [data-value="2"]');await close();await click('[aria-label="Model settings"]');
 check('with Loop back on, the jobs read the same',await element('[aria-label="Mode"]',MODE_WORDS+'==="2h Loop"')&&await open('Model options')&&await js('document.querySelectorAll("[data-model-view=roles] [data-quiet]").length===2'));
 const infoAt=await element('[data-role="builder"] .picker-role-info','({x:e.getBoundingClientRect().x+7,y:e.getBoundingClientRect().y+7})');
 await mouse({type:'mouseMove',...infoAt});await wait(700);
 check('the Workers info icon explains the job',await js('[...document.querySelectorAll("[data-slot=tooltip-content]")].some(e=>e.textContent.includes("Workers build the parts of the plan"))'));
 await capture('role-info');await mouse({type:'mouseMove',x:0,y:0});await wait(300);
 await click('[data-role="planner"]');
 check('a job opens its model list beside the panel and focuses the current model',await open('Main agent model')&&await open('Model options')&&await js('document.activeElement?.dataset.modelChoice==="codex::fixture-astra"'));
 check('the list groups models by maker and ends with Add more models',await js('(()=>{const l=document.querySelector("[data-slot=popover-content][aria-label=\\"Main agent model\\"]");return [...l.querySelectorAll(".picker-label")].map(e=>e.textContent).join("|")==="ChatGPT models|Claude models|Local models"&&[...l.querySelectorAll("button")].at(-1).textContent==="Add more models"&&!l.querySelector("[aria-label=\\"Search models\\"]")&&[...l.querySelectorAll("[data-model-choice]")].every(e=>!e.dataset.modelChoice.endsWith("::"))})()'));
 check('the model list opens to the right of the panel',await js('(()=>{const l=document.querySelector("[data-slot=popover-content][aria-label=\\"Main agent model\\"]").getBoundingClientRect(),p=document.querySelector("[data-slot=popover-content][aria-label=\\"Model options\\"]").getBoundingClientRect();return l.width>0&&l.left>=p.right})()'),await js('JSON.stringify({list:document.querySelector("[data-slot=popover-content][aria-label=\\"Main agent model\\"]").getBoundingClientRect(),panel:document.querySelector("[data-slot=popover-content][aria-label=\\"Model options\\"]").getBoundingClientRect()})'));
 check('the open job keeps its row filled',await element('[data-role="planner"]','e.getAttribute("aria-expanded")==="true"'));
 await capture('models');
 await key('Down');check('arrow keys move through the list',await js('document.activeElement?.dataset.modelChoice==="claude-code::fixture-opus"'));
 await key('Escape');check('Escape closes the list first and returns to the job',!(await open('Main agent model'))&&await open('Model options')&&await js('document.activeElement?.dataset.role==="planner"'));
 await key('Down');check('arrow keys move between jobs',await js('document.activeElement?.dataset.role==="builder"'));
 await key('Right');check('the right arrow opens the job\'s model list',await open('Workers model'));
 await click('[data-slot="popover-content"][aria-label="Workers model"] [data-model-choice="codex::fixture-astra"]');
 check('picking a worker model closes the list and keeps the panel',await element('#composer-settings','JSON.parse(e.dataset.roles).builder==="fixture-astra"')&&!(await open('Workers model'))&&await open('Model options')&&await js('document.activeElement?.dataset.role==="builder"')&&await element('[data-role="builder"] .picker-role-model','e.textContent==="Astra fixture"'));
 await click('[data-role="builder"]');await click('[data-slot="popover-content"][aria-label="Workers model"] [data-model-choice="claude-code::fixture-opus"]');
 await key('Escape');check('Escape at the panel closes the menu',!(await open('Model options')));
 await close();

 await click('[aria-label^="Effort:"]');
 check('effort opens one Faster–Smarter slider over the orchestrator\'s six levels',await open('Effort')&&await element('[data-effort-slider]','e.getAttribute("aria-valuetext")==="High" && e.querySelectorAll(".effort-stop").length===6 && document.activeElement===e')&&await js('document.querySelector("[aria-label=Effort][data-slot=popover-content]").textContent.includes("Faster")'));
 await key('Right');
 check('arrow keys choose the next level for every role',await element('#composer-settings','e.dataset.effort==="xhigh" && JSON.parse(e.dataset.roles).efforts.builder==="high" && JSON.parse(e.dataset.roles).efforts.judge==="xhigh"')&&await element('[aria-label^="Effort:"]','e.textContent==="xHigh"'));
 const endStop=await element('[data-effort-slider]','({x:e.getBoundingClientRect().right-6,y:e.getBoundingClientRect().y+e.getBoundingClientRect().height/2})');
 await mouse({type:'mouseMove',...endStop});await mouse({type:'mouseDown',button:'left',clickCount:1,...endStop});await mouse({type:'mouseUp',button:'left',clickCount:1,...endStop});await wait(300);
 check('clicking the track snaps to the nearest level; a model without it uses its closest',await element('#composer-settings','e.dataset.effort==="ultra" && JSON.parse(e.dataset.roles).efforts.builder==="max"'));
 await capture('effort');
 await key('Left');await key('Left');
 check('the slider reports its level to assistive technology',await element('[data-effort-slider]','e.getAttribute("aria-valuetext")==="xHigh" && e.getAttribute("role")==="slider"'));
 await close();
 await click('[aria-label="Add images and more"]');
 check('Add offers images and the built-in Blender plugin',await js('document.querySelector("[aria-label=Add][data-slot=popover-content]").textContent.includes("Reference or mood board")')&&await element('[aria-label="Use Local Blender"]','e.getAttribute("aria-checked")==="false"'));
 check('a locked account offers one Connect button, with no "Account locked" words',await element('[aria-label="Connect Genex fixture"]','e.textContent==="Connect"')&&!(await js('document.querySelector("[aria-label=Add][data-slot=popover-content]").textContent.includes("Account locked")')));
 await capture('add-account-locked');await click('[aria-label="Connect Genex fixture"]');
 check('connecting updates the open menu without another chat',await js('!document.querySelector("[aria-label=\\\"Connect Genex fixture\\\"]")'));
 check('an enabled plugin shows its disconnected server with a filled action',await js('(()=>{const row=document.querySelector("[data-plugin-row=\\"plugin:fixture\\"]");const b=row?.querySelector(".picker-action");return row.textContent.includes("Assets needs setup")&&b?.textContent==="Set up"&&getComputedStyle(b).backgroundColor!=="rgba(0, 0, 0, 0)"})()'));
 // A row without a status says where its switch applies instead; the status is the other .picker-desc.
 const pluginRow=id=>'document.querySelector("[data-plugin-row=\\"'+id+'\\"]")';
 const statusFree=id=>js('(()=>{const row='+pluginRow(id)+';const scope=row.querySelector("[data-plugin-scope]");return !row.querySelector(".picker-desc:not([data-plugin-scope])")&&scope?.textContent==="All games"&&row.querySelector("[role=switch]").getAttribute("aria-describedby")===scope.id})()');
 check('a disabled plugin shows no status, only that its switch covers all games',await statusFree('plugin:blender'));
 check('Add spans the entire composer above its writing surface',await js('(()=>{const c=document.querySelector("[data-promptbar] .composer-panel").getBoundingClientRect(),p=document.querySelector("[aria-label=Add][data-slot=popover-content]").getBoundingClientRect();return Math.abs(c.width-p.width)<2 && Math.abs(c.left-p.left)<2 && c.top-p.bottom>=7 && c.top-p.bottom<=10})()'));
 check('menu density: 6px inset, 32px rows, 12px medium labels',await js('(()=>{const p=document.querySelector("[aria-label=Add][data-slot=popover-content]");return getComputedStyle(p).paddingTop==="6px"&&[...p.querySelectorAll(".picker-row")].every(r=>r.getBoundingClientRect().height===32)&&[...p.querySelectorAll(".picker-label")].every(e=>getComputedStyle(e).fontSize==="12px"&&getComputedStyle(e).fontWeight==="500")})()'));
 check('Images and plugin names share one text size',await js('(()=>{const p=document.querySelector("[aria-label=Add][data-slot=popover-content]");const img=[...p.querySelectorAll("span")].find(e=>e.textContent==="Images"),plug=[...p.querySelectorAll("span")].find(e=>e.textContent==="Genex fixture");return getComputedStyle(img).fontSize===getComputedStyle(plug).fontSize})()'));
 await capture('add');await click('[aria-label="Use Genex fixture"]');
 check('turning a plugin off clears its status',await statusFree('plugin:fixture'));
 await click('[aria-label="Use Genex fixture"]');await js('window.addEventListener("studio:open-plugins",()=>document.body.dataset.managed="true",{once:true})');await click('[aria-label="Set up Genex fixture"]');
 check('plugin setup routes to plugin management',await js('document.body.dataset.managed==="true"'));await close();

 await click('[data-promptbar] [aria-label="Context and usage"]');
 const usagePanel='[data-slot="popover-content"][aria-label="Context and usage"]';
 check('context comes first with its window and automatic compaction',await element(usagePanel,'e.textContent.startsWith("Context window") && e.textContent.includes("Not measured yet") && e.textContent.includes("Compacts automatically")'));
 await wait(300);
 check('each signed-in subscription shows its plan limits',await element(usagePanel,'e.querySelectorAll("[role=progressbar]").length===5 && e.textContent.includes("Claude Max plan") && e.textContent.includes("ChatGPT Pro plan") && e.textContent.includes("Weekly · Fable") && e.textContent.includes("Resets in 3 h 54 m")'));
 check('split roles name who draws on each plan, orchestrator\'s plan first',await js('[...document.querySelectorAll("[data-usage-engine]")].map(e=>e.dataset.usageEngine+":"+e.querySelector(".usage-plan-roles").textContent).join("|")==="codex:Main agent · Reviewers|claude-code:Workers"'));
 check('an exhausted limit is red and a high one amber',await element('[data-usage-engine="claude-code"] [aria-label="Weekly · Fable"] i','e.dataset.level==="full"')&&await element('[data-usage-engine="codex"] [aria-label="Weekly limit"] i','e.dataset.level==="high"'));
 check('the context ring is 16px with a 2px stroke',await js('(()=>{const s=document.querySelector("[data-promptbar] [aria-label=\\"Context and usage\\"] svg");return s.getBoundingClientRect().width===16&&getComputedStyle(s.querySelector("circle")).strokeWidth==="2px"})()'));
 check('Codex compacts on its own, so its panel offers no compaction point',!(await js('Boolean(document.querySelector("[aria-label=\\"Auto-compact\\"]"))')));
 await capture('limits');
 await click('[data-usage-engine="claude-code"] .usage-plan-link');
 check('a plan title opens that provider\'s usage page',await js('document.body.dataset.openedUrl==="https://claude.ai/settings/usage"'));
 await close();

 await click('[data-promptbar] textarea');await insertText('Light the tower with @');await wait(400);
 check('typing @ opens Add as a mention list and keeps focus in the text',await js('Boolean(document.querySelector("[data-mention-list]"))&&document.activeElement?.getAttribute("aria-label")==="Prompt"&&Boolean(document.activeElement.getAttribute("aria-activedescendant"))'));
 await capture('mention');
 await insertText('gen');await wait(250);
 check('the mention list filters as you type',await js('[...document.querySelectorAll("[data-mention-list] [role=option]")].map(e=>e.textContent).join("|")==="Genex fixture"'));
 await key('Enter');
 check('Enter inserts the mention instead of sending',await element('[data-promptbar] textarea','e.value==="Light the tower with @Genex fixture "')&&await element('#composer-settings','e.dataset.running==="false"')&&!(await js('Boolean(document.querySelector("[data-mention-list]"))')));
 await insertText('@');await wait(300);await key('Escape');
 check('Escape closes the mention list and keeps the text and focus',await element('[data-promptbar] textarea','e.value.endsWith("@")&&document.activeElement===e')&&!(await js('Boolean(document.querySelector("[data-slot=popover-content][aria-label=Add][data-open]"))')));
 await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:4,commands:['selectAll']});await key('Backspace');
 // Plan mode on for the next message only: the bulb takes room the narrow specimen's ring needs above.
 await click(SPECIMEN+' [aria-label="Add images and more"]');await click(ADD_PLAN);await click('[data-promptbar] textarea');

 await insertText('A quiet garden');await wait(400);check('text enables Send',await element('[data-promptbar] [aria-label="Send"]','!e.disabled && e.dataset.state==="ready"'));
 check('ready Send is filled with the ink color',await element('[data-promptbar] [aria-label="Send"]','getComputedStyle(e).backgroundColor===getComputedStyle(document.querySelector("[data-promptbar] textarea")).color'));
 await click('[data-promptbar] [aria-label="Send"]');
 check('send includes approval and the selected Loop time',await element('#composer-settings','(()=>{const v=JSON.parse(e.textContent);return v.extras.reviewPlan===true && v.extras.autopilot.hours===2})()'));
 check('one effort is sent to every role at the closest level each model accepts',await element('#composer-settings','(()=>{const v=JSON.parse(e.textContent);return v.effort==="xhigh" && v.roles.efforts.planner==="xhigh" && v.roles.efforts.builder==="high" && v.roles.efforts.judge==="xhigh"})()'));
 const actionState=()=>js('[...document.querySelectorAll("[data-composer-specimen] [data-promptbar] button[aria-label=Send], [data-composer-specimen] [data-promptbar] button[aria-label=Stop]")].map(e=>e.getAttribute("aria-label")).join(",")');
 check('active work turns the same control into Stop',await actionState()==='Stop');
 await click('[data-promptbar] [aria-label="Stop"]');
 check('post-send pointer guard prevents accidental cancellation',await element('#composer-settings','e.dataset.running==="true" && e.dataset.stops==="0"'));
 await mouse({type:'mouseMove',x:0,y:0});await wait(400);
 check('Stop cross-fades to a filled square on the same white fill',await js('(()=>{const b=document.querySelector("[data-promptbar] [aria-label=Stop]");return getComputedStyle(b.querySelector("[data-glyph=stop]")).opacity==="1"&&getComputedStyle(b.querySelector("[data-glyph=send]")).opacity==="0"&&getComputedStyle(b).backgroundColor===getComputedStyle(document.querySelector("[data-promptbar] textarea")).color})()'));
 const stopRect=await element('[data-promptbar] [aria-label="Stop"]','e.getBoundingClientRect().toJSON()');
 check('Stop and its icon use pointer cursors',await element('[data-promptbar] [aria-label="Stop"]','getComputedStyle(e).cursor==="pointer" && getComputedStyle(e.querySelector("svg")).cursor==="pointer"'));
 await capture('running-stop');
 await click('[data-promptbar] textarea');await insertText('   ');await wait(100);
 check('whitespace keeps Stop available during work',await actionState()==='Stop');
 await insertText('Add fireflies');await wait(100);
 check('follow-up draft replaces Stop with one enabled Send',await actionState()==='Send'&&await element('[data-promptbar] [aria-label="Send"]','!e.disabled')&&await element('#composer-settings','e.dataset.running==="true"'));
 check('action occupies the same slot in both states',await element('[data-promptbar] [aria-label="Send"]','Math.abs(e.getBoundingClientRect().x-'+stopRect.x+')<1 && Math.abs(e.getBoundingClientRect().width-'+stopRect.width+')<1'));
 await capture('running-draft');
 await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:4,commands:['selectAll']});await key('Backspace');check('clearing the draft restores Stop',await actionState()==='Stop');
 await insertText('Add fireflies');await wait(100);await key('Enter');
 check('Enter submits a follow-up and restores Stop',await actionState()==='Stop'&&await element('#composer-settings','JSON.parse(e.textContent).text==="Add fireflies" && e.dataset.stops==="0"'));
 function installStopObserver() {
  window.stopGlyphFrame = new Promise(resolve => {
   const button = document.querySelector('[data-promptbar] [aria-label="Stop"]');
   const observer = new MutationObserver(() => {
    if (button.dataset.state !== 'idle') return;
    observer.disconnect();
    requestAnimationFrame(() => {
     const stop = button.querySelector('[data-glyph="stop"]');
     const send = button.querySelector('[data-glyph="send"]');
     resolve(button.getAttribute('aria-label') === 'Send' && getComputedStyle(stop).opacity === '0' &&
      getComputedStyle(send).opacity === '1' && getComputedStyle(send).transform === 'none' &&
      stop.getAnimations().length === 0 && send.getAnimations().length === 0);
    });
   });
   observer.observe(button, {attributes:true, attributeFilter:['data-state']});
  });
 }
 const observeStopGlyph = () => js('(' + installStopObserver.toString() + ')()');
 await wait(650);await observeStopGlyph();await click('[data-promptbar] [aria-label="Stop"]');
 check('normal motion replaces Stop on the first idle frame',await js('window.stopGlyphFrame'));

 check('pointer Stop still cancels work after the guard',await actionState()==='Send'&&await element('#composer-settings','e.dataset.running==="false" && e.dataset.stops==="1"'));
 check('idle empty Send has a disabled cursor including its icon',await element('[data-promptbar] [aria-label="Send"]','e.disabled && getComputedStyle(e).cursor!=="pointer" && getComputedStyle(e.querySelector("svg")).cursor!=="pointer"'));
 await click('[data-promptbar] textarea');await insertText('A second turn');await wait(100);await key('Enter');
 await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 await observeStopGlyph();
 await element('[data-promptbar] [aria-label="Stop"]','e.focus()');await key('Space');
 check('reduced motion replaces Stop on the first idle frame',await js('window.stopGlyphFrame'));
 await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
 check('keyboard Stop remains available',await actionState()==='Send'&&await element('#composer-settings','e.dataset.stops==="2"'));
 check('plan review resets after sending',!(await element(BULB,'true')));
 // gallery-a keeps its own Loop now, so the saved custom time is its own; the last pick (1 h 15 m) seeds gallery-b.
 await js('localStorage.setItem("studio.loop.gallery-a",JSON.stringify({on:true,hours:1.25}));localStorage.setItem("studio.autopilotHours","1.25")');await wc.reload();await wait(500);await element('[data-promptbar]','e.scrollIntoView({block:"center"})');
 await click('[aria-label="Mode"]');
 check('reopening preserves a saved time outside the presets',await element('[aria-label="Mode"]',MODE_WORDS+'==="1h15 Loop"')&&await element('[aria-label="Loop time limit"] [aria-checked="true"]','e.dataset.value==="custom"')&&await element('[aria-label="Custom time limit"]','e.value==="1 h 15 m"'));await close();
 await click('[data-specimen-chat="b"]');
 check('a fresh chat starts from the last pick',(await mode()).text==="1h15 Loop"&&await ownLoop('b',true,1.25),await mode());
 await click('[data-specimen-chat="a"]');
 await click('[data-promptbar] textarea');await insertText('A draft that stays');await wait(100);
 await click('[aria-label="Mode"]');await click('[aria-label="Loop time limit"] [data-value="0.5"]');await close();
 await click('[data-specimen-chat="b"]');const bKept=(await mode()).text;
 await click('[aria-label="Mode"]');await click('[aria-label="Loop time limit"] [data-value="inf"]');await close();const bPicked=(await mode()).text;
 await click('[data-specimen-chat="a"]');
 check('each chat keeps its own Loop',bKept==="1h15 Loop"&&bPicked==="∞ Loop"&&(await mode()).text==="30m Loop"&&await ownLoop('a',true,0.5)&&await ownLoop('b',true,null)&&await element('[data-promptbar] textarea','e.value==="A draft that stays"'),{bKept,bPicked,a:await mode()});
 await element('[data-promptbar] textarea','(e.focus(),true)');await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:4,commands:['selectAll']});await key('Backspace');
 await click('[data-specimen-build="running-inf"]');const runningInf=await mode();
 await click('[data-specimen-chat="b"]');await click('[data-specimen-build="running-30"]');const running30=await mode();
 check('a running build names its own limit',runningInf.text==="∞ Loop"&&runningInf.disabled&&running30.text==="30m Loop"&&running30.disabled&&await ownLoop('a',true,0.5)&&await ownLoop('b',true,null),{runningInf,running30});
 check('a running build\'s Mode is dimmed like the composer\'s disabled icons',runningInf.opacity==="0.45"&&running30.opacity==="0.45",{runningInf,running30});
 await capture('mode-running-build');
 await click('[data-specimen-build="paused-30"]');const paused=await mode();
 check('a paused build\'s Mode is read-only with its limit',paused.text==="30m Loop"&&paused.disabled,paused);
 check('a paused build\'s Mode is dimmed too',paused.opacity==="0.45",paused);
 await capture('mode-paused-build');
 await click('[data-specimen-build="finished"]');const finished=await mode();await click('[aria-label="Mode"]');
 check('a finished build\'s Mode is the chat\'s own Loop again, with no new-build choice',finished.text==="∞ Loop"&&!finished.disabled&&finished.opacity==="1"&&await element('[aria-label="Loop time limit"] [aria-checked="true"]','e.dataset.value==="inf"')&&await element('[aria-label="Mode options"]','!/new build/i.test(e.textContent)'),{finished,options:await element('[aria-label="Mode options"]','e.textContent')});
 await capture('mode-finished-build');
 await click('[aria-label="Loop time limit"] [data-value="0.5"]');
 check('a finished chat\'s Loop is its own to change',(await mode()).text==="30m Loop"&&await ownLoop('b',true,0.5),await mode());
 await close();await click('[data-specimen-build="none"]');await click('[data-specimen-chat="a"]');

 win.setSize(1080,680);wc.setZoomFactor(2);await wait(350);await js('Object.assign(document.querySelector("[data-composer-specimen]").style,{position:"fixed",bottom:"16px",left:"16px",width:"calc(100% - 32px)"});document.querySelector("#composer-settings").style.display="none"');await element('[data-promptbar]','e.scrollIntoView({block:"center"})');
 const inside='[...document.querySelectorAll("[data-slot=popover-content]")].every(e=>{const r=e.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1})';
 await click('[aria-label="Model settings"]');await click('[data-role="builder"]');await capture('zoom-200');
 check('200% zoom keeps the model panel and its list within the viewport',await js(inside),await js('[...document.querySelectorAll("[data-slot=popover-content]")].map(e=>({label:e.getAttribute("aria-label"),rect:e.getBoundingClientRect().toJSON(),w:innerWidth,h:innerHeight}))'));
 await close();await click('[aria-label="Mode"]');await capture('mode-zoom-200');
 check('200% zoom keeps the Mode panel within the viewport',await js(inside));
 await close();await click('[aria-label="Add images and more"]');await capture('add-zoom-200');
 check('Add remains aligned and fully above composer at 200% zoom',await js('(()=>{const c=document.querySelector("[data-promptbar] .composer-panel").getBoundingClientRect(),p=document.querySelector("[aria-label=Add][data-slot=popover-content]").getBoundingClientRect();return Math.abs(c.width-p.width)<2 && Math.abs(c.left-p.left)<2 && p.bottom<=c.top-7 && p.top>=0})()'));
 await close();wc.setZoomFactor(1);win.setSize(1080,900);await wait(200);
 await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await click('[aria-label="Mode"]');
 check('reduced motion removes panel animation',await element('[aria-label="Mode options"]','parseFloat(getComputedStyle(e).animationDuration)<0.001'));
 await close();await click('[aria-label^="Effort:"]');
 check('reduced motion keeps the effort thumb still',await element('.effort-thumb','parseFloat(getComputedStyle(e).transitionDuration)<0.001'));await close();
 await click('[aria-label="Model settings"]');await click('[data-role="planner"]');await click('[data-slot="popover-content"][aria-label="Main agent model"] [data-model-choice="claude-code::fixture-opus"]');await close();
 await click('[data-promptbar] [aria-label="Context and usage"]');
 check('Claude Code compacts on its own too, so its panel offers no compaction point',!(await js('Boolean(document.querySelector("[aria-label=\\"Auto-compact\\"]"))')));
 await capture('context-claude');
 await close();
 // The / list: Claude Code keeps a session, so /compact is offered. A caret moved off the command closes it; Enter runs it.
 const PROMPT=SPECIMEN+' textarea[aria-label="Prompt"]',compacts=()=>element('#composer-settings','Number(e.dataset.compacts)');
 await element(PROMPT,'(e.focus(),true)');await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:4,commands:['selectAll']});await key('Backspace');
 await insertText('/com');await wait(200);
 check('typing / offers /compact',await open('Commands')&&await js('Boolean(document.querySelector("[data-command-list] [data-command=compact]"))'));
 await key('Left');await wait(200);
 check('a caret moved off the command closes its list',!(await open('Commands')));
 await key('Right');await insertText('p');await wait(200);
 check('typing the command again reopens it',await open('Commands'));
 await key('Enter');await wait(200);
 check('Enter runs /compact and clears the message',await compacts()===1&&await element(PROMPT,'e.value===""'),String(await compacts()));
 check('the cleared message leaves no / list open',!(await open('Commands')));
 // No AI model yet: the model's place holds Connect AI model; Enter and Send point at it instead of sending.
 await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
 const NO_MODEL='[data-composer-specimen-nomodel]';
 const noModel=()=>element('#nomodel-result','({sent:Number(e.dataset.sent),opened:e.dataset.opened})');
 const nudge=()=>element(NO_MODEL+' [data-connect-model]','e.dataset.nudge??null');
 const tip=()=>js('[...document.querySelectorAll("[data-slot=tooltip-content]")].some(e=>e.textContent.includes("Connect an AI model to send"))');
 await element(NO_MODEL+' [data-promptbar]','e.scrollIntoView({block:"center"})');
 check('without a model the model button is Connect AI model',await element(NO_MODEL+' [data-connect-model]','e.textContent==="Connect AI model"&&!e.disabled&&!e.dataset.nudge')&&!(await element(NO_MODEL+' [aria-label="Model settings"]','true')),await element(NO_MODEL+' [data-composer-toolbar]','e.textContent'));
 check('without a model the prompt still takes typing',await element(NO_MODEL+' textarea','!e.disabled'));
 await element(NO_MODEL+' textarea','(e.focus(),true)');await insertText('A fox runs a tea shop');await key('Enter');
 const afterEnter={result:await noModel(),nudge:await nudge(),tip:await tip(),draft:await element(NO_MODEL+' textarea','e.value'),focus:await js('document.activeElement?.tagName')};
 check('Enter without a model sends nothing, keeps the prompt and lights up Connect AI model with its tooltip',afterEnter.result.sent===0&&Boolean(afterEnter.nudge)&&afterEnter.tip&&afterEnter.draft==='A fox runs a tea shop'&&afterEnter.focus==='TEXTAREA',afterEnter);
 check('the lit button is the filled accent',await element(NO_MODEL+' [data-connect-model]','getComputedStyle(e).color==="rgb(255, 255, 255)"'));
 await capture('no-model-nudge');
 await click(NO_MODEL+' [aria-label="Send"]');
 check('Send without a model points at Connect AI model too',(await noModel()).sent===0&&Boolean(await nudge()),{result:await noModel(),nudge:await nudge()});
 await click(NO_MODEL+' [data-connect-model]');
 check('Connect AI model opens Model Providers',(await noModel()).opened==='providers',await noModel());
 check('no renderer errors',errors.length===0,errors);
 }catch(e){check('runner completes',false,{error:e.stack,rendererErrors:errors});await capture('failure').catch(error=>check('failure capture',false,error.message));}
 fs.writeFileSync(${JSON.stringify(path.join(evidence, "report.json"))},JSON.stringify({profile:${JSON.stringify(profile)},provider:'gallery fixtures',electron:process.versions.electron,checks,captures},null,2));
 app.exit(checks.some(c=>c.status==='fail')?1:0);
});
`,
);
const child = spawn(resolveElectron(), fixtureElectronArgs([boot]), {
  env: fixtureElectronEnv(),
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
const timer = setTimeout(() => child.kill("SIGKILL"), 90000);
try {
  const code = await new Promise((resolve, reject) => {
    child.on("exit", resolve);
    child.on("error", reject);
  });
  console.log(path.join(evidence, "report.json"));
  if (code !== 0) process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await rm(profile, { recursive: true, force: true });
}
