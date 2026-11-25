// Summarizes one typing-test run from the results file.
// Usage: node summarize_typing.mjs <page-results.jsonl> <run tag>
import { readFileSync } from "node:fs";

const [file, run] = process.argv.slice(2);
const posts = readFileSync(file, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line))
	.filter((entry) => entry.kind === "post" && entry.data && entry.data.run === run);

const timeline = [];
const finalValues = {};
const batched = {};
for (const { at, data } of posts) {
	if (data.kind === "keydown") timeline.push(`${at} keydown ${data.field} key=${JSON.stringify(data.key)} code=${data.code}${data.repeat ? " repeat" : ""}${data.composing ? " composing" : ""}`);
	if (data.kind === "input") {
		finalValues[data.field] = data.value;
		timeline.push(`${at} input ${data.field} ${data.inputType} data=${JSON.stringify(data.data)} value=${JSON.stringify(data.value)}`);
	}
	if (data.kind === "paste") timeline.push(`${at} paste ${data.field} text=${JSON.stringify(data.text)}`);
	if (data.kind === "events") {
		for (const event of data.events) {
			batched[event.type] = (batched[event.type] ?? 0) + 1;
			if (event.type === "focus" || event.type === "blur") timeline.push(`${at} ${event.type} ${event.target}`);
		}
	}
}
console.log(timeline.join("\n"));
console.log("\nfinal values:", JSON.stringify(finalValues, null, 1));
console.log("batched event counts:", JSON.stringify(batched));
