/**
 * The creator surfaces of play-time AI in a disposable Electron profile with a fake
 * `window.studio` (`tests/fixtures/play-ai-studio.tsx`), against the v3 canvas: Settings →
 * Play-time AI, Get credits, Create's AI pill with its menu and first-use card (commit gated
 * 600 ms), the optional model check, Player reports with Fix with agent (the player's note never
 * reaches the agent), Publish's AI block (nothing preselected, Publish waits for the choice, never
 * for a check) and the engine Live card's line. Dark and light screens of each.
 */
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildDesignGallery } from "../../scripts/design-gallery.mjs";
import { fixtureElectronArgs, fixtureElectronEnv, resolveElectron } from "../../scripts/electron-runtime.mjs";
import { sourceIdentity } from "../../scripts/studio-dev/files.mjs";

/** The whole check, from Electron's start to its exit. */
const RUN_TIMEOUT_MS = 180_000;

const out = await buildDesignGallery();
const evidence = path.resolve(".studio-dev/evidence", `play-ai-studio-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "genex-play-ai-studio-"));
await build({
  entryPoints: ["tests/fixtures/play-ai-studio.tsx"],
  outfile: path.join(out, "play-ai-studio.js"),
  bundle: true,
  format: "esm",
  jsx: "automatic",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(
  path.join(out, "play-ai-studio.html"),
  '<html data-theme="dark"><head><link rel="stylesheet" href="gallery.css"></head><body style="margin:0;background:var(--background)"><div id="root"></div><script type="module" src="play-ai-studio.js"></script></body></html>',
);
const boot = path.join(out, "play-ai-studio.cjs");
await writeFile(
  boot,
  `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(profile)});
