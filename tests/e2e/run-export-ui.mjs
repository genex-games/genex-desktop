/**
 * L4: the chat header's export list for a Rust · wgpu game in real Chromium, over a fake host API
 * (`export-fixture.tsx`). On a Mac it lists Browser, iPhone and Android (the Rust Mac app and
 * desktop archives are not landed), and only the phones carry "Untested on real devices", the same
 * words in light and dark; choosing the iPhone opens the export sheet without exporting, and its
 * Simulator app export answers a receipt marked untested, which the notice says. On the Linux Studio
 * it lists Browser and Android. Light and dark screenshots of the open list and the sheet.
 */
import { runFixturePage } from "./fixture-page.mjs";

const steps = String.raw`
 if(!wc.debugger.isAttached())wc.debugger.attach();
 const theme=async mode=>{await js('window.test.theme('+JSON.stringify(mode)+')');await wait(200);};
 const press=async selector=>{
  const point=await js('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()');
  if(!point)throw new Error('Missing '+selector);
  for(const type of ['mousePressed','mouseReleased'])await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type,...point,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1});
  await wait(250);
 };
 const LIST=String.raw${"`"}(()=>{
  const menu=document.querySelector('[data-slot="dropdown-menu-content"]');
  if(!menu)return null;
  const items=[...menu.querySelectorAll('[data-chat-export-destination]')];
  const cut=e=>e.scrollWidth>e.clientWidth+1||e.scrollHeight>e.clientHeight+1;
  const m=menu.getBoundingClientRect();
  return {
   items:items.map(item=>item.dataset.chatExportDestination),
   caveats:Object.fromEntries([...menu.querySelectorAll('[data-chat-export-caveat]')].map(e=>[e.dataset.chatExportCaveat,e.textContent])),
   cut:items.some(cut)||cut(menu),
   inside:m.left>=0&&m.top>=0&&m.right<=innerWidth&&m.bottom<=innerHeight,
  };
 })()${"`"};
 const openList=async()=>{
  await press('button[aria-label="Chat actions"]');
  await until('document.querySelector("[data-chat-action=export]")');
  await press('[data-chat-action="export"]');
  await until('document.querySelector("[data-chat-export-destination=android]")');
  await wait(200);
  return js(LIST);
 };
 const notices=()=>js('[...document.querySelectorAll("[data-export-notice]")].map(e=>e.textContent)');
 const exports=async()=>(await js('window.test.calls()')).filter(c=>c.method==='exportGame');
 const UNTESTED='Untested on real devices';

 await theme('light');
 const mac=await openList();
 check('on a Mac the list offers Browser, iPhone and Android, in order',JSON.stringify(mac?.items)===JSON.stringify(['web','ios','android']),mac);
 check('only the phones are labelled untested on real devices',JSON.stringify(mac?.caveats)===JSON.stringify({ios:UNTESTED,android:UNTESTED}),mac?.caveats);
 check('no item or label is clipped, and the list stays on screen',mac&&!mac.cut&&mac.inside,mac);
 await capture('export-list-light');
 await theme('dark');
 const dark=await js(LIST);
 check('the label is byte-identical in dark',JSON.stringify(dark?.caveats)===JSON.stringify(mac?.caveats),dark?.caveats);
 check('nothing is clipped in dark',dark&&!dark.cut&&dark.inside,dark);
 await capture('export-list-dark');

 await press('[data-chat-export-destination="ios"]');
 await until('document.querySelector("[data-export-sheet=ios]")');
 check('choosing the iPhone opens its export sheet and exports nothing yet',(await exports()).length===0);
 await capture('export-sheet-ios-dark');
 await theme('light');
 await press('[data-export-submit]');
 await until('document.querySelector("[data-export-notice]")');
 const asked=(await exports()).at(-1);
 check('the sheet asks for the iPhone export signed ad hoc (a Simulator app)',asked?.args[1]?.destination==='ios'&&asked?.args[1]?.signing?.kind==='adhoc',asked);
 const said=(await notices()).at(-1)??'';
 check('the notice names the app and says it is untested on real devices',said.includes('Pond.app')&&said.includes('untested on real devices'),said);
 check('the sheet closes once the export is made',!(await js('Boolean(document.querySelector("[data-export-sheet]"))')));

 await js('window.test.platform("linux")');await wait(200);
 const linux=await openList();
 check('on the Linux Studio the list offers Browser and Android',JSON.stringify(linux?.items)===JSON.stringify(['web','android']),linux);
 check('the Linux Studio labels Android the same way',JSON.stringify(linux?.caveats)===JSON.stringify({android:UNTESTED}),linux?.caveats);
 await capture('export-list-linux-light');
 await press('[data-chat-export-destination="android"]');
 await until('document.querySelector("[data-export-sheet=android]")');
 await press('[data-export-submit]');
 await until('document.querySelectorAll("[data-export-notice]").length===2');
 const androidSaid=(await notices()).at(-1)??'';
 check('the development APK notice names the package and says it is untested on real devices',androidSaid.includes('Pond-debug.apk')&&androidSaid.includes('untested on real devices'),androidSaid);
`;

process.exitCode = await runFixturePage({
  name: "export-ui",
  entry: "tests/e2e/export-fixture.tsx",
  steps,
  size: { width: 900, height: 640 },
});
