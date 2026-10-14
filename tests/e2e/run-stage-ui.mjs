/**
 * L4: the stage strip over a compiled game in real Chromium, over a fake host API
 * (`stage-fixture.tsx`). A Rust · wgpu game's destinations get badges like a C++ game's: standing,
 * Browser and Mac are Live's (a Rust game has no window of its own, so Live shows its Mac build);
 * while its Mac build runs, the badge says Building out loud and its tooltip names the Rust build
 * stage, never C++; with no Rust tools in, both badges say they need tools. A C++ game keeps its own
 * window and names its own build stage. Light and dark screenshots of each, with the tooltip open.
 */
import { runFixturePage } from "./fixture-page.mjs";

const steps = String.raw`
 const strip='document.querySelector("[data-stage-strip]")';
 const badge=t=>'document.querySelector("[data-stage-destination='+t+']")';
 const show=async scene=>{await js('window.test.show('+JSON.stringify(scene)+')');await wait(150);};
 const theme=async mode=>{await js('window.test.theme('+JSON.stringify(mode)+')');await wait(150);};
 if(!wc.debugger.isAttached())wc.debugger.attach();
 const mouse=point=>wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
 const tooltip=async()=>{const point=await js('(()=>{const r=document.querySelector("[data-stage-destinations]").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');await mouse(point);await until('document.querySelector("[data-slot=tooltip-content]")');await wait(200);return js('[...(document.querySelector("[data-slot=tooltip-content]")?.querySelectorAll("li")??[])].filter(li=>!li.closest("[role=tooltip]")).map(li=>li.innerText).join(" | ")');};
 const blur=async()=>{await mouse({x:4,y:250});await wait(400);};
 const rust={stack:'rust-wgpu',building:false,rustReady:true};

 await theme('light');
 await show(rust);await until(badge('macos'));
 check('a Rust game shows its destination badges',await js('Boolean('+badge('web')+'&&'+badge('macos')+')'));
 check('standing, its Mac build is Live’s, not a window of its own',(await js(badge('macos')+'.dataset.destinationState'))==='in-live'&&(await js(badge('macos')+'.innerText')).includes('In Live · Native'),await js(badge('macos')+'.innerText'));
 check('the kind chip names Rust · wgpu',(await js(strip+'.querySelector("[data-stage-kind]").title')).includes('Rust · wgpu'));
 await capture('rust-standing-light');

 await show({...rust,building:true});await until(badge('macos')+'.dataset.destinationState==="building"');
 check('a running Rust build says Building out loud',(await js(badge('macos')+'.innerText')).includes('Building'));
 check('the strip marks the build phase',(await js('document.querySelector("[data-stage-destinations]").dataset.stageBuildPhase'))==='build');
 const said=await tooltip();
 check('the tooltip names the Rust build stage',said.includes('compiling the Rust code with Cargo'),said);
 check('nothing on a Rust game’s strip says C++',!/C\+\+/.test(said)&&!/C\+\+/.test(await js(strip+'.innerText')),said);
 await capture('rust-building-light');await theme('dark');await capture('rust-building-dark');await blur();await theme('light');

 await show({...rust,rustReady:false});await until(badge('macos')+'.dataset.destinationState==="needs-tools"');
 check('without its Rust tools, both destinations need tools',(await js(badge('web')+'.dataset.destinationState'))==='needs-tools');
 await capture('rust-needs-tools-light');await theme('dark');await capture('rust-needs-tools-dark');await theme('light');

 await show({stack:'raylib-cpp',building:true,rustReady:true});await until(badge('macos')+'.dataset.destinationState==="building"');
 const cppSaid=await tooltip();
 check('a C++ build names its own stage',cppSaid.includes('compiling the C++ code'),cppSaid);
 await blur();
 await show({stack:'raylib-cpp',building:false,rustReady:true});await wait(150);
 check('a C++ game keeps its own window',(await js(badge('macos')+'.dataset.destinationState'))!=='in-live',await js(badge('macos')+'.dataset.destinationState'));
 await capture('cpp-light');await theme('dark');await capture('cpp-dark');
 await show(rust);await wait(150);await capture('rust-standing-dark');
`;

process.exitCode = await runFixturePage({
  name: "stage-ui",
  entry: "tests/e2e/stage-fixture.tsx",
  steps,
  size: { width: 1000, height: 260 },
});
