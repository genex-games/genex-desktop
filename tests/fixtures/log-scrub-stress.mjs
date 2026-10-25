import assert from "node:assert/strict";
import { scrubForLog } from "../../src/main/logs.ts";

const payload = "A".repeat(200_000);
assert.equal(scrubForLog(`${payload} user@example.com`, "/fixture"), `${payload} [email]`);
assert.equal(scrubForLog(`${payload}@localhost`, "/fixture"), `${payload}@localhost`);
