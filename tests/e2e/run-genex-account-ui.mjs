// L4: the Genex page's own account card keeps the reason a connect failed in view.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { fixtureElectronArgs, fixtureElectronEnv, resolveElectron } from "../../scripts/electron-runtime.mjs";

const out = path.resolve(".studio-dev/evidence/genex-account-card");
await mkdir(out, { recursive: true });
await build({
  entryPoints: ["tests/e2e/genex-account-fixture.tsx"],
  bundle: true,
  format: "esm",
  outfile: path.join(out, "fixture.js"),
  jsx: "automatic",
});
await writeFile(
  path.join(out, "index.html"),
  '<style>body{margin:0;background:#111;color:#eee}</style><div id="root"></div><script type="module" src="./fixture.js"></script>',
);
const profile = await mkdtemp(path.join(os.tmpdir(), "genex-account-ui-"));
const boot = path.join(out, "boot.cjs");
await writeFile(
  boot,
  `
const {app,BrowserWindow}=require('electron'),fs=require('fs');app.setPath('userData',${JSON.stringify(profile)});
const checks=[];const wait=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:900,height:500,webPreferences:{nodeIntegration:false,contextIsolation:true}});try{
 await w.loadFile(${JSON.stringify(path.join(out, "index.html"))});
 const js=s=>w.webContents.executeJavaScript(s);const text=()=>js('document.body.innerText');
 const until=async(fn)=>{for(let i=0;i<100;i++){if(await fn())return;await wait(50);}throw Error('condition timed out');};
 const check=(name,ok)=>{checks.push({name,ok});if(!ok)throw Error(name);};
 await until(async()=>js('[...document.querySelectorAll("button")].some(b=>b.textContent==="Connect")'));
 check('a never-connected profile offers Connect, not unlock',!(await text()).includes('could not be unlocked'));
 await js('[...document.querySelectorAll("button")].find(b=>b.textContent==="Connect").click()');
 await until(async()=>(await text()).includes('Reconnect'));
 await wait(300);
 check('one connect',await js('window.test.connects()')===1);
 check('the failed connect says why, after the status is read again',(await text()).includes('could not be unlocked'));
 fs.writeFileSync(${JSON.stringify(path.join(out, "failed.png"))},(await w.webContents.capturePage()).toPNG());
 fs.writeFileSync(${JSON.stringify(path.join(out, "report.json"))},JSON.stringify({checks},null,2));app.exit(0);
 }catch(e){fs.writeFileSync(${JSON.stringify(path.join(out, "report.json"))},JSON.stringify({checks,error:String(e)},null,2));console.error(e);app.exit(1);}});
`,
);
const child = spawn(resolveElectron(process.cwd()), fixtureElectronArgs([boot]), {
  env: fixtureElectronEnv(),
  stdio: "inherit",
});
const code = await new Promise((r) => child.on("exit", r));
await rm(profile, { recursive: true, force: true });
process.exitCode = code ?? 1;
