import path from "node:path";
import { fileURLToPath } from "node:url";
const repo = fileURLToPath(new URL("..", import.meta.url));

/** One default home for generated acceptance artifacts; explicit output overrides still work. */
export function testEvidence(name, override) {
  return path.resolve(override ?? path.join(repo, ".studio-dev/evidence", name));
}