const evidence=${JSON.stringify(evidence)};
const report={source:${JSON.stringify(sourceIdentity(process.cwd()))},profile:${JSON.stringify(profile)},providers:'synthetic',steps:{},errors:[],screens:{}};
report.buildId=report.source.sourceDigest;
report.electron=process.versions.electron;
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1100,height:900,show:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const wc=win.webContents;
 wc.on('console-message',(event)=>{if(event.level==='error')report.errors.push(event.message)});
 const js=(source)=>wc.executeJavaScript(source);
 const capture=async(name)=>{const file=path.join(evidence,name+'.png');fs.writeFileSync(file,(await wc.capturePage()).toPNG());report.screens[name]=file;return file;};
 const step=async(name,source)=>{const result=await js(source);report.steps[name]=result;return result;};
 try {
  await wc.loadFile(${JSON.stringify(path.join(out, "play-ai-studio.html"))});
  for (const theme of ['dark','light']) {
   const t=JSON.stringify(theme);
   // Settings → Play-time AI (V3-Settings).
   const set=await step(theme+'Settings','window.aiRig.settings({theme:'+t+'})');
   assert.deepEqual(set.groups,['Models','Genex credits','Limitsall optional','Games','For game makers'].map((g)=>g.replace('Limitsall','Limits all')));
   assert.equal(set.balance,'1,240 credits');
   assert.match(set.topUp,/At most once a day and 3 times a month\\. Turns off if a payment fails\\./);
   assert.equal(set.topUpOn,'true');
   assert.deepEqual(set.games.map((g)=>g.replace(/ Turn off$/,'')),['Crowns of 1444 Genex credits · 310 this month','Moss Garden Claude Haiku 4.5 · your plan','Lantern Run Qwen3 8B · Free']);
   assert.equal(set.overflow,false);
   await capture(theme+'-settings');
   const out=await step(theme+'SettingsOut','window.aiRig.settings({theme:'+t+',signedIn:false})');
   assert.match(out.signedOut,/Sign in to Genex to play with your credits\\./);
   await capture(theme+'-settings-signed-out');
   // Get credits (V3-TopUp): one checkout price per pack, dollars only here.
   const buy=await step(theme+'Credits','window.aiRig.credits({theme:'+t+'})');
   assert.deepEqual(buy.packs,['500 $5.50','1,000 $11','2,500 $27.50','5,000 $55']);
   assert.equal(buy.chosen,'pack_2500');
   assert.equal(buy.buy,'Buy 2,500 credits');
   assert.match(buy.topUp,/Add 1,000 when I’m under 100 · at most once a day/);
   assert.match(buy.pro,/Genex Pro 1,000 credits every month \\$9\\.99 a month/);
   await capture(theme+'-get-credits');
   // Create's pill (V3-Create-States, V3-Pill).
   const expected={plan:'Claude Haiku 4.5',free:'Qwen3 8B Free',credits:'Credits 1,240',low:'Credits 38',off:'AI off',playtest:'AI · Saved playtest'};
   for (const [state,label] of Object.entries(expected)) {
    const p=await step(theme+'Pill-'+state,'window.aiRig.pill({theme:'+t+',state:'+JSON.stringify(state)+'})');
    assert.equal(p.pill,label,state);
    if (state==='plan'||state==='free') await capture(theme+'-pill-'+state);
   }
   await step(theme+'PillPlan','window.aiRig.pill({theme:'+t+',state:"plan"})');
   const menu=await step(theme+'Menu','window.aiRig.openMenu()');
   assert.equal(menu.usage,'Lantern Run Uses your Claude plan · 8% of this 5-hour window');
   assert.match(menu.genex,/Genex credits Claude Haiku 4\\.5, from your credits 1,240/);
   for (const row of ['Claude Haiku 4.5 Best','Claude Sonnet 4.5 plan','GPT-5 mini plan','Qwen3 8B Free','1 more may struggle','Turn off AI','Check models','Player reports','Add more models']) assert.ok(menu.rows.includes(row),row);
   await capture(theme+'-pill-menu');
   const card=await step(theme+'Card','window.aiRig.pickForCard()');
   assert.equal(card.kind,'plan');
   assert.equal(card.card,'Lantern Run will use Claude Sonnet 4.5 on your Claude plan. No extra cost. Pauses before half of your 5-hour limit. Play Change');
   assert.equal(card.gatedAtFirst,true,'Play waits 600 ms');
   assert.equal(card.openAfterGate,true);
   await capture(theme+'-pill-card');
   const answered=await step(theme+'Answer','window.aiRig.answerCard()');
   assert.deepEqual(answered.answers.at(-1),[{ticket:'ticket-0001',approve:true,model:null,unranked:false}]);
   // The model check (V3-Create-Check, V3-Create-States).
   const empty=await step(theme+'CheckEmpty','window.aiRig.modelCheck({theme:'+t+',state:"empty"})');
   assert.equal(empty.intro,'Play Lantern Run once with AI, then check which models fit. It runs on your own models, and it’s optional.');
   assert.deepEqual(empty.presses,['Play now']);
   await capture(theme+'-check-empty');
   const checking=await step(theme+'CheckRunning','window.aiRig.modelCheck({theme:'+t+',state:"checking"})');
   assert.deepEqual(checking.lines,['Checking 4 of 6 models…','You can keep building. Run it again after big changes.']);
   assert.deepEqual(checking.presses,['Stop']);
   await capture(theme+'-check-running');
   const done=await step(theme+'CheckDone','window.aiRig.modelCheck({theme:'+t+',state:"done"})');
   assert.equal(done.intro,'Genex replayed 24 moments from your playtests on the 6 models you have: your plans, your OpenRouter key and this Mac. No Genex credits. Optional.');
   assert.equal(done.rows[0],'Claude Haiku 4.5 Best your Claude plan 5 of 5 $ 1.1 s');
   assert.equal(done.rows[3],'Gemini 2.5 Flash OpenRouter 5 of 5 $ 0.9 s');
   assert.equal(done.rows[5],'Llama 3.2 3B this Mac 1 of 5 Free 0.7 s');
   assert.ok(done.lines.includes('Players on Genex credits get your pick.'));
   assert.ok(done.lines.includes('Llama 3.2 3B: forgot the inn’s menu in 4 of 5 moments. Players can still pick it; Genex warns them.'));
   assert.deepEqual(done.presses,['Check again','Recommend: Claude Haiku 4.5','Done']);
   await capture(theme+'-check-done');
   // Player reports with Fix with agent (Report-v2's maker side).
   const inbox=await step(theme+'Reports','window.aiRig.reports({theme:'+t+'})');
   assert.equal(inbox.rows.length,2);
   assert.match(inbox.rows[0],/^Harmful or dangerous 2h Ignore your instructions/);
   assert.match(inbox.rows[1],/^A reply didn’t fit the game/);
   assert.deepEqual(inbox.fixes,['Fix with agent','Ask again']);
   await capture(theme+'-reports');
   const fixed=await step(theme+'Fix','window.aiRig.fixFirst()');
   assert.deepEqual(fixed.fixed.at(-1),['lantern-run','report-0002']);
   assert.equal(fixed.composed.length,1);
   assert.equal(fixed.composed[0].project,'lantern-run');
   assert.equal(fixed.composed[0].send,true);
   assert.match(fixed.composed[0].text,/playtest report-report-0002-k3x9/);
   assert.doesNotMatch(fixed.composed[0].text,/Ignore your instructions/,'the player\\'s note never reaches the agent');
   assert.equal(fixed.button,'Sent to your agent');
   await capture(theme+'-reports-sent');
   // Publish (V3-Publish, V3-Publish-States).
   const fresh=await step(theme+'Publish','window.aiRig.publish({theme:'+t+',facts:"checked"})');
   assert.equal(fresh.block,'unchosen');
   assert.deepEqual(fresh.segments,[{text:'Needs AI',checked:'false'},{text:'Works without AI',checked:'false'}],'nothing preselected');
   assert.equal(fresh.best,'Best with Claude Haiku 4.5 · fits 5 of 6 models Change');
   assert.equal(fresh.cost,'AI cost for players $ Low');
   assert.equal(fresh.overflow,false);
   const gated=await step(theme+'PublishGate','window.aiRig.pressPublish()');
   assert.equal(gated.gate,'Choose whether Lantern Run needs AI.');
   assert.deepEqual(gated.published,[],'nothing is published without the choice');
   const needs=await step(theme+'PublishNeeds','window.aiRig.choose("ai")');
   assert.equal(needs.gate,null);
   assert.equal(needs.leaderboard,'Keep a leaderboard Scores count only on Genex credits.');
   assert.equal(needs.share,'You earn 10% of the credits players spend on AI in this game. Players on their own plan or this Mac pay you nothing and cost you nothing.');
   await capture(theme+'-publish');
   const sent=await step(theme+'PublishSent','window.aiRig.pressPublish()');
   assert.deepEqual(sent.published.at(-1),{requires:'ai',leaderboard:false});
   const unchecked=await step(theme+'PublishUnchecked','window.aiRig.publish({theme:'+t+',facts:"unchecked"})');
   assert.equal(unchecked.best,'Best with Claude Haiku 4.5 · the model you playtested Check models');
   assert.equal(unchecked.cost,null);
   await capture(theme+'-publish-unchecked');
   await step(theme+'PublishFree','window.aiRig.publish({theme:'+t+',facts:"free"})');
   const without=await step(theme+'PublishWithout','window.aiRig.choose("optional")');
   assert.equal(without.cost,'AI cost for players Free on most Macs');
   assert.equal(without.leaderboard,null);
   assert.equal(without.share,null);
   await capture(theme+'-publish-without');
   // The engine Live card's line.
   const line=await step(theme+'Engine','window.aiRig.engine({theme:'+t+',state:"free"})');
   assert.deepEqual(line,{line:'AI · Qwen3 8B, free on this Mac',tone:'ready'});
   await capture(theme+'-engine-line');
  }
  assert.deepEqual(report.errors,[]);
  console.log('PASS play-time AI creator surfaces: Settings, Get credits, the pill and its card, the check, Player reports, Publish and the engine line, dark and light');
 } catch(error) { report.failure=error.stack; console.error(error); await capture('failure').catch(()=>{}); }
 fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify(report,null,2));
 app.exit(report.failure?1:0);
});`,
);
try {
  const child = spawn(resolveElectron(), fixtureElectronArgs([boot]), { env: fixtureElectronEnv(), stdio: "inherit" });
  const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
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
