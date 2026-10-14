/**
 * L4: Home's normal Browser flow and explicit compiled-game creation in real Chromium, with real
 * shell hooks and a fake host API. C++ · raylib creation is retired (M6.3): no host, build or box
 * offers it. Where main's Rust creation gate is closed (M6.4: Windows, an Intel Mac) the compiled
 * entry makes only a browser game; where it is open (a developer run, or a release build where its
 * lane runs) it makes Rust · wgpu, with its own setup sheet (Rust components,
 * Apple's tools and Xcode apart, never C++ words). No app build, providers, accounts or native dialogs.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { fixtureElectronArgs, fixtureElectronEnv, resolveElectron } from "../../scripts/electron-runtime.mjs";
import { sourceIdentity } from "../../scripts/studio-dev/files.mjs";

const root = process.cwd();
const out = path.join(root, ".studio-dev/evidence/cpp-home-once-ui");
await fs.mkdir(out, { recursive: true });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "studio-create-game-ui-"));
const realSheet = path.join(root, "src/renderer/panels/ToolchainSheet.tsx");
/**
 * Wraps the dialog's Toolchain sheet in a spy that records each opening and its destinations and
 * keeps its `onClose`, then renders the real sheet with the same props. The spy's own import of
 * the real module resolves normally.
 */
