/**
 * L4: the Toolchain sheet per stack and Settings → Toolchains in real Chromium, over a fake host API
 * (`toolchain-fixture.tsx`). A Rust · wgpu game's sheet is titled for Rust games and never says C++;
 * with the Command Line Tools and no Xcode it lists both of Apple's rows, Xcode missing; it lists
 * the Rust components it lacks, says this version does not download them, and offers no Install;
 * each harness part a Rust night refuses has its re-take, which says where the agent's edit went or
 * why nothing changed. With Xcode alone and every Rust tool in, the sheet is ready. A C++ game's
 * sheet keeps its title, its one Apple row and Install. With Xcode 26 and the person's Android SDK,
 * a Rust sheet lists each phone's parts: the iPhone offers its Install, Android shows its SDK licence
 * for the person to accept and no Install until they do; accepting it asks the host once and then
 * offers Android's Install. Settings lists the same phones. Light and dark screenshots of each.
 */
import { runFixturePage } from "./fixture-page.mjs";

const steps = String.raw`
 const sheet='document.querySelector("[data-toolchain-sheet]")';
 const dialog='document.querySelector("[data-testid=toolchain-sheet]")';
 const show=async(view,scenario)=>{await js('window.test.show('+JSON.stringify(view)+','+JSON.stringify(scenario)+')');await wait(100);};
 const theme=async mode=>{await js('window.test.theme('+JSON.stringify(mode)+')');await wait(150);};
 const prerequisite=p=>sheet+'.querySelector("[data-toolchain-prerequisite='+p+']")';
 const rust={kind:'sheet',stack:'rust-wgpu'},cpp={kind:'sheet',stack:'raylib-cpp'},settings={kind:'settings'};

 await theme('light');
 await show(rust,'rustCltOnly');await until(sheet+'?.querySelector("[data-toolchain-prerequisite]")');
 const rustText=await js(dialog+'.innerText');
 check('a Rust sheet is titled for Rust games',rustText.includes('Set up Rust games'),rustText);
 check('nothing in a Rust sheet says C++',!/C\+\+/.test(rustText),rustText);
 check('the Command Line Tools row is installed',await js('Boolean('+prerequisite('clt')+'?.hasAttribute("data-toolchain-present"))'));
 check('the Xcode row is there and missing',await js('Boolean('+prerequisite('xcode')+'&&!'+prerequisite('xcode')+'.hasAttribute("data-toolchain-present"))'));
 check('the Xcode row says what it is for',(await js(prerequisite('xcode')+'.innerText')).includes('iPhone and iPad'));
 check('the Rust components it lacks are listed, and no C++ one',await js('Boolean('+sheet+'.querySelector("[data-toolchain-download=rust]")&&'+sheet+'.querySelector("[data-toolchain-download=wasm-bindgen]")&&!'+sheet+'.querySelector("[data-toolchain-download=emsdk]"))'));
 check('the sheet says this version does not download Rust tools, and offers no Install',await js('Boolean('+sheet+'.querySelector("[data-toolchain-not-installed-here]"))&&!document.querySelector("[data-toolchain-install]")'));
 check('each kept harness part has its re-take',await js('document.querySelectorAll("[data-seed-retake-button]").length===2'));
 await capture('rust-clt-only-light');await theme('dark');await capture('rust-clt-only-dark');await theme('light');
 await js('document.querySelector("[data-seed-retake-button=\\"loop/judge.ts\\"]").click()');
 await until('document.querySelector("[data-seed-retake=\\"loop/judge.ts\\"] [data-seed-retake-answer=retaken]")');
 const calls=await js('window.test.calls()');
 check('the re-take asked for exactly that part',calls.some(c=>c.method==='retakeSeedModule'&&JSON.stringify(c.args)===JSON.stringify(['loop/judge.ts'])),calls);
 check('a re-taken part says where the agent\u2019s edit went, and loses its button',(await js('document.querySelector("[data-seed-retake=\\"loop/judge.ts\\"]").innerText')).includes('judge.ts.patch')&&!(await js('document.querySelector("[data-seed-retake-button=\\"loop/judge.ts\\"]")')));
 check('the sheet read the status again after the re-take',(await js('window.test.calls()')).filter(c=>c.method==='toolchainStatus').length>=2);
 await js('document.querySelector("[data-seed-retake-button=\\"loop/review.ts\\"]").click()');
 await until('document.querySelector("[data-seed-retake=\\"loop/review.ts\\"] [data-seed-retake-answer=patch-exists]")');
 check('a refused re-take says why and keeps its button',Boolean(await js('document.querySelector("[data-seed-retake-button=\\"loop/review.ts\\"]")')));
 await capture('rust-retaken-light');await theme('dark');await capture('rust-retaken-dark');await theme('light');

 await show(rust,'rustReady');await until(sheet+'?.querySelector("[data-toolchain-prerequisite]")');
 check('with Xcode alone the tools row reads as included with Xcode',(await js(prerequisite('clt')+'.innerText')).includes('Included with Xcode'));
 check('a ready Rust sheet lists nothing to download and no note',await js('!'+sheet+'.querySelector("[data-toolchain-download]")&&!'+sheet+'.querySelector("[data-toolchain-not-installed-here]")&&!'+sheet+'.querySelector("[data-seed-retakes]")'));
 check('a ready Rust sheet still never says C++',!/C\+\+/.test(await js(dialog+'.innerText')));
 await capture('rust-ready-light');await theme('dark');await capture('rust-ready-dark');await theme('light');

 await show(cpp,'cpp');await until(sheet+'?.querySelector("[data-toolchain-download]")');
 const cppText=await js(dialog+'.innerText');
 check('a C++ sheet keeps its title',cppText.includes('Set up C++ games'),cppText);
 check('a C++ sheet lists only the Command Line Tools of Apple\u2019s rows, and offers Install',await js('!'+sheet+'.querySelector("[data-toolchain-prerequisite=xcode]")&&Boolean(document.querySelector("[data-toolchain-install]"))'));
 await capture('cpp-light');await theme('dark');await capture('cpp-dark');await theme('light');

 await show(settings,'rustCltOnly');await until('document.querySelector("[data-settings-rust-setup]")');
 const settingsText=await text('[data-settings-rust-setup]');
 check('Settings lists the Rust setup: Apple\u2019s two rows and the kept parts',settingsText.includes('Xcode')&&settingsText.includes('Apple Command Line Tools')&&settingsText.includes('loop/judge.ts'),settingsText);
 check('Settings\u2019 Rust setup never says C++',!/C\+\+/.test(settingsText),settingsText);
 await capture('settings-light');await theme('dark');await capture('settings-dark');

 const phone=t=>'document.querySelector("[data-toolchain-phone='+t+']")';
 await theme('light');
 await show(rust,'rustPhones');await until(sheet+'?.querySelector("[data-toolchain-phones]")');
 check('a Rust sheet lists the iPhone and Android',await js('Boolean('+phone('ios')+'&&'+phone('android')+')'));
 check('the iPhone lists its two Rust libraries',JSON.stringify(await js('[...'+phone('ios')+'.querySelectorAll("[data-toolchain-phone-part]")].map(e=>e.dataset.toolchainPhonePart)'))===JSON.stringify(['rust-std-ios','rust-std-ios-sim']));
 check('with Xcode 26 the iPhone offers its Install',await js('Boolean(document.querySelector("[data-toolchain-phone-install=ios]"))'));
 const androidParts=await js('[...'+phone('android')+'.querySelectorAll("[data-toolchain-phone-part]")].map(e=>[e.dataset.toolchainPhonePart,e.hasAttribute("data-toolchain-person-side"),e.dataset.toolchainPartState])');
 check('Android lists the SDK, Build-Tools and NDK as the person’s, beside the store’s parts',JSON.stringify(androidParts.filter(p=>p[1]).map(p=>p[0]))===JSON.stringify(['android-sdk','android-build-tools','android-ndk']),androidParts);
 check('another NDK revision names the one builds need',(await js(phone('android')+'.querySelector("[data-toolchain-phone-part=android-ndk]").innerText')).includes('30.0.16248370'));
 check('Android shows the licence for the person to accept, and no Install yet',await js('Boolean('+phone('android')+'.querySelector("[data-toolchain-licence=offered] [data-toolchain-licence-accept]"))&&!document.querySelector("[data-toolchain-phone-install=android]")'));
 check('Android says why it cannot install yet',(await js(phone('android')+'.querySelector("[data-toolchain-phone-why]")?.innerText??""')).includes('Accept the Android SDK License'));
 check('the phones never say C++',!/C\+\+/.test(await js(sheet+'.querySelector("[data-toolchain-phones]").innerText')));
 const clipped=await js('[...document.querySelectorAll("[data-toolchain-phones] *")].some(e=>e.children.length===0&&e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflow!=="visible")');
 check('nothing in the phones is clipped',!clipped);
 await capture('rust-phones-light');await theme('dark');await capture('rust-phones-dark');await theme('light');
 check('nothing asked the host to accept the licence before the press',!(await js('window.test.calls()')).some(c=>c.method==='toolchainAcceptAndroidLicence'));
 await js('document.querySelector("[data-toolchain-licence-accept]").click()');
 await until('document.querySelector("[data-toolchain-licence=accepted]")');
 const accepts=(await js('window.test.calls()')).filter(c=>c.method==='toolchainAcceptAndroidLicence');
 check('the press asks the host once for the Android SDK licence',JSON.stringify(accepts.map(c=>c.args))===JSON.stringify([['android-sdk-license']]),accepts);
 check('once accepted, Android offers its Install',await js('Boolean(document.querySelector("[data-toolchain-phone-install=android]"))'));
 await js('document.querySelector("[data-toolchain-phone-install=android]").click()');await wait(200);
 const installs=(await js('window.test.calls()')).filter(c=>c.method==='toolchainInstallMobile');
 check('Install asks for Android’s tools',JSON.stringify(installs.map(c=>c.args))===JSON.stringify([['android']]),installs);
 await capture('rust-phones-accepted-light');await theme('dark');await capture('rust-phones-accepted-dark');await theme('light');

 await show(settings,'rustPhones');await until('document.querySelector("[data-settings-rust-setup] [data-toolchain-phones]")');
 check('Settings lists the phones with the licence to accept',await js('Boolean(document.querySelector("[data-settings-rust-setup] [data-toolchain-licence=offered]"))'));
 await js('document.querySelector("[data-settings-rust-setup] [data-toolchain-phones]").scrollIntoView({block:"start"})');await wait(150);
 await capture('settings-phones-light');await theme('dark');await capture('settings-phones-dark');
`;

process.exitCode = await runFixturePage({
  name: "toolchain-ui",
  entry: "tests/e2e/toolchain-fixture.tsx",
  steps,
  size: { width: 900, height: 900 },
});
