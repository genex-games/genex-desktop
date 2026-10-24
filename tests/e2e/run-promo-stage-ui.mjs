/**
 * L4: the Genex promo over Live in real Chromium, over a fake host API (`promo-stage-fixture.tsx`).
 * The promo no longer rests the web game: while the card covers the slot, the view is sent out of
 * the window at the slot's size (main keeps a view with an area visible, so the page draws on) and
 * the slot shows the game's newer frames under the card. A dialog still rests the game and stops
 * the frames; closing the card puts the view back in its slot. Light and dark screenshots.
 */
import { runFixturePage } from "./fixture-page.mjs";

const steps = `
 const show=async scene=>{await js('window.test.show('+JSON.stringify(scene)+')');await wait(150);};
 const theme=async mode=>{await js('window.test.theme('+JSON.stringify(mode)+')');await wait(150);};
 const last='window.test.bounds().last';
 const slot='document.querySelector("[data-fixture-slot]")';
 const frames=()=>js('window.test.frames()');
 const still=()=>js(slot+'.style.backgroundImage');

 await theme('light');
 await show({promo:false,dialog:false});
 await until(last+'&&'+last+'.width>0&&'+last+'.x>=0');
 const rect=await js('(()=>{const r='+slot+'.getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:r.height}})()');
 check('with nothing over it, the game view sits in its slot',JSON.stringify(await js(last))===JSON.stringify(rect),await js(last));

 await show({promo:true,dialog:false});
 await until('document.querySelector("[data-genex-promo][data-ready]")');
 await until(last+'&&'+last+'.x<0');
 const parked=await js(last);
 check('under the promo the view keeps the slot’s size, out of sight, so the page draws on',parked.width===rect.width&&parked.height===rect.height&&parked.x+parked.width<=0&&parked.y+parked.height<=0,parked);
 await until(slot+'.hasAttribute("data-live-still")');
 const before=await frames();const firstStill=await still();
 await wait(1600);
 const after=await frames();
 check('the slot takes the game’s newer frames while the card is up',after>=before+2&&(await still())!==firstStill,{before,after});
 check('the slot no longer claims the game paints there',!(await js(slot+'.hasAttribute("data-native-view")')));
 await capture('promo-over-live-light');

 await show({promo:true,dialog:true});
 await until(last+'&&'+last+'.width===0');
 const rested=await frames();
 await wait(1200);
 check('a dialog still rests the game: no area, no new frames',(await frames())===rested,{rested,now:await frames()});

 await show({promo:true,dialog:false});
 await until(last+'&&'+last+'.x<0&&'+last+'.width>0');
 check('the dialog gone, the game draws on under the card again',(await js(last)).width===rect.width);
 await theme('dark');await capture('promo-over-live-dark');await theme('light');

 await show({promo:false,dialog:false});
 await until(last+'&&'+last+'.x>=0&&'+last+'.width>0');
 check('closing the card puts the view back in its slot',JSON.stringify(await js(last))===JSON.stringify(rect),await js(last));
 await until('!'+slot+'.hasAttribute("data-live-still")');
 const closed=await frames();
 await wait(1200);
 check('with the card gone the slot stops taking frames',(await frames())===closed);
 await capture('promo-closed-light');
`;

process.exitCode = await runFixturePage({
  name: "promo-stage-ui",
  entry: "tests/e2e/promo-stage-fixture.tsx",
  steps,
  size: { width: 1280, height: 800 },
});
