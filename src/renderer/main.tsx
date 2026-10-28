/**
 * Renderer entry: the window's language first, then the studio. The app's words are read once,
 * when their modules load, so the studio (`studio-entry.tsx`) is loaded only after the chosen
 * language's catalog is in place; each catalog is a chunk of its own.
 */
import { startLanguage } from "./language.ts";

await startLanguage();
await import("./studio-entry.tsx");
