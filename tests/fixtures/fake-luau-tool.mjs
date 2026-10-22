/**
 * A stand-in for luau-lsp, selene and StyLua: it prints what the real programs printed for
 * `fixtures/roblox-luau/game` (recorded in `fixtures/roblox-luau/recorded/`), only for the files it
 * is given, on the stream and with the exit code the real program uses.
 *
 * argv: <tool> <mode> <log file or -> <the program's own arguments…>. Modes: `recorded`, `clean`
 * (nothing found), `hang` (never ends), `flood` (prints far past any cap), `crash` (exits 3
 * printing nothing) and `parse-error` (StyLua's answer for a file it can't read). Each call
 * appends {tool, args, cwd, home, sourcemap} to the log file (the sourcemap luau-lsp was handed, read).
 */
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const recorded = (name) => readFileSync(path.join(here, "roblox-luau", "recorded", name), "utf8");
const [tool, mode, log, ...args] = process.argv.slice(2);
const mapArg = args.find((arg) => arg.startsWith("--sourcemap="));
const sourcemap = mapArg ? JSON.parse(readFileSync(path.resolve(mapArg.slice("--sourcemap=".length)), "utf8")) : undefined;
if (log && log !== "-")
  appendFileSync(log, `${JSON.stringify({ tool, args, cwd: process.cwd(), home: process.env.HOME ?? null, sourcemap })}\n`);

const files = args.filter((arg) => arg.startsWith("src/"));
const folder = process.cwd().split(path.sep).join("/");
const mentions = (line) => files.some((file) => line.includes(file));

if (mode === "hang") setInterval(() => {}, 1_000);
else if (mode === "flood") {
  const line = `${"x".repeat(1023)}\n`;
  for (let i = 0; i < 6 * 1024; i++) process.stdout.write(line);
  process.exitCode = 1;
} else if (mode === "crash") process.exitCode = 3;
else if (mode === "parse-error") process.stdout.write(recorded("stylua-parse-error.json"));
else if (mode === "clean") process.exitCode = 0;
else if (tool === "luau-lsp") {
  const lines = recorded("luau-lsp.txt").replaceAll("{{folder}}", folder).split("\n");
  const kept = lines.filter((line) => line.startsWith("[") || mentions(line));
  process.stderr.write(`${kept.join("\n")}\n`);
  process.exitCode = kept.some((line) => /: (TypeError|SyntaxError): /.test(line)) ? 1 : 0;
} else {
  const name = tool === "selene" ? "selene.jsonl" : "stylua.jsonl";
  const kept = recorded(name)
    .split("\n")
    .filter((line) => line && mentions(line));
  if (kept.length > 0) process.stdout.write(`${kept.join("\n")}\n`);
  process.exitCode = kept.length > 0 ? 1 : 0;
}
