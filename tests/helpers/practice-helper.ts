/**
 * A stand-in for the practice helper (`genex llm practice --json`): a small Node program that
 * prints the lines a test scripts and runs until it is told to stop, so a stop is proven by the
 * process being gone.
 */

import type { HostAsk } from "../../src/main/core/preview-ai-plans.ts";

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
export const listening = (port: number, mode: "mock" | "live" | "host") => ({
  command: "llm practice",
  status: "listening",
  port,
  key: `genex_llm_practice=${port}.${HEX}`,
  mode,
});

/** The port a helper in host mode listens on in these tests. */
export const HOST_PORT = 41002;

/**
 * A helper in host mode, as `genex llm practice --host` behaves: it listens only once its host said
 * who answers, then asks for the words of each of `asks`, and prints every answer it is given.
 */
export const hostProgram = (asks: HostAsk[]) =>
  `const first=${JSON.stringify(JSON.stringify({ ...listening(HOST_PORT, "host") }))};const asks=${JSON.stringify(asks.map((ask) => JSON.stringify({ event: "ask", outputFormat: "text", ...ask })))};` +
  `let hello=false;require("node:readline").createInterface({input:process.stdin}).on("line",(text)=>{let line;try{line=JSON.parse(text)}catch{return}` +
  `if(!hello&&line.host){hello=true;process.stdout.write(JSON.stringify({event:"hello",host:line.host})+"\\n"+first+"\\n");for(const ask of asks)process.stdout.write(ask+"\\n");return}` +
  `if(line.answer)process.stdout.write(JSON.stringify({event:"answered",answer:line.answer})+"\\n")});` +
  `process.on("SIGTERM",()=>{process.stdout.write(JSON.stringify({event:"stopped"})+"\\n");process.exit(0);});setInterval(()=>{},1000);`;
