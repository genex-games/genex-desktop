#!/usr/bin/env node
// Mines rustc errors from agent transcripts (Claude Code JSONL or a Studio chat export JSON array)
// and reports each name an agent guessed that the genex facade does not have, with the reference
// page that should have taught it. Usage: node scripts/evals/mine-guessed-api.mjs <file>... [--json]
import { readFileSync } from "node:fs";

/** rustc codes that mean "the agent guessed an API shape". */
const GUESS_CODES = new Set([
  "E0061",
  "E0425",
  "E0432",
  "E0433",
  "E0412",
  "E0422",
  "E0599",
  "E0560",
  "E0559",
  "E0603",
  "E0609",
  "E0004",
  "E0532",
  "E0026",
  "E0063",
  "E0308",
]);
/** Which reference page a facade word belongs to (first match wins). */
const PAGE_OF = [
  [/particle/i, "particles.md"],
  [/character|ragdoll|humanoid/i, "characters.md"],
  [/anim|clip|skeleton|motion|mask|layer/i, "animation.md"],
  [/net|player_?id|room/i, "net.md"],
  [/action|device|control|pad|key|touch|pointer/i, "input.md"],
  [/sound|music|audio|bus|play_?opts/i, "audio.md"],
  [/physics|collider|rigid|joint|ray|shape/i, "physics.md"],
  [/nav|agent|path/i, "navigation.md"],
  [/stream|cell/i, "streaming.md"],
  [/terrain|height/i, "terrain.md"],
  [/water/i, "water.md"],
  [/save|slot/i, "saves.md"],
  [/egui|ui|rect|screen_rect|content_rect|font|text|tr\b/i, "ui.md"],
  [/material|light|probe|volume|decal|sun|sky|environment|fog/i, "lighting.md"],
  [/render|preset|grading|look|exposure|tonemap/i, "rendering.md"],
  [/post|wgsl|gx_/i, "custom-materials.md"],
  [/gpu|pass/i, "gpu-passes.md"],
  [/rng|ctx|tick|dt/i, "ctx.md"],
  [/frame|cube|sphere|model|mesh|draw|tag|camera|transform/i, "drawing.md"],
  [/asset|gfx/i, "assets.md"],
];
const pageFor = (text) => (PAGE_OF.find(([re]) => re.test(text)) ?? [null, "?"])[1];

function textsOf(file) {
  const raw = readFileSync(file, "utf8").trim();
  const records = raw.startsWith("[")
    ? JSON.parse(raw)
    : raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        });
  const out = [];
  for (const record of records) {
    const content = record?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const parts = Array.isArray(block.content)
        ? block.content
        : [{ type: "text", text: String(block.content ?? "") }];
      out.push(
        parts
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n"),
      );
    }
  }
  return out;
}

const json = process.argv.includes("--json");
const rows = new Map();
for (const file of process.argv.slice(2).filter((a) => !a.startsWith("--"))) {
  for (const text of textsOf(file)) {
    for (const m of text.matchAll(/error\[(E\d{4})\]: ([^\n]{0,220})\n\s*-->\s*([^\n]+)/g)) {
      const [, code, message, at] = m;
      if (!GUESS_CODES.has(code)) continue;
      if (code === "E0308" && !/genex/.test(message)) continue;
      const name = (message.match(/`([^`]+)`/) ?? [])[1] ?? message.slice(0, 60);
      if (
        !/genex|Particles|Character|NetEvent|Device|Animator|Frame|Material|Gfx|Ctx|egui|sim|frame|ctx|gfx/.test(
          message + name,
        )
      )
        continue;
      const key = `${code} ${name}`;
      const row = rows.get(key) ?? {
        code,
        name,
        message: message.slice(0, 160),
        page: pageFor(message + " " + name),
        count: 0,
        files: new Set(),
      };
      row.count += 1;
      row.files.add(file.split("/").slice(-2, -1)[0].slice(-40));
      rows.set(key, row);
    }
  }
}
const list = [...rows.values()].sort((a, b) => b.count - a.count).map((r) => ({ ...r, files: [...r.files] }));
if (json) console.log(JSON.stringify(list, null, 2));
else for (const r of list) console.log(`${String(r.count).padStart(3)}  ${r.page.padEnd(20)} ${r.code}  ${r.message}`);
