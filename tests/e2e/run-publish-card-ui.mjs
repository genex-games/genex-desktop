/**
 * The Publish card of a game made in an engine, in a disposable Electron profile with a fake
 * `window.studio`: skeleton rows and no button until the game folder has answered. No row has a
 * switch: each ends in its own control, and one big button does everything. An Unreal game on a Mac
 * opens with "Build on Mac" and "Build on Genex Cloud" in its rows and "Publish to all platforms"
 * under them, with one line saying what it builds first; a row's own Build only builds (the agent
 * here, Genex Cloud for Windows, which keeps what it builds) and gives players nothing; a pressed
 * big button keeps its words, its fill and its label's colour while the press is sent, then turns
 * into the status "Publishing to all platforms · N of M live" while each platform goes to players
 * as soon as it is ready: the Mac app once the agent built it (its row says how much went, how fast
 * and how long is left), the Windows one once Genex Cloud built it. On a PC a second app waits its
 * turn ("Builds after Windows", "Queued"), and the press goes on with the window closed. A web
 * publish that goes live celebrates in the banner with the rows still under it. A row players have
 * ends in a menu whose one item takes the platform down. A live game whose apps are older builds
 * them again and updates them; built ones say "Update". A failed Genex Cloud build has its error
 * block (the log goes to the agent, never on screen) and "Try again" in its row, and leaves the
 * other platforms free; a build that didn't start and a send that failed are tried again from
 * their rows; a Unity game lists its four platforms. No row says "Public:", and no Share assets
 * line shows. Dark screens, and the main ones in light.
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
const RUN_TIMEOUT_MS = 120_000;

const out = await buildDesignGallery();
const evidence = path.resolve(".studio-dev/evidence", `publish-card-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "genex-publish-card-"));
await build({
  entryPoints: ["tests/fixtures/publish-card.tsx"],
  outfile: path.join(out, "publish-card.js"),
  bundle: true,
  format: "esm",
  jsx: "automatic",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(
  path.join(out, "publish-card.html"),
  '<html data-theme="dark"><head><link rel="stylesheet" href="gallery.css"></head><body style="margin:0;background:var(--background)"><div id="root" style="display:flex;width:100vw;height:100vh"></div><script type="module" src="publish-card.js"></script></body></html>',
);
const boot = path.join(out, "publish-card.cjs");
await writeFile(
  boot,
  `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(profile)});
const evidence=${JSON.stringify(evidence)};
const report={source:${JSON.stringify(sourceIdentity(process.cwd()))},profile:${JSON.stringify(profile)},providers:'synthetic',steps:{},errors:[]};
report.buildId=report.source.sourceDigest;
report.electron=process.versions.electron;
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1100,height:1000,show:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false,zoomFactor:1}});
 const wc=win.webContents;
 wc.on('console-message',(event)=>{if(event.level==='error')report.errors.push(event.message)});
 const js=(source)=>wc.executeJavaScript(source);
 const capture=async(name)=>{const file=path.join(evidence,name+'.png');fs.writeFileSync(file,(await wc.capturePage()).toPNG());return file;};
 const step=async(name,source)=>{const result=await js(source);report.steps[name]=result;return result;};
 // Each row as read: its name, status line, end note, then its button's words, "Queued", or 'busy' for its loader.
 const rows=(seen)=>seen.rows.map((row)=>[row.name,row.status,row.side,row.act??row.queued??(row.busy?'busy':null)]);
 const clean=(name,seen)=>{
  assert.equal(seen.overflow,false,name+': nothing runs past the card');
  assert.equal(seen.rows.some((row)=>row.switch),false,name+': no row has a switch');
  assert.ok(seen.noteLines<=1,name+': the line under the button keeps to one line');
  assert.doesNotMatch(seen.text,/Public:/,name+': no "Public:" word');
  assert.equal(seen.share,false,name+': no Share assets line');
  assert.doesNotMatch(seen.text,/Only Mac players/,name);
 };
 try {
  await wc.loadFile(${JSON.stringify(path.join(out, "publish-card.html"))});
  // While the folder is read: skeleton rows, no status, no button.
  const loading=await step('loading','window.cardRig.open({scene:"loading"})');
  assert.equal(loading.loading,true);
  assert.equal(loading.primary,null,'no button before the folder has answered');
  report.loading=await capture('dark-0-loading');
  const answered=await step('answered','window.cardRig.answer()');
  assert.equal(answered.loading,false);
  const ALL='Publish to all platforms';
  const GOES='Each one goes live as soon as it’s ready. You can close this window.';
  const NOT_BUILT=[['Mac','Not built',null,'Build on Mac'],['Windows','Not built',null,'Build on Genex Cloud']];
  for (const theme of ['dark','light']) {
   // Nothing built yet: each row has its own Build, and one button does everything.
   const first=await step(theme+'First','window.cardRig.open({scene:"first",theme:"'+theme+'"})');
   assert.deepEqual(rows(first),NOT_BUILT);
   assert.deepEqual([first.primary,first.following],[ALL,false]);
   assert.equal(first.note,'Builds Mac and Windows first. Windows can take up to an hour.');
   clean('first',first);
   report[theme+'First']=await capture(theme+'-b1-nothing-built');
  }
  // While a press is being sent the blue button keeps its words, its fill and its label's colour.
  for (const theme of ['light','dark']) {
   const ready=await step(theme+'SendingOpen','window.cardRig.open({scene:"first",theme:"'+theme+'"})');
   const sending=await step(theme+'Sending','window.cardRig.hold()');
   assert.equal(sending.primary,ALL,'a pressed button keeps its words');
   assert.equal(sending.primaryDisabled,true,'and takes no second press');
   assert.deepEqual([sending.primaryInk,sending.primaryFill],[ready.primaryInk,ready.primaryFill],theme+': a pressed button keeps its label colour and its fill');
   report[theme+'Sending']=await capture(theme+'-press-being-sent');
   await step(theme+'Sent','window.cardRig.goThrough()');
  }
  // A row's own Build only builds: Genex Cloud keeps the Windows app, the agent makes the Mac one, players get nothing.
  await step('rowBuildOpen','window.cardRig.open({scene:"first"})');
  const cloudOnly=await step('rowBuildWindows','window.cardRig.act("windows")');
  assert.deepEqual(cloudOnly.asked,['cloud:windows:keep']);
  assert.equal(cloudOnly.composed.length,0,'the agent builds nothing for it');
  assert.deepEqual(rows(cloudOnly),[NOT_BUILT[0],['Windows','Sending to Genex Cloud',null,'busy']]);
  assert.match(cloudOnly.rows[1].busy??'',/^Building/);
  assert.deepEqual([cloudOnly.primary,cloudOnly.following],[ALL,false],'the big button is still a press');
  clean('rowBuildWindows',cloudOnly);
  const onCloud=await step('rowBuildOnCloud','window.cardRig.cloudStarts()');
  assert.deepEqual(rows(onCloud)[1],['Windows','On Genex Cloud',null,'busy']);
  assert.match(onCloud.rows[1].busy??'',/^Building\\d/,'the loader has its clock');
  const macToo=await step('rowBuildMac','window.cardRig.act("mac")');
  assert.equal(macToo.composed.length,1,'the agent is asked once');
  assert.match(macToo.composed[0].text,/Mac app of genex-strike/);
  assert.deepEqual(rows(macToo)[0],['Mac','On this Mac',null,'busy']);
  report.rowBuilds=await capture('dark-c1-rows-build');
  const kept=await step('rowBuildKept','window.cardRig.cloudEnds()');
  assert.deepEqual(rows(kept)[1],['Windows','Ready to publish','2.9 GB','Publish'],'built and kept: its own Publish');
  assert.deepEqual(kept.asked,['cloud:windows:keep'],'nothing went to players');
  // The big button does everything: it builds both, then gives players each one as soon as it is ready.
  await step('allOpen','window.cardRig.open({scene:"first"})');
  const all=await step('allPress','window.cardRig.press()');
  assert.equal(all.composed.length,1,'the agent is asked once');
  assert.match(all.composed[0].text,/Mac app of genex-strike/);
  assert.deepEqual(all.asked,['cloud:windows:keep'],'Genex Cloud builds and keeps: nothing goes to players yet');
  assert.deepEqual(rows(all),[['Mac','On this Mac',null,'busy'],['Windows','Sending to Genex Cloud',null,'busy']]);
  assert.deepEqual([all.primary,all.following,all.note],['Publishing to all platforms · 0 of 2 live',true,GOES]);
  assert.equal(all.primaryDisabled,true,'the status takes no press');
  clean('allPress',all);
  await step('allOnCloud','window.cardRig.cloudStarts()');
  report.allBuilding=await capture('dark-b2-both-building');
  await step('allMacLands','window.cardRig.land("mac")');
  const macGoes=await step('allMacGoes','window.cardRig.wait((seen)=>seen.asked.includes("apps:mac")&&Boolean(seen.rows[0]?.bar),900)');
  assert.deepEqual(macGoes.asked,['cloud:windows:keep','apps:mac','release:windows'],'the Mac app goes by itself, and the Windows one is promised');
  assert.match(macGoes.rows[0].status,/of 3\\.2 GB · 16 MB\\/s$/,'the row says how much went and how fast');
  assert.match(macGoes.rows[0].busy??'',/^Publishing\\d+m left$/,'and its loader how long is left');
  assert.equal(macGoes.following,true);
  clean('allMacGoes',macGoes);
  report.allMacGoes=await capture('dark-b3-mac-goes');
  const macLive=await step('allMacLive','window.cardRig.arrive()');
  assert.deepEqual(rows(macLive)[0].slice(0,2),['Mac','Live · up to date']);
  assert.equal(macLive.rows[0].menu,true,'a row players have ends in its menu');
  assert.deepEqual([macLive.primary,macLive.following],['Publishing to all platforms · 1 of 2 live',true]);
  report.allMacLive=await capture('dark-b4-mac-live');
  await step('allCloudEnds','window.cardRig.cloudEnds()');
  const allLive=await step('allLive','window.cardRig.wait((seen)=>seen.primary===null,900)');
  assert.deepEqual(rows(allLive).map((one)=>one.slice(0,2)),[['Mac','Live · up to date'],['Windows','Live · up to date']]);
  assert.equal(allLive.primary,null,'all live: nothing to press');
  clean('allLive',allLive);
  report.allLive=await capture('dark-b5-both-live');
  // On a PC: the web version goes now, the agent builds one app at a time, and the press goes on with the window closed.
  for (const theme of ['dark','light']) {
   const pcWeb=await step(theme+'PcWeb','window.cardRig.open({scene:"pcWeb",theme:"'+theme+'"})');
   assert.deepEqual(rows(pcWeb),[['Web','Ready to publish',null,'Publish'],['Windows','Not built',null,'Build on PC'],['Linux','Not built',null,'Build on PC']]);
   assert.deepEqual([pcWeb.primary,pcWeb.note],[ALL,'Publishes Web now, Windows and Linux once they are built.']);
   clean('pcWeb',pcWeb);
   report[theme+'PcWeb']=await capture(theme+'-a1-opens');
  }
  // The web row's own Publish: its row says the send, and going live celebrates in the banner over the rows.
  const webGoes=await step('pcWebRow','window.cardRig.act("web")');
  assert.deepEqual(webGoes.asked.filter((one)=>!one.startsWith('review:')),['web:']);
  assert.match(webGoes.rows[0].status,/of 1\\.5 GB · 16 MB\\/s$/);
  assert.match(webGoes.rows[0].busy??'',/^Publishing/);
  assert.deepEqual([webGoes.primary,webGoes.note],[ALL,'Builds Windows and Linux, then publishes them by itself.']);
  clean('pcWebRow',webGoes);
  report.webGoes=await capture('dark-a2-web-pressed');
  const webLive=await step('pcWebLive','window.cardRig.arrive()');
  assert.equal(webLive.celebrating,true,'the banner says it is live');
  assert.deepEqual(rows(webLive),[['Web','Live · up to date','just now',null],['Windows','Not built',null,'Build on PC'],['Linux','Not built',null,'Build on PC']],'and the rows stay under it');
  assert.deepEqual([webLive.primary,webLive.following],[ALL,false]);
  clean('pcWebLive',webLive);
  report.webLive=await capture('dark-a3-web-live');
  const pcAll=await step('pcAllPress','window.cardRig.press()');
  assert.equal(pcAll.composed.length,1,'one message asks the agent for both apps');
  assert.match(pcAll.composed[0].text,/Windows app of genex-strike[\\s\\S]*Linux app of genex-strike/);
  assert.deepEqual(rows(pcAll).slice(1),[['Windows','On this PC',null,'busy'],['Linux','Builds after Windows',null,'Queued']],'a computer builds one app at a time');
  assert.deepEqual([pcAll.primary,pcAll.following,pcAll.note],['Publishing to all platforms · 1 of 3 live',true,GOES]);
  clean('pcAllPress',pcAll);
  report.pcAll=await capture('dark-a4-all-pressed');
  await step('pcClose','window.cardRig.close()');
  await step('pcWindowsLands','window.cardRig.land("windows")');
  const closed=await step('pcClosedSend','window.cardRig.wait((seen)=>seen.asked.includes("apps:windows"),1500)');
  assert.ok(closed.asked.includes('apps:windows'),'the Windows app goes to players with the window closed');
  const reopened=await step('pcReopen','window.cardRig.show()');
  assert.match(reopened.rows[1].busy??'',/^Publishing/);
  assert.deepEqual(rows(reopened)[2],['Linux','On this PC',null,'busy'],'the next app is being built');
  assert.equal(reopened.following,true,'the opened window shows the press still under way');
  clean('pcReopen',reopened);
  report.pcReopened=await capture('dark-a5-windows-goes');
  await step('pcWindowsLive','window.cardRig.arrive()');
  await step('pcLinuxLands','window.cardRig.land("linux")');
  await step('pcLinuxGoes','window.cardRig.wait((seen)=>seen.asked.includes("apps:linux"),900)');
  await step('pcLinuxLive','window.cardRig.arrive()');
  const pcDone=await step('pcDone','window.cardRig.wait((seen)=>seen.primary===null,900)');
  assert.deepEqual(rows(pcDone).map((one)=>one.slice(0,2)),[['Web','Live · up to date'],['Windows','Live · up to date'],['Linux','Live · up to date']]);
  assert.equal(pcDone.primary,null);
  clean('pcDone',pcDone);
  // Done: nothing to press, and each row's menu takes its platform down.
  const done=await step('done','window.cardRig.open({scene:"done"})');
  assert.deepEqual(rows(done).map((one)=>one.slice(0,2)),[['Mac','Live · up to date'],['Windows','Live · up to date']]);
  assert.deepEqual(done.rows.map((row)=>row.menu),[true,true]);
  assert.equal(done.primary,null);
  clean('done',done);
  report.done=await capture('dark-a6-done');
  const menu=await step('menu','window.cardRig.menu("windows")');
  assert.deepEqual(menu.menuItems,['Take Windows down']);
  report.takeDown=await capture('dark-d3-take-down');
  const down=await step('down','window.cardRig.takeDown()');
  assert.deepEqual(down.asked.filter((one)=>!one.startsWith('review:')),['publish-remove-app:windows']);
  for (const theme of ['dark','light']) {
   // The Mac app is built while Genex Cloud still builds: the button gives players one now, the other once built.
   const macBuilt=await step(theme+'MacBuilt','window.cardRig.open({scene:"macBuilt",theme:"'+theme+'"})');
   assert.deepEqual(rows(macBuilt),[['Mac','Ready to publish','3.2 GB','Publish'],['Windows','On Genex Cloud',null,'busy']]);
   assert.match(macBuilt.rows[1].busy??'',/^Building\\d/,'the loader has its clock');
   assert.deepEqual([macBuilt.primary,macBuilt.note],[ALL,'Publishes Mac now, Windows once it is built.']);
   clean('macBuilt',macBuilt);
   report[theme+'MacBuilt']=await capture(theme+'-c2-mac-built');
  }
  const published=await step('publishBoth','window.cardRig.press()');
  assert.deepEqual(published.asked,['apps:mac','release:windows'],'the Mac app goes, and the Windows one once it is built');
  // Both built: the button sends both with no line under it, and a row's own Publish sends only its app.
  const bothBuilt=await step('bothBuilt','window.cardRig.open({scene:"bothBuilt"})');
  assert.deepEqual(rows(bothBuilt),[['Mac','Ready to publish','3.2 GB','Publish'],['Windows','Ready to publish','2.9 GB','Publish']]);
  assert.deepEqual([bothBuilt.primary,bothBuilt.note],[ALL,null]);
  clean('bothBuilt',bothBuilt);
  report.bothBuilt=await capture('dark-both-built');
  const sentMac=await step('publishMac','window.cardRig.act("mac")');
  assert.deepEqual(sentMac.asked,['apps:mac'],'the Windows app stays built');
  // Only the Windows app is built: its own Publish gives players what Genex Cloud keeps.
  const windowsBuilt=await step('windowsBuilt','window.cardRig.open({scene:"windowsBuilt"})');
  assert.deepEqual(rows(windowsBuilt),[['Mac','Not built',null,'Build on Mac'],['Windows','Ready to publish','2.9 GB','Publish']]);
  assert.deepEqual([windowsBuilt.primary,windowsBuilt.note],[ALL,'Publishes Windows now, Mac once it is built.']);
  const sentWindows=await step('publishWindows','window.cardRig.act("windows")');
  assert.deepEqual(sentWindows.asked,['apps:','release:windows']);
  for (const theme of ['dark','light']) {
   // A live game that changed: each row builds its app again, keeps its menu, and one button updates all.
   const old=await step(theme+'Old','window.cardRig.open({scene:"old",theme:"'+theme+'"})');
   assert.deepEqual(rows(old),[
    ['Mac','Live · older than your game',null,'Build on Mac'],
    ['Windows','Live · older than your game',null,'Build on Genex Cloud'],
   ]);
   assert.deepEqual(old.rows.map((row)=>row.menu),[true,true]);
   assert.deepEqual([old.primary,old.note],['Update all platforms','Builds Mac and Windows again, then updates them by itself.']);
   clean('old',old);
   report[theme+'Old']=await capture(theme+'-c3-game-changed');
  }
  const rebuild=await step('rebuildMac','window.cardRig.act("mac")');
  assert.equal(rebuild.composed.length,1,'the agent is asked once');
  assert.match(rebuild.composed[0].text,/Build the Mac app of genex-strike again/);
  assert.deepEqual(rebuild.asked,[],'building sends nothing to players');
  assert.deepEqual(rows(rebuild)[0],['Mac','On this Mac',null,'busy']);
  // The Mac app lands and the agent's turn ends: the open card sees it, with no reopening.
  const landed=await step('landed','window.cardRig.land()');
  assert.deepEqual(rows(landed)[0],['Mac','Live · update ready','3.2 GB','Update'],'the card follows the folder');
  assert.deepEqual(landed.asked,[],'players keep the older one until Update');
  assert.deepEqual([landed.primary,landed.note],['Update all platforms','Updates Mac now, Windows once it is built.']);
  // Both newer apps are built: players keep the older ones until Update.
  const ready=await step('updateReady','window.cardRig.open({scene:"updateReady"})');
  assert.deepEqual(rows(ready),[['Mac','Live · update ready','3.2 GB','Update'],['Windows','Live · update ready','2.9 GB','Update']]);
  assert.deepEqual([ready.primary,ready.note],['Update all platforms',null]);
  clean('updateReady',ready);
  report.updateReady=await capture('dark-c4-update-ready');
  const updated=await step('updated','window.cardRig.press()');
  assert.deepEqual(updated.asked,['apps:mac','release:windows']);
  assert.match(updated.rows[0].busy??'',/^Updating/);
  assert.deepEqual([updated.following,updated.note],[true,GOES]);
  assert.match(updated.primary??'',/^Updating all platforms · \\d of 2 updated$/);
  report.updating=await capture('dark-c4-updating');
  // A build that publishes itself (one an older Genex started): its row says so, and nothing is left to press.
  const building=await step('building','window.cardRig.open({scene:"building"})');
  assert.deepEqual(rows(building)[1],['Windows','On Genex Cloud',null,'busy']);
  assert.equal(building.primary,null);
  clean('building',building);
  // A failed Genex Cloud build of the game as it is: the older app stays live, its row tries again, and a
  // block under the rows names it, never its log, with Send to agent and Copy; the big button has nothing to do.
  const failed=await step('failed','window.cardRig.open({scene:"failed"})');
  assert.deepEqual(rows(failed)[1],['Windows','Couldn’t build · the older one is still live',null,'Try again']);
  assert.deepEqual(failed.blocks.map((one)=>[one.target,one.text,one.send,one.copy]),[['windows','Windows build error'+'Send to agent',true,true]]);
  assert.doesNotMatch(failed.text,/FVector|C2065/,'the log never shows');
  assert.equal(failed.primary,null,'the error is not the big button');
  clean('failed',failed);
  report.failed=await capture('dark-c5-failed');
  // The same before the first publish: the Mac app never waits for Windows.
  const failedFirst=await step('failedFirst','window.cardRig.open({scene:"failedFirst"})');
  assert.deepEqual(rows(failedFirst),[['Mac','Ready to publish','3.2 GB','Publish'],['Windows','Couldn’t build',null,'Try again']]);
  assert.deepEqual(failedFirst.blocks.map((one)=>[one.target,one.send,one.copy]),[['windows',true,true]]);
  assert.deepEqual([failedFirst.primary,failedFirst.note],[ALL,null]);
  clean('failedFirst',failedFirst);
  report.failedFirst=await capture('dark-build-failed');
  const sentFix=await step('sendFix','window.cardRig.block("send")');
  assert.match(sentFix.composed[0]?.text??'',/FVector/,'the agent gets the whole log');
  assert.deepEqual(sentFix.blocks.map((one)=>[one.sent,one.send]),[[true,false]],'the block says the agent is on it');
  assert.match(sentFix.blocks[0].text,/^Agent is fixing the Windows build/);
  report.sentFix=await capture('dark-agent-fixing');
  // A build that didn't start: the row says so and tries again, a block copies why.
  await step('startFails','window.cardRig.open({scene:"startFails"})');
  const refused=await step('startFailsPress','window.cardRig.act("windows")');
  assert.deepEqual(rows(refused),[NOT_BUILT[0],['Windows','Couldn’t send',null,'Try again']]);
  assert.deepEqual(refused.blocks.map((one)=>[one.target,one.text,one.copy]),[['windows','Windows build didn’t start',true]]);
  assert.doesNotMatch(refused.text,/this month/,'the words of the CLI never show');
  clean('startFails',refused);
  report.startFails=await capture('dark-build-did-not-start');
  const again=await step('startAgain','window.cardRig.act("windows")');
  assert.deepEqual(again.asked,['cloud:windows:keep','cloud:windows:keep'],'Try again starts the build again');
  // A send that didn't reach Genex: its row tries it again, the big button stays out of it.
  const unsent=await step('sendFailed','window.cardRig.open({scene:"sendFailed"})');
  assert.deepEqual(rows(unsent)[0],['Mac','Couldn’t send',null,'Try again']);
  assert.deepEqual(unsent.blocks.map((one)=>[one.target,one.copy]),[['mac',true]]);
  assert.doesNotMatch(unsent.text,/HTTP 413/,'the words of the CLI never show');
  assert.equal(unsent.primary,null);
  report.sendFailed=await capture('dark-send-failed');
  const retried=await step('retry','window.cardRig.act("mac")');
  assert.deepEqual(retried.asked,['apps:mac'],'Try again sends that app again');
  // The same game on a PC with no web build: both apps are built there.
  const pc=await step('pc','window.cardRig.open({scene:"pc"})');
  assert.deepEqual(rows(pc),[['Windows','Not built',null,'Build on PC'],['Linux','Not built',null,'Build on PC']]);
  assert.deepEqual([pc.primary,pc.note],[ALL,'Builds Windows and Linux, then publishes them by itself.']);
  clean('pc',pc);
  report.pc=await capture('dark-pc-opens');
  // A Unity game with all four platforms.
  for (const theme of ['dark','light']) {
   const unity=await step(theme+'Unity','window.cardRig.open({scene:"unity",theme:"'+theme+'"})');
   assert.deepEqual(rows(unity).map((one)=>[one[0],one[1],one[3]]),[
    ['Web','Live · up to date',null],
    ['Mac','Live · up to date',null],
    ['Windows','Ready to publish','Publish'],
    ['Linux','Not built','Build on Mac'],
   ]);
   assert.deepEqual([unity.primary,unity.note],[ALL,'Publishes Windows now, Linux once it is built.']);
   clean('unity',unity);
   report[theme+'Unity']=await capture(theme+'-d1-unity');
  }
  assert.deepEqual(report.errors,[]);
  console.log('PASS Publish card: skeleton rows before the folder answers; no switches, each row ends in its own control; a row\\'s Build only builds; one big button builds what is not built and gives players each platform as soon as it is ready, as a status with the count while it goes, also with the window closed; a send says how much, how fast and how long is left in its row; a second app on one computer waits its turn; a web publish celebrates in the banner over the rows; a pressed button keeps its words, fill and label colour while the press is sent; the menu of a live row takes it down; older apps build again, then update; a failed cloud build leaves the others free and its block hands the log to the agent, never showing it; a build that did not start and a failed send are tried again from their rows; a PC builds its apps there; a Unity game lists four platforms; no "Public:", no Share assets');
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
