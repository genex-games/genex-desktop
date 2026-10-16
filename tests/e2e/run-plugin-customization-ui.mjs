/** Exercise the public panel API and host effects in an isolated Electron renderer. */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pluginTheme } from "../helpers/plugin-theme.ts";
import { build } from "esbuild";
import { fixtureElectronArgs, fixtureElectronEnv, resolveElectron } from "../../scripts/electron-runtime.mjs";
import { removeTree } from "../helpers/tmp.ts";
const RUN_TIMEOUT_MS = 30_000;
const root = process.cwd(),
  out = path.join(root, ".studio-dev/evidence/plugin-customization-ui");
await mkdir(out, { recursive: true });
await rm(path.join(out, "report.json"), { force: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "genex-customization-ui-"));
await build({
  entryPoints: [path.join(root, "tests/e2e/plugin-customization-fixture.tsx")],
  outfile: path.join(out, "fixture.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(
  path.join(out, "index.html"),
  `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${path.join(root, "dist/renderer/theme.css")}"><div id="root"></div><script type="module" src="fixture.js"></script>`,
);
const sdk = await readFile(path.join(root, "src/plugin-sdk/panel.js"), "utf8");
const theme = { version: 1, theme: pluginTheme(), newChat: { panel: "widget", height: 160 } };
const panel = `<!doctype html><meta charset="utf-8"><style>body{background:#15181c;color:#eee;font:14px system-ui;padding:20px}button{font:inherit;padding:10px;margin:6px;cursor:pointer}</style><h2>Disposable SDK test</h2><button id="apply">Apply</button><button id="reset">Reset</button><button id="invalid">Invalid</button><pre id="result"></pre><script>${sdk}</script><script>
const show=async(fn)=>{try{await fn();result.textContent='ok'}catch(e){result.textContent=e.message}};
document.querySelector('#apply').onclick=()=>show(()=>studioPlugin.call('customization.set',undefined,${JSON.stringify(theme)}));
document.querySelector('#reset').onclick=()=>show(()=>studioPlugin.call('customization.reset'));
document.querySelector('#invalid').onclick=()=>show(()=>studioPlugin.call('customization.set',undefined,{version:1,css:'body{display:none}'}));
</script>`;
const widgetPanel = `<!doctype html><meta charset="utf-8"><style>body{margin:8px;height:5000px;font:14px system-ui;background:#15181c;color:#eee}</style><div>Custom plugin UI</div><script>${sdk}</script>`;
await writeFile(
  path.join(out, "check.cjs"),
  String.raw`
const{app,BrowserWindow,protocol}=require('electron');const fs=require('node:fs');const{setTimeout:sleep}=require('node:timers/promises');
app.disableHardwareAcceleration();app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');app.setPath('userData',${JSON.stringify(profile)});app.setPath('sessionData',${JSON.stringify(path.join(profile, "session"))});
protocol.registerSchemesAsPrivileged([{scheme:'studio-plugin',privileges:{standard:true,secure:true}}]);
const checks=[];function check(name,ok){checks.push({name,ok});console.log(name);if(!ok)throw new Error(name)}
async function until(fn){const end=Date.now()+5000;while(Date.now()<end){if(await fn())return;await sleep(25);}throw new Error('Fixture condition timed out')}
app.whenReady().then(async()=>{
console.log('Electron ready');
protocol.handle('studio-plugin',request=>new Response(request.url.endsWith('/widget')?${JSON.stringify(widgetPanel)}:${JSON.stringify(panel)},{headers:{'Content-Type':'text/html','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"}}));
const win=new BrowserWindow({width:1000,height:850,show:false,x:-4000,focusable:false,skipTaskbar:true,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});win.showInactive();const wc=win.webContents, errors=[];
wc.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});
const js=code=>wc.executeJavaScript(code,true);
try{
await win.loadFile(${JSON.stringify(path.join(out, "index.html"))});
console.log('Fixture loaded');
await until(()=>js('!!document.querySelector("#native-control")'));
let frame;await until(async()=>{frame=wc.mainFrame.frames.find(f=>f.url.startsWith('studio-plugin:'));return !!frame});
await until(()=>frame.executeJavaScript('!!window.studioPlugin'));
check('opaque panel has no preload or Node',await frame.executeJavaScript('!window.studio && !window.require && !window.process && self.origin === "null"'));
check('feature discovery preserves native surface context',await frame.executeJavaScript("studioPlugin.call('context').then(c=>c.features.uiCustomization===1 && !!c.surface)"));
const ordinary=await js('getComputedStyle(document.documentElement).getPropertyValue("--background")');
const saved=await js('localStorage.getItem("studio.appearance.v1")');
const radius=await js('getComputedStyle(document.querySelector("#native-control")).borderRadius');
await frame.executeJavaScript('document.querySelector("#apply").click()');
await until(()=>js('!!document.querySelector("[data-new-chat-plugin]")'));
check('offering a theme does not select it or change saved appearance',await js('getComputedStyle(document.documentElement).getPropertyValue("--background")')===ordinary && await js('localStorage.getItem("studio.appearance.v1")')===saved);
check('one host label identifies the plugin and its panel',await js('document.querySelectorAll("[data-new-chat-plugin]").length===1 && document.querySelector(".new-chat-plugin-source").textContent.includes("Plugin: Fixture theme") && document.querySelector(".new-chat-plugin-source").textContent.includes("Fixture widget")'));
let widget; await until(async()=>{widget=wc.mainFrame.frames.find(f=>f.url.endsWith('/widget'));return !!widget});
await widget.executeJavaScript('parent.postMessage({type:"studio-plugin-size",height:5000},"*")');
await until(()=>js('document.querySelector(".new-chat-plugin-content iframe")?.style.height==="4000px"'));
check('large plugin content remains clipped below the prompt',await js('(()=>{const box=document.querySelector("[data-new-chat-plugin]"),content=box.querySelector(".new-chat-plugin-content"),prompt=document.querySelector("#new-chat");return box.getBoundingClientRect().top>=prompt.getBoundingClientRect().bottom && content.getBoundingClientRect().height===160 && getComputedStyle(content).contain.includes("paint") && getComputedStyle(box).position!=="absolute"})()'));
await js('customizationFixture.appearance(true)');
await until(()=>js('!!document.querySelector("[data-plugin-theme-choice]")'));
await js('document.querySelector("[data-plugin-theme-choice] button").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,button:0,pointerType:"mouse"}))');
await until(()=>js('!!Array.from(document.querySelectorAll("[role=menuitemradio]")).find(e=>e.textContent.includes("Test theme"))'));
check('Appearance lists a theme with plugin name and publisher',await js('Array.from(document.querySelectorAll("[role=menuitemradio]")).some(e=>e.textContent.includes("Plugin: Fixture theme by Fixture"))'));
await js('Array.from(document.querySelectorAll("[role=menuitemradio]")).find(e=>e.textContent.includes("Test theme")).click()');
await until(()=>js('document.querySelector("#chosen-theme").textContent==="theme"'));
check('selection is saved in ordinary appearance',await js('JSON.parse(localStorage.getItem("studio.appearance.v1")).pluginTheme==="theme"'));
await js('document.querySelector("#set-light").click()');
await until(()=>js('document.documentElement.dataset.theme==="light" && getComputedStyle(document.documentElement).getPropertyValue("--background")==="#ffffff"'));
check('light mode stays the persons choice',true);
await js('customizationFixture.mode("dark")');
await until(()=>js('document.documentElement.dataset.theme==="dark" && getComputedStyle(document.documentElement).getPropertyValue("--background")==="#111111"'));
check('native radii and fonts apply to the selected theme',await js('getComputedStyle(document.querySelector("#native-control")).borderRadius==="4px" && getComputedStyle(document.documentElement).getPropertyValue("--font-family-sans").includes("Segoe UI")'));
check('Appearance identifies the active plugin and offers turn off',await js('!!Array.from(document.querySelectorAll("button")).find(e=>e.textContent==="Turn off plugin theme") && document.querySelector("[data-plugin-theme-choice] [role=status]").textContent.includes("Plugin theme active")'));
await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
fs.writeFileSync(${JSON.stringify(path.join(out, "selected.png"))},(await wc.capturePage()).toPNG());
await js('document.querySelector("[data-plugin-theme-choice]").scrollIntoView({block:"center"})');
await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
fs.writeFileSync(${JSON.stringify(path.join(out, "appearance.png"))},(await wc.capturePage()).toPNG());
await js('Array.from(document.querySelectorAll("button")).find(e=>e.textContent==="Turn off plugin theme").click()');
await until(()=>js('document.querySelector("#chosen-theme").textContent==="built-in"'));
check('turn off restores geometry while leaving the panel',await js('getComputedStyle(document.querySelector("#native-control")).borderRadius')===radius && await js('!!document.querySelector("[data-new-chat-plugin]") && !JSON.parse(localStorage.getItem("studio.appearance.v1")).pluginTheme'));
await js('customizationFixture.select("theme")');
await frame.executeJavaScript('document.querySelector("#invalid").click()');
await until(()=>frame.executeJavaScript('document.querySelector("#result").textContent.includes("Invalid")'));
check('rejected write leaves the prior profile intact',await js('customizationFixture.profile().theme.name==="Test theme"'));
await js('customizationFixture.enable(false)');
await until(()=>js('!document.querySelector("[data-new-chat-plugin]")'));
check('disable restores native geometry and shows unavailable theme notice',await js('getComputedStyle(document.querySelector("#native-control")).borderRadius')===radius && await js('document.querySelector("[data-plugin-theme-choice] [role=status]").textContent.includes("unavailable")'));
await frame.executeJavaScript('document.querySelector("#apply").click()');
await until(()=>frame.executeJavaScript('document.querySelector("#result").textContent.includes("capability")'));
check('disabled panel cannot write',true);
await js('customizationFixture.enable(true)');
await until(()=>js('getComputedStyle(document.documentElement).getPropertyValue("--background")==="#111111"'));
check('reenabling restores the explicitly chosen theme and panel',await js('!!document.querySelector("[data-new-chat-plugin]")'));
win.setContentSize(420,800);
await js('document.querySelector("[data-new-chat-plugin]").scrollIntoView({block:"start"})');
await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
check('the small slot fits a narrow window without horizontal scrolling',await js('(()=>{const e=document.querySelector("[data-new-chat-plugin]"),r=e.getBoundingClientRect();return r.width<=innerWidth && r.left>=0 && r.right<=innerWidth && getComputedStyle(document.querySelector(".new-chat-plugin-source span")).textOverflow==="ellipsis"})()'));
await frame.executeJavaScript('document.querySelector("#reset").click()');
await until(()=>js('customizationFixture.profile()===null && !document.querySelector("[data-new-chat-plugin]")'));
check('reset restores native geometry',await js('getComputedStyle(document.querySelector("#native-control")).borderRadius')===radius);
check('no renderer errors',errors.length===0);
}catch(error){checks.push({name:'runner completed',ok:false,error:String(error.stack)});}
fs.writeFileSync(${JSON.stringify(path.join(out, "report.json"))},JSON.stringify({checks,errors,provider:'fixture',electron:process.versions.electron},null,2));win.destroy();app.exit(checks.some(c=>!c.ok)?1:0);
});
`,
);
const child = spawn(resolveElectron(), fixtureElectronArgs([path.join(out, "check.cjs")]), {
  env: fixtureElectronEnv(),
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (data) => process.stdout.write(data));
child.stderr.on("data", (data) => process.stderr.write(data));
const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
try {
  const code = await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  const report = JSON.parse(await readFile(path.join(out, "report.json"), "utf8"));
  for (const check of report.checks)
    console.log(`${check.ok ? "✔" : "✖"} ${check.name}${check.error ? `: ${check.error}` : ""}`);
  if (code !== 0) process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await removeTree(profile);
}
