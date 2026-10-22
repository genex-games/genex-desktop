/** Real Chromium checks for shared renderer primitives; no providers or account state. */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildDesignGallery } from "../../scripts/design-gallery.mjs";
import { resolveElectron, fixtureElectronArgs, fixtureElectronEnv } from "../../scripts/electron-runtime.mjs";
const out = await buildDesignGallery();
const profile = await mkdtemp(path.join(os.tmpdir(), "studio-design-"));
const bootstrap = path.join(out, "check.cjs");
await writeFile(
  bootstrap,
  String.raw`
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
app.setPath('userData',${JSON.stringify(profile)});
const checks=[];
function check(name,ok,detail){checks.push({name,ok,detail});if(!ok)console.error(name,detail);}
app.whenReady().then(async()=>{
 console.log('Design fixture ready');
 const win=new BrowserWindow({width:1080,height:900,show:false,focusable:false,skipTaskbar:true,x:-4000,y:0,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const wc=win.webContents; win.showInactive();
 const errors=[];wc.on('console-message',(_e,...args)=>{if(args[0]===3)errors.push(args[1]);});
 const evalJS=code=>wc.executeJavaScript(code,true);
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const key=async(keyCode,modifiers=[])=>{const k=({Down:'ArrowDown',Up:'ArrowUp',Left:'ArrowLeft',Right:'ArrowRight',Space:' '})[keyCode]??keyCode,p={key:k,code:keyCode==='Space'?'Space':k,windowsVirtualKeyCode:({Enter:13,Escape:27,Tab:9,ArrowDown:40,ArrowUp:38,ArrowLeft:37,ArrowRight:39,Home:36,End:35,' ':32})[k]??0,modifiers:modifiers.reduce((n,k)=>n|({meta:4,shift:8,control:2,alt:1})[k],0)};await wc.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',...p,...(k==='Enter'?{text:'\r'}:k===' '?{text:' '}:{} )});await wc.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',...p});await wait(280);};
 const capture=async file=>{await wc.capturePage();await wait(250);fs.writeFileSync(file,(await wc.capturePage()).toPNG());};
 try{
 await win.loadFile(${JSON.stringify(path.join(out, "index.html"))});await evalJS('document.fonts.ready.then(()=>true)');await wait(400);
 await wait(100);
 check('gallery renders',await evalJS('!!document.querySelector("#primary")'));
 check('offline faces load',await evalJS('document.fonts.check(\'14px "Zalando Sans SemiExpanded"\') && document.fonts.check(\'14px "Geist Mono"\') && document.fonts.check(\'14px "TikTok Sans Genex"\',"Создать")'));
 wc.debugger.attach('1.3');await wc.debugger.sendCommand('DOM.enable');await wc.debugger.sendCommand('CSS.enable');
 const root=await wc.debugger.sendCommand('DOM.getDocument');const faces={};
 for(const selector of ['#latin','#cyrillic','#mono']){const {nodeId}=await wc.debugger.sendCommand('DOM.querySelector',{nodeId:root.root.nodeId,selector});faces[selector]=(await wc.debugger.sendCommand('CSS.getPlatformFontsForNode',{nodeId})).fonts;}
 check('Latin uses Zalando',faces['#latin'].some(f=>f.familyName.includes('Zalando')&&f.isCustomFont),faces);
 check('Cyrillic uses Geist fallback',faces['#cyrillic'].some(f=>f.familyName==='Geist'&&f.isCustomFont));
 check('Mono uses Geist Mono',faces['#mono'].some(f=>f.familyName==='Geist Mono'&&f.isCustomFont));
 check('button and nested icon use pointer',await evalJS('["#primary","#primary svg","#secondary","#switch"].every(s=>getComputedStyle(document.querySelector(s)).cursor==="pointer")'));
 check('disabled does not use pointer',await evalJS('getComputedStyle(document.querySelector("#disabled")).cursor!=="pointer"'));
 check('standard button is 32px',await evalJS('document.querySelector("#primary").getBoundingClientRect().height===32'));
 check('no horizontal overflow',await evalJS('document.documentElement.scrollWidth<=innerWidth'));
 await key('Tab');
 const focusStates=[];
 for(const selector of ['#primary','#secondary','#switch','[role=tablist] [role=tab]']){
   await evalJS('document.querySelector('+JSON.stringify(selector)+').focus()');
   focusStates.push(await evalJS('(()=>{const e=document.activeElement,s=getComputedStyle(e);return {id:e.id||e.getAttribute("role"),visible:e.matches(":focus-visible"),width:parseFloat(s.outlineWidth),style:s.outlineStyle,color:s.outlineColor,background:s.backgroundColor}})()'));
 }
 check('keyboard focus has a distinct inset indicator on primary, secondary, switch and tabs',focusStates.every(s=>s.visible&&s.width>=2&&s.style==='solid'),focusStates);
 const luminance=color=>{const c=color.match(/[\d.]+/g)?.slice(0,3).map(Number)??[];return c.reduce((sum,v,i)=>{const n=v/255;return sum+([0.2126,0.7152,0.0722][i]*(n<=0.04045?n/12.92:((n+0.055)/1.055)**2.4));},0);};
 const contrasts=focusStates.map(s=>{const a=luminance(s.color),b=luminance(s.background);return {id:s.id,ratio:(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)};});
 check('focused control indicators contrast at least 3:1 with their fill',contrasts.every(s=>s.ratio>=3),contrasts);
 const landingFocus='(()=>{const e=document.activeElement,s=getComputedStyle(e);return {tag:e.tagName,visible:e.matches(":focus-visible"),style:s.outlineStyle}})()';
 await evalJS('document.querySelector("#landing-heading").focus()');
 const heading=await evalJS(landingFocus);
 check('a heading script focuses after keyboard use takes no ring',heading.visible&&heading.style==='none',heading);
 const fieldEdge='(()=>{const e=document.activeElement,s=getComputedStyle(e);return {label:e.getAttribute("aria-label"),visible:e.matches(":focus-visible"),style:s.outlineStyle}})()';
 await evalJS('document.querySelector("[aria-label=Message]").focus()');
 const composerField=await evalJS(fieldEdge);
 check('a focused text field keeps its caret and draws no inset edge',composerField.visible&&composerField.style==='none',composerField);
 await capture(${JSON.stringify(path.join(out, "keyboard-focus.png"))});
 await capture(${JSON.stringify(path.join(out, "gallery.png"))});
 await evalJS('document.querySelector("#export-review-specimen").scrollIntoView()');
 check('upload review shows included and excluded file sets',await evalJS('(()=>{const review=document.querySelector("#export-review-specimen [data-export-review]");return review.textContent.includes("index.html") && review.textContent.includes(".env.local")})()'));
 await capture(${JSON.stringify(path.join(out, "export-review.png"))});
 await evalJS('window.scrollTo(0,0)');
 await evalJS('document.querySelector("#menu-trigger").focus()');await key('Down');await wait(300);
 check('menu opens with keyboard',await evalJS('!!document.querySelector("[role=menu]")'));
 await key('End');check('menu skips disabled row',await evalJS('document.activeElement.textContent==="Share"'));
 await key('Enter');check('menu activates chosen action',await evalJS('document.querySelector("#action").textContent==="Share"'));
 await wait(250);check('menu restores trigger focus',await evalJS('document.activeElement.id==="menu-trigger"'));
 await evalJS('document.querySelector("#dialog-trigger").focus();document.querySelector("#dialog-trigger").click()');await wait(350);
 check('dialog focuses field',await evalJS('document.activeElement.getAttribute("aria-label")==="Game name"'));
 const dialogField=await evalJS(fieldEdge);
 check('a focused dialog field draws no inset edge either',dialogField.visible&&dialogField.style==='none',dialogField);
 await capture(${JSON.stringify(path.join(out, "dialog.png"))});
 for(let i=0;i<8;i++)await key('Tab');
 check('dialog traps focus',await evalJS('!!document.activeElement.closest("[role=dialog]")'));
 await evalJS('document.querySelector("[role=dialog]").focus()');
 const layer=await evalJS(landingFocus);
 check('a dialog layer script focuses after keyboard use is not framed',layer.visible&&layer.style==='none',layer);
 await key('Escape');await wait(250);check('Escape dismisses dialog',await evalJS('!document.querySelector("[role=dialog]")'));
 check('dialog restores opener focus',await evalJS('document.activeElement.id==="dialog-trigger"'));
 await evalJS('document.querySelector("#picker-trigger").click()');await wait(300);
 check('popover focuses search',await evalJS('document.activeElement.getAttribute("aria-label")==="Find a folder"'));
 await key('Escape');await wait(250);check('popover closes',await evalJS('!document.querySelector("[data-slot=popover-content]")'));
 await evalJS('document.querySelector("[role=tablist] [role=tab]").focus()');await key('Right');
 check('switcher arrows select and focus',await evalJS('document.activeElement.textContent==="Review" && document.activeElement.getAttribute("aria-selected")==="true"'));
 await evalJS('document.querySelector("#switch").focus()');await key('Space');check('switch toggles by keyboard',await evalJS('document.querySelector("#switch").getAttribute("aria-checked")==="false"'));
 await evalJS('document.querySelector("#disclosure").click()');await wait(300);check('closed disclosure is inert and collapsed',await evalJS('document.querySelector(".disclosure-body").inert && document.querySelector(".disclosure-body").getBoundingClientRect().height===0'));
 await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 check('reduced motion stops the current chat work indicator',await evalJS('getComputedStyle(document.querySelector(".chat-status-shimmer")).animationName==="none"'));
 check('reduced motion stops shimmer',await evalJS('parseFloat(getComputedStyle(document.querySelector("[data-shimmer]")).animationDuration)<0.001'));
 wc.setZoomFactor(1.25);await wait(200);check('125% zoom has no horizontal overflow',await evalJS('document.documentElement.scrollWidth<=innerWidth'));
 await capture(${JSON.stringify(path.join(out, "gallery-125.png"))});
 check('no renderer errors before chat interactions',errors.length===0,[...errors]);
 const enter=async()=>{await wc.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});await wc.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await wait(100);};
 wc.setZoomFactor(1);await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
 await evalJS('document.querySelector("#chat-specimen").scrollIntoView()');await wait(200);
 check('question begins without implicit approval',await evalJS('document.querySelector("#question-specimen button[type=submit]").disabled && document.querySelector("#question-answer").textContent===""'));
 await evalJS('document.querySelector("#question-specimen input[value=approve]").focus()');await key('Space');await wait(400);
 check('choosing does not auto-send',await evalJS('document.querySelector("#question-specimen input[value=approve]").checked && document.querySelector("#question-answer").textContent===""'));
 await key('Down');
 check('arrow keys change the radio choice',await evalJS('document.querySelector("#question-specimen input[value=decline]").checked'));
 check('choice labels and marks use pointer',await evalJS('[...document.querySelectorAll("#question-specimen .chat-choice,#question-specimen input,#question-specimen .chat-choice span")].every(e=>getComputedStyle(e).cursor==="pointer")'));
 await evalJS('document.querySelector("#question-specimen button[type=submit]").focus()');await enter();await wait(150);
 check('confirmed answer sends selected choice',await evalJS('document.querySelector("#question-answer").textContent==="decline"'),await evalJS('JSON.stringify({answer:document.querySelector("#question-answer").textContent,active:document.activeElement.outerHTML,form:document.querySelector("#question-specimen").textContent})'));
 await evalJS('document.querySelector("#question-specimen [data-chat-question] button[type=button]").click()');await wait(50);
 check('collapse restores keyboard focus to reopener',await evalJS('document.activeElement.hasAttribute("data-question-reopen")'));
 await enter();check('reopening restores focus',await evalJS('document.activeElement.getAttribute("aria-label")==="Put question aside"'));
 check('plan starts expanded with exactly three actions',await evalJS('document.querySelector("#plan-specimen .prose").textContent.includes("Changes") && [...document.querySelectorAll("#plan-specimen button")].map(e=>e.textContent).join("|")==="Approve|Make changes|Cancel" && document.querySelector("#plan-answer").textContent===""'));
 check('plan code and list markers render correctly',await evalJS('document.querySelector("#plan-specimen code").textContent==="<canvas>" && getComputedStyle(document.querySelector("#plan-specimen ul")).listStyleType==="disc"'));
 await evalJS('document.querySelector("#plan-specimen").scrollIntoView()');await wait(100);
 check('plan footer stays fixed while content scrolls',await evalJS('(()=>{const b=document.querySelector("[data-plan-body]"),f=document.querySelector("[data-plan-actions]"),top=f.getBoundingClientRect().top;b.scrollTop=b.scrollHeight;return b.scrollTop>0 && f.getBoundingClientRect().top===top && f.getBoundingClientRect().bottom<=document.querySelector("[data-plan-review]").getBoundingClientRect().bottom})()'));
 await capture(${JSON.stringify(path.join(out, "plan-expanded.png"))});
 await evalJS('document.querySelector("#plan-specimen [data-plan-revise]").focus()');await enter();await wait(100);
 check('plan revision never approves the build',await evalJS('document.querySelector("#plan-answer").textContent==="revise"'));
 await evalJS('document.querySelector("#plan-specimen [data-plan-cancel]").focus()');await enter();await wait(100);
 check('plan cancels directly from its footer',await evalJS('document.querySelector("#plan-answer").textContent==="cancelled"'));
 await evalJS('document.querySelector("#plan-specimen [data-plan-approve]").focus()');await enter();await wait(100);
 check('plan approval is explicit',await evalJS('document.querySelector("#plan-answer").textContent==="approved"'));
 await evalJS('document.querySelector("#chat-specimen [data-work-log] > button").click()');
 await evalJS('[...document.querySelectorAll("#chat-specimen [data-tool-state] [data-tool-toggle]")].find(e=>e.textContent.includes("Rebuilt")).click()');
 check('tool summary truncates and recorded command expands as code',await evalJS('(()=>{const row=[...document.querySelectorAll("[data-tool-state]")].find(e=>e.textContent.includes("Rebuilt")),label=row.querySelector("[data-tool-label]");return getComputedStyle(label).textOverflow==="ellipsis" && getComputedStyle(label).whiteSpace==="nowrap" && row.querySelector("pre code").textContent==="npm run build && npm test" && row.querySelector("[data-tool-output]").textContent.includes("34 checks passed")})()'));
 await evalJS('document.querySelector("#chat-specimen [data-work-log]").scrollIntoView()');await wait(100);
 await capture(${JSON.stringify(path.join(out, "tool-expanded.png"))});
 check('chat status has its timer beside it in the same type and no Stop',await evalJS('(()=>{const e=document.querySelector("#chat-specimen [data-chat-status]"),s=e.querySelector("[role=status]"),t=e.querySelector("[data-chat-elapsed]"),a=s.getBoundingClientRect(),b=t.getBoundingClientRect();return !e.textContent.includes("Stop") && b.left>=a.right && Math.abs(b.top+b.bottom-a.top-a.bottom)<2 && getComputedStyle(t).fontSize===getComputedStyle(s).fontSize})()'));
 await evalJS('document.querySelector("#chat-specimen").scrollIntoView()');await wait(200);
 await capture(${JSON.stringify(path.join(out, "chat-reference.png"))});
 await evalJS('document.querySelector("#chat-specimen").style.width="300px"');await wait(100);
 check('narrow question keeps every option and action in bounds',await evalJS('[...document.querySelectorAll("#chat-specimen [data-chat-question]")].every(e=>e.scrollWidth<=e.clientWidth)'));
 await evalJS('document.querySelector("#question-specimen").scrollIntoView()');
 await capture(${JSON.stringify(path.join(out, "chat-narrow.png"))});
 wc.setZoomFactor(2);await wait(100);
 check('200% question has no horizontal overflow',await evalJS('[...document.querySelectorAll("#chat-specimen [data-chat-question]")].every(e=>e.scrollWidth<=e.clientWidth)'));
 await capture(${JSON.stringify(path.join(out, "chat-200.png"))});
 await evalJS('document.querySelector("#plan-specimen").scrollIntoView()');await wait(100);
 check('200% plan keeps footer in its frame with no horizontal overflow',await evalJS('(()=>{const e=document.querySelector("[data-plan-review]"),f=e.querySelector("[data-plan-actions]"),r=e.getBoundingClientRect(),b=f.getBoundingClientRect();return e.scrollWidth<=e.clientWidth && b.bottom<=r.bottom && b.top>=r.top && [...f.querySelectorAll("button")].every(e=>getComputedStyle(e).cursor==="pointer")})()'));
 await capture(${JSON.stringify(path.join(out, "plan-200.png"))});
 wc.setZoomFactor(1);await evalJS('document.querySelector("#chat-polish-specimen").scrollIntoView()');await wait(200);
 check('only overflowing user messages offer Show more',await evalJS('(()=>{const e=document.querySelector("#chat-polish-specimen");return e.querySelectorAll("[data-user-message]").length===2 && e.querySelectorAll(".chat-user-toggle").length===1 && e.querySelector(".chat-user-toggle").getAttribute("aria-expanded")==="false" && e.querySelector("[data-overflow]").scrollHeight>e.querySelector("[data-overflow]").clientHeight})()'));
 const clockGap=await evalJS('(()=>{const t=document.querySelector("#chat-polish-specimen [data-chat-elapsed] > span").firstChild,at=t.data.search(/\\s/),r=document.createRange();r.setStart(t,at);r.setEnd(t,at+1);return {text:t.data,gap:r.getBoundingClientRect().width,size:parseFloat(getComputedStyle(t.parentElement).fontSize)}})()');
 check('a minutes clock keeps a word space between its minutes and seconds under tabular figures',clockGap.gap>0&&clockGap.gap<0.4*clockGap.size,clockGap);
 await capture(${JSON.stringify(path.join(out, "user-folded.png"))});
 await evalJS('document.querySelector("#chat-polish-specimen .chat-user-toggle").focus()');await key('Enter');
 check('keyboard expansion reveals the complete brief',await evalJS('(()=>{const e=document.querySelector("#chat-polish-specimen [data-user-message]"),c=e.querySelector(".chat-user-content");return e.querySelector("button").getAttribute("aria-expanded")==="true" && c.clientHeight===c.scrollHeight && c.textContent.includes("10. Keep")})()'));
 await key('Enter');await wait(150);
 check('folding restores compact content and keeps its control focused',await evalJS('document.activeElement.matches("#chat-polish-specimen .chat-user-toggle") && document.activeElement.getAttribute("aria-expanded")==="false"'));
 await evalJS('document.querySelector("#chat-polish-specimen").style.width="300px"');await wait(150);
 check('folded user message stays reachable in narrow chat',await evalJS('(()=>{const e=document.querySelector("#chat-polish-specimen [data-user-message]");return e.scrollWidth<=e.clientWidth && e.querySelector("button").textContent==="Show more"})()'));
 await capture(${JSON.stringify(path.join(out, "user-folded-narrow.png"))});
 await evalJS('document.querySelector("#chat-polish-specimen").style.width="440px";document.querySelector("#chat-specimen").style.width="440px";[...document.querySelectorAll("#chat-specimen [data-tool-state] [data-tool-toggle]")].find(e=>e.textContent.includes("Read the scene")).click();document.querySelector("#chat-specimen [data-work-log]").scrollIntoView()');await wait(100);
 check('expanded TypeScript output uses syntax highlighting and preserves text',await evalJS('(()=>{const e=[...document.querySelectorAll("#chat-specimen [data-tool-state]")].find(e=>e.textContent.includes("Read the scene"));return !!e.querySelector("[data-tool-output] .hljs-keyword") && e.querySelector("[data-tool-output]").textContent.includes("warm white")})()'));
 await capture(${JSON.stringify(path.join(out, "tool-highlighted.png"))});
 check('no renderer errors after chat interactions',errors.length===0,[...errors]);
 if(${process.argv.includes("--source-reference")}){wc.setZoomFactor(1);await win.loadFile(${JSON.stringify(path.join(out, "../source-reference/index.html"))});await evalJS('document.fonts.ready.then(()=>true)');await wait(400);await capture(${JSON.stringify(path.join(out, "../source-reference/reference.png"))});}

 }catch(error){check('runner completed',false,String(error.stack));}
 fs.writeFileSync(${JSON.stringify(path.join(out, "report.json"))},JSON.stringify({profile:${JSON.stringify(profile)},provider:'none',electron:process.versions.electron,checks},null,2));
 app.exit(checks.some(c=>!c.ok)?1:0);
});
`,
);
const child = spawn(resolveElectron(), fixtureElectronArgs([bootstrap]), {
  env: fixtureElectronEnv(),
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk;
  process.stderr.write(chunk);
});
child.stdout.on("data", (chunk) => process.stdout.write(chunk));
const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
try {
  const code = await new Promise((resolve, reject) => {
    child.on("exit", resolve);
    child.on("error", reject);
  });
  const report = JSON.parse(await readFile(path.join(out, "report.json"), "utf8"));
  for (const check of report.checks)
    console.log(
      `${check.ok ? "✔" : "✖"} ${check.name}${!check.ok && check.detail ? " — " + JSON.stringify(check.detail) : ""}`,
    );
  console.log(path.join(out, "report.json"));
  if (code !== 0) {
    process.exitCode = 1;
    console.error(stderr.slice(-2000));
  }
} finally {
  clearTimeout(timer);
  await rm(profile, { recursive: true, force: true });
}
