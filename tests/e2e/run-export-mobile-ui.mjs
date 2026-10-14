/**
 * L4: the phone export sheet in real Chromium, over a fake host API (`export-mobile-fixture.tsx`).
 * The iPhone's sheet offers the Simulator app (chosen first, Export on) and two IPAs marked "Only
 * you"; a device IPA keeps Export off until its identity and provisioning profile are in, and the
 * picked profile shows by its file name, never its folders. Android's sheet offers the development
 * APK and a Play bundle signed with the person's keystore: the sheet has no password field at all,
 * only where the signer reads the password (a variable's name or a picked file), and what it sends
 * carries that reference and never a password. A refusal that echoes a keystore password shows
 * redacted. Light and dark screenshots of each.
 */
import { runFixturePage } from "./fixture-page.mjs";

const steps = String.raw`
 if(!wc.debugger.isAttached())wc.debugger.attach();
 const theme=async mode=>{await js('window.test.theme('+JSON.stringify(mode)+')');await wait(200);};
 const open=async destination=>{await js('window.test.open('+JSON.stringify(destination)+')');await until('document.querySelector("[data-export-sheet='+destination+']")');await wait(150);};
 const q=selector=>'document.querySelector('+JSON.stringify(selector)+')';
 const choose=async signing=>{await js(q('[data-export-option="'+signing+'"] input')+'.click()');await wait(150);};
 const type=async(selector,value)=>{await js(q(selector)+'.focus()');await wc.debugger.sendCommand('Input.insertText',{text:value});await wait(100);};
 const exportOff=()=>js(q('[data-export-submit]')+'.disabled');
 const options=()=>js('[...document.querySelectorAll("[data-export-option]")].map(e=>[e.dataset.exportOption,e.querySelector("[data-export-person-only]")?.textContent??null])');
 const exports=async()=>(await js('window.test.calls()')).filter(c=>c.method==='exportGame');
 const LAYOUT=String.raw${"`"}(()=>{
  const d=document.querySelector('[data-testid="export-sheet"]');
  if(!d)return null;
  const r=d.getBoundingClientRect();
  const cut=[...d.querySelectorAll('button,label,span,p')].some(e=>e.children.length===0&&e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflow!=='visible');
  return {inside:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,cut};
 })()${"`"};

 await theme('light');
 await open('ios');
 check('the iPhone sheet offers the Simulator app and two IPAs, the IPAs only the person makes',JSON.stringify(await options())===JSON.stringify([['adhoc',null],['ios-development','Only you'],['ios-distribution','Only you']]),await options());
 check('the Simulator app is chosen first and Export works',await js(q('[data-export-option="adhoc"] input')+'.checked')&&!(await exportOff()));
 await choose('ios-development');
 check('a device IPA asks for its identity and profile, and Export waits for them',await js('Boolean('+q('[data-export-field="identity"]')+'&&'+q('[data-export-pick="provisioning-profile"]')+')'))&&await exportOff();
 await js(q('[data-export-pick="provisioning-profile"]')+'.click()');
 await until(q('[data-export-picked="provisioning-profile"]')+'?.textContent==="Pond Development.mobileprovision"');
 check('the picked profile shows by its file name, never its folders',!(await js('document.body.innerText')).includes('/Users/fixture/Private'));
 const picks=(await js('window.test.calls()')).filter(c=>c.method==='exportSigningReference');
 check('the dialog was asked for a provisioning profile',JSON.stringify(picks.map(c=>c.args))===JSON.stringify([['provisioning-profile']]),picks);
 await type('[data-export-field="identity"]','Apple Development: Pat Example (ABCDE12345)');
 check('with both in, Export works',!(await exportOff()));
 const iosLayout=await js(LAYOUT);
 check('the sheet stays on screen with nothing clipped',iosLayout&&iosLayout.inside&&!iosLayout.cut,iosLayout);
 await capture('ios-device-light');await theme('dark');
 const iosDark=await js(LAYOUT);
 check('nothing is clipped in dark',iosDark&&iosDark.inside&&!iosDark.cut,iosDark);
 await capture('ios-device-dark');await theme('light');
 await js(q('[data-export-submit]')+'.click()');
 await until(q('[data-export-notice]'));
 const iosSent=await exports();
 check('Export sends the device signing with the profile path main checks again',JSON.stringify(iosSent.map(c=>c.args))===JSON.stringify([['pond',{destination:'ios',signing:{kind:'ios-development',identity:'Apple Development: Pat Example (ABCDE12345)',provisioningProfile:'/Users/fixture/Private/Profiles/Pond Development.mobileprovision'}}]]),iosSent);
 check('the notice names the artifact',(await text('[data-export-notice]')).includes('Pond.app'));

 await open('android');
 check('Android offers the development APK and a Play bundle only the person makes',JSON.stringify(await options())===JSON.stringify([['android-debug',null],['android-release','Only you']]),await options());
 await choose('android-release');
 check('a release bundle asks for the keystore, its alias and where the password is read, and Export waits',await js('Boolean('+q('[data-export-pick="keystore"]')+'&&'+q('[data-export-field="alias"]')+'&&'+q('[data-export-field="password-env"]')+')'))&&await exportOff();
 check('the sheet has no password field at all',await js('!document.querySelector("input[type=password]")&&!document.querySelector("[data-export-field=password]")'));
 await js(q('[data-export-pick="keystore"]')+'.click()');
 await until(q('[data-export-picked="keystore"]')+'?.textContent==="upload.jks"');
 await type('[data-export-field="alias"]','upload');
 await type('[data-export-field="password-env"]','GENEX_KEYSTORE_PASSWORD');
 check('with the keystore, alias and variable in, Export works',!(await exportOff()));
 await capture('android-release-light');await theme('dark');
 const androidDark=await js(LAYOUT);
 check('nothing is clipped in dark',androidDark&&androidDark.inside&&!androidDark.cut,androidDark);
 await capture('android-release-dark');await theme('light');
 await js(q('[data-export-password-from="file"]')+'.click()');await wait(150);
 check('choosing a password file waits for the file',await exportOff());
 await js(q('[data-export-pick="password-file"]')+'.click()');
 await until(q('[data-export-picked="password-file"]')+'?.textContent==="upload-password.txt"');
 await js('window.test.refuseNext("jarsigner: keystore was tampered with GENEX_KEYSTORE_PASSWORD=hunter2-secret-0099")');
 await js(q('[data-export-submit]')+'.click()');
 await until(q('[data-export-error]'));
 const refused=await text('[data-export-error]');
 check('a refusal that echoes the password shows it redacted',!refused.includes('hunter2-secret-0099')&&refused.includes('[redacted]'),refused);
 const androidSent=await exports();
 check('what the sheet sent names the keystore and the password file, never a password',JSON.stringify(androidSent.map(c=>c.args))===JSON.stringify([['pond',{destination:'android',signing:{kind:'android-release',keystore:'/Users/fixture/Private/keys/upload.jks',alias:'upload',password:{file:'/Users/fixture/Private/keys/upload-password.txt'}}}]]),androidSent);
 await capture('android-refused-light');await theme('dark');await capture('android-refused-dark');
`;

process.exitCode = await runFixturePage({
  name: "export-mobile-ui",
  entry: "tests/e2e/export-mobile-fixture.tsx",
  steps,
  size: { width: 900, height: 820 },
});
