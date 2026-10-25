/**
 * The bar layer's entry (`play-bar.html`): the window's language first, then the bar
 * (`play-bar-page.tsx`), whose words are read when its modules load.
 */
import { startLanguage } from "./language.ts";

await startLanguage();
await import("./play-bar-page.tsx");