const sheetSpy = {
  name: "toolchain-sheet-spy",
  setup(builder) {
    builder.onResolve({ filter: /\/ToolchainSheet\.tsx$/ }, (args) =>
      args.namespace === "sheet-spy" ? undefined : { path: realSheet, namespace: "sheet-spy" },
    );
    builder.onLoad({ filter: /.*/, namespace: "sheet-spy" }, () => ({
      loader: "tsx",
      resolveDir: path.dirname(realSheet),
      contents: `import { ToolchainSheet as Real } from ${JSON.stringify(realSheet)};
export { useToolchainStatus } from ${JSON.stringify(realSheet)};
export function ToolchainSheet(props) {
  const spy = (window.__toolchainSheet ??= { opened: 0, open: false, targets: [] });
  if (props.open && !spy.open) spy.opened++;
  spy.open = props.open;
  spy.targets = [...props.targets];
  spy.onClose = props.onClose;
  return <Real {...props} />;
}`,
    }));
  },
};
await build({
  entryPoints: ["tests/e2e/create-game-fixture.tsx"],
  outfile: path.join(out, "fixture.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [sheetSpy],
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
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>',
);
const identity = { source: sourceIdentity(root), profile, providers: "none (fake window.studio)" };
await fs.writeFile(
  path.join(out, "check.cjs"),
  String.raw`
const {app,BrowserWindow}=require('electron'),fs=require('node:fs');
app.setPath('userData',${JSON.stringify(profile)});
const out=${JSON.stringify(out)},report={identity:${JSON.stringify(identity)},checks:[],artifacts:[]};
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:900,height:640,show:false,focusable:false,skipTaskbar:true,x:-4000,y:0,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 win.showInactive();
 const wc=win.webContents,errors=[];
 wc.on('console-message',(details)=>{if(details.level==='error')errors.push(details.message);});
 const js=code=>wc.executeJavaScript(code,true),wait=ms=>new Promise(r=>setTimeout(r,ms));
 const check=(name,ok,detail)=>{report.checks.push({name,ok,detail});if(!ok)throw new Error(name+' '+JSON.stringify(detail??''));console.log('PASS '+name);};
 const until=async(code)=>{for(let n=0;n<80;n++){if(await js(code))return;await wait(50);}throw new Error('Timed out: '+code);};
 const capture=async name=>{await wc.capturePage();await wait(150);fs.writeFileSync(out+'/'+name+'.png',(await wc.capturePage()).toPNG());report.artifacts.push(name+'.png');};
 const dialog='document.querySelector("[data-testid=create-game-dialog]")';
 const text=()=>js(dialog+'?.innerText??""');
 const calls=()=>js('window.test.calls()');
 const methods=async()=>(await calls()).map(c=>c.method);
 const home='document.querySelector("[data-home]")';
 const cppEntry='document.querySelector("[data-home-cpp]")';
 const box=t=>dialog+'.querySelector("[data-create-game-destination='+t+']")';
 const button=label=>'[...'+dialog+'.querySelectorAll("button")].find(b=>b.textContent.trim()==='+JSON.stringify(label)+')';
 const press=async label=>{await js(button(label)+'.click()');await wait(200);};
 const escape=async()=>{wc.sendInputEvent({type:'keyDown',keyCode:'Escape'});wc.sendInputEvent({type:'keyUp',keyCode:'Escape'});await wait(250);};
 const reset=async()=>{await js('window.test.remount()');await until(home);await wait(150);};
 const openCpp=async()=>{await js(cppEntry+'.focus();'+cppEntry+'.click()');await until(dialog);};
 const open=async()=>{await openCpp();await until('document.querySelector("[data-toolchain-sheet]")');};
 const closeTools=async()=>{await escape();await until('!document.querySelector("[data-toolchain-sheet]")');};
 const fresh=async()=>{await reset();await open();await closeTools();await until('document.activeElement?.id==="create-game-name"');};
 const type=async value=>{await js('document.querySelector("#create-game-name").focus()');await wc.insertText(value);await wait(100);};
 const tick=async t=>{await js(box(t)+'.click()');await wait(150);};
 const described=t=>js('(()=>{const b='+box(t)+',id=b.getAttribute("aria-describedby");return id?document.getElementById(id)?.textContent??"":""})()');
 const cursor=selector=>js('getComputedStyle('+selector+').cursor');
 try{
  await win.loadFile(out+'/index.html');
  await js('document.fonts.ready');await until(home);
  check('Home starts without a creation dialog',!(await js(dialog)));
  await js('document.querySelector("[data-fixture-new]").click()');await wait(150);
  check('New game opens Home and focuses its composer',await js(home+' && !'+dialog+' && document.activeElement?.tagName==="TEXTAREA"'));
  wc.sendInputEvent({type:'keyDown',keyCode:'n',modifiers:['meta']});wc.sendInputEvent({type:'keyUp',keyCode:'n',modifiers:['meta']});await wait(150);
  check('Command-N keeps normal creation on Home',await js(home+' && !'+dialog));
  await js('window.test.welcome("A browser puzzle")');await wait(150);
  check('Mac welcome stays on Home with its idea in the composer',await js(home+' && !'+dialog+' && document.querySelector("[data-home-composer] textarea").value==="A browser puzzle"'));
  check('welcome makes no game',(await methods()).every(m=>m!=='createGame'));
  await capture('home-dark');
  await js('document.querySelector("[data-home-composer] button[aria-label=Send]").click()');
  await until('window.test.calls().some(c=>c.method==="createGame")');
  const browser=(await calls()).find(c=>c.method==='createGame');
  check('Home first-send still creates a normal Browser game',JSON.stringify(browser.args)===JSON.stringify(['Browser game']),browser);
  // Flipped (M6.3): the compiled entry used to open on C++ · raylib with its setup sheet. raylib
  // creation is retired; a build whose Rust creation gate is closed (M6.4: Windows, an Intel Mac) makes only a browser game here.
  await reset();await openCpp();await wait(250);
  const stackRadio=s=>dialog+'.querySelector("[data-create-game-stack='+s+']")';
  check('a closed Rust gate offers no stack choice and never C++',!(await js(dialog+'.querySelector("[data-create-game-stacks]")'))&&!(await js(stackRadio('raylib-cpp')))&&!(await text()).includes('C++'),await text());
  check('a closed Rust gate opens no setup sheet and asks the store nothing for a browser game',!(await js('document.querySelector("[data-toolchain-sheet]")'))&&(await methods()).every(m=>m!=='toolchainStatus'));
  check('a closed Rust gate names a new game and Three.js',await js('document.body.innerText.includes("New game")')&&(await text()).includes('Made in Three.js'),await text());
  check('Browser is selected by default',await js(box('web')+'.checked'));
  check('a closed Rust gate refuses every desktop box and says why',await js(['macos','windows','linux'].map(t=>box(t)+'.disabled').join('&&'))&&(await described('macos')).includes('Rust games aren’t available'),await described('macos'));
  await capture('packaged-browser-only-dark');
  await type('Web game');await press('Create game');await until('!'+dialog);
  const packagedCreated=(await calls()).find(c=>c.method==='createGame');
  check('a closed Rust gate creates a browser game with no stack',JSON.stringify(packagedCreated.args)===JSON.stringify(['Web game']),packagedCreated);
  const created=[packagedCreated];
  // An open Rust gate on an Apple-silicon Mac (a developer run, or a release build since M6.4).
  // Flipped (M6 review): Rust · wgpu was the one stack offered, with no choice; Three.js is offered
  // beside it now, and the dialog starts on the stack the stackDefault switch names (Rust as shipped).
  await js('window.test.rustCreation(true)');
  await reset();await open();
  check('an open Rust gate starts on Rust, with Three.js and Rust as the stack choice and no C++ option',Boolean(await js(dialog+'.querySelector("[data-create-game-stacks]")'))&&Boolean(await js(stackRadio('three-js')))&&await js(stackRadio('rust-wgpu')+'?.checked')&&!(await js(stackRadio('raylib-cpp')))&&(await text()).includes('Made in Rust · wgpu')&&!(await text()).includes('C++'),await text());
  check('the title names a Rust game',await js('document.body.innerText.includes("New Rust game")'));
  const rustSheet='document.querySelector("[data-toolchain-sheet][data-toolchain-stack=rust-wgpu]")';
  await until(rustSheet);
  const rustSetup=await js('document.querySelector("[data-testid=toolchain-sheet]").innerText');
  check('opening offers the Rust setup once, for Browser and Mac',((await js('window.test.sheet()'))?.opened??0)===1&&JSON.stringify((await js('window.test.sheet()')).targets)===JSON.stringify(['web','macos']));
  check('the Rust setup is titled for Rust games and never says C++',rustSetup.includes('Set up Rust games')&&!/C\+\+/.test(rustSetup),rustSetup);
  check('the Rust setup lists Apple’s tools and Xcode apart, Xcode missing',await js('Boolean('+rustSheet+'.querySelector("[data-toolchain-prerequisite=clt][data-toolchain-present]")&&'+rustSheet+'.querySelector("[data-toolchain-prerequisite=xcode]:not([data-toolchain-present])"))'));
  check('the Rust setup lists Rust components, no C++ one, and no Install',await js('Boolean('+rustSheet+'.querySelector("[data-toolchain-download=rust]"))&&!'+rustSheet+'.querySelector("[data-toolchain-download=emsdk]")&&!document.querySelector("[data-toolchain-install]")'));
  await capture('rust-setup-dark');await closeTools();
  const sheetsBefore=(await js('window.test.sheet()'))?.opened??0;
  await tick('macos');await tick('windows');
  check('changing targets does not repeat the setup offer',((await js('window.test.sheet()'))?.opened??0)===sheetsBefore&&!(await js('document.querySelector("[data-toolchain-sheet]")')));
  await fresh();
  check('Browser is selected by default for Rust',await js(box('web')+'.checked'));
  check('the compiled entry has no duplicate Open existing or stack override',await js('!'+dialog+'.querySelector("[data-create-game-door]") && !'+dialog+'.querySelector("[data-create-game-cpp]")'));
  check('closing the nested Toolchain sheet restores name-field focus',await js('document.activeElement.id==="create-game-name"'));
  check('missing name disables Create without a pointer',await js(button('Create game')+'.disabled')&&(await cursor(button('Create game')))!=='pointer');
  check('enabled destination and its text have pointers',(await cursor(box('web')+'.closest("label")'))==='pointer'&&(await cursor(box('web')+'.closest("label").querySelector("span")'))==='pointer');
  const focusOrder=[];
  for(let i=0;i<7;i++){wc.sendInputEvent({type:'keyDown',keyCode:'Tab'});wc.sendInputEvent({type:'keyUp',keyCode:'Tab'});await wait(70);focusOrder.push(await js('document.activeElement.dataset.createGameDestination||document.activeElement.dataset.createGameStack||document.activeElement.textContent.trim()'));}
  check('keyboard reaches location, the chosen stack, four targets and Cancel',JSON.stringify(focusOrder)===JSON.stringify(['Change…','rust-wgpu','web','macos','windows','linux','Cancel']),focusOrder);
  await capture('rust-dark');
  await escape();await until('!'+dialog);
  check('Escape closes the dialog and returns focus to its Home entry',await js('document.activeElement.hasAttribute("data-home-cpp")'));
  await js('document.querySelector("[data-home-composer] textarea").focus()');await wc.insertText('Keep this draft');
  await open();await closeTools();await press('Cancel');await until('!'+dialog);
  check('Cancel keeps the Home draft',await js('document.querySelector("[data-home-composer] textarea").value==="Keep this draft"'));
  await fresh();await type('Rust web');await press('Create game');await until('!'+dialog);
  const rustWeb=(await calls()).find(c=>c.method==='createGame');created.push(rustWeb);
  check('Browser-only compiled creation sends rust-wgpu',JSON.stringify(rustWeb.args)===JSON.stringify(['Rust web',{stack:'rust-wgpu',targets:['web']}]),rustWeb);
  await fresh();await tick('macos');await type('Rust pond');
  check('Mac selection keeps the Rust stack',(await text()).includes('Made in Rust · wgpu'));
  await press('Create game');await until('!'+dialog);
  const rustMac=(await calls()).find(c=>c.method==='createGame');created.push(rustMac);
  check('a Rust game sends its stack with only the selected destinations',JSON.stringify(rustMac.args)===JSON.stringify(['Rust pond',{stack:'rust-wgpu',targets:['web','macos']}]),rustMac);
  // M6 review: Three.js is a choice where Rust is offered, and it makes a browser game.
  await fresh();await js(stackRadio('three-js')+'.click()');await wait(150);
  check('choosing Three.js names a browser game and refuses the desktop boxes, saying why',(await text()).includes('Made in Three.js')&&await js(box('macos')+'.disabled')&&(await described('macos')).includes('Three.js games play in the browser'),await described('macos'));
  await type('Cube');await press('Create game');await until('!'+dialog);
  const threeCreated=(await calls()).find(c=>c.method==='createGame');created.push(threeCreated);
  check('a Three.js choice creates a browser game with no stack',JSON.stringify(threeCreated.args)===JSON.stringify(['Cube']),threeCreated);
  // M6 review: the stackDefault switch reverted starts the dialog on Three.js, with Rust one choice away.
  await js('window.test.stackDefault("three-js")');await reset();await openCpp();await wait(250);
  check('the reverted switch starts on Three.js with Rust offered and no C++',await js(stackRadio('three-js')+'?.checked')&&Boolean(await js(stackRadio('rust-wgpu')))&&!(await js(stackRadio('raylib-cpp')))&&(await text()).includes('Made in Three.js'),await text());
  await js(stackRadio('rust-wgpu')+'.click()');await until('document.querySelector("[data-toolchain-sheet]")');
  check('choosing Rust under the reverted switch offers its setup once',((await js('window.test.sheet()'))?.opened??0)>=1);
  await js('window.test.closeSheet(false)');await until('!document.querySelector("[data-toolchain-sheet]")');await tick('macos');await type('Reverted pond');
  check('the reverted switch still makes a Rust game when Rust is chosen',(await text()).includes('Made in Rust · wgpu'));
  await press('Create game');await until('!'+dialog);
  const revertedRust=(await calls()).find(c=>c.method==='createGame');created.push(revertedRust);
  check('a Rust game chosen under the reverted switch sends its stack',JSON.stringify(revertedRust.args)===JSON.stringify(['Reverted pond',{stack:'rust-wgpu',targets:['web','macos']}]),revertedRust);
  await js('window.test.stackDefault("host-conditional")');
  // M6 review: offline, Rust stays offered once the store says its setup is already here.
  await js('window.test.online(false)');await reset();await openCpp();await wait(250);
  check('offline with no Rust setup here, the desktop boxes say the tools cannot be downloaded',await js(box('macos')+'.disabled')&&(await described('macos')).includes('can’t download them while offline'),await described('macos'));
  await escape();await until('!'+dialog);
  await js('window.test.rustReady(true)');await reset();await openCpp();
  await until(dialog+'.innerText.includes("Made in Rust · wgpu")');
  check('offline with Rust installed, Create game offers and starts on Rust',await js(stackRadio('rust-wgpu')+'?.checked')&&!(await js(box('macos')+'.disabled')),await text());
  await escape();await until('!'+dialog);
  await js('window.test.rustReady(false)');await js('window.test.online(true)');
  await fresh();await tick('web');
  check('no destination disables creation and explains recovery',await js(button('Create game')+'.disabled')&&(await text()).includes('Choose at least one place to play.'));
  check('nothing was created',(await methods()).every(m=>m!=='createGame'));
  await fresh();await tick('windows');
  check('an unrun destination says this computer cannot run it',(await described('windows')).includes('it can’t run on this computer'),await described('windows'));
  if(await js('Boolean(document.querySelector("[data-toolchain-sheet]"))'))await closeTools();
  await js('window.test.nextLocation({error:"Choose an empty folder."})');await press('Change…');
  check('a location refusal is visible beside creation',(await text()).includes('Choose an empty folder.'));
  await js('window.test.nextLocation({dir:"/Users/fixture/Projects",pathLabel:"~/Projects"})');await press('Change…');
  check('a new location is never inspected or adopted',(await methods()).every(m=>!['inspectFolder','adoptFolder','pickProject'].includes(m)));
  await type('In place');await press('Create game');await until('!'+dialog);
  const located=(await calls()).find(c=>c.method==='createGame');created.push(located);
  check('compiled create preserves chosen location',located.args[1].parent==='/Users/fixture/Projects',located);
  await fresh();await js('window.test.theme("light")');await wait(150);await capture('rust-light');
  await js('document.querySelector("#create-game-name").focus()');await wc.insertText('A long game name whose saved folder stays readable near the right edge');await capture('rust-long-light');
  win.setSize(640,480);await wait(250);await capture('rust-compact-light');
  check('the compact chooser fits inside its viewport',await js('(()=>{const r='+dialog+'.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()'));
  await escape();await until('!'+dialog);await capture('home-light');
  await js('window.test.theme("dark")');
  await js('window.test.platform("win32")');await reset();
  check('an unsupported Windows host has no compiled creation entry',!(await js(cppEntry)));
  await js('window.test.platform("linux")');await reset();
  check('Linux can reach compiled creation through the shared lane policy',Boolean(await js(cppEntry)));
  await open();
  check('Linux starts on Rust with Three.js beside it and no C++ option',Boolean(await js('document.querySelector("[data-create-game-stacks]")'))&&await js(stackRadio('rust-wgpu')+'?.checked')&&!(await js(stackRadio('raylib-cpp')))&&(await text()).includes('Made in Rust · wgpu'),await text());
  check('Linux Rust setup offers the browser build',JSON.stringify((await js('window.test.sheet()')).targets)===JSON.stringify(['web']));
  await capture('linux-rust-setup-dark');
  await closeTools();
  check('Linux refuses the Mac destination and says why',await js(box('macos')+'.disabled')&&(await described('macos')).includes('Mac games are built on a Mac'),await described('macos'));
  check('the refused Mac destination shows no pointer',(await cursor(box('macos')+'.closest("label")'))!=='pointer');
  await tick('windows');await tick('linux');await type('Linux destinations');await press('Create game');await until('!'+dialog);
  const linuxCreated=(await calls()).find(c=>c.method==='createGame');created.push(linuxCreated);
  check('Linux creates a Rust game with only the selected three destinations',JSON.stringify(linuxCreated.args)===JSON.stringify(['Linux destinations',{stack:'rust-wgpu',targets:['web','windows','linux']}]),linuxCreated);
  check('no create the dialog made ever named C++ · raylib',created.every(c=>!JSON.stringify(c.args).includes('raylib')),created);
  await js('window.test.platform("darwin")');await reset();
  win.setSize(900,640);await wait(200);
  const folderPoint=await js('(()=>{const r=document.querySelector("[data-home-folder]").getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()');
  wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...folderPoint});wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...folderPoint});
  await until('document.body.innerText.includes("Open a folder…")');
  check('Home still offers opening an existing game folder',await js('document.body.innerText.includes("Open a folder…")'));
  check('no renderer errors',errors.length===0,errors);
  report.ok=true;
 }catch(error){report.ok=false;report.error=String(error.stack||error);report.failureState={text:await text(),calls:await calls(),errors};console.error(error);console.error(JSON.stringify(report.failureState));}
 fs.writeFileSync(out+'/report.json',JSON.stringify(report,null,2));
 app.exit(report.ok?0:1);
});
`,
);
const child = spawn(resolveElectron(root), fixtureElectronArgs([path.join(out, "check.cjs")]), {
  env: fixtureElectronEnv(),
  stdio: "inherit",
});
const code = await new Promise((resolve) => child.on("exit", resolve));
await fs.rm(profile, { recursive: true, force: true });
process.exitCode = code ?? 1;
