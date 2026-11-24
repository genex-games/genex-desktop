/**
 * A stand-in for the practice helper (`genex llm practice --json`): a small Node program that
 * prints the lines a test scripts and runs until it is told to stop, so a stop is proven by the
 * process being gone.
 */

/** The token every scripted helper's key carries. */
export const HEX = "0123456789abcdef0123456789abcdef";

/** What a helper prints first; later lines follow one by one. */
export interface Script {
  first: Record<string, unknown>;
  later?: Record<string, unknown>[];
}

/** A program printing `script` as JSON lines that runs until it is told to stop. */
export const program = (script: Script) =>
  `const lines=${JSON.stringify([script.first, ...(script.later ?? [])].map((line) => JSON.stringify(line)))};` +
  `let i=0;const next=()=>{if(i<lines.length){process.stdout.write(lines[i++]+"\\n");setTimeout(next,20);}};next();` +
  `process.on("SIGTERM",()=>{process.stdout.write(JSON.stringify({event:"stopped"})+"\\n");process.exit(0);});setInterval(()=>{},1000);`;

/** The first line of a helper that listens on `port`. */
export const listening = (port: number, mode: "mock" | "live") => ({
  command: "llm practice",
  status: "listening",
  port,
  key: `genex_llm_practice=${port}.${HEX}`,
  mode,
});
