/**
 * L4: a Rust game's engine rows (extension ladder level 5) in real Chromium, over a fake host API
 * (`engine-rows-fixture.tsx`): the strip's engine button opens and closes them; eject asks first,
 * cancels to where it was and words a refusal by its code (`eject-needs-mac`); trust warns before
 * it turns on; an ejected game offers the engine back after a question; a new game closes the rows;
 * a C++ game has no engine button. Light and dark screenshots of each state.
 */
import { runFixturePage } from "./fixture-page.mjs";

const steps = String.raw`
 const q=s=>'document.querySelector('+JSON.stringify(s)+')';
 const show=async name=>{await js('window.test.show('+JSON.stringify(name)+')');await wait(150);};
 const theme=async mode=>{await js('window.test.theme('+JSON.stringify(mode)+')');await wait(150);};
 const click=async s=>{await js(q(s)+'.click()');await wait(120);};
 const calls=m=>js('window.test.calls()').then(all=>all.filter(c=>c.method===m).map(c=>c.args));
 const shots=async name=>{await capture(name+'-light');await theme('dark');await capture(name+'-dark');await theme('light');};

 await theme('light');
 await show('pond');await until(q('[data-stage-engine]'));
 check('a Rust game has an engine button, closed',(await js(q('[data-stage-engine]')+'.dataset.stageEngine'))==='closed');
 check('the rows stay closed until it is pressed',await js('!'+q('[data-stage-engine-rows]')));
 check('the button reads Game engine',(await js(q('[data-stage-engine]')+'.getAttribute("aria-label")'))==='Game engine');
 await click('[data-stage-engine]');await until(q('[data-stage-engine-rows]'));
 check('the engine state is read for the game',JSON.stringify(await calls('engineState'))===JSON.stringify([['pond']]));
 check('a game on Genex’s engine offers eject',(await js(q('[data-stage-engine-eject]')+'.dataset.stageEngineEject'))==='store');
 check('trust starts off',(await js(q('[data-stage-engine-trust]')+'.dataset.stageEngineTrust'))==='off');
 await shots('engine-store');

 await click('[data-stage-engine-eject-action=eject]');
 check('eject asks first',(await js(q('[data-stage-engine-eject]')+'.dataset.stageEngineEject'))==='asking-eject'&&await js('Boolean('+q('[data-stage-engine-eject] [role=alert]')+')'));
 await shots('engine-asking-eject');
 await click('[data-stage-engine-eject-action=cancel]');
 check('cancel goes back without asking the host',(await js(q('[data-stage-engine-eject]')+'.dataset.stageEngineEject'))==='store'&&(await calls('engineEject')).length===0);
 await click('[data-stage-engine-eject-action=eject]');await click('[data-stage-engine-eject-action=confirm]');
 await until(q('[data-stage-engine-eject] [role=status]')+'?.innerText.includes("needs a Mac")');
 check('confirming asks the host once for this game',JSON.stringify(await calls('engineEject'))===JSON.stringify([['pond']]));
 check('a refusal is worded by its code and the engine stays Genex’s',(await js(q('[data-stage-engine-eject]')+'.dataset.stageEngineEject'))==='store');
 await shots('engine-eject-refused');

 await click('[data-stage-engine-trust-action=trust]');
 check('trust warns before it turns on',(await js(q('[data-stage-engine-trust]')+'.dataset.stageEngineTrust'))==='asking'&&(await text('[data-stage-engine-trust] [role=alert]')).includes('Only trust code'));
 await shots('engine-trust-warning');
 await click('[data-stage-engine-trust-action=confirm]');await until(q('[data-stage-engine-trust="on"]'));
 check('confirming sets the flag on for this game',JSON.stringify(await calls('engineSetTrust'))===JSON.stringify([['pond',true]]));

 await show('cove');await wait(150);
 check('a new game closes the rows',await js('!'+q('[data-stage-engine-rows]'))&&(await js(q('[data-stage-engine]')+'.dataset.stageEngine'))==='closed');
 await click('[data-stage-engine]');await until(q('[data-stage-engine-rows]'));
 check('an ejected game shows its own copy and release',(await js(q('[data-stage-engine-eject]')+'.dataset.stageEngineEject'))==='ejected'&&(await text('[data-stage-engine-eject]')).includes('0.1.0'));
 check('a trusted game starts on',(await js(q('[data-stage-engine-trust]')+'.dataset.stageEngineTrust'))==='on');
 await shots('engine-ejected');
 await click('[data-stage-engine-eject-action=give-back]');
 check('giving the engine back asks first',(await js(q('[data-stage-engine-eject]')+'.dataset.stageEngineEject'))==='asking-give-back');
 await click('[data-stage-engine-eject-action=confirm]');await until(q('[data-stage-engine-eject="store"]'));
 check('confirming gives it back for this game',JSON.stringify(await calls('engineUneject'))===JSON.stringify([['cove']]));
 await click('[data-stage-engine]');await wait(150);
 check('the button closes the rows',await js('!'+q('[data-stage-engine-rows]')));

 await show('pong-cpp');await wait(150);
 check('a C++ game has no engine button',await js('!'+q('[data-stage-engine]')));
`;

process.exitCode = await runFixturePage({
  name: "engine-rows-ui",
  entry: "tests/e2e/engine-rows-fixture.tsx",
  steps,
  size: { width: 1000, height: 320 },
});
