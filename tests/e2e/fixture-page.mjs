/**
 * The shared frame of an L4 runner over one renderer fixture page (`run-stage-ui.mjs`,
 * `run-toolchain-ui.mjs`): bundle a `*-fixture.tsx` with esbuild, compile the app's theme with
 * Tailwind, and drive the page in a hidden Electron window with a fresh disposable profile and a
 * fake host API. No app build, providers, accounts, network or native dialogs. Evidence (each
 * screenshot and `report.json` with the source identity) goes to `.studio-dev/evidence/<name>/`.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { fixtureElectronArgs, fixtureElectronEnv, resolveElectron } from "../../scripts/electron-runtime.mjs";
import { sourceIdentity } from "../../scripts/studio-dev/files.mjs";

/**
 * Bundles `entry` into `out` with the app's compiled theme and fonts, and an `index.html` that
 * loads both.
 */
async function buildPage(root, entry, out) {
  await build({
    entryPoints: [entry],
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
    { cwd: root, stdio: "pipe" },
  );
  await fs.cp(path.join(root, "src/renderer/fonts"), path.join(out, "fonts"), { recursive: true });
  await fs.writeFile(
    path.join(out, "index.html"),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>',
  );
}

/**
 * The Electron driver: loads the page, then runs `steps` (the body of an async function) with
 * `js`, `wait`, `check`, `until`, `capture`, `text` and `win` in scope. A failed check ends the run.
 */
function driver(out, profile, identity, steps, size) {
  return `
const {app,BrowserWindow}=require('electron'),fs=require('node:fs');
app.setPath('userData',${JSON.stringify(profile)});
const out=${JSON.stringify(out)},report={identity:${JSON.stringify(identity)},checks:[],artifacts:[]};
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:${size.width},height:${size.height},show:false,focusable:false,skipTaskbar:true,x:-4000,y:0,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 win.showInactive();
 const wc=win.webContents,errors=[];
 wc.on('console-message',(details)=>{if(details.level==='error')errors.push(details.message);});
 const js=code=>wc.executeJavaScript(code,true),wait=ms=>new Promise(r=>setTimeout(r,ms));
 const check=(name,ok,detail)=>{report.checks.push({name,ok,detail});if(!ok)throw new Error(name+' '+JSON.stringify(detail??''));console.log('PASS '+name);};
 const until=async(code)=>{for(let n=0;n<100;n++){if(await js(code))return;await wait(50);}throw new Error('Timed out: '+code);};
 const capture=async name=>{await wc.capturePage();await wait(150);fs.writeFileSync(out+'/'+name+'.png',(await wc.capturePage()).toPNG());report.artifacts.push(name+'.png');};
 const text=selector=>js('document.querySelector('+JSON.stringify(selector)+')?.innerText??""');
 try{
  await win.loadFile(out+'/index.html');
  await js('document.fonts.ready');
  ${steps}
  check('no renderer errors',errors.length===0,errors);
  report.ok=true;
 }catch(error){report.ok=false;report.error=String(error.stack||error);report.failureState={body:await js('document.body.innerText').catch(()=>null),errors};console.error(error);}
 fs.writeFileSync(out+'/report.json',JSON.stringify(report,null,2));
 app.exit(report.ok?0:1);
});
`;
}

/**
 * Builds `entry` and drives it with `steps`; answers the Electron driver's exit code. The profile
 * is a fresh temporary folder, removed afterwards.
 */
export async function runFixturePage({ name, entry, steps, size = { width: 1100, height: 720 } }) {
  const root = process.cwd();
  const out = path.join(root, ".studio-dev/evidence", name);
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(out, { recursive: true });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), `studio-${name}-`));
  try {
    await buildPage(root, entry, out);
    const identity = { source: sourceIdentity(root), profile, providers: "none (fake window.studio)" };
    await fs.writeFile(path.join(out, "check.cjs"), driver(out, profile, identity, steps, size));
    const child = spawn(resolveElectron(root), fixtureElectronArgs([path.join(out, "check.cjs")]), {
      env: fixtureElectronEnv(),
      stdio: "inherit",
    });
    return (await new Promise((resolve) => child.on("exit", resolve))) ?? 1;
  } finally {
    await fs.rm(profile, { recursive: true, force: true });
  }
}
