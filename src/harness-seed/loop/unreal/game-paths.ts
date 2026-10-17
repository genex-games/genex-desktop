/**
 * Paths the lead names inside the game folder: refused by their shape alone (absolute, a climb, a
 * hidden folder), and followed through every link to where they really are. The rules live in
 * `../folder-paths.ts`, which the finish check's proof reader shares; this module keeps the names
 * its importers use.
 */
export { pathShapeProblem, realInside } from "../folder-paths.ts";
