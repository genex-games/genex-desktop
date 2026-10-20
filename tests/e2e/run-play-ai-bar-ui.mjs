/**
 * L4: the Play bar's AI pill and what it opens, in the production bar layer (`PlayBarPage`) over a
 * stand-in game, in a disposable Electron profile with a fake studio. It checks the pill's words, the
 * model menu's groups and pick, a first-use card's 600 ms gate, its answer and Change, setting a card
 * aside, a stop card into Get credits (packs, auto top-up, checkout), Report's "See what's sent" with
 * hostile text kept as text, Try again, and the notes, and saves light and dark screenshots of each.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { buildDesignGallery } from "../../scripts/design-gallery.mjs";
import { fixtureElectronArgs, fixtureElectronEnv, resolveElectron } from "../../scripts/electron-runtime.mjs";
import { sourceIdentity } from "../../scripts/studio-dev/files.mjs";

const out = await buildDesignGallery();
const evidence = path.resolve(".studio-dev/evidence", `play-ai-bar-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "genex-play-ai-bar-"));
await build({
  entryPoints: ["tests/fixtures/play-ai-bar.tsx"],
  outfile: path.join(out, "play-ai-bar.js"),
  bundle: true,
  format: "esm",
  jsx: "automatic",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
});
// The stand-in game: a painted map under the bar's see-through layer.
await writeFile(
  path.join(out, "play-ai-bar.html"),
  '<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="gallery.css"></head><body style="margin:0;background:linear-gradient(160deg,#41503a,#6a4b2f 40%,#3c4f63)"><div id="root"></div><script type="module" src="play-ai-bar.js"></script></body></html>',
);
const boot = path.join(out, "play-ai-bar.cjs");
await writeFile(
  boot,
  `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(profile)});
const report={source:${JSON.stringify(sourceIdentity(process.cwd()))},profile:${JSON.stringify(profile)},providers:'synthetic',checks:[],errors:[]};
report.buildId=report.source.sourceDigest;
report.electron=process.versions.electron;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1440,height:900,show:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const wc=win.webContents;
 wc.on('console-message',(event)=>{if(event.level==='error')report.errors.push(event.message)});
 const js=s=>wc.executeJavaScript(s);
 const until=async(what,expr)=>{for(let i=0;i<100;i++){if(await js(expr))return;await wait(30);}throw Error('timed out: '+what);};
 const check=(name,ok)=>{report.checks.push({name,ok:Boolean(ok)});assert.ok(ok,name);};
 const text=sel=>js('document.querySelector('+JSON.stringify(sel)+')?.textContent ?? null');
 const click=sel=>js('(()=>{const el=document.querySelector('+JSON.stringify(sel)+');if(!el)throw Error('+JSON.stringify('missing '+sel)+');el.click();return true})()');
 const clickText=t=>js('(()=>{const el=[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==='+JSON.stringify(t)+');if(!el)throw Error('+JSON.stringify('no button '+t)+');el.click();return true})()');
 const esc=()=>js('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
 const calls=m=>js('window.test.calls('+JSON.stringify(m)+')');
 const shot=async name=>{for(const theme of ['dark','light']){await js('window.test.theme('+JSON.stringify(theme)+')');await wait(700);fs.writeFileSync(${JSON.stringify(evidence)}+'/'+name+'-'+theme+'.png',(await wc.capturePage()).toPNG());}await js('window.test.theme("dark")');};
 try {
  await wc.loadFile(${JSON.stringify(path.join(out, "play-ai-bar.html"))});
  await until('the fixture', 'Boolean(window.test)');
  await js('window.test.bar(null)');
  await until('the bar', 'Boolean(document.querySelector("[data-play-viewer-bar]"))');
  check('no pill before the game says hello to its AI', !(await js('Boolean(document.querySelector("[data-play-ai-pill]"))')));

  // The pill names the model; it opens the chat's menu under it.
  await js('window.test.bar({})');
  await until('the pill', 'Boolean(document.querySelector("[data-play-ai-pill]"))');
  check('the pill names the model', (await js('document.querySelector("[data-play-ai-pill]").getAttribute("aria-label")'))==='AI: Claude Haiku 4.5');
  await click('[data-play-ai-pill]');
  await until('the menu', 'Boolean(document.querySelector("[data-play-ai-menu] [aria-checked]"))');
  const overlays=(await calls('playBar')).map(([hold])=>hold.overlay);
  check('the layer covers the window before the menu opens', overlays.includes('ai-menu'));
  const labels=await js('[...document.querySelectorAll("[data-play-ai-menu] .picker-label > span:first-child")].map(e=>e.textContent)');
  check('Genex, then makers, local models last', JSON.stringify(labels)===JSON.stringify(['Genex','Claude models','ChatGPT models','Local models']));
  check('the head says what the AI costs', (await text('[data-ai-usage]'))==='Uses your Claude plan · 8% of this 5-hour window');
  check('the model in use is checked', (await js('document.querySelector("[data-play-ai-menu] [aria-checked=true]").textContent')).includes('Claude Haiku 4.5'));
  check('struggling models fold under one row', (await text('[data-ai-struggling]'))==='2 more may struggle');
  check('Genex credits shows the balance', (await text('[data-ai-genex]')).includes('1,240'));
  await shot('menu');
  await click('[data-ai-model="plan-watcher:claude-code:claude-sonnet-4-5"]');
  await until('the pick', '(window.test.calls("gameAiPick").length===1)');
  check('a pick names the game and the model', JSON.stringify((await calls('gameAiPick'))[0])===JSON.stringify(['play:p-crowns',{door:'plan-watcher',engine:'claude-code',model:'claude-sonnet-4-5'}]));
  await until('the menu closes', '!document.querySelector("[data-play-ai-menu]")');

  // A first-use card drops from the pill; a yes in its first 600 ms does nothing.
  await js('window.test.notice({kind:"consent",consent:window.test.consent()})');
  await until('the card', 'Boolean(document.querySelector("[data-play-ai-card]"))');
  check('one sentence', (await text('.play-ai-card-line'))==='Crowns of 1444 will use Claude Haiku 4.5 on your Claude plan.');
  await clickText('Play');
  await wait(50);
  check('no answer inside the gate', (await calls('gameAiAnswer')).length===0);
  await shot('first-use');
  await wait(650);
  await clickText('Play');
  await until('the answer', '(window.test.calls("gameAiAnswer").length===1)');
  check('Play says yes with the card\\'s model', JSON.stringify((await calls('gameAiAnswer'))[0][0])===JSON.stringify({ticket:'ticket-0001',approve:true,model:null,unranked:false}));
  await until('the card goes', '!document.querySelector("[data-play-ai-card]")');

  // Set aside, a card waits on the pill; Change answers it with the model picked in the menu.
  await js('window.test.notice({kind:"consent",consent:window.test.consent({ticket:"ticket-0002",kind:"credits",model:window.test.models.CREDITS})})');
  await until('the credits card', 'Boolean(document.querySelector("[data-play-ai-card=credits]"))');
  await esc();
  await until('set aside', '!document.querySelector("[data-play-ai-card]")');
  await wait(200);
  check('a card set aside stays aside', !(await js('Boolean(document.querySelector("[data-play-ai-card]"))')));
  await js('window.test.bar({phase:"needs-you"})');
  await until('AI · Choose', 'document.querySelector("[data-play-ai-pill]").textContent.includes("AI · Choose")');
  await click('[data-play-ai-pill]');
  await until('the card again', 'Boolean(document.querySelector("[data-play-ai-card=credits]"))');
  await wait(650);
  await click('[data-ai-action=change]');
  await until('the menu for Change', 'Boolean(document.querySelector("[data-play-ai-menu] [aria-checked]"))');
  await click('[data-ai-model="local:ollama:qwen3:8b"]');
  await until('the answer with a model', '(window.test.calls("gameAiAnswer").length===2)');
  check('Change answers the card with the model picked', JSON.stringify((await calls('gameAiAnswer'))[1][0])===JSON.stringify({ticket:'ticket-0002',approve:true,model:{door:'local',engine:'ollama',model:'qwen3:8b'},unranked:false}));
  await until('menu and card gone', '!document.querySelector("[data-play-ai-menu]") && !document.querySelector("[data-play-ai-card]")');

  // A stop card, and Get credits from it.
  await js('window.test.bar({model:window.test.models.CREDITS,funding:"credits",balanceCredits:0,lowCredits:true})');
  await js('window.test.notice({kind:"stop",card:window.test.stop()})');
  await until('the stop card', 'Boolean(document.querySelector("[data-play-ai-card=out-of-credits]"))');
  check('the stop card\\'s words', (await text('.play-ai-card-small'))==='Keep going free with Qwen3 8B on this Mac, or get more credits.');
  await shot('out-of-credits');
  await wait(400);
  await click('[data-ai-action=get-credits]');
  await until('Get credits', 'Boolean(document.querySelector("[data-play-ai-credits] [data-ai-pack]"))');
  const packs=await js('[...document.querySelectorAll("[data-ai-pack]")].map(e=>[e.dataset.aiPack,e.getAttribute("aria-checked"),e.querySelector("small").textContent])');
  check('the four packs, smallest first, 2,500 picked, prices as checkout charges', JSON.stringify(packs)===JSON.stringify([['pack_500','false','$5.50'],['pack_1000','false','$11'],['pack_2500','true','$27.50'],['pack_5000','false','$55']]));
  await until('auto top-up', 'Boolean(document.querySelector("[data-ai-auto-top-up]"))');
  check('auto top-up is off, at most once a day', (await js('document.querySelector("[data-ai-auto-top-up]").getAttribute("aria-checked")'))==='false' && (await text('#play-ai-auto-top-up'))==='Add 1,000 when I’m under 100 · at most once a day');
  check('no fee in the copy', !(await js('document.body.innerText')).toLowerCase().includes('fee'));
  await shot('get-credits');
  await click('[data-ai-auto-top-up]');
  await until('the save', '(window.test.calls("gameAiSettingsSave").length===1)');
  check('the switch saves only auto top-up, with its defaults', JSON.stringify((await calls('gameAiSettingsSave'))[0][0])===JSON.stringify({autoTopUp:{on:true,underCredits:100,addCredits:1000}}));
  await click('[data-ai-buy]');
  await until('checkout', '(window.test.calls("gameAiCheckout").length===1)');
  check('Buy opens checkout for the picked pack', JSON.stringify((await calls('gameAiCheckout'))[0][0])===JSON.stringify({kind:'pack',packId:'pack_2500'}));
  await until('Get credits closes', '!document.querySelector("[data-play-ai-credits]")');
  check('the stop card does not come back once answered', !(await js('Boolean(document.querySelector("[data-play-ai-card]"))')));

  // The pill on credits, low.
  await js('window.test.bar({model:window.test.models.CREDITS,funding:"credits",balanceCredits:38,lowCredits:true})');
  await until('credits pill', 'document.querySelector("[data-play-ai-pill]").textContent.includes("38")');
  check('the low balance warns', await js('Boolean(document.querySelector("[data-play-ai-pill] [data-warn]"))'));
  await shot('pill-credits-low');

  // Report: what is sent, shown as text; a failed send says so and Try again sends it.
  await click('[data-play-ai-pill]');
  await until('the menu', 'Boolean(document.querySelector("[data-play-ai-menu] [aria-checked]"))');
  await clickText('Report what the AI wrote');
  await until('the report', 'Boolean(document.querySelector("[data-play-ai-report]"))');
  await click('[data-ai-see-sent]');
  await until('what is sent', 'Boolean(document.querySelector("[data-ai-report-preview]"))');
  check('the moments are listed', (await text('[data-ai-report-preview]')).includes('Will you join our alliance?'));
  check('hostile text stays text', (await text('[data-ai-report-preview]')).includes('<img src=x') && !(await js('Boolean(document.querySelector("[data-ai-report-preview] img"))')) && !(await js('window.test.pwned')));
  check('Send waits for a reason', await js('document.querySelector("[data-ai-report-send]").disabled'));
  await click('[data-ai-reason=harmful]');
  await shot('report');
  await click('[data-ai-report-send]');
  await until('the failure', 'document.querySelector("[data-play-ai-report] [role=alert]")?.textContent==="Couldn’t send your report"');
  check('Send becomes Try again', (await text('[data-ai-report-send]'))==='Try again');
  await shot('report-failed');
  await click('[data-ai-report-send]');
  await until('sent', '!document.querySelector("[data-play-ai-report]")');
  check('the report names the game and the reason', JSON.stringify((await calls('gameAiReport'))[1][0])===JSON.stringify({game:'play:p-crowns',reason:'harmful',note:null}));

  // The pill wears main's notes.
  await js('window.test.bar({note:"report-sent"})');
  await until('the note', 'document.querySelector("[data-play-ai-pill]").getAttribute("aria-label")==="Report sent"');
  check('a done note wears the check', (await js('document.querySelector("[data-play-ai-pill]").dataset.note'))==='done');
  await shot('note-report-sent');
  await js('window.test.bar({phase:"off",note:null})');
  await until('AI off', 'document.querySelector("[data-play-ai-pill]").getAttribute("aria-label")==="AI off"');
  await shot('pill-off');
  assert.deepEqual(report.errors,[]);
  console.log('PASS Play bar AI pill, menu, cards, Get credits and Report');
 } catch(error) { report.failure=error.stack; console.error(error); fs.writeFileSync(${JSON.stringify(evidence)}+'/failure.png',(await wc.capturePage()).toPNG()); }
 fs.writeFileSync(${JSON.stringify(path.join(evidence, "report.json"))},JSON.stringify(report,null,2));
 app.exit(report.failure?1:0);
});`,
);
try {
  const child = spawn(resolveElectron(), fixtureElectronArgs([boot]), { env: fixtureElectronEnv(), stdio: "inherit" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    if (code !== 0) process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
} finally {
  await rm(profile, { recursive: true, force: true });
}
console.log(evidence);
