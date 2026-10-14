// A nonconforming dev-flavour Rust game for the conformance suite's red rows: the fd-3 double
// (`studio-double.mjs`) started with one defect, `node game.mjs <defect>` (see `Defect` there).
// With no argument it conforms; `render-settings` alone serves the renderSettings verb and conforms.
import { Defect, serveStudioGame } from "./studio-double.mjs";

const RENDER_SETTINGS = "render-settings";
const named = process.argv[2] ?? null;
const known = named === RENDER_SETTINGS || Object.values(Defect).includes(named);
if (named !== null && !known) {
  process.stderr.write(`unknown defect: ${named}\n`);
  process.exit(2);
}
serveStudioGame({ defect: named === RENDER_SETTINGS ? null : named, renderSettings: named === RENDER_SETTINGS });
