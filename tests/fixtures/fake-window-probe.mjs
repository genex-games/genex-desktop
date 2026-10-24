#!/usr/bin/env node
/**
 * A stand-in for Genex's Windows window probe (`src/substrate/windows-window-probe.ts`): it reports its
 * start in stages, says it is ready with its view of the primary screen (half the driver's physical
 * pixels, as Windows scaling a process's points at 200% would), and answers one JSON line per request
 * line from a fixed desktop. `--log <file>` appends each start and each request; `--hang <request>`
 * never answers that request; `--fail-start` exits before it is ready, saying why on stderr;
 * `--stall` stops after loading and never says it is ready; `--chatter` says a warning, and puts a
 * byte-order mark before its first line, as Windows PowerShell can; `--exit-after-one` exits once it
 * has answered one request, as a helper that ends while idle.
 */
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const log = flag("--log");
const hang = flag("--hang");
const note = (entry) => log && appendFileSync(log, `${JSON.stringify(entry)}\n`);
const say = (line) => process.stdout.write(`${line}\n`);

/** The desktop: Notepad in front with a password field focused, 1Password on the right half of the view. */
const ANSWERS = {
  front: () => '{"pid":40,"exe":"Notepad.exe","name":"Notepad","secure":true,"window":4001}',
  at: (x) =>
    Number(x) < 500
      ? '{"pid":40,"exe":"Notepad.exe","name":"Notepad","window":4001}'
      : '{"pid":41,"exe":"1Password.exe","name":"1Password","window":4101}',
  pid: (pid) => (pid === "40" ? '{"pid":40,"exe":"Notepad.exe","name":"Notepad","window":4001}' : '{"pid":0}'),
};

function serve() {
  say('{"ready":true,"view":{"width":1000,"height":500}}');
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    note({ request: line });
    if (line === hang) return;
    const [verb, ...args] = line.split(" ");
    const answer = ANSWERS[verb]?.(...args) ?? '{"error":"unknown request"}';
    process.stdout.write(`${answer}\n`, () => {
      if (argv.includes("--exit-after-one")) process.exit(0);
    });
  });
  lines.on("close", () => process.exit(0));
}

if (argv.includes("--fail-start")) {
  process.stderr.write("Add-Type : Could not load file or assembly 'UIAutomationClient'.\n");
  process.exit(1);
}
note({ start: process.pid });
if (argv.includes("--chatter")) process.stdout.write("WARNING: a profile was skipped.\r\n\uFEFF");
say('{"stage":"started"}');
say('{"stage":"loaded"}');
if (argv.includes("--stall")) process.stdin.resume();
else serve();
