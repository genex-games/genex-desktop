/**
 * L4: the crate request card (extension ladder level 4) in a Rust game's Toolchain sheet, in real
 * Chromium over a fake host API (`crate-requests-fixture.tsx`): every request is listed with its
 * game, reason and what was read of it; a waiting one offers Approve and Decline with separate
 * switches for build scripts and proc macros and says the checks run after the approval; one
 * waiting again says why above working controls; a decided one says where it ended, naming the
 * crate a check stopped, and what the checks found (advisories as of the snapshot's day, licence,
 * banned crates, each trusted source's audit, the notice, and the engines behind "How it was
 * checked"). Approving with build scripts allowed sends exactly that decision. Light and dark
 * screenshots before and after.
 */
import { runFixturePage } from "./fixture-page.mjs";

const steps = `
 const card='document.querySelector("[data-crate-requests]")';
 const theme=async mode=>{await js('window.test.theme('+JSON.stringify(mode)+')');await wait(150);};
 await theme('light');
 await until(card);
 const cardText=await js(card+'.innerText');
 check('the card lists every request',await js('document.querySelectorAll("[data-crate-request]").length===7'));
 check('a waiting request offers Approve and Decline',await js('Boolean(document.querySelector("[data-crate-approve=crq-3]")&&document.querySelector("[data-crate-decline=crq-3]"))'));
 check('a decided request offers neither',await js('!document.querySelector("[data-crate-approve=crq-1]")&&!document.querySelector("[data-crate-approve=crq-2]")'));
 check('a refused request says why',await js('Boolean(document.querySelector("[data-crate-outcome=crate-licence]"))'),cardText);
 check('an added request says so',await js('Boolean(document.querySelector("[data-crate-outcome=vendored]"))'),cardText);
 check('an advisory refusal names the advisory and the crate it affects',await js('document.querySelector("[data-crate-request=crq-4] [data-crate-check-row=advisories]")?.innerText==="RUSTSEC-2021-0003 in smallvec 1.6.0"'),cardText);
 check('a licence refusal names the crate and its licence',await js('document.querySelector("[data-crate-request=crq-2] [data-crate-check-row=licence]")?.innerText==="Not allowed: copyleft 1.0.0 (GPL-3.0-only)"'),cardText);
 check('a banned crate it brings in is named in the outcome and its row',await js('document.querySelector("[data-crate-request=crq-7] [data-crate-outcome=crate-banned]")?.innerText.includes("It brings in glow 0.13.0")&&document.querySelector("[data-crate-request=crq-7] [data-crate-check-row=banned]")?.innerText==="glow 0.13.0"'),cardText);
 check('a passing check dates its advisory snapshot',await js('/^None known as of .*2026$/.test(document.querySelector("[data-crate-request=crq-1] [data-crate-check-row=advisories]")?.innerText??"")'),cardText);
 check('a waiting-again request says why above working controls',await js('Boolean(document.querySelector("[data-crate-request=crq-6] [data-crate-retry=crate-checker-unavailable]"))&&!document.querySelector("[data-crate-approve=crq-6]").disabled&&!document.querySelector("[data-crate-decline=crq-6]").disabled'),cardText);
 check('a refused request shows no audits row',await js('!document.querySelector("[data-crate-request=crq-4] [data-crate-check-row=audits]")'),cardText);
 check('every checked request names its engine, behind How it was checked',await js('[...document.querySelectorAll("[data-crate-check-details] [data-crate-check-row=engine]")].length===5&&[...document.querySelectorAll("[data-crate-check-row=engine]")].every(e=>e.textContent.startsWith("cargo-deny 0.20.2"))'),cardText);
 check('an audited request names its source and cargo-vet',await js('document.querySelector("[data-crate-request=crq-1] [data-crate-check-row=audits]")?.innerText.startsWith("Audited by Mozilla")&&document.querySelector("[data-crate-request=crq-1] [data-crate-check-row=engine]")?.textContent.includes("cargo-vet 0.10.0")'),cardText);
 check('an unaudited added request carries its notice and is still added',await js('Boolean(document.querySelector("[data-crate-request=crq-5] [data-crate-notice=crate-unaudited]")&&document.querySelector("[data-crate-request=crq-5] [data-crate-outcome=vendored]"))'),cardText);
 check('a waiting request shows no checks yet, and says they run after the approval',await js('!document.querySelector("[data-crate-request=crq-3] [data-crate-check]")&&document.querySelector("[data-crate-request=crq-3] [data-crate-facts]")?.innerText.includes("after you approve")'),cardText);
 check('the waiting request names its game and reason',cardText.includes('for pond')&&cardText.includes('entity store'),cardText);
 check('build scripts and proc macros have their own switches',cardText.includes('Allow build scripts')&&cardText.includes('Allow proc macros'),cardText);
 await js('document.querySelector("[data-crate-requests]").scrollIntoView()');
 await capture('crate-requests-light');
 await js('document.querySelector("[data-crate-request=crq-1] [data-crate-check-details] summary").click()');
 await wait(100);
 check('How it was checked opens on the engines and the dated snapshot',await js('document.querySelector("[data-crate-request=crq-1] [data-crate-check-details]").open&&document.querySelector("[data-crate-request=crq-1] [data-crate-check-row=snapshot]")?.innerText.startsWith("RustSec 550efd3d, ")'),cardText);
 await js('document.querySelector("[data-crate-request=crq-7]").scrollIntoView()');
 await capture('crate-requests-banned-light');await theme('dark');await capture('crate-requests-banned-dark');
 await js('document.querySelector("[data-crate-requests]").scrollIntoView()');
 await capture('crate-requests-dark');await theme('light');

 await js('[...document.querySelectorAll("[data-crate-request=crq-3] [role=switch]")][0].click()');
 await wait(100);
 await js('document.querySelector("[data-crate-approve=crq-3]").click()');
 await until('document.querySelector("[data-crate-request=crq-3] [data-crate-outcome=vendored]")');
 check('the approved request shows its checks',await js('Boolean(document.querySelector("[data-crate-request=crq-3] [data-crate-notice=crate-unaudited]"))'));
 const calls=await js('window.test.calls()');
 const decision=calls.find(c=>c.method==='cratesDecide');
 check('the decision sent is approve, with build scripts allowed and proc macros not',JSON.stringify(decision?.args)===JSON.stringify([{requestId:'crq-3',decision:'approve',buildScripts:true,procMacros:false}]),calls);
 check('the card read the list again after deciding',calls.filter(c=>c.method==='cratesList').length>=2,calls);
 await capture('crate-approved-light');await theme('dark');await capture('crate-approved-dark');
`;

process.exitCode = await runFixturePage({
  name: "crate-requests-ui",
  entry: "tests/e2e/crate-requests-fixture.tsx",
  steps,
  size: { width: 900, height: 900 },
});
