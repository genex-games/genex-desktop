/**
 * The Publish dialog of a game with apps, in a disposable Electron profile with a fake `window.studio`:
 * what the Publish card hands to Genex (only the apps it names; a web version still on Genex taken off
 * once confirmed; a web build that takes a page of apps only with consent), the rows of an app Genex
 * reviews or turned down, and Genex's review card of each app and takedown state. A web game with no app
 * shows no rows. The card's own rows, switches and button are run-publish-card-ui's. Dark and light screens.
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
const evidence = path.resolve(".studio-dev/evidence", `publish-platforms-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "genex-publish-platforms-"));
await build({
  entryPoints: ["tests/fixtures/publish-platforms.tsx"],
  outfile: path.join(out, "publish-platforms.js"),
  bundle: true,
  format: "esm",
  jsx: "automatic",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(
  path.join(out, "publish-platforms.html"),
  '<html data-theme="dark"><head><link rel="stylesheet" href="gallery.css"></head><body style="margin:0;background:var(--background)"><div id="root" style="display:flex;width:100vw;height:100vh"></div><script type="module" src="publish-platforms.js"></script></body></html>',
);
const boot = path.join(out, "publish-platforms.cjs");
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
 const win=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const wc=win.webContents;
 wc.on('console-message',(event)=>{if(event.level==='error')report.errors.push(event.message)});
 const js=(source)=>wc.executeJavaScript(source);
 const capture=async(name)=>{const file=path.join(evidence,name+'.png');fs.writeFileSync(file,(await wc.capturePage()).toPNG());return file;};
 const step=async(name,source)=>{const result=await js(source);report.steps[name]=result;return result;};
 try {
  await wc.loadFile(${JSON.stringify(path.join(out, "publish-platforms.html"))});
  // A game made in an engine gets the Publish card (its rows, switches and button are run-publish-card-ui's):
  // here, what the card hands to Genex. A game with only a Mac app publishes it alone, never a web copy.
  const card=(seen,target)=>seen.rows.find((one)=>one.target===target);
  const only=await step('appsOnly','window.platformsRig.open({scene:"appsOnly"})');
  assert.equal(only.listed,true);
  assert.deepEqual([card(only,'mac').name,card(only,'mac').status],['Mac','Not published']);
  assert.equal(only.primary,'Publish to Mac');
  report.appsOnly=await capture('dark-apps-only');
  const pressed=await step('appsOnlyPress','window.platformsRig.press()');
  assert.deepEqual(pressed.published,[{via:'apps',title:'Dust Runners',platforms:['mac']}],'the apps go, never a web copy');
  // Genex reviews an app sent by someone other than an admin, and may turn it down: the row says so.
  const review=await step('appsReview','window.platformsRig.open({scene:"appsReview"})');
  assert.equal(card(review,'mac').status,'In review');
  assert.equal(review.primary,null,'the same app sent again would change nothing');
  assert.equal(review.overflow,false);
  report.appsReview=await capture('dark-apps-review');
  const rejected=await step('appsRejected','window.platformsRig.open({scene:"appsRejected"})');
  assert.equal(card(rejected,'mac').status,'Not approved');
  assert.deepEqual(rejected.failures,['Genex didn’t approve the Mac app: It opens a shell.']);
  // Flipped on purpose (Publish card): the very build Genex turned down is not offered again; a newer one is.
  assert.equal(rejected.primary,null,'the same turned-down build would be turned down again');
  report.appsRejected=await capture('dark-apps-rejected');
  // An Unreal game whose page plays a web version it no longer has: switching the web row off takes it off.
  const stuck=await step('unrealWebOnGenex','window.platformsRig.open({scene:"unrealWebOnGenex"})');
  assert.deepEqual([card(stuck,'web').status,card(stuck,'web').tone],['Live · up to date','live']);
  const off=await step('webOff','window.platformsRig.toggle("web")');
  assert.equal(off.primary,'Take web down');
  report.unrealWebOnGenex=await capture('dark-unreal-web-on-genex');
  const removed=await step('removeWeb','window.platformsRig.press()');
  assert.deepEqual(removed.actions,['review:publish-remove-web','publish-remove-web'],'it is confirmed before the plugin action runs');
  // A Unity game whose page shows its apps: a web build takes that page only with their consent.
  const replaces=await step('unityReplacesApps','window.platformsRig.open({scene:"unityReplacesApps"})');
  assert.equal(replaces.replaces,'Publish makes this web version the game’s page, in place of its apps.');
  report.unityReplacesApps=await capture('dark-unity-replaces-apps');
  const agreed=await step('unityReplacesAppsPress','window.platformsRig.press()');
  assert.deepEqual(agreed.published,[{via:'web',replaceNativePage:true}]);
  const engineOnly=await step('engineNoReplace','window.platformsRig.open({scene:"engine"})');
  assert.equal(engineOnly.replaces,null,'no line while Genex has not said its page shows only apps');
  // Genex's review of the Mac app, and of a takedown (spec §6.9): each card in its words, in both themes.
  const truthful=(name,seen)=>{
   assert.doesNotMatch(seen.text,/few seconds|\\(2s\\)|about 2 min/i,name+' never claims seconds');
   assert.doesNotMatch(seen.text,/keeps checking|checks public games/i,name+' never claims a re-check of public games');
   assert.equal(seen.overflow,false,name+' fits');
  };
  for (const theme of ['dark','light']) {
   const checking=await step(theme+'AppsChecking','window.platformsRig.open({scene:"appsChecking",theme:"'+theme+'"})');
   assert.equal(checking.chip,'In review');
   assert.deepEqual(checking.steps,['done','done','current','next'],'Prepare · Upload · Check · Go live, at Check');
   assert.match(checking.check,/^Checking · 1m 0[56]s/);
   assert.match(checking.check,/Genex reads your app before players get it\\. Usually a few minutes\\./);
   // Flipped on purpose (Publish card): no explanation line under a game with apps; the Check says what happens.
   assert.equal(checking.hint,null);
   assert.equal(checking.review,null,'the step bar says it: no card');
   truthful('checking',checking);
   report[theme+'AppsChecking']=await capture(theme+'-apps-checking');
   const one=await step(theme+'AppsNotApproved1','window.platformsRig.open({scene:"appsNotApproved1",theme:"'+theme+'"})');
   assert.equal(one.chip,'Not approved');
   assert.equal(one.review.kind,'not-approved');
   assert.equal(one.review.title,"Can't publish yet: 1 thing to fix");
   assert.deepEqual(one.review.things,["Mines cryptocurrency on the player's computer"]);
   assert.deepEqual(one.review.presses,['Request human review','Fix with agent']);
   assert.equal(one.review.footer,'Nothing went public. After the fix, it publishes by itself and Genex checks it again.');
   truthful('not approved',one);
   report[theme+'AppsNotApproved1']=await capture(theme+'-apps-not-approved-1');
   const down=await step(theme+'AppsTakenDown','window.platformsRig.open({scene:"appsTakenDown",theme:"'+theme+'"})');
   assert.equal(down.chip,'Taken down');
   assert.equal(down.review.title,'Taken down: 3 things to fix');
   assert.deepEqual(down.review.lines,["Hidden from players until it's fixed and a person at Genex puts it back."]);
   assert.deepEqual(down.review.presses,['Request human review','Fix with agent']);
   assert.equal(down.review.footer,'After the fix, Studio asks a person at Genex to put it back. Usually within a day.');
   truthful('taken down',down);
   report[theme+'AppsTakenDown']=await capture(theme+'-apps-taken-down');
  }
  const slow=await step('appsChecking20m','window.platformsRig.open({scene:"appsChecking20m"})');
  assert.match(slow.check,/Taking longer than usual\\. If the check can't finish, a person at Genex reviews it\\./);
  report.appsChecking20m=await capture('dark-apps-checking-20m');
  const seven=await step('appsNotApproved7','window.platformsRig.open({scene:"appsNotApproved7"})');
  assert.equal(seven.review.title,"Can't publish yet: 7 things to fix");
  assert.equal(seven.review.things.length,3);
  assert.equal(seven.review.more,'Show 4 more');
  const opened=await step('appsNotApproved7More','window.platformsRig.reviewPress("more")');
  assert.equal(opened.review.things.length,7);
  assert.equal(opened.review.more,'Show less');
  report.appsNotApproved7=await capture('dark-apps-not-approved-7');
  const update=await step('appsUpdateNotApproved','window.platformsRig.open({scene:"appsUpdateNotApproved"})');
  assert.equal(update.review.title,'Update not approved: 1 thing to fix');
  assert.deepEqual(update.review.lines,['Players keep the Oct 25 version.']);
  const still=await step('appsStill','window.platformsRig.open({scene:"appsStill"})');
  assert.equal(still.review.title,'Not approved: 1 thing still to fix after the re-check');
  const requested=await step('appsRequested','window.platformsRig.open({scene:"appsRequested"})');
  assert.deepEqual(requested.review.after,['Human review requested. Usually within a day. You can still fix it yourself.']);
  assert.deepEqual(requested.review.presses,['Fix with agent']);
  const person=await step('appsWithPerson','window.platformsRig.open({scene:"appsWithPerson"})');
  assert.equal(person.review.title,'A person at Genex is reviewing it');
  assert.equal(person.check,null,'no check clock while a person reviews it');
  const personKept=await step('appsPersonKept','window.platformsRig.open({scene:"appsPersonKept"})');
  assert.deepEqual(personKept.review.lines,['Human review agreed with the check.']);
  assert.match(personKept.review.quote,/Sell coins through the Genex shop instead/);
  report.appsPersonKept=await capture('dark-apps-person-kept');
  const csam=await step('appsTakenDownCsam','window.platformsRig.open({scene:"appsTakenDownCsam"})');
  assert.equal(csam.review.title,'Taken down');
  assert.deepEqual(csam.review.lines,['The Genex team is reviewing this game.']);
  assert.deepEqual(csam.review.presses,[]);
  const sentFix=await step('appsFixSent','window.platformsRig.open({scene:"appsFixSent"})');
  assert.deepEqual(sentFix.review.after,["Sent to your agent. When it's done, Studio publishes it and Genex checks it again."]);
  assert.equal(sentFix.review.link,"Don't publish it automatically");
  report.appsFixSent=await capture('dark-apps-fix-sent');
  const stopped=await step('appsFixStopped','window.platformsRig.open({scene:"appsFixStopped"})');
  assert.deepEqual(stopped.review.lines,['Your agent stopped before it finished.']);
  assert.deepEqual(stopped.review.presses,['Fix again']);
  const unbuilt=await step('appsNotBuilt','window.platformsRig.open({scene:"appsNotBuilt"})');
  assert.deepEqual(unbuilt.review.lines,["The fix isn't built yet. Build the Mac app again and it publishes."]);
  assert.deepEqual(unbuilt.review.presses,['Build again']);
  const offline=await step('appsOffline','window.platformsRig.open({scene:"appsOffline"})');
  assert.deepEqual(offline.review.lines,['Not approved · reconnect to see what to fix']);
  const signedOut=await step('appsSignedOut','window.platformsRig.open({scene:"appsSignedOut"})');
  assert.ok(signedOut.review===null||signedOut.review.kind==='signed-out','signed out asks to sign in first');
  for (const [name,seen] of Object.entries({slow,seven,update,still,requested,person,personKept,csam,sentFix,stopped,unbuilt,offline})) truthful(name,seen);
  // Fix with agent and Request human review from the dialog's card.
  await step('fixOpen','window.platformsRig.open({scene:"appsNotApproved1"})');
  const fixed=await step('fixPress','window.platformsRig.reviewPress("fix")');
  assert.deepEqual(fixed.published,[{via:'fix'}]);
  await step('requestOpen','window.platformsRig.open({scene:"appsNotApproved1"})');
  await step('requestPress','window.platformsRig.reviewPress("request")');
  report.requestDialog=await capture('dark-request-review');
  const requestSent=await step('requestSend','window.platformsRig.requestReview("The coin page is our own shop.")');
  assert.deepEqual(requestSent.published,[{via:'request:The coin page is our own shop.'}]);
  assert.equal(requestSent.dialogOpen,false,'the dialog closes once Genex took the request');
  // A game opened on an app that is already live: no celebration, and Publish is still there to press.
  const liveApp=await step('appsLive','window.platformsRig.open({scene:"appsLive"})');
  assert.equal(liveApp.celebrating,false,'an app live before the dialog opened is no news');
  // Flipped on purpose (Publish card): an app live and up to date leaves nothing to press.
  assert.equal(liveApp.primary,null,'nothing to send again');
  assert.equal(liveApp.listed,true,'the rows are shown');
  // An apps publish that ends while the dialog is open: Genex is asked again, and its Check shows.
  const sendRuns=await step('appsPublishEnds','window.platformsRig.open({scene:"appsPublishEnds"})');
  assert.equal(sendRuns.check,null,'nothing with Genex yet');
  const ended=await step('appsPublishEnded','window.platformsRig.endSend()');
  assert.match(ended.check??'',/^Checking · /,'the Check and its clock once the send ended');
  assert.ok(ended.reviewReads.length>sendRuns.reviewReads.length&&ended.reviewReads.at(-1),'Genex was read again once the send ended');
  report.appsPublishEnded=await capture('dark-apps-publish-ended');
  // A game with a web version whose Mac app is checked: the web game's chip and steps stay.
  const webChecking=await step('webWithAppsChecking','window.platformsRig.open({scene:"webWithAppsChecking"})');
  assert.notEqual(webChecking.chip,'In review','the web version is live: its chip stays');
  assert.equal(webChecking.check,null,'no apps-only Check for a game with a web version');
  assert.ok(webChecking.primary,'the web Publish press stays');
  report.webWithAppsChecking=await capture('dark-web-with-apps-checking');
  // A person waits for the Mac app sent again: Publish sends it.
  const owed=await step('appsResendOwed','window.platformsRig.open({scene:"appsResendOwed"})');
  assert.equal(owed.review.kind,'resend-owed');
  assert.equal(owed.primary,'Publish Mac app','the very build Genex turned down can go to the person');
  // A taken-down game with a web version, fixed: Publish it, then Request human review.
  const fixedWeb=await step('webAppsFixedWeb','window.platformsRig.open({scene:"webAppsFixedWeb"})');
  assert.equal(fixedWeb.review.kind,'fixed-web');
  assert.deepEqual(fixedWeb.review.presses,['Request human review'],"the dialog's own press is the card's Publish");
  assert.ok(fixedWeb.primary,'Publish is there to press');
  assert.doesNotMatch(fixedWeb.text,/Studio asks a person/,"a web game's takedown is the person's to ask about");
  report.webAppsFixedWeb=await capture('dark-web-apps-fixed-web');
  // A fix that ended with nothing built half an hour ago, and an app sent since: it is checked, nothing else.
  const earlier=await step('appsFixEarlierBuild','window.platformsRig.open({scene:"appsFixEarlierBuild"})');
  assert.equal(earlier.review,null,"no isn't-built line for a fix Genex has moved past");
  assert.match(earlier.check??'',/^Checking · /);
  // An update Genex approves while the dialog watches: it celebrates, naming the version Mac players get now.
  const updating=await step('appsUpdateGoesLive','window.platformsRig.open({scene:"appsUpdateGoesLive"})');
  assert.equal(updating.celebrating,false);
  const wentLive=await step('appsUpdateApproved','window.platformsRig.approve()');
  assert.equal(wentLive.celebrating,true,'a check it watched ended live');
  assert.equal(wentLive.liveUpdate,'Version 1.3.0 is live for Mac players.');
  assert.equal(wentLive.hint,"If Genex ever takes it down, you'll hear it here and by email.");
  report.appsUpdateApproved=await capture('dark-apps-update-approved');
  assert.match(wentLive.chip??'',/^Live/,'players get the app: the banner never says Not published');
  // The same two moments in light.
  await step('lightAppsUpdateGoesLive','window.platformsRig.open({scene:"appsUpdateGoesLive",theme:"light"})');
  await step('lightAppsUpdateApproved','window.platformsRig.approve()');
  report.lightAppsUpdateApproved=await capture('light-apps-update-approved');
  await step('lightWebAppsFixedWeb','window.platformsRig.open({scene:"webAppsFixedWeb",theme:"light"})');
  report.lightWebAppsFixedWeb=await capture('light-web-apps-fixed-web');
  for (const [name,seen] of Object.entries({liveApp,ended,webChecking,owed,fixedWeb,earlier,wentLive})) truthful(name,seen);
  // A web game with no app: the dialog as it was, no rows.
  const plain=await step('web','window.platformsRig.open({scene:"web"})');
  assert.equal(plain.listed,false);
  report.web=await capture('dark-web');
  assert.deepEqual(report.errors,[]);
  console.log('PASS Publish platforms: a game with only an app publishes just it; an app in review or turned down says so on its row; switching off a web version still on Genex takes it off once confirmed; a web build that takes a page of apps says so and asks Genex with their consent; the review card of each app and takedown state; web game unchanged');
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
