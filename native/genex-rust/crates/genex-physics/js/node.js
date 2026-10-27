// @genex-ai/physics for Node 24: the WASM module beside this file is loaded synchronously on
// import, so `World.create(desc)` works at once; `await init()` is still accepted (and makes a new
// instance after a trap, §11.3).
import { readFileSync } from "node:fs";
import { loadSync } from "./core.js";

loadSync(readFileSync(new URL("./wasm/genex_physics_wasm_bg.wasm", import.meta.url)));

export { buildId, createBinding, init, PhysicsError, World } from "./core.js";
