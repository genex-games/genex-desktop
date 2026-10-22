/**
 * The engines tests link games to, declared as their plugins declare them (`engine` in
 * `plugin.json`): the bundled Unreal and Godot plugins' and the made-up toy engine's, and a
 * catalog of them, as the host builds one from the installed plugins.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { EngineCatalog, EngineDeclaration } from "../../src/shared/game-engine.ts";
import { engineCatalog } from "../../src/shared/plugins.ts";

const REPO = path.resolve(import.meta.dirname, "..", "..");

function declared(manifest: string): EngineDeclaration {
  const engine = (JSON.parse(readFileSync(manifest, "utf8")) as { engine?: EngineDeclaration }).engine;
  if (!engine) throw new Error(`${manifest} declares no engine`);
  return engine;
}

/** The bundled Unreal plugin's engine. */
export const UNREAL_ENGINE = declared(path.join(REPO, "src", "plugins", "unreal", "plugin.json"));

/** The bundled Godot plugin's engine. */
export const GODOT_ENGINE = declared(path.join(REPO, "src", "plugins", "godot", "plugin.json"));

/** The toy engine plugin's engine (`tests/fixtures/toy-engine-plugin`). */
export const TOY_ENGINE = declared(path.join(REPO, "tests", "fixtures", "toy-engine-plugin", "plugin.json"));

/** These engines, as the host's catalog of installed plugins holds them. */
export const ENGINES: EngineCatalog = engineCatalog([
  { engine: UNREAL_ENGINE },
  { engine: GODOT_ENGINE },
  { engine: TOY_ENGINE },
]);
